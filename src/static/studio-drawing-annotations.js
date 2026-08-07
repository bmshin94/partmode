import { canonicalStudioV5Project, studioV5CanonicalHash } from './studio-v5-runtime-document.js';
import { evaluateStudioExpression } from './studio-expression.js';
import { assertStudioHoleWizardFeature, studioHoleWizardCallout } from './studio-hole-wizard.js';

export const STUDIO_DRAWING_ANNOTATIONS_SCHEMA = 'partmode.drawing-annotations/v1';
export const STUDIO_DRAWING_ANNOTATION_KINDS = Object.freeze([
  'note', 'balloon', 'revision-cloud', 'block',
  'model-dimension', 'associative-dimension',
  'datum-symbol', 'feature-control-frame', 'tolerance-stack',
  'hole-callout', 'center-mark', 'centerline', 'weld-symbol', 'surface-finish',
]);
export const STUDIO_DRAWING_MODEL_DIMENSION_FIELDS = Object.freeze(['h', 'r', 't']);
export const STUDIO_DRAWING_ASSOCIATIVE_DIMENSION_TYPES = Object.freeze(['distance', 'horizontal', 'vertical']);
export const STUDIO_DRAWING_GDT_KINDS = Object.freeze(['datum-symbol', 'feature-control-frame', 'tolerance-stack']);
export const STUDIO_DRAWING_GDT_CHARACTERISTICS = Object.freeze([
  'straightness', 'flatness', 'circularity', 'cylindricity', 'profile-line', 'profile-surface',
  'parallelism', 'perpendicularity', 'angularity', 'position', 'circular-runout', 'total-runout',
]);
export const STUDIO_DRAWING_GDT_MATERIAL_CONDITIONS = Object.freeze(['none', 'maximum', 'least']);
export const STUDIO_DRAWING_MANUFACTURING_SYMBOL_KINDS = Object.freeze([
  'hole-callout', 'center-mark', 'centerline', 'weld-symbol', 'surface-finish',
]);
export const STUDIO_DRAWING_WELD_TYPES = Object.freeze(['fillet', 'square-groove', 'v-groove', 'plug-slot']);
export const STUDIO_DRAWING_WELD_SIDES = Object.freeze(['arrow', 'other', 'both']);
export const STUDIO_DRAWING_SURFACE_METHODS = Object.freeze(['unspecified', 'material-removal-required', 'material-removal-prohibited']);
export const STUDIO_DRAWING_SURFACE_LAYS = Object.freeze(['none', 'parallel', 'perpendicular', 'crossed', 'multidirectional', 'circular', 'radial']);

const STANDARD_PROJECTION_FRAMES = Object.freeze({
  front: { direction: [0, -1, 0], xAxis: [1, 0, 0] },
  back: { direction: [0, 1, 0], xAxis: [-1, 0, 0] },
  right: { direction: [-1, 0, 0], xAxis: [0, -1, 0] },
  left: { direction: [1, 0, 0], xAxis: [0, 1, 0] },
  bottom: { direction: [0, 0, 1], xAxis: [1, 0, 0] },
  top: { direction: [0, 0, -1], xAxis: [1, 0, 0] },
  iso: { direction: [-0.57735026919, -0.57735026919, -0.57735026919], xAxis: [0.707106781187, -0.707106781187, 0] },
});

const clone = (value) => structuredClone(value);
const NAME = /^[^\u0000-\u001f]{1,120}$/u;
const TEXT = /^[\x20-\x7e\r\n]{1,500}$/u;
const PERSISTENT_TOPOLOGY_NAME = /^[\x20-\x7e]{1,4096}$/u;

export class StudioDrawingAnnotationsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioDrawingAnnotationsError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new StudioDrawingAnnotationsError(code, message, details);
}

function name(value, label) {
  if (typeof value !== 'string' || !value.trim() || !NAME.test(value.trim())) fail('DRAWING_ANNOTATION_INPUT_INVALID', `${label} must be non-empty bounded text.`);
  return value.trim();
}

function content(value, label, maximum = 500) {
  const resolved = String(value ?? '').trim();
  if (!resolved || resolved.length > maximum || !TEXT.test(resolved)) fail('DRAWING_ANNOTATION_INPUT_INVALID', `${label} must be non-empty bounded printable text.`);
  return resolved;
}

function finite(value, label, minimum = -1_000_000, maximum = 1_000_000) {
  const resolved = Number(value);
  if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) fail('DRAWING_ANNOTATION_INPUT_INVALID', `${label} is outside its finite boundary.`);
  return Math.round(resolved * 1000) / 1000;
}

function point(value, label, bounds = null) {
  if (!Array.isArray(value) || value.length !== 2) fail('DRAWING_ANNOTATION_INPUT_INVALID', `${label} must contain two coordinates.`);
  const result = [finite(value[0], `${label} x`), finite(value[1], `${label} y`)];
  if (bounds && (result[0] < 0 || result[1] < 0 || result[0] > bounds[0] || result[1] > bounds[1])) {
    fail('DRAWING_ANNOTATION_INPUT_INVALID', `${label} must remain inside the drawing sheet.`);
  }
  return result;
}

function optionalContent(value, label, maximum = 200) {
  if (value == null || String(value).trim() === '') return '';
  return content(value, label, maximum);
}

function persistentTopologyName(value, label) {
  if (typeof value !== 'string' || !PERSISTENT_TOPOLOGY_NAME.test(value)) {
    fail('DRAWING_ANNOTATION_INPUT_INVALID', `${label} must be a bounded printable persistent name.`);
  }
  return value;
}

