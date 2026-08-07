// Shared, document-owned helpers for the bounded PT007 pattern families.
//
// This module is deliberately independent of the project validator, runtime
// document, DOM, and OpenCascade.  Document/runtime code uses it to reject
// structurally impossible fill recipes, and the production worker consumes the
// same deterministic lattice before applying its exact-kernel checks.  The
// generated positions are never persisted in the project document.

export const STUDIO_FILL_PATTERN_LAYOUTS = Object.freeze(['square', 'triangular']);
export const STUDIO_FILL_PATTERN_MAX_CANDIDATES = 100_000;
export const STUDIO_VARIABLE_PATTERN_MAX_GENERATED = 100;
export const STUDIO_VARIABLE_PATTERN_MAX_PARAMETERS = 16;
export const STUDIO_VARIABLE_PATTERN_DIMENSION_FIELDS = Object.freeze([
  'h', 'r', 't', 'thickness', 'angle', 'startAngle',
]);

const EPSILON = 1e-9;

function finitePoint(value, label) {
  if (!Array.isArray(value) || value.length !== 2
      || value.some((coordinate) => !Number.isFinite(coordinate))) {
    throw new Error(label + ' must contain exactly two finite coordinates.');
  }
  return [value[0], value[1]];
}

function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1])
    - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointOnSegment(point, a, b, tolerance = EPSILON) {
  if (Math.abs(cross(a, b, point)) > tolerance) return false;
  return point[0] >= Math.min(a[0], b[0]) - tolerance
    && point[0] <= Math.max(a[0], b[0]) + tolerance
    && point[1] >= Math.min(a[1], b[1]) - tolerance
    && point[1] <= Math.max(a[1], b[1]) + tolerance;
}

function orientation(a, b, c) {
  const value = cross(a, b, c);
  return Math.abs(value) <= EPSILON ? 0 : Math.sign(value);
}

function segmentsIntersect(a, b, c, d) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (abC !== abD && cdA !== cdB) return true;
  return (abC === 0 && pointOnSegment(c, a, b))
    || (abD === 0 && pointOnSegment(d, a, b))
    || (cdA === 0 && pointOnSegment(a, c, d))
    || (cdB === 0 && pointOnSegment(b, c, d));
}

function validateSimplePolygon(value) {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error('Fill pattern boundary requires at least three current profile points.');
  }
  const points = value.map((point, index) => finitePoint(point, 'Fill boundary point ' + (index + 1)));
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    if (Math.hypot(next[0] - points[index][0], next[1] - points[index][1]) <= EPSILON) {
      throw new Error('Fill pattern boundary contains a zero-length edge.');
    }
  }
  const twiceArea = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0);
  if (Math.abs(twiceArea) <= EPSILON) throw new Error('Fill pattern boundary has zero area.');
  for (let left = 0; left < points.length; left++) {
    const leftNext = (left + 1) % points.length;
    for (let right = left + 1; right < points.length; right++) {
      const rightNext = (right + 1) % points.length;
      if (left === right || leftNext === right || rightNext === left) continue;
      if (segmentsIntersect(points[left], points[leftNext], points[right], points[rightNext])) {
        throw new Error('Fill pattern boundary must be one simple non-self-intersecting polygon.');
      }
    }
  }
  return points;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[previous];
    const b = polygon[index];
    if (pointOnSegment(point, a, b)) return true;
    const crosses = (a[1] > point[1]) !== (b[1] > point[1]);
    if (crosses) {
      const intersectionX = a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
      if (intersectionX > point[0]) inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const denominator = dx * dx + dy * dy;
  const parameter = denominator <= EPSILON
    ? 0
    : Math.min(1, Math.max(0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator));
  return Math.hypot(point[0] - (a[0] + parameter * dx), point[1] - (a[1] + parameter * dy));
}

function boundaryDistance(point, polygon) {
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index++) {
    distance = Math.min(distance, distanceToSegment(point, polygon[index], polygon[(index + 1) % polygon.length]));
  }
  return distance;
}

