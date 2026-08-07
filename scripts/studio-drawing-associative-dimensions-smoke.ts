import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Associative drawing-dimension smoke failed: ${label}`);
}

function expectCode(label: string, action: () => unknown, code: string): void {
  try { action(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Associative drawing-dimension smoke failed: ${label} did not fail`);
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

const transact = (project: JsonRecord, id: string, operations: JsonRecord[]) => agent.applyCadTransaction(project, {
  transactionId: id, label: id, expectedRevision: 0, atomic: true, operations,
});

let project = runtime.createStudioV5RuntimePartProject({
  projectId: 'project-drawing-associative-dimension',
  name: 'Associative placed dimension',
  units: 'mm',
  parameters: [],
  features: [{
    id: 'feature-associative-dimension-plate', name: 'Plate', type: 'extrude',
    sketch: { shapes: [{ id: 'shape-associative-dimension-plate', kind: 'rect', x: 0, y: 0, w: 40, h: 30 }], z: 0 },
    h: 20, through: false,
  }],

});
project = transact(project, 'initialize-associative-dimension-sheet', [{
  kind: 'drawing.book.initialize',
  input: { title: 'Placed dimensions', templateId: 'iso-a3-landscape', name: 'Dimensions', scale: 'fit', views: ['front', 'top'] },
}]).project;
const body = runtime.studioV5ActiveBody(project);
check('dimension fixture has no active body', body?.id);

let kernel: HeadlessKernel | null = null;
let discovery: JsonRecord;
let exact: JsonRecord;
let changedExact: JsonRecord;
let changedProject: JsonRecord;
let references: JsonRecord[];
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  discovery = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-associative-dimension-discovery', projectId: project.projectId, revision: 1,
    document: project, views: ['front', 'top'],
  }, 180_000) as JsonRecord;
  check(`topology discovery failed: ${JSON.stringify(discovery.errors || [])}`, discovery.kind === 'drawing-result'
    && discovery.errors?.length === 0 && discovery.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');
  const topology = discovery.bodies?.[0]?.topology;
  check('drawing worker omitted exact named topology', topology?.schema === 'partmode.drawing-topology-evidence/v1'
    && topology.counts?.vertices === 8 && topology.counts?.namedVertices === 8);
  const at = (point: number[]) => topology.vertices.find((entry: JsonRecord) => JSON.stringify(entry.point) === JSON.stringify(point));
  const lower = at([-20, -15, 0]);
  const upper = at([-20, -15, 20]);
  check(`persistent vertical corner vertices are unavailable: ${JSON.stringify(topology.vertices.map((entry: JsonRecord) => entry.sig?.p))}`,
    lower?.name && upper?.name && lower.name !== upper.name);
  references = [lower, upper].map((entry: JsonRecord) => ({ bodyId: body.id, topologyKind: 'vertex', name: entry.name }));

  const created = transact(project, 'create-associative-dimension', [{
    kind: 'drawing.annotation.create', input: {
      kind: 'associative-dimension', sheetId: 'sheet-000001', viewId: 'front', dimensionType: 'vertical',
      references, labelMm: [58, 48],
    },
  }]);
  check('typed create does not report the placed dimension', created.changeSet.created.some((entry: JsonRecord) => entry.kind === 'drawing-annotation'));
  project = created.project;
  project = transact(project, 'create-temporary-associative-dimension', [{
    kind: 'drawing.annotation.create', input: {
      kind: 'associative-dimension', sheetId: 'sheet-000001', viewId: 'front', dimensionType: 'distance',
      references, labelMm: [72, 48],
    },
  }]).project;
  const temporaryId = annotations.inspectStudioDrawingAnnotations(project).annotations.at(-1).id;
  project = transact(project, 'update-temporary-associative-dimension', [{
    kind: 'drawing.annotation.update', input: { annotationId: temporaryId, patch: { dimensionType: 'vertical', labelMm: [74, 48] } },
  }]).project;
  check('typed placed-dimension update did not persist', annotations.inspectStudioDrawingAnnotations(project).annotations.at(-1).labelMm[0] === 74);
  project = transact(project, 'delete-temporary-associative-dimension', [{
    kind: 'drawing.annotation.delete', input: { annotationId: temporaryId },
  }]).project;
  const canonical = JSON.stringify(projectModule.prepareStudioV5Project(project));
  project = projectModule.parseStudioV5Project(canonical);
  check('placed dimension changed across canonical save/reopen', JSON.stringify(project) === canonical);
  exact = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-associative-dimension-initial', projectId: project.projectId, revision: 2,
    document: project, views: ['front', 'top'],
  }, 180_000) as JsonRecord;
  check(`initial associative drawing failed: ${JSON.stringify(exact.errors || [])}`, exact.kind === 'drawing-result'
    && exact.errors?.length === 0 && exact.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');
  const exactVertexNames = exact.bodies?.[0]?.topology?.vertices?.map((entry: JsonRecord) => entry.name) || [];
  check(`persistent vertex names changed before the model edit: ${JSON.stringify({ references, exactVertexNames })}`,
    references.every((reference) => exactVertexNames.includes(reference.name)));

  const hole = holeWizard.createStudioHoleWizardFeature({
    id: 'feature-associative-dimension-hole', bodyId: body.id, kind: 'clearance', designation: 'M6', center: [20, 15], sketchZ: 30,
  });
  changedProject = transact(project, 'change-topology-and-height', [
    { kind: 'feature.update', input: { featureId: 'feature-associative-dimension-plate', patch: { h: 30 } } },
    { kind: 'feature.cut', input: holeWizard.studioHoleWizardOperationInput(hole) },
  ]).project;
  changedExact = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-associative-dimension-changed', projectId: changedProject.projectId, revision: 3,
    document: changedProject, views: ['front', 'top'],
  }, 180_000) as JsonRecord;
  check(`changed associative drawing failed: ${JSON.stringify(changedExact.errors || [])}`, changedExact.kind === 'drawing-result'
    && changedExact.errors?.length === 0 && changedExact.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');
} finally { await kernel?.dispose(); }

