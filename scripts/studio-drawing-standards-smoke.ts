import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Drawing standards smoke failed: ${label}`);
}

function expectCode(label: string, fn: () => unknown, code: string): void {
  try { fn(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Drawing standards smoke failed: ${label} did not fail`);
}

function pageStreams(bytes: Uint8Array): string[] {
  return [...Buffer.from(bytes).toString('latin1').matchAll(/stream\n([\s\S]*?)endstream/gu)].map((match) => match[1]!);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const [runtime, agent, bookTools, standardTools, pdfTools] = await Promise.all([
  moduleAt('src/static/studio-v5-runtime-document.js'),
  moduleAt('src/static/studio-agent-service.js'),
  moduleAt('src/static/studio-drawing-book.js'),
  moduleAt('src/static/studio-drawing-standards.js'),
  moduleAt('src/static/studio-drawing-pdf.js'),
]);
const source = runtime.canonicalStudioV5Project(JSON.parse(await readFile(resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'), 'utf8')));
const originalJson = JSON.stringify(source);
const transact = (project: JsonRecord, id: string, operations: JsonRecord[]) => agent.applyCadTransaction(project, {
  transactionId: id, label: id, expectedRevision: 0, atomic: true, operations,
}, 0);

let transaction = transact(source, 'drawing-standard-book', [{
  kind: 'drawing.book.initialize', input: { title: 'Controlled standards set', name: 'ISO control', templateId: 'iso-a4-landscape', views: ['front'], tangentEdges: 'visible' },
}, {
  kind: 'drawing.sheet.create', input: { name: 'ANSI control', templateId: 'ansi-a-landscape', views: ['front'], tangentEdges: 'visible' },
}, {
  kind: 'drawing.sheet.create', input: { name: 'DIN control', templateId: 'din-a4-landscape', views: ['front'], tangentEdges: 'visible' },
}]);
check('drawing-standard setup mutated its source', JSON.stringify(source) === originalJson);
let project = transaction.project;
transaction = transact(project, 'drawing-standard-profiles', [
  { kind: 'drawing.standard.apply', input: { sheetId: 'sheet-000001', profileId: 'iso' } },
  { kind: 'drawing.standard.apply', input: { sheetId: 'sheet-000002', profileId: 'ansi' } },
  { kind: 'drawing.standard.apply', input: { sheetId: 'sheet-000003', profileId: 'din' } },
]);
project = transaction.project;
check('typed standard profile operations did not expose layer entities', transaction.changeSet.created.filter((entry: JsonRecord) => entry.kind === 'drawing-layer').length === 21);
transaction = transact(project, 'drawing-standard-custom-font', [{
  kind: 'drawing.lineFont.create', input: { name: 'Inspection red', widthMm: 0.7, dashMm: [4, 1], color: [0.8, 0.1, 0.2] },
}]);
project = transaction.project;
check('typed custom line font did not expose an entity', transaction.changeSet.created.some((entry: JsonRecord) => entry.kind === 'drawing-line-font' && entry.id === 'line-font-000001'));
project = transact(project, 'drawing-standard-layer-control', [
  { kind: 'drawing.layer.update', input: { sheetId: 'sheet-000001', layerId: 'hidden', patch: { visible: false } } },
  { kind: 'drawing.layer.update', input: { sheetId: 'sheet-000002', layerId: 'visible', patch: { lineFontId: 'line-font-000001' } } },
  { kind: 'drawing.layer.update', input: { sheetId: 'sheet-000003', layerId: 'tables', patch: { printable: false } } },
]).project;

const book = bookTools.inspectStudioDrawingBook(project);
const graph = standardTools.inspectStudioDrawingStandards(project);
check('drawing standards graph is wrong', graph.schema === 'partmode.drawing-standards/v1' && graph.sequence === 1
  && graph.lineFonts.length === 1 && graph.sheets.length === 3);
const styles = book.sheets.map((sheet: JsonRecord) => standardTools.resolveStudioDrawingSheetStyle(book, graph, sheet.id));
check('ISO, ANSI and DIN profiles did not resolve independently', JSON.stringify(styles.map((style: JsonRecord) => style.profile.id)) === JSON.stringify(['iso', 'ansi', 'din']));
check('layer visibility, custom font, or print state did not resolve', styles[0].layers.find((entry: JsonRecord) => entry.id === 'hidden').visible === false
  && styles[1].layers.find((entry: JsonRecord) => entry.id === 'visible').lineFont.id === 'line-font-000001'
  && styles[2].layers.find((entry: JsonRecord) => entry.id === 'tables').printable === false);
const reopened = runtime.canonicalStudioV5Project(JSON.parse(JSON.stringify(project)));
check('drawing standards changed after canonical save/reopen', JSON.stringify(reopened) === JSON.stringify(project));

expectCode('unknown drawing profile', () => standardTools.applyStudioDrawingStandardProfile(project, { sheetId: 'sheet-000001', profileId: 'jis' }), 'DRAWING_STANDARD_PROFILE_NOT_FOUND');
expectCode('duplicate line-font name', () => standardTools.createStudioDrawingLineFont(project, { name: 'inspection red', widthMm: 0.2, dashMm: [], color: [0, 0, 0] }), 'DRAWING_LINE_FONT_EXISTS');
expectCode('unsafe line-font width', () => standardTools.createStudioDrawingLineFont(project, { name: 'Unsafe width', widthMm: 4, dashMm: [], color: [0, 0, 0] }), 'DRAWING_STANDARD_INPUT_INVALID');
expectCode('odd dash pattern', () => standardTools.createStudioDrawingLineFont(project, { name: 'Odd dash', widthMm: 0.2, dashMm: [2], color: [0, 0, 0] }), 'DRAWING_STANDARD_INPUT_INVALID');
expectCode('unsafe line-font color', () => standardTools.createStudioDrawingLineFont(project, { name: 'Unsafe color', widthMm: 0.2, dashMm: [], color: [1.2, 0, 0] }), 'DRAWING_STANDARD_INPUT_INVALID');
expectCode('unknown layer line font', () => standardTools.updateStudioDrawingLayer(project, { sheetId: 'sheet-000001', layerId: 'visible', patch: { lineFontId: 'line-font-999999' } }), 'DRAWING_LINE_FONT_NOT_FOUND');
expectCode('delete assigned line font', () => standardTools.deleteStudioDrawingLineFont(project, 'line-font-000001'), 'DRAWING_LINE_FONT_IN_USE');

let kernel: HeadlessKernel | null = null;
let exact: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  exact = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-standards-exact', projectId: project.projectId,
    revision: 1, document: project, views: ['front'],
  }) as JsonRecord;
} finally { await kernel?.dispose(); }
check(`drawing standards exact HLR failed ${JSON.stringify(exact.errors || [])}`, exact.kind === 'drawing-result'
  && exact.errors?.length === 0 && exact.views?.length === 1 && exact.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');
check('exact fixture has no hidden paths for layer evidence', exact.views[0].hidden.length > 0);

const defaults = pdfTools.createStudioDrawingBookPdf(exact, project.name, book);
const first = pdfTools.createStudioDrawingBookPdf(exact, project.name, book, graph);
const second = pdfTools.createStudioDrawingBookPdf(exact, project.name, book, graph);
check('standards drawing PDF is not byte deterministic', Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes)) === 0);
check('standards drawing manifest is wrong', first.manifest.pageCount === 3
  && JSON.stringify(first.manifest.pages.map((page: JsonRecord) => page.drawingStyle.profile.id)) === JSON.stringify(['iso', 'ansi', 'din'])
  && first.manifest.pages.every((page: JsonRecord) => page.drawingStyle.layers.length === 7));
