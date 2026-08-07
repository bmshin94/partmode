// Simultaneous rigid-body assembly constraint core.
//
// This module is deliberately independent of the project schema and OCCT. The
// project adapter resolves persistent datum/topology references into local
// frames, then this core solves every active mate together. It never applies a
// mate as a one-way alignment, so declaration order cannot choose the result.

const EPSILON = 1e-12;
const SUPPORTED_GEOMETRY_KINDS = new Set(['plane', 'cylinder', 'cone', 'sphere']);
const CONVENTIONAL_MATE_KINDS = new Set([
  'coincident',
  'tangent',
  'concentric',
  'revolute',
  'distance',
  'parallel',
  'perpendicular',
  'angle',
  'slider',
]);
const ADVANCED_MATE_KINDS = new Set([
  'width',
  'symmetry',
  'path',
  'linear-coupler',
  'limit-distance',
  'limit-angle',
]);
const MECHANICAL_MATE_KINDS = new Set(['gear', 'hinge']);

const add = (left, right) => left.map((value, index) => value + right[index]);
const subtract = (left, right) => left.map((value, index) => value - right[index]);
const multiply = (vector, scalar) => vector.map((value) => value * scalar);
const dot = (left, right) => left.reduce((total, value, index) => total + value * right[index], 0);
const cross = (left, right) => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];
const magnitude = (vector) => Math.hypot(...vector);

function normalize(vector, label) {
  const size = magnitude(vector);
  if (!(size > EPSILON)) throw new Error(label + ' has zero length.');
  return multiply(vector, 1 / size);
}

function finiteVector(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => !Number.isFinite(entry))) {
    throw new Error(label + ' must contain three finite numbers.');
  }
  return value.map(Number);
}

function finiteTransform(value, label) {
  if (!Array.isArray(value) || value.length !== 16 || value.some((entry) => !Number.isFinite(entry))) {
    throw new Error(label + ' must contain sixteen finite numbers.');
  }
  return value.map(Number);
}

function transformPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function transformVector(matrix, vector) {
  const [x, y, z] = vector;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z,
    matrix[1] * x + matrix[5] * y + matrix[9] * z,
    matrix[2] * x + matrix[6] * y + matrix[10] * z,
  ];
}

