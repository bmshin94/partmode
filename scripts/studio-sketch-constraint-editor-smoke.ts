import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Sketch constraint editor smoke failed: ${label}`);
}

const point = (id: string, at: [number, number]) => ({ id, kind: 'point', at, fixed: true });
const reuseMetadata = (localPointId = 'p0') => ({
  blockInstances: [{
    id: 'preserved-instance',
    definitionId: 'preserved-definition',
    transform: { translation: [2, 3], angleDeg: 7, scale: 1.25 },
    fixed: false,
  }],
  relations: [{
    id: 'preserved-relation',
    kind: 'coincident',
    a: { entityId: localPointId },
    b: { instanceId: 'preserved-instance', memberId: 'definition-point' },
  }],
});
const reuseState = (sketch: JsonRecord) => JSON.stringify({
  blockInstances: sketch.blockInstances,
  relations: sketch.relations,
  derivedFrom: sketch.derivedFrom,
});
function checkReusePreserved(label: string, source: JsonRecord, result: JsonRecord): void {
  check(`${label} dropped or changed reusable-sketch metadata`, reuseState(result) === reuseState(source));
  for (const field of ['blockInstances', 'relations', 'derivedFrom']) {
    if (source[field] !== undefined) {
      check(`${label} retained a shared ${field} reference`, result[field] !== source[field]);
    }
  }
}
const richSketch = () => ({
  entities: [
    point('p0', [0, 0]),
    point('p0-copy', [0, 0]),
    point('px', [10, 0]),
    point('py', [0, 10]),
    point('p05', [0, 5]),
    point('p105', [10, 5]),
    point('pm', [5, 0]),
    point('p55', [5, 5]),
    point('pcircle', [5, 0]),
    point('ptangent-center', [0, 5]),
    point('pleft', [-2, 3]),
    point('pright', [2, 3]),
    point('axis-a', [0, -5]),
    point('axis-b', [0, 5]),
    { id: 'line-horizontal', kind: 'line', a: 'p0', b: 'px' },
    { id: 'line-horizontal-2', kind: 'line', a: 'p05', b: 'p105' },
    { id: 'line-vertical', kind: 'line', a: 'p0', b: 'py' },
    { id: 'line-axis', kind: 'line', a: 'axis-a', b: 'axis-b' },
    { id: 'circle-5', kind: 'circle', center: 'p0', r: 5 },
    { id: 'circle-3', kind: 'circle', center: 'p0-copy', r: 3 },
    { id: 'circle-tangent', kind: 'circle', center: 'ptangent-center', r: 5 },
  ],
  constraints: [],
  ...reuseMetadata(),
});

const inputs: Record<string, JsonRecord> = {
  coincident: { a: 'p0', b: 'p0-copy' },
  horizontal: { line: 'line-horizontal' },
  vertical: { line: 'line-vertical' },
  parallel: { a: 'line-horizontal', b: 'line-horizontal-2' },
  perpendicular: { a: 'line-horizontal', b: 'line-vertical' },
  tangent: { a: 'line-horizontal', b: 'circle-tangent' },
  equal: { a: 'line-horizontal', b: 'line-horizontal-2' },
  concentric: { a: 'circle-5', b: 'circle-3' },
  midpoint: { point: 'pm', line: 'line-horizontal' },
  pointOnLine: { point: 'pm', line: 'line-horizontal' },
  pointOnCircle: { point: 'pcircle', circle: 'circle-5' },
  pierce: { point: 'p0', curveSketchId: 'path-pierce', planeDatumId: 'datum-origin-xy' },
  symmetric: { a: 'pleft', b: 'pright', axis: 'line-axis' },
  distance: { a: 'p0', b: 'pm', value: 5 },
  horizontalDistance: { a: 'p0', b: 'p55', value: 5 },
  verticalDistance: { a: 'p0', b: 'p55', value: 5 },
  length: { line: 'line-horizontal', value: 10 },
  radius: { circle: 'circle-5', value: 5 },
  angle: { a: 'line-horizontal', b: 'line-vertical', value: 90 },
};

const root = process.cwd();
const module = await import(pathToFileURL(resolve(root, 'src/static/studio-sketch-constraint-edit.js')).href) as any;
const instanceModule = await import(pathToFileURL(resolve(root, 'src/static/studio-sketch-instances.js')).href) as any;
const solver = await import(pathToFileURL(resolve(root, 'src/static/studio-sketch-solver.js')).href) as any;
const kinds = solver.SKETCH_CONSTRAINT_KINDS as string[];
check('editor specs do not exactly cover all 19 solver kinds',
  kinds.length === 19
  && JSON.stringify(module.SKETCH_CONSTRAINT_EDITOR_SPECS.map((entry: JsonRecord) => entry.kind)) === JSON.stringify(kinds));

const evidence: JsonRecord[] = [];
for (const kind of kinds) {
  const source = richSketch();
  const snapshot = JSON.stringify(source);
  const input = { kind, ...inputs[kind] };
  const added = module.addSketchConstraint(source, input, { resolveDimension: Number, resolvePierce: () => [0, 0] });
  check(`${kind} add mutated its source sketch`, JSON.stringify(source) === snapshot);
  check(`${kind} add did not return one exact authored constraint`,
    added.sketch.constraints.length === 1
    && added.constraint.kind === kind
    && added.constraint.id === `constraint-${kind}-1`
    && added.result.status === 'ok');
  check(`${kind} add produced structurally invalid constraint data`,
    solver.validateConstraintSketch(added.sketch).length === 0);
  checkReusePreserved(`${kind} add`, source, added.sketch);
  const reopened = JSON.parse(JSON.stringify(added.sketch));
  check(`${kind} save/reopen changed the constraint`, JSON.stringify(reopened) === JSON.stringify(added.sketch));
  const deleted = module.deleteSketchConstraint(reopened, { id: added.constraint.id }, { resolveDimension: Number, resolvePierce: () => [0, 0] });
  check(`${kind} delete mutated the constrained source`, JSON.stringify(reopened) === JSON.stringify(added.sketch));
  check(`${kind} delete did not remove exactly one constraint`,
    deleted.sketch.constraints.length === 0
    && deleted.constraint.id === added.constraint.id
    && deleted.result.status === 'ok');
  checkReusePreserved(`${kind} delete`, reopened, deleted.sketch);
  evidence.push({ kind, id: added.constraint.id, add: true, delete: true });
}

const derivedSource: JsonRecord = {
  entities: [],
  constraints: [],
  blockInstances: [],
  relations: [{
    id: 'derived-placement', kind: 'horizontal',
    a: { derivedMemberId: 'source-a' }, b: { derivedMemberId: 'source-b' },
  }],
  derivedFrom: {
    sourceSketchId: 'source-sketch',
    transform: { translation: [4, 5], angleDeg: 12 },
  },
};
const derivedSnapshot = JSON.stringify(derivedSource);
const derivedReplacement = instanceModule.replaceStudioSketchMembers(derivedSource, {
  entities: [{ id: 'materialized-point', kind: 'point', at: [8, 9] }],
  constraints: [],
});
check('member replacement mutated a derived source', JSON.stringify(derivedSource) === derivedSnapshot);
checkReusePreserved('direct member replacement', derivedSource, derivedReplacement);
check('member replacement did not install cloned replacement entities',
  derivedReplacement.entities[0]?.id === 'materialized-point'
  && derivedReplacement.entities !== derivedSource.entities);
derivedReplacement.derivedFrom.transform.translation[0] = 400;
derivedReplacement.relations[0].a.derivedMemberId = 'changed-output-only';
check('member replacement leaked nested metadata writes into its source', JSON.stringify(derivedSource) === derivedSnapshot);

for (const [label, source, replacement] of [
  ['unknown source field', { ...richSketch(), unsupportedReuseState: true }, { entities: [], constraints: [] }],
  ['unknown replacement field', richSketch(), { entities: [], constraints: [], unsupportedReplacement: true }],
] as Array<[string, JsonRecord, JsonRecord]>) {
  const snapshot = JSON.stringify(source);
  let code = '';
  try {
    instanceModule.replaceStudioSketchMembers(source, replacement);
  } catch (error) {
    code = (error as { code?: string }).code || '';
  }
  check(`${label} did not fail closed without source mutation`,
    code === 'SKETCH_INSTANCE_INVALID' && JSON.stringify(source) === snapshot);
}

const expressionSketch = richSketch();
const expression = module.addSketchConstraint(expressionSketch, {
  kind: 'length',
  line: 'line-horizontal',
  value: 'scale*2',
}, { resolveDimension: (value: unknown) => value === 'scale*2' ? 10 : Number(value) });
check('driving expression was not preserved verbatim', expression.constraint.value === 'scale*2');

const referenceExpected: Record<string, number> = {
  distance: 5,
  horizontalDistance: 5,
  verticalDistance: 5,
  length: 10,
  radius: 5,
  angle: 90,
};
const referenceEvidence: JsonRecord[] = [];
for (const [kind, expected] of Object.entries(referenceExpected)) {
  const source = richSketch();
  const baseline = solver.solveSketch(source, { resolveDimension: Number });
  const added = module.addSketchConstraint(source, { kind, ...inputs[kind], value: undefined, driving: false }, { resolveDimension: Number });
  const measured = solver.measureSketchDimension(added.sketch, added.constraint, { presolved: added.result });
  check(`${kind} reference dimension stored a driving value`, added.constraint.driving === false && added.constraint.value === undefined);
  check(`${kind} reference dimension measured ${measured} instead of ${expected}`, Math.abs(measured - expected) <= 1e-9);
  check(`${kind} reference dimension changed solver equations or DOF`,
    added.result.equations === baseline.equations
    && added.result.rank === baseline.rank
    && added.result.dof === baseline.dof);
  const reopened = JSON.parse(JSON.stringify(added.sketch));
  const reopenedSolve = solver.solveSketch(reopened, { resolveDimension: Number });
  check(`${kind} reference dimension did not survive save/reopen`,
    reopened.constraints[0].driving === false
    && solver.measureSketchDimension(reopened, reopened.constraints[0], { presolved: reopenedSolve }) === expected);
  referenceEvidence.push({ kind, measured, equationDelta: 0, dofDelta: 0 });
}

const drivenSketch: JsonRecord = {
  entities: [
    { id: 'origin', kind: 'point', at: [0, 0], fixed: true },
    { id: 'end', kind: 'point', at: [9, 0] },
    { id: 'span', kind: 'line', a: 'origin', b: 'end' },
  ],
  constraints: [
    { id: 'span-length', kind: 'length', line: 'span', value: 10 },
    { id: 'span-reference', kind: 'distance', a: 'origin', b: 'end', driving: false },
  ],
  ...reuseMetadata('origin'),
};
const drivenSnapshot = JSON.stringify(drivenSketch);
const beforeDriven = solver.solveSketch(drivenSketch, { resolveDimension: Number });
check('initial driven reference dimension is not 10',
  solver.measureSketchDimension(drivenSketch, drivenSketch.constraints[1], { presolved: beforeDriven }) === 10);
const editedDriving = module.updateSketchDrivingDimension(drivenSketch, { id: 'span-length' }, 14, { resolveDimension: Number });
check('driving-dimension edit mutated its source sketch', JSON.stringify(drivenSketch) === drivenSnapshot);
check('driving-dimension edit did not preserve the reference record',
  editedDriving.sketch.constraints[1].driving === false && editedDriving.sketch.constraints[1].value === undefined);
check('reference dimension did not follow edited solved geometry',
  solver.measureSketchDimension(editedDriving.sketch, editedDriving.sketch.constraints[1], { presolved: editedDriving.result }) === 14);
checkReusePreserved('driving-dimension edit', drivenSketch, editedDriving.sketch);
check('driving-dimension edit changed the reference equation or DOF invariant',
  editedDriving.result.equations === beforeDriven.equations
  && editedDriving.result.rank === beforeDriven.rank
  && editedDriving.result.dof === beforeDriven.dof);

let referenceEditFailure = '';
try {
  module.updateSketchDrivingDimension(drivenSketch, { id: 'span-reference' }, 20, { resolveDimension: Number });
} catch (error) {
  referenceEditFailure = (error as { code?: string }).code || '';
}
check('reference dimension was editable as a driver', referenceEditFailure === 'SKETCH_CONSTRAINT_NOT_DRIVING_DIMENSION');

const anchorSketch: JsonRecord = {
  entities: [
    { id: 'anchor-a', kind: 'point', at: [0, 0] },
    { id: 'anchor-b', kind: 'point', at: [10, 1] },
    { id: 'anchor-line', kind: 'line', a: 'anchor-a', b: 'anchor-b' },
  ],
  constraints: [{ id: 'anchor-horizontal', kind: 'horizontal', line: 'anchor-line' }],
  ...reuseMetadata('anchor-a'),
};
const anchorSnapshot = JSON.stringify(anchorSketch);
const anchorBefore = solver.solveSketch(anchorSketch, { resolveDimension: Number });
const fixedPoint = module.setSketchPointFixed(anchorSketch, 'anchor-a', true, { resolveDimension: Number });
check('fix point mutated its source sketch', JSON.stringify(anchorSketch) === anchorSnapshot);
check('fix point did not pin the currently solved coordinate',
  fixedPoint.point.fixed === true
  && JSON.stringify(fixedPoint.point.at) === JSON.stringify(anchorBefore.entities.find((entity: JsonRecord) => entity.id === 'anchor-a')?.at));
check('fix point did not remove exactly two translational DOF', fixedPoint.result.dof === anchorBefore.dof - 2);
checkReusePreserved('fix point', anchorSketch, fixedPoint.sketch);
const releasedPoint = module.setSketchPointFixed(fixedPoint.sketch, 'anchor-a', false, { resolveDimension: Number });
check('unfix point did not restore its two translational DOF', !releasedPoint.point.fixed && releasedPoint.result.dof === anchorBefore.dof);
checkReusePreserved('unfix point', fixedPoint.sketch, releasedPoint.sketch);

const mergeSketch: JsonRecord = {
  entities: [
    { id: 'tri-a', kind: 'point', at: [0, 0], fixed: true },
    { id: 'tri-b-keep', kind: 'point', at: [10, 0] },
    { id: 'tri-b-remove', kind: 'point', at: [10, 0] },
    { id: 'tri-c', kind: 'point', at: [0, 10] },
    { id: 'tri-ab', kind: 'line', a: 'tri-a', b: 'tri-b-keep' },
    { id: 'tri-bc', kind: 'line', a: 'tri-b-remove', b: 'tri-c' },
    { id: 'tri-ca', kind: 'line', a: 'tri-c', b: 'tri-a' },
  ],
  constraints: [{ id: 'tri-join', kind: 'coincident', a: 'tri-b-keep', b: 'tri-b-remove' }],
  ...reuseMetadata('tri-b-remove'),
};
const mergeSnapshot = JSON.stringify(mergeSketch);
const mergedPoints = module.mergeSketchPoints(mergeSketch, 'tri-b-keep', 'tri-b-remove', { resolveDimension: Number });
check('merge points mutated its source sketch', JSON.stringify(mergeSketch) === mergeSnapshot);
check('merge points did not remove exactly one point and its redundant coincidence',
  mergedPoints.sketch.entities.length === mergeSketch.entities.length - 1
  && mergedPoints.sketch.constraints.length === 0
  && JSON.stringify(mergedPoints.droppedConstraintIds) === JSON.stringify(['tri-join']));
check('merge points left a dangling removed point reference', !JSON.stringify(mergedPoints.sketch).includes('tri-b-remove'));
check('merge points did not rewrite a reusable placement relation to the retained point',
  mergedPoints.sketch.relations[0]?.a?.entityId === 'tri-b-keep');
check('merge points dropped or shared reusable block metadata',
  JSON.stringify(mergedPoints.sketch.blockInstances) === JSON.stringify(mergeSketch.blockInstances)
  && mergedPoints.sketch.blockInstances !== mergeSketch.blockInstances
  && mergedPoints.sketch.relations !== mergeSketch.relations);
const mergedLoop = solver.constraintSketchToLoops(mergedPoints.sketch, { presolved: mergedPoints.result });
check('merge points broke the closed profile topology', mergedLoop.status === 'ok' && mergedLoop.loops.length === 1);
const mergedReopened = JSON.parse(JSON.stringify(mergedPoints.sketch));
check('merged topology did not survive save/reopen',
  solver.solveSketch(mergedReopened, { resolveDimension: Number }).status === 'ok'
  && !JSON.stringify(mergedReopened).includes('tri-b-remove'));

for (const [label, sketch, keepPointId, removePointId, code] of [
  ['same point', mergeSketch, 'tri-b-keep', 'tri-b-keep', 'SKETCH_POINT_MERGE_SAME'],
  ['line collapse', { entities: [{ id: 'a', kind: 'point', at: [0, 0] }, { id: 'b', kind: 'point', at: [1, 0] }, { id: 'ab', kind: 'line', a: 'a', b: 'b' }], constraints: [] }, 'a', 'b', 'SKETCH_CONSTRAINT_STRUCTURE_INVALID'],
  ['fixed conflict', { entities: [{ id: 'a', kind: 'point', at: [0, 0], fixed: true }, { id: 'b', kind: 'point', at: [1, 0], fixed: true }], constraints: [] }, 'a', 'b', 'SKETCH_POINT_MERGE_FIXED_CONFLICT'],
] as Array<[string, JsonRecord, string, string, string]>) {
  const snapshot = JSON.stringify(sketch);
  let actual = '';
  try {
    module.mergeSketchPoints(sketch, keepPointId, removePointId, { resolveDimension: Number });
  } catch (error) {
    actual = (error as { code?: string }).code || '';
  }
  check(`${label} merge did not fail closed with ${code}`, actual === code && JSON.stringify(sketch) === snapshot);
}

for (const [label, input, code] of [
  ['unknown kind', { kind: 'future-kind' }, 'SKETCH_CONSTRAINT_KIND_UNSUPPORTED'],
  ['wrong operand kind', { kind: 'tangent', a: 'circle-5', b: 'line-horizontal' }, 'SKETCH_CONSTRAINT_OPERAND_INVALID'],
  ['repeated operand', { kind: 'parallel', a: 'line-horizontal', b: 'line-horizontal' }, 'SKETCH_CONSTRAINT_OPERANDS_NOT_DISTINCT'],
  ['reference on geometric constraint', { kind: 'horizontal', line: 'line-horizontal', driving: false }, 'SKETCH_CONSTRAINT_REFERENCE_INVALID'],
  ['reference with stored value', { kind: 'length', line: 'line-horizontal', value: 10, driving: false }, 'SKETCH_CONSTRAINT_REFERENCE_VALUE_INVALID'],
  ['missing value', { kind: 'length', line: 'line-horizontal' }, 'SKETCH_CONSTRAINT_VALUE_INVALID'],
  ['conflicting dimension', { kind: 'length', line: 'line-horizontal', value: 11 }, 'SKETCH_CONSTRAINT_SOLVE_FAILED'],
] as Array<[string, JsonRecord, string]>) {
  const source = richSketch();
  const snapshot = JSON.stringify(source);
  let actual = '';
  try {
    module.addSketchConstraint(source, input, { resolveDimension: Number });
  } catch (error) {
    actual = (error as { code?: string }).code || '';
  }
  check(`${label} did not fail closed with ${code}`, actual === code && JSON.stringify(source) === snapshot);
}

let missingDelete = '';
try {
  module.deleteSketchConstraint(richSketch(), { id: 'missing' }, { resolveDimension: Number });
} catch (error) {
  missingDelete = (error as { code?: string }).code || '';
}
check('unknown delete did not fail closed', missingDelete === 'SKETCH_CONSTRAINT_NOT_FOUND');

const invalidReference: JsonRecord = richSketch();
invalidReference.constraints = [{ id: 'not-a-dimension', kind: 'horizontal', line: 'line-horizontal', driving: false }];
check('solver accepted a non-dimensional reference constraint',
  solver.validateConstraintSketch(invalidReference).some((diagnostic: JsonRecord) => diagnostic.code === 'REFERENCE_CONSTRAINT_NON_DIMENSIONAL'));

const conflictSource: JsonRecord = richSketch();
conflictSource.constraints = [
  { id: 'bad-length-a', kind: 'length', line: 'line-horizontal', value: 11 },
  { id: 'bad-length-b', kind: 'length', line: 'line-horizontal', value: 12 },
];
const firstRecovery = module.deleteSketchConstraint(conflictSource, { id: 'bad-length-a' }, { resolveDimension: Number });
check('delete blocked stepwise conflict recovery',
  firstRecovery.sketch.constraints.length === 1
  && firstRecovery.constraint.id === 'bad-length-a'
  && firstRecovery.result.status === 'inconsistent');
const completeRecovery = module.deleteSketchConstraint(firstRecovery.sketch, { id: 'bad-length-b' }, { resolveDimension: Number });
check('second delete did not complete conflict recovery',
  completeRecovery.sketch.constraints.length === 0
  && completeRecovery.result.status === 'ok');

const [studio, css, build, registry] = await Promise.all([
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.css'), 'utf8'),
  readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
]);
for (const required of [
  "import('/static/studio-sketch-constraint-edit.js')",
  'data-v6-control-id="sketch.constraint.kind"',
  'data-v6-control-id="sketch.constraint.add"',
  'data-v6-control-id="sketch.constraint.delete"',
  'data-v6-control-id="sketch.constraint.reference"',
  'data-v6-control-id="sketch.constraint.pierce"',
  "solverModule.measureSketchDimension(constrained, constraint, { presolved: solvedConstrained })",
  '<details class="sk-constraint-editor" open>',
  'constraintEditorModule.addSketchConstraint',
  'constraintEditorModule.updateSketchDrivingDimension',
  'constraintEditorModule.setSketchPointFixed',
  'constraintEditorModule.mergeSketchPoints',
  'data-v6-control-id="sketch.point.fixed"',
  'data-v6-control-id="sketch.point.merge"',
  'constraintEditorModule.deleteSketchConstraint',
  'data-cdel',
  // Every constraint row carries its stable constraint id in document order.
  '<div class="sk-constraint-row" data-constraint-id="',
  // The add form owns a visible error region and never refuses silently:
  // every refusal path routes the solver reason through it.
  '<p id="bw-sk-constraint-error" class="sk-constraint-error" role="alert" hidden></p>',
  'const setConstraintFormError = (message) =>',
  "setConstraintFormError('Constraint not added: '",
  // Add-form and row controls carry accessible names.
  'aria-label="Constraint type"',
  'aria-label="Add constraint"',
  '" aria-label="\' + escAttr(operand.label) + \'">',
  'aria-label="\' + escAttr(editorSpec.valueLabel) + \'"',
  'aria-label="Reference only"',
  'aria-label="Reference curve"',
  'aria-label="Sketch plane"',
  'aria-label="Dimension \' + escAttr(labelOf(constraint)) + \'"',
  'aria-label="Delete \' + escAttr(labelOf(constraint)) + \'"',
]) {
  check(`visible editor wiring is missing ${required}`, studio.includes(required));
}
check('the refused-add catch path bypasses the panel error region',
  /catch \(error\) \{\s*setConstraintFormError\('Constraint not added: '/u.test(studio));
check('constraint editor layout is missing', css.includes('.sk-constraint-editor') && css.includes('.sk-constraint-row'));
check('constraint add-form error region layout is missing',
  css.includes('.sk-constraint-error') && css.includes('.sk-constraint-error[hidden]'));
check('constraint editor runtime module is not shipped', build.includes("'studio-sketch-constraint-edit.js'"));
for (const controlId of ['sketch.constraint.kind', 'sketch.constraint.reference', 'sketch.constraint.pierce', 'sketch.constraint.add', 'sketch.constraint.delete', 'sketch.point.fixed', 'sketch.point.merge']) {
  check(`constraint editor control is absent from the source-owned UI inventory: ${controlId}`, registry.includes(`control('${controlId}'`));
}

console.log(JSON.stringify({
  schema: 'partmode.sketch-constraint-editor-smoke/v1',
  manualKinds: evidence,
  count: evidence.length,
  expressionPreserved: true,
  sourceMutationOnFailure: false,
  reusableMetadata: {
    blockInstancesPreserved: true,
    relationsPreserved: true,
    derivedFromPreserved: true,
    deepCloned: true,
    unknownFieldsRejected: true,
  },
  stepwiseConflictRecovery: true,
  referenceDimensions: referenceEvidence,
  drivingEdit: { beforeReference: 10, afterReference: 14, equationDelta: 0, dofDelta: 0 },
  pointOperations: { fix: true, unfix: true, merge: true, closedProfilePreserved: true },
  visibleControls: ['kind', 'operands', 'driving-value', 'reference-only', 'pierce-reference', 'add', 'delete', 'fix-unfix-point', 'merge-points'],
}, null, 2));
