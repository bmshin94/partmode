import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

const DERIVED_EVIDENCE_SCHEMA = 'partmode.drawing-derived-view-evidence/v1';
const DERIVED_KINDS = [
  'full-section', 'half-section', 'aligned-section', 'broken-out-section',
  'detail', 'auxiliary', 'crop', 'break',
] as const;
const SECTION_KINDS = new Set(['full-section', 'half-section', 'aligned-section', 'broken-out-section']);
const EDGE_CLASSES = [
  'visible', 'hidden', 'regularVisible', 'regularHidden', 'tangentVisible', 'tangentHidden',
] as const;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Drawing derived views smoke failed: ${label}`);
}

function expectCode(label: string, action: () => unknown, code: string): void {
  try { action(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Drawing derived views smoke failed: ${label} did not fail`);
}

function operationVolume(evidence: JsonRecord): { before: number; after: number } | null {
  if (Number.isFinite(Number(evidence.exact?.source?.volumeMm3)) && Number.isFinite(Number(evidence.exact?.result?.volumeMm3))) {
    return { before: Number(evidence.exact.source.volumeMm3), after: Number(evidence.exact.result.volumeMm3) };
  }
  const source = evidence.exact?.volume || evidence.exact?.volumes || evidence.exact
    || evidence.volume || evidence.volumes || evidence.geometry?.volume || null;
  const before = Number(source?.before ?? source?.source ?? source?.sourceVolume);
  const after = Number(source?.after ?? source?.result ?? source?.resultVolume);
  return Number.isFinite(before) && Number.isFinite(after) ? { before, after } : null;
}

function validShapeEvidence(value: JsonRecord): boolean {
  return value?.brepValid === true && Number.isInteger(value.solidCount) && value.solidCount > 0
    && Number.isInteger(value.faceCount) && value.faceCount > 0
    && Number.isInteger(value.edgeCount) && value.edgeCount > 0
    && Number.isFinite(Number(value.volumeMm3)) && Number(value.volumeMm3) > 0
    && Array.isArray(value.bounds) && value.bounds.length === 2;
}

function sameShapeEvidence(left: JsonRecord, right: JsonRecord): boolean {
  return validShapeEvidence(left) && validShapeEvidence(right) && stableSource(left) === stableSource(right);
}

function sameNumberTuple(left: unknown, right: unknown, tolerance = 1e-7): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((entry, index) => Number.isFinite(Number(entry)) && Number.isFinite(Number(right[index]))
      && Math.abs(Number(entry) - Number(right[index])) <= tolerance * Math.max(1, Math.abs(Number(entry)), Math.abs(Number(right[index]))));
}

function stableSource(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(stableSource).join(',')}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSource(record[key])}`).join(',')}}`;
}

