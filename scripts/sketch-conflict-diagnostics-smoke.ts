import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type AnyRecord = Record<string, any>;
type SolveSketch = (sketch: AnyRecord, options?: AnyRecord) => AnyRecord;

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Sketch conflict diagnostics smoke failed: ${name}`);
}

function conflictProjection(result: AnyRecord): AnyRecord {
  return {
    status: result.status,
    conflictSets: result.conflictSets,
    diagnostics: (result.diagnostics || []).map((diagnostic: AnyRecord) => ({
      code: diagnostic.code,
      constraintId: diagnostic.constraintId,
      constraintIds: diagnostic.constraintIds,
      minimal: diagnostic.minimal,
    })),
  };
}

function redundancyProjection(result: AnyRecord): AnyRecord {
  return {
    redundantConstraintIds: result.redundantConstraintIds,
    redundancyGroups: result.redundancyGroups,
  };
}

const solverUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-sketch-solver.js')).href;
const { solveSketch } = await import(solverUrl) as { solveSketch: SolveSketch };

const conflictEntities = [
  { id: 'anchor', kind: 'point', at: [0, 0], fixed: true },
  { id: 'moving', kind: 'point', at: [6, 0] },
  { id: 'other-anchor', kind: 'point', at: [20, 20], fixed: true },
  { id: 'other-moving', kind: 'point', at: [20, 24] },
];
const conflictConstraints = [
  { id: 'distance-5', kind: 'horizontalDistance', a: 'anchor', b: 'moving', value: 5 },
  { id: 'distance-7', kind: 'horizontalDistance', a: 'anchor', b: 'moving', value: 7 },
  { id: 'other-distance', kind: 'verticalDistance', a: 'other-anchor', b: 'other-moving', value: 4 },
];
const conflict = solveSketch({ entities: conflictEntities, constraints: conflictConstraints });
check('inconsistent dimensions are rejected', conflict.status === 'inconsistent');
check('one local conflict set is returned', JSON.stringify(conflict.conflictSets) === JSON.stringify([['distance-5', 'distance-7']]));
const conflictDiagnostic = conflict.diagnostics.find((diagnostic: AnyRecord) => diagnostic.code === 'CONSTRAINT_CONFLICT_SET');
check('conflict diagnostic carries exact ids', JSON.stringify(conflictDiagnostic?.constraintIds) === JSON.stringify(['distance-5', 'distance-7']));
check('conflict set is proven inclusion-minimal', conflictDiagnostic?.minimal === true);
check('disconnected constraint is excluded', !conflictDiagnostic?.constraintIds.includes('other-distance'));
check('bounded analysis did not truncate', conflict.conflictAnalysisTruncated === false);

const reorderedConflict = solveSketch({
  entities: [...conflictEntities].reverse(),
  constraints: [...conflictConstraints].reverse(),
});
check(
  'conflict diagnostics are ordering-deterministic',
  JSON.stringify(conflictProjection(reorderedConflict)) === JSON.stringify(conflictProjection(conflict)),
);

const redundantEntities = [
  { id: 'p0', kind: 'point', at: [0, 0], fixed: true },
  { id: 'p1', kind: 'point', at: [3, 2] },
  { id: 'line', kind: 'line', a: 'p0', b: 'p1' },
];
const redundantConstraints = [
  { id: 'horizontal-a', kind: 'horizontal', line: 'line' },
  { id: 'horizontal-b', kind: 'horizontal', line: 'line' },
];
const redundant = solveSketch({ entities: redundantEntities, constraints: redundantConstraints });
check('redundant sketch still solves', redundant.status === 'ok');
check('canonical later duplicate is identified', JSON.stringify(redundant.redundantConstraintIds) === JSON.stringify(['horizontal-b']));
check(
  'redundancy group names both participating constraints',
  JSON.stringify(redundant.redundancyGroups?.[0]?.constraintIds) === JSON.stringify(['horizontal-a', 'horizontal-b']),
);
check('redundancy group is minimal', redundant.redundancyGroups?.[0]?.minimal === true);

const reorderedRedundant = solveSketch({
  entities: [...redundantEntities].reverse(),
  constraints: [...redundantConstraints].reverse(),
});
check(
  'redundancy diagnostics are ordering-deterministic',
  JSON.stringify(redundancyProjection(reorderedRedundant)) === JSON.stringify(redundancyProjection(redundant)),
);

const coincidenceCycle = solveSketch({
  entities: [
    { id: 'a', kind: 'point', at: [0, 0] },
    { id: 'b', kind: 'point', at: [1, 0] },
    { id: 'c', kind: 'point', at: [2, 0] },
  ],
  constraints: [
    { id: 'coincident-ab', kind: 'coincident', a: 'a', b: 'b' },
    { id: 'coincident-bc', kind: 'coincident', a: 'b', b: 'c' },
    { id: 'coincident-ac', kind: 'coincident', a: 'a', b: 'c' },
  ],
});
check('coincidence cycle solves', coincidenceCycle.status === 'ok');
check('coincidence cycle redundancy is explicit', coincidenceCycle.redundantConstraintIds?.length === 1);
check('coincidence cycle set contains all three ids', coincidenceCycle.redundancyGroups?.[0]?.constraintIds?.length === 3);

const withinTolerance = solveSketch({
  entities: conflictEntities.slice(0, 2),
  constraints: [
    { id: 'near-5-a', kind: 'horizontalDistance', a: 'anchor', b: 'moving', value: 5 },
    { id: 'near-5-b', kind: 'horizontalDistance', a: 'anchor', b: 'moving', value: 5.00005 },
  ],
}, { tolerance: 0.0001 });
check('near dimensions solve inside configured tolerance', withinTolerance.status === 'ok');
check('near dimensions do not produce a conflict set', withinTolerance.conflictSets?.length === 0);

const outsideTolerance = solveSketch({
  entities: conflictEntities.slice(0, 2),
  constraints: [
    { id: 'near-5-a', kind: 'horizontalDistance', a: 'anchor', b: 'moving', value: 5 },
    { id: 'near-5-b', kind: 'horizontalDistance', a: 'anchor', b: 'moving', value: 5.00005 },
  ],
}, { tolerance: 0.000001 });
check('same dimensions conflict outside configured tolerance', outsideTolerance.status === 'inconsistent');
check('tight-tolerance conflict names both dimensions', JSON.stringify(outsideTolerance.conflictSets) === JSON.stringify([['near-5-a', 'near-5-b']]));

const fixedCoincident = solveSketch({
  entities: [
    { id: 'fixed-a', kind: 'point', at: [0, 0], fixed: true },
    { id: 'middle', kind: 'point', at: [1, 0] },
    { id: 'fixed-b', kind: 'point', at: [2, 0], fixed: true },
  ],
  constraints: [
    { id: 'path-z', kind: 'coincident', a: 'middle', b: 'fixed-b' },
    { id: 'path-a', kind: 'coincident', a: 'fixed-a', b: 'middle' },
  ],
});
check('fixed coincidence remains fail-closed', fixedCoincident.status === 'invalid');
check('fixed coincidence names its exact constraint path', JSON.stringify(fixedCoincident.conflictSets) === JSON.stringify([['path-a', 'path-z']]));

console.log(JSON.stringify({
  conflictSet: conflict.conflictSets[0],
  redundantConstraintIds: redundant.redundantConstraintIds,
  coincidenceCycleRedundantId: coincidenceCycle.redundantConstraintIds[0],
  tolerance: { within: withinTolerance.status, outside: outsideTolerance.status },
  fixedCoincident: fixedCoincident.conflictSets[0],
}));
