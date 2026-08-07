import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface PointEntity {
  id: string;
  kind: 'point';
  at: [number, number];
  fixed?: boolean;
}

interface CoincidentConstraint {
  id: string;
  kind: 'coincident';
  a: string;
  b: string;
}

interface SolveResult {
  status: 'ok' | 'invalid' | 'inconsistent';
  entities?: PointEntity[];
  dof?: number;
  diagnostics?: Array<{ code?: string }>;
}

type SolveSketch = (sketch: {
  entities: PointEntity[];
  constraints: CoincidentConstraint[];
}, options?: { tolerance?: number }) => SolveResult;

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Sketch solver smoke failed: ${name}`);
}

function pointAt(result: SolveResult, id: string): [number, number] {
  const point = result.entities?.find((entity) => entity.id === id);
  check(`solved point ${id} is present`, point?.kind === 'point');
  return point.at;
}

const solverUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-sketch-solver.js')).href;
const { solveSketch } = await import(solverUrl) as { solveSketch: SolveSketch };

const conflicting = solveSketch({
  entities: [
    { id: 'fixed-a', kind: 'point', at: [0, 0], fixed: true },
    { id: 'fixed-b', kind: 'point', at: [10, 0], fixed: true },
  ],
  constraints: [{ id: 'coincident-conflict', kind: 'coincident', a: 'fixed-a', b: 'fixed-b' }],
});
check('conflicting fixed points are rejected', conflicting.status === 'invalid' || conflicting.status === 'inconsistent');
check(
  'conflicting fixed points report the dedicated diagnostic',
  conflicting.diagnostics?.some((diagnostic) => diagnostic.code === 'FIXED_COINCIDENT_CONFLICT'),
);

const consistent = solveSketch({
  entities: [
    { id: 'fixed-a', kind: 'point', at: [4, 7], fixed: true },
    { id: 'fixed-b', kind: 'point', at: [4, 7], fixed: true },
  ],
  constraints: [{ id: 'coincident-consistent', kind: 'coincident', a: 'fixed-a', b: 'fixed-b' }],
});
check('consistent fixed coincidence solves', consistent.status === 'ok');
check('consistent fixed coincidence is fully defined', consistent.dof === 0);
check('first consistent fixed point stays fixed', pointAt(consistent, 'fixed-a').join(',') === '4,7');
check('second consistent fixed point stays fixed', pointAt(consistent, 'fixed-b').join(',') === '4,7');

const withinConfiguredTolerance = solveSketch({
  entities: [
    { id: 'fixed-a', kind: 'point', at: [0, 0], fixed: true },
    { id: 'fixed-b', kind: 'point', at: [0.000005, 0], fixed: true },
  ],
  constraints: [{ id: 'coincident-tolerance', kind: 'coincident', a: 'fixed-a', b: 'fixed-b' }],
}, { tolerance: 0.00001 });
check('configured tolerance is respected for fixed coincidence', withinConfiguredTolerance.status === 'ok');
const withinConfiguredToleranceReordered = solveSketch({
  entities: [
    { id: 'fixed-b', kind: 'point', at: [0.000005, 0], fixed: true },
    { id: 'fixed-a', kind: 'point', at: [0, 0], fixed: true },
  ],
  constraints: [{ id: 'coincident-tolerance', kind: 'coincident', a: 'fixed-b', b: 'fixed-a' }],
}, { tolerance: 0.00001 });
check('reordered within-tolerance fixed coincidence solves', withinConfiguredToleranceReordered.status === 'ok');
check(
  'within-tolerance fixed coincidence uses the canonical fixed id in every order',
  JSON.stringify(['fixed-a', 'fixed-b'].map((id) => pointAt(withinConfiguredTolerance, id)))
    === JSON.stringify(['fixed-a', 'fixed-b'].map((id) => pointAt(withinConfiguredToleranceReordered, id))),
);
check('canonical fixed point coordinate wins within tolerance', pointAt(withinConfiguredTolerance, 'fixed-a').join(',') === '0,0');

const ordinary = solveSketch({
  entities: [
    { id: 'anchor', kind: 'point', at: [2, 3], fixed: true },
    { id: 'moving', kind: 'point', at: [9, 11] },
  ],
  constraints: [{ id: 'coincident-ordinary', kind: 'coincident', a: 'anchor', b: 'moving' }],
});
check('ordinary coincidence solves', ordinary.status === 'ok');
check('ordinary coincidence inherits the fixed anchor', pointAt(ordinary, 'moving').join(',') === '2,3');

console.log(JSON.stringify({
  conflicting: { status: conflicting.status, diagnostic: conflicting.diagnostics?.[0]?.code },
  consistent: { status: consistent.status, dof: consistent.dof },
  ordinary: { status: ordinary.status, moving: pointAt(ordinary, 'moving') },
}));
