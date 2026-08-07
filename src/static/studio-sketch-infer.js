// Constraint inference for interactive sketching. Pure math, no DOM: the
// pointer tools feed placements through here and get back snapped positions
// plus the constraints a competent CAD sketcher would add automatically.
//
// Inference kinds:
//   - coincident: a placement within snapRadius of an existing point snaps
//     onto that point (returns its id instead of creating a duplicate).
//   - horizontal / vertical: a segment within snapAngleDeg of an axis snaps
//     onto it, and the matching constraint is recorded.
//
// The caller owns id allocation and entity insertion; this module only
// decides positions and constraint records so it stays trivially testable.

const DEFAULTS = Object.freeze({
  snapRadiusMm: 2.5,
  snapAngleDeg: 7,
});

export function nearestPoint(at, entities, snapRadiusMm = DEFAULTS.snapRadiusMm) {
  let best = null;
  for (const entity of entities || []) {
    if (entity.kind !== 'point') continue;
    const distance = Math.hypot(entity.at[0] - at[0], entity.at[1] - at[1]);
    if (distance <= snapRadiusMm && (!best || distance < best.distance)) {
      best = { pointId: entity.id, at: [entity.at[0], entity.at[1]], distance };
    }
  }
  return best;
}

export function axisSnap(from, to, snapAngleDeg = DEFAULTS.snapAngleDeg) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (Math.hypot(dx, dy) < 1e-9) return { at: [to[0], to[1]], axis: null };
  const angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
  const offHorizontal = Math.min(angle, 180 - angle);
  const offVertical = Math.abs(90 - angle);
  if (offHorizontal <= snapAngleDeg && offHorizontal <= offVertical) {
    return { at: [to[0], from[1]], axis: 'horizontal' };
  }
  if (offVertical <= snapAngleDeg) {
    return { at: [from[0], to[1]], axis: 'vertical' };
  }
  return { at: [to[0], to[1]], axis: null };
}

// Perpendicular foot on the interior of a line / circle / arc within
// snapRadius. Endpoint neighbourhoods are excluded on purpose — those belong
// to nearestPoint, which reuses ids instead of pinning onto the curve.
export function nearestOnEntity(at, entities, snapRadiusMm = DEFAULTS.snapRadiusMm, excludeIds = null) {
  const list = entities || [];
  const byId = new Map(list.map((entity) => [entity.id, entity]));
  let best = null;
  const consider = (candidate) => {
    if (candidate.distance <= snapRadiusMm && (!best || candidate.distance < best.distance)) best = candidate;
  };
  for (const entity of list) {
    if (excludeIds && excludeIds.has(entity.id)) continue;
    if (entity.kind === 'line') {
      const a = byId.get(entity.a);
      const b = byId.get(entity.b);
      if (!a || !b) continue;
      const dx = b.at[0] - a.at[0];
      const dy = b.at[1] - a.at[1];
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) continue;
      const t = ((at[0] - a.at[0]) * dx + (at[1] - a.at[1]) * dy) / len2;
      if (t <= 0.02 || t >= 0.98) continue;
      const px = a.at[0] + t * dx;
      const py = a.at[1] + t * dy;
      consider({ entityId: entity.id, kind: 'line', at: [px, py], distance: Math.hypot(at[0] - px, at[1] - py) });
      continue;
    }
    if (entity.kind !== 'circle' && entity.kind !== 'arc') continue;
    const center = byId.get(entity.center);
    if (!center) continue;
    let radius;
    if (entity.kind === 'circle') {
      radius = entity.r;
      if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) continue; // expression radii resolve at solve time
    } else {
      const a = byId.get(entity.a);
      if (!a) continue;
      radius = Math.hypot(a.at[0] - center.at[0], a.at[1] - center.at[1]);
      if (radius < 1e-9) continue;
    }
    const vx = at[0] - center.at[0];
    const vy = at[1] - center.at[1];
    const d = Math.hypot(vx, vy);
    if (d < 1e-9) continue;
    const px = center.at[0] + (vx / d) * radius;
    const py = center.at[1] + (vy / d) * radius;
    if (entity.kind === 'arc') {
      const a = byId.get(entity.a);
      const b = byId.get(entity.b);
      if (!a || !b) continue;
      const start = Math.atan2(a.at[1] - center.at[1], a.at[0] - center.at[0]);
      const end = Math.atan2(b.at[1] - center.at[1], b.at[0] - center.at[0]);
      const here = Math.atan2(py - center.at[1], px - center.at[0]);
      let span = end - start;
      let along = here - start;
      if (entity.ccw === false) {
        while (span >= 0) span -= Math.PI * 2;
        while (along > 0) along -= Math.PI * 2;
      } else {
        while (span <= 0) span += Math.PI * 2;
        while (along < 0) along += Math.PI * 2;
      }
      const fraction = along / span;
      if (!(fraction > 0.02 && fraction < 0.98)) continue;
    }
    consider({ entityId: entity.id, kind: entity.kind, at: [px, py], distance: Math.abs(d - radius) });
  }
  return best;
}

