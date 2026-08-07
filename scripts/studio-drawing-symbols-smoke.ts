import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Drawing symbols smoke failed: ${label}`);
}

function expectCode(label: string, action: () => unknown, code: string): void {
  try { action(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Drawing symbols smoke failed: ${label} did not fail`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const [runtime, agent, drawingBook, annotations, drawingPdf, holeWizard, projectModule] = await Promise.all([
  moduleAt('src/static/studio-v5-runtime-document.js'),
  moduleAt('src/static/studio-agent-service.js'),
  moduleAt('src/static/studio-drawing-book.js'),
  moduleAt('src/static/studio-drawing-annotations.js'),
  moduleAt('src/static/studio-drawing-pdf.js'),
  moduleAt('src/static/studio-hole-wizard.js'),
  moduleAt('src/static/studio-project-v5.js'),
]);

const plateDocument = (projectId: string): JsonRecord => runtime.createStudioV5RuntimePartProject({
  projectId,
  name: 'Manufacturing drawing symbols',
  units: 'mm',
  parameters: [],
  features: [{
    id: 'feature-symbol-plate', type: 'extrude',
    sketch: { shapes: [{ id: 'shape-symbol-plate', kind: 'rect', x: 0, y: 0, w: 40, h: 40 }], z: 0 },
    h: 20, through: false,
  }],

});

const transact = (project: JsonRecord, id: string, operations: JsonRecord[]) => agent.applyCadTransaction(project, {
  transactionId: id, label: id, expectedRevision: 0, atomic: true, operations,
});

let project = plateDocument('project-drawing-symbols');
const body = runtime.studioV5ActiveBody(project);
check('symbol fixture has no target body', body?.id);
const firstHole = holeWizard.createStudioHoleWizardFeature({
  id: 'feature-symbol-counterbore', bodyId: body.id, kind: 'counterbore', designation: 'M6', center: [-8, -5], sketchZ: 20,
});
const secondHole = holeWizard.createStudioHoleWizardFeature({
  id: 'feature-symbol-tapped', bodyId: body.id, kind: 'tapped', designation: 'M8', center: [8, -5], sketchZ: 20,
});
project = transact(project, 'create-symbol-source-holes', [
  { kind: 'feature.cut', input: holeWizard.studioHoleWizardOperationInput(firstHole) },
  { kind: 'feature.cut', input: holeWizard.studioHoleWizardOperationInput(secondHole) },
]).project;
project = transact(project, 'initialize-symbol-sheet', [{
  kind: 'drawing.book.initialize',
  input: { title: 'Manufacturing symbols', templateId: 'iso-a3-landscape', name: 'Symbols', scale: 'fit', views: ['front', 'top', 'right'] },
}]).project;

const created = transact(project, 'create-manufacturing-symbols', [
  { kind: 'drawing.annotation.create', input: { kind: 'hole-callout', sheetId: 'sheet-000001', viewId: 'top', featureId: firstHole.id, labelMm: [20, 20] } },
  { kind: 'drawing.annotation.create', input: { kind: 'center-mark', sheetId: 'sheet-000001', viewId: 'top', featureId: firstHole.id, sizeMm: 3 } },
  { kind: 'drawing.annotation.create', input: { kind: 'centerline', sheetId: 'sheet-000001', viewId: 'top', featureIds: [firstHole.id, secondHole.id], extensionMm: 4 } },
  { kind: 'drawing.annotation.create', input: { kind: 'weld-symbol', sheetId: 'sheet-000001', viewId: 'front', anchor: [0, -10], labelMm: [20, 86], weldType: 'fillet', side: 'both', sizeMm: 6, tail: 'SHOP WELD' } },
  { kind: 'drawing.annotation.create', input: { kind: 'surface-finish', sheetId: 'sheet-000001', viewId: 'front', anchor: [10, -15], labelMm: [80, 86], roughnessRa: 3.2, method: 'material-removal-required', lay: 'multidirectional', process: 'GRIND' } },
]);
check('typed manufacturing-symbol entities are incomplete', created.changeSet.created.filter((entry: JsonRecord) => entry.kind === 'drawing-annotation').length === 5);
project = created.project;
project = transact(project, 'create-temporary-symbol', [{
  kind: 'drawing.annotation.create', input: { kind: 'center-mark', sheetId: 'sheet-000001', viewId: 'top', featureId: secondHole.id, sizeMm: 2 },
}]).project;
const temporaryId = annotations.inspectStudioDrawingAnnotations(project).annotations.at(-1).id;
project = transact(project, 'update-temporary-symbol', [{
  kind: 'drawing.annotation.update', input: { annotationId: temporaryId, patch: { sizeMm: 2.5 } },
}]).project;
check('typed manufacturing-symbol update did not persist', annotations.inspectStudioDrawingAnnotations(project).annotations.at(-1).sizeMm === 2.5);
project = transact(project, 'delete-temporary-symbol', [{ kind: 'drawing.annotation.delete', input: { annotationId: temporaryId } }]).project;

