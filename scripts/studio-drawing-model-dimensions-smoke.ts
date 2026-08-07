import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Imported model-dimension smoke failed: ${label}`);
}

function expectCode(label: string, action: () => unknown, code: string): void {
  try { action(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Imported model-dimension smoke failed: ${label} did not fail`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const [runtime, agent, drawingBook, annotations, drawingPdf, projectModule] = await Promise.all([
  moduleAt('src/static/studio-v5-runtime-document.js'),
  moduleAt('src/static/studio-agent-service.js'),
  moduleAt('src/static/studio-drawing-book.js'),
  moduleAt('src/static/studio-drawing-annotations.js'),
  moduleAt('src/static/studio-drawing-pdf.js'),
  moduleAt('src/static/studio-project-v5.js'),
]);

const transact = (project: JsonRecord, id: string, operations: JsonRecord[]) => agent.applyCadTransaction(project, {
  transactionId: id, label: id, expectedRevision: 0, atomic: true, operations,
});

let project = runtime.createStudioV5RuntimePartProject({
  projectId: 'project-drawing-model-dimension',
  name: 'Imported model dimension',
  units: 'mm',
  parameters: [{ name: 'stock', value: 10 }],
  features: [{
    id: 'feature-model-dimension-plate', name: 'Plate', type: 'extrude',
    sketch: { shapes: [{ id: 'shape-model-dimension-plate', kind: 'rect', x: 0, y: 0, w: 40, h: 30 }], z: 0 },
    h: 'stock * 2', through: false,
  }],

});
project.parameters[0].value = 'max(8mm, 10mm)';

project = transact(project, 'initialize-model-dimension-sheet', [{
  kind: 'drawing.book.initialize',
  input: { title: 'Imported dimensions', templateId: 'iso-a3-landscape', name: 'Dimensions', scale: 'fit', views: ['front', 'top'] },
}]).project;

const created = transact(project, 'import-model-dimension', [{
  kind: 'drawing.annotation.create',
  input: {
    kind: 'model-dimension', sheetId: 'sheet-000001', viewId: 'front',
    featureId: 'feature-model-dimension-plate', sourceField: 'h',
    anchorA: [0, 0], anchorB: [0, -20], labelMm: [60, 55],
  },
}]);
check('typed create does not report the imported dimension', created.changeSet.created.some((entry: JsonRecord) => entry.kind === 'drawing-annotation'));
project = created.project;
let graph = annotations.inspectStudioDrawingAnnotations(project);
check('persistent imported model dimension is incomplete', graph.annotations.length === 1
  && graph.annotations[0].kind === 'model-dimension'
  && graph.annotations[0].featureId === 'feature-model-dimension-plate'
  && graph.annotations[0].sourceField === 'h');

project = transact(project, 'create-temporary-model-dimension', [{
  kind: 'drawing.annotation.create',
  input: {
    kind: 'model-dimension', sheetId: 'sheet-000001', viewId: 'front',
    featureId: 'feature-model-dimension-plate', sourceField: 'h',
    anchorA: [5, 0], anchorB: [5, -20], labelMm: [72, 55],
  },
}]).project;
const temporaryId = annotations.inspectStudioDrawingAnnotations(project).annotations.at(-1).id;
project = transact(project, 'update-temporary-model-dimension', [{
  kind: 'drawing.annotation.update', input: { annotationId: temporaryId, patch: { labelMm: [74, 55] } },
}]).project;
check('typed imported-dimension update did not persist', annotations.inspectStudioDrawingAnnotations(project).annotations.at(-1).labelMm[0] === 74);
project = transact(project, 'delete-temporary-model-dimension', [{
  kind: 'drawing.annotation.delete', input: { annotationId: temporaryId },
}]).project;

const canonical = JSON.stringify(projectModule.prepareStudioV5Project(project));
project = projectModule.parseStudioV5Project(canonical);
check('imported model dimension changed across canonical save/reopen', JSON.stringify(project) === canonical);
graph = annotations.inspectStudioDrawingAnnotations(project);

