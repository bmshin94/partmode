import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import puppeteer, { type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-assembly-features-ui-'));
const PART_FEATURE_ID = 'feature-ui-assembly-feature-plate';
const OCCURRENCE_A = 'occurrence-ui-assembly-feature-a';
const OCCURRENCE_B = 'occurrence-ui-assembly-feature-b';
const OCCURRENCE_C = 'occurrence-ui-assembly-feature-unselected';
const HTML_LIKE_CUT_NAME = '<img src=x onerror="window.__as015Injected=true"> Exact assembly cut';

function closeTo(actual: unknown, expected: number, tolerance = 3e-5): boolean {
  const value = Number(actual);
  return Number.isFinite(value) && Math.abs(value - expected) <= tolerance;
}

function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function rootAssembly(document: JsonRecord): JsonRecord {
  const assembly = document.assemblyDefinitions?.find(
    (entry: JsonRecord) => entry.id === document.rootDocument?.assemblyId,
  );
  assert.ok(assembly, 'browser document has no active root assembly');
  return assembly;
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
    const state = await control.evaluate((element, location) => {
      if (!(element instanceof HTMLElement)) return { visible: false, owns: false };
      const style = getComputedStyle(element);
      const target = document.elementFromPoint(location.x, location.y);
      return {
        visible: !element.hidden && style.display !== 'none' && style.visibility !== 'hidden',
        owns: Boolean(target && (target === element || element.contains(target))),
      };
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
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

async function replaceVisibleText(page: Page, selector: string, value: string): Promise<void> {
  await assertHitTestable(page, selector);
  await clickVisible(page, selector);
  await page.$eval(selector, (element) => (element as HTMLInputElement).select());
  await page.keyboard.press('Backspace');
  await page.keyboard.type(value);
  assert.equal(await page.$eval(selector, (element) => (element as HTMLInputElement).value), value,
    `physical typing did not reach ${selector}`);
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
      detachedPreview: studio.detachedPreviewForTest(),
    };
  });
  assert.equal(evidence.documentRevision, evidence.appliedRevision, `${label} is not visibly settled`);
  assert.equal(evidence.settlement?.status, 'settled', `${label} did not cross the settlement barrier`);
  assert.equal(evidence.settlement?.target?.documentHash, evidence.canonicalHash,
    `${label} settlement is not bound to the current document hash`);
  assert.equal(evidence.settlement?.kernel?.documentHash, evidence.canonicalHash,
    `${label} worker receipt is not current-document-hash-bound`);
  assert.equal(evidence.settlement?.persistence?.documentHash, evidence.canonicalHash,
    `${label} persistence receipt is not current-document-hash-bound`);
  assert.equal(evidence.settlement?.renderer?.documentHash, evidence.canonicalHash,
    `${label} renderer receipt is not current-document-hash-bound`);
  assert.deepEqual(evidence.errors, [], `${label} produced visible worker errors`);
  assert.equal(evidence.detachedPreview.activePreviewVisible, false, `${label} retained an active detached preview`);
  assert.equal(evidence.detachedPreview.renderedBodyCount, 0, `${label} retained detached viewport bodies`);
  assert.equal(evidence.detachedPreview.committedObjectsRestored, true, `${label} did not restore committed geometry`);
  assert.ok(evidence.documentRevision > previous.documentRevision, `${label} did not advance revision`);
  assert.notEqual(evidence.canonicalHash, previous.canonicalHash, `${label} did not change document hash`);
  return evidence;
}

async function setTargetBodySelection(page: Page, occurrenceIds: string[]): Promise<string[]> {
  const bodyIds = await page.evaluate((ids) => {
    const results = (window as any).__bwStudio.bodyResults();
    return ids.map((occurrenceId: string) => {
      const matches = results.filter((entry: JsonRecord) =>
        entry.occurrenceInstance?.occurrencePath?.length === 1
        && entry.occurrenceInstance.occurrenceId === occurrenceId
        && !entry.patternInstance);
      if (matches.length !== 1) throw new Error(`Occurrence ${occurrenceId} resolved ${matches.length} runtime bodies`);
      return matches[0].bodyId;
    });
  }, occurrenceIds);
  const token = await page.evaluate(async () => {
    const connection = await (window as any).__bwStudio.connectAgentForTest({
      clientLabel: 'AS015 target selection only',
      mode: 'scoped-auto-commit',
      permissionContext: {
        granted: ['project.read', 'ui.read', 'ui.select', 'ui.command-draft', 'ui.present-preview'],
        operationKinds: ['assemblyFeature.create', 'assemblyFeature.update', 'assemblyFeature.delete'],
        maxCommits: 0,
      },
    });
    return connection.connectionToken;
  });
  try {
    await page.evaluate(async (input) => {
      const bridge = (window as any).partmodeAgent;
      const opened = await bridge.requestTool(input.token, 'cad_ui', { action: 'snapshot' }, 'as015-selection-snapshot');
      await bridge.requestTool(input.token, 'cad_ui', {
        action: 'apply',
        expectedUiRevision: opened.uiRevision,
        actions: input.bodyIds.map((bodyId: string, index: number) => ({
          kind: index === 0 ? 'selection.set' : 'selection.add',
          entity: { kind: 'body', id: bodyId },
        })),
        presentation: { mode: 'instant', transition: 'cut' },
      }, 'as015-selection-apply');
    }, { token, bodyIds });
  } finally {
    await page.evaluate((connectionToken) => (window as any).partmodeAgent.disconnect(connectionToken), token);
  }
  const status = await page.evaluate(() => (window as any).partmodeAgent.status());
  assert.equal(status?.connected, false, 'assembly feature human path retained an agent session');
  return bodyIds;
}

async function bindOpenFeatureTargets(page: Page, bodyIds: string[]): Promise<void> {
  const result = await page.evaluate(async (ids) => {
    const connection = await (window as any).__bwStudio.connectAgentForTest({
      clientLabel: 'AS015 open target rebind only',
      mode: 'scoped-auto-commit',
      permissionContext: {
        granted: ['project.read', 'ui.read', 'ui.command-draft'],
        operationKinds: ['assemblyFeature.create', 'assemblyFeature.update', 'assemblyFeature.delete'],
        maxCommits: 0,
      },
    });
    const token = connection.connectionToken;
    try {
      const bridge = (window as any).partmodeAgent;
      const opened = await bridge.requestTool(token, 'cad_ui', { action: 'snapshot' }, 'as015-rebind-opened');
      await bridge.requestTool(token, 'cad_ui', {
        action: 'apply',
        expectedUiRevision: opened.uiRevision,
        actions: [{
          kind: 'command.bindSelection',
          fieldId: 'targetBodies',
          entities: ids.map((id: string) => ({ kind: 'body', id })),
        }],
        presentation: { mode: 'instant', transition: 'cut' },
      }, 'as015-rebind-apply');
      const configured = await bridge.requestTool(token, 'cad_ui', { action: 'snapshot' }, 'as015-rebind-configured');
      return {
        commandId: configured.activeCommand?.commandId,
        boundBodyIds: configured.activeCommand?.boundSelections?.targetBodies?.map((entry: JsonRecord) => entry.id),
        targetBodyIds: configured.activeCommand?.assemblyFeatureTargetBodyIds,
        targetCount: configured.activeCommand?.assemblyFeatureTargets?.length,
        visibleCount: document.querySelector('[data-assembly-feature-target-count]')?.textContent || '',
        visibleRows: document.querySelectorAll('[data-assembly-feature-target-summary] li').length,
      };
    } finally {
      (window as any).partmodeAgent.disconnect(token);
    }
  }, bodyIds);
  assert.equal(result.commandId, 'assembly.feature', 'target rebind did not retain the visible AS015 command');
  assert.deepEqual(result.boundBodyIds, bodyIds, 'target rebind changed opaque runtime body IDs');
  assert.deepEqual(result.targetBodyIds, bodyIds, 'target metadata lost its runtime-body identity binding');
  assert.equal(result.targetCount, bodyIds.length, 'target rebind did not refresh canonical targets');
  assert.equal(result.visibleCount, String(bodyIds.length), 'target rebind left the visible count stale');
  assert.equal(result.visibleRows, bodyIds.length, 'target rebind left the visible target list stale');
  assert.equal((await page.evaluate(() => (window as any).partmodeAgent.status()))?.connected, false,
    'target rebind retained an agent connection');
}

async function readUiSnapshot(page: Page): Promise<JsonRecord> {
  return page.evaluate(async () => {
    const connection = await (window as any).__bwStudio.connectAgentForTest({
      clientLabel: 'AS015 snapshot only',
      mode: 'scoped-auto-commit',
      permissionContext: {
        granted: ['project.read', 'ui.read'],
        operationKinds: ['assemblyFeature.create', 'assemblyFeature.update', 'assemblyFeature.delete'],
        maxCommits: 0,
      },
    });
    try {
      return await (window as any).partmodeAgent.requestTool(
        connection.connectionToken,
        'cad_ui',
        { action: 'snapshot' },
        'as015-read-snapshot',
      );
    } finally {
      (window as any).partmodeAgent.disconnect(connection.connectionToken);
    }
  });
}

async function chooseFamily(page: Page, kind: 'cut' | 'hole'): Promise<void> {
  const selector = '#bw-v5-command-form [name="kind"]';
  await assertHitTestable(page, selector);
  const current = await page.$eval(selector, (element) => (element as HTMLSelectElement).value);
  if (current === kind) return;
  const selected = await page.select(selector, kind);
  assert.deepEqual(selected, [kind], `assembly feature family ${kind} was not selectable`);
  await page.waitForFunction((expected) =>
    (document.querySelector('#bw-v5-command-form [name="kind"]') as HTMLSelectElement | null)?.value === expected,
  { polling: 50, timeout: 10_000 }, kind);
}

async function configureOpenFeature(
  page: Page,
  options: {
    kind: 'cut' | 'hole';
    name: string;
    origin: string;
    width?: string;
    height?: string;
    diameter?: string;
  },
): Promise<void> {
  await chooseFamily(page, options.kind);
  await replaceVisibleText(page, '#bw-v5-command-form [name="name"]', options.name);
  await replaceVisibleText(page, '#bw-v5-command-form [name="originCsv"]', options.origin);
  await replaceVisibleText(page, '#bw-v5-command-form [name="directionCsv"]', '0, 0, 1');
  await replaceVisibleText(page, '#bw-v5-command-form [name="xDirectionCsv"]', '1, 0, 0');
  if (options.kind === 'cut') {
    await replaceVisibleText(page, '#bw-v5-command-form [name="width"]', options.width || '10');
    await replaceVisibleText(page, '#bw-v5-command-form [name="height"]', options.height || '6');
  } else {
    await replaceVisibleText(page, '#bw-v5-command-form [name="diameter"]', options.diameter || '4');
  }
}

async function exactPreview(page: Page, expectedChange: 'created' | 'updated'): Promise<JsonRecord> {
  const before = await projectState(page);
  const initial = await page.evaluate(() => ({
    previewDisabled: (document.getElementById('bw-v5-command-preview') as HTMLButtonElement | null)?.disabled,
    applyDisabled: (document.getElementById('bw-v5-command-apply') as HTMLButtonElement | null)?.disabled,
    applyText: document.getElementById('bw-v5-command-apply')?.textContent || '',
  }));
  assert.equal(initial.previewDisabled, false, 'Assembly Cut / Hole Preview is disabled');
  assert.equal(initial.applyDisabled, true, 'Assembly Cut / Hole Apply enabled before exact preview');
  assert.match(initial.applyText, /Preview required/u, 'Apply does not advertise its exact-preview requirement');
  await clickVisible(page, '#bw-v5-command-preview');
  await page.waitForFunction(() => {
    const surface = document.getElementById('bw-v6-command-preview');
    const title = document.getElementById('bw-v6-command-preview-title');
    const apply = document.getElementById('bw-v5-command-apply') as HTMLButtonElement | null;
    const error = document.getElementById('bw-v5-command-error')?.textContent || '';
    return error.length > 0 || (surface?.hidden === false
      && /Exact validation passed/u.test(title?.textContent || '')
      && apply?.disabled === false);
  }, { polling: 50, timeout: 180_000 });
  const error = await page.$eval('#bw-v5-command-error', (element) => element.textContent || '');
  assert.equal(error, '', `Assembly Cut / Hole exact preview failed: ${error}`);
  assert.deepEqual(await projectState(page), before,
    'Assembly Cut / Hole preview mutated document bytes, hash, revision, or history before Apply');
  const visible = await page.evaluate(() => ({
    title: document.getElementById('bw-v6-command-preview-title')?.textContent || '',
    summary: document.getElementById('bw-v6-command-preview-summary')?.textContent || '',
    evidence: document.getElementById('bw-v6-command-preview-evidence')?.textContent || '',
    applyText: document.getElementById('bw-v5-command-apply')?.textContent || '',
    detached: (window as any).__bwStudio.detachedPreviewForTest(),
  }));
  assert.match(visible.title, /Exact validation passed/u, 'preview surface did not report exact validation');
  assert.match(visible.summary, new RegExp(expectedChange, 'u'), 'preview surface omitted its change count');
  assert.match(visible.evidence, /exact geometry valid/u, 'preview surface omitted exact-kernel evidence');
  assert.match(visible.applyText, /Apply exact preview/u, 'preview did not enable exact Apply');
  assert.equal(visible.detached.activePreviewVisible, true, 'exact preview is not active in the viewport');
  assert.equal(visible.detached.detachedExactGeometry, true, 'preview did not render detached exact geometry');
  assert.equal(visible.detached.renderedBodyCount, 3,
    'detached preview did not render every linked occurrence, including shared-source siblings');
  assert.ok(visible.detached.committedObjectCount > 0, 'detached preview did not capture committed viewport objects');
  assert.equal(visible.detached.committedObjectsHidden, true, 'committed geometry remained visible under detached preview');
  assert.equal(visible.detached.committedObjectsRestored, false, 'detached preview reported committed geometry restored too early');
  const status = await page.evaluate(() => (window as any).partmodeAgent.status());
  assert.equal(status?.connected, false, 'exact human preview depended on a connected agent');
  return before;
}

function exactFeatureEvidence(trace: JsonRecord, expectedCount: number): JsonRecord {
  const evidence = trace?.assemblyFeatures;
  assert.equal(evidence?.schema, 'partmode.assembly-feature-evidence/v1', 'visible worker omitted AS015 evidence');
  assert.equal(evidence?.features?.length, expectedCount, 'visible worker evidence has the wrong feature count');
  assert.equal(evidence?.atomic, true, 'visible worker evidence lost its all-target atomic contract');
  assert.ok(evidence.resultBodies.every((entry: JsonRecord) =>
    /^[0-9a-f]{64}$/u.test(entry.resultBrepSha256)
      && entry.topology.counts.faces === entry.topology.counts.namedFaces
      && entry.topology.counts.edges === entry.topology.counts.namedEdges
      && entry.topology.counts.vertices === entry.topology.counts.namedVertices),
  'visible worker evidence lacks current B-rep or complete topology proof');
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
    (window as any).__as015Injected = false;
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
  assert.equal(response?.status(), 200, 'AS015 UI route did not return HTTP 200');
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);

  const registry = await page.evaluate(async () => {
    const script = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
    if (!script) throw new Error('cannot locate built Studio module');
    const module = await import(new URL('studio-v6-ui-registry.js', script.src).href);
    return module.cadUiCommandDefinition('assembly.feature');
  });
  assert.equal(registry?.adapter, 'available', 'Assembly Cut / Hole registry command is unavailable');
  assert.deepEqual(registry?.operationKinds,
    ['assemblyFeature.create', 'assemblyFeature.update', 'assemblyFeature.delete'],
  'Assembly Cut / Hole registry operation family changed');
  assert.deepEqual(registry?.fields?.map((entry: JsonRecord) => entry.id),
    ['targetBodies', 'name', 'kind', 'origin', 'direction', 'xDirection', 'width', 'height', 'diameter', 'suppressed'],
  'Assembly Cut / Hole registry fields are incomplete');

  const beforeSeed = await projectState(page);
  await page.evaluate(async (fixture) => {
    const studio = (window as any).__bwStudio;
    await studio.commitHumanOperationsForTest('Seed AS015 source plate', [
      { kind: 'project.clear', input: {} },
      {
        kind: 'feature.extrude',
        input: {
          id: fixture.featureId,
          name: 'AS015 exact source plate',
          sketch: { shapes: [{ id: 'shape-ui-assembly-feature-plate', kind: 'rect', x: 0, y: 0, w: 40, h: 40 }], z: 0 },
          height: 8,
          resultPolicy: { kind: 'new-body', bodyName: 'Assembly feature plate' },
        },
      },
    ]);
    const current = JSON.parse(studio.docJson());
    const partId = current.rootDocument.partId;
    await studio.commitHumanOperationsForTest('Seed AS015 linked assembly', [
      {
        kind: 'assembly.create',
        input: {
          id: 'assembly-ui-assembly-features',
          occurrenceId: fixture.occurrenceA,
          name: 'AS015 exact linked assembly',
          occurrenceName: 'Plate A',
          fixed: true,
        },
      },
      {
        kind: 'component.insert',
        input: {
          id: fixture.occurrenceB,
          name: 'Plate B stacked',
          definition: { kind: 'part', partId },
          baseTransform: fixture.transformB,
          fixed: true,
        },
      },
      {
        kind: 'component.insert',
        input: {
          id: fixture.occurrenceC,
          name: 'Plate C untouched linked sibling',
          definition: { kind: 'part', partId },
          baseTransform: fixture.transformC,
          fixed: true,
        },
      },
    ]);
  }, {
    featureId: PART_FEATURE_ID,
    occurrenceA: OCCURRENCE_A,
    occurrenceB: OCCURRENCE_B,
    occurrenceC: OCCURRENCE_C,
    transformB: translation(0, 0, 20),
    transformC: translation(60, 0, 0),
  });
  await assertCurrentSettlement(page, beforeSeed, 'AS015 fixture seed');
  let document = await readDocument(page);
  let assembly = rootAssembly(document);
  assert.equal(assembly.occurrences.length, 3, 'AS015 browser fixture does not have three linked occurrences');
  assert.ok(assembly.occurrences.every((entry: JsonRecord) => entry.fixed === true),
    'AS015 browser fixture is not exactly fixed at its authored transforms');
  assert.equal(new Set(assembly.occurrences.map((entry: JsonRecord) => entry.definition.partId)).size, 1,
    'AS015 browser fixture occurrences do not share one source definition');

  await clickVisible(page, '[data-workspace="assembly"]');
  await assertHitTestable(page, '#bw-assembly-feature-open');

  // Disconnected-human preview, stale-input invalidation, and Cancel must not
  // mutate the authoritative document or history.
  const previewTargetBodyIds = await setTargetBodySelection(page, [OCCURRENCE_A, OCCURRENCE_B]);
  const beforeCancel = await projectState(page);
  await clickVisible(page, '#bw-assembly-feature-open');
  await waitForDialog(page, true);
  await bindOpenFeatureTargets(page, [previewTargetBodyIds[0]!]);
  await configureOpenFeature(page, {
    kind: 'cut', name: 'Preview-only cut', origin: '0, 0, 0', width: '10', height: '6',
  });
  await exactPreview(page, 'created');
  await replaceVisibleText(page, '#bw-v5-command-form [name="width"]', '11');
  const invalidated = await page.evaluate(() => ({
    applyDisabled: (document.getElementById('bw-v5-command-apply') as HTMLButtonElement | null)?.disabled,
    applyText: document.getElementById('bw-v5-command-apply')?.textContent || '',
    surfaceHidden: document.getElementById('bw-v6-command-preview')?.hidden,
  }));
  assert.equal(invalidated.applyDisabled, true, 'editing a previewed dimension did not invalidate Apply');
  assert.match(invalidated.applyText, /Preview required/u, 'stale preview did not restore its preview requirement');
  assert.equal(invalidated.surfaceHidden, true, 'stale preview surface remained visible after input change');
  const invalidatedGeometry = await page.evaluate(() => (window as any).__bwStudio.detachedPreviewForTest());
  assert.equal(invalidatedGeometry.activePreviewVisible, false, 'stale preview retained an active viewport candidate');
  assert.equal(invalidatedGeometry.renderedBodyCount, 0, 'stale preview retained detached viewport bodies');
  assert.equal(invalidatedGeometry.committedObjectsRestored, true, 'stale preview did not restore committed geometry');
  await clickVisible(page, '#bw-v5-command-cancel');
  await waitForDialog(page, false);
  assert.deepEqual(await projectState(page), beforeCancel,
    'preview/input-invalidation/Cancel mutated AS015 document bytes, hash, revision, or history');
  assert.equal(rootAssembly(await readDocument(page)).extensions?.assemblyFeatures, undefined,
    'preview-only Cancel stored an assembly feature');

  await setTargetBodySelection(page, [OCCURRENCE_A, OCCURRENCE_B]);
  const beforeCut = await projectState(page);
  await clickVisible(page, '#bw-assembly-feature-open');
  await waitForDialog(page, true);
  await configureOpenFeature(page, {
    kind: 'cut', name: HTML_LIKE_CUT_NAME, origin: '0, 0, 0', width: '10', height: '6',
  });
  await exactPreview(page, 'created');
  assert.deepEqual(await projectState(page), beforeCut, 'cut exact preview mutated the document before Apply');
  await clickVisible(page, '#bw-v5-command-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeCut, 'visible assembly cut create');
  document = await readDocument(page);
  assembly = rootAssembly(document);
  let features = assembly.extensions?.assemblyFeatures?.features;
  assert.equal(features?.length, 1, 'visible cut create did not persist one feature');
  const cutId = features[0].id;
  assert.equal(features[0].kind, 'cut', 'visible cut stored the wrong family');
  assert.equal(features[0].name, HTML_LIKE_CUT_NAME, 'visible cut lost its literal name');
  assert.equal(await page.evaluate(() => (window as any).__as015Injected), false,
    'HTML-like assembly feature name executed script');
  assert.equal(await page.$(`[data-assembly-feature-id="${cutId}"] img`), null,
    'HTML-like assembly feature name created an image element');
  const afterCut = await page.evaluate(() => ({
    bodies: (window as any).__bwStudio.bodyResults(),
    trace: (window as any).__bwStudio.evaluationTrace(),
  }));
  exactFeatureEvidence(afterCut.trace, 1);
  const cutVolumes = new Map(afterCut.bodies.map((entry: JsonRecord) => [entry.occurrenceInstance.occurrenceId, entry.geometry.volume]));
  assert.ok(closeTo(cutVolumes.get(OCCURRENCE_A), 40 * 40 * 8 - 10 * 6 * 8), 'visible cut volume A is wrong');
  assert.ok(closeTo(cutVolumes.get(OCCURRENCE_B), 40 * 40 * 8 - 10 * 6 * 8), 'visible cut volume B is wrong');
  assert.ok(closeTo(cutVolumes.get(OCCURRENCE_C), 40 * 40 * 8), 'visible cut changed linked sibling C');

  await setTargetBodySelection(page, [OCCURRENCE_A, OCCURRENCE_B]);
  const beforeHole = await projectState(page);
  await clickVisible(page, '#bw-assembly-feature-open');
  await waitForDialog(page, true);
  await configureOpenFeature(page, {
    kind: 'hole', name: 'Exact stacked circular hole', origin: '8, 0, 0', diameter: '4',
  });
  await exactPreview(page, 'created');
  await clickVisible(page, '#bw-v5-command-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeHole, 'visible assembly hole create');
  document = await readDocument(page);
  assembly = rootAssembly(document);
  features = assembly.extensions?.assemblyFeatures?.features;
  assert.deepEqual(features.map((entry: JsonRecord) => entry.kind), ['cut', 'hole'],
    'visible authoring did not preserve ordered cut and hole families');
  const holeId = features[1].id;
  const afterHole = await page.evaluate(() => ({
    bodies: (window as any).__bwStudio.bodyResults(),
    trace: (window as any).__bwStudio.evaluationTrace(),
  }));
  const holeEvidence = exactFeatureEvidence(afterHole.trace, 2);
  assert.deepEqual(holeEvidence.features.map((entry: JsonRecord) => entry.kind), ['cut', 'hole'],
    'visible worker changed feature execution order');
  const expectedVolume = 40 * 40 * 8 - 10 * 6 * 8 - Math.PI * 2 * 2 * 8;
  const finalVolumes = new Map(afterHole.bodies.map((entry: JsonRecord) => [entry.occurrenceInstance.occurrenceId, entry.geometry.volume]));
  assert.ok(closeTo(finalVolumes.get(OCCURRENCE_A), expectedVolume), 'visible cut-plus-hole volume A is wrong');
  assert.ok(closeTo(finalVolumes.get(OCCURRENCE_B), expectedVolume), 'visible cut-plus-hole volume B is wrong');
  assert.ok(closeTo(finalVolumes.get(OCCURRENCE_C), 40 * 40 * 8), 'visible cut-plus-hole changed sibling C');

  await page.evaluate(async () => (window as any).__bwStudio.flushStorage());
  const savedState = await projectState(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  const reopenedState = await projectState(page);
  assert.equal(reopenedState.docJson, savedState.docJson, 'save/reload changed AS015 canonical bytes');
  assert.equal(reopenedState.canonicalHash, savedState.canonicalHash, 'save/reload changed AS015 document hash');
  exactFeatureEvidence(await page.evaluate(() => (window as any).__bwStudio.evaluationTrace()), 2);
  assert.equal(await page.evaluate(() => (window as any).__as015Injected), false,
    'persisted HTML-like assembly feature name executed after reload');

  await clickVisible(page, '[data-workspace="assembly"]');
  const beforeEdit = await projectState(page);
  await clickVisible(page, `[data-assembly-feature-id="${holeId}"] [data-assembly-feature-action="edit"]`);
  await waitForDialog(page, true);
  const editFamily = await page.$eval('#bw-v5-command-form [name="kind"]', (element) => ({
    value: (element as HTMLSelectElement).value,
    disabled: (element as HTMLSelectElement).disabled,
  }));
  assert.deepEqual(editFamily, { value: 'hole', disabled: true }, 'edit did not lock the feature family');
  await replaceVisibleText(page, '#bw-v5-command-form [name="name"]', 'Edited exact stacked hole');
  await replaceVisibleText(page, '#bw-v5-command-form [name="diameter"]', '5');
  await exactPreview(page, 'updated');
  assert.deepEqual(await projectState(page), beforeEdit, 'hole edit preview mutated the document before Apply');
  await clickVisible(page, '#bw-v5-command-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeEdit, 'visible assembly hole edit');
  document = await readDocument(page);
  features = rootAssembly(document).extensions.assemblyFeatures.features;
  assert.deepEqual(features.map((entry: JsonRecord) => entry.id), [cutId, holeId],
    'visible edit changed stable IDs or feature order');
  assert.equal(features[1].definition.diameter, 5, 'visible edit did not persist the new diameter');
  const editedVolumes = new Map((await page.evaluate(() => (window as any).__bwStudio.bodyResults()))
    .map((entry: JsonRecord) => [entry.occurrenceInstance.occurrenceId, entry.geometry.volume]));
  const editedExpected = 40 * 40 * 8 - 10 * 6 * 8 - Math.PI * 2.5 * 2.5 * 8;
  assert.ok(closeTo(editedVolumes.get(OCCURRENCE_A), editedExpected), 'visible hole edit did not change exact volume');

  await clickVisible(page, `[data-assembly-feature-id="${holeId}"] [data-assembly-feature-action="select"]`);
  const selectedHoleSnapshot = await readUiSnapshot(page);
  assert.ok(selectedHoleSnapshot.selection?.some((entry: JsonRecord) =>
    entry.kind === 'assembly-feature' && entry.id === holeId),
  'tree selection did not expose the assembly hole semantically');
  const beforeHoleDelete = await projectState(page);
  await clickVisible(page, `[data-assembly-feature-id="${holeId}"] [data-assembly-feature-action="delete"]`);
  await assertCurrentSettlement(page, beforeHoleDelete, 'visible assembly hole delete');
  const deletedHoleSnapshot = await readUiSnapshot(page);
  assert.equal(deletedHoleSnapshot.selection?.some((entry: JsonRecord) =>
    entry.kind === 'assembly-feature' && entry.id === holeId), false,
  'visible delete retained a stale semantic assembly-feature selection');
  document = await readDocument(page);
  assert.deepEqual(rootAssembly(document).extensions.assemblyFeatures.features.map((entry: JsonRecord) => entry.id), [cutId],
    'visible hole delete removed the wrong feature');
  const beforeCutDelete = await projectState(page);
  await clickVisible(page, `[data-assembly-feature-id="${cutId}"] [data-assembly-feature-action="delete"]`);
  await assertCurrentSettlement(page, beforeCutDelete, 'visible assembly cut delete');
  document = await readDocument(page);
  assert.equal(rootAssembly(document).extensions?.assemblyFeatures, undefined,
    'visible final delete left assembly feature storage');
  const final = await page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    return {
      exact: await studio.exactBodyResultsForTest(),
      bodies: studio.bodyResults(),
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
  assert.equal(final.trace?.assemblyFeatures, undefined, 'post-delete worker retained AS015 evidence');
  assert.ok(final.bodies.every((entry: JsonRecord) => closeTo(entry.geometry.volume, 40 * 40 * 8)),
    'post-delete linked occurrences did not restore the source solid');
  assert.equal(await page.$('[data-assembly-feature-id]'), null, 'post-delete tree retained an assembly feature row');
  assert.deepEqual(failures, [], `AS015 browser gate reported errors: ${failures.join(' | ')}`);

  console.log(JSON.stringify({
    schema: 'partmode.assembly-features-ui-smoke/v1',
    browserBacked: true,
    chrome: await browser.version(),
    registeredControl: 'assembly.feature',
    runtimeSelectedTargets: [OCCURRENCE_A, OCCURRENCE_B],
    linkedSiblingUnchanged: OCCURRENCE_C,
    visibleLifecycle: [
      'semantic-target-rebind-count-and-identity',
      'detached-exact-all-linked-occurrence-preview',
      'preview-input-invalidation-cancel-no-mutation',
      'disconnected-human-cut-create',
      'disconnected-human-hole-create',
      'save-reload',
      'disconnected-human-hole-edit',
      'human-hole-delete',
      'deleted-feature-selection-pruned',
      'human-cut-delete',
    ],
    exactEvidence: {
      currentDocumentHashBound: true,
      orderedFeatureFamilies: ['cut', 'hole'],
      targetBodies: 2,
      detachedPreviewBodies: 3,
      completePersistentTopology: true,
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
