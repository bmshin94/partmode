// Focused acceptance gate for SM004 flat patterns in partmode.sheet-metal/v1.
//
// The gate authors a bend-table-driven sheet-metal enclosure (base flange,
// four edge flanges, four corner reliefs in both styles), derives the exact
// flat pattern as a read-only body, asserts the closed-form developed lengths
// and flat volume against independently computed values, rebuilds folded and
// flat bodies in the production worker, and exports the flat outline through
// the partmode.dxf/v1 sketch writer with an independent re-parse. Bend-line
// annotations, drawing flat-pattern views, and unfold/fold remain explicit
// exclusions.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Sheet-metal flat smoke failed: ${label}`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function closeTo(actual: number, expected: number, tolerance = 2e-4): boolean {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function messageOf(error: unknown): string {
  return String((error as Error | null)?.message || error || '');
}

function expectFailure(label: string, action: () => unknown, pattern?: RegExp): void {
  let failure: unknown = null;
  try { action(); } catch (error) { failure = error; }
  check(`${label} unexpectedly succeeded`, failure);
  if (pattern) check(`${label} returned the wrong refusal: ${messageOf(failure)}`, pattern.test(messageOf(failure)));
}

const near = (a: number, b: number, tolerance = 1.5e-6): boolean => Math.abs(a - b) <= tolerance;
const nearPoint = (a: number[], b: number[], tolerance = 1.5e-6): boolean =>
  near(a[0]!, b[0]!, tolerance) && near(a[1]!, b[1]!, tolerance);

