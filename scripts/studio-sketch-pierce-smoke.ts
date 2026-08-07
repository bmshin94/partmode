import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Sketch Pierce smoke failed: ${label}`);
}

function expectCode(label: string, fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Sketch Pierce smoke failed: ${label} did not fail`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const solver = await moduleAt('src/static/studio-sketch-solver.js');
const editor = await moduleAt('src/static/studio-sketch-constraint-edit.js');
const pierceTools = await moduleAt('src/static/studio-sketch-pierce.js');
const agentTools = await moduleAt('src/static/studio-agent-service.js');
const registryTools = await moduleAt('src/static/studio-v6-ui-registry.js');

const fixture = JSON.parse(await readFile(resolve(root, 'tests/cad-corpus/named-checkpoint.partmode.json'), 'utf8')) as JsonRecord;
fixture.projectId = 'sketch-pierce-exact';
fixture.name = 'Associative Pierce profile';
fixture.parameters = [];
const part = fixture.partDefinitions[0];
part.name = 'Pierced profile';
part.referenceGeometry = [{
  id: 'datum-pierce-xy', name: 'Pierce sketch plane', kind: 'plane', suppressed: false,
  definition: { mode: 'principal', origin: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
}];
part.sketches = [{
  id: 'path-pierce', name: 'Cross-plane path',
  entities: [{ id: 'entity-path-pierce', kind: 'polyline', points: [[-5, -5, -10], [5, 5, 10]], closed: false }],
  groups: [], constraints: [], extensions: { studioRole: 'path' },
}];
part.bodies = [{
  id: 'body-pierce', name: 'Pierced exact body', kind: 'solid', createdByFeatureId: 'feature-pierce',
  featureIds: ['feature-pierce'], visible: true, suppressed: false,
}];
const constrained = {
  entities: [
    { id: 'p1', kind: 'point', at: [1, 1] },
    { id: 'p2', kind: 'point', at: [21, 1] },
    { id: 'p3', kind: 'point', at: [21, 11] },
    { id: 'p4', kind: 'point', at: [1, 11] },
    { id: 'bottom', kind: 'line', a: 'p1', b: 'p2' },
    { id: 'right', kind: 'line', a: 'p2', b: 'p3' },
    { id: 'top', kind: 'line', a: 'p3', b: 'p4' },
    { id: 'left', kind: 'line', a: 'p4', b: 'p1' },
  ],
  constraints: [
    { id: 'pierce-origin', kind: 'pierce', point: 'p1', curveSketchId: 'path-pierce', planeDatumId: 'datum-pierce-xy' },
    { id: 'bottom-horizontal', kind: 'horizontal', line: 'bottom' },
    { id: 'right-vertical', kind: 'vertical', line: 'right' },
    { id: 'top-horizontal', kind: 'horizontal', line: 'top' },
    { id: 'left-vertical', kind: 'vertical', line: 'left' },
    { id: 'width', kind: 'horizontalDistance', a: 'p1', b: 'p2', value: 20 },
    { id: 'height', kind: 'verticalDistance', a: 'p1', b: 'p4', value: 10 },
  ],
};
part.features = [{
  id: 'feature-pierce', name: 'Pierce-driven extrusion', type: 'extrude',
  sketch: {
    id: 'profile-pierce', name: 'Pierced rectangle', constrained, entities: [],
    shapes: [{ kind: 'rect', x: 11, y: 6, w: 20, h: 10 }], z: 0,
  },
  plane: { kind: 'base', plane: 'XY' }, h: 5, through: false,
  resultPolicy: { kind: 'new-body', bodyName: 'Pierced exact body' }, createdBodyId: 'body-pierce',
  suppressed: false, inputRefs: [], extensions: { exactSketchEntities: true },
}];
part.featureOrder = ['feature-pierce'];
part.metadata = { activeBodyId: 'body-pierce' };
fixture.rootDocument = { kind: 'part', partId: part.id };
const authored = runtime.canonicalStudioV5Project(fixture);
const initialTransaction = agentTools.applyCadTransaction(authored, {
  transactionId: 'transaction-pierce-initial', label: 'Resolve initial Pierce path', expectedRevision: 0, atomic: true,
  operations: [{ kind: 'sketch.advanced.update', input: { sketchId: 'path-pierce', patch: { kind: 'polyline', points: [[-5, -5, -10], [5, 5, 10]] } } }],
});
const initial = initialTransaction.project;
const initialResolver = pierceTools.createStudioV5PierceResolver(initial, part.id);
const initialEvidence = pierceTools.resolveStudioV5PierceTarget(initial, part.id, constrained.constraints[0]);
check('Pierce evidence schema changed', initialEvidence.schema === 'partmode.sketch-pierce/v1');
check(`initial reference does not pierce the plane at the origin ${JSON.stringify(initialEvidence)}`,
  JSON.stringify(initialEvidence.worldPoint) === JSON.stringify([0, 0, 0])
  && JSON.stringify(initialEvidence.target) === JSON.stringify([0, 0]));
const initialSolved = solver.solveSketch(constrained, { resolveDimension: Number, resolvePierce: initialResolver });
check(`Pierce sketch did not solve fully defined ${JSON.stringify(initialSolved.diagnostics)}`,
  initialSolved.status === 'ok' && initialSolved.dof === 0 && initialSolved.equations === 8);
check('Pierce did not solve p1 to the exact intersection', JSON.stringify(initialSolved.entities.find((entry: JsonRecord) => entry.id === 'p1').at) === JSON.stringify([0, 0]));

const sourceJson = JSON.stringify(initial);
const movedTransaction = agentTools.applyCadTransaction(initial, {
  transactionId: 'transaction-pierce-move', label: 'Move associative Pierce path', expectedRevision: 0, atomic: true,
  operations: [{ kind: 'sketch.advanced.update', input: { sketchId: 'path-pierce', patch: { kind: 'polyline', points: [[-1, -3, -10], [9, 7, 10]] } } }],
});
check('typed Pierce update mutated its source document', JSON.stringify(initial) === sourceJson);
const moved = movedTransaction.project;
const movedEvidence = pierceTools.resolveStudioV5PierceTarget(moved, part.id, constrained.constraints[0]);
check(`moved reference does not pierce at 4,2 ${JSON.stringify(movedEvidence)}`,
  JSON.stringify(movedEvidence.worldPoint) === JSON.stringify([4, 2, 0])
  && JSON.stringify(movedEvidence.target) === JSON.stringify([4, 2]));
const movedConstrained = moved.partDefinitions[0].features[0].sketch.constrained;
const movedSolved = solver.solveSketch(movedConstrained, {
  resolveDimension: Number,
  resolvePierce: pierceTools.createStudioV5PierceResolver(moved, part.id),
});
check('associative path edit did not move the constrained profile', JSON.stringify(movedSolved.entities.find((entry: JsonRecord) => entry.id === 'p1').at) === JSON.stringify([4, 2]));
const reopened = runtime.canonicalStudioV5Project(JSON.parse(JSON.stringify(moved)));
check('Pierce save/reopen changed the project', JSON.stringify(reopened) === JSON.stringify(moved));
check('Pierce constraint disappeared after save/reopen', reopened.partDefinitions[0].features[0].sketch.constrained.constraints[0].kind === 'pierce');
const dependencies = new agentTools.CadCommandService({ project: reopened }).inspect({
  kind: 'entity.dependencies', entity: { kind: 'sketch', id: 'path-pierce' }, direction: 'downstream',
});
check('Pierce reference is absent from where-used dependency management', dependencies.items.some((edge: JsonRecord) =>
  edge.from.kind === 'sketch' && edge.from.id === 'path-pierce'
  && edge.to.kind === 'feature' && edge.to.id === 'feature-pierce' && edge.relation === 'pierces'));

let kernel: HeadlessKernel | null = null;
let initialExact: JsonRecord;
let movedExact: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  initialExact = await kernel.request({ kind: 'rebuild', requestId: 'pierce-initial-exact', projectId: initial.projectId, revision: 1, document: initial }) as JsonRecord;
  movedExact = await kernel.request({ kind: 'rebuild', requestId: 'pierce-moved-exact', projectId: moved.projectId, revision: 2, document: moved }) as JsonRecord;
} finally {
  await kernel?.dispose();
}
for (const [label, result] of [['initial', initialExact], ['moved', movedExact]] as Array<[string, JsonRecord]>) {
  check(`${label} exact rebuild failed ${JSON.stringify(result.errors || [])}`, result.kind === 'rebuild-result' && result.errors?.length === 0 && result.bodies?.length === 1);
  check(`${label} exact body is not valid ${JSON.stringify(result.bodies[0].geometry)}`, result.bodies[0].geometry?.valid === true && result.bodies[0].geometry?.solidCount === 1);
  check(`${label} exact body volume changed`, Math.abs(result.bodies[0].geometry.volume - 1000) < 1e-7);
}
check(`initial exact bounds are wrong ${JSON.stringify(initialExact.bodies[0].geometry.bounds)}`,
  JSON.stringify(initialExact.bodies[0].geometry.bounds) === JSON.stringify([[0, 0, 0], [20, 10, 5]]));
