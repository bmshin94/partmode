import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import puppeteer, { type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-advanced-patterns-ui-'));
const SOURCE_BODY_ID = 'body-pattern-source';
const DIRECTION_DATUM_ID = 'datum-pattern-direction';
const PLANE_DATUM_ID = 'datum-pattern-xy-plane';
const POINT_SKETCH_ID = 'sketch-pattern-points';
const DERIVED_POINT_SKETCH_ID = 'sketch-pattern-points-derived';
const BOUNDARY_SKETCH_ID = 'sketch-fill-boundary';
const HTML_LIKE_PATTERN_NAME = '<img src=x onerror="window.__pt007Injected=true"> Sketch pattern';

const pointSketchSource = {
  entities: [
    { id: 'pattern-seed', kind: 'point', at: [0, 0], fixed: true },
    { id: 'pattern-point-x', kind: 'point', at: [20, 0] },
    { id: 'pattern-point-y', kind: 'point', at: [0, 18] },
  ],
  constraints: [
    { id: 'pattern-point-x-horizontal', kind: 'horizontalDistance', a: 'pattern-seed', b: 'pattern-point-x', value: 20 },
    { id: 'pattern-point-x-vertical', kind: 'verticalDistance', a: 'pattern-seed', b: 'pattern-point-x', value: 0 },
    { id: 'pattern-point-y-horizontal', kind: 'horizontalDistance', a: 'pattern-seed', b: 'pattern-point-y', value: 0 },
    { id: 'pattern-point-y-vertical', kind: 'verticalDistance', a: 'pattern-seed', b: 'pattern-point-y', value: 18 },
  ],
};

function rootPart(document: JsonRecord): JsonRecord {
  const part = document.partDefinitions?.find((entry: JsonRecord) => entry.id === document.rootDocument?.partId)
    || document.partDefinitions?.[0];
  assert.ok(part, 'browser document has no active part definition');
  return part;
}

async function readDocument(page: Page): Promise<JsonRecord> {
  return page.evaluate(() => JSON.parse((window as any).__bwStudio.docJson()));
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

async function waitForSettlement(page: Page): Promise<void> {
  try {
    await page.waitForFunction(() => {
      const studio = (window as any).__bwStudio;
      return studio
        && studio.mode()?.kind === 'idle'
        && studio.appliedRevision() === studio.documentRevision();
    }, { polling: 100, timeout: 180_000 });
  } catch (error) {
    const state = await page.evaluate(() => {
      const studio = (window as any).__bwStudio;
      return {
        present: Boolean(studio),
        projectId: studio?.projectId?.() ?? null,
        commandRevision: studio?.commandRevision?.() ?? null,
        documentRevision: studio?.documentRevision?.() ?? null,
        appliedRevision: studio?.appliedRevision?.() ?? null,
        mode: studio?.mode?.() ?? null,
        errors: studio?.errors?.() ?? [],
        message: document.getElementById('bw-studio-msg')?.textContent || '',
        commandError: document.getElementById('bw-v5-command-error')?.textContent || '',
      };
    });
    throw new Error(`advanced-pattern browser document did not settle: ${JSON.stringify(state)}`, { cause: error });
  }
}

async function waitForMutation(page: Page, before: JsonRecord, label: string): Promise<void> {
  try {
    await page.waitForFunction((previousRevision) => {
      const studio = (window as any).__bwStudio;
      return studio
        && studio.documentRevision() > previousRevision
        && studio.appliedRevision() === studio.documentRevision()
        && studio.mode()?.kind === 'idle';
    }, { polling: 100, timeout: 180_000 }, before.documentRevision);
  } catch (error) {
    const state = await projectState(page);
    const diagnostic = await page.evaluate(() => ({
      dialogOpen: (document.getElementById('bw-v5-command') as HTMLDialogElement | null)?.open === true,
      commandError: document.getElementById('bw-v5-command-error')?.textContent || '',
      message: document.getElementById('bw-studio-msg')?.textContent || '',
      errors: (window as any).__bwStudio?.errors?.() ?? [],
    }));
    throw new Error(`${label} did not settle: ${JSON.stringify({ state, diagnostic })}`, { cause: error });
  }
  assert.deepEqual(await page.evaluate(() => (window as any).__bwStudio.errors()), [], `${label} reported CAD errors`);
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
      if (!(element instanceof HTMLElement)) return { visible: false, owns: false, disabled: true };
      const style = getComputedStyle(element);
      const target = document.elementFromPoint(location.x, location.y);
      return {
        visible: !element.hidden && style.display !== 'none' && style.visibility !== 'hidden',
        owns: Boolean(target && (target === element || element.contains(target))),
        disabled: (element instanceof HTMLButtonElement
          || element instanceof HTMLInputElement
          || element instanceof HTMLSelectElement
          || element instanceof HTMLTextAreaElement) && element.disabled,
      };
    }, point);
    assert.equal(state.visible, true, `control is hidden: ${selector}`);
    assert.equal(state.owns, true, `control does not own its center hit target: ${selector}`);
    assert.equal(state.disabled, false, `control is disabled: ${selector}`);
  } finally {
    await control.dispose();
  }
}

