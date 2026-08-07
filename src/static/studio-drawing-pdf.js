import { defaultStudioDrawingStyle, resolveStudioDrawingSheetStyle } from './studio-drawing-standards.js';
import { resolveStudioDrawingSheetAnnotations } from './studio-drawing-annotations.js';
import { resolveStudioDrawingSheetTables } from './studio-drawing-tables.js';
import { inspectStudioDrawingViews } from './studio-drawing-views.js';
import { studioV5CanonicalHash } from './studio-v5-runtime-document.js';

export const STUDIO_DRAWING_PDF_SCHEMA = 'partmode.drawing-pdf/v1';
export const STUDIO_DRAWING_SCALES = Object.freeze([10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01]);

const MM_TO_PT = 72 / 25.4;
const DEFAULT_SHEET_WIDTH_MM = 297;
const DEFAULT_SHEET_HEIGHT_MM = 210;
const encoder = new TextEncoder();
const DERIVED_VIEW_EVIDENCE_SCHEMA = 'partmode.drawing-derived-view-evidence/v1';
const DERIVED_VIEW_KINDS = new Set([
  'full-section', 'half-section', 'aligned-section', 'broken-out-section',
  'detail', 'auxiliary', 'crop', 'break',
]);
const SECTION_VIEW_KINDS = new Set(['full-section', 'half-section', 'aligned-section', 'broken-out-section']);
const DRAWING_ONLY_DERIVED_VIEW_KINDS = new Set(['detail', 'auxiliary', 'crop', 'break']);
const DERIVED_PATH_EDGE_CLASSES = Object.freeze([
  'visible', 'hidden', 'regularVisible', 'regularHidden', 'tangentVisible', 'tangentHidden',
]);
const DERIVED_VIEW_OPERATIONS = Object.freeze({
  'full-section': 'common-halfspace',
  'half-section': 'cut-quarter-wedge',
  'aligned-section': 'partition-rigid-brep-unfold-hlr',
  'broken-out-section': 'cut-view-profile-depth',
  detail: 'exact-hlr-profile-clip',
  auxiliary: 'persistent-planar-face-hlr',
  crop: 'exact-hlr-profile-clip',
  break: 'exact-hlr-band-break',
});

export class StudioDrawingPdfError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioDrawingPdfError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new StudioDrawingPdfError(code, message, details);
}

const finite = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) fail('DRAWING_PDF_INVALID', `${label} must be finite.`);
  return number;
};

function tangentEdgeMode(value) {
  const mode = value == null ? 'visible' : String(value);
  if (!['visible', 'removed', 'phantom'].includes(mode)) fail('DRAWING_PDF_INVALID', 'Tangent-edge display must be visible, removed, or phantom.');
  return mode;
}

function drawingStyle(value) {
  const style = value == null ? defaultStudioDrawingStyle('iso') : structuredClone(value);
  const roles = ['border', 'visible', 'hidden', 'tangent', 'dimensions', 'annotations', 'tables'];
  if (!style || style.schema !== 'partmode.drawing-style-resolved/v1' || !style.profile?.id
    || !Array.isArray(style.layers) || style.layers.length !== roles.length) {
    fail('DRAWING_STYLE_INVALID', 'A resolved drawing style with every supported layer is required.');
  }
  const ids = new Set();
  for (const layer of style.layers) {
    const font = layer?.lineFont;
    if (!roles.includes(layer?.id) || ids.has(layer.id) || typeof layer.visible !== 'boolean' || typeof layer.printable !== 'boolean'
      || !font || typeof font.id !== 'string' || !Number.isFinite(Number(font.widthMm)) || Number(font.widthMm) < 0.05 || Number(font.widthMm) > 2
      || !Array.isArray(font.dashMm) || font.dashMm.length > 8 || font.dashMm.length % 2 !== 0
      || font.dashMm.some((entry) => !Number.isFinite(Number(entry)) || Number(entry) <= 0 || Number(entry) > 100)
      || !Array.isArray(font.color) || font.color.length !== 3 || font.color.some((entry) => !Number.isFinite(Number(entry)) || Number(entry) < 0 || Number(entry) > 1)) {
      fail('DRAWING_STYLE_INVALID', 'Resolved drawing layers or line fonts are invalid.');
    }
    ids.add(layer.id);
  }
  return style;
}

function drawingAnnotations(value) {
  const resolved = value == null ? { schema: 'partmode.drawing-sheet-annotations/v1', sheetId: null, annotations: [] } : structuredClone(value);
  if (!resolved || resolved.schema !== 'partmode.drawing-sheet-annotations/v1' || !Array.isArray(resolved.annotations) || resolved.annotations.length > 500) {
    fail('DRAWING_ANNOTATIONS_INVALID', 'Resolved drawing annotations are invalid.');
  }
  return resolved;
}

function drawingTables(value) {
  const resolved = value == null ? { schema: 'partmode.drawing-sheet-tables/v1', sheetId: null, tables: [] } : structuredClone(value);
  if (!resolved || resolved.schema !== 'partmode.drawing-sheet-tables/v1' || !Array.isArray(resolved.tables) || resolved.tables.length > 60) {
    fail('DRAWING_TABLES_INVALID', 'Resolved drawing tables are invalid.');
  }
  return resolved;
}

const fmt = (value) => {
  const rounded = Math.round(Number(value) * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

const point = (xMm, yMm, sheetHeightMm = DEFAULT_SHEET_HEIGHT_MM) => [xMm * MM_TO_PT, (sheetHeightMm - yMm) * MM_TO_PT];

function pdfText(value, maximum = 120) {
  return String(value ?? '')
    .replace(/[^\x20-\x7e]/gu, '?')
    .slice(0, maximum)
    .replace(/([\\()])/g, '\\$1');
}

function standardScaleLabel(scale) {
  return scale >= 1 ? `${fmt(scale)}:1` : `1:${fmt(1 / scale)}`;
}

function evidenceRecord(value, label, { required = true } = {}) {
  if (value == null && !required) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} must be a non-empty evidence record.`);
  }
  return structuredClone(value);
}

function boundedEvidence(value, label, depth = 0) {
  if (depth > 8) fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} exceeds the supported evidence depth.`);
  if (value == null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} contains a non-finite number.`);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 4_096) fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} contains an oversized string.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} contains an oversized array.`);
    for (const [index, entry] of value.entries()) boundedEvidence(entry, `${label}[${index}]`, depth + 1);
    return;
  }
  if (typeof value !== 'object' || Object.keys(value).length > 100) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} contains unsupported evidence data.`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(key)) fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} contains an invalid evidence key.`);
    boundedEvidence(entry, `${label}.${key}`, depth + 1);
  }
}

function stableEvidenceSource(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableEvidenceSource).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableEvidenceSource(value[key])}`).join(',')}}`;
}

function stableEvidenceHash(value) {
  const source = stableEvidenceSource(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function evidenceNumber(value, label, { minimum = -1_000_000_000_000, maximum = 1_000_000_000_000 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} must be a bounded finite number.`);
  }
  return number;
}

function evidenceInteger(value, label, { minimum = 0, maximum = 1_000_000 } = {}) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} must be a bounded integer.`);
  }
  return value;
}

function evidenceTuple(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} must contain ${length} bounded finite numbers.`);
  }
  return value.map((entry, index) => evidenceNumber(entry, `${label}[${index}]`));
}

function evidenceBox(value, label) {
  const box = evidenceTuple(value, 4, label);
  if (!(box[2] > 0) || !(box[3] > 0)) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} must have positive width and height.`);
  }
  return box;
}

function evidenceBounds(value, label) {
  if (!Array.isArray(value) || value.length !== 2) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} must contain exact low and high corners.`);
  }
  const low = evidenceTuple(value[0], 3, `${label}[0]`);
  const high = evidenceTuple(value[1], 3, `${label}[1]`);
  if (low.some((entry, index) => entry > high[index])) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} exact corners are inverted.`);
  }
  return [low, high];
}

function evidenceShape(value, label) {
  const shape = evidenceRecord(value, label);
  if (shape.brepValid !== true) fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} is not a valid exact B-rep.`);
  shape.solidCount = evidenceInteger(shape.solidCount, `${label}.solidCount`, { minimum: 1 });
  shape.faceCount = evidenceInteger(shape.faceCount, `${label}.faceCount`, { minimum: 1 });
  shape.edgeCount = evidenceInteger(shape.edgeCount, `${label}.edgeCount`, { minimum: 1 });
  shape.volumeMm3 = evidenceNumber(shape.volumeMm3, `${label}.volumeMm3`, { minimum: 1e-8, maximum: 1e30 });
  shape.bounds = evidenceBounds(shape.bounds, `${label}.bounds`);
  return shape;
}

function nearlyEqual(left, right, tolerance = 1e-8) {
  return Math.abs(Number(left) - Number(right)) <= Math.max(tolerance, Math.abs(Number(left)) * tolerance, Math.abs(Number(right)) * tolerance);
}

function sameTuple(left, right, tolerance = 1e-8) {
  return left.length === right.length && left.every((entry, index) => nearlyEqual(entry, right[index], tolerance));
}

function evidenceMatrixPoint(matrix, point, weight = 1) {
  return matrix.slice(0, 3).map((row) => row[0] * point[0] + row[1] * point[1] + row[2] * point[2] + row[3] * weight);
}

function boxContains(outer, inner) {
  const tolerance = Math.max(1e-7, Math.hypot(outer[2], outer[3]) * 1e-7);
  return inner[0] >= outer[0] - tolerance && inner[1] >= outer[1] - tolerance
    && inner[0] + inner[2] <= outer[0] + outer[2] + tolerance
    && inner[1] + inner[3] <= outer[1] + outer[3] + tolerance;
}

function currentDerivedViewContext(project) {
  if (!project || typeof project !== 'object') {
    fail('DRAWING_DERIVED_PROJECT_REQUIRED', 'Derived drawing PDF output requires the current canonical project.');
  }
  let graph;
  let documentHash;
  try {
    graph = inspectStudioDrawingViews(project);
    documentHash = studioV5CanonicalHash(project);
  } catch (error) {
    fail('DRAWING_DERIVED_PROJECT_INVALID', `Derived drawing PDF output requires a valid current project: ${String(error?.message || error)}`);
  }
  if (project.rootDocument?.kind !== 'part') {
    fail('DRAWING_DERIVED_PROJECT_INVALID', 'Derived drawing PDF output currently requires a schema-5 part document.');
  }
  return {
    documentHash,
    views: new Map(graph.derivedViews.map((entry) => [entry.id, entry])),
    namedViews: new Map(graph.views.map((entry) => [entry.id, entry])),
  };
}

function deliveredPathPayload(source, viewBox) {
  const visible = Array.isArray(source?.visible) ? source.visible.map(String) : [];
  const hidden = Array.isArray(source?.hidden) ? source.hidden.map(String) : [];
  return {
    visible,
    hidden,
    regularVisible: Array.isArray(source?.regularVisible) ? source.regularVisible.map(String) : visible,
    regularHidden: Array.isArray(source?.regularHidden) ? source.regularHidden.map(String) : hidden,
    tangentVisible: Array.isArray(source?.tangentVisible) ? source.tangentVisible.map(String) : [],
    tangentHidden: Array.isArray(source?.tangentHidden) ? source.tangentHidden.map(String) : [],
    viewBox,
  };
}

function validatedPathEvidence(value, label, delivered = null) {
  const evidence = evidenceRecord(value, label);
  const pathCount = evidenceInteger(evidence.pathCount, `${label}.pathCount`, { minimum: 1, maximum: 100_000 });
  const pathHash = String(evidence.pathHash || '');
  const viewBox = evidenceBox(evidence.viewBox, `${label}.viewBox`);
  if (!/^[0-9a-z]{1,16}$/u.test(pathHash) || !evidence.edgeClasses || typeof evidence.edgeClasses !== 'object' || Array.isArray(evidence.edgeClasses)) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} has invalid exact path identity evidence.`);
  }
  const expectedPayload = delivered ? deliveredPathPayload(delivered.source, delivered.viewBox) : null;
  let counted = 0;
  for (const key of DERIVED_PATH_EDGE_CLASSES) {
    const edgeClass = evidenceRecord(evidence.edgeClasses[key], `${label}.${key}`);
    const count = evidenceInteger(edgeClass.pathCount, `${label}.${key}.pathCount`, { maximum: 100_000 });
    const hash = String(edgeClass.pathHash || '');
    if (!/^[0-9a-z]{1,16}$/u.test(hash)) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label}.${key} has invalid exact path identity evidence.`);
    }
    counted += count;
    if (expectedPayload) {
      const paths = expectedPayload[key];
      if (count !== paths.length || hash !== stableEvidenceHash(paths)) {
        fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label}.${key} does not match the delivered exact HLR paths.`);
      }
    }
  }
  if (counted !== pathCount) fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} path counts are inconsistent.`);
  if (expectedPayload) {
    const ordered = DERIVED_PATH_EDGE_CLASSES.flatMap((key) => expectedPayload[key]);
    if (pathHash !== stableEvidenceHash(ordered) || !sameTuple(viewBox, expectedPayload.viewBox, 1e-7)) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} does not match the delivered exact HLR payload.`);
    }
  }
  return { ...evidence, pathCount, pathHash, viewBox };
}

