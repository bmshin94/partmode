import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonDocument = Record<string, any>;

interface TopologySummary {
  faceCount: number;
  faceNames: string[];
  edgeCount: number;
  edgeNames: string[];
  edgeSignatures: Array<{ p: number[]; l: number; curveType?: string }>;
  vertexCount: number;
  vertexNames: string[];
  diagnostics: Array<Record<string, any>>;
}

interface BodySummary {
  bodyId: string;
  exactBrep: string | null;
  topology: TopologySummary | null;
  geometry: Record<string, any> | null;
  error: Record<string, any> | null;
  lastValid: boolean;
}

interface RebuildSummary {
  id: string;
  kind: string;
  errors: Array<Record<string, any>>;
  warnings: Array<Record<string, any>>;
  evaluation: Record<string, string[]>;
  bodies: BodySummary[];
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..', '..');
const fixturePath = resolve(root, 'tests', 'feature-registry-runtime', 'registered-features.partmode.json');
let importedRegistryKernelPromise: Promise<{ rc: any; registry: any }> | null = null;

async function importedRegistryKernel(): Promise<{ rc: any; registry: any }> {
  if (importedRegistryKernelPromise) return importedRegistryKernelPromise;
  importedRegistryKernelPromise = (async () => {
    const vendorDirectory = resolve(root, 'src/static/vendor');
    const globals = globalThis as typeof globalThis & {
      require: ReturnType<typeof createRequire>;
      __dirname: string;
    };
    globals.require = createRequire(import.meta.url);
    globals.__dirname = vendorDirectory;
    const rc = await import(pathToFileURL(resolve(vendorDirectory, 'replicad.module.js')).href) as any;
    const ocFactory = await import(pathToFileURL(resolve(vendorDirectory, 'replicad-oc.module.js')).href) as any;
    const module = await import(
      pathToFileURL(resolve(root, 'src/static/studio-imported-topology-registry.js')).href
    ) as any;
    const oc = await ocFactory.default({ locateFile: () => resolve(vendorDirectory, 'replicad_single.wasm') });
    rc.setOC(oc);
    return { rc, registry: module.createStudioImportedTopologyRegistry(rc) };
  })();
  return importedRegistryKernelPromise;
}
const coveredFeatureTypes = Object.freeze([
  'boolean-split-side',
  'chamfer',
  'draft',
  'imported-step',
  'revolve',
  'thicken',
  'transform',
]);

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameStrings(actual: string[], expected: string[], label: string): void {
  invariant(
    actual.length === expected.length && actual.every((entry, index) => entry === expected[index]),
    `${label}: expected [${expected.join(', ')}], received [${actual.join(', ')}]`,
  );
}

function rootPart(document: JsonDocument): JsonDocument {
  const part = document.partDefinitions.find((entry: JsonDocument) => entry.id === document.rootDocument.partId);
  invariant(part, 'root part is missing');
  return part;
}

function setParameter(document: JsonDocument, name: string, value: number | string): void {
  const matches = document.parameters.filter((parameter: JsonDocument) => parameter.name === name);
  invariant(matches.length === 1, `parameter ${name} did not resolve exactly once`);
  matches[0].value = value;
}

function feature(document: JsonDocument, id: string): JsonDocument {
  const matches = rootPart(document).features.filter((entry: JsonDocument) => entry.id === id);
  invariant(matches.length === 1, `feature ${id} did not resolve exactly once`);
  return matches[0];
}

function body(result: RebuildSummary, bodyId: string): BodySummary {
  const matches = result.bodies.filter((entry) => entry.bodyId === bodyId);
  invariant(matches.length === 1, `${result.id}: body ${bodyId} did not resolve exactly once`);
  return matches[0]!;
}

function topology(bodyResult: BodySummary, label: string): TopologySummary {
  invariant(bodyResult.topology, `${label}: topology mesh is missing`);
  return bodyResult.topology;
}

function assertExactBody(bodyResult: BodySummary, label: string): TopologySummary {
  invariant(!bodyResult.error, `${label}: body error ${bodyResult.error?.message || 'unknown'}`);
  invariant(!bodyResult.lastValid, `${label}: worker used last-valid geometry`);
  invariant(bodyResult.geometry?.valid === true, `${label}: exact shape is invalid`);
  invariant(bodyResult.geometry?.brepValid === true, `${label}: B-rep analyzer rejected the shape`);
  invariant(bodyResult.geometry?.solidCount === 1, `${label}: expected exactly one solid`);
  invariant(Number(bodyResult.geometry?.volume) > 1e-8, `${label}: volume is not positive`);
  invariant(
    typeof bodyResult.exactBrep === 'string' && bodyResult.exactBrep.length > 100,
    `${label}: canonical BREP evidence is missing`,
  );
  return topology(bodyResult, label);
}

function assertCompleteTopology(summary: TopologySummary, label: string): void {
  invariant(summary.faceCount > 0, `${label}: exact faces are missing`);
  invariant(summary.edgeCount > 0, `${label}: exact edges are missing`);
  invariant(summary.vertexCount > 0, `${label}: exact vertices are missing`);
  invariant(
    summary.faceNames.length === summary.faceCount,
    `${label}: only ${summary.faceNames.length}/${summary.faceCount} exact faces are named`,
  );
  invariant(
    summary.edgeNames.length === summary.edgeCount,
    `${label}: only ${summary.edgeNames.length}/${summary.edgeCount} exact edges are named`,
  );
  invariant(
    summary.vertexNames.length === summary.vertexCount,
    `${label}: only ${summary.vertexNames.length}/${summary.vertexCount} exact vertices are named`,
  );
  invariant(
    summary.diagnostics.length === 0,
    `${label}: topology diagnostics ${JSON.stringify(summary.diagnostics)}`,
  );
}

function assertValidRebuild(result: RebuildSummary, expectedBodyIds: string[]): void {
  invariant(result.kind === 'rebuild-result', `${result.id}: worker did not return rebuild-result`);
  invariant(result.errors.length === 0, `${result.id}: worker errors ${JSON.stringify(result.errors)}`);
  invariant(result.warnings.length === 0, `${result.id}: worker warnings ${JSON.stringify(result.warnings)}`);
  sameStrings(result.bodies.map((entry) => entry.bodyId), expectedBodyIds, `${result.id}: body order`);
  for (const bodyId of expectedBodyIds) {
    const summary = assertExactBody(body(result, bodyId), `${result.id}/${bodyId}`);
    assertCompleteTopology(summary, `${result.id}/${bodyId}`);
  }
}

function assertStableTopology(results: RebuildSummary[], expectedBodyIds: string[]): void {
  const baseline = results[0];
  invariant(baseline, 'stable-topology comparison requires a baseline');
  for (const current of results.slice(1)) {
    for (const bodyId of expectedBodyIds) {
      const baselineTopology = topology(body(baseline, bodyId), `base/${bodyId}`);
      const currentTopology = topology(body(current, bodyId), `${current.id}/${bodyId}`);
      sameStrings(currentTopology.faceNames, baselineTopology.faceNames, `${current.id}/${bodyId}: face names`);
      sameStrings(currentTopology.edgeNames, baselineTopology.edgeNames, `${current.id}/${bodyId}: edge names`);
      sameStrings(currentTopology.vertexNames, baselineTopology.vertexNames, `${current.id}/${bodyId}: vertex names`);
    }
  }
}

async function runWorkerSequence(
  page: Page,
  sequenceId: string,
  variants: Array<{ id: string; document: JsonDocument }>,
): Promise<RebuildSummary[]> {
  return page.evaluate(async (input) => {
    const studioScript = document.querySelector<HTMLScriptElement>('script[src*="/studio.js"]');
    if (!studioScript) throw new Error('versioned Studio entrypoint is missing');
    const workerUrl = `${new URL('.', studioScript.src).href}studio-kernel.worker.js`;
    const worker = new Worker(workerUrl, { type: 'module' });
    let revision = 0;
    try {
      const summaries = [];
      for (const variant of input.variants) {
        revision += 1;
        const requestId = `${input.sequenceId}-${revision}`;
        const response = await new Promise<Record<string, any>>((resolveResponse, rejectResponse) => {
          const timeout = setTimeout(
            () => rejectResponse(new Error(`${variant.id}: exact worker timed out`)),
            120_000,
          );
          const onMessage = (event: MessageEvent<Record<string, any>>) => {
            const data = event.data;
            if (data?.kind === 'kernel-status' && data.status === 'failed') {
              clearTimeout(timeout);
              worker.removeEventListener('message', onMessage);
              rejectResponse(new Error(data.message || 'CAD kernel initialization failed'));
              return;
            }
            if (data?.requestId !== requestId) return;
            clearTimeout(timeout);
            worker.removeEventListener('message', onMessage);
            if (data.kind === 'kernel-error') rejectResponse(new Error(data.message || 'CAD kernel error'));
            else resolveResponse(data);
          };
          worker.addEventListener('message', onMessage);
          worker.postMessage({
            kind: 'rebuild',
            requestId,
            projectId: variant.document.projectId,
            revision,
            document: variant.document,
            includeExactBrep: true,
          });
        });
        summaries.push({
          id: variant.id,
          kind: String(response.kind || ''),
          errors: (response.errors || []).map((entry: Record<string, any>) => ({
            code: entry.code,
            bodyId: entry.bodyId,
            featureId: entry.featureId,
            featureType: entry.featureType,
            message: entry.message,
          })),
          warnings: (response.warnings || []).map((entry: Record<string, any>) => ({
            code: entry.code,
            bodyId: entry.bodyId,
            featureId: entry.featureId,
            message: entry.message,
          })),
          evaluation: Object.fromEntries(
            Object.entries(response.evaluation || {}).map(([key, values]) => [key, [...(values as string[])]]),
          ),
          bodies: (response.bodies || []).map((entry: Record<string, any>) => ({
            bodyId: String(entry.bodyId || ''),
            exactBrep: typeof entry.exactBrep === 'string' ? entry.exactBrep : null,
            topology: entry.mesh ? {
              faceCount: Number(entry.mesh.topologyCounts?.faces ?? entry.mesh.topologyFaces?.length ?? 0),
              faceNames: (entry.mesh.topologyFaces || [])
                .map((face: Record<string, any>) => face.name)
                .filter((name: unknown) => typeof name === 'string')
                .sort(),
              edgeCount: Number(entry.mesh.topologyCounts?.edges ?? entry.mesh.edges?.length ?? 0),
              edgeNames: (entry.mesh.edges || [])
                .map((edge: Record<string, any>) => edge.name)
                .filter((name: unknown) => typeof name === 'string')
                .sort(),
              edgeSignatures: (entry.mesh.edges || []).map((edge: Record<string, any>) => ({
                p: [...(edge.sig?.p || [])].map(Number),
                l: Number(edge.sig?.l),
                ...(typeof edge.sig?.curveType === 'string' ? { curveType: edge.sig.curveType } : {}),
              })),
              vertexCount: Number(entry.mesh.topologyCounts?.vertices ?? entry.mesh.topologyVertices?.length ?? 0),
              vertexNames: (entry.mesh.topologyVertices || [])
                .map((vertex: Record<string, any>) => vertex.name)
                .filter((name: unknown) => typeof name === 'string')
                .sort(),
              diagnostics: (entry.mesh.topologyDiagnostics || []).map((diagnostic: Record<string, any>) => ({
                severity: diagnostic.severity,
                code: diagnostic.code,
                reason: diagnostic.reason,
                topologyKind: diagnostic.topologyKind,
                faces: diagnostic.faces,
                namedFaces: diagnostic.namedFaces,
                edges: diagnostic.edges,
                namedEdges: diagnostic.namedEdges,
                vertices: diagnostic.vertices,
                namedVertices: diagnostic.namedVertices,
              })),
            } : null,
            geometry: entry.geometry ? { ...entry.geometry } : null,
            error: entry.error ? { ...entry.error } : null,
            lastValid: entry.lastValid === true,
          })),
        });
      }
      return summaries;
    } finally {
      worker.terminate();
    }
  }, { sequenceId, variants }) as Promise<RebuildSummary[]>;
}

const projectModule = await import(
  pathToFileURL(resolve(root, 'src', 'static', 'studio-project-v5.js')).href
) as any;
const runtimeModule = await import(
  pathToFileURL(resolve(root, 'src', 'static', 'studio-v5-runtime-document.js')).href
) as any;
const prepareStudioV5Project = projectModule.prepareStudioV5Project as (candidate: JsonDocument) => JsonDocument;
const parseStudioV5Project = projectModule.parseStudioV5Project as (source: string) => JsonDocument;
const studioV5CanonicalHash = runtimeModule.studioV5CanonicalHash as (candidate: JsonDocument) => string;

function saveReopen(candidate: JsonDocument, label: string): JsonDocument {
  const prepared = prepareStudioV5Project(clone(candidate));
  const saved = JSON.stringify(prepared);
  const reopened = parseStudioV5Project(saved);
  invariant(JSON.stringify(reopened) === saved, `${label}: save/reopen changed canonical JSON`);
  invariant(
    studioV5CanonicalHash(reopened) === studioV5CanonicalHash(parseStudioV5Project(JSON.stringify(reopened))),
    `${label}: canonical hash changed on a second reopen`,
  );
  return reopened;
}

function isolatedThinChamfer(
  candidate: JsonDocument,
  signature: { p: number[]; l: number; curveType: string } | null,
): JsonDocument {
  const document = clone(candidate);
  document.projectId = signature ? 'runtime-ambiguous-chamfer' : 'runtime-thin-chamfer-source';
  document.name = signature ? 'Ambiguous unnamed edge reference' : 'Thin chamfer source';
  document.parameters = document.parameters.filter((entry: JsonDocument) => entry.name === 'chamfer_size');
  setParameter(document, 'chamfer_size', 0.1);
  const part = rootPart(document);
  part.referenceGeometry = [];
  part.sketches = [];
  part.bodies = part.bodies.filter((entry: JsonDocument) => entry.id === 'body-chamfer');
  part.metadata.activeBodyId = 'body-chamfer';
  const stock = feature(document, 'feature-chamfer-stock');
  stock.h = 12;
  stock.sketch.entities = [
    { id: 'chamfer-stock-bottom', kind: 'line', a: [-0.01, -5], b: [0.01, -5] },
    { id: 'chamfer-stock-right', kind: 'line', a: [0.01, -5], b: [0.01, 5] },
    { id: 'chamfer-stock-top', kind: 'line', a: [0.01, 5], b: [-0.01, 5] },
    { id: 'chamfer-stock-left', kind: 'line', a: [-0.01, 5], b: [-0.01, -5] },
  ];
  stock.sketch.shapes = [{ kind: 'rect', x: 0, y: 0, w: 0.02, h: 10 }];
  if (signature) {
    const chamfer = feature(document, 'feature-chamfer');
    chamfer.edges = [signature];
    part.features = part.features.filter((entry: JsonDocument) =>
      entry.id === 'feature-chamfer-stock' || entry.id === 'feature-chamfer');
    part.featureOrder = ['feature-chamfer-stock', 'feature-chamfer'];
    part.bodies[0].featureIds = ['feature-chamfer-stock', 'feature-chamfer'];
  } else {
    part.features = part.features.filter((entry: JsonDocument) => entry.id === 'feature-chamfer-stock');
    part.featureOrder = ['feature-chamfer-stock'];
    part.bodies[0].featureIds = ['feature-chamfer-stock'];
  }
  document.metadata = {
    corpus: signature
      ? 'registered-feature-runtime-ambiguity'
      : 'registered-feature-runtime-ambiguity-source',
  };
  return saveReopen(document, signature ? 'ambiguous chamfer' : 'thin chamfer source');
}

function deriveAmbiguousEdgeSignature(summary: TopologySummary): {
  p: number[];
  l: number;
  curveType: string;
} {
  const candidates = summary.edgeSignatures;
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex]!;
      if (Math.abs(left.l - right.l) >= 0.05 || left.p.length !== 3 || right.p.length !== 3) continue;
      const p = left.p.map((value, axis) => (value + right.p[axis]!) / 2);
      const l = (left.l + right.l) / 2;
      const matches = candidates.filter((entry) =>
        Math.abs(entry.l - l) < 0.05
        && entry.p.length === 3
        && Math.hypot(...entry.p.map((value, axis) => value - p[axis]!)) < 0.05);
      if (matches.length === 2) return { p, l, curveType: left.curveType || 'LINE' };
    }
  }
  throw new Error(`thin chamfer source did not expose an exactly two-candidate signature: ${JSON.stringify(candidates)}`);
}

