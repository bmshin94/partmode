import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import puppeteer, { type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-structural-member-ui-'));
const PATH_ID = 'ui-structural-path';
const INVALID_PATH_ID = 'ui-invalid-structural-path';
const PATH_LENGTH = 120;
const HTML_LIKE_PATH_NAME = '<img src=x onerror="window.__wd001Injected=true"> UI structural Path';

function closeTo(actual: unknown, expected: number, tolerance = 1e-6): boolean {
  const value = Number(actual);
  return Number.isFinite(value) && Math.abs(value - expected) <= Math.max(tolerance, Math.abs(expected) * 1e-9);
}

function rootPart(document: JsonRecord): JsonRecord {
  const partId = document.rootDocument?.partId;
  const part = document.partDefinitions?.find((entry: JsonRecord) => entry.id === partId)
    || document.partDefinitions?.[0];
  assert.ok(part, 'browser document has no active part definition');
  return part;
}

async function readDocument(page: Page): Promise<JsonRecord> {
  return page.evaluate(() => JSON.parse((window as any).__bwStudio.docJson()));
}

async function readPart(page: Page): Promise<JsonRecord> {
  return rootPart(await readDocument(page));
}

async function waitForSettlement(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    return studio
      && studio.appliedRevision() === studio.documentRevision()
      && studio.mode()?.kind === 'idle';
  }, { polling: 100, timeout: 120_000 });
}

async function projectState(page: Page): Promise<JsonRecord> {
  return page.evaluate(() => {
    const studio = (window as any).__bwStudio;
    return {
      docJson: studio.docJson(),
      canonicalHash: studio.canonicalHash(),
      documentRevision: studio.documentRevision(),
      appliedRevision: studio.appliedRevision(),
      undoDepth: studio.undoDepth(),
      redoDepth: studio.redoDepth(),
      undoLabels: studio.undoLabels(),
    };
  });
}

async function assertHitTestable(page: Page, selector: string): Promise<void> {
  const control = await page.$(selector);
  assert.ok(control, `visible control is missing: ${selector}`);
  try {
    await control.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
    const box = await control.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, `control has no hit-test bounds: ${selector}`);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const state = await control.evaluate((element, location) => {
      if (!(element instanceof HTMLElement)) return { visible: false, owns: false };
      const style = getComputedStyle(element);
      const target = document.elementFromPoint(location.x, location.y);
      return {
        visible: !element.hidden && style.display !== 'none' && style.visibility !== 'hidden',
        owns: Boolean(target && (target === element || element.contains(target))),
      };
    }, point);
    assert.equal(state.visible, true, `control is hidden: ${selector}`);
    assert.equal(state.owns, true, `control does not own its center hit target: ${selector}`);
  } finally {
    await control.dispose();
  }
}

