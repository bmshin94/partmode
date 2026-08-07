import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Drawing GD&T smoke failed: ${label}`);
}

function expectCode(label: string, action: () => unknown, code: string): void {
  try { action(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Drawing GD&T smoke failed: ${label} did not fail`);
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
  projectId: 'project-drawing-gdt',
  name: 'GD&T reference drawing',
  units: 'mm',
  parameters: [],
  features: [{
    id: 'feature-gdt-plate', name: 'Datum plate', type: 'extrude',
    sketch: { shapes: [{ id: 'shape-gdt-plate', kind: 'rect', x: 0, y: 0, w: 100, h: 60 }], z: 0 },
    h: 10, through: false,
  }],

});
project = transact(project, 'initialize-gdt-sheet', [{
  kind: 'drawing.book.initialize',
  input: { title: 'GD&T reference', templateId: 'iso-a3-landscape', name: 'Inspection', scale: 'fit', views: ['front', 'top'] },
}]).project;
const body = runtime.studioV5ActiveBody(project);
check('fixture has no active exact body', body?.id);

let kernel: HeadlessKernel | null = null;
let discovery: JsonRecord;
let exact: JsonRecord;
let references: JsonRecord[];
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  discovery = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-gdt-discovery', projectId: project.projectId, revision: 1,
    document: project, views: ['front', 'top'],
  }, 180_000) as JsonRecord;
  check(`exact topology discovery failed: ${JSON.stringify(discovery.errors || [])}`, discovery.kind === 'drawing-result'
    && discovery.errors?.length === 0 && discovery.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');
  const topology = discovery.bodies?.[0]?.topology;
  const exactFaces = topology?.faces?.filter((entry: JsonRecord) => entry?.name && Array.isArray(entry?.point)) || [];
  check('drawing worker omitted two persistent exact faces', topology?.schema === 'partmode.drawing-topology-evidence/v1'
    && topology.counts?.namedFaces === topology.counts?.faces && exactFaces.length >= 2);
  references = exactFaces.slice(0, 2).map((entry: JsonRecord) => ({ bodyId: body.id, topologyKind: 'face', name: entry.name }));

  const created = transact(project, 'create-gdt-records', [
    { kind: 'drawing.annotation.create', input: {
      kind: 'datum-symbol', sheetId: 'sheet-000001', viewId: 'top', identifier: 'A',
      reference: references[0], labelMm: [44, 42],
    } },
    { kind: 'drawing.annotation.create', input: {
      kind: 'datum-symbol', sheetId: 'sheet-000001', viewId: 'top', identifier: 'B',
      reference: references[1], labelMm: [44, 54],
    } },
    { kind: 'drawing.annotation.create', input: {
      kind: 'feature-control-frame', sheetId: 'sheet-000001', viewId: 'top', reference: references[0],
      characteristic: 'position', toleranceMm: 0.1, diameterZone: true, materialCondition: 'maximum',
      datumIds: ['annotation-000001', 'annotation-000002'], labelMm: [74, 66],
    } },
    { kind: 'drawing.annotation.create', input: {
      kind: 'tolerance-stack', sheetId: 'sheet-000001', name: 'Axial stack', positionMm: [20, 205],
      entries: [
        { label: 'Housing', nominalMm: 100, plusMm: 0.2, minusMm: 0.1, direction: 1 },
        { label: 'Spacer', nominalMm: 20, plusMm: 0.05, minusMm: 0.05, direction: -1 },
        { label: 'Plate', nominalMm: 10, plusMm: 0.1, minusMm: 0.1, direction: 1 },
      ],
    } },
  ]);
  check('typed create did not report all four GD&T records', created.changeSet.created.filter((entry: JsonRecord) => entry.kind === 'drawing-annotation').length === 4);
  project = created.project;

  project = transact(project, 'create-temporary-gdt-stack', [{ kind: 'drawing.annotation.create', input: {
    kind: 'tolerance-stack', sheetId: 'sheet-000001', name: 'Temporary stack', positionMm: [150, 205],
    entries: [
      { label: 'First', nominalMm: 5, plusMm: 0.1, minusMm: 0.1, direction: 1 },
      { label: 'Second', nominalMm: 2, plusMm: 0.1, minusMm: 0.1, direction: -1 },
    ],
  } }]).project;
  const temporaryId = annotations.inspectStudioDrawingAnnotations(project).annotations.at(-1).id;
  project = transact(project, 'update-temporary-gdt-stack', [{
    kind: 'drawing.annotation.update', input: { annotationId: temporaryId, patch: { name: 'Updated temporary stack', positionMm: [152, 205] } },
  }]).project;
  check('typed GD&T update did not persist', annotations.inspectStudioDrawingAnnotations(project).annotations.at(-1).name === 'Updated temporary stack');
  project = transact(project, 'delete-temporary-gdt-stack', [{
    kind: 'drawing.annotation.delete', input: { annotationId: temporaryId },
  }]).project;

  const canonical = JSON.stringify(projectModule.prepareStudioV5Project(project));
  project = projectModule.parseStudioV5Project(canonical);
  check('GD&T graph changed across canonical save/reopen', JSON.stringify(project) === canonical);
  exact = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-gdt-exact', projectId: project.projectId, revision: 2,
    document: project, views: ['front', 'top'],
  }, 180_000) as JsonRecord;
  check(`exact GD&T drawing failed: ${JSON.stringify(exact.errors || [])}`, exact.kind === 'drawing-result'
    && exact.errors?.length === 0 && exact.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');
} finally { await kernel?.dispose(); }