// Tangent continuation: when the chain leaves a point that is an arc
// endpoint and the drawn direction is within snapAngleDeg of the arc's
// tangent there, project the target onto the tangent ray.
export function tangentContinuation(options) {
  const { fromPointId, from, to, entities, snapAngleDeg = DEFAULTS.snapAngleDeg } = options;
  const list = entities || [];
  const byId = new Map(list.map((entity) => [entity.id, entity]));
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  let best = null;
  for (const entity of list) {
    if (entity.kind !== 'arc') continue;
    if (entity.a !== fromPointId && entity.b !== fromPointId) continue;
    const center = byId.get(entity.center);
    if (!center) continue;
    const rx = from[0] - center.at[0];
    const ry = from[1] - center.at[1];
    const rlen = Math.hypot(rx, ry);
    if (rlen < 1e-9) continue;
    // Tangent is perpendicular to the radius; pick the sign following the draw.
    let tx = -ry / rlen;
    let ty = rx / rlen;
    if (tx * dx + ty * dy < 0) { tx = -tx; ty = -ty; }
    const cos = Math.min(1, Math.max(-1, (tx * dx + ty * dy) / len));
    const delta = (Math.acos(cos) * 180) / Math.PI;
    if (delta <= snapAngleDeg && (!best || delta < best.delta)) {
      const along = tx * dx + ty * dy;
      best = { arcId: entity.id, at: [from[0] + tx * along, from[1] + ty * along], dir: [tx, ty], delta };
    }
  }
  return best;
}

// One line-tool placement: given the chain's previous point (id or null for
// the first click) and the raw click position, produce the snapped position,
// whether it lands on an existing point or curve, and the constraints to
// record. Segment constraints come back as {kind:'horizontal'|'vertical'},
// {kind:'tangent', arc} or {kind:'equal', line}; landing on a curve interior
// adds pointConstraints ({kind:'pointOnLine', line} / {kind:'pointOnCircle',
// circle}) for the caller to attach to the newly created point.
export function inferLinePlacement(options) {
  const { sketch, fromPointId, at, snapRadiusMm = DEFAULTS.snapRadiusMm, snapAngleDeg = DEFAULTS.snapAngleDeg } = options;
  const entities = sketch?.entities || [];
  const from = fromPointId ? entities.find((entity) => entity.id === fromPointId) : null;
  let target = [at[0], at[1]];
  let axis = null;
  let tangentArc = null;
  let dir = null; // unit direction of an axis/tangent snap, when one applied
  if (from) {
    const tangent = tangentContinuation({ fromPointId, from: from.at, to: target, entities, snapAngleDeg });
    if (tangent) {
      target = tangent.at;
      tangentArc = tangent.arcId;
      dir = tangent.dir;
    } else {
      const snapped = axisSnap(from.at, target, snapAngleDeg);
      target = snapped.at;
      axis = snapped.axis;
      if (axis) dir = axis === 'horizontal' ? [Math.sign(target[0] - from.at[0]) || 1, 0] : [0, Math.sign(target[1] - from.at[1]) || 1];
    }
  }
  // Coincidence wins over every other snap: landing on an existing point
  // reuses it exactly (id-based connectivity, no tolerance welding later).
  const hit = nearestPoint(target, entities, snapRadiusMm);
  if (hit) {
    const constraints = [];
    if (from && axis) {
      // Keep the axis constraint only if the existing point actually lies on
      // the snapped axis; otherwise the coincidence decides the direction.
      const stillAxis = axis === 'horizontal'
        ? Math.abs(hit.at[1] - from.at[1]) <= 1e-9
        : Math.abs(hit.at[0] - from.at[0]) <= 1e-9;
      if (stillAxis) constraints.push({ kind: axis });
    }
    if (from && tangentArc && dir) {
      // Keep the tangency only if the existing point lies on the tangent ray.
      const cross = Math.abs(dir[0] * (hit.at[1] - from.at[1]) - dir[1] * (hit.at[0] - from.at[0]));
      if (cross <= 1e-6) constraints.push({ kind: 'tangent', arc: tangentArc });
    }
    const axisKept = constraints.some((c) => c.kind === axis) ? axis : null;
    return { at: hit.at, coincidentWith: hit.pointId, axis: axisKept, constraints, pointConstraints: [], onEntity: null };
  }
  const constraints = [];
  const pointConstraints = [];
  let onEntity = null;
  // The chain is leaving the from-point: curves attached to it hug the new
  // segment near its start, so they never count as a landing surface.
  const excludeIds = from
    ? new Set(entities.filter((entity) => (entity.kind === 'line' || entity.kind === 'arc') && (entity.a === fromPointId || entity.b === fromPointId)).map((entity) => entity.id))
    : null;
  const curveHit = nearestOnEntity(target, entities, snapRadiusMm, excludeIds);
  if (curveHit) {
    onEntity = curveHit.entityId;
    let landed = curveHit.at;
    let keepDirection = false;
    if (from && dir && curveHit.kind === 'line') {
      // Terminating a directed segment on a line: land on the intersection of
      // the direction ray and that line, keeping both constraints, as long as
      // the intersection is still near the click and inside the segment.
      const lineEntity = entities.find((entity) => entity.id === curveHit.entityId);
      const a = entities.find((entity) => entity.id === lineEntity?.a);
      const b = entities.find((entity) => entity.id === lineEntity?.b);
      if (a && b) {
        const ex = b.at[0] - a.at[0];
        const ey = b.at[1] - a.at[1];
        const denom = dir[0] * ey - dir[1] * ex;
        if (Math.abs(denom) > 1e-9) {
          const s = (dir[0] * (a.at[1] - from.at[1]) - dir[1] * (a.at[0] - from.at[0])) / -denom;
          const ix = a.at[0] + s * ex;
          const iy = a.at[1] + s * ey;
          if (s > 0.02 && s < 0.98 && Math.hypot(ix - target[0], iy - target[1]) <= snapRadiusMm) {
            landed = [ix, iy];
            keepDirection = true;
          }
        }
      }
    }
    target = landed;
    if (keepDirection) {
      if (axis) constraints.push({ kind: axis });
      if (tangentArc) constraints.push({ kind: 'tangent', arc: tangentArc });
    } else {
      axis = null;
      tangentArc = null;
    }
    pointConstraints.push(curveHit.kind === 'line'
      ? { kind: 'pointOnLine', line: curveHit.entityId }
      : { kind: 'pointOnCircle', circle: curveHit.entityId });
    return { at: target, coincidentWith: null, axis, constraints, pointConstraints, onEntity };
  }
  if (axis) constraints.push({ kind: axis });
  if (tangentArc) constraints.push({ kind: 'tangent', arc: tangentArc });
  // Equal-length inference: a free endpoint whose segment comes out within
  // snap distance of an existing line's length snaps to exactly that length.
  if (from) {
    const length = Math.hypot(target[0] - from.at[0], target[1] - from.at[1]);
    if (length > 1e-9) {
      const byId = new Map(entities.map((entity) => [entity.id, entity]));
      let bestEqual = null;
      for (const entity of entities) {
        if (entity.kind !== 'line') continue;
        const a = byId.get(entity.a);
        const b = byId.get(entity.b);
        if (!a || !b) continue;
        const other = Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]);
        if (other < 1e-9) continue;
        const diff = Math.abs(other - length);
        if (diff <= snapRadiusMm && (!bestEqual || diff < bestEqual.diff)) {
          bestEqual = { lineId: entity.id, length: other, diff };
        }
      }
      if (bestEqual) {
        const scale = bestEqual.length / length;
        target = [from.at[0] + (target[0] - from.at[0]) * scale, from.at[1] + (target[1] - from.at[1]) * scale];
        constraints.push({ kind: 'equal', line: bestEqual.lineId });
      }
    }
  }
  return { at: target, coincidentWith: null, axis, constraints, pointConstraints, onEntity };
}

