import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ActiveFeatureDescriptor {
  featureId: string;
  signature: string;
}

interface CheckpointDescriptor extends ActiveFeatureDescriptor {
  token: string;
}

interface RebuildPlan {
  reusablePrefixLength: number;
  restoreCheckpoint: CheckpointDescriptor | null;
  reusedFeatureIds: string[];
  evaluatedFeatureIds: string[];
}

interface PlannerError extends Error {
  code: string;
}

interface PlannerModule {
  planStudioFeatureRebuild(active: unknown, prior?: unknown): RebuildPlan;
  StudioFeatureRebuildPlanError: new (message: string) => PlannerError;
}

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-feature-rebuild-plan.js')).href;
const planner = await import(moduleUrl) as PlannerModule;

const feature = (featureId: string, signature = `signature-${featureId}`): ActiveFeatureDescriptor => ({ featureId, signature });
const checkpoint = (featureId: string, signature = `signature-${featureId}`): CheckpointDescriptor => ({
  featureId,
  signature,
  token: `checkpoint-${featureId}`,
});
const active = ['a', 'b', 'c', 'd'].map((id) => feature(id));
const prior = ['a', 'b', 'c', 'd'].map((id) => checkpoint(id));

function expectPlan(
  label: string,
  current: ActiveFeatureDescriptor[],
  previous: unknown,
  expected: {
    prefix: number;
    restoreFeatureId: string | null;
    reused: string[];
    evaluated: string[];
  },
): RebuildPlan {
  const plan = planner.planStudioFeatureRebuild(current, previous);
  assert.equal(plan.reusablePrefixLength, expected.prefix, `${label}: reusable prefix`);
  assert.equal(plan.restoreCheckpoint?.featureId ?? null, expected.restoreFeatureId, `${label}: restore checkpoint`);
  assert.deepEqual(plan.reusedFeatureIds, expected.reused, `${label}: reused features`);
  assert.deepEqual(plan.evaluatedFeatureIds, expected.evaluated, `${label}: evaluated features`);
  return plan;
}

const fullReuse = expectPlan('unchanged history', active, prior, {
  prefix: 4,
  restoreFeatureId: 'd',
  reused: ['a', 'b', 'c', 'd'],
  evaluated: [],
});
assert.equal(fullReuse.restoreCheckpoint, prior[3], 'restore checkpoint preserves the opaque descriptor identity');

expectPlan('upstream signature change', [feature('a', 'changed-a'), ...active.slice(1)], prior, {
  prefix: 0,
  restoreFeatureId: null,
  reused: [],
  evaluated: ['a', 'b', 'c', 'd'],
});

expectPlan('downstream-only signature change', [active[0]!, active[1]!, feature('c', 'changed-c'), active[3]!], prior, {
  prefix: 2,
  restoreFeatureId: 'b',
  reused: ['a', 'b'],
  evaluated: ['c', 'd'],
});

expectPlan('mismatch never jumps to a later match', active, [checkpoint('a', 'changed-a'), ...prior.slice(1)], {
  prefix: 0,
  restoreFeatureId: null,
  reused: [],
  evaluated: ['a', 'b', 'c', 'd'],
});

expectPlan('suppressed feature leaves active list', [active[0]!, active[2]!, active[3]!], prior, {
  prefix: 1,
  restoreFeatureId: 'a',
  reused: ['a'],
  evaluated: ['c', 'd'],
});

expectPlan('rollback shortens active list', active.slice(0, 2), prior, {
  prefix: 2,
  restoreFeatureId: 'b',
  reused: ['a', 'b'],
  evaluated: [],
});

expectPlan('feature insertion', [active[0]!, active[1]!, feature('inserted'), active[2]!, active[3]!], prior, {
  prefix: 2,
  restoreFeatureId: 'b',
  reused: ['a', 'b'],
  evaluated: ['inserted', 'c', 'd'],
});

expectPlan('feature deletion', [active[0]!, active[1]!, active[3]!], prior, {
  prefix: 2,
  restoreFeatureId: 'b',
  reused: ['a', 'b'],
  evaluated: ['d'],
});

expectPlan('new downstream feature', [...active, feature('e')], prior, {
  prefix: 4,
  restoreFeatureId: 'd',
  reused: ['a', 'b', 'c', 'd'],
  evaluated: ['e'],
});

expectPlan('no prior cache', active, undefined, {
  prefix: 0,
  restoreFeatureId: null,
  reused: [],
  evaluated: ['a', 'b', 'c', 'd'],
});

expectPlan('malformed prior sequence fails closed', active, [prior[0], prior[1], { featureId: 'c' }, prior[3]], {
  prefix: 0,
  restoreFeatureId: null,
  reused: [],
  evaluated: ['a', 'b', 'c', 'd'],
});

expectPlan('non-array prior cache fails closed', active, { checkpoints: prior }, {
  prefix: 0,
  restoreFeatureId: null,
  reused: [],
  evaluated: ['a', 'b', 'c', 'd'],
});

expectPlan('duplicate prior feature id fails closed', active, [prior[0], prior[1], checkpoint('b'), prior[3]], {
  prefix: 0,
  restoreFeatureId: null,
  reused: [],
  evaluated: ['a', 'b', 'c', 'd'],
});

const activeSnapshot = JSON.stringify(active);
const priorSnapshot = JSON.stringify(prior);
planner.planStudioFeatureRebuild(active, prior);
assert.equal(JSON.stringify(active), activeSnapshot, 'planner does not mutate active descriptors');
assert.equal(JSON.stringify(prior), priorSnapshot, 'planner does not mutate checkpoint descriptors');

assert.throws(
  () => planner.planStudioFeatureRebuild([feature('a'), feature('a', 'other')], prior),
  (error: unknown) => error instanceof planner.StudioFeatureRebuildPlanError
    && (error as PlannerError).code === 'INVALID_ACTIVE_FEATURE_SEQUENCE',
  'duplicate active feature ids are rejected',
);
assert.throws(
  () => planner.planStudioFeatureRebuild([{ featureId: 'a', signature: '' }], prior),
  (error: unknown) => error instanceof planner.StudioFeatureRebuildPlanError,
  'malformed active feature descriptors are rejected',
);
assert.throws(
  () => planner.planStudioFeatureRebuild(null, prior),
  (error: unknown) => error instanceof planner.StudioFeatureRebuildPlanError,
  'non-array active feature input is rejected',
);

expectPlan('empty active list', [], prior, {
  prefix: 0,
  restoreFeatureId: null,
  reused: [],
  evaluated: [],
});

console.log(JSON.stringify({
  ok: true,
  strictlyContiguous: true,
  malformedPriorFailsClosed: true,
  scenarios: [
    'upstream-change',
    'downstream-only-change',
    'suppression',
    'rollback',
    'insertion',
    'deletion',
    'duplicates',
    'no-prior-cache',
  ],
}));