async function clickVisible(page: Page, selector: string): Promise<void> {
  await assertHitTestable(page, selector);
  const disabled = await page.$eval(selector, (element) =>
    (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement)
      && element.disabled);
  assert.equal(disabled, false, `control is disabled: ${selector}`);
  const control = await page.$(selector);
  assert.ok(control, `click target disappeared: ${selector}`);
  try {
    const box = await control.boundingBox();
    assert.ok(box, `click target lost its bounds: ${selector}`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  } finally {
    await control.dispose();
  }
}

async function replaceValue(page: Page, selector: string, value: string): Promise<void> {
  await assertHitTestable(page, selector);
  await page.$eval(selector, (element, nextValue) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      throw new Error(`expected editable input: ${element.id}`);
    }
    element.value = nextValue;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function waitForDialog(page: Page, open: boolean): Promise<void> {
  await page.waitForFunction((expectedOpen) =>
    (document.getElementById('bw-structural-member') as HTMLDialogElement | null)?.open === expectedOpen,
  { polling: 50, timeout: 30_000 }, open);
}

async function exactSettlement(page: Page, bodyId: string, expectedProfileEdges: number): Promise<JsonRecord> {
  await waitForSettlement(page);
  const settlement = await page.evaluate(async (expectedBodyId) => {
    const studio = (window as any).__bwStudio;
    const exact = await studio.exactBodyResultsForTest();
    return {
      exact,
      ordinary: studio.bodyResults().find((entry: any) => entry.bodyId === expectedBodyId) || null,
      body: exact.bodies.find((entry: any) => entry.bodyId === expectedBodyId) || null,
      canonicalHash: studio.canonicalHash(),
      documentRevision: studio.documentRevision(),
      appliedRevision: studio.appliedRevision(),
    };
  }, bodyId);
  assert.equal(settlement.documentRevision, settlement.appliedRevision, 'visible document is not currently settled');
  assert.equal(settlement.exact.revision, settlement.documentRevision, 'exact worker evidence is not current-revision evidence');
  assert.equal(settlement.exact.effectiveDocumentHash, settlement.canonicalHash,
    'exact worker evidence is not bound to the current canonical document hash');
  assert.deepEqual(settlement.exact.errors, [], 'isolated production-worker rebuild reported errors');
  assert.equal(settlement.body?.bodyId, bodyId, 'isolated production-worker rebuild omitted the member body');
  assert.equal(settlement.body?.error, null, 'isolated production-worker rebuild returned a body error');
  assert.equal(settlement.body?.geometry?.valid, true, 'structural member is not a valid exact solid');
  assert.equal(settlement.body?.geometry?.brepValid, true, 'structural member failed BRepCheck validation');
  assert.equal(settlement.body?.geometry?.solidCount, 1, 'structural member is not exactly one solid');
  assert.equal(settlement.body?.geometry?.faceCount, expectedProfileEdges + 2,
    'structural member exact face count does not match its profile prism');
  assert.equal(settlement.body?.geometry?.edgeCount, expectedProfileEdges * 3,
    'structural member exact edge count does not match its profile prism');
  assert.equal(settlement.body?.geometry?.vertexCount, expectedProfileEdges * 2,
    'structural member exact vertex count does not match its profile prism');
  assert.ok(typeof settlement.body?.exactBrep === 'string' && settlement.body.exactBrep.length > 100,
    'structural member has no canonical exact BREP evidence');
  assert.ok(settlement.body.geometry.volume > 0, 'structural member has no positive exact volume');
  assert.equal(settlement.ordinary?.bodyId, bodyId, 'visible settled body is missing');
  assert.deepEqual(settlement.ordinary?.geometry?.bounds, settlement.body.geometry.bounds,
    'visible and isolated-worker exact bounds disagree');
  assert.ok(closeTo(settlement.ordinary?.geometry?.volume, settlement.body.geometry.volume),
    'visible and isolated-worker exact volumes disagree');
  // The production rebuild serializes every schema-5 body with
  // requirePersistentTopology=true. A body error or missing exact BREP is the
  // fail-closed outcome when any exact face, edge, or vertex lacks a name.
  return settlement;
}

async function assertOpenRefused(page: Page, expectedMessage: RegExp): Promise<void> {
  await clickVisible(page, '#bw-structural-member-open');
  await page.waitForFunction(() => {
    const dialog = document.getElementById('bw-structural-member') as HTMLDialogElement | null;
    return dialog?.open !== true && Boolean(document.getElementById('bw-studio-msg')?.textContent?.trim());
  }, { polling: 50, timeout: 30_000 });
  const message = await page.$eval('#bw-studio-msg', (element) => element.textContent?.trim() || '');
  assert.match(message, expectedMessage, 'Structural member did not visibly explain the unavailable path');
}

let local: RunningPartModeServer | undefined;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

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
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => localStorage.setItem('bw-studio-welcome-v1', '1'));

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
  assert.equal(response?.status(), 200, 'structural-member UI route did not return HTTP 200');
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  await clickVisible(page, '[data-workspace="solid"]');
  await assertHitTestable(page, '#bw-structural-member-open');

  const registryAudit = await page.evaluate(async () => {
    const studioScript = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
    if (!studioScript) throw new Error('Cannot locate the built Studio module URL.');
    const registryUrl = new URL('studio-v6-ui-registry.js', studioScript.src).href;
    const registryModule = await import(registryUrl);
    const matches = (registryModule.CAD_UI_CONTROL_REGISTRY as any[])
      .filter((entry) => entry.id === 'model.structural-member');
    const control = matches[0];
    return {
      count: matches.length,
      bindings: control?.humanBindings || [],
      operationKinds: control?.operationKinds || [],
      fields: control?.fields || [],
    };
  });
  assert.equal(registryAudit.count, 1, 'model.structural-member is not uniquely registered');
  assert.deepEqual(registryAudit.bindings, [{ kind: 'element-id', elementId: 'bw-structural-member-open' }],
    'registered structural-member control is not bound to the visible ribbon button');
  assert.deepEqual(registryAudit.operationKinds, ['structural.member.create', 'structural.member.update'],
    'registered structural-member control advertises the wrong typed operations');
  assert.deepEqual(registryAudit.fields.map((field: JsonRecord) => field.id),
    ['name', 'pathSketchId', 'familyId', 'presetId', 'anchor', 'rotationDegrees', 'offsetX', 'offsetY'],
    'registered structural-member field contract is incomplete');
  assert.ok(registryAudit.fields.filter((field: JsonRecord) =>
    ['rotationDegrees', 'offsetX', 'offsetY'].includes(field.id)).every((field: JsonRecord) => field.kind === 'number'),
  'structural placement registry fields are not literal numbers');

  await page.evaluate(() => (window as any).__bwStudio.commitHumanOperationsForTest(
    'Blank structural-member UI acceptance',
    [{ kind: 'project.clear', input: {} }],
  ));
  await waitForSettlement(page);
  await assertOpenRefused(page, /direct two-point polyline Path/u);

  await page.evaluate((invalidPathId) => (window as any).__bwStudio.commitHumanOperationsForTest(
    'Seed invalid multi-segment structural path',
    [{
      kind: 'sketch.path.create',
      input: {
        id: invalidPathId,
        name: 'Invalid multi-segment path',
        curveKind: 'polyline',
        points: [[0, 0, 0], [0, 0, 40], [20, 0, 80]],
      },
    }],
  ), INVALID_PATH_ID);
  await waitForSettlement(page);
  await assertOpenRefused(page, /direct two-point polyline Path/u);

  await page.evaluate((fixture) => (window as any).__bwStudio.commitHumanOperationsForTest(
    'Seed exact structural-member Path',
    [
      { kind: 'project.clear', input: {} },
      {
        kind: 'sketch.path.create',
        input: {
          id: fixture.pathId,
          name: fixture.pathName,
          curveKind: 'polyline',
          points: [[0, 0, 0], [0, 0, fixture.length]],
        },
      },
    ],
  ), { pathId: PATH_ID, pathName: HTML_LIKE_PATH_NAME, length: PATH_LENGTH });
  await waitForSettlement(page);
  await clickVisible(page, '#bw-structural-member-open');
  await waitForDialog(page, true);
  for (const selector of [
    '#bw-structural-member-form [name="name"]',
    '#bw-structural-member-path',
    '#bw-structural-member-family',
    '#bw-structural-member-preset',
    '#bw-structural-member-anchor',
    '#bw-structural-member-form [name="rotationDegrees"]',
    '#bw-structural-member-form [name="offsetX"]',
    '#bw-structural-member-form [name="offsetY"]',
    '#bw-structural-member-cancel',
    '#bw-structural-member-apply',
  ]) await assertHitTestable(page, selector);
  assert.deepEqual(await page.$$eval('#bw-structural-member-path option', (options) =>
    options.map((option) => ({ value: (option as HTMLOptionElement).value, text: option.textContent?.trim() }))),
  [{ value: PATH_ID, text: HTML_LIKE_PATH_NAME }], 'visible dialog did not offer exactly the valid direct Path');

  await replaceValue(page, '#bw-structural-member-form [name="name"]', 'UI I-section member');
  await page.select('#bw-structural-member-family', 'i-section');
  await page.select('#bw-structural-member-preset', 'i-100x50x6');
  await page.select('#bw-structural-member-anchor', 'center');
  await replaceValue(page, '#bw-structural-member-form [name="rotationDegrees"]', '0');
  await replaceValue(page, '#bw-structural-member-form [name="offsetX"]', '0');
  await replaceValue(page, '#bw-structural-member-form [name="offsetY"]', '0');
  const createSummary = await page.$eval('#bw-structural-member-summary', (element) => element.textContent?.trim() || '');
  const createSource = await page.$eval('#bw-structural-member-source', (element) => element.textContent?.trim() || '');
  assert.match(createSummary, /I 100 × 50 × 6 · 12 exact profile edges/u,
    'visible profile summary does not describe the selected exact I-section');
  assert.match(createSource, /PartMode generic metric structural profiles.*unstandardized nominal design aid/u,
    'visible dialog does not disclose profile provenance');
  await clickVisible(page, '#bw-structural-member-apply');
  await waitForDialog(page, false);
  await waitForSettlement(page);

  let part = await readPart(page);
  let member = part.features.find((entry: JsonRecord) => entry.extensions?.structuralMember);
  assert.ok(member, 'visible create did not persist a structural-member feature');
  let recipe = member.extensions.structuralMember;
  assert.equal(member.type, 'sweep', 'structural member is not an exact Sweep specialization');
  assert.equal(recipe.familyId, 'i-section', 'visible create persisted the wrong profile family');
  assert.equal(recipe.presetId, 'i-100x50x6', 'visible create persisted the wrong profile preset');
  assert.equal(recipe.pathSketchId, PATH_ID, 'visible create persisted the wrong Path');
  assert.equal(recipe.pathPolicy, 'exact-two-point-single-segment', 'visible create weakened the Path policy');
  assert.equal(recipe.cornerPolicy, 'single-member-without-trim-or-corner-treatment',
    'visible create invented corner treatment');
  const profileSketch = part.sketches.find((entry: JsonRecord) => entry.id === recipe.profileSketchId);
  assert.equal(profileSketch?.entities?.[0]?.points?.length, 12,
    'visible create did not persist the exact 12-edge I-section profile');
  const body = part.bodies.find((entry: JsonRecord) => entry.createdByFeatureId === member.id);
  assert.ok(body, 'visible create did not persist the member result body');

  const historySelector = `#bw-history .hist-item[data-sel="${member.id}"]`;
  await page.waitForSelector(historySelector, { visible: true, timeout: 30_000 });
  const historyText = await page.$eval(historySelector, (element) => element.textContent || '');
  assert.match(historyText, /SM\s*1\. Structural member/u, 'model tree labels the structural member as a generic Sweep');
  assert.match(historyText, /I 100 × 50 × 6.*UI structural Path.*center insertion/u,
    'model tree omits structural profile, Path, or placement evidence');
  assert.equal(await page.$(`${historySelector} img`), null,
    'HTML-like structural Path name created an element in the model tree');
  assert.notEqual(await page.evaluate(() => (window as any).__wd001Injected), true,
    'HTML-like structural Path name executed an event handler in the model tree');
  await clickVisible(page, `${historySelector} .hi-sel`);
  await page.waitForFunction(() =>
    document.getElementById('bw-inspector-kind')?.textContent?.trim() === 'Structural member properties');
  const inspectorText = await page.$eval('#bw-context', (element) => element.textContent || '');
  for (const expected of [
    'Structural member', 'I 100 × 50 × 6', 'I section (i-section)', 'i-100x50x6',
    'UI structural Path', 'center', 'PartMode generic metric structural profiles',
    'unstandardized nominal design aid', 'exact-two-point-single-segment',
    'single-member-without-trim-or-corner-treatment', 'generic-profile-design-aid-not-manufacturing-certification',
  ]) assert.ok(inspectorText.includes(expected), `inspector omits structural-member detail: ${expected}`);
  assert.equal(await page.$eval('#bw-context [data-cxedit="1"]', (element) => element.textContent?.trim()), 'Edit member',
    'inspector exposes the structural member as a generic profile/Sweep edit');

  const exactBefore = await exactSettlement(page, body.id, 12);
  assert.ok(closeTo(exactBefore.body.geometry.volume, recipe.profileArea * PATH_LENGTH),
    'initial exact I-section volume does not equal catalog area × Path length');

  const beforeCancel = await projectState(page);
  await clickVisible(page, `${historySelector} [data-edit="${member.id}"]`);
  await waitForDialog(page, true);
  assert.equal(await page.$eval('#bw-structural-member-title', (element) => element.textContent?.trim()),
    'Edit structural member', 'model-tree Edit opened a generic Sweep editor');
  await page.select('#bw-structural-member-preset', 'i-120x60x6');
  await page.select('#bw-structural-member-anchor', 'top-left');
  await replaceValue(page, '#bw-structural-member-form [name="rotationDegrees"]', '17');
  await replaceValue(page, '#bw-structural-member-form [name="offsetX"]', '4');
  await replaceValue(page, '#bw-structural-member-form [name="offsetY"]', '-3');
  assert.equal(await page.evaluate(() => (window as any).__bwStudio.docJson()), beforeCancel.docJson,
    'visible structural-member draft mutated the authoritative document before Apply');
  await clickVisible(page, '#bw-structural-member-cancel');
  await waitForDialog(page, false);
  await waitForSettlement(page);
  assert.deepEqual(await projectState(page), beforeCancel,
    'Cancel changed structural-member document bytes, hash, revision, or undo/redo history');
  const exactAfterCancel = await exactSettlement(page, body.id, 12);
  assert.equal(exactAfterCancel.body.exactBrep, exactBefore.body.exactBrep,
    'Cancel changed the exact structural-member BREP');

  await clickVisible(page, `${historySelector} [data-edit="${member.id}"]`);
  await waitForDialog(page, true);
  await page.select('#bw-structural-member-preset', 'i-120x60x6');
  await page.select('#bw-structural-member-anchor', 'top-left');
  await replaceValue(page, '#bw-structural-member-form [name="rotationDegrees"]', '17');
  await replaceValue(page, '#bw-structural-member-form [name="offsetX"]', '4');
  await replaceValue(page, '#bw-structural-member-form [name="offsetY"]', '-3');
  await clickVisible(page, '#bw-structural-member-apply');
  await waitForDialog(page, false);
  await page.waitForFunction((featureId) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    const partId = document.rootDocument?.partId;
    const part = document.partDefinitions.find((entry: any) => entry.id === partId);
    const recipe = part.features.find((entry: any) => entry.id === featureId)?.extensions?.structuralMember;
    return recipe?.presetId === 'i-120x60x6'
      && recipe?.placement?.anchor === 'top-left'
      && recipe?.placement?.rotationDegrees === 17
      && recipe?.placement?.offset?.[0] === 4
      && recipe?.placement?.offset?.[1] === -3;
  }, { polling: 100, timeout: 30_000 }, member.id);
  await waitForSettlement(page);

  part = await readPart(page);
  member = part.features.find((entry: JsonRecord) => entry.id === member.id);
  recipe = member.extensions.structuralMember;
  assert.equal(recipe.profileSketchId, profileSketch.id, 'same-family update replaced the owned profile identity');
  assert.equal(recipe.familyId, 'i-section', 'same-family update changed the profile family');
  const exactAfter = await exactSettlement(page, body.id, 12);
  assert.notEqual(exactAfter.body.exactBrep, exactBefore.body.exactBrep,
    'visible preset/placement update reused stale canonical BREP evidence');
  assert.notDeepEqual(exactAfter.body.geometry.bounds, exactBefore.body.geometry.bounds,
    'visible preset/placement update did not change exact bounds');
  assert.notEqual(exactAfter.body.geometry.volume, exactBefore.body.geometry.volume,
    'visible preset update did not change exact volume');
  assert.notEqual(exactAfter.canonicalHash, exactBefore.canonicalHash,
    'visible preset/placement update did not change the canonical document hash');
  assert.ok(exactAfter.documentRevision > exactBefore.documentRevision,
    'visible preset/placement update did not advance document revision');
  assert.ok(closeTo(exactAfter.body.geometry.volume, recipe.profileArea * PATH_LENGTH),
    'updated exact I-section volume does not equal catalog area × Path length');
  const updatedHistoryText = await page.$eval(historySelector, (element) => element.textContent || '');
  assert.match(updatedHistoryText, /I 120 × 60 × 6.*top-left insertion/u,
    'model tree did not refresh the updated profile and placement');

  const selectedAfterUpdate = await page.$eval(`${historySelector} .hi-sel`, (element) =>
    element.getAttribute('aria-pressed') === 'true');
  if (!selectedAfterUpdate) await clickVisible(page, `${historySelector} .hi-sel`);
  await page.waitForFunction(() =>
    (document.getElementById('bw-context-wrap') as HTMLElement | null)?.hidden === false
      && document.querySelector('#bw-context')?.textContent?.includes('I 120 × 60 × 6'));
  await clickVisible(page, '#bw-context [data-cxdel="1"]');
  await page.waitForFunction((featureId) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    const partId = document.rootDocument?.partId;
    const part = document.partDefinitions.find((entry: any) => entry.id === partId);
    return !part.features.some((entry: any) => entry.id === featureId);
  }, { polling: 100, timeout: 30_000 }, member.id);
  await waitForSettlement(page);
  part = await readPart(page);
  assert.ok(part.sketches.some((entry: JsonRecord) => entry.id === PATH_ID),
    'visible structural-member delete removed the shared Path');
  assert.ok(!part.sketches.some((entry: JsonRecord) => entry.id === recipe.profileSketchId),
    'visible structural-member delete left the owned profile sketch');
  assert.ok(!part.referenceGeometry.some((entry: JsonRecord) => entry.id === recipe.profilePlaneId),
    'visible structural-member delete left the owned profile plane');
  assert.ok(!part.bodies.some((entry: JsonRecord) => entry.id === body.id),
    'visible structural-member delete left its result body');
  assert.equal(part.extensions?.structuralProfileLibrary, undefined,
    'visible delete of the last member left the part profile-library extension');
  assert.equal(await page.$(historySelector), null, 'visible delete left the structural member in the model tree');
  const exactAfterDelete = await page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    const exact = await studio.exactBodyResultsForTest();
    return {
      exact,
      canonicalHash: studio.canonicalHash(),
      documentRevision: studio.documentRevision(),
      appliedRevision: studio.appliedRevision(),
    };
  });
  assert.deepEqual(exactAfterDelete.exact.errors, [], 'exact rebuild after visible delete reported errors');
  assert.deepEqual(exactAfterDelete.exact.bodies, [], 'exact rebuild after visible delete retained a body');
  assert.equal(exactAfterDelete.exact.effectiveDocumentHash, exactAfterDelete.canonicalHash,
    'post-delete exact evidence is not current-document-hash-bound');
  assert.equal(exactAfterDelete.exact.revision, exactAfterDelete.documentRevision,
    'post-delete exact evidence is not current-revision evidence');
  assert.equal(exactAfterDelete.appliedRevision, exactAfterDelete.documentRevision,
    'post-delete visible document is not settled');

  assert.deepEqual(failures, [], `structural-member browser gate reported errors: ${failures.join(' | ')}`);
  console.log(JSON.stringify({
    schema: 'partmode.structural-members-ui-smoke/v1',
    browserBacked: true,
    visibleLifecycle: ['missing-path-refusal', 'invalid-path-refusal', 'create', 'cancel', 'update', 'delete'],
    registeredControl: 'model.structural-member',
    pathPolicy: recipe.pathPolicy,
    initialProfile: 'I 100 × 50 × 6',
    updatedProfile: recipe.designation,
    exactEvidence: {
      currentRevisionBound: true,
      currentDocumentHashBound: true,
      brepChanged: true,
      persistentTopologyComplete: true,
    },
    ownedHelperCleanup: true,
    htmlLikePathNameEscaped: true,
    consoleNetworkResponsePageErrors: 0,
  }, null, 2));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
