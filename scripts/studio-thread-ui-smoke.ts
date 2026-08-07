import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import puppeteer, { type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-thread-ui-'));
const SOURCE_FEATURE_ID = 'feature-ui-thread-shaft';
const SOURCE_BODY_ID = 'body-' + SOURCE_FEATURE_ID;
const SECOND_FEATURE_ID = 'feature-ui-thread-unrelated-shaft';
const SECOND_BODY_ID = 'body-' + SECOND_FEATURE_ID;
const THREAD_NAME = '<svg onload="window.__pt005Injected=true"> exact external thread';
const PROJECT_NAME = '<img src=x onerror="window.__pt005Injected=true"> thread project';
const MODELED_HELIX_ANGULAR_SIGN = { right: 1, left: -1 } as const;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function rootPart(document: JsonRecord): JsonRecord {
  const part = document.partDefinitions?.find((entry: JsonRecord) => entry.id === document.rootDocument?.partId)
    || document.partDefinitions?.[0];
  assert.ok(part, 'browser document has no root part');
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
    return studio && studio.appliedRevision() === studio.documentRevision() && studio.mode()?.kind === 'idle';
  }, { polling: 100, timeout: 180_000 });
}

async function waitForDialog(page: Page, open: boolean): Promise<void> {
  await page.waitForFunction((expected) =>
    (document.getElementById('bw-thread') as HTMLDialogElement | null)?.open === expected,
  { polling: 50, timeout: 60_000 }, open);
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
    const hit = await control.evaluate((element, location) => {
      const style = getComputedStyle(element);
      const target = document.elementFromPoint(location.x, location.y);
      return {
        visible: element instanceof HTMLElement && !element.hidden
          && style.display !== 'none' && style.visibility !== 'hidden',
        owns: Boolean(target && (target === element || element.contains(target))),
        target: target instanceof Element ? `${target.tagName.toLowerCase()}#${target.id}` : String(target),
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
    assert.ok(box, `click target lost bounds: ${selector}`);
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
  assert.deepEqual(selected, [value], `${selector} did not accept ${value}`);
}

async function isolatedExact(page: Page): Promise<JsonRecord> {
  await waitForSettlement(page);
  return page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    const studioScript = [...document.scripts].find((entry) => entry.src.includes('/studio.js'));
    if (!studioScript) throw new Error('versioned Studio module URL is missing');
    const worker = new Worker(new URL('studio-kernel.worker.js', studioScript.src).href, { type: 'module' });
    const requestId = `thread-ui-${crypto.randomUUID()}`;
    try {
      const response = await new Promise<JsonRecord>((resolveResponse, rejectResponse) => {
        const timeout = setTimeout(() => rejectResponse(new Error('isolated production worker timed out')), 180_000);
        const onMessage = (event: MessageEvent<JsonRecord>) => {
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
          kind: 'rebuild', requestId, projectId: studio.projectId(), revision: studio.documentRevision(),
          document: JSON.parse(studio.docJson()), includeExactBrep: true,
        });
      });
      return JSON.parse(JSON.stringify({
        kind: response.kind,
        revision: response.revision,
        effectiveDocumentHash: response.effectiveDocumentHash || null,
        documentRevision: studio.documentRevision(),
        appliedRevision: studio.appliedRevision(),
        canonicalHash: studio.canonicalHash(),
        errors: response.errors || [],
        bodies: response.bodies || [],
      }));
    } finally {
      worker.terminate();
    }
  });
}

function exactBody(snapshot: JsonRecord, bodyId: string, label: string): JsonRecord {
  assert.equal(snapshot.kind, 'rebuild-result', `${label}: wrong isolated-worker response kind`);
  assert.equal(snapshot.revision, snapshot.documentRevision, `${label}: isolated proof is stale`);
  assert.equal(snapshot.appliedRevision, snapshot.documentRevision, `${label}: visible rebuild is unsettled`);
  assert.equal(snapshot.effectiveDocumentHash, snapshot.canonicalHash,
    `${label}: exact result is not current-document-hash-bound`);
  assert.deepEqual(snapshot.errors, [], `${label}: isolated production worker reported errors`);
  const body = snapshot.bodies.find((entry: JsonRecord) => entry.bodyId === bodyId);
  assert.ok(body, `${label}: exact body is missing`);
  assert.equal(body.error, null, `${label}: exact body has an error`);
  assert.equal(body.lastValid, false, `${label}: exact body reused last-valid geometry`);
  assert.equal(body.geometry?.valid, true, `${label}: exact body is invalid`);
  assert.equal(body.geometry?.brepValid, true, `${label}: BRepCheck rejected exact body`);
  assert.equal(body.geometry?.solidCount, 1, `${label}: exact body is not one solid`);
  assert.ok(typeof body.exactBrep === 'string' && body.exactBrep.length > 100,
    `${label}: canonical exact BREP is missing`);
  const counts = body.mesh?.topologyCounts;
  assert.equal(counts?.faces, body.geometry.faceCount, `${label}: face counts disagree`);
  assert.equal(counts?.edges, body.geometry.edgeCount, `${label}: edge counts disagree`);
  assert.equal(counts?.vertices, body.geometry.vertexCount, `${label}: vertex counts disagree`);
  assert.equal(counts?.namedFaces, counts?.faces, `${label}: face naming is incomplete`);
  assert.equal(counts?.namedEdges, counts?.edges, `${label}: edge naming is incomplete`);
  assert.equal(counts?.namedVertices, counts?.vertices, `${label}: vertex naming is incomplete`);
  assert.deepEqual(body.mesh?.topologyDiagnostics || [], [], `${label}: topology naming emitted diagnostics`);
  return body;
}

async function selectCylindricalFaceThroughViewport(page: Page, bodyId: string): Promise<JsonRecord> {
  const session = await page.evaluate(async (targetBodyId) => {
    const studio = (window as any).__bwStudio;
    const agent = (window as any).partmodeAgent;
    const connection = await studio.connectAgentForTest({
      clientLabel: 'PT005 trusted viewport face selection',
      mode: 'read-only',
      permissionContext: { granted: ['project.read', 'ui.read', 'ui.select'] },
    });
    const token = connection.connectionToken;
    const topology = await agent.requestTool(token, 'cad_query', {
      query: { kind: 'geometry.topology', bodyId: targetBodyId, limit: 250 },
    }, 'pt005-topology-query');
    if (topology.revision !== studio.commandRevision() || topology.result?.exactGeometry !== true) {
      throw new Error(`topology inventory is stale or approximate: ${JSON.stringify(topology)}`);
    }
    return { token, topology };
  }, bodyId);
  try {
    await selectValue(page, '#bw-selection-filter', 'face');
    await page.evaluate(() => {
      const studio = (window as any).__bwStudio;
      studio.setViewForTest('front');
      studio.frame();
    });
    const canvas = await page.$('canvas[aria-label="3D modeling canvas"]');
    assert.ok(canvas, '3D modeling canvas is missing');
    const box = await canvas.boundingBox();
    assert.ok(box, '3D modeling canvas has no bounds');
    let selected: JsonRecord | null = null;
    // Center-out ring sweep across the full canvas. frame() fits every visible
    // body, so once the fixture seeds additional bodies the target face can sit
    // well outside the central region.
    const sweep = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75, 0.2, 0.8, 0.15, 0.85];
    for (const fy of sweep) {
      for (const fx of sweep) {
        await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
        const snapshot = await page.evaluate(async (token) =>
          (window as any).partmodeAgent.requestTool(token, 'cad_ui', { action: 'snapshot' },
            `pt005-selection-${crypto.randomUUID()}`), session.token);
        const candidate = snapshot.selection?.[0];
        if (snapshot.selection?.length === 1 && candidate?.owner?.id === bodyId
          && candidate?.topologySignature?.kind === 'face' && candidate?.expectedGeometry === 'cylinder') {
          selected = candidate;
          break;
        }
      }
      if (selected) break;
    }
    assert.ok(selected, 'trusted viewport clicks did not select the exact cylindrical face');
    const inventoryMatch = session.topology.result.items.find((entry: JsonRecord) =>
      entry.stableId === selected?.stableId && entry.owner?.id === bodyId);
    assert.ok(inventoryMatch, 'viewport selection does not belong to the current exact topology inventory');
    const persistentName = await page.evaluate(async (stableId) => {
      const studioScript = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
      if (!studioScript) throw new Error('Studio module URL is missing');
      const interaction = await import(new URL('studio-v6-interaction.js', studioScript.src).href);
      return interaction.cadUiTopologyNameFromStableId(stableId);
    }, selected.stableId);
    assert.ok(typeof persistentName === 'string' && persistentName.length > 0,
      'viewport-selected cylindrical face has no persistent topology name');
    return { selection: selected, inventory: inventoryMatch, persistentName, revision: session.topology.revision };
  } finally {
    await page.evaluate((token) => (window as any).partmodeAgent.disconnect(token), session.token);
  }
}

