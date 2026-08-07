import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonRecord = Record<string, any>;

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-assembly-features.js')).href;
const assemblyFeatures = await import(moduleUrl) as any;
const {
  STUDIO_ASSEMBLY_FEATURES_SCHEMA,
  STUDIO_ASSEMBLY_FEATURE_LIMITS,
  assertStudioAssemblyFeaturesProject,
  createStudioAssemblyFeature,
  updateStudioAssemblyFeature,
  deleteStudioAssemblyFeature,
  studioAssemblyFeatureOccurrenceDependency,
  studioAssemblyFeatureBodyDependencies,
} = assemblyFeatures;

const clone = <T>(value: T): T => structuredClone(value);

function fixture(): JsonRecord {
  return {
    schemaVersion: 5,
    id: 'project-assembly-features',
    rootDocument: { kind: 'assembly', assemblyId: 'assembly-root' },
    partDefinitions: [{
      id: 'part-plate',
      name: 'Shared plate',
      bodies: [{ id: 'body-plate', kind: 'solid', name: 'Plate body', suppressed: false }],
    }],
    assemblyDefinitions: [{
      id: 'assembly-root',
      name: 'Root assembly',
      occurrences: [
        {
          id: 'occurrence-plate-a',
          name: 'Plate A',
          parentOccurrenceId: null,
          definition: { kind: 'part', partId: 'part-plate' },
          suppressed: false,
        },
        {
          id: 'occurrence-plate-b',
          name: 'Plate B',
          parentOccurrenceId: null,
          definition: { kind: 'part', partId: 'part-plate' },
          suppressed: false,
        },
      ],
      mates: [],
      occurrencePatterns: [],
      extensions: { adjacentFixture: { retained: true } },
    }],
  };
}

const firstTarget = () => ({
  occurrenceId: 'occurrence-plate-a',
  partId: 'part-plate',
  bodyId: 'body-plate',
});

const secondTarget = () => ({
  occurrenceId: 'occurrence-plate-b',
  partId: 'part-plate',
  bodyId: 'body-plate',
});

function cutInput(overrides: JsonRecord = {}): JsonRecord {
  return {
    id: 'assembly-cut-main',
    name: 'Main assembly cut',
    kind: 'cut',
    targets: [firstTarget(), secondTarget()],
    origin: [0, 0, 0],
    direction: [0, 0, 4],
    xDirection: [3, 0, 0],
    width: STUDIO_ASSEMBLY_FEATURE_LIMITS.minimumDimensionMm,
    height: 8,
    ...overrides,
  };
}

function holeInput(overrides: JsonRecord = {}): JsonRecord {
  return {
    id: 'assembly-hole-main',
    name: 'Main assembly hole',
    kind: 'hole',
    targets: [firstTarget()],
    origin: [4, -3, 0],
    direction: [0, 0, 2],
    xDirection: [0, 5, 0],
    diameter: 6,
    ...overrides,
  };
}

function without(value: JsonRecord, key: string): JsonRecord {
  const result = clone(value);
  delete result[key];
  return result;
}

function rootAssembly(project: JsonRecord): JsonRecord {
  return project.assemblyDefinitions.find((entry: JsonRecord) => entry.id === project.rootDocument.assemblyId);
}

function store(project: JsonRecord): JsonRecord {
  return rootAssembly(project).extensions.assemblyFeatures;
}

function feature(project: JsonRecord, id: string): JsonRecord {
  return store(project).features.find((entry: JsonRecord) => entry.id === id);
}

function refusal(
  label: string,
  project: JsonRecord,
  action: () => unknown,
  expectedCode: string,
): Error & { code?: string } {
  const before = clone(project);
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `${label} did not fail closed`);
  assert.equal((caught as Error & { code?: string }).code, expectedCode, `${label} returned the wrong typed refusal`);
  assert.deepEqual(project, before, `${label} mutated its caller on failure`);
  return caught as Error & { code?: string };
}

function validationRefusal(
  label: string,
  project: JsonRecord,
  expectedCode: string,
): Error & { code?: string } {
  return refusal(label, project, () => assertStudioAssemblyFeaturesProject(project), expectedCode);
}

