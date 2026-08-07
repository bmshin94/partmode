import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

type JsonRecord = Record<string, any>;

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const threads = await moduleAt('src/static/studio-thread.js');
const featureTypes = await moduleAt('src/static/studio-v5-feature-types.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const projectModule = await moduleAt('src/static/studio-project-v5.js');
const agent = await moduleAt('src/static/studio-agent-service.js');

function expectCode(label: string, action: () => unknown, code: string): void {
  assert.throws(action, (error: any) => error?.code === code, label);
}

const targetFace = {
  name: 'Ffeature-thread-carrier:side',
  sig: {
    topologyKind: 'face',
    geomType: 'CYLINDRE',
    p: [4, -2, 7],
    n: [Math.SQRT1_2, Math.SQRT1_2, 0],
    r: 3,
  },
};

assert.equal(threads.STUDIO_THREAD_SCHEMA_V2, 'partmode.thread/v2');
assert.equal(threads.STUDIO_THREAD_EVIDENCE_SCHEMA, 'partmode.thread-evidence/v1');
assert.equal(threads.STUDIO_THREAD_MODELED_TURN_LIMIT, 7);
assert.equal(threads.STUDIO_THREAD_COSMETIC_TURN_LIMIT, 100);
assert.deepEqual(threads.STUDIO_THREAD_KINDS, ['external', 'internal']);
assert.deepEqual(threads.STUDIO_THREAD_RUNOUT_FORMS, ['full-profile', 'one-pitch-taper']);
assert.equal(threads.STUDIO_THREAD_SOURCES.length, 3, 'base source inventory changed');
assert.deepEqual(
  threads.STUDIO_THREAD_V2_SOURCES.slice(-2).map((source: JsonRecord) => `${source.standard}:${source.edition}`),
  ['ISO 965-1:2026', 'ISO 965-2:2024'],
);
assert.ok(threads.STUDIO_THREAD_V2_SOURCES.every((source: JsonRecord) =>
  source.url.startsWith('https://www.iso.org/standard/')));

const external = threads.studioThreadV2Definition({
  mode: 'modeled',
  threadKind: 'external',
  designation: 'M6',
  handedness: 'right',
  toleranceClass: '6g',
  span: { mode: 'fraction', start: 0.25, end: 0.75 },
  runout: 'one-pitch-taper',
});
assert.equal(threads.assertStudioThreadV2Definition(external).schema, 'partmode.thread/v2');
assert.equal(external.profile.policy, 'iso-68-1-truncated-profile-v1');
assert.equal(external.profile.includedAngleDegrees, 60);
assert.ok(external.profile.crest.truncationHeight > 0);
assert.equal(external.profile.root.form, 'rounded');
assert.ok(external.profile.root.radius > 0);
assert.notEqual(external.profile, 'nominal-sharp-60-degree-v');
assert.equal(external.tolerance.class, '6g');
assert.equal(external.tolerance.fundamentalDeviationMicrometres, -26);
assert.equal(external.tolerance.allowanceMm, 0.026);
assert.equal(external.tolerance.maximumMaterialRepresentative.majorDiameter, 5.974);
assert.deepEqual(external.runout, {
  form: 'one-pitch-taper',
  policy: 'partmode-explicit-axial-transition-v1',
  startTurns: 1,
  endTurns: 1,
  construction: 'partmode-linear-profile-scale-over-one-pitch',
  standardsConformance: 'not-claimed',
});
assert.deepEqual(threads.studioThreadResolveAxialSpan(external, 12), {
  startMm: 3,
  endMm: 9,
  lengthMm: 6,
  turnCount: 6,
  fullTurnCount: 6,
});

const internal = threads.studioThreadV2Definition({
  mode: 'cosmetic',
  threadKind: 'internal',
  designation: 'M6',
  handedness: 'left',
  span: { mode: 'offset', startMm: 2, endMm: 18 },
  runout: 'full-profile',
});
assert.equal(internal.toleranceClass, '6H');
assert.equal(internal.tolerance.position, 'H');
assert.equal(internal.tolerance.fundamentalDeviationMicrometres, 0);
assert.equal(internal.tolerance.allowanceMm, 0);
assert.equal(internal.profile.root.form, 'flat');
assert.equal(internal.runout.startTurns, 0);
assert.deepEqual(threads.studioThreadResolveAxialSpan(internal, 20), {
  startMm: 2,
  endMm: 18,
  lengthMm: 16,
  turnCount: 16,
  fullTurnCount: 16,
});

const feature = threads.createStudioThreadV2Feature({
  id: 'feature-thread-v2',
  bodyId: 'body-thread-v2',
  targetFace,
  mode: 'modeled',
  threadKind: 'internal',
  designation: 'M6',
  handedness: 'left',
  toleranceClass: '6H',
  span: { mode: 'offset', startMm: 2, endMm: 18 },
  runout: 'full-profile',
  name: 'Internal M6 <literal>',
});
const normalized = threads.assertStudioThreadFeature(feature);
assert.equal(normalized.schema, 'partmode.thread/v2');
assert.equal(normalized.support.bodyId, 'body-thread-v2');
assert.equal(normalized.support.face.name, targetFace.name);
assert.equal(feature.resultPolicy.kind, 'add');
assert.deepEqual(feature.inputRefs.map((reference: JsonRecord) => reference.semanticPath.role),
  ['target-body', 'target-face']);
assert.equal(feature.inputRefs[1].semanticPath.topologyKind, 'face');
assert.equal(feature.inputRefs[1].semanticPath.name, targetFace.name);
assert.equal('center' in normalized, false);
assert.equal('startZ' in normalized, false);
assert.equal('axis' in normalized, false);
featureTypes.assertStudioV5FeatureStructure(feature, 'thread-v2');
assert.equal(featureTypes.assertStudioV5FeatureContract(feature),
  featureTypes.STUDIO_V5_FEATURE_CONTRACTS.thread);
assert.deepEqual(threads.studioThreadOperationInput(feature).extensions, feature.extensions);
// Typed transaction and canonical stored reopen retain the exact v2 recipe.
const base = runtime.createStudioV5RuntimePartProject({
  projectId: 'project-thread-v2-document',
  name: 'Thread v2 document contract',
  units: 'mm',
  parameters: [],
  features: [{
    id: 'feature-thread-carrier',
    type: 'extrude',
    sketch: { shapes: [{ id: 'shape-thread-carrier', kind: 'circle', x: 0, y: 0, r: 3 }] },
    h: 20,
    through: false,
  }],

});
const bodyId = runtime.studioV5ActiveBody(base).id;
const storedFeature = threads.createStudioThreadV2Feature({
  id: 'feature-thread-v2-stored',
  bodyId,
  targetFace,
  mode: 'cosmetic',
  threadKind: 'external',
  designation: 'M6',
  span: { mode: 'fraction', start: 0.1, end: 0.9 },
  runout: 'one-pitch-taper',
});
const applied = agent.applyCadTransaction(base, {
  transactionId: 'transaction-thread-v2-document',
  label: 'Create exact thread v2 recipe',
  expectedRevision: 0,
  atomic: true,
  operations: [{ kind: 'feature.thread', input: threads.studioThreadOperationInput(storedFeature) }],
}).project;
const saved = JSON.stringify(projectModule.prepareStudioV5Project(applied));
const reopened = projectModule.parseStudioV5Project(saved);
assert.equal(JSON.stringify(reopened), saved);
const reopenedFeature = reopened.partDefinitions[0].features.at(-1);
assert.equal(threads.assertStudioThreadFeature(reopenedFeature).schema, 'partmode.thread/v2');
assert.equal(reopenedFeature.extensions.thread.support.face.name, targetFace.name);

const editedFeature = threads.createStudioThreadV2Feature({
  id: reopenedFeature.id,
  bodyId,
  targetFace,
  mode: 'modeled',
  threadKind: 'external',
  designation: 'M6',
  handedness: 'left',
  toleranceClass: '6g',
  span: { mode: 'fraction', start: 0.2, end: 0.8 },
  runout: 'full-profile',
  name: 'Edited exact thread v2',
});
const edited = agent.applyCadTransaction(reopened, {
  transactionId: 'transaction-thread-v2-update',
  label: 'Update exact thread v2 recipe',
  expectedRevision: reopened.revision,
  atomic: true,
  operations: [{
    kind: 'feature.update',
    input: {
      featureId: reopenedFeature.id,
      patch: {
        name: editedFeature.name,
        resultPolicy: editedFeature.resultPolicy,
        inputRefs: editedFeature.inputRefs,
        extensions: editedFeature.extensions,
      },
    },
  }],
}).project;
const editedStored = edited.partDefinitions[0].features.find((entry: JsonRecord) => entry.id === editedFeature.id);
assert.equal(threads.assertStudioThreadFeature(editedStored).mode, 'modeled');
assert.equal(editedStored.extensions.thread.handedness, 'left');
assert.equal(editedStored.extensions.thread.runout.form, 'full-profile');
const retargetedFeature = threads.createStudioThreadV2Feature({
  id: editedFeature.id,
  bodyId,
  targetFace: { ...targetFace, name: targetFace.name + ':other-support' },
  mode: 'modeled',
  threadKind: 'external',
  designation: 'M6',
  handedness: 'left',
  toleranceClass: '6g',
  span: { mode: 'fraction', start: 0.2, end: 0.8 },
  runout: 'full-profile',
  name: 'Illegally retargeted Thread v2',
});
assert.throws(() => agent.applyCadTransaction(edited, {
  transactionId: 'transaction-thread-v2-retarget-refusal',
  label: 'Refuse Thread v2 support retarget',
  expectedRevision: edited.revision,
  atomic: true,
  operations: [{
    kind: 'feature.update',
    input: {
      featureId: editedFeature.id,
      patch: {
        name: retargetedFeature.name,
        resultPolicy: retargetedFeature.resultPolicy,
        inputRefs: retargetedFeature.inputRefs,
        extensions: retargetedFeature.extensions,
      },
    },
  }],
}), (error: any) => error?.code === 'INVALID_PATCH'
  && /support body and cylindrical face are immutable/iu.test(error.message),
'typed Thread v2 update retargeted its immutable support');
const deleted = agent.applyCadTransaction(edited, {
  transactionId: 'transaction-thread-v2-delete',
  label: 'Delete exact thread v2 recipe',
  expectedRevision: edited.revision,
  atomic: true,
  operations: [{ kind: 'feature.delete', input: { featureId: editedFeature.id } }],
}).project;
assert.equal(deleted.partDefinitions[0].features.some((entry: JsonRecord) => entry.id === editedFeature.id), false);
assert.equal(deleted.partDefinitions[0].bodies.some((entry: JsonRecord) => entry.id === bodyId), true);

// Every stored derived field and every canonical association fails closed when
// changed independently. Property order alone remains semantically irrelevant.
for (const [label, mutate] of [
  ['profile', (candidate: JsonRecord) => { candidate.extensions.thread.profile.crest.truncationHeight += 0.01; }],
  ['tolerance', (candidate: JsonRecord) => { candidate.extensions.thread.tolerance.allowanceMm += 0.001; }],
  ['runout', (candidate: JsonRecord) => { candidate.extensions.thread.runout.startTurns += 1; }],
  ['source', (candidate: JsonRecord) => { candidate.extensions.thread.sources[3].url = 'https://example.invalid/'; }],
  ['support name', (candidate: JsonRecord) => { candidate.extensions.thread.support.face.name += '-changed'; }],
  ['support signature', (candidate: JsonRecord) => { candidate.extensions.thread.support.face.sig.r += 0.1; }],
  ['input references', (candidate: JsonRecord) => { candidate.inputRefs.reverse(); }],
  ['extra recipe field', (candidate: JsonRecord) => { candidate.extensions.thread.unproved = true; }],
] as Array<[string, (candidate: JsonRecord) => void]>) {
  const candidate = structuredClone(feature);
  mutate(candidate);
  assert.throws(() => threads.assertStudioThreadFeature(candidate), `${label} tamper passed`);
}

expectCode('external 6H accepted', () => threads.studioThreadV2Definition({
  mode: 'modeled', threadKind: 'external', designation: 'M6', toleranceClass: '6H',
}), 'THREAD_TOLERANCE_CLASS_UNSUPPORTED');
expectCode('internal 6g accepted', () => threads.studioThreadV2Definition({
  mode: 'modeled', threadKind: 'internal', designation: 'M6', toleranceClass: '6g',
}), 'THREAD_TOLERANCE_CLASS_UNSUPPORTED');
expectCode('planar support accepted', () => threads.createStudioThreadV2Feature({
  id: 'bad-face', bodyId: 'body', targetFace: { name: 'Fplane', sig: { geomType: 'PLANE' } },
  mode: 'cosmetic', threadKind: 'external', designation: 'M6',
}), 'THREAD_FACE_REFERENCE_INVALID');
expectCode('empty exact face evidence accepted', () => threads.createStudioThreadV2Feature({
  id: 'empty-face', bodyId: 'body', targetFace: { name: 'Fcylinder', sig: {} },
  mode: 'cosmetic', threadKind: 'external', designation: 'M6',
}), 'THREAD_FACE_REFERENCE_INVALID');
expectCode('short span accepted', () => threads.studioThreadResolveAxialSpan(
  threads.studioThreadV2Definition({
    mode: 'modeled', threadKind: 'external', designation: 'M6',
    span: { mode: 'offset', startMm: 0, endMm: 0.5 },
  }), 20,
), 'THREAD_SPAN_TOO_SHORT');
expectCode('outside span accepted', () => threads.studioThreadResolveAxialSpan(
  threads.studioThreadV2Definition({
    mode: 'modeled', threadKind: 'external', designation: 'M6',
    span: { mode: 'offset', startMm: 0, endMm: 21 },
  }), 20,
), 'THREAD_SPAN_OUTSIDE_SUPPORT');
expectCode('modeled scale ceiling not enforced', () => threads.studioThreadResolveAxialSpan(
  threads.studioThreadV2Definition({
    mode: 'modeled', threadKind: 'external', designation: 'M3',
    span: { mode: 'offset', startMm: 0, endMm: 4 },
  }), 40,
), 'THREAD_TURN_COUNT_INVALID');
expectCode('cosmetic viewport ceiling not enforced', () => threads.studioThreadResolveAxialSpan(
  threads.studioThreadV2Definition({
    mode: 'cosmetic', threadKind: 'external', designation: 'M6',
    span: { mode: 'offset', startMm: 0, endMm: 101 },
    runout: 'full-profile',
  }), 101,
), 'THREAD_TURN_COUNT_INVALID');

console.log(JSON.stringify({
  schema: 'partmode.thread-document-smoke/v2',
  currentSchema: feature.extensions.thread.schema,
  kinds: threads.STUDIO_THREAD_KINDS,
  modes: threads.STUDIO_THREAD_MODES,
  toleranceClasses: threads.STUDIO_THREAD_TOLERANCE_CLASSES,
  runoutForms: threads.STUDIO_THREAD_RUNOUT_FORMS,
  modeledTurnLimit: threads.STUDIO_THREAD_MODELED_TURN_LIMIT,
  cosmeticTurnLimit: threads.STUDIO_THREAD_COSMETIC_TURN_LIMIT,
  supportPolicy: feature.extensions.thread.support.policy,
  exactFaceReference: feature.extensions.thread.support.face.name,
  axisPolicy: 'derived from current exact cylindrical topology',
  canonicalStoredReopen: true,
  typedLifecycle: ['create', 'update', 'delete'],
  sources: threads.STUDIO_THREAD_V2_SOURCES.map((source: JsonRecord) => `${source.standard}:${source.edition}`),
  manufacturingCertification: false,
}, null, 2));
