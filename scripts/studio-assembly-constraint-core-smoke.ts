import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-assembly-constraint-core.js')).href;
const { solveAssemblyConstraintSystem } = await import(moduleUrl) as any;
const assemblyModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-v5-assembly.js')).href;
const { solveStudioV5Assembly } = await import(assemblyModuleUrl) as any;

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translated = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const frame = (direction: number[], xDirection: number[]) => ({ origin: [0, 0, 0], direction, xDirection });
const analyticFrame = (
  direction: number[],
  xDirection: number[],
  origin: number[] = [0, 0, 0],
  geometryKind = 'plane',
) => ({ geometryKind, origin, direction, xDirection });
const rotatedX = (degrees: number, x = 0, y = 0, z = 0) => {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [1, 0, 0, 0, 0, cosine, sine, 0, 0, -sine, cosine, 0, x, y, z, 1];
};
const rotatedZ = (degrees: number, x = 0, y = 0, z = 0) => {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [cosine, sine, 0, 0, -sine, cosine, 0, 0, 0, 0, 1, 0, x, y, z, 1];
};
const transformedDirection = (matrix: number[], direction: number[]) => {
  const result = [
    matrix[0]! * direction[0]! + matrix[4]! * direction[1]! + matrix[8]! * direction[2]!,
    matrix[1]! * direction[0]! + matrix[5]! * direction[1]! + matrix[9]! * direction[2]!,
    matrix[2]! * direction[0]! + matrix[6]! * direction[1]! + matrix[10]! * direction[2]!,
  ];
  const size = Math.hypot(...result);
  return result.map((value) => value / size);
};
const angleDegrees = (left: number[], right: number[]) => Math.acos(Math.max(-1, Math.min(1,
  left.reduce((total, value, index) => total + value * right[index]!, 0),
))) * 180 / Math.PI;
const occurrences = [
  { id: 'ground', transform: identity, fixed: true },
  { id: 'moving', transform: translated(8, -5, 11), fixed: false },
];
const coincident = (id: string, direction: number[], xDirection: number[]) => ({
  id,
  kind: 'coincident',
  occurrenceIds: ['ground', 'moving'],
  frames: [frame(direction, xDirection), frame(direction, xDirection)],
});
const fullMates = [
  coincident('plane-z', [0, 0, 1], [1, 0, 0]),
  coincident('plane-x', [1, 0, 0], [0, 1, 0]),
  coincident('plane-y', [0, 1, 0], [0, 0, 1]),
];

const solved = solveAssemblyConstraintSystem({ occurrences, mates: fullMates });
assert.equal(solved.state, 'fully-constrained');
assert.equal(solved.satisfied, true);
assert.equal(solved.rank, 6);
assert.equal(solved.degreesOfFreedom.get('moving'), 0);
assert.deepEqual(solved.conflicts, []);
assert.ok(Math.hypot(...solved.transforms.get('moving').slice(12, 15)) < 1e-7);

const reversed = solveAssemblyConstraintSystem({ occurrences, mates: [...fullMates].reverse() });
assert.equal(reversed.state, 'fully-constrained');
assert.deepEqual(
  reversed.transforms.get('moving').map((value: number) => Math.round(value * 1e8) / 1e8),
  solved.transforms.get('moving').map((value: number) => Math.round(value * 1e8) / 1e8),
  'simultaneous solve changed when mate declaration order changed',
);

const widthInput = {
  occurrences: [
    { id: 'width-owner', transform: identity, fixed: true },
    { id: 'width-follower', transform: rotatedX(25, 4, -3, 7), fixed: false },
  ],
  mates: [{
    id: 'advanced-width',
    kind: 'width',
    occurrenceIds: ['width-owner', 'width-follower'],
    frames: [
      analyticFrame([0, 0, 1], [1, 0, 0]),
      analyticFrame([0, 0, 1], [1, 0, 0]),
    ],
  }],
};
const widthSolved = solveAssemblyConstraintSystem(widthInput);
assert.equal(widthSolved.satisfied, true, 'width mate did not solve its derived center planes');
assert.equal(widthSolved.rank, 3, 'width mate must constrain one station and two direction rotations');
assert.equal(widthSolved.degreesOfFreedom.get('width-follower'), 3);
const widthTransform = widthSolved.transforms.get('width-follower');
assert.ok(Math.abs(widthTransform[14]) < 1e-7, 'width mate did not center the derived plane station');
assert.ok(angleDegrees([0, 0, 1], transformedDirection(widthTransform, [0, 0, 1])) < 1e-5,
  'width mate did not align the center plane directions');