function withCut(): JsonRecord {
  const project = fixture();
  createStudioAssemblyFeature(project, cutInput());
  return project;
}

function withHole(): JsonRecord {
  const project = fixture();
  createStudioAssemblyFeature(project, holeInput());
  return project;
}

// Positive create, ordered persistence, canonical orientation, clone isolation,
// save/reopen, update, dependency, and delete behavior.
const lifecycle = fixture();
const authoredCut = cutInput({ origin: [-0, 0, -0], direction: [-0, 0, 4], xDirection: [3, -0, 0] });
const authoredCutSnapshot = clone(authoredCut);
const createdCut = createStudioAssemblyFeature(lifecycle, authoredCut);
assert.deepEqual(authoredCut, authoredCutSnapshot, 'create normalized the caller-owned input object in place');
assert.equal(createdCut.project, lifecycle, 'create did not commit into the caller document');
assert.deepEqual(createdCut.feature.placement, {
  origin: [0, 0, 0],
  direction: [0, 0, 1],
  xDirection: [1, 0, 0],
});
assert.ok(
  [...createdCut.feature.placement.origin, ...createdCut.feature.placement.direction,
    ...createdCut.feature.placement.xDirection].every((value: number) => !Object.is(value, -0)),
  'canonical placement retained signed zero that changes under JSON serialization',
);
assert.deepEqual(createdCut.feature.definition, {
  profile: 'rectangle',
  width: 0.001,
  height: 8,
  extent: 'through-all',
});
assert.equal(createdCut.feature.suppressed, false);
createdCut.feature.name = 'Caller mutation';
assert.equal(feature(lifecycle, 'assembly-cut-main').name, 'Main assembly cut', 'returned feature aliases stored state');

const createdHole = createStudioAssemblyFeature(lifecycle, holeInput({ suppressed: true }));
assert.deepEqual(createdHole.feature.placement, {
  origin: [4, -3, 0],
  direction: [0, 0, 1],
  xDirection: [0, 1, 0],
}, 'hole orientation was not persisted canonically');
assert.equal(createdHole.feature.suppressed, true);
assert.deepEqual(store(lifecycle).features.map((entry: JsonRecord) => entry.id), [
  'assembly-cut-main',
  'assembly-hole-main',
], 'feature history did not preserve authored order');
assertStudioAssemblyFeaturesProject(lifecycle);

const reopened = JSON.parse(JSON.stringify(lifecycle));
assertStudioAssemblyFeaturesProject(reopened);
assert.deepEqual(reopened, lifecycle, 'canonical JSON save/reopen changed assembly feature state');
assert.deepEqual(Object.keys(feature(reopened, 'assembly-hole-main').placement).sort(), [
  'direction', 'origin', 'xDirection',
], 'hole save/reopen lost its deterministic profile frame');

const cutPatch = {
  name: 'Edited assembly cut',
  direction: [0, 4, 0],
  xDirection: [2, 0, 1],
  width: STUDIO_ASSEMBLY_FEATURE_LIMITS.maximumDimensionMm,
  suppressed: true,
};
const cutPatchSnapshot = clone(cutPatch);
const updatedCut = updateStudioAssemblyFeature(lifecycle, 'assembly-cut-main', cutPatch).feature;
assert.deepEqual(cutPatch, cutPatchSnapshot, 'update normalized the caller-owned patch object in place');
assert.equal(updatedCut.id, 'assembly-cut-main');
assert.equal(updatedCut.kind, 'cut');
assert.equal(updatedCut.definition.width, 100_000);
assert.equal(updatedCut.definition.height, 8);
assert.deepEqual(updatedCut.placement.direction, [0, 1, 0]);
assert.deepEqual(updatedCut.placement.xDirection, [2 / Math.sqrt(5), 0, 1 / Math.sqrt(5)]);
assert.equal(updatedCut.suppressed, true);

