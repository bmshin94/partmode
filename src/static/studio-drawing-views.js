import { canonicalStudioV5Project } from './studio-v5-runtime-document.js';

export const STUDIO_DRAWING_VIEWS_SCHEMA = 'partmode.drawing-views/v1';
export const STUDIO_STANDARD_DRAWING_VIEWS = Object.freeze(['front', 'top', 'right', 'left', 'bottom', 'back', 'iso']);
export const STUDIO_TANGENT_EDGE_MODES = Object.freeze(['visible', 'removed', 'phantom']);
export const STUDIO_DERIVED_DRAWING_VIEW_KINDS = Object.freeze([
  'full-section', 'half-section', 'aligned-section', 'broken-out-section',
  'detail', 'auxiliary', 'crop', 'break',
]);

const clone = (value) => structuredClone(value);
const NAME = /^[^\u0000-\u001f]{1,120}$/u;

export class StudioDrawingViewsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioDrawingViewsError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new StudioDrawingViewsError(code, message, details);
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || !NAME.test(value.trim())) fail('DRAWING_VIEW_INPUT_INVALID', `${label} must be non-empty bounded text.`);
  return value.trim();
}

function vector(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => !Number.isFinite(Number(entry)) || Math.abs(Number(entry)) > 1_000_000)) {
    fail('DRAWING_VIEW_INPUT_INVALID', `${label} must contain three bounded finite numbers.`);
  }
  return value.map(Number);
}

const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
const length = (value) => Math.hypot(...value);
const rounded = (value) => Math.round(value * 1e12) / 1e12;
const normalized = (value, label) => {
  const magnitude = length(value);
  if (magnitude < 1e-9) fail('DRAWING_VIEW_INPUT_INVALID', `${label} must be non-zero.`);
  return value.map((entry) => rounded(entry / magnitude));
};
const cross = (left, right) => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];
const subtract = (left, right) => left.map((entry, index) => entry - right[index]);

function alignedSectionJoints(resolvedPlanes) {
  const referenceAxis = normalized(cross(resolvedPlanes[0].normal, resolvedPlanes[0].xAxis), 'Aligned-section reference hinge axis');
  const referenceCoordinate = dot(resolvedPlanes[0].origin, referenceAxis);
  const joints = [];
  for (let index = 0; index < resolvedPlanes.length - 1; index++) {
    const previous = resolvedPlanes[index];
    const next = resolvedPlanes[index + 1];
    const rawAxis = cross(previous.normal, next.normal);
    const denominator = dot(rawAxis, rawAxis);
    if (!(denominator > 1e-12)) {
      fail('DRAWING_VIEW_INPUT_INVALID', `Aligned-section planes ${index + 1} and ${index + 2} require one unique non-parallel hinge.`);
    }
    let axis = normalized(rawAxis, `Aligned-section hinge ${index + 1} axis`);
    const alignment = dot(axis, referenceAxis);
    if (Math.abs(alignment) < 1 - 1e-7) {
      fail('DRAWING_VIEW_INPUT_INVALID', 'Aligned-section hinges must share one stable fold axis.');
    }
    if (alignment < 0) axis = axis.map((entry) => -entry);
    const previousOffset = dot(previous.normal, previous.origin);
    const nextOffset = dot(next.normal, next.origin);
    const nextCrossAxis = cross(next.normal, rawAxis);
    const axisCrossPrevious = cross(rawAxis, previous.normal);
    let point = previous.normal.map((_, component) => (
      previousOffset * nextCrossAxis[component] + nextOffset * axisCrossPrevious[component]
    ) / denominator);
    const axialDenominator = dot(axis, referenceAxis);
    const axialShift = (referenceCoordinate - dot(point, referenceAxis)) / axialDenominator;
    point = point.map((entry, component) => rounded(entry + axis[component] * axialShift));
    if (point.some((entry) => !Number.isFinite(entry) || Math.abs(entry) > 1_000_000)) {
      fail('DRAWING_VIEW_INPUT_INVALID', `Aligned-section hinge ${index + 1} lies outside the bounded model space.`);
    }
    const splitNormal = normalized(
      previous.xAxis.map((entry, component) => entry + next.xAxis[component]),
      `Aligned-section hinge ${index + 1} split normal`,
    );
    if (dot(splitNormal, previous.xAxis) <= 1e-7 || dot(splitNormal, next.xAxis) <= 1e-7) {
      fail('DRAWING_VIEW_INPUT_INVALID', 'Aligned-section plane x-axes must point through the ordered hinge chain.');
    }
    joints.push({
      previousPlaneIndex: index,
      nextPlaneIndex: index + 1,
      point,
      axis: axis.map(rounded),
      splitNormal: splitNormal.map(rounded),
    });
  }
  for (let index = 1; index < resolvedPlanes.length - 1; index++) {
    const plane = resolvedPlanes[index];
    const delta = subtract(joints[index].point, joints[index - 1].point);
    const advance = dot(delta, plane.xAxis);
    const residual = subtract(delta, plane.xAxis.map((entry) => entry * advance));
    const tolerance = Math.max(1e-7, length(delta) * 1e-8);
    if (!(advance > tolerance) || length(residual) > tolerance) {
      fail('DRAWING_VIEW_INPUT_INVALID', 'Aligned-section hinges must advance monotonically along each intermediate plane x-axis.');
    }
  }
  return joints;
}

