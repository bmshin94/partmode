// Source-owned partmode.dxf/v1 writer and bounded R12 sketch importer.
//
// Emits deterministic DXF R12 (AC1009) ASCII text for two bounded exports:
//   - createStudioDrawingDxf: the exact OCCT HLR projection paths of the
//     generic four-view drawing sheet, unscaled model millimetres, one layer
//     pair per view with a documented third-angle offset layout.
//   - createStudioSketchDxf: one solved constraint-native sketch profile in
//     sketch-local millimetres.
//
// Entity vocabulary: LINE, ARC, CIRCLE, and LWPOLYLINE. LWPOLYLINE is emitted
// only under the explicit documented spline tessellation policy; the default
// policy fails closed on every curve class that DXF R12 cannot carry exactly
// (quadratic/cubic Bezier spans and elliptical arcs). Nothing user-controlled
// is embedded in the artifact. See docs/dxf-export.md for the full contract.
//
// importStudioSketchDxf reads the same bounded vocabulary back from DXF R12
// ASCII text in millimetres into one constraint-native sketch. Every group
// code, entity type, version, unit declaration, and bound outside the
// documented subset fails closed with a typed StudioDxfError; DWG and R13+
// remain explicit exclusions.

import { sampleSplineThrough, solveSketch } from './studio-sketch-solver.js';

export const STUDIO_DXF_SCHEMA = 'partmode.dxf/v1';
export const STUDIO_DXF_VERSION = 'AC1009';
export const STUDIO_DXF_SPLINE_POLICIES = Object.freeze(['fail', 'tessellate-v1']);
export const STUDIO_DXF_VIEW_GAP_MM = 20;
export const STUDIO_DXF_BEZIER_TESSELLATION_STEPS = 32;
export const STUDIO_DXF_SPLINE_TESSELLATION_STEPS = 16;
export const STUDIO_DXF_MAX_ENTITIES = 20_000;
export const STUDIO_DXF_MAX_BYTES = 8 * 1024 * 1024;
export const STUDIO_DXF_FULL_CIRCLE_CHORD_MM = 1e-3;

const STANDARD_VIEWS = Object.freeze(['front', 'top', 'right', 'iso']);

// The DXF sheet carries the orthographic views only. The pictorial iso view
// projects circular model edges as elliptical arcs, and DXF R12 has no exact
// ellipse entity, so the iso view is an explicit exclusion of this slice
// rather than a silent approximation.
export const STUDIO_DXF_SHEET_VIEWS = Object.freeze(['front', 'top', 'right']);

export class StudioDxfError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StudioDxfError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StudioDxfError(code, message);
}

// Deterministic coordinate formatting: round half away from zero at 1e-6 mm,
// never scientific notation, never negative zero.
function num(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1e9) {
    fail('DXF_INVALID_NUMBER', 'DXF writer received a non-finite or out-of-range coordinate.');
  }
  const rounded = Math.round(number * 1e6) / 1e6;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function splinePolicyOf(options) {
  const policy = options?.splinePolicy ?? 'fail';
  if (!STUDIO_DXF_SPLINE_POLICIES.includes(policy)) {
    fail('DXF_SPLINE_POLICY_INVALID', 'DXF spline policy must be one of: ' + STUDIO_DXF_SPLINE_POLICIES.join(', ') + '.');
  }
  return policy;
}

// --- primitive collection ---------------------------------------------------

function createCollector() {
  const entities = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const touch = (x, y) => {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  };
  const push = (entity) => {
    entities.push(entity);
    if (entities.length > STUDIO_DXF_MAX_ENTITIES) {
      fail('DXF_LIMIT_EXCEEDED', 'DXF export exceeds the bounded limit of ' + STUDIO_DXF_MAX_ENTITIES + ' entities.');
    }
  };
  return {
    entities,
    bounds,
    line(layer, a, b) {
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= 1e-9) return;
      touch(a[0], a[1]);
      touch(b[0], b[1]);
      push({ kind: 'line', layer, a, b });
    },
    circle(layer, center, r) {
      if (!(r > 0)) fail('DXF_INVALID_NUMBER', 'DXF circle radius must be positive.');
      touch(center[0] - r, center[1] - r);
      touch(center[0] + r, center[1] + r);
      push({ kind: 'circle', layer, center, r });
    },
    // startDeg/endDeg follow the DXF convention: counterclockwise from start
    // to end. Bounds are the conservative full-circle box.
    arc(layer, center, r, startDeg, endDeg) {
      if (!(r > 0)) fail('DXF_INVALID_NUMBER', 'DXF arc radius must be positive.');
      touch(center[0] - r, center[1] - r);
      touch(center[0] + r, center[1] + r);
      push({ kind: 'arc', layer, center, r, startDeg, endDeg });
    },
    polyline(layer, points, closed) {
      if (points.length < 2) return;
      for (const point of points) touch(point[0], point[1]);
      push({ kind: 'polyline', layer, points, closed: Boolean(closed) });
    },
  };
}

// --- DXF text emission ------------------------------------------------------

