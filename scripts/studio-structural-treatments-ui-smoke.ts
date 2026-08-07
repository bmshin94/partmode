import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import puppeteer, { type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-structural-treatment-ui-'));
const MEMBER_A_ID = 'ui-treatment-member-a';
const MEMBER_B_ID = 'ui-treatment-member-b';
const MEMBER_A_BODY_ID = 'body-' + MEMBER_A_ID;
const MEMBER_B_BODY_ID = 'body-' + MEMBER_B_ID;
const HTML_LIKE_MEMBER_NAME = '<img src=x onerror="window.__wd002Injected=true"> Member A';
const HTML_LIKE_TREATMENT_NAME = '<svg onload="window.__wd002Injected=true"> Visible trim';

function closeTo(actual: unknown, expected: number, tolerance = 2e-4): boolean {
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

async function selectValue(page: Page, selector: string, value: string): Promise<void> {
  await assertHitTestable(page, selector);
  const selected = await page.select(selector, value);
  assert.deepEqual(selected, [value], `could not choose ${value} in ${selector}`);
}

async function waitForDialog(page: Page, open: boolean): Promise<void> {
  await page.waitForFunction((expectedOpen) =>
    (document.getElementById('bw-structural-treatment') as HTMLDialogElement | null)?.open === expectedOpen,
  { polling: 50, timeout: 120_000 }, open);
}

async function assertFieldsets(page: Page, activeKind: string): Promise<void> {
  const states = await page.$$eval('[data-structural-treatment-fields]', (fieldsets) => fieldsets.map((fieldset) => ({
    kind: (fieldset as HTMLElement).dataset.structuralTreatmentFields,
    hidden: (fieldset as HTMLFieldSetElement).hidden,
    disabled: (fieldset as HTMLFieldSetElement).disabled,
  })));
  assert.deepEqual(states.map((entry) => entry.kind), ['trim-extend', 'corner', 'gusset', 'end-cap'],
    'visible dialog does not expose exactly the four WD002 treatment families');
  for (const state of states) {
    const active = state.kind === activeKind;
    assert.equal(state.hidden, !active, `${state.kind} fieldset visibility does not follow ${activeKind}`);
    assert.equal(state.disabled, !active, `${state.kind} fieldset disabled state does not follow ${activeKind}`);
  }
}

async function assertDisabled(page: Page, selector: string, expected: boolean): Promise<void> {
  const disabled = await page.$eval(selector, (element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLButtonElement)) {
      throw new Error('expected a disable-capable form control');
    }
    return element.disabled;
  });
  assert.equal(disabled, expected, `${selector} disabled state is wrong`);
}

async function openCreateDialog(page: Page, kind: string): Promise<void> {
  await clickVisible(page, '#bw-structural-treatment-open');
  await waitForDialog(page, true);
  await selectValue(page, '#bw-structural-treatment-kind', kind);
  await assertFieldsets(page, kind);
}

function historySelector(featureId: string): string {
  return `#bw-history .hist-item[data-sel="${featureId}"]`;
}

async function openHistoryEdit(page: Page, featureId: string): Promise<void> {
  const selector = historySelector(featureId);
  await page.waitForSelector(selector, { visible: true, timeout: 30_000 });
  await clickVisible(page, `${selector} [data-edit="${featureId}"]`);
  await waitForDialog(page, true);
}

async function selectHistoryFeature(page: Page, featureId: string): Promise<void> {
  const selector = historySelector(featureId);
  await page.waitForSelector(selector, { visible: true, timeout: 30_000 });
  const selected = await page.$eval(`${selector} .hi-sel`, (element) =>
    element.getAttribute('aria-pressed') === 'true');
  if (!selected) await clickVisible(page, `${selector} .hi-sel`);
  await page.waitForFunction((id) => {
    const wrap = document.getElementById('bw-context-wrap') as HTMLElement | null;
    const selectedRow = document.querySelector(`#bw-history .hist-item[data-sel="${id}"] .hi-sel`);
    return wrap?.hidden === false && selectedRow?.getAttribute('aria-pressed') === 'true';
  }, { polling: 50, timeout: 30_000 }, featureId);
}

async function openInspectorEdit(page: Page, featureId: string): Promise<void> {
  await selectHistoryFeature(page, featureId);
  await page.waitForFunction(() =>
    (document.getElementById('bw-context-wrap') as HTMLElement | null)?.hidden === false
      && Boolean(document.querySelector('#bw-context [data-cxedit="1"]')),
  { polling: 50, timeout: 30_000 });
  await clickVisible(page, '#bw-context [data-cxedit="1"]');
  await waitForDialog(page, true);
}