expectCode('missing feature source', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'model-dimension', sheetId: 'sheet-000001', viewId: 'front', featureId: 'feature-missing', sourceField: 'h',
  anchorA: [0, 0], anchorB: [0, -20], labelMm: [60, 55],
}), 'DRAWING_ANNOTATION_REFERENCE_MISSING');
expectCode('incompatible driving field', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'model-dimension', sheetId: 'sheet-000001', viewId: 'front', featureId: 'feature-model-dimension-plate', sourceField: 'r',
  anchorA: [0, 0], anchorB: [0, -20], labelMm: [60, 55],
}), 'DRAWING_ANNOTATION_REFERENCE_MISSING');
expectCode('collapsed authored endpoints', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'model-dimension', sheetId: 'sheet-000001', viewId: 'front', featureId: 'feature-model-dimension-plate', sourceField: 'h',
  anchorA: [0, 0], anchorB: [0, 0], labelMm: [60, 55],
}), 'DRAWING_ANNOTATION_INPUT_INVALID');

const book = drawingBook.inspectStudioDrawingBook(project);
let kernel: HeadlessKernel | null = null;
let exact: JsonRecord;
let editedExact: JsonRecord;
let editedProject: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  exact = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-model-dimension-initial', projectId: project.projectId, revision: 1,
    document: project, views: ['front', 'top'],
  }, 180_000) as JsonRecord;
  check(`initial exact drawing failed: ${JSON.stringify(exact.errors || [])}`, exact.kind === 'drawing-result'
    && exact.errors?.length === 0 && exact.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');
  editedProject = transact(project, 'edit-driving-parameter', [{
    kind: 'parameter.update', input: { parameterName: 'stock', value: '15mm' },
  }]).project;
  editedExact = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-model-dimension-edited', projectId: editedProject.projectId, revision: 2,
    document: editedProject, views: ['front', 'top'],
  }, 180_000) as JsonRecord;
  check(`edited exact drawing failed: ${JSON.stringify(editedExact.errors || [])}`, editedExact.kind === 'drawing-result'
    && editedExact.errors?.length === 0 && editedExact.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');
} finally { await kernel?.dispose(); }

const firstPdf = drawingPdf.createStudioDrawingBookPdf(exact!, project.name, book, null, graph, null, project);
const repeatedPdf = drawingPdf.createStudioDrawingBookPdf(exact!, project.name, book, null, graph, null, project);
const editedPdf = drawingPdf.createStudioDrawingBookPdf(
  editedExact!, editedProject!.name, book, null, editedProject!.extensions.drawingAnnotations, null, editedProject!,
);
check('imported model-dimension PDF is not deterministic', Buffer.compare(Buffer.from(firstPdf.bytes), Buffer.from(repeatedPdf.bytes)) === 0);
check('driving model edit did not change the exact drawing PDF', Buffer.compare(Buffer.from(firstPdf.bytes), Buffer.from(editedPdf.bytes)) !== 0);
const resolved = firstPdf.manifest.pages[0].drawingAnnotations.annotations[0];
const editedResolved = editedPdf.manifest.pages[0].drawingAnnotations.annotations[0];
check('initial expression/value evidence is incomplete', resolved.authoredExpression === 'stock * 2'
  && resolved.resolvedValue === 20 && resolved.displayText === 'Plate depth = 20 mm'
  && resolved.sourceEvidence.kind === 'exact-imported-model-dimension'
  && resolved.sourceEvidence.documentHash === exact!.manifest.exactProjectionEvidence.documentHash);
check('typed parameter edit did not refresh imported dimension', editedResolved.authoredExpression === 'stock * 2'
  && editedResolved.resolvedValue === 30 && editedResolved.displayText === 'Plate depth = 30 mm'
  && editedResolved.sourceEvidence.documentHash === editedExact!.manifest.exactProjectionEvidence.documentHash);
