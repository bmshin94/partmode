import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type NamedTables = {
  faces: Array<{ name: string; face: any }>;
  edges: Array<{ name: string; edge: any }>;
  vertices: Array<{ name: string; vertex: any }>;
};

type RestoreOutcome = {
  shape: any;
  names: NamedTables;
  diagnostics: Array<Record<string, unknown>>;
  registryId: string;
  sourceEvidence: string;
};

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Imported topology registry smoke failed: ${name}`);
}

function safeDelete(value: any): void {
  try { value?.delete?.(); } catch {}
}

const root = process.cwd();
const vendorDirectory = resolve(root, 'src/static/vendor');
const nodeGlobals = globalThis as typeof globalThis & {
  require: ReturnType<typeof createRequire>;
  __dirname: string;
};
nodeGlobals.require = createRequire(import.meta.url);
nodeGlobals.__dirname = vendorDirectory;

const rc = await import(pathToFileURL(resolve(vendorDirectory, 'replicad.module.js')).href) as any;
const ocFactory = await import(pathToFileURL(resolve(vendorDirectory, 'replicad-oc.module.js')).href) as any;
const registryModule = await import(
  pathToFileURL(resolve(root, 'src/static/studio-imported-topology-registry.js')).href
) as any;
const source = readFileSync(resolve(root, 'src/static/studio-imported-topology-registry.js'), 'utf8');

check('implementation never uses a topology hash', !source.includes('.HashCode') && !source.includes('.hashCode'));
check('implementation never uses geometric or proximity identity',
  !source.includes('.boundingBox')
  && !source.includes('.pointAt(')
  && !source.includes('measureDistance')
  && !source.includes('centerOf'));
check('implementation uses exact OCCT identity inside the carrier', source.includes('.IsSame('));
check('implementation binds the carrier to full canonical source text',
  source.includes('restoredEvidence !== sourceBrep'));
check('implementation does not call BRepTools.Compare as a fallback', !source.includes('BRepTools.Compare'));
check('persistent-name ordering is independent of locale and ICU data', !source.includes('localeCompare'));
check('analytic-frame quantization is confined to explicit direction-token slots',
  source.includes('tokenIndex < 4 || tokenIndex > 12')
  && source.includes('CANONICAL_ANALYTIC_FRAME_GRID = 1e-12')
  && source.includes('value / CANONICAL_ANALYTIC_FRAME_GRID')
  && !source.includes('.toPrecision(')
  && !source.includes('.toFixed('));
check('irreducible OCCT frame cycles use a deterministic exact representative',
  source.includes('.sort(compareCodeUnits)[0]'));

const oc = await ocFactory.default({ locateFile: () => resolve(vendorDirectory, 'replicad_single.wasm') });
rc.setOC(oc);
const importedRegistry = registryModule.createStudioImportedTopologyRegistry(rc);

const shapeEnum = {
  face: oc.TopAbs_ShapeEnum.TopAbs_FACE,
  edge: oc.TopAbs_ShapeEnum.TopAbs_EDGE,
  vertex: oc.TopAbs_ShapeEnum.TopAbs_VERTEX,
  shell: oc.TopAbs_ShapeEnum.TopAbs_SHELL,
  solid: oc.TopAbs_ShapeEnum.TopAbs_SOLID,
  wire: oc.TopAbs_ShapeEnum.TopAbs_WIRE,
} as const;
const slotOrientations = [
  oc.TopAbs_Orientation.TopAbs_FORWARD,
  oc.TopAbs_Orientation.TopAbs_REVERSED,
  oc.TopAbs_Orientation.TopAbs_INTERNAL,
  oc.TopAbs_Orientation.TopAbs_EXTERNAL,
];

function exactKind(shape: any, kind: keyof typeof shapeEnum): any[] {
  const explorer = new oc.TopExp_Explorer_2(
    shape.wrapped,
    shapeEnum[kind],
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  const wrappers: any[] = [];
  try {
    while (explorer.More()) {
      const current = explorer.Current();
      let wrapper: any = null;
      try {
        wrapper = rc.cast(current);
        if (wrappers.some((candidate) => candidate.wrapped.IsSame(wrapper.wrapped))) {
          wrapper.delete();
        } else {
          wrappers.push(wrapper);
          wrapper = null;
        }
      } finally {
        safeDelete(wrapper);
        current.delete();
      }
      explorer.Next();
    }
    return wrappers;
  } catch (error) {
    wrappers.forEach(safeDelete);
    throw error;
  } finally {
    explorer.delete();
  }
}

const analyticSurfaceTokenCounts = new Map([
  ['1', 13],
  ['2', 14],
  ['3', 14],
  ['4', 14],
  ['5', 15],
]);
const analyticCurve3dTokenCounts = new Map([
  ['2', 14],
  ['3', 15],
  ['4', 14],
  ['5', 15],
]);

function analyticSurfaceFrameRecords(brep: string, surfaceType?: string): string[][] {
  const records: string[][] = [];
  let inSurfaceSection = false;
  for (const line of brep.split('\n')) {
    const trimmed = line.trim();
    if (/^Surfaces\s+\d+$/.test(trimmed)) {
      inSurfaceSection = true;
      continue;
    }
    if (inSurfaceSection && /^Triangulations\s+\d+$/.test(trimmed)) break;
    if (!inSurfaceSection) continue;
    const tokens = trimmed.split(/\s+/);
    const expectedTokenCount = analyticSurfaceTokenCounts.get(tokens[0]!);
    if (expectedTokenCount === tokens.length
      && (!surfaceType || tokens[0] === surfaceType)
      && tokens.every((token) => Number.isFinite(Number(token)))) {
      records.push(tokens);
    }
  }
  return records;
}

function analyticCurve3dFrameRecords(brep: string, curveType?: string): string[][] {
  const records: string[][] = [];
  let inCurveSection = false;
  for (const line of brep.split('\n')) {
    const trimmed = line.trim();
    if (/^Curves\s+\d+$/.test(trimmed)) {
      inCurveSection = true;
      continue;
    }
    if (inCurveSection && /^Curve2ds\s+\d+$/.test(trimmed)) break;
    if (!inCurveSection) continue;
    const tokens = trimmed.split(/\s+/);
    const expectedTokenCount = analyticCurve3dTokenCounts.get(tokens[0]!);
    if (expectedTokenCount === tokens.length
      && (!curveType || tokens[0] === curveType)
      && tokens.every((token) => Number.isFinite(Number(token)))) {
      records.push(tokens);
    }
  }
  return records;
}

function makePlaneFrameDriftSweep(): any {
  const profileEdges = [
    rc.makeLine([-3, -2, 0], [3, -2, 0]),
    rc.makeLine([3, -2, 0], [3, 2, 0]),
    rc.makeLine([3, 2, 0], [-3, 2, 0]),
    rc.makeLine([-3, 2, 0], [-3, -2, 0]),
  ];
  let profile: any = null;
  let pathEdge: any = null;
  let path: any = null;
  let pipe: any = null;
  let law: any = null;
  let trimmedLaw: any = null;
  let progress: any = null;
  let shape: any = null;
  let rawShape: any = null;
  try {
    profile = rc.assembleWire(profileEdges);
    const bend = 14.202;
    const height = 38.977;
    const offset = 16.946;
    const scale = 0.743;
    pathEdge = rc.makeBSplineApproximation([
      [0, 0, 0],
      [0, 0, bend / 2],
      [0, 0, bend],
      [offset / 3, 0, bend + (height - bend) / 3],
      [offset, 0, height],
    ], { tolerance: 1e-4, degMax: 5 });
    path = rc.assembleWire([pathEdge]);
    pipe = new oc.BRepOffsetAPI_MakePipeShell(path.wrapped);
    pipe.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
    pipe.SetMode_1(false);
    law = new oc.Law_Linear();
    law.Set(0, 1, path.length, scale);
    trimmedLaw = law.Trim(0, path.length, 1e-6);
    pipe.SetLaw_1(profile.wrapped, trimmedLaw, false, true);
    progress = new oc.Message_ProgressRange_1();
    pipe.Build(progress);
    pipe.MakeSolid();
    check('plane-frame drift regression Sweep completes', pipe.IsDone());
    rawShape = pipe.Shape();
    shape = rc.cast(rawShape);
    rawShape.delete();
    rawShape = null;
    const result = shape;
    shape = null;
    return result;
  } finally {
    safeDelete(rawShape);
    safeDelete(shape);
    safeDelete(progress);
    safeDelete(trimmedLaw);
    safeDelete(law);
    safeDelete(pipe);
    safeDelete(path);
    safeDelete(pathEdge);
    safeDelete(profile);
    profileEdges.forEach(safeDelete);
  }
}

const tiltedAnalyticAxis = [0.6105578, -0.7257188, -0.6645552];

function makeTiltedSphere(direction = tiltedAnalyticAxis): any {
  let axis: any = null;
  let maker: any = null;
  let rawShape: any = null;
  let shape: any = null;
  try {
    axis = rc.makeAx2([1, 2, 3], direction);
    maker = new oc.BRepPrimAPI_MakeSphere_9(axis, 3);
    rawShape = maker.Shape();
    shape = rc.cast(rawShape);
    rawShape.delete();
    rawShape = null;
    const result = shape;
    shape = null;
    return result;
  } finally {
    safeDelete(shape);
    safeDelete(rawShape);
    safeDelete(maker);
    safeDelete(axis);
  }
}

function makeTiltedTorus(direction = tiltedAnalyticAxis): any {
  let axis: any = null;
  let maker: any = null;
  let rawShape: any = null;
  let shape: any = null;
  try {
    axis = rc.makeAx2([1, 2, 3], direction);
    maker = new oc.BRepPrimAPI_MakeTorus_5(axis, 5, 2);
    rawShape = maker.Shape();
    shape = rc.cast(rawShape);
    rawShape.delete();
    rawShape = null;
    const result = shape;
    shape = null;
    return result;
  } finally {
    safeDelete(shape);
    safeDelete(rawShape);
    safeDelete(maker);
    safeDelete(axis);
  }
}

function makeTiltedCone(): any {
  return rc.draw([2, 0])
    .lineTo([4, 8])
    .lineTo([0, 8])
    .lineTo([0, 0])
    .close()
    .sketchOnPlane('XZ')
    .revolve([0, 0, 1])
    .rotate(37, [0, 0, 0], [0.3, 0.5, 0.7]);
}

function completeNamedTables(shape: any, prefix: string): NamedTables {
  return {
    faces: exactKind(shape, 'face').map((face, index) => ({ name: `${prefix}-face-${index}`, face })),
    edges: exactKind(shape, 'edge').map((edge, index) => ({ name: `${prefix}-edge-${index}`, edge })),
    vertices: exactKind(shape, 'vertex').map((vertex, index) => ({ name: `${prefix}-vertex-${index}`, vertex })),
  };
}

function sortedNames(table: Array<{ name: string }>): string[] {
  return table.map((entry) => entry.name).sort();
}

function verifyAnalyticSurfaceCheckpoint(
  shape: any,
  label: string,
  surfaceType: '1' | '2' | '3' | '4' | '5',
): void {
  let names: NamedTables | null = null;
  let restored: RestoreOutcome | null = null;
  try {
    const rawRecords = analyticSurfaceFrameRecords(shape.serialize(), surfaceType);
    check(`${label} fixture contains the expected analytic surface record`, rawRecords.length > 0);

    const canonical = importedRegistry.canonicalBrep(shape);
    const canonicalRecords = analyticSurfaceFrameRecords(canonical, surfaceType);
    check(`${label} canonicalization retains every analytic surface record`,
      canonicalRecords.length === rawRecords.length);
    check(`${label} canonicalization preserves analytic surface origins exactly`,
      JSON.stringify(canonicalRecords.map((tokens) => tokens.slice(1, 4)))
      === JSON.stringify(rawRecords.map((tokens) => tokens.slice(1, 4))));
    check(`${label} canonicalization preserves analytic surface scalar parameters`,
      JSON.stringify(canonicalRecords.map((tokens) => tokens.slice(13)))
      === JSON.stringify(rawRecords.map((tokens) => tokens.slice(13))));
    const maxDirectionDelta = Math.max(0, ...canonicalRecords.flatMap((tokens, recordIndex) =>
      tokens.slice(4, 13).map((token, directionIndex) =>
        Math.abs(Number(token) - Number(rawRecords[recordIndex]![directionIndex + 4])))));
    check(`${label} analytic frame quantization stays within its kernel evidence bound`,
      maxDirectionDelta <= 2e-12);

    const canonicalShape = rc.deserializeShape(canonical);
    try {
      check(`${label} reaches an exact canonical BREP fixed point`,
        importedRegistry.canonicalBrep(canonicalShape) === canonical);
    } finally {
      canonicalShape.delete();
    }

    names = completeNamedTables(shape, label);
    const captured = importedRegistry.captureNamed({
      shape,
      registryId: `feature-checkpoint-${label}`,
      names,
    });
    restored = importedRegistry.restore({
      sourceBrep: captured.sourceBrep,
      registry: captured.registry,
      expectedRegistryRef: captured.featureReference,
    }) as RestoreOutcome;
    for (const tableKey of ['faces', 'edges', 'vertices'] as const) {
      check(`${label} checkpoint restores every ${tableKey} name exactly`,
        JSON.stringify(sortedNames(restored.names[tableKey]))
        === JSON.stringify(sortedNames(names[tableKey])));
    }
    check(`${label} restored shape retains the exact canonical source BREP`,
      importedRegistry.canonicalBrep(restored.shape) === captured.sourceBrep);
  } finally {
    if (restored) importedRegistry.disposeOutcome(restored);
    if (names) importedRegistry.disposeTables(names);
  }
}

function deterministicAnalyticAxes(count: number): number[][] {
  const axes: number[][] = [];
  let state = 0x51f15e5d;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000 * 2 - 1;
  };
  while (axes.length < count) {
    const candidate = [next(), next(), next()];
    const length = Math.hypot(...candidate);
    if (length > 0.2) axes.push(candidate.map((value) => value / length));
  }
  return axes;
}

function verifyCanonicalPhaseIndependence(shape: any, label: string): void {
  const canonical = importedRegistry.canonicalBrep(shape);
  const reopened = rc.deserializeShape(canonical);
  try {
    check(`${label} canonical evidence is independent of the OCCT cycle phase`,
      importedRegistry.canonicalBrep(reopened) === canonical);
  } finally {
    reopened.delete();
  }
}

function structuralMarkerSlot(marker: any, childKind: 'face' | 'edge'): number | null {
  const explorer = new oc.TopExp_Explorer_2(
    marker.wrapped,
    shapeEnum[childKind],
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  const counts = [0, 0, 0, 0];
  let representative: any = null;
  try {
    while (explorer.More()) {
      let current: any = explorer.Current();
      try {
        if (!representative) {
          representative = current;
          current = null;
        } else if (!representative.IsSame(current)) {
          return null;
        }
        const orientation = (current || representative).Orientation_1();
        const index = slotOrientations.findIndex((candidate) => candidate === orientation);
        if (index < 0) return null;
        counts[index] = (counts[index] ?? 0) + 1;
      } finally {
        safeDelete(current);
      }
      explorer.Next();
    }
    if (!representative || counts.some((count) => count < 1 || count > 16)) return null;
    return counts.reduce((slot, count, index) => slot + (count - 1) * 16 ** index, 0);
  } finally {
    safeDelete(representative);
    explorer.delete();
  }
}

function alteredCarrierBrep(
  carrierBrep: string,
  mode: 'duplicate-marker' | 'missing-marker',
): string {
  const carrier = rc.deserializeShape(carrierBrep);
  const shells = exactKind(carrier, 'shell');
  const wires = exactKind(carrier, 'wire');
  const solids = exactKind(carrier, 'solid');
  let builder: any = null;
  let wrapper: any = null;
  try {
    const sourceSolids = solids.filter((solid) => {
      const faces = exactKind(solid, 'face');
      try { return faces.length > 0; }
      finally { faces.forEach(safeDelete); }
    });
    check('carrier mutation fixture has one non-empty source solid', sourceSolids.length === 1);
    const markers = [
      ...shells.map((marker) => ({ marker, childKind: 'face' as const, slot: structuralMarkerSlot(marker, 'face') })),
      ...wires.map((marker) => ({ marker, childKind: 'edge' as const, slot: structuralMarkerSlot(marker, 'edge') })),
    ].filter((entry): entry is { marker: any; childKind: 'face' | 'edge'; slot: number } => entry.slot != null);
    check('carrier mutation fixture discovers every marker structurally', markers.length === 26);

    builder = new oc.TopoDS_Builder();
    const rawRoot = new oc.TopoDS_Compound();
    builder.MakeCompound(rawRoot);
    builder.Add(rawRoot, sourceSolids[0]!.wrapped);
    const omitted = markers[0]!;
    for (const entry of markers) {
      if (mode === 'missing-marker' && entry === omitted) continue;
      builder.Add(rawRoot, entry.marker.wrapped);
    }
    if (mode === 'duplicate-marker') {
      const duplicate = omitted.childKind === 'face' ? new oc.TopoDS_Shell() : new oc.TopoDS_Wire();
      try {
        if (omitted.childKind === 'face') builder.MakeShell(duplicate);
        else builder.MakeWire(duplicate);
        const explorer = new oc.TopExp_Explorer_2(
          omitted.marker.wrapped,
          shapeEnum[omitted.childKind],
          oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
        );
        try {
          while (explorer.More()) {
            const occurrence = explorer.Current();
            try { builder.Add(duplicate, occurrence); }
            finally { occurrence.delete(); }
            explorer.Next();
          }
        } finally {
          explorer.delete();
        }
        builder.Add(rawRoot, duplicate);
      } finally {
        duplicate.delete();
      }
    }
    wrapper = rc.cast(rawRoot);
    rawRoot.delete();
    return wrapper.serialize();
  } finally {
    safeDelete(wrapper);
    safeDelete(builder);
    solids.forEach(safeDelete);
    wires.forEach(safeDelete);
    shells.forEach(safeDelete);
    carrier.delete();
  }
}

const original = rc.makeBox([0, 0, 0], [11, 7, 5]);
let captured: any = null;
let namedCaptured: any = null;
let namedRestored: RestoreOutcome | null = null;
let compoundNamedCaptured: any = null;
let compoundNamedRestored: RestoreOutcome | null = null;
let compoundRoot: any = null;
let first: RestoreOutcome | null = null;
let reopened: RestoreOutcome | null = null;
let independentBody: any = null;
let independentFace: any = null;
let driftSweep: any = null;
let driftCaptured: any = null;
let driftRestored: RestoreOutcome | null = null;
let driftNames: NamedTables | null = null;
let tinyOriginBox: any = null;
let tinyTiltBox: any = null;
let tiltedCylinder: any = null;
let tiltedSphere: any = null;
let tiltedTorus: any = null;
let tiltedCone: any = null;
let analyticAxisCorpusModels = 0;
let analyticAxisCarrierModels = 0;
try {
  driftSweep = makePlaneFrameDriftSweep();
  driftNames = {
    faces: exactKind(driftSweep, 'face').map((face, index) => ({ name: `drift-face-${index}`, face })),
    edges: exactKind(driftSweep, 'edge').map((edge, index) => ({ name: `drift-edge-${index}`, edge })),
    vertices: exactKind(driftSweep, 'vertex').map((vertex, index) => ({ name: `drift-vertex-${index}`, vertex })),
  };
  driftCaptured = importedRegistry.captureNamed({
    shape: driftSweep,
    registryId: 'feature-checkpoint-plane-frame-drift',
    names: driftNames,
  });
  const driftReopenedSource = rc.deserializeShape(driftCaptured.sourceBrep);
  try {
    check('Sweep plane-frame roundoff reaches an exact canonical BREP fixed point',
      importedRegistry.canonicalBrep(driftReopenedSource) === driftCaptured.sourceBrep);
  } finally {
    driftReopenedSource.delete();
  }
  driftRestored = importedRegistry.restore({
    sourceBrep: driftCaptured.sourceBrep,
    registry: driftCaptured.registry,
    expectedRegistryRef: driftCaptured.featureReference,
  }) as RestoreOutcome;
  check('Sweep plane-frame checkpoint restores complete F/E/V identity',
    driftRestored.names.faces.length === driftNames.faces.length
    && driftRestored.names.edges.length === driftNames.edges.length
    && driftRestored.names.vertices.length === driftNames.vertices.length);

  tiltedCylinder = rc.makeCylinder(3, 8, [1, 2, 3], tiltedAnalyticAxis);
  verifyAnalyticSurfaceCheckpoint(tiltedCylinder, 'tilted-cylinder', '2');
  const rawCylinderCurves = analyticCurve3dFrameRecords(tiltedCylinder.serialize(), '2');
  const canonicalCylinderCurves = analyticCurve3dFrameRecords(
    importedRegistry.canonicalBrep(tiltedCylinder),
    '2',
  );
  check('tilted-cylinder fixture contains circular gp_Ax2 curve records', rawCylinderCurves.length > 0);
  check('analytic curve canonicalization preserves circle radii exactly',
    JSON.stringify(canonicalCylinderCurves.map((tokens) => tokens.slice(13)))
    === JSON.stringify(rawCylinderCurves.map((tokens) => tokens.slice(13))));
  tiltedSphere = makeTiltedSphere();
  verifyAnalyticSurfaceCheckpoint(tiltedSphere, 'tilted-sphere', '4');
  tiltedTorus = makeTiltedTorus();
  verifyAnalyticSurfaceCheckpoint(tiltedTorus, 'tilted-torus', '5');
  tiltedCone = makeTiltedCone();
  verifyAnalyticSurfaceCheckpoint(tiltedCone, 'tilted-cone', '3');

  for (const [axisIndex, direction] of deterministicAnalyticAxes(32).entries()) {
    for (const [kind, surfaceType, factory] of [
      ['cylinder', '2', () => rc.makeCylinder(3, 8, [1, 2, 3], direction)],
      ['sphere', '4', () => makeTiltedSphere(direction)],
      ['torus', '5', () => makeTiltedTorus(direction)],
    ] as const) {
      const shape = factory();
      try {
        verifyCanonicalPhaseIndependence(shape, `analytic-axis-${axisIndex}-${kind}`);
        analyticAxisCorpusModels++;
        if (axisIndex < 4) {
          verifyAnalyticSurfaceCheckpoint(
            shape,
            `analytic-axis-carrier-${axisIndex}-${kind}`,
            surfaceType,
          );
          analyticAxisCarrierModels++;
        }
      } finally {
        shape.delete();
      }
    }
  }

  tinyOriginBox = rc.makeBox([1e-15, 0, 0], [1.000000000000001, 2, 3]);
  const tinyOriginCanonical = importedRegistry.canonicalBrep(tinyOriginBox);
  check('canonicalization preserves legitimate tiny model coordinates',
    analyticSurfaceFrameRecords(tinyOriginCanonical, '1').some((tokens) =>
      tokens.slice(1, 4).some((token) => {
        const value = Math.abs(Number(token));
        return value > 0 && value < 1e-14;
      })));

  tinyTiltBox = rc.makeBox([0, 0, 0], [1, 2, 3]);
  tinyTiltBox = tinyTiltBox.rotate(1e-10, [0, 0, 0], [0, 0, 1]);
  const tinyTiltCanonical = importedRegistry.canonicalBrep(tinyTiltBox);
  check('canonicalization preserves above-grid plane-frame direction components',
    analyticSurfaceFrameRecords(tinyTiltCanonical, '1').some((tokens) =>
      tokens.slice(4).some((token) => {
        const value = Math.abs(Number(token));
        return value > 1e-12 && value < 1e-11;
      })));

  captured = importedRegistry.capture({
    shape: original,
    registryId: 'resource-step-main',
  });
  const capturedSource = rc.deserializeShape(captured.sourceBrep);
  try {
    check('capture stores a canonical exact source BREP fixed point',
      captured.sourceBrep === importedRegistry.canonicalBrep(capturedSource));
  } finally {
    capturedSource.delete();
  }
  check('resource registry is schema version one',
    captured.registry.schema === registryModule.IMPORTED_TOPOLOGY_REGISTRY_SCHEMA
    && captured.registry.version === registryModule.IMPORTED_TOPOLOGY_REGISTRY_VERSION);
  check('feature metadata references the exact resource registry',
    JSON.stringify(captured.featureReference) === JSON.stringify({
      schema: registryModule.IMPORTED_TOPOLOGY_REGISTRY_SCHEMA,
      version: registryModule.IMPORTED_TOPOLOGY_REGISTRY_VERSION,
      registryId: 'resource-step-main',
    }));
  check('capture persists six opaque face names',
    captured.registry.entries.filter((entry: any) => entry.kind === 'face').length === 6);
  check('capture persists twelve opaque edge names',
    captured.registry.entries.filter((entry: any) => entry.kind === 'edge').length === 12);
  check('capture persists eight opaque vertex names',
    captured.registry.entries.filter((entry: any) => entry.kind === 'vertex').length === 8);
  check('persistent names are opaque resource metadata, not geometry descriptions',
    captured.registry.entries.every((entry: any) => entry.name.includes(':opaque:')));

  first = importedRegistry.restore({
    sourceBrep: captured.sourceBrep,
    registry: captured.registry,
    expectedRegistryRef: captured.featureReference,
  }) as RestoreOutcome;
  check('restore has no diagnostics', first.diagnostics.length === 0);
  check('restore returns the referenced registry ID', first.registryId === 'resource-step-main');
  check('restore returns exact source evidence', first.sourceEvidence === captured.sourceBrep);
  check('restore has complete face coverage', first.names.faces.length === 6);
  check('restore has complete edge coverage', first.names.edges.length === 12);
  check('restore has complete vertex coverage', first.names.vertices.length === 8);

  const suppliedNames = {
    faces: first.names.faces.map((entry, index) => ({ name: `semantic-face-${index}`, face: entry.face })),
    edges: first.names.edges.map((entry, index) => ({ name: `semantic-edge-${index}`, edge: entry.edge })),
    vertices: first.names.vertices.map((entry, index) => ({ name: `semantic-vertex-${index}`, vertex: entry.vertex })),
  };
  namedCaptured = importedRegistry.captureNamed({
    shape: first.shape,
    registryId: 'feature-checkpoint-semantic-names',
    names: suppliedNames,
  });
  check('named capture declares supplied persistent-name mode',
    namedCaptured.registry.nameMode === 'provided-persistent-names-v1');
  namedRestored = importedRegistry.restore({
    sourceBrep: namedCaptured.sourceBrep,
    registry: namedCaptured.registry,
    expectedRegistryRef: namedCaptured.featureReference,
  }) as RestoreOutcome;
  for (const tableKey of ['faces', 'edges', 'vertices'] as const) {
    check(`named carrier restores arbitrary ${tableKey} exactly`,
      JSON.stringify(namedRestored.names[tableKey].map((entry) => entry.name).sort())
      === JSON.stringify(suppliedNames[tableKey].map((entry) => entry.name).sort()));
  }

  const compoundBuilder = new oc.TopoDS_Builder();
  const rawCompound = new oc.TopoDS_Compound();
  try {
    compoundBuilder.MakeCompound(rawCompound);
    compoundBuilder.Add(rawCompound, first.shape.wrapped);
    compoundRoot = rc.cast(rawCompound);
    compoundNamedCaptured = importedRegistry.captureNamed({
      shape: compoundRoot,
      registryId: 'feature-checkpoint-compound-root',
      names: suppliedNames,
    });
    compoundNamedRestored = importedRegistry.restore({
      sourceBrep: compoundNamedCaptured.sourceBrep,
      registry: compoundNamedCaptured.registry,
      expectedRegistryRef: compoundNamedCaptured.featureReference,
    }) as RestoreOutcome;
    check('named carrier preserves an exact one-solid compound root',
      compoundNamedRestored.shape.wrapped.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_COMPOUND
      && importedRegistry.canonicalBrep(compoundNamedRestored.shape) === compoundNamedCaptured.sourceBrep);
  } finally {
    rawCompound.delete();
    compoundBuilder.delete();
  }

  const saveEnvelope = JSON.stringify({
    resource: {
      data: captured.sourceBrep,
      extensions: { studioImportedStep: { topologyRegistry: captured.registry } },
    },
    feature: {
      extensions: { studioImportedStep: { topologyRegistry: captured.featureReference } },
    },
  });
  const loadedEnvelope = JSON.parse(saveEnvelope);
  reopened = importedRegistry.restore({
    sourceBrep: loadedEnvelope.resource.data,
    registry: loadedEnvelope.resource.extensions.studioImportedStep.topologyRegistry,
    expectedRegistryRef: loadedEnvelope.feature.extensions.studioImportedStep.topologyRegistry,
  }) as RestoreOutcome;

  const namesOf = (outcome: RestoreOutcome) => ({
    faces: outcome.names.faces.map((entry) => entry.name).sort(),
    edges: outcome.names.edges.map((entry) => entry.name).sort(),
    vertices: outcome.names.vertices.map((entry) => entry.name).sort(),
  });
  check('save/reopen preserves every persistent topology name deterministically',
    JSON.stringify(namesOf(reopened)) === JSON.stringify(namesOf(first)));
  check('save/reopen preserves canonical exact BREP deterministically',
    importedRegistry.canonicalBrep(reopened.shape) === captured.sourceBrep);

  for (const [kind, tableKey, wrapperKey] of [
    ['face', 'faces', 'face'],
    ['edge', 'edges', 'edge'],
    ['vertex', 'vertices', 'vertex'],
  ] as const) {
    const candidates = kind === 'face'
      ? importedRegistry.exactFaces(reopened.shape)
      : kind === 'edge'
        ? importedRegistry.exactEdges(reopened.shape)
        : importedRegistry.exactVertices(reopened.shape);
    try {
      const table = reopened.names[tableKey];
      check(`${kind} persistent names are one-to-one`, new Set(table.map((entry) => entry.name)).size === candidates.length);
      check(`${kind} entries resolve only by IsSame within the shared carrier`, candidates.every((candidate: any) =>
        table.filter((entry: any) => candidate.wrapped.IsSame(entry[wrapperKey].wrapped)).length === 1));
    } finally {
      importedRegistry.disposeWrappers(candidates);
    }
  }

  // This is the failure mode the carrier solves: identical independently read
  // BREP text does not preserve TopoDS_TShape identity.
  independentBody = rc.deserializeShape(captured.sourceBrep);
  check('a separately deserialized body is not IsSame', !independentBody.wrapped.IsSame(reopened.shape.wrapped));
  const independentFaces = importedRegistry.exactFaces(independentBody);
  try {
    const serializedNamedFace = reopened.names.faces[0]!.face.serialize();
    independentFace = rc.deserializeShape(serializedNamedFace);
    check('a separately deserialized face is not IsSame its registry face',
      !independentFace.wrapped.IsSame(reopened.names.faces[0]!.face.wrapped));
    check('no independently deserialized body face is IsSame a carrier face',
      independentFaces.every((face: any) => !face.wrapped.IsSame(reopened!.names.faces[0]!.face.wrapped)));
  } finally {
    importedRegistry.disposeWrappers(independentFaces);
  }

  const replacement = rc.makeBox([0, 0, 0], [12, 7, 5]);
  try {
    const replacementBrep = importedRegistry.canonicalBrep(replacement);
    try {
      importedRegistry.restore({
        sourceBrep: replacementBrep,
        registry: captured.registry,
        expectedRegistryRef: captured.featureReference,
      });
      throw new Error('stale registry was accepted for replacement BREP');
    } catch (error: any) {
      check('same-topology-count replacement BREP fails closed with an explicit diagnostic',
        error?.code === registryModule.IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.sourceMismatch
        && error?.diagnostics?.[0]?.reason === 'full-canonical-brep-evidence-mismatch');
    }
  } finally {
    replacement.delete();
  }

  const staleReference = { ...captured.featureReference, registryId: 'resource-step-other' };
  try {
    importedRegistry.restore({
      sourceBrep: captured.sourceBrep,
      registry: captured.registry,
      expectedRegistryRef: staleReference,
    });
    throw new Error('mismatched feature reference was accepted');
  } catch (error: any) {
    check('feature/resource registry mismatch fails closed with an explicit diagnostic',
      error?.code === registryModule.IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.registryMismatch
      && error?.diagnostics?.[0]?.reason === 'feature-resource-registry-reference-mismatch');
  }

  const missingSlotRegistry = structuredClone(captured.registry);
  missingSlotRegistry.entries[0].slot = 65535;
  missingSlotRegistry.entries[0].opaqueToken = (65535).toString(36).padStart(4, '0');
  missingSlotRegistry.entries[0].name = registryModule.importedTopologyPersistentName(
    missingSlotRegistry.registryId,
    missingSlotRegistry.entries[0].kind,
    missingSlotRegistry.entries[0].opaqueToken,
  );
  try {
    importedRegistry.restore({
      sourceBrep: captured.sourceBrep,
      registry: missingSlotRegistry,
      expectedRegistryRef: captured.featureReference,
    });
    throw new Error('missing carrier slot was accepted');
  } catch (error: any) {
    check('stale slot metadata fails closed with an explicit provenance diagnostic',
      error?.code === registryModule.IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.missingProvenance
      && error?.diagnostics?.[0]?.reason === 'unregistered-carrier-slot');
  }

  const swappedNameRegistry = structuredClone(captured.registry);
  [swappedNameRegistry.entries[0].name, swappedNameRegistry.entries[1].name] =
    [swappedNameRegistry.entries[1].name, swappedNameRegistry.entries[0].name];
  try {
    importedRegistry.restore({
      sourceBrep: captured.sourceBrep,
      registry: swappedNameRegistry,
      expectedRegistryRef: captured.featureReference,
    });
    throw new Error('permuted persistent names were accepted');
  } catch (error: any) {
    check('metadata name permutation cannot silently retarget exact topology',
      error?.code === registryModule.IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidRegistry
      && error?.diagnostics?.[0]?.reason === 'persistent-name-marker-token-mismatch');
  }

  for (const [mode, expectedCount] of [
    ['duplicate-marker', 27],
    ['missing-marker', 25],
  ] as const) {
    const alteredRegistry = structuredClone(captured.registry);
    alteredRegistry.carrierBrep = alteredCarrierBrep(captured.registry.carrierBrep, mode);
    try {
      importedRegistry.restore({
        sourceBrep: captured.sourceBrep,
        registry: alteredRegistry,
        expectedRegistryRef: captured.featureReference,
      });
      throw new Error(`${mode} carrier was accepted`);
    } catch (error: any) {
      check(`${mode} fails closed before any positional remapping`,
        error?.code === registryModule.IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.incompleteCoverage
        && error?.diagnostics?.[0]?.reason === 'carrier-marker-count-mismatch'
        && error?.diagnostics?.[0]?.markerCount === expectedCount);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    registrySchema: captured.registry.schema,
    exactTopology: { faces: 6, edges: 12, vertices: 8 },
    storageBytes: { sourceBrep: captured.sourceBrep.length, carrierBrep: captured.registry.carrierBrep.length },
    saveReopen: 'deterministic',
    namedCheckpointCarrier: {
      nameMode: namedCaptured.registry.nameMode,
      exactTopology: namedCaptured.registry.topologyCounts,
      compoundRoot: compoundNamedCaptured.registry.sourceRootKind,
    },
    analyticSurfaceFrameCanonicalization: {
      sweepCheckpoint: 'fixed-point',
      checkpoints: ['cylinder', 'cone', 'sphere', 'torus'],
      arbitraryAxisModels: analyticAxisCorpusModels,
      arbitraryAxisCarriers: analyticAxisCarrierModels,
      directionGrid: 1e-12,
      tinyOrigin: 'preserved',
      aboveGridDirection: 'preserved',
    },
    independentlyDeserializedIsSame: false,
    identityInputs: ['shared-carrier IsSame', 'persisted structural slot', 'full canonical source BREP equality'],
    rejectedFallbacks: ['geometry', 'proximity', 'HashCode', 'explorer-order remapping', 'separately-deserialized IsSame'],
    failClosedDiagnostics: [
      registryModule.IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidRegistry,
      registryModule.IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.sourceMismatch,
      registryModule.IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.registryMismatch,
      registryModule.IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.missingProvenance,
      registryModule.IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.incompleteCoverage,
    ],
  }));
} finally {
  safeDelete(independentFace);
  safeDelete(independentBody);
  safeDelete(tinyTiltBox);
  safeDelete(tinyOriginBox);
  safeDelete(tiltedCone);
  safeDelete(tiltedTorus);
  safeDelete(tiltedSphere);
  safeDelete(tiltedCylinder);
  if (driftNames) importedRegistry.disposeTables(driftNames);
  if (driftRestored) importedRegistry.disposeOutcome(driftRestored);
  safeDelete(driftSweep);
  safeDelete(compoundRoot);
  if (compoundNamedRestored) importedRegistry.disposeOutcome(compoundNamedRestored);
  if (namedRestored) importedRegistry.disposeOutcome(namedRestored);
  if (reopened) importedRegistry.disposeOutcome(reopened);
  if (first) importedRegistry.disposeOutcome(first);
  original.delete();
}