async function assertEditLocks(
  page: Page,
  kind: string,
  associations: string[],
  editable: string[],
): Promise<void> {
  await assertFieldsets(page, kind);
  await assertDisabled(page, '#bw-structural-treatment-kind', true);
  for (const name of associations) {
    await assertDisabled(page, `#bw-structural-treatment-form [name="${name}"]`, true);
  }
  for (const name of editable) {
    await assertDisabled(page, `#bw-structural-treatment-form [name="${name}"]`, false);
    await assertHitTestable(page, `#bw-structural-treatment-form [name="${name}"]`);
  }
}

async function assertCurrentSettlement(page: Page, previous: JsonRecord, label: string): Promise<JsonRecord> {
  await waitForSettlement(page);
  const evidence = await page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    const settlement = await studio.latestDocumentSettlementForTest();
    return {
      settlement,
      canonicalHash: studio.canonicalHash(),
      documentRevision: studio.documentRevision(),
      appliedRevision: studio.appliedRevision(),
      errors: studio.errors(),
      bodyResults: studio.bodyResults(),
      docJson: studio.docJson(),
    };
  });
  assert.ok(evidence.settlement, `${label} has no document-settlement receipt`);
  assert.equal(evidence.appliedRevision, evidence.documentRevision, `${label} is not visibly settled`);
  assert.equal(evidence.settlement.status, 'settled', `${label} did not cross the settlement barrier`);
  assert.equal(evidence.settlement.target.documentHash, evidence.canonicalHash,
    `${label} target is not bound to the current canonical document hash`);
  assert.equal(evidence.settlement.target.kernelRevision, evidence.documentRevision,
    `${label} target is not bound to the current exact-kernel revision`);
  assert.equal(evidence.settlement.kernel.documentHash, evidence.canonicalHash,
    `${label} kernel receipt is not current-document-hash-bound`);
  assert.equal(evidence.settlement.kernel.kernelRevision, evidence.documentRevision,
    `${label} kernel receipt is not current-revision evidence`);
  assert.equal(evidence.settlement.persistence.documentHash, evidence.canonicalHash,
    `${label} persistence receipt is not current-document-hash-bound`);
  assert.equal(evidence.settlement.renderer.documentHash, evidence.canonicalHash,
    `${label} rendered frame is not current-document-hash-bound`);
  assert.deepEqual(evidence.errors, [], `${label} produced visible exact rebuild errors`);
  assert.ok(evidence.documentRevision > previous.documentRevision, `${label} did not advance the document revision`);
  assert.notEqual(evidence.canonicalHash, previous.canonicalHash, `${label} did not change the canonical document hash`);
  return evidence;
}

async function assertExactCurrent(
  page: Page,
  expectedBodyIds: string[],
  label: string,
): Promise<JsonRecord> {
  await waitForSettlement(page);
  const evidence = await page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    return {
      exact: await studio.exactBodyResultsForTest(),
      ordinary: studio.bodyResults(),
      canonicalHash: studio.canonicalHash(),
      documentRevision: studio.documentRevision(),
      appliedRevision: studio.appliedRevision(),
    };
  });
  assert.equal(evidence.appliedRevision, evidence.documentRevision, `${label} document is not settled`);
  assert.equal(evidence.exact.revision, evidence.documentRevision, `${label} exact proof is stale`);
  assert.equal(evidence.exact.effectiveDocumentHash, evidence.canonicalHash,
    `${label} exact proof is not current-document-hash-bound`);
  assert.deepEqual(evidence.exact.errors, [], `${label} isolated production-worker rebuild reported errors`);
  for (const bodyId of expectedBodyIds) {
    const body = evidence.exact.bodies.find((entry: JsonRecord) => entry.bodyId === bodyId);
    const ordinary = evidence.ordinary.find((entry: JsonRecord) => entry.bodyId === bodyId);
    assert.ok(body, `${label} omitted exact body ${bodyId}`);
    assert.equal(body.error, null, `${label} exact body ${bodyId} has an error`);
    assert.equal(body.lastValid, false, `${label} exact body ${bodyId} reused last-valid geometry`);
    assert.equal(body.geometry?.valid, true, `${label} body ${bodyId} is not a valid exact solid`);
    assert.equal(body.geometry?.brepValid, true, `${label} body ${bodyId} failed BRepCheck validation`);
    assert.equal(body.geometry?.solidCount, 1, `${label} body ${bodyId} is not exactly one solid`);
    assert.ok(typeof body.exactBrep === 'string' && body.exactBrep.length > 100,
      `${label} body ${bodyId} has no canonical exact BREP`);
    assert.ok(ordinary, `${label} visible settled body ${bodyId} is missing`);
    assert.deepEqual(ordinary.geometry?.bounds, body.geometry?.bounds,
      `${label} visible and isolated exact bounds disagree for ${bodyId}`);
    assert.ok(closeTo(ordinary.geometry?.volume, body.geometry?.volume),
      `${label} visible and isolated exact volumes disagree for ${bodyId}`);
  }
  return evidence;
}

