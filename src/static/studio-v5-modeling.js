// Shared schema-5 datum and transform math. This module is deliberately free
// of DOM and OpenCascade dependencies so document commands, the kernel worker,
// headless checks, and the visible Studio use exactly the same resolved frames.

import { parseStudioExpression } from './studio-expression.js';

const EPSILON = 1e-9;
const ANTIPARALLEL_FRAME_EPSILON = 1e-8;

const add = (a, b) => a.map((value, index) => value + b[index]);
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const multiply = (vector, scale) => vector.map((value) => value * scale);
const dot = (a, b) => a.reduce((total, value, index) => total + value * b[index], 0);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (vector) => Math.hypot(...vector);

function finiteVector(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw new Error(name + ' must contain three finite numbers.');
  }
  return [...value];
}

function normalize(vector, name = 'Direction') {
  const magnitude = length(vector);
  if (magnitude <= EPSILON) throw new Error(name + ' cannot be zero length.');
  return multiply(vector, 1 / magnitude);
}

function orthogonalX(normal, preferred = [1, 0, 0]) {
  const projected = subtract(preferred, multiply(normal, dot(preferred, normal)));
  if (length(projected) > EPSILON) return normalize(projected);
  const fallback = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  return normalize(subtract(fallback, multiply(normal, dot(fallback, normal))));
}

function planeFrame(origin, normal, xDirection) {
  const z = normalize(finiteVector(normal, 'Plane normal'), 'Plane normal');
  const x = orthogonalX(z, finiteVector(xDirection || [1, 0, 0], 'Plane X direction'));
  return { kind: 'plane', origin: finiteVector(origin, 'Plane origin'), normal: z, xDirection: x, yDirection: normalize(cross(z, x)) };
}

function transportPlaneXDirection(referenceNormal, referenceXDirection, currentNormal) {
  const from = normalize(finiteVector(referenceNormal, 'Reference plane normal'), 'Reference plane normal');
  const to = normalize(finiteVector(currentNormal, 'Current plane normal'), 'Current plane normal');
  const authoredX = finiteVector(referenceXDirection, 'Reference plane X direction');
  const projectedX = subtract(authoredX, multiply(from, dot(authoredX, from)));
  if (length(projectedX) <= EPSILON) {
    throw new Error('Reference plane X direction cannot be parallel to its normal.');
  }
  const initialX = normalize(projectedX, 'Reference plane X direction');
  const cosine = Math.max(-1, Math.min(1, dot(from, to)));
  if (cosine <= -1 + ANTIPARALLEL_FRAME_EPSILON) {
    throw new Error('Curve-normal reference frame cannot resolve a 180-degree path reversal.');
  }
  const rotation = cross(from, to);
  const sine = length(rotation);
  if (sine <= EPSILON) return orthogonalX(to, initialX);
  const axis = multiply(rotation, 1 / sine);
  const angle = Math.atan2(sine, cosine) * 180 / Math.PI;
  return orthogonalX(to, rotateVector(initialX, axis, angle));
}

function axisFrame(origin, direction) {
  return { kind: 'axis', origin: finiteVector(origin, 'Axis origin'), direction: normalize(finiteVector(direction, 'Axis direction'), 'Axis direction') };
}

function pointFrame(point) {
  return { kind: 'point', point: finiteVector(point, 'Point') };
}

function coordinateFrame(origin, xDirection, zDirection) {
  const plane = planeFrame(origin, zDirection, xDirection);
  return { kind: 'coordinate-system', origin: plane.origin, xDirection: plane.xDirection, yDirection: plane.yDirection, zDirection: plane.normal };
}

function rotateVector(vector, axis, angleDegrees) {
  const direction = normalize(axis, 'Rotation axis');
  const angle = angleDegrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return add(add(multiply(vector, cosine), multiply(cross(direction, vector), sine)), multiply(direction, dot(direction, vector) * (1 - cosine)));
}