const defaultStreams = pageStreams(defaults.bytes);
const styledStreams = pageStreams(first.bytes);
check('multi-page standards content streams are missing', defaultStreams.length === 3 && styledStreams.length === 3);
const strokes = (value: string) => (value.match(/(?:^|\n)S\n/gu) || []).length;
check('hidden layer visibility did not remove exact HLR strokes', strokes(styledStreams[0]!) < strokes(defaultStreams[0]!));
check('custom ANSI line font did not reach exact PDF commands', styledStreams[1]!.includes('0.8 0.1 0.2 RG 1.984 w [11.339 2.835] 0 d'));
check('DIN line font did not reach exact PDF commands', styledStreams[2]!.includes('0.06 0.09 0.12 RG 1.417 w [] 0 d'));
check('ISO hidden line font leaked through disabled layer', !styledStreams[0]!.includes('0.511 w [5.102 3.402] 0 d'));

const edited = standardTools.updateStudioDrawingLineFont(project, { lineFontId: 'line-font-000001', patch: { widthMm: 0.65, dashMm: [5, 2], color: [0.7, 0.05, 0.1] } });
const editedPdf = pdfTools.createStudioDrawingBookPdf(exact, edited.name, bookTools.inspectStudioDrawingBook(edited), standardTools.inspectStudioDrawingStandards(edited));
check('line-font edit did not change deterministic drawing bytes', Buffer.compare(Buffer.from(first.bytes), Buffer.from(editedPdf.bytes)) !== 0
  && pageStreams(editedPdf.bytes)[1]!.includes('0.7 0.05 0.1 RG 1.843 w [14.173 5.669] 0 d'));