const graph = annotations.inspectStudioDrawingAnnotations(project);
check('manufacturing-symbol graph is incomplete', graph.schema === 'partmode.drawing-annotations/v1' && graph.annotations.length === 5
  && JSON.stringify(graph.annotations.map((entry: JsonRecord) => entry.kind))
    === JSON.stringify(['hole-callout', 'center-mark', 'centerline', 'weld-symbol', 'surface-finish']));
const canonical = JSON.stringify(projectModule.prepareStudioV5Project(project));
project = projectModule.parseStudioV5Project(canonical);
check('manufacturing symbols changed across canonical save/reopen', JSON.stringify(project) === canonical);

expectCode('missing Hole Wizard callout source', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'hole-callout', sheetId: 'sheet-000001', viewId: 'top', featureId: 'feature-missing', labelMm: [20, 20],
}), 'DRAWING_ANNOTATION_REFERENCE_MISSING');
expectCode('duplicate centerline source', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'centerline', sheetId: 'sheet-000001', viewId: 'top', featureIds: [firstHole.id, firstHole.id], extensionMm: 2,
}), 'DRAWING_ANNOTATION_INPUT_INVALID');
expectCode('symbol view absent from sheet', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'surface-finish', sheetId: 'sheet-000001', viewId: 'iso', anchor: [0, 0], labelMm: [20, 20], roughnessRa: 1.6,
}), 'DRAWING_ANNOTATION_INPUT_INVALID');
expectCode('invalid surface roughness', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'surface-finish', sheetId: 'sheet-000001', viewId: 'front', anchor: [0, 0], labelMm: [20, 20], roughnessRa: 0,
}), 'DRAWING_ANNOTATION_INPUT_INVALID');

const book = drawingBook.inspectStudioDrawingBook(project);
let kernel: HeadlessKernel | null = null;
let exact: JsonRecord;
let movedExact: JsonRecord;
let movedProject: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  exact = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-symbols-initial', projectId: project.projectId, revision: 1,
    document: project, views: ['front', 'top', 'right'],
  }, 180_000) as JsonRecord;
  check(`initial exact symbol drawing failed: ${JSON.stringify(exact.errors || [])}`, exact.kind === 'drawing-result'
    && exact.errors?.length === 0 && exact.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');
  const movedHole = holeWizard.createStudioHoleWizardFeature({
    id: firstHole.id, bodyId: body.id, kind: 'counterbore', designation: 'M6', center: [-4, -5], sketchZ: 20,
  });
  movedProject = transact(project, 'move-symbol-source-hole', [{
    kind: 'feature.update', input: {
      featureId: firstHole.id,
      patch: { name: movedHole.name, sketch: movedHole.sketch, h: movedHole.h, through: true, resultPolicy: movedHole.resultPolicy, inputRefs: movedHole.inputRefs, extensions: movedHole.extensions },
    },
  }]).project;
  movedExact = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-symbols-moved', projectId: movedProject.projectId, revision: 2,
    document: movedProject, views: ['front', 'top', 'right'],
  }, 180_000) as JsonRecord;
  check(`moved exact symbol drawing failed: ${JSON.stringify(movedExact.errors || [])}`, movedExact.kind === 'drawing-result'
    && movedExact.errors?.length === 0 && movedExact.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');
} finally { await kernel?.dispose(); }

