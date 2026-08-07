// Constraint-based sketch solver for PartMode.
//
// This module is deliberately free of DOM, three.js, and OpenCascade
// dependencies so the sketch editor, the kernel worker, the agent service,
// and headless CI checks all solve through exactly the same code.
//
// Model
//   entities: [
//     { id, kind: 'point',  at: [x, y], fixed?: true }
//     { id, kind: 'line',   a: pointId, b: pointId, construction?: true }
//     { id, kind: 'circle', center: pointId, r: number|string, construction?: true }
//     { id, kind: 'arc',    center: pointId, a: pointId, b: pointId, ccw?: boolean }
//   ]
//   constraints: [
//     { id?, kind: 'coincident',    a: pointId, b: pointId }
//     { id?, kind: 'horizontal',    line: lineId }            (or { a, b } point pair)
//     { id?, kind: 'vertical',      line: lineId }            (or { a, b } point pair)
//     { id?, kind: 'parallel',      a: lineId, b: lineId }
//     { id?, kind: 'perpendicular', a: lineId, b: lineId }
//     { id?, kind: 'tangent',       a: lineId|circleId|arcId, b: circleId|arcId }
//     { id?, kind: 'equal',         a: lineId|circleId|arcId, b: lineId|circleId|arcId }
//     { id?, kind: 'concentric',    a: circleId|arcId, b: circleId|arcId }
//     { id?, kind: 'midpoint',      point: pointId, line: lineId }
//     { id?, kind: 'pointOnLine',   point: pointId, line: lineId }
//     { id?, kind: 'pointOnCircle', point: pointId, circle: circleId|arcId }
//     { id?, kind: 'pierce',        point: pointId, curveSketchId, planeDatumId }
//     { id?, kind: 'symmetric',     a: pointId, b: pointId, axis: lineId }
//     { id?, kind: 'distance',           a: pointId, b: pointId, value: dim }
//     { id?, kind: 'horizontalDistance', a: pointId, b: pointId, value: dim }   (signed b-a)
//     { id?, kind: 'verticalDistance',   a: pointId, b: pointId, value: dim }   (signed b-a)
//     { id?, kind: 'length',        line: lineId, value: dim }
//     { id?, kind: 'radius',        circle: circleId|arcId, value: dim }
//     { id?, kind: 'angle',         a: lineId, b: lineId, value: dim }  (degrees, a->b ccw)
//   ]
//   Any dimensional constraint may instead carry { driving: false } and
//   omit value. It is then a measured reference dimension: the solver ignores
//   it as an equation and measureSketchDimension reads the solved geometry.
//   A dim is a finite number or an expression string; expression strings are
//   resolved through options.resolveDimension so the caller supplies the same
//   parameter evaluator the rest of the document uses.
//
// Solving is damped least squares (Levenberg-Marquardt) over the free point
// coordinates and circle radii. Under-constrained sketches stay near their
// current positions via a weak prior; they do not jump. Degrees of freedom
// are reported from the rank of the hard-constraint Jacobian.

const SOLVER_DEFAULTS = Object.freeze({
  tolerance: 1e-9,
  maxIterations: 150,
  rankTolerance: 1e-7,
});

// Diagnostics deliberately stop before analysis cost can grow with an
// industrial-size sketch.  The solver still returns its normal residual
// diagnostics when one of these limits is reached.
const CONSTRAINT_DIAGNOSTIC_LIMITS = Object.freeze({
  maxComponents: 16,
  maxConstraintsPerComponent: 32,
  maxConflictSets: 4,
  maxOracleSolves: 96,
  maxRankTests: 512,
});

const POINT_KINDS = new Set(['point']);
const CURVE_KINDS = new Set(['line', 'circle', 'arc']);
const ENTITY_KINDS = new Set(['point', 'line', 'circle', 'arc', 'spline']);

const CONSTRAINT_ARITY = Object.freeze({
  coincident: ['a', 'b'],
  horizontal: [],
  vertical: [],
  parallel: ['a', 'b'],
  perpendicular: ['a', 'b'],
  tangent: ['a', 'b'],
  equal: ['a', 'b'],
  concentric: ['a', 'b'],
  midpoint: ['point', 'line'],
  pointOnLine: ['point', 'line'],
  pointOnCircle: ['point', 'circle'],
  pierce: ['point'],
  symmetric: ['a', 'b', 'axis'],
  distance: ['a', 'b'],
  horizontalDistance: ['a', 'b'],
  verticalDistance: ['a', 'b'],
  length: ['line'],
  radius: ['circle'],
  angle: ['a', 'b'],
});

const DIMENSIONAL_KINDS = new Set([
  'distance', 'horizontalDistance', 'verticalDistance', 'length', 'radius', 'angle',
]);

export const SKETCH_CONSTRAINT_KINDS = Object.freeze(Object.keys(CONSTRAINT_ARITY));
export const SKETCH_ENTITY_KINDS = Object.freeze([...ENTITY_KINDS]);

class SketchSolveError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

