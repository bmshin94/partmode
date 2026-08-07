import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Structural-treatment smoke failed: ${label}`);
}

function closeTo(actual: number, expected: number, tolerance = 2e-4): boolean {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
}

function boundsClose(actual: number[][], expected: number[][], tolerance = 2e-4): boolean {
  return Array.isArray(actual) && actual.length === 2
    && actual.every((corner, cornerIndex) => Array.isArray(corner) && corner.length === 3
      && corner.every((value, axis) => {
        const expectedValue = expected[cornerIndex]?.[axis];
        return typeof expectedValue === 'number' && closeTo(value, expectedValue, tolerance);
      }));
}

function messageOf(error: unknown): string {
  return String((error as Error | null)?.message || error || '');
}

function expectFailure(label: string, action: () => unknown, pattern: RegExp): void {
  let failure: unknown = null;
  try { action(); } catch (error) { failure = error; }
  check(`${label} unexpectedly succeeded`, failure);
  check(`${label} returned the wrong refusal: ${messageOf(failure)}`, pattern.test(messageOf(failure)));
}

const root = process.cwd();
const moduleAt = async (path: string) => import(pathToFileURL(resolve(root, path)).href) as Promise<any>;
const projectModule = await moduleAt('src/static/studio-project-v5.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const agent = await moduleAt('src/static/studio-agent-service.js');
const treatments = await moduleAt('src/static/studio-structural-treatments.js');
const structural = await moduleAt('src/static/studio-structural-members.js');
const registry = await moduleAt('src/static/studio-v6-ui-registry.js');

function blankProject(projectId: string): JsonRecord {
  return runtime.createStudioV5RuntimePartProject({
  projectId,
    name: 'Structural treatment acceptance',
    units: 'mm',
    parameters: [],
    features: [],

}) as JsonRecord;
}

function apply(project: JsonRecord, transactionId: string, operations: JsonRecord[]): JsonRecord {
  return agent.applyCadTransaction(project, {
    transactionId,
    label: transactionId,
    expectedRevision: 0,
    atomic: true,
    operations,
  }).project as JsonRecord;
}

function rootPart(project: JsonRecord): JsonRecord {
  return runtime.studioV5RootPart(project) as JsonRecord;
}

function jointProjectFromPaths(projectId: string, pathA: number[][], pathB: number[][]): JsonRecord {
  return apply(blankProject(projectId), 'create-perpendicular-members', [
    {
      kind: 'sketch.path.create',
      input: { id: 'path-a', name: 'Member A path', curveKind: 'polyline', points: pathA },
    },
    {
      kind: 'sketch.path.create',
      input: { id: 'path-b', name: 'Member B path', curveKind: 'polyline', points: pathB },
    },
    {
      kind: 'structural.member.create',
      input: { id: 'member-a', name: 'Member <A>', pathSketchId: 'path-a', familyId: 'rectangular-bar', presetId: 'rect-20x10' },
    },
    {
      kind: 'structural.member.create',
      input: { id: 'member-b', name: 'Member B', pathSketchId: 'path-b', familyId: 'rectangular-bar', presetId: 'rect-20x10' },
    },
  ]);
}

function jointProject(projectId: string): JsonRecord {
  return jointProjectFromPaths(projectId, [[0, 0, 0], [100, 0, 0]], [[0, 0, 0], [0, 100, 0]]);
}

function withTreatment(projectId: string, input: JsonRecord): JsonRecord {
  return apply(jointProject(projectId), 'create-' + input.kind, [{
    kind: 'structural.treatment.create',
    input: { id: 'treatment-' + input.kind, name: input.name || input.kind, ...input },
  }]);
}

function familyEndCapProject(family: JsonRecord): { project: JsonRecord; bodyId: string; expectedVolume: number } {
  const preset = family.presets[0];
  const memberId = 'matrix-member-' + family.id;
  const treatmentId = 'matrix-cap-' + family.id;
  const project = apply(blankProject('structural-treatment-matrix-' + family.id), 'create-' + family.id + '-cap', [
    {
      kind: 'sketch.path.create',
      input: { id: 'matrix-path-' + family.id, name: family.name + ' path', curveKind: 'polyline', points: [[0, 0, 0], [0, 0, 80]] },
    },
    {
      kind: 'structural.member.create',
      input: { id: memberId, name: family.name, pathSketchId: 'matrix-path-' + family.id, familyId: family.id, presetId: preset.id },
    },
    {
      kind: 'structural.treatment.create',
      input: { id: treatmentId, name: family.name + ' end cap', kind: 'end-cap', memberId, end: 'end', thickness: 2 },
    },
  ]);
  const profile = structural.studioStructuralProfile(family.id, preset.id, { anchor: 'center', rotationDegrees: 0, offset: [0, 0] });
  return { project, bodyId: 'body-' + treatmentId, expectedVolume: profile.area * 2 };
}

check('weldment-treatment schema changed', treatments.STUDIO_WELDMENT_TREATMENT_SCHEMA === 'partmode.weldment-treatment/v1');
check('weldment-treatment kinds changed', JSON.stringify(treatments.STUDIO_WELDMENT_TREATMENT_KINDS)
  === JSON.stringify(['trim-extend', 'corner', 'gusset', 'end-cap']));
const control = (registry.cadUiControlRegistry() as JsonRecord[]).find((entry) => entry.id === 'model.structural-treatment');
check('Structural treatment is not one typed available UI command', control?.adapter === 'available'
  && control.workspaceId === 'solid'
  && JSON.stringify(control.operationKinds) === JSON.stringify([
    'structural.treatment.create', 'structural.treatment.update', 'structural.treatment.delete',
  ]));

const baseline = jointProject('structural-treatment-baseline');
const baselineSource = JSON.stringify(baseline);
const treatmentCapability = (agent.cadCapabilityManifest().operations as JsonRecord[])
  .find((entry) => entry.kind === 'structural.treatment.create');
const treatmentCreateSchemas = treatmentCapability?.inputSchema?.properties?.input?.oneOf as JsonRecord[];
check('published treatment-create contract is missing four exact variants', treatmentCreateSchemas?.length === 4);
for (const [index, schema] of treatmentCreateSchemas.entries()) {
  const idPattern = new RegExp(schema.properties.id.pattern);
  check(`treatment-create variant ${index} does not accept a 120-character source-owned ID`, idPattern.test('a'.repeat(120)));
  check(`treatment-create variant ${index} accepts an ID above the source-owned limit`, !idPattern.test('a'.repeat(121)));
  for (const field of ['distance', 'leftLegLength', 'rightLegLength', 'thickness']) {
    if (schema.properties[field]) {
      check(`treatment-create variant ${index} ${field} lower bound drifted`, schema.properties[field].exclusiveMinimum === 1e-7);
    }
  }
}
const trim = withTreatment('structural-treatment-trim', {
  kind: 'trim-extend', memberId: 'member-a', end: 'start', mode: 'trim', distance: 10,
});
const trimChecked = runtime.assertStudioWeldmentTreatmentDocument(trim, 'treatment-trim-extend') as JsonRecord;
check('trim recipe is detached from its exact member/body/end', trimChecked.recipe.kind === 'trim-extend'
  && trimChecked.recipe.memberId === 'member-a'
  && trimChecked.recipe.memberBodyId === 'body-member-a'
  && trimChecked.recipe.end === 'start'
  && trimChecked.recipe.mode === 'trim'
  && trimChecked.recipe.distance === 10);
check('trim did not remain one downstream modifier on the source body', rootPart(trim).bodies.length === 2
  && rootPart(trim).bodies.find((body: JsonRecord) => body.id === 'body-member-a')?.featureIds.at(-1) === 'treatment-trim-extend');

const extended = apply(trim, 'edit-trim-to-extend', [{
  kind: 'structural.treatment.update',
  input: { featureId: 'treatment-trim-extend', patch: { name: 'Extended <member>', mode: 'extend', distance: 5 } },
}]);
const extendedChecked = runtime.assertStudioWeldmentTreatmentDocument(extended, 'treatment-trim-extend') as JsonRecord;
check('trim-to-extend edit changed persistent association identity', extendedChecked.recipe.featureId === trimChecked.recipe.featureId
  && extendedChecked.recipe.memberId === trimChecked.recipe.memberId
  && extendedChecked.recipe.memberBodyId === trimChecked.recipe.memberBodyId
  && extendedChecked.recipe.end === trimChecked.recipe.end
  && extendedChecked.recipe.mode === 'extend'
  && extendedChecked.recipe.distance === 5);

const miter = withTreatment('structural-treatment-miter', {
  kind: 'corner', targetMemberId: 'member-a', targetEnd: 'start', otherMemberId: 'member-b', otherEnd: 'start', style: 'miter',
});
const reciprocalMiter = apply(miter, 'create-reciprocal-miter', [{
  kind: 'structural.treatment.create',
  input: {
    id: 'treatment-reciprocal-miter', kind: 'corner',
    targetMemberId: 'member-b', targetEnd: 'start', otherMemberId: 'member-a', otherEnd: 'start', style: 'miter',
  },
}]);
const cope = withTreatment('structural-treatment-cope', {
  kind: 'corner', targetMemberId: 'member-a', targetEnd: 'start', otherMemberId: 'member-b', otherEnd: 'start', style: 'cope',
});
const gusset = withTreatment('structural-treatment-gusset', {
  kind: 'gusset', leftMemberId: 'member-a', leftEnd: 'start', rightMemberId: 'member-b', rightEnd: 'start',
  leftLegLength: 30, rightLegLength: 30, thickness: 4,
});
const endCap = withTreatment('structural-treatment-end-cap', {
  kind: 'end-cap', memberId: 'member-a', end: 'end', thickness: 3,
});
const oppositeEndCapAfterTrim = apply(trim, 'create-opposite-end-cap-after-trim', [{
  kind: 'structural.treatment.create',
  input: { id: 'treatment-opposite-end-cap', name: 'Opposite end cap', kind: 'end-cap', memberId: 'member-a', end: 'end', thickness: 3 },
}]);

const mixedEndBase = jointProjectFromPaths(
  'structural-treatment-mixed-end-base',
  [[-100, 0, 0], [0, 0, 0]],
  [[0, 0, 0], [0, 100, 0]],
);
const mixedEndMiter = apply(mixedEndBase, 'create-mixed-end-miter', [{
  kind: 'structural.treatment.create',
  input: { id: 'mixed-end-miter', kind: 'corner', targetMemberId: 'member-a', targetEnd: 'end', otherMemberId: 'member-b', otherEnd: 'start', style: 'miter' },
}]);
const mixedEndCope = apply(mixedEndBase, 'create-mixed-end-cope', [{
  kind: 'structural.treatment.create',
  input: { id: 'mixed-end-cope', kind: 'corner', targetMemberId: 'member-a', targetEnd: 'end', otherMemberId: 'member-b', otherEnd: 'start', style: 'cope' },
}]);
const angle = Math.PI / 6;
const rotatedEnd = [100 * Math.cos(angle), 100 * Math.sin(angle), 0];
const rotatedOtherEnd = [-100 * Math.sin(angle), 100 * Math.cos(angle), 0];
const rotatedBase = jointProjectFromPaths(
  'structural-treatment-rotated-base',
  [[0, 0, 0], rotatedEnd],
  [[0, 0, 0], rotatedOtherEnd],
);
const rotatedMiter = apply(rotatedBase, 'create-rotated-miter', [{
  kind: 'structural.treatment.create',
  input: { id: 'rotated-miter', kind: 'corner', targetMemberId: 'member-a', targetEnd: 'start', otherMemberId: 'member-b', otherEnd: 'start', style: 'miter' },
}]);
const rotatedCope = apply(rotatedBase, 'create-rotated-cope', [{
  kind: 'structural.treatment.create',
  input: { id: 'rotated-cope', kind: 'corner', targetMemberId: 'member-a', targetEnd: 'start', otherMemberId: 'member-b', otherEnd: 'start', style: 'cope' },
}]);

for (const [label, project, featureId, kind, bodyCount] of [
  ['miter', miter, 'treatment-corner', 'corner', 2],
  ['cope', cope, 'treatment-corner', 'corner', 2],
  ['gusset', gusset, 'treatment-gusset', 'gusset', 3],
  ['end cap', endCap, 'treatment-end-cap', 'end-cap', 3],
] as const) {
  const checked = runtime.assertStudioWeldmentTreatmentDocument(project, featureId) as JsonRecord;
  check(`${label} kind or owned body count is wrong`, checked.recipe.kind === kind && rootPart(project).bodies.length === bodyCount);
  const saved = JSON.stringify(projectModule.prepareStudioV5Project(project));
  const reopened = projectModule.parseStudioV5Project(saved) as JsonRecord;
  check(`${label} changed canonical bytes across save/reopen`, JSON.stringify(reopened) === saved
    && JSON.stringify(runtime.assertStudioWeldmentTreatmentDocument(reopened, featureId)) === JSON.stringify(checked));
}

function expectAtomicFailure(label: string, source: JsonRecord, operations: JsonRecord[], pattern: RegExp): void {
  const before = JSON.stringify(source);
  expectFailure(label, () => apply(source, 'reject-' + label.replace(/[^a-z0-9]+/giu, '-'), operations), pattern);
  check(`${label} mutated its source`, JSON.stringify(source) === before);
}

expectAtomicFailure('same-member corner', baseline, [{
  kind: 'structural.treatment.create',
  input: { id: 'bad-corner', kind: 'corner', targetMemberId: 'member-a', targetEnd: 'start', otherMemberId: 'member-a', otherEnd: 'start', style: 'miter' },
}], /two different structural members/u);
expectAtomicFailure('noncoincident corner', baseline, [{
  kind: 'structural.treatment.create',
  input: { id: 'bad-joint', kind: 'corner', targetMemberId: 'member-a', targetEnd: 'end', otherMemberId: 'member-b', otherEnd: 'end', style: 'miter' },
}], /endpoints must coincide/u);
expectAtomicFailure('zero trim', baseline, [{
  kind: 'structural.treatment.create',
  input: { id: 'zero-trim', kind: 'trim-extend', memberId: 'member-a', end: 'start', mode: 'trim', distance: 0 },
}], /distance|exclusiveMinimum|greater than/u);
expectAtomicFailure('source-limit trim', baseline, [{
  kind: 'structural.treatment.create',
  input: { id: 'treatment-source-limit', kind: 'trim-extend', memberId: 'member-a', end: 'start', mode: 'trim', distance: 1e-7 },
}], /distance|exclusiveMinimum|greater than/u);
expectAtomicFailure('overlong treatment ID', baseline, [{
  kind: 'structural.treatment.create',
  input: { id: 'a'.repeat(121), kind: 'trim-extend', memberId: 'member-a', end: 'start', mode: 'trim', distance: 1 },
}], /ID must contain|pattern|schema|match/u);
expectAtomicFailure('whole-member trim', baseline, [{
  kind: 'structural.treatment.create',
  input: { id: 'whole-trim', kind: 'trim-extend', memberId: 'member-a', end: 'start', mode: 'trim', distance: 100 },
}], /positive exact member length/u);
expectAtomicFailure('generic treatment update bypass', trim, [{
  kind: 'feature.update', input: { featureId: 'treatment-trim-extend', patch: { name: 'Bypass' } },
}], /structural\.treatment\.update/u);
expectAtomicFailure('association-changing treatment patch', trim, [{
  kind: 'structural.treatment.update', input: { featureId: 'treatment-trim-extend', patch: { memberId: 'member-b' } },
}], /unsupported field|cannot change|additional/u);
expectAtomicFailure('delete treated member', trim, [{
  kind: 'feature.delete', input: { featureId: 'member-a' },
}], /used by weldment treatments/u);
expectAtomicFailure('stacked treatment on one member endpoint', trim, [{
  kind: 'structural.treatment.create',
  input: { id: 'detached-cap', kind: 'end-cap', memberId: 'member-a', end: 'start', thickness: 3 },
}], /already claimed by weldment treatment/u);

const tampered = JSON.parse(JSON.stringify(trim)) as JsonRecord;
rootPart(tampered).features.find((feature: JsonRecord) => feature.id === 'treatment-trim-extend')
  .extensions.weldmentTreatment.distance = -5;
expectFailure('tampered negative persisted distance', () => projectModule.prepareStudioV5Project(tampered), /above zero|canonical/u);
check('tamper test changed authoritative trim source', JSON.stringify(trim) !== JSON.stringify(tampered));

const deletedTrim = apply(trim, 'delete-trim-treatment', [{
  kind: 'structural.treatment.delete', input: { featureId: 'treatment-trim-extend' },
}]);
check('typed trim delete did not restore the source document graph', rootPart(deletedTrim).features.length === 2
  && rootPart(deletedTrim).bodies.length === 2
  && !rootPart(deletedTrim).features.some((feature: JsonRecord) => feature.extensions?.weldmentTreatment));
const deletedGusset = apply(gusset, 'delete-gusset-treatment', [{
  kind: 'structural.treatment.delete', input: { featureId: 'treatment-gusset' },
}]);
check('typed gusset delete did not remove its owned body', rootPart(deletedGusset).features.length === 2
  && rootPart(deletedGusset).bodies.length === 2
  && !rootPart(deletedGusset).bodies.some((body: JsonRecord) => body.createdByFeatureId === 'treatment-gusset'));
check('document commands mutated the baseline source', JSON.stringify(baseline) === baselineSource);
const familyEndCaps = (structural.STUDIO_STRUCTURAL_PROFILE_FAMILIES as JsonRecord[]).map(familyEndCapProject);

function topologyNames(body: JsonRecord): { faces: string[]; edges: string[]; vertices: string[] } {
  return {
    faces: (body.mesh?.topologyFaces || []).map((entry: JsonRecord) => entry.name).sort(),
    edges: (body.mesh?.edges || []).map((entry: JsonRecord) => entry.name).sort(),
    vertices: (body.mesh?.topologyVertices || []).map((entry: JsonRecord) => entry.name).sort(),
  };
}

function assertExactBody(result: JsonRecord, project: JsonRecord, revision: number, bodyId: string, label: string): JsonRecord {
  check(`${label} returned stale revision`, result.kind === 'rebuild-result' && result.revision === revision);
  check(`${label} returned stale document hash`, result.effectiveDocumentHash === runtime.studioV5CanonicalHash(project));
  check(`${label} exact rebuild errors: ${JSON.stringify(result.errors || [])}`, result.errors?.length === 0);
  check(`${label} exact rebuild warnings: ${JSON.stringify(result.warnings || [])}`, result.warnings?.length === 0);
  const body = result.bodies?.find((entry: JsonRecord) => entry.bodyId === bodyId);
  check(`${label} omitted exact body ${bodyId}`, body);
  check(`${label} published invalid or last-valid geometry`, !body.error && body.lastValid === false
    && body.geometry?.valid === true && body.geometry?.brepValid === true
    && body.geometry?.solidCount === 1 && body.geometry?.shellCount === 1
    && typeof body.exactBrep === 'string' && body.exactBrep.length > 100);
  const counts = body.mesh?.topologyCounts;
  const names = topologyNames(body);
  check(`${label} did not name every exact face`, counts?.faces === body.geometry.faceCount
    && counts?.namedFaces === counts?.faces && names.faces.length === counts.faces
    && names.faces.every(Boolean) && new Set(names.faces).size === names.faces.length);
  check(`${label} did not name every exact edge`, counts?.edges === body.geometry.edgeCount
    && counts?.namedEdges === counts?.edges && counts?.authoritativeNamedEdgeCount === counts?.exactEdgeCount
    && names.edges.length === counts.edges && names.edges.every(Boolean) && new Set(names.edges).size === names.edges.length);
  check(`${label} did not name every exact vertex`, counts?.vertices === body.geometry.vertexCount
    && counts?.namedVertices === counts?.vertices && counts?.namedVertexCount === counts?.exactVertexCount
    && names.vertices.length === counts.vertices && names.vertices.every(Boolean) && new Set(names.vertices).size === names.vertices.length);
  check(`${label} topology diagnostics are not empty: ${JSON.stringify(body.mesh?.topologyDiagnostics || [])}`,
    Array.isArray(body.mesh?.topologyDiagnostics) && body.mesh.topologyDiagnostics.length === 0);
  return body;
}

async function rebuild(kernel: HeadlessKernel, project: JsonRecord, revision: number, label: string): Promise<JsonRecord> {
  return kernel.request({
    kind: 'rebuild',
    requestId: `structural-treatment-${revision}-${label}`,
    projectId: project.projectId,
    revision,
    document: project,
    includeExactBrep: true,
  }, 180_000) as Promise<JsonRecord>;
}

let kernel: HeadlessKernel | null = null;
let freshKernel: HeadlessKernel | null = null;
let revision = 0;
const exactEvidence: JsonRecord[] = [];
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  const baselineResult = await rebuild(kernel, baseline, ++revision, 'baseline');
  const baselineA = assertExactBody(baselineResult, baseline, revision, 'body-member-a', 'baseline member A');
  check('baseline member volume drifted', closeTo(baselineA.geometry.volume, 20_000));
  check(`baseline member bounds drifted: ${JSON.stringify(baselineA.geometry.bounds)}`,
    boundsClose(baselineA.geometry.bounds, [[0, -5, -10], [100, 5, 10]]));

  const cases: Array<[string, JsonRecord, string, (body: JsonRecord) => void]> = [
    ['trim', trim, 'body-member-a', (body) => check('trim exact volume is wrong', closeTo(body.geometry.volume, 18_000))],
    ['extend', extended, 'body-member-a', (body) => check('extend exact volume is wrong', closeTo(body.geometry.volume, 21_000))],
    ['miter', miter, 'body-member-a', (body) => check('miter exact 90-degree wedge volume or bounds are wrong',
      closeTo(body.geometry.volume, 19_750) && boundsClose(body.geometry.bounds, baselineA.geometry.bounds))],
    ['reciprocal-miter', reciprocalMiter, 'body-member-a', (body) => check('reciprocal miter changed the first exact wedge',
      closeTo(body.geometry.volume, 19_750) && boundsClose(body.geometry.bounds, baselineA.geometry.bounds))],
    ['cope', cope, 'body-member-a', (body) => check('cope exact 90-degree overlap volume or bounds are wrong',
      closeTo(body.geometry.volume, 19_500) && boundsClose(body.geometry.bounds, baselineA.geometry.bounds))],
    ['mixed-end-miter', mixedEndMiter, 'body-member-a', (body) => check('mixed start/end miter exact volume or bounds are wrong',
      closeTo(body.geometry.volume, 19_750) && boundsClose(body.geometry.bounds, [[-100, -5, -10], [0, 5, 10]]))],
    ['mixed-end-cope', mixedEndCope, 'body-member-a', (body) => check('mixed start/end cope exact volume or bounds are wrong',
      closeTo(body.geometry.volume, 19_500) && boundsClose(body.geometry.bounds, [[-100, -5, -10], [0, 5, 10]]))],
    ['rotated-miter', rotatedMiter, 'body-member-a', (body) => check('non-axis-aligned miter exact volume is wrong', closeTo(body.geometry.volume, 19_750))],
    ['rotated-cope', rotatedCope, 'body-member-a', (body) => check('non-axis-aligned cope exact volume is wrong', closeTo(body.geometry.volume, 19_500))],
    ['gusset', gusset, 'body-treatment-gusset', (body) => check('gusset exact volume is not triangle area × thickness', closeTo(body.geometry.volume, 1_800))],
    ['end-cap', endCap, 'body-treatment-end-cap', (body) => check('end-cap exact volume is not member area × thickness', closeTo(body.geometry.volume, 600))],
    ['opposite-end-cap-after-trim', oppositeEndCapAfterTrim, 'body-treatment-opposite-end-cap', (body) =>
      check('opposite-end cap after trim is detached or has wrong exact volume', closeTo(body.geometry.volume, 600)
        && boundsClose(body.geometry.bounds, [[100, -5, -10], [103, 5, 10]]))],
  ];
  for (const [label, project, bodyId, assertion] of cases) {
    const result = await rebuild(kernel, project, ++revision, label);
    const body = assertExactBody(result, project, revision, bodyId, label);
    assertion(body);
    if (label === 'reciprocal-miter') {
      const otherBody = assertExactBody(result, project, revision, 'body-member-b', 'reciprocal miter other member');
      check('reciprocal miter did not cut the other exact member analytically', closeTo(otherBody.geometry.volume, 19_750));
    }
    if (label === 'opposite-end-cap-after-trim') {
      const sourceBody = assertExactBody(result, project, revision, 'body-member-a', 'opposite-end cap treated source');
      check('opposite-end cap disturbed the trimmed source history', closeTo(sourceBody.geometry.volume, 18_000)
        && boundsClose(sourceBody.geometry.bounds, [[10, -5, -10], [100, 5, 10]]));
    }
    exactEvidence.push({
      label,
      bodyId,
      volumeMm3: body.geometry.volume,
      brepSha256: createHash('sha256').update(body.exactBrep).digest('hex'),
      documentHash: result.effectiveDocumentHash,
      topology: body.mesh.topologyCounts,
    });
  }
  for (const [index, familyCase] of familyEndCaps.entries()) {
    const family = structural.STUDIO_STRUCTURAL_PROFILE_FAMILIES[index] as JsonRecord;
    const label = 'end-cap-' + family.id;
    const result = await rebuild(kernel, familyCase.project, ++revision, label);
    const body = assertExactBody(result, familyCase.project, revision, familyCase.bodyId, label);
    check(`${label} does not use the complete catalog profile area`, closeTo(body.geometry.volume, familyCase.expectedVolume));
    exactEvidence.push({
      label,
      bodyId: familyCase.bodyId,
      volumeMm3: body.geometry.volume,
      brepSha256: createHash('sha256').update(body.exactBrep).digest('hex'),
      documentHash: result.effectiveDocumentHash,
      topology: body.mesh.topologyCounts,
    });
  }

  const deletedResult = await rebuild(kernel, deletedTrim, ++revision, 'delete-restores-source');
  const restoredA = assertExactBody(deletedResult, deletedTrim, revision, 'body-member-a', 'delete restores source');
  check('typed delete did not restore source B-rep bytes', restoredA.exactBrep === baselineA.exactBrep
    && JSON.stringify(restoredA.geometry) === JSON.stringify(baselineA.geometry)
    && JSON.stringify(topologyNames(restoredA)) === JSON.stringify(topologyNames(baselineA)));

  const associative = apply(trim, 'extend-treated-member-path', [{
    kind: 'sketch.advanced.update',
    input: { sketchId: 'path-a', patch: { kind: 'polyline', points: [[0, 0, 0], [120, 0, 0]] } },
  }]);
  const associativeResult = await rebuild(kernel, associative, ++revision, 'associative-path-edit');
  const associativeBody = assertExactBody(associativeResult, associative, revision, 'body-member-a', 'associative path edit');
  check('trim did not rebuild associatively from the edited member path', closeTo(associativeBody.geometry.volume, 22_000));

  await kernel.dispose();
  kernel = null;
  freshKernel = await createHeadlessKernel();
  await freshKernel.waitForKernel();
  const freshResult = await rebuild(freshKernel, endCap, 1, 'fresh-worker');
  const freshCap = assertExactBody(freshResult, endCap, 1, 'body-treatment-end-cap', 'fresh-worker end cap');
  const priorCap = exactEvidence.find((entry) => entry.label === 'end-cap');
  check('fresh production worker changed deterministic end-cap B-rep',
    createHash('sha256').update(freshCap.exactBrep).digest('hex') === priorCap?.brepSha256);

  const [moduleSource, runtimeSource, projectSource, featureTypeSource, workerSource, agentSource, pageSource, studioSource, registrySource, buildSource] = await Promise.all([
    readFile(resolve(root, 'src/static/studio-structural-treatments.js'), 'utf8'),
    readFile(resolve(root, 'src/static/studio-v5-runtime-document.js'), 'utf8'),
    readFile(resolve(root, 'src/static/studio-project-v5.js'), 'utf8'),
    readFile(resolve(root, 'src/static/studio-v5-feature-types.js'), 'utf8'),
    readFile(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8'),
    readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
    readFile(resolve(root, 'src/page.html'), 'utf8'),
    readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
    readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
    readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
  ]);
  check('source-owned treatment module imports DOM or OCCT', !/\/static\/vendor|document\.|window\.|OpenCascade|replicad/iu.test(moduleSource));
  check('runtime omits typed treatment lifecycle', runtimeSource.includes('export function createStudioWeldmentTreatment')
    && runtimeSource.includes('export function updateStudioWeldmentTreatment')
    && runtimeSource.includes('export function deleteStudioWeldmentTreatment'));
  check('project or feature contracts omit fail-closed treatment validation', projectSource.includes('assertStudioWeldmentTreatmentPart(')
    && featureTypeSource.includes("'weldment-treatment': contract('weldment-treatment', ['add', 'new-body'])"));
  check('production worker omits exact treatment evaluation', workerSource.includes('assertStudioWeldmentTreatmentPart(')
    && workerSource.includes('weldmentTreatment'));
  check('agent protocol omits typed operations or bypass guards', agentSource.includes("'structural.treatment.create'")
    && agentSource.includes("'structural.treatment.update'")
    && agentSource.includes("'structural.treatment.delete'")
    && agentSource.includes('Weldment treatments must be edited through structural.treatment.update.'));
  check('visible UI omits treatment ribbon/dialog/lifecycle', pageSource.includes('id="bw-structural-treatment-open"')
    && pageSource.includes('id="bw-structural-treatment-form"')
    && studioSource.includes("'structural.treatment.create'")
    && studioSource.includes("'structural.treatment.update'"));
  check('UI denominator or release asset omits treatments', registrySource.includes("control('model.structural-treatment'")
    && buildSource.includes("'studio-structural-treatments.js'"));

  console.log(JSON.stringify({
    schema: 'partmode.structural-treatments-smoke/v1',
    exactProductionRebuilds: exactEvidence.length + 4,
    capabilities: {
      trimExtend: ['trim', 'extend'],
      cornerTreatments: ['miter', 'cope'],
      cornerFixtures: ['start/start', 'end/start', 'non-axis-aligned', 'reciprocal-miter'],
      gusset: 'exact triangular plate body',
      endCap: 'exact catalog-profile plate body',
    },
    evidence: exactEvidence,
    lifecycle: {
      typedCreateUpdateDelete: true,
      stableAssociationsAcrossUpdate: true,
      deleteRestoresSourceBrep: true,
      saveReopen: true,
      freshWorkerDeterminism: true,
      associativeMemberPathEdit: true,
      oppositeEndpointComposition: true,
    },
    refusals: [
      'same member', 'noncoincident endpoints', 'zero/whole-member trim', 'generic update bypass',
      'association-changing patch', 'treated-member deletion', 'same-endpoint stacking',
      'overlong ID/source-limit dimension', 'tampered recipe',
    ],
  }, null, 2));
} finally {
  await kernel?.dispose();
  await freshKernel?.dispose();
}
