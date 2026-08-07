import { solveSketch, solveSketchPreview } from './studio-sketch-solver.js';

export const STUDIO_SKETCH_DRAG_SCHEMA = 'partmode.sketch-drag/v1';

const SESSION_TAG = Symbol('partmode.sketch-drag-session');
const CONSTRAINT_REFERENCE_FIELDS = Object.freeze(['a', 'b', 'line', 'circle', 'point', 'axis']);
const DEFAULT_TARGET_TOLERANCE = 1e-7;

export class StudioSketchDragError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioSketchDragError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new StudioSketchDragError(code, message, details);
}

function clone(value) {
  return structuredClone(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function entityPointReferences(entity) {
  if (entity.kind === 'line') return [entity.a, entity.b];
  if (entity.kind === 'circle') return [entity.center];
  if (entity.kind === 'arc') return [entity.center, entity.a, entity.b];
  if (entity.kind === 'spline') return entity.through || [];
  return [];
}

function constraintEntityReferences(constraint, byId) {
  const references = [];
  for (const field of CONSTRAINT_REFERENCE_FIELDS) {
    const id = constraint?.[field];
    if (typeof id === 'string' && byId.has(id) && !references.includes(id)) references.push(id);
  }
  return references;
}

function connect(adjacency, left, right) {
  if (!adjacency.has(left)) adjacency.set(left, new Set());
  if (!adjacency.has(right)) adjacency.set(right, new Set());
  adjacency.get(left).add(right);
  adjacency.get(right).add(left);
}

function extractConstraintComponent(sketch, seedId) {
  const entities = sketch.entities || [];
  const constraints = sketch.constraints || [];
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  if (!byId.has(seedId)) fail('SKETCH_DRAG_HANDLE_MISSING', `Sketch drag handle "${seedId}" does not exist.`, { entityId: seedId });

  const adjacency = new Map(entities.map((entity) => [entity.id, new Set()]));
  for (const entity of entities) {
    for (const pointId of entityPointReferences(entity)) {
      if (byId.has(pointId)) connect(adjacency, entity.id, pointId);
    }
  }
  for (const constraint of constraints) {
    const references = constraintEntityReferences(constraint, byId);
    for (let left = 0; left < references.length; left++) {
      for (let right = left + 1; right < references.length; right++) {
        connect(adjacency, references[left], references[right]);
      }
    }
  }

  const included = new Set([seedId]);
  const queue = [seedId];
  for (let index = 0; index < queue.length; index++) {
    for (const neighbour of adjacency.get(queue[index]) || []) {
      if (included.has(neighbour)) continue;
      included.add(neighbour);
      queue.push(neighbour);
    }
  }

  const includedConstraintIndexes = [];
  constraints.forEach((constraint, index) => {
    const references = constraintEntityReferences(constraint, byId);
    if (references.some((id) => included.has(id))) includedConstraintIndexes.push(index);
  });
  const componentEntities = entities.filter((entity) => included.has(entity.id));
  const componentConstraints = constraints.filter((_, index) => includedConstraintIndexes.includes(index));
  const kinds = { point: 0, line: 0, circle: 0, arc: 0, spline: 0 };
  for (const entity of componentEntities) {
    if (Object.prototype.hasOwnProperty.call(kinds, entity.kind)) kinds[entity.kind]++;
  }
  return {
    sketch: { entities: clone(componentEntities), constraints: clone(componentConstraints) },
    entityIds: componentEntities.map((entity) => entity.id),
    constraintIndexes: includedConstraintIndexes,
    counts: {
      entities: componentEntities.length,
      constraints: componentConstraints.length,
      points: kinds.point,
      lines: kinds.line,
      circles: kinds.circle,
      arcs: kinds.arc,
      splines: kinds.spline,
      sourceEntities: entities.length,
      sourceConstraints: constraints.length,
    },
  };
}

function normalizeHandle(sketch, input) {
  if (!input || typeof input !== 'object') {
    fail('SKETCH_DRAG_HANDLE_INVALID', 'Sketch drag handle must describe one point or round-geometry radius.');
  }
  const kind = input.kind;
  const entityId = kind === 'point'
    ? input.pointId || input.entityId
    : kind === 'radius'
      ? input.entityId || input.circleId || input.arcId
      : null;
  if (typeof entityId !== 'string' || !entityId) {
    fail('SKETCH_DRAG_HANDLE_INVALID', 'Sketch drag handle requires a stable entity id.', { kind: kind || null });
  }
  const entity = (sketch.entities || []).find((entry) => entry.id === entityId);
  if (!entity) fail('SKETCH_DRAG_HANDLE_MISSING', `Sketch drag handle "${entityId}" does not exist.`, { entityId });
  if (kind === 'point' && entity.kind !== 'point') {
    fail('SKETCH_DRAG_HANDLE_KIND', `Sketch drag point handle "${entityId}" does not reference a point.`, { entityId, entityKind: entity.kind });
  }
  if (kind === 'radius' && entity.kind !== 'circle' && entity.kind !== 'arc') {
    fail('SKETCH_DRAG_HANDLE_KIND', `Sketch drag radius handle "${entityId}" does not reference a circle or arc.`, { entityId, entityKind: entity.kind });
  }
  if (kind !== 'point' && kind !== 'radius') {
    fail('SKETCH_DRAG_HANDLE_INVALID', 'Sketch drag handle kind must be "point" or "radius".', { kind: kind || null });
  }
  return { kind, entityId, entityKind: entity.kind };
}

function normalizeTarget(handle, input) {
  if (handle.kind === 'point') {
    const target = Array.isArray(input) ? input : input?.at;
    if (!Array.isArray(target) || target.length !== 2 || target.some((value) => !Number.isFinite(value))) {
      fail('SKETCH_DRAG_TARGET_INVALID', 'Point drag target must contain two finite sketch-plane coordinates.');
    }
    return [target[0], target[1]];
  }
  const target = typeof input === 'number' ? input : input?.radius;
  if (!Number.isFinite(target) || !(target > 0)) {
    fail('SKETCH_DRAG_TARGET_INVALID', 'Radius drag target must be one finite positive length.');
  }
  return target;
}

function pointAt(byId, pointId) {
  return byId.get(pointId)?.at;
}

function radiusOf(handle, entities) {
  const byId = new Map((entities || []).map((entity) => [entity.id, entity]));
  const entity = byId.get(handle.entityId);
  if (entity?.kind === 'circle') return entity.solvedR;
  if (entity?.kind === 'arc') {
    const center = pointAt(byId, entity.center);
    const edge = pointAt(byId, entity.a);
    if (center && edge) return Math.hypot(edge[0] - center[0], edge[1] - center[1]);
  }
  return null;
}

function targetReached(handle, entities, target, tolerance) {
  const byId = new Map((entities || []).map((entity) => [entity.id, entity]));
  if (handle.kind === 'point') {
    const at = byId.get(handle.entityId)?.at;
    return Array.isArray(at) && Math.hypot(at[0] - target[0], at[1] - target[1]) <= tolerance;
  }
  const actual = radiusOf(handle, entities);
  return Number.isFinite(actual) && Math.abs(actual - target) <= tolerance;
}

function achievedTarget(handle, entities) {
  if (handle.kind === 'point') {
    const entity = (entities || []).find((entry) => entry.id === handle.entityId);
    return Array.isArray(entity?.at) ? [entity.at[0], entity.at[1]] : null;
  }
  return radiusOf(handle, entities);
}

function targetDistance(handle, left, right) {
  if (handle.kind === 'point') {
    if (!Array.isArray(left) || !Array.isArray(right)) return Infinity;
    return Math.hypot(left[0] - right[0], left[1] - right[1]);
  }
  return Number.isFinite(left) && Number.isFinite(right) ? Math.abs(left - right) : Infinity;
}

function withProjectionEvidence(result, handle, currentTarget, requestedTarget, projected, hardResult = result, method = projected ? 'seeded-manifold' : 'exact-target') {
  const achieved = achievedTarget(handle, result.entities);
  const cursorDistanceBefore = targetDistance(handle, currentTarget, requestedTarget);
  const cursorDistanceAfter = targetDistance(handle, achieved, requestedTarget);
  return {
    ...result,
    projection: {
      applied: projected,
      method,
      requestedTarget: clone(requestedTarget),
      achievedTarget: clone(achieved),
      movement: targetDistance(handle, currentTarget, achieved),
      cursorDistanceBefore,
      cursorDistanceAfter,
      improvement: cursorDistanceBefore - cursorDistanceAfter,
      hardTargetStatus: hardResult.status,
      hardTargetResidual: hardResult.residual ?? null,
    },
  };
}

function transientCandidate(componentSketch, handle, target) {
  const candidate = clone(componentSketch);
  if (handle.kind === 'point') {
    const point = candidate.entities.find((entity) => entity.id === handle.entityId);
    point.at = [target[0], target[1]];
    point.fixed = true;
  } else {
    candidate.constraints ||= [];
    candidate.constraints.push({ kind: 'radius', circle: handle.entityId, value: target });
  }
  return candidate;
}

function projectedPointCandidate(componentSketch, handle, target, method) {
  const candidate = clone(componentSketch);
  if (method === 'seeded-manifold') {
    const point = candidate.entities.find((entity) => entity.id === handle.entityId);
    point.at = [target[0], target[1]];
    return candidate;
  }
  const existingIds = new Set(candidate.entities.map((entity) => entity.id));
  let suffix = 0;
  let anchorId = '__partmode-drag-target';
  while (existingIds.has(anchorId)) anchorId = `__partmode-drag-target-${++suffix}`;
  candidate.entities.push({ id: anchorId, kind: 'point', at: [target[0], target[1]], fixed: true, construction: true });
  candidate.constraints ||= [];
  candidate.constraints.push({
    kind: method === 'x-axis-driver' ? 'horizontalDistance' : 'verticalDistance',
    a: anchorId,
    b: handle.entityId,
    value: 0,
  });
  return candidate;
}

function solveTransient(componentSketch, handle, target, solveOptions, tolerance, currentTarget) {
  const candidate = transientCandidate(componentSketch, handle, target);
  const hardResult = solveSketchPreview(candidate, solveOptions);
  if (hardResult.status === 'ok' && targetReached(handle, hardResult.entities, target, tolerance)) {
    return withProjectionEvidence(hardResult, handle, currentTarget, target, false);
  }

  // A point with fewer than two free coordinates cannot generally land on the
  // raw cursor.  Seed it at the request without fixing either coordinate, then
  // solve only the authored constraints.  The second solve is the exact
  // constraint-manifold projection used for display and settlement.
  let projectedResult = null;
  let projectedTarget = null;
  let movement = 0;
  let improvement = 0;
  if (handle.kind === 'point') {
    const candidates = [];
    for (const method of ['x-axis-driver', 'y-axis-driver', 'seeded-manifold']) {
      const candidate = projectedPointCandidate(componentSketch, handle, target, method);
      const result = solveSketchPreview(candidate, solveOptions);
      const achieved = achievedTarget(handle, result.entities);
      const candidateMovement = targetDistance(handle, currentTarget, achieved);
      const cursorDistance = targetDistance(handle, achieved, target);
      const candidateImprovement = targetDistance(handle, currentTarget, target) - cursorDistance;
      const moved = Array.isArray(achieved)
        ? [achieved[0] - currentTarget[0], achieved[1] - currentTarget[1]]
        : [0, 0];
      const requested = [target[0] - currentTarget[0], target[1] - currentTarget[1]];
      const directionalProgress = candidateMovement > tolerance
        ? (moved[0] * requested[0] + moved[1] * requested[1]) / candidateMovement
        : 0;
      const exactResidual = result.status === 'ok'
        && Number.isFinite(result.residual)
        && result.residual <= Math.max(tolerance, 1e-7);
      const nonWorsening = cursorDistance <= targetDistance(handle, currentTarget, target) + tolerance;
      if (exactResidual && candidateMovement > tolerance && directionalProgress > tolerance && nonWorsening) {
        candidates.push({
          method, result, achieved, movement: candidateMovement, improvement: candidateImprovement,
          cursorDistance, directionalProgress,
        });
      }
      if (!projectedResult || cursorDistance < targetDistance(handle, projectedTarget, target)) {
        projectedResult = result;
        projectedTarget = achieved;
        movement = candidateMovement;
        improvement = candidateImprovement;
      }
    }
    candidates.sort((left, right) => left.cursorDistance - right.cursorDistance
      || ['x-axis-driver', 'y-axis-driver', 'seeded-manifold'].indexOf(left.method)
        - ['x-axis-driver', 'y-axis-driver', 'seeded-manifold'].indexOf(right.method));
    const best = candidates[0];
    if (best) {
      return withProjectionEvidence(best.result, handle, currentTarget, target, true, hardResult, best.method);
    }
  }

  fail('SKETCH_DRAG_TARGET_UNSATISFIED', 'The sketch constraints cannot satisfy or project this drag target.', {
    entityId: handle.entityId,
    handleKind: handle.kind,
    target: clone(target),
    status: hardResult.status,
    residual: hardResult.residual ?? null,
    diagnostics: clone(hardResult.diagnostics || []),
    projection: projectedResult ? {
      status: projectedResult.status,
      residual: projectedResult.residual ?? null,
      achievedTarget: clone(projectedTarget),
      movement,
      improvement,
    } : null,
  });
}

function entityIndex(entityIndexById, id) {
  const index = entityIndexById?.[id];
  return Number.isInteger(index) ? index : -1;
}

function mergeSolvedEntities(
  baselineEntities,
  solvedEntities,
  reuseFrozenBaselineEntities = false,
  entityIndexById = null,
) {
  if (reuseFrozenBaselineEntities) {
    const merged = (baselineEntities || []).slice();
    for (const solved of solvedEntities || []) {
      const index = entityIndex(entityIndexById, solved.id);
      if (index < 0) continue;
      const baseline = baselineEntities[index];
      if (baseline.kind === 'point') {
        if (baseline.at[0] !== solved.at[0] || baseline.at[1] !== solved.at[1]) {
          merged[index] = { ...clone(baseline), at: [solved.at[0], solved.at[1]] };
        }
        continue;
      }
      if (baseline.kind === 'circle') {
        if (baseline.solvedR !== solved.solvedR) {
          merged[index] = { ...clone(baseline), solvedR: solved.solvedR };
        }
      }
      // Lines, arcs, and splines retain stable references; their point
      // geometry is read through the independently replaced point entries.
    }
    return merged;
  }
  // Keep result ownership independent without paying one structured-clone
  // invocation per entity on every pointer sample. One array clone preserves
  // the same deep-copy contract; indexed patching touches only solved geometry.
  const merged = clone(baselineEntities || []);
  for (const solved of solvedEntities || []) {
    const index = entityIndex(entityIndexById, solved.id);
    if (index < 0) continue;
    const baseline = merged[index];
    if (baseline.kind === 'point') baseline.at = [solved.at[0], solved.at[1]];
    else if (baseline.kind === 'circle') baseline.solvedR = solved.solvedR;
  }
  return merged;
}

function mergeSolvedSketch(
  sourceSketch,
  baselineEntities,
  solvedEntities,
  tolerance,
  entityIndexById,
  allowedEntityIds = null,
) {
  const merged = clone(sourceSketch);
  const solvedById = new Map((solvedEntities || []).map((entity) => [entity.id, entity]));
  const candidateIds = allowedEntityIds || [...solvedById.keys()];
  for (const id of candidateIds) {
    const index = entityIndex(entityIndexById, id);
    if (index < 0) continue;
    const entity = merged.entities[index];
    const solved = solvedById.get(id);
    if (!solved) continue;
    if (entity.kind === 'point') {
      entity.at = [solved.at[0], solved.at[1]];
    } else if (entity.kind === 'circle') {
      const before = baselineEntities[index]?.solvedR;
      if (Number.isFinite(solved.solvedR) && (!Number.isFinite(before) || Math.abs(solved.solvedR - before) > tolerance)) {
        if (typeof entity.r === 'string') {
          fail('SKETCH_DRAG_RADIUS_EXPRESSION', `Circle "${entity.id}" has an authored radius expression that drag cannot replace.`, { entityId: entity.id });
        }
        entity.r = solved.solvedR;
      }
    }
  }
  return merged;
}

function changedGeometry(baselineEntities, nextEntities, tolerance, componentEntityIndexes) {
  const changedPoints = new Set();
  const changedRadii = new Set();
  for (const index of componentEntityIndexes) {
    const baseline = baselineEntities[index];
    const next = nextEntities[index];
    if (!next) continue;
    if (baseline.kind === 'point' && Math.hypot(next.at[0] - baseline.at[0], next.at[1] - baseline.at[1]) > tolerance) {
      changedPoints.add(baseline.id);
    } else if (baseline.kind === 'circle'
      && Number.isFinite(baseline.solvedR) && Number.isFinite(next.solvedR)
      && Math.abs(next.solvedR - baseline.solvedR) > tolerance) {
      changedRadii.add(baseline.id);
    }
  }

  const affected = new Set([...changedPoints, ...changedRadii]);
  for (const index of componentEntityIndexes) {
    const entity = nextEntities[index];
    if (!entity) continue;
    const pointReferences = entityPointReferences(entity);
    if (pointReferences.some((id) => changedPoints.has(id))) affected.add(entity.id);
    if (entity.kind === 'circle' && changedRadii.has(entity.id)) affected.add(entity.id);
  }
  return {
    affectedIds: [...affected].sort(compareText),
    affectedPointIds: [...changedPoints].sort(compareText),
    affectedRadiusIds: [...changedRadii].sort(compareText),
  };
}

function assertSession(session) {
  if (!session || session[SESSION_TAG] !== true || session.schema !== STUDIO_SKETCH_DRAG_SCHEMA) {
    fail('SKETCH_DRAG_SESSION_INVALID', 'Sketch drag preview requires a session returned by beginStudioSketchDrag.');
  }
}

function interactionSolveOptions(session, options) {
  const {
    targetTolerance: _targetTolerance,
    solveOptions: nestedSolveOptions,
    presolved: _presolved,
    presolvedSourceSketch: _presolvedSourceSketch,
    reuseFrozenBaselineEntities: _reuseFrozenBaselineEntities,
    ...directSolveOptions
  } = options || {};
  return { ...session.solveOptions, ...directSolveOptions, ...(nestedSolveOptions || {}) };
}

function resultFor(session, phase, target, localResult, mergedSketch, entities, solver) {
  const changed = changedGeometry(
    session.entities,
    entities,
    session.targetTolerance,
    session.componentEntityIndexes,
  );
  const affectedIds = [...changed.affectedIds];
  const projection = clone(localResult.projection || {
    applied: false,
    requestedTarget: target,
    achievedTarget: target,
    movement: targetDistance(session.handle, session.currentTarget, target),
    cursorDistanceBefore: targetDistance(session.handle, session.currentTarget, target),
    cursorDistanceAfter: 0,
    improvement: targetDistance(session.handle, session.currentTarget, target),
    hardTargetStatus: localResult.status,
    hardTargetResidual: localResult.residual ?? null,
  });
  return {
    schema: STUDIO_SKETCH_DRAG_SCHEMA,
    phase,
    handle: clone(session.handle),
    target: clone(target),
    requestedTarget: clone(target),
    achievedTarget: clone(projection.achievedTarget),
    targetProjected: Boolean(projection.applied),
    projection,
    componentCounts: clone(session.componentCounts),
    componentEntityIds: [...session.componentEntityIds],
    ...changed,
    affectedIds,
    affectedEntityIds: affectedIds,
    sketch: mergedSketch,
    mergedSketch,
    entities,
    solver: {
      status: solver.status,
      iterations: solver.iterations,
      residual: solver.residual,
      equations: solver.equations,
      rank: solver.rank ?? null,
      dof: solver.dof ?? null,
      entityStates: clone(solver.entityStates || []),
      diagnostics: clone(solver.diagnostics || []),
      previewAnalysisSkipped: phase === 'preview',
    },
    componentResult: {
      status: localResult.status,
      iterations: localResult.iterations,
      residual: localResult.residual,
      equations: localResult.equations,
    },
  };
}

function radiusHandleIsMovable(componentSketch, handle, currentRadius, solveOptions, tolerance) {
  const step = Math.max(1e-4, Math.abs(currentRadius) * 1e-3);
  const targets = [currentRadius + step];
  if (currentRadius - step > tolerance) targets.push(currentRadius - step);
  for (const target of targets) {
    try {
      solveTransient(componentSketch, handle, target, solveOptions, tolerance, currentRadius);
      return true;
    } catch (error) {
      if (!(error instanceof StudioSketchDragError) || error.code !== 'SKETCH_DRAG_TARGET_UNSATISFIED') throw error;
    }
  }
  return false;
}

export function beginStudioSketchDrag(sketch, handleInput, solveOptions = {}) {
  const sourceSketch = clone(sketch);
  const handle = normalizeHandle(sourceSketch, handleInput);
  const hasPresolved = Object.prototype.hasOwnProperty.call(solveOptions || {}, 'presolved');
  const hasPresolvedSource = Object.prototype.hasOwnProperty.call(solveOptions || {}, 'presolvedSourceSketch');
  const { presolved: _presolved, presolvedSourceSketch: _presolvedSourceSketch, ...effectiveSolveOptions } = solveOptions || {};
  if (hasPresolved || hasPresolvedSource) {
    fail('SKETCH_DRAG_PRESOLVED_UNSUPPORTED',
      'Sketch drag requires a fresh full solve of the current source; caller-supplied presolved evidence is not accepted.');
  }
  const baseline = solveSketch(sourceSketch, effectiveSolveOptions);
  if (baseline.status !== 'ok') {
    fail('SKETCH_DRAG_SOURCE_UNSOLVED', 'Sketch drag requires a structurally valid, currently solved sketch.', {
      status: baseline.status,
      diagnostics: clone(baseline.diagnostics || []),
    });
  }

  const sourceEntity = sourceSketch.entities.find((entity) => entity.id === handle.entityId);
  if (handle.kind === 'point' && sourceEntity.fixed) {
    fail('SKETCH_DRAG_HANDLE_FIXED', `Point "${handle.entityId}" is fixed and cannot be dragged.`, { entityId: handle.entityId });
  }
  if (handle.kind === 'point') {
    const state = (baseline.entityStates || []).find((entry) => entry.entityId === handle.entityId);
    if (!state?.underDefined) {
      fail('SKETCH_DRAG_HANDLE_FULLY_CONSTRAINED', `Point "${handle.entityId}" has no movable solver coordinate.`, { entityId: handle.entityId });
    }
  }
  if (handle.kind === 'radius' && sourceEntity.kind === 'circle' && typeof sourceEntity.r === 'string') {
    fail('SKETCH_DRAG_RADIUS_EXPRESSION', `Circle "${handle.entityId}" has an authored radius expression that drag cannot replace.`, { entityId: handle.entityId });
  }

  const component = extractConstraintComponent(sourceSketch, handle.entityId);
  const targetTolerance = DEFAULT_TARGET_TOLERANCE;
  const currentTarget = handle.kind === 'point'
    ? clone(baseline.entities.find((entity) => entity.id === handle.entityId).at)
    : radiusOf(handle, baseline.entities);
  if (handle.kind === 'radius') {
    if (!Number.isFinite(currentTarget)) {
      fail('SKETCH_DRAG_HANDLE_INVALID', `Radius handle "${handle.entityId}" has no finite solved radius.`, { entityId: handle.entityId });
    }
    if (!radiusHandleIsMovable(component.sketch, handle, currentTarget, effectiveSolveOptions, targetTolerance)) {
      fail('SKETCH_DRAG_HANDLE_FULLY_CONSTRAINED', `Radius "${handle.entityId}" has no movable solver degree of freedom.`, { entityId: handle.entityId });
    }
  }

  const frozenSource = deepFreeze(sourceSketch);
  const frozenComponent = deepFreeze(component.sketch);
  const frozenEntities = deepFreeze(clone(baseline.entities));
  const entityIndexById = Object.create(null);
  frozenEntities.forEach((entity, index) => { entityIndexById[entity.id] = index; });
  const componentEntityIndexes = component.entityIds.map((id) => entityIndexById[id]);
  const noAffectedEntities = deepFreeze([]);
  const session = {
    [SESSION_TAG]: true,
    schema: STUDIO_SKETCH_DRAG_SCHEMA,
    phase: 'begun',
    handle: deepFreeze(handle),
    currentTarget: deepFreeze(currentTarget),
    sourceSketch: frozenSource,
    sketch: frozenSource,
    mergedSketch: frozenSource,
    componentSketch: frozenComponent,
    componentCounts: deepFreeze(component.counts),
    componentEntityIds: deepFreeze([...component.entityIds]),
    componentEntityIndexes: deepFreeze(componentEntityIndexes),
    componentConstraintIndexes: deepFreeze([...component.constraintIndexes]),
    entityIndexById: deepFreeze(entityIndexById),
    constraintFingerprint: JSON.stringify(sourceSketch.constraints || []),
    solveOptions: Object.freeze({ ...effectiveSolveOptions }),
    targetTolerance,
    entities: frozenEntities,
    affectedIds: noAffectedEntities,
    affectedEntityIds: noAffectedEntities,
    affectedPointIds: deepFreeze([]),
    affectedRadiusIds: deepFreeze([]),
    solver: deepFreeze({
      status: baseline.status,
      iterations: baseline.iterations,
      residual: baseline.residual,
      equations: baseline.equations,
      rank: baseline.rank,
      dof: baseline.dof,
      diagnostics: clone(baseline.diagnostics || []),
      previewAnalysisSkipped: false,
    }),
  };
  return Object.freeze(session);
}

export function previewStudioSketchDrag(session, targetInput, options = {}) {
  assertSession(session);
  const target = normalizeTarget(session.handle, targetInput);
  const tolerance = Number.isFinite(options.targetTolerance) && options.targetTolerance > 0
    ? options.targetTolerance
    : session.targetTolerance;
  const solveOptions = interactionSolveOptions(session, options);
  const localResult = solveTransient(
    session.componentSketch,
    session.handle,
    target,
    solveOptions,
    tolerance,
    session.currentTarget,
  );
  const entities = mergeSolvedEntities(
    session.entities,
    localResult.entities,
    options.reuseFrozenBaselineEntities === true,
    session.entityIndexById,
  );
  const mergedSketch = mergeSolvedSketch(
    session.sourceSketch,
    session.entities,
    localResult.entities,
    tolerance,
    session.entityIndexById,
    session.componentEntityIds,
  );
  if (JSON.stringify(mergedSketch.constraints || []) !== session.constraintFingerprint) {
    fail('SKETCH_DRAG_CONSTRAINT_MUTATION', 'Sketch drag preview changed authored constraint bytes or order.');
  }
  return resultFor(session, 'preview', target, localResult, mergedSketch, entities, localResult);
}

export function settleStudioSketchDrag(session, targetInput, options = {}) {
  assertSession(session);
  const target = normalizeTarget(session.handle, targetInput);
  const tolerance = Number.isFinite(options.targetTolerance) && options.targetTolerance > 0
    ? options.targetTolerance
    : session.targetTolerance;
  const solveOptions = interactionSolveOptions(session, options);
  const localResult = solveTransient(
    session.componentSketch,
    session.handle,
    target,
    solveOptions,
    tolerance,
    session.currentTarget,
  );
  const reuseFrozenBaselineEntities = options.reuseFrozenBaselineEntities === true;
  const previewSketch = mergeSolvedSketch(
    session.sourceSketch,
    session.entities,
    localResult.entities,
    tolerance,
    session.entityIndexById,
    session.componentEntityIds,
  );
  const validated = solveSketch(previewSketch, solveOptions);
  const achieved = localResult.projection.achievedTarget;
  if (validated.status !== 'ok' || !targetReached(session.handle, validated.entities, achieved, tolerance)) {
    fail('SKETCH_DRAG_SETTLEMENT_FAILED', 'The drag preview did not remain valid after removing its transient driver.', {
      entityId: session.handle.entityId,
      handleKind: session.handle.kind,
      target: clone(target),
      achievedTarget: clone(achieved),
      status: validated.status,
      residual: validated.residual ?? null,
      diagnostics: clone(validated.diagnostics || []),
    });
  }
  const mergedSketch = mergeSolvedSketch(
    session.sourceSketch,
    session.entities,
    validated.entities,
    tolerance,
    session.entityIndexById,
    session.componentEntityIds,
  );
  if (JSON.stringify(mergedSketch.constraints || []) !== session.constraintFingerprint) {
    fail('SKETCH_DRAG_CONSTRAINT_MUTATION', 'Settled sketch drag changed authored constraint bytes or order.');
  }
  const entities = mergeSolvedEntities(
    session.entities,
    validated.entities,
    reuseFrozenBaselineEntities,
    session.entityIndexById,
  );
  return resultFor(session, 'settled', target, localResult, mergedSketch, entities, validated);
}
