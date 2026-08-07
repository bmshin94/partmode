import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;

interface StepFixture {
  id: string;
  filename: string;
  blob: Blob;
}

interface RawStepEvidence {
  rootValid: boolean;
  everySolidValid: boolean;
  solidCount: number;
  shellCount: number;
  faceCount: number;
  edgeCount: number;
  vertexCount: number;
  volume: number | null;
  bounds: number[][];
  faceOrientations: string[];
  solids: Array<{
    valid: boolean;
    volume: number;
    bounds: number[][];
  }>;
}

interface ExactBodyEvidence {
  bodyId: string;
  exactBrep: string;
  geometry: JsonRecord;
  faceNames: string[];
  edgeNames: string[];
  vertexNames: string[];
}

interface ImportedBodyEvidence {
  body: JsonRecord;
  feature: JsonRecord;
  resource: JsonRecord;
  healing: JsonRecord;
  brep: string;
  brepSha256: string;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..', '..');
const vendorDirectory = resolve(root, 'src', 'static', 'vendor');
const HEALING_SCHEMA = 'partmode.step-healing/v1';
const BOX_MIN = [0, 0, 0] as const;
const BOX_MAX = [20, 10, 8] as const;
const SECOND_BOX_MIN = [30, 0, 0] as const;
const SECOND_BOX_MAX = [50, 10, 8] as const;
const BOX_VOLUME = 20 * 10 * 8;
const WITHIN_POLICY_GAP_MM = 0.02;
const BEYOND_POLICY_GAP_MM = 0.20;
const POLICY_MAX_TOLERANCE_MM = Math.min(
  0.05,
  Math.max(0.001, Math.hypot(...BOX_MAX) * 0.001),
);
const MULTI_POLICY_MAX_TOLERANCE_MM = Math.min(
  0.05,
  Math.max(0.001, Math.hypot(...SECOND_BOX_MAX) * 0.001),
);
const SHIFTED_VOLUME = BOX_VOLUME + (20 * 10 * WITHIN_POLICY_GAP_MM) / 3;
const TRANSFORM_TRANSLATION = [3, 4, 5] as const;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`STEP import healing smoke failed: ${message}`);
}

function close(actual: number, expected: number, tolerance = 1e-7): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function safeDelete(value: any): void {
  try { value?.delete?.(); } catch {}
}

function sameStrings(actual: string[], expected: string[], label: string): void {
  invariant(
    actual.length === expected.length && actual.every((entry, index) => entry === expected[index]),
    `${label}: expected [${expected.join(', ')}], received [${actual.join(', ')}]`,
  );
}

function assertBounds(
  actual: unknown,
  expected: readonly [readonly number[], readonly number[]],
  tolerance: number,
  label: string,
): void {
  invariant(Array.isArray(actual) && actual.length === 2, `${label}: exact bounds are missing`);
  for (const side of [0, 1]) for (const axis of [0, 1, 2]) {
    const value = Number(actual[side]?.[axis]);
    const expectedValue = Number(expected[side]?.[axis]);
    invariant(
      close(value, expectedValue, tolerance),
      `${label}: bounds[${side}][${axis}] is ${value}; expected ${expectedValue} ± ${tolerance}`,
    );
  }
}

async function sha256Blob(blob: Blob): Promise<string> {
  return createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');
}

const nodeGlobals = globalThis as typeof globalThis & {
  require: ReturnType<typeof createRequire>;
  __dirname: string;
};
nodeGlobals.require = createRequire(import.meta.url);
nodeGlobals.__dirname = vendorDirectory;

const rc = await import(pathToFileURL(resolve(vendorDirectory, 'replicad.module.js')).href) as any;
const ocFactory = await import(pathToFileURL(resolve(vendorDirectory, 'replicad-oc.module.js')).href) as any;
const projectModule = await import(
  pathToFileURL(resolve(root, 'src', 'static', 'studio-project-v5.js')).href
) as any;
const runtimeModule = await import(
  pathToFileURL(resolve(root, 'src', 'static', 'studio-v5-runtime-document.js')).href
) as any;
const importedRegistryModule = await import(
  pathToFileURL(resolve(root, 'src', 'static', 'studio-imported-topology-registry.js')).href
) as any;

const oc = await ocFactory.default({
  locateFile: () => resolve(vendorDirectory, 'replicad_single.wasm'),
  print: () => {},
  printErr: () => {},
});
rc.setOC(oc);
const importedTopologyRegistry = importedRegistryModule.createStudioImportedTopologyRegistry(rc);
const prepareStudioV5Project = projectModule.prepareStudioV5Project as (candidate: JsonRecord) => JsonRecord;
const parseStudioV5Project = projectModule.parseStudioV5Project as (source: string) => JsonRecord;
const studioV5CanonicalHash = runtimeModule.studioV5CanonicalHash as (candidate: JsonRecord) => string;
const createStudioV5TransformFeature = runtimeModule.createStudioV5TransformFeature as (
  project: JsonRecord,
  options: JsonRecord,
) => JsonRecord;

function orientationName(orientation: any): string {
  if (orientation === oc.TopAbs_Orientation.TopAbs_FORWARD) return 'forward';
  if (orientation === oc.TopAbs_Orientation.TopAbs_REVERSED) return 'reversed';
  if (orientation === oc.TopAbs_Orientation.TopAbs_INTERNAL) return 'internal';
  if (orientation === oc.TopAbs_Orientation.TopAbs_EXTERNAL) return 'external';
  return 'unknown';
}

function topologyCount(shape: any, kind: string): number {
  let count = 0;
  for (const raw of rc.iterTopo(shape.wrapped, kind)) {
    count += 1;
    safeDelete(raw);
  }
  return count;
}

function detachedBoxFaces(): any[] {
  const box = rc.makeBox([...BOX_MIN], [...BOX_MAX]);
  const sourceFaces = box.faces;
  try {
    // Serializing every face separately deliberately severs shared TopoDS edge
    // and vertex identity. The resulting STEP fixture contains six exact face
    // records, not a shell disguised as six array entries.
    return sourceFaces.map((face: any) => rc.deserializeShape(face.serialize()));
  } finally {
    sourceFaces.forEach(safeDelete);
    safeDelete(box);
  }
}

function topFaceIndex(faces: any[]): number {
  const matches = faces
    .map((face, index) => ({ index, bounds: face.boundingBox.bounds }))
    .filter(({ bounds }) => close(bounds[0][2], BOX_MAX[2], 2e-6) && close(bounds[1][2], BOX_MAX[2], 2e-6));
  invariant(matches.length === 1, `top face resolved ${matches.length} times`);
  return matches[0]!.index;
}