interface ImportedStepFixture {
  document: JsonDocument;
  opaque: {
    faceNames: string[];
    edgeNames: string[];
    vertexNames: string[];
    sideFaceName: string;
    openingFaceName: string;
    blendEdgeName: string;
  };
}

async function importedStepFixture(exactBrep: string): Promise<ImportedStepFixture> {
  const { rc, registry } = await importedRegistryKernel();
  const source = rc.deserializeShape(exactBrep);
  let captured: any;
  try {
    captured = registry.capture({ shape: source, registryId: 'resource-imported-step' });
  } finally {
    source.delete();
  }
  const data = Buffer.from(captured.sourceBrep, 'utf8').toString('base64');
  const restored = registry.restore({
    sourceBrep: captured.sourceBrep,
    registry: captured.registry,
    expectedRegistryRef: captured.featureReference,
  });
  const center = (wrapper: any): [number, number, number] => {
    const value = wrapper.center;
    try { return [Number(value.x ?? value[0]), Number(value.y ?? value[1]), Number(value.z ?? value[2])]; }
    finally { value?.delete?.(); }
  };
  let opaque: ImportedStepFixture['opaque'];
  try {
    const faceCenters: Array<{ name: string; center: [number, number, number] }> =
      restored.names.faces.map((entry: any) => ({ name: String(entry.name), center: center(entry.face) }));
    const maximum = (entries: Array<{ name: string; center: [number, number, number] }>, axis: number) =>
      [...entries].sort((left, right) => right.center[axis]! - left.center[axis]!)[0]!.name;
    const blend = restored.names.edges[0];
    invariant(blend, 'imported registry did not expose an edge for modifier coverage');
    opaque = {
      faceNames: restored.names.faces.map((entry: any) => String(entry.name)).sort(),
      edgeNames: restored.names.edges.map((entry: any) => String(entry.name)).sort(),
      vertexNames: restored.names.vertices.map((entry: any) => String(entry.name)).sort(),
      sideFaceName: maximum(faceCenters, 0),
      openingFaceName: maximum(faceCenters, 2),
      blendEdgeName: String(blend.name),
    };
  } finally {
    registry.disposeOutcome(restored);
  }
  const document = saveReopen({
    schemaVersion: 5,
    projectId: 'runtime-imported-step',
    name: 'Imported STEP topology gate',
    units: 'mm',
    parameters: [],
    materials: [],
    partDefinitions: [{
      id: 'part-imported-step',
      name: 'Imported STEP topology gate',
      parameters: [],
      referenceGeometry: [],
      sketches: [],
      bodies: [{
        id: 'body-imported-step',
        name: 'Imported exact body',
        kind: 'solid',
        createdByFeatureId: 'feature-imported-step',
        featureIds: ['feature-imported-step'],
        visible: true,
        suppressed: false,
      }],
      bodyPatterns: [],
      features: [{
        id: 'feature-imported-step',
        name: 'Imported exact body',
        type: 'imported-step',
        suppressed: false,
        inputRefs: [],
        resultPolicy: { kind: 'new-body', bodyName: 'Imported exact body' },
        createdBodyId: 'body-imported-step',
        extensions: {
          studioImportedStep: {
            resourceId: 'resource-imported-step',
            exactBrep: true,
            parametricHistory: false,
            topologyRegistry: captured.featureReference,
          },
        },
      }],
      featureOrder: ['feature-imported-step'],
      metadata: { activeBodyId: 'body-imported-step', importedFromStep: true },
      extensions: { studioImportedStep: { exactBrep: true, parametricHistory: false } },
    }],
    assemblyDefinitions: [],
    rootDocument: { kind: 'part', partId: 'part-imported-step' },
    resources: [{
      id: 'resource-imported-step',
      name: 'Imported exact body B-rep',
      mimeType: 'text/plain',
      byteLength: Buffer.byteLength(captured.sourceBrep, 'utf8'),
      encoding: 'base64',
      data,
      extensions: {
        studioImportedStep: {
          source: 'runtime-gate',
          topologyRegistryByteLength: Buffer.byteLength(captured.registry.carrierBrep, 'utf8'),
          topologyRegistry: captured.registry,
        },
      },
    }],
    metadata: { corpus: 'registered-feature-runtime-import' },
  }, 'imported STEP');
  return { document, opaque };
}