function tangentBasis(direction) {
  const candidate = Math.abs(direction[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const first = normalize(cross(direction, candidate), 'frame tangent');
  return [first, normalize(cross(direction, first), 'frame cotangent')];
}

function normalizedFrame(frame, occurrenceId, label, strictGeometry = false) {
  if (!frame || typeof frame !== 'object') throw new Error(label + ' is missing.');
  if (strictGeometry && !SUPPORTED_GEOMETRY_KINDS.has(frame.geometryKind)) {
    throw new Error(label + '.geometryKind must name a supported analytic reference.');
  }
  const direction = normalize(finiteVector(frame.direction || frame.normal || frame.zDirection, label + '.direction'), label + '.direction');
  let xDirection = frame.xDirection ? finiteVector(frame.xDirection, label + '.xDirection') : tangentBasis(direction)[0];
  xDirection = subtract(xDirection, multiply(direction, dot(xDirection, direction)));
  xDirection = normalize(xDirection, label + '.xDirection');
  return {
    occurrenceId,
    geometryKind: SUPPORTED_GEOMETRY_KINDS.has(frame.geometryKind) ? frame.geometryKind : 'plane',
    origin: finiteVector(strictGeometry ? frame.origin : frame.origin || [0, 0, 0], label + '.origin'),
    direction,
    xDirection,
  };
}

function worldFrame(local, transforms) {
  const transform = transforms.get(local.occurrenceId);
  if (!transform) throw new Error('Mate frame occurrence "' + local.occurrenceId + '" is missing.');
  return {
    geometryKind: local.geometryKind,
    origin: transformPoint(transform, local.origin),
    direction: normalize(transformVector(transform, local.direction), 'transformed frame direction'),
    xDirection: normalize(transformVector(transform, local.xDirection), 'transformed frame x direction'),
  };
}

function row(value, unit, semantic) {
  return { value, unit, semantic };
}

function vectorRows(vector, unit, semantic) {
  return vector.map((value, axis) => row(value, unit, semantic + '.' + 'xyz'[axis]));
}

function alignedDirectionRows(anchorDirection, movingDirection, sign, semantic) {
  return vectorRows(subtract(movingDirection, multiply(anchorDirection, sign)), 'angular', semantic);
}

const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

// Rotation of a world frame about its own axis direction, measured against
// the deterministic tangent basis of that direction. The stored local frame
// evaluates to zero at an identity placement, so the coupled gear equation is
// anchored to the authored axis frames rather than an arbitrary datum.
function axisRotationAngle(frame) {
  const [tangent, cotangent] = tangentBasis(frame.direction);
  return Math.atan2(dot(frame.xDirection, cotangent), dot(frame.xDirection, tangent));
}

function projectedTwistAngle(anchor, moving, targetDirection) {
  const anchorX = normalize(subtract(anchor.xDirection, multiply(targetDirection, dot(anchor.xDirection, targetDirection))), 'anchor hinge x direction');
  const movingX = normalize(subtract(moving.xDirection, multiply(targetDirection, dot(moving.xDirection, targetDirection))), 'moving hinge x direction');
  return Math.atan2(dot(cross(anchorX, movingX), targetDirection), dot(anchorX, movingX));
}

function polynomialValue(coefficients, parameter) {
  let value = 0;
  for (let index = coefficients.length - 1; index >= 0; index--) value = value * parameter + coefficients[index];
  return value;
}

function normalizedPolynomial(coefficients) {
  const result = [...coefficients];
  const scale = Math.max(0, ...result.map(Math.abs));
  if (!(scale > 0)) return [0];
  while (result.length > 1 && Math.abs(result.at(-1)) <= scale * 1e-14) result.pop();
  const retainedScale = Math.max(...result.map(Math.abs));
  return result.map((value) => value / retainedScale);
}

// Isolate every real root in [0, 1] by recursively partitioning at the roots
// of the derivative. Degree-five point-to-cubic stationarity polynomials are
// therefore evaluated against the exact Bezier span, never a display mesh or
// sampled polyline.
function unitIntervalPolynomialRoots(inputCoefficients) {
  const coefficients = normalizedPolynomial(inputCoefficients);
  const degree = coefficients.length - 1;
  if (degree <= 0) return [];
  if (degree === 1) {
    const root = -coefficients[0] / coefficients[1];
    return root >= -1e-12 && root <= 1 + 1e-12 ? [Math.max(0, Math.min(1, root))] : [];
  }
  const derivative = coefficients.slice(1).map((value, index) => value * (index + 1));
  const critical = unitIntervalPolynomialRoots(derivative)
    .filter((value) => value > 1e-12 && value < 1 - 1e-12)
    .sort((left, right) => left - right);
  const boundaries = [0, ...critical, 1];
  const roots = [];
  const push = (value) => {
    let bounded = Math.max(0, Math.min(1, value));
    for (let iteration = 0; iteration < 12; iteration++) {
      const residual = polynomialValue(coefficients, bounded);
      const slope = polynomialValue(derivative, bounded);
      if (!(Math.abs(slope) > 1e-15)) break;
      const next = bounded - residual / slope;
      if (!(next >= 0 && next <= 1) || Math.abs(next - bounded) <= Number.EPSILON) break;
      bounded = next;
    }
    if (!roots.some((entry) => Math.abs(entry - bounded) <= 1e-9)) roots.push(bounded);
  };
  for (const boundary of boundaries) {
    if (Math.abs(polynomialValue(coefficients, boundary)) <= 1e-10) push(boundary);
  }
  for (let index = 0; index < boundaries.length - 1; index++) {
    let lower = boundaries[index];
    let upper = boundaries[index + 1];
    let lowerValue = polynomialValue(coefficients, lower);
    const upperValue = polynomialValue(coefficients, upper);
    if (lowerValue === 0 || upperValue === 0 || lowerValue * upperValue > 0) continue;
    for (let iteration = 0; iteration < 64; iteration++) {
      const middle = (lower + upper) / 2;
      const middleValue = polynomialValue(coefficients, middle);
      if (upper - lower <= 1e-15) {
        lower = middle;
        upper = middle;
        break;
      }
      if (lowerValue * middleValue <= 0) {
        upper = middle;
      } else {
        lower = middle;
        lowerValue = middleValue;
      }
    }
    push((lower + upper) / 2);
  }
  return roots.sort((left, right) => left - right);
}

function cubicPowerCoefficients(points) {
  const [first, controlA, controlB, last] = points;
  return [
    first,
    multiply(subtract(controlA, first), 3),
    multiply(add(subtract(controlB, multiply(controlA, 2)), first), 3),
    add(subtract(last, multiply(controlB, 3)), add(multiply(controlA, 3), multiply(first, -1))),
  ];
}

function evaluateVectorPolynomial(coefficients, parameter) {
  const result = [0, 0, 0];
  for (let index = coefficients.length - 1; index >= 0; index--) {
    for (let axis = 0; axis < 3; axis++) result[axis] = result[axis] * parameter + coefficients[index][axis];
  }
  return result;
}

function closestPointOnLine(points, query) {
  const direction = subtract(points[1], points[0]);
  const parameter = Math.max(0, Math.min(1, dot(subtract(query, points[0]), direction) / dot(direction, direction)));
  return add(points[0], multiply(direction, parameter));
}

function closestPointOnCubic(points, query) {
  const coefficients = cubicPowerCoefficients(points);
  const displaced = [[...subtract(coefficients[0], query)], coefficients[1], coefficients[2], coefficients[3]];
  const derivative = [coefficients[1], multiply(coefficients[2], 2), multiply(coefficients[3], 3)];
  const stationarity = Array(6).fill(0);
  for (let left = 0; left < displaced.length; left++) {
    for (let right = 0; right < derivative.length; right++) stationarity[left + right] += dot(displaced[left], derivative[right]);
  }
  const candidates = [0, ...unitIntervalPolynomialRoots(stationarity), 1];
  let closest = evaluateVectorPolynomial(coefficients, 0);
  let closestDistance = dot(subtract(closest, query), subtract(closest, query));
  for (const parameter of candidates) {
    const point = evaluateVectorPolynomial(coefficients, parameter);
    const delta = subtract(point, query);
    const distance = dot(delta, delta);
    if (distance < closestDistance) {
      closest = point;
      closestDistance = distance;
    }
  }
  return closest;
}

function closestPointOnPath(path, ownerTransform, query) {
  let closest = null;
  let closestDistance = Infinity;
  for (const segment of path.segments) {
    const points = segment.points.map((point) => transformPoint(ownerTransform, point));
    const candidate = segment.kind === 'line'
      ? closestPointOnLine(points, query)
      : closestPointOnCubic(points, query);
    const delta = subtract(candidate, query);
    const distance = dot(delta, delta);
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }
  return closest;
}

function mateRows(mate, transforms) {
  const [localAnchor, localMoving] = mate.frames;
  const anchor = worldFrame(localAnchor, transforms);
  const moving = worldFrame(localMoving, transforms);
  const sign = mate.flip ? -1 : 1;
  const targetDirection = multiply(anchor.direction, sign);
  const offset = subtract(moving.origin, anchor.origin);
  const [tangent, cotangent] = tangentBasis(targetDirection);
  const transverse = [dot(offset, tangent), dot(offset, cotangent)];
  const value = mate.value;
  const aligned = () => alignedDirectionRows(anchor.direction, moving.direction, sign, 'axis-alignment');

  switch (mate.kind) {
    case 'width':
      return [
        row(dot(offset, targetDirection) - value, 'linear', 'width-center-station'),
        ...alignedDirectionRows(anchor.direction, moving.direction, sign, 'width-direction-alignment'),
      ];
    case 'symmetry': {
      const plane = worldFrame(mate.frames[2], transforms);
      const firstToPlane = subtract(anchor.origin, plane.origin);
      const reflectedOrigin = subtract(anchor.origin, multiply(plane.direction, 2 * dot(firstToPlane, plane.direction)));
      const reflectedDirection = subtract(anchor.direction, multiply(plane.direction, 2 * dot(anchor.direction, plane.direction)));
      return [
        ...vectorRows(subtract(moving.origin, reflectedOrigin), 'linear', 'symmetry-origin'),
        ...vectorRows(subtract(moving.direction, reflectedDirection), 'angular', 'symmetry-direction'),
      ];
    }
    case 'path': {
      const ownerTransform = transforms.get(localAnchor.occurrenceId);
      if (!ownerTransform) throw new Error('Path owner occurrence "' + localAnchor.occurrenceId + '" is missing.');
      const closest = closestPointOnPath(mate.path, ownerTransform, moving.origin);
      return vectorRows(subtract(moving.origin, closest), 'linear', 'path-point');
    }
    case 'linear-coupler': {
      const anchorCoordinate = dot(anchor.origin, anchor.direction);
      const movingCoordinate = dot(moving.origin, moving.direction);
      return [row(anchorCoordinate - mate.advanced.ratio * movingCoordinate - mate.advanced.offset, 'linear', 'linear-coupler')];
    }
    case 'limit-distance': {
      const distance = dot(offset, targetDirection);
      const residual = distance < mate.advanced.minimum
        ? distance - mate.advanced.minimum
        : distance > mate.advanced.maximum
          ? distance - mate.advanced.maximum
          : 0;
      return [row(residual, 'linear', 'limit-distance')];
    }
    case 'limit-angle': {
      const cosine = Math.max(-1, Math.min(1, dot(targetDirection, moving.direction)));
      const angle = Math.acos(cosine);
      const minimum = mate.advanced.minimum * Math.PI / 180;
      const maximum = mate.advanced.maximum * Math.PI / 180;
      const residual = angle < minimum ? angle - minimum : angle > maximum ? angle - maximum : 0;
      return [row(residual, 'angular', 'limit-angle')];
    }
    case 'gear': {
      // theta2 = -ratio * theta1 + offset. The gear couples only rotation;
      // shaft translations remain governed by the other mates on each axis.
      const firstAngle = axisRotationAngle(anchor);
      const secondAngle = axisRotationAngle(moving);
      const offsetRadians = mate.advanced.offset * Math.PI / 180;
      return [row(
        wrapAngle(secondAngle + mate.advanced.ratio * firstAngle - offsetRadians),
        'angular',
        'gear-rotation-coupling',
      )];
    }
    case 'hinge': {
      const rows = [
        row(transverse[0], 'linear', 'axis-offset.u'),
        row(transverse[1], 'linear', 'axis-offset.v'),
        row(dot(offset, targetDirection), 'linear', 'axial-station'),
        ...aligned(),
      ];
      if (mate.advanced.minimum != null) {
        const twist = projectedTwistAngle(anchor, moving, targetDirection);
        const minimum = mate.advanced.minimum * Math.PI / 180;
        const maximum = mate.advanced.maximum * Math.PI / 180;
        const residual = twist < minimum ? twist - minimum : twist > maximum ? twist - maximum : 0;
        rows.push(row(residual, 'angular', 'hinge-limit-angle'));
      }
      return rows;
    }
    case 'coincident':
    case 'tangent':
      return [
        row(dot(offset, targetDirection) - value, 'linear', 'plane-offset'),
        ...aligned(),
      ];
    case 'concentric':
      if (anchor.geometryKind === 'sphere' || moving.geometryKind === 'sphere') {
        if (anchor.geometryKind !== 'sphere' || moving.geometryKind !== 'sphere') {
          throw new Error('A spherical concentric mate requires two spherical references.');
        }
        return vectorRows(offset, 'linear', 'center-offset');
      }
      return [
        row(transverse[0], 'linear', 'axis-offset.u'),
        row(transverse[1], 'linear', 'axis-offset.v'),
        ...aligned(),
      ];
    case 'revolute':
      return [
        row(transverse[0], 'linear', 'axis-offset.u'),
        row(transverse[1], 'linear', 'axis-offset.v'),
        row(dot(offset, targetDirection) - value, 'linear', 'axial-station'),
        ...aligned(),
      ];
    case 'distance':
      return [row(dot(offset, targetDirection) - value, 'linear', 'normal-distance')];
    case 'parallel':
      return aligned();
    case 'perpendicular':
      return [row(dot(anchor.direction, moving.direction), 'angular', 'axis-perpendicular')];
    case 'angle': {
      const radians = value * Math.PI / 180;
      return [row(dot(anchor.direction, moving.direction) - Math.cos(radians), 'angular', 'axis-angle')];
    }
    case 'slider': {
      const anchorX = normalize(subtract(anchor.xDirection, multiply(targetDirection, dot(anchor.xDirection, targetDirection))), 'anchor slider x direction');
      const movingX = normalize(subtract(moving.xDirection, multiply(targetDirection, dot(moving.xDirection, targetDirection))), 'moving slider x direction');
      return [
        row(transverse[0], 'linear', 'axis-offset.u'),
        row(transverse[1], 'linear', 'axis-offset.v'),
        row(dot(cross(movingX, anchorX), targetDirection), 'angular', 'axis-twist'),
        ...aligned(),
      ];
    }
    default:
      throw new Error('Unsupported simultaneous assembly mate kind "' + mate.kind + '".');
  }
}

function rotationMatrix(vector) {
  const angle = magnitude(vector);
  if (angle < 1e-14) {
    const [x, y, z] = vector;
    return [1, -z, y, z, 1, -x, -y, x, 1];
  }
  const [x, y, z] = multiply(vector, 1 / angle);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const complement = 1 - cosine;
  return [
    complement * x * x + cosine,
    complement * x * y - sine * z,
    complement * x * z + sine * y,
    complement * x * y + sine * z,
    complement * y * y + cosine,
    complement * y * z - sine * x,
    complement * x * z - sine * y,
    complement * y * z + sine * x,
    complement * z * z + cosine,
  ];
}

function rotateVector(matrix, vector) {
  return [
    matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
    matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
    matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2],
  ];
}

function perturbedTransform(transform, component, amount) {
  const result = [...transform];
  if (component < 3) {
    result[12 + component] += amount;
    return result;
  }
  const rotationVector = [0, 0, 0];
  rotationVector[component - 3] = amount;
  const rotation = rotationMatrix(rotationVector);
  for (const offset of [0, 4, 8]) {
    const rotated = rotateVector(rotation, [transform[offset], transform[offset + 1], transform[offset + 2]]);
    result[offset] = rotated[0];
    result[offset + 1] = rotated[1];
    result[offset + 2] = rotated[2];
  }
  return result;
}

function applyDelta(transform, delta, options) {
  const result = [...transform];
  const translation = delta.slice(0, 3);
  const translationSize = magnitude(translation);
  const limitedTranslation = translationSize > options.maxTranslationStep
    ? multiply(translation, options.maxTranslationStep / translationSize)
    : translation;
  result[12] += limitedTranslation[0];
  result[13] += limitedTranslation[1];
  result[14] += limitedTranslation[2];
  const rotation = delta.slice(3, 6);
  const rotationSize = magnitude(rotation);
  const limitedRotation = rotationSize > options.maxRotationStepRadians
    ? multiply(rotation, options.maxRotationStepRadians / rotationSize)
    : rotation;
  return perturbedTransform(perturbedTransform(perturbedTransform(result, 3, limitedRotation[0]), 4, limitedRotation[1]), 5, limitedRotation[2]);
}

// Direction alignment and unsigned angular limits have legitimate stationary
// maxima at exactly 180 degrees, while a lower angular limit has a cusp at
// exactly 0 degrees. A centered-difference Gauss-Newton step is therefore zero
// at those feasible starting states. Probe a small, deterministic set of rigid
// rotations only when the ordinary step is stationary, and accept a probe only
// when it strictly lowers the complete simultaneous objective. Irreducible
// systems still reach the unchanged rank/augmented-rank conflict classifier.
function rotatedAroundLocalPoint(transform, component, amount, localPoint, options) {
  const fixedPoint = transformPoint(transform, localPoint);
  const rotated = perturbedTransform(transform, component, amount);
  const movedPoint = transformPoint(rotated, localPoint);
  const correction = subtract(fixedPoint, movedPoint);
  if (magnitude(correction) > options.maxTranslationStep) return null;
  rotated[12] += correction[0];
  rotated[13] += correction[1];
  rotated[14] += correction[2];
  return rotated;
}

function stationaryRotationEscape(mates, transforms, movable, characteristicLength, options, before) {
  const step = Math.min(options.maxRotationStepRadians, options.stationaryRotationProbeRadians);
  if (!(step > 0)) return null;
  let best = null;
  let bestObjective = before;
  for (const occurrence of [...movable].sort((left, right) => left.id.localeCompare(right.id))) {
    const original = transforms.get(occurrence.id);
    const pivots = new Map([['0,0,0', [0, 0, 0]]]);
    for (const mate of mates) for (const frame of mate.frames) if (frame.occurrenceId === occurrence.id) {
      pivots.set(frame.origin.join(','), frame.origin);
    }
    for (const localPoint of [...pivots.entries()].sort(([left], [right]) => left.localeCompare(right)).map((entry) => entry[1])) {
      for (let component = 3; component < 6; component++) for (const sign of [1, -1]) {
        const candidate = rotatedAroundLocalPoint(original, component, sign * step, localPoint, options);
        if (!candidate) continue;
        const trial = new Map(transforms);
        trial.set(occurrence.id, candidate);
        const candidateObjective = objective(evaluateRows(mates, trial, characteristicLength));
        if (candidateObjective < bestObjective) {
          best = trial;
          bestObjective = candidateObjective;
        }
      }
    }
  }
  return best;
}

function scaledValue(rawRow, characteristicLength) {
  return rawRow.value * (rawRow.unit === 'angular' ? characteristicLength : 1);
}

function evaluateRows(mates, transforms, characteristicLength) {
  const rows = [];
  for (const mate of mates) {
    const evaluated = mateRows(mate, transforms);
    evaluated.forEach((entry, rowIndex) => rows.push({
      mateId: mate.id,
      rowIndex,
      semantic: entry.semantic,
      unit: entry.unit,
      rawResidual: entry.value,
      residual: scaledValue(entry, characteristicLength),
      values: new Map(),
    }));
  }
  return rows;
}

function buildLinearization(mates, transforms, variableOffsets, characteristicLength, options) {
  const rows = evaluateRows(mates, transforms, characteristicLength);
  let rowOffset = 0;
  for (const mate of mates) {
    const baseRows = rows.slice(rowOffset, rowOffset + mateRows(mate, transforms).length);
    rowOffset += baseRows.length;
    const involved = [...new Set(mate.frames.map((frame) => frame.occurrenceId))]
      .filter((occurrenceId) => variableOffsets.has(occurrenceId));
    for (const occurrenceId of involved) {
      const original = transforms.get(occurrenceId);
      const columnOffset = variableOffsets.get(occurrenceId);
      for (let component = 0; component < 6; component++) {
        const epsilon = component < 3 ? options.translationDerivativeStep : options.rotationDerivativeStep;
        transforms.set(occurrenceId, perturbedTransform(original, component, epsilon));
        let plus;
        try {
          plus = mateRows(mate, transforms);
        } finally {
          transforms.set(occurrenceId, original);
        }
        transforms.set(occurrenceId, perturbedTransform(original, component, -epsilon));
        let minus;
        try {
          minus = mateRows(mate, transforms);
        } finally {
          transforms.set(occurrenceId, original);
        }
        if (plus.length !== baseRows.length || minus.length !== baseRows.length) throw new Error('Mate "' + mate.id + '" changed equation count while linearizing.');
        for (let index = 0; index < baseRows.length; index++) {
          const derivative = (scaledValue(plus[index], characteristicLength) - scaledValue(minus[index], characteristicLength)) / (2 * epsilon);
          if (Math.abs(derivative) > options.derivativePruneTolerance) baseRows[index].values.set(columnOffset + component, derivative);
        }
      }
    }
  }
  return rows;
}

function objective(rows) {
  return rows.reduce((total, entry) => total + entry.residual * entry.residual, 0) / 2;
}

function maxResidual(rows) {
  return rows.reduce((maximum, entry) => Math.max(maximum, Math.abs(entry.residual)), 0);
}

function dotVectors(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index++) total += left[index] * right[index];
  return total;
}

