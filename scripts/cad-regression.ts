import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonDocument = Record<string, any>;

interface ParameterMutation {
  scope: 'project' | `part:${string}`;
  name: string;
  value: number | string;
}

interface MutationStep {
  id: string;
  set: ParameterMutation[];
  mustEvaluateBodyIds: string[];
  mustEvaluateFeatureIds?: string[];
  mustReuseFeatureIds?: string[];
}

interface KernelBodyExpectation {
  bodyId: string;
  minTriangles: number;
  minFaces: number;
  minEdges: number;
  minVertices?: number;
  minNamedFaces?: number;
  minNamedEdges?: number;
  minNamedVertices?: number;
  maxTopologyDiagnostics?: number;
  topologyDiagnosticCodes?: string[];
  stableTopologyNames?: boolean;
  requiredFaceNames?: string[];
  requiredVertexNames?: string[];
}

interface CaseExpectation {
  rootKind: 'part';
  partCount: number;
  assemblyCount: number;
  datumCount: number;
  sketchCount: number;
  featureTypes: string[];
  parameterNames: string[];
  bodyIds: string[];
  kernelBodies: KernelBodyExpectation[];
}

interface CorpusCase {
  id: string;
  file: string;
  mutations: MutationStep[];
  expected: CaseExpectation;
}

interface CorpusManifest {
  version: number;
  cases: CorpusCase[];
}

interface PreparedVariant {
  id: string;
  document: JsonDocument;
  hash: string;
  mustEvaluateBodyIds: string[];
  mustEvaluateFeatureIds: string[];
  mustReuseFeatureIds: string[];
}

interface KernelGeometrySummary {
  valid?: boolean;
  brepValid?: boolean;
  solidCount?: number;
  volume?: number;
  faceCount?: number;
  edgeCount?: number;
}

interface KernelBodySummary {
  bodyId: string;
  triangleCount: number;
  faceNames: string[];
  edgeCount: number;
  edgeNames: string[];
  vertexCount: number;
  vertexNames: string[];
  topologyDiagnostics: Array<{ code?: string; reason?: string }>;
  geometry: KernelGeometrySummary | null;
  error: { message?: string } | null;
  lastValid: boolean;
}

interface KernelResponseSummary {
  kind: string;
  errors: Array<{ message?: string }>;
  warnings: Array<{ message?: string }>;
  evaluation: {
    evaluatedBodyIds?: string[];
    reusedBodyIds?: string[];
    evaluatedFeatureIds?: string[];
    reusedFeatureIds?: string[];
  } | null;
  bodies: KernelBodySummary[];
}

