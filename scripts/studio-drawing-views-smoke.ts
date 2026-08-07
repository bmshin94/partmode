import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Drawing views smoke failed: ${label}`);
}

function expectCode(label: string, fn: () => unknown, code: string): void {
  try { fn(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Drawing views smoke failed: ${label} did not fail`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const [runtime, agent, viewTools, bookTools, pdfTools, annotationTools] = await Promise.all([
  moduleAt('src/static/studio-v5-runtime-document.js'),
  moduleAt('src/static/studio-agent-service.js'),
  moduleAt('src/static/studio-drawing-views.js'),
  moduleAt('src/static/studio-drawing-book.js'),
  moduleAt('src/static/studio-drawing-pdf.js'),
  moduleAt('src/static/studio-drawing-annotations.js'),
]);
const source = runtime.canonicalStudioV5Project(JSON.parse(await readFile(resolve(root, 'tests/cad-corpus/fillet-shell.partmode.json'), 'utf8')));
const originalJson = JSON.stringify(source);
const transact = (project: JsonRecord, id: string, operations: JsonRecord[]) => agent.applyCadTransaction(project, {
  transactionId: id, label: id, expectedRevision: 0, atomic: true, operations,
}, 0).project;

const contractPlane = { origin: [0, 0, 0], normal: [0, -1, 0], xAxis: [1, 0, 0], keepSide: 'positive' };
expectCode('break display gap equal to removed interval', () => viewTools.createStudioDerivedDrawingView(source, {
  name: 'Invalid break', kind: 'break', sourceViewId: 'front', definition: { axis: 'x', start: -5, end: 5, gapMm: 10 },
}), 'DRAWING_VIEW_INPUT_INVALID');
const assemblyRoot = runtime.createStudioV5AssemblyFromPart(source, {
  id: 'assembly-derived-contract', occurrenceId: 'occurrence-derived-contract',
  name: 'Derived contract assembly', occurrenceName: 'Part:1', fixed: true,
});
expectCode('derived view on assembly root', () => viewTools.createStudioDerivedDrawingView(assemblyRoot, {
  name: 'Assembly section', kind: 'full-section', sourceViewId: 'front', definition: { planes: [contractPlane] },
}), 'DRAWING_DERIVED_VIEW_PART_REQUIRED');

let contractProject = viewTools.createStudioDerivedDrawingView(source, {
  name: 'Contract break', kind: 'break', sourceViewId: 'front', definition: { axis: 'x', start: -10, end: 10, gapMm: 4 },
});
const contractBody = runtime.studioV5ActiveBody(contractProject);
check('contract fixture has no active body', contractBody?.id);
expectCode('auxiliary missing body', () => viewTools.createStudioDerivedDrawingView(contractProject, {
  name: 'Missing auxiliary body', kind: 'auxiliary', sourceViewId: 'front',
  definition: { reference: { bodyId: 'body-missing', faceName: 'face:missing' }, xAxis: [1, 0, 0] },
}), 'DRAWING_VIEW_REFERENCE_MISSING');
contractProject = viewTools.createStudioDerivedDrawingView(contractProject, {
  name: 'Contract auxiliary', kind: 'auxiliary', sourceViewId: 'front',
  definition: { reference: { bodyId: contractBody.id, faceName: 'face:resolved-by-exact-worker' }, xAxis: [1, 0, 0] },
});
let contractGraph = viewTools.inspectStudioDrawingViews(contractProject);
const contractBreakId = contractGraph.derivedViews.find((entry: JsonRecord) => entry.kind === 'break').id;
const contractAuxiliaryId = contractGraph.derivedViews.find((entry: JsonRecord) => entry.kind === 'auxiliary').id;
expectCode('derived view as derived source', () => viewTools.createStudioDerivedDrawingView(contractProject, {
  name: 'Derived chain', kind: 'full-section', sourceViewId: contractBreakId, definition: { planes: [contractPlane] },
}), 'DRAWING_VIEW_NOT_FOUND');
contractProject = bookTools.initializeStudioDrawingBook(contractProject, {
  title: 'Derived contract', name: 'Contract sheet', templateId: 'iso-a4-landscape', views: ['front', contractBreakId],
});
const contractSheetId = bookTools.inspectStudioDrawingBook(contractProject).activeSheetId;
for (const kind of [
  'balloon', 'model-dimension', 'associative-dimension', 'datum-symbol', 'feature-control-frame',
  'hole-callout', 'center-mark', 'centerline', 'weld-symbol', 'surface-finish',
]) {
  expectCode(`${kind} on derived view`, () => annotationTools.createStudioDrawingAnnotation(contractProject, {
    kind, sheetId: contractSheetId, viewId: contractBreakId,
  }), 'DRAWING_ANNOTATION_DERIVED_VIEW_UNSUPPORTED');
}
const auxiliaryDependencies = new agent.CadCommandService({ project: contractProject }).inspect({
  kind: 'entity.dependencies', entity: { kind: 'body', id: contractBody.id }, direction: 'downstream',
});
check('auxiliary persistent body dependency is absent', auxiliaryDependencies.items.some((edge: JsonRecord) =>
  edge.from.kind === 'body' && edge.from.id === contractBody.id && edge.to.kind === 'drawing-derived-view'
  && edge.to.id === contractAuxiliaryId && edge.relation === 'references'));
