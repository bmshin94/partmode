import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonDocument = Record<string, any>;

interface StepNormalizationModule {
  PARTMODE_STEP_CANONICAL_TIMESTAMP: string;
  normalizeStepHeaderText(source: string): string;
  normalizeStepExportBlob(blob: Blob): Promise<Blob>;
}

interface ExportCase {
  id: string;
  document: JsonDocument;
  bodyIds?: string[];
  delayBeforeMs?: number;
}

interface StepExportResult {
  id: string;
  errors: Array<Record<string, any>>;
  manifest: Record<string, any> | null;
  text: string;
  type: string;
}

const root = resolve(process.cwd());
const normalization = await import(pathToFileURL(
  resolve(root, 'src', 'static', 'studio-step-normalization.js'),
).href) as StepNormalizationModule;

const sampleStep = (timestamp: string): string => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('PartMode deterministic export regression'),'2;1');
FILE_NAME('customer-approved.step','${timestamp}',('Jane O''Brien'),('Example Org'),'Open CASCADE STEP processor','PartMode V8','Released by QA');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN_CC2'));
ENDSEC;
DATA;
#1=APPLICATION_CONTEXT('configuration controlled 3d design');
ENDSEC;
END-ISO-10303-21;
`;

const normalizedEarlier = normalization.normalizeStepHeaderText(sampleStep('2026-07-31T23:59:58'));
const normalizedLater = normalization.normalizeStepHeaderText(sampleStep('2026-08-01T00:00:03'));
assert.equal(normalizedEarlier, normalizedLater, 'wall-clock variants did not normalize to identical STEP bytes');
assert.match(normalizedEarlier, /FILE_NAME\('customer-approved\.step','2000-01-01T00:00:00'/);
assert.match(normalizedEarlier, /\('Jane O''Brien'\),\('Example Org'\),'Open CASCADE STEP processor','PartMode V8','Released by QA'/);
assert.equal(
  (normalizedEarlier.match(/2000-01-01T00:00:00/g) || []).length,
  1,
  'normalization changed more than the one FILE_NAME timestamp',
);
assert.equal(
  normalization.normalizeStepHeaderText(normalizedEarlier),
  normalizedEarlier,
  'STEP normalization is not idempotent',
);
await assert.rejects(
  normalization.normalizeStepExportBlob(new Blob(['not a STEP file'], { type: 'application/STEP' })),
  /exactly one HEADER/,
);
assert.throws(
  () => normalization.normalizeStepHeaderText(sampleStep('2026-08-01T00:00:03').replace('FILE_NAME', 'FILE_NAME_REMOVED')),
  /exactly one FILE_NAME/,
);
assert.throws(
  () => normalization.normalizeStepHeaderText(sampleStep('2026-08-01T00:00:03').replace(
    'FILE_SCHEMA',
    "FILE_NAME('duplicate.step','2026-08-01T00:00:04',('A'),('B'),'C','D','E');\nFILE_SCHEMA",
  )),
  /exactly one FILE_NAME/,
);

const partDocument = JSON.parse(readFileSync(
  resolve(root, 'tests', 'fixtures', 'three-body.json'),
  'utf8',
)) as JsonDocument;
const assemblyDocument = JSON.parse(readFileSync(
  resolve(root, 'tests', 'assembly-runtime', 'two-part-constrained.partmode.json'),
  'utf8',
)) as JsonDocument;
async function runWorkerExports(page: Page, cases: ExportCase[]): Promise<StepExportResult[]> {
  return page.evaluate(async (inputCases) => {
    const studioScript = document.querySelector<HTMLScriptElement>('script[src*="/studio.js"]');
    if (!studioScript) throw new Error('versioned Studio entrypoint is missing');
    const workerUrl = `${new URL('.', studioScript.src).href}studio-kernel.worker.js`;
    let revision = 0;
    const results = [];
    for (const input of inputCases) {
      if (input.delayBeforeMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, input.delayBeforeMs));
      revision += 1;
      const requestId = `step-determinism-${input.id}-${revision}`;
      const worker = new Worker(workerUrl, { type: 'module' });
      try {
        const response = await new Promise<Record<string, any>>((resolveResponse, rejectResponse) => {
          const timeout = setTimeout(() => rejectResponse(new Error(`${input.id}: STEP export timed out`)), 180_000);
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
            kind: 'export-step',
            requestId,
            projectId: input.document.projectId || input.id,
            revision,
            document: input.document,
            ...(input.bodyIds ? { bodyIds: input.bodyIds } : {}),
          });
        });
        results.push({
          id: input.id,
          errors: response.errors || [],
          manifest: response.manifest ? JSON.parse(JSON.stringify(response.manifest)) : null,
          text: response.blob ? await response.blob.text() : '',
          type: response.blob?.type || '',
        });
      } finally {
        worker.terminate();
      }
    }
    return results;
  }, cases) as Promise<StepExportResult[]>;
}

function assertCanonicalStep(result: StepExportResult): void {
  assert.equal(result.errors.length, 0, `${result.id}: export errors ${JSON.stringify(result.errors)}`);
  assert.equal(result.type.toLowerCase(), 'application/step', `${result.id}: unexpected MIME type ${result.type}`);
  assert.ok(result.text.length > 100, `${result.id}: STEP output is empty`);
  assert.match(result.text, /ISO-10303-21\s*;/i, `${result.id}: exchange-file start marker is missing`);
  assert.match(result.text, /\bHEADER\s*;/i, `${result.id}: HEADER section is missing`);
  assert.match(result.text, /\bDATA\s*;/i, `${result.id}: DATA section is missing`);
  assert.match(result.text, /END-ISO-10303-21\s*;/i, `${result.id}: exchange-file end marker is missing`);
  const fileNames = [...result.text.matchAll(
    /\bFILE_NAME\s*\(\s*'(?:[^']|'')*'\s*,\s*'((?:[^']|'')*)'/gi,
  )];
  assert.equal(fileNames.length, 1, `${result.id}: expected exactly one FILE_NAME entity`);
  assert.equal(
    fileNames[0]![1],
    normalization.PARTMODE_STEP_CANONICAL_TIMESTAMP,
    `${result.id}: FILE_NAME timestamp is not canonical`,
  );
}

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-step-determinism-'));
let local: RunningPartModeServer | undefined;
let browser: Browser | undefined;

try {
  local = await startPartModeServer({
    distDir: resolve(root, 'dist'),
    host: '127.0.0.1',
    port: 0,
    stateDir: resolve(temporaryDirectory, 'state'),
  });
  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 300_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const response = await page.goto(local.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert.equal(response?.status(), 200, `local PartMode page returned HTTP ${response?.status() ?? 0}`);

  const exports = await runWorkerExports(page, [
    { id: 'schema-5-part-first', document: partDocument, bodyIds: ['body-feature-housing'] },
    {
      id: 'schema-5-part-second',
      document: partDocument,
      bodyIds: ['body-feature-housing'],
      delayBeforeMs: 1_200,
    },
    {
      id: 'partial-assembly',
      document: assemblyDocument,
      bodyIds: ['occurrence-base:body-base-block'],
    },
    { id: 'structured-assembly', document: assemblyDocument },
  ]);
  exports.forEach(assertCanonicalStep);

  const firstPart = exports.find((entry) => entry.id === 'schema-5-part-first')!;
  const secondPart = exports.find((entry) => entry.id === 'schema-5-part-second')!;
  if (firstPart.text !== secondPart.text) {
    let mismatch = 0;
    while (mismatch < firstPart.text.length && firstPart.text[mismatch] === secondPart.text[mismatch]) mismatch += 1;
    throw new Error(
      `repeated schema-5 part exports differ at byte ${mismatch}; `
      + `first=${JSON.stringify(firstPart.text.slice(Math.max(0, mismatch - 120), mismatch + 120))}; `
      + `second=${JSON.stringify(secondPart.text.slice(Math.max(0, mismatch - 120), mismatch + 120))}`,
    );
  }
  const structured = exports.find((entry) => entry.id === 'structured-assembly')!;
  assert.equal(structured.manifest?.structuredHierarchy, true, 'complete assembly did not use structured STEP export');
  assert.match(structured.text, /\/\*PARTMODE_V8_MANIFEST:/, 'structured assembly manifest is missing');
  const partial = exports.find((entry) => entry.id === 'partial-assembly')!;
  assert.equal(partial.manifest?.structuredHierarchy, false, 'partial assembly unexpectedly used structured export');

  console.log(JSON.stringify({
    ok: true,
    canonicalTimestamp: normalization.PARTMODE_STEP_CANONICAL_TIMESTAMP,
    metadataPreserved: true,
    repeatedPartBytes: firstPart.text.length,
    productionPaths: exports.map((entry) => entry.id),
  }));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