interface KernelVariantSummary {
  id: string;
  response: KernelResponseSummary;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..', '..');
const corpusDirectory = resolve(repositoryRoot, 'tests', 'cad-corpus');
const manifestPath = resolve(corpusDirectory, 'manifest.json');

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameArray(actual: string[], expected: string[], label: string): void {
  invariant(
    actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    `${label}: expected [${expected.join(', ')}], received [${actual.join(', ')}]`,
  );
}

function readManifest(): CorpusManifest {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CorpusManifest;
  invariant(manifest.version === 1, `unsupported CAD corpus manifest version: ${manifest.version}`);
  invariant(Array.isArray(manifest.cases) && manifest.cases.length >= 4, 'CAD corpus must contain at least four cases');
  const ids = new Set<string>();
  for (const entry of manifest.cases) {
    invariant(typeof entry.id === 'string' && entry.id.length > 0, 'CAD corpus case id is required');
    invariant(!ids.has(entry.id), `duplicate CAD corpus case id: ${entry.id}`);
    ids.add(entry.id);
    invariant(/^[a-z0-9-]+\.partmode\.json$/.test(entry.file), `${entry.id}: unsafe corpus filename`);
    invariant(Array.isArray(entry.mutations) && entry.mutations.length > 0, `${entry.id}: mutations are required`);
    invariant(entry.expected.rootKind === 'part', `${entry.id}: this runner currently accepts part roots only`);
    invariant(entry.expected.bodyIds.length > 0, `${entry.id}: expected body ids are required`);
    sameArray(
      entry.expected.kernelBodies.map((body) => body.bodyId),
      entry.expected.bodyIds,
      `${entry.id}: kernel/body manifest alignment`,
    );
  }
  return manifest;
}

function applyMutation(document: JsonDocument, mutation: ParameterMutation, caseId: string, stepId: string): void {
  let parameters: Array<{ name?: string; value?: number | string }>;
  if (mutation.scope === 'project') {
    parameters = document.parameters as Array<{ name?: string; value?: number | string }>;
  } else {
    const partId = mutation.scope.slice('part:'.length);
    const parts = document.partDefinitions as JsonDocument[];
    const part = parts.find((candidate) => candidate.id === partId);
    invariant(part, `${caseId}/${stepId}: mutation references missing part ${partId}`);
    parameters = part.parameters as Array<{ name?: string; value?: number | string }>;
  }
  invariant(Array.isArray(parameters), `${caseId}/${stepId}: mutation scope has no parameter array`);
  const matches = parameters.filter((parameter) => parameter.name === mutation.name);
  invariant(matches.length === 1, `${caseId}/${stepId}: parameter ${mutation.name} did not resolve exactly once`);
  const parameter = matches[0];
  invariant(parameter, `${caseId}/${stepId}: parameter ${mutation.name} is unavailable`);
  parameter.value = mutation.value;
}

function assertDocumentManifest(document: JsonDocument, entry: CorpusCase, variantId: string): void {
  const label = `${entry.id}/${variantId}`;
  const expected = entry.expected;
  invariant(document.schemaVersion === 5, `${label}: schemaVersion is not 5`);
  invariant(document.rootDocument?.kind === expected.rootKind, `${label}: root kind changed`);
  invariant(document.partDefinitions.length === expected.partCount, `${label}: part count changed`);
  invariant(document.assemblyDefinitions.length === expected.assemblyCount, `${label}: assembly count changed`);
  const rootPart = document.partDefinitions.find(
    (part: JsonDocument) => part.id === document.rootDocument.partId,
  ) as JsonDocument | undefined;
  invariant(rootPart, `${label}: root part is missing`);
  invariant(rootPart.referenceGeometry.length === expected.datumCount, `${label}: datum count changed`);
  invariant(rootPart.sketches.length === expected.sketchCount, `${label}: sketch count changed`);
  sameArray(rootPart.features.map((feature: JsonDocument) => feature.type), expected.featureTypes, `${label}: feature types`);
  sameArray(document.parameters.map((parameter: JsonDocument) => parameter.name), expected.parameterNames, `${label}: parameters`);
  sameArray(rootPart.bodies.map((body: JsonDocument) => body.id), expected.bodyIds, `${label}: bodies`);
  sameArray(rootPart.featureOrder, rootPart.features.map((feature: JsonDocument) => feature.id), `${label}: feature order`);
}

async function prepareCases(
  manifest: CorpusManifest,
): Promise<Array<{ entry: CorpusCase; variants: PreparedVariant[] }>> {
  const projectModule = await import(pathToFileURL(resolve(repositoryRoot, 'src', 'static', 'studio-project-v5.js')).href);
  const runtimeModule = await import(pathToFileURL(resolve(repositoryRoot, 'src', 'static', 'studio-v5-runtime-document.js')).href);
  const prepareStudioV5Project = projectModule.prepareStudioV5Project as (candidate: JsonDocument) => JsonDocument;
  const parseStudioV5Project = projectModule.parseStudioV5Project as (text: string) => JsonDocument;
  const canonicalStudioV5Project = runtimeModule.canonicalStudioV5Project as (candidate: JsonDocument) => JsonDocument;
  const studioV5CanonicalHash = runtimeModule.studioV5CanonicalHash as (candidate: JsonDocument) => string;
  const preparedCases: Array<{ entry: CorpusCase; variants: PreparedVariant[] }> = [];

  for (const entry of manifest.cases) {
    const sourceText = readFileSync(resolve(corpusDirectory, entry.file), 'utf8');
    const sourceDocument = JSON.parse(sourceText) as JsonDocument;
    const sourceSnapshot = JSON.stringify(sourceDocument);
    const working = clone(sourceDocument);
    const variants: PreparedVariant[] = [];
    const expectedHashSequence: string[] = [];
    const definitions: Array<{ id: string; step?: MutationStep }> = [
      { id: 'base' },
      ...entry.mutations.map((step) => ({ id: step.id, step })),
    ];

    for (const definition of definitions) {
      for (const mutation of definition.step?.set ?? []) {
        applyMutation(working, mutation, entry.id, definition.id);
      }
      const workingSnapshot = JSON.stringify(working);
      const prepared = prepareStudioV5Project(clone(working));
      invariant(JSON.stringify(working) === workingSnapshot, `${entry.id}/${definition.id}: schema preparation mutated its input`);
      const preparedAgain = prepareStudioV5Project(clone(prepared));
      invariant(JSON.stringify(preparedAgain) === JSON.stringify(prepared), `${entry.id}/${definition.id}: schema canonicalization is not idempotent`);
      const parsedAgain = parseStudioV5Project(JSON.stringify(prepared));
      invariant(JSON.stringify(parsedAgain) === JSON.stringify(prepared), `${entry.id}/${definition.id}: JSON round-trip changed the document`);
      const runtimeCanonical = canonicalStudioV5Project(prepared);
      invariant(JSON.stringify(runtimeCanonical) === JSON.stringify(prepared), `${entry.id}/${definition.id}: runtime canonicalization changed the document`);
      const hash = studioV5CanonicalHash(prepared);
      invariant(/^[0-9a-f]{64}$/.test(hash), `${entry.id}/${definition.id}: canonical hash is not SHA-256`);
      invariant(studioV5CanonicalHash(runtimeCanonical) === hash, `${entry.id}/${definition.id}: canonical hash is unstable`);
      if (expectedHashSequence.length > 0) {
        invariant(!expectedHashSequence.includes(hash), `${entry.id}/${definition.id}: parameter mutation did not change the canonical document hash`);
      }
      assertDocumentManifest(prepared, entry, definition.id);
      expectedHashSequence.push(hash);
      variants.push({
        id: definition.id,
        document: prepared,
        hash,
        mustEvaluateBodyIds: definition.step?.mustEvaluateBodyIds ?? entry.expected.bodyIds,
        mustEvaluateFeatureIds: definition.step?.mustEvaluateFeatureIds ?? [],
        mustReuseFeatureIds: definition.step?.mustReuseFeatureIds ?? [],
      });
    }

    const replay = clone(sourceDocument);
    const replayHashes: string[] = [studioV5CanonicalHash(prepareStudioV5Project(clone(replay)))];
    for (const step of entry.mutations) {
      for (const mutation of step.set) applyMutation(replay, mutation, entry.id, `replay-${step.id}`);
      replayHashes.push(studioV5CanonicalHash(prepareStudioV5Project(clone(replay))));
    }
    sameArray(replayHashes, expectedHashSequence, `${entry.id}: deterministic mutation replay hashes`);
    invariant(JSON.stringify(sourceDocument) === sourceSnapshot, `${entry.id}: corpus source object was mutated`);
    preparedCases.push({ entry, variants });
    console.log(`schema ${entry.id}: ${variants.length} deterministic variants OK`);
  }
  return preparedCases;
}

async function runKernelCase(page: Page, entry: CorpusCase, variants: PreparedVariant[]): Promise<KernelVariantSummary[]> {
  return page.evaluate(async (input) => {
    const studioScript = document.querySelector<HTMLScriptElement>('script[src*="/studio.js"]');
    if (!studioScript) throw new Error('versioned Studio entrypoint is missing');
    const assetBase = new URL('.', studioScript.src).href;
    const worker = new Worker(`${assetBase}studio-kernel.worker.js`, { type: 'module' });
    let revision = 0;
    try {
      const summaries = [];
      for (const variant of input.variants) {
        revision += 1;
        const requestId = `cad-corpus-${input.caseId}-${revision}`;
        const response = await new Promise<Record<string, any>>((resolveResponse, rejectResponse) => {
          const timeout = setTimeout(
            () => rejectResponse(new Error(`${input.caseId}/${variant.id} timed out in the exact CAD worker`)),
            120_000,
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
          });
        });
        summaries.push({
          id: variant.id,
          response: {
            kind: String(response.kind || ''),
            errors: Array.isArray(response.errors) ? response.errors.map((error) => ({ message: error?.message })) : [],
            warnings: Array.isArray(response.warnings) ? response.warnings.map((warning) => ({ message: warning?.message })) : [],
            evaluation: response.evaluation
              ? {
                  evaluatedBodyIds: [...(response.evaluation.evaluatedBodyIds || [])],
                  reusedBodyIds: [...(response.evaluation.reusedBodyIds || [])],
                  evaluatedFeatureIds: [...(response.evaluation.evaluatedFeatureIds || [])],
                  reusedFeatureIds: [...(response.evaluation.reusedFeatureIds || [])],
                }
              : null,
            bodies: Array.isArray(response.bodies)
              ? response.bodies.map((body) => ({
                  bodyId: String(body.bodyId || ''),
                  triangleCount: body.mesh?.triangles?.length ? body.mesh.triangles.length / 3 : 0,
                  faceNames: Array.isArray(body.mesh?.topologyFaces)
                    ? body.mesh.topologyFaces
                        .map((face: Record<string, any>) => face?.name)
                        .filter((name: unknown): name is string => typeof name === 'string')
                        .sort()
                    : [],
                  edgeCount: Array.isArray(body.mesh?.edges) ? body.mesh.edges.length : 0,
                  edgeNames: Array.isArray(body.mesh?.edges)
                    ? body.mesh.edges
                        .map((edge: Record<string, any>) => edge?.name)
                        .filter((name: unknown): name is string => typeof name === 'string')
                        .sort()
                    : [],
                  vertexCount: Array.isArray(body.mesh?.topologyVertices)
                    ? body.mesh.topologyVertices.length
                    : 0,
                  vertexNames: Array.isArray(body.mesh?.topologyVertices)
                    ? body.mesh.topologyVertices
                        .map((vertex: Record<string, any>) => vertex?.name)
                        .filter((name: unknown): name is string => typeof name === 'string')
                        .sort()
                    : [],
                  topologyDiagnostics: Array.isArray(body.mesh?.topologyDiagnostics)
                    ? body.mesh.topologyDiagnostics.map((diagnostic: Record<string, any>) => ({
                        code: typeof diagnostic?.code === 'string' ? diagnostic.code : undefined,
                        reason: typeof diagnostic?.reason === 'string' ? diagnostic.reason : undefined,
                      }))
                    : [],
                  geometry: body.geometry
                    ? {
                        valid: body.geometry.valid,
                        brepValid: body.geometry.brepValid,
                        solidCount: body.geometry.solidCount,
                        volume: body.geometry.volume,
                        faceCount: body.geometry.faceCount,
                        edgeCount: body.geometry.edgeCount,
                      }
                    : null,
                  error: body.error ? { message: body.error.message } : null,
                  lastValid: body.lastValid === true,
                }))
              : [],
          },
        });
      }
      return summaries;
    } finally {
      worker.terminate();
    }
  }, {
    caseId: entry.id,
    variants: variants.map((variant) => ({ id: variant.id, document: variant.document })),
  }) as Promise<KernelVariantSummary[]>;
}

