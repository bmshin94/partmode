import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const threads = await moduleAt('src/static/studio-thread.js');
const projectModule = await moduleAt('src/static/studio-project-v5.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const agent = await moduleAt('src/static/studio-agent-service.js');

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const closeTo = (left: number, right: number, tolerance = 2e-7): boolean =>
  Math.abs(left - right) <= tolerance;
const vectorDot = (left: number[], right: number[]): number =>
  left.reduce((sum, value, index) => sum + value * right[index]!, 0);
const vectorCross = (left: number[], right: number[]): number[] => [
  left[1]! * right[2]! - left[2]! * right[1]!,
  left[2]! * right[0]! - left[0]! * right[2]!,
  left[0]! * right[1]! - left[1]! * right[0]!,
];
const vectorLength = (value: number[]): number => Math.hypot(...value);
const helixPoint = (
  axisPoint: number[],
  axisDirection: number[],
  radialDirection: number[],
  radius: number,
  station: number,
  angle: number,
): number[] => {
  const binormal = vectorCross(axisDirection, radialDirection);
  return axisPoint.map((coordinate, index) => coordinate
    + axisDirection[index]! * station
    + radius * (radialDirection[index]! * Math.cos(angle) + binormal[index]! * Math.sin(angle)));
};

let independentRcPromise: Promise<any> | null = null;

async function independentReplicad(): Promise<any> {
  if (independentRcPromise) return independentRcPromise;
  independentRcPromise = (async () => {
    const vendorDirectory = resolve(root, 'src/static/vendor');
    const nodeGlobals = globalThis as typeof globalThis & {
      require: ReturnType<typeof createRequire>;
      __dirname: string;
    };
    nodeGlobals.require = createRequire(import.meta.url);
    nodeGlobals.__dirname = vendorDirectory;
    const rc = await import(pathToFileURL(resolve(vendorDirectory, 'replicad.module.js')).href) as any;
    const ocFactory = await import(pathToFileURL(resolve(vendorDirectory, 'replicad-oc.module.js')).href) as any;
    const oc = await ocFactory.default({ locateFile: () => resolve(vendorDirectory, 'replicad_single.wasm') });
    rc.setOC(oc);
    return rc;
  })();
  return independentRcPromise;
}

type AxisFrame = {
  origin: number[];
  axis: number[];
  radial: number[];
  binormal: number[];
};

type ExactSample = {
  point: number[];
  station: number;
  signedRadial: number;
  radius: number;
  angle: number;
};

type ExactEdgeTrace = {
  index: number;
  type: string;
  length: number;
  samples: ExactSample[];
  stationMin: number;
  stationMax: number;
  stationSpan: number;
  radiusMin: number;
  radiusMax: number;
  radialRange: number;
  angleDelta: number;
  turns: number;
  thetaPerStation: number | null;
  pitchMm: number | null;
};

const independentM6External = (() => {
  const pitchMm = 1;
  const nominalMajorDiameterMm = 6;
  const fundamentalTriangleHeightMm = Math.sqrt(3) * pitchMm / 2;
  // Independent ISO-position-g arithmetic for this bounded M6 acceptance
  // fixture; no authored Thread definition or worker evidence is read here.
  const allowanceMm = (15 + 11 * pitchMm) / 1000;
  const majorRadiusMm = (nominalMajorDiameterMm - allowanceMm) / 2;
  const minorRadiusMm = (
    nominalMajorDiameterMm - 17 * fundamentalTriangleHeightMm / 12 - allowanceMm
  ) / 2;
  const roundedRootRadiusMm = fundamentalTriangleHeightMm / 6;
  return {
    pitchMm,
    nominalRadiusMm: nominalMajorDiameterMm / 2,
    majorRadiusMm,
    minorRadiusMm,
    roundedRootRadiusMm,
    rootTangentRadiusMm: minorRadiusMm + roundedRootRadiusMm / 2,
    radialDepthMm: majorRadiusMm - minorRadiusMm,
  };
})();

function exactAxisFrame(
  axisDirection: number[],
  origin: number[] = [0, 0, 0],
): AxisFrame {
  const axis = axisDirection.map((entry) => entry / vectorLength(axisDirection));
  const candidate = Math.abs(axis[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const projection = vectorDot(candidate, axis);
  const radial = candidate.map((entry, index) => entry - projection * axis[index]!);
  const radialDirection = radial.map((entry) => entry / vectorLength(radial));
  return {
    origin: [...origin],
    axis,
    radial: radialDirection,
    binormal: vectorCross(axis, radialDirection),
  };
}

function exactSample(frame: AxisFrame, point: number[]): ExactSample {
  const relative = point.map((entry, index) => entry - frame.origin[index]!);
  const station = vectorDot(relative, frame.axis);
  const signedRadial = vectorDot(relative, frame.radial);
  const binormal = vectorDot(relative, frame.binormal);
  return {
    point,
    station,
    signedRadial,
    radius: Math.hypot(signedRadial, binormal),
    angle: Math.atan2(binormal, signedRadial),
  };
}

function exactEdgeTraces(shape: any, frame: AxisFrame, sampleCount = 257): ExactEdgeTrace[] {
  return shape.edges.map((edge: any, index: number) => {
    try {
      const samples = Array.from({ length: sampleCount }, (_, sampleIndex) => {
        const point = edge.pointAt(sampleIndex / (sampleCount - 1));
        try { return exactSample(frame, point.toTuple()); } finally { point.delete(); }
      });
      const unwrapped = [samples[0]!.angle];
      for (let sampleIndex = 1; sampleIndex < samples.length; sampleIndex += 1) {
        let delta = samples[sampleIndex]!.angle - samples[sampleIndex - 1]!.angle;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        unwrapped.push(unwrapped[sampleIndex - 1]! + delta);
      }
      const stations = samples.map((sample) => sample.station);
      const radii = samples.map((sample) => sample.radius);
      const stationMin = Math.min(...stations);
      const stationMax = Math.max(...stations);
      const radiusMin = Math.min(...radii);
      const radiusMax = Math.max(...radii);
      const stationMean = stations.reduce((sum, entry) => sum + entry, 0) / stations.length;
      const angleMean = unwrapped.reduce((sum, entry) => sum + entry, 0) / unwrapped.length;
      const stationVariance = stations.reduce(
        (sum, entry) => sum + (entry - stationMean) ** 2,
        0,
      );
      const covariance = stations.reduce(
        (sum, entry, sampleIndex) => sum + (entry - stationMean) * (unwrapped[sampleIndex]! - angleMean),
        0,
      );
      const thetaPerStation = stationVariance > 1e-12 ? covariance / stationVariance : null;
      const angleDelta = unwrapped.at(-1)! - unwrapped[0]!;
      return {
        index,
        type: String(edge.geomType),
        length: edge.length,
        samples,
        stationMin,
        stationMax,
        stationSpan: stationMax - stationMin,
        radiusMin,
        radiusMax,
        radialRange: radiusMax - radiusMin,
        angleDelta,
        turns: angleDelta / (Math.PI * 2),
        thetaPerStation,
        pitchMm: thetaPerStation && Math.abs(thetaPerStation) > 1e-9
          ? Math.PI * 2 / Math.abs(thetaPerStation)
          : null,
      };
    } finally {
      edge.delete();
    }
  });
}

function exactSectionTraces(
  rc: any,
  shape: any,
  frame: AxisFrame,
  origin: number[],
  normal: number[],
  sampleCount = 513,
): ExactEdgeTrace[] {
  const oc = rc.getOC();
  let point: any = null;
  let direction: any = null;
  let plane: any = null;
  let section: any = null;
  let progress: any = null;
  let result: any = null;
  try {
    point = new oc.gp_Pnt_3(...origin);
    direction = new oc.gp_Dir_4(...normal);
    plane = new oc.gp_Pln_3(point, direction);
    section = new oc.BRepAlgoAPI_Section_1();
    section.Init1_1(shape.wrapped);
    section.Init2_2(plane);
    section.Approximation(false);
    progress = new oc.Message_ProgressRange_1();
    section.Build(progress);
    assert.ok(!section.IsDone || section.IsDone(), 'independent exact section failed');
    result = rc.cast(section.Shape());
    const traces = exactEdgeTraces(result, frame, sampleCount);
    assert.ok(traces.length > 0, 'independent exact section produced no edges');
    return traces;
  } finally {
    result?.delete();
    progress?.delete();
    section?.delete();
    plane?.delete();
    direction?.delete();
    point?.delete();
  }
}

function axialSectionExtrema(
  rc: any,
  shape: any,
  frame: AxisFrame,
  station: number,
): { minimumRadiusMm: number; maximumRadiusMm: number } {
  const origin = frame.origin.map((entry, index) => entry + frame.axis[index]! * station);
  const traces = exactSectionTraces(rc, shape, frame, origin, frame.axis);
  const radii = traces.flatMap((trace) => trace.samples.map((sample) => sample.radius));
  return { minimumRadiusMm: Math.min(...radii), maximumRadiusMm: Math.max(...radii) };
}

function median(values: number[]): number {
  assert.ok(values.length > 0, 'median requires at least one value');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function circleRadius2d(first: number[], second: number[], third: number[]): number {
  const [x1, y1] = first;
  const [x2, y2] = second;
  const [x3, y3] = third;
  const determinant = 2 * (x1! * (y2! - y3!) + x2! * (y3! - y1!) + x3! * (y1! - y2!));
  assert.ok(Math.abs(determinant) > 1e-10, 'independent root samples are collinear');
  const centerX = (
    (x1! ** 2 + y1! ** 2) * (y2! - y3!)
    + (x2! ** 2 + y2! ** 2) * (y3! - y1!)
    + (x3! ** 2 + y3! ** 2) * (y1! - y2!)
  ) / determinant;
  const centerY = (
    (x1! ** 2 + y1! ** 2) * (x3! - x2!)
    + (x2! ** 2 + y2! ** 2) * (x1! - x3!)
    + (x3! ** 2 + y3! ** 2) * (x2! - x1!)
  ) / determinant;
  return Math.hypot(x1! - centerX, y1! - centerY);
}

function exactRoundedRootRadius(rc: any, shape: any, frame: AxisFrame): number {
  const traces = exactSectionTraces(rc, shape, frame, frame.origin, frame.binormal);
  const candidates = traces.filter((trace) =>
    trace.type === 'BSPLINE_CURVE'
    && closeTo(trace.radiusMin, independentM6External.minorRadiusMm, 2e-4)
    && closeTo(trace.radiusMax, independentM6External.rootTangentRadiusMm, 2e-4)
    && trace.stationSpan > 0.08
    && trace.stationSpan < 0.14);
  assert.ok(candidates.length > 0, 'independent exact section found no bounded rounded-root arc');
  return median(candidates.map((trace) => {
    const first = trace.samples[0]!;
    const middle = trace.samples[Math.floor(trace.samples.length / 2)]!;
    const last = trace.samples.at(-1)!;
    return circleRadius2d(
      [first.radius, first.station],
      [middle.radius, middle.station],
      [last.radius, last.station],
    );
  }));
}

function assertMeasuredHandedness(readback: JsonRecord, expected: 'left' | 'right', label: string): void {
  assert.equal(readback.handedness, expected, `${label}: exact helical handedness is wrong`);
}

function exactModeledThreadReadback(
  rc: any,
  exactBrep: string,
  frame: AxisFrame,
  expected: {
    label: string;
    handedness: 'left' | 'right';
    span: [number, number];
    runout: 'full-profile' | 'one-pitch-taper';
    verifyRoundedRoot?: boolean;
    sectionStation?: number;
  },
): JsonRecord {
  const shape = rc.deserializeShape(exactBrep);
  try {
    const traces = exactEdgeTraces(shape, frame);
    const constantHelices = traces.filter((trace) =>
      trace.type === 'BSPLINE_CURVE'
      && trace.stationSpan > independentM6External.pitchMm * 0.75
      && Math.abs(trace.turns) > 0.75
      && trace.pitchMm != null
      && closeTo(trace.pitchMm, independentM6External.pitchMm, 3e-4)
      && trace.radialRange < 3e-4);
    const majorHelices = constantHelices.filter((trace) =>
      closeTo((trace.radiusMin + trace.radiusMax) / 2, independentM6External.majorRadiusMm, 2e-4));
    const rootTangentHelices = constantHelices.filter((trace) =>
      closeTo((trace.radiusMin + trace.radiusMax) / 2, independentM6External.rootTangentRadiusMm, 2e-4));
    assert.ok(majorHelices.length > 0, `${expected.label}: exact artifact has no M6 major-radius helix`);
    assert.ok(rootTangentHelices.length > 0, `${expected.label}: exact artifact has no rounded-root tangent helix`);
    const helicalSign = Math.sign(median(
      [...majorHelices, ...rootTangentHelices].map((trace) => trace.thetaPerStation!),
    ));
    const handedness = helicalSign > 0 ? 'right' : 'left';
    const pitchMm = median([...majorHelices, ...rootTangentHelices].map((trace) => trace.pitchMm!));
    assert.ok(closeTo(pitchMm, independentM6External.pitchMm, 3e-4),
      `${expected.label}: exact helical pitch is not 1 mm`);
    const centerSection = axialSectionExtrema(
      rc,
      shape,
      frame,
      expected.sectionStation ?? (expected.span[0] + expected.span[1]) / 2,
    );
    assert.ok(closeTo(centerSection.maximumRadiusMm, independentM6External.majorRadiusMm, 3e-4),
      `${expected.label}: exact major radius is wrong`);
    assert.ok(closeTo(centerSection.minimumRadiusMm, independentM6External.minorRadiusMm, 3e-4),
      `${expected.label}: exact minor/root radius is wrong`);
    const radialDepthMm = centerSection.maximumRadiusMm - centerSection.minimumRadiusMm;
    assert.ok(closeTo(radialDepthMm, independentM6External.radialDepthMm, 5e-4),
      `${expected.label}: exact profile radial span is wrong`);

    const probeOffset = independentM6External.pitchMm * 0.05;
    const startSection = axialSectionExtrema(rc, shape, frame, expected.span[0] + probeOffset);
    const endSection = axialSectionExtrema(rc, shape, frame, expected.span[1] - probeOffset);
    const startDepth = startSection.maximumRadiusMm - startSection.minimumRadiusMm;
    const endDepth = endSection.maximumRadiusMm - endSection.minimumRadiusMm;
    const taperHelices = traces.filter((trace) =>
      trace.type === 'BSPLINE_CURVE'
      && trace.stationSpan > independentM6External.pitchMm * 0.8
      && Math.abs(trace.angleDelta) > Math.PI * 1.5
      && trace.radialRange > independentM6External.radialDepthMm * 0.7);
    if (expected.runout === 'full-profile') {
      assert.ok(startDepth > independentM6External.radialDepthMm * 0.9
        && endDepth > independentM6External.radialDepthMm * 0.9,
      `${expected.label}: exact full-profile runout lost full endpoint depth`);
      assert.equal(taperHelices.length, 0,
        `${expected.label}: exact full-profile artifact contains tapered helical boundaries`);
    } else {
      assert.ok(startDepth < independentM6External.radialDepthMm * 0.15
        && endDepth < independentM6External.radialDepthMm * 0.15,
      `${expected.label}: exact one-pitch runout did not taper both endpoints`);
      assert.ok(taperHelices.length >= 2,
        `${expected.label}: exact one-pitch runout has no tapered helical transitions`);
    }
    const roundedRootRadiusMm = expected.verifyRoundedRoot
      ? exactRoundedRootRadius(rc, shape, frame)
      : null;
    if (roundedRootRadiusMm != null) {
      assert.ok(closeTo(roundedRootRadiusMm, independentM6External.roundedRootRadiusMm, 6e-4),
        `${expected.label}: exact rounded root is not H/6`);
    }
    const readback = {
      source: 'independent-deserialized-occt-brep',
      pitchMm,
      handedness,
      helicalSign,
      majorRadiusMm: centerSection.maximumRadiusMm,
      minorRootRadiusMm: centerSection.minimumRadiusMm,
      radialDepthMm,
      roundedRootRadiusMm,
      spanMm: [...expected.span],
      runout: expected.runout,
      endpointDepthMm: [startDepth, endDepth],
      constantHelixCount: constantHelices.length,
      taperedTransitionCount: taperHelices.length,
    };
    assertMeasuredHandedness(readback, expected.handedness, expected.label);
    return readback;
  } finally {
    shape.delete();
  }
}

function exactInteriorSpanReadback(
  rc: any,
  exactBrep: string,
  frame: AxisFrame,
  requestedSpan: [number, number],
): JsonRecord {
  const shape = rc.deserializeShape(exactBrep);
  try {
    const traces = exactEdgeTraces(shape, frame);
    const modifiedSamples = traces.flatMap((trace) => trace.samples).filter((sample) =>
      sample.radius < independentM6External.nominalRadiusMm - 1e-4);
    assert.ok(modifiedSamples.length > 0, 'interior span artifact contains no exact threaded boundary');
    const measuredSpan = [
      Math.min(...modifiedSamples.map((sample) => sample.station)),
      Math.max(...modifiedSamples.map((sample) => sample.station)),
    ];
    assert.ok(closeTo(measuredSpan[0]!, requestedSpan[0], 2e-3)
      && closeTo(measuredSpan[1]!, requestedSpan[1], 2e-3),
    `interior exact groove escaped requested span ${requestedSpan.join('..')}: measured ${measuredSpan.join('..')}`);
    const boundaryProbe = 0.02;
    const before = axialSectionExtrema(rc, shape, frame, requestedSpan[0] - boundaryProbe);
    const after = axialSectionExtrema(rc, shape, frame, requestedSpan[1] + boundaryProbe);
    for (const [label, section] of [['before', before], ['after', after]] as const) {
      assert.ok(closeTo(section.minimumRadiusMm, independentM6External.nominalRadiusMm, 2e-5)
        && closeTo(section.maximumRadiusMm, independentM6External.nominalRadiusMm, 2e-5),
      `interior exact groove cut material ${label} its requested span`);
    }
    return {
      source: 'independent-deserialized-occt-brep',
      requestedSpanMm: [...requestedSpan],
      measuredModifiedSpanMm: measuredSpan,
      outsideProbeOffsetMm: boundaryProbe,
      outsideRadiusMm: [before.minimumRadiusMm, after.minimumRadiusMm],
    };
  } finally {
    shape.delete();
  }
}

function assertPlainCylinderHasNoThreadHelix(rc: any, exactBrep: string, frame: AxisFrame): void {
  const shape = rc.deserializeShape(exactBrep);
  try {
    const falseHelices = exactEdgeTraces(shape, frame).filter((trace) =>
      trace.stationSpan > independentM6External.pitchMm * 0.75
      && Math.abs(trace.turns) > 0.75
      && trace.pitchMm != null
      && closeTo(trace.pitchMm, independentM6External.pitchMm, 3e-4));
    assert.equal(falseHelices.length, 0,
      'negative control: a plain cylinder was misclassified as an exact modeled thread');
  } finally {
    shape.delete();
  }
}

let requestSerial = 0;

function rootPart(document: JsonRecord): JsonRecord {
  const part = document.partDefinitions?.find((entry: JsonRecord) =>
    entry.id === document.rootDocument?.partId) || document.partDefinitions?.[0];
  assert.ok(part, 'Thread v2 smoke: root part is missing');
  return part;
}

function activeBodyId(document: JsonRecord): string {
  const body = runtime.studioV5ActiveBody(document);
  assert.ok(body?.id, 'Thread v2 smoke: active target body is missing');
  return body.id;
}

function saveReopen(document: JsonRecord, label: string): JsonRecord {
  const saved = JSON.stringify(projectModule.prepareStudioV5Project(document));
  const reopened = projectModule.parseStudioV5Project(saved) as JsonRecord;
  assert.equal(JSON.stringify(reopened), saved, `${label}: canonical save/reopen changed document bytes`);
  return reopened;
}

function cylinderProject(projectId: string, radiusMm: number, lengthMm: number): JsonRecord {
  return runtime.createStudioV5RuntimePartProject({
  projectId,
    name: projectId,
    units: 'mm',
    parameters: [],
    features: [{
      id: `feature-${projectId}-carrier`,
      type: 'extrude',
      sketch: {
        shapes: [{ id: `shape-${projectId}-carrier`, kind: 'circle', x: 0, y: 0, r: radiusMm }],
        z: 0,
      },
      h: lengthMm,
      through: false,
    }],

}) as JsonRecord;
}

function annulusProject(projectId: string, innerRadiusMm: number, lengthMm: number): JsonRecord {
  return runtime.createStudioV5RuntimePartProject({
  projectId,
    name: projectId,
    units: 'mm',
    parameters: [],
    features: [{
      id: `feature-${projectId}-carrier`,
      type: 'extrude',
      sketch: {
        shapes: [{ id: `shape-${projectId}-outer`, kind: 'circle', x: 0, y: 0, r: 6 }],
        z: 0,
      },
      h: lengthMm,
      through: false,
    }, {
      id: `feature-${projectId}-bore`,
      type: 'cut',
      sketch: {
        shapes: [{ id: `shape-${projectId}-inner`, kind: 'circle', x: 0, y: 0, r: innerRadiusMm }],
        z: 0,
      },
      h: lengthMm,
      through: true,
    }],

}) as JsonRecord;
}

function rotatedCylinderProject(projectId: string, radiusMm: number, lengthMm: number): JsonRecord {
  const base = cylinderProject(projectId, radiusMm, lengthMm);
  return runtime.createStudioV5TransformFeature(base, {
    id: `feature-${projectId}-rotate`,
    name: 'Rotate cylindrical support off the world Z axis',
    bodyId: activeBodyId(base),
    mode: 'rotate',
    transform: {
      mode: 'rotate',
      origin: [0, 0, 0],
      direction: [0, 1, 0],
      angle: 37,
    },
  }) as JsonRecord;
}

async function rebuild(
  kernel: HeadlessKernel,
  document: JsonRecord,
  label: string,
  timeoutMs = 180_000,
): Promise<JsonRecord> {
  requestSerial += 1;
  return kernel.request({
    kind: 'rebuild',
    requestId: `thread-v2-${requestSerial}-${label}`,
    projectId: document.projectId,
    revision: requestSerial,
    document,
    includeExactBrep: true,
  }, timeoutMs) as Promise<JsonRecord>;
}

function topologyNames(body: JsonRecord): { faces: string[]; edges: string[]; vertices: string[] } {
  return {
    faces: (body.mesh?.topologyFaces || []).map((entry: JsonRecord) => entry.name),
    edges: (body.mesh?.edges || []).map((entry: JsonRecord) => entry.name),
    vertices: (body.mesh?.topologyVertices || []).map((entry: JsonRecord) => entry.name),
  };
}

function assertExactBody(
  result: JsonRecord,
  document: JsonRecord,
  label: string,
  bodyId = activeBodyId(document),
): JsonRecord {
  assert.equal(result.kind, 'rebuild-result', `${label}: wrong production-worker response kind`);
  assert.equal(result.effectiveDocumentHash, runtime.studioV5CanonicalHash(document),
    `${label}: rebuild is not bound to the current canonical document hash`);
  assert.deepEqual(result.errors || [], [], `${label}: production worker errors`);
  const body = result.bodies?.find((entry: JsonRecord) => entry.bodyId === bodyId);
  assert.ok(body, `${label}: exact target body is missing`);
  assert.equal(body.error, null, `${label}: exact body published an error`);
  assert.equal(body.lastValid, false, `${label}: body came from a last-valid fallback`);
  assert.equal(body.geometry?.valid, true, `${label}: exact geometry is invalid`);
  assert.equal(body.geometry?.brepValid, true, `${label}: BRepCheck rejected exact geometry`);
  assert.equal(body.geometry?.solidCount, 1, `${label}: exact result is not one solid`);
  assert.ok(typeof body.exactBrep === 'string' && body.exactBrep.length > 100,
    `${label}: canonical exact BREP is missing`);
  const counts = body.mesh?.topologyCounts;
  assert.ok(counts, `${label}: exact topology counts are missing`);
  assert.equal(counts.faces, body.geometry.faceCount, `${label}: face counts disagree`);
  assert.equal(counts.edges, body.geometry.edgeCount, `${label}: edge counts disagree`);
  assert.equal(counts.vertices, body.geometry.vertexCount, `${label}: vertex counts disagree`);
  assert.equal(counts.namedFaces, counts.faces, `${label}: persistent face naming is incomplete`);
  assert.equal(counts.namedEdges, counts.edges, `${label}: persistent edge naming is incomplete`);
  assert.equal(counts.namedVertices, counts.vertices, `${label}: persistent vertex naming is incomplete`);
  assert.deepEqual(body.mesh?.topologyDiagnostics || [], [], `${label}: topology diagnostics are not empty`);
  const names = topologyNames(body);
  for (const kind of ['faces', 'edges', 'vertices'] as const) {
    assert.equal(names[kind].length, counts[kind], `${label}: ${kind} topology payload is incomplete`);
    assert.ok(names[kind].every((name) => typeof name === 'string' && name.length > 0),
      `${label}: ${kind} contains an unnamed exact subshape`);
    assert.equal(new Set(names[kind]).size, names[kind].length,
      `${label}: ${kind} persistent names are not unique`);
  }
  return body;
}

async function discoverCylindricalFace(
  kernel: HeadlessKernel,
  document: JsonRecord,
  expectedRadiusMm: number,
  label: string,
): Promise<{ result: JsonRecord; body: JsonRecord; face: JsonRecord }> {
  const result = await rebuild(kernel, document, `${label}-discovery`);
  const body = assertExactBody(result, document, `${label} source discovery`);
  const matches = (body.mesh.topologyFaces || []).filter((entry: JsonRecord) =>
    // Serialized selection signatures are intentionally display-quantized;
    // the worker re-derives and validates the unrounded radius from OCCT.
    entry.geomType === 'CYLINDRE' && closeTo(Number(entry.sig?.r), expectedRadiusMm, 0.01));
  assert.equal(matches.length, 1,
    `${label}: runtime did not expose one persistently named radius-${expectedRadiusMm} cylindrical face: `
      + JSON.stringify((body.mesh.topologyFaces || []).map((entry: JsonRecord) => ({
        name: entry.name, geomType: entry.geomType, radius: entry.sig?.r,
      }))));
  const face = matches[0];
  assert.ok(typeof face.name === 'string' && face.name.length > 0,
    `${label}: selected current cylindrical face is unnamed`);
  assert.equal(face.sig?.topologyKind, 'cylindrical-face',
    `${label}: selected current face lacks analytic cylinder evidence`);
  return { result, body, face };
}

function selectedFace(face: JsonRecord, overrides: JsonRecord = {}): JsonRecord {
  return {
    name: overrides.name ?? face.name,
    sig: {
      kind: 'face',
      ...structuredClone(face.sig),
      ...(overrides.sig || {}),
    },
  };
}

function createThreadFeature(
  document: JsonRecord,
  face: JsonRecord,
  id: string,
  options: JsonRecord,
): JsonRecord {
  return threads.createStudioThreadV2Feature({
    id,
    bodyId: activeBodyId(document),
    targetFace: selectedFace(face),
    designation: 'M6',
    toleranceClass: options.threadKind === 'internal' ? '6H' : '6g',
    handedness: 'right',
    ...options,
  });
}

function applyThread(document: JsonRecord, feature: JsonRecord, label: string): JsonRecord {
  return agent.applyCadTransaction(document, {
    transactionId: `transaction-${label}`,
    label,
    expectedRevision: document.revision,
    atomic: true,
    operations: [{ kind: 'feature.thread', input: threads.studioThreadOperationInput(feature) }],
  }).project as JsonRecord;
}

function updateThread(document: JsonRecord, feature: JsonRecord, label: string): JsonRecord {
  return agent.applyCadTransaction(document, {
    transactionId: `transaction-${label}`,
    label,
    expectedRevision: document.revision,
    atomic: true,
    operations: [{
      kind: 'feature.update',
      input: {
        featureId: feature.id,
        patch: {
          name: feature.name,
          resultPolicy: feature.resultPolicy,
          inputRefs: feature.inputRefs,
          extensions: feature.extensions,
        },
      },
    }],
  }).project as JsonRecord;
}

function deleteFeature(document: JsonRecord, featureId: string, label: string): JsonRecord {
  return agent.applyCadTransaction(document, {
    transactionId: `transaction-${label}`,
    label,
    expectedRevision: document.revision,
    atomic: true,
    operations: [{ kind: 'feature.delete', input: { featureId } }],
  }).project as JsonRecord;
}

function assertThreadEvidence(
  body: JsonRecord,
  document: JsonRecord,
  feature: JsonRecord,
  sourceBrepSha256: string,
  label: string,
): JsonRecord {
  assert.equal(body.threadEvidence?.length, 1, `${label}: one authoritative Thread record was not published`);
  const evidence = body.threadEvidence[0];
  assert.equal(evidence.schema, 'partmode.thread-evidence/v1', `${label}: wrong evidence schema`);
  assert.equal(evidence.policy, 'exact-cylindrical-face-thread-v1', `${label}: wrong evidence policy`);
  assert.equal(evidence.featureId, feature.id, `${label}: evidence is bound to the wrong feature`);
  assert.equal(evidence.documentHash, runtime.studioV5CanonicalHash(document),
    `${label}: evidence is not bound to the current document hash`);
  assert.equal(evidence.sourceBrepSha256, sourceBrepSha256,
    `${label}: evidence is not bound to the current source BREP`);
  assert.equal(evidence.resultBrepSha256, sha256(body.exactBrep),
    `${label}: evidence is not bound to the current result BREP`);
  assert.equal(evidence.selectedFace?.name, feature.extensions.thread.support.face.name,
    `${label}: evidence is not bound to the selected persistent face`);
  assert.equal(evidence.selectedFace?.signature?.topologyKind, 'cylindrical-face',
    `${label}: evidence does not retain current analytic cylinder identity`);
  assert.equal(evidence.mode, feature.extensions.thread.mode, `${label}: evidence changed thread mode`);
  assert.equal(evidence.threadKind, feature.extensions.thread.threadKind, `${label}: evidence changed thread kind`);
  assert.equal(evidence.support?.classification, feature.extensions.thread.threadKind,
    `${label}: material-side classification disagrees with the recipe`);
  assert.ok(Array.isArray(evidence.support?.axisPoint) && evidence.support.axisPoint.length === 3,
    `${label}: exact support axis point is missing`);
  assert.ok(Array.isArray(evidence.support?.axisDirection) && evidence.support.axisDirection.length === 3,
    `${label}: exact support axis direction is missing`);
  assert.ok(closeTo(Math.hypot(...evidence.support.axisDirection), 1, 2e-8),
    `${label}: exact support axis is not normalized`);
  assert.equal(evidence.definition?.designation, 'M6', `${label}: evidence changed designation`);
  assert.equal(evidence.definition?.profile?.policy, 'iso-68-1-truncated-profile-v1',
    `${label}: exact ISO-profile construction evidence is missing`);
  assert.equal(evidence.definition?.tolerance?.policy, 'iso-965-maximum-material-reference-v1',
    `${label}: bounded tolerance-reference evidence is missing`);
  assert.equal(evidence.definition?.runout?.policy, 'partmode-explicit-axial-transition-v1',
    `${label}: explicit runout construction evidence is missing`);
  const topology = evidence.resultTopology;
  for (const count of ['faces', 'namedFaces', 'edges', 'namedEdges', 'vertices', 'namedVertices']) {
    assert.equal(topology?.counts?.[count], body.mesh.topologyCounts[count],
      `${label}: evidence and serialized exact-topology ${count} disagree`);
  }
  const bodyNames = topologyNames(body);
  for (const kind of ['faces', 'edges', 'vertices'] as const) {
    assert.equal(topology.persistentNames[kind].length, topology.counts[kind],
      `${label}: evidence ${kind} names are incomplete`);
    assert.equal(new Set(topology.persistentNames[kind]).size, topology.counts[kind],
      `${label}: evidence ${kind} names are not unique`);
    assert.deepEqual([...topology.persistentNames[kind]].sort(), [...bodyNames[kind]].sort(),
      `${label}: evidence ${kind} names differ from the serialized exact body`);
  }
  assert.match(topology.persistentNamesSha256, /^[0-9a-f]{64}$/u,
    `${label}: topology-name digest is malformed`);
  return evidence;
}

function featureById(document: JsonRecord, featureId: string): JsonRecord {
  const feature = rootPart(document).features.find((entry: JsonRecord) => entry.id === featureId);
  assert.ok(feature, `Thread v2 smoke: feature ${featureId} is missing`);
  return feature;
}

async function assertRefusal(
  kernel: HeadlessKernel,
  document: JsonRecord,
  label: string,
  messagePattern: RegExp,
): Promise<JsonRecord> {
  const result = await rebuild(kernel, document, `refusal-${label}`, 90_000);
  assert.equal(result.kind, 'rebuild-result', `${label}: refusal did not return a rebuild result`);
  assert.equal(result.effectiveDocumentHash, runtime.studioV5CanonicalHash(document),
    `${label}: refusal is not bound to the invalid current document`);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0,
    `${label}: invalid Thread unexpectedly produced no worker error`);
  const body = result.bodies?.find((entry: JsonRecord) => entry.bodyId === activeBodyId(document));
  assert.ok(body, `${label}: refusal omitted the target body record`);
  assert.ok(body.error, `${label}: refusal omitted the body-scoped error`);
  assert.equal(body.lastValid, false, `${label}: refusal exposed last-valid geometry`);
  assert.equal(body.geometry, null, `${label}: refusal exposed exact geometry`);
  assert.equal(body.mesh, null, `${label}: refusal exposed display geometry`);
  assert.equal('exactBrep' in body, false, `${label}: refusal exposed an exact BREP`);
  assert.equal('threadEvidence' in body, false, `${label}: refusal exposed stale Thread evidence`);
  assert.match(JSON.stringify(result.errors), messagePattern, `${label}: wrong refusal reason`);
  return result;
}

async function assertRequestRejection(
  kernel: HeadlessKernel,
  document: JsonRecord,
  label: string,
  messagePattern: RegExp,
): Promise<void> {
  let rejected: unknown = null;
  try {
    await rebuild(kernel, document, `contract-refusal-${label}`, 90_000);
  } catch (error) {
    rejected = error;
  }
  assert.ok(rejected instanceof Error, `${label}: malformed document unexpectedly produced a rebuild payload`);
  assert.match(rejected.message, messagePattern, `${label}: wrong document-contract refusal reason`);
  // HeadlessKernel rejects only a `kernel-error` response. Such a response has
  // no bodies, transfer list, BREP, mesh, topology, or evidence to leak.
}

const externalThreadId = 'feature-thread-v2-external-seven';
const internalThreadId = 'feature-thread-v2-internal';
const arbitraryThreadId = 'feature-thread-v2-arbitrary-axis';

let kernel: HeadlessKernel | null = null;
let freshKernel: HeadlessKernel | null = null;

let externalDocument: JsonRecord;
let externalBody: JsonRecord;
let externalEvidence: JsonRecord;
let externalSourceDigest: string;
let externalSourceBrep: string;
let externalFace: JsonRecord;
let externalFeature: JsonRecord;
let externalTopologyNames: JsonRecord;
let internalBody: JsonRecord;
let arbitraryBody: JsonRecord;
let offsetBody: JsonRecord;
let cosmeticBody: JsonRecord;
let cosmeticEvidence: JsonRecord;
let externalArtifactReadback: JsonRecord;
let taperedArtifactReadback: JsonRecord;
let interiorSpanReadback: JsonRecord;

try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();

  // The ordinary external acceptance path starts from a current production-
  // worker topology inventory. The authored support remains nominal Ø6; the
  // bounded 6g allowance is realized by exact geometry rather than requiring
  // callers to pre-machine a hidden Ø5.974 fixture.
  const externalBase = saveReopen(
    cylinderProject('project-thread-v2-external', 3, 7),
    'external source',
  );
  const externalDiscovery = await discoverCylindricalFace(kernel, externalBase, 3, 'external nominal M6');
  externalFace = externalDiscovery.face;
  externalSourceBrep = externalDiscovery.body.exactBrep;
  externalSourceDigest = sha256(externalSourceBrep);
  externalFeature = createThreadFeature(externalBase, externalFace, externalThreadId, {
    name: 'Exact external M6 6g seven-turn thread',
    mode: 'modeled',
    threadKind: 'external',
    handedness: 'right',
    span: { mode: 'fraction', start: 0, end: 1 },
    runout: 'full-profile',
  });
  externalDocument = saveReopen(
    applyThread(externalBase, externalFeature, 'create-external-seven-turn'),
    'external modeled Thread',
  );
  assert.equal(featureById(externalDocument, externalThreadId).extensions.thread.schema, 'partmode.thread/v2',
    'typed create lost the v2 recipe');
  const externalResult = await rebuild(kernel, externalDocument, 'external-seven-turn-full-profile');
  externalBody = assertExactBody(externalResult, externalDocument, 'external seven-turn full-profile');
  externalEvidence = assertThreadEvidence(
    externalBody,
    externalDocument,
    externalFeature,
    externalSourceDigest,
    'external seven-turn full-profile',
  );
  assert.equal(externalEvidence.mode, 'modeled', 'external acceptance path is not modeled');
  assert.equal(externalEvidence.threadKind, 'external', 'external acceptance path changed side');
  assert.equal(externalEvidence.support.radiusMm, 3, 'external support is not nominal Ø6');
  assert.ok(closeTo(externalEvidence.support.modeledSupportRadiusMm, 2.987, 2e-9),
    'external 6g maximum-material allowance was not realized at Ø5.974');
  assert.equal(externalEvidence.definition.resolvedSpanMm.turnCount, 7,
    'external acceptance path did not execute seven modeled turns');
  assert.equal(externalEvidence.definition.runout.form, 'full-profile',
    'external acceptance path changed runout form');
  assert.ok(externalBody.geometry.volume < externalDiscovery.body.geometry.volume,
    'external modeled thread removed no exact material');
  assert.notEqual(externalBody.exactBrep, externalSourceBrep,
    'external modeled Thread is indistinguishable from its source cylinder');
  externalTopologyNames = structuredClone(externalEvidence.resultTopology.persistentNames);

  // An interior, non-integral offset keeps both requested thread boundaries
  // away from the carrier caps. Exact-artifact readback can therefore detect
  // a groove tool that silently cuts beyond the authored axial span.
  const offsetBase = saveReopen(
    cylinderProject('project-thread-v2-interior-offset', 3, 5.5),
    'interior offset source',
  );
  const offsetDiscovery = await discoverCylindricalFace(kernel, offsetBase, 3, 'interior offset nominal M6');
  const offsetFeature = createThreadFeature(
    offsetBase,
    offsetDiscovery.face,
    'feature-thread-v2-interior-offset',
    {
      name: 'Exact interior-offset external M6 thread',
      mode: 'modeled',
      threadKind: 'external',
      handedness: 'right',
      span: { mode: 'offset', startMm: 1.25, endMm: 4.25 },
      runout: 'full-profile',
    },
  );
  const offsetDocument = saveReopen(
    applyThread(offsetBase, offsetFeature, 'create-interior-offset-thread'),
    'interior offset modeled Thread',
  );
  const offsetResult = await rebuild(kernel, offsetDocument, 'interior-offset-modeled');
  offsetBody = assertExactBody(offsetResult, offsetDocument, 'interior offset modeled Thread');
  assertThreadEvidence(
    offsetBody,
    offsetDocument,
    offsetFeature,
    sha256(offsetDiscovery.body.exactBrep),
    'interior offset modeled Thread',
  );

  // Updating the typed feature exercises warm feature-checkpoint replay. A
  // cosmetic recipe is still a kernel-validated analytic thread: it must keep
  // exact source geometry byte-identical while publishing enough current,
  // hash-bound helix data for the viewport overlay.
  const cosmeticFeature = createThreadFeature(externalDocument, externalFace, externalThreadId, {
    name: 'Cosmetic external M6 tapered overlay',
    mode: 'cosmetic',
    threadKind: 'external',
    handedness: 'left',
    span: { mode: 'offset', startMm: 1, endMm: 4 },
    runout: 'one-pitch-taper',
  });
  const cosmeticDocument = saveReopen(
    updateThread(externalDocument, cosmeticFeature, 'update-to-cosmetic-offset'),
    'cosmetic typed update',
  );
  const cosmeticResult = await rebuild(kernel, cosmeticDocument, 'cosmetic-offset-tapered');
  cosmeticBody = assertExactBody(cosmeticResult, cosmeticDocument, 'cosmetic offset tapered Thread');
  cosmeticEvidence = assertThreadEvidence(
    cosmeticBody,
    cosmeticDocument,
    cosmeticFeature,
    externalSourceDigest,
    'cosmetic offset tapered Thread',
  );
  assert.equal(cosmeticBody.exactBrep, externalSourceBrep,
    'cosmetic Thread changed canonical exact source geometry');
  assert.equal(cosmeticEvidence.sourceBrepSha256, cosmeticEvidence.resultBrepSha256,
    'cosmetic Thread evidence does not prove unchanged exact BREP');
  assert.equal(cosmeticEvidence.cosmeticGeometryUnchanged, true,
    'cosmetic Thread did not declare unchanged exact geometry');
  assert.deepEqual(cosmeticEvidence.definition.requestedSpan,
    { mode: 'offset', startMm: 1, endMm: 4 },
    'cosmetic Thread lost its bounded offset span');
  assert.equal(cosmeticEvidence.definition.runout.form, 'one-pitch-taper',
    'cosmetic Thread lost explicit tapered runout');
  // This contract is filled by the production worker, not inferred from DOM
  // text or tessellated mesh counts. It is intentionally asserted below once
  // as a structured analytic overlay rather than a screenshot surrogate.
  const overlay = cosmeticEvidence.representation;
  assert.equal(overlay?.kind, 'analytic-helix-overlay',
    'cosmetic Thread omitted authoritative analytic overlay evidence');
  assert.equal(overlay?.policy, 'axis-radius-pitch-span-v1',
    'cosmetic overlay changed its analytic contract');
  assert.equal(overlay?.targetFaceName, externalFace.name,
    'cosmetic overlay is detached from the selected persistent face');
  assert.equal(overlay?.radiusMm, cosmeticEvidence.support.radiusMm,
    'cosmetic overlay radius is detached from exact support evidence');
  assert.deepEqual(overlay?.axisPoint, cosmeticEvidence.support.axisPoint,
    'cosmetic overlay axis point is detached from exact support evidence');
  assert.deepEqual(overlay?.axisDirection, cosmeticEvidence.support.axisDirection,
    'cosmetic overlay axis direction is detached from exact support evidence');
  assert.equal(overlay?.pitchMm, 1, 'cosmetic overlay pitch changed');
  assert.equal(overlay?.handedness, 'left', 'cosmetic overlay handedness changed');
  assert.equal(overlay?.startStationMm,
    cosmeticEvidence.support.axialBoundsMm.start + cosmeticEvidence.definition.resolvedSpanMm.start,
    'cosmetic overlay start is detached from resolved support span');
  assert.equal(overlay?.endStationMm,
    cosmeticEvidence.support.axialBoundsMm.start + cosmeticEvidence.definition.resolvedSpanMm.end,
    'cosmetic overlay end is detached from resolved support span');
  assert.deepEqual(overlay?.parameterDomain, [0, 1],
    'cosmetic overlay does not expose a bounded viewport parameter domain');
  assert.ok([overlay?.axisPoint, overlay?.axisDirection, overlay?.radialDirection,
    overlay?.startPoint, overlay?.endPoint].every((tuple) =>
    Array.isArray(tuple) && tuple.length === 3 && tuple.every(Number.isFinite)),
  'cosmetic overlay contains non-finite analytic vectors');
  assert.ok(closeTo(vectorLength(overlay.axisDirection), 1, 1e-9)
    && closeTo(vectorLength(overlay.radialDirection), 1, 1e-9)
    && closeTo(vectorDot(overlay.axisDirection, overlay.radialDirection), 0, 1e-9),
  'cosmetic overlay frame is not orthonormal');
  assert.ok(closeTo(
    overlay.endStationMm - overlay.startStationMm,
    overlay.turnCount * overlay.pitchMm,
    1e-8,
  ), 'cosmetic overlay station span is detached from turn count and pitch');
  assert.ok(Number.isFinite(overlay?.angleStartRadians) && Number.isFinite(overlay?.angleDeltaRadians)
    && overlay.angleDeltaRadians < 0,
  'left-hand cosmetic overlay has invalid analytic angular evidence');
  assert.ok(closeTo(Math.abs(overlay.angleDeltaRadians), Math.PI * 2 * overlay.turnCount, 1e-8),
    'cosmetic overlay angle is detached from resolved turn count');
  const expectedOverlayStart = helixPoint(
    overlay.axisPoint, overlay.axisDirection, overlay.radialDirection, overlay.radiusMm,
    overlay.startStationMm, overlay.angleStartRadians,
  );
  const expectedOverlayEnd = helixPoint(
    overlay.axisPoint, overlay.axisDirection, overlay.radialDirection, overlay.radiusMm,
    overlay.endStationMm, overlay.angleStartRadians + overlay.angleDeltaRadians,
  );
  assert.ok(overlay.startPoint.every((coordinate: number, index: number) =>
    closeTo(coordinate, expectedOverlayStart[index]!, 1e-8)),
  'cosmetic overlay analytic start point is inconsistent');
  assert.ok(overlay.endPoint.every((coordinate: number, index: number) =>
    closeTo(coordinate, expectedOverlayEnd[index]!, 1e-8)),
  'cosmetic overlay analytic end point is inconsistent');

  // Thread evidence describes the exact result at the Thread checkpoint. A
  // downstream body modifier changes that result, so the old digest/topology
  // record must not be relabelled with the new document hash. Keep the valid
  // Thread history, rebuild the downstream body exactly, and publish no stale
  // Thread evidence until a future contract can prove the composed result.
  const transformedCosmeticDocument = saveReopen(agent.applyCadTransaction(cosmeticDocument, {
    transactionId: 'transaction-cosmetic-thread-downstream-transform',
    label: 'Move body after cosmetic Thread',
    expectedRevision: cosmeticDocument.revision,
    atomic: true,
    operations: [{
      kind: 'body.transform',
      input: {
        id: 'feature-thread-v2-downstream-transform',
        name: 'Downstream move after cosmetic Thread',
        bodyId: activeBodyId(cosmeticDocument),
        mode: 'move',
        transform: { mode: 'move', translation: [11, -4, 2] },
      },
    }],
  }).project as JsonRecord, 'cosmetic Thread downstream transform');
  const transformedPart = rootPart(transformedCosmeticDocument);
  assert.ok(transformedPart.features.some((entry: JsonRecord) => entry.id === externalThreadId),
    'downstream transform deleted the cosmetic Thread history');
  assert.ok(transformedPart.features.findIndex((entry: JsonRecord) => entry.id === externalThreadId)
    < transformedPart.features.findIndex((entry: JsonRecord) =>
      entry.id === 'feature-thread-v2-downstream-transform'),
  'downstream transform is not ordered after the cosmetic Thread');
  const transformedCosmeticResult = await rebuild(
    kernel, transformedCosmeticDocument, 'cosmetic-thread-downstream-transform',
  );
  const transformedCosmeticBody = assertExactBody(
    transformedCosmeticResult,
    transformedCosmeticDocument,
    'cosmetic Thread downstream transform',
  );
  assert.notEqual(transformedCosmeticBody.exactBrep, cosmeticBody.exactBrep,
    'downstream transform did not change the exact body');
  assert.deepEqual(transformedCosmeticBody.threadEvidence || [], [],
    'downstream transform republished stale cosmetic Thread evidence under the current document hash');

  const cutSourceFeature = createThreadFeature(externalDocument, externalFace, externalThreadId, {
    name: 'One-turn modeled Thread for downstream Cut',
    mode: 'modeled',
    threadKind: 'external',
    handedness: 'right',
    span: { mode: 'offset', startMm: 0, endMm: 1 },
    runout: 'full-profile',
  });
  const cutSourceDocument = saveReopen(
    updateThread(externalDocument, cutSourceFeature, 'update-to-one-turn-before-downstream-cut'),
    'one-turn modeled Thread before downstream cut',
  );
  const cutSourceResult = await rebuild(kernel, cutSourceDocument, 'modeled-one-turn-before-cut');
  const cutSourceBody = assertExactBody(
    cutSourceResult,
    cutSourceDocument,
    'modeled one-turn Thread before downstream Cut',
  );
  assertThreadEvidence(
    cutSourceBody,
    cutSourceDocument,
    cutSourceFeature,
    externalSourceDigest,
    'modeled one-turn Thread before downstream Cut',
  );
  const cutModeledDocument = saveReopen(agent.applyCadTransaction(cutSourceDocument, {
    transactionId: 'transaction-modeled-thread-downstream-cut',
    label: 'Cut body after modeled Thread',
    expectedRevision: cutSourceDocument.revision,
    atomic: true,
    operations: [{
      kind: 'feature.cut',
      input: {
        id: 'feature-thread-v2-downstream-cut',
        name: 'Downstream shallow pocket after modeled Thread',
        sketch: {
          shapes: [{ id: 'shape-thread-v2-downstream-cut', kind: 'circle', x: 0, y: 0, r: 0.35 }],
          z: 6.75,
        },
        height: 0.25,
        through: false,
        resultPolicy: {
          kind: 'subtract',
          targetBodyIds: [activeBodyId(cutSourceDocument)],
          keepTools: false,
        },
      },
    }],
  }).project as JsonRecord, 'modeled Thread downstream cut');
  const cutPart = rootPart(cutModeledDocument);
  assert.ok(cutPart.features.some((entry: JsonRecord) => entry.id === externalThreadId),
    'downstream Cut deleted the modeled Thread history');
  assert.ok(cutPart.features.findIndex((entry: JsonRecord) => entry.id === externalThreadId)
    < cutPart.features.findIndex((entry: JsonRecord) => entry.id === 'feature-thread-v2-downstream-cut'),
  'downstream Cut is not ordered after the modeled Thread');
  const cutModeledResult = await rebuild(kernel, cutModeledDocument, 'modeled-thread-downstream-cut');
  const cutModeledBody = assertExactBody(
    cutModeledResult,
    cutModeledDocument,
    'modeled Thread downstream Cut',
  );
  assert.notEqual(cutModeledBody.exactBrep, cutSourceBody.exactBrep,
    'downstream Cut did not change the exact modeled Thread body');
  assert.ok(cutModeledBody.geometry.volume < cutSourceBody.geometry.volume,
    'downstream Cut removed no exact material');
  assert.deepEqual(cutModeledBody.threadEvidence || [], [],
    'downstream Cut republished stale modeled Thread evidence under the current document hash');

  const deletedDocument = saveReopen(
    deleteFeature(cosmeticDocument, externalThreadId, 'delete-cosmetic-thread'),
    'typed Thread delete',
  );
  assert.equal(rootPart(deletedDocument).features.some((entry: JsonRecord) => entry.id === externalThreadId), false,
    'typed delete retained the Thread feature');
  const deletedResult = await rebuild(kernel, deletedDocument, 'deleted-thread-restoration');
  const deletedBody = assertExactBody(deletedResult, deletedDocument, 'typed Thread delete restoration');
  assert.equal(deletedBody.exactBrep, externalSourceBrep,
    'typed Thread delete did not restore the canonical source BREP');
  assert.deepEqual(deletedBody.threadEvidence || [], [], 'typed Thread delete retained stale evidence');

  // Internal support comes from a real annular solid. The target is selected
  // from its current exact topology inventory by the ISO basic minor radius,
  // not inserted as a fixture name or authored world axis.
  const internalDefinition = threads.studioThreadV2Definition({
    mode: 'modeled', threadKind: 'internal', designation: 'M6', toleranceClass: '6H',
    span: { mode: 'fraction', start: 0, end: 1 }, runout: 'full-profile',
  });
  const internalRadius = internalDefinition.profile.basicDiameters.minor / 2;
  const internalBase = saveReopen(
    annulusProject('project-thread-v2-internal', internalRadius, 3),
    'internal annular source',
  );
  const internalDiscovery = await discoverCylindricalFace(
    kernel, internalBase, internalRadius, 'internal nominal M6 bore',
  );
  const internalFeature = createThreadFeature(internalBase, internalDiscovery.face, internalThreadId, {
    name: 'Exact internal M6 6H thread',
    mode: 'modeled',
    threadKind: 'internal',
    handedness: 'left',
    span: { mode: 'offset', startMm: 0, endMm: 3 },
    runout: 'full-profile',
  });
  const internalDocument = saveReopen(
    applyThread(internalBase, internalFeature, 'create-internal-thread'),
    'internal modeled Thread',
  );
  const internalResult = await rebuild(kernel, internalDocument, 'internal-modeled');
  internalBody = assertExactBody(internalResult, internalDocument, 'internal modeled Thread');
  const internalEvidence = assertThreadEvidence(
    internalBody,
    internalDocument,
    internalFeature,
    sha256(internalDiscovery.body.exactBrep),
    'internal modeled Thread',
  );
  assert.equal(internalEvidence.threadKind, 'internal', 'internal Thread changed side');
  assert.equal(internalEvidence.support.classification, 'internal',
    'inner bore was not classified from exact material orientation');
  assert.equal(internalEvidence.definition.toleranceClass, '6H', 'internal Thread changed tolerance class');
  assert.equal(internalEvidence.definition.profile.root.form, 'flat',
    'internal exact profile lost its flat root');
  assert.ok(internalBody.geometry.volume < internalDiscovery.body.geometry.volume,
    'internal modeled groove removed no exact material');

  // The same source-owned construction must follow an arbitrary exact cylinder
  // axis. This three-turn one-pitch-taper path also proves bounded fractional
  // span resolution without relying on a world-Z special case.
  const arbitraryBase = saveReopen(
    rotatedCylinderProject('project-thread-v2-arbitrary', 3, 3),
    'arbitrary-axis source',
  );
  const arbitraryDiscovery = await discoverCylindricalFace(kernel, arbitraryBase, 3, 'arbitrary-axis support');
  const arbitraryFeature = createThreadFeature(arbitraryBase, arbitraryDiscovery.face, arbitraryThreadId, {
    name: 'Arbitrary-axis tapered external M6 thread',
    mode: 'modeled',
    threadKind: 'external',
    handedness: 'left',
    span: { mode: 'fraction', start: 0, end: 1 },
    runout: 'one-pitch-taper',
  });
  const arbitraryDocument = saveReopen(
    applyThread(arbitraryBase, arbitraryFeature, 'create-arbitrary-axis-thread'),
    'arbitrary-axis modeled Thread',
  );
  const arbitraryResult = await rebuild(kernel, arbitraryDocument, 'arbitrary-axis-tapered');
  arbitraryBody = assertExactBody(arbitraryResult, arbitraryDocument, 'arbitrary-axis tapered Thread');
  const arbitraryEvidence = assertThreadEvidence(
    arbitraryBody,
    arbitraryDocument,
    arbitraryFeature,
    sha256(arbitraryDiscovery.body.exactBrep),
    'arbitrary-axis tapered Thread',
  );
  assert.ok(Math.abs(arbitraryEvidence.support.axisDirection[0]!) > 0.25,
    'arbitrary support axis remained a hidden world-Z special case');
  assert.ok(Math.abs(Math.abs(arbitraryEvidence.support.axisDirection[2]!) - 1) > 0.1,
    'arbitrary support axis remained parallel to world Z');
  assert.equal(arbitraryEvidence.definition.runout.form, 'one-pitch-taper',
    'arbitrary-axis modeled Thread did not execute tapered runout');
  assert.equal(arbitraryEvidence.definition.resolvedSpanMm.turnCount, 3,
    'arbitrary-axis fractional span did not resolve to three turns');

  // These checks open the canonical result BREP in a second OCCT instance and
  // measure its exact curves/sections. They intentionally consume neither the
  // authored Thread definition nor the production worker's threadEvidence.
  const independentRc = await independentReplicad();
  const worldFrame = exactAxisFrame([0, 0, 1]);
  const arbitraryFrame = exactAxisFrame([
    Math.sin(37 * Math.PI / 180),
    0,
    Math.cos(37 * Math.PI / 180),
  ]);
  assertPlainCylinderHasNoThreadHelix(independentRc, externalSourceBrep, worldFrame);
  externalArtifactReadback = exactModeledThreadReadback(
    independentRc,
    externalBody.exactBrep,
    worldFrame,
    {
      label: 'independent external full-profile readback',
      handedness: 'right',
      span: [0, 7],
      runout: 'full-profile',
      verifyRoundedRoot: true,
      sectionStation: 3.25,
    },
  );
  interiorSpanReadback = exactInteriorSpanReadback(
    independentRc,
    offsetBody.exactBrep,
    worldFrame,
    [1.25, 4.25],
  );
  taperedArtifactReadback = exactModeledThreadReadback(
    independentRc,
    arbitraryBody.exactBrep,
    arbitraryFrame,
    {
      label: 'independent arbitrary-axis tapered readback',
      handedness: 'left',
      span: [0, 3],
      runout: 'one-pitch-taper',
    },
  );
  assert.equal(
    Math.sign(cosmeticEvidence.representation.angleDeltaRadians),
    taperedArtifactReadback.helicalSign,
    'cosmetic overlay handedness is opposite the independently measured modeled artifact',
  );
  assert.throws(
    () => assertMeasuredHandedness(externalArtifactReadback, 'left', 'wrong-hand negative control'),
    /handedness/iu,
    'negative control: wrong modeled handedness unexpectedly passed exact-artifact readback',
  );

  // Source edits invalidate the stored face signature. The worker must refuse
  // the stale association, then accept a face freshly selected from the edited
  // exact topology. This request follows a valid result for the same project,
  // so last-valid leakage would be observable.
  const sourceFeatureId = rootPart(externalDocument).features[0].id;
  const sourceEdited = agent.applyCadTransaction(externalDocument, {
    transactionId: 'transaction-edit-thread-source-height',
    label: 'Edit Thread source support height',
    expectedRevision: externalDocument.revision,
    atomic: true,
    operations: [{ kind: 'feature.update', input: { featureId: sourceFeatureId, patch: { h: 6 } } }],
  }).project as JsonRecord;
  await rebuild(kernel, externalDocument, 'prime-valid-before-stale-source');
  await assertRefusal(kernel, sourceEdited, 'stale face after source edit', /current|signature|persistent|match/iu);
  const editedSourceOnly = saveReopen(
    deleteFeature(sourceEdited, externalThreadId, 'delete-stale-thread-before-rebind'),
    'edited source without stale Thread',
  );
  const editedDiscovery = await discoverCylindricalFace(kernel, editedSourceOnly, 3, 'edited source recapture');
  const reboundFeature = createThreadFeature(editedSourceOnly, editedDiscovery.face, externalThreadId, {
    name: 'Rebound cosmetic Thread after source edit',
    mode: 'cosmetic',
    threadKind: 'external',
    span: { mode: 'fraction', start: 0, end: 1 },
    runout: 'full-profile',
  });
  const reboundDocument = saveReopen(
    applyThread(editedSourceOnly, reboundFeature, 'rebind-thread-after-source-edit'),
    'source-edit rebound Thread',
  );
  const reboundResult = await rebuild(kernel, reboundDocument, 'source-edit-rebound');
  const reboundBody = assertExactBody(reboundResult, reboundDocument, 'source-edit rebound Thread');
  assertThreadEvidence(
    reboundBody,
    reboundDocument,
    reboundFeature,
    sha256(editedDiscovery.body.exactBrep),
    'source-edit rebound Thread',
  );
  assert.equal(reboundBody.exactBrep, editedDiscovery.body.exactBrep,
    'source-edit cosmetic rebind changed the edited exact source');

  // Fail-closed production-worker matrix. Every invalid revision is inspected
  // for absence of exact BREP, display mesh, topology, evidence, and fallback.
  const planarFace = externalDiscovery.body.mesh.topologyFaces.find((entry: JsonRecord) =>
    entry.geomType === 'PLANE');
  assert.ok(planarFace?.name, 'external source has no named planar face for non-cylinder refusal');

  const wrongKindFeature = createThreadFeature(externalBase, externalFace, 'feature-thread-v2-wrong-kind', {
    mode: 'cosmetic', threadKind: 'internal', span: { mode: 'fraction', start: 0, end: 1 },
    runout: 'full-profile',
  });
  await assertRefusal(
    kernel,
    applyThread(externalBase, wrongKindFeature, 'create-wrong-kind-thread'),
    'wrong material side',
    /external|internal|support/iu,
  );

  const wrongSignatureFace = selectedFace(externalFace, {
    sig: { r: Number(externalFace.sig.r) + 0.25 },
  });
  const wrongRadiusFeature = threads.createStudioThreadV2Feature({
    id: 'feature-thread-v2-wrong-signature-radius',
    bodyId: activeBodyId(externalBase),
    targetFace: wrongSignatureFace,
    mode: 'cosmetic', threadKind: 'external', designation: 'M6', toleranceClass: '6g',
    span: { mode: 'fraction', start: 0, end: 1 }, runout: 'full-profile',
  });
  await assertRefusal(
    kernel,
    applyThread(externalBase, wrongRadiusFeature, 'create-wrong-signature-radius'),
    'wrong stored face radius',
    /signature|current|match/iu,
  );

  const nonCylinderTarget = selectedFace(externalFace, { name: planarFace.name });
  const nonCylinderFeature = threads.createStudioThreadV2Feature({
    id: 'feature-thread-v2-planar-target',
    bodyId: activeBodyId(externalBase),
    targetFace: nonCylinderTarget,
    mode: 'cosmetic', threadKind: 'external', designation: 'M6', toleranceClass: '6g',
    span: { mode: 'fraction', start: 0, end: 1 }, runout: 'full-profile',
  });
  await assertRefusal(
    kernel,
    applyThread(externalBase, nonCylinderFeature, 'create-planar-target-thread'),
    'non-cylindrical persistent face',
    /cylindrical|signature|current|match/iu,
  );

  const outsideSpanFeature = createThreadFeature(externalBase, externalFace, 'feature-thread-v2-outside-span', {
    mode: 'cosmetic', threadKind: 'external', span: { mode: 'offset', startMm: 0, endMm: 8 },
    runout: 'full-profile',
  });
  await assertRefusal(
    kernel,
    applyThread(externalBase, outsideSpanFeature, 'create-outside-span-thread'),
    'span outside current support',
    /span|inside|support/iu,
  );

  const shortTaperFeature = createThreadFeature(externalBase, externalFace, 'feature-thread-v2-short-taper', {
    mode: 'modeled', threadKind: 'external', span: { mode: 'offset', startMm: 0, endMm: 1 },
    runout: 'one-pitch-taper',
  });
  await assertRefusal(
    kernel,
    applyThread(externalBase, shortTaperFeature, 'create-short-taper-thread'),
    'overlapping one-pitch runouts',
    /two full pitches|runout|span/iu,
  );

  const limitBase = saveReopen(cylinderProject('project-thread-v2-turn-limit', 3, 8), 'turn-limit source');
  const limitDiscovery = await discoverCylindricalFace(kernel, limitBase, 3, 'turn-limit support');
  const overLimitFeature = createThreadFeature(limitBase, limitDiscovery.face, 'feature-thread-v2-over-limit', {
    mode: 'modeled', threadKind: 'external', span: { mode: 'fraction', start: 0, end: 1 },
    runout: 'full-profile',
  });
  await assertRefusal(
    kernel,
    applyThread(limitBase, overLimitFeature, 'create-over-limit-thread'),
    'modeled turn limit',
    /7-turn|ceiling|turn/iu,
  );

  const cosmeticLimitBase = saveReopen(
    cylinderProject('project-thread-v2-cosmetic-turn-limit', 3, 101),
    'cosmetic turn-limit source',
  );
  const cosmeticLimitDiscovery = await discoverCylindricalFace(
    kernel, cosmeticLimitBase, 3, 'cosmetic turn-limit support',
  );
  const overCosmeticLimitFeature = createThreadFeature(
    cosmeticLimitBase,
    cosmeticLimitDiscovery.face,
    'feature-thread-v2-over-cosmetic-limit',
    {
      mode: 'cosmetic', threadKind: 'external', span: { mode: 'fraction', start: 0, end: 1 },
      runout: 'full-profile',
    },
  );
  assert.equal(overCosmeticLimitFeature.extensions.thread.cosmeticTurnLimit, 100,
    'valid cosmetic recipe lost its explicit viewport turn limit');
  assert.equal(overCosmeticLimitFeature.extensions.thread.coarsePitch, 1,
    'cosmetic turn-limit fixture changed M6 coarse pitch');
  assert.ok(closeTo(
    cosmeticLimitDiscovery.body.geometry.bounds[1][2]
      - cosmeticLimitDiscovery.body.geometry.bounds[0][2],
    101,
    1e-8,
  ), 'cosmetic turn-limit fixture is not a 101-pitch exact support');
  await assertRefusal(
    kernel,
    applyThread(cosmeticLimitBase, overCosmeticLimitFeature, 'create-over-cosmetic-limit-thread'),
    'cosmetic turn limit',
    /Cosmetic thread span exceeds the 100-turn viewport ceiling/iu,
  );

  const mismatchBase = saveReopen(
    cylinderProject('project-thread-v2-diameter-mismatch', 3.1, 3),
    'diameter mismatch source',
  );
  const mismatchDiscovery = await discoverCylindricalFace(kernel, mismatchBase, 3.1, 'diameter mismatch');
  for (const mode of ['cosmetic', 'modeled']) {
    const mismatchFeature = createThreadFeature(
      mismatchBase,
      mismatchDiscovery.face,
      `feature-thread-v2-diameter-mismatch-${mode}`,
      {
        mode, threadKind: 'external', span: { mode: 'fraction', start: 0, end: 1 },
        runout: 'full-profile',
      },
    );
    await assertRefusal(
      kernel,
      applyThread(mismatchBase, mismatchFeature, `create-diameter-mismatch-${mode}`),
      `${mode} nominal diameter mismatch`,
      /diameter|M6|support/iu,
    );
  }

  const unnamedDocument = structuredClone(externalDocument);
  const unnamedFeature = featureById(unnamedDocument, externalThreadId);
  unnamedFeature.extensions.thread.support.face.name = '';
  unnamedFeature.inputRefs[1].semanticPath.name = '';
  await rebuild(kernel, externalDocument, 'prime-before-unnamed-refusal');
  await assertRequestRejection(kernel, unnamedDocument, 'unnamed persistent face', /name|persistent|recipe/iu);

  const tamperedDocument = structuredClone(externalDocument);
  featureById(tamperedDocument, externalThreadId).extensions.thread.sources[0].url = 'https://example.invalid/';
  await rebuild(kernel, externalDocument, 'prime-before-recipe-tamper');
  await assertRequestRejection(kernel, tamperedDocument, 'tampered source-owned recipe', /recipe|source-owned|Thread/iu);

  // A second production worker must independently derive byte-identical exact
  // BREP, complete names, and evidence. Dispose first because the headless host
  // intentionally exposes one worker instance per process.
  await kernel.dispose();
  kernel = null;
  freshKernel = await createHeadlessKernel();
  await freshKernel.waitForKernel();
  const freshResult = await rebuild(freshKernel, externalDocument, 'fresh-worker-determinism');
  const freshBody = assertExactBody(freshResult, externalDocument, 'fresh-worker external Thread');
  const freshEvidence = assertThreadEvidence(
    freshBody,
    externalDocument,
    externalFeature,
    externalSourceDigest,
    'fresh-worker external Thread',
  );
  assert.equal(freshBody.exactBrep, externalBody.exactBrep,
    'fresh worker changed the canonical exact Thread BREP');
  assert.deepEqual(freshEvidence.resultTopology.persistentNames, externalTopologyNames,
    'fresh worker changed complete persistent F/E/V identity');
  assert.equal(freshEvidence.resultBrepSha256, externalEvidence.resultBrepSha256,
    'fresh worker changed result digest evidence');
  assert.equal(freshEvidence.sourceBrepSha256, externalEvidence.sourceBrepSha256,
    'fresh worker changed source digest evidence');

  console.log(JSON.stringify({
    schema: 'partmode.thread-v2-smoke/v1',
    productionWorker: 'browser-worker-module-via-headless-host',
    runtimeSelectedSupports: {
      external: externalFace.name,
      internal: internalFeature.extensions.thread.support.face.name,
      arbitraryAxis: arbitraryEvidence.selectedFace.name,
    },
    exactCapabilities: {
      externalNominalM6ModeledTurns: externalEvidence.definition.resolvedSpanMm.turnCount,
      internalModeled: internalBody.geometry.valid,
      arbitraryAxis: arbitraryEvidence.support.axisDirection,
      boundedSpanModes: ['fraction', 'offset'],
      runoutForms: ['full-profile', 'one-pitch-taper'],
      cosmeticExactBrepUnchanged: cosmeticBody.exactBrep === externalSourceBrep,
      cosmeticAnalyticOverlay: cosmeticEvidence.representation.kind,
      completePersistentTopology: true,
      freshWorkerDeterministic: true,
      canonicalSaveReopen: true,
      typedLifecycle: ['create', 'update', 'delete'],
      sourceEditRebind: true,
      downstreamEvidenceInvalidation: ['cosmetic-to-transform', 'modeled-to-cut'],
    },
    external: {
      sourceBrepSha256: externalSourceDigest,
      resultBrepSha256: externalEvidence.resultBrepSha256,
      topology: externalBody.mesh.topologyCounts,
      exactBrepBytes: externalBody.exactBrep.length,
    },
    independentExactArtifactReadback: {
      externalFullProfile: externalArtifactReadback,
      arbitraryAxisTapered: taperedArtifactReadback,
      interiorOffsetSpan: interiorSpanReadback,
      negativeControls: ['plain-cylinder-no-helix', 'wrong-handedness-rejected'],
    },
    refusals: [
      'stale-face-after-source-edit',
      'wrong-material-side',
      'wrong-stored-face-radius',
      'non-cylindrical-face',
      'span-outside-support',
      'overlapping-runout-span',
      'modeled-turn-limit',
      'cosmetic-turn-limit',
      'modeled-diameter-mismatch',
      'cosmetic-diameter-mismatch',
      'unnamed-face',
      'tampered-recipe',
    ],
    refusalPublication: { lastValid: false, geometry: false, mesh: false, exactBrep: false, evidence: false },
    manufacturingCertification: false,
  }, null, 2));
} finally {
  await freshKernel?.dispose();
  await kernel?.dispose();
}