function latticeBasis(layout, spacing, rotationDegrees) {
  const angle = rotationDegrees * Math.PI / 180;
  const u = [Math.cos(angle) * spacing, Math.sin(angle) * spacing];
  const perpendicular = [-Math.sin(angle), Math.cos(angle)];
  const v = layout === 'triangular'
    ? [u[0] * 0.5 + perpendicular[0] * spacing * Math.sqrt(3) / 2,
      u[1] * 0.5 + perpendicular[1] * spacing * Math.sqrt(3) / 2]
    : [perpendicular[0] * spacing, perpendicular[1] * spacing];
  return { u, v };
}

function latticeCoordinate(point, seed, basis) {
  const x = point[0] - seed[0];
  const y = point[1] - seed[1];
  const determinant = basis.u[0] * basis.v[1] - basis.u[1] * basis.v[0];
  return [
    (x * basis.v[1] - y * basis.v[0]) / determinant,
    (basis.u[0] * y - basis.u[1] * x) / determinant,
  ];
}

/**
 * Derive one deterministic current fill lattice without persisting generated
 * positions.  Returned `key` values remain tied to lattice coordinates even
 * when a boundary edit admits or removes other candidates.
 */
export function studioFillPatternLattice({
  boundaryPoints,
  layout,
  spacing,
  rotationDegrees,
  boundaryMargin,
  seed,
  maxGenerated = 5000,
}) {
  const polygon = validateSimplePolygon(boundaryPoints);
  if (!STUDIO_FILL_PATTERN_LAYOUTS.includes(layout)) {
    throw new Error('Fill pattern layout must be square or triangular.');
  }
  if (!Number.isFinite(spacing) || spacing <= EPSILON) {
    throw new Error('Fill pattern spacing must evaluate above zero.');
  }
  if (!Number.isFinite(rotationDegrees)) throw new Error('Fill pattern rotation must evaluate to a finite angle.');
  if (!Number.isFinite(boundaryMargin) || boundaryMargin < 0) {
    throw new Error('Fill pattern boundary margin must evaluate to zero or above.');
  }
  const anchor = finitePoint(seed, 'Fill pattern seed');
  if (!Number.isInteger(maxGenerated) || maxGenerated < 1 || maxGenerated > 5000) {
    throw new Error('Fill pattern generated-occurrence limit must be an integer from 1 to 5,000.');
  }
  const basis = latticeBasis(layout, spacing, rotationDegrees);
  const latticePolygon = polygon.map((point) => latticeCoordinate(point, anchor, basis));
  const iMin = Math.floor(Math.min(...latticePolygon.map((point) => point[0]))) - 1;
  const iMax = Math.ceil(Math.max(...latticePolygon.map((point) => point[0]))) + 1;
  const jMin = Math.floor(Math.min(...latticePolygon.map((point) => point[1]))) - 1;
  const jMax = Math.ceil(Math.max(...latticePolygon.map((point) => point[1]))) + 1;
  const candidateCount = (iMax - iMin + 1) * (jMax - jMin + 1);
  if (!Number.isSafeInteger(candidateCount) || candidateCount > STUDIO_FILL_PATTERN_MAX_CANDIDATES) {
    throw new Error('Fill pattern exceeds the bounded 100,000-candidate lattice budget.');
  }
  const positions = [];
  for (let j = jMin; j <= jMax; j++) {
    for (let i = iMin; i <= iMax; i++) {
      if (i === 0 && j === 0) continue;
      const point = [
        anchor[0] + basis.u[0] * i + basis.v[0] * j,
        anchor[1] + basis.u[1] * i + basis.v[1] * j,
      ];
      if (!pointInPolygon(point, polygon)) continue;
      if (boundaryMargin > 0 && boundaryDistance(point, polygon) + EPSILON < boundaryMargin) continue;
      positions.push({ key: i + ':' + j, lattice: [i, j], point });
      if (positions.length > maxGenerated) {
        throw new Error('Fill pattern exceeds the bounded ' + maxGenerated + '-generated-occurrence limit.');
      }
    }
  }
  if (!positions.length) {
    throw new Error('Fill pattern recipe produces no generated occurrence inside the current boundary.');
  }
  return positions;
}