function stableHash(value: unknown): string {
  const source = stableSource(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function rebindManifestEvidenceHash(response: JsonRecord, viewId: string): void {
  const view = response.views.find((entry: JsonRecord) => entry.view === viewId);
  const binding = response.manifest.exactProjectionEvidence.derivedViews
    .find((entry: JsonRecord) => entry.view === viewId);
  check(`cannot rebind missing derived evidence ${viewId}`, view?.derivedEvidence && binding);
  binding.evidenceHash = stableHash(view.derivedEvidence);
}

function validPathEvidenceRecord(value: JsonRecord): boolean {
  return value && Number.isInteger(value.pathCount) && value.pathCount > 0
    && typeof value.pathHash === 'string' && value.pathHash.length > 0
    && Array.isArray(value.viewBox) && value.viewBox.length === 4
    && EDGE_CLASSES.every((key) => Number.isInteger(value.edgeClasses?.[key]?.pathCount)
      && typeof value.edgeClasses?.[key]?.pathHash === 'string')
    && EDGE_CLASSES.reduce((sum, key) => sum + Number(value.edgeClasses?.[key]?.pathCount || 0), 0) === value.pathCount;
}

function validPathEvidence(value: JsonRecord, payload: JsonRecord): boolean {
  const paths = Object.fromEntries(EDGE_CLASSES.map((key) => [key, Array.isArray(payload?.[key]) ? payload[key].map(String) : []]));
  const ordered = EDGE_CLASSES.flatMap((key) => paths[key]);
  return validPathEvidenceRecord(value) && value.pathCount === ordered.length && value.pathHash === stableHash(ordered)
    && Array.isArray(value.viewBox) && stableSource(value.viewBox) === stableSource(payload.viewBox.map((entry: number) => Math.round(entry * 1e9) / 1e9))
    && EDGE_CLASSES.every((key) => {
      const classPaths = paths[key] || [];
      return value.edgeClasses?.[key]?.pathCount === classPaths.length
        && value.edgeClasses?.[key]?.pathHash === stableHash(classPaths);
    });
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const [runtime, agent, viewTools, bookTools, pdfTools, projectModule] = await Promise.all([
  moduleAt('src/static/studio-v5-runtime-document.js'),
  moduleAt('src/static/studio-agent-service.js'),
  moduleAt('src/static/studio-drawing-views.js'),
  moduleAt('src/static/studio-drawing-book.js'),
  moduleAt('src/static/studio-drawing-pdf.js'),
  moduleAt('src/static/studio-project-v5.js'),
]);

const source = runtime.canonicalStudioV5Project(JSON.parse(
  await readFile(resolve(root, 'tests/cad-corpus/fillet-shell.partmode.json'), 'utf8'),
));
const sourceJson = JSON.stringify(source);
const transact = (project: JsonRecord, id: string, operations: JsonRecord[]) => agent.applyCadTransaction(project, {
  transactionId: id,
  label: id,
  expectedRevision: 0,
  atomic: true,
  operations,
}, 0);

let kernel: HeadlessKernel | null = null;
let discovery: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  discovery = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-derived-discovery', projectId: source.projectId,
    revision: 1, document: source, views: ['front'],
  }, 180_000) as JsonRecord;
} catch (error) {
  await kernel?.dispose();
  throw error;
}
check(`exact topology discovery failed ${JSON.stringify(discovery!.errors || [])}`, discovery!.kind === 'drawing-result'
  && discovery!.errors?.length === 0 && discovery!.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');
check('topology discovery mutated its source document', JSON.stringify(source) === sourceJson);
const activeBody = runtime.studioV5ActiveBody(source);
const activeEvidence = discovery!.bodies?.find((entry: JsonRecord) => entry.bodyId === activeBody?.id) || discovery!.bodies?.[0];
const planarFace = activeEvidence?.topology?.faces?.find((entry: JsonRecord) => entry.geomType === 'PLANE' && entry.name
  && Array.isArray(entry.sig?.n) && Math.abs(Number(entry.sig.n[2])) > 0.9);
check('fixture has no persistent non-front planar face for an exact auxiliary view', activeBody?.id && planarFace?.name);
const auxiliaryReference = { bodyId: activeBody.id, faceName: planarFace.name };
const auxiliaryNormal = planarFace.sig.n.map(Number);

const transverse = { origin: [0, 0, 7], normal: [0, -1, 0], xAxis: [1, 0, 0], keepSide: 'positive' };
const longitudinal = { origin: [-30, 0, 7], normal: [1, 0, 0], xAxis: [0, 1, 0], keepSide: 'positive' };
const alignedReference = { ...transverse, origin: [45, 0, 7], xAxis: [-1, 0, 0] };
const angled = { origin: [-30, 0, 7], normal: [1, -1, 0], xAxis: [-1, -1, 0], keepSide: 'positive' };
const definitions: Record<(typeof DERIVED_KINDS)[number], JsonRecord> = {
  'full-section': { planes: [longitudinal], hatchAngleDeg: 45 },
  'half-section': { planes: [transverse, longitudinal], half: { axis: 'x', side: 'positive', at: -30 }, hatchAngleDeg: 45 },
  'aligned-section': { planes: [alignedReference, angled], hatchAngleDeg: 30 },
  'broken-out-section': {
    boundary: { kind: 'circle', x: -30, y: 7, radius: 6 }, depthMm: 6, hatchAngleDeg: 45,
  },
  detail: { boundary: { kind: 'circle', x: -30, y: 7, radius: 9 }, magnification: 2 },
  auxiliary: { reference: auxiliaryReference, xAxis: [1, 0, 0] },
  crop: { boundary: { kind: 'rect', x: -43, y: -1, width: 27, height: 16 } },
  break: { axis: 'x', start: -34, end: -26, gapMm: 4 },
};

const created = transact(source, 'create-derived-drawing-views', DERIVED_KINDS.map((kind) => ({
  kind: 'drawing.derivedView.create',
  input: { name: `DR003 ${kind}`, kind, sourceViewId: 'front', definition: definitions[kind] },
})));
check('typed transaction did not report all eight derived-view entities', created.changeSet.created
  .filter((entry: JsonRecord) => entry.kind === 'drawing-derived-view').length === DERIVED_KINDS.length);
let project = created.project;
let graph = viewTools.inspectStudioDrawingViews(project);
check('persistent derived-view graph is incomplete', graph.schema === 'partmode.drawing-views/v1'
  && graph.derivedViews.length === DERIVED_KINDS.length
  && JSON.stringify(graph.derivedViews.map((entry: JsonRecord) => entry.kind)) === JSON.stringify(DERIVED_KINDS));
const graphByKind = new Map<string, JsonRecord>(graph.derivedViews.map((entry: JsonRecord) => [entry.kind, entry]));
check('section retained sides or half-plane count were not persisted', graphByKind.get('full-section')?.definition?.planes?.[0]?.keepSide === 'positive'
  && graphByKind.get('half-section')?.definition?.planes?.length === 2
  && graphByKind.get('half-section')?.definition?.planes?.every((entry: JsonRecord) => entry.keepSide === 'positive'));
check('broken-out boundary/depth contract was not persisted', graphByKind.get('broken-out-section')?.definition?.depthMm === 6
  && graphByKind.get('broken-out-section')?.definition?.boundary?.kind === 'circle'
  && graphByKind.get('broken-out-section')?.definition?.planes == null);
check('auxiliary persistent planar-face reference was not persisted', JSON.stringify(graphByKind.get('auxiliary')?.definition?.reference) === JSON.stringify(auxiliaryReference)
  && JSON.stringify(graphByKind.get('auxiliary')?.definition?.xAxis) === JSON.stringify([1, 0, 0]));

const detailId = graph.derivedViews.find((entry: JsonRecord) => entry.kind === 'detail').id;
project = transact(project, 'update-derived-detail-view', [{
  kind: 'drawing.derivedView.update', input: {
    viewId: detailId,
    patch: { name: 'DR003 detail enlarged', definition: { ...definitions.detail, magnification: 2.25 } },
  },
}]).project;
check('typed derived-view update did not persist', viewTools.inspectStudioDrawingViews(project).derivedViews
  .find((entry: JsonRecord) => entry.id === detailId)?.definition?.magnification === 2.25);

project = transact(project, 'initialize-derived-drawing-book', [{
  kind: 'drawing.book.initialize', input: {
    title: 'DR003 exact derived views', name: 'Derived views', templateId: 'iso-a2-landscape', scale: 'fit',
    views: viewTools.inspectStudioDrawingViews(project).derivedViews.map((entry: JsonRecord) => entry.id),
  },
}]).project;
const book = bookTools.inspectStudioDrawingBook(project);
check('drawing book did not persist all eight derived views', book.sheets.length === 1
  && book.sheets[0].views.length === DERIVED_KINDS.length);

const temporarySource = transact(project, 'create-temporary-derived-source', [
  { kind: 'drawing.view.create', input: { name: 'Temporary source', direction: [-1, -2, -1], xAxis: [1, -0.5, 0] } },
]);
project = temporarySource.project;
const temporarySourceId = temporarySource.changeSet.created.find((entry: JsonRecord) => entry.kind === 'drawing-view')?.id;
check('typed named-view creation returned no persistent source id', temporarySourceId);
project = transact(project, 'create-temporary-derived-child', [{
  kind: 'drawing.derivedView.create', input: {
    name: 'Temporary crop', kind: 'crop', sourceViewId: temporarySourceId,
    definition: { boundary: { kind: 'rect', x: -10, y: -10, width: 20, height: 20 } },
  },
}]).project;
graph = viewTools.inspectStudioDrawingViews(project);
const temporaryDerivedId = graph.derivedViews.find((entry: JsonRecord) => entry.name === 'Temporary crop').id;
expectCode('delete persistent source view in use', () => viewTools.deleteStudioNamedDrawingView(project, temporarySourceId), 'DRAWING_VIEW_IN_USE');
project = transact(project, 'delete-temporary-derived-source', [
  { kind: 'drawing.derivedView.delete', input: { viewId: temporaryDerivedId } },
  { kind: 'drawing.view.delete', input: { viewId: temporarySourceId } },
]).project;
check('typed derived-view deletion did not persist', viewTools.inspectStudioDrawingViews(project).derivedViews.length === DERIVED_KINDS.length
  && viewTools.inspectStudioDrawingViews(project).views.length === 0);

const canonical = JSON.stringify(projectModule.prepareStudioV5Project(project));
project = projectModule.parseStudioV5Project(canonical);
check('derived drawing views changed across canonical save/reopen', JSON.stringify(project) === canonical);
const currentDocumentHash = runtime.studioV5CanonicalHash(project);
graph = viewTools.inspectStudioDrawingViews(project);
const requestedViewIds = bookTools.requiredStudioDrawingBookViews(project);
const viewRequests = viewTools.resolveStudioDrawingViewRequests(project, requestedViewIds);
check('persistent records did not resolve to all eight derived worker requests', viewRequests.length === DERIVED_KINDS.length
  && viewRequests.every((entry: JsonRecord) => entry.derived?.kind && entry.derived?.sourceViewId === 'front'));
const auxiliaryId = graph.derivedViews.find((entry: JsonRecord) => entry.kind === 'auxiliary').id;
const fullId = graph.derivedViews.find((entry: JsonRecord) => entry.kind === 'full-section').id;
const halfId = graph.derivedViews.find((entry: JsonRecord) => entry.kind === 'half-section').id;
const alignedId = graph.derivedViews.find((entry: JsonRecord) => entry.kind === 'aligned-section').id;
const brokenOutId = graph.derivedViews.find((entry: JsonRecord) => entry.kind === 'broken-out-section').id;
const cropId = graph.derivedViews.find((entry: JsonRecord) => entry.kind === 'crop').id;
const invalidReferenceProject = viewTools.updateStudioDerivedDrawingView(project, {
  viewId: auxiliaryId,
  patch: { definition: { ...definitions.auxiliary, reference: { ...auxiliaryReference, faceName: 'face:missing' } } },
});
const invalidReferenceRequests = viewTools.resolveStudioDrawingViewRequests(invalidReferenceProject, requestedViewIds);
const baseHalfDefinition = structuredClone(graph.derivedViews.find((entry: JsonRecord) => entry.id === halfId).definition);
const mismatchedHalfProject = viewTools.updateStudioDerivedDrawingView(project, {
  viewId: halfId,
  patch: { definition: { ...baseHalfDefinition, half: { ...baseHalfDefinition.half, at: baseHalfDefinition.half.at + 1 } } },
});
const negativeHalfProject = viewTools.updateStudioDerivedDrawingView(project, {
  viewId: halfId,
  patch: { definition: {
    ...baseHalfDefinition,
    planes: [baseHalfDefinition.planes[0], { ...baseHalfDefinition.planes[1], keepSide: 'negative' }],
    half: { ...baseHalfDefinition.half, side: 'negative' },
  } },
});
const verticalHalfProject = viewTools.updateStudioDerivedDrawingView(project, {
  viewId: halfId,
  patch: { definition: {
    ...baseHalfDefinition,
    planes: [baseHalfDefinition.planes[0], {
      origin: [0, 0, 7], normal: [0, 0, 1], xAxis: [1, 0, 0], keepSide: 'positive',
    }],
    half: { axis: 'y', side: 'positive', at: 7 },
  } },
});
const baseAlignedDefinition = structuredClone(graph.derivedViews.find((entry: JsonRecord) => entry.id === alignedId).definition);
const alignedVariantProject = viewTools.updateStudioDerivedDrawingView(project, {
  viewId: alignedId,
  patch: { definition: {
    ...baseAlignedDefinition,
    planes: [baseAlignedDefinition.planes[0], {
      origin: [-28, 0, 7], normal: [1, -2, 0], xAxis: [-2, -1, 0], keepSide: 'positive',
    }],
  } },
});
const baseBrokenOutDefinition = structuredClone(graph.derivedViews.find((entry: JsonRecord) => entry.id === brokenOutId).definition);
const brokenOutDepthVariantProject = viewTools.updateStudioDerivedDrawingView(project, {
  viewId: brokenOutId,
  patch: { definition: { ...baseBrokenOutDefinition, depthMm: baseBrokenOutDefinition.depthMm + 2 } },
});
const nonIntersectingBrokenOutProject = viewTools.updateStudioDerivedDrawingView(project, {
  viewId: brokenOutId,
  patch: { definition: {
    ...baseBrokenOutDefinition,
    boundary: { kind: 'rect', x: 100_000, y: 100_000, width: 10, height: 10 },
  } },
});
const forgedFrameRequests = viewRequests.map((entry: JsonRecord) => entry.id === cropId
  ? { ...entry, standard: 'top', direction: null, xAxis: null }
  : entry);

expectCode('missing derived source reference', () => viewTools.createStudioDerivedDrawingView(project, {
  name: 'Missing source', kind: 'crop', sourceViewId: 'drawing-view-999999', definition: definitions.crop,
}), 'DRAWING_VIEW_NOT_FOUND');
expectCode('empty full-section plane definition', () => viewTools.createStudioDerivedDrawingView(project, {
  name: 'Empty section', kind: 'full-section', sourceViewId: 'front', definition: { planes: [] },
}), 'DRAWING_VIEW_INPUT_INVALID');
expectCode('parallel aligned-section plane chain', () => viewTools.createStudioDerivedDrawingView(project, {
  name: 'Parallel aligned section', kind: 'aligned-section', sourceViewId: 'front',
  definition: { planes: [transverse, { ...transverse, origin: [30, 0, 7] }] },
}), 'DRAWING_VIEW_INPUT_INVALID');
expectCode('misaligned aligned-section hinge axis', () => viewTools.createStudioDerivedDrawingView(project, {
  name: 'Misaligned hinge section', kind: 'aligned-section', sourceViewId: 'front',
  definition: { planes: [transverse, {
    origin: [30, 0, 7], normal: [0, 0, 1], xAxis: [-1, 0, 0], keepSide: 'positive',
  }] },
}), 'DRAWING_VIEW_INPUT_INVALID');
expectCode('invalid crop boundary', () => viewTools.createStudioDerivedDrawingView(project, {
  name: 'Invalid crop', kind: 'crop', sourceViewId: 'front', definition: { boundary: { kind: 'rect', x: 0, y: 0, width: 0, height: 10 } },
}), 'DRAWING_VIEW_INPUT_INVALID');
expectCode('invalid auxiliary persistent reference', () => viewTools.createStudioDerivedDrawingView(project, {
  name: 'Invalid auxiliary', kind: 'auxiliary', sourceViewId: 'front',
  definition: { reference: { bodyId: '', faceName: '' }, xAxis: [1, 0, 0] },
}), 'DRAWING_VIEW_INPUT_INVALID');
expectCode('delete sheet-owned derived view', () => viewTools.deleteStudioDerivedDrawingView(project, requestedViewIds[0]), 'DRAWING_VIEW_IN_USE');

let exact: JsonRecord;
let exactRepeat: JsonRecord;
let invalidReference: JsonRecord;
let forgedFrame: JsonRecord;
let mismatchedHalf: JsonRecord;
let negativeHalf: JsonRecord;
let verticalHalf: JsonRecord;
let alignedVariant: JsonRecord;
let brokenOutDepthVariant: JsonRecord;
let nonIntersectingBrokenOut: JsonRecord;
try {
  check('headless kernel was disposed before the exact derived request', kernel);
  exact = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-derived-exact', projectId: project.projectId,
    revision: 2, document: project, views: viewRequests,
  }, 240_000) as JsonRecord;
  invalidReference = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-derived-invalid-reference', projectId: project.projectId,
    revision: 3, document: invalidReferenceProject, views: invalidReferenceRequests,
  }, 240_000) as JsonRecord;
} finally { await kernel?.dispose(); }