const widthAntiparallelInput = structuredClone(widthInput);
widthAntiparallelInput.mates[0]!.frames[1]!.origin = [0, 100, 5];
widthAntiparallelInput.occurrences[1]!.transform = rotatedX(180, 4, -3, 5);
const widthAntiparallel = solveAssemblyConstraintSystem(widthAntiparallelInput);
assert.equal(widthAntiparallel.satisfied, true,
  'width mate did not escape an exactly antiparallel direction state');
assert.deepEqual(widthAntiparallel.conflicts, [],
  'feasible antiparallel width state was falsely classified as a conflict');
assert.ok(angleDegrees(
  [0, 0, 1],
  transformedDirection(widthAntiparallel.transforms.get('width-follower'), [0, 0, 1]),
) < 1e-5, 'antiparallel width direction did not converge to alignment');

const symmetryInput = {
  occurrences: [
    { id: 'symmetry-first', transform: translated(-2, 1, 0), fixed: true },
    { id: 'symmetry-second', transform: rotatedZ(120, 7, 4, 3), fixed: false },
    { id: 'symmetry-plane', transform: identity, fixed: true },
  ],
  mates: [{
    id: 'advanced-symmetry',
    kind: 'symmetry',
    occurrenceIds: ['symmetry-first', 'symmetry-second', 'symmetry-plane'],
    frames: [
      analyticFrame([1, 0, 0], [0, 1, 0]),
      analyticFrame([1, 0, 0], [0, 1, 0]),
      analyticFrame([1, 0, 0], [0, 1, 0]),
    ],
  }],
};
const symmetrySolved = solveAssemblyConstraintSystem(symmetryInput);
assert.equal(symmetrySolved.satisfied, true, 'symmetry mate did not solve the reflected frame');
assert.equal(symmetrySolved.rank, 5, 'symmetry mate must preserve only twist about the reflected direction');
assert.equal(symmetrySolved.degreesOfFreedom.get('symmetry-second'), 1);
const symmetryTransform = symmetrySolved.transforms.get('symmetry-second');
assert.ok(Math.hypot(symmetryTransform[12] - 2, symmetryTransform[13] - 1, symmetryTransform[14]) < 1e-7,
  'symmetry mate did not reflect the first frame origin through the plane');
assert.ok(angleDegrees([-1, 0, 0], transformedDirection(symmetryTransform, [1, 0, 0])) < 1e-5,
  'symmetry mate did not reflect the first frame direction through the plane');

const symmetryAntiparallelInput = structuredClone(symmetryInput);
symmetryAntiparallelInput.occurrences[1]!.transform = translated(2, 1, 0);
const symmetryAntiparallel = solveAssemblyConstraintSystem(symmetryAntiparallelInput);
assert.equal(symmetryAntiparallel.satisfied, true,
  'symmetry mate did not escape an exactly antiparallel reflected direction state');
assert.deepEqual(symmetryAntiparallel.conflicts, [],
  'feasible antiparallel symmetry state was falsely classified as a conflict');
assert.ok(angleDegrees(
  [-1, 0, 0],
  transformedDirection(symmetryAntiparallel.transforms.get('symmetry-second'), [1, 0, 0]),
) < 1e-5, 'antiparallel symmetry direction did not converge to the reflected direction');

