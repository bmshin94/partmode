import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface NameEntry {
  name: string;
  face: any;
}

interface EdgeNameEntry {
  name: string;
  edge: any;
}

interface OffsetOutcome {
  shape: any;
  names: NameEntry[];
  diagnostics: Array<Record<string, unknown>>;
}

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Offset feature history smoke failed: ${name}`);
}

function closeTo(actual: number, expected: number, tolerance = 1e-6): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function safeDelete(value: any): void {
  try { value?.delete?.(); } catch {}
}

function deleteAll(values: any[]): void {
  for (const value of values || []) safeDelete(value);
}

function centerOf(shape: any): [number, number, number] {
  const center = shape.center;
  try { return [center.x ?? center[0], center.y ?? center[1], center.z ?? center[2]]; }
  finally { safeDelete(center); }
}

const root = process.cwd();
const vendorDir = resolve(root, 'src/static/vendor');
const nodeGlobals = globalThis as typeof globalThis & {
  require: ReturnType<typeof createRequire>;
  __dirname: string;
};
nodeGlobals.require = createRequire(import.meta.url);
nodeGlobals.__dirname = vendorDir;

const rc = await import(pathToFileURL(resolve(vendorDir, 'replicad.module.js')).href) as any;
const ocFactory = await import(pathToFileURL(resolve(vendorDir, 'replicad-oc.module.js')).href) as any;
const oc = await ocFactory.default({ locateFile: () => resolve(vendorDir, 'replicad_single.wasm') });
rc.setOC(oc);

const historyModule = await import(pathToFileURL(resolve(root, 'src/static/studio-offset-feature-history.js')).href) as any;
const history = historyModule.createStudioOffsetFeatureHistory(rc);

function validateSolid(label: string, shape: any): void {
  const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
  try {
    check(`${label} is an exact valid B-rep`, analyzer.IsValid_2());
    check(`${label} has positive volume`, rc.measureVolume(shape) > 1e-8);
  } finally {
    analyzer.delete();
  }
}

function exactFaceCount(shape: any): number {
  const faces = history.exactFaces(shape);
  try { return faces.length; }
  finally { history.disposeWrappers(faces); }
}

function semanticBoxFaceTable(shape: any, size: [number, number, number]): NameEntry[] {
  const faces = history.exactFaces(shape);
  const table: NameEntry[] = [];
  try {
    for (const face of faces) {
      const center = centerOf(face);
      const choices: Array<{ name: string; distance: number }> = [
        { name: 'Fstock:x:min', distance: Math.abs(center[0]) },
        { name: 'Fstock:x:max', distance: Math.abs(center[0] - size[0]) },
        { name: 'Fstock:y:min', distance: Math.abs(center[1]) },
        { name: 'Fstock:y:max', distance: Math.abs(center[1] - size[1]) },
        { name: 'Fstock:z:min', distance: Math.abs(center[2]) },
        { name: 'Fstock:z:max', distance: Math.abs(center[2] - size[2]) },
      ].sort((left, right) => left.distance - right.distance);
      check('box face has a unique semantic plane', choices[0]!.distance < 1e-6 && choices[1]!.distance > 1e-6);
      table.push({ name: choices[0]!.name, face: face.clone() });
    }
  } finally {
    history.disposeWrappers(faces);
  }
  check('box has six semantic face names', table.length === 6 && new Set(table.map((entry) => entry.name)).size === 6);
  return table;
}

function faceNamed(table: NameEntry[], name: string): any {
  const matches = table.filter((entry) => entry.name === name);
  check(`${name} occurs exactly once`, matches.length === 1);
  return matches[0]!.face;
}

function semanticTopBoundaryEdges(topFace: any, size: [number, number, number]): EdgeNameEntry[] {
  const edges = history.exactEdges(topFace);
  const table: EdgeNameEntry[] = [];
  try {
    for (const edge of edges) {
      const midpoint = edge.pointAt(0.5);
      const point: [number, number, number] = [midpoint.x, midpoint.y, midpoint.z];
      safeDelete(midpoint);
      const choices: Array<{ name: string; distance: number }> = [
        { name: 'Estock:top:y:min', distance: Math.abs(point[1]) },
        { name: 'Estock:top:y:max', distance: Math.abs(point[1] - size[1]) },
        { name: 'Estock:top:x:min', distance: Math.abs(point[0]) },
        { name: 'Estock:top:x:max', distance: Math.abs(point[0] - size[0]) },
      ].sort((left, right) => left.distance - right.distance);
      check('top boundary edge has a unique semantic side', choices[0]!.distance < 1e-6 && choices[1]!.distance > 1e-6);
      table.push({ name: choices[0]!.name, edge: edge.clone() });
    }
  } finally {
    history.disposeWrappers(edges);
  }
  check('top face has four stable boundary edge names', table.length === 4 && new Set(table.map((entry) => entry.name)).size === 4);
  return table;
}

function sortedNames(outcome: OffsetOutcome): string[] {
  return outcome.names.map((entry) => entry.name).sort();
}

function exactNamed(outcome: OffsetOutcome, name: string): any {
  const matches = outcome.names.filter((entry) => entry.name === name);
  check(`${name} resolves to one exact result face`, matches.length === 1);
  return matches[0]!.face;
}

function checkComplete(label: string, outcome: OffsetOutcome): void {
  validateSolid(label, outcome.shape);
  const count = exactFaceCount(outcome.shape);
  check(`${label} has complete named-face coverage`, outcome.names.length === count);
  check(`${label} has one unique persistent name per face`, new Set(sortedNames(outcome)).size === count);
  check(`${label} has no topology diagnostics`, outcome.diagnostics.length === 0);
}

function shellBuild(
  size: [number, number, number],
  thickness: number,
  serializedSource?: string,
): { outcome: OffsetOutcome; shape: any; faceTable: NameEntry[]; size: [number, number, number]; thickness: number } {
  const shape = serializedSource ? rc.deserializeShape(serializedSource) : rc.makeBox([0, 0, 0], size);
  const faceTable = semanticBoxFaceTable(shape, size);
  const opening = faceNamed(faceTable, 'Fstock:z:max');
  try {
    const outcome = history.shellWithHistory({
      shape,
      openingFaces: [opening],
      faceTable,
      featureId: 'shell-main',
      thickness: -thickness,
    }) as OffsetOutcome;
    return { outcome, shape, faceTable, size, thickness };
  } catch (error) {
    history.disposeTable(faceTable);
    shape.delete();
    throw error;
  }
}

function thickenBuild(
  size: [number, number, number],
  thickness: number,
  serializedSource?: string,
  symmetric = true,
): {
  outcome: OffsetOutcome;
  shape: any;
  faceTable: NameEntry[];
  edgeTable: EdgeNameEntry[];
  size: [number, number, number];
  thickness: number;
  symmetric: boolean;
} {
  const shape = serializedSource ? rc.deserializeShape(serializedSource) : rc.makeBox([0, 0, 0], size);
  const faceTable = semanticBoxFaceTable(shape, size);
  const sourceFace = faceNamed(faceTable, 'Fstock:z:max');
  const edgeTable = semanticTopBoundaryEdges(sourceFace, size);
  try {
    const outcome = history.planarThickenWithHistory({
      sourceFace,
      sourceFaceName: 'Fstock:z:max',
      boundaryEdgeTable: edgeTable,
      featureId: 'thicken-main',
      direction: [0, 0, 1],
      thickness,
      symmetric,
    }) as OffsetOutcome;
    return { outcome, shape, faceTable, edgeTable, size, thickness, symmetric };
  } catch (error) {
    deleteAll(edgeTable.map((entry) => entry.edge));
    history.disposeTable(faceTable);
    shape.delete();
    throw error;
  }
}

const results: Record<string, unknown> = {};

// Shell: exact source serialization/reopen, source-size edit, and thickness
// edit must retain one semantic name set. The opening's old name must vanish;
// every new offset/transition face receives feature-derived provenance.
{
  const source = rc.makeBox([0, 0, 0], [10, 12, 8]);
  const serialized = source.serialize();
  source.delete();
  const builds = [
    shellBuild([10, 12, 8], 1),
    shellBuild([10, 12, 8], 1, serialized),
    shellBuild([14, 16, 11], 1),
    shellBuild([14, 16, 11], 1.5),
  ];
  try {
    for (const [index, build] of builds.entries()) checkComplete(`shell build ${index}`, build.outcome);
    const expected = sortedNames(builds[0]!.outcome);
    for (const [index, build] of builds.entries()) {
      check(`shell build ${index} keeps the semantic name set`, JSON.stringify(sortedNames(build.outcome)) === JSON.stringify(expected));
      check(`shell build ${index} drops the removed opening name`, !build.outcome.names.some((entry) => entry.name === 'Fstock:z:max'));
      check(`shell build ${index} names new inner faces`, build.outcome.names.some((entry) => entry.name.includes(':shell:inner:')));
      check(`shell build ${index} names new rim faces`, build.outcome.names.some((entry) => entry.name.includes(':shell:rim:')));
      const sourceXMin = exactNamed(build.outcome, 'Fstock:x:min');
      const innerXMinName = historyModule.offsetFeatureFaceNames('shell-main', 'Fstock:x:min').shellInner;
      const innerXMin = exactNamed(build.outcome, innerXMinName);
      check(`shell build ${index} does not retarget the surviving x-min wall`, closeTo(centerOf(sourceXMin)[0], 0));
      check(`shell build ${index} does not retarget the x-min inner offset`,
        closeTo(centerOf(innerXMin)[0], -build.thickness));
      const openingRimName = historyModule.shellRimOpeningFaceName('shell-main', 'Fstock:z:max');
      const openingRim = exactNamed(build.outcome, openingRimName);
      check(`shell build ${index} does not retarget the opening collar`,
        closeTo(centerOf(openingRim)[2], build.size[2]));
    }
    const reopenedResult = rc.deserializeShape(builds[0]!.outcome.shape.serialize());
    try { validateSolid('serialized shell result', reopenedResult); }
    finally { reopenedResult.delete(); }
    results.shell = { faceCount: expected.length, names: expected };
  } finally {
    for (const build of builds) {
      history.disposeTable(build.outcome.names);
      build.outcome.shape.delete();
      history.disposeTable(build.faceTable);
      build.shape.delete();
    }
  }
}

// Planar Thicken: start/end are tied to the persistent source face and every
// side is tied to a persistent source boundary edge. Reopen/edit cycles cannot
// change those names or silently target another face.
{
  const source = rc.makeBox([0, 0, 0], [9, 13, 6]);
  const serialized = source.serialize();
  source.delete();
  const builds = [
    thickenBuild([9, 13, 6], 2),
    thickenBuild([9, 13, 6], 2, serialized),
    thickenBuild([12, 17, 9], 2),
    thickenBuild([12, 17, 9], 3.5),
    thickenBuild([12, 17, 9], 2.25, undefined, false),
  ];
  try {
    for (const [index, build] of builds.entries()) checkComplete(`thicken build ${index}`, build.outcome);
    const expected = sortedNames(builds[0]!.outcome);
    check('planar Thicken has start, end, and four side names', expected.length === 6);
    check('planar Thicken has exactly one start name', expected.filter((name) => name.includes(':thicken:start:')).length === 1);
    check('planar Thicken has exactly one end name', expected.filter((name) => name.includes(':thicken:end:')).length === 1);
    check('planar Thicken has four persistent edge-derived side names', expected.filter((name) => name.includes(':thicken:side:')).length === 4);
    for (const [index, build] of builds.entries()) {
      check(`thicken build ${index} keeps the semantic name set`, JSON.stringify(sortedNames(build.outcome)) === JSON.stringify(expected));
      const semantic = historyModule.offsetFeatureFaceNames('thicken-main', 'Fstock:z:max');
      const start = exactNamed(build.outcome, semantic.thickenStart);
      const end = exactNamed(build.outcome, semantic.thickenEnd);
      const expectedStart = build.symmetric ? build.size[2] - build.thickness / 2 : build.size[2];
      check(`thicken build ${index} does not retarget its start face`,
        closeTo(centerOf(start)[2], expectedStart));
      check(`thicken build ${index} does not retarget its end face`,
        closeTo(centerOf(end)[2], expectedStart + build.thickness));
      const xMinSide = exactNamed(
        build.outcome,
        historyModule.thickenSideFaceName('thicken-main', 'Estock:top:x:min'),
      );
      check(`thicken build ${index} does not retarget the x-min boundary side`, closeTo(centerOf(xMinSide)[0], 0));
    }
    const reopenedResult = rc.deserializeShape(builds[0]!.outcome.shape.serialize());
    try { validateSolid('serialized planar Thicken result', reopenedResult); }
    finally { reopenedResult.delete(); }
    results.thicken = { faceCount: expected.length, names: expected };
  } finally {
    for (const build of builds) {
      history.disposeTable(build.outcome.names);
      build.outcome.shape.delete();
      deleteAll(build.edgeTable.map((entry) => entry.edge));
      history.disposeTable(build.faceTable);
      build.shape.delete();
    }
  }
}

// Offset outcomes must retain upstream topology diagnostics. A downstream
// feature may add provenance, but it cannot erase an earlier ambiguity.
{
  const marker = {
    severity: 'error',
    code: 'TOPOLOGY_NAMING_AMBIGUOUS_SUFFIX',
    reason: 'upstream-marker',
    topologyKind: 'face',
  };
  const shellShape = rc.makeBox([0, 0, 0], [10, 12, 8]);
  const shellFaces = semanticBoxFaceTable(shellShape, [10, 12, 8]) as NameEntry[] & {
    diagnostics?: Array<Record<string, unknown>>;
  };
  shellFaces.diagnostics = [marker];
  let shellOutcome: OffsetOutcome | null = null;
  const thickenShape = rc.makeBox([0, 0, 0], [9, 13, 6]);
  const thickenFaces = semanticBoxFaceTable(thickenShape, [9, 13, 6]);
  const thickenFace = faceNamed(thickenFaces, 'Fstock:z:max');
  const thickenEdges = semanticTopBoundaryEdges(thickenFace, [9, 13, 6]);
  let thickenOutcome: OffsetOutcome | null = null;
  try {
    shellOutcome = history.shellWithHistory({
      shape: shellShape,
      openingFaces: [faceNamed(shellFaces, 'Fstock:z:max')],
      faceTable: shellFaces,
      featureId: 'shell-diagnostic',
      thickness: -1,
    }) as OffsetOutcome;
    thickenOutcome = history.planarThickenWithHistory({
      sourceFace: thickenFace,
      sourceFaceName: 'Fstock:z:max',
      boundaryEdgeTable: thickenEdges,
      topologyDiagnostics: [marker],
      featureId: 'thicken-diagnostic',
      direction: [0, 0, 1],
      thickness: 2,
      symmetric: false,
    }) as OffsetOutcome;
    for (const [label, outcome] of [['shell', shellOutcome], ['thicken', thickenOutcome]] as const) {
      check(`${label} retains one upstream diagnostic`, outcome.diagnostics.length === 1);
      check(`${label} retains the upstream diagnostic code`, outcome.diagnostics[0]?.code === marker.code);
      check(
        `${label} attaches diagnostics to its owned name table`,
        (outcome.names as NameEntry[] & { diagnostics?: Array<Record<string, unknown>> }).diagnostics?.[0]?.code === marker.code,
      );
    }
    results.diagnosticPropagation = { shell: true, thicken: true };
  } finally {
    if (shellOutcome) {
      history.disposeTable(shellOutcome.names);
      shellOutcome.shape.delete();
    }
    if (thickenOutcome) {
      history.disposeTable(thickenOutcome.names);
      thickenOutcome.shape.delete();
    }
    deleteAll(thickenEdges.map((entry) => entry.edge));
    history.disposeTable(thickenFaces);
    thickenShape.delete();
    history.disposeTable(shellFaces);
    shellShape.delete();
  }
}

// Exact ambiguity is fail-closed. Two names for the same TopoDS edge must
// produce a structured error and no partially named result.
{
  const shape = rc.makeBox([0, 0, 0], [8, 10, 5]);
  const faceTable = semanticBoxFaceTable(shape, [8, 10, 5]);
  const sourceFace = faceNamed(faceTable, 'Fstock:z:max');
  const edgeTable = semanticTopBoundaryEdges(sourceFace, [8, 10, 5]);
  const ambiguousTable = [
    ...edgeTable,
    { name: 'Econflicting-name', edge: edgeTable[0]!.edge.clone() },
  ];
  let caught: any = null;
  try {
    history.planarThickenWithHistory({
      sourceFace,
      sourceFaceName: 'Fstock:z:max',
      boundaryEdgeTable: ambiguousTable,
      featureId: 'thicken-ambiguous',
      direction: [0, 0, 1],
      thickness: 2,
    });
  } catch (error) {
    caught = error;
  } finally {
    deleteAll(ambiguousTable.map((entry) => entry.edge));
    history.disposeTable(faceTable);
    shape.delete();
  }
  check('ambiguous exact edge provenance throws a structured error',
    caught?.code === historyModule.OFFSET_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance);
  check('ambiguous exact edge provenance includes a fail-closed diagnostic',
    Array.isArray(caught?.diagnostics)
      && caught.diagnostics[0]?.reason === 'multiple-names-for-exact-subshape');
  results.ambiguity = { code: caught.code, reason: caught.diagnostics[0].reason };
}

console.log(JSON.stringify(results));
