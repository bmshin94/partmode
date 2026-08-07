import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import puppeteer, { type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-smart-fasteners-ui-'));
const TARGET_FEATURE_ID = 'feature-ui-smart-fastener-plate';
const TARGET_HOLE_ID = 'feature-ui-smart-fastener-hole';
const TARGET_BODY_ID = 'body-' + TARGET_FEATURE_ID;
const TARGET_OCCURRENCE_ID = 'occurrence-ui-smart-fastener-target';
const HTML_LIKE_NAME = '<img src=x onerror="window.__as016Injected=true"> Exact M6 stack';

function closeTo(actual: unknown, expected: number, tolerance = 2e-6): boolean {
  const value = Number(actual);
  return Number.isFinite(value) && Math.abs(value - expected) <= tolerance;
}

function rootAssembly(document: JsonRecord): JsonRecord {
  const assembly = document.assemblyDefinitions?.find(
    (entry: JsonRecord) => entry.id === document.rootDocument?.assemblyId,
  );
  assert.ok(assembly, 'browser document has no active root assembly');
  return assembly;
}

function smartGroup(document: JsonRecord): JsonRecord {
  const groups = rootAssembly(document).extensions?.smartFasteners?.groups;
  assert.ok(Array.isArray(groups) && groups.length === 1,
    'browser document does not contain exactly one Smart Fastener group');
  return groups[0];
}

async function readDocument(page: Page): Promise<JsonRecord> {
  return page.evaluate(() => JSON.parse((window as any).__bwStudio.docJson()));
}

async function waitForSettlement(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    return studio
      && studio.appliedRevision() === studio.documentRevision()
      && studio.mode()?.kind === 'idle';
  }, { polling: 100, timeout: 180_000 });
}

async function waitForDialog(page: Page, open: boolean): Promise<void> {
  await page.waitForFunction((expectedOpen) =>
    (document.getElementById('bw-v5-command') as HTMLDialogElement | null)?.open === expectedOpen,
  { polling: 50, timeout: 180_000 }, open);
}

