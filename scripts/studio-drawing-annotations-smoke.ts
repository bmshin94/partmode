import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Drawing annotations smoke failed: ${label}`);
}

function expectCode(label: string, fn: () => unknown, code: string): void {
  try { fn(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Drawing annotations smoke failed: ${label} did not fail`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const [runtime, agent, bookTools, annotationTools, standardTools, pdfTools] = await Promise.all([
  moduleAt('src/static/studio-v5-runtime-document.js'), moduleAt('src/static/studio-agent-service.js'),
  moduleAt('src/static/studio-drawing-book.js'), moduleAt('src/static/studio-drawing-annotations.js'),
  moduleAt('src/static/studio-drawing-standards.js'), moduleAt('src/static/studio-drawing-pdf.js'),
]);
const source = runtime.canonicalStudioV5Project(JSON.parse(await readFile(resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'), 'utf8')));
const originalJson = JSON.stringify(source);
const transact = (project: JsonRecord, id: string, operations: JsonRecord[]) => agent.applyCadTransaction(project, {
  transactionId: id, label: id, expectedRevision: 0, atomic: true, operations,
}, 0);

let transaction = transact(source, 'drawing-annotation-setup', [{
  kind: 'drawing.book.initialize', input: { title: 'Annotated release set', name: 'Release sheet', templateId: 'iso-a4-landscape', views: ['front'], tangentEdges: 'visible' },
}, {
  kind: 'drawing.block.create', input: { name: 'Inspection stamp', text: 'QA HOLD', widthMm: 36, heightMm: 12 },
}, {
  kind: 'drawing.annotation.create', input: { kind: 'note', sheetId: 'sheet-000001', text: 'RELEASE NOTE\nDEBURR ALL EDGES', positionMm: [18, 18], sizePt: 8 },
}, {
  kind: 'drawing.annotation.create', input: { kind: 'balloon', sheetId: 'sheet-000001', text: 'MANUAL-7', viewId: 'front', anchor: [0, 0], labelMm: [60, 40] },
}, {
  kind: 'drawing.annotation.create', input: { kind: 'revision-cloud', sheetId: 'sheet-000001', revision: 'B', boundsMm: [140, 30, 40, 20] },
}, {
  kind: 'drawing.annotation.create', input: { kind: 'block', sheetId: 'sheet-000001', blockId: 'drawing-block-000001', positionMm: [20, 170], scale: 1 },
}]);
check('drawing-annotation setup mutated its source', JSON.stringify(source) === originalJson);
check('typed annotation entities are incomplete', transaction.changeSet.created.filter((entry: JsonRecord) => entry.kind === 'drawing-annotation').length === 4
  && transaction.changeSet.created.some((entry: JsonRecord) => entry.kind === 'drawing-block' && entry.id === 'drawing-block-000001'));
let project = transaction.project;
let book = bookTools.inspectStudioDrawingBook(project);
let graph = annotationTools.inspectStudioDrawingAnnotations(project);
check('drawing-annotation graph is wrong', graph.schema === 'partmode.drawing-annotations/v1'
  && graph.annotationSequence === 4 && graph.blockSequence === 1 && graph.blocks.length === 1 && graph.annotations.length === 4
  && JSON.stringify(graph.annotations.map((entry: JsonRecord) => entry.kind)) === JSON.stringify(['note', 'balloon', 'revision-cloud', 'block']));
const resolved = annotationTools.resolveStudioDrawingSheetAnnotations(book, graph, 'sheet-000001');
check('reusable block did not resolve into its instance', resolved.annotations[3].block.id === 'drawing-block-000001' && resolved.annotations[3].block.text === 'QA HOLD');
const reopened = runtime.canonicalStudioV5Project(JSON.parse(JSON.stringify(project)));
check('drawing annotations changed after canonical save/reopen', JSON.stringify(reopened) === JSON.stringify(project));

expectCode('duplicate drawing block', () => annotationTools.createStudioDrawingBlock(project, { name: 'inspection stamp', text: 'OTHER', widthMm: 20, heightMm: 10 }), 'DRAWING_BLOCK_EXISTS');
expectCode('unsafe drawing block size', () => annotationTools.createStudioDrawingBlock(project, { name: 'Unsafe', text: 'BAD', widthMm: 2, heightMm: 10 }), 'DRAWING_ANNOTATION_INPUT_INVALID');
expectCode('delete used drawing block', () => annotationTools.deleteStudioDrawingBlock(project, 'drawing-block-000001'), 'DRAWING_BLOCK_IN_USE');
expectCode('missing drawing block', () => annotationTools.createStudioDrawingAnnotation(project, { kind: 'block', sheetId: 'sheet-000001', blockId: 'drawing-block-999999', positionMm: [10, 10], scale: 1 }), 'DRAWING_BLOCK_NOT_FOUND');
expectCode('balloon missing sheet view', () => annotationTools.createStudioDrawingAnnotation(project, { kind: 'balloon', sheetId: 'sheet-000001', text: 'X', viewId: 'right', anchor: [0, 0], labelMm: [40, 40] }), 'DRAWING_ANNOTATION_INPUT_INVALID');
expectCode('note outside sheet', () => annotationTools.createStudioDrawingAnnotation(project, { kind: 'note', sheetId: 'sheet-000001', text: 'OUTSIDE', positionMm: [400, 20], sizePt: 8 }), 'DRAWING_ANNOTATION_INPUT_INVALID');
expectCode('cloud outside sheet', () => annotationTools.createStudioDrawingAnnotation(project, { kind: 'revision-cloud', sheetId: 'sheet-000001', revision: 'C', boundsMm: [280, 10, 40, 20] }), 'DRAWING_ANNOTATION_INPUT_INVALID');
expectCode('annotation kind edit', () => annotationTools.updateStudioDrawingAnnotation(project, { annotationId: 'annotation-000001', patch: { kind: 'balloon' } }), 'DRAWING_ANNOTATION_INPUT_INVALID');

let kernel: HeadlessKernel | null = null;
let exact: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  exact = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-annotations-exact', projectId: project.projectId,
    revision: 1, document: project, views: ['front'],
  }) as JsonRecord;
} finally { await kernel?.dispose(); }
check(`drawing-annotation exact HLR failed ${JSON.stringify(exact.errors || [])}`, exact.kind === 'drawing-result'
  && exact.errors?.length === 0 && exact.views?.length === 1 && exact.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');
const automaticBalloons = exact.manifest?.annotations?.balloons || [];
check('existing automatic balloons lost exact evidence', automaticBalloons.length === 2
  && automaticBalloons.every((entry: JsonRecord) => entry.evidence?.kind === 'occt-brep-camera-support'
    && entry.evidence.assemblyProjectionKind === 'occt-hlr-exact'
    && entry.evidence.revisionKey === exact.manifest.drawingPlan.revisionKey
    && typeof entry.evidence.supportFingerprint === 'string' && entry.evidence.supportFingerprint.length === 32));

const first = pdfTools.createStudioDrawingBookPdf(exact, project.name, book, null, graph);
const second = pdfTools.createStudioDrawingBookPdf(exact, project.name, book, null, graph);
check('annotated drawing PDF is not byte deterministic', Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes)) === 0);
check('authored annotation manifest is wrong', first.manifest.pages[0].drawingAnnotations.schema === 'partmode.drawing-sheet-annotations/v1'
  && first.manifest.pages[0].drawingAnnotations.annotations.length === 4
  && first.manifest.exactProjectionEvidence?.kind === 'occt-hlr-exact');