const pathInput = {
  occurrences: [
    { id: 'path-owner', transform: identity, fixed: true },
    { id: 'path-follower', transform: translated(5, 3, 2), fixed: false },
  ],
  mates: [{
    id: 'advanced-path',
    kind: 'path',
    occurrenceIds: ['path-owner', 'path-follower'],
    frames: [
      analyticFrame([0, 0, 1], [1, 0, 0]),
      analyticFrame([0, 0, 1], [1, 0, 0]),
    ],
    path: {
      segments: [
        { kind: 'line', points: [[-20, 0, 0], [-10, 0, 0]] },
        { kind: 'cubic-bezier', points: [[0, 0, 0], [0, 4, 0], [10, 4, 0], [10, 0, 0]] },
      ],
    },
  }],
};
const pathSolved = solveAssemblyConstraintSystem(pathInput);
assert.equal(pathSolved.satisfied, true, 'path mate did not project onto the exact cubic span');
assert.equal(pathSolved.rank, 2, 'interior path Jacobian must preserve travel along the curve');
assert.equal(pathSolved.degreesOfFreedom.get('path-follower'), 4,
  'path mate must preserve one path-translation and three rotation freedoms');
const pathTransform = pathSolved.transforms.get('path-follower');
assert.ok(Math.hypot(pathTransform[12] - 5, pathTransform[13] - 3, pathTransform[14]) < 1e-7,
  'path mate did not settle on the exact cubic point at t=0.5');

const linePathInput = {
  occurrences: [
    { id: 'line-path-owner', transform: identity, fixed: true },
    { id: 'line-path-follower', transform: translated(4, 2, -3), fixed: false },
  ],
  mates: [{
    id: 'advanced-line-path',
    kind: 'path',
    occurrenceIds: ['line-path-owner', 'line-path-follower'],
    frames: [analyticFrame([0, 0, 1], [1, 0, 0]), analyticFrame([0, 0, 1], [1, 0, 0])],
    path: { segments: [{ kind: 'line', points: [[0, 0, 0], [10, 0, 0]] }] },
  }],
};
const linePathSolved = solveAssemblyConstraintSystem(linePathInput);
assert.equal(linePathSolved.rank, 2, 'interior exact-line path travel was over-constrained');
assert.ok(Math.hypot(
  linePathSolved.transforms.get('line-path-follower')[12] - 4,
  linePathSolved.transforms.get('line-path-follower')[13],
  linePathSolved.transforms.get('line-path-follower')[14],
) < 1e-7, 'line path did not preserve its free axial station');

const couplerInput = {
  occurrences: [
    { id: 'coupler-owner', transform: identity, fixed: true },
    { id: 'coupler-follower', transform: translated(8, 0, 0), fixed: false },
  ],
  mates: [{
    id: 'advanced-linear-coupler',
    kind: 'linear-coupler',
    occurrenceIds: ['coupler-owner', 'coupler-follower'],
    frames: [
      analyticFrame([1, 0, 0], [0, 1, 0], [10, 0, 0]),
      analyticFrame([1, 0, 0], [0, 1, 0]),
    ],
    advanced: { ratio: 2, offset: 4 },
  }],
};
const couplerSolved = solveAssemblyConstraintSystem(couplerInput);
assert.equal(couplerSolved.satisfied, true, 'linear coupler equation did not solve');
assert.equal(couplerSolved.rank, 1);
assert.ok(Math.abs(couplerSolved.transforms.get('coupler-follower')[12] - 3) < 1e-7,
  'linear coupler did not enforce qA - ratio*qB - offset');