const updatedHole = updateStudioAssemblyFeature(lifecycle, 'assembly-hole-main', {
  xDirection: [5, 0, 0],
  diameter: 4,
  suppressed: false,
}).feature;
assert.deepEqual(updatedHole.placement.xDirection, [1, 0, 0]);
assert.equal(updatedHole.definition.diameter, 4);
assert.equal(updatedHole.suppressed, false);
assert.deepEqual(studioAssemblyFeatureOccurrenceDependency(rootAssembly(lifecycle), 'occurrence-plate-b'), {
  featureId: 'assembly-cut-main', kind: 'cut',
});
assert.equal(
  studioAssemblyFeatureBodyDependencies(lifecycle, 'part-plate', 'body-plate').length,
  3,
  'definition-body dependency traversal did not retain each explicit occurrence target',
);

const deletedHole = deleteStudioAssemblyFeature(lifecycle, 'assembly-hole-main').feature;
assert.equal(deletedHole.id, 'assembly-hole-main');
deletedHole.name = 'Caller mutation';
assert.deepEqual(store(lifecycle).features.map((entry: JsonRecord) => entry.id), ['assembly-cut-main']);
deleteStudioAssemblyFeature(lifecycle, 'assembly-cut-main');
assert.equal(rootAssembly(lifecycle).extensions.assemblyFeatures, undefined, 'last delete retained an empty feature store');
assert.deepEqual(rootAssembly(lifecycle).extensions.adjacentFixture, { retained: true }, 'last delete removed adjacent extensions');

// Exact family-specific create contracts and primitive type refusal.
const createCases: Array<[string, JsonRecord, string]> = [
  ['cut missing name', without(cutInput(), 'name'), 'ASSEMBLY_FEATURE_RECORD_INVALID'],
  ['cut cross-family diameter', cutInput({ diameter: 4 }), 'ASSEMBLY_FEATURE_RECORD_INVALID'],
  ['hole missing xDirection', without(holeInput(), 'xDirection'), 'ASSEMBLY_FEATURE_RECORD_INVALID'],
  ['hole cross-family width', holeInput({ width: 4 }), 'ASSEMBLY_FEATURE_RECORD_INVALID'],
  ['hole cross-family height', holeInput({ height: 4 }), 'ASSEMBLY_FEATURE_RECORD_INVALID'],
  ['unknown create field', cutInput({ decorativeProof: true }), 'ASSEMBLY_FEATURE_RECORD_INVALID'],
  ['numeric name coercion', cutInput({ name: 42 }), 'ASSEMBLY_FEATURE_NAME_INVALID'],
  ['trimmed name coercion', cutInput({ name: ' Padded name ' }), 'ASSEMBLY_FEATURE_NAME_INVALID'],
  ['numeric-string width coercion', cutInput({ width: '4' }), 'ASSEMBLY_FEATURE_DIMENSION_INVALID'],
  ['numeric-string diameter coercion', holeInput({ diameter: '6' }), 'ASSEMBLY_FEATURE_DIMENSION_INVALID'],
  ['sub-minimum width', cutInput({ width: 0.000999 }), 'ASSEMBLY_FEATURE_DIMENSION_INVALID'],
  ['infinite height', cutInput({ height: Number.POSITIVE_INFINITY }), 'ASSEMBLY_FEATURE_DIMENSION_INVALID'],
  ['non-boolean suppressed', cutInput({ suppressed: 'false' }), 'ASSEMBLY_FEATURE_RECORD_INVALID'],
  ['string vector coordinate', cutInput({ origin: [0, '0', 0] }), 'ASSEMBLY_FEATURE_VECTOR_INVALID'],
  ['parallel cut frame', cutInput({ direction: [0, 0, 1], xDirection: [0, 0, 2] }), 'ASSEMBLY_FEATURE_VECTOR_INVALID'],
  ['parallel hole frame', holeInput({ direction: [0, 1, 0], xDirection: [0, 3, 0] }), 'ASSEMBLY_FEATURE_VECTOR_INVALID'],
  ['target extra key', cutInput({ targets: [{ ...firstTarget(), runtimeBodyId: 'occurrence-plate-a:body-plate' }] }), 'ASSEMBLY_FEATURE_RECORD_INVALID'],
  ['duplicate target', cutInput({ targets: [firstTarget(), firstTarget()] }), 'ASSEMBLY_FEATURE_TARGET_DUPLICATE'],
  ['empty targets', cutInput({ targets: [] }), 'ASSEMBLY_FEATURE_TARGET_INVALID'],
  ['invalid kind', cutInput({ kind: 'pocket' }), 'ASSEMBLY_FEATURE_KIND_INVALID'],
];
for (const [label, input, code] of createCases) {
  const project = fixture();
  refusal(label, project, () => createStudioAssemblyFeature(project, input), code);
}

