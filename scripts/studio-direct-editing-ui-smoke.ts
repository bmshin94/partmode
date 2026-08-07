import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import puppeteer, { type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-direct-editing-ui-'));
const BASE_FEATURE_ID = 'feature-ui-direct-edit-base';
const BOSS_FEATURE_ID = 'feature-ui-direct-edit-boss';
const REPLACEMENT_FEATURE_ID = 'feature-ui-direct-edit-replacement';
const TARGET_BODY_ID = 'body-' + BASE_FEATURE_ID;
const REPLACEMENT_BODY_ID = 'body-' + REPLACEMENT_FEATURE_ID;
const HTML_LIKE_TARGET_NAME = '<img src=x onerror="window.__pt013Injected=true"> target body';
const HTML_LIKE_REPLACEMENT_NAME = '<svg onload="window.__pt013Injected=true"> replacement body';
const HTML_LIKE_FEATURE_NAME = '<img src=x onerror="window.__pt013Injected=true"> direct edit';

function closeTo(actual: unknown, expected: unknown, tolerance = 1e-6): boolean {
  const left = Number(actual);
  const right = Number(expected);
  return Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= Math.max(tolerance, Math.abs(right) * 1e-9);
}

function rootPart(document: JsonRecord): JsonRecord {
  const part = document.partDefinitions?.find((entry: JsonRecord) => entry.id === document.rootDocument?.partId)
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

async function waitForDialog(page: Page, open: boolean): Promise<void> {
  await page.waitForFunction((expected) =>
    (document.getElementById('bw-direct-edit') as HTMLDialogElement | null)?.open === expected,
  { polling: 50, timeout: 30_000 }, open);
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

function assertStateEqual(actual: JsonRecord, expected: JsonRecord, message: string): void {
  assert.deepEqual(actual, expected, message);
}

async function assertHitTestable(page: Page, selector: string): Promise<void> {
  const control = await page.$(selector);
  assert.ok(control, `visible control is missing: ${selector}`);
  try {
    await control.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
    const box = await control.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, `control has no hit-test bounds: ${selector}`);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const hit = await control.evaluate((element, location) => {
      if (!(element instanceof HTMLElement)) return { visible: false, owns: false, target: 'non-html' };
      const style = getComputedStyle(element);
      const target = document.elementFromPoint(location.x, location.y);
      return {
        visible: !element.hidden && style.display !== 'none' && style.visibility !== 'hidden',
        owns: Boolean(target && (target === element || element.contains(target))),
        target: target instanceof Element
          ? `${target.tagName.toLowerCase()}#${target.id}.${[...target.classList].join('.')}`
          : String(target),
      };
    }, point);
    assert.equal(hit.visible, true, `control is hidden: ${selector}`);
    assert.equal(hit.owns, true, `control does not own its center hit target: ${selector}; hit=${hit.target}`);
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

async function selectValue(page: Page, selector: string, value: string): Promise<void> {
  await assertHitTestable(page, selector);
  const selected = await page.select(selector, value);
  assert.deepEqual(selected, [value], `could not choose visible option ${value} from ${selector}`);
}

async function selectBody(page: Page, selector: string, bodyId: string): Promise<void> {
  const options = await page.$$eval(`${selector} option`, (entries) => entries.map((entry) => ({
    value: (entry as HTMLOptionElement).value,
    text: entry.textContent || '',
  })));
  assert.ok(options.some((entry) => entry.value === bodyId), `${selector} omitted body ${bodyId}`);
  await selectValue(page, selector, bodyId);
}

async function selectPlanarFace(
  page: Page,
  selector: string,
  criteria: { highest?: boolean; belowZ?: number; normalZ?: number },
): Promise<JsonRecord> {
  await assertHitTestable(page, selector);
  const selected = await page.$eval(selector, (element, input) => {
    const select = element as HTMLSelectElement & { __directEditFaceChoices?: JsonRecord[] };
    const choices = (select.__directEditFaceChoices || []).map((entry, index) => ({
      index,
      value: String(index),
      name: entry.reference?.name,
      sig: entry.reference?.sig,
      label: select.options[index]?.textContent || '',
    })).filter((entry) => {
      const normalZ = Number(entry.sig?.n?.[2]);
      const z = Number(entry.sig?.p?.[2]);
      return entry.name && entry.sig
        && (input.normalZ === undefined || Math.abs(normalZ - input.normalZ) < 1e-6)
        && (input.belowZ === undefined || z < input.belowZ - 1e-6);
    });
    if (input.highest) choices.sort((left, right) => Number(right.sig.p[2]) - Number(left.sig.p[2]));
    else choices.sort((left, right) => Number(right.sig.p[2]) - Number(left.sig.p[2]));
    return choices[0] || null;
  }, criteria);
  assert.ok(selected, `${selector} has no matching persistent planar face`);
  assert.equal(typeof selected.name, 'string', `${selector} selected an unnamed face`);
  assert.ok(selected.sig && typeof selected.sig === 'object', `${selector} selected a face without a signature`);
  assert.ok(selected.label.includes(selected.name), `${selector} option does not visibly label its persistent name`);
  assert.match(selected.label, /centre .*normal/u, `${selector} option omits typed centre/normal context`);
  await selectValue(page, selector, selected.value);
  return selected;
}

async function exactCurrent(page: Page, label: string): Promise<JsonRecord> {
  await waitForSettlement(page);
  const result = await page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    return {
      exact: await studio.exactBodyResultsForTest(),
      canonicalHash: studio.canonicalHash(),
      documentRevision: studio.documentRevision(),
      appliedRevision: studio.appliedRevision(),
      visible: studio.bodyResults(),
      topology: studio.topologyInventoryForTest(),
    };
  });
  assert.equal(result.documentRevision, result.appliedRevision, `${label}: visible rebuild is not settled`);
  assert.equal(result.exact.revision, result.documentRevision, `${label}: isolated worker evidence is stale`);
  assert.equal(result.exact.effectiveDocumentHash, result.canonicalHash,
    `${label}: isolated worker evidence is not current-document-hash-bound`);
  assert.deepEqual(result.exact.errors, [], `${label}: isolated production-worker rebuild reported errors`);
  for (const body of result.exact.bodies as JsonRecord[]) {
    assert.equal(body.error, null, `${label}/${body.bodyId}: exact body has an error`);
    assert.equal(body.geometry?.valid, true, `${label}/${body.bodyId}: exact body is invalid`);
    assert.equal(body.geometry?.brepValid, true, `${label}/${body.bodyId}: BRepCheck rejected the body`);
    assert.equal(body.geometry?.solidCount, 1, `${label}/${body.bodyId}: result is not exactly one solid`);
    assert.ok(typeof body.exactBrep === 'string' && body.exactBrep.length > 100,
      `${label}/${body.bodyId}: canonical exact BREP evidence is missing`);
    const visible = result.visible.find((entry: JsonRecord) => entry.bodyId === body.bodyId);
    assert.ok(visible, `${label}/${body.bodyId}: exact body is absent from the visible settled rebuild`);
    assert.ok(closeTo(visible.geometry?.volume, body.geometry?.volume),
      `${label}/${body.bodyId}: visible and isolated exact volumes disagree`);
    for (const [kind, countKey] of [
      ['face', 'faceCount'],
      ['edge', 'edgeCount'],
      ['vertex', 'vertexCount'],
    ] as const) {
      const entries = result.topology.filter((entry: JsonRecord) =>
        entry.owner?.kind === 'body' && entry.owner.id === body.bodyId
        && entry.topologySignature?.kind === kind);
      // topologyInventoryForTest intentionally publishes named subshapes
      // only. Matching the kernel's full exact count proves completeness.
      assert.equal(entries.length, body.geometry?.[countKey],
        `${label}/${body.bodyId}: persistently named ${kind} topology inventory is incomplete`);
      assert.ok(entries.every((entry: JsonRecord) => typeof entry.stableId === 'string' && entry.stableId.length > 0),
        `${label}/${body.bodyId}: ${kind} topology inventory contains no stable identity`);
    }
  }
  return result;
}

function exactBody(result: JsonRecord, bodyId: string, label: string): JsonRecord {
  const body = result.exact.bodies.find((entry: JsonRecord) => entry.bodyId === bodyId);
  assert.ok(body, `${label}: exact body ${bodyId} is missing`);
  return body;
}

function historySelector(featureId: string): string {
  return `#bw-history .hist-item[data-sel="${featureId}"]`;
}

async function openFeatureEdit(page: Page, featureId: string): Promise<void> {
  const selector = `${historySelector(featureId)} [data-edit="${featureId}"]`;
  await page.waitForSelector(selector, { visible: true, timeout: 30_000 });
  await clickVisible(page, selector);
  await waitForDialog(page, true);
}

async function deleteFeatureFromDialog(page: Page, featureId: string): Promise<void> {
  const before = await projectState(page);
  await openFeatureEdit(page, featureId);
  await clickVisible(page, '#bw-direct-edit-delete');
  await waitForDialog(page, false);
  await waitForSettlement(page);
  assert.ok((await projectState(page)).documentRevision > before.documentRevision,
    `visible delete did not advance document revision for ${featureId}`);
  assert.equal(await page.$(historySelector(featureId)), null,
    `visible typed delete left direct-edit feature ${featureId} in history`);
}

async function openCreate(page: Page, button: string, operation: string): Promise<void> {
  await clickVisible(page, button);
  await waitForDialog(page, true);
  assert.equal(await page.$eval('#bw-direct-edit', (element) => element.getAttribute('data-operation')), operation,
    `${button} opened the wrong direct-edit family`);
  await selectBody(page, '#bw-direct-edit-target-body', TARGET_BODY_ID);
}

async function dragDirectPushPull(page: Page): Promise<{ before: JsonRecord; after: JsonRecord }> {
  await page.waitForFunction(() => (window as any).__bwStudio.directEditDragStateForTest()?.active === true,
    { polling: 50, timeout: 30_000 });
  const before = await page.evaluate(() => (window as any).__bwStudio.directEditDragStateForTest());
  assert.equal(before.active, true, 'Direct Push/Pull TransformControls preview is not active');
  assert.equal(before.bodyId, TARGET_BODY_ID, 'Direct Push/Pull gizmo is attached to the wrong body');
  assert.equal(before.guideCount, 2, 'Direct Push/Pull did not create detached-face and signed-extent guides');
  assert.equal(before.detachedFaceVisible, true, 'detached target-face guide is not visible');
  assert.equal(before.extentVisible, true, 'signed extent guide is not visible');
  assert.ok(Array.isArray(before.normal) && before.normal.length === 3, 'normal-only gizmo has no face normal');
  assert.ok([before.pointerStart.x, before.pointerStart.y, before.pointerEnd.x, before.pointerEnd.y]
    .every(Number.isFinite), 'Direct Push/Pull hook did not expose finite canvas coordinates');

  const canvasHit = await page.evaluate((point) => {
    const target = document.elementFromPoint(point.x, point.y);
    const canvas = document.querySelector('canvas[aria-label="3D modeling canvas"]');
    return {
      owns: Boolean(canvas && target && (target === canvas || canvas.contains(target))),
      target: target instanceof Element
        ? `${target.tagName.toLowerCase()}#${target.id}.${[...target.classList].join('.')}`
        : String(target),
      canvasRect: canvas?.getBoundingClientRect().toJSON() || null,
    };
  }, before.pointerStart);
  assert.equal(canvasHit.owns, true,
    `TransformControls arrow is not hit-testable on the real canvas: start=${JSON.stringify(before.pointerStart)} hit=${canvasHit.target} canvas=${JSON.stringify(canvasHit.canvasRect)}`);

  await page.mouse.move(before.pointerStart.x, before.pointerStart.y);
  await page.waitForFunction(() => (window as any).__bwStudio.directEditDragStateForTest()?.axis === 'Z',
    { polling: 25, timeout: 30_000 });
  const hover = await page.evaluate(() => (window as any).__bwStudio.directEditDragStateForTest());
  assert.equal(hover.axis, 'Z', 'trusted canvas hover did not select the normal-only Z picker');
  assert.equal(hover.dragging, false, 'TransformControls began dragging before pointerdown');
  await page.mouse.down();
  await page.waitForFunction(() => (window as any).__bwStudio.directEditDragStateForTest()?.dragging === true,
    { polling: 25, timeout: 30_000 });
  // One real pointermove is enough to exercise TransformControls. Extra
  // interpolation steps each force a synchronous software-WebGL frame and
  // add no acceptance value.
  await page.mouse.move(before.pointerEnd.x, before.pointerEnd.y, { steps: 1 });
  await page.mouse.up();
  await page.waitForFunction((value) => {
    const next = (window as any).__bwStudio.directEditDragStateForTest();
    return next?.active === true && next.dragging === false
      && Math.abs(Number(next.authoredDistance) - Number(value)) > 1e-6;
  }, { polling: 50, timeout: 30_000 }, before.authoredDistance);
  const after = await page.evaluate(() => (window as any).__bwStudio.directEditDragStateForTest());
  assert.notEqual(after.authoredDistance, before.authoredDistance,
    'trusted page.mouse drag did not change the signed-distance field');
  assert.equal(after.guideCount, 2, 'trusted drag lost its detached-face or extent guide');
  assert.equal(after.detachedFaceVisible, true, 'trusted drag hid the detached face guide');
  assert.equal(after.extentVisible, true, 'trusted drag hid the signed extent guide');
  assert.equal(await page.$eval('#bw-direct-edit-distance', (element) => Number((element as HTMLInputElement).value)),
    after.authoredDistance, 'trusted drag did not drive the visible signed-distance control');
  return { before, after };
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
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('bw-studio-welcome-v1', '1');
    (window as any).__pt013Injected = false;
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
  assert.equal(response?.status(), 200, 'PT013 UI route did not return HTTP 200');
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  // The privacy banner is intentionally above every app surface until the
  // user records a first-party essential-storage choice.
  if (await page.$eval('#pm-cookie-banner', (element) => !(element as HTMLElement).hidden)) {
    await clickVisible(page, '#pm-cookie-essential');
    await page.waitForFunction(() => (document.getElementById('pm-cookie-banner') as HTMLElement | null)?.hidden === true,
      { polling: 50, timeout: 30_000 });
  }
  await clickVisible(page, '[data-workspace="solid"]');

  const controls = [
    { id: 'model.direct-push-pull', button: '#bw-direct-push-pull-open', fields: ['name', 'targetBody', 'targetFace', 'distance'] },
    { id: 'model.replace-face', button: '#bw-replace-face-open', fields: ['name', 'targetBody', 'targetFace', 'replacementBody', 'replacementFace'] },
    { id: 'model.delete-face', button: '#bw-delete-face-open', fields: ['name', 'targetBody', 'targetFace', 'patchFace'] },
  ];
  const registry = await page.evaluate(async (ids) => {
    const studioScript = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
    if (!studioScript) throw new Error('Cannot locate the built Studio module URL.');
    const module = await import(new URL('studio-v6-ui-registry.js', studioScript.src).href);
    return ids.map((id) => ({
      id,
      matches: module.CAD_UI_CONTROL_REGISTRY.filter((entry: JsonRecord) => entry.id === id),
    }));
  }, controls.map((entry) => entry.id));
  for (const expected of controls) {
    await assertHitTestable(page, expected.button);
    const matches = registry.find((entry: JsonRecord) => entry.id === expected.id)?.matches || [];
    assert.equal(matches.length, 1, `${expected.id} is not uniquely registered`);
    const control = matches[0];
    assert.equal(control.adapter, 'available', `${expected.id} is registered as unavailable`);
    assert.deepEqual(control.operationKinds, ['directEdit.create', 'directEdit.update', 'directEdit.delete'],
      `${expected.id} does not advertise the typed direct-edit lifecycle`);
    assert.deepEqual(control.humanBindings, [{ kind: 'element-id', elementId: expected.button.slice(1) }],
      `${expected.id} is not bound to its visible ribbon control`);
    assert.deepEqual(control.fields.map((field: JsonRecord) => field.id), expected.fields,
      `${expected.id} has an incomplete typed field contract`);
  }

  await page.evaluate(async (fixture) => {
    const studio = (window as any).__bwStudio;
    await studio.commitHumanOperationsForTest('Seed PT013 exact direct-edit solids', [
      { kind: 'project.clear', input: {} },
      {
        kind: 'feature.extrude',
        input: {
          id: fixture.baseFeatureId,
          name: 'PT013 base prism',
          sketch: { shapes: [{ id: 'shape-ui-direct-base', kind: 'rect', x: 0, y: 0, w: 12, h: 8 }], z: 0 },
          height: 4,
          resultPolicy: { kind: 'new-body', bodyName: fixture.targetName },
        },
      },
      {
        kind: 'feature.extrude',
        input: {
          id: fixture.bossFeatureId,
          name: 'PT013 raised boss',
          sketch: { shapes: [{ id: 'shape-ui-direct-boss', kind: 'rect', x: 4, y: 2, w: 4, h: 4 }], z: 4 },
          height: 4,
          resultPolicy: { kind: 'add', targetBodyIds: [fixture.targetBodyId] },
        },
      },
      {
        kind: 'feature.extrude',
        input: {
          id: fixture.replacementFeatureId,
          name: 'PT013 replacement prism',
          sketch: { shapes: [{ id: 'shape-ui-direct-replacement', kind: 'rect', x: 30, y: 0, w: 4, h: 4 }], z: 6 },
          height: 4,
          resultPolicy: { kind: 'new-body', bodyName: fixture.replacementName },
        },
      },
    ]);
  }, {
    baseFeatureId: BASE_FEATURE_ID,
    bossFeatureId: BOSS_FEATURE_ID,
    replacementFeatureId: REPLACEMENT_FEATURE_ID,
    targetBodyId: TARGET_BODY_ID,
    targetName: HTML_LIKE_TARGET_NAME,
    replacementName: HTML_LIKE_REPLACEMENT_NAME,
  });
  await waitForSettlement(page);
  const baseline = await exactCurrent(page, 'baseline direct-edit solids');
  const baselineTarget = exactBody(baseline, TARGET_BODY_ID, 'baseline');
  const baselineReplacement = exactBody(baseline, REPLACEMENT_BODY_ID, 'baseline');
  assert.ok(closeTo(baselineTarget.geometry.volume, 448), 'baseline target is not the 448 mm³ base-plus-boss solid');
  assert.ok(closeTo(baselineReplacement.geometry.volume, 64), 'baseline replacement is not the 64 mm³ prism');

  // A real TransformControls gesture must remain a preview and Cancel must
  // remove both scene guides without touching document bytes or history.
  const beforeCancel = await projectState(page);
  await openCreate(page, '#bw-direct-push-pull-open', 'push-pull');
  const selectedTarget = await selectPlanarFace(page, '#bw-direct-edit-target-face', { highest: true, normalZ: 1 });
  await replaceValue(page, '#bw-direct-edit-distance', '2');
  const cancelDrag = await dragDirectPushPull(page);
  assertStateEqual(await projectState(page), beforeCancel,
    'trusted Direct Push/Pull preview mutated document bytes, hash, revision, or history before Cancel');
  await clickVisible(page, '#bw-direct-edit-cancel');
  await waitForDialog(page, false);
  assertStateEqual(await projectState(page), beforeCancel,
    'Cancel after trusted Direct Push/Pull drag mutated document bytes, hash, revision, or history');
  const cancelledPreview = await page.evaluate(() => (window as any).__bwStudio.directEditDragStateForTest());
  assert.equal(cancelledPreview.active, false, 'Cancel left the Direct Push/Pull TransformControls preview active');
  assert.equal(cancelledPreview.guideCount, 0, 'Cancel leaked a detached face or extent guide');

  // Create Push/Pull from a second real pointer gesture, then visibly edit and
  // delete it through the same typed lifecycle.
  await openCreate(page, '#bw-direct-push-pull-open', 'push-pull');
  await selectPlanarFace(page, '#bw-direct-edit-target-face', { highest: true, normalZ: 1 });
  await replaceValue(page, '#bw-direct-edit-distance', '2');
  await replaceValue(page, '#bw-direct-edit-name', HTML_LIKE_FEATURE_NAME);
  const beforePushApply = await projectState(page);
  const createDrag = await dragDirectPushPull(page);
  assertStateEqual(await projectState(page), beforePushApply,
    'trusted Direct Push/Pull drag mutated document bytes, hash, revision, or history before Apply');
  await clickVisible(page, '#bw-direct-edit-apply');
  await waitForDialog(page, false);
  await waitForSettlement(page);
  let part = await readPart(page);
  let feature = part.features.find((entry: JsonRecord) => entry.type === 'direct-edit' && entry.operation === 'push-pull');
  assert.ok(feature, 'visible Direct Push/Pull did not persist a direct-edit feature');
  const pushId = feature.id;
  assert.equal(feature.name, HTML_LIKE_FEATURE_NAME, 'visible Direct Push/Pull did not preserve its literal feature name');
  assert.equal(feature.targetBodyId, TARGET_BODY_ID, 'visible Direct Push/Pull targeted the wrong body');
  assert.equal(feature.targetFace.name, selectedTarget.name, 'visible Direct Push/Pull lost its named target face');
  assert.deepEqual(feature.targetFace.sig, selectedTarget.sig, 'visible Direct Push/Pull lost its target signature');
  assert.ok(closeTo(feature.distance, createDrag.after.authoredDistance),
    'Apply did not persist the signed distance authored by the trusted gizmo drag');
  const pushCreated = await exactCurrent(page, 'visible Direct Push/Pull create');
  assert.notEqual(exactBody(pushCreated, TARGET_BODY_ID, 'push create').exactBrep, baselineTarget.exactBrep,
    'visible Direct Push/Pull did not change the exact target BREP');
  assert.equal(exactBody(pushCreated, REPLACEMENT_BODY_ID, 'push create').exactBrep, baselineReplacement.exactBrep,
    'visible Direct Push/Pull changed the unrelated replacement body');
  assert.equal(await page.$(`${historySelector(pushId)} img`), null,
    'HTML-like Direct Push/Pull name created an element in visible history');
  assert.equal(await page.evaluate(() => (window as any).__pt013Injected), false,
    'HTML-like direct-edit name executed script');

  await openFeatureEdit(page, pushId);
  assert.equal((await page.$eval('#bw-direct-edit-target-body', (element) => (element as HTMLSelectElement).disabled)), true,
    'Direct Push/Pull edit does not visibly lock immutable target body');
  await replaceValue(page, '#bw-direct-edit-name', 'Edited Direct Push/Pull');
  await replaceValue(page, '#bw-direct-edit-distance', '1');
  await clickVisible(page, '#bw-direct-edit-apply');
  await waitForDialog(page, false);
  await waitForSettlement(page);
  part = await readPart(page);
  feature = part.features.find((entry: JsonRecord) => entry.id === pushId);
  assert.equal(feature?.name, 'Edited Direct Push/Pull', 'visible Direct Push/Pull edit did not preserve feature identity');
  assert.equal(feature?.distance, 1, 'visible Direct Push/Pull edit persisted the wrong distance');
  const pushEdited = await exactCurrent(page, 'visible Direct Push/Pull edit');
  assert.notEqual(exactBody(pushEdited, TARGET_BODY_ID, 'push edit').exactBrep,
    exactBody(pushCreated, TARGET_BODY_ID, 'push create').exactBrep,
  'visible Direct Push/Pull edit reused stale exact BREP output');
  await deleteFeatureFromDialog(page, pushId);
  const afterPushDelete = await exactCurrent(page, 'visible Direct Push/Pull delete');
  assert.equal(exactBody(afterPushDelete, TARGET_BODY_ID, 'push delete').exactBrep, baselineTarget.exactBrep,
    'typed Direct Push/Pull delete did not restore the source BREP');

  // Replace Face create/edit/save/reload/delete. Body and face selectors are
  // visible typed controls, while the replacement source remains unchanged.
  await openCreate(page, '#bw-replace-face-open', 'replace-face');
  await selectPlanarFace(page, '#bw-direct-edit-target-face', { highest: true, normalZ: 1 });
  await selectBody(page, '#bw-direct-edit-replacement-body', REPLACEMENT_BODY_ID);
  const replacementFace = await selectPlanarFace(page, '#bw-direct-edit-replacement-face', { highest: true, normalZ: 1 });
  await replaceValue(page, '#bw-direct-edit-name', 'Visible Replace Face');
  await clickVisible(page, '#bw-direct-edit-apply');
  await waitForDialog(page, false);
  await waitForSettlement(page);
  part = await readPart(page);
  feature = part.features.find((entry: JsonRecord) => entry.type === 'direct-edit' && entry.operation === 'replace-face');
  assert.ok(feature, 'visible Replace Face did not persist a direct-edit feature');
  const replaceId = feature.id;
  assert.equal(feature.replacementBodyId, REPLACEMENT_BODY_ID, 'visible Replace Face stored the wrong source body');
  assert.equal(feature.replacementFace.name, replacementFace.name, 'visible Replace Face lost its persistent source face');
  const replaceCreated = await exactCurrent(page, 'visible Replace Face create');
  assert.notEqual(exactBody(replaceCreated, TARGET_BODY_ID, 'replace create').exactBrep, baselineTarget.exactBrep,
    'visible Replace Face did not change the exact target BREP');
  assert.equal(exactBody(replaceCreated, REPLACEMENT_BODY_ID, 'replace create').exactBrep, baselineReplacement.exactBrep,
    'visible Replace Face consumed or changed its replacement body');

  await openFeatureEdit(page, replaceId);
  await replaceValue(page, '#bw-direct-edit-name', 'Edited Replace Face');
  await clickVisible(page, '#bw-direct-edit-apply');
  await waitForDialog(page, false);
  await waitForSettlement(page);
  part = await readPart(page);
  feature = part.features.find((entry: JsonRecord) => entry.id === replaceId);
  assert.equal(feature?.name, 'Edited Replace Face', 'visible Replace Face edit replaced feature identity');
  assert.equal(feature?.operation, 'replace-face', 'visible Replace Face edit changed operation family');

  await page.evaluate(async () => (window as any).__bwStudio.flushStorage());
  const savedState = await projectState(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  const reopenedState = await projectState(page);
  assert.equal(reopenedState.docJson, savedState.docJson, 'save/reload changed canonical direct-edit document bytes');
  assert.equal(reopenedState.canonicalHash, savedState.canonicalHash, 'save/reload changed direct-edit document hash');
  assert.ok((await readPart(page)).features.some((entry: JsonRecord) => entry.id === replaceId),
    'save/reload lost the persistent Replace Face feature');
  assert.equal(await page.evaluate(() => (window as any).__pt013Injected), false,
    'persisted HTML-like body name executed after reload');
  const replaceReopened = await exactCurrent(page, 'reopened Replace Face');
  assert.equal(exactBody(replaceReopened, TARGET_BODY_ID, 'replace reload').exactBrep,
    exactBody(replaceCreated, TARGET_BODY_ID, 'replace create').exactBrep,
  'save/reload changed the exact Replace Face result');
  await clickVisible(page, '[data-workspace="solid"]');
  await deleteFeatureFromDialog(page, replaceId);
  const afterReplaceDelete = await exactCurrent(page, 'visible Replace Face delete');
  assert.equal(exactBody(afterReplaceDelete, TARGET_BODY_ID, 'replace delete').exactBrep, baselineTarget.exactBrep,
    'typed Replace Face delete did not restore the source BREP');

  // Delete Face uses a distinct lower parallel face as its exact patch plane.
  await openCreate(page, '#bw-delete-face-open', 'delete-face');
  const deleteTarget = await selectPlanarFace(page, '#bw-direct-edit-target-face', { highest: true, normalZ: 1 });
  const patchFace = await selectPlanarFace(page, '#bw-direct-edit-patch-face', {
    belowZ: Number(deleteTarget.sig.p[2]), normalZ: 1,
  });
  assert.notEqual(patchFace.name, deleteTarget.name, 'Delete Face target and patch selectors chose the same persistent face');
  await replaceValue(page, '#bw-direct-edit-name', 'Visible Delete Face');
  await clickVisible(page, '#bw-direct-edit-apply');
  await waitForDialog(page, false);
  await waitForSettlement(page);
  part = await readPart(page);
  feature = part.features.find((entry: JsonRecord) => entry.type === 'direct-edit' && entry.operation === 'delete-face');
  assert.ok(feature, 'visible Delete Face did not persist a direct-edit feature');
  const deleteId = feature.id;
  assert.equal(feature.targetFace.name, deleteTarget.name, 'visible Delete Face lost its persistent target face');
  assert.equal(feature.patchFace.name, patchFace.name, 'visible Delete Face lost its persistent patch face');
  const deleteCreated = await exactCurrent(page, 'visible Delete Face create');
  assert.notEqual(exactBody(deleteCreated, TARGET_BODY_ID, 'delete create').exactBrep, baselineTarget.exactBrep,
    'visible Delete Face did not change the exact target BREP');
  assert.ok(exactBody(deleteCreated, TARGET_BODY_ID, 'delete create').geometry.volume < baselineTarget.geometry.volume,
    'visible Delete Face did not remove exact target material');
  assert.equal(exactBody(deleteCreated, REPLACEMENT_BODY_ID, 'delete create').exactBrep, baselineReplacement.exactBrep,
    'visible Delete Face changed an unrelated body');

  await openFeatureEdit(page, deleteId);
  await replaceValue(page, '#bw-direct-edit-name', 'Edited Delete Face');
  await clickVisible(page, '#bw-direct-edit-apply');
  await waitForDialog(page, false);
  await waitForSettlement(page);
  part = await readPart(page);
  feature = part.features.find((entry: JsonRecord) => entry.id === deleteId);
  assert.equal(feature?.name, 'Edited Delete Face', 'visible Delete Face edit replaced feature identity');
  assert.equal(feature?.operation, 'delete-face', 'visible Delete Face edit changed operation family');
  await deleteFeatureFromDialog(page, deleteId);
  const finalExact = await exactCurrent(page, 'final direct-edit cleanup');
  assert.equal(exactBody(finalExact, TARGET_BODY_ID, 'final').exactBrep, baselineTarget.exactBrep,
    'typed Delete Face cleanup did not restore target BREP bytes');
  assert.equal(exactBody(finalExact, REPLACEMENT_BODY_ID, 'final').exactBrep, baselineReplacement.exactBrep,
    'direct-edit lifecycle changed replacement BREP bytes');
  assert.ok((await readPart(page)).features.every((entry: JsonRecord) => entry.type !== 'direct-edit'),
    'visible lifecycle cleanup left a direct-edit feature');
  assert.equal(await page.evaluate(() => (window as any).__pt013Injected), false,
    'literal-safe body or feature labels executed script');
  assert.deepEqual(failures, [], `direct-edit browser gate reported errors: ${failures.join(' | ')}`);

  console.log(JSON.stringify({
    schema: 'partmode.direct-editing-ui-smoke/v1',
    browserBacked: true,
    chrome: await browser.version(),
    controls: controls.map((entry) => entry.id),
    trustedDrag: {
      realPointerEvents: true,
      pointerStart: cancelDrag.before.pointerStart,
      pointerEnd: cancelDrag.before.pointerEnd,
      signedDistanceChanged: true,
      normalOnly: true,
      detachedFaceGuide: true,
      signedExtentGuide: true,
      cancelAtomic: true,
      applyAtomic: true,
    },
    typedLifecycle: ['push-pull', 'replace-face', 'delete-face'],
    saveReload: true,
    exactCurrentHashBound: true,
    topologyComplete: true,
    literalSafe: true,
  }, null, 2));

  await context.close();
} finally {
  await browser?.close().catch(() => {});
  await local?.close().catch(() => {});
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
