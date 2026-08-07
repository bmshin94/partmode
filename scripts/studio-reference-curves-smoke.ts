import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Reference curve smoke failed: ${label}`);
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

const referenceCommand = uiRegistry.cadUiCommandDefinition('model.reference-curve');
const kindField = referenceCommand?.fields?.find((entry: JsonRecord) => entry.id === 'referenceKind');
check('visible reference-curve command is not fully advertised', referenceCommand?.adapter === 'available'
  && ['projected', 'composite', 'helix'].every((value) => kindField?.values?.includes(value))
  && ['sourcePaths', 'planeDatum', 'axisDatum', 'radius', 'pitch', 'turns', 'startAngle', 'handedness']
    .every((id) => referenceCommand.fields.some((field: JsonRecord) => field.id === id)));
const pageSource = await readFile(resolve(root, 'src/page.html'), 'utf8');
check('human reference-curve ribbon control is missing', pageSource.includes('data-v5-command="reference-curve"'));
const workerSource = await readFile(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8');
check('helical kernel path is not analytic OCCT geometry', workerSource.includes("if (reference?.kind === 'helix')")
  && workerSource.includes('rc.sketchHelix(pitch, pitch * turns, radius'));
check('spline and projected-spline kernel paths are not exact cubic geometry', workerSource.includes('studioV5OpenSplineBezierSegments')
  && workerSource.includes('pathCurveSegments3d') && workerSource.includes('rc.makeBezierCurve(segment.points)'));

const visibleDraft = (referenceKind: string, inputValues: JsonRecord, boundSelections: JsonRecord): JsonRecord =>
  uiInteraction.buildCadUiCommandTransaction({
    expectedRevision: 0,
    transactionId: `visible-reference-${referenceKind}`,
    draft: {
      commandId: 'model.reference-curve', draftId: `draft-reference-${referenceKind}`, baseRevision: 0,
      inputValues: { name: `Visible ${referenceKind}`, referenceKind, ...inputValues },
      boundSelections,
      generatedIds: { sketchId: `sketch-visible-${referenceKind}` }, bootstrapOperations: [],
    },
  }).transaction;

const visibleProjected = visibleDraft('projected', {}, {
  sourcePaths: [{ kind: 'sketch', id: 'path-projected-source' }],
  planeDatum: [{ kind: 'datum', id: 'datum-origin-xy' }],
});
const visibleComposite = visibleDraft('composite', {}, {
  sourcePaths: [{ kind: 'sketch', id: 'path-composite-a' }, { kind: 'sketch', id: 'path-composite-b' }],
});
const visibleHelix = visibleDraft('helix', { radius: 5, pitch: 4, turns: 1, startAngle: 0, handedness: 'right' }, {
  axisDatum: [{ kind: 'datum', id: 'datum-origin-z' }],
});
for (const [kind, transaction] of [['projected', visibleProjected], ['composite', visibleComposite], ['helix', visibleHelix]] as const) {
  const operation = transaction.operations[0];
  check(`visible ${kind} adapter did not produce a typed reference-curve operation`, transaction.operations.length === 1
    && operation.kind === 'sketch.reference.create'
    && operation.input.definition.kind === kind);
}

const apply = (source: JsonRecord, id: string, operations: JsonRecord[]): JsonRecord => agent.applyCadTransaction(source, {
  transactionId: id,
  label: id,
  expectedRevision: 0,
  atomic: true,
  operations,
}).project as JsonRecord;

const fixture = JSON.parse(await readFile(resolve(root, 'tests/body-pattern-runtime/body-patterns.partmode.json'), 'utf8')) as JsonRecord;
fixture.projectId = 'project-reference-curves';
fixture.name = 'Reference curve acceptance';
fixture.partDefinitions[0].bodyPatterns = [];
let project = projectModule.prepareStudioV5Project(fixture) as JsonRecord;
project = apply(project, 'create-reference-curve-fixture', [
  { kind: 'parameter.create', input: { id: 'parameter-helix-radius', name: 'helix_radius', value: 5 } },
  { kind: 'parameter.create', input: { id: 'parameter-helix-pitch', name: 'helix_pitch', value: 4 } },
  {
    kind: 'datum.create',
    input: { id: 'datum-origin-xy', name: 'XY plane', datumKind: 'plane', definition: { mode: 'principal', origin: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] } },
  },
  {
    kind: 'datum.create',
    input: { id: 'datum-origin-z', name: 'Z axis', datumKind: 'axis', definition: { mode: 'principal', origin: [0, 0, 0], direction: [0, 0, 1] } },
  },
  {
    kind: 'datum.create',
    input: { id: 'datum-helix-cs', name: 'Helix coordinates', datumKind: 'coordinate-system', definition: { mode: 'principal', origin: [0, 0, 0], xDirection: [0, 1, 0], zDirection: [0, 0, 1] } },
  },
  { kind: 'sketch.path.create', input: { id: 'path-projected-source', name: 'Projection source', curveKind: 'polyline', points: [[0, 0, 5], [10, 0, 15]] } },
  { kind: 'sketch.path.create', input: { id: 'path-spline-source', name: 'Spline projection source', curveKind: 'spline', points: [[0, 0, 5], [5, 6, 9], [10, 0, 13]] } },
  { kind: 'sketch.path.create', input: { id: 'path-composite-a', name: 'Composite A', curveKind: 'polyline', points: [[0, 0, 0], [0, 0, 10]] } },
  { kind: 'sketch.path.create', input: { id: 'path-composite-b', name: 'Composite B', curveKind: 'polyline', points: [[0, 0, 10], [10, 0, 10]] } },
  {
    kind: 'sketch.reference.create',
    input: { id: 'reference-projected', name: 'Projected path', definition: { kind: 'projected', sourceSketchId: 'path-projected-source', planeDatumId: 'datum-origin-xy' } },
  },
  {
    kind: 'sketch.reference.create',
    input: { id: 'reference-spline-projected', name: 'Projected spline path', definition: { kind: 'projected', sourceSketchId: 'path-spline-source', planeDatumId: 'datum-origin-xy' } },
  },
  {
    kind: 'datum.create',
    input: {
      id: 'datum-projected-spline-quarter', name: 'Projected spline quarter point', datumKind: 'point',
      definition: { mode: 'on-curve', curveSketchId: 'reference-spline-projected', parameter: 0.25 },
    },
  },
  {
    kind: 'sketch.reference.create',
    input: { id: 'reference-composite', name: 'Composite path', definition: { kind: 'composite', sourceSketchIds: ['path-composite-a', 'path-composite-b'] } },
  },
  {
    kind: 'sketch.reference.create',
    input: { id: 'reference-helix', name: 'Analytic helix', definition: { kind: 'helix', axisDatumId: 'datum-helix-cs', radius: 'helix_radius', pitch: 'helix_pitch', turns: 1, startAngle: 0, handedness: 'right' } },
  },
  {
    kind: 'pattern.create',
    input: {
      id: 'pattern-projected', name: 'Projected path pattern', kind: 'curve', sourceBodyId: 'body-pattern-source', pathSketchId: 'reference-projected', outputMode: 'linked',
      definition: { count: 2, distribution: 'table', orientation: 'fixed', symmetric: false, parameters: [1] },
    },
  },
  {
    kind: 'pattern.create',
    input: {
      id: 'pattern-spline-projected', name: 'Projected spline pattern', kind: 'curve', sourceBodyId: 'body-pattern-source', pathSketchId: 'reference-spline-projected', outputMode: 'linked',
      definition: { count: 2, distribution: 'table', orientation: 'fixed', symmetric: false, parameters: [0.5] },
    },
  },
  {
    kind: 'pattern.create',
    input: {
      id: 'pattern-composite', name: 'Composite path pattern', kind: 'curve', sourceBodyId: 'body-pattern-source', pathSketchId: 'reference-composite', outputMode: 'linked',
      definition: { count: 2, distribution: 'table', orientation: 'fixed', symmetric: false, parameters: [1] },
    },
  },
  {
    kind: 'pattern.create',
    input: {
      id: 'pattern-helix', name: 'Helix path pattern', kind: 'curve', sourceBodyId: 'body-pattern-source', pathSketchId: 'reference-helix', outputMode: 'linked',
      definition: { count: 2, distribution: 'table', orientation: 'fixed', symmetric: false, parameters: [0.25] },
    },
  },
]);

const previews = Object.fromEntries(['reference-projected', 'reference-spline-projected', 'reference-composite', 'reference-helix'].map((id) => [id, modeling.resolveStudioV5PathPreview(project, id)]));
check('projected preview did not resolve onto the authored plane', JSON.stringify(previews['reference-projected'].points) === JSON.stringify([[0, 0, 0], [10, 0, 0]]));
const splineProjection = previews['reference-spline-projected'];
check('projected spline did not retain two exact cubic spans', splineProjection.exactPointEvaluation === true
  && splineProjection.exactPolylineEvaluation === false && splineProjection.projectionSegments?.length === 2
  && splineProjection.projectionSegments.every((segment: JsonRecord) => segment.kind === 'bezier'));
check('projected spline preview left its plane or lost its authored curve', splineProjection.points.length === 25
  && splineProjection.points.every((point: number[]) => closeTo(point[2]!, 0))
  && Math.max(...splineProjection.points.map((point: number[]) => point[1]!)) >= 6);
const splineQuarter = modeling.resolveStudioV5Datums(project).resolve('datum-projected-spline-quarter').point;
check('projected spline exact point evaluator did not use its cubic control points', closeTo(splineQuarter[0], 2.1875)
  && closeTo(splineQuarter[1], 3.375) && closeTo(splineQuarter[2], 0));
check('composite preview did not preserve exact source order', JSON.stringify(previews['reference-composite'].points) === JSON.stringify([[0, 0, 0], [0, 0, 10], [10, 0, 10]]));
check('helix preview did not preserve its coordinate-system phase and analytic endpoint extent', closeTo(previews['reference-helix'].points[0][1], 5)
  && closeTo(previews['reference-helix'].points.at(-1)[1], 5)
  && closeTo(previews['reference-helix'].points.at(-1)[2], 4));

const canonicalText = JSON.stringify(projectModule.prepareStudioV5Project(project));
project = projectModule.parseStudioV5Project(canonicalText) as JsonRecord;
check('reference curves changed across canonical save/reopen', JSON.stringify(project) === canonicalText);

const dependencyService = new agent.CadCommandService({ project });
const projectedDependencies = dependencyService.inspect({
  kind: 'entity.dependencies', entity: { kind: 'sketch', id: 'path-projected-source' }, direction: 'downstream',
});
check('projected curve source dependency is absent', projectedDependencies.items.some((edge: JsonRecord) =>
  edge.from.id === 'path-projected-source' && edge.to.id === 'reference-projected' && edge.relation === 'defines'));
const compositeDependencies = dependencyService.inspect({
  kind: 'entity.dependencies', entity: { kind: 'sketch', id: 'path-composite-b' }, direction: 'downstream',
});
check('composite curve source dependency is absent', compositeDependencies.items.some((edge: JsonRecord) =>
  edge.from.id === 'path-composite-b' && edge.to.id === 'reference-composite' && edge.relation === 'defines'));
rejection('deleting a projected-curve source was not guarded', project,
  () => runtime.deleteStudioV5AdvancedSketch(project, 'path-projected-source'), /Projected path/u);
rejection('deleting a projected-curve plane was not guarded', project,
  () => runtime.deleteStudioV5Datum(project, 'datum-origin-xy'), /Projected path/u);
rejection('disconnected composite curve did not fail closed', project, () => apply(project, 'invalid-disconnected-composite', [{
  kind: 'sketch.reference.create',
  input: { id: 'reference-disconnected', name: 'Disconnected', definition: { kind: 'composite', sourceSketchIds: ['path-projected-source', 'path-composite-b'] } },
}]), /connect end to start/u);
rejection('zero-radius helix did not fail closed', project, () => apply(project, 'invalid-zero-radius-helix', [{
  kind: 'sketch.reference.create',
  input: { id: 'reference-zero-radius', name: 'Zero radius', definition: { kind: 'helix', axisDatumId: 'datum-helix-cs', radius: 0, pitch: 4, turns: 1, handedness: 'right' } },
}]), /radius must evaluate above zero/u);
rejection('cyclic projected curve did not fail closed', project, () => apply(project, 'invalid-reference-cycle', [{
  kind: 'sketch.reference.update',
  input: { sketchId: 'reference-projected', patch: { definition: { kind: 'projected', sourceSketchId: 'reference-projected', planeDatumId: 'datum-origin-xy' } } },
}]), /[Cc]yclic reference-curve/u);
rejection('projecting an analytic helix without an exact affine-span representation did not fail closed', project, () => apply(project, 'invalid-helix-projection', [
  { kind: 'sketch.reference.create', input: { id: 'reference-helix-projection', name: 'Helix projection', definition: { kind: 'projected', sourceSketchId: 'reference-helix', planeDatumId: 'datum-origin-xy' } } },
]), /exact line or spline spans/u);

const movedPlaneProject = runtime.updateStudioV5Datum(project, 'datum-origin-xy', {
  definition: { mode: 'principal', origin: [0, 0, 2], normal: [0, 0, 1], xDirection: [1, 0, 0] },
});
check('datum edit did not refresh its projected curve preview', JSON.stringify(modeling.resolveStudioV5PathPreview(movedPlaneProject, 'reference-projected').points) === JSON.stringify([[0, 0, 2], [10, 0, 2]])
  && JSON.stringify(runtime.studioV5RootPart(movedPlaneProject).sketches.find((entry: JsonRecord) => entry.id === 'reference-projected').entities[0].points) === JSON.stringify([[0, 0, 2], [10, 0, 2]]));
const resizedHelixProject = apply(project, 'resize-parameterized-helix', [{
  kind: 'parameter.update', input: { parameterId: 'parameter-helix-radius', value: 6 },
}]);
check('parameter edit did not refresh its helical curve preview', closeTo(modeling.resolveStudioV5PathPreview(resizedHelixProject, 'reference-helix').points[0][1], 6)
  && closeTo(runtime.studioV5RootPart(resizedHelixProject).sketches.find((entry: JsonRecord) => entry.id === 'reference-helix').entities[0].points[0][1], 6));

const movedProject = apply(project, 'move-projected-source', [{
  kind: 'sketch.advanced.update',
  input: { sketchId: 'path-projected-source', patch: { points: [[0, 0, 7], [20, 0, 25]] } },
}]);
check('projected preview did not update associatively', JSON.stringify(modeling.resolveStudioV5PathPreview(movedProject, 'reference-projected').points) === JSON.stringify([[0, 0, 0], [20, 0, 0]]));
const movedSplineProject = apply(project, 'move-projected-spline-source', [{
  kind: 'sketch.advanced.update',
  input: { sketchId: 'path-spline-source', patch: { points: [[0, 0, 7], [5, 10, 11], [10, 0, 15]] } },
}]);
const movedSplinePreview = modeling.resolveStudioV5PathPreview(movedSplineProject, 'reference-spline-projected');
check('projected spline preview did not update associatively', closeTo(Math.max(...movedSplinePreview.points.map((point: number[]) => point[1]!)), 10)
  && movedSplinePreview.points.every((point: number[]) => closeTo(point[2]!, 0)));

function exactPatternOccurrence(result: JsonRecord, patternId: string): JsonRecord {
  const matches = result.bodies.filter((entry: JsonRecord) => entry.patternInstance?.patternId === patternId && entry.patternInstance?.fused !== true);
  check(`${patternId} did not create one linked occurrence`, matches.length === 1);
  const entry = matches[0];
  check(`${patternId} is not one valid exact linked solid: ${JSON.stringify(entry)}`, !entry.error && entry.lastValid === false
    && entry.geometry?.valid === true && entry.geometry?.brepValid === true && entry.geometry?.solidCount === 1
    && entry.renderSourceBodyId === 'body-pattern-source' && Array.isArray(entry.renderTransform) && entry.renderTransform.length === 16);
  return entry;
}

function checkBounds(actual: number[][], expected: number[][], label: string): void {
  check(label, actual?.flat().every((value: number, index: number) => closeTo(value, expected.flat()[index]!)));
}

let kernel: HeadlessKernel | null = null;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  let revision = 0;
  const rebuild = async (document: JsonRecord, label: string): Promise<JsonRecord> => {
    revision += 1;
    const result = await kernel!.request({
      kind: 'rebuild', requestId: `reference-curves-${revision}-${label}`,
      projectId: document.projectId, revision, document, includeExactBrep: true,
    }, 180_000) as JsonRecord;
    check(`${label} exact rebuild failed: ${JSON.stringify(result.errors || [])}`,
      result.kind === 'rebuild-result' && result.errors?.length === 0 && result.warnings?.length === 0);
    return result;
  };

  const baseResult = await rebuild(project, 'base');
  const projected = exactPatternOccurrence(baseResult, 'pattern-projected');
  const projectedSpline = exactPatternOccurrence(baseResult, 'pattern-spline-projected');
  const composite = exactPatternOccurrence(baseResult, 'pattern-composite');
  const helix = exactPatternOccurrence(baseResult, 'pattern-helix');
  checkBounds(projected.geometry.bounds, [[4, -4, 0], [16, 4, 8]], 'projected exact path endpoint changed');
  checkBounds(projectedSpline.geometry.bounds, [[-1, 2, 0], [11, 10, 8]], 'projected exact spline midpoint changed');
  checkBounds(composite.geometry.bounds, [[4, -4, 10], [16, 4, 18]], 'composite exact joined-wire endpoint changed');
  checkBounds(helix.geometry.bounds, [[-11, -9, 1], [1, -1, 9]], 'analytic helix coordinate-system phase or quarter-turn placement changed');

  const movedResult = await rebuild(movedProject, 'moved-projection-source');
  const movedProjected = exactPatternOccurrence(movedResult, 'pattern-projected');
  checkBounds(movedProjected.geometry.bounds, [[14, -4, 0], [26, 4, 8]], 'projected source edit did not invalidate the exact dependent occurrence');
  check('projected source edit reused a stale exact transform', projected.renderTransform.join(',') !== movedProjected.renderTransform.join(','));

  const movedSplineResult = await rebuild(movedSplineProject, 'moved-projection-spline-source');
  const movedProjectedSpline = exactPatternOccurrence(movedSplineResult, 'pattern-spline-projected');
  checkBounds(movedProjectedSpline.geometry.bounds, [[-1, 6, 0], [11, 14, 8]], 'projected spline source edit did not invalidate the exact dependent occurrence');
  check('projected spline source edit reused a stale exact transform', projectedSpline.renderTransform.join(',') !== movedProjectedSpline.renderTransform.join(','));

  console.log(JSON.stringify({
    schema: 'partmode.reference-curves-smoke/v1',
    exactRebuilds: 3,
    proven: {
      projected: { sourceEdit: '10 mm to 20 mm endpoint', boundsAfter: movedProjected.geometry.bounds },
      projectedSpline: {
        representation: 'exact cubic Bezier spans projected by their control points',
        pointAtQuarter: splineQuarter,
        boundsBefore: projectedSpline.geometry.bounds,
        boundsAfterControlEdit: movedProjectedSpline.geometry.bounds,
      },
      composite: { sourceCount: 2, exactEndpointBounds: composite.geometry.bounds },
      helix: { representation: 'analytic OCCT helix', radius: 5, pitch: 4, turns: 1, quarterTurnBounds: helix.geometry.bounds },
    },
    persistence: 'typed transactions plus canonical save/reopen',
    dependencies: ['path to projected curve', 'paths to composite curve', 'reference curve to curve-driven pattern'],
    failClosed: ['disconnected composite', 'zero-radius helix', 'cyclic reference curve', 'helix projection without affine spans', 'referenced-source deletion', 'referenced-datum deletion'],
  }, null, 2));
} finally {
  await kernel?.dispose();
}