let repeatKernel: HeadlessKernel | null = null;
try {
  repeatKernel = await createHeadlessKernel();
  await repeatKernel.waitForKernel();
  exactRepeat = await repeatKernel.request({
    kind: 'drawing-v5', requestId: 'drawing-derived-exact-repeat', projectId: project.projectId,
    revision: 4, document: project, views: viewRequests,
  }, 240_000) as JsonRecord;
  forgedFrame = await repeatKernel.request({
    kind: 'drawing-v5', requestId: 'drawing-derived-forged-frame', projectId: project.projectId,
    revision: 5, document: project, views: forgedFrameRequests,
  }, 240_000) as JsonRecord;
  mismatchedHalf = await repeatKernel.request({
    kind: 'drawing-v5', requestId: 'drawing-derived-half-mismatch', projectId: mismatchedHalfProject.projectId,
    revision: 6, document: mismatchedHalfProject,
    views: viewTools.resolveStudioDrawingViewRequests(mismatchedHalfProject, [halfId]),
  }, 240_000) as JsonRecord;
  negativeHalf = await repeatKernel.request({
    kind: 'drawing-v5', requestId: 'drawing-derived-half-negative', projectId: negativeHalfProject.projectId,
    revision: 7, document: negativeHalfProject,
    views: viewTools.resolveStudioDrawingViewRequests(negativeHalfProject, [halfId]),
  }, 240_000) as JsonRecord;
  verticalHalf = await repeatKernel.request({
    kind: 'drawing-v5', requestId: 'drawing-derived-half-vertical', projectId: verticalHalfProject.projectId,
    revision: 8, document: verticalHalfProject,
    views: viewTools.resolveStudioDrawingViewRequests(verticalHalfProject, [halfId]),
  }, 240_000) as JsonRecord;
  alignedVariant = await repeatKernel.request({
    kind: 'drawing-v5', requestId: 'drawing-derived-aligned-variant', projectId: alignedVariantProject.projectId,
    revision: 9, document: alignedVariantProject,
    views: viewTools.resolveStudioDrawingViewRequests(alignedVariantProject, [alignedId]),
  }, 240_000) as JsonRecord;
  brokenOutDepthVariant = await repeatKernel.request({
    kind: 'drawing-v5', requestId: 'drawing-derived-broken-out-depth-variant', projectId: brokenOutDepthVariantProject.projectId,
    revision: 10, document: brokenOutDepthVariantProject,
    views: viewTools.resolveStudioDrawingViewRequests(brokenOutDepthVariantProject, [brokenOutId]),
  }, 240_000) as JsonRecord;
  nonIntersectingBrokenOut = await repeatKernel.request({
    kind: 'drawing-v5', requestId: 'drawing-derived-broken-out-non-intersecting', projectId: nonIntersectingBrokenOutProject.projectId,
    revision: 11, document: nonIntersectingBrokenOutProject,
    views: viewTools.resolveStudioDrawingViewRequests(nonIntersectingBrokenOutProject, [brokenOutId]),
  }, 240_000) as JsonRecord;
} finally { await repeatKernel?.dispose(); }