export function evaluateStudioV5Expression(value, parameters = new Map()) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Expression must be finite.');
    return value;
  }
  // Delegate to the shared document-boundary grammar so functions, unit
  // literals, and comparisons behave identically on every evaluation path.
  const lookup = typeof parameters?.get === 'function' && typeof parameters?.has === 'function'
    ? parameters
    : { has: (name) => Object.prototype.hasOwnProperty.call(parameters, name), get: (name) => parameters[name] };
  return parseStudioExpression(String(value ?? '')).evaluate((name) => {
    if (!lookup.has(name)) throw new Error('Unknown parameter "' + name + '".');
    return lookup.get(name);
  });
}

export function studioV5ParameterValues(project, part) {
  const unresolved = new Map([...(project.parameters || []), ...(part.parameters || [])].map((entry) => [entry.name, entry.value]));
  const resolved = new Map();
  const active = new Set();
  function resolve(name) {
    if (resolved.has(name)) return resolved.get(name);
    if (!unresolved.has(name)) throw new Error('Unknown parameter "' + name + '".');
    if (active.has(name)) throw new Error('Cyclic parameter "' + name + '".');
    active.add(name);
    const proxy = {
      has: (key) => unresolved.has(key),
      get: (key) => resolve(key),
    };
    const value = evaluateStudioV5Expression(unresolved.get(name), proxy);
    active.delete(name);
    resolved.set(name, value);
    return value;
  }
  for (const name of unresolved.keys()) resolve(name);
  return resolved;
}

function expressionVector(values, parameters, name) {
  if (!Array.isArray(values) || values.length !== 3) throw new Error(name + ' must contain three values.');
  return values.map((value) => evaluateStudioV5Expression(value, parameters));
}

export function studioV5OpenSplineBezierSegments(points) {
  if (!Array.isArray(points) || points.length < 2) throw new Error('Spline path requires at least two points.');
  return points.slice(0, -1).map((point, index) => {
    const previous = index === 0 ? point : points[index - 1];
    const next = points[index + 1];
    const after = index + 2 < points.length ? points[index + 2] : next;
    return {
      kind: 'bezier',
      points: [
        [...point],
        add(point, multiply(subtract(next, previous), 1 / 6)),
        subtract(next, multiply(subtract(after, point), 1 / 6)),
        [...next],
      ],
    };
  });
}

function lineSegments(points) {
  return points.slice(1).map((point, index) => ({ kind: 'line', points: [[...points[index]], [...point]] }));
}

function evaluateBezier(points, parameter) {
  const inverse = 1 - parameter;
  return points[0].map((_, index) =>
    inverse ** 3 * points[0][index]
      + 3 * inverse ** 2 * parameter * points[1][index]
      + 3 * inverse * parameter ** 2 * points[2][index]
      + parameter ** 3 * points[3][index]);
}

function evaluateBezierTangent(points, parameter) {
  const inverse = 1 - parameter;
  return normalize(points[0].map((_, index) =>
    3 * inverse ** 2 * (points[1][index] - points[0][index])
      + 6 * inverse * parameter * (points[2][index] - points[1][index])
      + 3 * parameter ** 2 * (points[3][index] - points[2][index])), 'Path tangent');
}

function evaluateSegments(segments, parameter) {
  if (parameter === 1) return [...segments.at(-1).points.at(-1)];
  const scaled = parameter * segments.length;
  const index = Math.min(segments.length - 1, Math.floor(scaled));
  const local = scaled - index;
  const segment = segments[index];
  return segment.kind === 'line'
    ? add(segment.points[0], multiply(subtract(segment.points[1], segment.points[0]), local))
    : evaluateBezier(segment.points, local);
}

function evaluateSegmentsTangent(segments, parameter) {
  const scaled = parameter === 1 ? segments.length : parameter * segments.length;
  const index = Math.min(segments.length - 1, Math.floor(scaled));
  const local = parameter === 1 ? 1 : scaled - index;
  const segment = segments[index];
  return segment.kind === 'line'
    ? normalize(subtract(segment.points[1], segment.points[0]), 'Path tangent')
    : evaluateBezierTangent(segment.points, local);
}