async function selectExactTopologyFace(page: Page, input: {
  bodyId: string;
  label: string;
  expectedGeometry?: string;
  persistentNamePrefix?: string;
}): Promise<JsonRecord> {
  return page.evaluate(async (criteria) => {
    const studio = (window as any).__bwStudio;
    const agent = (window as any).partmodeAgent;
    const connection = await studio.connectAgentForTest({
      clientLabel: `PT005 ${criteria.label} selection`,
      mode: 'read-only',
      permissionContext: { granted: ['project.read', 'ui.read', 'ui.select'] },
    });
    const token = connection.connectionToken;
    try {
      const topology = await agent.requestTool(token, 'cad_query', {
        query: { kind: 'geometry.topology', bodyId: criteria.bodyId, limit: 250 },
      }, `pt005-${criteria.label}-topology`);
      if (topology.revision !== studio.commandRevision() || topology.result?.exactGeometry !== true) {
        throw new Error(`${criteria.label} topology inventory is stale or approximate: ${JSON.stringify(topology)}`);
      }
      const studioScript = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
      if (!studioScript) throw new Error('Studio module URL is missing');
      const interaction = await import(new URL('studio-v6-interaction.js', studioScript.src).href);
      const candidates = (topology.result.items || [])
        .filter((entry: JsonRecord) => entry.owner?.id === criteria.bodyId
          && entry.topologySignature?.kind === 'face'
          && (!criteria.expectedGeometry || entry.expectedGeometry === criteria.expectedGeometry))
        .map((entry: JsonRecord) => ({
          entry,
          persistentName: interaction.cadUiTopologyNameFromStableId(entry.stableId),
        }))
        .filter((entry: JsonRecord) => !criteria.persistentNamePrefix
          || entry.persistentName?.startsWith(criteria.persistentNamePrefix));
      if (candidates.length < 1) {
        throw new Error(`${criteria.label} did not resolve an exact face: ${JSON.stringify({
          criteria,
          available: (topology.result.items || []).map((entry: JsonRecord) => ({
            stableId: entry.stableId,
            owner: entry.owner,
            expectedGeometry: entry.expectedGeometry,
            topologyKind: entry.topologySignature?.kind,
            persistentName: interaction.cadUiTopologyNameFromStableId(entry.stableId),
          })),
        })}`);
      }
      const chosen = candidates[0]!;
      const opened = await agent.requestTool(token, 'cad_ui', { action: 'snapshot' },
        `pt005-${criteria.label}-selection-opened`);
      await agent.requestTool(token, 'cad_ui', {
        action: 'apply',
        expectedUiRevision: opened.uiRevision,
        actions: [{ kind: 'selection.set', entity: chosen.entry }],
        presentation: { mode: 'instant', transition: 'cut' },
      }, `pt005-${criteria.label}-selection-apply`);
      const selected = await agent.requestTool(token, 'cad_ui', { action: 'snapshot' },
        `pt005-${criteria.label}-selection-result`);
      if (selected.selection?.length !== 1 || selected.selection[0]?.stableId !== chosen.entry.stableId) {
        throw new Error(`${criteria.label} exact face was not retained as the sole UI selection`);
      }
      return JSON.parse(JSON.stringify({
        selection: selected.selection[0],
        persistentName: chosen.persistentName,
        revision: topology.revision,
      }));
    } finally {
      agent.disconnect(token);
    }
  }, input);
}

function historySelector(featureId: string): string {
  return `#bw-history .hist-item[data-sel="${featureId}"]`;
}

async function openThreadCreate(page: Page): Promise<void> {
  await clickVisible(page, '#bw-thread-open');
  await waitForDialog(page, true);
}

async function openThreadEdit(page: Page, featureId: string): Promise<void> {
  await clickVisible(page, `${historySelector(featureId)} [data-edit="${featureId}"]`);
  await waitForDialog(page, true);
}

function storedThreadSupportSnapshot(feature: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify({
    inputRefs: feature?.inputRefs,
    resultPolicy: feature?.resultPolicy,
    support: feature?.extensions?.thread?.support,
  }));
}