function normalProduct(rows, vector, damping) {
  const result = new Float64Array(vector.length);
  for (const entry of rows) {
    let projected = 0;
    for (const [column, value] of entry.values) projected += value * vector[column];
    for (const [column, value] of entry.values) result[column] += value * projected;
  }
  for (let index = 0; index < result.length; index++) result[index] += damping * vector[index];
  return result;
}

function solveNormalEquations(rows, variableCount, damping, options) {
  const right = new Float64Array(variableCount);
  const diagonal = new Float64Array(variableCount).fill(damping);
  for (const entry of rows) for (const [column, value] of entry.values) {
    right[column] -= value * entry.residual;
    diagonal[column] += value * value;
  }
  const rightNorm = Math.sqrt(dotVectors(right, right));
  if (!(rightNorm > options.linearSolveTolerance)) return new Float64Array(variableCount);
  const solution = new Float64Array(variableCount);
  let residual = right.slice();
  let preconditioned = Float64Array.from(residual, (value, index) => value / Math.max(diagonal[index], EPSILON));
  let direction = preconditioned.slice();
  let rz = dotVectors(residual, preconditioned);
  const target = options.linearSolveTolerance * Math.max(1, rightNorm);
  for (let iteration = 0; iteration < options.maxLinearIterations; iteration++) {
    const product = normalProduct(rows, direction, damping);
    const denominator = dotVectors(direction, product);
    if (!(Math.abs(denominator) > EPSILON)) break;
    const alpha = rz / denominator;
    for (let index = 0; index < variableCount; index++) {
      solution[index] += alpha * direction[index];
      residual[index] -= alpha * product[index];
    }
    const residualNorm = Math.sqrt(dotVectors(residual, residual));
    if (residualNorm <= target) break;
    preconditioned = Float64Array.from(residual, (value, index) => value / Math.max(diagonal[index], EPSILON));
    const nextRz = dotVectors(residual, preconditioned);
    const beta = nextRz / Math.max(Math.abs(rz), EPSILON);
    for (let index = 0; index < variableCount; index++) direction[index] = preconditioned[index] + beta * direction[index];
    rz = nextRz;
  }
  return solution;
}