async function clickVisible(page: Page, selector: string): Promise<void> {
  await assertHitTestable(page, selector);
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
      throw new Error(`expected editable input: ${element.id || element.getAttribute('name')}`);
    }
    element.value = nextValue;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function selectValue(page: Page, selector: string, value: string): Promise<void> {
  await assertHitTestable(page, selector);
  const selected = await page.select(selector, value);
  assert.deepEqual(selected, [value], `visible select rejected ${JSON.stringify(value)}: ${selector}`);
}

async function waitForPatternDialog(page: Page, open: boolean): Promise<void> {
  await page.waitForFunction((expectedOpen) => {
    const dialog = document.getElementById('bw-v5-command') as HTMLDialogElement | null;
    return dialog?.open === expectedOpen;
  }, { polling: 50, timeout: 30_000 }, open);
}

async function ensureSourceBodySelected(page: Page): Promise<void> {
  const selector = `[data-body-id="${SOURCE_BODY_ID}"] [data-body-action="select"]`;
  await assertHitTestable(page, selector);
  const selected = await page.$eval(selector, (element) => element.getAttribute('aria-pressed') === 'true');
  if (!selected) await clickVisible(page, selector);
}

async function openPatternCreate(page: Page): Promise<void> {
  await clickVisible(page, '[data-workspace="solid"]');
  await ensureSourceBodySelected(page);
  await clickVisible(page, '[data-v5-command="pattern"]');
  await waitForPatternDialog(page, true);
  assert.equal(await page.$eval('#bw-v5-command', (element) => (element as HTMLDialogElement).dataset.command), 'pattern',
    'Pattern ribbon button opened the wrong visible command');
  for (const selector of [
    '#bw-v5-command-form [name="name"]',
    '#bw-v5-command-form [name="sourceBodyId"]',
    '#bw-v5-command-form [name="patternKind"]',
    '#bw-v5-command-form [name="outputMode"]',
    '#bw-v5-command-apply',
  ]) await assertHitTestable(page, selector);
}

async function openPatternEdit(page: Page, patternId: string): Promise<void> {
  const selector = `[data-pattern-id="${patternId}"] [data-pattern-action="edit"]`;
  await clickVisible(page, selector);
  await waitForPatternDialog(page, true);
  assert.equal(await page.$eval('#bw-v5-command', (element) => (element as HTMLDialogElement).dataset.patternId), patternId,
    'visible pattern tree opened a different pattern');
}

async function applyPatternForm(page: Page, label: string): Promise<void> {
  const before = await projectState(page);
  await clickVisible(page, '#bw-v5-command-apply');
  await waitForPatternDialog(page, false);
  await waitForMutation(page, before, label);
}

async function createSketchPattern(page: Page): Promise<string> {
  await openPatternCreate(page);
  const pointSketchOptions = await page.$$eval(
    '#bw-v5-command-form [name="pointSketchId"] option',
    (options) => options.map((option) => (option as HTMLOptionElement).value),
  );
  assert.ok(pointSketchOptions.includes(POINT_SKETCH_ID),
    'visible sketch-pattern selector omitted the direct constrained sketch');
  assert.equal(pointSketchOptions.includes(DERIVED_POINT_SKETCH_ID), false,
    'visible sketch-pattern selector offered a derived constrained sketch');
  await replaceValue(page, '#bw-v5-command-form [name="name"]', HTML_LIKE_PATTERN_NAME);
  await selectValue(page, '#bw-v5-command-form [name="patternKind"]', 'sketch');
  await selectValue(page, '#bw-v5-command-form [name="outputMode"]', 'linked');
  await selectValue(page, '#bw-v5-command-form [name="pointSketchId"]', POINT_SKETCH_ID);
  await replaceValue(page, '#bw-v5-command-form [name="pointIds"]', 'pattern-seed\npattern-point-x\npattern-point-y');
  await applyPatternForm(page, 'visible sketch-pattern create');
  const pattern = rootPart(await readDocument(page)).bodyPatterns.find((entry: JsonRecord) => entry.name === HTML_LIKE_PATTERN_NAME);
  assert.ok(pattern, 'visible sketch-pattern create did not persist a pattern');
  assert.equal(pattern.kind, 'sketch', 'visible sketch-pattern create persisted the wrong kind');
  assert.equal(pattern.definition.count, 3, 'visible sketch-pattern count was not derived from point IDs');
  return pattern.id;
}