const pdfText = Buffer.from(first.bytes).toString('latin1');
check('note, revision cloud, manual balloon, or reusable block did not render', pdfText.includes('(RELEASE NOTE)')
  && pdfText.includes('(DEBURR ALL EDGES)') && pdfText.includes('(REV B)') && pdfText.includes('(QA HOLD)') && pdfText.includes('(MANUAL-7)'));
check('revision cloud has no scalloped vector geometry', (pdfText.match(/ c h S/gu) || []).length >= 16);

project = transact(project, 'drawing-annotation-edit', [{
  kind: 'drawing.annotation.update', input: { annotationId: 'annotation-000001', patch: { text: 'RELEASE APPROVED', positionMm: [22, 24], sizePt: 9 } },
}, {
  kind: 'drawing.block.update', input: { blockId: 'drawing-block-000001', patch: { text: 'QA ACCEPTED' } },
}]).project;
book = bookTools.inspectStudioDrawingBook(project);
graph = annotationTools.inspectStudioDrawingAnnotations(project);
const editedPdf = pdfTools.createStudioDrawingBookPdf(exact, project.name, book, null, graph);
const editedText = Buffer.from(editedPdf.bytes).toString('latin1');
check('annotation or block edit did not change exact PDF bytes', Buffer.compare(Buffer.from(first.bytes), Buffer.from(editedPdf.bytes)) !== 0
  && editedText.includes('(RELEASE APPROVED)') && editedText.includes('(QA ACCEPTED)') && !editedText.includes('(QA HOLD)'));