function extendSparseEchelon(echelon, inputRows, columnFilter, options, includeResidual = false) {
  const { basis, pivotColumns } = echelon;
  const augmentedColumn = options.variableCount;
  for (const source of inputRows) {
    const vector = new Map();
    for (const [column, value] of source.values) {
      if ((!columnFilter || columnFilter.has(column)) && Math.abs(value) > options.rankTolerance) vector.set(column, value);
    }
    if (includeResidual && Math.abs(source.residual) > options.rankTolerance) vector.set(augmentedColumn, -source.residual);
    const norm = Math.max(0, ...[...vector.values()].map(Math.abs));
    if (!(norm > options.rankTolerance)) continue;
    for (const [column, value] of [...vector]) vector.set(column, value / norm);
    for (const pivot of pivotColumns) {
      const factor = vector.get(pivot) || 0;
      if (Math.abs(factor) <= options.rankTolerance) continue;
      for (const [column, value] of basis.get(pivot)) {
        const next = (vector.get(column) || 0) - factor * value;
        if (Math.abs(next) <= options.rankTolerance) vector.delete(column);
        else vector.set(column, next);
      }
    }
    const candidates = [...vector.keys()].filter((column) => Math.abs(vector.get(column)) > options.rankTolerance).sort((left, right) => left - right);
    if (!candidates.length) continue;
    const pivot = candidates[0];
    const pivotValue = vector.get(pivot);
    for (const [column, value] of [...vector]) {
      const normalized = value / pivotValue;
      if (Math.abs(normalized) <= options.rankTolerance) vector.delete(column);
      else vector.set(column, normalized);
    }
    basis.set(pivot, vector);
    pivotColumns.push(pivot);
    pivotColumns.sort((left, right) => left - right);
  }
  echelon.rank = basis.size;
  return echelon;
}

