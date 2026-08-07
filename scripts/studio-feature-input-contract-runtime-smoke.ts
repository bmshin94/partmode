import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonDocument = Record<string, any>;

interface InvalidDocumentCase {
  id: string;
  code: string;
  document: JsonDocument;
}

interface WorkerSummary {
  id: string;
  kind: string;
  code: string | null;
  message: string;
  bodyCount: number;
  geometryCount: number;
  meshCount: number;
  exactBrepCount: number;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..', '..');
const sourceUrl = (path: string) => pathToFileURL(resolve(root, path)).href;
const projectBoundary: any = await import(sourceUrl('src/static/studio-project-v5.js'));
const runtime: any = await import(sourceUrl('src/static/studio-v5-runtime-document.js'));
const agent: any = await import(sourceUrl('src/static/studio-agent-service.js'));

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const load = (path: string): JsonDocument => JSON.parse(readFileSync(resolve(root, path), 'utf8')) as JsonDocument;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rootPart(document: JsonDocument): JsonDocument {
  const part = document.partDefinitions.find((entry: JsonDocument) => entry.id === document.rootDocument.partId);
  invariant(part, 'root part is missing');
  return part;
}

function feature(document: JsonDocument, id: string): JsonDocument {
  const matches = rootPart(document).features.filter((entry: JsonDocument) => entry.id === id);
  invariant(matches.length === 1, `feature ${id} did not resolve exactly once`);
  return matches[0]!;
}

function invalidFeatureCase(
  id: string,
  source: JsonDocument,
  featureId: string,
  code: string,
  mutate: (record: JsonDocument) => void,
): InvalidDocumentCase {
  const document = clone(source);
  mutate(feature(document, featureId));
  return { id, code, document };
}

interface RejectionDiagnostic {
  label: string;
  name: string;
  code: string | null;
}

function rejected(
  label: string,
  source: JsonDocument,
  expected: readonly [name: string, code: string | null],
  operation: () => unknown,
): RejectionDiagnostic {
  const before = JSON.stringify(source);
  let error: any = null;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  invariant(error instanceof Error, `${label}: operation did not reject`);
  invariant(typeof error.message === 'string' && error.message.length > 0, `${label}: rejection has no diagnostic`);
  assert.equal(JSON.stringify(source), before, `${label}: rejected operation mutated its source document`);
  const coded = error as Error & { code?: unknown };
  const actual = [coded.name, typeof coded.code === 'string' ? coded.code : null] as const;
  assert.deepEqual(actual, expected, `${label}: rejection identity changed`);
  return { label, name: actual[0], code: actual[1] };
}

const profilePattern = load('tests/cad-corpus/profile-pattern.partmode.json');
const filletShell = load('tests/cad-corpus/fillet-shell.partmode.json');
const sweepPath = load('tests/cad-corpus/sweep-path.partmode.json');
const loftSections = load('tests/cad-corpus/loft-sections.partmode.json');
const registered = load('tests/feature-registry-runtime/registered-features.partmode.json');
const bodyPatterns = load('tests/body-pattern-runtime/body-patterns.partmode.json');

const invalidCases: InvalidDocumentCase[] = [
  invalidFeatureCase('rect-zero-width', profilePattern, 'feature-pattern-stock', 'FEATURE_PROFILE_DIMENSION_INVALID', (record) => {
    record.sketch.shapes[0].w = 0;
  }),
  invalidFeatureCase('circle-negative-radius', profilePattern, 'feature-pattern-stock', 'FEATURE_PROFILE_DIMENSION_INVALID', (record) => {
    record.sketch.shapes = [{ id: 'invalid-circle', kind: 'circle', x: 0, y: 0, r: -2 }];
  }),
  invalidFeatureCase('pattern-count-below-range', profilePattern, 'feature-pattern-cut', 'FEATURE_SKETCH_PATTERN_COUNT_INVALID', (record) => {
    record.pattern.n = 1;
  }),
  invalidFeatureCase('pattern-count-fractional', profilePattern, 'feature-pattern-cut', 'FEATURE_SKETCH_PATTERN_COUNT_INVALID', (record) => {
    record.pattern.n = 2.5;
  }),
  invalidFeatureCase('pattern-count-above-range', profilePattern, 'feature-pattern-cut', 'FEATURE_SKETCH_PATTERN_COUNT_INVALID', (record) => {
    record.pattern.n = 101;
  }),
  invalidFeatureCase('extrude-zero-depth', profilePattern, 'feature-pattern-stock', 'FEATURE_EXTRUSION_DEPTH_INVALID', (record) => {
    record.h = 0;
  }),
  invalidFeatureCase('extrude-through-all', profilePattern, 'feature-pattern-stock', 'FEATURE_INPUT_STRUCTURE_INVALID', (record) => {
    record.through = true;
  }),
  invalidFeatureCase('blind-cut-zero-depth', profilePattern, 'feature-pattern-cut', 'FEATURE_EXTRUSION_DEPTH_INVALID', (record) => {
    record.through = false;
    record.h = 0;
  }),
  invalidFeatureCase('malformed-profile-plane', profilePattern, 'feature-pattern-stock', 'FEATURE_INPUT_STRUCTURE_INVALID', (record) => {
    record.plane = { kind: 'base', plane: 'AUTO' };
  }),
  invalidFeatureCase('ignored-classic-reversed', profilePattern, 'feature-pattern-stock', 'FEATURE_INPUT_STRUCTURE_INVALID', (record) => {
    delete record.extensions;
    record.reversed = true;
  }),
  invalidFeatureCase('fillet-zero-radius', filletShell, 'feature-edge-fillet', 'FEATURE_MODIFIER_RADIUS_INVALID', (record) => {
    record.r = 0;
  }),
  invalidFeatureCase('variable-fillet-zero-start', filletShell, 'feature-edge-fillet', 'FEATURE_MODIFIER_RADIUS_INVALID', (record) => {
    record.variableRadii = [{ edge: clone(record.edges[0]), startRadius: 0, endRadius: 2 }];
    record.tangentPropagation = false;
  }),
  invalidFeatureCase('shell-negative-thickness', filletShell, 'feature-open-shell', 'FEATURE_SHELL_THICKNESS_INVALID', (record) => {
    record.t = -1;
  }),
  invalidFeatureCase('sweep-zero-scale', sweepPath, 'feature-sweep-path', 'FEATURE_SWEEP_SCALE_INVALID', (record) => {
    record.scaleEnd = 0;
  }),
  invalidFeatureCase('sweep-controlled-twist', sweepPath, 'feature-sweep-path', 'FEATURE_INPUT_STRUCTURE_INVALID', (record) => {
    record.orientation = 'controlled-twist';
    record.twistAngle = 30;
  }),
  invalidFeatureCase('sweep-ignored-twist', sweepPath, 'feature-sweep-path', 'FEATURE_SWEEP_DOMAIN_INVALID', (record) => {
    record.twistAngle = 15;
  }),
  invalidFeatureCase('loft-string-start-index', loftSections, 'feature-loft-sections', 'FEATURE_INPUT_STRUCTURE_INVALID', (record) => {
    record.sections[0].startIndex = '0';
  }),
  invalidFeatureCase('loft-closed', loftSections, 'feature-loft-sections', 'FEATURE_INPUT_STRUCTURE_INVALID', (record) => {
    record.closed = true;
  }),
  invalidFeatureCase('loft-asymmetric-continuity', loftSections, 'feature-loft-sections', 'FEATURE_INPUT_STRUCTURE_INVALID', (record) => {
    record.continuity = { start: 'free', end: 'tangent' };
  }),
  invalidFeatureCase('draft-tangent-propagation', registered, 'feature-draft', 'FEATURE_INPUT_STRUCTURE_INVALID', (record) => {
    record.tangentPropagation = true;
  }),
  invalidFeatureCase('revolve-symmetric-contradiction', registered, 'feature-revolve', 'FEATURE_REVOLVE_ANGLE_INVALID', (record) => {
    record.symmetric = true;
    record.startAngle = 0;
  }),
  invalidFeatureCase('thicken-zero-thickness', registered, 'feature-thicken', 'FEATURE_THICKEN_THICKNESS_INVALID', (record) => {
    record.thickness = 0;
  }),
  invalidFeatureCase('copy-policy-contradiction', registered, 'feature-transform-copy', 'FEATURE_INPUT_STRUCTURE_INVALID', (record) => {
    record.resultPolicy = { kind: 'add', targetBodyIds: [record.sourceBodyId] };
    record.toolBodyIds = [];
    record.linked = false;
  }),
  invalidFeatureCase('copy-flip-outside-align', registered, 'feature-transform-copy', 'FEATURE_INPUT_STRUCTURE_INVALID', (record) => {
    record.transform.flip = true;
  }),
  invalidFeatureCase('split-consume-tools', registered, 'feature-split-outside', 'FEATURE_INPUT_STRUCTURE_INVALID', (record) => {
    record.keepTools = false;
  }),
];

const invalidDatum = clone(registered);
rootPart(invalidDatum).referenceGeometry.find((datum: JsonDocument) => datum.id === 'datum-draft-neutral').definition.mode = 'automatic';
invalidCases.push({ id: 'datum-unsupported-mode', code: 'INVALID_DATUM_DEFINITION', document: invalidDatum });

for (const testCase of invalidCases) {
  const before = JSON.stringify(testCase.document);
  assert.throws(
    () => projectBoundary.prepareStudioV5Project(testCase.document),
    (error: any) => error?.code === testCase.code,
    `${testCase.id}: prepare did not reject with ${testCase.code}`,
  );
  assert.equal(JSON.stringify(testCase.document), before, `${testCase.id}: prepare mutated rejected input`);
}

const creatorDiagnostics = [
  rejected('body pattern explicit null count', bodyPatterns, ['Error', null], () => runtime.createStudioV5BodyPattern(bodyPatterns, {
    id: 'pattern-invalid-null-count', name: 'Invalid pattern', kind: 'linear', sourceBodyId: 'body-pattern-source',
    directionDatumIds: ['datum-pattern-direction'], count: null,
  })),
  rejected('body pattern fractional count', bodyPatterns, ['Error', null], () => runtime.createStudioV5BodyPattern(bodyPatterns, {
    id: 'pattern-invalid-fractional-count', name: 'Invalid pattern', kind: 'linear', sourceBodyId: 'body-pattern-source',
    directionDatumIds: ['datum-pattern-direction'], count: 2.5,
  })),
  rejected('Loft string startIndex', loftSections, ['Error', null], () => runtime.createStudioV5LoftFeature(loftSections, {
    id: 'feature-invalid-loft', name: 'Invalid Loft',
    sections: [
      { sketchId: 'sketch-loft-base', startIndex: '0' },
      { sketchId: 'sketch-loft-mid', startIndex: 0 },
    ],
  })),
  rejected('datum unsupported mode', registered, ['StudioV5ProjectError', 'INVALID_DATUM_DEFINITION'], () => runtime.createStudioV5Datum(registered, {
    id: 'datum-invalid-mode', name: 'Invalid datum', kind: 'plane', definition: { mode: 'automatic' },
  })),
  rejected('datum explicit null offset', registered, ['StudioV5ProjectError', 'INVALID_EXPRESSION'], () => runtime.createStudioV5Datum(registered, {
    id: 'datum-invalid-offset', name: 'Invalid offset', kind: 'plane',
    definition: { mode: 'offset', referenceDatumId: 'datum-draft-neutral', offset: null },
  })),
  rejected('datum explicit null angle', registered, ['StudioV5ProjectError', 'INVALID_EXPRESSION'], () => runtime.createStudioV5Datum(registered, {
    id: 'datum-invalid-angle', name: 'Invalid angle', kind: 'plane',
    definition: { mode: 'angle', referenceDatumId: 'datum-draft-neutral', axisDatumId: 'datum-revolve-axis', angle: null },
  })),
  rejected('Sweep sampled controlled twist', sweepPath, ['Error', null], () => runtime.createStudioV5SweepFeature(sweepPath, {
    id: 'feature-invalid-sweep', name: 'Invalid Sweep', profileSketchId: 'sketch-sweep-profile',
    pathSketchId: 'sketch-sweep-path', orientation: 'controlled-twist', twistAngle: 20,
  })),
  rejected('Boolean Split tool consumption', registered, ['Error', null], () => runtime.createStudioV5BooleanSplit(registered, {
    id: 'split-invalid-consume', targetBodyId: 'body-split-target', toolBodyId: 'body-split-tool', keepTools: false,
  })),
  rejected('Move coerced into copy', registered, ['Error', null], () => runtime.createStudioV5TransformFeature(registered, {
    id: 'transform-invalid-copy', bodyId: 'body-transform-source', mode: 'move', copy: true,
    transform: { mode: 'move', translation: [1, 0, 0] },
  })),
];
assert.equal(creatorDiagnostics.length, 9, 'creator rejection coverage changed');

function transaction(id: string, kind: string, input: JsonDocument): JsonDocument {
  return { transactionId: id, label: id, atomic: true, operations: [{ kind, input }] };
}

const agentDiagnostics = [
  rejected('agent pattern null count', bodyPatterns, ['CadAgentError', 'DOCUMENT_VALIDATION_FAILED'], () => agent.applyCadTransaction(bodyPatterns, transaction(
    'agent-invalid-pattern', 'pattern.create', {
      id: 'pattern-agent-invalid', kind: 'linear', sourceBodyId: 'body-pattern-source',
      directionDatumIds: ['datum-pattern-direction'], count: null,
    },
  ))),
  rejected('agent Loft string startIndex', loftSections, ['CadAgentError', 'DOCUMENT_VALIDATION_FAILED'], () => agent.applyCadTransaction(loftSections, transaction(
    'agent-invalid-loft', 'feature.loft', {
      id: 'feature-agent-invalid-loft',
      sections: [
        { sketchId: 'sketch-loft-base', startIndex: '0' },
        { sketchId: 'sketch-loft-mid', startIndex: 0 },
      ],
    },
  ))),
  rejected('agent datum invalid mode', registered, ['CadAgentError', 'INVALID_DATUM_DEFINITION'], () => agent.applyCadTransaction(registered, transaction(
    'agent-invalid-datum', 'datum.create', {
      id: 'datum-agent-invalid', name: 'Invalid datum', datumKind: 'plane', definition: { mode: 'automatic' },
    },
  ))),
  rejected('agent tangent propagation', registered, ['CadAgentError', 'DOCUMENT_VALIDATION_FAILED'], () => agent.applyCadTransaction(registered, transaction(
    'agent-invalid-propagation', 'feature.draft', {
      id: 'feature-agent-invalid-draft', bodyId: 'body-draft', neutralPlaneDatumId: 'datum-draft-neutral',
      angle: 5, faceRefs: clone(feature(registered, 'feature-draft').faces), tangentPropagation: true,
    },
  ))),
];
assert.equal(agentDiagnostics.length, 4, 'agent rejection coverage changed');

async function runWorkerSequence(
  page: Page,
  variants: Array<{ id: string; document: JsonDocument }>,
): Promise<WorkerSummary[]> {
  return page.evaluate(async (input) => {
    const studioScript = document.querySelector<HTMLScriptElement>('script[src*="/studio.js"]');
    if (!studioScript) throw new Error('versioned Studio entrypoint is missing');
    const workerUrl = `${new URL('.', studioScript.src).href}studio-kernel.worker.js`;
    const worker = new Worker(workerUrl, { type: 'module' });
    const summaries: WorkerSummary[] = [];
    let revision = 0;
    try {
      for (const variant of input) {
        revision += 1;
        const requestId = `feature-input-${revision}`;
        const response = await new Promise<Record<string, any>>((resolveResponse, rejectResponse) => {
          const timeout = setTimeout(() => rejectResponse(new Error(`${variant.id}: worker timed out`)), 120_000);
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
            resolveResponse(data);
          };
          worker.addEventListener('message', onMessage);
          worker.postMessage({
            kind: 'rebuild', requestId, projectId: variant.document.projectId, revision,
            document: variant.document, includeExactBrep: true,
          });
        });
        const bodies = Array.isArray(response.bodies) ? response.bodies : [];
        summaries.push({
          id: variant.id,
          kind: String(response.kind || ''),
          code: typeof response.code === 'string' ? response.code : null,
          message: String(response.message || ''),
          bodyCount: bodies.length,
          geometryCount: bodies.filter((body: Record<string, any>) => body.geometry != null).length,
          meshCount: bodies.filter((body: Record<string, any>) => body.mesh != null).length,
          exactBrepCount: bodies.filter((body: Record<string, any>) => typeof body.exactBrep === 'string').length,
        });
      }
      return summaries;
    } finally {
      worker.terminate();
    }
  }, variants);
}

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-feature-input-contract-'));
let local: RunningPartModeServer | undefined;
let browser: Browser | undefined;

