import { resolveStudioV5Datums, resolveStudioV5PathPreview } from './studio-v5-modeling.js';

export const STUDIO_SKETCH_PIERCE_SCHEMA = 'partmode.sketch-pierce/v1';

const EPSILON = 1e-9;
const subtract = (left, right) => left.map((value, index) => value - right[index]);
const add = (left, right) => left.map((value, index) => value + right[index]);
const multiply = (vector, scalar) => vector.map((value) => value * scalar);
const dot = (left, right) => left.reduce((total, value, index) => total + value * right[index], 0);
const cross = (left, right) => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];
const magnitude = (vector) => Math.hypot(...vector);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function finiteVector(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => !Number.isFinite(entry))) {
    fail('SKETCH_PIERCE_REFERENCE_INVALID', `${label} must contain three finite numbers.`);
  }
  return value.map(Number);
}

function normalize(value, label) {
  const vector = finiteVector(value, label);
  const length = magnitude(vector);
  if (!(length > EPSILON)) fail('SKETCH_PIERCE_REFERENCE_INVALID', `${label} must have non-zero length.`);
  return multiply(vector, 1 / length);
}

function uniqueIntersections(points, plane) {
  const intersections = [];
  const push = (point, segmentIndex, parameter) => {
    if (intersections.some((entry) => magnitude(subtract(entry.point, point)) <= EPSILON)) return;
    intersections.push({ point, segmentIndex, parameter });
  };
  for (let index = 0; index < points.length - 1; index++) {
    const first = finiteVector(points[index], `Reference curve point ${index}`);
    const second = finiteVector(points[index + 1], `Reference curve point ${index + 1}`);
    const firstDistance = dot(subtract(first, plane.origin), plane.normal);
    const secondDistance = dot(subtract(second, plane.origin), plane.normal);
    const firstOnPlane = Math.abs(firstDistance) <= EPSILON;
    const secondOnPlane = Math.abs(secondDistance) <= EPSILON;
    if (firstOnPlane && secondOnPlane) {
      fail('SKETCH_PIERCE_COINCIDENT_CURVE', 'The reference curve contains a segment in the sketch plane, so Pierce has no unique intersection.', { segmentIndex: index });
    }
    if (firstOnPlane) push(first, index, 0);
    if (secondOnPlane) push(second, index, 1);
    if (!firstOnPlane && !secondOnPlane && firstDistance * secondDistance < 0) {
      const parameter = firstDistance / (firstDistance - secondDistance);
      push(add(first, multiply(subtract(second, first), parameter)), index, parameter);
    }
  }
  return intersections;
}

export function resolveStudioV5PierceTarget(project, partId, constraint) {
  if (!constraint || constraint.kind !== 'pierce') fail('SKETCH_PIERCE_CONSTRAINT_INVALID', 'Pierce resolution requires a Pierce constraint.');
  const curveSketchId = String(constraint.curveSketchId || '');
  const planeDatumId = String(constraint.planeDatumId || '');
  if (!curveSketchId || !planeDatumId) {
    fail('SKETCH_PIERCE_REFERENCE_INVALID', 'Pierce requires persistent curveSketchId and planeDatumId references.');
  }
  let path;
  let plane;
  try {
    path = resolveStudioV5PathPreview(project, curveSketchId, partId);
    plane = resolveStudioV5Datums(project, partId).resolve(planeDatumId);
  } catch (error) {
    fail('SKETCH_PIERCE_REFERENCE_MISSING', String(error?.message || error), { curveSketchId, planeDatumId });
  }
  if (plane.kind !== 'plane') fail('SKETCH_PIERCE_REFERENCE_INVALID', 'Pierce support must resolve to a datum plane.', { planeDatumId });
  if (path.exactPolylineEvaluation !== true) {
    fail('SKETCH_PIERCE_CURVE_UNSUPPORTED', 'Pierce currently requires an exact polyline-compatible path; curved paths are rejected.', { curveSketchId });
  }
  if (!Array.isArray(path.points) || path.points.length < 2) {
    fail('SKETCH_PIERCE_REFERENCE_INVALID', 'Pierce reference curve requires at least two exact points.', { curveSketchId });
  }
  const normal = normalize(plane.normal, 'Pierce plane normal');
  const rawX = normalize(plane.xDirection, 'Pierce plane X direction');
  const xDirection = normalize(subtract(rawX, multiply(normal, dot(rawX, normal))), 'Pierce plane X direction');
  const yDirection = normalize(cross(normal, xDirection), 'Pierce plane Y direction');
  const intersections = uniqueIntersections(path.points, { origin: finiteVector(plane.origin, 'Pierce plane origin'), normal });
  if (intersections.length !== 1) {
    fail(
      intersections.length ? 'SKETCH_PIERCE_AMBIGUOUS' : 'SKETCH_PIERCE_NO_INTERSECTION',
      intersections.length
        ? `The reference curve crosses the sketch plane ${intersections.length} times; Pierce requires one unique intersection.`
        : 'The reference curve does not cross the sketch plane.',
      { curveSketchId, planeDatumId, intersections: intersections.length },
    );
  }
  const intersection = intersections[0];
  const relative = subtract(intersection.point, plane.origin);
  return {
    schema: STUDIO_SKETCH_PIERCE_SCHEMA,
    target: [dot(relative, xDirection), dot(relative, yDirection)],
    worldPoint: intersection.point,
    curveSketchId,
    planeDatumId,
    segmentIndex: intersection.segmentIndex,
    segmentParameter: intersection.parameter,
  };
}

export function createStudioV5PierceResolver(project, partId = project?.rootDocument?.partId) {
  return (constraint) => resolveStudioV5PierceTarget(project, partId, constraint).target;
}
