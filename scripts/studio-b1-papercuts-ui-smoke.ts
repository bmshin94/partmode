// B1 friction-log papercuts (Phase 3 polish pass), proven in a real browser:
// PM-UX-033 first-visit overlay sequencing (cookie banner before the template
// chooser, never simultaneous), PM-UX-034 constraint-add refusals surfaced in
// the panel's own error region, PM-UX-035 stable constraint-row targeting in
// document order with accessible add-form controls, PM-UX-036 the docked
// fillet/chamfer picker panel with a sane minimum width off the viewport
// centre, and PM-UX-037 overlapping-edge pick disambiguation by cycling.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import puppeteer, { type Browser, type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-b1-papercuts-ui-'));
const SOURCE_FEATURE_ID = 'feature-ui-b1-papercuts-plate';

const constraintSketch = {
  entities: [
    { id: 'anchor', kind: 'point', at: [0, 0], fixed: true },
    { id: 'defined-end', kind: 'point', at: [10, 2] },
    { id: 'defined-line', kind: 'line', a: 'anchor', b: 'defined-end' },
    { id: 'open-a', kind: 'point', at: [20, 10] },
    { id: 'open-b', kind: 'point', at: [30, 10] },
    { id: 'open-line', kind: 'line', a: 'open-a', b: 'open-b' },
    { id: 'circle-center', kind: 'point', at: [-10, 10], fixed: true },
    { id: 'defined-circle', kind: 'circle', center: 'circle-center', r: 3 },
  ],
  constraints: [
    { id: 'defined-horizontal', kind: 'horizontal', line: 'defined-line' },
    { id: 'defined-x', kind: 'horizontalDistance', a: 'anchor', b: 'defined-end', value: 10 },
    { id: 'defined-radius', kind: 'radius', circle: 'defined-circle', value: 3 },
  ],
};

function watchPage(page: Page): { pageErrors: string[]; consoleErrors: string[]; networkErrors: string[] } {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) =>
    networkErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`));
  page.on('response', (response) => {
    if (response.status() >= 400) networkErrors.push(`${response.status()} ${response.url()}`);
  });
  return { pageErrors, consoleErrors, networkErrors };
}

function assertNoBrowserErrors(label: string, watched: ReturnType<typeof watchPage>): void {
  const failures = [...watched.pageErrors, ...watched.consoleErrors, ...watched.networkErrors];
  assert.deepEqual(failures, [], `${label} reported browser errors: ${failures.join(' | ')}`);
}

async function waitForStudio(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
}

async function waitForSettlement(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    return studio
      && studio.appliedRevision() === studio.documentRevision()
      && studio.mode()?.kind === 'idle';
  }, { polling: 100, timeout: 180_000 });
}

async function clickVisible(page: Page, selector: string): Promise<void> {
  await page.waitForFunction((candidate) => {
    const element = document.querySelector(candidate) as HTMLElement | null;
    if (!element || element.hidden) return false;
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || bounds.width <= 0 || bounds.height <= 0) return false;
    if ((element as HTMLButtonElement).disabled) return false;
    const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return Boolean(target && (target === element || element.contains(target)));
  }, { polling: 50, timeout: 60_000 }, selector);
  const box = await (await page.$(selector))!.boundingBox();
  assert.ok(box, `click target lost its bounds: ${selector}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

