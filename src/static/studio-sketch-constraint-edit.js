import {
  SKETCH_CONSTRAINT_KINDS,
  solveSketch,
  validateConstraintSketch,
} from './studio-sketch-solver.js';
import { replaceStudioSketchMembers } from './studio-sketch-instances.js';

const field = (key, label, kinds) => Object.freeze({ key, label, kinds: Object.freeze(kinds) });
const spec = (kind, label, fields, valueLabel = null) => Object.freeze({
  kind,
  label,
  fields: Object.freeze(fields),
  ...(valueLabel ? { valueLabel } : {}),
});

export const SKETCH_CONSTRAINT_EDITOR_SPECS = Object.freeze([
  spec('coincident', 'Coincident', [field('a', 'First point', ['point']), field('b', 'Second point', ['point'])]),
  spec('horizontal', 'Horizontal', [field('line', 'Line', ['line'])]),
  spec('vertical', 'Vertical', [field('line', 'Line', ['line'])]),
  spec('parallel', 'Parallel', [field('a', 'First line', ['line']), field('b', 'Second line', ['line'])]),
  spec('perpendicular', 'Perpendicular', [field('a', 'First line', ['line']), field('b', 'Second line', ['line'])]),
  spec('tangent', 'Tangent', [field('a', 'Line or round curve', ['line', 'circle', 'arc']), field('b', 'Circle or arc', ['circle', 'arc'])]),
  spec('equal', 'Equal', [field('a', 'First curve', ['line', 'circle', 'arc']), field('b', 'Second matching curve', ['line', 'circle', 'arc'])]),
  spec('concentric', 'Concentric', [field('a', 'First circle or arc', ['circle', 'arc']), field('b', 'Second circle or arc', ['circle', 'arc'])]),
  spec('midpoint', 'Midpoint', [field('point', 'Point', ['point']), field('line', 'Line', ['line'])]),
  spec('pointOnLine', 'Point on line', [field('point', 'Point', ['point']), field('line', 'Line', ['line'])]),
  spec('pointOnCircle', 'Point on circle', [field('point', 'Point', ['point']), field('circle', 'Circle or arc', ['circle', 'arc'])]),
  spec('pierce', 'Pierce', [field('point', 'Point', ['point'])]),
  spec('symmetric', 'Symmetric', [field('a', 'First point', ['point']), field('b', 'Second point', ['point']), field('axis', 'Axis line', ['line'])]),
  spec('distance', 'Distance', [field('a', 'First point', ['point']), field('b', 'Second point', ['point'])], 'Distance'),
  spec('horizontalDistance', 'Horizontal distance', [field('a', 'First point', ['point']), field('b', 'Second point', ['point'])], 'Signed horizontal distance'),
  spec('verticalDistance', 'Vertical distance', [field('a', 'First point', ['point']), field('b', 'Second point', ['point'])], 'Signed vertical distance'),
  spec('length', 'Length', [field('line', 'Line', ['line'])], 'Length'),
  spec('radius', 'Radius', [field('circle', 'Circle or arc', ['circle', 'arc'])], 'Radius'),
  spec('angle', 'Angle', [field('a', 'First line', ['line']), field('b', 'Second line', ['line'])], 'Angle in degrees'),
]);

const specByKind = new Map(SKETCH_CONSTRAINT_EDITOR_SPECS.map((entry) => [entry.kind, entry]));

if (SKETCH_CONSTRAINT_EDITOR_SPECS.length !== SKETCH_CONSTRAINT_KINDS.length
  || SKETCH_CONSTRAINT_KINDS.some((kind) => !specByKind.has(kind))) {
  throw new Error('Sketch constraint editor specs do not cover the exact solver constraint vocabulary.');
}

export class SketchConstraintEditError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SketchConstraintEditError';
    this.code = code;
    Object.assign(this, details);
  }
}

const clone = (value) => structuredClone(value);

function fail(code, message, details) {
  throw new SketchConstraintEditError(code, message, details);
}

function preparedSource(sketch) {
  const structural = validateConstraintSketch(sketch);
  if (structural.length) {
    fail('SKETCH_CONSTRAINT_SOURCE_INVALID', structural[0].message, { diagnostics: structural });
  }
  return replaceStudioSketchMembers(sketch, {
    entities: clone(sketch.entities || []),
    constraints: clone(sketch.constraints || []),
  });
}

