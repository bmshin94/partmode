import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Drawing book smoke failed: ${label}`);
}

function expectCode(label: string, fn: () => unknown, code: string): void {
  try { fn(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Drawing book smoke failed: ${label} did not fail`);
}

function validateMultiPagePdf(bytes: Uint8Array): { objects: number; pageCount: number; mediaBoxes: number[][] } {
  const text = Buffer.from(bytes).toString('latin1');
  check('multi-page PDF header/trailer is invalid', text.startsWith('%PDF-1.7\n%') && text.endsWith('%%EOF\n'));
  check('multi-page PDF page tree is invalid', text.includes('/Kids [4 0 R 6 0 R 8 0 R] /Count 3'));
  const start = text.match(/startxref\n(\d+)\n%%EOF\n$/u);
  check('multi-page PDF startxref is missing', start);
  const xrefOffset = Number(start[1]!);
  check('multi-page PDF xref size is wrong', text.slice(xrefOffset).startsWith('xref\n0 11\n'));
  const lines = text.slice(xrefOffset).split('\n');
  for (let object = 1; object <= 10; object++) {
    const offset = Number(lines[2 + object]!.slice(0, 10));
    check(`multi-page PDF xref object ${object} is wrong`, text.slice(offset).startsWith(`${object} 0 obj\n`));
  }
  for (const streamId of [5, 7, 9]) {
    const match = text.match(new RegExp(`${streamId} 0 obj\\n<< \\/Length (\\d+) >>\\nstream\\n`, 'u'));
    check(`multi-page PDF stream ${streamId} is missing`, match);
    const streamStart = match.index! + match[0].length;
    check(`multi-page PDF stream ${streamId} length is wrong`, text.indexOf('endstream', streamStart) - streamStart === Number(match[1]));
  }
  const mediaBoxes: Array<[number, number]> = [...text.matchAll(/\/MediaBox \[0 0 ([0-9.]+) ([0-9.]+)\]/gu)]
    .map((match) => [Number(match[1]), Number(match[2])]);
  check('multi-page PDF media boxes are missing', mediaBoxes.length === 3);
  const expected: Array<[number, number]> = ([[500, 300], [297, 210], [420, 297]] as Array<[number, number]>)
    .map(([width, height]) => [width * 72 / 25.4, height * 72 / 25.4]);
  check('multi-page PDF custom/template media boxes are wrong', mediaBoxes.every((box, index) =>
    Math.abs(box[0] - expected[index]![0]) < 0.001 && Math.abs(box[1] - expected[index]![1]) < 0.001));
  return { objects: 10, pageCount: 3, mediaBoxes };
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const [runtime, agent, drawingBook, drawingPdf] = await Promise.all([
  moduleAt('src/static/studio-v5-runtime-document.js'),
  moduleAt('src/static/studio-agent-service.js'),
  moduleAt('src/static/studio-drawing-book.js'),
  moduleAt('src/static/studio-drawing-pdf.js'),
]);
const source = runtime.canonicalStudioV5Project(JSON.parse(await readFile(resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'), 'utf8')));
const originalJson = JSON.stringify(source);
const transact = (project: JsonRecord, id: string, operations: JsonRecord[]) => agent.applyCadTransaction(project, {
  transactionId: id, label: id, expectedRevision: 0, atomic: true, operations,
});

let transaction = transact(source, 'drawing-book-initialize', [{
  kind: 'drawing.book.initialize', input: { title: 'Assembly release drawing set', templateId: 'iso-a4-landscape', name: 'General arrangement', scale: 'fit', views: ['front', 'top', 'right', 'iso'] },
}]);
check('drawing-book initialization mutated its source', JSON.stringify(source) === originalJson);
check('typed initialization did not create a drawing-sheet entity', transaction.changeSet.created.some((entry: JsonRecord) => entry.kind === 'drawing-sheet' && entry.id === 'sheet-000001'));
let project = transaction.project;
transaction = transact(project, 'drawing-book-add-sheets', [
  { kind: 'drawing.sheet.create', input: { name: 'Interface detail', templateId: 'iso-a3-landscape', scale: 1, views: ['front', 'right', 'iso'], activate: true } },
  { kind: 'drawing.sheet.create', input: { name: 'Custom overview', widthMm: 500, heightMm: 300, formatName: 'Shop landscape', standard: 'Shop', size: '500x300', projection: 'third-angle', titleBlock: 'shop-default', scale: 0.5, views: ['top'], activate: true } },
]);
project = transaction.project;
check('typed sheet creation did not expose both sheets', transaction.changeSet.created.filter((entry: JsonRecord) => entry.kind === 'drawing-sheet').length === 2);
project = transact(project, 'drawing-book-reorder', [{
  kind: 'drawing.sheet.reorder', input: { orderedSheetIds: ['sheet-000003', 'sheet-000001', 'sheet-000002'] },
}, {
  kind: 'drawing.sheet.activate', input: { sheetId: 'sheet-000001' },
}, {
  kind: 'drawing.sheet.update', input: { sheetId: 'sheet-000002', patch: { description: 'Exact interface dimensions', views: ['right', 'iso', 'front'] } },
}]).project;
let book = drawingBook.inspectStudioDrawingBook(project);
check('drawing-book graph is wrong', book.schema === 'partmode.drawing-book/v1' && book.sheets.length === 3
  && book.activeSheetId === 'sheet-000001'
  && JSON.stringify(book.sheets.map((entry: JsonRecord) => entry.id)) === JSON.stringify(['sheet-000003', 'sheet-000001', 'sheet-000002']));
check('sheet templates/custom formats are wrong', book.sheets[0].format.kind === 'custom' && book.sheets[0].format.widthMm === 500 && book.sheets[0].format.heightMm === 300
  && book.sheets[1].format.templateId === 'iso-a4-landscape' && book.sheets[2].format.templateId === 'iso-a3-landscape');
check('per-sheet scales or view sets are wrong', book.sheets[0].scale === 0.5 && book.sheets[1].scale === 'fit' && book.sheets[2].scale === 1
  && JSON.stringify(book.sheets[2].views) === JSON.stringify(['right', 'iso', 'front']));

const reopened = runtime.canonicalStudioV5Project(JSON.parse(JSON.stringify(project)));
check('drawing book changed after canonical save/reopen', JSON.stringify(reopened) === JSON.stringify(project));
const reopenedJson = JSON.stringify(reopened);
const direct = drawingBook.updateStudioDrawingSheet(reopened, { sheetId: 'sheet-000003', patch: { name: 'Custom shop overview' } });
check('direct drawing-sheet update mutated its source', JSON.stringify(reopened) === reopenedJson);
check('direct drawing-sheet update did not return a clone', drawingBook.inspectStudioDrawingBook(direct).sheets[0].name === 'Custom shop overview');

expectCode('duplicate sheet name', () => drawingBook.updateStudioDrawingSheet(project, { sheetId: 'sheet-000002', patch: { name: 'General arrangement' } }), 'DRAWING_BOOK_INVALID');
expectCode('invalid custom size', () => drawingBook.createStudioDrawingSheet(project, { name: 'Invalid custom', widthMm: 99, heightMm: 300, views: ['front'] }), 'DRAWING_BOOK_INPUT_INVALID');
expectCode('unknown template', () => drawingBook.createStudioDrawingSheet(project, { name: 'Invalid template', templateId: 'missing-template', views: ['front'] }), 'DRAWING_TEMPLATE_NOT_FOUND');
expectCode('incomplete reorder', () => drawingBook.reorderStudioDrawingSheets(project, ['sheet-000001']), 'DRAWING_BOOK_INPUT_INVALID');
const single = drawingBook.initializeStudioDrawingBook(source, { templateId: 'iso-a4-landscape' });
expectCode('delete only sheet', () => drawingBook.deleteStudioDrawingSheet(single, 'sheet-000001'), 'DRAWING_SHEET_REQUIRED');

const requiredViews = drawingBook.requiredStudioDrawingBookViews(project);
check('drawing-book view union is wrong', JSON.stringify(requiredViews) === JSON.stringify(['top', 'front', 'right', 'iso']));
let kernel: HeadlessKernel | null = null;
let exactDrawing: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  exactDrawing = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-book-exact', projectId: project.projectId,
    revision: 1, document: project, views: requiredViews,
  }) as JsonRecord;
} finally { await kernel?.dispose(); }
check(`drawing-book exact HLR failed ${JSON.stringify(exactDrawing.errors || [])}`,
  exactDrawing.kind === 'drawing-result' && exactDrawing.errors?.length === 0
  && JSON.stringify(exactDrawing.views.map((entry: JsonRecord) => entry.view)) === JSON.stringify(requiredViews)
  && exactDrawing.manifest.exactProjectionEvidence?.kind === 'occt-hlr-exact');

const firstPdf = drawingPdf.createStudioDrawingBookPdf(exactDrawing, project.name, book);
const secondPdf = drawingPdf.createStudioDrawingBookPdf(exactDrawing, project.name, book);
check('multi-page drawing PDF is not deterministic', Buffer.compare(Buffer.from(firstPdf.bytes), Buffer.from(secondPdf.bytes)) === 0);
check('multi-page manifest is wrong', firstPdf.mediaType === 'application/pdf' && firstPdf.manifest.pageCount === 3
  && JSON.stringify(firstPdf.manifest.pages.map((entry: JsonRecord) => entry.sheetId)) === JSON.stringify(['sheet-000003', 'sheet-000001', 'sheet-000002'])
  && JSON.stringify(firstPdf.manifest.pages.map((entry: JsonRecord) => entry.scaleLabel)) === JSON.stringify(['1:2', '2:1', '1:1'])
  && firstPdf.manifest.exactProjectionEvidence?.kind === 'occt-hlr-exact');
const pdfStructure = validateMultiPagePdf(firstPdf.bytes);
expectCode('missing requested exact view', () => drawingPdf.createStudioDrawingBookPdf({ ...exactDrawing, views: exactDrawing.views.filter((entry: JsonRecord) => entry.view !== 'top') }, project.name, book), 'DRAWING_BOOK_VIEW_MISSING');

const [pageSource, studioSource, registrySource, agentSource, buildSource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
]);
check('visible drawing-book manager is missing', pageSource.includes('id="bw-drawing-book-initialize"')
  && pageSource.includes('id="bw-drawing-sheet-template"') && pageSource.includes('id="bw-drawing-sheet-views"')
  && pageSource.includes('id="bw-drawing-sheet-add"') && pageSource.includes('id="bw-drawing-sheet-apply"'));
