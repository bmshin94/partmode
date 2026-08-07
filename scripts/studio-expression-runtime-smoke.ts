import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type ElementHandle } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type AnyRecord = Record<string, any>;

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Studio expression runtime smoke failed: ${name}`);
}

function sameNumbers(actual: number[], expected: number[], label: string, tolerance = 2e-7): void {
  check(`${label} length`, actual.length === expected.length);
  actual.forEach((value, index) => check(
    `${label}[${index}] expected ${expected[index]}, received ${value}`,
    Math.abs(value - expected[index]!) <= tolerance,
  ));
}

function expectFailure(label: string, run: () => unknown): void {
  let failed = false;
  try { run(); } catch { failed = true; }
  check(`${label} fails closed`, failed);
}

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-expression-'));
const fixturePath = resolve(temporaryDirectory, 'equation-runtime.bomcad.json');
const runtimeUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-v5-runtime-document.js')).href;
const runtime = await import(runtimeUrl) as {
  createStudioV5RuntimePartProject: (options: AnyRecord) => AnyRecord;
};
const authoredX = 'if(wall >= 10mm, 2in, 1in)';
const fixture = runtime.createStudioV5RuntimePartProject({
  projectId: 'equation-runtime-proof',
  name: 'Equation runtime proof',
  units: 'mm',
  parameters: [{ name: 'wall', value: 10 }],
  features: [{
    id: 'equation-extrude',
    type: 'extrude',
    sketch: {
      z: 0,
      shapes: [{
        id: 'equation-profile',
        kind: 'rect',
        x: authoredX,
        y: 'sin(30deg) * 10mm',
        w: 'max(wall * 2, 0.5in)',
        h: 'sqrt((2cm)^2)',
      }],
    },
    h: '1in + 5mm',
    through: false,
  }],
});
writeFileSync(fixturePath, JSON.stringify(fixture));

let server: RunningPartModeServer | undefined;
let browser: Browser | undefined;

try {
  const expressionUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-expression.js')).href;
  const { evaluateStudioExpression, parseStudioExpression } = await import(expressionUrl) as {
    evaluateStudioExpression: (input: number | string, params?: AnyRecord) => number;
    parseStudioExpression: (input: number | string, options?: AnyRecord) => AnyRecord;
  };
  check('inch literal converts to millimetres', evaluateStudioExpression('2in + 5mm') === 55.8);
  check('radian literal converts to degrees', Math.abs(evaluateStudioExpression('pi rad') - 180) <= 1e-12);
  check('degree trigonometry is canonical', Math.abs(evaluateStudioExpression('sin(30deg)') - 0.5) <= 1e-12);
  check('inverse trigonometry returns degrees', Math.abs(evaluateStudioExpression('arcsin(0.5)') - 30) <= 1e-12);
  check('if comparison selects the exact branch', evaluateStudioExpression('if(wall > 5mm, 2in, 1in)', { wall: 10 }) === 50.8);
  check('functions and exponentiation compose', evaluateStudioExpression('max(sqrt(81), 2^3)') === 9);
  check('unary minus has conventional power precedence', evaluateStudioExpression('-2^2') === -4);
  check('existing parameter names override new constants', evaluateStudioExpression('pi + e', { pi: 4, e: 6 }) === 10);
  const parsed = parseStudioExpression('max(wall, stock) + 1mm', { allowedNames: new Set(['wall', 'stock']) });
  check('parameter dependencies are exact', JSON.stringify([...parsed.dependencies]) === JSON.stringify(['wall', 'stock']));
  expectFailure('unknown function', () => evaluateStudioExpression('fetch(1)'));
  expectFailure('unknown unit', () => evaluateStudioExpression('10parsecs'));
  expectFailure('non-finite function result', () => evaluateStudioExpression('sqrt(-1)'));
  expectFailure('wrong function arity', () => evaluateStudioExpression('if(1, 2)'));
  expectFailure('global-object syntax', () => evaluateStudioExpression('globalThis.constructor(1)'));

  server = await startPartModeServer({
    host: '127.0.0.1',
    port: 0,
    stateDir: resolve(temporaryDirectory, 'state'),
  });
  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 180_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('expression smoke page error:', error instanceof Error ? error.message : String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('expression smoke console error:', message.text());
  });
  page.on('requestfailed', (request) => console.error('expression smoke request failed:', request.url(), request.failure()?.errorText));
  page.on('response', (result) => {
    if (result.status() >= 400) console.error('expression smoke HTTP error:', result.status(), result.url());
  });
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  const response = await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  check('Studio page loads', response?.status() === 200);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { timeout: 120_000 });
  const input = await page.$('#bw-open-file') as ElementHandle<HTMLInputElement> | null;
  check('visible project input exists', input);
  await input.uploadFile(fixturePath);
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    return studio?.documentRevision() === studio?.appliedRevision()
      && studio?.bodyResults()?.length === 1
      && studio?.errors()?.length === 0;
  }, { polling: 50, timeout: 180_000 });

  const before = await page.evaluate(() => {
    const studio = (window as any).__bwStudio;
    const body = studio.bodyResults()[0];
    const row = document.querySelector('#bw-params .param-row') as HTMLElement | null;
    const name = row?.querySelector('[data-pname]') as HTMLInputElement | null;
    const value = row?.querySelector('[data-pval]') as HTMLInputElement | null;
    const add = document.querySelector('#bw-param-add') as HTMLButtonElement | null;
    return {
      bounds: body.geometry.bounds,
      volume: body.geometry.volume,
      parameterUi: {
        rowVisible: Boolean(row && row.getBoundingClientRect().width > 0 && row.getBoundingClientRect().height > 0),
        name: name?.value,
        value: value?.value,
        addVisible: Boolean(add && add.getBoundingClientRect().width > 0 && add.getBoundingClientRect().height > 0),
      },
      document: JSON.parse(studio.docJson()),
    };
  });
  sameNumbers(before.bounds[0], [40.8, -5, 0], 'initial minimum bounds');
  sameNumbers(before.bounds[1], [60.8, 15, 30.4], 'initial maximum bounds');
  check('exact B-rep volume uses evaluated dimensions', Math.abs(before.volume - 12160) <= 1e-6);
  check('global variable table row is visible', before.parameterUi.rowVisible && before.parameterUi.addVisible);
  check('global variable table shows exact value', before.parameterUi.name === 'wall' && before.parameterUi.value === '10');
  const savedPart = before.document.partDefinitions.find(
    (part: AnyRecord) => part.id === before.document.rootDocument.partId,
  );
  check('saved expressions remain authored text', savedPart.features[0].sketch.shapes[0].x === authoredX);

  const valueInput = await page.$('#bw-params [data-pval="0"]') as ElementHandle<HTMLInputElement> | null;
  check('visible global variable value input exists', valueInput);
  await page.$eval('#bw-params [data-pval="0"]', (element) => {
    const inputElement = element as HTMLInputElement;
    inputElement.value = '12';
    inputElement.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    const documentValue = JSON.parse(studio.docJson());
    return documentValue.parameters?.[0]?.value === 12
      && studio.documentRevision() === studio.appliedRevision()
      && studio.errors().length === 0;
  }, { polling: 50, timeout: 180_000 });

  const after = await page.evaluate(() => {
    const studio = (window as any).__bwStudio;
    return {
      bounds: studio.bodyResults()[0].geometry.bounds,
      volume: studio.bodyResults()[0].geometry.volume,
      value: (document.querySelector('#bw-params [data-pval="0"]') as HTMLInputElement | null)?.value,
      undoDepth: studio.undoDepth(),
    };
  });
  sameNumbers(after.bounds[0], [38.8, -5, 0], 'edited minimum bounds');
  sameNumbers(after.bounds[1], [62.8, 15, 30.4], 'edited maximum bounds');
  check('visible global variable edit persisted', after.value === '12');
  check('global variable edit is undoable', after.undoDepth > 0);
  check('global variable changed exact B-rep volume', Math.abs(after.volume - 14592) <= 1e-6 && after.volume !== before.volume);

  console.log(JSON.stringify({
    parser: {
      inchesMm: evaluateStudioExpression('2in + 5mm'),
      sin30: evaluateStudioExpression('sin(30deg)'),
      radiansDegrees: evaluateStudioExpression('pi rad'),
      dependencies: [...parsed.dependencies],
    },
    runtime: {
      initialBounds: before.bounds,
      editedBounds: after.bounds,
      visibleGlobalVariable: { name: before.parameterUi.name, initial: before.parameterUi.value, edited: after.value },
      exactBrepVolume: { initial: before.volume, edited: after.volume },
    },
  }));
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