let obliqueProject = viewTools.createStudioNamedDrawingView(source, {
  name: 'DR003 oblique broken-out source', direction: [1, 2, 1], xAxis: [1, -0.5, 0],
});
const obliqueViewId = viewTools.inspectStudioDrawingViews(obliqueProject).views[0].id;
let obliqueDiscovery: JsonRecord;
let obliqueBrokenOut: JsonRecord;
let obliqueDepthVariant: JsonRecord;
let obliqueBrokenOutId: string;
let obliqueDepthVariantProject: JsonRecord;
let obliqueKernel: HeadlessKernel | null = null;
try {
  obliqueKernel = await createHeadlessKernel();
  await obliqueKernel.waitForKernel();
  obliqueDiscovery = await obliqueKernel.request({
    kind: 'drawing-v5', requestId: 'drawing-derived-oblique-discovery', projectId: obliqueProject.projectId,
    revision: 10, document: obliqueProject,
    views: viewTools.resolveStudioDrawingViewRequests(obliqueProject, [obliqueViewId]),
  }, 240_000) as JsonRecord;
  check(`oblique exact source discovery failed ${JSON.stringify(obliqueDiscovery!.errors || [])}`,
    obliqueDiscovery!.errors?.length === 0 && obliqueDiscovery!.views?.length === 1);
  const obliqueBox = obliqueDiscovery!.views[0].viewBox.map(Number);
  const insetX = obliqueBox[2] * 0.05;
  const insetY = obliqueBox[3] * 0.05;
  const obliqueBoundary = {
    kind: 'rect',
    x: obliqueBox[0] + insetX,
    y: -obliqueBox[1] - obliqueBox[3] + insetY,
    width: obliqueBox[2] - insetX * 2,
    height: obliqueBox[3] - insetY * 2,
  };
  obliqueProject = viewTools.createStudioDerivedDrawingView(obliqueProject, {
    name: 'DR003 oblique exact-front broken out', kind: 'broken-out-section', sourceViewId: obliqueViewId,
    definition: { boundary: obliqueBoundary, depthMm: 4, hatchAngleDeg: 35 },
  });
  obliqueBrokenOutId = viewTools.inspectStudioDrawingViews(obliqueProject).derivedViews[0].id;
  obliqueProject = bookTools.initializeStudioDrawingBook(obliqueProject, {
    title: 'DR003 oblique broken-out validation', name: 'Oblique broken out', templateId: 'iso-a4-landscape',
    scale: 'fit', views: [obliqueBrokenOutId],
  });
  const obliqueDefinition = viewTools.inspectStudioDrawingViews(obliqueProject).derivedViews[0].definition;
  obliqueDepthVariantProject = viewTools.updateStudioDerivedDrawingView(obliqueProject, {
    viewId: obliqueBrokenOutId,
    patch: { definition: { ...obliqueDefinition, depthMm: obliqueDefinition.depthMm + 2 } },
  });
  obliqueBrokenOut = await obliqueKernel.request({
    kind: 'drawing-v5', requestId: 'drawing-derived-oblique-broken-out', projectId: obliqueProject.projectId,
    revision: 11, document: obliqueProject,
    views: viewTools.resolveStudioDrawingViewRequests(obliqueProject, [obliqueBrokenOutId]),
  }, 240_000) as JsonRecord;
  obliqueDepthVariant = await obliqueKernel.request({
    kind: 'drawing-v5', requestId: 'drawing-derived-oblique-broken-out-depth-variant',
    projectId: obliqueDepthVariantProject.projectId, revision: 12, document: obliqueDepthVariantProject,
    views: viewTools.resolveStudioDrawingViewRequests(obliqueDepthVariantProject, [obliqueBrokenOutId]),
  }, 240_000) as JsonRecord;
} finally { await obliqueKernel?.dispose(); }

