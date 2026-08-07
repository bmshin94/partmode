import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import puppeteer, { type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-drawing-derived-ui-'));
const fixture = JSON.parse(await readFile(
  resolve(repositoryRoot, 'tests', 'fixtures', 'three-body.json'),
  'utf8',
));

let local: RunningPartModeServer | undefined;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

async function clickVisible(page: Page, selector: string): Promise<void> {
  const control = await page.$(selector);
  assert.ok(control, `visible control is missing: ${selector}`);
  try {
    const state = await control.evaluate((element) => ({
      connected: element.isConnected,
      disabled: element instanceof HTMLButtonElement && element.disabled,
      ariaDisabled: element.getAttribute('aria-disabled'),
      hidden: element instanceof HTMLElement && (element.hidden || getComputedStyle(element).visibility === 'hidden'),
    }));
    assert.equal(state.connected, true, `control is detached: ${selector}`);
    assert.equal(state.disabled, false, `control is disabled: ${selector}`);
    assert.notEqual(state.ariaDisabled, 'true', `control is aria-disabled: ${selector}`);
    assert.equal(state.hidden, false, `control is hidden: ${selector}`);
    await control.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
    const box = await control.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, `control has no hit-test bounds: ${selector}`);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const ownsHitTarget = await control.evaluate((element, location) => {
      const target = document.elementFromPoint(location.x, location.y);
      return Boolean(target && (target === element || element.contains(target)));
    }, point);
    assert.equal(ownsHitTarget, true, `control does not own its center hit target: ${selector}`);
    await page.mouse.click(point.x, point.y);
  } finally {
    await control.dispose();
  }
}