function sparseEchelon(inputRows, columnFilter, options, includeResidual = false) {
  return extendSparseEchelon({ rank: 0, basis: new Map(), pivotColumns: [] }, inputRows, columnFilter, options, includeResidual);
}

function rankOf(rows, columns, options, includeResidual = false) {
  return sparseEchelon(rows, columns, options, includeResidual).rank;
}

function mateResidualSummary(rows, tolerance) {
  const grouped = new Map();
  for (const entry of rows) {
    if (!grouped.has(entry.mateId)) grouped.set(entry.mateId, []);
    grouped.get(entry.mateId).push(entry);
  }
  return [...grouped].map(([mateId, entries]) => ({
    mateId,
    maxScaledResidual: maxResidual(entries),
    maxLinearResidual: entries.filter((entry) => entry.unit === 'linear').reduce((maximum, entry) => Math.max(maximum, Math.abs(entry.rawResidual)), 0),
    maxAngularResidual: entries.filter((entry) => entry.unit === 'angular').reduce((maximum, entry) => Math.max(maximum, Math.abs(entry.rawResidual)), 0),
    satisfied: maxResidual(entries) <= tolerance,
    equations: entries.map((entry) => ({ semantic: entry.semantic, unit: entry.unit, residual: entry.rawResidual })),
  }));
}