function defaultResolveDimension(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new SketchSolveError('DIMENSION_UNRESOLVED', 'Dimension "' + value + '" is not a number and no expression resolver was provided.');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableDiagnosticValue(value) {
  if (Array.isArray(value)) return '[' + value.map(stableDiagnosticValue).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort(compareText).map((key) => JSON.stringify(key) + ':' + stableDiagnosticValue(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sketchConstraintEntries(sketch) {
  return (sketch.constraints || []).map((constraint, index) => {
    const hasExplicitId = typeof constraint?.id === 'string' && constraint.id.length > 0;
    const diagnosticId = hasExplicitId ? constraint.id : (constraint?.kind || 'constraint') + '#' + index;
    const fingerprint = stableDiagnosticValue(constraint);
    return {
      constraint,
      index,
      diagnosticId,
      hasExplicitId,
      sortKey: (hasExplicitId ? '0:' : '1:') + diagnosticId + '\u0000' + fingerprint + '\u0000' + index,
    };
  }).filter((entry) => entry.constraint?.driving !== false);
}

function sortedUniqueConstraintIds(entries) {
  return [...new Set(entries.map((entry) => entry.diagnosticId))].sort(compareText);
}

function coincidencePathEntries(entries, startPointId, endPointId) {
  if (startPointId === endPointId) return [];
  const adjacency = new Map();
  const connect = (from, to, entry) => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push({ pointId: to, entry });
  };
  for (const entry of entries) {
    if (entry.constraint?.kind !== 'coincident') continue;
    connect(entry.constraint.a, entry.constraint.b, entry);
    connect(entry.constraint.b, entry.constraint.a, entry);
  }
  for (const edges of adjacency.values()) {
    edges.sort((left, right) => compareText(left.entry.sortKey, right.entry.sortKey) || compareText(left.pointId, right.pointId));
  }
  const queue = [startPointId];
  const previous = new Map([[startPointId, null]]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const pointId = queue[cursor];
    for (const edge of adjacency.get(pointId) || []) {
      if (previous.has(edge.pointId)) continue;
      previous.set(edge.pointId, { pointId, entry: edge.entry });
      if (edge.pointId === endPointId) {
        const path = [];
        let step = endPointId;
        while (step !== startPointId) {
          const link = previous.get(step);
          if (!link) return [];
          path.push(link.entry);
          step = link.pointId;
        }
        return path.reverse();
      }
      queue.push(edge.pointId);
    }
  }
  return [];
}

// --- structural validation -------------------------------------------------

export function validateConstraintSketch(sketch) {
  const diagnostics = [];
  const fail = (code, message, meta) => diagnostics.push({ code, severity: 'error', message, ...(meta || {}) });
  if (!sketch || typeof sketch !== 'object') {
    fail('SKETCH_INVALID', 'Sketch must be an object.');
    return diagnostics;
  }
  const entities = Array.isArray(sketch.entities) ? sketch.entities : [];
  const constraints = Array.isArray(sketch.constraints) ? sketch.constraints : [];
  const byId = new Map();
  for (const entity of entities) {
    if (!entity || typeof entity !== 'object') { fail('ENTITY_INVALID', 'Entity must be an object.'); continue; }
    if (typeof entity.id !== 'string' || !entity.id) { fail('ENTITY_ID_INVALID', 'Entity id must be a non-empty string.'); continue; }
    if (byId.has(entity.id)) { fail('ENTITY_ID_DUPLICATE', 'Duplicate entity id "' + entity.id + '".', { entityId: entity.id }); continue; }
    if (!ENTITY_KINDS.has(entity.kind)) { fail('ENTITY_KIND_UNKNOWN', 'Unknown entity kind "' + entity.kind + '".', { entityId: entity.id }); continue; }
    byId.set(entity.id, entity);
  }
  const requireRef = (constraintOrEntity, field, kinds, label) => {
    const ref = constraintOrEntity[field];
    const target = byId.get(ref);
    if (typeof ref !== 'string' || !target) {
      fail('REF_MISSING', label + '.' + field + ' must reference an existing entity.', { ref });
      return null;
    }
    if (kinds && !kinds.has(target.kind)) {
      fail('REF_KIND', label + '.' + field + ' references a ' + target.kind + '; expected ' + [...kinds].join('|') + '.', { ref });
      return null;
    }
    return target;
  };
  for (const entity of entities) {
    if (!byId.has(entity.id) || byId.get(entity.id) !== entity) continue;
    const label = 'entity "' + entity.id + '"';
    if (entity.kind === 'point') {
      const at = entity.at;
      if (!Array.isArray(at) || at.length !== 2 || !at.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        fail('POINT_AT_INVALID', label + ' needs at: [x, y] with finite numbers.', { entityId: entity.id });
      }
    } else if (entity.kind === 'line') {
      requireRef(entity, 'a', POINT_KINDS, label);
      requireRef(entity, 'b', POINT_KINDS, label);
      if (entity.a === entity.b) fail('LINE_DEGENERATE', label + ' endpoints must be distinct points.', { entityId: entity.id });
    } else if (entity.kind === 'circle') {
      requireRef(entity, 'center', POINT_KINDS, label);
      if (!(typeof entity.r === 'number' && Number.isFinite(entity.r) && entity.r > 0) && typeof entity.r !== 'string') {
        fail('CIRCLE_RADIUS_INVALID', label + ' needs r as a positive number or expression string.', { entityId: entity.id });
      }
    } else if (entity.kind === 'arc') {
      requireRef(entity, 'center', POINT_KINDS, label);
      requireRef(entity, 'a', POINT_KINDS, label);
      requireRef(entity, 'b', POINT_KINDS, label);
      if (entity.a === entity.b) fail('ARC_DEGENERATE', label + ' endpoints must be distinct points.', { entityId: entity.id });
    } else if (entity.kind === 'spline') {
      const through = entity.through;
      if (!Array.isArray(through) || through.length < 2) {
        fail('SPLINE_THROUGH_INVALID', label + ' needs through: [pointId, ...] with at least two points.', { entityId: entity.id });
      } else {
        for (let index = 0; index < through.length; index++) {
          requireRef({ ref: through[index] }, 'ref', POINT_KINDS, label + '.through[' + index + ']');
          // A closed spline repeats its first point at the end; consecutive
          // repeats are degenerate.
          if (index > 0 && through[index] === through[index - 1]) {
            fail('SPLINE_DEGENERATE', label + ' repeats point "' + through[index] + '" consecutively.', { entityId: entity.id });
          }
        }
      }
    }
  }
  const LINE_ONLY = new Set(['line']);
  const ROUND_KINDS = new Set(['circle', 'arc']);
  const TANGENT_A = new Set(['line', 'circle', 'arc']);
  const EQUAL_KINDS = new Set(['line', 'circle', 'arc']);
  const constraintIds = new Set();
  constraints.forEach((constraint, index) => {
    if (!constraint || typeof constraint !== 'object') { fail('CONSTRAINT_INVALID', 'Constraint #' + index + ' must be an object.'); return; }
    if (constraint.id !== undefined) {
      if (typeof constraint.id !== 'string' || constraint.id.length === 0) {
        fail('CONSTRAINT_ID_INVALID', 'Constraint #' + index + ' id must be a non-empty string when provided.', { constraintIndex: index });
      } else if (constraintIds.has(constraint.id)) {
        fail('CONSTRAINT_ID_DUPLICATE', 'Duplicate constraint id "' + constraint.id + '".', { constraintId: constraint.id, constraintIndex: index });
      } else {
        constraintIds.add(constraint.id);
      }
    }
    const kind = constraint.kind;
    if (!CONSTRAINT_ARITY[kind]) { fail('CONSTRAINT_KIND_UNKNOWN', 'Unknown constraint kind "' + kind + '".', { constraintIndex: index }); return; }
    if (constraint.driving !== undefined && typeof constraint.driving !== 'boolean') {
      fail('CONSTRAINT_DRIVING_INVALID', 'Constraint driving must be boolean when provided.', { constraintIndex: index });
    }
    if (constraint.driving === false && !DIMENSIONAL_KINDS.has(kind)) {
      fail('REFERENCE_CONSTRAINT_NON_DIMENSIONAL', 'Only dimensional constraints can be reference dimensions.', { constraintIndex: index });
    }
    const label = 'constraint "' + (constraint.id || kind + '#' + index) + '"';
    const need = (field, kinds) => requireRef(constraint, field, kinds, label);
    if (kind === 'coincident' || kind === 'distance' || kind === 'horizontalDistance' || kind === 'verticalDistance') {
      need('a', POINT_KINDS); need('b', POINT_KINDS);
    } else if (kind === 'horizontal' || kind === 'vertical') {
      if (typeof constraint.line === 'string') need('line', LINE_ONLY);
      else { need('a', POINT_KINDS); need('b', POINT_KINDS); }
    } else if (kind === 'parallel' || kind === 'perpendicular' || kind === 'angle') {
      need('a', LINE_ONLY); need('b', LINE_ONLY);
    } else if (kind === 'tangent') {
      need('a', TANGENT_A); need('b', ROUND_KINDS);
    } else if (kind === 'equal') {
      const a = need('a', EQUAL_KINDS); const b = need('b', EQUAL_KINDS);
      if (a && b) {
        const aRound = ROUND_KINDS.has(a.kind); const bRound = ROUND_KINDS.has(b.kind);
        if (aRound !== bRound) fail('EQUAL_MIXED', label + ' cannot equate a length with a radius.', { constraintIndex: index });
      }
    } else if (kind === 'concentric') {
      need('a', ROUND_KINDS); need('b', ROUND_KINDS);
    } else if (kind === 'midpoint' || kind === 'pointOnLine') {
      need('point', POINT_KINDS); need('line', LINE_ONLY);
    } else if (kind === 'pointOnCircle') {
      need('point', POINT_KINDS); need('circle', ROUND_KINDS);
    } else if (kind === 'pierce') {
      need('point', POINT_KINDS);
      if (typeof constraint.curveSketchId !== 'string' || !constraint.curveSketchId) {
        fail('PIERCE_CURVE_REFERENCE_INVALID', label + '.curveSketchId must be a persistent path sketch id.', { constraintIndex: index });
      }
      if (typeof constraint.planeDatumId !== 'string' || !constraint.planeDatumId) {
        fail('PIERCE_PLANE_REFERENCE_INVALID', label + '.planeDatumId must be a persistent plane datum id.', { constraintIndex: index });
      }
    } else if (kind === 'symmetric') {
      need('a', POINT_KINDS); need('b', POINT_KINDS); need('axis', LINE_ONLY);
    } else if (kind === 'length') {
      need('line', LINE_ONLY);
    } else if (kind === 'radius') {
      need('circle', ROUND_KINDS);
    }
    if (DIMENSIONAL_KINDS.has(kind)) {
      const value = constraint.value;
      const numeric = typeof value === 'number' && Number.isFinite(value);
      const expression = typeof value === 'string' && value.length > 0;
      if (constraint.driving === false) {
        if (value !== undefined) fail('REFERENCE_DIMENSION_VALUE', label + ' is measured and must not store a driving value.', { constraintIndex: index });
      } else if (!numeric && !expression) {
        fail('DIMENSION_INVALID', label + ' needs value as a finite number or expression string.', { constraintIndex: index });
      }
    }
  });
  return diagnostics;
}

// --- solve state -----------------------------------------------------------

function buildSystem(sketch, options) {
  const resolve = options.resolveDimension || defaultResolveDimension;
  const entities = sketch.entities || [];
  const constraints = sketch.constraints || [];
  const byId = new Map(entities.map((entity) => [entity.id, entity]));

  // Union coincident points so shared corners solve as one node. This keeps
  // the system small and makes loop extraction exact instead of tolerance-based.
  const parent = new Map();
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root);
    let cursor = id;
    while (cursor !== root) { const next = parent.get(cursor); parent.set(cursor, root); cursor = next; }
    return root;
  };
  for (const entity of entities) if (entity.kind === 'point') parent.set(entity.id, entity.id);
  const mergedConstraints = [];
  for (const constraint of constraints) {
    if (constraint.driving === false) continue;
    if (constraint.kind === 'coincident') {
      const ra = find(constraint.a); const rb = find(constraint.b);
      if (ra !== rb) parent.set(ra, rb);
      continue; // handled structurally, not as a residual
    }
    mergedConstraints.push(constraint);
  }

  // Diagnose incompatible fixed points before choosing a representative for
  // the coincident cluster.  Entity ordering therefore cannot decide which
  // fixed point is reported, and the diagnostic carries the exact shortest
  // coincidence path that creates the conflict.
  const fixedByCluster = new Map();
  for (const entity of entities) {
    if (entity.kind !== 'point' || !entity.fixed) continue;
    const root = find(entity.id);
    if (!fixedByCluster.has(root)) fixedByCluster.set(root, []);
    fixedByCluster.get(root).push(entity);
  }
  const constraintEntries = sketchConstraintEntries(sketch);
  const fixedGroups = [...fixedByCluster.values()]
    .map((fixedPoints) => fixedPoints.sort((left, right) => compareText(left.id, right.id)))
    .sort((left, right) => compareText(left[0].id, right[0].id));
  for (const fixedPoints of fixedGroups) {
    for (let leftIndex = 0; leftIndex < fixedPoints.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < fixedPoints.length; rightIndex++) {
        const left = fixedPoints[leftIndex];
        const right = fixedPoints[rightIndex];
        const separation = Math.hypot(right.at[0] - left.at[0], right.at[1] - left.at[1]);
        if (separation <= options.tolerance) continue;
        const path = coincidencePathEntries(constraintEntries, left.id, right.id);
        throw new SketchSolveError(
          'FIXED_COINCIDENT_CONFLICT',
          'Fixed points "' + left.id + '" and "' + right.id + '" cannot be coincident because their positions differ.',
          {
            entityIds: [left.id, right.id],
            separation,
            constraintIds: sortedUniqueConstraintIds(path),
            conflictSetMinimal: true,
          },
        );
      }
    }
  }

  // Free parameters: one (x, y) pair per point cluster root (unless a fixed
  // point is in the cluster), plus one radius per circle.
  const clusterOf = (pointId) => find(pointId);
  const clusters = new Map(); // root -> {x, y, fixed, fixedEntityId, index|-1}
  // Cluster initialization is semantic, not document-order based. The lowest
  // stable point id supplies an unconstrained cluster's initial value, and the
  // lowest stable fixed-point id supplies a within-tolerance fixed anchor.
  // Reordering entities or coincidence constraints must therefore produce the
  // same exact solution bytes.
  const orderedPoints = entities
    .filter((entity) => entity.kind === 'point')
    .sort((left, right) => compareText(left.id, right.id));
  const canonicalFixedByCluster = new Map(
    [...fixedByCluster.entries()].map(([root, fixedPoints]) => [
      root,
      [...fixedPoints].sort((left, right) => compareText(left.id, right.id))[0],
    ]),
  );
  for (const entity of orderedPoints) {
    if (entity.kind !== 'point') continue;
    const root = clusterOf(entity.id);
    let cluster = clusters.get(root);
    if (!cluster) {
      const fixedAnchor = canonicalFixedByCluster.get(root);
      cluster = {
        x: fixedAnchor?.at[0] ?? entity.at[0],
        y: fixedAnchor?.at[1] ?? entity.at[1],
        fixed: Boolean(fixedAnchor),
        fixedEntityId: fixedAnchor?.id || null,
        index: -1,
      };
      clusters.set(root, cluster);
    }
  }
  const params = [];
  for (const cluster of clusters.values()) {
    if (cluster.fixed) continue;
    cluster.index = params.length;
    params.push(cluster.x, cluster.y);
  }
  const radii = new Map(); // circleId -> {index, value}
  for (const entity of entities) {
    if (entity.kind !== 'circle') continue;
    const value = resolve(entity.r);
    if (!(value > 0)) throw new SketchSolveError('CIRCLE_RADIUS_INVALID', 'Circle "' + entity.id + '" radius must resolve positive.', { entityId: entity.id });
    radii.set(entity.id, { index: params.length, value });
    params.push(value);
  }

  const px = (x, pointId) => { const c = clusters.get(clusterOf(pointId)); return c.fixed ? c.x : x[c.index]; };
  const py = (x, pointId) => { const c = clusters.get(clusterOf(pointId)); return c.fixed ? c.y : x[c.index + 1]; };
  const rOf = (x, circleId) => x[radii.get(circleId).index];

  // Radius accessor that works for circles (parameter) and arcs (derived).
  const roundRadius = (x, entity) => entity.kind === 'circle'
    ? rOf(x, entity.id)
    : Math.hypot(px(x, entity.a) - px(x, entity.center), py(x, entity.a) - py(x, entity.center));

  const residuals = []; // {constraint, eval(x, out)} pushing 1..2 values
  const pushResidual = (constraint, count, evaluate) => residuals.push({ constraint, count, evaluate });

  // Arcs stay circular: |center-a| === |center-b|.
  for (const entity of entities) {
    if (entity.kind !== 'arc') continue;
    if (options.skipArcInternalIds?.has(entity.id)) continue;
    pushResidual({ kind: 'arc-internal', id: entity.id }, 1, (x, out) => {
      const cx = px(x, entity.center), cy = py(x, entity.center);
      out.push(Math.hypot(px(x, entity.a) - cx, py(x, entity.a) - cy)
             - Math.hypot(px(x, entity.b) - cx, py(x, entity.b) - cy));
    });
  }

  const lineOf = (id) => byId.get(id);
  const dir = (x, line) => [px(x, line.b) - px(x, line.a), py(x, line.b) - py(x, line.a)];
  const norm = (v) => Math.hypot(v[0], v[1]) || 1e-12;

  for (const constraint of mergedConstraints) {
    const kind = constraint.kind;
    if (kind === 'horizontal' || kind === 'vertical') {
      const pair = typeof constraint.line === 'string'
        ? { a: lineOf(constraint.line).a, b: lineOf(constraint.line).b }
        : { a: constraint.a, b: constraint.b };
      pushResidual(constraint, 1, (x, out) => {
        out.push(kind === 'horizontal' ? py(x, pair.b) - py(x, pair.a) : px(x, pair.b) - px(x, pair.a));
      });
    } else if (kind === 'parallel' || kind === 'perpendicular') {
      const la = lineOf(constraint.a), lb = lineOf(constraint.b);
      pushResidual(constraint, 1, (x, out) => {
        const d1 = dir(x, la), d2 = dir(x, lb);
        const scale = norm(d1) * norm(d2);
        out.push(kind === 'parallel'
          ? (d1[0] * d2[1] - d1[1] * d2[0]) / scale
          : (d1[0] * d2[0] + d1[1] * d2[1]) / scale);
      });
    } else if (kind === 'tangent') {
      const a = byId.get(constraint.a), b = byId.get(constraint.b);
      const x0 = Float64Array.from(params);
      if (a.kind === 'line') {
        // Which side the circle sits on is decided by the input configuration,
        // so solving is deterministic and the circle never flips across.
        const d0 = dir(x0, a);
        const signed0 = (d0[0] * (py(x0, b.center) - py(x0, a.a)) - d0[1] * (px(x0, b.center) - px(x0, a.a))) / norm(d0);
        const sign = signed0 >= 0 ? 1 : -1;
        pushResidual(constraint, 1, (x, out) => {
          const d = dir(x, a);
          const cxv = px(x, b.center) - px(x, a.a);
          const cyv = py(x, b.center) - py(x, a.a);
          out.push((d[0] * cyv - d[1] * cxv) / norm(d) - sign * roundRadius(x, b));
        });
      } else {
        const gap0 = Math.hypot(px(x0, b.center) - px(x0, a.center), py(x0, b.center) - py(x0, a.center));
        const ra0 = roundRadius(x0, a), rb0 = roundRadius(x0, b);
        const mode = Math.abs(gap0 - (ra0 + rb0)) <= Math.abs(gap0 - Math.abs(ra0 - rb0)) ? 'external' : 'internal';
        pushResidual(constraint, 1, (x, out) => {
          const gap = Math.hypot(px(x, b.center) - px(x, a.center), py(x, b.center) - py(x, a.center));
          const ra = roundRadius(x, a), rb = roundRadius(x, b);
          out.push(gap - (mode === 'external' ? ra + rb : Math.abs(ra - rb)));
        });
      }
    } else if (kind === 'equal') {
      const a = byId.get(constraint.a), b = byId.get(constraint.b);
      if (a.kind === 'line') {
        pushResidual(constraint, 1, (x, out) => {
          const d1 = dir(x, a), d2 = dir(x, b);
          out.push((d1[0] * d1[0] + d1[1] * d1[1]) - (d2[0] * d2[0] + d2[1] * d2[1]));
        });
      } else {
        pushResidual(constraint, 1, (x, out) => out.push(roundRadius(x, a) - roundRadius(x, b)));
      }
    } else if (kind === 'concentric') {
      const a = byId.get(constraint.a), b = byId.get(constraint.b);
      pushResidual(constraint, 2, (x, out) => {
        out.push(px(x, a.center) - px(x, b.center), py(x, a.center) - py(x, b.center));
      });
    } else if (kind === 'midpoint') {
      const line = lineOf(constraint.line);
      pushResidual(constraint, 2, (x, out) => {
        out.push(px(x, constraint.point) - (px(x, line.a) + px(x, line.b)) / 2,
                 py(x, constraint.point) - (py(x, line.a) + py(x, line.b)) / 2);
      });
    } else if (kind === 'pointOnLine') {
      const line = lineOf(constraint.line);
      pushResidual(constraint, 1, (x, out) => {
        const d = dir(x, line);
        out.push((d[0] * (py(x, constraint.point) - py(x, line.a))
                - d[1] * (px(x, constraint.point) - px(x, line.a))) / norm(d));
      });
    } else if (kind === 'pointOnCircle') {
      const circle = byId.get(constraint.circle);
      pushResidual(constraint, 1, (x, out) => {
        out.push(Math.hypot(px(x, constraint.point) - px(x, circle.center),
                            py(x, constraint.point) - py(x, circle.center)) - roundRadius(x, circle));
      });
    } else if (kind === 'pierce') {
      if (typeof options.resolvePierce !== 'function') {
        throw new SketchSolveError('PIERCE_RESOLVER_REQUIRED', 'Pierce requires a document-aware reference-curve resolver.', { constraintId: constraint.id || null });
      }
      const target = options.resolvePierce(constraint);
      if (!Array.isArray(target) || target.length !== 2 || target.some((entry) => !Number.isFinite(entry))) {
        throw new SketchSolveError('PIERCE_TARGET_INVALID', 'Pierce resolver must return one finite sketch-plane point.', { constraintId: constraint.id || null });
      }
      pushResidual(constraint, 2, (x, out) => {
        out.push(px(x, constraint.point) - target[0], py(x, constraint.point) - target[1]);
      });
    } else if (kind === 'symmetric') {
      const axis = lineOf(constraint.axis);
      pushResidual(constraint, 2, (x, out) => {
        const ax = px(x, axis.a), ay = py(x, axis.a);
        const d = dir(x, axis); const len = norm(d);
        const ux = d[0] / len, uy = d[1] / len;
        const rel = [px(x, constraint.a) - ax, py(x, constraint.a) - ay];
        const along = rel[0] * ux + rel[1] * uy;
        const across = rel[0] * -uy + rel[1] * ux;
        const mx = ax + along * ux - across * -uy;
        const my = ay + along * uy - across * ux;
        out.push(mx - px(x, constraint.b), my - py(x, constraint.b));
      });
    } else if (kind === 'distance') {
      const value = resolve(constraint.value);
      pushResidual(constraint, 1, (x, out) => {
        out.push(Math.hypot(px(x, constraint.b) - px(x, constraint.a), py(x, constraint.b) - py(x, constraint.a)) - value);
      });
    } else if (kind === 'horizontalDistance') {
      const value = resolve(constraint.value);
      pushResidual(constraint, 1, (x, out) => out.push(px(x, constraint.b) - px(x, constraint.a) - value));
    } else if (kind === 'verticalDistance') {
      const value = resolve(constraint.value);
      pushResidual(constraint, 1, (x, out) => out.push(py(x, constraint.b) - py(x, constraint.a) - value));
    } else if (kind === 'length') {
      const line = lineOf(constraint.line);
      const value = resolve(constraint.value);
      pushResidual(constraint, 1, (x, out) => {
        const d = dir(x, line);
        out.push(Math.hypot(d[0], d[1]) - value);
      });
    } else if (kind === 'radius') {
      const circle = byId.get(constraint.circle);
      const value = resolve(constraint.value);
      pushResidual(constraint, 1, (x, out) => out.push(roundRadius(x, circle) - value));
    } else if (kind === 'angle') {
      const la = lineOf(constraint.a), lb = lineOf(constraint.b);
      const target = (resolve(constraint.value) * Math.PI) / 180;
      pushResidual(constraint, 1, (x, out) => {
        const d1 = dir(x, la), d2 = dir(x, lb);
        let delta = Math.atan2(d2[1], d2[0]) - Math.atan2(d1[1], d1[0]) - target;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta <= -Math.PI) delta += 2 * Math.PI;
        out.push(delta);
      });
    }
  }

  return { params, residuals, clusters, clusterOf, radii, px, py, byId, entities };
}