expectCode('delete auxiliary source body', () => transact(contractProject, 'delete-auxiliary-source-body', [{
  kind: 'body.delete', input: { bodyId: contractBody.id },
}]), 'DRAWING_VIEW_IN_USE');
expectCode('convert part with derived views to assembly', () => transact(contractProject, 'assembly-with-derived-views', [{
  kind: 'assembly.create', input: {
    id: 'assembly-derived-transition', occurrenceId: 'occurrence-derived-transition',
    name: 'Invalid transition', occurrenceName: 'Part:1', fixed: true,
  },
}]), 'DRAWING_DERIVED_VIEW_PART_REQUIRED');

const capabilityManifest = agent.cadCapabilityManifest();
const derivedCreateSchema = capabilityManifest.operations.find((entry: JsonRecord) => entry.kind === 'drawing.derivedView.create')
  ?.inputSchema?.properties?.input;
check('derived create capability is not discriminated by all eight kinds', Array.isArray(derivedCreateSchema?.oneOf)
  && derivedCreateSchema.oneOf.length === viewTools.STUDIO_DERIVED_DRAWING_VIEW_KINDS.length
  && JSON.stringify(derivedCreateSchema.oneOf.map((entry: JsonRecord) => entry.properties.kind.const))
    === JSON.stringify(viewTools.STUDIO_DERIVED_DRAWING_VIEW_KINDS));
check('derived create schemas accept transformed derived sources', derivedCreateSchema.oneOf.every((entry: JsonRecord) => {
  const sourceVariants = entry.properties.sourceViewId.oneOf;
  return sourceVariants.some((source: JsonRecord) => source.pattern === '^drawing-view-[0-9]{6}$')
    && sourceVariants.every((source: JsonRecord) => !String(source.pattern || '').includes('derived'));
}));
check('derived definition schemas are not closed typed records', derivedCreateSchema.oneOf.every((entry: JsonRecord) =>
  entry.properties.definition?.type === 'object' && entry.properties.definition.additionalProperties === false));
const annotationCreateSchema = capabilityManifest.operations.find((entry: JsonRecord) => entry.kind === 'drawing.annotation.create')
  ?.inputSchema?.properties?.input;
check('typed annotation schema accepts transformed derived views', annotationCreateSchema.properties.viewId.oneOf
  .every((entry: JsonRecord) => !String(entry.pattern || '').includes('derived')));

let project = transact(source, 'named-view-create', [{
  kind: 'drawing.view.create', input: { name: 'Manufacturing oblique', direction: [-1, -2, -1], xAxis: [1, -0.5, 0] },
}]);
check('named-view creation mutated its source', JSON.stringify(source) === originalJson);
let graph = viewTools.inspectStudioDrawingViews(project);
check('named-view frame was not normalized', graph.schema === 'partmode.drawing-views/v1' && graph.views.length === 1
  && graph.views[0].id === 'drawing-view-000001'
  && Math.abs(Math.hypot(...graph.views[0].direction) - 1) < 1e-11
  && Math.abs(Math.hypot(...graph.views[0].xAxis) - 1) < 1e-11
  && Math.abs(graph.views[0].direction.reduce((sum: number, value: number, index: number) => sum + value * graph.views[0].xAxis[index], 0)) < 1e-11);