const graph = annotations.inspectStudioDrawingAnnotations(project);
check('persistent GD&T graph is incomplete', graph.annotations.length === 4
  && graph.annotations.filter((entry: JsonRecord) => entry.kind === 'datum-symbol').length === 2
  && graph.annotations.some((entry: JsonRecord) => entry.kind === 'feature-control-frame')
  && graph.annotations.some((entry: JsonRecord) => entry.kind === 'tolerance-stack'));
const book = drawingBook.inspectStudioDrawingBook(project);
const firstPdf = drawingPdf.createStudioDrawingBookPdf(exact!, project.name, book, null, graph, null, project);
const repeatedPdf = drawingPdf.createStudioDrawingBookPdf(exact!, project.name, book, null, graph, null, project);
check('GD&T PDF is not deterministic', Buffer.compare(Buffer.from(firstPdf.bytes), Buffer.from(repeatedPdf.bytes)) === 0);
const resolved = firstPdf.manifest.pages[0].drawingAnnotations.annotations;
const datumA = resolved.find((entry: JsonRecord) => entry.kind === 'datum-symbol' && entry.identifier === 'A');
const datumB = resolved.find((entry: JsonRecord) => entry.kind === 'datum-symbol' && entry.identifier === 'B');
const frame = resolved.find((entry: JsonRecord) => entry.kind === 'feature-control-frame');
const stack = resolved.find((entry: JsonRecord) => entry.kind === 'tolerance-stack');
check('datum A lacks current exact topology evidence', datumA?.sourceEvidence?.kind === 'exact-persistent-topology-datum'
  && datumA.sourceEvidence.reference.name === references!.at(0)?.name && Array.isArray(datumA.anchor));
check('datum B lacks current exact topology evidence', datumB?.sourceEvidence?.kind === 'exact-persistent-topology-datum'
  && datumB.sourceEvidence.reference.name === references!.at(1)?.name && Array.isArray(datumB.anchor));
check('feature-control frame resolution is incomplete', frame?.sourceEvidence?.kind === 'exact-persistent-topology-feature-control-frame'
  && frame.characteristic === 'position' && frame.toleranceMm === 0.1 && frame.diameterZone === true
  && frame.materialCondition === 'maximum' && JSON.stringify(frame.datumIdentifiers) === JSON.stringify(['A', 'B']));
check('controlled tolerance-stack result is incorrect', stack?.sourceEvidence?.kind === 'controlled-worst-case-tolerance-stack'
  && stack.nominalMm === 90 && stack.minimumMm === 89.75 && stack.maximumMm === 90.35
  && stack.worstCaseMinusMm === 0.25 && stack.worstCasePlusMm === 0.35 && stack.rssMm === 0.229128785);