function evaluateResiduals(system, x) {
  const values = [];
  const spans = [];
  for (const residual of system.residuals) {
    const start = values.length;
    residual.evaluate(x, values);
    spans.push({ residual, start, end: values.length });
  }
  return { values, spans };
}

function numericJacobian(system, x, baseValues) {
  const n = x.length;
  const m = baseValues.length;
  const jacobian = new Array(m);
  for (let row = 0; row < m; row++) jacobian[row] = new Float64Array(n);
  const probe = x.slice();
  for (let col = 0; col < n; col++) {
    const h = 1e-7 * Math.max(1, Math.abs(x[col]));
    probe[col] = x[col] + h;
    const shifted = evaluateResiduals(system, probe).values;
    probe[col] = x[col];
    for (let row = 0; row < m; row++) jacobian[row][col] = (shifted[row] - baseValues[row]) / h;
  }
  return jacobian;
}

function solveNormalEquations(jtj, rhs) {
  // Cholesky with diagonal jitter fallback; deterministic.
  const n = rhs.length;
  const a = jtj.map((row) => row.slice());
  const b = rhs.slice();
  for (let attempt = 0; attempt < 4; attempt++) {
    const chol = a.map((row) => row.slice());
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = chol[i][j];
        for (let k = 0; k < j; k++) sum -= chol[i][k] * chol[j][k];
        if (i === j) {
          if (sum <= 0) { ok = false; break; }
          chol[i][i] = Math.sqrt(sum);
        } else {
          chol[i][j] = sum / chol[j][j];
        }
      }
    }
    if (ok) {
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let sum = b[i];
        for (let k = 0; k < i; k++) sum -= chol[i][k] * y[k];
        y[i] = sum / chol[i][i];
      }
      const out = new Float64Array(n);
      for (let i = n - 1; i >= 0; i--) {
        let sum = y[i];
        for (let k = i + 1; k < n; k++) sum -= chol[k][i] * out[k];
        out[i] = sum / chol[i][i];
      }
      return out;
    }
    for (let i = 0; i < n; i++) a[i][i] += 1e-10 * Math.pow(10, attempt);
  }
  return null;
}