function enumValue(value, allowed, label) {
  const resolved = String(value || '');
  if (!allowed.includes(resolved)) fail('DRAWING_ANNOTATION_INPUT_INVALID', `${label} is unsupported.`);
  return resolved;
}

function featureIds(value, label, count) {
  if (!Array.isArray(value) || value.length !== count) fail('DRAWING_ANNOTATION_INPUT_INVALID', `${label} requires exactly ${count} persistent feature reference${count === 1 ? '' : 's'}.`);
  const result = value.map((entry) => content(entry, `${label} reference`, 200));
  if (new Set(result).size !== result.length) fail('DRAWING_ANNOTATION_INPUT_INVALID', `${label} references must be unique.`);
  return result;
}

function annotationView(sheetRecord, value) {
  const viewId = String(value || '');
  if (!sheetRecord.views.includes(viewId)) fail('DRAWING_ANNOTATION_INPUT_INVALID', 'Drawing-annotation view must be present on its drawing sheet.');
  if (/^drawing-derived-view-\d{6}$/u.test(viewId)) {
    fail('DRAWING_ANNOTATION_DERIVED_VIEW_UNSUPPORTED', 'View-bound annotations, dimensions, GD&T, and manufacturing symbols require an ordinary standard or named drawing view.');
  }
  return viewId;
}

function rootPart(project) {
  if (project?.rootDocument?.kind !== 'part') return null;
  const rootPartId = project.rootDocument.partId || project.rootDocument.definitionId;
  return (project.partDefinitions || []).find((part) => part.id === rootPartId) || null;
}

function featureMap(project) {
  const root = rootPart(project);
  return new Map((root?.features || []).map((feature) => [feature.id, feature]));
}

function bodyMap(project) {
  const root = rootPart(project);
  return new Map((root?.bodies || []).map((body) => [body.id, body]));
}

function persistentTopologyReferences(value, project, count, label) {
  if (!Array.isArray(value) || value.length !== count) {
    fail('DRAWING_ANNOTATION_INPUT_INVALID', `${label} requires exactly ${count} persistent topology reference${count === 1 ? '' : 's'}.`);
  }
  const bodies = bodyMap(project);
  const references = value.map((entry, index) => {
    const bodyId = content(entry?.bodyId, `${label} reference ${index + 1} body`, 200);
    const body = bodies.get(bodyId);
    if (!body || body.suppressed === true) {
      fail('DRAWING_ANNOTATION_REFERENCE_MISSING', `${label} references missing or suppressed body "${bodyId}".`, { bodyId });
    }
    return {
      bodyId,
      topologyKind: enumValue(entry?.topologyKind, ['face', 'edge', 'vertex'], `${label} reference ${index + 1} topology kind`),
      name: persistentTopologyName(entry?.name, `${label} reference ${index + 1} persistent topology name`),
    };
  });
  if (new Set(references.map((entry) => `${entry.bodyId}\u0000${entry.topologyKind}\u0000${entry.name}`)).size !== references.length) {
    fail('DRAWING_ANNOTATION_INPUT_INVALID', `${label} references must be distinct.`);
  }
  return references;
}

function activeHoleFeature(project, featureId, code = 'DRAWING_ANNOTATION_REFERENCE_MISSING') {
  const feature = featureMap(project).get(featureId);
  if (!feature || feature.suppressed === true || !feature.extensions?.holeWizard) {
    fail(code, `Drawing symbol references missing or suppressed Hole Wizard feature "${featureId}".`, { featureId });
  }
  assertStudioHoleWizardFeature(feature, `feature[${featureId}]`);
  return feature;
}

function modelDimensionSource(project, featureId, sourceField, code = 'DRAWING_ANNOTATION_REFERENCE_MISSING') {
  const feature = featureMap(project).get(featureId);
  const field = enumValue(sourceField, STUDIO_DRAWING_MODEL_DIMENSION_FIELDS, 'Imported model-dimension field');
  const supported = (field === 'h' && ['extrude', 'cut'].includes(feature?.type) && !(feature.type === 'cut' && feature.through === true))
    || (field === 'r' && ['fillet', 'chamfer'].includes(feature?.type))
    || (field === 't' && feature?.type === 'shell');
  if (!feature || feature.suppressed === true || !supported || !Object.prototype.hasOwnProperty.call(feature, field)) {
    fail(code, `Imported model dimension references missing, suppressed, or incompatible feature field "${featureId}.${field}".`, { featureId, sourceField: field });
  }
  try {
    const part = rootPart(project);
    const authoredExpression = feature[field];
    const raw = new Map([...(project.parameters || []), ...(part?.parameters || [])].map((entry) => [entry.name, entry.value]));
    const resolved = new Map();
    const resolving = new Set();
    const resolveParameter = (name) => {
      if (resolved.has(name)) return resolved.get(name);
      if (!raw.has(name)) throw new Error(`Unknown parameter "${name}".`);
      if (resolving.has(name)) throw new Error(`Cyclic parameter "${name}".`);
      resolving.add(name);
      const result = evaluateStudioExpression(raw.get(name), resolveParameter, { allowedNames: new Set(raw.keys()) });
      resolving.delete(name);
      resolved.set(name, result);
      return result;
    };
    const resolvedValue = evaluateStudioExpression(authoredExpression, resolveParameter, { allowedNames: new Set(raw.keys()) });
    if (!(resolvedValue > 0)) throw new Error('Driving model dimension must evaluate above zero.');
    return { feature, field, authoredExpression, resolvedValue: Math.round(resolvedValue * 1e9) / 1e9 };
  } catch (error) {
    fail(code, `Imported model dimension "${featureId}.${field}" cannot be evaluated by the current model.`, {
      featureId, sourceField: field, reason: String(error?.message || error),
    });
  }
}