async function createFillPattern(page: Page): Promise<string> {
  await openPatternCreate(page);
  await replaceValue(page, '#bw-v5-command-form [name="name"]', 'Visible square fill & literal <boundary>');
  await selectValue(page, '#bw-v5-command-form [name="patternKind"]', 'fill');
  await selectValue(page, '#bw-v5-command-form [name="outputMode"]', 'linked');
  await selectValue(page, '#bw-v5-command-form [name="boundarySketchId"]', BOUNDARY_SKETCH_ID);
  await selectValue(page, '#bw-v5-command-form [name="fillLayout"]', 'square');
  await replaceValue(page, '#bw-v5-command-form [name="spacing"]', '10');
  await replaceValue(page, '#bw-v5-command-form [name="fillRotation"]', '0');
  await replaceValue(page, '#bw-v5-command-form [name="boundaryMargin"]', '4');
  await replaceValue(page, '#bw-v5-command-form [name="seedX"]', '0');
  await replaceValue(page, '#bw-v5-command-form [name="seedY"]', '0');
  await replaceValue(page, '#bw-v5-command-form [name="maximumCount"]', '64');
  await applyPatternForm(page, 'visible fill-pattern create');
  const pattern = rootPart(await readDocument(page)).bodyPatterns.find((entry: JsonRecord) => entry.kind === 'fill');
  assert.ok(pattern, 'visible fill-pattern create did not persist a pattern');
  assert.equal(pattern.definition.layout, 'square', 'visible fill-pattern create persisted the wrong lattice');
  return pattern.id;
}

async function createVariablePattern(page: Page): Promise<string> {
  await openPatternCreate(page);
  await replaceValue(page, '#bw-v5-command-form [name="name"]', 'Visible variable pattern "literal"');
  await selectValue(page, '#bw-v5-command-form [name="patternKind"]', 'variable');
  await selectValue(page, '#bw-v5-command-form [name="outputMode"]', 'linked');
  await selectValue(page, '#bw-v5-command-form [name="directionDatumId"]', DIRECTION_DATUM_ID);
  await replaceValue(page, '#bw-v5-command-form [name="variableInstances"]', JSON.stringify([
    { position: 18, parameterOverrides: { source_height: 10 } },
    { position: 36, parameterOverrides: { source_height: 12 } },
  ], null, 2));
  await applyPatternForm(page, 'visible variable-pattern create');
  const pattern = rootPart(await readDocument(page)).bodyPatterns.find((entry: JsonRecord) => entry.kind === 'variable');
  assert.ok(pattern, 'visible variable-pattern create did not persist a pattern');
  assert.equal(pattern.definition.count, 3, 'visible variable-pattern count was not derived from rows');
  return pattern.id;
}

async function assertLiteralEscaping(page: Page, sketchPatternId: string): Promise<void> {
  assert.equal(await page.evaluate(() => (window as any).__pt007Injected), false,
    'HTML-like pattern name executed script');
  assert.equal(await page.$(`[data-pattern-id="${sketchPatternId}"] img`), null,
    'HTML-like pattern name created an element in the model tree');
  const visibleName = await page.$eval(
    `[data-pattern-id="${sketchPatternId}"] [data-pattern-action="edit"] span`,
    (element) => element.textContent || '',
  );
  assert.equal(visibleName, HTML_LIKE_PATTERN_NAME, 'visible tree did not preserve the literal pattern name');
}

async function exactPatternSettlement(
  page: Page,
  patternIds: Record<'sketch' | 'fill' | 'variable', string>,
): Promise<JsonRecord> {
  await waitForSettlement(page);
  const snapshot = await page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    return {
      exact: await studio.exactBodyResultsForTest(),
      ordinary: studio.bodyResults(),
      canonicalHash: studio.canonicalHash(),
      documentRevision: studio.documentRevision(),
      appliedRevision: studio.appliedRevision(),
      errors: studio.errors(),
    };
  });
  assert.equal(snapshot.documentRevision, snapshot.appliedRevision, 'visible advanced-pattern document is not settled');
  assert.equal(snapshot.exact.revision, snapshot.documentRevision, 'isolated exact evidence is stale');
  assert.equal(snapshot.exact.effectiveDocumentHash, snapshot.canonicalHash,
    'isolated exact evidence is not bound to the current canonical document hash');
  assert.deepEqual(snapshot.errors, [], 'visible advanced-pattern rebuild reported errors');
  assert.deepEqual(snapshot.exact.errors, [], 'isolated production-worker advanced-pattern rebuild reported errors');

  const result: JsonRecord = {};
  for (const [kind, patternId] of Object.entries(patternIds)) {
    const ordinary = snapshot.ordinary
      .filter((entry: JsonRecord) => entry.patternInstance?.patternId === patternId)
      .sort((left: JsonRecord, right: JsonRecord) => left.patternInstance.index - right.patternInstance.index);
    const exact = snapshot.exact.bodies
      .filter((entry: JsonRecord) => entry.bodyId.startsWith(patternId + '-instance-'))
      .sort((left: JsonRecord, right: JsonRecord) => left.bodyId.localeCompare(right.bodyId));
    assert.ok(ordinary.length > 0, `${kind} pattern produced no visible occurrences`);
    assert.equal(exact.length, ordinary.length, `${kind} isolated exact occurrence count disagrees with the visible worker`);
    for (const entry of exact) {
      assert.equal(entry.error, null, `${kind} exact occurrence has an error`);
      assert.equal(entry.lastValid, false, `${kind} exact occurrence fell back to stale geometry`);
      assert.equal(entry.geometry?.valid, true, `${kind} exact occurrence is invalid`);
      assert.equal(entry.geometry?.brepValid, true, `${kind} exact occurrence failed BRepCheck`);
      assert.equal(entry.geometry?.solidCount, 1, `${kind} exact occurrence is not one solid`);
      assert.ok(entry.geometry?.volume > 0, `${kind} exact occurrence has no positive volume`);
      const visible = ordinary.find((candidate: JsonRecord) => candidate.bodyId === entry.bodyId);
      assert.ok(visible, `${kind} exact occurrence is absent from the visible settled worker`);
      assert.deepEqual(visible.geometry?.bounds, entry.geometry.bounds,
        `${kind} visible and isolated exact bounds disagree for ${entry.bodyId}`);
    }
    result[kind] = { ordinary, exact };
  }

  const variableExact = result.variable.exact as JsonRecord[];
  const variableOrdinary = result.variable.ordinary as JsonRecord[];
  assert.ok(variableExact.every((entry) => typeof entry.exactBrep === 'string' && entry.exactBrep.length > 100),
    'variable occurrences did not publish their own exact B-reps');
  assert.equal(new Set(variableExact.map((entry) => entry.exactBrep)).size, variableExact.length,
    'variable occurrences published duplicate placed B-reps');
  assert.equal(new Set(variableExact.map((entry) => Number(entry.geometry.volume).toFixed(8))).size, variableExact.length,
    'variable parameter rows did not produce distinct exact volumes');
  assert.equal(new Set(variableOrdinary.map((entry) => entry.patternInstance?.variableSeedBrepSha256)).size,
    variableOrdinary.length, 'variable parameter rows did not produce distinct seed B-rep evidence');
  return result;
}