function jacobianRank(jacobian, tolerance) {
  if (!jacobian.length) return 0;
  const rows = jacobian.map((row) => Array.from(row));
  const cols = rows[0].length;
  let rank = 0;
  let pivotRow = 0;
  for (let col = 0; col < cols && pivotRow < rows.length; col++) {
    let best = pivotRow;
    for (let row = pivotRow + 1; row < rows.length; row++) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[best][col])) best = row;
    }
    if (Math.abs(rows[best][col]) <= tolerance) continue;
    [rows[pivotRow], rows[best]] = [rows[best], rows[pivotRow]];
    const pivot = rows[pivotRow][col];
    for (let row = pivotRow + 1; row < rows.length; row++) {
      const factor = rows[row][col] / pivot;
      if (factor === 0) continue;
      for (let k = col; k < cols; k++) rows[row][k] -= factor * rows[pivotRow][k];
    }
    pivotRow++;
    rank++;
  }
  return rank;
}

// Identify which scalar parameters can move in the local null space of the
// hard-constraint Jacobian. A pivot is not automatically fixed: in x - y = 0,
// both x and y can still translate together. Reducing all pivot rows exposes
// that dependency without running one additional rank solve per parameter.
function jacobianParameterMobility(jacobian, parameterCount, tolerance) {
  if (parameterCount === 0) return [];
  if (!jacobian.length) return Array(parameterCount).fill(true);
  const rows = jacobian.map((row) => Array.from(row));
  const pivots = [];
  let pivotRow = 0;
  for (let col = 0; col < parameterCount && pivotRow < rows.length; col++) {
    let best = pivotRow;
    for (let row = pivotRow + 1; row < rows.length; row++) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[best][col])) best = row;
    }
    if (Math.abs(rows[best][col]) <= tolerance) continue;
    [rows[pivotRow], rows[best]] = [rows[best], rows[pivotRow]];
    const pivot = rows[pivotRow][col];
    for (let index = col; index < parameterCount; index++) rows[pivotRow][index] /= pivot;
    for (let row = 0; row < rows.length; row++) {
      if (row === pivotRow) continue;
      const factor = rows[row][col];
      if (Math.abs(factor) <= tolerance) continue;
      for (let index = col; index < parameterCount; index++) rows[row][index] -= factor * rows[pivotRow][index];
    }
    pivots.push({ col, row: pivotRow });
    pivotRow++;
  }
  const pivotColumns = new Set(pivots.map((pivot) => pivot.col));
  const freeColumns = Array.from({ length: parameterCount }, (_, index) => index)
    .filter((index) => !pivotColumns.has(index));
  const movable = Array(parameterCount).fill(false);
  for (const col of freeColumns) movable[col] = true;
  for (const pivot of pivots) {
    movable[pivot.col] = freeColumns.some((freeCol) => Math.abs(rows[pivot.row][freeCol]) > tolerance);
  }
  return movable;
}