function validatedAlignmentTransforms(value, count, label) {
  if (!Array.isArray(value) || value.length !== count) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} must authenticate one transform per cutting plane.`);
  }
  const indices = new Set();
  return value.map((entry, index) => {
    const transform = evidenceRecord(entry, `${label}[${index}]`);
    const planeIndex = evidenceInteger(transform.planeIndex, `${label}[${index}].planeIndex`, { maximum: count - 1 });
    if (indices.has(planeIndex)) fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label} has duplicate cutting-plane transforms.`);
    indices.add(planeIndex);
    transform.anchor = evidenceTuple(transform.anchor, 2, `${label}[${index}].anchor`);
    if (!Array.isArray(transform.matrix2d) || transform.matrix2d.length !== 2) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label}[${index}] has no bounded rigid 2D matrix.`);
    }
    transform.matrix2d = transform.matrix2d.map((row, rowIndex) => evidenceTuple(row, 3, `${label}[${index}].matrix2d[${rowIndex}]`));
    if (!Array.isArray(transform.matrix4x4) || transform.matrix4x4.length !== 4) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label}[${index}] has no bounded rigid 4x4 matrix.`);
    }
    transform.matrix4x4 = transform.matrix4x4.map((row, rowIndex) => evidenceTuple(row, 4, `${label}[${index}].matrix4x4[${rowIndex}]`));
    transform.determinant = evidenceNumber(transform.determinant, `${label}[${index}].determinant`, { minimum: -1.000001, maximum: 1.000001 });
    transform.rotationDeg = evidenceNumber(transform.rotationDeg, `${label}[${index}].rotationDeg`, { minimum: -360, maximum: 360 });
    transform.sourceAnchor = evidenceTuple(transform.sourceAnchor, 3, `${label}[${index}].sourceAnchor`);
    transform.targetAnchor = evidenceTuple(transform.targetAnchor, 3, `${label}[${index}].targetAnchor`);
    transform.sourceNormal = evidenceTuple(transform.sourceNormal, 3, `${label}[${index}].sourceNormal`);
    transform.sourceXAxis = evidenceTuple(transform.sourceXAxis, 3, `${label}[${index}].sourceXAxis`);
    transform.targetNormal = evidenceTuple(transform.targetNormal, 3, `${label}[${index}].targetNormal`);
    transform.targetXAxis = evidenceTuple(transform.targetXAxis, 3, `${label}[${index}].targetXAxis`);
    transform.primaryRotation = evidenceRecord(transform.primaryRotation, `${label}[${index}].primaryRotation`);
    transform.primaryRotation.axis = evidenceTuple(transform.primaryRotation.axis, 3, `${label}[${index}].primaryRotation.axis`);
    transform.primaryRotation.angleDeg = evidenceNumber(
      transform.primaryRotation.angleDeg,
      `${label}[${index}].primaryRotation.angleDeg`,
      { minimum: -360, maximum: 360 },
    );
    transform.twistDeg = evidenceNumber(transform.twistDeg, `${label}[${index}].twistDeg`, { minimum: -360, maximum: 360 });
    const columns = [0, 1, 2].map((column) => transform.matrix4x4.slice(0, 3).map((row) => row[column]));
    const dot = (left, right) => left.reduce((sum, entry, component) => sum + entry * right[component], 0);
    const determinant3d = columns[0][0] * (columns[1][1] * columns[2][2] - columns[1][2] * columns[2][1])
      - columns[1][0] * (columns[0][1] * columns[2][2] - columns[0][2] * columns[2][1])
      + columns[2][0] * (columns[0][1] * columns[1][2] - columns[0][2] * columns[1][1]);
    const mappedSourceAnchor = evidenceMatrixPoint(transform.matrix4x4, transform.sourceAnchor);
    const mappedSourceNormal = evidenceMatrixPoint(transform.matrix4x4, transform.sourceNormal, 0);
    const mappedSourceXAxis = evidenceMatrixPoint(transform.matrix4x4, transform.sourceXAxis, 0);
    if (transform.rigid !== true || !nearlyEqual(Math.abs(transform.determinant), 1, 1e-6)
      || !sameTuple(transform.matrix4x4[3], [0, 0, 0, 1], 1e-9)
      || columns.some((column) => !nearlyEqual(dot(column, column), 1, 1e-7))
      || Math.abs(dot(columns[0], columns[1])) > 1e-7
      || Math.abs(dot(columns[0], columns[2])) > 1e-7
      || Math.abs(dot(columns[1], columns[2])) > 1e-7
      || !nearlyEqual(determinant3d, 1, 1e-7)
      || !sameTuple(mappedSourceAnchor, transform.targetAnchor, 1e-7)
      || !sameTuple(mappedSourceNormal, transform.targetNormal, 1e-7)
      || !sameTuple(mappedSourceXAxis, transform.targetXAxis, 1e-7)) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `${label}[${index}] is not an authenticated rigid transform.`);
    }
    boundedEvidence(transform, `${label}[${index}]`);
    return transform;
  });
}

