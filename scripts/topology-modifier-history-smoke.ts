import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface NameEntry {
  name: string;
  face: any;
}

interface ModifierOutcome {
  shape: any;
  names: NameEntry[];
}

interface TopologyNaming {
  disposeTable(table: NameEntry[]): void;
  transformWithNames(shape: any, transformation: any, table: NameEntry[]): ModifierOutcome;
  draftWithNames(shape: any, faces: any[], table: NameEntry[], angle: number, plane: any): ModifierOutcome;
  shellWithNames(shape: any, faces: any[], table: NameEntry[], thickness: number): ModifierOutcome;
}

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Topology modifier history smoke failed: ${name}`);
}

function closeTo(actual: number, expected: number, tolerance = 1e-6): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function centerOf(face: any): [number, number, number] {
  const center = face.center;
  return [center.x ?? center[0], center.y ?? center[1], center.z ?? center[2]];
}

function findFace(faces: any[], axis: 0 | 1 | 2, value: number): any {
  const face = faces.find((candidate) => closeTo(centerOf(candidate)[axis], value));
  check(`box has a face centered at axis ${axis} = ${value}`, face);
  return face;
}

function checkValidSolid(oc: any, rc: any, label: string, shape: any): void {
  const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
  try {
    check(`${label} is an exact valid B-rep`, analyzer.IsValid_2());
    check(`${label} has positive volume`, rc.measureVolume(shape) > 1e-8);
  } finally {
    analyzer.delete();
  }
}

function exactName(outcome: ModifierOutcome, name: string): NameEntry {
  check(`${name} survives exactly once`, outcome.names.filter((entry) => entry.name === name).length === 1);
  return outcome.names.find((entry) => entry.name === name)!;
}

function deleteAll(values: any[]): void {
  for (const value of values) {
    try { value?.delete?.(); } catch {}
  }
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
const topoModule = await import(pathToFileURL(resolve(root, 'src/static/studio-topo-naming.js')).href) as {
  createStudioTopoNaming(rc: any): TopologyNaming;
};
const topologySource = readFileSync(resolve(root, 'src/static/studio-topo-naming.js'), 'utf8');
const workerSource = readFileSync(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8');
const draftBranchStart = workerSource.indexOf("if (feature.type === 'draft')");
const shellBranchStart = workerSource.indexOf("if (feature.type === 'shell')", draftBranchStart);
const draftBranch = workerSource.slice(
  draftBranchStart,
  shellBranchStart,
);
const shellBranch = workerSource.slice(
  shellBranchStart,
  workerSource.indexOf('return null;', shellBranchStart),
);
const transformFunction = workerSource.slice(
  workerSource.indexOf('function applyStudioV5Transform('),
  workerSource.indexOf('function evaluatedSketchPoints('),
);
check('topology wrapper owns a raw OCCT transform builder', topologySource.includes('new oc.BRepBuilderAPI_Transform_2('));
check('topology wrapper owns a raw OCCT draft builder', topologySource.includes('new oc.BRepOffsetAPI_DraftAngle_2('));
check('topology wrapper checks every draft face Add', topologySource.includes('if (!builder.AddDone())'));
check('topology wrapper owns a raw OCCT thick-solid builder', topologySource.includes('new oc.BRepOffsetAPI_MakeThickSolid()'));
check('shell filters the selected opening from ordinary name propagation', topologySource.includes('const survivingTable = (faceTable || []).filter'));
check('worker draft uses history-aware naming', draftBranch.includes('topo.draftWithNames('));
check('worker draft no longer erases names', !draftBranch.includes('names: []'));
check('worker shell uses complete offset history naming', shellBranch.includes('offsetFeatureHistory.shellWithHistory({'));
check('worker shell no longer erases names', !shellBranch.includes('names: []'));
check('worker transform propagates source names at every step', transformFunction.includes('topo.transformWithNames(next, transformation, nextNames)'));
check('worker transform returns its propagated table', transformFunction.includes('return { shape: next, names: nextNames };'));
check('worker transform no longer erases names',
  !transformFunction.includes('nextNames = []') && !transformFunction.includes('names: []'));

const ocFactory = await import(pathToFileURL(resolve(vendorDir, 'replicad-oc.module.js')).href) as any;
const oc = await ocFactory.default({ locateFile: () => resolve(vendorDir, 'replicad_single.wasm') });
rc.setOC(oc);
const topology = topoModule.createStudioTopoNaming(rc);
const results: Record<string, unknown> = {};

{
  const shape = rc.makeBox([0, 0, 0], [10, 10, 10]);
  const faces = shape.faces;
  const sourceFace = findFace(faces, 0, 0);
  const table = [{ name: 'Fsource:transform-wall', face: sourceFace.clone() }];
  const transformation = new rc.Transformation();
  let outcome: ModifierOutcome | null = null;
  try {
    transformation.translate([5, 2, 1]);
    outcome = topology.transformWithNames(shape, transformation, table);
    checkValidSolid(oc, rc, 'transform result', outcome.shape);
    const propagated = exactName(outcome, 'Fsource:transform-wall');
    const center = centerOf(propagated.face);
    check('transform propagates the named face to its translated position',
      closeTo(center[0], 5) && closeTo(center[1], 7) && closeTo(center[2], 6));
    check('transform leaves its source shape immutable', closeTo(centerOf(sourceFace)[0], 0));
    results.transform = { names: outcome.names.map((entry) => entry.name), center };
  } finally {
    if (outcome) {
      topology.disposeTable(outcome.names);
      outcome.shape.delete();
    }
    topology.disposeTable(table);
    transformation.delete();
    deleteAll(faces);
    shape.delete();
  }
}

{
  const shape = rc.makeBox([0, 0, 0], [10, 10, 10]);
  const faces = shape.faces;
  const selectedFace = findFace(faces, 0, 10);
  const table = [{ name: 'Fsource:draft-wall', face: selectedFace.clone() }];
  const neutralPlane = new rc.Plane([0, 0, 0], [1, 0, 0], [0, 0, 1]);
  let outcome: ModifierOutcome | null = null;
  try {
    outcome = topology.draftWithNames(shape, [selectedFace], table, 5, neutralPlane);
    checkValidSolid(oc, rc, 'draft result', outcome.shape);
    const propagated = exactName(outcome, 'Fsource:draft-wall');
    const center = centerOf(propagated.face);
    check('draft propagates the selected face through Generated history',
      center[0] < 10 && center[0] > 9 && closeTo(center[1], 5) && closeTo(center[2], 5));
    results.draft = { names: outcome.names.map((entry) => entry.name), center };
  } finally {
    if (outcome) {
      topology.disposeTable(outcome.names);
      outcome.shape.delete();
    }
    topology.disposeTable(table);
    neutralPlane.delete();
    deleteAll(faces);
    shape.delete();
  }
}

{
  const shape = rc.makeBox([0, 0, 0], [10, 10, 10]);
  const faces = shape.faces;
  const openingFace = findFace(faces, 2, 10);
  const wallFace = findFace(faces, 0, 0);
  const table = [
    { name: 'Fsource:shell-opening', face: openingFace.clone() },
    { name: 'Fsource:shell-wall', face: wallFace.clone() },
  ];
  let outcome: ModifierOutcome | null = null;
  try {
    // PartMode passes a negative public thickness, which the Replicad-compatible
    // wrapper negates into the existing outward raw OCCT offset.
    outcome = topology.shellWithNames(shape, [openingFace], table, -1);
    checkValidSolid(oc, rc, 'shell result', outcome.shape);
    const propagated = exactName(outcome, 'Fsource:shell-wall');
    const center = centerOf(propagated.face);
    check('shell retains the unselected source wall without suffixing its name',
      closeTo(center[0], 0) && closeTo(center[1], 5) && closeTo(center[2], 5));
    check('shell does not reuse the removed opening name for a new rim face',
      !outcome.names.some((entry) => entry.name === 'Fsource:shell-opening'));
    results.shell = { names: outcome.names.map((entry) => entry.name), center };
  } finally {
    if (outcome) {
      topology.disposeTable(outcome.names);
      outcome.shape.delete();
    }
    topology.disposeTable(table);
    deleteAll(faces);
    shape.delete();
  }
}

console.log(JSON.stringify(results));