let local: RunningPartModeServer | undefined;
let browser: Browser | undefined;

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
  assert.match(await browser.version(), /Chrome\//u, 'Puppeteer did not launch a real Chrome runtime');

  // --- Papercut 1: first-visit overlay sequencing ---------------------------
  const firstVisitContext = await browser.createBrowserContext();
  const firstVisitPage = await firstVisitContext.newPage();
  const firstVisitWatch = watchPage(firstVisitPage);
  await firstVisitPage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await firstVisitPage.evaluateOnNewDocument(() => {
    (window as any).__overlayOverlapObserved = false;
    const track = () => {
      const banner = document.getElementById('pm-cookie-banner');
      const welcome = document.getElementById('bw-welcome');
      if (banner && welcome && !banner.hidden && !welcome.hidden) {
        (window as any).__overlayOverlapObserved = true;
      }
      requestAnimationFrame(track);
    };
    requestAnimationFrame(track);
  });
  const firstResponse = await firstVisitPage.goto(local.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert.equal(firstResponse?.status(), 200, 'first-visit page did not return HTTP 200');
  await waitForStudio(firstVisitPage);
  await firstVisitPage.waitForFunction(() =>
    document.getElementById('bw-welcome')?.getAttribute('aria-busy') === 'false'
      && (document.getElementById('pm-cookie-banner') as HTMLElement | null)?.hidden === false,
  { polling: 50, timeout: 60_000 });
  const beforeDismissal = await firstVisitPage.evaluate(() => ({
    bannerHidden: (document.getElementById('pm-cookie-banner') as HTMLElement).hidden,
    welcomeHidden: (document.getElementById('bw-welcome') as HTMLElement).hidden,
    firstVisitFlag: localStorage.getItem('bw-studio-welcome-v1'),
    seededFlag: localStorage.getItem('bw-studio-v2-seeded'),
  }));
  assert.equal(beforeDismissal.firstVisitFlag, null, 'first-visit context is not clean');
  assert.equal(beforeDismissal.seededFlag, null, 'first-visit context is not clean');
  assert.equal(beforeDismissal.bannerHidden, false, 'cookie banner is not the first visible overlay');
  assert.equal(beforeDismissal.welcomeHidden, true,
    'template chooser rendered before the cookie banner was dismissed');
  await clickVisible(firstVisitPage, '#pm-cookie-essential');
  await firstVisitPage.waitForFunction(() =>
    (document.getElementById('pm-cookie-banner') as HTMLElement | null)?.hidden === true
      && (document.getElementById('bw-welcome') as HTMLElement | null)?.hidden === false,
  { polling: 50, timeout: 10_000 });
  assert.equal(await firstVisitPage.evaluate(() => (window as any).__overlayOverlapObserved), false,
    'cookie banner and template chooser were visible in the same frame');
  assert.match(await firstVisitPage.evaluate(() => document.cookie), /partmode_cookie_consent=essential-v1/u,
    'banner dismissal did not store the essential-only choice');
  // The chooser stays individually functional after the handoff.
  await clickVisible(firstVisitPage, '#bw-welcome-templates');
  await firstVisitPage.waitForFunction(() =>
    (document.getElementById('bw-templates') as HTMLDialogElement | null)?.open === true,
  { polling: 50, timeout: 30_000 });
  await clickVisible(firstVisitPage, '#bw-templates-close');
  await firstVisitPage.waitForFunction(() =>
    (document.getElementById('bw-templates') as HTMLDialogElement | null)?.open !== true
      && (document.getElementById('bw-welcome') as HTMLElement | null)?.hidden === false,
  { polling: 50, timeout: 10_000 });
  // A revisit with stored consent shows the chooser immediately, banner-free.
  await firstVisitPage.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForStudio(firstVisitPage);
  await firstVisitPage.waitForFunction(() =>
    document.getElementById('bw-welcome')?.getAttribute('aria-busy') === 'false',
  { polling: 50, timeout: 60_000 });
  const revisit = await firstVisitPage.evaluate(() => ({
    bannerHidden: (document.getElementById('pm-cookie-banner') as HTMLElement).hidden,
    welcomeHidden: (document.getElementById('bw-welcome') as HTMLElement).hidden,
    overlapObserved: (window as any).__overlayOverlapObserved,
  }));
  assert.equal(revisit.bannerHidden, true, 'stored consent did not keep the banner hidden on revisit');
  assert.equal(revisit.welcomeHidden, false, 'template chooser is not independently functional after consent');
  assert.equal(revisit.overlapObserved, false, 'revisit rendered both overlays in the same frame');
  assertNoBrowserErrors('overlay sequencing', firstVisitWatch);
  await firstVisitPage.close();
  await firstVisitContext.close();

  // --- Papercuts 2 and 3: constraint add refusals and row targeting ---------
  const editorContext = await browser.createBrowserContext();
  const page = await editorContext.newPage();
  const editorWatch = watchPage(page);
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('bw-studio-welcome-v1', '1');
    document.cookie = 'partmode_cookie_consent=essential-v1; Path=/';
  });
  const editorResponse = await page.goto(local.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert.equal(editorResponse?.status(), 200, 'editor page did not return HTTP 200');
  await waitForStudio(page);
  await waitForSettlement(page);
  await page.evaluate((sketch) => (window as any).__bwStudio.openConstrainedSketchForTest(sketch), constraintSketch);
  await page.waitForFunction(() => Boolean(document.getElementById('bw-sk-constraint-kind')),
    { polling: 50, timeout: 60_000 });

  const rowState = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#bw-sk-dims .sk-constraint-row')];
    const addForm = document.querySelector('.sk-constraint-create');
    return {
      rowIds: rows.map((row) => row.getAttribute('data-constraint-id')),
      deleteLabels: rows.map((row) => row.querySelector('button[data-cdel]')?.getAttribute('aria-label') || ''),
      kindLabel: document.getElementById('bw-sk-constraint-kind')?.getAttribute('aria-label'),
      addLabel: document.getElementById('bw-sk-constraint-add')?.getAttribute('aria-label'),
      operandLabels: [...(addForm?.querySelectorAll('[data-cfield]') || [])]
        .map((select) => select.getAttribute('aria-label') || ''),
      documentOrder: ((window as any).__bwStudio.sketchDraftForTest()?.sketch?.constrained?.constraints || [])
        .map((constraint: JsonRecord) => constraint.id),
    };
  });
  assert.deepEqual(rowState.rowIds, ['defined-horizontal', 'defined-x', 'defined-radius'],
    'constraint rows do not carry stable constraint ids in document order');
  assert.deepEqual(rowState.rowIds, rowState.documentOrder,
    'DOM row order does not equal the constraint list order');
  assert.equal(rowState.kindLabel, 'Constraint type', 'constraint kind select has no accessible name');
  assert.equal(rowState.addLabel, 'Add constraint', 'add button has no accessible name');
  assert.ok(rowState.operandLabels.length > 0 && rowState.operandLabels.every((label) => label.length > 0),
    `add-form operand selects lack accessible names: ${JSON.stringify(rowState.operandLabels)}`);
  assert.ok(rowState.deleteLabels.every((label) => label.startsWith('Delete ')),
    `row delete controls lack accessible names: ${JSON.stringify(rowState.deleteLabels)}`);

  // A conflicting driving dimension must be refused with the solver's actual
  // reason in the panel's error region, never as a silent no-op.
  await page.evaluate(() => {
    const kind = document.getElementById('bw-sk-constraint-kind') as HTMLSelectElement;
    kind.value = 'length';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() =>
    Boolean(document.querySelector('#bw-sk-constraint-fields [data-cfield="line"]'))
      && Boolean(document.querySelector('#bw-sk-constraint-fields [data-cvalue]')),
  { polling: 50, timeout: 10_000 });
  await page.evaluate(() => {
    const line = document.querySelector('#bw-sk-constraint-fields [data-cfield="line"]') as HTMLSelectElement;
    line.value = 'defined-line';
    const value = document.querySelector('#bw-sk-constraint-fields [data-cvalue]') as HTMLInputElement;
    value.value = '12';
  });
  await clickVisible(page, '#bw-sk-constraint-add');
  await page.waitForFunction(() =>
    (document.getElementById('bw-sk-constraint-error') as HTMLElement | null)?.hidden === false,
  { polling: 50, timeout: 10_000 });
  const refusal = await page.evaluate(() => {
    const region = document.getElementById('bw-sk-constraint-error') as HTMLElement;
    const bounds = region.getBoundingClientRect();
    return {
      role: region.getAttribute('role'),
      text: region.textContent || '',
      visible: bounds.width > 0 && bounds.height > 0 && getComputedStyle(region).display !== 'none',
      constraintCount: ((window as any).__bwStudio.sketchDraftForTest()?.sketch?.constrained?.constraints || []).length,
      rowCount: document.querySelectorAll('#bw-sk-dims .sk-constraint-row').length,
    };
  });
  assert.equal(refusal.role, 'alert', 'refusal region is not an alert region');
  assert.equal(refusal.visible, true, 'refusal region is not visibly rendered in the panel');
  assert.match(refusal.text, /^Constraint not added: /u, 'refusal region does not state the refusal');
  assert.match(refusal.text, /SKETCH_CONSTRAINT_SOLVE_FAILED/u, 'refusal region omits the solver code');
  assert.ok(refusal.text.length > 'Constraint not added: SKETCH_CONSTRAINT_SOLVE_FAILED: '.length,
    'refusal region omits the solver diagnostic reason');
  assert.equal(refusal.constraintCount, 3, 'refused add mutated the constraint list');
  assert.equal(refusal.rowCount, 3, 'refused add changed the rendered rows');

  // A subsequent valid add clears the error region and appends its row last.
  await page.evaluate(() => {
    const kind = document.getElementById('bw-sk-constraint-kind') as HTMLSelectElement;
    kind.value = 'parallel';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() =>
    document.querySelectorAll('#bw-sk-constraint-fields [data-cfield]').length === 2
      && (document.getElementById('bw-sk-constraint-error') as HTMLElement | null)?.hidden === true,
  { polling: 50, timeout: 10_000 });
  await page.evaluate(() => {
    const [first, second] = [...document.querySelectorAll('#bw-sk-constraint-fields [data-cfield]')] as HTMLSelectElement[];
    first!.value = 'defined-line';
    second!.value = 'open-line';
  });
  await clickVisible(page, '#bw-sk-constraint-add');
  await page.waitForFunction(() =>
    document.querySelectorAll('#bw-sk-dims .sk-constraint-row').length === 4,
  { polling: 50, timeout: 10_000 });
  const afterAdd = await page.evaluate(() => ({
    rowIds: [...document.querySelectorAll('#bw-sk-dims .sk-constraint-row')]
      .map((row) => row.getAttribute('data-constraint-id')),
    documentOrder: ((window as any).__bwStudio.sketchDraftForTest()?.sketch?.constrained?.constraints || [])
      .map((constraint: JsonRecord) => constraint.id),
    errorHidden: (document.getElementById('bw-sk-constraint-error') as HTMLElement | null)?.hidden,
  }));
  assert.deepEqual(afterAdd.rowIds, ['defined-horizontal', 'defined-x', 'defined-radius', 'constraint-parallel-1'],
    'rebuilt rows lost stable ids or document order after a successful add');
  assert.deepEqual(afterAdd.rowIds, afterAdd.documentOrder, 'rebuilt DOM row order diverged from the constraint list');
  assert.equal(afterAdd.errorHidden, true, 'successful add did not clear the panel error region');
  assertNoBrowserErrors('constraint editor', editorWatch);
  await page.close();
  await editorContext.close();

  // --- Papercuts 4 and 5: picker docking and overlap pick cycling -----------
  const pickerContext = await browser.createBrowserContext();
  const pickerPage = await pickerContext.newPage();
  const pickerWatch = watchPage(pickerPage);
  await pickerPage.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await pickerPage.evaluateOnNewDocument(() => {
    localStorage.setItem('bw-studio-welcome-v1', '1');
    document.cookie = 'partmode_cookie_consent=essential-v1; Path=/';
  });
  const pickerResponse = await pickerPage.goto(local.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert.equal(pickerResponse?.status(), 200, 'picker page did not return HTTP 200');
  await waitForStudio(pickerPage);
  await waitForSettlement(pickerPage);
  await pickerPage.evaluate(async (featureId) => {
    await (window as any).__bwStudio.commitHumanOperationsForTest('Seed thin overlap plate', [
      { kind: 'project.clear', input: {} },
      {
        kind: 'feature.extrude',
        input: {
          id: featureId,
          name: 'Thin overlap plate',
          sketch: { shapes: [{ id: 'shape-b1-papercuts-plate', kind: 'rect', x: 0, y: 0, w: 40, h: 24 }], z: 0 },
          plane: 'XY',
          height: 1,
          resultPolicy: { kind: 'new-body', bodyName: 'Thin overlap plate' },
        },
      },
    ]);
  }, SOURCE_FEATURE_ID);
  await waitForSettlement(pickerPage);
  const seededRevision = await pickerPage.evaluate(() => (window as any).__bwStudio.documentRevision());

  await clickVisible(pickerPage, '[data-workspace="solid"]');
  await clickVisible(pickerPage, 'button[data-feat="fillet"]');
  await pickerPage.waitForFunction(() =>
    (document.getElementById('bw-pick') as HTMLElement | null)?.hidden === false
      && (window as any).__bwStudio.mode()?.kind === 'picking-edges',
  { polling: 50, timeout: 60_000 });
  assert.equal(await pickerPage.$eval('#bw-pick-title', (element) => element.textContent), 'New fillet',
    'ribbon Fillet did not open the edge picker');

  const dock = await pickerPage.evaluate(() => {
    const stage = document.getElementById('bw-studio')!.getBoundingClientRect();
    const bar = document.getElementById('bw-pick')!.getBoundingClientRect();
    const box = (selector: string) => {
      const element = document.querySelector(selector) as HTMLElement | null;
      if (!element || element.hidden || getComputedStyle(element).display === 'none') return null;
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
    };
    const children = [...document.getElementById('bw-pick')!.children]
      .filter((child) => !(child as HTMLElement).hidden);
    const rowTops = new Set(children.map((child) => Math.round(child.getBoundingClientRect().top / 8)));
    return {
      stage: { left: stage.left, right: stage.right, top: stage.top, bottom: stage.bottom },
      bar: { left: bar.left, right: bar.right, top: bar.top, bottom: bar.bottom, width: bar.width, height: bar.height },
      cube: box('.ws-viewcube'),
      navRail: box('.ws-nav-rail'),
      controls: children.length,
      rows: rowTops.size,
    };
  });
  const overlaps = (left: JsonRecord | null, right: JsonRecord | null) => Boolean(left && right
    && left.left < right.right && right.left < left.right
    && left.top < right.bottom && right.top < left.bottom);
  const stageCentre = {
    x: (dock.stage.left + dock.stage.right) / 2,
    y: (dock.stage.top + dock.stage.bottom) / 2,
  };
  assert.ok(dock.bar.width >= 300, `picker panel narrower than its sane minimum width: ${dock.bar.width}px`);
  assert.ok(dock.rows < dock.controls,
    `picker panel renders one control per line (${dock.rows} rows for ${dock.controls} controls)`);
  assert.ok(dock.rows <= 4, `picker panel collapsed into a column: ${dock.rows} control rows`);
  assert.ok(
    stageCentre.x < dock.bar.left || stageCentre.x > dock.bar.right
      || stageCentre.y < dock.bar.top || stageCentre.y > dock.bar.bottom,
    'picker panel covers the viewport centre');
  assert.ok(dock.bar.right <= dock.stage.right + 1 && dock.stage.right - dock.bar.right <= 80,
    'picker panel is not docked to the right stage edge');
  assert.ok(dock.bar.top >= dock.stage.top && dock.bar.top - dock.stage.top <= 160,
    'picker panel is not docked to the upper stage band');
  assert.ok(!overlaps(dock.bar, dock.cube), 'picker panel overlaps the view cube');
  assert.ok(!overlaps(dock.bar, dock.navRail), 'picker panel overlaps the canvas navigation rail');

  // Locate a screen position where the plate's top and bottom contour edges
  // both fall inside the picker's trusted 1.2 mm click threshold.
  const overlapTarget = await pickerPage.evaluate(() => {
    const studio = (window as any).__bwStudio;
    studio.setViewForTest('top');
    studio.frame();
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[aria-label="3D modeling canvas"]');
    if (!canvas) throw new Error('3D modeling canvas is missing');
    const rect = canvas.getBoundingClientRect();
    for (let row = 10; row <= 190; row += 2) {
      for (let column = 10; column <= 190; column += 2) {
        const fx = column / 200;
        const fy = row / 200;
        const candidates = studio.pickCandidatesAt(fx, fy);
        if (candidates.length !== 2) continue;
        const [near, far] = candidates;
        if (!(near.sig?.l > 10) || !(far.sig?.l > 10)) continue;
        if (Math.abs(Number(near.sig.p?.[2]) - Number(far.sig.p?.[2])) < 0.5) continue;
        const x = rect.left + fx * rect.width;
        const y = rect.top + fy * rect.height;
        if (document.elementFromPoint(x, y) !== canvas) continue;
        return {
          x, y,
          nearZ: Number(near.sig.p[2]),
          farZ: Number(far.sig.p[2]),
          nearDistance: near.distance,
          farDistance: far.distance,
        };
      }
    }
    throw new Error('no screen position with exactly two overlapping contour edges was found');
  });
  assert.ok(overlapTarget.nearDistance < overlapTarget.farDistance,
    'overlap candidates are not ordered nearest first');

  const pickedState = () => pickerPage.evaluate(() => ({
    count: document.getElementById('bw-pick-count')?.textContent || '',
    cycle: (window as any).__bwStudio.pickCycleState(),
    pickedZ: (window as any).__bwStudio.pickedEdgeSignatures()
      .map((signature: JsonRecord) => Number(signature.p?.[2]))
      .sort((left: number, right: number) => left - right),
    message: document.getElementById('bw-studio-msg')?.textContent || '',
  }));

  await pickerPage.mouse.click(overlapTarget.x, overlapTarget.y);
  const afterFirst = await pickedState();
  assert.equal(afterFirst.count, '1 picked', 'first overlap click did not pick exactly one edge');
  assert.deepEqual(afterFirst.cycle, { index: 0, count: 2 }, 'first overlap click did not start a two-candidate cycle');
  assert.equal(afterFirst.pickedZ.length, 1, 'first overlap click picked more than one edge');
  assert.ok(Math.abs(afterFirst.pickedZ[0] - overlapTarget.nearZ) < 0.05,
    'first overlap click did not pick the nearest edge');
  assert.match(afterFirst.message, /Overlapping edges here: toggled edge 1 of 2/u,
    'overlap disambiguation is not announced');

  await pickerPage.mouse.click(overlapTarget.x, overlapTarget.y);
  const afterSecond = await pickedState();
  assert.equal(afterSecond.count, '2 picked', 'repeated click did not cycle to the second overlapping edge');
  assert.deepEqual(afterSecond.cycle, { index: 1, count: 2 }, 'repeated click did not advance the cycle');
  assert.deepEqual(afterSecond.pickedZ.map((z: number) => Math.round(z * 100) / 100),
    [overlapTarget.nearZ, overlapTarget.farZ].sort((left, right) => left - right)
      .map((z) => Math.round(z * 100) / 100),
    'cycling did not target the second overlapping edge');
  assert.match(afterSecond.message, /Overlapping edges here: toggled edge 2 of 2/u,
    'cycle position is not announced');

  await pickerPage.mouse.click(overlapTarget.x, overlapTarget.y);
  const afterThird = await pickedState();
  assert.equal(afterThird.count, '1 picked', 'third click did not wrap the cycle back to the first candidate');
  assert.deepEqual(afterThird.cycle, { index: 0, count: 2 }, 'third click did not wrap the cycle');
  assert.equal(afterThird.pickedZ.length, 1, 'third click left the wrong number of picked edges');
  assert.ok(Math.abs(afterThird.pickedZ[0] - overlapTarget.farZ) < 0.05,
    'wrapping the cycle did not keep the second overlapping edge picked');

  await clickVisible(pickerPage, '#bw-pick-cancel');
  await pickerPage.waitForFunction(() =>
    (document.getElementById('bw-pick') as HTMLElement | null)?.hidden === true
      && (window as any).__bwStudio.mode()?.kind === 'idle',
  { polling: 50, timeout: 30_000 });
  assert.equal(await pickerPage.evaluate(() => (window as any).__bwStudio.documentRevision()), seededRevision,
    'picker session mutated the document');
  assertNoBrowserErrors('picker docking and overlap cycling', pickerWatch);
  await pickerPage.close();
  await pickerContext.close();

  console.log(JSON.stringify({
    schema: 'partmode.b1-papercuts-ui-smoke/v1',
    browserBacked: true,
    chrome: await browser.version(),
    overlaySequencing: {
      bannerFirst: true,
      chooserAfterDismissal: true,
      neverSimultaneousFramesObserved: true,
      chooserFunctionalAfterConsent: true,
      revisitBannerFree: true,
    },
    constraintAdd: {
      refusalSurfaced: true,
      solverCode: 'SKETCH_CONSTRAINT_SOLVE_FAILED',
      refusalRegionRole: 'alert',
      silentNoOp: false,
      successClearsRegion: true,
    },
    constraintRows: {
      stableIds: true,
      domOrderEqualsDocumentOrder: true,
      accessibleAddFormControls: true,
      accessibleRowControls: true,
    },
    pickerDock: {
      minWidthPx: Math.round(dock.bar.width),
      controlRows: dock.rows,
      controls: dock.controls,
      coversViewportCentre: false,
      dockedTopRight: true,
    },
    overlapCycling: {
      candidateCount: 2,
      nearFirst: true,
      clickSequencePicked: ['near', 'near+far', 'far'],
      announced: true,
      documentUnchanged: true,
    },
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await local?.close().catch(() => {});
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
