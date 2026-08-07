import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonDocument = Record<string, any>;
type TopologyKind = 'face' | 'edge';

interface TopologySummary {
  faces: number;
  namedFaces: number;
  edges: number;
  namedEdges: number;
  vertices: number;
  namedVertices: number;
  diagnostics: string[];
}

interface BodySummary {
  bodyId: string;
  mesh: boolean;
  renderSourceBodyId: string | null;
  exactBrep: string | null;
  topology: TopologySummary | null;
  geometry: Record<string, any> | null;
  error: Record<string, any> | null;
  lastValid: boolean;
}

interface RebuildSummary {
  id: string;
  kind: string;
  errors: Array<Record<string, any>>;
  evaluation: Record<string, string[]>;
  bodies: BodySummary[];
  retainedShapeEntries: number;
}

interface ScenarioSummary {
  steps: RebuildSummary[];
  retainedAfterRelease: number;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..', '..');

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Serialization fail-closed smoke failed: ${message}`);
}

function body(result: RebuildSummary, bodyId: string): BodySummary {
  const matches = result.bodies.filter((entry) => entry.bodyId === bodyId);
  invariant(matches.length === 1, `${result.id}: body ${bodyId} resolved ${matches.length} times`);
  return matches[0]!;
}

function assertCompleteTopology(result: BodySummary, label: string): void {
  invariant(!result.error, `${label}: unexpected body error ${JSON.stringify(result.error)}`);
  invariant(!result.lastValid, `${label}: used last-valid geometry`);
  invariant(result.mesh, `${label}: mesh is missing`);
  invariant(typeof result.exactBrep === 'string' && result.exactBrep.length > 100,
    `${label}: exact BREP evidence is missing`);
  invariant(result.geometry?.valid === true && result.geometry?.brepValid === true,
    `${label}: exact geometry is invalid`);
  invariant(result.geometry?.solidCount === 1, `${label}: exact geometry is not one solid`);
  const topology = result.topology;
  invariant(topology, `${label}: topology payload is missing`);
  invariant(topology.faces > 0 && topology.namedFaces === topology.faces,
    `${label}: named faces ${topology.namedFaces}/${topology.faces}`);
  invariant(topology.edges > 0 && topology.namedEdges === topology.edges,
    `${label}: named edges ${topology.namedEdges}/${topology.edges}`);
  invariant(topology.vertices > 0 && topology.namedVertices === topology.vertices,
    `${label}: named vertices ${topology.namedVertices}/${topology.vertices}`);
  invariant(topology.diagnostics.length === 0,
    `${label}: topology diagnostics ${JSON.stringify(topology.diagnostics)}`);
}

function assertCorrelationFailure(result: RebuildSummary, bodyId: string, label: string): void {
  invariant(result.kind === 'rebuild-result', `${label}: worker returned ${result.kind}`);
  const failed = body(result, bodyId);
  invariant(failed.error?.code === 'TOPOLOGY_DISPLAY_HASH_AMBIGUOUS',
    `${label}: body error ${JSON.stringify(failed.error)}`);
  invariant(failed.error?.stage === 'serialization', `${label}: failure stage is not serialization`);
  invariant(!failed.mesh, `${label}: published a mesh`);
  invariant(failed.exactBrep === null, `${label}: published exact BREP evidence`);
  invariant(failed.geometry === null, `${label}: published geometry metadata`);
  invariant(!failed.lastValid, `${label}: resurrected last-valid geometry`);
  const matchingErrors = result.errors.filter((entry) =>
    entry.bodyId === bodyId && entry.code === 'TOPOLOGY_DISPLAY_HASH_AMBIGUOUS');
  invariant(matchingErrors.length === 1,
    `${label}: expected one body-scoped correlation error, received ${JSON.stringify(result.errors)}`);
}

async function runScenario(
  page: Page,
  scenarioId: string,
  projectDocument: JsonDocument,
  steps: Array<{ id: string; bodyId?: string; topologyKind?: TopologyKind }>,
): Promise<ScenarioSummary> {
  return page.evaluate(async (input) => {
    const studioScript = document.querySelector<HTMLScriptElement>('script[src*="/studio.js"]');
    if (!studioScript) throw new Error('versioned Studio entrypoint is missing');
    const workerUrl = `${new URL('.', studioScript.src).href}studio-kernel.worker.js`;
    const worker = new Worker(workerUrl, { type: 'module' });
    let sequence = 0;

    const request = (payload: Record<string, any>): Promise<Record<string, any>> => {
      sequence += 1;
      const requestId = `${input.scenarioId}-${sequence}`;
      return new Promise((resolveResponse, rejectResponse) => {
        const timeout = setTimeout(() => rejectResponse(new Error(`${requestId}: worker timed out`)), 120_000);
        const onMessage = (event: MessageEvent<Record<string, any>>) => {
          const response = event.data;
          if (response?.kind === 'kernel-status' && response.status === 'failed') {
            clearTimeout(timeout);
            worker.removeEventListener('message', onMessage);
            rejectResponse(new Error(response.message || 'kernel initialization failed'));
            return;
          }
          if (response?.requestId !== requestId) return;
          clearTimeout(timeout);
          worker.removeEventListener('message', onMessage);
          if (response.kind === 'kernel-error') {
            rejectResponse(new Error(`${response.code || 'KERNEL_ERROR'}: ${response.message || 'worker failed'}`));
          } else {
            resolveResponse(response);
          }
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage({
          ...payload,
          requestId,
          projectId: input.document.projectId,
          revision: sequence,
        });
      });
    };

    const memory = async (): Promise<number> => {
      const response = await request({ kind: 'memory-stats' });
      return Number(response.memory?.retainedShapeEntries ?? -1);
    };

    const summarizeBody = (entry: Record<string, any>) => ({
      bodyId: String(entry.bodyId || ''),
      mesh: Boolean(entry.mesh),
      renderSourceBodyId: typeof entry.renderSourceBodyId === 'string' ? entry.renderSourceBodyId : null,
      exactBrep: typeof entry.exactBrep === 'string' ? entry.exactBrep : null,
      topology: entry.mesh ? {
        faces: Number(entry.mesh.topologyCounts?.faces ?? 0),
        namedFaces: Number(entry.mesh.topologyCounts?.namedFaces ?? 0),
        edges: Number(entry.mesh.topologyCounts?.edges ?? 0),
        namedEdges: Number(entry.mesh.topologyCounts?.namedEdges ?? 0),
        vertices: Number(entry.mesh.topologyCounts?.vertices ?? 0),
        namedVertices: Number(entry.mesh.topologyCounts?.namedVertices ?? 0),
        diagnostics: (entry.mesh.topologyDiagnostics || []).map((diagnostic: Record<string, any>) =>
          String(diagnostic.code || diagnostic.reason || 'unknown')),
      } : null,
      geometry: entry.geometry ? { ...entry.geometry } : null,
      error: entry.error ? { ...entry.error } : null,
      lastValid: entry.lastValid === true,
    });

    try {
      const summaries = [];
      for (const step of input.steps) {
        const collision = step.bodyId && step.topologyKind
          ? { bodyId: step.bodyId, topologyKind: step.topologyKind }
          : null;
        const response = await request({
          kind: 'rebuild',
          document: input.document,
          includeExactBrep: true,
          ...(collision ? { testOnlyTopologyDisplayHashCollision: collision } : {}),
        });
        summaries.push({
          id: step.id,
          kind: String(response.kind || ''),
          errors: (response.errors || []).map((entry: Record<string, any>) => ({ ...entry })),
          evaluation: Object.fromEntries(Object.entries(response.evaluation || {}).map(([key, value]) =>
            [key, [...(value as string[])]])),
          bodies: (response.bodies || []).map(summarizeBody),
          retainedShapeEntries: await memory(),
        });
      }
      await request({ kind: 'release' });
      return { steps: summaries, retainedAfterRelease: await memory() };
    } finally {
      worker.terminate();
    }
  }, { scenarioId, document: projectDocument, steps }) as Promise<ScenarioSummary>;
}

const booleanDocument = JSON.parse(readFileSync(
  resolve(root, 'tests', 'cad-corpus', 'boolean-cut.partmode.json'),
  'utf8',
)) as JsonDocument;
const patternDocument = JSON.parse(readFileSync(
  resolve(root, 'tests', 'body-pattern-runtime', 'body-patterns.partmode.json'),
  'utf8',
)) as JsonDocument;

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-serialization-failclosed-'));
let local: RunningPartModeServer | undefined;
let browser: Browser | undefined;

try {
  local = await startPartModeServer({
    distDir: resolve(root, 'dist'),
    host: '127.0.0.1',
    port: 0,
    stateDir: resolve(temporaryDirectory, 'state'),
  });
  const health = await fetch(new URL('/healthz', local.url));
  invariant(health.ok, `local health returned HTTP ${health.status}`);
  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 300_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const navigation = await page.goto(local.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  invariant(navigation?.status() === 200, `local page returned HTTP ${navigation?.status() ?? 0}`);

  const ordinary = await runScenario(page, 'ordinary-serialization', booleanDocument, [
    { id: 'baseline' },
    { id: 'warm-face-collision', bodyId: 'body-boolean-target', topologyKind: 'face' },
    { id: 'cold-edge-collision', bodyId: 'body-boolean-target', topologyKind: 'edge' },
    { id: 'recovery' },
  ]);
  const [ordinaryBaseline, warmFace, coldEdge, ordinaryRecovery] = ordinary.steps;
  invariant(ordinaryBaseline && warmFace && coldEdge && ordinaryRecovery, 'ordinary sequence is incomplete');
  assertCompleteTopology(body(ordinaryBaseline, 'body-boolean-target'), 'ordinary baseline target');
  assertCompleteTopology(body(ordinaryBaseline, 'body-boolean-tool'), 'ordinary baseline independent tool');
  invariant(ordinaryBaseline.retainedShapeEntries === 2,
    `ordinary baseline retained ${ordinaryBaseline.retainedShapeEntries} shapes`);

  assertCorrelationFailure(warmFace, 'body-boolean-target', 'warm face collision');
  invariant((warmFace.evaluation.reusedBodyIds || []).includes('body-boolean-target'),
    'warm face collision did not exercise a reused body');
  assertCompleteTopology(body(warmFace, 'body-boolean-tool'), 'warm face collision independent tool');
  invariant(warmFace.retainedShapeEntries === 1,
    `warm face collision retained ${warmFace.retainedShapeEntries} shapes instead of one survivor`);

  assertCorrelationFailure(coldEdge, 'body-boolean-target', 'cold edge collision');
  invariant((coldEdge.evaluation.evaluatedBodyIds || []).includes('body-boolean-target'),
    'cold edge collision did not build a new target shape');
  assertCompleteTopology(body(coldEdge, 'body-boolean-tool'), 'cold edge collision independent tool');
  invariant(coldEdge.retainedShapeEntries === 1,
    `cold edge collision leaked a new shape; retained ${coldEdge.retainedShapeEntries}`);

  assertCompleteTopology(body(ordinaryRecovery, 'body-boolean-target'), 'ordinary recovery target');
  assertCompleteTopology(body(ordinaryRecovery, 'body-boolean-tool'), 'ordinary recovery independent tool');
  invariant(ordinaryRecovery.retainedShapeEntries === 2,
    `ordinary recovery retained ${ordinaryRecovery.retainedShapeEntries} shapes`);
  invariant(body(ordinaryRecovery, 'body-boolean-target').exactBrep === body(ordinaryBaseline, 'body-boolean-target').exactBrep,
    'ordinary recovery changed canonical target BREP bytes');
  invariant(ordinary.retainedAfterRelease === 0,
    `ordinary release retained ${ordinary.retainedAfterRelease} shapes`);

  const patterns = await runScenario(page, 'fused-pattern-serialization', patternDocument, [
    { id: 'baseline' },
    { id: 'source-face-collision', bodyId: 'body-pattern-source', topologyKind: 'face' },
    { id: 'source-recovery' },
    { id: 'warm-fused-face-collision', bodyId: 'pattern-union-fused', topologyKind: 'face' },
    { id: 'cold-fused-edge-collision', bodyId: 'pattern-union-fused', topologyKind: 'edge' },
    { id: 'recovery' },
  ]);
  const [patternBaseline, sourceCollision, sourceRecovery, warmFusedFace, coldFusedEdge, patternRecovery] = patterns.steps;
  invariant(patternBaseline && sourceCollision && sourceRecovery && warmFusedFace && coldFusedEdge && patternRecovery,
    'pattern sequence is incomplete');
  assertCompleteTopology(body(patternBaseline, 'body-pattern-source'), 'pattern baseline source');
  assertCompleteTopology(body(patternBaseline, 'pattern-union-fused'), 'pattern baseline fused body');
  invariant(patternBaseline.retainedShapeEntries === 6,
    `pattern baseline retained ${patternBaseline.retainedShapeEntries} shapes`);

  assertCorrelationFailure(sourceCollision, 'body-pattern-source', 'pattern source face collision');
  for (const occurrenceId of [
    'pattern-linked-instance-1',
    'pattern-linked-instance-2',
    'pattern-union-instance-1',
    'pattern-union-instance-2',
  ]) {
    const occurrence = body(sourceCollision, occurrenceId);
    invariant(occurrence.error?.code === 'TOPOLOGY_DISPLAY_HASH_AMBIGUOUS',
      `${occurrenceId}: source correlation error was not propagated`);
    invariant(!occurrence.mesh && occurrence.exactBrep === null && occurrence.geometry === null && !occurrence.lastValid,
      `${occurrenceId}: published stale shared geometry`);
    invariant(occurrence.renderSourceBodyId === null,
      `${occurrenceId}: retained a broken render-source link`);
  }
  invariant(new Set(sourceCollision.errors.map((entry) => entry.bodyId)).size === sourceCollision.errors.length,
    `source collision duplicated body errors ${JSON.stringify(sourceCollision.errors)}`);
  assertCompleteTopology(body(sourceCollision, 'pattern-union-fused'), 'source collision independent fused result');
  invariant(sourceCollision.retainedShapeEntries === 1,
    `source collision retained ${sourceCollision.retainedShapeEntries} shapes instead of the independent fused result`);
  assertCompleteTopology(body(sourceRecovery, 'body-pattern-source'), 'source recovery source');
  assertCompleteTopology(body(sourceRecovery, 'pattern-union-fused'), 'source recovery fused body');
  invariant(sourceRecovery.retainedShapeEntries === 6,
    `source recovery retained ${sourceRecovery.retainedShapeEntries} shapes`);

  assertCorrelationFailure(warmFusedFace, 'pattern-union-fused', 'warm fused face collision');
  assertCompleteTopology(body(warmFusedFace, 'body-pattern-source'), 'warm fused collision source survivor');
  invariant(warmFusedFace.bodies.filter((entry) => entry.bodyId !== 'pattern-union-fused')
    .every((entry) => !entry.error && !entry.lastValid),
  'warm fused collision damaged another pattern body');
  invariant(warmFusedFace.retainedShapeEntries === 5,
    `warm fused collision retained ${warmFusedFace.retainedShapeEntries} shapes`);

  assertCorrelationFailure(coldFusedEdge, 'pattern-union-fused', 'cold fused edge collision');
  assertCompleteTopology(body(coldFusedEdge, 'body-pattern-source'), 'cold fused collision source survivor');
  invariant(coldFusedEdge.retainedShapeEntries === 5,
    `cold fused collision leaked a new fused shape; retained ${coldFusedEdge.retainedShapeEntries}`);

  assertCompleteTopology(body(patternRecovery, 'body-pattern-source'), 'pattern recovery source');
  assertCompleteTopology(body(patternRecovery, 'pattern-union-fused'), 'pattern recovery fused body');
  invariant(patternRecovery.retainedShapeEntries === 6,
    `pattern recovery retained ${patternRecovery.retainedShapeEntries} shapes`);
  invariant(body(patternRecovery, 'pattern-union-fused').exactBrep === body(patternBaseline, 'pattern-union-fused').exactBrep,
    'fused recovery changed canonical BREP bytes');
  invariant(patterns.retainedAfterRelease === 0,
    `pattern release retained ${patterns.retainedAfterRelease} shapes`);

  console.log(JSON.stringify({
    ok: true,
    injectedDisplayHashCollisions: ['face', 'edge'],
    ordinaryRetainedShapes: ordinary.steps.map((entry) => entry.retainedShapeEntries),
    fusedPatternRetainedShapes: patterns.steps.map((entry) => entry.retainedShapeEntries),
    warmLastValidSuppressed: true,
    coldLastValidSuppressed: true,
    independentBodiesSurvived: true,
    exactTopology: 'complete F/E/V before and after recovery',
    releasedRetainedShapes: [ordinary.retainedAfterRelease, patterns.retainedAfterRelease],
  }));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