const distanceLimitInput = (suffix: string, station: number) => ({
  occurrences: [
    { id: `distance-owner-${suffix}`, transform: identity, fixed: true },
    { id: `distance-follower-${suffix}`, transform: translated(0, 0, station), fixed: false },
  ],
  mates: [{
    id: `advanced-limit-distance-${suffix}`,
    kind: 'limit-distance',
    occurrenceIds: [`distance-owner-${suffix}`, `distance-follower-${suffix}`],
    frames: [analyticFrame([0, 0, 1], [1, 0, 0]), analyticFrame([0, 0, 1], [1, 0, 0])],
    advanced: { minimum: 1, maximum: 3 },
  }],
});
const distanceLowerInput = distanceLimitInput('lower', -5);
const distanceUpperInput = distanceLimitInput('upper', 8);
const distanceInactiveInput = distanceLimitInput('inactive', 2);
const distanceLower = solveAssemblyConstraintSystem(distanceLowerInput);
const distanceUpper = solveAssemblyConstraintSystem(distanceUpperInput);
const distanceInactive = solveAssemblyConstraintSystem(distanceInactiveInput);
assert.ok(Math.abs(distanceLower.transforms.get('distance-follower-lower')[14] - 1) < 1e-5,
  'lower distance limit did not activate at its bound');
assert.ok(Math.abs(distanceUpper.transforms.get('distance-follower-upper')[14] - 3) < 1e-5,
  'upper distance limit did not activate at its bound');
assert.equal(distanceInactive.transforms.get('distance-follower-inactive')[14], 2,
  'in-range distance limit changed an admissible placement');
assert.equal(distanceInactive.rank, 0, 'inactive distance limit contributed a constraint row');
assert.deepEqual(distanceInactive.residuals[0].equations, [{ semantic: 'limit-distance', unit: 'linear', residual: 0 }],
  'inactive distance limit did not retain its zero equation row');

const angleLimitInput = (suffix: string, angle: number) => ({
  occurrences: [
    { id: `angle-owner-${suffix}`, transform: identity, fixed: true },
    { id: `angle-follower-${suffix}`, transform: rotatedX(angle), fixed: false },
  ],
  mates: [{
    id: `advanced-limit-angle-${suffix}`,
    kind: 'limit-angle',
    occurrenceIds: [`angle-owner-${suffix}`, `angle-follower-${suffix}`],
    frames: [analyticFrame([0, 0, 1], [1, 0, 0]), analyticFrame([0, 0, 1], [1, 0, 0])],
    advanced: { minimum: 30, maximum: 60 },
  }],
});
const angleLowerInput = angleLimitInput('lower', 10);
const angleUpperInput = angleLimitInput('upper', 80);
const angleInactiveInput = angleLimitInput('inactive', 45);
const angleZeroInput = angleLimitInput('zero', 0);
const angleOpposedInput = angleLimitInput('opposed', 180);
const angleLower = solveAssemblyConstraintSystem(angleLowerInput);
const angleUpper = solveAssemblyConstraintSystem(angleUpperInput);
const angleInactive = solveAssemblyConstraintSystem(angleInactiveInput);
const angleZero = solveAssemblyConstraintSystem(angleZeroInput);
const angleOpposed = solveAssemblyConstraintSystem(angleOpposedInput);
const solvedAngle = (result: any, id: string) => angleDegrees(
  [0, 0, 1],
  transformedDirection(result.transforms.get(id), [0, 0, 1]),
);
assert.ok(Math.abs(solvedAngle(angleLower, 'angle-follower-lower') - 30) < 1e-5,
  'lower angle limit did not activate at its bound');
assert.ok(Math.abs(solvedAngle(angleUpper, 'angle-follower-upper') - 60) < 1e-5,
  'upper angle limit did not activate at its bound');
assert.ok(Math.abs(solvedAngle(angleInactive, 'angle-follower-inactive') - 45) < 1e-10,
  'in-range angle limit changed an admissible orientation');
assert.equal(angleInactive.rank, 0, 'inactive angle limit contributed a constraint row');
assert.deepEqual(angleInactive.residuals[0].equations, [{ semantic: 'limit-angle', unit: 'angular', residual: 0 }],
  'inactive angle limit did not retain its zero equation row');
assert.ok(Math.abs(solvedAngle(angleZero, 'angle-follower-zero') - 30) < 1e-5,
  'lower angle limit did not activate from an exact zero-degree endpoint');
assert.ok(Math.abs(solvedAngle(angleOpposed, 'angle-follower-opposed') - 60) < 1e-5,
  'upper angle limit did not activate from an exact 180-degree endpoint');
