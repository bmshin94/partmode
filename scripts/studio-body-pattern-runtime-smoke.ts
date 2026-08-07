import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  vertexCount: number;
  vertexNames: string[];
  diagnostics: Array<{ code?: string; reason?: string; severity?: string }>;
}

interface BodySummary {
  bodyId: string;
  sourceBodyId: string;
  visible: boolean;
  patternInstance: Record<string, any> | null;
  renderSourceBodyId: string | null;
  renderTransform: number[] | null;
  sharesSourceGeometry: boolean;
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
const fixturePath = resolve(root, 'tests', 'body-pattern-runtime', 'body-patterns.partmode.json');

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

function setParameter(document: JsonDocument, name: string, value: number): void {
  const matches = document.parameters.filter((parameter: Record<string, any>) => parameter.name === name);
  invariant(matches.length === 1, `parameter ${name} did not resolve exactly once`);
  matches[0].value = value;
}

function sourceFeature(document: JsonDocument): Record<string, any> {
  const part = document.partDefinitions.find((entry: Record<string, any>) =>
    entry.id === document.rootDocument.partId);
  invariant(part, 'fixture root part is missing');
  const feature = part.features.find((entry: Record<string, any>) => entry.id === 'feature-pattern-source');
  invariant(feature, 'fixture source feature is missing');
  return feature;
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
  invariant(typeof bodyResult.exactBrep === 'string' && bodyResult.exactBrep.length > 100, `${label}: canonical BREP evidence is missing`);
  return topology(bodyResult, label);
}

function assertCompleteTopology(summary: TopologySummary, label: string): void {
  invariant(summary.faceCount > 0, `${label}: exact faces are missing`);
  invariant(summary.edgeCount > 0, `${label}: exact edges are missing`);
  invariant(summary.vertexCount > 0, `${label}: exact vertices are missing`);
  invariant(summary.faceNames.length === summary.faceCount,
    `${label}: only ${summary.faceNames.length}/${summary.faceCount} exact faces are named`);
  invariant(summary.edgeNames.length === summary.edgeCount,
    `${label}: only ${summary.edgeNames.length}/${summary.edgeCount} exact edges are named`);
  invariant(summary.vertexNames.length === summary.vertexCount,
    `${label}: only ${summary.vertexNames.length}/${summary.vertexCount} exact vertices are named`);
  invariant(summary.diagnostics.length === 0,
    `${label}: topology diagnostics ${JSON.stringify(summary.diagnostics)}`);
}

function assertLinkedOccurrence(bodyResult: BodySummary, patternIndex: number, label: string): void {
  invariant(!bodyResult.error, `${label}: occurrence error ${bodyResult.error?.message || 'unknown'}`);
  invariant(!bodyResult.lastValid, `${label}: occurrence used last-valid geometry`);
  invariant(bodyResult.patternInstance?.patternId === 'pattern-linked', `${label}: wrong pattern identity`);
  invariant(bodyResult.patternInstance?.index === patternIndex, `${label}: wrong occurrence index`);
  invariant(bodyResult.sourceBodyId === 'body-pattern-source', `${label}: wrong source identity`);
  invariant(bodyResult.renderSourceBodyId === 'body-pattern-source', `${label}: linked occurrence does not render exact source geometry`);
  invariant(bodyResult.geometry?.valid === true && bodyResult.geometry?.brepValid === true,
    `${label}: transformed exact occurrence is invalid`);
  invariant(bodyResult.geometry?.solidCount === 1 && Number(bodyResult.geometry?.volume) > 1e-8,
    `${label}: transformed occurrence is not one positive-volume solid`);
  invariant(Array.isArray(bodyResult.renderTransform) && bodyResult.renderTransform.length === 16,
    `${label}: rigid render transform is missing`);
  invariant(bodyResult.topology === null, `${label}: linked occurrence unexpectedly duplicated its source mesh`);
}

function patternIds(result: RebuildSummary, field: string): string[] {
  return [...(result.evaluation[field] || [])].sort();
}

function assertTranslationX(result: RebuildSummary, bodyId: string, expected: number): void {
  const matrix = body(result, bodyId).renderTransform;
  invariant(matrix && matrix.length === 16, `${result.id}/${bodyId}: render transform is missing`);
  invariant(Math.abs((matrix[12] ?? Number.NaN) - expected) <= 1e-8,
    `${result.id}/${bodyId}: expected X translation ${expected}, received ${matrix[12]}`);
}

function assertValidRebuild(result: RebuildSummary): void {
  invariant(result.kind === 'rebuild-result', `${result.id}: worker did not return rebuild-result`);
  invariant(result.errors.length === 0, `${result.id}: worker errors ${JSON.stringify(result.errors)}`);
  invariant(result.warnings.length === 0, `${result.id}: worker warnings ${JSON.stringify(result.warnings)}`);
  const expectedIds = [
    'body-pattern-source',
    'pattern-linked-instance-1',
    'pattern-linked-instance-2',
    'pattern-union-instance-1',
    'pattern-union-instance-2',
    'pattern-union-fused',
  ];
  sameStrings(result.bodies.map((entry) => entry.bodyId), expectedIds, `${result.id}: body order`);
  const sourceTopology = assertExactBody(body(result, 'body-pattern-source'), `${result.id}/source`);
  assertCompleteTopology(sourceTopology, `${result.id}/source`);
  assertLinkedOccurrence(body(result, 'pattern-linked-instance-1'), 1, `${result.id}/linked-1`);
  assertLinkedOccurrence(body(result, 'pattern-linked-instance-2'), 2, `${result.id}/linked-2`);
  const fused = body(result, 'pattern-union-fused');
  const fusedTopology = assertExactBody(fused, `${result.id}/union-fused`);
  assertCompleteTopology(fusedTopology, `${result.id}/union-fused`);
  invariant(fused.patternInstance?.patternId === 'pattern-union', `${result.id}: fused pattern identity changed`);
  invariant(fused.patternInstance?.fused === true, `${result.id}: fused result is not marked fused`);
  for (const generatedId of ['pattern-union-instance-1', 'pattern-union-instance-2']) {
    const generated = body(result, generatedId);
    invariant(generated.visible === false, `${result.id}/${generatedId}: fused operand remained visible`);
    invariant(!generated.error && !generated.lastValid, `${result.id}/${generatedId}: fused operand failed or fell back`);
    invariant(generated.geometry?.valid === true && generated.geometry?.brepValid === true,
      `${result.id}/${generatedId}: fused operand exact shape is invalid`);
  }
}

function assertStableTopology(results: RebuildSummary[]): void {
  const baselineSource = topology(body(results[0]!, 'body-pattern-source'), 'baseline source');
  const baselineFused = topology(body(results[0]!, 'pattern-union-fused'), 'baseline fused');
  for (const result of results.slice(1)) {
    const currentSource = topology(body(result, 'body-pattern-source'), `${result.id} source`);
    const currentFused = topology(body(result, 'pattern-union-fused'), `${result.id} fused`);
    sameStrings(currentSource.faceNames, baselineSource.faceNames, `${result.id}: source face-name set`);
    sameStrings(currentSource.edgeNames, baselineSource.edgeNames, `${result.id}: source edge-name set`);
    sameStrings(currentSource.vertexNames, baselineSource.vertexNames, `${result.id}: source vertex-name set`);
    sameStrings(currentFused.faceNames, baselineFused.faceNames, `${result.id}: fused face-name set`);
    sameStrings(currentFused.edgeNames, baselineFused.edgeNames, `${result.id}: fused edge-name set`);
    sameStrings(currentFused.vertexNames, baselineFused.vertexNames, `${result.id}: fused vertex-name set`);
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
          const timeout = setTimeout(() => rejectResponse(new Error(`${variant.id}: exact worker timed out`)), 120_000);
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
          evaluation: Object.fromEntries(Object.entries(response.evaluation || {}).map(([key, values]) => [key, [...(values as string[])]])),
          bodies: (response.bodies || []).map((entry: Record<string, any>) => ({
            bodyId: String(entry.bodyId || ''),
            sourceBodyId: String(entry.sourceBodyId || ''),
            visible: entry.visible !== false,
            patternInstance: entry.patternInstance ? { ...entry.patternInstance } : null,
            renderSourceBodyId: typeof entry.renderSourceBodyId === 'string' ? entry.renderSourceBodyId : null,
            renderTransform: Array.isArray(entry.renderTransform) ? [...entry.renderTransform] : null,
            sharesSourceGeometry: entry.sharesSourceGeometry === true,
            exactBrep: typeof entry.exactBrep === 'string' ? entry.exactBrep : null,
            topology: entry.mesh ? {
              faceCount: Number(entry.mesh.topologyCounts?.faces ?? entry.mesh.topologyFaces?.length ?? 0),
              faceNames: (entry.mesh.topologyFaces || []).map((face: Record<string, any>) => face.name).filter((name: unknown) => typeof name === 'string').sort(),
              edgeCount: Number(entry.mesh.topologyCounts?.edges ?? entry.mesh.edges?.length ?? 0),
              edgeNames: (entry.mesh.edges || []).map((edge: Record<string, any>) => edge.name).filter((name: unknown) => typeof name === 'string').sort(),
              vertexCount: Number(entry.mesh.topologyCounts?.vertices ?? entry.mesh.topologyVertices?.length ?? 0),
              vertexNames: (entry.mesh.topologyVertices || []).map((vertex: Record<string, any>) => vertex.name).filter((name: unknown) => typeof name === 'string').sort(),
              diagnostics: (entry.mesh.topologyDiagnostics || []).map((diagnostic: Record<string, any>) => ({
                code: diagnostic.code,
                reason: diagnostic.reason,
                severity: diagnostic.severity,
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

const projectModule = await import(pathToFileURL(resolve(root, 'src', 'static', 'studio-project-v5.js')).href) as any;
const runtimeModule = await import(pathToFileURL(resolve(root, 'src', 'static', 'studio-v5-runtime-document.js')).href) as any;
const prepareStudioV5Project = projectModule.prepareStudioV5Project as (candidate: JsonDocument) => JsonDocument;
const parseStudioV5Project = projectModule.parseStudioV5Project as (source: string) => JsonDocument;
const studioV5CanonicalHash = runtimeModule.studioV5CanonicalHash as (candidate: JsonDocument) => string;
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as JsonDocument;
const workerSource = readFileSync(resolve(root, 'src', 'static', 'studio-kernel.worker.js'), 'utf8');
invariant(
  /const signature = stableSource\(\{[\s\S]*?pattern:/u.test(workerSource)
    && /signature: stableSource\(\{ pattern, patternParameterState, referenceState, source: source\.signature, fused: true \}\)/u.test(workerSource),
  'body-pattern geometry caches must use the complete canonical signature source',
);
invariant(
  !/signature\s*[:=]\s*stableHash\(\{[\s\S]{0,160}?pattern/u.test(workerSource),
  'body-pattern geometry cache still uses a bounded hash',
);

function saveReopen(candidate: JsonDocument, label: string): JsonDocument {
  const prepared = prepareStudioV5Project(clone(candidate));
  const saved = JSON.stringify(prepared);
  const reopened = parseStudioV5Project(saved);
  invariant(JSON.stringify(reopened) === saved, `${label}: save/reopen changed canonical JSON`);
  invariant(studioV5CanonicalHash(reopened) === studioV5CanonicalHash(parseStudioV5Project(JSON.stringify(reopened))),
    `${label}: canonical hash changed on a second reopen`);
  return reopened;
}

const base = saveReopen(fixture, 'base');
const reopened = saveReopen(base, 'reopened');
invariant(studioV5CanonicalHash(reopened) === studioV5CanonicalHash(base), 'save/reopen changed the document hash');
const linkedEdit = clone(reopened);
setParameter(linkedEdit, 'linked_spacing', 34);
const linkedEdited = saveReopen(linkedEdit, 'linked spacing edit');
const unionEdit = clone(linkedEdited);
setParameter(unionEdit, 'union_spacing', 9);
const unionEdited = saveReopen(unionEdit, 'union spacing edit');
const sourceEdit = clone(unionEdited);
setParameter(sourceEdit, 'source_height', 11);
const sourceEdited = saveReopen(sourceEdit, 'source height edit');
const incomplete = clone(sourceEdited);
delete sourceFeature(incomplete).extensions.exactSketchEntities;
const incompleteSource = saveReopen(incomplete, 'incomplete source edit');

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-body-pattern-runtime-'));
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

  const validVariants = [
    { id: 'base', document: base },
    { id: 'save-reopen', document: reopened },
    { id: 'linked-spacing-edit', document: linkedEdited },
    { id: 'union-spacing-edit', document: unionEdited },
    { id: 'source-height-edit', document: sourceEdited },
  ];
  const warmResults = await runWorkerSequence(page, 'body-pattern-warm', [
    ...validVariants,
    { id: 'warm-incomplete-source', document: incompleteSource },
  ]);
  const validResults = warmResults.slice(0, validVariants.length);
  for (const result of validResults) assertValidRebuild(result);
  assertStableTopology(validResults);

  const acceptanceFailures: string[] = [];
  const acceptance = (label: string, assertion: () => void): void => {
    try { assertion(); }
    catch (error) { acceptanceFailures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  acceptance('save/reopen exact pattern-table checkpoint reuse', () => sameStrings(
    patternIds(validResults[1]!, 'reusedPatternInstanceIds'),
    ['pattern-linked-instance-1', 'pattern-linked-instance-2', 'pattern-union-instance-1', 'pattern-union-instance-2'],
    'reused pattern ids',
  ));
  acceptance('save/reopen deterministic union refusion', () => sameStrings(
    patternIds(validResults[1]!, 'evaluatedPatternInstanceIds'), ['pattern-union-fused'], 'evaluated pattern ids'));
  acceptance('linked spacing dirty subgraph', () => sameStrings(
    patternIds(validResults[2]!, 'evaluatedPatternInstanceIds'),
    ['pattern-linked-instance-1', 'pattern-linked-instance-2', 'pattern-union-fused'],
    'evaluated pattern ids',
  ));
  acceptance('linked spacing preserved union checkpoints', () => sameStrings(
    patternIds(validResults[2]!, 'reusedPatternInstanceIds'),
    ['pattern-union-instance-1', 'pattern-union-instance-2'],
    'reused pattern ids',
  ));
  acceptance('union spacing dirty subgraph', () => sameStrings(
    patternIds(validResults[3]!, 'evaluatedPatternInstanceIds'),
    ['pattern-union-fused', 'pattern-union-instance-1', 'pattern-union-instance-2'],
    'evaluated pattern ids',
  ));
  acceptance('union spacing preserved linked checkpoints', () => sameStrings(
    patternIds(validResults[3]!, 'reusedPatternInstanceIds'),
    ['pattern-linked-instance-1', 'pattern-linked-instance-2'],
    'reused pattern ids',
  ));
  acceptance('source edit invalidated dependent pattern checkpoints', () => sameStrings(
    patternIds(validResults[4]!, 'evaluatedPatternInstanceIds'),
    ['pattern-linked-instance-1', 'pattern-linked-instance-2', 'pattern-union-fused', 'pattern-union-instance-1', 'pattern-union-instance-2'],
    'evaluated pattern ids',
  ));
  const translations = [
    { result: validResults[0]!, values: [30, 60, 8, 16] },
    { result: validResults[1]!, values: [30, 60, 8, 16] },
    { result: validResults[2]!, values: [34, 68, 8, 16] },
    { result: validResults[3]!, values: [34, 68, 9, 18] },
    { result: validResults[4]!, values: [34, 68, 9, 18] },
  ];
  for (const entry of translations) {
    const ids = [
      'pattern-linked-instance-1', 'pattern-linked-instance-2',
      'pattern-union-instance-1', 'pattern-union-instance-2',
    ];
    ids.forEach((id, index) => acceptance(`${entry.result.id}/${id} parameterized placement`, () =>
      assertTranslationX(entry.result, id, entry.values[index]!)));
  }
  invariant(body(validResults[0]!, 'body-pattern-source').exactBrep === body(validResults[1]!, 'body-pattern-source').exactBrep,
    'save/reopen changed exact source BREP bytes');
  invariant(body(validResults[0]!, 'pattern-union-fused').exactBrep === body(validResults[1]!, 'pattern-union-fused').exactBrep,
    'save/reopen changed exact fused BREP bytes');
  acceptance('union spacing changed exact fused BREP', () => invariant(
    body(validResults[2]!, 'pattern-union-fused').exactBrep !== body(validResults[3]!, 'pattern-union-fused').exactBrep,
    'fused BREP remained byte-identical after union_spacing changed from 8 to 9'));

  const coldInvalid = (await runWorkerSequence(page, 'body-pattern-cold-invalid', [
    { id: 'cold-incomplete-source', document: incompleteSource },
  ]))[0]!;
  invariant(coldInvalid.errors.length === 3, `cold incomplete source: expected the source error and two explicit pattern errors, received ${JSON.stringify(coldInvalid.errors)}`);
  sameStrings(coldInvalid.errors.map((entry) => String(entry.featureId)).sort(), ['feature-pattern-source', 'pattern-linked', 'pattern-union'],
    'cold incomplete source feature and pattern errors');
  invariant(coldInvalid.bodies.every((entry) => !entry.patternInstance), 'cold incomplete source emitted a generated pattern occurrence');
  invariant(coldInvalid.bodies.every((entry) => !entry.lastValid), 'cold incomplete source used last-valid geometry');
  const coldSource = body(coldInvalid, 'body-pattern-source');
  invariant(coldSource.topology === null && coldSource.geometry === null && coldSource.exactBrep === null,
    'cold incomplete source exposed mesh, geometry, or BREP evidence');
  invariant(coldSource.error?.code === 'INLINE_PROFILE_MISSING_SHAPE_ID',
    `cold incomplete source returned ${coldSource.error?.code || 'no exact body error code'}`);
  invariant(
    coldSource.error?.message === 'An inline sketch shape has no explicit stable id, so it cannot own persistent topology.',
    `cold incomplete source returned unexpected body error ${JSON.stringify(coldSource.error)}`,
  );

  const warmInvalid = warmResults[validVariants.length]!;
  invariant(warmInvalid.errors.length === 3, `warm incomplete source: expected the source error and two explicit pattern errors, received ${JSON.stringify(warmInvalid.errors)}`);
  sameStrings(warmInvalid.errors.map((entry) => String(entry.featureId)).sort(), ['feature-pattern-source', 'pattern-linked', 'pattern-union'],
    'warm incomplete source feature and pattern errors');
  acceptance('warm incomplete source removed generated pattern occurrences', () => invariant(
    warmInvalid.bodies.every((entry) => !entry.patternInstance),
    `retained [${warmInvalid.bodies.filter((entry) => entry.patternInstance).map((entry) => entry.bodyId).join(', ')}]`));
  acceptance('warm incomplete source rejected last-valid pattern geometry', () => invariant(
    warmInvalid.bodies.every((entry) => !entry.lastValid),
    `last-valid [${warmInvalid.bodies.filter((entry) => entry.lastValid).map((entry) => entry.bodyId).join(', ')}]`));
  const warmSource = body(warmInvalid, 'body-pattern-source');
  acceptance('warm incomplete source published zero geometry', () => invariant(
    warmSource.topology === null && warmSource.geometry === null && warmSource.exactBrep === null && !warmSource.lastValid,
    'warm incomplete source exposed mesh, geometry, BREP, or last-valid evidence'));
  acceptance('warm incomplete source retained its exact diagnostic', () => invariant(
    warmSource.error?.code === 'INLINE_PROFILE_MISSING_SHAPE_ID',
    `returned ${warmSource.error?.code || 'no exact body error code'}`));

  const sourceCounts = topology(body(validResults[0]!, 'body-pattern-source'), 'summary source');
  const fusedCounts = topology(body(validResults[0]!, 'pattern-union-fused'), 'summary fused');
  console.log(JSON.stringify({
    ok: acceptanceFailures.length === 0,
    validExactRebuilds: validResults.length,
    sourceTopology: {
      faces: sourceCounts.faceCount,
      namedFaces: sourceCounts.faceNames.length,
      edges: sourceCounts.edgeCount,
      namedEdges: sourceCounts.edgeNames.length,
      vertices: sourceCounts.vertexCount,
      namedVertices: sourceCounts.vertexNames.length,
    },
    fusedTopology: {
      faces: fusedCounts.faceCount,
      namedFaces: fusedCounts.faceNames.length,
      edges: fusedCounts.edgeCount,
      namedEdges: fusedCounts.edgeNames.length,
      vertices: fusedCounts.vertexCount,
      namedVertices: fusedCounts.vertexNames.length,
    },
    saveReopenExactBrepStable: true,
    coldIncompleteSourceFailedClosed: true,
    acceptanceFailures,
  }));
  invariant(acceptanceFailures.length === 0,
    `body-pattern runtime acceptance failed:\n- ${acceptanceFailures.join('\n- ')}`);

  console.log(JSON.stringify({
    ok: true,
    exactRebuilds: validResults.length + 2,
    sourceTopology: {
      faces: sourceCounts.faceCount,
      edges: sourceCounts.edgeCount,
      vertices: sourceCounts.vertexCount,
    },
    fusedTopology: {
      faces: fusedCounts.faceCount,
      edges: fusedCounts.edgeCount,
      vertices: fusedCounts.vertexCount,
    },
    saveReopen: 'canonical JSON hash and exact source/fused BREP stable',
    linked: 'shared exact source geometry with reusable complete internal pattern tables',
    union: 'complete exact serialized face/edge/vertex names',
    parameterEdits: ['linked_spacing', 'union_spacing', 'source_height'],
    failClosed: ['cold-incomplete-source', 'warm-incomplete-source'],
  }));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