function assertKernelManifest(
  entry: CorpusCase,
  variants: PreparedVariant[],
  results: KernelVariantSummary[],
): void {
  invariant(results.length === variants.length, `${entry.id}: exact worker returned the wrong variant count`);
  const baselineTopologyNames = new Map<string, { faces: string[]; edges: string[]; vertices: string[] }>();
  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    const result = results[index];
    invariant(variant && result, `${entry.id}: missing exact-worker result at variant ${index}`);
    const label = `${entry.id}/${variant.id}`;
    invariant(result.id === variant.id, `${label}: exact-worker response order changed`);
    invariant(result.response.kind === 'rebuild-result', `${label}: worker did not return rebuild-result`);
    invariant(result.response.errors.length === 0, `${label}: kernel errors: ${result.response.errors.map((error) => error.message).join('; ')}`);
    invariant(result.response.warnings.length === 0, `${label}: kernel warnings: ${result.response.warnings.map((warning) => warning.message).join('; ')}`);
    sameArray(result.response.bodies.map((body) => body.bodyId), entry.expected.bodyIds, `${label}: worker bodies`);
    const evaluated = new Set(result.response.evaluation?.evaluatedBodyIds ?? []);
    for (const bodyId of variant.mustEvaluateBodyIds) {
      invariant(evaluated.has(bodyId), `${label}: mutation did not evaluate required body ${bodyId}`);
    }
    const evaluatedFeatures = new Set(result.response.evaluation?.evaluatedFeatureIds ?? []);
    const reusedFeatures = new Set(result.response.evaluation?.reusedFeatureIds ?? []);
    for (const featureId of variant.mustEvaluateFeatureIds) {
      invariant(evaluatedFeatures.has(featureId), `${label}: dirty subgraph did not evaluate required feature ${featureId}`);
      invariant(!reusedFeatures.has(featureId), `${label}: feature ${featureId} was both evaluated and reported reused`);
    }
    for (const featureId of variant.mustReuseFeatureIds) {
      invariant(reusedFeatures.has(featureId), `${label}: unchanged feature checkpoint ${featureId} was not reused`);
      invariant(!evaluatedFeatures.has(featureId), `${label}: reused feature ${featureId} was replayed`);
    }
    for (const expectedBody of entry.expected.kernelBodies) {
      const body = result.response.bodies.find((candidate) => candidate.bodyId === expectedBody.bodyId);
      invariant(body, `${label}: expected body ${expectedBody.bodyId} is missing`);
      invariant(!body.error, `${label}/${body.bodyId}: ${body.error?.message ?? 'body error'}`);
      invariant(!body.lastValid, `${label}/${body.bodyId}: worker fell back to last-valid geometry`);
      invariant(body.geometry, `${label}/${body.bodyId}: exact geometry manifest is missing`);
      invariant(body.geometry.valid === true, `${label}/${body.bodyId}: geometry is not valid`);
      invariant(body.geometry.brepValid === true, `${label}/${body.bodyId}: B-rep analyzer rejected the shape`);
      invariant(body.geometry.solidCount === 1, `${label}/${body.bodyId}: expected exactly one solid`);
      invariant(typeof body.geometry.volume === 'number' && body.geometry.volume > 1e-8, `${label}/${body.bodyId}: volume is not positive`);
      invariant((body.geometry.faceCount ?? 0) >= expectedBody.minFaces, `${label}/${body.bodyId}: face count fell below ${expectedBody.minFaces}`);
      invariant((body.geometry.edgeCount ?? 0) >= expectedBody.minEdges, `${label}/${body.bodyId}: edge count fell below ${expectedBody.minEdges}`);
      invariant(body.triangleCount >= expectedBody.minTriangles, `${label}/${body.bodyId}: triangle count fell below ${expectedBody.minTriangles}`);
      invariant(body.vertexCount >= (expectedBody.minVertices ?? 0), `${label}/${body.bodyId}: exact vertex count fell below ${expectedBody.minVertices}`);
      invariant(body.faceNames.length >= (expectedBody.minNamedFaces ?? 0), `${label}/${body.bodyId}: named face count fell below ${expectedBody.minNamedFaces}`);
      invariant(body.edgeNames.length >= (expectedBody.minNamedEdges ?? 0), `${label}/${body.bodyId}: named edge count fell below ${expectedBody.minNamedEdges}`);
      invariant(body.vertexNames.length >= (expectedBody.minNamedVertices ?? 0), `${label}/${body.bodyId}: named vertex count fell below ${expectedBody.minNamedVertices}`);
      if (expectedBody.maxTopologyDiagnostics !== undefined) {
        invariant(
          body.topologyDiagnostics.length <= expectedBody.maxTopologyDiagnostics,
          `${label}/${body.bodyId}: topology diagnostics [${body.topologyDiagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.reason}`).join(', ')}] exceed ${expectedBody.maxTopologyDiagnostics}`,
        );
      }
      if (expectedBody.topologyDiagnosticCodes) {
        sameArray(
          body.topologyDiagnostics.map((diagnostic) => diagnostic.code || '').sort(),
          [...expectedBody.topologyDiagnosticCodes].sort(),
          `${label}/${body.bodyId}: explicit topology diagnostic codes`,
        );
      }
      if (expectedBody.stableTopologyNames) {
        const baseline = baselineTopologyNames.get(body.bodyId);
        if (!baseline) {
          baselineTopologyNames.set(body.bodyId, {
            faces: [...body.faceNames],
            edges: [...body.edgeNames],
            vertices: [...body.vertexNames],
          });
        } else {
          sameArray(body.faceNames, baseline.faces, `${label}/${body.bodyId}: persistent face-name set`);
          sameArray(body.edgeNames, baseline.edges, `${label}/${body.bodyId}: persistent edge-name set`);
          sameArray(body.vertexNames, baseline.vertices, `${label}/${body.bodyId}: persistent vertex-name set`);
        }
      }
      for (const faceName of expectedBody.requiredFaceNames ?? []) {
        invariant(
          body.faceNames.includes(faceName),
          `${label}/${body.bodyId}: persistent face ${faceName} is missing; received [${body.faceNames.join(', ')}]`,
        );
      }
      for (const vertexName of expectedBody.requiredVertexNames ?? []) {
        invariant(
          body.vertexNames.includes(vertexName),
          `${label}/${body.bodyId}: persistent vertex ${vertexName} is missing; received [${body.vertexNames.join(', ')}]`,
        );
      }
    }
    console.log(
      `kernel ${label}: ${result.response.bodies.length} exact bodies, ${result.response.bodies.reduce((total, body) => total + body.triangleCount, 0)} triangles, ${result.response.bodies.reduce((total, body) => total + body.faceNames.length, 0)} named faces, ${result.response.bodies.reduce((total, body) => total + body.edgeNames.length, 0)}/${result.response.bodies.reduce((total, body) => total + body.edgeCount, 0)} named edges, ${result.response.bodies.reduce((total, body) => total + body.vertexNames.length, 0)}/${result.response.bodies.reduce((total, body) => total + body.vertexCount, 0)} named vertices, diagnostics [${[...new Set(result.response.bodies.flatMap((body) => body.topologyDiagnostics.map((diagnostic) => diagnostic.code || 'UNKNOWN')))].sort().join(', ')}] OK`,
    );
  }
}

const manifest = readManifest();
const preparedCases = await prepareCases(manifest);
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-cad-corpus-'));
let local: RunningPartModeServer | undefined;
let browser: Browser | undefined;

try {
  local = await startPartModeServer({
    distDir: resolve(repositoryRoot, 'dist'),
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
  for (const preparedCase of preparedCases) {
    const results = await runKernelCase(page, preparedCase.entry, preparedCase.variants);
    assertKernelManifest(preparedCase.entry, preparedCase.variants, results);
  }
  console.log(`CAD regression corpus OK: ${manifest.cases.length} cases, ${preparedCases.reduce((total, entry) => total + entry.variants.length, 0)} exact rebuilds`);
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