const tooManyTargets = Array.from(
  { length: STUDIO_ASSEMBLY_FEATURE_LIMITS.targetsPerFeature + 1 },
  (_, index) => ({ ...firstTarget(), occurrenceId: `occurrence-overflow-${index}` }),
);
{
  const project = fixture();
  refusal('target limit', project, () => createStudioAssemblyFeature(project, cutInput({ targets: tooManyTargets })),
    'ASSEMBLY_FEATURE_TARGET_INVALID');
}

// Family-specific patch contracts, semantic no-op refusal, and late failure atomicity.
const updateCases: Array<[string, JsonRecord, string, JsonRecord]> = [
  ['empty patch', withCut(), 'assembly-cut-main', {}],
  ['immutable ID', withCut(), 'assembly-cut-main', { id: 'changed' }],
  ['immutable same kind', withCut(), 'assembly-cut-main', { kind: 'cut' }],
  ['immutable changed kind', withCut(), 'assembly-cut-main', { kind: 'hole' }],
  ['cut cross-family diameter', withCut(), 'assembly-cut-main', { diameter: 5 }],
  ['hole cross-family width', withHole(), 'assembly-hole-main', { width: 5 }],
  ['hole cross-family height', withHole(), 'assembly-hole-main', { height: 5 }],
  ['unknown patch field', withCut(), 'assembly-cut-main', { reportOnly: true }],
  ['non-boolean patch suppressed', withCut(), 'assembly-cut-main', { suppressed: 1 }],
  ['numeric-string patch dimension', withCut(), 'assembly-cut-main', { width: '5' }],
  ['same name no-op', withCut(), 'assembly-cut-main', { name: 'Main assembly cut' }],
  ['scaled direction semantic no-op', withCut(), 'assembly-cut-main', { direction: [0, 0, 20] }],
];
for (const [label, project, id, patch] of updateCases) {
  const expectedCode = label.startsWith('immutable ID')
    ? 'ASSEMBLY_FEATURE_ID_INVALID'
    : label.startsWith('immutable')
      ? 'ASSEMBLY_FEATURE_KIND_INVALID'
      : label.includes('no-op')
        ? 'ASSEMBLY_FEATURE_PATCH_INVALID'
        : label === 'empty patch'
          ? 'ASSEMBLY_FEATURE_PATCH_INVALID'
          : label.includes('dimension')
            ? 'ASSEMBLY_FEATURE_DIMENSION_INVALID'
            : 'ASSEMBLY_FEATURE_RECORD_INVALID';
  refusal(label, project, () => updateStudioAssemblyFeature(project, id, patch), expectedCode);
}

{
  const project = withCut();
  refusal('late second-target validation', project, () => updateStudioAssemblyFeature(project, 'assembly-cut-main', {
    targets: [firstTarget(), { ...secondTarget(), bodyId: 'body-stale' }],
  }), 'ASSEMBLY_FEATURE_TARGET_INVALID');
}
{
  const project = withCut();
  refusal('missing update ID', project, () => updateStudioAssemblyFeature(project, 'missing-feature', { width: 3 }),
    'ASSEMBLY_FEATURE_NOT_FOUND');
  refusal('missing delete ID', project, () => deleteStudioAssemblyFeature(project, 'missing-feature'),
    'ASSEMBLY_FEATURE_NOT_FOUND');
}