project = transact(project, 'drawing-view-sheet', [{
  kind: 'drawing.book.initialize', input: {
    title: 'Drawing view release set', name: 'Aligned phantom', templateId: 'iso-a3-landscape', scale: 'fit',
    views: ['front', 'drawing-view-000001', 'iso'], tangentEdges: 'phantom',
    alignments: [
      { parentView: 'front', childView: 'drawing-view-000001', axis: 'horizontal', gapMm: 10 },
      { parentView: 'front', childView: 'iso', axis: 'vertical', gapMm: 8 },
    ],
  },
}, {
  kind: 'drawing.sheet.create', input: { name: 'Tangent removed', templateId: 'iso-a3-landscape', scale: 'fit', views: ['drawing-view-000001'], tangentEdges: 'removed', activate: true },
}, {
  kind: 'drawing.sheet.create', input: { name: 'Tangent visible', templateId: 'iso-a3-landscape', scale: 'fit', views: ['drawing-view-000001'], tangentEdges: 'visible', activate: true },
}]);
let book = bookTools.inspectStudioDrawingBook(project);
check('drawing-view sheet contract is wrong', book.sheets.length === 3
  && JSON.stringify(book.sheets.map((sheet: JsonRecord) => sheet.tangentEdges)) === JSON.stringify(['phantom', 'removed', 'visible'])
  && book.sheets[0].alignments.length === 2 && book.sheets[0].views.includes('drawing-view-000001'));
const reopened = runtime.canonicalStudioV5Project(JSON.parse(JSON.stringify(project)));
check('named views or alignments changed after save/reopen', JSON.stringify(reopened) === JSON.stringify(project));

expectCode('parallel named-view frame', () => viewTools.createStudioNamedDrawingView(project, { name: 'Parallel', direction: [1, 0, 0], xAxis: [2, 0, 0] }), 'DRAWING_VIEW_INPUT_INVALID');
expectCode('duplicate named-view name', () => viewTools.createStudioNamedDrawingView(project, { name: 'manufacturing oblique', direction: [0, 0, 1], xAxis: [1, 0, 0] }), 'DRAWING_VIEW_EXISTS');
expectCode('delete used named view', () => viewTools.deleteStudioNamedDrawingView(project, 'drawing-view-000001'), 'DRAWING_VIEW_IN_USE');
expectCode('alignment cycle', () => bookTools.updateStudioDrawingSheet(project, { sheetId: 'sheet-000001', patch: { alignments: [
  { parentView: 'front', childView: 'drawing-view-000001', axis: 'horizontal', gapMm: 10 },
  { parentView: 'drawing-view-000001', childView: 'front', axis: 'vertical', gapMm: 8 },
] } }), 'DRAWING_BOOK_INPUT_INVALID');
expectCode('duplicate parent alignment axis', () => bookTools.updateStudioDrawingSheet(project, { sheetId: 'sheet-000001', patch: { alignments: [
  { parentView: 'front', childView: 'drawing-view-000001', axis: 'horizontal', gapMm: 10 },
  { parentView: 'front', childView: 'iso', axis: 'horizontal', gapMm: 8 },
] } }), 'DRAWING_BOOK_INPUT_INVALID');

const viewIds = bookTools.requiredStudioDrawingBookViews(project);
const viewRequests = viewTools.resolveStudioDrawingViewRequests(project, viewIds);
check('named view did not resolve to an exact projection frame', JSON.stringify(viewRequests.map((entry: any) => typeof entry === 'string' ? entry : entry.id))
  === JSON.stringify(['front', 'drawing-view-000001', 'iso']));
let kernel: HeadlessKernel | null = null;
let exact: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  exact = await kernel.request({ kind: 'drawing-v5', requestId: 'drawing-view-exact', projectId: project.projectId, revision: 1, document: project, views: viewRequests }) as JsonRecord;
} finally { await kernel?.dispose(); }
check(`named-view exact HLR failed ${JSON.stringify(exact.errors || [])}`, exact.kind === 'drawing-result' && exact.errors?.length === 0 && exact.views.length === 3);
const namedExact = exact.views.find((entry: JsonRecord) => entry.view === 'drawing-view-000001');
check('named-view exact frame evidence is wrong', namedExact.name === 'Manufacturing oblique'
  && JSON.stringify(namedExact.frame.direction) === JSON.stringify(graph.views[0].direction)
  && JSON.stringify(namedExact.frame.xAxis) === JSON.stringify(graph.views[0].xAxis));
