import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type AnyRecord = Record<string, any>;

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Sketch scale smoke failed: ${name}`);
}

const solverUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-sketch-solver.js')).href;
const { solveSketch } = await import(solverUrl) as {
  solveSketch: (sketch: AnyRecord, options?: AnyRecord) => AnyRecord;
};

const lineCount = 250;
const circleCount = 125;
const lineAnchors = Array.from({ length: lineCount }, (_, index) => ({
  id: `scale-anchor-${String(index).padStart(4, '0')}`,
  kind: 'point',
  at: [(index % 25) * 5, Math.floor(index / 25) * 5],
  fixed: true,
}));
const lineEnds = lineAnchors.map((anchor, index) => ({
  id: `scale-end-${String(index).padStart(4, '0')}`,
  kind: 'point',
  at: [anchor.at[0]! + 0.7 + (index % 9) * 0.11, anchor.at[1]! + 0.4],
}));
const lines = lineAnchors.map((anchor, index) => ({
  id: `scale-line-${String(index).padStart(4, '0')}`,
  kind: 'line',
  a: anchor.id,
  b: lineEnds[index]!.id,
}));
const circleCenters = Array.from({ length: circleCount }, (_, index) => ({
  id: `scale-center-${String(index).padStart(4, '0')}`,
  kind: 'point',
  at: [(index % 25) * 5, 60 + Math.floor(index / 25) * 5],
  fixed: true,
}));
const circles = Array.from({ length: circleCount }, (_, index) => ({
  id: `scale-circle-${String(index).padStart(4, '0')}`,
  kind: 'circle',
  center: circleCenters[index]!.id,
  r: 0.5 + (index % 11) * 0.13,
}));
const constraints = [
  ...lines.flatMap((line, index) => [{
    id: `scale-horizontal-${String(index).padStart(4, '0')}`,
    kind: 'horizontal',
    line: line.id,
  }, {
    id: `scale-length-${String(index).padStart(4, '0')}`,
    kind: 'length',
    line: line.id,
    value: 'target_length',
  }]),
  ...circles.map((circle, index) => ({
    id: `scale-radius-${String(index).padStart(4, '0')}`,
    kind: 'radius',
    circle: circle.id,
    value: 'target_radius',
  })),
];
const sketch = { entities: [...lineAnchors, ...lineEnds, ...lines, ...circleCenters, ...circles], constraints };
const expectedRank = lineCount * 2 + circleCount;
const solve = (candidate: AnyRecord) => {
  const started = performance.now();
  const result = solveSketch(candidate, {
    resolveDimension: (value: number | string) =>
      value === 'target_radius' || value === 'target_length' ? 2 : Number(value),
  });
  return { result, milliseconds: performance.now() - started };
};

const forward = solve(sketch);
const reversed = solve({ entities: [...sketch.entities].reverse(), constraints: [...constraints].reverse() });
for (const [label, outcome] of [['forward', forward], ['reversed', reversed]] as const) {
  const { result } = outcome;
  check(`${label} solve succeeds`, result.status === 'ok');
  check(`${label} solve has exact rank`, result.rank === expectedRank);
  check(`${label} solve is fully defined`, result.dof === 0);
  check(`${label} solve has no diagnostics`, result.diagnostics.length === 0);
  check(`${label} solve returns every entity`, result.entities.length === 1000);
  check(`${label} solve reports every entity fully defined`,
    result.entityStates.length === 1000 && result.entityStates.every((entry: AnyRecord) => entry.fullyDefined === true));
  const solvedCircles = result.entities.filter((entity: AnyRecord) => entity.kind === 'circle');
  check(`${label} solve returns every circle`, solvedCircles.length === circleCount);
  check(`${label} solve satisfies every radius exactly`, solvedCircles.every((circle: AnyRecord) => circle.solvedR === 2));
  const solvedPoints = new Map(result.entities
    .filter((entity: AnyRecord) => entity.kind === 'point')
    .map((point: AnyRecord) => [point.id, point.at]));
  check(`${label} solve satisfies every line exactly`, lines.every((line) => {
    const anchor = solvedPoints.get(line.a) as number[] | undefined;
    const end = solvedPoints.get(line.b) as number[] | undefined;
    return anchor && end && Math.abs(end[0]! - anchor[0]! - 2) < 1e-7 && Math.abs(end[1]! - anchor[1]!) < 1e-7;
  }));
  check(`${label} bounded scale gate completes`, outcome.milliseconds < 15_000);
}

const solvedState = (result: AnyRecord) => Object.fromEntries(result.entities
  .filter((entity: AnyRecord) => entity.kind === 'point' || entity.kind === 'circle')
  .map((entity: AnyRecord) => [entity.id, entity.kind === 'point' ? entity.at : entity.solvedR])
  .sort(([left]: [string, unknown], [right]: [string, unknown]) => left.localeCompare(right)));
check('input ordering does not change the exact solution',
  JSON.stringify(solvedState(forward.result)) === JSON.stringify(solvedState(reversed.result)));

console.log(JSON.stringify({
  entities: sketch.entities.length,
  constraints: constraints.length,
  entityKinds: { points: lineAnchors.length + lineEnds.length + circleCenters.length, lines: lines.length, circles: circles.length },
  constraintKinds: { horizontal: lineCount, length: lineCount, radius: circleCount },
  rank: forward.result.rank,
  dof: forward.result.dof,
  iterations: forward.result.iterations,
  milliseconds: {
    forward: Math.round(forward.milliseconds),
    reversed: Math.round(reversed.milliseconds),
  },
  orderIndependent: true,
}));