function frame(input) {
  const direction = normalized(vector(input.direction, 'View direction'), 'View direction');
  const authoredX = vector(input.xAxis, 'View x-axis');
  const projection = dot(authoredX, direction);
  const orthogonal = authoredX.map((entry, index) => entry - projection * direction[index]);
  const xAxis = normalized(orthogonal, 'View x-axis');
  return { direction, xAxis };
}

function emptyGraph() {
  return { schema: STUDIO_DRAWING_VIEWS_SCHEMA, sequence: 0, views: [], derivedSequence: 0, derivedViews: [] };
}

function finite(value, label, minimum = -1_000_000, maximum = 1_000_000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    fail('DRAWING_VIEW_INPUT_INVALID', `${label} must be a bounded finite number.`);
  }
  return rounded(number);
}

function defaultXAxis(normal) {
  const preferred = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const projection = dot(preferred, normal);
  return normalized(preferred.map((entry, index) => entry - projection * normal[index]), 'Cutting-plane x-axis');
}

function cuttingPlane(value, label) {
  const origin = vector(value?.origin, `${label} origin`).map(rounded);
  const normal = normalized(vector(value?.normal, `${label} normal`), `${label} normal`);
  const resolved = frame({ direction: normal, xAxis: value?.xAxis || defaultXAxis(normal) });
  const keepSide = String(value?.keepSide || 'positive');
  if (!['positive', 'negative'].includes(keepSide)) fail('DRAWING_VIEW_INPUT_INVALID', `${label} retained side must be positive or negative.`);
  return { origin, normal: resolved.direction, xAxis: resolved.xAxis, keepSide };
}

function boundary(value, label) {
  const kind = String(value?.kind || 'rect');
  if (kind === 'rect') {
    const x = finite(value.x, `${label} x`);
    const y = finite(value.y, `${label} y`);
    const width = finite(value.width, `${label} width`, 0.001);
    const height = finite(value.height, `${label} height`, 0.001);
    return { kind, x, y, width, height };
  }
  if (kind === 'circle') {
    return {
      kind,
      x: finite(value.x, `${label} center x`),
      y: finite(value.y, `${label} center y`),
      radius: finite(value.radius, `${label} radius`, 0.001),
    };
  }
  fail('DRAWING_VIEW_INPUT_INVALID', `${label} must be a rectangle or circle.`);
}

function planes(value, count, label) {
  if (!Array.isArray(value) || value.length < count[0] || value.length > count[1]) {
    fail('DRAWING_VIEW_INPUT_INVALID', `${label} requires ${count[0] === count[1] ? count[0] : `${count[0]} to ${count[1]}`} cutting plane${count[1] === 1 ? '' : 's'}.`);
  }
  return value.map((entry, index) => cuttingPlane(entry, `${label} plane ${index + 1}`));
}

