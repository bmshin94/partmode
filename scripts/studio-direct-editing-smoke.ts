import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

const TARGET_BODY_ID = 'body-direct-target';
const REPLACEMENT_BODY_ID = 'body-direct-replacement';
const PUSH_ID = 'feature-direct-push';
const REPLACE_ID = 'feature-direct-replace';
const DELETE_FACE_ID = 'feature-direct-delete-face';

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Direct editing smoke failed: ${label}`);
}

function closeTo(actual: number, expected: number, tolerance = 2e-5): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function checkBounds(label: string, actual: unknown, expected: number[][]): void {
  check(`${label} bounds are absent`, Array.isArray(actual) && actual.length === 2);
  check(
    `${label} bounds changed: ${JSON.stringify(actual)}`,
    actual.every((row: unknown, rowIndex: number) => Array.isArray(row)
      && row.length === 3
      && row.every((value: unknown, axis: number) => typeof value === 'number'
        && closeTo(value, expected[rowIndex]![axis]!))),
  );
}

function rejection(label: string, source: JsonRecord, action: () => unknown, pattern: RegExp): void {
  const before = JSON.stringify(source);
  let error: unknown = null;
  try { action(); } catch (candidate) { error = candidate; }
  check(`${label} did not reject`, error instanceof Error && pattern.test(error.message));
  check(`${label} mutated its source`, JSON.stringify(source) === before);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const projectModule = await moduleAt('src/static/studio-project-v5.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const agent = await moduleAt('src/static/studio-agent-service.js');
const featureTypes = await moduleAt('src/static/studio-v5-feature-types.js');

function exactRectangleSketch(
  id: string,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  z: number,
): JsonRecord {
  const x0 = x - width / 2;
  const x1 = x + width / 2;
  const y0 = y - height / 2;
  const y1 = y + height / 2;
  return {
    id,
    name,
    entities: [
      { id: `${id}-bottom`, kind: 'line', a: [x0, y0], b: [x1, y0] },
      { id: `${id}-right`, kind: 'line', a: [x1, y0], b: [x1, y1] },
      { id: `${id}-top`, kind: 'line', a: [x1, y1], b: [x0, y1] },
      { id: `${id}-left`, kind: 'line', a: [x0, y1], b: [x0, y0] },
    ],
    groups: [],
    shapes: [{ kind: 'rect', x, y, w: width, h: height }],
    z,
  };
}

function directEditFixture(): JsonRecord {
  const targetReference = {
    ownerKind: 'body',
    ownerId: TARGET_BODY_ID,
    semanticPath: { role: 'target' },
    signature: { role: 'target' },
  };
  const project = {
    schemaVersion: 5,
    projectId: 'project-direct-edit-acceptance',
    name: 'Direct editing exact acceptance',
    units: 'mm',
    parameters: [{ id: 'parameter-boss-height', name: 'boss_height', value: 4 }],
    materials: [],
    partDefinitions: [{
      id: 'part-direct-edit-acceptance',
      name: 'Direct editing exact acceptance',
      parameters: [],
      referenceGeometry: [],
      sketches: [],
      bodies: [],
      bodyPatterns: [],
      features: [
        {
          id: 'feature-direct-base',
          name: 'Direct edit base',
          type: 'extrude',
          sketch: exactRectangleSketch('sketch-direct-base', 'Direct edit base profile', 0, 0, 12, 8, 0),
          plane: { kind: 'base', plane: 'XY' },
          h: 4,
          through: false,
          resultPolicy: { kind: 'new-body', bodyName: 'Stepped direct edit target' },
          createdBodyId: TARGET_BODY_ID,
          suppressed: false,
          inputRefs: [],
          extensions: { exactSketchEntities: true },
        },
        {
          id: 'feature-direct-boss',
          name: 'Direct edit boss',
          type: 'extrude',
          sketch: exactRectangleSketch('sketch-direct-boss', 'Direct edit boss profile', 0, 0, 4, 4, 4),
          plane: { kind: 'base', plane: 'XY' },
          h: 'boss_height',
          through: false,
          resultPolicy: { kind: 'add', targetBodyIds: [TARGET_BODY_ID] },
          suppressed: false,
          inputRefs: [targetReference],
          extensions: { exactSketchEntities: true },
        },
        {
          id: 'feature-direct-replacement-stock',
          name: 'Replacement plane stock',
          type: 'extrude',
          sketch: exactRectangleSketch(
            'sketch-direct-replacement',
            'Replacement plane profile',
            30,
            0,
            4,
            4,
            0,
          ),
          plane: { kind: 'base', plane: 'XY' },
          h: 10,
          through: false,
          resultPolicy: { kind: 'new-body', bodyName: 'Replacement plane stock' },
          createdBodyId: REPLACEMENT_BODY_ID,
          suppressed: false,
          inputRefs: [],
          extensions: { exactSketchEntities: true },
        },
      ],
      featureOrder: [
        'feature-direct-base',
        'feature-direct-boss',
        'feature-direct-replacement-stock',
      ],
      metadata: { activeBodyId: TARGET_BODY_ID },
    }],
    assemblyDefinitions: [],
    rootDocument: { kind: 'part', partId: 'part-direct-edit-acceptance' },
    resources: [],
    metadata: { corpus: 'direct-editing-exact-acceptance' },
  } as JsonRecord;
  runtime.reconcileStudioV5Bodies(project.partDefinitions[0]);
  return projectModule.prepareStudioV5Project(project) as JsonRecord;
}

function canonicalSaveReopen(project: JsonRecord, label: string): JsonRecord {
  const saved = JSON.stringify(projectModule.prepareStudioV5Project(project));
  const reopened = projectModule.parseStudioV5Project(saved) as JsonRecord;
  check(`${label} changed across canonical save/reopen`, JSON.stringify(reopened) === saved);
  return reopened;
}

let transactionSequence = 0;
function apply(source: JsonRecord, label: string, operations: JsonRecord[]): JsonRecord {
  transactionSequence += 1;
  return agent.applyCadTransaction(source, {
    transactionId: `direct-edit-${transactionSequence}-${label}`,
    label,
    expectedRevision: 0,
    atomic: true,
    operations,
  }).project as JsonRecord;
}

let rebuildSequence = 0;
async function rebuild(kernel: HeadlessKernel, project: JsonRecord, label: string): Promise<JsonRecord> {
  rebuildSequence += 1;
  return kernel.request({
    kind: 'rebuild',
    requestId: `direct-edit-rebuild-${rebuildSequence}-${label}`,
    projectId: project.projectId,
    revision: rebuildSequence,
    document: project,
    includeExactBrep: true,
  }, 180_000) as Promise<JsonRecord>;
}

function bodyFrom(result: JsonRecord, bodyId: string, label: string): JsonRecord {
  const body = result.bodies?.find((entry: JsonRecord) => entry.bodyId === bodyId);
  check(`${label} omitted body ${bodyId}: ${JSON.stringify(result.errors || [])}`, body);
  return body;
}

function assertCurrentResult(result: JsonRecord, project: JsonRecord, label: string): void {
  const hash = runtime.studioV5CanonicalHash(project);
  check(`${label} was not a current rebuild result`, result.kind === 'rebuild-result'
    && result.effectiveDocumentHash === hash
    && /^[0-9a-f]{64}$/u.test(hash));
}

function exactBody(result: JsonRecord, project: JsonRecord, bodyId: string, label: string): JsonRecord {
  assertCurrentResult(result, project, label);
  check(`${label} published worker errors: ${JSON.stringify(result.errors || [])}`, result.errors?.length === 0);
  check(`${label} published worker warnings: ${JSON.stringify(result.warnings || [])}`, result.warnings?.length === 0);
  const body = bodyFrom(result, bodyId, label);
  const counts = body.mesh?.topologyCounts;
  check(`${label} has no current exact one-solid B-rep`, body.error == null
    && body.lastValid === false
    && body.geometry?.valid === true
    && body.geometry?.brepValid === true
    && body.geometry?.solidCount === 1
    && body.geometry?.shellCount === 1
    && typeof body.exactBrep === 'string'
    && body.exactBrep.length > 100);
  check(`${label} has incomplete persistent topology: ${JSON.stringify(counts)}`, counts
    && counts.faces > 0 && counts.faces === body.geometry.faceCount && counts.faces === counts.namedFaces
    && counts.edges > 0 && counts.edges === body.geometry.edgeCount && counts.edges === counts.namedEdges
    && counts.vertices > 0 && counts.vertices === body.geometry.vertexCount && counts.vertices === counts.namedVertices
    && body.mesh.topologyFaces?.length === counts.faces
    && body.mesh.edges?.length === counts.edges
    && body.mesh.topologyVertices?.length === counts.vertices);
  check(`${label} published topology errors: ${JSON.stringify(body.mesh?.topologyDiagnostics || [])}`,
    Array.isArray(body.mesh?.topologyDiagnostics)
      && !body.mesh.topologyDiagnostics.some((entry: JsonRecord) => entry.severity === 'error'));
  return body;
}

function selectedPlaneFace(
  body: JsonRecord,
  stationAxis: number,
  station: number,
  expectedNormal: number[],
  label: string,
): JsonRecord {
  const matches = (body.mesh?.topologyFaces || []).filter((face: JsonRecord) =>
    typeof face.name === 'string' && face.name.length > 0
      && face.geomType === 'PLANE'
      && Array.isArray(face.sig?.p) && closeTo(face.sig.p[stationAxis], station, 0.05)
      && Array.isArray(face.sig?.n)
      && face.sig.n.reduce((sum: number, value: number, axis: number) =>
        sum + value * (expectedNormal[axis] ?? 0), 0) > 0.999);
  check(`${label} did not resolve exactly one current named planar face: ${JSON.stringify(body.mesh?.topologyFaces || [])}`,
    matches.length === 1);
  return { name: matches[0].name, sig: structuredClone(matches[0].sig) };
}

function directCreate(
  source: JsonRecord,
  label: string,
  input: JsonRecord,
): JsonRecord {
  return apply(source, label, [{ kind: 'directEdit.create', input }]);
}

function directFeature(project: JsonRecord, featureId: string): JsonRecord {
  const feature = runtime.studioV5RootPart(project).features.find((entry: JsonRecord) => entry.id === featureId);
  check(`stored direct edit ${featureId} is absent`, feature?.type === 'direct-edit');
  featureTypes.assertStudioV5FeatureStructure(feature, `stored-${featureId}`);
  return feature;
}

function assertDirectRecipe(feature: JsonRecord, operation: string, expectedRoles: string[]): void {
  check(`${feature.id} lost its immutable direct-edit recipe`, feature.operation === operation
    && feature.sourceBodyId === TARGET_BODY_ID
    && feature.targetBodyId === TARGET_BODY_ID
    && feature.resultPolicy?.kind === 'add'
    && JSON.stringify(feature.resultPolicy.targetBodyIds) === JSON.stringify([TARGET_BODY_ID])
    && feature.extensions?.directEdit?.schema === 'partmode.direct-edit/v1'
    && feature.extensions.directEdit.version === 1
    && feature.extensions.directEdit.operation === operation
    && JSON.stringify(feature.inputRefs.map((entry: JsonRecord) => entry.semanticPath?.role))
      === JSON.stringify(expectedRoles));
}

async function assertRefusedRebuild(
  kernel: HeadlessKernel,
  project: JsonRecord,
  featureId: string,
  label: string,
  pattern: RegExp,
): Promise<void> {
  const before = JSON.stringify(project);
  const result = await rebuild(kernel, project, label);
  assertCurrentResult(result, project, label);
  check(`${label} did not publish the expected feature refusal: ${JSON.stringify(result.errors || [])}`,
    result.errors?.some((entry: JsonRecord) => entry.featureId === featureId && pattern.test(entry.message)));
  const target = bodyFrom(result, TARGET_BODY_ID, label);
  check(`${label} published stale or modified exact target geometry`, target.error
    && target.lastValid !== true
    && target.exactBrep == null
    && target.geometry == null);
  check(`${label} mutated its source document`, JSON.stringify(project) === before);
}

const base = canonicalSaveReopen(directEditFixture(), 'base fixture');
const basePart = runtime.studioV5RootPart(base);
check('fixture body ownership is not exact', JSON.stringify(
  basePart.bodies.map((body: JsonRecord) => [body.id, body.featureIds]),
) === JSON.stringify([
  [TARGET_BODY_ID, ['feature-direct-base', 'feature-direct-boss']],
  [REPLACEMENT_BODY_ID, ['feature-direct-replacement-stock']],
]));

let kernel: HeadlessKernel | null = null;
let pushProject: JsonRecord;
let pushBody: JsonRecord;
let replacementBaseline: JsonRecord;
let targetTop: JsonRecord;
let targetPatch: JsonRecord;
let replacementTop: JsonRecord;
let replacementSide: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();

  const baselineResult = await rebuild(kernel, base, 'baseline');
  const targetBaseline = exactBody(baselineResult, base, TARGET_BODY_ID, 'baseline target');
  replacementBaseline = exactBody(baselineResult, base, REPLACEMENT_BODY_ID, 'baseline replacement');
  check('baseline target exact volume changed', closeTo(targetBaseline.geometry.volume, 448));
  checkBounds('baseline target', targetBaseline.geometry.bounds, [[-6, -4, 0], [6, 4, 8]]);
  check('replacement stock exact volume changed', closeTo(replacementBaseline.geometry.volume, 160));
  checkBounds('replacement stock', replacementBaseline.geometry.bounds, [[28, -2, 0], [32, 2, 10]]);

  targetTop = selectedPlaneFace(targetBaseline, 2, 8, [0, 0, 1], 'target boss top');
  targetPatch = selectedPlaneFace(targetBaseline, 2, 4, [0, 0, 1], 'target shelf patch');
  replacementTop = selectedPlaneFace(replacementBaseline, 2, 10, [0, 0, 1], 'replacement top');
  replacementSide = selectedPlaneFace(replacementBaseline, 0, 32, [1, 0, 0], 'replacement side');

  pushProject = directCreate(base, 'create-push-pull', {
    id: PUSH_ID,
    name: 'Push boss top by two',
    operation: 'push-pull',
    targetBodyId: TARGET_BODY_ID,
    targetFace: targetTop,
    distance: 2,
  });
  const pushFeature = directFeature(pushProject, PUSH_ID);
  assertDirectRecipe(pushFeature, 'push-pull', ['target-body', 'target-face']);
  check('push-pull lost its authored signed distance and persistent face reference', pushFeature.distance === 2
    && pushFeature.targetFace.name === targetTop.name
    && JSON.stringify(pushFeature.targetFace.sig) === JSON.stringify(targetTop.sig));
  pushProject = canonicalSaveReopen(pushProject, 'push-pull');
  const pushResult = await rebuild(kernel, pushProject, 'push-positive');
  pushBody = exactBody(pushResult, pushProject, TARGET_BODY_ID, 'positive push-pull');
  check('positive push-pull did not add the exact selected-face prism', closeTo(pushBody.geometry.volume, 480));
  checkBounds('positive push-pull', pushBody.geometry.bounds, [[-6, -4, 0], [6, 4, 10]]);
  const pushReplacement = exactBody(pushResult, pushProject, REPLACEMENT_BODY_ID, 'push replacement');
  check('push-pull changed the unrelated replacement exact body', pushReplacement.exactBrep === replacementBaseline.exactBrep
    && closeTo(pushReplacement.geometry.volume, replacementBaseline.geometry.volume));

  const updatedPush = apply(pushProject, 'update-push-pull', [{
    kind: 'directEdit.update',
    input: { featureId: PUSH_ID, patch: { name: 'Push boss top by three', distance: 3 } },
  }]);
  const updatedPushFeature = directFeature(updatedPush, PUSH_ID);
  assertDirectRecipe(updatedPushFeature, 'push-pull', ['target-body', 'target-face']);
  check('typed direct-edit update did not preserve identity and change only requested fields',
    updatedPushFeature.name === 'Push boss top by three'
      && updatedPushFeature.distance === 3
      && updatedPushFeature.targetFace.name === targetTop.name);
  const updatedPushBody = exactBody(
    await rebuild(kernel, updatedPush, 'push-updated'),
    updatedPush,
    TARGET_BODY_ID,
    'updated push-pull',
  );
  check('typed push-pull update reused stale exact geometry', closeTo(updatedPushBody.geometry.volume, 496)
    && updatedPushBody.exactBrep !== pushBody.exactBrep);
  checkBounds('updated push-pull', updatedPushBody.geometry.bounds, [[-6, -4, 0], [6, 4, 11]]);

  const deletedPush = apply(updatedPush, 'delete-push-pull', [{
    kind: 'directEdit.delete', input: { featureId: PUSH_ID },
  }]);
  check('typed direct-edit delete retained the feature or body ownership',
    !runtime.studioV5RootPart(deletedPush).features.some((entry: JsonRecord) => entry.id === PUSH_ID)
      && !runtime.studioV5RootPart(deletedPush).bodies.find((entry: JsonRecord) => entry.id === TARGET_BODY_ID)
        .featureIds.includes(PUSH_ID));
  const restoredBody = exactBody(
    await rebuild(kernel, deletedPush, 'push-deleted'),
    deletedPush,
    TARGET_BODY_ID,
    'deleted push-pull restoration',
  );
  check('typed direct-edit delete did not restore the exact upstream B-rep',
    restoredBody.exactBrep === targetBaseline.exactBrep && closeTo(restoredBody.geometry.volume, 448));

  const negativePush = directCreate(base, 'create-negative-push', {
    id: 'feature-direct-negative-push',
    name: 'Pull boss top down',
    operation: 'push-pull',
    targetBodyId: TARGET_BODY_ID,
    targetFace: targetTop,
    distance: -2,
  });
  const negativeBody = exactBody(
    await rebuild(kernel, negativePush, 'push-negative'),
    negativePush,
    TARGET_BODY_ID,
    'negative push-pull',
  );
  check('negative push-pull did not remove the exact selected-face prism', closeTo(negativeBody.geometry.volume, 416));
  checkBounds('negative push-pull', negativeBody.geometry.bounds, [[-6, -4, 0], [6, 4, 6]]);

  const nameFirstPush = directCreate(base, 'create-name-first-push', {
    id: 'feature-direct-name-first',
    name: 'Name-first push',
    operation: 'push-pull',
    targetBodyId: TARGET_BODY_ID,
    targetFace: { name: targetTop.name, sig: { deliberately: 'not-the-face-signature' } },
    distance: 2,
  });
  const nameFirstBody = exactBody(
    await rebuild(kernel, nameFirstPush, 'name-first'),
    nameFirstPush,
    TARGET_BODY_ID,
    'name-first push-pull',
  );
  check('persistent name did not take precedence over a stale signature',
    nameFirstBody.exactBrep === pushBody.exactBrep && closeTo(nameFirstBody.geometry.volume, 480));

  let associatedPush = structuredClone(pushProject);
  associatedPush.parameters.find((entry: JsonRecord) => entry.name === 'boss_height').value = 5;
  associatedPush = canonicalSaveReopen(projectModule.prepareStudioV5Project(associatedPush), 'upstream-associated push');
  const associatedBody = exactBody(
    await rebuild(kernel, associatedPush, 'upstream-associated'),
    associatedPush,
    TARGET_BODY_ID,
    'upstream-associated push-pull',
  );
  check('upstream boss edit did not rebuild the name-bound direct edit associatively',
    closeTo(associatedBody.geometry.volume, 496) && associatedBody.exactBrep !== pushBody.exactBrep);
  checkBounds('upstream-associated push-pull', associatedBody.geometry.bounds, [[-6, -4, 0], [6, 4, 11]]);

  const replaceProject = canonicalSaveReopen(directCreate(base, 'create-replace-face', {
    id: REPLACE_ID,
    name: 'Replace boss top at external station',
    operation: 'replace-face',
    targetBodyId: TARGET_BODY_ID,
    targetFace: targetTop,
    replacementBodyId: REPLACEMENT_BODY_ID,
    replacementFace: replacementTop,
  }), 'replace-face');
  const replaceFeature = directFeature(replaceProject, REPLACE_ID);
  assertDirectRecipe(replaceFeature, 'replace-face', [
    'target-body', 'target-face', 'replacement-body', 'replacement-face',
  ]);
  const replaceResult = await rebuild(kernel, replaceProject, 'replace-face');
  const replacedBody = exactBody(replaceResult, replaceProject, TARGET_BODY_ID, 'replace-face target');
  const replacementAfterReplace = exactBody(
    replaceResult,
    replaceProject,
    REPLACEMENT_BODY_ID,
    'replace-face reference body',
  );
  check('replace-face did not move the exact target plane to the replacement station',
    closeTo(replacedBody.geometry.volume, 480));
  checkBounds('replace-face target', replacedBody.geometry.bounds, [[-6, -4, 0], [6, 4, 10]]);
  check('replace-face mutated its exact replacement reference body',
    replacementAfterReplace.exactBrep === replacementBaseline.exactBrep
      && closeTo(replacementAfterReplace.geometry.volume, 160));

  const deleteFaceProject = canonicalSaveReopen(directCreate(base, 'create-delete-face', {
    id: DELETE_FACE_ID,
    name: 'Delete boss top to shelf patch',
    operation: 'delete-face',
    targetBodyId: TARGET_BODY_ID,
    targetFace: targetTop,
    patchFace: targetPatch,
  }), 'delete-face');
  const deleteFaceFeature = directFeature(deleteFaceProject, DELETE_FACE_ID);
  assertDirectRecipe(deleteFaceFeature, 'delete-face', ['target-body', 'target-face', 'patch-face']);
  const deletedFaceBody = exactBody(
    await rebuild(kernel, deleteFaceProject, 'delete-face'),
    deleteFaceProject,
    TARGET_BODY_ID,
    'delete-face patch',
  );
  check('delete-face did not remove the exact boss material through its patch station',
    closeTo(deletedFaceBody.geometry.volume, 384));
  checkBounds('delete-face patch', deletedFaceBody.geometry.bounds, [[-6, -4, 0], [6, 4, 4]]);

  let wholeBody = runtime.createStudioV5TransformFeature(base, {
    id: 'feature-direct-whole-move',
    name: 'Move whole stepped body',
    bodyId: TARGET_BODY_ID,
    mode: 'move',
    transform: { mode: 'move', translation: [10, 0, 0] },
  });
  wholeBody = runtime.createStudioV5TransformFeature(wholeBody, {
    id: 'feature-direct-whole-rotate',
    name: 'Rotate whole stepped body',
    bodyId: TARGET_BODY_ID,
    mode: 'rotate',
    transform: { mode: 'rotate', origin: [0, 0, 0], direction: [0, 0, 1], angle: 90 },
  });
  const wholePart = runtime.studioV5RootPart(wholeBody);
  check('whole-body move/rotate did not remain ordered modifiers on the original body',
    JSON.stringify(wholePart.bodies.find((entry: JsonRecord) => entry.id === TARGET_BODY_ID).featureIds)
      === JSON.stringify([
        'feature-direct-base', 'feature-direct-boss',
        'feature-direct-whole-move', 'feature-direct-whole-rotate',
      ]));
  const wholeResult = await rebuild(kernel, wholeBody, 'whole-body-move-rotate');
  const wholeTarget = exactBody(wholeResult, wholeBody, TARGET_BODY_ID, 'whole-body move/rotate');
  check('whole-body move/rotate changed exact material volume', closeTo(wholeTarget.geometry.volume, 448));
  checkBounds('whole-body move/rotate', wholeTarget.geometry.bounds, [[-4, 4, 0], [4, 16, 8]]);
  check('whole-body move/rotate lost persistent face identity',
    wholeTarget.mesh.topologyFaces.some((entry: JsonRecord) => entry.name === targetTop.name));

  const withoutWholeBody = runtime.deleteStudioV5Body(wholeBody, TARGET_BODY_ID);
  const withoutPart = runtime.studioV5RootPart(withoutWholeBody);
  check('whole-body delete did not cascade its exact history',
    !withoutPart.bodies.some((entry: JsonRecord) => entry.id === TARGET_BODY_ID)
      && withoutPart.bodies.some((entry: JsonRecord) => entry.id === REPLACEMENT_BODY_ID)
      && !withoutPart.features.some((entry: JsonRecord) => [
        'feature-direct-base',
        'feature-direct-boss',
        'feature-direct-whole-move',
        'feature-direct-whole-rotate',
      ].includes(entry.id)));
  const deletedWholeResult = await rebuild(kernel, withoutWholeBody, 'whole-body-delete');
  assertCurrentResult(deletedWholeResult, withoutWholeBody, 'whole-body delete');
  check('whole-body delete published errors', deletedWholeResult.errors?.length === 0);
  check('whole-body delete still published the removed body',
    !deletedWholeResult.bodies.some((entry: JsonRecord) => entry.bodyId === TARGET_BODY_ID));
  const deleteSurvivor = exactBody(
    deletedWholeResult,
    withoutWholeBody,
    REPLACEMENT_BODY_ID,
    'whole-body delete survivor',
  );
  check('whole-body delete changed unrelated exact material', deleteSurvivor.exactBrep === replacementBaseline.exactBrep);

  rejection('zero push-pull distance', base, () => directCreate(base, 'zero-distance', {
    id: 'feature-direct-zero', operation: 'push-pull', targetBodyId: TARGET_BODY_ID,
    targetFace: targetTop, distance: 0,
  }), /distance|oneOf|schema|valid/u);
  rejection('oversize push-pull distance', base, () => directCreate(base, 'oversize-distance', {
    id: 'feature-direct-oversize', operation: 'push-pull', targetBodyId: TARGET_BODY_ID,
    targetFace: targetTop, distance: 1_000_001,
  }), /distance|oneOf|schema|valid/u);
  rejection('same-body replace-face reference', base, () => directCreate(base, 'same-body-replace', {
    id: 'feature-direct-same-body', operation: 'replace-face', targetBodyId: TARGET_BODY_ID,
    targetFace: targetTop, replacementBodyId: TARGET_BODY_ID, replacementFace: targetPatch,
  }), /distinct|replacement/u);
  rejection('same-face delete patch', base, () => directCreate(base, 'same-face-delete', {
    id: 'feature-direct-same-face', operation: 'delete-face', targetBodyId: TARGET_BODY_ID,
    targetFace: targetTop, patchFace: targetTop,
  }), /different|patch/u);
  rejection('immutable direct-edit operation update', pushProject, () => apply(pushProject, 'immutable-operation', [{
    kind: 'directEdit.update', input: { featureId: PUSH_ID, patch: { operation: 'delete-face' } },
  }]), /operation|patch|schema|additional/u);
  rejection('immutable direct-edit target update', pushProject, () => apply(pushProject, 'immutable-target', [{
    kind: 'directEdit.update', input: { featureId: PUSH_ID, patch: { targetBodyId: REPLACEMENT_BODY_ID } },
  }]), /targetBodyId|patch|schema|additional/u);
  rejection('generic direct-edit update bypass', pushProject, () => apply(pushProject, 'generic-update', [{
    kind: 'feature.update', input: { featureId: PUSH_ID, patch: { name: 'Bypass' } },
  }]), /directEdit\.update|Direct edits/u);
  rejection('generic direct-edit delete bypass', pushProject, () => apply(pushProject, 'generic-delete', [{
    kind: 'feature.delete', input: { featureId: PUSH_ID },
  }]), /directEdit\.delete|Direct edits/u);

  await kernel.dispose();
  kernel = null;
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  const freshPushBody = exactBody(
    await rebuild(kernel, pushProject, 'push-fresh-worker'),
    pushProject,
    TARGET_BODY_ID,
    'fresh-worker push-pull',
  );
  check('fresh worker changed the canonical exact push-pull B-rep',
    freshPushBody.exactBrep === pushBody.exactBrep
      && createHash('sha256').update(freshPushBody.exactBrep).digest('hex')
        === createHash('sha256').update(pushBody.exactBrep).digest('hex'));

  const missingName = directCreate(base, 'create-missing-name', {
    id: 'feature-direct-missing-name',
    name: 'Missing persistent target name',
    operation: 'push-pull',
    targetBodyId: TARGET_BODY_ID,
    targetFace: { name: `${targetTop.name}:missing`, sig: structuredClone(targetTop.sig) },
    distance: 2,
  });
  missingName.projectId = 'project-direct-edit-missing-name';
  await assertRefusedRebuild(
    kernel,
    projectModule.prepareStudioV5Project(missingName),
    'feature-direct-missing-name',
    'missing persistent name',
    /persistent name|name.*resolved|matched 0/u,
  );

  const nonparallel = directCreate(base, 'create-nonparallel-replace', {
    id: 'feature-direct-nonparallel',
    name: 'Nonparallel replacement refusal',
    operation: 'replace-face',
    targetBodyId: TARGET_BODY_ID,
    targetFace: targetTop,
    replacementBodyId: REPLACEMENT_BODY_ID,
    replacementFace: replacementSide,
  });
  nonparallel.projectId = 'project-direct-edit-nonparallel';
  await assertRefusedRebuild(
    kernel,
    projectModule.prepareStudioV5Project(nonparallel),
    'feature-direct-nonparallel',
    'nonparallel replacement face',
    /parallel/u,
  );

  console.log(JSON.stringify({
    schema: 'partmode.direct-editing-smoke/v2',
    wholeBody: {
      operations: ['move', 'rotate', 'delete'],
      exactVolume: wholeTarget.geometry.volume,
      exactBounds: wholeTarget.geometry.bounds,
      persistentNamePropagation: true,
      deleteCascade: true,
    },
    faceEditing: {
      operations: ['push-pull', 'replace-face', 'delete-face'],
      exactVolumes: {
        baseline: targetBaseline.geometry.volume,
        positivePush: pushBody.geometry.volume,
        negativePush: negativeBody.geometry.volume,
        replaceFace: replacedBody.geometry.volume,
        deleteFace: deletedFaceBody.geometry.volume,
      },
      typedLifecycle: ['create', 'update', 'delete'],
      persistence: ['canonical-save-reopen', 'current-document-hash', 'fresh-worker-determinism'],
      associativity: 'upstream boss height rebuilt through persistent face name',
      referencePolicy: 'persistent name first; no signature fallback once name exists',
      replacementBodyUnchanged: true,
      completeTopology: true,
    },
    failClosed: [
      'zero and oversize distances',
      'same-body replacement',
      'same-face patch',
      'immutable operation and target',
      'generic lifecycle bypass',
      'missing persistent name',
      'nonparallel replacement face',
    ],
  }, null, 2));
} finally {
  await kernel?.dispose();
}
