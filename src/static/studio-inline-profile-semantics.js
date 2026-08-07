// Stable creation provenance for schema-5 profiles that still use
// `feature.sketch.shapes` instead of exact sketch entities.
//
// An inline shape is eligible only when it owns an explicit, stable `id`.
// Rectangle edge roles and a circle's curve are construction semantics, not
// topology discovered by traversal or geometry. Polygons additionally need an
// explicit `edgeIds` entry for every segment. If any shape cannot meet that
// contract, conversion fails closed and returns no sources at all.

export const INLINE_PROFILE_SEMANTICS_CODES = Object.freeze({
  duplicateEntityId: 'INLINE_PROFILE_DUPLICATE_ENTITY_ID',
  duplicateShapeId: 'INLINE_PROFILE_DUPLICATE_SHAPE_ID',
  invalidDimension: 'INLINE_PROFILE_INVALID_DIMENSION',
  invalidPoint: 'INLINE_PROFILE_INVALID_POINT',
  invalidStableId: 'INLINE_PROFILE_INVALID_STABLE_ID',
  missingPolyEdgeIds: 'INLINE_PROFILE_MISSING_POLY_EDGE_IDS',
  missingShapeId: 'INLINE_PROFILE_MISSING_SHAPE_ID',
  openPoly: 'INLINE_PROFILE_OPEN_POLY',
  unsupportedShape: 'INLINE_PROFILE_UNSUPPORTED_SHAPE',
});

const RECT_EDGE_ROLES = Object.freeze(['bottom', 'right', 'top', 'left']);
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const encoded = (value) => encodeURIComponent(String(value));

export function inlineRectEdgeSourceId(shapeId, role) {
  if (!RECT_EDGE_ROLES.includes(role)) throw new Error('Unknown rectangle edge role "' + role + '".');
  return 'inline-shape:' + encoded(shapeId) + ':rect-edge:' + role;
}

export function inlineCircleSourceId(shapeId) {
  return 'inline-shape:' + encoded(shapeId) + ':circle';
}

export function inlinePolyEdgeSourceId(shapeId, edgeId) {
  return 'inline-shape:' + encoded(shapeId) + ':poly-edge:' + encoded(edgeId);
}

function diagnostic(code, message, details = {}) {
  return { severity: 'error', code, message, ...details };
}

function stableId(value) {
  return typeof value === 'string' && STABLE_ID_PATTERN.test(value) ? value : null;
}