check(`moved exact bounds are wrong ${JSON.stringify(movedExact.bodies[0].geometry.bounds)}`,
  JSON.stringify(movedExact.bodies[0].geometry.bounds) === JSON.stringify([[4, 2, 0], [24, 12, 5]]));
const movedTopology = movedExact.bodies[0].mesh.topologyCounts;
check('moved exact topology does not retain complete persistent identity',
  movedTopology.namedFaces === movedTopology.faces
  && movedTopology.namedEdges === movedTopology.edges
  && movedTopology.namedVertices === movedTopology.vertices);

expectCode('missing curve', () => pierceTools.resolveStudioV5PierceTarget(moved, part.id, { ...constrained.constraints[0], curveSketchId: 'missing-path' }), 'SKETCH_PIERCE_REFERENCE_MISSING');
const ambiguous = structuredClone(moved);
ambiguous.partDefinitions[0].sketches[0].entities[0].points = [[-1, 0, -1], [0, 0, 1], [1, 0, -1]];
expectCode('ambiguous intersections', () => pierceTools.resolveStudioV5PierceTarget(ambiguous, part.id, constrained.constraints[0]), 'SKETCH_PIERCE_AMBIGUOUS');
const coincident = structuredClone(moved);
coincident.partDefinitions[0].sketches[0].entities[0].points = [[0, 0, 0], [1, 0, 0]];
expectCode('coincident path segment', () => pierceTools.resolveStudioV5PierceTarget(coincident, part.id, constrained.constraints[0]), 'SKETCH_PIERCE_COINCIDENT_CURVE');
let guardedDelete = '';
try { runtime.deleteStudioV5AdvancedSketch(moved, 'path-pierce'); } catch (error: any) { guardedDelete = String(error?.message || error); }
check('referenced Pierce path could be deleted', guardedDelete.includes('Pierce-driven extrusion'));