function entityParameterIndexes(entity, system) {
  const indexes = new Set();
  const addPoint = (pointId) => {
    const cluster = system.clusters.get(system.clusterOf(pointId));
    if (!cluster || cluster.fixed) return;
    indexes.add(cluster.index);
    indexes.add(cluster.index + 1);
  };
  if (entity.kind === 'point') addPoint(entity.id);
  else if (entity.kind === 'line') {
    addPoint(entity.a);
    addPoint(entity.b);
  } else if (entity.kind === 'circle') {
    addPoint(entity.center);
    const radius = system.radii.get(entity.id);
    if (radius) indexes.add(radius.index);
  } else if (entity.kind === 'arc') {
    addPoint(entity.center);
    addPoint(entity.a);
    addPoint(entity.b);
  } else if (entity.kind === 'spline') {
    for (const pointId of entity.through || []) addPoint(pointId);
  }
  return [...indexes].sort((left, right) => left - right);
}

function collectEntityInfluenceKeys(entityId, byId, keys, visiting = new Set()) {
  if (typeof entityId !== 'string' || visiting.has(entityId)) return;
  const entity = byId.get(entityId);
  if (!entity) return;
  visiting.add(entityId);
  keys.add('entity:' + entityId);
  if (entity.kind === 'point') {
    keys.add('point:' + entityId);
  } else if (entity.kind === 'line') {
    collectEntityInfluenceKeys(entity.a, byId, keys, visiting);
    collectEntityInfluenceKeys(entity.b, byId, keys, visiting);
  } else if (entity.kind === 'circle') {
    collectEntityInfluenceKeys(entity.center, byId, keys, visiting);
    keys.add('radius:' + entityId);
  } else if (entity.kind === 'arc') {
    collectEntityInfluenceKeys(entity.center, byId, keys, visiting);
    collectEntityInfluenceKeys(entity.a, byId, keys, visiting);
    collectEntityInfluenceKeys(entity.b, byId, keys, visiting);
  } else if (entity.kind === 'spline') {
    for (const pointId of entity.through || []) collectEntityInfluenceKeys(pointId, byId, keys, visiting);
  }
  visiting.delete(entityId);
}

function constraintInfluenceKeys(constraint, byId) {
  const keys = new Set();
  for (const field of ['a', 'b', 'line', 'point', 'circle', 'axis']) {
    collectEntityInfluenceKeys(constraint?.[field], byId, keys);
  }
  if (constraint?.kind === 'pierce') {
    keys.add('pierce-curve:' + String(constraint.curveSketchId || 'missing'));
    keys.add('pierce-plane:' + String(constraint.planeDatumId || 'missing'));
  }
  // A valid constraint always references geometry.  This key keeps malformed
  // or future zero-reference constraints isolated instead of joining them by
  // accident.
  if (!keys.size) keys.add('constraint-kind:' + (constraint?.kind || 'unknown'));
  return keys;
}

function constraintComponents(sketch, providedEntries = null) {
  const entries = providedEntries || sketchConstraintEntries(sketch);
  if (!entries.length) return [];
  const byId = new Map((sketch.entities || []).map((entity) => [entity.id, entity]));
  const parent = entries.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (index !== root) { const next = parent[index]; parent[index] = root; index = next; }
    return root;
  };
  const unite = (left, right) => {
    const leftRoot = find(left); const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) parent[rightRoot] = leftRoot;
    else parent[leftRoot] = rightRoot;
  };
  const ownerByKey = new Map();
  entries.forEach((entry, index) => {
    for (const key of constraintInfluenceKeys(entry.constraint, byId)) {
      if (ownerByKey.has(key)) unite(index, ownerByKey.get(key));
      else ownerByKey.set(key, index);
    }
  });
  const grouped = new Map();
  entries.forEach((entry, index) => {
    const root = find(index);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(entry);
  });
  return [...grouped.values()]
    .map((componentEntries) => componentEntries.sort((left, right) => compareText(left.sortKey, right.sortKey)))
    .sort((left, right) => compareText(left[0].sortKey, right[0].sortKey));
}

function resultIsConstraintConflict(result) {
  return result?.status === 'inconsistent'
    || (result?.status === 'invalid' && (result.diagnostics || []).some((diagnostic) => diagnostic.code === 'FIXED_COINCIDENT_CONFLICT'));
}

function diagnoseConflictSets(sketch, settings) {
  const limits = CONSTRAINT_DIAGNOSTIC_LIMITS;
  const components = constraintComponents(sketch);
  let oracleSolves = 0;
  let truncated = components.length > limits.maxComponents;
  const oracle = (entries) => {
    if (oracleSolves >= limits.maxOracleSolves) return null;
    oracleSolves++;
    const candidate = { ...sketch, constraints: entries.map((entry) => entry.constraint) };
    return resultIsConstraintConflict(solveSketchInternal(candidate, settings, false));
  };

  // If geometry-internal equations are already inconsistent, no user
  // constraint set can truthfully be blamed.
  if (oracle([])) return { groups: [], truncated, oracleSolves, baseGeometryInconsistent: true };

  const groups = [];
  for (const component of components.slice(0, limits.maxComponents)) {
    const componentConflicts = oracle(component);
    if (componentConflicts === null) { truncated = true; break; }
    if (!componentConflicts) continue;
    if (component.length > limits.maxConstraintsPerComponent) {
      truncated = true;
      continue;
    }

    let remaining = component.slice();
    while (remaining.length && groups.length < limits.maxConflictSets) {
      const stillConflicts = oracle(remaining);
      if (stillConflicts === null) { truncated = true; break; }
      if (!stillConflicts) break;

      let candidate = remaining.slice();
      let minimal = true;
      // Canonical reverse deletion retains the lexically earliest valid
      // explanation when more than one inclusion-minimal set exists.
      for (const entry of [...candidate].reverse()) {
        const trial = candidate.filter((other) => other !== entry);
        const trialConflicts = oracle(trial);
        if (trialConflicts === null) { truncated = true; minimal = false; break; }
        if (trialConflicts) candidate = trial;
      }
      if (!candidate.length) break;
      groups.push({
        constraintIds: sortedUniqueConstraintIds(candidate),
        minimal,
        analysis: 'bounded-local-deletion',
        componentConstraintCount: component.length,
      });
      const chosen = new Set(candidate);
      remaining = remaining.filter((entry) => !chosen.has(entry));
    }
    if (groups.length >= limits.maxConflictSets) {
      const moreConflicts = remaining.length ? oracle(remaining) : false;
      if (moreConflicts === null || moreConflicts) truncated = true;
      break;
    }
  }
  groups.sort((left, right) => compareText(left.constraintIds.join('\u0000'), right.constraintIds.join('\u0000')));
  return { groups, truncated, oracleSolves, baseGeometryInconsistent: false };
}