function rootPart(project) {
  if (project?.rootDocument?.kind !== 'part') return null;
  const partId = project.rootDocument.partId || project.rootDocument.definitionId;
  return (project.partDefinitions || []).find((entry) => entry.id === partId) || null;
}

function requireDerivedPart(project) {
  if (project?.rootDocument?.kind !== 'part' || project?.metadata?.editContext || !rootPart(project)) {
    fail('DRAWING_DERIVED_VIEW_PART_REQUIRED', 'Derived drawing views can be persisted only in a part document.');
  }
}

function auxiliaryReference(value, project = null) {
  const bodyId = String(value?.bodyId || '').trim();
  const faceName = String(value?.faceName || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(bodyId) || !NAME.test(faceName)) {
    fail('DRAWING_VIEW_INPUT_INVALID', 'Auxiliary view requires one persistent body id and face name.');
  }
  if (project) {
    const body = rootPart(project)?.bodies?.find((entry) => entry.id === bodyId);
    if (!body || body.suppressed === true) {
      fail('DRAWING_VIEW_REFERENCE_MISSING', `Auxiliary view references missing or suppressed body "${bodyId}".`, { bodyId });
    }
  }
  return { bodyId, faceName };
}

function derivedDefinition(kind, value = {}, project = null) {
  if (kind === 'full-section') return { planes: planes(value.planes, [1, 1], 'Full section'), hatchAngleDeg: finite(value.hatchAngleDeg ?? 45, 'Hatch angle', -89, 89) };
  if (kind === 'half-section') {
    const axis = String(value.half?.axis || 'x');
    const side = String(value.half?.side || 'positive');
    if (!['x', 'y'].includes(axis) || !['positive', 'negative'].includes(side)) fail('DRAWING_VIEW_INPUT_INVALID', 'Half section requires an x/y split axis and a positive/negative exterior side.');
    return {
      planes: planes(value.planes, [2, 2], 'Half section'),
      half: { axis, side, at: finite(value.half?.at ?? 0, 'Half-section split') },
      hatchAngleDeg: finite(value.hatchAngleDeg ?? 45, 'Hatch angle', -89, 89),
    };
  }
  if (kind === 'aligned-section') {
    const resolvedPlanes = planes(value.planes, [2, 6], 'Aligned section');
    return {
      planes: resolvedPlanes,
      joints: alignedSectionJoints(resolvedPlanes),
      hatchAngleDeg: finite(value.hatchAngleDeg ?? 45, 'Hatch angle', -89, 89),
    };
  }
  if (kind === 'broken-out-section') return {
    boundary: boundary(value.boundary, 'Broken-out boundary'),
    depthMm: finite(value.depthMm, 'Broken-out depth', 0.001, 1_000_000),
    hatchAngleDeg: finite(value.hatchAngleDeg ?? 45, 'Hatch angle', -89, 89),
  };
  if (kind === 'detail') return {
    boundary: boundary(value.boundary, 'Detail boundary'),
    magnification: finite(value.magnification ?? 2, 'Detail magnification', 1.1, 10),
  };
  if (kind === 'auxiliary') {
    const xAxis = normalized(vector(value.xAxis, 'Auxiliary x-axis'), 'Auxiliary x-axis').map(rounded);
    return { reference: auxiliaryReference(value.reference, project), xAxis };
  }
  if (kind === 'crop') return { boundary: boundary(value.boundary, 'Crop boundary') };
  if (kind === 'break') {
    const axis = String(value.axis || 'x');
    if (!['x', 'y'].includes(axis)) fail('DRAWING_VIEW_INPUT_INVALID', 'Break view axis must be x or y.');
    const start = finite(value.start, 'Break start');
    const end = finite(value.end, 'Break end');
    const gapMm = finite(value.gapMm ?? 4, 'Break display gap', 1, 25);
    if (!(end > start + 0.001)) fail('DRAWING_VIEW_INPUT_INVALID', 'Break end must be greater than break start.');
    if (!(gapMm < end - start)) fail('DRAWING_VIEW_INPUT_INVALID', 'Break display gap must be smaller than the removed interval.');
    return { axis, start, end, gapMm };
  }
  fail('DRAWING_VIEW_INPUT_INVALID', 'Derived drawing-view kind is unsupported.');
}