function normalizeAngle(degrees) {
  const wrapped = ((degrees % 360) + 360) % 360;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

function emitDxf(comments, collector, layerOrder) {
  const usedLayers = new Set(collector.entities.map((entity) => entity.layer));
  const layers = layerOrder.filter((layer) => usedLayers.has(layer.name));
  if (!layers.length || !collector.entities.length) {
    fail('DXF_EMPTY', 'DXF export produced no drawable entities.');
  }
  const lines = [];
  const push = (code, value) => { lines.push(String(code), String(value)); };
  for (const comment of comments) push(999, comment);
  push(0, 'SECTION');
  push(2, 'HEADER');
  push(9, '$ACADVER');
  push(1, STUDIO_DXF_VERSION);
  push(9, '$INSBASE');
  push(10, '0'); push(20, '0'); push(30, '0');
  push(9, '$EXTMIN');
  push(10, num(collector.bounds.minX)); push(20, num(collector.bounds.minY)); push(30, '0');
  push(9, '$EXTMAX');
  push(10, num(collector.bounds.maxX)); push(20, num(collector.bounds.maxY)); push(30, '0');
  push(0, 'ENDSEC');
  push(0, 'SECTION');
  push(2, 'TABLES');
  push(0, 'TABLE');
  push(2, 'LTYPE');
  push(70, '2');
  push(0, 'LTYPE');
  push(2, 'CONTINUOUS');
  push(70, '0');
  push(3, 'Solid line');
  push(72, '65'); push(73, '0'); push(40, '0');
  push(0, 'LTYPE');
  push(2, 'DASHED');
  push(70, '0');
  push(3, 'Dashed line');
  push(72, '65'); push(73, '2'); push(40, '0.75'); push(49, '0.5'); push(49, '-0.25');
  push(0, 'ENDTAB');
  push(0, 'TABLE');
  push(2, 'LAYER');
  push(70, String(layers.length));
  for (const layer of layers) {
    push(0, 'LAYER');
    push(2, layer.name);
    push(70, '0');
    push(62, String(layer.color));
    push(6, layer.linetype);
  }
  push(0, 'ENDTAB');
  push(0, 'ENDSEC');
  push(0, 'SECTION');
  push(2, 'ENTITIES');
  for (const entity of collector.entities) {
    if (entity.kind === 'line') {
      push(0, 'LINE');
      push(8, entity.layer);
      push(10, num(entity.a[0])); push(20, num(entity.a[1])); push(30, '0');
      push(11, num(entity.b[0])); push(21, num(entity.b[1])); push(31, '0');
    } else if (entity.kind === 'circle') {
      push(0, 'CIRCLE');
      push(8, entity.layer);
      push(10, num(entity.center[0])); push(20, num(entity.center[1])); push(30, '0');
      push(40, num(entity.r));
    } else if (entity.kind === 'arc') {
      push(0, 'ARC');
      push(8, entity.layer);
      push(10, num(entity.center[0])); push(20, num(entity.center[1])); push(30, '0');
      push(40, num(entity.r));
      push(50, num(normalizeAngle(entity.startDeg)));
      push(51, num(normalizeAngle(entity.endDeg)));
    } else {
      push(0, 'LWPOLYLINE');
      push(8, entity.layer);
      push(90, String(entity.points.length));
      push(70, entity.closed ? '1' : '0');
      for (const point of entity.points) {
        push(10, num(point[0]));
        push(20, num(point[1]));
      }
    }
  }
  push(0, 'ENDSEC');
  push(0, 'EOF');
  const text = lines.join('\n') + '\n';
  if (text.length > STUDIO_DXF_MAX_BYTES) {
    fail('DXF_LIMIT_EXCEEDED', 'DXF export exceeds the bounded output size of ' + STUDIO_DXF_MAX_BYTES + ' bytes.');
  }
  return text;
}

// --- exact HLR path parsing -------------------------------------------------

// The exact worker serializes OCCT HLR edges through replicad as absolute SVG
// path data with the fixed grammar M / L / Q / C / A / Z, space separated.
// Anything outside that grammar fails closed.
const COMMAND_ARITY = Object.freeze({ M: 2, L: 2, Q: 4, C: 6, A: 7, Z: 0 });
const NUMBER_PATTERN = /^-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?$/iu;

function parseExactPath(path) {
  const tokens = String(path).trim().split(/[\s,]+/u).filter(Boolean);
  const primitives = [];
  let current = null;
  let subpathStart = null;
  let index = 0;
  const readNumber = () => {
    const token = tokens[index++];
    if (typeof token !== 'string' || !NUMBER_PATTERN.test(token)) {
      fail('DXF_PATH_INVALID', 'Exact projection path contains a malformed number.');
    }
    const value = Number(token);
    if (!Number.isFinite(value)) fail('DXF_PATH_INVALID', 'Exact projection path contains a non-finite number.');
    return value;
  };
  while (index < tokens.length) {
    const command = tokens[index++];
    const arity = COMMAND_ARITY[command];
    if (arity === undefined) {
      fail('DXF_PATH_INVALID', 'Exact projection path uses an unsupported command "' + String(command).slice(0, 8) + '".');
    }
    if (command !== 'M' && command !== 'Z' && !current) {
      fail('DXF_PATH_INVALID', 'Exact projection path draws before its first move command.');
    }
    if (command === 'M') {
      const x = readNumber();
      const y = readNumber();
      current = [x, y];
      subpathStart = [x, y];
    } else if (command === 'L') {
      const next = [readNumber(), readNumber()];
      primitives.push({ kind: 'line', a: current, b: next });
      current = next;
    } else if (command === 'Q') {
      const c1 = [readNumber(), readNumber()];
      const next = [readNumber(), readNumber()];
      primitives.push({ kind: 'quadratic', a: current, c1, b: next });
      current = next;
    } else if (command === 'C') {
      const c1 = [readNumber(), readNumber()];
      const c2 = [readNumber(), readNumber()];
      const next = [readNumber(), readNumber()];
      primitives.push({ kind: 'cubic', a: current, c1, c2, b: next });
      current = next;
    } else if (command === 'A') {
      const rx = readNumber();
      const ry = readNumber();
      const rotation = readNumber();
      const largeArc = readNumber();
      const sweep = readNumber();
      const next = [readNumber(), readNumber()];
      if (largeArc !== 0 && largeArc !== 1) fail('DXF_PATH_INVALID', 'Exact projection arc has an invalid large-arc flag.');
      if (sweep !== 0 && sweep !== 1) fail('DXF_PATH_INVALID', 'Exact projection arc has an invalid sweep flag.');
      primitives.push({ kind: 'arc', a: current, b: next, rx, ry, rotation, largeArc: largeArc === 1, sweep: sweep === 1 });
      current = next;
    } else {
      if (subpathStart && current
        && Math.hypot(subpathStart[0] - current[0], subpathStart[1] - current[1]) > 1e-9) {
        primitives.push({ kind: 'line', a: current, b: subpathStart });
      }
      current = subpathStart;
    }
  }
  if (!primitives.length) fail('DXF_PATH_INVALID', 'Exact projection path contains no drawable segments.');
  return primitives;
}

// Endpoint-parameterized circular arc to center form, in y-up model
// coordinates. ccw is the y-up sweep direction.
function arcCenterForm(a, b, r, largeArc, ccw) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const chord = Math.hypot(dx, dy);
  if (!(r > 0) || chord <= 1e-12) fail('DXF_PATH_INVALID', 'Exact projection arc is degenerate.');
  let half = chord / 2;
  if (half > r) {
    if (half - r > 1e-6) fail('DXF_PATH_INVALID', 'Exact projection arc chord exceeds its diameter.');
    half = r;
  }
  const height = Math.sqrt(Math.max(0, r * r - half * half));
  // Counterclockwise minor arcs and clockwise major arcs keep their center on
  // the left of the directed chord.
  const sign = (ccw !== largeArc) ? 1 : -1;
  const center = [
    (a[0] + b[0]) / 2 + sign * height * (-dy / chord),
    (a[1] + b[1]) / 2 + sign * height * (dx / chord),
  ];
  const startDeg = Math.atan2(a[1] - center[1], a[0] - center[0]) * 180 / Math.PI;
  const endDeg = Math.atan2(b[1] - center[1], b[0] - center[0]) * 180 / Math.PI;
  return { center, startDeg, endDeg };
}