function coincidentRedundancyGroups(component) {
  const entries = component.filter((entry) => entry.constraint.kind === 'coincident');
  if (!entries.length) return [];
  const pointIds = new Set(entries.flatMap((entry) => [entry.constraint.a, entry.constraint.b]));
  const parent = new Map([...pointIds].map((pointId) => [pointId, pointId]));
  const find = (pointId) => {
    let root = pointId;
    while (parent.get(root) !== root) root = parent.get(root);
    let cursor = pointId;
    while (cursor !== root) { const next = parent.get(cursor); parent.set(cursor, root); cursor = next; }
    return root;
  };
  const unite = (left, right) => {
    const leftRoot = find(left); const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (compareText(leftRoot, rightRoot) <= 0) parent.set(rightRoot, leftRoot);
    else parent.set(leftRoot, rightRoot);
  };
  const forest = [];
  const groups = [];
  for (const entry of entries) {
    const { a, b } = entry.constraint;
    if (find(a) === find(b)) {
      const support = coincidencePathEntries(forest, a, b);
      groups.push({
        constraintIds: sortedUniqueConstraintIds([...support, entry]),
        redundantConstraintIds: [entry.diagnosticId],
        equationExcess: 1,
        minimal: true,
        analysis: 'local-coincidence-cycle',
      });
    } else {
      unite(a, b);
      forest.push(entry);
    }
  }
  return groups;
}

function diagnoseRedundancyGroups(sketch, system, evaluation, jacobian, settings) {
  const limits = CONSTRAINT_DIAGNOSTIC_LIMITS;
  const entries = sketchConstraintEntries(sketch);
  const components = constraintComponents(sketch, entries);
  const entryByConstraint = new Map(entries.map((entry) => [entry.constraint, entry]));
  const rowsByEntry = new Map(entries.map((entry) => [entry, []]));
  const internalRows = [];
  for (const span of evaluation.spans) {
    const rows = jacobian.slice(span.start, span.end);
    const entry = entryByConstraint.get(span.residual.constraint);
    if (entry) rowsByEntry.get(entry).push(...rows);
    else internalRows.push(...rows);
  }

  let rankTests = 0;
  let truncated = components.length > limits.maxComponents;
  const rankCache = new Map();
  const rankFor = (selectedEntries) => {
    const ordered = [...selectedEntries].sort((left, right) => compareText(left.sortKey, right.sortKey));
    const key = ordered.map((entry) => entry.sortKey).join('\u0001');
    if (rankCache.has(key)) return rankCache.get(key);
    if (rankTests >= limits.maxRankTests) return null;
    rankTests++;
    const rows = internalRows.slice();
    for (const entry of ordered) rows.push(...(rowsByEntry.get(entry) || []));
    const rank = jacobianRank(rows, settings.rankTolerance);
    rankCache.set(key, rank);
    return rank;
  };

  const groups = [];
  for (const component of components.slice(0, limits.maxComponents)) {
    if (component.length > limits.maxConstraintsPerComponent) {
      truncated = true;
      continue;
    }
    groups.push(...coincidentRedundancyGroups(component));

    const accepted = [];
    for (const entry of component) {
      if (entry.constraint.kind === 'coincident') continue;
      const currentRows = rowsByEntry.get(entry) || [];
      if (!currentRows.length) continue;
      const before = rankFor(accepted);
      const after = rankFor([...accepted, entry]);
      if (before === null || after === null) { truncated = true; break; }
      const addedRank = after - before;
      if (addedRank < currentRows.length) {
        let support = accepted.slice();
        let minimal = true;
        for (const prior of [...support].reverse()) {
          const trial = support.filter((other) => other !== prior);
          const trialBefore = rankFor(trial);
          const trialAfter = rankFor([...trial, entry]);
          if (trialBefore === null || trialAfter === null) { truncated = true; minimal = false; break; }
          if (trialAfter - trialBefore < currentRows.length) support = trial;
        }
        groups.push({
          constraintIds: sortedUniqueConstraintIds([...support, entry]),
          redundantConstraintIds: [entry.diagnosticId],
          equationExcess: currentRows.length - addedRank,
          minimal,
          analysis: 'local-jacobian-rank',
        });
      }
      if (addedRank > 0) accepted.push(entry);
    }
  }

  const deduplicated = new Map();
  for (const group of groups) {
    const key = group.constraintIds.join('\u0000') + '\u0002' + group.redundantConstraintIds.join('\u0000');
    if (!deduplicated.has(key)) deduplicated.set(key, group);
  }
  const orderedGroups = [...deduplicated.values()].sort((left, right) => {
    return compareText(left.constraintIds.join('\u0000'), right.constraintIds.join('\u0000'))
      || compareText(left.redundantConstraintIds.join('\u0000'), right.redundantConstraintIds.join('\u0000'));
  });
  return {
    groups: orderedGroups,
    redundantConstraintIds: [...new Set(orderedGroups.flatMap((group) => group.redundantConstraintIds))].sort(compareText),
    truncated,
    rankTests,
  };
}