function graphComponents(occurrenceIds, mates, fixedIds) {
  const neighbors = new Map(occurrenceIds.map((id) => [id, new Set()]));
  for (const mate of mates) {
    const ids = [...new Set(mate.frames.map((frame) => frame.occurrenceId))];
    for (const left of ids) for (const right of ids) if (left !== right) neighbors.get(left).add(right);
  }
  const components = [];
  const visited = new Set();
  for (const start of occurrenceIds) {
    if (visited.has(start)) continue;
    const stack = [start];
    const ids = [];
    visited.add(start);
    while (stack.length) {
      const current = stack.pop();
      ids.push(current);
      for (const next of neighbors.get(current)) if (!visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
    const idSet = new Set(ids);
    components.push({
      occurrenceIds: ids.sort(),
      mateIds: mates.filter((mate) => mate.frames.some((frame) => idSet.has(frame.occurrenceId))).map((mate) => mate.id).sort(),
      grounded: ids.some((id) => fixedIds.has(id)),
    });
  }
  return components;
}

function conflictSets(rows, components, residualByMate, options) {
  const result = [];
  const rowsByMate = new Map();
  for (const entry of rows) {
    if (!rowsByMate.has(entry.mateId)) rowsByMate.set(entry.mateId, []);
    rowsByMate.get(entry.mateId).push(entry);
  }
  const inconsistent = (mateIds) => {
    const selected = mateIds.flatMap((id) => rowsByMate.get(id) || []);
    if (!selected.length || maxResidual(selected) <= options.residualTolerance) return false;
    return rankOf(selected, null, options, true) > rankOf(selected, null, options, false);
  };
  for (const component of components) {
    if (!component.mateIds.some((id) => residualByMate.get(id)?.satisfied === false)) continue;
    let candidate = [...component.mateIds];
    if (!inconsistent(candidate)) continue;
    for (const mateId of [...candidate]) {
      const trial = candidate.filter((id) => id !== mateId);
      if (trial.length && inconsistent(trial)) candidate = trial;
    }
    result.push({
      code: 'ASSEMBLY_CONSTRAINT_CONFLICT',
      mateIds: candidate,
      message: 'These mates are jointly inconsistent at the solved linearization.',
    });
  }
  return result;
}

function canonicalOptions(input, variableCount) {
  return {
    characteristicLength: Number.isFinite(input.characteristicLength) && input.characteristicLength > 0 ? input.characteristicLength : 10,
    residualTolerance: Number.isFinite(input.residualTolerance) && input.residualTolerance > 0 ? input.residualTolerance : 1e-6,
    translationDerivativeStep: 1e-6,
    rotationDerivativeStep: 1e-6,
    derivativePruneTolerance: 1e-10,
    rankTolerance: 1e-8,
    linearSolveTolerance: 1e-10,
    maxLinearIterations: Math.max(50, Math.min(2000, variableCount * 3)),
    maxIterations: Number.isInteger(input.maxIterations) && input.maxIterations > 0 ? input.maxIterations : 60,
    maxTranslationStep: Number.isFinite(input.maxTranslationStep) && input.maxTranslationStep > 0 ? input.maxTranslationStep : 100,
    maxRotationStepRadians: Number.isFinite(input.maxRotationStepRadians) && input.maxRotationStepRadians > 0 ? input.maxRotationStepRadians : Math.PI / 6,
    stationaryRotationProbeRadians: 1e-3,
    maxExactOccurrenceMobility: Number.isInteger(input.maxExactOccurrenceMobility) && input.maxExactOccurrenceMobility > 0
      ? input.maxExactOccurrenceMobility
      : 200,
    initialDamping: 1e-6,
    stepTolerance: 1e-10,
    objectiveTolerance: 1e-16,
    variableCount,
  };
}

function normalizedAdvanced(candidate, id) {
  if (!candidate.advanced || typeof candidate.advanced !== 'object' || Array.isArray(candidate.advanced)) {
    throw new Error('Mate "' + id + '" requires advanced values.');
  }
  if (candidate.kind === 'linear-coupler') {
    const ratio = candidate.advanced.ratio;
    const offset = candidate.advanced.offset;
    if (!Number.isFinite(ratio) || ratio === 0) throw new Error('Mate "' + id + '" ratio must be finite and nonzero.');
    if (!Number.isFinite(offset)) throw new Error('Mate "' + id + '" offset must be finite.');
    return { ratio, offset };
  }
  if (candidate.kind === 'gear') {
    const ratio = candidate.advanced.ratio;
    const offset = candidate.advanced.offset;
    if (!Number.isFinite(ratio) || !(ratio > 0)) throw new Error('Mate "' + id + '" gear ratio must be finite and positive.');
    if (!Number.isFinite(offset)) throw new Error('Mate "' + id + '" gear offset must be finite.');
    return { ratio, offset };
  }
  if (candidate.kind === 'hinge') {
    const minimum = candidate.advanced.minimum;
    const maximum = candidate.advanced.maximum;
    if (minimum == null && maximum == null) return { minimum: null, maximum: null };
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
      throw new Error('Mate "' + id + '" hinge limits must be authored together as finite angles.');
    }
    if (minimum > maximum) throw new Error('Mate "' + id + '" hinge limits must be ordered minimum through maximum.');
    if (minimum < -180 || maximum > 180) {
      throw new Error('Mate "' + id + '" hinge limits must stay within -180 through 180 degrees.');
    }
    return { minimum, maximum };
  }
  const minimum = candidate.advanced.minimum;
  const maximum = candidate.advanced.maximum;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) throw new Error('Mate "' + id + '" limits must be finite.');
  if (minimum > maximum) throw new Error('Mate "' + id + '" limits must be ordered minimum through maximum.');
  if (candidate.kind === 'limit-angle' && (minimum < 0 || maximum > 180)) {
    throw new Error('Mate "' + id + '" angle limits must stay within 0 through 180 degrees.');
  }
  return { minimum, maximum };
}