async function assertStoredThreadRetargetLocked(page: Page, input: {
  featureId: string;
  faceName: string;
  supportSnapshot: JsonRecord;
  label: string;
}): Promise<void> {
  const before = await projectState(page);
  await openThreadEdit(page, input.featureId);
  const capture = await page.$eval('#bw-thread-capture', (element) => {
    const control = element as HTMLButtonElement;
    const bounds = control.getBoundingClientRect();
    return {
      hidden: control.hidden,
      disabled: control.disabled,
      width: bounds.width,
      height: bounds.height,
      display: getComputedStyle(control).display,
    };
  });
  assert.equal(capture.hidden, true, `${input.label}: stored edit exposed the face Capture control`);
  assert.equal(capture.disabled, true, `${input.label}: stored edit left face Capture enabled`);
  assert.ok(capture.width === 0 || capture.height === 0 || capture.display === 'none',
    `${input.label}: stored edit retained a hit-testable face Capture control`);
  const target = await page.$eval('#bw-thread-target', (element) => element.textContent || '');
  assert.match(target, new RegExp(input.faceName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    `${input.label}: stored edit target summary changed its persistent support`);
  assert.match(target, /support locked; delete and recreate to retarget/iu,
    `${input.label}: stored edit did not explain immutable support`);

  // A synthetic event reaches the defensive handler even though ordinary
  // pointer/keyboard activation cannot reach this hidden, disabled button.
  await page.$eval('#bw-thread-capture', (element) => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  assert.match(await page.$eval('#bw-thread-error', (element) => element.textContent || ''),
    /Stored Thread support is immutable\. Delete and recreate the Thread to target another face\./u,
  `${input.label}: defensive stored-edit Capture refusal was not retained`);
  await clickVisible(page, '#bw-thread-cancel');
  await waitForDialog(page, false);
  assert.deepEqual(await projectState(page), before,
    `${input.label}: attempted stored Thread retarget changed document bytes, hash, revision, or history`);
  const part = await readPart(page);
  const feature = part.features.find((entry: JsonRecord) => entry.id === input.featureId);
  assert.deepEqual(storedThreadSupportSnapshot(feature), input.supportSnapshot,
    `${input.label}: attempted stored Thread retarget changed support recipe or feature references`);
}

async function waitForPreview(page: Page, deletion = false): Promise<void> {
  await page.waitForFunction((isDeletion) => {
    const status = document.getElementById('bw-thread-preview-status')?.textContent || '';
    const error = document.getElementById('bw-thread-error')?.textContent || '';
    return Boolean(error) || (status.includes(isDeletion ? 'Exact delete preview ready' : 'Exact preview ready')
      && !(document.getElementById('bw-thread-apply') as HTMLButtonElement | null)?.disabled);
  }, { polling: 100, timeout: 180_000 }, deletion);
  const error = await page.$eval('#bw-thread-error', (element) => element.textContent || '');
  assert.equal(error, '', `exact Thread preview failed: ${error}`);
}

function assertStoredV2Thread(feature: JsonRecord, expected: {
  faceName: string;
  name: string;
  handedness: string;
  runout: string;
  spanMode: string;
}): void {
  const recipe = feature?.extensions?.thread;
  assert.equal(feature?.type, 'thread', 'stored feature has the wrong type');
  assert.equal(feature?.name, expected.name, 'stored thread name changed');
  assert.equal(recipe?.schema, 'partmode.thread/v2', 'stored thread does not use v2');
  assert.equal(recipe?.policy, 'exact-cylindrical-face-thread-v1', 'stored thread has wrong exact policy');
  assert.equal(recipe?.threadKind, 'external', 'stored thread changed side');
  assert.equal(recipe?.designation, 'M6', 'stored thread changed size');
  assert.equal(recipe?.toleranceClass, '6g', 'stored thread changed tolerance class');
  assert.equal(recipe?.handedness, expected.handedness, 'stored thread changed handedness');
  assert.equal(recipe?.span?.mode, expected.spanMode, 'stored thread changed axial span mode');
  assert.equal(recipe?.runout?.form, expected.runout, 'stored thread changed runout');
  assert.equal(recipe?.support?.face?.name, expected.faceName, 'stored thread changed persistent face name');
  assert.ok(recipe?.support?.face?.sig && typeof recipe.support.face.sig === 'object',
    'stored thread omitted the exact face signature snapshot');
  const targetFaceRef = feature.inputRefs?.find((entry: JsonRecord) => entry.semanticPath?.role === 'target-face');
  assert.equal(targetFaceRef?.semanticPath?.name, expected.faceName,
    'canonical target-face input reference changed persistent name');
}

function assertThreadEvidence(snapshot: JsonRecord, body: JsonRecord, feature: JsonRecord,
  sourceDigest: string, faceName: string, label: string): JsonRecord {
  assert.equal(body.threadEvidence?.length, 1, `${label}: exact body does not expose one thread evidence record`);
  const evidence = body.threadEvidence[0];
  assert.equal(evidence.schema, 'partmode.thread-evidence/v1', `${label}: wrong evidence schema`);
  assert.equal(evidence.policy, 'exact-cylindrical-face-thread-v1', `${label}: wrong evidence policy`);
  assert.equal(evidence.featureId, feature.id, `${label}: evidence is bound to wrong feature`);
  assert.equal(evidence.documentHash, snapshot.canonicalHash, `${label}: evidence is stale`);
  assert.equal(evidence.sourceBrepSha256, sourceDigest, `${label}: evidence is bound to wrong source BREP`);
  assert.equal(evidence.resultBrepSha256, sha256(body.exactBrep), `${label}: evidence is bound to wrong result BREP`);
  assert.notEqual(evidence.resultBrepSha256, evidence.sourceBrepSha256,
    `${label}: modeled Thread reused source BREP`);
  assert.equal(evidence.mode, 'modeled', `${label}: evidence changed representation`);
  assert.equal(evidence.threadKind, 'external', `${label}: evidence changed thread side`);
  assert.equal(evidence.selectedFace?.name, faceName, `${label}: evidence changed selected face`);
  assert.equal(evidence.selectedFace?.signature?.topologyKind, 'cylindrical-face',
    `${label}: OCCT did not classify the selected support as cylindrical`);
  assert.equal(evidence.support?.classification, 'external', `${label}: support classification is wrong`);
  assert.equal(evidence.support?.radiusMm, 3,
    `${label}: exact evidence did not retain the nominal Ø6 source support radius`);
  assert.equal(evidence.definition?.designation, 'M6', `${label}: evidence changed designation`);
  assert.equal(evidence.definition?.toleranceClass, '6g', `${label}: evidence changed tolerance class`);
  assert.ok(evidence.definition?.resolvedSpanMm?.turnCount >= 1,
    `${label}: exact axial span did not resolve to a thread turn`);
  assert.deepEqual(evidence.resultTopology?.counts, {
    faces: body.geometry.faceCount,
    namedFaces: body.geometry.faceCount,
    edges: body.geometry.edgeCount,
    namedEdges: body.geometry.edgeCount,
    vertices: body.geometry.vertexCount,
    namedVertices: body.geometry.vertexCount,
  }, `${label}: evidence topology counts disagree with exact geometry`);
  return evidence;
}

type Vector3Tuple = [number, number, number];
const vectorSubtract = (left: Vector3Tuple, right: Vector3Tuple): Vector3Tuple =>
  [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
const vectorDot = (left: Vector3Tuple, right: Vector3Tuple): number =>
  left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
const vectorScale = (vector: Vector3Tuple, scale: number): Vector3Tuple =>
  [vector[0] * scale, vector[1] * scale, vector[2] * scale];
const vectorLength = (vector: Vector3Tuple): number => Math.hypot(...vector);
const vectorCross = (left: Vector3Tuple, right: Vector3Tuple): Vector3Tuple => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];

function assertCosmeticOverlay(overlays: JsonRecord[], expected: {
  bodyId: string;
  featureId: string;
  documentHash: string;
  handedness: 'right' | 'left';
  resolvedStartMm: number;
  resolvedEndMm: number;
  supportStartMm: number;
  supportEndMm: number;
  minimumPointCount?: number;
}): JsonRecord {
  assert.equal(overlays.length, 1, 'viewport did not expose exactly one persisted cosmetic Thread helix');
  const overlay = overlays[0];
  assert.ok(overlay, 'cosmetic Thread overlay snapshot is missing');
  assert.equal(overlay.kind, 'Line', 'cosmetic Thread representation is not a real Three.js line');
  assert.equal(overlay.featureId, expected.featureId, 'cosmetic Thread line is bound to the wrong feature');
  assert.equal(overlay.bodyId, expected.bodyId, 'cosmetic Thread line is bound to the wrong body');
  assert.equal(overlay.visible, true, 'cosmetic Thread line is not visible in the viewport');
  assert.equal(overlay.color, '#ff8a3d', 'cosmetic Thread line lost its visible viewport style');
  assert.ok(overlay.pointCount >= 33 && overlay.worldPoints.length === overlay.pointCount,
    'cosmetic Thread line has no bounded helical geometry');
  if (expected.minimumPointCount !== undefined) {
    assert.ok(overlay.pointCount >= expected.minimumPointCount,
      `cosmetic Thread line has ${overlay.pointCount} points, below ${expected.minimumPointCount}`);
  }
  assert.equal(overlay.evidence.documentHash, expected.documentHash,
    'cosmetic Thread line is not bound to the current exact document evidence');
  assert.equal(overlay.evidence.handedness, expected.handedness, 'cosmetic Thread line changed handedness');
  assert.equal(overlay.evidence.radiusMm, 3, 'cosmetic Thread line changed nominal support radius');
  assert.ok(Math.abs(overlay.evidence.spanStartMm - expected.resolvedStartMm) < 1e-8,
    'cosmetic Thread line changed resolved span start');
  assert.ok(Math.abs(overlay.evidence.spanEndMm - expected.resolvedEndMm) < 1e-8,
    'cosmetic Thread line changed resolved span end');
  assert.ok(Math.abs(overlay.evidence.supportStartMm - expected.supportStartMm) < 1e-8,
    'cosmetic Thread line changed support start');
  assert.ok(Math.abs(overlay.evidence.supportEndMm - expected.supportEndMm) < 1e-8,
    'cosmetic Thread line changed support end');
  assert.ok(Math.abs(overlay.evidence.absoluteSpanStartMm - (expected.supportStartMm + expected.resolvedStartMm)) < 1e-8,
    'cosmetic Thread line did not translate the resolved span onto the exact support station');
  assert.ok(Math.abs(overlay.evidence.absoluteSpanEndMm - (expected.supportStartMm + expected.resolvedEndMm)) < 1e-8,
    'cosmetic Thread line did not translate the resolved span end onto the exact support station');
  assert.equal(overlay.evidence.pitchMm, 1, 'cosmetic Thread line changed M6 coarse pitch');
  assert.equal(Math.sign(overlay.evidence.angleDeltaRadians), MODELED_HELIX_ANGULAR_SIGN[expected.handedness],
    'cosmetic Thread analytic evidence disagrees with the independently read modeled-helix handedness convention');
  assert.ok(Math.abs(overlay.evidence.worldAxisDirection[0]) > 0.999,
    'cosmetic Thread line did not follow the arbitrary X-axis cylindrical support');
  assert.ok(vectorLength(overlay.evidence.worldAxisPoint) > 1,
    'cosmetic Thread gate did not exercise a displaced arbitrary-axis support');

  const axisPoint = overlay.evidence.worldAxisPoint as Vector3Tuple;
  const axis = overlay.evidence.worldAxisDirection as Vector3Tuple;
  const stations: number[] = [];
  const radialVectors: Vector3Tuple[] = [];
  for (const point of overlay.worldPoints as Vector3Tuple[]) {
    const delta = vectorSubtract(point, axisPoint);
    const station = vectorDot(delta, axis);
    const radial = vectorSubtract(delta, vectorScale(axis, station));
    stations.push(station);
    radialVectors.push(radial);
    assert.ok(Math.abs(vectorLength(radial) - 3) < 2e-4,
      'cosmetic Thread world point left the exact selected cylindrical radius');
  }
  assert.ok(Math.abs(stations[0]! - (expected.supportStartMm + expected.resolvedStartMm)) < 2e-4,
    'cosmetic Thread world geometry starts outside its evidence span');
  assert.ok(Math.abs(stations.at(-1)! - (expected.supportStartMm + expected.resolvedEndMm)) < 2e-4,
    'cosmetic Thread world geometry ends outside its evidence span');
  assert.ok(vectorLength(vectorSubtract(overlay.worldPoints[0] as Vector3Tuple,
    overlay.evidence.worldAnalyticStartPoint as Vector3Tuple)) < 2e-4,
  'cosmetic Thread line does not start at its worker-evidenced analytic point');
  assert.ok(vectorLength(vectorSubtract(overlay.worldPoints.at(-1) as Vector3Tuple,
    overlay.evidence.worldAnalyticEndPoint as Vector3Tuple)) < 2e-4,
  'cosmetic Thread line does not end at its worker-evidenced analytic point');
  assert.ok(stations.every((station, index) => index === 0 || station > stations[index - 1]!),
    'cosmetic Thread world geometry does not advance monotonically on its exact axis');
  assert.ok(Math.abs((expected.resolvedEndMm - expected.resolvedStartMm) / overlay.evidence.turnCount - overlay.evidence.pitchMm) < 1e-8,
    'cosmetic Thread world geometry does not advance one pitch per turn');
  const angularStep = vectorDot(vectorCross(radialVectors[0]!, radialVectors[1]!), axis);
  assert.ok(Math.sign(angularStep) === Math.sign(overlay.evidence.angleDeltaRadians),
    'cosmetic Thread world geometry winds with the wrong handedness');
  if (expected.minimumPointCount !== undefined) {
    const samplesPerTurn = (overlay.pointCount - 1) / overlay.evidence.turnCount;
    assert.ok(Math.abs(samplesPerTurn - 48) < 1e-8,
      'cosmetic Thread renderer did not preserve 48 samples per evidenced turn');
    const oneTurnIndex = 48;
    const quarterTurnIndex = 12;
    assert.ok(Math.abs((stations[oneTurnIndex]! - stations[0]!) - overlay.evidence.pitchMm) < 2e-4,
      'cosmetic Thread world geometry does not advance one exact pitch in one rendered turn');
    assert.ok(vectorLength(vectorSubtract(radialVectors[oneTurnIndex]!, radialVectors[0]!)) < 2e-4,
      'cosmetic Thread radial phase does not close after one rendered turn');
    assert.ok(Math.abs(vectorDot(radialVectors[0]!, radialVectors[quarterTurnIndex]!)) < 2e-3,
      'cosmetic Thread radial phase collapsed before one quarter turn');
    assert.ok(vectorLength(vectorCross(radialVectors[0]!, radialVectors[quarterTurnIndex]!)) > 8.99,
      'cosmetic Thread radial phase did not sweep a real quarter turn');
  }
  return overlay;
}

function assertCosmeticEvidence(snapshot: JsonRecord, body: JsonRecord, feature: JsonRecord,
  sourceDigest: string, faceName: string, label: string): JsonRecord {
  assert.equal(body.exactBrep && sha256(body.exactBrep), sourceDigest,
    `${label}: cosmetic Thread mutated exact BREP bytes`);
  assert.equal(body.threadEvidence?.length, 1, `${label}: cosmetic Thread evidence is missing`);
  const evidence = body.threadEvidence[0];
  assert.equal(evidence.schema, 'partmode.thread-evidence/v1', `${label}: wrong evidence schema`);
  assert.equal(evidence.featureId, feature.id, `${label}: evidence is bound to wrong feature`);
  assert.equal(evidence.documentHash, snapshot.canonicalHash, `${label}: evidence is stale`);
  assert.equal(evidence.mode, 'cosmetic', `${label}: evidence changed representation`);
  assert.equal(evidence.cosmeticGeometryUnchanged, true, `${label}: cosmetic invariant is not proved`);
  assert.equal(evidence.sourceBrepSha256, sourceDigest, `${label}: source BREP digest changed`);
  assert.equal(evidence.resultBrepSha256, sourceDigest, `${label}: result BREP digest changed`);
  assert.equal(evidence.selectedFace?.name, faceName, `${label}: selected persistent face changed`);
  assert.equal(evidence.support?.radiusMm, 3, `${label}: nominal support radius changed`);
  assert.equal(evidence.definition?.designation, 'M6', `${label}: designation changed`);
  assert.equal(evidence.definition?.toleranceClass, '6g', `${label}: reference choice changed`);
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
  const browserVersion = await browser.version();
  assert.match(browserVersion, /Chrome\//u, 'Puppeteer did not launch real Chrome');
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1800, height: 1200, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('bw-studio-welcome-v1', '1');
    (window as any).__pt005Injected = false;
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
  assert.equal(response?.status(), 200, 'PT005 UI route did not return HTTP 200');
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  if (await page.$eval('#pm-cookie-banner', (element) => !(element as HTMLElement).hidden)) {
    await clickVisible(page, '#pm-cookie-essential');
  }
  await clickVisible(page, '[data-workspace="solid"]');
  await assertHitTestable(page, '#bw-thread-open');

  const registry = await page.evaluate(async () => {
    const studioScript = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
    if (!studioScript) throw new Error('Studio module URL is missing');
    const module = await import(new URL('studio-v6-ui-registry.js', studioScript.src).href);
    return module.CAD_UI_CONTROL_REGISTRY.filter((entry: JsonRecord) => entry.id === 'model.thread');
  });
  assert.equal(registry.length, 1, 'model.thread is not uniquely registered');
  assert.equal(registry[0].adapter, 'available', 'model.thread is not available');
  assert.deepEqual(registry[0].operationKinds, ['feature.thread', 'feature.update', 'feature.delete'],
    'model.thread advertises wrong typed operations');
  assert.deepEqual(registry[0].fields.map((entry: JsonRecord) => entry.id), [
    'name', 'targetFace', 'mode', 'threadKind', 'designation', 'handedness', 'toleranceClass',
    'spanMode', 'spanStart', 'spanEnd', 'runout',
  ], 'model.thread field contract is incomplete');

  const seedBefore = await projectState(page);
  await page.evaluate(async (fixture) => {
    await (window as any).__bwStudio.commitHumanOperationsForTest('Seed exact M6 shaft for PT005 UI', [
      { kind: 'project.clear', input: {} },
      { kind: 'project.rename', input: { name: fixture.projectName } },
      {
        kind: 'sketch.constrained.create',
        input: {
          id: 'sketch-ui-thread-shaft',
          name: 'Displaced YZ M6 shaft profile',
          plane: 'YZ',
          z: 7,
          constrained: {
            entities: [
              { id: 'point-ui-thread-center', kind: 'point', at: [4, -2], fixed: true },
              { id: 'circle-ui-thread-shaft', kind: 'circle', center: 'point-ui-thread-center', r: 3 },
            ],
            constraints: [],
            blockInstances: [],
            relations: [],
          },
        },
      },
      {
        kind: 'feature.extrude',
        input: {
          id: fixture.featureId,
          name: 'Exact M6 cylindrical shaft',
          sketchId: 'sketch-ui-thread-shaft', plane: 'YZ', height: 12,
          resultPolicy: { kind: 'new-body', bodyName: 'M6 thread shaft' },
        },
      },
    ]);
  }, { featureId: SOURCE_FEATURE_ID, projectName: PROJECT_NAME });
  await waitForSettlement(page);
  assert.ok((await projectState(page)).commandRevision > seedBefore.commandRevision,
    'shaft seed did not advance the command revision');
  const baselineSnapshot = await isolatedExact(page);
  const baselineBody = exactBody(baselineSnapshot, SOURCE_BODY_ID, 'external shaft baseline');
  assert.equal(baselineBody.geometry.faceCount, 3, 'shaft baseline is not an exact simple cylinder');
  assert.deepEqual(baselineBody.geometry.bounds[1].map((value: number, index: number) =>
    Number((value - baselineBody.geometry.bounds[0][index]).toFixed(6))).sort((left: number, right: number) => left - right),
  [6, 6, 12], 'visible/source support is not a displaced arbitrary-axis nominal Ø6 cylinder');
  const sourceDigest = sha256(baselineBody.exactBrep);

  const selected = await selectCylindricalFaceThroughViewport(page, SOURCE_BODY_ID);
  assert.equal(selected.revision, (await projectState(page)).commandRevision,
    'selected cylindrical topology was not current-revision-bound');

  const beforeCancel = await projectState(page);
  await openThreadCreate(page);
  for (const selector of [
    '#bw-thread-name', '#bw-thread-kind', '#bw-thread-mode', '#bw-thread-size', '#bw-thread-handedness',
    '#bw-thread-tolerance', '#bw-thread-span-mode', '#bw-thread-span-start', '#bw-thread-span-end',
    '#bw-thread-runout', '#bw-thread-capture', '#bw-thread-preview', '#bw-thread-cancel',
  ]) await assertHitTestable(page, selector);
  assert.match(await page.$eval('#bw-thread-target', (element) => element.textContent || ''),
    new RegExp(selected.persistentName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    'visible target summary omitted the persistent cylindrical-face name');
  await selectValue(page, '#bw-thread-kind', 'internal');
  assert.equal(await page.$eval('#bw-thread-tolerance', (element) => (element as HTMLSelectElement).value), '6H',
    'internal visible draft did not bind tolerance class 6H');
  await replaceValue(page, '#bw-thread-name', 'Cancelled internal thread draft');
  assert.deepEqual(await projectState(page), beforeCancel,
    'visible Thread draft mutated document bytes, hash, revision, or history');
  await clickVisible(page, '#bw-thread-cancel');
  await waitForDialog(page, false);
  assert.deepEqual(await projectState(page), beforeCancel, 'Cancel mutated the authoritative Thread document');

  // Closing a dialog while its exact preview is still in flight must reset
  // its controls immediately. The stale run may finish after a new session is
  // open, but it must not disable, unlock, publish, or orphan anything there.
  const beforeInFlightClose = await projectState(page);
  await openThreadCreate(page);
  await replaceValue(page, '#bw-thread-name', 'Escape an in-flight exact Thread preview');
  await selectValue(page, '#bw-thread-kind', 'external');
  await selectValue(page, '#bw-thread-mode', 'modeled');
  await selectValue(page, '#bw-thread-size', 'M6');
  await selectValue(page, '#bw-thread-span-mode', 'fraction');
  await replaceValue(page, '#bw-thread-span-start', '0.1');
  await replaceValue(page, '#bw-thread-span-end', '0.35');
  await selectValue(page, '#bw-thread-runout', 'full-profile');
  await page.evaluate(() => (window as any).__bwStudio.delayNextKernelReply(1200));
  await clickVisible(page, '#bw-thread-preview');
  await page.waitForFunction(() =>
    (document.getElementById('bw-thread-preview') as HTMLButtonElement | null)?.disabled === true
      && (document.getElementById('bw-thread-delete') as HTMLButtonElement | null)?.disabled === true,
  { polling: 25, timeout: 10_000 });
  await page.keyboard.press('Escape');
  await waitForDialog(page, false);
  assert.deepEqual(await projectState(page), beforeInFlightClose,
    'Escape during an in-flight Thread preview mutated the authoritative document');
  assert.equal(await page.$eval('#bw-thread-preview', (element) => (element as HTMLButtonElement).disabled), false,
    'closing an in-flight Thread preview left Preview disabled');
  assert.equal(await page.$eval('#bw-thread-delete', (element) => (element as HTMLButtonElement).disabled), false,
    'closing an in-flight Thread preview left Preview delete disabled');

  await openThreadCreate(page);
  assert.equal(await page.$eval('#bw-thread-preview', (element) => (element as HTMLButtonElement).disabled), false,
    'reopened Thread dialog inherited a disabled Preview control');
  assert.equal(await page.$eval('#bw-thread-delete', (element) => (element as HTMLButtonElement).disabled), false,
    'reopened Thread dialog inherited a disabled Preview delete control');
  await replaceValue(page, '#bw-thread-name', 'Reopened exact Thread preview');
  await selectValue(page, '#bw-thread-kind', 'external');
  await selectValue(page, '#bw-thread-mode', 'modeled');
  await selectValue(page, '#bw-thread-size', 'M6');
  await selectValue(page, '#bw-thread-span-mode', 'fraction');
  await replaceValue(page, '#bw-thread-span-start', '0.1');
  await replaceValue(page, '#bw-thread-span-end', '0.35');
  await selectValue(page, '#bw-thread-runout', 'full-profile');
  await clickVisible(page, '#bw-thread-preview');
  await waitForPreview(page);
  await clickVisible(page, '#bw-thread-cancel');
  await waitForDialog(page, false);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
  assert.deepEqual(await projectState(page), beforeInFlightClose,
    'reopened Preview then Cancel mutated the document after a stale run completed');
  assert.deepEqual(await page.evaluate(() => (window as any).__bwStudio.agentPreviewIds()), [],
    'in-flight close/reopen left an orphan exact preview');
  assert.equal((await page.evaluate(() => (window as any).__bwStudio.detachedPreviewForTest()))?.activePreviewVisible,
    false, 'in-flight close/reopen leaked detached viewport geometry');

  // An authoritative edit does not change the dialog's local draft token.
  // Delay the detached exact render until a real document mutation lands and
  // prove the old candidate can never be published as a current visual.
  const beforeAuthoritativeRace = await projectState(page);
  await openThreadCreate(page);
  await replaceValue(page, '#bw-thread-name', 'Stale after authoritative mutation');
  await selectValue(page, '#bw-thread-kind', 'external');
  await selectValue(page, '#bw-thread-mode', 'modeled');
  await selectValue(page, '#bw-thread-size', 'M6');
  await selectValue(page, '#bw-thread-span-mode', 'fraction');
  await replaceValue(page, '#bw-thread-span-start', '0.1');
  await replaceValue(page, '#bw-thread-span-end', '0.35');
  await selectValue(page, '#bw-thread-runout', 'full-profile');
  await page.evaluate(() => (window as any).__bwStudio.delayNextIsolatedKernelReply(1500));
  await clickVisible(page, '#bw-thread-preview');
  await page.waitForFunction(() => (window as any).__bwStudio.isolatedKernelPendingForTest() === 1,
    { polling: 25, timeout: 60_000 });
  await page.evaluate(async () => {
    await (window as any).__bwStudio.commitHumanOperationsForTest('Concurrent authoritative parameter mutation', [{
      kind: 'parameter.create',
      input: { id: 'parameter-thread-preview-race', name: 'thread_preview_race', value: 42 },
    }]);
  });
  await page.waitForFunction(() => {
    const error = document.getElementById('bw-thread-error')?.textContent || '';
    return /project changed while the exact Thread preview was rendering/iu.test(error)
      && (document.getElementById('bw-thread-apply') as HTMLButtonElement | null)?.disabled === true
      && (document.getElementById('bw-thread-preview') as HTMLButtonElement | null)?.disabled === false;
  }, { polling: 50, timeout: 180_000 });
  await waitForSettlement(page);
  const afterAuthoritativeRace = await projectState(page);
  assert.ok(afterAuthoritativeRace.commandRevision > beforeAuthoritativeRace.commandRevision,
    'concurrent authoritative mutation did not advance the document revision');
  assert.notEqual(afterAuthoritativeRace.canonicalHash, beforeAuthoritativeRace.canonicalHash,
    'concurrent authoritative mutation did not change the canonical document');
  assert.equal((await readDocument(page)).parameters.find((entry: JsonRecord) =>
    entry.id === 'parameter-thread-preview-race')?.value, 42,
  'stale Thread render rolled back the concurrent authoritative mutation');
  assert.equal((await page.evaluate(() => (window as any).__bwStudio.detachedPreviewForTest()))?.activePreviewVisible,
    false, 'stale exact Thread render published detached viewport geometry');
  assert.deepEqual(await page.evaluate(() => (window as any).__bwStudio.agentPreviewIds()), [],
    'stale exact Thread render retained an orphan service preview');
  assert.equal(await page.evaluate(() => (window as any).__bwStudio.isolatedKernelPendingForTest()), 0,
    'stale isolated Thread render remained pending after refusal');
  await clickVisible(page, '#bw-thread-cancel');
  await waitForDialog(page, false);
  const reselectedAfterMutation = await selectCylindricalFaceThroughViewport(page, SOURCE_BODY_ID);
  assert.equal(reselectedAfterMutation.persistentName, selected.persistentName,
    'authoritative non-geometric mutation changed the selected cylindrical-face identity');

  const beforePreview = await projectState(page);
  await openThreadCreate(page);
  await replaceValue(page, '#bw-thread-name', THREAD_NAME);
  await selectValue(page, '#bw-thread-kind', 'external');
  await selectValue(page, '#bw-thread-mode', 'modeled');
  await selectValue(page, '#bw-thread-size', 'M6');
  await selectValue(page, '#bw-thread-handedness', 'left');
  await selectValue(page, '#bw-thread-span-mode', 'fraction');
  await replaceValue(page, '#bw-thread-span-start', '0.1');
  await replaceValue(page, '#bw-thread-span-end', '0.35');
  await selectValue(page, '#bw-thread-runout', 'full-profile');

  // A human can keep editing while the exact worker is busy. The completed
  // response must be cancelled rather than attached to the newer visible
  // values, and Apply must stay disabled.
  await replaceValue(page, '#bw-thread-name', 'Stale in-flight Thread draft');
  await page.evaluate(() => (window as any).__bwStudio.delayNextKernelReply(500));
  await clickVisible(page, '#bw-thread-preview');
  await replaceValue(page, '#bw-thread-name', THREAD_NAME);
  await page.waitForFunction(() => {
    const error = document.getElementById('bw-thread-error')?.textContent || '';
    return /draft changed|values changed/iu.test(error)
      && (document.getElementById('bw-thread-apply') as HTMLButtonElement | null)?.disabled === true;
  }, { polling: 100, timeout: 180_000 });
  assert.deepEqual(await projectState(page), beforePreview,
    'stale in-flight Thread preview mutated document bytes, hash, revision, or history');
  assert.equal((await page.evaluate(() => (window as any).__bwStudio.detachedPreviewForTest()))?.activePreviewVisible,
    false, 'stale in-flight Thread preview leaked detached viewport geometry');

  // A completed exact preview is still only a disposable draft. Cancel must
  // remove its detached geometry and leave authoritative history untouched.
  await clickVisible(page, '#bw-thread-preview');
  await waitForPreview(page);
  assert.deepEqual(await projectState(page), beforePreview,
    'exact Thread preview mutated document bytes, hash, revision, or history');
  const disposablePreview = await page.evaluate(() => (window as any).__bwStudio.detachedPreviewForTest());
  assert.equal(disposablePreview?.activePreviewVisible, true, 'exact Thread preview is not visible in the viewport');
  assert.equal(disposablePreview?.detachedExactGeometry, true, 'visible Thread preview is not exact geometry');
  assert.equal(disposablePreview?.renderedBodyCount, 1, 'visible Thread preview did not render one exact body');
  await clickVisible(page, '#bw-thread-cancel');
  await waitForDialog(page, false);
  assert.deepEqual(await projectState(page), beforePreview, 'Preview then Cancel mutated the Thread document');
  assert.equal((await page.evaluate(() => (window as any).__bwStudio.detachedPreviewForTest()))?.activePreviewVisible,
    false, 'Preview then Cancel leaked detached viewport geometry');

  await openThreadCreate(page);
  await replaceValue(page, '#bw-thread-name', THREAD_NAME);
  await selectValue(page, '#bw-thread-kind', 'external');
  await selectValue(page, '#bw-thread-mode', 'modeled');
  await selectValue(page, '#bw-thread-size', 'M6');
  await selectValue(page, '#bw-thread-handedness', 'left');
  await selectValue(page, '#bw-thread-span-mode', 'fraction');
  await replaceValue(page, '#bw-thread-span-start', '0.1');
  await replaceValue(page, '#bw-thread-span-end', '0.35');
  await selectValue(page, '#bw-thread-runout', 'full-profile');
  await clickVisible(page, '#bw-thread-preview');
  await waitForPreview(page);
  await clickVisible(page, '#bw-thread-apply');
  await waitForDialog(page, false);
  await waitForSettlement(page);

  let part = await readPart(page);
  let feature = part.features.find((entry: JsonRecord) => entry.type === 'thread');
  assertStoredV2Thread(feature, {
    faceName: selected.persistentName, name: THREAD_NAME, handedness: 'left',
    runout: 'full-profile', spanMode: 'fraction',
  });
  const threadId = feature.id;
  assert.equal(feature.extensions.thread.span.start, 0.1, 'stored fractional span start changed');
  assert.equal(feature.extensions.thread.span.end, 0.35, 'stored fractional span end changed');
  const createdSnapshot = await isolatedExact(page);
  const createdBody = exactBody(createdSnapshot, SOURCE_BODY_ID, 'visible external Thread create');
  assertThreadEvidence(createdSnapshot, createdBody, feature, sourceDigest, selected.persistentName,
    'visible external Thread create');

  assert.equal(await page.$eval('#bw-project-name', (element) => element.textContent), PROJECT_NAME,
    'HTML-like project name was not rendered literally');
  assert.ok((await page.$eval(`${historySelector(threadId)} .hi-n`, (element) => element.textContent || '')).includes(THREAD_NAME),
    'HTML-like Thread name was not rendered literally');
  assert.equal(await page.$$eval('img[src="x"], svg[onload]', (elements) => elements.length), 0,
    'HTML-like project or Thread name created executable markup');
  assert.equal(await page.evaluate(() => (window as any).__pt005Injected), false,
    'HTML-like project or Thread name executed script');

  await page.evaluate(() => (window as any).__bwStudio.flushStorage());
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  part = await readPart(page);
  feature = part.features.find((entry: JsonRecord) => entry.id === threadId);
  assertStoredV2Thread(feature, {
    faceName: selected.persistentName, name: THREAD_NAME, handedness: 'left',
    runout: 'full-profile', spanMode: 'fraction',
  });

  const immutableSupport = storedThreadSupportSnapshot(feature);
  await page.evaluate(async (fixture) => {
    await (window as any).__bwStudio.commitHumanOperationsForTest('Seed unrelated exact body for Thread retarget refusal', [{
      kind: 'feature.extrude',
      input: {
        id: fixture.featureId,
        name: 'Unrelated exact cylindrical body',
        sketch: { shapes: [{ id: 'circle-ui-thread-unrelated', kind: 'circle', x: 24, y: 18, r: 2 }], z: 30 },
        plane: 'XY',
        height: 5,
        resultPolicy: { kind: 'new-body', bodyName: 'Unrelated exact cylinder' },
      },
    }]);
  }, { featureId: SECOND_FEATURE_ID });
  await waitForSettlement(page);
  const unrelatedFace = await selectExactTopologyFace(page, {
    bodyId: SECOND_BODY_ID,
    label: 'unrelated-body-face',
    expectedGeometry: 'cylinder',
  });
  assert.equal(unrelatedFace.selection.owner?.id, SECOND_BODY_ID,
    'unrelated-body retarget refusal did not begin from the second exact body');
  await assertStoredThreadRetargetLocked(page, {
    featureId: threadId,
    faceName: selected.persistentName,
    supportSnapshot: immutableSupport,
    label: 'unrelated-body selection',
  });

  const featureOwnedFace = await selectExactTopologyFace(page, {
    bodyId: SOURCE_BODY_ID,
    label: 'feature-owned-face',
    persistentNamePrefix: `F${threadId}:`,
  });
  assert.ok(featureOwnedFace.persistentName.startsWith(`F${threadId}:`),
    'feature-owned retarget refusal did not begin from a Thread-generated exact face');
  await assertStoredThreadRetargetLocked(page, {
    featureId: threadId,
    faceName: selected.persistentName,
    supportSnapshot: immutableSupport,
    label: 'feature-owned face selection',
  });

  const beforeEditCancel = await projectState(page);
  await openThreadEdit(page, threadId);
  assert.equal(await page.$eval('#bw-thread', (element) => (element as HTMLElement).dataset.schema),
    'partmode.thread/v2', 'saved Thread did not reopen in the current editor');
  await replaceValue(page, '#bw-thread-span-end', '0.7');
  await selectValue(page, '#bw-thread-runout', 'one-pitch-taper');
  await clickVisible(page, '#bw-thread-cancel');
  await waitForDialog(page, false);
  assert.deepEqual(await projectState(page), beforeEditCancel, 'v2 edit Cancel changed the authoritative document');

  const beforeEditPreview = await projectState(page);
  await openThreadEdit(page, threadId);
  await selectValue(page, '#bw-thread-handedness', 'right');
  await selectValue(page, '#bw-thread-span-mode', 'offset');
  await replaceValue(page, '#bw-thread-span-start', '1');
  await replaceValue(page, '#bw-thread-span-end', '4');
  await selectValue(page, '#bw-thread-runout', 'full-profile');
  await clickVisible(page, '#bw-thread-preview');
  await waitForPreview(page);
  assert.deepEqual(await projectState(page), beforeEditPreview, 'v2 exact edit preview mutated the document');
  await clickVisible(page, '#bw-thread-apply');
  await waitForDialog(page, false);
  await waitForSettlement(page);
  part = await readPart(page);
  feature = part.features.find((entry: JsonRecord) => entry.id === threadId);
  assertStoredV2Thread(feature, {
    faceName: selected.persistentName, name: THREAD_NAME, handedness: 'right',
    runout: 'full-profile', spanMode: 'offset',
  });
  assert.deepEqual(feature.extensions.thread.span, { mode: 'offset', startMm: 1, endMm: 4 },
    'stored offset axial span changed');
  const editedSnapshot = await isolatedExact(page);
  const editedBody = exactBody(editedSnapshot, SOURCE_BODY_ID, 'visible external Thread edit');
  const editedEvidence = assertThreadEvidence(editedSnapshot, editedBody, feature, sourceDigest,
    selected.persistentName, 'visible external Thread edit');
  assert.equal(editedEvidence.definition.handedness, 'right', 'edited evidence changed handedness');
  assert.equal(editedEvidence.definition.runout.form, 'full-profile', 'edited evidence changed runout');
  assert.deepEqual(editedEvidence.definition.requestedSpan, { mode: 'offset', startMm: 1, endMm: 4 },
    'edited evidence changed requested axial span');

  const beforeDeletePreview = await projectState(page);
  await openThreadEdit(page, threadId);
  await clickVisible(page, '#bw-thread-delete');
  await waitForPreview(page, true);
  assert.deepEqual(await projectState(page), beforeDeletePreview, 'exact delete preview mutated the Thread document');
  await clickVisible(page, '#bw-thread-apply');
  await waitForDialog(page, false);
  await waitForSettlement(page);
  part = await readPart(page);
  assert.equal(part.features.some((entry: JsonRecord) => entry.id === threadId), false,
    'visible exact delete did not remove the Thread feature');
  const deletedSnapshot = await isolatedExact(page);
  const restoredBody = exactBody(deletedSnapshot, SOURCE_BODY_ID, 'visible Thread delete');
  assert.equal(restoredBody.exactBrep, baselineBody.exactBrep, 'Thread delete did not restore exact source BREP');
  assert.deepEqual(restoredBody.threadEvidence || [], [], 'Thread delete retained stale evidence');
  assert.deepEqual(await page.evaluate(() => (window as any).__bwStudio.cosmeticThreadOverlaysForTest()), [],
    'modeled Thread delete left a cosmetic viewport artifact');

  // Cosmetic is a real viewport representation backed by the same current
  // exact topology evidence. It must never mutate the solid, and its helix
  // must survive reload, update from an edit, and disappear on delete.
  const cosmeticSelected = await selectCylindricalFaceThroughViewport(page, SOURCE_BODY_ID);
  await openThreadCreate(page);
  await replaceValue(page, '#bw-thread-name', 'Visible cosmetic M6 reference');
  await selectValue(page, '#bw-thread-kind', 'external');
  await selectValue(page, '#bw-thread-mode', 'cosmetic');
  await selectValue(page, '#bw-thread-size', 'M6');
  await selectValue(page, '#bw-thread-handedness', 'left');
  await selectValue(page, '#bw-thread-span-mode', 'fraction');
  await replaceValue(page, '#bw-thread-span-start', '0');
  await replaceValue(page, '#bw-thread-span-end', '1');
  await selectValue(page, '#bw-thread-runout', 'one-pitch-taper');
  await clickVisible(page, '#bw-thread-preview');
  await waitForPreview(page);
  const cosmeticPreview = await page.evaluate(() => (window as any).__bwStudio.detachedPreviewForTest());
  assert.equal(cosmeticPreview?.detachedExactGeometry, true,
    'cosmetic Thread Preview is not bound to an exact detached rebuild');
  assert.equal(cosmeticPreview?.cosmeticThreadLineCount, 1,
    'cosmetic Thread Preview did not render its worker-evidenced helix');
  await clickVisible(page, '#bw-thread-apply');
  await waitForDialog(page, false);
  await waitForSettlement(page);

  part = await readPart(page);
  let cosmeticFeature = part.features.find((entry: JsonRecord) => entry.type === 'thread');
  assertStoredV2Thread(cosmeticFeature, {
    faceName: cosmeticSelected.persistentName, name: 'Visible cosmetic M6 reference', handedness: 'left',
    runout: 'one-pitch-taper', spanMode: 'fraction',
  });
  assert.equal(cosmeticFeature.extensions.thread.mode, 'cosmetic', 'visible cosmetic Apply stored modeled mode');
  const cosmeticId = cosmeticFeature.id;
  const cosmeticSnapshot = await isolatedExact(page);
  const cosmeticBody = exactBody(cosmeticSnapshot, SOURCE_BODY_ID, 'visible cosmetic Thread create');
  const cosmeticEvidence = assertCosmeticEvidence(cosmeticSnapshot, cosmeticBody, cosmeticFeature, sourceDigest,
    cosmeticSelected.persistentName, 'visible cosmetic Thread create');
  assert.ok(Math.abs(cosmeticEvidence.support.axialBoundsMm.start - 7) < 1e-8
    && Math.abs(cosmeticEvidence.support.axialBoundsMm.end - 19) < 1e-8
    && Math.abs(cosmeticEvidence.support.axialBoundsMm.length - 12) < 1e-8,
  'cosmetic evidence did not retain the displaced arbitrary-axis support interval');
  assert.ok(Math.abs(cosmeticEvidence.definition.resolvedSpanMm.start) < 1e-8
    && Math.abs(cosmeticEvidence.definition.resolvedSpanMm.end - 12) < 1e-8
    && Math.abs(cosmeticEvidence.definition.resolvedSpanMm.length - 12) < 1e-8
    && Math.abs(cosmeticEvidence.definition.resolvedSpanMm.turnCount - 12) < 1e-8
    && cosmeticEvidence.definition.resolvedSpanMm.fullTurnCount === 12,
  'cosmetic evidence changed the full-support twelve-turn span');
  const createdCosmeticOverlay = assertCosmeticOverlay(
    await page.evaluate(() => (window as any).__bwStudio.cosmeticThreadOverlaysForTest()),
    {
      bodyId: SOURCE_BODY_ID, featureId: cosmeticId, documentHash: cosmeticSnapshot.canonicalHash,
      handedness: 'left', resolvedStartMm: 0, resolvedEndMm: 12, supportStartMm: 7, supportEndMm: 19,
      minimumPointCount: 514,
    },
  );

  await page.evaluate(() => (window as any).__bwStudio.flushStorage());
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  const reloadedCosmeticOverlay = assertCosmeticOverlay(
    await page.evaluate(() => (window as any).__bwStudio.cosmeticThreadOverlaysForTest()),
    {
      bodyId: SOURCE_BODY_ID, featureId: cosmeticId, documentHash: cosmeticSnapshot.canonicalHash,
      handedness: 'left', resolvedStartMm: 0, resolvedEndMm: 12, supportStartMm: 7, supportEndMm: 19,
      minimumPointCount: 514,
    },
  );
  assert.deepEqual(reloadedCosmeticOverlay.worldPoints, createdCosmeticOverlay.worldPoints,
    'save/reload changed cosmetic Thread viewport geometry');

  await openThreadEdit(page, cosmeticId);
  await selectValue(page, '#bw-thread-handedness', 'right');
  await selectValue(page, '#bw-thread-span-mode', 'offset');
  await replaceValue(page, '#bw-thread-span-start', '2');
  await replaceValue(page, '#bw-thread-span-end', '5');
  await clickVisible(page, '#bw-thread-preview');
  await waitForPreview(page);
  assert.equal((await page.evaluate(() => (window as any).__bwStudio.detachedPreviewForTest()))?.cosmeticThreadLineCount, 1,
    'cosmetic Thread edit Preview did not update its visible helix');
  await clickVisible(page, '#bw-thread-apply');
  await waitForDialog(page, false);
  await waitForSettlement(page);
  part = await readPart(page);
  cosmeticFeature = part.features.find((entry: JsonRecord) => entry.id === cosmeticId);
  assertStoredV2Thread(cosmeticFeature, {
    faceName: cosmeticSelected.persistentName, name: 'Visible cosmetic M6 reference', handedness: 'right',
    runout: 'one-pitch-taper', spanMode: 'offset',
  });
  const editedCosmeticSnapshot = await isolatedExact(page);
  const editedCosmeticBody = exactBody(editedCosmeticSnapshot, SOURCE_BODY_ID, 'visible cosmetic Thread edit');
  assertCosmeticEvidence(editedCosmeticSnapshot, editedCosmeticBody, cosmeticFeature, sourceDigest,
    cosmeticSelected.persistentName, 'visible cosmetic Thread edit');
  const editedCosmeticOverlay = assertCosmeticOverlay(
    await page.evaluate(() => (window as any).__bwStudio.cosmeticThreadOverlaysForTest()),
    {
      bodyId: SOURCE_BODY_ID, featureId: cosmeticId, documentHash: editedCosmeticSnapshot.canonicalHash,
      handedness: 'right', resolvedStartMm: 2, resolvedEndMm: 5, supportStartMm: 7, supportEndMm: 19,
    },
  );
  assert.notDeepEqual(editedCosmeticOverlay.worldPoints[0], createdCosmeticOverlay.worldPoints[0],
    'cosmetic Thread edit did not move the visible bounded helix');

  await openThreadEdit(page, cosmeticId);
  await clickVisible(page, '#bw-thread-delete');
  await waitForPreview(page, true);
  assert.equal((await page.evaluate(() => (window as any).__bwStudio.detachedPreviewForTest()))?.cosmeticThreadLineCount, 0,
    'cosmetic Thread delete Preview retained the removed helix');
  await clickVisible(page, '#bw-thread-apply');
  await waitForDialog(page, false);
  await waitForSettlement(page);
  assert.deepEqual(await page.evaluate(() => (window as any).__bwStudio.cosmeticThreadOverlaysForTest()), [],
    'cosmetic Thread delete left its viewport helix behind');
  const deletedCosmeticSnapshot = await isolatedExact(page);
  const deletedCosmeticBody = exactBody(deletedCosmeticSnapshot, SOURCE_BODY_ID, 'visible cosmetic Thread delete');
  assert.equal(deletedCosmeticBody.exactBrep, baselineBody.exactBrep,
    'cosmetic Thread delete did not retain exact source BREP');
  assert.deepEqual(deletedCosmeticBody.threadEvidence || [], [],
    'cosmetic Thread delete retained stale exact evidence');

  assert.deepEqual(failures, [], `browser emitted errors: ${failures.join('\n')}`);
  console.log(JSON.stringify({
    schema: 'partmode.thread-ui-smoke/v2',
    browser: browserVersion,
    selection: {
      source: 'real viewport click over current exact topology inventory',
      bodyId: SOURCE_BODY_ID,
      faceName: selected.persistentName,
      topologyRevision: selected.revision,
    },
    lifecycle: ['cancel', 'exact-preview', 'human-apply', 'save-reload', 'edit-cancel', 'edit-apply', 'delete'],
    v2: {
      schema: 'partmode.thread/v2', threadKindsVisible: ['external', 'internal'],
      toleranceClassesVisible: ['6g', '6H'], runoutFormsVisible: ['full-profile', 'one-pitch-taper'],
      sourceDigest, createdResultDigest: sha256(createdBody.exactBrep), editedResultDigest: sha256(editedBody.exactBrep),
      exactEvidence: true, completePersistentTopology: true,
    },
    cosmeticViewport: {
      kind: 'Three.js Line', arbitraryAxis: true, displacedSupport: true, pitchMm: 1,
      fullSupportTurns: 12, createdPointCount: createdCosmeticOverlay.pointCount,
      nonCollapsedRadialPhase: true, modeledHandednessConvention: 'right-positive; left-negative dtheta/dz',
      lifecycle: ['apply', 'save-reload', 'edit', 'delete'], exactBrepUnchanged: true,
    },
    immutableStoredSupport: ['unrelated-body-face', 'thread-feature-owned-face'],
    literalSafeNames: true,
    browserErrors: failures.length,
  }, null, 2));
} finally {
  await browser?.close();
  await local?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