function sampleBezier(primitive, steps) {
  const points = [[primitive.a[0], primitive.a[1]]];
  const quadratic = primitive.kind === 'quadratic';
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const u = 1 - t;
    if (quadratic) {
      points.push([
        u * u * primitive.a[0] + 2 * u * t * primitive.c1[0] + t * t * primitive.b[0],
        u * u * primitive.a[1] + 2 * u * t * primitive.c1[1] + t * t * primitive.b[1],
      ]);
    } else {
      points.push([
        u * u * u * primitive.a[0] + 3 * u * u * t * primitive.c1[0] + 3 * u * t * t * primitive.c2[0] + t * t * t * primitive.b[0],
        u * u * u * primitive.a[1] + 3 * u * u * t * primitive.c1[1] + 3 * u * t * t * primitive.c2[1] + t * t * t * primitive.b[1],
      ]);
    }
  }
  return points;
}

// --- drawing sheet export ---------------------------------------------------

function exactViews(response) {
  if (!response || response.kind !== 'drawing-result' || response.errors?.length
    || response.manifest?.exactProjectionEvidence?.kind !== 'occt-hlr-exact') {
    fail('DXF_EXACT_REQUIRED', 'Drawing DXF requires a successful exact OCCT HLR result.');
  }
  if (!Array.isArray(response.views) || response.views.length !== 4) {
    fail('DXF_VIEW_SET_INVALID', 'Drawing DXF requires exactly four standard views.');
  }
  const byView = new Map();
  let pathCount = 0;
  let pathCharacters = 0;
  for (const source of response.views) {
    const view = String(source?.view || '');
    const viewBox = Array.isArray(source?.viewBox) ? source.viewBox.map(Number) : [];
    const visible = Array.isArray(source?.visible) ? source.visible.map(String) : [];
    const hidden = Array.isArray(source?.hidden) ? source.hidden.map(String) : [];
    if (!STANDARD_VIEWS.includes(view) || byView.has(view) || viewBox.length !== 4
      || viewBox.some((entry) => !Number.isFinite(entry)) || viewBox[2] <= 0 || viewBox[3] <= 0 || !visible.length
      || [...visible, ...hidden].some((entry) => !entry.trim() || entry.length > 1_000_000)) {
      fail('DXF_VIEW_SET_INVALID', 'Drawing DXF view identity, bounds, or exact paths are invalid.');
    }
    pathCount += visible.length + hidden.length;
    pathCharacters += [...visible, ...hidden].reduce((sum, entry) => sum + entry.length, 0);
    if (pathCount > 100_000 || pathCharacters > 16 * 1024 * 1024) {
      fail('DXF_LIMIT_EXCEEDED', 'Drawing DXF exact paths exceed the bounded input limit.');
    }
    byView.set(view, { view, viewBox, visible, hidden });
  }
  if (STANDARD_VIEWS.some((view) => !byView.has(view))) {
    fail('DXF_VIEW_SET_INVALID', 'Drawing DXF standard view set is incomplete.');
  }
  return byView;
}

function modelBox(viewBox) {
  return {
    minX: viewBox[0],
    minY: -viewBox[1] - viewBox[3],
    maxX: viewBox[0] + viewBox[2],
    maxY: -viewBox[1],
  };
}

export function studioDrawingDxfLayerName(view, hidden) {
  return 'PM-' + view.toUpperCase() + (hidden ? '-HIDDEN' : '');
}