// Global ID ownership and bounded persistent history.
for (const collisionId of ['project-assembly-features', 'assembly-root', 'part-plate', 'body-plate', 'occurrence-plate-a']) {
  const project = fixture();
  refusal(`global ID collision ${collisionId}`, project, () => createStudioAssemblyFeature(project, cutInput({ id: collisionId })),
    'ASSEMBLY_FEATURE_ID_COLLISION');
}
{
  const project = fixture();
  rootAssembly(project).extensions.fakeSchemaObject = {
    schema: STUDIO_ASSEMBLY_FEATURES_SCHEMA,
    id: 'feature-hidden-collision',
  };
  refusal('fake schema object ID hiding', project, () => createStudioAssemblyFeature(project,
    cutInput({ id: 'feature-hidden-collision' })), 'ASSEMBLY_FEATURE_ID_COLLISION');
}
{
  const project = withCut();
  refusal('duplicate feature create', project, () => createStudioAssemblyFeature(project, cutInput()),
    'ASSEMBLY_FEATURE_ID_COLLISION');
}
{
  const project = withCut();
  const template = feature(project, 'assembly-cut-main');
  store(project).features = Array.from({ length: STUDIO_ASSEMBLY_FEATURE_LIMITS.features }, (_, index) => ({
    ...clone(template), id: `assembly-cut-${index}`,
  }));
  assertStudioAssemblyFeaturesProject(project);
  refusal('feature history limit', project, () => createStudioAssemblyFeature(project,
    cutInput({ id: 'assembly-cut-overflow' })), 'ASSEMBLY_FEATURE_LIMIT');
}

// Stored-state schema hardening, including deterministic hole frame and root-only ownership.
const storedMutations: Array<[string, (project: JsonRecord) => void, string]> = [
  ['stored non-boolean suppressed', (project) => { feature(project, 'assembly-hole-main').suppressed = 'false'; }, 'ASSEMBLY_FEATURE_RECORD_INVALID'],
  ['stored hole missing xDirection', (project) => { delete feature(project, 'assembly-hole-main').placement.xDirection; }, 'ASSEMBLY_FEATURE_RECORD_INVALID'],
  ['stored hole non-unit direction', (project) => { feature(project, 'assembly-hole-main').placement.direction = [0, 0, 2]; }, 'ASSEMBLY_FEATURE_VECTOR_INVALID'],
  ['stored hole nonperpendicular xDirection', (project) => { feature(project, 'assembly-hole-main').placement.xDirection = [0, 0, 1]; }, 'ASSEMBLY_FEATURE_VECTOR_INVALID'],
  ['stored signed zero coordinate', (project) => { feature(project, 'assembly-hole-main').placement.origin[0] = -0; }, 'ASSEMBLY_FEATURE_VECTOR_INVALID'],
  ['stored numeric-string diameter', (project) => { feature(project, 'assembly-hole-main').definition.diameter = '6'; }, 'ASSEMBLY_FEATURE_DIMENSION_INVALID'],
  ['stored sub-minimum diameter', (project) => { feature(project, 'assembly-hole-main').definition.diameter = 0.00099; }, 'ASSEMBLY_FEATURE_DIMENSION_INVALID'],
  ['stored target extra key', (project) => { feature(project, 'assembly-hole-main').targets[0].runtimeBodyId = 'prefixed'; }, 'ASSEMBLY_FEATURE_RECORD_INVALID'],
  ['stored feature extra key', (project) => { feature(project, 'assembly-hole-main').proof = 'decorative'; }, 'ASSEMBLY_FEATURE_RECORD_INVALID'],
  ['stored definition extra key', (project) => { feature(project, 'assembly-hole-main').definition.depth = 8; }, 'ASSEMBLY_FEATURE_RECORD_INVALID'],
  ['stored definition extent', (project) => { feature(project, 'assembly-hole-main').definition.extent = 'blind'; }, 'ASSEMBLY_FEATURE_EXTENT_INVALID'],
  ['stored definition profile', (project) => { feature(project, 'assembly-hole-main').definition.profile = 'rectangle'; }, 'ASSEMBLY_FEATURE_PROFILE_INVALID'],
  ['stored schema', (project) => { store(project).schema = 'partmode.assembly-features/v0'; }, 'ASSEMBLY_FEATURE_DOCUMENT_INVALID'],
  ['stored store extra key', (project) => { store(project).report = true; }, 'ASSEMBLY_FEATURE_RECORD_INVALID'],
  ['stored duplicate feature ID', (project) => { store(project).features.push(clone(feature(project, 'assembly-hole-main'))); }, 'ASSEMBLY_FEATURE_ID_COLLISION'],
];
for (const [label, mutate, code] of storedMutations) {
  const project = withHole();
  mutate(project);
  validationRefusal(label, project, code);
}