function normalizedPath(candidate, id) {
  if (!candidate.path || typeof candidate.path !== 'object' || !Array.isArray(candidate.path.segments) || !candidate.path.segments.length) {
    throw new Error('Mate "' + id + '" requires at least one exact path segment.');
  }
  const segments = candidate.path.segments.map((segment, segmentIndex) => {
    const label = 'mate "' + id + '" path segment ' + segmentIndex;
    if (!segment || typeof segment !== 'object' || (segment.kind !== 'line' && segment.kind !== 'cubic-bezier')) {
      throw new Error(label + ' must be an exact line or cubic-bezier span.');
    }
    const expectedPoints = segment.kind === 'line' ? 2 : 4;
    if (!Array.isArray(segment.points) || segment.points.length !== expectedPoints) {
      throw new Error(label + ' must contain ' + expectedPoints + ' local points.');
    }
    const points = segment.points.map((point, pointIndex) => finiteVector(point, label + ' point ' + pointIndex));
    if (segment.kind === 'line' && !(magnitude(subtract(points[1], points[0])) > EPSILON)) {
      throw new Error(label + ' has zero length.');
    }
    if (segment.kind === 'cubic-bezier' && !points.slice(1).some((point) => magnitude(subtract(point, points[0])) > EPSILON)) {
      throw new Error(label + ' has zero length.');
    }
    return { kind: segment.kind, points };
  });
  return { segments };
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Assembly constraint input is required.');
  if (!Array.isArray(input.occurrences) || !Array.isArray(input.mates)) throw new Error('Assembly constraint input requires occurrence and mate arrays.');
  const occurrenceIds = new Set();
  const occurrences = input.occurrences.map((occurrence, index) => {
    const id = String(occurrence?.id || '');
    if (!id || occurrenceIds.has(id)) throw new Error('Occurrence ' + index + ' has a missing or duplicate id.');
    occurrenceIds.add(id);
    return { id, transform: finiteTransform(occurrence.transform || occurrence.baseTransform, 'occurrence "' + id + '" transform'), fixed: occurrence.fixed === true };
  });
  const mateIds = new Set();
  const fixedIds = new Set(occurrences.filter((entry) => entry.fixed).map((entry) => entry.id));
  const mates = [];
  for (const [index, candidate] of input.mates.entries()) {
    const id = String(candidate?.id || '');
    if (!id || mateIds.has(id)) throw new Error('Mate ' + index + ' has a missing or duplicate id.');
    mateIds.add(id);
    if (candidate.suppressed === true) continue;
    const occurrenceSelection = Array.isArray(candidate.occurrenceIds) ? candidate.occurrenceIds.map(String) : [];
    if (candidate.kind === 'fixed') {
      if (occurrenceSelection.length !== 1 || !occurrenceIds.has(occurrenceSelection[0])) throw new Error('Fixed mate "' + id + '" must select one existing occurrence.');
      fixedIds.add(occurrenceSelection[0]);
      continue;
    }
    if (!CONVENTIONAL_MATE_KINDS.has(candidate.kind)
      && !ADVANCED_MATE_KINDS.has(candidate.kind)
      && !MECHANICAL_MATE_KINDS.has(candidate.kind)) {
      throw new Error('Unsupported simultaneous assembly mate kind "' + candidate.kind + '".');
    }
    const frameCount = candidate.kind === 'symmetry' ? 3 : 2;
    if (occurrenceSelection.length !== frameCount
      || new Set(occurrenceSelection).size !== frameCount
      || occurrenceSelection.some((entry) => !occurrenceIds.has(entry))) {
      const countLabel = frameCount === 2 ? 'two' : 'three';
      throw new Error('Mate "' + id + '" must select ' + countLabel + ' different existing occurrences.');
    }
    const suppliedFrames = candidate.frames || candidate.localFrames;
    if (!Array.isArray(suppliedFrames) || suppliedFrames.length !== frameCount) {
      const countLabel = frameCount === 2 ? 'two' : 'three';
      throw new Error('Mate "' + id + '" requires ' + countLabel + ' resolved local frames.');
    }
    const strictGeometry = ADVANCED_MATE_KINDS.has(candidate.kind) || MECHANICAL_MATE_KINDS.has(candidate.kind);
    const frames = suppliedFrames.map((frame, frameIndex) => normalizedFrame(
      frame,
      occurrenceSelection[frameIndex],
      'mate "' + id + '" frame ' + frameIndex,
      strictGeometry,
    ));
    if (candidate.kind === 'width' && frames.some((frame) => frame.geometryKind !== 'plane')) {
      throw new Error('Mate "' + id + '" width center frames must be planar.');
    }
    if (candidate.kind === 'symmetry' && frames[2].geometryKind !== 'plane') {
      throw new Error('Mate "' + id + '" symmetry plane frame must be planar.');
    }
    const value = candidate.value == null ? 0 : Number(candidate.value);
    if (!Number.isFinite(value)) throw new Error('Mate "' + id + '" value must be finite.');
    const normalized = { id, kind: candidate.kind, frames, value, flip: candidate.flip === true || candidate.extensions?.flip === true };
    if (candidate.kind === 'path') normalized.path = normalizedPath(candidate, id);
    if (candidate.kind === 'linear-coupler'
      || candidate.kind === 'limit-distance'
      || candidate.kind === 'limit-angle'
      || MECHANICAL_MATE_KINDS.has(candidate.kind)) {
      normalized.advanced = normalizedAdvanced(candidate, id);
    }
    mates.push(normalized);
  }
  return { occurrences, mates, fixedIds };
}