const tangentCount = namedExact.tangentVisible.length + namedExact.tangentHidden.length;
check(`exact HLR did not classify tangent edges ${JSON.stringify({ regularVisible: namedExact.regularVisible.length, regularHidden: namedExact.regularHidden.length, tangentVisible: namedExact.tangentVisible.length, tangentHidden: namedExact.tangentHidden.length })}`, tangentCount > 0
  && namedExact.regularVisible.length > 0
  && namedExact.visible.length > 0);

const firstPdf = pdfTools.createStudioDrawingBookPdf(exact, project.name, book);
const secondPdf = pdfTools.createStudioDrawingBookPdf(exact, project.name, book);
check('named-view drawing set is not deterministic', Buffer.compare(Buffer.from(firstPdf.bytes), Buffer.from(secondPdf.bytes)) === 0);
check('drawing-view PDF manifest is wrong', firstPdf.manifest.pageCount === 3
  && JSON.stringify(firstPdf.manifest.pages.map((page: JsonRecord) => page.tangentEdges)) === JSON.stringify(['phantom', 'removed', 'visible'])
  && firstPdf.manifest.pages[0].layoutMode === 'aligned' && firstPdf.manifest.pages[0].alignments.length === 2);
const horizontal = firstPdf.manifest.pages[0].alignments.find((entry: JsonRecord) => entry.axis === 'horizontal');
const vertical = firstPdf.manifest.pages[0].alignments.find((entry: JsonRecord) => entry.axis === 'vertical');
check('horizontal view alignment is not exact', Math.abs(horizontal.parentCenter[1] - horizontal.childCenter[1]) < 1e-9
  && Math.abs(horizontal.measuredGapMm - 10) < 1e-9 && horizontal.gapMm === 10);
check('vertical view alignment is not exact', Math.abs(vertical.parentCenter[0] - vertical.childCenter[0]) < 1e-9
  && Math.abs(vertical.measuredGapMm - 8) < 1e-9 && vertical.gapMm === 8);

const isolatedResponse = { ...exact, views: [namedExact] };
const removed = pdfTools.createStudioDrawingPdf(isolatedResponse, 'Removed', { tangentEdges: 'removed' });
const visible = pdfTools.createStudioDrawingPdf(isolatedResponse, 'Visible', { tangentEdges: 'visible' });
const phantom = pdfTools.createStudioDrawingPdf(isolatedResponse, 'Phantom', { tangentEdges: 'phantom' });
const pathOps = (bytes: Uint8Array) => (Buffer.from(bytes).toString('latin1').match(/(?:^|\n)S\n/gu) || []).length;
check(`removed tangent edges did not reduce exact PDF paths ${JSON.stringify({ visible: pathOps(visible.bytes), removed: pathOps(removed.bytes) })}`, pathOps(visible.bytes) > pathOps(removed.bytes));
check('phantom tangent line font is absent', Buffer.from(phantom.bytes).toString('latin1').includes('[8.504 2.835 1.701 2.835] 0 d'));
check('visible tangent mode incorrectly uses phantom font', !Buffer.from(visible.bytes).toString('latin1').includes('[8.504 2.835 1.701 2.835] 0 d'));

const edited = viewTools.updateStudioNamedDrawingView(project, { viewId: 'drawing-view-000001', patch: { direction: [-2, -1, -1], xAxis: [1, -2, 0] } });
const editedRequests = viewTools.resolveStudioDrawingViewRequests(edited, ['drawing-view-000001']);
let editedExact: JsonRecord;
let invalidFrame: JsonRecord;
let duplicateRequest: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  editedExact = await kernel.request({ kind: 'drawing-v5', requestId: 'drawing-view-edited', projectId: edited.projectId, revision: 2, document: edited, views: editedRequests }) as JsonRecord;
  invalidFrame = await kernel.request({ kind: 'drawing-v5', requestId: 'drawing-view-invalid-frame', projectId: edited.projectId, revision: 3, document: edited, views: [{ id: 'drawing-view-000002', name: 'Invalid', direction: [1, 0, 0], xAxis: [2, 0, 0] }] }) as JsonRecord;
  duplicateRequest = await kernel.request({ kind: 'drawing-v5', requestId: 'drawing-view-duplicate', projectId: edited.projectId, revision: 4, document: edited, views: ['front', 'front'] }) as JsonRecord;
} finally { await kernel?.dispose(); }
check(`edited named-view HLR failed ${JSON.stringify(editedExact.errors || [])}`, editedExact.errors?.length === 0 && editedExact.views?.length === 1);
check('named-view edit did not change exact projection', JSON.stringify(editedExact.views[0].visible) !== JSON.stringify(namedExact.visible));
check('worker accepted a parallel named-view frame', invalidFrame.views === null && invalidFrame.errors?.[0]?.message.includes('orthogonal'));
check('worker accepted duplicate projection ids', duplicateRequest.views === null && duplicateRequest.errors?.[0]?.message.includes('unique'));

