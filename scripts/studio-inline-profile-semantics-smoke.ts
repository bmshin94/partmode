import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Source {
  kind: 'line' | 'circle';
  id: string;
  a2?: [number, number];
  b2?: [number, number];
  center2?: [number, number];
  radius?: number;
}

interface SourceOutcome {
  complete: boolean;
  diagnostics: Array<Record<string, unknown>>;
  entities: Source[];
  shapeCount: number;
}

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Inline profile semantics smoke failed: ${name}`);
}

function safeDelete(value: any): void {
  try { value?.delete?.(); } catch {}
}

function sortedIds(outcome: SourceOutcome): string[] {
  return outcome.entities.map((entity) => entity.id).sort();
}

function sourceMap(outcome: SourceOutcome): Record<string, unknown> {
  const entries: Array<[string, unknown]> = outcome.entities.map((entity) => [entity.id, {
    kind: entity.kind,
    a2: entity.a2,
    b2: entity.b2,
    center2: entity.center2,
    radius: entity.radius,
  }]);
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

const root = process.cwd();
const vendorDir = resolve(root, 'src/static/vendor');
const nodeGlobals = globalThis as typeof globalThis & {
  require: ReturnType<typeof createRequire>;
  __dirname: string;
};
nodeGlobals.require = createRequire(import.meta.url);
nodeGlobals.__dirname = vendorDir;

const semanticsModule = await import(
  pathToFileURL(resolve(root, 'src/static/studio-inline-profile-semantics.js')).href
) as any;
const { INLINE_PROFILE_SEMANTICS_CODES, inlineProfileCreationSources } = semanticsModule;

const parameters: Record<string, number> = {
  base_d: 30,
  base_h: 20,
  base_w: 40,
  tool_r: 6,
};
const evaluate = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && Object.hasOwn(parameters, value)) return parameters[value]!;
  throw new Error('Unknown expression');
};

const targetShape = { id: 'target-profile', kind: 'rect', x: 0, y: 0, w: 'base_w', h: 'base_d' };
const toolShape = { id: 'tool-profile', kind: 'circle', x: 0, y: 0, r: 'tool_r' };
const targetSources = inlineProfileCreationSources([targetShape], evaluate) as SourceOutcome;
const toolSources = inlineProfileCreationSources([toolShape], evaluate) as SourceOutcome;

check('explicit-id rectangle is eligible', targetSources.complete && targetSources.diagnostics.length === 0);
check('rectangle has four role-owned line sources', targetSources.entities.length === 4
  && targetSources.entities.every((entity) => entity.kind === 'line'));
check('rectangle identities are semantic roles', JSON.stringify(sortedIds(targetSources)) === JSON.stringify([
  'inline-shape:target-profile:rect-edge:bottom',
  'inline-shape:target-profile:rect-edge:left',
  'inline-shape:target-profile:rect-edge:right',
  'inline-shape:target-profile:rect-edge:top',
]));
check('explicit-id circle is eligible', toolSources.complete && toolSources.entities.length === 1);
check('circle identity comes from its explicit shape id', toolSources.entities[0]!.id === 'inline-shape:tool-profile:circle');

const reordered = inlineProfileCreationSources([toolShape, targetShape], evaluate) as SourceOutcome;
const ordered = inlineProfileCreationSources([targetShape, toolShape], evaluate) as SourceOutcome;
check('shape array reordering does not change identities', JSON.stringify(sortedIds(reordered)) === JSON.stringify(sortedIds(ordered)));
check('shape array reordering does not retarget semantics', JSON.stringify(sourceMap(reordered)) === JSON.stringify(sourceMap(ordered)));

parameters.base_w = 52;
parameters.base_d = 36;
parameters.tool_r = 8;
const editedTargetSources = inlineProfileCreationSources([targetShape], evaluate) as SourceOutcome;
const editedToolSources = inlineProfileCreationSources([toolShape], evaluate) as SourceOutcome;
check('rectangle dimension edits preserve identities', JSON.stringify(sortedIds(editedTargetSources)) === JSON.stringify(sortedIds(targetSources)));
check('circle dimension edits preserve identity', JSON.stringify(sortedIds(editedToolSources)) === JSON.stringify(sortedIds(toolSources)));
check('rectangle edit changes construction coordinates', JSON.stringify(sourceMap(editedTargetSources)) !== JSON.stringify(sourceMap(targetSources)));
check('circle edit changes the evaluated radius', editedToolSources.entities[0]!.radius === 8);
parameters.base_w = 40;
parameters.base_d = 30;
parameters.tool_r = 6;

const stablePoly = inlineProfileCreationSources([{
  id: 'flange-profile',
  kind: 'poly',
  pts: [[0, 0], [8, 0], [3, 5]],
  edgeIds: ['base-edge', 'slope-right', 'slope-left'],
  closed: true,
}], evaluate) as SourceOutcome;
check('polygon with explicit per-segment ids is eligible', stablePoly.complete && stablePoly.entities.length === 3);
check('polygon source ids use explicit edge ids', sortedIds(stablePoly).includes('inline-shape:flange-profile:poly-edge:slope-right'));

const missingId = inlineProfileCreationSources([{ kind: 'rect', x: 0, y: 0, w: 10, h: 8 }], evaluate) as SourceOutcome;
check('missing shape id fails closed', !missingId.complete && missingId.entities.length === 0);
check('missing shape id is explicit', missingId.diagnostics.some((item) => item.code === INLINE_PROFILE_SEMANTICS_CODES.missingShapeId));

const invalidId = inlineProfileCreationSources([{ id: 'not a stable id', kind: 'circle', x: 0, y: 0, r: 2 }], evaluate) as SourceOutcome;
check('invalid persistent-id syntax fails closed', !invalidId.complete && invalidId.entities.length === 0);
check('invalid persistent-id syntax is explicit', invalidId.diagnostics.some((item) =>
  item.code === INLINE_PROFILE_SEMANTICS_CODES.invalidStableId));

const missingPolyEdges = inlineProfileCreationSources([{
  id: 'anonymous-edges', kind: 'poly', pts: [[0, 0], [5, 0], [0, 5]], closed: true,
}], evaluate) as SourceOutcome;
check('polygon without explicit edge ids fails closed', !missingPolyEdges.complete && missingPolyEdges.entities.length === 0);
check('missing polygon edge ids are explicit', missingPolyEdges.diagnostics.some((item) =>
  item.code === INLINE_PROFILE_SEMANTICS_CODES.missingPolyEdgeIds));

const duplicateShapeIds = inlineProfileCreationSources([targetShape, { ...toolShape, id: targetShape.id }], evaluate) as SourceOutcome;
check('duplicate shape ids fail the whole profile closed', !duplicateShapeIds.complete && duplicateShapeIds.entities.length === 0);
check('duplicate shape ids are explicit', duplicateShapeIds.diagnostics.some((item) =>
  item.code === INLINE_PROFILE_SEMANTICS_CODES.duplicateShapeId));

const mixedUnsafe = inlineProfileCreationSources([targetShape, { kind: 'circle', x: 3, y: 3, r: 1 }], evaluate) as SourceOutcome;
check('one unsafe shape suppresses all otherwise valid sources', !mixedUnsafe.complete && mixedUnsafe.entities.length === 0);

// Prove that the semantic sources name actual OCCT faces, not just JSON rows.
const rc = await import(pathToFileURL(resolve(vendorDir, 'replicad.module.js')).href) as any;
const ocFactory = await import(pathToFileURL(resolve(vendorDir, 'replicad-oc.module.js')).href) as any;
const topologyModule = await import(pathToFileURL(resolve(root, 'src/static/studio-topo-naming.js')).href) as any;
const oc = await ocFactory.default({ locateFile: () => resolve(vendorDir, 'replicad_single.wasm') });
rc.setOC(oc);
const topology = topologyModule.createStudioTopoNaming(rc);

function exactFaceCount(shape: any): number {
  const faces = topology.exactFaces(shape);
  try { return faces.length; }
  finally { topology.disposeWrappers(faces); }
}

function creationNames(shape: any, featureId: string, sources: Source[], height: number): any[] {
  return topology.creationNamesForSweep(shape, {
    featureId,
    entities: sources,
    toWorld: ([x, y]: [number, number]) => [x, y, 0],
    sweepDirection: [0, 0, 1],
    capOffsets: [0, height],
  });
}

const booleanNameSets: string[][] = [];
for (const dimensions of [
  { width: 40, depth: 30, height: 20, radius: 6 },
  { width: 40, depth: 30, height: 20, radius: 8 },
  { width: 40, depth: 30, height: 26, radius: 8 },
]) {
  parameters.base_w = dimensions.width;
  parameters.base_d = dimensions.depth;
  parameters.base_h = dimensions.height;
  parameters.tool_r = dimensions.radius;
  const targetSourceEdit = inlineProfileCreationSources([targetShape], evaluate) as SourceOutcome;
  const toolSourceEdit = inlineProfileCreationSources([toolShape], evaluate) as SourceOutcome;
  let stage = 'build target';
  let target: any = null;
  let tool: any = null;
  let targetNames: any = null;
  let toolNames: any = null;
  let cut: any = null;
  try {
    const targetDrawing = semanticsModule.inlineStableShapeDrawing(rc, targetShape, evaluate);
    check('stable rectangle drawing is available', targetDrawing.complete && targetDrawing.drawing);
    target = targetDrawing.drawing.sketchOnPlane('XY').extrude(dimensions.height);
    stage = 'build tool';
    const toolDrawing = semanticsModule.inlineStableShapeDrawing(rc, toolShape, evaluate);
    check('stable single-curve circle drawing is available', toolDrawing.complete && toolDrawing.drawing);
    tool = toolDrawing.drawing.sketchOnPlane('XY').extrude(dimensions.height);
    stage = 'name target';
    targetNames = creationNames(target, 'feature-target-extrude', targetSourceEdit.entities, dimensions.height);
    stage = 'name tool';
    toolNames = creationNames(tool, 'feature-tool-extrude', toolSourceEdit.entities, dimensions.height);
    stage = 'check creation names';
    const targetFaceCount = exactFaceCount(target);
    const toolFaceCount = exactFaceCount(tool);
    check('target rectangle has one exact persistent name per face', targetNames.length === targetFaceCount);
    check('tool circle has one exact persistent name per face', toolNames.length === toolFaceCount);
    check('creation naming emits no ambiguity diagnostics', (targetNames as any).diagnostics.length === 0
      && (toolNames as any).diagnostics.length === 0);
    stage = 'boolean cut';
    cut = topology.booleanWithNames('cut', target, tool, targetNames, toolNames);
    stage = 'validate boolean cut';
    check('boolean cut remains a valid exact B-rep', (() => {
      const analyzer = new oc.BRepCheck_Analyzer(cut.shape.wrapped, true, false);
      try { return analyzer.IsValid_2(); }
      finally { analyzer.delete(); }
    })());
    check('boolean cut has complete exact persistent face coverage', cut.names.length === exactFaceCount(cut.shape));
    check('boolean cut emits no provenance ambiguity diagnostics', (cut.names as any).diagnostics.length === 0);
    const nameSet = cut.names.map((entry: any) => entry.name).sort();
    check('boolean cut retains the explicit circle-wall identity', nameSet.includes(
      'Ffeature-tool-extrude:side:inline-shape:tool-profile:circle',
    ));
    booleanNameSets.push(nameSet);
  } catch (error) {
    throw new Error('Inline profile kernel proof failed during ' + stage + ': ' + String(error));
  } finally {
    if (cut) {
      topology.disposeTable(cut.names);
      safeDelete(cut.shape);
    }
    topology.disposeTable(targetNames || []);
    topology.disposeTable(toolNames || []);
    safeDelete(target);
    safeDelete(tool);
  }
}
check('boolean parameter edits preserve the entire semantic face-name set', booleanNameSets.every((names) =>
  JSON.stringify(names) === JSON.stringify(booleanNameSets[0])));

console.log(JSON.stringify({
  booleanCutBuilds: booleanNameSets.length,
  booleanCutFaceNames: booleanNameSets[0]?.length,
  failClosedCodes: [
    INLINE_PROFILE_SEMANTICS_CODES.missingShapeId,
    INLINE_PROFILE_SEMANTICS_CODES.invalidStableId,
    INLINE_PROFILE_SEMANTICS_CODES.missingPolyEdgeIds,
    INLINE_PROFILE_SEMANTICS_CODES.duplicateShapeId,
  ],
  reorderStable: true,
  rectangleSources: targetSources.entities.length,
  circleSources: toolSources.entities.length,
  polygonSources: stablePoly.entities.length,
}));