function derivedRecord(input, id, namedViewIds, project = null) {
  const kind = String(input?.kind || '');
  if (!STUDIO_DERIVED_DRAWING_VIEW_KINDS.includes(kind)) fail('DRAWING_VIEW_INPUT_INVALID', 'Derived drawing-view kind is unsupported.');
  const sourceViewId = String(input?.sourceViewId || 'front');
  if (!STUDIO_STANDARD_DRAWING_VIEWS.includes(sourceViewId) && !namedViewIds.has(sourceViewId)) {
    fail('DRAWING_VIEW_NOT_FOUND', `Source drawing view "${sourceViewId}" does not exist.`);
  }
  return {
    id,
    name: text(input.name, 'Derived drawing-view name'),
    kind,
    sourceViewId,
    definition: derivedDefinition(kind, input.definition || {}, project),
  };
}

function validateGraph(value, project = null) {
  if (!value || typeof value !== 'object' || value.schema !== STUDIO_DRAWING_VIEWS_SCHEMA
    || !Number.isInteger(value.sequence) || value.sequence < 0 || !Array.isArray(value.views) || value.views.length > 100) {
    fail('DRAWING_VIEWS_INVALID', 'Named drawing-view graph is invalid.');
  }
  const graph = clone(value);
  graph.derivedSequence ??= 0;
  graph.derivedViews ??= [];
  if (!Number.isInteger(graph.derivedSequence) || graph.derivedSequence < 0 || !Array.isArray(graph.derivedViews) || graph.derivedViews.length > 100) {
    fail('DRAWING_VIEWS_INVALID', 'Derived drawing-view graph is invalid.');
  }
  if (graph.derivedViews.length) requireDerivedPart(project);
  const ids = new Set();
  const names = new Set();
  let maximumSequence = 0;
  for (const view of graph.views) {
    if (!/^drawing-view-\d{6}$/u.test(view?.id || '') || ids.has(view.id)) fail('DRAWING_VIEWS_INVALID', 'Named drawing-view ids are missing or duplicated.');
    view.name = text(view.name, 'Drawing-view name');
    const folded = view.name.toLowerCase();
    if (names.has(folded) || STUDIO_STANDARD_DRAWING_VIEWS.includes(folded)) fail('DRAWING_VIEWS_INVALID', 'Named drawing-view names must be unique and cannot shadow a standard view.');
    const resolved = frame(view);
    view.direction = resolved.direction;
    view.xAxis = resolved.xAxis;
    maximumSequence = Math.max(maximumSequence, Number(view.id.slice('drawing-view-'.length)));
    ids.add(view.id);
    names.add(folded);
  }
  if (graph.sequence < maximumSequence) fail('DRAWING_VIEWS_INVALID', 'Named drawing-view sequence can collide with an existing id.');
  const namedIds = new Set(ids);
  let maximumDerivedSequence = 0;
  for (const [index, source] of graph.derivedViews.entries()) {
    if (!/^drawing-derived-view-\d{6}$/u.test(source?.id || '') || ids.has(source.id)) fail('DRAWING_VIEWS_INVALID', 'Derived drawing-view ids are missing or duplicated.');
    const record = derivedRecord(source, source.id, namedIds, project);
    const folded = record.name.toLowerCase();
    if (names.has(folded) || STUDIO_STANDARD_DRAWING_VIEWS.includes(folded)) fail('DRAWING_VIEWS_INVALID', 'Drawing-view names must be unique and cannot shadow a standard view.');
    maximumDerivedSequence = Math.max(maximumDerivedSequence, Number(record.id.slice('drawing-derived-view-'.length)));
    graph.derivedViews[index] = record;
    ids.add(record.id);
    names.add(folded);
  }
  if (graph.derivedSequence < maximumDerivedSequence) fail('DRAWING_VIEWS_INVALID', 'Derived drawing-view sequence can collide with an existing id.');
  return graph;
}