assert.deepEqual(angleZero.conflicts, [],
  'feasible zero-degree angular endpoint was falsely classified as a conflict');
assert.deepEqual(angleOpposed.conflicts, [],
  'feasible 180-degree angular endpoint was falsely classified as a conflict');

const advancedOrderingInputs = [
  widthInput,
  symmetryInput,
  pathInput,
  couplerInput,
  distanceLowerInput,
  angleUpperInput,
];
const advancedOrderingOccurrences = advancedOrderingInputs.flatMap((entry) => entry.occurrences);
const advancedOrderingMates = advancedOrderingInputs.flatMap((entry) => entry.mates);
const advancedOrdered = solveAssemblyConstraintSystem({
  occurrences: advancedOrderingOccurrences,
  mates: advancedOrderingMates,
});
const advancedReversed = solveAssemblyConstraintSystem({
  occurrences: advancedOrderingOccurrences,
  mates: [...advancedOrderingMates].reverse(),
});
assert.equal(advancedOrdered.satisfied, true, 'combined advanced mate system did not solve');
assert.equal(advancedReversed.satisfied, true, 'reversed advanced mate system did not solve');
for (const occurrence of advancedOrderingOccurrences.filter((entry) => !entry.fixed)) {
  assert.deepEqual(
    advancedReversed.transforms.get(occurrence.id).map((value: number) => Math.round(value * 1e7) / 1e7),
    advancedOrdered.transforms.get(occurrence.id).map((value: number) => Math.round(value * 1e7) / 1e7),
    `advanced simultaneous placement for ${occurrence.id} changed with mate declaration order`,
  );
}

assert.throws(() => solveAssemblyConstraintSystem({
  occurrences: couplerInput.occurrences,
  mates: [{ ...couplerInput.mates[0], advanced: { ratio: 0, offset: 4 } }],
}), /ratio must be finite and nonzero/, 'zero linear-coupler ratio was accepted');
assert.throws(() => solveAssemblyConstraintSystem({
  occurrences: couplerInput.occurrences,
  mates: [{ ...couplerInput.mates[0], advanced: { ratio: 2, offset: null } }],
}), /offset must be finite/, 'non-numeric linear-coupler offset was accepted');
assert.throws(() => solveAssemblyConstraintSystem({
  occurrences: distanceLowerInput.occurrences,
  mates: [{ ...distanceLowerInput.mates[0], advanced: { minimum: 3, maximum: 1 } }],
}), /limits must be ordered/, 'reversed distance limits were accepted');
assert.throws(() => solveAssemblyConstraintSystem({
  occurrences: angleLowerInput.occurrences,
  mates: [{ ...angleLowerInput.mates[0], advanced: { minimum: 0, maximum: 181 } }],
}), /angle limits must stay within 0 through 180/, 'out-of-range angle limits were accepted');
assert.throws(() => solveAssemblyConstraintSystem({
  occurrences: linePathInput.occurrences,
  mates: [{
    ...linePathInput.mates[0],
    path: { segments: [{ kind: 'line', points: [[0, 0, 0], [0, 0, 0]] }] },
  }],
}), /zero length/, 'degenerate exact path geometry was accepted');
assert.throws(() => solveAssemblyConstraintSystem({
  occurrences: widthInput.occurrences,
  mates: [{
    ...widthInput.mates[0],
    frames: [frame([0, 0, 1], [1, 0, 0]), analyticFrame([0, 0, 1], [1, 0, 0])],
  }],
}), /geometryKind must name a supported analytic reference/, 'advanced mate frame without analytic geometry was accepted');