// The documented third-angle layout: every view keeps its exact unscaled
// model-space millimetre coordinates (the SVG y axis is mirrored back to the
// model y axis) plus one per-view translation. front is untranslated, top
// sits one gap above front, right sits one gap to the right of front, and iso
// sits one further gap to the right of the right view with its bottom edge on
// the bottom edge of front.
export function studioDrawingDxfViewOffsets(byView) {
  const boxes = Object.fromEntries(STUDIO_DXF_SHEET_VIEWS.map((view) => [view, modelBox(byView.get(view).viewBox)]));
  const gap = STUDIO_DXF_VIEW_GAP_MM;
  return {
    front: [0, 0],
    top: [0, boxes.front.maxY + gap - boxes.top.minY],
    right: [boxes.front.maxX + gap - boxes.right.minX, 0],
  };
}

export function createStudioDrawingDxf(response, options = {}) {
  const splinePolicy = splinePolicyOf(options);
  const byView = exactViews(response);
  const offsets = studioDrawingDxfViewOffsets(byView);
  const collector = createCollector();
  const layerOrder = [];
  for (const view of STUDIO_DXF_SHEET_VIEWS) {
    layerOrder.push({ name: studioDrawingDxfLayerName(view, false), color: 7, linetype: 'CONTINUOUS' });
    layerOrder.push({ name: studioDrawingDxfLayerName(view, true), color: 8, linetype: 'DASHED' });
  }
  for (const view of STUDIO_DXF_SHEET_VIEWS) {
    const entry = byView.get(view);
    const [offsetX, offsetY] = offsets[view];
    const toModel = (point) => [point[0] + offsetX, -point[1] + offsetY];
    for (const hidden of [false, true]) {
      const layer = studioDrawingDxfLayerName(view, hidden);
      for (const path of hidden ? entry.hidden : entry.visible) {
        for (const primitive of parseExactPath(path)) {
          if (primitive.kind === 'line') {
            collector.line(layer, toModel(primitive.a), toModel(primitive.b));
          } else if (primitive.kind === 'arc') {
            if (Math.abs(primitive.rx - primitive.ry) > 1e-9 * Math.max(1, primitive.rx) || primitive.rotation !== 0) {
              fail('DXF_UNSUPPORTED_CURVE', 'Elliptical exact projection edges are outside the DXF R12 slice.');
            }
            const a = toModel(primitive.a);
            const b = toModel(primitive.b);
            // Mirroring the SVG y axis flips the sweep direction.
            const ccw = !primitive.sweep;
            const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (primitive.largeArc && chord <= STUDIO_DXF_FULL_CIRCLE_CHORD_MM) {
              const { center } = arcCenterForm(a, b, primitive.rx, primitive.largeArc, ccw);
              collector.circle(layer, center, primitive.rx);
            } else {
              const { center, startDeg, endDeg } = arcCenterForm(a, b, primitive.rx, primitive.largeArc, ccw);
              if (ccw) collector.arc(layer, center, primitive.rx, startDeg, endDeg);
              else collector.arc(layer, center, primitive.rx, endDeg, startDeg);
            }
          } else if (splinePolicy === 'tessellate-v1') {
            collector.polyline(layer,
              sampleBezier(primitive, STUDIO_DXF_BEZIER_TESSELLATION_STEPS).map(toModel), false);
          } else {
            fail('DXF_UNSUPPORTED_CURVE', 'Exact projection contains Bezier spans; DXF R12 export fails closed unless the documented tessellate-v1 spline policy is requested.');
          }
        }
      }
    }
  }
  const comments = [
    STUDIO_DXF_SCHEMA + ' kind=drawing-sheet units=mm projection=third-angle splinePolicy=' + splinePolicy,
    ...STUDIO_DXF_SHEET_VIEWS.map((view) => 'view ' + view
      + ' layer=' + studioDrawingDxfLayerName(view, false)
      + ' offsetX=' + num(offsets[view][0])
      + ' offsetY=' + num(offsets[view][1])),
  ];
  return emitDxf(comments, collector, layerOrder);
}

// --- sketch profile export --------------------------------------------------

export const STUDIO_DXF_SKETCH_LAYER = 'PM-SKETCH';

