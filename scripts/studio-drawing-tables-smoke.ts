import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Drawing tables smoke failed: ${label}`);
}

function expectCode(label: string, action: () => unknown, code: string): void {
  try { action(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Drawing tables smoke failed: ${label} did not fail`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const [runtime, agent, drawingBook, drawingTables, drawingPdf, holeWizard, projectModule] = await Promise.all([
  moduleAt('src/static/studio-v5-runtime-document.js'),
  moduleAt('src/static/studio-agent-service.js'),
  moduleAt('src/static/studio-drawing-book.js'),
  moduleAt('src/static/studio-drawing-tables.js'),
  moduleAt('src/static/studio-drawing-pdf.js'),
  moduleAt('src/static/studio-hole-wizard.js'),
  moduleAt('src/static/studio-project-v5.js'),
]);

const plateDocument = (projectId: string): JsonRecord => runtime.createStudioV5RuntimePartProject({
  projectId,
  name: 'Associative manufacturing tables',
  units: 'mm',
  parameters: [],
  features: [{
    id: 'feature-base-plate', type: 'extrude',
    sketch: { shapes: [{ id: 'shape-base-plate', kind: 'rect', x: 0, y: 0, w: 40, h: 40 }], z: 0 },
    h: 20, through: false,
  }],

});

const transact = (project: JsonRecord, id: string, operations: JsonRecord[]): JsonRecord => agent.applyCadTransaction(project, {
  transactionId: id, label: id, expectedRevision: 0, atomic: true, operations,
}).project as JsonRecord;

let project = plateDocument('project-drawing-tables');
const body = runtime.studioV5ActiveBody(project);
check('base plate has no active exact target body', body?.id);
const hole = holeWizard.createStudioHoleWizardFeature({
  id: 'feature-table-hole', bodyId: body.id, kind: 'counterbore', designation: 'M6', center: [6, -4], sketchZ: 20,
});
project = transact(project, 'create-table-source-hole', [{ kind: 'feature.cut', input: holeWizard.studioHoleWizardOperationInput(hole) }]);
project = transact(project, 'initialize-table-sheet', [{
  kind: 'drawing.book.initialize',
  input: { title: 'Manufacturing tables', templateId: 'iso-a3-landscape', name: 'Manufacturing', scale: 'fit', views: ['front', 'top', 'right', 'iso'] },
}]);
const tableCreation = agent.applyCadTransaction(project, {
  transactionId: 'create-drawing-tables', label: 'create-drawing-tables', expectedRevision: 0, atomic: true, operations: [
  {
    kind: 'drawing.table.create',
    input: { kind: 'cut-list', sheetId: 'sheet-000001', name: 'Exact cut list', positionMm: [12, 12], widthMm: 155, sourceType: 'body-axis', axis: 'z', sourceBodyIds: [body.id] },
  },
  {
    kind: 'drawing.table.create',
    input: { kind: 'hole', sheetId: 'sheet-000001', name: 'Hole schedule', positionMm: [12, 36], widthMm: 155, sourceFeatureIds: ['feature-table-hole'] },
  },
  {
    kind: 'drawing.table.create',
    input: {
      kind: 'revision', sheetId: 'sheet-000001', name: 'Revision history', positionMm: [12, 60], widthMm: 155,
      entries: [
        { revision: 'A', description: 'Initial release', date: '2026-08-02', approvedBy: 'QA' },
        { revision: 'B', description: 'Counterbore added', date: '2026-08-03', approvedBy: 'Lead' },
      ],
    },
  },
  ],
});
project = tableCreation.project as JsonRecord;
check('typed table entities are incomplete', tableCreation.changeSet.created.filter((entry: JsonRecord) => entry.kind === 'drawing-table').length === 3);
project = transact(project, 'create-temporary-drawing-table', [{
  kind: 'drawing.table.create',
  input: {
    kind: 'revision', sheetId: 'sheet-000001', name: 'Temporary revisions', positionMm: [180, 12], widthMm: 100,
    entries: [{ revision: 'X', description: 'Temporary', date: '2026-08-04', approvedBy: 'QA' }],
  },
}]);
const temporaryTableId = drawingTables.inspectStudioDrawingTables(project).tables.at(-1).id;
project = transact(project, 'update-temporary-drawing-table', [{
  kind: 'drawing.table.update', input: { tableId: temporaryTableId, patch: { name: 'Updated temporary revisions' } },
}]);
check('typed table update did not persist', drawingTables.inspectStudioDrawingTables(project).tables.at(-1).name === 'Updated temporary revisions');
project = transact(project, 'delete-temporary-drawing-table', [{ kind: 'drawing.table.delete', input: { tableId: temporaryTableId } }]);

const graph = drawingTables.inspectStudioDrawingTables(project);
check('typed table operations did not create all three persistent kinds', graph.schema === 'partmode.drawing-tables/v1'
  && graph.tables.length === 3 && JSON.stringify(graph.tables.map((entry: JsonRecord) => entry.kind)) === JSON.stringify(['cut-list', 'hole', 'revision']));