// Build a fully-defined axis-aligned rectangle from two corner picks. The
// first corner is fixed (anchoring the sketch), sides carry H/V constraints,
// and the two driving dimensions come from the actual drag, rounded to the
// grid so hand-drawn rectangles come out with round numbers.
export function constrainedRectangle(options) {
  const { corner, opposite, idPrefix = 'sk', gridMm = 1 } = options;
  const round = (value) => {
    const rounded = Math.round(value / gridMm) * gridMm;
    return Object.is(rounded, -0) ? 0 : rounded;
  };
  const x0 = round(corner[0]), y0 = round(corner[1]);
  const x1 = round(opposite[0]), y1 = round(opposite[1]);
  const width = Math.abs(x1 - x0), height = Math.abs(y1 - y0);
  if (width < gridMm || height < gridMm) return null;
  const id = (suffix) => idPrefix + '-' + suffix;
  return {
    entities: [
      { id: id('p0'), kind: 'point', at: [x0, y0], fixed: true },
      { id: id('p1'), kind: 'point', at: [x1, y0] },
      { id: id('p2'), kind: 'point', at: [x1, y1] },
      { id: id('p3'), kind: 'point', at: [x0, y1] },
      { id: id('l0'), kind: 'line', a: id('p0'), b: id('p1') },
      { id: id('l1'), kind: 'line', a: id('p1'), b: id('p2') },
      { id: id('l2'), kind: 'line', a: id('p2'), b: id('p3') },
      { id: id('l3'), kind: 'line', a: id('p3'), b: id('p0') },
    ],
    constraints: [
      { kind: 'horizontal', line: id('l0') },
      { kind: 'vertical', line: id('l1') },
      { kind: 'horizontal', line: id('l2') },
      { kind: 'vertical', line: id('l3') },
      { id: id('width'), kind: 'length', line: id('l0'), value: width },
      { id: id('height'), kind: 'length', line: id('l1'), value: height },
    ],
  };
}

// A dimensioned circle from a centre pick and a radius pick.
export function constrainedCircle(options) {
  const { center, radiusPoint, idPrefix = 'sk', gridMm = 1 } = options;
  const round = (value) => {
    const rounded = Math.round(value / gridMm) * gridMm;
    return Object.is(rounded, -0) ? 0 : rounded;
  };
  const radius = Math.max(gridMm, round(Math.hypot(radiusPoint[0] - center[0], radiusPoint[1] - center[1])));
  const id = (suffix) => idPrefix + '-' + suffix;
  return {
    entities: [
      { id: id('c'), kind: 'point', at: [round(center[0]), round(center[1])], fixed: true },
      { id: id('circle'), kind: 'circle', center: id('c'), r: radius },
    ],
    constraints: [
      { id: id('r'), kind: 'radius', circle: id('circle'), value: radius },
    ],
  };
}

// Circumcircle of three points; null when collinear (no arc exists).
export function arcFromThreePoints(a, via, b) {
  const d = 2 * (a[0] * (via[1] - b[1]) + via[0] * (b[1] - a[1]) + b[0] * (a[1] - via[1]));
  if (Math.abs(d) < 1e-9) return null;
  const aa = a[0] * a[0] + a[1] * a[1];
  const vv = via[0] * via[0] + via[1] * via[1];
  const bb = b[0] * b[0] + b[1] * b[1];
  const cx = (aa * (via[1] - b[1]) + vv * (b[1] - a[1]) + bb * (a[1] - via[1])) / d;
  const cy = (aa * (b[0] - via[0]) + vv * (a[0] - b[0]) + bb * (via[0] - a[0])) / d;
  const r = Math.hypot(a[0] - cx, a[1] - cy);
  // Orientation: does start -> via -> end turn left (ccw)?
  const ccw = ((via[0] - a[0]) * (b[1] - a[1]) - (via[1] - a[1]) * (b[0] - a[0])) > 0;
  return { center: [cx, cy], r, ccw };
}

