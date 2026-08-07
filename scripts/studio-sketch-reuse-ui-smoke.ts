import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import puppeteer, { type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;

function closeTo(actual: unknown, expected: number, tolerance = 1e-7): boolean {
  const value = Number(actual);
  return Number.isFinite(value) && Math.abs(value - expected) <= Math.max(tolerance, Math.abs(expected) * 1e-9);
}

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-sketch-reuse-ui-'));
const SOURCE_SKETCH_ID = 'ui-source-sketch';
const TARGET_SKETCH_ID = 'ui-target-sketch';
const DEFINITION_A_ID = 'ui-block-definition-a';
const DEFINITION_B_ID = 'ui-block-definition-b';
const SOURCE_FEATURE_ID = 'ui-source-extrude';
const SOURCE_BODY_ID = `body-${SOURCE_FEATURE_ID}`;
const TARGET_FEATURE_ID = 'ui-target-extrude';
const TARGET_BODY_ID = `body-${TARGET_FEATURE_ID}`;
const DERIVED_FEATURE_ID = 'ui-derived-extrude';
const DERIVED_BODY_ID = `body-${DERIVED_FEATURE_ID}`;

const requiredOperationByControl = Object.freeze({
  'bw-sketch-reuse-create': 'sketch.constrained.create',
  'bw-sketch-reuse-edit-members': 'sketch.constrained.update',
  'bw-sketch-reuse-delete-sketch': 'sketch.constrained.delete',
  'bw-sketch-reuse-insert': 'sketch.blockInstance.create',
  'bw-sketch-reuse-edit-instance': 'sketch.blockInstance.update',
  'bw-sketch-reuse-delete-instance': 'sketch.blockInstance.delete',
  'bw-sketch-reuse-create-relation': 'sketch.relation.create',
  'bw-sketch-reuse-edit-relation': 'sketch.relation.update',
  'bw-sketch-reuse-delete-relation': 'sketch.relation.delete',
});

function rectangleConstrained(width: number, height: number): JsonRecord {
  return {
    entities: [
      { id: 'source-p1', kind: 'point', at: [0, 0], fixed: true },
      { id: 'source-p2', kind: 'point', at: [width, 0] },
      { id: 'source-p3', kind: 'point', at: [width, height] },
      { id: 'source-p4', kind: 'point', at: [0, height] },
      { id: 'source-bottom', kind: 'line', a: 'source-p1', b: 'source-p2' },
      { id: 'source-right', kind: 'line', a: 'source-p2', b: 'source-p3' },
      { id: 'source-top', kind: 'line', a: 'source-p3', b: 'source-p4' },
      { id: 'source-left', kind: 'line', a: 'source-p4', b: 'source-p1' },
    ],
    constraints: [
      { id: 'source-horizontal-bottom', kind: 'horizontal', line: 'source-bottom' },
      { id: 'source-vertical-right', kind: 'vertical', line: 'source-right' },
      { id: 'source-horizontal-top', kind: 'horizontal', line: 'source-top' },
      { id: 'source-vertical-left', kind: 'vertical', line: 'source-left' },
      { id: 'source-width', kind: 'horizontalDistance', a: 'source-p1', b: 'source-p2', value: width },
      { id: 'source-height', kind: 'verticalDistance', a: 'source-p1', b: 'source-p4', value: height },
    ],
    blockInstances: [],
    relations: [],
  };
}

function targetConstrained(): JsonRecord {
  return {
    entities: [
      { id: 'target-anchor', kind: 'point', at: [30, 15] },
      { id: 'target-guide-end', kind: 'point', at: [35, 15] },
      { id: 'target-guide', kind: 'line', a: 'target-anchor', b: 'target-guide-end', construction: true },
    ],
    constraints: [
      { id: 'target-guide-horizontal', kind: 'horizontal', line: 'target-guide' },
      { id: 'target-guide-length', kind: 'length', line: 'target-guide', value: 5 },
    ],
    blockInstances: [],
    relations: [],
  };
}

function rootPart(document: JsonRecord): JsonRecord {
  const partId = document.rootDocument?.partId;
  const part = document.partDefinitions?.find((entry: JsonRecord) => entry.id === partId)
    || document.partDefinitions?.[0];
  assert.ok(part, 'browser document has no active part definition');
  return part;
}

async function readPart(page: Page): Promise<JsonRecord> {
  const document = await page.evaluate(() => JSON.parse((window as any).__bwStudio.docJson()));
  return rootPart(document);
}

async function waitForSettlement(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    return studio
      && studio.appliedRevision() === studio.documentRevision()
      && studio.mode()?.kind === 'idle';
  }, { polling: 100, timeout: 120_000 });
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
      if (!(element instanceof HTMLElement)) return { visible: false, owns: false };
      const style = getComputedStyle(element);
      const target = document.elementFromPoint(location.x, location.y);
      return {
        visible: !element.hidden && style.display !== 'none' && style.visibility !== 'hidden',
        owns: Boolean(target && (target === element || element.contains(target))),
      };
    }, point);
    assert.equal(hit.visible, true, `control is hidden: ${selector}`);
    assert.equal(hit.owns, true, `control does not own its center hit target: ${selector}`);
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

async function clientPoint(page: Page, point: [number, number]): Promise<[number, number]> {
  const location = await page.evaluate(([x, y]) => {
    const studio = (window as any).__bwStudio;
    const canvas = document.querySelector('#bw-sketch-canvas') as HTMLCanvasElement | null;
    if (!canvas) throw new Error('Sketch canvas is missing.');
    const rect = canvas.getBoundingClientRect();
    const view = studio.sketchViewForTest();
    return {
      x: rect.left + rect.width / 2 + (x - view.cx) * view.pxPerMm,
      y: rect.top + rect.height / 2 - (y - view.cy) * view.pxPerMm,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    };
  }, point);
  assert.ok(
    location.x >= location.rect.left + 2
      && location.x <= location.rect.right - 2
      && location.y >= location.rect.top + 2
      && location.y <= location.rect.bottom - 2,
    `sketch point ${JSON.stringify(point)} is outside the visible canvas`,
  );
  return [location.x, location.y];
}

async function clickSketchPoint(page: Page, point: [number, number]): Promise<void> {
  const target = await clientPoint(page, point);
  await page.mouse.move(target[0], target[1]);
  await page.mouse.click(target[0], target[1], { button: 'left' });
}