function detachedFaceStepFixture(
  id: string,
  options: { shiftTopMm?: number; reverseTop?: boolean; omitTop?: boolean; translateXmm?: number } = {},
): StepFixture {
  const faces = detachedBoxFaces();
  let compound: any = null;
  try {
    const index = topFaceIndex(faces);
    if (options.shiftTopMm) {
      const shifted = faces[index].translateZ(options.shiftTopMm);
      safeDelete(faces[index]);
      faces[index] = shifted;
    }
    if (options.reverseTop) {
      const rawReversed = faces[index].wrapped.Reversed();
      let reversed: any = null;
      try { reversed = rc.cast(rawReversed); }
      finally { safeDelete(rawReversed); }
      safeDelete(faces[index]);
      faces[index] = reversed;
    }
    if (options.omitTop) {
      const [removed] = faces.splice(index, 1);
      safeDelete(removed);
    }
    if (options.translateXmm) {
      for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
        const translated = faces[faceIndex]!.translateX(options.translateXmm);
        safeDelete(faces[faceIndex]);
        faces[faceIndex] = translated;
      }
    }
    compound = rc.compoundShapes(faces.map((face) => face.clone()));
    return { id, filename: `${id}.step`, blob: compound.blobSTEP() };
  } finally {
    safeDelete(compound);
    faces.forEach(safeDelete);
  }
}

async function nonidentityPartModeManifestFixture(): Promise<StepFixture> {
  const source = detachedFaceStepFixture('nonidentity-manifest-source', {
    shiftTopMm: WITHIN_POLICY_GAP_MM,
    translateXmm: 5,
  });
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
  const manifest = {
    format: 'partmode-v8-step-assembly-1',
    schemaVersion: 5,
    units: 'mm',
    sourceUnits: 'mm',
    projectName: 'Nonidentity healed STEP refusal',
    rootAssemblyId: 'assembly-nonidentity-healed',
    parts: [{
      id: 'part-nonidentity-healed',
      definitionPartId: 'part-nonidentity-healed',
      name: 'Healed box',
      parameterOverrides: {},
      bodies: [{
        id: 'body-nonidentity-healed',
        name: 'Healed box',
        kind: 'solid',
        visible: true,
        materialId: null,
        appearanceId: null,
      }],
    }],
    assemblies: [{
      id: 'assembly-nonidentity-healed',
      name: 'Nonidentity healed assembly',
      occurrences: [{
        id: 'occurrence-nonidentity-healed',
        name: 'Healed box:1',
        definition: { kind: 'part', partId: 'part-nonidentity-healed' },
        transform,
        visible: true,
      }],
    }],
    bodyInstances: [{
      bodyId: 'body-nonidentity-healed',
      partId: 'part-nonidentity-healed',
      definitionPartId: 'part-nonidentity-healed',
      localBodyId: 'body-nonidentity-healed',
      name: 'Healed box',
      occurrencePath: ['occurrence-nonidentity-healed'],
      transform,
      bounds: [[5, 0, 0], [25, 10, BOX_MAX[2] + WITHIN_POLICY_GAP_MM]],
      volume: SHIFTED_VOLUME,
    }],
    materials: [],
    limitations: ['exact-brep-and-solved-hierarchy-only', 'no-parametric-feature-history', 'no-mate-recovery'],
  };
  const text = await source.blob.text();
  const marker = '/*PARTMODE_V8_MANIFEST:'
    + Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64')
    + '*/';
  const insertion = text.indexOf('\n');
  const marked = insertion < 0
    ? `${text}\n${marker}`
    : `${text.slice(0, insertion + 1)}${marker}\n${text.slice(insertion + 1)}`;
  return {
    id: 'partmode-manifest-nonidentity-healed',
    filename: 'partmode-manifest-nonidentity-healed.step',
    blob: new Blob([marked], { type: 'application/STEP' }),
  };
}

function separatedSolidStepFixture(): StepFixture {
  const boxes = [
    rc.makeBox([...BOX_MIN], [...BOX_MAX]),
    rc.makeBox([...SECOND_BOX_MIN], [...SECOND_BOX_MAX]),
  ];
  let compound: any = null;
  try {
    compound = rc.compoundShapes(boxes.map((box) => box.clone()));
    return {
      id: 'two-separated-solid-boxes',
      filename: 'two-separated-solid-boxes.step',
      blob: compound.blobSTEP(),
    };
  } finally {
    safeDelete(compound);
    boxes.forEach(safeDelete);
  }
}

function generateFixtures(): Record<string, StepFixture> {
  const clean = rc.makeBox([...BOX_MIN], [...BOX_MAX]);
  let cleanBlob: Blob;
  try { cleanBlob = clean.blobSTEP(); }
  finally { safeDelete(clean); }
  const generated = {
    clean: { id: 'clean-solid-box', filename: 'clean-solid-box.step', blob: cleanBlob! },
  } as Record<string, StepFixture>;
  for (const [id, factory] of [
    ['multi', () => separatedSolidStepFixture()],
    ['detached', () => detachedFaceStepFixture('six-disconnected-box-faces')],
    ['within', () => detachedFaceStepFixture('top-face-gap-0.02mm', { shiftTopMm: WITHIN_POLICY_GAP_MM })],
    ['flipped', () => detachedFaceStepFixture('one-flipped-box-face', { reverseTop: true })],
    ['beyond', () => detachedFaceStepFixture('top-face-gap-0.20mm', { shiftTopMm: BEYOND_POLICY_GAP_MM })],
    ['missing', () => detachedFaceStepFixture('missing-top-box-face', { omitTop: true })],
  ] as const) {
    generated[id] = factory();
  }
  return generated;
}

async function inspectRawStep(fixture: StepFixture): Promise<RawStepEvidence> {
  const imported = await rc.importSTEP(fixture.blob);
  const solids: any[] = [];
  let analyzer: any = null;
  try {
    analyzer = new oc.BRepCheck_Analyzer(imported.wrapped, true, false);
    for (const raw of rc.iterTopo(imported.wrapped, 'solid')) {
      let solid: any = null;
      try { solid = rc.cast(raw); }
      finally { safeDelete(raw); }
      solids.push(solid);
    }
    let everySolidValid = true;
    const solidEvidence: RawStepEvidence['solids'] = [];
    for (const solid of solids) {
      const solidAnalyzer = new oc.BRepCheck_Analyzer(solid.wrapped, true, false);
      try {
        const valid = solidAnalyzer.IsValid_2();
        everySolidValid &&= valid;
        solidEvidence.push({
          valid,
          volume: rc.measureVolume(solid),
          bounds: clone(solid.boundingBox.bounds),
        });
      }
      finally { safeDelete(solidAnalyzer); }
    }
    solidEvidence.sort((left, right) => left.bounds[0]![0]! - right.bounds[0]![0]!);
    const faceOrientations: string[] = [];
    for (const raw of rc.iterTopo(imported.wrapped, 'face')) {
      try { faceOrientations.push(orientationName(raw.Orientation_1())); }
      finally { safeDelete(raw); }
    }
    return {
      rootValid: analyzer.IsValid_2(),
      everySolidValid,
      solidCount: solids.length,
      shellCount: topologyCount(imported, 'shell'),
      faceCount: topologyCount(imported, 'face'),
      edgeCount: topologyCount(imported, 'edge'),
      vertexCount: topologyCount(imported, 'vertex'),
      volume: solidEvidence.length
        ? solidEvidence.reduce((total, solid) => total + solid.volume, 0)
        : null,
      bounds: clone(imported.boundingBox.bounds),
      faceOrientations,
      solids: solidEvidence,
    };
  } finally {
    safeDelete(analyzer);
    solids.forEach(safeDelete);
    safeDelete(imported);
  }
}