check(`exact derived drawing failed ${JSON.stringify(exact!.errors || [])}`, exact!.kind === 'drawing-result'
  && exact!.errors?.length === 0 && exact!.views?.length === DERIVED_KINDS.length
  && exact!.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');
check('exact projection evidence is stale', exact!.manifest.exactProjectionEvidence.documentHash === currentDocumentHash);
check('worker accepted a missing persistent auxiliary face', invalidReference!.views === null && invalidReference!.errors?.length > 0);
check(`independent exact worker repeat failed ${JSON.stringify(exactRepeat!.errors || [])}`, exactRepeat!.errors?.length === 0
  && exactRepeat!.views?.length === DERIVED_KINDS.length
  && stableSource(exactRepeat!.views) === stableSource(exact!.views)
  && stableSource(exactRepeat!.manifest.exactProjectionEvidence) === stableSource(exact!.manifest.exactProjectionEvidence));
check('worker accepted a forged derived source camera', forgedFrame!.views === null && forgedFrame!.errors?.length > 0);
check('worker ignored a mismatched half-section split position', mismatchedHalf!.views === null && mismatchedHalf!.errors?.length > 0);
check(`valid negative-side half section failed ${JSON.stringify(negativeHalf!.errors || [])}`, negativeHalf!.errors?.length === 0
  && negativeHalf!.views?.length === 1 && negativeHalf!.views[0].derivedEvidence?.section?.halfMapping?.side === 'negative');
check(`valid vertical-axis half section failed ${JSON.stringify(verticalHalf!.errors || [])}`, verticalHalf!.errors?.length === 0
  && verticalHalf!.views?.length === 1 && verticalHalf!.views[0].derivedEvidence?.section?.halfMapping?.axis === 'y'
  && verticalHalf!.views[0].derivedEvidence?.section?.halfMapping?.at === 7);
check(`valid aligned hinge/angle edit failed ${JSON.stringify(alignedVariant!.errors || [])}`, alignedVariant!.errors?.length === 0
  && alignedVariant!.views?.length === 1
  && alignedVariant!.views[0].derivedEvidence?.exact?.operation === 'partition-rigid-brep-unfold-hlr');
check(`valid broken-out depth edit failed ${JSON.stringify(brokenOutDepthVariant!.errors || [])}`,
  brokenOutDepthVariant!.errors?.length === 0 && brokenOutDepthVariant!.views?.length === 1);
check('worker published a non-intersecting broken-out profile',
  nonIntersectingBrokenOut!.views === null && nonIntersectingBrokenOut!.errors?.length > 0);
const baselineBrokenOutView = exact!.views.find((entry: JsonRecord) => entry.view === brokenOutId);
const depthVariantView = brokenOutDepthVariant!.views[0];
const depthCausality = {
  baselineVolume: baselineBrokenOutView.derivedEvidence.exact.result.volumeMm3,
  changedVolume: depthVariantView.derivedEvidence.exact.result.volumeMm3,
  baselineSectionHash: baselineBrokenOutView.derivedEvidence.section.pathHash,
  changedSectionHash: depthVariantView.derivedEvidence.section.pathHash,
  baselineObjectHlrHash: baselineBrokenOutView.derivedEvidence.exact.outputPaths.pathHash,
  changedObjectHlrHash: depthVariantView.derivedEvidence.exact.outputPaths.pathHash,
  baselineFront: baselineBrokenOutView.derivedEvidence.clip.frontDepth,
  changedFront: depthVariantView.derivedEvidence.clip.frontDepth,
  baselineEnd: baselineBrokenOutView.derivedEvidence.clip.endDepth,
  changedEnd: depthVariantView.derivedEvidence.clip.endDepth,
};
check(`broken-out depth edit did not causally change exact material and end plane ${JSON.stringify(depthCausality)}`,
  depthCausality.changedVolume < depthCausality.baselineVolume
  && sameNumberTuple([depthCausality.changedFront], [depthCausality.baselineFront])
  && sameNumberTuple([depthCausality.changedEnd - depthCausality.baselineEnd], [2]));
const depthVariantPdf = pdfTools.createStudioDrawingPdf(
  brokenOutDepthVariant!, brokenOutDepthVariantProject.name, { project: brokenOutDepthVariantProject },
);
check('broken-out depth edit did not reach authenticated deterministic PDF output', depthVariantPdf.bytes?.length > 1_000);
const obliqueClip = obliqueBrokenOut!.views?.[0]?.derivedEvidence?.clip;
check(`oblique broken-out exact camera support failed ${JSON.stringify(obliqueBrokenOut!.errors || [])}`,
  obliqueBrokenOut!.errors?.length === 0 && obliqueBrokenOut!.views?.length === 1
  && obliqueClip?.rangeMethod === 'rigid-camera-frame-AddOptimal'
  && Array.isArray(obliqueClip.sourceDepthRange) && Array.isArray(obliqueClip.worldAabbDepthRange)
  && Math.abs(Number(obliqueClip.sourceDepthRange[0]) - Number(obliqueClip.worldAabbDepthRange[0])) > 1e-4);
check(`oblique broken-out depth edit failed ${JSON.stringify(obliqueDepthVariant!.errors || [])}`,
  obliqueDepthVariant!.errors?.length === 0 && obliqueDepthVariant!.views?.length === 1);
const obliqueBaselineView = obliqueBrokenOut!.views[0];
const obliqueDepthView = obliqueDepthVariant!.views[0];
const obliqueDepthCausality = {
  baselineVolume: obliqueBaselineView.derivedEvidence.exact.result.volumeMm3,
  changedVolume: obliqueDepthView.derivedEvidence.exact.result.volumeMm3,
  baselineSectionHash: obliqueBaselineView.derivedEvidence.section.pathHash,
  changedSectionHash: obliqueDepthView.derivedEvidence.section.pathHash,
  baselineObjectHlrHash: obliqueBaselineView.derivedEvidence.exact.outputPaths.pathHash,
  changedObjectHlrHash: obliqueDepthView.derivedEvidence.exact.outputPaths.pathHash,
  baselineFront: obliqueBaselineView.derivedEvidence.clip.frontDepth,
  changedFront: obliqueDepthView.derivedEvidence.clip.frontDepth,
  baselineEnd: obliqueBaselineView.derivedEvidence.clip.endDepth,
  changedEnd: obliqueDepthView.derivedEvidence.clip.endDepth,
};
check(`oblique broken-out depth edit did not change exact B-rep and delivered geometry ${JSON.stringify(obliqueDepthCausality)}`,
  obliqueDepthCausality.changedVolume < obliqueDepthCausality.baselineVolume
  && (obliqueDepthCausality.changedSectionHash !== obliqueDepthCausality.baselineSectionHash
    || obliqueDepthCausality.changedObjectHlrHash !== obliqueDepthCausality.baselineObjectHlrHash)
  && sameNumberTuple([obliqueDepthCausality.changedFront], [obliqueDepthCausality.baselineFront])
  && sameNumberTuple([obliqueDepthCausality.changedEnd - obliqueDepthCausality.baselineEnd], [2]));
const obliqueManifestBinding = obliqueBrokenOut!.manifest.exactProjectionEvidence.derivedViews[0];
const obliqueTransportHash = stableHash(obliqueBaselineView.derivedEvidence);
const obliqueClonedHash = stableHash(structuredClone(obliqueBaselineView.derivedEvidence));
check(`oblique worker evidence hash changed in transport ${obliqueManifestBinding.evidenceHash}/${obliqueTransportHash}/${obliqueClonedHash}`,
  obliqueManifestBinding.evidenceHash === obliqueTransportHash && obliqueTransportHash === obliqueClonedHash);
const obliquePdf = pdfTools.createStudioDrawingBookPdf(
  obliqueBrokenOut!, obliqueProject.name, bookTools.inspectStudioDrawingBook(obliqueProject),
  null, null, null, obliqueProject,
);
check('oblique broken-out exact camera support did not reach deterministic PDF output',
  obliquePdf.manifest?.pages?.[0]?.derivedViews?.[0]?.evidence?.kind === 'broken-out-section'
  && obliquePdf.bytes?.length > 1_000);
const obliqueDepthPdf = pdfTools.createStudioDrawingBookPdf(
  obliqueDepthVariant!, obliqueDepthVariantProject.name,
  bookTools.inspectStudioDrawingBook(obliqueDepthVariantProject), null, null, null, obliqueDepthVariantProject,
);
check('oblique broken-out depth edit did not reach authenticated deterministic PDF output', obliqueDepthPdf.bytes?.length > 1_000);

const evidenceByKind = new Map<string, JsonRecord>();
for (const view of exact!.views) {
  const persistent = graph.derivedViews.find((entry: JsonRecord) => entry.id === view.view);
  check(`worker returned an unknown derived view ${String(view.view)}`, persistent);
  const evidence = view.derivedEvidence;
  const expectedDefinitionHash = stableHash({
    kind: persistent.kind, sourceViewId: persistent.sourceViewId, definition: persistent.definition,
  });
  const manifestEvidence = exact!.manifest.exactProjectionEvidence.derivedViews
    .find((entry: JsonRecord) => entry.view === view.view);
  check(`${persistent.kind} lacks current exact derived evidence`, evidence?.schema === DERIVED_EVIDENCE_SCHEMA
    && evidence.documentHash === currentDocumentHash && evidence.kind === persistent.kind
    && evidence.sourceViewId === persistent.sourceViewId && evidence.definitionHash === expectedDefinitionHash
    && evidence.sourceFrameHash === stableHash({ sourceViewId: 'front', standard: 'front' })
    && manifestEvidence?.evidenceHash === stableHash(evidence)
    && evidence.exact && typeof evidence.exact === 'object'
    && evidence.exact.kernel === 'OpenCascade' && typeof evidence.exact.operation === 'string'
    && validShapeEvidence(evidence.exact.source) && validShapeEvidence(evidence.exact.result));
  check(`${persistent.kind} lacks exact HLR paths`, Array.isArray(view.visible) && view.visible.length > 0
    && Array.isArray(view.regularVisible) && Array.isArray(view.hidden));
  check(`${persistent.kind} returned the unmodified source projection`, JSON.stringify({ viewBox: view.viewBox, visible: view.visible, hidden: view.hidden })
    !== JSON.stringify({ viewBox: discovery!.views[0].viewBox, visible: discovery!.views[0].visible, hidden: discovery!.views[0].hidden }));
  if (SECTION_KINDS.has(persistent.kind)) {
    const volume = operationVolume(evidence);
    const expectedPlaneCount = ['half-section', 'aligned-section'].includes(persistent.kind) ? 2 : 1;
    check(`${persistent.kind} lacks bounded exact before/after volume evidence`, volume && volume.before > 0
      && volume.after > 0 && volume.after < volume.before);
    check(`${persistent.kind} lacks exact section contours`, Number(evidence.section?.pathCount) > 0
      && Array.isArray(view.sectionPaths) && view.sectionPaths.length === Number(evidence.section.pathCount)
      && view.sectionPaths.every((path: string) => /[Zz](?:\s*)$/u.test(path))
      && evidence.section.pathHash === stableHash(view.sectionPaths)
      && stableSource(evidence.section.pathHashes) === stableSource(view.sectionPaths.map((path: string) => stableHash(path)))
      && Array.isArray(evidence.section.pathBounds) && evidence.section.pathBounds.length === 4
      && evidence.section.planeCount === expectedPlaneCount && Number(evidence.section.faceCount) > 0
      && Number(evidence.section.contourCount) >= Number(evidence.section.pathCount)
      && Array.isArray(evidence.section.kernelEdgeCounts)
      && evidence.section.kernelEdgeCounts.length === expectedPlaneCount
      && evidence.section.kernelEdgeCounts.every((count: number) => Number.isInteger(count) && count > 0)
      && evidence.section.generatedFaceFilter === 'exclude-source-IsSame'
      && Array.isArray(evidence.section.planes) && evidence.section.planes.length === expectedPlaneCount);
    if (persistent.kind === 'full-section') {
      check('full section lacks delivered exact HLR identity', evidence.exact.operation === 'common-halfspace'
        && validPathEvidence(evidence.exact.outputPaths, view)
        && stableSource(evidence.exact.viewFrame) === stableSource(evidence.section.viewFrame)
        && sameNumberTuple(evidence.section.viewFrame.direction, persistent.definition.planes[0].normal)
        && sameNumberTuple(evidence.section.viewFrame.xAxis, persistent.definition.planes[0].xAxis)
        && sameNumberTuple(view.frame.direction, persistent.definition.planes[0].normal)
        && sameNumberTuple(view.frame.xAxis, persistent.definition.planes[0].xAxis)
        && !sameNumberTuple(view.frame.direction, discovery!.views[0].frame?.direction || [0, -1, 0]));
    }
    if (persistent.kind === 'half-section') {
      const mapping = evidence.section.halfMapping;
      check('half-section controls are not bound to the exact quarter cutter', evidence.exact.operation === 'cut-quarter-wedge'
        && stableSource(mapping) === stableSource(evidence.exact.halfMapping)
        && mapping.axis === persistent.definition.half.axis && mapping.side === persistent.definition.half.side
        && mapping.at === persistent.definition.half.at && Number.isInteger(mapping.splitPlaneIndex)
        && Number.isInteger(mapping.sectionPlaneIndex) && mapping.splitPlaneIndex !== mapping.sectionPlaneIndex
        && evidence.section.sideContract === 'remove-intersection-of-authored-retained-side-complements'
        && validPathEvidence(evidence.exact.outputPaths, view));
    }
    if (persistent.kind === 'aligned-section') {
      const transforms = evidence.section.alignmentTransforms;
      const regions = evidence.exact.regions;
      const partition = evidence.exact.partition;
      const angledRegionClasses = regions?.[1]?.regionalHlr?.edgeClasses || {};
      check(`aligned angled region lacks hidden/tangent exact HLR ${JSON.stringify(angledRegionClasses)}`,
        Number(angledRegionClasses.regularHidden?.pathCount) > 0
          && Number(angledRegionClasses.tangentVisible?.pathCount + angledRegionClasses.tangentHidden?.pathCount) > 0);
      check('aligned section lacks complete exact regional B-rep unfolding evidence', evidence.exact.operation === 'partition-rigid-brep-unfold-hlr'
        && evidence.section.alignmentMode === 'exact-disjoint-region-brep-unfold'
        && evidence.section.reference?.planeIndex === 0
        && Array.isArray(transforms) && transforms.length === expectedPlaneCount
        && transforms.every((entry: JsonRecord, index: number) => entry.planeIndex === index && entry.rigid === true
          && Array.isArray(entry.anchor) && entry.anchor.length === 2
          && Array.isArray(entry.matrix2d) && entry.matrix2d.length === 2
          && Array.isArray(entry.matrix4x4) && entry.matrix4x4.length === 4
          && entry.matrix4x4.every((row: unknown) => Array.isArray(row) && row.length === 4)
          && Math.abs(Math.abs(Number(entry.determinant)) - 1) < 1e-6
          && Array.isArray(entry.sourceAnchor) && entry.sourceAnchor.length === 3
          && Array.isArray(entry.targetAnchor) && entry.targetAnchor.length === 3
          && Array.isArray(entry.sourceNormal) && entry.sourceNormal.length === 3
          && Array.isArray(entry.targetNormal) && entry.targetNormal.length === 3
          && Array.isArray(entry.primaryRotation?.axis) && entry.primaryRotation.axis.length === 3
          && Number.isFinite(Number(entry.primaryRotation?.angleDeg)) && Number.isFinite(Number(entry.twistDeg)))
        && stableSource(transforms[0].anchor) !== stableSource(transforms[1].anchor)
        && Array.isArray(evidence.exact.joints) && evidence.exact.joints.length === expectedPlaneCount - 1
        && Array.isArray(regions) && regions.length === expectedPlaneCount
        && regions.every((entry: JsonRecord, index: number) => entry.index === index
          && validShapeEvidence(entry.source) && validShapeEvidence(entry.transformed)
          && validPathEvidenceRecord(entry.regionalHlr)
          && stableSource(entry.transform) === stableSource(transforms[index]))
        && stableSource(regions[1].source.bounds) !== stableSource(regions[1].transformed.bounds)
        && partition?.coverage === 'exact-disjoint-halfspace-cells'
        && partition.regionCount === expectedPlaneCount
        && partition.coverageDeltaMm3 <= partition.toleranceMm3
        && partition.maximumPairOverlapMm3 <= partition.toleranceMm3
        && Array.isArray(partition.pairChecks)
        && partition.pairChecks.length === expectedPlaneCount * (expectedPlaneCount - 1) / 2
        && partition.pairChecks.every((entry: JsonRecord) => entry.kernel === 'OpenCascade-BRepAlgoAPI-Common'
          && entry.completed === true && Number.isInteger(entry.leftRegionIndex) && Number.isInteger(entry.rightRegionIndex)
          && entry.leftRegionIndex < entry.rightRegionIndex && Number(entry.volumeMm3) <= partition.toleranceMm3)
        && validShapeEvidence(evidence.exact.transformedResult)
        && validPathEvidenceRecord(evidence.exact.preUnfoldPaths)
        && evidence.exact.alignedHlrPathCount === evidence.exact.objectHlrPaths.pathCount
        && evidence.exact.alignedHlrPathCount > view.sectionPaths.length
        && validPathEvidence(evidence.exact.objectHlrPaths, view)
        && validPathEvidence(evidence.exact.deliveredPaths, view)
        && Number(evidence.exact.deliveredPaths.edgeClasses?.regularHidden?.pathCount) > 0
        && Number(evidence.exact.deliveredPaths.edgeClasses?.tangentVisible?.pathCount
          + evidence.exact.deliveredPaths.edgeClasses?.tangentHidden?.pathCount) > 0
        && evidence.exact.preUnfoldPaths.pathHash !== evidence.exact.deliveredPaths.pathHash
        && stableSource(evidence.exact.objectHlrPaths) === stableSource(evidence.exact.deliveredPaths)
        && view.visible.length + view.hidden.length > view.sectionPaths.length);
    }
    if (persistent.kind === 'broken-out-section') {
      check('broken-out section lacks exact boundary/depth clipping evidence', evidence.clip?.operation === 'exact-profile-prism-cut'
        && stableSource(evidence.clip.boundary) === stableSource(persistent.definition.boundary)
        && evidence.clip.depthMm === persistent.definition.depthMm && evidence.section.depthMm === persistent.definition.depthMm
        && Array.isArray(evidence.clip.sourceDepthRange) && evidence.clip.sourceDepthRange.length === 2
        && evidence.clip.rangeMethod === 'rigid-camera-frame-AddOptimal'
        && evidence.clip.depthRelation === 'end-depth=front-depth+persisted-depth-mm'
        && sameNumberTuple([evidence.clip.frontDepth], [evidence.clip.sourceDepthRange[0]])
        && sameNumberTuple([evidence.clip.endDepth], [evidence.clip.frontDepth + persistent.definition.depthMm])
        && Array.isArray(evidence.clip.toolDepthRange) && evidence.clip.toolDepthRange.length === 2
        && evidence.clip.toolDepthRange[0] < evidence.clip.frontDepth
        && sameNumberTuple([evidence.clip.toolDepthRange[1]], [evidence.clip.endDepth])
        && Array.isArray(evidence.clip.cameraTransform?.matrix4x4)
        && evidence.clip.cameraTransform.matrix4x4.length === 4
        && Array.isArray(evidence.clip.worldAabbDepthRange) && evidence.clip.worldAabbDepthRange.length === 2
        && stableSource(evidence.section.depthPlane) === stableSource(evidence.section.planes[0].plane)
        && Array.isArray(evidence.clip.resultViewBox) && evidence.clip.resultViewBox.length === 4
        && evidence.exact.operation === 'cut-view-profile-depth' && validPathEvidence(evidence.exact.outputPaths, view));
    }
  } else if (['detail', 'crop'].includes(persistent.kind)) {
    const expectedMagnification = persistent.kind === 'detail' ? persistent.definition.magnification : 1;
    const clippingChecks = {
      operation: evidence.exact.operation === 'exact-hlr-profile-clip' && evidence.clip?.operation === 'exact-hlr-boundary-clip',
      unchangedBrep: sameShapeEvidence(evidence.exact.source, evidence.exact.result),
      definition: stableSource(evidence.clip.boundary) === stableSource(persistent.definition.boundary)
        && evidence.clip.magnification === expectedMagnification,
      bounds: Array.isArray(evidence.clip.sourceViewBounds) && evidence.clip.sourceViewBounds.length === 4
        && Array.isArray(evidence.clip.resultViewBox) && evidence.clip.resultViewBox.length === 4
        && sameNumberTuple(evidence.clip.resultViewBox, view.viewBox)
        && sameNumberTuple(evidence.clip.boundaryViewBox, view.viewBox),
      sourcePaths: validPathEvidence(evidence.clip.sourcePaths, discovery!.views[0]),
      resultPaths: validPathEvidence(evidence.clip.resultPaths, view),
      exactBinding: stableSource(evidence.exact.sourcePaths) === stableSource(evidence.clip.sourcePaths)
        && stableSource(evidence.exact.resultPaths) === stableSource(evidence.clip.resultPaths),
      changedPaths: evidence.clip.sourcePaths.pathHash !== evidence.clip.resultPaths.pathHash,
      noSectionGeometry: view.sectionPaths.length === 0,
    };
    check(`${persistent.kind} lacks exact drawing-only HLR clipping evidence ${JSON.stringify(clippingChecks)}`,
      Object.values(clippingChecks).every(Boolean));
  } else if (persistent.kind === 'break') {
    check('break view lacks exact drawing-only piecewise HLR mapping evidence', evidence.exact.operation === 'exact-hlr-band-break'
      && sameShapeEvidence(evidence.exact.source, evidence.exact.result)
      && evidence.break?.operation === 'exact-hlr-band-map'
      && evidence.break.axis === persistent.definition.axis
      && evidence.break.start === persistent.definition.start && evidence.break.end === persistent.definition.end
      && evidence.break.gapMm === persistent.definition.gapMm
      && evidence.break.removedSpanMm === persistent.definition.end - persistent.definition.start
      && evidence.break.translationMm === evidence.break.removedSpanMm - evidence.break.gapMm
      && evidence.break.pieceCount === 2 && Array.isArray(evidence.break.sourceViewBounds)
      && evidence.break.sourceViewBounds.length === 4 && Array.isArray(evidence.break.resultViewBox)
      && evidence.break.resultViewBox.length === 4
      && sameNumberTuple(evidence.break.resultViewBox, view.viewBox)
      && Array.isArray(evidence.break.mappedBoundaries) && evidence.break.mappedBoundaries.length === 2
      && evidence.break.mappedBoundaries[1] - evidence.break.mappedBoundaries[0] === persistent.definition.gapMm
      && validPathEvidence(evidence.break.sourcePaths, discovery!.views[0])
      && validPathEvidence(evidence.break.resultPaths, view)
      && stableSource(evidence.exact.sourcePaths) === stableSource(evidence.break.sourcePaths)
      && stableSource(evidence.exact.resultPaths) === stableSource(evidence.break.resultPaths)
      && Array.isArray(evidence.break.pieces) && evidence.break.pieces.length === 2
      && evidence.break.pieces.every((entry: JsonRecord, index: number) => entry.index === index
        && Array.isArray(entry.sourceInterval) && entry.sourceInterval.length === 2
        && Array.isArray(entry.translation) && entry.translation.length === 2
        && validPathEvidenceRecord(entry.sourcePaths) && validPathEvidenceRecord(entry.resultPaths))
      && view.sectionPaths.length === 0);
  } else {
    const direction = view.frame?.direction?.map(Number);
    const alignment = Array.isArray(direction) && direction.length === 3
      ? Math.abs(direction.reduce((sum: number, value: number, index: number) => sum + value * auxiliaryNormal[index], 0))
        / Math.max(1e-12, Math.hypot(...direction) * Math.hypot(...auxiliaryNormal))
      : 0;
    check('auxiliary view lacks its exact resolved planar frame', evidence.exact.operation === 'persistent-planar-face-hlr'
      && evidence.exact.resolvedReference?.bodyId === auxiliaryReference.bodyId
      && evidence.exact.resolvedReference?.faceName === auxiliaryReference.faceName
      && Array.isArray(evidence.exact.facePoint) && evidence.exact.facePoint.length === 3
      && alignment > 1 - 1e-9);
  }
  evidenceByKind.set(persistent.kind, evidence);
}
check('worker omitted one or more derived capability families', DERIVED_KINDS.every((kind) => evidenceByKind.has(kind)));

const baselineHalfView = exact!.views.find((entry: JsonRecord) => entry.view === halfId);
check('valid negative exterior side did not change exact half-section geometry',
  negativeHalf!.views[0].derivedEvidence.exact.result.volumeMm3 !== baselineHalfView.derivedEvidence.exact.result.volumeMm3
  || negativeHalf!.views[0].derivedEvidence.exact.outputPaths.pathHash !== baselineHalfView.derivedEvidence.exact.outputPaths.pathHash);
check('valid y-axis half split did not change exact half-section geometry',
  verticalHalf!.views[0].derivedEvidence.exact.result.volumeMm3 !== baselineHalfView.derivedEvidence.exact.result.volumeMm3
  || verticalHalf!.views[0].derivedEvidence.exact.outputPaths.pathHash !== baselineHalfView.derivedEvidence.exact.outputPaths.pathHash);
const baselineAlignedView = exact!.views.find((entry: JsonRecord) => entry.view === alignedId);
check('aligned hinge/angle edit changed only contours instead of the complete unfolded object HLR',
  alignedVariant!.views[0].derivedEvidence.exact.deliveredPaths.pathHash
    !== baselineAlignedView.derivedEvidence.exact.deliveredPaths.pathHash
  && alignedVariant!.views[0].derivedEvidence.exact.preUnfoldPaths.pathHash
    !== alignedVariant!.views[0].derivedEvidence.exact.deliveredPaths.pathHash);

const stableBook = bookTools.inspectStudioDrawingBook(project);
const drawingPdf = (response: JsonRecord) => pdfTools.createStudioDrawingBookPdf(
  response, project.name, stableBook, null, null, null, project,
);
const staleEvidence = structuredClone(exact!);
staleEvidence.views[0].derivedEvidence.documentHash = '0'.repeat(64);
expectCode('stale derived document evidence', () => drawingPdf(staleEvidence), 'DRAWING_DERIVED_EVIDENCE_INVALID');
const missingEvidence = structuredClone(exact!);
delete missingEvidence.views[0].derivedEvidence;
expectCode('missing derived kernel evidence', () => drawingPdf(missingEvidence), 'DRAWING_DERIVED_EVIDENCE_REQUIRED');
const tamperedDefinitionEvidence = structuredClone(exact!);
const tamperedViewId = tamperedDefinitionEvidence.views[0].view;
tamperedDefinitionEvidence.views[0].derivedEvidence.definitionHash = 'forged-definition';
tamperedDefinitionEvidence.manifest.exactProjectionEvidence.derivedViews
  .find((entry: JsonRecord) => entry.view === tamperedViewId).definitionHash = 'forged-definition';
rebindManifestEvidenceHash(tamperedDefinitionEvidence, tamperedViewId);
expectCode('paired tampered derived definition evidence', () => drawingPdf(tamperedDefinitionEvidence), 'DRAWING_DERIVED_EVIDENCE_INVALID');
const pairedDocumentHash = structuredClone(exact!);
pairedDocumentHash.manifest.exactProjectionEvidence.documentHash = '0'.repeat(64);
for (const view of pairedDocumentHash.views) {
  view.derivedEvidence.documentHash = '0'.repeat(64);
  rebindManifestEvidenceHash(pairedDocumentHash, view.view);
}
expectCode('paired forged document hash', () => drawingPdf(pairedDocumentHash), 'DRAWING_DERIVED_EVIDENCE_INVALID');
const tamperedExactRecord = structuredClone(exact!);
tamperedExactRecord.views[0].derivedEvidence.exact = { forged: true };
rebindManifestEvidenceHash(tamperedExactRecord, tamperedExactRecord.views[0].view);
expectCode('fabricated exact-kernel record', () => drawingPdf(tamperedExactRecord), 'DRAWING_DERIVED_EVIDENCE_INVALID');
const unboundEvidenceTamper = structuredClone(exact!);
unboundEvidenceTamper.views[0].derivedEvidence.presentation.hatchSpacingMm += 0.1;
expectCode('unbound derived evidence tamper', () => drawingPdf(unboundEvidenceTamper), 'DRAWING_DERIVED_EVIDENCE_INVALID');
const tamperedSectionPath = structuredClone(exact!);
const sectionView = tamperedSectionPath.views.find((entry: JsonRecord) => SECTION_KINDS.has(entry.derivedEvidence.kind));
sectionView.sectionPaths[0] = 'M 0 0 L 4 0 L 4 4 L 0 4 Z';
expectCode('tampered exact section contour', () => drawingPdf(tamperedSectionPath), 'DRAWING_DERIVED_EVIDENCE_INVALID');
const tamperedAlignedTransform = structuredClone(exact!);
const alignedTransformView = tamperedAlignedTransform.views.find((entry: JsonRecord) => entry.view === alignedId);
alignedTransformView.derivedEvidence.section.alignmentTransforms[1].matrix4x4[0][3] += 1;
alignedTransformView.derivedEvidence.section.regions[1].transform.matrix4x4[0][3] += 1;
alignedTransformView.derivedEvidence.exact.regions[1].transform.matrix4x4[0][3] += 1;
rebindManifestEvidenceHash(tamperedAlignedTransform, alignedId);
expectCode('tampered aligned regional transform', () => drawingPdf(tamperedAlignedTransform), 'DRAWING_DERIVED_EVIDENCE_INVALID');
const tamperedFullSectionFrame = structuredClone(exact!);
const tamperedFullSectionView = tamperedFullSectionFrame.views.find((entry: JsonRecord) => entry.view === fullId);
tamperedFullSectionView.frame.direction = [0, -1, 0];
tamperedFullSectionView.derivedEvidence.exact.viewFrame.direction = [0, -1, 0];
tamperedFullSectionView.derivedEvidence.section.viewFrame.direction = [0, -1, 0];
rebindManifestEvidenceHash(tamperedFullSectionFrame, fullId);
expectCode('tampered full-section output frame', () => drawingPdf(tamperedFullSectionFrame), 'DRAWING_DERIVED_EVIDENCE_INVALID');
const tamperedAlignedPartition = structuredClone(exact!);
const alignedPartitionView = tamperedAlignedPartition.views.find((entry: JsonRecord) => entry.view === alignedId);
alignedPartitionView.derivedEvidence.exact.partition.maximumPairOverlapMm3
  = alignedPartitionView.derivedEvidence.exact.partition.toleranceMm3 + 1;
alignedPartitionView.derivedEvidence.section.partition.maximumPairOverlapMm3
  = alignedPartitionView.derivedEvidence.section.partition.toleranceMm3 + 1;
rebindManifestEvidenceHash(tamperedAlignedPartition, alignedId);
expectCode('tampered aligned partition overlap', () => drawingPdf(tamperedAlignedPartition), 'DRAWING_DERIVED_EVIDENCE_INVALID');
const tamperedBrokenOutDepth = structuredClone(exact!);
const tamperedBrokenOutDepthView = tamperedBrokenOutDepth.views.find((entry: JsonRecord) => entry.view === brokenOutId);
tamperedBrokenOutDepthView.derivedEvidence.clip.endDepth += 1;
rebindManifestEvidenceHash(tamperedBrokenOutDepth, brokenOutId);
expectCode('tampered broken-out depth relation', () => drawingPdf(tamperedBrokenOutDepth), 'DRAWING_DERIVED_EVIDENCE_INVALID');
const tamperedBrokenOutOrigin = structuredClone(exact!);
const tamperedBrokenOutOriginView = tamperedBrokenOutOrigin.views.find((entry: JsonRecord) => entry.view === brokenOutId);
tamperedBrokenOutOriginView.derivedEvidence.section.depthPlane.origin[0] += 1;
tamperedBrokenOutOriginView.derivedEvidence.section.planes[0].plane.origin[0] += 1;
rebindManifestEvidenceHash(tamperedBrokenOutOrigin, brokenOutId);
expectCode('tampered broken-out depth origin', () => drawingPdf(tamperedBrokenOutOrigin), 'DRAWING_DERIVED_EVIDENCE_INVALID');
expectCode('derived PDF without current project', () => pdfTools.createStudioDrawingBookPdf(exact!, project.name, stableBook), 'DRAWING_DERIVED_PROJECT_REQUIRED');
const firstPdf = drawingPdf(exact!);
const secondPdf = drawingPdf(exactRepeat!);
check('derived-view PDF bytes are not deterministic', Buffer.compare(Buffer.from(firstPdf.bytes), Buffer.from(secondPdf.bytes)) === 0);
check('derived-view PDF manifest is incomplete', firstPdf.manifest.schema === 'partmode.drawing-pdf/v1'
  && firstPdf.manifest.pageCount === 1 && firstPdf.manifest.exactProjectionEvidence?.documentHash === currentDocumentHash
  && firstPdf.manifest.pages[0].views.length === DERIVED_KINDS.length
  && firstPdf.manifest.pages[0].derivedViews?.length === DERIVED_KINDS.length);
const pdfText = Buffer.from(firstPdf.bytes).toString('latin1');
check('one or more section families lack deterministic clipped PDF hatching',
  (pdfText.match(/% partmode-derived-section-hatch/gu) || []).length === SECTION_KINDS.size
  && (pdfText.match(/W\* n/gu) || []).length >= SECTION_KINDS.size);

const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'partmode-drawing-derived-views-'));
let pdfinfo = '';
try {
  const pdfPath = resolve(temporaryDirectory, 'dr003-derived-views.pdf');
  await writeFile(pdfPath, firstPdf.bytes);
  const inspected = await promisify(execFile)('pdfinfo', [pdfPath], { encoding: 'utf8' });
  pdfinfo = inspected.stdout;
  check('pdfinfo rejected the generated PDF page tree', /^Pages:\s+1\s*$/mu.test(pdfinfo));
  check('pdfinfo did not report PDF 1.7', /^PDF version:\s+1\.7\s*$/mu.test(pdfinfo));
} finally { await rm(temporaryDirectory, { recursive: true, force: true }); }