let graph = annotations.inspectStudioDrawingAnnotations(project);
check('placed dimension graph is incomplete', graph.annotations.length === 1 && graph.annotations[0].kind === 'associative-dimension'
  && graph.annotations[0].dimensionType === 'vertical' && JSON.stringify(graph.annotations[0].references) === JSON.stringify(references!));

const book = drawingBook.inspectStudioDrawingBook(project);
const firstPdf = drawingPdf.createStudioDrawingBookPdf(exact!, project.name, book, null, graph, null, project);
const repeatedPdf = drawingPdf.createStudioDrawingBookPdf(exact!, project.name, book, null, graph, null, project);
const changedPdf = drawingPdf.createStudioDrawingBookPdf(
  changedExact!, changedProject!.name, book, null, changedProject!.extensions.drawingAnnotations, null, changedProject!,
);
check('associative placed-dimension PDF is not deterministic', Buffer.compare(Buffer.from(firstPdf.bytes), Buffer.from(repeatedPdf.bytes)) === 0);
check('topology/height edit did not change placed-dimension PDF', Buffer.compare(Buffer.from(firstPdf.bytes), Buffer.from(changedPdf.bytes)) !== 0);
const resolved = firstPdf.manifest.pages[0].drawingAnnotations.annotations[0];
const changedResolved = changedPdf.manifest.pages[0].drawingAnnotations.annotations[0];
check('initial persistent-topology dimension is incomplete', resolved.sourceEvidence.kind === 'exact-persistent-topology-dimension'
  && resolved.resolvedValue === 20 && resolved.displayText === '20 mm'
  && JSON.stringify(resolved.anchors) === JSON.stringify([[-20, 0], [-20, -20]]));
check('persistent names did not survive exact topology change', changedResolved.resolvedValue === 30
  && changedResolved.displayText === '30 mm'
  && JSON.stringify(changedResolved.anchors) === JSON.stringify([[-20, 0], [-20, -30]])
  && JSON.stringify(changedResolved.references) === JSON.stringify(resolved.references)
  && changedExact!.bodies[0].topology.counts.faces > exact!.bodies[0].topology.counts.faces
  && changedExact!.bodies[0].topology.counts.edges > exact!.bodies[0].topology.counts.edges);
check('placed dimension text did not render', Buffer.from(firstPdf.bytes).toString('latin1').includes('(20 mm)')
  && Buffer.from(changedPdf.bytes).toString('latin1').includes('(30 mm)'));