function nextConstraintId(sketch, kind) {
  const used = new Set((sketch.constraints || []).map((constraint) => constraint.id).filter(Boolean));
  for (let index = 1; index <= 100000; index++) {
    const id = `constraint-${kind}-${index}`;
    if (!used.has(id)) return id;
  }
  fail('SKETCH_CONSTRAINT_ID_EXHAUSTED', `Could not allocate an ID for ${kind}.`);
}

function normalizedValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) {
    fail('SKETCH_CONSTRAINT_VALUE_INVALID', 'A driving value or expression is required.');
  }
  const trimmed = value.trim();
  return /^-?\d+(?:\.\d+)?$/u.test(trimmed) ? Number(trimmed) : trimmed;
}

function evaluatedCandidate(candidate, options, requireSolvable) {
  const structural = validateConstraintSketch(candidate);
  if (structural.length) {
    fail('SKETCH_CONSTRAINT_STRUCTURE_INVALID', structural[0].message, { diagnostics: structural });
  }
  let result;
  try {
    result = solveSketch(candidate, {
      resolveDimension: options?.resolveDimension,
      resolvePierce: options?.resolvePierce,
    });
  } catch (error) {
    if (requireSolvable) throw error;
    result = {
      status: 'invalid',
      diagnostics: [{
        code: 'SKETCH_CONSTRAINT_EVALUATION_FAILED',
        message: String(error?.message || error),
      }],
    };
  }
  if (requireSolvable && result.status !== 'ok') {
    fail(
      'SKETCH_CONSTRAINT_SOLVE_FAILED',
      result.diagnostics?.[0]?.message || 'The constraint does not produce a solvable sketch.',
      { diagnostics: clone(result.diagnostics || []), status: result.status },
    );
  }
  return result;
}

export function getSketchConstraintEditorSpec(kind) {
  return specByKind.get(kind) || null;
}