function solveSketchInternal(sketch, options = {}, analyzeConstraints = true, analyzeDefinition = true) {
  const settings = { ...SOLVER_DEFAULTS, ...options };
  const structural = validateConstraintSketch(sketch);
  if (structural.length) return { status: 'invalid', diagnostics: structural };

  let system;
  try {
    system = buildSystem(sketch, settings);
  } catch (error) {
    if (error instanceof SketchSolveError) {
      const diagnostic = { code: error.code, severity: 'error', message: error.message, ...error.meta };
      const conflictSets = Array.isArray(diagnostic.constraintIds) && diagnostic.constraintIds.length
        ? [diagnostic.constraintIds]
        : [];
      return { status: 'invalid', diagnostics: [diagnostic], conflictSets, redundantConstraintIds: [], redundancyGroups: [] };
    }
    throw error;
  }

  const parameterCount = system.params.length;
  const equationCount = system.residuals.reduce((total, residual) => total + residual.count, 0);
  const denseWorkCells = (equationCount > 0 ? 4 * parameterCount * parameterCount : 0)
    + 2 * parameterCount * equationCount;
  if (
    Number.isFinite(settings.maxDenseWorkCells)
    && denseWorkCells > settings.maxDenseWorkCells
  ) {
    return {
      status: 'invalid',
      diagnostics: [{
        code: 'SKETCH_SOLVE_WORK_LIMIT',
        severity: 'error',
        message: 'Sketch solve exceeds the bounded dense-matrix work budget.',
        parameterCount,
        equationCount,
        denseWorkCells,
        maximumDenseWorkCells: settings.maxDenseWorkCells,
      }],
      conflictSets: [],
      redundantConstraintIds: [],
      redundancyGroups: [],
    };
  }

  const x = Float64Array.from(system.params);
  const n = x.length;

  // Damped least squares. The damping term keeps every step minimal-norm,
  // which is what makes under-constrained sketches settle near their input
  // instead of drifting; no explicit prior is needed (a prior would bias the
  // converged solution away from exactly satisfying the constraints).
  let lambda = 1e-4;
  let iterations = 0;
  let evaluation = evaluateResiduals(system, x);
  const costOf = (values) => values.reduce((sum, v) => sum + v * v, 0);
  let cost = costOf(evaluation.values);

  while (iterations < settings.maxIterations) {
    const maxResidual = evaluation.values.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
    if (maxResidual < settings.tolerance) break;
    const jacobian = numericJacobian(system, x, evaluation.values);
    const m = evaluation.values.length;
    const jtj = [];
    const rhs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      jtj.push(new Float64Array(n));
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let row = 0; row < m; row++) sum += jacobian[row][i] * jacobian[row][j];
        jtj[i][j] = sum;
      }
      let g = 0;
      for (let row = 0; row < m; row++) g += jacobian[row][i] * evaluation.values[row];
      rhs[i] = -g;
    }
    let accepted = false;
    for (let inner = 0; inner < 8 && !accepted; inner++) {
      // Marquardt scaling plus an absolute floor: parameters no constraint
      // touches get a well-conditioned identity block (and a zero gradient,
      // so they simply do not move).
      const damped = jtj.map((row, i) => {
        const copy = row.slice();
        copy[i] += lambda * copy[i] + lambda;
        return copy;
      });
      const step = solveNormalEquations(damped, rhs);
      if (!step) { lambda *= 4; continue; }
      const trial = x.slice();
      for (let i = 0; i < n; i++) trial[i] += step[i];
      const trialEval = evaluateResiduals(system, trial);
      const trialCost = costOf(trialEval.values);
      if (trialCost <= cost || trialCost < settings.tolerance * settings.tolerance) {
        x.set(trial);
        evaluation = trialEval;
        cost = trialCost;
        lambda = Math.max(lambda / 3, 1e-12);
        accepted = true;
      } else {
        lambda *= 4;
      }
    }
    iterations++;
    if (!accepted) break;
  }

  const maxResidual = evaluation.values.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
  const converged = maxResidual < Math.max(settings.tolerance, 1e-7);

  // Live direct manipulation needs the same nonlinear residual solve, but it
  // does not need a second full Jacobian plus rank, null-space mobility, and
  // bounded diagnostic oracles for every pointer sample.  The ordinary
  // solveSketch path keeps all of that analysis; solveSketchPreview below is
  // deliberately geometry-only and callers must run a full solve before
  // committing authored state.
  const jacobian = analyzeDefinition ? numericJacobian(system, x, evaluation.values) : [];
  const rank = analyzeDefinition ? jacobianRank(jacobian, settings.rankTolerance) : null;
  const dof = analyzeDefinition ? Math.max(0, n - rank) : null;
  const parameterMobility = analyzeDefinition
    ? jacobianParameterMobility(jacobian, n, settings.rankTolerance)
    : [];
  const entityStates = analyzeDefinition
    ? [...(sketch.entities || [])]
      .sort((left, right) => compareText(left.id, right.id))
      .map((entity) => {
        const parameterIndexes = entityParameterIndexes(entity, system);
        const freeParameterCount = parameterIndexes.filter((index) => parameterMobility[index]).length;
        return {
          entityId: entity.id,
          fullyDefined: freeParameterCount === 0,
          underDefined: freeParameterCount > 0,
          freeParameterCount,
        };
      })
    : [];
  const redundant = analyzeDefinition && evaluation.values.length > rank;
  const conflictAnalysis = !converged && analyzeConstraints
    ? diagnoseConflictSets(sketch, settings)
    : { groups: [], truncated: false, oracleSolves: 0, baseGeometryInconsistent: false };
  const hasCoincidentConstraints = (sketch.constraints || []).some((constraint) => constraint.kind === 'coincident');
  const redundancyAnalysis = converged && analyzeDefinition && analyzeConstraints && (redundant || hasCoincidentConstraints)
    ? diagnoseRedundancyGroups(sketch, system, evaluation, jacobian, settings)
    : { groups: [], redundantConstraintIds: [], truncated: false, rankTests: 0 };

  const diagnostics = [];
  if (!converged) {
    const entryByConstraint = new Map(sketchConstraintEntries(sketch).map((entry) => [entry.constraint, entry]));
    const offenders = evaluation.spans
      .map(({ residual, start, end }) => ({
        constraint: residual.constraint,
        diagnosticId: entryByConstraint.get(residual.constraint)?.diagnosticId || residual.constraint.id || residual.constraint.kind,
        worst: evaluation.values.slice(start, end).reduce((max, v) => Math.max(max, Math.abs(v)), 0),
      }))
      .filter((entry) => entry.worst > Math.max(settings.tolerance, 1e-7))
      .sort((a, b) => (b.worst - a.worst) || compareText(a.diagnosticId, b.diagnosticId))
      .slice(0, 5);
    for (const offender of offenders) {
      diagnostics.push({
        code: 'CONSTRAINT_UNSATISFIED',
        severity: 'error',
        message: 'Constraint ' + offender.diagnosticId + ' is off by ' + offender.worst.toPrecision(3) + ' — the sketch is over-constrained or conflicting.',
        constraintId: offender.diagnosticId,
        constraintKind: offender.constraint.kind,
        residual: offender.worst,
      });
    }
    for (const group of conflictAnalysis.groups) {
      diagnostics.push({
        code: 'CONSTRAINT_CONFLICT_SET',
        severity: 'error',
        message: 'Constraint conflict set: ' + group.constraintIds.join(', ') + '.',
        ...group,
      });
    }
    if (conflictAnalysis.truncated) {
      diagnostics.push({
        code: 'CONSTRAINT_CONFLICT_ANALYSIS_LIMIT',
        severity: 'warning',
        message: 'Conflict-set analysis reached its deterministic work limit; residual diagnostics remain complete.',
        oracleSolves: conflictAnalysis.oracleSolves,
      });
    }
  } else if (redundancyAnalysis.groups.length) {
    diagnostics.push({
      code: 'CONSTRAINTS_REDUNDANT',
      severity: 'warning',
      message: 'The sketch solves, but these constraint sets contain redundant equations: '
        + redundancyAnalysis.groups.map((group) => group.constraintIds.join(' + ')).join('; ') + '.',
      constraintIds: [...new Set(redundancyAnalysis.groups.flatMap((group) => group.constraintIds))].sort(compareText),
      redundantConstraintIds: redundancyAnalysis.redundantConstraintIds,
      groups: redundancyAnalysis.groups,
      analysisTruncated: redundancyAnalysis.truncated,
    });
  } else if (redundant) {
    diagnostics.push({
      code: 'CONSTRAINTS_REDUNDANT',
      severity: 'warning',
      message: 'The sketch solves, but ' + (evaluation.values.length - rank) + ' equation(s) are redundant; no bounded user-constraint set was proven.',
      constraintIds: [],
      redundantConstraintIds: [],
      analysisTruncated: redundancyAnalysis.truncated,
    });
  }

  // Write solved coordinates back into entity copies.
  const solvedEntities = (sketch.entities || []).map((entity) => {
    if (entity.kind === 'point') {
      const cluster = system.clusters.get(system.clusterOf(entity.id));
      const sx = cluster.fixed ? cluster.x : x[cluster.index];
      const sy = cluster.fixed ? cluster.y : x[cluster.index + 1];
      return { ...entity, at: [roundTiny(sx), roundTiny(sy)] };
    }
    if (entity.kind === 'circle') {
      const slot = system.radii.get(entity.id);
      return { ...entity, solvedR: roundTiny(x[slot.index]) };
    }
    return { ...entity };
  });

  return {
    status: converged ? 'ok' : 'inconsistent',
    entities: solvedEntities,
    dof,
    rank,
    equations: evaluation.values.length,
    iterations,
    residual: maxResidual,
    entityStates,
    diagnostics,
    conflictSets: conflictAnalysis.groups.map((group) => group.constraintIds),
    conflictAnalysisTruncated: conflictAnalysis.truncated,
    redundantConstraintIds: redundancyAnalysis.redundantConstraintIds,
    redundancyGroups: redundancyAnalysis.groups,
    redundancyAnalysisTruncated: redundancyAnalysis.truncated,
  };
}

export function solveSketch(sketch, options = {}) {
  return solveSketchInternal(sketch, options, true);
}

// Geometry-only solve for transient interaction previews.  This is not a
// completion or document-validation API: it intentionally omits DOF/rank,
// entity-definition state, redundancy analysis, and conflict-set isolation.
// A caller that persists its result must validate the settled sketch through
// solveSketch first.
export function solveSketchPreview(sketch, options = {}) {
  return solveSketchInternal(sketch, options, false, false);
}

function roundTiny(value) {
  const rounded = Math.round(value * 1e9) / 1e9;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function measureSketchDimension(sketch, constraint, options = {}) {
  if (!DIMENSIONAL_KINDS.has(constraint?.kind)) {
    throw new SketchSolveError('DIMENSION_KIND_INVALID', 'Only dimensional constraints can be measured.');
  }
  const structural = validateConstraintSketch(sketch);
  if (structural.length) {
    throw new SketchSolveError('SKETCH_INVALID', structural[0].message, { diagnostics: structural });
  }
  const { presolved, ...solveOptions } = options;
  const solved = presolved || solveSketch(sketch, solveOptions);
  if (solved.status !== 'ok') {
    throw new SketchSolveError('SKETCH_UNSOLVED', 'Reference dimensions require a solved sketch.', { diagnostics: solved.diagnostics || [] });
  }
  const byId = new Map((solved.entities || []).map((entity) => [entity.id, entity]));
  const point = (id) => byId.get(id)?.at;
  const vector = (lineId) => {
    const line = byId.get(lineId);
    const a = point(line?.a); const b = point(line?.b);
    return [b[0] - a[0], b[1] - a[1]];
  };
  let measured;
  if (constraint.kind === 'distance' || constraint.kind === 'horizontalDistance' || constraint.kind === 'verticalDistance') {
    const a = point(constraint.a); const b = point(constraint.b);
    const dx = b[0] - a[0]; const dy = b[1] - a[1];
    measured = constraint.kind === 'distance' ? Math.hypot(dx, dy) : constraint.kind === 'horizontalDistance' ? dx : dy;
  } else if (constraint.kind === 'length') {
    const [dx, dy] = vector(constraint.line);
    measured = Math.hypot(dx, dy);
  } else if (constraint.kind === 'radius') {
    const round = byId.get(constraint.circle);
    if (round.kind === 'circle') measured = round.solvedR ?? round.r;
    else {
      const center = point(round.center); const edge = point(round.a);
      measured = Math.hypot(edge[0] - center[0], edge[1] - center[1]);
    }
  } else {
    const a = vector(constraint.a); const b = vector(constraint.b);
    measured = (Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0])) * 180 / Math.PI;
    while (measured > 180) measured -= 360;
    while (measured <= -180) measured += 360;
  }
  return roundTiny(measured);
}