const pdfText = Buffer.from(firstPdf.bytes).toString('latin1');
check('datum and feature-control-frame graphics did not render', pdfText.includes('(POS)')
  && pdfText.includes('(DIA 0.1 M)') && pdfText.includes('(A)') && pdfText.includes('(B)'));
check('controlled tolerance-stack results did not render', pdfText.includes('(WC 90 +0.35/-0.25 mm)')
  && pdfText.includes('RSS 0.229128785'));

expectCode('duplicate datum identifier', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'datum-symbol', sheetId: 'sheet-000001', viewId: 'top', identifier: 'A', reference: references![0], labelMm: [50, 50],
}), 'DRAWING_GDT_DATUM_DUPLICATE');
expectCode('reserved datum identifier', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'datum-symbol', sheetId: 'sheet-000001', viewId: 'top', identifier: 'I', reference: references![0], labelMm: [50, 50],
}), 'DRAWING_ANNOTATION_INPUT_INVALID');
expectCode('missing frame datum', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'feature-control-frame', sheetId: 'sheet-000001', viewId: 'top', reference: references![0],
  characteristic: 'flatness', toleranceMm: 0.05, materialCondition: 'none', datumIds: ['annotation-999999'], labelMm: [50, 50],
}), 'DRAWING_GDT_DATUM_MISSING');
expectCode('delete datum in use', () => annotations.deleteStudioDrawingAnnotation(project, 'annotation-000001'), 'DRAWING_GDT_DATUM_MISSING');
expectCode('missing datum body', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'datum-symbol', sheetId: 'sheet-000001', viewId: 'top', identifier: 'C',
  reference: { ...references![0], bodyId: 'body-missing' }, labelMm: [50, 50],
}), 'DRAWING_ANNOTATION_REFERENCE_MISSING');
expectCode('invalid tolerance-stack direction', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'tolerance-stack', sheetId: 'sheet-000001', name: 'Invalid stack', positionMm: [150, 150],
  entries: [
    { label: 'First', nominalMm: 5, plusMm: 0.1, minusMm: 0.1, direction: 0 },
    { label: 'Second', nominalMm: 2, plusMm: 0.1, minusMm: 0.1, direction: 1 },
  ],
}), 'DRAWING_ANNOTATION_INPUT_INVALID');
expectCode('negative frame tolerance', () => annotations.createStudioDrawingAnnotation(project, {
  kind: 'feature-control-frame', sheetId: 'sheet-000001', viewId: 'top', reference: references![0],
  characteristic: 'position', toleranceMm: -0.1, materialCondition: 'none', datumIds: [], labelMm: [50, 50],
}), 'DRAWING_ANNOTATION_INPUT_INVALID');

const missingNameProject = annotations.updateStudioDrawingAnnotation(project, {
  annotationId: 'annotation-000003', patch: { reference: { ...references![0], name: 'face:missing' } },
});
expectCode('missing persistent topology name', () => drawingPdf.createStudioDrawingBookPdf(
  { ...exact, manifest: { ...exact!.manifest, exactProjectionEvidence: { ...exact!.manifest.exactProjectionEvidence, documentHash: runtime.studioV5CanonicalHash(missingNameProject) } } },
  missingNameProject.name, book, null, missingNameProject.extensions.drawingAnnotations, null, missingNameProject,
), 'DRAWING_ANNOTATION_REFERENCE_STALE');
const changedProject = transact(project, 'change-gdt-source-model', [{
  kind: 'feature.update', input: { featureId: 'feature-gdt-plate', patch: { h: 12 } },
}]).project;
expectCode('stale exact document revision', () => drawingPdf.createStudioDrawingBookPdf(
  exact!, changedProject.name, book, null, changedProject.extensions.drawingAnnotations, null, changedProject,
), 'DRAWING_ANNOTATION_REFERENCE_STALE');
const overflowProject = annotations.createStudioDrawingAnnotation(project, {
  kind: 'tolerance-stack', sheetId: 'sheet-000001', name: 'Overflow stack', positionMm: [315, 260],
  entries: [
    { label: 'First', nominalMm: 5, plusMm: 0.1, minusMm: 0.1, direction: 1 },
    { label: 'Second', nominalMm: 2, plusMm: 0.1, minusMm: 0.1, direction: -1 },
  ],
});
expectCode('unsafe tolerance-stack layout', () => drawingPdf.createStudioDrawingBookPdf(
  { ...exact, manifest: { ...exact!.manifest, exactProjectionEvidence: { ...exact!.manifest.exactProjectionEvidence, documentHash: runtime.studioV5CanonicalHash(overflowProject) } } },
  overflowProject.name, book, null, overflowProject.extensions.drawingAnnotations, null, overflowProject,
), 'DRAWING_GDT_DOES_NOT_FIT');