function from(project) {
  const value = project?.extensions?.drawingViews;
  return value == null ? emptyGraph() : validateGraph(value, project);
}

function attach(project, graph) {
  const candidate = canonicalStudioV5Project(project);
  candidate.extensions = { ...(candidate.extensions || {}), drawingViews: validateGraph(graph, candidate) };
  return canonicalStudioV5Project(candidate);
}

export function createStudioNamedDrawingView(project, input = {}) {
  const graph = from(project);
  if (graph.views.length >= 100) fail('DRAWING_VIEW_LIMIT_EXCEEDED', 'A project supports at most 100 named drawing views.');
  const name = text(input.name, 'Drawing-view name');
  if (graph.views.some((entry) => entry.name.toLowerCase() === name.toLowerCase()) || STUDIO_STANDARD_DRAWING_VIEWS.includes(name.toLowerCase())) {
    fail('DRAWING_VIEW_EXISTS', `Drawing view "${name}" already exists.`);
  }
  const resolved = frame(input);
  const view = { id: `drawing-view-${String(++graph.sequence).padStart(6, '0')}`, name, ...resolved };
  graph.views.push(view);
  return attach(project, graph);
}

export function updateStudioNamedDrawingView(project, input = {}) {
  const graph = from(project);
  const view = graph.views.find((entry) => entry.id === input.viewId);
  if (!view) fail('DRAWING_VIEW_NOT_FOUND', 'Requested named drawing view does not exist.');
  const patch = input.patch && typeof input.patch === 'object' ? input.patch : {};
  const unknown = Object.keys(patch).filter((key) => !['name', 'direction', 'xAxis'].includes(key));
  if (unknown.length) fail('DRAWING_VIEW_INPUT_INVALID', 'Named drawing-view patch contains unsupported fields.', { unknown });
  if (patch.name != null) view.name = text(patch.name, 'Drawing-view name');
  if (patch.direction != null || patch.xAxis != null) {
    const resolved = frame({ direction: patch.direction || view.direction, xAxis: patch.xAxis || view.xAxis });
    view.direction = resolved.direction;
    view.xAxis = resolved.xAxis;
  }
  return attach(project, graph);
}

export function deleteStudioNamedDrawingView(project, viewId) {
  const graph = from(project);
  const index = graph.views.findIndex((entry) => entry.id === viewId);
  if (index < 0) fail('DRAWING_VIEW_NOT_FOUND', 'Requested named drawing view does not exist.');
  const users = (project?.extensions?.drawingBook?.sheets || []).filter((sheet) => Array.isArray(sheet.views) && sheet.views.includes(viewId)).map((sheet) => sheet.id);
  if (users.length) fail('DRAWING_VIEW_IN_USE', 'Named drawing view is used by one or more drawing sheets.', { sheetIds: users });
  const derivedUsers = graph.derivedViews.filter((entry) => entry.sourceViewId === viewId).map((entry) => entry.id);
  if (derivedUsers.length) fail('DRAWING_VIEW_IN_USE', 'Named drawing view is the source of one or more derived drawing views.', { derivedViewIds: derivedUsers });
  graph.views.splice(index, 1);
  return attach(project, graph);
}

export function createStudioDerivedDrawingView(project, input = {}) {
  requireDerivedPart(project);
  const graph = from(project);
  if (graph.derivedViews.length >= 100) fail('DRAWING_VIEW_LIMIT_EXCEEDED', 'A project supports at most 100 derived drawing views.');
  const namedIds = new Set(graph.views.map((entry) => entry.id));
  const id = `drawing-derived-view-${String(++graph.derivedSequence).padStart(6, '0')}`;
  const record = derivedRecord(input, id, namedIds, project);
  const folded = record.name.toLowerCase();
  if (graph.views.some((entry) => entry.name.toLowerCase() === folded) || graph.derivedViews.some((entry) => entry.name.toLowerCase() === folded)) {
    fail('DRAWING_VIEW_EXISTS', `Drawing view "${record.name}" already exists.`);
  }
  graph.derivedViews.push(record);
  return attach(project, graph);
}