check('visible drawing-book manager does not route typed operations', studioSource.includes("kind: 'drawing.book.initialize'")
  && studioSource.includes("kind: 'drawing.sheet.create'") && studioSource.includes("kind: 'drawing.sheet.update'")
  && studioSource.includes("kind: 'drawing.sheet.reorder'") && studioSource.includes('createStudioDrawingBookPdf'));
check('typed UI registry omits drawing-book controls', registrySource.includes("'dialog.drawing-book.initialize'")
  && registrySource.includes("'dialog.drawing-sheet.template'") && registrySource.includes("'dialog.drawing-sheet.apply'"));
check('typed agent schema omits drawing-book operations', agentSource.includes("'drawing.book.initialize'")
  && agentSource.includes("'drawing.sheet.create'") && agentSource.includes("'drawing.sheet.reorder'"));
check('drawing-book runtime is not release packaged', buildSource.includes("'studio-drawing-book.js'"));

console.log(JSON.stringify({
  schema: book.schema,
  templates: drawingBook.STUDIO_DRAWING_SHEET_TEMPLATES.map((entry: JsonRecord) => entry.id),
  sheets: book.sheets.map((entry: JsonRecord) => ({ id: entry.id, name: entry.name, format: entry.format.name, size: [entry.format.widthMm, entry.format.heightMm], scale: entry.scale, views: entry.views })),
  exactViews: requiredViews,
  exactEvidence: exactDrawing.manifest.exactProjectionEvidence.kind,
  pdf: { bytes: firstPdf.bytes.length, deterministic: true, ...pdfStructure },
  saveReopen: 'preserved',
  failClosed: ['duplicate-name', 'invalid-custom-size', 'unknown-template', 'incomplete-reorder', 'delete-only-sheet', 'missing-exact-view'],
}, null, 2));

process.exit(0);
