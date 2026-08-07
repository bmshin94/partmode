import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface SourceEdge {
  sketchId?: string;
  sectionId?: string;
  entityId: string;
  edge: any;
}

interface NamedOutcome {
  shape: any;
  names: Array<{ name: string; face: any }>;
  diagnostics: Array<{ severity: string; code: string; [key: string]: unknown }>;
}

interface ProfileHistory {
  revolveWithHistory(options: Record<string, unknown>): NamedOutcome;
  loftWithHistory(options: Record<string, unknown>): NamedOutcome;
  sweepWithHistory(options: Record<string, unknown>): NamedOutcome;
  disposeOutcome(outcome: NamedOutcome): void;
  exactFaces(shape: any): any[];
  exactEdges(shape: any): any[];
  exactVertices(shape: any): any[];
  disposeWrappers(wrappers: any[]): void;
  exactNameEvidence(outcome: NamedOutcome): Array<{
    name: string;
    exactMatchCount: number;
    evidence: { geometry: string; area: string; center: string[] } | null;
  }>;
}

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Profile feature history smoke failed: ${name}`);
}

function deleteAll(values: any[]): void {
  for (const value of values) {
    try { value?.delete?.(); } catch {}
  }
}

function sortedNames(outcome: NamedOutcome): string[] {
  return outcome.names.map((entry) => entry.name).sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function edgeEndpoints(edge: any): [number[], number[]] {
  const start = edge.startPoint;
  const end = edge.endPoint;
  try {
    return [
      [start.x ?? start[0], start.y ?? start[1], start.z ?? start[2]],
      [end.x ?? end[0], end.y ?? end[1], end.z ?? end[2]],
    ];
  } finally {
    start.delete();
    end.delete();
  }
}

const closePoint = (left: number[], right: number[]) =>
  left.every((value, index) => Math.abs(value - (right[index] ?? Number.NaN)) <= 1e-8);

function sameSegment(edge: any, start: number[], end: number[]): boolean {
  const [actualStart, actualEnd] = edgeEndpoints(edge);
  return (closePoint(actualStart, start) && closePoint(actualEnd, end))
    || (closePoint(actualStart, end) && closePoint(actualEnd, start));
}

function exactFaceCount(history: ProfileHistory, shape: any): number {
  const faces = history.exactFaces(shape);
  try { return faces.length; }
  finally { history.disposeWrappers(faces); }
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

function checkExactCoverage(history: ProfileHistory, label: string, outcome: NamedOutcome): ReturnType<ProfileHistory['exactNameEvidence']> {
  const errors = outcome.diagnostics.filter((entry) => entry.severity === 'error');
  check(`${label} has no history ambiguity or unnamed-face error; names=${JSON.stringify(sortedNames(outcome))}; errors=${JSON.stringify(errors)}`, errors.length === 0);
  const evidence = history.exactNameEvidence(outcome);
  check(`${label} gives every name one exact face`, evidence.every((entry) => entry.exactMatchCount === 1));
  check(`${label} persistent names are unique`, new Set(sortedNames(outcome)).size === outcome.names.length);
  check(`${label} names every exact result face`, outcome.names.length === exactFaceCount(history, outcome.shape));
  return evidence;
}

function checkResultRoundTrip(history: ProfileHistory, oc: any, rc: any, label: string, outcome: NamedOutcome): void {
  const serialized = outcome.shape.serialize();
  const reopened = rc.deserializeShape(serialized);
  try {
    checkValidSolid(oc, rc, `${label} reopened result`, reopened);
    check(`${label} reopen preserves exact face count`, exactFaceCount(history, reopened) === exactFaceCount(history, outcome.shape));
    check(`${label} BREP save/reopen preserves kernel volume`,
      Math.abs(rc.measureVolume(reopened) - rc.measureVolume(outcome.shape)) <= 1e-8);
  } finally {
    reopened.delete();
  }
}

function rectangleEdges(
  rc: any,
  points: Array<[number, number, number]>,
  scopeKey: 'sketchId' | 'sectionId',
  scopeId: string,
  reopen: boolean,
): { edges: any[]; wire: any; sources: SourceEdge[] } {
  const entityIds = ['bottom', 'outer', 'top', 'inner'];
  const originals = points.map((point, index) => rc.makeLine(point, points[(index + 1) % points.length]));
  let wire = rc.assembleWire(originals);
  deleteAll(originals);
  if (reopen) {
    const serialized = wire.serialize();
    const reopened = rc.deserializeShape(serialized);
    check('serialized profile reopens as a wire', reopened instanceof rc.Wire);
    wire.delete();
    wire = reopened;
  }
  const edges = history.exactEdges(wire);
  const edgeForSegment = (start: number[], end: number[]) => {
    const matches = edges.filter((edge) => sameSegment(edge, start, end));
    check('semantic profile segment maps to one exact wire edge', matches.length === 1);
    return matches[0];
  };
  const sources = points.map((point, index) => ({
    [scopeKey]: scopeId,
    entityId: entityIds[index],
    edge: edgeForSegment(point, points[(index + 1) % points.length]!),
  })) as SourceEdge[];
  return { edges, wire, sources };
}

function disposeProfile(profile: { face?: any; wire: any; edges: any[] }): void {
  deleteAll([profile.face, profile.wire, ...profile.edges]);
}

const root = process.cwd();
const vendorDir = resolve(root, 'src/static/vendor');
const nodeGlobals = globalThis as typeof globalThis & {
  require: ReturnType<typeof createRequire>;
  __dirname: string;
};
nodeGlobals.require = createRequire(import.meta.url);
nodeGlobals.__dirname = vendorDir;

const source = readFileSync(resolve(root, 'src/static/studio-profile-feature-history.js'), 'utf8');
check('module owns raw revolve history builder', source.includes('new oc.BRepPrimAPI_MakeRevol_1('));
check('module owns raw loft history builder', source.includes('new oc.BRepOffsetAPI_ThruSections('));
check('module owns raw pipe-shell history builder', source.includes('new oc.BRepOffsetAPI_MakePipeShell('));
check('module never calls HashCode identity', !source.includes('.HashCode(') && !source.includes('.hashCode'));
check('module uses exact IsSame identity', source.includes('.IsSame('));
check('full revolve cap creation is explicitly excluded', source.includes('if (!isFull)'));
check('ambiguous suffixes are diagnosed', source.includes('PROFILE_FEATURE_HISTORY_CODES.ambiguousSuffix'));
check('geometry never orders persistent-name suffixes', !source.includes('strictFaceOrder'));
check('ambiguous generated faces receive no numbered name', !source.includes("name: baseName + ("));

const rc = await import(pathToFileURL(resolve(vendorDir, 'replicad.module.js')).href) as any;
const ocFactory = await import(pathToFileURL(resolve(vendorDir, 'replicad-oc.module.js')).href) as any;
const historyModule = await import(pathToFileURL(resolve(root, 'src/static/studio-profile-feature-history.js')).href) as {
  createStudioProfileFeatureHistory(rc: any): ProfileHistory;
};
const oc = await ocFactory.default({ locateFile: () => resolve(vendorDir, 'replicad_single.wasm') });
rc.setOC(oc);
const history = historyModule.createStudioProfileFeatureHistory(rc);

function buildRevolve(radialSize: number, reopen: boolean, angleDegrees: number): NamedOutcome {
  const profile = rectangleEdges(
    rc,
    [
      [2, -radialSize / 2, 0],
      [2 + radialSize, -radialSize / 2, 0],
      [2 + radialSize, radialSize / 2, 0],
      [2, radialSize / 2, 0],
    ],
    'sketchId',
    'revolve-profile',
    reopen,
  ) as ReturnType<typeof rectangleEdges> & { face: any };
  profile.face = rc.makeFace(profile.wire);
  const exactProfileEdges = history.exactEdges(profile.face);
  const faceSources = profile.sources.map((source) => {
    const [start, end] = edgeEndpoints(source.edge);
    const matches = exactProfileEdges.filter((edge) => sameSegment(edge, start, end));
    check('revolve semantic entity maps to one exact face edge', matches.length === 1);
    return { sketchId: source.sketchId, entityId: source.entityId, edge: matches[0] };
  });
  try {
    return history.revolveWithHistory({
      featureId: 'revolve-1',
      profileId: 'revolve-profile',
      profileFace: profile.face,
      profileEdges: faceSources,
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 1, 0],
      angleDegrees,
    });
  } finally {
    history.disposeWrappers(exactProfileEdges);
    disposeProfile(profile);
  }
}

function inspectClosedRevolveHistory(radialSize: number, reopen: boolean): Record<string, unknown> {
  const profile = rectangleEdges(
    rc,
    [
      [2, -radialSize / 2, 0],
      [2 + radialSize, -radialSize / 2, 0],
      [2 + radialSize, radialSize / 2, 0],
      [2, radialSize / 2, 0],
    ],
    'sketchId',
    'revolve-profile',
    reopen,
  ) as ReturnType<typeof rectangleEdges> & { face: any };
  profile.face = rc.makeFace(profile.wire);
  const faceEdges = history.exactEdges(profile.face);
  const sources = profile.sources.map((source) => {
    const [start, end] = edgeEndpoints(source.edge);
    const matches = faceEdges.filter((edge) => sameSegment(edge, start, end));
    check('closed-revolve inspection maps semantic edge exactly', matches.length === 1);
    return { entityId: source.entityId, edge: matches[0] };
  });
  const axis = rc.makeAx1([0, 0, 0], [0, 1, 0]);
  const builder = new oc.BRepPrimAPI_MakeRevol_1(profile.face.wrapped, axis, Math.PI * 2, false);
  const rawResult = builder.Shape();
  const shape = rc.cast(rawResult);
  rawResult.delete();
  const resultFaces = history.exactFaces(shape);
  const resultEdges = history.exactEdges(shape);
  const resultFaceEdges = resultFaces.map((face) => history.exactEdges(face));
  const drain = (list: any): any[] => {
    const outputs: any[] = [];
    const copy = new oc.TopTools_ListOfShape_1();
    try {
      copy.Assign(list);
      while (copy.Size() > 0) {
        outputs.push(copy.First_1());
        copy.RemoveFirst();
      }
      return outputs;
    } finally {
      copy.delete();
      list.delete();
    }
  };
  const exactFaceMatches = (raw: any): number => resultFaces.filter((face) => face.wrapped.IsSame(raw)).length;
  const listMatches = (list: any): number => {
    const outputs = drain(list);
    try { return outputs.reduce((sum, output) => sum + exactFaceMatches(output), 0); }
    finally { deleteAll(outputs); }
  };
  let revol = null;
  let revolBinding: Record<string, unknown>;
  try {
    revol = builder.Revol();
    const revolMethods = new Set<string>();
    for (let prototype = Object.getPrototypeOf(revol); prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
      for (const name of Object.getOwnPropertyNames(prototype)) revolMethods.add(name);
    }
    revolBinding = { callable: true, methods: [...revolMethods].sort() };
  } catch (error) {
    revolBinding = { callable: false, error: String((error as Error)?.message || error) };
  }
  const evidence: Record<string, unknown> = {};
  try {
    for (const source of sources) {
      let first = null;
      let last = null;
      const sourceVertices = history.exactVertices(source.edge);
      try {
        first = builder.FirstShape_2(source.edge.wrapped);
        last = builder.LastShape_2(source.edge.wrapped);
        const vertexGroups = sourceVertices.map((vertex) => {
          const outputs = drain(builder.Generated(vertex.wrapped));
          try {
            return resultEdges.filter((edge) =>
              outputs.some((output) => edge.wrapped.IsSame(output)));
          } finally {
            deleteAll(outputs);
          }
        });
        const vertexBoundaryFaces = resultFaces.filter((_face, faceIndex) =>
          vertexGroups.length > 0
          && vertexGroups.every((group) => group.some((edge) =>
            resultFaceEdges[faceIndex]!.some((candidate) => candidate.wrapped.IsSame(edge.wrapped)))));
        evidence[source.entityId] = {
          generatedFaceMatches: listMatches(builder.Generated(source.edge.wrapped)),
          modifiedFaceMatches: listMatches(builder.Modified(source.edge.wrapped)),
          firstFaceMatches: exactFaceMatches(first),
          lastFaceMatches: exactFaceMatches(last),
          containedResultFaceCount: resultFaces.filter((face) => {
            const edges = history.exactEdges(face);
            try { return edges.some((edge) => edge.wrapped.IsSame(source.edge.wrapped)); }
            finally { history.disposeWrappers(edges); }
          }).length,
          sourceVertexCount: sourceVertices.length,
          generatedVertexEdgeMatches: vertexGroups.map((group) => group.length),
          vertexBoundaryFaceMatches: vertexBoundaryFaces.length,
        };
      } finally {
        history.disposeWrappers(sourceVertices);
        deleteAll([first, last]);
      }
    }
    return {
      resultFaceCount: resultFaces.length,
      generatedFaceMethodAvailable: typeof builder.GeneratedFace === 'function',
      revolBinding,
      sources: evidence,
    };
  } finally {
    try { revol.delete(); } catch {}
    resultFaceEdges.forEach((edges) => history.disposeWrappers(edges));
    history.disposeWrappers(resultEdges);
    history.disposeWrappers(resultFaces);
    history.disposeWrappers(faceEdges);
    deleteAll([shape, builder, axis]);
    disposeProfile(profile);
  }
}

function buildSweep(size: number, reopen: boolean, ambiguousEntity = false): NamedOutcome {
  const half = size / 2;
  const profile = rectangleEdges(
    rc,
    [[-half, 0, -half], [half, 0, -half], [half, 0, half], [-half, 0, half]],
    'sketchId',
    'sweep-profile',
    reopen,
  );
  const pathEdge = rc.makeLine([0, 0, 0], [0, 12 + size, 0]);
  let spine = rc.assembleWire([pathEdge]);
  if (reopen) {
    const serialized = spine.serialize();
    const reopened = rc.deserializeShape(serialized);
    check('serialized path reopens as a wire', reopened instanceof rc.Wire);
    spine.delete();
    spine = reopened;
  }
  try {
    const profileEdges = profile.sources.map((entry) =>
      ambiguousEntity && entry.entityId === 'top'
        ? { ...entry, entityId: 'bottom' }
        : entry);
    return history.sweepWithHistory({
      featureId: 'sweep-1',
      profileId: 'sweep-profile',
      profileWire: profile.wire,
      profileEdges,
      spine,
      transition: 'right',
      frenet: false,
    });
  } finally {
    deleteAll([spine, pathEdge]);
    disposeProfile(profile);
  }
}

function buildSegmentedSweep(size: number, reverseAssembly: boolean): NamedOutcome {
  const half = size / 2;
  const profile = rectangleEdges(
    rc,
    [[-half, 0, -half], [half, 0, -half], [half, 0, half], [-half, 0, half]],
    'sketchId',
    'segmented-sweep-profile',
    false,
  );
  const legA = rc.makeLine([0, 0, 0], [0, 8, 0]);
  const legB = rc.makeLine([0, 8, 0], [0, 16, 3]);
  const legC = rc.makeLine([0, 16, 3], [0, 24, 9]);
  const spine = rc.assembleWire(reverseAssembly ? [legC, legB, legA] : [legA, legB, legC]);
  try {
    return history.sweepWithHistory({
      featureId: 'sweep-segmented',
      profileId: 'segmented-sweep-profile',
      profileWire: profile.wire,
      profileEdges: profile.sources,
      spine,
      transition: 'right',
      frenet: false,
    });
  } finally {
    deleteAll([spine, legC, legB, legA]);
    disposeProfile(profile);
  }
}

function buildAnalyticBoundarySweep(scaleEnd: number): NamedOutcome {
  const profile = rectangleEdges(
    rc,
    [[-3, -2, 0], [3, -2, 0], [3, 2, 0], [-3, 2, 0]],
    'sketchId',
    'sweep-boundary-profile',
    false,
  );
  const pathEdge = rc.makeBSplineApproximation([
    [0, 0, 0],
    [0, 0, 8.3595],
    [0, 0, 16.719],
    [5.884, 0, 24.045333333333332],
    [17.652, 0, 38.698],
  ], { tolerance: 1e-4, degMax: 5 });
  const spine = rc.assembleWire([pathEdge]);
  try {
    return history.sweepWithHistory({
      featureId: 'sweep-analytic-boundary',
      profileId: 'sweep-boundary-profile',
      profileWire: profile.wire,
      profileEdges: profile.sources,
      spine,
      transition: 'round',
      frenet: false,
      scaleEnd,
    });
  } finally {
    deleteAll([spine, pathEdge]);
    disposeProfile(profile);
  }
}

function buildLoft(size: number, reopen: boolean): NamedOutcome {
  const half = size / 2;
  const lower = rectangleEdges(
    rc,
    [[-half, -half, 0], [half, -half, 0], [half, half, 0], [-half, half, 0]],
    'sectionId',
    'section-a',
    reopen,
  );
  const upperHalf = size * 0.32;
  const upper = rectangleEdges(
    rc,
    [
      [-upperHalf, -upperHalf, 10 + size],
      [upperHalf, -upperHalf, 10 + size],
      [upperHalf, upperHalf, 10 + size],
      [-upperHalf, upperHalf, 10 + size],
    ],
    'sectionId',
    'section-b',
    reopen,
  );
  try {
    return history.loftWithHistory({
      featureId: 'loft-1',
      sections: [
        { id: 'section-a', wire: lower.wire, edges: lower.sources },
        { id: 'section-b', wire: upper.wire, edges: upper.sources },
      ],
      ruled: true,
      smoothing: false,
      solid: true,
    });
  } finally {
    disposeProfile(lower);
    disposeProfile(upper);
  }
}

const results: Record<string, unknown> = {};
const closedRevolveHistory = inspectClosedRevolveHistory(4, false) as {
  resultFaceCount: number;
  generatedFaceMethodAvailable: boolean;
  revolBinding: { callable: boolean; error?: string };
  sources: Record<string, {
    generatedFaceMatches: number;
    modifiedFaceMatches: number;
    firstFaceMatches: number;
    lastFaceMatches: number;
    containedResultFaceCount: number;
    sourceVertexCount: number;
    generatedVertexEdgeMatches: number[];
    vertexBoundaryFaceMatches: number;
  }>;
};
for (const entityId of ['bottom', 'top']) {
  const entry = closedRevolveHistory.sources[entityId]!;
  check(`${entityId} radial edge has no direct Generated face`, entry.generatedFaceMatches === 0);
  check(`${entityId} radial edge has no Modified face`, entry.modifiedFaceMatches === 0);
  check(`${entityId} radial edge has no per-source First/Last face`,
    entry.firstFaceMatches === 0 && entry.lastFaceMatches === 0);
  check(`${entityId} radial edge is not an exact boundary edge of its annular face`,
    entry.containedResultFaceCount === 0);
  check(`${entityId} endpoint vertices each generate one exact result edge`,
    entry.sourceVertexCount === 2 && sameStrings(entry.generatedVertexEdgeMatches.map(String), ['1', '1']));
  check(`${entityId} generated endpoint-edge intersection proves one exact result face`,
    entry.vertexBoundaryFaceMatches === 1);
}
check('unbound internal BRepSweep_Revol is not used as hidden provenance',
  closedRevolveHistory.revolBinding.callable === false
  && closedRevolveHistory.revolBinding.error?.includes('unbound types'));
check('BRepPrimAPI_MakeRevol exposes no GeneratedFace fallback',
  closedRevolveHistory.generatedFaceMethodAvailable === false);
results.closedRevolveHistory = closedRevolveHistory;

{
  const base = buildRevolve(4, false, 225);
  const reopened = buildRevolve(4, true, 225);
  const edited = buildRevolve(5.25, false, 225);
  try {
    checkValidSolid(oc, rc, 'partial revolve', base.shape);
    const baseEvidence = checkExactCoverage(history, 'partial revolve', base);
    checkExactCoverage(history, 'reopened partial revolve', reopened);
    checkExactCoverage(history, 'dimension-edited partial revolve', edited);
    check('partial revolve has explicit start cap', sortedNames(base).some((name) => name.includes(':revolve:cap:start:')));
    check('partial revolve has explicit end cap', sortedNames(base).some((name) => name.includes(':revolve:cap:end:')));
    check('partial revolve save/rebuild preserves name set', sameStrings(sortedNames(base), sortedNames(reopened)));
    check('partial revolve upstream edit preserves name set', sameStrings(sortedNames(base), sortedNames(edited)));
    checkResultRoundTrip(history, oc, rc, 'partial revolve', base);
    results.partialRevolve = { names: sortedNames(base), evidence: baseEvidence };
  } finally {
    history.disposeOutcome(base);
    history.disposeOutcome(reopened);
    history.disposeOutcome(edited);
  }
}

{
  const base = buildRevolve(4, false, 360);
  const reopened = buildRevolve(4, true, 360);
  const edited = buildRevolve(5.25, false, 360);
  try {
    checkValidSolid(oc, rc, 'full revolve', base.shape);
    const evidence = checkExactCoverage(history, 'full revolve', base);
    checkExactCoverage(history, 'reopened full revolve', reopened);
    checkExactCoverage(history, 'dimension-edited full revolve', edited);
    check('full revolve invents no cap names', sortedNames(base).every((name) => !name.includes(':cap:')));
    check('full revolve names both annular faces from endpoint-vertex history',
      ['bottom', 'top'].every((entityId) => sortedNames(base).includes(
        `Frevolve-1:revolve:side:revolve-profile/${entityId}`)));
    check('full revolve save/rebuild preserves name set', sameStrings(sortedNames(base), sortedNames(reopened)));
    check('full revolve upstream edit preserves name set', sameStrings(sortedNames(base), sortedNames(edited)));
    checkResultRoundTrip(history, oc, rc, 'full revolve', base);
    results.fullRevolve = { names: sortedNames(base), evidence };
  } finally {
    history.disposeOutcome(base);
    history.disposeOutcome(reopened);
    history.disposeOutcome(edited);
  }
}

{
  const base = buildSweep(4, false);
  const reopened = buildSweep(4, true);
  const edited = buildSweep(5.5, false);
  try {
    checkValidSolid(oc, rc, 'sweep', base.shape);
    const evidence = checkExactCoverage(history, 'sweep', base);
    checkExactCoverage(history, 'reopened sweep', reopened);
    checkExactCoverage(history, 'dimension-edited sweep', edited);
    check('sweep has explicit start cap', sortedNames(base).some((name) => name.includes(':sweep:cap:start:')));
    check('sweep has explicit end cap', sortedNames(base).some((name) => name.includes(':sweep:cap:end:')));
    check('sweep save/rebuild preserves name set', sameStrings(sortedNames(base), sortedNames(reopened)));
    check('sweep upstream edit preserves name set', sameStrings(sortedNames(base), sortedNames(edited)));
    checkResultRoundTrip(history, oc, rc, 'sweep', base);
    results.sweep = { names: sortedNames(base), evidence };
  } finally {
    history.disposeOutcome(base);
    history.disposeOutcome(reopened);
    history.disposeOutcome(edited);
  }
}

{
  // A multi-edge open spine generates one lateral face per profile edge per
  // spine segment. Exact Generated(spine edge) intersection names them with
  // deterministic :seg:N suffixes anchored at the start cap; assembly order
  // of the authored spine edges must not change the name set.
  const base = buildSegmentedSweep(4, false);
  const repeated = buildSegmentedSweep(4, false);
  const reversedAssembly = buildSegmentedSweep(4, true);
  const edited = buildSegmentedSweep(5.5, false);
  try {
    checkValidSolid(oc, rc, 'segmented sweep', base.shape);
    checkExactCoverage(history, 'segmented sweep', base);
    checkExactCoverage(history, 'repeated segmented sweep', repeated);
    checkExactCoverage(history, 'reversed-assembly segmented sweep', reversedAssembly);
    checkExactCoverage(history, 'dimension-edited segmented sweep', edited);
    const names = sortedNames(base);
    check('segmented sweep names all three segments per profile edge',
      [0, 1, 2].every((segment) => names.filter((name) => name.endsWith(':seg:' + segment)).length === 4));
    check('segmented sweep keeps explicit start and end caps',
      names.some((name) => name.includes(':sweep:cap:start:')) && names.some((name) => name.includes(':sweep:cap:end:')));
    check('segmented sweep rebuild preserves name set', sameStrings(names, sortedNames(repeated)));
    check('segmented sweep spine assembly order does not change names', sameStrings(names, sortedNames(reversedAssembly)));
    check('segmented sweep dimension edit preserves name set', sameStrings(names, sortedNames(edited)));
    checkResultRoundTrip(history, oc, rc, 'segmented sweep', base);
    results.segmentedSweep = { names };
  } finally {
    history.disposeOutcome(base);
    history.disposeOutcome(repeated);
    history.disposeOutcome(reversedAssembly);
    history.disposeOutcome(edited);
  }
}

{
  const tapered = buildAnalyticBoundarySweep(0.63);
  const unit = buildAnalyticBoundarySweep(1);
  const expanded = buildAnalyticBoundarySweep(1.15);
  try {
    checkValidSolid(oc, rc, 'analytic-boundary tapered sweep', tapered.shape);
    checkValidSolid(oc, rc, 'analytic-boundary unit sweep', unit.shape);
    checkValidSolid(oc, rc, 'analytic-boundary expanded sweep', expanded.shape);
    const taperedEvidence = checkExactCoverage(history, 'analytic-boundary tapered sweep', tapered);
    const unitEvidence = checkExactCoverage(history, 'analytic-boundary unit sweep', unit);
    const expandedEvidence = checkExactCoverage(history, 'analytic-boundary expanded sweep', expanded);
    check('analytic sweep scale edits preserve the complete construction-lineage name set',
      sameStrings(sortedNames(tapered), sortedNames(unit))
      && sameStrings(sortedNames(unit), sortedNames(expanded)));
    const geometryByName = (evidence: ReturnType<ProfileHistory['exactNameEvidence']>) => new Map(
      evidence.map((entry) => [entry.name, entry.evidence?.geometry || 'UNKNOWN']),
    );
    const taperedGeometry = geometryByName(taperedEvidence);
    const unitGeometry = geometryByName(unitEvidence);
    const expandedGeometry = geometryByName(expandedEvidence);
    const analyticTransitions = sortedNames(unit).filter((name) =>
      taperedGeometry.get(name) === 'BSPLINE_SURFACE'
      && unitGeometry.get(name) === 'PLANE'
      && expandedGeometry.get(name) === 'BSPLINE_SURFACE');
    const expectedTransitions = ['bottom', 'top'].map((entityId) =>
      `Fsweep-analytic-boundary:sweep:side:sweep-boundary-profile/${entityId}`).sort();
    check('unit sweep specializes exactly the two generated side faces from B-spline surfaces to planes',
      sameStrings(analyticTransitions, expectedTransitions));
    results.sweepAnalyticSpecialization = {
      names: sortedNames(unit),
      transitions: analyticTransitions.map((name) => ({
        name,
        tapered: taperedGeometry.get(name),
        unit: unitGeometry.get(name),
        expanded: expandedGeometry.get(name),
      })),
    };
  } finally {
    history.disposeOutcome(tapered);
    history.disposeOutcome(unit);
    history.disposeOutcome(expanded);
  }
}

{
  const ambiguous = buildSweep(4, false, true);
  try {
    checkValidSolid(oc, rc, 'ambiguous-source sweep', ambiguous.shape);
    const evidence = history.exactNameEvidence(ambiguous);
    check('ambiguous-source sweep keeps every assigned name exact',
      evidence.every((entry) => entry.exactMatchCount === 1));
    const ambiguity = ambiguous.diagnostics.find((entry) =>
      entry.code === 'PROFILE_HISTORY_AMBIGUOUS_SUFFIX'
      && entry.persistentBaseName === 'Fsweep-1:sweep:side:sweep-profile/bottom');
    check('one semantic source mapping to two faces is explicitly ambiguous', ambiguity?.candidateCount === 2);
    check('ambiguous faces receive no guessed numbered names',
      sortedNames(ambiguous).every((name) => !name.startsWith('Fsweep-1:sweep:side:sweep-profile/bottom')));
    check('named plus explicitly ambiguous faces cover the exact result',
      ambiguous.names.length + Number(ambiguity?.candidateCount || 0) === exactFaceCount(history, ambiguous.shape));
    results.ambiguousSweep = {
      names: sortedNames(ambiguous),
      diagnostic: ambiguity,
    };
  } finally {
    history.disposeOutcome(ambiguous);
  }
}

{
  const base = buildLoft(6, false);
  const reopened = buildLoft(6, true);
  const edited = buildLoft(7.5, false);
  try {
    checkValidSolid(oc, rc, 'loft', base.shape);
    const evidence = checkExactCoverage(history, 'loft', base);
    checkExactCoverage(history, 'reopened loft', reopened);
    checkExactCoverage(history, 'dimension-edited loft', edited);
    check('loft has explicit first-section cap', sortedNames(base).some((name) => name.includes(':loft:cap:start:section-a')));
    check('loft has explicit last-section cap', sortedNames(base).some((name) => name.includes(':loft:cap:end:section-b')));
    check('loft lateral names carry section provenance', sortedNames(base).filter((name) => name.includes(':loft:side:')).every((name) => name.includes('section-a/') || name.includes('section-b/')));
    check('loft save/rebuild preserves name set', sameStrings(sortedNames(base), sortedNames(reopened)));
    check('loft upstream edit preserves name set', sameStrings(sortedNames(base), sortedNames(edited)));
    checkResultRoundTrip(history, oc, rc, 'loft', base);
    results.loft = { names: sortedNames(base), evidence };
  } finally {
    history.disposeOutcome(base);
    history.disposeOutcome(reopened);
    history.disposeOutcome(edited);
  }
}

console.log(JSON.stringify(results));