export function updateStudioDerivedDrawingView(project, input = {}) {
  requireDerivedPart(project);
  const graph = from(project);
  const index = graph.derivedViews.findIndex((entry) => entry.id === input.viewId);
  if (index < 0) fail('DRAWING_VIEW_NOT_FOUND', 'Requested derived drawing view does not exist.');
  const patch = input.patch && typeof input.patch === 'object' ? input.patch : {};
  const unknown = Object.keys(patch).filter((key) => !['name', 'kind', 'sourceViewId', 'definition'].includes(key));
  if (unknown.length) fail('DRAWING_VIEW_INPUT_INVALID', 'Derived drawing-view patch contains unsupported fields.', { unknown });
  const namedIds = new Set(graph.views.map((entry) => entry.id));
  graph.derivedViews[index] = derivedRecord({ ...graph.derivedViews[index], ...patch }, input.viewId, namedIds, project);
  return attach(project, graph);
}

export function deleteStudioDerivedDrawingView(project, viewId) {
  requireDerivedPart(project);
  const graph = from(project);
  const index = graph.derivedViews.findIndex((entry) => entry.id === viewId);
  if (index < 0) fail('DRAWING_VIEW_NOT_FOUND', 'Requested derived drawing view does not exist.');
  const users = (project?.extensions?.drawingBook?.sheets || []).filter((sheet) => Array.isArray(sheet.views) && sheet.views.includes(viewId)).map((sheet) => sheet.id);
  if (users.length) fail('DRAWING_VIEW_IN_USE', 'Derived drawing view is used by one or more drawing sheets.', { sheetIds: users });
  graph.derivedViews.splice(index, 1);
  return attach(project, graph);
}

export function inspectStudioDrawingViews(project) {
  return from(project);
}

export function studioDrawingViewIds(project) {
  const graph = from(project);
  return new Set([...graph.views.map((entry) => entry.id), ...graph.derivedViews.map((entry) => entry.id)]);
}

export function resolveStudioDrawingViewRequests(project, viewIds) {
  if (!Array.isArray(viewIds) || !viewIds.length || new Set(viewIds).size !== viewIds.length) fail('DRAWING_VIEW_INPUT_INVALID', 'Drawing view request ids must be a non-empty unique list.');
  const graph = from(project);
  const named = new Map(graph.views.map((entry) => [entry.id, entry]));
  const derived = new Map(graph.derivedViews.map((entry) => [entry.id, entry]));
  const sourceRequest = (key) => {
    if (STUDIO_STANDARD_DRAWING_VIEWS.includes(key)) return { standard: key, direction: null, xAxis: null };
    const view = named.get(key);
    if (!view) fail('DRAWING_VIEW_NOT_FOUND', `Drawing view "${key}" does not exist.`);
    return { standard: null, direction: clone(view.direction), xAxis: clone(view.xAxis) };
  };
  return viewIds.map((id) => {
    const key = String(id);
    if (STUDIO_STANDARD_DRAWING_VIEWS.includes(key)) return key;
    const view = named.get(key);
    if (view) return { id: view.id, name: view.name, direction: clone(view.direction), xAxis: clone(view.xAxis) };
    const child = derived.get(key);
    if (!child) fail('DRAWING_VIEW_NOT_FOUND', `Drawing view "${key}" does not exist.`);
    const source = sourceRequest(child.sourceViewId);
    return {
      id: child.id,
      name: child.name,
      ...source,
      derived: { kind: child.kind, sourceViewId: child.sourceViewId, definition: clone(child.definition) },
    };
  });
}