function modelDimensionText(source) {
  const meaning = source.field === 'h' ? 'depth' : source.field === 'r' ? 'radius' : 'thickness';
  return `${source.feature.name || source.feature.type} ${meaning} = ${Number(source.resolvedValue.toFixed(6))} mm`;
}

function emptyGraph() {
  return { schema: STUDIO_DRAWING_ANNOTATIONS_SCHEMA, annotationSequence: 0, blockSequence: 0, blocks: [], annotations: [] };
}

function drawingBook(project) {
  const book = project?.extensions?.drawingBook;
  if (!book || book.schema !== 'partmode.drawing-book/v1' || !Array.isArray(book.sheets)) {
    fail('DRAWING_BOOK_NOT_INITIALIZED', 'A drawing book is required before editing drawing annotations.');
  }
  return book;
}

function sheet(book, sheetId) {
  const result = book.sheets.find((entry) => entry.id === sheetId);
  if (!result) fail('DRAWING_SHEET_NOT_FOUND', 'Requested drawing sheet does not exist.');
  return result;
}

function sheetBounds(sheetRecord) {
  return [Number(sheetRecord.format?.widthMm), Number(sheetRecord.format?.heightMm)];
}

function blockRecord(value, id = value?.id) {
  return {
    id: String(id || ''),
    name: name(value?.name, 'Drawing-block name'),
    text: content(value?.text, 'Drawing-block text', 200),
    widthMm: finite(value?.widthMm, 'Drawing-block width', 5, 200),
    heightMm: finite(value?.heightMm, 'Drawing-block height', 5, 100),
  };
}

function datumIdentifier(value) {
  const resolved = String(value || '').trim().toUpperCase();
  if (!/^[A-HJ-NP-Z]{1,3}$/u.test(resolved)) fail('DRAWING_ANNOTATION_INPUT_INVALID', 'Datum identifier must contain 1 to 3 letters excluding I, O, and Q.');
  return resolved;
}

function toleranceStackEntries(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 50) fail('DRAWING_ANNOTATION_INPUT_INVALID', 'Tolerance stack requires 2 to 50 terms.');
  return value.map((entry, index) => ({
    label: content(entry?.label, `Tolerance-stack term ${index + 1} label`, 80),
    nominalMm: finite(entry?.nominalMm, `Tolerance-stack term ${index + 1} nominal`, -1_000_000, 1_000_000),
    plusMm: finite(entry?.plusMm ?? 0, `Tolerance-stack term ${index + 1} plus tolerance`, 0, 100_000),
    minusMm: finite(entry?.minusMm ?? 0, `Tolerance-stack term ${index + 1} minus tolerance`, 0, 100_000),
    direction: enumValue(String(entry?.direction ?? 1), ['1', '-1'], `Tolerance-stack term ${index + 1} direction`) === '1' ? 1 : -1,
  }));
}

