import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Smart Fasteners smoke failed: ${label}`);
}

function closeTo(actual: number, expected: number, tolerance = 2e-6): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function thrown(label: string, action: () => unknown, pattern: RegExp): unknown {
  try {
    action();
  } catch (error) {
    check(`${label} returned the wrong refusal: ${String((error as Error)?.message || error)}`,
      pattern.test(String((error as Error)?.message || error)));
    return error;
  }
  throw new Error(`Smart Fasteners smoke failed: ${label} did not fail closed`);
}

async function rejected(label: string, action: () => Promise<unknown>, pattern: RegExp): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    check(`${label} returned the wrong refusal: ${String((error as Error)?.message || error)}`,
      pattern.test(String((error as Error)?.message || error)));
    return error;
  }
  throw new Error(`Smart Fasteners smoke failed: ${label} did not fail closed`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const [runtime, projectModule, holeWizard, agent, smartFasteners] = await Promise.all([
  moduleAt('src/static/studio-v5-runtime-document.js'),
  moduleAt('src/static/studio-project-v5.js'),
  moduleAt('src/static/studio-hole-wizard.js'),
  moduleAt('src/static/studio-agent-service.js'),
  moduleAt('src/static/studio-smart-fasteners.js'),
]);

const TARGET_OCCURRENCE_ID = 'occurrence-smart-fastener-plate';
const SECOND_TARGET_OCCURRENCE_ID = 'occurrence-smart-fastener-plate-secondary';
const TARGET_FEATURE_ID = 'feature-smart-fastener-hole';
const TARGET_CENTER = [6, -4] as const;
const GROUP_ID = 'smart-fastener-main';
const SECOND_GROUP_ID = 'smart-fastener-secondary';

function transaction(project: JsonRecord, id: string, operations: JsonRecord[]): JsonRecord {
  return agent.applyCadTransaction(project, {
    transactionId: id,
    label: id,
    expectedRevision: 0,
    atomic: true,
    operations,
  }, 0).project as JsonRecord;
}

function platePart(projectId: string, height: number): JsonRecord {
  return runtime.createStudioV5RuntimePartProject({
  projectId,
    name: 'Smart Fastener exact plate',
    units: 'mm',
    parameters: [],
    features: [{
      id: 'feature-smart-fastener-plate',
      type: 'extrude',
      sketch: {
        shapes: [{ id: 'shape-smart-fastener-plate', kind: 'rect', x: 0, y: 0, w: 40, h: 40 }],
        z: 0,
      },
      h: height,
      through: false,
    }],

});
}

interface FixtureOptions {
  projectId: string;
  height?: number;
  designation?: string;
  kind?: string;
  holeCount?: number;
  suppressed?: boolean;
}

function plateAssembly({
  projectId,
  height = 8,
  designation = 'M6',
  kind = 'clearance',
  holeCount = 1,
  suppressed = false,
}: FixtureOptions): JsonRecord {
  let project = platePart(projectId, height);
  const body = runtime.studioV5ActiveBody(project);
  check(`${projectId} has no active source body`, body?.id);
  for (let index = 0; index < holeCount; index += 1) {
    const id = index === 0 ? TARGET_FEATURE_ID : `${TARGET_FEATURE_ID}-${index + 1}`;
    const feature = holeWizard.createStudioHoleWizardFeature({
      id,
      bodyId: body.id,
      kind,
      designation,
      center: [TARGET_CENTER[0] + index * 8, TARGET_CENTER[1]],
      sketchZ: height,
    });
    project = transaction(project, `transaction-${projectId}-${id}`, [{
      kind: 'feature.cut',
      input: holeWizard.studioHoleWizardOperationInput(feature),
    }]);
  }
  if (suppressed) {
    project = transaction(project, `transaction-${projectId}-suppress`, [{
      kind: 'feature.suppress', input: { featureId: TARGET_FEATURE_ID, suppressed: true },
    }]);
  }
  return runtime.createStudioV5AssemblyFromPart(project, {
    id: `assembly-${projectId}`,
    occurrenceId: TARGET_OCCURRENCE_ID,
    name: 'Smart Fastener plate assembly',
    occurrenceName: 'Plate:1',
    fixed: true,
  });
}

let requestSerial = 0;
async function planRaw(
  kernel: HeadlessKernel,
  document: JsonRecord,
  label: string,
  targetOccurrenceId = TARGET_OCCURRENCE_ID,
): Promise<JsonRecord> {
  requestSerial += 1;
  return kernel.request({
    kind: 'smart-fastener-plan-v5',
    requestId: `smart-fastener-plan-${requestSerial}-${label}`,
    projectId: document.projectId,
    revision: requestSerial,
    document,
    targetOccurrenceId,
  }, 180_000) as Promise<JsonRecord>;
}

async function plan(
  kernel: HeadlessKernel,
  document: JsonRecord,
  label: string,
  targetOccurrenceId = TARGET_OCCURRENCE_ID,
): Promise<JsonRecord> {
  const result = await planRaw(kernel, document, label, targetOccurrenceId);
  check(`${label} did not return a Smart Fastener plan: ${JSON.stringify(result)}`,
    result.kind === 'smart-fastener-plan-result'
      && result.errors?.length === 0
      && result.plan?.schema === smartFasteners.STUDIO_SMART_FASTENER_PLAN_SCHEMA);
  return result.plan;
}

async function rebuild(
  kernel: HeadlessKernel,
  document: JsonRecord,
  label: string,
): Promise<JsonRecord> {
  requestSerial += 1;
  return kernel.request({
    kind: 'rebuild',
    requestId: `smart-fastener-rebuild-${requestSerial}-${label}`,
    projectId: document.projectId,
    revision: requestSerial,
    document,
    includeExactBrep: true,
  }, 180_000) as Promise<JsonRecord>;
}

async function assertRebuildRefusesSmartEvidence(
  kernel: HeadlessKernel,
  document: JsonRecord,
  label: string,
  pattern: RegExp,
): Promise<void> {
  try {
    const result = await rebuild(kernel, document, label);
    const messages = (result.errors || []).map((entry: JsonRecord) => entry.message).join('; ');
    check(`${label} did not report a current worker refusal: ${JSON.stringify(result)}`,
      result.errors?.length > 0 && pattern.test(messages));
    check(`${label} published success evidence after refusal`, result.evaluation?.smartFasteners === undefined);
  } catch (error) {
    check(`${label} returned the wrong worker refusal: ${String((error as Error)?.message || error)}`,
      pattern.test(String((error as Error)?.message || error)));
  }
}

function assertNamedReference(
  reference: JsonRecord,
  label: string,
  ownerId: string,
  occurrenceId: string,
  topologyKind: 'cylindrical-face' | 'planar-face',
  expectedName?: string,
): void {
  check(`${label} uses a runtime or wrong body owner`, reference?.ownerKind === 'body'
    && reference.ownerId === ownerId
    && !reference.ownerId.includes(':'));
  check(`${label} lost its direct source occurrence path`,
    JSON.stringify(reference.occurrencePath) === JSON.stringify([occurrenceId]));
  check(`${label} lost its persistent name`, typeof reference.semanticPath?.name === 'string'
    && reference.semanticPath.name.length > 0
    && (expectedName === undefined || reference.semanticPath.name === expectedName));
  check(`${label} lost its current analytic signature`, reference.signature?.topologyKind === topologyKind
    && Array.isArray(reference.signature.p) && reference.signature.p.length === 3
    && Array.isArray(reference.signature.n) && reference.signature.n.length === 3
    && reference.signature.p.every(Number.isFinite)
    && reference.signature.n.every(Number.isFinite));
  if (topologyKind === 'cylindrical-face') {
    check(`${label} lost its exact cylinder`, Array.isArray(reference.signature.a)
      && reference.signature.a.length === 3
      && reference.signature.a.every(Number.isFinite)
      && Array.isArray(reference.signature.d)
      && reference.signature.d.length === 3
      && reference.signature.d.every(Number.isFinite)
      && Number.isFinite(reference.signature.r)
      && reference.signature.r > 0);
  }
}

function assertCompleteExactBody(body: JsonRecord | undefined, label: string): asserts body is JsonRecord {
  check(`${label} is not a current valid one-solid exact B-rep: ${JSON.stringify(body)}`,
    body && !body.error && body.lastValid === false
      && body.geometry?.valid === true
      && body.geometry?.brepValid === true
      && body.geometry?.solidCount === 1
      && body.geometry?.shellCount === 1
      && typeof body.exactBrep === 'string'
      && body.exactBrep.length > 100);
  const counts = body.mesh?.topologyCounts;
  check(`${label} omitted complete persistent face identity`, counts?.faces > 0
    && counts.faces === body.mesh?.topologyFaces?.length
    && counts.faces === counts.namedFaces
    && body.mesh.topologyFaces.every((entry: JsonRecord) => typeof entry.name === 'string' && entry.name.length > 0));
  check(`${label} omitted complete persistent edge identity`, counts?.edges > 0
    && counts.edges === body.mesh?.edges?.length
    && counts.edges === counts.namedEdges
    && body.mesh.edges.every((entry: JsonRecord) => typeof entry.name === 'string' && entry.name.length > 0));
  check(`${label} omitted complete persistent vertex identity`, counts?.vertices > 0
    && counts.vertices === body.mesh?.topologyVertices?.length
    && counts.vertices === counts.namedVertices
    && body.mesh.topologyVertices.every((entry: JsonRecord) => typeof entry.name === 'string' && entry.name.length > 0));
  check(`${label} published topology diagnostics`, Array.isArray(body.mesh?.topologyDiagnostics)
    && body.mesh.topologyDiagnostics.length === 0);
}

function assemblyFor(project: JsonRecord): JsonRecord {
  const assembly = project.assemblyDefinitions.find((entry: JsonRecord) => entry.id === project.rootDocument.assemblyId);
  check('root assembly is missing', assembly);
  return assembly;
}

function smartGroup(project: JsonRecord): JsonRecord {
  const groups = assemblyFor(project).extensions?.smartFasteners?.groups;
  check('exactly one Smart Fastener group was not persisted', Array.isArray(groups) && groups.length === 1);
  return groups[0];
}

function injectDuplicateStoredGroup(project: JsonRecord, duplicateId: string): JsonRecord {
  const candidate = clone(project);
  const assembly = assemblyFor(candidate);
  const sourceGroup = smartGroup(candidate);
  const owned = smartFasteners.studioSmartFastenerOwnedIds(duplicateId);
  const occurrenceIdMap = new Map<string, string>([[sourceGroup.targetOccurrenceId, sourceGroup.targetOccurrenceId]]);

  for (const role of smartFasteners.STUDIO_SMART_FASTENER_COMPONENT_ROLES as string[]) {
    const sourceOccurrenceId = sourceGroup.occurrenceIds[role];
    const sourceOccurrence = assembly.occurrences.find((entry: JsonRecord) => entry.id === sourceOccurrenceId);
    check(`duplicate validator fixture lost the ${role} source occurrence`, sourceOccurrence);
    const duplicateOccurrence = clone(sourceOccurrence);
    duplicateOccurrence.id = owned.occurrenceIds[role];
    duplicateOccurrence.extensions.smartFastenerOwnership.groupId = duplicateId;
    occurrenceIdMap.set(sourceOccurrenceId, duplicateOccurrence.id);
    assembly.occurrences.push(duplicateOccurrence);
  }

  for (const role of smartFasteners.STUDIO_SMART_FASTENER_MATE_ROLES as string[]) {
    const sourceMate = assembly.mates.find((entry: JsonRecord) => entry.id === sourceGroup.mateIds[role]);
    check(`duplicate validator fixture lost the ${role} source mate`, sourceMate);
    const duplicateMate = clone(sourceMate);
    duplicateMate.id = owned.mateIds[role];
    duplicateMate.name = `Duplicate ${role}`;
    duplicateMate.occurrenceIds = duplicateMate.occurrenceIds.map(
      (occurrenceId: string) => occurrenceIdMap.get(occurrenceId) || occurrenceId,
    );
    duplicateMate.references = duplicateMate.references.map((reference: JsonRecord) => ({
      ...reference,
      occurrencePath: reference.occurrencePath.map(
        (occurrenceId: string) => occurrenceIdMap.get(occurrenceId) || occurrenceId,
      ),
    }));
    duplicateMate.extensions.smartFastenerOwnership.groupId = duplicateId;
    assembly.mates.push(duplicateMate);
  }

  const duplicateGroup = clone(sourceGroup);
  duplicateGroup.id = duplicateId;
  duplicateGroup.name = 'Duplicate same-target Smart Fastener';
  duplicateGroup.occurrenceIds = clone(owned.occurrenceIds);
  duplicateGroup.mateIds = clone(owned.mateIds);
  assembly.extensions.smartFasteners.groups.push(duplicateGroup);
  return candidate;
}

function applyTyped(project: JsonRecord, planned: JsonRecord): JsonRecord {
  return transaction(project, 'transaction-smart-fastener-apply', [{
    kind: 'smartFastener.apply',
    input: { id: GROUP_ID, name: 'M6 plate fastener', plan: clone(planned) },
  }]);
}

function updateTyped(project: JsonRecord, planned: JsonRecord): JsonRecord {
  return transaction(project, 'transaction-smart-fastener-update', [{
    kind: 'smartFastener.update',
    input: { smartFastenerId: GROUP_ID, plan: clone(planned) },
  }]);
}

function deleteTyped(project: JsonRecord): JsonRecord {
  return transaction(project, 'transaction-smart-fastener-delete', [{
    kind: 'smartFastener.delete', input: { smartFastenerId: GROUP_ID },
  }]);
}

function editedGrip(project: JsonRecord, height: number): JsonRecord {
  return transaction(project, `transaction-smart-fastener-height-${height}`, [
    { kind: 'assembly.context.enter', input: { occurrenceId: TARGET_OCCURRENCE_ID } },
    { kind: 'feature.update', input: { featureId: 'feature-smart-fastener-plate', patch: { h: height } } },
    { kind: 'assembly.context.exit', input: {} },
  ]);
}

function tamperedPlan(planValue: JsonRecord, mutate: (candidate: JsonRecord) => void): JsonRecord {
  const candidate = clone(planValue);
  mutate(candidate);
  candidate.fingerprint = smartFasteners.studioSmartFastenerPlanFingerprint(candidate);
  return candidate;
}

function canonicalSaveReopen(project: JsonRecord): JsonRecord {
  const saved = JSON.stringify(projectModule.prepareStudioV5Project(project));
  const reopened = projectModule.parseStudioV5Project(saved) as JsonRecord;
  check('canonical save/reopen changed project bytes', JSON.stringify(reopened) === saved);
  return reopened;
}

function numericLeaves(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numericLeaves);
  if (value && typeof value === 'object') return Object.values(value).flatMap(numericLeaves);
  return [];
}

function assertSmartEvidence(
  result: JsonRecord,
  project: JsonRecord,
  group: JsonRecord,
  expectedGrip: number,
  expectedScrewDesignation: string,
): JsonRecord {
  const evidence = result.evaluation?.smartFasteners;
  const documentHash = runtime.studioV5CanonicalHash(project);
  check('worker omitted current Smart Fastener evidence', evidence?.schema === 'partmode.smart-fastener-evidence/v1'
    && evidence.documentHash === documentHash
    && result.effectiveDocumentHash === documentHash
    && Array.isArray(evidence.groups)
    && evidence.groups.length === 1);
  const proved = evidence.groups[0];
  check('worker evidence lost the persisted group association', proved.groupId === group.id
    && proved.policyId === smartFasteners.STUDIO_SMART_FASTENER_POLICY_ID
    && proved.target?.occurrenceId === TARGET_OCCURRENCE_ID
    && proved.target.partId === group.target.partId
    && proved.target.bodyId === group.target.bodyId
    && proved.target.featureId === group.target.featureId
    && proved.target.designation === 'M6'
    && closeTo(proved.target.exactGrip, expectedGrip));
  assertNamedReference(
    proved.target.holeReference,
    'evidence target pilot wall',
    group.target.bodyId,
    TARGET_OCCURRENCE_ID,
    'cylindrical-face',
  );
  assertNamedReference(
    proved.target.entryReference,
    'evidence target entry',
    group.target.bodyId,
    TARGET_OCCURRENCE_ID,
    'planar-face',
  );
  assertNamedReference(
    proved.target.exitReference,
    'evidence target exit',
    group.target.bodyId,
    TARGET_OCCURRENCE_ID,
    'planar-face',
  );
  check('evidence catalog did not derive the exact complete stack length', closeTo(
    proved.catalog?.requiredLength,
    expectedGrip + 1.6 + 5.2 + 2,
  ));
  check('evidence catalog selection is not the current source-owned stack',
    proved.catalog?.selections?.screw?.designation === expectedScrewDesignation
      && proved.catalog.selections.screw.familyId === 'iso4017-hex-screw'
      && proved.catalog.selections.washer.designation === '6'
      && proved.catalog.selections.washer.familyId === 'iso7089-plain-washer'
      && proved.catalog.selections.nut.designation === 'M6'
      && proved.catalog.selections.nut.familyId === 'iso4032-hex-nut');
  check('worker evidence does not contain target plus three exact bodies',
    JSON.stringify(Object.keys(proved.exactBodies || {})) === JSON.stringify(['target', 'screw', 'washer', 'nut']));
  for (const [role, body] of Object.entries(proved.exactBodies) as Array<[string, JsonRecord]>) {
    const expectedOccurrenceId = role === 'target' ? TARGET_OCCURRENCE_ID : group.occurrenceIds[role];
    check(`evidence ${role} lost source identity or solved placement`, body.occurrenceId === expectedOccurrenceId
      && typeof body.bodyId === 'string'
      && !body.bodyId.includes(':')
      && typeof body.variantId === 'string'
      && Array.isArray(body.transform)
      && body.transform.length === 16
      && body.transform.every(Number.isFinite));
    check(`evidence ${role} lacks a canonical current exact B-rep`,
      typeof body.exactBrep === 'string'
        && body.exactBrep.length > 100
        && /^[0-9a-f]{64}$/u.test(body.brepSha256)
        && body.brepSha256 === createHash('sha256').update(body.exactBrep).digest('hex')
        && body.geometry?.valid === true
        && body.geometry?.brepValid === true
        && body.geometry?.solidCount === 1);
    if (role !== 'target') {
      check(`evidence ${role} omitted current catalog parameters`, body.parameters
        && Object.keys(body.parameters).length > 0
        && Object.values(body.parameters).every(Number.isFinite));
    }
  }
  check('worker evidence omitted six current exact mate frames', Array.isArray(proved.mateFrames)
    && proved.mateFrames.length === 6
    && JSON.stringify(proved.mateFrames.map((entry: JsonRecord) => entry.role))
      === JSON.stringify(smartFasteners.STUDIO_SMART_FASTENER_MATE_ROLES));
  for (const frame of proved.mateFrames as JsonRecord[]) {
    check(`evidence mate ${frame.role} lost its persisted crosslink`, frame.mateId === group.mateIds[frame.role]
      && ['concentric', 'coincident'].includes(frame.kind)
      && (frame.kind === 'coincident' ? frame.flip === true : frame.flip === false)
      && Array.isArray(frame.references)
      && frame.references.length === 2);
    for (const reference of frame.references) {
      const worldFrameNumbers = numericLeaves(reference.worldFrame);
      check(`evidence mate ${frame.role} lacks a current named exact frame`,
        typeof reference.occurrenceId === 'string'
          && typeof reference.bodyId === 'string'
          && !reference.bodyId.includes(':')
          && typeof reference.name === 'string'
          && reference.name.length > 0
          && typeof reference.localSignature?.topologyKind === 'string'
          && reference.worldFrame
          && worldFrameNumbers.length >= 6
          && worldFrameNumbers.every(Number.isFinite));
    }
    check(`evidence mate ${frame.role} residual is not settled`,
      frame.residual?.mateId === frame.mateId
        && frame.residual.satisfied === true
        && Number.isFinite(frame.residual.maxScaledResidual)
        && Math.abs(frame.residual.maxScaledResidual) <= 1e-6);
  }
  check('worker evidence did not prove the fresh rank-15 one-DOF-per-component solution',
    proved.solver?.rank === 15
      && Array.isArray(proved.solver.residuals)
      && proved.solver.residuals.length === 6
      && proved.solver.residuals.every((entry: JsonRecord) => entry.satisfied === true
        && Number.isFinite(entry.maxScaledResidual)
        && Math.abs(entry.maxScaledResidual) <= 1e-6)
      && JSON.stringify(proved.solver.degreesOfFreedom) === JSON.stringify({ screw: 1, washer: 1, nut: 1 })
      && proved.solver.usedLastValid === false);
  const interferencePairs = proved.interference?.pairs;
  const acceptanceToleranceMm3 = proved.interference?.acceptanceToleranceMm3;
  check('worker evidence omitted the explicit exact-interference acceptance tolerance',
    acceptanceToleranceMm3 === 1e-7);
  check('worker evidence omitted six measured nonnegative body-pair intersection volumes',
    Array.isArray(interferencePairs)
      && interferencePairs.length === 6
      && interferencePairs.every((entry: JsonRecord) => Array.isArray(entry.roles)
        && entry.roles.length === 2
        && Number.isFinite(entry.positiveVolumeMm3)
        && entry.positiveVolumeMm3 >= 0
        && entry.positiveVolumeMm3 <= acceptanceToleranceMm3
        && entry.hasInterference === (entry.positiveVolumeMm3 > 0)));
  const measuredVolumes = interferencePairs.map((entry: JsonRecord) => entry.positiveVolumeMm3);
  const measuredMaximum = Math.max(...measuredVolumes);
  check('worker evidence rewrote or disagreed with the measured pairwise intersection volumes',
    proved.interference.maxPositiveVolumeMm3 === measuredMaximum
      && proved.interference.hasInterference === measuredVolumes.some((volume: number) => volume > 0));
  return evidence;
}

let firstKernel: HeadlessKernel | null = null;
let secondKernel: HeadlessKernel | null = null;
try {
  firstKernel = await createHeadlessKernel();
  await firstKernel.waitForKernel();

  const source = plateAssembly({ projectId: 'project-smart-fastener-main' });
  const sourceAssembly = assemblyFor(source);
  const sourcePart = source.partDefinitions.find((entry: JsonRecord) => entry.id === sourceAssembly.occurrences[0].definition.partId);
  const sourceBody = sourcePart.bodies[0];
  const sourceHash = runtime.studioV5CanonicalHash(source);
  const originalSource = JSON.stringify(source);

  const initialPlan = await plan(firstKernel, source, 'initial');
  check('planning mutated the authoritative source document', JSON.stringify(source) === originalSource);
  check('plan is not bound to the current canonical document hash', initialPlan.documentHash === sourceHash);
  check('plan policy changed', initialPlan.policyId === smartFasteners.STUDIO_SMART_FASTENER_POLICY_ID);
  check('plan fingerprint is not source-derived and current', /^[0-9a-f]{64}$/u.test(initialPlan.fingerprint)
    && initialPlan.fingerprint === smartFasteners.studioSmartFastenerPlanFingerprint(initialPlan));
  smartFasteners.assertStudioSmartFastenerPlan(initialPlan, { documentHash: sourceHash });

  check('plan did not recognize the selected direct occurrence', initialPlan.target.occurrenceId === TARGET_OCCURRENCE_ID
    && JSON.stringify(initialPlan.target.occurrencePath) === JSON.stringify([TARGET_OCCURRENCE_ID]));
  check('plan did not retain source-local target ownership', initialPlan.target.partId === sourcePart.id
    && initialPlan.target.bodyId === sourceBody.id
    && initialPlan.target.featureId === TARGET_FEATURE_ID);
  check('plan did not recognize one M6 clearance Hole Wizard', initialPlan.target.designation === 'M6');
  check('plan did not derive the exact 8 mm grip', closeTo(initialPlan.target.exactGrip, 8));
  assertNamedReference(
    initialPlan.target.holeReference,
    'target pilot wall',
    sourceBody.id,
    TARGET_OCCURRENCE_ID,
    'cylindrical-face',
    `F${TARGET_FEATURE_ID}:hole-wizard:pilot-side`,
  );
  check('M6 clearance pilot radius changed', closeTo(initialPlan.target.holeReference.signature.r, 3.3));
  assertNamedReference(
    initialPlan.target.entryReference,
    'target entry face',
    sourceBody.id,
    TARGET_OCCURRENCE_ID,
    'planar-face',
    'Ffeature-smart-fastener-plate:cap:end',
  );
  assertNamedReference(
    initialPlan.target.exitReference,
    'target exit face',
    sourceBody.id,
    TARGET_OCCURRENCE_ID,
    'planar-face',
    'Ffeature-smart-fastener-plate:cap:start',
  );
  check('entry/exit signatures do not prove the exact 8 mm grip', closeTo(
    Math.abs(initialPlan.target.entryReference.signature.p[2] - initialPlan.target.exitReference.signature.p[2]),
    8,
  ));

  check('source-owned catalog selection changed',
    initialPlan.selections.screw.familyId === 'iso4017-hex-screw'
      && initialPlan.selections.screw.designation === 'M6x20'
      && initialPlan.selections.screw.parameterOverrides.length === 20
      && initialPlan.selections.washer.familyId === 'iso7089-plain-washer'
      && initialPlan.selections.washer.designation === '6'
      && initialPlan.selections.washer.parameterOverrides.thickness === 1.6
      && initialPlan.selections.nut.familyId === 'iso4032-hex-nut'
      && initialPlan.selections.nut.designation === 'M6'
      && initialPlan.selections.nut.parameterOverrides.height === 5.2);
  check('plan did not generate three distinct rigid component placements',
    JSON.stringify(Object.keys(initialPlan.occurrences)) === JSON.stringify(['screw', 'washer', 'nut'])
      && new Set(Object.values(initialPlan.occurrences).map((entry: any) => entry.occurrenceId)).size === 3
      && Object.values(initialPlan.occurrences).every((entry: any) => Array.isArray(entry.baseTransform)
        && entry.baseTransform.length === 16 && entry.baseTransform.every(Number.isFinite)));
  check('plan did not generate the canonical six explicit mates', initialPlan.mates.length === 6
    && JSON.stringify(initialPlan.mates.map((entry: JsonRecord) => entry.role))
      === JSON.stringify(smartFasteners.STUDIO_SMART_FASTENER_MATE_ROLES)
    && initialPlan.mates.every((entry: JsonRecord) => entry.references.length === 2
      && entry.references.every((reference: JsonRecord) => reference.ownerKind === 'body'
        && !reference.ownerId.includes(':')
        && reference.occurrencePath.length === 1
        && typeof reference.semanticPath?.name === 'string')));
  check('plan did not retain explicit opposing-normal contact flips',
    initialPlan.mates.filter((entry: JsonRecord) => entry.kind === 'coincident').length === 3
      && initialPlan.mates.filter((entry: JsonRecord) => entry.kind === 'coincident')
        .every((entry: JsonRecord) => entry.flip === true)
      && initialPlan.mates.filter((entry: JsonRecord) => entry.kind === 'concentric')
        .every((entry: JsonRecord) => entry.flip === undefined));

  // This collision is intentionally discovered only after the core apply path
  // has prepared all three canonical catalog imports. The exported operation
  // must still leave the caller byte-for-byte unchanged on that late failure.
  const lateCollisionInput = clone(source);
  const lateCollisionInputBytes = JSON.stringify(lateCollisionInput);
  thrown('direct apply late group-ID collision after catalog preparation', () =>
    smartFasteners.applyStudioSmartFastenerPlan(lateCollisionInput, clone(initialPlan), {
      id: TARGET_FEATURE_ID,
      name: 'Late collision fixture',
    }), /collision|already in use|owned ID/iu);
  check('failed late-collision direct apply mutated the caller document',
    JSON.stringify(lateCollisionInput) === lateCollisionInputBytes);

  const direct = smartFasteners.applyStudioSmartFastenerPlan(clone(source), clone(initialPlan), {
    id: GROUP_ID,
    name: 'M6 plate fastener',
  }).project as JsonRecord;
  smartFasteners.assertStudioSmartFastenersProject(direct);
  const runtimeApplied = runtime.applyStudioV5SmartFastenerPlan(clone(source), clone(initialPlan), {
    id: GROUP_ID,
    name: 'M6 plate fastener',
  }).project as JsonRecord;
  smartFasteners.assertStudioSmartFastenersProject(runtimeApplied);
  const applied = applyTyped(source, initialPlan);
  smartFasteners.assertStudioSmartFastenersProject(applied);
  const directAssembly = assemblyFor(direct);
  const appliedAssembly = assemblyFor(applied);
  check('typed and core APIs disagree on persisted Smart Fastener state',
    JSON.stringify(directAssembly.extensions.smartFasteners) === JSON.stringify(appliedAssembly.extensions.smartFasteners));
  check('runtime and core APIs disagree on persisted Smart Fastener state',
    JSON.stringify(assemblyFor(runtimeApplied).extensions.smartFasteners)
      === JSON.stringify(directAssembly.extensions.smartFasteners));
  check('apply did not add exactly three real occurrences',
    appliedAssembly.occurrences.length === sourceAssembly.occurrences.length + 3);
  check('apply did not add exactly six real mates',
    appliedAssembly.mates.length === sourceAssembly.mates.length + 6);
  const initialGroup = smartGroup(applied);
  check('persisted group lost source associations', initialGroup.id === GROUP_ID
    && initialGroup.targetOccurrenceId === TARGET_OCCURRENCE_ID
    && initialGroup.target.partId === sourcePart.id
    && initialGroup.target.bodyId === sourceBody.id
    && initialGroup.target.featureId === TARGET_FEATURE_ID);
  check('owned occurrences do not use stable group-derived IDs',
    JSON.stringify(initialGroup.occurrenceIds) === JSON.stringify(smartFasteners.studioSmartFastenerOwnedIds(GROUP_ID).occurrenceIds));
  check('owned mates do not use stable group-derived IDs',
    JSON.stringify(initialGroup.mateIds) === JSON.stringify(smartFasteners.studioSmartFastenerOwnedIds(GROUP_ID).mateIds));
  for (const [role, selection] of Object.entries(initialPlan.selections) as Array<[string, JsonRecord]>) {
    const part = applied.partDefinitions.find((entry: JsonRecord) => entry.id === selection.partId);
    const configurationSet = applied.partConfigurationSets.find((entry: JsonRecord) => entry.partId === selection.partId);
    const provenance = part?.extensions?.standardPartCatalog;
    check(`${role} is not backed by its source-owned ISO definition and exact configuration row`,
      provenance?.schema === 'partmode.standard-part-catalog/v1'
        && provenance.source?.standard?.startsWith('ISO ')
        && provenance.source?.url?.startsWith('https://www.iso.org/')
        && provenance.configurationData?.[selection.configurationId]?.designation === selection.designation
        && configurationSet?.configurations?.some((entry: JsonRecord) => entry.id === selection.configurationId));
  }
  for (const mateId of Object.values(initialGroup.mateIds) as string[]) {
    const mate = appliedAssembly.mates.find((entry: JsonRecord) => entry.id === mateId);
    check(`${mateId} is not a real current mate`, mate && mate.suppressed === false);
    for (const reference of mate.references) {
      check(`${mateId} persisted a runtime-prefixed body owner`, reference.ownerKind === 'body'
        && !reference.ownerId.includes(':')
        && reference.occurrencePath.length === 1
        && typeof reference.semanticPath?.name === 'string'
        && reference.semanticPath.name.length > 0);
    }
  }

  const reopened = canonicalSaveReopen(applied);
  smartFasteners.assertStudioSmartFastenersProject(reopened);
  check('save/reopen lost the exact Smart Fastener group',
    JSON.stringify(smartGroup(reopened)) === JSON.stringify(initialGroup));

  const duplicatedStoredTarget = injectDuplicateStoredGroup(reopened, 'smart-fastener-duplicate-validator-fixture');
  const duplicateStoredError = thrown('stored duplicate same-target Smart Fastener groups',
    () => smartFasteners.assertStudioSmartFastenersProject(duplicatedStoredTarget),
    /target occurrence\/body\/feature|multiple groups|already owned/iu) as JsonRecord;
  check('stored duplicate target refusal did not retain its typed error code',
    duplicateStoredError.code === 'SMART_FASTENER_TARGET_DUPLICATE');

  const currentExistingTargetPlan = await plan(firstKernel, reopened, 'current-existing-target');
  const sameTargetUpdate = smartFasteners.updateStudioSmartFastenerGroup(
    clone(reopened),
    GROUP_ID,
    clone(currentExistingTargetPlan),
  ).project as JsonRecord;
  check('updating a group on its own current target was incorrectly refused',
    smartGroup(sameTargetUpdate).id === GROUP_ID
      && smartGroup(sameTargetUpdate).targetOccurrenceId === TARGET_OCCURRENCE_ID);

  const duplicateApplyInput = clone(reopened);
  const duplicateApplyInputBytes = JSON.stringify(duplicateApplyInput);
  const duplicateApplyError = thrown('direct duplicate same-target Smart Fastener apply', () =>
    smartFasteners.applyStudioSmartFastenerPlan(duplicateApplyInput, clone(currentExistingTargetPlan), {
      id: 'smart-fastener-duplicate-apply',
      name: 'Duplicate same-target apply',
    }), /target occurrence\/body\/feature|already owned/iu) as JsonRecord;
  check('duplicate apply refusal did not retain its typed error code',
    duplicateApplyError.code === 'SMART_FASTENER_TARGET_DUPLICATE');
  check('failed duplicate direct apply mutated the caller document',
    JSON.stringify(duplicateApplyInput) === duplicateApplyInputBytes);
  thrown('typed duplicate same-target Smart Fastener apply', () => transaction(reopened, 'transaction-smart-fastener-duplicate-apply', [{
    kind: 'smartFastener.apply',
    input: {
      id: 'smart-fastener-duplicate-typed',
      name: 'Duplicate same-target typed apply',
      plan: clone(currentExistingTargetPlan),
    },
  }]), /target occurrence\/body\/feature|already owned/iu);

  const initialRebuild = await rebuild(firstKernel, reopened, 'initial');
  check(`initial exact assembly rebuild failed: ${JSON.stringify({
    errors: initialRebuild.errors || [],
    solverRank: initialRebuild.evaluation?.solverRank,
    mateResiduals: initialRebuild.evaluation?.mateResiduals,
    degreesOfFreedom: initialRebuild.evaluation?.degreesOfFreedom,
  })}`,
    initialRebuild.kind === 'rebuild-result'
      && initialRebuild.errors?.length === 0
      && initialRebuild.warnings?.length === 0
      && initialRebuild.effectiveDocumentHash === runtime.studioV5CanonicalHash(reopened));
  check('exact rebuild did not publish target plus three generated bodies', initialRebuild.bodies?.length === 4);
  const initialSmartEvidence = assertSmartEvidence(initialRebuild, reopened, initialGroup, 8, 'M6x20');
  const initialBodies = new Map<string, JsonRecord>(initialRebuild.bodies.map((body: JsonRecord) => [
    body.occurrenceInstance?.occurrenceId,
    body,
  ]));
  check('exact rebuild omitted the target occurrence', initialBodies.has(TARGET_OCCURRENCE_ID));
  for (const [role, occurrenceId] of Object.entries(initialGroup.occurrenceIds) as Array<[string, string]>) {
    assertCompleteExactBody(initialBodies.get(occurrenceId), `initial ${role}`);
  }
  assertCompleteExactBody(initialBodies.get(TARGET_OCCURRENCE_ID), 'initial target plate');

  // 11.204 mm is deliberately just beyond the M6x20 complete-stack boundary:
  // 11.204 + 1.6 washer + 5.2 nut + 2 * 1.0 pitch = 20.004 mm. Rounding the
  // measured OCCT grip to 0.01 mm would incorrectly select M6x20.
  const thresholdSource = plateAssembly({
    projectId: 'project-smart-fastener-threshold',
    height: 11.204,
  });
  const thresholdPlan = await plan(firstKernel, thresholdSource, 'exact-threshold-11.204');
  check('threshold plan rounded the exact OCCT grip to 0.01 mm',
    closeTo(thresholdPlan.target.exactGrip, 11.204, 1e-8)
      && thresholdPlan.target.exactGrip > 11.2);
  check('threshold plan selected M6x20 from a rounded grip instead of M6x30',
    thresholdPlan.selections.screw.designation === 'M6x30'
      && thresholdPlan.selections.screw.parameterOverrides.length === 30);
  check('threshold plan rounded its exact rigid placement translation to 0.01 mm',
    closeTo(thresholdPlan.occurrences.washer.baseTransform[14], 11.204, 1e-8)
      && thresholdPlan.occurrences.washer.baseTransform[14] > 11.2);
  const thresholdApplied = applyTyped(thresholdSource, thresholdPlan);
  const thresholdReopened = canonicalSaveReopen(thresholdApplied);
  const thresholdGroup = smartGroup(thresholdReopened);
  const thresholdRebuild = await rebuild(firstKernel, thresholdReopened, 'exact-threshold-11.204');
  check(`threshold exact assembly rebuild failed: ${JSON.stringify(thresholdRebuild.errors || [])}`,
    thresholdRebuild.kind === 'rebuild-result'
      && thresholdRebuild.errors?.length === 0
      && thresholdRebuild.warnings?.length === 0
      && thresholdRebuild.bodies?.length === 4
      && thresholdRebuild.effectiveDocumentHash === runtime.studioV5CanonicalHash(thresholdReopened));
  const thresholdEvidence = assertSmartEvidence(
    thresholdRebuild,
    thresholdReopened,
    thresholdGroup,
    11.204,
    'M6x30',
  );
  check('threshold worker evidence rounded the measured grip or required stack length',
    closeTo(thresholdEvidence.groups[0].target.exactGrip, 11.204, 1e-8)
      && closeTo(thresholdEvidence.groups[0].catalog.requiredLength, 20.004, 1e-8)
      && thresholdEvidence.groups[0].catalog.requiredLength > 20);

  const secondTargetProject = runtime.createStudioV5ComponentOccurrence(clone(reopened), {
    id: SECOND_TARGET_OCCURRENCE_ID,
    name: 'Plate:2',
    definition: clone(assemblyFor(reopened).occurrences.find(
      (entry: JsonRecord) => entry.id === TARGET_OCCURRENCE_ID,
    ).definition),
    baseTransform: [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      60, 0, 0, 1,
    ],
    fixed: true,
    visible: true,
  }) as JsonRecord;
  const secondTargetPlan = await plan(
    firstKernel,
    secondTargetProject,
    'secondary-target',
    SECOND_TARGET_OCCURRENCE_ID,
  );
  const twoTargetGroups = smartFasteners.applyStudioSmartFastenerPlan(
    clone(secondTargetProject),
    clone(secondTargetPlan),
    { id: SECOND_GROUP_ID, name: 'Secondary target Smart Fastener' },
  ).project as JsonRecord;
  smartFasteners.assertStudioSmartFastenersProject(twoTargetGroups);
  check('two-target update fixture did not retain two distinct Smart Fastener associations',
    assemblyFor(twoTargetGroups).extensions.smartFasteners.groups.length === 2
      && new Set(assemblyFor(twoTargetGroups).extensions.smartFasteners.groups.map(
        (group: JsonRecord) => group.targetOccurrenceId,
      )).size === 2);
  const occupiedSecondTargetPlan = await plan(
    firstKernel,
    twoTargetGroups,
    'occupied-secondary-target',
    SECOND_TARGET_OCCURRENCE_ID,
  );
  const duplicateUpdateInput = clone(twoTargetGroups);
  const duplicateUpdateInputBytes = JSON.stringify(duplicateUpdateInput);
  const duplicateUpdateError = thrown('direct update onto another group\'s occupied target', () =>
    smartFasteners.updateStudioSmartFastenerGroup(
      duplicateUpdateInput,
      GROUP_ID,
      clone(occupiedSecondTargetPlan),
    ), /target occurrence\/body\/feature|already owned/iu) as JsonRecord;
  check('duplicate update refusal did not retain its typed error code',
    duplicateUpdateError.code === 'SMART_FASTENER_TARGET_DUPLICATE');
  check('failed direct update did not leave the caller document byte-for-byte unchanged',
    JSON.stringify(duplicateUpdateInput) === duplicateUpdateInputBytes);
  thrown('typed update onto another group\'s occupied target', () => transaction(
    twoTargetGroups,
    'transaction-smart-fastener-duplicate-update',
    [{
      kind: 'smartFastener.update',
      input: { smartFastenerId: GROUP_ID, plan: clone(occupiedSecondTargetPlan) },
    }],
  ), /target occurrence\/body\/feature|already owned/iu);

  // A second fresh worker must derive the same plan, B-reps, placement and
  // evidence from document bytes rather than a retained in-process fixture.
  await firstKernel.dispose();
  firstKernel = null;
  secondKernel = await createHeadlessKernel();
  await secondKernel.waitForKernel();
  const repeatedPlan = await plan(secondKernel, source, 'fresh-repeat');
  check('fresh-kernel planning is not deterministic', JSON.stringify(repeatedPlan) === JSON.stringify(initialPlan));
  const repeatedRebuild = await rebuild(secondKernel, reopened, 'fresh-repeat');
  check(`fresh exact assembly rebuild failed: ${JSON.stringify(repeatedRebuild.errors || [])}`,
    repeatedRebuild.kind === 'rebuild-result'
      && repeatedRebuild.errors?.length === 0
      && repeatedRebuild.effectiveDocumentHash === runtime.studioV5CanonicalHash(reopened));
  const repeatedSmartEvidence = assertSmartEvidence(repeatedRebuild, reopened, initialGroup, 8, 'M6x20');
  check('fresh-kernel exact Smart Fastener evidence is not deterministic',
    JSON.stringify(repeatedSmartEvidence) === JSON.stringify(initialSmartEvidence));
  const repeatedBodies = new Map<string, JsonRecord>(repeatedRebuild.bodies.map((body: JsonRecord) => [
    body.occurrenceInstance?.occurrenceId,
    body,
  ]));
  for (const occurrenceId of [TARGET_OCCURRENCE_ID, ...Object.values(initialGroup.occurrenceIds)] as string[]) {
    const first = initialBodies.get(occurrenceId);
    const repeated = repeatedBodies.get(occurrenceId);
    assertCompleteExactBody(first, `initial deterministic ${occurrenceId}`);
    assertCompleteExactBody(repeated, `fresh ${occurrenceId}`);
    check(`${occurrenceId} canonical exact B-rep changed in a fresh kernel`, repeated.exactBrep === first.exactBrep);
    check(`${occurrenceId} exact solved placement changed in a fresh kernel`,
      JSON.stringify(repeated.occurrenceInstance) === JSON.stringify(first.occurrenceInstance)
        && JSON.stringify(repeated.geometry.bounds) === JSON.stringify(first.geometry.bounds));
  }

  const taller = editedGrip(reopened, 18);
  const tallerHash = runtime.studioV5CanonicalHash(taller);
  thrown('old plan after associative plate edit',
    () => smartFasteners.assertStudioSmartFastenerPlan(initialPlan, { documentHash: tallerHash }), /stale/u);
  thrown('old plan update after associative plate edit',
    () => smartFasteners.updateStudioSmartFastenerGroup(clone(taller), GROUP_ID, clone(initialPlan)), /stale/u);
  const tallerPlan = await plan(secondKernel, taller, 'grip-18');
  check('associative edit did not derive the exact 18 mm grip', closeTo(tallerPlan.target.exactGrip, 18));
  check('associative edit did not choose the shortest M6x30 catalog screw',
    tallerPlan.selections.screw.designation === 'M6x30'
      && tallerPlan.selections.screw.parameterOverrides.length === 30);
  check('associative edit did not change exact source face evidence',
    closeTo(Math.abs(
      tallerPlan.target.entryReference.signature.p[2] - tallerPlan.target.exitReference.signature.p[2],
    ), 18));
  const runtimeUpdated = runtime.updateStudioV5SmartFastenerGroup(
    clone(taller),
    GROUP_ID,
    clone(tallerPlan),
  ).project as JsonRecord;
  smartFasteners.assertStudioSmartFastenersProject(runtimeUpdated);
  const updated = updateTyped(taller, tallerPlan);
  smartFasteners.assertStudioSmartFastenersProject(updated);
  const updatedGroup = smartGroup(updated);
  check('runtime and typed update APIs disagree on persisted Smart Fastener state',
    JSON.stringify(smartGroup(runtimeUpdated)) === JSON.stringify(updatedGroup));
  check('update changed group identity', updatedGroup.id === initialGroup.id);
  check('update replaced role-stable occurrence identities',
    JSON.stringify(updatedGroup.occurrenceIds) === JSON.stringify(initialGroup.occurrenceIds));
  check('update replaced role-stable mate identities',
    JSON.stringify(updatedGroup.mateIds) === JSON.stringify(initialGroup.mateIds));
  check('update did not persist the M6x30 selection', updatedGroup.selections.screw.designation === 'M6x30');

  // Reset the second fresh worker's exact cache so every updated role publishes
  // a complete payload, including unchanged washer/nut variants that an
  // incremental response may legitimately reference from its prior render.
  requestSerial += 1;
  const release = await secondKernel.request({
    kind: 'release',
    requestId: `smart-fastener-release-${requestSerial}`,
    projectId: updated.projectId,
    revision: requestSerial,
    bodyId: null,
  }, 180_000) as JsonRecord;
  check('production worker cache release failed', release.kind === 'release-result');
  const updatedRebuild = await rebuild(secondKernel, updated, 'grip-18');
  check(`updated exact assembly rebuild failed: ${JSON.stringify(updatedRebuild.errors || [])}`,
    updatedRebuild.kind === 'rebuild-result'
      && updatedRebuild.errors?.length === 0
      && updatedRebuild.warnings?.length === 0
      && updatedRebuild.effectiveDocumentHash === runtime.studioV5CanonicalHash(updated));
  const updatedSmartEvidence = assertSmartEvidence(updatedRebuild, updated, updatedGroup, 18, 'M6x30');
  check('associative edit left stale Smart Fastener exact evidence',
    JSON.stringify(updatedSmartEvidence) !== JSON.stringify(initialSmartEvidence));
  const updatedBodies = new Map<string, JsonRecord>(updatedRebuild.bodies.map((body: JsonRecord) => [
    body.occurrenceInstance?.occurrenceId,
    body,
  ]));
  const movedRoles: string[] = [];
  for (const [role, occurrenceId] of Object.entries(updatedGroup.occurrenceIds) as Array<[string, string]>) {
    const body = updatedBodies.get(occurrenceId);
    assertCompleteExactBody(body, `updated ${role}`);
    if (JSON.stringify(body.geometry.bounds) !== JSON.stringify(initialBodies.get(occurrenceId)?.geometry.bounds)) {
      movedRoles.push(role);
    }
  }
  check('grip edit did not update the generated exact placement', movedRoles.includes('screw')
    && movedRoles.includes('washer'));
  check('M6x30 screw exact B-rep did not replace M6x20',
    updatedBodies.get(updatedGroup.occurrenceIds.screw)?.exactBrep
      !== initialBodies.get(initialGroup.occurrenceIds.screw)?.exactBrep);

  await rejected('M3 unsupported catalog plan', () => planRaw(secondKernel!, plateAssembly({
    projectId: 'project-smart-fastener-m3', designation: 'M3',
  }), 'unsupported-m3'), /M5|M6|M8|M10|M12|unsupported|Smart Fastener/iu);
  await rejected('M4 unsupported catalog plan', () => planRaw(secondKernel!, plateAssembly({
    projectId: 'project-smart-fastener-m4', designation: 'M4',
  }), 'unsupported-m4'), /M5|M6|M8|M10|M12|unsupported|Smart Fastener/iu);
  await rejected('non-clearance Hole Wizard plan', () => planRaw(secondKernel!, plateAssembly({
    projectId: 'project-smart-fastener-tapped', kind: 'tapped',
  }), 'unsupported-tapped'), /clearance|Smart Fastener/iu);
  await rejected('suppressed Hole Wizard plan', () => planRaw(secondKernel!, plateAssembly({
    projectId: 'project-smart-fastener-suppressed', suppressed: true,
  }), 'unsupported-suppressed'), /clearance|unsuppressed|Smart Fastener/iu);
  await rejected('ambiguous multiple-hole plan', () => planRaw(secondKernel!, plateAssembly({
    projectId: 'project-smart-fastener-multiple', holeCount: 2,
  }), 'unsupported-multiple'), /one|unique|multiple|clearance|Smart Fastener/iu);
  await rejected('oversize grip with no catalog length', () => planRaw(secondKernel!, plateAssembly({
    projectId: 'project-smart-fastener-oversize', height: 40,
  }), 'unsupported-oversize'), /long enough|catalog|stack|Smart Fastener/iu);
  requestSerial += 1;
  await rejected('caller-supplied designation override', () => secondKernel!.request({
    kind: 'smart-fastener-plan-v5',
    requestId: `smart-fastener-plan-${requestSerial}-caller-override`,
    projectId: source.projectId,
    revision: requestSerial,
    document: source,
    targetOccurrenceId: TARGET_OCCURRENCE_ID,
    designation: 'M8',
  }, 180_000), /derive|cannot supply|targetOccurrenceId|Smart Fastener/iu);

  const missingName = tamperedPlan(initialPlan, (candidate) => {
    candidate.target.holeReference.semanticPath.name = '';
    candidate.mates[0].references[1].semanticPath.name = '';
    candidate.mates[2].references[1].semanticPath.name = '';
  });
  thrown('plan without the persistent target name',
    () => smartFasteners.assertStudioSmartFastenerPlan(missingName), /persistent face name/u);
  const runtimeOwner = tamperedPlan(initialPlan, (candidate) => {
    const runtimeBodyId = `${TARGET_OCCURRENCE_ID}:${sourceBody.id}`;
    candidate.target.holeReference.ownerId = runtimeBodyId;
    candidate.mates[0].references[1].ownerId = runtimeBodyId;
    candidate.mates[2].references[1].ownerId = runtimeBodyId;
  });
  thrown('plan with a runtime-prefixed body owner',
    () => smartFasteners.assertStudioSmartFastenerPlan(runtimeOwner), /source body|ownerId/u);
  const badFingerprint = clone(initialPlan);
  badFingerprint.target.exactGrip = 9;
  thrown('plan fingerprint tamper', () => smartFasteners.assertStudioSmartFastenerPlan(badFingerprint), /fingerprint/u);
  const badHash = clone(initialPlan);
  badHash.documentHash = '0'.repeat(64);
  badHash.fingerprint = smartFasteners.studioSmartFastenerPlanFingerprint(badHash);
  thrown('plan current-document hash tamper',
    () => smartFasteners.assertStudioSmartFastenerPlan(badHash, { documentHash: sourceHash }), /stale/u);
  const badCatalog = tamperedPlan(initialPlan, (candidate) => {
    candidate.selections.screw.parameterOverrides.length = 12;
  });
  thrown('plan catalog override tamper',
    () => smartFasteners.assertStudioSmartFastenerPlan(badCatalog), /catalog|canonical/u);

  const badOccurrenceCrosslink = clone(updated);
  smartGroup(badOccurrenceCrosslink).occurrenceIds.screw = 'occurrence-not-owned';
  thrown('stored occurrence crosslink tamper',
    () => smartFasteners.assertStudioSmartFastenersProject(badOccurrenceCrosslink), /owned IDs|ownership|missing/u);
  const badMateCrosslink = clone(updated);
  smartGroup(badMateCrosslink).mateIds['nut-coincident-exit'] = 'mate-not-owned';
  thrown('stored mate crosslink tamper',
    () => smartFasteners.assertStudioSmartFastenersProject(badMateCrosslink), /owned IDs|ownership|missing/u);
  const badOccurrenceOverride = clone(updated);
  const tamperedGroup = smartGroup(badOccurrenceOverride);
  assemblyFor(badOccurrenceOverride).occurrences.find(
    (entry: JsonRecord) => entry.id === tamperedGroup.occurrenceIds.screw,
  ).parameterOverrides.length = 12;
  thrown('stored catalog occurrence override tamper',
    () => smartFasteners.assertStudioSmartFastenersProject(badOccurrenceOverride), /catalog|configuration|occurrence/u);
  const badMateReference = clone(updated);
  const referenceGroup = smartGroup(badMateReference);
  assemblyFor(badMateReference).mates.find(
    (entry: JsonRecord) => entry.id === referenceGroup.mateIds['screw-concentric-hole'],
  ).references[1].ownerId = `${TARGET_OCCURRENCE_ID}:${sourceBody.id}`;
  thrown('stored runtime-prefixed mate owner tamper',
    () => smartFasteners.assertStudioSmartFastenersProject(badMateReference), /named source-body|owner/u);
  await assertRebuildRefusesSmartEvidence(
    secondKernel,
    badOccurrenceOverride,
    'worker-catalog-override-tamper',
    /Smart Fastener|catalog|configuration|occurrence/iu,
  );
  await assertRebuildRefusesSmartEvidence(
    secondKernel,
    badMateReference,
    'worker-runtime-owner-tamper',
    /Smart Fastener|named source-body|owner/iu,
  );

  thrown('generic target deletion while Smart Fastener owns the association', () => transaction(updated, 'transaction-delete-target', [{
    kind: 'component.delete', input: { occurrenceId: TARGET_OCCURRENCE_ID },
  }]), /Smart Fastener|dependency|referenced/u);
  thrown('generic generated occurrence deletion while Smart Fastener owns it', () => transaction(updated, 'transaction-delete-owned', [{
    kind: 'component.delete', input: { occurrenceId: updatedGroup.occurrenceIds.screw },
  }]), /Smart Fastener|dependency|owned|referenced/u);

  const beforeDelete = assemblyFor(updated);
  const deleted = deleteTyped(updated);
  smartFasteners.assertStudioSmartFastenersProject(deleted);
  const deletedAssembly = assemblyFor(deleted);
  check('typed delete did not remove exactly three owned occurrences',
    deletedAssembly.occurrences.length === beforeDelete.occurrences.length - 3
      && Object.values(updatedGroup.occurrenceIds).every((id) => !deletedAssembly.occurrences.some((entry: JsonRecord) => entry.id === id)));
  check('typed delete did not remove exactly six owned mates',
    deletedAssembly.mates.length === beforeDelete.mates.length - 6
      && Object.values(updatedGroup.mateIds).every((id) => !deletedAssembly.mates.some((entry: JsonRecord) => entry.id === id)));
  check('typed delete left a Smart Fastener group', deletedAssembly.extensions?.smartFasteners === undefined);
  check('typed delete removed or changed the unrelated host occurrence',
    deletedAssembly.occurrences.length === 1
      && deletedAssembly.occurrences[0].id === TARGET_OCCURRENCE_ID
      && JSON.stringify(deletedAssembly.occurrences[0]) === JSON.stringify(beforeDelete.occurrences.find(
        (entry: JsonRecord) => entry.id === TARGET_OCCURRENCE_ID,
      )));
  check('typed delete removed source-owned catalog definitions',
    ['part-standard-iso4017-hex-screw', 'part-standard-iso7089-plain-washer', 'part-standard-iso4032-hex-nut']
      .every((partId) => deleted.partDefinitions.some((entry: JsonRecord) => entry.id === partId)
        && deleted.partConfigurationSets.some((entry: JsonRecord) => entry.partId === partId)));

  const [workerSource, buildSource, runtimeSource, agentSource] = await Promise.all([
    readFile(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8'),
    readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
    readFile(resolve(root, 'src/static/studio-v5-runtime-document.js'), 'utf8'),
    readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  ]);
  check('release asset allowlist omits Smart Fasteners', buildSource.includes("'studio-smart-fasteners.js'"));
  check('production worker request routing omits Smart Fastener planning',
    workerSource.includes("request.kind === 'smart-fastener-plan-v5'")
      && workerSource.includes('assertStudioSmartFastenerPlan'));
  check('production worker still rewrites a measured positive intersection volume to literal zero',
    workerSource.includes('positiveVolumeMm3: volume')
      && !/positiveVolumeMm3\s*:\s*0\b/u.test(workerSource));
  check('runtime document API does not expose the Smart Fastener lifecycle',
    runtimeSource.includes('applyStudioV5SmartFastenerPlan')
      && runtimeSource.includes('updateStudioV5SmartFastenerGroup')
      && runtimeSource.includes('deleteStudioV5SmartFastenerGroup'));
  check('typed agent API does not expose the Smart Fastener lifecycle',
    agentSource.includes("'smartFastener.apply'")
      && agentSource.includes("'smartFastener.update'")
      && agentSource.includes("'smartFastener.delete'"));

  console.log(JSON.stringify({
    schema: 'partmode.smart-fasteners-smoke/v1',
    plan: {
      target: initialPlan.target,
      selections: Object.fromEntries(Object.entries(initialPlan.selections).map(([role, selection]: [string, any]) => [
        role,
        { standard: selection.familyId, designation: selection.designation, configurationId: selection.configurationId },
      ])),
      occurrences: Object.keys(initialPlan.occurrences).length,
      mates: initialPlan.mates.length,
      deterministicFreshKernels: 2,
      exactThreshold: {
        grip: thresholdEvidence.groups[0].target.exactGrip,
        requiredLength: thresholdEvidence.groups[0].catalog.requiredLength,
        screw: thresholdEvidence.groups[0].catalog.selections.screw.designation,
        saveReopenAndExactRebuild: true,
      },
    },
    lifecycle: {
      createdOccurrences: 3,
      createdMates: 6,
      update: { exactGrip: 18, screw: tallerPlan.selections.screw.designation, identitiesPreserved: true },
      delete: { occurrences: 3, mates: 6, sourceDefinitionsRetained: 3 },
    },
    exact: {
      initialBodies: initialRebuild.bodies.length,
      updatedBodies: updatedRebuild.bodies.length,
      currentHashBound: true,
      canonicalBreps: true,
      completePersistentTopology: true,
      measuredInterference: initialSmartEvidence.groups[0].interference,
    },
    refused: [
      'M3', 'M4', 'non-clearance', 'suppressed', 'multiple holes', 'oversize grip',
      'missing persistent name', 'runtime body owner', 'stale hash', 'fingerprint tamper',
      'catalog override', 'occurrence crosslink', 'mate crosslink', 'generic owned deletion',
      'duplicate same-target apply', 'duplicate persisted target', 'update onto occupied target',
      'late apply ID collision after catalog preparation',
    ],
  }, null, 2));
} finally {
  await firstKernel?.dispose();
  await secondKernel?.dispose();
}