const [pageSource, studioSource, registrySource, agentSource, workerSource, vendorSource, buildSource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'), readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'), readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8'), readFile(resolve(root, 'src/static/vendor/replicad.module.js'), 'utf8'),
  readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
]);
check('visible named-view controls are missing', pageSource.includes('id="bw-drawing-view-add"') && pageSource.includes('id="bw-drawing-tangent-edges"')
  && pageSource.includes('id="bw-drawing-alignment-add"') && pageSource.includes('id="bw-drawing-alignment-delete"'));
check('visible derived-view contract boundaries are missing', pageSource.includes('id="bw-drawing-derived-view-fieldset"')
  && pageSource.includes('Exterior side') && pageSource.includes('id="bw-drawing-derived-view-boundary-x-label">Minimum X')
  && pageSource.includes('id="bw-drawing-derived-view-boundary-y-label">Minimum Y'));
check('visible drawing-view routing is missing', studioSource.includes("kind: 'drawing.view.create'")
  && studioSource.includes('resolveStudioDrawingViewRequests') && studioSource.includes("kind: 'drawing.sheet.update'"));
check('visible manager does not enforce part-only or ordinary annotation views', studioSource.includes('derivedDrawingViewsAvailable')
  && studioSource.includes("doc.rootDocument?.kind === 'part'") && studioSource.includes('populateOrdinaryDrawingViewSelect')
  && studioSource.includes('Break display gap must be smaller than the removed interval.'));
check('typed drawing-view surfaces are missing', agentSource.includes("'drawing.view.create'") && agentSource.includes("['drawing-view', view.id, view]")
  && registrySource.includes("'dialog.drawing-view.add'") && registrySource.includes("'dialog.drawing-alignment.add'")
  && registrySource.includes('Set half-section exterior side'));
check('exact tangent HLR classification is missing', workerSource.includes('drawProjectionWithEdgeClasses')
  && vendorSource.includes('Rg1LineVCompound_1') && vendorSource.includes('tangentVisible'));
check('drawing-view module is absent from release assets', buildSource.includes("'studio-drawing-views.js'"));

console.log(JSON.stringify({
  schema: graph.schema, namedView: graph.views[0], exactEvidence: exact.manifest.exactProjectionEvidence.kind,
  exactViews: exact.views.map((entry: JsonRecord) => entry.view), tangentEdges: {
    regularVisible: namedExact.regularVisible.length, regularHidden: namedExact.regularHidden.length,
    tangentVisible: namedExact.tangentVisible.length, tangentHidden: namedExact.tangentHidden.length,
  },
  alignedSheet: { horizontalGapMm: horizontal.gapMm, verticalGapMm: vertical.gapMm, scale: firstPdf.manifest.pages[0].scaleLabel },
  displayModes: { removedPaths: pathOps(removed.bytes), visiblePaths: pathOps(visible.bytes), phantomFont: true },
  derivedContract: {
    partOnly: true, ordinarySourcesOnly: true, typedKinds: derivedCreateSchema.oneOf.length,
    annotationTargets: 'ordinary-only', auxiliaryBodyDependency: true, breakGapBounded: true,
  },
  saveReopen: 'preserved', editedProjection: 'changed', controls: 15,
  failClosed: ['parallel-frame', 'duplicate-name', 'delete-in-use', 'alignment-cycle', 'duplicate-parent-axis', 'worker-parallel-frame', 'worker-duplicate-id'],
}, null, 2));