const deletedSheet = bookTools.deleteStudioDrawingSheet(project, 'sheet-000003');
check('sheet deletion left an orphan drawing-layer state', standardTools.inspectStudioDrawingStandards(deletedSheet).sheets.length === 2);

const [pageSource, studioSource, registrySource, agentSource, pdfSource, buildSource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'), readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'), readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-drawing-pdf.js'), 'utf8'), readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
]);
check('visible drawing standards controls are missing', ['bw-drawing-standard-profile', 'bw-drawing-standard-apply', 'bw-drawing-layer',
  'bw-drawing-layer-visible', 'bw-drawing-layer-printable', 'bw-drawing-layer-line-font', 'bw-drawing-layer-apply',
  'bw-drawing-line-font-add', 'bw-drawing-line-font-update', 'bw-drawing-line-font-delete'].every((id) => pageSource.includes(`id="${id}"`))
  && pageSource.includes('din-a4-landscape'));
check('production drawing standards routing is missing', studioSource.includes("kind: 'drawing.standard.apply'")
  && studioSource.includes("kind: 'drawing.layer.update'") && studioSource.includes('doc.extensions?.drawingStandards'));
check('typed drawing standards surfaces are missing', agentSource.includes("'drawing.lineFont.create'")
  && agentSource.includes("'drawing.layer.update'") && registrySource.includes("'dialog.drawing-standard.apply'")
  && registrySource.includes("'dialog.drawing-line-font.add'"));
check('exact PDF layer styling is missing', pdfSource.includes("stroke('hidden')") && pdfSource.includes("enabled('tables')")
  && pdfSource.includes('resolveStudioDrawingSheetStyle'));
check('drawing standards module is absent from release assets', buildSource.includes("'studio-drawing-standards.js'"));

console.log(JSON.stringify({
  schema: graph.schema, profiles: styles.map((style: JsonRecord) => style.profile.id), customLineFont: graph.lineFonts[0],
  exactEvidence: exact.manifest.exactProjectionEvidence.kind, exactHiddenPaths: exact.views[0].hidden.length,
  layersPerSheet: styles.map((style: JsonRecord) => style.layers.length),
  hiddenLayer: { defaultStrokes: strokes(defaultStreams[0]!), controlledStrokes: strokes(styledStreams[0]!) },
  pdf: { pages: first.manifest.pageCount, deterministic: true, customAnsiFont: true, dinProfile: true },
  saveReopen: 'preserved', controls: 15,
  failClosed: ['unknown-profile', 'duplicate-font', 'unsafe-width', 'odd-dash', 'unsafe-color', 'unknown-font', 'delete-in-use'],
}, null, 2));

process.exit(0);