const concentric = {
  id: 'axis-concentric',
  kind: 'concentric',
  occurrenceIds: ['ground', 'moving'],
  frames: [frame([0, 0, 1], [1, 0, 0]), frame([0, 0, 1], [1, 0, 0])],
};
const under = solveAssemblyConstraintSystem({ occurrences, mates: [concentric] });
assert.equal(under.state, 'under-constrained');
assert.equal(under.rank, 4);
assert.equal(under.components[0].degreesOfFreedom, 2);
assert.equal(under.degreesOfFreedom.get('moving'), 2);
assert.deepEqual(under.diagnostics[0].occurrenceIds, ['ground', 'moving']);
assert.equal(Math.abs(under.transforms.get('moving')[12]) < 1e-7, true);
assert.equal(Math.abs(under.transforms.get('moving')[13]) < 1e-7, true);
assert.equal(Math.abs(under.transforms.get('moving')[14] - 11) < 1e-7, true, 'concentric solve changed its free axial station');

const duplicate = solveAssemblyConstraintSystem({
  occurrences,
  mates: [concentric, { ...concentric, id: 'axis-concentric-copy' }],
});
assert.deepEqual(duplicate.redundantMateIds, ['axis-concentric-copy']);
assert.equal(duplicate.rank, 4);

const loopOccurrences = [
  { id: 'loop-ground', transform: identity, fixed: true },
  { id: 'loop-a', transform: translated(9, -4, 7), fixed: false },
  { id: 'loop-b', transform: translated(-6, 8, 3), fixed: false },
];
const loopFrame = (occurrenceId: string, direction: number[], xDirection: number[]) => ({
  occurrenceId,
  origin: [0, 0, 0],
  direction,
  xDirection,
});
const loopCoincident = (
  id: string,
  left: string,
  right: string,
  direction: number[],
  xDirection: number[],
) => ({
  id,
  kind: 'coincident',
  occurrenceIds: [left, right],
  frames: [loopFrame(left, direction, xDirection), loopFrame(right, direction, xDirection)],
});
const loopDirections = [
  { suffix: 'x', direction: [1, 0, 0], xDirection: [0, 1, 0] },
  { suffix: 'y', direction: [0, 1, 0], xDirection: [0, 0, 1] },
  { suffix: 'z', direction: [0, 0, 1], xDirection: [1, 0, 0] },
];
const loopMates = [
  ...loopDirections.map((axis) => loopCoincident(`ab-${axis.suffix}`, 'loop-a', 'loop-b', axis.direction, axis.xDirection)),
  ...loopDirections.map((axis) => loopCoincident(`bg-${axis.suffix}`, 'loop-b', 'loop-ground', axis.direction, axis.xDirection)),
  ...loopDirections.map((axis) => loopCoincident(`ga-${axis.suffix}`, 'loop-ground', 'loop-a', axis.direction, axis.xDirection)),
];
const closedLoop = solveAssemblyConstraintSystem({ occurrences: loopOccurrences, mates: loopMates });
assert.equal(closedLoop.state, 'fully-constrained', 'closed mate loop did not solve simultaneously');
assert.equal(closedLoop.satisfied, true, 'closed mate loop retained a residual');
assert.equal(closedLoop.rank, 12, 'closed mate loop rank is wrong');
assert.equal(closedLoop.components[0].degreesOfFreedom, 0, 'closed mate loop retained mobility');
assert.deepEqual(closedLoop.conflicts, [], 'consistent closed mate loop was reported as conflicting');
assert.deepEqual(closedLoop.redundantMateIds, ['ga-x', 'ga-y', 'ga-z'], 'redundant closing mates are not deterministic');
for (const occurrenceId of ['loop-a', 'loop-b']) {
  assert.ok(Math.hypot(...closedLoop.transforms.get(occurrenceId).slice(12, 15)) < 1e-7,
    `${occurrenceId} did not settle at the exact closed-loop station`);
}
const reversedLoop = solveAssemblyConstraintSystem({ occurrences: loopOccurrences, mates: [...loopMates].reverse() });
assert.deepEqual(reversedLoop.redundantMateIds, closedLoop.redundantMateIds,
  'closed-loop redundancy changed with mate declaration order');
for (const occurrenceId of ['loop-a', 'loop-b']) {
  assert.deepEqual(
    reversedLoop.transforms.get(occurrenceId).map((value: number) => Math.round(value * 1e8) / 1e8),
    closedLoop.transforms.get(occurrenceId).map((value: number) => Math.round(value * 1e8) / 1e8),
    `closed-loop placement for ${occurrenceId} changed with mate declaration order`,
  );
}