async function canonicalCleanSourceBrep(clean: StepFixture): Promise<string> {
  const imported = await rc.importSTEP(clean.blob);
  let sourceSolid: any = null;
  try {
    for (const raw of rc.iterTopo(imported.wrapped, 'solid')) {
      try {
        invariant(!sourceSolid, 'clean raw STEP contains more than one solid');
        sourceSolid = rc.cast(raw);
      } finally { safeDelete(raw); }
    }
    invariant(sourceSolid, 'clean raw STEP contains no solid');
    return importedTopologyRegistry.capture({
      shape: sourceSolid,
      registryId: 'resource-clean-source-evidence',
    }).sourceBrep;
  } finally {
    safeDelete(sourceSolid);
    safeDelete(imported);
  }
}

function assertRawPreconditions(raw: Record<string, RawStepEvidence>): void {
  const clean = raw.clean!;
  invariant(clean.rootValid && clean.everySolidValid, 'clean STEP is not valid before production import');
  invariant(
    clean.solidCount === 1 && clean.shellCount === 1 && clean.faceCount === 6
      && clean.edgeCount === 12 && clean.vertexCount === 8,
    `clean STEP topology is ${JSON.stringify(clean)}`,
  );
  invariant(close(Number(clean.volume), BOX_VOLUME, 1e-8), `clean STEP volume is ${clean.volume}`);
  assertBounds(clean.bounds, [BOX_MIN, BOX_MAX], 2e-6, 'clean raw STEP');

  const multi = raw.multi!;
  invariant(multi.rootValid && multi.everySolidValid,
    'two-solid STEP is not a valid exact compound before production import');
  invariant(
    multi.solidCount === 2 && multi.shellCount === 2 && multi.faceCount === 12
      && multi.edgeCount === 24 && multi.vertexCount === 16 && multi.solids.length === 2,
    `two-solid STEP topology is ${JSON.stringify(multi)}`,
  );
  invariant(close(Number(multi.volume), BOX_VOLUME * 2, 1e-8),
    `two-solid STEP volume is ${multi.volume}`);
  assertBounds(multi.bounds, [BOX_MIN, SECOND_BOX_MAX], 2e-6, 'two-solid raw STEP');
  assertBounds(multi.solids[0]!.bounds, [BOX_MIN, BOX_MAX], 2e-6, 'two-solid raw first body');
  assertBounds(multi.solids[1]!.bounds, [SECOND_BOX_MIN, SECOND_BOX_MAX], 2e-6,
    'two-solid raw second body');
  for (const [index, solid] of multi.solids.entries()) {
    invariant(solid.valid && close(solid.volume, BOX_VOLUME, 1e-8),
      `two-solid raw body ${index + 1} is not an independently valid ${BOX_VOLUME} mm³ solid`);
  }

  for (const id of ['detached', 'within', 'flipped', 'beyond']) {
    const current = raw[id]!;
    invariant(current.rootValid, `${id} raw compound is not a valid collection of exact faces`);
    invariant(
      current.solidCount === 0 && current.shellCount === 6 && current.faceCount === 6
        && current.edgeCount === 24 && current.vertexCount === 24,
      `${id} did not preserve six topologically disconnected faces: ${JSON.stringify(current)}`,
    );
  }
  assertBounds(raw.detached!.bounds, [BOX_MIN, BOX_MAX], 2e-6, 'detached raw STEP');
  assertBounds(
    raw.within!.bounds,
    [BOX_MIN, [BOX_MAX[0], BOX_MAX[1], BOX_MAX[2] + WITHIN_POLICY_GAP_MM]],
    2e-6,
    'within-policy raw STEP',
  );
  assertBounds(
    raw.beyond!.bounds,
    [BOX_MIN, [BOX_MAX[0], BOX_MAX[1], BOX_MAX[2] + BEYOND_POLICY_GAP_MM]],
    2e-6,
    'beyond-policy raw STEP',
  );
  const orientationChanges = raw.detached!.faceOrientations.filter(
    (orientation, index) => orientation !== raw.flipped!.faceOrientations[index],
  );
  invariant(
    orientationChanges.length === 1,
    `flipped fixture changed ${orientationChanges.length} face orientations instead of one`,
  );

  const missing = raw.missing!;
  invariant(missing.rootValid, 'missing-face fixture is not a valid collection of five faces');
  invariant(
    missing.solidCount === 0 && missing.shellCount === 5 && missing.faceCount === 5
      && missing.edgeCount === 20 && missing.vertexCount === 20,
    `missing-face raw topology is ${JSON.stringify(missing)}`,
  );

  const nonidentity = raw.nonidentity!;
  invariant(
    nonidentity.rootValid && nonidentity.solidCount === 0 && nonidentity.shellCount === 6
      && nonidentity.faceCount === 6 && nonidentity.edgeCount === 24 && nonidentity.vertexCount === 24,
    `nonidentity PartMode-manifest fixture lost its six disconnected exact faces: ${JSON.stringify(nonidentity)}`,
  );
  assertBounds(
    nonidentity.bounds,
    [[5, 0, 0], [25, 10, BOX_MAX[2] + WITHIN_POLICY_GAP_MM]],
    2e-6,
    'nonidentity PartMode-manifest raw STEP',
  );
}

async function importStep(
  kernel: HeadlessKernel,
  fixture: StepFixture,
  requestId: string,
  revision: number,
): Promise<JsonRecord> {
  const response = await kernel.request({
    kind: 'import-step-v5',
    requestId,
    projectId: `step-healing-smoke-${fixture.id}`,
    revision,
    blob: fixture.blob,
    filename: fixture.filename,
  }, 180_000);
  invariant(response.kind === 'import-result', `${fixture.id} returned ${String(response.kind)}`);
  invariant(response.project && typeof response.project === 'object', `${fixture.id} omitted imported project`);
  invariant(response.manifest && typeof response.manifest === 'object', `${fixture.id} omitted import manifest`);
  return response;
}