expectCode('missing body reference', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'associative-dimension', sheetId: 'sheet-000001', viewId: 'front', dimensionType: 'distance',
  references: references!.map((entry) => ({ ...entry, bodyId: 'body-missing' })), labelMm: [58, 48],
}), 'DRAWING_ANNOTATION_REFERENCE_MISSING');
expectCode('duplicate topology reference', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'associative-dimension', sheetId: 'sheet-000001', viewId: 'front', dimensionType: 'distance',
  references: [references![0], references![0]], labelMm: [58, 48],
}), 'DRAWING_ANNOTATION_INPUT_INVALID');
const missingNameProject = annotations.createStudioDrawingAnnotation(project, {
  kind: 'associative-dimension', sheetId: 'sheet-000001', viewId: 'front', dimensionType: 'distance',
  references: [references![0], { ...references![1], name: 'vertex:missing' }], labelMm: [58, 48],
});
expectCode('missing persistent topology name', () => drawingPdf.createStudioDrawingBookPdf(
  { ...exact, manifest: { ...exact!.manifest, exactProjectionEvidence: { ...exact!.manifest.exactProjectionEvidence, documentHash: runtime.studioV5CanonicalHash(missingNameProject) } } },
  missingNameProject.name, book, null, missingNameProject.extensions.drawingAnnotations, null, missingNameProject,
), 'DRAWING_ANNOTATION_REFERENCE_STALE');
const topProject = annotations.updateStudioDrawingAnnotation(project, {
  annotationId: graph.annotations[0].id, patch: { viewId: 'top' },
});
expectCode('references collapsed in selected projection', () => drawingPdf.createStudioDrawingBookPdf(
  { ...exact, manifest: { ...exact!.manifest, exactProjectionEvidence: { ...exact!.manifest.exactProjectionEvidence, documentHash: runtime.studioV5CanonicalHash(topProject) } } },
  topProject.name, book, null, topProject.extensions.drawingAnnotations, null, topProject,
), 'DRAWING_ANNOTATION_REFERENCE_STALE');
expectCode('stale exact document revision', () => drawingPdf.createStudioDrawingBookPdf(
  exact!, changedProject!.name, book, null, changedProject!.extensions.drawingAnnotations, null, changedProject!,
), 'DRAWING_ANNOTATION_REFERENCE_STALE');
const ambiguous = structuredClone(exact!);
const firstReference = references![0]!;
ambiguous.bodies[0].topology.vertices.push(structuredClone(ambiguous.bodies[0].topology.vertices.find((entry: JsonRecord) => entry.name === firstReference.name)));
expectCode('ambiguous persistent topology name', () => drawingPdf.createStudioDrawingBookPdf(
  ambiguous, project.name, book, null, graph, null, project,
), 'DRAWING_ANNOTATION_REFERENCE_STALE');
expectCode('missing exact topology evidence', () => drawingPdf.createStudioDrawingBookPdf(
  { ...exact, bodies: exact!.bodies.map((entry: JsonRecord) => ({ ...entry, topology: null })) },
  project.name, book, null, graph, null, project,
), 'DRAWING_ANNOTATION_REFERENCE_STALE');

const [pageSource, studioSource, agentSource, registrySource, pdfSource, workerSource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-drawing-pdf.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8'),
]);
const uiIds = ['bw-drawing-associative-dimension', 'bw-drawing-associative-dimension-type',
  'bw-drawing-associative-dimension-view', 'bw-drawing-associative-dimension-capture',
  'bw-drawing-associative-dimension-references', 'bw-drawing-associative-dimension-label',
  'bw-drawing-associative-dimension-add', 'bw-drawing-associative-dimension-update',
  'bw-drawing-associative-dimension-delete'];
check('visible placed-dimension manager is incomplete', uiIds.every((id) => pageSource.includes(`id="${id}"`)));
check('visible manager does not capture selected persistent names', studioSource.includes('captureDrawingAssociativeDimensionSelections')
  && studioSource.includes('v6StoredTopologyReference(selection).name'));
check('typed agent does not admit placed dimensions', agentSource.includes("'associative-dimension'")
  && agentSource.includes("dimensionType: { enum: ['distance', 'horizontal', 'vertical'] }"));
check('typed UI registry omits placed-dimension lifecycle', registrySource.includes("'dialog.drawing-associative-dimension.capture'")
  && registrySource.includes("'dialog.drawing-associative-dimension.add'")
  && registrySource.includes("'dialog.drawing-associative-dimension.update'")
  && registrySource.includes("'dialog.drawing-associative-dimension.delete'"));
check('PDF renderer omits placed dimensions', pdfSource.includes("annotation.kind === 'associative-dimension'"));
check('drawing worker omits persistent topology evidence', workerSource.includes("'partmode.drawing-topology-evidence/v1'")
  && workerSource.includes('drawingTopologyEvidence(result.shape, result.names)'));

console.log(JSON.stringify({
  schema: graph.schema,
  dimensionType: resolved.dimensionType,
  persistentReferences: resolved.references.map((entry: JsonRecord) => ({ bodyId: entry.bodyId, topologyKind: entry.topologyKind, name: entry.name })),
  resolvedValuesMm: [resolved.resolvedValue, changedResolved.resolvedValue],
  exactTopologyCounts: [exact!.bodies[0].topology.counts, changedExact!.bodies[0].topology.counts],
  exactDrawings: 3,
  deterministicPdfBytes: firstPdf.bytes.length,
  typedLifecycle: ['create', 'update', 'delete'],
  saveReopen: 'preserved',
  failClosed: ['missing-body', 'duplicate-reference', 'missing-name', 'ambiguous-name', 'collapsed-view', 'missing-topology-evidence', 'stale-document-revision'],
  prohibitedFallbacks: ['proximity', 'hash', 'traversal-order'],
}, null, 2));