const canonical = JSON.stringify(projectModule.prepareStudioV5Project(project));
project = projectModule.parseStudioV5Project(canonical);
check('drawing tables changed across canonical save/reopen', JSON.stringify(project) === canonical);

expectCode('missing cut-list body', () => drawingTables.createStudioDrawingTable(project, {
  kind: 'cut-list', sheetId: 'sheet-000001', name: 'Missing body', positionMm: [10, 10], widthMm: 100, sourceType: 'body-axis', axis: 'x', sourceBodyIds: ['body-missing'],
}), 'DRAWING_TABLE_REFERENCE_MISSING');
expectCode('non-Hole-Wizard feature', () => drawingTables.createStudioDrawingTable(project, {
  kind: 'hole', sheetId: 'sheet-000001', name: 'Missing hole', positionMm: [10, 10], widthMm: 100, sourceFeatureIds: ['feature-base-plate'],
}), 'DRAWING_TABLE_REFERENCE_MISSING');
expectCode('duplicate revision', () => drawingTables.createStudioDrawingTable(project, {
  kind: 'revision', sheetId: 'sheet-000001', name: 'Bad revisions', positionMm: [10, 10], widthMm: 100,
  entries: [
    { revision: 'A', description: 'One', date: '2026-08-02', approvedBy: 'QA' },
    { revision: 'a', description: 'Two', date: '2026-08-03', approvedBy: 'QA' },
  ],
}), 'DRAWING_TABLE_INPUT_INVALID');

const book = drawingBook.inspectStudioDrawingBook(project);
let kernel: HeadlessKernel | null = null;
let firstDrawing: JsonRecord;
let tallerDrawing: JsonRecord;
let tallerProject: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  firstDrawing = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-tables-20', projectId: project.projectId, revision: 1,
    document: project, views: ['front', 'top', 'right', 'iso'],
  }, 180_000) as JsonRecord;
  check(`20 mm exact drawing failed: ${JSON.stringify(firstDrawing.errors || [])}`, firstDrawing.kind === 'drawing-result'
    && firstDrawing.errors?.length === 0 && firstDrawing.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact'
    && firstDrawing.bodies?.length === 1 && firstDrawing.bodies[0].geometry?.brepValid === true);
  tallerProject = transact(project, 'increase-cut-length', [
    { kind: 'feature.update', input: { featureId: 'feature-base-plate', patch: { h: 30 } } },
    { kind: 'feature.update', input: { featureId: 'feature-table-hole', patch: { sketch: { ...hole.sketch, z: 30 } } } },
  ]);
  tallerDrawing = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-tables-30', projectId: tallerProject.projectId, revision: 2,
    document: tallerProject, views: ['front', 'top', 'right', 'iso'],
  }, 180_000) as JsonRecord;
  check(`30 mm exact drawing failed: ${JSON.stringify(tallerDrawing.errors || [])}`, tallerDrawing.kind === 'drawing-result'
    && tallerDrawing.errors?.length === 0 && tallerDrawing.bodies?.[0]?.geometry?.brepValid === true);
} finally {
  await kernel?.dispose();
}

const first = drawingPdf.createStudioDrawingBookPdf(firstDrawing!, project.name, book, null, null, project.extensions.drawingTables, project);
const repeated = drawingPdf.createStudioDrawingBookPdf(firstDrawing!, project.name, book, null, null, project.extensions.drawingTables, project);
const taller = drawingPdf.createStudioDrawingBookPdf(tallerDrawing!, tallerProject!.name, book, null, null, tallerProject!.extensions.drawingTables, tallerProject!);
check('drawing-table PDF is not deterministic', Buffer.compare(Buffer.from(first.bytes), Buffer.from(repeated.bytes)) === 0);
check('drawing-table PDF did not change after exact body length changed', Buffer.compare(Buffer.from(first.bytes), Buffer.from(taller.bytes)) !== 0);
const pageTables = first.manifest.pages[0].drawingTables;
const tallerTables = taller.manifest.pages[0].drawingTables;
check('resolved drawing-table manifest is incomplete', pageTables.schema === 'partmode.drawing-sheet-tables/v1'
  && pageTables.tables.length === 3 && pageTables.tables.every((entry: JsonRecord) => entry.rows.length > 0));
const cut = pageTables.tables.find((entry: JsonRecord) => entry.kind === 'cut-list');
const tallerCut = tallerTables.tables.find((entry: JsonRecord) => entry.kind === 'cut-list');
check('cut-list length did not resolve from exact B-rep bounds', cut.evidence.kind === 'exact-brep-bounds'
  && cut.rows[0].at(-1) === 20 && tallerCut.rows[0].at(-1) === 30);
const holes = pageTables.tables.find((entry: JsonRecord) => entry.kind === 'hole');
check('hole table did not resolve the persistent Hole Wizard recipe', holes.evidence.kind === 'hole-wizard-exact-document'
  && holes.rows[0][1] === 6 && holes.rows[0][2] === -4 && holes.rows[0][3].includes('CBORE 10 x 6 mm'));