function validatedDerivedEvidence(source, response, sectionPaths, viewBox, currentProject) {
  const view = String(source?.view || '');
  const evidenceSource = source?.derivedEvidence;
  const derivedIdentity = /^drawing-derived-view-\d{6}$/u.test(view);
  if (evidenceSource == null) {
    if (derivedIdentity || sectionPaths.length) {
      fail('DRAWING_DERIVED_EVIDENCE_REQUIRED', `Derived drawing view "${view}" has no authenticated kernel evidence.`);
    }
    return null;
  }
  const evidence = evidenceRecord(evidenceSource, `Derived drawing view "${view}" evidence`);
  boundedEvidence(evidence, `Derived drawing view "${view}" evidence`);
  if (!currentProject) {
    fail('DRAWING_DERIVED_PROJECT_REQUIRED', `Derived drawing view "${view}" requires the current canonical project.`);
  }
  const persisted = currentProject.views.get(view);
  if (!persisted || String(source?.name || '') !== persisted.name) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Derived drawing view "${view}" is absent from the current project or has stale identity.`);
  }
  const exactProjection = response.manifest?.exactProjectionEvidence;
  const documentHash = String(exactProjection?.documentHash || '');
  const kind = String(evidence.schema || '');
  const viewKind = String(evidence.kind || '');
  const sourceViewId = String(evidence.sourceViewId || '');
  const evidenceDocumentHash = String(evidence.documentHash || '');
  const definitionHash = String(evidence.definitionHash || '');
  const sourceFrame = ['front', 'top', 'right', 'left', 'bottom', 'back', 'iso'].includes(persisted.sourceViewId)
    ? { sourceViewId: persisted.sourceViewId, standard: persisted.sourceViewId }
    : (() => {
        const named = currentProject.namedViews.get(persisted.sourceViewId);
        return named ? { sourceViewId: persisted.sourceViewId, direction: named.direction, xAxis: named.xAxis } : null;
      })();
  const expectedSourceFrameHash = sourceFrame ? stableEvidenceHash(sourceFrame) : '';
  const expectedDefinitionHash = stableEvidenceHash({
    kind: persisted.kind,
    sourceViewId: persisted.sourceViewId,
    definition: persisted.definition,
  });
  const manifestBindings = Array.isArray(exactProjection?.derivedViews) ? exactProjection.derivedViews : [];
  const manifestBinding = manifestBindings.filter((entry) => String(entry?.view || '') === view);
  const expectedEvidenceHash = stableEvidenceHash(evidence);
  if (kind !== DERIVED_VIEW_EVIDENCE_SCHEMA || !DERIVED_VIEW_KINDS.has(viewKind)
    || viewKind !== persisted.kind || sourceViewId !== persisted.sourceViewId
    || definitionHash !== expectedDefinitionHash
    || String(evidence.sourceFrameHash || '') !== expectedSourceFrameHash
    || exactProjection?.kind !== 'occt-hlr-exact' || !/^[a-f0-9]{64}$/u.test(documentHash)
    || documentHash !== currentProject.documentHash || evidenceDocumentHash !== documentHash
    || !Array.isArray(exactProjection.views) || !exactProjection.views.map(String).includes(view)
    || manifestBinding.length !== 1 || String(manifestBinding[0]?.kind || '') !== viewKind
    || String(manifestBinding[0]?.sourceViewId || '') !== sourceViewId
    || String(manifestBinding[0]?.definitionHash || '') !== definitionHash
    || String(manifestBinding[0]?.evidenceHash || '') !== expectedEvidenceHash) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Derived drawing view "${view}" is not bound to the current exact OCCT projection.`, {
      view,
      manifestEvidenceHash: String(manifestBinding[0]?.evidenceHash || ''),
      expectedEvidenceHash,
    });
  }
  evidence.exact = evidenceRecord(evidence.exact, `Derived drawing view "${view}" exact evidence`);
  const optionalEvidence = [
    ['section', `Derived drawing view "${view}" section evidence`],
    ['clip', `Derived drawing view "${view}" clip evidence`],
    ['break', `Derived drawing view "${view}" break evidence`],
    ['presentation', `Derived drawing view "${view}" presentation evidence`],
  ];
  for (const [key, label] of optionalEvidence) {
    const record = evidenceRecord(evidence[key], label, { required: false });
    if (record) evidence[key] = record;
    else delete evidence[key];
  }
  if (evidence.exact.kernel !== 'OpenCascade' || evidence.exact.operation !== DERIVED_VIEW_OPERATIONS[viewKind]) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Derived drawing view "${view}" has unsupported exact-kernel operation evidence.`);
  }
  evidence.exact.source = evidenceShape(evidence.exact.source, `Derived drawing view "${view}" exact source`);
  evidence.exact.result = evidenceShape(evidence.exact.result, `Derived drawing view "${view}" exact result`);
  if (DRAWING_ONLY_DERIVED_VIEW_KINDS.has(viewKind)) {
    if (stableEvidenceSource(evidence.exact.source) !== stableEvidenceSource(evidence.exact.result)) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Drawing-only derived view "${view}" must retain the exact source B-rep.`);
    }
  } else {
    const tolerance = Math.max(1e-7, evidence.exact.source.volumeMm3 * 1e-9);
    if (!(evidence.exact.result.volumeMm3 < evidence.exact.source.volumeMm3 - tolerance)) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Derived drawing view "${view}" has no authenticated exact material change.`);
    }
  }
  if (viewKind === 'auxiliary') {
    const resolved = evidenceRecord(evidence.exact.resolvedReference, `Auxiliary drawing view "${view}" resolved reference`);
    const reference = persisted.definition.reference;
    if (String(resolved.faceName || '') !== reference.faceName
      || ![resolved.bodyId, resolved.sourceBodyId].map(String).includes(reference.bodyId)) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Auxiliary drawing view "${view}" is not bound to its persistent planar face.`);
    }
    evidence.exact.facePoint = evidenceTuple(evidence.exact.facePoint, 3, `Auxiliary drawing view "${view}" face point`);
  }
  if (SECTION_VIEW_KINDS.has(viewKind)) {
    const expectedPlaneCount = viewKind === 'aligned-section' ? persisted.definition.planes.length
      : viewKind === 'half-section' ? 2 : 1;
    if (!evidence.section || !sectionPaths.length
      || evidenceInteger(evidence.section.pathCount, `Section drawing view "${view}" path count`, { minimum: 1 }) !== sectionPaths.length
      || evidenceInteger(evidence.section.planeCount, `Section drawing view "${view}" plane count`, { minimum: 1, maximum: 6 }) !== expectedPlaneCount
      || evidenceInteger(evidence.section.faceCount, `Section drawing view "${view}" face count`, { minimum: 1 }) < 1
      || evidenceInteger(evidence.section.contourCount, `Section drawing view "${view}" contour count`, { minimum: sectionPaths.length }) < sectionPaths.length
      || sectionPaths.some((path) => !/[Zz](?:\s*)$/u.test(path))) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Section drawing view "${view}" requires authenticated closed section contours.`);
    }
    if (!Array.isArray(evidence.section.kernelEdgeCounts) || evidence.section.kernelEdgeCounts.length !== expectedPlaneCount
      || evidence.section.kernelEdgeCounts.some((entry, index) => evidenceInteger(entry, `Section drawing view "${view}" kernel edge count ${index + 1}`, { minimum: 1 }) < 1)) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Section drawing view "${view}" lacks exact OCCT intersection evidence for every cutting plane.`);
    }
    if (String(evidence.section.pathHash || '') !== stableEvidenceHash(sectionPaths)
      || !Array.isArray(evidence.section.pathHashes) || evidence.section.pathHashes.length !== sectionPaths.length
      || evidence.section.pathHashes.some((hash, index) => String(hash) !== stableEvidenceHash(sectionPaths[index]))) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Section drawing view "${view}" contours do not match their authenticated path hashes.`);
    }
    evidence.section.pathBounds = evidenceBox(evidence.section.pathBounds, `Section drawing view "${view}" path bounds`);
    if (!boxContains(viewBox, evidence.section.pathBounds)) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Section drawing view "${view}" contour bounds escape the exact projection bounds.`);
    }
    for (const path of sectionPaths) tokenizePath(path);
    const angle = Number(evidence.presentation?.hatchAngleDeg ?? evidence.section.hatchAngleDeg ?? 45);
    const spacing = Number(evidence.presentation?.hatchSpacingMm ?? evidence.section.hatchSpacingMm ?? 2.5);
    if (!Number.isFinite(angle) || angle < -89 || angle > 89 || !Number.isFinite(spacing) || spacing < 0.5 || spacing > 10) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Section drawing view "${view}" has invalid hatch presentation evidence.`);
    }
    if (viewKind !== 'aligned-section') {
      evidence.exact.outputPaths = validatedPathEvidence(
        evidence.exact.outputPaths,
        `Section drawing view "${view}" delivered HLR paths`,
        { source, viewBox },
      );
    }
    if (viewKind === 'full-section') {
      const sectionViewFrame = evidenceRecord(evidence.section.viewFrame, `Full-section drawing view "${view}" section frame`);
      const exactViewFrame = evidenceRecord(evidence.exact.viewFrame, `Full-section drawing view "${view}" exact frame`);
      const deliveredFrame = evidenceRecord(source.frame, `Full-section drawing view "${view}" delivered frame`);
      sectionViewFrame.direction = evidenceTuple(sectionViewFrame.direction, 3, `Full-section drawing view "${view}" direction`);
      sectionViewFrame.xAxis = evidenceTuple(sectionViewFrame.xAxis, 3, `Full-section drawing view "${view}" x-axis`);
      const cuttingPlane = evidenceRecord(sectionViewFrame.cuttingPlane, `Full-section drawing view "${view}" cutting plane`);
      cuttingPlane.origin = evidenceTuple(cuttingPlane.origin, 3, `Full-section drawing view "${view}" cutting-plane origin`);
      cuttingPlane.normal = evidenceTuple(cuttingPlane.normal, 3, `Full-section drawing view "${view}" cutting-plane normal`);
      cuttingPlane.xAxis = evidenceTuple(cuttingPlane.xAxis, 3, `Full-section drawing view "${view}" cutting-plane x-axis`);
      cuttingPlane.yAxis = evidenceTuple(cuttingPlane.yAxis, 3, `Full-section drawing view "${view}" cutting-plane y-axis`);
      deliveredFrame.direction = evidenceTuple(deliveredFrame.direction, 3, `Full-section drawing view "${view}" delivered direction`);
      deliveredFrame.xAxis = evidenceTuple(deliveredFrame.xAxis, 3, `Full-section drawing view "${view}" delivered x-axis`);
      const persistedPlane = persisted.definition.planes[0];
      const expectedDirection = persistedPlane.keepSide === 'positive'
        ? persistedPlane.normal
        : persistedPlane.normal.map((component) => -component);
      const contourPlanes = Array.isArray(evidence.section.planes) ? evidence.section.planes : [];
      if (sectionViewFrame.retainedSide !== persistedPlane.keepSide
        || cuttingPlane.keepSide !== persistedPlane.keepSide
        || !sameTuple(cuttingPlane.origin, persistedPlane.origin, 1e-7)
        || !sameTuple(cuttingPlane.normal, persistedPlane.normal, 1e-7)
        || !sameTuple(cuttingPlane.xAxis, persistedPlane.xAxis, 1e-7)
        || !sameTuple(sectionViewFrame.direction, expectedDirection, 1e-7)
        || !sameTuple(sectionViewFrame.xAxis, persistedPlane.xAxis, 1e-7)
        || !sameTuple(deliveredFrame.direction, expectedDirection, 1e-7)
        || !sameTuple(deliveredFrame.xAxis, persistedPlane.xAxis, 1e-7)
        || stableEvidenceSource(sectionViewFrame) !== stableEvidenceSource(exactViewFrame)
        || contourPlanes.length !== 1
        || stableEvidenceSource(cuttingPlane) !== stableEvidenceSource(contourPlanes[0]?.plane)) {
        fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Full-section drawing view "${view}" is not oriented to its exact retained cutting plane.`);
      }
      sectionViewFrame.cuttingPlane = cuttingPlane;
      evidence.section.viewFrame = sectionViewFrame;
      evidence.exact.viewFrame = exactViewFrame;
    }
    if (viewKind === 'half-section') {
      const mapping = evidenceRecord(evidence.section.halfMapping, `Half drawing view "${view}" mapping`);
      const expected = persisted.definition.half;
      if (String(mapping.axis || '') !== expected.axis || String(mapping.side || '') !== expected.side
        || !nearlyEqual(mapping.at, expected.at)
        || !['positive', 'negative'].includes(String(mapping.retainedPlaneSide || ''))
        || !['positive', 'negative'].includes(String(mapping.cutterSide || ''))
        || String(mapping.retainedPlaneSide) === String(mapping.cutterSide)) {
        fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Half drawing view "${view}" does not authenticate its persistent split mapping.`);
      }
      mapping.axisVector = evidenceTuple(mapping.axisVector, 3, `Half drawing view "${view}" mapping axis`);
      mapping.splitPlaneIndex = evidenceInteger(mapping.splitPlaneIndex, `Half drawing view "${view}" split plane index`, { maximum: 1 });
      mapping.sectionPlaneIndex = evidenceInteger(mapping.sectionPlaneIndex, `Half drawing view "${view}" section plane index`, { maximum: 1 });
      if (mapping.splitPlaneIndex === mapping.sectionPlaneIndex) {
        fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Half drawing view "${view}" split and section planes must remain distinct.`);
      }
      if (stableEvidenceSource(mapping) !== stableEvidenceSource(evidence.exact.halfMapping)) {
        fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Half drawing view "${view}" has inconsistent exact split evidence.`);
      }
      evidence.section.halfMapping = mapping;
    }
    if (viewKind === 'aligned-section') {
      evidence.section.reference = evidenceRecord(evidence.section.reference, `Aligned drawing view "${view}" reference frame`);
      const referencePlaneIndex = evidenceInteger(
        evidence.section.reference.planeIndex,
        `Aligned drawing view "${view}" reference plane index`,
        { maximum: expectedPlaneCount - 1 },
      );
      const referencePlane = evidenceRecord(evidence.section.reference.plane, `Aligned drawing view "${view}" reference plane`);
      const expectedReferencePlane = persisted.definition.planes[referencePlaneIndex];
      const referenceOrigin = evidenceTuple(referencePlane.origin, 3, `Aligned drawing view "${view}" reference origin`);
      const referenceNormal = evidenceTuple(referencePlane.normal, 3, `Aligned drawing view "${view}" reference normal`);
      const referenceXAxis = evidenceTuple(referencePlane.xAxis, 3, `Aligned drawing view "${view}" reference x-axis`);
      if (referencePlaneIndex !== 0 || !sameTuple(referenceOrigin, expectedReferencePlane.origin, 1e-9)
        || !sameTuple(referenceNormal, expectedReferencePlane.normal, 1e-9)
        || !sameTuple(referenceXAxis, expectedReferencePlane.xAxis, 1e-9)
        || String(referencePlane.keepSide || '') !== expectedReferencePlane.keepSide) {
        fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Aligned drawing view "${view}" reference frame is stale.`);
      }
      evidence.section.alignmentTransforms = validatedAlignmentTransforms(
        evidence.section.alignmentTransforms,
        expectedPlaneCount,
        `Aligned drawing view "${view}" transforms`,
      );
      for (const [index, transform] of evidence.section.alignmentTransforms.entries()) {
        const plane = persisted.definition.planes[index];
        if (!sameTuple(transform.sourceNormal, plane.normal, 1e-8)
          || !sameTuple(transform.sourceXAxis, plane.xAxis, 1e-8)
          || !sameTuple(transform.targetNormal, expectedReferencePlane.normal, 1e-8)
          || !sameTuple(transform.targetXAxis, expectedReferencePlane.xAxis, 1e-8)) {
          fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Aligned drawing view "${view}" has a transform that is not bound to its persistent plane frames.`);
        }
      }
      evidence.exact.deliveredPaths = validatedPathEvidence(
        evidence.exact.deliveredPaths,
        `Aligned drawing view "${view}" delivered HLR paths`,
        { source, viewBox },
      );
      evidence.exact.objectHlrPaths = validatedPathEvidence(
        evidence.exact.objectHlrPaths,
        `Aligned drawing view "${view}" object HLR paths`,
      );
      evidence.section.objectHlrPaths = validatedPathEvidence(
        evidence.section.objectHlrPaths,
        `Aligned drawing view "${view}" section-bound object HLR paths`,
      );
      evidence.exact.preUnfoldPaths = validatedPathEvidence(
        evidence.exact.preUnfoldPaths,
        `Aligned drawing view "${view}" pre-unfold cut-body HLR paths`,
      );
      evidence.section.preUnfoldPaths = validatedPathEvidence(
        evidence.section.preUnfoldPaths,
        `Aligned drawing view "${view}" section-bound pre-unfold HLR paths`,
      );
      const persistentJoints = Array.isArray(persisted.definition.joints) ? persisted.definition.joints : [];
      const exactJoints = Array.isArray(evidence.exact.joints) ? evidence.exact.joints.map((entry, index) => {
        const joint = evidenceRecord(entry, `Aligned drawing view "${view}" exact joint ${index + 1}`);
        joint.previousPlaneIndex = evidenceInteger(joint.previousPlaneIndex, `Aligned drawing view "${view}" joint previous index`, { maximum: expectedPlaneCount - 1 });
        joint.nextPlaneIndex = evidenceInteger(joint.nextPlaneIndex, `Aligned drawing view "${view}" joint next index`, { maximum: expectedPlaneCount - 1 });
        joint.point = evidenceTuple(joint.point, 3, `Aligned drawing view "${view}" joint point`);
        joint.axis = evidenceTuple(joint.axis, 3, `Aligned drawing view "${view}" joint axis`);
        joint.splitNormal = evidenceTuple(joint.splitNormal, 3, `Aligned drawing view "${view}" joint split normal`);
        if (joint.previousPlaneIndex !== index || joint.nextPlaneIndex !== index + 1) {
          fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Aligned drawing view "${view}" has unordered exact joints.`);
        }
        return joint;
      }) : [];
      const jointsMatchPersistent = exactJoints.every((joint, index) => {
        const persistent = persistentJoints[index];
        return Number(persistent?.previousPlaneIndex) === joint.previousPlaneIndex
          && Number(persistent?.nextPlaneIndex) === joint.nextPlaneIndex
          && sameTuple(joint.point, persistent?.point || [], 1e-8)
          && sameTuple(joint.axis, persistent?.axis || [], 1e-8)
          && sameTuple(joint.splitNormal, persistent?.splitNormal || [], 1e-8);
      });
      if (persistentJoints.length !== expectedPlaneCount - 1 || exactJoints.length !== persistentJoints.length
        || !jointsMatchPersistent
        || stableEvidenceSource(evidence.section.joints) !== stableEvidenceSource(exactJoints)) {
        fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Aligned drawing view "${view}" has stale or incomplete persistent hinge evidence.`);
      }
      for (const [index, transform] of evidence.section.alignmentTransforms.entries()) {
        const expectedSourceAnchor = index === 0 ? referenceOrigin : exactJoints[index - 1].point;
        const expectedTargetAnchor = index === 0
          ? referenceOrigin
          : evidenceMatrixPoint(evidence.section.alignmentTransforms[index - 1].matrix4x4, expectedSourceAnchor);
        if (!sameTuple(transform.sourceAnchor, expectedSourceAnchor, 1e-8)
          || !sameTuple(transform.targetAnchor, expectedTargetAnchor, 1e-7)) {
          fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Aligned drawing view "${view}" has a disconnected regional hinge transform.`);
        }
      }
      const exactPartition = evidenceRecord(evidence.exact.partition, `Aligned drawing view "${view}" exact partition`);
      const sectionPartition = evidenceRecord(evidence.section.partition, `Aligned drawing view "${view}" section partition`);
      const regionCount = evidenceInteger(exactPartition.regionCount, `Aligned drawing view "${view}" region count`, { minimum: 2, maximum: 6 });
      const sourceVolumeMm3 = evidenceNumber(exactPartition.sourceVolumeMm3, `Aligned drawing view "${view}" partition source volume`, { minimum: 1e-8 });
      const regionVolumeSumMm3 = evidenceNumber(exactPartition.regionVolumeSumMm3, `Aligned drawing view "${view}" partition volume sum`, { minimum: 1e-8 });
      const coverageDeltaMm3 = evidenceNumber(exactPartition.coverageDeltaMm3, `Aligned drawing view "${view}" partition coverage delta`, { minimum: 0 });
      const maximumPairOverlapMm3 = evidenceNumber(exactPartition.maximumPairOverlapMm3, `Aligned drawing view "${view}" partition overlap`, { minimum: 0 });
      const partitionToleranceMm3 = evidenceNumber(exactPartition.toleranceMm3, `Aligned drawing view "${view}" partition tolerance`, { minimum: 0, maximum: 1_000_000 });
      const expectedPairChecks = expectedPlaneCount * (expectedPlaneCount - 1) / 2;
      const pairChecks = Array.isArray(exactPartition.pairChecks) ? exactPartition.pairChecks : [];
      const pairKeys = new Set();
      let recordedMaximumOverlapMm3 = 0;
      for (const [index, sourceCheck] of pairChecks.entries()) {
        const pair = evidenceRecord(sourceCheck, `Aligned drawing view "${view}" pair overlap check ${index + 1}`);
        const leftRegionIndex = evidenceInteger(pair.leftRegionIndex, `Aligned drawing view "${view}" pair left region`, { maximum: expectedPlaneCount - 1 });
        const rightRegionIndex = evidenceInteger(pair.rightRegionIndex, `Aligned drawing view "${view}" pair right region`, { maximum: expectedPlaneCount - 1 });
        const volumeMm3 = evidenceNumber(pair.volumeMm3, `Aligned drawing view "${view}" pair overlap volume`, { minimum: 0 });
        const key = `${leftRegionIndex}:${rightRegionIndex}`;
        if (!(rightRegionIndex > leftRegionIndex) || pairKeys.has(key)
          || pair.kernel !== 'OpenCascade-BRepAlgoAPI-Common' || pair.completed !== true
          || volumeMm3 > partitionToleranceMm3) {
          fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Aligned drawing view "${view}" has an incomplete or overlapping exact region pair.`);
        }
        pairKeys.add(key);
        recordedMaximumOverlapMm3 = Math.max(recordedMaximumOverlapMm3, volumeMm3);
      }
      if (exactPartition.coverage !== 'exact-disjoint-halfspace-cells' || regionCount !== expectedPlaneCount
        || !nearlyEqual(sourceVolumeMm3, evidence.exact.result.volumeMm3, 1e-8)
        || !nearlyEqual(regionVolumeSumMm3, sourceVolumeMm3, 1e-8)
        || coverageDeltaMm3 > partitionToleranceMm3 || maximumPairOverlapMm3 > partitionToleranceMm3
        || pairChecks.length !== expectedPairChecks || pairKeys.size !== expectedPairChecks
        || !nearlyEqual(recordedMaximumOverlapMm3, maximumPairOverlapMm3, 1e-9)
        || stableEvidenceSource(sectionPartition) !== stableEvidenceSource(exactPartition)) {
        fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Aligned drawing view "${view}" lacks exact partition coverage and non-overlap proof.`);
      }
      const exactRegions = Array.isArray(evidence.exact.regions) ? evidence.exact.regions : [];
      const sectionRegions = Array.isArray(evidence.section.regions) ? evidence.section.regions : [];
      if (exactRegions.length !== expectedPlaneCount || stableEvidenceSource(sectionRegions) !== stableEvidenceSource(exactRegions)) {
        fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Aligned drawing view "${view}" lacks one exact source/transformed record per region.`);
      }
      let authenticatedRegionVolume = 0;
      for (const [index, sourceRegion] of exactRegions.entries()) {
        const region = evidenceRecord(sourceRegion, `Aligned drawing view "${view}" region ${index + 1}`);
        if (evidenceInteger(region.index, `Aligned drawing view "${view}" region index`, { maximum: expectedPlaneCount - 1 }) !== index
          || region.lowerJointIndex !== (index > 0 ? index - 1 : null)
          || region.upperJointIndex !== (index < expectedPlaneCount - 1 ? index : null)) {
          fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Aligned drawing view "${view}" has unordered or overlapping region ownership.`);
        }
        region.source = evidenceShape(region.source, `Aligned drawing view "${view}" source region ${index + 1}`);
        region.transformed = evidenceShape(region.transformed, `Aligned drawing view "${view}" transformed region ${index + 1}`);
        region.regionalHlr = validatedPathEvidence(
          region.regionalHlr,
          `Aligned drawing view "${view}" transformed region ${index + 1} HLR paths`,
        );
        if (!nearlyEqual(region.source.volumeMm3, region.transformed.volumeMm3, 1e-8)
          || stableEvidenceSource(region.transform) !== stableEvidenceSource(evidence.section.alignmentTransforms[index])) {
          fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Aligned drawing view "${view}" region ${index + 1} is not bound to one volume-preserving rigid transform.`);
        }
        authenticatedRegionVolume += region.source.volumeMm3;
      }
      evidence.exact.transformedResult = evidenceShape(
        evidence.exact.transformedResult,
        `Aligned drawing view "${view}" transformed regional compound`,
      );
      if (!nearlyEqual(authenticatedRegionVolume, sourceVolumeMm3, 1e-8)
        || !nearlyEqual(evidence.exact.transformedResult.volumeMm3, sourceVolumeMm3, 1e-8)
        || evidence.exact.transformedResult.solidCount < expectedPlaneCount) {
        fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Aligned drawing view "${view}" transformed regions do not preserve the complete cut body.`);
      }
      const alignedHlrPathCount = evidenceInteger(
        evidence.exact.alignedHlrPathCount,
        `Aligned drawing view "${view}" exact HLR path count`,
        { minimum: 1, maximum: 100_000 },
      );
      const deliveredHlrPaths = [
        ...(Array.isArray(source.visible) ? source.visible.map(String) : []),
        ...(Array.isArray(source.hidden) ? source.hidden.map(String) : []),
      ];
      if (alignedHlrPathCount !== evidence.exact.objectHlrPaths.pathCount
        || alignedHlrPathCount !== evidence.exact.deliveredPaths.pathCount
        || stableEvidenceSource(evidence.exact.objectHlrPaths) !== stableEvidenceSource(evidence.section.objectHlrPaths)
        || stableEvidenceSource(evidence.exact.preUnfoldPaths) !== stableEvidenceSource(evidence.section.preUnfoldPaths)
        || stableEvidenceSource(evidence.exact.objectHlrPaths) !== stableEvidenceSource(evidence.exact.deliveredPaths)
        || evidence.exact.preUnfoldPaths.pathHash === evidence.exact.deliveredPaths.pathHash
        || stableEvidenceHash(deliveredHlrPaths) === stableEvidenceHash(sectionPaths)) {
        fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Aligned drawing view "${view}" must deliver authenticated unfolded regional object HLR in addition to section contours.`);
      }
      evidence.exact.alignedHlrPathCount = alignedHlrPathCount;
    }
  } else if (sectionPaths.length) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Non-section drawing view "${view}" cannot supply section contours.`);
  }
  if (['detail', 'crop', 'broken-out-section'].includes(viewKind)) {
    if (!evidence.clip) fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Derived drawing view "${view}" requires exact clipping evidence.`);
    const expectedClipOperation = viewKind === 'broken-out-section' ? 'exact-profile-prism-cut' : 'exact-hlr-boundary-clip';
    if (evidence.clip.operation !== expectedClipOperation
      || stableEvidenceSource(evidence.clip.boundary) !== stableEvidenceSource(persisted.definition.boundary)) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Derived drawing view "${view}" clipping evidence does not match its persistent boundary.`);
    }
    const resultViewBox = evidenceBox(evidence.clip.resultViewBox, `Derived drawing view "${view}" clipped result bounds`);
    if (!sameTuple(resultViewBox, viewBox, 1e-7)) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Derived drawing view "${view}" clipped bounds do not match its exact paths.`);
    }
    if (viewKind === 'broken-out-section') {
      const sourceDepthRange = evidenceTuple(evidence.clip.sourceDepthRange, 2, `Broken-out drawing view "${view}" source depth range`);
      const worldAabbDepthRange = evidenceTuple(evidence.clip.worldAabbDepthRange, 2, `Broken-out drawing view "${view}" world-AABB depth range`);
      const toolDepthRange = evidenceTuple(evidence.clip.toolDepthRange, 2, `Broken-out drawing view "${view}" exact tool depth range`);
      const frontDepth = evidenceNumber(evidence.clip.frontDepth, `Broken-out drawing view "${view}" exact front depth`);
      const endDepth = evidenceNumber(evidence.clip.endDepth, `Broken-out drawing view "${view}" exact end depth`);
      const deliveredFrame = evidenceRecord(source.frame, `Broken-out drawing view "${view}" delivered source frame`);
      const frameDirection = evidenceTuple(deliveredFrame.direction, 3, `Broken-out drawing view "${view}" source direction`);
      const frameXAxis = evidenceTuple(deliveredFrame.xAxis, 3, `Broken-out drawing view "${view}" source x-axis`);
      const cameraTransform = validatedAlignmentTransforms(
        [evidence.clip.cameraTransform], 1, `Broken-out drawing view "${view}" exact camera-frame transform`,
      )[0];
      const depthPlane = evidenceRecord(evidence.section.depthPlane, `Broken-out drawing view "${view}" exact depth plane`);
      depthPlane.origin = evidenceTuple(depthPlane.origin, 3, `Broken-out drawing view "${view}" exact depth-plane origin`);
      depthPlane.normal = evidenceTuple(depthPlane.normal, 3, `Broken-out drawing view "${view}" exact depth-plane normal`);
      depthPlane.xAxis = evidenceTuple(depthPlane.xAxis, 3, `Broken-out drawing view "${view}" exact depth-plane x-axis`);
      depthPlane.yAxis = evidenceTuple(depthPlane.yAxis, 3, `Broken-out drawing view "${view}" exact depth-plane y-axis`);
      const planeRecords = Array.isArray(evidence.section.planes) ? evidence.section.planes : [];
      const contourPlane = planeRecords.length === 1
        ? evidenceRecord(planeRecords[0]?.plane, `Broken-out drawing view "${view}" authenticated contour plane`)
        : null;
      const expectedDepthOrigin = frameDirection.map((component) => component * endDepth);
      const frameDot = frameDirection.reduce((sum, component, index) => sum + component * frameXAxis[index], 0);
      const frameDirectionLength = Math.hypot(...frameDirection);
      const frameXAxisLength = Math.hypot(...frameXAxis);
      if (evidence.clip.rangeMethod !== 'rigid-camera-frame-AddOptimal'
        || evidence.clip.depthRelation !== 'end-depth=front-depth+persisted-depth-mm'
        || !nearlyEqual(evidence.clip.depthMm, persisted.definition.depthMm)
        || !nearlyEqual(evidence.section.depthMm, persisted.definition.depthMm)
        || !(sourceDepthRange[1] > sourceDepthRange[0]) || !(worldAabbDepthRange[1] > worldAabbDepthRange[0])
        || !nearlyEqual(frontDepth, sourceDepthRange[0], 1e-7)
        || !nearlyEqual(endDepth, frontDepth + persisted.definition.depthMm, 1e-7)
        || !(endDepth > frontDepth) || endDepth > sourceDepthRange[1] + 1e-7
        || !(toolDepthRange[0] < frontDepth) || !nearlyEqual(toolDepthRange[1], endDepth, 1e-7)
        || !nearlyEqual(frameDirectionLength, 1, 1e-7) || !nearlyEqual(frameXAxisLength, 1, 1e-7)
        || Math.abs(frameDot) > 1e-7
        || !sameTuple(cameraTransform.sourceAnchor, [0, 0, 0], 1e-9)
        || !sameTuple(cameraTransform.targetAnchor, [0, 0, 0], 1e-9)
        || !sameTuple(cameraTransform.sourceNormal, frameDirection, 1e-7)
        || !sameTuple(cameraTransform.sourceXAxis, frameXAxis, 1e-7)
        || !sameTuple(cameraTransform.targetNormal, [0, 0, 1], 1e-7)
        || !sameTuple(cameraTransform.targetXAxis, [1, 0, 0], 1e-7)
        || depthPlane.keepSide !== 'negative'
        || !sameTuple(depthPlane.origin, expectedDepthOrigin, 1e-7)
        || !sameTuple(depthPlane.normal, frameDirection, 1e-7)
        || !sameTuple(depthPlane.xAxis, frameXAxis, 1e-7)
        || !contourPlane || stableEvidenceSource(contourPlane) !== stableEvidenceSource(depthPlane)) {
        fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Broken-out drawing view "${view}" has stale exact depth evidence.`);
      }
      evidence.clip.sourceDepthRange = sourceDepthRange;
      evidence.clip.worldAabbDepthRange = worldAabbDepthRange;
      evidence.clip.toolDepthRange = toolDepthRange;
      evidence.clip.frontDepth = frontDepth;
      evidence.clip.endDepth = endDepth;
      evidence.clip.cameraTransform = cameraTransform;
      evidence.section.depthPlane = depthPlane;
    } else {
      evidenceTuple(evidence.clip.sourceViewBounds, 4, `Derived drawing view "${view}" source view bounds`);
      const expectedMagnification = viewKind === 'detail' ? persisted.definition.magnification : 1;
      if (!nearlyEqual(evidence.clip.magnification, expectedMagnification)) {
        fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Derived drawing view "${view}" has stale magnification evidence.`);
      }
      evidence.clip.sourcePaths = validatedPathEvidence(
        evidence.clip.sourcePaths,
        `Derived drawing view "${view}" source HLR paths`,
      );
      evidence.clip.resultPaths = validatedPathEvidence(
        evidence.clip.resultPaths,
        `Derived drawing view "${view}" clipped HLR paths`,
        { source, viewBox },
      );
      evidence.exact.sourcePaths = validatedPathEvidence(
        evidence.exact.sourcePaths,
        `Derived drawing view "${view}" exact source HLR paths`,
      );
      evidence.exact.resultPaths = validatedPathEvidence(
        evidence.exact.resultPaths,
        `Derived drawing view "${view}" exact clipped HLR paths`,
        { source, viewBox },
      );
      if (stableEvidenceSource(evidence.clip.sourcePaths) !== stableEvidenceSource(evidence.exact.sourcePaths)
        || stableEvidenceSource(evidence.clip.resultPaths) !== stableEvidenceSource(evidence.exact.resultPaths)) {
        fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Derived drawing view "${view}" has inconsistent exact clipping path evidence.`);
      }
    }
  }
  const boundaryKind = evidence.clip?.boundary?.kind ?? evidence.presentation?.boundaryKind;
  if (boundaryKind != null && !['rect', 'circle'].includes(String(boundaryKind))) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Derived drawing view "${view}" has unsupported boundary presentation evidence.`);
  }
  if (viewKind === 'break') {
    const axis = String(evidence.break?.axis || '');
    const definition = persisted.definition;
    if (!evidence.break || evidence.break.operation !== 'exact-hlr-band-map'
      || axis !== definition.axis || !['x', 'y'].includes(axis)
      || !nearlyEqual(evidence.break.start, definition.start) || !nearlyEqual(evidence.break.end, definition.end)
      || !nearlyEqual(evidence.break.gapMm, definition.gapMm)
      || !nearlyEqual(evidence.break.removedSpanMm, definition.end - definition.start)
      || !nearlyEqual(evidence.break.translationMm, definition.end - definition.start - definition.gapMm)
      || evidenceInteger(evidence.break.pieceCount, `Break drawing view "${view}" piece count`, { minimum: 2, maximum: 2 }) !== 2) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Break drawing view "${view}" does not match its persistent piecewise mapping.`);
    }
    evidence.break.sourcePaths = validatedPathEvidence(
      evidence.break.sourcePaths,
      `Break drawing view "${view}" source HLR paths`,
    );
    evidence.break.resultPaths = validatedPathEvidence(
      evidence.break.resultPaths,
      `Break drawing view "${view}" mapped HLR paths`,
      { source, viewBox },
    );
    evidence.exact.sourcePaths = validatedPathEvidence(
      evidence.exact.sourcePaths,
      `Break drawing view "${view}" exact source HLR paths`,
    );
    evidence.exact.resultPaths = validatedPathEvidence(
      evidence.exact.resultPaths,
      `Break drawing view "${view}" exact mapped HLR paths`,
      { source, viewBox },
    );
    if (stableEvidenceSource(evidence.break.sourcePaths) !== stableEvidenceSource(evidence.exact.sourcePaths)
      || stableEvidenceSource(evidence.break.resultPaths) !== stableEvidenceSource(evidence.exact.resultPaths)) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Break drawing view "${view}" has inconsistent exact path mapping evidence.`);
    }
    evidenceTuple(evidence.break.sourceViewBounds, 4, `Break drawing view "${view}" source bounds`);
    const resultViewBox = evidenceBox(evidence.break.resultViewBox, `Break drawing view "${view}" result bounds`);
    const mappedBoundaries = evidenceTuple(evidence.break.mappedBoundaries, 2, `Break drawing view "${view}" mapped boundaries`);
    const exactMappedBoundaries = evidenceTuple(evidence.exact.mappedBoundaries, 2, `Break drawing view "${view}" exact mapped boundaries`);
    const axisOffset = axis === 'x' ? 0 : 1;
    const axisExtent = axis === 'x' ? 2 : 3;
    if (!sameTuple(resultViewBox, viewBox, 1e-7) || !sameTuple(mappedBoundaries, exactMappedBoundaries, 1e-9)
      || !(mappedBoundaries[1] > mappedBoundaries[0])
      || !nearlyEqual(mappedBoundaries[1] - mappedBoundaries[0], definition.gapMm)
      || mappedBoundaries[0] < viewBox[axisOffset] - 1e-7
      || mappedBoundaries[1] > viewBox[axisOffset] + viewBox[axisExtent] + 1e-7) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Break drawing view "${view}" has invalid authenticated mapped boundaries.`);
    }
    evidence.break.mappedBoundaries = mappedBoundaries;
  }
  return evidence;
}