const [pageSource, studioSource, agentSource, registrySource, pdfSource, workerSource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-drawing-pdf.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8'),
]);
const uiIds = ['bw-drawing-gdt', 'bw-drawing-gdt-kind', 'bw-drawing-gdt-view', 'bw-drawing-gdt-capture',
  'bw-drawing-gdt-reference', 'bw-drawing-gdt-name', 'bw-drawing-gdt-label', 'bw-drawing-gdt-characteristic',
  'bw-drawing-gdt-tolerance', 'bw-drawing-gdt-diameter', 'bw-drawing-gdt-material', 'bw-drawing-gdt-datums',
  'bw-drawing-gdt-stack', 'bw-drawing-gdt-add', 'bw-drawing-gdt-update', 'bw-drawing-gdt-delete'];
check('visible GD&T manager is incomplete', uiIds.every((id) => pageSource.includes(`id="${id}"`)));
check('visible manager does not route persistent selection and typed lifecycle', studioSource.includes('captureDrawingGdtSelection')
  && studioSource.includes('v6StoredTopologyReference(selection).name') && studioSource.includes('authoredDrawingGdt'));
check('typed agent omits GD&T contracts', agentSource.includes("'datum-symbol'") && agentSource.includes("'feature-control-frame'")
  && agentSource.includes("'tolerance-stack'") && agentSource.includes('materialCondition'));
check('typed UI registry omits GD&T lifecycle', registrySource.includes("'dialog.drawing-gdt.capture'")
  && registrySource.includes("'dialog.drawing-gdt.add'") && registrySource.includes("'dialog.drawing-gdt.update'")
  && registrySource.includes("'dialog.drawing-gdt.delete'"));
check('PDF renderer omits GD&T records', pdfSource.includes("annotation.kind === 'datum-symbol'")
  && pdfSource.includes("annotation.kind === 'feature-control-frame'") && pdfSource.includes("annotation.kind === 'tolerance-stack'"));
check('drawing worker omits exact persistent topology evidence', workerSource.includes("'partmode.drawing-topology-evidence/v1'"));

console.log(JSON.stringify({
  schema: graph.schema,
  records: graph.annotations.map((entry: JsonRecord) => ({ id: entry.id, kind: entry.kind })),
  exactTopologyReferences: references!,
  frame: { characteristic: frame.characteristic, toleranceMm: frame.toleranceMm, diameterZone: frame.diameterZone, materialCondition: frame.materialCondition, datums: frame.datumIdentifiers },
  toleranceStack: { nominalMm: stack.nominalMm, minimumMm: stack.minimumMm, maximumMm: stack.maximumMm, worstCaseMinusMm: stack.worstCaseMinusMm, worstCasePlusMm: stack.worstCasePlusMm, rssMm: stack.rssMm },
  deterministicPdfBytes: firstPdf.bytes.length,
  typedLifecycle: ['create', 'update', 'delete'],
  saveReopen: 'preserved',
  failClosed: ['duplicate-datum', 'reserved-datum', 'missing-datum', 'datum-in-use', 'missing-body', 'invalid-direction', 'negative-tolerance', 'missing-topology-name', 'stale-document-revision', 'unsafe-layout'],
  boundary: 'controlled ASME Y14.5 reference vocabulary; no standards-certification claim',
}, null, 2));