const [pageSource, studioSource, registrySource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
]);
const visibleControls = [
  'bw-drawing-derived-view-select', 'bw-drawing-derived-view-name', 'bw-drawing-derived-view-kind',
  'bw-drawing-derived-view-source', 'bw-drawing-derived-view-planes', 'bw-drawing-derived-view-depth',
  'bw-drawing-derived-view-aux-body', 'bw-drawing-derived-view-aux-face', 'bw-drawing-derived-view-aux-xaxis',
  'bw-drawing-derived-view-add', 'bw-drawing-derived-view-update', 'bw-drawing-derived-view-delete',
];
check('visible derived-view manager is incomplete', visibleControls.every((id) => pageSource.includes(`id="${id}"`))
  && DERIVED_KINDS.every((kind) => pageSource.includes(`value="${kind}"`)));
check('visible exact drawing path drops resolved derived worker requests', studioSource.includes('request.views = deepCopy(options.views)')
  && studioSource.includes('resolveStudioDrawingViewRequests')
  && studioSource.includes("kind: 'drawing.derivedView.create'")
  && studioSource.includes("kind: 'drawing.derivedView.update'")
  && studioSource.includes("kind: 'drawing.derivedView.delete'"));
check('source-owned UI registry omits derived lifecycle controls', registrySource.includes("'dialog.drawing-derived-view.add'")
  && registrySource.includes("'dialog.drawing-derived-view.update'")
  && registrySource.includes("'dialog.drawing-derived-view.delete'"));

