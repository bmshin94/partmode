import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Weld-bead smoke failed: ${label}`);
}

function closeTo(actual: number, expected: number, tolerance = 2e-5): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function boundsClose(actual: number[][], expected: number[][], tolerance = 2e-5): boolean {
  return Array.isArray(actual) && actual.length === 2
    && actual.every((corner, cornerIndex) => Array.isArray(corner) && corner.length === 3
      && corner.every((value, axis) => closeTo(value, expected[cornerIndex]?.[axis] ?? Number.NaN, tolerance)));
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
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const [runtime, agent, projectModule, weldBeads, drawingBook, drawingTables, drawingPdf, registry, interaction] = await Promise.all([
  moduleAt('src/static/studio-v5-runtime-document.js'),
  moduleAt('src/static/studio-agent-service.js'),
  moduleAt('src/static/studio-project-v5.js'),
  moduleAt('src/static/studio-weld-beads.js'),
  moduleAt('src/static/studio-drawing-book.js'),
  moduleAt('src/static/studio-drawing-tables.js'),
  moduleAt('src/static/studio-drawing-pdf.js'),
  moduleAt('src/static/studio-v6-ui-registry.js'),
  moduleAt('src/static/studio-v6-interaction.js'),
]);

function blankProject(projectId: string): JsonRecord {
  return runtime.createStudioV5RuntimePartProject({
  projectId,
    name: 'Exact modeled weld bead acceptance', units: 'mm', parameters: [], features: [],

}) as JsonRecord;
}

function transact(project: JsonRecord, transactionId: string, operations: JsonRecord[]): JsonRecord {
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

function sourceProject(projectId: string): JsonRecord {
  return transact(blankProject(projectId), 'create-touching-members', [
    {
      kind: 'sketch.path.create',
      input: { id: 'path-a', name: 'Support A path', curveKind: 'polyline', points: [[0, 0, 0], [0, 0, 100]] },
    },
    {
      kind: 'sketch.path.create',
      input: { id: 'path-b', name: 'Support B path', curveKind: 'polyline', points: [[0, 0, 0], [0, 0, 100]] },
    },
    {
      kind: 'structural.member.create',
      input: {
        id: 'member-a', name: 'Support <A>', pathSketchId: 'path-a',
        familyId: 'rectangular-bar', presetId: 'rect-20x10',
        placement: { anchor: 'center', rotationDegrees: 0, offset: [0, 0] },
      },
    },
    {
      kind: 'structural.member.create',
      input: {
        id: 'member-b', name: 'Support B', pathSketchId: 'path-b',
        familyId: 'rectangular-bar', presetId: 'rect-20x10',
        placement: { anchor: 'center', rotationDegrees: 0, offset: [20, -10] },
      },
    },
  ]);
}

async function rebuild(kernel: HeadlessKernel, project: JsonRecord, revision: number, label: string): Promise<JsonRecord> {
  return kernel.request({
    kind: 'rebuild',
    requestId: `weld-bead-${revision}-${label}`,
    projectId: project.projectId,
    revision,
    document: project,
    includeExactBrep: true,
  }, 180_000) as Promise<JsonRecord>;
}

function bodyFrom(result: JsonRecord, bodyId: string, label: string): JsonRecord {
  const body = result.bodies?.find((entry: JsonRecord) => entry.bodyId === bodyId);
  check(`${label} omitted ${bodyId}: ${JSON.stringify(result.errors || [])}`, body);
  return body;
}

function assertExactBody(result: JsonRecord, project: JsonRecord, revision: number, bodyId: string, label: string): JsonRecord {
  check(`${label} returned stale revision`, result.kind === 'rebuild-result' && result.revision === revision);
  check(`${label} returned stale document hash`, result.effectiveDocumentHash === runtime.studioV5CanonicalHash(project));
  check(`${label} rebuild errors: ${JSON.stringify(result.errors || [])}`, result.errors?.length === 0);
  check(`${label} rebuild warnings: ${JSON.stringify(result.warnings || [])}`, result.warnings?.length === 0);
  const body = bodyFrom(result, bodyId, label);
  check(`${label} has no current exact one-solid B-rep`, !body.error && body.lastValid === false
    && body.geometry?.valid === true && body.geometry?.brepValid === true
    && body.geometry?.solidCount === 1 && body.geometry?.shellCount === 1
    && typeof body.exactBrep === 'string' && body.exactBrep.length > 100);
  const counts = body.mesh?.topologyCounts;
  check(`${label} omitted persistent topology counts`, counts);
  check(`${label} has incomplete face identity`, counts.faces === body.geometry.faceCount && counts.namedFaces === counts.faces);
  check(`${label} has incomplete edge identity`, counts.edges === body.geometry.edgeCount && counts.namedEdges === counts.edges);
  check(`${label} has incomplete vertex identity`, counts.vertices === body.geometry.vertexCount && counts.namedVertices === counts.vertices);
  check(`${label} published topology diagnostics: ${JSON.stringify(body.mesh?.topologyDiagnostics || [])}`,
    Array.isArray(body.mesh?.topologyDiagnostics) && body.mesh.topologyDiagnostics.length === 0);
  return body;
}

function selectedFace(body: JsonRecord, expectedPoint: number[], expectedNormal: number[], label: string): JsonRecord {
  const matches = (body.mesh?.topologyFaces || []).filter((face: JsonRecord) => face.name && face.geomType === 'PLANE'
    && Math.hypot(...face.sig.p.map((value: number, axis: number) => value - (expectedPoint[axis] ?? Number.NaN))) < 0.05
    && face.sig.n.reduce((sum: number, value: number, axis: number) => sum + value * (expectedNormal[axis] ?? 0), 0) > 0.999);
  check(`${label} did not resolve one named planar face: ${JSON.stringify(body.mesh?.topologyFaces || [])}`, matches.length === 1);
  return { name: matches[0].name, sig: structuredClone(matches[0].sig) };
}

function selectedEdge(body: JsonRecord, expectedMidpoint: number[], expectedLength: number, label: string): JsonRecord {
  const matches = (body.mesh?.edges || []).filter((edge: JsonRecord) => edge.name && edge.sig?.curveType === 'LINE'
    && closeTo(edge.sig.l, expectedLength, 0.05)
    && Math.hypot(...edge.sig.p.map((value: number, axis: number) => value - (expectedMidpoint[axis] ?? Number.NaN))) < 0.05);
  check(`${label} did not resolve one named straight edge: ${JSON.stringify(body.mesh?.edges || [])}`, matches.length === 1);
  return { name: matches[0].name, sig: structuredClone(matches[0].sig) };
}

function beadCreateInput(sourceResult: JsonRecord): JsonRecord {
  const bodyA = bodyFrom(sourceResult, 'body-member-a', 'source A selection');
  const bodyB = bodyFrom(sourceResult, 'body-member-b', 'source B selection');
  return {
    id: 'weld-bead-main',
    name: 'Main <fillet> bead',
    bodyName: 'Deposited weld material',
    kind: 'fillet',
    sizeMm: 3,
    process: 'GMAW',
    supports: [
      {
        role: 'support-a', memberId: 'member-a',
        face: selectedFace(bodyA, [0, 10, 50], [0, 1, 0], 'support A'),
        edge: selectedEdge(bodyA, [5, 10, 50], 100, 'support A'),
      },
      {
        role: 'support-b', memberId: 'member-b',
        face: selectedFace(bodyB, [5, 20, 50], [-1, 0, 0], 'support B'),
        edge: selectedEdge(bodyB, [5, 10, 50], 100, 'support B'),
      },
    ],
  };
}

function expectAtomicFailure(label: string, source: JsonRecord, operations: JsonRecord[], pattern: RegExp): void {
  const before = JSON.stringify(source);
  expectFailure(label, () => transact(source, 'reject-' + label.replace(/[^a-z0-9]+/giu, '-'), operations), pattern);
  check(`${label} mutated its source`, JSON.stringify(source) === before);
}

check('weld-bead schema changed', weldBeads.STUDIO_WELD_BEAD_SCHEMA === 'partmode.weld-bead/v1');
check('weld-bead family changed', JSON.stringify(weldBeads.STUDIO_WELD_BEAD_KINDS) === JSON.stringify(['fillet']));
check('weld drawing-table kind is unavailable', drawingTables.STUDIO_DRAWING_TABLE_KINDS.includes('weld'));
const weldControl = (registry.cadUiControlRegistry() as JsonRecord[]).find((entry) => entry.id === 'model.weld-bead');
check('visible weld-bead command is absent from the typed UI registry', weldControl?.adapter === 'available'
  && JSON.stringify(weldControl.operationKinds) === JSON.stringify(['weld.bead.create', 'weld.bead.update', 'weld.bead.delete']));
const weldCommand = registry.cadUiCommandDefinition('model.weld-bead') as JsonRecord;
check('semantic weld-bead command is not advertised with four exact topology selections', weldCommand?.kind === 'command'
  && weldCommand.semanticAction === 'command.open'
  && weldCommand.fields.find((field: JsonRecord) => field.id === 'supports')?.kind === 'selection'
  && weldCommand.fields.find((field: JsonRecord) => field.id === 'supports')?.minItems === 4
  && weldCommand.fields.find((field: JsonRecord) => field.id === 'supports')?.maxItems === 4);

let kernel: HeadlessKernel | null = null;
let freshKernel: HeadlessKernel | null = null;
let revision = 0;
let source: JsonRecord;
let bead: JsonRecord;
let edited: JsonRecord;
let associative: JsonRecord;
let drawingProject: JsonRecord;
let sourceResult: JsonRecord;
let beadResult: JsonRecord;
let editedResult: JsonRecord;
let associativeResult: JsonRecord;
let drawingResult: JsonRecord;
let createInput: JsonRecord;

try {
  source = sourceProject('project-weld-bead');
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  sourceResult = await rebuild(kernel, source, ++revision, 'source');
  const sourceA = assertExactBody(sourceResult, source, revision, 'body-member-a', 'source member A');
  const sourceB = assertExactBody(sourceResult, source, revision, 'body-member-b', 'source member B');
  check('source A bounds drifted', boundsClose(sourceA.geometry.bounds, [[-5, -10, 0], [5, 10, 100]]));
  check('source B bounds drifted', boundsClose(sourceB.geometry.bounds, [[5, 10, 0], [15, 30, 100]]));
  check('source member volume drifted', closeTo(sourceA.geometry.volume, 20_000) && closeTo(sourceB.geometry.volume, 20_000));

  createInput = beadCreateInput(sourceResult);
  const maximumId = 'w'.repeat(115);
  const maximumIdProject = transact(source, 'create-maximum-length-weld-id', [{
    kind: 'weld.bead.create', input: { ...createInput, id: maximumId },
  }]);
  check('maximum weld-bead ID did not produce a bounded canonical body ID',
    rootPart(maximumIdProject).features.some((entry: JsonRecord) => entry.id === maximumId)
      && rootPart(maximumIdProject).bodies.some((entry: JsonRecord) => entry.id === 'body-' + maximumId)
      && ('body-' + maximumId).length === 120);
  const semanticCreate = interaction.buildCadUiCommandTransaction({
    draft: {
      commandId: 'model.weld-bead', draftId: 'draft-weld-create', baseRevision: 0,
      transactionId: 'visible-weld-create', generatedIds: { featureId: 'semantic-weld-bead' },
      inputValues: {
        name: 'Semantic weld bead', sizeMm: 3, process: 'GMAW', supports: createInput.supports,
      },
      boundSelections: {}, diagnostics: [], state: 'draft', previewId: null,
    },
    expectedRevision: 0,
    transactionId: 'visible-weld-create',
  });
  check('semantic weld-bead create adapter emitted the wrong typed transaction',
    semanticCreate.transaction.operations.length === 1
      && semanticCreate.transaction.operations[0].kind === 'weld.bead.create'
      && semanticCreate.transaction.operations[0].input.supports.length === 2
      && !Object.hasOwn(semanticCreate.transaction.operations[0].input.supports[0], 'bodyId'));
  const semanticUpdate = interaction.buildCadUiCommandTransaction({
    draft: {
      commandId: 'model.weld-bead', draftId: 'draft-weld-update', baseRevision: 0,
      transactionId: 'visible-weld-update', generatedIds: { featureId: 'weld-bead-main' },
      editEntity: { kind: 'feature', id: 'weld-bead-main' },
      inputValues: { name: 'Semantic edited bead', sizeMm: 4, process: 'GTAW' },
      boundSelections: {}, diagnostics: [], state: 'draft', previewId: null,
    },
    expectedRevision: 0,
    transactionId: 'visible-weld-update',
  });
  check('semantic weld-bead update adapter emitted the wrong typed transaction',
    semanticUpdate.transaction.operations.length === 1
      && semanticUpdate.transaction.operations[0].kind === 'weld.bead.update'
      && semanticUpdate.transaction.operations[0].input.featureId === 'weld-bead-main'
      && semanticUpdate.transaction.operations[0].input.patch.sizeMm === 4);
  const creation = agent.applyCadTransaction(source, {
    transactionId: 'create-exact-weld-bead', label: 'create-exact-weld-bead', expectedRevision: 0, atomic: true,
    operations: [{ kind: 'weld.bead.create', input: createInput }],
  });
  bead = creation.project as JsonRecord;
  check('typed create omitted feature/body change records', creation.changeSet.created.some((entry: JsonRecord) => entry.kind === 'feature' && entry.id === 'weld-bead-main')
    && creation.changeSet.created.some((entry: JsonRecord) => entry.kind === 'body' && entry.id === 'body-weld-bead-main'));
  const checked = runtime.assertStudioWeldBeadDocument(bead, 'weld-bead-main') as JsonRecord;
  check('persisted bead contract is detached', checked.recipe.kind === 'fillet' && checked.recipe.sizeMm === 3
    && checked.recipe.process === 'GMAW' && checked.recipe.supports.length === 2
    && checked.feature.inputRefs.length === 8 && checked.createdBody.id === 'body-weld-bead-main');
  const saved = JSON.stringify(projectModule.prepareStudioV5Project(bead));
  const reopened = projectModule.parseStudioV5Project(saved) as JsonRecord;
  check('weld bead changed across canonical save/reopen', JSON.stringify(reopened) === saved
    && JSON.stringify(runtime.assertStudioWeldBeadDocument(reopened, 'weld-bead-main')) === JSON.stringify(checked));

  beadResult = await rebuild(kernel, bead, ++revision, 'size-3');
  const beadBody = assertExactBody(beadResult, bead, revision, 'body-weld-bead-main', '3 mm weld bead');
  check('3 mm bead exact analytic volume drifted', closeTo(beadBody.geometry.volume, 450));
  check(`3 mm bead exact bounds drifted: ${JSON.stringify(beadBody.geometry.bounds)}`,
    boundsClose(beadBody.geometry.bounds, [[2, 10, 0], [5, 13, 100]]));
  check('bead topology is not the canonical triangular prism', beadBody.geometry.faceCount === 5
    && beadBody.geometry.edgeCount === 9 && beadBody.geometry.vertexCount === 6);
  const beadSourceA = assertExactBody(beadResult, bead, revision, 'body-member-a', 'bead source A');
  const beadSourceB = assertExactBody(beadResult, bead, revision, 'body-member-b', 'bead source B');
  const sourceBrepHashes = [sourceA, sourceB, beadSourceA, beadSourceB]
    .map((body) => createHash('sha256').update(body.exactBrep).digest('hex'));
  check(`bead creation modified either source B-rep: ${JSON.stringify(sourceBrepHashes)}`,
    beadSourceA.exactBrep === sourceA.exactBrep && beadSourceB.exactBrep === sourceB.exactBrep);

  edited = transact(bead, 'edit-weld-size-process', [{
    kind: 'weld.bead.update',
    input: { featureId: 'weld-bead-main', patch: { name: 'Edited exact bead', sizeMm: 4, process: 'GTAW' } },
  }]);
  const editedChecked = runtime.assertStudioWeldBeadDocument(edited, 'weld-bead-main') as JsonRecord;
  check('typed update changed immutable support identity', JSON.stringify(editedChecked.recipe.supports) === JSON.stringify(checked.recipe.supports)
    && editedChecked.recipe.sizeMm === 4 && editedChecked.recipe.process === 'GTAW');
  editedResult = await rebuild(kernel, edited, ++revision, 'size-4');
  const editedBody = assertExactBody(editedResult, edited, revision, 'body-weld-bead-main', '4 mm weld bead');
  check('4 mm bead exact analytic volume drifted', closeTo(editedBody.geometry.volume, 800));
  check('4 mm bead exact bounds drifted', boundsClose(editedBody.geometry.bounds, [[1, 10, 0], [5, 14, 100]]));
  check('size update did not change the exact bead B-rep', editedBody.exactBrep !== beadBody.exactBrep);

  associative = transact(edited, 'extend-both-weld-supports', [
    { kind: 'sketch.advanced.update', input: { sketchId: 'path-a', patch: { kind: 'polyline', points: [[0, 0, 0], [0, 0, 120]] } } },
    { kind: 'sketch.advanced.update', input: { sketchId: 'path-b', patch: { kind: 'polyline', points: [[0, 0, 0], [0, 0, 120]] } } },
  ]);
  associativeResult = await rebuild(kernel, associative, ++revision, 'length-120');
  const associativeBody = assertExactBody(associativeResult, associative, revision, 'body-weld-bead-main', '120 mm weld bead');
  check('associative support edit did not rebuild exact bead volume', closeTo(associativeBody.geometry.volume, 960));
  check('associative support edit did not rebuild bead bounds', boundsClose(associativeBody.geometry.bounds, [[1, 10, 0], [5, 14, 120]]));
  check('associative support edit did not change exact bead B-rep', associativeBody.exactBrep !== editedBody.exactBrep);

  drawingProject = transact(associative, 'create-weld-drawing-table', [
    {
      kind: 'drawing.book.initialize',
      input: { title: 'Weld schedule', templateId: 'iso-a3-landscape', name: 'Welds', scale: 'fit', views: ['front', 'top', 'right', 'iso'] },
    },
    {
      kind: 'drawing.table.create',
      input: {
        kind: 'weld', sheetId: 'sheet-000001', name: 'Exact weld schedule',
        positionMm: [12, 12], widthMm: 190, sourceFeatureIds: ['weld-bead-main'],
      },
    },
  ]);
  const graph = drawingTables.inspectStudioDrawingTables(drawingProject) as JsonRecord;
  check('weld table did not persist', graph.tables.length === 1 && graph.tables[0].kind === 'weld'
    && graph.tables[0].sourceFeatureIds[0] === 'weld-bead-main');
  drawingResult = await kernel.request({
    kind: 'drawing-v5', requestId: 'weld-bead-drawing', projectId: drawingProject.projectId,
    revision: ++revision, document: drawingProject, views: ['front', 'top', 'right', 'iso'],
  }, 180_000) as JsonRecord;
  check(`exact weld drawing failed: ${JSON.stringify(drawingResult.errors || [])}`,
    drawingResult.kind === 'drawing-result' && drawingResult.errors?.length === 0
      && drawingResult.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact'
      && drawingResult.manifest.exactProjectionEvidence.documentHash === runtime.studioV5CanonicalHash(drawingProject));

  await kernel.dispose();
  kernel = null;
  freshKernel = await createHeadlessKernel();
  await freshKernel.waitForKernel();
  const freshResult = await rebuild(freshKernel, associative, 1, 'fresh-worker');
  const freshBody = assertExactBody(freshResult, associative, 1, 'body-weld-bead-main', 'fresh-worker weld bead');
  check('fresh production worker changed canonical bead B-rep', createHash('sha256').update(freshBody.exactBrep).digest('hex')
    === createHash('sha256').update(associativeBody.exactBrep).digest('hex'));
} finally {
  await kernel?.dispose();
  await freshKernel?.dispose();
}

const book = drawingBook.inspectStudioDrawingBook(drawingProject!);
const firstPdf = drawingPdf.createStudioDrawingBookPdf(
  drawingResult!, drawingProject!.name, book, null, null, drawingProject!.extensions.drawingTables, drawingProject!,
);
const repeatedPdf = drawingPdf.createStudioDrawingBookPdf(
  drawingResult!, drawingProject!.name, book, null, null, drawingProject!.extensions.drawingTables, drawingProject!,
);
check('weld-table PDF is not deterministic', Buffer.compare(Buffer.from(firstPdf.bytes), Buffer.from(repeatedPdf.bytes)) === 0);
const resolved = firstPdf.manifest.pages[0].drawingTables.tables[0];
check('resolved weld table is not exact/current', resolved.kind === 'weld' && resolved.rows.length === 1
  && resolved.evidence.kind === 'exact-modeled-weld-beads'
  && resolved.evidence.documentHash === runtime.studioV5CanonicalHash(drawingProject));
check(`resolved weld row drifted: ${JSON.stringify(resolved.rows[0])}`,
  resolved.rows[0][0] === 1 && resolved.rows[0][1] === 'Edited exact bead'
    && resolved.rows[0][2] === 'FILLET' && resolved.rows[0][3] === 4
    && closeTo(resolved.rows[0][4], 120, 1e-7) && resolved.rows[0][5] === 'GTAW'
    && closeTo(resolved.rows[0][6], 960, 1e-5));
check('resolved weld evidence omitted source identities', resolved.evidence.featureIds[0] === 'weld-bead-main'
  && resolved.evidence.bodyIds[0] === 'body-weld-bead-main'
  && resolved.evidence.sourceBodyIds.includes('body-member-a') && resolved.evidence.sourceBodyIds.includes('body-member-b'));
const malformedDrawing = structuredClone(drawingResult!);
bodyFrom(malformedDrawing, 'body-weld-bead-main', 'malformed weld drawing').geometry.faceCount = 6;
expectFailure('weld table accepted noncanonical exact topology', () => drawingTables.resolveStudioDrawingSheetTables(
  book,
  drawingProject!.extensions.drawingTables,
  book.sheets[0].id,
  malformedDrawing,
  drawingProject!,
), /canonical triangular-prism topology/u);

const artifactDirectory = await mkdtemp(join(tmpdir(), 'partmode-weld-bead-'));
try {
  const pdfPath = join(artifactDirectory, 'weld-schedule.pdf');
  await writeFile(pdfPath, Buffer.from(firstPdf.bytes));
  const info = spawnSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  check(`independent pdfinfo validation failed: ${info.stderr || info.stdout}`, info.status === 0
    && /^Pages:\s+1$/mu.test(info.stdout) && /^PDF version:\s+\d/mu.test(info.stdout));
  const text = spawnSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });
  if (text.status === 0) {
    check('independent PDF text omitted weld schedule content', text.stdout.includes('Exact weld schedule')
      && text.stdout.includes('Edited exact bead') && text.stdout.includes('GTAW'));
  }
} finally {
  await rm(artifactDirectory, { recursive: true, force: true });
}

expectAtomicFailure('same-member supports', source!, [{
  kind: 'weld.bead.create',
  input: {
    ...createInput!, id: 'same-member-bead',
    supports: [createInput!.supports[0], { ...createInput!.supports[1], memberId: 'member-a' }],
  },
}], /distinct structural members|different structural members/u);
expectAtomicFailure('zero bead size', source!, [{
  kind: 'weld.bead.create', input: { ...createInput!, id: 'zero-bead', sizeMm: 0 },
}], /sizeMm|exclusiveMinimum|greater than/u);
expectAtomicFailure('overlong bead ID', source!, [{
  kind: 'weld.bead.create', input: { ...createInput!, id: 'a'.repeat(116) },
}], /pattern|schema|ID/u);
expectAtomicFailure('association-changing patch', bead!, [{
  kind: 'weld.bead.update', input: { featureId: 'weld-bead-main', patch: { supports: createInput!.supports } },
}], /additional|unsupported|cannot change/u);
expectAtomicFailure('generic bead update bypass', bead!, [{
  kind: 'feature.update', input: { featureId: 'weld-bead-main', patch: { name: 'Bypass' } },
}], /weld\.bead\.update/u);
expectAtomicFailure('generic bead suppression bypass', bead!, [{
  kind: 'feature.suppress', input: { featureId: 'weld-bead-main', suppressed: true },
}], /typed weld\.bead lifecycle/u);
expectAtomicFailure('generic bead-body suppression bypass', bead!, [{
  kind: 'body.suppress', input: { bodyId: 'body-weld-bead-main', suppressed: true },
}], /cannot be generically suppressed/u);
expectAtomicFailure('delete referenced support member', bead!, [{
  kind: 'feature.delete', input: { featureId: 'member-a' },
}], /used by weld beads|structural dependents/u);
expectAtomicFailure('delete table-referenced bead', drawingProject!, [{
  kind: 'weld.bead.delete', input: { featureId: 'weld-bead-main' },
}], /used by drawing weld tables/u);

const oversized = transact(source!, 'create-oversized-bead', [{
  kind: 'weld.bead.create', input: { ...createInput!, id: 'oversized-bead', sizeMm: 30 },
}]);
const tampered = structuredClone(bead!);
const tamperedFeature = rootPart(tampered).features.find((entry: JsonRecord) => entry.id === 'weld-bead-main');
tamperedFeature.extensions.weldBead.supports[0].edge.name = 'Edead:persistent-name';
tamperedFeature.inputRefs[3].semanticPath.name = 'Edead:persistent-name';
for (const [label, mutate] of [
  ['suppressed weld feature', (project: JsonRecord) => {
    rootPart(project).features.find((entry: JsonRecord) => entry.id === 'weld-bead-main').suppressed = true;
  }],
  ['suppressed weld body', (project: JsonRecord) => {
    rootPart(project).bodies.find((entry: JsonRecord) => entry.id === 'body-weld-bead-main').suppressed = true;
  }],
] as const) {
  const candidate = structuredClone(bead!);
  mutate(candidate);
  expectFailure(label, () => projectModule.prepareStudioV5Project(candidate), /cannot be suppressed|active exact solid body/u);
}
let refusalKernel: HeadlessKernel | null = null;
try {
  refusalKernel = await createHeadlessKernel();
  await refusalKernel.waitForKernel();
  for (const [label, project, bodyId, pattern] of [
    ['oversized bead', oversized, 'body-oversized-bead', /support face|bounded|published/u],
    ['dead persistent edge', tampered, 'body-weld-bead-main', /persistent|matched|published/u],
  ] as const) {
    const result = await rebuild(refusalKernel, project, 1, label.replaceAll(' ', '-'));
    const body = bodyFrom(result, bodyId, label);
    check(`${label} published prohibited geometry`, body.geometry == null && body.error && !body.exactBrep);
    check(`${label} returned the wrong exact refusal: ${body.error?.message}`, pattern.test(body.error?.message || ''));
  }
} finally {
  await refusalKernel?.dispose();
}

const tableId = drawingTables.inspectStudioDrawingTables(drawingProject!).tables[0].id;
const withoutTable = transact(drawingProject!, 'delete-weld-table', [{ kind: 'drawing.table.delete', input: { tableId } }]);
const withoutBead = transact(withoutTable, 'delete-weld-bead', [{ kind: 'weld.bead.delete', input: { featureId: 'weld-bead-main' } }]);
check('typed bead delete left feature or body residue', !rootPart(withoutBead).features.some((entry: JsonRecord) => entry.extensions?.weldBead)
  && !rootPart(withoutBead).bodies.some((entry: JsonRecord) => entry.createdByFeatureId === 'weld-bead-main'));

const [moduleSource, runtimeSource, projectSource, typeSource, workerSource, agentSource, pageSource, studioSource, registrySource, buildSource] = await Promise.all([
  readFile(resolve(root, 'src/static/studio-weld-beads.js'), 'utf8'),
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
check('source-owned bead contract imports DOM or OCCT', !/\/static\/vendor|document\.|window\.|OpenCascade|replicad/iu.test(moduleSource));
check('runtime omits typed weld-bead lifecycle', runtimeSource.includes('export function createStudioWeldBead')
  && runtimeSource.includes('export function updateStudioWeldBead') && runtimeSource.includes('export function deleteStudioWeldBead'));
check('project/type contracts omit weld-bead validation', projectSource.includes('assertStudioWeldBeadPart(')
  && typeSource.includes("'weld-bead': contract('linked-body', ['new-body'])"));
check('worker omits modeled exact weld material', workerSource.includes('buildStudioWeldBeadBody')
  && workerSource.includes('WELD_BEAD_VOLUME_INVALID') && workerSource.includes('weldBeadExactCommonVolume'));
check('agent omits typed weld-bead operations', agentSource.includes("'weld.bead.create'")
  && agentSource.includes("'weld.bead.update'") && agentSource.includes("'weld.bead.delete'"));
check('visible UI omits weld-bead authoring', pageSource.includes('id="bw-weld-bead-open"')
  && pageSource.includes('id="bw-weld-bead-form"') && studioSource.includes("kind: 'weld.bead.create'"));
check('typed UI registry omits weld-bead controls', registrySource.includes("control('model.weld-bead'"));
check('release asset allowlist omits weld-bead contract', buildSource.includes("'studio-weld-beads.js'"));

console.log(JSON.stringify({
  schema: 'partmode.weld-beads-smoke/v1',
  capability: 'modeled continuous equal-leg straight 90-degree fillet bead',
  exactProductionWorkerEvaluations: 8,
  exactVolumesMm3: [450, 800, 960],
  seamLengthsMm: [100, 120],
  topology: { faces: 5, edges: 9, vertices: 6 },
  exactFreshWorkerDeterminism: true,
  saveReopen: true,
  typedLifecycle: ['create', 'update', 'delete'],
  weldTable: { rows: 1, derivedFromCurrentExactTopology: true, deterministicPdf: true, independentPdfinfo: true },
  refusalCases: [
    'same member', 'zero size', 'overlong ID', 'association mutation', 'generic edit/suppress',
    'support member deletion', 'table-referenced deletion', 'oversized leg', 'dead persistent edge',
  ],
  unsupported: [
    'intermittent or multi-segment beads', 'curved seams', 'unequal/convex/concave profiles',
    'groove/plug/slot welds', 'assembly welds', 'automatic inference', 'process or manufacturing certification',
  ],
}, null, 2));