async function deleteFromInspector(page: Page, featureId: string, label: string): Promise<JsonRecord> {
  const before = await projectState(page);
  const selector = historySelector(featureId);
  await selectHistoryFeature(page, featureId);
  await page.waitForFunction(() =>
    (document.getElementById('bw-context-wrap') as HTMLElement | null)?.hidden === false
      && Boolean(document.querySelector('#bw-context [data-cxdel="1"]')),
    { polling: 50, timeout: 30_000 });
  await clickVisible(page, '#bw-context [data-cxdel="1"]');
  await page.waitForFunction((id) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    const partId = document.rootDocument?.partId;
    const part = document.partDefinitions.find((entry: any) => entry.id === partId);
    return !part.features.some((entry: any) => entry.id === id);
  }, { polling: 100, timeout: 30_000 }, featureId);
  const evidence = await assertCurrentSettlement(page, before, label);
  assert.equal(await page.$(selector), null, `${label} left the treatment in visible history`);
  return evidence;
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
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('bw-studio-welcome-v1', '1');
    (window as any).__wd002Injected = false;
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
  assert.equal(response?.status(), 200, 'structural-treatment UI route did not return HTTP 200');
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  await clickVisible(page, '[data-workspace="solid"]');
  await assertHitTestable(page, '#bw-structural-treatment-open');

  const registryAudit = await page.evaluate(async () => {
    const studioScript = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
    if (!studioScript) throw new Error('Cannot locate the built Studio module URL.');
    const registryUrl = new URL('studio-v6-ui-registry.js', studioScript.src).href;
    const registryModule = await import(registryUrl);
    const matches = (registryModule.CAD_UI_CONTROL_REGISTRY as any[])
      .filter((entry) => entry.id === 'model.structural-treatment');
    const control = matches[0];
    const studioSource = await (await fetch(studioScript.src)).text();
    return {
      count: matches.length,
      control,
      typedDeleteRoutes: studioSource.match(/\? 'structural\.treatment\.delete' : 'feature\.delete'/gu)?.length || 0,
    };
  });
  assert.equal(registryAudit.count, 1, 'model.structural-treatment is not uniquely registered');
  assert.equal(registryAudit.control.adapter, 'available', 'Structural treatment is not an available semantic adapter');
  assert.equal(registryAudit.control.workspaceId, 'solid', 'Structural treatment is registered in the wrong workspace');
  assert.deepEqual(registryAudit.control.humanBindings,
    [{ kind: 'element-id', elementId: 'bw-structural-treatment-open' }],
    'registered treatment control is not bound to the visible ribbon button');
  assert.deepEqual(registryAudit.control.operationKinds,
    ['structural.treatment.create', 'structural.treatment.update', 'structural.treatment.delete'],
    'registered treatment control advertises the wrong typed operations');
  assert.deepEqual(registryAudit.control.fields.map((field: JsonRecord) => field.id), [
    'name', 'kind', 'memberId', 'end', 'mode', 'distance',
    'targetMemberId', 'targetEnd', 'otherMemberId', 'otherEnd', 'style',
    'leftMemberId', 'leftEnd', 'rightMemberId', 'rightEnd',
    'leftLegLength', 'rightLegLength', 'thickness',
  ], 'registered treatment field contract is incomplete');
  assert.equal(registryAudit.typedDeleteRoutes, 3,
    'visible history, inspector, and keyboard deletion are not all routed through structural.treatment.delete');

  const seedBefore = await projectState(page);
  await page.evaluate((fixture) => (window as any).__bwStudio.commitHumanOperationsForTest(
    'Seed perpendicular RECT members for WD002 UI acceptance',
    [
      { kind: 'project.clear', input: {} },
      {
        kind: 'sketch.path.create',
        input: {
          id: 'ui-treatment-path-a', name: 'Member A path', curveKind: 'polyline',
          points: [[0, 0, 0], [100, 0, 0]],
        },
      },
      {
        kind: 'sketch.path.create',
        input: {
          id: 'ui-treatment-path-b', name: 'Member B path', curveKind: 'polyline',
          points: [[0, 0, 0], [0, 100, 0]],
        },
      },
      {
        kind: 'structural.member.create',
        input: {
          id: fixture.memberAId, name: fixture.memberAName, pathSketchId: 'ui-treatment-path-a',
          familyId: 'rectangular-bar', presetId: 'rect-20x10',
        },
      },
      {
        kind: 'structural.member.create',
        input: {
          id: fixture.memberBId, name: 'Member B', pathSketchId: 'ui-treatment-path-b',
          familyId: 'rectangular-bar', presetId: 'rect-20x10',
        },
      },
    ],
  ), { memberAId: MEMBER_A_ID, memberBId: MEMBER_B_ID, memberAName: HTML_LIKE_MEMBER_NAME });
  await assertCurrentSettlement(page, seedBefore, 'perpendicular RECT member seed');
  let part = await readPart(page);
  assert.equal(part.features.filter((entry: JsonRecord) => entry.extensions?.structuralMember).length, 2,
    'browser fixture does not contain exactly two structural members');
  assert.deepEqual(part.features.filter((entry: JsonRecord) => entry.extensions?.structuralMember)
    .map((entry: JsonRecord) => entry.extensions.structuralMember.familyId),
  ['rectangular-bar', 'rectangular-bar'], 'browser fixture members are not RECT profiles');
  const baselineExact = await assertExactCurrent(page, [MEMBER_A_BODY_ID, MEMBER_B_BODY_ID], 'baseline perpendicular members');
  const baselineBodyA = baselineExact.exact.bodies.find((entry: JsonRecord) => entry.bodyId === MEMBER_A_BODY_ID);
  assert.ok(closeTo(baselineBodyA.geometry.volume, 20_000), 'baseline RECT member A exact volume drifted');

  const beforeCancel = await projectState(page);
  await openCreateDialog(page, 'trim-extend');
  for (const selector of [
    '#bw-structural-treatment-form [name="name"]',
    '#bw-structural-treatment-kind',
    '#bw-structural-treatment-form [name="trimMemberId"]',
    '#bw-structural-treatment-form [name="trimEnd"]',
    '#bw-structural-treatment-form [name="trimMode"]',
    '#bw-structural-treatment-form [name="trimDistance"]',
    '#bw-structural-treatment-cancel',
    '#bw-structural-treatment-apply',
  ]) await assertHitTestable(page, selector);
  const memberOptions = await page.$$eval('#bw-structural-treatment-form [name="trimMemberId"] option', (options) =>
    options.map((option) => ({ value: (option as HTMLOptionElement).value, text: option.textContent?.trim() || '' })));
  assert.equal(memberOptions.length, 2, 'visible treatment dialog did not list exactly the two seeded members');
  assert.equal(memberOptions.find((entry) => entry.value === MEMBER_A_ID)?.text,
    HTML_LIKE_MEMBER_NAME + ' · RECT 20 × 10', 'member name was not inserted as literal option text');
  assert.equal(await page.$('#bw-structural-treatment img'), null,
    'HTML-like member name created an element in the visible dialog');
  assert.equal(await page.evaluate(() => (window as any).__wd002Injected), false,
    'HTML-like member name executed in the visible dialog');
  await selectValue(page, '#bw-structural-treatment-kind', 'gusset');
  await assertFieldsets(page, 'gusset');
  await replaceValue(page, '#bw-structural-treatment-form [name="name"]', 'Cancelled gusset draft');
  await replaceValue(page, '#bw-structural-treatment-form [name="gussetThickness"]', '7');
  assert.equal(await page.evaluate(() => (window as any).__bwStudio.docJson()), beforeCancel.docJson,
    'visible treatment draft mutated the authoritative document before Apply');
  await clickVisible(page, '#bw-structural-treatment-cancel');
  await waitForDialog(page, false);
  await waitForSettlement(page);
  assert.deepEqual(await projectState(page), beforeCancel,
    'Cancel changed treatment document bytes, hash, revision, or undo/redo history');

  // Trim -> extend, preserving member/body/end association identity.
  let beforeApply = await projectState(page);
  await openCreateDialog(page, 'trim-extend');
  await replaceValue(page, '#bw-structural-treatment-form [name="name"]', HTML_LIKE_TREATMENT_NAME);
  await selectValue(page, '#bw-structural-treatment-form [name="trimMemberId"]', MEMBER_A_ID);
  await selectValue(page, '#bw-structural-treatment-form [name="trimEnd"]', 'start');
  await selectValue(page, '#bw-structural-treatment-form [name="trimMode"]', 'trim');
  await replaceValue(page, '#bw-structural-treatment-form [name="trimDistance"]', '10');
  await clickVisible(page, '#bw-structural-treatment-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeApply, 'visible trim create');
  part = await readPart(page);
  let treatment = part.features.find((entry: JsonRecord) => entry.extensions?.weldmentTreatment?.kind === 'trim-extend');
  assert.ok(treatment, 'visible trim create did not persist a weldment-treatment feature');
  const trimId = treatment.id;
  const trimRecipe = structuredClone(treatment.extensions.weldmentTreatment);
  assert.equal(treatment.name, HTML_LIKE_TREATMENT_NAME, 'visible trim create changed the literal treatment name');
  assert.equal(trimRecipe.memberId, MEMBER_A_ID, 'visible trim create persisted the wrong member association');
  assert.equal(trimRecipe.memberBodyId, MEMBER_A_BODY_ID, 'visible trim create detached its target body');
  assert.equal(trimRecipe.end, 'start', 'visible trim create persisted the wrong named endpoint');
  assert.equal(trimRecipe.mode, 'trim', 'visible trim create persisted the wrong mode');
  assert.equal(trimRecipe.distance, 10, 'visible trim create persisted the wrong distance');
  const trimHistory = historySelector(trimId);
  await page.waitForSelector(trimHistory, { visible: true, timeout: 30_000 });
  const trimHistoryText = await page.$eval(trimHistory, (element) => element.textContent || '');
  assert.match(trimHistoryText, /TE\s*3\. Trim \/ extend/u, 'history labels visible trim as a generic feature');
  assert.ok(trimHistoryText.includes(HTML_LIKE_MEMBER_NAME), 'history omits the treated member association');
  assert.equal(await page.$(`${trimHistory} img`), null, 'HTML-like member name created an element in history');
  assert.equal(await page.evaluate(() => (window as any).__wd002Injected), false,
    'HTML-like member or treatment name executed in history');

  beforeApply = await projectState(page);
  await openHistoryEdit(page, trimId);
  await assertEditLocks(page, 'trim-extend', ['trimMemberId', 'trimEnd'], ['name', 'trimMode', 'trimDistance']);
  await replaceValue(page, '#bw-structural-treatment-form [name="name"]', 'Visible extend treatment');
  await selectValue(page, '#bw-structural-treatment-form [name="trimMode"]', 'extend');
  await replaceValue(page, '#bw-structural-treatment-form [name="trimDistance"]', '5');
  await clickVisible(page, '#bw-structural-treatment-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeApply, 'visible trim-to-extend edit');
  part = await readPart(page);
  treatment = part.features.find((entry: JsonRecord) => entry.id === trimId);
  assert.equal(treatment.id, trimId, 'trim-to-extend edit replaced the treatment feature identity');
  assert.equal(treatment.extensions.weldmentTreatment.featureId, trimRecipe.featureId,
    'trim-to-extend edit replaced recipe identity');
  assert.equal(treatment.extensions.weldmentTreatment.memberId, trimRecipe.memberId,
    'trim-to-extend edit changed its member association');
  assert.equal(treatment.extensions.weldmentTreatment.memberBodyId, trimRecipe.memberBodyId,
    'trim-to-extend edit changed its body association');
  assert.equal(treatment.extensions.weldmentTreatment.end, trimRecipe.end,
    'trim-to-extend edit changed its named endpoint');
  assert.equal(treatment.extensions.weldmentTreatment.mode, 'extend', 'visible edit did not persist Extend');
  assert.equal(treatment.extensions.weldmentTreatment.distance, 5, 'visible edit persisted the wrong Extend distance');
  const extendedExact = await assertExactCurrent(page, [MEMBER_A_BODY_ID, MEMBER_B_BODY_ID], 'visible extend result');
  const extendedBody = extendedExact.exact.bodies.find((entry: JsonRecord) => entry.bodyId === MEMBER_A_BODY_ID);
  assert.ok(closeTo(extendedBody.geometry.volume, 21_000), 'visible Extend exact volume is wrong');
  await deleteFromInspector(page, trimId, 'visible typed trim/extend delete');
  const afterTrimDelete = await assertExactCurrent(page, [MEMBER_A_BODY_ID, MEMBER_B_BODY_ID], 'trim delete restores source');
  assert.equal(afterTrimDelete.exact.bodies.find((entry: JsonRecord) => entry.bodyId === MEMBER_A_BODY_ID)?.exactBrep,
    baselineBodyA.exactBrep, 'visible typed trim delete did not restore the source BREP bytes');

  // Miter -> cope, preserving both exact member/body/end associations.
  beforeApply = await projectState(page);
  await openCreateDialog(page, 'corner');
  await replaceValue(page, '#bw-structural-treatment-form [name="name"]', 'Visible miter corner');
  await selectValue(page, '#bw-structural-treatment-form [name="cornerTargetMemberId"]', MEMBER_A_ID);
  await selectValue(page, '#bw-structural-treatment-form [name="cornerTargetEnd"]', 'start');
  await selectValue(page, '#bw-structural-treatment-form [name="cornerOtherMemberId"]', MEMBER_B_ID);
  await selectValue(page, '#bw-structural-treatment-form [name="cornerOtherEnd"]', 'start');
  await selectValue(page, '#bw-structural-treatment-form [name="cornerStyle"]', 'miter');
  await clickVisible(page, '#bw-structural-treatment-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeApply, 'visible miter create');
  part = await readPart(page);
  treatment = part.features.find((entry: JsonRecord) => entry.extensions?.weldmentTreatment?.kind === 'corner');
  assert.ok(treatment, 'visible miter create did not persist a corner treatment');
  const cornerId = treatment.id;
  const cornerRecipe = structuredClone(treatment.extensions.weldmentTreatment);
  assert.equal(cornerRecipe.style, 'miter', 'visible corner create persisted the wrong style');
  assert.equal(cornerRecipe.targetMemberId, MEMBER_A_ID, 'visible miter detached its target member');
  assert.equal(cornerRecipe.otherMemberId, MEMBER_B_ID, 'visible miter detached its other member');

  beforeApply = await projectState(page);
  await openHistoryEdit(page, cornerId);
  await assertEditLocks(page, 'corner',
    ['cornerTargetMemberId', 'cornerTargetEnd', 'cornerOtherMemberId', 'cornerOtherEnd'],
    ['name', 'cornerStyle']);
  await replaceValue(page, '#bw-structural-treatment-form [name="name"]', 'Visible cope corner');
  await selectValue(page, '#bw-structural-treatment-form [name="cornerStyle"]', 'cope');
  await clickVisible(page, '#bw-structural-treatment-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeApply, 'visible miter-to-cope edit');
  part = await readPart(page);
  treatment = part.features.find((entry: JsonRecord) => entry.id === cornerId);
  assert.equal(treatment.id, cornerId, 'miter-to-cope edit replaced the treatment feature identity');
  for (const key of ['featureId', 'targetMemberId', 'targetBodyId', 'targetEnd', 'otherMemberId', 'otherBodyId', 'otherEnd']) {
    assert.equal(treatment.extensions.weldmentTreatment[key], cornerRecipe[key],
      `miter-to-cope edit changed immutable ${key}`);
  }
  assert.equal(treatment.extensions.weldmentTreatment.style, 'cope', 'visible edit did not persist Cope');
  const copeExact = await assertExactCurrent(page, [MEMBER_A_BODY_ID, MEMBER_B_BODY_ID], 'visible cope result');
  const copeBody = copeExact.exact.bodies.find((entry: JsonRecord) => entry.bodyId === MEMBER_A_BODY_ID);
  assert.ok(copeBody.geometry.volume > 0 && copeBody.geometry.volume < 20_000,
    'visible Cope did not remove exact overlapping member material');
  await deleteFromInspector(page, cornerId, 'visible typed corner delete');

  // Gusset dimensions remain editable while both member/end associations stay locked.
  beforeApply = await projectState(page);
  await openCreateDialog(page, 'gusset');
  await replaceValue(page, '#bw-structural-treatment-form [name="name"]', 'Visible gusset');
  await selectValue(page, '#bw-structural-treatment-form [name="gussetLeftMemberId"]', MEMBER_A_ID);
  await selectValue(page, '#bw-structural-treatment-form [name="gussetLeftEnd"]', 'start');
  await selectValue(page, '#bw-structural-treatment-form [name="gussetRightMemberId"]', MEMBER_B_ID);
  await selectValue(page, '#bw-structural-treatment-form [name="gussetRightEnd"]', 'start');
  await replaceValue(page, '#bw-structural-treatment-form [name="gussetLeftLegLength"]', '30');
  await replaceValue(page, '#bw-structural-treatment-form [name="gussetRightLegLength"]', '30');
  await replaceValue(page, '#bw-structural-treatment-form [name="gussetThickness"]', '4');
  await clickVisible(page, '#bw-structural-treatment-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeApply, 'visible gusset create');
  part = await readPart(page);
  treatment = part.features.find((entry: JsonRecord) => entry.extensions?.weldmentTreatment?.kind === 'gusset');
  assert.ok(treatment, 'visible gusset create did not persist a gusset treatment');
  const gussetId = treatment.id;
  const gussetRecipe = structuredClone(treatment.extensions.weldmentTreatment);
  const gussetBody = part.bodies.find((entry: JsonRecord) => entry.createdByFeatureId === gussetId);
  assert.ok(gussetBody, 'visible gusset create did not persist its owned body');

  beforeApply = await projectState(page);
  await openInspectorEdit(page, gussetId);
  await assertEditLocks(page, 'gusset',
    ['gussetLeftMemberId', 'gussetLeftEnd', 'gussetRightMemberId', 'gussetRightEnd'],
    ['name', 'gussetLeftLegLength', 'gussetRightLegLength', 'gussetThickness']);
  await replaceValue(page, '#bw-structural-treatment-form [name="name"]', 'Visible gusset updated');
  await replaceValue(page, '#bw-structural-treatment-form [name="gussetLeftLegLength"]', '35');
  await replaceValue(page, '#bw-structural-treatment-form [name="gussetRightLegLength"]', '25');
  await replaceValue(page, '#bw-structural-treatment-form [name="gussetThickness"]', '5');
  await clickVisible(page, '#bw-structural-treatment-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeApply, 'visible gusset edit');
  part = await readPart(page);
  treatment = part.features.find((entry: JsonRecord) => entry.id === gussetId);
  assert.equal(treatment.id, gussetId, 'gusset edit replaced the treatment feature identity');
  for (const key of ['featureId', 'leftMemberId', 'leftEnd', 'rightMemberId', 'rightEnd']) {
    assert.equal(treatment.extensions.weldmentTreatment[key], gussetRecipe[key], `gusset edit changed immutable ${key}`);
  }
  assert.equal(part.bodies.find((entry: JsonRecord) => entry.createdByFeatureId === gussetId)?.id, gussetBody.id,
    'gusset edit replaced its owned body identity');
  const gussetExact = await assertExactCurrent(page,
    [MEMBER_A_BODY_ID, MEMBER_B_BODY_ID, gussetBody.id], 'visible gusset result');
  const exactGussetBody = gussetExact.exact.bodies.find((entry: JsonRecord) => entry.bodyId === gussetBody.id);
  assert.ok(closeTo(exactGussetBody.geometry.volume, 35 * 25 * 5 / 2),
    'visible gusset exact volume is not triangle area × thickness');
  await deleteFromInspector(page, gussetId, 'visible typed gusset delete');
  part = await readPart(page);
  assert.ok(!part.bodies.some((entry: JsonRecord) => entry.id === gussetBody.id),
    'visible typed gusset delete left its owned body');

  // End-cap thickness edit, durable save/reload, then typed cleanup.
  beforeApply = await projectState(page);
  await openCreateDialog(page, 'end-cap');
  await replaceValue(page, '#bw-structural-treatment-form [name="name"]', 'Visible end cap');
  await selectValue(page, '#bw-structural-treatment-form [name="capMemberId"]', MEMBER_A_ID);
  await selectValue(page, '#bw-structural-treatment-form [name="capEnd"]', 'end');
  await replaceValue(page, '#bw-structural-treatment-form [name="capThickness"]', '3');
  await clickVisible(page, '#bw-structural-treatment-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeApply, 'visible end-cap create');
  part = await readPart(page);
  treatment = part.features.find((entry: JsonRecord) => entry.extensions?.weldmentTreatment?.kind === 'end-cap');
  assert.ok(treatment, 'visible end-cap create did not persist an end-cap treatment');
  const endCapId = treatment.id;
  const endCapRecipe = structuredClone(treatment.extensions.weldmentTreatment);
  const endCapBody = part.bodies.find((entry: JsonRecord) => entry.createdByFeatureId === endCapId);
  assert.ok(endCapBody, 'visible end-cap create did not persist its owned body');

  beforeApply = await projectState(page);
  await openHistoryEdit(page, endCapId);
  await assertEditLocks(page, 'end-cap', ['capMemberId', 'capEnd'], ['name', 'capThickness']);
  await replaceValue(page, '#bw-structural-treatment-form [name="name"]', 'Visible end cap updated');
  await replaceValue(page, '#bw-structural-treatment-form [name="capThickness"]', '4');
  await clickVisible(page, '#bw-structural-treatment-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeApply, 'visible end-cap edit');
  part = await readPart(page);
  treatment = part.features.find((entry: JsonRecord) => entry.id === endCapId);
  assert.equal(treatment.id, endCapId, 'end-cap edit replaced the treatment feature identity');
  for (const key of ['featureId', 'memberId', 'end']) {
    assert.equal(treatment.extensions.weldmentTreatment[key], endCapRecipe[key], `end-cap edit changed immutable ${key}`);
  }
  assert.equal(treatment.extensions.weldmentTreatment.thickness, 4, 'visible edit persisted the wrong cap thickness');
  assert.equal(part.bodies.find((entry: JsonRecord) => entry.createdByFeatureId === endCapId)?.id, endCapBody.id,
    'end-cap edit replaced its owned body identity');
  const capExact = await assertExactCurrent(page,
    [MEMBER_A_BODY_ID, MEMBER_B_BODY_ID, endCapBody.id], 'visible end-cap result');
  const exactCapBody = capExact.exact.bodies.find((entry: JsonRecord) => entry.bodyId === endCapBody.id);
  assert.ok(closeTo(exactCapBody.geometry.volume, 800),
    'visible end-cap exact volume is not RECT profile area × thickness');

  await page.evaluate(async () => (window as any).__bwStudio.flushStorage());
  const savedState = await projectState(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  const reopenedState = await projectState(page);
  assert.equal(reopenedState.docJson, savedState.docJson,
    'save/reload changed the canonical treatment document bytes');
  assert.equal(reopenedState.canonicalHash, savedState.canonicalHash,
    'save/reload changed the canonical treatment document hash');
  part = await readPart(page);
  treatment = part.features.find((entry: JsonRecord) => entry.id === endCapId);
  assert.ok(treatment, 'save/reload lost the visible end-cap treatment');
  assert.deepEqual(treatment.extensions.weldmentTreatment,
    rootPart(JSON.parse(savedState.docJson)).features.find((entry: JsonRecord) => entry.id === endCapId)
      .extensions.weldmentTreatment,
  'save/reload changed the persistent end-cap recipe');
  assert.equal(part.bodies.find((entry: JsonRecord) => entry.createdByFeatureId === endCapId)?.id, endCapBody.id,
    'save/reload replaced the end-cap body identity');
  assert.equal(await page.evaluate(() => (window as any).__wd002Injected), false,
    'persisted HTML-like name executed after reload');
  await assertExactCurrent(page, [MEMBER_A_BODY_ID, MEMBER_B_BODY_ID, endCapBody.id], 'reopened end-cap result');
  await deleteFromInspector(page, endCapId, 'visible typed end-cap delete after reload');
  part = await readPart(page);
  assert.ok(!part.bodies.some((entry: JsonRecord) => entry.id === endCapBody.id),
    'visible typed end-cap delete left its owned body');

  const finalExact = await assertExactCurrent(page, [MEMBER_A_BODY_ID, MEMBER_B_BODY_ID], 'final treatment cleanup');
  assert.equal(finalExact.exact.bodies.length, 2, 'treatment cleanup left generated exact bodies');
  assert.ok((await readPart(page)).features.every((entry: JsonRecord) => !entry.extensions?.weldmentTreatment),
    'treatment cleanup left a persisted weldment-treatment feature');
  assert.deepEqual(failures, [], `structural-treatment browser gate reported errors: ${failures.join(' | ')}`);

  console.log(JSON.stringify({
    schema: 'partmode.structural-treatments-ui-smoke/v1',
    browserBacked: true,
    visibleLifecycle: {
      trimExtend: ['trim-create', 'extend-edit', 'typed-delete'],
      corner: ['miter-create', 'cope-edit', 'typed-delete'],
      gusset: ['create', 'dimension-edit', 'typed-delete'],
      endCap: ['create', 'thickness-edit', 'save-reload', 'typed-delete'],
      cancelNoMutation: true,
    },
    registeredControl: 'model.structural-treatment',
    perpendicularRectMembers: [MEMBER_A_ID, MEMBER_B_ID],
    stableFeatureAssociationAndBodyIds: true,
    immutableAssociationControlsDisabled: true,
    inactiveTreatmentFieldsetsDisabled: true,
    exactEvidence: {
      currentRevisionBoundAfterEveryApply: true,
      currentDocumentHashBoundAfterEveryApply: true,
      isolatedProductionWorkerFamilies: ['extend', 'cope', 'gusset', 'end-cap'],
      trimDeleteRestoredSourceBrep: true,
    },
    htmlLikeNamesEscaped: true,
    consoleNetworkResponsePageErrors: 0,
  }, null, 2));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