function evaluatedFinite(value, evaluate) {
  try {
    const result = evaluate(value);
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

function failResult(diagnostics, shapeCount) {
  return Object.freeze({
    complete: false,
    diagnostics: Object.freeze(diagnostics),
    entities: Object.freeze([]),
    shapeCount,
  });
}

// Returns sources in the exact input format consumed by
// studio-topo-naming.js creationNamesForSweep:
//   line   { kind, id, a2, b2 }
//   circle { kind, id, center2, radius }
//
// Entity order follows drawing construction for convenience, but persistent
// identity comes only from the explicit shape/edge ids encoded in each source.
export function inlineProfileCreationSources(shapes, evaluate = Number) {
  const shapeCount = Array.isArray(shapes) ? shapes.length : 0;
  if (!Array.isArray(shapes) || shapes.length === 0) {
    return failResult([
      diagnostic(
        INLINE_PROFILE_SEMANTICS_CODES.unsupportedShape,
        'Inline profile creation provenance requires at least one supported sketch shape.',
      ),
    ], shapeCount);
  }

  const diagnostics = [];
  const entities = [];
  const shapeIds = new Set();
  const entityIds = new Set();

  const addEntity = (entity, shapeId) => {
    if (entityIds.has(entity.id)) {
      diagnostics.push(diagnostic(
        INLINE_PROFILE_SEMANTICS_CODES.duplicateEntityId,
        'Inline profile source ids must be unique.',
        { shapeId, entityId: entity.id },
      ));
      return;
    }
    entityIds.add(entity.id);
    entities.push(entity);
  };

  for (const shape of shapes) {
    const shapeId = stableId(shape?.id);
    if (!shapeId) {
      diagnostics.push(diagnostic(
        shape?.id == null || shape?.id === ''
          ? INLINE_PROFILE_SEMANTICS_CODES.missingShapeId
          : INLINE_PROFILE_SEMANTICS_CODES.invalidStableId,
        shape?.id == null || shape?.id === ''
          ? 'An inline sketch shape has no explicit stable id, so it cannot own persistent topology.'
          : 'An inline sketch shape id does not satisfy the persistent-id contract.',
        { shapeId: shape?.id ?? null, shapeKind: shape?.kind ?? null },
      ));
      continue;
    }
    if (shapeIds.has(shapeId)) {
      diagnostics.push(diagnostic(
        INLINE_PROFILE_SEMANTICS_CODES.duplicateShapeId,
        'Inline sketch shape ids must be unique within a profile.',
        { shapeId, shapeKind: shape?.kind ?? null },
      ));
      continue;
    }
    shapeIds.add(shapeId);

    if (shape.kind === 'rect') {
      const x = evaluatedFinite(shape.x, evaluate);
      const y = evaluatedFinite(shape.y, evaluate);
      const width = evaluatedFinite(shape.w, evaluate);
      const height = evaluatedFinite(shape.h, evaluate);
      if (x == null || y == null || width == null || height == null || width <= 0 || height <= 0) {
        diagnostics.push(diagnostic(
          INLINE_PROFILE_SEMANTICS_CODES.invalidDimension,
          'An inline rectangle needs finite x/y values and positive width/height values.',
          { shapeId, shapeKind: shape.kind },
        ));
        continue;
      }
      const x0 = x - width / 2;
      const x1 = x + width / 2;
      const y0 = y - height / 2;
      const y1 = y + height / 2;
      const edges = [
        { role: 'bottom', a2: [x0, y0], b2: [x1, y0] },
        { role: 'right', a2: [x1, y0], b2: [x1, y1] },
        { role: 'top', a2: [x1, y1], b2: [x0, y1] },
        { role: 'left', a2: [x0, y1], b2: [x0, y0] },
      ];
      for (const edge of edges) {
        addEntity({
          kind: 'line',
          id: inlineRectEdgeSourceId(shapeId, edge.role),
          a2: edge.a2,
          b2: edge.b2,
        }, shapeId);
      }
      continue;
    }

    if (shape.kind === 'circle') {
      const x = evaluatedFinite(shape.x, evaluate);
      const y = evaluatedFinite(shape.y, evaluate);
      const radius = evaluatedFinite(shape.r, evaluate);
      if (x == null || y == null || radius == null || radius <= 0) {
        diagnostics.push(diagnostic(
          INLINE_PROFILE_SEMANTICS_CODES.invalidDimension,
          'An inline circle needs finite center values and a positive radius.',
          { shapeId, shapeKind: shape.kind },
        ));
        continue;
      }
      addEntity({
        kind: 'circle',
        id: inlineCircleSourceId(shapeId),
        center2: [x, y],
        radius,
      }, shapeId);
      continue;
    }

    if (shape.kind === 'poly') {
      if (shape.closed === false) {
        diagnostics.push(diagnostic(
          INLINE_PROFILE_SEMANTICS_CODES.openPoly,
          'An open inline polygon cannot define persistent solid-creation topology.',
          { shapeId, shapeKind: shape.kind },
        ));
        continue;
      }
      const points = Array.isArray(shape.pts) ? shape.pts : [];
      const edgeIds = Array.isArray(shape.edgeIds) ? shape.edgeIds : [];
      if (points.length < 3 || edgeIds.length !== points.length) {
        diagnostics.push(diagnostic(
          INLINE_PROFILE_SEMANTICS_CODES.missingPolyEdgeIds,
          'An inline polygon needs one explicit stable edge id for every closed segment.',
          { shapeId, shapeKind: shape.kind, pointCount: points.length, edgeIdCount: edgeIds.length },
        ));
        continue;
      }
      if (!edgeIds.every((edgeId) => stableId(edgeId))) {
        diagnostics.push(diagnostic(
          INLINE_PROFILE_SEMANTICS_CODES.invalidStableId,
          'An inline polygon edge id does not satisfy the persistent-id contract.',
          { shapeId, shapeKind: shape.kind },
        ));
        continue;
      }
      const evaluatedPoints = [];
      let invalidPoint = false;
      for (const point of points) {
        const x = Array.isArray(point) ? evaluatedFinite(point[0], evaluate) : null;
        const y = Array.isArray(point) ? evaluatedFinite(point[1], evaluate) : null;
        if (x == null || y == null) {
          invalidPoint = true;
          break;
        }
        evaluatedPoints.push([x, y]);
      }
      if (invalidPoint) {
        diagnostics.push(diagnostic(
          INLINE_PROFILE_SEMANTICS_CODES.invalidPoint,
          'An inline polygon contains a non-finite point.',
          { shapeId, shapeKind: shape.kind },
        ));
        continue;
      }
      for (let segment = 0; segment < evaluatedPoints.length; segment++) {
        addEntity({
          kind: 'line',
          id: inlinePolyEdgeSourceId(shapeId, edgeIds[segment]),
          a2: evaluatedPoints[segment],
          b2: evaluatedPoints[(segment + 1) % evaluatedPoints.length],
        }, shapeId);
      }
      continue;
    }

    diagnostics.push(diagnostic(
      INLINE_PROFILE_SEMANTICS_CODES.unsupportedShape,
      'This inline sketch shape kind has no stable creation-provenance contract.',
      { shapeId, shapeKind: shape.kind ?? null },
    ));
  }

  if (diagnostics.length) return failResult(diagnostics, shapeCount);
  return Object.freeze({
    complete: true,
    diagnostics: Object.freeze([]),
    entities: Object.freeze(entities),
    shapeCount,
  });
}

// Build the drawing that corresponds to one eligible inline shape. This keeps
// geometry construction and semantic sources on the same contract. In
// particular, a circle must use replicad's single-curve builder: `drawCircle`
// deliberately creates two semicircles, whose two cylindrical faces cannot be
// assigned stable suffixes without extra provenance.
export function inlineStableShapeDrawing(rc, shape, evaluate = Number) {
  const outcome = inlineProfileCreationSources([shape], evaluate);
  if (!outcome.complete) return Object.freeze({ ...outcome, drawing: null });

  let drawing;
  if (shape.kind === 'rect') {
    const bottom = outcome.entities.find((entity) =>
      entity.id === inlineRectEdgeSourceId(shape.id, 'bottom'));
    const right = outcome.entities.find((entity) =>
      entity.id === inlineRectEdgeSourceId(shape.id, 'right'));
    const width = bottom.b2[0] - bottom.a2[0];
    const height = right.b2[1] - right.a2[1];
    const center = [bottom.a2[0] + width / 2, bottom.a2[1] + height / 2];
    drawing = rc.drawRectangle(width, height).translate(center);
  } else if (shape.kind === 'circle') {
    const circle = outcome.entities[0];
    drawing = rc.drawSingleCircle(circle.radius).translate(circle.center2);
  } else {
    let pen = rc.draw(outcome.entities[0].a2);
    for (const entity of outcome.entities) pen = pen.lineTo(entity.b2);
    drawing = pen.close();
  }
  return Object.freeze({ ...outcome, drawing });
}