async function rejectedStepImport(
  kernel: HeadlessKernel,
  fixture: StepFixture,
  requestId: string,
  revision: number,
): Promise<string> {
  try {
    await importStep(kernel, fixture, requestId, revision);
  } catch (error: any) {
    const message = String(error?.message || error);
    invariant(
      /validating and healing exact STEP geometry:/i.test(message),
      `${fixture.id} failed outside the healing boundary: ${message}`,
    );
    return message;
  }
  throw new Error(`STEP import healing smoke failed: ${fixture.id} unexpectedly imported`);
}

function importedRecords(response: JsonRecord, label: string): ImportedBodyEvidence[] {
  const bodies = response.project.partDefinitions.flatMap((part: JsonRecord) => part.bodies);
  const features = response.project.partDefinitions.flatMap((part: JsonRecord) => part.features)
    .filter((feature: JsonRecord) => feature.type === 'imported-step');
  invariant(bodies.length > 0 && features.length === bodies.length,
    `${label}: imported project has ${bodies.length} bodies and ${features.length} imported-step features`);
  return features.map((feature: JsonRecord, index: number) => {
    const matchingBodies = bodies.filter((body: JsonRecord) => body.createdByFeatureId === feature.id);
    invariant(matchingBodies.length === 1,
      `${label}: imported feature ${feature.id} resolves ${matchingBodies.length} bodies`);
    const resources = response.project.resources.filter(
      (resource: JsonRecord) => resource.id === feature.extensions?.studioImportedStep?.resourceId,
    );
    invariant(resources.length === 1,
      `${label}: imported exact BREP resource for body ${index + 1} did not resolve exactly once`);
    const resource = resources[0]!;
    const resourceHealing = resource.extensions?.studioImportedStep?.healing;
    const featureHealing = feature.extensions?.studioImportedStep?.healing;
    invariant(resourceHealing?.schema === HEALING_SCHEMA,
      `${label}: resource healing schema for body ${index + 1} is missing`);
    invariant(
      JSON.stringify(resourceHealing) === JSON.stringify(featureHealing),
      `${label}: resource and feature healing evidence differ for body ${index + 1}`,
    );
    invariant(resource.encoding === 'base64' && typeof resource.data === 'string',
      `${label}: exact BREP for body ${index + 1} is not embedded base64`);
    const brep = Buffer.from(resource.data, 'base64').toString('utf8');
    invariant(Buffer.byteLength(brep) === resource.byteLength,
      `${label}: exact BREP byte length for body ${index + 1} is inconsistent`);
    const brepSha256 = createHash('sha256').update(brep).digest('hex');
    invariant(resourceHealing.healedBrepSha256 === brepSha256,
      `${label}: healed BREP digest does not bind embedded body ${index + 1}`);
    return {
      body: matchingBodies[0]!,
      feature,
      resource,
      healing: resourceHealing,
      brep,
      brepSha256,
    };
  });
}

function importedRecord(response: JsonRecord, label: string): ImportedBodyEvidence {
  const records = importedRecords(response, label);
  invariant(records.length === 1, `${label}: imported project has ${records.length} bodies instead of one`);
  return records[0]!;
}

async function assertImportEvidence(
  response: JsonRecord,
  fixture: StepFixture,
  expected: 'unchanged' | 'healed',
  expectedBodyCount = 1,
  expectedMaxToleranceMm = POLICY_MAX_TOLERANCE_MM,
): Promise<void> {
  const label = fixture.id;
  const summary = response.manifest.healing;
  invariant(summary?.schema === HEALING_SCHEMA, `${label}: manifest healing schema is missing`);
  invariant(response.manifest.exactGeometry === true && response.manifest.bodyCount === expectedBodyCount,
    `${label}: manifest does not declare ${expectedBodyCount} exact bodies`);
  const healed = expected === 'healed';
  invariant(
    summary.attempted === healed && summary.applied === healed && summary.status === expected,
    `${label}: healing summary is ${JSON.stringify(summary)}`,
  );
  invariant(
    summary.healedBodyCount === (healed ? expectedBodyCount : 0)
      && summary.unchangedBodyCount === (healed ? 0 : expectedBodyCount),
    `${label}: healed/unchanged body ledger is inconsistent`,
  );
  invariant(close(Number(summary.maxToleranceMm), expectedMaxToleranceMm, 1e-10),
    `${label}: max tolerance is ${summary.maxToleranceMm}, expected ${expectedMaxToleranceMm}`);
  if (healed) {
    invariant(
      Number(summary.selectedToleranceMm) >= 0.001
        && Number(summary.selectedToleranceMm) <= POLICY_MAX_TOLERANCE_MM + 1e-12,
      `${label}: selected tolerance ${summary.selectedToleranceMm} escaped policy`,
    );
  } else {
    invariant(Number(summary.selectedToleranceMm) === 0, `${label}: unchanged solid selected a healing tolerance`);
  }
  if (fixture.id === 'top-face-gap-0.02mm') {
    invariant(
      Number(summary.selectedToleranceMm) > WITHIN_POLICY_GAP_MM
        && Number(summary.selectedToleranceMm) <= POLICY_MAX_TOLERANCE_MM + 1e-12,
      `${label}: final tolerance ${summary.selectedToleranceMm} did not bound the 0.02 mm defect`,
    );
  }
  const records = importedRecords(response, label);
  invariant(records.length === expectedBodyCount,
    `${label}: project contains ${records.length} exact imported records instead of ${expectedBodyCount}`);
  const sourceSha256 = await sha256Blob(fixture.blob);
  for (const [index, record] of records.entries()) {
    invariant(record.healing.applied === healed && record.healing.status === expected,
      `${label}: persisted evidence for body ${index + 1} disagrees with manifest`);
    invariant(record.healing.sourceSha256 === sourceSha256,
      `${label}: persisted evidence for body ${index + 1} is not bound to source STEP bytes`);
  }
  invariant(
    JSON.stringify(response.project.metadata.stepHealing) === JSON.stringify(summary),
    `${label}: project metadata and import manifest summaries differ`,
  );
}