type ImportedDownstreamKind = 'transform' | 'draft' | 'shell' | 'thicken' | 'fillet' | 'chamfer' | 'boolean' | 'boolean-split';

function bodyInputReference(ownerId: string, role: string): JsonDocument {
  return {
    ownerKind: 'body',
    ownerId,
    semanticPath: { role },
    signature: { role },
  };
}

function importedDownstreamDocument(
  fixture: ImportedStepFixture,
  kind: ImportedDownstreamKind,
  importShift: number,
  options: { ambiguousBoolean?: boolean } = {},
): JsonDocument {
  const document = clone(fixture.document);
  document.projectId = `runtime-imported-${kind}${options.ambiguousBoolean ? '-ambiguous' : ''}`;
  document.name = `Imported STEP downstream ${kind}`;
  document.parameters = [
    { id: 'parameter-import-shift', name: 'import_shift', value: importShift },
    { id: 'parameter-import-modifier', name: 'import_modifier', value: kind === 'draft' ? 4 : 1 },
  ];
  const part = rootPart(document);
  const importedBody = part.bodies.find((entry: JsonDocument) => entry.id === 'body-imported-step');
  invariant(importedBody, 'imported downstream fixture lost its imported body');
  const transform = {
    id: 'feature-imported-transform',
    name: 'Move imported topology',
    type: 'transform',
    operation: 'move',
    transform: { mode: 'move', translation: ['import_shift', 0, 0] },
    sourceBodyId: 'body-imported-step',
    resultPolicy: { kind: 'add', targetBodyIds: ['body-imported-step'] },
    suppressed: false,
    inputRefs: [bodyInputReference('body-imported-step', 'target')],
  };
  part.features.push(transform);
  part.featureOrder.push(transform.id);
  importedBody.featureIds.push(transform.id);
  if (kind === 'transform') return saveReopen(document, `imported ${kind} chain`);

  if (kind === 'thicken') {
    const thickenedBody = {
      id: 'body-imported-thickened',
      name: 'Thickened imported face',
      kind: 'solid',
      createdByFeatureId: 'feature-imported-thicken',
      featureIds: ['feature-imported-thicken'],
      visible: true,
      suppressed: false,
    };
    const thicken = {
      id: 'feature-imported-thicken',
      name: 'Thicken imported face',
      type: 'thicken',
      sourceBodyId: 'body-imported-step',
      toolBodyIds: ['body-imported-step'],
      linked: true,
      faces: [{ name: fixture.opaque.openingFaceName }],
      thickness: 'import_modifier',
      symmetric: false,
      flip: false,
      resultPolicy: { kind: 'new-body', bodyName: 'Thickened imported face' },
      createdBodyId: thickenedBody.id,
      suppressed: false,
      inputRefs: [bodyInputReference('body-imported-step', 'source')],
    };
    part.bodies.push(thickenedBody);
    part.features.push(thicken);
    part.featureOrder.push(thicken.id);
    return saveReopen(document, `imported ${kind} chain`);
  }

  if (kind === 'boolean' || kind === 'boolean-split') {
    const notch = options.ambiguousBoolean === true;
    const x0 = notch ? 5 : -1.5;
    const x1 = notch ? 9 : 1.5;
    const y0 = notch ? -1 : -1.25;
    const y1 = notch ? 1 : 1.25;
    const z0 = notch ? 7 : 2;
    const height = 4;
    const toolBody = {
      id: 'body-imported-tool',
      name: 'Imported topology Boolean tool',
      kind: 'solid',
      createdByFeatureId: 'feature-imported-tool',
      featureIds: ['feature-imported-tool'],
      visible: true,
      suppressed: false,
    };
    const tool = {
      id: 'feature-imported-tool',
      name: 'Imported topology Boolean tool',
      type: 'extrude',
      sketch: {
        id: 'sketch-imported-tool',
        name: 'Imported topology Boolean tool profile',
        entities: [
          { id: 'imported-tool-bottom', kind: 'line', a: [x0, y0], b: [x1, y0] },
          { id: 'imported-tool-right', kind: 'line', a: [x1, y0], b: [x1, y1] },
          { id: 'imported-tool-top', kind: 'line', a: [x1, y1], b: [x0, y1] },
          { id: 'imported-tool-left', kind: 'line', a: [x0, y1], b: [x0, y0] },
        ],
        groups: [],
        shapes: [{ kind: 'rect', x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 }],
        z: z0,
      },
      plane: { kind: 'base', plane: 'XY' },
      h: height,
      through: false,
      resultPolicy: { kind: 'new-body', bodyName: 'Imported topology Boolean tool' },
      createdBodyId: toolBody.id,
      suppressed: false,
      inputRefs: [],
      extensions: { exactSketchEntities: true },
    };
    const operation = kind === 'boolean-split'
      ? {
          id: 'feature-imported-boolean-split',
          name: 'Split imported topology outside',
          type: 'boolean-split-side',
          operationId: 'operation-imported-split',
          side: 'outside',
          sourceBodyId: 'body-imported-step',
          toolBodyIds: ['body-imported-step', toolBody.id],
          keepTools: true,
          resultPolicy: { kind: 'new-body', bodyName: 'Imported split outside' },
          createdBodyId: 'body-imported-split',
          suppressed: false,
          inputRefs: [
            bodyInputReference('body-imported-step', 'target'),
            bodyInputReference(toolBody.id, 'tool'),
          ],
        }
      : {
          id: 'feature-imported-boolean',
          name: 'Cut imported topology',
          type: 'boolean',
          operation: 'subtract',
          toolBodyIds: [toolBody.id],
          resultPolicy: { kind: 'subtract', targetBodyIds: ['body-imported-step'], keepTools: true },
          suppressed: false,
          inputRefs: [
            bodyInputReference('body-imported-step', 'target'),
            bodyInputReference(toolBody.id, 'tool'),
          ],
        };
    part.bodies.push(toolBody);
    if (kind === 'boolean-split') {
      part.bodies.push({
        id: 'body-imported-split',
        name: 'Imported split outside',
        kind: 'solid',
        createdByFeatureId: operation.id,
        featureIds: [operation.id],
        visible: true,
        suppressed: false,
      });
    }
    part.features.push(tool, operation);
    part.featureOrder.push(tool.id, operation.id);
    if (kind === 'boolean') importedBody.featureIds.push(operation.id);
    return saveReopen(document, `imported ${kind}${notch ? ' ambiguity' : ''} chain`);
  }

  let modifier: JsonDocument;
  if (kind === 'draft') {
    part.referenceGeometry.push({
      id: 'datum-imported-neutral',
      name: 'Imported draft neutral plane',
      kind: 'plane',
      suppressed: false,
      definition: { origin: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
    });
    modifier = {
      id: 'feature-imported-draft',
      name: 'Draft imported topology',
      type: 'draft',
      faces: [{ name: fixture.opaque.sideFaceName }],
      neutralPlaneDatumId: 'datum-imported-neutral',
      angle: 'import_modifier',
      flip: false,
      tangentPropagation: false,
      resultPolicy: { kind: 'add', targetBodyIds: ['body-imported-step'] },
      suppressed: false,
      inputRefs: [
        bodyInputReference('body-imported-step', 'target'),
        { ownerKind: 'datum', ownerId: 'datum-imported-neutral', semanticPath: { role: 'neutral-plane' }, signature: { role: 'neutral-plane' } },
      ],
    };
  } else if (kind === 'shell') {
    modifier = {
      id: 'feature-imported-shell',
      name: 'Shell imported topology',
      type: 'shell',
      faces: [{ name: fixture.opaque.openingFaceName }],
      t: 'import_modifier',
      resultPolicy: { kind: 'add', targetBodyIds: ['body-imported-step'] },
      suppressed: false,
      inputRefs: [bodyInputReference('body-imported-step', 'target')],
    };
  } else {
    modifier = {
      id: `feature-imported-${kind}`,
      name: `${kind} imported topology`,
      type: kind,
      edges: [{ name: fixture.opaque.blendEdgeName }],
      r: 'import_modifier',
      ...(kind === 'fillet' ? { variableRadii: [] } : {}),
      resultPolicy: { kind: 'add', targetBodyIds: ['body-imported-step'] },
      suppressed: false,
      inputRefs: [bodyInputReference('body-imported-step', 'target')],
    };
  }
  part.features.push(modifier);
  part.featureOrder.push(modifier.id);
  importedBody.featureIds.push(modifier.id);
  return saveReopen(document, `imported ${kind} chain`);
}

function diagnosticCheckpointDocument(candidate: JsonDocument, shift: number): JsonDocument {
  const document = clone(candidate);
  document.projectId = 'runtime-checkpoint-diagnostic-propagation';
  document.name = 'Checkpoint diagnostic propagation';
  document.parameters = [
    { id: 'parameter-face-stock-height', name: 'face_stock_height', value: 10 },
    { id: 'parameter-diagnostic-shift', name: 'diagnostic_shift', value: shift },
  ];
  const part = rootPart(document);
  part.referenceGeometry = [];
  part.sketches = [];
  part.bodies = part.bodies.filter((entry: JsonDocument) => entry.id === 'body-face-attached');
  part.metadata.activeBodyId = 'body-face-attached';
  const stock = feature(document, 'feature-face-stock');
  const toolBody = {
    id: 'body-diagnostic-tool',
    name: 'Face split diagnostic tool',
    kind: 'solid',
    createdByFeatureId: 'feature-diagnostic-tool',
    featureIds: ['feature-diagnostic-tool'],
    visible: true,
    suppressed: false,
  };
  const tool = {
    id: 'feature-diagnostic-tool',
    name: 'Face split diagnostic tool',
    type: 'extrude',
    sketch: {
      id: 'sketch-diagnostic-tool',
      name: 'Face split diagnostic tool profile',
      entities: [
        { id: 'diagnostic-tool-bottom', kind: 'line', a: [8, -2], b: [12, -2] },
        { id: 'diagnostic-tool-right', kind: 'line', a: [12, -2], b: [12, 2] },
        { id: 'diagnostic-tool-top', kind: 'line', a: [12, 2], b: [8, 2] },
        { id: 'diagnostic-tool-left', kind: 'line', a: [8, 2], b: [8, -2] },
      ],
      groups: [],
      shapes: [{ kind: 'rect', x: 10, y: 0, w: 4, h: 4 }],
      z: 8,
    },
    plane: { kind: 'base', plane: 'XY' },
    h: 4,
    through: false,
    resultPolicy: { kind: 'new-body', bodyName: 'Face split diagnostic tool' },
    createdBodyId: toolBody.id,
    suppressed: false,
    inputRefs: [],
    extensions: { exactSketchEntities: true },
  };
  const cut = {
    id: 'feature-diagnostic-boolean',
    name: 'Boolean with split source face',
    type: 'boolean',
    operation: 'subtract',
    toolBodyIds: [toolBody.id],
    resultPolicy: { kind: 'subtract', targetBodyIds: ['body-face-attached'], keepTools: true },
    suppressed: false,
    inputRefs: [
      bodyInputReference('body-face-attached', 'target'),
      bodyInputReference(toolBody.id, 'tool'),
    ],
  };
  const transform = {
    id: 'feature-diagnostic-transform',
    name: 'Transform after ambiguous face history',
    type: 'transform',
    operation: 'move',
    transform: { mode: 'move', translation: ['diagnostic_shift', 0, 0] },
    sourceBodyId: 'body-face-attached',
    resultPolicy: { kind: 'add', targetBodyIds: ['body-face-attached'] },
    suppressed: false,
    inputRefs: [bodyInputReference('body-face-attached', 'target')],
  };
  part.bodies.push(toolBody);
  part.features = [stock, tool, cut, transform];
  part.featureOrder = [stock.id, tool.id, cut.id, transform.id];
  part.bodies[0].featureIds = [stock.id, cut.id, transform.id];
  document.metadata = { corpus: 'checkpoint-diagnostic-propagation' };
  return saveReopen(document, 'checkpoint diagnostic propagation');
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as JsonDocument;
const sourceSnapshot = JSON.stringify(fixture);
const base = saveReopen(fixture, 'base');
invariant(JSON.stringify(fixture) === sourceSnapshot, 'fixture preparation mutated the source object');
invariant(
  feature(base, 'feature-face-cut').onFace?.name === 'Ffeature-face-stock:cap:end',
  'face-attached Cut does not store its support as a persistent face name',
);

const fixtureTypes = [...new Set<string>(rootPart(base).features.map((entry: JsonDocument) => String(entry.type)))]
  .filter((type) => coveredFeatureTypes.includes(type))
  .sort();
sameStrings(
  fixtureTypes,
  coveredFeatureTypes.filter((type) => type !== 'imported-step').sort(),
  'fixture registered feature coverage',
);

const reopened = saveReopen(base, 'save/reopen');
invariant(studioV5CanonicalHash(reopened) === studioV5CanonicalHash(base), 'save/reopen changed the document hash');
const mutationDefinitions: Array<[string, string, number]> = [
  ['chamfer-edit', 'chamfer_size', 2],
  ['draft-edit', 'draft_angle', 6],
  ['revolve-edit', 'revolve_angle', 240],
  ['thicken-edit', 'thicken_distance', 3],
  ['transform-edit', 'transform_dx', 38],
  ['split-edit', 'split_target_height', 14],
  ['face-support-edit', 'face_stock_height', 14],
];
const validVariants = [{ id: 'base', document: base }, { id: 'save-reopen', document: reopened }];
let working = reopened;
for (const [id, parameterName, value] of mutationDefinitions) {
  const edited = clone(working);
  setParameter(edited, parameterName, value);
  working = saveReopen(edited, id);
  validVariants.push({ id, document: working });
}
const thinChamferSource = isolatedThinChamfer(base, null);

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-feature-registry-runtime-'));
let local: RunningPartModeServer | undefined;
let browser: Browser | undefined;

try {
  local = await startPartModeServer({
    distDir: resolve(root, 'dist'),
    host: '127.0.0.1',
    port: 0,
    stateDir: resolve(temporaryDirectory, 'state'),
  });
  const health = await fetch(new URL('/healthz', local.url));
  invariant(health.ok, `local PartMode health returned HTTP ${health.status}`);
  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 300_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const response = await page.goto(local.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  invariant(response?.status() === 200, `local PartMode page returned HTTP ${response?.status() ?? 0}`);

  const expectedBodyIds: string[] = rootPart(base).bodies.map((entry: JsonDocument) => String(entry.id));
  const validResults = await runWorkerSequence(page, 'registered-feature-valid', validVariants);
  for (const result of validResults) assertValidRebuild(result, expectedBodyIds);
  assertStableTopology(validResults, expectedBodyIds);
  for (const bodyId of expectedBodyIds) {
    invariant(
      body(validResults[0]!, bodyId).exactBrep === body(validResults[1]!, bodyId).exactBrep,
      `save/reopen changed exact BREP bytes for ${bodyId}`,
    );
  }
  const namedSupportFace = 'Ffeature-face-stock:cap:end';
  for (const result of validResults) {
    invariant(
      topology(body(result, 'body-face-attached'), `${result.id}/body-face-attached`).faceNames.includes(namedSupportFace),
      `${result.id}/body-face-attached: named support face ${namedSupportFace} did not survive the face-attached Cut`,
    );
  }
  const faceSupportEdit = validResults.find((entry) => entry.id === 'face-support-edit');
  invariant(faceSupportEdit, 'face-support-edit rebuild result is missing');
  for (const featureId of ['feature-face-stock', 'feature-face-cut']) {
    invariant(
      (faceSupportEdit.evaluation.evaluatedFeatureIds || []).includes(featureId),
      `face-support-edit did not reevaluate ${featureId}`,
    );
  }

  const affectedBodies: Record<string, string[]> = {
    'chamfer-edit': ['body-chamfer'],
    'draft-edit': ['body-draft'],
    'revolve-edit': ['body-revolve'],
    'thicken-edit': ['body-thickened'],
    'transform-edit': ['body-transform-copy'],
    'split-edit': ['body-split-target', 'body-split-outside', 'body-split-inside'],
    'face-support-edit': ['body-face-attached'],
  };
  for (let index = 2; index < validResults.length; index += 1) {
    const previous = validResults[index - 1]!;
    const current = validResults[index]!;
    for (const bodyId of affectedBodies[current.id] || []) {
      invariant(
        body(previous, bodyId).exactBrep !== body(current, bodyId).exactBrep,
        `${current.id}/${bodyId}: parameter edit did not change exact BREP bytes`,
      );
    }
  }

  const thinSourceResult = (await runWorkerSequence(page, 'registered-feature-ambiguity-source', [
    { id: 'thin-chamfer-source', document: thinChamferSource },
  ]))[0]!;
  assertValidRebuild(thinSourceResult, ['body-chamfer']);
  const ambiguousSignature = deriveAmbiguousEdgeSignature(
    topology(body(thinSourceResult, 'body-chamfer'), 'thin-chamfer-source/body-chamfer'),
  );
  const ambiguous = isolatedThinChamfer(base, ambiguousSignature);
  const ambiguousResult = (await runWorkerSequence(page, 'registered-feature-ambiguous', [
    { id: 'cold-ambiguous-chamfer', document: ambiguous },
  ]))[0]!;
  invariant(ambiguousResult.kind === 'rebuild-result', 'ambiguous chamfer did not return rebuild-result');
  invariant(ambiguousResult.warnings.length === 0, `ambiguous chamfer warnings ${JSON.stringify(ambiguousResult.warnings)}`);
  invariant(ambiguousResult.errors.length === 1, `ambiguous chamfer expected one error, received ${JSON.stringify(ambiguousResult.errors)}`);
  invariant(ambiguousResult.errors[0]?.featureId === 'feature-chamfer', 'ambiguous chamfer error was attributed to the wrong feature');
  invariant(
    /2 edge candidates matched the stored signature/i.test(String(ambiguousResult.errors[0]?.message || '')),
    `ambiguous chamfer did not expose explicit candidate ambiguity: ${ambiguousResult.errors[0]?.message || ''}`,
  );
  const ambiguousBody = body(ambiguousResult, 'body-chamfer');
  invariant(!ambiguousBody.lastValid, 'cold ambiguous chamfer used last-valid geometry');
  invariant(ambiguousBody.topology === null, 'cold ambiguous chamfer emitted silently retargeted topology');
  invariant(ambiguousBody.exactBrep === null, 'cold ambiguous chamfer emitted silently retargeted exact BREP');

  const diagnosticBaseline = diagnosticCheckpointDocument(base, 1);
  const diagnosticFailure = (await runWorkerSequence(page, 'checkpoint-diagnostic-fail-closed', [
    { id: 'checkpoint-diagnostic-baseline', document: diagnosticBaseline },
  ]))[0]!;
  invariant(diagnosticFailure.kind === 'rebuild-result', 'checkpoint naming ambiguity did not return rebuild-result');
  invariant(diagnosticFailure.warnings.length === 0,
    `checkpoint naming ambiguity warnings ${JSON.stringify(diagnosticFailure.warnings)}`);
  invariant(
    diagnosticFailure.errors.length === 1
    && diagnosticFailure.errors[0]?.featureId === 'feature-diagnostic-boolean'
    && diagnosticFailure.errors[0]?.code === 'TOPOLOGY_NAMING_AMBIGUOUS_SUFFIX',
    `checkpoint naming ambiguity was not an explicit feature failure: ${JSON.stringify(diagnosticFailure.errors)}`,
  );
  const diagnosticFailedBody = body(diagnosticFailure, 'body-face-attached');
  invariant(!diagnosticFailedBody.lastValid, 'cold checkpoint naming ambiguity used last-valid geometry');
  invariant(diagnosticFailedBody.topology === null, 'checkpoint naming ambiguity emitted topology');
  invariant(diagnosticFailedBody.exactBrep === null, 'checkpoint naming ambiguity emitted exact BREP');
  invariant(diagnosticFailedBody.geometry === null, 'checkpoint naming ambiguity emitted geometry properties');

  const importSourceBrep = body(validResults[0]!, 'body-transform-source').exactBrep;
  invariant(importSourceBrep, 'import source canonical BREP is missing');
  const importedFixture = await importedStepFixture(importSourceBrep);
  const imported = importedFixture.document;
  const importedReopened = saveReopen(imported, 'imported STEP save/reopen');
  const importedResults = await runWorkerSequence(page, 'registered-feature-imported', [
    { id: 'imported-step', document: imported },
    { id: 'imported-step-save-reopen', document: importedReopened },
  ]);
  let importBlocker: Error | null = null;
  for (const result of importedResults) {
    invariant(result.kind === 'rebuild-result', `${result.id}: worker did not return rebuild-result`);
    invariant(result.errors.length === 0, `${result.id}: worker errors ${JSON.stringify(result.errors)}`);
    invariant(result.warnings.length === 0, `${result.id}: worker warnings ${JSON.stringify(result.warnings)}`);
    const importedBody = body(result, 'body-imported-step');
    const importedTopology = assertExactBody(importedBody, `${result.id}/body-imported-step`);
    try {
      assertCompleteTopology(importedTopology, `${result.id}/body-imported-step`);
    } catch (error) {
      importBlocker ||= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (!importBlocker) {
    assertStableTopology(importedResults, ['body-imported-step']);
    invariant(
      body(importedResults[0]!, 'body-imported-step').exactBrep === body(importedResults[1]!, 'body-imported-step').exactBrep,
      'imported STEP save/reopen changed exact BREP bytes',
    );
  }

  const downstreamKinds: ImportedDownstreamKind[] = [
    'transform',
    'draft',
    'shell',
    'thicken',
    'fillet',
    'chamfer',
    'boolean',
    'boolean-split',
  ];
  const importedDownstream: Record<string, Record<string, unknown>> = {};
  for (const kind of downstreamKinds) {
    const baselineDocument = importedDownstreamDocument(importedFixture, kind, 2);
    const reopenedDocument = saveReopen(baselineDocument, `imported ${kind} save/reopen`);
    const editedDocument = clone(reopenedDocument);
    setParameter(editedDocument, 'import_shift', 3);
    const reopenedEdit = saveReopen(editedDocument, `imported ${kind} upstream edit`);
    const warmResults = await runWorkerSequence(page, `registered-feature-imported-${kind}`, [
      { id: `${kind}-baseline`, document: baselineDocument },
      { id: `${kind}-save-reopen`, document: reopenedDocument },
      { id: `${kind}-warm-upstream-edit`, document: reopenedEdit },
    ]);
    const coldEdit = (await runWorkerSequence(page, `registered-feature-imported-${kind}-cold`, [
      { id: `${kind}-cold-upstream-edit`, document: reopenedEdit },
    ]))[0]!;
    const expectedBodies = kind === 'boolean'
      ? ['body-imported-step', 'body-imported-tool']
      : kind === 'boolean-split'
        ? ['body-imported-step', 'body-imported-tool', 'body-imported-split']
        : kind === 'thicken'
          ? ['body-imported-step', 'body-imported-thickened']
        : ['body-imported-step'];
    for (const result of [...warmResults, coldEdit]) assertValidRebuild(result, expectedBodies);
    const resultBodyId = kind === 'boolean-split'
      ? 'body-imported-split'
      : kind === 'thicken'
        ? 'body-imported-thickened'
        : 'body-imported-step';
    const summaries = warmResults.map((result) =>
      topology(body(result, resultBodyId), `${result.id}/${resultBodyId}`));
    const coldSummary = topology(body(coldEdit, resultBodyId), `${coldEdit.id}/${resultBodyId}`);
    const warmEdit = warmResults[2]!;
    const dirtyFeatureId = kind === 'transform'
      ? 'feature-imported-transform'
      : `feature-imported-${kind}`;
    invariant(
      (warmEdit.evaluation.reusedFeatureIds || []).includes('feature-imported-step'),
      `${kind}: warm upstream edit did not restore the imported-step carrier checkpoint`,
    );
    invariant(
      !(warmEdit.evaluation.evaluatedFeatureIds || []).includes('feature-imported-step'),
      `${kind}: warm upstream edit unnecessarily re-evaluated imported-step`,
    );
    for (const featureId of new Set(['feature-imported-transform', dirtyFeatureId])) {
      invariant(
        (warmEdit.evaluation.evaluatedFeatureIds || []).includes(featureId),
        `${kind}: warm upstream edit did not evaluate dirty feature ${featureId}`,
      );
    }
    assertStableTopology(warmResults.slice(0, 2), expectedBodies);
    sameStrings(coldSummary.faceNames, summaries[2]!.faceNames, `${kind}: warm/cold edited face names`);
    sameStrings(coldSummary.edgeNames, summaries[2]!.edgeNames, `${kind}: warm/cold edited edge names`);
    sameStrings(coldSummary.vertexNames, summaries[2]!.vertexNames, `${kind}: warm/cold edited vertex names`);
    invariant(
      body(warmResults[0]!, resultBodyId).exactBrep === body(warmResults[1]!, resultBodyId).exactBrep,
      `${kind}: save/reopen changed exact BREP bytes`,
    );
    invariant(
      body(warmResults[1]!, resultBodyId).exactBrep !== body(warmResults[2]!, resultBodyId).exactBrep,
      `${kind}: upstream transform edit did not change exact BREP bytes`,
    );
    const opaqueEdges = summaries.map((summary) =>
      importedFixture.opaque.edgeNames.filter((name) => summary.edgeNames.includes(name)));
    const opaqueVertices = summaries.map((summary) =>
      importedFixture.opaque.vertexNames.filter((name) => summary.vertexNames.includes(name)));
    invariant(opaqueEdges[0]!.length > 0, `${kind}: no opaque imported edge identity survived downstream`);
    invariant(opaqueVertices[0]!.length > 0, `${kind}: no opaque imported vertex identity survived downstream`);
    sameStrings(opaqueEdges[1]!, opaqueEdges[0]!, `${kind}: save/reopen opaque edge survivors`);
    sameStrings(opaqueVertices[1]!, opaqueVertices[0]!, `${kind}: save/reopen opaque vertex survivors`);
    sameStrings(opaqueEdges[2]!, opaqueEdges[0]!, `${kind}: upstream edit opaque edge survivors`);
    sameStrings(opaqueVertices[2]!, opaqueVertices[0]!, `${kind}: upstream edit opaque vertex survivors`);
    if (kind === 'transform') {
      sameStrings(opaqueEdges[0]!, importedFixture.opaque.edgeNames, `${kind}: complete opaque edge propagation`);
      sameStrings(opaqueVertices[0]!, importedFixture.opaque.vertexNames, `${kind}: complete opaque vertex propagation`);
    } else {
      invariant(
        summaries[0]!.edgeNames.some((name) => !importedFixture.opaque.edgeNames.includes(name)),
        `${kind}: new exact edges did not receive derived provenance names`,
      );
      invariant(
        summaries[0]!.vertexNames.some((name) => !importedFixture.opaque.vertexNames.includes(name)),
        `${kind}: new exact vertices did not receive derived provenance names`,
      );
    }
    let booleanToolBrepUnchanged: boolean | null = null;
    if (kind === 'boolean') {
      const toolOnlyDocument = clone(baselineDocument);
      feature(toolOnlyDocument, 'feature-imported-boolean').suppressed = true;
      const toolOnly = (await runWorkerSequence(page, 'registered-feature-imported-boolean-tool-only', [
        { id: 'boolean-tool-only', document: saveReopen(toolOnlyDocument, 'imported Boolean tool-only control') },
      ]))[0]!;
      assertValidRebuild(toolOnly, ['body-imported-step', 'body-imported-tool']);
      const expectedToolBrep = body(toolOnly, 'body-imported-tool').exactBrep;
      booleanToolBrepUnchanged = [...warmResults, coldEdit].every((result) =>
        body(result, 'body-imported-tool').exactBrep === expectedToolBrep);
      invariant(booleanToolBrepUnchanged, 'boolean: cached tool BREP changed after Boolean evaluation');
    }
    importedDownstream[kind] = {
      faces: summaries[0]!.faceCount,
      edges: summaries[0]!.edgeCount,
      vertices: summaries[0]!.vertexCount,
      survivingOpaqueEdges: opaqueEdges[0]!.length,
      survivingOpaqueVertices: opaqueVertices[0]!.length,
      saveReopenStable: true,
      upstreamEditWarmColdStable: true,
      warmCheckpointPrefix: {
        reusedFeatureIds: warmEdit.evaluation.reusedFeatureIds,
        evaluatedFeatureIds: warmEdit.evaluation.evaluatedFeatureIds,
      },
      ...(booleanToolBrepUnchanged === null ? {} : { booleanToolBrepUnchanged }),
    };
  }

  const ambiguousImportedBoolean = importedDownstreamDocument(
    importedFixture,
    'boolean',
    0,
    { ambiguousBoolean: true },
  );
  const ambiguousImportedResult = (await runWorkerSequence(page, 'registered-feature-imported-boolean-ambiguity', [
    { id: 'imported-boolean-explicit-edge-split', document: ambiguousImportedBoolean },
  ]))[0]!;
  invariant(
    ambiguousImportedResult.errors.length === 1,
    `imported Boolean split ambiguity expected one error, received ${JSON.stringify(ambiguousImportedResult.errors)}`,
  );
  invariant(
    ambiguousImportedResult.errors[0]?.code === 'TOPOLOGY_NAMING_AMBIGUOUS_SUFFIX',
    `imported Boolean split ambiguity returned ${ambiguousImportedResult.errors[0]?.code || 'no structured code'}`,
  );
  const ambiguousImportedBody = body(ambiguousImportedResult, 'body-imported-step');
  invariant(!ambiguousImportedBody.lastValid, 'imported Boolean split ambiguity used last-valid geometry');
  invariant(ambiguousImportedBody.topology === null, 'imported Boolean split ambiguity emitted topology');
  invariant(ambiguousImportedBody.exactBrep === null, 'imported Boolean split ambiguity emitted exact BREP');

  const missingRegistry = clone(imported);
  delete missingRegistry.resources[0].extensions.studioImportedStep.topologyRegistry;
  const mismatchedRegistry = clone(imported);
  feature(mismatchedRegistry, 'feature-imported-step').extensions.studioImportedStep.topologyRegistry.registryId =
    'resource-imported-step-mismatch';
  const invalidImportResults = await runWorkerSequence(page, 'registered-feature-imported-fail-closed', [
    { id: 'imported-step-missing-registry', document: missingRegistry },
    { id: 'imported-step-mismatched-registry', document: mismatchedRegistry },
  ]);
  const expectedImportFailures = [
    ['IMPORTED_TOPOLOGY_REGISTRY_INVALID_REGISTRY', /malformed or unsupported/i],
    ['IMPORTED_TOPOLOGY_REGISTRY_REFERENCE_MISMATCH', /do not match/i],
  ] as const;
  for (const [index, result] of invalidImportResults.entries()) {
    const [expectedCode, expectedMessage] = expectedImportFailures[index]!;
    invariant(result.kind === 'rebuild-result', `${result.id}: invalid import did not return rebuild-result`);
    invariant(result.errors.length === 1, `${result.id}: expected one fail-closed error, received ${JSON.stringify(result.errors)}`);
    invariant(result.errors[0]?.code === expectedCode, `${result.id}: expected ${expectedCode}, received ${result.errors[0]?.code || 'no code'}`);
    invariant(expectedMessage.test(String(result.errors[0]?.message || '')), `${result.id}: missing explicit registry diagnostic`);
    const failedBody = body(result, 'body-imported-step');
    invariant(!failedBody.lastValid, `${result.id}: invalid import used last-valid geometry`);
    invariant(failedBody.exactBrep === null, `${result.id}: invalid import emitted exact BREP`);
    invariant(failedBody.topology === null, `${result.id}: invalid import emitted topology`);
  }

  const baseCounts = Object.fromEntries(expectedBodyIds.map((bodyId) => {
    const summary = topology(body(validResults[0]!, bodyId), `summary/${bodyId}`);
    return [bodyId, {
      faces: summary.faceCount,
      namedFaces: summary.faceNames.length,
      edges: summary.edgeCount,
      namedEdges: summary.edgeNames.length,
      vertices: summary.vertexCount,
      namedVertices: summary.vertexNames.length,
    }];
  }));
  const importedCounts = topology(body(importedResults[0]!, 'body-imported-step'), 'summary/imported-step');
  console.log(JSON.stringify({
    ok: importBlocker === null,
    exactValidRebuilds: validResults.length,
    coveredFeatureTypes,
    baseCounts,
    parameterEdits: mutationDefinitions.map(([id, name, value]) => ({ id, name, value })),
    saveReopenExactBrepStable: true,
    faceAttachedCut: {
      supportFaceName: namedSupportFace,
      upstreamEdit: { parameter: 'face_stock_height', from: 10, to: 14 },
      topology: baseCounts['body-face-attached'],
      reevaluatedFeatureIds: ['feature-face-stock', 'feature-face-cut'],
    },
    failClosedAmbiguity: {
      featureId: ambiguousResult.errors[0]?.featureId,
      message: ambiguousResult.errors[0]?.message,
      lastValid: ambiguousBody.lastValid,
      emittedTopology: ambiguousBody.topology !== null,
    },
    checkpointPersistenceFailClosed: {
      code: diagnosticFailure.errors[0]?.code,
      featureId: diagnosticFailure.errors[0]?.featureId,
      emittedGeometry: diagnosticFailedBody.geometry !== null,
      emittedTopology: diagnosticFailedBody.topology !== null,
    },
    importedStep: {
      exactGeometryValid: body(importedResults[0]!, 'body-imported-step').geometry?.valid === true,
      faces: importedCounts.faceCount,
      namedFaces: importedCounts.faceNames.length,
      edges: importedCounts.edgeCount,
      namedEdges: importedCounts.edgeNames.length,
      vertices: importedCounts.vertexCount,
      namedVertices: importedCounts.vertexNames.length,
      diagnostics: importedCounts.diagnostics,
      blocker: importBlocker?.message || null,
      downstream: importedDownstream,
      downstreamAmbiguity: {
        code: ambiguousImportedResult.errors[0]?.code,
        emittedTopology: ambiguousImportedBody.topology !== null,
      },
      failClosed: invalidImportResults.map((result) => ({
        id: result.id,
        code: result.errors[0]?.code,
        emittedTopology: body(result, 'body-imported-step').topology !== null,
      })),
    },
  }));

  invariant(
    !importBlocker,
    'imported-step persistent-topology gate is blocked: ' + importBlocker?.message,
  );
  console.log('Registered feature runtime smoke OK');
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