export function sketchDof(sketch, options = {}) {
  const solved = solveSketch(sketch, options);
  if (solved.status === 'invalid') return solved;
  return {
    status: solved.status,
    dof: solved.dof,
    rank: solved.rank,
    equations: solved.equations,
    fullyDefined: solved.status === 'ok' && solved.dof === 0,
    diagnostics: solved.diagnostics,
  };
}

// --- profile extraction ----------------------------------------------------

// Turns solved entities into closed loops the kernel can sweep: circles become
// standalone round loops; lines and arcs chain end-to-end (coincidence is by
// shared or coincident-merged point ids, never by distance tolerance).
export function constraintSketchToLoops(sketch, options = {}) {
  const solved = options.presolved || solveSketch(sketch, options);
  if (solved.status === 'invalid') return { status: 'invalid', loops: [], diagnostics: solved.diagnostics };
  const entities = solved.entities || [];
  const byId = new Map(entities.map((entity) => [entity.id, entity]));

  const parent = new Map();
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root);
    let cursor = id;
    while (cursor !== root) { const next = parent.get(cursor); parent.set(cursor, root); cursor = next; }
    return root;
  };
  for (const entity of entities) if (entity.kind === 'point') parent.set(entity.id, entity.id);
  for (const constraint of sketch.constraints || []) {
    if (constraint.kind !== 'coincident') continue;
    const ra = find(constraint.a); const rb = find(constraint.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const at = (pointId) => byId.get(pointId).at;

  const loops = [];
  const diagnostics = [];
  for (const entity of entities) {
    if (entity.kind === 'circle' && !entity.construction) {
      loops.push({
        kind: 'circle',
        entityId: entity.id,
        center: at(entity.center),
        r: entity.solvedR !== undefined ? entity.solvedR : entity.r,
      });
    }
  }

  const endPoint = (segment, end) => segment.kind === 'spline'
    ? (end === 'a' ? segment.through[0] : segment.through[segment.through.length - 1])
    : segment[end];
  const segments = entities.filter((entity) => (entity.kind === 'line' || entity.kind === 'arc' || entity.kind === 'spline') && !entity.construction);
  const bySocket = new Map(); // cluster root -> [{segment, end: 'a'|'b'}]
  for (const segment of segments) {
    for (const end of ['a', 'b']) {
      const root = find(endPoint(segment, end));
      if (!bySocket.has(root)) bySocket.set(root, []);
      bySocket.get(root).push({ segment, end });
    }
  }
  const used = new Set();
  for (const segment of segments) {
    if (used.has(segment.id)) continue;
    const chain = [];
    let current = segment;
    let entrySocket = find(endPoint(current, 'a'));
    let guard = segments.length + 1;
    let closed = false;
    while (guard-- > 0) {
      used.add(current.id);
      const exitEnd = find(endPoint(current, 'a')) === entrySocket ? 'b' : 'a';
      chain.push({ segment: current, reversed: exitEnd === 'a' });
      const exitSocket = find(endPoint(current, exitEnd));
      // A closed spline is a loop all by itself (its two sockets coincide).
      const selfClosed = chain.length === 1 && current.kind === 'spline'
        && find(endPoint(current, 'a')) === find(endPoint(current, 'b'));
      if (chain.length > 1 || segments.length === 1 || selfClosed) {
        if (exitSocket === find(endPoint(chain[0].segment, chain[0].reversed ? 'b' : 'a'))) { closed = true; break; }
      }
      const next = (bySocket.get(exitSocket) || []).find((slot) => !used.has(slot.segment.id));
      if (!next) break;
      current = next.segment;
      entrySocket = exitSocket;
    }
    if (!closed) {
      diagnostics.push({
        code: 'PROFILE_OPEN',
        severity: 'error',
        message: 'Profile chain starting at "' + segment.id + '" does not close (' + chain.length + ' segment(s)).',
        entityId: segment.id,
      });
      continue;
    }
    const loopSegments = chain.map(({ segment: seg, reversed }) => {
      if (seg.kind === 'spline') {
        const through = (reversed ? [...seg.through].reverse() : seg.through).map((pointId) => at(pointId));
        return { kind: 'spline', entityId: seg.id, a: through[0], b: through[through.length - 1], through };
      }
      const a = at(reversed ? seg.b : seg.a);
      const b = at(reversed ? seg.a : seg.b);
      if (seg.kind === 'line') return { kind: 'line', entityId: seg.id, a, b };
      const ccw = seg.ccw !== false;
      return {
        kind: 'arc', entityId: seg.id, a, b,
        center: at(seg.center),
        ccw: reversed ? !ccw : ccw,
      };
    });
    loops.push({ kind: 'loop', segments: loopSegments });
  }

  return { status: diagnostics.length ? 'invalid' : 'ok', loops, diagnostics, solved };
}

// --- spline geometry --------------------------------------------------------
// Splines interpolate their through-points with a uniform Catmull-Rom curve,
// expressed as cubic Bezier segments so the exact kernel path and every
// display sampler trace the SAME curve. A closed spline repeats its first
// point id at the end of `through`; tangents then wrap around the loop.
// (studio-kernel.worker.js carries a twin of catmullRomBeziers — keep them
// in sync.)

export function catmullRomBeziers(points) {
  const closed = points.length > 2
    && Math.abs(points[0][0] - points[points.length - 1][0]) <= 1e-9
    && Math.abs(points[0][1] - points[points.length - 1][1]) <= 1e-9;
  const core = closed ? points.slice(0, -1) : points;
  const count = core.length;
  if (count < 2) return [];
  const pointAt = (index) => {
    if (closed) return core[((index % count) + count) % count];
    return core[Math.min(count - 1, Math.max(0, index))];
  };
  const tangentAt = (index) => {
    const prev = pointAt(index - 1);
    const next = pointAt(index + 1);
    return [(next[0] - prev[0]) / 2, (next[1] - prev[1]) / 2];
  };
  const segments = [];
  const last = closed ? count : count - 1;
  for (let index = 0; index < last; index++) {
    const p0 = pointAt(index);
    const p1 = pointAt(index + 1);
    const m0 = tangentAt(index);
    const m1 = tangentAt(index + 1);
    segments.push({
      a: [p0[0], p0[1]],
      c1: [p0[0] + m0[0] / 3, p0[1] + m0[1] / 3],
      c2: [p1[0] - m1[0] / 3, p1[1] - m1[1] / 3],
      b: [p1[0], p1[1]],
    });
  }
  return segments;
}

export function sampleSplineThrough(points, stepsPerSegment = 12) {
  const segments = catmullRomBeziers(points);
  if (!segments.length) return points.map((p) => [p[0], p[1]]);
  const out = [[segments[0].a[0], segments[0].a[1]]];
  for (const segment of segments) {
    for (let step = 1; step <= stepsPerSegment; step++) {
      const t = step / stepsPerSegment;
      const u = 1 - t;
      const x = u * u * u * segment.a[0] + 3 * u * u * t * segment.c1[0] + 3 * u * t * t * segment.c2[0] + t * t * t * segment.b[0];
      const y = u * u * u * segment.a[1] + 3 * u * u * t * segment.c1[1] + 3 * u * t * t * segment.c2[1] + t * t * t * segment.b[1];
      out.push([x, y]);
    }
  }
  return out;
}

export { SketchSolveError };