function assertTwoSolidEmbeddedEvidence(response: JsonRecord): JsonRecord[] {
  const label = 'two-separated-solid-boxes';
  const records = importedRecords(response, label);
  invariant(records.length === 2 && response.project.resources.length === 2,
    `${label}: expected exactly two body records and two embedded resources`);
  invariant(new Set(records.map((record) => record.body.id)).size === 2,
    `${label}: body identities are not independent`);
  invariant(new Set(records.map((record) => record.feature.id)).size === 2,
    `${label}: feature identities are not independent`);
  invariant(new Set(records.map((record) => record.resource.id)).size === 2,
    `${label}: resource identities are not independent`);
  invariant(new Set(records.map((record) => record.brepSha256)).size === 2,
    `${label}: separately placed exact body BREP digests unexpectedly collide`);

  const measured = records.map((record, index) => {
    let shape: any = null;
    let analyzer: any = null;
    try {
      shape = rc.deserializeShape(record.brep);
      analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
      const evidence = {
        bodyId: record.body.id,
        featureId: record.feature.id,
        resourceId: record.resource.id,
        brepSha256: record.brepSha256,
        brepValid: analyzer.IsValid_2(),
        solidCount: topologyCount(shape, 'solid'),
        shellCount: topologyCount(shape, 'shell'),
        faceCount: topologyCount(shape, 'face'),
        edgeCount: topologyCount(shape, 'edge'),
        vertexCount: topologyCount(shape, 'vertex'),
        volume: rc.measureVolume(shape),
        bounds: clone(shape.boundingBox.bounds),
        healing: record.healing,
      };
      invariant(
        evidence.brepValid && evidence.solidCount === 1 && evidence.shellCount === 1
          && evidence.faceCount === 6 && evidence.edgeCount === 12 && evidence.vertexCount === 8,
        `${label}: embedded body ${index + 1} is not independently one valid exact box solid`,
      );
      return evidence;
    } finally {
      safeDelete(analyzer);
      safeDelete(shape);
    }
  }).sort((left, right) => left.bounds[0]![0]! - right.bounds[0]![0]!);

  const expectedBounds = [
    [BOX_MIN, BOX_MAX],
    [SECOND_BOX_MIN, SECOND_BOX_MAX],
  ] as const;
  for (const [index, evidence] of measured.entries()) {
    const healing = evidence.healing;
    invariant(healing.status === 'unchanged' && healing.applied === false,
      `${label}: body ${index + 1} did not carry unchanged evidence`);
    invariant(JSON.stringify(healing.pre) === JSON.stringify(healing.post),
      `${label}: unchanged body ${index + 1} has different pre/post measurements`);
    const metrics = healing.post;
    invariant(
      metrics?.brepValid === true && metrics.solidCount === 1 && metrics.shellCount === 1
        && metrics.faceCount === 6 && metrics.edgeCount === 12 && metrics.vertexCount === 8
        && metrics.freeEdgeCount === 0 && metrics.multipleEdgeCount === 0,
      `${label}: persisted one-solid metrics for body ${index + 1} are incomplete`,
    );
    invariant(close(Number(evidence.volume), BOX_VOLUME, 1e-8)
      && close(Number(metrics.volumeMm3), evidence.volume, 1e-8),
    `${label}: body ${index + 1} independently measured/persisted volume differs`);
    assertBounds(evidence.bounds, expectedBounds[index]!, 2e-6,
      `${label} embedded body ${index + 1}`);
    assertBounds(metrics.boundsMm, expectedBounds[index]!, 2e-6,
      `${label} persisted body ${index + 1}`);
    invariant(
      close(Number(healing.drift?.maxBoundsDeltaMm), 0)
        && close(Number(healing.drift?.absoluteVolumeDeltaMm3), 0)
        && close(Number(healing.drift?.relativeVolumeDelta), 0),
      `${label}: unchanged body ${index + 1} reports geometric drift`,
    );
  }
  return measured.map((evidence) => ({
    bodyId: evidence.bodyId,
    resourceId: evidence.resourceId,
    brepSha256: evidence.brepSha256,
    volume: evidence.volume,
    bounds: evidence.bounds,
    solidCount: evidence.solidCount,
    brepValid: evidence.brepValid,
  }));
}

function saveReopen(project: JsonRecord, label: string): JsonRecord {
  const source = JSON.stringify(project);
  const prepared = prepareStudioV5Project(clone(project));
  invariant(JSON.stringify(project) === source, `${label}: schema preparation mutated imported project`);
  const saved = JSON.stringify(prepared);
  const reopened = parseStudioV5Project(saved);
  invariant(JSON.stringify(reopened) === saved, `${label}: canonical save/reopen changed JSON`);
  invariant(
    studioV5CanonicalHash(reopened) === studioV5CanonicalHash(parseStudioV5Project(JSON.stringify(reopened))),
    `${label}: canonical hash changed on second reopen`,
  );
  return reopened;
}

async function rebuildProject(
  kernel: HeadlessKernel,
  project: JsonRecord,
  requestId: string,
  revision: number,
): Promise<JsonRecord> {
  const result = await kernel.request({
    kind: 'rebuild',
    requestId,
    projectId: project.projectId,
    revision,
    document: project,
    includeExactBrep: true,
  }, 180_000);
  invariant(result.kind === 'rebuild-result', `${requestId}: rebuild returned ${String(result.kind)}`);
  invariant(Array.isArray(result.errors) && result.errors.length === 0,
    `${requestId}: rebuild errors ${JSON.stringify(result.errors || [])}`);
  invariant(Array.isArray(result.warnings) && result.warnings.length === 0,
    `${requestId}: rebuild warnings ${JSON.stringify(result.warnings || [])}`);
  return result;
}

function exactBody(result: JsonRecord, label: string): ExactBodyEvidence {
  invariant(Array.isArray(result.bodies) && result.bodies.length === 1,
    `${label}: rebuild returned ${result.bodies?.length ?? 0} bodies`);
  const body = result.bodies[0]!;
  invariant(!body.error && body.lastValid !== true, `${label}: body failed or used last-valid geometry`);
  invariant(
    body.geometry?.valid === true && body.geometry?.brepValid === true && body.geometry?.solidCount === 1,
    `${label}: body is not one valid exact BREP solid: ${JSON.stringify(body.geometry)}`,
  );
  invariant(typeof body.exactBrep === 'string' && body.exactBrep.length > 100,
    `${label}: canonical exact BREP evidence is missing`);
  const faceCount = Number(body.mesh?.topologyCounts?.faces ?? 0);
  const edgeCount = Number(body.mesh?.topologyCounts?.edges ?? 0);
  const vertexCount = Number(body.mesh?.topologyCounts?.vertices ?? 0);
  const faceNames = (body.mesh?.topologyFaces || [])
    .map((entry: JsonRecord) => entry.name).filter((name: unknown) => typeof name === 'string').sort();
  const edgeNames = (body.mesh?.edges || [])
    .map((entry: JsonRecord) => entry.name).filter((name: unknown) => typeof name === 'string').sort();
  const vertexNames = (body.mesh?.topologyVertices || [])
    .map((entry: JsonRecord) => entry.name).filter((name: unknown) => typeof name === 'string').sort();
  invariant(faceCount > 0 && faceNames.length === faceCount && new Set(faceNames).size === faceCount,
    `${label}: only ${faceNames.length}/${faceCount} faces have unique persistent names`);
  invariant(edgeCount > 0 && edgeNames.length === edgeCount && new Set(edgeNames).size === edgeCount,
    `${label}: only ${edgeNames.length}/${edgeCount} edges have unique persistent names`);
  invariant(vertexCount > 0 && vertexNames.length === vertexCount && new Set(vertexNames).size === vertexCount,
    `${label}: only ${vertexNames.length}/${vertexCount} vertices have unique persistent names`);
  return {
    bodyId: String(body.sourceBodyId || body.bodyId),
    exactBrep: body.exactBrep,
    geometry: clone(body.geometry),
    faceNames,
    edgeNames,
    vertexNames,
  };
}