const editorSource = { entities: [{ id: 'editor-point', kind: 'point', at: [3, 3] }], constraints: [] };
const editorAdded = editor.addSketchConstraint(editorSource, {
  kind: 'pierce', point: 'editor-point', curveSketchId: 'path-pierce', planeDatumId: 'datum-pierce-xy',
}, { resolveDimension: Number, resolvePierce: () => [4, 2] });
check('manual Pierce editor did not author and solve Pierce', editorAdded.constraint.kind === 'pierce'
  && editorAdded.result.status === 'ok'
  && JSON.stringify(editorAdded.result.entities[0].at) === JSON.stringify([4, 2]));
const editorDeleted = editor.deleteSketchConstraint(editorAdded.sketch, { id: editorAdded.constraint.id }, { resolveDimension: Number, resolvePierce: () => [4, 2] });
check('manual Pierce editor did not delete Pierce', editorDeleted.sketch.constraints.length === 0);

const [studioSource, agentSource, buildSource] = await Promise.all([
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
]);
check('visible constraint editor does not expose reference curve and plane selectors',
  studioSource.includes('data-cmeta="curveSketchId"') && studioSource.includes('data-cmeta="planeDatumId"')
  && studioSource.includes('data-v6-control-id="sketch.constraint.pierce"'));
check('typed constrained-sketch schema does not expose Pierce', agentSource.includes("'pointOnCircle', 'pierce', 'symmetric'")
  && agentSource.includes('curveSketchId: ID_SCHEMA, planeDatumId: ID_SCHEMA'));
check('Pierce resolver is not release packaged', buildSource.includes("'studio-sketch-pierce.js'"));
const control = registryTools.cadUiControlRegistry().find((entry: JsonRecord) => entry.id === 'sketch.constraint.pierce');
check('typed UI registry does not expose Pierce selector', control?.kind === 'field' && control?.permission === 'ui.command-draft');

console.log(JSON.stringify({
  schema: movedEvidence.schema,
  initialIntersection: initialEvidence.worldPoint,
  movedIntersection: movedEvidence.worldPoint,
  fullyDefined: movedSolved.dof === 0,
  exactBounds: { initial: initialExact.bodies[0].geometry.bounds, moved: movedExact.bodies[0].geometry.bounds },
  exactVolume: movedExact.bodies[0].geometry.volume,
  topology: {
    faces: movedTopology.faces,
    edges: movedTopology.edges,
    vertices: movedTopology.vertices,
  },
  saveReopen: 'preserved',
  whereUsed: dependencies.items.map((edge: JsonRecord) => `${edge.from.kind}:${edge.from.id}>${edge.relation}>${edge.to.kind}:${edge.to.id}`),
  failClosed: ['missing-curve', 'ambiguous-intersection', 'coincident-segment', 'referenced-delete'],
}, null, 2));

process.exit(0);