const firstPdf = drawingPdf.createStudioDrawingBookPdf(exact!, project.name, book, null, project.extensions.drawingAnnotations, null, project);
const repeatedPdf = drawingPdf.createStudioDrawingBookPdf(exact!, project.name, book, null, project.extensions.drawingAnnotations, null, project);
const movedPdf = drawingPdf.createStudioDrawingBookPdf(movedExact!, movedProject!.name, book, null, movedProject!.extensions.drawingAnnotations, null, movedProject!);
check('manufacturing-symbol PDF is not deterministic', Buffer.compare(Buffer.from(firstPdf.bytes), Buffer.from(repeatedPdf.bytes)) === 0);
check('associative symbol source edit did not change PDF', Buffer.compare(Buffer.from(firstPdf.bytes), Buffer.from(movedPdf.bytes)) !== 0);
const resolved = firstPdf.manifest.pages[0].drawingAnnotations.annotations;
const movedResolved = movedPdf.manifest.pages[0].drawingAnnotations.annotations;
const callout = resolved.find((entry: JsonRecord) => entry.kind === 'hole-callout');
const movedCallout = movedResolved.find((entry: JsonRecord) => entry.kind === 'hole-callout');
const centerline = resolved.find((entry: JsonRecord) => entry.kind === 'centerline');
check('Hole Wizard callout did not resolve through exact view frame', callout.callout === 'CBORE 10 x 6 mm, THRU 6.6 mm'
  && callout.sourceEvidence.kind === 'exact-hole-wizard-projection' && JSON.stringify(callout.anchor) === JSON.stringify([-8, -5])
  && JSON.stringify(movedCallout.anchor) === JSON.stringify([-4, -5]));
check('center mark or centerline did not resolve exact Hole Wizard centers', resolved.find((entry: JsonRecord) => entry.kind === 'center-mark').sourceEvidence.kind === 'exact-hole-wizard-projection'
  && centerline.sourceEvidence.kind === 'exact-hole-wizard-centerline'
  && JSON.stringify(centerline.anchors) === JSON.stringify([[-8, -5], [8, -5]]));
const collapsedCenterlineProject = annotations.createStudioDrawingAnnotation(project, {
  kind: 'centerline', sheetId: 'sheet-000001', viewId: 'right', featureIds: [firstHole.id, secondHole.id], extensionMm: 3,
});
expectCode('distinct centers collapsed in selected view', () => drawingPdf.createStudioDrawingBookPdf(
  exact!, project.name, book, null, collapsedCenterlineProject.extensions.drawingAnnotations, null, project,
), 'DRAWING_ANNOTATIONS_INVALID');
expectCode('stale exact document revision', () => drawingPdf.createStudioDrawingBookPdf(
  exact!, movedProject!.name, book, null, movedProject!.extensions.drawingAnnotations, null, movedProject!,
), 'DRAWING_ANNOTATION_REFERENCE_STALE');
const pdfText = Buffer.from(firstPdf.bytes).toString('latin1');
check('one or more manufacturing symbols did not render', pdfText.includes('(CBORE 10 x 6 mm, THRU 6.6 mm)')
  && pdfText.includes('(6 fillet both)') && pdfText.includes('(SHOP WELD)')
  && pdfText.includes('(Ra 3.2)') && pdfText.includes('(GRIND)') && pdfText.includes('(lay multidirectional)'));