// One arc-tool placement: three raw picks (start, end, via). Endpoints snap
// to existing points; if a snapped endpoint belongs to a line whose direction
// is tangent to the arc there (within snapAngleDeg), a tangent constraint is
// recorded. Returns null for degenerate (collinear or tiny) picks.
export function inferArcPlacement(options) {
  const { sketch, start, end, via, snapRadiusMm = DEFAULTS.snapRadiusMm, snapAngleDeg = DEFAULTS.snapAngleDeg } = options;
  const entities = sketch?.entities || [];
  const snap = (at) => {
    const hit = nearestPoint(at, entities, snapRadiusMm);
    return hit ? { at: hit.at, coincidentWith: hit.pointId } : { at: [at[0], at[1]], coincidentWith: null };
  };
  const s = snap(start);
  const e = snap(end);
  const geometry = arcFromThreePoints(s.at, via, e.at);
  if (!geometry || geometry.r < 0.25 || Math.hypot(e.at[0] - s.at[0], e.at[1] - s.at[1]) < 0.5) return null;
  const constraints = [];
  const tangentAt = (endpoint, label) => {
    if (!endpoint.coincidentWith) return;
    // Arc tangent direction at a point is perpendicular to the radius there.
    const rx = endpoint.at[0] - geometry.center[0];
    const ry = endpoint.at[1] - geometry.center[1];
    const tangentAngle = Math.atan2(rx, -ry); // perpendicular to (rx, ry)
    for (const entity of entities) {
      if (entity.kind !== 'line') continue;
      if (entity.a !== endpoint.coincidentWith && entity.b !== endpoint.coincidentWith) continue;
      const pa = entities.find((x) => x.id === entity.a);
      const pb = entities.find((x) => x.id === entity.b);
      if (!pa || !pb) continue;
      const lineAngle = Math.atan2(pb.at[1] - pa.at[1], pb.at[0] - pa.at[0]);
      let delta = Math.abs(tangentAngle - lineAngle) % Math.PI;
      delta = Math.min(delta, Math.PI - delta);
      if (delta <= (snapAngleDeg * Math.PI) / 180) {
        constraints.push({ kind: 'tangent', line: entity.id, at: label });
        return; // one tangency per endpoint
      }
    }
  };
  tangentAt(s, 'start');
  tangentAt(e, 'end');
  return { start: s, end: e, center: geometry.center, r: geometry.r, ccw: geometry.ccw, constraints };
}

// Project a face outline (sampled polylines in sketch-plane coordinates)
// into fixed construction geometry: new sketches can then snap, chain, and
// dimension against the body's real edges. Collinear runs merge into single
// lines; closed round contours are recognised and become construction
// circles with a radius dimension. Every projected point is fixed, so the
// projection adds zero degrees of freedom.
export function projectOutline(options) {
  const { polylines, idPrefix = 'proj', angleTolDeg = 1.5, gridMm = 0.01 } = options;
  const entities = [];
  const constraints = [];
  let seq = 0;
  let projected = 0;
  const round = (value) => Math.round(value / gridMm) * gridMm;
  for (const raw of polylines || []) {
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const pts = [];
    for (const p of raw) {
      const q = [round(p[0]), round(p[1])];
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-6) pts.push(q);
    }
    let closed = false;
    if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <= 1e-6) {
      pts.pop();
      closed = true;
    }
    if (pts.length < 2) continue;
    if (closed && pts.length >= 8) {
      // Round contour? All samples equidistant from the centroid.
      const cx = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
      const cy = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
      const radii = pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
      const mean = radii.reduce((sum, value) => sum + value, 0) / radii.length;
      if (mean > 1e-6 && radii.every((value) => Math.abs(value - mean) <= Math.max(0.02, mean * 0.005))) {
        const centerId = idPrefix + '-pc' + (seq++);
        const circleId = idPrefix + '-c' + (seq++);
        entities.push({ id: centerId, kind: 'point', at: [round(cx), round(cy)], fixed: true });
        entities.push({ id: circleId, kind: 'circle', center: centerId, r: mean, construction: true });
        constraints.push({ id: circleId + '-r', kind: 'radius', circle: circleId, value: mean });
        projected++;
        continue;
      }
    }
    // Merge collinear runs: keep a vertex only where the contour turns.
    const count = pts.length;
    const kept = [];
    for (let index = 0; index < count; index++) {
      if (!closed && (index === 0 || index === count - 1)) { kept.push(pts[index]); continue; }
      const prev = pts[(index - 1 + count) % count];
      const next = pts[(index + 1) % count];
      const incoming = Math.atan2(pts[index][1] - prev[1], pts[index][0] - prev[0]);
      const outgoing = Math.atan2(next[1] - pts[index][1], next[0] - pts[index][0]);
      let turn = Math.abs(outgoing - incoming) % (Math.PI * 2);
      turn = Math.min(turn, Math.PI * 2 - turn);
      if (turn > (angleTolDeg * Math.PI) / 180) kept.push(pts[index]);
    }
    if (kept.length < 2) continue;
    const pointIds = kept.map((p) => {
      const id = idPrefix + '-p' + (seq++);
      entities.push({ id, kind: 'point', at: [p[0], p[1]], fixed: true });
      return id;
    });
    const segmentCount = closed ? pointIds.length : pointIds.length - 1;
    for (let index = 0; index < segmentCount; index++) {
      entities.push({
        id: idPrefix + '-l' + (seq++),
        kind: 'line',
        a: pointIds[index],
        b: pointIds[(index + 1) % pointIds.length],
        construction: true,
      });
    }
    projected++;
  }
  if (!projected) return null;
  return { entities, constraints, projected };
}