async function waitForMemberEditor(page: Page, kind: string, id: string): Promise<JsonRecord> {
  await page.waitForFunction((expectedKind, expectedId) => {
    const studio = (window as any).__bwStudio;
    const visual = studio?.sketchVisualState?.();
    const bounds = document.querySelector('#bw-sketch-canvas')?.getBoundingClientRect();
    return visual?.visible === true
      && visual.memberTarget?.kind === expectedKind
      && visual.memberTarget?.id === expectedId
      && visual.solverStatus === 'ok'
      && bounds && bounds.width > 100 && bounds.height > 100;
  }, { polling: 50, timeout: 120_000 }, kind, id);
  return page.evaluate(() => (window as any).__bwStudio.sketchVisualState());
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

async function exactSettlement(page: Page, bodyIds: string[]): Promise<JsonRecord> {
  await waitForSettlement(page);
  const settlement = await page.evaluate(async (expectedBodyIds) => {
    const studio = (window as any).__bwStudio;
    const exact = await studio.exactBodyResultsForTest();
    const ordinary = studio.bodyResults();
    return {
      exact,
      canonicalHash: studio.canonicalHash(),
      documentRevision: studio.documentRevision(),
      appliedRevision: studio.appliedRevision(),
      bodies: expectedBodyIds.map((bodyId) => ({
        exact: exact.bodies.find((entry: any) => entry.bodyId === bodyId) || null,
        ordinary: ordinary.find((entry: any) => entry.bodyId === bodyId) || null,
      })),
    };
  }, bodyIds);
  assert.equal(settlement.documentRevision, settlement.appliedRevision, 'visible document is not currently settled');
  assert.equal(settlement.exact.revision, settlement.documentRevision, 'exact worker evidence is not for the current revision');
  assert.equal(
    settlement.exact.effectiveDocumentHash,
    settlement.canonicalHash,
    'exact worker evidence is not bound to the current canonical document hash',
  );
  assert.deepEqual(settlement.exact.errors, [], 'exact worker settlement reported errors');
  for (const [index, bodyId] of bodyIds.entries()) {
    const evidence = settlement.bodies[index];
    assert.equal(evidence?.exact?.bodyId, bodyId, `exact body ${bodyId} is missing`);
    assert.equal(evidence?.ordinary?.bodyId, bodyId, `ordinary settled body ${bodyId} is missing`);
    assert.equal(evidence.exact.error, null, `exact body ${bodyId} reported an error`);
    assert.equal(evidence.exact.geometry?.valid, true, `exact body ${bodyId} is not valid`);
    assert.equal(evidence.exact.geometry?.brepValid, true, `exact body ${bodyId} is not BRepCheck-valid`);
    assert.equal(evidence.exact.geometry?.solidCount, 1, `exact body ${bodyId} is not exactly one solid`);
    assert.equal(evidence.exact.geometry?.faceCount, 6, `exact body ${bodyId} is not a six-face prism`);
    assert.equal(evidence.exact.geometry?.edgeCount, 12, `exact body ${bodyId} is not a twelve-edge prism`);
    assert.equal(evidence.exact.geometry?.vertexCount, 8, `exact body ${bodyId} is not an eight-vertex prism`);
    assert.ok(evidence.exact.geometry?.volume > 0, `exact body ${bodyId} has no positive volume`);
    assert.ok(typeof evidence.exact.exactBrep === 'string' && evidence.exact.exactBrep.length > 100,
      `exact body ${bodyId} has no canonical BREP`);
    assert.deepEqual(evidence.ordinary.geometry?.bounds, evidence.exact.geometry.bounds,
      `ordinary and exact ${bodyId} bounds disagree`);
    assert.ok(closeTo(evidence.ordinary.geometry?.volume, evidence.exact.geometry.volume),
      `ordinary and exact ${bodyId} volumes disagree`);
  }
  return settlement;
}

function exactBody(settlement: JsonRecord, bodyId: string): JsonRecord {
  const body = settlement.bodies.find((entry: JsonRecord) => entry.exact?.bodyId === bodyId)?.exact;
  assert.ok(body, `exact settlement is missing ${bodyId}`);
  return body;
}

function assertExactBodyChanged(before: JsonRecord, after: JsonRecord, bodyId: string): void {
  const left = exactBody(before, bodyId);
  const right = exactBody(after, bodyId);
  assert.notEqual(right.exactBrep, left.exactBrep, `${bodyId} reused stale canonical BREP evidence`);
  assert.notDeepEqual(right.geometry.bounds, left.geometry.bounds, `${bodyId} exact bounds did not change`);
  assert.notEqual(right.geometry.volume, left.geometry.volume, `${bodyId} exact volume did not change`);
  assert.notEqual(after.canonicalHash, before.canonicalHash, `${bodyId} edit did not change the canonical document hash`);
  assert.ok(after.documentRevision > before.documentRevision, `${bodyId} edit did not advance the document revision`);
}

async function waitForTargetInstanceCount(page: Page, count: number): Promise<void> {
  await page.waitForFunction((sketchId, expectedCount) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    const partId = document.rootDocument?.partId;
    const part = document.partDefinitions?.find((entry: any) => entry.id === partId)
      || document.partDefinitions?.[0];
    const sketch = part?.sketches?.find((entry: any) => entry.id === sketchId);
    return sketch?.constrained?.blockInstances?.length === expectedCount;
  }, { polling: 100, timeout: 30_000 }, TARGET_SKETCH_ID, count);
  await waitForSettlement(page);
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
  assert.equal(response?.status(), 200, 'sketch-reuse UI route did not return HTTP 200');
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);

  const members = ['source-bottom', 'source-right', 'source-top', 'source-left'];
  await page.evaluate((fixture) => (window as any).__bwStudio.commitHumanOperationsForTest(
    'Seed sketch reuse UI acceptance',
    [
      { kind: 'project.clear', input: {} },
      {
        kind: 'sketch.constrained.create',
        input: {
          id: fixture.sourceSketchId,
          name: 'UI source sketch',
          plane: 'XY',
          z: 0,
          constrained: fixture.source,
        },
      },
      {
        kind: 'sketch.constrained.create',
        input: {
          id: fixture.targetSketchId,
          name: 'UI target sketch',
          plane: 'XY',
          z: 0,
          constrained: fixture.target,
        },
      },
      {
        kind: 'sketch.blockDefinition.create',
        input: {
          id: fixture.definitionAId,
          name: 'UI block A',
          insertionPoint: [0, 0],
          sourceSketchId: fixture.sourceSketchId,
          memberEntityIds: fixture.members,
        },
      },
      {
        kind: 'sketch.blockDefinition.create',
        input: {
          id: fixture.definitionBId,
          name: 'UI block B',
          insertionPoint: [0, 0],
          sourceSketchId: fixture.sourceSketchId,
          memberEntityIds: fixture.members,
        },
      },
      {
        kind: 'feature.extrude',
        input: {
          id: fixture.sourceFeatureId,
          name: 'UI source exact consumer',
          sketchId: fixture.sourceSketchId,
          height: 5,
          resultPolicy: { kind: 'new-body', bodyName: 'UI source body' },
        },
      },
    ],
  ), {
    sourceSketchId: SOURCE_SKETCH_ID,
    targetSketchId: TARGET_SKETCH_ID,
    definitionAId: DEFINITION_A_ID,
    definitionBId: DEFINITION_B_ID,
    sourceFeatureId: SOURCE_FEATURE_ID,
    source: rectangleConstrained(12, 8),
    target: targetConstrained(),
    members,
  });
  await waitForSettlement(page);
  let part = await readPart(page);
  assert.equal(part.sketches.length, 2, 'fixture did not persist both first-class sketches');
  assert.equal(part.sketchBlockDefinitions.length, 2, 'fixture did not persist both block definitions');
  const sourceExactAtTwelve = await exactSettlement(page, [SOURCE_BODY_ID]);
  assert.ok(closeTo(exactBody(sourceExactAtTwelve, SOURCE_BODY_ID).geometry.volume, 12 * 8 * 5),
    'source exact consumer does not match its initial constrained profile');

  await clickVisible(page, `#bw-history [data-sel="${SOURCE_FEATURE_ID}"]`);
  await page.waitForFunction(() =>
    document.querySelector('[data-cxedit="1"]')?.textContent?.trim() === 'Profile');
  await clickVisible(page, '[data-cxedit="1"]');
  await page.waitForFunction((sketchId) => {
    const dialog = document.getElementById('bw-sketch-reuse') as HTMLDialogElement | null;
    const selector = document.getElementById('bw-sketch-reuse-sketch') as HTMLSelectElement | null;
    return dialog?.open === true && selector?.value === sketchId;
  }, { polling: 50, timeout: 30_000 }, SOURCE_SKETCH_ID);
  await clickVisible(page, '#bw-sketch-reuse-close');
  await page.waitForFunction(() =>
    (document.getElementById('bw-sketch-reuse') as HTMLDialogElement | null)?.open !== true);

  await assertHitTestable(page, '#bw-sketch-reuse-open');
  await clickVisible(page, '#bw-sketch-reuse-open');
  await page.waitForFunction(() => (document.getElementById('bw-sketch-reuse') as HTMLDialogElement | null)?.open === true);

  const registryAudit = await page.evaluate(async (requiredOperations) => {
    const studioScript = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
    if (!studioScript) throw new Error('Cannot locate the built Studio module URL.');
    const registryUrl = new URL('studio-v6-ui-registry.js', studioScript.src).href;
    const registryModule = await import(registryUrl);
    const registry = registryModule.CAD_UI_CONTROL_REGISTRY as any[];
    const dialog = document.getElementById('bw-sketch-reuse');
    if (!dialog) throw new Error('Sketch reuse dialog is missing.');
    const interactiveIds = [...dialog.querySelectorAll('button[id], input[id], select[id], textarea[id]')]
      .map((element) => element.id);
    const owners = new Map<string, any[]>();
    for (const entry of registry) {
      for (const binding of entry.humanBindings || []) {
        if (binding.kind !== 'element-id') continue;
        const list = owners.get(binding.elementId) || [];
        list.push(entry);
        owners.set(binding.elementId, list);
      }
    }
    const registeredReuseIds = [...owners.keys()].filter((id) => id.startsWith('bw-sketch-reuse-'));
    const operationMismatches = Object.entries(requiredOperations).flatMap(([elementId, operationKind]) => {
      const entries = owners.get(elementId) || [];
      return entries.some((entry) => entry.operationKinds?.includes(operationKind))
        ? []
        : [`${elementId}:${operationKind}`];
    });
    return {
      interactiveIds,
      missingRegistrations: interactiveIds.filter((id) => !owners.has(id)),
      duplicateRegistrations: interactiveIds.filter((id) => (owners.get(id) || []).length !== 1),
      staleRegistrations: registeredReuseIds.filter((id) => !document.getElementById(id)),
      openRegistered: owners.has('bw-sketch-reuse-open'),
      operationMismatches,
    };
  }, requiredOperationByControl);
  assert.equal(registryAudit.openRegistered, true, 'ribbon entry is absent from the control registry');
  assert.deepEqual(registryAudit.missingRegistrations, [], 'dialog has unregistered controls');
  assert.deepEqual(registryAudit.duplicateRegistrations, [], 'dialog controls have ambiguous registry owners');
  assert.deepEqual(registryAudit.staleRegistrations, [], 'registry contains stale sketch-reuse bindings');
  assert.deepEqual(registryAudit.operationMismatches, [], 'lifecycle controls advertise the wrong typed operations');
  assert.ok(registryAudit.interactiveIds.length >= 40, 'dialog control inventory unexpectedly shrank');
  for (const id of registryAudit.interactiveIds) await assertHitTestable(page, `#${id}`);

  await replaceValue(page, '#bw-sketch-reuse-promote-name', 'UI visibly authored sketch');
  await page.select('#bw-sketch-reuse-promote-plane', 'YZ');
  await clickVisible(page, '#bw-sketch-reuse-create');
  await waitForMemberEditor(page, 'sketch-create', await page.evaluate(() =>
    (window as any).__bwStudio.sketchVisualState()?.memberTarget?.id));
  await clickVisible(page, '[data-sktool="rect"]');
  await clickSketchPoint(page, [-8, -5]);
  await clickSketchPoint(page, [8, 5]);
  await page.waitForFunction(() => {
    const constrained = (window as any).__bwStudio.sketchDraftForTest()?.sketch?.constrained;
    return constrained?.entities?.filter((entry: any) => entry.kind === 'line').length === 4
      && constrained?.constraints?.length === 6
      && constrained.constraints.filter((entry: any) => entry.kind === 'length').length === 2;
  }, { polling: 50, timeout: 30_000 });
  await clickVisible(page, '[data-sktool="line"]');
  for (const point of [[12, -3], [16, -3], [14, 1], [12, -3]] as Array<[number, number]>) {
    await clickSketchPoint(page, point);
  }
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    const constrained = studio.sketchDraftForTest()?.sketch?.constrained;
    return constrained?.entities?.filter((entry: any) => entry.kind === 'line').length === 7
      && constrained?.entities?.filter((entry: any) => entry.kind === 'point').length === 7
      && constrained?.constraints?.length === 8
      && studio.sketchVisualState()?.solverStatus === 'ok';
  }, { polling: 50, timeout: 30_000 });
  const pointerAuthoredDraft = await page.evaluate(() =>
    (window as any).__bwStudio.sketchDraftForTest().sketch.constrained);
  await clickVisible(page, '#bw-sk-apply');
  await page.waitForFunction(() => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    const partId = document.rootDocument?.partId;
    const part = document.partDefinitions.find((entry: any) => entry.id === partId);
    return part.sketches.some((entry: any) =>
      entry.name === 'UI visibly authored sketch'
      && entry.plane === 'YZ'
      && entry.extensions?.studioRole === 'constrained-2d'
      && entry.constrained?.entities?.length === 14
      && entry.constrained?.constraints?.length === 8
      && entry.constrained.constraints.filter((constraint: any) => constraint.kind === 'length').length >= 2);
  }, { polling: 100, timeout: 30_000 });
  await waitForSettlement(page);
  part = await readPart(page);
  const temporarySketch = part.sketches.find((entry: JsonRecord) => entry.name === 'UI visibly authored sketch');
  assert.ok(temporarySketch, 'visible New did not persist its pointer-authored first-class constrained graph');
  assert.deepEqual(
    temporarySketch.constrained,
    pointerAuthoredDraft,
    'visible New replaced or normalized away the exact Rect/Line pointer-authored graph',
  );
  assert.equal(temporarySketch.constrained.blockInstances.length, 0, 'visible New invented block instances');
  assert.equal(temporarySketch.constrained.relations.length, 0, 'visible New invented placement relations');
  await clickVisible(page, '#bw-sketch-reuse-delete-sketch');
  await page.waitForFunction((sketchId) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    const partId = document.rootDocument?.partId;
    const part = document.partDefinitions.find((entry: any) => entry.id === partId);
    return !part.sketches.some((entry: any) => entry.id === sketchId);
  }, { polling: 100, timeout: 30_000 }, temporarySketch.id);
  await waitForSettlement(page);

  await page.select('#bw-sketch-reuse-sketch', SOURCE_SKETCH_ID);
  const beforeRejectedOpenProfile = await projectState(page);
  await clickVisible(page, '#bw-sketch-reuse-edit-members');
  await waitForMemberEditor(page, 'sketch-update', SOURCE_SKETCH_ID);
  const sourceDraftBeforeTrim = await page.evaluate(() =>
    JSON.stringify((window as any).__bwStudio.sketchDraftForTest()));
  await clickVisible(page, '[data-sktool="trim"]');
  await clickSketchPoint(page, [12, 4]);
  await page.waitForFunction((before) => {
    const studio = (window as any).__bwStudio;
    return JSON.stringify(studio.sketchDraftForTest()) !== before
      && studio.sketchVisualState()?.solverStatus === 'invalid';
  }, { polling: 50, timeout: 30_000 }, sourceDraftBeforeTrim);
  await clickVisible(page, '#bw-sk-apply');
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    const dialog = document.getElementById('bw-sketch-reuse') as HTMLDialogElement | null;
    const visual = studio.sketchVisualState?.();
    return visual?.visible === true
      && visual.solverStatus === 'invalid'
      && visual.pill?.className?.includes('is-conflict')
      && dialog?.open !== true;
  }, { polling: 50, timeout: 30_000 });
  assert.deepEqual(
    await projectState(page),
    beforeRejectedOpenProfile,
    'rejected visible open-profile member edit changed document bytes, hash, revision, or history',
  );
  await clickVisible(page, '#bw-sk-cancel');
  await page.waitForFunction(() =>
    (document.getElementById('bw-sketch-reuse') as HTMLDialogElement | null)?.open === true);
  await waitForSettlement(page);

  const beforeCancelledSourceEdit = await projectState(page);
  await clickVisible(page, '#bw-sketch-reuse-edit-members');
  await waitForMemberEditor(page, 'sketch-update', SOURCE_SKETCH_ID);
  await replaceValue(page, '#bw-sk-dims [data-cdim="4"]', '14');
  await page.waitForFunction(() => {
    const draft = (window as any).__bwStudio.sketchDraftForTest();
    return draft?.sketch?.constrained?.constraints?.[4]?.value === 14
      && (window as any).__bwStudio.sketchVisualState()?.solverStatus === 'ok';
  }, { polling: 50, timeout: 30_000 });
  assert.equal(
    await page.evaluate(() => (window as any).__bwStudio.docJson()),
    beforeCancelledSourceEdit.docJson,
    'visible member draft mutated the authoritative document before Apply',
  );
  await clickVisible(page, '#bw-sk-cancel');
  await page.waitForFunction(() =>
    (document.getElementById('bw-sketch-reuse') as HTMLDialogElement | null)?.open === true);
  await waitForSettlement(page);
  assert.deepEqual(
    await projectState(page),
    beforeCancelledSourceEdit,
    'Cancel after a visible member-dimension change altered document bytes, hash, revision, or history',
  );
  const sourceExactAfterCancel = await exactSettlement(page, [SOURCE_BODY_ID]);
  assert.equal(
    exactBody(sourceExactAfterCancel, SOURCE_BODY_ID).exactBrep,
    exactBody(sourceExactAtTwelve, SOURCE_BODY_ID).exactBrep,
    'Cancel changed the exact source consumer',
  );

  await clickVisible(page, '#bw-sketch-reuse-edit-members');
  await waitForMemberEditor(page, 'sketch-update', SOURCE_SKETCH_ID);
  await replaceValue(page, '#bw-sk-dims [data-cdim="4"]', '16');
  await clickVisible(page, '#bw-sk-apply');
  await page.waitForFunction((sketchId) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    const partId = document.rootDocument?.partId;
    const part = document.partDefinitions.find((entry: any) => entry.id === partId);
    return part.sketches.find((entry: any) => entry.id === sketchId)
      ?.constrained?.constraints?.find((entry: any) => entry.id === 'source-width')?.value === 16;
  }, { polling: 50, timeout: 30_000 }, SOURCE_SKETCH_ID);
  const sourceExactAtSixteen = await exactSettlement(page, [SOURCE_BODY_ID]);
  assertExactBodyChanged(sourceExactAtTwelve, sourceExactAtSixteen, SOURCE_BODY_ID);
  assert.ok(closeTo(exactBody(sourceExactAtSixteen, SOURCE_BODY_ID).geometry.volume, 16 * 8 * 5),
    'visible source dimension edit did not update the exact Extrude volume');

  await page.select('#bw-sketch-reuse-sketch', TARGET_SKETCH_ID);
  await page.select('#bw-sketch-reuse-instance-definition', DEFINITION_A_ID);
  await replaceValue(page, '#bw-sketch-reuse-translation-x', '2');
  await replaceValue(page, '#bw-sketch-reuse-translation-y', '3');
  await replaceValue(page, '#bw-sketch-reuse-angle', '5');
  await replaceValue(page, '#bw-sketch-reuse-scale', '1.25');
  await clickVisible(page, '#bw-sketch-reuse-fixed');
  await clickVisible(page, '#bw-sketch-reuse-insert');
  await waitForTargetInstanceCount(page, 1);
  part = await readPart(page);
  let targetSketch = part.sketches.find((entry: JsonRecord) => entry.id === TARGET_SKETCH_ID);
  const instanceId = targetSketch.constrained.blockInstances[0].id;
  assert.equal(targetSketch.constrained.blockInstances[0].definitionId, DEFINITION_A_ID, 'visible insert used the wrong definition');
  assert.equal(targetSketch.constrained.blockInstances[0].fixed, true, 'visible insert did not fix the block instance');

  await page.select('#bw-sketch-reuse-instance-definition', DEFINITION_B_ID);
  await replaceValue(page, '#bw-sketch-reuse-translation-x', '4');
  await replaceValue(page, '#bw-sketch-reuse-translation-y', '6');
  await replaceValue(page, '#bw-sketch-reuse-angle', '12');
  await clickVisible(page, '#bw-sketch-reuse-edit-instance');
  await page.waitForFunction((sketchId, expectedInstanceId) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    const partId = document.rootDocument?.partId;
    const part = document.partDefinitions.find((entry: any) => entry.id === partId);
    const instance = part.sketches.find((entry: any) => entry.id === sketchId)
      ?.constrained?.blockInstances?.find((entry: any) => entry.id === expectedInstanceId);
    return instance?.transform?.translation?.[0] === 4 && instance?.transform?.angleDeg === 12;
  }, { polling: 100, timeout: 30_000 }, TARGET_SKETCH_ID, instanceId);
  await waitForSettlement(page);
  part = await readPart(page);
  targetSketch = part.sketches.find((entry: JsonRecord) => entry.id === TARGET_SKETCH_ID);
  assert.equal(
    targetSketch.constrained.blockInstances[0].definitionId,
    DEFINITION_A_ID,
    'visible instance edit improperly relinked the block definition',
  );

  const relation = {
    id: 'ui-placement-relation',
    kind: 'coincident',
    a: { entityId: 'target-anchor' },
    b: { instanceId, memberId: 'source-p1' },
  };
  await replaceValue(page, '#bw-sketch-reuse-relation-json', JSON.stringify(relation, null, 2));
  await clickVisible(page, '#bw-sketch-reuse-create-relation');
  await page.waitForFunction((sketchId, relationId) => {
    const project = JSON.parse((window as any).__bwStudio.docJson());
    const partId = project.rootDocument?.partId;
    const part = project.partDefinitions.find((entry: any) => entry.id === partId);
    const persisted = part.sketches.find((entry: any) => entry.id === sketchId)
      ?.constrained?.relations?.some((entry: any) => entry.id === relationId);
    const error = document.getElementById('bw-sketch-reuse-error')?.textContent?.trim();
    return persisted || Boolean(error);
  }, { polling: 100, timeout: 30_000 }, TARGET_SKETCH_ID, relation.id);
  await waitForSettlement(page);
  const relationCreateError = await page.$eval('#bw-sketch-reuse-error', (element) => element.textContent?.trim() || '');
  assert.equal(relationCreateError, '', `visible relation create failed: ${relationCreateError}`);
  part = await readPart(page);
  targetSketch = part.sketches.find((entry: JsonRecord) => entry.id === TARGET_SKETCH_ID);
  assert.deepEqual(targetSketch.constrained.relations[0], relation, 'visible relation create persisted the wrong record');

  const updatedRelation = { ...relation, a: relation.b, b: relation.a };
  await replaceValue(page, '#bw-sketch-reuse-relation-json', JSON.stringify(updatedRelation, null, 2));
  await clickVisible(page, '#bw-sketch-reuse-edit-relation');
  await page.waitForFunction((sketchId, relationId) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    const partId = document.rootDocument?.partId;
    const part = document.partDefinitions.find((entry: any) => entry.id === partId);
    return part.sketches.find((entry: any) => entry.id === sketchId)
      ?.constrained?.relations?.find((entry: any) => entry.id === relationId)?.a?.instanceId != null;
  }, { polling: 100, timeout: 30_000 }, TARGET_SKETCH_ID, relation.id);
  await waitForSettlement(page);
  part = await readPart(page);
  targetSketch = part.sketches.find((entry: JsonRecord) => entry.id === TARGET_SKETCH_ID);
  assert.deepEqual(targetSketch.constrained.relations[0], updatedRelation, 'visible relation update did not persist');

  const targetReuseBeforeMemberEdit = JSON.stringify({
    blockInstances: targetSketch.constrained.blockInstances,
    relations: targetSketch.constrained.relations,
  });
  await clickVisible(page, '#bw-sketch-reuse-edit-members');
  const targetMemberVisual = await waitForMemberEditor(page, 'sketch-update', TARGET_SKETCH_ID);
  assert.equal(targetMemberVisual.dof, 0,
    'member editor did not use the full fixed-block/relation graph for authoritative local DOF');
  assert.ok(targetMemberVisual.memberTarget.contextEntityCount >= 8,
    'member editor omitted linked block geometry from its visible context');
  assert.equal(
    targetMemberVisual.contextGeometry.length,
    targetMemberVisual.memberTarget.contextEntityCount,
    'member editor did not render every linked-context entity',
  );
  assert.ok(
    targetMemberVisual.geometry.every((entry: JsonRecord) => entry.status === 'fully-defined'),
    'member editor painted locally editable members as under-defined despite their authoritative placement relation',
  );
  const solvedTargetAnchor = targetMemberVisual.geometry.find((entry: JsonRecord) =>
    entry.entityId === 'target-anchor')?.at;
  assert.ok(
    Array.isArray(solvedTargetAnchor)
      && Math.abs(solvedTargetAnchor[0] - 4) <= 1e-8
      && Math.abs(solvedTargetAnchor[1] - 6) <= 1e-8,
    `member editor painted the related local anchor at ${JSON.stringify(solvedTargetAnchor)} instead of the fixed block member [4,6]`,
  );
  const beforeUnsupportedPierce = await projectState(page);
  const memberDraftBeforePierce = await page.evaluate(() =>
    JSON.stringify((window as any).__bwStudio.sketchDraftForTest()));
  const pierceOption = await page.$eval('#bw-sk-constraint-kind option[value="pierce"]', (element) => ({
    disabled: (element as HTMLOptionElement).disabled,
    text: element.textContent?.trim() || '',
  }));
  assert.deepEqual(
    pierceOption,
    { disabled: true, text: 'Pierce · unavailable for reusable sketches' },
    'reusable member editor presents unsupported Pierce as an actionable constraint',
  );
  assert.equal(
    await page.evaluate(() => JSON.stringify((window as any).__bwStudio.sketchDraftForTest())),
    memberDraftBeforePierce,
    'unsupported visible Pierce selection mutated the member draft',
  );
  assert.deepEqual(
    await projectState(page),
    beforeUnsupportedPierce,
    'unsupported visible Pierce selection mutated document bytes, hash, revision, or history',
  );
  await replaceValue(page, '#bw-sk-dims [data-cdim="1"]', '7');
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    return studio.sketchDraftForTest()?.sketch?.constrained?.constraints?.[1]?.value === 7
      && studio.sketchVisualState()?.dof === 0;
  }, { polling: 50, timeout: 30_000 });
  await clickVisible(page, '#bw-sk-apply');
  await waitForSettlement(page);
  part = await readPart(page);
  targetSketch = part.sketches.find((entry: JsonRecord) => entry.id === TARGET_SKETCH_ID);
  assert.equal(
    JSON.stringify({
      blockInstances: targetSketch.constrained.blockInstances,
      relations: targetSketch.constrained.relations,
    }),
    targetReuseBeforeMemberEdit,
    'visible member edit changed block instances or placement relations',
  );
  assert.equal(
    targetSketch.constrained.constraints.find((entry: JsonRecord) => entry.id === 'target-guide-length')?.value,
    7,
    'visible member edit did not persist the existing local driving dimension',
  );

  await page.evaluate((fixture) => (window as any).__bwStudio.commitHumanOperationsForTest(
    'Seed target exact consumer',
    [{
      kind: 'feature.extrude',
      input: {
        id: fixture.featureId,
        name: 'UI target exact consumer',
        sketchId: fixture.sketchId,
        height: 4,
        resultPolicy: { kind: 'new-body', bodyName: 'UI target body' },
      },
    }],
  ), { featureId: TARGET_FEATURE_ID, sketchId: TARGET_SKETCH_ID });
  const targetExactBeforeDefinitionEdit = await exactSettlement(page, [SOURCE_BODY_ID, TARGET_BODY_ID]);
  part = await readPart(page);
  assert.equal(
    part.sketchBlockDefinitions.find((entry: JsonRecord) => entry.id === DEFINITION_A_ID)
      ?.constrained?.constraints?.find((entry: JsonRecord) => entry.id === 'source-width')?.value,
    12,
    'source-sketch member edit improperly rewrote the independent block-definition snapshot',
  );
  assert.ok(
    closeTo(exactBody(targetExactBeforeDefinitionEdit, TARGET_BODY_ID).geometry.volume, 12 * 8 * 1.25 * 1.25 * 4),
    'pre-edit block instance exact volume does not use the independent 12 mm definition snapshot',
  );

  await page.select('#bw-sketch-reuse-definition', DEFINITION_A_ID);
  await replaceValue(page, '#bw-sketch-reuse-insertion-x', '2');
  await replaceValue(page, '#bw-sketch-reuse-insertion-y', '1');
  await clickVisible(page, '#bw-sketch-reuse-edit-definition');
  const definitionVisual = await waitForMemberEditor(page, 'definition-update', DEFINITION_A_ID);
  assert.ok(definitionVisual.memberTarget.contextEntityCount >= 8,
    'block-definition editor did not expose its linked instance context');
  assert.equal(
    definitionVisual.contextGeometry.length,
    definitionVisual.memberTarget.contextEntityCount,
    'block-definition editor did not visibly render every linked-context entity',
  );
  assert.ok(definitionVisual.contextGeometry.some((entry: JsonRecord) => entry.kind === 'line'),
    'block-definition linked context has no visible line geometry');
  const contextInsertionPoint = definitionVisual.contextGeometry.find((entry: JsonRecord) =>
    entry.kind === 'point' && entry.entityId.endsWith(':source-p1'))?.at;
  const angle = 12 * Math.PI / 180;
  const insertionDx = -2 * 1.25;
  const insertionDy = -1 * 1.25;
  const expectedContextInsertionPoint = [
    4 + insertionDx * Math.cos(angle) - insertionDy * Math.sin(angle),
    6 + insertionDx * Math.sin(angle) + insertionDy * Math.cos(angle),
  ];
  const actualContextX = Number(contextInsertionPoint?.[0]);
  const actualContextY = Number(contextInsertionPoint?.[1]);
  assert.ok(
    Array.isArray(contextInsertionPoint)
      && Math.abs(actualContextX - expectedContextInsertionPoint[0]!) <= 1e-8
      && Math.abs(actualContextY - expectedContextInsertionPoint[1]!) <= 1e-8,
    `block-definition context used stale insertion metadata: ${JSON.stringify(contextInsertionPoint)}`,
  );
  await replaceValue(page, '#bw-sk-dims [data-cdim="4"]', '18');
  await clickVisible(page, '#bw-sk-apply');
  await page.waitForFunction((definitionId) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    const partId = document.rootDocument?.partId;
    const part = document.partDefinitions.find((entry: any) => entry.id === partId);
    return part.sketchBlockDefinitions.find((entry: any) => entry.id === definitionId)
      ?.constrained?.constraints?.find((entry: any) => entry.id === 'source-width')?.value === 18;
  }, { polling: 50, timeout: 30_000 }, DEFINITION_A_ID);
  const targetExactAfterDefinitionEdit = await exactSettlement(page, [SOURCE_BODY_ID, TARGET_BODY_ID]);
  part = await readPart(page);
  assert.deepEqual(
    part.sketchBlockDefinitions.find((entry: JsonRecord) => entry.id === DEFINITION_A_ID)?.insertionPoint,
    [2, 1],
    'visible block-member edit did not persist its pending insertion point',
  );
  assertExactBodyChanged(targetExactBeforeDefinitionEdit, targetExactAfterDefinitionEdit, TARGET_BODY_ID);
  assert.ok(
    closeTo(exactBody(targetExactAfterDefinitionEdit, TARGET_BODY_ID).geometry.volume, 18 * 8 * 1.25 * 1.25 * 4),
    'visible block-definition member edit did not update the existing instance exact volume',
  );
  assert.equal(
    exactBody(targetExactAfterDefinitionEdit, SOURCE_BODY_ID).exactBrep,
    exactBody(targetExactBeforeDefinitionEdit, SOURCE_BODY_ID).exactBrep,
    'block-definition edit changed its independent first-class source consumer',
  );
  part = await readPart(page);
  targetSketch = part.sketches.find((entry: JsonRecord) => entry.id === TARGET_SKETCH_ID);
  assert.equal(
    JSON.stringify({
      blockInstances: targetSketch.constrained.blockInstances,
      relations: targetSketch.constrained.relations,
    }),
    targetReuseBeforeMemberEdit,
    'block-definition member edit rewrote existing instances or placement relations',
  );

  await page.select('#bw-sketch-reuse-relation', relation.id);
  const beforeRejectedRelationEdit = await projectState(page);
  const invalidRelation = {
    ...updatedRelation,
    b: { entityId: 'missing-local-member' },
  };
  await replaceValue(page, '#bw-sketch-reuse-relation-json', JSON.stringify(invalidRelation, null, 2));
  await clickVisible(page, '#bw-sketch-reuse-edit-relation');
  await page.waitForFunction(() => Boolean(document.getElementById('bw-sketch-reuse-error')?.textContent?.trim()),
    { polling: 50, timeout: 30_000 });
  assert.deepEqual(
    await projectState(page),
    beforeRejectedRelationEdit,
    'rejected visible relation edit changed document bytes, hash, revision, or history',
  );
  const targetExactAfterRejectedEdit = await exactSettlement(page, [TARGET_BODY_ID]);
  assert.equal(
    exactBody(targetExactAfterRejectedEdit, TARGET_BODY_ID).exactBrep,
    exactBody(targetExactAfterDefinitionEdit, TARGET_BODY_ID).exactBrep,
    'rejected visible relation edit changed exact geometry',
  );
  await replaceValue(page, '#bw-sketch-reuse-relation-json', JSON.stringify(updatedRelation, null, 2));

  await page.select('#bw-sketch-reuse-source', SOURCE_SKETCH_ID);
  await replaceValue(page, '#bw-sketch-reuse-derived-name', 'UI linked derived sketch');
  await replaceValue(page, '#bw-sketch-reuse-derived-x', '1');
  await clickVisible(page, '#bw-sketch-reuse-derived');
  await page.waitForFunction((sourceSketchId) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    const partId = document.rootDocument?.partId;
    const part = document.partDefinitions.find((entry: any) => entry.id === partId);
    return part.sketches.some((entry: any) =>
      entry.name === 'UI linked derived sketch'
      && entry.constrained?.derivedFrom?.sourceSketchId === sourceSketchId);
  }, { polling: 100, timeout: 30_000 }, SOURCE_SKETCH_ID);
  await waitForSettlement(page);
  part = await readPart(page);
  let derivedSketch = part.sketches.find((entry: JsonRecord) => entry.name === 'UI linked derived sketch');
  assert.ok(derivedSketch, 'visible derived create did not persist a linked sketch');
  const derivedSketchId = derivedSketch.id;
  const linkedUi = await page.$eval('#bw-sketch-reuse-source', (element) => ({
    disabled: (element as HTMLSelectElement).disabled,
    value: (element as HTMLSelectElement).value,
  }));
  assert.deepEqual(linkedUi, { disabled: true, value: SOURCE_SKETCH_ID }, 'linked source is not visibly locked');

  await page.$eval('#bw-sketch-reuse-source', (element, nextSource) => {
    const select = element as HTMLSelectElement;
    select.value = nextSource;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, TARGET_SKETCH_ID);
  await replaceValue(page, '#bw-sketch-reuse-derived-name', 'UI linked derived sketch edited');
  await replaceValue(page, '#bw-sketch-reuse-derived-x', '7');
  await clickVisible(page, '#bw-sketch-reuse-edit-derived');
  await page.waitForFunction((sketchId) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    const partId = document.rootDocument?.partId;
    const part = document.partDefinitions.find((entry: any) => entry.id === partId);
    const sketch = part.sketches.find((entry: any) => entry.id === sketchId);
    return sketch?.name === 'UI linked derived sketch edited'
      && sketch.constrained?.derivedFrom?.transform?.translation?.[0] === 7;
  }, { polling: 100, timeout: 30_000 }, derivedSketchId);
  await waitForSettlement(page);
  part = await readPart(page);
  derivedSketch = part.sketches.find((entry: JsonRecord) => entry.id === derivedSketchId);
  assert.equal(
    derivedSketch.constrained.derivedFrom.sourceSketchId,
    SOURCE_SKETCH_ID,
    'visible derived edit improperly relinked its source sketch',
  );

  await page.evaluate((fixture) => (window as any).__bwStudio.commitHumanOperationsForTest(
    'Seed derived exact consumer',
    [{
      kind: 'feature.extrude',
      input: {
        id: fixture.featureId,
        name: 'UI derived exact consumer',
        sketchId: fixture.sketchId,
        height: 3,
        resultPolicy: { kind: 'new-body', bodyName: 'UI derived body' },
      },
    }],
  ), { featureId: DERIVED_FEATURE_ID, sketchId: derivedSketchId });
  const linkedExactBeforeSourceEdit = await exactSettlement(
    page,
    [SOURCE_BODY_ID, TARGET_BODY_ID, DERIVED_BODY_ID],
  );
  const derivedLinkBeforeSourceEdit = JSON.stringify(derivedSketch.constrained.derivedFrom);
  assert.equal(
    await page.$eval('#bw-sketch-reuse-edit-members', (element) => element.textContent?.trim()),
    'Edit source members',
    'linked derived sketch does not visibly route member editing to its source',
  );
  await clickVisible(page, '#bw-sketch-reuse-edit-members');
  await waitForMemberEditor(page, 'sketch-update', SOURCE_SKETCH_ID);
  await replaceValue(page, '#bw-sk-dims [data-cdim="4"]', '20');
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    return studio.sketchDraftForTest()?.sketch?.constrained?.constraints?.[4]?.value === 20
      && studio.sketchVisualState()?.solverStatus === 'ok';
  }, { polling: 50, timeout: 30_000 });
  await clickVisible(page, '#bw-sk-apply');
  await page.waitForFunction((sourceSketchId, selectedDerivedId) => {
    const studio = (window as any).__bwStudio;
    const project = JSON.parse(studio.docJson());
    const partId = project.rootDocument?.partId;
    const part = project.partDefinitions.find((entry: any) => entry.id === partId);
    const source = part.sketches.find((entry: any) => entry.id === sourceSketchId);
    const selector = document.querySelector('#bw-sketch-reuse-sketch') as HTMLSelectElement | null;
    return source?.constrained?.constraints?.find((entry: any) => entry.id === 'source-width')?.value === 20
      && selector?.value === selectedDerivedId;
  }, { polling: 50, timeout: 30_000 }, SOURCE_SKETCH_ID, derivedSketchId);
  await waitForSettlement(page);
  part = await readPart(page);
  derivedSketch = part.sketches.find((entry: JsonRecord) => entry.id === derivedSketchId);
  assert.equal(
    JSON.stringify(derivedSketch.constrained.derivedFrom),
    derivedLinkBeforeSourceEdit,
    'editing source members through a selected derived sketch broke or rewrote the derived link',
  );
  const linkedExactAfterSourceEdit = await exactSettlement(
    page,
    [SOURCE_BODY_ID, TARGET_BODY_ID, DERIVED_BODY_ID],
  );
  assertExactBodyChanged(linkedExactBeforeSourceEdit, linkedExactAfterSourceEdit, SOURCE_BODY_ID);
  assertExactBodyChanged(linkedExactBeforeSourceEdit, linkedExactAfterSourceEdit, DERIVED_BODY_ID);
  assert.equal(
    exactBody(linkedExactAfterSourceEdit, TARGET_BODY_ID).exactBrep,
    exactBody(linkedExactBeforeSourceEdit, TARGET_BODY_ID).exactBrep,
    'source-sketch member edit changed the independent block-definition consumer',
  );
  assert.ok(closeTo(exactBody(linkedExactAfterSourceEdit, SOURCE_BODY_ID).geometry.volume, 20 * 8 * 5),
    'source member edit through the linked sketch did not update its exact Extrude');
  assert.ok(closeTo(exactBody(linkedExactAfterSourceEdit, DERIVED_BODY_ID).geometry.volume, 20 * 8 * 3),
    'source member edit through the linked sketch did not update the derived exact Extrude');

  await page.evaluate((featureId) => (window as any).__bwStudio.commitHumanOperationsForTest(
    'Remove target exact consumer for lifecycle cleanup',
    [{ kind: 'feature.delete', input: { featureId } }],
  ), TARGET_FEATURE_ID);
  await waitForSettlement(page);
  await page.select('#bw-sketch-reuse-sketch', TARGET_SKETCH_ID);
  await page.select('#bw-sketch-reuse-relation', relation.id);
  await clickVisible(page, '#bw-sketch-reuse-delete-relation');
  await page.waitForFunction((sketchId) => {
    const document = JSON.parse((window as any).__bwStudio.docJson());
    const partId = document.rootDocument?.partId;
    const part = document.partDefinitions.find((entry: any) => entry.id === partId);
    return part.sketches.find((entry: any) => entry.id === sketchId)?.constrained?.relations?.length === 0;
  }, { polling: 100, timeout: 30_000 }, TARGET_SKETCH_ID);
  await clickVisible(page, '#bw-sketch-reuse-delete-instance');
  await waitForTargetInstanceCount(page, 0);
  part = await readPart(page);
  targetSketch = part.sketches.find((entry: JsonRecord) => entry.id === TARGET_SKETCH_ID);
  assert.deepEqual(targetSketch.constrained.relations, [], 'visible relation delete left a record behind');
  assert.deepEqual(targetSketch.constrained.blockInstances, [], 'visible instance delete left a record behind');

  assert.deepEqual(failures, [], `sketch-reuse browser gate reported errors: ${failures.join(' | ')}`);
  console.log(JSON.stringify({
    browserBacked: true,
    registeredHitTestableControls: registryAudit.interactiveIds.length,
    constrainedSketchLifecycle: ['pointer-create', 'member-update', 'cancel-rollback', 'delete'],
    instanceLifecycle: ['create', 'update', 'delete'],
    relationLifecycle: ['create', 'update', 'delete'],
    linkedContext: { visible: true, authoritativeDof: 0 },
    exactConsumers: [SOURCE_BODY_ID, TARGET_BODY_ID, DERIVED_BODY_ID],
    exactMemberUpdates: ['source', 'block-definition', 'derived-source'],
    atomicFailure: { relationUpdate: true, stateUnchanged: true },
    prohibitedRelinks: { instanceDefinition: true, derivedSource: true },
    documentStateVerified: true,
    consoleNetworkPageErrors: 0,
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