function annotationRecord(value, book, blocks, id = value?.id, project = null) {
  const kind = String(value?.kind || '');
  if (!STUDIO_DRAWING_ANNOTATION_KINDS.includes(kind)) fail('DRAWING_ANNOTATION_INPUT_INVALID', 'Drawing annotation kind is unsupported.');
  const sheetRecord = sheet(book, String(value?.sheetId || ''));
  const bounds = sheetBounds(sheetRecord);
  const base = { id: String(id || ''), kind, sheetId: sheetRecord.id };
  if (kind === 'note') {
    return { ...base, text: content(value?.text, 'Drawing note'), positionMm: point(value?.positionMm, 'Drawing-note position', bounds), sizePt: finite(value?.sizePt ?? 8, 'Drawing-note size', 5, 24) };
  }
  if (kind === 'balloon') {
    const viewId = annotationView(sheetRecord, value?.viewId);
    return {
      ...base, text: content(value?.text, 'Manual balloon text', 12), viewId,
      anchor: point(value?.anchor, 'Manual balloon projection anchor'),
      labelMm: point(value?.labelMm, 'Manual balloon label', bounds),
    };
  }
  if (kind === 'revision-cloud') {
    if (!Array.isArray(value?.boundsMm) || value.boundsMm.length !== 4) fail('DRAWING_ANNOTATION_INPUT_INVALID', 'Revision cloud requires sheet x, y, width, and height.');
    const cloud = [
      finite(value.boundsMm[0], 'Revision-cloud x', 0, bounds[0]), finite(value.boundsMm[1], 'Revision-cloud y', 0, bounds[1]),
      finite(value.boundsMm[2], 'Revision-cloud width', 5, 500), finite(value.boundsMm[3], 'Revision-cloud height', 5, 500),
    ];
    if (cloud[0] + cloud[2] > bounds[0] || cloud[1] + cloud[3] > bounds[1]) fail('DRAWING_ANNOTATION_INPUT_INVALID', 'Revision cloud must remain inside the drawing sheet.');
    return { ...base, revision: content(value?.revision, 'Revision-cloud revision', 20), boundsMm: cloud };
  }
  if (kind === 'block') {
    const blockId = String(value?.blockId || '');
    const block = blocks.get(blockId);
    if (!block) fail('DRAWING_BLOCK_NOT_FOUND', 'Requested reusable drawing block does not exist.');
    const scale = finite(value?.scale ?? 1, 'Drawing-block scale', 0.1, 10);
    const positionMm = point(value?.positionMm, 'Drawing-block position', bounds);
    if (positionMm[0] + block.widthMm * scale > bounds[0] || positionMm[1] + block.heightMm * scale > bounds[1]) {
      fail('DRAWING_ANNOTATION_INPUT_INVALID', 'Drawing-block instance must remain inside the drawing sheet.');
    }
    return { ...base, blockId, positionMm, scale };
  }
  if (kind === 'tolerance-stack') {
    return {
      ...base, name: name(value?.name, 'Tolerance-stack name'),
      positionMm: point(value?.positionMm, 'Tolerance-stack position', bounds),
      entries: toleranceStackEntries(value?.entries),
    };
  }
  const viewId = annotationView(sheetRecord, value?.viewId);
  if (kind === 'model-dimension') {
    const featureId = featureIds([value?.featureId], 'Imported model dimension', 1)[0];
    const source = modelDimensionSource(project, featureId, value?.sourceField);
    const anchorA = point(value?.anchorA, 'Imported model-dimension first projection anchor');
    const anchorB = point(value?.anchorB, 'Imported model-dimension second projection anchor');
    if (Math.hypot(anchorB[0] - anchorA[0], anchorB[1] - anchorA[1]) < 1e-9) {
      fail('DRAWING_ANNOTATION_INPUT_INVALID', 'Imported model-dimension projection anchors must be distinct.');
    }
    return { ...base, viewId, featureId, sourceField: source.field, anchorA, anchorB, labelMm: point(value?.labelMm, 'Imported model-dimension label', bounds) };
  }
  if (kind === 'associative-dimension') {
    return {
      ...base, viewId,
      dimensionType: enumValue(value?.dimensionType || 'distance', STUDIO_DRAWING_ASSOCIATIVE_DIMENSION_TYPES, 'Associative drawing-dimension type'),
      references: persistentTopologyReferences(value?.references, project, 2, 'Associative drawing dimension'),
      labelMm: point(value?.labelMm, 'Associative drawing-dimension label', bounds),
    };
  }
  if (kind === 'datum-symbol') {
    return {
      ...base, viewId, identifier: datumIdentifier(value?.identifier),
      reference: persistentTopologyReferences([value?.reference], project, 1, 'Datum symbol')[0],
      labelMm: point(value?.labelMm, 'Datum-symbol label', bounds),
    };
  }
  if (kind === 'feature-control-frame') {
    const datumIds = Array.isArray(value?.datumIds) ? value.datumIds.map((entry) => content(entry, 'Feature-control-frame datum reference', 200)) : [];
    if (datumIds.length > 3 || new Set(datumIds).size !== datumIds.length) fail('DRAWING_ANNOTATION_INPUT_INVALID', 'Feature-control frame supports up to three unique datum references.');
    return {
      ...base, viewId,
      reference: persistentTopologyReferences([value?.reference], project, 1, 'Feature-control frame')[0],
      characteristic: enumValue(value?.characteristic, STUDIO_DRAWING_GDT_CHARACTERISTICS, 'Feature-control-frame characteristic'),
      toleranceMm: finite(value?.toleranceMm, 'Feature-control-frame tolerance', 0.000001, 100_000),
      diameterZone: value?.diameterZone === true,
      materialCondition: enumValue(value?.materialCondition || 'none', STUDIO_DRAWING_GDT_MATERIAL_CONDITIONS, 'Feature-control-frame material condition'),
      datumIds, labelMm: point(value?.labelMm, 'Feature-control-frame label', bounds),
    };
  }
  if (kind === 'hole-callout') {
    const featureId = featureIds([value?.featureId], 'Hole callout', 1)[0];
    activeHoleFeature(project, featureId);
    return { ...base, viewId, featureId, labelMm: point(value?.labelMm, 'Hole-callout label', bounds) };
  }
  if (kind === 'center-mark') {
    const featureId = featureIds([value?.featureId], 'Center mark', 1)[0];
    activeHoleFeature(project, featureId);
    return { ...base, viewId, featureId, sizeMm: finite(value?.sizeMm ?? 3, 'Center-mark size', 1, 20) };
  }
  if (kind === 'centerline') {
    const sourceFeatureIds = featureIds(value?.featureIds, 'Centerline', 2);
    for (const featureId of sourceFeatureIds) activeHoleFeature(project, featureId);
    return { ...base, viewId, featureIds: sourceFeatureIds, extensionMm: finite(value?.extensionMm ?? 3, 'Centerline extension', 0, 20) };
  }
  const anchor = point(value?.anchor, 'Manufacturing-symbol projection anchor');
  const labelMm = point(value?.labelMm, 'Manufacturing-symbol label', bounds);
  if (kind === 'weld-symbol') {
    return {
      ...base, viewId, anchor, labelMm,
      weldType: enumValue(value?.weldType || 'fillet', STUDIO_DRAWING_WELD_TYPES, 'Weld-symbol type'),
      side: enumValue(value?.side || 'arrow', STUDIO_DRAWING_WELD_SIDES, 'Weld-symbol side'),
      sizeMm: finite(value?.sizeMm, 'Weld size', 0.1, 1_000),
      tail: optionalContent(value?.tail, 'Weld-symbol tail', 120),
    };
  }
  return {
    ...base, viewId, anchor, labelMm,
    roughnessRa: finite(value?.roughnessRa, 'Surface roughness Ra', 0.01, 500),
    method: enumValue(value?.method || 'unspecified', STUDIO_DRAWING_SURFACE_METHODS, 'Surface-finish material-removal method'),
    lay: enumValue(value?.lay || 'none', STUDIO_DRAWING_SURFACE_LAYS, 'Surface-finish lay'),
    process: optionalContent(value?.process, 'Surface-finish process', 120),
  };
}