export function solveAssemblyConstraintSystem(input, inputOptions = {}) {
  const { occurrences, mates, fixedIds } = normalizeInput(input);
  const inputTransforms = new Map(occurrences.map((entry) => [entry.id, [...entry.transform]]));
  const transforms = new Map(occurrences.map((entry) => [entry.id, [...entry.transform]]));
  const movable = occurrences.filter((entry) => !fixedIds.has(entry.id));
  const variableOffsets = new Map(movable.map((entry, index) => [entry.id, index * 6]));
  const variableCount = movable.length * 6;
  const options = canonicalOptions(inputOptions, variableCount);
  let damping = options.initialDamping;
  let iterations = 0;
  let stationary = variableCount === 0 || mates.length === 0;
  let terminationReason = stationary ? 'no-active-equations' : null;

  while (!stationary && iterations < options.maxIterations) {
    const linearization = buildLinearization(mates, transforms, variableOffsets, options.characteristicLength, options);
    if (maxResidual(linearization) <= options.residualTolerance) {
      stationary = true;
      terminationReason = 'residual-tolerance';
      break;
    }
    const before = objective(linearization);
    let accepted = false;
    let acceptedStep = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const delta = solveNormalEquations(linearization, variableCount, damping, options);
      acceptedStep = Math.sqrt(dotVectors(delta, delta));
      if (!(acceptedStep > options.stepTolerance)) break;
      const trial = new Map(transforms);
      for (const occurrence of movable) {
        const offset = variableOffsets.get(occurrence.id);
        trial.set(occurrence.id, applyDelta(transforms.get(occurrence.id), Array.from(delta.slice(offset, offset + 6)), options));
      }
      const afterRows = evaluateRows(mates, trial, options.characteristicLength);
      const after = objective(afterRows);
      if (after < before) {
        for (const [id, transform] of trial) transforms.set(id, transform);
        damping = Math.max(1e-14, damping / 3);
        accepted = true;
        if (before - after <= options.objectiveTolerance * Math.max(1, before)) {
          stationary = true;
          terminationReason = 'objective-stagnation';
        }
        break;
      }
      damping = Math.min(1e14, damping * 10);
    }
    iterations++;
    if (!accepted || acceptedStep <= options.stepTolerance) {
      const escape = stationaryRotationEscape(
        mates,
        transforms,
        movable,
        options.characteristicLength,
        options,
        before,
      );
      if (escape) {
        for (const [id, transform] of escape) transforms.set(id, transform);
        damping = options.initialDamping;
        continue;
      }
      stationary = true;
      terminationReason = acceptedStep <= options.stepTolerance ? 'step-tolerance' : 'step-rejected';
    }
  }

  if (!stationary && iterations >= options.maxIterations) terminationReason = 'iteration-limit';

  const finalRows = buildLinearization(mates, transforms, variableOffsets, options.characteristicLength, options);
  const finalMaxResidual = maxResidual(finalRows);
  const residuals = mateResidualSummary(finalRows, options.residualTolerance);
  const residualByMate = new Map(residuals.map((entry) => [entry.mateId, entry]));
  const components = graphComponents(occurrences.map((entry) => entry.id), mates, fixedIds);
  let globalRank = 0;
  const degreesOfFreedom = new Map();
  for (const occurrence of occurrences) if (fixedIds.has(occurrence.id)) degreesOfFreedom.set(occurrence.id, 0);
  for (const component of components) {
    const componentMateIds = new Set(component.mateIds);
    const componentRows = finalRows.filter((entry) => componentMateIds.has(entry.mateId));
    const componentColumns = new Set(component.occurrenceIds.flatMap((id) => {
      const offset = variableOffsets.get(id);
      return offset == null ? [] : [0, 1, 2, 3, 4, 5].map((axis) => offset + axis);
    }));
    component.rank = rankOf(componentRows, componentColumns, options, false);
    component.variableCount = componentColumns.size;
    component.degreesOfFreedom = Math.max(0, component.variableCount - component.rank);
    component.state = component.degreesOfFreedom === 0 ? 'fully-constrained' : 'under-constrained';
    globalRank += component.rank;
    component.occurrenceMobilityExact = component.occurrenceIds.length <= options.maxExactOccurrenceMobility;
    for (const occurrenceId of component.occurrenceIds) {
      if (fixedIds.has(occurrenceId)) continue;
      if (!component.occurrenceMobilityExact) {
        // The component rank/nullity above is still exact. Recomputing a
        // rank-revealing elimination with each six-column occurrence block
        // removed is intentionally bounded; returning null is safer than a
        // guessed per-occurrence DOF count on very large graphs.
        degreesOfFreedom.set(occurrenceId, null);
        continue;
      }
      const offset = variableOffsets.get(occurrenceId);
      const occurrenceColumns = new Set([0, 1, 2, 3, 4, 5].map((axis) => offset + axis));
      const withoutOccurrence = new Set([...componentColumns].filter((column) => !occurrenceColumns.has(column)));
      const complementRank = rankOf(componentRows, withoutOccurrence, options, false);
      const mobility = Math.max(0, Math.min(6, 6 - component.rank + complementRank));
      degreesOfFreedom.set(occurrenceId, mobility);
    }
  }

  const redundantMateIds = [];
  const acceptedEchelon = { rank: 0, basis: new Map(), pivotColumns: [] };
  for (const mate of [...mates].sort((left, right) => left.id.localeCompare(right.id))) {
    const mateRowsForRank = finalRows.filter((entry) => entry.mateId === mate.id);
    const previousRank = acceptedEchelon.rank;
    extendSparseEchelon(acceptedEchelon, mateRowsForRank, null, options, false);
    if (acceptedEchelon.rank === previousRank && residualByMate.get(mate.id)?.satisfied) redundantMateIds.push(mate.id);
  }
  const conflicts = conflictSets(finalRows, components, residualByMate, options);
  const nullity = Math.max(0, variableCount - globalRank);
  const state = conflicts.length ? 'over-constrained' : nullity === 0 ? 'fully-constrained' : 'under-constrained';
  const satisfied = finalMaxResidual <= options.residualTolerance;
  const convergenceFailed = !satisfied && conflicts.length === 0;
  // A capped or conflicting nonlinear iterate is diagnostic evidence, not a
  // valid assembly placement. Reject it at the solver boundary so callers
  // receive either the original placement or their own last-valid solution.
  const acceptedTransforms = satisfied ? transforms : inputTransforms;
  return {
    transforms: acceptedTransforms,
    state,
    stationary,
    satisfied,
    converged: satisfied,
    solutionAccepted: satisfied,
    terminationReason: satisfied ? 'residual-tolerance' : terminationReason || 'unsatisfied',
    maxScaledResidual: finalMaxResidual,
    iterations,
    rank: globalRank,
    variableCount,
    degreesOfFreedom,
    components,
    residuals,
    redundantMateIds,
    conflicts,
    diagnostics: [
      ...components.filter((component) => component.degreesOfFreedom > 0).map((component) => ({
        code: 'ASSEMBLY_UNDER_CONSTRAINED_COMPONENT',
        occurrenceIds: component.occurrenceIds,
        degreesOfFreedom: component.degreesOfFreedom,
        message: 'Assembly component retains ' + component.degreesOfFreedom + ' degree' + (component.degreesOfFreedom === 1 ? '' : 's') + ' of freedom.',
      })),
      ...components.filter((component) => !component.occurrenceMobilityExact).map((component) => ({
        code: 'ASSEMBLY_OCCURRENCE_MOBILITY_DEFERRED',
        occurrenceIds: component.occurrenceIds,
        componentDegreesOfFreedom: component.degreesOfFreedom,
        message: 'The component rank and total degrees of freedom are exact; per-occurrence mobility was not expanded for this large graph.',
      })),
      ...conflicts,
      ...(convergenceFailed ? [{
        code: 'ASSEMBLY_CONVERGENCE_FAILED',
        reason: terminationReason || 'unsatisfied',
        iterations,
        iterationLimit: options.maxIterations,
        maxScaledResidual: finalMaxResidual,
        solutionAccepted: false,
        message: 'The assembly solver did not converge; the capped candidate placement was rejected.',
      }] : []),
    ],
  };
}
