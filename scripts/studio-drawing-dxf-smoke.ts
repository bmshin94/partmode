// Focused acceptance gate for the source-owned partmode.dxf/v1 writer and
// the bounded R12 sketch importer.
//
// The gate builds one exact OCCT HLR drawing result and one solved
// constraint-native sketch, exports both through the writer, then re-parses
// the emitted DXF with an independent minimal parser defined in this file and
// re-derives every endpoint coordinate against the exact source geometry.
// The import half round-trips the exported sketch DXF through the production
// importer back to byte-identical DXF, proves benchmark B4 step 4 (import a
// DXF profile, extrude it to a closed-form exact volume), covers the typed
// fail-closed import vocabulary, and uploads a real .dxf through the visible
// file input in headless Chrome. DWG and R13+ remain explicit exclusions.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type ElementHandle } from 'puppeteer';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Drawing DXF smoke failed: ${label}`);
}

function expectCode(label: string, fn: () => unknown, code: string): void {
  try { fn(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Drawing DXF smoke failed: ${label} did not fail`);
}

const near = (a: number, b: number, tolerance = 1.5e-6): boolean => Math.abs(a - b) <= tolerance;
const nearPoint = (a: number[], b: number[], tolerance = 1.5e-6): boolean =>
  near(a[0]!, b[0]!, tolerance) && near(a[1]!, b[1]!, tolerance);

// --- independent minimal DXF parser (this file only, not the writer) --------

interface DxfEntity {
  type: string;
  layer: string;
  groups: Array<[number, number]>;
  vertices: number[][];
}

interface DxfFile {
  comments: string[];
  header: Map<string, number[]>;
  acadVersion: string | null;
  layers: Array<{ name: string; color: number; linetype: string }>;
  entities: DxfEntity[];
}

function parseDxf(text: string): DxfFile {
  const rawLines = text.split('\n');
  check('DXF ends with one trailing newline', text.endsWith('\n') && rawLines[rawLines.length - 1] === '');
  const lines = rawLines.slice(0, -1);
  check('DXF pairs are complete', lines.length % 2 === 0);
  const pairs: Array<[number, string]> = [];
  for (let index = 0; index < lines.length; index += 2) {
    const code = Number(lines[index]);
    check(`group code "${lines[index]}" is an integer`, Number.isInteger(code));
    pairs.push([code, lines[index + 1]!]);
  }
  const file: DxfFile = { comments: [], header: new Map(), acadVersion: null, layers: [], entities: [] };
  let section: string | null = null;
  let table: string | null = null;
  let headerVariable: string | null = null;
  let entity: DxfEntity | null = null;
  let layer: { name: string; color: number; linetype: string } | null = null;
  const flushEntity = () => { if (entity) file.entities.push(entity); entity = null; };
  const flushLayer = () => { if (layer) file.layers.push(layer); layer = null; };
  for (const [code, value] of pairs) {
    if (code === 999) { file.comments.push(value); continue; }
    if (code === 0 && value === 'SECTION') { section = null; continue; }
    if (code === 2 && section === null) { section = value; continue; }
    if (code === 0 && value === 'ENDSEC') { flushEntity(); section = 'ended'; continue; }
    if (section === 'HEADER') {
      if (code === 9) { headerVariable = value; file.header.set(value, []); continue; }
      if (headerVariable === '$ACADVER' && code === 1) { file.acadVersion = value; continue; }
      if (headerVariable && [10, 20, 30].includes(code)) { file.header.get(headerVariable)!.push(Number(value)); continue; }
      continue;
    }
    if (section === 'TABLES') {
      if (code === 0 && value === 'TABLE') { flushLayer(); table = null; continue; }
      if (code === 2 && table === null) { table = value; continue; }
      if (code === 0 && value === 'ENDTAB') { flushLayer(); table = 'ended'; continue; }
      if (table === 'LAYER') {
        if (code === 0 && value === 'LAYER') { flushLayer(); layer = { name: '', color: 0, linetype: '' }; continue; }
        if (!layer) continue;
        if (code === 2) layer.name = value;
        else if (code === 62) layer.color = Number(value);
        else if (code === 6) layer.linetype = value;
      }
      continue;
    }
    if (section === 'ENTITIES') {
      if (code === 0) {
        flushEntity();
        check(`entity type ${value} is inside the bounded vocabulary`, ['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE'].includes(value));
        entity = { type: value, layer: '', groups: [], vertices: [] };
        continue;
      }
      if (!entity) continue;
      if (code === 8) entity.layer = value;
      else if (entity.type === 'LWPOLYLINE' && code === 10) entity.vertices.push([Number(value)]);
      else if (entity.type === 'LWPOLYLINE' && code === 20) entity.vertices[entity.vertices.length - 1]!.push(Number(value));
      else entity.groups.push([code, Number(value)]);
    }
  }
  flushEntity();
  return file;
}

function groupValue(entity: DxfEntity, code: number): number {
  const found = entity.groups.find(([entryCode]) => entryCode === code);
  check(`entity ${entity.type} carries group ${code}`, found !== undefined);
  return Number(found![1]);
}

function lineEndpoints(entity: DxfEntity): [number[], number[]] {
  return [
    [groupValue(entity, 10), groupValue(entity, 20)],
    [groupValue(entity, 11), groupValue(entity, 21)],
  ];
}

function arcEndpoints(entity: DxfEntity): { start: number[]; end: number[]; center: number[]; r: number } {
  const center = [groupValue(entity, 10), groupValue(entity, 20)];
  const r = groupValue(entity, 40);
  const startDeg = groupValue(entity, 50);
  const endDeg = groupValue(entity, 51);
  const point = (deg: number) => [
    center[0]! + r * Math.cos(deg * Math.PI / 180),
    center[1]! + r * Math.sin(deg * Math.PI / 180),
  ];
  return { start: point(startDeg), end: point(endDeg), center, r };
}

// --- independent exact-source reference model -------------------------------

// This reference implementation re-reads the exact HLR path text emitted by
// the production worker and re-derives the expected DXF coordinates from the
// documented contract: mirror the SVG y axis back to model y, then translate
// by the documented per-view third-angle offsets.
interface ReferencePrimitive {
  kind: 'line' | 'arc' | 'circle' | 'bezier';
  a: number[];
  b: number[];
  r?: number;
  ccw?: boolean;
  samples?: number[][];
}

function referencePathPrimitives(path: string, toModel: (point: number[]) => number[]): ReferencePrimitive[] {
  const tokens = path.trim().split(/[\s,]+/u);
  const out: ReferencePrimitive[] = [];
  let cursor = 0;
  let current: number[] | null = null;
  let start: number[] | null = null;
  const number = () => {
    const value = Number(tokens[cursor++]);
    check('reference path number is finite', Number.isFinite(value));
    return value;
  };
  while (cursor < tokens.length) {
    const command = tokens[cursor++];
    if (command === 'M') { current = [number(), number()]; start = current; continue; }
    check('reference path has a current point', current !== null);
    if (command === 'L') {
      const next = [number(), number()];
      out.push({ kind: 'line', a: toModel(current!), b: toModel(next) });
      current = next;
    } else if (command === 'A') {
      const rx = number(); const ry = number(); const rotation = number();
      const largeArc = number(); const sweep = number();
      const next = [number(), number()];
      check('reference arc is circular', Math.abs(rx - ry) <= 1e-9 * Math.max(1, rx) && rotation === 0);
      const a = toModel(current!);
      const b = toModel(next);
      const chord = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
      if (largeArc === 1 && chord <= 1e-3) out.push({ kind: 'circle', a, b, r: rx });
      else out.push({ kind: 'arc', a, b, r: rx, ccw: sweep === 0 });
      current = next;
    } else if (command === 'C' || command === 'Q') {
      const controls = command === 'C'
        ? [[number(), number()], [number(), number()]]
        : [[number(), number()]];
      const next = [number(), number()];
      const samples: number[][] = [];
      for (let step = 0; step <= 32; step++) {
        const t = step / 32;
        const u = 1 - t;
        if (command === 'Q') {
          samples.push(toModel([
            u * u * current![0]! + 2 * u * t * controls[0]![0]! + t * t * next[0]!,
            u * u * current![1]! + 2 * u * t * controls[0]![1]! + t * t * next[1]!,
          ]));
        } else {
          samples.push(toModel([
            u * u * u * current![0]! + 3 * u * u * t * controls[0]![0]! + 3 * u * t * t * controls[1]![0]! + t * t * t * next[0]!,
            u * u * u * current![1]! + 3 * u * u * t * controls[0]![1]! + 3 * u * t * t * controls[1]![1]! + t * t * t * next[1]!,
          ]));
        }
      }
      out.push({ kind: 'bezier', a: toModel(current!), b: toModel(next), samples });
      current = next;
    } else if (command === 'Z') {
      if (start && current && Math.hypot(start[0]! - current[0]!, start[1]! - current[1]!) > 1e-9) {
        out.push({ kind: 'line', a: toModel(current), b: toModel(start) });
      }
      current = start;
    } else {
      throw new Error(`Drawing DXF smoke failed: reference parser hit unsupported command "${command}"`);
    }
  }
  return out.filter((primitive) => primitive.kind !== 'line'
    || Math.hypot(primitive.b[0]! - primitive.a[0]!, primitive.b[1]! - primitive.a[1]!) > 1e-9);
}

// --- fixtures ---------------------------------------------------------------

const root = process.cwd();
const dxfTools = await import(pathToFileURL(resolve(root, 'src/static/studio-drawing-dxf.js')).href);
const solverTools = await import(pathToFileURL(resolve(root, 'src/static/studio-sketch-solver.js')).href);
const agentServiceTools = await import(pathToFileURL(resolve(root, 'src/static/studio-agent-service.js')).href);
const runtimeDocumentTools = await import(pathToFileURL(resolve(root, 'src/static/studio-v5-runtime-document.js')).href);
const source = JSON.parse(await readFile(resolve(root, 'tests/fixtures/three-body.json'), 'utf8')) as JsonRecord;
// Move the radius-5 tool cylinder onto the housing corner at model (20, 20):
// the boolean subtract then leaves an asymmetric quarter arc whose exact
// center is known source geometry, which pins DXF arc center-side selection.
const toolFeature = source.partDefinitions[0].features.find((entry: JsonRecord) => entry.id === 'feature-tool');
toolFeature.sketch.shapes[0].x = 20;
toolFeature.sketch.shapes[0].y = 20;

let kernel: HeadlessKernel | null = null;
let drawing: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  drawing = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-dxf-exact', projectId: source.projectId,
    revision: 1, document: source, views: ['front', 'top', 'right', 'iso'],
  }) as JsonRecord;
} finally { await kernel?.dispose(); }
check(`exact drawing failed ${JSON.stringify(drawing.errors || [])}`,
  drawing.kind === 'drawing-result' && drawing.errors?.length === 0
  && drawing.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');

// --- drawing sheet round-trip ----------------------------------------------

const first = dxfTools.createStudioDrawingDxf(drawing);
const second = dxfTools.createStudioDrawingDxf(drawing);
check('drawing DXF is not byte-deterministic', first === second);

const parsed = parseDxf(first);
check('drawing DXF is not AC1009', parsed.acadVersion === 'AC1009');
check('drawing DXF schema comment is wrong',
  parsed.comments[0] === 'partmode.dxf/v1 kind=drawing-sheet units=mm projection=third-angle splinePolicy=fail');

// The DXF sheet carries the orthographic views only; the pictorial iso view
// projects circles as ellipses and is an explicit exclusion of this slice.
const viewNames = ['front', 'top', 'right'] as const;
const viewByName = new Map<string, JsonRecord>(drawing.views.map((entry: JsonRecord) => [entry.view, entry]));
const modelBox = (viewBox: number[]) => ({
  minX: viewBox[0]!, minY: -viewBox[1]! - viewBox[3]!, maxX: viewBox[0]! + viewBox[2]!, maxY: -viewBox[1]!,
});
const boxes = Object.fromEntries(viewNames.map((view) => [view, modelBox(viewByName.get(view)!.viewBox)]));
const gap = 20;
const offsets: Record<string, number[]> = {
  front: [0, 0],
  top: [0, boxes.front!.maxY + gap - boxes.top!.minY],
  right: [boxes.front!.maxX + gap - boxes.right!.minX, 0],
};
check('iso view leaked into the DXF sheet', !parsed.layers.some((entry) => entry.name.startsWith('PM-ISO'))
  && !parsed.entities.some((entry) => entry.layer.startsWith('PM-ISO'))
  && !parsed.comments.some((entry) => entry.startsWith('view iso')));
for (const view of viewNames) {
  const comment = parsed.comments.find((entry) => entry.startsWith(`view ${view} `));
  check(`drawing DXF carries the documented ${view} offset comment`,
    comment === `view ${view} layer=PM-${view.toUpperCase()}`
      + ` offsetX=${String(Math.round(offsets[view]![0]! * 1e6) / 1e6)}`
      + ` offsetY=${String(Math.round(offsets[view]![1]! * 1e6) / 1e6)}`);
}

const expectedExtents = {
  minX: Math.min(...viewNames.map((view) => boxes[view]!.minX + offsets[view]![0]!)),
  minY: Math.min(...viewNames.map((view) => boxes[view]!.minY + offsets[view]![1]!)),
  maxX: Math.max(...viewNames.map((view) => boxes[view]!.maxX + offsets[view]![0]!)),
  maxY: Math.max(...viewNames.map((view) => boxes[view]!.maxY + offsets[view]![1]!)),
};
const extmin = parsed.header.get('$EXTMIN');
const extmax = parsed.header.get('$EXTMAX');
check('drawing DXF extents disagree with the exact view bounds',
  !!extmin && !!extmax
  && near(extmin[0]!, expectedExtents.minX) && near(extmin[1]!, expectedExtents.minY)
  && near(extmax[0]!, expectedExtents.maxX) && near(extmax[1]!, expectedExtents.maxY));

let roundTrippedEntities = 0;
let roundTrippedArcs = 0;
let roundTrippedCircles = 0;
for (const view of viewNames) {
  const entry = viewByName.get(view)!;
  const [offsetX, offsetY] = offsets[view]!;
  const toModel = (point: number[]) => [point[0]! + offsetX!, -point[1]! + offsetY!];
  for (const hidden of [false, true]) {
    const layerName = `PM-${view.toUpperCase()}${hidden ? '-HIDDEN' : ''}`;
    const expected = (hidden ? entry.hidden : entry.visible)
      .flatMap((path: string) => referencePathPrimitives(path, toModel));
    const actual = parsed.entities.filter((candidate) => candidate.layer === layerName);
    check(`layer ${layerName} entity count ${actual.length} != exact source count ${expected.length}`,
      actual.length === expected.length);
    for (let index = 0; index < expected.length; index++) {
      const want = expected[index]!;
      const got = actual[index]!;
      roundTrippedEntities += 1;
      if (want.kind === 'line') {
        check(`layer ${layerName} entity ${index} should be LINE`, got.type === 'LINE');
        const [a, b] = lineEndpoints(got);
        check(`layer ${layerName} LINE ${index} endpoints drifted from the exact source`,
          nearPoint(a, want.a) && nearPoint(b, want.b));
      } else if (want.kind === 'circle') {
        roundTrippedCircles += 1;
        check(`layer ${layerName} entity ${index} should be CIRCLE`, got.type === 'CIRCLE');
        const r = groupValue(got, 40);
        const center = [groupValue(got, 10), groupValue(got, 20)];
        check(`layer ${layerName} CIRCLE ${index} radius drifted`, near(r, want.r!));
        check(`layer ${layerName} CIRCLE ${index} does not pass through its exact source point`,
          near(Math.hypot(center[0]! - want.a[0]!, center[1]! - want.a[1]!), want.r!, 2e-4));
      } else if (want.kind === 'arc') {
        roundTrippedArcs += 1;
        check(`layer ${layerName} entity ${index} should be ARC`, got.type === 'ARC');
        const { start, end, center, r } = arcEndpoints(got);
        check(`layer ${layerName} ARC ${index} radius drifted`, near(r, want.r!, 1e-5));
        const [expectStart, expectEnd] = want.ccw ? [want.a, want.b] : [want.b, want.a];
        check(`layer ${layerName} ARC ${index} endpoints drifted from the exact source`,
          nearPoint(start, expectStart, 1e-4) && nearPoint(end, expectEnd, 1e-4));
        check(`layer ${layerName} ARC ${index} center is not equidistant from the source endpoints`,
          near(Math.hypot(center[0]! - want.a[0]!, center[1]! - want.a[1]!), r, 1e-5)
          && near(Math.hypot(center[0]! - want.b[0]!, center[1]! - want.b[1]!), r, 1e-5));
      } else {
        throw new Error('Drawing DXF smoke failed: default policy round-trip should never contain Bezier spans');
      }
    }
  }
}
check('round-trip inspected no entities', roundTrippedEntities > 20);

const withViewPath = (path: string): JsonRecord => ({
  ...drawing,
  views: drawing.views.map((entry: JsonRecord, index: number) => index
    ? entry
    : { ...entry, visible: [...entry.visible, path] }),
});

// Exact source-model anchors: the tool cylinder axis sits at model (20, 20)
// with radius 5, and its exact silhouette circle appears in the top-view path
// text with the literal diametral endpoints (15, 20) and (25, 20), so the
// projection-plane center is (20, 20) in path coordinates. The boolean
// quarter notch is concentric with it. Under the documented mapping
// (dxfX = pathX + offsetX, dxfY = -pathY + offsetY) every radius-5 arc in the
// unscaled top view must therefore sit on one shared DXF center (this pins
// millimetre 1:1 scale and endpoint-to-center side selection: a wrong side
// would drop the asymmetric quarter arc onto (15, 15) instead), and the
// quarter notch must round-trip its exact path endpoints (15, 20)-(20, 15).
const topArcs = parsed.entities.filter((entity) => entity.type === 'ARC' && entity.layer === 'PM-TOP'
  && near(groupValue(entity, 40), 5, 1e-5));
const topOffset = offsets.top!;
const mapTop = (point: number[]) => [point[0]! + topOffset[0]!, -point[1]! + topOffset[1]!];
const anchorCenter = mapTop([20, 20]);
check('top view path text lost the exact diametral cylinder silhouette',
  viewByName.get('top')!.visible.some((path: string) => path.includes('M 25 20 A 5 5 0 1 1 15 20'))
  && viewByName.get('top')!.visible.some((path: string) => path.includes('M 15 20 A 5 5 0 0 1 20 15')));
check('top view lost the radius-5 exact arcs', topArcs.length >= 3);
check('a radius-5 top arc left the exact source center (center-side selection is wrong)',
  topArcs.every((entity) => nearPoint([groupValue(entity, 10), groupValue(entity, 20)], anchorCenter, 1e-4)));
const notchEndpointsSeen = topArcs.some((entity) => {
  const { start, end } = arcEndpoints(entity);
  const wantA = mapTop([15, 20]);
  const wantB = mapTop([20, 15]);
  return (nearPoint(start, wantA, 1e-4) && nearPoint(end, wantB, 1e-4))
    || (nearPoint(start, wantB, 1e-4) && nearPoint(end, wantA, 1e-4));
});
check('top view lost the exact quarter-notch arc endpoints', notchEndpointsSeen);

// CIRCLE emission: the exact worker parameterizes a closed circular edge
// either as paired 180-degree arcs (covered above) or with a 1e-4 mm closure
// displacement; the displaced form must round-trip as a CIRCLE entity.
const circleDxf = dxfTools.createStudioDrawingDxf(withViewPath('M 5 0 A 5 5 0 1 1 5 0.0001'));
const circleParsed = parseDxf(circleDxf);
const syntheticCircle = circleParsed.entities.find((entity) => entity.type === 'CIRCLE');
check('closure-displaced full circle did not become a CIRCLE entity', syntheticCircle !== undefined
  && near(groupValue(syntheticCircle!, 40), 5, 1e-9)
  && near(Math.hypot(
    groupValue(syntheticCircle!, 10) - (5 + offsets.front![0]!),
    groupValue(syntheticCircle!, 20) - (0 + offsets.front![1]!),
  ), 5, 2e-4));

const layerTable = parsed.layers.map((entry) => `${entry.name}:${entry.color}:${entry.linetype}`);
check('hidden layers are not dashed and gray', viewNames.every((view) =>
  layerTable.includes(`PM-${view.toUpperCase()}:7:CONTINUOUS`))
  && parsed.layers.filter((entry) => entry.name.endsWith('-HIDDEN'))
    .every((entry) => entry.color === 8 && entry.linetype === 'DASHED'));

// --- drawing fail-closed and policy coverage --------------------------------

expectCode('missing exact evidence',
  () => dxfTools.createStudioDrawingDxf({ ...drawing, manifest: { ...drawing.manifest, exactProjectionEvidence: null } }),
  'DXF_EXACT_REQUIRED');
expectCode('missing standard view',
  () => dxfTools.createStudioDrawingDxf({ ...drawing, views: drawing.views.slice(0, 3) }), 'DXF_VIEW_SET_INVALID');
expectCode('duplicate standard view',
  () => dxfTools.createStudioDrawingDxf({ ...drawing, views: [...drawing.views.slice(0, 3), drawing.views[0]] }),
  'DXF_VIEW_SET_INVALID');
expectCode('invalid exact bounds',
  () => dxfTools.createStudioDrawingDxf({ ...drawing, views: drawing.views.map((entry: JsonRecord, index: number) => index ? entry : { ...entry, viewBox: [0, 0, Number.NaN, 10] }) }),
  'DXF_VIEW_SET_INVALID');
expectCode('empty exact visible paths',
  () => dxfTools.createStudioDrawingDxf({ ...drawing, views: drawing.views.map((entry: JsonRecord, index: number) => index ? entry : { ...entry, visible: [] }) }),
  'DXF_VIEW_SET_INVALID');
expectCode('Bezier span fails closed by default',
  () => dxfTools.createStudioDrawingDxf(withViewPath('M 0 0 C 1 2 3 4 5 6')), 'DXF_UNSUPPORTED_CURVE');
expectCode('elliptical arc fails closed even under the tessellation policy',
  () => dxfTools.createStudioDrawingDxf(withViewPath('M 0 0 A 5 3 0 0 1 5 3'), { splinePolicy: 'tessellate-v1' }),
  'DXF_UNSUPPORTED_CURVE');
expectCode('malformed path command fails closed',
  () => dxfTools.createStudioDrawingDxf(withViewPath('M 0 0 X 1 2')), 'DXF_PATH_INVALID');
expectCode('malformed path number fails closed',
  () => dxfTools.createStudioDrawingDxf(withViewPath('M 0 0 L 1 nope')), 'DXF_PATH_INVALID');
expectCode('unknown spline policy fails closed',
  () => dxfTools.createStudioDrawingDxf(drawing, { splinePolicy: 'approximate' }), 'DXF_SPLINE_POLICY_INVALID');
const oversized = 'M 0 0 ' + Array.from({ length: 20_001 }, (_, index) => `L ${index + 1} 0`).join(' ');
expectCode('bounded entity limit fails closed',
  () => dxfTools.createStudioDrawingDxf(withViewPath(oversized)), 'DXF_LIMIT_EXCEEDED');

const tessellated = dxfTools.createStudioDrawingDxf(withViewPath('M 0 0 C 1 2 3 4 5 6'), { splinePolicy: 'tessellate-v1' });
const tessellatedParsed = parseDxf(tessellated);
const polylines = tessellatedParsed.entities.filter((entity) => entity.type === 'LWPOLYLINE');
check('tessellation policy emits exactly one LWPOLYLINE for the injected Bezier', polylines.length === 1);
const frontOffset = offsets.front!;
const bezierReference = referencePathPrimitives('M 0 0 C 1 2 3 4 5 6',
  (point) => [point[0]! + frontOffset[0]!, -point[1]! + frontOffset[1]!])[0]!;
check('tessellated LWPOLYLINE vertex count is not 33', polylines[0]!.vertices.length === 33);
check('tessellated vertices drift from the independent Bezier evaluation',
  polylines[0]!.vertices.every((vertex, index) => nearPoint(vertex, bezierReference.samples![index]!)));
check('default-policy artifact and tessellated artifact differ only by the declared policy',
  tessellatedParsed.comments[0] === 'partmode.dxf/v1 kind=drawing-sheet units=mm projection=third-angle splinePolicy=tessellate-v1');

// --- sketch profile round-trip ----------------------------------------------

const point = (id: string, at: number[]): JsonRecord => ({ id, kind: 'point', at, fixed: true });
const sketch: JsonRecord = {
  entities: [
    point('p1', [0, 0]), point('p2', [40, 0]), point('p3', [40, 25]), point('p4', [0, 25]),
    { id: 'l1', kind: 'line', a: 'p1', b: 'p2' },
    { id: 'l2', kind: 'line', a: 'p2', b: 'p3' },
    { id: 'l3', kind: 'line', a: 'p3', b: 'p4' },
    { id: 'l4', kind: 'line', a: 'p4', b: 'p1' },
    point('pc', [20, 12.5]),
    { id: 'c1', kind: 'circle', center: 'pc', r: 6 },
    point('ac', [60, 10]), point('aa', [66, 10]), point('ab', [60, 16]),
    { id: 'a1', kind: 'arc', center: 'ac', a: 'aa', b: 'ab' },
    { id: 'a2', kind: 'arc', center: 'ac', a: 'aa', b: 'ab', ccw: false },
    point('cx1', [80, 0]), point('cx2', [90, 8]),
    { id: 'construction-line', kind: 'line', a: 'cx1', b: 'cx2', construction: true },
  ],
  constraints: [],
};
const sketchDxf = dxfTools.createStudioSketchDxf(sketch);
check('sketch DXF is not byte-deterministic', sketchDxf === dxfTools.createStudioSketchDxf(sketch));
const sketchParsed = parseDxf(sketchDxf);
check('sketch DXF is not AC1009', sketchParsed.acadVersion === 'AC1009');
check('sketch DXF schema comment is wrong',
  sketchParsed.comments[0] === 'partmode.dxf/v1 kind=sketch-profile units=mm splinePolicy=fail');
check('sketch DXF layer set is wrong',
  sketchParsed.layers.length === 1 && sketchParsed.layers[0]!.name === 'PM-SKETCH'
  && sketchParsed.entities.every((entity) => entity.layer === 'PM-SKETCH'));

const sketchLines = sketchParsed.entities.filter((entity) => entity.type === 'LINE');
const sketchCircles = sketchParsed.entities.filter((entity) => entity.type === 'CIRCLE');
const sketchArcs = sketchParsed.entities.filter((entity) => entity.type === 'ARC');
check('sketch DXF entity census is wrong (construction geometry must be excluded)',
  sketchLines.length === 4 && sketchCircles.length === 1 && sketchArcs.length === 2
  && sketchParsed.entities.length === 7);
const expectedSketchLines: Array<[number[], number[]]> = [
  [[0, 0], [40, 0]], [[40, 0], [40, 25]], [[40, 25], [0, 25]], [[0, 25], [0, 0]],
];
for (let index = 0; index < expectedSketchLines.length; index++) {
  const [a, b] = lineEndpoints(sketchLines[index]!);
  check(`sketch LINE ${index} endpoints drifted from the solved source geometry`,
    nearPoint(a, expectedSketchLines[index]![0]!) && nearPoint(b, expectedSketchLines[index]![1]!));
}
check('sketch CIRCLE drifted from the solved source geometry',
  nearPoint([groupValue(sketchCircles[0]!, 10), groupValue(sketchCircles[0]!, 20)], [20, 12.5])
  && near(groupValue(sketchCircles[0]!, 40), 6));
const ccwArc = arcEndpoints(sketchArcs[0]!);
check('ccw sketch ARC drifted from the solved source geometry',
  nearPoint(ccwArc.center, [60, 10]) && near(ccwArc.r, 6)
  && nearPoint(ccwArc.start, [66, 10]) && nearPoint(ccwArc.end, [60, 16])
  && near(groupValue(sketchArcs[0]!, 50), 0) && near(groupValue(sketchArcs[0]!, 51), 90));
const cwArc = arcEndpoints(sketchArcs[1]!);
check('cw sketch ARC drifted from the solved source geometry (DXF arcs stay counterclockwise)',
  nearPoint(cwArc.center, [60, 10]) && near(cwArc.r, 6)
  && nearPoint(cwArc.start, [60, 16]) && nearPoint(cwArc.end, [66, 10])
  && near(groupValue(sketchArcs[1]!, 50), 90) && near(groupValue(sketchArcs[1]!, 51), 0));
const sketchExtmin = sketchParsed.header.get('$EXTMIN');
const sketchExtmax = sketchParsed.header.get('$EXTMAX');
check('sketch DXF extents disagree with the solved geometry',
  !!sketchExtmin && !!sketchExtmax
  && nearPoint(sketchExtmin, [0, 0]) && nearPoint(sketchExtmax, [66, 25]));

// --- sketch spline policy and fail-closed coverage --------------------------

const splineSketch: JsonRecord = {
  entities: [
    point('s1', [0, 0]), point('s2', [10, 8]), point('s3', [24, 2]),
    { id: 'sp1', kind: 'spline', through: ['s1', 's2', 's3'] },
  ],
  constraints: [],
};
expectCode('sketch spline fails closed by default',
  () => dxfTools.createStudioSketchDxf(splineSketch), 'DXF_UNSUPPORTED_CURVE');
const splineDxf = dxfTools.createStudioSketchDxf(splineSketch, { splinePolicy: 'tessellate-v1' });
const splineParsed = parseDxf(splineDxf);
const splinePolylines = splineParsed.entities.filter((entity) => entity.type === 'LWPOLYLINE');
check('tessellated sketch spline is one open LWPOLYLINE', splinePolylines.length === 1
  && splineParsed.entities.length === 1);
const expectedSamples = solverTools.sampleSplineThrough([[0, 0], [10, 8], [24, 2]], 16) as number[][];
check('tessellated sketch spline vertex count is wrong', splinePolylines[0]!.vertices.length === expectedSamples.length
  && expectedSamples.length === 33);
check('tessellated sketch spline endpoints are not the exact through points',
  nearPoint(splinePolylines[0]!.vertices[0]!, [0, 0]) && nearPoint(splinePolylines[0]!.vertices[32]!, [24, 2]));
check('tessellated sketch spline drifts from the documented Catmull-Rom sampler',
  splinePolylines[0]!.vertices.every((vertex, index) => nearPoint(vertex, expectedSamples[index]!)));

expectCode('unsolved sketch fails closed', () => dxfTools.createStudioSketchDxf({
  entities: [point('u1', [0, 0]), point('u2', [10, 0])],
  constraints: [{ id: 'conflict', kind: 'coincident', a: 'u1', b: 'u2' }],
}), 'DXF_SKETCH_UNSOLVED');
// The solver's own arc-circularity residual rejects this before the writer's
// defensive equidistance check can run; either way it must fail closed.
expectCode('non-circular arc fails closed', () => dxfTools.createStudioSketchDxf({
  entities: [point('b1', [0, 0]), point('b2', [5, 0]), point('b3', [0, 6]),
    { id: 'bad-arc', kind: 'arc', center: 'b1', a: 'b2', b: 'b3' }],
  constraints: [],
}), 'DXF_SKETCH_UNSOLVED');
expectCode('point-only sketch fails closed', () => dxfTools.createStudioSketchDxf({
  entities: [point('only', [1, 2])],
  constraints: [],
}), 'DXF_SKETCH_EMPTY');
expectCode('non-sketch input fails closed', () => dxfTools.createStudioSketchDxf(null), 'DXF_SKETCH_INVALID');

// --- DXF R12 sketch import round-trip ---------------------------------------

const importedSketch = dxfTools.importStudioSketchDxf(sketchDxf);
check('sketch import is not deterministic',
  JSON.stringify(importedSketch) === JSON.stringify(dxfTools.importStudioSketchDxf(sketchDxf)));
check('sketch import identity is wrong',
  importedSketch.schema === 'partmode.dxf/v1' && importedSketch.kind === 'sketch-import'
  && importedSketch.units === 'mm' && importedSketch.acadVersion === 'AC1009');
check('sketch import census is wrong: ' + JSON.stringify(importedSketch.stats),
  JSON.stringify(importedSketch.stats) === JSON.stringify({
    dxfEntities: { line: 4, arc: 2, circle: 1, polyline: 0 },
    sketchPoints: 9,
    sketchCurves: 7,
    mergedEndpoints: 6,
  }));
check('sketch import inferred constraints beyond shared coincident endpoints',
  importedSketch.constrained.constraints.length === 0
  && importedSketch.constrained.blockInstances.length === 0
  && importedSketch.constrained.relations.length === 0);
const importedEntities = importedSketch.constrained.entities as JsonRecord[];
const importedLines = importedEntities.filter((entity) => entity.kind === 'line');
const importedCircles = importedEntities.filter((entity) => entity.kind === 'circle');
const importedArcs = importedEntities.filter((entity) => entity.kind === 'arc');
check('imported entity vocabulary census is wrong',
  importedLines.length === 4 && importedCircles.length === 1 && importedArcs.length === 2
  && importedEntities.filter((entity) => entity.kind === 'point').length === 9
  && importedEntities.length === 16);
// Coincident endpoints must land as shared sketch points, the only inferred
// relationship: the rectangle closes through four shared corners and the two
// opposite arcs share both endpoints while keeping independent center points.
check('rectangle corners did not merge into shared coincident points',
  importedLines[0]!.b === importedLines[1]!.a && importedLines[1]!.b === importedLines[2]!.a
  && importedLines[2]!.b === importedLines[3]!.a && importedLines[3]!.b === importedLines[0]!.a);
check('arc endpoints did not merge into shared coincident points',
  importedArcs[0]!.a === importedArcs[1]!.b && importedArcs[0]!.b === importedArcs[1]!.a);
check('arc centers must stay independent points (no inferred concentricity)',
  importedArcs[0]!.center !== importedArcs[1]!.center);

// The re-solved geometry must match the exact source coordinates.
const reSolved = solverTools.solveSketch({ entities: importedEntities, constraints: [] }, {});
check('imported sketch does not re-solve', reSolved.status === 'ok');
const reSolvedAt = new Map<string, number[]>((reSolved.entities as JsonRecord[])
  .filter((entity) => entity.kind === 'point')
  .map((entity) => [entity.id, entity.at]));
const exactPoint = (id: string, expected: number[], label: string): void => {
  const at = reSolvedAt.get(id);
  check(`${label} drifted from the exact source coordinate`, !!at && nearPoint(at, expected, 1e-9));
};
const expectedCorners: number[][] = [[0, 0], [40, 0], [40, 25], [0, 25]];
for (let index = 0; index < 4; index++) {
  exactPoint(importedLines[index]!.a, expectedCorners[index]!, `imported rectangle corner ${index}`);
}
exactPoint(importedCircles[0]!.center, [20, 12.5], 'imported circle center');
check('imported circle radius drifted', near(Number(importedCircles[0]!.r), 6, 1e-9));
exactPoint(importedArcs[0]!.center, [60, 10], 'imported ccw arc center');
exactPoint(importedArcs[0]!.a, [66, 10], 'imported ccw arc start');
exactPoint(importedArcs[0]!.b, [60, 16], 'imported ccw arc end');
exactPoint(importedArcs[1]!.a, [60, 16], 'imported normalized cw arc start');
exactPoint(importedArcs[1]!.b, [66, 10], 'imported normalized cw arc end');
// The strongest exactness proof: exporting the imported sketch reproduces the
// source DXF byte for byte.
check('import then re-export is not byte-identical to the source DXF',
  dxfTools.createStudioSketchDxf({ entities: importedEntities, constraints: [] }) === sketchDxf);

// Coincidence tolerance boundary: endpoints inside the documented exact
// tolerance merge, endpoints outside it stay independent.
const dxfFile = (pairs: Array<[number, string | number]>): string =>
  pairs.map(([code, value]) => `${code}\n${value}`).join('\n') + '\n';
const entitiesDxf = (entityPairs: Array<[number, string | number]>): string => dxfFile([
  [0, 'SECTION'], [2, 'ENTITIES'], ...entityPairs, [0, 'ENDSEC'], [0, 'EOF'],
]);
const linePairs = (x1: number, y1: number, x2: number, y2: number): Array<[number, string | number]> =>
  [[0, 'LINE'], [10, x1], [20, y1], [11, x2], [21, y2]];
const mergedProbe = dxfTools.importStudioSketchDxf(entitiesDxf([
  ...linePairs(0, 0, 10, 0), ...linePairs(10.00005, 0, 20, 0),
]));
check('endpoints inside the exact tolerance did not merge',
  mergedProbe.stats.mergedEndpoints === 1 && mergedProbe.stats.sketchPoints === 3);
const unmergedProbe = dxfTools.importStudioSketchDxf(entitiesDxf([
  ...linePairs(0, 0, 10, 0), ...linePairs(10.0002, 0, 20, 0),
]));
check('endpoints outside the exact tolerance merged',
  unmergedProbe.stats.mergedEndpoints === 0 && unmergedProbe.stats.sketchPoints === 4);

// --- import fail-closed coverage --------------------------------------------

expectCode('non-string import input fails closed',
  () => dxfTools.importStudioSketchDxf(null), 'DXF_IMPORT_INVALID');
expectCode('binary DXF sentinel fails closed',
  () => dxfTools.importStudioSketchDxf('AutoCAD Binary DXF\r\n '), 'DXF_IMPORT_UNSUPPORTED_VERSION');
expectCode('R13+ version fails closed',
  () => dxfTools.importStudioSketchDxf(sketchDxf.replace('AC1009', 'AC1012')), 'DXF_IMPORT_UNSUPPORTED_VERSION');
expectCode('non-millimetre units fail closed',
  () => dxfTools.importStudioSketchDxf(dxfFile([
    [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 1], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], ...linePairs(0, 0, 10, 0), [0, 'ENDSEC'], [0, 'EOF'],
  ])), 'DXF_IMPORT_UNSUPPORTED_UNITS');
expectCode('unsupported SPLINE entity fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf([[0, 'SPLINE'], [10, 0], [20, 0]])), 'DXF_IMPORT_UNSUPPORTED_ENTITY');
expectCode('legacy POLYLINE entity fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf([[0, 'POLYLINE'], [66, 1]])), 'DXF_IMPORT_UNSUPPORTED_ENTITY');
expectCode('malformed group code fails closed',
  () => dxfTools.importStudioSketchDxf('nope\nLINE\n0\nEOF\n'), 'DXF_IMPORT_INVALID');
expectCode('truncated group pair fails closed',
  () => dxfTools.importStudioSketchDxf(sketchDxf + '0\n'), 'DXF_IMPORT_INVALID');
expectCode('group code outside the documented LINE subset fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf([...linePairs(0, 0, 10, 0), [100, 'AcDbLine']])), 'DXF_IMPORT_INVALID');
expectCode('non-planar LINE fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf([...linePairs(0, 0, 10, 0), [30, 5]])), 'DXF_IMPORT_INVALID');
expectCode('tilted extrusion direction fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf([...linePairs(0, 0, 10, 0), [230, -1]])), 'DXF_IMPORT_INVALID');
expectCode('repeated group code fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf([...linePairs(0, 0, 10, 0), [11, 12]])), 'DXF_IMPORT_INVALID');
expectCode('non-positive CIRCLE radius fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf([[0, 'CIRCLE'], [10, 0], [20, 0], [40, 0]])), 'DXF_IMPORT_INVALID');
expectCode('LWPOLYLINE bulge arc fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf([
    [0, 'LWPOLYLINE'], [90, 2], [70, 0], [10, 0], [20, 0], [42, 0.5], [10, 10], [20, 0],
  ])), 'DXF_IMPORT_UNSUPPORTED_CURVE');
expectCode('LWPOLYLINE vertex-count mismatch fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf([
    [0, 'LWPOLYLINE'], [90, 3], [70, 0], [10, 0], [20, 0], [10, 10], [20, 0],
  ])), 'DXF_IMPORT_INVALID');
expectCode('LWPOLYLINE vertex bound fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf([
    [0, 'LWPOLYLINE'], [90, 5000], [70, 0], [10, 0], [20, 0],
  ])), 'DXF_IMPORT_LIMIT_EXCEEDED');
const oversizedImport: Array<[number, string | number]> = [];
for (let index = 0; index <= 5_000; index++) oversizedImport.push(...linePairs(index, 0, index + 0.5, 1));
expectCode('bounded import entity limit fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf(oversizedImport)), 'DXF_IMPORT_LIMIT_EXCEEDED');
expectCode('empty ENTITIES section fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf([])), 'DXF_IMPORT_EMPTY');
expectCode('content after EOF fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf(linePairs(0, 0, 10, 0)) + '0\nSECTION\n'), 'DXF_IMPORT_INVALID');
expectCode('missing EOF fails closed',
  () => dxfTools.importStudioSketchDxf(dxfFile([
    [0, 'SECTION'], [2, 'ENTITIES'], ...linePairs(0, 0, 10, 0), [0, 'ENDSEC'],
  ])), 'DXF_IMPORT_INVALID');
expectCode('degenerate LINE fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf(linePairs(5, 5, 5, 5))), 'DXF_IMPORT_INVALID');
expectCode('degenerate full-circle ARC fails closed',
  () => dxfTools.importStudioSketchDxf(entitiesDxf([
    [0, 'ARC'], [10, 0], [20, 0], [40, 5], [50, 0], [51, 360],
  ])), 'DXF_IMPORT_INVALID');

// --- benchmark B4 step 4: import a DXF profile and extrude it ---------------

// A foreign-authored CRLF R12 profile: one closed LWPOLYLINE rectangle plus a
// hole circle, declared in millimetres, with a skipped TABLES section.
const b4Dxf = ([
  [999, 'B4 supplier profile'],
  [0, 'SECTION'], [2, 'HEADER'],
  [9, '$ACADVER'], [1, 'AC1009'],
  [9, '$INSUNITS'], [70, 4],
  [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'TABLES'], [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'ENTITIES'],
  [0, 'LWPOLYLINE'], [8, '0'], [90, 4], [70, 1],
  [10, 0], [20, 0], [10, 40], [20, 0], [10, 40], [20, 25], [10, 0], [20, 25],
  [0, 'CIRCLE'], [8, '0'], [10, 20], [20, 12.5], [40, 6],
  [0, 'ENDSEC'],
  [0, 'EOF'],
] as Array<[number, string | number]>).map(([code, value]) => `${code}\r\n${value}`).join('\r\n') + '\r\n';

const b4Base = runtimeDocumentTools.createStudioV5RuntimePartProject({
  projectId: 'drawing-dxf-b4',
  name: 'B4 DXF import',
  units: 'mm',
  parameters: [],
  features: [],
});
const b4Applied = agentServiceTools.applyCadTransaction(b4Base, {
  transactionId: 'b4-dxf-import-extrude',
  label: 'Import DXF profile and extrude',
  expectedRevision: 0,
  atomic: true,
  operations: [
    { kind: 'sketch.importDxf', input: { id: 'b4-dxf-sketch', name: 'B4 supplier profile (DXF)', plane: 'XY', dxfText: b4Dxf } },
    { kind: 'feature.extrude', input: { id: 'feature-b4-extrude', name: 'B4 extrude', sketchId: 'b4-dxf-sketch', h: 10 } },
  ],
});
const b4Project = b4Applied.project as JsonRecord;
const b4Part = runtimeDocumentTools.studioV5RootPart(b4Project) as JsonRecord;
const b4Sketch = b4Part.sketches.find((entry: JsonRecord) => entry.id === 'b4-dxf-sketch');
check('B4 imported sketch is not a first-class constraint-native sketch',
  b4Sketch?.extensions?.studioRole === 'constrained-2d'
  && b4Sketch.constrained.entities.filter((entity: JsonRecord) => entity.kind === 'line').length === 4
  && b4Sketch.constrained.entities.filter((entity: JsonRecord) => entity.kind === 'circle').length === 1
  && b4Sketch.constrained.constraints.length === 0);
const b4Feature = b4Part.features.find((entry: JsonRecord) => entry.id === 'feature-b4-extrude');
check('B4 extrude is not linked to the imported sketch',
  b4Feature?.sketchId === 'b4-dxf-sketch' && b4Feature.h === 10);
const b4Expected = (40 * 25 - Math.PI * 36) * 10;
let b4Kernel: HeadlessKernel | null = null;
let b4Result: JsonRecord;
try {
  b4Kernel = await createHeadlessKernel();
  await b4Kernel.waitForKernel();
  b4Result = await b4Kernel.request({
    kind: 'rebuild',
    requestId: 'drawing-dxf-b4-extrude',
    projectId: b4Project.projectId,
    revision: 1,
    document: b4Project,
    includeExactBrep: true,
  }, 180_000) as JsonRecord;
} finally { await b4Kernel?.dispose(); }
check(`B4 rebuild failed ${JSON.stringify(b4Result.errors || [])}`,
  b4Result.kind === 'rebuild-result' && (b4Result.errors || []).length === 0 && b4Result.bodies?.length === 1);
const b4Body = b4Result.bodies[0] as JsonRecord;
check('B4 extrude is not one valid exact solid',
  b4Body.geometry?.valid === true && b4Body.geometry?.solidCount === 1 && !b4Body.error);
check(`B4 exact volume ${b4Body.geometry?.volume} differs from closed form ${b4Expected}`,
  Math.abs(Number(b4Body.geometry?.volume) - b4Expected) <= Math.max(1e-6, b4Expected * 1e-9));

// --- production wiring ------------------------------------------------------

const [studioSource, pageSource, buildSource, registrySource, mcpSource, relaySource] = await Promise.all([
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
  readFile(resolve(root, 'src/mcp.ts'), 'utf8'),
  readFile(resolve(root, 'src/relay-hub.ts'), 'utf8'),
]);
check('production drawing export does not use the source-owned DXF writer',
  studioSource.includes('drawingDxfTools.createStudioDrawingDxf(generated.response)')
  && studioSource.includes('drawingDxfTools.createStudioSketchDxf(feature.sketch.constrained)'));
check('visible DXF output entry is missing',
  pageSource.includes('id="bw-export-dxf"') && pageSource.includes('data-command-target="bw-export-dxf"'));
check('typed DXF export formats are not advertised',
  studioSource.includes("'drawing-dxf'") && studioSource.includes("'sketch-dxf'")
  && mcpSource.includes("'drawing-dxf', 'sketch-dxf'")
  && relaySource.includes("'drawing-dxf': 'artifact.export-drawing'")
  && relaySource.includes("'sketch-dxf': 'artifact.export-drawing'"));
check('DXF export control is not registered', registrySource.includes("control('export.drawing-dxf'"));
check('DXF writer is absent from the release assets', buildSource.includes("'studio-drawing-dxf.js'"));
check('visible file input does not accept .dxf', pageSource.includes('accept=".json,.step,.stp,.dxf"'));
check('visible open path does not route .dxf through the typed import operation',
  studioSource.includes("/\\.dxf$/i.test(file.name) ? 'dxf'")
  && studioSource.includes("kind: 'sketch.importDxf'"));
check('typed dxf import format is not wired',
  studioSource.includes("['project', 'step', 'dxf']")
  && studioSource.includes("=== 'dxf' ? 'project.edit' : 'project.replace'"));
check('sketch.importDxf operation is not advertised in the capability manifest',
  (agentServiceTools.cadCapabilityManifest().operations as JsonRecord[])
    .some((operation) => operation.kind === 'sketch.importDxf' && operation.state === 'available'));
check('project.open registry control does not mention the DXF import affordance',
  registrySource.includes("'Open project, STEP, or DXF profile'"));

// --- visible import path in real headless Chrome ----------------------------

interface VisibleImportEvidence {
  acceptedMessage: string;
  rejectedMessage: string;
  sketchEntityCount: number;
}

async function verifyVisibleDxfImport(): Promise<VisibleImportEvidence> {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-dxf-import-'));
  const goodPath = resolve(temporaryDirectory, 'b4-supplier-profile.dxf');
  const badPath = resolve(temporaryDirectory, 'unsupported-spline.dxf');
  writeFileSync(goodPath, b4Dxf);
  writeFileSync(badPath, entitiesDxf([[0, 'SPLINE'], [10, 0], [20, 0]]));
  let server: RunningPartModeServer | undefined;
  let browser: Browser | undefined;
  try {
    server = await startPartModeServer({
      distDir: resolve(root, 'dist'),
      host: '127.0.0.1',
      port: 0,
      stateDir: resolve(temporaryDirectory, 'state'),
    });
    browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 480_000,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    const response = await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    check(`visible Studio returned HTTP ${response?.status() ?? 0}`, response?.status() === 200);
    await page.waitForFunction(() => Boolean((window as any).__bwStudio), { timeout: 120_000 });
    await page.waitForFunction(() => {
      const studio = (window as any).__bwStudio;
      return studio?.documentRevision?.() === studio?.appliedRevision?.()
        && studio?.mode?.()?.kind !== 'rebuilding';
    }, { polling: 50, timeout: 180_000 });
    const input = await page.$('#bw-open-file') as ElementHandle<HTMLInputElement> | null;
    check('visible DXF file input is missing', input);
    await input!.uploadFile(goodPath);
    await page.waitForFunction(() => {
      const studio = (window as any).__bwStudio;
      if (!studio || studio.documentRevision() !== studio.appliedRevision()) return false;
      try {
        const project = JSON.parse(studio.docJson());
        const part = (project.partDefinitions || [])[0];
        const sketch = (part?.sketches || []).find((entry: any) => String(entry.id).startsWith('dxf-import-'));
        const message = document.querySelector('#bw-studio-msg')?.textContent || '';
        return Boolean(sketch)
          && sketch.extensions?.studioRole === 'constrained-2d'
          && /DXF R12 profile imported/.test(message);
      } catch {
        return false;
      }
    }, { polling: 50, timeout: 240_000 });
    const accepted = await page.evaluate(() => {
      const studio = (window as any).__bwStudio;
      const project = JSON.parse(studio.docJson());
      const sketch = (project.partDefinitions || [])[0].sketches
        .find((entry: any) => String(entry.id).startsWith('dxf-import-'));
      return {
        document: studio.docJson(),
        hash: studio.canonicalHash(),
        revision: studio.documentRevision(),
        undoDepth: studio.undoDepth(),
        sketchEntityCount: sketch.constrained.entities.length,
        constraintCount: sketch.constrained.constraints.length,
        lineCount: sketch.constrained.entities.filter((entry: any) => entry.kind === 'line').length,
        circleCount: sketch.constrained.entities.filter((entry: any) => entry.kind === 'circle').length,
        status: document.querySelector('#bw-studio-msg')?.textContent || '',
      };
    });
    check(`visible DXF import produced the wrong sketch census: ${JSON.stringify(accepted)}`,
      accepted.lineCount === 4 && accepted.circleCount === 1 && accepted.constraintCount === 0
      && accepted.sketchEntityCount === 10);
    await input!.uploadFile(badPath);
    await page.waitForFunction(() => {
      const message = document.querySelector('#bw-studio-msg')?.textContent || '';
      return /^Could not import DXF:/.test(message);
    }, { polling: 50, timeout: 240_000 });
    const afterRejected = await page.evaluate(() => {
      const studio = (window as any).__bwStudio;
      return {
        document: studio.docJson(),
        hash: studio.canonicalHash(),
        revision: studio.documentRevision(),
        undoDepth: studio.undoDepth(),
        status: document.querySelector('#bw-studio-msg')?.textContent || '',
      };
    });
    for (const key of ['document', 'hash', 'revision', 'undoDepth'] as const) {
      check(`rejected visible DXF upload changed ${key}`, afterRejected[key] === accepted[key]);
    }
    check(`visible DXF rejection does not carry the typed refusal: ${afterRejected.status}`,
      /DXF_IMPORT_UNSUPPORTED_ENTITY|bounded vocabulary/i.test(afterRejected.status));
    check(`visible DXF import page errors ${JSON.stringify(pageErrors)}`, pageErrors.length === 0);
    check(`visible DXF import console errors ${JSON.stringify(consoleErrors)}`, consoleErrors.length === 0);
    return {
      acceptedMessage: accepted.status,
      rejectedMessage: afterRejected.status,
      sketchEntityCount: accepted.sketchEntityCount,
    };
  } finally {
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const visibleImport = await verifyVisibleDxfImport();

console.log(JSON.stringify({
  schema: 'partmode.dxf/v1',
  dxfVersion: 'AC1009',
  units: 'mm',
  deterministic: true,
  drawing: {
    bytes: first.length,
    layers: layerTable,
    roundTrippedEntities,
    roundTrippedArcs,
    radiusFiveTopArcs: topArcs.length,
    exactAnchors: ['radius-5 top arcs on the shared exact cylinder center', 'asymmetric quarter-notch endpoints', 'closure-displaced CIRCLE'],
  },
  sketch: {
    bytes: sketchDxf.length,
    entities: { lines: 4, circles: 1, arcs: 2 },
    constructionExcluded: true,
    tessellatedSplineVertices: 33,
  },
  splinePolicies: ['fail', 'tessellate-v1'],
  import: {
    roundTrip: {
      byteIdenticalReExport: true,
      entities: { lines: 4, circles: 1, arcs: 2 },
      mergedEndpoints: 6,
      inferredConstraints: 0,
    },
    b4Step4: {
      profile: 'closed LWPOLYLINE rectangle plus hole CIRCLE, CRLF, foreign-authored',
      closedFormVolumeMm3: b4Expected,
      exactVolumeMm3: Number(b4Body.geometry?.volume),
    },
    visibleImport,
  },
  failClosed: [
    'missing-exact-evidence', 'missing-view', 'duplicate-view', 'invalid-bounds', 'empty-visible-paths',
    'default-bezier', 'elliptical-arc', 'malformed-command', 'malformed-number', 'unknown-spline-policy',
    'entity-limit', 'default-sketch-spline', 'unsolved-sketch', 'non-circular-arc', 'empty-sketch', 'non-sketch-input',
  ],
  importFailClosed: [
    'non-string-input', 'binary-sentinel', 'r13-version', 'non-millimetre-units', 'spline-entity',
    'legacy-polyline-entity', 'malformed-group-code', 'truncated-pair', 'out-of-subset-group-code',
    'non-planar-line', 'tilted-extrusion', 'repeated-group-code', 'non-positive-circle-radius',
    'polyline-bulge', 'polyline-vertex-mismatch', 'polyline-vertex-bound', 'entity-limit',
    'empty-entities', 'content-after-eof', 'missing-eof', 'degenerate-line', 'degenerate-arc',
  ],
  exclusions: ['dwg', 'r13-plus', 'iso-view', 'elliptical-arcs', 'bulge-arcs', 'blocks-and-inserts',
    'non-millimetre-units', 'persisted-standards-sheets'],
}, null, 2));