function validateGraph(value, book = null, project = null) {
  if (value == null) return emptyGraph();
  if (!book) fail('DRAWING_BOOK_NOT_INITIALIZED', 'A drawing book is required to validate drawing annotations.');
  if (!value || typeof value !== 'object' || value.schema !== STUDIO_DRAWING_ANNOTATIONS_SCHEMA
    || !Number.isInteger(value.annotationSequence) || value.annotationSequence < 0
    || !Number.isInteger(value.blockSequence) || value.blockSequence < 0
    || !Array.isArray(value.blocks) || value.blocks.length > 50
    || !Array.isArray(value.annotations) || value.annotations.length > 500) {
    fail('DRAWING_ANNOTATIONS_INVALID', 'Drawing-annotation graph is invalid.');
  }
  const graph = clone(value);
  const blockIds = new Set();
  const blockNames = new Set();
  let maximumBlockSequence = 0;
  for (const source of graph.blocks) {
    if (!/^drawing-block-\d{6}$/u.test(source?.id || '') || blockIds.has(source.id)) fail('DRAWING_ANNOTATIONS_INVALID', 'Drawing-block ids are missing or duplicated.');
    const block = blockRecord(source, source.id);
    const folded = block.name.toLowerCase();
    if (blockNames.has(folded)) fail('DRAWING_ANNOTATIONS_INVALID', 'Drawing-block names must be unique.');
    Object.assign(source, block);
    maximumBlockSequence = Math.max(maximumBlockSequence, Number(source.id.slice('drawing-block-'.length)));
    blockIds.add(source.id);
    blockNames.add(folded);
  }
  if (graph.blockSequence < maximumBlockSequence) fail('DRAWING_ANNOTATIONS_INVALID', 'Drawing-block sequence can collide with an existing id.');
  const blocks = new Map(graph.blocks.map((entry) => [entry.id, entry]));
  const annotationIds = new Set();
  let maximumAnnotationSequence = 0;
  for (const source of graph.annotations) {
    if (!/^annotation-\d{6}$/u.test(source?.id || '') || annotationIds.has(source.id)) fail('DRAWING_ANNOTATIONS_INVALID', 'Drawing-annotation ids are missing or duplicated.');
    const annotation = annotationRecord(source, book, blocks, source.id, project);
    Object.assign(source, annotation);
    maximumAnnotationSequence = Math.max(maximumAnnotationSequence, Number(source.id.slice('annotation-'.length)));
    annotationIds.add(source.id);
  }
  if (graph.annotationSequence < maximumAnnotationSequence) fail('DRAWING_ANNOTATIONS_INVALID', 'Drawing-annotation sequence can collide with an existing id.');
  const datums = new Map(graph.annotations.filter((entry) => entry.kind === 'datum-symbol').map((entry) => [entry.id, entry]));
  const datumKeys = new Set();
  for (const datum of datums.values()) {
    const key = `${datum.sheetId}\u0000${datum.identifier}`;
    if (datumKeys.has(key)) fail('DRAWING_GDT_DATUM_DUPLICATE', `Datum identifier "${datum.identifier}" must be unique on its sheet.`);
    datumKeys.add(key);
  }
  for (const frame of graph.annotations.filter((entry) => entry.kind === 'feature-control-frame')) {
    for (const datumId of frame.datumIds) {
      const datum = datums.get(datumId);
      if (!datum || datum.sheetId !== frame.sheetId) fail('DRAWING_GDT_DATUM_MISSING', `Feature-control frame references missing datum symbol "${datumId}" on its sheet.`);
    }
  }
  return graph;
}

function from(project) {
  return validateGraph(project?.extensions?.drawingAnnotations, drawingBook(project), project);
}

function attach(project, graph) {
  const candidate = canonicalStudioV5Project(project);
  candidate.extensions = { ...(candidate.extensions || {}), drawingAnnotations: validateGraph(graph, drawingBook(candidate), candidate) };
  return canonicalStudioV5Project(candidate);
}