export function sketchConstraintEntityOptions(sketch, kind, fieldKey) {
  const editorSpec = getSketchConstraintEditorSpec(kind);
  const operand = editorSpec?.fields.find((entry) => entry.key === fieldKey);
  if (!operand) return [];
  const allowed = new Set(operand.kinds);
  return (sketch?.entities || [])
    .filter((entity) => allowed.has(entity.kind))
    .map((entity) => ({ id: entity.id, kind: entity.kind }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function addSketchConstraint(sketch, input, options = {}) {
  const source = preparedSource(sketch);
  const editorSpec = getSketchConstraintEditorSpec(input?.kind);
  if (!editorSpec) {
    fail('SKETCH_CONSTRAINT_KIND_UNSUPPORTED', `Unsupported sketch constraint kind "${String(input?.kind)}".`);
  }
  const constraint = {
    id: input.id || nextConstraintId(source, editorSpec.kind),
    kind: editorSpec.kind,
  };
  if (typeof constraint.id !== 'string' || !constraint.id) {
    fail('SKETCH_CONSTRAINT_ID_INVALID', 'Constraint ID must be a non-empty string.');
  }
  if (source.constraints.some((entry) => entry.id === constraint.id)) {
    fail('SKETCH_CONSTRAINT_ID_DUPLICATE', `Constraint ID "${constraint.id}" already exists.`);
  }
  if (input.driving !== undefined && typeof input.driving !== 'boolean') {
    fail('SKETCH_CONSTRAINT_DRIVING_INVALID', 'Constraint driving state must be boolean.');
  }
  if (input.driving === false && !editorSpec.valueLabel) {
    fail('SKETCH_CONSTRAINT_REFERENCE_INVALID', 'Only dimensional constraints can be reference dimensions.');
  }
  if (input.driving === false && input.value !== undefined) {
    fail('SKETCH_CONSTRAINT_REFERENCE_VALUE_INVALID', 'Reference dimensions measure solved geometry and cannot store a driving value.');
  }
  for (const operand of editorSpec.fields) {
    const entityId = input[operand.key];
    const allowed = sketchConstraintEntityOptions(source, editorSpec.kind, operand.key);
    if (!allowed.some((entry) => entry.id === entityId)) {
      fail(
        'SKETCH_CONSTRAINT_OPERAND_INVALID',
        `${operand.label} must reference a ${operand.kinds.join(' or ')} entity.`,
        { field: operand.key, entityId },
      );
    }
    constraint[operand.key] = entityId;
  }
  const operandIds = editorSpec.fields.map((operand) => constraint[operand.key]);
  if (new Set(operandIds).size !== operandIds.length) {
    fail(
      'SKETCH_CONSTRAINT_OPERANDS_NOT_DISTINCT',
      `${editorSpec.label} requires distinct referenced entities.`,
    );
  }
  if (editorSpec.valueLabel) {
    if (input.driving === false) constraint.driving = false;
    else constraint.value = normalizedValue(input.value);
  }
  if (editorSpec.kind === 'pierce') {
    if (typeof input.curveSketchId !== 'string' || !input.curveSketchId) {
      fail('SKETCH_PIERCE_CURVE_REQUIRED', 'Pierce requires a persistent reference curve.');
    }
    if (typeof input.planeDatumId !== 'string' || !input.planeDatumId) {
      fail('SKETCH_PIERCE_PLANE_REQUIRED', 'Pierce requires a persistent sketch plane datum.');
    }
    constraint.curveSketchId = input.curveSketchId;
    constraint.planeDatumId = input.planeDatumId;
  }
  const candidate = replaceStudioSketchMembers(source, {
    entities: source.entities,
    constraints: [...source.constraints, constraint],
  });
  const result = evaluatedCandidate(candidate, options, true);
  return { sketch: candidate, constraint: clone(constraint), result };
}

export function updateSketchDrivingDimension(sketch, selector, value, options = {}) {
  const source = preparedSource(sketch);
  const index = typeof selector?.index === 'number'
    ? selector.index
    : source.constraints.findIndex((constraint) => constraint.id === selector?.id);
  if (!Number.isInteger(index) || index < 0 || index >= source.constraints.length) {
    fail('SKETCH_CONSTRAINT_NOT_FOUND', 'The requested sketch constraint does not exist.');
  }
  const previous = source.constraints[index];
  const editorSpec = getSketchConstraintEditorSpec(previous.kind);
  if (!editorSpec?.valueLabel || previous.driving === false) {
    fail('SKETCH_CONSTRAINT_NOT_DRIVING_DIMENSION', 'Only a driving dimension can be edited.');
  }
  const updated = { ...previous, value: normalizedValue(value) };
  const candidate = replaceStudioSketchMembers(source, {
    entities: source.entities,
    constraints: source.constraints.map((constraint, constraintIndex) => constraintIndex === index ? updated : constraint),
  });
  const result = evaluatedCandidate(candidate, options, true);
  return { sketch: candidate, constraint: clone(updated), previous: clone(previous), result };
}

export function setSketchPointFixed(sketch, pointId, fixed, options = {}) {
  if (typeof fixed !== 'boolean') {
    fail('SKETCH_POINT_FIXED_INVALID', 'Point fixed state must be boolean.');
  }
  const source = preparedSource(sketch);
  const pointIndex = source.entities.findIndex((entity) => entity.id === pointId && entity.kind === 'point');
  if (pointIndex < 0) fail('SKETCH_POINT_NOT_FOUND', 'The requested sketch point does not exist.');
  const sourceResult = evaluatedCandidate(source, options, true);
  const solvedPoint = sourceResult.entities.find((entity) => entity.id === pointId);
  const updatedPoint = { ...source.entities[pointIndex], at: clone(solvedPoint.at) };
  if (fixed) updatedPoint.fixed = true;
  else delete updatedPoint.fixed;
  const candidate = replaceStudioSketchMembers(source, {
    entities: source.entities.map((entity, index) => index === pointIndex ? updatedPoint : entity),
    constraints: source.constraints,
  });
  const result = evaluatedCandidate(candidate, options, true);
  return { sketch: candidate, point: clone(updatedPoint), previous: clone(source.entities[pointIndex]), result };
}

export function mergeSketchPoints(sketch, keepPointId, removePointId, options = {}) {
  if (keepPointId === removePointId) {
    fail('SKETCH_POINT_MERGE_SAME', 'Merge requires two distinct points.');
  }
  const source = preparedSource(sketch);
  const keep = source.entities.find((entity) => entity.id === keepPointId && entity.kind === 'point');
  const removed = source.entities.find((entity) => entity.id === removePointId && entity.kind === 'point');
  if (!keep || !removed) fail('SKETCH_POINT_NOT_FOUND', 'Both merge operands must reference existing points.');
  const sourceResult = evaluatedCandidate(source, options, true);
  const solvedById = new Map(sourceResult.entities.map((entity) => [entity.id, entity]));
  const keepSolved = solvedById.get(keepPointId);
  const removeSolved = solvedById.get(removePointId);
  if (keep.fixed && removed.fixed && Math.hypot(keepSolved.at[0] - removeSolved.at[0], keepSolved.at[1] - removeSolved.at[1]) > 1e-9) {
    fail('SKETCH_POINT_MERGE_FIXED_CONFLICT', 'Distinct fixed points cannot be merged.');
  }
  const mergedPoint = {
    ...keep,
    at: clone(removed.fixed && !keep.fixed ? removeSolved.at : keepSolved.at),
    ...((keep.fixed || removed.fixed) ? { fixed: true } : {}),
  };
  const replace = (value) => value === removePointId ? keepPointId : value;
  const entities = source.entities
    .filter((entity) => entity.id !== removePointId)
    .map((entity) => {
      if (entity.id === keepPointId) return mergedPoint;
      const updated = { ...entity };
      for (const key of ['a', 'b', 'center']) if (typeof updated[key] === 'string') updated[key] = replace(updated[key]);
      if (Array.isArray(updated.through)) updated.through = updated.through.map(replace);
      return updated;
    });
  const droppedConstraintIds = [];
  const constraints = [];
  for (let index = 0; index < source.constraints.length; index++) {
    const constraint = source.constraints[index];
    const updated = { ...constraint };
    for (const key of ['a', 'b', 'line', 'circle', 'point', 'axis']) {
      if (typeof updated[key] === 'string') updated[key] = replace(updated[key]);
    }
    if (updated.kind === 'coincident' && updated.a === updated.b) {
      droppedConstraintIds.push(updated.id || 'coincident#' + index);
      continue;
    }
    constraints.push(updated);
  }
  const rewriteRelationReference = (value) => {
    if (typeof value === 'string') return replace(value);
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.entityId !== 'string') return value;
    return { ...value, entityId: replace(value.entityId) };
  };
  const rewrittenSource = Array.isArray(source.relations)
    ? {
        ...source,
        relations: source.relations.map((relation) => {
          const updated = { ...relation };
          for (const key of ['a', 'b', 'line', 'circle', 'point', 'axis']) {
            if (updated[key] !== undefined) updated[key] = rewriteRelationReference(updated[key]);
          }
          return updated;
        }),
      }
    : source;
  const candidate = replaceStudioSketchMembers(rewrittenSource, { entities, constraints });
  const result = evaluatedCandidate(candidate, options, true);
  return {
    sketch: candidate,
    point: clone(mergedPoint),
    removed: clone(removed),
    droppedConstraintIds,
    result,
  };
}

export function deleteSketchConstraint(sketch, selector, options = {}) {
  const source = preparedSource(sketch);
  const index = typeof selector?.index === 'number'
    ? selector.index
    : source.constraints.findIndex((constraint) => constraint.id === selector?.id);
  if (!Number.isInteger(index) || index < 0 || index >= source.constraints.length) {
    fail('SKETCH_CONSTRAINT_NOT_FOUND', 'The requested sketch constraint does not exist.');
  }
  const removed = source.constraints[index];
  const candidate = replaceStudioSketchMembers(source, {
    entities: source.entities,
    constraints: source.constraints.filter((_constraint, constraintIndex) => constraintIndex !== index),
  });
  // Deletion is a recovery operation. Return the remaining solve state even
  // when another conflict is still present so users can remove conflicts one
  // at a time instead of being trapped by the pre-existing sketch state.
  const result = evaluatedCandidate(candidate, options, false);
  return { sketch: candidate, constraint: clone(removed), result };
}
