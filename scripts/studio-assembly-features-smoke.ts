import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const [runtime, projectModule, agent, assemblyFeatures] = await Promise.all([
  moduleAt('src/static/studio-v5-runtime-document.js'),
  moduleAt('src/static/studio-project-v5.js'),
  moduleAt('src/static/studio-agent-service.js'),
  moduleAt('src/static/studio-assembly-features.js'),
]);

const OCCURRENCE_A = 'occurrence-assembly-feature-a';
const OCCURRENCE_B = 'occurrence-assembly-feature-b';
const OCCURRENCE_C = 'occurrence-assembly-feature-linked-unselected';
const CUT_ID = 'assembly-feature-through-cut';
const HOLE_ID = 'assembly-feature-through-hole';
const PART_FEATURE_ID = 'feature-assembly-feature-plate';

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Assembly features smoke failed: ${label}`);
}

function closeTo(actual: number, expected: number, tolerance = 3e-5): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function transaction(project: JsonRecord, id: string, operations: JsonRecord[]): JsonRecord {
  return agent.applyCadTransaction(project, {
    transactionId: id,
    label: id,
    expectedRevision: 0,
    atomic: true,
    operations,
  }, 0).project as JsonRecord;
}

function baseAssembly(projectId = 'project-assembly-features'): JsonRecord {
  let project = runtime.createStudioV5RuntimePartProject({
  projectId,
    name: 'Assembly feature linked plate',
    units: 'mm',
    parameters: [],
    features: [{
      id: PART_FEATURE_ID,
      type: 'extrude',
      sketch: {
        shapes: [{ id: 'shape-assembly-feature-plate', kind: 'rect', x: 0, y: 0, w: 40, h: 40 }],
        z: 0,
      },
      h: 8,
      through: false,
    }],

});
  project = runtime.createStudioV5AssemblyFromPart(project, {
    id: 'assembly-assembly-features',
    occurrenceId: OCCURRENCE_A,
    name: 'Assembly feature exact fixture',
    occurrenceName: 'Plate A',
    fixed: true,
  });
  project = runtime.duplicateStudioV5LinkedOccurrence(project, OCCURRENCE_A, {
    id: OCCURRENCE_B,
    name: 'Plate B stacked',
    baseTransform: translation(0, 0, 20),
    fixed: true,
  });
  project = runtime.duplicateStudioV5LinkedOccurrence(project, OCCURRENCE_A, {
    id: OCCURRENCE_C,
    name: 'Plate C untouched linked sibling',
    baseTransform: translation(60, 0, 0),
    fixed: true,
  });
  return project;
}

function assemblyContext(project: JsonRecord): { assembly: JsonRecord; part: JsonRecord; body: JsonRecord } {
  const assembly = project.assemblyDefinitions.find(
    (entry: JsonRecord) => entry.id === project.rootDocument.assemblyId,
  );
  const occurrence = assembly.occurrences.find((entry: JsonRecord) => entry.id === OCCURRENCE_A);
  const part = project.partDefinitions.find((entry: JsonRecord) => entry.id === occurrence.definition.partId);
  check('fixture source part has one exact body', part?.bodies?.length === 1);
  return { assembly, part, body: part.bodies[0] };
}

function withFeatures(project: JsonRecord): JsonRecord {
  const { part, body } = assemblyContext(project);
  const targets = [OCCURRENCE_A, OCCURRENCE_B].map((occurrenceId) => ({
    occurrenceId,
    partId: part.id,
    bodyId: body.id,
  }));
  return transaction(project, 'transaction-create-assembly-cut-and-hole', [
    {
      kind: 'assemblyFeature.create',
      input: {
        id: CUT_ID,
        name: 'Through both stacked plates',
        kind: 'cut',
        targets,
        origin: [0, 0, 0],
        direction: [0, 0, 1],
        xDirection: [1, 0, 0],
        width: 10,
        height: 6,
      },
    },
    {
      kind: 'assemblyFeature.create',
      input: {
        id: HOLE_ID,
        name: 'Through both stacked plates hole',
        kind: 'hole',
        targets,
        origin: [8, 0, 0],
        direction: [0, 0, 1],
        xDirection: [1, 0, 0],
        diameter: 4,
      },
    },
  ]);
}

let serial = 0;
async function rebuild(kernel: HeadlessKernel, document: JsonRecord, label: string): Promise<JsonRecord> {
  serial += 1;
  return kernel.request({
    kind: 'rebuild',
    requestId: `assembly-features-rebuild-${serial}-${label}`,
    projectId: document.projectId,
    revision: serial,
    document,
    includeExactBrep: true,
  }, 180_000) as Promise<JsonRecord>;
}

function bodiesByOccurrence(result: JsonRecord): Map<string, JsonRecord> {
  return new Map(result.bodies.map((body: JsonRecord) => [
    body.occurrenceInstance?.occurrenceId,
    body,
  ]));
}

function assertExactBody(body: JsonRecord | undefined, label: string): asserts body is JsonRecord {
  check(`${label} has no current valid one-solid OCCT result: ${JSON.stringify(body)}`,
    body && !body.error && body.lastValid === false
      && body.geometry?.valid === true
      && body.geometry?.brepValid === true
      && body.geometry?.solidCount === 1
      && typeof body.exactBrep === 'string'
      && body.exactBrep.length > 100);
  const counts = body.mesh?.topologyCounts;
  check(`${label} has incomplete persistent topology: ${JSON.stringify(counts)}`,
    counts
      && counts.faces > 0 && counts.faces === counts.namedFaces
      && counts.edges > 0 && counts.edges === counts.namedEdges
      && counts.vertices > 0 && counts.vertices === counts.namedVertices
      && !body.mesh.topologyDiagnostics.some((entry: JsonRecord) => entry.severity === 'error'));
}

function assertFeatureEvidence(result: JsonRecord, project: JsonRecord): JsonRecord {
  const evidence = result.evaluation?.assemblyFeatures;
  check('worker omitted assembly feature evidence',
    evidence?.schema === assemblyFeatures.STUDIO_ASSEMBLY_FEATURE_EVIDENCE_SCHEMA
      && evidence.documentHash === runtime.studioV5CanonicalHash(project)
      && evidence.assemblyId === project.rootDocument.assemblyId
      && evidence.atomic === true
      && evidence.occurrenceScope === 'direct-root-part-occurrences'
      && evidence.operation === 'ordered-private-per-occurrence-occt-cut');
  check('worker did not execute ordered cut and hole families',
    JSON.stringify(evidence.features.map((entry: JsonRecord) => [entry.featureId, entry.kind, entry.status]))
      === JSON.stringify([[CUT_ID, 'cut', 'applied'], [HOLE_ID, 'hole', 'applied']]));
  for (const feature of evidence.features) {
    check(`${feature.featureId} lost through-all or two-target evidence`,
      feature.targets.length === 2
        && feature.throughAll.extentMm > 28
        && feature.targets.every((target: JsonRecord) =>
          target.occurrencePath.length === 1
          && target.occurrencePath[0] === target.occurrenceId
          && target.removedVolumeMm3 > 0
          && target.inputVolumeMm3 > target.resultVolumeMm3
          && /^[0-9a-f]{64}$/u.test(target.inputBrepSha256)
          && /^[0-9a-f]{64}$/u.test(target.resultBrepSha256)
          && /^[0-9a-f]{64}$/u.test(target.topology.persistentNamesSha256)
          && target.topology.counts.faces === target.topology.counts.namedFaces
          && target.topology.counts.edges === target.topology.counts.namedEdges
          && target.topology.counts.vertices === target.topology.counts.namedVertices));
  }
  check('worker did not publish two occurrence-specific final results',
    evidence.resultBodies.length === 2
      && evidence.resultBodies.every((entry: JsonRecord) =>
        JSON.stringify(entry.featureIds) === JSON.stringify([CUT_ID, HOLE_ID])
        && /^[0-9a-f]{64}$/u.test(entry.resultBrepSha256)));
  return evidence;
}

async function exportStep(kernel: HeadlessKernel, document: JsonRecord, label: string): Promise<JsonRecord> {
  serial += 1;
  const result = await kernel.request({
    kind: 'export-step',
    requestId: `assembly-features-export-${serial}-${label}`,
    projectId: document.projectId,
    revision: serial,
    document,
    bodyIds: [],
  }, 180_000) as JsonRecord;
  check(`exact STEP export failed: ${JSON.stringify(result.errors || [])}`,
    result.kind === 'export-result'
      && result.errors?.length === 0
      && result.blob instanceof Blob
      && result.blob.size > 500
      && result.manifest?.assemblyFeatureExportMode === 'flattened-exact-solved-occurrence-breps'
      && result.manifest?.structuredHierarchy === false);
  return result;
}

async function importStep(kernel: HeadlessKernel, exported: JsonRecord): Promise<JsonRecord> {
  serial += 1;
  const imported = await kernel.request({
    kind: 'import-step-v5',
    requestId: `assembly-features-import-${serial}`,
    projectId: 'project-assembly-features-reimport',
    revision: serial,
    blob: exported.blob,
    filename: 'assembly-features-exact.step',
  }, 180_000) as JsonRecord;
  check(`flattened exact STEP did not independently reimport: ${JSON.stringify({
    kind: imported.kind,
    manifest: imported.manifest,
    rootDocument: imported.project?.rootDocument,
  })}`,
    imported.kind === 'import-result'
      && imported.project?.schemaVersion === 5
      && imported.manifest?.bodyCount === 3
      && imported.manifest?.exactGeometry === true
      && imported.manifest?.importMode === 'flat-solid-fallback');
  return imported.project;
}

function canonicalSaveReopen(project: JsonRecord): JsonRecord {
  const saved = JSON.stringify(projectModule.prepareStudioV5Project(project));
  const reopened = projectModule.parseStudioV5Project(saved) as JsonRecord;
  check('canonical save/reopen changed assembly feature document bytes', JSON.stringify(reopened) === saved);
  return reopened;
}

function brepDigest(body: JsonRecord): string {
  return createHash('sha256').update(body.exactBrep).digest('hex');
}

let firstKernel: HeadlessKernel | null = null;
let secondKernel: HeadlessKernel | null = null;
try {
  firstKernel = await createHeadlessKernel();
  await firstKernel.waitForKernel();

  const base = baseAssembly();
  const baseBytes = JSON.stringify(base);
  const baseResult = await rebuild(firstKernel, base, 'base');
  check(`base assembly failed: ${JSON.stringify(baseResult.errors || [])}`,
    baseResult.kind === 'rebuild-result' && baseResult.errors?.length === 0);
  check('base exact rebuild mutated the source document', JSON.stringify(base) === baseBytes);
  const baseBodies = bodiesByOccurrence(baseResult);
  const baseA = baseBodies.get(OCCURRENCE_A);
  assertExactBody(baseA, 'base source plate');
  check('base source plate volume changed', closeTo(baseA.geometry.volume, 40 * 40 * 8));

  const featured = withFeatures(base);
  const featuredBytes = JSON.stringify(featured);
  const { assembly, part, body } = assemblyContext(featured);
  const store = assembly.extensions?.assemblyFeatures;
  check('typed transaction did not persist ordered assembly features',
    store?.schema === assemblyFeatures.STUDIO_ASSEMBLY_FEATURES_SCHEMA
      && JSON.stringify(store.features.map((entry: JsonRecord) => entry.id))
        === JSON.stringify([CUT_ID, HOLE_ID])
      && store.features.every((entry: JsonRecord) =>
        JSON.stringify(entry.placement.xDirection) === JSON.stringify([1, 0, 0])));
  check('assembly features changed the linked source definition',
    JSON.stringify(part) === JSON.stringify(base.partDefinitions.find((entry: JsonRecord) => entry.id === part.id)));

  const featuredResult = await rebuild(firstKernel, featured, 'featured');
  check(`assembly feature rebuild failed: ${JSON.stringify(featuredResult.errors || [])}`,
    featuredResult.kind === 'rebuild-result'
      && featuredResult.errors?.length === 0
      && featuredResult.effectiveDocumentHash === runtime.studioV5CanonicalHash(featured));
  check('assembly feature exact rebuild mutated the authored document', JSON.stringify(featured) === featuredBytes);
  const initialEvidence = assertFeatureEvidence(featuredResult, featured);
  const featuredBodies = bodiesByOccurrence(featuredResult);
  const bodyA = featuredBodies.get(OCCURRENCE_A);
  const bodyB = featuredBodies.get(OCCURRENCE_B);
  const bodyC = featuredBodies.get(OCCURRENCE_C);
  assertExactBody(bodyA, 'cut and holed occurrence A');
  assertExactBody(bodyB, 'cut and holed occurrence B');
  assertExactBody(bodyC, 'untouched linked occurrence C');
  const expectedVolume = 40 * 40 * 8 - 10 * 6 * 8 - Math.PI * 2 * 2 * 8;
  check('occurrence A exact cut/hole volume is wrong', closeTo(bodyA.geometry.volume, expectedVolume));
  check('occurrence B exact cut/hole volume is wrong', closeTo(bodyB.geometry.volume, expectedVolume));
  check('unselected linked occurrence changed exact volume', closeTo(bodyC.geometry.volume, 40 * 40 * 8));
  check('unselected linked occurrence or source definition B-rep changed', bodyC.exactBrep === baseA.exactBrep);
  check('selected occurrences reused shared uncut render geometry',
    bodyA.sourceKey.includes(':assembly-feature:')
      && bodyB.sourceKey.includes(':assembly-feature:')
      && bodyA.renderSourceBodyId === undefined
      && bodyB.renderSourceBodyId === undefined
      && JSON.stringify(bodyA.assemblyFeatureIds) === JSON.stringify([CUT_ID, HOLE_ID])
      && JSON.stringify(bodyB.assemblyFeatureIds) === JSON.stringify([CUT_ID, HOLE_ID]));

  const exported = await exportStep(firstKernel, featured, 'featured');
  const imported = await importStep(firstKernel, exported);
  const importedResult = await rebuild(firstKernel, imported, 'reimported-step');
  check(`reimported exact STEP failed: ${JSON.stringify(importedResult.errors || [])}`,
    importedResult.kind === 'rebuild-result' && importedResult.errors?.length === 0);
  const importedVolume = importedResult.bodies.reduce(
    (total: number, entry: JsonRecord) => total + (entry.geometry?.volume || 0),
    0,
  );
  check('STEP reimport did not contain the exact modified occurrence volumes',
    closeTo(importedVolume, expectedVolume * 2 + 40 * 40 * 8, 1e-3));

  const reopened = canonicalSaveReopen(featured);
  check('save/reopen lost target part/body associations',
    reopened.assemblyDefinitions[0].extensions.assemblyFeatures.features.every((entry: JsonRecord) =>
      entry.targets.every((target: JsonRecord) => target.partId === part.id && target.bodyId === body.id)));

  const edited = transaction(reopened, 'transaction-edit-hole-diameter', [{
    kind: 'assemblyFeature.update',
    input: { assemblyFeatureId: HOLE_ID, patch: { diameter: 5 } },
  }]);
  const editedResult = await rebuild(firstKernel, edited, 'edited-hole');
  check(`edited assembly hole failed: ${JSON.stringify(editedResult.errors || [])}`,
    editedResult.errors?.length === 0);
  const editedBodies = bodiesByOccurrence(editedResult);
  const editedA = editedBodies.get(OCCURRENCE_A);
  assertExactBody(editedA, 'edited hole occurrence A');
  const editedExpected = 40 * 40 * 8 - 10 * 6 * 8 - Math.PI * 2.5 * 2.5 * 8;
  check('typed hole edit did not change exact analytic volume',
    closeTo(editedA.geometry.volume, editedExpected)
      && editedA.exactBrep !== bodyA.exactBrep
      && edited.assemblyDefinitions[0].extensions.assemblyFeatures.features[1].id === HOLE_ID);

  const moved = runtime.updateStudioV5ComponentOccurrence(reopened, OCCURRENCE_B, {
    baseTransform: translation(1, 0, 20),
  });
  const movedResult = await rebuild(firstKernel, moved, 'moved-target');
  check(`associative occurrence move failed: ${JSON.stringify(movedResult.errors || [])}`,
    movedResult.errors?.length === 0);
  const movedBodies = bodiesByOccurrence(movedResult);
  const movedA = movedBodies.get(OCCURRENCE_A);
  const movedB = movedBodies.get(OCCURRENCE_B);
  assertExactBody(movedA, 'unchanged occurrence A after B move');
  assertExactBody(movedB, 'associatively recut occurrence B');
  check('moving B changed the unrelated A result', movedA.exactBrep === bodyA.exactBrep);
  check('moving B did not recut in its current occurrence-local frame', movedB.exactBrep !== bodyB.exactBrep);

  const sourceEdited = transaction(reopened, 'transaction-edit-linked-source-height', [
    { kind: 'assembly.context.enter', input: { occurrenceId: OCCURRENCE_A } },
    { kind: 'feature.update', input: { featureId: PART_FEATURE_ID, patch: { h: 10 } } },
    { kind: 'assembly.context.exit', input: {} },
  ]);
  const sourceEditedResult = await rebuild(firstKernel, sourceEdited, 'source-edited');
  check(`associative source edit failed: ${JSON.stringify(sourceEditedResult.errors || [])}`,
    sourceEditedResult.errors?.length === 0);
  const sourceEditedBodies = bodiesByOccurrence(sourceEditedResult);
  const sourceEditedA = sourceEditedBodies.get(OCCURRENCE_A);
  const sourceEditedB = sourceEditedBodies.get(OCCURRENCE_B);
  const sourceEditedC = sourceEditedBodies.get(OCCURRENCE_C);
  assertExactBody(sourceEditedA, 'source-edited occurrence A');
  assertExactBody(sourceEditedB, 'source-edited occurrence B');
  assertExactBody(sourceEditedC, 'source-edited unselected occurrence C');
  const sourceEditedExpected = 40 * 40 * 10 - 10 * 6 * 10 - Math.PI * 2 * 2 * 10;
  check('source edit did not associatively recut both targets',
    closeTo(sourceEditedA.geometry.volume, sourceEditedExpected)
      && closeTo(sourceEditedB.geometry.volume, sourceEditedExpected)
      && closeTo(sourceEditedC.geometry.volume, 40 * 40 * 10));

  const restored = transaction(reopened, 'transaction-delete-assembly-features', [
    { kind: 'assemblyFeature.delete', input: { assemblyFeatureId: HOLE_ID } },
    { kind: 'assemblyFeature.delete', input: { assemblyFeatureId: CUT_ID } },
  ]);
  const restoredResult = await rebuild(firstKernel, restored, 'deleted-restored');
  check(`feature delete rebuild failed: ${JSON.stringify(restoredResult.errors || [])}`,
    restoredResult.errors?.length === 0 && restoredResult.evaluation?.assemblyFeatures === undefined);
  const restoredA = bodiesByOccurrence(restoredResult).get(OCCURRENCE_A);
  assertExactBody(restoredA, 'restored occurrence A');
  check('deleting assembly history did not restore exact source B-rep', restoredA.exactBrep === baseA.exactBrep);

  const failureBase = baseAssembly('project-assembly-features-atomic-failure');
  const failureContext = assemblyContext(failureBase);
  const failing = transaction(failureBase, 'transaction-create-late-miss', [{
    kind: 'assemblyFeature.create',
    input: {
      id: 'assembly-feature-late-target-miss',
      name: 'Late second target miss',
      kind: 'hole',
      targets: [OCCURRENCE_A, OCCURRENCE_C].map((occurrenceId) => ({
        occurrenceId,
        partId: failureContext.part.id,
        bodyId: failureContext.body.id,
      })),
      origin: [0, 0, 0],
      direction: [0, 0, 1],
      xDirection: [1, 0, 0],
      diameter: 4,
    },
  }]);
  const failingResult = await rebuild(firstKernel, failing, 'late-target-miss');
  const failingMessage = (failingResult.errors || []).map((entry: JsonRecord) => entry.message).join('; ');
  check('late second-target miss did not fail closed',
    failingResult.errors?.some((entry: JsonRecord) => entry.featureType === 'assembly-feature')
      && /does not intersect every selected target/iu.test(failingMessage)
      && failingResult.evaluation?.assemblyFeatures === undefined);
  const failedBodies = bodiesByOccurrence(failingResult);
  const failedA = failedBodies.get(OCCURRENCE_A);
  const failedC = failedBodies.get(OCCURRENCE_C);
  assertExactBody(failedA, 'failure-atomic occurrence A');
  check('failure-atomic occurrence C did not retain the shared valid source result',
    failedC?.geometry?.valid === true
      && failedC.error == null
      && failedC.lastValid === false
      && failedC.renderSourceBodyId === failedA.bodyId
      && closeTo(failedC.geometry.volume, 40 * 40 * 8));
  check('late target failure leaked a partial first-target cut',
    failedA.exactBrep === baseA.exactBrep);

  // A second fresh worker must derive identical B-reps, topology, and evidence
  // from reopened document bytes rather than retained shapes or test fixtures.
  await firstKernel.dispose();
  firstKernel = null;
  secondKernel = await createHeadlessKernel();
  await secondKernel.waitForKernel();
  const repeatedResult = await rebuild(secondKernel, reopened, 'fresh-worker');
  check(`fresh-worker rebuild failed: ${JSON.stringify(repeatedResult.errors || [])}`,
    repeatedResult.errors?.length === 0);
  const repeatedEvidence = assertFeatureEvidence(repeatedResult, reopened);
  check('fresh-worker exact assembly feature evidence changed',
    JSON.stringify(repeatedEvidence) === JSON.stringify(initialEvidence));
  const repeatedBodies = bodiesByOccurrence(repeatedResult);
  for (const occurrenceId of [OCCURRENCE_A, OCCURRENCE_B, OCCURRENCE_C]) {
    const initial = featuredBodies.get(occurrenceId);
    const repeated = repeatedBodies.get(occurrenceId);
    assertExactBody(initial, `initial deterministic ${occurrenceId}`);
    assertExactBody(repeated, `fresh deterministic ${occurrenceId}`);
    check(`${occurrenceId} exact B-rep changed across fresh workers`,
      repeated.exactBrep === initial.exactBrep
        && brepDigest(repeated) === brepDigest(initial)
        && JSON.stringify(repeated.mesh.topologyCounts) === JSON.stringify(initial.mesh.topologyCounts));
  }

  console.log('Studio assembly features smoke passed.');
} finally {
  if (firstKernel) await firstKernel.dispose();
  if (secondKernel) await secondKernel.dispose();
}