const revisions = pageTables.tables.find((entry: JsonRecord) => entry.kind === 'revision');
check('revision table did not preserve controlled rows', revisions.evidence.kind === 'controlled-document-records'
  && revisions.rows.length === 2 && revisions.rows[1][0] === 'B');
expectCode('stale exact document revision', () => drawingPdf.createStudioDrawingBookPdf(
  firstDrawing, tallerProject!.name, book, null, null, tallerProject!.extensions.drawingTables, tallerProject!,
), 'DRAWING_TABLE_REFERENCE_STALE');
const pdfText = Buffer.from(first.bytes).toString('latin1');
check('PDF omitted one or more authored table types', pdfText.includes('(Exact cut list)') && pdfText.includes('(Hole schedule)')
  && pdfText.includes('(Revision history)') && pdfText.includes('(CBORE 10 x 6 mm'));
expectCode('stale exact cut-list evidence', () => drawingPdf.createStudioDrawingBookPdf(
  { ...firstDrawing, bodies: [] }, project.name, book, null, null, project.extensions.drawingTables, project,
), 'DRAWING_TABLE_REFERENCE_STALE');
const suppressedHoleProject = transact(project, 'suppress-table-source-hole', [{
  kind: 'feature.suppress', input: { featureId: 'feature-table-hole', suppressed: true },
}]);
expectCode('suppressed Hole Wizard reference', () => drawingPdf.createStudioDrawingBookPdf(
  firstDrawing, suppressedHoleProject.name, book, null, null, suppressedHoleProject.extensions.drawingTables, suppressedHoleProject,
), 'DRAWING_TABLE_REFERENCE_MISSING');

const cleaned = drawingBook.initializeStudioDrawingBook(plateDocument('project-table-delete'), { templateId: 'iso-a3-landscape' });
let twoSheets = drawingBook.createStudioDrawingSheet(cleaned, { name: 'Second', templateId: 'iso-a4-landscape', views: ['front'] });
twoSheets = drawingTables.createStudioDrawingTable(twoSheets, {
  kind: 'revision', sheetId: 'sheet-000002', name: 'Delete with sheet', positionMm: [10, 10], widthMm: 100,
  entries: [{ revision: 'A', description: 'Test', date: '2026-08-02', approvedBy: 'QA' }],
});
const deletedSheet = drawingBook.deleteStudioDrawingSheet(twoSheets, 'sheet-000002');
check('deleting a drawing sheet did not clean its tables', drawingTables.inspectStudioDrawingTables(deletedSheet).tables.length === 0);

const [pageSource, studioSource, agentSource, registrySource, pdfSource, workerSource, buildSource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-drawing-pdf.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8'),
  readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
]);
check('visible table manager is incomplete', ['bw-drawing-table-kind', 'bw-drawing-table-references', 'bw-drawing-table-revisions', 'bw-drawing-table-add', 'bw-drawing-table-update', 'bw-drawing-table-delete']
  .every((id) => pageSource.includes(`id="${id}"`)));
check('visible table manager does not route typed operations', studioSource.includes("kind: 'drawing.table.create'")
  && studioSource.includes("kind: 'drawing.table.update'") && studioSource.includes("kind: 'drawing.table.delete'"));
check('typed agent omits drawing-table operations', agentSource.includes("'drawing.table.create'")
  && agentSource.includes("'drawing.table.update'") && agentSource.includes("'drawing.table.delete'")
  && agentSource.includes("['drawing-table', table.id, table]"));
check('typed UI registry omits drawing-table controls', registrySource.includes("'dialog.drawing-table.add'")
  && registrySource.includes("'dialog.drawing-table.update'") && registrySource.includes("'dialog.drawing-table.delete'"));
check('PDF renderer omits resolved drawing tables', pdfSource.includes('resolveStudioDrawingSheetTables') && pdfSource.includes('layout.drawingTables.tables'));
check('drawing worker does not publish exact body evidence', workerSource.includes('exactBodyEvidence') && workerSource.includes('geometry: structuredClone(result.geometry)'));
check('drawing-table module is not release packaged', buildSource.includes("'studio-drawing-tables.js'"));

console.log(JSON.stringify({
  schema: graph.schema,
  tables: pageTables.tables.map((entry: JsonRecord) => ({ kind: entry.kind, rows: entry.rows.length, evidence: entry.evidence.kind })),
  associativeCutLengthMm: [cut.rows[0].at(-1), tallerCut.rows[0].at(-1)],
  holeCallout: holes.rows[0][3],
  revisions: revisions.evidence.revisions,
  exactDrawings: 2,
  deterministicPdfBytes: first.bytes.length,
  saveReopen: 'preserved',
  typedLifecycle: ['create', 'update', 'delete'],
  failClosed: ['missing-body', 'non-hole-feature', 'duplicate-revision', 'stale-exact-body-evidence', 'suppressed-hole', 'stale-document-revision'],
}, null, 2));