console.log(JSON.stringify({
  schema: graph.schema,
  derivedKinds: DERIVED_KINDS,
  currentDocumentHash,
  evidenceSchema: DERIVED_EVIDENCE_SCHEMA,
  exactViews: exact!.views.map((entry: JsonRecord) => ({
    id: entry.view,
    kind: entry.derivedEvidence.kind,
    sectionContours: entry.derivedEvidence.section?.pathCount || 0,
    visiblePaths: entry.visible.length,
  })),
  alignedPartition: {
    regionCount: evidenceByKind.get('aligned-section')?.exact?.partition?.regionCount,
    pairChecks: evidenceByKind.get('aligned-section')?.exact?.partition?.pairChecks?.length,
    maximumPairOverlapMm3: evidenceByKind.get('aligned-section')?.exact?.partition?.maximumPairOverlapMm3,
  },
  brokenOutDepthCausality: depthCausality,
  obliqueBrokenOut: {
    rangeMethod: obliqueClip.rangeMethod,
    sourceDepthRange: obliqueClip.sourceDepthRange,
    worldAabbDepthRange: obliqueClip.worldAabbDepthRange,
    depthCausality: obliqueDepthCausality,
  },
  deterministicPdfBytes: firstPdf.bytes.length,
  pdfinfo: pdfinfo.split('\n').filter((line) => /^(Pages|PDF version):/u.test(line)),
  typedLifecycle: ['create', 'update', 'delete'],
  visibleManager: { controls: visibleControls.length, resolvedWorkerRequests: true },
  failClosed: [
    'missing-source', 'empty-section', 'parallel-aligned-chain', 'misaligned-aligned-hinge',
    'invalid-crop', 'source-in-use', 'sheet-in-use',
    'invalid-auxiliary-reference', 'forged-source-camera', 'half-split-mismatch',
    'stale-derived-evidence', 'missing-derived-evidence', 'paired-definition-hash-tamper',
    'paired-document-hash-tamper', 'fabricated-exact-record', 'unbound-evidence-tamper', 'section-contour-tamper',
    'aligned-transform-tamper', 'full-section-frame-tamper', 'aligned-partition-overlap', 'broken-depth-relation-tamper',
    'broken-depth-origin-tamper', 'broken-profile-no-intersection', 'missing-current-project',
  ],
}, null, 2));