const suppressedProject = transact(project, 'suppress-symbol-source-hole', [{
  kind: 'feature.suppress', input: { featureId: firstHole.id, suppressed: true },
}]).project;
expectCode('suppressed Hole Wizard symbol source', () => drawingPdf.createStudioDrawingBookPdf(
  exact!, suppressedProject.name, book, null, suppressedProject.extensions.drawingAnnotations, null, suppressedProject,
), 'DRAWING_ANNOTATION_REFERENCE_MISSING');
expectCode('missing exact drawing evidence', () => annotations.resolveStudioDrawingSheetAnnotations(
  book, project.extensions.drawingAnnotations, 'sheet-000001', { ...exact, manifest: null }, project,
), 'DRAWING_ANNOTATION_EXACT_REQUIRED');
const outsideAnchorProject = annotations.createStudioDrawingAnnotation(project, {
  kind: 'weld-symbol', sheetId: 'sheet-000001', viewId: 'front', anchor: [1_000, 1_000], labelMm: [20, 20],
  weldType: 'v-groove', side: 'both', sizeMm: 5,
});
expectCode('authored anchor outside exact view', () => annotations.resolveStudioDrawingSheetAnnotations(
  book, outsideAnchorProject.extensions.drawingAnnotations, 'sheet-000001', exact, outsideAnchorProject,
), 'DRAWING_ANNOTATION_REFERENCE_STALE');

const [pageSource, studioSource, agentSource, registrySource, pdfSource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-drawing-pdf.js'), 'utf8'),
]);
check('visible manufacturing-symbol manager is incomplete', ['bw-drawing-symbol-kind', 'bw-drawing-symbol-view', 'bw-drawing-symbol-references',
  'bw-drawing-symbol-anchor', 'bw-drawing-symbol-label', 'bw-drawing-symbol-value', 'bw-drawing-symbol-weld-type',
  'bw-drawing-symbol-weld-side', 'bw-drawing-symbol-surface-method', 'bw-drawing-symbol-surface-lay', 'bw-drawing-symbol-detail',
  'bw-drawing-symbol-add', 'bw-drawing-symbol-update', 'bw-drawing-symbol-delete'].every((id) => pageSource.includes(`id="${id}"`)));
check('visible manufacturing symbols do not route typed operations', studioSource.includes('authoredDrawingSymbol')
  && studioSource.includes("'Add manufacturing drawing symbol'") && studioSource.includes("'Update manufacturing drawing symbol'"));
check('typed agent does not admit manufacturing symbols', agentSource.includes("'hole-callout'") && agentSource.includes("'surface-finish'"));
check('typed UI registry omits manufacturing-symbol controls', registrySource.includes("'dialog.drawing-symbol.add'")
  && registrySource.includes("'dialog.drawing-symbol.update'") && registrySource.includes("'dialog.drawing-symbol.delete'"));
check('PDF renderer omits manufacturing-symbol paths', pdfSource.includes("annotation.kind === 'hole-callout'")
  && pdfSource.includes("annotation.kind === 'center-mark'") && pdfSource.includes("annotation.kind === 'centerline'")
  && pdfSource.includes("annotation.kind === 'weld-symbol'") && pdfSource.includes("annotation.kind === 'surface-finish'"));

console.log(JSON.stringify({
  schema: graph.schema,
  symbols: resolved.map((entry: JsonRecord) => ({ kind: entry.kind, evidence: entry.sourceEvidence?.kind || 'authored' })),
  associativeHoleAnchor: [callout.anchor, movedCallout.anchor],
  exactDrawings: 2,
  deterministicPdfBytes: firstPdf.bytes.length,
  typedLifecycle: ['create', 'update', 'delete'],
  saveReopen: 'preserved',
  failClosed: ['missing-hole', 'duplicate-centerline', 'collapsed-centerline', 'missing-view', 'invalid-roughness', 'suppressed-hole', 'missing-exact-evidence', 'outside-exact-view', 'stale-document-revision'],
}, null, 2));