function sampleSegments(segments, samplesPerBezier = 12) {
  const points = [];
  for (const segment of segments) {
    const samples = segment.kind === 'line' ? 1 : samplesPerBezier;
    for (let index = 0; index < samples; index++) points.push(
      segment.kind === 'line'
        ? [...segment.points[0]]
        : evaluateBezier(segment.points, index / samples),
    );
  }
  points.push([...segments.at(-1).points.at(-1)]);
  return points;
}

function evaluatePolylineAtArcFraction(points, parameter) {
  const segmentLengths = points.slice(1).map((point, index) => length(subtract(point, points[index])));
  if (segmentLengths.some((value) => value <= EPSILON)) throw new Error('Point-on-curve path contains a zero-length segment.');
  const totalLength = segmentLengths.reduce((total, value) => total + value, 0);
  if (parameter === 0) return [...points[0]];
  if (parameter === 1) return [...points.at(-1)];
  const target = parameter * totalLength;
  let traversed = 0;
  for (let index = 0; index < segmentLengths.length; index++) {
    const next = traversed + segmentLengths[index];
    if (target <= next || index === segmentLengths.length - 1) {
      const local = (target - traversed) / segmentLengths[index];
      return add(points[index], multiply(subtract(points[index + 1], points[index]), local));
    }
    traversed = next;
  }
  return [...points.at(-1)];
}

function evaluatePolylineTangentAtArcFraction(points, parameter) {
  const segmentLengths = points.slice(1).map((point, index) => length(subtract(point, points[index])));
  if (segmentLengths.some((value) => value <= EPSILON)) throw new Error('Path tangent contains a zero-length segment.');
  if (parameter === 1) return normalize(subtract(points.at(-1), points.at(-2)), 'Path tangent');
  const target = parameter * segmentLengths.reduce((total, value) => total + value, 0);
  let traversed = 0;
  for (let index = 0; index < segmentLengths.length; index++) {
    if (target < traversed + segmentLengths[index] || index === segmentLengths.length - 1) {
      return normalize(subtract(points[index + 1], points[index]), 'Path tangent');
    }
    traversed += segmentLengths[index];
  }
  return normalize(subtract(points.at(-1), points.at(-2)), 'Path tangent');
}

