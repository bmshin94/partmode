import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import puppeteer, { type Page } from 'puppeteer';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-weldment-cut-list-ui-'));
const downloadDirectory = resolve(temporaryDirectory, 'downloads');
mkdirSync(downloadDirectory);
const PATH_A_ID = 'ui-cut-list-path-a';
const PATH_B_ID = 'ui-cut-list-path-b';
const MEMBER_A_ID = 'ui-cut-list-member-a';
const MEMBER_B_ID = 'ui-cut-list-member-b';
const MEMBER_A_BODY_ID = 'body-' + MEMBER_A_ID;
const MEMBER_B_BODY_ID = 'body-' + MEMBER_B_ID;
const TREATMENT_ID = 'ui-cut-list-corner';
const HTML_LIKE_MEMBER_NAME = '<img src=x onerror="window.__wd004Injected=true"> Miter member';
const EXPECTED_HEADERS = [
  'ITEM', 'MEMBER', 'PROFILE', 'MATERIAL', 'QTY', 'LENGTH mm', 'START ° OFF SQ', 'END ° OFF SQ',
];

const moduleAt = async (path: string): Promise<any> =>
  import(pathToFileURL(resolve(repositoryRoot, path)).href);
const [runtime, drawingBook, drawingPdf] = await Promise.all([
  moduleAt('src/static/studio-v5-runtime-document.js'),
  moduleAt('src/static/studio-drawing-book.js'),
  moduleAt('src/static/studio-drawing-pdf.js'),
]);

function closeTo(actual: unknown, expected: number, tolerance = 2e-4): boolean {
  const value = Number(actual);
  return Number.isFinite(value)
    && Math.abs(value - expected) <= Math.max(tolerance, Math.abs(expected) * 1e-9);
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

async function waitForDrawingDialog(page: Page, open: boolean): Promise<void> {
  await page.waitForFunction((expectedOpen) =>
    (document.getElementById('bw-drawing-pdf') as HTMLDialogElement | null)?.open === expectedOpen,
  { polling: 50, timeout: 60_000 }, open);
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
      docJson: studio.docJson(),
    };
  });
  assert.ok(evidence.settlement, `${label} has no document-settlement receipt`);
  assert.equal(evidence.appliedRevision, evidence.documentRevision, `${label} is not visibly settled`);
  assert.equal(evidence.settlement.status, 'settled', `${label} did not cross the settlement barrier`);
  assert.equal(evidence.settlement.target.documentHash, evidence.canonicalHash,
    `${label} target is not current-document-hash-bound`);
  assert.equal(evidence.settlement.target.kernelRevision, evidence.documentRevision,
    `${label} target is not current-revision-bound`);
  assert.equal(evidence.settlement.kernel.documentHash, evidence.canonicalHash,
    `${label} kernel receipt is stale`);
  assert.equal(evidence.settlement.persistence.documentHash, evidence.canonicalHash,
    `${label} persistence receipt is stale`);
  assert.equal(evidence.settlement.renderer.documentHash, evidence.canonicalHash,
    `${label} renderer receipt is stale`);
  assert.deepEqual(evidence.errors, [], `${label} produced visible exact rebuild errors`);
  assert.ok(evidence.documentRevision > previous.documentRevision, `${label} did not advance document revision`);
  assert.notEqual(evidence.canonicalHash, previous.canonicalHash, `${label} did not change canonical hash`);
  return evidence;
}

async function assertDrawingTablePanels(page: Page, sourceType: 'structural-member' | 'body-axis'): Promise<void> {
  const state = await page.evaluate((activeSourceType) => {
    const record = (id: string) => {
      const panel = document.getElementById(id) as HTMLElement | null;
      if (!panel) throw new Error(`missing drawing-table panel ${id}`);
      return {
        hidden: panel.hidden,
        controls: [...panel.querySelectorAll('input,select,textarea,button')].map((entry) => ({
          id: (entry as HTMLElement).id,
          disabled: (entry as HTMLInputElement).disabled,
        })),
      };
    };
    return {
      activeSourceType,
      sourceType: (document.getElementById('bw-drawing-table-source-type') as HTMLSelectElement | null)?.value,
      structural: record('bw-drawing-table-structural-fields'),
      body: record('bw-drawing-table-body-fields'),
      feature: record('bw-drawing-table-feature-fields'),
      revision: record('bw-drawing-table-revision-fields'),
    };
  }, sourceType);
  assert.equal(state.sourceType, sourceType, 'cut-list source selector drifted');
  assert.equal(state.structural.hidden, sourceType !== 'structural-member', 'structural fields visibility drifted');
  assert.equal(state.body.hidden, sourceType !== 'body-axis', 'body-axis fields visibility drifted');
  assert.equal(state.feature.hidden, true, 'hole/weld feature fields are active during cut-list authoring');
  assert.equal(state.revision.hidden, true, 'revision fields are active during cut-list authoring');
  for (const [name, panel, active] of [
    ['structural', state.structural, sourceType === 'structural-member'],
    ['body-axis', state.body, sourceType === 'body-axis'],
    ['feature', state.feature, false],
    ['revision', state.revision, false],
  ] as const) {
    assert.ok(panel.controls.length > 0, `${name} drawing-table panel has no controls`);
    assert.equal(panel.controls.every((entry) => entry.disabled === !active), true,
      `${name} drawing-table controls do not follow panel activation`);
  }
}

function drawingTable(document: JsonRecord, tableId?: string): JsonRecord {
  const tables = document.extensions?.drawingTables?.tables || [];
  const table = tableId ? tables.find((entry: JsonRecord) => entry.id === tableId) : tables[0];
  assert.ok(table, `drawing table ${tableId || ''} is missing`);
  return table;
}

function assertStructuralTableContract(table: JsonRecord, tableId?: string): void {
  if (tableId) assert.equal(table.id, tableId, 'drawing-table identity changed');
  assert.equal(table.kind, 'cut-list', 'visible manager persisted the wrong table kind');
  assert.equal(table.sourceType, 'structural-member', 'visible manager persisted the wrong cut-list source type');
  assert.deepEqual(table.sourceMemberIds, [MEMBER_A_ID], 'visible manager lost the persistent member association');
  for (const forbidden of [
    'axis', 'sourceBodyIds', 'sourceFeatureIds', 'headers', 'rows', 'evidence',
    'lengthMm', 'startAngleDegrees', 'endAngleDegrees', 'angle1', 'angle2',
  ]) {
    assert.equal(Object.hasOwn(table, forbidden), false,
      `structural cut-list record persisted derived or inactive field ${forbidden}`);
  }
}

