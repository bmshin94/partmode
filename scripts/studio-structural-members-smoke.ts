import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

interface StructuralCase {
  familyId: string;
  presetId: string;
  memberId: string;
  pathId: string;
  profile: JsonRecord;
  created: JsonRecord;
  reopened: JsonRecord;
  saved: string;
}

interface ExactBodyEvidence {
  result: JsonRecord;
  body: JsonRecord;
  brepSha256: string;
  faces: string[];
  edges: string[];
  vertices: string[];
}

interface SameFamilyPresetEdit {
  familyId: string;
  fromPresetId: string;
  toPresetId: string;
  baseline: StructuralCase;
  edited: JsonRecord;
  profile: JsonRecord;
}

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Structural-member smoke failed: ${label}`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function closeTo(actual: number, expected: number, tolerance = 2e-4): boolean {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function messageOf(error: unknown): string {
  return String((error as Error | null)?.message || error || '');
}

function expectFailure(label: string, action: () => unknown, pattern?: RegExp): void {
  let failure: unknown = null;
  try { action(); } catch (error) { failure = error; }
  check(`${label} unexpectedly succeeded`, failure);
  if (pattern) check(`${label} returned the wrong refusal: ${messageOf(failure)}`, pattern.test(messageOf(failure)));
}

const root = process.cwd();
const moduleAt = async (path: string) => import(pathToFileURL(resolve(root, path)).href) as Promise<any>;
const structural = await moduleAt('src/static/studio-structural-members.js');
const projectModule = await moduleAt('src/static/studio-project-v5.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const modeling = await moduleAt('src/static/studio-v5-modeling.js');
const agent = await moduleAt('src/static/studio-agent-service.js');
const uiRegistry = await moduleAt('src/static/studio-v6-ui-registry.js');

function blankProject(projectId: string): JsonRecord {
  return runtime.createStudioV5RuntimePartProject({
  projectId,
    name: 'Structural member acceptance',
    units: 'mm',
    parameters: [],
    features: [],

}) as JsonRecord;
}

function rootPart(project: JsonRecord): JsonRecord {
  return runtime.studioV5RootPart(project) as JsonRecord;
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

function expectAtomicFailure(
  label: string,
  source: JsonRecord,
  operations: JsonRecord[],
  pattern?: RegExp,
): void {
  const before = JSON.stringify(source);
  expectFailure(label, () => apply(source, `reject-${label.replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`, operations), pattern);
  check(`${label} mutated its source document`, JSON.stringify(source) === before);
}

function canonicalReopen(project: JsonRecord, label: string): { saved: string; reopened: JsonRecord } {
  const saved = JSON.stringify(projectModule.prepareStudioV5Project(project));
  const reopened = projectModule.parseStudioV5Project(saved) as JsonRecord;
  check(`${label} changed canonical bytes across save/reopen`, JSON.stringify(reopened) === saved);
  return { saved, reopened };
}

function independentPolygonArea(points: number[][]): number {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return sum + point[0]! * next[1]! - next[0]! * point[1]!;
  }, 0) / 2);
}

const families = structural.STUDIO_STRUCTURAL_PROFILE_FAMILIES as JsonRecord[];
check('catalog must contain exactly five profile families', families.length === 5);
check('catalog family IDs changed', JSON.stringify(families.map((family) => family.id))
  === JSON.stringify(['rectangular-bar', 'equal-angle', 'channel', 'i-section', 'tee']));
check('every profile family must expose exactly three presets', families.every((family) => family.presets?.length === 3));
const catalogEntries = families.flatMap((family) => family.presets.map((preset: JsonRecord) => ({ family, preset })));
check('catalog must contain exactly 15 presets', catalogEntries.length === 15);
check('catalog preset IDs must be globally unique', new Set(catalogEntries.map(({ preset }) => preset.id)).size === 15);
check('catalog version changed', structural.STUDIO_STRUCTURAL_PROFILE_CATALOG_VERSION === 1);
check('catalog provenance changed', JSON.stringify(structural.STUDIO_STRUCTURAL_PROFILE_SOURCE) === JSON.stringify({
  id: 'partmode-generic-metric-structural-profiles',
  title: 'PartMode generic metric structural profiles',
  edition: '1',
  status: 'unstandardized nominal design aid',
}));

const defaultPlacement = { anchor: 'center', rotationDegrees: 0, offset: [0, 0] };
const profileByPreset = new Map<string, JsonRecord>();
for (const { family, preset } of catalogEntries) {
  const profile = structural.studioStructuralProfile(family.id, preset.id, defaultPlacement) as JsonRecord;
  profileByPreset.set(preset.id, profile);
  check(`${preset.id} lost source-owned catalog provenance`, profile.schema === structural.STUDIO_STRUCTURAL_PROFILE_LIBRARY_SCHEMA
    && profile.catalogVersion === structural.STUDIO_STRUCTURAL_PROFILE_CATALOG_VERSION
    && JSON.stringify(profile.source) === JSON.stringify(structural.STUDIO_STRUCTURAL_PROFILE_SOURCE));
  check(`${preset.id} catalog designation or dimensions drifted`, profile.familyId === family.id
    && profile.familyName === family.name
    && profile.presetId === preset.id
    && profile.designation === preset.designation
    && Object.keys(profile.dimensions).length === Object.keys(preset.dimensions).length
    && Object.entries(preset.dimensions).every(([key, value]) => profile.dimensions[key] === value));
  check(`${preset.id} does not define a bounded simple polygon`, Array.isArray(profile.points)
    && profile.points.length >= 4
    && profile.points.every((point: unknown) => Array.isArray(point)
      && point.length === 2
      && point.every((coordinate: unknown) => typeof coordinate === 'number' && Number.isFinite(coordinate))));
  check(`${preset.id} area is not independently reproducible`, closeTo(profile.area, independentPolygonArea(profile.points), 1e-9)
    && profile.area > 0);
}

const structuralControl = (uiRegistry.cadUiControlRegistry() as JsonRecord[])
  .find((entry) => entry.id === 'model.structural-member') || null;
check('Structural member is not a typed available UI command', structuralControl?.adapter === 'available'
  && structuralControl.workspaceId === 'solid'
  && JSON.stringify(structuralControl.operationKinds) === JSON.stringify(['structural.member.create', 'structural.member.update']));
const familyField = structuralControl?.fields?.find((field: JsonRecord) => field.id === 'familyId');
const presetField = structuralControl?.fields?.find((field: JsonRecord) => field.id === 'presetId');
check('UI registry does not expose all source-owned profile choices', JSON.stringify(familyField?.values) === JSON.stringify(families.map((family) => family.id))
  && JSON.stringify(presetField?.values) === JSON.stringify(catalogEntries.map(({ preset }) => preset.id)));

const pathLength = 120;
const cases: StructuralCase[] = catalogEntries.map(({ family, preset }) => {
  const memberId = `member-${preset.id}`;
  const pathId = `path-${preset.id}`;
  const source = blankProject(`project-structural-${preset.id}`);
  const sourceSnapshot = JSON.stringify(source);
  const created = apply(source, `create-${preset.id}`, [
    {
      kind: 'sketch.path.create',
      input: {
        id: pathId,
        name: `${preset.designation} path`,
        curveKind: 'polyline',
        points: [[0, 0, 0], [0, 0, pathLength]],
      },
    },
    {
      kind: 'structural.member.create',
      input: {
        id: memberId,
        name: preset.designation,
        bodyName: `${preset.designation} body`,
        pathSketchId: pathId,
        familyId: family.id,
        presetId: preset.id,
        placement: defaultPlacement,
      },
    },
  ]);
  check(`${preset.id} typed create mutated its input`, JSON.stringify(source) === sourceSnapshot);
  const part = rootPart(created);
  check(`${preset.id} did not persist exactly one source feature/body`, part.features.length === 1 && part.bodies.length === 1);
  const checked = runtime.assertStudioStructuralMemberDocument(created, memberId) as JsonRecord;
  check(`${preset.id} stored recipe is detached from its catalog profile`, checked.recipe.familyId === family.id
    && checked.recipe.presetId === preset.id
    && checked.recipe.pathPolicy === 'exact-two-point-single-segment'
    && checked.recipe.cornerPolicy === 'single-member-without-trim-or-corner-treatment'
    && checked.recipe.complianceStatus === 'generic-profile-design-aid-not-manufacturing-certification'
    && JSON.stringify(checked.profile.points) === JSON.stringify(profileByPreset.get(preset.id)!.points));
  const owned = structural.studioStructuralMemberOwnedIds(memberId) as JsonRecord;
  check(`${preset.id} owned helper identity is incomplete`, part.referenceGeometry.some((entry: JsonRecord) => entry.id === owned.profilePlaneId)
    && part.sketches.some((entry: JsonRecord) => entry.id === owned.profileSketchId)
    && part.sketches.some((entry: JsonRecord) => entry.id === pathId));
  check(`${preset.id} part-level library provenance is absent`, JSON.stringify(part.extensions?.structuralProfileLibrary) === JSON.stringify({
    schema: structural.STUDIO_STRUCTURAL_PROFILE_LIBRARY_SCHEMA,
    version: structural.STUDIO_STRUCTURAL_PROFILE_CATALOG_VERSION,
    source: structural.STUDIO_STRUCTURAL_PROFILE_SOURCE,
  }));
  const { saved, reopened } = canonicalReopen(created, preset.id);
  const reopenedCheck = runtime.assertStudioStructuralMemberDocument(reopened, memberId) as JsonRecord;
  check(`${preset.id} save/reopen changed owned identity or catalog evidence`, JSON.stringify(reopenedCheck) === JSON.stringify(checked));
  return {
    familyId: family.id,
    presetId: preset.id,
    memberId,
    pathId,
    profile: profileByPreset.get(preset.id)!,
    created,
    reopened,
    saved,
  };
});

function sortedNames(entries: JsonRecord[] | undefined): string[] {
  return (entries || []).map((entry) => String(entry.name || '')).sort();
}

function assertExactStructuralBody(
  result: JsonRecord,
  project: JsonRecord,
  revision: number,
  profile: JsonRecord,
  length: number,
  label: string,
): ExactBodyEvidence {
  check(`${label} expected rebuild-result, received ${result.kind}`, result.kind === 'rebuild-result');
  check(`${label} returned stale revision ${String(result.revision)}`, result.revision === revision);
  const expectedHash = runtime.studioV5CanonicalHash(project);
  check(`${label} returned stale document hash`, result.effectiveDocumentHash === expectedHash && /^[0-9a-f]{64}$/u.test(expectedHash));
  check(`${label} production rebuild errors: ${JSON.stringify(result.errors || [])}`, Array.isArray(result.errors) && result.errors.length === 0);
  check(`${label} production rebuild warnings: ${JSON.stringify(result.warnings || [])}`, Array.isArray(result.warnings) && result.warnings.length === 0);
  check(`${label} expected one rebuilt body, received ${result.bodies?.length ?? 0}`, result.bodies?.length === 1);
  const body = result.bodies[0] as JsonRecord;
  check(`${label} published a failed or last-valid body`, !body.error && body.lastValid === false);
  check(`${label} is not one valid exact B-rep solid`, body.geometry?.valid === true
    && body.geometry?.brepValid === true
    && body.geometry?.solidCount === 1
    && body.geometry?.shellCount === 1);
  check(`${label} canonical B-rep evidence is missing`, typeof body.exactBrep === 'string' && body.exactBrep.length > 100);
  const expectedVolume = profile.area * length;
  check(`${label} exact volume ${body.geometry?.volume} differs from area × length ${expectedVolume}`,
    closeTo(Number(body.geometry?.volume), expectedVolume, Math.max(2e-4, expectedVolume * 1e-9)));
  const profileEdges = profile.points.length;
  const expectedCounts = { faces: profileEdges + 2, edges: profileEdges * 3, vertices: profileEdges * 2 };
  const counts = body.mesh?.topologyCounts;
  const faces = sortedNames(body.mesh?.topologyFaces);
  const edges = sortedNames(body.mesh?.edges);
  const vertices = sortedNames(body.mesh?.topologyVertices);
  check(`${label} exact topology counts do not match the source polygon`, body.geometry?.faceCount === expectedCounts.faces
    && body.geometry?.edgeCount === expectedCounts.edges
    && body.geometry?.vertexCount === expectedCounts.vertices
    && counts?.faces === expectedCounts.faces
    && counts?.edges === expectedCounts.edges
    && counts?.vertices === expectedCounts.vertices);
  check(`${label} does not name every exact face`, counts?.namedFaces === counts?.faces
    && faces.length === counts?.faces
    && faces.every(Boolean)
    && new Set(faces).size === faces.length);
  check(`${label} does not name every exact edge`, counts?.namedEdges === counts?.edges
    && counts?.authoritativeNamedEdgeCount === counts?.exactEdgeCount
    && edges.length === counts?.edges
    && edges.every(Boolean)
    && new Set(edges).size === edges.length);
  check(`${label} does not name every exact vertex`, counts?.namedVertices === counts?.vertices
    && counts?.namedVertexCount === counts?.exactVertexCount
    && vertices.length === counts?.vertices
    && vertices.every(Boolean)
    && new Set(vertices).size === vertices.length);
  check(`${label} topology diagnostics are not empty: ${JSON.stringify(body.mesh?.topologyDiagnostics || [])}`,
    Array.isArray(body.mesh?.topologyDiagnostics) && body.mesh.topologyDiagnostics.length === 0);
  return { result, body, brepSha256: sha256(body.exactBrep), faces, edges, vertices };
}

async function workerRebuild(
  kernel: HeadlessKernel,
  project: JsonRecord,
  revision: number,
  label: string,
): Promise<JsonRecord> {
  return kernel.request({
    kind: 'rebuild',
    requestId: `structural-${revision}-${label}`,
    projectId: project.projectId,
    revision,
    document: project,
    includeExactBrep: true,
  }, 180_000) as Promise<JsonRecord>;
}

const representative = cases.find((entry) => entry.presetId === 'i-80x40x5');
check('representative I-section case is missing', representative);
const sourceSnapshot = JSON.stringify(representative.reopened);

expectAtomicFailure('cross-family edit', representative.reopened, [{
  kind: 'structural.member.update',
  input: { featureId: representative.memberId, patch: { familyId: 'tee', presetId: 'tee-50x40x5' } },
}], /family changes require a new member/u);
expectAtomicFailure('generic advanced-feature bypass', representative.reopened, [{
  kind: 'feature.advanced.update',
  input: { featureId: representative.memberId, patch: { name: 'Bypassed member' } },
}], /typed structural-member command/u);
expectAtomicFailure('generic feature-update bypass', representative.reopened, [{
  kind: 'feature.update',
  input: { featureId: representative.memberId, patch: { name: 'Bypassed member' } },
}], /structural\.member\.update/u);

const baselinePart = rootPart(representative.reopened);
const baselineFeature = baselinePart.features.find((entry: JsonRecord) => entry.id === representative.memberId)!;
const baselineRecipe = clone(baselineFeature.extensions.structuralMember);
const baselinePlane = baselinePart.referenceGeometry.find((entry: JsonRecord) => entry.id === baselineRecipe.profilePlaneId)!;

const pathEdited = apply(representative.reopened, 'edit-structural-path-associatively', [{
  kind: 'sketch.advanced.update',
  input: {
    sketchId: representative.pathId,
    patch: { kind: 'polyline', points: [[0, 0, 0], [30, 40, 120]] },
  },
}]);
const pathChecked = runtime.assertStudioStructuralMemberDocument(pathEdited, representative.memberId) as JsonRecord;
check('path edit did not preserve the persisted reference frame', JSON.stringify(pathChecked.recipe.profileFrame) === JSON.stringify(baselineRecipe.profileFrame));
const pathFrame = modeling.resolveStudioV5Datums(pathEdited).resolve(baselineRecipe.profilePlaneId) as JsonRecord;
const expectedTangent = [30 / 130, 40 / 130, 120 / 130];
check('curve-normal plane did not follow the edited path endpoint', pathFrame.kind === 'plane'
  && JSON.stringify(pathFrame.origin) === JSON.stringify([0, 0, 0])
  && pathFrame.normal.every((value: number, index: number) => closeTo(value, expectedTangent[index]!, 1e-10))
  && closeTo(pathFrame.normal.reduce((sum: number, value: number, index: number) => sum + value * pathFrame.xDirection[index], 0), 0, 1e-10));

const presetEdited = apply(representative.reopened, 'edit-structural-preset', [{
  kind: 'structural.member.update',
  input: { featureId: representative.memberId, patch: { presetId: 'i-100x50x6' } },
}]);
const presetProfile = structural.studioStructuralProfile('i-section', 'i-100x50x6', defaultPlacement) as JsonRecord;
const presetChecked = runtime.assertStudioStructuralMemberDocument(presetEdited, representative.memberId) as JsonRecord;
check('same-family preset edit lost owned IDs or reference frame', presetChecked.recipe.profilePlaneId === baselineRecipe.profilePlaneId
  && presetChecked.recipe.profileSketchId === baselineRecipe.profileSketchId
  && JSON.stringify(presetChecked.recipe.profileFrame) === JSON.stringify(baselineRecipe.profileFrame)
  && presetChecked.recipe.profileArea === presetProfile.area);

const sameFamilyPresetEdits: SameFamilyPresetEdit[] = families.map((family) => {
  const baseline = cases.find((entry) => entry.familyId === family.id && entry.presetId === family.presets[0].id);
  check(`${family.id} baseline case is missing`, baseline);
  const targetPreset = family.presets[1];
  const edited = family.id === 'i-section'
    ? presetEdited
    : apply(baseline.reopened, `edit-${family.id}-preset`, [{
      kind: 'structural.member.update',
      input: { featureId: baseline.memberId, patch: { presetId: targetPreset.id } },
    }]);
  const profile = family.id === 'i-section'
    ? presetProfile
    : structural.studioStructuralProfile(family.id, targetPreset.id, defaultPlacement) as JsonRecord;
  const baselineRecipeForFamily = rootPart(baseline.reopened).features
    .find((entry: JsonRecord) => entry.id === baseline.memberId)!.extensions.structuralMember;
  const checked = runtime.assertStudioStructuralMemberDocument(edited, baseline.memberId) as JsonRecord;
  check(`${family.id} same-family preset edit lost owned IDs or reference frame`,
    checked.recipe.profilePlaneId === baselineRecipeForFamily.profilePlaneId
      && checked.recipe.profileSketchId === baselineRecipeForFamily.profileSketchId
      && JSON.stringify(checked.recipe.profileFrame) === JSON.stringify(baselineRecipeForFamily.profileFrame)
      && checked.recipe.familyId === family.id
      && checked.recipe.presetId === targetPreset.id
      && closeTo(checked.recipe.profileArea, profile.area, 1e-9));
  return {
    familyId: family.id,
    fromPresetId: baseline.presetId,
    toPresetId: targetPreset.id,
    baseline,
    edited,
    profile,
  };
});

const placedProfile = structural.studioStructuralProfile('i-section', 'i-80x40x5', {
  anchor: 'top-left', rotationDegrees: 27, offset: [7, -4],
}) as JsonRecord;
const placementEdited = apply(representative.reopened, 'edit-structural-placement', [{
  kind: 'structural.member.update',
  input: {
    featureId: representative.memberId,
    patch: { placement: placedProfile.placement },
  },
}]);
const placementChecked = runtime.assertStudioStructuralMemberDocument(placementEdited, representative.memberId) as JsonRecord;
check('placement edit did not persist exact catalog points', JSON.stringify(placementChecked.profile.points) === JSON.stringify(placedProfile.points)
  && closeTo(placementChecked.recipe.profileArea, representative.profile.area, 1e-9));
const partialPlacementProfile = structural.studioStructuralProfile('i-section', 'i-80x40x5', {
  anchor: 'top-left', rotationDegrees: 35, offset: [7, -4],
}) as JsonRecord;
const partialPlacementEdited = apply(placementEdited, 'edit-structural-placement-partially', [{
  kind: 'structural.member.update',
  input: {
    featureId: representative.memberId,
    patch: { placement: { rotationDegrees: 35 } },
  },
}]);
const partialPlacementChecked = runtime.assertStudioStructuralMemberDocument(
  partialPlacementEdited, representative.memberId,
) as JsonRecord;
check('partial placement edit reset omitted authored placement fields',
  JSON.stringify(partialPlacementChecked.recipe.placement) === JSON.stringify(partialPlacementProfile.placement)
    && JSON.stringify(partialPlacementChecked.profile.points) === JSON.stringify(partialPlacementProfile.points));

const reversedPathOperation = [{
  kind: 'sketch.advanced.update',
  input: { sketchId: representative.pathId, patch: { kind: 'polyline', points: [[0, 0, 0], [0, 0, -120]] } },
}];
expectAtomicFailure('180-degree path reversal', representative.reopened, reversedPathOperation, /180 degrees|180-degree/u);
const missingReferenceDefinition = clone(baselinePlane.definition);
delete missingReferenceDefinition.referenceXDirection;
expectAtomicFailure('incomplete persisted reference frame', representative.reopened, [{
  kind: 'datum.update', input: { datumId: baselinePlane.id, patch: { definition: missingReferenceDefinition } },
}], /provided together|reference frame/u);

const invalidBlank = blankProject('project-structural-invalid-paths');
expectAtomicFailure('multi-segment path', invalidBlank, [
  { kind: 'sketch.path.create', input: { id: 'path-multi', name: 'Multi', curveKind: 'polyline', points: [[0, 0, 0], [0, 0, 20], [20, 0, 20]] } },
  { kind: 'structural.member.create', input: { id: 'member-multi', pathSketchId: 'path-multi', familyId: 'rectangular-bar', presetId: 'rect-20x10' } },
], /direct two-point polyline/u);
expectAtomicFailure('spline path', invalidBlank, [
  { kind: 'sketch.path.create', input: { id: 'path-spline', name: 'Spline', curveKind: 'spline', points: [[0, 0, 0], [0, 0, 20]] } },
  { kind: 'structural.member.create', input: { id: 'member-spline', pathSketchId: 'path-spline', familyId: 'rectangular-bar', presetId: 'rect-20x10' } },
], /direct two-point polyline/u);
expectAtomicFailure('zero-length path', invalidBlank, [
  { kind: 'sketch.path.create', input: { id: 'path-zero', name: 'Zero', curveKind: 'polyline', points: [[0, 0, 0], [0, 0, 0]] } },
  { kind: 'structural.member.create', input: { id: 'member-zero', pathSketchId: 'path-zero', familyId: 'rectangular-bar', presetId: 'rect-20x10' } },
], /duplicate points|zero-length/u);
expectAtomicFailure('reference-curve path', invalidBlank, [
  { kind: 'sketch.path.create', input: { id: 'path-reference-a', name: 'A', curveKind: 'polyline', points: [[0, 0, 0], [0, 0, 20]] } },
  { kind: 'sketch.path.create', input: { id: 'path-reference-b', name: 'B', curveKind: 'polyline', points: [[0, 0, 20], [0, 0, 40]] } },
  { kind: 'sketch.reference.create', input: { id: 'path-reference', name: 'Reference', definition: { kind: 'composite', sourceSketchIds: ['path-reference-a', 'path-reference-b'] } } },
  { kind: 'structural.member.create', input: { id: 'member-reference', pathSketchId: 'path-reference', familyId: 'rectangular-bar', presetId: 'rect-20x10' } },
], /direct two-point polyline/u);
expectAtomicFailure('unknown family', invalidBlank, [
  { kind: 'sketch.path.create', input: { id: 'path-unknown-family', name: 'Unknown family', curveKind: 'polyline', points: [[0, 0, 0], [0, 0, 20]] } },
  { kind: 'structural.member.create', input: { id: 'member-unknown-family', pathSketchId: 'path-unknown-family', familyId: 'round-tube', presetId: 'tube-20' } },
], /Unknown structural profile family|familyId|allowed|enum/u);
expectAtomicFailure('unknown preset', invalidBlank, [
  { kind: 'sketch.path.create', input: { id: 'path-unknown-preset', name: 'Unknown preset', curveKind: 'polyline', points: [[0, 0, 0], [0, 0, 20]] } },
  { kind: 'structural.member.create', input: { id: 'member-unknown-preset', pathSketchId: 'path-unknown-preset', familyId: 'rectangular-bar', presetId: 'rect-unknown' } },
], /Unknown structural profile preset/u);

function expectTamperedDocumentRefusal(label: string, mutate: (project: JsonRecord) => void, pattern: RegExp): void {
  const tampered = clone(representative!.reopened);
  mutate(tampered);
  expectFailure(label, () => projectModule.prepareStudioV5Project(tampered), pattern);
  check(`${label} mutated the authoritative source`, JSON.stringify(representative!.reopened) === sourceSnapshot);
}

expectTamperedDocumentRefusal('tampered part catalog', (project) => {
  rootPart(project).extensions.structuralProfileLibrary.source.id = 'substituted-catalog';
}, /profile library provenance|unsupported fields/u);
expectTamperedDocumentRefusal('tampered generated profile', (project) => {
  const recipe = rootPart(project).features[0].extensions.structuralMember;
  rootPart(project).sketches.find((entry: JsonRecord) => entry.id === recipe.profileSketchId).entities[0].points[0][0] += 0.5;
}, /profile sketch no longer matches/u);
expectTamperedDocumentRefusal('tampered owned profile entity identity', (project) => {
  const recipe = rootPart(project).features[0].extensions.structuralMember;
  rootPart(project).sketches.find((entry: JsonRecord) => entry.id === recipe.profileSketchId).entities[0].id = 'substituted-profile-entity';
}, /profile sketch no longer matches/u);
expectTamperedDocumentRefusal('tampered direct path', (project) => {
  rootPart(project).sketches.find((entry: JsonRecord) => entry.id === representative!.pathId).entities[0].points.push([0, 0, 240]);
}, /direct two-point polyline/u);
expectTamperedDocumentRefusal('tampered owned plane', (project) => {
  const recipe = rootPart(project).features[0].extensions.structuralMember;
  rootPart(project).referenceGeometry.find((entry: JsonRecord) => entry.id === recipe.profilePlaneId).definition.parameter = 0.25;
}, /profile plane is missing or detached/u);
expectTamperedDocumentRefusal('suppressed owned plane', (project) => {
  const recipe = rootPart(project).features[0].extensions.structuralMember;
  rootPart(project).referenceGeometry.find((entry: JsonRecord) => entry.id === recipe.profilePlaneId).suppressed = true;
}, /profile plane is missing or detached/u);
expectTamperedDocumentRefusal('tampered structural recipe', (project) => {
  rootPart(project).features[0].extensions.structuralMember.pathPolicy = 'accept-any-path';
}, /policy evidence is invalid/u);
expectTamperedDocumentRefusal('tampered structural reference direction', (project) => {
  rootPart(project).features[0].referenceDirection = [1, 0, 0];
}, /unit-scale, untwisted, new-body exact Sweep/u);
expectTamperedDocumentRefusal('parallel-invalid persisted frame', (project) => {
  const feature = rootPart(project).features[0];
  const recipe = feature.extensions.structuralMember;
  recipe.profileFrame.xDirection = clone(recipe.profileFrame.normal);
  const plane = rootPart(project).referenceGeometry.find((entry: JsonRecord) => entry.id === recipe.profilePlaneId);
  plane.definition.referenceXDirection = clone(recipe.profileFrame.xDirection);
}, /profile frame must be orthogonal/u);

let deleteProject = blankProject('project-structural-delete');
deleteProject = apply(deleteProject, 'create-two-structural-members', [
  { kind: 'sketch.path.create', input: { id: 'path-shared-delete', name: 'Shared path', curveKind: 'polyline', points: [[0, 0, 0], [0, 0, 75]] } },
  { kind: 'structural.member.create', input: { id: 'member-delete-a', pathSketchId: 'path-shared-delete', familyId: 'rectangular-bar', presetId: 'rect-20x10' } },
  { kind: 'structural.member.create', input: { id: 'member-delete-b', pathSketchId: 'path-shared-delete', familyId: 'channel', presetId: 'channel-50x25x4' } },
]);
const deleteSourceSnapshot = JSON.stringify(deleteProject);
const afterFirstDelete = apply(deleteProject, 'delete-first-structural-member', [{
  kind: 'feature.delete', input: { featureId: 'member-delete-a' },
}]);
const firstDeletePart = rootPart(afterFirstDelete);
const firstOwned = structural.studioStructuralMemberOwnedIds('member-delete-a') as JsonRecord;
check('typed delete did not remove the first member body/feature/helpers', firstDeletePart.features.length === 1
  && firstDeletePart.bodies.length === 1
  && !firstDeletePart.features.some((entry: JsonRecord) => entry.id === 'member-delete-a')
  && !firstDeletePart.sketches.some((entry: JsonRecord) => entry.id === firstOwned.profileSketchId)
  && !firstDeletePart.referenceGeometry.some((entry: JsonRecord) => entry.id === firstOwned.profilePlaneId));
check('typed delete removed a shared path or a still-used catalog', firstDeletePart.sketches.some((entry: JsonRecord) => entry.id === 'path-shared-delete')
  && firstDeletePart.extensions?.structuralProfileLibrary?.schema === structural.STUDIO_STRUCTURAL_PROFILE_LIBRARY_SCHEMA);
const afterSecondDelete = apply(afterFirstDelete, 'delete-last-structural-member', [{
  kind: 'feature.delete', input: { featureId: 'member-delete-b' },
}]);
const secondDeletePart = rootPart(afterSecondDelete);
const secondOwned = structural.studioStructuralMemberOwnedIds('member-delete-b') as JsonRecord;
check('typed last delete did not remove its body/feature/helpers', secondDeletePart.features.length === 0
  && secondDeletePart.bodies.length === 0
  && !secondDeletePart.sketches.some((entry: JsonRecord) => entry.id === secondOwned.profileSketchId)
  && !secondDeletePart.referenceGeometry.some((entry: JsonRecord) => entry.id === secondOwned.profilePlaneId));
check('typed last delete removed the shared path or retained a stale catalog', secondDeletePart.sketches.some((entry: JsonRecord) => entry.id === 'path-shared-delete')
  && secondDeletePart.extensions?.structuralProfileLibrary === undefined);
check('typed delete mutated its source document', JSON.stringify(deleteProject) === deleteSourceSnapshot);

const bodyDeleteBodyId = rootPart(representative.reopened).bodies[0].id as string;
const afterBodyDelete = apply(representative.reopened, 'delete-structural-member-by-body', [{
  kind: 'body.delete', input: { bodyId: bodyDeleteBodyId },
}]);
const bodyDeletePart = rootPart(afterBodyDelete);
const bodyDeleteOwned = structural.studioStructuralMemberOwnedIds(representative.memberId) as JsonRecord;
check('typed body.delete did not route through structural cleanup', bodyDeletePart.features.length === 0
  && bodyDeletePart.bodies.length === 0
  && !bodyDeletePart.sketches.some((entry: JsonRecord) => entry.id === bodyDeleteOwned.profileSketchId)
  && !bodyDeletePart.referenceGeometry.some((entry: JsonRecord) => entry.id === bodyDeleteOwned.profilePlaneId)
  && bodyDeletePart.extensions?.structuralProfileLibrary === undefined);
check('typed body.delete removed the shared authored path or mutated its source',
  bodyDeletePart.sketches.some((entry: JsonRecord) => entry.id === representative.pathId)
  && JSON.stringify(representative.reopened) === sourceSnapshot);

const [structuralSource, runtimeSource, projectSource, workerSource, agentSource, studioSource, pageSource, registrySource, buildSource] = await Promise.all([
  readFile(resolve(root, 'src/static/studio-structural-members.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v5-runtime-document.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-project-v5.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
  readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
]);
check('source-owned structural module is not an acyclic leaf', !/^\s*import\s/mu.test(structuralSource));
check('runtime omits typed structural lifecycle commands', runtimeSource.includes('export function createStudioStructuralMember')
  && runtimeSource.includes('export function updateStudioStructuralMember')
  && runtimeSource.includes('export function deleteStudioStructuralMember')
  && runtimeSource.includes('family changes require a new member'));
check('persisted project boundary omits structural binding validation', projectSource.includes("from './studio-structural-members.js'")
  && projectSource.includes('assertStudioStructuralMemberPart('));
check('production worker omits structural binding validation', workerSource.includes("from '/static/studio-structural-members.js'")
  && workerSource.includes("'STRUCTURAL_MEMBER_EVIDENCE_INVALID'"));
check('agent protocol omits typed structural operations or generic bypass guards', agentSource.includes("'structural.member.create'")
  && agentSource.includes("'structural.member.update'")
  && agentSource.includes('deleteStudioStructuralMember(')
  && agentSource.includes('Structural members must be edited through structural.member.update.'));
check('visible Studio does not load and route Structural member', studioSource.includes("import('/static/studio-structural-members.js')")
  && studioSource.includes("return 'model.structural-member'")
  && studioSource.includes("kind: existingId ? 'structural.member.update' : 'structural.member.create'"));
check('visible Structural member ribbon/dialog is missing', pageSource.includes('id="bw-structural-member-open"')
  && pageSource.includes('id="bw-structural-member-form"')
  && pageSource.includes('id="bw-structural-member-family"')
  && pageSource.includes('id="bw-structural-member-preset"'));
check('Structural member is absent from the UI denominator', registrySource.includes("control('model.structural-member'"));
check('release asset allowlist omits the structural catalog module', buildSource.includes("'studio-structural-members.js'"));

let kernel: HeadlessKernel | null = null;
let freshKernel: HeadlessKernel | null = null;
const evidenceByPreset = new Map<string, ExactBodyEvidence>();
let revision = 0;

try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  for (const entry of cases) {
    revision += 1;
    const result = await workerRebuild(kernel, entry.reopened, revision, entry.presetId);
    evidenceByPreset.set(entry.presetId, assertExactStructuralBody(
      result,
      entry.reopened,
      revision,
      entry.profile,
      pathLength,
      entry.presetId,
    ));
  }
  check('15 catalog presets did not produce 15 distinct exact B-reps', new Set(
    [...evidenceByPreset.values()].map((entry) => entry.brepSha256),
  ).size === 15);

  const baselineEvidence = evidenceByPreset.get(representative.presetId)!;
  revision += 1;
  const createdResult = await workerRebuild(kernel, representative.created, revision, 'save-source');
  const createdEvidence = assertExactStructuralBody(
    createdResult, representative.created, revision, representative.profile, pathLength, 'save-source',
  );
  check('save/reopen changed exact B-rep or named topology', createdEvidence.body.exactBrep === baselineEvidence.body.exactBrep
    && JSON.stringify(createdEvidence.body.geometry) === JSON.stringify(baselineEvidence.body.geometry)
    && JSON.stringify(createdEvidence.faces) === JSON.stringify(baselineEvidence.faces)
    && JSON.stringify(createdEvidence.edges) === JSON.stringify(baselineEvidence.edges)
    && JSON.stringify(createdEvidence.vertices) === JSON.stringify(baselineEvidence.vertices));

  revision += 1;
  const pathResult = await workerRebuild(kernel, pathEdited, revision, 'associative-path-edit');
  const pathEvidence = assertExactStructuralBody(pathResult, pathEdited, revision, representative.profile, 130, 'associative-path-edit');
  check('associative path edit did not rebuild exact geometry while preserving topology identity',
    pathEvidence.body.exactBrep !== baselineEvidence.body.exactBrep
    && JSON.stringify(pathEvidence.body.geometry.bounds) !== JSON.stringify(baselineEvidence.body.geometry.bounds)
    && JSON.stringify(pathEvidence.faces) === JSON.stringify(baselineEvidence.faces)
    && JSON.stringify(pathEvidence.edges) === JSON.stringify(baselineEvidence.edges)
    && JSON.stringify(pathEvidence.vertices) === JSON.stringify(baselineEvidence.vertices));

  const sameFamilyEditEvidence: JsonRecord[] = [];
  for (const edit of sameFamilyPresetEdits) {
    const familyBaselineEvidence = evidenceByPreset.get(edit.fromPresetId)!;
    revision += 1;
    const label = `same-family-${edit.familyId}-preset-edit`;
    const presetResult = await workerRebuild(kernel, edit.edited, revision, label);
    const presetEvidence = assertExactStructuralBody(
      presetResult, edit.edited, revision, edit.profile, pathLength, label,
    );
    check(`${edit.familyId} same-family preset edit did not change exact section while preserving topology identity`,
      presetEvidence.body.exactBrep !== familyBaselineEvidence.body.exactBrep
      && !closeTo(presetEvidence.body.geometry.volume, familyBaselineEvidence.body.geometry.volume, 1e-8)
      && JSON.stringify(presetEvidence.faces) === JSON.stringify(familyBaselineEvidence.faces)
      && JSON.stringify(presetEvidence.edges) === JSON.stringify(familyBaselineEvidence.edges)
      && JSON.stringify(presetEvidence.vertices) === JSON.stringify(familyBaselineEvidence.vertices));
    sameFamilyEditEvidence.push({
      familyId: edit.familyId,
      fromPresetId: edit.fromPresetId,
      toPresetId: edit.toPresetId,
      persistentTopologyStable: true,
    });
  }

  revision += 1;
  const placementResult = await workerRebuild(kernel, placementEdited, revision, 'placement-edit');
  const placementEvidence = assertExactStructuralBody(
    placementResult, placementEdited, revision, placedProfile, pathLength, 'placement-edit',
  );
  check('placement edit did not move exact section while preserving volume/topology identity',
    placementEvidence.body.exactBrep !== baselineEvidence.body.exactBrep
    && closeTo(placementEvidence.body.geometry.volume, baselineEvidence.body.geometry.volume, 1e-8)
    && JSON.stringify(placementEvidence.body.geometry.bounds) !== JSON.stringify(baselineEvidence.body.geometry.bounds)
    && JSON.stringify(placementEvidence.faces) === JSON.stringify(baselineEvidence.faces)
    && JSON.stringify(placementEvidence.edges) === JSON.stringify(baselineEvidence.edges)
    && JSON.stringify(placementEvidence.vertices) === JSON.stringify(baselineEvidence.vertices));

  revision += 1;
  const partialPlacementResult = await workerRebuild(
    kernel, partialPlacementEdited, revision, 'partial-placement-edit',
  );
  const partialPlacementEvidence = assertExactStructuralBody(
    partialPlacementResult, partialPlacementEdited, revision, partialPlacementProfile, pathLength, 'partial-placement-edit',
  );
  check('partial placement edit did not preserve omitted fields and exact topology identity',
    partialPlacementEvidence.body.exactBrep !== placementEvidence.body.exactBrep
      && closeTo(partialPlacementEvidence.body.geometry.volume, placementEvidence.body.geometry.volume, 1e-8)
      && JSON.stringify(partialPlacementEvidence.faces) === JSON.stringify(placementEvidence.faces)
      && JSON.stringify(partialPlacementEvidence.edges) === JSON.stringify(placementEvidence.edges)
      && JSON.stringify(partialPlacementEvidence.vertices) === JSON.stringify(placementEvidence.vertices));

  const workerTamper = clone(representative.reopened);
  const workerRecipe = rootPart(workerTamper).features[0].extensions.structuralMember;
  rootPart(workerTamper).sketches.find((entry: JsonRecord) => entry.id === workerRecipe.profileSketchId).entities[0].points[0][0] += 1;
  let workerRefusal: unknown = null;
  try {
    revision += 1;
    const invalidResult = await workerRebuild(kernel, workerTamper, revision, 'tampered-profile');
    if (invalidResult.errors?.length && invalidResult.bodies?.every((body: JsonRecord) => !body.geometry && !body.exactBrep)) {
      workerRefusal = new Error(invalidResult.errors.map((error: JsonRecord) => error.message).join('; '));
    }
  } catch (error) {
    workerRefusal = error;
  }
  check(`production worker accepted a tampered profile: ${messageOf(workerRefusal)}`, workerRefusal
    && /profile sketch no longer matches|STRUCTURAL_MEMBER_EVIDENCE_INVALID/u.test(messageOf(workerRefusal)));

  await kernel.dispose();
  kernel = null;
  freshKernel = await createHeadlessKernel();
  await freshKernel.waitForKernel();
  const freshRevision = 1;
  const freshResult = await workerRebuild(freshKernel, representative.reopened, freshRevision, 'fresh-worker');
  const freshEvidence = assertExactStructuralBody(
    freshResult, representative.reopened, freshRevision, representative.profile, pathLength, 'fresh-worker',
  );
  check('fresh production worker changed deterministic exact evidence', freshEvidence.body.exactBrep === baselineEvidence.body.exactBrep
    && JSON.stringify(freshEvidence.body.geometry) === JSON.stringify(baselineEvidence.body.geometry)
    && JSON.stringify(freshEvidence.faces) === JSON.stringify(baselineEvidence.faces)
    && JSON.stringify(freshEvidence.edges) === JSON.stringify(baselineEvidence.edges)
    && JSON.stringify(freshEvidence.vertices) === JSON.stringify(baselineEvidence.vertices));

  console.log(JSON.stringify({
    schema: 'partmode.structural-members-smoke/v1',
    catalog: {
      families: families.length,
      presets: cases.length,
      source: structural.STUDIO_STRUCTURAL_PROFILE_SOURCE,
      catalogVersion: structural.STUDIO_STRUCTURAL_PROFILE_CATALOG_VERSION,
    },
    exactProductionRebuilds: cases.length + 10,
    presetEvidence: cases.map((entry) => {
      const exact = evidenceByPreset.get(entry.presetId)!;
      return {
        familyId: entry.familyId,
        presetId: entry.presetId,
        designation: entry.profile.designation,
        profileEdges: entry.profile.points.length,
        areaMm2: entry.profile.area,
        lengthMm: pathLength,
        volumeMm3: exact.body.geometry.volume,
        faces: exact.faces.length,
        edges: exact.edges.length,
        vertices: exact.vertices.length,
        brepSha256: exact.brepSha256,
        documentHash: exact.result.effectiveDocumentHash,
      };
    }),
    associativeEdits: {
      pathLengthMm: 130,
      sameFamilyPresetTransitions: sameFamilyEditEvidence,
      placement: partialPlacementProfile.placement,
      partialPlacementPreservesOmittedFields: true,
      persistentTopologyStable: true,
    },
    lifecycle: {
      canonicalSaveReopen: true,
      freshWorkerDeterminism: true,
      typedDeletePreservesSharedPath: true,
      typedBodyDeleteUsesStructuralCleanup: true,
      sourceOwnedHelpersRemoved: true,
    },
    refusals: [
      'cross-family edit', 'generic update bypasses', 'multi-segment path', 'spline path', 'zero-length path',
      'reference curve', 'unknown family/preset', '180-degree reversal', 'incomplete/parallel reference frame',
      'tampered catalog/profile/path/plane/recipe',
    ],
    unsupported: ['multi-segment structural groups', 'corner treatment and trimming', 'weld beads', 'cut-list generation', 'manufacturing certification'],
  }, null, 2));
} finally {
  await freshKernel?.dispose();
  await kernel?.dispose();
}