function createStudioV5PathPreviewResolver(part, parameters, resolveDatum) {
  const sketches = new Map((part.sketches || []).map((sketch) => [sketch.id, sketch]));
  const resolved = new Map();
  const active = new Set();

  function resolvePath(sketchId) {
    if (resolved.has(sketchId)) return resolved.get(sketchId);
    if (active.has(sketchId)) throw new Error('Cyclic reference-curve dependency at "' + sketchId + '".');
    const sketch = sketches.get(sketchId);
    if (!sketch || sketch.extensions?.studioRole !== 'path') throw new Error('Reference curve must resolve to a path sketch.');
    active.add(sketchId);
    try {
      const reference = sketch.extensions?.referenceCurve;
      let result;
      if (!reference) {
        const entity = sketch.entities?.[0];
        if (entity?.kind !== 'polyline' && entity?.kind !== 'spline') throw new Error('Path sketch must contain one polyline or spline.');
        const authoredPoints = (entity.points || []).map((point, index) => expressionVector(point, parameters, 'Path point ' + (index + 1)));
        const segments = entity.kind === 'polyline' ? lineSegments(authoredPoints) : studioV5OpenSplineBezierSegments(authoredPoints);
        result = {
          points: entity.kind === 'polyline' ? authoredPoints : sampleSegments(segments),
          referenceKind: null,
          exactPointEvaluation: true,
          exactTangentEvaluation: true,
          exactPolylineEvaluation: entity.kind === 'polyline',
          projectionSegments: segments,
          evaluate: entity.kind === 'polyline'
            ? (parameter) => evaluatePolylineAtArcFraction(authoredPoints, parameter)
            : (parameter) => evaluateSegments(segments, parameter),
          tangent: entity.kind === 'polyline'
            ? (parameter) => evaluatePolylineTangentAtArcFraction(authoredPoints, parameter)
            : (parameter) => evaluateSegmentsTangent(segments, parameter),
        };
      } else if (reference.kind === 'projected') {
        const source = resolvePath(reference.sourceSketchId);
        if (!source.projectionSegments) throw new Error('Projected curves require a source representable by exact line or spline spans.');
        const plane = resolveDatum(reference.planeDatumId);
        if (plane?.kind !== 'plane') throw new Error('Projected curve requires a plane datum.');
        const project = (point) => subtract(point, multiply(plane.normal, dot(subtract(point, plane.origin), plane.normal)));
        const projectionSegments = source.projectionSegments.map((segment) => ({
          kind: segment.kind,
          points: segment.points.map(project),
        }));
        result = {
          points: sampleSegments(projectionSegments),
          referenceKind: 'projected',
          exactPointEvaluation: true,
          exactTangentEvaluation: source.exactTangentEvaluation === true,
          exactPolylineEvaluation: source.exactPolylineEvaluation,
          projectionSegments,
          evaluate: (parameter) => project(source.evaluate(parameter)),
          tangent: source.exactTangentEvaluation === true
            ? (parameter) => normalize(
              subtract(source.tangent(parameter), multiply(plane.normal, dot(source.tangent(parameter), plane.normal))),
              'Projected path tangent',
            )
            : null,
        };
      } else if (reference.kind === 'composite') {
        if (!Array.isArray(reference.sourceSketchIds) || reference.sourceSketchIds.length < 2) {
          throw new Error('Composite curve requires at least two source paths.');
        }
        const sources = reference.sourceSketchIds.map((id) => resolvePath(id));
        const points = [];
        for (const [index, source] of sources.entries()) {
          if (!source.points.length) throw new Error('Composite curve source path is empty.');
          if (index > 0 && length(subtract(points.at(-1), source.points[0])) > 1e-6) {
            throw new Error('Composite curve source paths must connect end to start.');
          }
          points.push(...(index === 0 ? source.points : source.points.slice(1)));
        }
        result = {
          points,
          referenceKind: 'composite',
          exactPointEvaluation: sources.every((source) => source.exactPointEvaluation),
          exactTangentEvaluation: sources.every((source) => source.exactTangentEvaluation),
          exactPolylineEvaluation: sources.every((source) => source.exactPolylineEvaluation),
          projectionSegments: sources.every((source) => source.projectionSegments)
            ? sources.flatMap((source) => source.projectionSegments)
            : null,
        };
        result.evaluate = result.exactPolylineEvaluation
          ? (parameter) => evaluatePolylineAtArcFraction(points, parameter)
          : result.projectionSegments
            ? (parameter) => evaluateSegments(result.projectionSegments, parameter)
            : (parameter) => {
              if (parameter === 1) return sources.at(-1).evaluate(1);
              const scaled = parameter * sources.length;
              const index = Math.min(sources.length - 1, Math.floor(scaled));
              return sources[index].evaluate(scaled - index);
            };
        result.tangent = result.exactPolylineEvaluation
          ? (parameter) => evaluatePolylineTangentAtArcFraction(points, parameter)
          : result.projectionSegments
            ? (parameter) => evaluateSegmentsTangent(result.projectionSegments, parameter)
            : result.exactTangentEvaluation
              ? (parameter) => {
                if (parameter === 1) return sources.at(-1).tangent(1);
                const scaled = parameter * sources.length;
                const index = Math.min(sources.length - 1, Math.floor(scaled));
                return sources[index].tangent(scaled - index);
              }
              : null;
      } else if (reference.kind === 'helix') {
        const frame = resolveDatum(reference.axisDatumId);
        if (frame?.kind !== 'axis' && frame?.kind !== 'coordinate-system') throw new Error('Helical curve requires an axis or coordinate-system datum.');
        const radius = evaluateStudioV5Expression(reference.radius, parameters);
        const pitch = evaluateStudioV5Expression(reference.pitch, parameters);
        const turns = evaluateStudioV5Expression(reference.turns, parameters);
        const startAngle = evaluateStudioV5Expression(reference.startAngle ?? 0, parameters);
        if (!(radius > EPSILON)) throw new Error('Helical curve radius must evaluate above zero.');
        if (!(pitch > EPSILON)) throw new Error('Helical curve pitch must evaluate above zero.');
        if (!(turns > 0 && turns <= 100)) throw new Error('Helical curve turns must evaluate above zero and at most 100.');
        if (reference.handedness !== 'right' && reference.handedness !== 'left') throw new Error('Helical curve handedness must be right or left.');
        const origin = frame.origin;
        const axis = frame.kind === 'axis' ? frame.direction : frame.zDirection;
        const xDirection = frame.kind === 'coordinate-system' ? frame.xDirection : orthogonalX(axis);
        const yDirection = frame.kind === 'coordinate-system' ? frame.yDirection : normalize(cross(axis, xDirection));
        const samples = Math.min(2401, Math.max(25, Math.ceil(turns * 24) + 1));
        const sign = reference.handedness === 'left' ? -1 : 1;
        const evaluate = (parameter) => {
          const angle = (startAngle + sign * 360 * turns * parameter) * Math.PI / 180;
          return add(
            add(origin, multiply(axis, pitch * turns * parameter)),
            add(multiply(xDirection, radius * Math.cos(angle)), multiply(yDirection, radius * Math.sin(angle))),
          );
        };
        const points = Array.from({ length: samples }, (_, index) => evaluate(index / (samples - 1)));
        result = {
          points,
          referenceKind: 'helix',
          exactPointEvaluation: true,
          exactTangentEvaluation: true,
          exactPolylineEvaluation: false,
          projectionSegments: null,
          evaluate,
          tangent: (parameter) => {
            const angle = (startAngle + sign * 360 * turns * parameter) * Math.PI / 180;
            const angularRate = sign * Math.PI * 2 * turns;
            return normalize(add(
              multiply(axis, pitch * turns),
              add(
                multiply(xDirection, -radius * Math.sin(angle) * angularRate),
                multiply(yDirection, radius * Math.cos(angle) * angularRate),
              ),
            ), 'Helical path tangent');
          },
        };
      } else {
        throw new Error('Reference-curve kind "' + String(reference.kind) + '" is unsupported.');
      }
      if (result.points.length < 2) throw new Error('Reference curve requires at least two points.');
      active.delete(sketchId);
      resolved.set(sketchId, result);
      return result;
    } catch (error) {
      active.delete(sketchId);
      throw error;
    }
  }
  return resolvePath;
}

