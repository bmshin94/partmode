import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessAgentHost } from '../src/headless/agent-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Studio sketch drag smoke failed: ${label}`);
}

function closeTo(actual: number, expected: number, tolerance = 1e-7): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function expectCode(label: string, expectedCode: string, action: () => unknown): string {
  let actualCode = 'NO_THROW';
  try {
    action();
  } catch (error) {
    actualCode = String((error as { code?: unknown })?.code || 'UNTYPED_ERROR');
  }
  check(`${label} returned ${actualCode} instead of ${expectedCode}`, actualCode === expectedCode);
  return actualCode;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function shuffled<T>(values: T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function percentile(values: number[], fraction: number): number {
  check('latency sample is empty', values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function rounded(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function pointAt(source: JsonRecord, id: string): [number, number] {
  const point = (source.entities || []).find((entity: JsonRecord) => entity.id === id);
  check(`point ${id} is absent`, point?.kind === 'point' && Array.isArray(point.at));
  return point.at;
}

function entityGeometry(source: JsonRecord, prefix = ''): JsonRecord[] {
  return (source.entities || [])
    .filter((entity: JsonRecord) => !prefix || entity.id.startsWith(prefix))
    .map((entity: JsonRecord) => ({
      id: entity.id,
      kind: entity.kind,
      ...(entity.kind === 'point' ? { at: entity.at.map(rounded) } : {}),
      ...(entity.kind === 'circle' ? { r: rounded(Number(entity.r)), solvedR: rounded(Number(entity.solvedR ?? entity.r)) } : {}),
      ...(entity.kind === 'line' ? { a: entity.a, b: entity.b } : {}),
      ...(entity.kind === 'arc' ? { center: entity.center, a: entity.a, b: entity.b } : {}),
    }))
    .sort((left: JsonRecord, right: JsonRecord) => left.id.localeCompare(right.id));
}

function rectangleSketch(width: number, height: number): JsonRecord {
  return {
    entities: [
      { id: 'rect-p1', kind: 'point', at: [0, 0], fixed: true },
      { id: 'rect-p2', kind: 'point', at: [width, 0] },
      { id: 'rect-p3', kind: 'point', at: [width, height] },
      { id: 'rect-p4', kind: 'point', at: [0, height] },
      { id: 'rect-l1', kind: 'line', a: 'rect-p1', b: 'rect-p2' },
      { id: 'rect-l2', kind: 'line', a: 'rect-p2', b: 'rect-p3' },
      { id: 'rect-l3', kind: 'line', a: 'rect-p3', b: 'rect-p4' },
      { id: 'rect-l4', kind: 'line', a: 'rect-p4', b: 'rect-p1' },
    ],
    constraints: [
      { id: 'rect-horizontal-bottom', kind: 'horizontal', line: 'rect-l1' },
      { id: 'rect-vertical-right', kind: 'vertical', line: 'rect-l2' },
      { id: 'rect-horizontal-top', kind: 'horizontal', line: 'rect-l3' },
      { id: 'rect-vertical-left', kind: 'vertical', line: 'rect-l4' },
    ],
  };
}

function rawAxisResidual(sketch: JsonRecord): number {
  const entities = new Map((sketch.entities || []).map((entity: JsonRecord) => [entity.id, entity]));
  let maximum = 0;
  for (const constraint of sketch.constraints || []) {
    if (constraint.kind !== 'horizontal' && constraint.kind !== 'vertical') continue;
    const line = entities.get(constraint.line) as JsonRecord | undefined;
    const a = line ? entities.get(line.a) as JsonRecord | undefined : undefined;
    const b = line ? entities.get(line.b) as JsonRecord | undefined : undefined;
    check(`raw residual cannot resolve ${constraint.id}`, a?.kind === 'point' && b?.kind === 'point');
    maximum = Math.max(maximum, Math.abs(constraint.kind === 'horizontal' ? b.at[1] - a.at[1] : b.at[0] - a.at[0]));
  }
  return maximum;
}

function assertImmutable(
  label: string,
  source: JsonRecord,
  sourceBytes: string,
  constraintBytes: string,
  result: JsonRecord,
): void {
  check(`${label} mutated its source sketch`, JSON.stringify(source) === sourceBytes);
  check(`${label} mutated source constraint bytes`, JSON.stringify(source.constraints || []) === constraintBytes);
  check(`${label} changed authored constraint bytes or order`, JSON.stringify(result.sketch.constraints || []) === constraintBytes);
}

function makeScaleSketch(entityCount: 500 | 1000, seed: number): JsonRecord {
  const random = mulberry32(seed);
  const chainPoints = Array.from({ length: 64 }, (_, index) => ({
    id: `chain-p-${String(index).padStart(3, '0')}`,
    kind: 'point',
    at: [rounded(index * 1.25 + random() * 0.2), 0],
  }));
  const chainLines = Array.from({ length: 63 }, (_, index) => ({
    id: `chain-l-${String(index).padStart(3, '0')}`,
    kind: 'line',
    a: chainPoints[index]!.id,
    b: chainPoints[index + 1]!.id,
  }));
  const constraints = chainLines.map((line, index) => ({
    id: `chain-horizontal-${String(index).padStart(3, '0')}`,
    kind: 'horizontal',
    line: line.id,
  }));

  const fixedEntityCount = entityCount - chainPoints.length - chainLines.length;
  const fixedGroups = Math.floor(fixedEntityCount / 3);
  const fixedEntities: JsonRecord[] = [];
  for (let index = 0; index < fixedGroups; index++) {
    const x = (index % 37) * 4 + random();
    const y = 20 + Math.floor(index / 37) * 4 + random();
    const a = `fixed-a-${String(index).padStart(4, '0')}`;
    const b = `fixed-b-${String(index).padStart(4, '0')}`;
    fixedEntities.push(
      { id: a, kind: 'point', at: [rounded(x), rounded(y)], fixed: true },
      { id: b, kind: 'point', at: [rounded(x + 1 + random()), rounded(y + 0.25 + random())], fixed: true },
      { id: `fixed-line-${String(index).padStart(4, '0')}`, kind: 'line', a, b },
    );
  }
  for (let index = fixedGroups * 3; index < fixedEntityCount; index++) {
    fixedEntities.push({
      id: `fixed-point-${String(index).padStart(4, '0')}`,
      kind: 'point',
      at: [rounded(200 + random() * 20), rounded(20 + random() * 20)],
      fixed: true,
    });
  }
  const entities = [...chainPoints, ...chainLines, ...fixedEntities];
  check(`${entityCount}-entity fixture has ${entities.length} entities`, entities.length === entityCount);
  return { entities, constraints };
}

const root = process.cwd();
const drag = await import(pathToFileURL(resolve(root, 'src/static/studio-sketch-drag.js')).href) as JsonRecord;
const solver = await import(pathToFileURL(resolve(root, 'src/static/studio-sketch-solver.js')).href) as JsonRecord;
const projectModule = await import(pathToFileURL(resolve(root, 'src/static/studio-project-v5.js')).href) as JsonRecord;

const replaySeed = process.env.PARTMODE_SKETCH_DRAG_SEED;
const seed = replaySeed === undefined ? randomBytes(4).readUInt32LE(0) : Number(replaySeed) >>> 0;
check('PARTMODE_SKETCH_DRAG_SEED is not a uint32', replaySeed === undefined || /^\d+$/.test(replaySeed));
console.log(`SK002 runtime-selected seed: ${seed}`);

const dimensionsRandom = mulberry32(seed ^ 0x51_4b_30_32);
const width = 20 + Math.floor(dimensionsRandom() * 20);
const height = 10 + Math.floor(dimensionsRandom() * 15);
const target: [number, number] = [width + 4 + Math.floor(dimensionsRandom() * 8), height + 3 + Math.floor(dimensionsRandom() * 7)];
const rectangle = rectangleSketch(width, height);
const rectangleBytes = JSON.stringify(rectangle);
const rectangleConstraintBytes = JSON.stringify(rectangle.constraints);

// Negative control: changing only the seed coordinate breaks two authored
// constraints. The production operation must propagate through the solver.
const naive = structuredClone(rectangle);
pointAt(naive, 'rect-p3')[0] = target[0];
pointAt(naive, 'rect-p3')[1] = target[1];
check('naive seed-only edit unexpectedly satisfies the rectangle constraints', rawAxisResidual(naive) > 1);

const rectangleSession = drag.beginStudioSketchDrag(rectangle, { kind: 'point', entityId: 'rect-p3' });
check('rectangle drag did not extract all eight connected entities', rectangleSession.componentCounts.entities === 8);
check('drag session source is not recursively frozen',
  Object.isFrozen(rectangleSession.sourceSketch)
  && Object.isFrozen(rectangleSession.sourceSketch.entities)
  && Object.isFrozen(rectangleSession.sourceSketch.constraints));
const rectanglePreview = drag.previewStudioSketchDrag(rectangleSession, target);
const rectangleSettlement = drag.settleStudioSketchDrag(rectangleSession, target);
assertImmutable('rectangle preview', rectangle, rectangleBytes, rectangleConstraintBytes, rectanglePreview);
assertImmutable('rectangle settlement', rectangle, rectangleBytes, rectangleConstraintBytes, rectangleSettlement);
check('point drag did not reach the selected target',
  closeTo(pointAt(rectangleSettlement.sketch, 'rect-p3')[0], target[0])
  && closeTo(pointAt(rectangleSettlement.sketch, 'rect-p3')[1], target[1]));
check('rectangle point drag did not propagate to adjacent corners',
  JSON.stringify(pointAt(rectangleSettlement.sketch, 'rect-p2').map(rounded)) === JSON.stringify([target[0], 0])
  && JSON.stringify(pointAt(rectangleSettlement.sketch, 'rect-p4').map(rounded)) === JSON.stringify([0, target[1]]));
check('settled rectangle does not satisfy its authored constraints', rawAxisResidual(rectangleSettlement.sketch) <= 1e-7);
check('settled point drag omits propagated point evidence',
  ['rect-p2', 'rect-p3', 'rect-p4'].every((id) => rectangleSettlement.affectedPointIds.includes(id)));
const rectangleSolve = solver.solveSketch(rectangleSettlement.sketch);
const rectangleLoops = solver.constraintSketchToLoops(rectangleSettlement.sketch, { presolved: rectangleSolve });
check('settled underdefined rectangle is not one exact closed loop',
  rectangleSolve.status === 'ok' && rectangleSolve.dof > 0
  && rectangleLoops.status === 'ok' && rectangleLoops.loops.length === 1);

const declarationRandom = mulberry32(seed ^ 0xde_c1_a2_e5);
const reorderedRectangle = {
  entities: shuffled(rectangle.entities, declarationRandom),
  constraints: shuffled(rectangle.constraints, declarationRandom),
};
const reorderedRectangleSettlement = drag.settleStudioSketchDrag(
  drag.beginStudioSketchDrag(reorderedRectangle, { kind: 'point', entityId: 'rect-p3' }),
  target,
);
check('rectangle declaration order changed settled geometry',
  JSON.stringify(entityGeometry(reorderedRectangleSettlement.sketch)) === JSON.stringify(entityGeometry(rectangleSettlement.sketch)));
check('rectangle declaration order changed affected ids',
  JSON.stringify(reorderedRectangleSettlement.affectedIds) === JSON.stringify(rectangleSettlement.affectedIds));

const circleSketch: JsonRecord = {
  entities: [
    { id: 'circle-center', kind: 'point', at: [2, 3], fixed: true },
    { id: 'circle-round', kind: 'circle', center: 'circle-center', r: 5 },
  ],
  constraints: [],
};
const circleBytes = JSON.stringify(circleSketch);
const circleConstraintBytes = JSON.stringify(circleSketch.constraints);
const circleTarget = 7 + Math.floor(dimensionsRandom() * 5);
const circleSession = drag.beginStudioSketchDrag(circleSketch, { kind: 'radius', entityId: 'circle-round' });
const circlePreview = drag.previewStudioSketchDrag(circleSession, circleTarget);
const circleSettlement = drag.settleStudioSketchDrag(circleSession, circleTarget);
assertImmutable('circle radius preview', circleSketch, circleBytes, circleConstraintBytes, circlePreview);
assertImmutable('circle radius settlement', circleSketch, circleBytes, circleConstraintBytes, circleSettlement);
const settledCircle = circleSettlement.sketch.entities.find((entity: JsonRecord) => entity.id === 'circle-round');
check('circle radius handle did not author its solved radius',
  closeTo(settledCircle?.r, circleTarget)
  && circleSettlement.affectedRadiusIds.includes('circle-round'));

const arcSketch: JsonRecord = {
  entities: [
    { id: 'arc-center', kind: 'point', at: [0, 0], fixed: true },
    { id: 'arc-a', kind: 'point', at: [6, 0] },
    { id: 'arc-b', kind: 'point', at: [0, 6] },
    { id: 'arc-round', kind: 'arc', center: 'arc-center', a: 'arc-a', b: 'arc-b', ccw: true },
  ],
  constraints: [],
};
const arcBytes = JSON.stringify(arcSketch);
const arcConstraintBytes = JSON.stringify(arcSketch.constraints);
const arcTarget = 9 + Math.floor(dimensionsRandom() * 5);
const arcSession = drag.beginStudioSketchDrag(arcSketch, { kind: 'radius', entityId: 'arc-round' });
const arcPreview = drag.previewStudioSketchDrag(arcSession, arcTarget);
const arcSettlement = drag.settleStudioSketchDrag(arcSession, arcTarget);
assertImmutable('arc radius preview', arcSketch, arcBytes, arcConstraintBytes, arcPreview);
assertImmutable('arc radius settlement', arcSketch, arcBytes, arcConstraintBytes, arcSettlement);
const arcCenter = pointAt(arcSettlement.sketch, 'arc-center');
const arcA = pointAt(arcSettlement.sketch, 'arc-a');
const arcB = pointAt(arcSettlement.sketch, 'arc-b');
check('arc radius handle did not propagate to both arc endpoints',
  closeTo(Math.hypot(arcA[0] - arcCenter[0], arcA[1] - arcCenter[1]), arcTarget)
  && closeTo(Math.hypot(arcB[0] - arcCenter[0], arcB[1] - arcCenter[1]), arcTarget)
  && arcSettlement.affectedIds.includes('arc-round'));

const negativeEvidence = {
  fixed: expectCode('fixed point drag', 'SKETCH_DRAG_HANDLE_FIXED', () => drag.beginStudioSketchDrag({
    entities: [{ id: 'fixed', kind: 'point', at: [0, 0], fixed: true }], constraints: [],
  }, { kind: 'point', entityId: 'fixed' })),
  fullyConstrainedPoint: expectCode('fully constrained point drag', 'SKETCH_DRAG_HANDLE_FULLY_CONSTRAINED', () => drag.beginStudioSketchDrag({
    entities: [
      { id: 'fc-anchor', kind: 'point', at: [0, 0], fixed: true },
      { id: 'fc-point', kind: 'point', at: [5, 4] },
    ],
    constraints: [
      { id: 'fc-x', kind: 'horizontalDistance', a: 'fc-anchor', b: 'fc-point', value: 5 },
      { id: 'fc-y', kind: 'verticalDistance', a: 'fc-anchor', b: 'fc-point', value: 4 },
    ],
  }, { kind: 'point', entityId: 'fc-point' })),
  fullyConstrainedRadius: expectCode('fully constrained radius drag', 'SKETCH_DRAG_HANDLE_FULLY_CONSTRAINED', () => drag.beginStudioSketchDrag({
    entities: [
      { id: 'fc-circle-center', kind: 'point', at: [0, 0], fixed: true },
      { id: 'fc-circle', kind: 'circle', center: 'fc-circle-center', r: 5 },
    ],
    constraints: [{ id: 'fc-radius', kind: 'radius', circle: 'fc-circle', value: 5 }],
  }, { kind: 'radius', entityId: 'fc-circle' })),
  projectedPartialDof: (() => {
    const partialSketch = {
      entities: [
        { id: 'partial-anchor', kind: 'point', at: [0, 0], fixed: true },
        { id: 'partial-point', kind: 'point', at: [5, 1] },
      ],
      constraints: [{ id: 'partial-x', kind: 'horizontalDistance', a: 'partial-anchor', b: 'partial-point', value: 5 }],
    };
    const sourceBytes = JSON.stringify(partialSketch);
    const constraintBytes = JSON.stringify(partialSketch.constraints);
    const session = drag.beginStudioSketchDrag(partialSketch, { kind: 'point', entityId: 'partial-point' });
    const preview = drag.previewStudioSketchDrag(session, [7, 3]);
    const settled = drag.settleStudioSketchDrag(session, [7, 3]);
    assertImmutable('partial-DOF projection preview', partialSketch, sourceBytes, constraintBytes, preview);
    assertImmutable('partial-DOF projection settlement', partialSketch, sourceBytes, constraintBytes, settled);
    check('partial-DOF cursor was not projected onto the authored X constraint',
      preview.targetProjected === true
      && settled.targetProjected === true
      && settled.projection?.method === 'y-axis-driver'
      && JSON.stringify(settled.requestedTarget) === JSON.stringify([7, 3])
      && JSON.stringify(settled.achievedTarget) === JSON.stringify([5, 3])
      && JSON.stringify(pointAt(settled.sketch, 'partial-point')) === JSON.stringify([5, 3]));
    return {
      requestedTarget: settled.requestedTarget,
      achievedTarget: settled.achievedTarget,
      projected: settled.targetProjected,
      method: settled.projection.method,
      sourceUnchanged: JSON.stringify(partialSketch) === sourceBytes,
    };
  })(),
  projectedOrthogonalDof: (() => {
    const partialSketch = {
      entities: [
        { id: 'orthogonal-anchor', kind: 'point', at: [0, 0], fixed: true },
        { id: 'orthogonal-point', kind: 'point', at: [5, 1] },
      ],
      constraints: [{ id: 'orthogonal-y', kind: 'verticalDistance', a: 'orthogonal-anchor', b: 'orthogonal-point', value: 1 }],
    };
    const sourceBytes = JSON.stringify(partialSketch);
    const constraintBytes = JSON.stringify(partialSketch.constraints);
    const session = drag.beginStudioSketchDrag(partialSketch, { kind: 'point', entityId: 'orthogonal-point' });
    const settled = drag.settleStudioSketchDrag(session, [7, 3]);
    assertImmutable('orthogonal partial-DOF projection', partialSketch, sourceBytes, constraintBytes, settled);
    check('orthogonal partial-DOF cursor did not retain its free X coordinate',
      settled.targetProjected === true
      && settled.projection?.method === 'x-axis-driver'
      && JSON.stringify(settled.achievedTarget) === JSON.stringify([7, 1])
      && JSON.stringify(pointAt(settled.sketch, 'orthogonal-point')) === JSON.stringify([7, 1]));
    return {
      requestedTarget: settled.requestedTarget,
      achievedTarget: settled.achievedTarget,
      projected: settled.targetProjected,
      method: settled.projection.method,
      sourceUnchanged: JSON.stringify(partialSketch) === sourceBytes,
    };
  })(),
  projectedTinyFreeAxisMotion: (() => {
    const partialSketch = {
      entities: [
        { id: 'tiny-anchor', kind: 'point', at: [0, 0], fixed: true },
        { id: 'tiny-point', kind: 'point', at: [5, 1] },
      ],
      constraints: [{ id: 'tiny-x', kind: 'horizontalDistance', a: 'tiny-anchor', b: 'tiny-point', value: 5 }],
    };
    const session = drag.beginStudioSketchDrag(partialSketch, { kind: 'point', entityId: 'tiny-point' });
    const settled = drag.settleStudioSketchDrag(session, [15, 1.001]);
    const achieved = pointAt(settled.sketch, 'tiny-point');
    check('small free-axis motion was masked by a much larger locked-axis cursor request',
      settled.targetProjected === true
      && settled.projection?.method === 'y-axis-driver'
      && closeTo(achieved[0], 5)
      && closeTo(achieved[1], 1.001));
    return {
      requestedTarget: settled.requestedTarget,
      achievedTarget: settled.achievedTarget,
      method: settled.projection.method,
    };
  })(),
  unavailableDirection: (() => {
    const partialSketch = {
      entities: [
        { id: 'unavailable-anchor', kind: 'point', at: [0, 0], fixed: true },
        { id: 'unavailable-point', kind: 'point', at: [5, 1] },
      ],
      constraints: [{ id: 'unavailable-x', kind: 'horizontalDistance', a: 'unavailable-anchor', b: 'unavailable-point', value: 5 }],
    };
    const session = drag.beginStudioSketchDrag(partialSketch, { kind: 'point', entityId: 'unavailable-point' });
    return expectCode('cursor motion outside the remaining DOF', 'SKETCH_DRAG_TARGET_UNSATISFIED', () =>
      drag.previewStudioSketchDrag(session, [7, 1]));
  })(),
  nonfinitePoint: expectCode('nonfinite point target', 'SKETCH_DRAG_TARGET_INVALID', () =>
    drag.previewStudioSketchDrag(rectangleSession, [Number.NaN, 0])),
  nonfiniteRadius: expectCode('nonfinite radius target', 'SKETCH_DRAG_TARGET_INVALID', () =>
    drag.previewStudioSketchDrag(circleSession, Number.POSITIVE_INFINITY)),
  expressionRadius: expectCode('authored expression radius drag', 'SKETCH_DRAG_RADIUS_EXPRESSION', () =>
    drag.beginStudioSketchDrag({
      entities: [
        { id: 'expression-center', kind: 'point', at: [0, 0], fixed: true },
        { id: 'expression-circle', kind: 'circle', center: 'expression-center', r: 'diameter / 2' },
      ],
      constraints: [],
    }, { kind: 'radius', entityId: 'expression-circle' }, {
      resolveDimension: (value: unknown) => value === 'diameter / 2' ? 5 : Number(value),
    })),
  presolvedBypassRejected: (() => {
    const presolved = solver.solveSketch(rectangle);
    return expectCode('caller-supplied presolved bypass', 'SKETCH_DRAG_PRESOLVED_UNSUPPORTED', () =>
      drag.beginStudioSketchDrag(rectangle, { kind: 'point', entityId: 'rect-p3' }, {
        presolved,
        presolvedSourceSketch: rectangle,
      }));
  })(),
};

function scaleProfile(entityCount: 500 | 1000, profileSeed: number): JsonRecord {
  const sketch = makeScaleSketch(entityCount, profileSeed);
  const sourceBytes = JSON.stringify(sketch);
  const constraintBytes = JSON.stringify(sketch.constraints);
  const sourceFixedGeometry = JSON.stringify(entityGeometry(sketch, 'fixed-'));
  const handleId = 'chain-p-032';
  const original = pointAt(sketch, handleId);
  const profileRandom = mulberry32(profileSeed ^ 0xa1_17_5c_02);
  const settleTarget: [number, number] = [rounded(original[0] + 2 + profileRandom() * 2), rounded(2 + profileRandom() * 3)];
  const beginStarted = performance.now();
  const session = drag.beginStudioSketchDrag(sketch, { kind: 'point', entityId: handleId });
  const beginMs = performance.now() - beginStarted;
  check(`${entityCount}-entity component is not the 127-entity movable chain`,
    session.componentCounts.entities === 127
    && session.componentCounts.points === 64
    && session.componentCounts.lines === 63
    && session.componentCounts.sourceEntities === entityCount
    && session.componentCounts.constraints === 63);

  const samples: number[] = [];
  let lastPreview: JsonRecord | null = null;
  for (let index = 0; index < 20; index++) {
    const sampleTarget: [number, number] = [
      rounded(original[0] + 0.5 + profileRandom() * 5),
      rounded(0.25 + profileRandom() * 5),
    ];
    const started = performance.now();
    lastPreview = drag.previewStudioSketchDrag(session, sampleTarget);
    samples.push(performance.now() - started);
    check(`${entityCount}-entity preview ${index} missed its runtime-selected target`,
      closeTo(pointAt(lastPreview!.sketch, handleId)[0], sampleTarget[0])
      && closeTo(pointAt(lastPreview!.sketch, handleId)[1], sampleTarget[1]));
  }
  const p95Ms = percentile(samples, 0.95);
  const maxMs = Math.max(...samples);
  check(`${entityCount}-entity repeated preview p95 ${p95Ms.toFixed(1)}ms is not interactive`, p95Ms < 100);
  check(`${entityCount}-entity repeated preview max ${maxMs.toFixed(1)}ms is unbounded`, maxMs < 250);

  const settleStarted = performance.now();
  const settled = drag.settleStudioSketchDrag(session, settleTarget);
  const settleMs = performance.now() - settleStarted;
  assertImmutable(`${entityCount}-entity settlement`, sketch, sourceBytes, constraintBytes, settled);
  check(`${entityCount}-entity settlement changed disconnected fixed geometry`,
    JSON.stringify(entityGeometry(settled.sketch, 'fixed-')) === sourceFixedGeometry);
  check(`${entityCount}-entity chain did not propagate the dragged Y coordinate`,
    Array.from({ length: 64 }, (_, index) => pointAt(settled.sketch, `chain-p-${String(index).padStart(3, '0')}`)[1])
      .every((value) => closeTo(value, settleTarget[1])));

  const orderRandom = mulberry32(profileSeed ^ 0x0d_e2_12_01);
  const reordered = {
    entities: shuffled(sketch.entities, orderRandom),
    constraints: shuffled(sketch.constraints, orderRandom),
  };
  const reorderedSettled = drag.settleStudioSketchDrag(
    drag.beginStudioSketchDrag(reordered, { kind: 'point', entityId: handleId }),
    settleTarget,
  );
  check(`${entityCount}-entity declaration order changed chain geometry`,
    JSON.stringify(entityGeometry(reorderedSettled.sketch, 'chain-')) === JSON.stringify(entityGeometry(settled.sketch, 'chain-')));
  check(`${entityCount}-entity declaration order changed affected ids`,
    JSON.stringify(reorderedSettled.affectedIds) === JSON.stringify(settled.affectedIds));
  check(`${entityCount}-entity begin exceeded its bounded budget (${beginMs.toFixed(1)}ms)`, beginMs < 2_000);
  check(`${entityCount}-entity settlement exceeded its bounded budget (${settleMs.toFixed(1)}ms)`, settleMs < 2_000);
  return {
    entities: entityCount,
    constraints: sketch.constraints.length,
    sourceBytes: Buffer.byteLength(sourceBytes),
    component: session.componentCounts,
    latencyMs: {
      begin: rounded(beginMs),
      previewP50: rounded(percentile(samples, 0.5)),
      previewP95: rounded(p95Ms),
      previewMax: rounded(maxMs),
      settle: rounded(settleMs),
    },
    repeatedPreviews: samples.length,
    declarationOrderDeterministic: true,
    fixedGeometryUnchanged: true,
    previewPhase: lastPreview?.phase,
  };
}

const scaleEvidence = [
  scaleProfile(500, seed ^ 0x50_00_00_01),
  scaleProfile(1000, seed ^ 0x10_00_00_02),
];

function topologySignature(body: JsonRecord): JsonRecord {
  return { solids: body.solids, shells: body.shells, faces: body.faces, edges: body.edges };
}

function sameBounds(actual: number[][], expected: number[][], tolerance = 1e-6): boolean {
  return actual?.length === expected.length && actual.every((axis, axisIndex) =>
    axis.length === expected[axisIndex]!.length
    && axis.every((value, valueIndex) => closeTo(value, expected[axisIndex]![valueIndex]!, tolerance)));
}

function exactBody(response: JsonRecord, label: string): JsonRecord {
  check(`${label} request failed: ${JSON.stringify(response.diagnostics || [])}`, response.status === 'ok');
  const evidence = response.result;
  check(`${label} is not exact current-kernel evidence`,
    evidence?.exactGeometry === true && evidence?.valid === true && evidence.bodies?.length === 1);
  const body = evidence.bodies[0];
  check(`${label} body is not one valid positive-volume solid`,
    body.valid === true && body.solids === 1 && body.volume > 0 && Array.isArray(body.boundingBox));
  return body;
}

const projectId = `sk002-${seed.toString(16).padStart(8, '0')}`;
const featureId = `sk002-extrude-${seed.toString(16).padStart(8, '0')}`;
const depth = 6 + Math.floor(dimensionsRandom() * 5);
const host = await createHeadlessAgentHost({ projectId, name: 'SK002 exact drag acceptance' });
const permissionContext = { granted: ['project.read', 'project.edit'] };
let requestSequence = 0;
const envelope = (payload: JsonRecord, extra: JsonRecord = {}) => ({
  protocol: host.protocol,
  requestId: `sk002-${seed}-${++requestSequence}`,
  sessionId: `sk002-session-${seed}`,
  permissionContext,
  payload,
  ...extra,
});
const request = async (payload: JsonRecord, extra: JsonRecord = {}): Promise<JsonRecord> =>
  await host.request(envelope(payload, extra)) as JsonRecord;

let exactEvidence: JsonRecord;
try {
  const createPreview = await request({
    kind: 'preview',
    transaction: {
      transactionId: `sk002-create-${seed}`,
      label: 'Create constrained SK002 extrusion',
      expectedRevision: 0,
      atomic: true,
      operations: [{
        kind: 'feature.extrude',
        alias: 'createdExtrude',
        input: {
          id: featureId,
          name: 'SK002 constrained extrusion',
          sketch: { constrained: rectangle },
          h: depth,
        },
      }],
    },
  });
  check(`constrained extrude preview failed: ${JSON.stringify(createPreview.diagnostics || [])}`, createPreview.status === 'ok');
  check('constrained extrude preview was not exact-kernel validated',
    createPreview.result?.validation?.exactGeometry === true
    && createPreview.result?.evidence?.bodyResults?.[0]?.valid === true);
  check('create resultRef was not the persistent feature',
    createPreview.result?.changeSet?.aliases?.createdExtrude?.kind === 'feature'
    && createPreview.result.changeSet.aliases.createdExtrude.id === featureId);
  const createCommit = await request(
    { kind: 'commit', previewId: createPreview.result.previewId },
    { expectedRevision: 0 },
  );
  check(`constrained extrude commit failed: ${JSON.stringify(createCommit.diagnostics || [])}`,
    createCommit.status === 'ok' && createCommit.result?.revision === 1 && host.service.revision === 1);

  const beforeExactResponse = await request({ kind: 'query', query: { kind: 'geometry.validity', exact: true } });
  const beforeBody = exactBody(beforeExactResponse, 'pre-drag OCCT validation');
  check('pre-drag OCCT bounds do not match the constrained rectangle',
    sameBounds(beforeBody.boundingBox, [[0, 0, 0], [width, height, depth]]));
  check('pre-drag OCCT volume does not match the constrained rectangle',
    closeTo(beforeBody.volume, width * height * depth, 1e-5));

  const failedSource = JSON.stringify(host.service.snapshot());
  const fixedTyped = await request({
    kind: 'preview',
    transaction: {
      transactionId: `sk002-fixed-negative-${seed}`,
      label: 'Reject fixed typed sketch drag',
      expectedRevision: 1,
      atomic: true,
      operations: [{
        kind: 'sketch.drag',
        input: { featureId, handleKind: 'point', entityId: 'rect-p1', target: [1, 1] },
      }],
    },
  });
  check('typed fixed-point drag did not fail closed',
    fixedTyped.status === 'error'
    && fixedTyped.diagnostics?.[0]?.code === 'SKETCH_DRAG_HANDLE_FIXED'
    && Number(host.service.revision) === 1
    && JSON.stringify(host.service.snapshot()) === failedSource);

  const committedSource = host.service.snapshot() as JsonRecord;
  const committedFeature = committedSource.partDefinitions[0]?.features?.find((feature: JsonRecord) => feature.id === featureId);
  check('committed constrained feature is missing', committedFeature?.sketch?.constrained);
  const typedSourceSketch = structuredClone(committedFeature.sketch.constrained);
  const typedSourceConstraintBytes = JSON.stringify(typedSourceSketch.constraints || []);
  const pureTypedSettlement = drag.settleStudioSketchDrag(
    drag.beginStudioSketchDrag(typedSourceSketch, { kind: 'point', entityId: 'rect-p3' }),
    target,
  );

  const dragPreview = await request({
    kind: 'preview',
    transaction: {
      transactionId: `sk002-drag-${seed}`,
      label: 'Drag constrained feature corner',
      expectedRevision: 1,
      atomic: true,
      operations: [{
        kind: 'sketch.drag',
        alias: 'draggedFeature',
        input: { featureId, handleKind: 'point', entityId: 'rect-p3', target },
      }],
    },
  });
  check(`typed sketch.drag preview failed: ${JSON.stringify(dragPreview.diagnostics || [])}`, dragPreview.status === 'ok');
  const typedResultRef = dragPreview.result?.changeSet?.aliases?.draggedFeature;
  check('typed sketch.drag resultRef does not identify the edited feature',
    typedResultRef?.kind === 'feature' && typedResultRef.id === featureId && typedResultRef.name === committedFeature.name);
  const previewBody = dragPreview.result?.evidence?.bodyResults?.[0];
  check('typed sketch.drag preview lacks exact moved OCCT geometry',
    dragPreview.result?.validation?.exactGeometry === true
    && previewBody?.valid === true
    && sameBounds(previewBody.boundingBox, [[0, 0, 0], [target[0], target[1], depth]]));

  const dragCommit = await request(
    { kind: 'commit', previewId: dragPreview.result.previewId },
    { expectedRevision: 1 },
  );
  check(`typed sketch.drag commit failed: ${JSON.stringify(dragCommit.diagnostics || [])}`,
    dragCommit.status === 'ok' && dragCommit.result?.revision === 2 && Number(host.service.revision) === 2);
  check('committed typed resultRef changed from preview',
    JSON.stringify(dragCommit.result?.changeSet?.aliases?.draggedFeature) === JSON.stringify(typedResultRef));

  const afterSnapshot = host.service.snapshot() as JsonRecord;
  const afterFeature = afterSnapshot.partDefinitions[0]?.features?.find((feature: JsonRecord) => feature.id === featureId);
  check('typed sketch.drag output differs from pure settlement',
    JSON.stringify(afterFeature?.sketch?.constrained) === JSON.stringify(pureTypedSettlement.sketch));
  check('typed sketch.drag changed authored constraint bytes',
    JSON.stringify(afterFeature.sketch.constrained.constraints || []) === typedSourceConstraintBytes);

  const afterExactResponse = await request({ kind: 'query', query: { kind: 'geometry.validity', exact: true } });
  const afterBody = exactBody(afterExactResponse, 'post-drag OCCT validation');
  check('typed sketch.drag did not move both exact body bounds',
    sameBounds(afterBody.boundingBox, [[0, 0, 0], [target[0], target[1], depth]])
    && afterBody.boundingBox[1][0] > beforeBody.boundingBox[1][0]
    && afterBody.boundingBox[1][1] > beforeBody.boundingBox[1][1]);
  check('typed sketch.drag exact volume did not follow the moved profile',
    closeTo(afterBody.volume, target[0] * target[1] * depth, 1e-5)
    && !closeTo(afterBody.volume, beforeBody.volume, 1e-5));
  check('typed sketch.drag changed prism topology counts',
    JSON.stringify(topologySignature(afterBody)) === JSON.stringify(topologySignature(beforeBody)));

  const canonicalText = JSON.stringify(afterSnapshot);
  const reopened = projectModule.parseStudioV5Project(canonicalText);
  check('canonical JSON reopen changed committed document bytes', JSON.stringify(reopened) === canonicalText);
  host.service.synchronize(reopened, 2);
  check('headless host canonical reopen changed committed document bytes', JSON.stringify(host.service.snapshot()) === canonicalText);
  const reopenedExactResponse = await request({ kind: 'query', query: { kind: 'geometry.validity', exact: true } });
  const reopenedBody = exactBody(reopenedExactResponse, 'reopened OCCT validation');
  check('canonical reopen changed exact body bounds', sameBounds(reopenedBody.boundingBox, afterBody.boundingBox));
  check('canonical reopen changed exact body volume', closeTo(reopenedBody.volume, afterBody.volume, 1e-7));
  check('canonical reopen changed exact topology counts',
    JSON.stringify(topologySignature(reopenedBody)) === JSON.stringify(topologySignature(afterBody)));

  exactEvidence = {
    projectId,
    featureId,
    revisions: { create: createCommit.result.revision, drag: dragCommit.result.revision, reopened: host.service.revision },
    resultRef: typedResultRef,
    bounds: { before: beforeBody.boundingBox, after: afterBody.boundingBox, reopened: reopenedBody.boundingBox },
    volume: { before: beforeBody.volume, after: afterBody.volume, reopened: reopenedBody.volume },
    topology: { before: topologySignature(beforeBody), after: topologySignature(afterBody), reopened: topologySignature(reopenedBody) },
    geometryHashChanged: beforeBody.geometryHash !== afterBody.geometryHash,
    pureSettlementMatchesTyped: true,
    canonicalJsonBytes: Buffer.byteLength(canonicalText),
  };
} finally {
  await host.dispose();
}

console.log(JSON.stringify({
  ok: true,
  seed,
  pointDrag: {
    source: { width, height },
    target,
    naiveResidual: rawAxisResidual(naive),
    settledResidual: rawAxisResidual(rectangleSettlement.sketch),
    affected: rectangleSettlement.affectedIds,
    closedLoops: rectangleLoops.loops.length,
    declarationOrderDeterministic: true,
  },
  roundHandles: {
    circle: { target: circleTarget, affected: circleSettlement.affectedIds },
    arc: { target: arcTarget, affected: arcSettlement.affectedIds },
  },
  negativeEvidence,
  scaleEvidence,
  exactEvidence,
}));

// The OCCT module hooks can retain the event loop after their worker exits.
// All evidence is emitted above, so terminate exactly like agent-headless-smoke.
process.exit(0);