export function inspectStudioDrawingAnnotations(project) {
  return from(project);
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function exactDrawingView(response, viewId, project) {
  if (/^drawing-derived-view-\d{6}$/u.test(String(viewId || ''))) {
    fail('DRAWING_ANNOTATION_DERIVED_VIEW_UNSUPPORTED', 'View-bound annotations, dimensions, GD&T, and manufacturing symbols require an ordinary standard or named drawing view.');
  }
  if (!response || response.kind !== 'drawing-result' || response.errors?.length
    || response.manifest?.exactProjectionEvidence?.kind !== 'occt-hlr-exact') {
    fail('DRAWING_ANNOTATION_EXACT_REQUIRED', 'Exact-view drawing annotations require a successful exact OCCT drawing result.');
  }
  const evidence = response.manifest.exactProjectionEvidence;
  const documentHash = evidence.documentHash || evidence.revisionKey;
  if (!project || typeof documentHash !== 'string' || documentHash !== studioV5CanonicalHash(project)) {
    fail('DRAWING_ANNOTATION_REFERENCE_STALE', 'Exact-view drawing annotations require exact evidence for the current document revision.');
  }
  const view = (response.views || []).find((entry) => entry.view === viewId);
  if (!view || !Array.isArray(view.viewBox) || view.viewBox.length !== 4 || view.viewBox.some((value) => !Number.isFinite(value))) {
    fail('DRAWING_ANNOTATION_REFERENCE_STALE', `Exact-view drawing annotation references missing exact view "${viewId}".`);
  }
  return view;
}

function projectionFrame(view) {
  const standard = view.frame?.standard;
  const source = standard ? STANDARD_PROJECTION_FRAMES[standard] : view.frame;
  const direction = source?.direction;
  const xAxis = source?.xAxis;
  if (!Array.isArray(direction) || direction.length !== 3 || !Array.isArray(xAxis) || xAxis.length !== 3
    || [...direction, ...xAxis].some((value) => !Number.isFinite(value))) {
    fail('DRAWING_ANNOTATION_REFERENCE_STALE', `Exact drawing view "${view.view}" has no usable projection frame.`);
  }
  const directionLength = Math.hypot(...direction);
  const xAxisLength = Math.hypot(...xAxis);
  const cosine = dot(direction, xAxis) / Math.max(1e-12, directionLength * xAxisLength);
  if (directionLength < 1e-9 || xAxisLength < 1e-9 || Math.abs(cosine) > 1e-8) {
    fail('DRAWING_ANNOTATION_REFERENCE_STALE', `Exact drawing view "${view.view}" has a degenerate projection frame.`);
  }
  const normalizedDirection = direction.map((value) => value / directionLength);
  const normalizedX = xAxis.map((value) => value / xAxisLength);
  return { direction: normalizedDirection, xAxis: normalizedX, yAxis: cross(normalizedDirection, normalizedX) };
}

function exactViewPoint(value, view) {
  const [x, y, width, height] = view.viewBox;
  const tolerance = 1e-7;
  if (value[0] < x - tolerance || value[0] > x + width + tolerance || value[1] < y - tolerance || value[1] > y + height + tolerance) {
    fail('DRAWING_ANNOTATION_REFERENCE_STALE', 'Manufacturing drawing symbol anchor lies outside the current exact view.');
  }
  return [...value];
}

function projectModelPoint(point3d, view) {
  const frame = projectionFrame(view);
  const result = [dot(point3d, frame.xAxis), -dot(point3d, frame.yAxis)].map((value) => Math.round(value * 1e9) / 1e9);
  return exactViewPoint(result, view);
}

function resolvedHoleSource(project, response, viewId, featureId) {
  const feature = activeHoleFeature(project, featureId, 'DRAWING_ANNOTATION_REFERENCE_STALE');
  const definition = assertStudioHoleWizardFeature(feature, `feature[${featureId}]`);
  const view = exactDrawingView(response, viewId, project);
  return {
    feature,
    anchor: projectModelPoint([definition.center[0], definition.center[1], Number(feature.sketch.z)], view),
    evidence: { kind: 'exact-hole-wizard-projection', featureId, viewId, projection: clone(view.frame) },
  };
}

function resolvedTopologyPoint(reference, response, view) {
  const body = (response.bodies || []).find((entry) => !entry.patternInstance
    && String(entry.sourceBodyId || entry.bodyId || '') === reference.bodyId);
  const topology = body?.topology;
  const collection = topology?.[{ face: 'faces', edge: 'edges', vertex: 'vertices' }[reference.topologyKind]];
  const matches = Array.isArray(collection) ? collection.filter((entry) => entry?.name === reference.name) : [];
  const point3d = matches[0]?.point;
  if (topology?.schema !== 'partmode.drawing-topology-evidence/v1' || matches.length !== 1
    || !Array.isArray(point3d) || point3d.length !== 3 || point3d.some((value) => !Number.isFinite(value))) {
    fail('DRAWING_ANNOTATION_REFERENCE_STALE', `Persistent ${reference.topologyKind} "${reference.name}" on body "${reference.bodyId}" did not resolve one-to-one in current exact topology.`, reference);
  }
  return { reference: clone(reference), point3d: [...point3d], point2d: projectModelPoint(point3d, view) };
}

function resolvedToleranceStack(annotation) {
  let nominalMm = 0;
  let minimumMm = 0;
  let maximumMm = 0;
  let rssSquared = 0;
  for (const entry of annotation.entries) {
    nominalMm += entry.direction * entry.nominalMm;
    if (entry.direction === 1) {
      minimumMm += entry.nominalMm - entry.minusMm;
      maximumMm += entry.nominalMm + entry.plusMm;
    } else {
      minimumMm -= entry.nominalMm + entry.plusMm;
      maximumMm -= entry.nominalMm - entry.minusMm;
    }
    rssSquared += Math.max(entry.plusMm, entry.minusMm) ** 2;
  }
  const rounded = (value) => Math.round(value * 1e9) / 1e9;
  return {
    ...clone(annotation), nominalMm: rounded(nominalMm), minimumMm: rounded(minimumMm), maximumMm: rounded(maximumMm),
    worstCaseMinusMm: rounded(nominalMm - minimumMm), worstCasePlusMm: rounded(maximumMm - nominalMm),
    rssMm: rounded(Math.sqrt(rssSquared)),
    sourceEvidence: { kind: 'controlled-worst-case-tolerance-stack', termCount: annotation.entries.length, unit: 'mm' },
  };
}

function resolveManufacturingAnnotation(annotation, response, project, datums = new Map()) {
  if (annotation.kind === 'tolerance-stack') return resolvedToleranceStack(annotation);
  if (annotation.kind === 'model-dimension') {
    const view = exactDrawingView(response, annotation.viewId, project);
    const source = modelDimensionSource(project, annotation.featureId, annotation.sourceField, 'DRAWING_ANNOTATION_REFERENCE_STALE');
    const anchors = [exactViewPoint(annotation.anchorA, view), exactViewPoint(annotation.anchorB, view)];
    return {
      ...clone(annotation), anchors, authoredExpression: clone(source.authoredExpression), resolvedValue: source.resolvedValue,
      unit: 'mm', displayText: modelDimensionText(source),
      sourceEvidence: {
        kind: 'exact-imported-model-dimension', featureId: source.feature.id, featureType: source.feature.type,
        sourceField: source.field, authoredExpression: clone(source.authoredExpression), resolvedValue: source.resolvedValue,
        unit: 'mm', viewId: annotation.viewId, projection: clone(view.frame), documentHash: studioV5CanonicalHash(project),
      },
    };
  }
  if (annotation.kind === 'associative-dimension') {
    const view = exactDrawingView(response, annotation.viewId, project);
    const points = annotation.references.map((reference) => resolvedTopologyPoint(reference, response, view));
    const delta = [points[1].point2d[0] - points[0].point2d[0], points[1].point2d[1] - points[0].point2d[1]];
    const resolvedValue = annotation.dimensionType === 'horizontal' ? Math.abs(delta[0])
      : annotation.dimensionType === 'vertical' ? Math.abs(delta[1]) : Math.hypot(...delta);
    if (!(resolvedValue > 1e-9)) {
      fail('DRAWING_ANNOTATION_REFERENCE_STALE', `Associative ${annotation.dimensionType} dimension collapses in the selected exact view.`);
    }
    const rounded = Math.round(resolvedValue * 1e9) / 1e9;
    return {
      ...clone(annotation), anchors: points.map((entry) => entry.point2d), resolvedValue: rounded, unit: 'mm',
      displayText: `${Number(rounded.toFixed(6))} mm`,
      sourceEvidence: {
        kind: 'exact-persistent-topology-dimension', dimensionType: annotation.dimensionType,
        references: points.map((entry) => entry.reference), points3d: points.map((entry) => entry.point3d),
        resolvedValue: rounded, unit: 'mm', viewId: annotation.viewId, projection: clone(view.frame),
        documentHash: studioV5CanonicalHash(project),
      },
    };
  }
  if (annotation.kind === 'datum-symbol' || annotation.kind === 'feature-control-frame') {
    const view = exactDrawingView(response, annotation.viewId, project);
    const source = resolvedTopologyPoint(annotation.reference, response, view);
    return {
      ...clone(annotation), anchor: source.point2d,
      ...(annotation.kind === 'feature-control-frame' ? { datumIdentifiers: annotation.datumIds.map((datumId) => datums.get(datumId)?.identifier) } : {}),
      sourceEvidence: {
        kind: annotation.kind === 'datum-symbol' ? 'exact-persistent-topology-datum' : 'exact-persistent-topology-feature-control-frame',
        reference: source.reference, point3d: source.point3d, viewId: annotation.viewId,
        projection: clone(view.frame), documentHash: studioV5CanonicalHash(project),
      },
    };
  }
  if (!STUDIO_DRAWING_MANUFACTURING_SYMBOL_KINDS.includes(annotation.kind)) return clone(annotation);
  if (annotation.kind === 'hole-callout' || annotation.kind === 'center-mark') {
    const source = resolvedHoleSource(project, response, annotation.viewId, annotation.featureId);
    return {
      ...clone(annotation), anchor: source.anchor, sourceEvidence: source.evidence,
      ...(annotation.kind === 'hole-callout' ? { callout: studioHoleWizardCallout(source.feature.extensions.holeWizard) } : {}),
    };
  }
  if (annotation.kind === 'centerline') {
    const sources = annotation.featureIds.map((featureId) => resolvedHoleSource(project, response, annotation.viewId, featureId));
    return {
      ...clone(annotation), anchors: sources.map((entry) => entry.anchor),
      sourceEvidence: { kind: 'exact-hole-wizard-centerline', featureIds: [...annotation.featureIds], viewId: annotation.viewId, projections: sources.map((entry) => entry.evidence.projection) },
    };
  }
  const view = exactDrawingView(response, annotation.viewId, project);
  return {
    ...clone(annotation), anchor: exactViewPoint(annotation.anchor, view),
    sourceEvidence: { kind: 'exact-view-coordinate', viewId: annotation.viewId, projection: clone(view.frame) },
  };
}

export function resolveStudioDrawingSheetAnnotations(book, graphValue, sheetId, response = null, project = null) {
  const graph = validateGraph(graphValue, book, project);
  sheet(book, sheetId);
  const blocks = new Map(graph.blocks.map((entry) => [entry.id, entry]));
  const datums = new Map(graph.annotations.filter((entry) => entry.kind === 'datum-symbol').map((entry) => [entry.id, entry]));
  return {
    schema: 'partmode.drawing-sheet-annotations/v1',
    sheetId,
    annotations: graph.annotations.filter((entry) => entry.sheetId === sheetId).map((entry) => entry.kind === 'block'
      ? { ...clone(entry), block: clone(blocks.get(entry.blockId)) }
      : resolveManufacturingAnnotation(entry, response, project, datums)),
  };
}

export function createStudioDrawingBlock(project, input = {}) {
  const graph = from(project);
  if (graph.blocks.length >= 50) fail('DRAWING_BLOCK_LIMIT_EXCEEDED', 'A project supports at most 50 reusable drawing blocks.');
  const blockName = name(input.name, 'Drawing-block name');
  if (graph.blocks.some((entry) => entry.name.toLowerCase() === blockName.toLowerCase())) fail('DRAWING_BLOCK_EXISTS', `Drawing block "${blockName}" already exists.`);
  const id = `drawing-block-${String(++graph.blockSequence).padStart(6, '0')}`;
  graph.blocks.push(blockRecord({ ...input, name: blockName }, id));
  return attach(project, graph);
}

export function updateStudioDrawingBlock(project, input = {}) {
  const graph = from(project);
  const block = graph.blocks.find((entry) => entry.id === input.blockId);
  if (!block) fail('DRAWING_BLOCK_NOT_FOUND', 'Requested reusable drawing block does not exist.');
  const patch = input.patch && typeof input.patch === 'object' ? input.patch : {};
  const unknown = Object.keys(patch).filter((key) => !['name', 'text', 'widthMm', 'heightMm'].includes(key));
  if (unknown.length) fail('DRAWING_ANNOTATION_INPUT_INVALID', 'Drawing-block patch contains unsupported fields.', { unknown });
  const next = blockRecord({ ...block, ...patch }, block.id);
  if (graph.blocks.some((entry) => entry.id !== block.id && entry.name.toLowerCase() === next.name.toLowerCase())) fail('DRAWING_BLOCK_EXISTS', `Drawing block "${next.name}" already exists.`);
  Object.assign(block, next);
  return attach(project, graph);
}

export function deleteStudioDrawingBlock(project, blockId) {
  const graph = from(project);
  const index = graph.blocks.findIndex((entry) => entry.id === blockId);
  if (index < 0) fail('DRAWING_BLOCK_NOT_FOUND', 'Requested reusable drawing block does not exist.');
  const users = graph.annotations.filter((entry) => entry.kind === 'block' && entry.blockId === blockId).map((entry) => entry.id);
  if (users.length) fail('DRAWING_BLOCK_IN_USE', 'Reusable drawing block has one or more sheet instances.', { annotationIds: users });
  graph.blocks.splice(index, 1);
  return attach(project, graph);
}

export function createStudioDrawingAnnotation(project, input = {}) {
  const book = drawingBook(project);
  const graph = from(project);
  if (graph.annotations.length >= 500) fail('DRAWING_ANNOTATION_LIMIT_EXCEEDED', 'A project supports at most 500 authored drawing annotations.');
  const id = `annotation-${String(++graph.annotationSequence).padStart(6, '0')}`;
  const blocks = new Map(graph.blocks.map((entry) => [entry.id, entry]));
  graph.annotations.push(annotationRecord(input, book, blocks, id, project));
  return attach(project, graph);
}

export function updateStudioDrawingAnnotation(project, input = {}) {
  const book = drawingBook(project);
  const graph = from(project);
  const annotation = graph.annotations.find((entry) => entry.id === input.annotationId);
  if (!annotation) fail('DRAWING_ANNOTATION_NOT_FOUND', 'Requested drawing annotation does not exist.');
  const patch = input.patch && typeof input.patch === 'object' ? input.patch : {};
  if (patch.kind != null && patch.kind !== annotation.kind) fail('DRAWING_ANNOTATION_INPUT_INVALID', 'Drawing annotation kind cannot change during an update.');
  const allowed = {
    note: ['text', 'positionMm', 'sizePt'], balloon: ['text', 'viewId', 'anchor', 'labelMm'],
    'revision-cloud': ['revision', 'boundsMm'], block: ['blockId', 'positionMm', 'scale'],
    'model-dimension': ['viewId', 'featureId', 'sourceField', 'anchorA', 'anchorB', 'labelMm'],
    'associative-dimension': ['viewId', 'dimensionType', 'references', 'labelMm'],
    'datum-symbol': ['viewId', 'identifier', 'reference', 'labelMm'],
    'feature-control-frame': ['viewId', 'reference', 'characteristic', 'toleranceMm', 'diameterZone', 'materialCondition', 'datumIds', 'labelMm'],
    'tolerance-stack': ['name', 'positionMm', 'entries'],
    'hole-callout': ['viewId', 'featureId', 'labelMm'], 'center-mark': ['viewId', 'featureId', 'sizeMm'],
    centerline: ['viewId', 'featureIds', 'extensionMm'],
    'weld-symbol': ['viewId', 'anchor', 'labelMm', 'weldType', 'side', 'sizeMm', 'tail'],
    'surface-finish': ['viewId', 'anchor', 'labelMm', 'roughnessRa', 'method', 'lay', 'process'],
  }[annotation.kind];
  const unknown = Object.keys(patch).filter((key) => key !== 'kind' && !allowed.includes(key));
  if (unknown.length) fail('DRAWING_ANNOTATION_INPUT_INVALID', 'Drawing-annotation patch contains unsupported fields.', { unknown });
  const blocks = new Map(graph.blocks.map((entry) => [entry.id, entry]));
  Object.assign(annotation, annotationRecord({ ...annotation, ...patch }, book, blocks, annotation.id, project));
  return attach(project, graph);
}

export function deleteStudioDrawingAnnotation(project, annotationId) {
  const graph = from(project);
  const index = graph.annotations.findIndex((entry) => entry.id === annotationId);
  if (index < 0) fail('DRAWING_ANNOTATION_NOT_FOUND', 'Requested drawing annotation does not exist.');
  graph.annotations.splice(index, 1);
  return attach(project, graph);
}