const initialPdfText = Buffer.from(firstPdf.bytes).toString('latin1');
const editedPdfText = Buffer.from(editedPdf.bytes).toString('latin1');
check('imported dimension text did not render on the dimensions layer', initialPdfText.includes('(Plate depth = 20 mm)')
  && editedPdfText.includes('(Plate depth = 30 mm)'));

expectCode('stale exact document revision', () => drawingPdf.createStudioDrawingBookPdf(
  exact!, editedProject!.name, book, null, editedProject!.extensions.drawingAnnotations, null, editedProject!,
), 'DRAWING_ANNOTATION_REFERENCE_STALE');
expectCode('missing exact drawing evidence', () => annotations.resolveStudioDrawingSheetAnnotations(
  book, graph, 'sheet-000001', { ...exact, manifest: null }, project,
), 'DRAWING_ANNOTATION_EXACT_REQUIRED');
const outsideProject = annotations.createStudioDrawingAnnotation(project, {
  kind: 'model-dimension', sheetId: 'sheet-000001', viewId: 'front', featureId: 'feature-model-dimension-plate', sourceField: 'h',
  anchorA: [0, 0], anchorB: [1_000, 1_000], labelMm: [60, 55],
});
expectCode('endpoint outside exact view', () => annotations.resolveStudioDrawingSheetAnnotations(
  book, outsideProject.extensions.drawingAnnotations, 'sheet-000001', exact, outsideProject,
), 'DRAWING_ANNOTATION_REFERENCE_STALE');
const suppressedProject = transact(project, 'suppress-model-dimension-source', [{
  kind: 'feature.suppress', input: { featureId: 'feature-model-dimension-plate', suppressed: true },
}]).project;
expectCode('suppressed model source', () => annotations.inspectStudioDrawingAnnotations(suppressedProject), 'DRAWING_ANNOTATION_REFERENCE_MISSING');

const [pageSource, studioSource, agentSource, registrySource, pdfSource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-drawing-pdf.js'), 'utf8'),
]);
const uiIds = ['bw-drawing-model-dimension', 'bw-drawing-model-dimension-view', 'bw-drawing-model-dimension-feature',
  'bw-drawing-model-dimension-field', 'bw-drawing-model-dimension-anchor-a', 'bw-drawing-model-dimension-anchor-b',
  'bw-drawing-model-dimension-label', 'bw-drawing-model-dimension-add', 'bw-drawing-model-dimension-update',
  'bw-drawing-model-dimension-delete'];
check('visible imported model-dimension manager is incomplete', uiIds.every((id) => pageSource.includes(`id="${id}"`)));
check('visible manager does not route typed lifecycle', studioSource.includes('authoredDrawingModelDimension')
  && studioSource.includes("'Import model dimension'") && studioSource.includes("'Update imported model dimension'"));
check('typed agent does not admit imported dimensions', agentSource.includes("'model-dimension'") && agentSource.includes("sourceField: { enum: ['h', 'r', 't'] }"));
check('typed UI registry omits imported model-dimension controls', registrySource.includes("'dialog.drawing-model-dimension.add'")
  && registrySource.includes("'dialog.drawing-model-dimension.update'") && registrySource.includes("'dialog.drawing-model-dimension.delete'"));
check('PDF renderer omits imported model dimensions', pdfSource.includes("annotation.kind === 'model-dimension'")
  && pdfSource.includes('annotation.displayText'));

console.log(JSON.stringify({
  schema: graph.schema,
  source: { featureId: resolved.featureId, sourceField: resolved.sourceField, authoredExpression: resolved.authoredExpression },
  resolvedValuesMm: [resolved.resolvedValue, editedResolved.resolvedValue],
  exactDrawings: 2,
  deterministicPdfBytes: firstPdf.bytes.length,
  typedLifecycle: ['create', 'update', 'delete'],
  saveReopen: 'preserved',
  failClosed: ['missing-feature', 'incompatible-field', 'collapsed-endpoints', 'suppressed-feature', 'missing-exact-evidence', 'outside-view', 'stale-document-revision'],
  boundary: 'authored exact-view endpoints; no topology-associative placement claim',
}, null, 2));