function sameKind(frame, kind, name) {
  if (!frame || frame.kind !== kind) throw new Error(name + ' must reference a ' + kind + '.');
  return frame;
}

export function resolveStudioV5Datums(project, partId = project.rootDocument?.partId) {
  const part = (project.partDefinitions || []).find((entry) => entry.id === partId);
  if (!part) throw new Error('The requested part definition is missing.');
  const parameters = studioV5ParameterValues(project, part);
  const definitions = new Map((part.referenceGeometry || []).map((datum) => [datum.id, datum]));
  const resolved = new Map();
  const errors = new Map();
  const active = new Set();
  const owns = (record, key) => Object.prototype.hasOwnProperty.call(record, key);
  const authoredOr = (record, key, fallback) => owns(record, key) ? record[key] : fallback;
  const resolvePath = createStudioV5PathPreviewResolver(part, parameters, (datumId) => resolve(datumId));

  function pointFrom(value, name) {
    if (typeof value === 'string') return sameKind(resolve(value), 'point', name).point;
    return expressionVector(value, parameters, name);
  }

  function pointOnCurve(curveSketchId, parameterValue) {
    const path = resolvePath(curveSketchId);
    if (!path.exactPointEvaluation || typeof path.evaluate !== 'function') throw new Error('Point-on-curve requires an exactly evaluable path.');
    const parameter = evaluateStudioV5Expression(parameterValue, parameters);
    if (parameter < 0 || parameter > 1) throw new Error('Point-on-curve parameter must evaluate from 0 through 1.');
    return path.evaluate(parameter);
  }

  function resolve(id) {
    if (resolved.has(id)) return resolved.get(id);
    if (errors.has(id)) throw errors.get(id);
    const datum = definitions.get(id);
    if (!datum) throw new Error('Missing datum "' + id + '".');
    if (datum.suppressed) throw new Error('Datum "' + datum.name + '" is suppressed.');
    if (active.has(id)) throw new Error('Cyclic datum dependency at "' + datum.name + '".');
    active.add(id);
    try {
      if (!datum.definition || typeof datum.definition !== 'object' || Array.isArray(datum.definition)) {
        throw new Error('Datum "' + datum.name + '" definition must be an object.');
      }
      const definition = datum.definition;
      const supportedModes = datum.kind === 'plane'
        ? ['principal', 'offset', 'angle', 'three-point', 'point-normal', 'curve-normal', 'midplane']
        : datum.kind === 'axis'
          ? ['principal', 'through-points', 'plane-normal']
          : datum.kind === 'point'
            ? ['coordinates', 'midpoint', 'on-curve']
            : datum.kind === 'coordinate-system'
              ? ['principal']
              : [];
      if (owns(definition, 'mode') && !supportedModes.includes(definition.mode)) {
        throw new Error('Datum mode "' + String(definition.mode) + '" is unsupported for ' + datum.kind + '.');
      }
      let frame;
      if (datum.kind === 'point') {
        if (definition.mode === 'on-curve') {
          if (!owns(definition, 'parameter')) throw new Error('Point-on-curve requires an authored parameter.');
          frame = pointFrame(pointOnCurve(definition.curveSketchId, definition.parameter));
        } else if (definition.mode === 'midpoint') {
          frame = pointFrame(multiply(add(pointFrom(definition.pointA, 'First midpoint reference'), pointFrom(definition.pointB, 'Second midpoint reference')), 0.5));
        } else frame = pointFrame(expressionVector(
          owns(definition, 'coordinates') ? definition.coordinates : authoredOr(definition, 'point', [0, 0, 0]),
          parameters,
          'Point coordinates',
        ));
      } else if (datum.kind === 'axis') {
        if (definition.mode === 'through-points') {
          const first = pointFrom(definition.pointA, 'Axis start point');
          const second = pointFrom(definition.pointB, 'Axis end point');
          frame = axisFrame(first, subtract(second, first));
        } else if (definition.mode === 'plane-normal') {
          const plane = sameKind(resolve(definition.planeDatumId), 'plane', 'Axis plane');
          frame = axisFrame(definition.pointDatumId ? pointFrom(definition.pointDatumId, 'Axis point') : plane.origin, plane.normal);
        } else frame = axisFrame(
          expressionVector(authoredOr(definition, 'origin', [0, 0, 0]), parameters, 'Axis origin'),
          expressionVector(authoredOr(definition, 'direction', [1, 0, 0]), parameters, 'Axis direction'),
        );
      } else if (datum.kind === 'coordinate-system') {
        frame = coordinateFrame(
          expressionVector(authoredOr(definition, 'origin', [0, 0, 0]), parameters, 'Coordinate-system origin'),
          expressionVector(authoredOr(definition, 'xDirection', [1, 0, 0]), parameters, 'Coordinate-system X direction'),
          expressionVector(authoredOr(definition, 'zDirection', [0, 0, 1]), parameters, 'Coordinate-system Z direction'),
        );
      } else if (definition.mode === 'offset') {
        const base = sameKind(resolve(definition.referenceDatumId), 'plane', 'Offset reference');
        if (!owns(definition, 'offset')) throw new Error('Offset datum requires an authored offset.');
        if (owns(definition, 'flipNormal') && typeof definition.flipNormal !== 'boolean') throw new Error('Offset datum flipNormal must be true or false.');
        const signed = evaluateStudioV5Expression(definition.offset, parameters) * (definition.flipNormal === true ? -1 : 1);
        frame = planeFrame(add(base.origin, multiply(base.normal, signed)), definition.flipNormal === true ? multiply(base.normal, -1) : base.normal, base.xDirection);
      } else if (definition.mode === 'angle') {
        const base = sameKind(resolve(definition.referenceDatumId), 'plane', 'Angle reference');
        const axis = sameKind(resolve(definition.axisDatumId), 'axis', 'Angle axis');
        if (!owns(definition, 'angle')) throw new Error('Angle datum requires an authored angle.');
        const angle = evaluateStudioV5Expression(definition.angle, parameters);
        const rotatedOrigin = add(axis.origin, rotateVector(subtract(base.origin, axis.origin), axis.direction, angle));
        frame = planeFrame(rotatedOrigin, rotateVector(base.normal, axis.direction, angle), rotateVector(base.xDirection, axis.direction, angle));
      } else if (definition.mode === 'three-point') {
        const first = pointFrom(definition.points?.[0] ?? definition.pointA, 'First plane point');
        const second = pointFrom(definition.points?.[1] ?? definition.pointB, 'Second plane point');
        const third = pointFrom(definition.points?.[2] ?? definition.pointC, 'Third plane point');
        frame = planeFrame(first, cross(subtract(second, first), subtract(third, first)), subtract(second, first));
      } else if (definition.mode === 'curve-normal') {
        if (typeof definition.curveSketchId === 'string' && definition.curveSketchId) {
          const path = resolvePath(definition.curveSketchId);
          if (!path.exactPointEvaluation || !path.exactTangentEvaluation || typeof path.evaluate !== 'function' || typeof path.tangent !== 'function') {
            throw new Error('Curve-normal plane requires an exactly evaluable path and tangent.');
          }
          const parameter = evaluateStudioV5Expression(authoredOr(definition, 'parameter', 0), parameters);
          if (parameter < 0 || parameter > 1) throw new Error('Curve-normal plane parameter must evaluate from 0 through 1.');
          const tangent = path.tangent(parameter);
          const hasReferenceNormal = owns(definition, 'referenceNormal');
          const hasReferenceXDirection = owns(definition, 'referenceXDirection');
          if (hasReferenceNormal !== hasReferenceXDirection) {
            throw new Error('Curve-normal plane referenceNormal and referenceXDirection must be provided together.');
          }
          const xDirection = hasReferenceNormal
            ? transportPlaneXDirection(
              expressionVector(definition.referenceNormal, parameters, 'Curve-normal reference normal'),
              expressionVector(definition.referenceXDirection, parameters, 'Curve-normal reference X direction'),
              tangent,
            )
            : expressionVector(authoredOr(definition, 'xDirection', [1, 0, 0]), parameters, 'Curve-normal plane X direction');
          frame = planeFrame(
            path.evaluate(parameter),
            tangent,
            xDirection,
          );
        } else {
          const origin = pointFrom(
            owns(definition, 'pointDatumId') ? definition.pointDatumId : authoredOr(definition, 'point', [0, 0, 0]),
            'Curve-normal plane point',
          );
          const tangent = owns(definition, 'axisDatumId')
            ? sameKind(resolve(definition.axisDatumId), 'axis', 'Curve-normal tangent axis').direction
            : expressionVector(
                owns(definition, 'normal') ? definition.normal : authoredOr(definition, 'tangent', [0, 0, 1]),
                parameters,
                'Curve-normal tangent',
              );
          frame = planeFrame(
            origin,
            tangent,
            expressionVector(authoredOr(definition, 'xDirection', [1, 0, 0]), parameters, 'Curve-normal plane X direction'),
          );
        }
      } else if (definition.mode === 'point-normal') {
        const origin = pointFrom(
          owns(definition, 'pointDatumId') ? definition.pointDatumId : authoredOr(definition, 'point', [0, 0, 0]),
          'Plane point',
        );
        const direction = owns(definition, 'axisDatumId')
          ? sameKind(resolve(definition.axisDatumId), 'axis', 'Plane normal axis').direction
          : expressionVector(
              owns(definition, 'normal') ? definition.normal : authoredOr(definition, 'tangent', [0, 0, 1]),
              parameters,
              'Plane normal',
            );
        frame = planeFrame(
          origin,
          direction,
          expressionVector(authoredOr(definition, 'xDirection', [1, 0, 0]), parameters, 'Plane X direction'),
        );
      } else if (definition.mode === 'midplane') {
        const first = sameKind(resolve(definition.firstDatumId), 'plane', 'First midplane reference');
        const second = sameKind(resolve(definition.secondDatumId), 'plane', 'Second midplane reference');
        if (Math.abs(Math.abs(dot(first.normal, second.normal)) - 1) > 1e-6) throw new Error('Midplane references must be parallel.');
        frame = planeFrame(multiply(add(first.origin, second.origin), 0.5), first.normal, first.xDirection);
      } else {
        frame = planeFrame(
          expressionVector(authoredOr(definition, 'origin', [0, 0, 0]), parameters, 'Plane origin'),
          expressionVector(authoredOr(definition, 'normal', [0, 0, 1]), parameters, 'Plane normal'),
          expressionVector(authoredOr(definition, 'xDirection', [1, 0, 0]), parameters, 'Plane X direction'),
        );
      }
      active.delete(id);
      resolved.set(id, frame);
      return frame;
    } catch (error) {
      active.delete(id);
      const failure = error instanceof Error ? error : new Error(String(error));
      errors.set(id, failure);
      throw failure;
    }
  }

  for (const datum of definitions.values()) {
    try { resolve(datum.id); } catch {}
  }
  return { part, parameters, frames: resolved, errors, resolve };
}