function validatedViews(response, project = null) {
  if (!response || typeof response !== 'object' || !Array.isArray(response.views) || !response.views.length || response.errors?.length) {
    fail('DRAWING_PDF_INVALID', 'An exact drawing result with at least one view is required.');
  }
  if (response.views.length > 16) fail('DRAWING_PDF_LIMIT_EXCEEDED', 'Drawing PDF supports at most 16 exact views.');
  const needsDerivedContext = response.views.some((entry) => entry?.derivedEvidence != null
    || /^drawing-derived-view-\d{6}$/u.test(String(entry?.view || ''))
    || (Array.isArray(entry?.sectionPaths) && entry.sectionPaths.length));
  const currentProject = needsDerivedContext ? currentDerivedViewContext(project) : null;
  const views = [];
  const names = new Set();
  let pathCount = 0;
  let pathCharacters = 0;
  for (const source of response.views) {
    const view = String(source?.view || '');
    const viewBox = Array.isArray(source?.viewBox) ? source.viewBox.map(Number) : [];
    if (!view || names.has(view) || viewBox.length !== 4 || viewBox.some((entry) => !Number.isFinite(entry)) || viewBox[2] <= 0 || viewBox[3] <= 0) {
      fail('DRAWING_PDF_INVALID', 'Drawing view identity or bounds are invalid.');
    }
    const visible = Array.isArray(source.visible) ? source.visible.map(String) : [];
    const hidden = Array.isArray(source.hidden) ? source.hidden.map(String) : [];
    const regularVisible = Array.isArray(source.regularVisible) ? source.regularVisible.map(String) : visible;
    const regularHidden = Array.isArray(source.regularHidden) ? source.regularHidden.map(String) : hidden;
    const tangentVisible = Array.isArray(source.tangentVisible) ? source.tangentVisible.map(String) : [];
    const tangentHidden = Array.isArray(source.tangentHidden) ? source.tangentHidden.map(String) : [];
    const sectionPaths = Array.isArray(source.sectionPaths) ? source.sectionPaths.map(String) : [];
    if (!visible.length || [...visible, ...hidden].some((entry) => !entry.trim() || entry.length > 1_000_000)) {
      fail('DRAWING_PDF_INVALID', `Drawing view "${view}" has no bounded exact HLR paths.`);
    }
    if (sectionPaths.some((entry) => !entry.trim() || entry.length > 1_000_000)) {
      fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Drawing view "${view}" has invalid bounded section contours.`);
    }
    const derivedEvidence = validatedDerivedEvidence(source, response, sectionPaths, viewBox, currentProject);
    pathCount += visible.length + hidden.length + sectionPaths.length;
    pathCharacters += [...visible, ...hidden, ...sectionPaths].reduce((sum, entry) => sum + entry.length, 0);
    if (pathCount > 100_000 || pathCharacters > 16 * 1024 * 1024) {
      fail('DRAWING_PDF_LIMIT_EXCEEDED', 'Drawing PDF exact paths exceed the bounded output limit.');
    }
    names.add(view);
    views.push({
      view, name: String(source.name || view), frame: structuredClone(source.frame || null), viewBox,
      visible, hidden, regularVisible, regularHidden, tangentVisible, tangentHidden,
      sectionPaths, derivedEvidence,
    });
  }
  return views;
}

function validatedAlignments(value, views) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > Math.max(0, views.length - 1)) fail('DRAWING_ALIGNMENT_INVALID', 'View alignments must form a bounded graph.');
  const ids = new Set(views.map((entry) => entry.view));
  const children = new Set();
  const parentAxes = new Set();
  const result = value.map((entry) => {
    const parentView = String(entry?.parentView || '');
    const childView = String(entry?.childView || '');
    const axis = String(entry?.axis || '');
    const gapMm = entry?.gapMm == null ? 12 : Number(entry.gapMm);
    const parentAxis = `${parentView}:${axis}`;
    if (!ids.has(parentView) || !ids.has(childView) || parentView === childView || children.has(childView) || parentAxes.has(parentAxis)
      || !['horizontal', 'vertical'].includes(axis) || !Number.isFinite(gapMm) || gapMm < 2 || gapMm > 100) {
      fail('DRAWING_ALIGNMENT_INVALID', 'Each alignment requires distinct view ids, one parent per child and axis, and a 2 to 100 millimetre gap.');
    }
    children.add(childView);
    parentAxes.add(parentAxis);
    return { parentView, childView, axis, gapMm };
  });
  const parents = new Map(result.map((entry) => [entry.childView, entry.parentView]));
  for (const view of views) {
    const seen = new Set();
    let current = view.view;
    while (parents.has(current)) {
      if (seen.has(current)) fail('DRAWING_ALIGNMENT_INVALID', 'View alignments cannot contain a cycle.');
      seen.add(current);
      current = parents.get(current);
    }
  }
  return result;
}

function alignedLayout(views, options, sheet) {
  const margin = Math.max(7, Math.min(12, Math.min(sheet.widthMm, sheet.heightMm) * 0.06));
  const titleSpace = Math.min(34, sheet.heightMm * 0.17);
  const availableWidth = sheet.widthMm - margin * 2;
  const availableHeight = sheet.heightMm - margin * 2 - titleSpace;
  if (availableWidth <= 0 || availableHeight <= 0) fail('DRAWING_SHEET_INVALID', 'Drawing sheet has no usable aligned-view area.');
  const authored = validatedAlignments(options.alignments, views);
  const alignments = authored.length ? authored : views.slice(1).map((entry, index) => ({
    parentView: views[index].view, childView: entry.view, axis: 'horizontal', gapMm: 12,
  }));
  const byId = new Map(views.map((entry) => [entry.view, entry]));
  const childIds = new Set(alignments.map((entry) => entry.childView));
  const children = new Map();
  for (const entry of alignments) {
    if (!children.has(entry.parentView)) children.set(entry.parentView, []);
    children.get(entry.parentView).push(entry);
  }
  const roots = views.filter((entry) => !childIds.has(entry.view));
  const arrange = (scale) => {
    const positions = new Map();
    let componentCursor = 0;
    for (const root of roots) {
      positions.set(root.view, { x: 0, y: 0 });
      const queue = [root.view];
      while (queue.length) {
        const parentId = queue.shift();
        const parent = byId.get(parentId);
        const parentPosition = positions.get(parentId);
        for (const relation of children.get(parentId) || []) {
          const child = byId.get(relation.childView);
          const parentWidth = parent.viewBox[2] * scale;
          const parentHeight = parent.viewBox[3] * scale;
          const childWidth = child.viewBox[2] * scale;
          const childHeight = child.viewBox[3] * scale;
          positions.set(child.view, relation.axis === 'horizontal'
            ? { x: parentPosition.x + parentWidth + relation.gapMm, y: parentPosition.y + (parentHeight - childHeight) / 2 }
            : { x: parentPosition.x + (parentWidth - childWidth) / 2, y: parentPosition.y - relation.gapMm - childHeight });
          queue.push(child.view);
        }
      }
      const componentIds = [...positions.keys()].filter((id) => {
        let current = id;
        const parents = new Map(alignments.map((entry) => [entry.childView, entry.parentView]));
        while (parents.has(current)) current = parents.get(current);
        return current === root.view;
      });
      const minimumX = Math.min(...componentIds.map((id) => positions.get(id).x));
      const maximumX = Math.max(...componentIds.map((id) => positions.get(id).x + byId.get(id).viewBox[2] * scale));
      for (const id of componentIds) positions.get(id).x += componentCursor - minimumX;
      componentCursor += maximumX - minimumX + 12;
    }
    const minimumX = Math.min(...views.map((entry) => positions.get(entry.view).x));
    const minimumY = Math.min(...views.map((entry) => positions.get(entry.view).y));
    const maximumX = Math.max(...views.map((entry) => positions.get(entry.view).x + entry.viewBox[2] * scale));
    const maximumY = Math.max(...views.map((entry) => positions.get(entry.view).y + entry.viewBox[3] * scale));
    return { positions, width: maximumX - minimumX, height: maximumY - minimumY, minimumX, minimumY };
  };
  const requested = options.scale == null || options.scale === 'fit' ? null : finite(options.scale, 'Drawing scale');
  if (requested != null && !STUDIO_DRAWING_SCALES.includes(requested)) fail('DRAWING_PDF_INVALID', 'Drawing scale is unsupported.');
  const candidateScales = requested == null ? STUDIO_DRAWING_SCALES : [requested];
  let selected = null;
  let arranged = null;
  for (const scale of candidateScales) {
    const candidate = arrange(scale);
    if (candidate.width <= availableWidth + 1e-9 && candidate.height <= availableHeight + 1e-9) {
      selected = scale;
      arranged = candidate;
      break;
    }
  }
  if (selected == null || !arranged) fail('DRAWING_SCALE_DOES_NOT_FIT', 'Requested aligned drawing views do not fit the selected sheet.');
  const offsetX = margin + (availableWidth - arranged.width) / 2 - arranged.minimumX;
  const offsetY = margin + (availableHeight - arranged.height) / 2 - arranged.minimumY;
  const placements = views.map((entry) => {
    const position = arranged.positions.get(entry.view);
    return { view: entry.view, source: entry, x: position.x + offsetX, y: position.y + offsetY, width: entry.viewBox[2] * selected, height: entry.viewBox[3] * selected };
  });
  const placementById = new Map(placements.map((entry) => [entry.view, entry]));
  const alignmentEvidence = alignments.map((entry) => {
    const parent = placementById.get(entry.parentView);
    const child = placementById.get(entry.childView);
    return {
      ...entry,
      parentBounds: [parent.x, parent.y, parent.width, parent.height],
      childBounds: [child.x, child.y, child.width, child.height],
      parentCenter: [parent.x + parent.width / 2, parent.y + parent.height / 2],
      childCenter: [child.x + child.width / 2, child.y + child.height / 2],
      measuredGapMm: entry.axis === 'horizontal'
        ? child.x - (parent.x + parent.width)
        : parent.y - (child.y + child.height),
    };
  });
  return {
    schema: STUDIO_DRAWING_PDF_SCHEMA, sheet, scale: selected, scaleLabel: standardScaleLabel(selected),
    maximumScale: selected, placements, frontPlacement: placementById.get('front') || null,
    margin, gap: 12, alignmentEvidence, layoutMode: 'aligned', tangentEdges: tangentEdgeMode(options.tangentEdges),
    drawingStyle: drawingStyle(options.drawingStyle),
    drawingAnnotations: drawingAnnotations(options.drawingAnnotations),
    drawingTables: drawingTables(options.drawingTables),
  };
}

export function layoutStudioDrawingPdf(response, options = {}) {
  const views = validatedViews(response, options.project || null);
  const byView = new Map(views.map((entry) => [entry.view, entry]));
  const front = byView.get('front') || views.find((entry) => entry.view !== 'iso') || views[0];
  const top = byView.get('top')?.view === front.view ? null : byView.get('top');
  const right = byView.get('right')?.view === front.view ? null : byView.get('right');
  const iso = byView.get('iso')?.view === front.view ? null : byView.get('iso');
  const sheetWidth = options.sheetWidthMm == null ? DEFAULT_SHEET_WIDTH_MM : finite(options.sheetWidthMm, 'Sheet width');
  const sheetHeight = options.sheetHeightMm == null ? DEFAULT_SHEET_HEIGHT_MM : finite(options.sheetHeightMm, 'Sheet height');
  if (sheetWidth < 100 || sheetWidth > 2_000 || sheetHeight < 100 || sheetHeight > 2_000) {
    fail('DRAWING_SHEET_INVALID', 'Drawing sheet dimensions must be between 100 and 2,000 millimetres.');
  }
  const sheet = {
    standard: String(options.sheetStandard || 'ISO 216'),
    size: String(options.sheetSize || (sheetWidth === 297 && sheetHeight === 210 ? 'A4' : 'Custom')),
    orientation: sheetWidth >= sheetHeight ? 'landscape' : 'portrait',
    widthMm: sheetWidth,
    heightMm: sheetHeight,
    projection: options.projection === 'first-angle' ? 'first-angle' : 'third-angle',
  };
  if ((Array.isArray(options.alignments) && options.alignments.length) || views.some((entry) => !['front', 'top', 'right', 'iso'].includes(entry.view))) {
    return alignedLayout(views, options, sheet);
  }
  const margin = Math.max(7, Math.min(12, Math.min(sheetWidth, sheetHeight) * 0.06));
  const gap = Math.min(18, sheetWidth * 0.06);
  const isoAreaWidth = iso ? Math.min(70, sheetWidth * 0.25) : 0;
  const dimensionSpace = Math.min(26, sheetWidth * 0.09);
  const titleSpace = Math.min(34, sheetHeight * 0.17);
  const frontWidth = front.viewBox[2];
  const frontHeight = front.viewBox[3];
  const topHeight = top?.viewBox[3] || 0;
  const rightWidth = right?.viewBox[2] || 0;
  const availableWidth = sheetWidth - margin * 2 - isoAreaWidth - (right ? gap : 0) - dimensionSpace;
  const availableHeight = sheetHeight - margin * 2 - (top ? gap : 0) - titleSpace;
  if (availableWidth <= 0 || availableHeight <= 0) fail('DRAWING_SHEET_INVALID', 'Drawing sheet has no usable view area.');
  const orthographicMaximumScale = Math.min(
    availableWidth / Math.max(1e-6, frontWidth + rightWidth),
    availableHeight / Math.max(1e-6, frontHeight + topHeight),
  );
  const isometricMaximumScale = iso
    ? Math.min((isoAreaWidth - 4) / Math.max(1e-6, iso.viewBox[2]), Math.min(70, sheetHeight * 0.34) / Math.max(1e-6, iso.viewBox[3]))
    : Number.POSITIVE_INFINITY;
  const maximumScale = Math.min(orthographicMaximumScale, isometricMaximumScale);
  const requested = options.scale == null || options.scale === 'fit' ? null : finite(options.scale, 'Drawing scale');
  if (requested != null && (!STUDIO_DRAWING_SCALES.includes(requested) || requested > maximumScale + 1e-9)) {
    fail('DRAWING_SCALE_DOES_NOT_FIT', `Requested drawing scale ${standardScaleLabel(requested)} does not fit the selected sheet.`, {
      requested,
      maximumScale,
    });
  }
  const scale = requested || STUDIO_DRAWING_SCALES.find((entry) => entry <= maximumScale) || STUDIO_DRAWING_SCALES.at(-1);
  const placements = [];
  const place = (entry, x, y) => {
    if (!entry) return null;
    const placement = {
      view: entry.view,
      source: entry,
      x,
      y,
      width: entry.viewBox[2] * scale,
      height: entry.viewBox[3] * scale,
    };
    placements.push(placement);
    return placement;
  };
  const frontX = margin + 14;
  const frontY = sheetHeight - margin - Math.min(30, titleSpace - 4) - frontHeight * scale;
  const frontPlacement = place(front, frontX, frontY);
  place(top, frontX, frontY - gap - topHeight * scale);
  if (right) place(right, frontPlacement.x + frontPlacement.width + gap, frontY + frontHeight * scale - right.viewBox[3] * scale);
  if (iso) place(iso, sheetWidth - margin - isoAreaWidth + 4, margin + 6);
  return {
    schema: STUDIO_DRAWING_PDF_SCHEMA,
    sheet,
    scale,
    scaleLabel: standardScaleLabel(scale),
    maximumScale,
    placements,
    frontPlacement,
    margin,
    gap,
    alignmentEvidence: [],
    layoutMode: 'standard',
    tangentEdges: tangentEdgeMode(options.tangentEdges),
    drawingStyle: drawingStyle(options.drawingStyle),
    drawingAnnotations: drawingAnnotations(options.drawingAnnotations),
    drawingTables: drawingTables(options.drawingTables),
  };
}

function tokenizePath(path) {
  const source = String(path);
  const pattern = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][-+]?\d+)?/gu;
  const tokens = source.match(pattern) || [];
  if (!tokens.length) fail('DRAWING_PATH_INVALID', 'Exact HLR path is empty or unsupported.');
  if (source.replace(pattern, '').replace(/[\s,]+/gu, '')) fail('DRAWING_PATH_INVALID', 'Exact HLR path contains unsupported syntax.');
  return tokens;
}

const isCommand = (value) => /^[A-Za-z]$/u.test(value);

function arcSegments(start, values) {
  let [rx, ry, angle, largeArc, sweep, endX, endY] = values;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry || (start[0] === endX && start[1] === endY)) return [{ line: [endX, endY] }];
  const phi = angle * Math.PI / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (start[0] - endX) / 2;
  const dy = (start[1] - endY) / 2;
  const xPrime = cosPhi * dx + sinPhi * dy;
  const yPrime = -sinPhi * dx + cosPhi * dy;
  const radii = (xPrime * xPrime) / (rx * rx) + (yPrime * yPrime) / (ry * ry);
  if (radii > 1) {
    const factor = Math.sqrt(radii);
    rx *= factor;
    ry *= factor;
  }
  const numerator = Math.max(0, rx * rx * ry * ry - rx * rx * yPrime * yPrime - ry * ry * xPrime * xPrime);
  const denominator = rx * rx * yPrime * yPrime + ry * ry * xPrime * xPrime;
  const sign = Number(Boolean(largeArc)) === Number(Boolean(sweep)) ? -1 : 1;
  const coefficient = denominator ? sign * Math.sqrt(numerator / denominator) : 0;
  const centerPrimeX = coefficient * (rx * yPrime / ry);
  const centerPrimeY = coefficient * (-ry * xPrime / rx);
  const centerX = cosPhi * centerPrimeX - sinPhi * centerPrimeY + (start[0] + endX) / 2;
  const centerY = sinPhi * centerPrimeX + cosPhi * centerPrimeY + (start[1] + endY) / 2;
  const vectorAngle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const startVector = [(xPrime - centerPrimeX) / rx, (yPrime - centerPrimeY) / ry];
  const endVector = [(-xPrime - centerPrimeX) / rx, (-yPrime - centerPrimeY) / ry];
  let theta = Math.atan2(startVector[1], startVector[0]);
  let delta = vectorAngle(startVector[0], startVector[1], endVector[0], endVector[1]);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;
  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / count;
  const transform = (x, y) => [centerX + rx * cosPhi * x - ry * sinPhi * y, centerY + rx * sinPhi * x + ry * cosPhi * y];
  const derivative = (at) => [-rx * cosPhi * Math.sin(at) - ry * sinPhi * Math.cos(at), -rx * sinPhi * Math.sin(at) + ry * cosPhi * Math.cos(at)];
  const segments = [];
  for (let index = 0; index < count; index++) {
    const from = theta + step * index;
    const to = from + step;
    const alpha = 4 / 3 * Math.tan(step / 4);
    const p0 = transform(Math.cos(from), Math.sin(from));
    const p3 = transform(Math.cos(to), Math.sin(to));
    const d0 = derivative(from);
    const d1 = derivative(to);
    segments.push({ cubic: [p0[0] + alpha * d0[0], p0[1] + alpha * d0[1], p3[0] - alpha * d1[0], p3[1] - alpha * d1[1], p3[0], p3[1]] });
  }
  return segments;
}

function pdfPath(path, placement) {
  const tokens = tokenizePath(path);
  const box = placement.source.viewBox;
  const map = (x, y) => point(
    placement.x + (x - box[0]) * placement.scale,
    placement.y + (y - box[1]) * placement.scale,
    placement.sheetHeight,
  );
  const output = [];
  let index = 0;
  let command = null;
  let current = [0, 0];
  let subpath = [0, 0];
  let lastCubicControl = null;
  let lastQuadraticControl = null;
  const take = (count) => {
    if (index + count > tokens.length || tokens.slice(index, index + count).some(isCommand)) fail('DRAWING_PATH_INVALID', 'Exact HLR path has incomplete coordinates.');
    const values = tokens.slice(index, index + count).map(Number);
    if (values.some((entry) => !Number.isFinite(entry))) fail('DRAWING_PATH_INVALID', 'Exact HLR path contains non-finite coordinates.');
    index += count;
    return values;
  };
  const emitPoint = (operator, x, y) => {
    const mapped = map(x, y);
    output.push(`${fmt(mapped[0])} ${fmt(mapped[1])} ${operator}`);
  };
  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = tokens[index++];
    if (!command) fail('DRAWING_PATH_INVALID', 'Exact HLR path must begin with a command.');
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    if (upper === 'Z') {
      output.push('h');
      current = [...subpath];
      lastCubicControl = null;
      lastQuadraticControl = null;
      command = null;
      continue;
    }
    if (upper === 'M' || upper === 'L' || upper === 'T') {
      const values = take(2);
      const target = [values[0] + (relative ? current[0] : 0), values[1] + (relative ? current[1] : 0)];
      if (upper === 'M') {
        emitPoint('m', target[0], target[1]);
        subpath = [...target];
        command = relative ? 'l' : 'L';
      } else if (upper === 'L') {
        emitPoint('l', target[0], target[1]);
      } else {
        const control = lastQuadraticControl ? [2 * current[0] - lastQuadraticControl[0], 2 * current[1] - lastQuadraticControl[1]] : [...current];
        const c1 = [current[0] + 2 / 3 * (control[0] - current[0]), current[1] + 2 / 3 * (control[1] - current[1])];
        const c2 = [target[0] + 2 / 3 * (control[0] - target[0]), target[1] + 2 / 3 * (control[1] - target[1])];
        const mapped = [...map(...c1), ...map(...c2), ...map(...target)];
        output.push(`${mapped.map(fmt).join(' ')} c`);
        lastQuadraticControl = control;
      }
      current = target;
      if (upper !== 'T') lastQuadraticControl = null;
      lastCubicControl = null;
      continue;
    }
    if (upper === 'H' || upper === 'V') {
      const value = take(1)[0];
      current = upper === 'H' ? [value + (relative ? current[0] : 0), current[1]] : [current[0], value + (relative ? current[1] : 0)];
      emitPoint('l', current[0], current[1]);
      lastCubicControl = null;
      lastQuadraticControl = null;
      continue;
    }
    if (upper === 'C' || upper === 'S') {
      const values = take(upper === 'C' ? 6 : 4);
      const first = upper === 'C'
        ? [values[0] + (relative ? current[0] : 0), values[1] + (relative ? current[1] : 0)]
        : lastCubicControl ? [2 * current[0] - lastCubicControl[0], 2 * current[1] - lastCubicControl[1]] : [...current];
      const offset = upper === 'C' ? 2 : 0;
      const second = [values[offset] + (relative ? current[0] : 0), values[offset + 1] + (relative ? current[1] : 0)];
      const target = [values[offset + 2] + (relative ? current[0] : 0), values[offset + 3] + (relative ? current[1] : 0)];
      const mapped = [...map(...first), ...map(...second), ...map(...target)];
      output.push(`${mapped.map(fmt).join(' ')} c`);
      current = target;
      lastCubicControl = second;
      lastQuadraticControl = null;
      continue;
    }
    if (upper === 'Q') {
      const values = take(4);
      const control = [values[0] + (relative ? current[0] : 0), values[1] + (relative ? current[1] : 0)];
      const target = [values[2] + (relative ? current[0] : 0), values[3] + (relative ? current[1] : 0)];
      const c1 = [current[0] + 2 / 3 * (control[0] - current[0]), current[1] + 2 / 3 * (control[1] - current[1])];
      const c2 = [target[0] + 2 / 3 * (control[0] - target[0]), target[1] + 2 / 3 * (control[1] - target[1])];
      const mapped = [...map(...c1), ...map(...c2), ...map(...target)];
      output.push(`${mapped.map(fmt).join(' ')} c`);
      current = target;
      lastQuadraticControl = control;
      lastCubicControl = null;
      continue;
    }
    if (upper === 'A') {
      const values = take(7);
      if (![0, 1].includes(values[3]) || ![0, 1].includes(values[4]) || values[0] < 0 || values[1] < 0) {
        fail('DRAWING_PATH_INVALID', 'Exact HLR elliptical arc flags or radii are invalid.');
      }
      const target = [values[5] + (relative ? current[0] : 0), values[6] + (relative ? current[1] : 0)];
      for (const segment of arcSegments(current, [...values.slice(0, 5), ...target])) {
        if (segment.line) emitPoint('l', segment.line[0], segment.line[1]);
        else {
          const mapped = [
            ...map(segment.cubic[0], segment.cubic[1]),
            ...map(segment.cubic[2], segment.cubic[3]),
            ...map(segment.cubic[4], segment.cubic[5]),
          ];
          output.push(`${mapped.map(fmt).join(' ')} c`);
        }
      }
      current = target;
      lastCubicControl = null;
      lastQuadraticControl = null;
      continue;
    }
    fail('DRAWING_PATH_INVALID', `Exact HLR path command "${command}" is unsupported.`);
  }
  return output.join('\n');
}

function lineCommand(x0, y0, x1, y1, sheetHeight) {
  const a = point(x0, y0, sheetHeight);
  const b = point(x1, y1, sheetHeight);
  return `${fmt(a[0])} ${fmt(a[1])} m ${fmt(b[0])} ${fmt(b[1])} l S`;
}

function circleCommand(centerX, centerY, radius, sheetHeight) {
  const k = 0.552284749831;
  const points = [
    point(centerX + radius, centerY, sheetHeight),
    point(centerX + radius, centerY - k * radius, sheetHeight), point(centerX + k * radius, centerY - radius, sheetHeight), point(centerX, centerY - radius, sheetHeight),
    point(centerX - k * radius, centerY - radius, sheetHeight), point(centerX - radius, centerY - k * radius, sheetHeight), point(centerX - radius, centerY, sheetHeight),
    point(centerX - radius, centerY + k * radius, sheetHeight), point(centerX - k * radius, centerY + radius, sheetHeight), point(centerX, centerY + radius, sheetHeight),
    point(centerX + k * radius, centerY + radius, sheetHeight), point(centerX + radius, centerY + k * radius, sheetHeight), point(centerX + radius, centerY, sheetHeight),
  ];
  return `${fmt(points[0][0])} ${fmt(points[0][1])} m\n`
    + `${points.slice(1, 4).flat().map(fmt).join(' ')} c\n`
    + `${points.slice(4, 7).flat().map(fmt).join(' ')} c\n`
    + `${points.slice(7, 10).flat().map(fmt).join(' ')} c\n`
    + `${points.slice(10, 13).flat().map(fmt).join(' ')} c h S`;
}

function rectangleCommand(x, y, width, height, mode = 'S', sheetHeight) {
  const lower = point(x, y + height, sheetHeight);
  return `${fmt(lower[0])} ${fmt(lower[1])} ${fmt(width * MM_TO_PT)} ${fmt(height * MM_TO_PT)} re ${mode}`;
}

function textCommand(value, x, y, sizePt = 8, align = 'left', sheetHeight, color = [0.12, 0.16, 0.2]) {
  const [px, py] = point(x, y, sheetHeight);
  const safe = pdfText(value);
  const approximateWidth = safe.length * sizePt * 0.5;
  const adjusted = align === 'center' ? px - approximateWidth / 2 : align === 'right' ? px - approximateWidth : px;
  return `BT /F1 ${fmt(sizePt)} Tf ${color.map(fmt).join(' ')} rg 1 0 0 1 ${fmt(adjusted)} ${fmt(py)} Tm (${safe}) Tj ET`;
}

function derivedViewLabel(source) {
  const labels = {
    'full-section': 'FULL SECTION',
    'half-section': 'HALF SECTION',
    'aligned-section': 'ALIGNED SECTION',
    'broken-out-section': 'BROKEN-OUT SECTION',
    detail: 'DETAIL',
    auxiliary: 'AUXILIARY',
    crop: 'CROP',
    break: 'BREAK',
  };
  const evidence = source.derivedEvidence;
  const authored = String(evidence?.presentation?.label || '').trim();
  return authored || `${labels[evidence.kind]} | ${source.name}`;
}

function sectionHatchCommands(placement, line, stroke) {
  const evidence = placement.source.derivedEvidence;
  if (!SECTION_VIEW_KINDS.has(evidence?.kind)) return [];
  const authoredAngle = evidence.presentation?.hatchAngleDeg ?? evidence.section?.hatchAngleDeg ?? 45;
  const authoredSpacing = evidence.presentation?.hatchSpacingMm ?? evidence.section?.hatchSpacingMm ?? 2.5;
  const angle = Number(authoredAngle);
  const spacing = Number(authoredSpacing);
  if (!Number.isFinite(angle) || angle < -89 || angle > 89 || !Number.isFinite(spacing) || spacing < 0.5 || spacing > 10) {
    fail('DRAWING_DERIVED_EVIDENCE_INVALID', `Section drawing view "${placement.view}" has invalid hatch presentation evidence.`);
  }
  const theta = angle * Math.PI / 180;
  const direction = [Math.cos(theta), Math.sin(theta)];
  const normal = [-direction[1], direction[0]];
  const center = [placement.x + placement.width / 2, placement.y + placement.height / 2];
  const corners = [
    [placement.x, placement.y], [placement.x + placement.width, placement.y],
    [placement.x, placement.y + placement.height], [placement.x + placement.width, placement.y + placement.height],
  ];
  const offsets = corners.map((entry) => (entry[0] - center[0]) * normal[0] + (entry[1] - center[1]) * normal[1]);
  const minimum = Math.floor(Math.min(...offsets) / spacing) * spacing;
  const maximum = Math.ceil(Math.max(...offsets) / spacing) * spacing;
  const reach = Math.hypot(placement.width, placement.height) + spacing;
  const commands = ['% partmode-derived-section-hatch', 'q'];
  for (const path of placement.source.sectionPaths) commands.push(pdfPath(path, placement));
  commands.push('W* n', stroke('visible'));
  for (let offset = minimum; offset <= maximum + 1e-9; offset += spacing) {
    const origin = [center[0] + normal[0] * offset, center[1] + normal[1] * offset];
    commands.push(line(
      origin[0] - direction[0] * reach, origin[1] - direction[1] * reach,
      origin[0] + direction[0] * reach, origin[1] + direction[1] * reach,
    ));
  }
  commands.push('Q');
  return commands;
}

function derivedPresentationCommands(placement, line, circle, rectangle, stroke, text, annotationsEnabled, visibleEnabled) {
  const evidence = placement.source.derivedEvidence;
  if (!evidence) return [];
  const commands = [];
  if (visibleEnabled && ['detail', 'crop'].includes(evidence.kind)) {
    commands.push(stroke('visible'), `[${fmt(1.5 * MM_TO_PT)} ${fmt(1 * MM_TO_PT)}] 0 d`);
    const boundaryKind = String(evidence.clip?.boundary?.kind || evidence.presentation?.boundaryKind || (evidence.kind === 'detail' ? 'circle' : 'rect'));
    if (boundaryKind === 'circle') {
      commands.push(circle(
        placement.x + placement.width / 2,
        placement.y + placement.height / 2,
        Math.max(0.1, Math.min(placement.width, placement.height) / 2),
      ));
    } else {
      commands.push(rectangle(placement.x, placement.y, placement.width, placement.height));
    }
  }
  if (visibleEnabled && evidence.kind === 'break') {
    commands.push(stroke('visible'));
    const axis = String(evidence.break.axis);
    const sourceBox = placement.source.viewBox;
    const mapped = evidence.break.mappedBoundaries.map((value) => axis === 'x'
      ? placement.x + (value - sourceBox[0]) * placement.scale
      : placement.y + (value - sourceBox[1]) * placement.scale);
    const mappedGap = Math.abs(mapped[1] - mapped[0]);
    const amplitude = Math.min(2, Math.max(0.1, Math.min(placement.width, placement.height) * 0.12), mappedGap * 0.2);
    const span = Math.min(amplitude * 3, mappedGap * 0.4);
    const zigzag = (points) => {
      for (let index = 1; index < points.length; index++) commands.push(line(...points[index - 1], ...points[index]));
    };
    if (axis === 'x') {
      for (const x of mapped) for (const y of [placement.y, placement.y + placement.height]) {
        zigzag([[x - span, y], [x - amplitude, y + amplitude], [x + amplitude, y - amplitude], [x + span, y]]);
      }
    } else {
      for (const y of mapped) for (const x of [placement.x, placement.x + placement.width]) {
        zigzag([[x, y - span], [x + amplitude, y - amplitude], [x - amplitude, y + amplitude], [x, y + span]]);
      }
    }
  }
  if (annotationsEnabled) {
    commands.push(stroke('annotations'));
    commands.push(text(derivedViewLabel(placement.source), placement.x + placement.width / 2, placement.y + placement.height + 4, 6.5, 'center'));
  }
  return commands;
}

function drawingContent(response, partName, layout) {
  const sheetWidth = layout.sheet.widthMm;
  const sheetHeight = layout.sheet.heightMm;
  const line = (x0, y0, x1, y1) => lineCommand(x0, y0, x1, y1, sheetHeight);
  const circle = (x, y, radius) => circleCommand(x, y, radius, sheetHeight);
  const rectangle = (x, y, width, height, mode = 'S') => rectangleCommand(x, y, width, height, mode, sheetHeight);
  const layers = new Map(layout.drawingStyle.layers.map((entry) => [entry.id, entry]));
  const enabled = (role) => layers.get(role)?.visible && layers.get(role)?.printable;
  const stroke = (role) => {
    const font = layers.get(role).lineFont;
    const dashPattern = font.dashMm.map((entry) => fmt(entry * MM_TO_PT)).join(' ');
    return `${font.color.map(fmt).join(' ')} RG ${fmt(font.widthMm * MM_TO_PT)} w [${dashPattern}] 0 d`;
  };
  const text = (value, x, y, size = 8, align = 'left', role = 'annotations') => textCommand(
    value, x, y, size, align, sheetHeight, layers.get(role)?.lineFont?.color,
  );
  const commands = ['1 1 1 rg', rectangle(0, 0, sheetWidth, sheetHeight, 'f')];
  if (enabled('border')) commands.push(stroke('border'), rectangle(6, 6, sheetWidth - 12, sheetHeight - 12));
  for (const placement of layout.placements) {
    placement.scale = layout.scale;
    placement.sheetHeight = sheetHeight;
    commands.push('q');
    if (enabled('visible')) commands.push(...sectionHatchCommands(placement, line, stroke));
    const hiddenPaths = layout.tangentEdges === 'visible' ? placement.source.hidden : placement.source.regularHidden;
    const visiblePaths = layout.tangentEdges === 'visible' ? placement.source.visible : placement.source.regularVisible;
    if (enabled('hidden') && hiddenPaths.length) {
      commands.push(stroke('hidden'));
      for (const path of hiddenPaths) commands.push(pdfPath(path, placement), 'S');
    }
    if (enabled('visible')) {
      commands.push(stroke('visible'));
      for (const path of visiblePaths) commands.push(pdfPath(path, placement), 'S');
    }
    if (enabled('tangent') && layout.tangentEdges === 'phantom') {
      const tangentPaths = [...placement.source.tangentHidden, ...placement.source.tangentVisible];
      if (tangentPaths.length) {
        commands.push(stroke('tangent'));
        for (const path of tangentPaths) commands.push(pdfPath(path, placement), 'S');
      }
    }
    commands.push(...derivedPresentationCommands(
      placement, line, circle, rectangle, stroke, text, enabled('annotations'), enabled('visible'),
    ));
    commands.push('Q');
  }
  const front = layout.frontPlacement;
  if (front && enabled('dimensions')) {
    const right = layout.placements.find((entry) => entry.view === 'right');
    const top = layout.placements.find((entry) => entry.view === 'top');
    commands.push(stroke('dimensions'));
    commands.push(line(front.x, front.y + front.height + 7, front.x + front.width, front.y + front.height + 7));
    commands.push(line(front.x, front.y + front.height + 5, front.x, front.y + front.height + 9));
    commands.push(line(front.x + front.width, front.y + front.height + 5, front.x + front.width, front.y + front.height + 9));
    commands.push(text(fmt(front.source.viewBox[2]), front.x + front.width / 2, front.y + front.height + 5.2, 8, 'center', 'dimensions'));
    const dimensionX = front.x + front.width + (right?.width || 0) + (right ? layout.gap : 0) + 7;
    commands.push(line(dimensionX, front.y, dimensionX, front.y + front.height));
    commands.push(text(fmt(front.source.viewBox[3]), dimensionX + 1.4, front.y + front.height / 2, 8, 'left', 'dimensions'));
    if (top) {
      commands.push(line(front.x - 7, top.y, front.x - 7, top.y + top.height));
      commands.push(text(fmt(top.source.viewBox[3]), front.x - 5.6, top.y + top.height / 2, 8, 'left', 'dimensions'));
    }
  }
  const annotations = response.manifest?.annotations || response.manifest?.drawingPlan?.annotations;
  const balloons = Array.isArray(annotations?.balloons) ? annotations.balloons : [];
  for (const balloon of enabled('annotations') ? balloons : []) {
    const placement = layout.placements.find((entry) => entry.view === balloon.view);
    if (!placement || !Array.isArray(balloon.anchor) || !Array.isArray(balloon.label)) continue;
    const map = (source) => [placement.x + (Number(source[0]) - placement.source.viewBox[0]) * layout.scale, placement.y + (Number(source[1]) - placement.source.viewBox[1]) * layout.scale];
    const points = [...(Array.isArray(balloon.leader) ? balloon.leader : [balloon.anchor]), balloon.label].map(map);
    commands.push(stroke('annotations'));
    for (let index = 1; index < points.length; index++) commands.push(line(points[index - 1][0], points[index - 1][1], points[index][0], points[index][1]));
    const label = map(balloon.label);
    commands.push(circle(label[0], label[1], 3.6));
    commands.push(text(balloon.itemNumber, label[0], label[1] + 1, 8, 'center'));
  }
  const authored = layout.drawingAnnotations.annotations.filter((annotation) =>
    ['model-dimension', 'associative-dimension'].includes(annotation.kind) ? enabled('dimensions') : enabled('annotations'));
  for (const annotation of authored) {
    commands.push(stroke(['model-dimension', 'associative-dimension'].includes(annotation.kind) ? 'dimensions' : 'annotations'));
    if (annotation.kind === 'note') {
      for (const [index, entry] of String(annotation.text).split(/\r?\n/u).entries()) {
        commands.push(text(entry, annotation.positionMm[0], annotation.positionMm[1] + index * annotation.sizePt * 0.45, annotation.sizePt));
      }
    } else if (annotation.kind === 'balloon') {
      const placement = layout.placements.find((entry) => entry.view === annotation.viewId);
      if (!placement) fail('DRAWING_ANNOTATIONS_INVALID', `Manual balloon "${annotation.id}" references a missing exact view placement.`);
      const anchor = [
        placement.x + (annotation.anchor[0] - placement.source.viewBox[0]) * layout.scale,
        placement.y + (annotation.anchor[1] - placement.source.viewBox[1]) * layout.scale,
      ];
      commands.push(line(anchor[0], anchor[1], annotation.labelMm[0], annotation.labelMm[1]));
      commands.push(circle(annotation.labelMm[0], annotation.labelMm[1], 4));
      commands.push(text(annotation.text, annotation.labelMm[0], annotation.labelMm[1] + 1, 8, 'center'));
    } else if (annotation.kind === 'model-dimension' || annotation.kind === 'associative-dimension') {
      const placement = layout.placements.find((entry) => entry.view === annotation.viewId);
      if (!placement || !Array.isArray(annotation.anchors) || annotation.anchors.length !== 2) {
        fail('DRAWING_ANNOTATIONS_INVALID', `Imported model dimension "${annotation.id}" has no exact two-point placement.`);
      }
      const anchors = annotation.anchors.map((anchor) => [
        placement.x + (anchor[0] - placement.source.viewBox[0]) * layout.scale,
        placement.y + (anchor[1] - placement.source.viewBox[1]) * layout.scale,
      ]);
      const delta = [anchors[1][0] - anchors[0][0], anchors[1][1] - anchors[0][1]];
      const distance = Math.hypot(...delta);
      if (distance < 1e-9) fail('DRAWING_ANNOTATIONS_INVALID', `Imported model dimension "${annotation.id}" collapses in the selected exact view.`);
      const direction = delta.map((value) => value / distance);
      const normal = [-direction[1], direction[0]];
      const offset = (annotation.labelMm[0] - anchors[0][0]) * normal[0] + (annotation.labelMm[1] - anchors[0][1]) * normal[1];
      const dimensionPoints = anchors.map((anchor) => [anchor[0] + normal[0] * offset, anchor[1] + normal[1] * offset]);
      commands.push(line(anchors[0][0], anchors[0][1], dimensionPoints[0][0], dimensionPoints[0][1]));
      commands.push(line(anchors[1][0], anchors[1][1], dimensionPoints[1][0], dimensionPoints[1][1]));
      commands.push(line(dimensionPoints[0][0], dimensionPoints[0][1], dimensionPoints[1][0], dimensionPoints[1][1]));
      const wing = 1.8;
      for (const [index, endpoint] of dimensionPoints.entries()) {
        const inward = index === 0 ? direction : direction.map((value) => -value);
        commands.push(line(endpoint[0], endpoint[1], endpoint[0] + inward[0] * 3 + normal[0] * wing, endpoint[1] + inward[1] * 3 + normal[1] * wing));
        commands.push(line(endpoint[0], endpoint[1], endpoint[0] + inward[0] * 3 - normal[0] * wing, endpoint[1] + inward[1] * 3 - normal[1] * wing));
      }
      const midpoint = [(dimensionPoints[0][0] + dimensionPoints[1][0]) / 2, (dimensionPoints[0][1] + dimensionPoints[1][1]) / 2];
      commands.push(text(annotation.displayText, midpoint[0], midpoint[1] - 1.5, 6, 'center', 'dimensions'));
    } else if (annotation.kind === 'datum-symbol') {
      const placement = layout.placements.find((entry) => entry.view === annotation.viewId);
      if (!placement) fail('DRAWING_ANNOTATIONS_INVALID', `Datum symbol "${annotation.id}" references a missing exact view placement.`);
      const anchor = [
        placement.x + (annotation.anchor[0] - placement.source.viewBox[0]) * layout.scale,
        placement.y + (annotation.anchor[1] - placement.source.viewBox[1]) * layout.scale,
      ];
      const [x, y] = annotation.labelMm;
      commands.push(line(anchor[0], anchor[1], x, y));
      commands.push(line(x, y, x + 3, y - 3), line(x, y, x + 3, y + 3), line(x + 3, y - 3, x + 3, y + 3));
      commands.push(rectangle(x + 3, y - 3, 7, 6));
      commands.push(text(annotation.identifier, x + 6.5, y + 1, 7, 'center'));
    } else if (annotation.kind === 'feature-control-frame') {
      const placement = layout.placements.find((entry) => entry.view === annotation.viewId);
      if (!placement) fail('DRAWING_ANNOTATIONS_INVALID', `Feature-control frame "${annotation.id}" references a missing exact view placement.`);
      const anchor = [
        placement.x + (annotation.anchor[0] - placement.source.viewBox[0]) * layout.scale,
        placement.y + (annotation.anchor[1] - placement.source.viewBox[1]) * layout.scale,
      ];
      const abbreviations = {
        straightness: 'STRAIGHT', flatness: 'FLAT', circularity: 'ROUND', cylindricity: 'CYL',
        'profile-line': 'PROF LINE', 'profile-surface': 'PROF SURF', parallelism: 'PAR',
        perpendicularity: 'PERP', angularity: 'ANG', position: 'POS',
        'circular-runout': 'RUNOUT', 'total-runout': 'TOTAL RUNOUT',
      };
      const condition = annotation.materialCondition === 'maximum' ? ' M' : annotation.materialCondition === 'least' ? ' L' : '';
      const cells = [abbreviations[annotation.characteristic], `${annotation.diameterZone ? 'DIA ' : ''}${annotation.toleranceMm}${condition}`, ...annotation.datumIdentifiers];
      const [x, y] = annotation.labelMm;
      commands.push(line(anchor[0], anchor[1], x, y));
      let cursor = x;
      for (const cell of cells) {
        const width = Math.max(8, String(cell).length * 2.2 + 4);
        commands.push(rectangle(cursor, y - 3.5, width, 7));
        commands.push(text(String(cell), cursor + width / 2, y + 1, 5.5, 'center'));
        cursor += width;
      }
    } else if (annotation.kind === 'tolerance-stack') {
      const [x, y] = annotation.positionMm;
      const width = 102;
      const rowHeight = 5;
      const height = rowHeight * (annotation.entries.length + 3);
      if (x + width > sheetWidth - 6 || y + height > sheetHeight - 6) fail('DRAWING_GDT_DOES_NOT_FIT', `Tolerance stack "${annotation.name}" does not fit its sheet.`);
      commands.push(rectangle(x, y, width, height));
      commands.push(text(annotation.name, x + 2, y + 3.8, 6, 'left'));
      let rowY = y + rowHeight;
      for (const entry of annotation.entries) {
        rowY += rowHeight;
        commands.push(line(x, rowY, x + width, rowY));
        commands.push(text(`${entry.direction === 1 ? '+' : '-'} ${entry.label}`, x + 2, rowY - 1.2, 5.5, 'left'));
        commands.push(text(`${entry.nominalMm} +${entry.plusMm}/-${entry.minusMm} mm`, x + width - 2, rowY - 1.2, 5.5, 'right'));
      }
      rowY += rowHeight;
      commands.push(line(x, rowY, x + width, rowY));
      commands.push(text(`WC ${annotation.nominalMm} +${annotation.worstCasePlusMm}/-${annotation.worstCaseMinusMm} mm`, x + 2, rowY - 1.2, 5.5, 'left'));
      commands.push(text(`LIMITS ${annotation.minimumMm} to ${annotation.maximumMm} | RSS ${annotation.rssMm}`, x + 2, rowY + rowHeight - 1.2, 5.2, 'left'));
    } else if (annotation.kind === 'revision-cloud') {
      const [x, y, width, height] = annotation.boundsMm;
      const radius = Math.max(1.5, Math.min(4, Math.min(width, height) / 5));
      const horizontalCount = Math.max(2, Math.ceil(width / (radius * 2)));
      const verticalCount = Math.max(2, Math.ceil(height / (radius * 2)));
      for (let index = 0; index <= horizontalCount; index++) {
        const offset = width * index / horizontalCount;
        commands.push(circle(x + offset, y, radius), circle(x + offset, y + height, radius));
      }
      for (let index = 1; index < verticalCount; index++) {
        const offset = height * index / verticalCount;
        commands.push(circle(x, y + offset, radius), circle(x + width, y + offset, radius));
      }
      commands.push(text(`REV ${annotation.revision}`, x + width / 2, y + height / 2 + 1, 7, 'center'));
    } else if (annotation.kind === 'hole-callout') {
      const placement = layout.placements.find((entry) => entry.view === annotation.viewId);
      if (!placement) fail('DRAWING_ANNOTATIONS_INVALID', `Hole callout "${annotation.id}" references a missing exact view placement.`);
      const anchor = [
        placement.x + (annotation.anchor[0] - placement.source.viewBox[0]) * layout.scale,
        placement.y + (annotation.anchor[1] - placement.source.viewBox[1]) * layout.scale,
      ];
      commands.push(line(anchor[0], anchor[1], annotation.labelMm[0], annotation.labelMm[1]));
      commands.push(line(annotation.labelMm[0], annotation.labelMm[1], annotation.labelMm[0] + 48, annotation.labelMm[1]));
      commands.push(text(annotation.callout, annotation.labelMm[0] + 1, annotation.labelMm[1] - 1.2, 6, 'left'));
    } else if (annotation.kind === 'center-mark') {
      const placement = layout.placements.find((entry) => entry.view === annotation.viewId);
      if (!placement) fail('DRAWING_ANNOTATIONS_INVALID', `Center mark "${annotation.id}" references a missing exact view placement.`);
      const anchor = [
        placement.x + (annotation.anchor[0] - placement.source.viewBox[0]) * layout.scale,
        placement.y + (annotation.anchor[1] - placement.source.viewBox[1]) * layout.scale,
      ];
      commands.push(line(anchor[0] - annotation.sizeMm, anchor[1], anchor[0] + annotation.sizeMm, anchor[1]));
      commands.push(line(anchor[0], anchor[1] - annotation.sizeMm, anchor[0], anchor[1] + annotation.sizeMm));
      commands.push(circle(anchor[0], anchor[1], Math.max(0.8, annotation.sizeMm * 0.32)));
    } else if (annotation.kind === 'centerline') {
      const placement = layout.placements.find((entry) => entry.view === annotation.viewId);
      if (!placement || !Array.isArray(annotation.anchors) || annotation.anchors.length !== 2) {
        fail('DRAWING_ANNOTATIONS_INVALID', `Centerline "${annotation.id}" has no exact two-point placement.`);
      }
      const anchors = annotation.anchors.map((anchor) => [
        placement.x + (anchor[0] - placement.source.viewBox[0]) * layout.scale,
        placement.y + (anchor[1] - placement.source.viewBox[1]) * layout.scale,
      ]);
      const delta = [anchors[1][0] - anchors[0][0], anchors[1][1] - anchors[0][1]];
      const length = Math.hypot(...delta);
      if (length < 1e-9) fail('DRAWING_ANNOTATIONS_INVALID', `Centerline "${annotation.id}" collapses in the selected exact view.`);
      const unit = delta.map((value) => value / length);
      commands.push(line(
        anchors[0][0] - unit[0] * annotation.extensionMm, anchors[0][1] - unit[1] * annotation.extensionMm,
        anchors[1][0] + unit[0] * annotation.extensionMm, anchors[1][1] + unit[1] * annotation.extensionMm,
      ));
    } else if (annotation.kind === 'weld-symbol') {
      const placement = layout.placements.find((entry) => entry.view === annotation.viewId);
      if (!placement) fail('DRAWING_ANNOTATIONS_INVALID', `Weld symbol "${annotation.id}" references a missing exact view placement.`);
      const anchor = [
        placement.x + (annotation.anchor[0] - placement.source.viewBox[0]) * layout.scale,
        placement.y + (annotation.anchor[1] - placement.source.viewBox[1]) * layout.scale,
      ];
      const [x, y] = annotation.labelMm;
      const sideOffsets = annotation.side === 'both' ? [4, -4] : [annotation.side === 'other' ? -4 : 4];
      commands.push(line(anchor[0], anchor[1], x, y), line(x, y, x + 32, y));
      for (const sideOffset of sideOffsets) {
        if (annotation.weldType === 'fillet') {
          commands.push(line(x + 8, y, x + 8, y + sideOffset), line(x + 8, y + sideOffset, x + 14, y));
        } else if (annotation.weldType === 'v-groove') {
          commands.push(line(x + 8, y + sideOffset, x + 11, y), line(x + 14, y + sideOffset, x + 11, y));
        } else if (annotation.weldType === 'square-groove') {
          commands.push(line(x + 9, y, x + 9, y + sideOffset), line(x + 13, y, x + 13, y + sideOffset));
        } else {
          commands.push(rectangle(x + 8, y + Math.min(0, sideOffset), 6, Math.abs(sideOffset)));
        }
      }
      commands.push(text(`${annotation.sizeMm} ${annotation.weldType.replaceAll('-', ' ')} ${annotation.side}`, x + 16, y - 1.2, 5.5, 'left'));
      if (annotation.tail) commands.push(text(annotation.tail, x + 33, y + 1.2, 5.5, 'left'));
    } else if (annotation.kind === 'surface-finish') {
      const placement = layout.placements.find((entry) => entry.view === annotation.viewId);
      if (!placement) fail('DRAWING_ANNOTATIONS_INVALID', `Surface-finish symbol "${annotation.id}" references a missing exact view placement.`);
      const anchor = [
        placement.x + (annotation.anchor[0] - placement.source.viewBox[0]) * layout.scale,
        placement.y + (annotation.anchor[1] - placement.source.viewBox[1]) * layout.scale,
      ];
      const [x, y] = annotation.labelMm;
      commands.push(line(anchor[0], anchor[1], x, y), line(x, y, x + 5, y + 7), line(x + 5, y + 7, x + 12, y - 5));
      if (annotation.method === 'material-removal-required') commands.push(line(x + 4, y - 1, x + 11, y - 1));
      if (annotation.method === 'material-removal-prohibited') commands.push(circle(x + 7.5, y - 1.5, 2));
      commands.push(text(`Ra ${annotation.roughnessRa}`, x + 12, y - 2, 6, 'left'));
      if (annotation.process) commands.push(text(annotation.process, x + 12, y + 3, 5.5, 'left'));
      if (annotation.lay !== 'none') commands.push(text(`lay ${annotation.lay}`, x + 12, y + 7, 5, 'left'));
    } else if (annotation.kind === 'block') {
      const width = annotation.block.widthMm * annotation.scale;
      const height = annotation.block.heightMm * annotation.scale;
      commands.push(rectangle(annotation.positionMm[0], annotation.positionMm[1], width, height));
      commands.push(text(annotation.block.text, annotation.positionMm[0] + width / 2, annotation.positionMm[1] + height / 2 + 1, Math.max(5, Math.min(14, 8 * annotation.scale)), 'center'));
    }
  }
  const authoredTables = enabled('tables') ? layout.drawingTables.tables : [];
  for (const table of authoredTables) {
    const headers = Array.isArray(table.headers) ? table.headers.map(String) : [];
    const rows = Array.isArray(table.rows) ? table.rows.map((row) => Array.isArray(row) ? row.map((value) => String(value ?? '')) : []) : [];
    if (!headers.length || headers.length > 8 || !rows.length || rows.length > 100 || rows.some((row) => row.length !== headers.length)) {
      fail('DRAWING_TABLES_INVALID', `Drawing table "${table.id || ''}" has invalid columns or rows.`);
    }
    const rowHeight = 5;
    const titleHeight = 6;
    const tableHeight = titleHeight + rowHeight * (rows.length + 1);
    const [tableX, tableY] = table.positionMm;
    const tableWidth = Number(table.widthMm);
    if (!Number.isFinite(tableX) || !Number.isFinite(tableY) || !Number.isFinite(tableWidth)
      || tableX < 6 || tableY < 6 || tableX + tableWidth > sheetWidth - 6 || tableY + tableHeight > sheetHeight - 6) {
      fail('DRAWING_TABLE_DOES_NOT_FIT', `Drawing table "${table.name || table.id}" does not fit the selected sheet.`);
    }
    const columnWidth = tableWidth / headers.length;
    const cellText = (value, column) => String(value).slice(0, Math.max(3, Math.floor(columnWidth / 1.45)));
    commands.push(stroke('tables'), rectangle(tableX, tableY, tableWidth, tableHeight));
    commands.push(line(tableX, tableY + titleHeight, tableX + tableWidth, tableY + titleHeight));
    commands.push(text(table.name, tableX + 1.5, tableY + 4.2, 6.5, 'left', 'tables'));
    for (let column = 1; column < headers.length; column++) {
      const x = tableX + columnWidth * column;
      commands.push(line(x, tableY + titleHeight, x, tableY + tableHeight));
    }
    for (let row = 1; row <= rows.length; row++) {
      const y = tableY + titleHeight + rowHeight * row;
      commands.push(line(tableX, y, tableX + tableWidth, y));
    }
    for (const [column, header] of headers.entries()) {
      commands.push(text(cellText(header, column), tableX + columnWidth * column + 1, tableY + titleHeight + 3.6, 5.5, 'left', 'tables'));
    }
    for (const [rowIndex, row] of rows.entries()) for (const [column, value] of row.entries()) {
      commands.push(text(cellText(value, column), tableX + columnWidth * column + 1, tableY + titleHeight + rowHeight * (rowIndex + 1) + 3.6, 5.5, 'left', 'tables'));
    }
  }
  const bom = Array.isArray(response.manifest?.bom) ? response.manifest.bom : [];
  if (bom.length && enabled('tables')) {
    const tableWidth = 92;
    const tableX = sheetWidth - layout.margin - tableWidth;
    const titleTop = sheetHeight - layout.margin - 24;
    const rowHeight = Math.min(5, Math.max(20, titleTop - layout.margin - 3) / (bom.length + 1));
    const tableHeight = rowHeight * (bom.length + 1);
    const tableY = titleTop - tableHeight - 2;
    const columns = [0, 8, 34, 70, 79, 92];
    commands.push(stroke('tables'), rectangle(tableX, tableY, tableWidth, tableHeight));
    for (const offset of columns.slice(1, -1)) commands.push(line(tableX + offset, tableY, tableX + offset, tableY + tableHeight));
    for (let index = 1; index <= bom.length; index++) commands.push(line(tableX, tableY + rowHeight * index, tableX + tableWidth, tableY + rowHeight * index));
    const headers = [['ITEM', 1], ['PART NUMBER', 9], ['DESCRIPTION', 35], ['QTY', 71], ['REV', 80]];
    for (const [label, offset] of headers) commands.push(text(label, tableX + offset, tableY + rowHeight * 0.72, 5.5, 'left', 'tables'));
    for (let index = 0; index < bom.length; index++) {
      const entry = bom[index];
      const y = tableY + rowHeight * (index + 1.72);
      for (const [value, offset, limit] of [[entry.itemNumber, 1, 4], [entry.partNumber, 9, 18], [entry.description, 35, 28], [entry.quantity, 71, 5], [entry.revision, 80, 8]]) {
        commands.push(text(String(value ?? '').slice(0, limit), tableX + offset, y, 5.5, 'left', 'tables'));
      }
    }
  }
  const blockX = sheetWidth - layout.margin - 92;
  const blockY = sheetHeight - layout.margin - 24;
  if (enabled('border')) {
    commands.push(stroke('border'), rectangle(blockX, blockY, 92, 24));
    commands.push(line(blockX, blockY + 8, blockX + 92, blockY + 8), line(blockX, blockY + 16, blockX + 92, blockY + 16));
  }
  if (enabled('annotations')) {
    commands.push(text(partName || 'Part', blockX + 3, blockY + 5.5, 10));
    commands.push(text(`Scale ${layout.scaleLabel} | millimetres | ${layout.sheet.projection.replace('-', ' ')}`, blockX + 3, blockY + 13.5, 7.5));
    commands.push(text('PartMode | print-ready vector PDF', blockX + 3, blockY + 21.5, 7.5));
  }
  return commands.join('\n') + '\n';
}

function buildPdf(pages, title) {
  if (!Array.isArray(pages) || !pages.length || pages.length > 20) fail('DRAWING_PDF_LIMIT_EXCEEDED', 'Drawing PDF requires 1 to 20 pages.');
  const infoId = 4 + pages.length * 2;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const contentBytes = encoder.encode(page.content);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(page.widthMm * MM_TO_PT)} ${fmt(page.heightMm * MM_TO_PT)}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${contentBytes.length} >>\nstream\n${page.content}endstream`,
    );
  }
  objects.push(`<< /Title (${pdfText(title || 'PartMode drawing')}) /Producer (PartMode ${STUDIO_DRAWING_PDF_SCHEMA}) >>`);
  const chunks = [encoder.encode('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')];
  const offsets = [0];
  let length = chunks[0].length;
  for (let index = 0; index < objects.length; index++) {
    offsets.push(length);
    const chunk = encoder.encode(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`);
    chunks.push(chunk);
    length += chunk.length;
  }
  const xrefOffset = length;
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f '];
  for (const offset of offsets.slice(1)) xref.push(`${String(offset).padStart(10, '0')} 00000 n `);
  xref.push('trailer', `<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>`, 'startxref', String(xrefOffset), '%%EOF', '');
  chunks.push(encoder.encode(xref.join('\n')));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }
  return bytes;
}

export function createStudioDrawingPdf(response, partName, options = {}) {
  const layout = layoutStudioDrawingPdf(response, options);
  const content = drawingContent(response, String(partName || 'Part'), layout);
  const bytes = buildPdf([{ content, widthMm: layout.sheet.widthMm, heightMm: layout.sheet.heightMm }], `${partName || 'Part'} drawing`);
  const derivedViews = layout.placements.filter((entry) => entry.source.derivedEvidence).map((entry) => ({
    view: entry.view,
    name: entry.source.name,
    evidence: structuredClone(entry.source.derivedEvidence),
    sectionPathCount: entry.source.sectionPaths.length,
  }));
  return {
    bytes,
    mediaType: 'application/pdf',
    manifest: {
      schema: STUDIO_DRAWING_PDF_SCHEMA,
      sheet: layout.sheet,
      scale: layout.scale,
      scaleLabel: layout.scaleLabel,
      viewCount: layout.placements.length,
      views: layout.placements.map((entry) => entry.view),
      tangentEdges: layout.tangentEdges,
      layoutMode: layout.layoutMode,
      alignments: layout.alignmentEvidence,
      drawingStyle: structuredClone(layout.drawingStyle),
      drawingAnnotations: structuredClone(layout.drawingAnnotations),
      drawingTables: structuredClone(layout.drawingTables),
      exactProjectionEvidence: response.manifest?.exactProjectionEvidence || null,
      ...(derivedViews.length ? { derivedViews } : {}),
    },
  };
}

export function createStudioDrawingBookPdf(response, partName, book, standards = null, annotations = null, tables = null, project = null) {
  if (!book || book.schema !== 'partmode.drawing-book/v1' || !Array.isArray(book.sheets) || !book.sheets.length || book.sheets.length > 20) {
    fail('DRAWING_BOOK_INVALID', 'A validated drawing book with 1 to 20 sheets is required.');
  }
  const available = new Map(validatedViews(response, project).map((entry) => [entry.view, entry]));
  const pages = [];
  const pageManifest = [];
  for (const sheet of book.sheets) {
    const requestedViews = Array.isArray(sheet.views) ? sheet.views.map(String) : [];
    if (!requestedViews.length || requestedViews.some((view) => !available.has(view))) {
      fail('DRAWING_BOOK_VIEW_MISSING', `Drawing sheet "${sheet.name || sheet.id}" requests an exact view that was not generated.`);
    }
    const sheetResponse = { ...response, views: requestedViews.map((view) => available.get(view)) };
    const layout = layoutStudioDrawingPdf(sheetResponse, {
      scale: sheet.scale,
      sheetWidthMm: sheet.format?.widthMm,
      sheetHeightMm: sheet.format?.heightMm,
      sheetStandard: sheet.format?.standard,
      sheetSize: sheet.format?.size,
      projection: sheet.format?.projection,
      tangentEdges: sheet.tangentEdges,
      alignments: sheet.alignments,
      drawingStyle: resolveStudioDrawingSheetStyle(book, standards, sheet.id),
      drawingAnnotations: resolveStudioDrawingSheetAnnotations(book, annotations, sheet.id, sheetResponse, project),
      drawingTables: resolveStudioDrawingSheetTables(book, tables, sheet.id, sheetResponse, project),
      project,
    });
    const content = drawingContent(sheetResponse, `${partName || 'Part'} | ${sheet.name || sheet.id}`, layout);
    pages.push({ content, widthMm: layout.sheet.widthMm, heightMm: layout.sheet.heightMm });
    const derivedViews = layout.placements.filter((entry) => entry.source.derivedEvidence).map((entry) => ({
      view: entry.view,
      name: entry.source.name,
      evidence: structuredClone(entry.source.derivedEvidence),
      sectionPathCount: entry.source.sectionPaths.length,
    }));
    pageManifest.push({
      sheetId: String(sheet.id),
      name: String(sheet.name),
      format: cloneSheetFormat(sheet.format),
      scale: layout.scale,
      scaleLabel: layout.scaleLabel,
      views: layout.placements.map((entry) => entry.view),
      tangentEdges: layout.tangentEdges,
      layoutMode: layout.layoutMode,
      alignments: layout.alignmentEvidence,
      drawingStyle: structuredClone(layout.drawingStyle),
      drawingAnnotations: structuredClone(layout.drawingAnnotations),
      drawingTables: structuredClone(layout.drawingTables),
      ...(derivedViews.length ? { derivedViews } : {}),
    });
  }
  return {
    bytes: buildPdf(pages, `${partName || 'Part'} drawing set`),
    mediaType: 'application/pdf',
    manifest: {
      schema: STUDIO_DRAWING_PDF_SCHEMA,
      drawingBookSchema: book.schema,
      title: String(book.title || 'Drawing set'),
      pageCount: pages.length,
      pages: pageManifest,
      exactProjectionEvidence: response.manifest?.exactProjectionEvidence || null,
    },
  };
}

function cloneSheetFormat(value) {
  return value && typeof value === 'object' ? structuredClone(value) : null;
}