const conflict = solveAssemblyConstraintSystem({
  occurrences,
  mates: [
    concentric,
    {
      id: 'station-a', kind: 'distance', value: 2,
      occurrenceIds: ['ground', 'moving'],
      frames: [frame([0, 0, 1], [1, 0, 0]), frame([0, 0, 1], [1, 0, 0])],
    },
    {
      id: 'station-b', kind: 'distance', value: 5,
      occurrenceIds: ['ground', 'moving'],
      frames: [frame([0, 0, 1], [1, 0, 0]), frame([0, 0, 1], [1, 0, 0])],
    },
  ],
});
assert.equal(conflict.state, 'over-constrained');
assert.equal(conflict.satisfied, false);
assert.equal(conflict.solutionAccepted, false);
assert.deepEqual(conflict.transforms.get('moving'), occurrences[1]!.transform,
  'conflicting candidate transform escaped the fail-closed boundary');
assert.deepEqual(conflict.conflicts.map((entry: any) => entry.mateIds), [['station-a', 'station-b']]);
assert.ok(conflict.residuals.find((entry: any) => entry.mateId === 'station-a').maxLinearResidual > 1);
assert.ok(conflict.residuals.find((entry: any) => entry.mateId === 'station-b').maxLinearResidual > 1);

const cappedInput = [
  { id: 'ground', transform: identity, fixed: true },
  { id: 'moving', transform: translated(0, 0, 1000), fixed: false },
];
const capped = solveAssemblyConstraintSystem({
  occurrences: cappedInput,
  mates: [coincident('far-plane', [0, 0, 1], [1, 0, 0])],
}, { maxIterations: 1, maxTranslationStep: 0.001 });
assert.equal(capped.converged, false, 'iteration-limited solve was reported as converged');
assert.equal(capped.solutionAccepted, false, 'iteration-limited candidate transform was accepted');
assert.equal(capped.terminationReason, 'iteration-limit');
assert.ok(capped.maxScaledResidual > 900, 'iteration-limited residual evidence is missing');
assert.deepEqual(capped.transforms.get('moving'), cappedInput[1]!.transform,
  'iteration-limited candidate transform escaped the fail-closed boundary');
const convergenceFailure = capped.diagnostics.find((entry: any) => entry.code === 'ASSEMBLY_CONVERGENCE_FAILED');
assert.equal(convergenceFailure?.solutionAccepted, false, 'convergence diagnostic does not reject the candidate');
assert.equal(convergenceFailure?.iterations, 1, 'convergence diagnostic iteration count is wrong');
assert.equal(convergenceFailure?.iterationLimit, 1, 'convergence diagnostic iteration limit is wrong');

const adapterProject = JSON.parse(readFileSync(
  resolve(process.cwd(), 'tests/assembly-runtime/two-part-constrained.partmode.json'),
  'utf8',
));
const adapterAssembly = adapterProject.assemblyDefinitions[0];
const adapterMoving = adapterAssembly.occurrences.find((entry: any) => entry.id === 'occurrence-moving');
adapterMoving.baseTransform[14] = 100_000;
adapterAssembly.mates = adapterAssembly.mates.filter((entry: any) => entry.id === 'mate-corner-z');
adapterAssembly.mates[0].kind = 'distance';
adapterAssembly.mates[0].value = 0;
const adapterFailure = solveStudioV5Assembly(adapterProject, adapterAssembly.id);
assert.equal(adapterFailure.errors.find((entry: any) => entry.code === 'ASSEMBLY_CONVERGENCE_FAILED')?.solutionAccepted, false,
  'project adapter did not expose the structured convergence failure');
assert.deepEqual(adapterFailure.transforms.get('occurrence-moving'), adapterMoving.baseTransform,
  'project adapter exposed a capped intermediate placement');