export function resolveStudioV5PathPreview(project, sketchId, partId = project.rootDocument?.partId) {
  const part = (project.partDefinitions || []).find((entry) => entry.id === partId);
  if (!part) throw new Error('The requested part definition is missing.');
  const parameters = studioV5ParameterValues(project, part);
  const datums = resolveStudioV5Datums(project, part.id);
  return createStudioV5PathPreviewResolver(part, parameters, (datumId) => datums.resolve(datumId))(sketchId);
}

export function resolveStudioV5Transform(project, part, feature) {
  const datums = resolveStudioV5Datums(project, part.id);
  const parameters = datums.parameters;
  const vector = (value, name) => expressionVector(value, parameters, name);
  const scalar = (value, fallback = 0) => evaluateStudioV5Expression(value ?? fallback, parameters);
  const transform = feature.transform || {};
  const mode = transform.mode || feature.operation;
  if (mode === 'translate' || mode === 'move' || mode === 'copy') {
    return { mode, translation: vector(transform.translation || [0, 0, 0], 'Translation') };
  }
  if (mode === 'rotate') {
    const axis = transform.axisDatumId
      ? sameKind(datums.resolve(transform.axisDatumId), 'axis', 'Rotation axis')
      : axisFrame(vector(transform.origin || [0, 0, 0], 'Rotation origin'), vector(transform.direction || [1, 0, 0], 'Rotation direction'));
    return { mode, origin: axis.origin, direction: axis.direction, angle: scalar(transform.angle) };
  }
  if (mode === 'scale') {
    const factor = scalar(transform.factor, 1);
    if (!(factor > 0)) throw new Error('Scale factor must be greater than zero.');
    return { mode, center: vector(transform.center || [0, 0, 0], 'Scale center'), factor };
  }
  if (mode === 'mirror') {
    const plane = transform.planeDatumId
      ? sameKind(datums.resolve(transform.planeDatumId), 'plane', 'Mirror plane')
      : planeFrame(vector(transform.origin || [0, 0, 0], 'Mirror origin'), vector(transform.normal || [1, 0, 0], 'Mirror normal'));
    return { mode, origin: plane.origin, normal: plane.normal };
  }
  if (mode === 'align') {
    const from = datums.resolve(transform.fromDatumId);
    const to = datums.resolve(transform.toDatumId);
    if (from.kind !== to.kind || (from.kind !== 'plane' && from.kind !== 'axis' && from.kind !== 'coordinate-system')) {
      throw new Error('Align requires compatible plane, axis, or coordinate-system datums.');
    }
    return { mode, from, to, offset: scalar(transform.offset), flip: transform.flip === true };
  }
  throw new Error('Unsupported transform mode "' + mode + '".');
}

export const studioV5VectorMath = Object.freeze({
  add,
  subtract,
  multiply,
  dot,
  cross,
  length,
  normalize,
  rotateVector,
  planeFrame,
  axisFrame,
  transportPlaneXDirection,
});