export function createStudioSketchDxf(sketch, options = {}) {
  const splinePolicy = splinePolicyOf(options);
  if (!sketch || typeof sketch !== 'object' || !Array.isArray(sketch.entities)) {
    fail('DXF_SKETCH_INVALID', 'Sketch DXF requires one constraint-native sketch object.');
  }
  let solved;
  try {
    solved = solveSketch(sketch, {});
  } catch (error) {
    fail('DXF_SKETCH_UNSOLVED', 'Sketch DXF requires a valid sketch: ' + String(error?.message || error));
  }
  if (solved.status !== 'ok') {
    const first = (solved.diagnostics || [])[0];
    fail('DXF_SKETCH_UNSOLVED', 'Sketch DXF requires a solved sketch (' + String(first?.code || solved.status) + ').');
  }
  const byId = new Map((solved.entities || []).map((entity) => [entity.id, entity]));
  const at = (pointId) => {
    const point = byId.get(pointId);
    if (!point || point.kind !== 'point' || !Array.isArray(point.at)) {
      fail('DXF_SKETCH_INVALID', 'Sketch DXF entity references a missing solved point.');
    }
    return [Number(point.at[0]), Number(point.at[1])];
  };
  const collector = createCollector();
  const layer = STUDIO_DXF_SKETCH_LAYER;
  for (const entity of solved.entities || []) {
    if (entity.construction) continue;
    if (entity.kind === 'line') {
      collector.line(layer, at(entity.a), at(entity.b));
    } else if (entity.kind === 'circle') {
      const r = Number(entity.solvedR !== undefined ? entity.solvedR : entity.r);
      if (!Number.isFinite(r) || !(r > 0)) fail('DXF_SKETCH_INVALID', 'Sketch DXF circle "' + entity.id + '" has no solved positive radius.');
      collector.circle(layer, at(entity.center), r);
    } else if (entity.kind === 'arc') {
      const center = at(entity.center);
      const a = at(entity.a);
      const b = at(entity.b);
      const ra = Math.hypot(a[0] - center[0], a[1] - center[1]);
      const rb = Math.hypot(b[0] - center[0], b[1] - center[1]);
      if (!(ra > 0) || Math.abs(ra - rb) > 1e-6 * Math.max(1, ra)) {
        fail('DXF_SKETCH_INVALID', 'Sketch DXF arc "' + entity.id + '" endpoints are not equidistant from its center.');
      }
      const r = (ra + rb) / 2;
      const startDeg = Math.atan2(a[1] - center[1], a[0] - center[0]) * 180 / Math.PI;
      const endDeg = Math.atan2(b[1] - center[1], b[0] - center[0]) * 180 / Math.PI;
      const ccw = entity.ccw !== false;
      if (ccw) collector.arc(layer, center, r, startDeg, endDeg);
      else collector.arc(layer, center, r, endDeg, startDeg);
    } else if (entity.kind === 'spline') {
      if (splinePolicy !== 'tessellate-v1') {
        fail('DXF_UNSUPPORTED_CURVE', 'Sketch DXF fails closed on spline "' + entity.id + '" unless the documented tessellate-v1 spline policy is requested.');
      }
      const through = (entity.through || []).map(at);
      if (through.length < 2) fail('DXF_SKETCH_INVALID', 'Sketch DXF spline "' + entity.id + '" has too few through points.');
      const sampled = sampleSplineThrough(through, STUDIO_DXF_SPLINE_TESSELLATION_STEPS);
      const first = sampled[0];
      const last = sampled[sampled.length - 1];
      const closed = sampled.length > 2
        && Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-9;
      collector.polyline(layer, closed ? sampled.slice(0, -1) : sampled, closed);
    }
  }
  if (!collector.entities.length) fail('DXF_SKETCH_EMPTY', 'Sketch DXF found no exportable curve entities.');
  const comments = [STUDIO_DXF_SCHEMA + ' kind=sketch-profile units=mm splinePolicy=' + splinePolicy];
  return emitDxf(comments, collector, [{ name: layer, color: 7, linetype: 'CONTINUOUS' }]);
}

// --- DXF R12 sketch import --------------------------------------------------
//
// Bounded read half of partmode.dxf/v1: DXF R12 (AC1009) ASCII text in
// millimetres becomes one constraint-native sketch. The entity vocabulary is
// exactly LINE, ARC, CIRCLE, and straight LWPOLYLINE; coordinates land as
// authored sketch entities with no inferred constraints beyond coincident
// endpoints, which merge into one shared sketch point inside the documented
// exact tolerance. Everything else fails closed with a typed error.

export const STUDIO_DXF_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
export const STUDIO_DXF_IMPORT_MAX_ENTITIES = 5_000;
export const STUDIO_DXF_IMPORT_MAX_POLYLINE_VERTICES = 4_096;
export const STUDIO_DXF_IMPORT_COINCIDENCE_TOLERANCE_MM = 1e-4;
export const STUDIO_DXF_IMPORT_ENTITY_TYPES = Object.freeze(['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE']);

const IMPORT_NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu;
// Group codes every supported entity may carry without changing its bounded
// 2D millimetre meaning: handle, linetype, layer, and color.
const IMPORT_IGNORED_ENTITY_CODES = new Set([5, 6, 8, 62]);

function importNumber(raw, label) {
  const token = String(raw).trim();
  if (!IMPORT_NUMBER_PATTERN.test(token)) {
    fail('DXF_IMPORT_INVALID', 'DXF import found a malformed number for ' + label + '.');
  }
  const value = Number(token);
  if (!Number.isFinite(value) || Math.abs(value) > 1e9) {
    fail('DXF_IMPORT_INVALID', 'DXF import found a non-finite or out-of-range number for ' + label + '.');
  }
  return value;
}

function importGroupPairs(text) {
  const lines = text.split(/\r\n|[\n\r]/u);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length % 2 !== 0) {
    fail('DXF_IMPORT_INVALID', 'DXF import found a truncated group-code pair.');
  }
  const pairs = [];
  for (let index = 0; index < lines.length; index += 2) {
    const codeToken = lines[index].trim();
    if (!/^\d{1,4}$/u.test(codeToken)) {
      fail('DXF_IMPORT_INVALID', 'DXF import found a malformed group code "' + codeToken.slice(0, 16) + '".');
    }
    const code = Number(codeToken);
    if (!Number.isInteger(code) || code > 1071) {
      fail('DXF_IMPORT_INVALID', 'DXF import found a group code outside the DXF range.');
    }
    pairs.push([code, lines[index + 1]]);
  }
  return pairs;
}

// One flat scalar record for LINE, ARC, and CIRCLE. Repeated scalar codes and
// codes outside the documented R12 subset fail closed.
function importScalarRecord(entity, allowedCodes) {
  const values = new Map();
  for (const [code, raw] of entity.pairs) {
    if (IMPORT_IGNORED_ENTITY_CODES.has(code)) continue;
    if (!allowedCodes.has(code)) {
      fail('DXF_IMPORT_INVALID', 'DXF import found group code ' + code + ' outside the documented ' + entity.type + ' subset.');
    }
    if (values.has(code)) {
      fail('DXF_IMPORT_INVALID', 'DXF import found a repeated group code ' + code + ' on ' + entity.type + '.');
    }
    values.set(code, importNumber(raw, entity.type + ' group ' + code));
  }
  return values;
}

