// OpenCascade worker for PartMode.
//
// The UI owns documents, commands, selection and rendering. This worker owns
// the WASM kernel, B-rep shapes, exact rebuilds, topology extraction and
// exports. Every reply carries the caller's request id and document revision;
// the UI is responsible for discarding stale visual results.

let rc = null;
let topo = null;
let offsetFeatureHistory = null;
let profileFeatureHistory = null;
let patternFeatureHistory = null;
let importedTopologyRegistry = null;
let stepImportHealing = null;
let kernelRobustness = null;
let stepImportQueue = Promise.resolve();
let kernelReady = null;
let currentBodyCache = new Map();
let currentAssemblySolutions = new Map();
let currentAssemblySolutionKey = null;
let currentRevision = -1;

import {
  resolveStudioV5Datums,
  resolveStudioV5Transform,
  studioV5OpenSplineBezierSegments,
  studioV5VectorMath,
} from '/static/studio-v5-modeling.js';
import {
  solveStudioV5Assembly,
  studioV5IdentityMatrix as assemblyIdentityMatrix,
  studioV5MultiplyMatrices,
  studioV5RigidInverse,
  studioV5TransformBounds,
  studioV5TransformPoint,
  studioV5TransformVector,
} from '/static/studio-v5-assembly.js';
import { planStudioFeatureRebuild } from '/static/studio-feature-rebuild-plan.js';
import { applyStudioPartConfiguration } from '/static/studio-part-configurations.js';
import { prepareStudioV5Project, STUDIO_V5_PROJECT_LIMITS } from '/static/studio-project-v5.js';
import {
  STUDIO_V5_FEATURE_INPUT_ERROR_CODES,
  assertStudioV5FeatureContract,
  assertStudioV5FeatureStructure,
  assertStudioV5FeatureType,
} from '/static/studio-v5-feature-types.js';
import { canonicalStudioBrepEvidence } from '/static/studio-brep-evidence.js';
import { createStudioOffsetFeatureHistory } from '/static/studio-offset-feature-history.js';
import { createStudioProfileFeatureHistory } from '/static/studio-profile-feature-history.js';
import { createStudioPatternFeatureHistory } from '/static/studio-pattern-feature-history.js';
import { createStudioImportedTopologyRegistry } from '/static/studio-imported-topology-registry.js';
import { inlineProfileCreationSources, inlineStableShapeDrawing } from '/static/studio-inline-profile-semantics.js';
import { createStudioTopoNaming } from '/static/studio-topo-naming.js';
import { resolveTopologyReference } from '/static/studio-topology-reference-resolver.js';
import { derivePersistentVertexNames } from '/static/studio-topology-vertices.js';
import {
  assemblyDrawingCanonicalFingerprint,
  createAssemblyDrawingPlan,
  finalizeAssemblyDrawingAnnotations,
} from '/static/studio-assembly-drawing-plan.js';
import { studioV5CanonicalHash, studioV5Sha256Hex } from '/static/studio-v5-runtime-document.js';
import { createStudioStepImportHealing } from '/static/studio-step-import-healing.js';
import {
  STUDIO_KERNEL_ROBUSTNESS_SCHEMA,
  STUDIO_TANGENT_FILLET_POLICY,
  createStudioKernelRobustness,
  hasStudioExactTangentFilletPolicy,
} from '/static/studio-kernel-robustness.js';
import { normalizeStepExportBlob } from '/static/studio-step-normalization.js';
import { evaluateStudioExpression } from '/static/studio-expression.js';
import { createStudioAnalyticMateSignature } from '/static/studio-analytic-mate-reference.js';
import { studioAssemblyEditContextDisplayProject } from '/static/studio-assembly-edit-context.js';
import { assertStudioHoleWizardFeature } from '/static/studio-hole-wizard.js';
import {
  createStandardPartProject,
  selectStandardFastenerCatalogStack,
} from '/static/studio-standard-parts.js';
import {
  STUDIO_SMART_FASTENER_FACE_NAMES,
  STUDIO_SMART_FASTENER_POLICY_ID,
  STUDIO_SMART_FASTENER_PLAN_SCHEMA,
  assertStudioSmartFastenerPlan,
  assertStudioSmartFastenersProject,
  studioSmartFastenerPlanFingerprint,
} from '/static/studio-smart-fasteners.js';
import {
  STUDIO_ASSEMBLY_FEATURE_EVIDENCE_SCHEMA,
  assertStudioAssemblyFeaturesProject,
} from '/static/studio-assembly-features.js';
import {
  STUDIO_THREAD_COSMETIC_TURN_LIMIT,
  STUDIO_THREAD_EVIDENCE_SCHEMA,
  assertStudioThreadFeature,
  studioThreadResolveAxialSpan,
} from '/static/studio-thread.js';
import { assertStudioStructuralMemberPart } from '/static/studio-structural-members.js';
import {
  assertStudioSheetMetalPart,
  studioSheetMetalEdgeSectionArea,
  studioSheetMetalReliefArea,
  studioSheetMetalSegmentEntityId,
} from '/static/studio-sheet-metal.js';
import { assertStudioWeldmentTreatmentPart } from '/static/studio-structural-treatments.js';
import { assertStudioWeldBeadPart } from '/static/studio-weld-beads.js';
import {
  STUDIO_CONSTRAINED_2D_ROLE,
  resolveStudioConstrainedSketch,
} from '/static/studio-sketch-instances.js';
import {
  STUDIO_VARIABLE_PATTERN_DIMENSION_FIELDS,
  studioFillPatternLattice,
} from '/static/studio-advanced-patterns.js';
import { STUDIO_DIRECT_EDIT_MAX_DISTANCE_MM } from '/static/studio-direct-edit.js';

function loadKernel() {
  if (kernelReady) return kernelReady;
  self.postMessage({ kind: 'kernel-status', status: 'loading' });
  kernelReady = (async () => {
    const [replicad, ocFactory] = await Promise.all([
      import('/static/vendor/replicad.module.js'),
      import('/static/vendor/replicad-oc.module.js'),
    ]);
    const OC = await ocFactory.default({
      locateFile: () => '/static/vendor/replicad_single.wasm',
    });
    replicad.setOC(OC);
    rc = replicad;
    try { topo = createStudioTopoNaming(replicad); } catch { topo = null; }
    offsetFeatureHistory = createStudioOffsetFeatureHistory(replicad);
    profileFeatureHistory = createStudioProfileFeatureHistory(replicad);
    patternFeatureHistory = createStudioPatternFeatureHistory(replicad);
    importedTopologyRegistry = createStudioImportedTopologyRegistry(replicad);
    stepImportHealing = createStudioStepImportHealing(replicad);
    kernelRobustness = createStudioKernelRobustness(replicad);
    self.postMessage({ kind: 'kernel-status', status: 'ready' });
    return replicad;
  })();
  kernelReady.catch((error) => {
    self.postMessage({
      kind: 'kernel-status',
      status: 'failed',
      message: String(error?.message || error),
    });
  });
  return kernelReady;
}

function evalExpr(input, params, allowedNames = null) {
  return evaluateStudioExpression(input, (name) => {
    if (!(name in params)) throw new Error('unknown parameter "' + name + '"');
    return params[name];
  }, allowedNames ? { allowedNames } : {});
}

function evaluator(document, activeDefinition = null) {
  const entries = [
    ...(document.parameters || []),
    ...(activeDefinition?.parameters || (document.partDefinitions || []).find((part) => part.id === document.rootDocument?.partId)?.parameters || []),
  ];
  const rawParams = Object.fromEntries(entries.map((param) => [param.name, param.value]));
  const allowedParameterNames = new Set(Object.keys(rawParams));
  const resolvedParams = {};
  const resolving = new Set();
  const params = new Proxy(resolvedParams, {
    has: (_target, name) => typeof name === 'string' && name in rawParams,
    get: (_target, name) => {
      if (typeof name !== 'string') return undefined;
      if (name in resolvedParams) return resolvedParams[name];
      if (!(name in rawParams)) return undefined;
      if (resolving.has(name)) throw new Error('cyclic parameter "' + name + '"');
      resolving.add(name);
      const value = evalExpr(rawParams[name], params, allowedParameterNames);
      resolving.delete(name);
      resolvedParams[name] = value;
      return value;
    },
  });
  const strict = (value) => evalExpr(value, params, allowedParameterNames);
  const safe = (value, fallback) => {
    try {
      return strict(value);
    } catch {
      return fallback ?? 0;
    }
  };
  return { strict, safe };
}

function evaluatedFeatureValue(value, N, code, label) {
  let evaluated;
  try {
    evaluated = N(value);
  } catch (error) {
    throw codedFeatureError(code, label + ' must evaluate to a finite number; no geometry was published.', {
      cause: String(error?.message || error),
    });
  }
  if (!Number.isFinite(evaluated)) {
    throw codedFeatureError(code, label + ' must evaluate to a finite number; no geometry was published.');
  }
  return evaluated;
}

function positiveFeatureValue(value, N, code, label) {
  const evaluated = evaluatedFeatureValue(value, N, code, label);
  if (!(evaluated > 0)) {
    throw codedFeatureError(code, label + ' must evaluate above zero; no geometry was published.', { evaluatedValue: evaluated });
  }
  return evaluated;
}

function classicProfileShapeValues(feature, N) {
  for (const [index, shape] of (feature.sketch?.shapes || []).entries()) {
    const label = (feature.name || feature.type || 'Feature') + ' profile shape ' + index;
    if (shape?.kind === 'rect') {
      evaluatedFeatureValue(shape.x, N, STUDIO_V5_FEATURE_INPUT_ERROR_CODES.profileDimension, label + ' X');
      evaluatedFeatureValue(shape.y, N, STUDIO_V5_FEATURE_INPUT_ERROR_CODES.profileDimension, label + ' Y');
      positiveFeatureValue(shape.w, N, STUDIO_V5_FEATURE_INPUT_ERROR_CODES.profileDimension, label + ' width');
      positiveFeatureValue(shape.h, N, STUDIO_V5_FEATURE_INPUT_ERROR_CODES.profileDimension, label + ' height');
    } else if (shape?.kind === 'circle') {
      evaluatedFeatureValue(shape.x, N, STUDIO_V5_FEATURE_INPUT_ERROR_CODES.profileDimension, label + ' center X');
      evaluatedFeatureValue(shape.y, N, STUDIO_V5_FEATURE_INPUT_ERROR_CODES.profileDimension, label + ' center Y');
      positiveFeatureValue(shape.r, N, STUDIO_V5_FEATURE_INPUT_ERROR_CODES.profileDimension, label + ' radius');
    } else if (shape?.kind === 'poly') {
      for (const [pointIndex, point] of (shape.pts || []).entries()) {
        if (!Array.isArray(point) || point.length !== 2) {
          throw codedFeatureError(
            STUDIO_V5_FEATURE_INPUT_ERROR_CODES.profileDimension,
            label + ' point ' + pointIndex + ' must contain exactly two coordinates; no geometry was published.',
          );
        }
        point.forEach((coordinate, coordinateIndex) => evaluatedFeatureValue(
          coordinate,
          N,
          STUDIO_V5_FEATURE_INPUT_ERROR_CODES.profileDimension,
          label + ' point ' + pointIndex + ' coordinate ' + coordinateIndex,
        ));
      }
    }
  }
  for (const [index, entity] of (feature.sketch?.entities || []).entries()) {
    if (entity?.kind === 'circle') positiveFeatureValue(
      entity.radius,
      N,
      STUDIO_V5_FEATURE_INPUT_ERROR_CODES.profileDimension,
      (feature.name || feature.type || 'Feature') + ' circle entity ' + index + ' radius',
    );
  }
}

function exactSketchPatternCount(pattern, N) {
  const count = evaluatedFeatureValue(
    pattern?.n,
    N,
    STUDIO_V5_FEATURE_INPUT_ERROR_CODES.sketchPatternCount,
    'Sketch pattern count',
  );
  if (!Number.isInteger(count) || count < 2 || count > 100) {
    throw codedFeatureError(
      STUDIO_V5_FEATURE_INPUT_ERROR_CODES.sketchPatternCount,
      'Sketch pattern count must evaluate to an integer from 2 to 100; no geometry was published.',
      { evaluatedValue: count },
    );
  }
  return count;
}

function exactExtrusionDepth(feature, N) {
  if (feature.type === 'cut' && feature.through === true) return 0;
  return positiveFeatureValue(
    feature.h,
    N,
    STUDIO_V5_FEATURE_INPUT_ERROR_CODES.extrusionDepth,
    feature.type === 'cut' ? 'Cut depth' : 'Extrude depth',
  );
}

function patternedDrawing(drawing, pattern, N, NS) {
  if (!pattern) return drawing;
  const count = exactSketchPatternCount(pattern, N);
  if (count <= 1) return drawing;
  let result = drawing;
  for (let i = 1; i < count; i++) {
    result = result.fuse(
      pattern.kind === 'circular'
        ? drawing.rotate((360 / count) * i, [N(pattern.cx ?? 0), N(pattern.cy ?? 0)])
        : drawing.translate(N(pattern.dx ?? 0) * i, N(pattern.dy ?? 0) * i),
    );
  }
  return result;
}

function shapeToDrawing(shape, N) {
  if (shape.kind === 'rect') {
    return rc.drawRectangle(N(shape.w), N(shape.h)).translate(N(shape.x), N(shape.y));
  }
  if (shape.kind === 'circle') {
    return rc.drawCircle(N(shape.r)).translate(N(shape.x), N(shape.y));
  }
  if (shape.kind === 'poly') {
    let pen = rc.draw([shape.pts[0][0], shape.pts[0][1]]);
    for (let i = 1; i < shape.pts.length; i++) pen = pen.lineTo([shape.pts[i][0], shape.pts[i][1]]);
    return pen.close();
  }
  throw new Error('unknown shape');
}

const sameSketchPoint = (left, right) => Math.abs(left[0] - right[0]) <= 1e-9 && Math.abs(left[1] - right[1]) <= 1e-9;
const sameSketchExpressionPoint = (left, right, N) => sameSketchPoint(left.map(N), right.map(N));

function sketchEntityEnds(entity) {
  if (entity.kind === 'line') return [entity.a, entity.b];
  if (entity.kind === 'arc') return [entity.start, entity.end];
  if (entity.kind === 'spline') return [entity.through[0], entity.through[entity.through.length - 1]];
  return null;
}

// Twin of catmullRomBeziers in studio-sketch-solver.js — keep in sync. The
// worker cannot import the solver module (it ships standalone), so the
// spline-to-bezier conversion is duplicated here verbatim.
function sketchSplineBeziers(points) {
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

function sketchSplinePoints(entity, reversed, N, stepsPerSegment = 16) {
  const through = entity.through.map((point) => point.map(N));
  const ordered = reversed ? [...through].reverse() : through;
  const segments = sketchSplineBeziers(ordered);
  const out = [ordered[0]];
  for (const segment of segments) {
    for (let step = 1; step <= stepsPerSegment; step++) {
      const t = step / stepsPerSegment;
      const u = 1 - t;
      out.push([
        u * u * u * segment.a[0] + 3 * u * u * t * segment.c1[0] + 3 * u * t * t * segment.c2[0] + t * t * t * segment.b[0],
        u * u * u * segment.a[1] + 3 * u * u * t * segment.c1[1] + 3 * u * t * t * segment.c2[1] + t * t * t * segment.b[1],
      ]);
    }
  }
  return out;
}

function traceSketchEntityLoop(entities, N) {
  if (!entities.length) throw new Error('exact sketch profile loop is empty');
  const remaining = [...entities];
  const first = remaining.shift();
  const firstEnds = sketchEntityEnds(first);
  if (!firstEnds) throw new Error('exact sketch profile contains a non-chain entity');
  const traced = [{ entity: first, reversed: false }];
  let current = firstEnds[1];
  while (remaining.length) {
    const index = remaining.findIndex((entity) => {
      const ends = sketchEntityEnds(entity);
      return ends && (sameSketchExpressionPoint(ends[0], current, N) || sameSketchExpressionPoint(ends[1], current, N));
    });
    if (index < 0) throw new Error('exact sketch profile does not form one connected loop');
    const entity = remaining.splice(index, 1)[0];
    const ends = sketchEntityEnds(entity);
    const reversed = sameSketchExpressionPoint(ends[1], current, N);
    traced.push({ entity, reversed });
    current = reversed ? ends[0] : ends[1];
  }
  if (!sameSketchExpressionPoint(current, firstEnds[0], N)) throw new Error('exact sketch profile loop is open');
  return traced;
}

function sketchArcPoints(entity, reversed, N, count = 48) {
  const start = reversed ? entity.end : entity.start;
  const end = reversed ? entity.start : entity.end;
  const clockwise = reversed ? entity.clockwise !== true : entity.clockwise === true;
  const center = entity.center.map(N);
  const evaluatedStart = start.map(N);
  const evaluatedEnd = end.map(N);
  const startAngle = Math.atan2(evaluatedStart[1] - center[1], evaluatedStart[0] - center[0]);
  const endAngle = Math.atan2(evaluatedEnd[1] - center[1], evaluatedEnd[0] - center[0]);
  let delta = endAngle - startAngle;
  if (clockwise) while (delta >= 0) delta -= Math.PI * 2;
  else while (delta <= 0) delta += Math.PI * 2;
  const radius = Math.hypot(evaluatedStart[0] - center[0], evaluatedStart[1] - center[1]);
  return Array.from({ length: count + 1 }, (_, index) => {
    const angle = startAngle + delta * index / count;
    return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius];
  });
}

function sketchTracePolygon(traced, N) {
  const points = [];
  for (const { entity, reversed } of traced) {
    if (entity.kind === 'line') {
      const ends = sketchEntityEnds(entity);
      const start = (reversed ? ends[1] : ends[0]).map(N);
      const end = (reversed ? ends[0] : ends[1]).map(N);
      if (!points.length) points.push(start);
      points.push(end);
    } else if (entity.kind === 'spline') {
      const sampled = sketchSplinePoints(entity, reversed, N);
      if (!points.length) points.push(sampled[0]);
      points.push(...sampled.slice(1));
    } else {
      const arc = sketchArcPoints(entity, reversed, N);
      if (!points.length) points.push(arc[0]);
      points.push(...arc.slice(1));
    }
  }
  if (points.length > 1 && sameSketchPoint(points[0], points.at(-1))) points.pop();
  return points;
}

function sketchTraceDrawing(traced, N) {
  const first = traced[0];
  const firstEnds = sketchEntityEnds(first.entity);
  const start = (first.reversed ? firstEnds[1] : firstEnds[0]).map(N);
  let pen = rc.draw(start);
  for (const { entity, reversed } of traced) {
    const ends = sketchEntityEnds(entity);
    const end = (reversed ? ends[0] : ends[1]).map(N);
    if (entity.kind === 'line') {
      pen = pen.lineTo(end);
    } else if (entity.kind === 'spline') {
      const through = entity.through.map((point) => point.map(N));
      const ordered = reversed ? [...through].reverse() : through;
      for (const segment of sketchSplineBeziers(ordered)) {
        pen = pen.bezierCurveTo(segment.b, [segment.c1, segment.c2]);
      }
    } else {
      pen = pen.threePointsArcTo(end, sketchArcPoints(entity, reversed, N, 2)[1]);
    }
  }
  return pen.close();
}

function polygonCentroid(points) {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current[0] * next[1] - next[0] * current[1];
    twiceArea += cross;
    x += (current[0] + next[0]) * cross;
    y += (current[1] + next[1]) * cross;
  }
  if (Math.abs(twiceArea) <= 1e-12) {
    return points.reduce((sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0]);
  }
  return [x / (3 * twiceArea), y / (3 * twiceArea)];
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current];
    const b = polygon[previous];
    if (((a[1] > point[1]) !== (b[1] > point[1])) &&
      point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function polygonInteriorProbe(polygon) {
  let signedArea = 0;
  let scale = 0;
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    signedArea += current[0] * next[1] - next[0] * current[1];
    scale = Math.max(scale, Math.abs(current[0]), Math.abs(current[1]));
  }
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const dx = next[0] - current[0];
    const dy = next[1] - current[1];
    const length = Math.hypot(dx, dy);
    if (length <= 1e-12) continue;
    const direction = signedArea >= 0 ? 1 : -1;
    const offset = Math.max(1, scale) * 1e-7;
    return [
      (current[0] + next[0]) / 2 - direction * dy / length * offset,
      (current[1] + next[1]) / 2 + direction * dx / length * offset,
    ];
  }
  return polygonCentroid(polygon);
}

function exactSketchLoopRecords(sketch, N) {
  const entities = sketch.entities.filter((entity) => entity.construction !== true);
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const used = new Set();
  const loops = [];
  for (const entity of entities) {
    if (entity.kind !== 'circle') continue;
    const center = entity.center.map(N);
    const radius = N(entity.radius);
    const polygon = Array.from({ length: 64 }, (_, index) => {
      const angle = Math.PI * 2 * index / 64;
      return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius];
    });
    loops.push({
      profileId: 'sketch-profile:circle:' + entity.id,
      traced: [{ entity, reversed: false }],
      // One exact circle entity is one periodic semantic source. The ordinary
      // drawCircle helper deliberately constructs two semicircles, which
      // yields two indistinguishable cylindrical side faces after extrusion
      // and therefore cannot own one persistent entity name fail-closed.
      drawing: rc.drawSingleCircle(radius).translate(center),
      polygon,
    });
    used.add(entity.id);
  }
  for (const group of sketch.groups || []) {
    const grouped = group.entityIds.map((id) => byId.get(id)).filter(Boolean);
    if (!grouped.length || grouped.some((entity) => entity.kind === 'circle')) continue;
    const traced = traceSketchEntityLoop(grouped, N);
    loops.push({
      profileId: 'sketch-profile:group:' + group.id,
      traced,
      drawing: sketchTraceDrawing(traced, N),
      polygon: sketchTracePolygon(traced, N),
    });
    grouped.forEach((entity) => used.add(entity.id));
  }
  const remaining = entities.filter((entity) => !used.has(entity.id));
  while (remaining.length) {
    const chain = [remaining.shift()];
    const firstEnds = sketchEntityEnds(chain[0]);
    let current = firstEnds[1];
    while (!sameSketchExpressionPoint(current, firstEnds[0], N)) {
      const index = remaining.findIndex((entity) => {
        const ends = sketchEntityEnds(entity);
        return ends && (sameSketchExpressionPoint(ends[0], current, N) || sameSketchExpressionPoint(ends[1], current, N));
      });
      if (index < 0) throw new Error('exact sketch profile contains an open loop');
      const entity = remaining.splice(index, 1)[0];
      const ends = sketchEntityEnds(entity);
      current = sameSketchExpressionPoint(ends[0], current, N) ? ends[1] : ends[0];
      chain.push(entity);
    }
    const traced = traceSketchEntityLoop(chain, N);
    const semanticEntitySet = traced.map(({ entity }) => encodeURIComponent(entity.id)).sort().join('/');
    loops.push({
      profileId: 'sketch-profile:loop:' + semanticEntitySet,
      traced,
      drawing: sketchTraceDrawing(traced, N),
      polygon: sketchTracePolygon(traced, N),
    });
  }
  if (!loops.length) throw new Error('exact sketch contains no closed non-construction profile');
  loops.forEach((loop) => {
    const point = polygonInteriorProbe(loop.polygon);
    loop.depth = loops.filter((candidate) => candidate !== loop && pointInPolygon(point, candidate.polygon)).length;
  });
  return loops;
}

function exactSketchDrawings(sketch, N) {
  const loops = exactSketchLoopRecords(sketch, N);
  return loops.filter((loop) => loop.depth % 2 === 0).map((outer) => {
    let drawing = outer.drawing;
    for (const hole of loops.filter((loop) => loop.depth === outer.depth + 1 && pointInPolygon(polygonInteriorProbe(loop.polygon), outer.polygon))) {
      drawing = drawing.cut(hole.drawing);
    }
    return drawing;
  });
}

function featureProfileDrawings(feature, N, NS) {
  if (feature.extensions?.exactSketchEntities && Array.isArray(feature.sketch?.entities)) {
    return exactSketchDrawings(feature.sketch, N).map((drawing) => patternedDrawing(drawing, feature.pattern, N, NS));
  }
  return feature.sketch.shapes.map((shape) => {
    // An explicitly identified inline shape participates in the stable
    // semantic-source contract. Use the matching construction primitive too:
    // drawSingleCircle produces one cylindrical source, whereas drawCircle
    // splits it into indistinguishable semicylinders.
    const stable = typeof shape?.id === 'string' && shape.id.trim()
      ? inlineStableShapeDrawing(rc, shape, N)
      : null;
    const drawing = stable?.complete ? stable.drawing : shapeToDrawing(shape, N);
    return patternedDrawing(drawing, feature.pattern, N, NS);
  });
}

function resolvedConstrainedExecutionFeature(part, feature, N) {
  if (!feature.sketchId) return null;
  const sketch = (part?.sketches || []).find((entry) => entry.id === feature.sketchId);
  if (sketch?.extensions?.studioRole !== STUDIO_CONSTRAINED_2D_ROLE) return null;
  if (feature.type !== 'extrude' && feature.type !== 'cut') {
    throw new Error('First-class constrained sketches currently support exact Extrude and Cut only.');
  }
  if (feature.onFace !== undefined) {
    throw new Error('A first-class constrained sketch cannot be reinterpreted on an unrelated face.');
  }
  const resolved = resolveStudioConstrainedSketch(part, sketch.id, {
    evaluate: N,
    requireClosedProfile: true,
  });
  if (resolved.exactEntities.some((entity) => entity.kind === 'spline')) {
    throw new Error('First-class spline profiles require exact spline side-face naming before solid execution.');
  }
  return {
    ...feature,
    sketch: {
      id: sketch.id,
      z: sketch.z ?? 0,
      entities: resolved.exactEntities,
      shapes: [],
    },
    plane: { kind: 'base', plane: sketch.plane },
    extensions: { ...(feature.extensions || {}), exactSketchEntities: true },
  };
}

function basePlaneNormal(plane) {
  if (plane === 'YZ') return [1, 0, 0];
  if (plane === 'ZX') return [0, 1, 0];
  return [0, 0, 1];
}

// Offset of a feature's sketch plane along its base-plane normal. `sketch.z` is
// a dimension like every other, so it may be a parameter expression. Evaluate
// it with the strict evaluator rather than reading the raw value, which used to
// leave an expression as a string and silently place the sketch at z=0.
function sketchPlaneOffset(feature, N) {
  const z = feature.sketch?.z;
  if (z == null || z === '') return 0;
  const offset = N(z);
  if (!Number.isFinite(offset)) throw new Error('the sketch plane offset must evaluate to a number');
  return offset;
}

function topOf(shape) {
  let boundingBox = null;
  try {
    boundingBox = shape.boundingBox;
    const bounds = boundingBox?.bounds;
    if (Array.isArray(bounds) && bounds.length === 2) return bounds[1][2];
    if (Array.isArray(bounds) && bounds.length === 6) return bounds[5];
  } catch {}
  finally { safeDelete(boundingBox); }
  return 1000;
}

function exactShapeBoundsCenter(shape, label) {
  let boundingBox = null;
  try {
    boundingBox = shape?.boundingBox;
    const bounds = boundingBox?.bounds;
    if (
      !Array.isArray(bounds)
      || bounds.length !== 2
      || bounds.some((corner) => !Array.isArray(corner) || corner.length !== 3 || corner.some((value) => !Number.isFinite(value)))
    ) {
      throw new Error(label + ' exact target bounds are unavailable; no geometry was published.');
    }
    return bounds[0].map((value, index) => (value + bounds[1][index]) / 2);
  } finally {
    safeDelete(boundingBox);
  }
}

function optimalShapeBounds(shape, label = 'Shape') {
  const oc = rc.getOC();
  let boundingBox = null;
  try {
    boundingBox = new oc.Bnd_Box_1();
    oc.BRepBndLib.AddOptimal(shape.wrapped, boundingBox, false, false);
    const xMin = { current: 0 }; const yMin = { current: 0 }; const zMin = { current: 0 };
    const xMax = { current: 0 }; const yMax = { current: 0 }; const zMax = { current: 0 };
    boundingBox.Get(xMin, yMin, zMin, xMax, yMax, zMax);
    const bounds = [
      [xMin.current, yMin.current, zMin.current],
      [xMax.current, yMax.current, zMax.current],
    ];
    if (bounds.flat().some((value) => !Number.isFinite(value))) throw new Error(label + ' optimal bounds are non-finite.');
    return bounds;
  } finally {
    safeDelete(boundingBox);
  }
}

function pointTuple(point, label) {
  const tuple = [point?.x ?? point?.[0], point?.y ?? point?.[1], point?.z ?? point?.[2]];
  if (tuple.some((value) => !Number.isFinite(value))) throw new Error(label + ' is not a finite exact point.');
  return tuple;
}

function studioHoleWizardPlacement(feature, accumulated, N) {
  const definition = assertStudioHoleWizardFeature(feature);
  if (!accumulated) throw new Error('Hole Wizard requires one exact target body.');
  const normal = [0, 0, 1];
  let authoredPlane = null;
  let worldCenter = null;
  try {
    authoredPlane = rc.makePlane('XY', [0, 0, sketchPlaneOffset(feature, N)]);
    worldCenter = authoredPlane.toWorldCoords(definition.center);
    const origin = pointTuple(worldCenter, 'Hole Wizard center');
    const targetCenter = exactShapeBoundsCenter(accumulated, 'Hole Wizard');
    const towardTarget = targetCenter.reduce((sum, value, index) => sum + (value - origin[index]) * normal[index], 0);
    const targetScale = Math.max(1, ...targetCenter.map(Math.abs), ...origin.map(Math.abs));
    if (Math.abs(towardTarget) <= targetScale * 1e-10) {
      throw new Error('Hole Wizard recess plane crosses the target center; choose an exterior support plane.');
    }
    const inward = normal.map((value) => value * (towardTarget > 0 ? 1 : -1));
    return { definition, origin, inward, targetScale };
  } finally {
    safeDelete(worldCenter);
    safeDelete(authoredPlane);
  }
}

// The persisted Hole Wizard remains one normal Cut feature. Its pilot uses
// the regular Through All path above; this helper adds only the exact
// counterbore/countersink envelope to the Boolean tool. The recess direction
// is derived from the target body's exact bounds, so top and bottom XY
// placements both cut inward without a UI-only direction flag.
function studioHoleWizardRecess(feature, accumulated, N) {
  const placement = studioHoleWizardPlacement(feature, accumulated, N);
  const { definition, origin, inward, targetScale } = placement;
  if (definition.kind !== 'counterbore' && definition.kind !== 'countersink') return null;
  const outwardMargin = Math.max(1.6e-6, targetScale * Number.EPSILON * 256);
  const outerOrigin = origin.map((value, index) => value - inward[index] * outwardMargin);
  const dimensions = definition.dimensions;
  if (definition.kind === 'counterbore') {
    return rc.makeCylinder(
      dimensions.recessDiameter / 2,
      dimensions.recessDepth + outwardMargin,
      outerOrigin,
      inward,
    );
  }
  const bottom = origin.map((value, index) => value + inward[index] * dimensions.recessDepth);
  const radialExtension = outwardMargin * Math.tan((dimensions.includedAngleDegrees / 2) * Math.PI / 180);
  // A revolved radial section preserves the conical/pilot junction as one
  // authoritative circular edge. A two-wire loft represents the same solid
  // but splits that circle into indistinguishable semicircles, which cannot
  // satisfy exact persistent-topology identity.
  let cone = rc.draw([dimensions.pilotDiameter / 2, bottom[2]])
    .lineTo([dimensions.recessDiameter / 2 + radialExtension, outerOrigin[2]])
    .lineTo([0, outerOrigin[2]])
    .lineTo([0, bottom[2]])
    .close()
    .sketchOnPlane('XZ')
    .revolve([0, 0, 1]);
  cone = cone.translate([origin[0], origin[1], 0]);
  return cone;
}

// A Through All tool is a property of the current target, not a magic model
// size. Project the target's exact OCCT bounding box into the authored sketch
// frame and extend both caps by a strict, scale-aware margin. The projection
// of all eight box corners is conservative for every B-rep inside the box,
// including a support face whose normal is not aligned with a base plane.
//
// Returning the shifted plane as well as the extent gives solid construction,
// creation naming and sketch-pattern transforms one authoritative placement.
// No caller is allowed to reconstruct either cap independently.
function throughAllCutSweep(target, authoredPlane, authoredNormal) {
  if (!target || !authoredPlane) {
    throw new Error('Through All Cut requires one exact target body and one authored sketch plane.');
  }
  const normalLength = Math.hypot(...authoredNormal);
  if (!(normalLength > 1e-12) || !Number.isFinite(normalLength)) {
    throw new Error('Through All Cut sketch-plane normal is degenerate; no geometry was published.');
  }
  const normal = authoredNormal.map((value) => value / normalLength);
  let boundingBox = null;
  let planeOrigin = null;
  try {
    boundingBox = target.boundingBox;
    const bounds = boundingBox?.bounds;
    if (
      !Array.isArray(bounds)
      || bounds.length !== 2
      || bounds.some((corner) => !Array.isArray(corner) || corner.length !== 3 || corner.some((value) => !Number.isFinite(value)))
    ) {
      throw new Error('Through All Cut target bounds are unavailable; no geometry was published.');
    }
    planeOrigin = authoredPlane.toWorldCoords([0, 0]);
    const origin = [planeOrigin.x ?? planeOrigin[0], planeOrigin.y ?? planeOrigin[1], planeOrigin.z ?? planeOrigin[2]];
    if (origin.some((value) => !Number.isFinite(value))) {
      throw new Error('Through All Cut sketch-plane origin is invalid; no geometry was published.');
    }
    const dot = (point) => point[0] * normal[0] + point[1] * normal[1] + point[2] * normal[2];
    const originProjection = dot(origin);
    const projections = [];
    for (const x of [bounds[0][0], bounds[1][0]]) {
      for (const y of [bounds[0][1], bounds[1][1]]) {
        for (const z of [bounds[0][2], bounds[1][2]]) projections.push(dot([x, y, z]));
      }
    }
    const lower = Math.min(...projections) - originProjection;
    const upper = Math.max(...projections) - originProjection;
    const span = upper - lower;
    const scale = Math.max(1, Math.abs(originProjection), ...projections.map(Math.abs), Math.abs(span));
    const margin = Math.max(1.6e-6, Math.abs(span) * 1e-9, scale * Number.EPSILON * 256);
    const startOffset = lower - margin;
    const extent = span + margin * 2;
    if (![startOffset, extent, margin].every(Number.isFinite) || !(extent > 0)) {
      throw new Error('Through All Cut target interval is invalid; no geometry was published.');
    }
    return {
      plane: authoredPlane.translate(normal.map((value) => value * startOffset)),
      normal,
      startOffset,
      extent,
      margin,
    };
  } finally {
    safeDelete(planeOrigin);
    safeDelete(boundingBox);
  }
}

const quantize = (value) => Math.round(value * 100) / 100;

function edgeSignature(edge) {
  let point = null;
  try {
    point = edge.pointAt(0.5);
    const signature = {
      p: [point.x ?? point[0], point.y ?? point[1], point.z ?? point[2]].map(quantize),
      l: quantize(edge.length),
      curveType: edge.geomType,
    };
    if (edge.geomType === 'CIRCLE') {
      let adaptor = null; let circle = null; let location = null;
      try {
        adaptor = edge._geomAdaptor();
        circle = adaptor.Circle();
        location = circle.Location();
        signature.r = quantize(circle.Radius());
        signature.c = [location.X(), location.Y(), location.Z()].map(quantize);
      } catch {}
      finally { safeDelete(location); safeDelete(circle); safeDelete(adaptor); }
    }
    return signature;
  } finally {
    safeDelete(point);
  }
}

function edgeMatches(signature, edge) {
  let point = null;
  try {
    point = edge.pointAt(0.5);
    const candidate = [point.x ?? point[0], point.y ?? point[1], point.z ?? point[2]];
    return (
      Math.abs(edge.length - signature.l) < 0.05 &&
      Math.hypot(candidate[0] - signature.p[0], candidate[1] - signature.p[1], candidate[2] - signature.p[2]) < 0.05
    );
  } finally {
    safeDelete(point);
  }
}

function faceSignature(face) {
  return createStudioAnalyticMateSignature(rc.getOC(), face, quantize);
}

function exactAnalyticFaceSignature(face) {
  const finiteIdentity = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error('Exact analytic face signature contains a non-finite value.');
    return numeric;
  };
  return createStudioAnalyticMateSignature(rc.getOC(), face, finiteIdentity);
}

function faceMatches(signature, face) {
  if (face.geomType !== 'PLANE') return false;
  let center = null;
  let normal = null;
  try {
    center = face.center;
    normal = face.normalAt();
    return (
      Math.hypot(center.x - signature.p[0], center.y - signature.p[1], center.z - signature.p[2]) < 0.05 &&
      normal.x * signature.n[0] + normal.y * signature.n[1] + normal.z * signature.n[2] > 0.999
    );
  } finally {
    safeDelete(normal);
    safeDelete(center);
  }
}

function faceOutline(face) {
  const polygons = [];
  const plane = rc.makePlaneFromFace(face);
  let faceEdges = [];
  try {
    faceEdges = face.edges;
    for (const edge of faceEdges) {
      const points = [];
      for (let i = 0; i <= 8; i++) {
        let point = null;
        let local = null;
        try {
          point = edge.pointAt(i / 8);
          local = plane.toLocalCoords(point);
          points.push([local.x ?? local[0], local.y ?? local[1]]);
        } finally {
          safeDelete(local);
          safeDelete(point);
        }
      }
      polygons.push(points);
    }
  } catch {}
  finally {
    for (const edge of faceEdges) safeDelete(edge);
    safeDelete(plane);
  }
  return polygons;
}

function featureSolid(feature, zTop, accumulated, N, NS, accumulatedNames = []) {
  if (feature?.type !== 'extrude' && feature?.type !== 'cut' && feature?.type !== 'revolve') {
    throw new Error(
      'Feature type "' + String(feature?.type)
        + '" is not a profile-solid constructor and cannot use the extrusion path.',
    );
  }
  classicProfileShapeValues(feature, N);
  const authoredDepth = feature.type === 'extrude' || feature.type === 'cut'
    ? exactExtrusionDepth(feature, N)
    : null;
  let facePlane = null;
  let faceNormal = null;
  if (feature.onFace) {
    if (!accumulated) throw new Error('the picked face no longer exists — edit or delete this feature');
    if (!topo) throw new Error('persistent topology naming is unavailable for this face-attached feature');
    const lookups = topo.nameLookups(accumulated, accumulatedNames);
    try {
      const face = resolveModifierTopologyReference(feature.onFace, 'face', lookups);
      facePlane = rc.makePlaneFromFace(face);
      const normal = face.normalAt();
      try { faceNormal = [normal.x, normal.y, normal.z]; }
      finally { safeDelete(normal); }
    } finally {
      lookups.dispose();
    }
  }
  try {
    const solids = [];
    for (const drawing of featureProfileDrawings(feature, N, NS)) {
    if (feature.type === 'revolve') {
      const plane = feature.plane?.kind === 'base' ? feature.plane.plane : 'XZ';
      const angle = requireExactRevolveAngle(
        feature,
        N,
        'INLINE_REVOLVE_INVALID_ANGLE',
        'Inline-profile Revolve',
      );
      solids.push(drawing.sketchOnPlane(plane).revolve(undefined, { angle: feature.reversed ? -angle : angle }));
    } else if (feature.type === 'cut') {
      const depth = authoredDepth;
      if (facePlane) {
        if (feature.through) {
          const sweep = throughAllCutSweep(accumulated, facePlane, faceNormal);
          try { solids.push(drawing.sketchOnPlane(sweep.plane).extrude(sweep.extent)); }
          finally { safeDelete(sweep.plane); }
        } else {
          solids.push(drawing.sketchOnPlane(facePlane).extrude(feature.reversed ? depth : -depth));
        }
      } else {
        const plane = feature.plane?.kind === 'base' ? feature.plane.plane : 'XY';
        if (feature.through) {
          const normal = basePlaneNormal(plane);
          const authoredPlane = rc.makePlane(plane, normal.map((value) => value * sketchPlaneOffset(feature, N)));
          try {
            const sweep = throughAllCutSweep(accumulated, authoredPlane, normal);
            try { solids.push(drawing.sketchOnPlane(sweep.plane).extrude(sweep.extent)); }
            finally { safeDelete(sweep.plane); }
          } finally {
            safeDelete(authoredPlane);
          }
        } else if (feature.extensions?.exactSketchEntities) {
          const signedDepth = feature.reversed ? -depth : depth;
          const normal = basePlaneNormal(plane);
          const originDistance = (feature.symmetric ? -depth / 2 : 0) + sketchPlaneOffset(feature, N);
          const origin = normal.map((value) => value * originDistance);
          solids.push(drawing.sketchOnPlane(plane, origin).extrude(feature.symmetric ? depth : signedDepth));
        } else {
          const sketch = drawing.sketchOnPlane('XY', (zTop ?? 0) - depth);
          solids.push(sketch.extrude(depth + 1000));
        }
      }
    } else {
      const depth = authoredDepth;
      if (facePlane) {
        solids.push(drawing.sketchOnPlane(facePlane).extrude(feature.reversed ? -depth : depth));
      } else if (feature.extensions?.exactSketchEntities) {
        const plane = feature.plane?.kind === 'base' ? feature.plane.plane : 'XY';
        const normal = basePlaneNormal(plane);
        const originDistance = (feature.symmetric ? -depth / 2 : 0) + sketchPlaneOffset(feature, N);
        const origin = normal.map((value) => value * originDistance);
        solids.push(drawing.sketchOnPlane(plane, origin).extrude(feature.symmetric ? depth : feature.reversed ? -depth : depth));
      } else {
        solids.push(drawing.sketchOnPlane('XY', sketchPlaneOffset(feature, N)).extrude(depth));
      }
    }
    }
    let result = solids[0];
    for (let i = 1; i < solids.length; i++) result = result.fuse(solids[i]);
    if (feature.extensions?.holeWizard) {
      let recess = null;
      try {
        recess = studioHoleWizardRecess(feature, accumulated, N);
        if (recess) {
          const composite = result.fuse(recess);
          safeDelete(result);
          result = composite;
        }
      } finally {
        safeDelete(recess);
      }
    }
    return result;
  } finally {
    safeDelete(facePlane);
  }
}

function studioHoleWizardCreationNameTable(feature, solid, accumulated, N) {
  const { definition, origin, inward, targetScale } = studioHoleWizardPlacement(feature, accumulated, N);
  const names = [];
  names.diagnostics = [];
  const faces = importedTopologyRegistry.exactFaces(solid);
  const roles = new Map();
  const tolerance = Math.max(2e-5, targetScale * 1e-9);
  const localEvidence = (point) => {
    const offset = point.map((value, index) => value - origin[index]);
    const axial = offset.reduce((sum, value, index) => sum + value * inward[index], 0);
    // This bounded slice owns the XY support plane, so radial angle is an
    // authoritative discriminator for OCCT's two semicircular junction edges.
    const angle = Math.atan2(offset[1], offset[0]);
    const radial = Math.hypot(offset[0], offset[1]);
    return { axial, angle, radial };
  };
  const groupedExplicitNames = (records, prefix) => {
    const table = [];
    const grouped = new Map();
    for (const record of records) grouped.set(record.role, [...(grouped.get(record.role) || []), record]);
    for (const [role, matches] of grouped) {
      matches.sort((left, right) => left.angle - right.angle || left.radial - right.radial || left.axial - right.axial);
      matches.forEach((record, index) => table.push({
        name: `${prefix}${feature.id}:hole-wizard:${role}${matches.length > 1 ? ':segment:' + index : ''}`,
        [record.wrapperKey]: record.wrapper.clone(),
      }));
    }
    return table;
  };
  try {
    for (const face of faces) {
      let role = null;
      let signature = null;
      try {
        signature = createStudioAnalyticMateSignature(rc.getOC(), face, (value) => value);
        if (signature.topologyKind === 'cylindrical-face') {
          if (Math.abs(signature.r - definition.dimensions.pilotDiameter / 2) <= tolerance) role = 'pilot-side';
          else if (definition.dimensions.recessDiameter
            && Math.abs(signature.r - definition.dimensions.recessDiameter / 2) <= tolerance) role = 'recess-side';
        } else if (signature.topologyKind === 'conical-face' && definition.kind === 'countersink') {
          role = 'recess-cone';
        } else if (signature.topologyKind === 'planar-face') {
          const axial = signature.p.reduce((sum, value, index) => sum + (value - origin[index]) * inward[index], 0);
          if (axial <= tolerance) role = 'entry-cap';
          else if (definition.kind === 'counterbore'
            && Math.abs(axial - definition.dimensions.recessDepth) <= tolerance) role = 'recess-shoulder';
          else if (axial > (definition.dimensions.recessDepth || 0) + tolerance) role = 'through-cap';
        }
      } catch (error) {
        names.diagnostics.push({
          severity: 'error',
          code: 'HOLE_WIZARD_TOPOLOGY_UNCLASSIFIED',
          message: 'Hole Wizard exact face could not be classified: ' + String(error?.message || error),
        });
      }
      if (!role) {
        names.diagnostics.push({
          severity: 'error',
          code: 'HOLE_WIZARD_TOPOLOGY_UNCLASSIFIED',
          message: 'Hole Wizard exact face has no supported semantic role.',
          topologyKind: signature?.topologyKind || String(face.geomType || 'unknown'),
        });
        continue;
      }
      roles.set(role, [...(roles.get(role) || []), face]);
    }
    for (const [role, matches] of roles) {
      if (matches.length !== 1) {
        names.diagnostics.push({
          severity: 'error',
          code: 'HOLE_WIZARD_TOPOLOGY_AMBIGUOUS',
          message: `Hole Wizard semantic role "${role}" resolves to ${matches.length} exact faces.`,
        });
        continue;
      }
      names.push({ name: `F${feature.id}:hole-wizard:${role}`, face: matches[0].clone() });
    }
    const edges = importedTopologyRegistry.exactEdges(solid);
    try {
      const records = [];
      const recessDepth = definition.dimensions.recessDepth || 0;
      for (const edge of edges) {
        let midpoint = null;
        try {
          midpoint = edge.pointAt(0.5);
          const evidence = localEvidence(pointTuple(midpoint, 'Hole Wizard edge midpoint'));
          let role = null;
          if (edge.geomType === 'CIRCLE') {
            if (evidence.axial <= tolerance) role = 'entry-rim';
            else if (recessDepth > 0 && Math.abs(evidence.axial - recessDepth) <= tolerance) {
              if (definition.kind === 'counterbore') {
                role = Math.abs(evidence.radial - definition.dimensions.recessDiameter / 2) <= tolerance
                  ? 'shoulder-outer-rim'
                  : 'shoulder-inner-rim';
              } else role = 'pilot-junction-rim';
            } else role = 'through-rim';
          } else {
            role = recessDepth > 0 && evidence.axial < recessDepth - tolerance ? 'recess-seam' : 'pilot-seam';
          }
          records.push({ ...evidence, role, wrapperKey: 'edge', wrapper: edge });
        } finally {
          safeDelete(midpoint);
        }
      }
      names.explicitEdgeTable = groupedExplicitNames(records, 'E');
    } finally {
      for (const edge of edges) safeDelete(edge);
    }
    const vertices = importedTopologyRegistry.exactVertices(solid);
    try {
      const records = [];
      const recessDepth = definition.dimensions.recessDepth || 0;
      for (const vertex of vertices) {
        const evidence = localEvidence(vertex.asTuple());
        let role = null;
        if (evidence.axial <= tolerance) role = 'entry-vertex';
        else if (recessDepth > 0 && Math.abs(evidence.axial - recessDepth) <= tolerance) {
          if (definition.kind === 'counterbore') {
            role = Math.abs(evidence.radial - definition.dimensions.recessDiameter / 2) <= tolerance
              ? 'shoulder-outer-vertex'
              : 'shoulder-inner-vertex';
          } else role = 'pilot-junction-vertex';
        } else role = 'through-vertex';
        records.push({ ...evidence, role, wrapperKey: 'vertex', wrapper: vertex });
      }
      names.explicitVertexTable = groupedExplicitNames(records, 'V');
    } finally {
      for (const vertex of vertices) safeDelete(vertex);
    }
    return names;
  } finally {
    for (const face of faces) safeDelete(face);
  }
}

// Assign creation names to an extrude/cut solid built from exact sketch
// entities. Mirrors featureSolid's exact base-plane or support-face placement
// so the expected sweep history is tied to stable feature/entity identifiers.
// Patterned features use their own operation-history naming path.
function creationNameTable(feature, solid, N, part = null, accumulated = null, accumulatedNames = []) {
  if (!topo || !solid) return [];
  if (feature.pattern) return [];
  if (feature.type !== 'cut' && feature.type !== 'extrude') return [];
  if (feature.extensions?.holeWizard) return studioHoleWizardCreationNameTable(feature, solid, accumulated, N);
  // First-class constrained features reference their entities via sketchId;
  // resolve the current sketch exactly like geometry execution does.
  let sketch = feature.sketch;
  if (feature.sketchId && part) {
    const partSketch = (part.sketches || []).find((entry) => entry.id === feature.sketchId);
    if (partSketch?.extensions?.studioRole === STUDIO_CONSTRAINED_2D_ROLE) {
      const resolvedFeature = resolvedConstrainedExecutionFeature(part, feature, N);
      sketch = resolvedFeature.sketch;
      feature = resolvedFeature;
    }
  }
  const entities = [];
  if (feature.extensions?.exactSketchEntities) {
    const sketchEntities = (sketch?.entities || []).filter((entity) => entity.construction !== true);
    for (const entity of sketchEntities) {
      if (entity.kind === 'line') {
        entities.push({ kind: 'line', id: entity.id, a2: entity.a.map(N), b2: entity.b.map(N) });
      } else if (entity.kind === 'circle') {
        entities.push({ kind: 'circle', id: entity.id, center2: entity.center.map(N), radius: N(entity.radius) });
      } else if (entity.kind === 'arc') {
        const center = entity.center.map(N);
        const start = entity.start.map(N);
        entities.push({ kind: 'arc', id: entity.id, center2: center, radius: Math.hypot(start[0] - center[0], start[1] - center[1]) });
      }
    }
  } else {
    const inlineProfile = inlineProfileCreationSources(sketch?.shapes || [], N);
    if (!inlineProfile.complete) {
      const unnamed = [];
      unnamed.diagnostics = [...inlineProfile.diagnostics];
      return unnamed;
    }
    entities.push(...inlineProfile.entities);
  }
  if (!entities.length) return [];
  const planeName = feature.plane?.kind === 'base' ? feature.plane.plane : 'XY';
  let normal = basePlaneNormal(planeName);
  let originDistance = 0;
  let extent = 0;
  let plane = null;
  let lookups = null;
  let supportNormal = null;
  // Mirrors featureSolid's plane arithmetic exactly, including the sketch
  // plane offset. Otherwise creation names are computed against a solid
  // that sits somewhere else and every name misses.
  const planeOffset = sketchPlaneOffset({ ...feature, sketch }, N);
  const authoredDepth = exactExtrusionDepth(feature, N);
  if (feature.onFace) {
    if (!accumulated) return [];
    try {
      lookups = topo.nameLookups(accumulated, accumulatedNames);
      const supportFace = resolveModifierTopologyReference(feature.onFace, 'face', lookups);
      supportNormal = supportFace.normalAt();
      normal = [supportNormal.x, supportNormal.y, supportNormal.z];
      plane = rc.makePlaneFromFace(supportFace);
      const depth = authoredDepth;
      if (feature.type === 'cut') {
        if (feature.through) {
          const sweep = throughAllCutSweep(accumulated, plane, normal);
          safeDelete(plane);
          plane = sweep.plane;
          normal = sweep.normal;
          extent = sweep.extent;
        } else {
          extent = feature.reversed ? depth : -depth;
        }
      } else {
        extent = feature.reversed ? -depth : depth;
      }
    } catch (error) {
      safeDelete(supportNormal);
      lookups?.dispose();
      safeDelete(plane);
      throw error;
    }
  } else if (feature.type === 'cut') {
    const depth = authoredDepth;
    const signedDepth = feature.reversed ? -depth : depth;
    if (feature.through) {
      const authoredPlane = rc.makePlane(planeName, normal.map((value) => value * planeOffset));
      try {
        const sweep = throughAllCutSweep(accumulated, authoredPlane, normal);
        plane = sweep.plane;
        normal = sweep.normal;
        extent = sweep.extent;
      } finally {
        safeDelete(authoredPlane);
      }
    } else {
      originDistance = (feature.symmetric ? -depth / 2 : 0) + planeOffset;
      extent = feature.symmetric ? depth : signedDepth;
    }
  } else {
    const depth = authoredDepth;
    originDistance = (feature.symmetric ? -depth / 2 : 0) + planeOffset;
    extent = feature.symmetric ? depth : feature.reversed ? -depth : depth;
  }
  if (!plane) plane = rc.makePlane(planeName, normal.map((value) => value * originDistance));
  try {
    const toWorld = (point) => {
      const world = plane.toWorldCoords(point);
      try { return [world.x ?? world[0], world.y ?? world[1], world.z ?? world[2]]; }
      finally { safeDelete(world); }
    };
    return topo.creationNamesForSweep(solid, {
      featureId: feature.id,
      entities,
      toWorld,
      sweepDirection: normal,
      capOffsets: [0, extent],
    });
  } finally {
    safeDelete(supportNormal);
    lookups?.dispose();
    try { plane.delete?.(); } catch {}
  }
}

function disposeNameTable(table) {
  try { topo?.disposeTable(table); } catch {}
}

function cloneKernelRobustnessEvidence(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('kernel-robustness evidence payload is malformed');
  const cloned = JSON.parse(JSON.stringify(value));
  for (const [index, evidence] of cloned.entries()) {
    const selectedEdgeNames = evidence?.selectedEdgeNames;
    const expandedEdgeNames = evidence?.expandedEdgeNames;
    const contours = evidence?.contours;
    const resultTopology = evidence?.resultTopology;
    const validNames = (names) => Array.isArray(names)
      && names.length > 0
      && names.every((name) => typeof name === 'string' && name.length > 0)
      && new Set(names).size === names.length;
    if (
      !evidence
      || typeof evidence !== 'object'
      || Array.isArray(evidence)
      || evidence.schema !== STUDIO_KERNEL_ROBUSTNESS_SCHEMA
      || evidence.policy !== STUDIO_TANGENT_FILLET_POLICY
      || evidence.mode !== 'tangent-chain-fillet'
      || typeof evidence.featureId !== 'string'
      || !evidence.featureId
      || !/^[0-9a-f]{64}$/u.test(evidence.documentHash || '')
      || !/^[0-9a-f]{64}$/u.test(evidence.sourceBrepSha256 || '')
      || !/^[0-9a-f]{64}$/u.test(evidence.resultBrepSha256 || '')
      || !(Number.isFinite(evidence.radiusMm) && evidence.radiusMm > 0)
      || !Number.isSafeInteger(evidence.sourceEdgeCount)
      || evidence.sourceEdgeCount < 1
      || !validNames(selectedEdgeNames)
      || !validNames(expandedEdgeNames)
      || expandedEdgeNames.length > evidence.sourceEdgeCount
      || !Array.isArray(contours)
      || !Number.isSafeInteger(evidence.contourCount)
      || evidence.contourCount !== contours.length
      || evidence.contourCount < 1
      || !resultTopology
      || typeof resultTopology !== 'object'
      || Array.isArray(resultTopology)
      || !['faces', 'edges', 'vertices'].every((kind) =>
        Number.isSafeInteger(resultTopology[kind]) && resultTopology[kind] > 0)
    ) throw new Error('kernel-robustness evidence entry ' + index + ' is malformed');
    const flattenedEdgeNames = [];
    const contourSeedNames = [];
    for (const contour of contours) {
      if (
        !contour
        || typeof contour !== 'object'
        || Array.isArray(contour)
        || typeof contour.seedEdgeName !== 'string'
        || !contour.seedEdgeName
        || !validNames(contour.selectedSeedEdgeNames)
        || !validNames(contour.edgeNames)
        || !Number.isSafeInteger(contour.edgeCount)
        || contour.edgeCount !== contour.edgeNames.length
        || typeof contour.closedAndTangent !== 'boolean'
        || !contour.selectedSeedEdgeNames.includes(contour.seedEdgeName)
        || !contour.edgeNames.includes(contour.seedEdgeName)
        || contour.selectedSeedEdgeNames.some((name) => !contour.edgeNames.includes(name))
      ) throw new Error('kernel-robustness evidence contour in entry ' + index + ' is malformed');
      flattenedEdgeNames.push(...contour.edgeNames);
      contourSeedNames.push(...contour.selectedSeedEdgeNames);
    }
    if (
      flattenedEdgeNames.join('\n') !== expandedEdgeNames.join('\n')
      || new Set(flattenedEdgeNames).size !== flattenedEdgeNames.length
      || contourSeedNames.length !== selectedEdgeNames.length
      || new Set(contourSeedNames).size !== contourSeedNames.length
      || selectedEdgeNames.some((name) => !contourSeedNames.includes(name))
    ) throw new Error('kernel-robustness evidence topology in entry ' + index + ' is inconsistent');
  }
  return cloned;
}

function currentKernelRobustnessEvidence(value, documentHash) {
  if (!/^[0-9a-f]{64}$/u.test(documentHash || '')) {
    throw new Error('kernel-robustness evidence requires the current effective document hash');
  }
  return cloneKernelRobustnessEvidence(value).map((entry) => ({
    ...entry,
    documentHash,
  }));
}

function cloneThreadEvidence(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('thread evidence payload is malformed');
  const cloned = structuredClone(value);
  const close = (left, right, scale = 1) => Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= Math.max(1e-9, Math.abs(scale) * 1e-9);
  const finiteTuple = (tuple, length) => Array.isArray(tuple)
    && tuple.length === length
    && tuple.every((entry) => Number.isFinite(entry));
  const tupleClose = (left, right, scale = 1) => finiteTuple(left, 3)
    && finiteTuple(right, 3)
    && left.every((entry, index) => close(entry, right[index], scale));
  const dot = (left, right) => left.reduce((total, entry, index) => total + entry * right[index], 0);
  const cross = (left, right) => [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
  const magnitude = (tuple) => Math.hypot(...tuple);
  const uniqueNames = (names) => Array.isArray(names)
    && names.length > 0
    && names.every((name) => typeof name === 'string' && name.length > 0)
    && new Set(names).size === names.length;
  for (const [index, evidence] of cloned.entries()) {
    const support = evidence?.support;
    const definition = evidence?.definition;
    const topology = evidence?.resultTopology;
    const counts = topology?.counts;
    const persistentNames = topology?.persistentNames;
    const resolved = definition?.resolvedSpanMm;
    const profile = definition?.profile;
    const tolerance = definition?.tolerance;
    const representative = tolerance?.maximumMaterialRepresentative;
    const runout = definition?.runout;
    const expectedClass = evidence?.threadKind === 'external' ? '6g' : '6H';
    const expectedPosition = evidence?.threadKind === 'external' ? 'g' : 'H';
    const basicSupportDiameter = evidence?.threadKind === 'external'
      ? profile?.basicDiameters?.major
      : profile?.basicDiameters?.minor;
    const modeledSupportDiameter = evidence?.threadKind === 'external'
      ? representative?.majorDiameter
      : representative?.minorDiameter;
    const supportScale = Math.max(1, support?.axialBoundsMm?.length || 0, support?.radiusMm || 0);
    const spanTolerance = Math.max(1e-9, (support?.axialBoundsMm?.length || 0) * 1e-9);
    const selectedExact = evidence?.selectedFace?.signature;
    const selectedStored = evidence?.selectedFace?.storedSignature;
    const selectedAuthored = evidence?.selectedFace?.authoredSignature;
    const serializableSignatureMatch = selectedStored
      && selectedAuthored
      && stableSource(selectedStored) === stableSource(selectedAuthored);
    const profileDiameters = profile?.basicDiameters;
    const representativeDiameters = representative
      ? [representative.majorDiameter, representative.pitchDiameter, representative.minorDiameter]
      : [];
    const profileValid = profile?.policy === 'iso-68-1-truncated-profile-v1'
      && profile.includedAngleDegrees === 60
      && Number.isFinite(profile.fundamentalTriangleHeight)
      && profile.fundamentalTriangleHeight > 0
      && close(
        profile.fundamentalTriangleHeight,
        Math.sqrt(3) * (definition?.pitchMm || 0) / 2,
        definition?.pitchMm,
      )
      && profileDiameters
      && [profileDiameters.major, profileDiameters.pitch, profileDiameters.minor]
        .every((entry) => Number.isFinite(entry) && entry > 0)
      && profileDiameters.major > profileDiameters.pitch
      && profileDiameters.pitch > profileDiameters.minor
      && close(profileDiameters.major, definition?.majorDiameterMm, definition?.majorDiameterMm)
      && profile.crest?.form === 'flat'
      && Number.isFinite(profile.crest.truncationHeight)
      && profile.crest.truncationHeight > 0
      && (evidence?.threadKind === 'external'
        ? profile.root?.form === 'rounded'
          && close(profile.root.radius, profile.fundamentalTriangleHeight / 6, profile.fundamentalTriangleHeight)
        : profile.root?.form === 'flat' && profile.root.radius === 0);
    const toleranceValid = tolerance?.policy === 'iso-965-maximum-material-reference-v1'
      && tolerance.class === expectedClass
      && tolerance.grade === 6
      && tolerance.position === expectedPosition
      && Number.isFinite(tolerance.fundamentalDeviationMicrometres)
      && Number.isFinite(tolerance.allowanceMm)
      && tolerance.allowanceMm >= 0
      && representativeDiameters.length === 3
      && representativeDiameters.every((entry) => Number.isFinite(entry) && entry > 0)
      && representative.majorDiameter > representative.pitchDiameter
      && representative.pitchDiameter > representative.minorDiameter;
    const runoutValid = runout?.policy === 'partmode-explicit-axial-transition-v1'
      && runout.standardsConformance === 'not-claimed'
      && (
        (runout.form === 'full-profile'
          && runout.startTurns === 0
          && runout.endTurns === 0
          && runout.construction === 'constant-full-profile')
        || (runout.form === 'one-pitch-taper'
          && runout.startTurns === 1
          && runout.endTurns === 1
          && runout.construction === 'partmode-linear-profile-scale-over-one-pitch')
      );
    const resolvedValid = resolved
      && [resolved.start, resolved.end, resolved.length, resolved.turnCount]
        .every(Number.isFinite)
      && Number.isSafeInteger(resolved.fullTurnCount)
      && resolved.start >= -spanTolerance
      && resolved.end <= (support?.axialBoundsMm?.length || 0) + spanTolerance
      && resolved.end > resolved.start + spanTolerance
      && close(resolved.length, resolved.end - resolved.start, supportScale)
      && close(resolved.turnCount, resolved.length / definition.pitchMm, resolved.turnCount)
      && resolved.fullTurnCount === Math.floor(resolved.turnCount + 1e-9);
    const representation = evidence?.representation;
    let representationValid = representation === null;
    if (evidence?.mode === 'cosmetic' && resolvedValid && finiteTuple(support?.axisDirection, 3)) {
      const expectedStartStation = support.axialBoundsMm.start + resolved.start;
      const expectedEndStation = support.axialBoundsMm.start + resolved.end;
      const expectedAngleDelta = (definition.handedness === 'left' ? -1 : 1)
        * Math.PI * 2 * resolved.turnCount;
      const axis = support.axisDirection;
      const radial = representation?.radialDirection;
      const binormal = finiteTuple(radial, 3) ? cross(axis, radial) : null;
      const pointAt = (station, angle) => support.axisPoint.map((entry, axisIndex) =>
        entry + axis[axisIndex] * station + support.radiusMm * (
          radial[axisIndex] * Math.cos(angle) + binormal[axisIndex] * Math.sin(angle)
        ));
      representationValid = representation?.kind === 'analytic-helix-overlay'
        && representation.policy === 'axis-radius-pitch-span-v1'
        && representation.targetFaceName === evidence.selectedFace?.name
        && Array.isArray(representation.parameterDomain)
        && representation.parameterDomain.length === 2
        && representation.parameterDomain[0] === 0
        && representation.parameterDomain[1] === 1
        && tupleClose(representation.axisPoint, support.axisPoint, supportScale)
        && tupleClose(representation.axisDirection, axis, 1)
        && finiteTuple(radial, 3)
        && close(magnitude(radial), 1, 1)
        && close(dot(axis, radial), 0, 1)
        && close(representation.radiusMm, support.radiusMm, support.radiusMm)
        && close(representation.startStationMm, expectedStartStation, supportScale)
        && close(representation.endStationMm, expectedEndStation, supportScale)
        && close(representation.pitchMm, definition.pitchMm, definition.pitchMm)
        && close(representation.turnCount, resolved.turnCount, resolved.turnCount)
        && representation.handedness === definition.handedness
        && representation.angleStartRadians === 0
        && close(representation.angleDeltaRadians, expectedAngleDelta, expectedAngleDelta)
        && finiteTuple(representation.startPoint, 3)
        && finiteTuple(representation.endPoint, 3)
        && tupleClose(representation.startPoint, pointAt(expectedStartStation, 0), supportScale)
        && tupleClose(
          representation.endPoint,
          pointAt(expectedEndStation, expectedAngleDelta),
          supportScale,
        );
    }
    if (
      !evidence
      || typeof evidence !== 'object'
      || Array.isArray(evidence)
      || evidence.schema !== STUDIO_THREAD_EVIDENCE_SCHEMA
      || evidence.policy !== 'exact-cylindrical-face-thread-v1'
      || typeof evidence.featureId !== 'string'
      || !evidence.featureId
      || !/^[0-9a-f]{64}$/u.test(evidence.documentHash || '')
      || !/^[0-9a-f]{64}$/u.test(evidence.sourceBrepSha256 || '')
      || !/^[0-9a-f]{64}$/u.test(evidence.resultBrepSha256 || '')
      || !['cosmetic', 'modeled'].includes(evidence.mode)
      || !['external', 'internal'].includes(evidence.threadKind)
      || evidence.cosmeticGeometryUnchanged !== (evidence.mode === 'cosmetic')
      || (evidence.mode === 'cosmetic' && evidence.sourceBrepSha256 !== evidence.resultBrepSha256)
      || (evidence.mode === 'modeled' && evidence.sourceBrepSha256 === evidence.resultBrepSha256)
      || !evidence.selectedFace
      || typeof evidence.selectedFace.name !== 'string'
      || !evidence.selectedFace.name
      || !evidence.selectedFace.signature
      || evidence.selectedFace.signature.topologyKind !== 'cylindrical-face'
      || selectedStored?.topologyKind !== 'cylindrical-face'
      || selectedAuthored?.topologyKind !== 'cylindrical-face'
      || !serializableSignatureMatch
      || !support
      || support.classification !== evidence.threadKind
      || !finiteTuple(support.axisPoint, 3)
      || !finiteTuple(support.axisDirection, 3)
      || !close(magnitude(support.axisDirection), 1, 1)
      || !(Number.isFinite(support.radiusMm) && support.radiusMm > 0)
      || !(Number.isFinite(support.modeledSupportRadiusMm) && support.modeledSupportRadiusMm > 0)
      || !support.axialBoundsMm
      || ![support.axialBoundsMm.start, support.axialBoundsMm.end, support.axialBoundsMm.length]
        .every(Number.isFinite)
      || !(support.axialBoundsMm.end > support.axialBoundsMm.start)
      || Math.abs(
        support.axialBoundsMm.length
          - (support.axialBoundsMm.end - support.axialBoundsMm.start),
      ) > 1e-8
      || !finiteTuple(selectedExact?.a, 3)
      || !finiteTuple(selectedExact?.d, 3)
      || !(Number.isFinite(selectedExact?.r) && selectedExact.r > 0)
      || !close(selectedExact.r, support.radiusMm, support.radiusMm)
      || !close(Math.abs(dot(threadUnitVector(selectedExact.d, 'Thread evidence exact axis'), support.axisDirection)), 1, 1)
      || !definition
      || typeof definition.designation !== 'string'
      || !definition.designation
      || !['right', 'left'].includes(definition.handedness)
      || typeof definition.toleranceClass !== 'string'
      || definition.toleranceClass !== expectedClass
      || !(Number.isFinite(definition.majorDiameterMm) && definition.majorDiameterMm > 0)
      || !(Number.isFinite(definition.pitchMm) && definition.pitchMm > 0)
      || !profileValid
      || !toleranceValid
      || !runoutValid
      || !definition.requestedSpan
      || !resolvedValid
      || (evidence.mode === 'cosmetic' && resolved.turnCount > STUDIO_THREAD_COSMETIC_TURN_LIMIT + 1e-9)
      || !close(support.radiusMm * 2, basicSupportDiameter, support.radiusMm)
      || !close(support.modeledSupportRadiusMm * 2, modeledSupportDiameter, support.radiusMm)
      || !representationValid
      || !topology
      || !counts
      || !persistentNames
      || !['faces', 'edges', 'vertices'].every((kind) =>
        Number.isSafeInteger(counts[kind])
        && counts[kind] > 0
        && counts[kind] === counts['named' + kind[0].toUpperCase() + kind.slice(1)]
        && uniqueNames(persistentNames[kind])
        && persistentNames[kind].length === counts[kind])
      || !/^[0-9a-f]{64}$/u.test(topology.persistentNamesSha256 || '')
    ) throw new Error('thread evidence entry ' + index + ' is malformed');
  }
  return cloned;
}

function currentThreadEvidence(value, documentHash) {
  if (!/^[0-9a-f]{64}$/u.test(documentHash || '')) {
    throw new Error('thread evidence requires the current effective document hash');
  }
  return cloneThreadEvidence(value).map((entry) => ({ ...entry, documentHash }));
}

function createFeatureCheckpoint(
  featureId,
  signature,
  shape,
  names,
  kernelRobustnessEvidence = [],
  threadEvidence = [],
) {
  if (!topo || !importedTopologyRegistry) {
    throw new Error('authoritative feature checkpoint topology is unavailable');
  }
  const topologyDiagnostics = JSON.parse(JSON.stringify(Array.isArray(names?.diagnostics) ? names.diagnostics : []));
  const serializedNames = topo.serializationNames(shape, names || []);
  const exactFaces = importedTopologyRegistry.exactFaces(shape);
  const exactEdges = importedTopologyRegistry.exactEdges(shape);
  const exactVertices = importedTopologyRegistry.exactVertices(shape);
  let derivedVertices = [];
  let vertexDiagnostics = [];
  try {
    let vertexTable = serializedNames.vertexTable;
    if (!Object.prototype.hasOwnProperty.call(names || [], 'explicitVertexTable')) {
      const vertexNaming = derivePersistentVertexNames({
        edges: exactEdges,
        getEdgeName: (edge) => serializedNames.getEdgeName(edge),
        getEdgeEndpoints: (edge) => exactEdgeEndpointVertices(
          edge,
          exactVertices.map((vertex) => vertex.wrapped),
        ),
        isSameEdge: (left, right) => left.wrapped.IsSame(right.wrapped),
        isSameVertex: (left, right) => left.IsSame(right),
      });
      vertexDiagnostics = vertexNaming.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity || 'error',
        ...diagnostic,
      }));
      derivedVertices = vertexNaming.vertexTable.map((entry) => {
        const matches = exactVertices.filter((vertex) => vertex.wrapped.IsSame(entry.vertex));
        if (matches.length !== 1) throw new Error('feature checkpoint vertex provenance is not one-to-one');
        return { name: entry.name, vertex: matches[0] };
      });
      vertexTable = derivedVertices;
    }
    const complete = (names || []).length === exactFaces.length
      && serializedNames.edgeTable.length === exactEdges.length
      && vertexTable.length === exactVertices.length;
    const namingErrors = [
      ...topologyDiagnostics,
      ...(serializedNames.diagnostics || []),
      ...vertexDiagnostics,
    ].filter((diagnostic) => diagnostic?.severity === 'error');
    if (namingErrors.length) {
      const first = namingErrors[0];
      throw codedFeatureError(
        first.code || 'TOPOLOGY_PERSISTENCE_INCOMPLETE',
        first.message || 'Feature topology naming is ambiguous; no geometry was published.',
        { diagnostics: structuredClone(namingErrors) },
      );
    }
    if (!complete) {
      throw codedFeatureError(
        'TOPOLOGY_PERSISTENCE_INCOMPLETE',
        'Feature checkpoint does not cover every exact face, edge, and vertex; no geometry was published.',
        {
          exactCounts: { faces: exactFaces.length, edges: exactEdges.length, vertices: exactVertices.length },
          namedCounts: { faces: (names || []).length, edges: serializedNames.edgeTable.length, vertices: vertexTable.length },
        },
      );
    }
    const captured = importedTopologyRegistry.captureNamed({
      shape,
      registryId: 'feature-checkpoint:' + featureId,
      names: {
        faces: names || [],
        edges: serializedNames.edgeTable,
        vertices: vertexTable,
      },
    });
    const explicitTopologyNames = {
      edges: Object.prototype.hasOwnProperty.call(names || [], 'explicitEdgeTable')
        ? names.explicitEdgeTable.map((entry) => entry.name)
        : null,
      vertices: Object.prototype.hasOwnProperty.call(names || [], 'explicitVertexTable')
        ? names.explicitVertexTable.map((entry) => entry.name)
        : null,
    };
    return {
      featureId,
      signature,
      kernelRobustnessEvidence: cloneKernelRobustnessEvidence(kernelRobustnessEvidence),
      threadEvidence: cloneThreadEvidence(threadEvidence),
      topologyCarrier: {
        sourceBrep: captured.sourceBrep,
        registry: captured.registry,
        featureReference: captured.featureReference,
        explicitTopologyNames,
      },
      topologyDiagnostics,
    };
  } finally {
    derivedVertices = [];
    importedTopologyRegistry.disposeWrappers(exactVertices);
    importedTopologyRegistry.disposeWrappers(exactEdges);
    importedTopologyRegistry.disposeWrappers(exactFaces);
    serializedNames.dispose();
  }
}

function restoreFeatureCheckpoint(checkpoint) {
  if (
    !Array.isArray(checkpoint?.topologyDiagnostics)
    || checkpoint.topologyDiagnostics.some((diagnostic) => !diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic))
  ) {
    throw new Error('feature checkpoint diagnostic payload is malformed');
  }
  const carrier = checkpoint.topologyCarrier;
  if (
    !carrier
    || typeof carrier !== 'object'
    || typeof carrier.sourceBrep !== 'string'
    || !carrier.sourceBrep
    || !carrier.registry
    || typeof carrier.registry !== 'object'
    || !carrier.featureReference
    || typeof carrier.featureReference !== 'object'
    || !carrier.explicitTopologyNames
    || typeof carrier.explicitTopologyNames !== 'object'
    || !importedTopologyRegistry
  ) {
    throw new Error('feature checkpoint persistent-topology carrier is malformed');
  }
  const restored = importedTopologyRegistry.restore({
    sourceBrep: carrier.sourceBrep,
    registry: carrier.registry,
    expectedRegistryRef: carrier.featureReference,
  });
  try {
    const explicitNames = carrier.explicitTopologyNames;
    for (const key of ['edges', 'vertices']) {
      const values = explicitNames[key];
      if (values !== null && (
        !Array.isArray(values)
        || values.some((name) => typeof name !== 'string' || !name)
        || new Set(values).size !== values.length
      )) throw new Error('feature checkpoint explicit-topology metadata is malformed');
    }
    const resolveExplicit = (table, names) => {
      if (names === null) return null;
      const selected = [];
      const selectedEntries = new Set();
      for (const name of names) {
        const matches = table.filter((entry) => entry.name === name);
        if (matches.length !== 1 || selectedEntries.has(matches[0])) {
          throw new Error('feature checkpoint explicit-topology names do not resolve one-to-one');
        }
        selected.push(matches[0]);
        selectedEntries.add(matches[0]);
      }
      return selected;
    };
    const resolvedEdges = resolveExplicit(restored.names.edges, explicitNames.edges);
    const resolvedVertices = resolveExplicit(restored.names.vertices, explicitNames.vertices);
    const adoptExplicit = (table, selected, wrapperKey) => {
      const kept = new Set(selected || []);
      importedTopologyRegistry.disposeWrappers(
        table.filter((entry) => !kept.has(entry)).map((entry) => entry[wrapperKey]),
      );
      return selected;
    };
    const explicitEdges = adoptExplicit(restored.names.edges, resolvedEdges, 'edge');
    restored.names.edges = [];
    const explicitVertices = adoptExplicit(restored.names.vertices, resolvedVertices, 'vertex');
    restored.names.vertices = [];
    const shape = restored.shape;
    restored.shape = null;
    const names = restored.names.faces;
    restored.names.faces = [];
    if (explicitEdges !== null) names.explicitEdgeTable = explicitEdges;
    if (explicitVertices !== null) names.explicitVertexTable = explicitVertices;
    names.diagnostics = JSON.parse(JSON.stringify(checkpoint.topologyDiagnostics));
    return {
      shape,
      names,
      kernelRobustnessEvidence: cloneKernelRobustnessEvidence(checkpoint.kernelRobustnessEvidence),
      threadEvidence: cloneThreadEvidence(checkpoint.threadEvidence),
    };
  } finally {
    importedTopologyRegistry.disposeOutcome(restored);
  }
}

function privateShapeWithNames(shape, names) {
  if (!topo) throw new Error('authoritative private topology copy is unavailable');
  // Boolean builders receive private B-reps. OCCT ModifiedShape history moves
  // every persistent name to the copy; explorer indices never assign names.
  const identity = new rc.Transformation();
  try { return topo.transformWithNames(shape, identity, names || []); }
  finally { identity.delete(); }
}

// OpenCascade is built without exceptions, so a refused operation surfaces as a
// bare integer. Translate it for whoever reads the error, a human in the UI or
// an agent reading the diagnostics channel, and keep the raw code so the
// failure stays traceable.
function friendlyError(feature, error) {
  let message = String(error?.message || error);
  const type = feature?.type || feature?.featureType || '';
  // Only a bare integer is a kernel code. An empty or 'Error' message is just
  // as opaque and gets the same hint, but must not claim a code it never had.
  const kernelCode = /^\d+$/.test(message.trim()) ? message.trim() : null;
  if (kernelCode || /^Error$/i.test(message.trim()) || !message.trim()) {
    const hint =
      type === 'shell'
        ? 'the kernel could not hollow this shape. Try different walls, another opening face, or shell earlier in the history'
        : type === 'fillet' || type === 'chamfer'
          ? 'the kernel refused this ' + type + '. Try a smaller radius, fewer edges, or an edge whose neighbouring faces are not interrupted by other features'
          : type === 'loft' || type === 'sweep'
            ? 'the kernel could not build this ' + type + '. Check that the profiles are closed and that the path meets them'
            : type === 'pattern'
              ? 'the kernel refused this pattern. Check the instance spacing and count'
              : 'the kernel rejected this ' + (type || 'feature') + '. Check the sketch for overlapping, tangent or self-crossing shapes';
    message = kernelCode ? hint + ' (kernel code ' + kernelCode + ')' : hint;
  } else if ((type === 'fillet' || type === 'chamfer') && !/no longer exist/.test(message)) {
    message += (/[.!?]$/.test(message) ? ' ' : '. ') + 'Try a smaller radius';
  }
  return message;
}

function featureFailureCode(feature, error) {
  if (typeof error?.code === 'string' && error.code.trim()) return error.code.trim().slice(0, 160);
  const type = String(feature?.type || feature?.featureType || 'feature')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'FEATURE';
  const raw = String(error?.message || error).trim();
  return /^\d+$/.test(raw) ? type + '_KERNEL_REJECTED' : type + '_REBUILD_FAILED';
}

function v5RootPart(document) {
  if (document.rootDocument?.kind !== 'part') throw new Error('This worker request requires a schema-5 part document.');
  const part = (document.partDefinitions || []).find((entry) => entry.id === document.rootDocument.partId);
  if (!part) throw new Error('The schema-5 root part is missing.');
  return part;
}

function stableSource(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableSource).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableSource(value[key])).join(',') + '}';
}

function stableHash(value) {
  const source = stableSource(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function exactPartVariantKey(partId, parameterOverrides = {}) {
  return partId + ':variant-source:' + stableSource(parameterOverrides);
}

function publicPartVariantId(partId, parameterOverrides = {}) {
  return partId + ':variant:' + stableHash(parameterOverrides);
}

function solidCount(shape) {
  let count = 0;
  for (const solid of rc.iterTopo(shape.wrapped, 'solid')) {
    count++;
    try { solid.delete?.(); } catch {}
  }
  return count;
}

function shapeVolume(shape) {
  const properties = rc.measureShapeVolumeProperties(shape);
  try {
    return properties.volume;
  } finally {
    try { properties.delete(); } catch {}
  }
}

function scaleInertiaTensor(tensor, factor) {
  return tensor.map((row) => row.map((value) => value * factor));
}

function addInertiaTensors(left, right) {
  return left.map((row, rowIndex) => row.map((value, columnIndex) => value + right[rowIndex][columnIndex]));
}

function translatedInertiaTensor(tensor, massLike, sourceCenter, targetCenter) {
  const delta = sourceCenter.map((value, axis) => value - targetCenter[axis]);
  const distanceSquared = delta.reduce((total, value) => total + value * value, 0);
  const shift = delta.map((rowValue, row) => delta.map((columnValue, column) =>
    massLike * ((row === column ? distanceSquared : 0) - rowValue * columnValue)));
  return addInertiaTensors(tensor, shift);
}

function principalInertia(tensor) {
  const matrix = tensor.map((row) => [...row]);
  const tensorScale = Math.max(1, ...matrix.flat().map(Math.abs));
  const vectors = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iteration = 0; iteration < 32; iteration++) {
    let row = 0;
    let column = 1;
    let largest = Math.abs(matrix[row][column]);
    for (const [candidateRow, candidateColumn] of [[0, 2], [1, 2]]) {
      const magnitude = Math.abs(matrix[candidateRow][candidateColumn]);
      if (magnitude > largest) {
        row = candidateRow;
        column = candidateColumn;
        largest = magnitude;
      }
    }
    const scale = Math.max(1, Math.abs(matrix[0][0]), Math.abs(matrix[1][1]), Math.abs(matrix[2][2]));
    if (largest <= scale * 1e-13) break;
    const offDiagonal = matrix[row][column];
    const tau = (matrix[column][column] - matrix[row][row]) / (2 * offDiagonal);
    const tangent = tau >= 0
      ? 1 / (tau + Math.sqrt(1 + tau * tau))
      : -1 / (-tau + Math.sqrt(1 + tau * tau));
    const cosine = 1 / Math.sqrt(1 + tangent * tangent);
    const sine = tangent * cosine;
    const rowDiagonal = matrix[row][row];
    const columnDiagonal = matrix[column][column];
    matrix[row][row] = rowDiagonal - tangent * offDiagonal;
    matrix[column][column] = columnDiagonal + tangent * offDiagonal;
    matrix[row][column] = 0;
    matrix[column][row] = 0;
    for (let axis = 0; axis < 3; axis++) {
      if (axis === row || axis === column) continue;
      const axisRow = matrix[axis][row];
      const axisColumn = matrix[axis][column];
      matrix[axis][row] = matrix[row][axis] = cosine * axisRow - sine * axisColumn;
      matrix[axis][column] = matrix[column][axis] = sine * axisRow + cosine * axisColumn;
    }
    for (let axis = 0; axis < 3; axis++) {
      const vectorRow = vectors[axis][row];
      const vectorColumn = vectors[axis][column];
      vectors[axis][row] = cosine * vectorRow - sine * vectorColumn;
      vectors[axis][column] = sine * vectorRow + cosine * vectorColumn;
    }
  }
  const entries = [0, 1, 2]
    .map((axis) => {
      if (matrix[axis][axis] < -tensorScale * 1e-10) throw new Error('Exact inertia tensor is not positive semidefinite.');
      return {
        moment: Math.max(0, matrix[axis][axis]),
        vector: [vectors[0][axis], vectors[1][axis], vectors[2][axis]],
      };
    })
    .sort((left, right) => left.moment - right.moment);
  for (const entry of entries) {
    const magnitude = Math.hypot(...entry.vector);
    entry.vector = entry.vector.map((value) => value / magnitude);
    const dominant = entry.vector.reduce((best, value, index) =>
      Math.abs(value) > Math.abs(entry.vector[best]) ? index : best, 0);
    if (entry.vector[dominant] < 0) entry.vector = entry.vector.map((value) => -value);
  }
  const handedness =
    (entries[0].vector[1] * entries[1].vector[2] - entries[0].vector[2] * entries[1].vector[1]) * entries[2].vector[0] +
    (entries[0].vector[2] * entries[1].vector[0] - entries[0].vector[0] * entries[1].vector[2]) * entries[2].vector[1] +
    (entries[0].vector[0] * entries[1].vector[1] - entries[0].vector[1] * entries[1].vector[0]) * entries[2].vector[2];
  if (handedness < 0) entries[2].vector = entries[2].vector.map((value) => -value);
  return {
    moments: entries.map((entry) => entry.moment),
    axes: entries.map((entry) => entry.vector),
  };
}

function inertiaSummary(tensor, massLike) {
  const principal = principalInertia(tensor);
  return {
    tensor,
    principalMoments: principal.moments,
    principalAxes: principal.axes,
    radiiOfGyration: massLike > 0
      ? principal.moments.map((moment) => Math.sqrt(Math.max(0, moment / massLike)))
      : [0, 0, 0],
  };
}

function volumeInertiaTensor(volumeProperties, centerOfMass) {
  const oc = rc.getOC();
  const moment = (direction) => {
    const point = new oc.gp_Pnt_3(...centerOfMass);
    const axisDirection = new oc.gp_Dir_4(...direction);
    const axis = new oc.gp_Ax1_2(point, axisDirection);
    try {
      return volumeProperties.wrapped.MomentOfInertia(axis);
    } finally {
      try { axis.delete(); } catch {}
      try { axisDirection.delete(); } catch {}
      try { point.delete(); } catch {}
    }
  };
  const x = moment([1, 0, 0]);
  const y = moment([0, 1, 0]);
  const z = moment([0, 0, 1]);
  const xy = moment([Math.SQRT1_2, Math.SQRT1_2, 0]) - (x + y) / 2;
  const xz = moment([Math.SQRT1_2, 0, Math.SQRT1_2]) - (x + z) / 2;
  const yz = moment([0, Math.SQRT1_2, Math.SQRT1_2]) - (y + z) / 2;
  return [[x, xy, xz], [xy, y, yz], [xz, yz, z]];
}

function topologyCount(shape, kind) {
  let count = 0;
  for (const element of rc.iterTopo(shape.wrapped, kind)) {
    count++;
    try { element.delete?.(); } catch {}
  }
  return count;
}

function shapePhysicalProperties(shape, { includeInertia = false } = {}) {
  const volumeProperties = rc.measureShapeVolumeProperties(shape);
  const surfaceProperties = rc.measureShapeSurfaceProperties(shape);
  try {
    const centerOfMass = volumeProperties.centerOfMass;
    return {
      volume: volumeProperties.volume,
      surfaceArea: surfaceProperties.area,
      centerOfMass,
      ...(includeInertia ? { volumeInertiaTensor: volumeInertiaTensor(volumeProperties, centerOfMass) } : {}),
    };
  } finally {
    try { volumeProperties.delete(); } catch {}
    try { surfaceProperties.delete(); } catch {}
  }
}

function bodyGeometry(shape) {
  const solids = solidCount(shape);
  const physical = shapePhysicalProperties(shape);
  const volume = physical.volume;
  const bounds = optimalShapeBounds(shape, 'Body');
  let brepValid = false;
  let brepError = null;
  try {
    const analyzer = new (rc.getOC().BRepCheck_Analyzer)(shape.wrapped, true, false);
    try { brepValid = analyzer.IsValid_2(); } finally { analyzer.delete(); }
  } catch (error) { brepError = String(error?.message || error); }
  return {
    solidCount: solids,
    volume,
    surfaceArea: physical.surfaceArea,
    centerOfMass: physical.centerOfMass,
    shellCount: topologyCount(shape, 'shell'),
    faceCount: topologyCount(shape, 'face'),
    edgeCount: topologyCount(shape, 'edge'),
    vertexCount: topologyCount(shape, 'vertex'),
    bounds,
    brepValid,
    ...(brepError ? { brepError } : {}),
    valid: solids === 1 && brepValid && Number.isFinite(volume) && volume > 1e-8,
  };
}

// A subtract that changes no volume has very different causes, and saying
// "does not intersect" for all of them sends you looking in the wrong place.
// Inspect the tool to name the real one. Only called on the failure path, so
// the healthy rebuild pays nothing for it.
function subtractFailureMessage(tool) {
  let geometry = null;
  try { geometry = bodyGeometry(tool); } catch {}
  if (!geometry) return 'the subtract feature does not intersect its target body';
  if (geometry.solidCount === 0 || !(geometry.volume > 1e-8)) {
    return 'the subtract feature built no solid from its sketch. Check for zero-area, duplicate or self-crossing shapes';
  }
  // Only the tool's own validity proves degeneration. Bounding boxes cannot: a
  // small cut just outside a round body shares an AABB with it and is a plain
  // miss. Profiles that touch at a single point fail to fuse and leave an
  // invalid tool, which is exactly what separates the two cases. Several
  // separate profiles in one sketch stay valid and are never blamed here.
  if (!geometry.brepValid) {
    return 'the subtract feature removed no material because its sketch profiles did not build usable geometry. '
      + 'Shapes that touch at a single point, such as a rectangle exactly tangent to a circle, stay separate instead of merging. '
      + 'Overlap them, or cut them as separate features.';
  }
  return 'the subtract feature does not intersect its target body';
}

// How many sketch-pattern instances of a cut feature cannot touch the target
// body at all (their footprint lies entirely outside the body's bounds in
// the sketch plane). A conservative 2D check: it never flags an instance
// that could cut, so a nonzero count is always a real silent no-op.
function patternInstanceMisses(feature, targetBounds, N, NS) {
  const pattern = feature.pattern;
  if (!pattern || !Array.isArray(targetBounds) || targetBounds.length !== 2) return { missed: 0, count: 0 };
  const count = exactSketchPatternCount(pattern, N);
  const planeName = feature.plane?.kind === 'base' ? feature.plane.plane : 'XY';
  const axes = planeName === 'XZ' ? [0, 2] : planeName === 'YZ' ? [1, 2] : [0, 1];
  const bodyRect = [
    [targetBounds[0][axes[0]], targetBounds[0][axes[1]]],
    [targetBounds[1][axes[0]], targetBounds[1][axes[1]]],
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const shape of feature.sketch?.shapes || []) {
    if (shape.kind === 'rect') {
      const w = NS(shape.w, 1) / 2, h = NS(shape.h, 1) / 2, x = NS(shape.x, 0), y = NS(shape.y, 0);
      grow(x - w, y - h); grow(x + w, y + h);
    } else if (shape.kind === 'circle') {
      const r = NS(shape.r, 1), x = NS(shape.x, 0), y = NS(shape.y, 0);
      grow(x - r, y - r); grow(x + r, y + r);
    } else if (shape.kind === 'poly') {
      for (const p of shape.pts || []) grow(p[0], p[1]);
    }
  }
  if (!Number.isFinite(minX)) return { missed: 0, count };
  const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
  let missed = 0;
  for (let index = 0; index < count; index++) {
    let instance;
    if (pattern.kind === 'circular') {
      const angle = ((360 / count) * index * Math.PI) / 180;
      const cx = N(pattern.cx ?? 0), cy = N(pattern.cy ?? 0);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      instance = corners.map(([x, y]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]);
    } else {
      const dx = N(pattern.dx ?? 0) * index, dy = N(pattern.dy ?? 0) * index;
      instance = corners.map(([x, y]) => [x + dx, y + dy]);
    }
    const ix0 = Math.min(...instance.map((p) => p[0])), ix1 = Math.max(...instance.map((p) => p[0]));
    const iy0 = Math.min(...instance.map((p) => p[1])), iy1 = Math.max(...instance.map((p) => p[1]));
    const overlaps = ix0 <= bodyRect[1][0] + 1e-7 && bodyRect[0][0] <= ix1 + 1e-7
      && iy0 <= bodyRect[1][1] + 1e-7 && bodyRect[0][1] <= iy1 + 1e-7;
    if (!overlaps) missed++;
  }
  return { missed, count };
}

function boundsOverlap(left, right, tolerance = 1e-7) {
  const a = left?.boundingBox?.bounds;
  const b = right?.boundingBox?.bounds;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2) return true;
  return [0, 1, 2].every((axis) => a[0][axis] <= b[1][axis] + tolerance && b[0][axis] <= a[1][axis] + tolerance);
}

function orientedBounds(shape, matrix, tolerance = 1e-7) {
  const bounds = shape?.boundingBox?.bounds;
  if (!Array.isArray(bounds) || bounds.length !== 2) return null;
  const center = [0, 1, 2].map((axis) => (bounds[0][axis] + bounds[1][axis]) / 2);
  const localExtents = [0, 1, 2].map((axis) => Math.max(0, (bounds[1][axis] - bounds[0][axis]) / 2));
  const columns = [[matrix[0], matrix[1], matrix[2]], [matrix[4], matrix[5], matrix[6]], [matrix[8], matrix[9], matrix[10]]];
  const axes = [];
  const extents = [];
  for (let index = 0; index < 3; index++) {
    const length = Math.hypot(...columns[index]);
    if (!(length > 1e-12)) return null;
    axes.push(columns[index].map((value) => value / length));
    extents.push(localExtents[index] * length + tolerance);
  }
  return { center: studioV5TransformPoint(matrix, center), axes, extents };
}

// Full 15-axis separating-axis test for two rigidly transformed local AABBs.
// These OBBs conservatively contain the exact B-reps, so a separating axis is
// a safe proof of non-interference before any expensive OCC extrema/Boolean.
function orientedBoundsOverlap(left, right) {
  if (!left || !right) return true;
  const R = Array.from({ length: 3 }, () => [0, 0, 0]);
  const absR = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    R[i][j] = left.axes[i][0] * right.axes[j][0] + left.axes[i][1] * right.axes[j][1] + left.axes[i][2] * right.axes[j][2];
    absR[i][j] = Math.abs(R[i][j]) + 1e-10;
  }
  const delta = right.center.map((value, axis) => value - left.center[axis]);
  const t = left.axes.map((axis) => delta[0] * axis[0] + delta[1] * axis[1] + delta[2] * axis[2]);
  for (let i = 0; i < 3; i++) {
    const rb = right.extents[0] * absR[i][0] + right.extents[1] * absR[i][1] + right.extents[2] * absR[i][2];
    if (Math.abs(t[i]) > left.extents[i] + rb) return false;
  }
  for (let j = 0; j < 3; j++) {
    const projected = Math.abs(t[0] * R[0][j] + t[1] * R[1][j] + t[2] * R[2][j]);
    const ra = left.extents[0] * absR[0][j] + left.extents[1] * absR[1][j] + left.extents[2] * absR[2][j];
    if (projected > ra + right.extents[j]) return false;
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const i1 = (i + 1) % 3; const i2 = (i + 2) % 3;
    const j1 = (j + 1) % 3; const j2 = (j + 2) % 3;
    const projected = Math.abs(t[i2] * R[i1][j] - t[i1] * R[i2][j]);
    const ra = left.extents[i1] * absR[i2][j] + left.extents[i2] * absR[i1][j];
    const rb = right.extents[j1] * absR[i][j2] + right.extents[j2] * absR[i][j1];
    if (projected > ra + rb) return false;
  }
  return true;
}

const INTERFERENCE_MESH_TOLERANCE_MM = 0.5;
const INTERFERENCE_CELL_MM = 2;

function collisionMesh(shape) {
  return shape.mesh({ tolerance: INTERFERENCE_MESH_TOLERANCE_MM, angularTolerance: 0.3 });
}

function collisionEnvelope(mesh, transform = assemblyIdentityMatrix()) {
  const cells = new Set();
  const padding = INTERFERENCE_MESH_TOLERANCE_MM * 2;
  const vertices = [];
  const lower = [Infinity, Infinity, Infinity];
  const upper = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < mesh.vertices.length; index += 3) {
    const point = studioV5TransformPoint(transform, [mesh.vertices[index], mesh.vertices[index + 1], mesh.vertices[index + 2]]);
    vertices.push(...point);
    for (let axis = 0; axis < 3; axis++) {
      lower[axis] = Math.min(lower[axis], point[axis]);
      upper[axis] = Math.max(upper[axis], point[axis]);
    }
  }
  const triangles = mesh.triangles;
  const triangleBounds = [];
  for (let index = 0; index < triangles.length; index += 3) {
    const points = [triangles[index], triangles[index + 1], triangles[index + 2]].map((vertexIndex) => [
      vertices[vertexIndex * 3], vertices[vertexIndex * 3 + 1], vertices[vertexIndex * 3 + 2],
    ]);
    const triangleLow = [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis])));
    const triangleHigh = [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis])));
    triangleBounds.push([triangleLow, triangleHigh]);
    const low = triangleLow.map((value) => Math.floor((value - padding) / INTERFERENCE_CELL_MM));
    const high = triangleHigh.map((value) => Math.floor((value + padding) / INTERFERENCE_CELL_MM));
    for (let x = low[0]; x <= high[0]; x++) for (let y = low[1]; y <= high[1]; y++) for (let z = low[2]; z <= high[2]; z++) {
      cells.add(x + ',' + y + ',' + z);
    }
  }
  const bounds = [
    lower.map((value) => value - padding),
    upper.map((value) => value + padding),
  ];
  return { cells, vertices, triangles, triangleBounds, triangleCells: null, point: vertices.slice(0, 3), bounds };
}

function boundsContain(outer, inner, tolerance = 1e-7) {
  if (!Array.isArray(outer) || !Array.isArray(inner)) return false;
  return [0, 1, 2].every((axis) => outer[0][axis] <= inner[0][axis] + tolerance && outer[1][axis] >= inner[1][axis] - tolerance);
}

function rayTriangleHit(origin, direction, a, b, c) {
  const edge1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const edge2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [
    direction[1] * edge2[2] - direction[2] * edge2[1],
    direction[2] * edge2[0] - direction[0] * edge2[2],
    direction[0] * edge2[1] - direction[1] * edge2[0],
  ];
  const determinant = edge1[0] * p[0] + edge1[1] * p[1] + edge1[2] * p[2];
  if (Math.abs(determinant) < 1e-10) return false;
  const inverse = 1 / determinant;
  const t = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
  const u = (t[0] * p[0] + t[1] * p[1] + t[2] * p[2]) * inverse;
  if (!(u > 1e-8 && u < 1 - 1e-8)) return false;
  const q = [
    t[1] * edge1[2] - t[2] * edge1[1],
    t[2] * edge1[0] - t[0] * edge1[2],
    t[0] * edge1[1] - t[1] * edge1[0],
  ];
  const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) * inverse;
  if (!(v > 1e-8 && u + v < 1 - 1e-8)) return false;
  const distance = (edge2[0] * q[0] + edge2[1] * q[1] + edge2[2] * q[2]) * inverse;
  return distance > 1e-7;
}

function meshContainsPoint(envelope, point) {
  if (!point?.length) return true;
  const directions = [[1, 0.371, 0.127], [0.217, 1, 0.433], [0.319, 0.173, 1]];
  let insideVotes = 0;
  for (const direction of directions) {
    let hits = 0;
    for (let index = 0; index < envelope.triangles.length; index += 3) {
      const points = [envelope.triangles[index], envelope.triangles[index + 1], envelope.triangles[index + 2]].map((vertexIndex) => [
        envelope.vertices[vertexIndex * 3], envelope.vertices[vertexIndex * 3 + 1], envelope.vertices[vertexIndex * 3 + 2],
      ]);
      if (rayTriangleHit(point, direction, points[0], points[1], points[2])) hits++;
    }
    if (hits % 2 === 1) insideVotes++;
  }
  return insideVotes >= 2;
}

// Tessellation deflection bounds the exact surface to 0.5 mm on each body.
// If no transformed triangle AABBs approach within the combined 1 mm
// envelope, the exact B-rep surfaces cannot cross and no OCC distance query
// or Boolean is needed. Containment remains a separate check below.
function ensureTriangleCells(envelope) {
  if (envelope.triangleCells) return envelope.triangleCells;
  const cells = new Map();
  for (let triangleIndex = 0; triangleIndex < envelope.triangleBounds.length; triangleIndex++) {
    const bounds = envelope.triangleBounds[triangleIndex];
    const low = bounds[0].map((value) => Math.floor(value / INTERFERENCE_CELL_MM));
    const high = bounds[1].map((value) => Math.floor(value / INTERFERENCE_CELL_MM));
    for (let x = low[0]; x <= high[0]; x++) for (let y = low[1]; y <= high[1]; y++) for (let z = low[2]; z <= high[2]; z++) {
      const key = x + ',' + y + ',' + z;
      const entries = cells.get(key) || [];
      entries.push(triangleIndex); cells.set(key, entries);
    }
  }
  envelope.triangleCells = cells;
  return cells;
}

function vectorSubtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vectorDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vectorCross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function pointTriangleDistanceSquared(point, a, b, c) {
  const ab = vectorSubtract(b, a); const ac = vectorSubtract(c, a); const ap = vectorSubtract(point, a);
  const d1 = vectorDot(ab, ap); const d2 = vectorDot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return vectorDot(ap, ap);
  const bp = vectorSubtract(point, b); const d3 = vectorDot(ab, bp); const d4 = vectorDot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return vectorDot(bp, bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3); const projected = [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]];
    const delta = vectorSubtract(point, projected); return vectorDot(delta, delta);
  }
  const cp = vectorSubtract(point, c); const d5 = vectorDot(ab, cp); const d6 = vectorDot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return vectorDot(cp, cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6); const projected = [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]];
    const delta = vectorSubtract(point, projected); return vectorDot(delta, delta);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const edge = vectorSubtract(c, b); const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const projected = [b[0] + w * edge[0], b[1] + w * edge[1], b[2] + w * edge[2]];
    const delta = vectorSubtract(point, projected); return vectorDot(delta, delta);
  }
  const denominator = 1 / (va + vb + vc); const v = vb * denominator; const w = vc * denominator;
  const projected = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
  const delta = vectorSubtract(point, projected); return vectorDot(delta, delta);
}

function segmentSegmentDistanceSquared(p1, q1, p2, q2) {
  const d1 = vectorSubtract(q1, p1); const d2 = vectorSubtract(q2, p2); const r = vectorSubtract(p1, p2);
  const a = vectorDot(d1, d1); const e = vectorDot(d2, d2); const f = vectorDot(d2, r);
  let s = 0; let t = 0;
  if (a <= 1e-18 && e <= 1e-18) return vectorDot(r, r);
  if (a <= 1e-18) t = Math.max(0, Math.min(1, f / e));
  else {
    const c = vectorDot(d1, r);
    if (e <= 1e-18) s = Math.max(0, Math.min(1, -c / a));
    else {
      const b = vectorDot(d1, d2); const denominator = a * e - b * b;
      if (denominator !== 0) s = Math.max(0, Math.min(1, (b * f - c * e) / denominator));
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  const closest1 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const closest2 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  const delta = vectorSubtract(closest1, closest2); return vectorDot(delta, delta);
}

function segmentIntersectsTriangle(start, end, a, b, c) {
  const direction = vectorSubtract(end, start); const edge1 = vectorSubtract(b, a); const edge2 = vectorSubtract(c, a);
  const h = vectorCross(direction, edge2); const determinant = vectorDot(edge1, h);
  if (Math.abs(determinant) < 1e-12) return false;
  const inverse = 1 / determinant; const s = vectorSubtract(start, a); const u = inverse * vectorDot(s, h);
  if (u < 0 || u > 1) return false;
  const q = vectorCross(s, edge1); const v = inverse * vectorDot(direction, q);
  if (v < 0 || u + v > 1) return false;
  const along = inverse * vectorDot(edge2, q);
  return along >= 0 && along <= 1;
}

function triangleDistanceSquared(left, right) {
  const leftEdges = [[left[0], left[1]], [left[1], left[2]], [left[2], left[0]]];
  const rightEdges = [[right[0], right[1]], [right[1], right[2]], [right[2], right[0]]];
  let minimum = Infinity;
  for (const [start, end] of leftEdges) {
    if (segmentIntersectsTriangle(start, end, right[0], right[1], right[2])) return 0;
    minimum = Math.min(minimum, pointTriangleDistanceSquared(start, right[0], right[1], right[2]));
  }
  for (const [start, end] of rightEdges) {
    if (segmentIntersectsTriangle(start, end, left[0], left[1], left[2])) return 0;
    minimum = Math.min(minimum, pointTriangleDistanceSquared(start, left[0], left[1], left[2]));
  }
  for (const leftEdge of leftEdges) for (const rightEdge of rightEdges) {
    minimum = Math.min(minimum, segmentSegmentDistanceSquared(leftEdge[0], leftEdge[1], rightEdge[0], rightEdge[1]));
  }
  return minimum;
}

function envelopeTriangle(envelope, triangleIndex) {
  return [0, 1, 2].map((offset) => {
    const vertexIndex = envelope.triangles[triangleIndex * 3 + offset] * 3;
    return envelope.vertices.slice(vertexIndex, vertexIndex + 3);
  });
}

function meshSurfacesMayMeet(left, right) {
  if (!left?.triangleBounds || !right?.triangleBounds) return true;
  const tolerance = INTERFERENCE_MESH_TOLERANCE_MM * 2;
  const toleranceSquared = tolerance * tolerance;
  const [probe, indexed] = left.triangleBounds.length <= right.triangleBounds.length ? [left, right] : [right, left];
  const indexedCells = ensureTriangleCells(indexed);
  for (let probeIndex = 0; probeIndex < probe.triangleBounds.length; probeIndex++) {
    const bounds = probe.triangleBounds[probeIndex];
    const low = bounds[0].map((value) => Math.floor((value - tolerance) / INTERFERENCE_CELL_MM));
    const high = bounds[1].map((value) => Math.floor((value + tolerance) / INTERFERENCE_CELL_MM));
    const tested = new Set();
    for (let x = low[0]; x <= high[0]; x++) for (let y = low[1]; y <= high[1]; y++) for (let z = low[2]; z <= high[2]; z++) {
      for (const triangleIndex of indexedCells.get(x + ',' + y + ',' + z) || []) {
        if (tested.has(triangleIndex)) continue;
        tested.add(triangleIndex);
        const candidate = indexed.triangleBounds[triangleIndex];
        if ([0, 1, 2].every((axis) => bounds[0][axis] <= candidate[1][axis] + tolerance && candidate[0][axis] <= bounds[1][axis] + tolerance)
          && triangleDistanceSquared(envelopeTriangle(probe, probeIndex), envelopeTriangle(indexed, triangleIndex)) <= toleranceSquared) return true;
      }
    }
  }
  return false;
}

// Conservative surface-cell broad phase. Exact B-rep Booleans still produce
// every reported volume; tessellation only proves obviously separated
// surfaces. The expanded cells cover mesh deflection, while a containment
// vote retains swallowed-solid cases whose boundaries do not cross.
function collisionEnvelopesOverlap(left, right) {
  if (!left || !right) return true;
  const smaller = left.cells.size <= right.cells.size ? left.cells : right.cells;
  const larger = smaller === left.cells ? right.cells : left.cells;
  let sharedSurfaceCell = false;
  for (const key of smaller) if (larger.has(key)) { sharedSurfaceCell = true; break; }
  if (sharedSurfaceCell && meshSurfacesMayMeet(left, right)) return true;
  if (boundsContain(left.bounds, right.bounds) && meshContainsPoint(left, right.point)) return true;
  if (boundsContain(right.bounds, left.bounds) && meshContainsPoint(right, left.point)) return true;
  return false;
}

function roundedRigidMatrix(matrix) {
  return matrix.map((value) => Math.abs(value) < 1e-10 ? 0 : Math.round(value * 1e8) / 1e8);
}

function interferenceEquivalenceKey(left, right) {
  const leftKey = left.runtime.sourceKey;
  const rightKey = right.runtime.sourceKey;
  const leftMatrix = left.runtime.renderTransform || left.runtime.exactPlacement;
  const rightMatrix = right.runtime.renderTransform || right.runtime.exactPlacement;
  if (!leftKey || !rightKey || !leftMatrix || !rightMatrix) return null;
  if (leftKey < rightKey) {
    return leftKey + '|' + rightKey + '|' + stableSource(roundedRigidMatrix(studioV5MultiplyMatrices(studioV5RigidInverse(leftMatrix), rightMatrix)));
  }
  if (rightKey < leftKey) {
    return rightKey + '|' + leftKey + '|' + stableSource(roundedRigidMatrix(studioV5MultiplyMatrices(studioV5RigidInverse(rightMatrix), leftMatrix)));
  }
  const relative = roundedRigidMatrix(studioV5MultiplyMatrices(studioV5RigidInverse(leftMatrix), rightMatrix));
  const inverse = roundedRigidMatrix(studioV5RigidInverse(relative));
  const forwardSource = stableSource(relative); const inverseSource = stableSource(inverse);
  return leftKey + '|' + rightKey + '|' + (forwardSource < inverseSource ? forwardSource : inverseSource);
}

// Inspection only needs the exact common volume, not a simplified result B-rep.
// Running OCC's common builder directly avoids the expensive post-Boolean
// topology simplification performed by Shape.intersect on complex lofts.
function exactIntersectionVolume(left, right) {
  let intersection = null;
  let intersector = null;
  let progress = null;
  try {
    const oc = rc.getOC();
    progress = new oc.Message_ProgressRange_1();
    intersector = new oc.BRepAlgoAPI_Common_3(left.shape.wrapped, right.shape.wrapped, progress);
    intersector.SetUseOBB?.(true);
    intersector.SetFuzzyValue?.(1e-4);
    intersector.Build(progress);
    intersection = rc.cast(intersector.Shape());
    return shapeVolume(intersection);
  } catch {
    return 0;
  } finally {
    safeDelete(intersection);
    try { intersector?.delete(); } catch {}
    try { progress?.delete(); } catch {}
  }
}

function batchInterferenceVolumes(left, candidates, tolerance = 0) {
  const volumes = new Map(candidates.map((entry) => [entry.index, 0]));
  if (!candidates.length) return volumes;
  // A positive exact shape distance proves that two solids cannot have a
  // volumetric intersection. Use that exact predicate after the conservative
  // mesh/cell broad phase so nearby surfaces do not force a Boolean Common.
  let exactCandidates = candidates;
  let distanceQuery = null;
  try {
    distanceQuery = new rc.DistanceQuery(left.shape);
    const contactTolerance = Math.max(1e-7, Number(tolerance) || 0);
    exactCandidates = candidates.filter(({ entry }) => {
      const leftEnvelope = left.collisionEnvelope;
      const rightEnvelope = entry.collisionEnvelope;
      const containmentPossible = leftEnvelope && rightEnvelope && (
        (boundsContain(leftEnvelope.bounds, rightEnvelope.bounds) && meshContainsPoint(leftEnvelope, rightEnvelope.point))
        || (boundsContain(rightEnvelope.bounds, leftEnvelope.bounds) && meshContainsPoint(rightEnvelope, leftEnvelope.point))
      );
      // Boundary distance remains positive when one solid is wholly inside
      // another, so contained candidates must still reach Boolean Common.
      if (containmentPossible) return true;
      try { return distanceQuery.distanceTo(entry.shape) <= contactTolerance; }
      catch { return true; }
    });
  } catch {
    exactCandidates = candidates;
  } finally {
    distanceQuery?.delete();
  }
  if (!exactCandidates.length) return volumes;
  for (const candidate of exactCandidates) {
    // Keep attribution exact per pair. A compound common is slower for complex
    // lofts and can assign a valid solid to the wrong overlapping bounds.
    volumes.set(candidate.index, exactIntersectionVolume(left, candidate.entry));
  }
  return volumes;
}

function safeDelete(shape) {
  try { shape?.delete(); } catch {}
}

function datumPlaneForFeature(document, part, datumId) {
  const frame = resolveStudioV5Datums(document, part.id).resolve(datumId);
  if (frame.kind !== 'plane') throw new Error('the selected neutral reference is not a plane');
  return new rc.Plane(frame.origin, frame.xDirection, frame.normal);
}

function topologyCandidateName(candidate, topologyKind, lookups) {
  if (!lookups) return null;
  return topologyKind === 'edge'
    ? lookups.getEdgeName(candidate)
    : lookups.getFaceName(candidate);
}

function resolveModifierTopologyReference(reference, topologyKind, lookups) {
  return resolveTopologyReference({
    reference,
    topologyKind,
    candidates: topologyKind === 'edge' ? lookups.edgeCandidates : lookups.faceCandidates,
    getName: (candidate) => topologyCandidateName(candidate, topologyKind, lookups),
    matchesSignature: topologyKind === 'edge' ? edgeMatches : faceMatches,
  });
}

function exactWrappedMatch(left, right) {
  try { return left.wrapped.IsSame(right.wrapped); } catch { return false; }
}

const STUDIO_THREAD_SUPPORT_AREA_RELATIVE_TOLERANCE = 2e-6;

function threadVectorDot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function threadVectorCross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function threadVectorAddScaled(point, direction, scale) {
  return point.map((value, index) => value + direction[index] * scale);
}

function threadUnitVector(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => !Number.isFinite(entry))) {
    throw new Error(label + ' must contain three finite coordinates.');
  }
  const length = Math.hypot(...value);
  if (!(length > 1e-12)) throw new Error(label + ' has zero length.');
  return value.map((entry) => entry / length);
}

function canonicalThreadAxisDirection(value) {
  let direction = threadUnitVector(value, 'Thread cylinder axis');
  let pivot = 0;
  for (let index = 1; index < 3; index++) {
    if (Math.abs(direction[index]) > Math.abs(direction[pivot]) + 1e-14) pivot = index;
  }
  if (direction[pivot] < 0) direction = direction.map((entry) => -entry);
  return direction;
}

function canonicalThreadRadialDirection(axisDirection) {
  const bases = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const reference = bases.reduce((best, candidate) => (
    Math.abs(threadVectorDot(axisDirection, candidate))
      < Math.abs(threadVectorDot(axisDirection, best))
      ? candidate
      : best
  ));
  return threadUnitVector(
    threadVectorCross(reference, axisDirection),
    'Thread cosmetic radial direction',
  );
}

function threadPointTuple(point, label) {
  return pointTuple(point, label).map((entry) => {
    if (!Number.isFinite(entry)) throw new Error(label + ' contains a non-finite coordinate.');
    return entry;
  });
}


function exactThreadCylinderSupport(face) {
  const exactSignature = exactAnalyticFaceSignature(face);
  if (exactSignature.topologyKind !== 'cylindrical-face') {
    throw new Error('Thread target persistent face is not a current exact cylindrical face.');
  }
  const axisDirection = canonicalThreadAxisDirection(exactSignature.d);
  const rawAxisPoint = exactSignature.a;
  const axisPoint = threadVectorAddScaled(
    rawAxisPoint,
    axisDirection,
    -threadVectorDot(rawAxisPoint, axisDirection),
  );
  const stationOf = (point) => threadVectorDot(
    point.map((entry, index) => entry - axisPoint[index]),
    axisDirection,
  );
  const stations = [];
  let classificationPoint = null;
  let classificationNormal = null;
  try {
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      for (const v of [0, 1]) {
        let point = null;
        try {
          point = face.pointOnSurface(u, v);
          stations.push(stationOf(threadPointTuple(point, 'Thread cylinder support point')));
        } finally {
          safeDelete(point);
        }
      }
    }
    const start = Math.min(...stations);
    const end = Math.max(...stations);
    const length = end - start;
    const radius = Number(exactSignature.r);
    if (!(Number.isFinite(radius) && radius > 0) || !(Number.isFinite(length) && length > 1e-8)) {
      throw new Error('Thread target cylindrical face has invalid exact radius or axial bounds.');
    }

    // A partial cylinder or a cylinder with trimmed-away islands is not a
    // sound one-face thread support. Exact surface area proves that this face
    // owns the full 2π support over the derived axial interval.
    const areaProperties = rc.measureShapeSurfaceProperties(face);
    let actualArea;
    try { actualArea = areaProperties.area; } finally { areaProperties.delete(); }
    const expectedArea = 2 * Math.PI * radius * length;
    if (
      !Number.isFinite(actualArea)
      || Math.abs(actualArea - expectedArea)
        > Math.max(2e-7, expectedArea * STUDIO_THREAD_SUPPORT_AREA_RELATIVE_TOLERANCE)
    ) {
      throw new Error('Thread target must be one complete untrimmed exact cylindrical support face.');
    }

    classificationPoint = face.pointOnSurface(0.25, 0.5);
    classificationNormal = face.normalAt(classificationPoint);
    const point = threadPointTuple(classificationPoint, 'Thread support classification point');
    const normal = threadUnitVector(
      threadPointTuple(classificationNormal, 'Thread support classification normal'),
      'Thread support classification normal',
    );
    const station = stationOf(point);
    const onAxis = threadVectorAddScaled(axisPoint, axisDirection, station);
    const radial = threadUnitVector(
      point.map((entry, index) => entry - onAxis[index]),
      'Thread support radial direction',
    );
    const orientation = threadVectorDot(normal, radial);
    if (Math.abs(orientation) < 0.98) {
      throw new Error('Thread target cylindrical-face material orientation is ambiguous.');
    }
    return {
      exactSignature,
      axisPoint,
      axisDirection,
      radius,
      start,
      end,
      length,
      classification: orientation > 0 ? 'external' : 'internal',
    };
  } finally {
    safeDelete(classificationNormal);
    safeDelete(classificationPoint);
  }
}

function assertCurrentThreadFaceReference(reference, face) {
  if (!reference || typeof reference.name !== 'string' || !reference.name || !reference.sig) {
    throw new Error('Thread target requires one named current cylindrical-face reference.');
  }
  const currentSignature = faceSignature(face);
  if (
    currentSignature.topologyKind !== 'cylindrical-face'
    || stableSource(currentSignature) !== stableSource(reference.sig)
  ) {
    throw new Error('Thread target persistent face signature no longer matches the current exact cylindrical face.');
  }
  return currentSignature;
}

function threadProfileGeometry(definition, support) {
  const profile = definition.profile;
  const tolerance = definition.tolerance;
  const representative = tolerance?.maximumMaterialRepresentative;
  if (
    profile?.policy !== 'iso-68-1-truncated-profile-v1'
    || profile.includedAngleDegrees !== 60
    || !(Number.isFinite(profile.fundamentalTriangleHeight) && profile.fundamentalTriangleHeight > 0)
    || profile.crest?.form !== 'flat'
    || !representative
    || ![representative.majorDiameter, representative.pitchDiameter, representative.minorDiameter]
      .every((entry) => Number.isFinite(entry) && entry > 0)
    || !(representative.majorDiameter > representative.pitchDiameter
      && representative.pitchDiameter > representative.minorDiameter)
  ) throw new Error('Thread profile or tolerance recipe is invalid.');
  const pitch = definition.coarsePitch;
  const H = profile.fundamentalTriangleHeight;
  if (
    !(Number.isFinite(pitch) && pitch > 0)
    || Math.abs(H - Math.sqrt(3) * pitch / 2) > Math.max(1e-10, pitch * 1e-9)
  ) throw new Error('Thread profile fundamental triangle is inconsistent with its pitch.');

  const supportDiameter = definition.threadKind === 'external'
    ? profile.basicDiameters.major
    : profile.basicDiameters.minor;
  const modeledSupportDiameter = definition.threadKind === 'external'
    ? representative.majorDiameter
    : representative.minorDiameter;
  const rootDiameter = definition.threadKind === 'external'
    ? representative.minorDiameter
    : representative.majorDiameter;
  const dimensionTolerance = Math.max(2e-5, supportDiameter * 1e-7);
  if (Math.abs(support.radius * 2 - supportDiameter) > dimensionTolerance) {
    throw new Error(
      `Thread target diameter ${support.radius * 2} mm does not match ${definition.designation} `
        + `${definition.threadKind} basic support diameter ${supportDiameter} mm.`,
    );
  }
  const depth = Math.abs(rootDiameter - supportDiameter) / 2;
  const modeledDepth = Math.abs(rootDiameter - modeledSupportDiameter) / 2;
  if (!(modeledDepth > 1e-8 && modeledDepth < support.radius)) {
    throw new Error('Thread profile radial depth is invalid for the selected exact cylindrical support.');
  }
  const root = profile.root;
  if (definition.threadKind === 'external') {
    if (
      root?.form !== 'rounded'
      || !(Number.isFinite(root.radius) && root.radius > 0)
      || Math.abs(root.radius - H / 6) > Math.max(1e-10, H * 1e-9)
    ) throw new Error('External ISO thread profile requires its exact H/6 rounded root.');
  } else if (root?.form !== 'flat' || root.radius !== 0) {
    throw new Error('Internal ISO thread profile requires its exact flat root.');
  }
  // Two percent of the profile depth keeps OCCT's linear-law endpoint
  // nondegenerate. The terminal scale is chosen from this same overlap, so
  // the scaled profile still touches the support at exactly one radial point
  // and removes zero endpoint area.
  const overlap = Math.max(modeledDepth * 0.02, 1e-6, support.radius * 2e-7, pitch * 2e-6);
  const slope = Math.tan(Math.PI / 3);
  const crestHalfWidth = pitch / 2 - profile.crest.truncationHeight / slope;
  const flatRootHalfWidth = root.truncationHeight / slope;
  if (!(crestHalfWidth > 0) || !(flatRootHalfWidth > 0)) {
    throw new Error('Thread crest or root truncation produced an invalid exact profile.');
  }
  return {
    pitch,
    H,
    supportDiameter,
    rootDiameter,
    rootRadius: root.radius,
    depth: modeledDepth,
    nominalDepth: depth,
    modeledSupportRadius: modeledSupportDiameter / 2,
    overlap,
    slope,
    crestHalfWidth,
    flatRootHalfWidth,
  };
}

function studioThreadGrooveDrawing(definition, geometry) {
  const {
    depth, overlap, slope, crestHalfWidth, flatRootHalfWidth, rootRadius,
  } = geometry;
  if (definition.threadKind === 'external') {
    // Anchor the sweep just outside the major cylinder. This makes a zero-law
    // endpoint exactly tangent to the support instead of leaving a finite
    // groove. At full scale the circular H/6 root reaches the declared minor
    // radius and is tangent to both 60-degree flanks.
    const outerX = 0;
    const outerHalfWidth = crestHalfWidth + overlap / slope;
    const rootX = -(depth + overlap);
    const tangentX = rootX + rootRadius / 2;
    const tangentHalfWidth = Math.sqrt(3) * rootRadius / 2;
    return rc.draw([tangentX, -tangentHalfWidth])
      .lineTo([outerX, -outerHalfWidth])
      .lineTo([outerX, outerHalfWidth])
      .lineTo([tangentX, tangentHalfWidth])
      .threePointsArcTo([tangentX, -tangentHalfWidth], [rootX, 0])
      .close();
  }
  // Internal roots are the source-owned flat ISO truncation. The sweep is
  // anchored just inside the bore so its tapered endpoint likewise touches,
  // but does not cut, the current cylindrical support.
  const innerX = 0;
  const innerHalfWidth = crestHalfWidth + overlap / slope;
  const rootX = depth + overlap;
  return rc.draw([innerX, -innerHalfWidth])
    .lineTo([rootX, -flatRootHalfWidth])
    .lineTo([rootX, flatRootHalfWidth])
    .lineTo([innerX, innerHalfWidth])
    .close();
}

function buildStudioThreadAllowanceTool(definition, support, geometry, resolvedSpan) {
  if (definition.threadKind !== 'external') return null;
  const radialAllowance = support.radius - geometry.modeledSupportRadius;
  if (radialAllowance <= Math.max(1e-9, support.radius * 1e-10)) return null;
  const startStation = support.start + resolvedSpan.startMm;
  const origin = threadVectorAddScaled(support.axisPoint, support.axisDirection, startStation);
  let outer = null;
  let inner = null;
  let annulus = null;
  try {
    outer = rc.makeCylinder(
      support.radius + geometry.overlap,
      resolvedSpan.lengthMm,
      origin,
      support.axisDirection,
    );
    inner = rc.makeCylinder(
      geometry.modeledSupportRadius,
      resolvedSpan.lengthMm,
      origin,
      support.axisDirection,
    );
    annulus = outer.cut(inner);
    const exact = bodyGeometry(annulus);
    if (!exact.valid) throw new Error('External Thread allowance tool is not one valid exact annular solid.');
    const result = annulus;
    annulus = null;
    return result;
  } finally {
    safeDelete(annulus);
    safeDelete(inner);
    safeDelete(outer);
  }
}

function buildStudioThreadAxialClip(support, geometry, resolvedSpan) {
  const startStation = support.start + resolvedSpan.startMm;
  const origin = threadVectorAddScaled(support.axisPoint, support.axisDirection, startStation);
  // This cylinder represents only the authored axial slab. Its generous
  // radial extent must never trim the groove profile; exact Common below is
  // therefore an axial clip for external and internal threads alike.
  const radius = support.radius + geometry.depth + geometry.overlap * 8;
  const clip = rc.makeCylinder(
    radius,
    resolvedSpan.lengthMm,
    origin,
    support.axisDirection,
  );
  const exact = bodyGeometry(clip);
  if (!exact.valid) {
    safeDelete(clip);
    throw new Error('Thread axial-span clip is not one valid exact cylindrical solid.');
  }
  return clip;
}

function threadLinearLaw(length, startFactor, endFactor) {
  const oc = rc.getOC();
  let base = null;
  let law = null;
  try {
    base = new oc.Law_Linear();
    base.Set(0, startFactor, length, endFactor);
    law = base.Trim(0, length, 1e-7);
    return { base, law };
  } catch (error) {
    safeDelete(law);
    safeDelete(base);
    throw error;
  }
}

function buildStudioThreadGrooveSegment(definition, support, geometry, segment, threadStartStation) {
  const axisOrigin = threadVectorAddScaled(support.axisPoint, support.axisDirection, threadStartStation);
  const pathRadius = definition.threadKind === 'external'
    ? geometry.modeledSupportRadius + geometry.overlap
    : geometry.modeledSupportRadius - geometry.overlap;
  if (!(pathRadius > 0)) throw new Error('Thread helical sweep radius is invalid.');
  const helix = rc.sketchHelix(
    geometry.pitch,
    segment.length,
    pathRadius,
    axisOrigin,
    support.axisDirection,
    definition.handedness === 'left',
  );
  let lawOwner = null;
  let profilePlane = null;
  let groove = null;
  try {
    const helixStart = threadPointTuple(
      helix.wire.startPoint,
      'Thread helical sweep start point',
    );
    const startStation = threadVectorDot(
      helixStart.map((entry, index) => entry - axisOrigin[index]),
      support.axisDirection,
    );
    const onAxis = threadVectorAddScaled(axisOrigin, support.axisDirection, startStation);
    const radialDirection = threadUnitVector(
      helixStart.map((entry, index) => entry - onAxis[index]),
      'Thread helical sweep radial direction',
    );
    const planeNormal = threadUnitVector(
      threadVectorCross(radialDirection, support.axisDirection),
      'Thread helical profile plane normal',
    );
    // Replicad's default sweep plane derives from helix tangent and its
    // Sketch default world-Z direction. That flips the radial profile axis for
    // left-hand internal helices and is wrong for arbitrary support axes. An
    // explicit radial/axial plane makes the ISO profile orientation independent
    // of handedness and world coordinates: plane X is radial, plane Y is the
    // exact cylinder axis, and the helical wire supplies only the sweep path.
    profilePlane = new rc.Plane(helixStart, radialDirection, planeNormal);
    if (segment.startFactor !== 1 || segment.endFactor !== 1) {
      lawOwner = threadLinearLaw(segment.length, segment.startFactor, segment.endFactor);
    }
    groove = helix.sweepSketch(
      () => studioThreadGrooveDrawing(definition, geometry).sketchOnPlane(profilePlane),
      {
        frenet: true,
        // `round` forces Replicad's withCorrection flag even when the caller
        // explicitly disables profile/spine orthogonalization. Transformed
        // keeps correction false, preserving the authored radial/axial ISO
        // section while the Frenet frame carries it along the analytic helix.
        transitionMode: 'transformed',
        forceProfileSpineOthogonality: false,
        withContact: false,
        ...(lawOwner ? { law: lawOwner.law } : {}),
      },
    );
    const turnsFromStart = (segment.startStation - threadStartStation) / geometry.pitch;
    const axialOffset = segment.startStation - threadStartStation;
    if (Math.abs(axialOffset) > 1e-12) {
      groove = groove.translate(support.axisDirection.map((entry) => entry * axialOffset));
    }
    const rawPhaseDegrees = (definition.handedness === 'left' ? -1 : 1) * 360 * turnsFromStart;
    let phaseDegrees = ((rawPhaseDegrees % 360) + 360) % 360;
    if (phaseDegrees > 180) phaseDegrees -= 360;
    if (Math.abs(phaseDegrees) < 1e-9) phaseDegrees = 0;
    if (Math.abs(phaseDegrees) > 1e-10) {
      groove = groove.rotate(phaseDegrees, support.axisPoint, support.axisDirection);
    }
    const result = groove;
    groove = null;
    return result;
  } finally {
    safeDelete(groove);
    safeDelete(profilePlane);
    safeDelete(lawOwner?.law);
    safeDelete(lawOwner?.base);
  }
}

function buildStudioThreadGroove(definition, support, geometry, resolvedSpan) {
  const startStation = support.start + resolvedSpan.startMm;
  const endStation = support.start + resolvedSpan.endMm;
  const terminalScale = geometry.overlap / (geometry.depth + geometry.overlap);
  let segments;
  if (definition.runout.form === 'full-profile') {
    segments = [{ startStation, length: endStation - startStation, startFactor: 1, endFactor: 1 }];
  } else if (definition.runout.form === 'one-pitch-taper') {
    const taperLength = geometry.pitch;
    const centralLength = endStation - startStation - taperLength * 2;
    if (centralLength < -Math.max(1e-9, geometry.pitch * 1e-9)) {
      throw new Error('One-pitch start and end runouts require at least two resolved thread turns.');
    }
    segments = [
      { startStation, length: taperLength, startFactor: terminalScale, endFactor: 1 },
      ...(centralLength > 1e-9
        ? [{ startStation: startStation + taperLength, length: centralLength, startFactor: 1, endFactor: 1 }]
        : []),
      { startStation: endStation - taperLength, length: taperLength, startFactor: 1, endFactor: terminalScale },
    ];
  } else {
    throw new Error('Thread runout profile is unsupported.');
  }

  // OCCT's pipe-shell cost grows sharply when one analytic helix carries many
  // turns. Keep each exact sweep at or below one pitch, then apply the
  // phase-continuous authored pieces independently. This bounded construction
  // supports the source-owned practical ceiling of seven modeled turns.
  segments = segments.flatMap((segment) => {
    if (
      segment.startFactor !== 1
      || segment.endFactor !== 1
      || segment.length <= geometry.pitch + 1e-9
    ) return [segment];
    const pieces = [];
    let consumed = 0;
    while (consumed < segment.length - 1e-9) {
      const length = Math.min(geometry.pitch, segment.length - consumed);
      pieces.push({
        startStation: segment.startStation + consumed,
        length,
        startFactor: 1,
        endFactor: 1,
      });
      consumed += length;
    }
    return pieces;
  });
  const grooves = [];
  let fullPitchTemplate = null;
  let fullPitchTemplateStation = 0;
  try {
    for (const segment of segments) {
      let piece = null;
      try {
        const reusableFullPitch = segment.startFactor === 1
          && segment.endFactor === 1
          && Math.abs(segment.length - geometry.pitch) <= 1e-9;
        if (reusableFullPitch && fullPitchTemplate) {
          piece = fullPitchTemplate.clone();
          const offset = segment.startStation - fullPitchTemplateStation;
          if (Math.abs(offset) > 1e-12) {
            piece = piece.translate(support.axisDirection.map((entry) => entry * offset));
          }
        } else {
          piece = buildStudioThreadGrooveSegment(
            definition,
            support,
            geometry,
            segment,
            startStation,
          );
          if (reusableFullPitch && !fullPitchTemplate) {
            fullPitchTemplate = piece.clone();
            fullPitchTemplateStation = segment.startStation;
          }
        }
        const exact = bodyGeometry(piece);
        if (!exact.valid) throw new Error('Thread helical groove segment is not one valid exact solid.');
        grooves.push(piece);
        piece = null;
      } finally {
        safeDelete(piece);
      }
    }
    if (!grooves.length) throw new Error('Thread runout planner produced no exact groove.');
    return grooves;
  } catch (error) {
    for (const groove of grooves) safeDelete(groove);
    throw error;
  } finally {
    safeDelete(fullPitchTemplate);
  }
}

function threadExactSubshapeName(prefix, topologyShape) {
  const digest = studioV5Sha256Hex(canonicalStudioBrepEvidence(rc, topologyShape));
  return prefix + digest;
}

function exactStudioThreadCut(targetShape, toolShape) {
  const oc = rc.getOC();
  let progress = null;
  let builder = null;
  let raw = null;
  let result = null;
  try {
    progress = new oc.Message_ProgressRange_1();
    builder = new oc.BRepAlgoAPI_Cut_3(targetShape.wrapped, toolShape.wrapped, progress);
    builder.Build(progress);
    if (builder.IsDone && !builder.IsDone()) throw new Error('OCCT did not complete the exact thread cut.');
    raw = builder.Shape();
    result = rc.cast(raw);
    safeDelete(raw);
    raw = null;
    if (!result) throw new Error('OCCT produced no exact thread-cut shape.');
    const output = result;
    result = null;
    return output;
  } finally {
    safeDelete(result);
    safeDelete(raw);
    safeDelete(builder);
    safeDelete(progress);
  }
}

function exactStudioThreadCommon(leftShape, rightShape) {
  const oc = rc.getOC();
  let progress = null;
  let builder = null;
  let raw = null;
  let result = null;
  try {
    progress = new oc.Message_ProgressRange_1();
    builder = new oc.BRepAlgoAPI_Common_3(leftShape.wrapped, rightShape.wrapped, progress);
    builder.Build(progress);
    if (builder.IsDone && !builder.IsDone()) {
      throw new Error('OCCT did not complete the exact thread axial clipping operation.');
    }
    raw = builder.Shape();
    result = rc.cast(raw);
    safeDelete(raw);
    raw = null;
    if (!result) throw new Error('OCCT produced no exact axially clipped thread tool.');
    const output = result;
    result = null;
    return output;
  } finally {
    safeDelete(result);
    safeDelete(raw);
    safeDelete(builder);
    safeDelete(progress);
  }
}

function completeStudioThreadNames(shape, sourceShape, sourceNames, featureId) {
  const faces = importedTopologyRegistry.exactFaces(shape);
  const edges = importedTopologyRegistry.exactEdges(shape);
  const vertices = importedTopologyRegistry.exactVertices(shape);
  const sourceSerialization = topo.serializationNames(sourceShape, sourceNames || []);
  const result = [];
  // Preserve every diagnostic that existed before this feature. Newly split
  // thread topology is not assigned an inherited name at all; it receives a
  // feature-owned exact digest below, so there is no ambiguity to erase.
  result.diagnostics = structuredClone([
    ...(sourceNames?.diagnostics || []),
    ...(sourceSerialization.diagnostics || []),
  ]);
  const claimed = new Set();
  const claim = (name, kind) => {
    if (typeof name !== 'string' || !name || claimed.has(name)) {
      throw new Error(`Thread exact ${kind} persistent identity is missing or duplicated.`);
    }
    claimed.add(name);
    return name;
  };
  const inheritedExactName = (candidate, table, wrapperKey, kind) => {
    const matches = (table || []).filter((entry) => {
      try { return entry[wrapperKey].wrapped.IsSame(candidate.wrapped); } catch { return false; }
    });
    if (matches.length > 1 || new Set(matches.map((entry) => entry.name)).size > 1) {
      throw new Error(`Thread source ${kind} persistent identity is ambiguous.`);
    }
    return matches[0]?.name || null;
  };
  try {
    for (const face of faces) {
      const inherited = inheritedExactName(face, sourceNames, 'face', 'face');
      const name = claim(
        inherited || threadExactSubshapeName(`F${featureId}:thread:exact:`, face),
        'face',
      );
      result.push({ name, face: face.clone() });
    }
    result.explicitEdgeTable = edges.map((edge) => ({
      name: claim(
        inheritedExactName(edge, sourceSerialization.edgeTable, 'edge', 'edge')
          || threadExactSubshapeName(`E${featureId}:thread:exact:`, edge),
        'edge',
      ),
      edge: edge.clone(),
    }));
    result.explicitVertexTable = vertices.map((vertex) => ({
      name: claim(
        inheritedExactName(vertex, sourceSerialization.vertexTable, 'vertex', 'vertex')
          || threadExactSubshapeName(`V${featureId}:thread:exact:`, vertex),
        'vertex',
      ),
      vertex: vertex.clone(),
    }));
    assertCompleteFeatureTopology(shape, result, 'Modeled Thread v2');
    return result;
  } catch (error) {
    disposeNameTable(result);
    throw error;
  } finally {
    sourceSerialization.dispose();
    importedTopologyRegistry.disposeWrappers(vertices);
    importedTopologyRegistry.disposeWrappers(edges);
    importedTopologyRegistry.disposeWrappers(faces);
  }
}

function studioThreadCosmeticRepresentation(definition, support, resolvedSpan) {
  const radialDirection = canonicalThreadRadialDirection(support.axisDirection);
  const startStationMm = support.start + resolvedSpan.startMm;
  const endStationMm = support.start + resolvedSpan.endMm;
  const angleStartRadians = 0;
  const angleDeltaRadians = (definition.handedness === 'left' ? -1 : 1)
    * Math.PI * 2 * resolvedSpan.turnCount;
  const pointAt = (station, angle) => {
    const axisPoint = threadVectorAddScaled(support.axisPoint, support.axisDirection, station);
    const binormalDirection = threadVectorCross(support.axisDirection, radialDirection);
    return axisPoint.map((value, index) => value + support.radius * (
      radialDirection[index] * Math.cos(angle)
        + binormalDirection[index] * Math.sin(angle)
    ));
  };
  return {
    kind: 'analytic-helix-overlay',
    policy: 'axis-radius-pitch-span-v1',
    targetFaceName: definition.support.face.name,
    parameterDomain: [0, 1],
    axisPoint: structuredClone(support.axisPoint),
    axisDirection: structuredClone(support.axisDirection),
    radialDirection,
    radiusMm: support.radius,
    startStationMm,
    endStationMm,
    pitchMm: definition.coarsePitch,
    turnCount: resolvedSpan.turnCount,
    handedness: definition.handedness,
    angleStartRadians,
    angleDeltaRadians,
    startPoint: pointAt(startStationMm, angleStartRadians),
    endPoint: pointAt(endStationMm, angleStartRadians + angleDeltaRadians),
  };
}

function studioThreadEvidenceEntry({
  feature,
  definition,
  support,
  storedSignature,
  resolvedSpan,
  sourceBrepSha256,
  resultShape,
  resultNames,
}) {
  const resultBrepSha256 = definition.mode === 'cosmetic'
    ? sourceBrepSha256
    : studioV5Sha256Hex(canonicalStudioBrepEvidence(rc, resultShape));
  return {
    schema: STUDIO_THREAD_EVIDENCE_SCHEMA,
    policy: definition.policy,
    featureId: feature.id,
    documentHash: '0'.repeat(64),
    mode: definition.mode,
    threadKind: definition.threadKind,
    sourceBrepSha256,
    selectedFace: {
      name: definition.support.face.name,
      signature: structuredClone(support.exactSignature),
      storedSignature: structuredClone(storedSignature),
      authoredSignature: structuredClone(definition.support.face.sig),
    },
    support: {
      axisPoint: structuredClone(support.axisPoint),
      axisDirection: structuredClone(support.axisDirection),
      radiusMm: support.radius,
      modeledSupportRadiusMm: definition.threadKind === 'external'
        ? definition.tolerance.maximumMaterialRepresentative.majorDiameter / 2
        : definition.tolerance.maximumMaterialRepresentative.minorDiameter / 2,
      axialBoundsMm: { start: support.start, end: support.end, length: support.length },
      classification: support.classification,
    },
    definition: {
      designation: definition.designation,
      handedness: definition.handedness,
      toleranceClass: definition.toleranceClass,
      majorDiameterMm: definition.majorDiameter,
      pitchMm: definition.coarsePitch,
      profile: structuredClone(definition.profile),
      tolerance: structuredClone(definition.tolerance),
      runout: structuredClone(definition.runout),
      requestedSpan: structuredClone(definition.span),
      resolvedSpanMm: {
        start: resolvedSpan.startMm,
        end: resolvedSpan.endMm,
        length: resolvedSpan.lengthMm,
        turnCount: resolvedSpan.turnCount,
        fullTurnCount: resolvedSpan.fullTurnCount,
      },
    },
    resultBrepSha256,
    resultTopology: assemblyFeatureTopologyEvidence(resultShape, resultNames),
    cosmeticGeometryUnchanged: definition.mode === 'cosmetic',
    representation: definition.mode === 'cosmetic'
      ? studioThreadCosmeticRepresentation(definition, support, resolvedSpan)
      : null,
  };
}


function modeledThreadV2Outcome(feature, shape, names, definition) {
  if (!topo || !importedTopologyRegistry) {
    throw new Error('Thread requires the exact persistent-topology runtime.');
  }
  const lookups = topo.nameLookups(shape, names || []);
  let grooves = [];
  let allowanceTool = null;
  let axialClipTool = null;
  let combinedGrooveTool = null;
  let resultShape = null;
  let resultNames = null;
  let borrowedResultOwners = false;
  try {
    const targetFace = resolveModifierTopologyReference(definition.support.face, 'face', lookups);
    const storedSignature = assertCurrentThreadFaceReference(definition.support.face, targetFace);
    const support = exactThreadCylinderSupport(targetFace);
    if (support.classification !== definition.threadKind) {
      throw new Error(
        `Thread target is an ${support.classification} cylindrical support, not the authored ${definition.threadKind} support.`,
      );
    }
    const resolvedSpan = studioThreadResolveAxialSpan(definition, support.length);
    const geometry = threadProfileGeometry(definition, support);
    const sourceBrepSha256 = studioV5Sha256Hex(canonicalStudioBrepEvidence(rc, shape));
    if (definition.mode === 'cosmetic') {
      // Cosmetic Thread is a typed no-op on the exact solid. Keep the same
      // OCCT shape and name-table owners so even topology ordering and
      // canonical BREP bytes remain unchanged; the caller transfers those
      // owners instead of deleting them.
      resultShape = shape;
      resultNames = names;
      borrowedResultOwners = true;
    } else {
      allowanceTool = buildStudioThreadAllowanceTool(definition, support, geometry, resolvedSpan);
      axialClipTool = buildStudioThreadAxialClip(support, geometry, resolvedSpan);
      grooves = buildStudioThreadGroove(definition, support, geometry, resolvedSpan);
      if (definition.runout.form === 'one-pitch-taper') {
        combinedGrooveTool = grooves[0].clone();
        for (let grooveIndex = 1; grooveIndex < grooves.length; grooveIndex += 1) {
          const fused = combinedGrooveTool.fuse(grooves[grooveIndex]);
          safeDelete(combinedGrooveTool);
          combinedGrooveTool = fused;
        }
        const combinedGrooveGeometry = bodyGeometry(combinedGrooveTool);
        if (!combinedGrooveGeometry.valid) {
          throw new Error('Modeled Thread tapered groove did not combine into one valid exact tool.');
        }
      }
      const before = bodyGeometry(shape);
      let workingShape = shape;
      let ownsWorkingShape = false;
      try {
        let threadToolIndex = 0;
        const threadTools = [
          ...(allowanceTool ? [allowanceTool] : []),
          ...(combinedGrooveTool ? [combinedGrooveTool] : grooves),
        ];
        for (const tool of threadTools) {
          let clippedTool = null;
          try {
            const cutTool = tool === allowanceTool
              ? tool
              : (clippedTool = exactStudioThreadCommon(tool, axialClipTool));
            if (clippedTool) {
              const clippedGeometry = bodyGeometry(clippedTool);
              if (!clippedGeometry.valid) {
                throw new Error(
                  `Modeled Thread exact groove step ${threadToolIndex} did not clip to one valid solid.`,
                );
              }
            }
            const next = exactStudioThreadCut(workingShape, cutTool);
            const stepGeometry = bodyGeometry(next);
            if (!stepGeometry.valid) {
              safeDelete(next);
              throw new Error(`Modeled Thread exact tool step ${threadToolIndex} produced an invalid solid.`);
            }
            if (ownsWorkingShape) safeDelete(workingShape);
            workingShape = next;
            ownsWorkingShape = true;
            threadToolIndex += 1;
          } finally {
            safeDelete(clippedTool);
          }
        }
        resultShape = workingShape;
        ownsWorkingShape = false;
      } finally {
        if (ownsWorkingShape) safeDelete(workingShape);
      }
      const after = bodyGeometry(resultShape);
      if (!after.valid) throw new Error('Modeled Thread did not produce exactly one valid solid.');
      if (before.volume - after.volume <= Math.max(1e-8, before.volume * 1e-10)) {
        throw new Error('Modeled Thread exact groove removed no material from its selected cylindrical support.');
      }
      resultNames = completeStudioThreadNames(resultShape, shape, names, feature.id);
    }
    assertCompleteFeatureTopology(resultShape, resultNames, 'Thread v2');
    const threadEvidence = studioThreadEvidenceEntry({
      feature,
      definition,
      support,
      storedSignature,
      resolvedSpan,
      sourceBrepSha256,
      resultShape,
      resultNames,
    });
    const result = { shape: resultShape, names: resultNames, threadEvidence };
    resultShape = null;
    resultNames = null;
    return result;
  } catch (error) {
    if (typeof error?.code === 'string') throw error;
    throw codedFeatureError(
      'THREAD_EXACT_KERNEL_REFUSED',
      String(error?.message || error) + ' No geometry was published.',
      { featureId: feature.id, schema: definition.schema },
    );
  } finally {
    if (!borrowedResultOwners) {
      safeDelete(resultShape);
      disposeNameTable(resultNames);
    }
    safeDelete(allowanceTool);
    safeDelete(axialClipTool);
    safeDelete(combinedGrooveTool);
    for (const groove of grooves) safeDelete(groove);
    lookups.dispose();
  }
}

function modeledThreadOutcome(feature, shape, names) {
  const definition = assertStudioThreadFeature(feature);
  return modeledThreadV2Outcome(feature, shape, names, definition);
}

const STUDIO_DIRECT_EDIT_MIN_DISTANCE_MM = 1e-9;
const STUDIO_DIRECT_EDIT_PARALLEL_DOT = 1 - 1e-8;

function studioDirectEditPlane(face, label) {
  if (face?.geomType !== 'PLANE') throw new Error(label + ' must remain an exact planar face.');
  let center = null;
  let normal = null;
  try {
    center = face.center;
    normal = face.normalAt(center);
    const origin = [center.x, center.y, center.z];
    const rawNormal = [normal.x, normal.y, normal.z];
    const magnitude = Math.hypot(...rawNormal);
    if (origin.some((value) => !Number.isFinite(value))
      || rawNormal.some((value) => !Number.isFinite(value))
      || !(magnitude > 1e-12)) {
      throw new Error(label + ' did not expose a finite exact plane.');
    }
    return {
      origin,
      normal: rawNormal.map((value) => value / magnitude),
    };
  } finally {
    safeDelete(normal);
    safeDelete(center);
  }
}

function studioDirectEditDistance(value, label) {
  if (!Number.isFinite(value)
    || Math.abs(value) <= STUDIO_DIRECT_EDIT_MIN_DISTANCE_MM
    || Math.abs(value) > STUDIO_DIRECT_EDIT_MAX_DISTANCE_MM) {
    throw new Error(
      label + ' must be finite, nonzero, and no greater than '
        + STUDIO_DIRECT_EDIT_MAX_DISTANCE_MM + ' mm in magnitude.',
    );
  }
  return value;
}

function studioDirectEditStation(targetPlane, stationPlane, label) {
  const alignment = studioV5VectorMath.dot(targetPlane.normal, stationPlane.normal);
  if (Math.abs(alignment) < STUDIO_DIRECT_EDIT_PARALLEL_DOT) {
    throw new Error(label + ' must remain parallel to the target face.');
  }
  return studioDirectEditDistance(
    studioV5VectorMath.dot(
      studioV5VectorMath.subtract(stationPlane.origin, targetPlane.origin),
      targetPlane.normal,
    ),
    label + ' station distance',
  );
}

function studioDirectEditFaceOnlyNames(names) {
  const table = (names || []).map((entry) => ({ name: entry.name, face: entry.face.clone() }));
  table.diagnostics = structuredClone(names?.diagnostics || []);
  return table;
}

function buildStudioDirectEditModifier(feature, shape, names, N, evaluateBody) {
  if (!topo || !offsetFeatureHistory || !patternFeatureHistory) {
    throw new Error('Direct Edit requires the exact persistent-topology runtime.');
  }
  if (typeof evaluateBody !== 'function') throw new Error('Direct Edit body evaluation is unavailable.');
  if (typeof feature.sourceBodyId !== 'string' || !feature.sourceBodyId) {
    throw new Error('Direct Edit requires its current source body identity.');
  }
  if (feature.targetBodyId !== undefined && feature.targetBodyId !== feature.sourceBodyId) {
    throw new Error('Direct Edit targetBodyId must identify its current source body.');
  }

  let targetLookups = null;
  let replacementLookups = null;
  let completeTables = null;
  let targetEdges = [];
  let targetVertices = [];
  let tool = null;
  let booleanToolNames = null;
  let outcome = null;
  try {
    targetLookups = topo.nameLookups(shape, names || []);
    const targetFace = resolveModifierTopologyReference(feature.targetFace, 'face', targetLookups);
    const targetFaceName = targetLookups.getFaceName(targetFace);
    if (!targetFaceName) throw new Error('Direct Edit target face has no current persistent name.');
    const targetPlane = studioDirectEditPlane(targetFace, 'Direct Edit target');

    let signedDistance;
    if (feature.operation === 'push-pull') {
      signedDistance = studioDirectEditDistance(
        evaluatedFeatureValue(
          feature.distance,
          N,
          'DIRECT_EDIT_DISTANCE_INVALID',
          'Direct Edit Push/Pull distance',
        ),
        'Direct Edit Push/Pull distance',
      );
    } else if (feature.operation === 'replace-face') {
      if (typeof feature.replacementBodyId !== 'string' || !feature.replacementBodyId) {
        throw new Error('Replace Face requires a replacement body.');
      }
      if (feature.replacementBodyId === feature.sourceBodyId) {
        throw new Error('Replace Face requires a distinct replacement body.');
      }
      const replacement = evaluateBody(feature.replacementBodyId);
      if (!replacement?.shape || replacement.error || !replacement.geometry?.valid) {
        throw new Error('Replace Face replacement body has no current valid exact solid.');
      }
      replacementLookups = topo.nameLookups(replacement.shape, replacement.names || []);
      const replacementFace = resolveModifierTopologyReference(
        feature.replacementFace,
        'face',
        replacementLookups,
      );
      const replacementPlane = studioDirectEditPlane(replacementFace, 'Replace Face reference');
      signedDistance = studioDirectEditStation(targetPlane, replacementPlane, 'Replace Face reference');
    } else if (feature.operation === 'delete-face') {
      const patchFace = resolveModifierTopologyReference(feature.patchFace, 'face', targetLookups);
      if (exactWrappedMatch(targetFace, patchFace)) {
        throw new Error('Delete Face patch must be a distinct current face on the target body.');
      }
      const patchPlane = studioDirectEditPlane(patchFace, 'Delete Face patch');
      signedDistance = studioDirectEditStation(targetPlane, patchPlane, 'Delete Face patch');
    } else {
      throw new Error('Direct Edit operation "' + String(feature.operation) + '" is unsupported.');
    }

    // Prove the selected face owns complete persistent boundary identity before
    // the prism builder receives any topology. The complete tables use exact
    // IsSame membership and are never inferred from coordinates or traversal
    // order.
    completeTables = completePatternTopologyTables(shape, names || []);
    targetEdges = offsetFeatureHistory.exactEdges(targetFace);
    targetVertices = topo.exactVertices(targetFace);
    const boundaryEdgeTable = completeTables.edges.filter((entry) =>
      targetEdges.some((edge) => exactWrappedMatch(edge, entry.edge)));
    const boundaryVertexTable = completeTables.vertices.filter((entry) =>
      targetVertices.some((vertex) => exactWrappedMatch(vertex, entry.vertex)));
    if (boundaryEdgeTable.length !== targetEdges.length
      || targetEdges.some((edge) => boundaryEdgeTable.filter((entry) =>
        exactWrappedMatch(edge, entry.edge)).length !== 1)) {
      throw new Error('Direct Edit target boundary is missing one-to-one persistent edge identity.');
    }
    if (boundaryVertexTable.length !== targetVertices.length
      || targetVertices.some((vertex) => boundaryVertexTable.filter((entry) =>
        exactWrappedMatch(vertex, entry.vertex)).length !== 1)) {
      throw new Error('Direct Edit target boundary is missing one-to-one persistent vertex identity.');
    }

    tool = offsetFeatureHistory.planarThickenWithHistory({
      sourceFace: targetFace,
      sourceFaceName: targetFaceName,
      boundaryEdgeTable,
      explicitEdgeTable: boundaryEdgeTable,
      explicitVertexTable: boundaryVertexTable,
      topologyDiagnostics: names?.diagnostics || [],
      propagateExplicitTopology: topo.propagateExplicitTopology,
      featureId: feature.id,
      direction: targetPlane.normal.map((value) => value * Math.sign(signedDistance)),
      thickness: Math.abs(signedDistance),
      symmetric: false,
    });
    assertCompleteFeatureTopology(tool.shape, tool.names, 'Direct Edit ' + feature.id + ' exact prism');

    const before = bodyGeometry(shape);
    // The prism owns complete explicit boundary tables for standalone proof.
    // Its start boundary is IsSame with the target boundary, however, so the
    // Boolean receives face provenance only for the tool. This preserves the
    // target's higher-precedence opaque edge/vertex identities while new tool
    // topology is named from its complete face history after the Boolean.
    booleanToolNames = studioDirectEditFaceOnlyNames(tool.names);
    const booleanKind = signedDistance > 0 ? 'fuse' : 'cut';
    outcome = topo.booleanWithNames(
      booleanKind,
      shape,
      tool.shape,
      names || [],
      booleanToolNames,
    );
    const after = bodyGeometry(outcome.shape);
    if (!after.valid) throw new Error('Direct Edit did not produce exactly one valid solid.');
    const materialDelta = booleanKind === 'fuse'
      ? after.volume - before.volume
      : before.volume - after.volume;
    if (!(materialDelta > Math.max(1e-7, Math.abs(before.volume) * 1e-9))) {
      throw new Error('Direct Edit did not change the intended exact material volume.');
    }
    assertCompleteFeatureTopology(outcome.shape, outcome.names, 'Direct Edit ' + feature.id + ' result');
    const result = outcome;
    outcome = null;
    return result;
  } catch (error) {
    if (typeof error?.code === 'string') throw error;
    throw codedFeatureError(
      'DIRECT_EDIT_KERNEL_REFUSED',
      String(error?.message || error) + ' No geometry was published.',
      { featureId: feature.id, operation: feature.operation },
    );
  } finally {
    if (outcome) {
      safeDelete(outcome.shape);
      disposeNameTable(outcome.names);
    }
    disposeNameTable(booleanToolNames);
    if (tool) {
      safeDelete(tool.shape);
      disposeNameTable(tool.names);
    }
    offsetFeatureHistory.disposeWrappers(targetEdges);
    topo.disposeWrappers(targetVertices);
    patternFeatureHistory.disposeTables(completeTables);
    replacementLookups?.dispose();
    targetLookups?.dispose();
  }
}

function applyBodyModifier(document, part, feature, shape, N, names = [], evaluateBody = null) {
  if (feature.type === 'direct-edit') {
    return buildStudioDirectEditModifier(feature, shape, names, N, evaluateBody);
  }
  if (feature.type === 'weldment-treatment') {
    return buildStudioWeldmentTreatmentModifier(document, part, feature, shape, names, N, evaluateBody);
  }
  if (feature.type === 'sheet-metal-flange') {
    return buildStudioSheetMetalModifier(document, part, feature, shape, names, N);
  }
  if (feature.type === 'thread') return modeledThreadOutcome(feature, shape, names);
  if (feature.type === 'fillet' || feature.type === 'chamfer') {
    if (!topo) throw new Error('persistent topology naming is unavailable for ' + feature.type);
    const radius = positiveFeatureValue(
      feature.r,
      N,
      STUDIO_V5_FEATURE_INPUT_ERROR_CODES.modifierRadius,
      (feature.type === 'fillet' ? 'Fillet' : 'Chamfer') + ' radius',
    );
    const lookups = topo.nameLookups(shape, names);
    try {
      if (feature.extensions?.advancedFillet?.mode === 'adjacent-face-pair') {
        const faceRefs = feature.faces || [];
        if (faceRefs.length !== 2) throw new Error('Face Fillet requires exactly two selected faces');
        const selectedFaces = faceRefs.map((reference) =>
          resolveModifierTopologyReference(reference, 'face', lookups));
        if (exactWrappedMatch(selectedFaces[0], selectedFaces[1])) {
          throw new Error('Face Fillet requires two distinct exact faces');
        }
        let leftEdges = [];
        let rightEdges = [];
        try {
          leftEdges = selectedFaces[0].edges;
          rightEdges = selectedFaces[1].edges;
          const shared = lookups.edgeCandidates.filter((candidate) =>
            leftEdges.some((edge) => exactWrappedMatch(edge, candidate))
            && rightEdges.some((edge) => exactWrappedMatch(edge, candidate)));
          if (!shared.length) throw new Error('Face Fillet selected faces are not adjacent');
          if (shared.length !== 1) throw new Error('Face Fillet selected faces have an ambiguous shared-edge set');
          const edgeName = topologyCandidateName(shared[0], 'edge', lookups);
          return topo.filletChamferWithNames('fillet', shape, [{ edge: shared[0], radii: radius, edgeName }], names, feature.id);
        } finally {
          for (const edge of leftEdges) safeDelete(edge);
          for (const edge of rightEdges) safeDelete(edge);
        }
      }
      const variableByEdge = [];
      for (const entry of feature.variableRadii || []) {
        const edge = resolveModifierTopologyReference(entry?.edge, 'edge', lookups);
        if (variableByEdge.some((candidate) => exactWrappedMatch(candidate.edge, edge))) {
          throw new Error('variable fillet contains duplicate references to the same exact edge');
        }
        variableByEdge.push({ edge, entry });
      }
      const radiiFor = (edge) => {
        if (feature.type !== 'fillet') return radius;
        const variable = variableByEdge.find((candidate) => exactWrappedMatch(candidate.edge, edge))?.entry;
        if (variable) {
          const start = positiveFeatureValue(
            variable.startRadius,
            N,
            STUDIO_V5_FEATURE_INPUT_ERROR_CODES.modifierRadius,
            'Variable Fillet start radius',
          );
          const end = positiveFeatureValue(
            variable.endRadius,
            N,
            STUDIO_V5_FEATURE_INPUT_ERROR_CODES.modifierRadius,
            'Variable Fillet end radius',
          );
          return [start, end];
        }
        return radius;
      };
      let picks = [];
      for (const reference of feature.edges || []) {
        const edge = resolveModifierTopologyReference(reference, 'edge', lookups);
        if (picks.some((candidate) => exactWrappedMatch(candidate.edge, edge))) continue;
        const edgeName = topologyCandidateName(edge, 'edge', lookups);
        picks.push({ edge, radii: radiiFor(edge), edgeName });
      }
      if (!picks.length) throw new Error('the picked edges no longer exist — edit or delete this feature');
      let robustnessEvidence = null;
      if (feature.tangentPropagation === true) {
        const exactPolicy = hasStudioExactTangentFilletPolicy(feature);
        if (exactPolicy && (feature.type !== 'fillet' || feature.extensions?.advancedFillet || variableByEdge.length)) {
          throw new Error('tangent-chain propagation requires a constant-radius edge Fillet');
        }
        if (exactPolicy) {
          if (!kernelRobustness) throw new Error('exact tangent-chain planning is unavailable');
          const plan = kernelRobustness.planTangentFillet(
            shape,
            picks,
            lookups.edgeCandidates,
            (edge) => topologyCandidateName(edge, 'edge', lookups),
            {
              featureId: feature.id,
              documentHash: studioV5CanonicalHash(document),
              sourceBrepSha256: studioV5Sha256Hex(canonicalStudioBrepEvidence(rc, shape)),
            },
          );
          picks = plan.picks;
          robustnessEvidence = plan.evidence;
        } else throw new Error('tangent-chain propagation requires an exact kernel policy');
      }
      const outcome = topo.filletChamferWithNames(feature.type, shape, picks, names, feature.id);
      if (robustnessEvidence) {
        outcome.kernelRobustnessEvidence = {
          ...robustnessEvidence,
          resultBrepSha256: studioV5Sha256Hex(canonicalStudioBrepEvidence(rc, outcome.shape)),
          resultTopology: {
            faces: topologyCount(outcome.shape, 'face'),
            edges: topologyCount(outcome.shape, 'edge'),
            vertices: topologyCount(outcome.shape, 'vertex'),
          },
        };
      }
      return outcome;
    } finally {
      lookups.dispose();
    }
  }
  if (feature.type === 'draft') {
    if (!topo) throw new Error('persistent topology naming is unavailable for Draft');
    const lookups = topo.nameLookups(shape, names);
    try {
      const draftFaces = (feature.faces || []).map((reference) =>
        resolveModifierTopologyReference(reference, 'face', lookups));
      if (!draftFaces.length) throw new Error('the picked draft faces no longer exist — repair this feature');
      const angle = N(feature.angle) * (feature.flip ? -1 : 1);
      if (!(Math.abs(angle) > 1e-6 && Math.abs(angle) < 89)) throw new Error('draft angle must stay between -89 and 89 degrees and not be zero');
      const neutralPlane = datumPlaneForFeature(document, part, feature.neutralPlaneDatumId);
      try {
        return topo.draftWithNames(shape, draftFaces, names, angle, neutralPlane);
      } finally {
        neutralPlane.delete();
      }
    } finally {
      lookups.dispose();
    }
  }
  if (feature.type === 'shell') {
    if (!topo || !offsetFeatureHistory) throw new Error('persistent topology naming is unavailable for Shell');
    const lookups = topo.nameLookups(shape, names);
    try {
      const shellFaces = (feature.faces || []).map((reference) =>
        resolveModifierTopologyReference(reference, 'face', lookups));
      if (!shellFaces.length) throw new Error('the picked faces no longer exist — edit or delete this feature');
      return offsetFeatureHistory.shellWithHistory({
        shape,
        openingFaces: shellFaces,
        faceTable: names,
        edgeTable: lookups.edgeTable,
        propagateExplicitTopology: topo.propagateExplicitTopology,
        featureId: feature.id,
        // Preserve Replicad's public sign convention used by the previous
        // implementation. The history module negates this value for OCCT.
        thickness: -positiveFeatureValue(
          feature.t,
          N,
          STUDIO_V5_FEATURE_INPUT_ERROR_CODES.shellThickness,
          'Shell thickness',
        ),
      });
    } finally {
      lookups.dispose();
    }
  }
  return null;
}

function thickenStudioV5Face(feature, sourceShape, N, names = []) {
  if (!topo || !offsetFeatureHistory) throw new Error('persistent topology naming is unavailable for Thicken');
  const lookups = topo.nameLookups(sourceShape, names);
  let faceEdges = [];
  let faceVertices = [];
  try {
    const thickenFaces = (feature.faces || []).map((reference) =>
      resolveModifierTopologyReference(reference, 'face', lookups));
    if (thickenFaces.length !== 1) throw new Error('Thicken requires exactly one source face');
    const face = thickenFaces[0];
    if (face.geomType !== 'PLANE') throw new Error('this Thicken increment requires a planar source face');
    const sourceFaceName = lookups.getFaceName(face);
    if (!sourceFaceName) throw new Error('the Thicken source face has no persistent topology name');
    const thickness = N(feature.thickness);
    if (!(thickness > 0)) throw new Error('Thicken distance must stay above zero');
    let normalValue = null;
    let direction = null;
    try {
      normalValue = face.normalAt();
      direction = [normalValue.x, normalValue.y, normalValue.z]
        .map((value) => value * (feature.flip ? -1 : 1));
    } finally {
      safeDelete(normalValue);
    }
    faceEdges = offsetFeatureHistory.exactEdges(face);
    faceVertices = topo.exactVertices(face);
    const boundaryEdgeTable = lookups.edgeTable.filter((entry) =>
      faceEdges.some((edge) => exactWrappedMatch(edge, entry.edge)));
    if (boundaryEdgeTable.length !== faceEdges.length) {
      throw new Error('the Thicken source boundary is missing persistent edge provenance');
    }
    return offsetFeatureHistory.planarThickenWithHistory({
      sourceFace: face,
      sourceFaceName,
      boundaryEdgeTable,
      explicitEdgeTable: Object.prototype.hasOwnProperty.call(names, 'explicitEdgeTable')
        ? names.explicitEdgeTable.filter((entry) =>
            faceEdges.some((edge) => exactWrappedMatch(edge, entry.edge)))
        : null,
      explicitVertexTable: Object.prototype.hasOwnProperty.call(names, 'explicitVertexTable')
        ? names.explicitVertexTable.filter((entry) =>
            faceVertices.some((vertex) => exactWrappedMatch(vertex, entry.vertex)))
        : null,
      topologyDiagnostics: names?.diagnostics || [],
      propagateExplicitTopology: topo.propagateExplicitTopology,
      featureId: feature.id,
      direction,
      thickness,
      symmetric: feature.symmetric === true,
    });
  } finally {
    offsetFeatureHistory.disposeWrappers(faceEdges);
    topo.disposeWrappers(faceVertices);
    lookups.dispose();
  }
}

function transformDirection(frame) {
  if (frame.kind === 'plane') return frame.normal;
  if (frame.kind === 'axis') return frame.direction;
  return frame.zDirection;
}

function transformOrigin(frame) {
  return frame.origin;
}

function rotationBetween(from, to) {
  const { cross, dot, length, normalize } = studioV5VectorMath;
  const source = normalize(from);
  const target = normalize(to);
  const product = Math.max(-1, Math.min(1, dot(source, target)));
  let axis = cross(source, target);
  if (length(axis) < 1e-8) {
    if (product > 0) return { axis: [1, 0, 0], angle: 0 };
    axis = cross(source, Math.abs(source[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0]);
  }
  return { axis: normalize(axis), angle: Math.acos(product) * 180 / Math.PI };
}

function applyStudioV5Transform(document, part, feature, sourceShape, names = []) {
  if (!topo) throw new Error('persistent topology naming is unavailable for Transform');
  const resolved = resolveStudioV5Transform(document, part, feature);
  const { add, subtract, multiply, dot, cross, length, normalize, rotateVector } = studioV5VectorMath;
  let next = sourceShape;
  let nextNames = names;
  let ownsNext = false;
  const applyStep = (configure) => {
    const transformation = new rc.Transformation();
    try {
      configure(transformation);
      const outcome = topo.transformWithNames(next, transformation, nextNames);
      if (ownsNext) {
        safeDelete(next);
        disposeNameTable(nextNames);
      }
      next = outcome.shape;
      nextNames = outcome.names;
      ownsNext = true;
    } finally {
      transformation.delete();
    }
  };
  try {
    if (resolved.mode === 'translate' || resolved.mode === 'move' || resolved.mode === 'copy') {
      applyStep((transformation) => transformation.translate(resolved.translation));
    } else if (resolved.mode === 'rotate') {
      applyStep((transformation) => transformation.rotate(resolved.angle, resolved.origin, resolved.direction));
    } else if (resolved.mode === 'scale') {
      if (!(resolved.factor > 0)) throw new Error('Scale factor must be greater than zero.');
      applyStep((transformation) => transformation.scale(resolved.center, resolved.factor));
    } else if (resolved.mode === 'mirror') {
      applyStep((transformation) => transformation.mirror(resolved.normal, resolved.origin));
    } else if (resolved.mode === 'align') {
      const fromDirection = transformDirection(resolved.from);
      const toDirection = resolved.flip ? multiply(transformDirection(resolved.to), -1) : transformDirection(resolved.to);
      const rotation = rotationBetween(fromDirection, toDirection);
      if (Math.abs(rotation.angle) > 1e-8) {
        applyStep((transformation) => transformation.rotate(rotation.angle, transformOrigin(resolved.from), rotation.axis));
      }
      if (resolved.from.xDirection && resolved.to.xDirection) {
        const rotatedFromX = Math.abs(rotation.angle) > 1e-8
          ? rotateVector(resolved.from.xDirection, rotation.axis, rotation.angle)
          : resolved.from.xDirection;
        const projectToAlignmentPlane = (direction) => subtract(direction, multiply(toDirection, dot(direction, toDirection)));
        const sourceX = projectToAlignmentPlane(rotatedFromX);
        const targetX = projectToAlignmentPlane(resolved.to.xDirection);
        if (length(sourceX) > 1e-8 && length(targetX) > 1e-8) {
          const fromX = normalize(sourceX);
          const toX = normalize(targetX);
          const twist = Math.atan2(dot(toDirection, cross(fromX, toX)), Math.max(-1, Math.min(1, dot(fromX, toX)))) * 180 / Math.PI;
          if (Math.abs(twist) > 1e-8) {
            applyStep((transformation) => transformation.rotate(twist, transformOrigin(resolved.from), toDirection));
          }
        }
      }
      const destination = add(transformOrigin(resolved.to), multiply(toDirection, resolved.offset));
      applyStep((transformation) => transformation.translate(subtract(destination, transformOrigin(resolved.from))));
    } else {
      throw new Error('Unsupported transform operation.');
    }
    return { shape: next, names: nextNames };
  } catch (error) {
    if (ownsNext) {
      safeDelete(next);
      disposeNameTable(nextNames);
    }
    throw error;
  }
}

function evaluatedSketchPoints(sketch, N) {
  const entity = sketch?.entities?.[0];
  if (!entity || !Array.isArray(entity.points)) throw new Error('sketch has no editable point geometry');
  return entity.points.map((point) => point.map((value) => N(value)));
}

function mappedSectionPointRecords(points, section) {
  const records = points.map((point, originalIndex) => ({ point, originalIndex }));
  const start = section.startIndex || 0;
  const ordered = [...records.slice(start), ...records.slice(0, start)];
  return section.reversed ? [ordered[0], ...ordered.slice(1).reverse()] : ordered;
}

// BRepBuilderAPI_MakeWire may replace an input edge while connecting it to the
// preceding edge. OCCT exposes the authoritative edge after every Add through
// Edge(); keeping the pre-builder wrapper silently loses history for every
// rewritten edge. Capture only those exact builder results and prove that each
// is present exactly once in the completed wire before exposing it as a
// persistent profile source. No endpoint, geometry, or traversal-order match
// is permitted here.
function assembleProfileWireWithSources(sourceEdges) {
  if (!profileFeatureHistory) throw new Error('persistent profile topology history is unavailable');
  const oc = rc.getOC();
  const builder = new oc.BRepBuilderAPI_MakeWire_1();
  const progress = new oc.Message_ProgressRange_1();
  const sources = [];
  let wire = null;
  let wireEdges = [];
  try {
    for (const source of sourceEdges) {
      builder.Add_1(source.edge.wrapped);
      if (!builder.IsDone() || builder.Error() !== oc.BRepBuilderAPI_WireError.BRepBuilderAPI_WireDone) {
        throw new Error('OCCT could not connect profile edge "' + source.entityId + '"');
      }
      let rawEdge = null;
      try {
        rawEdge = builder.Edge();
        sources.push({
          sketchId: source.sketchId,
          entityId: source.entityId,
          edge: rc.cast(rawEdge),
        });
      } finally {
        safeDelete(rawEdge);
      }
    }
    builder.Build(progress);
    if (!builder.IsDone()) throw new Error('OCCT could not complete the profile wire');
    let rawWire = null;
    try {
      rawWire = builder.Wire();
      wire = rc.cast(rawWire);
    } finally {
      safeDelete(rawWire);
    }
    wireEdges = profileFeatureHistory.exactEdges(wire);
    for (const source of sources) {
      const matches = wireEdges.filter((edge) => edge.wrapped.IsSame(source.edge.wrapped));
      if (matches.length !== 1) {
        throw new Error(
          'Profile source "' + source.entityId + '" does not map to exactly one completed wire edge.',
        );
      }
    }
    const outcome = { wire, sources };
    wire = null;
    return outcome;
  } catch (error) {
    safeDelete(wire);
    for (const source of sources) safeDelete(source.edge);
    throw error;
  } finally {
    profileFeatureHistory.disposeWrappers(wireEdges);
    safeDelete(progress);
    safeDelete(builder);
  }
}

function profileSketch3dData(document, part, sketch, section, N) {
  if (sketch.extensions?.studioRole !== 'profile' || sketch.support?.ownerKind !== 'datum') throw new Error('Loft and Sweep profiles must be plane-supported profile sketches');
  const frame = resolveStudioV5Datums(document, part.id).resolve(sketch.support.ownerId);
  if (frame.kind !== 'plane') throw new Error('profile support is not a plane');
  const entity = sketch.entities[0];
  const records = mappedSectionPointRecords(evaluatedSketchPoints(sketch, N), section || {});
  const { add, subtract, multiply } = studioV5VectorMath;
  const worldRecords = records.map(({ point: [x, y], originalIndex }) => ({
    point: add(frame.origin, add(multiply(frame.xDirection, x), multiply(frame.yDirection, y))),
    originalIndex,
  }));
  const edges = entity.kind === 'spline'
    ? worldRecords.map(({ point }, index) => {
      const previous = worldRecords[(index - 1 + worldRecords.length) % worldRecords.length].point;
      const next = worldRecords[(index + 1) % worldRecords.length].point;
      const after = worldRecords[(index + 2) % worldRecords.length].point;
      const control1 = add(point, multiply(subtract(next, previous), 1 / 6));
      const control2 = subtract(next, multiply(subtract(after, point), 1 / 6));
      return rc.makeBezierCurve([point, control1, control2, next]);
    })
    : worldRecords.map(({ point }, index) =>
      rc.makeLine(point, worldRecords[(index + 1) % worldRecords.length].point));
  let wireAssembly = null;
  let profile = null;
  try {
    wireAssembly = assembleProfileWireWithSources(edges.map((edge, index) => {
      const left = worldRecords[index].originalIndex;
      const right = worldRecords[(index + 1) % worldRecords.length].originalIndex;
      const low = Math.min(left, right);
      const high = Math.max(left, right);
      return {
        sketchId: sketch.id,
        entityId: `${entity.id}:segment:${low}:${high}`,
        edge,
      };
    }));
    profile = new rc.Sketch(wireAssembly.wire, { defaultOrigin: frame.origin, defaultDirection: frame.normal });
    wireAssembly.wire = null;
    const outcome = { profile, sources: wireAssembly.sources };
    profile = null;
    wireAssembly.sources = [];
    return outcome;
  } finally {
    for (const edge of edges) safeDelete(edge);
    for (const source of wireAssembly?.sources || []) safeDelete(source.edge);
    safeDelete(profile);
    safeDelete(wireAssembly?.wire);
  }
}

function disposeProfileSketch3dData(data) {
  for (const source of data?.sources || []) safeDelete(source.edge);
  safeDelete(data?.profile);
}

function attachProfileHistoryDiagnostics(outcome) {
  if (outcome?.names) outcome.names.diagnostics = [...(outcome.diagnostics || [])];
  return outcome;
}

function codedFeatureError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function pathCurveSegments3d(document, part, sketch, N, stack = []) {
  if (sketch?.extensions?.studioRole !== 'path') throw new Error('feature path reference is not a path sketch');
  if (stack.includes(sketch.id)) throw new Error('cyclic reference-curve path at "' + sketch.id + '"');
  const reference = sketch.extensions?.referenceCurve;
  const nextStack = [...stack, sketch.id];
  if (!reference) {
    const entity = sketch.entities?.[0];
    const points = evaluatedSketchPoints(sketch, N);
    if (entity?.kind === 'polyline') {
      return points.slice(1).map((point, index) => ({ kind: 'line', points: [points[index], point] }));
    }
    if (entity?.kind === 'spline') return studioV5OpenSplineBezierSegments(points);
    throw new Error('path sketch must contain one polyline or spline');
  }
  const sketchById = new Map((part.sketches || []).map((entry) => [entry.id, entry]));
  if (reference.kind === 'composite') {
    return reference.sourceSketchIds.flatMap((id) =>
      pathCurveSegments3d(document, part, sketchById.get(id), N, nextStack));
  }
  if (reference.kind === 'projected') {
    const sourceSegments = pathCurveSegments3d(document, part, sketchById.get(reference.sourceSketchId), N, nextStack);
    const plane = resolveStudioV5Datums(document, part.id).resolve(reference.planeDatumId);
    if (plane.kind !== 'plane') throw new Error('projected reference curve requires a plane datum');
    const { dot, multiply, subtract } = studioV5VectorMath;
    const project = (point) => subtract(point, multiply(plane.normal, dot(subtract(point, plane.origin), plane.normal)));
    return sourceSegments.map((segment) => ({ kind: segment.kind, points: segment.points.map(project) }));
  }
  throw new Error('analytic helix cannot be represented as exact line or spline spans for projection');
}

function pathEdgesFromSegments(segments) {
  return segments.map((segment) => segment.kind === 'bezier'
    ? rc.makeBezierCurve(segment.points)
    : rc.makeLine(segment.points[0], segment.points[1]));
}

function pathWire3d(document, part, sketch, N, stack = []) {
  if (sketch?.extensions?.studioRole !== 'path') throw new Error('feature path reference is not a path sketch');
  if (stack.includes(sketch.id)) throw new Error('cyclic reference-curve path at "' + sketch.id + '"');
  const reference = sketch.extensions?.referenceCurve;
  if (reference?.kind === 'composite') {
    const sketchById = new Map((part.sketches || []).map((entry) => [entry.id, entry]));
    const wires = reference.sourceSketchIds.map((id) => pathWire3d(document, part, sketchById.get(id), N, [...stack, sketch.id]));
    const edges = [];
    try {
      for (const wire of wires) edges.push(...wire.edges);
      return rc.assembleWire(edges);
    } finally {
      for (const edge of edges) safeDelete(edge);
      for (const wire of wires) safeDelete(wire);
    }
  }
  if (reference?.kind === 'helix') {
    const frame = resolveStudioV5Datums(document, part.id).resolve(reference.axisDatumId);
    if (frame.kind !== 'axis' && frame.kind !== 'coordinate-system') throw new Error('helical reference curve requires an axis or coordinate system');
    const origin = frame.origin;
    const direction = frame.kind === 'axis' ? frame.direction : frame.zDirection;
    const pitch = N(reference.pitch);
    const turns = N(reference.turns);
    const radius = N(reference.radius);
    const startAngle = N(reference.startAngle ?? 0);
    const helix = rc.sketchHelix(pitch, pitch * turns, radius, origin, direction, reference.handedness === 'left');
    let wire = null;
    try {
      wire = helix.wires();
    } finally {
      helix.delete();
    }
    const { cross, dot, length, multiply, normalize, subtract } = studioV5VectorMath;
    const startDirection = normalize(subtract(pathFrameAtArcFraction(wire, 0).point, origin));
    let authoredX = frame.kind === 'coordinate-system' ? frame.xDirection : subtract([1, 0, 0], multiply(direction, dot([1, 0, 0], direction)));
    if (length(authoredX) <= 1e-8) {
      const fallback = Math.abs(direction[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
      authoredX = subtract(fallback, multiply(direction, dot(fallback, direction)));
    }
    authoredX = normalize(authoredX);
    const authoredPhase = Math.atan2(dot(direction, cross(startDirection, authoredX)), dot(startDirection, authoredX)) * 180 / Math.PI;
    const phase = authoredPhase + startAngle;
    if (Math.abs(phase) > 1e-12) {
      const rotated = wire.rotate(phase, origin, direction);
      safeDelete(wire);
      wire = rotated;
    }
    return wire;
  }
  if (!reference && sketch.entities?.[0]?.kind === 'spline') {
    // A plain spline spine stays one BSpline edge: BRepOffsetAPI_MakePipeShell
    // rejects the equivalent multi-Bezier wire (and its scale law requires a
    // single-edge spine), so the exact per-span Bezier representation is used
    // only for reference-curve projection, not for pipe spines.
    const points = evaluatedSketchPoints(sketch, N);
    const edge = rc.makeBSplineApproximation(points, { tolerance: 1e-4, degMax: 5 });
    try {
      return rc.assembleWire([edge]);
    } finally {
      safeDelete(edge);
    }
  }
  const edges = pathEdgesFromSegments(pathCurveSegments3d(document, part, sketch, N, stack));
  try {
    return rc.assembleWire(edges);
  } finally {
    for (const edge of edges) safeDelete(edge);
  }
}

function sectionFrames(document, part, sectionSketches) {
  const datums = resolveStudioV5Datums(document, part.id);
  return sectionSketches.map((sketch) => datums.resolve(sketch.support.ownerId));
}

function requireGuideIntersections(document, part, guideSketch, frames, N) {
  const points = evaluatedSketchPoints(guideSketch, N);
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    const intersects = points.some((point) => Math.abs(studioV5VectorMath.dot(studioV5VectorMath.subtract(point, frame.origin), frame.normal)) <= 1e-5);
    if (!intersects) throw new Error('guide curve misses Loft section ' + (index + 1));
  }
}

function loftContinuity(oc, feature) {
  const values = [feature.continuity?.start, feature.continuity?.end];
  if (values.includes('curvature')) return oc.GeomAbs_Shape.GeomAbs_C2;
  if (values.includes('tangent')) return oc.GeomAbs_Shape.GeomAbs_C1;
  return oc.GeomAbs_Shape.GeomAbs_C0;
}

function pipeShellFromProfiles(profileWires, spine, options = {}) {
  const oc = rc.getOC();
  const builder = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  const progress = new oc.Message_ProgressRange_1();
  let law = null;
  let trimmedLaw = null;
  let step = 'initialization';
  try {
    const transition = {
      transformed: oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_Transformed,
      round: oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner,
      right: oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner,
    }[options.transition || 'right'];
    step = 'transition setup';
    builder.SetTransitionMode(transition);
    if (options.auxiliarySpine) {
      step = 'guide setup';
      builder.SetMode_5(options.auxiliarySpine.wrapped, false, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
    } else if (options.fixedDirection) {
      step = 'fixed-direction setup';
      const direction = rc.makeDirection(options.fixedDirection);
      try { builder.SetMode_3(direction); } finally { direction.delete(); }
    } else {
      step = 'orientation setup';
      builder.SetMode_1(options.frenet === true);
    }
    if (profileWires.length === 1 && options.scaleEnd != null && Math.abs(options.scaleEnd - 1) > 1e-9) {
      law = new oc.Law_Linear();
      law.Set(0, 1, spine.length, options.scaleEnd);
      trimmedLaw = law.Trim(0, spine.length, 1e-6);
      step = 'scale-law profile setup';
      builder.SetLaw_1(profileWires[0].wrapped, trimmedLaw, false, true);
    } else {
      step = 'profile setup';
      profileWires.forEach((wire) => builder.Add_1(wire.wrapped, false, true));
    }
    step = 'build';
    builder.Build(progress);
    if (options.solid !== false) { step = 'solid closure'; builder.MakeSolid(); }
    step = 'shape extraction';
    let shape;
    try { shape = rc.cast(builder.Shape()); }
    catch (error) { throw new Error('pipe-shell result unavailable: ' + String(error?.message || error)); }
    if (!shape || shape.isNull) throw new Error('OpenCascade could not build the requested guided shape');
    if (options.withBounds) {
      const firstWire = rc.cast(builder.FirstShape());
      const lastWire = rc.cast(builder.LastShape());
      if (!rc.isWire(firstWire) || !rc.isWire(lastWire)) throw new Error('guided Loft did not retain usable end profiles');
      return [shape, firstWire, lastWire];
    }
    return shape;
  } catch (error) {
    throw new Error('guided shape failed during ' + step + ': ' + String(error?.message || error));
  } finally {
    try { trimmedLaw?.delete(); } catch {}
    try { law?.delete(); } catch {}
    progress.delete();
    builder.delete();
  }
}

function generatedTwistGuide(path, twistAngle) {
  const { cross, dot, length, multiply, add, normalize, rotateVector } = studioV5VectorMath;
  const samples = 32;
  const points = [];
  let previousTangent = null;
  let transported = null;
  for (let index = 0; index <= samples; index++) {
    const t = index / samples;
    const pointVector = path.pointAt(t);
    const tangentVector = path.tangentAt(Math.min(1 - 1e-7, Math.max(1e-7, t)));
    const point = [pointVector.x, pointVector.y, pointVector.z];
    const tangent = normalize([tangentVector.x, tangentVector.y, tangentVector.z]);
    pointVector.delete(); tangentVector.delete();
    if (!transported) {
      const preferred = Math.abs(tangent[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
      transported = normalize(cross(tangent, preferred));
    } else {
      const axis = cross(previousTangent, tangent);
      if (length(axis) > 1e-8) {
        const angle = Math.atan2(length(axis), Math.max(-1, Math.min(1, dot(previousTangent, tangent)))) * 180 / Math.PI;
        transported = rotateVector(transported, normalize(axis), angle);
      }
    }
    previousTangent = tangent;
    const twisted = rotateVector(transported, tangent, twistAngle * t);
    points.push(add(point, multiply(twisted, 1)));
  }
  const edge = rc.makeBSplineApproximation(points, { tolerance: 1e-4, degMax: 6 });
  return rc.assembleWire([edge]);
}

function buildStudioV5Loft(document, part, feature, N) {
  if (!profileFeatureHistory) throw new Error('persistent profile topology history is unavailable for Loft');
  if (feature.guideSketchIds?.length || feature.centerlineSketchId) {
    throw codedFeatureError(
      'PROFILE_HISTORY_GUIDED_LOFT_UNSUPPORTED',
      'Guided and centerline Loft are unavailable because this build cannot prove their face, edge, and vertex identity from OCCT history.',
      {
        guideSketchIds: [...(feature.guideSketchIds || [])],
        centerlineSketchId: feature.centerlineSketchId || null,
      },
    );
  }
  const sketchById = new Map(part.sketches.map((sketch) => [sketch.id, sketch]));
  const sectionSketches = feature.sections.map((section) => {
    const sketch = sketchById.get(section.sketchId);
    if (!sketch) throw new Error('missing Loft section sketch "' + section.sketchId + '"');
    return sketch;
  });
  const sections = sectionSketches.map((sketch, index) =>
    profileSketch3dData(document, part, sketch, feature.sections[index], N));
  try {
    const oc = rc.getOC();
    // Schema-5 dimensions are stored in millimetres; a 1e-4 mm Loft
    // approximation is already well below display, export, and inspection
    // tolerances. The previous 1e-6 mm solver target made every ordinary
    // three-section blade rebuild pay for nanometre-scale fitting.
    const continuity = loftContinuity(oc, feature);
    return attachProfileHistoryDiagnostics(profileFeatureHistory.loftWithHistory({
      featureId: feature.id,
      sections: sections.map((section, index) => ({
        id: feature.sections[index].id ?? feature.sections[index].sketchId,
        wire: section.profile.wire,
        edges: section.sources,
      })),
      ruled: feature.ruled === true,
      tolerance: 1e-4,
      solid: true,
      checkCompatibility: false,
      smoothing: feature.ruled !== true && continuity !== oc.GeomAbs_Shape.GeomAbs_C0,
      maxDegree: 4,
      continuity,
    }));
  } finally {
    sections.forEach(disposeProfileSketch3dData);
  }
}

function buildStudioV5Sweep(document, part, feature, N) {
  if (!profileFeatureHistory) throw new Error('persistent profile topology history is unavailable for Sweep');
  if (feature.extensions?.structuralMember) {
    try {
      assertStudioStructuralMemberPart(
        part,
        feature,
        'kernel.structuralMember[' + feature.id + ']',
        (value, label) => evaluatedFeatureValue(value, N, 'STRUCTURAL_MEMBER_EVIDENCE_INVALID', label),
      );
    } catch (error) {
      if (error?.code === 'STRUCTURAL_MEMBER_EVIDENCE_INVALID') throw error;
      throw codedFeatureError(
        'STRUCTURAL_MEMBER_EVIDENCE_INVALID',
        String(error?.message || error) + ' No geometry was published.',
        { featureId: feature.id },
      );
    }
  }
  const scaleEnd = positiveFeatureValue(
    feature.scaleEnd,
    N,
    STUDIO_V5_FEATURE_INPUT_ERROR_CODES.sweepScale,
    'Sweep end scale',
  );
  const sketchById = new Map(part.sketches.map((sketch) => [sketch.id, sketch]));
  const profileDefinition = sketchById.get(feature.profileSketchId);
  const pathDefinition = sketchById.get(feature.pathSketchId);
  if (!profileDefinition || !pathDefinition) throw new Error('Sweep profile or path sketch is missing');
  const profile = profileSketch3dData(document, part, profileDefinition, {}, N);
  const path = pathWire3d(document, part, pathDefinition, N);
  let auxiliary = null;
  try {
    if (feature.orientation === 'guide') {
      auxiliary = pathWire3d(document, part, sketchById.get(feature.guideSketchId), N);
    } else if (feature.orientation === 'controlled-twist') {
      auxiliary = generatedTwistGuide(path, N(feature.twistAngle));
    }
    return attachProfileHistoryDiagnostics(profileFeatureHistory.sweepWithHistory({
      featureId: feature.id,
      profileId: profileDefinition.id,
      profileWire: profile.profile.wire,
      profileEdges: profile.sources,
      spine: path,
      auxiliarySpine: auxiliary,
      fixedDirection: feature.orientation === 'fixed' || feature.orientation === 'reference' ? feature.referenceDirection.map(N) : null,
      frenet: feature.orientation === 'path-normal',
      scaleEnd,
      transition: feature.transition,
      solid: true,
    }));
  } finally {
    disposeProfileSketch3dData(profile); path.delete(); safeDelete(auxiliary);
  }
}

function checkedStudioWeldmentTreatment(part, feature, N) {
  try {
    return assertStudioWeldmentTreatmentPart(
      part,
      feature,
      'kernel.weldmentTreatment[' + feature.id + ']',
      (value, label) => evaluatedFeatureValue(value, N, 'WELDMENT_TREATMENT_EVIDENCE_INVALID', label),
    );
  } catch (error) {
    if (error?.code === 'WELDMENT_TREATMENT_EVIDENCE_INVALID') throw error;
    throw codedFeatureError(
      'WELDMENT_TREATMENT_EVIDENCE_INVALID',
      String(error?.message || error) + ' No geometry was published.',
      { featureId: feature.id },
    );
  }
}

function weldmentUnit(vector, label) {
  const length = Math.hypot(...vector);
  if (!(length > 1e-9) || !Number.isFinite(length)) throw new Error(label + ' must be a finite nonzero vector.');
  return vector.map((value) => value / length);
}

function weldmentPlaneAxes(normalInput, preferredInput = [0, 0, 1]) {
  const { cross, dot, multiply, subtract } = studioV5VectorMath;
  const normal = weldmentUnit(normalInput, 'Weldment treatment plane normal');
  let xDirection = subtract(preferredInput, multiply(normal, dot(preferredInput, normal)));
  if (Math.hypot(...xDirection) <= 1e-8) {
    const fallback = Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
    xDirection = subtract(fallback, multiply(normal, dot(fallback, normal)));
  }
  xDirection = weldmentUnit(xDirection, 'Weldment treatment plane x direction');
  return { normal, xDirection, yDirection: weldmentUnit(cross(normal, xDirection), 'Weldment treatment plane y direction') };
}

function weldmentPrismOutcome({ featureId, profileId, points, entityIds, origin, xDirection, normal, extent }) {
  if (!topo) throw new Error('persistent topology naming is unavailable for Weldment treatment');
  if (!Array.isArray(points) || points.length < 3 || points.some((point) =>
    !Array.isArray(point) || point.length !== 2 || point.some((value) => !Number.isFinite(value)))) {
    throw new Error('Weldment treatment profile must contain at least three finite two-dimensional points.');
  }
  if (!(Math.abs(extent) > 1e-7) || !Number.isFinite(extent)) throw new Error('Weldment treatment prism extent is invalid.');
  const frame = weldmentPlaneAxes(normal, xDirection);
  const ids = Array.isArray(entityIds) && entityIds.length === points.length
    ? entityIds
    : points.map((_, index) => profileId + ':edge:' + index);
  const { add, multiply } = studioV5VectorMath;
  const toWorld = ([x, y]) => add(origin, add(multiply(frame.xDirection, x), multiply(frame.yDirection, y)));
  let plane = null;
  let shape = null;
  let names = null;
  try {
    plane = new rc.Plane(origin, frame.xDirection, frame.normal);
    let drawing = rc.draw(points[0]);
    for (let index = 1; index < points.length; index++) drawing = drawing.lineTo(points[index]);
    shape = drawing.close().sketchOnPlane(plane).extrude(extent);
    names = topo.creationNamesForSweep(shape, {
      featureId,
      entities: points.map((point, index) => ({
        kind: 'line',
        id: ids[index],
        a2: point,
        b2: points[(index + 1) % points.length],
      })),
      toWorld,
      sweepDirection: frame.normal,
      capOffsets: [0, extent],
    });
    const geometry = bodyGeometry(shape);
    if (!geometry.valid) throw new Error('Weldment treatment prism is not exactly one valid solid.');
    assertCompleteFeatureTopology(shape, names, 'Weldment treatment ' + featureId);
    const outcome = { shape, names, diagnostics: names.diagnostics || [] };
    shape = null;
    names = null;
    return outcome;
  } finally {
    safeDelete(shape);
    disposeNameTable(names);
    safeDelete(plane);
  }
}

function weldmentMemberFrame(document, part, member) {
  const frame = resolveStudioV5Datums(document, part.id).resolve(member.recipe.profilePlaneId);
  if (frame?.kind !== 'plane') throw new Error('Structural-member profile frame is unavailable to the treatment.');
  const alignment = studioV5VectorMath.dot(frame.normal, member.currentTangent);
  if (alignment < 1 - 1e-8) throw new Error('Structural-member treatment frame is detached from the current exact Path tangent.');
  return frame;
}

function weldmentMemberPrism(document, part, featureId, member, origin, extent, profileId = 'member-profile') {
  const frame = weldmentMemberFrame(document, part, member);
  const points = member.profile.points;
  return weldmentPrismOutcome({
    featureId,
    profileId,
    points,
    entityIds: points.map((_, index) => profileId + ':segment:' + index),
    origin,
    xDirection: frame.xDirection,
    normal: frame.normal,
    extent,
  });
}

function weldmentBoundsCorners(bounds) {
  const corners = [];
  for (const x of [bounds[0][0], bounds[1][0]]) {
    for (const y of [bounds[0][1], bounds[1][1]]) {
      for (const z of [bounds[0][2], bounds[1][2]]) corners.push([x, y, z]);
    }
  }
  return corners;
}

function weldmentHalfspaceTool(shape, featureId, origin, removalDirection, preferredX) {
  const { dot, subtract } = studioV5VectorMath;
  const frame = weldmentPlaneAxes(removalDirection, preferredX);
  const relative = weldmentBoundsCorners(optimalShapeBounds(shape, 'Weldment treatment target'))
    .map((corner) => subtract(corner, origin));
  const extent = Math.max(
    1,
    ...relative.flatMap((point) => [
      Math.abs(dot(point, frame.xDirection)),
      Math.abs(dot(point, frame.yDirection)),
      Math.abs(dot(point, frame.normal)),
    ]),
  ) * 4 + 10;
  return weldmentPrismOutcome({
    featureId,
    profileId: 'removal-halfspace',
    points: [[-extent, -extent], [extent, -extent], [extent, extent], [-extent, extent]],
    entityIds: ['removal-bottom', 'removal-right', 'removal-top', 'removal-left'],
    origin,
    xDirection: frame.xDirection,
    normal: frame.normal,
    extent: extent * 2,
  });
}

function weldmentVolumeTolerance(volume) {
  return Math.max(1e-7, Math.abs(volume) * 1e-9);
}

function weldmentBooleanOutcome(kind, feature, shape, names, tool, label) {
  if (!topo) throw new Error('persistent topology naming is unavailable for Weldment treatment');
  const before = shapeVolume(shape);
  let outcome = null;
  try {
    outcome = topo.booleanWithNames(kind, shape, tool.shape, names, tool.names);
    const geometry = bodyGeometry(outcome.shape);
    if (!geometry.valid) throw new Error(label + ' did not produce exactly one valid solid.');
    const delta = kind === 'fuse' ? geometry.volume - before : before - geometry.volume;
    if (!(delta > weldmentVolumeTolerance(before))) throw new Error(label + ' did not change the intended exact material volume.');
    assertCompleteFeatureTopology(outcome.shape, outcome.names, label);
    const result = outcome;
    outcome = null;
    return { ...result, volumeDelta: delta };
  } catch (error) {
    if (typeof error?.code === 'string') throw error;
    throw codedFeatureError(
      'WELDMENT_TREATMENT_KERNEL_REFUSED',
      String(error?.message || error) + ' No geometry was published.',
      { featureId: feature.id, treatmentKind: feature.extensions?.weldmentTreatment?.kind },
    );
  } finally {
    if (outcome) {
      safeDelete(outcome.shape);
      disposeNameTable(outcome.names);
    }
  }
}

function weldmentExpectedPrismVolume(outcome, expected, label) {
  const actual = shapeVolume(outcome.shape);
  const tolerance = Math.max(1e-6, Math.abs(expected) * 1e-7);
  if (Math.abs(actual - expected) > tolerance) {
    throw codedFeatureError(
      'WELDMENT_TREATMENT_VOLUME_INVALID',
      label + ' exact volume does not match its persistent construction dimensions. No geometry was published.',
      { expectedVolume: expected, actualVolume: actual },
    );
  }
}

function checkedStudioWeldBead(part, feature, N) {
  try {
    return assertStudioWeldBeadPart(
      part,
      feature,
      'kernel.weldBead[' + feature.id + ']',
      (value, label) => evaluatedFeatureValue(value, N, 'WELD_BEAD_EVIDENCE_INVALID', label),
    );
  } catch (error) {
    if (error?.code === 'WELD_BEAD_EVIDENCE_INVALID') throw error;
    throw codedFeatureError(
      'WELD_BEAD_EVIDENCE_INVALID',
      String(error?.message || error) + ' No weld-bead geometry was published.',
      { featureId: feature.id },
    );
  }
}

function weldBeadOrderedEndpoints(edge, label) {
  let first = null;
  let second = null;
  try {
    first = edge.pointAt(0);
    second = edge.pointAt(1);
    const left = pointTuple(first, label + ' first endpoint');
    const right = pointTuple(second, label + ' second endpoint');
    const compare = left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    return compare <= 0 ? [left, right] : [right, left];
  } finally {
    safeDelete(first);
    safeDelete(second);
  }
}

function weldBeadSupportContext(result, support, label) {
  if (!topo || !result?.shape || result.error || result.geometry?.valid !== true
    || result.geometry?.brepValid !== true || result.geometry?.solidCount !== 1) {
    throw new Error(label + ' has no current valid one-solid OCCT result.');
  }
  const lookups = topo.nameLookups(result.shape, result.names || []);
  let faceEdges = [];
  try {
    const face = resolveModifierTopologyReference(support.face, 'face', lookups);
    const edge = resolveModifierTopologyReference(support.edge, 'edge', lookups);
    if (face.geomType !== 'PLANE') throw new Error(label + ' face must remain an exact plane.');
    if (edge.geomType !== 'LINE') throw new Error(label + ' edge must remain one exact straight line.');
    faceEdges = face.edges;
    if (!faceEdges.some((candidate) => exactWrappedMatch(candidate, edge))) {
      throw new Error(label + ' edge is no longer incident to its selected planar face.');
    }
    let normalValue = null;
    try {
      normalValue = face.normalAt();
      const normal = weldmentUnit(pointTuple(normalValue, label + ' outward normal'), label + ' outward normal');
      const endpoints = weldBeadOrderedEndpoints(edge, label + ' edge');
      const length = Number(edge.length);
      if (!(length > 1e-7) || !Number.isFinite(length)) throw new Error(label + ' edge has no positive exact length.');
      return { result, support, lookups, face, edge, normal, endpoints, length };
    } finally {
      safeDelete(normalValue);
    }
  } catch (error) {
    lookups.dispose();
    throw error;
  } finally {
    for (const candidate of faceEdges) safeDelete(candidate);
  }
}

function disposeWeldBeadSupport(context) {
  context?.lookups?.dispose();
}

function weldBeadPointOnFace(context, point, tolerance, label) {
  let vertex = null;
  let query = null;
  try {
    vertex = rc.makeVertex(point);
    query = new rc.DistanceQuery(vertex);
    const distance = query.distanceTo(context.face);
    if (!Number.isFinite(distance) || distance > tolerance) {
      throw new Error(label + ' leaves the bounded exact support face.');
    }
  } finally {
    safeDelete(query);
    safeDelete(vertex);
  }
}

function weldBeadExactDistance(left, right, label) {
  let query = null;
  try {
    query = new rc.DistanceQuery(left);
    const distance = query.distanceTo(right);
    if (!Number.isFinite(distance)) throw new Error(label + ' exact distance is non-finite.');
    return distance;
  } catch (error) {
    throw new Error(label + ' exact distance query failed: ' + String(error?.message || error));
  } finally {
    safeDelete(query);
  }
}

function weldBeadExactCommonVolume(left, right, label) {
  const oc = rc.getOC();
  let leftInput = null;
  let rightInput = null;
  let progress = null;
  let common = null;
  let result = null;
  try {
    // OCCT Boolean builders may attach operation state to their operands. Use
    // private B-reps for evidence-only intersection queries so proving a weld
    // never mutates either cached structural-member result.
    leftInput = privateShapeWithNames(left, []);
    rightInput = privateShapeWithNames(right, []);
    progress = new oc.Message_ProgressRange_1();
    common = new oc.BRepAlgoAPI_Common_3(leftInput.shape.wrapped, rightInput.shape.wrapped, progress);
    common.SetUseOBB?.(true);
    common.Build(progress);
    if (typeof common.IsDone === 'function' && !common.IsDone()) throw new Error('OCCT Common did not finish.');
    result = rc.cast(common.Shape());
    const volume = shapeVolume(result);
    if (!Number.isFinite(volume) || volume < -1e-12) throw new Error('OCCT Common returned an invalid volume.');
    return Math.max(0, volume);
  } catch (error) {
    throw new Error(label + ' exact volumetric-intersection query failed: ' + String(error?.message || error));
  } finally {
    safeDelete(result);
    safeDelete(common);
    safeDelete(progress);
    safeDelete(leftInput?.shape);
    disposeNameTable(leftInput?.names);
    safeDelete(rightInput?.shape);
    disposeNameTable(rightInput?.names);
  }
}

function buildStudioWeldBeadBody(part, feature, N, evaluateBody) {
  if (typeof evaluateBody !== 'function') throw new Error('Weld bead source-body evaluator is unavailable.');
  const checked = checkedStudioWeldBead(part, feature, N);
  const [supportA, supportB] = checked.recipe.supports;
  if (supportA.bodyId === supportB.bodyId) throw new Error('Weld bead requires two distinct exact source bodies.');
  const sourceA = evaluateBody(supportA.bodyId);
  const sourceB = evaluateBody(supportB.bodyId);
  let contextA = null;
  let contextB = null;
  let outcome = null;
  try {
    contextA = weldBeadSupportContext(sourceA, supportA, 'Weld bead support A');
    contextB = weldBeadSupportContext(sourceB, supportB, 'Weld bead support B');
    const scale = Math.max(1, contextA.length, contextB.length, checked.recipe.sizeMm);
    const tolerance = Math.max(1e-7, scale * 1e-9);
    if (Math.abs(contextA.length - contextB.length) > tolerance) {
      throw new Error('Weld bead support edges no longer have the same exact length.');
    }
    const direct = Math.hypot(...contextA.endpoints[0].map((value, axis) => value - contextB.endpoints[0][axis]))
      + Math.hypot(...contextA.endpoints[1].map((value, axis) => value - contextB.endpoints[1][axis]));
    const reversed = Math.hypot(...contextA.endpoints[0].map((value, axis) => value - contextB.endpoints[1][axis]))
      + Math.hypot(...contextA.endpoints[1].map((value, axis) => value - contextB.endpoints[0][axis]));
    if (Math.min(direct, reversed) > tolerance * 2) {
      throw new Error('Weld bead support edges no longer share one exact endpoint pair.');
    }
    const { add, cross, dot, multiply, subtract } = studioV5VectorMath;
    if (Math.abs(dot(contextA.normal, contextB.normal)) > 1e-7) {
      throw new Error('This weld-bead increment requires perpendicular exact support faces.');
    }
    let start = contextA.endpoints[0];
    let end = contextA.endpoints[1];
    let tangent = weldmentUnit(subtract(end, start), 'Weld bead seam tangent');
    if (Math.abs(dot(tangent, contextA.normal)) > 1e-7 || Math.abs(dot(tangent, contextB.normal)) > 1e-7) {
      throw new Error('Weld bead seam must lie in both exact support planes.');
    }
    const legA = contextB.normal;
    const legB = contextA.normal;
    if (dot(cross(tangent, legA), legB) < 0) {
      [start, end] = [end, start];
      tangent = multiply(tangent, -1);
    }
    if (dot(cross(tangent, legA), legB) < 1 - 1e-7) {
      throw new Error('Weld bead supports do not define one canonical exterior fillet quadrant.');
    }
    const size = checked.recipe.sizeMm;
    const toeAStart = add(start, multiply(legA, size));
    const toeAEnd = add(end, multiply(legA, size));
    const toeBStart = add(start, multiply(legB, size));
    const toeBEnd = add(end, multiply(legB, size));
    weldBeadPointOnFace(contextA, toeAStart, tolerance, 'Weld bead A-start toe');
    weldBeadPointOnFace(contextA, toeAEnd, tolerance, 'Weld bead A-end toe');
    weldBeadPointOnFace(contextB, toeBStart, tolerance, 'Weld bead B-start toe');
    weldBeadPointOnFace(contextB, toeBEnd, tolerance, 'Weld bead B-end toe');
    const sourceCommon = weldBeadExactCommonVolume(sourceA.shape, sourceB.shape, 'Weld bead source bodies');
    if (sourceCommon > Math.max(1e-7, Math.min(sourceA.geometry.volume, sourceB.geometry.volume) * 1e-9)) {
      throw new Error('Weld bead source bodies overlap in exact material instead of meeting at the selected seam.');
    }
    if (weldBeadExactDistance(sourceA.shape, sourceB.shape, 'Weld bead source bodies') > tolerance) {
      throw new Error('Weld bead source bodies are not in exact contact.');
    }
    outcome = weldmentPrismOutcome({
      featureId: feature.id,
      profileId: 'fillet-bead',
      points: [[0, 0], [size, 0], [0, size]],
      entityIds: ['support-a-leg', 'toe', 'support-b-leg'],
      origin: start,
      xDirection: legA,
      normal: tangent,
      extent: contextA.length,
    });
    const geometry = bodyGeometry(outcome.shape);
    const expectedVolume = 0.5 * size * size * contextA.length;
    if (geometry.faceCount !== 5 || geometry.edgeCount !== 9 || geometry.vertexCount !== 6) {
      throw new Error('Weld bead did not produce the canonical five-face, nine-edge, six-vertex fillet prism.');
    }
    if (Math.abs(geometry.volume - expectedVolume) > Math.max(1e-6, expectedVolume * 1e-8)) {
      throw codedFeatureError(
        'WELD_BEAD_VOLUME_INVALID',
        'Weld bead exact volume does not equal one-half size squared times current seam length. No geometry was published.',
        { featureId: feature.id, expectedVolume, actualVolume: geometry.volume, seamLength: contextA.length },
      );
    }
    for (const [source, label] of [[sourceA, 'A'], [sourceB, 'B']]) {
      if (weldBeadExactDistance(outcome.shape, source.shape, 'Weld bead support ' + label) > tolerance) {
        throw new Error('Weld bead is detached from exact support ' + label + '.');
      }
      const commonVolume = weldBeadExactCommonVolume(outcome.shape, source.shape, 'Weld bead support ' + label);
      if (commonVolume > Math.max(1e-7, expectedVolume * 1e-9)) {
        throw new Error('Weld bead is embedded in exact support ' + label + ' instead of contacting its boundary.');
      }
    }
    const accepted = outcome;
    outcome = null;
    return accepted;
  } catch (error) {
    if (typeof error?.code === 'string') throw error;
    throw codedFeatureError(
      'WELD_BEAD_KERNEL_REFUSED',
      String(error?.message || error) + ' No weld-bead geometry was published.',
      { featureId: feature.id },
    );
  } finally {
    if (outcome) {
      safeDelete(outcome.shape);
      disposeNameTable(outcome.names);
    }
    disposeWeldBeadSupport(contextA);
    disposeWeldBeadSupport(contextB);
  }
}

function buildStudioWeldmentTreatmentNewBody(document, part, feature, N) {
  const checked = checkedStudioWeldmentTreatment(part, feature, N);
  const { add, cross, dot, multiply } = studioV5VectorMath;
  if (checked.recipe.kind === 'gusset') {
    const normal = weldmentUnit(cross(checked.joint.leftAway, checked.joint.rightAway), 'Gusset joint normal');
    const frame = weldmentPlaneAxes(normal, checked.joint.leftAway);
    const rightPoint = multiply(checked.joint.rightAway, checked.recipe.rightLegLength);
    const points = [
      [0, 0],
      [checked.recipe.leftLegLength, 0],
      [dot(rightPoint, frame.xDirection), dot(rightPoint, frame.yDirection)],
    ];
    const origin = add(checked.joint.point, multiply(frame.normal, -checked.recipe.thickness / 2));
    const outcome = weldmentPrismOutcome({
      featureId: feature.id,
      profileId: 'gusset',
      points,
      entityIds: ['gusset-left-leg', 'gusset-free-edge', 'gusset-right-leg'],
      origin,
      xDirection: frame.xDirection,
      normal: frame.normal,
      extent: checked.recipe.thickness,
    });
    const area = Math.abs(points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0)) / 2;
    try {
      weldmentExpectedPrismVolume(outcome, area * checked.recipe.thickness, 'Gusset');
      return outcome;
    } catch (error) {
      safeDelete(outcome.shape);
      disposeNameTable(outcome.names);
      throw error;
    }
  }
  if (checked.recipe.kind === 'end-cap') {
    const frame = weldmentMemberFrame(document, part, checked.member);
    const signedThickness = checked.recipe.end === 'start' ? -checked.recipe.thickness : checked.recipe.thickness;
    const outcome = weldmentMemberPrism(
      document,
      part,
      feature.id,
      checked.member,
      checked.endpoint,
      signedThickness,
      'end-cap-profile',
    );
    try {
      weldmentExpectedPrismVolume(
        outcome,
        checked.member.profile.area * checked.recipe.thickness,
        'End cap',
      );
      if (Math.abs(dot(frame.normal, checked.member.currentTangent) - 1) > 1e-8) {
        throw new Error('End-cap profile frame is detached from the structural member.');
      }
      return outcome;
    } catch (error) {
      safeDelete(outcome.shape);
      disposeNameTable(outcome.names);
      throw error;
    }
  }
  throw new Error('Only gusset and end-cap treatments may create new bodies.');
}

function buildStudioWeldmentTreatmentModifier(document, part, feature, shape, names, N, evaluateBody) {
  const checked = checkedStudioWeldmentTreatment(part, feature, N);
  const { add, multiply, subtract } = studioV5VectorMath;
  let tool = null;
  try {
    if (checked.recipe.kind === 'trim-extend') {
      if (checked.recipe.mode === 'trim') {
        const boundary = add(checked.endpoint, multiply(checked.away, checked.recipe.distance));
        const frame = weldmentMemberFrame(document, part, checked.member);
        tool = weldmentHalfspaceTool(shape, feature.id, boundary, multiply(checked.away, -1), frame.xDirection);
        return weldmentBooleanOutcome('cut', feature, shape, names, tool, 'Structural trim');
      }
      const profileScale = Math.max(1, ...checked.member.profile.points.flat().map(Math.abs));
      const overlap = Math.min(checked.recipe.distance * 1e-4, Math.max(1e-7, profileScale * 1e-7));
      const origin = add(checked.endpoint, multiply(checked.away, overlap));
      const signedExtent = (checked.recipe.end === 'start' ? -1 : 1) * (checked.recipe.distance + overlap);
      tool = weldmentMemberPrism(document, part, feature.id, checked.member, origin, signedExtent, 'extension-profile');
      const outcome = weldmentBooleanOutcome('fuse', feature, shape, names, tool, 'Structural extension');
      const expected = checked.member.profile.area * checked.recipe.distance;
      if (Math.abs(outcome.volumeDelta - expected) > Math.max(1e-6, expected * 1e-7)) {
        safeDelete(outcome.shape);
        disposeNameTable(outcome.names);
        throw codedFeatureError(
          'WELDMENT_TREATMENT_VOLUME_INVALID',
          'Structural extension exact volume does not equal profile area times extension distance. No geometry was published.',
          { featureId: feature.id, expectedVolumeDelta: expected, actualVolumeDelta: outcome.volumeDelta },
        );
      }
      return outcome;
    }
    if (checked.recipe.kind === 'corner' && checked.recipe.style === 'miter') {
      const normal = weldmentUnit(
        subtract(checked.joint.leftAway, checked.joint.rightAway),
        'Miter plane normal',
      );
      if (Math.abs(studioV5VectorMath.dot(normal, checked.joint.leftAway)) <= 1e-7) {
        throw new Error('Miter members do not define a bounded retained side.');
      }
      const frame = weldmentMemberFrame(document, part, checked.target);
      tool = weldmentHalfspaceTool(shape, feature.id, checked.joint.point, multiply(normal, -1), frame.xDirection);
      return weldmentBooleanOutcome('cut', feature, shape, names, tool, 'Structural miter');
    }
    if (checked.recipe.kind === 'corner' && checked.recipe.style === 'cope') {
      if (typeof evaluateBody !== 'function') throw new Error('Cope treatment body evaluator is unavailable.');
      const other = evaluateBody(checked.recipe.otherBodyId);
      if (!other?.shape || other.error) throw new Error('Cope other-member body has no current valid exact solid.');
      if (!boundsOverlap(shape, other.shape)) throw new Error('Cope members do not overlap in exact space.');
      let privateTool = null;
      let prefixedNames = null;
      try {
        privateTool = privateShapeWithNames(other.shape, other.names || []);
        prefixedNames = topo.prefixTable(privateTool.names, 'weldment:' + feature.id + '/other-member/');
        tool = { shape: privateTool.shape, names: prefixedNames };
        privateTool.shape = null;
        prefixedNames = null;
        return weldmentBooleanOutcome('cut', feature, shape, names, tool, 'Structural cope');
      } finally {
        if (privateTool) {
          safeDelete(privateTool.shape);
          disposeNameTable(privateTool.names);
        }
        disposeNameTable(prefixedNames);
      }
    }
    throw new Error('Only trim/extend and corner treatments may modify a structural-member body.');
  } finally {
    safeDelete(tool?.shape);
    disposeNameTable(tool?.names);
  }
}

function checkedStudioSheetMetal(part, feature, N) {
  try {
    return assertStudioSheetMetalPart(
      part,
      feature,
      'kernel.sheetMetal[' + feature.id + ']',
      (value, label) => evaluatedFeatureValue(value, N, 'SHEET_METAL_EVIDENCE_INVALID', label),
    );
  } catch (error) {
    if (error?.code === 'SHEET_METAL_EVIDENCE_INVALID') throw error;
    throw codedFeatureError(
      'SHEET_METAL_EVIDENCE_INVALID',
      String(error?.message || error) + ' No geometry was published.',
      { featureId: feature.id },
    );
  }
}

function sheetMetalExpectedVolume(shape, expected, label, featureId) {
  const actual = shapeVolume(shape);
  const tolerance = Math.max(1e-6, Math.abs(expected) * 1e-7);
  if (Math.abs(actual - expected) > tolerance) {
    throw codedFeatureError(
      'SHEET_METAL_VOLUME_INVALID',
      label + ' exact volume does not match its persistent construction dimensions. No geometry was published.',
      { featureId, expectedVolume: expected, actualVolume: actual },
    );
  }
}

// Extrude a closed line/arc profile with complete creation naming. Unlike the
// weldment prism helper, the profile may contain exact circular arcs; the
// final entity must be a line returning to the profile start so the drawing
// close() completes that authored segment.
function sheetMetalProfilePrism({ featureId, entities, origin, xDirection, normal, extent }) {
  if (!topo) throw new Error('persistent topology naming is unavailable for Sheet metal');
  if (!(Math.abs(extent) > 1e-7) || !Number.isFinite(extent)) throw new Error('Sheet-metal prism extent is invalid.');
  const frame = weldmentPlaneAxes(normal, xDirection);
  const { add, multiply } = studioV5VectorMath;
  const toWorld = ([x, y]) => add(origin, add(multiply(frame.xDirection, x), multiply(frame.yDirection, y)));
  const last = entities[entities.length - 1];
  if (last.kind !== 'line' || Math.hypot(last.b2[0] - entities[0].a2[0], last.b2[1] - entities[0].a2[1]) > 1e-12) {
    throw new Error('Sheet-metal profile must close with a straight segment back to its start.');
  }
  let plane = null;
  let shape = null;
  let names = null;
  try {
    plane = new rc.Plane(origin, frame.xDirection, frame.normal);
    let drawing = rc.draw(entities[0].a2);
    for (const entity of entities.slice(0, -1)) {
      drawing = entity.kind === 'arc'
        ? drawing.threePointsArcTo(entity.b2, entity.mid2)
        : drawing.lineTo(entity.b2);
    }
    shape = drawing.close().sketchOnPlane(plane).extrude(extent);
    names = topo.creationNamesForSweep(shape, {
      featureId,
      entities: entities.map((entity) => entity.kind === 'arc'
        ? { kind: 'arc', id: entity.id, center2: entity.center2, radius: entity.radius }
        : { kind: 'line', id: entity.id, a2: entity.a2, b2: entity.b2 }),
      toWorld,
      sweepDirection: frame.normal,
      capOffsets: [0, extent],
    });
    const geometry = bodyGeometry(shape);
    if (!geometry.valid) throw new Error('Sheet-metal prism is not exactly one valid solid.');
    assertCompleteFeatureTopology(shape, names, 'Sheet metal ' + featureId);
    const outcome = { shape, names, diagnostics: names.diagnostics || [] };
    shape = null;
    names = null;
    return outcome;
  } finally {
    safeDelete(shape);
    disposeNameTable(names);
    safeDelete(plane);
  }
}

function sheetMetalBooleanOutcome(kind, feature, shape, names, tool, label) {
  if (!topo) throw new Error('persistent topology naming is unavailable for Sheet metal');
  const before = shapeVolume(shape);
  let outcome = null;
  try {
    outcome = topo.booleanWithNames(kind, shape, tool.shape, names, tool.names);
    const geometry = bodyGeometry(outcome.shape);
    if (!geometry.valid) throw new Error(label + ' did not produce exactly one valid solid.');
    const delta = kind === 'fuse' ? geometry.volume - before : before - geometry.volume;
    if (!(delta > Math.max(1e-7, before * 1e-9))) throw new Error(label + ' did not change the intended exact material volume.');
    assertCompleteFeatureTopology(outcome.shape, outcome.names, label);
    const result = outcome;
    outcome = null;
    return { ...result, volumeDelta: delta };
  } catch (error) {
    if (typeof error?.code === 'string') throw error;
    throw codedFeatureError(
      'SHEET_METAL_KERNEL_REFUSED',
      String(error?.message || error) + ' No geometry was published.',
      { featureId: feature.id, sheetMetalKind: feature.extensions?.sheetMetal?.kind },
    );
  } finally {
    if (outcome) {
      safeDelete(outcome.shape);
      disposeNameTable(outcome.names);
    }
  }
}

function buildStudioSheetMetalNewBody(document, part, feature, N) {
  const checked = checkedStudioSheetMetal(part, feature, N);
  if (checked.recipe.kind !== 'base-flange' && checked.recipe.kind !== 'flat-pattern') {
    throw codedFeatureError(
      'SHEET_METAL_EVIDENCE_INVALID',
      'Edge flanges and corner reliefs modify their base-flange body and cannot create a new body. No geometry was published.',
      { featureId: feature.id },
    );
  }
  if (checked.recipe.kind === 'flat-pattern') {
    // The derived flat pattern extrudes the exact developed outline computed
    // at the document boundary: base profile plus relief-shortened developed
    // flange extensions minus relief cutouts, in the base profile plane.
    const thickness = checked.base.recipe.thickness;
    const frame = resolveStudioV5Datums(document, part.id).resolve(checked.base.supportDatumId);
    if (frame?.kind !== 'plane') throw new Error('Flat-pattern profile support is not a datum plane.');
    const outcome = sheetMetalProfilePrism({
      featureId: feature.id,
      entities: checked.plan.entities,
      origin: frame.origin,
      xDirection: frame.xDirection,
      normal: frame.normal,
      extent: thickness,
    });
    try {
      sheetMetalExpectedVolume(
        outcome.shape,
        checked.plan.flatArea * thickness,
        'Flat pattern',
        feature.id,
      );
      return outcome;
    } catch (error) {
      safeDelete(outcome.shape);
      disposeNameTable(outcome.names);
      throw error;
    }
  }
  const frame = resolveStudioV5Datums(document, part.id).resolve(checked.supportDatumId);
  if (frame?.kind !== 'plane') throw new Error('Base-flange profile support is not a datum plane.');
  const points = checked.profilePoints;
  const outcome = sheetMetalProfilePrism({
    featureId: feature.id,
    entities: points.map((point, index) => ({
      kind: 'line',
      id: studioSheetMetalSegmentEntityId(index),
      a2: point,
      b2: points[(index + 1) % points.length],
    })),
    origin: frame.origin,
    xDirection: frame.xDirection,
    normal: frame.normal,
    extent: checked.recipe.thickness,
  });
  try {
    sheetMetalExpectedVolume(
      outcome.shape,
      checked.profileArea * checked.recipe.thickness,
      'Base flange',
      feature.id,
    );
    return outcome;
  } catch (error) {
    safeDelete(outcome.shape);
    disposeNameTable(outcome.names);
    throw error;
  }
}

// Corner relief cuts the exact square or quarter-disc base cutout at one
// perpendicular shared corner, through the full sheet thickness, before any
// edge flange of the base replays. The cut prism is positioned from the
// evaluated base profile corner in the base datum plane and its removed
// volume must equal the closed-form relief area times thickness exactly.
function buildStudioSheetMetalCornerRelief(document, part, feature, shape, names, checked) {
  const thickness = checked.base.recipe.thickness;
  const frame = resolveStudioV5Datums(document, part.id).resolve(checked.base.supportDatumId);
  if (frame?.kind !== 'plane') throw new Error('Corner-relief profile support is not a datum plane.');
  const corner = checked.corner;
  const size = corner.reliefSize;
  const point = corner.point;
  const inbound = corner.inboundDirection;
  const outbound = corner.outboundDirection;
  const mouthStart = [point[0] - size * inbound[0], point[1] - size * inbound[1]];
  const mouthEnd = [point[0] + size * outbound[0], point[1] + size * outbound[1]];
  const entities = [];
  if (checked.recipe.style === 'rectangular') {
    const inner = [
      point[0] + size * (outbound[0] - inbound[0]),
      point[1] + size * (outbound[1] - inbound[1]),
    ];
    entities.push(
      { kind: 'line', id: 'relief-inner-a', a2: mouthStart, b2: inner },
      { kind: 'line', id: 'relief-inner-b', a2: inner, b2: mouthEnd },
    );
  } else {
    const diagonal = Math.SQRT1_2;
    entities.push({
      kind: 'arc',
      id: 'relief-arc',
      a2: mouthStart,
      b2: mouthEnd,
      mid2: [
        point[0] + size * diagonal * (outbound[0] - inbound[0]),
        point[1] + size * diagonal * (outbound[1] - inbound[1]),
      ],
      center2: [point[0], point[1]],
      radius: size,
    });
  }
  entities.push(
    { kind: 'line', id: 'relief-mouth-b', a2: mouthEnd, b2: [point[0], point[1]] },
    { kind: 'line', id: 'relief-mouth-a', a2: [point[0], point[1]], b2: mouthStart },
  );
  let tool = null;
  try {
    tool = sheetMetalProfilePrism({
      featureId: feature.id,
      entities,
      origin: frame.origin,
      xDirection: frame.xDirection,
      normal: frame.normal,
      extent: thickness,
    });
    const expected = studioSheetMetalReliefArea(checked.recipe.style, size) * thickness;
    sheetMetalExpectedVolume(tool.shape, expected, 'Corner relief cutout', feature.id);
    const outcome = sheetMetalBooleanOutcome('cut', feature, shape, names, tool, 'Corner relief');
    if (Math.abs(outcome.volumeDelta - expected) > Math.max(1e-6, expected * 1e-7)) {
      safeDelete(outcome.shape);
      disposeNameTable(outcome.names);
      throw codedFeatureError(
        'SHEET_METAL_VOLUME_INVALID',
        'Corner relief removed volume does not equal the exact relief cutout. No geometry was published.',
        { featureId: feature.id, expectedVolumeDelta: expected, actualVolumeDelta: outcome.volumeDelta },
      );
    }
    return outcome;
  } catch (error) {
    if (typeof error?.code === 'string') throw error;
    throw codedFeatureError(
      'SHEET_METAL_KERNEL_REFUSED',
      String(error?.message || error) + ' No geometry was published.',
      { featureId: feature.id },
    );
  } finally {
    safeDelete(tool?.shape);
    disposeNameTable(tool?.names);
  }
}

function buildStudioSheetMetalModifier(document, part, feature, shape, names, N) {
  const checked = checkedStudioSheetMetal(part, feature, N);
  if (checked.recipe.kind === 'corner-relief') {
    return buildStudioSheetMetalCornerRelief(document, part, feature, shape, names, checked);
  }
  if (checked.recipe.kind !== 'edge-flange') {
    throw codedFeatureError(
      'SHEET_METAL_EVIDENCE_INVALID',
      'Base flanges and flat patterns create a new exact body and cannot modify an existing one. No geometry was published.',
      { featureId: feature.id },
    );
  }
  if (!topo) throw new Error('persistent topology naming is unavailable for Sheet metal');
  const recipe = checked.recipe;
  const thickness = checked.base.recipe.thickness;
  const bendRadius = recipe.bendRadius;
  const wall = recipe.flangeLength;
  const { cross, dot, multiply, subtract } = studioV5VectorMath;
  const lookups = topo.nameLookups(shape, names);
  let sheetFaceEdges = [];
  let attachmentFaceEdges = [];
  let tool = null;
  try {
    const edge = resolveModifierTopologyReference({ name: recipe.edgeName }, 'edge', lookups);
    const sheetFace = resolveModifierTopologyReference({ name: recipe.sheetFaceName }, 'face', lookups);
    const attachmentFace = resolveModifierTopologyReference({ name: recipe.attachmentFaceName }, 'face', lookups);
    if (edge.geomType !== 'LINE') throw new Error('Edge flange requires one exact straight bend edge.');
    if (sheetFace.geomType !== 'PLANE' || attachmentFace.geomType !== 'PLANE') {
      throw new Error('Edge flange requires exact planar sheet and attachment faces.');
    }
    sheetFaceEdges = sheetFace.edges;
    attachmentFaceEdges = attachmentFace.edges;
    if (!sheetFaceEdges.some((candidate) => exactWrappedMatch(candidate, edge))
      || !attachmentFaceEdges.some((candidate) => exactWrappedMatch(candidate, edge))) {
      throw new Error('Edge flange bend edge is no longer shared by its sheet and attachment faces.');
    }
    let sheetNormalValue = null;
    let attachmentNormalValue = null;
    let sheetNormal;
    let attachmentNormal;
    try {
      sheetNormalValue = sheetFace.normalAt();
      attachmentNormalValue = attachmentFace.normalAt();
      sheetNormal = weldmentUnit(pointTuple(sheetNormalValue, 'Edge flange sheet normal'), 'Edge flange sheet normal');
      attachmentNormal = weldmentUnit(pointTuple(attachmentNormalValue, 'Edge flange attachment normal'), 'Edge flange attachment normal');
    } finally {
      safeDelete(sheetNormalValue);
      safeDelete(attachmentNormalValue);
    }
    if (Math.abs(dot(sheetNormal, attachmentNormal)) > 1e-7) {
      throw new Error('Edge flange sheet and attachment faces must remain exactly perpendicular.');
    }
    let firstPoint = null;
    let secondPoint = null;
    let start;
    let end;
    try {
      firstPoint = edge.pointAt(0);
      secondPoint = edge.pointAt(1);
      start = pointTuple(firstPoint, 'Edge flange bend-edge start');
      end = pointTuple(secondPoint, 'Edge flange bend-edge end');
    } finally {
      safeDelete(firstPoint);
      safeDelete(secondPoint);
    }
    const length = Number(edge.length);
    if (!(length > 1e-7) || !Number.isFinite(length)) throw new Error('Edge flange bend edge has no positive exact length.');
    let tangent = weldmentUnit(subtract(end, start), 'Edge flange bend tangent');
    if (Math.abs(dot(tangent, sheetNormal)) > 1e-7 || Math.abs(dot(tangent, attachmentNormal)) > 1e-7) {
      throw new Error('Edge flange bend edge must lie in both exact support planes.');
    }
    let origin = start;
    if (dot(cross(tangent, attachmentNormal), sheetNormal) < 0) {
      tangent = multiply(tangent, -1);
      origin = end;
    }
    if (dot(cross(tangent, attachmentNormal), sheetNormal) < 1 - 1e-7) {
      throw new Error('Edge flange supports do not define one exact orthonormal bend frame.');
    }
    // The attachment face must remain exactly the full-edge-by-thickness
    // rectangle so the folded increment attaches across the entire sheet
    // boundary. A partial-width flange is a named exclusion of this slice.
    const cornerTolerance = Math.max(1e-6, Math.max(length, thickness) * 1e-9);
    const cornerKeys = new Set();
    for (const boundary of attachmentFaceEdges) {
      for (const parameter of [0, 1]) {
        let cornerPoint = null;
        try {
          cornerPoint = boundary.pointAt(parameter);
          const corner = pointTuple(cornerPoint, 'Edge flange attachment corner');
          const relative = subtract(corner, origin);
          const along = dot(relative, tangent);
          const rise = dot(relative, sheetNormal);
          const out = dot(relative, attachmentNormal);
          if (Math.abs(out) > cornerTolerance) throw new Error('Edge flange attachment face left its exact support plane.');
          const alongStation = Math.abs(along) <= cornerTolerance ? 0 : Math.abs(along - length) <= cornerTolerance ? 1 : null;
          const riseStation = Math.abs(rise) <= cornerTolerance ? 0 : Math.abs(rise + thickness) <= cornerTolerance ? 1 : null;
          if (alongStation === null || riseStation === null) {
            throw new Error('Edge flange attachment face is not the exact full-edge-by-thickness sheet boundary.');
          }
          cornerKeys.add(alongStation + ':' + riseStation);
        } finally {
          safeDelete(cornerPoint);
        }
      }
    }
    if (cornerKeys.size !== 4) {
      throw new Error('Edge flange attachment face is not the exact full-edge-by-thickness sheet boundary.');
    }
    const diagonal = Math.SQRT1_2;
    const outerRadius = bendRadius + thickness;
    const entities = [
      {
        kind: 'arc',
        id: 'bend-inner',
        a2: [0, 0],
        b2: [bendRadius, bendRadius],
        mid2: [bendRadius * diagonal, bendRadius * (1 - diagonal)],
        center2: [0, bendRadius],
        radius: bendRadius,
      },
      { kind: 'line', id: 'wall-inner', a2: [bendRadius, bendRadius], b2: [bendRadius, bendRadius + wall] },
      { kind: 'line', id: 'flange-tip', a2: [bendRadius, bendRadius + wall], b2: [outerRadius, bendRadius + wall] },
      { kind: 'line', id: 'wall-outer', a2: [outerRadius, bendRadius + wall], b2: [outerRadius, bendRadius] },
      {
        kind: 'arc',
        id: 'bend-outer',
        a2: [outerRadius, bendRadius],
        b2: [0, -thickness],
        mid2: [outerRadius * diagonal, bendRadius - outerRadius * diagonal],
        center2: [0, bendRadius],
        radius: outerRadius,
      },
      { kind: 'line', id: 'attachment', a2: [0, -thickness], b2: [0, 0] },
    ];
    tool = sheetMetalProfilePrism({
      featureId: feature.id,
      entities,
      origin,
      xDirection: attachmentNormal,
      normal: tangent,
      extent: length,
    });
    const expected = studioSheetMetalEdgeSectionArea(bendRadius, thickness, wall) * length;
    sheetMetalExpectedVolume(tool.shape, expected, 'Edge flange increment', feature.id);
    const outcome = sheetMetalBooleanOutcome('fuse', feature, shape, names, tool, 'Edge flange');
    if (Math.abs(outcome.volumeDelta - expected) > Math.max(1e-6, expected * 1e-7)) {
      safeDelete(outcome.shape);
      disposeNameTable(outcome.names);
      throw codedFeatureError(
        'SHEET_METAL_VOLUME_INVALID',
        'Edge flange fused volume does not equal the exact quarter-annulus-plus-wall increment. No geometry was published.',
        { featureId: feature.id, expectedVolumeDelta: expected, actualVolumeDelta: outcome.volumeDelta },
      );
    }
    return outcome;
  } catch (error) {
    if (typeof error?.code === 'string') throw error;
    throw codedFeatureError(
      'SHEET_METAL_KERNEL_REFUSED',
      String(error?.message || error) + ' No geometry was published.',
      { featureId: feature.id },
    );
  } finally {
    for (const candidate of sheetFaceEdges) safeDelete(candidate);
    for (const candidate of attachmentFaceEdges) safeDelete(candidate);
    lookups.dispose();
    safeDelete(tool?.shape);
    disposeNameTable(tool?.names);
  }
}

function buildStudioV5Revolve(document, part, feature, N) {
  if (!profileFeatureHistory || !topo) throw new Error('persistent profile topology history is unavailable for Revolve');
  const sketch = part.sketches.find((entry) => entry.id === feature.profileSketchId);
  if (!sketch) throw new Error('Revolve profile sketch is missing');
  const frame = resolveStudioV5Datums(document, part.id).resolve(feature.axisDatumId);
  if (frame.kind !== 'axis') throw new Error('Revolve requires an axis datum');
  const angle = N(feature.angle);
  const startAngle = N(feature.startAngle ?? (feature.symmetric ? -angle / 2 : 0));
  if (!(angle > 0 && angle <= 360)) throw new Error('Revolve angle must stay above zero and at most 360 degrees');
  const profile = profileSketch3dData(document, part, sketch, {}, N);
  let profileFace = null;
  let outcome = null;
  try {
    profileFace = rc.makeFace(profile.profile.wire);
    outcome = profileFeatureHistory.revolveWithHistory({
      featureId: feature.id,
      profileId: sketch.id,
      profileFace,
      profileEdges: profile.sources,
      axisOrigin: frame.origin,
      axisDirection: frame.direction,
      angleDegrees: angle,
    });
    if (Math.abs(startAngle) > 1e-9) {
      const transformation = new rc.Transformation();
      try {
        transformation.rotate(startAngle, frame.origin, frame.direction);
        const rotated = topo.transformWithNames(outcome.shape, transformation, outcome.names);
        safeDelete(outcome.shape);
        disposeNameTable(outcome.names);
        outcome.shape = rotated.shape;
        outcome.names = rotated.names;
      } finally {
        transformation.delete();
      }
    }
    const result = outcome;
    outcome = null;
    return attachProfileHistoryDiagnostics(result);
  } finally {
    if (outcome) profileFeatureHistory.disposeOutcome(outcome);
    safeDelete(profileFace);
    disposeProfileSketch3dData(profile);
  }
}

function assertCompleteFeatureTopology(shape, names, label) {
  if (!topo || !patternFeatureHistory) {
    throw codedFeatureError(
      'PROFILE_HISTORY_PERSISTENCE_UNAVAILABLE',
      label + ' cannot publish geometry without the persistent-topology runtime.',
    );
  }
  const faces = topo.exactFaces(shape);
  const edges = topo.exactEdges(shape);
  const vertices = topo.exactVertices(shape);
  let tables = null;
  try {
    const diagnostics = names?.diagnostics || [];
    if (diagnostics.some((entry) => entry.severity === 'error')) {
      throw codedFeatureError(
        'PROFILE_HISTORY_PERSISTENCE_INCOMPLETE',
        label + ' OCCT history is incomplete, so no geometry was published.',
        { diagnostics: structuredClone(diagnostics) },
      );
    }
    const uniqueNames = new Set((names || []).map((entry) => entry.name));
    const everyFaceNamedExactlyOnce = faces.every((face) =>
      (names || []).filter((entry) => {
        try { return entry.face.wrapped.IsSame(face.wrapped); } catch { return false; }
      }).length === 1);
    if (
      names?.length !== faces.length
      || uniqueNames.size !== names?.length
      || !everyFaceNamedExactlyOnce
    ) {
      throw codedFeatureError(
        'PROFILE_HISTORY_PERSISTENCE_INCOMPLETE',
        label + ' did not prove a unique persistent name for every exact face, so no geometry was published.',
        { faces: faces.length, namedFaces: names?.length || 0 },
      );
    }
    tables = completePatternTopologyTables(shape, names);
    if (tables.faces.length !== faces.length || tables.edges.length !== edges.length || tables.vertices.length !== vertices.length) {
      throw codedFeatureError(
        'PROFILE_HISTORY_PERSISTENCE_INCOMPLETE',
        label + ' did not prove complete exact face, edge, and vertex identity, so no geometry was published.',
        {
          faces: faces.length,
          namedFaces: tables.faces.length,
          edges: edges.length,
          namedEdges: tables.edges.length,
          vertices: vertices.length,
          namedVertices: tables.vertices.length,
        },
      );
    }
  } catch (error) {
    if (typeof error?.code === 'string') throw error;
    throw codedFeatureError(
      'PROFILE_HISTORY_PERSISTENCE_INCOMPLETE',
      label + ' did not prove complete exact face, edge, and vertex identity, so no geometry was published: '
        + String(error?.message || error),
    );
  } finally {
    patternFeatureHistory.disposeTables(tables);
    topo.disposeWrappers(faces);
    topo.disposeWrappers(edges);
    topo.disposeWrappers(vertices);
  }
}

function inlineProfileData(feature, shape, N) {
  const semantics = inlineProfileCreationSources([shape], N);
  if (!semantics.complete) {
    const first = semantics.diagnostics[0];
    throw codedFeatureError(
      first?.code || 'INLINE_PROFILE_PERSISTENCE_UNSUPPORTED',
      'Basic Revolve requires explicit stable inline-profile source ids; no geometry was published. '
        + (first?.message || 'The inline profile has no authoritative semantic-source contract.'),
      { diagnostics: structuredClone(semantics.diagnostics) },
    );
  }
  const planeName = feature.plane?.kind === 'base' ? feature.plane.plane : 'XZ';
  const plane = rc.makePlane(planeName);
  const sourceEdges = [];
  let wireAssembly = null;
  let face = null;
  const worldPoint = (point) => {
    const world = plane.toWorldCoords(point);
    try { return world.toTuple(); }
    finally { safeDelete(world); }
  };
  try {
    for (const entity of semantics.entities) {
      const edge = entity.kind === 'circle'
        ? rc.makeCircle(entity.radius, worldPoint(entity.center2), plane.zDir.toTuple())
        : rc.makeLine(worldPoint(entity.a2), worldPoint(entity.b2));
      sourceEdges.push({
        sketchId: 'inline-profile:' + shape.id,
        entityId: entity.id,
        edge,
      });
    }
    wireAssembly = assembleProfileWireWithSources(sourceEdges);
    face = rc.makeFace(wireAssembly.wire);
    const result = {
      profileId: 'inline-profile:' + shape.id,
      face,
      sources: wireAssembly.sources,
    };
    face = null;
    wireAssembly.sources = [];
    return result;
  } finally {
    safeDelete(face);
    safeDelete(wireAssembly?.wire);
    for (const source of wireAssembly?.sources || []) safeDelete(source.edge);
    for (const source of sourceEdges) safeDelete(source.edge);
    safeDelete(plane);
  }
}

function disposeInlineProfileData(profile) {
  safeDelete(profile?.face);
  for (const source of profile?.sources || []) safeDelete(source.edge);
}

function buildInlineRevolve(feature, N) {
  if (!profileFeatureHistory || !topo) {
    throw codedFeatureError(
      'PROFILE_HISTORY_PERSISTENCE_UNAVAILABLE',
      'Basic Revolve cannot publish geometry without OCCT profile history.',
    );
  }
  if (feature.pattern) {
    throw codedFeatureError(
      'INLINE_REVOLVE_PATTERN_HISTORY_UNSUPPORTED',
      'Patterned Basic Revolve is unavailable because this build cannot prove occurrence topology identity.',
    );
  }
  if (feature.onFace || feature.plane?.kind === 'face') {
    throw codedFeatureError(
      'INLINE_REVOLVE_SUPPORT_HISTORY_UNSUPPORTED',
      'Face-supported Basic Revolve is unavailable because this build cannot prove the profile support frame.',
    );
  }
  const shapes = feature.sketch?.shapes || [];
  if (!shapes.length) {
    throw codedFeatureError('INLINE_PROFILE_PERSISTENCE_UNSUPPORTED', 'Basic Revolve requires a closed inline profile.');
  }
  const angle = requireExactRevolveAngle(
    feature,
    N,
    'INLINE_REVOLVE_INVALID_ANGLE',
    'Basic Revolve',
  );
  let combinedShape = null;
  let combinedNames = null;
  try {
    for (const shape of shapes) {
      const profile = inlineProfileData(feature, shape, N);
      let outcome = null;
      try {
        outcome = profileFeatureHistory.revolveWithHistory({
          featureId: feature.id,
          profileId: profile.profileId,
          profileFace: profile.face,
          profileEdges: profile.sources,
          axisOrigin: [0, 0, 0],
          axisDirection: feature.reversed ? [0, 0, -1] : [0, 0, 1],
          angleDegrees: angle,
        });
        attachProfileHistoryDiagnostics(outcome);
        assertCompleteFeatureTopology(outcome.shape, outcome.names, 'Basic Revolve');
        if (!combinedShape) {
          combinedShape = outcome.shape;
          combinedNames = outcome.names;
          outcome.shape = null;
          outcome.names = [];
        } else {
          const fused = topo.booleanWithNames('fuse', combinedShape, outcome.shape, combinedNames, outcome.names);
          safeDelete(combinedShape);
          disposeNameTable(combinedNames);
          combinedShape = fused.shape;
          combinedNames = fused.names;
          assertCompleteFeatureTopology(combinedShape, combinedNames, 'Basic Revolve profile fusion');
        }
      } finally {
        profileFeatureHistory.disposeOutcome(outcome);
        disposeInlineProfileData(profile);
      }
    }
    const result = { shape: combinedShape, names: combinedNames, diagnostics: [] };
    combinedShape = null;
    combinedNames = null;
    return result;
  } finally {
    safeDelete(combinedShape);
    disposeNameTable(combinedNames);
  }
}

function exactProfilePatternTransforms(feature, N, accumulated, accumulatedNames) {
  const pattern = feature.pattern;
  if (!pattern) return [];
  if (pattern.kind !== 'linear' && pattern.kind !== 'circular') {
    throw new Error('Sketch-level pattern kind "' + pattern.kind + '" is unsupported.');
  }
  const countValue = exactSketchPatternCount(pattern, N);

  let plane = null;
  let lookups = null;
  try {
    if (feature.onFace) {
      if (!accumulated) throw new Error('the patterned support face no longer exists');
      if (!topo) throw new Error('persistent topology naming is unavailable for this patterned feature');
      lookups = topo.nameLookups(accumulated, accumulatedNames);
      const supportFace = resolveModifierTopologyReference(feature.onFace, 'face', lookups);
      plane = rc.makePlaneFromFace(supportFace);
      if (feature.type === 'cut' && feature.through) {
        const supportNormal = supportFace.normalAt();
        try {
          const sweep = throughAllCutSweep(accumulated, plane, [supportNormal.x, supportNormal.y, supportNormal.z]);
          safeDelete(plane);
          plane = sweep.plane;
        } finally {
          safeDelete(supportNormal);
        }
      }
    } else {
      const planeName = feature.plane?.kind === 'base' ? feature.plane.plane : 'XY';
      const normal = basePlaneNormal(planeName);
      const depth = feature.type === 'cut' && feature.through
        ? 0
        : exactExtrusionDepth(feature, N);
      const originDistance = (feature.symmetric ? -depth / 2 : 0) + sketchPlaneOffset(feature, N);
      const authoredPlane = rc.makePlane(planeName, normal.map((value) => value * originDistance));
      if (feature.type === 'cut' && feature.through) {
        try {
          const sweep = throughAllCutSweep(accumulated, authoredPlane, normal);
          plane = sweep.plane;
        } finally {
          safeDelete(authoredPlane);
        }
      } else {
        plane = authoredPlane;
      }
    }

    const worldPoint = (point) => {
      const world = plane.toWorldCoords(point);
      try { return [world.x ?? world[0], world.y ?? world[1], world.z ?? world[2]]; }
      finally { safeDelete(world); }
    };
    const origin = worldPoint([0, 0]);
    const xPoint = worldPoint([1, 0]);
    const yPoint = worldPoint([0, 1]);
    const subtract = (left, right) => left.map((value, index) => value - right[index]);
    const cross = (left, right) => [
      left[1] * right[2] - left[2] * right[1],
      left[2] * right[0] - left[0] * right[2],
      left[0] * right[1] - left[1] * right[0],
    ];
    const normalize = (vector) => {
      const length = Math.hypot(...vector);
      if (!(length > 1e-12)) throw new Error('Sketch-level pattern support frame is degenerate.');
      return vector.map((value) => value / length);
    };
    const xDirection = normalize(subtract(xPoint, origin));
    const yDirection = normalize(subtract(yPoint, origin));
    const normal = normalize(cross(xDirection, yDirection));
    const transforms = [];
    for (let index = 1; index < countValue; index++) {
      if (pattern.kind === 'linear') {
        const dx = N(pattern.dx ?? 0) * index;
        const dy = N(pattern.dy ?? 0) * index;
        transforms.push([{
          kind: 'translate',
          vector: xDirection.map((value, axis) => value * dx + yDirection[axis] * dy),
        }]);
      } else {
        transforms.push([{
          kind: 'rotate',
          point: worldPoint([N(pattern.cx ?? 0), N(pattern.cy ?? 0)]),
          direction: normal,
          angleDegrees: 360 / countValue * index,
        }]);
      }
    }
    return transforms;
  } finally {
    lookups?.dispose();
    safeDelete(plane);
  }
}

// Build inline sketch-level patterns as explicit exact solid occurrences.
// The previous path fused transformed 2D drawings and then attempted to infer
// names from the final geometry. Here every occurrence starts from one fully
// named source solid, is transformed through OCCT history, and is fused through
// OCCT Boolean history. Incomplete source provenance blocks the operation.
function buildExactProfilePatternOutcome(feature, zTop, accumulated, N, NS, accumulatedNames, part) {
  if (!topo || !patternFeatureHistory) throw new Error('persistent topology history is unavailable for Sketch pattern');
  if (!feature?.extensions?.exactSketchEntities || !feature.pattern) return null;
  if (feature.type !== 'cut' && feature.type !== 'extrude') {
    throw new Error('Exact sketch-level patterns currently require an Extrude or Cut feature.');
  }
  const sourceFeature = { ...feature, pattern: null };
  let sourceShape = null;
  let sourceNames = null;
  let sourceTables = null;
  let fused = null;
  try {
    sourceShape = featureSolid(sourceFeature, zTop, accumulated, N, NS, accumulatedNames);
    sourceNames = creationNameTable(sourceFeature, sourceShape, N, part, accumulated, accumulatedNames);
    sourceTables = completePatternTopologyTables(sourceShape, sourceNames);
    const transforms = exactProfilePatternTransforms(sourceFeature.pattern ? sourceFeature : feature, N, accumulated, accumulatedNames);
    if (!transforms.length) {
      const outcome = { shape: sourceShape, names: sourceNames, diagnostics: [] };
      sourceShape = null;
      sourceNames = null;
      return outcome;
    }
    fused = patternFeatureHistory.fusePatternWithHistory({
      sourceShape,
      sourceTables,
      featureId: feature.id,
      instances: [
        { instanceId: feature.id + ':profile-instance:0', transforms: [] },
        ...transforms.map((steps, index) => ({
          instanceId: feature.id + ':profile-instance:' + (index + 1),
          transforms: steps,
        })),
      ],
    });
    const names = fused.names.faces;
    fused.names.faces = [];
    const outcome = { shape: fused.shape, names, diagnostics: fused.diagnostics || [] };
    fused.shape = null;
    patternFeatureHistory.disposeTables(fused.names);
    fused = null;
    return outcome;
  } finally {
    if (fused) patternFeatureHistory.disposeOutcome(fused);
    if (sourceTables) patternFeatureHistory.disposeTables(sourceTables);
    disposeNameTable(sourceNames);
    safeDelete(sourceShape);
  }
}

function studioV5FeatureOutcome(document, part, feature, zTop, accumulated, N, NS, accumulatedNames = []) {
  assertStudioV5FeatureContract(feature);
  assertStudioV5FeatureStructure(feature);
  if (feature.type === 'imported-step') {
    if (!importedTopologyRegistry) throw new Error('Imported persistent topology registry is unavailable');
    const resourceId = feature.extensions?.studioImportedStep?.resourceId;
    const resource = document.resources?.find((entry) => entry.id === resourceId);
    if (!resource?.data || resource.encoding !== 'base64') throw new Error('Imported STEP body resource is missing');
    const binary = atob(resource.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const restored = importedTopologyRegistry.restore({
      sourceBrep: new TextDecoder().decode(bytes),
      registry: resource.extensions?.studioImportedStep?.topologyRegistry,
      expectedRegistryRef: feature.extensions?.studioImportedStep?.topologyRegistry,
    });
    try {
      const shape = restored.shape;
      restored.shape = null;
      const names = restored.names.faces;
      restored.names.faces = [];
      names.explicitEdgeTable = restored.names.edges;
      restored.names.edges = [];
      names.explicitVertexTable = restored.names.vertices;
      restored.names.vertices = [];
      return { shape, names, diagnostics: restored.diagnostics || [] };
    } finally {
      importedTopologyRegistry.disposeOutcome(restored);
    }
  }
  if (feature.type === 'weldment-treatment') {
    return buildStudioWeldmentTreatmentNewBody(document, part, feature, N);
  }
  if (feature.type === 'sheet-metal-flange') {
    return buildStudioSheetMetalNewBody(document, part, feature, N);
  }
  if (feature.type === 'loft') return buildStudioV5Loft(document, part, feature, N);
  if (feature.type === 'sweep') return buildStudioV5Sweep(document, part, feature, N);
  if (feature.type === 'revolve' && feature.profileSketchId) return buildStudioV5Revolve(document, part, feature, N);
  const constrainedExecutionFeature = resolvedConstrainedExecutionFeature(part, feature, N);
  if (constrainedExecutionFeature) {
    if (constrainedExecutionFeature.pattern) {
      const patterned = buildExactProfilePatternOutcome(
        constrainedExecutionFeature, zTop, accumulated, N, NS, accumulatedNames, part,
      );
      if (patterned) return patterned;
    }
    return {
      shape: featureSolid(
        constrainedExecutionFeature,
        zTop,
        accumulated,
        N,
        NS,
        accumulatedNames,
      ),
      names: null,
      diagnostics: [],
    };
  }
  if (feature.type === 'revolve') return buildInlineRevolve(feature, N);
  if (feature.pattern) {
    const patterned = buildExactProfilePatternOutcome(feature, zTop, accumulated, N, NS, accumulatedNames, part);
    if (patterned) return patterned;
  }
  return {
    shape: featureSolid(feature, zTop, accumulated, N, NS, accumulatedNames),
    names: null,
    diagnostics: [],
  };
}

const patternInstanceId = (patternId, index) => patternId + '-instance-' + index;

function fillPatternInstanceId(patternId, lattice) {
  const signed = (value) => (value < 0 ? 'n' + Math.abs(value) : 'p' + value);
  return patternId + '-instance-lattice-' + signed(lattice[0]) + '-' + signed(lattice[1]);
}

function patternReference(pattern, role) {
  return (pattern.references || []).find((reference) => reference.semanticPath?.role === role);
}

function patternCount(pattern, N) {
  const count = N(pattern.definition?.count);
  if (!Number.isInteger(count) || count < 2 || count > 5000) throw new Error('pattern count must evaluate to an integer from 2 to 5,000');
  return count;
}

function patternOccurrenceCount(pattern, N) {
  const count = patternCount(pattern, N);
  if (pattern.kind !== 'linear' || !patternReference(pattern, 'direction-2')) return count;
  const count2 = N(pattern.definition?.count2);
  if (!Number.isInteger(count2) || count2 < 2 || count * count2 > 5000) throw new Error('two-direction pattern counts must produce from 4 to 5,000 total occurrences');
  return count * count2;
}

function patternStep(index, symmetric) {
  if (!symmetric) return index;
  return Math.ceil(index / 2) * (index % 2 ? 1 : -1);
}

function shapeCenter(shape) {
  const bounds = shape.boundingBox?.bounds;
  if (!bounds) return [0, 0, 0];
  return bounds[0].map((value, axis) => (value + bounds[1][axis]) / 2);
}

const PATTERN_SOURCE_ANCHOR_TOLERANCE = 1e-7;

function finitePatternPoint2(value, label) {
  if (!Array.isArray(value) || value.length !== 2 || value.some((coordinate) => !Number.isFinite(coordinate))) {
    throw new Error(label + ' must resolve to exactly two finite coordinates');
  }
  return [value[0], value[1]];
}

function tuple3(value) {
  return [value.x ?? value[0], value.y ?? value[1], value.z ?? value[2]];
}

function constrainedPatternSketchFrame(sketch, N) {
  if (sketch?.extensions?.studioRole !== STUDIO_CONSTRAINED_2D_ROLE) {
    throw new Error('sketch-point pattern reference is not a first-class constrained sketch');
  }
  const planeName = sketch.plane || 'XY';
  if (!['XY', 'YZ', 'ZX'].includes(planeName)) throw new Error('sketch-point pattern support plane is invalid');
  const offset = N(sketch.z ?? 0);
  if (!Number.isFinite(offset)) throw new Error('sketch-point pattern support offset must evaluate to a finite number');
  const normal = basePlaneNormal(planeName);
  const plane = rc.makePlane(planeName, normal.map((value) => value * offset));
  return {
    world(localPoint) {
      const point = plane.toWorldCoords(localPoint);
      try { return tuple3(point); }
      finally { safeDelete(point); }
    },
    local(worldPoint) {
      const point = plane.toLocalCoords(worldPoint);
      try { return [point.x ?? point[0], point.y ?? point[1]]; }
      finally { safeDelete(point); }
    },
    evidence: { kind: 'base-plane', plane: planeName, offset },
    dispose() { safeDelete(plane); },
  };
}

function advancedPatternSketchFrame(document, part, sketch) {
  if (sketch?.extensions?.studioRole !== 'profile' || sketch.support?.ownerKind !== 'datum') {
    throw new Error('fill pattern boundary is not a datum-plane-supported advanced profile');
  }
  const frame = resolveStudioV5Datums(document, part.id).resolve(sketch.support.ownerId);
  if (frame.kind !== 'plane') throw new Error('fill pattern boundary support is not a plane datum');
  const { add, subtract, multiply, dot } = studioV5VectorMath;
  return {
    world([x, y]) {
      return add(frame.origin, add(multiply(frame.xDirection, x), multiply(frame.yDirection, y)));
    },
    local(point) {
      const offset = subtract(point, frame.origin);
      return [dot(offset, frame.xDirection), dot(offset, frame.yDirection)];
    },
    evidence: {
      kind: 'datum-plane',
      datumId: sketch.support.ownerId,
      origin: [...frame.origin],
      xDirection: [...frame.xDirection],
      yDirection: [...frame.yDirection],
      normal: [...frame.normal],
    },
    dispose() {},
  };
}

function assertPatternSourceAnchor(sourceShape, frame, expectedLocalPoint, label) {
  const projected = finitePatternPoint2(frame.local(shapeCenter(sourceShape)), label + ' source projection');
  const expected = finitePatternPoint2(expectedLocalPoint, label + ' seed');
  const drift = Math.hypot(projected[0] - expected[0], projected[1] - expected[1]);
  if (drift > PATTERN_SOURCE_ANCHOR_TOLERANCE) {
    throw new Error(
      label + ' requires the current source bounding-box center projection to equal its seed point; drift is '
      + drift + ' mm',
    );
  }
  return projected;
}

function advancedPatternPlacementPlan(document, part, pattern, sourceShape, N, sketchById) {
  if (pattern.kind !== 'sketch' && pattern.kind !== 'fill' && pattern.kind !== 'variable') return null;
  if ((pattern.outputMode || 'linked') !== 'linked') {
    throw new Error(pattern.kind + ' patterns currently require linked output so every exact occurrence remains independently named');
  }
  const definition = pattern.definition || {};
  const { subtract, multiply } = studioV5VectorMath;
  if (pattern.kind === 'sketch') {
    const reference = patternReference(pattern, 'point-sketch');
    if (!reference || reference.ownerKind !== 'sketch') throw new Error('sketch-point pattern is missing its point-sketch reference');
    const sketch = sketchById.get(reference.ownerId);
    if (!sketch || sketch.constrained?.derivedFrom) throw new Error('sketch-point pattern requires one direct constrained sketch');
    const count = patternCount(pattern, N);
    const pointIds = definition.pointIds || [];
    if (pointIds.length !== count || new Set(pointIds).size !== pointIds.length) {
      throw new Error('sketch-point pattern pointIds must contain one unique solved point per occurrence, including the seed');
    }
    const resolved = resolveStudioConstrainedSketch(part, sketch.id, { evaluate: N });
    const solvedById = new Map(resolved.solved.entities.map((entity) => [entity.id, entity]));
    const localPoints = pointIds.map((pointId) => {
      const entity = solvedById.get(pointId);
      if (entity?.kind !== 'point') throw new Error('sketch-point pattern point "' + pointId + '" is missing from the current solved sketch');
      return finitePatternPoint2(entity.at, 'Solved sketch point "' + pointId + '"');
    });
    const frame = constrainedPatternSketchFrame(sketch, N);
    try {
      const sourceProjection = assertPatternSourceAnchor(sourceShape, frame, localPoints[0], 'Sketch-point pattern');
      const worldPoints = localPoints.map((point) => frame.world(point));
      return {
        count,
        occurrences: worldPoints.slice(1).map((point, offset) => ({
          index: offset + 1,
          bodyId: patternInstanceId(pattern.id, offset + 1),
          placementKey: pointIds[offset + 1],
          translation: subtract(point, worldPoints[0]),
        })),
        referenceState: {
          kind: 'sketch',
          sketchId: sketch.id,
          frame: frame.evidence,
          sourceProjection,
          points: pointIds.map((id, index) => ({ id, local: localPoints[index], world: worldPoints[index] })),
        },
      };
    } finally {
      frame.dispose();
    }
  }
  if (pattern.kind === 'fill') {
    if ((pattern.skippedIndices || []).length) throw new Error('fill pattern skippedIndices must stay empty');
    const reference = patternReference(pattern, 'boundary');
    if (!reference || reference.ownerKind !== 'sketch') throw new Error('fill pattern is missing its boundary reference');
    const sketch = sketchById.get(reference.ownerId);
    const entity = sketch?.entities?.[0];
    if (sketch?.extensions?.studioRole !== 'profile' || entity?.kind !== 'polyline' || entity.closed !== true) {
      throw new Error('fill pattern boundary must be one closed advanced polyline profile');
    }
    const boundaryPoints = evaluatedSketchPoints(sketch, N).map((point, index) =>
      finitePatternPoint2(point, 'Fill boundary point ' + (index + 1)));
    const seed = finitePatternPoint2((definition.seed || []).map((value) => N(value)), 'Fill pattern seed');
    const spacing = N(definition.spacing);
    const rotationDegrees = N(definition.rotation);
    const boundaryMargin = N(definition.boundaryMargin);
    const maximumCount = definition.maximumCount;
    if (!Number.isInteger(maximumCount) || maximumCount < 2 || maximumCount > 5000) {
      throw new Error('fill pattern maximumCount must be a literal integer from 2 to 5,000');
    }
    const generated = studioFillPatternLattice({
      boundaryPoints,
      layout: definition.layout,
      spacing,
      rotationDegrees,
      boundaryMargin,
      seed,
      maxGenerated: maximumCount - 1,
    });
    const frame = advancedPatternSketchFrame(document, part, sketch);
    try {
      const sourceProjection = assertPatternSourceAnchor(sourceShape, frame, seed, 'Fill pattern');
      const seedWorld = frame.world(seed);
      return {
        count: generated.length + 1,
        occurrences: generated.map((entry, offset) => ({
          index: offset + 1,
          bodyId: fillPatternInstanceId(pattern.id, entry.lattice),
          placementKey: entry.key,
          lattice: [...entry.lattice],
          translation: subtract(frame.world(entry.point), seedWorld),
        })),
        referenceState: {
          kind: 'fill',
          sketchId: sketch.id,
          frame: frame.evidence,
          sourceProjection,
          boundaryPoints,
          seed,
          layout: definition.layout,
          spacing,
          rotationDegrees,
          boundaryMargin,
          maximumCount,
          lattice: generated.map((entry) => ({ key: entry.key, lattice: [...entry.lattice], point: [...entry.point] })),
        },
      };
    } finally {
      frame.dispose();
    }
  }
  const reference = patternReference(pattern, 'direction');
  if (!reference || reference.ownerKind !== 'datum') throw new Error('variable pattern is missing its direction datum');
  const frame = resolveStudioV5Datums(document, part.id).resolve(reference.ownerId);
  const direction = frame.kind === 'axis' ? frame.direction : frame.kind === 'coordinate-system' ? frame.xDirection : null;
  if (!direction) throw new Error('variable pattern direction must resolve to an axis or coordinate system');
  const count = patternCount(pattern, N);
  const instances = definition.instances || [];
  if (instances.length !== count - 1 || instances.length > 100) {
    throw new Error('variable pattern instances must contain one row per generated occurrence (maximum 100)');
  }
  const positions = [];
  const occurrences = instances.map((instance, offset) => {
    const position = N(instance.position);
    if (!Number.isFinite(position)) throw new Error('variable pattern position must evaluate to a finite number');
    const positionKey = String(position);
    if (positions.some((prior) => Math.abs(prior - position) <= 1e-9)) {
      throw new Error('variable pattern positions must be unique after evaluation');
    }
    positions.push(position);
    return {
      index: offset + 1,
      bodyId: patternInstanceId(pattern.id, offset + 1),
      placementKey: 'position:' + positionKey,
      position,
      translation: multiply(direction, position),
      parameterOverrides: structuredClone(instance.parameterOverrides || {}),
    };
  });
  return {
    count,
    occurrences,
    referenceState: {
      kind: 'variable',
      datumId: reference.ownerId,
      direction: [...direction],
      positions: occurrences.map((entry) => entry.position),
    },
  };
}

function patternPlacementPlan(document, part, pattern, sourceShape, N, sketchById) {
  const advanced = advancedPatternPlacementPlan(document, part, pattern, sourceShape, N, sketchById);
  if (advanced) return advanced;
  const count = patternOccurrenceCount(pattern, N);
  return {
    count,
    occurrences: Array.from({ length: count - 1 }, (_unused, offset) => ({
      index: offset + 1,
      bodyId: patternInstanceId(pattern.id, offset + 1),
      placementKey: String(offset + 1),
    })),
    referenceState: null,
  };
}

const identityMatrix = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiplyMatrix(left, right) {
  const out = Array(16).fill(0);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    for (let inner = 0; inner < 4; inner++) out[column * 4 + row] += left[inner * 4 + row] * right[column * 4 + inner];
  }
  return out;
}
const translationMatrix = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
function rotationMatrix(degrees, point, axis) {
  const [x, y, z] = studioV5VectorMath.normalize(axis);
  const angle = degrees * Math.PI / 180;
  const c = Math.cos(angle); const s = Math.sin(angle); const t = 1 - c;
  const rotation = [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
  return multiplyMatrix(translationMatrix(point), multiplyMatrix(rotation, translationMatrix(point.map((value) => -value))));
}
function mirrorMatrix(normal, point) {
  const [x, y, z] = studioV5VectorMath.normalize(normal);
  const offset = 2 * (x * point[0] + y * point[1] + z * point[2]);
  return [
    1 - 2 * x * x, -2 * x * y, -2 * x * z, 0,
    -2 * x * y, 1 - 2 * y * y, -2 * y * z, 0,
    -2 * x * z, -2 * y * z, 1 - 2 * z * z, 0,
    offset * x, offset * y, offset * z, 1,
  ];
}
function sceneRenderMatrix(cadMatrix) {
  const cadToScene = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  const sceneToCad = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
  return multiplyMatrix(cadToScene, multiplyMatrix(cadMatrix, sceneToCad));
}
function applyLocatedTransform(shape, configure) {
  const transformation = new rc.Transformation();
  let transformer = null;
  try {
    configure(transformation);
    const OC = rc.getOC();
    transformer = new OC.BRepBuilderAPI_Transform_2(shape.wrapped, transformation.wrapped, false);
    return rc.cast(transformer.ModifiedShape(shape.wrapped));
  } finally {
    transformer?.delete();
    transformation.delete();
    shape.delete();
  }
}
function pathFrameAtArcFraction(path, fraction) {
  const adaptor = new path.oc.BRepAdaptor_CompCurve_2(path.wrapped, true);
  const point = new path.oc.gp_Pnt_1();
  const tangent = new path.oc.gp_Vec_1();
  try {
    const parameter = adaptor.FirstParameter() + (adaptor.LastParameter() - adaptor.FirstParameter()) * fraction;
    adaptor.D1(parameter, point, tangent);
    return {
      point: [point.X(), point.Y(), point.Z()],
      tangent: [tangent.X(), tangent.Y(), tangent.Z()],
    };
  } finally {
    point.delete(); tangent.delete(); adaptor.delete();
  }
}

function patternTransform(document, part, pattern, sourceShape, index, N, sketchById, placementRecord = null) {
  const definition = pattern.definition || {};
  const { add, subtract, multiply, dot, length, normalize, rotateVector } = studioV5VectorMath;
  const datums = resolveStudioV5Datums(document, part.id);
  let next = sourceShape.clone();
  let placement = identityMatrix();
  const historyTransforms = [];
  const translate = (vector) => {
    historyTransforms.push({ kind: 'translate', vector: [...vector] });
    next = applyLocatedTransform(next, (transformation) => transformation.translate(vector));
    placement = multiplyMatrix(translationMatrix(vector), placement);
  };
  const rotate = (degrees, point, axis) => {
    historyTransforms.push({ kind: 'rotate', angleDegrees: degrees, point: [...point], direction: [...axis] });
    next = applyLocatedTransform(next, (transformation) => transformation.rotate(degrees, point, axis));
    placement = multiplyMatrix(rotationMatrix(degrees, point, axis), placement);
  };
  try {
  if (pattern.kind === 'sketch' || pattern.kind === 'fill' || pattern.kind === 'variable') {
    if (!placementRecord || !Array.isArray(placementRecord.translation)
        || placementRecord.translation.length !== 3
        || placementRecord.translation.some((value) => !Number.isFinite(value))) {
      throw new Error(pattern.kind + ' pattern occurrence is missing its current exact placement');
    }
    translate(placementRecord.translation);
    return { shape: next, placement, historyTransforms };
  }
  if (pattern.kind === 'mirror') {
    const reference = patternReference(pattern, 'plane');
    const frame = datums.resolve(reference.ownerId);
    historyTransforms.push({ kind: 'mirror', point: [...frame.origin], normal: [...frame.normal] });
    next = applyLocatedTransform(next, (transformation) => transformation.mirror(frame.normal, frame.origin));
    placement = multiplyMatrix(mirrorMatrix(frame.normal, frame.origin), placement);
    return { shape: next, placement, historyTransforms };
  }
  if (pattern.kind === 'linear') {
    const count = patternCount(pattern, N);
    const secondReference = patternReference(pattern, 'direction-2');
    const firstIndex = secondReference ? index % count : index;
    const secondIndex = secondReference ? Math.floor(index / count) : 0;
    const transformDirection = (reference, ordinal, distribution, spacing, extent, positions, symmetric, alternating) => {
      if (!reference || ordinal === 0) return;
      const frame = datums.resolve(reference.ownerId);
      const direction = frame.kind === 'axis' ? frame.direction : frame.xDirection;
      const dimensionCount = reference === secondReference ? N(definition.count2) : count;
      let distance;
      if (distribution === 'table') distance = N(positions[ordinal - 1]);
      else if (distribution === 'extent') distance = N(extent) / (dimensionCount - 1) * patternStep(ordinal, symmetric);
      else distance = N(spacing) * patternStep(ordinal, symmetric);
      translate(multiply(direction, distance));
      if (alternating === true && ordinal % 2 === 1) rotate(180, shapeCenter(next), direction);
    };
    transformDirection(patternReference(pattern, 'direction'), firstIndex, definition.distribution, definition.spacing, definition.extent, definition.positions, definition.symmetric, definition.alternating);
    transformDirection(secondReference, secondIndex, definition.distribution2, definition.spacing2, definition.extent2, definition.positions2, definition.symmetric2, definition.alternating2);
    return { shape: next, placement, historyTransforms };
  }
  if (pattern.kind === 'circular') {
    const reference = patternReference(pattern, 'axis');
    const frame = datums.resolve(reference.ownerId);
    const direction = frame.kind === 'axis' ? frame.direction : frame.zDirection;
    const count = patternCount(pattern, N);
    let angle;
    if (definition.distribution === 'table') angle = N(definition.angles[index - 1]);
    else if (definition.distribution === 'spacing') angle = N(definition.spacingAngle) * patternStep(index, definition.symmetric);
    else if (definition.distribution === 'extent') angle = N(definition.totalAngle) / (count - 1) * patternStep(index, definition.symmetric);
    else angle = 360 / count * index;
    const center = shapeCenter(sourceShape);
    const centerOffset = subtract(center, frame.origin);
    const axialComponent = multiply(direction, dot(centerOffset, direction));
    const radial = subtract(centerOffset, axialComponent);
    const radialDirection = length(radial) > 1e-8 ? normalize(rotateVector(radial, direction, angle)) : [1, 0, 0];
    if (definition.orientation === 'preserve') {
      const rotatedCenter = add(frame.origin, add(axialComponent, rotateVector(radial, direction, angle)));
      translate(subtract(rotatedCenter, center));
    } else {
      rotate(angle, frame.origin, direction);
      if (definition.orientation === 'alternating' && index % 2 === 1) rotate(180, shapeCenter(next), direction);
    }
    const radialOffset = N(definition.radialOffset ?? 0) * index;
    const axialOffset = N(definition.axialOffset ?? 0) * index;
    if (Math.abs(radialOffset) > 1e-9 || Math.abs(axialOffset) > 1e-9) {
      translate(add(multiply(radialDirection, radialOffset), multiply(direction, axialOffset)));
    }
    return { shape: next, placement, historyTransforms };
  }
  const reference = patternReference(pattern, 'path');
  const pathSketch = sketchById.get(reference.ownerId);
  const path = pathWire3d(document, part, pathSketch, N);
  try {
    const count = patternCount(pattern, N);
    let parameter;
    if (definition.distribution === 'table') parameter = N(definition.parameters[index - 1]);
    else if (definition.distribution === 'spacing') parameter = index * N(definition.spacing) / path.length;
    else if (definition.distribution === 'extent') parameter = index * N(definition.extent) / (count - 1) / path.length;
    else parameter = index / (count - 1);
    if (!(parameter >= 0 && parameter <= 1)) throw new Error('curve pattern parameter must stay between 0 and 1');
    const startFrame = pathFrameAtArcFraction(path, 0);
    const currentFrame = pathFrameAtArcFraction(path, parameter);
    const startPoint = startFrame.point;
    const point = currentFrame.point;
    if (definition.orientation === 'tangent') {
      const rotation = rotationBetween(startFrame.tangent, currentFrame.tangent);
      if (Math.abs(rotation.angle) > 1e-8) rotate(rotation.angle, startPoint, rotation.axis);
    }
    translate(subtract(point, startPoint));
    return { shape: next, placement, historyTransforms };
  } finally {
    path.delete();
  }
  } catch (error) {
    safeDelete(next);
    throw error;
  }
}

function completePatternTopologyTables(shape, faceTable) {
  if (!topo || !patternFeatureHistory) throw new Error('persistent topology history is unavailable for Pattern');
  const tables = { faces: [], edges: [], vertices: [] };
  const lookups = topo.nameLookups(shape, faceTable || []);
  let vertices = [];
  try {
    tables.faces = (faceTable || []).map((entry) => ({ name: entry.name, face: entry.face.clone() }));
    if (faceTable?.diagnostics?.some((entry) => entry.severity === 'error')) {
      throw new Error('pattern source face provenance is ambiguous');
    }
    if (lookups.diagnostics.some((entry) => entry.severity === 'error')
      || lookups.edgeTable.length !== lookups.edgeCandidates.length) {
      throw new Error('pattern source edge provenance is incomplete or ambiguous');
    }
    tables.edges = lookups.edgeTable.map((entry) => ({ name: entry.name, edge: entry.edge.clone() }));
    vertices = patternFeatureHistory.exactVertices(shape);
    if (faceTable && Object.prototype.hasOwnProperty.call(faceTable, 'explicitVertexTable')) {
      const serializedNames = topo.serializationNames(shape, faceTable);
      try {
        if (serializedNames.diagnostics.some((entry) => entry.severity === 'error')
          || serializedNames.vertexTable.length !== vertices.length) {
          throw new Error('pattern source vertex provenance is incomplete or ambiguous');
        }
        tables.vertices = vertices.map((vertex) => {
          const matches = serializedNames.vertexTable.filter((entry) =>
            vertex.wrapped.IsSame(entry.vertex.wrapped));
          if (matches.length !== 1) throw new Error('pattern source vertex did not resolve to exactly one persistent name');
          return { name: matches[0].name, vertex: vertex.clone() };
        });
      } finally {
        serializedNames.dispose();
      }
    } else {
      const vertexNaming = derivePersistentVertexNames({
        edges: lookups.edgeCandidates,
        getEdgeName: (edge) => lookups.getEdgeName(edge),
        getEdgeEndpoints: (edge) => exactEdgeEndpointVertices(edge, vertices.map((vertex) => vertex.wrapped)),
        isSameEdge: (left, right) => left.wrapped.IsSame(right.wrapped),
        isSameVertex: (left, right) => left.IsSame(right),
      });
      if (vertexNaming.diagnostics.length || vertexNaming.vertexTable.length !== vertices.length) {
        throw new Error('pattern source vertex provenance is incomplete or ambiguous');
      }
      tables.vertices = vertices.map((vertex) => {
        const matches = vertexNaming.vertexTable.filter((entry) => vertex.wrapped.IsSame(entry.vertex));
        if (matches.length !== 1) throw new Error('pattern source vertex did not resolve to exactly one persistent name');
        return { name: matches[0].name, vertex: vertex.clone() };
      });
    }
    patternFeatureHistory.validateCompleteTables(shape, tables);
    return tables;
  } catch (error) {
    patternFeatureHistory.disposeTables(tables);
    throw error;
  } finally {
    patternFeatureHistory.disposeWrappers(vertices);
    lookups.dispose();
  }
}

function disposeCachedNameData(entry) {
  if (entry?.patternTables && patternFeatureHistory) patternFeatureHistory.disposeTables(entry.patternTables);
  else disposeNameTable(entry?.names);
}

function disposeUncachedV5Build(built) {
  const disposedShapes = new Set();
  const disposedNames = new Set();
  for (const result of [...(built?.results?.values() || []), ...(built?.patternResults?.values() || [])]) {
    if (result?.shape && !disposedShapes.has(result.shape)) {
      disposedShapes.add(result.shape);
      safeDelete(result.shape);
    }
    const nameOwner = result?.patternTables || result?.names;
    if (nameOwner && !disposedNames.has(nameOwner)) {
      disposedNames.add(nameOwner);
      disposeCachedNameData(result);
    }
  }
}

async function buildV5Document(document, options = {}) {
  await loadKernel();
  const part = options.partId
    ? (document.partDefinitions || []).find((entry) => entry.id === options.partId)
    : v5RootPart(document);
  if (!part) throw new Error('The requested schema-5 part definition is missing.');
  for (const feature of part.features || []) assertStudioV5FeatureStructure(feature);
  const { strict: N, safe: NS } = evaluator(document, part);
  const featureById = new Map(part.features.map((feature) => [feature.id, feature]));
  const bodyById = new Map(part.bodies.map((body) => [body.id, body]));
  const cache = options.cache || new Map();
  const previousCache = options.previousCache || new Map();
  const evaluating = new Set();
  const signatures = new Map();
  const signing = new Set();
  const results = new Map();
  const errors = [];
  const warnings = []; // non-fatal diagnostics: { severity:'warning', code, bodyId, featureId, featureType, message }
  const evaluatedBodyIds = [];
  const reusedBodyIds = [];
  const evaluatedFeatureIds = [];
  const reusedFeatureIds = [];
  const evaluatedPatternInstanceIds = [];
  const reusedPatternInstanceIds = [];
  // Parameter state is scoped to the records that actually consume it. Part
  // parameters shadow project parameters exactly as the evaluator does, and
  // transitive expression dependencies are included. This lets a downstream
  // edit reuse upstream feature checkpoints without making cache correctness
  // depend on a lossy hash or on unrelated parameters elsewhere in the part.
  const effectiveParameterByName = new Map();
  for (const parameter of document.parameters || []) {
    effectiveParameterByName.set(parameter.name, { scope: 'project', parameter });
  }
  for (const parameter of part.parameters || []) {
    effectiveParameterByName.set(parameter.name, { scope: 'part', parameter });
  }
  function parameterStateFor(value) {
    const names = new Set();
    const collect = (entry) => {
      if (typeof entry === 'string') {
        for (const match of entry.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
          if (effectiveParameterByName.has(match[0])) names.add(match[0]);
        }
      } else if (Array.isArray(entry)) {
        for (const item of entry) collect(item);
      } else if (entry && typeof entry === 'object') {
        for (const item of Object.values(entry)) collect(item);
      }
    };
    collect(value);
    const expanded = new Set();
    for (;;) {
      const pending = [...names].filter((name) => !expanded.has(name));
      if (!pending.length) break;
      for (const name of pending) {
        expanded.add(name);
        collect(effectiveParameterByName.get(name)?.parameter?.value);
      }
    }
    return [...names].sort().map((name) => {
      const entry = effectiveParameterByName.get(name);
      return [entry.scope, entry.parameter];
    });
  }
  const datumById = new Map((part.referenceGeometry || []).map((datum) => [datum.id, datum]));
  const sketchById = new Map((part.sketches || []).map((sketch) => [sketch.id, sketch]));
  const sketchBlockDefinitionById = new Map(
    (part.sketchBlockDefinitions || []).map((definition) => [definition.id, definition]),
  );
  const datumSignatures = new Map();
  const sketchSignatures = new Map();
  const sketchBlockDefinitionSignatures = new Map();
  const signingDatums = new Set();
  const signingSketches = new Set();
  function sketchBlockDefinitionSignature(definitionId) {
    if (sketchBlockDefinitionSignatures.has(definitionId)) {
      return sketchBlockDefinitionSignatures.get(definitionId);
    }
    const definition = sketchBlockDefinitionById.get(definitionId);
    const signature = stableSource({
      definition: definition || null,
      parameterState: parameterStateFor(definition),
    });
    sketchBlockDefinitionSignatures.set(definitionId, signature);
    return signature;
  }
  function sketchSignature(sketchId) {
    if (sketchSignatures.has(sketchId)) return sketchSignatures.get(sketchId);
    if (signingSketches.has(sketchId)) return 'cyclic:' + sketchId;
    signingSketches.add(sketchId);
    const sketch = sketchById.get(sketchId);
    const supportSignature = sketch?.support?.ownerKind === 'datum'
      ? datumSignature(sketch.support.ownerId)
      : null;
    const referenceCurve = sketch?.extensions?.referenceCurve;
    const referenceDatumIds = Object.entries(referenceCurve || {})
      .filter(([key, value]) => (key.endsWith('DatumId') || key.endsWith('DatumIds')) && (typeof value === 'string' || Array.isArray(value)))
      .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
    const referenceSketchIds = Object.entries(referenceCurve || {})
      .filter(([key, value]) => (key.endsWith('SketchId') || key.endsWith('SketchIds')) && (typeof value === 'string' || Array.isArray(value)))
      .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
    const derivedSourceId = sketch?.constrained?.derivedFrom?.sourceSketchId;
    if (typeof derivedSourceId === 'string') referenceSketchIds.push(derivedSourceId);
    const blockDefinitionIds = [...new Set(
      (sketch?.constrained?.blockInstances || []).map((instance) => instance.definitionId),
    )].sort();
    const uniqueReferenceSketchIds = [...new Set(referenceSketchIds)].sort();
    const signature = stableSource({
      sketch,
      supportSignature,
      parameterState: parameterStateFor(sketch),
      referenceDatumSignatures: referenceDatumIds.map((id) => [id, datumSignature(id)]),
      referenceSketchSignatures: uniqueReferenceSketchIds.map((id) => [id, sketchSignature(id)]),
      blockDefinitionSignatures: blockDefinitionIds.map((id) => [id, sketchBlockDefinitionSignature(id)]),
    });
    signingSketches.delete(sketchId);
    sketchSignatures.set(sketchId, signature);
    return signature;
  }
  function datumSignature(datumId) {
    if (datumSignatures.has(datumId)) return datumSignatures.get(datumId);
    if (signingDatums.has(datumId)) return 'cyclic:' + datumId;
    signingDatums.add(datumId);
    const datum = datumById.get(datumId);
    const dependencyIds = Object.entries(datum?.definition || {})
      .filter(([key, value]) => (key.endsWith('DatumId') || key.endsWith('DatumIds')) && (typeof value === 'string' || Array.isArray(value)))
      .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
    const dependencySketchIds = Object.entries(datum?.definition || {})
      .filter(([key, value]) => (key.endsWith('SketchId') || key.endsWith('SketchIds')) && (typeof value === 'string' || Array.isArray(value)))
      .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
    const signature = stableSource({
      datum,
      parameterState: parameterStateFor(datum),
      dependencies: dependencyIds.map((id) => [id, datumSignature(id)]),
      sketchDependencies: dependencySketchIds.map((id) => [id, sketchSignature(id)]),
    });
    signingDatums.delete(datumId);
    datumSignatures.set(datumId, signature);
    return signature;
  }
  const requestedRollbackIndex = part.metadata?.rollbackFeatureId
    ? part.featureOrder.indexOf(part.metadata.rollbackFeatureId)
    : -1;
  const rollbackIndex = requestedRollbackIndex >= 0 ? requestedRollbackIndex : part.featureOrder.length - 1;
  const enabledFeatureIds = new Set(part.featureOrder.slice(0, rollbackIndex + 1));

  function signatureStateForFeatures(bodyId, features) {
    const body = bodyById.get(bodyId);
    if (!body) throw new Error('missing body "' + bodyId + '"');
    const referencedBodyIds = new Set();
    const referencedDatumIds = new Set();
    const referencedSketchIds = new Set();
    const resourceSignatures = [];
    const collectKnownIds = (value) => {
      if (typeof value === 'string') {
        if (value !== bodyId && bodyById.has(value)) referencedBodyIds.add(value);
        if (datumById.has(value)) referencedDatumIds.add(value);
        if (sketchById.has(value)) referencedSketchIds.add(value);
      } else if (Array.isArray(value)) {
        for (const entry of value) collectKnownIds(entry);
      } else if (value && typeof value === 'object') {
        for (const entry of Object.values(value)) collectKnownIds(entry);
      }
    };
    for (const feature of features) {
      if (feature.suppressed) continue;
      const miterWithoutBodyDependency = feature.type === 'weldment-treatment'
        && feature.extensions?.weldmentTreatment?.kind === 'corner'
        && feature.extensions.weldmentTreatment.style === 'miter';
      if (miterWithoutBodyDependency) {
        const signatureFeature = structuredClone(feature);
        signatureFeature.inputRefs = signatureFeature.inputRefs.filter((reference) => reference?.ownerKind !== 'body');
        delete signatureFeature.extensions.weldmentTreatment.targetBodyId;
        delete signatureFeature.extensions.weldmentTreatment.otherBodyId;
        collectKnownIds(signatureFeature);
      } else collectKnownIds(feature);
      if (feature.type === 'weldment-treatment') {
        for (const reference of feature.inputRefs || []) {
          if (reference?.ownerKind !== 'feature') continue;
          const sourceFeature = featureById.get(reference.ownerId);
          if (sourceFeature) {
            const { createdBodyId: _createdBodyId, resultPolicy: _resultPolicy, ...sourceDefinition } = sourceFeature;
            collectKnownIds(sourceDefinition);
          }
        }
      }
      if (feature.type === 'imported-step') {
        const resourceId = feature.extensions?.studioImportedStep?.resourceId;
        const resource = document.resources?.find((entry) => entry.id === resourceId);
        resourceSignatures.push(['resource:' + String(resourceId || ''), stableSource(resource || null)]);
      }
    }
    const referencedDatumSignatures = [...referencedDatumIds].sort().map((datumId) =>
      [datumId, datumSignature(datumId)]);
    const referencedSketchSignatures = [...referencedSketchIds].sort().map((sketchId) =>
      [sketchId, sketchSignature(sketchId)]);
    return {
      parameterState: parameterStateFor({ features, referencedDatumSignatures, referencedSketchSignatures }),
      kind: body.kind,
      features,
      bodySignatures: [...referencedBodyIds].sort().map((dependencyBodyId) =>
        [dependencyBodyId, signatureFor(dependencyBodyId)]),
      resourceSignatures,
      referencedDatumSignatures,
      referencedSketchSignatures,
    };
  }

  function signatureFor(bodyId) {
    if (signatures.has(bodyId)) return signatures.get(bodyId);
    if (signing.has(bodyId)) throw new Error('cyclic body dependency at "' + bodyId + '"');
    signing.add(bodyId);
    const body = bodyById.get(bodyId);
    if (!body) throw new Error('missing body "' + bodyId + '"');
    const features = body.featureIds.map((featureId) => featureById.get(featureId)).filter((feature) => feature && enabledFeatureIds.has(feature.id));
    const signature = stableSource(signatureStateForFeatures(bodyId, features));
    signatures.set(bodyId, signature);
    signing.delete(bodyId);
    return signature;
  }

  function variablePatternConsumedParameters(bodyId) {
    const body = bodyById.get(bodyId);
    if (!body) throw new Error('variable pattern source body "' + bodyId + '" is missing');
    const activeFeatures = body.featureIds
      .map((featureId) => featureById.get(featureId))
      .filter((feature) => feature && !feature.suppressed && enabledFeatureIds.has(feature.id));
    const drivingValues = activeFeatures.map((feature) => Object.fromEntries(
      STUDIO_VARIABLE_PATTERN_DIMENSION_FIELDS
        .filter((field) => feature[field] !== undefined)
        .map((field) => [field, feature[field]]),
    ));
    return new Map(parameterStateFor(drivingValues)
      .filter(([scope]) => scope === 'part')
      .map(([, parameter]) => [parameter.name, parameter]));
  }

  function validateVariablePatternRows(pattern, placementPlan) {
    if (pattern.kind !== 'variable') return null;
    const consumedParameters = variablePatternConsumedParameters(pattern.sourceBodyId);
    if (!consumedParameters.size) throw new Error('variable pattern source consumes no supported part-local driving dimension');
    let expectedNames = null;
    const overrideSignatures = new Set();
    for (const occurrence of placementPlan.occurrences) {
      const overrides = occurrence.parameterOverrides;
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        throw new Error('variable pattern occurrence overrides must be a parameter-name record');
      }
      const names = Object.keys(overrides).sort();
      if (!names.length || names.length > 16) throw new Error('variable pattern occurrence must override from 1 to 16 driving parameters');
      if (expectedNames == null) expectedNames = names;
      else if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
        throw new Error('variable pattern rows must override the same ordered parameter-name set');
      }
      let differsFromSeed = false;
      for (const name of names) {
        if (!consumedParameters.has(name)) {
          throw new Error('variable pattern override "' + name + '" is not a transitively consumed part-local source dimension');
        }
        const value = overrides[name];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error('variable pattern override "' + name + '" must be a finite literal number');
        }
        if (Math.abs(value - N(name)) > 1e-12) differsFromSeed = true;
      }
      if (!differsFromSeed) throw new Error('every variable pattern row must change at least one current source dimension');
      const overrideSignature = stableSource(names.map((name) => [name, overrides[name]]));
      if (overrideSignatures.has(overrideSignature)) throw new Error('variable pattern rows must rebuild distinct parameter variants');
      overrideSignatures.add(overrideSignature);
    }
    return { consumedParameters, names: expectedNames || [] };
  }

  async function buildVariablePatternSeed(pattern, occurrence, variableContract) {
    const variantDocument = structuredClone(document);
    const variantPart = (variantDocument.partDefinitions || []).find((entry) => entry.id === part.id);
    if (!variantPart) throw new Error('variable pattern source part is missing from its rebuild document');
    // A variable occurrence is a seed-feature rebuild, never a recursive body
    // pattern evaluation. Removing the selected part's pattern recipes makes
    // that boundary explicit in both the validated document and worker call.
    variantPart.bodyPatterns = [];
    for (const name of variableContract.names) {
      const parameter = (variantPart.parameters || []).find((entry) => entry.name === name);
      if (!parameter) throw new Error('variable pattern part parameter "' + name + '" no longer exists');
      parameter.value = occurrence.parameterOverrides[name];
    }
    const preparedVariant = prepareStudioV5Project(variantDocument);
    const built = await buildV5Document(preparedVariant, {
      partId: part.id,
      cache: new Map(),
      previousCache: new Map(),
      skipBodyPatterns: true,
    });
    const seed = built.results.get(pattern.sourceBodyId);
    if (!seed?.shape || seed.error || !seed.geometry?.valid) {
      const message = seed?.error?.message || 'rebuilt source produced no valid exact solid';
      disposeUncachedV5Build(built);
      throw new Error('variable pattern seed rebuild failed: ' + message);
    }
    return { built, seed };
  }

  function evaluateBody(bodyId) {
    if (results.has(bodyId)) return results.get(bodyId);
    if (evaluating.has(bodyId)) throw new Error('cyclic body dependency at "' + bodyId + '"');
    evaluating.add(bodyId);
    const body = bodyById.get(bodyId);
    if (!body) throw new Error('missing body "' + bodyId + '"');
    const signature = signatureFor(bodyId);
    const cached = cache.get(bodyId);
    if (cached?.signature === signature && cached.shape) {
      const result = { ...cached, body, reused: true, lastValid: false };
      results.set(bodyId, result);
      reusedBodyIds.push(bodyId);
      reusedFeatureIds.push(...body.featureIds.filter((featureId) => {
        const feature = featureById.get(featureId);
        return feature && !feature.suppressed && enabledFeatureIds.has(feature.id);
      }));
      evaluating.delete(bodyId);
      return result;
    }
    const activeFeatures = body.featureIds
      .map((featureId) => featureById.get(featureId))
      .filter((feature) => feature && !feature.suppressed && enabledFeatureIds.has(feature.id));
    const activeFeatureDescriptors = activeFeatures.map((feature, index) => ({
      featureId: feature.id,
      // Store the complete stable source rather than a bounded hash: a cache
      // collision must never make an edited CAD feature reuse stale geometry.
      signature: stableSource(signatureStateForFeatures(bodyId, activeFeatures.slice(0, index + 1))),
    }));
    let rebuildPlan = planStudioFeatureRebuild(
      activeFeatureDescriptors,
      cached?.featureCheckpoints || [],
    );
    let shape = null;
    let names = [];
    let featureCheckpoints = [];
    let kernelRobustnessEvidence = [];
    let threadEvidence = [];
    if (rebuildPlan.restoreCheckpoint) {
      try {
        const restored = restoreFeatureCheckpoint(rebuildPlan.restoreCheckpoint);
        shape = restored.shape;
        names = restored.names;
        kernelRobustnessEvidence = restored.kernelRobustnessEvidence;
        threadEvidence = restored.threadEvidence;
        featureCheckpoints = cached.featureCheckpoints.slice(0, rebuildPlan.reusablePrefixLength);
      } catch {
        // Checkpoints are an optimization. Corrupt or stale payloads trigger a
        // deterministic cold rebuild and are never allowed to affect geometry.
        rebuildPlan = planStudioFeatureRebuild(activeFeatureDescriptors, []);
      }
    }
    reusedFeatureIds.push(...rebuildPlan.reusedFeatureIds);
    let failure = null;
    let currentFeature = null;
    const finishFeature = (feature, descriptor) => {
      if (!shape) throw new Error('the feature produced no solid');
      const geometry = bodyGeometry(shape);
      if (!geometry.valid) {
        throw new Error('feature result is not exactly one valid solid (solids ' + geometry.solidCount + ', volume ' + geometry.volume + (geometry.brepError ? ', check ' + geometry.brepError : '') + ')');
      }
      const currentThreadEntry = threadEvidence.find((entry) => entry.featureId === feature.id);
      const cosmeticThreadNoOp = currentThreadEntry?.mode === 'cosmetic';
      // Thread evidence describes the exact result topology at the point where
      // that Thread feature completed. Only a cosmetic Thread is an exact
      // shape no-op, so only it may carry earlier still-current records across
      // this feature boundary. Every geometry-changing feature invalidates all
      // earlier Thread records. A modeled Thread retains only its own freshly
      // generated record; any other geometry feature retains none.
      if (!cosmeticThreadNoOp) {
        threadEvidence = currentThreadEntry?.mode === 'modeled'
          ? cloneThreadEvidence([currentThreadEntry])
          : [];
      }
      const previousCheckpoint = featureCheckpoints.at(-1);
      if (cosmeticThreadNoOp && !previousCheckpoint?.topologyCarrier) {
        throw new Error('Cosmetic Thread requires an exact predecessor checkpoint.');
      }
      // A cosmetic thread is intentionally the same exact solid. Reuse the
      // predecessor's immutable topology carrier rather than serializing an
      // extra copy whose OCCT bookkeeping order could change byte evidence.
      // Restoring this carrier is therefore byte-identical to restoring the
      // body immediately before the cosmetic feature, including after reopen.
      const checkpoint = cosmeticThreadNoOp
        ? {
            featureId: feature.id,
            signature: descriptor.signature,
            kernelRobustnessEvidence: cloneKernelRobustnessEvidence(kernelRobustnessEvidence),
            threadEvidence: cloneThreadEvidence(threadEvidence),
            topologyCarrier: structuredClone(previousCheckpoint.topologyCarrier),
            topologyDiagnostics: structuredClone(previousCheckpoint.topologyDiagnostics),
          }
        : createFeatureCheckpoint(
            feature.id,
            descriptor.signature,
            shape,
            names,
            kernelRobustnessEvidence,
            threadEvidence,
          );
      const canonical = restoreFeatureCheckpoint(checkpoint);
      safeDelete(shape);
      disposeNameTable(names);
      shape = canonical.shape;
      names = canonical.names;
      if (kernelRobustnessEvidence.some((entry) => entry.featureId === feature.id)) {
        kernelRobustnessEvidence = cloneKernelRobustnessEvidence(
          kernelRobustnessEvidence.map((entry) => entry.featureId === feature.id
            ? {
                ...entry,
                resultBrepSha256: studioV5Sha256Hex(canonicalStudioBrepEvidence(rc, shape)),
                resultTopology: {
                  faces: topologyCount(shape, 'face'),
                  edges: topologyCount(shape, 'edge'),
                  vertices: topologyCount(shape, 'vertex'),
                },
              }
            : entry),
        );
        checkpoint.kernelRobustnessEvidence = cloneKernelRobustnessEvidence(kernelRobustnessEvidence);
      }
      if (threadEvidence.some((entry) => entry.featureId === feature.id)) {
        const resultBrepSha256 = studioV5Sha256Hex(canonicalStudioBrepEvidence(rc, shape));
        threadEvidence = cloneThreadEvidence(
          threadEvidence.map((entry) => entry.featureId === feature.id
            ? {
                ...entry,
                ...(entry.mode === 'cosmetic' ? { sourceBrepSha256: resultBrepSha256 } : {}),
                resultBrepSha256,
                resultTopology: assemblyFeatureTopologyEvidence(shape, names),
              }
            : entry),
        );
        checkpoint.threadEvidence = cloneThreadEvidence(threadEvidence);
      }
      featureCheckpoints.push(checkpoint);
    };
    try {
      for (let featureIndex = rebuildPlan.reusablePrefixLength; featureIndex < activeFeatures.length; featureIndex++) {
        const feature = activeFeatures[featureIndex];
        const descriptor = activeFeatureDescriptors[featureIndex];
        currentFeature = feature;
        evaluatedFeatureIds.push(feature.id);
        const policy = feature.resultPolicy;
        const featureContract = assertStudioV5FeatureContract(feature);
        assertStudioV5FeatureStructure(feature);
        if (policy.kind === 'surface') throw new Error('surface results are not supported by this solid feature yet');
        if (policy.kind === 'new-body') {
          if (featureContract.execution === 'body-boolean' || featureContract.execution === 'body-modifier') {
            throw new Error(
              'Feature type "' + feature.type + '" cannot create a new body under its execution contract.',
            );
          }
          let propagatedNames = null;
          const next = feature.type === 'transform'
            ? (() => {
                const source = evaluateBody(feature.sourceBodyId);
                if (!source.shape || source.error) throw new Error('source body "' + feature.sourceBodyId + '" has no valid solid');
                const outcome = applyStudioV5Transform(document, part, feature, source.shape, source.names || []);
                propagatedNames = outcome.names;
                return outcome.shape;
              })()
            : feature.type === 'thicken'
              ? (() => {
                  const source = evaluateBody(feature.sourceBodyId);
                  if (!source.shape || source.error) throw new Error('source body "' + feature.sourceBodyId + '" has no valid face to thicken');
                  const outcome = thickenStudioV5Face(feature, source.shape, N, source.names || []);
                  propagatedNames = outcome.names;
                  return outcome.shape;
                })()
            : feature.type === 'boolean-split-side'
              ? (() => {
                  const source = evaluateBody(feature.sourceBodyId);
                  const toolBodyId = (feature.toolBodyIds || []).find((bodyId) => bodyId !== feature.sourceBodyId);
                  const tool = evaluateBody(toolBodyId);
                  if (!source.shape || source.error || !tool?.shape || tool.error) throw new Error('Boolean Split source or tool has no valid exact solid');
                  if (!boundsOverlap(source.shape, tool.shape)) throw new Error('the splitting tool does not intersect the target body');
                  // A split evaluates two sibling results from the same source
                  // and tool. Cached Replicad wrappers must stay immutable:
                  // OCC Boolean builders may attach mutable operation state to
                  // their operands even though they return a new shape. Give
                  // each side private inputs so evaluating Outside can never
                  // poison the subsequent Inside result or the body cache.
                  // Shape.clone() is a TopoDS partner, not a deep B-rep copy.
                  // Round-trip the bounded exact operands so OCC cannot share
                  // mutable topology between the two sibling Boolean builders.
                  const sourceInput = privateShapeWithNames(source.shape, source.names || []);
                  const toolInput = privateShapeWithNames(tool.shape, tool.names || []);
                  try {
                    if (!topo) return feature.side === 'inside'
                      ? sourceInput.shape.intersect(toolInput.shape)
                      : sourceInput.shape.cut(toolInput.shape);
                    const outcome = topo.booleanWithNames(
                      feature.side === 'inside' ? 'common' : 'cut',
                      sourceInput.shape,
                      toolInput.shape,
                      sourceInput.names,
                      toolInput.names,
                    );
                    propagatedNames = outcome.names;
                    return outcome.shape;
                  } finally {
                    safeDelete(sourceInput.shape);
                    disposeNameTable(sourceInput.names);
                    safeDelete(toolInput.shape);
                    disposeNameTable(toolInput.names);
                  }
                })()
            : feature.type === 'weld-bead'
              ? (() => {
                  const outcome = buildStudioWeldBeadBody(part, feature, N, evaluateBody);
                  propagatedNames = outcome.names;
                  return outcome.shape;
                })()
            : (() => {
                const outcome = studioV5FeatureOutcome(document, part, feature, 0, null, N, NS);
                propagatedNames = outcome.names;
                return outcome.shape;
              })();
          if (!next) throw new Error('the feature produced no solid');
          safeDelete(shape);
          disposeNameTable(names);
          shape = next;
          names = propagatedNames ?? creationNameTable(feature, next, N, part);
        } else if (feature.type === 'boolean') {
          if (!shape) throw new Error('the Boolean target has no valid solid');
          let next = shape;
          let nextNames = names;
          const before = bodyGeometry(shape);
          for (const toolBodyId of feature.toolBodyIds || []) {
            const tool = evaluateBody(toolBodyId);
            if (!tool.shape || tool.error) throw new Error('tool body "' + toolBodyId + '" has no valid solid');
            const operation = feature.operation || policy.kind;
            if ((operation === 'subtract' || operation === 'intersect') && !boundsOverlap(next, tool.shape)) {
              throw new Error('the selected tool does not intersect the target body');
            }
            let operated;
            let operatedNames = [];
            if (topo) {
              const toolInput = privateShapeWithNames(tool.shape, tool.names || []);
              let toolNames = null;
              try {
                toolNames = topo.prefixTable(toolInput.names, 'body:' + toolBodyId + '/');
                const boolKind = operation === 'add' ? 'fuse' : operation === 'intersect' ? 'common' : 'cut';
                const outcome = topo.booleanWithNames(boolKind, next, toolInput.shape, nextNames, toolNames);
                operated = outcome.shape;
                operatedNames = outcome.names;
              } finally {
                disposeNameTable(toolNames);
                safeDelete(toolInput.shape);
                disposeNameTable(toolInput.names);
              }
            } else {
              operated = operation === 'add'
                ? next.fuse(tool.shape)
                : operation === 'intersect'
                  ? next.intersect(tool.shape)
                  : next.cut(tool.shape);
            }
            if (next !== shape) safeDelete(next);
            if (nextNames !== names) disposeNameTable(nextNames);
            next = operated;
            nextNames = operatedNames;
          }
          const after = bodyGeometry(next);
          const abandonBoolean = () => {
            if (next !== shape) safeDelete(next);
            if (nextNames !== names) disposeNameTable(nextNames);
          };
          if (!after.valid) {
            abandonBoolean();
            throw new Error('the Boolean did not produce exactly one valid solid');
          }
          if (policy.kind === 'subtract' && before.volume - after.volume <= Math.max(1e-7, before.volume * 1e-9)) {
            abandonBoolean();
            throw new Error('the selected tool does not intersect the target body');
          }
          if (policy.kind === 'intersect' && after.volume >= before.volume - Math.max(1e-7, before.volume * 1e-9)) {
            abandonBoolean();
            throw new Error('the intersection did not isolate shared material');
          }
          if (next !== shape) safeDelete(shape);
          if (nextNames !== names) disposeNameTable(names);
          shape = next;
          names = nextNames;
        } else {
          if (!shape) throw new Error('target body has no solid before ' + feature.name);
          if (feature.type === 'transform') {
            const transformed = applyStudioV5Transform(document, part, feature, shape, names);
            const geometry = bodyGeometry(transformed.shape);
            if (!geometry.valid) {
              safeDelete(transformed.shape);
              disposeNameTable(transformed.names);
              throw new Error('the transform result is not exactly one valid solid');
            }
            safeDelete(shape);
            disposeNameTable(names);
            names = transformed.names;
            shape = transformed.shape;
            finishFeature(feature, descriptor);
            continue;
          }
          const modified = applyBodyModifier(document, part, feature, shape, N, names, evaluateBody);
          if (modified) {
            if ((modified.shape === shape) !== (modified.names === names)) {
              throw new Error('Body modifier shape and topology ownership must transfer together.');
            }
            if (modified.kernelRobustnessEvidence) {
              kernelRobustnessEvidence = [
                ...kernelRobustnessEvidence.filter((entry) => entry.featureId !== feature.id),
                cloneKernelRobustnessEvidence([modified.kernelRobustnessEvidence])[0],
              ];
            }
            if (modified.threadEvidence) {
              threadEvidence = [
                ...threadEvidence.filter((entry) => entry.featureId !== feature.id),
                cloneThreadEvidence([modified.threadEvidence])[0],
              ];
            }
            if (modified.shape !== shape) safeDelete(shape);
            if (modified.names !== names) disposeNameTable(names);
            shape = modified.shape;
            names = modified.names;
            finishFeature(feature, descriptor);
            continue;
          }
          const toolOutcome = studioV5FeatureOutcome(document, part, feature, topOf(shape), shape, N, NS, names);
          const tool = toolOutcome.shape;
          const toolNames = toolOutcome.names ?? creationNameTable(feature, tool, N, part, shape, names);
          let next;
          let nextNames = [];
          if (topo) {
            const boolKind = policy.kind === 'add' ? 'fuse' : policy.kind === 'intersect' ? 'common' : 'cut';
            const outcome = topo.booleanWithNames(boolKind, shape, tool, names, toolNames);
            next = outcome.shape;
            nextNames = outcome.names;
          } else {
            if (policy.kind === 'add') next = shape.fuse(tool);
            else if (policy.kind === 'intersect') next = shape.intersect(tool);
            else next = shape.cut(tool);
          }
          if (feature.type === 'revolve' && !feature.profileSketchId) {
            try {
              assertCompleteFeatureTopology(next, nextNames, 'Basic Revolve Boolean result');
            } catch (error) {
              safeDelete(next);
              disposeNameTable(nextNames);
              disposeNameTable(toolNames);
              safeDelete(tool);
              throw error;
            }
          }
          disposeNameTable(toolNames);
          const before = bodyGeometry(shape);
          const after = bodyGeometry(next);
          // The tool solid stays alive until the checks below have run: when one
          // fails it is the only thing that can explain why.
          const rejectBoolean = (message) => {
            safeDelete(next);
            disposeNameTable(nextNames);
            safeDelete(tool);
            throw new Error(message);
          };
          if (!after.valid) rejectBoolean('the ' + policy.kind + ' result is not exactly one valid solid');
          if (policy.kind === 'add' && after.solidCount !== 1) rejectBoolean('disconnected additive geometry must use New body');
          if (policy.kind === 'subtract' && before.volume - after.volume <= Math.max(1e-7, before.volume * 1e-9)) {
            rejectBoolean(subtractFailureMessage(tool));
          }
          safeDelete(tool);
          // A patterned cut can succeed overall while single instances land
          // entirely outside the body — the classic silent no-op. Flag them.
          if (policy.kind === 'subtract' && feature.pattern && !feature.onFace) {
            const { missed, count } = patternInstanceMisses(feature, before.bounds, N, NS);
            if (missed > 0) {
              warnings.push({
                severity: 'warning',
                code: 'PATTERN_NO_EFFECT',
                bodyId,
                featureId: feature.id,
                featureType: feature.type,
                message: missed + ' of ' + count + ' pattern instances fall outside the body and remove no material',
              });
            }
          }
          safeDelete(shape);
          disposeNameTable(names);
          shape = next;
          names = nextNames;
        }
        finishFeature(feature, descriptor);
      }
      if (!shape) throw new Error('body history produced no solid');
    } catch (error) {
      failure = {
        bodyId,
        featureId: currentFeature?.id || body.createdByFeatureId,
        featureType: currentFeature?.type || 'body',
        code: featureFailureCode(currentFeature || { type: 'body' }, error),
        ...(Array.isArray(error?.diagnostics)
          ? { diagnostics: structuredClone(error.diagnostics) }
          : {}),
        // The agent protocol surfaces this string verbatim, so it goes through
        // the same translation the UI gets. An agent should never be handed a
        // bare OpenCascade integer.
        message: friendlyError(currentFeature || { type: 'body' }, error),
      };
      errors.push(failure);
    }

    if (failure) {
      safeDelete(shape);
      disposeNameTable(names);
      // A failed history is not renderable geometry. The prior valid entry may
      // remain in the worker's private cache for an exact undo/repair, but it
      // must never become the runtime result for the invalid revision.
      const result = {
        signature,
        shape: null,
        geometry: null,
        body,
        error: failure,
        reused: false,
        lastValid: false,
      };
      results.set(bodyId, result);
      evaluating.delete(bodyId);
      return result;
    }

    const entry = {
      signature,
      shape,
      geometry: bodyGeometry(shape),
      body,
      error: null,
      reused: false,
      lastValid: false,
      names,
      featureCheckpoints,
      kernelRobustnessEvidence,
      threadEvidence,
    };
    results.set(bodyId, entry);
    evaluatedBodyIds.push(bodyId);
    evaluating.delete(bodyId);
    return entry;
  }

  for (const body of part.bodies) evaluateBody(body.id);
  // Boolean tool bodies remain addressable dependencies so suppression,
  // repair, and undo can recover them, but `keepTools: false` must not leave
  // the consumed solid rendered or exported as an independent body.
  const consumedBodyIds = new Map();
  for (const feature of part.features || []) {
    if (feature.suppressed || !enabledFeatureIds.has(feature.id) || feature.type !== 'boolean' || feature.resultPolicy?.keepTools !== false) continue;
    for (const toolBodyId of feature.toolBodyIds || []) consumedBodyIds.set(toolBodyId, feature.id);
  }
  for (const [bodyId, featureId] of consumedBodyIds) {
    const result = results.get(bodyId);
    if (result) result.body = { ...result.body, visible: false, extensions: { ...(result.body.extensions || {}), consumedByFeatureId: featureId } };
  }
  const patternResults = new Map();
  for (const pattern of options.skipBodyPatterns ? [] : (part.bodyPatterns || [])) {
    if (pattern.suppressed) continue;
    let source;
    let sourceTables;
    let placementPlan;
    let variableContract = null;
    let baseSeedBrepSha256 = null;
    const variableSeedEvidence = new Set();
    try {
      source = evaluateBody(pattern.sourceBodyId);
      if (!source?.shape || source.error) throw new Error('source body has no valid exact solid');
      placementPlan = patternPlacementPlan(document, part, pattern, source.shape, N, sketchById);
      variableContract = validateVariablePatternRows(pattern, placementPlan);
      sourceTables = completePatternTopologyTables(source.shape, source.names || []);
      if (pattern.kind === 'variable') {
        baseSeedBrepSha256 = studioV5Sha256Hex(canonicalStudioBrepEvidence(rc, source.shape));
        variableSeedEvidence.add(baseSeedBrepSha256);
      }
    } catch (error) {
      if (sourceTables) patternFeatureHistory.disposeTables(sourceTables);
      const failure = { bodyId: pattern.sourceBodyId, featureId: pattern.id, featureType: 'pattern', code: featureFailureCode({ type: 'pattern' }, error), message: friendlyError({ type: 'pattern' }, error) };
      errors.push(failure);
      // A pattern whose source lacks complete exact topology is not allowed to
      // resurrect stale occurrences from a previous revision. Keep the source
      // body and explicit error, but publish no generated pattern geometry.
      continue;
    }
    const skipped = new Set(pattern.skippedIndices || []);
    const referenceState = (pattern.references || []).map((reference) => {
      if (reference.ownerKind === 'datum') {
        try { return [reference.ownerId, resolveStudioV5Datums(document, part.id).resolve(reference.ownerId)]; }
        catch (error) { return [reference.ownerId, { error: String(error?.message || error) }]; }
      }
      const sketch = sketchById.get(reference.ownerId);
      return [reference.ownerId, sketch];
    });
    if (placementPlan.referenceState) referenceState.push(['resolved-placement', placementPlan.referenceState]);
    const patternParameterState = parameterStateFor({
      definition: pattern.definition,
      references: pattern.references,
      referenceState,
    });
    for (const occurrence of placementPlan.occurrences) {
      const index = occurrence.index;
      if (skipped.has(index)) continue;
      const bodyId = occurrence.bodyId;
      const patternInstance = {
        patternId: pattern.id,
        index,
        sourceBodyId: pattern.sourceBodyId,
        placementKey: occurrence.placementKey,
        ...(occurrence.lattice ? { lattice: [...occurrence.lattice] } : {}),
        ...(occurrence.position !== undefined ? { position: occurrence.position } : {}),
        ...(occurrence.parameterOverrides ? { parameterOverrides: structuredClone(occurrence.parameterOverrides) } : {}),
      };
      const body = {
        id: bodyId,
        name: pattern.name + ' ' + (index + 1),
        kind: source.body.kind,
        visible: pattern.visible !== false && source.body.visible !== false,
        suppressed: false,
        patternInstance,
      };
      const signature = stableSource({
        pattern: { id: pattern.id, kind: pattern.kind, sourceBodyId: pattern.sourceBodyId, references: pattern.references, definition: pattern.definition },
        index,
        placement: occurrence,
        source: source.signature,
        referenceState,
        patternParameterState,
      });
      const cached = cache.get(bodyId);
      const reusableVariable = pattern.kind !== 'variable'
        || (cached?.rendersOwnGeometry === true
          && typeof cached?.seedBrepSha256 === 'string'
          && cached.seedBrepSha256 !== baseSeedBrepSha256
          && !variableSeedEvidence.has(cached.seedBrepSha256));
      if (cached?.signature === signature && cached.shape && cached.patternTables && cached.historyTransforms && reusableVariable) {
        if (pattern.kind === 'variable') {
          variableSeedEvidence.add(cached.seedBrepSha256);
          Object.assign(patternInstance, {
            variableSeedSignature: cached.variantSeedSignature,
            variableSeedBrepSha256: cached.seedBrepSha256,
          });
        }
        patternResults.set(bodyId, { ...cached, body, reused: true, lastValid: false });
        reusedPatternInstanceIds.push(bodyId);
        continue;
      }
      let placementOutcome = null;
      let namedOutcome = null;
      let occurrenceSource = source;
      let occurrenceTables = sourceTables;
      let variableBuild = null;
      let variableTables = null;
      let seedBrepSha256 = null;
      let variantSeedSignature = null;
      try {
        if (pattern.kind === 'variable') {
          variableBuild = await buildVariablePatternSeed(pattern, occurrence, variableContract);
          occurrenceSource = variableBuild.seed;
          variableTables = completePatternTopologyTables(occurrenceSource.shape, occurrenceSource.names || []);
          occurrenceTables = variableTables;
          variantSeedSignature = occurrenceSource.signature;
          seedBrepSha256 = studioV5Sha256Hex(canonicalStudioBrepEvidence(rc, occurrenceSource.shape));
          if (seedBrepSha256 === baseSeedBrepSha256) {
            throw new Error('variable pattern overrides did not change the exact seed B-rep');
          }
          if (variableSeedEvidence.has(seedBrepSha256)) {
            throw new Error('variable pattern rows rebuilt the same exact seed B-rep');
          }
          variableSeedEvidence.add(seedBrepSha256);
          Object.assign(patternInstance, {
            variableSeedSignature: variantSeedSignature,
            variableSeedBrepSha256: seedBrepSha256,
          });
        }
        placementOutcome = patternTransform(
          document,
          part,
          pattern,
          occurrenceSource.shape,
          index,
          N,
          sketchById,
          occurrence,
        );
        namedOutcome = patternFeatureHistory.transformPatternInstance({
          sourceShape: occurrenceSource.shape,
          sourceTables: occurrenceTables,
          featureId: pattern.id,
          instanceId: bodyId,
          transforms: placementOutcome.historyTransforms,
        });
        const shape = namedOutcome.shape;
        const geometry = bodyGeometry(shape);
        if (!geometry.valid) {
          throw new Error('generated occurrence is not exactly one valid solid');
        }
        if (pattern.kind === 'variable') {
          // Variable occurrences publish their own B-rep instead of borrowing
          // the seed mesh. Preserve all three exact topology tables on the
          // serialization face table so display/export cannot derive weaker
          // edge or vertex identity from geometry alone.
          namedOutcome.names.faces.explicitEdgeTable = namedOutcome.names.edges;
          namedOutcome.names.faces.explicitVertexTable = namedOutcome.names.vertices;
        }
        patternResults.set(bodyId, {
          signature, shape, geometry, body, renderTransform: placementOutcome.placement,
          historyTransforms: placementOutcome.historyTransforms,
          names: namedOutcome.names.faces,
          patternTables: namedOutcome.names,
          sharesSourceGeometry: pattern.kind === 'variable'
            ? false
            : shape.wrapped.IsPartner(source.shape.wrapped),
          rendersOwnGeometry: pattern.kind === 'variable',
          ...(pattern.kind === 'variable' ? { seedBrepSha256, variantSeedSignature } : {}),
          error: null, reused: false, lastValid: false,
        });
        namedOutcome = null;
        evaluatedPatternInstanceIds.push(bodyId);
      } catch (error) {
        const failure = { bodyId, featureId: pattern.id, featureType: 'pattern', code: featureFailureCode({ type: 'pattern' }, error), message: 'occurrence ' + index + ': ' + friendlyError({ type: 'pattern' }, error) };
        errors.push(failure);
        patternResults.set(bodyId, {
          signature,
          shape: null,
          geometry: null,
          body,
          error: failure,
          reused: false,
          lastValid: false,
        });
      } finally {
        safeDelete(placementOutcome?.shape);
        if (namedOutcome) patternFeatureHistory.disposeOutcome(namedOutcome);
        if (variableTables) patternFeatureHistory.disposeTables(variableTables);
        if (variableBuild) disposeUncachedV5Build(variableBuild.built);
      }
    }
    if (pattern.outputMode === 'union') {
      const generated = [...patternResults.values()].filter((entry) => entry.body.patternInstance?.patternId === pattern.id && !entry.error && entry.shape);
      let fused = null;
      let fusedTables = null;
      let volumeProbe = null;
      try {
        let silentInstances = 0;
        volumeProbe = rc.deserializeShape(source.shape.serialize());
        for (const entry of generated) {
          const operand = rc.deserializeShape(entry.shape.serialize());
          try {
            const volumeBefore = shapeVolume(volumeProbe);
            const next = volumeProbe.fuse(operand);
            safeDelete(volumeProbe);
            volumeProbe = next;
            // An instance that adds no volume is fully swallowed by the
            // union — silently, unless we say so.
            if (shapeVolume(volumeProbe) - volumeBefore <= Math.max(1e-7, volumeBefore * 1e-9)) silentInstances++;
          } finally {
            safeDelete(operand);
          }
        }
        safeDelete(volumeProbe);
        volumeProbe = null;
        if (silentInstances > 0) {
          warnings.push({
            severity: 'warning',
            code: 'PATTERN_NO_EFFECT',
            bodyId: pattern.id + '-fused',
            featureId: pattern.id,
            featureType: 'pattern',
            message: silentInstances + ' of ' + generated.length + ' pattern instances add no material to the fused result',
          });
        }
        const fusedOutcome = patternFeatureHistory.fusePatternWithHistory({
          sourceShape: source.shape,
          sourceTables,
          featureId: pattern.id,
          instances: [
            { instanceId: patternInstanceId(pattern.id, 0), transforms: [] },
            ...generated.map((entry) => ({
              instanceId: entry.body.id,
              transforms: entry.historyTransforms,
            })),
          ],
        });
        fused = fusedOutcome.shape;
        fusedTables = fusedOutcome.names;
        const geometry = bodyGeometry(fused);
        if (!geometry.valid || geometry.solidCount !== 1) throw new Error('pattern fusion must produce exactly one connected valid solid');
        for (const entry of generated) entry.body.visible = false;
        const bodyId = pattern.id + '-fused';
        const body = {
          id: bodyId, name: pattern.name + ' fused result', kind: source.body.kind,
          visible: pattern.visible !== false && source.body.visible !== false, suppressed: false,
          patternInstance: { patternId: pattern.id, index: 0, sourceBodyId: pattern.sourceBodyId, fused: true },
        };
        patternResults.set(bodyId, {
          signature: stableSource({ pattern, patternParameterState, referenceState, source: source.signature, fused: true }), shape: fused, geometry, body,
          names: fusedTables.faces, patternTables: fusedTables,
          renderTransform: identityMatrix(), sharesSourceGeometry: false, error: null, reused: false, lastValid: false,
        });
        fused = null;
        fusedTables = null;
        evaluatedPatternInstanceIds.push(bodyId);
      } catch (error) {
        const failure = { bodyId: pattern.id + '-fused', featureId: pattern.id, featureType: 'pattern', code: featureFailureCode({ type: 'pattern' }, error), message: friendlyError({ type: 'pattern' }, error) };
        errors.push(failure);
      } finally {
        safeDelete(volumeProbe);
        safeDelete(fused);
        patternFeatureHistory.disposeTables(fusedTables);
      }
    }
    patternFeatureHistory.disposeTables(sourceTables);
  }
  return {
    part,
    results,
    patternResults,
    errors,
    warnings,
    trace: { evaluatedBodyIds, reusedBodyIds, evaluatedFeatureIds, reusedFeatureIds, evaluatedPatternInstanceIds, reusedPatternInstanceIds },
  };
}

function rigidMatrixAxisAngle(matrix) {
  const m00 = matrix[0]; const m01 = matrix[4]; const m02 = matrix[8];
  const m10 = matrix[1]; const m11 = matrix[5]; const m12 = matrix[9];
  const m20 = matrix[2]; const m21 = matrix[6]; const m22 = matrix[10];
  const trace = m00 + m11 + m22;
  let x; let y; let z; let w;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  const magnitude = Math.hypot(x, y, z);
  if (magnitude < 1e-12) return { angle: 0, axis: [0, 0, 1] };
  return { angle: 2 * Math.atan2(magnitude, w) * 180 / Math.PI, axis: [x / magnitude, y / magnitude, z / magnitude] };
}

function applyRigidMatrix(shape, matrix) {
  let next = shape.clone();
  const rotation = rigidMatrixAxisAngle(matrix);
  if (Math.abs(rotation.angle) > 1e-10) next = applyLocatedTransform(next, (transformation) => transformation.rotate(rotation.angle, [0, 0, 0], rotation.axis));
  const translation = [matrix[12], matrix[13], matrix[14]];
  if (Math.hypot(...translation) > 1e-10) next = applyLocatedTransform(next, (transformation) => transformation.translate(translation));
  return next;
}

const STUDIO_V5_STEP_BYTES = 50 * 1024 * 1024;
const STUDIO_V5_STEP_MANIFEST_PREFIX = '/*PARTMODE_V8_MANIFEST:';
const STUDIO_V5_STEP_MANIFEST_SUFFIX = '*/';

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToUtf8(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function stepManifestFromText(text) {
  const start = text.indexOf(STUDIO_V5_STEP_MANIFEST_PREFIX);
  if (start < 0) return null;
  const encodedStart = start + STUDIO_V5_STEP_MANIFEST_PREFIX.length;
  const end = text.indexOf(STUDIO_V5_STEP_MANIFEST_SUFFIX, encodedStart);
  if (end < 0 || end - encodedStart > 8 * 1024 * 1024) throw new Error('PartMode STEP hierarchy manifest is invalid or too large');
  const manifest = JSON.parse(base64ToUtf8(text.slice(encodedStart, end)));
  if (manifest?.format !== 'partmode-v8-step-assembly-1' || manifest.units !== 'mm') throw new Error('PartMode STEP hierarchy manifest is unsupported');
  return manifest;
}

async function withStepManifest(blob, manifest) {
  const text = await blob.text();
  const marker = STUDIO_V5_STEP_MANIFEST_PREFIX + utf8ToBase64(JSON.stringify(manifest)) + STUDIO_V5_STEP_MANIFEST_SUFFIX;
  const insertion = text.indexOf('\n');
  const next = insertion < 0 ? text + '\n' + marker : text.slice(0, insertion + 1) + marker + '\n' + text.slice(insertion + 1);
  return new Blob([next], { type: 'application/STEP' });
}

function ocExtendedString(oc, value) {
  return new oc.TCollection_ExtendedString_2(String(value || 'Unnamed'), true);
}

function ocLocationFromMatrix(oc, matrix) {
  const transform = new oc.gp_Trsf_1();
  transform.SetValues(
    matrix[0], matrix[4], matrix[8], matrix[12],
    matrix[1], matrix[5], matrix[9], matrix[13],
    matrix[2], matrix[6], matrix[10], matrix[14],
  );
  const location = new oc.TopLoc_Location_2(transform);
  transform.delete();
  return location;
}

function setOcLabelName(oc, label, name) {
  const wrapped = ocExtendedString(oc, name);
  oc.TDataStd_Name.Set_1(label, wrapped);
  wrapped.delete();
}

function setOcLabelColor(oc, colorTool, label, color) {
  const source = String(color || '#a7b8c9').replace(/^#/, '');
  const hex = source.length === 3 ? source.replace(/(.)/g, '$1$1') : source.padEnd(6, '0').slice(0, 6);
  const rgba = new oc.Quantity_ColorRGBA_5(
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
    1,
  );
  colorTool.SetColor_3(label, rgba, oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
  rgba.delete();
}

function writeXcafStep(oc, document) {
  // The default writer owns its work session. Keeping that lifetime inside a
  // single wrapper avoids dangling Handle_XSControl_WorkSession instances in
  // the long-lived WASM worker after repeated export/import cycles.
  const writer = new oc.STEPCAFControl_Writer_1();
  oc.Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
  oc.Interface_Static.SetCVal('write.step.unit', 'MM');
  writer.SetColorMode(true);
  writer.SetLayerMode(true);
  writer.SetNameMode(true);
  oc.Interface_Static.SetIVal('write.surfacecurve.mode', true);
  oc.Interface_Static.SetIVal('write.precision.mode', 0);
  oc.Interface_Static.SetIVal('write.step.assembly', 2);
  // AP214 preserves names, colors, and hierarchy while remaining stable in
  // the browser STEPControl reader across repeated import/re-export cycles.
  oc.Interface_Static.SetIVal('write.step.schema', 4);
  const progress = new oc.Message_ProgressRange_1();
  const documentHandle = new oc.Handle_TDocStd_Document_2(document);
  writer.Transfer_1(documentHandle, oc.STEPControl_StepModelType.STEPControl_AsIs, null, progress);
  documentHandle.delete(); progress.delete();
  const filename = 'partmode-assembly-export.step';
  const status = writer.Write(filename);
  writer.delete();
  if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('Structured STEP export failed');
  const file = oc.FS.readFile('/' + filename);
  oc.FS.unlink('/' + filename);
  return new Blob([file], { type: 'application/STEP' });
}

function sourcePatternOccurrenceTransform(solution, leaf) {
  if (leaf.definition.kind === 'part') return leaf.transform;
  const sourceId = leaf.sourceOccurrenceId;
  const child = solution.subassemblies.get(sourceId);
  const childLeaf = child?.leafOccurrences.find((entry) => !entry.patternInstance && entry.occurrencePath.join('/') === leaf.occurrencePath.slice(1).join('/'))
    || child?.leafOccurrences.find((entry) => !entry.patternInstance);
  if (!childLeaf) throw new Error('Cannot resolve patterned subassembly placement');
  return studioV5MultiplyMatrices(leaf.transform, studioV5RigidInverse(childLeaf.transform));
}

function createStructuredAssemblyStep(document, built, selected) {
  const oc = rc.getOC();
  const documentType = ocExtendedString(oc, 'XmlOcaf');
  const xcafDocument = new oc.TDocStd_Document(documentType);
  documentType.delete();
  oc.XCAFDoc_ShapeTool.SetAutoNaming(false);
  const mainLabel = xcafDocument.Main();
  const shapeToolHandle = oc.XCAFDoc_DocumentTool.ShapeTool(mainLabel);
  const shapeTool = shapeToolHandle.get();
  const colorToolHandle = oc.XCAFDoc_DocumentTool.ColorTool(mainLabel);
  const colorTool = colorToolHandle.get();
  const selectedKeys = new Set(selected.map((runtime) => runtime.sourceKey));
  const bodyLabels = new Map();
  const partLabels = new Map();
  const assemblyLabels = new Map();
  const manifestParts = [];
  const manifestAssemblies = [];
  const selectedPaths = selected.map((runtime) => runtime.occurrenceInstance.occurrencePath);
  const pathStartsWith = (path, prefix) => prefix.every((id, index) => path[index] === id);
  const contextsByAssembly = new Map([[built.solution.assembly.id, [[]]]]);
  const contextQueue = [built.solution.assembly.id];
  while (contextQueue.length) {
    const assemblyId = contextQueue.shift();
    const assembly = (document.assemblyDefinitions || []).find((entry) => entry.id === assemblyId);
    const contexts = contextsByAssembly.get(assemblyId) || [];
    for (const occurrence of assembly?.occurrences || []) {
      if (occurrence.suppressed || occurrence.definition.kind !== 'assembly') continue;
      const childContexts = contexts
        .map((prefix) => [...prefix, occurrence.id])
        .filter((prefix) => selectedPaths.some((path) => pathStartsWith(path, prefix)));
      if (!childContexts.length) continue;
      const childId = occurrence.definition.assemblyId;
      const existing = contextsByAssembly.get(childId) || [];
      const additions = childContexts.filter((prefix) => !existing.some((entry) => entry.join('/') === prefix.join('/')));
      if (additions.length) {
        contextsByAssembly.set(childId, [...existing, ...additions]);
        contextQueue.push(childId);
      }
    }
  }

  try {
    for (const [variantKey, partBuild] of built.partBuilds) {
      const part = partBuild.part;
      const localResults = [
        ...part.bodies.map((body) => ({ body, result: partBuild.results.get(body.id) })),
        ...[...partBuild.patternResults.values()].map((result) => ({ body: result.body, result })),
      ].filter(({ body, result }) => selectedKeys.has(variantKey + ':' + body.id) && result?.shape && result.geometry?.valid);
      if (!localResults.length) continue;
      const partLabel = shapeTool.NewShape();
      setOcLabelName(oc, partLabel, part.name);
      partLabels.set(variantKey, partLabel);
      const manifestBodies = [];
      for (const { body, result } of localResults) {
        const definitionLabel = shapeTool.AddShape(result.shape.wrapped, false, false);
        setOcLabelName(oc, definitionLabel, body.name);
        const material = body.materialId ? document.materials?.find((entry) => entry.id === body.materialId) : null;
        const appearance = document.materials?.find((entry) => entry.appearanceId === (body.appearanceId || material?.appearanceId))?.extensions?.studioAppearance;
        setOcLabelColor(oc, colorTool, definitionLabel, appearance?.baseColor || '#a7b8c9');
        bodyLabels.set(variantKey + ':' + body.id, definitionLabel);
        const location = ocLocationFromMatrix(oc, assemblyIdentityMatrix());
        const componentLabel = shapeTool.AddComponent_1(partLabel, definitionLabel, location);
        setOcLabelName(oc, componentLabel, body.name);
        location.delete();
        manifestBodies.push({ id: body.id, name: body.name, kind: body.kind, visible: body.visible !== false, materialId: body.materialId || null, appearanceId: body.appearanceId || null });
      }
      if (manifestBodies.length) manifestParts.push({
        id: partBuild.variantId,
        definitionPartId: partBuild.sourcePartId,
        name: part.name,
        parameterOverrides: partBuild.parameterOverrides,
        bodies: manifestBodies,
      });
    }

    for (const assembly of document.assemblyDefinitions || []) {
      if (!contextsByAssembly.has(assembly.id)) continue;
      const label = shapeTool.NewShape();
      setOcLabelName(oc, label, assembly.name);
      assemblyLabels.set(assembly.id, label);
    }
    const solutions = collectAssemblySolutions(built.solution);
    for (const assembly of document.assemblyDefinitions || []) {
      const solution = solutions.get(assembly.id);
      if (!solution) continue;
      const parentLabel = assemblyLabels.get(assembly.id);
      const contexts = contextsByAssembly.get(assembly.id) || [];
      const occurrences = [];
      for (const occurrence of assembly.occurrences) {
        if (occurrence.suppressed) continue;
        if (!contexts.some((prefix) => selectedPaths.some((path) => pathStartsWith(path, [...prefix, occurrence.id])))) continue;
        const definitionLabel = occurrence.definition.kind === 'part'
          ? partLabels.get(exactPartVariantKey(occurrence.definition.partId, occurrence.parameterOverrides || {}))
          : assemblyLabels.get(occurrence.definition.assemblyId);
        if (!definitionLabel) continue;
        const transform = solution.transforms.get(occurrence.id);
        const location = ocLocationFromMatrix(oc, transform);
        const componentLabel = shapeTool.AddComponent_1(parentLabel, definitionLabel, location);
        setOcLabelName(oc, componentLabel, occurrence.name);
        location.delete();
        occurrences.push({
          id: occurrence.id, name: occurrence.name,
          definition: occurrence.definition.kind === 'part'
            ? { kind: 'part', partId: publicPartVariantId(occurrence.definition.partId, occurrence.parameterOverrides || {}) }
            : occurrence.definition,
          transform, visible: occurrence.visible !== false, extensions: { importedFromStep: true },
        });
      }
      const generatedTopIds = new Set();
      for (const leaf of solution.leafOccurrences.filter((entry) => entry.patternInstance)) {
        const topId = leaf.occurrencePath[0];
        if (generatedTopIds.has(topId)) continue;
        if (!contexts.some((prefix) => selectedPaths.some((path) => pathStartsWith(path, [...prefix, topId])))) continue;
        generatedTopIds.add(topId);
        const source = assembly.occurrences.find((entry) => entry.id === leaf.sourceOccurrenceId);
        const definitionLabel = source?.definition.kind === 'part'
          ? partLabels.get(exactPartVariantKey(source.definition.partId, source.parameterOverrides || {}))
          : assemblyLabels.get(source?.definition.assemblyId);
        if (!source || !definitionLabel) continue;
        const transform = source.definition.kind === 'part' ? leaf.transform : sourcePatternOccurrenceTransform(solution, leaf);
        const name = leaf.name.split(' / ')[0];
        const location = ocLocationFromMatrix(oc, transform);
        const componentLabel = shapeTool.AddComponent_1(parentLabel, definitionLabel, location);
        setOcLabelName(oc, componentLabel, name);
        location.delete();
        occurrences.push({
          id: topId, name,
          definition: source.definition.kind === 'part'
            ? { kind: 'part', partId: publicPartVariantId(source.definition.partId, source.parameterOverrides || {}) }
            : source.definition,
          transform,
          visible: source.visible !== false, extensions: { importedFromStep: true, sourcePatternId: leaf.patternInstance.patternId },
        });
      }
      manifestAssemblies.push({ id: assembly.id, name: assembly.name, occurrences });
    }
    shapeTool.UpdateAssemblies();
    const blob = writeXcafStep(oc, xcafDocument);
    const bodyInstances = selected.map((runtime) => ({
      bodyId: runtime.bodyId,
      partId: runtime.occurrenceInstance.variantId,
      definitionPartId: runtime.occurrenceInstance.definition.partId,
      localBodyId: runtime.localBodyId,
      name: runtime.bodyName,
      occurrencePath: runtime.occurrenceInstance.occurrencePath,
      transform: runtime.exactPlacement,
      bounds: runtime.geometry?.bounds || null,
      volume: runtime.geometry?.volume ?? null,
    }));
    return {
      blob,
      manifest: {
        format: 'partmode-v8-step-assembly-1', schemaVersion: 5, units: 'mm', sourceUnits: document.units,
        projectName: document.name, rootAssemblyId: built.solution.assembly.id,
        parts: manifestParts, assemblies: manifestAssemblies, bodyInstances, materials: structuredClone(document.materials || []),
        limitations: ['exact-brep-and-solved-hierarchy-only', 'no-parametric-feature-history', 'no-mate-recovery'],
      },
    };
  } finally {
    safeDelete(colorToolHandle);
    safeDelete(shapeToolHandle);
    safeDelete(xcafDocument);
  }
}

function collectAssemblySolutions(solution, target = new Map()) {
  target.set(solution.assembly.id, solution);
  for (const child of solution.subassemblies.values()) collectAssemblySolutions(child, target);
  return target;
}

function assemblySolutionCacheKey(document) {
  return String(document?.projectId || '') + '|' + studioV5CanonicalHash(document);
}

function previousAssemblySolutionsFor(document) {
  return currentAssemblySolutionKey === assemblySolutionCacheKey(document)
    ? currentAssemblySolutions
    : new Map();
}

function assignAssemblyVariantIdentity(solution) {
  for (const occurrence of solution.leafOccurrences) {
    const partId = occurrence.definition.partId;
    const parameterOverrides = occurrence.parameterOverrides || {};
    occurrence.variantKey = exactPartVariantKey(partId, parameterOverrides);
    occurrence.variantId = publicPartVariantId(partId, parameterOverrides);
  }
  return solution;
}

function resolveCurrentExactNamedFace(result, persistentName, expectedTopologyKind = null) {
  if (!result?.shape || result.error || result.lastValid || result.geometry?.valid !== true
    || result.geometry?.brepValid !== true || result.geometry?.solidCount !== 1) {
    throw new Error('persistent face owner has no current valid one-solid OCCT result');
  }
  if (!topo) throw new Error('persistent exact topology resolver is unavailable');
  const lookups = topo.nameLookups(result.shape, result.names || []);
  try {
    const matches = lookups.faceCandidates.filter((candidate) => lookups.getFaceName(candidate) === persistentName);
    if (matches.length !== 1) {
      throw new Error('persistent face "' + persistentName + '" resolves to ' + matches.length + ' current exact faces');
    }
    const signature = exactAnalyticFaceSignature(matches[0]);
    if (expectedTopologyKind && signature.topologyKind !== expectedTopologyKind) {
      throw new Error('persistent face "' + persistentName + '" changed analytic topology kind');
    }
    return { signature, faceName: persistentName };
  } finally {
    lookups.dispose();
  }
}

function currentExactAssemblyBodyReferenceResolver(partBuilds) {
  return ({ reference, occurrence, part }) => {
    const persistentName = reference?.semanticPath?.name;
    if (typeof persistentName !== 'string' || !persistentName) {
      throw new Error('named mate topology requires one non-empty persistent face name');
    }
    const variantKey = exactPartVariantKey(part.id, occurrence?.parameterOverrides || {});
    const built = partBuilds.get(variantKey);
    const result = built?.results.get(reference.ownerId) || built?.patternResults.get(reference.ownerId);
    const expected = reference.semanticPath?.topologyKind;
    const resolved = resolveCurrentExactNamedFace(
      result,
      persistentName,
      expected && expected !== 'face' ? expected : null,
    );
    const signature = resolved.signature;
    if (!['planar-face', 'cylindrical-face', 'conical-face', 'spherical-face'].includes(signature.topologyKind)) {
      throw new Error('persistent mate face "' + persistentName + '" is not a supported current analytic face');
    }
    {
      const expected = reference.semanticPath?.topologyKind;
      if (expected && expected !== 'face' && expected !== signature.topologyKind) {
        throw new Error('persistent mate face "' + persistentName + '" changed analytic topology kind');
      }
      return signature;
    }
  };
}

function assemblyFeatureRuntimeTarget(runtimeBodies, target, label) {
  const matches = runtimeBodies.filter((runtime) =>
    runtime.occurrenceInstance?.occurrencePath?.length === 1
    && runtime.occurrenceInstance.occurrencePath[0] === target.occurrenceId
    && runtime.occurrenceInstance.occurrenceId === target.occurrenceId
    && runtime.occurrenceInstance.definition?.kind === 'part'
    && runtime.occurrenceInstance.definition.partId === target.partId
    && runtime.localBodyId === target.bodyId
    && !runtime.patternInstance);
  if (matches.length !== 1) {
    throw new Error(label + ' must resolve to exactly one current direct occurrence body.');
  }
  const runtime = matches[0];
  if (!runtime.exactShape || !runtime.exactNames || runtime.error || runtime.lastValid
      || runtime.suppressed || runtime.kind !== 'solid'
      || runtime.geometry?.valid !== true || runtime.geometry?.brepValid !== true
      || runtime.geometry?.solidCount !== 1) {
    throw new Error(label + ' has no current non-last-valid one-solid OCCT result.');
  }
  return runtime;
}

function assemblyFeatureHoleTool(feature, origin, direction, xDirection, extent) {
  if (!topo) throw new Error('Persistent topology naming is unavailable for assembly holes.');
  const frame = weldmentPlaneAxes(direction, xDirection);
  const radius = feature.definition.diameter / 2;
  let plane = null;
  let shape = null;
  let names = null;
  try {
    plane = new rc.Plane(origin, frame.xDirection, frame.normal);
    shape = rc.drawSingleCircle(radius).sketchOnPlane(plane).extrude(extent);
    const { add, multiply } = studioV5VectorMath;
    const toWorld = ([x, y]) => add(origin, add(
      multiply(frame.xDirection, x),
      multiply(frame.yDirection, y),
    ));
    names = topo.creationNamesForSweep(shape, {
      featureId: feature.id,
      entities: [{
        kind: 'circle',
        id: 'assembly-hole-circle',
        center2: [0, 0],
        radius,
      }],
      toWorld,
      sweepDirection: frame.normal,
      capOffsets: [0, extent],
    });
    const geometry = bodyGeometry(shape);
    if (!geometry.valid) throw new Error('Assembly hole tool is not exactly one valid solid.');
    assertCompleteFeatureTopology(shape, names, 'Assembly hole ' + feature.id + ' tool');
    const result = { shape, names };
    shape = null;
    names = null;
    return result;
  } finally {
    safeDelete(shape);
    disposeNameTable(names);
    safeDelete(plane);
  }
}

function assemblyFeatureTool(feature, origin, direction, xDirection, extent) {
  if (feature.kind === 'hole') {
    return assemblyFeatureHoleTool(feature, origin, direction, xDirection, extent);
  }
  const halfWidth = feature.definition.width / 2;
  const halfHeight = feature.definition.height / 2;
  return weldmentPrismOutcome({
    featureId: feature.id,
    profileId: 'assembly-cut-rectangle',
    points: [
      [-halfWidth, -halfHeight],
      [halfWidth, -halfHeight],
      [halfWidth, halfHeight],
      [-halfWidth, halfHeight],
    ],
    entityIds: ['assembly-cut-bottom', 'assembly-cut-right', 'assembly-cut-top', 'assembly-cut-left'],
    origin,
    xDirection,
    normal: direction,
    extent,
  });
}

function assemblyFeatureTopologyEvidence(shape, names) {
  const topology = drawingTopologyEvidence(shape, names);
  const { counts } = topology;
  if (topology.diagnostics.some((entry) => entry?.severity === 'error')
      || counts.faces !== counts.namedFaces
      || counts.edges !== counts.namedEdges
      || counts.vertices !== counts.namedVertices) {
    throw new Error('Assembly feature result does not have complete current face, edge, and vertex identity.');
  }
  const persistentNames = {
    faces: topology.faces.map((entry) => entry.name).sort(),
    edges: topology.edges.map((entry) => entry.name).sort(),
    vertices: topology.vertices.map((entry) => entry.name).sort(),
  };
  return {
    counts,
    persistentNames,
    persistentNamesSha256: studioV5Sha256Hex(JSON.stringify(persistentNames)),
  };
}

function assemblyFeatureWorldSpan(feature, runtimes) {
  const { dot, subtract, add, multiply } = studioV5VectorMath;
  const projections = [];
  for (const runtime of runtimes) {
    const bounds = runtime.geometry?.bounds;
    if (!Array.isArray(bounds) || bounds.length !== 2) {
      throw new Error('Assembly feature target has no current exact world bounds.');
    }
    for (const corner of weldmentBoundsCorners(bounds)) {
      projections.push(dot(subtract(corner, feature.placement.origin), feature.placement.direction));
    }
  }
  const minimum = Math.min(...projections);
  const maximum = Math.max(...projections);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || !(maximum > minimum)) {
    throw new Error('Assembly feature through-all span cannot be derived from its current targets.');
  }
  const margin = Math.max(1, (maximum - minimum) * 0.05);
  const startOffset = minimum - margin;
  const endOffset = maximum + margin;
  return {
    startOffset,
    endOffset,
    extent: endOffset - startOffset,
    start: add(feature.placement.origin, multiply(feature.placement.direction, startOffset)),
  };
}

function assemblyFeatureLocalFrame(runtime, feature, worldStart) {
  const inverse = studioV5RigidInverse(runtime.exactPlacement);
  const direction = weldmentUnit(
    studioV5TransformVector(inverse, feature.placement.direction),
    'Assembly feature local direction',
  );
  const authoredX = weldmentUnit(
    studioV5TransformVector(inverse, feature.placement.xDirection),
    'Assembly feature local x direction',
  );
  const projection = studioV5VectorMath.dot(authoredX, direction);
  const xDirection = weldmentUnit(
    studioV5VectorMath.subtract(authoredX, studioV5VectorMath.multiply(direction, projection)),
    'Assembly feature local transverse direction',
  );
  return {
    origin: studioV5TransformPoint(inverse, worldStart),
    direction,
    xDirection,
  };
}

function disposeAssemblyFeatureCandidates(candidates) {
  for (const candidate of candidates.values()) {
    safeDelete(candidate.shape);
    disposeNameTable(candidate.names);
    candidate.shape = null;
    candidate.names = null;
  }
}

function applyStudioAssemblyFeatures(document, solution, runtimeBodies, effectiveDocumentHash) {
  const store = solution.assembly.extensions?.assemblyFeatures;
  const features = store?.features || [];
  const candidates = new Map();
  const featureEvidence = [];
  let activeFeatureId = null;
  try {
    for (const feature of features) {
      activeFeatureId = feature.id;
      if (feature.suppressed) {
        featureEvidence.push({
          featureId: feature.id,
          name: feature.name,
          kind: feature.kind,
          status: 'suppressed',
          targets: [],
        });
        continue;
      }
      const resolved = feature.targets.map((target, index) => ({
        target,
        runtime: assemblyFeatureRuntimeTarget(
          runtimeBodies,
          target,
          'Assembly feature "' + feature.id + '" target ' + (index + 1),
        ),
      }));
      const span = assemblyFeatureWorldSpan(feature, resolved.map((entry) => entry.runtime));
      const targetEvidence = [];
      for (const { target, runtime } of resolved) {
        let candidate = candidates.get(runtime.bodyId);
        if (!candidate) {
          const copied = privateShapeWithNames(runtime.exactShape, runtime.exactNames);
          candidate = {
            runtime,
            shape: copied.shape,
            names: copied.names,
            appliedFeatureIds: [],
          };
          candidates.set(runtime.bodyId, candidate);
        }
        const beforeGeometry = bodyGeometry(candidate.shape);
        if (!beforeGeometry.valid) {
          throw new Error('Assembly feature target private input is not exactly one valid solid.');
        }
        const beforeBrepSha256 = studioV5Sha256Hex(canonicalStudioBrepEvidence(rc, candidate.shape));
        const frame = assemblyFeatureLocalFrame(runtime, feature, span.start);
        let tool = null;
        let outcome = null;
        try {
          tool = assemblyFeatureTool(feature, frame.origin, frame.direction, frame.xDirection, span.extent);
          outcome = topo.booleanWithNames('cut', candidate.shape, tool.shape, candidate.names, tool.names);
          const afterGeometry = bodyGeometry(outcome.shape);
          const removedVolume = beforeGeometry.volume - afterGeometry.volume;
          const tolerance = Math.max(1e-7, Math.abs(beforeGeometry.volume) * 1e-9);
          if (!afterGeometry.valid) {
            throw new Error('Assembly feature did not produce exactly one valid solid.');
          }
          if (!(removedVolume > tolerance)) {
            throw new Error('Assembly feature does not intersect every selected target with positive exact removed volume.');
          }
          assertCompleteFeatureTopology(
            outcome.shape,
            outcome.names,
            'Assembly ' + feature.kind + ' ' + feature.id + ' target ' + runtime.bodyId,
          );
          const afterBrepSha256 = studioV5Sha256Hex(canonicalStudioBrepEvidence(rc, outcome.shape));
          const topologyEvidence = assemblyFeatureTopologyEvidence(outcome.shape, outcome.names);
          targetEvidence.push({
            occurrenceId: target.occurrenceId,
            occurrencePath: [target.occurrenceId],
            partId: target.partId,
            bodyId: target.bodyId,
            runtimeBodyId: runtime.bodyId,
            exactPlacement: structuredClone(runtime.exactPlacement),
            inputBrepSha256: beforeBrepSha256,
            resultBrepSha256: afterBrepSha256,
            inputVolumeMm3: beforeGeometry.volume,
            resultVolumeMm3: afterGeometry.volume,
            removedVolumeMm3: removedVolume,
            topology: topologyEvidence,
          });
          safeDelete(candidate.shape);
          disposeNameTable(candidate.names);
          candidate.shape = outcome.shape;
          candidate.names = outcome.names;
          candidate.appliedFeatureIds.push(feature.id);
          outcome = null;
        } finally {
          if (outcome) {
            safeDelete(outcome.shape);
            disposeNameTable(outcome.names);
          }
          if (tool) {
            safeDelete(tool.shape);
            disposeNameTable(tool.names);
          }
        }
      }
      featureEvidence.push({
        featureId: feature.id,
        name: feature.name,
        kind: feature.kind,
        status: 'applied',
        placement: structuredClone(feature.placement),
        definition: structuredClone(feature.definition),
        throughAll: {
          startOffsetMm: span.startOffset,
          endOffsetMm: span.endOffset,
          extentMm: span.extent,
        },
        targets: targetEvidence,
      });
    }

    // Final validation is a separate pass. No runtime pointer changes until
    // every candidate has current B-rep, geometry, and complete topology
    // evidence, so a late failure cannot leak a partially applied feature.
    for (const candidate of candidates.values()) {
      const runtime = candidate.runtime;
      const localGeometry = bodyGeometry(candidate.shape);
      const resultBrepSha256 = studioV5Sha256Hex(canonicalStudioBrepEvidence(rc, candidate.shape));
      const worldGeometry = {
        ...localGeometry,
        bounds: studioV5TransformBounds(localGeometry.bounds, runtime.exactPlacement),
        centerOfMass: studioV5TransformPoint(runtime.exactPlacement, localGeometry.centerOfMass),
      };
      candidate.final = {
        localGeometry,
        worldGeometry,
        resultBrepSha256,
        topology: assemblyFeatureTopologyEvidence(candidate.shape, candidate.names),
      };
    }

    const ownedRuntimeResults = [];
    const resultBodies = [];
    for (const candidate of candidates.values()) {
      const runtime = candidate.runtime;
      const { localGeometry, worldGeometry, resultBrepSha256, topology } = candidate.final;
      const result = {
        body: runtime.exactResult?.body || null,
        shape: candidate.shape,
        names: candidate.names,
        geometry: localGeometry,
        error: null,
        reused: false,
        lastValid: false,
      };
      runtime.exactShape = candidate.shape;
      runtime.exactNames = candidate.names;
      runtime.exactResult = result;
      runtime.renderShape = candidate.shape;
      runtime.renderNames = candidate.names;
      runtime.renderTransform = runtime.exactPlacement;
      runtime.geometry = worldGeometry;
      runtime.error = null;
      runtime.reused = false;
      runtime.lastValid = false;
      runtime.assemblyFeatureIds = [...candidate.appliedFeatureIds];
      runtime.sourceKey = runtime.sourceKey + ':assembly-feature:'
        + runtime.occurrenceInstance.occurrenceId + ':' + resultBrepSha256;
      ownedRuntimeResults.push({ shape: candidate.shape, names: candidate.names });
      resultBodies.push({
        runtimeBodyId: runtime.bodyId,
        occurrenceId: runtime.occurrenceInstance.occurrenceId,
        occurrencePath: structuredClone(runtime.occurrenceInstance.occurrencePath),
        partId: runtime.occurrenceInstance.definition.partId,
        bodyId: runtime.localBodyId,
        featureIds: [...candidate.appliedFeatureIds],
        resultBrepSha256,
        volumeMm3: localGeometry.volume,
        topology,
      });
      candidate.shape = null;
      candidate.names = null;
    }
    return {
      ownedRuntimeResults,
      evidence: {
        schema: STUDIO_ASSEMBLY_FEATURE_EVIDENCE_SCHEMA,
        documentHash: effectiveDocumentHash,
        assemblyId: solution.assembly.id,
        occurrenceScope: 'direct-root-part-occurrences',
        operation: 'ordered-private-per-occurrence-occt-cut',
        atomic: true,
        features: featureEvidence,
        resultBodies,
      },
    };
  } catch (error) {
    disposeAssemblyFeatureCandidates(candidates);
    throw codedFeatureError(
      'ASSEMBLY_FEATURE_KERNEL_REFUSED',
      String(error?.message || error) + ' No assembly feature geometry or success evidence was published.',
      {
        featureId: activeFeatureId,
        causeCode: typeof error?.code === 'string' ? error.code : null,
      },
    );
  }
}

async function buildV5Assembly(document, options = {}) {
  await loadKernel();
  if (document.rootDocument?.kind !== 'assembly') throw new Error('This worker request requires a schema-5 assembly document.');
  // Reject malformed Smart Fastener ownership before either the enumeration
  // pass or the authoritative exact solve. In particular, two generated
  // stacks may never claim the same occurrence/body/feature target.
  assertStudioSmartFastenersProject(document);
  assertStudioAssemblyFeaturesProject(document);
  const effectiveDocumentHash = studioV5CanonicalHash(document);
  // The first pass is deliberately non-authoritative: it only expands the
  // hierarchy far enough to enumerate unique part variants. Named topology is
  // never trusted from the authored mate signature during this pass.
  const provisionalSolution = assignAssemblyVariantIdentity(solveStudioV5Assembly(
    document,
    document.rootDocument.assemblyId,
    { enumerateOnly: true, previousByAssembly: new Map() },
  ));
  const partBuilds = new Map();
  const publicVariantSources = new Map();
  const cacheView = (cache, variantKey) => {
    const view = new Map();
    const prefix = variantKey + ':';
    for (const [key, value] of cache || []) if (String(key).startsWith(prefix)) view.set(String(key).slice(prefix.length), value);
    return view;
  };
  for (const occurrence of provisionalSolution.leafOccurrences) {
    const partId = occurrence.definition.partId;
    const parameterOverrides = occurrence.parameterOverrides || {};
    const variantKey = exactPartVariantKey(partId, parameterOverrides);
    const variantId = publicPartVariantId(partId, parameterOverrides);
    const priorVariantSource = publicVariantSources.get(variantId);
    if (priorVariantSource && priorVariantSource !== variantKey) {
      throw new Error('Component parameter variants collide on the bounded public id; the assembly was not evaluated.');
    }
    publicVariantSources.set(variantId, variantKey);
    occurrence.variantKey = variantKey;
    occurrence.variantId = variantId;
    if (partBuilds.has(variantKey)) continue;
    // The canonical assembly has many reusable definitions but only a small
    // number of actual parameter variants. Cloning the complete project once
    // per ordinary (non-overridden) definition added avoidable latency to
    // every edit. Exact document evaluation is read-only, so share the
    // canonical document unless this variant genuinely needs an isolated
    // parameter patch.
    const variantDocument = Object.keys(parameterOverrides).length ? structuredClone(document) : document;
    if (variantDocument !== document) {
      const variantPart = variantDocument.partDefinitions.find((entry) => entry.id === partId);
      for (const [name, value] of Object.entries(parameterOverrides)) {
        const parameter = variantPart?.parameters?.find((entry) => entry.name === name);
        if (!parameter) throw new Error('Component variant parameter "' + name + '" no longer exists in part "' + partId + '".');
        parameter.value = value;
      }
    }
    const built = await buildV5Document(variantDocument, {
      ...options,
      partId,
      cache: cacheView(options.cache, variantKey),
      previousCache: cacheView(options.previousCache, variantKey),
    });
    built.variantKey = variantKey;
    built.variantId = variantId;
    built.sourcePartId = partId;
    built.parameterOverrides = structuredClone(parameterOverrides);
    partBuilds.set(variantKey, built);
  }
  // This is the only authoritative assembly solve. Every persistent named
  // body reference is re-resolved one-to-one against the just-built variant's
  // current OCCT name table and its analytic frame is recomputed from that
  // exact face. Resolver failures enter the normal mate error channel.
  const solution = assignAssemblyVariantIdentity(solveStudioV5Assembly(
    document,
    document.rootDocument.assemblyId,
    {
      previousByAssembly: options.previousSolutions || new Map(),
      resolveBodyReference: currentExactAssemblyBodyReferenceResolver(partBuilds),
    },
  ));
  const runtimeBodies = [];
  const errors = solution.errors.map((error) => ({ ...error, featureType: 'mate' }));
  for (const occurrence of solution.leafOccurrences) {
    const built = partBuilds.get(occurrence.variantKey);
    for (const body of built.part.bodies) {
      const result = built.results.get(body.id);
      const runtimeBody = result?.body || body;
      const bodyId = occurrence.id + ':' + body.id;
      const geometry = result?.geometry ? {
        ...result.geometry,
        bounds: studioV5TransformBounds(result.geometry.bounds, occurrence.transform),
        centerOfMass: result.geometry.centerOfMass ? studioV5TransformPoint(occurrence.transform, result.geometry.centerOfMass) : null,
      } : null;
      const error = result?.error ? { ...result.error, bodyId, occurrencePath: occurrence.occurrencePath } : null;
      if (error) errors.push(error);
      runtimeBodies.push({
        bodyId,
        localBodyId: body.id,
        bodyName: occurrence.name + ' / ' + runtimeBody.name,
        kind: runtimeBody.kind,
        visible: occurrence.visible && runtimeBody.visible,
        suppressed: occurrence.suppressed || runtimeBody.suppressed,
        consumed: Boolean(runtimeBody.extensions?.consumedByFeatureId),
        occurrenceInstance: {
          occurrenceId: occurrence.id,
          occurrencePath: occurrence.occurrencePath,
          definition: occurrence.definition,
          parameterOverrides: occurrence.parameterOverrides || {},
          variantKey: occurrence.variantKey,
          variantId: occurrence.variantId,
          sourceOccurrenceId: occurrence.sourceOccurrenceId,
          patternInstance: occurrence.patternInstance || null,
        },
        sourceBodyId: body.id,
        sourceKey: occurrence.variantKey + ':' + body.id,
        exactShape: result?.shape || null,
        exactNames: result?.names || null,
        exactResult: result || null,
        renderShape: result?.shape || null,
        renderNames: result?.names || null,
        exactPlacement: occurrence.transform,
        renderTransform: occurrence.transform,
        geometry,
        error,
        reused: result?.reused === true,
        lastValid: Boolean(result?.lastValid || solution.usedLastValid),
      });
    }
    for (const result of built.patternResults.values()) {
      const source = built.results.get(result.body.patternInstance.sourceBodyId);
      const bodyId = occurrence.id + ':' + result.body.id;
      const fused = result.body.patternInstance?.fused === true;
      const ownsGeometry = fused || result.rendersOwnGeometry === true;
      const placement = ownsGeometry
        ? occurrence.transform
        : studioV5MultiplyMatrices(occurrence.transform, result.renderTransform || assemblyIdentityMatrix());
      const geometry = result.geometry ? {
        ...result.geometry,
        bounds: studioV5TransformBounds(result.geometry.bounds, occurrence.transform),
        centerOfMass: result.geometry.centerOfMass ? studioV5TransformPoint(occurrence.transform, result.geometry.centerOfMass) : null,
      } : null;
      const error = result.error ? { ...result.error, bodyId, occurrencePath: occurrence.occurrencePath } : null;
      if (error) errors.push(error);
      runtimeBodies.push({
        bodyId,
        localBodyId: result.body.id,
        bodyName: occurrence.name + ' / ' + result.body.name,
        kind: result.body.kind,
        visible: occurrence.visible && result.body.visible,
        suppressed: occurrence.suppressed || result.body.suppressed,
        occurrenceInstance: {
          occurrenceId: occurrence.id,
          occurrencePath: occurrence.occurrencePath,
          definition: occurrence.definition,
          parameterOverrides: occurrence.parameterOverrides || {},
          variantKey: occurrence.variantKey,
          variantId: occurrence.variantId,
          sourceOccurrenceId: occurrence.sourceOccurrenceId,
          patternInstance: occurrence.patternInstance || null,
        },
        patternInstance: result.body.patternInstance,
        sourceBodyId: result.body.patternInstance.sourceBodyId,
        sourceKey: occurrence.variantKey + ':' + (ownsGeometry ? result.body.id : result.body.patternInstance.sourceBodyId),
        exactShape: result.shape,
        exactNames: result.names || null,
        exactResult: result,
        renderShape: ownsGeometry ? result.shape : source?.shape || null,
        renderNames: ownsGeometry ? result.names || null : source?.names || null,
        exactPlacement: occurrence.transform,
        renderTransform: placement,
        geometry,
        error,
        reused: result.reused === true,
        lastValid: Boolean(result.lastValid || solution.usedLastValid),
      });
    }
  }
  const trace = {
      effectiveDocumentHash,
      assemblyId: solution.assembly.id,
      solverState: solution.state,
      solverRank: solution.solverRank,
      solverComponents: solution.solverComponents,
      solverDiagnostics: solution.solverDiagnostics,
      degreesOfFreedom: Object.fromEntries(solution.degreesOfFreedom),
      conflicts: solution.conflicts,
      redundantMateIds: solution.redundantMateIds,
      mateResiduals: solution.residuals,
      usedLastValid: solution.usedLastValid,
      evaluatedPartIds: [...new Set([...partBuilds.values()].map((built) => built.sourcePartId))],
      evaluatedVariantKeys: [...partBuilds.keys()],
      reusedBodyIds: [...partBuilds.values()].flatMap((built) => built.trace.reusedBodyIds),
      evaluatedBodyIds: [...partBuilds.values()].flatMap((built) => built.trace.evaluatedBodyIds),
      reusedVariantBodyIds: [...partBuilds.values()].flatMap((built) => built.trace.reusedBodyIds.map((bodyId) => built.variantKey + ':' + bodyId)),
      evaluatedVariantBodyIds: [...partBuilds.values()].flatMap((built) => built.trace.evaluatedBodyIds.map((bodyId) => built.variantKey + ':' + bodyId)),
  };
  let ownedRuntimeResults = [];
  const assemblyFeatures = solution.assembly.extensions?.assemblyFeatures?.features || [];
  if (assemblyFeatures.length) {
    try {
      if (assemblyFeatures.some((feature) => feature.suppressed !== true)
          && (errors.length || solution.usedLastValid || runtimeBodies.some((runtime) => runtime.lastValid))) {
        throw new Error('Assembly features require error-free current component geometry and an exact solve without last-valid recovery.');
      }
      const applied = applyStudioAssemblyFeatures(
        document,
        solution,
        runtimeBodies,
        effectiveDocumentHash,
      );
      ownedRuntimeResults = applied.ownedRuntimeResults;
      trace.assemblyFeatures = applied.evidence;
    } catch (error) {
      errors.push({
        featureId: error?.featureId || null,
        featureType: 'assembly-feature',
        code: typeof error?.code === 'string' ? error.code : 'ASSEMBLY_FEATURE_KERNEL_REFUSED',
        message: String(error?.message || error),
      });
      delete trace.assemblyFeatures;
    }
  }
  const smartFastenerGroups = solution.assembly.extensions?.smartFasteners?.groups || [];
  if (smartFastenerGroups.length && options.skipSmartFastenerEvidence !== true) {
    try {
      if (errors.length || solution.usedLastValid) {
        throw new Error('Smart Fastener evidence requires an error-free current assembly solve without last-valid recovery.');
      }
      trace.smartFasteners = buildSmartFastenerEvidence(document, {
        solution,
        partBuilds,
        runtimeBodies,
        trace,
      });
    } catch (error) {
      errors.push({
        featureType: 'smart-fastener',
        code: typeof error?.code === 'string' ? error.code : 'SMART_FASTENER_EVIDENCE_INVALID',
        message: String(error?.message || error) + ' No Smart Fastener success evidence was published.',
      });
      delete trace.smartFasteners;
    }
  }
  return {
    solution,
    partBuilds,
    runtimeBodies,
    ownedRuntimeResults,
    errors,
    trace,
  };
}

const smartFastenerVectorSubtract = (left, right) => left.map((value, index) => value - right[index]);
const smartFastenerVectorAddScaled = (point, direction, distance) =>
  point.map((value, index) => value + direction[index] * distance);
const smartFastenerVectorDot = (left, right) => left.reduce((total, value, index) => total + value * right[index], 0);
const smartFastenerVectorCross = (left, right) => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];

function smartFastenerUnit(vector, label) {
  const magnitude = Math.hypot(...vector);
  if (!(magnitude > 1e-10) || !Number.isFinite(magnitude)) throw new Error(label + ' has zero or invalid length.');
  return vector.map((value) => value / magnitude);
}

function smartFastenerRigidTransform(zDirectionInput, translation) {
  const z = smartFastenerUnit(zDirectionInput, 'Smart Fastener placement axis');
  if (!Array.isArray(translation) || translation.length !== 3 || translation.some((value) => !Number.isFinite(value))) {
    throw new Error('Smart Fastener placement translation must contain three finite exact coordinates.');
  }
  const seed = Math.abs(z[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const projection = smartFastenerVectorDot(seed, z);
  const x = smartFastenerUnit(seed.map((value, index) => value - projection * z[index]), 'Smart Fastener placement x direction');
  const y = smartFastenerUnit(smartFastenerVectorCross(z, x), 'Smart Fastener placement y direction');
  return [
    ...x, 0,
    ...y, 0,
    ...z, 0,
    ...translation, 1,
  ];
}

function smartFastenerNamedReference(occurrenceId, bodyId, persistentName, signature, role) {
  return {
    ownerKind: 'body',
    ownerId: bodyId,
    occurrencePath: [occurrenceId],
    semanticPath: { role, topologyKind: signature.topologyKind, name: persistentName },
    signature: structuredClone(signature),
  };
}

function smartFastenerAxisPlanePoint(axisSignature, planeSignature, label) {
  const denominator = smartFastenerVectorDot(planeSignature.n, axisSignature.d);
  if (Math.abs(denominator) <= 1e-10) throw new Error(label + ' plane is parallel to the exact hole axis.');
  const parameter = smartFastenerVectorDot(
    planeSignature.n,
    smartFastenerVectorSubtract(planeSignature.p, axisSignature.a),
  ) / denominator;
  return smartFastenerVectorAddScaled(axisSignature.a, axisSignature.d, parameter);
}

async function buildSmartFastenerCatalogSelection(selection) {
  const document = createStandardPartProject(selection.familyId);
  const part = document.partDefinitions.find((entry) => entry.id === selection.partId);
  if (!part) throw new Error('Smart Fastener canonical catalog part is missing.');
  for (const [name, value] of Object.entries(selection.parameterOverrides)) {
    const parameter = part.parameters.find((entry) => entry.name === name);
    if (!parameter) throw new Error('Smart Fastener canonical catalog parameter "' + name + '" is missing.');
    parameter.value = value;
  }
  const built = await buildV5Document(document, {
    partId: selection.partId,
    cache: new Map(),
    previousCache: new Map(),
  });
  const result = built.results.get(selection.bodyId);
  if (built.errors.length || !result?.shape || result.error || result.lastValid
      || result.geometry?.valid !== true || result.geometry?.brepValid !== true || result.geometry?.solidCount !== 1) {
    disposeV5Build(built);
    throw new Error('Smart Fastener canonical ' + selection.familyId + ' selection did not produce one current valid exact OCCT solid.');
  }
  return { built, result };
}

function smartFastenerActiveFeatureIds(part) {
  const rollbackIndex = part.metadata?.rollbackFeatureId
    ? part.featureOrder.indexOf(part.metadata.rollbackFeatureId)
    : -1;
  return new Set(part.featureOrder.slice(0, rollbackIndex >= 0 ? rollbackIndex + 1 : part.featureOrder.length));
}

function resolveSmartFastenerTargetTopology(result, feature, definition, N, preferredEntryName = null) {
  const holeName = 'F' + feature.id + ':hole-wizard:pilot-side';
  if (!topo) throw new Error('Smart Fastener exact target topology resolver is unavailable.');
  const lookups = topo.nameLookups(result.shape, result.names || []);
  let holeEdges = [];
  try {
    const holeMatches = lookups.faceCandidates.filter((candidate) => lookups.getFaceName(candidate) === holeName);
    if (holeMatches.length !== 1) {
      throw new Error('Smart Fastener pilot cylinder "' + holeName + '" resolves to ' + holeMatches.length + ' current exact faces.');
    }
    const holeFace = holeMatches[0];
    const holeSignature = exactAnalyticFaceSignature(holeFace);
    if (holeSignature.topologyKind !== 'cylindrical-face') {
      throw new Error('Smart Fastener pilot persistent face is no longer an exact cylinder.');
    }
    const axis = smartFastenerUnit(holeSignature.d, 'Smart Fastener exact pilot axis');
    holeEdges = holeFace.edges;
    const axialSamples = [];
    for (const edge of holeEdges) for (const parameter of [0, 0.5, 1]) {
      let point = null;
      try {
        point = edge.pointAt(parameter);
        axialSamples.push(smartFastenerVectorDot(pointTuple(point, 'Smart Fastener pilot boundary point'), axis));
      } finally { safeDelete(point); }
    }
    if (!axialSamples.length) throw new Error('Smart Fastener pilot cylinder has no exact boundary evidence.');
    const axialMin = Math.min(...axialSamples);
    const axialMax = Math.max(...axialSamples);
    const grip = axialMax - axialMin;
    const tolerance = Math.max(2e-5, Math.abs(grip) * 1e-8);
    const seating = [];
    for (const face of lookups.faceCandidates) {
      const persistentName = lookups.getFaceName(face);
      if (!persistentName || face === holeFace) continue;
      let signature;
      try { signature = exactAnalyticFaceSignature(face); } catch { continue; }
      if (signature.topologyKind !== 'planar-face') continue;
      const normal = smartFastenerUnit(signature.n, 'Smart Fastener seating normal');
      if (Math.abs(smartFastenerVectorDot(normal, axis)) < 1 - 1e-7) continue;
      const station = smartFastenerVectorDot(signature.p, axis);
      if (Math.min(Math.abs(station - axialMin), Math.abs(station - axialMax)) > tolerance) continue;
      let edges = [];
      try {
        edges = face.edges;
        if (!edges.some((candidate) => holeEdges.some((holeEdge) => exactWrappedMatch(candidate, holeEdge)))) continue;
      } finally {
        for (const edge of edges) safeDelete(edge);
      }
      seating.push({ faceName: persistentName, signature, station });
    }
    if (seating.length !== 2) {
      throw new Error('Smart Fastener pilot must meet exactly two current named planar seating faces; found ' + seating.length + '.');
    }
    if (preferredEntryName) {
      const preferred = seating.findIndex((entry) => entry.faceName === preferredEntryName);
      if (preferred < 0) {
        throw new Error('Smart Fastener associated entry face "' + preferredEntryName + '" is no longer a current pilot-boundary seating face.');
      }
      if (preferred > 0) [seating[0], seating[preferred]] = [seating[preferred], seating[0]];
    } else {
      const supportOrigin = [definition.center[0], definition.center[1], sketchPlaneOffset(feature, N)];
      const supportStation = smartFastenerVectorDot(supportOrigin, axis);
      seating.sort((left, right) => Math.abs(left.station - supportStation) - Math.abs(right.station - supportStation));
      if (Math.abs(seating[0].station - supportStation) > tolerance) {
        throw new Error('Smart Fastener could not associate the exact Hole Wizard support plane with a current seating face.');
      }
    }
    const exactGrip = Math.abs(seating[1].station - seating[0].station);
    if (!Number.isFinite(exactGrip)) throw new Error('Smart Fastener exact grip is not finite.');
    return {
      hole: { faceName: holeName, signature: holeSignature },
      entry: seating[0],
      exit: seating[1],
      exactGrip,
    };
  } finally {
    for (const edge of holeEdges) safeDelete(edge);
    lookups.dispose();
  }
}

function smartFastenerStoredTargetFaceName(assembly, group, mateRole, targetOccurrenceId) {
  const mateId = group?.mateIds?.[mateRole];
  const mate = assembly?.mates?.find((entry) => entry.id === mateId);
  const matches = (mate?.references || []).filter((reference) =>
    reference?.occurrencePath?.length === 1 && reference.occurrencePath[0] === targetOccurrenceId);
  if (matches.length !== 1 || typeof matches[0].semanticPath?.name !== 'string') {
    throw new Error('Smart Fastener stored ' + mateRole + ' target association is missing or ambiguous.');
  }
  return matches[0].semanticPath.name;
}

async function createSmartFastenerPlan(document, targetOccurrenceId) {
  assertStudioSmartFastenersProject(document);
  if (document?.rootDocument?.kind !== 'assembly') throw new Error('Smart Fastener planning requires a schema-5 root assembly.');
  if (typeof targetOccurrenceId !== 'string' || !targetOccurrenceId) throw new Error('Smart Fastener planning requires targetOccurrenceId.');
  const assembly = document.assemblyDefinitions.find((entry) => entry.id === document.rootDocument.assemblyId);
  const targetOccurrence = assembly?.occurrences.find((entry) => entry.id === targetOccurrenceId);
  if (!targetOccurrence || targetOccurrence.definition?.kind !== 'part' || targetOccurrence.fixed !== true
      || targetOccurrence.suppressed === true || targetOccurrence.parentOccurrenceId != null) {
    throw new Error('Smart Fastener target must be one fixed, direct, unsuppressed part occurrence.');
  }

  let built = null;
  const catalogBuilds = [];
  try {
    built = await buildV5Assembly(document, {
      cache: new Map(),
      previousCache: new Map(),
      previousSolutions: new Map(),
      skipSmartFastenerEvidence: true,
    });
    if (built.errors.length || built.solution.usedLastValid) {
      throw new Error('Smart Fastener planning requires a fresh error-free assembly solve without last-valid recovery.');
    }
    const targetRuntimes = built.runtimeBodies.filter((runtime) =>
      runtime.occurrenceInstance?.occurrencePath?.length === 1
      && runtime.occurrenceInstance.occurrenceId === targetOccurrenceId
      && !runtime.suppressed
      && runtime.kind === 'solid');
    if (targetRuntimes.length !== 1) {
      throw new Error('Smart Fastener target must evaluate to exactly one unsuppressed solid body.');
    }
    const targetRuntime = targetRuntimes[0];
    if (targetRuntime.assemblyFeatureIds?.length) {
      throw new Error('Smart Fastener target is already owned by an assembly-level cut or hole.');
    }
    const targetResult = targetRuntime.exactResult;
    if (!targetRuntime.exactShape || !targetResult || targetRuntime.error || targetRuntime.lastValid
        || targetResult.geometry?.valid !== true || targetResult.geometry?.brepValid !== true
        || targetResult.geometry?.solidCount !== 1) {
      throw new Error('Smart Fastener target has no current non-last-valid one-solid OCCT result.');
    }
    const partId = targetOccurrence.definition.partId;
    const part = document.partDefinitions.find((entry) => entry.id === partId);
    const body = part?.bodies.find((entry) => entry.id === targetRuntime.localBodyId);
    if (!part || !body || body.suppressed === true) throw new Error('Smart Fastener target body recipe is missing or suppressed.');
    const enabledIds = smartFastenerActiveFeatureIds(part);
    const clearanceFeatures = part.features.filter((feature) =>
      enabledIds.has(feature.id)
      && feature.suppressed !== true
      && feature.extensions?.holeWizard?.kind === 'clearance');
    if (clearanceFeatures.length !== 1) {
      throw new Error('Smart Fastener target part must contain one uniquely eligible active clearance Hole Wizard feature.');
    }
    const feature = clearanceFeatures[0];
    if (!body.featureIds.includes(feature.id) || !feature.resultPolicy?.targetBodyIds?.includes(body.id)) {
      throw new Error('Smart Fastener Hole Wizard feature is not associated with the current target body history.');
    }
    const definition = assertStudioHoleWizardFeature(feature, 'smartFastener.plan.targetFeature');
    if (definition.kind !== 'clearance' || !['M5', 'M6', 'M8', 'M10', 'M12'].includes(definition.designation)) {
      throw new Error('Smart Fastener target is outside the bounded M5-M12 clearance-hole subset.');
    }

    const N = evaluator(document, part).strict;
    const existingGroups = (assembly.extensions?.smartFasteners?.groups || [])
      .filter((group) => group.targetOccurrenceId === targetOccurrenceId
        && group.target?.bodyId === body.id
        && group.target?.featureId === feature.id);
    if (existingGroups.length > 1) {
      throw new Error('Smart Fastener target occurrence/body/feature is owned by multiple groups.');
    }
    const existingEntryNames = new Set(existingGroups.map((group) =>
      smartFastenerStoredTargetFaceName(assembly, group, 'washer-coincident-entry', targetOccurrenceId)));
    if (existingEntryNames.size > 1) {
      throw new Error('Smart Fastener target has conflicting persisted entry-side associations.');
    }
    const targetTopology = resolveSmartFastenerTargetTopology(
      targetResult,
      feature,
      definition,
      N,
      existingEntryNames.size ? [...existingEntryNames][0] : null,
    );
    const { hole, entry, exit } = targetTopology;
    const holeRadius = definition.dimensions.pilotDiameter / 2;
    const topologyTolerance = Math.max(2e-5, Math.abs(holeRadius) * 1e-8);
    if (Math.abs(hole.signature.r - holeRadius) > topologyTolerance) {
      throw new Error('Smart Fastener current exact hole radius no longer matches its Hole Wizard recipe.');
    }
    const localAxis = smartFastenerUnit(hole.signature.d, 'Smart Fastener exact hole axis');
    const exactGrip = targetTopology.exactGrip;
    if (!(exactGrip > 1e-7) || !Number.isFinite(exactGrip)) {
      throw new Error('Smart Fastener exact entry and exit seating faces do not define a positive grip.');
    }
    for (const [label, seating] of [['entry', entry], ['exit', exit]]) {
      const alignment = Math.abs(smartFastenerVectorDot(
        smartFastenerUnit(seating.signature.n, 'Smart Fastener ' + label + ' face normal'),
        localAxis,
      ));
      if (alignment < 1 - 1e-7) throw new Error('Smart Fastener ' + label + ' seating face is not perpendicular to the current exact hole axis.');
    }

    const stack = selectStandardFastenerCatalogStack(definition.designation, exactGrip);
    const selections = {
      screw: structuredClone(stack.screw),
      washer: structuredClone(stack.washer),
      nut: structuredClone(stack.nut),
    };
    for (const role of ['screw', 'washer', 'nut']) {
      catalogBuilds.push({ role, ...(await buildSmartFastenerCatalogSelection(selections[role])) });
    }
    const catalogResult = (role) => catalogBuilds.find((entry) => entry.role === role).result;
    const catalogFace = (role, name, kind) => resolveCurrentExactNamedFace(catalogResult(role), name, kind).signature;

    const documentHash = studioV5CanonicalHash(document);
    const planOccurrenceIds = {
      screw: 'smart-plan-' + documentHash.slice(0, 16) + '-screw',
      washer: 'smart-plan-' + documentHash.slice(0, 16) + '-washer',
      nut: 'smart-plan-' + documentHash.slice(0, 16) + '-nut',
    };
    const targetReference = {
      hole: smartFastenerNamedReference(targetOccurrenceId, body.id, hole.faceName, hole.signature, 'target-hole'),
      entry: smartFastenerNamedReference(targetOccurrenceId, body.id, entry.faceName, entry.signature, 'target-entry'),
      exit: smartFastenerNamedReference(targetOccurrenceId, body.id, exit.faceName, exit.signature, 'target-exit'),
    };
    const hardwareReferences = {
      screwShank: smartFastenerNamedReference(planOccurrenceIds.screw, selections.screw.bodyId,
        STUDIO_SMART_FASTENER_FACE_NAMES.screwShank,
        catalogFace('screw', STUDIO_SMART_FASTENER_FACE_NAMES.screwShank, 'cylindrical-face'), 'screw-shank'),
      screwBearing: smartFastenerNamedReference(planOccurrenceIds.screw, selections.screw.bodyId,
        STUDIO_SMART_FASTENER_FACE_NAMES.screwBearing,
        catalogFace('screw', STUDIO_SMART_FASTENER_FACE_NAMES.screwBearing, 'planar-face'), 'screw-bearing'),
      washerBore: smartFastenerNamedReference(planOccurrenceIds.washer, selections.washer.bodyId,
        STUDIO_SMART_FASTENER_FACE_NAMES.washerBore,
        catalogFace('washer', STUDIO_SMART_FASTENER_FACE_NAMES.washerBore, 'cylindrical-face'), 'washer-bore'),
      washerBottom: smartFastenerNamedReference(planOccurrenceIds.washer, selections.washer.bodyId,
        STUDIO_SMART_FASTENER_FACE_NAMES.washerBottom,
        catalogFace('washer', STUDIO_SMART_FASTENER_FACE_NAMES.washerBottom, 'planar-face'), 'washer-bottom'),
      washerTop: smartFastenerNamedReference(planOccurrenceIds.washer, selections.washer.bodyId,
        STUDIO_SMART_FASTENER_FACE_NAMES.washerTop,
        catalogFace('washer', STUDIO_SMART_FASTENER_FACE_NAMES.washerTop, 'planar-face'), 'washer-top'),
      nutBore: smartFastenerNamedReference(planOccurrenceIds.nut, selections.nut.bodyId,
        STUDIO_SMART_FASTENER_FACE_NAMES.nutBore,
        catalogFace('nut', STUDIO_SMART_FASTENER_FACE_NAMES.nutBore, 'cylindrical-face'), 'nut-bore'),
      nutTop: smartFastenerNamedReference(planOccurrenceIds.nut, selections.nut.bodyId,
        STUDIO_SMART_FASTENER_FACE_NAMES.nutTop,
        catalogFace('nut', STUDIO_SMART_FASTENER_FACE_NAMES.nutTop, 'planar-face'), 'nut-top'),
    };

    const entryWorld = studioV5TransformPoint(
      targetRuntime.exactPlacement,
      smartFastenerAxisPlanePoint(hole.signature, entry.signature, 'Smart Fastener entry seating'),
    );
    const exitWorld = studioV5TransformPoint(
      targetRuntime.exactPlacement,
      smartFastenerAxisPlanePoint(hole.signature, exit.signature, 'Smart Fastener exit seating'),
    );
    const passageWorld = smartFastenerUnit(
      smartFastenerVectorSubtract(exitWorld, entryWorld),
      'Smart Fastener world passage direction',
    );
    const hardwareZ = passageWorld.map((value) => -value);
    const washerThickness = Number(selections.washer.parameterOverrides.thickness);
    const screwLength = Number(selections.screw.parameterOverrides.length);
    const nutHeight = Number(selections.nut.parameterOverrides.height);
    const washerOrigin = entryWorld;
    const washerTop = smartFastenerVectorAddScaled(entryWorld, hardwareZ, washerThickness);
    const screwOrigin = smartFastenerVectorAddScaled(washerTop, hardwareZ, -screwLength);
    const nutOrigin = smartFastenerVectorAddScaled(exitWorld, hardwareZ, -nutHeight);

    const plan = {
      schema: STUDIO_SMART_FASTENER_PLAN_SCHEMA,
      policyId: STUDIO_SMART_FASTENER_POLICY_ID,
      documentHash,
      target: {
        occurrenceId: targetOccurrenceId,
        occurrencePath: [targetOccurrenceId],
        partId,
        bodyId: body.id,
        featureId: feature.id,
        designation: definition.designation,
        holeReference: targetReference.hole,
        entryReference: targetReference.entry,
        exitReference: targetReference.exit,
        exactGrip,
      },
      selections,
      occurrences: {
        screw: { occurrenceId: planOccurrenceIds.screw, baseTransform: smartFastenerRigidTransform(hardwareZ, screwOrigin) },
        washer: { occurrenceId: planOccurrenceIds.washer, baseTransform: smartFastenerRigidTransform(hardwareZ, washerOrigin) },
        nut: { occurrenceId: planOccurrenceIds.nut, baseTransform: smartFastenerRigidTransform(hardwareZ, nutOrigin) },
      },
      mates: [
        { role: 'screw-concentric-hole', kind: 'concentric', occurrenceRoles: ['screw', 'target'], references: [hardwareReferences.screwShank, targetReference.hole] },
        { role: 'screw-coincident-washer', kind: 'coincident', occurrenceRoles: ['screw', 'washer'], references: [hardwareReferences.screwBearing, hardwareReferences.washerTop], flip: true },
        { role: 'washer-concentric-hole', kind: 'concentric', occurrenceRoles: ['washer', 'target'], references: [hardwareReferences.washerBore, targetReference.hole] },
        { role: 'washer-coincident-entry', kind: 'coincident', occurrenceRoles: ['washer', 'target'], references: [hardwareReferences.washerBottom, targetReference.entry], flip: true },
        { role: 'nut-concentric-screw', kind: 'concentric', occurrenceRoles: ['nut', 'screw'], references: [hardwareReferences.nutBore, hardwareReferences.screwShank] },
        { role: 'nut-coincident-exit', kind: 'coincident', occurrenceRoles: ['nut', 'target'], references: [hardwareReferences.nutTop, targetReference.exit], flip: true },
      ],
      fingerprint: '',
    };
    plan.fingerprint = studioSmartFastenerPlanFingerprint(plan);
    return assertStudioSmartFastenerPlan(plan, { documentHash });
  } finally {
    for (const entry of catalogBuilds) disposeV5Build(entry.built);
    if (built) disposeV5Build(built);
  }
}

async function planSmartFastenerV5(request) {
  if (Object.prototype.hasOwnProperty.call(request, 'featureId')
      || Object.prototype.hasOwnProperty.call(request, 'bodyId')
      || Object.prototype.hasOwnProperty.call(request, 'designation')) {
    throw new Error('Smart Fastener planning derives the feature, body, and designation from targetOccurrenceId; callers cannot supply them.');
  }
  const plan = await createSmartFastenerPlan(request.document, request.targetOccurrenceId);
  self.postMessage({
    kind: 'smart-fastener-plan-result',
    requestId: request.requestId,
    projectId: request.projectId,
    revision: request.revision,
    errors: [],
    plan,
  });
}

function smartFastenerRuntimeFor(runtimeBodies, occurrenceId, bodyId, label) {
  const matches = runtimeBodies.filter((runtime) =>
    runtime.occurrenceInstance?.occurrencePath?.length === 1
    && runtime.occurrenceInstance.occurrenceId === occurrenceId
    && runtime.localBodyId === bodyId);
  if (matches.length !== 1) throw new Error(label + ' does not resolve to one current direct exact body occurrence.');
  const runtime = matches[0];
  if (!runtime.exactShape || !runtime.exactResult || runtime.error || runtime.lastValid
      || runtime.exactResult.error || runtime.exactResult.lastValid
      || runtime.geometry?.valid !== true || runtime.geometry?.brepValid !== true
      || runtime.geometry?.solidCount !== 1) {
    throw new Error(label + ' has no current non-last-valid one-solid OCCT result.');
  }
  return runtime;
}

function smartFastenerWorldFrame(signature, transform) {
  if (signature.topologyKind === 'planar-face') return {
    geometryKind: 'plane',
    origin: studioV5TransformPoint(transform, signature.p),
    direction: smartFastenerUnit(studioV5TransformVector(transform, signature.n), 'Smart Fastener world plane normal'),
  };
  if (signature.topologyKind === 'cylindrical-face') return {
    geometryKind: 'cylinder',
    origin: studioV5TransformPoint(transform, signature.a),
    direction: smartFastenerUnit(studioV5TransformVector(transform, signature.d), 'Smart Fastener world cylinder axis'),
    radius: signature.r,
  };
  throw new Error('Smart Fastener evidence supports only planar and cylindrical mate frames.');
}

function smartFastenerResolvedMateReference(runtimeBodies, reference, expectedName, expectedKind, label) {
  const occurrenceId = reference?.occurrencePath?.[0];
  if (typeof occurrenceId !== 'string' || reference.occurrencePath.length !== 1) {
    throw new Error(label + ' must retain one direct occurrence path.');
  }
  if (reference.ownerKind !== 'body' || reference.semanticPath?.name !== expectedName) {
    throw new Error(label + ' lost its source-owned persistent face association.');
  }
  const runtime = smartFastenerRuntimeFor(runtimeBodies, occurrenceId, reference.ownerId, label);
  const resolved = resolveCurrentExactNamedFace(runtime.exactResult, expectedName, expectedKind);
  return {
    occurrenceId,
    bodyId: reference.ownerId,
    name: expectedName,
    localSignature: structuredClone(resolved.signature),
    worldFrame: smartFastenerWorldFrame(resolved.signature, runtime.exactPlacement),
  };
}

function smartFastenerExactBodyEvidence(role, runtime) {
  const exactBrep = canonicalStudioBrepEvidence(rc, runtime.exactShape);
  return {
    occurrenceId: runtime.occurrenceInstance.occurrenceId,
    bodyId: runtime.localBodyId,
    variantId: runtime.occurrenceInstance.variantId,
    parameters: structuredClone(runtime.occurrenceInstance.parameterOverrides || {}),
    transform: [...runtime.exactPlacement],
    exactBrep,
    brepSha256: studioV5Sha256Hex(exactBrep),
    geometry: structuredClone(runtime.geometry),
    role,
  };
}

function smartFastenerStrictIntersectionVolume(leftShape, rightShape) {
  let intersection = null;
  let intersector = null;
  let progress = null;
  try {
    const oc = rc.getOC();
    progress = new oc.Message_ProgressRange_1();
    intersector = new oc.BRepAlgoAPI_Common_3(leftShape.wrapped, rightShape.wrapped, progress);
    intersector.SetUseOBB?.(true);
    intersector.SetFuzzyValue?.(1e-7);
    intersector.Build(progress);
    if (typeof intersector.IsDone === 'function' && !intersector.IsDone()) {
      throw new Error('Smart Fastener exact interference Boolean did not complete.');
    }
    intersection = rc.cast(intersector.Shape());
    const volume = shapeVolume(intersection);
    if (!Number.isFinite(volume) || volume < -1e-12) throw new Error('Smart Fastener exact interference volume is invalid.');
    return Math.max(0, volume);
  } finally {
    safeDelete(intersection);
    safeDelete(intersector);
    safeDelete(progress);
  }
}

const SMART_FASTENER_INTERFERENCE_ACCEPTANCE_TOLERANCE_MM3 = 1e-7;

function smartFastenerInterferenceEvidence(runtimes) {
  const roles = ['target', 'screw', 'washer', 'nut'];
  const placed = new Map();
  try {
    for (const role of roles) placed.set(role, applyRigidMatrix(runtimes[role].exactShape, runtimes[role].exactPlacement));
    const pairs = [];
    let maxPositiveVolumeMm3 = 0;
    let hasInterference = false;
    for (let leftIndex = 0; leftIndex < roles.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < roles.length; rightIndex++) {
        const pairRoles = [roles[leftIndex], roles[rightIndex]];
        const volume = smartFastenerStrictIntersectionVolume(placed.get(pairRoles[0]), placed.get(pairRoles[1]));
        const pairHasInterference = volume > 0;
        maxPositiveVolumeMm3 = Math.max(maxPositiveVolumeMm3, volume);
        hasInterference ||= pairHasInterference;
        if (volume > SMART_FASTENER_INTERFERENCE_ACCEPTANCE_TOLERANCE_MM3) {
          throw new Error('Smart Fastener exact bodies ' + pairRoles.join(' and ') + ' interfere by ' + volume + ' mm^3.');
        }
        pairs.push({
          roles: pairRoles,
          positiveVolumeMm3: volume,
          hasInterference: pairHasInterference,
        });
      }
    }
    return {
      acceptanceToleranceMm3: SMART_FASTENER_INTERFERENCE_ACCEPTANCE_TOLERANCE_MM3,
      pairs,
      maxPositiveVolumeMm3,
      hasInterference,
    };
  } finally {
    for (const shape of placed.values()) safeDelete(shape);
  }
}

function smartFastenerPersistedSelection(selection) {
  return {
    familyId: selection.familyId,
    configurationId: selection.configurationId,
    designation: selection.designation,
    partNumber: selection.partNumber,
  };
}

function buildSmartFastenerGroupEvidence(document, context, group) {
  const { solution, runtimeBodies, trace } = context;
  const assembly = solution.assembly;
  const targetOccurrence = assembly.occurrences.find((entry) => entry.id === group.targetOccurrenceId);
  const targetPart = document.partDefinitions.find((entry) => entry.id === group.target.partId);
  const targetBody = targetPart?.bodies.find((entry) => entry.id === group.target.bodyId);
  const targetFeature = targetPart?.features.find((entry) => entry.id === group.target.featureId);
  if (!targetOccurrence || targetOccurrence.definition?.partId !== targetPart?.id || targetOccurrence.fixed !== true
      || targetOccurrence.suppressed === true || !targetBody || !targetFeature || targetBody.suppressed === true) {
    throw new Error('Smart Fastener group "' + group.id + '" target association is stale.');
  }
  const definition = assertStudioHoleWizardFeature(targetFeature, 'smartFastener.evidence.targetFeature');
  if (definition.kind !== 'clearance' || definition.designation !== group.target.designation
      || !targetBody.featureIds.includes(targetFeature.id)
      || !targetFeature.resultPolicy?.targetBodyIds?.includes(targetBody.id)
      || !smartFastenerActiveFeatureIds(targetPart).has(targetFeature.id)) {
    throw new Error('Smart Fastener group "' + group.id + '" current Hole Wizard recipe is stale.');
  }

  const runtimes = {
    target: smartFastenerRuntimeFor(runtimeBodies, group.targetOccurrenceId, group.target.bodyId, 'Smart Fastener target'),
    screw: smartFastenerRuntimeFor(runtimeBodies, group.occurrenceIds.screw,
      selectStandardFastenerCatalogStack(group.target.designation, 1).screw.bodyId, 'Smart Fastener screw'),
    washer: smartFastenerRuntimeFor(runtimeBodies, group.occurrenceIds.washer,
      selectStandardFastenerCatalogStack(group.target.designation, 1).washer.bodyId, 'Smart Fastener washer'),
    nut: smartFastenerRuntimeFor(runtimeBodies, group.occurrenceIds.nut,
      selectStandardFastenerCatalogStack(group.target.designation, 1).nut.bodyId, 'Smart Fastener nut'),
  };
  const targetTopology = resolveSmartFastenerTargetTopology(
    runtimes.target.exactResult,
    targetFeature,
    definition,
    evaluator(document, targetPart).strict,
    smartFastenerStoredTargetFaceName(assembly, group, 'washer-coincident-entry', group.targetOccurrenceId),
  );
  const exactGrip = targetTopology.exactGrip;
  const selectedStack = selectStandardFastenerCatalogStack(group.target.designation, exactGrip);
  const selectedByRole = { screw: selectedStack.screw, washer: selectedStack.washer, nut: selectedStack.nut };
  for (const role of ['screw', 'washer', 'nut']) {
    if (JSON.stringify(group.selections[role]) !== JSON.stringify(smartFastenerPersistedSelection(selectedByRole[role]))) {
      throw new Error('Smart Fastener group "' + group.id + '" ' + role + ' is no longer the shortest current exact catalog selection.');
    }
    if (JSON.stringify(runtimes[role].occurrenceInstance.parameterOverrides || {})
        !== JSON.stringify(selectedByRole[role].parameterOverrides)) {
      throw new Error('Smart Fastener group "' + group.id + '" ' + role + ' parameters no longer match its source-owned catalog row.');
    }
  }

  const targetReferences = {
    holeReference: smartFastenerNamedReference(group.targetOccurrenceId, group.target.bodyId,
      targetTopology.hole.faceName, targetTopology.hole.signature, 'target-hole'),
    entryReference: smartFastenerNamedReference(group.targetOccurrenceId, group.target.bodyId,
      targetTopology.entry.faceName, targetTopology.entry.signature, 'target-entry'),
    exitReference: smartFastenerNamedReference(group.targetOccurrenceId, group.target.bodyId,
      targetTopology.exit.faceName, targetTopology.exit.signature, 'target-exit'),
  };
  const expectedMateNames = {
    'screw-concentric-hole': [STUDIO_SMART_FASTENER_FACE_NAMES.screwShank, targetTopology.hole.faceName],
    'screw-coincident-washer': [STUDIO_SMART_FASTENER_FACE_NAMES.screwBearing, STUDIO_SMART_FASTENER_FACE_NAMES.washerTop],
    'washer-concentric-hole': [STUDIO_SMART_FASTENER_FACE_NAMES.washerBore, targetTopology.hole.faceName],
    'washer-coincident-entry': [STUDIO_SMART_FASTENER_FACE_NAMES.washerBottom, targetTopology.entry.faceName],
    'nut-concentric-screw': [STUDIO_SMART_FASTENER_FACE_NAMES.nutBore, STUDIO_SMART_FASTENER_FACE_NAMES.screwShank],
    'nut-coincident-exit': [STUDIO_SMART_FASTENER_FACE_NAMES.nutTop, targetTopology.exit.faceName],
  };
  const mateFrames = [];
  for (const role of Object.keys(expectedMateNames)) {
    const mateId = group.mateIds[role];
    const mate = assembly.mates.find((entry) => entry.id === mateId);
    const expectedKind = role.includes('concentric') ? 'cylindrical-face' : 'planar-face';
    const expectedFlip = !role.includes('concentric');
    if (!mate || mate.suppressed || (mate.extensions?.flip === true) !== expectedFlip) {
      throw new Error('Smart Fastener mate "' + role + '" lost its canonical contact orientation.');
    }
    const references = mate.references.map((reference, index) => smartFastenerResolvedMateReference(
      runtimeBodies,
      reference,
      expectedMateNames[role][index],
      expectedKind,
      'Smart Fastener mate ' + role + ' reference ' + (index + 1),
    ));
    const residual = solution.residuals.find((entry) => entry.mateId === mateId);
    if (!residual || residual.satisfied !== true || !(Number(residual.maxScaledResidual) <= 1e-6)) {
      throw new Error('Smart Fastener mate "' + role + '" has no current satisfied exact solver residual: '
        + JSON.stringify(residual || null) + '.');
    }
    mateFrames.push({
      role,
      mateId,
      kind: mate.kind,
      flip: expectedFlip,
      references,
      residual: structuredClone(residual),
    });
  }

  const degreesOfFreedom = {
    screw: solution.degreesOfFreedom.get(group.occurrenceIds.screw),
    washer: solution.degreesOfFreedom.get(group.occurrenceIds.washer),
    nut: solution.degreesOfFreedom.get(group.occurrenceIds.nut),
  };
  if (Object.values(degreesOfFreedom).some((value) => value !== 1)) {
    throw new Error('Smart Fastener generated occurrences must each retain exactly one rotational degree of freedom.');
  }
  const groupMateIds = new Set(Object.values(group.mateIds));
  const solverResiduals = trace.mateResiduals.filter((entry) => groupMateIds.has(entry.mateId));
  if (solverResiduals.length !== 6 || solverResiduals.some((entry) => entry.satisfied !== true || !(entry.maxScaledResidual <= 1e-6))) {
    throw new Error('Smart Fastener group does not have six current satisfied mate residuals.');
  }

  const exactBodies = Object.fromEntries(['target', 'screw', 'washer', 'nut'].map((role) => [
    role,
    smartFastenerExactBodyEvidence(role, runtimes[role]),
  ]));
  const interference = smartFastenerInterferenceEvidence(runtimes);
  return {
    groupId: group.id,
    policyId: group.policyId,
    target: {
      occurrenceId: group.targetOccurrenceId,
      partId: group.target.partId,
      bodyId: group.target.bodyId,
      featureId: group.target.featureId,
      designation: group.target.designation,
      ...targetReferences,
      exactGrip,
      axis: structuredClone(targetTopology.hole.signature.d),
      radius: targetTopology.hole.signature.r,
    },
    catalog: {
      requiredLength: selectedStack.requiredLength,
      selections: structuredClone(selectedByRole),
    },
    exactBodies,
    mateFrames,
    solver: {
      rank: trace.solverRank,
      residuals: structuredClone(solverResiduals),
      degreesOfFreedom,
      usedLastValid: false,
    },
    interference,
  };
}

function buildSmartFastenerEvidence(document, context) {
  assertStudioSmartFastenersProject(document);
  if (context.solution.usedLastValid || context.runtimeBodies.some((runtime) => runtime.lastValid)) {
    throw new Error('Smart Fastener evidence refuses last-valid geometry or placement.');
  }
  const groups = context.solution.assembly.extensions?.smartFasteners?.groups || [];
  return {
    schema: 'partmode.smart-fastener-evidence/v1',
    documentHash: context.trace.effectiveDocumentHash,
    groups: groups.map((group) => buildSmartFastenerGroupEvidence(document, context, group)),
  };
}

// Enumerate exact OCCT vertices without using hash codes or coordinates for
// identity. Replicad's private topology iterator deduplicates by HashCode only;
// that is fine for display edges, but it is not a safe persistent-reference
// boundary because distinct topology can collide or occupy one point.
function exactVertexHandles(topologyShape) {
  const oc = rc.getOC();
  const explorer = new oc.TopExp_Explorer_2(
    topologyShape.wrapped,
    oc.TopAbs_ShapeEnum.TopAbs_VERTEX,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  const vertices = [];
  try {
    while (explorer.More()) {
      let current = null;
      let vertex = null;
      try {
        current = explorer.Current();
        vertex = oc.TopoDS.Vertex_1(current);
        if (vertices.some((candidate) => candidate.IsSame(vertex))) {
          safeDelete(vertex);
        } else {
          vertices.push(vertex);
          vertex = null;
        }
      } finally {
        safeDelete(vertex);
        safeDelete(current);
      }
      explorer.Next();
    }
    return vertices;
  } catch (error) {
    for (const vertex of vertices) safeDelete(vertex);
    throw error;
  } finally {
    safeDelete(explorer);
  }
}

function exactEdgeEndpointVertices(edge, shapeVertices) {
  const discovered = exactVertexHandles(edge);
  try {
    const endpoints = discovered.map((vertex) => {
      const matches = shapeVertices.filter((candidate) => candidate.IsSame(vertex));
      return matches.length === 1 ? matches[0] : null;
    });
    if (endpoints.some((vertex) => !vertex) || endpoints.length < 1 || endpoints.length > 2) return [];
    // A closed edge has one exact vertex which is both endpoints. Preserve that
    // topology explicitly; the vertex namer will count its incidence once.
    return endpoints.length === 1 ? [endpoints[0], endpoints[0]] : endpoints;
  } finally {
    for (const vertex of discovered) safeDelete(vertex);
  }
}

const TEST_ONLY_COLLIDING_DISPLAY_HASH = -2147483648;

function topologyDisplayHash(topology, topologyKind, index, options) {
  const injection = options?.testOnlyDisplayHashCollision;
  if (injection?.topologyKind === topologyKind && index < 2) {
    return TEST_ONLY_COLLIDING_DISPLAY_HASH;
  }
  return topology.hashCode;
}

function serializeShape(shape, nameTable = null, options = {}) {
  if (!shape) return { mesh: null, transfer: [], exactBrep: null };
  // Raw OCCT BREP is intentionally opt-in. The mutation acceptance gate uses
  // it to prove that checkpointed and cold rebuilds are byte deterministic;
  // normal interactive rebuilds do not pay the serialization or message cost.
  const exactBrep = options.includeExactBrep === true ? canonicalStudioBrepEvidence(rc, shape) : null;
  let wireNames = {
    diagnostics: [],
    getFaceName: () => null,
    getEdgeName: () => null,
    getVertexName: () => null,
    dispose: () => {},
  };
  if (nameTable?.length && topo) {
    // Naming failures are correctness failures, not permission to erase all
    // persistent names from the response. Let them reach the worker's explicit
    // error channel.
    wireNames = topo.serializationNames(shape, nameTable);
  }
  let shapeFaces = [];
  let shapeEdges = [];
  let shapeVertices = [];
  let boundingBox = null;
  try {
    shapeFaces = topo ? topo.exactFaces(shape) : shape.faces;
    shapeEdges = topo ? topo.exactEdges(shape) : shape.edges;
    shapeVertices = exactVertexHandles(shape);
    const mesh = shape.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
    const vertices = Float32Array.from(mesh.vertices);
    const normals = mesh.normals ? Float32Array.from(mesh.normals) : null;
    const triangles = Uint32Array.from(mesh.triangles);
    const faceGroups = (mesh.faceGroups || []).map((group) => ({
      start: group.start,
      count: group.count,
      faceId: group.faceId,
    }));
    const topologyDiagnostics = [...(wireNames.diagnostics || [])];
    const faceByDisplayHash = new Map();
    for (const [index, face] of shapeFaces.entries()) {
      const hash = topologyDisplayHash(face, 'face', index, options);
      if (!faceByDisplayHash.has(hash)) faceByDisplayHash.set(hash, []);
      faceByDisplayHash.get(hash).push(face);
    }
    const ambiguousFaceHashes = new Set();
    for (const [hashId, matches] of faceByDisplayHash) {
      if (matches.length < 2) continue;
      ambiguousFaceHashes.add(hashId);
      topologyDiagnostics.push({
        severity: 'error',
        code: 'TOPOLOGY_DISPLAY_HASH_AMBIGUOUS',
        reason: 'distinct-exact-faces-share-display-hash',
        topologyKind: 'face',
        hashId,
        exactMatchCount: matches.length,
      });
    }
    const planarFaces = [];
    const topologyFaces = [];
    for (const [index, face] of shapeFaces.entries()) {
      const displayHash = topologyDisplayHash(face, 'face', index, options);
      // A colliding display id cannot identify either exact face. Keep the
      // triangles for rendering, but omit both selectable topology records.
      if (ambiguousFaceHashes.has(displayHash)) continue;
      const name = wireNames.getFaceName(face);
      topologyFaces.push({ faceId: displayHash, sig: faceSignature(face), geomType: face.geomType || 'OTHER', ...(name ? { name } : {}) });
      if (face.geomType === 'PLANE') {
        planarFaces.push({ faceId: displayHash, sig: faceSignature(face), outline: faceOutline(face), ...(name ? { name } : {}) });
      }
    }
    const edges = [];
    const edgeMesh = shape.meshEdges();
    const byHash = new Map();
    for (const [index, edge] of shapeEdges.entries()) {
      const hash = topologyDisplayHash(edge, 'edge', index, options);
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash).push(edge);
    }
    const diagnosedEdgeHashes = new Set();
    for (const [hashId, matches] of byHash) {
      if (matches.length < 2) continue;
      diagnosedEdgeHashes.add(hashId);
      topologyDiagnostics.push({
        severity: 'error',
        code: 'TOPOLOGY_DISPLAY_HASH_AMBIGUOUS',
        reason: 'distinct-exact-edges-share-display-hash',
        topologyKind: 'edge',
        hashId,
        exactMatchCount: matches.length,
      });
    }
    for (const group of edgeMesh.edgeGroups || []) {
      const matches = byHash.get(group.edgeId) || [];
      if (matches.length !== 1) {
        if (matches.length > 1 && !diagnosedEdgeHashes.has(group.edgeId)) {
          diagnosedEdgeHashes.add(group.edgeId);
          topologyDiagnostics.push({
            severity: 'error',
            code: 'TOPOLOGY_DISPLAY_HASH_AMBIGUOUS',
            reason: 'distinct-exact-edges-share-display-hash',
            topologyKind: 'edge',
            hashId: group.edgeId,
            exactMatchCount: matches.length,
          });
        }
        continue;
      }
      const edge = matches[0];
      const name = wireNames.getEdgeName(edge);
      edges.push({
        points: Float32Array.from(edgeMesh.lines.slice(group.start * 3, (group.start + group.count) * 3)),
        sig: edgeSignature(edge),
        ...(name ? { name } : {}),
      });
    }

    let vertexNaming = null;
    if (nameTable?.length && topo && !nameTable.explicitVertexTable) {
      vertexNaming = derivePersistentVertexNames({
        edges: shapeEdges,
        getEdgeName: (edge) => wireNames.getEdgeName(edge),
        getEdgeEndpoints: (edge) => exactEdgeEndpointVertices(edge, shapeVertices),
        isSameEdge: (left, right) => left.wrapped.IsSame(right.wrapped),
        isSameVertex: (left, right) => left.IsSame(right),
      });
    }
    const topologyVertices = shapeVertices.map((vertex) => {
      let exactPoint = null;
      try {
        exactPoint = rc.getOC().BRep_Tool.Pnt(vertex);
        const point = [exactPoint.X(), exactPoint.Y(), exactPoint.Z()].map(quantize);
        const name = wireNames.getVertexName(vertex)
          || vertexNaming?.vertexTable.find((entry) => entry.vertex.IsSame(vertex))?.name
          || null;
        return { sig: { p: point }, ...(name ? { name } : {}) };
      } finally {
        safeDelete(exactPoint);
      }
    });
    const persistentTopologyCounts = {
      faces: shapeFaces.length,
      namedFaces: topologyFaces.filter((face) => Boolean(face.name)).length,
      edges: shapeEdges.length,
      namedEdges: edges.filter((edge) => Boolean(edge.name)).length,
      vertices: shapeVertices.length,
      namedVertices: topologyVertices.filter((vertex) => Boolean(vertex.name)).length,
      ...(vertexNaming?.counts || {}),
    };
    if (options.requirePersistentTopology === true && (
      persistentTopologyCounts.namedFaces !== persistentTopologyCounts.faces
      || persistentTopologyCounts.namedEdges !== persistentTopologyCounts.edges
      || persistentTopologyCounts.namedVertices !== persistentTopologyCounts.vertices
    )) {
      topologyDiagnostics.push({
        severity: 'error',
        code: 'TOPOLOGY_PERSISTENCE_INCOMPLETE',
        reason: 'not-every-exact-subshape-has-a-persistent-name',
        topologyKind: 'shape',
        ...persistentTopologyCounts,
      });
    }
    const vertexTopologyDiagnostics = (vertexNaming?.diagnostics || []).map((diagnostic) => ({
      severity: diagnostic.severity || 'error',
      ...diagnostic,
    }));
    const combinedTopologyDiagnostics = [...topologyDiagnostics, ...vertexTopologyDiagnostics]
      .sort((left, right) => JSON.stringify([
        left.code || '', left.reason || '', left.topologyKind || '', left.persistentBaseName || '', left.hashId ?? '',
      ]).localeCompare(JSON.stringify([
        right.code || '', right.reason || '', right.topologyKind || '', right.persistentBaseName || '', right.hashId ?? '',
      ])));
    if (options.requirePersistentTopology === true) {
      const namingErrors = combinedTopologyDiagnostics.filter((diagnostic) => diagnostic?.severity === 'error');
      if (namingErrors.length) {
        const first = namingErrors[0];
        throw codedFeatureError(
          first.code || 'TOPOLOGY_PERSISTENCE_INCOMPLETE',
          first.message || 'Required persistent topology is incomplete or ambiguous; no geometry was published.',
          { diagnostics: structuredClone(namingErrors) },
        );
      }
    }
    boundingBox = shape.boundingBox;
    const bounds = boundingBox?.bounds ?? null;
    const transfer = [vertices.buffer, triangles.buffer, ...edges.map((edge) => edge.points.buffer)];
    if (normals) transfer.push(normals.buffer);
    return {
      mesh: {
        vertices,
        normals,
        triangles,
        faceGroups,
        planarFaces,
        topologyFaces,
        edges,
        topologyVertices,
        topologyDiagnostics: combinedTopologyDiagnostics,
        topologyCounts: persistentTopologyCounts,
        bounds,
      },
      transfer,
      exactBrep,
    };
  } finally {
    safeDelete(boundingBox);
    wireNames.dispose();
    for (const face of shapeFaces) safeDelete(face);
    for (const edge of shapeEdges) safeDelete(edge);
    for (const vertex of shapeVertices) safeDelete(vertex);
  }
}

async function rebuild(request) {
  return rebuildV5(request);
}

function testOnlyDisplayHashCollisionFor(request, bodyId) {
  const injection = request?.testOnlyTopologyDisplayHashCollision;
  if (injection?.bodyId !== bodyId) return null;
  if (injection.topologyKind !== 'face' && injection.topologyKind !== 'edge') return null;
  // This deliberately cannot choose a hash value or the number of affected
  // subshapes. Tests can exercise correlation failure, but cannot turn this
  // hook into another runtime identity scheme.
  return { topologyKind: injection.topologyKind };
}

function bodySerializationFailure(body, error) {
  return {
    bodyId: body.id,
    featureId: body.patternInstance?.patternId || body.createdByFeatureId || body.id,
    featureType: body.patternInstance ? 'pattern' : 'body',
    code: typeof error?.code === 'string' ? error.code : 'TOPOLOGY_SERIALIZATION_FAILED',
    stage: 'serialization',
    message: String(error?.message || error),
  };
}

function disposeRejectedBuildResult(result, previous) {
  if (!result?.shape || result.shape === previous?.shape) return;
  safeDelete(result.shape);
  disposeCachedNameData(result);
}

function retainPrivateFailureCheckpoint(nextCache, previousCache, cacheKey, result) {
  if (!result?.error) return;
  const previous = previousCache.get(cacheKey);
  // Only successful exact entries enter the cache. Retaining the same object
  // keeps its shape/name ownership singular, while the failed response remains
  // completely shape-less and cannot expose this checkpoint.
  if (previous?.shape && !previous.error) nextCache.set(cacheKey, previous);
}

function appendBodyScopedError(errors, failure) {
  const duplicate = errors.some((entry) =>
    entry?.bodyId === failure.bodyId
    && entry?.stage === failure.stage
    && entry?.code === failure.code);
  if (!duplicate) errors.push(failure);
}

function effectiveConfiguredRootDocument(document) {
  const authoredDocument = prepareStudioV5Project(document);
  if (authoredDocument.rootDocument?.kind !== 'part') {
    return {
      authoredDocument,
      effectiveDocument: authoredDocument,
      configuration: null,
      effectiveDocumentHash: studioV5CanonicalHash(authoredDocument),
    };
  }
  const rootPartId = authoredDocument.rootDocument.partId;
  const configurationSets = (authoredDocument.partConfigurationSets || [])
    .filter((entry) => entry?.partId === rootPartId);
  if (configurationSets.length > 1) {
    throw new Error('Part "' + rootPartId + '" has more than one configuration set.');
  }
  if (!configurationSets.length) {
    return {
      authoredDocument,
      effectiveDocument: authoredDocument,
      configuration: null,
      effectiveDocumentHash: studioV5CanonicalHash(authoredDocument),
    };
  }
  const configurationSet = configurationSets[0];
  const applied = applyStudioPartConfiguration(
    authoredDocument,
    configurationSet,
    configurationSet.activeConfigurationId,
  );
  const configuration = {
    id: applied.configuration.id,
    name: applied.configuration.name,
    partId: rootPartId,
  };
  return {
    authoredDocument,
    effectiveDocument: applied.project,
    configuration,
    effectiveDocumentHash: studioV5CanonicalHash(applied.project),
  };
}

async function rebuildV5(request) {
  const context = effectiveConfiguredRootDocument(request.document);
  const preparedRequest = { ...request, document: context.authoredDocument };
  if (context.authoredDocument.rootDocument?.kind === 'assembly') return rebuildV5Assembly(preparedRequest);
  const contextDisplayProject = studioAssemblyEditContextDisplayProject(context.effectiveDocument);
  if (contextDisplayProject) {
    return rebuildV5Assembly({
      ...preparedRequest,
      document: contextDisplayProject,
      editContext: structuredClone(context.authoredDocument.metadata.editContext),
    });
  }
  const previousCache = currentBodyCache;
  const built = await buildV5Document(context.effectiveDocument, { cache: previousCache, previousCache });
  const nextCache = new Map();
  const rejectedBuildResults = [];
  const serializationFailuresByBodyId = new Map();
  const bodies = [];
  const transfer = [];
  for (const body of built.part.bodies) {
    const result = built.results.get(body.id);
    let serialized = { mesh: null, transfer: [], exactBrep: null };
    let serializationError = null;
    try {
      serialized = !body.suppressed && result?.shape
        ? serializeShape(result.shape, result.names, {
            includeExactBrep: request.includeExactBrep === true,
            requirePersistentTopology: true,
            testOnlyDisplayHashCollision: testOnlyDisplayHashCollisionFor(request, body.id),
          })
        : serialized;
    } catch (error) {
      serializationError = bodySerializationFailure(body, error);
      appendBodyScopedError(built.errors, serializationError);
      serializationFailuresByBodyId.set(body.id, serializationError);
      rejectedBuildResults.push({ cacheKey: body.id, result });
    }
    if (!serializationError) {
      if (result?.shape && !result.error) nextCache.set(body.id, result);
      else retainPrivateFailureCheckpoint(nextCache, previousCache, body.id, result);
    }
    transfer.push(...serialized.transfer);
    bodies.push({
      bodyId: body.id,
      bodyName: body.name,
      sourceBodyId: body.id,
      sourceKey: built.part.id + ':' + body.id,
      renderSourceKey: built.part.id + ':' + body.id,
      kind: body.kind,
      visible: body.visible,
      suppressed: body.suppressed,
      mesh: serialized.mesh,
      ...(request.includeExactBrep === true && serialized.exactBrep ? { exactBrep: serialized.exactBrep } : {}),
      geometry: serializationError ? null : result?.geometry || null,
      ...(!serializationError && result?.kernelRobustnessEvidence?.length
        ? { kernelRobustnessEvidence: currentKernelRobustnessEvidence(
            result.kernelRobustnessEvidence,
            context.effectiveDocumentHash,
          ) }
        : {}),
      ...(!serializationError && result?.threadEvidence?.length
        ? { threadEvidence: currentThreadEvidence(
            result.threadEvidence,
            context.effectiveDocumentHash,
          ) }
        : {}),
      error: serializationError || result?.error || null,
      lastValid: serializationError ? false : Boolean(result?.lastValid),
    });
  }
  for (const result of built.patternResults.values()) {
    const body = result.body;
    const fused = body.patternInstance?.fused === true;
    const ownsGeometry = fused || result.rendersOwnGeometry === true;
    const shared = result.sharesSourceGeometry === true;
    let serialized = { mesh: null, transfer: [], exactBrep: null };
    let serializationError = null;
    const sourceSerializationError = serializationFailuresByBodyId.get(body.patternInstance.sourceBodyId);
    if (!ownsGeometry && sourceSerializationError) {
      serializationError = {
        bodyId: body.id,
        featureId: body.patternInstance.patternId,
        featureType: 'pattern',
        code: sourceSerializationError.code,
        stage: 'serialization',
        message: 'Pattern occurrence requires source body "' + body.patternInstance.sourceBodyId
          + '", whose display topology is ambiguous; no geometry was published.',
      };
      appendBodyScopedError(built.errors, serializationError);
      rejectedBuildResults.push({ cacheKey: body.id, result });
    } else {
      try {
        serialized = ownsGeometry && !body.suppressed && result?.shape
          ? serializeShape(result.shape, result.names || null, {
              includeExactBrep: request.includeExactBrep === true,
              requirePersistentTopology: true,
              testOnlyDisplayHashCollision: testOnlyDisplayHashCollisionFor(request, body.id),
            })
          : serialized;
      } catch (error) {
        serializationError = bodySerializationFailure(body, error);
        appendBodyScopedError(built.errors, serializationError);
        rejectedBuildResults.push({ cacheKey: body.id, result });
      }
    }
    if (!serializationError) {
      if (result?.shape && !result.error) nextCache.set(body.id, result);
      else retainPrivateFailureCheckpoint(nextCache, previousCache, body.id, result);
    }
    transfer.push(...serialized.transfer);
    bodies.push({
      bodyId: body.id,
      bodyName: body.name,
      sourceBodyId: body.patternInstance.sourceBodyId,
      sourceKey: built.part.id + ':' + (ownsGeometry ? body.id : body.patternInstance.sourceBodyId),
      renderSourceKey: built.part.id + ':' + (ownsGeometry ? body.id : body.patternInstance.sourceBodyId),
      kind: body.kind,
      visible: body.visible,
      suppressed: body.suppressed,
      patternInstance: body.patternInstance,
      mesh: serialized.mesh,
      ...(!ownsGeometry && !serializationError ? { renderSourceBodyId: body.patternInstance.sourceBodyId, renderTransform: sceneRenderMatrix(result.renderTransform || identityMatrix()) } : {}),
      sharesSourceGeometry: serializationError ? false : shared,
      ...(request.includeExactBrep === true && serialized.exactBrep ? { exactBrep: serialized.exactBrep } : {}),
      geometry: serializationError ? null : result?.geometry || null,
      error: serializationError || result?.error || null,
      lastValid: serializationError ? false : Boolean(result?.lastValid),
    });
  }
  for (const { cacheKey, result } of rejectedBuildResults) {
    disposeRejectedBuildResult(result, previousCache.get(cacheKey));
  }
  for (const [bodyId, entry] of previousCache) {
    if (nextCache.get(bodyId)?.shape !== entry.shape) {
      safeDelete(entry.shape);
      disposeCachedNameData(entry);
    }
  }
  currentBodyCache = nextCache;
  currentRevision = request.revision;
  if (request.delayMs) await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(0, request.delayMs))));
  self.postMessage({
    kind: 'rebuild-result',
    requestId: request.requestId,
    projectId: request.projectId,
    revision: request.revision,
    bodies,
    errors: built.errors,
    warnings: built.warnings || [],
    evaluation: built.trace,
    configuration: context.configuration,
    effectiveDocumentHash: context.effectiveDocumentHash,
  }, transfer);
}

async function rebuildV5Assembly(request) {
  const previousRevision = currentRevision;
  const previousCache = currentBodyCache;
  const solutionKey = assemblySolutionCacheKey(request.document);
  const built = await buildV5Assembly(request.document, {
    cache: previousCache,
    previousCache,
    previousSolutions: previousAssemblySolutionsFor(request.document),
  });
  const nextCache = new Map();
  for (const partBuild of built.partBuilds.values()) {
    for (const body of partBuild.part.bodies) {
      const result = partBuild.results.get(body.id);
      const cacheKey = partBuild.variantKey + ':' + body.id;
      if (result?.shape && !result.error) nextCache.set(cacheKey, result);
      else retainPrivateFailureCheckpoint(nextCache, previousCache, cacheKey, result);
    }
    for (const result of partBuild.patternResults.values()) {
      const cacheKey = partBuild.variantKey + ':' + result.body.id;
      if (result?.shape && !result.error) nextCache.set(cacheKey, result);
      else retainPrivateFailureCheckpoint(nextCache, previousCache, cacheKey, result);
    }
  }
  const templateBodyIds = new Map();
  const knownRenderSourceKeys = new Set(
    (Array.isArray(request.knownRenderSourceKeys) ? request.knownRenderSourceKeys : [])
      .filter((sourceKey) => typeof sourceKey === 'string' && sourceKey.length <= 4096)
      .slice(0, 10_000),
  );
  const renderCacheAcknowledged = Number.isInteger(request.knownRenderCacheRevision)
    && request.knownRenderCacheRevision === previousRevision;
  const bodies = [];
  const transfer = [];
  let serializationCompleted = false;
  try {
    for (const runtime of built.runtimeBodies) {
      const templateBodyId = templateBodyIds.get(runtime.sourceKey);
      let serialized = { mesh: null, transfer: [], exactBrep: null };
      if (!templateBodyId && runtime.renderShape
          && (previousRevision < 0
            || !renderCacheAcknowledged
            || !runtime.reused
            || !knownRenderSourceKeys.has(runtime.sourceKey)
            || request.includeExactBrep === true)) {
        serialized = serializeShape(runtime.renderShape, runtime.renderNames || null, {
          includeExactBrep: request.includeExactBrep === true,
          requirePersistentTopology: true,
        });
        transfer.push(...serialized.transfer);
      }
      if (!templateBodyId) templateBodyIds.set(runtime.sourceKey, runtime.bodyId);
      bodies.push({
        bodyId: runtime.bodyId,
        bodyName: runtime.bodyName,
        kind: runtime.kind,
        visible: runtime.visible,
        suppressed: runtime.suppressed,
        occurrenceInstance: runtime.occurrenceInstance,
        patternInstance: runtime.patternInstance || null,
        sourceBodyId: runtime.sourceBodyId,
        sourceKey: runtime.sourceKey,
        renderSourceKey: runtime.sourceKey,
        ...(runtime.assemblyFeatureIds?.length
          ? { assemblyFeatureIds: [...runtime.assemblyFeatureIds] }
          : {}),
        mesh: serialized.mesh,
        ...(request.includeExactBrep === true && serialized.exactBrep ? { exactBrep: serialized.exactBrep } : {}),
        ...(templateBodyId ? { renderSourceBodyId: templateBodyId, sharesSourceGeometry: true } : {}),
        renderTransform: sceneRenderMatrix(runtime.renderTransform || identityMatrix()),
        geometry: runtime.geometry,
        error: runtime.error,
        lastValid: runtime.lastValid,
      });
    }
    serializationCompleted = true;
  } finally {
    // Runtime meshes and optional B-rep bytes are detached message data. The
    // occurrence overlays are private to this rebuild and must be released on
    // both success and serialization refusal. A failed serialization also
    // cannot publish the newly built source shapes into the retained cache.
    disposeAssemblyFeatureOverlays(built);
    if (!serializationCompleted) disposeV5Build(built);
  }
  for (const [bodyId, entry] of previousCache) if (nextCache.get(bodyId)?.shape !== entry.shape) { safeDelete(entry.shape); disposeCachedNameData(entry); }
  currentBodyCache = nextCache;
  if (!built.solution.errors.length) {
    currentAssemblySolutions = collectAssemblySolutions(built.solution);
    currentAssemblySolutionKey = solutionKey;
  } else if (currentAssemblySolutionKey !== solutionKey) {
    currentAssemblySolutions = new Map();
    currentAssemblySolutionKey = null;
  }
  currentRevision = request.revision;
  if (request.delayMs) await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(0, request.delayMs))));
  self.postMessage({
    kind: 'rebuild-result',
    requestId: request.requestId,
    projectId: request.projectId,
    revision: request.revision,
    bodies,
    errors: built.errors,
    warnings: built.warnings || [],
    evaluation: built.trace,
    effectiveDocumentHash: built.trace.effectiveDocumentHash,
  }, transfer);
}

async function validateV5(request) {
  const context = effectiveConfiguredRootDocument(request.document);
  const preparedRequest = { ...request, document: context.authoredDocument };
  if (context.authoredDocument.rootDocument?.kind === 'assembly') return validateV5Assembly(preparedRequest);
  const built = await buildV5Document(context.effectiveDocument, { cache: currentBodyCache, previousCache: currentBodyCache });
  const bodies = built.part.bodies.map((body) => {
    const result = built.results.get(body.id);
    return {
      bodyId: body.id,
      bodyName: body.name,
      suppressed: body.suppressed,
      geometry: result?.geometry || null,
      error: result?.error || null,
    };
  });
  for (const result of built.patternResults.values()) {
    bodies.push({
      bodyId: result.body.id,
      bodyName: result.body.name,
      patternInstance: result.body.patternInstance,
      suppressed: result.body.suppressed,
      geometry: result.geometry || null,
      error: result.error || null,
    });
  }
  disposeV5Build(built);
  if (request.delayMs) await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(0, request.delayMs))));
  self.postMessage({
    kind: 'validation-result',
    requestId: request.requestId,
    projectId: request.projectId,
    revision: request.revision,
    bodies,
    errors: built.errors,
    warnings: built.warnings || [],
    evaluation: built.trace,
    configuration: context.configuration,
    effectiveDocumentHash: context.effectiveDocumentHash,
  });
}

async function validateV5Assembly(request) {
  const built = await buildV5Assembly(request.document, {
    cache: currentBodyCache,
    previousCache: currentBodyCache,
    previousSolutions: previousAssemblySolutionsFor(request.document),
  });
  const bodies = built.runtimeBodies.map((runtime) => ({
    bodyId: runtime.bodyId,
    bodyName: runtime.bodyName,
    sourceBodyId: runtime.sourceBodyId,
    visible: runtime.visible,
    occurrenceInstance: runtime.occurrenceInstance,
    patternInstance: runtime.patternInstance || null,
    ...(runtime.assemblyFeatureIds?.length
      ? { assemblyFeatureIds: [...runtime.assemblyFeatureIds] }
      : {}),
    suppressed: runtime.suppressed,
    geometry: runtime.geometry,
    error: runtime.error,
  }));
  disposeV5Build(built);
  if (request.delayMs) await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(0, request.delayMs))));
  self.postMessage({
    kind: 'validation-result', requestId: request.requestId, projectId: request.projectId, revision: request.revision,
    bodies, errors: built.errors, warnings: built.warnings || [], evaluation: built.trace,
    effectiveDocumentHash: built.trace.effectiveDocumentHash,
  });
}

function inspectionMaterial(document, runtime) {
  const partId = runtime.occurrenceInstance?.definition?.partId || document.rootDocument?.partId;
  const part = document.partDefinitions.find((entry) => entry.id === partId);
  const body = part?.bodies.find((entry) => entry.id === runtime.sourceBodyId || entry.id === runtime.bodyId);
  const material = body?.materialId ? document.materials.find((entry) => entry.id === body.materialId) : null;
  return { part, body, material };
}

function evaluateSavedMeasurement(measurement, placedByBodyId) {
  const definition = measurement.definition || {};
  const body = (bodyId) => {
    const entry = placedByBodyId.get(bodyId);
    if (!entry) throw new Error('Referenced measurement body "' + bodyId + '" no longer exists.');
    return entry;
  };
  const referencePoint = (reference) => {
    const local = reference?.signature?.p;
    if (!Array.isArray(local) || local.length !== 3 || local.some((value) => !Number.isFinite(Number(value)))) throw new Error('Measurement point signature is invalid.');
    return reference.bodyId ? studioV5TransformPoint(body(reference.bodyId).runtime.exactPlacement || assemblyIdentityMatrix(), local.map(Number)) : local.map(Number);
  };
  const referenceNormal = (reference) => {
    const local = reference?.signature?.n;
    if (!Array.isArray(local) || local.length !== 3) throw new Error('Measurement face normal is invalid.');
    const transformed = reference.bodyId ? studioV5TransformVector(body(reference.bodyId).runtime.exactPlacement || assemblyIdentityMatrix(), local.map(Number)) : local.map(Number);
    const magnitude = Math.hypot(...transformed);
    if (!(magnitude > 1e-12)) throw new Error('Measurement direction is zero length.');
    return transformed.map((value) => value / magnitude);
  };
  const result = { id: measurement.id, name: measurement.name, kind: measurement.kind, valid: true };
  const references = definition.references || [];
  if (measurement.kind === 'coordinate') return { ...result, value: referencePoint(references[0]), unit: 'mm' };
  if (measurement.kind === 'point-distance') {
    const left = referencePoint(references[0]); const right = referencePoint(references[1]);
    return { ...result, value: Math.hypot(...left.map((value, index) => value - right[index])), unit: 'mm' };
  }
  if (measurement.kind === 'edge-length') return { ...result, value: Number(references[0]?.signature?.l), unit: 'mm' };
  if (measurement.kind === 'radius' || measurement.kind === 'diameter') {
    const radius = Number(references[0]?.signature?.r);
    if (!(radius > 0)) throw new Error('Referenced circular edge no longer has a valid radius.');
    return { ...result, value: measurement.kind === 'diameter' ? radius * 2 : radius, unit: 'mm' };
  }
  if (measurement.kind === 'face-angle') {
    const left = referenceNormal(references[0]); const right = referenceNormal(references[1]);
    const cosine = Math.max(-1, Math.min(1, left.reduce((total, value, index) => total + value * right[index], 0)));
    return { ...result, value: Math.acos(cosine) * 180 / Math.PI, unit: 'deg' };
  }
  if (measurement.kind === 'wall-thickness') {
    const left = referencePoint(references[0]); const right = referencePoint(references[1]); const normal = referenceNormal(references[0]);
    const delta = right.map((value, index) => value - left[index]);
    return { ...result, value: Math.abs(delta.reduce((total, value, index) => total + value * normal[index], 0)), unit: 'mm' };
  }
  if (measurement.kind === 'bounding-box') {
    const bounds = body(definition.bodyIds[0]).properties.bounds;
    return { ...result, value: bounds[0].map((value, axis) => bounds[1][axis] - value), coordinates: bounds, unit: 'mm' };
  }
  if (measurement.kind === 'minimum-clearance') {
    const left = body(definition.bodyIds[0]); const right = body(definition.bodyIds[1]);
    const distanceTool = new rc.DistanceTool();
    try { return { ...result, value: distanceTool.distanceBetween(left.shape, right.shape), unit: 'mm' }; }
    finally { distanceTool.delete(); }
  }
  throw new Error('Measurement kind is unsupported.');
}

function disposeV5Build(built) {
  disposeAssemblyFeatureOverlays(built);
  const disposed = new Set();
  const builds = built.partBuilds ? [...built.partBuilds.values()] : [built];
  for (const partBuild of builds) for (const result of [...partBuild.results.values(), ...partBuild.patternResults.values()]) {
    if (result.shape && !result.reused && !result.lastValid && !disposed.has(result.shape)) { disposed.add(result.shape); safeDelete(result.shape); }
  }
}

function disposeAssemblyFeatureOverlays(built) {
  const disposedShapes = new Set();
  const disposedNames = new Set();
  for (const result of built?.ownedRuntimeResults || []) {
    if (result?.shape && !disposedShapes.has(result.shape)) {
      disposedShapes.add(result.shape);
      safeDelete(result.shape);
    }
    if (result?.names && !disposedNames.has(result.names)) {
      disposedNames.add(result.names);
      disposeNameTable(result.names);
    }
  }
  if (built) built.ownedRuntimeResults = [];
}

async function inspectV5(request) {
  await loadKernel();
  if (request.document?.schemaVersion !== 5) throw new Error('Engineering inspection requires a schema-5 project.');
  let built;
  let runtimes;
  let inspectedDocument = request.document;
  let configuration = null;
  let effectiveDocumentHash = studioV5CanonicalHash(request.document);
  if (request.document.rootDocument?.kind === 'assembly') {
    built = await buildV5Assembly(request.document, {
      cache: currentBodyCache,
      previousCache: currentBodyCache,
      previousSolutions: previousAssemblySolutionsFor(request.document),
    });
    runtimes = built.runtimeBodies;
  } else {
    const context = effectiveConfiguredRootDocument(request.document);
    inspectedDocument = context.effectiveDocument;
    configuration = context.configuration;
    effectiveDocumentHash = context.effectiveDocumentHash;
    built = await buildV5Document(inspectedDocument, { cache: currentBodyCache, previousCache: currentBodyCache });
    runtimes = [
      ...built.part.bodies.map((body) => {
        const result = built.results.get(body.id);
        return { bodyId: body.id, bodyName: body.name, sourceBodyId: body.id, sourceKey: built.part.id + ':' + body.id, visible: result?.body?.visible ?? body.visible, suppressed: body.suppressed, consumed: Boolean(result?.body?.extensions?.consumedByFeatureId), exactShape: result?.shape, exactPlacement: assemblyIdentityMatrix(), renderShape: result?.shape, renderTransform: assemblyIdentityMatrix(), geometry: result?.geometry, error: result?.error };
      }),
      ...[...built.patternResults.values()].map((result) => ({
        bodyId: result.body.id, bodyName: result.body.name, sourceBodyId: result.body.patternInstance.sourceBodyId,
        sourceKey: built.part.id + ':' + ((result.body.patternInstance?.fused || result.rendersOwnGeometry === true) ? result.body.id : result.body.patternInstance.sourceBodyId),
        visible: result.body.visible, suppressed: result.body.suppressed, exactShape: result.shape, exactPlacement: assemblyIdentityMatrix(),
        renderShape: (result.body.patternInstance?.fused || result.rendersOwnGeometry === true) ? result.shape : built.results.get(result.body.patternInstance.sourceBodyId)?.shape,
        renderTransform: (result.body.patternInstance?.fused || result.rendersOwnGeometry === true) ? assemblyIdentityMatrix() : result.renderTransform || assemblyIdentityMatrix(),
        geometry: result.geometry, error: result.error,
      })),
    ];
  }
  const requested = Array.isArray(request.bodyIds) && request.bodyIds.length ? new Set(request.bodyIds) : null;
  const candidates = runtimes.filter((runtime) => (!requested || requested.has(runtime.bodyId)) && !runtime.suppressed && !runtime.consumed);
  const selected = candidates.filter((runtime) => runtime.exactShape);
  const errors = [...(built.errors || [])]
    .filter((error) => !requested || !error.bodyId || requested.has(error.bodyId));
  if (!selected.length) errors.push({ featureType: 'inspection', message: 'Select at least one valid unsuppressed body or component.' });
  if (requested) for (const bodyId of requested) if (!runtimes.some((runtime) => runtime.bodyId === bodyId)) errors.push({ bodyId, featureType: 'inspection', message: 'Selected inspection body no longer exists.' });
  for (const runtime of candidates) if (!runtime.exactShape && !errors.some((error) => error.bodyId === runtime.bodyId)) {
    errors.push({ bodyId: runtime.bodyId, featureType: 'inspection', message: 'Selected body has no exact geometry to inspect.' });
  }
  const placed = [];
  const collisionMeshes = new Map();
  try {
    for (const runtime of selected) {
      const shape = applyRigidMatrix(runtime.exactShape, runtime.exactPlacement || assemblyIdentityMatrix());
      const physical = shapePhysicalProperties(shape, { includeInertia: true });
      const { part, body, material } = inspectionMaterial(inspectedDocument, runtime);
      const densityKgM3 = material?.densityKgM3 ?? null;
      const volumeInertia = inertiaSummary(physical.volumeInertiaTensor, physical.volume);
      const massKg = densityKgM3 == null ? null : physical.volume * 1e-9 * densityKgM3;
      const massInertia = massKg == null
        ? null
        : inertiaSummary(scaleInertiaTensor(physical.volumeInertiaTensor, densityKgM3 * 1e-9), massKg);
      let envelope = null;
      if (request.mode === 'interference') {
        const collisionKey = runtime.sourceKey || runtime.sourceBodyId || runtime.bodyId;
        let mesh = collisionMeshes.get(collisionKey);
        if (!mesh) {
          mesh = collisionMesh(runtime.renderShape || runtime.exactShape);
          collisionMeshes.set(collisionKey, mesh);
        }
        envelope = collisionEnvelope(mesh, runtime.renderTransform || runtime.exactPlacement || assemblyIdentityMatrix());
      }
      placed.push({
        runtime, shape,
        orientedBounds: orientedBounds(
          runtime.renderShape || runtime.exactShape,
          runtime.renderTransform || runtime.exactPlacement || assemblyIdentityMatrix(),
          Number(request.tolerance) || 1e-7,
        ),
        collisionEnvelope: envelope,
        properties: {
          bodyId: runtime.bodyId,
          bodyName: runtime.bodyName,
          occurrencePath: runtime.occurrenceInstance?.occurrencePath || [],
          partId: part?.id || null,
          sourceBodyId: body?.id || runtime.sourceBodyId || runtime.bodyId,
          volumeMm3: physical.volume,
          surfaceAreaMm2: physical.surfaceArea,
          centerOfMassMm: physical.centerOfMass,
          inertiaReferencePointMm: physical.centerOfMass,
          volumeInertiaTensorMm5: volumeInertia.tensor,
          principalVolumeMomentsMm5: volumeInertia.principalMoments,
          principalAxes: volumeInertia.principalAxes,
          radiiOfGyrationMm: volumeInertia.radiiOfGyration,
          massKg,
          massInertiaTensorKgMm2: massInertia?.tensor ?? null,
          principalMomentsKgMm2: massInertia?.principalMoments ?? null,
          densityKgM3,
          materialId: material?.id || null,
          materialName: material?.name || null,
          health: {
            valid: runtime.geometry?.valid === true && !runtime.error,
            brepValid: runtime.geometry?.brepValid === true,
            solidCount: runtime.geometry?.solidCount ?? solidCount(shape),
            shellCount: runtime.geometry?.shellCount ?? topologyCount(shape, 'shell'),
            faceCount: runtime.geometry?.faceCount ?? topologyCount(shape, 'face'),
            edgeCount: runtime.geometry?.edgeCount ?? topologyCount(shape, 'edge'),
            vertexCount: runtime.geometry?.vertexCount ?? topologyCount(shape, 'vertex'),
            freeEdgeCount: runtime.geometry?.valid ? 0 : null,
            nonManifold: runtime.geometry?.brepValid === false,
            recoveredLastValid: Boolean(runtime.lastValid || runtime.error),
          },
          bounds: shape.boundingBox?.bounds || null,
        },
      });
    }
    const properties = placed.map((entry) => entry.properties);
    const totalVolumeMm3 = properties.reduce((total, entry) => total + entry.volumeMm3, 0);
    const knownMass = properties.filter((entry) => entry.massKg != null);
    const knownMassKg = knownMass.reduce((total, entry) => total + entry.massKg, 0);
    const missingMaterialBodyIds = properties.filter((entry) => entry.massKg == null).map((entry) => entry.bodyId);
    const centerOfVolumeMm = [0, 1, 2].map((axis) => totalVolumeMm3 > 0
      ? properties.reduce((total, entry) => total + entry.centerOfMassMm[axis] * entry.volumeMm3, 0) / totalVolumeMm3
      : 0);
    const centerOfKnownMassMm = [0, 1, 2].map((axis) => knownMassKg > 0
      ? knownMass.reduce((total, entry) => total + entry.centerOfMassMm[axis] * entry.massKg, 0) / knownMassKg
      : null);
    const centerOfMassMm = missingMaterialBodyIds.length ? [null, null, null] : centerOfKnownMassMm;
    const emptyTensor = () => [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const volumeInertiaTensorMm5 = properties.reduce((tensor, entry) => addInertiaTensors(
      tensor,
      translatedInertiaTensor(entry.volumeInertiaTensorMm5, entry.volumeMm3, entry.centerOfMassMm, centerOfVolumeMm),
    ), emptyTensor());
    const volumeInertia = inertiaSummary(volumeInertiaTensorMm5, totalVolumeMm3);
    const knownMassInertiaTensorKgMm2 = knownMassKg > 0
      ? knownMass.reduce((tensor, entry) => addInertiaTensors(
        tensor,
        translatedInertiaTensor(entry.massInertiaTensorKgMm2, entry.massKg, entry.centerOfMassMm, centerOfKnownMassMm),
      ), emptyTensor())
      : null;
    const knownMassInertia = knownMassInertiaTensorKgMm2
      ? inertiaSummary(knownMassInertiaTensorKgMm2, knownMassKg)
      : null;
    const massInertia = missingMaterialBodyIds.length ? null : knownMassInertia;
    const pairs = [];
    let broadPhasePairs = 0;
    const exactPairCache = new Map();
    const broadPhaseClassKeys = new Set();
    if (request.mode === 'interference' || request.mode === 'clearance') {
      const pairFilter = Array.isArray(request.pairBodyIds) && request.pairBodyIds.length === 2 ? new Set(request.pairBodyIds) : null;
      for (let leftIndex = 0; leftIndex < placed.length; leftIndex++) {
        const left = placed[leftIndex];
        const candidates = [];
        for (let rightIndex = leftIndex + 1; rightIndex < placed.length; rightIndex++) {
          const right = placed[rightIndex];
          if (pairFilter && (!pairFilter.has(left.runtime.bodyId) || !pairFilter.has(right.runtime.bodyId))) continue;
          const overlaps = boundsOverlap(left.shape, right.shape, Number(request.tolerance) || 0)
            && orientedBoundsOverlap(left.orientedBounds, right.orientedBounds)
            && collisionEnvelopesOverlap(left.collisionEnvelope, right.collisionEnvelope);
          const equivalenceKey = overlaps ? interferenceEquivalenceKey(left, right) : null;
          if (overlaps) {
            broadPhasePairs++;
            if (equivalenceKey) broadPhaseClassKeys.add(equivalenceKey);
            candidates.push({ index: rightIndex, entry: right, equivalenceKey });
          }
          if (request.mode === 'clearance' && !overlaps) candidates.push({ index: rightIndex, entry: right, equivalenceKey: null });
        }
        if (request.mode === 'interference') {
          const uncached = candidates.filter((candidate) => !candidate.equivalenceKey || !exactPairCache.has(candidate.equivalenceKey));
          const batchVolumes = batchInterferenceVolumes(left, uncached, Number(request.tolerance) || 0);
          for (const candidate of uncached) if (candidate.equivalenceKey) {
            exactPairCache.set(candidate.equivalenceKey, { interferenceVolumeMm3: batchVolumes.get(candidate.index) || 0 });
          }
          for (const candidate of candidates) {
            const interferenceVolumeMm3 = candidate.equivalenceKey && exactPairCache.has(candidate.equivalenceKey)
              ? exactPairCache.get(candidate.equivalenceKey).interferenceVolumeMm3
              : batchVolumes.get(candidate.index) || 0;
            pairs.push({
              leftBodyId: left.runtime.bodyId, rightBodyId: candidate.entry.runtime.bodyId,
              leftOccurrencePath: left.runtime.occurrenceInstance?.occurrencePath || [], rightOccurrencePath: candidate.entry.runtime.occurrenceInstance?.occurrencePath || [],
              interferenceVolumeMm3, minimumClearanceMm: 0,
            });
          }
          continue;
        }
        const distanceQuery = new rc.DistanceQuery(left.shape);
        try {
          for (const candidate of candidates) {
            let minimumClearanceMm = null;
            try { minimumClearanceMm = distanceQuery.distanceTo(candidate.entry.shape); } catch {}
            let interferenceVolumeMm3 = 0;
            if (candidate.equivalenceKey && minimumClearanceMm != null && minimumClearanceMm <= Math.max(1e-7, Number(request.tolerance) || 0)) {
              interferenceVolumeMm3 = exactIntersectionVolume(left, candidate.entry);
            }
            pairs.push({
              leftBodyId: left.runtime.bodyId, rightBodyId: candidate.entry.runtime.bodyId,
              leftOccurrencePath: left.runtime.occurrenceInstance?.occurrencePath || [], rightOccurrencePath: candidate.entry.runtime.occurrenceInstance?.occurrencePath || [],
              interferenceVolumeMm3, minimumClearanceMm,
            });
          }
        } finally {
          distanceQuery.delete();
        }
      }
    }
    const measurementResults = [];
    if (request.mode === 'measurements') {
      const saved = request.document.rootDocument?.kind === 'assembly'
        ? request.document.assemblyDefinitions.find((entry) => entry.id === request.document.rootDocument.assemblyId)?.metadata?.measurements || []
        : [];
      const placedByBodyId = new Map(placed.map((entry) => [entry.runtime.bodyId, entry]));
      for (const measurement of saved.filter((entry) => entry.visible !== false)) {
        try { measurementResults.push(evaluateSavedMeasurement(measurement, placedByBodyId)); }
        catch (error) { measurementResults.push({ id: measurement.id, name: measurement.name, kind: measurement.kind, valid: false, error: String(error?.message || error) }); }
      }
    }
    self.postMessage({
      kind: 'inspection-result', requestId: request.requestId, projectId: request.projectId, revision: request.revision,
      errors,
      inspection: {
        mode: request.mode || 'properties',
        revisionKey: effectiveDocumentHash,
        effectiveDocumentHash,
        configuration,
        bodyCount: properties.length,
        properties,
        aggregate: {
          volumeMm3: totalVolumeMm3,
          surfaceAreaMm2: properties.reduce((total, entry) => total + entry.surfaceAreaMm2, 0),
          massKg: missingMaterialBodyIds.length ? null : knownMassKg,
          knownMassKg,
          centerOfVolumeMm,
          centerOfMassMm,
          centerOfKnownMassMm,
          inertiaReferencePointMm: centerOfMassMm,
          volumeInertiaTensorMm5: volumeInertia.tensor,
          principalVolumeMomentsMm5: volumeInertia.principalMoments,
          volumePrincipalAxes: volumeInertia.principalAxes,
          knownMassInertiaTensorKgMm2: knownMassInertia?.tensor ?? null,
          knownMassInertiaReferencePointMm: knownMassKg > 0 ? centerOfKnownMassMm : null,
          knownPrincipalMomentsKgMm2: knownMassInertia?.principalMoments ?? null,
          knownPrincipalAxes: knownMassInertia?.principalAxes ?? null,
          knownRadiiOfGyrationMm: knownMassInertia?.radiiOfGyration ?? null,
          massInertiaTensorKgMm2: massInertia?.tensor ?? null,
          principalMomentsKgMm2: massInertia?.principalMoments ?? null,
          principalAxes: massInertia?.principalAxes ?? null,
          radiiOfGyrationMm: massInertia?.radiiOfGyration ?? null,
          missingMaterialBodyIds,
          valid: errors.length === 0 && properties.every((entry) => entry.health.valid),
        },
        broadPhasePairs,
        broadPhaseClassCount: broadPhaseClassKeys.size,
        exactPairClassCount: exactPairCache.size,
        pairs,
        measurementResults,
      },
    });
  } finally {
    for (const entry of placed) safeDelete(entry.shape);
    disposeV5Build(built);
  }
}

function resolvedPartDrawingManifest(document, part, context) {
  const recipe = part.extensions?.partmodeDrawing;
  if (recipe == null) return null;
  if (!recipe || recipe.schema !== 'partmode.part-drawing/v1' || typeof recipe.id !== 'string') {
    throw new Error('Part drawing recipe is missing a supported schema and stable id.');
  }
  if (recipe.displayUnits !== 'in' && recipe.displayUnits !== 'mm') {
    throw new Error('Part drawing recipe displayUnits must be "in" or "mm".');
  }
  if (!context.configuration?.id) throw new Error('Configuration-driven part drawing has no active configuration.');
  const configurationData = recipe.configurationData?.[context.configuration.id];
  if (!configurationData || typeof configurationData !== 'object') {
    throw new Error('Part drawing has no data for active configuration "' + context.configuration.id + '".');
  }
  if (!Array.isArray(configurationData.dimensions) || !configurationData.dimensions.length) {
    throw new Error('Part drawing active configuration has no authored dimensions.');
  }
  const dimensionIds = new Set();
  for (const dimension of configurationData.dimensions) {
    if (!dimension?.id || dimensionIds.has(dimension.id)) throw new Error('Part drawing dimension ids are missing or ambiguous.');
    dimensionIds.add(dimension.id);
  }
  const profile = part.sketches.find((sketch) => sketch.id === recipe.profileSketchId);
  if (profile?.extensions?.studioRole !== 'profile' || profile.entities?.length !== 1 || !Array.isArray(profile.entities[0].points)) {
    throw new Error('Part drawing section profile does not resolve to one editable profile sketch.');
  }
  const { strict: N } = evaluator(document, part);
  const sectionProfileMm = profile.entities[0].points.map((point) => point.map((value) => N(value)));
  if (sectionProfileMm.some((point) => point.length !== 2 || point.some((value) => !Number.isFinite(value)))) {
    throw new Error('Part drawing section profile did not evaluate to finite 2D coordinates.');
  }
  const requiredViews = Array.isArray(recipe.requiredViews) && recipe.requiredViews.length
    ? [...new Set(recipe.requiredViews.map(String))]
    : ['front', 'right'];
  const supportedViews = new Set(['front', 'top', 'right', 'left', 'bottom', 'back', 'iso']);
  if (requiredViews.some((view) => !supportedViews.has(view))) throw new Error('Part drawing requests an unsupported exact projection.');
  const notes = Array.isArray(recipe.notes) ? structuredClone(recipe.notes) : [];
  const noteIds = new Set();
  for (const note of notes) {
    if (!note?.id || typeof note.text !== 'string' || noteIds.has(note.id)) throw new Error('Part drawing note ids or text are invalid.');
    noteIds.add(note.id);
  }
  return {
    ...structuredClone(configurationData),
    schema: recipe.schema,
    id: recipe.id,
    displayUnits: recipe.displayUnits,
    authoredDate: String(recipe.authoredDate || ''),
    requiredViews,
    configuration: structuredClone(context.configuration),
    effectiveDocumentHash: context.effectiveDocumentHash,
    partId: part.id,
    notes,
    symbols: structuredClone(recipe.symbols || {}),
    sectionProfileMm,
    limitations: structuredClone(part.extensions?.as4395?.limitations || []),
    modelPolicy: String(part.extensions?.as4395?.modelPolicy || 'authored'),
    complianceStatus: String(part.extensions?.as4395?.complianceStatus || 'unspecified'),
  };
}

// Hidden-line-removed orthographic projections for a 2D drawing sheet. The
// heavy lifting is OCCT's HLR via replicad drawProjection; the client lays
// the returned per-view SVG paths out on a dimensioned sheet. Runs in a
// disposable worker (like exports) because HLR mutates global kernel state.
function normalizedDrawingViewRequests(value, document = null) {
  const source = Array.isArray(value) && value.length ? value : ['front', 'top', 'right', 'iso'];
  if (source.length > 16) throw new Error('Drawing supports at most sixteen exact views per request.');
  const standard = new Set(['front', 'top', 'right', 'left', 'bottom', 'back', 'iso']);
  const derivedKinds = new Set([
    'full-section', 'half-section', 'aligned-section', 'broken-out-section',
    'detail', 'auxiliary', 'crop', 'break',
  ]);
  const persistedNamed = new Map((document?.extensions?.drawingViews?.views || []).map((entry) => [entry.id, entry]));
  const persistedDerived = new Map((document?.extensions?.drawingViews?.derivedViews || []).map((entry) => [entry.id, entry]));
  const ids = new Set();
  const requests = source.map((entry) => {
    if (typeof entry === 'string') {
      if (!standard.has(entry)) throw new Error('Drawing requests an unsupported standard projection.');
      if (ids.has(entry)) throw new Error('Drawing projection ids must be unique.');
      ids.add(entry);
      return { id: entry, name: entry, standard: entry, direction: null, xAxis: null };
    }
    const id = String(entry?.id || '');
    const name = String(entry?.name || id);
    const derived = entry?.derived;
    const isDerived = /^drawing-derived-view-\d{6}$/u.test(id);
    if ((!isDerived && !/^drawing-view-\d{6}$/u.test(id)) || !name.trim() || name.length > 120 || ids.has(id)) {
      throw new Error('Drawing projection identity is invalid.');
    }
    const projectionStandard = entry?.standard == null ? null : String(entry.standard);
    let direction = null;
    let xAxis = null;
    if (projectionStandard != null) {
      if (!standard.has(projectionStandard)) throw new Error('Drawing projection source standard is invalid.');
    } else {
      direction = Array.isArray(entry?.direction) ? entry.direction.map(Number) : [];
      xAxis = Array.isArray(entry?.xAxis) ? entry.xAxis.map(Number) : [];
      if (direction.length !== 3 || xAxis.length !== 3 || [...direction, ...xAxis].some((number) => !Number.isFinite(number) || Math.abs(number) > 1_000_000)) {
        throw new Error('Named drawing projection identity or frame is invalid.');
      }
      const directionLength = Math.hypot(...direction);
      const xAxisLength = Math.hypot(...xAxis);
      const cosine = direction.reduce((sum, number, index) => sum + number * xAxis[index], 0) / Math.max(1e-12, directionLength * xAxisLength);
      if (directionLength < 1e-9 || xAxisLength < 1e-9 || Math.abs(cosine) > 1e-8) throw new Error('Named drawing projection frame must be non-zero and orthogonal.');
      direction = direction.map((number) => Math.round(number / directionLength * 1e12) / 1e12);
      xAxis = xAxis.map((number) => Math.round(number / xAxisLength * 1e12) / 1e12);
    }
    let exactDerived = null;
    if (isDerived) {
      const persisted = persistedDerived.get(id);
      const kind = String(derived?.kind || '');
      const sourceViewId = String(derived?.sourceViewId || '');
      if (!persisted || !derivedKinds.has(kind) || !sourceViewId || !derived?.definition
        || name.trim() !== persisted.name || kind !== persisted.kind || sourceViewId !== persisted.sourceViewId
        || stableSource(derived.definition) !== stableSource(persisted.definition)) {
        throw new Error('Derived drawing projection does not match its persistent current-document definition.');
      }
      let sourceFrameIdentity;
      if (standard.has(sourceViewId)) {
        if (projectionStandard !== sourceViewId || direction !== null || xAxis !== null) {
          throw new Error('Derived drawing projection camera does not match its persistent standard source view.');
        }
        sourceFrameIdentity = { sourceViewId, standard: sourceViewId };
      } else {
        const persistedSource = persistedNamed.get(sourceViewId);
        const persistedDirection = Array.isArray(persistedSource?.direction) ? persistedSource.direction.map(Number) : [];
        const persistedXAxis = Array.isArray(persistedSource?.xAxis) ? persistedSource.xAxis.map(Number) : [];
        const persistedDirectionLength = Math.hypot(...persistedDirection);
        const persistedXAxisLength = Math.hypot(...persistedXAxis);
        if (!/^drawing-view-\d{6}$/u.test(sourceViewId) || !persistedSource
          || persistedDirection.length !== 3 || persistedXAxis.length !== 3
          || [...persistedDirection, ...persistedXAxis].some((number) => !Number.isFinite(number))
          || persistedDirectionLength < 1e-9 || persistedXAxisLength < 1e-9) {
          throw new Error('Derived drawing projection has no valid persistent named source view.');
        }
        const normalizedPersistedDirection = persistedDirection.map((number) => Math.round(number / persistedDirectionLength * 1e12) / 1e12);
        const normalizedPersistedXAxis = persistedXAxis.map((number) => Math.round(number / persistedXAxisLength * 1e12) / 1e12);
        if (projectionStandard !== null
          || stableSource(direction) !== stableSource(normalizedPersistedDirection)
          || stableSource(xAxis) !== stableSource(normalizedPersistedXAxis)) {
          throw new Error('Derived drawing projection camera does not match its persistent named source view.');
        }
        sourceFrameIdentity = {
          sourceViewId,
          direction: normalizedPersistedDirection,
          xAxis: normalizedPersistedXAxis,
        };
      }
      exactDerived = {
        kind,
        sourceViewId,
        definition: structuredClone(persisted.definition),
        definitionHash: stableHash({ kind, sourceViewId, definition: persisted.definition }),
        sourceFrameHash: stableHash(sourceFrameIdentity),
      };
    } else if (derived != null) {
      throw new Error('Named drawing projections cannot carry derived-view definitions.');
    }
    ids.add(id);
    return {
      id, name: name.trim(), standard: projectionStandard, direction, xAxis,
      ...(exactDerived ? { derived: exactDerived } : {}),
    };
  });
  return requests;
}

const DRAWING_DERIVED_EVIDENCE_SCHEMA = 'partmode.drawing-derived-view-evidence/v1';
const DRAWING_HLR_PERFORMANCE_EVIDENCE_SCHEMA = 'partmode.drawing-hlr-performance/v1';

const DRAWING_STANDARD_FRAMES = Object.freeze({
  front: { direction: [0, -1, 0], xAxis: [1, 0, 0] },
  back: { direction: [0, 1, 0], xAxis: [-1, 0, 0] },
  right: { direction: [-1, 0, 0], xAxis: [0, -1, 0] },
  left: { direction: [1, 0, 0], xAxis: [0, 1, 0] },
  bottom: { direction: [0, 0, 1], xAxis: [1, 0, 0] },
  top: { direction: [0, 0, -1], xAxis: [1, 0, 0] },
});

const drawingRound = (value) => Math.round(Number(value) * 1e9) / 1e9;
const drawingScaleVector = (vector, factor) => vector.map((value) => value * factor);
const drawingAddVectors = (left, right) => left.map((value, index) => value + right[index]);

function drawingUnitVector(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => !Number.isFinite(Number(entry)))) {
    throw new Error(label + ' must be a finite 3D vector.');
  }
  const vector = value.map(Number);
  const length = Math.hypot(...vector);
  if (!(length > 1e-10)) throw new Error(label + ' must be non-zero.');
  return vector.map((entry) => drawingRound(entry / length));
}

function drawingPlaneDefinition(value, label) {
  const origin = Array.isArray(value?.origin) ? value.origin.map(Number) : [];
  const normal = drawingUnitVector(value?.normal, label + ' normal');
  const xAxis = drawingUnitVector(value?.xAxis, label + ' x-axis');
  const keepSide = String(value?.keepSide || 'positive');
  if (origin.length !== 3 || origin.some((entry) => !Number.isFinite(entry) || Math.abs(entry) > 1_000_000)
    || Math.abs(vectorDot(normal, xAxis)) > 1e-8 || !['positive', 'negative'].includes(keepSide)) {
    throw new Error(label + ' definition is invalid.');
  }
  return {
    origin: origin.map(drawingRound), normal, xAxis,
    yAxis: drawingUnitVector(vectorCross(normal, xAxis), label + ' y-axis'),
    keepSide,
  };
}

function drawingCamera(viewRequest) {
  if (viewRequest.standard === 'iso') return new rc.ProjectionCamera([0, 0, 0], [-1, -1, -1]);
  if (viewRequest.standard) {
    const frame = DRAWING_STANDARD_FRAMES[viewRequest.standard];
    if (!frame) throw new Error('Drawing projection source standard is invalid.');
    return new rc.ProjectionCamera([0, 0, 0], frame.direction, frame.xAxis);
  }
  return new rc.ProjectionCamera([0, 0, 0], viewRequest.direction, viewRequest.xAxis);
}

function drawingCameraFrame(camera) {
  let direction = null;
  let xAxis = null;
  let yAxis = null;
  try {
    direction = camera.direction;
    xAxis = camera.xAxis;
    yAxis = camera.yAxis;
    return {
      direction: drawingUnitVector(drawingEvidencePoint(direction), 'Drawing camera direction'),
      xAxis: drawingUnitVector(drawingEvidencePoint(xAxis), 'Drawing camera x-axis'),
      yAxis: drawingUnitVector(drawingEvidencePoint(yAxis), 'Drawing camera y-axis'),
    };
  } finally {
    safeDelete(direction); safeDelete(xAxis); safeDelete(yAxis);
  }
}

function drawingParseBox(value) {
  const parsed = String(value || '').trim().split(/\s+/u).map(Number);
  return parsed.length === 4 && parsed.every(Number.isFinite) && parsed[2] > 0 && parsed[3] > 0 ? parsed : null;
}

function drawingUnionBox(left, right) {
  if (!left) return right;
  if (!right) return left;
  const x = Math.min(left[0], right[0]);
  const y = Math.min(left[1], right[1]);
  return [x, y, Math.max(left[0] + left[2], right[0] + right[2]) - x, Math.max(left[1] + left[3], right[1] + right[3]) - y];
}

function drawingPaths(drawing) {
  return drawing ? drawing.toSVGPaths().flat(Infinity).filter(Boolean).map(String) : [];
}

const DRAWING_EDGE_CLASSES = Object.freeze([
  'visible', 'hidden', 'regularVisible', 'regularHidden', 'tangentVisible', 'tangentHidden',
]);

function drawingProjectionDrawings(shape, camera) {
  const projection = rc.drawProjectionWithEdgeClasses(shape, camera);
  return Object.fromEntries(DRAWING_EDGE_CLASSES.map((key) => [key, projection[key] || null]));
}

function drawingDrawingParts(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function drawingPayloadFromDrawings(drawings, extraBoxes = []) {
  const paths = {};
  let viewBox = null;
  for (const key of DRAWING_EDGE_CLASSES) {
    const parts = drawingDrawingParts(drawings[key]);
    paths[key] = parts.flatMap(drawingPaths);
    if (key === 'visible' || key === 'hidden') {
      for (const part of parts) {
        if (drawingPaths(part).length) viewBox = drawingUnionBox(viewBox, drawingParseBox(part.toSVGViewBox(0)));
      }
    }
  }
  for (const box of extraBoxes) viewBox = drawingUnionBox(viewBox, box);
  if (!viewBox || !paths.visible.length) throw new Error('Exact projection produced no drawable visible edges.');
  return {
    ...paths,
    viewBox,
    localBounds: [viewBox[0], -viewBox[1] - viewBox[3], viewBox[0] + viewBox[2], -viewBox[1]],
  };
}

function drawingProjectionPayload(shape, camera, options = {}) {
  const projection = drawingProjectionDrawings(shape, camera);
  const drawings = Object.fromEntries(DRAWING_EDGE_CLASSES.map((key) => {
    const drawing = projection[key];
    if (!drawing || !options.scale) return [key, drawing];
    return [key, drawing.scale(options.scale.factor, options.scale.center)];
  }));
  return drawingPayloadFromDrawings(drawings);
}

function drawingPathEvidence(payload) {
  const edgeClasses = Object.fromEntries(DRAWING_EDGE_CLASSES.map((key) => {
    const paths = Array.isArray(payload?.[key]) ? payload[key].map(String) : [];
    return [key, { pathCount: paths.length, pathHash: stableHash(paths) }];
  }));
  const orderedPaths = DRAWING_EDGE_CLASSES.flatMap((key) => Array.isArray(payload?.[key]) ? payload[key].map(String) : []);
  return {
    pathCount: orderedPaths.length,
    pathHash: stableHash(orderedPaths),
    viewBox: Array.isArray(payload?.viewBox) ? payload.viewBox.map(drawingRound) : null,
    edgeClasses,
  };
}

function drawingSectionPathEvidence(paths, box) {
  const normalized = Array.isArray(paths) ? paths.map(String) : [];
  return {
    pathCount: normalized.length,
    pathHash: stableHash(normalized),
    pathBounds: Array.isArray(box) ? box.map(drawingRound) : null,
  };
}

function drawingShapeEvidence(shape, label) {
  const oc = rc.getOC();
  let analyzer = null;
  let valid = false;
  try {
    analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
    valid = analyzer.IsValid_2();
  } finally { safeDelete(analyzer); }
  const evidence = {
    brepValid: Boolean(valid),
    solidCount: solidCount(shape),
    faceCount: topologyCount(shape, 'face'),
    edgeCount: topologyCount(shape, 'edge'),
    volumeMm3: drawingRound(shapeVolume(shape)),
    bounds: optimalShapeBounds(shape, label).map((corner) => corner.map(drawingRound)),
  };
  if (!evidence.brepValid || evidence.solidCount < 1 || !(evidence.volumeMm3 > 1e-8)) {
    throw new Error(label + ' is not a non-empty valid exact B-rep.');
  }
  return evidence;
}

function drawingBoundsCorners(bounds) {
  const [low, high] = bounds;
  const corners = [];
  for (const x of [low[0], high[0]]) for (const y of [low[1], high[1]]) for (const z of [low[2], high[2]]) corners.push([x, y, z]);
  return corners;
}

function drawingHalfspaceTool(shape, authoredPlane, label, options = {}) {
  const plane = drawingPlaneDefinition(authoredPlane, label);
  const toolPlane = options.complement
    ? { ...plane, keepSide: plane.keepSide === 'positive' ? 'negative' : 'positive' }
    : plane;
  const corners = drawingBoundsCorners(optimalShapeBounds(shape, label + ' source'));
  const relative = corners.map((corner) => vectorSubtract(corner, toolPlane.origin));
  const extent = Math.max(1,
    ...relative.flatMap((point) => [Math.abs(vectorDot(point, toolPlane.xAxis)), Math.abs(vectorDot(point, toolPlane.yAxis)), Math.abs(vectorDot(point, toolPlane.normal))])) * 4 + 10;
  let exactPlane = null;
  try {
    exactPlane = new rc.Plane(toolPlane.origin, toolPlane.xAxis, toolPlane.normal);
    const signedDistance = (toolPlane.keepSide === 'positive' ? 1 : -1) * extent * 2;
    return {
      plane,
      toolSide: toolPlane.keepSide,
      tool: rc.drawRectangle(extent * 2, extent * 2).sketchOnPlane(exactPlane).extrude(signedDistance),
    };
  } finally { safeDelete(exactPlane); }
}

function drawingWedgeTool(shape, planes, label, options = {}) {
  if (!Array.isArray(planes) || planes.length < 2) throw new Error(label + ' requires at least two exact cutting planes.');
  const records = [];
  const toolSides = [];
  let wedge = null;
  try {
    for (const [index, source] of planes.entries()) {
      const next = drawingHalfspaceTool(shape, source, label + ' plane ' + (index + 1), {
        complement: options.removeComplement === true,
      });
      records.push(next.plane);
      toolSides.push(next.toolSide);
      if (!wedge) wedge = next.tool;
      else {
        let combined = null;
        try { combined = wedge.intersect(next.tool); }
        finally { safeDelete(wedge); safeDelete(next.tool); }
        wedge = combined;
      }
    }
    drawingShapeEvidence(wedge, label + ' removal wedge');
    return {
      tool: wedge,
      planes: records,
      toolSides,
      sideContract: options.removeComplement === true
        ? 'remove-intersection-of-authored-retained-side-complements'
        : 'remove-intersection-of-authored-sides',
    };
  } catch (error) {
    safeDelete(wedge);
    throw error;
  }
}

function drawingHalfSectionMapping(definition, planes, frame) {
  const axis = String(definition?.half?.axis || '');
  const side = String(definition?.half?.side || '');
  const at = Number(definition?.half?.at);
  if (!['x', 'y'].includes(axis) || !['positive', 'negative'].includes(side) || !Number.isFinite(at)) {
    throw new Error('Half section split mapping is invalid.');
  }
  const axisVector = axis === 'x' ? frame.xAxis : frame.yAxis;
  const parallel = (left, right) => Math.abs(vectorDot(left, right)) >= 1 - 1e-7;
  const splitCandidates = planes.map((plane, index) => ({ plane, index })).filter(({ plane }) => parallel(plane.normal, axisVector));
  const sectionCandidates = planes.map((plane, index) => ({ plane, index })).filter(({ plane }) => parallel(plane.normal, frame.direction));
  if (splitCandidates.length !== 1 || sectionCandidates.length !== 1 || splitCandidates[0].index === sectionCandidates[0].index) {
    throw new Error('Half section requires one source-normal section plane and one source-axis split plane.');
  }
  const split = splitCandidates[0];
  const authoredAt = vectorDot(split.plane.origin, axisVector);
  const tolerance = Math.max(1e-7, Math.max(Math.abs(authoredAt), Math.abs(at), 1) * 1e-9);
  if (Math.abs(authoredAt - at) > tolerance) {
    throw new Error('Half section split position does not match its exact split plane.');
  }
  const retainedDirection = (split.plane.keepSide === 'positive' ? 1 : -1) * vectorDot(split.plane.normal, axisVector);
  const planeSide = retainedDirection >= 0 ? 'positive' : 'negative';
  if (planeSide !== side) {
    throw new Error('Half section retained side does not match its exact split-plane side.');
  }
  return {
    axis,
    side,
    at: drawingRound(at),
    axisVector: axisVector.map(drawingRound),
    splitPlaneIndex: split.index,
    sectionPlaneIndex: sectionCandidates[0].index,
    retainedPlaneSide: split.plane.keepSide,
    cutterSide: split.plane.keepSide === 'positive' ? 'negative' : 'positive',
  };
}

function drawingProjectionRanges(shape, frame, label) {
  const worldBounds = optimalShapeBounds(shape, label + ' world bounds');
  const worldCorners = drawingBoundsCorners(worldBounds);
  const worldRange = (axis) => {
    const values = worldCorners.map((corner) => vectorDot(corner, axis));
    return [Math.min(...values), Math.max(...values)];
  };
  const targetFrame = { direction: [0, 0, 1], xAxis: [1, 0, 0], yAxis: [0, 1, 0] };
  const transform = drawingAlignedRigidTransform(
    { normal: frame.direction, xAxis: frame.xAxis }, targetFrame, [0, 0, 0], [0, 0, 0], 0,
  );
  let framedShape = null;
  let frameBounds;
  try {
    framedShape = transform.applyShape(shape.clone());
    frameBounds = optimalShapeBounds(framedShape, label + ' exact camera-frame support');
  } finally { safeDelete(framedShape); }
  const x = [frameBounds[0][0], frameBounds[1][0]];
  const y = [frameBounds[0][1], frameBounds[1][1]];
  const depth = [frameBounds[0][2], frameBounds[1][2]];
  const diagonal = Math.hypot(x[1] - x[0], y[1] - y[0], depth[1] - depth[0]);
  return {
    x, y, depth,
    rangeMethod: 'rigid-camera-frame-AddOptimal',
    cameraTransform: structuredClone(transform.evidence),
    worldAabbDepth: worldRange(frame.direction),
    margin: Math.max(1, diagonal * 0.05) + 1,
  };
}

function drawingBoundaryDefinition(value, label) {
  const kind = String(value?.kind || '');
  const bounded = (entry, field, positive = false) => {
    const number = Number(entry);
    if (!Number.isFinite(number) || Math.abs(number) > 1_000_000 || (positive && !(number > 0))) throw new Error(label + ' ' + field + ' is invalid.');
    // Drawing-view persistence canonicalizes authored geometry to 12 decimal
    // places. Preserve that same value here so exact worker evidence remains
    // byte-for-byte bound to the persisted boundary, including oblique-view
    // bounds that naturally contain more than nine fractional digits.
    return Math.round(number * 1e12) / 1e12;
  };
  if (kind === 'rect') return {
    kind, x: bounded(value.x, 'x'), y: bounded(value.y, 'y'),
    width: bounded(value.width, 'width', true), height: bounded(value.height, 'height', true),
  };
  if (kind === 'circle') return {
    kind, x: bounded(value.x, 'center x'), y: bounded(value.y, 'center y'), radius: bounded(value.radius, 'radius', true),
  };
  throw new Error(label + ' must be a rectangle or circle.');
}

function drawingBoundaryProfile(boundary) {
  return boundary.kind === 'circle'
    ? rc.drawCircle(boundary.radius).translate(boundary.x, boundary.y)
    : rc.drawRectangle(boundary.width, boundary.height).translate(boundary.x + boundary.width / 2, boundary.y + boundary.height / 2);
}

function drawingBlueprintList(shape) {
  if (!shape) return [];
  if (shape instanceof rc.Blueprint) return [shape];
  if (shape instanceof rc.Blueprints || shape instanceof rc.CompoundBlueprint) {
    return shape.blueprints.flatMap(drawingBlueprintList);
  }
  throw new Error('Exact HLR drawing contains an unsupported planar-curve container.');
}

function drawingCurveBoundaryIntersections(curve, boundaryCurves) {
  const oc = rc.getOC();
  const intersector = new oc.Geom2dAPI_InterCurveCurve_1();
  const points = [];
  try {
    for (const boundaryCurve of boundaryCurves) {
      if (curve.boundingBox.isOut(boundaryCurve.boundingBox)) continue;
      intersector.Init_1(curve.wrapped, boundaryCurve.wrapped, 1e-9);
      for (let index = 1; index <= intersector.NbPoints(); index++) {
        const point = intersector.Point(index);
        try { points.push([point.X(), point.Y()]); }
        finally { safeDelete(point); }
      }
      for (let index = 1; index <= intersector.NbSegments(); index++) {
        let firstHandle = null; let secondHandle = null; let common = null;
        try {
          firstHandle = new oc.Handle_Geom2d_Curve_1();
          secondHandle = new oc.Handle_Geom2d_Curve_1();
          intersector.Segment(index, firstHandle, secondHandle);
          common = new rc.Curve2D(firstHandle);
          points.push(common.firstPoint, common.lastPoint);
        } finally {
          safeDelete(common); safeDelete(firstHandle); safeDelete(secondHandle);
        }
      }
    }
  } finally { safeDelete(intersector); }
  const roundedPoints = new Map();
  for (const point of points) {
    const key = point.map((entry) => drawingRound(entry)).join(',');
    if (!roundedPoints.has(key)) roundedPoints.set(key, point);
  }
  return [...roundedPoints.values()];
}

function drawingPointWithinBoundary(point, boundary) {
  const scale = boundary.kind === 'circle'
    ? boundary.radius
    : Math.max(boundary.width, boundary.height);
  const tolerance = Math.max(1e-8, scale * 1e-9);
  if (boundary.kind === 'circle') {
    return Math.hypot(point[0] - boundary.x, point[1] - boundary.y) <= boundary.radius + tolerance;
  }
  return point[0] >= boundary.x - tolerance && point[0] <= boundary.x + boundary.width + tolerance
    && point[1] >= boundary.y - tolerance && point[1] <= boundary.y + boundary.height + tolerance;
}

function drawingClipSourceCurves(source, boundaryDrawing, boundary) {
  if (!source?.innerShape) return null;
  const boundaryBlueprint = boundaryDrawing.blueprint;
  const boundaryCurves = boundaryBlueprint.curves;
  const retained = [];
  for (const blueprint of drawingBlueprintList(source.innerShape)) {
    for (const curve of blueprint.curves) {
      const intersections = drawingCurveBoundaryIntersections(curve, boundaryCurves);
      const segments = intersections.length ? curve.splitAt(intersections, 1e-8) : [curve];
      for (const segment of segments) {
        const midpoint = segment.value((segment.firstParameter + segment.lastParameter) / 2);
        if (drawingPointWithinBoundary(midpoint, boundary)) retained.push(segment);
      }
    }
  }
  if (!retained.length) return new rc.Drawing();
  const blueprints = retained.map((curve) => new rc.Blueprint([curve]));
  return new rc.Drawing(blueprints.length === 1 ? blueprints[0] : new rc.Blueprints(blueprints));
}

function drawingClipEdgeClasses(drawings, authoredBoundary, options = {}) {
  const boundary = drawingBoundaryDefinition(authoredBoundary, options.label || 'Drawing HLR boundary');
  const clip = drawingBoundaryProfile(boundary);
  const clipped = Object.fromEntries(DRAWING_EDGE_CLASSES.map((key) => {
    const source = drawings[key];
    if (!source) return [key, null];
    let result = drawingClipSourceCurves(source, clip, boundary);
    if (options.translate) result = result.translate(options.translate);
    if (options.scale) result = result.scale(options.scale.factor, options.scale.center);
    return [key, result];
  }));
  return { boundary, drawings: clipped };
}

function drawingCombineEdgeClassParts(...sets) {
  return Object.fromEntries(DRAWING_EDGE_CLASSES.map((key) => [key, sets.flatMap((set) => drawingDrawingParts(set?.[key]))]));
}

function drawingBoundaryPrism(shape, frame, authoredBoundary, options = {}) {
  const boundary = drawingBoundaryDefinition(authoredBoundary, options.label || 'Drawing boundary');
  const ranges = drawingProjectionRanges(shape, frame, options.label || 'Drawing boundary source');
  const authoredDepthMm = options.depthMm == null ? null : Number(options.depthMm);
  const frontDepth = ranges.depth[0];
  const startDepth = ranges.depth[0] - ranges.margin;
  const requestedDepth = authoredDepthMm == null
    ? ranges.depth[1] - ranges.depth[0] + ranges.margin * 2
    : authoredDepthMm + ranges.margin;
  if (!Number.isFinite(requestedDepth) || !(requestedDepth > ranges.margin) || requestedDepth > 2_000_000) throw new Error((options.label || 'Drawing boundary') + ' depth is invalid.');
  const endDepth = startDepth + requestedDepth;
  const origin = drawingScaleVector(frame.direction, startDepth);
  let plane = null;
  try {
    plane = new rc.Plane(origin, frame.xAxis, frame.direction);
    const tool = drawingBoundaryProfile(boundary).sketchOnPlane(plane).extrude(requestedDepth);
    return {
      boundary, ranges, tool,
      frontDepth, endDepth, toolDepthRange: [startDepth, endDepth],
      endPlane: authoredDepthMm == null ? null : {
        origin: drawingScaleVector(frame.direction, endDepth),
        normal: frame.direction, xAxis: frame.xAxis, yAxis: frame.yAxis, keepSide: 'negative',
      },
    };
  } finally { safeDelete(plane); }
}

function drawingSectionEdgeCount(shape, authoredPlane) {
  const plane = drawingPlaneDefinition(authoredPlane, 'Drawing section');
  const oc = rc.getOC();
  let point = null; let direction = null; let exactPlane = null; let section = null; let progress = null; let result = null;
  try {
    point = new oc.gp_Pnt_3(...plane.origin);
    direction = new oc.gp_Dir_4(...plane.normal);
    exactPlane = new oc.gp_Pln_3(point, direction);
    section = new oc.BRepAlgoAPI_Section_1();
    section.Init1_1(shape.wrapped);
    section.Init2_2(exactPlane);
    section.Approximation(false);
    progress = new oc.Message_ProgressRange_1();
    section.Build(progress);
    result = rc.cast(section.Shape());
    return topologyCount(result, 'edge');
  } finally {
    safeDelete(result); safeDelete(progress); safeDelete(section); safeDelete(exactPlane); safeDelete(direction); safeDelete(point);
  }
}

function drawingSectionFaces(shape, authoredPlane, label, options = {}) {
  const plane = drawingPlaneDefinition(authoredPlane, label);
  const bounds = optimalShapeBounds(shape, label + ' result');
  const tolerance = Math.max(1e-7, Math.hypot(...vectorSubtract(bounds[1], bounds[0])) * 1e-8);
  const faces = importedTopologyRegistry.exactFaces(shape);
  const sourceFaces = options.excludeSourceShape ? importedTopologyRegistry.exactFaces(options.excludeSourceShape) : [];
  const matches = [];
  let excludedSourceFaceCount = 0;
  try {
    for (const face of faces) {
      let center = null; let normal = null;
      try {
        if (face.geomType !== 'PLANE') continue;
        if (sourceFaces.some((sourceFace) => sourceFace.wrapped.IsSame(face.wrapped))) {
          excludedSourceFaceCount++;
          continue;
        }
        center = face.center;
        normal = face.normalAt(center);
        const centerTuple = drawingEvidencePoint(center);
        const normalTuple = drawingUnitVector(drawingEvidencePoint(normal), label + ' face normal');
        if (Math.abs(vectorDot(vectorSubtract(centerTuple, plane.origin), plane.normal)) <= tolerance
          && Math.abs(vectorDot(normalTuple, plane.normal)) >= 1 - 1e-7) {
          matches.push(face);
          continue;
        }
      } finally {
        safeDelete(center); safeDelete(normal);
        if (!matches.includes(face)) safeDelete(face);
      }
    }
    return { plane, faces: matches, excludedSourceFaceCount };
  } catch (error) {
    for (const face of faces) safeDelete(face);
    throw error;
  } finally {
    for (const face of sourceFaces) safeDelete(face);
  }
}

function drawingFaceContour(face, targetPoint, label) {
  const bounds = face.UVBounds;
  const uSpan = bounds.uMax - bounds.uMin;
  const vSpan = bounds.vMax - bounds.vMin;
  if (!(Math.abs(uSpan) > 1e-10) || !(Math.abs(vSpan) > 1e-10)) throw new Error(label + ' face parameterization is degenerate.');
  const uStep = Math.min(1, Math.abs(uSpan));
  const vStep = Math.min(1, Math.abs(vSpan));
  let p0 = null; let pu = null; let pv = null;
  try {
    p0 = face.pointOnSurface(0, 0);
    pu = face.pointOnSurface(uStep / uSpan, 0);
    pv = face.pointOnSurface(0, vStep / vSpan);
    const q0 = targetPoint(drawingEvidencePoint(p0));
    const qu = targetPoint(drawingEvidencePoint(pu));
    const qv = targetPoint(drawingEvidencePoint(pv));
    const colU = [(qu[0] - q0[0]) / uStep, (qu[1] - q0[1]) / uStep];
    const colV = [(qv[0] - q0[0]) / vStep, (qv[1] - q0[1]) / vStep];
    const scaleU = Math.hypot(...colU); const scaleV = Math.hypot(...colV);
    const determinant = colU[0] * colV[1] - colU[1] * colV[0];
    if (Math.abs(determinant) <= 1e-9) return null;
    if (!(scaleU > 1e-9) || Math.abs(scaleU - scaleV) > 1e-6 || Math.abs(colU[0] * colV[0] + colU[1] * colV[1]) > 1e-6) {
      throw new Error(label + ' exact planar contour does not map through a rigid projection.');
    }
    const translation = [
      q0[0] - colU[0] * bounds.uMin - colV[0] * bounds.vMin,
      q0[1] - colU[1] * bounds.uMin - colV[1] * bounds.vMin,
    ];
    let drawing = rc.drawFaceOutline(face);
    if (Math.abs(scaleU - 1) > 1e-9) drawing = drawing.scale(scaleU, [0, 0]);
    if (determinant < 0) drawing = drawing.mirror([1, 0], [0, 0], 'plane');
    drawing = drawing.rotate(Math.atan2(colU[1], colU[0]) * 180 / Math.PI, [0, 0]).translate(translation);
    return { paths: drawingPaths(drawing), box: drawingParseBox(drawing.toSVGViewBox(0)) };
  } finally { safeDelete(p0); safeDelete(pu); safeDelete(pv); }
}

function drawingAlignedJoints(value, planes) {
  if (!Array.isArray(value) || value.length !== planes.length - 1) {
    throw new Error('Aligned section requires one persistent hinge between every ordered cutting-plane region.');
  }
  const referenceAxis = planes[0].yAxis;
  const tolerance = 1e-7;
  const joints = value.map((entry, index) => {
    if (Number(entry?.previousPlaneIndex) !== index || Number(entry?.nextPlaneIndex) !== index + 1) {
      throw new Error('Aligned-section hinge indices do not match the persistent cutting-plane order.');
    }
    const point = Array.isArray(entry?.point) ? entry.point.map(Number) : [];
    const axis = drawingUnitVector(entry?.axis, 'Aligned-section hinge axis');
    const splitNormal = drawingUnitVector(entry?.splitNormal, 'Aligned-section hinge split normal');
    const previous = planes[index];
    const next = planes[index + 1];
    const exactAxis = drawingUnitVector(vectorCross(previous.normal, next.normal), 'Aligned-section exact hinge axis');
    const canonicalAxis = vectorDot(exactAxis, referenceAxis) < 0 ? drawingScaleVector(exactAxis, -1) : exactAxis;
    const canonicalSplit = drawingUnitVector(
      previous.xAxis.map((component, componentIndex) => component + next.xAxis[componentIndex]),
      'Aligned-section canonical split normal',
    );
    if (point.length !== 3 || point.some((component) => !Number.isFinite(component) || Math.abs(component) > 1_000_000)
      || Math.abs(vectorDot(vectorSubtract(point, previous.origin), previous.normal)) > tolerance
      || Math.abs(vectorDot(vectorSubtract(point, next.origin), next.normal)) > tolerance
      || Math.abs(vectorDot(axis, canonicalAxis)) < 1 - tolerance
      || Math.abs(vectorDot(splitNormal, canonicalSplit)) < 1 - tolerance
      || Math.abs(vectorDot(axis, splitNormal)) > tolerance
      || vectorDot(splitNormal, previous.xAxis) <= tolerance
      || vectorDot(splitNormal, next.xAxis) <= tolerance) {
      throw new Error('Aligned-section hinge does not define the canonical exact disjoint-region split.');
    }
    return {
      previousPlaneIndex: index,
      nextPlaneIndex: index + 1,
      point: point.map(drawingRound),
      axis: canonicalAxis.map(drawingRound),
      splitNormal: canonicalSplit.map(drawingRound),
    };
  });
  for (let index = 1; index < planes.length - 1; index++) {
    const delta = vectorSubtract(joints[index].point, joints[index - 1].point);
    const advance = vectorDot(delta, planes[index].xAxis);
    const residual = vectorSubtract(delta, drawingScaleVector(planes[index].xAxis, advance));
    const scaleTolerance = Math.max(tolerance, Math.hypot(...delta) * 1e-8);
    if (!(advance > scaleTolerance) || Math.hypot(...residual) > scaleTolerance) {
      throw new Error('Aligned-section hinges are not monotonic along the persistent cutting-plane chain.');
    }
  }
  return joints;
}

function drawingAlignedRigidTransform(plane, targetFrame, sourceAnchor, targetAnchor, planeIndex) {
  const firstRotation = rotationBetween(plane.normal, targetFrame.direction);
  const rotateFirst = (vector) => Math.abs(firstRotation.angle) > 1e-10
    ? studioV5VectorMath.rotateVector(vector, firstRotation.axis, firstRotation.angle)
    : [...vector];
  const firstXAxis = rotateFirst(plane.xAxis);
  const twistDegrees = Math.atan2(
    vectorDot(targetFrame.direction, vectorCross(firstXAxis, targetFrame.xAxis)),
    Math.max(-1, Math.min(1, vectorDot(firstXAxis, targetFrame.xAxis))),
  ) * 180 / Math.PI;
  const rotateVector = (vector) => {
    const first = rotateFirst(vector);
    return Math.abs(twistDegrees) > 1e-10
      ? studioV5VectorMath.rotateVector(first, targetFrame.direction, twistDegrees)
      : first;
  };
  const mapPoint = (point) => drawingAddVectors(targetAnchor, rotateVector(vectorSubtract(point, sourceAnchor)));
  const anchor = [vectorDot(targetAnchor, targetFrame.xAxis), vectorDot(targetAnchor, targetFrame.yAxis)];
  const basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(rotateVector);
  const translation = targetAnchor.map((entry, row) => entry - sourceAnchor.reduce(
    (sum, component, column) => sum + basis[column][row] * component,
    0,
  ));
  const matrix4x4 = [0, 1, 2].map((row) => [
    drawingRound(basis[0][row]),
    drawingRound(basis[1][row]),
    drawingRound(basis[2][row]),
    drawingRound(translation[row]),
  ]);
  matrix4x4.push([0, 0, 0, 1]);
  const mappedNormal = drawingUnitVector(rotateVector(plane.normal), 'Aligned-section mapped normal');
  const mappedXAxis = drawingUnitVector(rotateVector(plane.xAxis), 'Aligned-section mapped x-axis');
  if (Math.abs(vectorDot(mappedNormal, targetFrame.direction)) < 1 - 1e-7
    || Math.abs(vectorDot(mappedXAxis, targetFrame.xAxis)) < 1 - 1e-7) {
    throw new Error('Aligned-section region transform does not map its complete exact frame to the reference frame.');
  }
  return {
    mapPoint,
    targetPoint(point) {
      const mapped = mapPoint(point);
      return [vectorDot(mapped, targetFrame.xAxis), vectorDot(mapped, targetFrame.yAxis)];
    },
    applyShape(sourceShape) {
      let transformed = sourceShape;
      if (Math.abs(firstRotation.angle) > 1e-10) {
        transformed = applyLocatedTransform(transformed, (transformation) => transformation.rotate(
          firstRotation.angle, sourceAnchor, firstRotation.axis,
        ));
      }
      if (Math.abs(twistDegrees) > 1e-10) {
        transformed = applyLocatedTransform(transformed, (transformation) => transformation.rotate(
          twistDegrees, sourceAnchor, targetFrame.direction,
        ));
      }
      const translation = vectorSubtract(targetAnchor, sourceAnchor);
      if (Math.hypot(...translation) > 1e-10) {
        transformed = applyLocatedTransform(transformed, (transformation) => transformation.translate(translation));
      }
      return transformed;
    },
    evidence: {
      planeIndex,
      anchor: anchor.map(drawingRound),
      matrix2d: [
        [1, 0, drawingRound(anchor[0])],
        [0, 1, drawingRound(anchor[1])],
      ],
      matrix4x4,
      determinant: 1,
      rotationDeg: drawingRound(firstRotation.angle + twistDegrees),
      rigid: true,
      sourceAnchor: sourceAnchor.map(drawingRound),
      targetAnchor: targetAnchor.map(drawingRound),
      sourceNormal: plane.normal.map(drawingRound),
      sourceXAxis: plane.xAxis.map(drawingRound),
      targetNormal: targetFrame.direction.map(drawingRound),
      targetXAxis: targetFrame.xAxis.map(drawingRound),
      primaryRotation: {
        axis: firstRotation.axis.map(drawingRound),
        angleDeg: drawingRound(firstRotation.angle),
      },
      twistDeg: drawingRound(twistDegrees),
    },
  };
}

function drawingAlignedRegionPiece(shape, joints, regionIndex, regionCount) {
  let piece = shape.clone();
  const clip = (joint, keepSide, label) => {
    const halfspace = drawingHalfspaceTool(piece, {
      origin: joint.point,
      normal: joint.splitNormal,
      xAxis: joint.axis,
      keepSide,
    }, label);
    let next = null;
    try { next = piece.intersect(halfspace.tool); }
    finally { safeDelete(piece); safeDelete(halfspace.tool); }
    piece = next;
  };
  try {
    if (regionIndex > 0) clip(joints[regionIndex - 1], 'positive', `Aligned section region ${regionIndex + 1} lower split`);
    if (regionIndex < regionCount - 1) clip(joints[regionIndex], 'negative', `Aligned section region ${regionIndex + 1} upper split`);
    return piece;
  } catch (error) {
    safeDelete(piece);
    throw error;
  }
}

function drawingExactCommonVolume(leftShape, rightShape, label) {
  let intersection = null;
  let intersector = null;
  let progress = null;
  try {
    const oc = rc.getOC();
    progress = new oc.Message_ProgressRange_1();
    intersector = new oc.BRepAlgoAPI_Common_3(leftShape.wrapped, rightShape.wrapped, progress);
    intersector.SetUseOBB?.(true);
    intersector.SetFuzzyValue?.(1e-7);
    intersector.Build(progress);
    if (intersector.IsDone?.() === false) throw new Error('OpenCascade Common did not complete.');
    intersection = rc.cast(intersector.Shape());
    const volumeMm3 = shapeVolume(intersection);
    if (!Number.isFinite(volumeMm3) || volumeMm3 < -1e-9) throw new Error('OpenCascade Common returned an invalid volume.');
    return drawingRound(Math.max(0, volumeMm3));
  } catch (error) {
    throw new Error(`${label} exact overlap check failed: ${String(error?.message || error)}`);
  } finally {
    safeDelete(intersection);
    safeDelete(intersector);
    safeDelete(progress);
  }
}

function drawingAlignedPartition(shape, planes, persistedJoints, targetFrame, targetCamera) {
  const joints = drawingAlignedJoints(persistedJoints, planes);
  const sourceEvidence = drawingShapeEvidence(shape, 'Aligned section cut result');
  const pieces = [];
  const sourceRegions = [];
  const transformedRegions = [];
  const transforms = [];
  let alignedCompound = null;
  try {
    for (let index = 0; index < planes.length; index++) {
      const piece = drawingAlignedRegionPiece(shape, joints, index, planes.length);
      pieces.push(piece);
      sourceRegions.push(drawingShapeEvidence(piece, `Aligned section source region ${index + 1}`));
    }
    const volumeTolerance = Math.max(1e-6, sourceEvidence.volumeMm3 * 1e-8);
    const sourceVolumeSum = sourceRegions.reduce((sum, entry) => sum + entry.volumeMm3, 0);
    let maximumPairOverlapMm3 = 0;
    const pairChecks = [];
    for (let left = 0; left < pieces.length; left++) {
      for (let right = left + 1; right < pieces.length; right++) {
        const volumeMm3 = drawingExactCommonVolume(
          pieces[left], pieces[right], `Aligned section regions ${left + 1} and ${right + 1}`,
        );
        maximumPairOverlapMm3 = Math.max(maximumPairOverlapMm3, volumeMm3);
        pairChecks.push({ leftRegionIndex: left, rightRegionIndex: right, kernel: 'OpenCascade-BRepAlgoAPI-Common', completed: true, volumeMm3 });
      }
    }
    if (Math.abs(sourceVolumeSum - sourceEvidence.volumeMm3) > volumeTolerance || maximumPairOverlapMm3 > volumeTolerance) {
      throw new Error('Aligned-section exact regions do not form one complete non-overlapping partition of the cut result.');
    }
    for (let index = 0; index < planes.length; index++) {
      const sourceAnchor = index === 0 ? planes[0].origin : joints[index - 1].point;
      const targetAnchor = index === 0 ? planes[0].origin : transforms[index - 1].mapPoint(sourceAnchor);
      const transform = drawingAlignedRigidTransform(planes[index], targetFrame, sourceAnchor, targetAnchor, index);
      transforms.push(transform);
      const transformed = transform.applyShape(pieces[index]);
      pieces[index] = null;
      transformedRegions.push({
        shape: transformed,
        evidence: drawingShapeEvidence(transformed, `Aligned section unfolded region ${index + 1}`),
        regionalHlr: drawingPathEvidence(drawingProjectionPayload(transformed, targetCamera)),
      });
    }
    alignedCompound = rc.compoundShapes(transformedRegions.map((entry) => entry.shape));
    for (const entry of transformedRegions) entry.shape = null;
    const transformedResult = drawingShapeEvidence(alignedCompound, 'Aligned section unfolded regional compound');
    if (Math.abs(transformedResult.volumeMm3 - sourceEvidence.volumeMm3) > volumeTolerance
      || transformedResult.solidCount < planes.length) {
      throw new Error('Aligned-section rigid regional unfold did not preserve the complete exact cut-body material.');
    }
    return {
      compound: alignedCompound,
      joints,
      transforms,
      regions: sourceRegions.map((source, index) => ({
        index,
        lowerJointIndex: index > 0 ? index - 1 : null,
        upperJointIndex: index < joints.length ? index : null,
        source,
        transformed: transformedRegions[index].evidence,
        regionalHlr: transformedRegions[index].regionalHlr,
        transform: structuredClone(transforms[index].evidence),
      })),
      partition: {
        regionCount: planes.length,
        coverage: 'exact-disjoint-halfspace-cells',
        sourceVolumeMm3: sourceEvidence.volumeMm3,
        regionVolumeSumMm3: drawingRound(sourceVolumeSum),
        coverageDeltaMm3: drawingRound(Math.abs(sourceVolumeSum - sourceEvidence.volumeMm3)),
        maximumPairOverlapMm3: drawingRound(maximumPairOverlapMm3),
        toleranceMm3: drawingRound(volumeTolerance),
        pairChecks,
      },
      transformedResult,
    };
  } catch (error) {
    safeDelete(alignedCompound);
    for (const piece of pieces) safeDelete(piece);
    for (const entry of transformedRegions) safeDelete(entry.shape);
    throw error;
  }
}

function drawingSectionContours(shape, authoredPlanes, frame, options = {}) {
  let box = null;
  const paths = [];
  let faceCount = 0;
  let loopCount = 0;
  let excludedSourceFaceCount = 0;
  const planes = [];
  const planeEvidence = [];
  for (const [planeIndex, authoredPlane] of authoredPlanes.entries()) {
    const matched = drawingSectionFaces(shape, authoredPlane, (options.label || 'Drawing section') + ' plane ' + (planeIndex + 1), {
      excludeSourceShape: options.sourceShape || null,
    });
    planes.push(matched.plane);
    excludedSourceFaceCount += matched.excludedSourceFaceCount;
    const unfold = Array.isArray(options.alignedTransforms) ? options.alignedTransforms[planeIndex] : null;
    const targetPoint = unfold?.targetPoint || ((point) => [vectorDot(point, frame.xAxis), vectorDot(point, frame.yAxis)]);
    const firstPathIndex = paths.length;
    let planeBox = null;
    let planeFaceCount = 0;
    try {
      for (const face of matched.faces) {
        faceCount++;
        planeFaceCount++;
        const wires = face.wires;
        try {
          for (const wire of wires) {
            let sketch = null; let loopFace = null;
            try {
              sketch = new rc.Sketch(wire.clone());
              loopFace = sketch.face();
              const contour = drawingFaceContour(loopFace, targetPoint, options.label || 'Drawing section');
              if (contour) {
                paths.push(...contour.paths);
                box = drawingUnionBox(box, contour.box);
                planeBox = drawingUnionBox(planeBox, contour.box);
                loopCount += contour.paths.length;
              }
            } finally { safeDelete(loopFace); safeDelete(sketch); }
          }
        } finally { for (const wire of wires) safeDelete(wire); }
      }
    } finally { for (const face of matched.faces) safeDelete(face); }
    const planePaths = paths.slice(firstPathIndex);
    planeEvidence.push({
      planeIndex,
      plane: structuredClone(matched.plane),
      faceCount: planeFaceCount,
      ...drawingSectionPathEvidence(planePaths, planeBox),
      ...(unfold ? { unfold: unfold.evidence } : {}),
    });
  }
  if (!faceCount || !paths.length || paths.some((path) => !/[Zz](?:\s*)$/u.test(path)) || !box) {
    throw new Error((options.label || 'Drawing section') + ' produced no exact closed section contours.');
  }
  return {
    paths, box, faceCount, loopCount, planes, planeEvidence, excludedSourceFaceCount,
    generatedFaceFilter: options.sourceShape ? 'exclude-source-IsSame' : 'result-plane-match',
  };
}

function drawingAuxiliaryFrame(reference, xAxisHint, partBodies) {
  const bodyId = String(reference?.bodyId || '');
  const faceName = String(reference?.faceName || '');
  const runtime = partBodies.find(({ body }) => body.id === bodyId || body.sourceBodyId === bodyId);
  if (!runtime || !topo) throw new Error('Auxiliary view persistent body reference does not resolve in the current exact part.');
  let faces = [];
  let lookups = null;
  const matches = [];
  try {
    faces = topo.exactFaces(runtime.result.shape);
    lookups = topo.nameLookups(runtime.result.shape, runtime.result.names || []);
    for (const face of faces) if (lookups.getFaceName(face) === faceName) matches.push(face);
    if (matches.length !== 1) throw new Error('Auxiliary view persistent face reference is missing or ambiguous.');
    const face = matches[0];
    if (face.geomType !== 'PLANE') throw new Error('Auxiliary view requires a persistent planar face reference.');
    let center = null; let normal = null;
    try {
      center = face.center;
      normal = face.normalAt(center);
      const outward = drawingUnitVector(drawingEvidencePoint(normal), 'Auxiliary face normal');
      const direction = drawingScaleVector(outward, -1);
      const hint = drawingUnitVector(xAxisHint, 'Auxiliary x-axis');
      const projected = hint.map((value, index) => value - vectorDot(hint, direction) * direction[index]);
      const xAxis = drawingUnitVector(projected, 'Auxiliary x-axis projected into the referenced face');
      return {
        direction, xAxis,
        reference: { bodyId: runtime.body.id, sourceBodyId: runtime.body.sourceBodyId || runtime.body.id, faceName },
        facePoint: drawingEvidencePoint(center),
      };
    } finally { safeDelete(center); safeDelete(normal); }
  } finally {
    lookups?.dispose();
    for (const face of faces) safeDelete(face);
  }
}

function drawingVolumeChanged(source, result, label) {
  const tolerance = Math.max(1e-7, source.volumeMm3 * 1e-9);
  if (!(result.volumeMm3 < source.volumeMm3 - tolerance)) {
    throw new Error(label + ' changed no exact material and was not published.');
  }
}

function drawingSectionEvidence(contours, kernelEdgeCounts, additions = {}) {
  const pathEvidence = drawingSectionPathEvidence(contours.paths, contours.box);
  return {
    planeCount: contours.planes.length,
    faceCount: contours.faceCount,
    contourCount: contours.loopCount,
    kernelEdgeCounts,
    ...pathEvidence,
    pathHashes: contours.paths.map((path) => stableHash(String(path))),
    planes: structuredClone(contours.planeEvidence),
    generatedFaceFilter: contours.generatedFaceFilter,
    excludedSourceFaceCount: contours.excludedSourceFaceCount,
    ...additions,
  };
}

function drawingDerivedEvidence(viewRequest, documentHash, exact, additions = {}) {
  return {
    schema: DRAWING_DERIVED_EVIDENCE_SCHEMA,
    kind: viewRequest.derived.kind,
    sourceViewId: viewRequest.derived.sourceViewId,
    documentHash,
    definitionHash: viewRequest.derived.definitionHash,
    sourceFrameHash: viewRequest.derived.sourceFrameHash,
    exact,
    ...additions,
  };
}

function drawingDerivedProjection(compound, viewRequest, sourceCamera, sourceFrame, context) {
  const { kind, definition } = viewRequest.derived;
  const sourceEvidence = context.sourceEvidence;
  const documentHash = context.documentHash;
  let resultShape = null;
  let ownedCamera = null;
  let camera = sourceCamera;
  let frame = sourceFrame;
  let sectionPaths = [];
  let payload = null;
  let exact = null;
  let section = null;
  let clip = null;
  let breakEvidence = null;
  let alignedPartition = null;
  const presentation = {};
  try {
    if (kind === 'auxiliary') {
      const resolved = drawingAuxiliaryFrame(definition.reference, definition.xAxis, context.partBodies);
      ownedCamera = new rc.ProjectionCamera([0, 0, 0], resolved.direction, resolved.xAxis);
      camera = ownedCamera;
      frame = drawingCameraFrame(camera);
      payload = drawingProjectionPayload(compound, camera);
      exact = {
        kernel: 'OpenCascade', operation: 'persistent-planar-face-hlr', source: sourceEvidence,
        result: sourceEvidence, resolvedReference: resolved.reference, facePoint: resolved.facePoint,
      };
    } else if (kind === 'full-section') {
      const retained = drawingHalfspaceTool(compound, definition.planes?.[0], 'Full section');
      try { resultShape = compound.intersect(retained.tool); }
      finally { safeDelete(retained.tool); }
      const resultEvidence = drawingShapeEvidence(resultShape, 'Full section result');
      drawingVolumeChanged(sourceEvidence, resultEvidence, 'Full section');
      const kernelEdgeCounts = [drawingSectionEdgeCount(compound, retained.plane)];
      if (!kernelEdgeCounts[0]) throw new Error('Full section cutting plane intersects no exact topology.');
      const sectionDirection = retained.plane.keepSide === 'positive'
        ? retained.plane.normal
        : drawingScaleVector(retained.plane.normal, -1);
      ownedCamera = new rc.ProjectionCamera([0, 0, 0], sectionDirection, retained.plane.xAxis);
      camera = ownedCamera;
      frame = drawingCameraFrame(camera);
      const viewFrame = {
        direction: [...frame.direction],
        xAxis: [...frame.xAxis],
        cuttingPlane: structuredClone(retained.plane),
        retainedSide: retained.plane.keepSide,
      };
      const contours = drawingSectionContours(resultShape, [retained.plane], frame, {
        label: 'Full section', sourceShape: compound,
      });
      sectionPaths = contours.paths;
      payload = drawingProjectionPayload(resultShape, camera);
      exact = {
        kernel: 'OpenCascade', operation: 'common-halfspace', source: sourceEvidence, result: resultEvidence,
        outputPaths: drawingPathEvidence(payload), viewFrame: structuredClone(viewFrame),
      };
      section = drawingSectionEvidence(contours, kernelEdgeCounts, { viewFrame });
      presentation.hatchAngleDeg = Number(definition.hatchAngleDeg ?? 45);
      presentation.hatchSpacingMm = 2.5;
    } else if (kind === 'half-section' || kind === 'aligned-section') {
      const expectedMinimum = kind === 'half-section' ? 2 : 2;
      if (!Array.isArray(definition.planes) || definition.planes.length < expectedMinimum) throw new Error(kind + ' requires its complete cutting-plane set.');
      const wedge = drawingWedgeTool(compound, definition.planes, kind === 'half-section' ? 'Half section' : 'Aligned section', {
        removeComplement: true,
      });
      const halfMapping = kind === 'half-section' ? drawingHalfSectionMapping(definition, wedge.planes, frame) : null;
      try { resultShape = compound.cut(wedge.tool); }
      finally { safeDelete(wedge.tool); }
      const label = kind === 'half-section' ? 'Half section' : 'Aligned section';
      const resultEvidence = drawingShapeEvidence(resultShape, label + ' result');
      drawingVolumeChanged(sourceEvidence, resultEvidence, label);
      const kernelEdgeCounts = wedge.planes.map((plane) => drawingSectionEdgeCount(compound, plane));
      if (kernelEdgeCounts.some((count) => count < 1)) throw new Error(label + ' has a cutting plane that intersects no exact topology.');
      if (kind === 'aligned-section') {
        ownedCamera = new rc.ProjectionCamera([0, 0, 0], wedge.planes[0].normal, wedge.planes[0].xAxis);
        camera = ownedCamera;
        frame = drawingCameraFrame(camera);
        alignedPartition = drawingAlignedPartition(resultShape, wedge.planes, definition.joints, frame, camera);
      }
      const contours = drawingSectionContours(resultShape, wedge.planes, frame, {
        label,
        ...(kind === 'aligned-section' ? { alignedTransforms: alignedPartition.transforms } : {}),
        sourceShape: compound,
      });
      sectionPaths = contours.paths;
      if (kind === 'aligned-section') {
        const preUnfoldHlr = drawingProjectionPayload(resultShape, camera);
        const exactHlr = drawingProjectionPayload(alignedPartition.compound, camera);
        const combinedBox = drawingUnionBox(exactHlr.viewBox, contours.box);
        payload = {
          ...exactHlr,
          viewBox: combinedBox,
          localBounds: [combinedBox[0], -combinedBox[1] - combinedBox[3], combinedBox[0] + combinedBox[2], -combinedBox[1]],
        };
        const preUnfoldPaths = drawingPathEvidence(preUnfoldHlr);
        const objectHlrPaths = drawingPathEvidence(payload);
        if (preUnfoldPaths.pathHash === objectHlrPaths.pathHash) {
          throw new Error('Aligned-section regional unfold changed no complete object HLR and was not published.');
        }
        exact = {
          kernel: 'OpenCascade', operation: 'partition-rigid-brep-unfold-hlr', source: sourceEvidence,
          result: resultEvidence,
          alignedHlrPathCount: objectHlrPaths.pathCount,
          preUnfoldPaths,
          objectHlrPaths,
          deliveredPaths: drawingPathEvidence(payload),
          transformedResult: structuredClone(alignedPartition.transformedResult),
          partition: structuredClone(alignedPartition.partition),
          regions: structuredClone(alignedPartition.regions),
          joints: structuredClone(alignedPartition.joints),
          sideContract: wedge.sideContract,
          toolSides: [...wedge.toolSides],
        };
      } else {
        payload = drawingProjectionPayload(resultShape, camera);
        exact = {
          kernel: 'OpenCascade', operation: 'cut-quarter-wedge', source: sourceEvidence, result: resultEvidence,
          halfMapping,
          sideContract: wedge.sideContract,
          toolSides: [...wedge.toolSides],
          outputPaths: drawingPathEvidence(payload),
        };
      }
      section = drawingSectionEvidence(contours, kernelEdgeCounts, kind === 'aligned-section' ? {
        alignmentMode: 'exact-disjoint-region-brep-unfold',
        reference: { planeIndex: 0, plane: structuredClone(wedge.planes[0]) },
        alignmentTransforms: contours.planeEvidence.map((entry) => structuredClone(entry.unfold)),
        objectHlrPaths: structuredClone(exact.objectHlrPaths),
        preUnfoldPaths: structuredClone(exact.preUnfoldPaths),
        partition: structuredClone(alignedPartition.partition),
        regions: structuredClone(alignedPartition.regions),
        joints: structuredClone(alignedPartition.joints),
      } : {
        halfMapping: structuredClone(halfMapping),
        sideContract: wedge.sideContract,
        toolSides: [...wedge.toolSides],
      });
      presentation.hatchAngleDeg = Number(definition.hatchAngleDeg ?? 45);
      presentation.hatchSpacingMm = 2.5;
      if (kind === 'half-section') presentation.half = structuredClone(halfMapping);
    } else if (kind === 'broken-out-section') {
      const bounded = drawingBoundaryPrism(compound, frame, definition.boundary, {
        label: 'Broken-out section', depthMm: Number(definition.depthMm),
      });
      try { resultShape = compound.cut(bounded.tool); }
      finally { safeDelete(bounded.tool); }
      const resultEvidence = drawingShapeEvidence(resultShape, 'Broken-out section result');
      drawingVolumeChanged(sourceEvidence, resultEvidence, 'Broken-out section');
      const kernelEdgeCounts = [drawingSectionEdgeCount(compound, bounded.endPlane)];
      if (!kernelEdgeCounts[0]) throw new Error('Broken-out depth terminates outside exact material.');
      const contours = drawingSectionContours(resultShape, [bounded.endPlane], frame, {
        label: 'Broken-out section', sourceShape: compound,
      });
      sectionPaths = contours.paths;
      payload = drawingProjectionPayload(resultShape, camera);
      exact = {
        kernel: 'OpenCascade', operation: 'cut-view-profile-depth', source: sourceEvidence, result: resultEvidence,
        outputPaths: drawingPathEvidence(payload),
      };
      section = drawingSectionEvidence(contours, kernelEdgeCounts, {
        depthMm: Number(definition.depthMm),
        depthPlane: structuredClone(contours.planes[0]),
      });
      clip = {
        operation: 'exact-profile-prism-cut', boundary: bounded.boundary,
        sourceDepthRange: bounded.ranges.depth.map(drawingRound), depthMm: Number(definition.depthMm),
        rangeMethod: bounded.ranges.rangeMethod,
        cameraTransform: structuredClone(bounded.ranges.cameraTransform),
        frontDepth: drawingRound(bounded.frontDepth),
        endDepth: drawingRound(bounded.endDepth),
        depthRelation: 'end-depth=front-depth+persisted-depth-mm',
        toolDepthRange: bounded.toolDepthRange.map(drawingRound),
        worldAabbDepthRange: bounded.ranges.worldAabbDepth.map(drawingRound),
        resultViewBox: payload.viewBox.map(drawingRound),
      };
      presentation.hatchAngleDeg = Number(definition.hatchAngleDeg ?? 45);
      presentation.hatchSpacingMm = 2.5;
      presentation.boundaryKind = bounded.boundary.kind;
    } else if (kind === 'detail' || kind === 'crop') {
      const label = kind === 'detail' ? 'Detail view' : 'Crop view';
      const sourceDrawings = drawingProjectionDrawings(compound, camera);
      const sourceProjection = drawingPayloadFromDrawings(sourceDrawings);
      const scale = kind === 'detail' ? Number(definition.magnification) : 1;
      if (!Number.isFinite(scale) || (kind === 'detail' && (!(scale > 1) || scale > 10))) {
        throw new Error(label + ' magnification is invalid.');
      }
      const normalizedBoundary = drawingBoundaryDefinition(definition.boundary, label + ' boundary');
      const center = normalizedBoundary.kind === 'circle'
        ? [normalizedBoundary.x, normalizedBoundary.y]
        : [normalizedBoundary.x + normalizedBoundary.width / 2, normalizedBoundary.y + normalizedBoundary.height / 2];
      const clipped = drawingClipEdgeClasses(sourceDrawings, normalizedBoundary, {
        label: label + ' boundary',
        ...(scale === 1 ? {} : { scale: { factor: scale, center } }),
      });
      const authoredBoundaryDrawing = drawingBoundaryProfile(clipped.boundary);
      const displayedBoundaryDrawing = scale === 1 ? authoredBoundaryDrawing : authoredBoundaryDrawing.scale(scale, center);
      const boundaryViewBox = drawingParseBox(displayedBoundaryDrawing.toSVGViewBox(0));
      if (!boundaryViewBox) throw new Error(label + ' boundary produced no exact display bounds.');
      payload = drawingPayloadFromDrawings(clipped.drawings, [boundaryViewBox]);
      const sourcePaths = drawingPathEvidence(sourceProjection);
      const resultPaths = drawingPathEvidence(payload);
      exact = {
        kernel: 'OpenCascade', operation: 'exact-hlr-profile-clip', source: sourceEvidence, result: sourceEvidence,
        sourcePaths, resultPaths,
      };
      clip = {
        operation: 'exact-hlr-boundary-clip', boundary: clipped.boundary,
        sourceViewBounds: sourceProjection.localBounds.map(drawingRound), resultViewBox: payload.viewBox.map(drawingRound),
        sourcePaths, resultPaths, magnification: scale,
        boundaryViewBox: boundaryViewBox.map(drawingRound),
        ...(scale === 1 ? {} : { scaleCenter: center.map(drawingRound) }),
      };
      presentation.boundaryKind = clipped.boundary.kind;
      if (kind === 'detail') presentation.magnification = scale;
    } else if (kind === 'break') {
      const sourceDrawings = drawingProjectionDrawings(compound, camera);
      const sourceProjection = drawingPayloadFromDrawings(sourceDrawings);
      const axis = String(definition.axis || '');
      const start = Number(definition.start); const end = Number(definition.end); const gapMm = Number(definition.gapMm);
      if (!['x', 'y'].includes(axis) || !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(gapMm) || !(end > start)) {
        throw new Error('Break view mapping is invalid.');
      }
      const bounds = sourceProjection.localBounds;
      const [minimum, maximum] = axis === 'x' ? [bounds[0], bounds[2]] : [bounds[1], bounds[3]];
      const removedSpan = end - start;
      if (!(start > minimum + 1e-6) || !(end < maximum - 1e-6) || !(gapMm > 0) || !(gapMm < removedSpan)) {
        throw new Error('Break interval must remove an interior span while retaining two exact pieces.');
      }
      const padding = Math.max(1, Math.hypot(bounds[2] - bounds[0], bounds[3] - bounds[1]) * 0.05);
      const leftBoundary = axis === 'x'
        ? { kind: 'rect', x: bounds[0] - padding, y: bounds[1] - padding, width: start - bounds[0] + padding, height: bounds[3] - bounds[1] + padding * 2 }
        : { kind: 'rect', x: bounds[0] - padding, y: bounds[1] - padding, width: bounds[2] - bounds[0] + padding * 2, height: start - bounds[1] + padding };
      const rightBoundary = axis === 'x'
        ? { kind: 'rect', x: end, y: bounds[1] - padding, width: bounds[2] - end + padding, height: bounds[3] - bounds[1] + padding * 2 }
        : { kind: 'rect', x: bounds[0] - padding, y: end, width: bounds[2] - bounds[0] + padding * 2, height: bounds[3] - end + padding };
      const first = drawingClipEdgeClasses(sourceDrawings, leftBoundary, { label: 'Break first retained band' });
      const secondSource = drawingClipEdgeClasses(sourceDrawings, rightBoundary, { label: 'Break second retained band' });
      const translationMm = removedSpan - gapMm;
      const translation = axis === 'x' ? [-translationMm, 0] : [0, -translationMm];
      const secondResultDrawings = Object.fromEntries(DRAWING_EDGE_CLASSES.map((key) => [
        key,
        secondSource.drawings[key]?.translate(translation) || null,
      ]));
      const firstPayload = drawingPayloadFromDrawings(first.drawings);
      const secondSourcePayload = drawingPayloadFromDrawings(secondSource.drawings);
      const secondResultPayload = drawingPayloadFromDrawings(secondResultDrawings);
      payload = drawingPayloadFromDrawings(drawingCombineEdgeClassParts(first.drawings, secondResultDrawings));
      const sourcePaths = drawingPathEvidence(sourceProjection);
      const resultPaths = drawingPathEvidence(payload);
      const mappedBoundaries = axis === 'x'
        ? [drawingRound(start), drawingRound(start + gapMm)]
        : [drawingRound(-start - gapMm), drawingRound(-start)];
      exact = {
        kernel: 'OpenCascade', operation: 'exact-hlr-band-break', source: sourceEvidence, result: sourceEvidence,
        sourcePaths, resultPaths, mappedBoundaries,
      };
      breakEvidence = {
        operation: 'exact-hlr-band-map',
        axis, start: drawingRound(start), end: drawingRound(end), removedSpanMm: drawingRound(removedSpan),
        gapMm: drawingRound(gapMm), translationMm: drawingRound(translationMm), pieceCount: 2,
        sourceViewBounds: bounds.map(drawingRound), resultViewBox: payload.viewBox.map(drawingRound),
        sourcePaths, resultPaths, mappedBoundaries,
        pieces: [
          {
            index: 0,
            sourceInterval: [drawingRound(minimum), drawingRound(start)],
            translation: [0, 0],
            sourcePaths: drawingPathEvidence(firstPayload),
            resultPaths: drawingPathEvidence(firstPayload),
          },
          {
            index: 1,
            sourceInterval: [drawingRound(end), drawingRound(maximum)],
            translation: translation.map(drawingRound),
            sourcePaths: drawingPathEvidence(secondSourcePayload),
            resultPaths: drawingPathEvidence(secondResultPayload),
          },
        ],
      };
    } else {
      throw new Error('Derived drawing-view kind is unsupported by the exact worker.');
    }
    return {
      camera, frame, payload, sectionPaths,
      evidence: drawingDerivedEvidence(viewRequest, documentHash, exact, {
        ...(section ? { section } : {}), ...(clip ? { clip } : {}), ...(breakEvidence ? { break: breakEvidence } : {}),
        ...(Object.keys(presentation).length ? { presentation } : {}),
      }),
    };
  } finally {
    safeDelete(alignedPartition?.compound);
    safeDelete(resultShape);
    if (ownedCamera) safeDelete(ownedCamera);
  }
}

const drawingEvidencePoint = (value) => [value.x ?? value.X?.() ?? value[0], value.y ?? value.Y?.() ?? value[1], value.z ?? value.Z?.() ?? value[2]]
  .map((entry) => Math.round(Number(entry) * 1e9) / 1e9);

function drawingTopologyEvidence(shape, nameTable) {
  if (!topo || !shape || !nameTable?.length) throw new Error('Persistent drawing topology evidence is unavailable.');
  const wireNames = topo.serializationNames(shape, nameTable);
  let faces = [];
  let edges = [];
  let vertices = [];
  try {
    faces = topo.exactFaces(shape);
    edges = topo.exactEdges(shape);
    vertices = exactVertexHandles(shape);
    let vertexNaming = null;
    if (!nameTable.explicitVertexTable) {
      vertexNaming = derivePersistentVertexNames({
        edges,
        getEdgeName: (edge) => wireNames.getEdgeName(edge),
        getEdgeEndpoints: (edge) => exactEdgeEndpointVertices(edge, vertices),
        isSameEdge: (left, right) => left.wrapped.IsSame(right.wrapped),
        isSameVertex: (left, right) => left.IsSame(right),
      });
    }
    const records = {
      schema: 'partmode.drawing-topology-evidence/v1',
      faces: faces.map((face) => {
        let center = null;
        try {
          center = face.center;
          return { name: wireNames.getFaceName(face), point: drawingEvidencePoint(center), sig: faceSignature(face), geomType: face.geomType || 'OTHER' };
        } finally { safeDelete(center); }
      })
        .filter((entry) => Boolean(entry.name)),
      edges: edges.map((edge) => {
        let midpoint = null;
        let start = null;
        let end = null;
        try {
          midpoint = edge.pointAt(0.5);
          start = edge.pointAt(0);
          end = edge.pointAt(1);
          return {
            name: wireNames.getEdgeName(edge),
            point: drawingEvidencePoint(midpoint),
            sig: edgeSignature(edge),
            geomType: edge.geomType || 'OTHER',
            lengthMm: Number(edge.length),
            endpoints: [pointTuple(start, 'Drawing edge start'), pointTuple(end, 'Drawing edge end')]
              .sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]),
          };
        } finally { safeDelete(midpoint); safeDelete(start); safeDelete(end); }
      })
        .filter((entry) => Boolean(entry.name)),
      vertices: vertices.map((vertex) => {
        let point = null;
        try {
          point = rc.getOC().BRep_Tool.Pnt(vertex);
          const name = wireNames.getVertexName(vertex)
            || vertexNaming?.vertexTable.find((entry) => entry.vertex.IsSame(vertex))?.name
            || null;
          return { name, point: drawingEvidencePoint(point), sig: { p: [point.X(), point.Y(), point.Z()].map(quantize) } };
        } finally { safeDelete(point); }
      }).filter((entry) => Boolean(entry.name)),
    };
    return {
      ...records,
      counts: {
        faces: faces.length, namedFaces: records.faces.length,
        edges: edges.length, namedEdges: records.edges.length,
        vertices: vertices.length, namedVertices: records.vertices.length,
      },
      diagnostics: structuredClone([...(wireNames.diagnostics || []), ...(vertexNaming?.diagnostics || [])]),
    };
  } finally {
    wireNames.dispose();
    for (const face of faces) safeDelete(face);
    for (const edge of edges) safeDelete(edge);
    for (const vertex of vertices) safeDelete(vertex);
  }
}

function drawingStructuralTopologyEvidence(shape, nameTable, label) {
  if (!topo || !shape || !nameTable?.length) throw new Error(label + ' persistent topology evidence is unavailable.');
  const names = topo.serializationNames(shape, nameTable);
  let faces = [];
  let edges = [];
  let vertices = [];
  let vertexNaming = null;
  try {
    faces = topo.exactFaces(shape);
    edges = topo.exactEdges(shape);
    vertices = exactVertexHandles(shape);
    if (!Object.prototype.hasOwnProperty.call(nameTable, 'explicitVertexTable')) {
      vertexNaming = derivePersistentVertexNames({
        edges,
        getEdgeName: (edge) => names.getEdgeName(edge),
        getEdgeEndpoints: (edge) => exactEdgeEndpointVertices(edge, vertices),
        isSameEdge: (left, right) => left.wrapped.IsSame(right.wrapped),
        isSameVertex: (left, right) => left.IsSame(right),
      });
    }
    const faceRecords = faces.map((face) => {
      let center = null;
      let normalValue = null;
      try {
        center = face.center;
        normalValue = face.normalAt();
        return {
          name: names.getFaceName(face),
          geomType: face.geomType || 'OTHER',
          point: pointTuple(center, label + ' face point'),
          normal: weldmentUnit(pointTuple(normalValue, label + ' face normal'), label + ' face normal'),
        };
      } finally {
        safeDelete(normalValue);
        safeDelete(center);
      }
    }).sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
    const edgeRecords = edges.map((edge) => ({
      name: names.getEdgeName(edge),
      geomType: edge.geomType || 'OTHER',
    })).sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
    const vertexRecords = vertices.map((vertex) => {
      let point = null;
      try {
        point = rc.getOC().BRep_Tool.Pnt(vertex);
        const name = names.getVertexName(vertex)
          || vertexNaming?.vertexTable.find((entry) => entry.vertex.IsSame(vertex))?.name
          || null;
        return { name, point: [point.X(), point.Y(), point.Z()] };
      } finally {
        safeDelete(point);
      }
    }).sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
    const diagnostics = structuredClone([...(names.diagnostics || []), ...(vertexNaming?.diagnostics || [])]);
    const complete = faceRecords.length === faces.length && faceRecords.every((entry) => Boolean(entry.name))
      && edgeRecords.length === edges.length && edgeRecords.every((entry) => Boolean(entry.name))
      && vertexRecords.length === vertices.length && vertexRecords.every((entry) => Boolean(entry.name));
    const unique = (records) => new Set(records.map((entry) => entry.name)).size === records.length;
    if (!complete || !unique(faceRecords) || !unique(edgeRecords) || !unique(vertexRecords) || diagnostics.length) {
      throw new Error(label + ' requires complete, unique, diagnostic-free persistent face, edge, and vertex topology.');
    }
    if (faceRecords.some((entry) => entry.geomType !== 'PLANE')) {
      throw new Error(label + ' contains unsupported nonplanar exact topology.');
    }
    if (edgeRecords.some((entry) => entry.geomType !== 'LINE')) {
      throw new Error(label + ' contains unsupported nonlinear exact topology.');
    }
    const counts = {
      faces: faces.length, namedFaces: faceRecords.length,
      edges: edges.length, namedEdges: edgeRecords.length,
      vertices: vertices.length, namedVertices: vertexRecords.length,
    };
    const fingerprintSource = {
      counts,
      faces: faceRecords,
      edges: edgeRecords,
      vertices: vertexRecords,
      diagnostics,
    };
    return {
      schema: 'partmode.structural-member-cut-topology/v1',
      sha256: studioV5Sha256Hex(JSON.stringify(fingerprintSource)),
      ...fingerprintSource,
    };
  } finally {
    names.dispose();
    for (const face of faces) safeDelete(face);
    for (const edge of edges) safeDelete(edge);
    for (const vertex of vertices) safeDelete(vertex);
  }
}

function drawingStructuralEnabledFeatureIds(part) {
  const rollbackPosition = part.metadata?.rollbackFeatureId
    ? part.featureOrder.indexOf(part.metadata.rollbackFeatureId)
    : -1;
  return new Set(part.featureOrder.slice(0, rollbackPosition >= 0 ? rollbackPosition + 1 : part.featureOrder.length));
}

const drawingStructuralAddScaled = (point, direction, distance) =>
  point.map((value, index) => value + direction[index] * distance);

function drawingStructuralMemberContext(document, part, memberFeature, body, enabledIds) {
  const N = evaluator(document, part).strict;
  const checked = assertStudioStructuralMemberPart(
    part,
    memberFeature,
    'drawing.structuralMember[' + memberFeature.id + ']',
    (value) => N(value),
  );
  const featureById = new Map((part.features || []).map((feature) => [feature.id, feature]));
  const activeFeatures = (body.featureIds || [])
    .map((featureId) => featureById.get(featureId))
    .filter((feature) => feature && feature.suppressed !== true && enabledIds.has(feature.id));
  if (activeFeatures.filter((feature) => feature.id === memberFeature.id).length !== 1) {
    throw new Error('Structural-member creation feature is detached from its exact body history.');
  }
  const endpoints = {
    start: {
      kind: 'square', treatmentFeatureId: null,
      point: structuredClone(checked.evaluatedPath[0]), normal: structuredClone(checked.currentTangent), facePrefix: null,
    },
    end: {
      kind: 'square', treatmentFeatureId: null,
      point: structuredClone(checked.evaluatedPath[1]), normal: structuredClone(checked.currentTangent), facePrefix: null,
    },
  };
  for (const feature of activeFeatures.filter((entry) => entry.id !== memberFeature.id)) {
    if (feature.type !== 'weldment-treatment' || !feature.extensions?.weldmentTreatment) {
      throw new Error('Unsupported downstream modifier "' + feature.id + '" is present on the structural-member body.');
    }
    const treatment = assertStudioWeldmentTreatmentPart(
      part,
      feature,
      'drawing.weldmentTreatment[' + feature.id + ']',
      (value) => N(value),
    );
    let end;
    let descriptor;
    if (treatment.recipe.kind === 'trim-extend'
      && treatment.recipe.memberId === memberFeature.id && treatment.recipe.memberBodyId === body.id) {
      end = treatment.recipe.end;
      descriptor = {
        kind: 'square',
        treatmentFeatureId: feature.id,
        point: drawingStructuralAddScaled(
          treatment.endpoint,
          treatment.away,
          treatment.recipe.mode === 'trim' ? treatment.recipe.distance : -treatment.recipe.distance,
        ),
        normal: structuredClone(checked.currentTangent),
        facePrefix: null,
      };
    } else if (treatment.recipe.kind === 'corner'
      && treatment.recipe.targetMemberId === memberFeature.id && treatment.recipe.targetBodyId === body.id) {
      end = treatment.recipe.targetEnd;
      descriptor = treatment.recipe.style === 'cope'
        ? {
            kind: 'cope', treatmentFeatureId: feature.id, point: structuredClone(treatment.joint.point), normal: null,
            facePrefix: 'weldment:' + feature.id + '/other-member/',
          }
        : {
            kind: 'miter', treatmentFeatureId: feature.id, point: structuredClone(treatment.joint.point),
            normal: weldmentUnit(
              treatment.joint.leftAway.map((value, index) => value - treatment.joint.rightAway[index]),
              'Miter treatment plane',
            ),
            facePrefix: null,
          };
    } else {
      throw new Error('Treatment "' + feature.id + '" does not exclusively modify this structural member.');
    }
    if (endpoints[end].treatmentFeatureId) throw new Error('Multiple treatments claim the structural-member ' + end + ' endpoint.');
    endpoints[end] = descriptor;
  }
  return { checked, activeFeatures, endpoints };
}

function drawingStructuralCoordinateTolerance(points, length = 1) {
  const scale = Math.max(1, Math.abs(length), ...points.flat().map(Math.abs));
  return Math.max(1e-7, scale * 1e-9, scale * Number.EPSILON * 256);
}

function drawingStructuralPlanarEnd(topology, expected, axis, tolerance, label) {
  const expectedNormal = weldmentUnit(expected.normal, label + ' expected plane normal');
  const matches = topology.faces.filter((face) => {
    const alignment = Math.abs(studioV5VectorMath.dot(face.normal, expectedNormal));
    const distance = Math.abs(studioV5VectorMath.dot(
      face.point.map((value, index) => value - expected.point[index]),
      expectedNormal,
    ));
    return alignment >= 1 - 1e-10 && distance <= tolerance;
  });
  if (matches.length !== 1) throw new Error(label + ' exact treatment plane did not resolve to one persistent current OCCT face.');
  const alignment = Math.max(-1, Math.min(1, Math.abs(studioV5VectorMath.dot(matches[0].normal, axis))));
  let angleOffSquareDeg = alignment >= 1 - 1e-14 ? 0 : Math.acos(alignment) * 180 / Math.PI;
  if (angleOffSquareDeg <= 1e-7) angleOffSquareDeg = 0;
  return {
    kind: expected.kind,
    treatmentFeatureId: expected.treatmentFeatureId,
    angleOffSquareDeg,
    faceNames: [matches[0].name],
  };
}

function drawingStructuralEndEvidence(topology, expected, axis, tolerance, label) {
  if (expected.kind !== 'cope') return drawingStructuralPlanarEnd(topology, expected, axis, tolerance, label);
  const faceNames = topology.faces
    .filter((face) => face.name.startsWith(expected.facePrefix))
    .map((face) => face.name)
    .sort();
  if (!faceNames.length) throw new Error(label + ' cope has no exact profiled faces propagated from its current other-member B-rep.');
  return {
    kind: 'cope',
    treatmentFeatureId: expected.treatmentFeatureId,
    angleOffSquareDeg: null,
    faceNames,
  };
}

function drawingStructuralMemberCutRecord(document, part, feature, body, result, enabledIds) {
  const label = 'Structural-member "' + feature.id + '" cut evidence';
  if (!result?.shape || result.error || result.geometry?.valid !== true || result.geometry?.brepValid !== true
    || result.geometry?.solidCount !== 1 || !(result.geometry.volume > 0)) {
    throw new Error(label + ' requires one current valid positive-volume exact solid.');
  }
  const context = drawingStructuralMemberContext(document, part, feature, body, enabledIds);
  if (context.activeFeatures.length !== result.featureCheckpoints?.length
    || context.activeFeatures.some((active, index) => result.featureCheckpoints[index]?.featureId !== active.id)) {
    throw new Error(label + ' is detached from the final exact feature-checkpoint history.');
  }
  const checkpoint = result.featureCheckpoints.at(-1);
  const sourceBrep = checkpoint?.topologyCarrier?.sourceBrep;
  if (typeof sourceBrep !== 'string' || !sourceBrep.length) throw new Error(label + ' has no final canonical B-rep checkpoint.');
  const exactBodyBrep = importedTopologyRegistry.canonicalBrep(result.shape);
  const brepSha256 = studioV5Sha256Hex(exactBodyBrep);
  const brepBytes = exactBodyBrep.length;
  const checkpointBrepSha256 = studioV5Sha256Hex(sourceBrep);
  const checkpointBrepBytes = sourceBrep.length;
  if (checkpointBrepSha256 !== brepSha256 || checkpointBrepBytes !== brepBytes) {
    throw new Error(label + ' final exact body is detached from its restored final feature checkpoint B-rep.');
  }
  const topology = drawingStructuralTopologyEvidence(result.shape, result.names, label);
  if (topology.counts.faces !== result.geometry.faceCount || topology.counts.edges !== result.geometry.edgeCount
    || topology.counts.vertices !== result.geometry.vertexCount) {
    throw new Error(label + ' exact geometry and persistent topology counts disagree.');
  }
  const origin = structuredClone(context.checked.evaluatedPath[0]);
  const axis = weldmentUnit(context.checked.currentTangent, label + ' evaluated Path tangent');
  const projected = topology.vertices.map((vertex) => ({
    name: vertex.name,
    projection: studioV5VectorMath.dot(vertex.point.map((value, index) => value - origin[index]), axis),
  }));
  const minimumMm = Math.min(...projected.map((entry) => entry.projection));
  const maximumMm = Math.max(...projected.map((entry) => entry.projection));
  const lengthMm = maximumMm - minimumMm;
  if (!(lengthMm > 1e-7) || !Number.isFinite(lengthMm)) throw new Error(label + ' has no positive finite exact axial envelope.');
  const tolerance = drawingStructuralCoordinateTolerance([...topology.vertices.map((entry) => entry.point), origin], lengthMm);
  const axialEnvelope = {
    minimumMm,
    maximumMm,
    startVertexNames: projected.filter((entry) => Math.abs(entry.projection - minimumMm) <= tolerance)
      .map((entry) => entry.name).sort(),
    endVertexNames: projected.filter((entry) => Math.abs(entry.projection - maximumMm) <= tolerance)
      .map((entry) => entry.name).sort(),
  };
  if (!axialEnvelope.startVertexNames.length || !axialEnvelope.endVertexNames.length) {
    throw new Error(label + ' axial extrema have no persistent exact vertices.');
  }
  return {
    memberId: feature.id,
    bodyId: body.id,
    checkpointFeatureId: checkpoint.featureId,
    checkpointBrepSha256,
    checkpointBrepBytes,
    brepSha256,
    brepBytes,
    brepTopologyBindingSha256: studioV5Sha256Hex(JSON.stringify({
      brepSha256,
      brepBytes,
      topologySha256: topology.sha256,
    })),
    profile: {
      familyId: context.checked.recipe.familyId,
      presetId: context.checked.recipe.presetId,
      designation: context.checked.recipe.designation,
    },
    geometry: structuredClone(result.geometry),
    topology,
    axis: { origin, direction: axis },
    axialEnvelope,
    lengthMm,
    start: drawingStructuralEndEvidence(topology, context.endpoints.start, axis, tolerance, label + ' start'),
    end: drawingStructuralEndEvidence(topology, context.endpoints.end, axis, tolerance, label + ' end'),
  };
}

function drawingStructuralMemberCutEvidence(authoredDocument, effectiveDocument, built, effectiveDocumentHash) {
  const enabledIds = drawingStructuralEnabledFeatureIds(built.part);
  const bodyByMemberId = new Map();
  for (const body of built.part.bodies || []) {
    if (!bodyByMemberId.has(body.createdByFeatureId)) bodyByMemberId.set(body.createdByFeatureId, []);
    bodyByMemberId.get(body.createdByFeatureId).push(body);
  }
  const members = [];
  const errors = [];
  const featureById = new Map((built.part.features || []).map((feature) => [feature.id, feature]));
  const candidates = built.part.featureOrder
    .map((featureId) => featureById.get(featureId))
    .filter((feature) => feature && enabledIds.has(feature.id) && feature.suppressed !== true
      && feature.type === 'sweep' && feature.extensions?.structuralMember);
  for (const feature of candidates) {
    const bodies = bodyByMemberId.get(feature.id) || [];
    try {
      if (bodies.length !== 1 || bodies[0].suppressed === true) {
        throw new Error('Structural member has no unique unsuppressed current body.');
      }
      members.push(drawingStructuralMemberCutRecord(
        effectiveDocument,
        built.part,
        feature,
        bodies[0],
        built.results.get(bodies[0].id),
        enabledIds,
      ));
    } catch (error) {
      errors.push({ memberId: feature.id, bodyId: bodies.length === 1 ? bodies[0].id : null, message: String(error?.message || error) });
    }
  }
  return {
    schema: 'partmode.structural-member-cut-evidence/v1',
    kind: 'occt-exact-structural-member-cuts',
    documentHash: studioV5CanonicalHash(authoredDocument),
    effectiveDocumentHash,
    lengthBasis: 'exact-brep-axial-envelope',
    angleConvention: 'degrees-off-square',
    members,
    errors,
  };
}

async function drawingDocument(request) {
  const post = (payload) => self.postMessage({
    kind: 'drawing-result',
    requestId: request.requestId,
    projectId: request.projectId,
    revision: request.revision,
    ...payload,
  });
  const fail = (message) => post({ errors: [{ featureType: 'drawing', message }], views: null, manifest: null });
  let viewRequests;
  try { viewRequests = normalizedDrawingViewRequests(request.views, request.document); }
  catch (error) { return fail(String(error?.message || error)); }
  if (request.document?.schemaVersion !== 5) {
    return fail('Drawing requires a schema 5 project.');
  }
  let compound = null;
  let names = [];
  let assemblyDrawing = null;
  let partDrawing = null;
  let structuralMemberCutEvidence = null;
  let exactBodyEvidence = [];
  let drawingPartBodies = [];
  let cleanup = () => {};
  if (request.document.rootDocument?.kind === 'assembly') {
      if (viewRequests.some((entry) => entry.derived)) {
        return fail('Derived drawing views currently require a schema-5 part document with directly resolvable exact body topology.');
      }
      const built = await buildV5Assembly(request.document, {
        cache: new Map(),
        previousCache: new Map(),
        previousSolutions: new Map(),
      });
      const placed = [];
      const representativeShapes = new Map();
      let placedConsumedByCompound = false;
      const disposeAssemblyDrawing = () => {
        safeDelete(compound);
        if (!placedConsumedByCompound) for (const entry of placed) safeDelete(entry.shape);
        for (const shapes of representativeShapes.values()) for (const shape of shapes) safeDelete(shape);
        disposeV5Build(built);
      };
      try {
        if (built.errors.length || built.solution.errors.length) {
          disposeAssemblyDrawing();
          return fail('An assembly component or mate is failing — fix it first, so the drawing matches an exact solved position.');
        }
        if (built.solution.usedLastValid || built.runtimeBodies.some((runtime) => runtime.lastValid)) {
          disposeAssemblyDrawing();
          return fail('Assembly drawing refuses recovered last-valid geometry or placement. Rebuild every component and mate successfully first.');
        }
        const plan = createAssemblyDrawingPlan(request.document, built.solution, {
          revisionKey: studioV5CanonicalHash(request.document),
          views: viewRequests.map((entry) => entry.id),
        });
        const visibleRuntimes = built.runtimeBodies.filter((runtime) =>
          runtime.visible && !runtime.suppressed && !runtime.consumed && runtime.exactShape && runtime.geometry?.valid);
        const runtimesByOccurrence = new Map();
        for (const runtime of visibleRuntimes) {
          const occurrenceId = runtime.occurrenceInstance?.occurrenceId;
          if (!occurrenceId) throw new Error('Assembly drawing body has no persistent occurrence instance id.');
          if (!runtimesByOccurrence.has(occurrenceId)) runtimesByOccurrence.set(occurrenceId, []);
          runtimesByOccurrence.get(occurrenceId).push(runtime);
        }
        for (const projectionInstance of plan.instances.filter((entry) => entry.visible)) {
          const runtimes = runtimesByOccurrence.get(projectionInstance.instanceId) || [];
          if (!runtimes.length) {
            throw new Error('Assembly drawing occurrence "' + projectionInstance.instanceId + '" has no visible valid exact solid.');
          }
          const instanceShapes = [];
          for (const runtime of runtimes) {
            const shape = applyRigidMatrix(runtime.exactShape, runtime.exactPlacement || assemblyIdentityMatrix());
            placed.push({ runtime, shape });
            instanceShapes.push(shape);
          }
        }
        const representativeIds = new Set(plan.annotationRepresentatives.map((entry) => entry.instanceId));
        for (const entry of placed) {
          const occurrenceId = entry.runtime.occurrenceInstance.occurrenceId;
          if (!representativeIds.has(occurrenceId)) continue;
          if (!representativeShapes.has(occurrenceId)) representativeShapes.set(occurrenceId, []);
          representativeShapes.get(occurrenceId).push(entry.shape.clone());
        }
        for (const representativeId of representativeIds) {
          if (!representativeShapes.get(representativeId)?.length) {
            throw new Error('Assembly drawing BOM representative has no exact placed shape "' + representativeId + '".');
          }
        }
        const exactBodyInstanceCount = placed.length;
        compound = rc.compoundShapes(placed.map((entry) => entry.shape));
        placedConsumedByCompound = true;
        const placedCompoundEvidence = drawingShapeEvidence(compound, 'Assembly drawing placed compound');
        names = [plan.assemblyName];
        assemblyDrawing = {
          plan,
          representativeShapes,
          hlrPerformance: {
            schema: DRAWING_HLR_PERFORMANCE_EVIDENCE_SCHEMA,
            revisionKey: plan.revisionKey,
            placementLedgerFingerprint: plan.placementLedgerFingerprint,
            visibleComponentCount: plan.instances.filter((entry) => entry.visible).length,
            exactBodyInstanceCount,
            uniquePartVariantCount: new Set(visibleRuntimes.map((runtime) => runtime.occurrenceInstance.variantKey)).size,
            uniqueExactBodySourceCount: new Set(visibleRuntimes.map((runtime) => runtime.sourceKey)).size,
            requestedViewCount: viewRequests.length,
            occurrenceProjectionView: plan.annotationProjectionView,
            placedCompoundEvidence,
            assemblyHlrPasses: 0,
            occurrenceHlrPasses: 0,
            occurrenceSupportEvaluations: 0,
          },
        };
        cleanup = disposeAssemblyDrawing;
      } catch (error) {
        disposeAssemblyDrawing();
        return fail(String(error?.message || error));
      }
  } else {
      const context = effectiveConfiguredRootDocument(request.document);
      const built = await buildV5Document(context.effectiveDocument, { cache: new Map(), previousCache: new Map() });
      const runtimeBodies = [
        ...built.part.bodies.map((body) => ({ body, result: built.results.get(body.id) })),
        ...[...built.patternResults.values()].map((result) => ({ body: result.body, result })),
      ];
      const disposeAll = () => {
        const disposed = new Set();
        for (const result of [...built.results.values(), ...built.patternResults.values()]) {
          if (result.shape && !disposed.has(result.shape)) {
            disposed.add(result.shape);
            safeDelete(result.shape);
          }
        }
      };
      const drawingEnabledFeatureIds = drawingStructuralEnabledFeatureIds(built.part);
      const intentionallyExcludedStructuralBodyIds = new Set((built.part.bodies || [])
        .filter((body) => {
          const creator = (built.part.features || []).find((feature) => feature.id === body.createdByFeatureId);
          return creator?.type === 'sweep' && creator.extensions?.structuralMember
            && (creator.suppressed === true || !drawingEnabledFeatureIds.has(creator.id));
        })
        .map((body) => body.id));
      const blockingBuildErrors = built.errors.filter((error) =>
        !intentionallyExcludedStructuralBodyIds.has(error.bodyId));
      if (blockingBuildErrors.length) {
        disposeAll();
        return fail('A feature is failing (marked red) — fix or delete it first, so the drawing matches your design.');
      }
      const selected = runtimeBodies.filter(({ body, result }) => body.visible && !body.suppressed && result?.shape && result.geometry?.valid);
      if (!selected.length) {
        disposeAll();
        return fail('No visible body with valid exact geometry to draw.');
      }
      structuralMemberCutEvidence = drawingStructuralMemberCutEvidence(
        request.document,
        context.effectiveDocument,
        built,
        context.effectiveDocumentHash,
      );
      names = selected.map(({ body }) => body.name);
      drawingPartBodies = selected;
      const structuralCutByBodyId = new Map(
        structuralMemberCutEvidence.members.map((member) => [member.bodyId, member]),
      );
      const exactPartBodyEvidence = (body, result, evidenceOnly = false) => {
        let topology = null;
        let topologyError = null;
        try { topology = drawingTopologyEvidence(result.shape, result.names); }
        catch (error) { topologyError = String(error?.message || error); }
        const structuralCut = structuralCutByBodyId.get(body.id) || null;
        let structuralExact = null;
        let structuralEvidenceError = null;
        if (structuralCut) {
          try {
            const exactBrep = importedTopologyRegistry.canonicalBrep(result.shape);
            const preciseTopology = drawingStructuralTopologyEvidence(
              result.shape,
              result.names,
              'Published structural-member body "' + body.id + '"',
            );
            const brepSha256 = studioV5Sha256Hex(exactBrep);
            const brepBytes = exactBrep.length;
            structuralExact = {
              structuralMemberId: structuralCut.memberId,
              brepSha256,
              brepBytes,
              structuralTopologySha256: preciseTopology.sha256,
              brepTopologyBindingSha256: studioV5Sha256Hex(JSON.stringify({
                brepSha256,
                brepBytes,
                topologySha256: preciseTopology.sha256,
              })),
            };
          } catch (error) {
            structuralEvidenceError = String(error?.message || error);
          }
        }
        return {
          bodyId: body.id,
          sourceBodyId: body.sourceBodyId || body.id,
          name: body.name,
          geometry: structuredClone(result.geometry),
          topology,
          visible: body.visible !== false,
          ...(evidenceOnly ? { evidenceOnly: true } : {}),
          ...(structuralExact || {}),
          ...(structuralEvidenceError ? { structuralEvidenceError } : {}),
          ...(topologyError ? { topologyError } : {}),
          ...(body.patternInstance ? { patternInstance: structuredClone(body.patternInstance) } : {}),
        };
      };
      exactBodyEvidence = selected.map(({ body, result }) => exactPartBodyEvidence(body, result));
      const publishedBodyIds = new Set(exactBodyEvidence.map((entry) => entry.bodyId));
      for (const structuralCut of structuralMemberCutEvidence.members) {
        if (publishedBodyIds.has(structuralCut.bodyId)) continue;
        const body = built.part.bodies.find((entry) => entry.id === structuralCut.bodyId);
        const result = body ? built.results.get(body.id) : null;
        if (!body || !result?.shape || result.error) continue;
        exactBodyEvidence.push(exactPartBodyEvidence(body, result, true));
        publishedBodyIds.add(body.id);
      }
      compound = rc.compoundShapes(selected.map(({ result }) => result.shape.clone()));
      try {
        partDrawing = resolvedPartDrawingManifest(context.effectiveDocument, built.part, context);
        if (partDrawing && !(Array.isArray(request.views) && request.views.length)) viewRequests = normalizedDrawingViewRequests(partDrawing.requiredViews, request.document);
      } catch (error) {
        safeDelete(compound);
        disposeAll();
        return fail(String(error?.message || error));
      }
      cleanup = () => { safeDelete(compound); disposeAll(); };
  }
  try {
    const views = [];
    const exactAssemblyViews = [];
    const projectionFailures = [];
    const documentHash = studioV5CanonicalHash(request.document);
    let exactSourceEvidence = null;
    if (viewRequests.some((entry) => entry.derived)) {
      try { exactSourceEvidence = drawingShapeEvidence(compound, 'Derived drawing source'); }
      catch (error) { return fail(String(error?.message || error)); }
    }
    for (const viewRequest of viewRequests) {
      const view = viewRequest.id;
      let camera = null;
      try {
        camera = drawingCamera(viewRequest);
        const sourceFrame = drawingCameraFrame(camera);
        const derived = viewRequest.derived
          ? drawingDerivedProjection(compound, viewRequest, camera, sourceFrame, {
              documentHash, sourceEvidence: exactSourceEvidence, partBodies: drawingPartBodies,
            })
          : null;
        const payload = derived?.payload || drawingProjectionPayload(compound, camera);
        if (assemblyDrawing) {
          assemblyDrawing.hlrPerformance.assemblyHlrPasses += 1;
          const occurrences = [];
          const projectionRequest = assemblyDrawing.plan.projectionRequests.find((entry) => entry.view === view);
          if (!projectionRequest) throw new Error('Assembly drawing projection plan is missing view "' + view + '".');
          for (const instanceId of projectionRequest.exactOccurrencePass.instanceIds) {
            if (projectionRequest.exactOccurrencePass.kind !== 'occt-brep-camera-support') {
              throw new Error('Assembly drawing occurrence support plan is invalid for "' + view + '".');
            }
            const instanceShapes = assemblyDrawing.representativeShapes.get(instanceId) || [];
            if (!instanceShapes.length) throw new Error('Assembly drawing occurrence shapes are missing "' + instanceId + '".');
            let occurrenceBox = null;
            const supports = [];
            for (let shapeIndex = 0; shapeIndex < instanceShapes.length; shapeIndex += 1) {
              const support = drawingProjectionRanges(
                instanceShapes[shapeIndex], sourceFrame,
                'Assembly drawing occurrence "' + instanceId + '" body ' + (shapeIndex + 1),
              );
              const viewBox = [
                support.x[0], -support.y[1],
                support.x[1] - support.x[0], support.y[1] - support.y[0],
              ];
              if (viewBox.some((entry) => !Number.isFinite(entry)) || !(viewBox[2] > 0) || !(viewBox[3] > 0)) {
                throw new Error('Exact B-rep camera support produced no drawable bounds for "' + instanceId + '" in ' + view + '.');
              }
              occurrenceBox = drawingUnionBox(occurrenceBox, viewBox);
              supports.push({
                rangeMethod: support.rangeMethod,
                x: support.x.map(drawingRound),
                y: support.y.map(drawingRound),
                depth: support.depth.map(drawingRound),
                cameraTransform: support.cameraTransform,
              });
              assemblyDrawing.hlrPerformance.occurrenceSupportEvaluations += 1;
            }
            const canonicalSupports = supports.map((support) => structuredClone(support));
            const canonicalFrame = structuredClone(sourceFrame);
            occurrences.push({
              instanceId,
              viewBox: occurrenceBox.map(drawingRound),
              evidence: {
                schema: 'partmode.drawing-brep-camera-support/v1',
                kind: 'occt-brep-camera-support',
                revisionKey: assemblyDrawing.plan.revisionKey,
                sourceBodyCount: instanceShapes.length,
                frame: canonicalFrame,
                supports: canonicalSupports,
                supportFingerprint: assemblyDrawingCanonicalFingerprint({
                  revisionKey: assemblyDrawing.plan.revisionKey,
                  view,
                  instanceId,
                  frame: canonicalFrame,
                  supports: canonicalSupports,
                }),
              },
            });
          }
          exactAssemblyViews.push({
            view,
            assemblyViewBox: payload.viewBox,
            occurrencePassKind: projectionRequest.exactOccurrencePass.kind,
            occurrences,
          });
        }
        views.push({
          view, name: viewRequest.name,
          frame: derived
            ? { direction: derived.frame.direction, xAxis: derived.frame.xAxis }
            : viewRequest.standard ? { standard: viewRequest.standard } : { direction: viewRequest.direction, xAxis: viewRequest.xAxis },
          visible: payload.visible, hidden: payload.hidden,
          regularVisible: payload.regularVisible, regularHidden: payload.regularHidden,
          tangentVisible: payload.tangentVisible, tangentHidden: payload.tangentHidden,
          viewBox: payload.viewBox,
          ...(derived ? { sectionPaths: derived.sectionPaths, derivedEvidence: derived.evidence } : {}),
        });
      } catch (error) {
        projectionFailures.push({ view, message: String(error?.message || error) });
      } finally { safeDelete(camera); }
    }
    const projected = new Set(views.map((entry) => entry.view));
    const missingViews = viewRequests.map((entry) => entry.id).filter((view) => !projected.has(view));
    if (missingViews.length) return fail('Required exact drawing projection failed: ' + missingViews.join(', ') + '. ' + projectionFailures.map((entry) => entry.view + ': ' + entry.message).join('; '));
    if (assemblyDrawing) {
      let finalized;
      try {
        finalized = finalizeAssemblyDrawingAnnotations(assemblyDrawing.plan, {
          kind: 'occt-hlr-exact',
          revisionKey: assemblyDrawing.plan.revisionKey,
          placementLedgerFingerprint: assemblyDrawing.plan.placementLedgerFingerprint,
          views: exactAssemblyViews,
        });
      } catch (error) {
        return fail(String(error?.message || error));
      }
      post({
        errors: [],
        views,
        manifest: {
          units: 'mm',
          names,
          documentKind: 'assembly',
          assemblyId: finalized.assemblyId,
          solverState: finalized.solverState,
          bom: finalized.bom,
          balloons: finalized.annotations.balloons,
          annotations: finalized.annotations,
          drawingPlan: finalized,
          exactProjectionEvidence: finalized.exactProjectionEvidence,
          hlrPerformance: {
            ...assemblyDrawing.hlrPerformance,
            exactHlrPasses: assemblyDrawing.hlrPerformance.assemblyHlrPasses
              + assemblyDrawing.hlrPerformance.occurrenceHlrPasses,
            naivePerViewOccurrenceHlrPasses: assemblyDrawing.hlrPerformance.visibleComponentCount
              * assemblyDrawing.hlrPerformance.requestedViewCount,
            avoidedOccurrenceHlrPasses: assemblyDrawing.hlrPerformance.visibleComponentCount
              * assemblyDrawing.hlrPerformance.requestedViewCount,
            annotationRepresentativeCount: assemblyDrawing.plan.annotationRepresentatives.length,
            algorithm: 'one-assembly-hlr-per-view+exact-brep-support-per-bom-representative',
            viewPathEvidence: views.map((entry) => ({ view: entry.view, ...drawingPathEvidence(entry) })),
            occurrenceBoundsEvidence: exactAssemblyViews.map((entry) => ({
              view: entry.view,
              kind: entry.occurrencePassKind,
              occurrenceCount: entry.occurrences.length,
              occurrenceBoundsHash: stableHash(entry.occurrences),
              representatives: entry.occurrences.map((occurrence) => ({
                instanceId: occurrence.instanceId,
                viewBox: occurrence.viewBox,
                evidence: occurrence.evidence,
              })),
            })),
          },
        },
      });
    } else {
      if (partDrawing) {
        const projected = new Set(views.map((entry) => entry.view));
        const missing = partDrawing.requiredViews.filter((view) => !projected.has(view));
        if (missing.length) return fail('Required exact drawing projection failed: ' + missing.join(', ') + '.');
      }
      post({
        errors: [],
        views,
        bodies: exactBodyEvidence,
        manifest: {
          units: 'mm',
          names,
          documentKind: 'part',
          exactProjectionEvidence: {
            kind: 'occt-hlr-exact',
            documentHash,
            effectiveDocumentHash: structuralMemberCutEvidence?.effectiveDocumentHash || documentHash,
            views: views.map((entry) => entry.view),
            derivedViews: views.filter((entry) => entry.derivedEvidence).map((entry) => ({
              view: entry.view,
              kind: entry.derivedEvidence.kind,
              sourceViewId: entry.derivedEvidence.sourceViewId,
              definitionHash: entry.derivedEvidence.definitionHash,
              sourceFrameHash: entry.derivedEvidence.sourceFrameHash,
              evidenceHash: stableHash(entry.derivedEvidence),
            })),
          },
          ...(structuralMemberCutEvidence ? { structuralMemberCutEvidence } : {}),
          ...(partDrawing ? {
            partId: partDrawing.partId,
            configuration: partDrawing.configuration,
            effectiveDocumentHash: partDrawing.effectiveDocumentHash,
            partDrawing,
          } : {}),
        },
      });
    }
  } finally {
    cleanup();
  }
}

const MESH_EXPORT_TOLERANCE_MM = 0.03;
const MESH_EXPORT_ANGULAR_TOLERANCE = 0.3;

function exchangeXmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function exchangeNumber(value) {
  const finite = Number(value);
  if (!Number.isFinite(finite)) throw new Error('Mesh export encountered a non-finite coordinate.');
  if (Object.is(finite, -0)) return '0';
  return Number(finite.toPrecision(15)).toString();
}

function exchangeMesh(shape, name) {
  const mesh = shape.mesh({
    tolerance: MESH_EXPORT_TOLERANCE_MM,
    angularTolerance: MESH_EXPORT_ANGULAR_TOLERANCE,
  });
  const vertices = Array.from(mesh.vertices || [], Number);
  const triangles = Array.from(mesh.triangles || [], Number);
  if (!vertices.length || vertices.length % 3 !== 0 || !triangles.length || triangles.length % 3 !== 0) {
    throw new Error('Exact body tessellation produced an invalid exchange mesh.');
  }
  const vertexCount = vertices.length / 3;
  if (triangles.some((index) => !Number.isInteger(index) || index < 0 || index >= vertexCount)) {
    throw new Error('Exact body tessellation produced an out-of-range triangle index.');
  }
  return { name: String(name || 'Body'), vertices, triangles };
}

function amfXml(entries, modelName = 'PartMode model') {
  const objects = entries.map((entry, objectIndex) => {
    const vertices = [];
    for (let index = 0; index < entry.vertices.length; index += 3) {
      vertices.push('<vertex><coordinates><x>' + exchangeNumber(entry.vertices[index]) + '</x><y>'
        + exchangeNumber(entry.vertices[index + 1]) + '</y><z>' + exchangeNumber(entry.vertices[index + 2])
        + '</z></coordinates></vertex>');
    }
    const triangles = [];
    for (let index = 0; index < entry.triangles.length; index += 3) {
      triangles.push('<triangle><v1>' + entry.triangles[index] + '</v1><v2>' + entry.triangles[index + 1]
        + '</v2><v3>' + entry.triangles[index + 2] + '</v3></triangle>');
    }
    return '<object id="' + (objectIndex + 1) + '"><metadata type="name">' + exchangeXmlEscape(entry.name)
      + '</metadata><mesh><vertices>' + vertices.join('') + '</vertices><volume>' + triangles.join('')
      + '</volume></mesh></object>';
  });
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<amf unit="millimeter" version="1.2"><metadata type="name">' + exchangeXmlEscape(modelName)
    + '</metadata>' + objects.join('') + '</amf>';
}

function threeMfModelXml(entries, modelName = 'PartMode model') {
  const objects = entries.map((entry, objectIndex) => {
    const vertices = [];
    for (let index = 0; index < entry.vertices.length; index += 3) {
      vertices.push('<vertex x="' + exchangeNumber(entry.vertices[index]) + '" y="'
        + exchangeNumber(entry.vertices[index + 1]) + '" z="' + exchangeNumber(entry.vertices[index + 2]) + '"/>');
    }
    const triangles = [];
    for (let index = 0; index < entry.triangles.length; index += 3) {
      triangles.push('<triangle v1="' + entry.triangles[index] + '" v2="' + entry.triangles[index + 1]
        + '" v3="' + entry.triangles[index + 2] + '"/>');
    }
    return '<object id="' + (objectIndex + 1) + '" type="model" name="' + exchangeXmlEscape(entry.name)
      + '"><mesh><vertices>' + vertices.join('') + '</vertices><triangles>' + triangles.join('')
      + '</triangles></mesh></object>';
  });
  const build = entries.map((_, objectIndex) => '<item objectid="' + (objectIndex + 1) + '"/>').join('');
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
    + '<metadata name="Application">PartMode</metadata><metadata name="Title">' + exchangeXmlEscape(modelName)
    + '</metadata><resources>' + objects.join('') + '</resources><build>' + build + '</build></model>';
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function littleEndianRecord(length, writes) {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  writes(view);
  return bytes;
}

function storedZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const checksum = crc32(data);
    const localHeader = littleEndianRecord(30, (view) => {
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0800, true);
      view.setUint16(12, 33, true);
      view.setUint32(14, checksum, true);
      view.setUint32(18, data.byteLength, true);
      view.setUint32(22, data.byteLength, true);
      view.setUint16(26, name.byteLength, true);
    });
    localParts.push(localHeader, name, data);
    const centralHeader = littleEndianRecord(46, (view) => {
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, 0x0800, true);
      view.setUint16(14, 33, true);
      view.setUint32(16, checksum, true);
      view.setUint32(20, data.byteLength, true);
      view.setUint32(24, data.byteLength, true);
      view.setUint16(28, name.byteLength, true);
      view.setUint32(42, localOffset, true);
    });
    centralParts.push(centralHeader, name);
    localOffset += localHeader.byteLength + name.byteLength + data.byteLength;
  }
  const central = concatBytes(centralParts);
  const end = littleEndianRecord(22, (view) => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, files.length, true);
    view.setUint16(10, files.length, true);
    view.setUint32(12, central.byteLength, true);
    view.setUint32(16, localOffset, true);
  });
  return concatBytes([...localParts, central, end]);
}

function threeMfBlob(entries, modelName) {
  const contentTypes = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
    + '</Types>';
  const relationships = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
    + '</Relationships>';
  const bytes = storedZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: relationships },
    { name: '3D/3dmodel.model', data: threeMfModelXml(entries, modelName) },
  ]);
  return new Blob([bytes], { type: 'model/3mf' });
}

function meshExchangeBlob(kind, shapeEntries, modelName) {
  const entries = shapeEntries.map((entry) => exchangeMesh(entry.shape, entry.name));
  if (kind === 'export-amf') return new Blob([amfXml(entries, modelName)], { type: 'application/x-amf' });
  if (kind === 'export-3mf') return threeMfBlob(entries, modelName);
  throw new Error('Unsupported named mesh exchange format.');
}

async function exportDocument(request) {
  return exportV5Document(request);
}

async function exportV5Document(request) {
  if (request.document.rootDocument?.kind === 'assembly') return exportV5AssemblyDocument(request);
  const context = effectiveConfiguredRootDocument(request.document);
  const built = await buildV5Document(context.effectiveDocument, { cache: new Map(), previousCache: new Map() });
  const runtimeBodies = [
    ...built.part.bodies.map((body) => ({ body, result: built.results.get(body.id) })),
    ...[...built.patternResults.values()].map((result) => ({ body: result.body, result })),
  ];
  const requestedIds = Array.isArray(request.bodyIds) && request.bodyIds.length
    ? new Set(request.bodyIds)
    : new Set(runtimeBodies.filter(({ body }) => body.visible && !body.suppressed).map(({ body }) => body.id));
  const selected = runtimeBodies.filter(({ body }) => requestedIds.has(body.id) && !body.suppressed);
  const errors = [
    ...built.errors.filter((error) => requestedIds.has(error.bodyId)),
    ...[...requestedIds]
      .filter((bodyId) => !runtimeBodies.some(({ body }) => body.id === bodyId))
      .map((bodyId) => ({ bodyId, featureType: 'export', message: 'selected body does not exist' })),
  ];
  if (!selected.length) errors.push({ featureType: 'export', message: 'select at least one unsuppressed body' });
  if (selected.some(({ result }) => !result?.shape || !result.geometry?.valid)) {
    errors.push({ featureType: 'export', message: 'one or more selected bodies have no valid exact solid' });
  }
  let blob = null;
  if (!errors.length) {
    if (request.kind === 'export-step') {
      blob = rc.exportSTEP(
        selected.map(({ body, result }) => ({ shape: result.shape, name: body.name, color: '#a7b8c9' })),
        { unit: 'MM', modelUnit: 'MM' },
      );
    } else if (request.kind === 'export-stl') {
      const compound = rc.compoundShapes(selected.map(({ result }) => result.shape.clone()));
      try {
        blob = compound.blobSTL({ tolerance: MESH_EXPORT_TOLERANCE_MM, angularTolerance: MESH_EXPORT_ANGULAR_TOLERANCE, binary: true });
      } finally {
        safeDelete(compound);
      }
    } else {
      blob = meshExchangeBlob(request.kind, selected.map(({ body, result }) => ({
        shape: result.shape,
        name: body.name,
      })), context.effectiveDocument.name);
    }
  }
  const manifest = {
    schemaVersion: 5,
    format: request.kind.replace('export-', ''),
    units: 'mm',
    bodyCount: selected.length,
    solidCount: selected.reduce((total, entry) => total + (entry.result?.geometry?.solidCount || 0), 0),
    names: selected.map(({ body }) => body.name),
    placements: selected.map(({ body, result }) => ({ bodyId: body.id, bounds: result?.geometry?.bounds || null })),
    configuration: context.configuration,
    effectiveDocumentHash: context.effectiveDocumentHash,
  };
  const disposed = new Set();
  for (const result of [...built.results.values(), ...built.patternResults.values()]) {
    if (result.shape && !disposed.has(result.shape)) {
      disposed.add(result.shape);
      safeDelete(result.shape);
    }
  }
  if (blob && request.kind === 'export-step') blob = await normalizeStepExportBlob(blob);
  self.postMessage({
    kind: 'export-result',
    requestId: request.requestId,
    projectId: request.projectId,
    revision: request.revision,
    errors,
    blob,
    manifest,
  });
}

async function freezePatternOccurrences(request) {
  if (request.document?.rootDocument?.kind !== 'part') throw new Error('Pattern materialization requires a part document');
  const context = effectiveConfiguredRootDocument(request.document);
  const built = await buildV5Document(context.effectiveDocument, { cache: new Map(), previousCache: new Map() });
  const requestedIds = new Set(request.bodyIds || []);
  const selected = [...built.patternResults.values()].filter((result) => requestedIds.has(result.body.id));
  const errors = [
    ...built.errors.filter((error) => requestedIds.has(error.bodyId)),
    ...[...requestedIds].filter((bodyId) => !selected.some((result) => result.body.id === bodyId))
      .map((bodyId) => ({ bodyId, featureType: 'pattern', message: 'selected pattern occurrence does not exist' })),
  ];
  if (!selected.length) errors.push({ featureType: 'pattern', message: 'select at least one generated pattern occurrence' });
  if (selected.some((result) => !result.shape || !result.geometry?.valid)) errors.push({ featureType: 'pattern', message: 'one or more selected occurrences have no valid exact solid' });
  const prefix = String(request.freezePrefix || 'materialized-pattern').replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120);
  const records = errors.length ? [] : selected.map((result, index) => {
    const ids = {
      resourceId: prefix + '-resource-' + (index + 1),
      featureId: prefix + '-feature-' + (index + 1),
      bodyId: prefix + '-body-' + (index + 1),
    };
    const record = importedBodyRecord(ids, 'Independent ' + result.body.name, result.shape, result.body);
    return {
      ...record,
      patternId: result.body.patternInstance.patternId,
      patternIndex: result.body.patternInstance.index,
      sourceBodyId: result.body.patternInstance.sourceBodyId,
      geometry: result.geometry,
    };
  });
  const disposed = new Set();
  for (const result of [...built.results.values(), ...built.patternResults.values()]) {
    if (result.shape && !disposed.has(result.shape)) { disposed.add(result.shape); safeDelete(result.shape); }
  }
  self.postMessage({
    kind: 'freeze-pattern-result', requestId: request.requestId, projectId: request.projectId,
    revision: request.revision, errors, records,
    configuration: context.configuration,
    effectiveDocumentHash: context.effectiveDocumentHash,
  });
}

async function exportV5AssemblyDocument(request) {
  const built = await buildV5Assembly(request.document, { cache: new Map(), previousCache: new Map(), previousSolutions: new Map() });
  try {
  const available = built.runtimeBodies.filter((runtime) => runtime.visible && !runtime.suppressed);
  const requestedIds = Array.isArray(request.bodyIds) && request.bodyIds.length
    ? new Set(request.bodyIds)
    : new Set(available.map((runtime) => runtime.bodyId));
  const selected = built.runtimeBodies.filter((runtime) => requestedIds.has(runtime.bodyId) && !runtime.suppressed);
  const completeAssembly = request.kind === 'export-step' &&
    selected.length === available.length && available.every((runtime) => requestedIds.has(runtime.bodyId));
  const hasOccurrenceAssemblyFeatures = selected.some((runtime) =>
    Array.isArray(runtime.assemblyFeatureIds) && runtime.assemblyFeatureIds.length > 0);
  // XCAF reusable part labels intentionally describe shared definitions. An
  // occurrence-only assembly cut cannot use that path without exporting the
  // uncut source shape. Flatten those exact solved occurrence B-reps instead;
  // this preserves the actual CAD result and explicitly reports the hierarchy
  // limitation rather than silently substituting geometry.
  const structuredCompleteAssembly = completeAssembly && !hasOccurrenceAssemblyFeatures;
  const errors = [
    ...built.errors.filter((error) => !error.bodyId || requestedIds.has(error.bodyId)),
    ...[...requestedIds]
      .filter((bodyId) => !built.runtimeBodies.some((runtime) => runtime.bodyId === bodyId))
      .map((bodyId) => ({ bodyId, featureType: 'export', message: 'selected assembly body does not exist' })),
  ];
  if (!selected.length) errors.push({ featureType: 'export', message: 'select at least one visible assembly body' });
  if (selected.some((runtime) => !runtime.exactShape || !runtime.geometry?.valid)) errors.push({ featureType: 'export', message: 'one or more selected component bodies have no valid exact solid' });
  const placed = [];
  let blob = null;
  let interchangeManifest = null;
  try {
    if (!errors.length) {
      if (structuredCompleteAssembly) {
        const structured = createStructuredAssemblyStep(request.document, built, selected);
        interchangeManifest = structured.manifest;
        blob = await withStepManifest(structured.blob, structured.manifest);
      } else {
        for (const runtime of selected) placed.push({ runtime, shape: applyRigidMatrix(runtime.exactShape, runtime.exactPlacement) });
      }
      if (request.kind === 'export-step' && !structuredCompleteAssembly) {
        blob = rc.exportSTEP(
          placed.map(({ runtime, shape }) => ({ shape, name: runtime.bodyName, color: '#a7b8c9' })),
          { unit: 'MM', modelUnit: 'MM' },
        );
      } else if (request.kind === 'export-stl') {
        const compound = rc.compoundShapes(placed.map(({ shape }) => shape.clone()));
        try { blob = compound.blobSTL({ tolerance: MESH_EXPORT_TOLERANCE_MM, angularTolerance: MESH_EXPORT_ANGULAR_TOLERANCE, binary: true }); }
        finally { safeDelete(compound); }
      } else if (request.kind !== 'export-step') {
        blob = meshExchangeBlob(request.kind, placed.map(({ runtime, shape }) => ({
          shape,
          name: runtime.bodyName,
        })), request.document.name);
      }
    }
  } finally {
    for (const entry of placed) safeDelete(entry.shape);
  }
  if (blob && request.kind === 'export-step') blob = await normalizeStepExportBlob(blob);
  const manifest = {
    schemaVersion: 5,
    format: request.kind.replace('export-', ''),
    units: 'mm',
    documentKind: 'assembly',
    assemblyId: built.solution.assembly.id,
    bodyCount: selected.length,
    componentCount: new Set(selected.map((runtime) => runtime.occurrenceInstance.occurrenceId)).size,
    solidCount: selected.reduce((total, runtime) => total + (runtime.geometry?.solidCount || 0), 0),
    names: selected.map((runtime) => runtime.bodyName),
    placements: selected.map((runtime) => ({
      bodyId: runtime.bodyId,
      occurrencePath: runtime.occurrenceInstance.occurrencePath,
      transform: runtime.exactPlacement,
      bounds: runtime.geometry?.bounds || null,
    })),
    interchange: interchangeManifest,
    structuredHierarchy: Boolean(interchangeManifest),
    assemblyFeatureExportMode: hasOccurrenceAssemblyFeatures
      ? 'flattened-exact-solved-occurrence-breps'
      : null,
  };
  self.postMessage({
    kind: 'export-result', requestId: request.requestId, projectId: request.projectId, revision: request.revision,
    errors, blob, manifest,
  });
  } finally {
    disposeV5Build(built);
  }
}

function shapeMatchScore(geometry, instance) {
  if (!instance?.bounds || !Number.isFinite(instance.volume)) return Number.POSITIVE_INFINITY;
  if (!geometry.bounds || !Number.isFinite(geometry.volume)) return Number.POSITIVE_INFINITY;
  const boundDelta = Math.max(...geometry.bounds.flatMap((corner, side) => corner.map((value, axis) => Math.abs(value - instance.bounds[side][axis]))));
  const size = Math.max(1, ...instance.bounds.flat().map(Math.abs));
  const volumeDelta = Math.abs(geometry.volume - instance.volume) / Math.max(1, Math.abs(instance.volume));
  if (boundDelta > Math.max(0.02, size * 1e-6) || volumeDelta > 1e-5) return Number.POSITIVE_INFINITY;
  return boundDelta / size + volumeDelta;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function unchangedStepHealingEvidenceForBody(evidence, shape) {
  if (evidence?.status !== 'unchanged') return structuredClone(evidence);
  if (!stepImportHealing) throw new Error('Imported STEP exact evidence inspection is unavailable.');
  const metrics = stepImportHealing.inspect(shape);
  if (metrics.brepValid !== true || metrics.solidCount !== 1 || metrics.shellCount !== 1
      || metrics.freeEdgeCount !== 0 || metrics.multipleEdgeCount !== 0
      || !(metrics.volumeMm3 > 1e-8)) {
    throw new Error('Imported STEP body did not retain one closed, valid exact OCCT solid.');
  }
  return {
    ...structuredClone(evidence),
    pre: structuredClone(metrics),
    post: structuredClone(metrics),
    drift: {
      maxBoundsDeltaMm: 0,
      absoluteVolumeDeltaMm3: 0,
      relativeVolumeDelta: 0,
    },
  };
}

function importedBodyRecord(ids, name, shape, originalBody, healingEvidence = null) {
  if (!importedTopologyRegistry || !shape?.wrapped) {
    throw new Error('Imported persistent topology capture is unavailable');
  }
  const captured = importedTopologyRegistry.capture({ shape, registryId: ids.resourceId });
  const bytes = new TextEncoder().encode(captured.sourceBrep);
  const carrierBytes = new TextEncoder().encode(captured.registry.carrierBrep).byteLength;
  const healingBase = healingEvidence
    ? unchangedStepHealingEvidenceForBody(healingEvidence, shape)
    : null;
  const healing = healingBase
    ? {
        ...healingBase,
        healedBrepSha256: studioV5Sha256Hex(captured.sourceBrep),
      }
    : null;
  return {
    resource: {
      id: ids.resourceId, name: name + ' exact STEP B-rep', mimeType: 'text/plain',
      byteLength: bytes.byteLength, encoding: 'base64', data: bytesToBase64(bytes),
      extensions: {
        studioImportedStep: {
          source: 'step',
          topologyRegistryByteLength: carrierBytes,
          topologyRegistry: captured.registry,
          ...(healing ? { healing } : {}),
        },
      },
    },
    feature: {
      id: ids.featureId, name: 'Imported ' + name, type: 'imported-step', suppressed: false, inputRefs: [],
      resultPolicy: { kind: 'new-body', bodyName: name },
      extensions: {
        studioImportedStep: {
          resourceId: ids.resourceId,
          exactBrep: true,
          parametricHistory: false,
          topologyRegistry: captured.featureReference,
          ...(healing ? { healing: structuredClone(healing) } : {}),
        },
      },
    },
    body: {
      id: ids.bodyId, name, kind: originalBody?.kind || 'solid', createdByFeatureId: ids.featureId,
      featureIds: [ids.featureId], visible: originalBody?.visible !== false, suppressed: false,
      ...(originalBody?.appearanceId ? { appearanceId: originalBody.appearanceId } : {}),
      ...(originalBody?.materialId ? { materialId: originalBody.materialId } : {}),
    },
  };
}

function externalStepMetadata(text) {
  const unit = /SI_UNIT\(\.MILLI\.,\s*\.METRE\.\)/i.test(text) ? { sourceUnits: 'mm', scaleToMm: 1 }
    : /SI_UNIT\(\.CENTI\.,\s*\.METRE\.\)/i.test(text) ? { sourceUnits: 'cm', scaleToMm: 10 }
      : /SI_UNIT\(\$,\s*\.METRE\.\)/i.test(text) ? { sourceUnits: 'm', scaleToMm: 1000 }
        : /CONVERSION_BASED_UNIT\(\s*'INCH'/i.test(text) ? { sourceUnits: 'in', scaleToMm: 25.4 }
          : { sourceUnits: 'unknown', scaleToMm: null };
  const colors = [];
  for (const match of text.matchAll(/COLOUR_RGB\(\s*'([^']*)'\s*,\s*([\d.+-Ee]+)\s*,\s*([\d.+-Ee]+)\s*,\s*([\d.+-Ee]+)\s*\)/gi)) {
    const rgb = match.slice(2, 5).map(Number);
    if (rgb.every(Number.isFinite)) colors.push({ name: match[1] || 'STEP color', rgb });
  }
  return { ...unit, colors };
}

function externalStepProductGraph(text) {
  const entities = new Map();
  for (const match of text.matchAll(/#(\d+)\s*=\s*([\s\S]*?);/g)) entities.set(Number(match[1]), match[2].trim());
  const refs = (source) => [...String(source || '').matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
  const strings = (source) => [...String(source || '').matchAll(/'((?:''|[^'])*)'/g)].map((match) => match[1].replaceAll("''", "'"));
  const products = new Map();
  const formations = new Map();
  const definitions = new Map();
  const relations = [];
  for (const [id, source] of entities) {
    if (/^PRODUCT\(/i.test(source)) products.set(id, strings(source)[0] || 'Imported product');
    else if (/^PRODUCT_DEFINITION_FORMATION(?:_WITH_SPECIFIED_SOURCE)?\(/i.test(source)) formations.set(id, refs(source).at(-1));
    else if (/^PRODUCT_DEFINITION\(/i.test(source)) definitions.set(id, refs(source)[0]);
    else if (/^NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/i.test(source)) {
      const relationRefs = refs(source); const values = strings(source);
      if (relationRefs.length >= 2) relations.push({ id, name: values[1] || values[0] || 'Imported occurrence', parent: relationRefs.at(-2), child: relationRefs.at(-1) });
    }
  }
  const nameForDefinition = (definitionId) => products.get(formations.get(definitions.get(definitionId))) || 'Imported product';
  const children = new Map();
  for (const relation of relations) {
    if (!children.has(relation.parent)) children.set(relation.parent, []);
    children.get(relation.parent).push(relation);
  }
  const childIds = new Set(relations.map((relation) => relation.child));
  const roots = [...children.keys()].filter((id) => !childIds.has(id));
  return { relations, children, roots, nameForDefinition };
}

function createExternalStructuredProject(filename, text, solids, healingEvidence) {
  const graph = externalStepProductGraph(text);
  if (graph.roots.length !== 1 || !graph.relations.length) throw new Error('external STEP has no unambiguous product root');
  const metadata = externalStepMetadata(text);
  const resources = []; const parts = []; const assemblies = []; let solidIndex = 0; let sequence = 0;
  const safeId = (prefix, value) => prefix + '-' + String(value || '').replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) + '-' + (++sequence).toString(36);
  const materials = metadata.colors.map((color, index) => {
    const hex = '#' + color.rgb.map((value) => Math.max(0, Math.min(255, Math.round(value * 255))).toString(16).padStart(2, '0')).join('');
    return {
      id: 'material-step-color-' + (index + 1), name: color.name || 'STEP color ' + (index + 1),
      appearanceId: 'appearance-step-color-' + (index + 1), source: 'Imported STEP presentation style',
      extensions: { studioAppearance: { baseColor: hex, metallic: 0.1, roughness: 0.55, opacity: 1, edgeColor: '#263746' }, sourceRgb: color.rgb },
    };
  });
  const isPartWrapper = (definitionId) => {
    const childRelations = graph.children.get(definitionId) || [];
    return childRelations.length > 0 && childRelations.every((relation) => !(graph.children.get(relation.child)?.length));
  };
  const buildPart = (definitionId, occurrenceName) => {
    const bodyRelations = graph.children.get(definitionId) || [];
    const bodyRecords = [];
    for (const relation of bodyRelations) {
      const solid = solids[solidIndex++];
      if (!solid) throw new Error('external STEP product hierarchy has more leaf bodies than exact solids');
      const suffix = solidIndex.toString(36); const bodyName = graph.nameForDefinition(relation.child) || relation.name || 'Imported body ' + solidIndex;
      const material = materials[(solidIndex - 1) % Math.max(1, materials.length)];
      const record = importedBodyRecord({ bodyId: 'body-step-' + suffix, featureId: 'feature-step-' + suffix, resourceId: 'resource-step-' + suffix }, bodyName, solid, {
        kind: 'solid', visible: true, ...(material ? { materialId: material.id, appearanceId: material.appearanceId } : {}),
      }, healingEvidence);
      resources.push(record.resource); bodyRecords.push(record);
    }
    const partId = safeId('part-step', occurrenceName || graph.nameForDefinition(definitionId));
    const part = importedPartRecord(partId, graph.nameForDefinition(definitionId) || occurrenceName, bodyRecords);
    part.metadata.sourceProductDefinitionId = definitionId;
    parts.push(part);
    return partId;
  };
  const buildAssembly = (definitionId, occurrenceName) => {
    const assemblyId = safeId('assembly-step', occurrenceName || graph.nameForDefinition(definitionId));
    const occurrences = [];
    for (const relation of graph.children.get(definitionId) || []) {
      if (!(graph.children.get(relation.child)?.length)) continue;
      const definition = isPartWrapper(relation.child)
        ? { kind: 'part', partId: buildPart(relation.child, relation.name) }
        : { kind: 'assembly', assemblyId: buildAssembly(relation.child, relation.name) };
      occurrences.push({
        id: safeId('occurrence-step', relation.name), name: relation.name || graph.nameForDefinition(relation.child), definition,
        baseTransform: assemblyIdentityMatrix(), fixed: true, suppressed: false, visible: true,
        extensions: { studioImportedStep: { sourceUsageId: relation.id, worldPlacedGeometry: true } },
      });
    }
    assemblies.push({
      id: assemblyId, name: graph.nameForDefinition(definitionId) || occurrenceName, parameters: [], occurrences,
      mates: [], occurrencePatterns: [], explodedViews: [], sectionViews: [],
      metadata: { importedFromStep: true, sourceProductDefinitionId: definitionId },
      extensions: { studioImportedStep: { externalProductHierarchy: true, worldPlacedGeometry: true } },
    });
    return assemblyId;
  };
  const rootAssemblyId = buildAssembly(graph.roots[0], filename.replace(/\.(step|stp)$/i, ''));
  if (solidIndex !== solids.length || !parts.length || !assemblies.length) throw new Error('external STEP product hierarchy does not cover every exact solid');
  assertImportedResourceBudget(resources);
  return {
    schemaVersion: 5, projectId: 'project-step-' + crypto.randomUUID(), name: graph.nameForDefinition(graph.roots[0]) || filename.replace(/\.(step|stp)$/i, ''), units: 'mm',
    parameters: [], materials, partDefinitions: parts, assemblyDefinitions: assemblies,
    rootDocument: { kind: 'assembly', assemblyId: rootAssemblyId }, resources,
    metadata: {
      importedFromStep: true, importMode: 'external-product-hierarchy', sourceUnits: metadata.sourceUnits, sourceUnitScaleToMm: metadata.scaleToMm,
      importLimitations: ['world-placed-imported-geometry', 'no-parametric-feature-history', 'no-mate-recovery', ...(materials.length ? ['external-material-density-unavailable'] : ['external-material-assignment-unavailable'])],
    },
  };
}

function importedPartRecord(id, name, bodyRecords) {
  return {
    id, name, parameters: [], referenceGeometry: [], sketches: [],
    bodies: bodyRecords.map((entry) => entry.body), bodyPatterns: [],
    features: bodyRecords.map((entry) => entry.feature), featureOrder: bodyRecords.map((entry) => entry.feature.id),
    metadata: { activeBodyId: bodyRecords[0]?.body.id || null, importedFromStep: true },
    extensions: { studioImportedStep: { exactBrep: true, parametricHistory: false } },
  };
}

function assertImportedResourceBudget(resources) {
  if (resources.length > 1000) throw new Error('STEP import exceeds the 1,000 exact-body resource limit');
  const bytes = resources.reduce((total, resource) => total
    + resource.byteLength
    + Number(resource.extensions?.studioImportedStep?.topologyRegistryByteLength || 0), 0);
  if (bytes > 100 * 1024 * 1024) throw new Error('STEP import exceeds the 100 MB exact-body resource limit');
}

function assertImportedManifestBudget(manifest, solidCount) {
  const parts = Array.isArray(manifest.parts) ? manifest.parts : [];
  const assemblies = Array.isArray(manifest.assemblies) ? manifest.assemblies : [];
  const instances = Array.isArray(manifest.bodyInstances) ? manifest.bodyInstances : [];
  const occurrenceCount = assemblies.reduce((total, assembly) => total + (Array.isArray(assembly?.occurrences) ? assembly.occurrences.length : 0), 0);
  if (parts.length > STUDIO_V5_PROJECT_LIMITS.partDefinitions) throw new Error('PartMode STEP hierarchy exceeds the part-definition limit');
  if (assemblies.length > STUDIO_V5_PROJECT_LIMITS.assemblyDefinitions) throw new Error('PartMode STEP hierarchy exceeds the assembly-definition limit');
  if (occurrenceCount > STUDIO_V5_PROJECT_LIMITS.occurrences) throw new Error('PartMode STEP hierarchy exceeds the occurrence limit');
  if (instances.length > STUDIO_V5_PROJECT_LIMITS.generatedOccurrences) throw new Error('PartMode STEP hierarchy exceeds the 5,000 body-instance import limit');
  if (solidCount > STUDIO_V5_PROJECT_LIMITS.generatedOccurrences) throw new Error('STEP import exceeds the 5,000 exact-solid separation limit');
}

function createStructuredImportedProject(filename, manifest, solids, solidGeometry, healingEvidence) {
  if (!Array.isArray(manifest.parts) || !Array.isArray(manifest.assemblies) || !Array.isArray(manifest.bodyInstances)) {
    throw new Error('PartMode STEP hierarchy manifest is incomplete');
  }
  assertImportedManifestBudget(manifest, solids.length);
  const unused = new Set(solids.map((_, index) => index));
  const matched = new Map();
  for (const instance of manifest.bodyInstances) {
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const index of unused) {
      const score = shapeMatchScore(solidGeometry[index], instance);
      if (score < bestScore) { bestIndex = index; bestScore = score; }
    }
    if (bestIndex < 0) throw new Error('STEP geometry does not match its PartMode hierarchy manifest');
    unused.delete(bestIndex);
    const key = instance.partId + ':' + instance.localBodyId;
    if (!matched.has(key)) matched.set(key, { solid: solids[bestIndex], instance });
  }
  if (unused.size || matched.size === 0) throw new Error('STEP solid count does not match its PartMode hierarchy manifest');

  const resources = [];
  const parts = [];
  let sequence = 0;
  for (const part of manifest.parts) {
    const bodyRecords = [];
    for (const originalBody of part.bodies || []) {
      const found = matched.get(part.id + ':' + originalBody.id);
      if (!found) continue;
      const localShape = applyRigidMatrix(found.solid, studioV5RigidInverse(found.instance.transform));
      try {
        const suffix = (++sequence).toString(36);
        const record = importedBodyRecord({
          bodyId: originalBody.id,
          featureId: 'feature-step-' + suffix,
          resourceId: 'resource-step-' + suffix,
        }, originalBody.name, localShape, originalBody, healingEvidence);
        resources.push(record.resource); bodyRecords.push(record);
      } finally { safeDelete(localShape); }
    }
    if (bodyRecords.length) parts.push(importedPartRecord(part.id, part.name, bodyRecords));
  }
  assertImportedResourceBudget(resources);
  const partIds = new Set(parts.map((part) => part.id));
  const assemblyIds = new Set((manifest.assemblies || []).map((assembly) => assembly.id));
  const assemblies = (manifest.assemblies || []).map((assembly) => ({
    id: assembly.id, name: assembly.name, parameters: [],
    occurrences: (assembly.occurrences || []).filter((occurrence) =>
      occurrence.definition?.kind === 'part' ? partIds.has(occurrence.definition.partId) : assemblyIds.has(occurrence.definition?.assemblyId),
    ).map((occurrence) => ({
      id: occurrence.id, name: occurrence.name, definition: occurrence.definition,
      baseTransform: occurrence.transform, fixed: true, suppressed: false, visible: occurrence.visible !== false,
      extensions: { studioImportedStep: { solvedPlacement: true, sourcePatternId: occurrence.extensions?.sourcePatternId || null } },
    })),
    mates: [], occurrencePatterns: [], explodedViews: [], sectionViews: [],
    metadata: { importedFromStep: true },
    extensions: { studioImportedStep: { solvedHierarchy: true, mateRecovery: false } },
  }));
  if (!parts.length || !assemblies.some((assembly) => assembly.id === manifest.rootAssemblyId)) throw new Error('PartMode STEP hierarchy has no reusable geometry or root assembly');
  return {
    schemaVersion: 5,
    projectId: 'project-step-' + crypto.randomUUID(),
    name: manifest.projectName || filename.replace(/\.(step|stp)$/i, '') || 'Imported STEP assembly',
    units: 'mm', parameters: [], materials: structuredClone(manifest.materials || []), partDefinitions: parts, assemblyDefinitions: assemblies,
    rootDocument: { kind: 'assembly', assemblyId: manifest.rootAssemblyId }, resources,
    metadata: {
      importedFromStep: true, importMode: 'partmode-solved-hierarchy', sourceUnits: manifest.sourceUnits || manifest.units,
      importLimitations: ['no-parametric-feature-history', 'no-mate-recovery'],
    },
  };
}

function createFlatImportedProject(filename, solids, healingEvidence) {
  const resources = [];
  const bodyRecords = [];
  solids.forEach((solid, index) => {
    const suffix = (index + 1).toString(36);
    const bodyName = 'Imported solid ' + (index + 1);
    const record = importedBodyRecord({
      bodyId: 'body-step-' + suffix, featureId: 'feature-step-' + suffix, resourceId: 'resource-step-' + suffix,
    }, bodyName, solid, undefined, healingEvidence);
    resources.push(record.resource);
    bodyRecords.push(record);
  });
  assertImportedResourceBudget(resources);
  const partId = 'part-step-flat';
  const parts = [importedPartRecord(partId, 'Imported STEP solids', bodyRecords)];
  const occurrences = [{
    id: 'occurrence-step-flat', name: 'Imported STEP solids:1', definition: { kind: 'part', partId },
    baseTransform: assemblyIdentityMatrix(), fixed: true, suppressed: false, visible: true,
    extensions: { studioImportedStep: { flatFallback: true } },
  }];
  const assemblyId = 'assembly-step-root';
  return {
    schemaVersion: 5, projectId: 'project-step-' + crypto.randomUUID(),
    name: filename.replace(/\.(step|stp)$/i, '') || 'Imported STEP', units: 'mm',
    parameters: [], materials: [], partDefinitions: parts,
    assemblyDefinitions: [{
      id: assemblyId, name: 'Imported STEP solids', parameters: [], occurrences,
      mates: [], occurrencePatterns: [], explodedViews: [], sectionViews: [],
      metadata: { importedFromStep: true }, extensions: { studioImportedStep: { flatFallback: true } },
    }],
    rootDocument: { kind: 'assembly', assemblyId }, resources,
    metadata: {
      importedFromStep: true, importMode: 'flat-solid-fallback',
      importLimitations: ['external-product-hierarchy-unavailable', 'no-parametric-feature-history', 'no-mate-recovery'],
    },
  };
}

function stepImportFailure(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function sha256ByteArray(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function readStepShapeWithPolicy(blob) {
  const oc = rc.getOC();
  const unitKey = 'xstep.cascade.unit';
  const sameParameterKey = 'read.stdsameparameter.mode';
  // OCCT registers its STEP Interface_Static controls lazily when the first
  // reader is constructed. Initialise that registry before snapshotting it;
  // blindly writing an absent key returns false and provides no unit policy.
  const policyInitializer = new oc.STEPControl_Reader_1();
  policyInitializer.delete();
  if (!oc.Interface_Static.IsPresent(unitKey) || !oc.Interface_Static.IsPresent(sameParameterKey)) {
    throw stepImportFailure('STEP_READER_POLICY_UNAVAILABLE', 'The bundled STEP reader policy controls are unavailable.');
  }
  const previousUnit = oc.Interface_Static.CVal(unitKey);
  const previousSameParameter = oc.Interface_Static.IVal(sameParameterKey);
  const setUnit = oc.Interface_Static.SetCVal(unitKey, 'MM');
  const setSameParameter = oc.Interface_Static.SetIVal(sameParameterKey, 1);
  if (!setUnit || !setSameParameter) {
    oc.Interface_Static.SetCVal(unitKey, previousUnit);
    oc.Interface_Static.SetIVal(sameParameterKey, previousSameParameter);
    throw stepImportFailure('STEP_READER_POLICY_UNAVAILABLE', 'The bundled STEP reader rejected the required millimetre and same-parameter policy.');
  }
  let imported = null;
  let readError = null;
  try {
    for (let attempt = 0; attempt < 2 && !imported; attempt++) {
      try { imported = await rc.importSTEP(blob); }
      catch (error) { readError = error; }
    }
    if (!imported) {
      throw stepImportFailure(
        'STEP_READER_REJECTED',
        'reading STEP geometry: ' + String(readError?.message || readError),
        readError,
      );
    }
    return imported;
  } finally {
    const restoredUnit = oc.Interface_Static.SetCVal(unitKey, previousUnit);
    const restoredSameParameter = oc.Interface_Static.SetIVal(sameParameterKey, previousSameParameter);
    if (!restoredUnit || !restoredSameParameter) {
      safeDelete(imported);
      imported = null;
      throw stepImportFailure('STEP_READER_POLICY_RESTORE_FAILED', 'The STEP reader policy could not be restored after import.');
    }
  }
}

function expectedManifestBodyCount(manifest) {
  if (!manifest || !Array.isArray(manifest.bodyInstances)) return null;
  return new Set(manifest.bodyInstances.map((instance) => instance.partId + ':' + instance.localBodyId)).size;
}

function assertUnambiguousStepHealing(text, manifest, evidence) {
  if (!evidence?.applied) return;
  const manifestBodies = expectedManifestBodyCount(manifest);
  if (manifestBodies != null && manifestBodies !== 1) {
    throw stepImportFailure(
      'STEP_HEALING_HIERARCHY_AMBIGUOUS',
      'Bounded STEP healing refuses a hierarchy that expects ' + manifestBodies + ' separate bodies.',
    );
  }
  if (manifest) {
    const identity = assemblyIdentityMatrix();
    const instances = Array.isArray(manifest.bodyInstances) ? manifest.bodyInstances : [];
    const hasNonIdentityPlacement = instances.some((instance) => {
      const transform = instance?.transform;
      return !Array.isArray(transform) || transform.length !== 16
        || transform.some((value, index) => !Number.isFinite(value)
          || Math.abs(value - identity[index]) > 1e-12);
    });
    if (hasNonIdentityPlacement) {
      throw stepImportFailure(
        'STEP_HEALING_HIERARCHY_AMBIGUOUS',
        'Bounded STEP healing refuses transformed PartMode hierarchy geometry because source-space evidence would not match the stored local B-rep.',
      );
    }
  }
}

function stepHealingManifest(evidence, bodyCount) {
  const applied = evidence?.status === 'healed' && evidence.applied === true;
  return {
    schema: evidence?.schema || 'partmode.step-healing/v1',
    attempted: applied,
    applied,
    status: applied ? 'healed' : 'unchanged',
    healedBodyCount: applied ? bodyCount : 0,
    unchangedBodyCount: applied ? 0 : bodyCount,
    selectedToleranceMm: Number(evidence?.selectedToleranceMm || 0),
    maxToleranceMm: Number(evidence?.policy?.maxToleranceMm || 0),
    sourceSha256: evidence?.sourceSha256 || null,
    defects: Array.isArray(evidence?.defects) ? [...evidence.defects] : [],
    actions: Array.isArray(evidence?.actions) ? [...evidence.actions] : [],
  };
}

async function importV5Step(request) {
  await loadKernel();
  if (!(request.blob instanceof Blob)) throw new Error('STEP import requires a file');
  if (request.blob.size <= 0 || request.blob.size > STUDIO_V5_STEP_BYTES) throw new Error('STEP files must be between 1 byte and 50 MB');
  const filename = String(request.filename || 'import.step').slice(0, 200);
  if (!/\.(step|stp)$/i.test(filename)) throw new Error('Only .step and .stp files can be imported');
  const sourceBytes = new Uint8Array(await request.blob.arrayBuffer());
  const text = new TextDecoder().decode(sourceBytes);
  const sourceSha256 = await sha256ByteArray(sourceBytes);
  const manifest = stepManifestFromText(text);
  let stage = 'reading STEP geometry';
  let imported = null;
  let solids = [];
  try {
    imported = await readStepShapeWithPolicy(request.blob);
    stage = 'validating and healing exact STEP geometry';
    if (!stepImportHealing) throw stepImportFailure('STEP_HEALING_UNAVAILABLE', 'The bounded STEP healing service is unavailable.');
    const prepared = stepImportHealing.prepare(imported, {
      filename,
      sourceSha256,
      sourceByteLength: sourceBytes.byteLength,
      maxCandidates: STUDIO_V5_PROJECT_LIMITS.generatedOccurrences,
    });
    solids = prepared.solids;
    const healingEvidence = prepared.evidence;
    if (!Array.isArray(solids) || !solids.length) {
      throw stepImportFailure('STEP_HEALING_REFUSED', 'STEP import produced no accepted exact solid bodies.');
    }
    if (solids.length > STUDIO_V5_PROJECT_LIMITS.generatedOccurrences) {
      throw stepImportFailure('STEP_IMPORT_BODY_LIMIT', 'STEP import exceeds the 5,000 exact-solid separation limit.');
    }
    assertUnambiguousStepHealing(text, manifest, healingEvidence);
    const solidGeometry = solids.map((solid) => ({ bounds: solid.boundingBox?.bounds ?? null, volume: shapeVolume(solid) }));
    stage = 'reconstructing the imported document';
    let importedProject;
    if (manifest) importedProject = createStructuredImportedProject(filename, manifest, solids, solidGeometry, healingEvidence);
    else {
      try { importedProject = createExternalStructuredProject(filename, text, solids, healingEvidence); }
      catch { importedProject = createFlatImportedProject(filename, solids, healingEvidence); }
    }
    const healing = stepHealingManifest(healingEvidence, solids.length);
    importedProject.metadata.stepHealing = structuredClone(healing);
    const project = prepareStudioV5Project(importedProject);
    if (request.delayMs) await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(0, request.delayMs))));
    self.postMessage({
      kind: 'import-result', requestId: request.requestId, projectId: request.projectId, revision: request.revision,
      project, manifest: {
        importMode: project.metadata.importMode,
        bodyCount: project.partDefinitions.reduce((total, part) => total + part.bodies.length, 0),
        partCount: project.partDefinitions.length,
        assemblyCount: project.assemblyDefinitions.length,
        exactGeometry: true,
        limitations: project.metadata.importLimitations,
        healing,
      },
    });
  } catch (error) {
    if (String(error?.message || error).startsWith(stage + ':')) throw error;
    const wrapped = stepImportFailure(
      typeof error?.code === 'string' ? error.code : 'STEP_IMPORT_FAILED',
      stage + ': ' + String(error?.message || error),
      error,
    );
    throw wrapped;
  } finally {
    if (stepImportHealing) stepImportHealing.disposeSolids(solids);
    else for (const solid of solids) safeDelete(solid);
    safeDelete(imported);
  }
}

function queueStepImport(request) {
  const queued = stepImportQueue.then(() => importV5Step(request));
  stepImportQueue = queued.catch(() => {});
  return queued;
}

function releaseShape(request) {
  for (const entry of currentBodyCache.values()) { safeDelete(entry.shape); disposeCachedNameData(entry); }
  currentBodyCache = new Map();
  currentAssemblySolutions = new Map();
  currentAssemblySolutionKey = null;
  currentRevision = request.revision;
  self.postMessage({
    kind: 'release-result',
    requestId: request.requestId,
    projectId: request.projectId,
    revision: request.revision,
  });
}

async function reportMemoryStats(request) {
  await loadKernel();
  const oc = rc?.getOC?.();
  const heapBuffer = oc?.HEAP8?.buffer || oc?.wasmMemory?.buffer || oc?.asm?.memory?.buffer || null;
  self.postMessage({
    kind: 'memory-stats-result', requestId: request.requestId, projectId: request.projectId, revision: request.revision,
    memory: {
      wasmHeapBytes: heapBuffer?.byteLength || 0,
      retainedShapeEntries: currentBodyCache.size,
      retainedAssemblySolutions: currentAssemblySolutions.size,
    },
  });
}

self.addEventListener('message', (event) => {
  const request = event.data;
  if (!request || typeof request !== 'object') return;
  const run = request.kind === 'rebuild'
    ? rebuild(request)
    : request.kind === 'validate-v5'
      ? validateV5(request)
    : request.kind === 'smart-fastener-plan-v5'
      ? planSmartFastenerV5(request)
    : ['export-step', 'export-stl', 'export-amf', 'export-3mf'].includes(request.kind)
      ? exportDocument(request)
      : request.kind === 'drawing-v5'
        ? drawingDocument(request)
      : request.kind === 'freeze-pattern-v5'
      ? freezePatternOccurrences(request)
      : request.kind === 'import-step-v5'
        ? queueStepImport(request)
      : request.kind === 'inspect-v5'
        ? inspectV5(request)
      : request.kind === 'release'
        ? Promise.resolve(releaseShape(request))
      : request.kind === 'memory-stats'
        ? reportMemoryStats(request)
        : Promise.resolve();
  run.catch((error) => {
    self.postMessage({
      kind: 'kernel-error',
      requestId: request.requestId,
      projectId: request.projectId,
      revision: request.revision,
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      message: String(error?.message || error),
    });
  });
});

// Start initialization as soon as the module worker is alive. Requests that
// arrive during the WASM load await the same promise.
loadKernel().catch(() => {});