function assertExpectedBody(
  evidence: ExactBodyEvidence,
  expectedVolume: number,
  expectedBounds: readonly [readonly number[], readonly number[]],
  boundsTolerance: number,
  label: string,
): void {
  invariant(close(Number(evidence.geometry.volume), expectedVolume, 2e-6),
    `${label}: volume is ${evidence.geometry.volume}, expected ${expectedVolume}`);
  assertBounds(evidence.geometry.bounds, expectedBounds, boundsTolerance, label);
}

function stableImport(response: JsonRecord): string {
  const project = clone(response.project);
  project.projectId = '<generated-project-id>';
  return JSON.stringify({ manifest: response.manifest, project });
}

function rootPartProjection(project: JsonRecord): { project: JsonRecord; part: JsonRecord; body: JsonRecord } {
  invariant(project.partDefinitions.length === 1, `healed project has ${project.partDefinitions.length} parts`);
  const candidate = clone(project);
  const part = candidate.partDefinitions[0]!;
  invariant(part.bodies.length === 1, `healed part has ${part.bodies.length} bodies`);
  candidate.rootDocument = { kind: 'part', partId: part.id };
  const prepared = prepareStudioV5Project(candidate);
  const preparedPart = prepared.partDefinitions.find((entry: JsonRecord) => entry.id === part.id)!;
  return { project: prepared, part: preparedPart, body: preparedPart.bodies[0]! };
}

function browserErrorListeners(page: Page): {
  pageErrors: string[];
  consoleErrors: string[];
  networkErrors: string[];
} {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error instanceof Error ? error.message : String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => networkErrors.push(
    `${request.method()} ${request.url()} ${request.failure()?.errorText || 'failed'}`,
  ));
  page.on('response', (response) => {
    if (response.status() >= 400) networkErrors.push(`${response.status()} ${response.url()}`);
  });
  return { pageErrors, consoleErrors, networkErrors };
}

