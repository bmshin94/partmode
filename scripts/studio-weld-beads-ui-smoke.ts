import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import puppeteer, { type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-weld-bead-ui-'));
const MEMBER_A_ID = 'ui-weld-member-a';
const MEMBER_B_ID = 'ui-weld-member-b';
const MEMBER_A_BODY_ID = 'body-' + MEMBER_A_ID;
const MEMBER_B_BODY_ID = 'body-' + MEMBER_B_ID;
const HTML_LIKE_BEAD_NAME = '<img src=x onerror="window.__wd003Injected=true"> Exact bead';

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
  }, { polling: 100, timeout: 180_000 });
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
    (document.getElementById('bw-weld-bead') as HTMLDialogElement | null)?.open === expectedOpen,
  { polling: 50, timeout: 180_000 }, open);
}

async function openCreateDialog(page: Page): Promise<void> {
  await clickVisible(page, '#bw-weld-bead-open');
  await waitForDialog(page, true);
  assert.equal(await page.$eval('#bw-weld-bead', (dialog) => (dialog as HTMLElement).dataset.featureId || ''), '',
    'ribbon command opened weld-bead edit mode instead of create mode');
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

async function exactCurrent(page: Page, label: string): Promise<JsonRecord> {
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
  return evidence;
}

function exactBody(evidence: JsonRecord, bodyId: string, label: string): JsonRecord {
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
  return body;
}

async function selectExactWeldSupports(page: Page): Promise<JsonRecord> {
  return page.evaluate(async (fixture) => {
    const studio = (window as any).__bwStudio;
    const partmodeAgent = (window as any).partmodeAgent;
    const connection = await studio.connectAgentForTest({
      clientLabel: 'WD003 topology selector',
      mode: 'read-only',
      permissionContext: { granted: ['project.read', 'ui.read', 'ui.select', 'ui.command-draft'] },
    });
    const token = connection.connectionToken;
    let requestSequence = 0;
    const request = (tool: string, args: JsonRecord) => partmodeAgent.requestTool(
      token, tool, args, `wd003-ui-${++requestSequence}`,
    );
    try {
      const [queryA, queryB] = await Promise.all([
        request('cad_query', { query: { kind: 'geometry.topology', bodyId: fixture.bodyAId, limit: 250 } }),
        request('cad_query', { query: { kind: 'geometry.topology', bodyId: fixture.bodyBId, limit: 250 } }),
      ]);
      const distance = (left: number[] | undefined, right: number[]) => Array.isArray(left) && left.length === 3
        ? Math.hypot(...left.map((value, index) => value - (right[index] ?? Number.NaN)))
        : Number.POSITIVE_INFINITY;
      const dot = (left: number[] | undefined, right: number[]) => Array.isArray(left) && left.length === 3
        ? left.reduce((sum, value, index) => sum + value * (right[index] ?? Number.NaN), 0)
        : Number.NEGATIVE_INFINITY;
      const one = (items: JsonRecord[], description: string, predicate: (entry: JsonRecord) => boolean) => {
        const matches = items.filter(predicate);
        if (matches.length !== 1) throw new Error(`${description} resolved ${matches.length} candidates: ${JSON.stringify(items)}`);
        return matches[0]!;
      };
      for (const [label, query, bodyId] of [['A', queryA, fixture.bodyAId], ['B', queryB, fixture.bodyBId]]) {
        if (query.revision !== studio.commandRevision() || query.result?.exactGeometry !== true
          || query.result?.items?.some((entry: JsonRecord) => entry.owner?.id !== bodyId)) {
          throw new Error(`support ${label} topology query is stale or not exact: ${JSON.stringify({
            queryRevision: query.revision,
            commandRevision: studio.commandRevision(),
            documentRevision: studio.documentRevision(),
            exactGeometry: query.result?.exactGeometry,
            requestedBodyId: bodyId,
            ownerIds: [...new Set((query.result?.items || []).map((entry: JsonRecord) => entry.owner?.id))],
          })}`);
        }
      }
      const itemsA = queryA.result.items as JsonRecord[];
      const itemsB = queryB.result.items as JsonRecord[];
      const faceA = one(itemsA, 'support A face', (entry) => entry.topologySignature?.kind === 'face'
        && entry.expectedGeometry === 'plane' && distance(entry.topologySignature.p, [0, 10, 50]) < 0.05
        && dot(entry.topologySignature.n, [0, 1, 0]) > 0.999);
      const edgeA = one(itemsA, 'support A edge', (entry) => entry.topologySignature?.kind === 'edge'
        && entry.expectedGeometry === 'line' && distance(entry.topologySignature.p, [5, 10, 50]) < 0.05
        && Math.abs(Number(entry.topologySignature.l) - 100) < 0.05);
      const faceB = one(itemsB, 'support B face', (entry) => entry.topologySignature?.kind === 'face'
        && entry.expectedGeometry === 'plane' && distance(entry.topologySignature.p, [5, 20, 50]) < 0.05
        && dot(entry.topologySignature.n, [-1, 0, 0]) > 0.999);
      const edgeB = one(itemsB, 'support B edge', (entry) => entry.topologySignature?.kind === 'edge'
        && entry.expectedGeometry === 'line' && distance(entry.topologySignature.p, [5, 10, 50]) < 0.05
        && Math.abs(Number(entry.topologySignature.l) - 100) < 0.05);
      const supports = [faceA, edgeA, faceB, edgeB];
      const studioScript = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
      if (!studioScript) throw new Error('cannot locate Studio module for topology-name decoding');
      const interaction = await import(new URL('studio-v6-interaction.js', studioScript.src).href);
      const topologyNames = supports.map((entry) => interaction.cadUiTopologyNameFromStableId(entry.stableId));
      if (topologyNames.some((entry) => typeof entry !== 'string' || !entry)) {
        throw new Error(`weld support selection did not resolve persistent topology names: ${JSON.stringify({
          stableIds: supports.map((entry) => entry.stableId), topologyNames,
        })}`);
      }
      const snapshot = await request('cad_ui', { action: 'snapshot' });
      await request('cad_ui', {
        action: 'apply',
        expectedUiRevision: snapshot.uiRevision,
        actions: supports.map((entry, index) => ({
          kind: index === 0 ? 'selection.set' : 'selection.add',
          entity: entry,
        })),
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const selected = await request('cad_ui', { action: 'snapshot' });
      if (selected.selection?.length !== 4) throw new Error('semantic topology selection did not retain four supports');
      return {
        commandRevision: studio.commandRevision(),
        queryRevisions: [queryA.revision, queryB.revision],
        exactGeometry: queryA.result.exactGeometry && queryB.result.exactGeometry,
        supports,
        topologyNames,
        selected: selected.selection,
      };
    } finally {
      partmodeAgent.disconnect(token);
    }
  }, { bodyAId: MEMBER_A_BODY_ID, bodyBId: MEMBER_B_BODY_ID });
}

async function assertSemanticWeldCreate(page: Page): Promise<JsonRecord> {
  return page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    const partmodeAgent = (window as any).partmodeAgent;
    const authoritativeBefore = {
      docJson: studio.docJson(),
      canonicalHash: studio.canonicalHash(),
      commandRevision: studio.commandRevision(),
      documentRevision: studio.documentRevision(),
      undoDepth: studio.undoDepth(),
    };
    const connection = await studio.connectAgentForTest({
      clientLabel: 'WD003 semantic create gate',
      mode: 'scoped-auto-commit',
      permissionContext: {
        granted: ['project.read', 'project.edit', 'ui.read', 'ui.command-draft', 'ui.present-preview'],
        operationKinds: ['weld.bead.create'],
        maxCommits: 0,
      },
    });
    const token = connection.connectionToken;
    let sequence = 0;
    const request = (args: JsonRecord) => partmodeAgent.requestTool(
      token, 'cad_ui', args, `wd003-create-${++sequence}`,
    );
    try {
      const selected = await request({ action: 'snapshot' });
      const openedResult = await request({
        action: 'apply', expectedUiRevision: selected.uiRevision,
        actions: [{ kind: 'command.open', commandId: 'model.weld-bead' }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const opened = await request({ action: 'snapshot' });
      const dialog = document.getElementById('bw-weld-bead') as HTMLDialogElement | null;
      const configuredResult = await request({
        action: 'apply', expectedUiRevision: opened.uiRevision,
        actions: [
          { kind: 'command.setInput', fieldId: 'name', value: 'Semantic exact preview bead' },
          { kind: 'command.setInput', fieldId: 'sizeMm', value: 2.5 },
          { kind: 'command.setInput', fieldId: 'process', value: 'FCAW-preview' },
        ],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const configured = await request({ action: 'snapshot' });
      const studioScript = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
      if (!studioScript) throw new Error('cannot locate Studio module for semantic transaction inspection');
      const interaction = await import(new URL('studio-v6-interaction.js', studioScript.src).href);
      const built = interaction.buildCadUiCommandTransaction({
        draft: configured.activeCommand,
        expectedRevision: configured.activeCommand.baseRevision,
        transactionId: configured.activeCommand.transactionId,
      });
      const operation = built.transaction?.operations?.[0];
      const previewBatch = await request({
        action: 'apply', expectedUiRevision: configured.uiRevision,
        actions: [{ kind: 'command.preview' }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const previewResult = previewBatch.results?.find((entry: JsonRecord) => entry.kind === 'command.preview')?.result;
      const previewed = await request({ action: 'snapshot' });
      const generatedFeatureId = configured.activeCommand?.generatedIds?.featureId;
      const createdFeature = previewResult?.changeSet?.created?.find((entry: JsonRecord) =>
        entry.kind === 'feature' && entry.id === generatedFeatureId);
      const createdBody = previewResult?.changeSet?.created?.find((entry: JsonRecord) => entry.kind === 'body');
      const exactBead = previewResult?.evidence?.bodyResults?.find((entry: JsonRecord) =>
        entry.body?.id === createdBody?.id);
      if (
        operation?.kind !== 'weld.bead.create'
        || operation?.input?.name !== 'Semantic exact preview bead'
        || operation?.input?.sizeMm !== 2.5
        || operation?.input?.process !== 'FCAW-preview'
        || operation?.input?.supports?.length !== 2
        || previewResult?.transactionHash !== built.transactionHash
        || previewResult?.baseRevision !== authoritativeBefore.commandRevision
        || previewResult?.validation?.valid !== true
        || previewResult?.validation?.exactGeometry !== true
        || previewResult?.directVisibleHashParity !== true
        || previewResult?.evidence?.exactGeometry !== true
        || previewResult?.changeSet?.documentHashBefore !== authoritativeBefore.canonicalHash
        || previewResult?.changeSet?.documentHashAfter === authoritativeBefore.canonicalHash
        || !createdFeature || !createdBody
        || exactBead?.valid !== true || exactBead?.solids !== 1
        || exactBead?.faces !== 5 || exactBead?.edges !== 9
        || Math.abs(Number(exactBead?.volume) - 312.5) > 2e-4
        || previewed.preview?.previewId !== previewResult?.previewId
        || previewed.preview?.visible !== true
        || previewed.preview?.validation?.valid !== true
      ) {
        throw new Error(`semantic weld-bead exact preview evidence is incomplete: ${JSON.stringify({
          operation, builtHash: built.transactionHash, previewResult, preview: previewed.preview,
        })}`);
      }
      const evidence = {
        selectedSupportCount: selected.selection?.length || 0,
        commandId: opened.activeCommand?.commandId || null,
        dialogOpen: dialog?.open === true,
        dialogFeatureId: dialog?.dataset.featureId || '',
        opened: openedResult.results?.some((entry: JsonRecord) => entry.kind === 'command.open') || false,
        configured: configuredResult.results?.filter((entry: JsonRecord) => entry.kind === 'command.setInput').length === 3,
        operationKind: operation.kind,
        previewed: true,
        previewValid: previewResult.validation.valid,
        previewExactGeometry: previewResult.validation.exactGeometry,
        previewOneSolid: exactBead.solids === 1,
        previewTopology: { faces: exactBead.faces, edges: exactBead.edges },
        previewVolumeMm3: exactBead.volume,
        previewCurrentRevision: previewResult.baseRevision === authoritativeBefore.commandRevision,
      };
      const dismissedResult = await request({
        action: 'apply', expectedUiRevision: previewed.uiRevision,
        actions: [{ kind: 'preview.dismiss' }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const dismissed = await request({ action: 'snapshot' });
      if (dismissed.preview?.previewId !== previewResult.previewId || dismissed.preview?.visible !== false) {
        throw new Error('semantic weld-bead preview did not dismiss without committing');
      }
      const cancelledResult = await request({
        action: 'apply', expectedUiRevision: dismissed.uiRevision,
        actions: [{ kind: 'command.cancel' }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const closed = await request({ action: 'snapshot' });
      const authoritativeAfter = {
        docJson: studio.docJson(),
        canonicalHash: studio.canonicalHash(),
        commandRevision: studio.commandRevision(),
        documentRevision: studio.documentRevision(),
        undoDepth: studio.undoDepth(),
      };
      if (closed.activeCommand || closed.preview || dialog?.open === true) {
        throw new Error('semantic weld-bead create cancel left the command or dialog open');
      }
      if (JSON.stringify(authoritativeAfter) !== JSON.stringify(authoritativeBefore)) {
        throw new Error('semantic weld-bead preview or cancel mutated the authoritative document');
      }
      return {
        ...evidence,
        dismissed: dismissedResult.results?.some((entry: JsonRecord) => entry.kind === 'preview.dismiss') || false,
        cancelled: cancelledResult.results?.some((entry: JsonRecord) => entry.kind === 'command.cancel') || false,
        documentUnchanged: true,
      };
    } finally {
      partmodeAgent.disconnect(token);
    }
  });
}

async function assertSemanticWeldEdit(page: Page, featureId: string): Promise<JsonRecord> {
  return page.evaluate(async (selectedFeatureId) => {
    const studio = (window as any).__bwStudio;
    const partmodeAgent = (window as any).partmodeAgent;
    const connection = await studio.connectAgentForTest({
      clientLabel: 'WD003 semantic edit gate',
      mode: 'read-only',
      permissionContext: { granted: ['project.read', 'ui.read', 'ui.select', 'ui.command-draft'] },
    });
    const token = connection.connectionToken;
    let sequence = 0;
    const request = (args: JsonRecord) => partmodeAgent.requestTool(
      token, 'cad_ui', args, `wd003-edit-${++sequence}`,
    );
    try {
      const initial = await request({ action: 'snapshot' });
      await request({
        action: 'apply', expectedUiRevision: initial.uiRevision,
        actions: [{ kind: 'selection.set', entity: { kind: 'feature', id: selectedFeatureId } }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const selected = await request({ action: 'snapshot' });
      await request({
        action: 'apply', expectedUiRevision: selected.uiRevision,
        actions: [{ kind: 'command.open', commandId: 'model.weld-bead' }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const opened = await request({ action: 'snapshot' });
      const dialog = document.getElementById('bw-weld-bead') as HTMLDialogElement | null;
      const evidence = {
        commandId: opened.activeCommand?.commandId || null,
        editEntity: opened.activeCommand?.editEntity || null,
        dialogOpen: dialog?.open === true,
        dialogFeatureId: dialog?.dataset.featureId || null,
        title: document.getElementById('bw-weld-bead-title')?.textContent || '',
        captureDisabled: (document.getElementById('bw-weld-bead-capture') as HTMLButtonElement | null)?.disabled,
      };
      await request({
        action: 'apply', expectedUiRevision: opened.uiRevision,
        actions: [{ kind: 'command.cancel' }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const closed = await request({ action: 'snapshot' });
      if (closed.activeCommand || dialog?.open === true) {
        throw new Error('semantic weld-bead edit cancel left the command or dialog open');
      }
      return evidence;
    } finally {
      partmodeAgent.disconnect(token);
    }
  }, featureId);
}

function assertStoredSupport(
  actual: JsonRecord,
  selectedFace: JsonRecord,
  selectedEdge: JsonRecord,
  selectedFaceName: string,
  selectedEdgeName: string,
  expectedMemberId: string,
  expectedBodyId: string,
): void {
  assert.equal(actual.memberId, expectedMemberId, 'persisted weld support changed structural-member identity');
  assert.equal(actual.bodyId, expectedBodyId, 'persisted weld support changed structural body identity');
  assert.equal(actual.face.name, selectedFaceName, 'persisted weld support changed named face identity');
  assert.equal(actual.edge.name, selectedEdgeName, 'persisted weld support changed named edge identity');
  const faceSignature = structuredClone(selectedFace.topologySignature);
  const edgeSignature = structuredClone(selectedEdge.topologySignature);
  delete faceSignature.kind;
  delete edgeSignature.kind;
  assert.deepEqual(actual.face.sig, faceSignature, 'persisted weld support changed exact face signature snapshot');
  assert.deepEqual(actual.edge.sig, edgeSignature, 'persisted weld support changed exact edge signature snapshot');
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
    (window as any).__wd003Injected = false;
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
  assert.equal(response?.status(), 200, 'weld-bead UI route did not return HTTP 200');
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  await clickVisible(page, '[data-workspace="solid"]');
  await assertHitTestable(page, '#bw-weld-bead-open');

  const registryAudit = await page.evaluate(async () => {
    const studioScript = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
    if (!studioScript) throw new Error('Cannot locate the built Studio module URL.');
    const registryUrl = new URL('studio-v6-ui-registry.js', studioScript.src).href;
    const registryModule = await import(registryUrl);
    const matches = (registryModule.CAD_UI_CONTROL_REGISTRY as any[])
      .filter((entry) => entry.id === 'model.weld-bead');
    return { count: matches.length, control: matches[0] };
  });
  assert.equal(registryAudit.count, 1, 'model.weld-bead is not uniquely registered');
  assert.equal(registryAudit.control.adapter, 'available', 'Weld bead is not an available semantic adapter');
  assert.equal(registryAudit.control.workspaceId, 'solid', 'Weld bead is registered in the wrong workspace');
  assert.deepEqual(registryAudit.control.humanBindings,
    [{ kind: 'element-id', elementId: 'bw-weld-bead-open' }],
    'registered weld-bead control is not bound to the visible ribbon button');
  assert.deepEqual(registryAudit.control.operationKinds,
    ['weld.bead.create', 'weld.bead.update', 'weld.bead.delete'],
    'registered weld-bead control advertises the wrong typed operations');
  assert.deepEqual(registryAudit.control.fields.map((field: JsonRecord) => field.id),
    ['name', 'supports', 'sizeMm', 'process'], 'registered weld-bead field contract is incomplete');

  const seedBefore = await projectState(page);
  await page.evaluate((fixture) => (window as any).__bwStudio.commitHumanOperationsForTest(
    'Seed exact touching RECT members for WD003 UI acceptance',
    [
      { kind: 'project.clear', input: {} },
      {
        kind: 'sketch.path.create',
        input: {
          id: 'ui-weld-path-a', name: 'Support A path', curveKind: 'polyline',
          points: [[0, 0, 0], [0, 0, 100]],
        },
      },
      {
        kind: 'sketch.path.create',
        input: {
          id: 'ui-weld-path-b', name: 'Support B path', curveKind: 'polyline',
          points: [[0, 0, 0], [0, 0, 100]],
        },
      },
      {
        kind: 'structural.member.create',
        input: {
          id: fixture.memberAId, name: 'Support A', pathSketchId: 'ui-weld-path-a',
          familyId: 'rectangular-bar', presetId: 'rect-20x10',
          placement: { anchor: 'center', rotationDegrees: 0, offset: [0, 0] },
        },
      },
      {
        kind: 'structural.member.create',
        input: {
          id: fixture.memberBId, name: 'Support B', pathSketchId: 'ui-weld-path-b',
          familyId: 'rectangular-bar', presetId: 'rect-20x10',
          placement: { anchor: 'center', rotationDegrees: 0, offset: [20, -10] },
        },
      },
    ],
  ), { memberAId: MEMBER_A_ID, memberBId: MEMBER_B_ID });
  await assertCurrentSettlement(page, seedBefore, 'touching RECT member seed');
  let part = await readPart(page);
  assert.equal(part.features.filter((entry: JsonRecord) => entry.extensions?.structuralMember).length, 2,
    'browser fixture does not contain exactly two structural members');
  const baselineExact = await exactCurrent(page, 'baseline touching members');
  const baselineA = exactBody(baselineExact, MEMBER_A_BODY_ID, 'baseline support A');
  const baselineB = exactBody(baselineExact, MEMBER_B_BODY_ID, 'baseline support B');
  assert.ok(closeTo(baselineA.geometry.volume, 20_000) && closeTo(baselineB.geometry.volume, 20_000),
    'baseline exact RECT member volume drifted');
  assert.deepEqual(baselineA.geometry.bounds, [[-5, -10, 0], [5, 10, 100]],
    'baseline support A bounds drifted');
  assert.deepEqual(baselineB.geometry.bounds, [[5, 10, 0], [15, 30, 100]],
    'baseline support B bounds drifted');

  const selectionEvidence = await selectExactWeldSupports(page);
  assert.equal(selectionEvidence.exactGeometry, true, 'support selection did not come from current exact topology');
  assert.deepEqual(selectionEvidence.queryRevisions,
    [selectionEvidence.commandRevision, selectionEvidence.commandRevision],
    'support selection query was not current-revision-bound');
  assert.deepEqual(selectionEvidence.selected, selectionEvidence.supports,
    'visible semantic selection changed the runtime-selected topology references');

  const beforeCancel = await projectState(page);
  await openCreateDialog(page);
  for (const selector of [
    '#bw-weld-bead-name', '#bw-weld-bead-capture', '#bw-weld-bead-size', '#bw-weld-bead-process',
    '#bw-weld-bead-cancel', '#bw-weld-bead-apply',
  ]) await assertHitTestable(page, selector);
  await clickVisible(page, '#bw-weld-bead-capture');
  const capturedSummary = await page.$eval('#bw-weld-bead-supports', (entry) => entry.textContent || '');
  assert.match(capturedSummary, /Support A: Support A .* planar face .* straight edge/u,
    'visible support summary omitted support A named topology');
  assert.match(capturedSummary, /Support B: Support B .* planar face .* straight edge/u,
    'visible support summary omitted support B named topology');
  for (const [index, support] of selectionEvidence.supports.entries()) {
    assert.ok(capturedSummary.includes(selectionEvidence.topologyNames[index]),
      `visible support summary omitted persistent topology name ${support.stableId}`);
  }
  await replaceValue(page, '#bw-weld-bead-name', 'Cancelled exact weld draft');
  await replaceValue(page, '#bw-weld-bead-size', '6');
  await replaceValue(page, '#bw-weld-bead-process', 'SMAW');
  assert.equal(await page.evaluate(() => (window as any).__bwStudio.docJson()), beforeCancel.docJson,
    'visible weld-bead draft mutated the authoritative document before Apply');
  await clickVisible(page, '#bw-weld-bead-cancel');
  await waitForDialog(page, false);
  await waitForSettlement(page);
  assert.deepEqual(await projectState(page), beforeCancel,
    'Cancel changed weld-bead document bytes, hash, revision, or undo/redo history');

  const beforeRefusal = await projectState(page);
  await openCreateDialog(page);
  await clickVisible(page, '#bw-weld-bead-capture');
  await replaceValue(page, '#bw-weld-bead-name', 'Oversized refused bead');
  await replaceValue(page, '#bw-weld-bead-size', '30');
  await clickVisible(page, '#bw-weld-bead-apply');
  await page.waitForFunction(() => {
    const error = document.getElementById('bw-weld-bead-error')?.textContent || '';
    return /support face|bounded|published/iu.test(error);
  }, { polling: 100, timeout: 180_000 });
  assert.equal((await projectState(page)).docJson, beforeRefusal.docJson,
    'exact validation refusal committed an oversized weld bead');
  assert.equal((await projectState(page)).canonicalHash, beforeRefusal.canonicalHash,
    'exact validation refusal changed the canonical document hash');
  assert.equal(await page.$eval('#bw-weld-bead', (dialog) => (dialog as HTMLDialogElement).open), true,
    'exact validation refusal closed the visible command instead of retaining the error');
  await clickVisible(page, '#bw-weld-bead-cancel');
  await waitForDialog(page, false);

  let beforeApply = await projectState(page);
  await openCreateDialog(page);
  await clickVisible(page, '#bw-weld-bead-capture');
  await replaceValue(page, '#bw-weld-bead-name', HTML_LIKE_BEAD_NAME);
  await replaceValue(page, '#bw-weld-bead-size', '3');
  await replaceValue(page, '#bw-weld-bead-process', 'GMAW');
  await clickVisible(page, '#bw-weld-bead-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeApply, 'visible exact weld-bead create');
  part = await readPart(page);
  let bead = part.features.find((entry: JsonRecord) => entry.extensions?.weldBead);
  assert.ok(bead, 'visible create did not persist a typed weld-bead feature');
  const beadId = bead.id;
  const beadBody = part.bodies.find((entry: JsonRecord) => entry.createdByFeatureId === beadId);
  assert.ok(beadBody, 'visible create did not persist the weld bead owned body');
  const beadBodyId = beadBody.id;
  const initialRecipe = structuredClone(bead.extensions.weldBead);
  assert.equal(initialRecipe.schema, 'partmode.weld-bead/v1', 'visible create persisted the wrong weld-bead schema');
  assert.equal(initialRecipe.kind, 'fillet', 'visible create persisted the wrong weld family');
  assert.equal(initialRecipe.sizeMm, 3, 'visible create persisted the wrong equal leg size');
  assert.equal(initialRecipe.process, 'GMAW', 'visible create persisted the wrong process');
  assert.equal(bead.inputRefs.length, 8, 'visible create omitted canonical support input references');
  assertStoredSupport(initialRecipe.supports[0], selectionEvidence.supports[0], selectionEvidence.supports[1],
    selectionEvidence.topologyNames[0], selectionEvidence.topologyNames[1], MEMBER_A_ID, MEMBER_A_BODY_ID);
  assertStoredSupport(initialRecipe.supports[1], selectionEvidence.supports[2], selectionEvidence.supports[3],
    selectionEvidence.topologyNames[2], selectionEvidence.topologyNames[3], MEMBER_B_ID, MEMBER_B_BODY_ID);
  const rowSelector = historySelector(beadId);
  await page.waitForSelector(rowSelector, { visible: true, timeout: 30_000 });
  assert.equal(await page.$(`${rowSelector} img`), null, 'HTML-like weld-bead name created an image in visible History');
  assert.equal(await page.evaluate(() => (window as any).__wd003Injected), false,
    'HTML-like weld-bead name executed in visible History');

  const createdExact = await exactCurrent(page, 'visible 3 mm weld bead');
  const exactCreatedBead = exactBody(createdExact, beadBodyId, 'visible 3 mm weld bead');
  assert.ok(closeTo(exactCreatedBead.geometry.volume, 0.5 * 3 * 3 * 100),
    'visible 3 mm bead volume is not triangular area times exact seam length');
  assert.equal(exactCreatedBead.geometry.faceCount, 5, 'visible bead is not a five-face triangular prism');
  assert.equal(exactCreatedBead.geometry.edgeCount, 9, 'visible bead is not a nine-edge triangular prism');
  assert.equal(exactCreatedBead.geometry.vertexCount, 6, 'visible bead is not a six-vertex triangular prism');
  assert.equal(exactBody(createdExact, MEMBER_A_BODY_ID, 'created support A').exactBrep, baselineA.exactBrep,
    'modeled bead modified source member A BREP');
  assert.equal(exactBody(createdExact, MEMBER_B_BODY_ID, 'created support B').exactBrep, baselineB.exactBrep,
    'modeled bead modified source member B BREP');

  beforeApply = await projectState(page);
  await openHistoryEdit(page, beadId);
  assert.equal(await page.$eval('#bw-weld-bead-capture', (control) => (control as HTMLButtonElement).disabled), true,
    'visible edit allows immutable support topology to be recaptured');
  assert.equal(await page.$eval('#bw-weld-bead-supports', (entry) => entry.textContent || ''), capturedSummary,
    'visible edit did not reload the persistent support identities');
  await replaceValue(page, '#bw-weld-bead-name', 'Edited exact weld bead');
  await replaceValue(page, '#bw-weld-bead-size', '4');
  await replaceValue(page, '#bw-weld-bead-process', 'GTAW');
  await clickVisible(page, '#bw-weld-bead-apply');
  await waitForDialog(page, false);
  await assertCurrentSettlement(page, beforeApply, 'visible weld-bead edit');
  part = await readPart(page);
  bead = part.features.find((entry: JsonRecord) => entry.id === beadId);
  assert.equal(bead.id, beadId, 'visible edit replaced weld-bead feature identity');
  assert.equal(part.bodies.find((entry: JsonRecord) => entry.createdByFeatureId === beadId)?.id, beadBodyId,
    'visible edit replaced weld-bead body identity');
  assert.deepEqual(bead.extensions.weldBead.supports, initialRecipe.supports,
    'visible edit changed immutable support identity');
  assert.equal(bead.extensions.weldBead.sizeMm, 4, 'visible edit persisted the wrong equal leg size');
  assert.equal(bead.extensions.weldBead.process, 'GTAW', 'visible edit persisted the wrong process');
  const editedExact = await exactCurrent(page, 'visible 4 mm weld bead');
  const exactEditedBead = exactBody(editedExact, beadBodyId, 'visible 4 mm weld bead');
  assert.ok(closeTo(exactEditedBead.geometry.volume, 0.5 * 4 * 4 * 100),
    'visible edit did not rebuild analytic bead volume');
  assert.equal(exactEditedBead.geometry.faceCount, 5, 'edited bead lost five-face topology');
  assert.equal(exactEditedBead.geometry.edgeCount, 9, 'edited bead lost nine-edge topology');
  assert.equal(exactEditedBead.geometry.vertexCount, 6, 'edited bead lost six-vertex topology');
  assert.notEqual(exactEditedBead.exactBrep, exactCreatedBead.exactBrep,
    'visible size edit did not change the exact weld-bead BREP');

  await clickVisible(page, '[data-workspace="output"]');
  await clickVisible(page, '#bw-export-pdf-open');
  await page.waitForFunction(() =>
    (document.getElementById('bw-drawing-pdf') as HTMLDialogElement | null)?.open === true,
  { polling: 50, timeout: 30_000 });
  await assertHitTestable(page, '#bw-drawing-book-initialize');
  beforeApply = await projectState(page);
  await clickVisible(page, '#bw-drawing-book-initialize');
  await assertCurrentSettlement(page, beforeApply, 'visible drawing-set initialization');
  await assertHitTestable(page, '#bw-drawing-table-add');
  await selectValue(page, '#bw-drawing-table-kind', 'weld');
  await replaceValue(page, '#bw-drawing-table-name', 'Exact weld schedule');
  await replaceValue(page, '#bw-drawing-table-position', '12,12');
  await replaceValue(page, '#bw-drawing-table-width', '190');
  await replaceValue(page, '#bw-drawing-table-references', beadId);
  beforeApply = await projectState(page);
  await clickVisible(page, '#bw-drawing-table-add');
  await assertCurrentSettlement(page, beforeApply, 'visible weld-table create');
  let document = await readDocument(page);
  let tables = document.extensions?.drawingTables?.tables || [];
  assert.equal(tables.length, 1, 'visible table manager did not persist exactly one drawing table');
  assert.equal(tables[0].kind, 'weld', 'visible table manager persisted the wrong table kind');
  assert.equal(tables[0].name, 'Exact weld schedule', 'visible table manager persisted the wrong table name');
  assert.deepEqual(tables[0].sourceFeatureIds, [beadId],
    'visible weld table is not associated to the persistent modeled bead');
  const tableId = tables[0].id;
  const drawing = await page.evaluate(async () => (window as any).__bwStudio.drawingForTest());
  assert.ok(drawing, 'visible project did not produce an exact drawing after weld-table creation');
  assert.equal(drawing.manifest?.exactProjectionEvidence?.kind, 'occt-hlr-exact',
    'visible weld-table project drawing is not exact OCCT HLR output');
  assert.equal(drawing.manifest?.exactProjectionEvidence?.documentHash,
    (await projectState(page)).canonicalHash,
  'visible weld-table project drawing is not current-document-hash-bound');

  await page.evaluate(async () => (window as any).__bwStudio.flushStorage());
  const savedState = await projectState(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  const reopenedState = await projectState(page);
  assert.equal(reopenedState.docJson, savedState.docJson,
    'save/reload changed canonical weld-bead and weld-table document bytes');
  assert.equal(reopenedState.canonicalHash, savedState.canonicalHash,
    'save/reload changed canonical weld-bead and weld-table document hash');
  document = await readDocument(page);
  part = rootPart(document);
  bead = part.features.find((entry: JsonRecord) => entry.id === beadId);
  assert.ok(bead, 'save/reload lost the visible weld-bead feature');
  assert.deepEqual(bead.extensions.weldBead, rootPart(JSON.parse(savedState.docJson)).features
    .find((entry: JsonRecord) => entry.id === beadId).extensions.weldBead,
  'save/reload changed the persistent weld-bead recipe');
  tables = document.extensions?.drawingTables?.tables || [];
  assert.equal(tables.find((entry: JsonRecord) => entry.id === tableId)?.sourceFeatureIds[0], beadId,
    'save/reload lost the persistent weld-table association');
  assert.equal(await page.evaluate(() => (window as any).__wd003Injected), false,
    'persisted HTML-like weld-bead name executed after reload');
  const reopenedExact = await exactCurrent(page, 'reopened visible weld bead');
  const exactReopenedBead = exactBody(reopenedExact, beadBodyId, 'reopened visible weld bead');
  assert.ok(closeTo(exactReopenedBead.geometry.volume, 800),
    'reopened visible weld bead lost its exact analytic volume');

  await clickVisible(page, '[data-workspace="output"]');
  await clickVisible(page, '#bw-export-pdf-open');
  await page.waitForFunction(() =>
    (document.getElementById('bw-drawing-pdf') as HTMLDialogElement | null)?.open === true,
  { polling: 50, timeout: 30_000 });
  await selectValue(page, '#bw-drawing-table', tableId);
  beforeApply = await projectState(page);
  await clickVisible(page, '#bw-drawing-table-delete');
  await assertCurrentSettlement(page, beforeApply, 'visible weld-table delete');
  assert.equal((await readDocument(page)).extensions?.drawingTables?.tables?.length || 0, 0,
    'visible weld-table delete left a persistent table');

  await clickVisible(page, '#bw-drawing-pdf-close');
  await clickVisible(page, '[data-workspace="solid"]');
  const semanticEdit = await assertSemanticWeldEdit(page, beadId);
  assert.equal(semanticEdit.commandId, 'model.weld-bead',
    'semantic edit did not advertise the active model.weld-bead command');
  assert.equal(semanticEdit.editEntity?.id, beadId,
    'semantic edit did not retain the selected persistent weld-bead feature');
  assert.equal(semanticEdit.dialogOpen, true, 'semantic edit did not open the dedicated visible weld-bead dialog');
  assert.equal(semanticEdit.dialogFeatureId, beadId, 'semantic edit opened the weld-bead dialog in create mode');
  assert.equal(semanticEdit.title, 'Edit weld bead', 'semantic edit did not expose the visible edit title');
  assert.equal(semanticEdit.captureDisabled, true, 'semantic edit allowed immutable support topology recapture');

  const beforeDelete = await projectState(page);
  const deleteSelector = `${historySelector(beadId)} [data-del="${beadId}"]`;
  await clickVisible(page, deleteSelector);
  await page.waitForFunction((featureId) => {
    const project = JSON.parse((window as any).__bwStudio.docJson());
    const partId = project.rootDocument?.partId;
    const activePart = project.partDefinitions.find((entry: JsonRecord) => entry.id === partId);
    return !activePart.features.some((entry: JsonRecord) => entry.id === featureId)
      && !activePart.bodies.some((entry: JsonRecord) => entry.createdByFeatureId === featureId);
  }, { polling: 100, timeout: 30_000 }, beadId);
  await assertCurrentSettlement(page, beforeDelete, 'visible typed weld-bead delete');
  assert.equal(await page.$(historySelector(beadId)), null,
    'visible typed weld-bead delete left its History row');
  const finalExact = await exactCurrent(page, 'final weld-bead cleanup');
  assert.equal(finalExact.exact.bodies.length, 2, 'weld-bead cleanup left a generated exact body');
  exactBody(finalExact, MEMBER_A_BODY_ID, 'final support A');
  exactBody(finalExact, MEMBER_B_BODY_ID, 'final support B');
  assert.ok((await readPart(page)).features.every((entry: JsonRecord) => !entry.extensions?.weldBead),
    'weld-bead cleanup left a persistent typed feature');
  const finalSelection = await selectExactWeldSupports(page);
  assert.equal(finalSelection.selected.length, 4,
    'final semantic create gate did not restore the four exact weld supports');
  const semanticCreate = await assertSemanticWeldCreate(page);
  assert.deepEqual(semanticCreate, {
    selectedSupportCount: 4,
    commandId: 'model.weld-bead',
    dialogOpen: true,
    dialogFeatureId: '',
    opened: true,
    configured: true,
    operationKind: 'weld.bead.create',
    previewed: true,
    previewValid: true,
    previewExactGeometry: true,
    previewOneSolid: true,
    previewTopology: { faces: 5, edges: 9 },
    previewVolumeMm3: 312.5,
    previewCurrentRevision: true,
    dismissed: true,
    cancelled: true,
    documentUnchanged: true,
  }, 'semantic model.weld-bead create command did not use the dedicated visible dialog lifecycle');
  assert.deepEqual(failures, [], `weld-bead browser gate reported errors: ${failures.join(' | ')}`);

  console.log(JSON.stringify({
    schema: 'partmode.weld-beads-ui-smoke/v1',
    browserBacked: true,
    registeredControl: 'model.weld-bead',
    exactRuntimeSelection: {
      structuralMembers: [MEMBER_A_ID, MEMBER_B_ID],
      selectedPersistentSubshapes: 4,
      faceEdgePairs: 2,
      currentRevisionBound: true,
    },
    visibleLifecycle: {
      cancelNoMutation: true,
      exactValidationRefusal: 'oversized-support-bounds',
      weldBead: ['create', 'size-process-edit', 'save-reload', 'typed-delete'],
      weldTable: ['create', 'save-reload', 'typed-delete'],
    },
    exactEvidence: {
      currentDocumentHashBoundAfterEveryApply: true,
      isolatedProductionWorker: true,
      oneSolid: true,
      topology: { faces: 5, edges: 9, vertices: 6 },
      volumeMm3: [450, 800],
      semanticPreview: { operation: 'weld.bead.create', volumeMm3: 312.5, dismissedWithoutCommit: true },
      sourceBrepsUnchanged: true,
      currentOcctDrawing: true,
    },
    htmlLikeNameEscaped: true,
    consoleNetworkResponsePageErrors: 0,
  }, null, 2));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
