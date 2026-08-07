import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Reference geometry smoke failed: ${label}`);
}

function closeTo(actual: number, expected: number, tolerance = 2e-5): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function rejection(label: string, source: JsonRecord, action: () => unknown, pattern: RegExp): void {
  const before = JSON.stringify(source);
  let error: unknown = null;
  try { action(); } catch (candidate) { error = candidate; }
  check(label, error instanceof Error && pattern.test(error.message));
  check(`${label} mutated its source`, JSON.stringify(source) === before);
}

const root = process.cwd();
const moduleAt = async (path: string) => import(pathToFileURL(resolve(root, path)).href) as Promise<any>;
const projectModule = await moduleAt('src/static/studio-project-v5.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const modeling = await moduleAt('src/static/studio-v5-modeling.js');
const agent = await moduleAt('src/static/studio-agent-service.js');
const uiRegistry = await moduleAt('src/static/studio-v6-ui-registry.js');
const uiInteraction = await moduleAt('src/static/studio-v6-interaction.js');

const coordinateCommand = uiRegistry.cadUiCommandDefinition('model.coordinate-system');
const pointCommand = uiRegistry.cadUiCommandDefinition('model.curve-point');
const planeCommand = uiRegistry.cadUiCommandDefinition('model.plane');
check('visible coordinate-system command is not fully advertised', coordinateCommand?.adapter === 'available'
  && ['name', 'origin', 'xDirection', 'zDirection'].every((id) => coordinateCommand.fields.some((field: JsonRecord) => field.id === id)));
check('visible point-on-curve command is not fully advertised', pointCommand?.adapter === 'available'
  && ['name', 'pathSketch', 'parameter'].every((id) => pointCommand.fields.some((field: JsonRecord) => field.id === id)));
check('visible construction-plane command is not fully advertised', planeCommand?.adapter === 'available'
  && ['name', 'mode', 'pointDatum', 'normal'].every((id) => planeCommand.fields.some((field: JsonRecord) => field.id === id)));
const pageSource = await readFile(resolve(root, 'src/page.html'), 'utf8');
check('human coordinate-system ribbon control is missing', pageSource.includes('data-v5-command="coordinate-system"'));
check('human point-on-curve ribbon control is missing', pageSource.includes('data-v5-command="curve-point"'));

const visibleCoordinateTransaction = uiInteraction.buildCadUiCommandTransaction({
  expectedRevision: 0,
  transactionId: 'visible-coordinate-system',
  draft: {
    commandId: 'model.coordinate-system', draftId: 'draft-coordinate-system', baseRevision: 0,
    inputValues: { name: 'Visible coordinates', origin: [1, 2, 3], xDirection: [1, 0, 0], zDirection: [0, 0, 1] },
    boundSelections: {}, generatedIds: { datumId: 'datum-visible-cs' }, bootstrapOperations: [],
  },
}).transaction;
check('visible coordinate-system adapter did not produce its typed datum operation',
  visibleCoordinateTransaction.operations.length === 1
    && visibleCoordinateTransaction.operations[0].kind === 'datum.create'
    && visibleCoordinateTransaction.operations[0].input.datumKind === 'coordinate-system');
const visiblePointTransaction = uiInteraction.buildCadUiCommandTransaction({
  expectedRevision: 0,
  transactionId: 'visible-point-on-curve',
  draft: {
    commandId: 'model.curve-point', draftId: 'draft-point-on-curve', baseRevision: 0,
    inputValues: { name: 'Visible curve point', parameter: 0.25 },
    boundSelections: { pathSketch: [{ kind: 'sketch', id: 'sketch-reference-path' }] },
    generatedIds: { datumId: 'datum-visible-point' }, bootstrapOperations: [],
  },
}).transaction;
check('visible point-on-curve adapter did not produce its typed datum operation',
  visiblePointTransaction.operations.length === 1
    && visiblePointTransaction.operations[0].kind === 'datum.create'
    && visiblePointTransaction.operations[0].input.datumKind === 'point'
    && visiblePointTransaction.operations[0].input.definition.curveSketchId === 'sketch-reference-path');
const visibleCurveNormalTransaction = uiInteraction.buildCadUiCommandTransaction({
  expectedRevision: 0,
  transactionId: 'visible-curve-normal-plane',
  draft: {
    commandId: 'model.plane', draftId: 'draft-curve-normal-plane', baseRevision: 0,
    inputValues: { name: 'Visible curve-normal plane', mode: 'curve-normal', normal: [0, 1, 0] },
    boundSelections: { pointDatum: [{ kind: 'datum', id: 'datum-origin-point' }] },
    generatedIds: { datumId: 'datum-visible-curve-normal' }, bootstrapOperations: [],
  },
}).transaction;
check('visible curve-normal adapter did not preserve its point-plus-tangent datum contract',
  visibleCurveNormalTransaction.operations.length === 1
    && visibleCurveNormalTransaction.operations[0].kind === 'datum.create'
    && visibleCurveNormalTransaction.operations[0].input.datumKind === 'plane'
    && JSON.stringify(visibleCurveNormalTransaction.operations[0].input.definition) === JSON.stringify({
      mode: 'curve-normal', pointDatumId: 'datum-origin-point', tangent: [0, 1, 0],
    }));

const transaction = (source: JsonRecord, id: string, operations: JsonRecord[]): JsonRecord => agent.applyCadTransaction(source, {
  transactionId: id,
  label: id,
  expectedRevision: 0,
  atomic: true,
  operations,
}).project as JsonRecord;

const originOperations = [
  { kind: 'datum.create', input: { id: 'datum-origin-point', name: 'Origin', datumKind: 'point', definition: { mode: 'coordinates', coordinates: [0, 0, 0] } } },
  { kind: 'datum.create', input: { id: 'datum-origin-xy', name: 'XY plane', datumKind: 'plane', definition: { mode: 'principal', origin: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] } } },
  { kind: 'datum.create', input: { id: 'datum-origin-yz', name: 'YZ plane', datumKind: 'plane', definition: { mode: 'principal', origin: [0, 0, 0], normal: [1, 0, 0], xDirection: [0, 1, 0] } } },
  { kind: 'datum.create', input: { id: 'datum-origin-zx', name: 'ZX plane', datumKind: 'plane', definition: { mode: 'principal', origin: [0, 0, 0], normal: [0, 1, 0], xDirection: [0, 0, 1] } } },
  { kind: 'datum.create', input: { id: 'datum-origin-x', name: 'X axis', datumKind: 'axis', definition: { mode: 'principal', origin: [0, 0, 0], direction: [1, 0, 0] } } },
  { kind: 'datum.create', input: { id: 'datum-origin-y', name: 'Y axis', datumKind: 'axis', definition: { mode: 'principal', origin: [0, 0, 0], direction: [0, 1, 0] } } },
  { kind: 'datum.create', input: { id: 'datum-origin-z', name: 'Z axis', datumKind: 'axis', definition: { mode: 'principal', origin: [0, 0, 0], direction: [0, 0, 1] } } },
  { kind: 'datum.create', input: { id: 'datum-origin-cs', name: 'World coordinates', datumKind: 'coordinate-system', definition: { mode: 'principal', origin: [0, 0, 0], xDirection: [1, 0, 0], zDirection: [0, 0, 1] } } },
];

let pointProject = projectModule.createEmptyStudioV5PartProject({
  projectId: 'project-reference-geometry',
  name: 'Reference geometry acceptance',
  units: 'mm',
}) as JsonRecord;
pointProject = transaction(pointProject, 'bootstrap-canonical-origin-datums', originOperations);
check('canonical origin bootstrap did not preserve all eight typed datums', runtime.studioV5RootPart(pointProject).referenceGeometry.length === 8);

pointProject = transaction(pointProject, 'create-reference-geometry', [
  ...visibleCurveNormalTransaction.operations,
  {
    kind: 'sketch.path.create',
    input: { id: 'sketch-reference-path', name: 'Reference path', curveKind: 'polyline', points: [[0, 0, 0], [0, 0, 20], [20, 0, 20]] },
  },
  {
    kind: 'sketch.path.create',
    input: { id: 'sketch-reference-spline', name: 'Reference spline', curveKind: 'spline', points: [[0, 0, 0], [0, 0, 20], [20, 0, 20]] },
  },
  {
    kind: 'datum.create',
    input: {
      id: 'datum-custom-cs', name: 'Rotated coordinates', datumKind: 'coordinate-system',
      definition: { mode: 'principal', origin: [10, 20, 30], xDirection: [1, 1, 0], zDirection: [0, 0, 1] },
    },
  },
  {
    kind: 'datum.create',
    input: {
      id: 'datum-path-midpoint', name: 'Path midpoint', datumKind: 'point',
      definition: { mode: 'on-curve', curveSketchId: 'sketch-reference-path', parameter: 0.5 },
    },
  },
  {
    kind: 'datum.create',
    input: {
      id: 'datum-spline-quarter', name: 'Spline quarter point', datumKind: 'point',
      definition: { mode: 'on-curve', curveSketchId: 'sketch-reference-spline', parameter: 0.25 },
    },
  },
  {
    kind: 'datum.create',
    input: {
      id: 'datum-path-plane', name: 'Path point plane', datumKind: 'plane',
      definition: { mode: 'point-normal', pointDatumId: 'datum-path-midpoint', normal: [0, 0, 1] },
    },
  },
  {
    kind: 'sketch.profile.create',
    input: { id: 'sketch-loft-base', name: 'Loft base', planeDatumId: 'datum-origin-xy', curveKind: 'polyline', points: [[-2, -2], [2, -2], [2, 2], [-2, 2]] },
  },
  {
    kind: 'sketch.profile.create',
    input: { id: 'sketch-loft-top', name: 'Loft top', planeDatumId: 'datum-path-plane', curveKind: 'polyline', points: [[-2, -2], [2, -2], [2, 2], [-2, 2]] },
  },
  {
    kind: 'feature.loft',
    input: {
      id: 'feature-point-driven-loft', name: 'Point driven loft', sections: ['sketch-loft-base', 'sketch-loft-top'],
      mapping: 'explicit', continuity: { start: 'free', end: 'free' }, ruled: true, closed: false, bodyName: 'Point driven loft',
    },
  },
]);

const frames = modeling.resolveStudioV5Datums(pointProject);
const coordinateFrame = frames.resolve('datum-custom-cs');
const pointFrame = frames.resolve('datum-path-midpoint');
const splinePointFrame = frames.resolve('datum-spline-quarter');
const curveNormalFrame = frames.resolve('datum-visible-curve-normal');
check('coordinate-system origin changed', JSON.stringify(coordinateFrame.origin) === JSON.stringify([10, 20, 30]));
check('coordinate-system X axis was not normalized', closeTo(coordinateFrame.xDirection[0], Math.SQRT1_2)
  && closeTo(coordinateFrame.xDirection[1], Math.SQRT1_2)
  && closeTo(coordinateFrame.xDirection[2], 0));
check('coordinate-system frame is not right handed', closeTo(coordinateFrame.yDirection[0], -Math.SQRT1_2)
  && closeTo(coordinateFrame.yDirection[1], Math.SQRT1_2)
  && JSON.stringify(coordinateFrame.zDirection) === JSON.stringify([0, 0, 1]));
check('normalized arc-length midpoint did not resolve at the polyline corner', JSON.stringify(pointFrame.point) === JSON.stringify([0, 0, 20]));
check('exact spline-span point did not resolve on the cubic curve', closeTo(splinePointFrame.point[0], -1.25)
  && closeTo(splinePointFrame.point[1], 0) && closeTo(splinePointFrame.point[2], 10));
check('visible point-plus-tangent curve-normal plane no longer resolves',
  JSON.stringify(curveNormalFrame.origin) === JSON.stringify([0, 0, 0])
    && JSON.stringify(curveNormalFrame.normal) === JSON.stringify([0, 1, 0]));

const canonicalText = JSON.stringify(projectModule.prepareStudioV5Project(pointProject));
pointProject = projectModule.parseStudioV5Project(canonicalText) as JsonRecord;
check('reference geometry changed across canonical save/reopen', JSON.stringify(pointProject) === canonicalText);

const dependencyService = new agent.CadCommandService({ project: pointProject });
const pathDependencies = dependencyService.inspect({
  kind: 'entity.dependencies', entity: { kind: 'sketch', id: 'sketch-reference-path' }, direction: 'downstream',
});
check('path where-used does not report its associative point datum', pathDependencies.items.some((edge: JsonRecord) =>
  edge.from.kind === 'sketch' && edge.from.id === 'sketch-reference-path'
    && edge.to.kind === 'datum' && edge.to.id === 'datum-path-midpoint' && edge.relation === 'defines'));
rejection('deleting a referenced path was not guarded', pointProject,
  () => runtime.deleteStudioV5AdvancedSketch(pointProject, 'sketch-reference-path'), /Path midpoint/u);

rejection('point parameter above one did not fail closed', pointProject, () => transaction(pointProject, 'invalid-path-parameter', [{
  kind: 'datum.create',
  input: { id: 'datum-invalid-parameter', name: 'Invalid point', datumKind: 'point', definition: { mode: 'on-curve', curveSketchId: 'sketch-reference-path', parameter: 1.01 } },
}]), /parameter must evaluate from 0 through 1/u);
rejection('zero coordinate-system Z direction did not fail closed', pointProject, () => transaction(pointProject, 'invalid-coordinate-system', [{
  kind: 'datum.create',
  input: { id: 'datum-invalid-cs', name: 'Invalid coordinates', datumKind: 'coordinate-system', definition: { mode: 'principal', origin: [0, 0, 0], xDirection: [1, 0, 0], zDirection: [0, 0, 0] } },
}]), /cannot be zero length/u);
rejection('introducing a zero-length referenced path segment did not fail closed', pointProject, () => transaction(pointProject, 'invalid-point-path-segment', [{
  kind: 'sketch.advanced.update', input: { sketchId: 'sketch-reference-path', patch: { points: [[0, 0, 0], [0, 0, 0], [20, 0, 20]] } },
}]), /consecutive duplicate points/u);

let movedPointProject = transaction(pointProject, 'move-associative-reference-path', [{
  kind: 'sketch.advanced.update',
  input: { sketchId: 'sketch-reference-path', patch: { points: [[0, 0, 0], [0, 0, 30], [30, 0, 30]] } },
}, {
  kind: 'sketch.advanced.update',
  input: { sketchId: 'sketch-reference-spline', patch: { points: [[0, 0, 0], [0, 0, 30], [30, 0, 30]] } },
}]);
check('point did not move associatively after path edit', JSON.stringify(modeling.resolveStudioV5Datums(movedPointProject).resolve('datum-path-midpoint').point) === JSON.stringify([0, 0, 30]));
const movedSplinePoint = modeling.resolveStudioV5Datums(movedPointProject).resolve('datum-spline-quarter').point;
check('spline point did not move associatively after control-point edit', closeTo(movedSplinePoint[0], -1.875)
  && closeTo(movedSplinePoint[1], 0) && closeTo(movedSplinePoint[2], 15));

const patternFixture = JSON.parse(await readFile(resolve(root, 'tests/body-pattern-runtime/body-patterns.partmode.json'), 'utf8')) as JsonRecord;
patternFixture.partDefinitions[0].bodyPatterns = [];
let coordinatePattern = projectModule.prepareStudioV5Project(patternFixture) as JsonRecord;
coordinatePattern = transaction(coordinatePattern, 'coordinate-system-driven-pattern', [
  {
    kind: 'datum.create',
    input: { id: 'datum-pattern-cs', name: 'Y pattern coordinates', datumKind: 'coordinate-system', definition: { mode: 'principal', origin: [0, 0, 0], xDirection: [0, 1, 0], zDirection: [0, 0, 1] } },
  },
  {
    kind: 'pattern.create',
    input: {
      id: 'pattern-coordinate-system', name: 'Coordinate-system pattern', kind: 'linear', sourceBodyId: 'body-pattern-source',
      directionDatumIds: ['datum-pattern-cs'], outputMode: 'linked',
      definition: { count: 2, distribution: 'spacing', orientation: 'preserve', symmetric: false, spacing: 10 },
    },
  },
]);

let kernel: HeadlessKernel | null = null;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  let revision = 0;
  const rebuild = async (document: JsonRecord, label: string): Promise<JsonRecord> => {
    revision += 1;
    const result = await kernel!.request({
      kind: 'rebuild', requestId: `reference-geometry-${revision}-${label}`,
      projectId: document.projectId, revision, document, includeExactBrep: true,
    }, 180_000) as JsonRecord;
    check(`${label} exact rebuild failed: ${JSON.stringify(result.errors || [])}`,
      result.kind === 'rebuild-result' && result.errors?.length === 0 && result.warnings?.length === 0);
    return result;
  };

  const baseLoftResult = await rebuild(pointProject, 'point-loft-20');
  const movedLoftResult = await rebuild(movedPointProject, 'point-loft-30');
  const exactLoft = (result: JsonRecord) => result.bodies.find((entry: JsonRecord) =>
    entry.sourceBodyId === 'body-feature-point-driven-loft' || entry.bodyId === 'body-feature-point-driven-loft');
  const loft20 = exactLoft(baseLoftResult);
  const loft30 = exactLoft(movedLoftResult);
  check(`20 mm point-driven loft did not produce one exact valid solid: ${JSON.stringify(loft20)}`, loft20?.geometry?.valid === true
    && loft20.geometry.brepValid === true && loft20.geometry.solidCount === 1 && typeof loft20.exactBrep === 'string'
    && closeTo(loft20.geometry.volume, 320, 2e-4));
  check(`30 mm point-driven loft did not update exact volume: ${JSON.stringify(loft30)}`, loft30?.geometry?.valid === true
    && loft30.geometry.brepValid === true && loft30.geometry.solidCount === 1 && typeof loft30.exactBrep === 'string'
    && closeTo(loft30.geometry.volume, 480, 2e-4));
  check('associative point edit did not move the exact loft bound', closeTo(loft20.geometry.bounds[1][2], 20)
    && closeTo(loft30.geometry.bounds[1][2], 30));
  check('point-driven loft topology is incomplete', loft30.mesh?.topologyCounts?.faces === loft30.mesh.topologyFaces.length
    && loft30.mesh?.topologyCounts?.edges === loft30.mesh.edges.length
    && loft30.mesh?.topologyCounts?.vertices === loft30.mesh.topologyVertices.length
    && loft30.mesh.topologyFaces.every((entry: JsonRecord) => typeof entry.name === 'string')
    && loft30.mesh.edges.every((entry: JsonRecord) => typeof entry.name === 'string')
    && loft30.mesh.topologyVertices.every((entry: JsonRecord) => typeof entry.name === 'string'));

  const patternResult = await rebuild(coordinatePattern, 'coordinate-system-pattern');
  const occurrence = patternResult.bodies.find((entry: JsonRecord) =>
    entry.patternInstance?.patternId === 'pattern-coordinate-system' && entry.patternInstance?.index === 1);
  check(`coordinate-system-driven pattern did not publish an exact linked occurrence: ${JSON.stringify(occurrence)}`,
    occurrence?.geometry?.valid === true && occurrence.geometry.brepValid === true && occurrence.geometry.solidCount === 1
      && occurrence.renderSourceBodyId === 'body-pattern-source' && Array.isArray(occurrence.renderTransform));
  check('coordinate-system X direction did not drive the exact pattern translation',
    closeTo(occurrence.geometry.bounds[0][0], -6) && closeTo(occurrence.geometry.bounds[1][0], 6)
      && closeTo(occurrence.geometry.bounds[0][1], 6) && closeTo(occurrence.geometry.bounds[1][1], 14));

  console.log(JSON.stringify({
    schema: 'partmode.reference-geometry-smoke/v1',
    exactRebuilds: 3,
    coordinateSystem: {
      origin: coordinateFrame.origin,
      xDirection: coordinateFrame.xDirection,
      yDirection: coordinateFrame.yDirection,
      zDirection: coordinateFrame.zDirection,
      patternBounds: occurrence.geometry.bounds,
    },
    pointOnCurve: {
      modes: ['normalized-polyline-arc-length', 'normalized-exact-spline-span'],
      before: [0, 0, 20],
      afterPathEdit: [0, 0, 30],
      splineBefore: splinePointFrame.point,
      splineAfter: movedSplinePoint,
      loftVolumes: [loft20.geometry.volume, loft30.geometry.volume],
      loftBounds: [loft20.geometry.bounds, loft30.geometry.bounds],
    },
    contracts: {
      typedTransactions: true,
      canonicalSaveReopen: true,
      dependencyWhereUsed: true,
      guardedDelete: true,
      failClosedInvalidInputs: true,
      curveNormalPointTangent: true,
      visibleCommands: ['model.coordinate-system', 'model.curve-point', 'model.plane'],
    },
    limitations: [],
  }, null, 2));
} finally {
  await kernel?.dispose();
}
