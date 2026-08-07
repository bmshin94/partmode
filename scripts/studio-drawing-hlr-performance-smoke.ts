import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { createHeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

const root = process.cwd();
const projectModuleUrl = pathToFileURL(resolve(root, 'src/static/studio-project-v5.js')).href;
const { prepareStudioV5Project } = await import(projectModuleUrl) as any;
const profileMarker = 'PARTMODE_DR012_PROFILE ';
const fourViews = ['front', 'top', 'right', 'iso'];

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Drawing HLR performance smoke failed: ${label}`);
}

function sha256(value: unknown) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function close(left: number, right: number, tolerance = 1e-4) {
  return Math.abs(left - right) <= tolerance;
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (value: number) => String(value).padStart(4, '0');

function rowTransform(row: number, seed: number, mutationRow: number) {
  const cluster = Math.floor(row / 3);
  const depthLayer = row % 3;
  const layoutRandom = mulberry32((seed ^ Math.imul(cluster + 1, 0x9e3779b1)) >>> 0);
  const depthRandom = mulberry32((seed ^ Math.imul(row + 1, 0x85ebca6b)) >>> 0);
  const quarterTurns = cluster === 0 ? 0 : (cluster + Math.floor(layoutRandom() * 4)) % 4;
  const rotations = [
    [1, 0, 0, 0, 1, 0],
    [0, 1, 0, -1, 0, 0],
    [-1, 0, 0, 0, -1, 0],
    [0, -1, 0, 1, 0, 0],
  ];
  const [m00, m10, m20, m01, m11, m21] = rotations[quarterTurns]!;
  const x = cluster === 0 ? 0 : Math.round((layoutRandom() - 0.5) * 8 * 1e6) / 1e6;
  const depthJitter = cluster === 0 ? 0 : Math.round((depthRandom() - 0.5) * 2 * 1e6) / 1e6;
  const mutatedLayer = depthLayer === 0 ? 3 : -1;
  const y = (row === mutationRow ? mutatedLayer : depthLayer) * 12 + depthJitter;
  const z = cluster === 0 ? 0 : cluster * 70 + Math.round((layoutRandom() - 0.5) * 5 * 1e6) / 1e6;
  return [m00, m10, m20, 0, m01, m11, m21, 0, 0, 0, 1, 0, x, y, z, 1];
}

async function corpusParts() {
  const paths = [
    'tests/cad-corpus/boolean-cut.partmode.json',
    'tests/cad-corpus/fillet-shell.partmode.json',
    'tests/assembly-runtime/two-part-constrained.partmode.json',
  ];
  const sources = await Promise.all(paths.map(async (path) =>
    JSON.parse(await readFile(resolve(root, path), 'utf8')) as JsonRecord));
  const parts = sources.map((source) => structuredClone(source.partDefinitions[0]));
  parts[0].bodies.find((entry: JsonRecord) => entry.id === 'body-boolean-tool').visible = false;
  parts[1].bodies.find((entry: JsonRecord) => entry.id === 'body-shell-box').visible = false;
  const partNumbers = ['DR012-CUT', 'DR012-FILLET', 'DR012-BLOCK'];
  parts.forEach((part, index) => {
    part.metadata = {
      ...(part.metadata || {}),
      partNumber: partNumbers[index],
      revision: 'A',
      description: `DR012 exact corpus ${index + 1}`,
    };
  });
  return {
    parameters: sources.flatMap((source) => structuredClone(source.parameters || [])),
    parts,
    partNumbers,
  };
}

async function scaleProject(count: number, seed: number, mutationRow = -1, reordered = false) {
  check('scale count must be a positive multiple of 64', Number.isInteger(count) && count >= 64 && count % 64 === 0);
  const { parameters, parts } = await corpusParts();
  const rows = count / 64;
  const occurrences: JsonRecord[] = [];
  const occurrencePatterns: JsonRecord[] = [];
  for (let row = 0; row < rows; row += 1) {
    const id = `source-row-${pad(row)}`;
    const part = parts[row % parts.length];
    occurrences.push({
      id,
      name: `Seeded source row ${row + 1}`,
      definition: { kind: 'part', partId: part.id },
      baseTransform: rowTransform(row, seed, mutationRow),
      fixed: true,
      suppressed: false,
      visible: true,
    });
    occurrencePatterns.push({
      id: `pattern-row-${pad(row)}`,
      name: `Seeded row pattern ${row + 1}`,
      kind: 'linear',
      sourceOccurrenceIds: [id],
      generatedCount: 63,
      definition: { direction: [1, 0, 0], spacing: 90 },
      suppressed: false,
    });
  }
  if (reordered) {
    occurrences.reverse();
    occurrencePatterns.reverse();
  }
  return {
    schemaVersion: 5,
    projectId: `dr012-scale-${count}-${seed}-${mutationRow}-${reordered ? 'reordered' : 'ordered'}`,
    name: `DR012 ${count}-component seeded assembly`,
    units: 'mm',
    parameters,
    materials: [],
    partDefinitions: parts,
    assemblyDefinitions: [{
      id: 'assembly-dr012-scale',
      name: 'DR012 seeded scale assembly',
      parameters: [], occurrences, mates: [], occurrencePatterns,
      explodedViews: [], sectionViews: [], metadata: {},
    }],
    rootDocument: { kind: 'assembly', assemblyId: 'assembly-dr012-scale' },
    resources: [],
    metadata: { acceptance: 'PM-PAR-DR-012', seed, componentCount: count },
  };
}

async function occlusionClusterProject(seed: number, mutationRow = -1) {
  const project = await scaleProject(256, seed, mutationRow, false) as JsonRecord;
  const assembly = project.assemblyDefinitions[0];
  check('occlusion oracle assembly is missing', assembly);
  assembly.occurrencePatterns = [];
  project.projectId = `dr012-occlusion-cluster-${seed}-${mutationRow}`;
  project.name = 'DR012 four-component exact occlusion oracle';
  project.metadata = { acceptance: 'PM-PAR-DR-012-occlusion-oracle', seed, mutationRow };
  return project;
}

async function witnessProject(seed: number, partId: string, instanceId: string, transform: number[]) {
  const { parameters, parts } = await corpusParts();
  const part = parts.find((entry) => entry.id === partId);
  check(`witness part ${partId} exists`, part);
  return {
    schemaVersion: 5,
    projectId: `dr012-witness-${seed}-${partId}`,
    name: `DR012 witness ${partId}`,
    units: 'mm', parameters, materials: [], partDefinitions: [part],
    assemblyDefinitions: [{
      id: 'assembly-dr012-witness', name: 'DR012 witness assembly', parameters: [],
      occurrences: [{
        id: instanceId, name: `Witness ${partId}`, definition: { kind: 'part', partId },
        baseTransform: transform, fixed: true, suppressed: false, visible: true,
      }],
      mates: [], occurrencePatterns: [], explodedViews: [], sectionViews: [], metadata: {},
    }],
    rootDocument: { kind: 'assembly', assemblyId: 'assembly-dr012-witness' },
    resources: [], metadata: { acceptance: 'PM-PAR-DR-012-witness', seed },
  };
}

function pathPayload(result: JsonRecord) {
  return result.views.map((view: JsonRecord) => ({
    view: view.view,
    viewBox: view.viewBox,
    visible: view.visible,
    hidden: view.hidden,
    regularVisible: view.regularVisible,
    regularHidden: view.regularHidden,
    tangentVisible: view.tangentVisible,
    tangentHidden: view.tangentHidden,
  }));
}

const edgeClasses = ['visible', 'hidden', 'regularVisible', 'regularHidden', 'tangentVisible', 'tangentHidden'];

function normalizedPathPayload(payload: JsonRecord[]) {
  return payload.map((view: JsonRecord) => ({
    view: view.view,
    ...Object.fromEntries(edgeClasses.map((key) => [key, [...view[key]].sort()])),
  }));
}

async function exactProfile(document: JsonRecord, views: string[], includePaths = false, includeInstances = false) {
  const prepared = prepareStudioV5Project(structuredClone(document)) as JsonRecord;
  check('generated project did not survive canonical schema validation',
    JSON.stringify(prepareStudioV5Project(structuredClone(prepared))) === JSON.stringify(prepared));
  document = prepared;
  let kernel = await createHeadlessKernel();
  const started = performance.now();
  try {
    await kernel.waitForKernel();
    const ready = performance.now();
    const result = await kernel.request({
      kind: 'drawing-v5', requestId: `dr012-${document.projectId}-${views.join('-')}`,
      projectId: document.projectId, revision: 1, document, views,
    }) as JsonRecord;
    const finished = performance.now();
    if (result.kind !== 'drawing-result' || result.errors?.length || result.views?.length !== views.length) {
      const validation = await kernel.request({
        kind: 'validate-v5', requestId: `dr012-validate-${document.projectId}`,
        projectId: document.projectId, revision: 2, document,
      }) as JsonRecord;
      throw new Error(`exact profile failed ${JSON.stringify({
        drawingErrors: result.errors || [], validationErrors: validation.errors || [],
        bodyErrors: (validation.bodies || []).filter((entry: JsonRecord) => entry.error).slice(0, 12),
      })}`);
    }
    check(`exact profile failed ${JSON.stringify(result.errors || [])}`,
      result.kind === 'drawing-result' && result.errors?.length === 0 && result.views?.length === views.length);
    const payload = pathPayload(result);
    const deliveredPayload = payload.map((view: JsonRecord) => ({
      view: view.view, viewBox: view.viewBox, visible: view.visible, hidden: view.hidden,
    }));
    const pathBytes = Buffer.byteLength(JSON.stringify(deliveredPayload));
    const pathCount = deliveredPayload.reduce((sum: number, view: JsonRecord) =>
      sum + view.visible.length + view.hidden.length, 0);
    const memory = await kernel.request({
      kind: 'memory-stats', requestId: `dr012-memory-${document.projectId}`,
      projectId: document.projectId, revision: 1,
    }) as JsonRecord;
    check('memory telemetry did not return a current positive WASM heap measurement',
      memory.kind === 'memory-stats-result'
      && Number.isInteger(memory.memory?.wasmHeapBytes) && memory.memory.wasmHeapBytes > 0);
    const responseSource = JSON.stringify(result);
    const profile: JsonRecord = {
      kernelReadyMs: Math.round(ready - started),
      drawingMs: Math.round(finished - ready),
      responseBytes: Buffer.byteLength(responseSource),
      pathBytes,
      pathCount,
      wasmHeapBytes: memory.memory.wasmHeapBytes,
      responseHash: sha256(responseSource),
      pathHash: sha256(payload),
      normalizedPathHash: sha256(normalizedPathPayload(payload)),
      sourceDefinitionHash: sha256(document.partDefinitions),
      views: result.views.map((view: JsonRecord) => ({
        view: view.view, viewBox: view.viewBox,
        visible: view.visible.length, hidden: view.hidden.length,
        regularVisible: view.regularVisible.length, regularHidden: view.regularHidden.length,
        tangentVisible: view.tangentVisible.length, tangentHidden: view.tangentHidden.length,
      })),
      bom: result.manifest.bom.map((entry: JsonRecord) => ({
        itemNumber: entry.itemNumber, partId: entry.partId, partNumber: entry.partNumber,
        quantity: entry.quantity,
      })),
      balloons: result.manifest.balloons,
      plan: {
        schema: result.manifest.drawingPlan.schema,
        revisionKey: result.manifest.drawingPlan.revisionKey,
        placementLedgerFingerprint: result.manifest.drawingPlan.placementLedgerFingerprint,
        instanceCount: result.manifest.drawingPlan.instances.length,
        instances: includeInstances
          ? result.manifest.drawingPlan.instances.map((entry: JsonRecord) => ({
              instanceId: entry.instanceId,
              partId: entry.definitionPartId,
              transform: entry.transform,
            }))
          : [],
        representatives: result.manifest.drawingPlan.annotationRepresentatives.map((entry: JsonRecord) => {
          const instance = result.manifest.drawingPlan.instances.find((candidate: JsonRecord) => candidate.instanceId === entry.instanceId);
          return { ...entry, partId: instance.definitionPartId, transform: instance.transform };
        }),
      },
      performance: result.manifest.hlrPerformance,
      ...(includePaths ? { paths: payload } : {}),
    };
    profile.maxRssKb = process.resourceUsage().maxRSS;
    check('process RSS telemetry is missing', Number.isInteger(profile.maxRssKb) && profile.maxRssKb > 0);
    return profile;
  } finally {
    await kernel.dispose();
    kernel = null as any;
  }
}

function emitProfile(value: unknown) {
  process.stdout.write(`${profileMarker}${JSON.stringify(value)}\n`);
}

function profileFromChild(args: string[]) {
  const executable = fileURLToPath(import.meta.url);
  const child = spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 150_000,
  });
  check(`profile child ${args.join(' ')} exited cleanly: ${child.stderr || child.stdout}`,
    child.status === 0 && !child.error);
  const line = child.stdout.split(/\r?\n/u).find((entry) => entry.startsWith(profileMarker));
  check(`profile child ${args.join(' ')} returned a receipt`, line);
  return JSON.parse(line.slice(profileMarker.length)) as JsonRecord;
}

async function childMain(args: string[]) {
  if (args[0] === '--profile') {
    const count = Number(args[1]);
    const seed = Number(args[2]) >>> 0;
    const views = args[3] === 'front' ? ['front'] : args[3] === 'iso' ? ['iso'] : fourViews;
    const mutationRow = Number(args[4] ?? -1);
    const reordered = args[5] === 'reordered';
    emitProfile(await exactProfile(await scaleProject(count, seed, mutationRow, reordered), views));
    return true;
  }
  if (args[0] === '--cluster') {
    const seed = Number(args[1]) >>> 0;
    const mutationRow = Number(args[2] ?? -1);
    emitProfile(await exactProfile(await occlusionClusterProject(seed, mutationRow), ['front'], false, true));
    return true;
  }
  if (args[0] === '--witness') {
    const seed = Number(args[1]) >>> 0;
    const partId = String(args[2]);
    const instanceId = String(args[3]);
    const transform = JSON.parse(Buffer.from(String(args[4]), 'base64url').toString('utf8'));
    const view = args[5] === 'iso' ? 'iso' : 'front';
    emitProfile(await exactProfile(await witnessProject(seed, partId, instanceId, transform), [view], true));
    return true;
  }
  return false;
}

if (await childMain(process.argv.slice(2))) process.exit(0);

const replaySeed = process.env.PARTMODE_DR012_SEED;
const seed = replaySeed == null ? randomBytes(4).readUInt32LE(0) : Number(replaySeed) >>> 0;
console.log(`DR012 runtime-selected seed: ${seed}`);

const small = profileFromChild(['--profile', '512', String(seed), 'four', '-1', 'ordered']);
const large = profileFromChild(['--profile', '2048', String(seed), 'four', '-1', 'ordered']);
const repeated = profileFromChild(['--profile', '2048', String(seed), 'four', '-1', 'ordered']);
const mutationRow = 2;
const mutated = profileFromChild(['--profile', '2048', String(seed), 'front', String(mutationRow), 'ordered']);
const reordered = profileFromChild(['--profile', '512', String(seed), 'four', '-1', 'reordered']);
const clusterMutationRow = mutationRow;
const cluster = profileFromChild(['--cluster', String(seed), '-1']);
const mutatedCluster = profileFromChild(['--cluster', String(seed), String(clusterMutationRow)]);

check('large request did not carry exact performance evidence',
  large.performance?.schema === 'partmode.drawing-hlr-performance/v1');
check('large request did not prove 2,048 exact visible components and solids',
  large.performance.visibleComponentCount === 2048
  && large.performance.exactBodyInstanceCount === 2048
  && large.performance.placedCompoundEvidence?.solidCount === 2048);
check('large request did not use three exact part variants and exact body sources',
  large.performance.uniquePartVariantCount === 3 && large.performance.uniqueExactBodySourceCount === 3);
check('large request did not execute exactly one complete assembly HLR per view',
  large.performance.requestedViewCount === 4
  && large.performance.assemblyHlrPasses === 4
  && large.performance.exactHlrPasses === 4);
check('large request retained per-occurrence HLR work',
  large.performance.occurrenceHlrPasses === 0
  && large.performance.avoidedOccurrenceHlrPasses === 8192);
check('large request did not bound occurrence support to BOM representatives',
  large.performance.annotationRepresentativeCount === 3
  && large.performance.occurrenceSupportEvaluations === 3);
check('large request placement evidence is stale or incomplete',
  large.performance.revisionKey === large.plan.revisionKey
  && large.performance.placementLedgerFingerprint === large.plan.placementLedgerFingerprint
  && large.plan.instanceCount === 2048
  && large.plan.schema === 'partmode.assembly-drawing-plan/v2');
check('large exact views are incomplete', large.views.length === 4
  && large.views.every((view: JsonRecord) => view.visible > 0 && view.hidden > 0 && view.viewBox.every(Number.isFinite)));
check('large exact output crossed the bounded artifact ceiling',
  large.pathCount < 100_000 && large.pathBytes < 16 * 1024 * 1024 && large.responseBytes < 24 * 1024 * 1024);
for (const [label, profile] of [['large', large], ['repeated', repeated]] as const) {
  check(`${label} request has missing resource telemetry`,
    Number.isInteger(profile.kernelReadyMs) && profile.kernelReadyMs > 0
    && Number.isInteger(profile.drawingMs) && profile.drawingMs > 0
    && Number.isInteger(profile.wasmHeapBytes) && profile.wasmHeapBytes > 0
    && Number.isInteger(profile.maxRssKb) && profile.maxRssKb > 0);
  check(`${label} request exceeded the 30 second production budget (${profile.kernelReadyMs + profile.drawingMs} ms)`,
    profile.kernelReadyMs + profile.drawingMs <= 30_000);
  check(`${label} request exceeded 2 GiB WASM heap (${profile.wasmHeapBytes} bytes)`,
    profile.wasmHeapBytes <= 2 * 1024 * 1024 * 1024);
  check(`${label} request exceeded 3.75 GiB maximum RSS (${profile.maxRssKb} KiB)`,
    profile.maxRssKb <= 3.75 * 1024 * 1024);
}
check(`512-to-2048 scaling ratio is unbounded (${small.drawingMs} -> ${large.drawingMs} ms)`,
  large.drawingMs / Math.max(1, small.drawingMs) <= 6);
check('fresh-worker output is not byte deterministic',
  repeated.responseHash === large.responseHash && repeated.pathHash === large.pathHash);
check('occurrence declaration order changed exact HLR output', reordered.pathHash === small.pathHash);
check('placement mutation did not invalidate current exact output',
  mutated.sourceDefinitionHash === large.sourceDefinitionHash
  && mutated.plan.placementLedgerFingerprint !== large.plan.placementLedgerFingerprint
  && mutated.plan.revisionKey !== large.plan.revisionKey
  && JSON.stringify(mutated.views[0].viewBox) === JSON.stringify(large.views[0].viewBox)
  && close(mutated.performance.placedCompoundEvidence.volumeMm3, large.performance.placedCompoundEvidence.volumeMm3)
  && mutated.performance.viewPathEvidence[0].pathHash !== large.performance.viewPathEvidence[0].pathHash);

check('four-component occlusion oracle did not retain exact overlapping solids',
  cluster.performance.visibleComponentCount === 4
  && cluster.performance.exactBodyInstanceCount === 4
  && cluster.performance.placedCompoundEvidence.solidCount === 4
  && cluster.views[0].visible > 0 && cluster.views[0].hidden > 0);
check('depth-order mutation changed projected support instead of only occlusion ordering',
  mutatedCluster.sourceDefinitionHash === cluster.sourceDefinitionHash
  && JSON.stringify(mutatedCluster.views[0].viewBox) === JSON.stringify(cluster.views[0].viewBox)
  && close(mutatedCluster.performance.placedCompoundEvidence.volumeMm3, cluster.performance.placedCompoundEvidence.volumeMm3));
check('depth-order mutation did not change global exact HLR classification',
  mutatedCluster.normalizedPathHash !== cluster.normalizedPathHash);

const clusterWitnesses: JsonRecord[] = [];
for (const instance of cluster.plan.instances) {
  const mutatedInstance = mutatedCluster.plan.instances.find((entry: JsonRecord) => entry.instanceId === instance.instanceId);
  check(`mutated occlusion oracle lost ${instance.instanceId}`, mutatedInstance?.partId === instance.partId);
  const witnessArgs = (candidate: JsonRecord) => [
    '--witness', String(seed), candidate.partId, candidate.instanceId,
    Buffer.from(JSON.stringify(candidate.transform)).toString('base64url'),
  ];
  const baselineWitness = profileFromChild(witnessArgs(instance));
  const depthMutatedWitness = profileFromChild(witnessArgs(mutatedInstance));
  check(`isolated ${instance.instanceId} projection changed under a depth-only placement edit`,
    baselineWitness.normalizedPathHash === depthMutatedWitness.normalizedPathHash);
  clusterWitnesses.push(baselineWitness);
}
const naiveCluster = [{
  view: 'front',
  ...Object.fromEntries(edgeClasses.map((key) => [key, clusterWitnesses.flatMap((entry) => entry.paths[0][key])])),
}];
check('global assembly HLR is indistinguishable from naïve per-component projection concatenation',
  cluster.normalizedPathHash !== sha256(normalizedPathPayload(naiveCluster)));

const frontSupports = large.performance.occurrenceBoundsEvidence.find((entry: JsonRecord) => entry.view === 'front');
check('large request lacks three exact front-view support records',
  frontSupports?.kind === 'occt-brep-camera-support' && frontSupports.representatives?.length === 3);
const witnessVolumes = new Map<string, number>();
for (const representative of large.plan.representatives) {
  const encodedTransform = Buffer.from(JSON.stringify(representative.transform)).toString('base64url');
  const witness = profileFromChild([
    '--witness', String(seed), representative.partId, representative.instanceId, encodedTransform,
  ]);
  const support = frontSupports.representatives.find((entry: JsonRecord) => entry.instanceId === representative.instanceId);
  check(`representative ${representative.instanceId} lacks exact support evidence`,
    support?.evidence?.schema === 'partmode.drawing-brep-camera-support/v1'
    && support.evidence.kind === 'occt-brep-camera-support'
    && support.evidence.supports?.every((entry: JsonRecord) => entry.rangeMethod === 'rigid-camera-frame-AddOptimal')
    && typeof support.evidence.supportFingerprint === 'string' && support.evidence.supportFingerprint.length === 32);
  check(`representative ${representative.instanceId} support differs from independent exact HLR`,
    support.viewBox.length === 4
    && support.viewBox.every((value: number, index: number) => close(value, witness.views[0].viewBox[index])));
  const partNumber = witness.bom[0].partNumber;
  witnessVolumes.set(partNumber, witness.performance.placedCompoundEvidence.volumeMm3);
}
const obliqueRepresentative = large.plan.representatives[0];
const obliqueWitness = profileFromChild([
  '--witness', String(seed), obliqueRepresentative.partId, obliqueRepresentative.instanceId,
  Buffer.from(JSON.stringify(obliqueRepresentative.transform)).toString('base64url'), 'iso',
]);
const obliqueSupport = obliqueWitness.performance.occurrenceBoundsEvidence.find((entry: JsonRecord) => entry.view === 'iso')
  ?.representatives?.[0];
check('oblique representative support does not agree with independent exact isometric HLR',
  obliqueSupport?.evidence?.schema === 'partmode.drawing-brep-camera-support/v1'
  && obliqueSupport.evidence.frame?.direction?.length === 3
  && obliqueSupport.viewBox.every((value: number, index: number) => close(value, obliqueWitness.views[0].viewBox[index])));
const expectedVolume = large.bom.reduce((sum: number, item: JsonRecord) =>
  sum + item.quantity * (witnessVolumes.get(item.partNumber) || 0), 0);
check('large exact compound volume does not cover every BOM occurrence',
  close(large.performance.placedCompoundEvidence.volumeMm3, expectedVolume, Math.max(1e-5, expectedVolume * 1e-9)));

console.log(JSON.stringify({
  schema: large.performance.schema,
  seed,
  components: large.performance.visibleComponentCount,
  exactSolids: large.performance.placedCompoundEvidence.solidCount,
  variants: large.performance.uniquePartVariantCount,
  views: large.views.map((view: JsonRecord) => ({ view: view.view, visible: view.visible, hidden: view.hidden })),
  exactHlrPasses: large.performance.exactHlrPasses,
  occurrenceHlrPasses: large.performance.occurrenceHlrPasses,
  avoidedOccurrenceHlrPasses: large.performance.avoidedOccurrenceHlrPasses,
  representativeSupportEvaluations: large.performance.occurrenceSupportEvaluations,
  timingMs: {
    small512: small.kernelReadyMs + small.drawingMs,
    large2048: large.kernelReadyMs + large.drawingMs,
    repeated2048: repeated.kernelReadyMs + repeated.drawingMs,
  },
  maxRssKiB: large.maxRssKb,
  wasmHeapBytes: large.wasmHeapBytes,
  responseBytes: large.responseBytes,
  pathBytes: large.pathBytes,
  deterministicResponseSha256: large.responseHash,
  placementMutation: { row: mutationRow, depthOnly: true, changedPathHash: true },
  occlusionOracle: {
    components: cluster.performance.visibleComponentCount,
    depthMutationRow: clusterMutationRow,
    globalDiffersFromNaivePerComponent: true,
    isolatedDepthMutationStable: true,
  },
  independentWitnesses: witnessVolumes.size + clusterWitnesses.length * 2 + 1,
}, null, 2));
