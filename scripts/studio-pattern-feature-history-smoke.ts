import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type TopologyTables = {
  faces: Array<{ name: string; face: any }>;
  edges: Array<{ name: string; edge: any }>;
  vertices: Array<{ name: string; vertex: any }>;
};

type PatternOutcome = {
  shape: any;
  names: TopologyTables;
  diagnostics: Array<Record<string, unknown>>;
};

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Pattern feature history smoke failed: ${name}`);
}

function closeTo(actual: number, expected: number, tolerance = 1e-6): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function safeDelete(value: any): void {
  try { value?.delete?.(); } catch {}
}

function tupleKey(values: number[]): string {
  return values.map((value) => {
    const rounded = Math.round(value * 1e8) / 1e8;
    return Object.is(rounded, -0) ? '0' : String(rounded);
  }).join(',');
}

function centerOfFace(face: any): [number, number, number] {
  const center = face.center;
  try { return [center.x, center.y, center.z]; }
  finally { safeDelete(center); }
}

function centerOfEdge(edge: any): [number, number, number] {
  const point = edge.pointAt(0.5);
  try { return [point.x, point.y, point.z]; }
  finally { safeDelete(point); }
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
const historySource = readFileSync(resolve(root, 'src/static/studio-pattern-feature-history.js'), 'utf8');
check('implementation contains no display hash identity', !historySource.includes('.HashCode') && !historySource.includes('.hashCode'));
check('implementation contains no geometric identity lookup',
  !historySource.includes('.pointAt(') && !historySource.includes('.boundingBox') && !historySource.includes('measureDistance'));
check('implementation retains exact transform history', historySource.includes('builder.ModifiedShape(entry[wrapperKey].wrapped)'));
check('implementation retains exact boolean Modified history', historySource.includes('builder.Modified(record.wrapper.wrapped)'));
check('implementation retains exact boolean Generated history', historySource.includes('builder.Generated(record.wrapper.wrapped)'));
const module = await import(pathToFileURL(resolve(root, 'src/static/studio-pattern-feature-history.js')).href) as any;
const oc = await ocFactory.default({ locateFile: () => resolve(vendorDir, 'replicad_single.wasm') });
rc.setOC(oc);
const history = module.createStudioPatternFeatureHistory(rc);

function sourceTables(shape: any): TopologyTables {
  const faces = history.exactFaces(shape);
  const edges = history.exactEdges(shape);
  const vertices = history.exactVertices(shape);
  const tables: TopologyTables = { faces: [], edges: [], vertices: [] };
  try {
    tables.faces = faces.map((face: any) => ({
      name: `Fstock:${tupleKey(centerOfFace(face))}`,
      face: face.clone(),
    }));
    tables.edges = edges.map((edge: any) => ({
      name: `Estock:${tupleKey(centerOfEdge(edge))}`,
      edge: edge.clone(),
    }));
    tables.vertices = vertices.map((vertex: any) => ({
      name: `Vstock:${tupleKey(vertex.asTuple())}`,
      vertex: vertex.clone(),
    }));
  } finally {
    history.disposeWrappers(faces);
    history.disposeWrappers(edges);
    history.disposeWrappers(vertices);
  }
  check('fixture has six unique face names', tables.faces.length === 6 && new Set(tables.faces.map((entry) => entry.name)).size === 6);
  check('fixture has twelve unique edge names', tables.edges.length === 12 && new Set(tables.edges.map((entry) => entry.name)).size === 12);
  check('fixture has eight unique vertex names', tables.vertices.length === 8 && new Set(tables.vertices.map((entry) => entry.name)).size === 8);
  history.validateCompleteTables(shape, tables);
  return tables;
}

function checkValid(label: string, outcome: PatternOutcome): void {
  const analyzer = new oc.BRepCheck_Analyzer(outcome.shape.wrapped, true, false);
  try { check(`${label} is an exact valid B-rep`, analyzer.IsValid_2()); }
  finally { analyzer.delete(); }
  const faces = history.exactFaces(outcome.shape);
  const edges = history.exactEdges(outcome.shape);
  const vertices = history.exactVertices(outcome.shape);
  try {
    check(`${label} has complete face coverage`, outcome.names.faces.length === faces.length);
    check(`${label} has complete edge coverage`, outcome.names.edges.length === edges.length);
    check(`${label} has complete vertex coverage`, outcome.names.vertices.length === vertices.length);
    check(`${label} has unique face names`, new Set(outcome.names.faces.map((entry) => entry.name)).size === faces.length);
    check(`${label} has unique edge names`, new Set(outcome.names.edges.map((entry) => entry.name)).size === edges.length);
    check(`${label} has unique vertex names`, new Set(outcome.names.vertices.map((entry) => entry.name)).size === vertices.length);
    check(`${label} has no history diagnostics`, outcome.diagnostics.length === 0);
  } finally {
    history.disposeWrappers(faces);
    history.disposeWrappers(edges);
    history.disposeWrappers(vertices);
  }
  history.validateCompleteTables(outcome.shape, outcome.names);
}

function sortedNames(tables: TopologyTables): Record<string, string[]> {
  return {
    faces: tables.faces.map((entry) => entry.name).sort(),
    edges: tables.edges.map((entry) => entry.name).sort(),
    vertices: tables.vertices.map((entry) => entry.name).sort(),
  };
}

function exactNamedFace(outcome: PatternOutcome, name: string): any {
  const matches = outcome.names.faces.filter((entry) => entry.name === name);
  check(`${name} resolves to exactly one face`, matches.length === 1);
  return matches[0]!.face;
}

function exactNamedVertex(outcome: PatternOutcome, name: string): any {
  const matches = outcome.names.vertices.filter((entry) => entry.name === name);
  check(`${name} resolves to exactly one vertex`, matches.length === 1);
  return matches[0]!.vertex;
}

function disposeSource(shape: any, tables: TopologyTables): void {
  history.disposeTables(tables);
  shape.delete();
}

function buildLinear(serialized: string | null, spacing: number): {
  source: any;
  tables: TopologyTables;
  outcome: { instances: PatternOutcome[]; diagnostics: Array<Record<string, unknown>> };
} {
  const source = serialized ? rc.deserializeShape(serialized) : rc.makeBox([0, 0, 0], [4, 3, 2]);
  const tables = sourceTables(source);
  try {
    const outcome = history.patternInstancesWithHistory({
      sourceShape: source,
      sourceTables: tables,
      featureId: 'linear-main',
      // Deliberately reverse the declaration order. Stable instance IDs, not
      // array order, determine the returned order and persistent names.
      instances: [
        { instanceId: 'linear-2', transforms: [{ kind: 'translate', vector: [2 * spacing, 0, 0] }] },
        { instanceId: 'linear-1', transforms: [{ kind: 'translate', vector: [spacing, 0, 0] }] },
      ],
    }) as { instances: PatternOutcome[]; diagnostics: Array<Record<string, unknown>> };
    return { source, tables, outcome };
  } catch (error) {
    disposeSource(source, tables);
    throw error;
  }
}

const results: Record<string, unknown> = {};

// Linear patterns retain complete exact face/edge/vertex provenance through a
// save/reopen cycle and through spacing edits. A named source face must move to
// the intended instance, never another face with a similar signature.
{
  const pristine = rc.makeBox([0, 0, 0], [4, 3, 2]);
  const serialized = pristine.serialize();
  pristine.delete();
  const builds = [buildLinear(null, 7), buildLinear(serialized, 7), buildLinear(serialized, 9)];
  try {
    for (const [buildIndex, build] of builds.entries()) {
      check(`linear build ${buildIndex} sorts by stable instance ID`,
        (build.outcome.instances as any[]).map((entry) => entry.instanceId).join(',') === 'linear-1,linear-2');
      check(`linear build ${buildIndex} has no diagnostics`, build.outcome.diagnostics.length === 0);
      for (const [instanceIndex, instance] of build.outcome.instances.entries()) {
        checkValid(`linear build ${buildIndex} instance ${instanceIndex}`, instance);
      }
    }
    const baseline = builds[0]!.outcome.instances.map((entry) => sortedNames(entry.names));
    for (const build of builds) {
      check('linear name sets survive reopen and spacing edits',
        JSON.stringify(build.outcome.instances.map((entry) => sortedNames(entry.names))) === JSON.stringify(baseline));
    }
    const sourceFaceName = 'Fstock:4,1.5,1';
    for (const [buildIndex, build] of builds.entries()) {
      const spacing = buildIndex === 2 ? 9 : 7;
      for (const [index, instance] of build.outcome.instances.entries()) {
        const instanceId = `linear-${index + 1}`;
        const name = module.patternInstanceSubshapeName('linear-main', instanceId, 'face', sourceFaceName);
        const center = centerOfFace(exactNamedFace(instance, name));
        check(`linear ${instanceId} keeps the x-max source face after edit ${buildIndex}`,
          closeTo(center[0], 4 + spacing * (index + 1)) && closeTo(center[1], 1.5) && closeTo(center[2], 1));
      }
    }
    results.linear = { instances: 2, topologyPerInstance: { faces: 6, edges: 12, vertices: 8 } };
  } finally {
    for (const build of builds) {
      for (const instance of build.outcome.instances) history.disposeOutcome(instance);
      disposeSource(build.source, build.tables);
    }
  }
}

function buildCircular(serialized: string | null, angle: number): {
  source: any;
  tables: TopologyTables;
  outcome: { instances: PatternOutcome[]; diagnostics: Array<Record<string, unknown>> };
} {
  const source = serialized ? rc.deserializeShape(serialized) : rc.makeBox([8, 0, 0], [12, 3, 2]);
  const tables = sourceTables(source);
  try {
    const outcome = history.patternInstancesWithHistory({
      sourceShape: source,
      sourceTables: tables,
      featureId: 'circular-main',
      instances: [
        { instanceId: 'circular-a', transforms: [{ kind: 'rotate', angleDegrees: angle, point: [0, 0, 0], direction: [0, 0, 1] }] },
        { instanceId: 'circular-b', transforms: [{ kind: 'rotate', angleDegrees: angle * 2, point: [0, 0, 0], direction: [0, 0, 1] }] },
      ],
    }) as { instances: PatternOutcome[]; diagnostics: Array<Record<string, unknown>> };
    return { source, tables, outcome };
  } catch (error) {
    disposeSource(source, tables);
    throw error;
  }
}

// Circular pattern occurrence names are semantic in source vertex + stable
// instance ID. Reopen and angular-spacing edits preserve the name set while
// the exact named vertex follows the requested rotation.
{
  const pristine = rc.makeBox([8, 0, 0], [12, 3, 2]);
  const serialized = pristine.serialize();
  pristine.delete();
  const builds = [buildCircular(null, 90), buildCircular(serialized, 90), buildCircular(serialized, 75)];
  try {
    for (const [buildIndex, build] of builds.entries()) {
      for (const [instanceIndex, instance] of build.outcome.instances.entries()) {
        checkValid(`circular build ${buildIndex} instance ${instanceIndex}`, instance);
      }
    }
    const baseline = builds[0]!.outcome.instances.map((entry) => sortedNames(entry.names));
    for (const build of builds) {
      check('circular name sets survive reopen and angle edits',
        JSON.stringify(build.outcome.instances.map((entry) => sortedNames(entry.names))) === JSON.stringify(baseline));
    }
    const sourceVertexName = 'Vstock:12,3,2';
    for (const [buildIndex, build] of builds.entries()) {
      const baseAngle = buildIndex === 2 ? 75 : 90;
      for (const [index, instance] of build.outcome.instances.entries()) {
        const instanceId = index === 0 ? 'circular-a' : 'circular-b';
        const angle = baseAngle * (index + 1) * Math.PI / 180;
        const name = module.patternInstanceSubshapeName('circular-main', instanceId, 'vertex', sourceVertexName);
        const point = exactNamedVertex(instance, name).asTuple() as [number, number, number];
        const expected: [number, number, number] = [
          12 * Math.cos(angle) - 3 * Math.sin(angle),
          12 * Math.sin(angle) + 3 * Math.cos(angle),
          2,
        ];
        check(`circular ${instanceId} keeps its exact source vertex after edit ${buildIndex}`,
          closeTo(point[0], expected[0]) && closeTo(point[1], expected[1]) && closeTo(point[2], expected[2]));
      }
    }
    results.circular = { instances: 2, reopen: 'stable', parameterEdit: 'stable' };
  } finally {
    for (const build of builds) {
      for (const instance of build.outcome.instances) history.disposeOutcome(instance);
      disposeSource(build.source, build.tables);
    }
  }
}

function buildFused(serialized: string | null, spacing: number): {
  source: any;
  tables: TopologyTables;
  outcome: PatternOutcome;
} {
  const source = serialized ? rc.deserializeShape(serialized) : rc.makeBox([0, 0, 0], [4, 4, 4]);
  const tables = sourceTables(source);
  try {
    const outcome = history.fusePatternWithHistory({
      sourceShape: source,
      sourceTables: tables,
      featureId: 'fuse-main',
      instances: [
        { instanceId: 'seed', transforms: [] },
        { instanceId: 'translated', transforms: [{ kind: 'translate', vector: [spacing, 0, 0] }] },
      ],
    }) as PatternOutcome;
    return { source, tables, outcome };
  } catch (error) {
    disposeSource(source, tables);
    throw error;
  }
}

// Union mode consumes the occurrence builders' exact provenance and then the
// boolean Modified/Generated history. Merged topology gets a contributor-set
// name; indistinguishable contributor sets fail rather than receiving an
// explorer-order suffix.
{
  const pristine = rc.makeBox([0, 0, 0], [4, 4, 4]);
  const serialized = pristine.serialize();
  pristine.delete();
  const builds = [buildFused(null, 2), buildFused(serialized, 2), buildFused(serialized, 3)];
  try {
    for (const [index, build] of builds.entries()) checkValid(`fused build ${index}`, build.outcome);
    const expected = sortedNames(builds[0]!.outcome.names);
    for (const build of builds) {
      check('fused names survive reopen and overlapping-spacing edits',
        JSON.stringify(sortedNames(build.outcome.names)) === JSON.stringify(expected));
    }
    const leftName = module.patternInstanceSubshapeName('fuse-main', 'seed', 'face', 'Fstock:0,2,2');
    const leftFace = exactNamedFace(builds[0]!.outcome, leftName);
    check('fused seed x-min face keeps its exact occurrence provenance', closeTo(centerOfFace(leftFace)[0], 0));
    const rightName = module.patternInstanceSubshapeName('fuse-main', 'translated', 'face', 'Fstock:4,2,2');
    for (const [index, build] of builds.entries()) {
      const expectedX = index === 2 ? 7 : 6;
      const rightFace = exactNamedFace(build.outcome, rightName);
      check(`fused translated x-max face does not retarget after edit ${index}`,
        closeTo(centerOfFace(rightFace)[0], expectedX));
    }
    results.fused = {
      topology: {
        faces: builds[0]!.outcome.names.faces.length,
        edges: builds[0]!.outcome.names.edges.length,
        vertices: builds[0]!.outcome.names.vertices.length,
      },
      contributorNames: builds[0]!.outcome.names.faces.filter((entry) => entry.name.includes(':fuse:')).length,
    };
  } finally {
    for (const build of builds) {
      history.disposeOutcome(build.outcome);
      disposeSource(build.source, build.tables);
    }
  }
}

// Fail-closed behavior is part of the public contract: incomplete source
// coverage and duplicate stable instance IDs both have structured diagnostics.
{
  const source = rc.makeBox([0, 0, 0], [4, 3, 2]);
  const tables = sourceTables(source);
  try {
    const missing = tables.faces.pop();
    let missingCode = '';
    try {
      history.patternInstancesWithHistory({
        sourceShape: source,
        sourceTables: tables,
        featureId: 'invalid-main',
        instances: [{ instanceId: 'one', transforms: [] }],
      });
    } catch (error: any) {
      missingCode = error.code;
      check('missing coverage emits one structured diagnostic', error.diagnostics?.[0]?.code === missingCode);
    } finally {
      if (missing) tables.faces.push(missing);
    }
    check('missing source topology fails closed',
      missingCode === module.PATTERN_FEATURE_HISTORY_ERROR_CODES.incompleteCoverage);

    let ambiguityCode = '';
    try {
      history.patternInstancesWithHistory({
        sourceShape: source,
        sourceTables: tables,
        featureId: 'invalid-main',
        instances: [
          { instanceId: 'duplicate', transforms: [] },
          { instanceId: 'duplicate', transforms: [{ kind: 'translate', vector: [5, 0, 0] }] },
        ],
      });
    } catch (error: any) {
      ambiguityCode = error.code;
      check('ambiguity emits one structured diagnostic', error.diagnostics?.[0]?.code === ambiguityCode);
    }
    check('duplicate instance provenance fails closed',
      ambiguityCode === module.PATTERN_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance);
    results.failClosed = { missingCode, ambiguityCode };
  } finally {
    disposeSource(source, tables);
  }
}

console.log(JSON.stringify(results));