// Mirror entities across an axis line, emitting symmetric constraints so the
// copies stay mirrored under later edits. Expects solved coordinates on the
// entities passed in. Points lying on the axis are reused instead of
// duplicated; pointMap (source point id -> mirrored point id) carries reuse
// across repeated calls in one mirror session.
export function mirrorEntities(options) {
  const { sketch, axisId, entityIds, idPrefix = 'sk', pointMap = new Map() } = options;
  const entities = sketch?.entities || [];
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const axis = byId.get(axisId);
  const axisA = byId.get(axis?.a);
  const axisB = byId.get(axis?.b);
  if (!axis || axis.kind !== 'line' || !axisA || !axisB) return null;
  const dx = axisB.at[0] - axisA.at[0];
  const dy = axisB.at[1] - axisA.at[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len;
  const uy = dy / len;
  const reflect = (p) => {
    const along = (p[0] - axisA.at[0]) * ux + (p[1] - axisA.at[1]) * uy;
    const footX = axisA.at[0] + ux * along;
    const footY = axisA.at[1] + uy * along;
    return [2 * footX - p[0], 2 * footY - p[1]];
  };
  const newEntities = [];
  const newConstraints = [];
  let seq = 0;
  const mirrorPoint = (pointId) => {
    if (pointMap.has(pointId)) return pointMap.get(pointId);
    const source = byId.get(pointId);
    if (!source) return null;
    const at = reflect(source.at);
    if (Math.hypot(at[0] - source.at[0], at[1] - source.at[1]) <= 1e-6) {
      // On the axis: its mirror is itself.
      pointMap.set(pointId, pointId);
      return pointId;
    }
    const id = idPrefix + '-mp' + (seq++);
    newEntities.push({ id, kind: 'point', at });
    newConstraints.push({ kind: 'symmetric', a: pointId, b: id, axis: axisId });
    pointMap.set(pointId, id);
    return id;
  };
  let mirrored = 0;
  for (const entityId of entityIds || []) {
    const entity = byId.get(entityId);
    if (!entity || entityId === axisId) continue;
    if (entity.kind === 'line') {
      const a = mirrorPoint(entity.a);
      const b = mirrorPoint(entity.b);
      if (!a || !b) continue;
      newEntities.push({ id: idPrefix + '-ml' + (seq++), kind: 'line', a, b, ...(entity.construction ? { construction: true } : {}) });
      mirrored++;
    } else if (entity.kind === 'circle') {
      const center = mirrorPoint(entity.center);
      if (!center) continue;
      const id = idPrefix + '-mc' + (seq++);
      newEntities.push({ id, kind: 'circle', center, r: typeof entity.r === 'number' ? entity.r : 1, ...(entity.construction ? { construction: true } : {}) });
      newConstraints.push({ kind: 'equal', a: entityId, b: id });
      mirrored++;
    } else if (entity.kind === 'arc') {
      const center = mirrorPoint(entity.center);
      const a = mirrorPoint(entity.a);
      const b = mirrorPoint(entity.b);
      if (!center || !a || !b) continue;
      // Reflection flips orientation.
      newEntities.push({ id: idPrefix + '-ma' + (seq++), kind: 'arc', center, a, b, ccw: entity.ccw === false, ...(entity.construction ? { construction: true } : {}) });
      mirrored++;
    } else if (entity.kind === 'spline') {
      const through = entity.through.map((pointId) => mirrorPoint(pointId));
      if (through.some((id) => !id)) continue;
      newEntities.push({ id: idPrefix + '-ms' + (seq++), kind: 'spline', through, ...(entity.construction ? { construction: true } : {}) });
      mirrored++;
    }
  }
  if (!mirrored) return null;
  return { entities: newEntities, constraints: newConstraints, mirrored };
}

// Offset a line, circle, or arc: `through` (the second click) picks the side
// and the distance, rounded to the grid. The result is fully defined by ONE
// driving distance dimension; lines get perpendicular construction
// connectors at both ends so the offset direction is pinned without
// redundant equations. Expects solved coordinates. Returns null when the
// pick is degenerate (zero-length line, inward offset swallowing the
// radius).
export function offsetEntity(options) {
  const { sketch, entityId, through, gridMm = 1, idPrefix = 'sk' } = options;
  const entities = sketch?.entities || [];
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const entity = byId.get(entityId);
  if (!entity) return null;
  const round = (value) => Math.max(gridMm, Math.round(value / gridMm) * gridMm);
  if (entity.kind === 'line') {
    const a = byId.get(entity.a);
    const b = byId.get(entity.b);
    if (!a || !b) return null;
    const dx = b.at[0] - a.at[0];
    const dy = b.at[1] - a.at[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    const nx = -dy / len;
    const ny = dx / len;
    const signed = (through[0] - a.at[0]) * nx + (through[1] - a.at[1]) * ny;
    if (Math.abs(signed) < 1e-9) return null;
    const distance = round(Math.abs(signed));
    const side = Math.sign(signed);
    const id = (suffix) => idPrefix + '-' + suffix;
    return {
      distance,
      entities: [
        { id: id('oa'), kind: 'point', at: [a.at[0] + nx * side * distance, a.at[1] + ny * side * distance] },
        { id: id('ob'), kind: 'point', at: [b.at[0] + nx * side * distance, b.at[1] + ny * side * distance] },
        { id: id('og1'), kind: 'line', a: entity.a, b: id('oa'), construction: true },
        { id: id('og2'), kind: 'line', a: entity.b, b: id('ob'), construction: true },
        { id: id('ol'), kind: 'line', a: id('oa'), b: id('ob') },
      ],
      constraints: [
        { kind: 'perpendicular', a: id('og1'), b: entityId },
        { kind: 'perpendicular', a: id('og2'), b: entityId },
        { kind: 'equal', a: id('og1'), b: id('og2') },
        { id: id('odist'), kind: 'distance', a: entity.a, b: id('oa'), value: distance },
      ],
    };
  }
  if (entity.kind === 'circle') {
    const center = byId.get(entity.center);
    const radius = typeof entity.r === 'number' ? entity.r : null;
    if (!center || radius == null || radius <= 0) return null;
    const d = Math.hypot(through[0] - center.at[0], through[1] - center.at[1]);
    const outward = d >= radius;
    const distance = round(Math.abs(d - radius));
    const newRadius = outward ? radius + distance : radius - distance;
    if (newRadius < gridMm / 2) return null;
    const id = (suffix) => idPrefix + '-' + suffix;
    return {
      distance,
      entities: [{ id: id('oc'), kind: 'circle', center: entity.center, r: newRadius }],
      constraints: [{ id: id('or'), kind: 'radius', circle: id('oc'), value: newRadius }],
    };
  }
  if (entity.kind === 'arc') {
    const center = byId.get(entity.center);
    const a = byId.get(entity.a);
    const b = byId.get(entity.b);
    if (!center || !a || !b) return null;
    const radius = Math.hypot(a.at[0] - center.at[0], a.at[1] - center.at[1]);
    if (radius < 1e-9) return null;
    const d = Math.hypot(through[0] - center.at[0], through[1] - center.at[1]);
    const outward = d >= radius;
    const distance = round(Math.abs(d - radius));
    const newRadius = outward ? radius + distance : radius - distance;
    if (newRadius < gridMm / 2) return null;
    const scale = newRadius / radius;
    const radial = (p) => [center.at[0] + (p[0] - center.at[0]) * scale, center.at[1] + (p[1] - center.at[1]) * scale];
    const id = (suffix) => idPrefix + '-' + suffix;
    return {
      distance,
      entities: [
        { id: id('oa'), kind: 'point', at: radial(a.at) },
        { id: id('ob'), kind: 'point', at: radial(b.at) },
        { id: id('og1'), kind: 'line', a: entity.center, b: entity.a, construction: true },
        { id: id('og2'), kind: 'line', a: entity.center, b: entity.b, construction: true },
        { id: id('oarc'), kind: 'arc', center: entity.center, a: id('oa'), b: id('ob'), ccw: entity.ccw !== false },
      ],
      constraints: [
        { kind: 'pointOnLine', point: id('oa'), line: id('og1') },
        { kind: 'pointOnLine', point: id('ob'), line: id('og2') },
        { id: id('odist'), kind: 'distance', a: entity.center, b: id('oa'), value: newRadius },
      ],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trim: remove the clicked span of a curve up to its nearest intersections.

function lineLineIntersection(a1, b1, a2, b2) {
  const d1x = b1[0] - a1[0], d1y = b1[1] - a1[1];
  const d2x = b2[0] - a2[0], d2y = b2[1] - a2[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((a2[0] - a1[0]) * d2y - (a2[1] - a1[1]) * d2x) / denom;
  const s = ((a2[0] - a1[0]) * d1y - (a2[1] - a1[1]) * d1x) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || s < -1e-9 || s > 1 + 1e-9) return null;
  return { t, point: [a1[0] + d1x * t, a1[1] + d1y * t] };
}

function lineCircleIntersections(a, b, center, r) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const fx = a[0] - center[0], fy = a[1] - center[1];
  const A = dx * dx + dy * dy;
  if (A < 1e-12) return [];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const root = Math.sqrt(disc);
  const ts = root < 1e-9 ? [-B / (2 * A)] : [(-B - root) / (2 * A), (-B + root) / (2 * A)];
  return ts
    .filter((t) => t > -1e-9 && t < 1 + 1e-9)
    .map((t) => ({ t, point: [a[0] + dx * t, a[1] + dy * t] }));
}

function circleCircleIntersections(c1, r1, c2, r2) {
  const dx = c2[0] - c1[0], dy = c2[1] - c1[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-9 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const mx = c1[0] + (dx * a) / d;
  const my = c1[1] + (dy * a) / d;
  const points = [[mx + (dy * h) / d, my - (dx * h) / d]];
  if (h > 1e-9) points.push([mx - (dy * h) / d, my + (dx * h) / d]);
  return points;
}

// Angular span of an arc; fraction of an angle within it (null outside).
function arcSpan(center, aPt, bPt, ccw) {
  const start = Math.atan2(aPt[1] - center[1], aPt[0] - center[0]);
  const end = Math.atan2(bPt[1] - center[1], bPt[0] - center[0]);
  let span = end - start;
  if (ccw === false) { while (span >= 0) span -= Math.PI * 2; }
  else { while (span <= 0) span += Math.PI * 2; }
  return { start, span };
}
function arcFractionOf(spanInfo, point, center) {
  const angle = Math.atan2(point[1] - center[1], point[0] - center[0]);
  let along = angle - spanInfo.start;
  if (spanInfo.span < 0) { while (along > 0) along -= Math.PI * 2; }
  else { while (along < 0) along += Math.PI * 2; }
  const fraction = along / spanInfo.span;
  return fraction >= -1e-9 && fraction <= 1 + 1e-9 ? Math.min(1, Math.max(0, fraction)) : null;
}

// Trim the clicked span of entityId out of the sketch. `at` is the click
// (solved coordinates expected on the sketch, as for mirror/offset).
// Returns { entities, constraints, removedEntityIds } — a complete new
// constrained sketch — or null when the click does not resolve to a trim.
export function trimEntityAt(options) {
  const { sketch, entityId, at, idPrefix = 'sk' } = options;
  const entities = sketch?.entities || [];
  const constraints = sketch?.constraints || [];
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const target = byId.get(entityId);
  if (!target || (target.kind !== 'line' && target.kind !== 'circle' && target.kind !== 'arc')) return null;
  const pointOf = (id) => byId.get(id)?.at;
  const radiusOf = (entity) => {
    if (entity.kind === 'circle') return typeof entity.r === 'number' ? entity.r : null;
    const center = pointOf(entity.center);
    const a = pointOf(entity.a);
    return center && a ? Math.hypot(a[0] - center[0], a[1] - center[1]) : null;
  };

  // Geometry of the target in its own parameter space.
  const isLine = target.kind === 'line';
  const lineA = isLine ? pointOf(target.a) : null;
  const lineB = isLine ? pointOf(target.b) : null;
  const center = isLine ? null : pointOf(target.center);
  const radius = isLine ? null : radiusOf(target);
  if (isLine ? !(lineA && lineB) : !(center && radius > 0)) return null;
  const spanInfo = target.kind === 'arc' ? arcSpan(center, pointOf(target.a), pointOf(target.b), target.ccw) : null;
  if (target.kind === 'arc' && !(pointOf(target.a) && pointOf(target.b))) return null;

  const paramOfPoint = (point) => {
    if (isLine) {
      const dx = lineB[0] - lineA[0], dy = lineB[1] - lineA[1];
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) return null;
      return ((point[0] - lineA[0]) * dx + (point[1] - lineA[1]) * dy) / len2;
    }
    if (target.kind === 'arc') return arcFractionOf(spanInfo, point, center);
    // Circle parameter: absolute angle scaled to [0,1).
    const angle = Math.atan2(point[1] - center[1], point[0] - center[0]);
    return (angle < 0 ? angle + Math.PI * 2 : angle) / (Math.PI * 2);
  };
  const pointAtParam = (t) => {
    if (isLine) return [lineA[0] + (lineB[0] - lineA[0]) * t, lineA[1] + (lineB[1] - lineA[1]) * t];
    const angle = target.kind === 'arc' ? spanInfo.start + spanInfo.span * t : t * Math.PI * 2;
    return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius];
  };

  // Collect intersections with every other curve, in target parameter space.
  const cuts = []; // { t, point, cutterId, cutterKind }
  for (const cutter of entities) {
    if (cutter.id === entityId) continue;
    if (cutter.kind !== 'line' && cutter.kind !== 'circle' && cutter.kind !== 'arc') continue;
    const hits = [];
    if (cutter.kind === 'line') {
      const ca = pointOf(cutter.a);
      const cb = pointOf(cutter.b);
      if (!ca || !cb) continue;
      if (isLine) {
        const hit = lineLineIntersection(lineA, lineB, ca, cb);
        if (hit) hits.push(hit.point);
      } else {
        for (const hit of lineCircleIntersections(ca, cb, center, radius)) hits.push(hit.point);
      }
    } else {
      const cc = pointOf(cutter.center);
      const cr = radiusOf(cutter);
      if (!cc || !(cr > 0)) continue;
      const cutterSpan = cutter.kind === 'arc' ? arcSpan(cc, pointOf(cutter.a), pointOf(cutter.b), cutter.ccw) : null;
      const candidates = isLine
        ? lineCircleIntersections(lineA, lineB, cc, cr).map((hit) => hit.point)
        : circleCircleIntersections(center, radius, cc, cr);
      for (const point of candidates) {
        if (cutter.kind === 'arc' && arcFractionOf(cutterSpan, point, cc) == null) continue;
        hits.push(point);
      }
    }
    for (const point of hits) {
      const t = paramOfPoint(point);
      if (t == null) continue;
      // Interior cuts only: intersections at the target's own endpoints do
      // not split anything.
      if (target.kind !== 'circle' && (t < 1e-6 || t > 1 - 1e-6)) continue;
      cuts.push({ t, point, cutterId: cutter.id, cutterKind: cutter.kind });
    }
  }

  const tClick = paramOfPoint(at);
  if (tClick == null) return null;

  const nextEntities = entities.map((entity) => ({ ...entity }));
  const nextConstraints = constraints.map((constraint) => ({ ...constraint }));
  const removedEntityIds = [];
  const referencesEntity = (constraint, id) =>
    constraint.line === id || constraint.circle === id || constraint.axis === id
    || constraint.a === id || constraint.b === id || constraint.point === id;
  const dropConstraintsReferencing = (ids) => {
    for (let index = nextConstraints.length - 1; index >= 0; index--) {
      if (ids.some((id) => referencesEntity(nextConstraints[index], id))) nextConstraints.splice(index, 1);
    }
  };
  const removeEntity = (id) => {
    const index = nextEntities.findIndex((entity) => entity.id === id);
    if (index >= 0) nextEntities.splice(index, 1);
    removedEntityIds.push(id);
  };
  const cleanupOrphanPoints = (candidateIds) => {
    const referenced = new Set();
    for (const entity of nextEntities) {
      if (entity.kind === 'line') { referenced.add(entity.a); referenced.add(entity.b); }
      else if (entity.kind === 'circle') referenced.add(entity.center);
      else if (entity.kind === 'arc') { referenced.add(entity.center); referenced.add(entity.a); referenced.add(entity.b); }
    }
    for (const id of candidateIds) {
      if (referenced.has(id)) continue;
      const index = nextEntities.findIndex((entity) => entity.id === id && entity.kind === 'point');
      if (index >= 0) {
        nextEntities.splice(index, 1);
        dropConstraintsReferencing([id]);
        removedEntityIds.push(id);
      }
    }
  };
  let splitSeq = 0;
  const makeSplitPoint = (cut) => {
    const id = idPrefix + '-tp' + (splitSeq++);
    nextEntities.push({ id, kind: 'point', at: [cut.point[0], cut.point[1]] });
    nextConstraints.push(cut.cutterKind === 'line'
      ? { kind: 'pointOnLine', point: id, line: cut.cutterId }
      : { kind: 'pointOnCircle', point: id, circle: cut.cutterId });
    return id;
  };
  const dropLengthDims = (id) => {
    for (let index = nextConstraints.length - 1; index >= 0; index--) {
      const constraint = nextConstraints[index];
      if (constraint.kind === 'length' && constraint.line === id) nextConstraints.splice(index, 1);
    }
  };
  const finish = () => ({ entities: nextEntities, constraints: nextConstraints, removedEntityIds });

  if (target.kind === 'circle') {
    if (cuts.length < 2) {
      // Nothing to trim against: delete the whole circle.
      removeEntity(entityId);
      dropConstraintsReferencing([entityId]);
      cleanupOrphanPoints([target.center]);
      return finish();
    }
    // Remove the clicked span between the bracketing cuts (wrapping), keep
    // the complement as an arc that RETAINS the circle's id, so radius,
    // concentric, and tangent references survive.
    const sorted = [...cuts].sort((x, y) => x.t - y.t);
    let hiIndex = sorted.findIndex((cut) => cut.t > tClick);
    if (hiIndex === -1) hiIndex = 0; // wrapped
    const loIndex = (hiIndex + sorted.length - 1) % sorted.length;
    const lo = sorted[loIndex];
    const hi = sorted[hiIndex];
    if (lo === hi) return null;
    const startId = makeSplitPoint(hi);
    const endId = makeSplitPoint(lo);
    const self = nextEntities.find((entity) => entity.id === entityId);
    delete self.r;
    self.kind = 'arc';
    self.a = startId;
    self.b = endId;
    self.ccw = true; // from the end of the removed span, counter-clockwise around to its start
    return finish();
  }

  const interior = cuts.filter((cut) => cut.t > 1e-6 && cut.t < 1 - 1e-6).sort((x, y) => x.t - y.t);
  const below = interior.filter((cut) => cut.t < tClick);
  const above = interior.filter((cut) => cut.t > tClick);
  const lo = below.length ? below[below.length - 1] : null;
  const hi = above.length ? above[0] : null;
  if (!lo && !hi) {
    // No intersections: the click deletes the whole entity.
    const ownPoints = isLine ? [target.a, target.b] : [target.center, target.a, target.b];
    removeEntity(entityId);
    dropConstraintsReferencing([entityId]);
    cleanupOrphanPoints(ownPoints);
    return finish();
  }
  const self = nextEntities.find((entity) => entity.id === entityId);
  dropLengthDims(entityId);
  if (lo && hi) {
    // Middle span removed: the original id keeps the lower piece, a new
    // entity carries the upper piece, and the pieces stay geometrically
    // related (H/V copies, else parallel for lines; equal radii for arcs).
    const splitLoId = makeSplitPoint(lo);
    const splitHiId = makeSplitPoint(hi);
    const secondId = idPrefix + '-tt';
    if (isLine) {
      const outerB = self.b;
      self.b = splitLoId;
      nextEntities.push({ id: secondId, kind: 'line', a: splitHiId, b: outerB, ...(target.construction ? { construction: true } : {}) });
      const axisKinds = nextConstraints.filter((constraint) => (constraint.kind === 'horizontal' || constraint.kind === 'vertical') && constraint.line === entityId);
      if (axisKinds.length) {
        for (const constraint of axisKinds) nextConstraints.push({ kind: constraint.kind, line: secondId });
      } else {
        nextConstraints.push({ kind: 'parallel', a: entityId, b: secondId });
      }
    } else {
      const outerB = self.b;
      self.b = splitLoId;
      nextEntities.push({ id: secondId, kind: 'arc', center: self.center, a: splitHiId, b: outerB, ccw: self.ccw, ...(target.construction ? { construction: true } : {}) });
      nextConstraints.push({ kind: 'equal', a: entityId, b: secondId });
    }
    return finish();
  }
  // Span reaches one endpoint: shrink in place, freeing the outer endpoint.
  const cut = lo || hi;
  const splitId = makeSplitPoint(cut);
  const freedEnd = lo ? self.b : self.a;
  if (lo) self.b = splitId; else self.a = splitId;
  cleanupOrphanPoints([freedEnd]);
  return finish();
}

export { DEFAULTS as SKETCH_INFER_DEFAULTS };