async function semanticVariableCommandPreview(page: Page, patternId: string): Promise<JsonRecord> {
  return page.evaluate(async (input) => {
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
      clientLabel: 'PT007 semantic model.pattern command preview',
      mode: 'scoped-auto-commit',
      permissionContext: {
        granted: ['project.read', 'project.edit', 'ui.read', 'ui.select', 'ui.command-draft', 'ui.present-preview'],
        operationKinds: ['pattern.update'],
        maxCommits: 0,
      },
    });
    const token = connection.connectionToken;
    let sequence = 0;
    const request = (args: JsonRecord) => agent.requestTool(
      token, 'cad_ui', args, `pt007-command-preview-${++sequence}`,
    );
    try {
      const initial = await request({ action: 'snapshot' });
      await request({
        action: 'apply',
        expectedUiRevision: initial.uiRevision,
        actions: [{ kind: 'selection.set', entity: { kind: 'body-pattern', id: input.patternId } }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const selected = await request({ action: 'snapshot' });
      await request({
        action: 'apply',
        expectedUiRevision: selected.uiRevision,
        actions: [{ kind: 'command.open', commandId: 'model.pattern' }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const opened = await request({ action: 'snapshot' });
      const dialog = document.getElementById('bw-v5-command') as HTMLDialogElement | null;
      if (
        opened.activeCommand?.commandId !== 'model.pattern'
        || opened.activeCommand?.editEntity?.kind !== 'body-pattern'
        || opened.activeCommand?.editEntity?.id !== input.patternId
        || dialog?.open !== true
      ) throw new Error(`semantic model.pattern did not open the visible edit command: ${JSON.stringify(opened)}`);

      const setResult = await request({
        action: 'apply',
        expectedUiRevision: opened.uiRevision,
        actions: [{ kind: 'command.setInput', fieldId: 'variableInstances', value: input.rows }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const configured = await request({ action: 'snapshot' });
      const textarea = document.querySelector<HTMLTextAreaElement>('#bw-v5-command-form [name="variableInstances"]');
      if (!textarea) throw new Error('semantic model.pattern has no visible variable-rows textarea');
      let visibleRows;
      try { visibleRows = JSON.parse(textarea.value); }
      catch (error) { throw new Error(`semantic variable rows were not serialized as JSON: ${textarea.value}`, { cause: error }); }
      const studioScript = [...document.scripts].find((entry) => entry.src.endsWith('/studio.js'));
      if (!studioScript) throw new Error('cannot locate the built Studio module for semantic pattern inspection');
      const interaction = await import(new URL('studio-v6-interaction.js', studioScript.src).href);
      const built = interaction.buildCadUiCommandTransaction({
        draft: configured.activeCommand,
        expectedRevision: configured.activeCommand.baseRevision,
        transactionId: configured.activeCommand.transactionId,
      });
      const operation = built.transaction?.operations?.[0];
      if (
        JSON.stringify(visibleRows) !== JSON.stringify(input.rows)
        || !textarea.value.includes('\n')
        || JSON.stringify(configured.activeCommand?.inputValues?.variableInstances) !== JSON.stringify(input.rows)
        || operation?.kind !== 'pattern.update'
        || operation?.input?.patternId !== input.patternId
        || JSON.stringify(operation?.input?.patch?.instances) !== JSON.stringify(input.rows)
      ) throw new Error(`semantic variable rows did not reach the visible command transaction: ${JSON.stringify({
        visibleValue: textarea.value,
        visibleRows,
        activeRows: configured.activeCommand?.inputValues?.variableInstances,
        operation,
      })}`);

      const previewBatch = await request({
        action: 'apply',
        expectedUiRevision: configured.uiRevision,
        actions: [{ kind: 'command.preview' }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const preview = previewBatch.results
        ?.find((entry: JsonRecord) => entry.kind === 'command.preview')?.result;
      const previewed = await request({ action: 'snapshot' });
      const updated = preview?.changeSet?.updated?.find((entry: JsonRecord) =>
        entry.kind === 'body-pattern' && entry.id === input.patternId);
      if (
        typeof preview?.previewId !== 'string'
        || preview.baseRevision !== authoritativeBefore.commandRevision
        || preview.transactionHash !== built.transactionHash
        || preview.validation?.valid !== true
        || preview.validation?.exactGeometry !== true
        || preview.evidence?.exactGeometry !== true
        || preview.directVisibleHashParity !== true
        || preview.changeSet?.documentHashBefore !== authoritativeBefore.canonicalHash
        || preview.changeSet?.documentHashAfter === authoritativeBefore.canonicalHash
        || !updated
        || previewed.preview?.previewId !== preview.previewId
        || previewed.preview?.visible !== true
      ) throw new Error(`semantic model.pattern preview evidence is incomplete: ${JSON.stringify({
        operation, preview, presented: previewed.preview,
      })}`);

      await request({
        action: 'apply',
        expectedUiRevision: previewed.uiRevision,
        actions: [{ kind: 'preview.dismiss' }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const dismissed = await request({ action: 'snapshot' });
      await request({
        action: 'apply',
        expectedUiRevision: dismissed.uiRevision,
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
        redoDepth: studio.redoDepth(),
      };
      if (
        dismissed.preview?.previewId !== preview.previewId
        || dismissed.preview?.visible !== false
        || closed.activeCommand
        || closed.preview
        || dialog.open === true
        || JSON.stringify(authoritativeAfter) !== JSON.stringify(authoritativeBefore)
      ) throw new Error(`semantic model.pattern preview did not dismiss cleanly: ${JSON.stringify({
        dismissed, closed, authoritativeBefore, authoritativeAfter,
      })}`);
      return {
        commandId: opened.activeCommand.commandId,
        setInputApplied: setResult.results?.some((entry: JsonRecord) =>
          entry.kind === 'command.setInput' && entry.result?.fieldId === 'variableInstances') || false,
        serializedRows: visibleRows,
        operationKind: operation.kind,
        previewId: preview.previewId,
        previewExact: preview.validation.exactGeometry,
        dismissedWithoutMutation: true,
      };
    } finally {
      agent.disconnect(token);
    }
  }, {
    patternId,
    rows: [
      { position: 24, parameterOverrides: { source_height: 12 } },
      { position: 48, parameterOverrides: { source_height: 16 } },
    ],
  });
}

async function semanticVariablePreviewCommit(page: Page, patternId: string): Promise<JsonRecord> {
  const before = await projectState(page);
  const result = await page.evaluate(async (persistentPatternId) => {
    const studio = (window as any).__bwStudio;
    const agent = (window as any).partmodeAgent;
    const beforeState = {
      canonicalHash: studio.canonicalHash(),
      commandRevision: studio.commandRevision(),
      documentRevision: studio.documentRevision(),
    };
    const connection = await studio.connectAgentForTest({
      clientLabel: 'PT007 semantic variable-pattern update',
      mode: 'scoped-auto-commit',
      permissionContext: {
        granted: ['project.read', 'project.edit', 'ui.read', 'ui.command-draft', 'ui.present-preview'],
        operationKinds: ['pattern.update'],
        maxCommits: 1,
      },
    });
    const token = connection.connectionToken;
    let sequence = 0;
    const request = (tool: string, args: JsonRecord) => agent.requestTool(
      token, tool, args, `pt007-variable-${++sequence}`,
    );
    try {
      const transaction = {
        transactionId: 'pt007-variable-pattern-semantic-update',
        label: 'Semantic variable pattern update',
        expectedRevision: beforeState.commandRevision,
        atomic: true,
        operations: [{
          kind: 'pattern.update',
          input: { patternId: persistentPatternId, patch: { name: 'Semantic committed variable pattern' } },
        }],
      };
      const preview = await request('cad_preview', { transaction });
      const presented = await request('cad_ui', { action: 'snapshot' });
      const updated = preview.changeSet?.updated?.find((entry: JsonRecord) =>
        entry.kind === 'body-pattern' && entry.id === persistentPatternId);
      if (
        typeof preview.previewId !== 'string'
        || preview.baseRevision !== beforeState.commandRevision
        || preview.validation?.valid !== true
        || preview.validation?.exactGeometry !== true
        || preview.evidence?.exactGeometry !== true
        || preview.changeSet?.documentHashBefore !== beforeState.canonicalHash
        || preview.changeSet?.documentHashAfter === beforeState.canonicalHash
        || !updated
        || preview.visible !== true
        || presented.preview?.previewId !== preview.previewId
        || presented.preview?.visible !== true
      ) throw new Error(`variable pattern cad_preview evidence is incomplete: ${JSON.stringify({ preview, presented })}`);
      const commit = await request('cad_commit', {
        previewId: preview.previewId,
        expectedRevision: preview.baseRevision,
      });
      const closed = await request('cad_ui', { action: 'snapshot' });
      const afterState = {
        canonicalHash: studio.canonicalHash(),
        commandRevision: studio.commandRevision(),
        documentRevision: studio.documentRevision(),
      };
      if (
        commit.revision !== afterState.commandRevision
        || commit.changeSet?.documentHashBefore !== beforeState.canonicalHash
        || commit.changeSet?.documentHashAfter !== afterState.canonicalHash
        || commit.commitReceipt?.previewId !== preview.previewId
        || commit.commitReceipt?.documentHash !== afterState.canonicalHash
        || commit.settlement?.status !== 'settled'
        || commit.settlement?.target?.documentHash !== afterState.canonicalHash
        || closed.preview
      ) throw new Error(`variable pattern cad_commit evidence is incomplete: ${JSON.stringify({ preview, commit, closed })}`);
      return {
        previewId: preview.previewId,
        previewExact: preview.validation.exactGeometry,
        commitReceipt: commit.commitReceipt,
        settlement: commit.settlement,
      };
    } finally {
      agent.disconnect(token);
    }
  }, patternId);
  await waitForMutation(page, before, 'semantic variable-pattern cad_commit');
  assert.equal(result.previewExact, true, 'semantic variable-pattern preview was not exact');
  assert.ok(result.commitReceipt, 'semantic variable-pattern commit omitted its receipt');
  return result;
}

let local: RunningPartModeServer | undefined;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

try {
  const fixture = JSON.parse(await readFile(
    resolve(repositoryRoot, 'tests', 'body-pattern-runtime', 'body-patterns.partmode.json'),
    'utf8',
  )) as JsonRecord;
  fixture.projectId = 'pt007-advanced-patterns-ui';
  fixture.name = 'PT007 advanced pattern UI acceptance';
  fixture.partDefinitions[0].bodyPatterns = [];
  const sourceHeight = fixture.parameters.find((entry: JsonRecord) => entry.name === 'source_height');
  assert.ok(sourceHeight, 'body-pattern fixture has no source_height parameter');
  fixture.parameters = fixture.parameters.filter((entry: JsonRecord) => entry !== sourceHeight);
  fixture.partDefinitions[0].parameters.push(sourceHeight);

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
    (window as any).__pt007Injected = false;
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
  assert.equal(response?.status(), 200, 'advanced-pattern UI route did not return HTTP 200');
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await page.evaluate(async () => (window as any).__bwStudio.flushStorage());
  await page.evaluate(async (documentFixture) => {
    const database = await new Promise<IDBDatabase>((resolveOpen, rejectOpen) => {
      const request = indexedDB.open('partmode-studio', 1);
      request.addEventListener('success', () => resolveOpen(request.result), { once: true });
      request.addEventListener('error', () => rejectOpen(request.error), { once: true });
    });
    try {
      await new Promise<void>((resolveTransaction, rejectTransaction) => {
        const transaction = database.transaction(['meta', 'projects'], 'readwrite');
        transaction.objectStore('projects').put({
          projectId: documentFixture.projectId,
          title: documentFixture.name,
          document: documentFixture,
          commandRevision: 0,
          updatedAt: '2000-01-01T00:00:00.000Z',
        });
        transaction.objectStore('meta').put({ key: 'activeProjectId', value: documentFixture.projectId });
        transaction.addEventListener('complete', () => resolveTransaction(), { once: true });
        transaction.addEventListener('abort', () => rejectTransaction(transaction.error), { once: true });
        transaction.addEventListener('error', () => rejectTransaction(transaction.error), { once: true });
      });
    } finally {
      database.close();
    }
  }, fixture);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  assert.deepEqual(await page.evaluate(() => (window as any).__bwStudio.errors()), [],
    'advanced-pattern base fixture did not rebuild exactly');

  const beforeSources = await projectState(page);
  await page.evaluate((input) => (window as any).__bwStudio.commitHumanOperationsForTest(
    'Seed PT007 advanced-pattern references',
    [
      {
        kind: 'datum.create',
        input: {
          id: input.planeDatumId,
          name: 'Pattern XY plane',
          datumKind: 'plane',
          definition: { mode: 'principal', origin: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
        },
      },
      {
        kind: 'sketch.constrained.create',
        input: {
          id: input.pointSketchId,
          name: 'Solved pattern points',
          plane: 'XY',
          z: 0,
          constrained: input.pointSketch,
        },
      },
      {
        kind: 'sketch.derived.create',
        input: {
          id: input.derivedPointSketchId,
          name: 'Derived pattern points — ineligible',
          sourceSketchId: input.pointSketchId,
          plane: 'XY',
          z: 0,
          transform: { translation: [5, 5], angleDeg: 0 },
        },
      },
      {
        kind: 'sketch.profile.create',
        input: {
          id: input.boundarySketchId,
          name: 'Fill boundary',
          planeDatumId: input.planeDatumId,
          curveKind: 'polyline',
          points: [[-20, -15], [20, -15], [20, 15], [-20, 15]],
        },
      },
    ],
  ), {
    planeDatumId: PLANE_DATUM_ID,
    pointSketchId: POINT_SKETCH_ID,
    derivedPointSketchId: DERIVED_POINT_SKETCH_ID,
    boundarySketchId: BOUNDARY_SKETCH_ID,
    pointSketch: pointSketchSource,
  });
  await waitForMutation(page, beforeSources, 'advanced-pattern source seed');

  const sketchPatternId = await createSketchPattern(page);
  const fillPatternId = await createFillPattern(page);
  const variablePatternId = await createVariablePattern(page);
  const patternIds = { sketch: sketchPatternId, fill: fillPatternId, variable: variablePatternId };
  assert.equal(new Set(Object.values(patternIds)).size, 3, 'visible advanced patterns did not receive stable distinct IDs');
  assert.equal(rootPart(await readDocument(page)).bodyPatterns.length, 3,
    'visible create lifecycle did not persist exactly three patterns');
  await assertLiteralEscaping(page, sketchPatternId);
  const createdExact = await exactPatternSettlement(page, patternIds);
  assert.equal(createdExact.sketch.exact.length, 2, 'sketch pattern did not generate two exact occurrences');
  assert.equal(createdExact.fill.exact.length, 8, 'square fill pattern did not generate the deterministic lattice');
  assert.equal(createdExact.variable.exact.length, 2, 'variable pattern did not generate two exact occurrences');

  await page.evaluate(async () => (window as any).__bwStudio.flushStorage());
  const savedState = await projectState(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  const reopenedState = await projectState(page);
  assert.equal(reopenedState.docJson, savedState.docJson,
    'save/reload changed canonical advanced-pattern document bytes');
  assert.equal(reopenedState.canonicalHash, savedState.canonicalHash,
    'save/reload changed the advanced-pattern canonical hash');
  await assertLiteralEscaping(page, sketchPatternId);
  await exactPatternSettlement(page, patternIds);

  await openPatternEdit(page, sketchPatternId);
  await replaceValue(page, '#bw-v5-command-form [name="name"]', HTML_LIKE_PATTERN_NAME + ' edited');
  await replaceValue(page, '#bw-v5-command-form [name="pointIds"]', 'pattern-seed\npattern-point-x\npattern-point-y');
  await applyPatternForm(page, 'visible sketch-pattern update');
  await openPatternEdit(page, fillPatternId);
  await replaceValue(page, '#bw-v5-command-form [name="name"]', 'Visible triangular fill updated');
  await selectValue(page, '#bw-v5-command-form [name="fillLayout"]', 'triangular');
  await applyPatternForm(page, 'visible fill-pattern update');
  await openPatternEdit(page, variablePatternId);
  await replaceValue(page, '#bw-v5-command-form [name="name"]', 'Visible variable pattern updated');
  await replaceValue(page, '#bw-v5-command-form [name="variableInstances"]', JSON.stringify([
    { position: 22, parameterOverrides: { source_height: 11 } },
    { position: 44, parameterOverrides: { source_height: 14 } },
  ], null, 2));
  await applyPatternForm(page, 'visible variable-pattern update');
  let document = await readDocument(page);
  let part = rootPart(document);
  assert.equal(part.bodyPatterns.find((entry: JsonRecord) => entry.id === fillPatternId)?.definition.layout, 'triangular',
    'visible fill update did not persist the triangular lattice');
  assert.deepEqual(part.bodyPatterns.find((entry: JsonRecord) => entry.id === variablePatternId)?.definition.instances, [
    { position: 22, parameterOverrides: { source_height: 11 } },
    { position: 44, parameterOverrides: { source_height: 14 } },
  ], 'visible variable update did not persist its rows');
  const updatedExact = await exactPatternSettlement(page, patternIds);
  assert.equal(updatedExact.fill.exact.length, 10,
    'visible triangular fill update did not change the deterministic exact lattice');

  const sketchBoundsBeforeAssociation = structuredClone(
    updatedExact.sketch.exact.find((entry: JsonRecord) => entry.bodyId.endsWith('-instance-1'))?.geometry?.bounds,
  );
  const fillCountBeforeAssociation = updatedExact.fill.exact.length;
  const editedPointSketch = structuredClone(pointSketchSource);
  const editedPointDistance = editedPointSketch.constraints
    .find((entry: JsonRecord) => entry.id === 'pattern-point-x-horizontal');
  assert.ok(editedPointDistance, 'point-sketch fixture lost its horizontal-distance constraint');
  editedPointDistance.value = 26;
  const beforeAssociativeEdit = await projectState(page);
  await page.evaluate((input) => (window as any).__bwStudio.commitHumanOperationsForTest(
    'Associatively edit PT007 pattern sources',
    [
      {
        kind: 'sketch.constrained.update',
        input: { sketchId: input.pointSketchId, patch: { constrained: input.pointSketch } },
      },
      {
        kind: 'sketch.advanced.update',
        input: {
          sketchId: input.boundarySketchId,
          patch: { points: [[-20, -15], [30, -15], [30, 25], [-20, 25]] },
        },
      },
    ],
  ), {
    pointSketchId: POINT_SKETCH_ID,
    boundarySketchId: BOUNDARY_SKETCH_ID,
    pointSketch: editedPointSketch,
  });
  await waitForMutation(page, beforeAssociativeEdit, 'associative sketch/fill source edit');
  const associatedExact = await exactPatternSettlement(page, patternIds);
  const sketchBoundsAfterAssociation = associatedExact.sketch.exact
    .find((entry: JsonRecord) => entry.bodyId.endsWith('-instance-1'))?.geometry?.bounds;
  assert.notDeepEqual(sketchBoundsAfterAssociation, sketchBoundsBeforeAssociation,
    'solved point edit did not associatively move the exact sketch-pattern occurrence');
  assert.ok(associatedExact.fill.exact.length > fillCountBeforeAssociation,
    'boundary edit did not associatively regenerate the exact fill lattice');

  const semanticCommand = await semanticVariableCommandPreview(page, variablePatternId);
  assert.deepEqual(semanticCommand.serializedRows, [
    { position: 24, parameterOverrides: { source_height: 12 } },
    { position: 48, parameterOverrides: { source_height: 16 } },
  ], 'semantic command.setInput changed the authored variable rows');
  assert.equal(semanticCommand.setInputApplied, true,
    'semantic model.pattern did not acknowledge variableInstances command.setInput');
  const semantic = await semanticVariablePreviewCommit(page, variablePatternId);
  document = await readDocument(page);
  part = rootPart(document);
  assert.equal(part.bodyPatterns.find((entry: JsonRecord) => entry.id === variablePatternId)?.name,
    'Semantic committed variable pattern', 'semantic cad_commit did not update the persistent variable pattern');
  await exactPatternSettlement(page, patternIds);

  for (const patternId of [sketchPatternId, fillPatternId, variablePatternId]) {
    const beforeDelete = await projectState(page);
    await clickVisible(page, `[data-pattern-id="${patternId}"] [data-pattern-action="delete"]`);
    await waitForMutation(page, beforeDelete, `visible pattern delete ${patternId}`);
    assert.equal(rootPart(await readDocument(page)).bodyPatterns.some((entry: JsonRecord) => entry.id === patternId), false,
      `visible delete left pattern ${patternId} in the authoritative document`);
  }
  assert.equal(rootPart(await readDocument(page)).bodyPatterns.length, 0,
    'visible delete lifecycle left advanced patterns behind');
  const finalExact = await page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    return {
      exact: await studio.exactBodyResultsForTest(),
      canonicalHash: studio.canonicalHash(),
      documentRevision: studio.documentRevision(),
      errors: studio.errors(),
    };
  });
  assert.equal(finalExact.exact.revision, finalExact.documentRevision, 'post-delete exact evidence is stale');
  assert.equal(finalExact.exact.effectiveDocumentHash, finalExact.canonicalHash,
    'post-delete exact evidence is not current-document-hash-bound');
  assert.deepEqual(finalExact.errors, [], 'post-delete visible worker reported errors');
  assert.deepEqual(finalExact.exact.errors, [], 'post-delete isolated worker reported errors');
  for (const patternId of Object.values(patternIds)) {
    assert.equal(finalExact.exact.bodies.some((entry: JsonRecord) => entry.bodyId.startsWith(patternId + '-instance-')), false,
      `post-delete exact worker retained occurrence geometry for ${patternId}`);
  }
  assert.equal(await page.evaluate(() => (window as any).__pt007Injected), false,
    'HTML-like persistent pattern name executed during its lifecycle');
  assert.deepEqual(failures, [], `advanced-pattern browser gate reported errors: ${failures.join(' | ')}`);

  console.log(JSON.stringify({
    schema: 'partmode.advanced-patterns-ui-smoke/v1',
    browserBacked: true,
    chrome: await browser.version(),
    visibleLifecycle: {
      sketch: ['create', 'save-reload', 'update', 'associative-source-edit', 'delete'],
      fill: ['create', 'save-reload', 'update', 'associative-boundary-edit', 'delete'],
      variable: ['create', 'save-reload', 'update', 'semantic-preview-commit', 'delete'],
    },
    exactEvidence: {
      created: { sketch: 2, fill: 8, variable: 2 },
      updatedFill: updatedExact.fill.exact.length,
      associatedFill: associatedExact.fill.exact.length,
      variableDistinctVolumes: true,
      variableDistinctBreps: true,
      currentDocumentHashBound: true,
    },
    semantic: {
      tools: ['cad_preview', 'cad_commit'],
      visibleCommand: {
        commandId: semanticCommand.commandId,
        operationKind: semanticCommand.operationKind,
        setInput: 'variableInstances',
        previewExact: semanticCommand.previewExact,
        dismissedWithoutMutation: semanticCommand.dismissedWithoutMutation,
      },
      previewId: semantic.previewId,
      settled: semantic.settlement?.status,
    },
    literalEscaping: true,
    consoleNetworkResponsePageErrors: 0,
  }, null, 2));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
