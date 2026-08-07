import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Sheet-metal smoke failed: ${label}`);
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

const root = process.cwd();
const moduleAt = async (path: string) => import(pathToFileURL(resolve(root, path)).href) as Promise<any>;
const sheetMetal = await moduleAt('src/static/studio-sheet-metal.js');
const projectModule = await moduleAt('src/static/studio-project-v5.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const agent = await moduleAt('src/static/studio-agent-service.js');
const uiRegistry = await moduleAt('src/static/studio-v6-ui-registry.js');

function blankProject(projectId: string): JsonRecord {
  return runtime.createStudioV5RuntimePartProject({
  projectId,
    name: 'Sheet metal acceptance',
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

// ---------------------------------------------------------------------------
// Closed-form bend-allowance contract. Every value the module produces must
// equal an independently computed (R + K * t) * angle-in-radians result.
// ---------------------------------------------------------------------------

const allowanceCases: Array<[number, number, number, number]> = [
  [2, 0.44, 2, 90],
  [3, 0.3, 2.5, 90],
  [1.5, 0.5, 1, 45],
  [10, 0.33, 6, 30],
  [0.5, 0.01, 0.5, 120],
];
for (const [radius, factor, thickness, angle] of allowanceCases) {
  const independent = (radius + factor * thickness) * (angle * Math.PI / 180);
  const produced = sheetMetal.studioSheetMetalBendAllowance(radius, factor, thickness, angle) as number;
  check(
    `bend allowance (R=${radius}, K=${factor}, t=${thickness}, angle=${angle}) is not the exact closed form`,
    produced === independent && Number.isFinite(produced) && produced > 0,
  );
}
expectFailure('zero-radius bend allowance', () => sheetMetal.studioSheetMetalBendAllowance(0, 0.44, 2, 90), /finite positive/u);
expectFailure('zero-angle bend allowance', () => sheetMetal.studioSheetMetalBendAllowance(2, 0.44, 2, 0), /finite positive/u);
expectFailure('non-finite thickness bend allowance', () => sheetMetal.studioSheetMetalBendAllowance(2, 0.44, Number.NaN, 90), /finite positive/u);

const sectionCases: Array<[number, number, number]> = [[2, 2, 20], [3, 2, 15], [1, 0.5, 5]];
for (const [radius, thickness, wall] of sectionCases) {
  const independent = (Math.PI / 4) * ((radius + thickness) ** 2 - radius ** 2) + wall * thickness;
  check(
    `edge section area (R=${radius}, t=${thickness}, H=${wall}) is not the exact quarter annulus plus wall`,
    sheetMetal.studioSheetMetalEdgeSectionArea(radius, thickness, wall) === independent,
  );
}

check('sheet-metal schema identity drifted', sheetMetal.STUDIO_SHEET_METAL_SCHEMA === 'partmode.sheet-metal/v1'
  && sheetMetal.STUDIO_SHEET_METAL_FEATURE_TYPE === 'sheet-metal-flange'
  && JSON.stringify(sheetMetal.STUDIO_SHEET_METAL_KINDS) === JSON.stringify(['base-flange', 'edge-flange', 'corner-relief', 'flat-pattern'])
  && JSON.stringify(sheetMetal.STUDIO_SHEET_METAL_RELIEF_STYLES) === JSON.stringify(['rectangular', 'circular'])
  && sheetMetal.STUDIO_SHEET_METAL_BEND_ANGLE_DEGREES === 90);

// Closed-form corner relief sizing: reliefSize = bendRadius + thickness, with
// a full-square or exact quarter-disc removed base area.
for (const [radius, sheet] of [[2, 2], [3, 1.5], [0.5, 0.6]] as Array<[number, number]>) {
  check(`relief size (R=${radius}, t=${sheet}) is not the exact closed form`,
    sheetMetal.studioSheetMetalReliefSize(radius, sheet) === radius + sheet);
}
check('relief areas are not the exact square and quarter-disc closed forms',
  sheetMetal.studioSheetMetalReliefArea('rectangular', 4) === 16
  && sheetMetal.studioSheetMetalReliefArea('circular', 4) === (Math.PI / 4) * 16);
expectFailure('zero relief size', () => sheetMetal.studioSheetMetalReliefSize(0, 2), /finite positive/u);
expectFailure('unsupported relief style', () => sheetMetal.studioSheetMetalReliefArea('obround', 4), /rectangular or circular/u);

const sheetMetalControl = (uiRegistry.cadUiControlRegistry() as JsonRecord[])
  .find((entry) => entry.id === 'model.sheet-metal-flange') || null;
check('Sheet metal flange is not a typed available UI command', sheetMetalControl?.adapter === 'available'
  && sheetMetalControl.workspaceId === 'solid'
  && JSON.stringify(sheetMetalControl.operationKinds) === JSON.stringify(['sheetMetal.flange.create', 'sheetMetal.flange.update']));

// ---------------------------------------------------------------------------
// Typed authoring: base flange plus one up edge flange and one down flange.
// ---------------------------------------------------------------------------

const thickness = 2;
const kFactor = 0.44;
const baseBendRadius = 2;
const profilePoints = [[0, 0], [100, 0], [100, 60], [0, 60]];
const profileArea = 100 * 60;
const edgeLength = 60;
const flangeLength = 20;

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
      points: profilePoints,
    },
  },
  {
    kind: 'sheetMetal.flange.create',
    input: {
      id: 'flange-base',
      name: 'Base flange',
      bodyName: 'Sheet body',
      kind: 'base-flange',
      profileSketchId: 'sketch-sheet-profile',
      thickness,
      kFactor,
      bendRadius: baseBendRadius,
    },
  },
];

const empty = blankProject('project-sheet-metal');
const emptySnapshot = JSON.stringify(empty);
const docBase = apply(empty, 'create-sheet-metal-base', setupOperations);
check('typed base create mutated its input', JSON.stringify(empty) === emptySnapshot);
const basePart = rootPart(docBase);
check('base flange did not persist exactly one feature/body', basePart.features.length === 1 && basePart.bodies.length === 1);
const baseChecked = runtime.assertStudioSheetMetalDocument(docBase, 'flange-base') as JsonRecord;
check('base flange recipe drifted from its authored contract', baseChecked.recipe.kind === 'base-flange'
  && baseChecked.recipe.schema === 'partmode.sheet-metal/v1'
  && baseChecked.recipe.thickness === thickness
  && baseChecked.recipe.kFactor === kFactor
  && baseChecked.recipe.bendRadius === baseBendRadius
  && baseChecked.recipe.flangePolicy === 'single-closed-profile-flat-sheet'
  && baseChecked.recipe.complianceStatus === 'k-factor-neutral-axis-design-aid-not-manufacturing-certification'
  && baseChecked.profileArea === profileArea);
const { reopened: baseReopened } = canonicalReopen(docBase, 'base flange');
check('base flange save/reopen changed evidence', JSON.stringify(
  runtime.assertStudioSheetMetalDocument(baseReopened, 'flange-base'),
) === JSON.stringify(baseChecked));

const expectedEdgeNames = {
  edgeName: sheetMetal.studioSheetMetalBendEdgeName('flange-base', 1, 'up'),
  sheetFaceName: sheetMetal.studioSheetMetalCapFaceName('flange-base', 'up'),
  attachmentFaceName: sheetMetal.studioSheetMetalSideFaceName('flange-base', 1),
};
check('deterministic persistent-name derivation drifted',
  expectedEdgeNames.sheetFaceName === 'Fflange-base:cap:end'
  && expectedEdgeNames.attachmentFaceName === 'Fflange-base:side:sheet-profile:segment:1'
  && expectedEdgeNames.edgeName === 'E(Fflange-base:cap:end|Fflange-base:side:sheet-profile:segment:1)');

const docEdge = apply(baseReopened, 'create-sheet-metal-edge', [{
  kind: 'sheetMetal.flange.create',
  input: {
    id: 'flange-edge-right',
    name: 'Right edge flange',
    kind: 'edge-flange',
    baseFeatureId: 'flange-base',
    segmentIndex: 1,
    side: 'up',
    bendRadius: baseBendRadius,
    kFactor,
    flangeLength,
  },
}]);
const edgeChecked = runtime.assertStudioSheetMetalDocument(docEdge, 'flange-edge-right') as JsonRecord;
const expectedAllowance = (baseBendRadius + kFactor * thickness) * (Math.PI / 2);
check('edge flange recipe drifted from its authored contract', edgeChecked.recipe.kind === 'edge-flange'
  && edgeChecked.recipe.bendAngleDegrees === 90
  && edgeChecked.recipe.segmentIndex === 1
  && edgeChecked.recipe.side === 'up'
  && edgeChecked.recipe.bendRadius === baseBendRadius
  && edgeChecked.recipe.kFactor === kFactor
  && edgeChecked.recipe.flangeLength === flangeLength
  && edgeChecked.recipe.flangePolicy === 'single-full-edge-90-degree-bend'
  && edgeChecked.recipe.edgeName === expectedEdgeNames.edgeName
  && edgeChecked.recipe.sheetFaceName === expectedEdgeNames.sheetFaceName
  && edgeChecked.recipe.attachmentFaceName === expectedEdgeNames.attachmentFaceName);
check('stored bend allowance is not the exact closed form', edgeChecked.recipe.bendAllowance === expectedAllowance
  && edgeChecked.bendAllowance === expectedAllowance);
const { reopened: edgeReopened } = canonicalReopen(docEdge, 'edge flange');
const edgeSnapshot = JSON.stringify(edgeReopened);

const docTwo = apply(edgeReopened, 'create-sheet-metal-down-edge', [{
  kind: 'sheetMetal.flange.create',
  input: {
    id: 'flange-edge-left',
    name: 'Left edge flange',
    kind: 'edge-flange',
    baseFeatureId: 'flange-base',
    segmentIndex: 3,
    side: 'down',
    bendRadius: 3,
    kFactor: 0.3,
    flangeLength: 15,
  },
}]);
const downChecked = runtime.assertStudioSheetMetalDocument(docTwo, 'flange-edge-left') as JsonRecord;
check('down-side flange did not store its own exact closed-form allowance',
  downChecked.recipe.bendAllowance === (3 + 0.3 * thickness) * (Math.PI / 2));
canonicalReopen(docTwo, 'two flanges');

// ---------------------------------------------------------------------------
// Typed refusals and fail-closed tampering.
// ---------------------------------------------------------------------------

expectAtomicFailure('unsupported miter-flange kind', edgeReopened, [{
  kind: 'sheetMetal.flange.create',
  input: { id: 'flange-miter', kind: 'miter-flange', baseFeatureId: 'flange-base', segmentIndex: 0, side: 'up', flangeLength: 10 },
}]);
expectAtomicFailure('zero-thickness base flange', edgeReopened, [{
  kind: 'sheetMetal.flange.create',
  input: { id: 'flange-zero', kind: 'base-flange', profileSketchId: 'sketch-sheet-profile', thickness: 0, kFactor, bendRadius: 2 },
}]);
expectAtomicFailure('out-of-range K-factor', edgeReopened, [{
  kind: 'sheetMetal.flange.create',
  input: { id: 'flange-k', kind: 'base-flange', profileSketchId: 'sketch-sheet-profile', thickness: 2, kFactor: 1.5, bendRadius: 2 },
}]);
expectAtomicFailure('duplicate edge flange on one persistent edge', edgeReopened, [{
  kind: 'sheetMetal.flange.create',
  input: {
    id: 'flange-duplicate', kind: 'edge-flange', baseFeatureId: 'flange-base',
    segmentIndex: 1, side: 'up', flangeLength: 5,
  },
}], /already carries edge flange/u);
expectAtomicFailure('segment outside the base profile', edgeReopened, [{
  kind: 'sheetMetal.flange.create',
  input: {
    id: 'flange-outside', kind: 'edge-flange', baseFeatureId: 'flange-base',
    segmentIndex: 9, side: 'up', flangeLength: 5,
  },
}], /outside the base profile/u);
expectAtomicFailure('edge flange chained onto an edge flange', edgeReopened, [{
  kind: 'sheetMetal.flange.create',
  input: {
    id: 'flange-chained', kind: 'edge-flange', baseFeatureId: 'flange-edge-right',
    segmentIndex: 0, side: 'up', flangeLength: 5,
  },
}], /existing base flange/u);
expectAtomicFailure('open path sketch as base profile', edgeReopened, [
  { kind: 'sketch.path.create', input: { id: 'path-open', name: 'Open path', curveKind: 'polyline', points: [[0, 0, 0], [10, 0, 0]] } },
  { kind: 'sheetMetal.flange.create', input: { id: 'flange-open', kind: 'base-flange', profileSketchId: 'path-open', thickness: 2, kFactor, bendRadius: 2 } },
], /datum plane|closed polyline/u);
expectAtomicFailure('generic feature.update bypass', edgeReopened, [{
  kind: 'feature.update',
  input: { featureId: 'flange-edge-right', patch: { name: 'Bypassed flange' } },
}], /sheetMetal\.flange\.update/u);
expectAtomicFailure('generic advanced-feature bypass', edgeReopened, [{
  kind: 'feature.advanced.update',
  input: { featureId: 'flange-edge-right', patch: { name: 'Bypassed flange' } },
}], /advanced shape feature no longer exists/u);
expectAtomicFailure('immutable side patch', edgeReopened, [{
  kind: 'sheetMetal.flange.update',
  input: { featureId: 'flange-edge-right', patch: { side: 'down' } },
}]);
expectAtomicFailure('base flange delete before its edge flanges', edgeReopened, [{
  kind: 'sheetMetal.flange.delete',
  input: { featureId: 'flange-base' },
}], /Delete those dependent sheet-metal features first/u);

function expectTamperRefusal(label: string, mutate: (project: JsonRecord) => void, pattern: RegExp): void {
  const tampered = clone(edgeReopened);
  mutate(tampered);
  expectFailure(label, () => projectModule.prepareStudioV5Project(tampered), pattern);
  check(`${label} mutated the authoritative source`, JSON.stringify(edgeReopened) === edgeSnapshot);
}

expectTamperRefusal('tampered bend allowance', (project) => {
  rootPart(project).features[1].extensions.sheetMetal.bendAllowance += 0.001;
}, /closed-form/u);
expectTamperRefusal('tampered base thickness without recomputation', (project) => {
  rootPart(project).features[0].extensions.sheetMetal.thickness = 3;
}, /closed-form/u);
expectTamperRefusal('tampered persistent edge name', (project) => {
  rootPart(project).features[1].extensions.sheetMetal.edgeName = 'E(Fother|Fother)';
}, /persistent topology names|tampered/u);
expectTamperRefusal('tampered segment index', (project) => {
  rootPart(project).features[1].extensions.sheetMetal.segmentIndex = 2;
}, /persistent topology names|tampered/u);
expectTamperRefusal('detached edge-flange inputs', (project) => {
  rootPart(project).features[1].inputRefs = rootPart(project).features[1].inputRefs.slice(0, 1);
}, /inputs are detached/u);
expectTamperRefusal('tampered bend angle', (project) => {
  const recipe = rootPart(project).features[1].extensions.sheetMetal;
  recipe.bendAngleDegrees = 60;
}, /90-degree bend/u);
expectTamperRefusal('tampered compliance wording', (project) => {
  rootPart(project).features[0].extensions.sheetMetal.complianceStatus = 'certified';
}, /compliance evidence/u);

// ---------------------------------------------------------------------------
// Typed edits and deletion lifecycles.
// ---------------------------------------------------------------------------

const docFlangeEdited = apply(edgeReopened, 'edit-flange-length', [{
  kind: 'sheetMetal.flange.update',
  input: { featureId: 'flange-edge-right', patch: { flangeLength: 30 } },
}]);
const flangeEditedChecked = runtime.assertStudioSheetMetalDocument(docFlangeEdited, 'flange-edge-right') as JsonRecord;
check('flange-length edit lost its allowance or names', flangeEditedChecked.recipe.flangeLength === 30
  && flangeEditedChecked.recipe.bendAllowance === expectedAllowance
  && flangeEditedChecked.recipe.edgeName === expectedEdgeNames.edgeName);

const docThicker = apply(edgeReopened, 'edit-base-thickness', [{
  kind: 'sheetMetal.flange.update',
  input: { featureId: 'flange-base', patch: { thickness: 2.5 } },
}]);
const thickerBase = runtime.assertStudioSheetMetalDocument(docThicker, 'flange-base') as JsonRecord;
const thickerEdge = runtime.assertStudioSheetMetalDocument(docThicker, 'flange-edge-right') as JsonRecord;
const thickerAllowance = (baseBendRadius + kFactor * 2.5) * (Math.PI / 2);
check('base thickness edit did not recompute the dependent exact allowance', thickerBase.recipe.thickness === 2.5
  && thickerEdge.recipe.bendAllowance === thickerAllowance
  && thickerEdge.recipe.bendAllowance !== expectedAllowance);

const docProfileEdited = apply(edgeReopened, 'edit-profile-associatively', [{
  kind: 'sketch.advanced.update',
  input: { sketchId: 'sketch-sheet-profile', patch: { kind: 'polyline', points: [[0, 0], [120, 0], [120, 60], [0, 60]] } },
}]);
runtime.assertStudioSheetMetalDocument(docProfileEdited, 'flange-edge-right');

const afterEdgeDelete = apply(edgeReopened, 'delete-edge-flange', [{
  kind: 'sheetMetal.flange.delete', input: { featureId: 'flange-edge-right' },
}]);
check('edge-flange delete did not restore the bare base', rootPart(afterEdgeDelete).features.length === 1
  && rootPart(afterEdgeDelete).bodies.length === 1);
const afterBaseDelete = apply(afterEdgeDelete, 'delete-base-flange', [{
  kind: 'sheetMetal.flange.delete', input: { featureId: 'flange-base' },
}]);
check('base-flange delete left features or bodies behind', rootPart(afterBaseDelete).features.length === 0
  && rootPart(afterBaseDelete).bodies.length === 0
  && rootPart(afterBaseDelete).sketches.some((entry: JsonRecord) => entry.id === 'sketch-sheet-profile'));
const bodyId = rootPart(edgeReopened).bodies[0].id as string;
const afterBodyDelete = apply(edgeReopened, 'delete-sheet-body', [{
  kind: 'body.delete', input: { bodyId },
}]);
check('body.delete did not cascade the sheet-metal history', rootPart(afterBodyDelete).features.length === 0
  && rootPart(afterBodyDelete).bodies.length === 0);
const genericDelete = apply(edgeReopened, 'generic-feature-delete-edge', [{
  kind: 'feature.delete', input: { featureId: 'flange-edge-right' },
}]);
check('generic feature.delete did not route through the typed sheet-metal delete',
  rootPart(genericDelete).features.length === 1);

// ---------------------------------------------------------------------------
// SM002: corner relief at a shared perpendicular base corner. The relief is
// spliced before every edge flange of its base so the flange sweeps resolve
// the shortened current edges, and both flanges of a shared corner refuse to
// coexist without it.
// ---------------------------------------------------------------------------

const reliefSize = baseBendRadius + thickness;
const reliefOperations = (style: string): JsonRecord[] => [
  { kind: 'sheetMetal.cornerRelief.create', input: { id: 'relief-corner-2', baseFeatureId: 'flange-base', cornerIndex: 2, style } },
  {
    kind: 'sheetMetal.flange.create',
    input: {
      id: 'flange-edge-top', name: 'Top edge flange', kind: 'edge-flange', baseFeatureId: 'flange-base',
      segmentIndex: 2, side: 'up', bendRadius: baseBendRadius, kFactor, flangeLength,
    },
  },
];
const docReliefRect = apply(edgeReopened, 'create-corner-relief-rect', reliefOperations('rectangular'));
check('corner relief was not spliced before every edge flange of its base',
  JSON.stringify(rootPart(docReliefRect).features.map((entry: JsonRecord) => entry.id))
  === JSON.stringify(['flange-base', 'relief-corner-2', 'flange-edge-right', 'flange-edge-top']));
const reliefChecked = runtime.assertStudioSheetMetalDocument(docReliefRect, 'relief-corner-2') as JsonRecord;
check('corner-relief recipe drifted from its authored contract', reliefChecked.recipe.kind === 'corner-relief'
  && reliefChecked.recipe.cornerIndex === 2
  && reliefChecked.recipe.style === 'rectangular'
  && reliefChecked.recipe.reliefSize === reliefSize
  && reliefChecked.recipe.flangePolicy === 'single-90-degree-shared-corner-base-cutout'
  && reliefChecked.corner.reliefArea === reliefSize * reliefSize
  && JSON.stringify(reliefChecked.corner.point) === JSON.stringify([100, 60]));
const rightRelieved = runtime.assertStudioSheetMetalDocument(docReliefRect, 'flange-edge-right') as JsonRecord;
check('relieved edge flange did not report its exact shortened extent',
  rightRelieved.effectiveLength === edgeLength - reliefSize);
const { reopened: reliefReopened } = canonicalReopen(docReliefRect, 'corner relief');
const docReliefCircular = apply(edgeReopened, 'create-corner-relief-circular', reliefOperations('circular'));
check('circular corner relief lost its exact quarter-disc area',
  (runtime.assertStudioSheetMetalDocument(docReliefCircular, 'relief-corner-2') as JsonRecord)
    .corner.reliefArea === (Math.PI / 4) * reliefSize * reliefSize);
canonicalReopen(docReliefCircular, 'circular corner relief');

expectAtomicFailure('adjacent edge flanges without a corner relief', edgeReopened, [{
  kind: 'sheetMetal.flange.create',
  input: {
    id: 'flange-unrelieved', kind: 'edge-flange', baseFeatureId: 'flange-base',
    segmentIndex: 2, side: 'up', flangeLength: 5,
  },
}], /require a corner relief/u);
expectAtomicFailure('duplicate corner relief on one base corner', reliefReopened, [{
  kind: 'sheetMetal.cornerRelief.create',
  input: { id: 'relief-duplicate', baseFeatureId: 'flange-base', cornerIndex: 2, style: 'circular' },
}], /already carries corner relief/u);
expectAtomicFailure('corner relief outside the base profile', reliefReopened, [{
  kind: 'sheetMetal.cornerRelief.create',
  input: { id: 'relief-outside', baseFeatureId: 'flange-base', cornerIndex: 9, style: 'rectangular' },
}], /outside the base profile/u);
expectAtomicFailure('corner relief deletion under an adjacent flange pair', reliefReopened, [{
  kind: 'sheetMetal.flange.delete', input: { featureId: 'relief-corner-2' },
}], /require a corner relief/u);
expectAtomicFailure('derived corner-relief field edit', reliefReopened, [{
  kind: 'sheetMetal.flange.update', input: { featureId: 'relief-corner-2', patch: { flangeLength: 10 } },
}], /derived/u);
expectAtomicFailure('non-perpendicular corner relief', edgeReopened, [
  { kind: 'sketch.profile.create', input: { id: 'sketch-skewed', name: 'Skewed profile', planeDatumId: 'datum-sheet-plane', curveKind: 'polyline', points: [[200, 0], [300, 0], [250, 60]] } },
  { kind: 'sheetMetal.flange.create', input: { id: 'flange-skewed', kind: 'base-flange', profileSketchId: 'sketch-skewed', thickness: 2, kFactor, bendRadius: 2 } },
  { kind: 'sheetMetal.cornerRelief.create', input: { id: 'relief-skewed', baseFeatureId: 'flange-skewed', cornerIndex: 1, style: 'rectangular' } },
], /perpendicular base corner/u);
const reliefSnapshot = JSON.stringify(reliefReopened);

function expectReliefTamperRefusal(label: string, mutate: (project: JsonRecord) => void, pattern: RegExp): void {
  const tampered = clone(reliefReopened);
  mutate(tampered);
  expectFailure(label, () => projectModule.prepareStudioV5Project(tampered), pattern);
  check(`${label} mutated the authoritative source`, JSON.stringify(reliefReopened) === reliefSnapshot);
}
expectReliefTamperRefusal('tampered relief size', (project) => {
  rootPart(project).features[1].extensions.sheetMetal.reliefSize += 0.5;
}, /closed-form/u);
expectReliefTamperRefusal('relief reordered after its edge flanges', (project) => {
  // featureOrder is the history authority; the features array itself may be
  // stored in any permutation, so the tamper moves the order entry and keeps
  // the owning body's featureIds consistent with the reordered history.
  const part = rootPart(project);
  const movedId = part.features[1].id;
  const order = part.featureOrder;
  order.push(order.splice(order.indexOf(movedId), 1)[0]);
  for (const body of part.bodies) {
    const index = body.featureIds.indexOf(movedId);
    if (index >= 0) body.featureIds.push(body.featureIds.splice(index, 1)[0]);
  }
}, /follow every corner relief|precede every edge flange/u);

// A base thickness edit recomputes the dependent exact relief size and every
// dependent bend allowance in the same associative pass.
const docReliefThicker = apply(reliefReopened, 'edit-relieved-base-thickness', [{
  kind: 'sheetMetal.flange.update', input: { featureId: 'flange-base', patch: { thickness: 2.5 } },
}]);
check('base thickness edit did not recompute the dependent exact relief size',
  (runtime.assertStudioSheetMetalDocument(docReliefThicker, 'relief-corner-2') as JsonRecord)
    .recipe.reliefSize === baseBendRadius + 2.5
  && (runtime.assertStudioSheetMetalDocument(docReliefThicker, 'flange-edge-top') as JsonRecord)
    .recipe.bendAllowance === (baseBendRadius + kFactor * 2.5) * (Math.PI / 2));

// ---------------------------------------------------------------------------
// SM003: per-part bend table. With a stored table the table is the only
// K-factor source: exact (thickness, bendRadius) lookup, refusal of literal
// K-factors, associative re-resolution on edits, and fail-closed missing
// rows.
// ---------------------------------------------------------------------------

const bendTableRows = [
  { thickness: 2.5, bendRadius: 2, kFactor: 0.46 },
  { thickness: 2, bendRadius: 3, kFactor: 0.41 },
  { thickness: 2, bendRadius: 2, kFactor: 0.44 },
];
const docTable = apply(edgeReopened, 'set-bend-table', [{
  kind: 'sheetMetal.bendTable.set', input: { rows: bendTableRows },
}]);
const storedTable = rootPart(docTable).extensions.sheetMetalBendTable;
check('bend table was not stored canonically sorted', storedTable.schema === 'partmode.sheet-metal/v1'
  && storedTable.kind === 'bend-table'
  && JSON.stringify(storedTable.rows) === JSON.stringify([
    { thickness: 2, bendRadius: 2, kFactor: 0.44 },
    { thickness: 2, bendRadius: 3, kFactor: 0.41 },
    { thickness: 2.5, bendRadius: 2, kFactor: 0.46 },
  ]));
canonicalReopen(docTable, 'bend table');
const docTableEdge = apply(docTable, 'create-table-driven-edge', [{
  kind: 'sheetMetal.flange.create',
  input: {
    id: 'flange-edge-table', kind: 'edge-flange', baseFeatureId: 'flange-base',
    segmentIndex: 3, side: 'down', bendRadius: 3, flangeLength: 15,
  },
}]);
const tableEdgeChecked = runtime.assertStudioSheetMetalDocument(docTableEdge, 'flange-edge-table') as JsonRecord;
check('table-driven edge flange did not resolve its exact bend-table row',
  tableEdgeChecked.recipe.kFactor === 0.41
  && tableEdgeChecked.recipe.bendAllowance === (3 + 0.41 * thickness) * (Math.PI / 2));
expectAtomicFailure('bend-table lookup for a missing row', docTable, [{
  kind: 'sheetMetal.flange.create',
  input: {
    id: 'flange-edge-missing', kind: 'edge-flange', baseFeatureId: 'flange-base',
    segmentIndex: 3, side: 'down', bendRadius: 5, flangeLength: 15,
  },
}], /no exact row/u);
expectAtomicFailure('literal K-factor under a stored bend table', docTable, [{
  kind: 'sheetMetal.flange.create',
  input: {
    id: 'flange-edge-literal', kind: 'edge-flange', baseFeatureId: 'flange-base',
    segmentIndex: 3, side: 'down', bendRadius: 3, kFactor: 0.5, flangeLength: 15,
  },
}], /resolved from the stored bend table/u);
expectAtomicFailure('literal K-factor patch under a stored bend table', docTable, [{
  kind: 'sheetMetal.flange.update', input: { featureId: 'flange-edge-right', patch: { kFactor: 0.5 } },
}], /resolved from the stored bend table/u);
expectAtomicFailure('bend-table set with a row missing for an existing flange', edgeReopened, [{
  kind: 'sheetMetal.bendTable.set', input: { rows: [{ thickness: 3, bendRadius: 2, kFactor: 0.4 }] },
}], /no exact row/u);
expectAtomicFailure('duplicate bend-table pair', edgeReopened, [{
  kind: 'sheetMetal.bendTable.set',
  input: { rows: [{ thickness: 2, bendRadius: 2, kFactor: 0.44 }, { thickness: 2, bendRadius: 2, kFactor: 0.5 }] },
}], /strictly sorted/u);

// A thickness edit re-resolves every dependent flange through the table and
// fails closed when the new pair has no row.
const docTableThicker = apply(docTable, 'edit-table-thickness', [{
  kind: 'sheetMetal.flange.update', input: { featureId: 'flange-base', patch: { thickness: 2.5 } },
}]);
const tableThickerBase = runtime.assertStudioSheetMetalDocument(docTableThicker, 'flange-base') as JsonRecord;
const tableThickerEdge = runtime.assertStudioSheetMetalDocument(docTableThicker, 'flange-edge-right') as JsonRecord;
check('thickness edit did not re-resolve exact bend-table K-factors',
  tableThickerBase.recipe.kFactor === 0.46
  && tableThickerEdge.recipe.kFactor === 0.46
  && tableThickerEdge.recipe.bendAllowance === (baseBendRadius + 0.46 * 2.5) * (Math.PI / 2));
expectAtomicFailure('thickness edit onto a missing bend-table row', docTable, [{
  kind: 'sheetMetal.flange.update', input: { featureId: 'flange-base', patch: { thickness: 3 } },
}], /no exact row/u);

const tableSnapshot = JSON.stringify(docTable);
{
  const tampered = clone(docTable);
  rootPart(tampered).features[1].extensions.sheetMetal.kFactor = 0.5;
  expectFailure('tampered K-factor under a stored bend table',
    () => projectModule.prepareStudioV5Project(tampered), /bend-table row/u);
  const unsorted = clone(docTable);
  rootPart(unsorted).extensions.sheetMetalBendTable.rows.reverse();
  expectFailure('tampered unsorted bend table',
    () => projectModule.prepareStudioV5Project(unsorted), /strictly sorted/u);
  check('bend-table tampering mutated the authoritative source', JSON.stringify(docTable) === tableSnapshot);
}

// Removing the table freezes the resolved values as ordinary literals.
const docTableRemoved = apply(docTableEdge, 'delete-bend-table', [{ kind: 'sheetMetal.bendTable.delete', input: {} }]);
check('bend-table removal did not freeze resolved literals',
  rootPart(docTableRemoved).extensions?.sheetMetalBendTable === undefined
  && (runtime.assertStudioSheetMetalDocument(docTableRemoved, 'flange-edge-table') as JsonRecord).recipe.kFactor === 0.41);
runtime.assertStudioSheetMetalDocument(
  apply(docTableRemoved, 'literal-after-table-removal', [{
    kind: 'sheetMetal.flange.update', input: { featureId: 'flange-edge-table', patch: { kFactor: 0.5 } },
  }]),
  'flange-edge-table',
);
expectAtomicFailure('bend-table delete without a stored table', edgeReopened, [{
  kind: 'sheetMetal.bendTable.delete', input: {},
}], /no stored bend table/u);

// ---------------------------------------------------------------------------
// Source-ownership checks.
// ---------------------------------------------------------------------------

const [moduleSource, runtimeSource, projectSource, workerSource, agentSource, studioSource, pageSource, registrySource, buildSource] = await Promise.all([
  readFile(resolve(root, 'src/static/studio-sheet-metal.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v5-runtime-document.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-project-v5.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
  readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
]);
check('source-owned sheet-metal module is not an acyclic leaf', !/^\s*import\s/mu.test(moduleSource));
check('runtime omits typed sheet-metal lifecycle commands', runtimeSource.includes('export function createStudioSheetMetalFeature')
  && runtimeSource.includes('export function updateStudioSheetMetalFeature')
  && runtimeSource.includes('export function deleteStudioSheetMetalFeature'));
check('persisted project boundary omits sheet-metal binding validation', projectSource.includes("from './studio-sheet-metal.js'")
  && projectSource.includes('assertStudioSheetMetalPart('));
check('production worker omits sheet-metal binding validation', workerSource.includes("from '/static/studio-sheet-metal.js'")
  && workerSource.includes("'SHEET_METAL_EVIDENCE_INVALID'"));
check('agent protocol omits typed sheet-metal operations or bypass guards', agentSource.includes("'sheetMetal.flange.create'")
  && agentSource.includes('deleteStudioSheetMetalFeature(')
  && agentSource.includes('Sheet-metal flanges must be edited through sheetMetal.flange.update.'));
check('runtime omits the typed bend-table or flat-pattern lifecycle', runtimeSource.includes('export function setStudioSheetMetalBendTable')
  && runtimeSource.includes('export function deleteStudioSheetMetalBendTable')
  && runtimeSource.includes('export function studioSheetMetalFlatPatternSketch'));
check('agent protocol omits the SM002/SM003/SM004 typed operations', agentSource.includes("'sheetMetal.cornerRelief.create'")
  && agentSource.includes("'sheetMetal.flatPattern.create'")
  && agentSource.includes("'sheetMetal.bendTable.set'")
  && agentSource.includes("'sheetMetal.bendTable.delete'"));
check('visible Studio does not load and route Sheet metal', studioSource.includes("import('/static/studio-sheet-metal.js')")
  && studioSource.includes("return 'model.sheet-metal-flange'")
  && studioSource.includes("kind: 'sheetMetal.flange.create'"));
check('visible Sheet metal ribbon/dialog is missing', pageSource.includes('id="bw-sheet-metal-open"')
  && pageSource.includes('id="bw-sheet-metal-form"')
  && pageSource.includes('id="bw-sheet-metal-kind"'));
check('Sheet metal is absent from the UI denominator', registrySource.includes("control('model.sheet-metal-flange'"));
check('release asset allowlist omits the sheet-metal module', buildSource.includes("'studio-sheet-metal.js'"));

// ---------------------------------------------------------------------------
// Production-worker exact rebuilds.
// ---------------------------------------------------------------------------

interface ExactBodyEvidence {
  result: JsonRecord;
  body: JsonRecord;
  brepSha256: string;
  faces: string[];
  edges: string[];
  vertices: string[];
}

function sortedNames(entries: JsonRecord[] | undefined): string[] {
  return (entries || []).map((entry) => String(entry.name || '')).sort();
}

function assertExactSheetBody(
  result: JsonRecord,
  project: JsonRecord,
  revision: number,
  expectedVolume: number,
  expectedFaces: number,
  label: string,
): ExactBodyEvidence {
  check(`${label} expected rebuild-result, received ${result.kind}`, result.kind === 'rebuild-result');
  check(`${label} returned stale revision ${String(result.revision)}`, result.revision === revision);
  const expectedHash = runtime.studioV5CanonicalHash(project);
  check(`${label} returned stale document hash`, result.effectiveDocumentHash === expectedHash && /^[0-9a-f]{64}$/u.test(expectedHash));
  check(`${label} production rebuild errors: ${JSON.stringify(result.errors || [])}`, Array.isArray(result.errors) && result.errors.length === 0);
  check(`${label} production rebuild warnings: ${JSON.stringify(result.warnings || [])}`, Array.isArray(result.warnings) && result.warnings.length === 0);
  check(`${label} expected one rebuilt body, received ${result.bodies?.length ?? 0}`, result.bodies?.length === 1);
  const body = result.bodies[0] as JsonRecord;
  check(`${label} published a failed or last-valid body`, !body.error && body.lastValid === false);
  check(`${label} is not one valid exact B-rep solid`, body.geometry?.valid === true
    && body.geometry?.brepValid === true
    && body.geometry?.solidCount === 1
    && body.geometry?.shellCount === 1);
  check(`${label} canonical B-rep evidence is missing`, typeof body.exactBrep === 'string' && body.exactBrep.length > 100);
  check(`${label} exact volume ${body.geometry?.volume} differs from closed form ${expectedVolume}`,
    closeTo(Number(body.geometry?.volume), expectedVolume, Math.max(2e-4, expectedVolume * 1e-9)));
  const counts = body.mesh?.topologyCounts;
  const faces = sortedNames(body.mesh?.topologyFaces);
  const edges = sortedNames(body.mesh?.edges);
  const vertices = sortedNames(body.mesh?.topologyVertices);
  check(`${label} face count ${counts?.faces} differs from expected ${expectedFaces}`,
    body.geometry?.faceCount === expectedFaces && counts?.faces === expectedFaces);
  check(`${label} does not name every exact face`, counts?.namedFaces === counts?.faces
    && faces.length === counts?.faces && faces.every(Boolean) && new Set(faces).size === faces.length);
  check(`${label} does not name every exact edge`, counts?.namedEdges === counts?.edges
    && edges.length === counts?.edges && edges.every(Boolean) && new Set(edges).size === edges.length);
  check(`${label} does not name every exact vertex`, counts?.namedVertices === counts?.vertices
    && vertices.length === counts?.vertices && vertices.every(Boolean) && new Set(vertices).size === vertices.length);
  check(`${label} topology diagnostics are not empty: ${JSON.stringify(body.mesh?.topologyDiagnostics || [])}`,
    Array.isArray(body.mesh?.topologyDiagnostics) && body.mesh.topologyDiagnostics.length === 0);
  return { result, body, brepSha256: sha256(body.exactBrep), faces, edges, vertices };
}

async function workerRebuild(
  kernel: HeadlessKernel,
  project: JsonRecord,
  revision: number,
  label: string,
): Promise<JsonRecord> {
  return kernel.request({
    kind: 'rebuild',
    requestId: `sheet-metal-${revision}-${label}`,
    projectId: project.projectId,
    revision,
    document: project,
    includeExactBrep: true,
  }, 180_000) as Promise<JsonRecord>;
}

const baseVolume = profileArea * thickness;
const edgeIncrement = sheetMetal.studioSheetMetalEdgeSectionArea(baseBendRadius, thickness, flangeLength) * edgeLength;
const downIncrement = sheetMetal.studioSheetMetalEdgeSectionArea(3, thickness, 15) * edgeLength;

let kernel: HeadlessKernel | null = null;
let freshKernel: HeadlessKernel | null = null;
let revision = 0;
let exactRebuilds = 0;

try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();

  revision += 1;
  const baseResult = await workerRebuild(kernel, baseReopened, revision, 'base');
  const baseEvidence = assertExactSheetBody(baseResult, baseReopened, revision, baseVolume, 6, 'base flange');
  exactRebuilds += 1;
  check('base flange lost its deterministic persistent side/cap names',
    baseEvidence.faces.includes('Fflange-base:cap:start')
    && baseEvidence.faces.includes('Fflange-base:cap:end')
    && baseEvidence.faces.includes('Fflange-base:side:sheet-profile:segment:1')
    && baseEvidence.edges.includes(expectedEdgeNames.edgeName));

  revision += 1;
  const edgeResult = await workerRebuild(kernel, edgeReopened, revision, 'edge-up');
  const edgeEvidence = assertExactSheetBody(
    edgeResult, edgeReopened, revision, baseVolume + edgeIncrement, 10, 'edge flange up',
  );
  exactRebuilds += 1;
  check('edge flange lost its bend or wall topology identity',
    edgeEvidence.faces.includes('Fflange-edge-right:side:bend-inner')
    && edgeEvidence.faces.includes('Fflange-edge-right:side:bend-outer')
    && edgeEvidence.faces.includes('Fflange-edge-right:side:wall-inner')
    && edgeEvidence.faces.includes('Fflange-edge-right:side:wall-outer')
    && edgeEvidence.faces.includes('Fflange-edge-right:side:flange-tip')
    && !edgeEvidence.faces.includes('Fflange-base:side:sheet-profile:segment:1'));

  revision += 1;
  const twoResult = await workerRebuild(kernel, docTwo, revision, 'edge-both-sides');
  assertExactSheetBody(
    twoResult, docTwo, revision, baseVolume + edgeIncrement + downIncrement, 14, 'edge flanges both sides',
  );
  exactRebuilds += 1;

  revision += 1;
  const profileEditVolume = 120 * 60 * thickness + edgeIncrement;
  const profileResult = await workerRebuild(kernel, docProfileEdited, revision, 'associative-profile-edit');
  const profileEvidence = assertExactSheetBody(
    profileResult, docProfileEdited, revision, profileEditVolume, 10, 'associative profile edit',
  );
  exactRebuilds += 1;
  check('associative profile edit did not preserve persistent topology identity',
    profileEvidence.body.exactBrep !== edgeEvidence.body.exactBrep
    && JSON.stringify(profileEvidence.faces) === JSON.stringify(edgeEvidence.faces)
    && JSON.stringify(profileEvidence.edges) === JSON.stringify(edgeEvidence.edges)
    && JSON.stringify(profileEvidence.vertices) === JSON.stringify(edgeEvidence.vertices));

  revision += 1;
  const flangeEditVolume = baseVolume
    + sheetMetal.studioSheetMetalEdgeSectionArea(baseBendRadius, thickness, 30) * edgeLength;
  const flangeEditResult = await workerRebuild(kernel, docFlangeEdited, revision, 'flange-length-edit');
  const flangeEditEvidence = assertExactSheetBody(
    flangeEditResult, docFlangeEdited, revision, flangeEditVolume, 10, 'flange length edit',
  );
  exactRebuilds += 1;
  check('flange-length edit did not preserve persistent topology identity',
    JSON.stringify(flangeEditEvidence.faces) === JSON.stringify(edgeEvidence.faces));

  revision += 1;
  const thickerVolume = profileArea * 2.5
    + sheetMetal.studioSheetMetalEdgeSectionArea(baseBendRadius, 2.5, flangeLength) * edgeLength;
  const thickerResult = await workerRebuild(kernel, docThicker, revision, 'thickness-edit');
  assertExactSheetBody(thickerResult, docThicker, revision, thickerVolume, 10, 'base thickness edit');
  exactRebuilds += 1;

  revision += 1;
  const flangeSection = sheetMetal.studioSheetMetalEdgeSectionArea(baseBendRadius, thickness, flangeLength) as number;
  const topEdgeLength = 100;
  const reliefRectVolume = baseVolume - reliefSize * reliefSize * thickness
    + flangeSection * (edgeLength - reliefSize)
    + flangeSection * (topEdgeLength - reliefSize);
  const reliefRectResult = await workerRebuild(kernel, reliefReopened, revision, 'corner-relief-rect');
  const reliefRectEvidence = assertExactSheetBody(
    reliefRectResult, reliefReopened, revision, reliefRectVolume, 16, 'rectangular corner relief',
  );
  exactRebuilds += 1;
  check('rectangular corner relief lost its named cutout walls',
    reliefRectEvidence.faces.includes('Frelief-corner-2:side:relief-inner-a')
    && reliefRectEvidence.faces.includes('Frelief-corner-2:side:relief-inner-b'));

  revision += 1;
  const reliefCircularVolume = baseVolume - (Math.PI / 4) * reliefSize * reliefSize * thickness
    + flangeSection * (edgeLength - reliefSize)
    + flangeSection * (topEdgeLength - reliefSize);
  const reliefCircularResult = await workerRebuild(kernel, docReliefCircular, revision, 'corner-relief-circular');
  const reliefCircularEvidence = assertExactSheetBody(
    reliefCircularResult, docReliefCircular, revision, reliefCircularVolume, 17, 'circular corner relief',
  );
  exactRebuilds += 1;
  check('circular corner relief lost its named quarter-arc wall',
    reliefCircularEvidence.faces.includes('Frelief-corner-2:side:relief-arc'));

  revision += 1;
  const tableEdgeResult = await workerRebuild(kernel, docTableEdge, revision, 'bend-table-driven');
  assertExactSheetBody(
    tableEdgeResult, docTableEdge, revision, baseVolume + edgeIncrement + downIncrement, 14, 'bend-table-driven flanges',
  );
  exactRebuilds += 1;

  const reliefWorkerTamper = clone(reliefReopened);
  rootPart(reliefWorkerTamper).features[1].extensions.sheetMetal.reliefSize += 0.001;
  let reliefRefusal: unknown = null;
  try {
    revision += 1;
    const invalidRelief = await workerRebuild(kernel, reliefWorkerTamper, revision, 'tampered-relief-size');
    if (invalidRelief.errors?.length && invalidRelief.bodies?.every((body: JsonRecord) => !body.geometry && !body.exactBrep)) {
      reliefRefusal = new Error(invalidRelief.errors.map((error: JsonRecord) => error.message).join('; '));
    }
  } catch (error) {
    reliefRefusal = error;
  }
  check(`production worker accepted a tampered relief size: ${messageOf(reliefRefusal)}`, reliefRefusal
    && /closed-form|SHEET_METAL/u.test(messageOf(reliefRefusal)));

  const tableWorkerTamper = clone(docTable);
  rootPart(tableWorkerTamper).features[1].extensions.sheetMetal.kFactor = 0.5;
  let tableRefusal: unknown = null;
  try {
    revision += 1;
    const invalidTable = await workerRebuild(kernel, tableWorkerTamper, revision, 'tampered-table-factor');
    if (invalidTable.errors?.length && invalidTable.bodies?.every((body: JsonRecord) => !body.geometry && !body.exactBrep)) {
      tableRefusal = new Error(invalidTable.errors.map((error: JsonRecord) => error.message).join('; '));
    }
  } catch (error) {
    tableRefusal = error;
  }
  check(`production worker accepted a K-factor off the stored bend table: ${messageOf(tableRefusal)}`, tableRefusal
    && /bend-table|SHEET_METAL/u.test(messageOf(tableRefusal)));

  const workerTamper = clone(edgeReopened);
  rootPart(workerTamper).features[1].extensions.sheetMetal.bendAllowance += 0.001;
  let workerRefusal: unknown = null;
  try {
    revision += 1;
    const invalidResult = await workerRebuild(kernel, workerTamper, revision, 'tampered-allowance');
    if (invalidResult.errors?.length && invalidResult.bodies?.every((body: JsonRecord) => !body.geometry && !body.exactBrep)) {
      workerRefusal = new Error(invalidResult.errors.map((error: JsonRecord) => error.message).join('; '));
    }
  } catch (error) {
    workerRefusal = error;
  }
  check(`production worker accepted a tampered bend allowance: ${messageOf(workerRefusal)}`, workerRefusal
    && /closed-form|SHEET_METAL/u.test(messageOf(workerRefusal)));

  await kernel.dispose();
  kernel = null;
  freshKernel = await createHeadlessKernel();
  await freshKernel.waitForKernel();
  const freshResult = await workerRebuild(freshKernel, edgeReopened, 1, 'fresh-worker');
  const freshEvidence = assertExactSheetBody(
    freshResult, edgeReopened, 1, baseVolume + edgeIncrement, 10, 'fresh worker',
  );
  exactRebuilds += 1;
  check('fresh production worker changed deterministic exact evidence',
    freshEvidence.body.exactBrep === edgeEvidence.body.exactBrep
    && JSON.stringify(freshEvidence.body.geometry) === JSON.stringify(edgeEvidence.body.geometry)
    && JSON.stringify(freshEvidence.faces) === JSON.stringify(edgeEvidence.faces)
    && JSON.stringify(freshEvidence.edges) === JSON.stringify(edgeEvidence.edges)
    && JSON.stringify(freshEvidence.vertices) === JSON.stringify(edgeEvidence.vertices));

  console.log(JSON.stringify({
    schema: 'partmode.sheet-metal-smoke/v1',
    contract: {
      schema: sheetMetal.STUDIO_SHEET_METAL_SCHEMA,
      featureType: sheetMetal.STUDIO_SHEET_METAL_FEATURE_TYPE,
      kinds: sheetMetal.STUDIO_SHEET_METAL_KINDS,
      bendAngleDegrees: sheetMetal.STUDIO_SHEET_METAL_BEND_ANGLE_DEGREES,
    },
    bendAllowance: {
      closedForm: '(bendRadius + kFactor * thickness) * angleRadians',
      assertedCases: allowanceCases.length,
      storedRecipeValuesExactlyEqualClosedForm: true,
      associativeThicknessRecomputation: true,
    },
    exactProductionRebuilds: exactRebuilds,
    volumesMm3: {
      base: baseVolume,
      baseWithUpFlange: baseVolume + edgeIncrement,
      baseWithBothFlanges: baseVolume + edgeIncrement + downIncrement,
      profileEdited: profileEditVolume,
      flangeLengthEdited: flangeEditVolume,
      thicknessEdited: thickerVolume,
      rectangularCornerRelief: reliefRectVolume,
      circularCornerRelief: reliefCircularVolume,
      bendTableDriven: baseVolume + edgeIncrement + downIncrement,
    },
    cornerRelief: {
      closedFormSize: 'bendRadius + thickness',
      styles: ['rectangular', 'circular'],
      splicedBeforeEdgeFlanges: true,
      adjacentFlangePairRequiresRelief: true,
      shortenedFlangeSweeps: true,
    },
    bendTable: {
      storage: 'part.extensions.sheetMetalBendTable',
      lookup: 'exact (thickness, bendRadius) equality, fail-closed missing rows',
      literalKFactorRefusedWhileStored: true,
      associativeReResolutionOnEdits: true,
      removalFreezesLiterals: true,
    },
    lifecycle: {
      canonicalSaveReopen: true,
      freshWorkerDeterminism: true,
      persistentTopologyStableAcrossEdits: true,
      typedCreateUpdateDelete: true,
      bodyDeleteCascades: true,
    },
    refusals: [
      'miter/hem/jog/tab kinds', 'zero thickness', 'out-of-range K-factor', 'duplicate edge flange',
      'segment outside profile', 'flange chained on flange', 'open profile', 'generic update bypasses',
      'immutable side patch', 'base delete before dependents', 'tampered allowance/thickness/names/angle/compliance',
      'adjacent flanges without corner relief', 'duplicate/non-perpendicular/out-of-profile corner relief',
      'derived relief field edits', 'relief delete under an adjacent flange pair', 'tampered relief size/order',
      'missing bend-table rows', 'literal K-factors under a stored table', 'unsorted/tampered bend tables',
    ],
    unsupported: [
      'miter flange', 'hem', 'jog', 'tab', 'partial-width flanges', 'non-90-degree bends and corners',
      'closed corners and sketched bends', 'gauge tables', 'per-flange relief sizing overrides',
      'convert-to-sheet-metal, rip, unfold, fold', 'forming tools',
    ],
  }, null, 2));
} finally {
  await freshKernel?.dispose();
  await kernel?.dispose();
}