function requireImportValue(values, code, type) {
  if (!values.has(code)) {
    fail('DXF_IMPORT_INVALID', 'DXF import ' + type + ' is missing required group code ' + code + '.');
  }
  return values.get(code);
}

// The sketch import is strictly planar: any nonzero z, elevation, thickness,
// or tilted extrusion direction fails closed instead of being flattened.
function assertPlanarImportRecord(values, type) {
  for (const [code, expected] of [[30, 0], [31, 0], [38, 0], [39, 0], [210, 0], [220, 0], [230, 1]]) {
    if (values.has(code) && Math.abs(values.get(code) - expected) > 1e-9) {
      fail('DXF_IMPORT_INVALID', 'DXF import ' + type + ' is not in the millimetre sketch plane (group ' + code + ').');
    }
  }
}

function createImportSketchBuilder() {
  const entities = [];
  const endpointRegistry = [];
  let pointCount = 0;
  let curveCount = 0;
  let mergedEndpoints = 0;
  const freshPoint = (at) => {
    const id = 'dxf-p' + (++pointCount);
    entities.push({ id, kind: 'point', at: [at[0], at[1]] });
    return id;
  };
  // Coincident curve endpoints inside the exact tolerance merge into one
  // shared sketch point; this is the only inferred relationship.
  const endpoint = (at) => {
    for (const candidate of endpointRegistry) {
      if (Math.hypot(candidate.at[0] - at[0], candidate.at[1] - at[1]) <= STUDIO_DXF_IMPORT_COINCIDENCE_TOLERANCE_MM) {
        mergedEndpoints += 1;
        return candidate.id;
      }
    }
    const id = freshPoint(at);
    endpointRegistry.push({ id, at: [at[0], at[1]] });
    return id;
  };
  return {
    entities,
    line(a, b, sourceType) {
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= STUDIO_DXF_IMPORT_COINCIDENCE_TOLERANCE_MM) {
        fail('DXF_IMPORT_INVALID', 'DXF import found a degenerate ' + sourceType + ' segment inside the coincidence tolerance.');
      }
      const aId = endpoint(a);
      const bId = endpoint(b);
      if (aId === bId) {
        fail('DXF_IMPORT_INVALID', 'DXF import found a degenerate ' + sourceType + ' segment inside the coincidence tolerance.');
      }
      entities.push({ id: 'dxf-l' + (++curveCount), kind: 'line', a: aId, b: bId });
    },
    circle(center, r) {
      entities.push({ id: 'dxf-c' + (++curveCount), kind: 'circle', center: freshPoint(center), r });
    },
    arc(center, r, startDeg, endDeg) {
      const start = normalizeAngle(startDeg);
      const end = normalizeAngle(endDeg);
      const point = (deg) => [
        center[0] + r * Math.cos(deg * Math.PI / 180),
        center[1] + r * Math.sin(deg * Math.PI / 180),
      ];
      const a = point(start);
      const b = point(end);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= STUDIO_DXF_IMPORT_COINCIDENCE_TOLERANCE_MM) {
        fail('DXF_IMPORT_INVALID', 'DXF import found a degenerate ARC; a closed circular edge must be a CIRCLE entity.');
      }
      const aId = endpoint(a);
      const bId = endpoint(b);
      if (aId === bId) {
        fail('DXF_IMPORT_INVALID', 'DXF import found a degenerate ARC inside the coincidence tolerance.');
      }
      // DXF arcs run counterclockwise from start to end; the sketch arc
      // entity defaults to counterclockwise, so authored direction survives.
      entities.push({ id: 'dxf-a' + (++curveCount), kind: 'arc', center: freshPoint(center), a: aId, b: bId });
    },
    stats: () => ({
      sketchPoints: pointCount,
      sketchCurves: curveCount,
      mergedEndpoints,
    }),
  };
}