async function visibleUploadAcceptance(
  within: StepFixture,
  beyond: StepFixture,
  temporaryDirectory: string,
): Promise<JsonRecord> {
  const withinPath = resolve(temporaryDirectory, within.filename);
  const beyondPath = resolve(temporaryDirectory, beyond.filename);
  writeFileSync(withinPath, new Uint8Array(await within.blob.arrayBuffer()));
  writeFileSync(beyondPath, new Uint8Array(await beyond.blob.arrayBuffer()));
  let server: RunningPartModeServer | undefined;
  let browser: Browser | undefined;
  try {
    server = await startPartModeServer({
      distDir: resolve(root, 'dist'),
      host: '127.0.0.1',
      port: 0,
      stateDir: resolve(temporaryDirectory, 'state'),
    });
    const health = await fetch(new URL('/healthz', server.url));
    invariant(health.ok, `visible server health returned HTTP ${health.status}`);
    browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 480_000,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    const browserErrors = browserErrorListeners(page);
    const response = await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    invariant(response?.status() === 200, `visible Studio returned HTTP ${response?.status() ?? 0}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    await page.waitForFunction(() => Boolean((window as any).__bwStudio), { timeout: 120_000 });
    await page.waitForFunction(() => {
      const studio = (window as any).__bwStudio;
      return studio?.documentRevision?.() === studio?.appliedRevision?.()
        && studio?.mode?.()?.kind !== 'rebuilding';
    }, { polling: 50, timeout: 180_000 });

    const input = await page.$('#bw-open-file') as ElementHandle<HTMLInputElement> | null;
    invariant(input, 'visible STEP file input is missing');
    await input.uploadFile(withinPath);
    await page.waitForFunction(() => {
      const studio = (window as any).__bwStudio;
      if (!studio || studio.documentRevision() !== studio.appliedRevision()) return false;
      try {
        const project = JSON.parse(studio.docJson());
        const bodies = studio.bodyResults();
        return project.metadata?.stepHealing?.schema === 'partmode.step-healing/v1'
          && project.metadata.stepHealing.applied === true
          && bodies.length === 1
          && bodies[0]?.geometry?.valid === true
          && bodies[0]?.geometry?.solidCount === 1;
      } catch {
        return false;
      }
    }, { polling: 50, timeout: 240_000 });
    const accepted = await page.evaluate(() => {
      const studio = (window as any).__bwStudio;
      return {
        document: studio.docJson(),
        hash: studio.canonicalHash(),
        revision: studio.documentRevision(),
        appliedRevision: studio.appliedRevision(),
        undoDepth: studio.undoDepth(),
        redoDepth: studio.redoDepth(),
        bodies: JSON.stringify(studio.bodyResults().map((entry: JsonRecord) => ({
          bodyId: entry.bodyId,
          sourceBodyId: entry.sourceBodyId,
          geometry: entry.geometry,
          topologyCounts: entry.mesh?.topologyCounts,
        }))),
        status: document.querySelector('#bw-studio-msg')?.textContent || '',
      };
    });
    invariant(
      /Healing:\s*1 healed within/i.test(accepted.status) && /0 unchanged/i.test(accepted.status),
      `visible success message omits healing summary: ${accepted.status}`,
    );

    const rejectedInput = await page.$('#bw-open-file') as ElementHandle<HTMLInputElement> | null;
    invariant(rejectedInput, 'visible STEP file input disappeared after successful import');
    await rejectedInput.uploadFile(beyondPath);
    await page.waitForFunction(() => {
      const message = document.querySelector('#bw-studio-msg')?.textContent || '';
      return /^Could not import STEP:/i.test(message) && /validating and healing exact STEP geometry:/i.test(message);
    }, { polling: 50, timeout: 240_000 });
    const afterRejected = await page.evaluate(() => {
      const studio = (window as any).__bwStudio;
      return {
        document: studio.docJson(),
        hash: studio.canonicalHash(),
        revision: studio.documentRevision(),
        appliedRevision: studio.appliedRevision(),
        undoDepth: studio.undoDepth(),
        redoDepth: studio.redoDepth(),
        bodies: JSON.stringify(studio.bodyResults().map((entry: JsonRecord) => ({
          bodyId: entry.bodyId,
          sourceBodyId: entry.sourceBodyId,
          geometry: entry.geometry,
          topologyCounts: entry.mesh?.topologyCounts,
        }))),
        status: document.querySelector('#bw-studio-msg')?.textContent || '',
      };
    });
    for (const key of ['document', 'hash', 'revision', 'appliedRevision', 'undoDepth', 'redoDepth', 'bodies'] as const) {
      invariant(afterRejected[key] === accepted[key], `rejected visible upload changed ${key}`);
    }
    invariant(/^Could not import STEP:/i.test(afterRejected.status), 'visible rejection did not explain STEP failure');
    invariant(browserErrors.pageErrors.length === 0,
      `visible upload page errors ${JSON.stringify(browserErrors.pageErrors)}`);
    invariant(browserErrors.consoleErrors.length === 0,
      `visible upload console errors ${JSON.stringify(browserErrors.consoleErrors)}`);
    invariant(browserErrors.networkErrors.length === 0,
      `visible upload network errors ${JSON.stringify(browserErrors.networkErrors)}`);
    return {
      acceptedMessage: accepted.status,
      rejectedMessage: afterRejected.status,
      revision: accepted.revision,
      bodyCount: JSON.parse(accepted.bodies).length,
      atomic: true,
    };
  } finally {
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
  }
}

const fixtures = generateFixtures();
fixtures.nonidentity = await nonidentityPartModeManifestFixture();
for (const fixture of Object.values(fixtures)) {
  const header = (await fixture.blob.text()).slice(0, 32);
  invariant(fixture.blob.size > 1000 && header.startsWith('ISO-10303-21'),
    `${fixture.id} is not a real STEP exchange payload`);
}
const rawEntries: Array<[string, RawStepEvidence]> = [];
// This precondition probe uses the main-thread OCCT instance directly. Keep
// its virtual filesystem operations sequential; concurrency is exercised
// below through the production worker's explicit STEP-reader serialization.
for (const [id, fixture] of Object.entries(fixtures)) {
  rawEntries.push([id, await inspectRawStep(fixture)]);
}
const rawEvidence = Object.fromEntries(rawEntries) as Record<string, RawStepEvidence>;
assertRawPreconditions(rawEvidence);
const cleanSourceBrep = await canonicalCleanSourceBrep(fixtures.clean!);

let firstKernel: HeadlessKernel | null = null;
let secondKernel: HeadlessKernel | null = null;
let cleanImport: JsonRecord;
let multiImport: JsonRecord;
let detachedImport: JsonRecord;
let withinImport: JsonRecord;
let flippedImport: JsonRecord;
let withinRepeat: JsonRecord;
let withinFresh: JsonRecord;
let concurrentCleanImport: JsonRecord;
let concurrentWithinImport: JsonRecord;
let beyondRejection: string;
let missingRejection: string;
let nonidentityRejection: string;
try {
  firstKernel = await createHeadlessKernel();
  await firstKernel.waitForKernel();
  cleanImport = await importStep(firstKernel, fixtures.clean!, 'step-healing-clean', 1);
  multiImport = await importStep(firstKernel, fixtures.multi!, 'step-healing-multi', 2);
  detachedImport = await importStep(firstKernel, fixtures.detached!, 'step-healing-detached', 3);
  withinImport = await importStep(firstKernel, fixtures.within!, 'step-healing-within', 4);
  flippedImport = await importStep(firstKernel, fixtures.flipped!, 'step-healing-flipped', 5);
  withinRepeat = await importStep(firstKernel, fixtures.within!, 'step-healing-within-repeat', 6);
  beyondRejection = await rejectedStepImport(firstKernel, fixtures.beyond!, 'step-healing-beyond', 7);
  missingRejection = await rejectedStepImport(firstKernel, fixtures.missing!, 'step-healing-missing', 8);
  nonidentityRejection = await rejectedStepImport(
    firstKernel,
    fixtures.nonidentity!,
    'step-healing-nonidentity-manifest',
    9,
  );
  invariant(/refuses transformed PartMode hierarchy geometry/i.test(nonidentityRejection),
    `nonidentity healed hierarchy refusal is not explicit: ${nonidentityRejection}`);
  const cleanAfterHealing = await importStep(firstKernel, fixtures.clean!, 'step-healing-clean-after', 10);
  invariant(stableImport(cleanAfterHealing) === stableImport(cleanImport),
    'healed/rejected imports leaked policy or kernel state into a later clean import');
  [concurrentCleanImport, concurrentWithinImport] = await Promise.all([
    importStep(firstKernel, fixtures.clean!, 'step-healing-concurrent-clean', 11),
    importStep(firstKernel, fixtures.within!, 'step-healing-concurrent-within', 12),
  ]);
  await firstKernel.dispose();
  firstKernel = null;

  secondKernel = await createHeadlessKernel();
  await secondKernel.waitForKernel();
  withinFresh = await importStep(secondKernel, fixtures.within!, 'step-healing-within-fresh', 1);
} finally {
  await firstKernel?.dispose().catch(() => {});
}

await assertImportEvidence(cleanImport!, fixtures.clean!, 'unchanged');
await assertImportEvidence(
  multiImport!,
  fixtures.multi!,
  'unchanged',
  2,
  MULTI_POLICY_MAX_TOLERANCE_MM,
);
await assertImportEvidence(detachedImport!, fixtures.detached!, 'healed');
await assertImportEvidence(withinImport!, fixtures.within!, 'healed');
await assertImportEvidence(flippedImport!, fixtures.flipped!, 'healed');
await assertImportEvidence(concurrentCleanImport!, fixtures.clean!, 'unchanged');
await assertImportEvidence(concurrentWithinImport!, fixtures.within!, 'healed');
const multiBodyEvidence = assertTwoSolidEmbeddedEvidence(multiImport!);
invariant(importedRecord(cleanImport!, 'clean unchanged').brep === cleanSourceBrep,
  'clean valid solid changed exact BREP bytes at the healing boundary');
invariant(stableImport(withinRepeat!) === stableImport(withinImport!),
  'repeated import on one worker changed project, evidence, topology registry, or canonical BREP');
invariant(stableImport(withinFresh!) === stableImport(withinImport!),
  'fresh-worker import changed project, evidence, topology registry, or canonical BREP');
invariant(stableImport(concurrentCleanImport!) === stableImport(cleanImport!),
  'concurrent clean import changed deterministic project, evidence, topology, or canonical BREP');
invariant(stableImport(concurrentWithinImport!) === stableImport(withinImport!),
  'concurrent healed import changed deterministic project, evidence, topology, or canonical BREP');

const exactByFixture: Record<string, ExactBodyEvidence> = {};
try {
  invariant(secondKernel, 'fresh production kernel is unavailable for rebuild evidence');
  const successful = [
    ['clean', cleanImport!, BOX_VOLUME, [BOX_MIN, BOX_MAX], 2e-6],
    ['detached', detachedImport!, BOX_VOLUME, [BOX_MIN, BOX_MAX], 2e-6],
    ['within', withinImport!, SHIFTED_VOLUME,
      [BOX_MIN, [BOX_MAX[0], BOX_MAX[1], BOX_MAX[2] + WITHIN_POLICY_GAP_MM]],
      POLICY_MAX_TOLERANCE_MM + 2e-6],
    ['flipped', flippedImport!, BOX_VOLUME, [BOX_MIN, BOX_MAX], 2e-6],
  ] as const;
  let revision = 10;
  for (const [id, imported, volume, bounds, boundsTolerance] of successful) {
    const projected = rootPartProjection(imported.project).project;
    const result = await rebuildProject(secondKernel, projected, `step-healing-rebuild-${id}`, revision++);
    const evidence = exactBody(result, id);
    assertExpectedBody(evidence, volume, bounds, boundsTolerance, id);
    exactByFixture[id] = evidence;
  }

  const reopenedWithin = saveReopen(withinImport!.project, 'healed STEP');
  const reopenedResult = await rebuildProject(
    secondKernel,
    rootPartProjection(reopenedWithin).project,
    'step-healing-rebuild-reopened',
    revision++,
  );
  const reopenedEvidence = exactBody(reopenedResult, 'healed save/reopen');
  invariant(reopenedEvidence.exactBrep === exactByFixture.within!.exactBrep,
    'healed save/reopen changed canonical exact BREP');
  sameStrings(reopenedEvidence.faceNames, exactByFixture.within!.faceNames, 'healed save/reopen face names');
  sameStrings(reopenedEvidence.edgeNames, exactByFixture.within!.edgeNames, 'healed save/reopen edge names');
  sameStrings(reopenedEvidence.vertexNames, exactByFixture.within!.vertexNames, 'healed save/reopen vertex names');

  const rootPart = rootPartProjection(reopenedWithin);
  const transformed = createStudioV5TransformFeature(rootPart.project, {
    id: 'feature-step-healing-downstream-transform',
    name: 'Move healed STEP body',
    bodyId: rootPart.body.id,
    mode: 'move',
    transform: { mode: 'move', translation: [...TRANSFORM_TRANSLATION] },
  });
  const transformedPart = transformed.partDefinitions.find(
    (part: JsonRecord) => part.id === transformed.rootDocument.partId,
  );
  const transformedBody = transformedPart?.bodies.find((body: JsonRecord) => body.id === rootPart.body.id);
  invariant(
    transformedPart?.features.at(-1)?.type === 'transform'
      && transformedBody?.featureIds.at(-1) === 'feature-step-healing-downstream-transform',
    'downstream transform did not enter healed body history',
  );
  const transformedResult = await rebuildProject(
    secondKernel,
    transformed,
    'step-healing-rebuild-transformed',
    revision++,
  );
  const transformedEvidence = exactBody(transformedResult, 'downstream healed transform');
  assertExpectedBody(
    transformedEvidence,
    SHIFTED_VOLUME,
    [
      TRANSFORM_TRANSLATION,
      [
        BOX_MAX[0] + TRANSFORM_TRANSLATION[0],
        BOX_MAX[1] + TRANSFORM_TRANSLATION[1],
        BOX_MAX[2] + WITHIN_POLICY_GAP_MM + TRANSFORM_TRANSLATION[2],
      ],
    ],
    POLICY_MAX_TOLERANCE_MM + 2e-6,
    'downstream healed transform',
  );
  invariant(transformedEvidence.exactBrep !== exactByFixture.within!.exactBrep,
    'downstream transform did not change exact BREP placement');
  sameStrings(transformedEvidence.faceNames, exactByFixture.within!.faceNames,
    'downstream transform face names');
  sameStrings(transformedEvidence.edgeNames, exactByFixture.within!.edgeNames,
    'downstream transform edge names');
  sameStrings(transformedEvidence.vertexNames, exactByFixture.within!.vertexNames,
    'downstream transform vertex names');
  const transformedReopened = saveReopen(transformed, 'downstream healed transform');
  const transformedReopenedResult = await rebuildProject(
    secondKernel,
    transformedReopened,
    'step-healing-rebuild-transformed-reopened',
    revision++,
  );
  invariant(
    exactBody(transformedReopenedResult, 'downstream transform save/reopen').exactBrep
      === transformedEvidence.exactBrep,
    'downstream transform save/reopen changed exact BREP',
  );
} finally {
  await secondKernel?.dispose().catch(() => {});
}

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-step-healing-'));
let visibleEvidence: JsonRecord;
try {
  visibleEvidence = await visibleUploadAcceptance(fixtures.within!, fixtures.beyond!, temporaryDirectory);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log(JSON.stringify({
  fixtures: Object.fromEntries(Object.entries(fixtures).map(([id, fixture]) => [id, {
    filename: fixture.filename,
    bytes: fixture.blob.size,
    raw: rawEvidence[id],
  }])),
  policy: {
    withinGapMm: WITHIN_POLICY_GAP_MM,
    beyondGapMm: BEYOND_POLICY_GAP_MM,
    maxToleranceMm: POLICY_MAX_TOLERANCE_MM,
    multiSolidMaxToleranceMm: MULTI_POLICY_MAX_TOLERANCE_MM,
  },
  imports: {
    clean: cleanImport!.manifest.healing,
    multi: multiImport!.manifest.healing,
    detached: detachedImport!.manifest.healing,
    within: withinImport!.manifest.healing,
    flipped: flippedImport!.manifest.healing,
    deterministicRepeated: true,
    deterministicFreshWorker: true,
    concurrentSameWorker: {
      fixtures: [fixtures.clean!.id, fixtures.within!.id],
      clean: concurrentCleanImport!.manifest.healing,
      within: concurrentWithinImport!.manifest.healing,
      deterministic: true,
    },
    rejected: {
      beyond: beyondRejection!,
      missing: missingRejection!,
      nonidentityPartModeManifest: nonidentityRejection!,
    },
  },
  exact: Object.fromEntries(Object.entries(exactByFixture).map(([id, evidence]) => [id, {
    volume: evidence.geometry.volume,
    bounds: evidence.geometry.bounds,
    faces: evidence.faceNames.length,
    edges: evidence.edgeNames.length,
    vertices: evidence.vertexNames.length,
    brepSha256: createHash('sha256').update(evidence.exactBrep).digest('hex'),
  }])),
  multiSolidEmbeddedBodies: multiBodyEvidence,
  saveReopen: true,
  downstreamTransform: { translation: TRANSFORM_TRANSLATION, exact: true },
  visible: visibleEvidence!,
}, null, 2));