project = transact(project, 'drawing-annotation-layer-off', [{ kind: 'drawing.standard.apply', input: { sheetId: 'sheet-000001', profileId: 'iso' } }, {
  kind: 'drawing.layer.update', input: { sheetId: 'sheet-000001', layerId: 'annotations', patch: { visible: false } },
}]).project;
const hiddenPdf = pdfTools.createStudioDrawingBookPdf(exact, project.name, bookTools.inspectStudioDrawingBook(project), standardTools.inspectStudioDrawingStandards(project), annotationTools.inspectStudioDrawingAnnotations(project));
const hiddenText = Buffer.from(hiddenPdf.bytes).toString('latin1');
check(`annotation layer visibility did not suppress authored annotation output ${JSON.stringify({
  note: hiddenText.includes('(RELEASE APPROVED)'), block: hiddenText.includes('(QA ACCEPTED)'),
  revision: hiddenText.includes('(REV B)'), balloon: hiddenText.includes('(MANUAL-7)'),
})}`, !hiddenText.includes('(RELEASE APPROVED)')
  && !hiddenText.includes('(QA ACCEPTED)') && !hiddenText.includes('(REV B)') && !hiddenText.includes('(MANUAL-7)'));

project = transact(project, 'drawing-annotation-second-sheet', [{
  kind: 'drawing.sheet.create', input: { name: 'Temporary notes', templateId: 'iso-a4-landscape', views: ['front'] },
}, {
  kind: 'drawing.annotation.create', input: { kind: 'note', sheetId: 'sheet-000002', text: 'TEMP', positionMm: [10, 10], sizePt: 8 },
}]).project;
const deletedSheet = bookTools.deleteStudioDrawingSheet(project, 'sheet-000002');
check('sheet deletion left an orphan authored annotation', annotationTools.inspectStudioDrawingAnnotations(deletedSheet).annotations.length === 4);

const [pageSource, studioSource, registrySource, agentSource, pdfSource, buildSource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'), readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'), readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-drawing-pdf.js'), 'utf8'), readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
]);
check('visible drawing annotation controls are missing', ['bw-drawing-annotation', 'bw-drawing-annotation-kind', 'bw-drawing-annotation-text',
  'bw-drawing-annotation-position', 'bw-drawing-annotation-view', 'bw-drawing-annotation-anchor', 'bw-drawing-annotation-extent',
  'bw-drawing-annotation-block', 'bw-drawing-annotation-add', 'bw-drawing-annotation-update', 'bw-drawing-annotation-delete',
  'bw-drawing-block', 'bw-drawing-block-add', 'bw-drawing-block-update', 'bw-drawing-block-delete'].every((id) => pageSource.includes(`id="${id}"`)));
check('production drawing annotation routing is missing', studioSource.includes("kind: 'drawing.annotation.create'")
  && studioSource.includes("kind: 'drawing.block.create'") && studioSource.includes('doc.extensions?.drawingAnnotations'));
check('typed drawing annotation surfaces are missing', agentSource.includes("'drawing.annotation.update'")
  && agentSource.includes("['drawing-annotation', annotation.id, annotation]") && registrySource.includes("'dialog.drawing-annotation.add'")
  && registrySource.includes("'dialog.drawing-block.add'"));
check('exact PDF annotation rendering is missing', pdfSource.includes("annotation.kind === 'revision-cloud'")
  && pdfSource.includes("annotation.kind === 'balloon'") && pdfSource.includes('annotation.block.text'));
check('drawing annotations module is absent from release assets', buildSource.includes("'studio-drawing-annotations.js'"));

console.log(JSON.stringify({
  schema: graph.schema, authored: { notes: 1, manualBalloons: 1, revisionClouds: 1, blockInstances: 1, reusableBlocks: 1 },
  automaticBalloons: automaticBalloons.length, exactEvidence: exact.manifest.exactProjectionEvidence.kind,
  pdf: { deterministic: true, scallopedClouds: true, annotationLayerSuppressesAll: true },
  saveReopen: 'preserved', controls: 19,
  failClosed: ['duplicate-block', 'unsafe-block-size', 'delete-block-in-use', 'missing-block', 'missing-view', 'outside-sheet', 'cloud-overflow', 'kind-edit'],
}, null, 2));

process.exit(0);