async function projectState(page: Page): Promise<JsonRecord> {
  return page.evaluate(() => {
    const studio = (window as any).__bwStudio;
    return {
      docJson: studio.docJson(),
      canonicalHash: studio.canonicalHash(),
      commandRevision: studio.commandRevision(),
      documentRevision: studio.documentRevision(),
      appliedRevision: studio.appliedRevision(),
      undoDepth: studio.undoDepth(),
      redoDepth: studio.redoDepth(),
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
    (element instanceof HTMLButtonElement || element instanceof HTMLInputElement)
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

async function assertCurrentSettlement(page: Page, previous: JsonRecord, label: string): Promise<JsonRecord> {
  await waitForSettlement(page);
  const evidence = await page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    return {
      settlement: await studio.latestDocumentSettlementForTest(),
      canonicalHash: studio.canonicalHash(),
      documentRevision: studio.documentRevision(),
      appliedRevision: studio.appliedRevision(),
      errors: studio.errors(),
    };
  });
  assert.equal(evidence.documentRevision, evidence.appliedRevision, `${label} is not visibly settled`);
  assert.equal(evidence.settlement?.status, 'settled', `${label} did not cross the settlement barrier`);
  assert.equal(evidence.settlement?.target?.documentHash, evidence.canonicalHash,
    `${label} settlement is not bound to the current document hash`);
  assert.equal(evidence.settlement?.target?.kernelRevision, evidence.documentRevision,
    `${label} settlement is not bound to the current kernel revision`);
  assert.equal(evidence.settlement?.kernel?.documentHash, evidence.canonicalHash,
    `${label} worker receipt is not current-document-hash-bound`);
  assert.equal(evidence.settlement?.persistence?.documentHash, evidence.canonicalHash,
    `${label} persistence receipt is not current-document-hash-bound`);
  assert.equal(evidence.settlement?.renderer?.documentHash, evidence.canonicalHash,
    `${label} rendered frame is not current-document-hash-bound`);
  assert.deepEqual(evidence.errors, [], `${label} produced visible worker errors`);
  assert.ok(evidence.documentRevision > previous.documentRevision, `${label} did not advance revision`);
  assert.notEqual(evidence.canonicalHash, previous.canonicalHash, `${label} did not change document hash`);
  return evidence;
}

async function connectCommandAgent(page: Page, operationKind: string, maxCommits: number): Promise<string> {
  return page.evaluate(async (input) => {
    const connection = await (window as any).__bwStudio.connectAgentForTest({
      clientLabel: `AS016 Smart Fastener ${input.operationKind}`,
      mode: 'scoped-auto-commit',
      permissionContext: {
        granted: ['project.read', 'project.edit', 'ui.read', 'ui.select', 'ui.command-draft', 'ui.present-preview'],
        operationKinds: [input.operationKind],
        maxCommits: input.maxCommits,
      },
    });
    return connection.connectionToken;
  }, { operationKind, maxCommits });
}

async function disconnectCommandAgent(page: Page, token: string): Promise<void> {
  await page.evaluate((connectionToken) => (window as any).partmodeAgent.disconnect(connectionToken), token);
}

async function assertAgentDisconnected(page: Page, label: string): Promise<void> {
  const status = await page.evaluate(() => (window as any).partmodeAgent.status());
  assert.equal(status?.connected, false, `${label} unexpectedly depended on a connected agent session`);
}

async function replaceVisibleText(page: Page, selector: string, value: string): Promise<void> {
  await assertHitTestable(page, selector);
  const input = await page.$(selector);
  assert.ok(input, `visible text control disappeared: ${selector}`);
  try {
    await clickVisible(page, selector);
    await page.$eval(selector, (element) => (element as HTMLInputElement).select());
    await page.keyboard.press('Backspace');
    await page.keyboard.type(value);
  } finally {
    await input.dispose();
  }
  assert.equal(await page.$eval(selector, (element) => (element as HTMLInputElement).value), value,
    `physical typing did not reach ${selector}`);
}

async function previewOpenSmartFastenerAsHuman(
  page: Page,
  name: string,
  expectedChange: 'created' | 'updated',
): Promise<JsonRecord> {
  await assertAgentDisconnected(page, `human ${expectedChange} preview start`);
  await replaceVisibleText(page, '#bw-v5-command-form [name="name"]', name);
  const beforePreview = await projectState(page);
  const initialControls = await page.evaluate(() => ({
    previewText: document.getElementById('bw-v5-command-preview')?.textContent || '',
    previewDisabled: (document.getElementById('bw-v5-command-preview') as HTMLButtonElement | null)?.disabled,
    applyText: document.getElementById('bw-v5-command-apply')?.textContent || '',
    applyDisabled: (document.getElementById('bw-v5-command-apply') as HTMLButtonElement | null)?.disabled,
  }));
  assert.equal(initialControls.previewDisabled, false, 'visible human Preview control is disabled');
  assert.match(initialControls.previewText, /Run exact preview/u,
    'visible human Preview control does not advertise exact preview');
  assert.equal(initialControls.applyDisabled, true, 'Apply was enabled before the human exact preview');
  assert.match(initialControls.applyText, /Preview required/u,
    'Apply did not explain that the human exact preview is required');

  await clickVisible(page, '#bw-v5-command-preview');
  await page.waitForFunction(() => {
    const surface = document.getElementById('bw-v6-command-preview');
    const title = document.getElementById('bw-v6-command-preview-title');
    const preview = document.getElementById('bw-v5-command-preview') as HTMLButtonElement | null;
    const apply = document.getElementById('bw-v5-command-apply') as HTMLButtonElement | null;
    const error = document.getElementById('bw-v5-command-error')?.textContent || '';
    return error.length > 0 || (surface?.hidden === false
      && /Exact validation passed/u.test(title?.textContent || '')
      && preview?.disabled === false
      && /Re-run exact preview/u.test(preview.textContent || '')
      && apply?.disabled === false);
  }, { polling: 50, timeout: 180_000 });
  const previewError = await page.$eval('#bw-v5-command-error', (element) => element.textContent || '');
  assert.equal(previewError, '', `human ${expectedChange} exact preview failed: ${previewError}`);
  await assertAgentDisconnected(page, `human ${expectedChange} preview completion`);
  assert.deepEqual(await projectState(page), beforePreview,
    `human ${expectedChange} preview mutated document bytes, hash, revision, or history before Apply`);
  const result = await page.evaluate(() => ({
    surfaceTitle: document.getElementById('bw-v6-command-preview-title')?.textContent || '',
    surfaceSummary: document.getElementById('bw-v6-command-preview-summary')?.textContent || '',
    evidence: document.getElementById('bw-v6-command-preview-evidence')?.textContent || '',
    previewText: document.getElementById('bw-v5-command-preview')?.textContent || '',
    applyText: document.getElementById('bw-v5-command-apply')?.textContent || '',
  }));
  assert.match(result.surfaceTitle, /Exact validation passed/u,
    'human exact preview did not report success visibly');
  assert.match(result.surfaceSummary, new RegExp(expectedChange, 'u'),
    `human exact preview omitted its ${expectedChange} change count`);
  assert.match(result.evidence, /exact geometry valid/u,
    'human exact preview omitted its exact-kernel evidence');
  assert.match(result.applyText, /Apply exact preview/u,
    'human exact preview did not enable the visible exact Apply action');
  return result;
}

async function previewOpenSmartFastenerCommand(
  page: Page,
  token: string,
  name: string,
  expectedOperationKind: 'smartFastener.apply' | 'smartFastener.update',
): Promise<JsonRecord> {
  const result = await page.evaluate(async (input) => {
    const studio = (window as any).__bwStudio;
    const agent = (window as any).partmodeAgent;
    let sequence = 0;
    const request = (args: JsonRecord) => agent.requestTool(
      input.token,
      'cad_ui',
      args,
      `as016-command-${++sequence}`,
    );
    const opened = await request({ action: 'snapshot' });
    const dialog = document.getElementById('bw-v5-command') as HTMLDialogElement | null;
    if (opened.activeCommand?.commandId !== 'assembly.smart-fastener' || dialog?.open !== true) {
      throw new Error(`Smart Fastener did not expose its visible semantic command: ${JSON.stringify(opened)}`);
    }
    await request({
      action: 'apply',
      expectedUiRevision: opened.uiRevision,
      actions: [{ kind: 'command.setInput', fieldId: 'name', value: input.name }],
      presentation: { mode: 'instant', transition: 'cut' },
    });
    const configured = await request({ action: 'snapshot' });
    const script = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
    if (!script) throw new Error('cannot locate built Studio module');
    const interaction = await import(new URL('studio-v6-interaction.js', script.src).href);
    const built = interaction.buildCadUiCommandTransaction({
      draft: configured.activeCommand,
      expectedRevision: configured.activeCommand.baseRevision,
      transactionId: configured.activeCommand.transactionId,
    });
    const operation = built.transaction?.operations?.[0];
    if (operation?.kind !== input.expectedOperationKind || operation?.input?.name !== input.name
        || operation?.input?.plan?.schema !== 'partmode.smart-fastener-plan/v1') {
      throw new Error(`visible Smart Fastener draft built the wrong operation: ${JSON.stringify(operation)}`);
    }
    const previewBatch = await request({
      action: 'apply',
      expectedUiRevision: configured.uiRevision,
      actions: [{ kind: 'command.preview' }],
      presentation: { mode: 'instant', transition: 'cut' },
    });
    const preview = previewBatch.results?.find((entry: JsonRecord) => entry.kind === 'command.preview')?.result;
    const previewed = await request({ action: 'snapshot' });
    const surface = document.getElementById('bw-v6-command-preview');
    const apply = document.getElementById('bw-v5-command-apply') as HTMLButtonElement | null;
    if (
      typeof preview?.previewId !== 'string'
      || preview.validation?.valid !== true
      || preview.validation?.exactGeometry !== true
      || preview.evidence?.exactGeometry !== true
      || preview.directVisibleHashParity !== true
      || preview.changeSet?.documentHashBefore !== studio.canonicalHash()
      || preview.changeSet?.documentHashAfter === studio.canonicalHash()
      || previewed.preview?.previewId !== preview.previewId
      || previewed.preview?.visible !== true
      || surface?.hidden !== false
      || apply?.disabled !== false
    ) throw new Error(`Smart Fastener preview evidence is incomplete: ${JSON.stringify({ preview, previewed })}`);
    return {
      preview,
      operation,
      activeCommand: configured.activeCommand,
      visibleName: (document.querySelector('#bw-v5-command-form [name="name"]') as HTMLInputElement | null)?.value,
      surfaceTitle: document.getElementById('bw-v6-command-preview-title')?.textContent || '',
      surfaceSummary: document.getElementById('bw-v6-command-preview-summary')?.textContent || '',
    };
  }, { token, name, expectedOperationKind });
  assert.equal(result.visibleName, name, 'semantic name did not reach the visible form');
  assert.match(result.surfaceTitle, /Exact validation passed/u, 'visible exact preview did not report success');
  assert.match(result.surfaceSummary, /created|updated/u, 'visible exact preview omitted change counts');
  return result;
}

async function assertPreviewCancelNoMutation(page: Page): Promise<void> {
  const before = await projectState(page);
  const token = await connectCommandAgent(page, 'smartFastener.apply', 0);
  try {
    await clickVisible(page, '#bw-smart-fastener-open');
    await waitForDialog(page, true);
    await previewOpenSmartFastenerCommand(page, token, 'Preview-only Smart Fastener', 'smartFastener.apply');
    const snapshot = await page.evaluate(async (connectionToken) => {
      const agent = (window as any).partmodeAgent;
      let current = await agent.requestTool(connectionToken, 'cad_ui', { action: 'snapshot' }, 'as016-cancel-snapshot');
      await agent.requestTool(connectionToken, 'cad_ui', {
        action: 'apply', expectedUiRevision: current.uiRevision,
        actions: [{ kind: 'preview.dismiss' }], presentation: { mode: 'instant', transition: 'cut' },
      }, 'as016-dismiss');
      current = await agent.requestTool(connectionToken, 'cad_ui', { action: 'snapshot' }, 'as016-dismissed-snapshot');
      await agent.requestTool(connectionToken, 'cad_ui', {
        action: 'apply', expectedUiRevision: current.uiRevision,
        actions: [{ kind: 'command.cancel' }], presentation: { mode: 'instant', transition: 'cut' },
      }, 'as016-cancel');
      return agent.requestTool(connectionToken, 'cad_ui', { action: 'snapshot' }, 'as016-closed-snapshot');
    }, token);
    assert.equal(snapshot.activeCommand == null, true, 'semantic cancel left a Smart Fastener command open');
    assert.equal(snapshot.preview == null, true, 'semantic cancel left a preview record visible');
    await waitForDialog(page, false);
    assert.deepEqual(await projectState(page), before,
      'Smart Fastener preview/dismiss/cancel mutated document bytes, hash, revision, or history');
  } finally {
    await disconnectCommandAgent(page, token);
  }
}

async function assertSelectionReplanCancelRace(page: Page): Promise<void> {
  const before = await projectState(page);
  const token = await connectCommandAgent(page, 'smartFastener.apply', 0);
  try {
    await clickVisible(page, '#bw-smart-fastener-open');
    await waitForDialog(page, true);
    const opened = await page.evaluate(async (connectionToken) =>
      (window as any).partmodeAgent.requestTool(
        connectionToken, 'cad_ui', { action: 'snapshot' }, 'as016-race-opened',
      ), token);
    assert.equal(opened.activeCommand?.commandId, 'assembly.smart-fastener',
      'selection-race fixture did not open Smart Fastener');
    await page.evaluate((input) => {
      const pending = (window as any).partmodeAgent.requestTool(input.token, 'cad_ui', {
        action: 'apply',
        expectedUiRevision: input.uiRevision,
        actions: [{
          kind: 'command.bindSelection',
          fieldId: 'targetOccurrence',
          entities: [{ kind: 'occurrence', id: input.occurrenceId }],
        }],
        presentation: { mode: 'instant', transition: 'cut' },
      }, 'as016-selection-replan-race');
      (window as any).__as016SelectionRace = pending.then(
        (value: unknown) => ({ status: 'fulfilled', value }),
        (error: unknown) => ({
          status: 'rejected',
          message: String((error as Error)?.message || error),
        }),
      );
    }, { token, uiRevision: opened.uiRevision, occurrenceId: TARGET_OCCURRENCE_ID });
    await clickVisible(page, '#bw-v5-command-cancel');
    await waitForDialog(page, false);
    const result = await page.evaluate(async () => {
      const pending = (window as any).__as016SelectionRace;
      if (!pending) throw new Error('selection-replan race did not start');
      return Promise.race([
        pending,
        new Promise((resolveRace) => setTimeout(() => resolveRace({ status: 'timeout' }), 180_000)),
      ]);
    });
    assert.notEqual(result.status, 'timeout', 'selection replan did not finish after cancellation');
    const closed = await page.evaluate(async (connectionToken) =>
      (window as any).partmodeAgent.requestTool(
        connectionToken, 'cad_ui', { action: 'snapshot' }, 'as016-race-closed',
      ), token);
    assert.equal(closed.activeCommand == null, true,
      'cancelled target-selection replan resurrected a Smart Fastener draft');
    assert.equal(closed.preview == null, true,
      'cancelled target-selection replan resurrected a preview');
    assert.deepEqual(await projectState(page), before,
      'cancelled target-selection replan mutated document bytes, hash, revision, or history');
  } finally {
    await disconnectCommandAgent(page, token);
  }
}

async function assertSmartFastenerEvidence(
  page: Page,
  group: JsonRecord,
  expectedName: string,
): Promise<JsonRecord> {
  await waitForSettlement(page);
  const snapshot = await page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    return {
      exact: await studio.exactBodyResultsForTest(),
      trace: studio.evaluationTrace(),
      errors: studio.errors(),
      canonicalHash: studio.canonicalHash(),
      documentRevision: studio.documentRevision(),
      appliedRevision: studio.appliedRevision(),
    };
  });
  assert.equal(snapshot.documentRevision, snapshot.appliedRevision, 'Smart Fastener document is not settled');
  assert.deepEqual(snapshot.errors, [], 'visible Smart Fastener worker reported errors');
  assert.deepEqual(snapshot.exact.errors, [], 'isolated production worker reported Smart Fastener errors');
  assert.equal(snapshot.exact.revision, snapshot.documentRevision, 'isolated Smart Fastener exact proof is stale');
  assert.equal(snapshot.exact.effectiveDocumentHash, snapshot.canonicalHash,
    'isolated Smart Fastener exact proof is not current-document-hash-bound');
  assert.equal(snapshot.trace?.effectiveDocumentHash, snapshot.canonicalHash,
    'visible Smart Fastener evidence is not current-document-hash-bound');
  const evidence = snapshot.trace?.smartFasteners;
  assert.equal(evidence?.schema, 'partmode.smart-fastener-evidence/v1',
    'visible worker omitted typed Smart Fastener evidence');
  assert.equal(evidence.documentHash, snapshot.canonicalHash,
    'Smart Fastener evidence has the wrong document hash');
  assert.equal(evidence.groups?.length, 1, 'worker did not prove exactly one Smart Fastener group');
  const proved = evidence.groups[0];
  assert.equal(proved.groupId, group.id, 'worker evidence lost Smart Fastener group identity');
  assert.equal(proved.target?.occurrenceId, TARGET_OCCURRENCE_ID,
    'worker evidence lost target occurrence identity');
  assert.equal(proved.target?.designation, 'M6', 'worker evidence lost recognized M6 designation');
  assert.ok(closeTo(proved.target?.exactGrip, 8), 'worker evidence lost exact 8 mm grip');
  assert.equal(proved.catalog?.selections?.screw?.designation, 'M6x20',
    'worker evidence did not prove shortest M6x20 catalog screw');
  assert.equal(proved.catalog?.selections?.washer?.designation, '6',
    'worker evidence did not prove the canonical washer');
  assert.equal(proved.catalog?.selections?.nut?.designation, 'M6',
    'worker evidence did not prove the canonical nut');
  assert.equal(Object.keys(proved.exactBodies || {}).length, 4,
    'worker evidence did not prove target plus three exact bodies');
  for (const [role, body] of Object.entries(proved.exactBodies || {}) as Array<[string, JsonRecord]>) {
    const occurrenceId = role === 'target' ? TARGET_OCCURRENCE_ID : group.occurrenceIds[role];
    const exact = snapshot.exact.bodies.find((entry: JsonRecord) =>
      entry.bodyId === `${occurrenceId}:${body.bodyId}`);
    assert.ok(exact, `isolated worker omitted ${role} exact body`);
    assert.equal(exact.error, null, `${role} exact body has an error`);
    assert.equal(exact.lastValid, false, `${role} exact body used last-valid fallback`);
    assert.equal(exact.geometry?.valid, true, `${role} exact body is invalid`);
    assert.equal(exact.geometry?.brepValid, true, `${role} exact body failed BRepCheck`);
    assert.equal(exact.geometry?.solidCount, 1, `${role} exact body is not one solid`);
    assert.ok(typeof exact.exactBrep === 'string' && exact.exactBrep.length > 100,
      `${role} exact body has no canonical BREP`);
    assert.ok(typeof body.exactBrep === 'string' && body.exactBrep.length > 100,
      `${role} visible-worker evidence has no canonical BREP`);
    assert.deepEqual(exact.geometry?.bounds, body.geometry?.bounds,
      `${role} isolated and visible-worker exact bounds disagree`);
    assert.ok(closeTo(exact.geometry?.volume, body.geometry?.volume),
      `${role} isolated and visible-worker exact volumes disagree`);
    assert.match(body.brepSha256, /^[0-9a-f]{64}$/u, `${role} evidence has no BREP SHA-256`);
  }
  assert.equal(proved.mateFrames?.length, 6, 'worker evidence omitted six exact mate frames');
  assert.ok(proved.mateFrames.every((entry: JsonRecord) =>
    entry.residual?.satisfied === true && Math.abs(entry.residual.maxScaledResidual) <= 1e-6),
  'worker evidence contains an unsatisfied Smart Fastener mate');
  assert.deepEqual(proved.solver?.degreesOfFreedom, { screw: 1, washer: 1, nut: 1 },
    'worker evidence did not prove one rotational DOF per generated occurrence');
  assert.equal(proved.solver?.usedLastValid, false, 'worker evidence used last-valid assembly placement');
  assert.equal(proved.interference?.pairs?.length, 6, 'worker evidence omitted body-pair interference checks');
  assert.ok(closeTo(proved.interference?.maxPositiveVolumeMm3, 0, 1e-9),
    'worker evidence found positive-volume interference');
  const row = `[data-smart-fastener-id="${group.id}"]`;
  await page.waitForSelector(row, { visible: true, timeout: 30_000 });
  assert.equal(await page.$(`${row} img`), null, 'HTML-like Smart Fastener name created an image element');
  assert.equal(await page.$eval(`${row} [data-smart-fastener-action="edit"] span`, (element) => element.textContent),
    expectedName, 'visible tree did not preserve the literal Smart Fastener name');
  return snapshot;
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
    (window as any).__as016Injected = false;
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
  assert.equal(response?.status(), 200, 'Smart Fastener UI route did not return HTTP 200');
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);

  const registry = await page.evaluate(async () => {
    const script = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
    if (!script) throw new Error('cannot locate built Studio module');
    const module = await import(new URL('studio-v6-ui-registry.js', script.src).href);
    return module.cadUiCommandDefinition('assembly.smart-fastener');
  });
  assert.equal(registry?.adapter, 'available', 'Smart Fastener registry control is not available');
  assert.deepEqual(registry?.operationKinds,
    ['smartFastener.apply', 'smartFastener.update', 'smartFastener.delete'],
  'Smart Fastener registry operation family changed');
  assert.deepEqual(registry?.fields?.map((field: JsonRecord) => field.id), ['targetOccurrence', 'name', 'plan'],
    'Smart Fastener registry field contract changed');

  const beforeSeed = await projectState(page);
  await page.evaluate(async (fixture) => {
    const studio = (window as any).__bwStudio;
    const script = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
    if (!script) throw new Error('cannot locate built Studio module');
    const holeWizard = await import(new URL('studio-hole-wizard.js', script.src).href);
    const hole = holeWizard.createStudioHoleWizardFeature({
      id: fixture.holeId,
      bodyId: fixture.bodyId,
      kind: 'clearance',
      designation: 'M6',
      center: [6, -4],
      sketchZ: 8,
    });
    await studio.commitHumanOperationsForTest('Seed AS016 exact Smart Fastener assembly', [
      { kind: 'project.clear', input: {} },
      {
        kind: 'feature.extrude',
        input: {
          id: fixture.featureId,
          name: 'Exact Smart Fastener plate',
          sketch: { shapes: [{ id: 'shape-ui-smart-fastener-plate', kind: 'rect', x: 0, y: 0, w: 40, h: 40 }], z: 0 },
          height: 8,
          resultPolicy: { kind: 'new-body', bodyName: 'Smart Fastener target plate' },
        },
      },
      { kind: 'feature.cut', input: holeWizard.studioHoleWizardOperationInput(hole) },
      {
        kind: 'assembly.create',
        input: {
          id: 'assembly-ui-smart-fastener',
          occurrenceId: fixture.occurrenceId,
          name: 'AS016 Smart Fastener assembly',
          occurrenceName: 'Plate:1',
          fixed: true,
        },
      },
    ]);
  }, {
    featureId: TARGET_FEATURE_ID,
    holeId: TARGET_HOLE_ID,
    bodyId: TARGET_BODY_ID,
    occurrenceId: TARGET_OCCURRENCE_ID,
  });
  await assertCurrentSettlement(page, beforeSeed, 'Smart Fastener fixture seed');
  let document = await readDocument(page);
  let assembly = rootAssembly(document);
  assert.equal(assembly.occurrences.length, 1, 'fixture does not contain exactly one target occurrence');
  assert.equal(assembly.mates.length, 0, 'fixture unexpectedly contains mates');
  assert.equal(assembly.occurrences[0].id, TARGET_OCCURRENCE_ID, 'fixture target occurrence ID changed');
  assert.equal(assembly.occurrences[0].fixed, true, 'fixture target occurrence is not fixed');

  await clickVisible(page, '[data-workspace="assembly"]');
  await assertHitTestable(page, '#bw-smart-fastener-open');
  await assertSelectionReplanCancelRace(page);
  await assertPreviewCancelNoMutation(page);

  const beforeCreate = await projectState(page);
  await assertAgentDisconnected(page, 'human Smart Fastener create');
  await clickVisible(page, '#bw-smart-fastener-open');
  await waitForDialog(page, true);
  const summary = await page.$eval('[data-smart-fastener-plan-summary]', (element) => element.textContent || '');
  assert.match(summary, /M6 through clearance/u, 'visible Smart Fastener dialog omitted recognized M6 hole');
  assert.match(summary, /8 mm exact grip/u, 'visible Smart Fastener dialog omitted exact 8 mm grip');
  assert.match(summary, /M6x20/u, 'visible Smart Fastener dialog omitted selected M6x20 screw');
  assert.match(summary, /3 catalog occurrences/u, 'visible Smart Fastener dialog omitted occurrence result');
  assert.match(summary, /6 named analytic mates/u, 'visible Smart Fastener dialog omitted mate result');
  await previewOpenSmartFastenerAsHuman(page, HTML_LIKE_NAME, 'created');
  assert.deepEqual(await projectState(page), beforeCreate,
    'human exact create preview mutated the authoritative document before Apply');
  await clickVisible(page, '#bw-v5-command-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeCreate, 'visible Smart Fastener create');
  await assertAgentDisconnected(page, 'human Smart Fastener create completion');

  document = await readDocument(page);
  assembly = rootAssembly(document);
  let group = smartGroup(document);
  assert.equal(assembly.occurrences.length, 4, 'Smart Fastener create did not persist target plus three occurrences');
  assert.equal(assembly.mates.length, 6, 'Smart Fastener create did not persist six mates');
  assert.equal(Object.keys(group.occurrenceIds).length, 3, 'Smart Fastener group omitted owned occurrence IDs');
  assert.equal(Object.keys(group.mateIds).length, 6, 'Smart Fastener group omitted owned mate IDs');
  assert.ok(Object.values(group.occurrenceIds).every((id) =>
    assembly.occurrences.some((entry: JsonRecord) => entry.id === id
      && entry.extensions?.smartFastenerOwnership?.groupId === group.id)),
  'Smart Fastener group does not own three real occurrences');
  assert.ok(Object.values(group.mateIds).every((id) =>
    assembly.mates.some((entry: JsonRecord) => entry.id === id
      && entry.extensions?.smartFastenerOwnership?.groupId === group.id)),
  'Smart Fastener group does not own six real mates');
  await assertSmartFastenerEvidence(page, group, HTML_LIKE_NAME);
  assert.equal(await page.evaluate(() => (window as any).__as016Injected), false,
    'HTML-like Smart Fastener name executed script');

  await clickVisible(page,
    `[data-occurrence-id="${TARGET_OCCURRENCE_ID}"] [data-occurrence-action="select"]`);
  const beforeOccupiedTargetOpen = await projectState(page);
  await assertAgentDisconnected(page, 'occupied-target create refusal');
  await clickVisible(page, '#bw-smart-fastener-open');
  await page.waitForFunction(() => /not an eligible unfastened Smart Fastener target/u.test(
    document.getElementById('bw-studio-msg')?.textContent || '',
  ), { polling: 50, timeout: 30_000 });
  assert.equal(await page.$eval('#bw-v5-command', (element) => (element as HTMLDialogElement).open), false,
    'explicit occupied target selection opened a second Smart Fastener command');
  assert.deepEqual(await projectState(page), beforeOccupiedTargetOpen,
    'explicit occupied target selection mutated document bytes, hash, revision, or history');
  document = await readDocument(page);
  assembly = rootAssembly(document);
  assert.equal(assembly.extensions?.smartFasteners?.groups?.length, 1,
    'explicit occupied target selection created a second Smart Fastener group');
  assert.equal(assembly.occurrences.length, 4,
    'explicit occupied target selection added another hardware stack');
  assert.equal(assembly.mates.length, 6,
    'explicit occupied target selection added another mate stack');

  await page.evaluate(async () => (window as any).__bwStudio.flushStorage());
  const savedState = await projectState(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  const reopenedState = await projectState(page);
  assert.equal(reopenedState.docJson, savedState.docJson,
    'save/reload changed canonical Smart Fastener document bytes');
  assert.equal(reopenedState.canonicalHash, savedState.canonicalHash,
    'save/reload changed the Smart Fastener document hash');
  document = await readDocument(page);
  group = smartGroup(document);
  await assertSmartFastenerEvidence(page, group, HTML_LIKE_NAME);
  assert.equal(await page.evaluate(() => (window as any).__as016Injected), false,
    'persisted HTML-like Smart Fastener name executed after reload');

  await clickVisible(page, '[data-workspace="assembly"]');
  const beforeEdit = await projectState(page);
  const updatedName = 'Updated exact M6 Smart Fastener';
  await assertAgentDisconnected(page, 'human Smart Fastener edit');
  await clickVisible(page, `[data-smart-fastener-id="${group.id}"] [data-smart-fastener-action="edit"]`);
  await waitForDialog(page, true);
  await previewOpenSmartFastenerAsHuman(page, updatedName, 'updated');
  assert.deepEqual(await projectState(page), beforeEdit,
    'human exact edit preview mutated the authoritative document before Apply');
  await clickVisible(page, '#bw-v5-command-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeEdit, 'visible Smart Fastener edit');
  await assertAgentDisconnected(page, 'human Smart Fastener edit completion');
  document = await readDocument(page);
  const editedGroup = smartGroup(document);
  assert.equal(editedGroup.id, group.id, 'Smart Fastener edit replaced group identity');
  assert.deepEqual(editedGroup.occurrenceIds, group.occurrenceIds,
    'Smart Fastener edit replaced owned occurrence identity');
  assert.deepEqual(editedGroup.mateIds, group.mateIds,
    'Smart Fastener edit replaced owned mate identity');
  assert.equal(editedGroup.name, updatedName, 'Smart Fastener edit did not persist the new name');
  await assertSmartFastenerEvidence(page, editedGroup, updatedName);

  const ownedOccurrenceIds = Object.values(editedGroup.occurrenceIds) as string[];
  const ownedMateIds = Object.values(editedGroup.mateIds) as string[];
  const beforeDelete = await projectState(page);
  await clickVisible(page,
    `[data-smart-fastener-id="${editedGroup.id}"] [data-smart-fastener-action="delete"]`);
  await assertCurrentSettlement(page, beforeDelete, 'visible Smart Fastener delete');
  document = await readDocument(page);
  assembly = rootAssembly(document);
  assert.equal(assembly.extensions?.smartFasteners, undefined,
    'visible delete left Smart Fastener group storage');
  assert.ok(ownedOccurrenceIds.every((id) => !assembly.occurrences.some((entry: JsonRecord) => entry.id === id)),
    'visible delete left owned occurrences');
  assert.ok(ownedMateIds.every((id) => !assembly.mates.some((entry: JsonRecord) => entry.id === id)),
    'visible delete left owned mates');
  assert.equal(assembly.occurrences.length, 1, 'visible delete removed or duplicated the target occurrence');
  assert.equal(assembly.mates.length, 0, 'visible delete left generated mates');
  assert.equal(await page.$(`[data-smart-fastener-id="${editedGroup.id}"]`), null,
    'visible delete left the Smart Fastener tree row');
  const final = await page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    return {
      exact: await studio.exactBodyResultsForTest(),
      trace: studio.evaluationTrace(),
      errors: studio.errors(),
      canonicalHash: studio.canonicalHash(),
      documentRevision: studio.documentRevision(),
    };
  });
  assert.deepEqual(final.errors, [], 'post-delete visible worker reported errors');
  assert.deepEqual(final.exact.errors, [], 'post-delete isolated worker reported errors');
  assert.equal(final.exact.revision, final.documentRevision, 'post-delete exact proof is stale');
  assert.equal(final.exact.effectiveDocumentHash, final.canonicalHash,
    'post-delete exact proof is not current-document-hash-bound');
  assert.equal(final.exact.bodies.length, 1, 'post-delete exact worker retained generated hardware bodies');
  assert.equal(final.trace?.smartFasteners, undefined,
    'post-delete worker retained Smart Fastener success evidence');
  assert.deepEqual(failures, [], `Smart Fastener browser gate reported errors: ${failures.join(' | ')}`);

  console.log(JSON.stringify({
    schema: 'partmode.smart-fasteners-ui-smoke/v1',
    browserBacked: true,
    chrome: await browser.version(),
    registeredControl: 'assembly.smart-fastener',
    runtimeSelectedFixture: {
      targetOccurrenceId: TARGET_OCCURRENCE_ID,
      hole: 'M6 through clearance',
      exactGripMm: 8,
      selectedScrew: 'M6x20',
    },
    visibleLifecycle: [
      'selection-replan-cancel-race',
      'preview-cancel-no-mutation',
      'human-create-without-agent',
      'explicit-occupied-target-refusal',
      'save-reload',
      'human-edit-without-agent',
      'human-delete',
    ],
    persistedAssembly: { ownedOccurrences: 3, ownedMates: 6 },
    exactEvidence: {
      currentDocumentHashBound: true,
      targetPlusHardwareBodies: 4,
      mateFrames: 6,
      rotationalDegreesOfFreedom: { screw: 1, washer: 1, nut: 1 },
      zeroPositiveVolumeInterference: true,
      noLastValidFallback: true,
    },
    htmlLikeNameEscaped: true,
    consoleNetworkResponsePageErrors: 0,
  }, null, 2));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