let drawingRevision = 0;

async function exactDrawingPdf(
  kernel: HeadlessKernel,
  document: JsonRecord,
  tableId: string,
  label: string,
): Promise<JsonRecord> {
  const book = drawingBook.inspectStudioDrawingBook(document) as JsonRecord;
  const views = drawingBook.requiredStudioDrawingBookViews(document) as string[];
  const revision = ++drawingRevision;
  const response = await kernel.request({
    kind: 'drawing-v5',
    requestId: `wd004-ui-drawing-${revision}-${label}`,
    projectId: document.projectId,
    revision,
    document,
    views,
  }, 180_000) as JsonRecord;
  const documentHash = runtime.studioV5CanonicalHash(document);
  assert.equal(response.kind, 'drawing-result', `${label} did not return a drawing result`);
  assert.deepEqual(response.errors || [], [], `${label} exact drawing failed`);
  assert.equal(response.manifest?.exactProjectionEvidence?.kind, 'occt-hlr-exact',
    `${label} drawing is not exact OCCT HLR output`);
  assert.equal(response.manifest?.exactProjectionEvidence?.documentHash, documentHash,
    `${label} exact drawing is not current-document-hash-bound`);
  const workerEvidence = response.manifest?.structuralMemberCutEvidence;
  assert.equal(workerEvidence?.schema, 'partmode.structural-member-cut-evidence/v1',
    `${label} drawing omitted structural cut evidence`);
  assert.equal(workerEvidence?.kind, 'occt-exact-structural-member-cuts',
    `${label} drawing structural cut evidence is not OCCT-derived`);
  assert.equal(workerEvidence?.documentHash, documentHash,
    `${label} structural cut evidence is not current-document-hash-bound`);
  assert.equal(workerEvidence?.effectiveDocumentHash, response.manifest?.exactProjectionEvidence?.effectiveDocumentHash,
    `${label} structural cut evidence is not effective-document-hash-bound`);
  assert.equal(workerEvidence?.lengthBasis, 'exact-brep-axial-envelope',
    `${label} structural cut length does not claim its exact B-rep basis`);
  assert.equal(workerEvidence?.angleConvention, 'degrees-off-square',
    `${label} structural cut angles use an undocumented convention`);
  assert.deepEqual(workerEvidence?.errors, [], `${label} structural cut evidence contains worker refusals`);
  const pdf = drawingPdf.createStudioDrawingBookPdf(
    response,
    document.name,
    book,
    document.extensions?.drawingStandards,
    document.extensions?.drawingAnnotations,
    document.extensions?.drawingTables,
    document,
  ) as JsonRecord;
  assert.ok(pdf.bytes?.length > 1_000, `${label} produced no substantive drawing PDF`);
  assert.equal(pdf.manifest?.exactProjectionEvidence?.documentHash, documentHash,
    `${label} PDF manifest is not current-document-hash-bound`);
  const resolved = pdf.manifest?.pages?.[0]?.drawingTables?.tables
    ?.find((entry: JsonRecord) => entry.id === tableId);
  assert.ok(resolved, `${label} PDF manifest omitted cut-list table ${tableId}`);
  assert.deepEqual(resolved.headers, EXPECTED_HEADERS, `${label} cut-list headers drifted`);
  assert.equal(resolved.headers.length, 8, `${label} cut list does not contain exactly eight columns`);
  assert.equal(resolved.rows?.length, 1, `${label} cut list did not resolve exactly one member row`);
  assert.equal(resolved.evidence?.kind, 'exact-structural-member-cuts',
    `${label} cut-list evidence is not exact structural-member evidence`);
  assert.equal(resolved.evidence?.documentHash, documentHash,
    `${label} cut-list evidence is not current-document-hash-bound`);
  assert.deepEqual(resolved.evidence?.memberIds, [MEMBER_A_ID],
    `${label} cut-list evidence lost the member identity`);
  assert.deepEqual(resolved.evidence?.bodyIds, [MEMBER_A_BODY_ID],
    `${label} cut-list evidence lost the body identity`);
  return { documentHash, response, workerEvidence, pdf, resolved, row: resolved.rows[0] };
}