async function replaceInput(page: Page, selector: string, value: string): Promise<void> {
  const control = await page.$(selector);
  assert.ok(control, `editable form control is missing: ${selector}`);
  try {
    const visible = await control.evaluate((element) => element instanceof HTMLElement
      && !element.hidden && getComputedStyle(element).visibility !== 'hidden');
    const box = await control.boundingBox();
    assert.equal(visible, true, `editable form control is hidden: ${selector}`);
    assert.ok(box && box.width > 0 && box.height > 0, `editable form control has no visible bounds: ${selector}`);
    await control.evaluate((element, nextValue) => {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        throw new Error(`expected an editable form control: ${element.id}`);
      }
      element.value = nextValue;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  } finally {
    await control.dispose();
  }
}

async function waitForSettledProject(page: Page, projectId: string): Promise<void> {
  try {
    await page.waitForFunction(
      (expectedProjectId) => {
        const studio = (window as any).__bwStudio;
        return studio?.projectId?.() === expectedProjectId
          && studio.appliedRevision() === studio.documentRevision()
          && studio.mode()?.kind === 'idle';
      },
      { polling: 100, timeout: 120_000 },
      projectId,
    );
  } catch (error) {
    const state = await page.evaluate(() => {
      const studio = (window as any).__bwStudio;
      return {
        present: Boolean(studio),
        projectId: studio?.projectId?.() ?? null,
        rootKind: studio?.rootKind?.() ?? null,
        documentRevision: studio?.documentRevision?.() ?? null,
        appliedRevision: studio?.appliedRevision?.() ?? null,
        mode: studio?.mode?.() ?? null,
        errors: studio?.errors?.() ?? [],
        message: document.getElementById('bw-studio-msg')?.textContent || '',
        rejected: studio?.rejectedActiveProjectForTest?.() ?? null,
      };
    });
    throw new Error(`derived-view fixture did not settle: ${JSON.stringify(state)}`, { cause: error });
  }
}

try {
  local = await startPartModeServer({
    distDir: resolve(repositoryRoot, 'dist'),
    host: '127.0.0.1',
    port: 0,
    stateDir: resolve(temporaryDirectory, 'state'),
  });
  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 300_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('bw-studio-welcome-v1', '1');
    (window as any).__partmodeDrawingRequests = [];
    const originalPostMessage = Worker.prototype.postMessage;
    (Worker.prototype as any).postMessage = function drawingRequestCapture(...args: any[]) {
      const request = args[0];
      if (request?.kind === 'drawing-v5') {
        (window as any).__partmodeDrawingRequests.push(structuredClone(request));
      }
      return (originalPostMessage as any).apply(this, args);
    };
  });
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(`pageerror: ${error instanceof Error ? error.message : String(error)}`));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (request) => failures.push(
    `requestfailed: ${request.url()} ${request.failure()?.errorText ?? 'unknown'}`,
  ));
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`response: ${response.status()} ${response.url()}`);
  });

  const response = await page.goto(local.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert.equal(response?.status(), 200, 'derived-view UI route did not return HTTP 200');
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await page.evaluate(async () => (window as any).__bwStudio.flushStorage());
  await page.evaluate(async (documentFixture) => {
    const database = await new Promise<IDBDatabase>((resolveOpen, rejectOpen) => {
      const request = indexedDB.open('partmode-studio', 1);
      request.addEventListener('success', () => resolveOpen(request.result), { once: true });
      request.addEventListener('error', () => rejectOpen(request.error), { once: true });
    });
    try {
      await new Promise<void>((resolveTransaction, rejectTransaction) => {
        const transaction = database.transaction(['meta', 'projects'], 'readwrite');
        transaction.objectStore('projects').put({
          projectId: documentFixture.projectId,
          title: documentFixture.name,
          document: documentFixture,
          commandRevision: 0,
          updatedAt: '2000-01-01T00:00:00.000Z',
        });
        transaction.objectStore('meta').put({ key: 'activeProjectId', value: documentFixture.projectId });
        transaction.addEventListener('complete', () => resolveTransaction(), { once: true });
        transaction.addEventListener('abort', () => rejectTransaction(transaction.error), { once: true });
        transaction.addEventListener('error', () => rejectTransaction(transaction.error), { once: true });
      });
    } finally {
      database.close();
    }
  }, fixture);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForSettledProject(page, fixture.projectId);
  assert.deepEqual(
    await page.evaluate(() => (window as any).__bwStudio.errors()),
    [],
    'derived-view UI fixture did not rebuild exactly',
  );

  await clickVisible(page, '#bw-export-pdf-open');
  const manager = await page.evaluate(() => {
    const dialog = document.getElementById('bw-drawing-pdf') as HTMLDialogElement | null;
    const add = document.getElementById('bw-drawing-derived-view-add') as HTMLButtonElement | null;
    const source = document.getElementById('bw-drawing-derived-view-source') as HTMLSelectElement | null;
    return {
      dialogOpen: Boolean(dialog?.open),
      addEnabled: Boolean(add && !add.disabled),
      sources: source ? [...source.options].map((option) => option.value) : [],
    };
  });
  assert.equal(manager.dialogOpen, true, 'drawing manager did not open visibly');
  assert.equal(manager.addEnabled, true, 'part derived-view lifecycle is disabled');
  assert.ok(manager.sources.includes('front'), 'visible manager omits the standard front source');

  await page.select('#bw-drawing-derived-view-kind', 'crop');
  await page.select('#bw-drawing-derived-view-source', 'front');
  await replaceInput(page, '#bw-drawing-derived-view-name', 'Visible crop acceptance');
  await page.select('#bw-drawing-derived-view-boundary-kind', 'rect');
  await replaceInput(page, '#bw-drawing-derived-view-boundary-x', '-5');
  await replaceInput(page, '#bw-drawing-derived-view-boundary-y', '-2');
  await replaceInput(page, '#bw-drawing-derived-view-boundary-width', '50');
  await replaceInput(page, '#bw-drawing-derived-view-boundary-height', '24');
  await clickVisible(page, '#bw-drawing-derived-view-add');
  await page.waitForFunction(() => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    return document.extensions?.drawingViews?.derivedViews?.length === 1;
  }, { polling: 100, timeout: 30_000 });
  let documentState = await page.evaluate(() => JSON.parse((window as any).__bwStudio.docJson()));
  const created = documentState.extensions.drawingViews.derivedViews[0];
  assert.equal(created.kind, 'crop', 'visible create persisted the wrong derived kind');
  assert.equal(created.sourceViewId, 'front', 'visible create persisted the wrong source view');

  await page.select('#bw-drawing-derived-view-select', created.id);
  await replaceInput(page, '#bw-drawing-derived-view-name', 'Visible crop acceptance updated');
  await clickVisible(page, '#bw-drawing-derived-view-update');
  await page.waitForFunction((viewId) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    return document.extensions?.drawingViews?.derivedViews
      ?.find((entry: any) => entry.id === viewId)?.name === 'Visible crop acceptance updated';
  }, { polling: 100, timeout: 30_000 }, created.id);

  await page.select('#bw-drawing-sheet-views', created.id);
  await clickVisible(page, '#bw-drawing-book-initialize');
  await page.waitForFunction((viewId) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    return document.extensions?.drawingBook?.sheets?.[0]?.views?.includes(viewId);
  }, { polling: 100, timeout: 30_000 }, created.id);

  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: temporaryDirectory,
  });
  await clickVisible(page, '#bw-drawing-pdf-download');
  await page.waitForFunction((viewId) => (window as any).__partmodeDrawingRequests.some((request: any) =>
    request.kind === 'drawing-v5'
      && request.views?.length === 1
      && request.views[0]?.id === viewId
      && request.views[0]?.derived?.kind === 'crop'),
  { polling: 100, timeout: 240_000 }, created.id);
  await page.waitForFunction(() => {
    const dialog = document.getElementById('bw-drawing-pdf') as HTMLDialogElement | null;
    return dialog && !dialog.open;
  }, { polling: 100, timeout: 240_000 });
  const exportState = await page.evaluate((viewId) => {
    const request = (window as any).__partmodeDrawingRequests.find((entry: any) =>
      entry.kind === 'drawing-v5' && entry.views?.[0]?.id === viewId);
    return {
      request,
      message: document.getElementById('bw-studio-msg')?.textContent || '',
    };
  }, created.id);
  assert.equal(exportState.request.views[0].derived.sourceViewId, 'front', 'visible export changed the persistent source');
  assert.deepEqual(
    exportState.request.views[0].derived.definition,
    created.definition,
    'visible export did not send the persistent derived definition',
  );
  assert.match(exportState.message, /1-sheet drawing PDF exported/u, 'visible PDF export did not finish successfully');

  await clickVisible(page, '#bw-export-pdf-open');
  await page.select('#bw-drawing-sheet-views', 'front');
  await clickVisible(page, '#bw-drawing-sheet-apply');
  await page.waitForFunction((viewId) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    const views = document.extensions?.drawingBook?.sheets?.[0]?.views || [];
    return views.includes('front') && !views.includes(viewId);
  }, { polling: 100, timeout: 30_000 }, created.id);
  await page.select('#bw-drawing-derived-view-select', created.id);
  await clickVisible(page, '#bw-drawing-derived-view-delete');
  await page.waitForFunction(() => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    return document.extensions?.drawingViews?.derivedViews?.length === 0;
  }, { polling: 100, timeout: 30_000 });
  documentState = await page.evaluate(() => JSON.parse((window as any).__bwStudio.docJson()));
  assert.deepEqual(documentState.extensions.drawingViews.derivedViews, [], 'visible delete left a derived record behind');
  assert.deepEqual(failures, [], `derived-view browser gate reported errors: ${failures.join(' | ')}`);

  console.log(JSON.stringify({
    browserBacked: true,
    visibleLifecycle: ['create', 'update', 'delete'],
    sheetPlacement: created.id,
    exactExportRequest: {
      kind: exportState.request.kind,
      viewId: exportState.request.views[0].id,
      derivedKind: exportState.request.views[0].derived.kind,
      sourceViewId: exportState.request.views[0].derived.sourceViewId,
    },
    pdfExportCompleted: true,
    consoleNetworkPageErrors: 0,
  }, null, 2));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