assert.equal(adapterFailure.usedLastValid, false, 'cold convergence failure incorrectly claimed last-valid recovery');
assert.equal(adapterFailure.solverDiagnostics.find((entry: any) => entry.code === 'ASSEMBLY_CONVERGENCE_FAILED')?.reason,
  'iteration-limit', 'project adapter lost the convergence termination reason');

assert.throws(() => solveAssemblyConstraintSystem({
  occurrences,
  mates: [{ id: 'bad', kind: 'concentric', occurrenceIds: ['ground', 'moving'], frames: [] }],
}), /requires two resolved local frames/, 'invalid mate references did not fail closed');

const chainSize = 250;
const chainOccurrences = Array.from({ length: chainSize }, (_, index) => ({
  id: `chain-${index}`,
  transform: translated(index, 0, 0),
  fixed: index === 0,
}));
const chainMates = Array.from({ length: chainSize - 1 }, (_, index) => ({
  id: `chain-mate-${String(index).padStart(4, '0')}`,
  kind: 'concentric',
  occurrenceIds: [`chain-${index}`, `chain-${index + 1}`],
  frames: [frame([0, 0, 1], [1, 0, 0]), frame([0, 0, 1], [1, 0, 0])],
}));
const chain = solveAssemblyConstraintSystem({ occurrences: chainOccurrences, mates: chainMates }, { maxIterations: 10 });
assert.equal(chain.rank, 4 * (chainSize - 1), 'large sparse chain rank is wrong');
assert.equal(chain.components[0].degreesOfFreedom, 2 * (chainSize - 1), 'large sparse chain nullity is wrong');
assert.equal(chain.components[0].occurrenceMobilityExact, false, 'large component expanded expensive per-occurrence mobility');
assert.equal(chain.degreesOfFreedom.get('chain-1'), null, 'large-component per-occurrence mobility was guessed');
assert.ok(chain.diagnostics.some((entry: any) => entry.code === 'ASSEMBLY_OCCURRENCE_MOBILITY_DEFERRED'));

console.log(JSON.stringify({
  full: { rank: solved.rank, state: solved.state, iterations: solved.iterations },
  under: { rank: under.rank, dof: under.components[0].degreesOfFreedom },
  redundantMateIds: duplicate.redundantMateIds,
  closedLoop: {
    occurrences: loopOccurrences.length,
    rank: closedLoop.rank,
    dof: closedLoop.components[0].degreesOfFreedom,
    redundantMateIds: closedLoop.redundantMateIds,
  },
  conflictSets: conflict.conflicts.map((entry: any) => entry.mateIds),
  convergenceFailure: {
    reason: convergenceFailure.reason,
    iterations: convergenceFailure.iterations,
    residual: convergenceFailure.maxScaledResidual,
    solutionAccepted: convergenceFailure.solutionAccepted,
    adapterRejectedCandidate: adapterFailure.transforms.get('occurrence-moving')[14] === 100_000,
  },
  advanced: {
    width: {
      rank: widthSolved.rank,
      dof: widthSolved.degreesOfFreedom.get('width-follower'),
      antiparallelSolved: widthAntiparallel.satisfied,
    },
    symmetry: {
      rank: symmetrySolved.rank,
      dof: symmetrySolved.degreesOfFreedom.get('symmetry-second'),
      antiparallelSolved: symmetryAntiparallel.satisfied,
    },
    path: { rank: pathSolved.rank, dof: pathSolved.degreesOfFreedom.get('path-follower') },
    linearCoupler: { rank: couplerSolved.rank },
    distanceLimits: { lower: distanceLower.satisfied, upper: distanceUpper.satisfied, inactiveRank: distanceInactive.rank },
    angleLimits: {
      lower: angleLower.satisfied,
      upper: angleUpper.satisfied,
      exactZero: angleZero.satisfied,
      exactOpposed: angleOpposed.satisfied,
      inactiveRank: angleInactive.rank,
    },
    reversedOrder: advancedReversed.satisfied,
  },
  sparseChain: { occurrences: chainSize, rank: chain.rank, dof: chain.components[0].degreesOfFreedom },
}));
