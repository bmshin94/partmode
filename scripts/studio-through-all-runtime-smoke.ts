import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonDocument = Record<string, any>;

interface BodySummary {
  bodyId: string;
  exactBrep: string | null;
  geometry: Record<string, any> | null;
  faceNames: string[];
  faceCount: number;
  edgeNames: string[];
  edgeCount: number;
  vertexNames: string[];
  vertexCount: number;
  diagnostics: Array<Record<string, any>>;
  error: Record<string, any> | null;
  lastValid: boolean;
}

interface RebuildSummary {
  id: string;
  kind: string;
  errors: Array<Record<string, any>>;
  warnings: Array<Record<string, any>>;
  evaluation: Record<string, string[]>;
  bodies: BodySummary[];
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..', '..');
const fixturePath = resolve(root, 'tests', 'through-all-runtime', 'through-all-large.partmode.json');
const expectedBodyIds = Object.freeze([
  'body-through-exact',
  'body-through-classic',
  'body-through-face',
]);

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameStrings(actual: string[], expected: string[], label: string): void {
  invariant(
    actual.length === expected.length && actual.every((entry, index) => entry === expected[index]),
    `${label}: expected [${expected.join(', ')}], received [${actual.join(', ')}]`,
  );
}

function setParameter(document: JsonDocument, name: string, value: number): void {
  const matches = document.parameters.filter((entry: JsonDocument) => entry.name === name);
  invariant(matches.length === 1, `parameter ${name} did not resolve exactly once`);
  matches[0].value = value;
}

function body(result: RebuildSummary, bodyId: string): BodySummary {
  const matches = result.bodies.filter((entry) => entry.bodyId === bodyId);
  invariant(matches.length === 1, `${result.id}: body ${bodyId} did not resolve exactly once`);
  return matches[0]!;
}

const projectModule = await import(
  pathToFileURL(resolve(root, 'src', 'static', 'studio-project-v5.js')).href
) as any;
const runtimeModule = await import(
  pathToFileURL(resolve(root, 'src', 'static', 'studio-v5-runtime-document.js')).href
) as any;
const prepareStudioV5Project = projectModule.prepareStudioV5Project as (candidate: JsonDocument) => JsonDocument;
const parseStudioV5Project = projectModule.parseStudioV5Project as (source: string) => JsonDocument;
const studioV5CanonicalHash = runtimeModule.studioV5CanonicalHash as (candidate: JsonDocument) => string;

function saveReopen(candidate: JsonDocument, label: string): JsonDocument {
  const inputSnapshot = JSON.stringify(candidate);
  const prepared = prepareStudioV5Project(clone(candidate));
  invariant(JSON.stringify(candidate) === inputSnapshot, `${label}: preparation mutated its input`);
  const saved = JSON.stringify(prepared);
  const reopened = parseStudioV5Project(saved);
  invariant(JSON.stringify(reopened) === saved, `${label}: save/reopen changed canonical JSON`);
  invariant(
    studioV5CanonicalHash(reopened) === studioV5CanonicalHash(parseStudioV5Project(JSON.stringify(reopened))),
    `${label}: canonical hash changed on second reopen`,
  );
  return reopened;
}

async function runWorkerSequence(
  page: Page,
  sequenceId: string,
  variants: Array<{ id: string; document: JsonDocument }>,
): Promise<RebuildSummary[]> {
  return page.evaluate(async (input) => {
    const studioScript = document.querySelector<HTMLScriptElement>('script[src*="/studio.js"]');
    if (!studioScript) throw new Error('versioned Studio entrypoint is missing');
    const workerUrl = `${new URL('.', studioScript.src).href}studio-kernel.worker.js`;
    const worker = new Worker(workerUrl, { type: 'module' });
    let revision = 0;
    try {
      const summaries = [];
      for (const variant of input.variants) {
        revision += 1;
        const requestId = `${input.sequenceId}-${revision}`;
        const response = await new Promise<Record<string, any>>((resolveResponse, rejectResponse) => {
          const timeout = setTimeout(
            () => rejectResponse(new Error(`${variant.id}: exact worker timed out`)),
            180_000,
          );
          const onMessage = (event: MessageEvent<Record<string, any>>) => {
            const data = event.data;
            if (data?.kind === 'kernel-status' && data.status === 'failed') {
              clearTimeout(timeout);
              worker.removeEventListener('message', onMessage);
              rejectResponse(new Error(data.message || 'CAD kernel initialization failed'));
              return;
            }
            if (data?.requestId !== requestId) return;
            clearTimeout(timeout);
            worker.removeEventListener('message', onMessage);
            if (data.kind === 'kernel-error') rejectResponse(new Error(data.message || 'CAD kernel error'));
            else resolveResponse(data);
          };
          worker.addEventListener('message', onMessage);
          worker.postMessage({
            kind: 'rebuild',
            requestId,
            projectId: variant.document.projectId,
            revision,
            document: variant.document,
            includeExactBrep: true,
          });
        });
        summaries.push({
          id: variant.id,
          kind: String(response.kind || ''),
          errors: (response.errors || []).map((entry: Record<string, any>) => ({
            code: entry.code,
            bodyId: entry.bodyId,
            featureId: entry.featureId,
            message: entry.message,
          })),
          warnings: (response.warnings || []).map((entry: Record<string, any>) => ({
            code: entry.code,
            bodyId: entry.bodyId,
            featureId: entry.featureId,
            message: entry.message,
          })),
          evaluation: Object.fromEntries(
            Object.entries(response.evaluation || {}).map(([key, values]) => [key, [...(values as string[])]]),
          ),
          bodies: (response.bodies || []).map((entry: Record<string, any>) => ({
            bodyId: String(entry.bodyId || ''),
            exactBrep: typeof entry.exactBrep === 'string' ? entry.exactBrep : null,
            geometry: entry.geometry ? { ...entry.geometry } : null,
            faceNames: (entry.mesh?.topologyFaces || [])
              .map((face: Record<string, any>) => face.name)
              .filter((name: unknown) => typeof name === 'string')
              .sort(),
            faceCount: Number(entry.mesh?.topologyCounts?.faces ?? entry.mesh?.topologyFaces?.length ?? 0),
            edgeNames: (entry.mesh?.edges || [])
              .map((edge: Record<string, any>) => edge.name)
              .filter((name: unknown) => typeof name === 'string')
              .sort(),
            edgeCount: Number(entry.mesh?.topologyCounts?.edges ?? entry.mesh?.edges?.length ?? 0),
            vertexNames: (entry.mesh?.topologyVertices || [])
              .map((vertex: Record<string, any>) => vertex.name)
              .filter((name: unknown) => typeof name === 'string')
              .sort(),
            vertexCount: Number(entry.mesh?.topologyCounts?.vertices ?? entry.mesh?.topologyVertices?.length ?? 0),
            diagnostics: (entry.mesh?.topologyDiagnostics || []).map((diagnostic: Record<string, any>) => ({
              severity: diagnostic.severity,
              code: diagnostic.code,
              reason: diagnostic.reason,
            })),
            error: entry.error ? { ...entry.error } : null,
            lastValid: entry.lastValid === true,
          })),
        });
      }
      return summaries;
    } finally {
      worker.terminate();
    }
  }, { sequenceId, variants }) as Promise<RebuildSummary[]>;
}

function assertExactResult(result: RebuildSummary, offset: number, span: number): void {
  invariant(result.kind === 'rebuild-result', `${result.id}: worker did not return rebuild-result`);
  invariant(result.errors.length === 0, `${result.id}: worker errors ${JSON.stringify(result.errors)}`);
  invariant(result.warnings.length === 0, `${result.id}: worker warnings ${JSON.stringify(result.warnings)}`);
  sameStrings(result.bodies.map((entry) => entry.bodyId), [...expectedBodyIds], `${result.id}: body order`);
  const expectedVolumes = new Map<string, number>([
    ['body-through-exact', (40 * 30 - Math.PI * 25) * span],
    ['body-through-classic', (32 * 24 - 4 * 4) * span],
    ['body-through-face', (36 * 24 - 6 * 4) * span],
  ]);
  for (const bodyId of expectedBodyIds) {
    const current = body(result, bodyId);
    invariant(!current.error, `${result.id}/${bodyId}: body error ${current.error?.message || 'unknown'}`);
    invariant(!current.lastValid, `${result.id}/${bodyId}: worker used last-valid geometry`);
    invariant(current.geometry?.valid === true, `${result.id}/${bodyId}: exact shape is invalid`);
    invariant(current.geometry?.brepValid === true, `${result.id}/${bodyId}: B-rep analyzer rejected shape`);
    invariant(current.geometry?.solidCount === 1, `${result.id}/${bodyId}: expected one exact solid`);
    const expectedVolume = expectedVolumes.get(bodyId)!;
    const actualVolume = Number(current.geometry?.volume);
    invariant(
      Math.abs(actualVolume - expectedVolume) <= Math.max(1e-4, expectedVolume * 1e-10),
      `${result.id}/${bodyId}: Through All left material behind; volume ${actualVolume}, expected ${expectedVolume}`,
    );
    const bounds = current.geometry?.bounds;
    invariant(Array.isArray(bounds) && bounds.length === 2, `${result.id}/${bodyId}: exact bounds are missing`);
    invariant(Math.abs(bounds[0][2] - offset) <= 1e-6, `${result.id}/${bodyId}: lower Z bound changed`);
    invariant(Math.abs(bounds[1][2] - (offset + span)) <= 1e-6, `${result.id}/${bodyId}: upper Z bound changed`);
    invariant(typeof current.exactBrep === 'string' && current.exactBrep.length > 100, `${result.id}/${bodyId}: exact BREP missing`);
    invariant(current.faceCount > 0 && current.faceNames.length === current.faceCount,
      `${result.id}/${bodyId}: incomplete face names ${current.faceNames.length}/${current.faceCount}`);
    invariant(current.edgeCount > 0 && current.edgeNames.length === current.edgeCount,
      `${result.id}/${bodyId}: incomplete edge names ${current.edgeNames.length}/${current.edgeCount}`);
    invariant(current.vertexCount > 0 && current.vertexNames.length === current.vertexCount,
      `${result.id}/${bodyId}: incomplete vertex names ${current.vertexNames.length}/${current.vertexCount}`);
    invariant(current.diagnostics.length === 0,
      `${result.id}/${bodyId}: topology diagnostics ${JSON.stringify(current.diagnostics)}`);
  }
}

function assertSameEvidence(actual: RebuildSummary, expected: RebuildSummary, label: string): void {
  for (const bodyId of expectedBodyIds) {
    const left = body(actual, bodyId);
    const right = body(expected, bodyId);
    invariant(left.exactBrep === right.exactBrep, `${label}/${bodyId}: canonical BREP changed`);
    sameStrings(left.faceNames, right.faceNames, `${label}/${bodyId}: face names`);
    sameStrings(left.edgeNames, right.edgeNames, `${label}/${bodyId}: edge names`);
    sameStrings(left.vertexNames, right.vertexNames, `${label}/${bodyId}: vertex names`);
  }
}

const source = JSON.parse(readFileSync(fixturePath, 'utf8')) as JsonDocument;
const base = saveReopen(source, 'base');
const editedSource = clone(base);
setParameter(editedSource, 'stock_offset', -35000);
setParameter(editedSource, 'stock_span', 32000);
const edited = saveReopen(editedSource, 'edited');
const editedReopened = saveReopen(parseStudioV5Project(JSON.stringify(edited)), 'edited second reopen');

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-through-all-'));
let local: RunningPartModeServer | undefined;
let browser: Browser | undefined;

try {
  local = await startPartModeServer({
    distDir: resolve(root, 'dist'),
    host: '127.0.0.1',
    port: 0,
    stateDir: resolve(temporaryDirectory, 'state'),
  });
  const healthResponse = await fetch(new URL('/healthz', local.url));
  invariant(healthResponse.ok, `local PartMode health returned HTTP ${healthResponse.status}`);
  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 300_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const response = await page.goto(local.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  invariant(response?.status() === 200, `local PartMode page returned HTTP ${response?.status() ?? 0}`);

  const warm = await runWorkerSequence(page, 'through-all-warm', [
    { id: 'base-warm', document: base },
    { id: 'edited-warm', document: edited },
    { id: 'edited-reopened-warm', document: editedReopened },
  ]);
  const coldBase = (await runWorkerSequence(page, 'through-all-cold-base', [
    { id: 'base-cold', document: base },
  ]))[0]!;
  const coldEdited = (await runWorkerSequence(page, 'through-all-cold-edited', [
    { id: 'edited-cold', document: editedReopened },
  ]))[0]!;

  assertExactResult(warm[0]!, 20000, 25000);
  assertExactResult(warm[1]!, -35000, 32000);
  assertExactResult(warm[2]!, -35000, 32000);
  assertExactResult(coldBase, 20000, 25000);
  assertExactResult(coldEdited, -35000, 32000);
  assertSameEvidence(warm[0]!, coldBase, 'warm/cold base');
  assertSameEvidence(warm[1]!, coldEdited, 'warm/cold edited');
  assertSameEvidence(warm[1]!, warm[2]!, 'save/reopen checkpoint reuse');
  for (const bodyId of expectedBodyIds) {
    sameStrings(
      body(warm[1]!, bodyId).faceNames,
      body(warm[0]!, bodyId).faceNames,
      `edit/${bodyId}: stable face identities`,
    );
    sameStrings(
      body(warm[1]!, bodyId).edgeNames,
      body(warm[0]!, bodyId).edgeNames,
      `edit/${bodyId}: stable edge identities`,
    );
    sameStrings(
      body(warm[1]!, bodyId).vertexNames,
      body(warm[0]!, bodyId).vertexNames,
      `edit/${bodyId}: stable vertex identities`,
    );
  }
  const reusedOnReopen = new Set(warm[2]!.evaluation.reusedFeatureIds || []);
  for (const featureId of base.partDefinitions[0].featureOrder) {
    invariant(reusedOnReopen.has(featureId), `save/reopen did not reuse exact checkpoint ${featureId}`);
  }
  console.log('Through All target-bounds runtime OK: 5 exact rebuilds, 3 profile/support modes, warm/cold BREP and complete F/E/V stable');
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