function importLwpolyline(entity, builder) {
  let declaredVertices = null;
  let closed = false;
  const vertices = [];
  let pendingX = null;
  const flushVertex = () => {
    if (pendingX !== null) {
      fail('DXF_IMPORT_INVALID', 'DXF import LWPOLYLINE vertex is missing its Y coordinate.');
    }
  };
  const seenScalar = new Set();
  for (const [code, raw] of entity.pairs) {
    if (IMPORT_IGNORED_ENTITY_CODES.has(code)) continue;
    if (code === 10) {
      flushVertex();
      pendingX = importNumber(raw, 'LWPOLYLINE vertex X');
      if (vertices.length >= STUDIO_DXF_IMPORT_MAX_POLYLINE_VERTICES) {
        fail('DXF_IMPORT_LIMIT_EXCEEDED', 'DXF import LWPOLYLINE exceeds the bounded limit of ' + STUDIO_DXF_IMPORT_MAX_POLYLINE_VERTICES + ' vertices.');
      }
      continue;
    }
    if (code === 20) {
      if (pendingX === null) {
        fail('DXF_IMPORT_INVALID', 'DXF import LWPOLYLINE vertex Y arrived before its X coordinate.');
      }
      vertices.push([pendingX, importNumber(raw, 'LWPOLYLINE vertex Y')]);
      pendingX = null;
      continue;
    }
    if (code === 42) {
      if (Math.abs(importNumber(raw, 'LWPOLYLINE bulge')) > 1e-12) {
        fail('DXF_IMPORT_UNSUPPORTED_CURVE', 'DXF import fails closed on LWPOLYLINE bulge arcs; author them as ARC entities.');
      }
      continue;
    }
    if (![90, 70, 38, 39, 43, 210, 220, 230].includes(code)) {
      fail('DXF_IMPORT_INVALID', 'DXF import found group code ' + code + ' outside the documented LWPOLYLINE subset.');
    }
    if (seenScalar.has(code)) {
      fail('DXF_IMPORT_INVALID', 'DXF import found a repeated group code ' + code + ' on LWPOLYLINE.');
    }
    seenScalar.add(code);
    const value = importNumber(raw, 'LWPOLYLINE group ' + code);
    if (code === 90) {
      if (!Number.isInteger(value) || value < 2 || value > STUDIO_DXF_IMPORT_MAX_POLYLINE_VERTICES) {
        fail('DXF_IMPORT_LIMIT_EXCEEDED', 'DXF import LWPOLYLINE vertex count is outside the bounded 2..' + STUDIO_DXF_IMPORT_MAX_POLYLINE_VERTICES + ' range.');
      }
      declaredVertices = value;
    } else if (code === 70) {
      if (value !== 0 && value !== 1) {
        fail('DXF_IMPORT_INVALID', 'DXF import LWPOLYLINE flags outside the documented open/closed subset.');
      }
      closed = value === 1;
    } else if (code === 43) {
      if (Math.abs(value) > 1e-12) {
        fail('DXF_IMPORT_INVALID', 'DXF import LWPOLYLINE constant width is outside the sketch-profile subset.');
      }
    } else if ((code === 38 || code === 39 || code === 210 || code === 220) && Math.abs(value) > 1e-9) {
      fail('DXF_IMPORT_INVALID', 'DXF import LWPOLYLINE is not in the millimetre sketch plane (group ' + code + ').');
    } else if (code === 230 && Math.abs(value - 1) > 1e-9) {
      fail('DXF_IMPORT_INVALID', 'DXF import LWPOLYLINE is not in the millimetre sketch plane (group 230).');
    }
  }
  flushVertex();
  if (declaredVertices === null || vertices.length !== declaredVertices) {
    fail('DXF_IMPORT_INVALID', 'DXF import LWPOLYLINE vertex count does not match its declared group 90 count.');
  }
  for (let index = 1; index < vertices.length; index++) {
    builder.line(vertices[index - 1], vertices[index], 'LWPOLYLINE');
  }
  if (closed) builder.line(vertices[vertices.length - 1], vertices[0], 'LWPOLYLINE');
}