{
  const project = withHole();
  const nestedFeature = clone(feature(project, 'assembly-hole-main'));
  nestedFeature.targets = [{
    occurrenceId: 'occurrence-nested-plate', partId: 'part-plate', bodyId: 'body-plate',
  }];
  delete rootAssembly(project).extensions.assemblyFeatures;
  project.assemblyDefinitions.push({
    id: 'assembly-inactive',
    occurrences: [{
      id: 'occurrence-nested-plate',
      parentOccurrenceId: null,
      definition: { kind: 'part', partId: 'part-plate' },
      suppressed: false,
    }],
    extensions: {
      assemblyFeatures: { schema: STUDIO_ASSEMBLY_FEATURES_SCHEMA, features: [nestedFeature] },
    },
  });
  validationRefusal('non-root assembly feature owner', project, 'ASSEMBLY_FEATURE_DOCUMENT_INVALID');
}
{
  const project = withHole();
  project.rootDocument = { kind: 'part', partId: 'part-plate' };
  validationRefusal('part root with assembly feature store', project, 'ASSEMBLY_FEATURE_DOCUMENT_INVALID');
}

// Persistent target guards prove the bounded direct-occurrence/body contract.
const targetMutations: Array<[string, (project: JsonRecord) => void]> = [
  ['missing occurrence', (project) => { rootAssembly(project).occurrences.shift(); }],
  ['nested occurrence', (project) => { rootAssembly(project).occurrences[0].parentOccurrenceId = 'parent-occurrence'; }],
  ['suppressed occurrence', (project) => { rootAssembly(project).occurrences[0].suppressed = true; }],
  ['assembly occurrence', (project) => { rootAssembly(project).occurrences[0].definition = { kind: 'assembly', assemblyId: 'assembly-other' }; }],
  ['generated Smart Fastener occurrence', (project) => { rootAssembly(project).occurrences[0].extensions = { smartFastenerOwnership: { groupId: 'group' } }; }],
  ['replaced part definition', (project) => { rootAssembly(project).occurrences[0].definition.partId = 'part-replaced'; }],
  ['pattern source occurrence', (project) => { rootAssembly(project).occurrencePatterns = [{ id: 'pattern', sourceOccurrenceIds: ['occurrence-plate-a'], suppressed: false }]; }],
  ['missing body', (project) => { project.partDefinitions[0].bodies = []; }],
  ['surface body', (project) => { project.partDefinitions[0].bodies[0].kind = 'surface'; }],
  ['suppressed body', (project) => { project.partDefinitions[0].bodies[0].suppressed = true; }],
  ['consumed body', (project) => { project.partDefinitions[0].bodies[0].extensions = { consumedByFeatureId: 'feature-consumer' }; }],
  ['Smart Fastener target overlap', (project) => {
    rootAssembly(project).extensions.smartFasteners = {
      groups: [{ targetOccurrenceId: 'occurrence-plate-a', target: { bodyId: 'body-plate' } }],
    };
  }],
];
for (const [label, mutate] of targetMutations) {
  const project = withHole();
  mutate(project);
  validationRefusal(label, project, 'ASSEMBLY_FEATURE_TARGET_INVALID');
}

{
  const project = fixture();
  project.rootDocument = { kind: 'part', partId: 'part-plate' };
  refusal('create outside an active assembly', project, () => createStudioAssemblyFeature(project, cutInput()),
    'ASSEMBLY_FEATURE_DOCUMENT_INVALID');
}

console.log('Studio assembly feature document smoke passed.');