function assertResolvedMemberRow(
  evidence: JsonRecord,
  expected: { lengthMm: number; start: number | 'COPE'; end: number | 'COPE' },
  label: string,
): void {
  const row = evidence.row;
  assert.equal(row[0], 1, `${label} item number drifted`);
  assert.equal(row[1], HTML_LIKE_MEMBER_NAME, `${label} member name was escaped or detached`);
  assert.equal(typeof row[2], 'string', `${label} profile description is missing`);
  assert.equal(typeof row[3], 'string', `${label} material column is missing`);
  assert.equal(row[4], 1, `${label} quantity drifted`);
  assert.ok(closeTo(row[5], expected.lengthMm), `${label} exact length drifted: ${String(row[5])}`);
  if (typeof expected.start === 'number') {
    assert.ok(closeTo(row[6], expected.start), `${label} start angle drifted: ${String(row[6])}`);
  } else {
    assert.equal(row[6], expected.start, `${label} start treatment classification drifted`);
  }
  if (typeof expected.end === 'number') {
    assert.ok(closeTo(row[7], expected.end), `${label} end angle drifted: ${String(row[7])}`);
  } else {
    assert.equal(row[7], expected.end, `${label} end treatment classification drifted`);
  }
  const memberEvidence = evidence.resolved.evidence?.members?.[0];
  assert.ok(memberEvidence, `${label} exact member evidence is missing`);
  assert.equal(memberEvidence.memberId, MEMBER_A_ID, `${label} exact member evidence is detached`);
  assert.equal(memberEvidence.bodyId, MEMBER_A_BODY_ID, `${label} exact body evidence is detached`);
  assert.ok(closeTo(memberEvidence.lengthMm, expected.lengthMm), `${label} evidence length is not B-rep-derived`);
  assert.match(memberEvidence.brepSha256, /^[0-9a-f]{64}$/u, `${label} exact B-rep hash is missing`);
  assert.ok(Number.isInteger(memberEvidence.brepBytes) && memberEvidence.brepBytes > 100,
    `${label} exact B-rep payload length is missing`);
  assert.equal(memberEvidence.geometry?.valid, true, `${label} exact member geometry is invalid`);
  assert.equal(memberEvidence.geometry?.brepValid, true, `${label} member B-rep is invalid`);
  assert.equal(memberEvidence.geometry?.solidCount, 1, `${label} cut-list member is not one exact solid`);
  assert.equal(memberEvidence.topology?.schema, 'partmode.structural-member-cut-topology/v1',
    `${label} exact cut topology schema is missing`);
  assert.deepEqual(memberEvidence.topology?.diagnostics, [], `${label} exact cut topology has diagnostics`);
  assert.equal(memberEvidence.start?.kind, expected.start === 'COPE' ? 'cope' : expected.start === 0 ? 'square' : 'miter',
    `${label} start treatment class drifted`);
  assert.equal(memberEvidence.end?.kind, expected.end === 'COPE' ? 'cope' : expected.end === 0 ? 'square' : 'miter',
    `${label} end treatment class drifted`);
  if (expected.start === 'COPE') {
    assert.equal(memberEvidence.start?.angleOffSquareDeg, null, `${label} cope exposed a fabricated scalar start angle`);
    assert.ok(memberEvidence.start?.faceNames?.length > 0, `${label} cope has no persistent profiled face evidence`);
  } else {
    assert.ok(closeTo(memberEvidence.start?.angleOffSquareDeg, expected.start),
      `${label} worker start angle drifted`);
    assert.equal(memberEvidence.start?.faceNames?.length, 1, `${label} planar start did not resolve one exact face`);
  }
  if (expected.end === 'COPE') {
    assert.equal(memberEvidence.end?.angleOffSquareDeg, null, `${label} cope exposed a fabricated scalar end angle`);
    assert.ok(memberEvidence.end?.faceNames?.length > 0, `${label} cope has no persistent profiled face evidence`);
  } else {
    assert.ok(closeTo(memberEvidence.end?.angleOffSquareDeg, expected.end), `${label} worker end angle drifted`);
    assert.equal(memberEvidence.end?.faceNames?.length, 1, `${label} planar end did not resolve one exact face`);
  }
}

async function registryAudit(page: Page): Promise<JsonRecord> {
  return page.evaluate(async () => {
    const studioScript = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
    if (!studioScript) throw new Error('cannot locate built Studio module URL');
    const registry = await import(new URL('studio-v6-ui-registry.js', studioScript.src).href);
    const matches = registry.cadUiControlRegistry().filter((entry: JsonRecord) => entry.id === 'drawing.cut-list');
    return { count: matches.length, control: matches[0] || null };
  });
}