try {
  local = await startPartModeServer({
    distDir: resolve(root, 'dist'), host: '127.0.0.1', port: 0,
    stateDir: resolve(temporaryDirectory, 'state'),
  });
  const health = await fetch(new URL('/healthz', local.url));
  invariant(health.ok, `local PartMode health returned HTTP ${health.status}`);
  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 300_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const pageResponse = await page.goto(local.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  invariant(pageResponse?.status() === 200, `local PartMode page returned HTTP ${pageResponse?.status() ?? 0}`);

  const variants = [
    { id: invalidCases[0]!.id, document: invalidCases[0]!.document },
    { id: 'valid-baseline', document: profilePattern },
    ...invalidCases.slice(1).map((entry) => ({ id: entry.id, document: entry.document })),
  ];
  const workerResults = await runWorkerSequence(page, variants);
  const baseline = workerResults.find((entry) => entry.id === 'valid-baseline');
  invariant(baseline?.kind === 'rebuild-result', 'valid baseline did not reach the exact worker');
  invariant((baseline.exactBrepCount ?? 0) > 0 && (baseline.meshCount ?? 0) > 0, 'valid baseline emitted no exact geometry evidence');

  for (const testCase of invalidCases) {
    const result = workerResults.find((entry) => entry.id === testCase.id);
    invariant(result, `${testCase.id}: worker result is missing`);
    invariant(result.kind === 'kernel-error', `${testCase.id}: expected kernel-error, received ${result.kind}`);
    invariant(result.code === testCase.code, `${testCase.id}: expected ${testCase.code}, received ${result.code || 'no code'}`);
    invariant(result.bodyCount === 0 && result.geometryCount === 0 && result.meshCount === 0 && result.exactBrepCount === 0,
      `${testCase.id}: rejected persisted intent exposed body, geometry, mesh, or BREP evidence`);
  }

  console.log(JSON.stringify({
    prepareRejected: invalidCases.map(({ id, code }) => ({ id, code })),
    coldWorkerRejected: invalidCases[0]!.id,
    warmWorkerRejected: invalidCases.slice(1).length,
    workerGeometryOnRejectedIntent: 0,
    creatorDiagnostics,
    agentDiagnostics,
  }));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