export function importStudioSketchDxf(text) {
  if (typeof text !== 'string' || !text.trim().length) {
    fail('DXF_IMPORT_INVALID', 'DXF import requires non-empty DXF R12 ASCII text.');
  }
  if (text.length > STUDIO_DXF_IMPORT_MAX_BYTES) {
    fail('DXF_IMPORT_LIMIT_EXCEEDED', 'DXF import exceeds the bounded input size of ' + STUDIO_DXF_IMPORT_MAX_BYTES + ' bytes.');
  }
  if (text.startsWith('AutoCAD Binary DXF') || text.includes('\u0000')) {
    fail('DXF_IMPORT_UNSUPPORTED_VERSION', 'Binary DXF and DWG are outside this slice; DXF import reads R12 (AC1009) ASCII only.');
  }
  const pairs = importGroupPairs(text);
  let acadVersion = null;
  let insunits = null;
  const rawEntities = [];
  let sawEof = false;
  let index = 0;
  const nextPair = (context) => {
    if (index >= pairs.length) {
      fail('DXF_IMPORT_INVALID', 'DXF import ended unexpectedly inside ' + context + '.');
    }
    return pairs[index++];
  };
  while (index < pairs.length) {
    const [code, value] = pairs[index++];
    if (code === 999) continue;
    if (code === 0 && value === 'EOF') { sawEof = true; break; }
    if (code !== 0 || value !== 'SECTION') {
      fail('DXF_IMPORT_INVALID', 'DXF import expected a SECTION record at the file level.');
    }
    const [nameCode, sectionName] = nextPair('a SECTION header');
    if (nameCode !== 2) {
      fail('DXF_IMPORT_INVALID', 'DXF import SECTION is missing its group 2 name.');
    }
    if (sectionName === 'HEADER') {
      let headerVariable = null;
      for (;;) {
        const [headerCode, headerValue] = nextPair('the HEADER section');
        if (headerCode === 0 && headerValue === 'ENDSEC') break;
        if (headerCode === 0) {
          fail('DXF_IMPORT_INVALID', 'DXF import HEADER contains an unexpected record "' + String(headerValue).slice(0, 16) + '".');
        }
        if (headerCode === 999) continue;
        if (headerCode === 9) { headerVariable = headerValue; continue; }
        if (headerVariable === '$ACADVER' && headerCode === 1) acadVersion = headerValue.trim();
        else if (headerVariable === '$INSUNITS' && headerCode === 70) {
          insunits = importNumber(headerValue, '$INSUNITS');
        }
      }
    } else if (sectionName === 'ENTITIES') {
      let current = null;
      const flush = () => { if (current) rawEntities.push(current); current = null; };
      for (;;) {
        const [entityCode, entityValue] = nextPair('the ENTITIES section');
        if (entityCode === 0 && entityValue === 'ENDSEC') { flush(); break; }
        if (entityCode === 0) {
          flush();
          if (!STUDIO_DXF_IMPORT_ENTITY_TYPES.includes(entityValue)) {
            fail('DXF_IMPORT_UNSUPPORTED_ENTITY', 'DXF import fails closed on entity "' + String(entityValue).slice(0, 24)
              + '"; the bounded vocabulary is ' + STUDIO_DXF_IMPORT_ENTITY_TYPES.join(', ') + '.');
          }
          if (rawEntities.length >= STUDIO_DXF_IMPORT_MAX_ENTITIES) {
            fail('DXF_IMPORT_LIMIT_EXCEEDED', 'DXF import exceeds the bounded limit of ' + STUDIO_DXF_IMPORT_MAX_ENTITIES + ' entities.');
          }
          current = { type: entityValue, pairs: [] };
          continue;
        }
        if (entityCode === 999) continue;
        if (!current) {
          fail('DXF_IMPORT_INVALID', 'DXF import found entity data before an entity record.');
        }
        current.pairs.push([entityCode, entityValue]);
      }
    } else {
      // TABLES, BLOCKS, and other declarative sections carry no sketch
      // geometry in this slice; skip them structurally to the ENDSEC.
      for (;;) {
        const [skipCode, skipValue] = nextPair('the ' + String(sectionName).slice(0, 16) + ' section');
        if (skipCode === 0 && skipValue === 'ENDSEC') break;
      }
    }
  }
  if (!sawEof) fail('DXF_IMPORT_INVALID', 'DXF import is missing its EOF record.');
  while (index < pairs.length) {
    const [code] = pairs[index++];
    if (code !== 999) fail('DXF_IMPORT_INVALID', 'DXF import found content after EOF.');
  }
  if (acadVersion !== null && acadVersion !== STUDIO_DXF_VERSION) {
    fail('DXF_IMPORT_UNSUPPORTED_VERSION', 'DXF import reads R12 (' + STUDIO_DXF_VERSION + ') only; "' + acadVersion.slice(0, 16) + '" fails closed.');
  }
  if (insunits !== null && insunits !== 4) {
    fail('DXF_IMPORT_UNSUPPORTED_UNITS', 'DXF import reads millimetre files only; $INSUNITS ' + insunits + ' fails closed.');
  }
  const builder = createImportSketchBuilder();
  const counts = { line: 0, arc: 0, circle: 0, polyline: 0 };
  for (const entity of rawEntities) {
    if (entity.type === 'LINE') {
      const values = importScalarRecord(entity, new Set([10, 20, 30, 11, 21, 31, 39, 210, 220, 230]));
      assertPlanarImportRecord(values, 'LINE');
      builder.line(
        [requireImportValue(values, 10, 'LINE'), requireImportValue(values, 20, 'LINE')],
        [requireImportValue(values, 11, 'LINE'), requireImportValue(values, 21, 'LINE')],
        'LINE',
      );
      counts.line += 1;
    } else if (entity.type === 'CIRCLE') {
      const values = importScalarRecord(entity, new Set([10, 20, 30, 40, 39, 210, 220, 230]));
      assertPlanarImportRecord(values, 'CIRCLE');
      const r = requireImportValue(values, 40, 'CIRCLE');
      if (!(r > 0)) fail('DXF_IMPORT_INVALID', 'DXF import CIRCLE radius must be positive.');
      builder.circle([requireImportValue(values, 10, 'CIRCLE'), requireImportValue(values, 20, 'CIRCLE')], r);
      counts.circle += 1;
    } else if (entity.type === 'ARC') {
      const values = importScalarRecord(entity, new Set([10, 20, 30, 40, 50, 51, 39, 210, 220, 230]));
      assertPlanarImportRecord(values, 'ARC');
      const r = requireImportValue(values, 40, 'ARC');
      if (!(r > 0)) fail('DXF_IMPORT_INVALID', 'DXF import ARC radius must be positive.');
      builder.arc(
        [requireImportValue(values, 10, 'ARC'), requireImportValue(values, 20, 'ARC')],
        r,
        requireImportValue(values, 50, 'ARC'),
        requireImportValue(values, 51, 'ARC'),
      );
      counts.arc += 1;
    } else {
      importLwpolyline(entity, builder);
      counts.polyline += 1;
    }
  }
  if (!builder.stats().sketchCurves) {
    fail('DXF_IMPORT_EMPTY', 'DXF import found no drawable LINE, ARC, CIRCLE, or LWPOLYLINE entities.');
  }
  const constrained = {
    entities: builder.entities,
    constraints: [],
    blockInstances: [],
    relations: [],
  };
  // The importer authors coordinates directly; the production solver must
  // accept them and settle within the documented coincidence tolerance of the
  // authored geometry, otherwise the import fails closed instead of
  // publishing drifted geometry.
  let solved;
  try {
    solved = solveSketch({ entities: constrained.entities, constraints: [] }, {});
  } catch (error) {
    fail('DXF_IMPORT_UNSOLVED', 'DXF import produced a sketch the production solver rejects: ' + String(error?.message || error));
  }
  if (solved.status !== 'ok') {
    const first = (solved.diagnostics || [])[0];
    fail('DXF_IMPORT_UNSOLVED', 'DXF import produced an unsolved sketch (' + String(first?.code || solved.status) + ').');
  }
  const authoredById = new Map(constrained.entities
    .filter((entity) => entity.kind === 'point')
    .map((entity) => [entity.id, entity.at]));
  for (const entity of solved.entities || []) {
    if (entity.kind !== 'point') continue;
    const authored = authoredById.get(entity.id);
    if (!authored
      || Math.hypot(entity.at[0] - authored[0], entity.at[1] - authored[1]) > STUDIO_DXF_IMPORT_COINCIDENCE_TOLERANCE_MM) {
      fail('DXF_IMPORT_UNSOLVED', 'DXF import settlement moved point "' + entity.id + '" outside the documented coincidence tolerance.');
    }
  }
  return {
    schema: STUDIO_DXF_SCHEMA,
    kind: 'sketch-import',
    units: 'mm',
    acadVersion,
    constrained,
    stats: { dxfEntities: counts, ...builder.stats() },
  };
}