async function assertSemanticCutListPreviewCommit(page: Page, tableId: string): Promise<JsonRecord> {
  const previewOnly = await page.evaluate(async (persistentTableId) => {
    const studio = (window as any).__bwStudio;
    const agent = (window as any).partmodeAgent;
    const before = {
      docJson: studio.docJson(),
      canonicalHash: studio.canonicalHash(),
      commandRevision: studio.commandRevision(),
      documentRevision: studio.documentRevision(),
      undoDepth: studio.undoDepth(),
      redoDepth: studio.redoDepth(),
    };
    const connection = await studio.connectAgentForTest({
      clientLabel: 'WD004 cut-list preview-only audit',
      mode: 'scoped-auto-commit',
      permissionContext: {
        granted: ['project.read', 'project.edit', 'ui.read', 'ui.command-draft', 'ui.present-preview'],
        operationKinds: ['drawing.table.update'],
        maxCommits: 0,
      },
    });
    const token = connection.connectionToken;
    let sequence = 0;
    const request = (tool: string, args: JsonRecord) => agent.requestTool(
      token, tool, args, `wd004-preview-only-${++sequence}`,
    );
    try {
      const transaction = {
        transactionId: 'wd004-cut-list-preview-only',
        label: 'Preview-only structural cut-list edit',
        expectedRevision: studio.commandRevision(),
        atomic: true,
        operations: [{
          kind: 'drawing.table.update',
          input: { tableId: persistentTableId, patch: { name: 'Preview-only cut list' } },
        }],
      };
      const preview = await request('cad_preview', { transaction });
      const presented = await request('cad_ui', { action: 'snapshot' });
      if (
        typeof preview?.previewId !== 'string'
        || preview.baseRevision !== before.commandRevision
        || preview.validation?.valid !== true
        || preview.validation?.exactGeometry !== true
        || preview.evidence?.exactGeometry !== true
        || preview.changeSet?.documentHashBefore !== before.canonicalHash
        || preview.changeSet?.documentHashAfter === before.canonicalHash
        || preview.visible !== true
        || presented.preview?.previewId !== preview.previewId
        || presented.preview?.visible !== true
      ) {
        throw new Error(`drawing.cut-list cad_preview evidence is incomplete: ${JSON.stringify({ preview, presented })}`);
      }
      const dismissedResult = await request('cad_ui', {
        action: 'apply',
        expectedUiRevision: presented.uiRevision,
        actions: [{ kind: 'preview.dismiss' }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const dismissed = await request('cad_ui', { action: 'snapshot' });
      if (dismissed.preview?.previewId !== preview.previewId || dismissed.preview?.visible !== false) {
        throw new Error('drawing.cut-list preview did not dismiss without committing');
      }
      const after = {
        docJson: studio.docJson(),
        canonicalHash: studio.canonicalHash(),
        commandRevision: studio.commandRevision(),
        documentRevision: studio.documentRevision(),
        undoDepth: studio.undoDepth(),
        redoDepth: studio.redoDepth(),
      };
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error('drawing.cut-list preview or dismissal mutated the authoritative document');
      }
      return {
        previewId: preview.previewId,
        exact: preview.validation.exactGeometry,
        visible: preview.visible,
        dismissed: dismissedResult.results?.some((entry: JsonRecord) => entry.kind === 'preview.dismiss') || false,
        documentUnchanged: true,
      };
    } finally {
      agent.disconnect(token);
    }
  }, tableId);

  const beforeCommit = await projectState(page);
  const committed = await page.evaluate(async (persistentTableId) => {
    const studio = (window as any).__bwStudio;
    const agent = (window as any).partmodeAgent;
    const connection = await studio.connectAgentForTest({
      clientLabel: 'WD004 cut-list commit audit',
      mode: 'scoped-auto-commit',
      permissionContext: {
        granted: ['project.read', 'project.edit', 'ui.read', 'ui.command-draft', 'ui.present-preview'],
        operationKinds: ['drawing.table.update'],
        maxCommits: 1,
      },
    });
    const token = connection.connectionToken;
    let sequence = 0;
    const request = (tool: string, args: JsonRecord) => agent.requestTool(
      token, tool, args, `wd004-commit-${++sequence}`,
    );
    try {
      const transaction = {
        transactionId: 'wd004-cut-list-commit',
        label: 'Semantic structural cut-list edit',
        expectedRevision: studio.commandRevision(),
        atomic: true,
        operations: [{
          kind: 'drawing.table.update',
          input: { tableId: persistentTableId, patch: { name: 'Semantic committed cut list' } },
        }],
      };
      const preview = await request('cad_preview', { transaction });
      const commit = await request('cad_commit', {
        previewId: preview.previewId,
        expectedRevision: preview.baseRevision,
      });
      return {
        previewId: preview.previewId,
        previewValid: preview.validation?.valid === true,
        previewExact: preview.validation?.exactGeometry === true,
        revision: commit.revision,
        changeSet: commit.changeSet,
        commitReceipt: commit.commitReceipt,
        settlement: commit.settlement,
      };
    } finally {
      agent.disconnect(token);
    }
  }, tableId);
  await assertCurrentSettlement(page, beforeCommit, 'semantic drawing.cut-list cad_commit');
  assert.equal(committed.previewValid, true, 'drawing.cut-list commit did not use a valid preview');
  assert.equal(committed.previewExact, true, 'drawing.cut-list commit preview was not exact');
  assert.equal(committed.settlement?.status, 'settled', 'drawing.cut-list cad_commit did not settle');
  assert.ok(committed.commitReceipt, 'drawing.cut-list cad_commit omitted its receipt');
  const table = drawingTable(await readDocument(page), tableId);
  assert.equal(table.name, 'Semantic committed cut list', 'drawing.cut-list cad_commit changed no authoritative table');
  assertStructuralTableContract(table, tableId);
  return { previewOnly, committed };
}

async function assertSemanticLifecycleCommit(
  page: Page,
  operation: JsonRecord,
  label: 'create' | 'delete',
): Promise<JsonRecord> {
  const before = await projectState(page);
  const result = await page.evaluate(async (fixture) => {
    const studio = (window as any).__bwStudio;
    const agent = (window as any).partmodeAgent;
    const authoritativeBefore = {
      docJson: studio.docJson(),
      canonicalHash: studio.canonicalHash(),
      commandRevision: studio.commandRevision(),
      documentRevision: studio.documentRevision(),
      undoDepth: studio.undoDepth(),
      redoDepth: studio.redoDepth(),
    };
    const connection = await studio.connectAgentForTest({
      clientLabel: `WD004 cut-list semantic ${fixture.label}`,
      mode: 'scoped-auto-commit',
      permissionContext: {
        granted: ['project.read', 'project.edit', 'ui.read', 'ui.command-draft', 'ui.present-preview'],
        operationKinds: [fixture.operation.kind],
        maxCommits: 1,
      },
    });
    const token = connection.connectionToken;
    let sequence = 0;
    const request = (tool: string, args: JsonRecord) => agent.requestTool(
      token, tool, args, `wd004-${fixture.label}-${++sequence}`,
    );
    try {
      const transaction = {
        transactionId: `wd004-cut-list-${fixture.label}`,
        label: `Semantic structural cut-list ${fixture.label}`,
        expectedRevision: authoritativeBefore.commandRevision,
        atomic: true,
        operations: [fixture.operation],
      };
      const preview = await request('cad_preview', { transaction });
      const presented = await request('cad_ui', { action: 'snapshot' });
      const changed = preview.changeSet?.[fixture.label === 'create' ? 'created' : 'deleted'] || [];
      const changedTable = changed.find((entry: JsonRecord) => entry.kind === 'drawing-table');
      if (
        typeof preview.previewId !== 'string'
        || preview.baseRevision !== authoritativeBefore.commandRevision
        || preview.validation?.valid !== true
        || preview.validation?.exactGeometry !== true
        || preview.evidence?.exactGeometry !== true
        || preview.changeSet?.documentHashBefore !== authoritativeBefore.canonicalHash
        || preview.changeSet?.documentHashAfter === authoritativeBefore.canonicalHash
        || !changedTable
        || preview.visible !== true
        || presented.preview?.previewId !== preview.previewId
        || presented.preview?.visible !== true
      ) {
        throw new Error(`drawing.cut-list semantic ${fixture.label} preview is incomplete: ${JSON.stringify({
          preview, presented, changed,
        })}`);
      }
      if (fixture.label === 'delete' && preview.confirmation?.required !== true) {
        throw new Error('drawing.cut-list delete preview omitted destructive confirmation evidence');
      }
      const commit = await request('cad_commit', {
        previewId: preview.previewId,
        expectedRevision: preview.baseRevision,
      });
      const closed = await request('cad_ui', { action: 'snapshot' });
      const authoritativeAfter = {
        docJson: studio.docJson(),
        canonicalHash: studio.canonicalHash(),
        commandRevision: studio.commandRevision(),
        documentRevision: studio.documentRevision(),
        undoDepth: studio.undoDepth(),
        redoDepth: studio.redoDepth(),
      };
      if (
        commit.revision !== authoritativeAfter.commandRevision
        || commit.changeSet?.documentHashBefore !== authoritativeBefore.canonicalHash
        || commit.changeSet?.documentHashAfter !== authoritativeAfter.canonicalHash
        || commit.commitReceipt?.previewId !== preview.previewId
        || commit.commitReceipt?.documentHash !== authoritativeAfter.canonicalHash
        || commit.settlement?.status !== 'settled'
        || commit.settlement?.target?.documentHash !== authoritativeAfter.canonicalHash
        || closed.preview
        || JSON.stringify(authoritativeAfter) === JSON.stringify(authoritativeBefore)
      ) {
        throw new Error(`drawing.cut-list semantic ${fixture.label} commit is incomplete: ${JSON.stringify({
          preview, commit, closed, authoritativeBefore, authoritativeAfter,
        })}`);
      }
      return {
        previewId: preview.previewId,
        previewValid: preview.validation.valid,
        previewExact: preview.validation.exactGeometry,
        changedTable,
        confirmationRequired: preview.confirmation?.required === true,
        commitReceipt: commit.commitReceipt,
        settlement: commit.settlement,
      };
    } finally {
      agent.disconnect(token);
    }
  }, { operation, label });
  await assertCurrentSettlement(page, before, `semantic drawing.cut-list ${label} cad_commit`);
  assert.equal(result.previewValid, true, `drawing.cut-list ${label} preview was invalid`);
  assert.equal(result.previewExact, true, `drawing.cut-list ${label} preview was not exact`);
  assert.ok(result.commitReceipt, `drawing.cut-list ${label} commit omitted its receipt`);
  assert.equal(result.settlement?.status, 'settled', `drawing.cut-list ${label} commit did not settle`);
  return result;
}

async function openCutListManager(page: Page): Promise<void> {
  const open = await page.$eval('#bw-drawing-pdf', (element) => (element as HTMLDialogElement).open);
  if (open) {
    await clickVisible(page, '#bw-drawing-pdf-close');
    await waitForDrawingDialog(page, false);
  }
  await clickVisible(page, '[data-workspace="output"]');
  await clickVisible(page, '#bw-drawing-cut-list-open');
  await waitForDrawingDialog(page, true);
  await assertHitTestable(page, '#bw-drawing-table-fieldset');
}

async function selectDrawingTable(page: Page, tableId: string): Promise<void> {
  await selectValue(page, '#bw-drawing-table', tableId);
  await page.waitForFunction((expectedTableId) => {
    const table = document.getElementById('bw-drawing-table') as HTMLSelectElement | null;
    const update = document.getElementById('bw-drawing-table-update') as HTMLButtonElement | null;
    return table?.value === expectedTableId && update?.disabled === false;
  }, { polling: 50, timeout: 30_000 }, tableId);
}

async function closeDrawingManager(page: Page): Promise<void> {
  if (await page.$eval('#bw-drawing-pdf', (element) => (element as HTMLDialogElement).open)) {
    await clickVisible(page, '#bw-drawing-pdf-close');
    await waitForDrawingDialog(page, false);
  }
}

async function waitForDownloadedPdf(directory: string, timeoutMs = 240_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = readdirSync(directory);
    const incomplete = names.some((name) => name.endsWith('.crdownload'));
    const pdf = names.find((name) => name.toLowerCase().endsWith('.pdf'));
    if (!incomplete && pdf) {
      const path = resolve(directory, pdf);
      if (statSync(path).size > 1_000) return path;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`visible PDF download did not complete in ${timeoutMs} ms`);
}

let local: RunningPartModeServer | undefined;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
let kernel: HeadlessKernel | undefined;

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
  await page.setViewport({ width: 1800, height: 1300, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('bw-studio-welcome-v1', '1');
    (window as any).__wd004Injected = false;
    (window as any).__wd004DrawingRequests = [];
    const originalPostMessage = Worker.prototype.postMessage;
    (Worker.prototype as any).postMessage = function captureWd004DrawingRequest(...args: any[]) {
      const request = args[0];
      if (request?.kind === 'drawing-v5') {
        (window as any).__wd004DrawingRequests.push(structuredClone(request));
      }
      return (originalPostMessage as any).apply(this, args);
    };
  });
  await (context as unknown as {
    setDownloadBehavior: (behavior: { policy: 'allow'; downloadPath: string }) => Promise<void>;
  }).setDownloadBehavior({
    policy: 'allow',
    downloadPath: downloadDirectory,
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
  assert.equal(response?.status(), 200, 'weldment cut-list UI route did not return HTTP 200');
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);

  const registry = await registryAudit(page);
  assert.equal(registry.count, 1, 'drawing.cut-list is not uniquely registered');
  assert.equal(registry.control?.adapter, 'available', 'drawing.cut-list is not an available semantic adapter');
  assert.equal(registry.control?.workspaceId, 'output', 'drawing.cut-list is registered in the wrong workspace');
  assert.equal(registry.control?.semanticAction, 'document.previewCommit',
    'drawing.cut-list falsely advertises a command-dialog semantic action');
  assert.equal(registry.control?.adapterTool, 'cad_preview', 'drawing.cut-list does not truthfully advertise cad_preview');
  assert.equal(registry.control?.completionTool, 'cad_commit', 'drawing.cut-list does not truthfully advertise cad_commit');
  assert.deepEqual(registry.control?.humanBindings,
    [{ kind: 'element-id', elementId: 'bw-drawing-cut-list-open' }],
    'drawing.cut-list is not bound to the visible ribbon control');
  assert.deepEqual(registry.control?.operationKinds,
    ['drawing.table.create', 'drawing.table.update', 'drawing.table.delete'],
    'drawing.cut-list advertises the wrong typed operations');
  assert.deepEqual(registry.control?.fields?.map((field: JsonRecord) => field.id), [
    'tableId', 'kind', 'sheetId', 'name', 'positionMm', 'widthMm',
    'sourceType', 'sourceMemberIds', 'axis', 'sourceBodyIds',
  ], 'drawing.cut-list field contract is incomplete or contains authored derived values');

  const beforeSeed = await projectState(page);
  await page.evaluate((fixture) => (window as any).__bwStudio.commitHumanOperationsForTest(
    'Seed perpendicular treated members for WD004 UI acceptance',
    [
      { kind: 'project.clear', input: {} },
      {
        kind: 'sketch.path.create',
        input: { id: fixture.pathAId, name: 'Member A Path', curveKind: 'polyline', points: [[-100, 0, 0], [0, 0, 0]] },
      },
      {
        kind: 'sketch.path.create',
        input: { id: fixture.pathBId, name: 'Member B Path', curveKind: 'polyline', points: [[0, 0, 0], [0, 100, 0]] },
      },
      {
        kind: 'structural.member.create',
        input: {
          id: fixture.memberAId, name: fixture.memberAName, pathSketchId: fixture.pathAId,
          familyId: 'rectangular-bar', presetId: 'rect-20x10',
        },
      },
      {
        kind: 'structural.member.create',
        input: {
          id: fixture.memberBId, name: 'Perpendicular member', pathSketchId: fixture.pathBId,
          familyId: 'rectangular-bar', presetId: 'rect-20x10',
        },
      },
      {
        kind: 'structural.treatment.create',
        input: {
          id: fixture.treatmentId, name: 'Initial miter', kind: 'corner',
          targetMemberId: fixture.memberAId, targetEnd: 'end',
          otherMemberId: fixture.memberBId, otherEnd: 'start', style: 'miter',
        },
      },
    ],
  ), {
    pathAId: PATH_A_ID,
    pathBId: PATH_B_ID,
    memberAId: MEMBER_A_ID,
    memberBId: MEMBER_B_ID,
    memberAName: HTML_LIKE_MEMBER_NAME,
    treatmentId: TREATMENT_ID,
  });
  await assertCurrentSettlement(page, beforeSeed, 'perpendicular mitered member seed');
  let document = await readDocument(page);
  let part = rootPart(document);
  assert.equal(part.features.filter((entry: JsonRecord) => entry.extensions?.structuralMember).length, 2,
    'browser fixture does not contain exactly two structural members');
  assert.equal(part.features.find((entry: JsonRecord) => entry.id === TREATMENT_ID)
    ?.extensions?.weldmentTreatment?.style, 'miter', 'browser fixture did not persist the miter treatment');

  await openCutListManager(page);
  assert.equal(await page.$eval('#bw-drawing-book-initialize', (element) => (element as HTMLButtonElement).disabled), false,
    'drawing-set initialization is not available from the cut-list manager');
  let beforeUiMutation = await projectState(page);
  await clickVisible(page, '#bw-drawing-book-initialize');
  await assertCurrentSettlement(page, beforeUiMutation, 'visible drawing-set initialization');
  await assertDrawingTablePanels(page, 'structural-member');
  assert.equal(await page.$eval('#bw-drawing-table-kind', (element) => (element as HTMLSelectElement).disabled), false,
    'new-table kind is unexpectedly locked');
  assert.equal(await page.$eval('#bw-drawing-table-source-type', (element) => (element as HTMLSelectElement).disabled), false,
    'new-table source type is unexpectedly locked');
  await selectValue(page, '#bw-drawing-table-members', MEMBER_A_ID);
  const memberOptions = await page.$$eval('#bw-drawing-table-members option', (options) =>
    options.map((option) => ({ value: (option as HTMLOptionElement).value, text: option.textContent || '' })));
  assert.equal(memberOptions.length, 2, 'cut-list manager did not show exactly the two active structural members');
  assert.ok(memberOptions.find((entry) => entry.value === MEMBER_A_ID)?.text.startsWith(HTML_LIKE_MEMBER_NAME),
    'cut-list manager did not preserve the literal member name as option text');
  assert.equal(await page.$('#bw-drawing-pdf img[src="x"]'), null,
    'HTML-like member name created an element in the drawing manager');
  assert.equal(await page.evaluate(() => (window as any).__wd004Injected), false,
    'HTML-like member name executed in the drawing manager');
  assert.match(await page.$eval('#bw-drawing-table-member-summary', (element) => element.textContent || ''),
    /1 member selected/u, 'visible member selection summary is stale');
  await replaceValue(page, '#bw-drawing-table-name', 'Associative structural cut list');
  await replaceValue(page, '#bw-drawing-table-position', '14,18');
  assert.equal(await page.$eval('#bw-drawing-table-width', (element) => (element as HTMLInputElement).value), '240',
    'structural cut-list manager did not use the eight-column width');
  beforeUiMutation = await projectState(page);
  await clickVisible(page, '#bw-drawing-table-add');
  await assertCurrentSettlement(page, beforeUiMutation, 'visible structural cut-list create');
  assert.equal(await page.$eval('#bw-drawing-table-error', (element) => element.textContent || ''), '',
    'visible cut-list create reported a local validation error');
  document = await readDocument(page);
  assert.equal(document.extensions?.drawingTables?.tables?.length, 1,
    'visible cut-list create did not persist exactly one table');
  const tableId = document.extensions.drawingTables.tables[0].id;
  assertStructuralTableContract(drawingTable(document, tableId), tableId);
  assert.deepEqual(drawingTable(document, tableId).positionMm, [14, 18], 'visible manager persisted the wrong position');
  assert.equal(drawingTable(document, tableId).widthMm, 240, 'visible manager persisted the wrong width');
  await selectDrawingTable(page, tableId);
  await assertDrawingTablePanels(page, 'structural-member');
  assert.equal(await page.$eval('#bw-drawing-table-kind', (element) => (element as HTMLSelectElement).disabled), true,
    'editing permits table-kind reassociation');
  assert.equal(await page.$eval('#bw-drawing-table-source-type', (element) => (element as HTMLSelectElement).disabled), true,
    'editing permits cut-list-source reassociation');
  assert.equal(await page.$eval('#bw-drawing-table-delete', (element) => (element as HTMLButtonElement).disabled), false,
    'visible manager did not expose cut-list delete');

  kernel = await createHeadlessKernel();
  await kernel.waitForKernel(180_000);
  let exact = await exactDrawingPdf(kernel, document, tableId, 'miter-100');
  assertResolvedMemberRow(exact, { lengthMm: 100, start: 0, end: 45 }, 'initial end-miter cut list');

  await page.evaluate(async () => (window as any).__bwStudio.flushStorage());
  const savedState = await projectState(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  const reopenedState = await projectState(page);
  assert.equal(reopenedState.docJson, savedState.docJson, 'save/reload changed the canonical cut-list document bytes');
  assert.equal(reopenedState.canonicalHash, savedState.canonicalHash, 'save/reload changed the cut-list document hash');
  document = await readDocument(page);
  assertStructuralTableContract(drawingTable(document, tableId), tableId);
  assert.equal(await page.evaluate(() => (window as any).__wd004Injected), false,
    'persisted HTML-like member name executed after reload');
  await openCutListManager(page);
  await selectDrawingTable(page, tableId);
  await assertDrawingTablePanels(page, 'structural-member');

  const semantic = await assertSemanticCutListPreviewCommit(page, tableId);
  document = await readDocument(page);
  const mainTableAfterSemanticUpdate = structuredClone(drawingTable(document, tableId));
  const temporaryName = 'Semantic temporary structural cut list';
  const temporaryCreate = await assertSemanticLifecycleCommit(page, {
    kind: 'drawing.table.create',
    input: {
      kind: 'cut-list',
      sheetId: mainTableAfterSemanticUpdate.sheetId,
      name: temporaryName,
      positionMm: [32, 34],
      widthMm: 240,
      sourceType: 'structural-member',
      sourceMemberIds: [MEMBER_A_ID],
    },
  }, 'create');
  document = await readDocument(page);
  assert.equal(document.extensions?.drawingTables?.tables?.length, 2,
    'semantic cut-list create did not add exactly one authoritative table');
  assert.deepEqual(drawingTable(document, tableId), mainTableAfterSemanticUpdate,
    'semantic temporary create changed the main table');
  const temporaryTable = document.extensions.drawingTables.tables.find((entry: JsonRecord) => entry.name === temporaryName);
  assert.ok(temporaryTable, 'semantic cut-list create omitted the authoritative temporary table');
  assert.equal(temporaryCreate.changedTable.id, temporaryTable.id,
    'semantic create preview evidence named a different drawing table');
  assertStructuralTableContract(temporaryTable, temporaryTable.id);
  const temporaryDelete = await assertSemanticLifecycleCommit(page, {
    kind: 'drawing.table.delete',
    input: { tableId: temporaryTable.id },
  }, 'delete');
  document = await readDocument(page);
  assert.equal(document.extensions?.drawingTables?.tables?.length, 1,
    'semantic temporary delete did not restore one authoritative table');
  assert.equal(temporaryDelete.changedTable.id, temporaryTable.id,
    'semantic delete preview evidence named a different drawing table');
  assert.equal(temporaryDelete.confirmationRequired, true,
    'semantic delete did not retain destructive-confirmation evidence');
  assert.deepEqual(drawingTable(document, tableId), mainTableAfterSemanticUpdate,
    'semantic temporary delete changed the main table');
  await closeDrawingManager(page);
  await openCutListManager(page);
  await selectDrawingTable(page, tableId);
  beforeUiMutation = await projectState(page);
  await replaceValue(page, '#bw-drawing-table-name', 'Visible edited structural cut list');
  await replaceValue(page, '#bw-drawing-table-position', '22,24');
  await clickVisible(page, '#bw-drawing-table-update');
  await assertCurrentSettlement(page, beforeUiMutation, 'visible structural cut-list update');
  document = await readDocument(page);
  assert.equal(document.extensions?.drawingTables?.tables?.length, 1, 'visible update duplicated the drawing table');
  assertStructuralTableContract(drawingTable(document, tableId), tableId);
  assert.equal(drawingTable(document, tableId).name, 'Visible edited structural cut list',
    'visible manager did not persist the edited table name');
  assert.deepEqual(drawingTable(document, tableId).positionMm, [22, 24],
    'visible manager did not persist the edited table position');

  await closeDrawingManager(page);
  beforeUiMutation = await projectState(page);
  await page.evaluate((fixture) => (window as any).__bwStudio.commitHumanOperationsForTest(
    'Extend WD004 member Path associatively',
    [{
      kind: 'sketch.advanced.update',
      input: { sketchId: fixture.pathId, patch: { kind: 'polyline', points: [[-120, 0, 0], [0, 0, 0]] } },
    }],
  ), { pathId: PATH_A_ID });
  await assertCurrentSettlement(page, beforeUiMutation, 'associative Path edit');
  document = await readDocument(page);
  assertStructuralTableContract(drawingTable(document, tableId), tableId);
  exact = await exactDrawingPdf(kernel, document, tableId, 'miter-120');
  assertResolvedMemberRow(exact, { lengthMm: 120, start: 0, end: 45 }, 'Path-edited end-miter cut list');

  await clickVisible(page, '[data-workspace="solid"]');
  const treatmentSelector = `#bw-history .hist-item[data-sel="${TREATMENT_ID}"]`;
  await page.waitForSelector(treatmentSelector, { visible: true, timeout: 30_000 });
  beforeUiMutation = await projectState(page);
  await clickVisible(page, `${treatmentSelector} [data-edit="${TREATMENT_ID}"]`);
  await page.waitForFunction(() =>
    (document.getElementById('bw-structural-treatment') as HTMLDialogElement | null)?.open === true,
  { polling: 50, timeout: 30_000 });
  assert.equal(await page.$eval('#bw-structural-treatment-kind', (element) => (element as HTMLSelectElement).disabled), true,
    'visible treatment edit permits treatment-kind reassociation');
  for (const name of ['cornerTargetMemberId', 'cornerTargetEnd', 'cornerOtherMemberId', 'cornerOtherEnd']) {
    assert.equal(await page.$eval(`#bw-structural-treatment-form [name="${name}"]`,
      (element) => (element as HTMLSelectElement).disabled), true,
    `visible treatment edit permits ${name} reassociation`);
  }
  await selectValue(page, '#bw-structural-treatment-form [name="cornerStyle"]', 'cope');
  await clickVisible(page, '#bw-structural-treatment-apply');
  await page.waitForFunction(() =>
    (document.getElementById('bw-structural-treatment') as HTMLDialogElement | null)?.open === false,
  { polling: 50, timeout: 30_000 });
  await assertCurrentSettlement(page, beforeUiMutation, 'visible miter-to-cope treatment edit');
  document = await readDocument(page);
  part = rootPart(document);
  const treatment = part.features.find((entry: JsonRecord) => entry.id === TREATMENT_ID);
  assert.equal(treatment?.id, TREATMENT_ID, 'miter-to-cope edit replaced treatment identity');
  assert.equal(treatment?.extensions?.weldmentTreatment?.style, 'cope', 'visible treatment edit did not persist cope');
  assert.equal(treatment?.extensions?.weldmentTreatment?.targetMemberId, MEMBER_A_ID,
    'visible treatment edit changed the target-member association');
  assert.equal(treatment?.extensions?.weldmentTreatment?.otherMemberId, MEMBER_B_ID,
    'visible treatment edit changed the other-member association');
  assert.equal(treatment?.extensions?.weldmentTreatment?.targetEnd, 'end',
    'visible treatment edit changed the target endpoint');
  assertStructuralTableContract(drawingTable(document, tableId), tableId);
  exact = await exactDrawingPdf(kernel, document, tableId, 'cope-120');
  assertResolvedMemberRow(exact, { lengthMm: 120, start: 0, end: 'COPE' }, 'treatment-edited end-cope cut list');

  await openCutListManager(page);
  await selectDrawingTable(page, tableId);
  await clickVisible(page, '#bw-drawing-pdf-download');
  await waitForDrawingDialog(page, false);
  const downloadedPdfPath = await waitForDownloadedPdf(downloadDirectory);
  const visibleExport = await page.evaluate(() => {
    const studio = (window as any).__bwStudio;
    const requests = (window as any).__wd004DrawingRequests || [];
    return {
      requestCount: requests.length,
      request: requests.at(-1) || null,
      canonicalHash: studio.canonicalHash(),
      documentRevision: studio.documentRevision(),
      message: document.getElementById('bw-studio-msg')?.textContent || '',
    };
  });
  assert.equal(visibleExport.requestCount, 1,
    'visible PDF control did not issue exactly one browser drawing-v5 request');
  assert.equal(visibleExport.request?.kind, 'drawing-v5',
    'visible PDF control did not invoke the production drawing worker');
  assert.equal(visibleExport.request?.revision, visibleExport.documentRevision,
    'visible PDF request was not current-browser-revision-bound');
  assert.equal(runtime.studioV5CanonicalHash(visibleExport.request?.document), visibleExport.canonicalHash,
    'visible PDF request was not current-document-hash-bound');
  const requestedDocument = visibleExport.request.document as JsonRecord;
  assertStructuralTableContract(drawingTable(requestedDocument, tableId), tableId);
  const requestedPart = rootPart(requestedDocument);
  assert.deepEqual(requestedPart.sketches.find((entry: JsonRecord) => entry.id === PATH_A_ID)?.entities?.[0]?.points,
  [[-120, 0, 0], [0, 0, 0]], 'visible PDF request omitted the current 120 mm Path');
  assert.equal(requestedPart.features.find((entry: JsonRecord) => entry.id === TREATMENT_ID)
    ?.extensions?.weldmentTreatment?.style, 'cope',
  'visible PDF request omitted the current cope treatment');
  assert.match(visibleExport.message, /1-sheet drawing PDF exported/u,
    'visible PDF control did not report a successful browser export');
  const downloadedPdf = readFileSync(downloadedPdfPath);
  assert.ok(downloadedPdf.length > 1_000, 'visible browser download produced no substantive PDF');
  assert.equal(downloadedPdf.subarray(0, 8).toString('ascii'), '%PDF-1.7',
    'visible browser download is not the production PDF 1.7 artifact');
  const pdfinfo = spawnSync('pdfinfo', [downloadedPdfPath], { encoding: 'utf8' });
  assert.equal(pdfinfo.status, 0,
    `independent pdfinfo rejected the visible browser artifact: ${pdfinfo.stderr || pdfinfo.stdout}`);
  assert.match(pdfinfo.stdout, /^Pages:\s+1\s*$/mu, 'visible browser artifact does not contain one drawing sheet');
  assert.match(pdfinfo.stdout, /^PDF version:\s+1\.7\s*$/mu, 'visible browser artifact reports the wrong PDF version');
  const pdftotext = spawnSync('pdftotext', [downloadedPdfPath, '-'], { encoding: 'utf8' });
  assert.equal(pdftotext.status, 0,
    `independent pdftotext rejected the visible browser artifact: ${pdftotext.stderr || pdftotext.stdout}`);
  assert.match(pdftotext.stdout, /Visible edited structural cut list/u,
    'visible browser artifact omitted the current persistent table');
  assert.match(pdftotext.stdout, /\b120(?:\.0+)?\b/u,
    'visible browser artifact omitted the current exact 120 mm length');
  assert.match(pdftotext.stdout, /\bCOPE\b/u,
    'visible browser artifact omitted the current exact cope classification');
  assert.match(pdftotext.stdout, /START.*OFF SQ|START\s+°\s+OFF\s+SQ/su,
    'visible browser artifact omitted the structural cut-list headers');
  const visiblePdf = {
    bytes: downloadedPdf.length,
    sha256: createHash('sha256').update(downloadedPdf).digest('hex'),
    pages: 1,
    version: '1.7',
    currentLengthMm: 120,
    currentEndTreatment: 'COPE',
  };

  await openCutListManager(page);
  await selectDrawingTable(page, tableId);
  beforeUiMutation = await projectState(page);
  await clickVisible(page, '#bw-drawing-table-delete');
  await assertCurrentSettlement(page, beforeUiMutation, 'visible structural cut-list delete');
  document = await readDocument(page);
  assert.equal(document.extensions?.drawingTables?.tables?.length, 0,
    'visible cut-list delete left a persistent drawing table');
  assert.equal(await page.$eval('#bw-drawing-table option', (element) => (element as HTMLOptionElement).value), '',
    'visible manager still lists the deleted drawing table');
  assert.deepEqual(failures, [], `weldment cut-list browser gate reported errors: ${failures.join(' | ')}`);

  console.log(JSON.stringify({
    schema: 'partmode.weldment-cut-lists-ui-smoke/v1',
    browserBacked: true,
    registeredControl: 'drawing.cut-list',
    visibleLifecycle: ['create', 'save-reload', 'update', 'delete'],
    persistentAssociation: { tableId, sourceMemberIds: [MEMBER_A_ID], authoredDerivedValues: false },
    associativeEvidence: {
      pathLengthMm: [100, 120],
      treatment: {
        targetEnd: 'end',
        before: { endAngleOffSquareDeg: 45 },
        after: { end: 'COPE', angleOffSquareDeg: null },
      },
      tableIdentityPreserved: true,
      exactCurrentHashBound: true,
      exactBrepTopologyBound: true,
      pdfHeaders: EXPECTED_HEADERS,
    },
    semanticAdapter: {
      previewDismissedWithoutMutation: semantic.previewOnly.documentUnchanged,
      committedOperations: ['drawing.table.create', 'drawing.table.update', 'drawing.table.delete'],
      committedVia: ['cad_preview', 'cad_commit'],
      temporaryLifecyclePreservedMainTable: true,
    },
    visiblePdfArtifact: visiblePdf,
    inactiveBodyAxisControlsDisabled: true,
    htmlLikeMemberNameEscaped: true,
    consoleNetworkResponsePageErrors: 0,
  }, null, 2));
} finally {
  await kernel?.dispose();
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