const root = process.cwd();
const moduleAt = async (path: string) => import(pathToFileURL(resolve(root, path)).href) as Promise<any>;
const sheetMetal = await moduleAt('src/static/studio-sheet-metal.js');
const projectModule = await moduleAt('src/static/studio-project-v5.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const agent = await moduleAt('src/static/studio-agent-service.js');
const dxfTools = await moduleAt('src/static/studio-drawing-dxf.js');

function blankProject(projectId: string): JsonRecord {
  return runtime.createStudioV5RuntimePartProject({
  projectId,
    name: 'Flat pattern acceptance',
    units: 'mm',
    parameters: [],
    features: [],

}) as JsonRecord;
}

function rootPart(project: JsonRecord): JsonRecord {
  return runtime.studioV5RootPart(project) as JsonRecord;
}

function apply(project: JsonRecord, transactionId: string, operations: JsonRecord[]): JsonRecord {
  return agent.applyCadTransaction(project, {
    transactionId,
    label: transactionId,
    expectedRevision: 0,
    atomic: true,
    operations,
  }).project as JsonRecord;
}

function expectAtomicFailure(label: string, source: JsonRecord, operations: JsonRecord[], pattern?: RegExp): void {
  const before = JSON.stringify(source);
  expectFailure(label, () => apply(source, `reject-${label.replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`, operations), pattern);
  check(`${label} mutated its source document`, JSON.stringify(source) === before);
}

function canonicalReopen(project: JsonRecord, label: string): { saved: string; reopened: JsonRecord } {
  const saved = JSON.stringify(projectModule.prepareStudioV5Project(project));
  const reopened = projectModule.parseStudioV5Project(saved) as JsonRecord;
  check(`${label} changed canonical bytes across save/reopen`, JSON.stringify(reopened) === saved);
  return { saved, reopened };
}

// --- minimal independent DXF parser (this file only, not the writer) --------

interface DxfEntity {
  type: string;
  layer: string;
  groups: Array<[number, number]>;
}

function parseDxf(text: string): { comments: string[]; layers: string[]; entities: DxfEntity[]; extmin: number[]; extmax: number[] } {
  const lines = text.split('\n');
  check('flat DXF ends with one trailing newline', text.endsWith('\n') && lines[lines.length - 1] === '');
  const pairs: Array<[number, string]> = [];
  for (let index = 0; index < lines.length - 1; index += 2) {
    const code = Number(lines[index]);
    check(`flat DXF group code "${lines[index]}" is an integer`, Number.isInteger(code));
    pairs.push([code, lines[index + 1]!]);
  }
  const out = { comments: [] as string[], layers: [] as string[], entities: [] as DxfEntity[], extmin: [] as number[], extmax: [] as number[] };
  let section: string | null = null;
  let table: string | null = null;
  let headerVariable: string | null = null;
  let expectLayerName = false;
  let entity: DxfEntity | null = null;
  const flush = () => { if (entity) out.entities.push(entity); entity = null; };
  for (const [code, value] of pairs) {
    if (code === 999) { out.comments.push(value); continue; }
    if (code === 0 && value === 'SECTION') { section = null; continue; }
    if (code === 2 && section === null) { section = value; continue; }
    if (code === 0 && value === 'ENDSEC') { flush(); section = 'ended'; continue; }
    if (section === 'HEADER') {
      if (code === 9) { headerVariable = value; continue; }
      if (headerVariable === '$EXTMIN' && [10, 20].includes(code)) out.extmin.push(Number(value));
      if (headerVariable === '$EXTMAX' && [10, 20].includes(code)) out.extmax.push(Number(value));
      continue;
    }
    if (section === 'TABLES') {
      if (code === 0 && value === 'TABLE') { table = null; expectLayerName = false; continue; }
      if (code === 2 && table === null) { table = value; continue; }
      if (code === 0 && value === 'ENDTAB') { table = 'ended'; expectLayerName = false; continue; }
      if (table === 'LAYER' && code === 0 && value === 'LAYER') { expectLayerName = true; continue; }
      if (table === 'LAYER' && code === 2 && expectLayerName) { out.layers.push(value); expectLayerName = false; }
      continue;
    }
    if (section === 'ENTITIES') {
      if (code === 0) {
        flush();
        check(`flat DXF entity ${value} is inside the bounded vocabulary`, ['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE'].includes(value));
        entity = { type: value, layer: '', groups: [] };
        continue;
      }
      if (!entity) continue;
      if (code === 8) entity.layer = value;
      else entity.groups.push([code, Number(value)]);
    }
  }
  flush();
  return out;
}

function groupValue(entity: DxfEntity, code: number): number {
  const found = entity.groups.find(([entryCode]) => entryCode === code);
  check(`flat DXF entity ${entity.type} carries group ${code}`, found !== undefined);
  return Number(found![1]);
}

// ---------------------------------------------------------------------------
// Enclosure fixture: 120 x 80 base, bend table, four same-side edge flanges,
// four corner reliefs (two rectangular, two circular).
// ---------------------------------------------------------------------------

const thickness = 2;
const bendRadius = 2;
const tableFactor = 0.44;
const flangeLength = 25;
const width = 120;
const height = 80;
const reliefSize = bendRadius + thickness;
const bendAllowance = (bendRadius + tableFactor * thickness) * (Math.PI / 2);
const developedLength = bendAllowance + flangeLength;
const section = sheetMetal.studioSheetMetalEdgeSectionArea(bendRadius, thickness, flangeLength) as number;
const segmentLengths = [width, height, width, height];
const effectiveLengths = segmentLengths.map((length) => length - 2 * reliefSize);
const reliefStyles = ['rectangular', 'circular', 'rectangular', 'circular'];
const reliefAreaTotal = 2 * reliefSize * reliefSize + 2 * (Math.PI / 4) * reliefSize * reliefSize;

const foldedVolume = width * height * thickness
  - reliefAreaTotal * thickness
  + section * effectiveLengths.reduce((sum, value) => sum + value, 0);
const flatArea = width * height
  - reliefAreaTotal
  + developedLength * effectiveLengths.reduce((sum, value) => sum + value, 0);
const flatVolume = flatArea * thickness;

const setupOperations: JsonRecord[] = [
  {
    kind: 'datum.create',
    input: {
      id: 'datum-sheet-plane',
      name: 'Sheet plane',
      datumKind: 'plane',
      definition: { mode: 'principal', origin: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
    },
  },
  {
    kind: 'sketch.profile.create',
    input: {
      id: 'sketch-sheet-profile',
      name: 'Sheet profile',
      planeDatumId: 'datum-sheet-plane',
      curveKind: 'polyline',
      points: [[0, 0], [width, 0], [width, height], [0, height]],
    },
  },
  { kind: 'sheetMetal.bendTable.set', input: { rows: [{ thickness, bendRadius, kFactor: tableFactor }] } },
  {
    kind: 'sheetMetal.flange.create',
    input: {
      id: 'flange-base', name: 'Base flange', bodyName: 'Sheet body', kind: 'base-flange',
      profileSketchId: 'sketch-sheet-profile', thickness, bendRadius,
    },
  },
  ...reliefStyles.map((style, cornerIndex) => ({
    kind: 'sheetMetal.cornerRelief.create',
    input: { id: 'relief-' + cornerIndex, baseFeatureId: 'flange-base', cornerIndex, style },
  })),
  ...segmentLengths.map((_, segmentIndex) => ({
    kind: 'sheetMetal.flange.create',
    input: {
      id: 'flange-' + segmentIndex, kind: 'edge-flange', baseFeatureId: 'flange-base',
      segmentIndex, side: 'up', bendRadius, flangeLength,
    },
  })),
];

const docFolded = apply(blankProject('project-sheet-metal-flat'), 'author-enclosure', setupOperations);
check('enclosure did not persist one folded body with nine sheet-metal features',
  rootPart(docFolded).features.length === 9 && rootPart(docFolded).bodies.length === 1);
check('bend table did not drive every flange K-factor', rootPart(docFolded).features
  .filter((entry: JsonRecord) => entry.extensions?.sheetMetal?.kind === 'edge-flange')
  .every((entry: JsonRecord) => entry.extensions.sheetMetal.kFactor === tableFactor
    && entry.extensions.sheetMetal.bendAllowance === bendAllowance));

const docFlat = apply(docFolded, 'create-flat-pattern', [{
  kind: 'sheetMetal.flatPattern.create',
  input: { id: 'flat-pattern', name: 'Flat pattern', bodyName: 'Flat pattern', baseFeatureId: 'flange-base' },
}]);
const flatChecked = runtime.assertStudioSheetMetalDocument(docFlat, 'flat-pattern') as JsonRecord;
check('flat-pattern recipe drifted from its authored contract', flatChecked.recipe.kind === 'flat-pattern'
  && flatChecked.recipe.schema === 'partmode.sheet-metal/v1'
  && flatChecked.recipe.baseFeatureId === 'flange-base'
  && flatChecked.recipe.flangePolicy === 'derived-read-only-exact-flat-pattern'
  && flatChecked.recipe.complianceStatus === 'k-factor-neutral-axis-design-aid-not-manufacturing-certification');

// Closed-form developed lengths: every flange develops by exactly its stored
// bend allowance plus flange length over the relief-shortened segment.
check('flat plan lost a developed flange row', Array.isArray(flatChecked.plan.developed)
  && flatChecked.plan.developed.length === 4);
for (const row of flatChecked.plan.developed) {
  check(`developed length for segment ${row.segmentIndex} is not the exact closed form`,
    row.developedLength === developedLength
    && row.effectiveLength === segmentLengths[row.segmentIndex]! - 2 * reliefSize);
}
// The plan sums its exact per-feature terms in feature order; the independent
// closed form here associates differently, so the aggregate comparison uses a
// 1e-9 relative bound while every per-feature stored term stays bit-exact.
const aggregate = (actual: number, expected: number): boolean =>
  Math.abs(actual - expected) <= Math.abs(expected) * 1e-9;
check('flat plan area is not the exact closed form',
  flatChecked.plan.profileArea === width * height
  && aggregate(flatChecked.plan.reliefArea, reliefAreaTotal)
  && aggregate(flatChecked.plan.flatArea, flatArea)
  && flatChecked.plan.flatArea === flatChecked.plan.profileArea + flatChecked.plan.developedArea - flatChecked.plan.reliefArea);
check('flat body did not appear as one additional derived body',
  rootPart(docFlat).bodies.length === 2
  && rootPart(docFlat).bodies.some((body: JsonRecord) => body.createdByFeatureId === 'flat-pattern'));
const flatBodyId = rootPart(docFlat).bodies.find((body: JsonRecord) => body.createdByFeatureId === 'flat-pattern').id as string;
const { reopened: flatReopened } = canonicalReopen(docFlat, 'flat pattern');

// ---------------------------------------------------------------------------
// Read-only and lifecycle refusals.
// ---------------------------------------------------------------------------

expectAtomicFailure('duplicate flat pattern per base', flatReopened, [{
  kind: 'sheetMetal.flatPattern.create',
  input: { id: 'flat-duplicate', baseFeatureId: 'flange-base' },
}], /already carries flat pattern/u);
expectAtomicFailure('edge flange created after the flat pattern', flatReopened, [{
  kind: 'sheetMetal.flange.create',
  input: {
    id: 'flange-late', kind: 'edge-flange', baseFeatureId: 'flange-base',
    segmentIndex: 0, side: 'down', flangeLength: 5,
  },
}], /flat pattern must follow|already carries edge flange/u);
expectAtomicFailure('derived flat-pattern field edit', flatReopened, [{
  kind: 'sheetMetal.flange.update',
  input: { featureId: 'flat-pattern', patch: { thickness: 3 } },
}], /derived/u);
expectAtomicFailure('transform of the read-only flat body', flatReopened, [{
  kind: 'body.transform',
  input: { id: 'transform-flat', bodyId: flatBodyId, transform: { mode: 'move', translation: [10, 0, 0] } },
}], /derived and read-only/u);
expectAtomicFailure('generic feature.update bypass on the flat pattern', flatReopened, [{
  kind: 'feature.update',
  input: { featureId: 'flat-pattern', patch: { name: 'Bypassed' } },
}], /sheetMetal\.flange\.update/u);
const flatRenamed = apply(flatReopened, 'rename-flat-pattern', [{
  kind: 'sheetMetal.flange.update', input: { featureId: 'flat-pattern', patch: { name: 'Development' } },
}]);
check('flat-pattern rename was refused', rootPart(flatRenamed).features
  .find((entry: JsonRecord) => entry.id === 'flat-pattern').name === 'Development');

const flatSnapshot = JSON.stringify(flatReopened);
{
  const tampered = clone(flatReopened);
  // featureOrder is the history authority; the features array itself may be
  // stored in any permutation, so the tamper moves the order entry.
  const order = rootPart(tampered).featureOrder;
  const [flatId] = order.splice(order.indexOf('flat-pattern'), 1);
  order.splice(order.indexOf('flange-0'), 0, flatId);
  expectFailure('flat pattern reordered before its flanges',
    () => projectModule.prepareStudioV5Project(tampered), /flat pattern must follow/u);
  const detached = clone(flatReopened);
  rootPart(detached).features.find((entry: JsonRecord) => entry.id === 'flat-pattern')
    .extensions.sheetMetal.flangePolicy = 'certified';
  expectFailure('tampered flat-pattern policy',
    () => projectModule.prepareStudioV5Project(detached), /policy evidence/u);
  check('flat-pattern tampering mutated the authoritative source', JSON.stringify(flatReopened) === flatSnapshot);
}

const afterFlatDelete = apply(flatReopened, 'delete-flat-pattern', [{
  kind: 'sheetMetal.flange.delete', input: { featureId: 'flat-pattern' },
}]);
check('flat-pattern delete did not restore the folded-only document',
  rootPart(afterFlatDelete).features.length === 9 && rootPart(afterFlatDelete).bodies.length === 1);
const afterFlatBodyDelete = apply(flatReopened, 'delete-flat-body', [{
  kind: 'body.delete', input: { bodyId: flatBodyId },
}]);
check('flat body delete did not cascade only the flat-pattern feature',
  rootPart(afterFlatBodyDelete).features.length === 9 && rootPart(afterFlatBodyDelete).bodies.length === 1);

// An associative flange edit changes the derived flat plan without touching
// the stored flat recipe.
const docLonger = apply(flatReopened, 'edit-flange-length', [{
  kind: 'sheetMetal.flange.update', input: { featureId: 'flange-1', patch: { flangeLength: 30 } },
}]);
const longerChecked = runtime.assertStudioSheetMetalDocument(docLonger, 'flat-pattern') as JsonRecord;
const longerFlatArea = flatArea + 5 * effectiveLengths[1]!;
check('flange-length edit did not flow into the derived flat plan',
  aggregate(longerChecked.plan.flatArea, longerFlatArea)
  && JSON.stringify(longerChecked.recipe) === JSON.stringify(flatChecked.recipe));

// ---------------------------------------------------------------------------
// DXF export of the flat outline through the partmode.dxf/v1 sketch writer.
// ---------------------------------------------------------------------------

const flatExport = runtime.studioSheetMetalFlatPatternSketch(flatReopened, 'flat-pattern') as JsonRecord;
check('flat DXF export plan drifted from the validated document plan',
  JSON.stringify(flatExport.plan) === JSON.stringify(flatChecked.plan));
const flatDxf = dxfTools.createStudioSketchDxf(flatExport.sketch) as string;
check('flat DXF is not byte-deterministic',
  flatDxf === dxfTools.createStudioSketchDxf((runtime.studioSheetMetalFlatPatternSketch(flatReopened, 'flat-pattern') as JsonRecord).sketch));
const parsed = parseDxf(flatDxf);
check('flat DXF schema comment is wrong',
  parsed.comments[0] === 'partmode.dxf/v1 kind=sketch-profile units=mm splinePolicy=fail');
check('flat DXF layer set is wrong', parsed.layers.length === 1 && parsed.layers[0] === 'PM-SKETCH'
  && parsed.entities.every((entity) => entity.layer === 'PM-SKETCH'));
const dxfLines = parsed.entities.filter((entity) => entity.type === 'LINE');
const dxfArcs = parsed.entities.filter((entity) => entity.type === 'ARC');
check('flat DXF entity census is wrong (12 developed lines, 4 rectangular relief lines, 2 relief arcs)',
  dxfLines.length === 16 && dxfArcs.length === 2 && parsed.entities.length === 18);

// Every DXF line matches one plan chain line exactly, and every plan line is
// drawn exactly once.
const planLines = (flatChecked.plan.entities as JsonRecord[]).filter((entity) => entity.kind === 'line');
check('plan chain census disagrees with the DXF census',
  planLines.length === 16 && (flatChecked.plan.entities as JsonRecord[]).length === 18);
const unmatched = [...planLines];
for (const line of dxfLines) {
  const a = [groupValue(line, 10), groupValue(line, 20)];
  const b = [groupValue(line, 11), groupValue(line, 21)];
  const index = unmatched.findIndex((entity) =>
    (nearPoint(entity.a2, a) && nearPoint(entity.b2, b)) || (nearPoint(entity.a2, b) && nearPoint(entity.b2, a)));
  check(`flat DXF line ${JSON.stringify([a, b])} has no exact plan counterpart`, index >= 0);
  unmatched.splice(index, 1);
}
check('flat DXF omitted a plan outline line', unmatched.length === 0);
for (const arc of dxfArcs) {
  const center = [groupValue(arc, 10), groupValue(arc, 20)];
  check(`flat DXF arc at ${JSON.stringify(center)} drifted from its relieved corner`,
    near(groupValue(arc, 40), reliefSize)
    && (flatChecked.plan.entities as JsonRecord[]).some((entity) => entity.kind === 'arc' && nearPoint(entity.center2, center)));
}
check('flat DXF extents disagree with the developed outline',
  nearPoint(parsed.extmin, [-developedLength, -developedLength])
  && nearPoint(parsed.extmax, [width + developedLength, height + developedLength]));

// ---------------------------------------------------------------------------
// Source-ownership checks for the flat-dxf artifact surface.
// ---------------------------------------------------------------------------

const [studioSource, mcpSource, relaySource, agentSource, packageSource] = await Promise.all([
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/mcp.ts'), 'utf8'),
  readFile(resolve(root, 'src/relay-hub.ts'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  readFile(resolve(root, 'package.json'), 'utf8'),
]);
check('visible Studio omits the flat-dxf artifact handler', studioSource.includes("format === 'flat-dxf'")
  && studioSource.includes('studioSheetMetalFlatPatternSketch(doc, flatFeatureId)')
  && studioSource.includes("'flat-pattern-dxf'"));
check('MCP artifact surface omits flat-dxf', mcpSource.includes("'flat-dxf'")
  && mcpSource.includes('Only the flat-dxf artifact accepts "flatFeatureId".'));
check('relay permission map omits flat-dxf', relaySource.includes("'flat-dxf': 'artifact.export-drawing'"));
check('agent capability manifest omits flat-dxf', agentSource.includes("format: 'flat-dxf'"));
check('package scripts omit the flat gate', packageSource.includes('"smoke:sheet-metal-flat"'));

// ---------------------------------------------------------------------------
// Production-worker exact rebuilds: folded enclosure plus derived flat body.
// ---------------------------------------------------------------------------

interface BodyEvidence {
  body: JsonRecord;
  faces: string[];
  brepSha256: string;
}

function assertExactBody(result: JsonRecord, bodyId: string, expectedVolume: number, label: string): BodyEvidence {
  check(`${label} production rebuild errors: ${JSON.stringify(result.errors || [])}`,
    Array.isArray(result.errors) && result.errors.length === 0);
  check(`${label} production rebuild warnings: ${JSON.stringify(result.warnings || [])}`,
    Array.isArray(result.warnings) && result.warnings.length === 0);
  const body = (result.bodies || []).find((entry: JsonRecord) => entry.bodyId === bodyId);
  check(`${label} body ${bodyId} is missing from the rebuild`, body);
  check(`${label} published a failed or last-valid body`, !body.error && body.lastValid === false);
  check(`${label} is not one valid exact B-rep solid`, body.geometry?.valid === true
    && body.geometry?.brepValid === true
    && body.geometry?.solidCount === 1
    && body.geometry?.shellCount === 1
    && typeof body.exactBrep === 'string' && body.exactBrep.length > 100);
  check(`${label} exact volume ${body.geometry?.volume} differs from closed form ${expectedVolume}`,
    closeTo(Number(body.geometry?.volume), expectedVolume, Math.max(2e-4, expectedVolume * 1e-9)));
  const counts = body.mesh?.topologyCounts;
  const faces = (body.mesh?.topologyFaces || []).map((entry: JsonRecord) => String(entry.name || '')).sort();
  check(`${label} does not name every exact face`, counts?.namedFaces === counts?.faces
    && faces.length === counts?.faces && faces.every(Boolean) && new Set(faces).size === faces.length);
  check(`${label} does not name every exact edge and vertex`, counts?.namedEdges === counts?.edges
    && counts?.namedVertices === counts?.vertices);
  check(`${label} topology diagnostics are not empty: ${JSON.stringify(body.mesh?.topologyDiagnostics || [])}`,
    Array.isArray(body.mesh?.topologyDiagnostics) && body.mesh.topologyDiagnostics.length === 0);
  return { body, faces, brepSha256: sha256(body.exactBrep) };
}

async function workerRebuild(
  kernel: HeadlessKernel,
  project: JsonRecord,
  revision: number,
  label: string,
): Promise<JsonRecord> {
  return kernel.request({
    kind: 'rebuild',
    requestId: `sheet-metal-flat-${revision}-${label}`,
    projectId: project.projectId,
    revision,
    document: project,
    includeExactBrep: true,
  }, 240_000) as Promise<JsonRecord>;
}

const foldedBodyId = rootPart(docFlat).bodies.find((body: JsonRecord) => body.createdByFeatureId === 'flange-base').id as string;
let kernel: HeadlessKernel | null = null;
let freshKernel: HeadlessKernel | null = null;
let exactRebuilds = 0;

try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();

  const enclosureResult = await workerRebuild(kernel, flatReopened, 1, 'enclosure');
  check('enclosure rebuild did not publish exactly two exact bodies', enclosureResult.bodies?.length === 2);
  const foldedEvidence = assertExactBody(enclosureResult, foldedBodyId, foldedVolume, 'folded enclosure');
  const flatEvidence = assertExactBody(enclosureResult, flatBodyId, flatVolume, 'derived flat pattern');
  exactRebuilds += 2;
  check('flat body lost its developed outline face identity',
    flatEvidence.faces.includes('Fflat-pattern:side:flat:dev:0:tip')
    && flatEvidence.faces.includes('Fflat-pattern:side:flat:dev:2:return')
    && flatEvidence.faces.includes('Fflat-pattern:side:flat:relief:1:arc')
    && flatEvidence.faces.includes('Fflat-pattern:side:flat:relief:0:a')
    && flatEvidence.faces.includes('Fflat-pattern:cap:start')
    && flatEvidence.faces.includes('Fflat-pattern:cap:end'));
  check('folded enclosure lost its relieved flange topology',
    foldedEvidence.faces.includes('Fflange-0:side:bend-inner')
    && foldedEvidence.faces.includes('Fflange-3:side:flange-tip')
    && foldedEvidence.faces.includes('Frelief-0:side:relief-inner-a')
    && foldedEvidence.faces.includes('Frelief-1:side:relief-arc'));

  const longerResult = await workerRebuild(kernel, docLonger, 2, 'associative-flange-edit');
  const longerEvidence = assertExactBody(longerResult, flatBodyId, longerFlatArea * thickness, 'flat after flange edit');
  exactRebuilds += 1;
  check('associative flange edit did not change the exact flat B-rep while preserving identity',
    longerEvidence.body.exactBrep !== flatEvidence.body.exactBrep
    && JSON.stringify(longerEvidence.faces) === JSON.stringify(flatEvidence.faces));

  const workerTamper = clone(flatReopened);
  rootPart(workerTamper).features.find((entry: JsonRecord) => entry.id === 'flat-pattern')
    .extensions.sheetMetal.baseBodyId = 'body-else';
  let workerRefusal: unknown = null;
  try {
    const invalidResult = await workerRebuild(kernel, workerTamper, 3, 'tampered-flat');
    if (invalidResult.errors?.length) {
      workerRefusal = new Error(invalidResult.errors.map((error: JsonRecord) => error.message).join('; '));
    }
  } catch (error) {
    workerRefusal = error;
  }
  check(`production worker accepted a detached flat pattern: ${messageOf(workerRefusal)}`, workerRefusal
    && /detached|SHEET_METAL|INVALID/u.test(messageOf(workerRefusal)));

  await kernel.dispose();
  kernel = null;
  freshKernel = await createHeadlessKernel();
  await freshKernel.waitForKernel();
  const freshResult = await workerRebuild(freshKernel, flatReopened, 1, 'fresh-worker');
  const freshEvidence = assertExactBody(freshResult, flatBodyId, flatVolume, 'fresh-worker flat pattern');
  exactRebuilds += 1;
  check('fresh production worker changed deterministic exact flat evidence',
    freshEvidence.body.exactBrep === flatEvidence.body.exactBrep
    && freshEvidence.brepSha256 === flatEvidence.brepSha256
    && JSON.stringify(freshEvidence.faces) === JSON.stringify(flatEvidence.faces));

  console.log(JSON.stringify({
    schema: 'partmode.sheet-metal-flat-smoke/v1',
    contract: {
      schema: sheetMetal.STUDIO_SHEET_METAL_SCHEMA,
      kind: 'flat-pattern',
      policy: 'derived-read-only-exact-flat-pattern',
      dxf: 'partmode.dxf/v1 sketch writer, flat-dxf artifact surface',
    },
    closedForms: {
      developedLength: 'bendAllowance + flangeLength over relief-shortened segment extents',
      developedLengthMm: developedLength,
      flatAreaMm2: flatArea,
      flatVolumeMm3: flatVolume,
      foldedVolumeMm3: foldedVolume,
      reliefAreaMm2: reliefAreaTotal,
    },
    exactProductionRebuilds: exactRebuilds,
    dxfCensus: { lines: 16, arcs: 2, layer: 'PM-SKETCH', byteDeterministic: true },
    lifecycle: {
      canonicalSaveReopen: true,
      derivedReadOnlyBody: true,
      associativeFlangeEditFlowsIntoFlat: true,
      bodyDeleteCascades: true,
      freshWorkerDeterminism: true,
    },
    refusals: [
      'duplicate flat pattern', 'flange created after the flat pattern', 'derived field edits',
      'transform of the read-only flat body', 'generic update bypasses', 'reordered flat pattern',
      'tampered policy/base association',
    ],
    unsupported: [
      'bend-line annotations and flat-pattern drawing views', 'unfold/fold and convert-to-sheet-metal',
      'flat patterns of hems, jogs, tabs, or miter flanges', 'non-90-degree bends and corners',
      'export scaling, kerf, or nesting',
    ],
  }, null, 2));
} finally {
  await freshKernel?.dispose();
  await kernel?.dispose();
}
