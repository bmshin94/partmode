import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import puppeteer, { type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;
type AdvancedMateFamily =
  | 'width'
  | 'symmetry'
  | 'path'
  | 'linear-coupler'
  | 'limit-distance'
  | 'limit-angle';

type FamilySpec = {
  occurrenceIds: string[];
  ownerIndices: number[];
  roles: string[];
  selections: Record<string, string>;
  createdValues: Record<string, string>;
  editedValues: Record<string, string>;
};

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-advanced-mates-ui-'));
const FORM = '#bw-v5-command-form';
const BASE_OCCURRENCE_ID = 'occurrence-base';
const MOVING_OCCURRENCE_ID = 'occurrence-moving';
const THIRD_OCCURRENCE_ID = 'occurrence-third';
const PATH_SKETCH_ID = 'sketch-assembly-path';
const HTML_LIKE_PATH_CREATED_NAME = '<img src=x onerror="window.__as002Injected=true"> path mate';
const HTML_LIKE_PATH_EDITED_NAME = '<svg onload="window.__as002Injected=true"> edited path mate';

const FAMILY_ORDER: AdvancedMateFamily[] = [
  'width',
  'symmetry',
  'path',
  'linear-coupler',
  'limit-distance',
  'limit-angle',
];

const FAMILY_SPECS: Record<AdvancedMateFamily, FamilySpec> = {
  width: {
    occurrenceIds: [BASE_OCCURRENCE_ID, MOVING_OCCURRENCE_ID],
    ownerIndices: [0, 0, 1, 1],
    roles: ['width-first', 'width-second', 'tab-first', 'tab-second'],
    selections: {
      widthOccurrenceId: BASE_OCCURRENCE_ID,
      widthFirstReference: `${BASE_OCCURRENCE_ID}|datum-base-width-first`,
      widthSecondReference: `${BASE_OCCURRENCE_ID}|datum-base-width-second`,
      tabOccurrenceId: MOVING_OCCURRENCE_ID,
      tabFirstReference: `${MOVING_OCCURRENCE_ID}|datum-moving-tab-first`,
      tabSecondReference: `${MOVING_OCCURRENCE_ID}|datum-moving-tab-second`,
    },
    createdValues: {},
    editedValues: {},
  },
  symmetry: {
    occurrenceIds: [MOVING_OCCURRENCE_ID, THIRD_OCCURRENCE_ID, BASE_OCCURRENCE_ID],
    ownerIndices: [0, 1, 2],
    roles: ['symmetric-first', 'symmetric-second', 'symmetry-plane'],
    selections: {
      symmetryFirstOccurrenceId: MOVING_OCCURRENCE_ID,
      symmetryFirstReference: `${MOVING_OCCURRENCE_ID}|`,
      symmetrySecondOccurrenceId: THIRD_OCCURRENCE_ID,
      symmetrySecondReference: `${THIRD_OCCURRENCE_ID}|`,
      symmetryPlaneOccurrenceId: BASE_OCCURRENCE_ID,
      symmetryPlaneReference: `${BASE_OCCURRENCE_ID}|datum-base-symmetry`,
    },
    createdValues: {},
    editedValues: {},
  },
  path: {
    occurrenceIds: [BASE_OCCURRENCE_ID, MOVING_OCCURRENCE_ID],
    ownerIndices: [0, 1],
    roles: ['path', 'follower'],
    selections: {
      pathOccurrenceId: BASE_OCCURRENCE_ID,
      pathReference: `${BASE_OCCURRENCE_ID}|sketch:${PATH_SKETCH_ID}`,
      followerOccurrenceId: MOVING_OCCURRENCE_ID,
      followerReference: `${MOVING_OCCURRENCE_ID}|`,
    },
    createdValues: {},
    editedValues: {},
  },
  'linear-coupler': {
    occurrenceIds: [MOVING_OCCURRENCE_ID, THIRD_OCCURRENCE_ID],
    ownerIndices: [0, 1],
    roles: ['first-axis', 'second-axis'],
    selections: {
      firstOccurrenceId: MOVING_OCCURRENCE_ID,
      firstReference: `${MOVING_OCCURRENCE_ID}|datum-moving-axis-x`,
      secondOccurrenceId: THIRD_OCCURRENCE_ID,
      secondReference: `${THIRD_OCCURRENCE_ID}|datum-moving-axis-x`,
    },
    createdValues: { ratio: '2 + 1', offset: '1' },
    editedValues: { ratio: '3 + 1', offset: '-2' },
  },
  'limit-distance': {
    occurrenceIds: [BASE_OCCURRENCE_ID, MOVING_OCCURRENCE_ID],
    ownerIndices: [0, 1],
    roles: ['anchor', 'moving'],
    selections: {
      anchorOccurrenceId: BASE_OCCURRENCE_ID,
      anchorReference: `${BASE_OCCURRENCE_ID}|`,
      movingOccurrenceId: MOVING_OCCURRENCE_ID,
      movingReference: `${MOVING_OCCURRENCE_ID}|`,
    },
    createdValues: { minimum: '5', maximum: '10' },
    editedValues: { minimum: '4', maximum: '12' },
  },
  'limit-angle': {
    occurrenceIds: [BASE_OCCURRENCE_ID, MOVING_OCCURRENCE_ID],
    ownerIndices: [0, 1],
    roles: ['anchor', 'moving'],
    selections: {
      anchorOccurrenceId: BASE_OCCURRENCE_ID,
      anchorReference: `${BASE_OCCURRENCE_ID}|`,
      movingOccurrenceId: MOVING_OCCURRENCE_ID,
      movingReference: `${MOVING_OCCURRENCE_ID}|`,
    },
    createdValues: { minimum: '10', maximum: '45' },
    editedValues: { minimum: '20', maximum: '60' },
  },
};

function rootAssembly(document: JsonRecord): JsonRecord {
  const assembly = document.assemblyDefinitions?.find(
    (entry: JsonRecord) => entry.id === document.rootDocument?.assemblyId,
  );
  assert.ok(assembly, 'browser document has no active assembly definition');
  return assembly;
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
    const diagnostic = await page.evaluate(() => {
      const studio = (window as any).__bwStudio;
      return {
        present: Boolean(studio),
        commandRevision: studio?.commandRevision?.() ?? null,
        documentRevision: studio?.documentRevision?.() ?? null,
        appliedRevision: studio?.appliedRevision?.() ?? null,
        mode: studio?.mode?.() ?? null,
        errors: studio?.errors?.() ?? [],
        trace: studio?.evaluationTrace?.() ?? null,
        message: document.getElementById('bw-studio-msg')?.textContent || '',
        commandError: document.getElementById('bw-v5-command-error')?.textContent || '',
      };
    });
    throw new Error(`advanced-mate browser document did not settle: ${JSON.stringify(diagnostic)}`, { cause: error });
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
    const diagnostic = await page.evaluate(() => ({
      dialogOpen: (document.getElementById('bw-v5-command') as HTMLDialogElement | null)?.open === true,
      commandError: document.getElementById('bw-v5-command-error')?.textContent || '',
      message: document.getElementById('bw-studio-msg')?.textContent || '',
      errors: (window as any).__bwStudio?.errors?.() ?? [],
      trace: (window as any).__bwStudio?.evaluationTrace?.() ?? null,
    }));
    throw new Error(`${label} did not settle: ${JSON.stringify({ before, diagnostic })}`, { cause: error });
  }
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

async function waitForMateDialog(page: Page, open: boolean): Promise<void> {
  await page.waitForFunction((expectedOpen) => {
    const dialog = document.getElementById('bw-v5-command') as HTMLDialogElement | null;
    return dialog?.open === expectedOpen;
  }, { polling: 50, timeout: 30_000 }, open);
}

function expectedFormFields(spec: FamilySpec): string[] {
  return ['name', ...Object.keys(spec.selections), ...Object.keys(spec.createdValues)].sort();
}

async function assertFormContract(page: Page, family: AdvancedMateFamily): Promise<void> {
  const spec = FAMILY_SPECS[family];
  const actualFields = await page.$$eval(`${FORM} [name]`, (elements) =>
    elements.map((element) => element.getAttribute('name')).filter(Boolean).sort());
  assert.deepEqual(actualFields, expectedFormFields(spec), `${family} visible form field contract changed`);
  assert.equal(actualFields.includes('value'), false, `${family} form exposed forbidden top-level value`);
  assert.equal(actualFields.includes('flip'), false, `${family} form exposed forbidden flip`);
  for (const fieldName of actualFields) await assertHitTestable(page, `${FORM} [name="${fieldName}"]`);
  await assertHitTestable(page, '#bw-v5-command-apply');
  await assertHitTestable(page, '#bw-v5-command-cancel');
}

async function openMateCreate(page: Page, family: AdvancedMateFamily): Promise<void> {
  await clickVisible(page, '[data-workspace="assembly"]');
  await clickVisible(page, `[data-assembly-mate="${family}"]`);
  await waitForMateDialog(page, true);
  const state = await page.$eval('#bw-v5-command', (element) => ({
    command: (element as HTMLDialogElement).dataset.command,
    mateKind: (element as HTMLDialogElement).dataset.mateKind,
    mateId: (element as HTMLDialogElement).dataset.mateId,
  }));
  assert.deepEqual(state, { command: 'assembly-mate', mateKind: family, mateId: '' },
    `${family} ribbon button opened the wrong normal command form`);
  await assertFormContract(page, family);
}

async function openMateEdit(page: Page, family: AdvancedMateFamily, mateId: string): Promise<void> {
  await clickVisible(page, `[data-mate-id="${mateId}"] [data-mate-action="select"]`);
  await page.waitForSelector('[data-mate-context="edit"]', { visible: true, timeout: 30_000 });
  await clickVisible(page, '[data-mate-context="edit"]');
  await waitForMateDialog(page, true);
  const state = await page.$eval('#bw-v5-command', (element) => ({
    command: (element as HTMLDialogElement).dataset.command,
    mateKind: (element as HTMLDialogElement).dataset.mateKind,
    mateId: (element as HTMLDialogElement).dataset.mateId,
  }));
  assert.deepEqual(state, { command: 'assembly-mate', mateKind: family, mateId },
    `${family} inspector edit opened the wrong mate record`);
  await assertFormContract(page, family);
}

async function configureMateCreate(page: Page, family: AdvancedMateFamily, name: string): Promise<void> {
  const spec = FAMILY_SPECS[family];
  await replaceValue(page, `${FORM} [name="name"]`, name);
  for (const [fieldName, value] of Object.entries(spec.selections)) {
    await selectValue(page, `${FORM} [name="${fieldName}"]`, value);
  }
  for (const [fieldName, value] of Object.entries(spec.createdValues)) {
    await replaceValue(page, `${FORM} [name="${fieldName}"]`, value);
  }
}

async function applyMateForm(page: Page, label: string): Promise<void> {
  const before = await projectState(page);
  await clickVisible(page, '#bw-v5-command-apply');
  await page.waitForFunction(() => {
    const dialog = document.getElementById('bw-v5-command') as HTMLDialogElement | null;
    const error = document.getElementById('bw-v5-command-error')?.textContent?.trim();
    return dialog?.open === false || Boolean(error);
  }, { polling: 50, timeout: 180_000 });
  const outcome = await page.evaluate(() => ({
    open: (document.getElementById('bw-v5-command') as HTMLDialogElement | null)?.open === true,
    error: document.getElementById('bw-v5-command-error')?.textContent?.trim() || '',
    message: document.getElementById('bw-studio-msg')?.textContent?.trim() || '',
  }));
  assert.equal(outcome.open, false,
    `${label} form was rejected: ${JSON.stringify({ error: outcome.error, message: outcome.message })}`);
  await waitForMutation(page, before, label);
}

function assertStrictMate(
  mate: JsonRecord,
  family: AdvancedMateFamily,
  name: string,
  expectedValues: Record<string, string>,
): void {
  const spec = FAMILY_SPECS[family];
  assert.deepEqual(Object.keys(mate).sort(), [
    'extensions', 'id', 'kind', 'name', 'occurrenceIds', 'references', 'suppressed',
  ], `${family} mate persisted unsupported or missing top-level fields`);
  assert.equal(mate.kind, family, `${family} mate changed immutable family`);
  assert.equal(mate.name, name, `${family} mate name was not persisted literally`);
  assert.equal(mate.suppressed, false, `${family} mate unexpectedly persisted suppressed`);
  assert.deepEqual(mate.occurrenceIds, spec.occurrenceIds, `${family} occurrence ordering changed`);
  assert.equal(Object.hasOwn(mate, 'value'), false, `${family} persisted forbidden top-level value`);
  assert.deepEqual(Object.keys(mate.extensions), ['advancedMate'],
    `${family} persisted extensions outside the strict advanced-mate envelope`);
  assert.equal(Object.hasOwn(mate.extensions, 'flip'), false, `${family} persisted forbidden extensions.flip`);
  const advanced = mate.extensions.advancedMate;
  assert.deepEqual(Object.keys(advanced).sort(), [
    'family', 'schema', 'version', ...Object.keys(expectedValues),
  ].sort(), `${family} advancedMate extension fields changed`);
  assert.equal(advanced.schema, 'partmode.advanced-mate/v1', `${family} extension schema changed`);
  assert.equal(advanced.version, 1, `${family} extension version changed`);
  assert.equal(advanced.family, family, `${family} extension family disagrees with mate kind`);
  for (const [fieldName, value] of Object.entries(expectedValues)) {
    assert.equal(String(advanced[fieldName]), value, `${family} ${fieldName} changed`);
  }
  assert.equal(mate.references.length, spec.roles.length, `${family} reference count changed`);
  mate.references.forEach((reference: JsonRecord, index: number) => {
    assert.equal(reference.semanticPath?.role, spec.roles[index],
      `${family} reference ${index} lost its strict role`);
    assert.equal(reference.occurrencePath?.[0], spec.occurrenceIds[spec.ownerIndices[index]!],
      `${family} reference ${index} no longer belongs to its ordered occurrence`);
    assert.ok(reference.signature && typeof reference.signature === 'object',
      `${family} reference ${index} lost its persistent signature`);
  });
  if (family === 'path') {
    assert.equal(mate.references[0].ownerKind, 'sketch', 'path reference is not sketch-owned');
    assert.equal(mate.references[0].ownerId, PATH_SKETCH_ID, 'path reference changed its persistent sketch ID');
  }
  if (family === 'linear-coupler') {
    assert.ok(mate.references.every((reference: JsonRecord) =>
      reference.ownerKind === 'datum' && reference.ownerId === 'datum-moving-axis-x'),
    'linear coupler did not persist two genuine datum-axis references');
  }
}

async function assertMateNameRenderedAsText(
  page: Page,
  mateId: string,
  expectedName: string,
  phase: string,
): Promise<void> {
  const row = `[data-mate-id="${mateId}"]`;
  await page.waitForSelector(`${row} [data-mate-action="select"] span`, { visible: true, timeout: 30_000 });
  assert.equal(await page.$eval(
    `${row} [data-mate-action="select"] span`,
    (element) => element.textContent,
  ), expectedName, `${phase} did not render the literal HTML-like mate name as text`);
  assert.equal(await page.$$eval(`${row} img, ${row} svg, ${row} script`, (elements) => elements.length), 0,
    `${phase} injected an element from the HTML-like mate name`);
  assert.equal(await page.evaluate(() => (window as any).__as002Injected), false,
    `${phase} executed the HTML-like mate name`);
}

async function assertIsolatedExactEvidence(
  page: Page,
  family: AdvancedMateFamily,
  mateId: string,
): Promise<JsonRecord> {
  await waitForSettlement(page);
  const evidence = await page.evaluate(async (input) => {
    const studio = (window as any).__bwStudio;
    const studioScript = document.querySelector<HTMLScriptElement>('script[src*="/studio.js"]');
    if (!studioScript) throw new Error('versioned Studio entrypoint is missing');
    const workerUrl = `${new URL('.', studioScript.src).href}studio-kernel.worker.js`;
    const worker = new Worker(workerUrl, { type: 'module' });
    const requestId = `advanced-mates-ui-${input.family}-${studio.documentRevision()}`;
    try {
      const response = await new Promise<Record<string, any>>((resolveResponse, rejectResponse) => {
        const timeout = setTimeout(
          () => rejectResponse(new Error(`${input.family} isolated production worker timed out`)),
          180_000,
        );
        const onMessage = (event: MessageEvent<Record<string, any>>) => {
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
          kind: 'rebuild',
          requestId,
          projectId: studio.projectId(),
          revision: studio.documentRevision(),
          document: JSON.parse(studio.docJson()),
          includeExactBrep: true,
        });
      });
      const visibleBodies = studio.bodyResults();
      return {
        kind: response.kind,
        revision: response.revision,
        effectiveDocumentHash: response.effectiveDocumentHash || null,
        canonicalHash: studio.canonicalHash(),
        documentRevision: studio.documentRevision(),
        appliedRevision: studio.appliedRevision(),
        visibleErrors: studio.errors(),
        errors: JSON.parse(JSON.stringify(response.errors || [])),
        evaluation: JSON.parse(JSON.stringify(response.evaluation || {})),
        bodies: (response.bodies || []).map((body: JsonRecord) => {
          const visible = visibleBodies.find((entry: JsonRecord) => entry.bodyId === body.bodyId);
          return {
            bodyId: body.bodyId,
            sourceBodyId: body.sourceBodyId || body.bodyId,
            occurrenceId: body.occurrenceInstance?.occurrenceId || null,
            occurrencePath: [...(body.occurrenceInstance?.occurrencePath || [])],
            renderSourceBodyId: body.renderSourceBodyId || null,
            sharesSourceGeometry: body.sharesSourceGeometry === true,
            geometry: JSON.parse(JSON.stringify(body.geometry || null)),
            visibleBounds: JSON.parse(JSON.stringify(visible?.geometry?.bounds || null)),
            error: JSON.parse(JSON.stringify(body.error || null)),
            lastValid: body.lastValid === true,
            exactBrepLength: typeof body.exactBrep === 'string' ? body.exactBrep.length : 0,
            topology: body.mesh ? {
              faces: Number(body.mesh.topologyCounts?.faces ?? 0),
              edges: Number(body.mesh.topologyCounts?.edges ?? 0),
              vertices: Number(body.mesh.topologyCounts?.vertices ?? 0),
              namedFaces: Number(body.mesh.topologyCounts?.namedFaces ?? 0),
              namedEdges: Number(body.mesh.topologyCounts?.namedEdges ?? 0),
              namedVertices: Number(body.mesh.topologyCounts?.namedVertices ?? 0),
              faceRecords: body.mesh.topologyFaces?.length ?? 0,
              edgeRecords: body.mesh.edges?.length ?? 0,
              vertexRecords: body.mesh.topologyVertices?.length ?? 0,
              diagnostics: JSON.parse(JSON.stringify(body.mesh.topologyDiagnostics || [])),
            } : null,
          };
        }),
      };
    } finally {
      worker.terminate();
    }
  }, { family, mateId });

  assert.equal(evidence.kind, 'rebuild-result', `${family} isolated worker returned the wrong response kind`);
  assert.equal(evidence.revision, evidence.documentRevision, `${family} isolated exact proof is stale`);
  assert.equal(evidence.appliedRevision, evidence.documentRevision, `${family} visible document is not settled`);
  assert.equal(evidence.effectiveDocumentHash, evidence.canonicalHash,
    `${family} isolated exact proof is not current-document-hash-bound`);
  assert.deepEqual(evidence.visibleErrors, [], `${family} visible worker reported CAD errors`);
  assert.deepEqual(evidence.errors, [], `${family} isolated production worker reported CAD errors`);
  assert.equal(evidence.evaluation?.effectiveDocumentHash, evidence.canonicalHash,
    `${family} isolated solver evidence has the wrong document hash`);
  assert.notEqual(evidence.evaluation?.solverState, 'conflicting', `${family} solver settled in conflict`);
  assert.equal(evidence.evaluation?.usedLastValid, false, `${family} solver used a last-valid placement`);
  const residual = evidence.evaluation?.mateResiduals?.find((entry: JsonRecord) => entry.mateId === mateId);
  assert.ok(residual, `${family} isolated solver omitted the mate residual`);
  assert.equal(residual.satisfied, true, `${family} isolated solver retained an unsatisfied residual`);
  assert.ok(Number(residual.maxScaledResidual) <= 1e-6,
    `${family} isolated solver residual exceeded tolerance: ${residual.maxScaledResidual}`);
  assert.equal(evidence.evaluation?.conflicts?.some((set: string[]) => set.includes(mateId)), false,
    `${family} appeared in an isolated solver conflict set`);

  for (const occurrenceId of [BASE_OCCURRENCE_ID, MOVING_OCCURRENCE_ID, THIRD_OCCURRENCE_ID]) {
    const body = evidence.bodies.find((entry: JsonRecord) => entry.occurrenceId === occurrenceId);
    assert.ok(body, `${family} isolated worker omitted exact body for ${occurrenceId}`);
    assert.equal(body.error, null, `${family} exact body ${occurrenceId} has an error`);
    assert.equal(body.lastValid, false, `${family} exact body ${occurrenceId} used stale geometry`);
    assert.equal(body.geometry?.valid, true, `${family} exact body ${occurrenceId} is invalid`);
    assert.equal(body.geometry?.brepValid, true, `${family} exact body ${occurrenceId} failed BRepCheck`);
    assert.equal(body.geometry?.solidCount, 1, `${family} exact body ${occurrenceId} is not one solid`);
    assert.ok(body.geometry?.volume > 0, `${family} exact body ${occurrenceId} has no positive volume`);
    const exactSource = body.exactBrepLength > 100
      ? body
      : evidence.bodies.find((entry: JsonRecord) =>
        entry.bodyId === body.renderSourceBodyId
          || (entry.sourceBodyId === body.sourceBodyId && entry.exactBrepLength > 100));
    assert.ok(exactSource?.exactBrepLength > 100,
      `${family} exact body ${occurrenceId} omitted canonical BREP bytes and a proved reuse source`);
    if (exactSource !== body) {
      assert.equal(body.sharesSourceGeometry, true,
        `${family} exact body ${occurrenceId} reused BREP bytes without a shared-source marker`);
    }
    assert.deepEqual(body.geometry?.bounds, body.visibleBounds,
      `${family} isolated and visible-worker bounds disagree for ${occurrenceId}`);
    const topology = body.topology || exactSource?.topology;
    assert.ok(topology, `${family} exact body ${occurrenceId} omitted topology and a proved topology source`);
    assert.ok(topology.faces > 0 && topology.faces === topology.faceRecords,
      `${family} exact body ${occurrenceId} has incomplete faces`);
    assert.ok(topology.edges > 0 && topology.edges === topology.edgeRecords,
      `${family} exact body ${occurrenceId} has incomplete edges`);
    assert.ok(topology.vertices > 0 && topology.vertices === topology.vertexRecords,
      `${family} exact body ${occurrenceId} has incomplete vertices`);
    assert.equal(topology.namedFaces, topology.faces,
      `${family} exact body ${occurrenceId} has unnamed faces`);
    assert.equal(topology.namedEdges, topology.edges,
      `${family} exact body ${occurrenceId} has unnamed edges`);
    assert.equal(topology.namedVertices, topology.vertices,
      `${family} exact body ${occurrenceId} has unnamed vertices`);
    assert.deepEqual(topology.diagnostics, [],
      `${family} exact body ${occurrenceId} reported topology diagnostics`);
  }
  return {
    solverState: evidence.evaluation.solverState,
    residual: residual.maxScaledResidual,
    bodies: evidence.bodies.length,
    topology: evidence.bodies.map((entry: JsonRecord) => ({
      occurrenceId: entry.occurrenceId,
      faces: entry.topology?.faces,
      edges: entry.topology?.edges,
      vertices: entry.topology?.vertices,
    })),
  };
}

async function cancelEditedMate(
  page: Page,
  family: AdvancedMateFamily,
  mateId: string,
  editedName: string,
): Promise<void> {
  const before = await projectState(page);
  await openMateEdit(page, family, mateId);
  await replaceValue(page, `${FORM} [name="name"]`, `${family} cancelled mutation`);
  const numericField = Object.keys(FAMILY_SPECS[family].editedValues)[0];
  if (numericField) await replaceValue(page, `${FORM} [name="${numericField}"]`, '999');
  await clickVisible(page, '#bw-v5-command-cancel');
  await waitForMateDialog(page, false);
  assert.deepEqual(await projectState(page), before, `${family} Cancel mutated document or history state`);
  const mate = rootAssembly(await readDocument(page)).mates.find((entry: JsonRecord) => entry.id === mateId);
  assert.ok(mate, `${family} Cancel removed the edited mate`);
  assertStrictMate(mate, family, editedName, FAMILY_SPECS[family].editedValues);
}

async function persistAndReloadPath(page: Page, mateId: string, name: string): Promise<JsonRecord> {
  await page.evaluate(async () => (window as any).__bwStudio.flushStorage());
  const before = await projectState(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  const after = await projectState(page);
  assert.equal(after.docJson, before.docJson, 'path mate save/reload changed canonical document bytes');
  assert.equal(after.canonicalHash, before.canonicalHash, 'path mate save/reload changed canonical hash');
  const mate = rootAssembly(await readDocument(page)).mates.find((entry: JsonRecord) => entry.id === mateId);
  assert.ok(mate, 'path mate disappeared after browser persistence/reload');
  assertStrictMate(mate, 'path', name, {});
  await clickVisible(page, '[data-workspace="assembly"]');
  await assertMateNameRenderedAsText(page, mateId, name, 'path save/reload');
  return assertIsolatedExactEvidence(page, 'path', mateId);
}

async function persistReloadAndApplyCouplerExpression(
  page: Page,
  mateId: string,
  name: string,
): Promise<string> {
  await page.evaluate(async () => (window as any).__bwStudio.flushStorage());
  const beforeReload = await projectState(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  const afterReload = await projectState(page);
  assert.equal(afterReload.docJson, beforeReload.docJson,
    'linear-coupler expression save/reload changed canonical document bytes');
  assert.equal(afterReload.canonicalHash, beforeReload.canonicalHash,
    'linear-coupler expression save/reload changed canonical hash');
  let mate = rootAssembly(await readDocument(page)).mates.find((entry: JsonRecord) => entry.id === mateId);
  assert.ok(mate, 'linear-coupler disappeared after expression persistence/reload');
  assertStrictMate(mate, 'linear-coupler', name, FAMILY_SPECS['linear-coupler'].createdValues);

  const editedName = `${name} expression reapplied`;
  const opened = await page.evaluate(async (input) => {
    const studio = (window as any).__bwStudio;
    const agent = (window as any).partmodeAgent;
    const connection = await studio.connectAgentForTest({
      clientLabel: 'AS002 expression-backed linear-coupler visible edit',
      mode: 'scoped-auto-commit',
      permissionContext: {
        granted: ['project.read', 'project.edit', 'ui.read', 'ui.select', 'ui.command-draft', 'ui.present-preview'],
        operationKinds: ['mate.update'],
        maxCommits: 1,
      },
    });
    const token = connection.connectionToken;
    let sequence = 0;
    const request = (args: JsonRecord) => agent.requestTool(
      token,
      'cad_ui',
      args,
      `as002-coupler-expression-${++sequence}`,
    );
    try {
      const initial = await request({ action: 'snapshot' });
      await request({
        action: 'apply',
        expectedUiRevision: initial.uiRevision,
        actions: [{ kind: 'selection.set', entity: { kind: 'mate', id: input.mateId } }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const selected = await request({ action: 'snapshot' });
      await request({
        action: 'apply',
        expectedUiRevision: selected.uiRevision,
        actions: [{ kind: 'command.open', commandId: 'assembly.mate.linear-coupler' }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const commandOpened = await request({ action: 'snapshot' });
      if (
        commandOpened.activeCommand?.commandId !== 'assembly.mate.linear-coupler'
        || commandOpened.activeCommand?.editEntity?.kind !== 'mate'
        || commandOpened.activeCommand?.editEntity?.id !== input.mateId
        || commandOpened.activeCommand?.inputValues?.ratio !== input.ratio
      ) {
        throw new Error(`expression-backed coupler draft was normalized or opened incorrectly: ${JSON.stringify(commandOpened)}`);
      }
      await request({
        action: 'apply',
        expectedUiRevision: commandOpened.uiRevision,
        actions: [{ kind: 'command.setInput', fieldId: 'name', value: input.editedName }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const configured = await request({ action: 'snapshot' });
      if (configured.activeCommand?.inputValues?.ratio !== input.ratio) {
        throw new Error(`command.setInput changed the authored ratio expression: ${JSON.stringify(configured.activeCommand)}`);
      }
      const previewBatch = await request({
        action: 'apply',
        expectedUiRevision: configured.uiRevision,
        actions: [{ kind: 'command.preview' }],
        presentation: { mode: 'instant', transition: 'cut' },
      });
      const preview = previewBatch.results?.find((entry: JsonRecord) => entry.kind === 'command.preview')?.result;
      const previewed = await request({ action: 'snapshot' });
      if (
        preview?.validation?.valid !== true
        || preview?.validation?.exactGeometry !== true
        || preview?.evidence?.exactGeometry !== true
        || previewed.activeCommand?.inputValues?.ratio !== input.ratio
        || previewed.preview?.previewId !== preview?.previewId
      ) {
        throw new Error(`expression-backed coupler exact preview is incomplete: ${JSON.stringify({ preview, previewed })}`);
      }
      return {
        token,
        draftRatio: previewed.activeCommand.inputValues.ratio,
        previewId: preview.previewId,
      };
    } catch (error) {
      agent.disconnect(token);
      throw error;
    }
  }, {
    mateId,
    ratio: FAMILY_SPECS['linear-coupler'].createdValues.ratio,
    editedName,
  });

  try {
    assert.equal(opened.draftRatio, '2 + 1',
      'v6InitialAssemblyDraft normalized the persisted coupler ratio expression');
    assert.ok(typeof opened.previewId === 'string' && opened.previewId.length > 0,
      'expression-backed coupler edit omitted an exact preview ID');
    assert.equal(await page.$eval(`${FORM} [name="ratio"]`,
      (element) => (element as HTMLInputElement).value), '2 + 1',
    'visible coupler Edit form did not retain the exact authored ratio expression');
    assert.equal(await page.$eval(`${FORM} [name="name"]`,
      (element) => (element as HTMLInputElement).value), editedName,
    'semantic name edit did not reach the normal visible coupler form');
    await applyMateForm(page, 'expression-backed linear-coupler visible Apply');
  } finally {
    await page.evaluate((token) => (window as any).partmodeAgent.disconnect(token), opened.token);
  }

  mate = rootAssembly(await readDocument(page)).mates.find((entry: JsonRecord) => entry.id === mateId);
  assert.ok(mate, 'expression-backed visible Apply removed the linear coupler');
  assertStrictMate(mate, 'linear-coupler', editedName, FAMILY_SPECS['linear-coupler'].createdValues);
  return editedName;
}

async function seedRuntimeAssembly(page: Page): Promise<void> {
  const before = await projectState(page);
  await page.evaluate(async (ids) => {
    const studio = (window as any).__bwStudio;
    await studio.commitHumanOperationsForTest('Seed AS002 exact advanced-mate assembly', [
      { kind: 'project.clear', input: {} },
      {
        kind: 'feature.extrude',
        input: {
          id: 'feature-advanced-mates-source',
          name: 'Exact advanced-mate source block',
          sketch: {
            shapes: [{ id: 'shape-advanced-mates-source', kind: 'rect', x: -5, y: -5, w: 10, h: 10 }],
            z: 0,
          },
          height: 10,
          resultPolicy: { kind: 'new-body', bodyName: 'Advanced-mate source block' },
        },
      },
      {
        kind: 'datum.create',
        input: {
          id: 'datum-base-width-first', name: 'Base width first', datumKind: 'plane',
          definition: { mode: 'principal', origin: [-5, 0, 0], normal: [1, 0, 0], xDirection: [0, 1, 0] },
        },
      },
      {
        kind: 'datum.create',
        input: {
          id: 'datum-base-width-second', name: 'Base width second', datumKind: 'plane',
          definition: { mode: 'principal', origin: [5, 0, 0], normal: [-1, 0, 0], xDirection: [0, 1, 0] },
        },
      },
      {
        kind: 'datum.create',
        input: {
          id: 'datum-base-symmetry', name: 'Base symmetry plane', datumKind: 'plane',
          definition: { mode: 'principal', origin: [0, 0, 0], normal: [1, 0, 0], xDirection: [0, 1, 0] },
        },
      },
      {
        kind: 'datum.create',
        input: {
          id: 'datum-moving-tab-first', name: 'Moving tab first', datumKind: 'plane',
          definition: { mode: 'principal', origin: [-2, 0, 0], normal: [1, 0, 0], xDirection: [0, 1, 0] },
        },
      },
      {
        kind: 'datum.create',
        input: {
          id: 'datum-moving-tab-second', name: 'Moving tab second', datumKind: 'plane',
          definition: { mode: 'principal', origin: [2, 0, 0], normal: [-1, 0, 0], xDirection: [0, 1, 0] },
        },
      },
      {
        kind: 'datum.create',
        input: {
          id: 'datum-moving-axis-x', name: 'Moving X axis', datumKind: 'axis',
          definition: { mode: 'principal', origin: [0, 0, 0], direction: [1, 0, 0] },
        },
      },
      {
        kind: 'sketch.path.create',
        input: {
          id: ids.pathSketchId,
          name: 'Exact assembly spline path',
          curveKind: 'spline',
          points: [[0, 0, 0], [10, 5, 0], [20, 0, 0]],
        },
      },
      {
        kind: 'assembly.create',
        input: {
          id: 'assembly-advanced-mates-ui',
          occurrenceId: ids.baseOccurrenceId,
          name: 'AS002 advanced-mate UI acceptance',
          occurrenceName: 'Base component',
          fixed: true,
        },
      },
      {
        kind: 'component.duplicate',
        input: {
          occurrenceId: ids.baseOccurrenceId,
          id: ids.movingOccurrenceId,
          name: 'Moving component',
          baseTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, -4, 9, 1],
        },
      },
      {
        kind: 'component.duplicate',
        input: {
          occurrenceId: ids.baseOccurrenceId,
          id: ids.thirdOccurrenceId,
          name: 'Second moving component',
          baseTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -7, 2, 0, 1],
        },
      },
    ]);
  }, {
    baseOccurrenceId: BASE_OCCURRENCE_ID,
    movingOccurrenceId: MOVING_OCCURRENCE_ID,
    thirdOccurrenceId: THIRD_OCCURRENCE_ID,
    pathSketchId: PATH_SKETCH_ID,
  });
  await waitForMutation(page, before, 'typed advanced-mate runtime seed');

  assert.deepEqual(await page.evaluate(() => (window as any).__bwStudio.errors()), [],
    'typed advanced-mate runtime seed did not rebuild exactly');
  const document = await readDocument(page);
  const assembly = rootAssembly(document);
  assert.deepEqual(assembly.occurrences.map((entry: JsonRecord) => entry.id), [
    BASE_OCCURRENCE_ID, MOVING_OCCURRENCE_ID, THIRD_OCCURRENCE_ID,
  ], 'typed advanced-mate runtime seed did not create the three ordered occurrences');
  assert.equal(assembly.occurrences[0].fixed, true, 'typed seed did not fix the base occurrence');
  assert.ok(assembly.occurrences.slice(1).every((entry: JsonRecord) => entry.fixed === false),
    'typed seed unexpectedly fixed a moving occurrence');
  assert.equal(assembly.mates.length, 0, 'typed seed unexpectedly created an assembly mate');

  const sourcePartId = assembly.occurrences[0].definition?.partId;
  assert.ok(typeof sourcePartId === 'string' && sourcePartId.length > 0,
    'typed seed base occurrence lost its source part');
  assert.ok(assembly.occurrences.every((entry: JsonRecord) => entry.definition?.partId === sourcePartId),
    'typed linked duplicates do not share the runtime-created source part');
  const sourcePart = document.partDefinitions.find((entry: JsonRecord) => entry.id === sourcePartId);
  assert.ok(sourcePart, 'typed seed runtime-created source part is missing');
  assert.equal(sourcePart.bodies.length, 1, 'typed seed did not produce exactly one exact source body');
  assert.ok(sourcePart.sketches.some((entry: JsonRecord) => entry.id === PATH_SKETCH_ID),
    'typed seed did not persist the path through sketch.path.create');
  const axis = sourcePart.referenceGeometry.find(
    (entry: JsonRecord) => entry.id === 'datum-moving-axis-x',
  );
  assert.equal(axis?.kind, 'axis', 'typed seed did not create a genuine axis datum');
  assert.deepEqual(axis?.definition?.direction, [1, 0, 0],
    'typed seed axis datum lost its exact X direction');
  assert.equal(Object.hasOwn(axis?.definition || {}, 'xDirection'), false,
    'typed seed axis datum incorrectly relies on a plane-only xDirection');
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
  await page.setViewport({ width: 1800, height: 1200, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('bw-studio-welcome-v1', '1');
    (window as any).__as002Injected = false;
  });

  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(
    `pageerror: ${error instanceof Error ? error.message : String(error)}`,
  ));
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
  assert.equal(response?.status(), 200, 'advanced-mate UI route did not return HTTP 200');
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  if (await page.$eval('#pm-cookie-banner', (element) => !(element as HTMLElement).hidden)) {
    await clickVisible(page, '#pm-cookie-essential');
    await page.waitForFunction(() => (document.getElementById('pm-cookie-banner') as HTMLElement | null)?.hidden === true,
      { polling: 100, timeout: 10_000 });
  }
  await seedRuntimeAssembly(page);
  await clickVisible(page, '[data-workspace="assembly"]');

  const advertisedButtons = await page.$$eval(
    '#ws-panel-assembly [data-assembly-mate]',
    (buttons) => buttons.map((button) => (button as HTMLElement).dataset.assemblyMate),
  );
  for (const family of FAMILY_ORDER) {
    assert.equal(advertisedButtons.filter((value) => value === family).length, 1,
      `${family} ribbon command is missing or duplicated`);
    await assertHitTestable(page, `[data-assembly-mate="${family}"]`);
  }

  const exactEvidence: Record<string, JsonRecord> = {};
  const lifecycle: Record<string, string[]> = {};
  for (const family of FAMILY_ORDER) {
    const createdName = family === 'path' ? HTML_LIKE_PATH_CREATED_NAME : `${family} UI created`;
    const editedName = family === 'path' ? HTML_LIKE_PATH_EDITED_NAME : `${family} UI edited`;
    await openMateCreate(page, family);
    await configureMateCreate(page, family, createdName);
    await applyMateForm(page, `${family} visible create`);

    let document = await readDocument(page);
    let assembly = rootAssembly(document);
    assert.equal(assembly.mates.length, 1, `${family} create did not persist exactly one mate`);
    let mate = assembly.mates[0];
    assertStrictMate(mate, family, createdName, FAMILY_SPECS[family].createdValues);
    const mateId = mate.id;
    assert.ok(typeof mateId === 'string' && mateId.length > 0, `${family} create omitted a stable mate ID`);
    if (family === 'path') {
      await assertMateNameRenderedAsText(page, mateId, createdName, 'path create');
    }
    exactEvidence[family] = await assertIsolatedExactEvidence(page, family, mateId);
    lifecycle[family] = ['create', 'isolated-exact'];

    if (family === 'path') {
      exactEvidence.pathReload = await persistAndReloadPath(page, mateId, createdName);
      lifecycle[family].push('save-reload', 'fresh-isolated-exact');
    }

    let currentName = createdName;
    if (family === 'linear-coupler') {
      currentName = await persistReloadAndApplyCouplerExpression(page, mateId, createdName);
      exactEvidence.linearCouplerExpressionReload = await assertIsolatedExactEvidence(page, family, mateId);
      lifecycle[family].push('expression-save-reload', 'semantic-edit', 'exact-preview', 'visible-apply');
    }

    await openMateEdit(page, family, mateId);
    assert.equal(await page.$eval(`${FORM} [name="name"]`, (element) => (element as HTMLInputElement).value),
      currentName, `${family} edit did not restore the persisted name`);
    for (const [fieldName, value] of Object.entries(FAMILY_SPECS[family].selections)) {
      assert.equal(await page.$eval(`${FORM} [name="${fieldName}"]`,
        (element) => (element as HTMLSelectElement).value), value,
      `${family} edit did not restore ${fieldName}`);
    }
    for (const [fieldName, value] of Object.entries(FAMILY_SPECS[family].createdValues)) {
      assert.equal(await page.$eval(`${FORM} [name="${fieldName}"]`,
        (element) => (element as HTMLInputElement).value), value,
      `${family} edit did not restore ${fieldName}`);
    }
    await replaceValue(page, `${FORM} [name="name"]`, editedName);
    for (const [fieldName, value] of Object.entries(FAMILY_SPECS[family].editedValues)) {
      await replaceValue(page, `${FORM} [name="${fieldName}"]`, value);
    }
    await applyMateForm(page, `${family} visible edit`);
    document = await readDocument(page);
    assembly = rootAssembly(document);
    assert.equal(assembly.mates.length, 1, `${family} edit duplicated the mate`);
    mate = assembly.mates[0];
    assert.equal(mate.id, mateId, `${family} edit changed stable identity`);
    assertStrictMate(mate, family, editedName, FAMILY_SPECS[family].editedValues);
    if (family === 'path') {
      await assertMateNameRenderedAsText(page, mateId, editedName, 'path edit');
    }
    lifecycle[family].push('edit');

    await cancelEditedMate(page, family, mateId, editedName);
    lifecycle[family].push('cancel-no-mutation');

    const beforeDelete = await projectState(page);
    await clickVisible(page, `[data-mate-id="${mateId}"] [data-mate-action="delete"]`);
    await waitForMutation(page, beforeDelete, `${family} visible delete`);
    assert.equal(rootAssembly(await readDocument(page)).mates.length, 0,
      `${family} visible delete retained the mate`);
    const trace = await page.evaluate(() => (window as any).__bwStudio.evaluationTrace());
    assert.equal(trace?.usedLastValid, false, `${family} post-delete settlement used last-valid placement`);
    assert.notEqual(trace?.solverState, 'conflicting', `${family} post-delete settlement remained conflicting`);
    lifecycle[family].push('delete');
  }

  assert.equal(rootAssembly(await readDocument(page)).mates.length, 0,
    'advanced-mate visible lifecycle left persistent mates behind');
  assert.deepEqual(failures, [], `advanced-mate browser gate reported errors: ${failures.join(' | ')}`);

  console.log(JSON.stringify({
    schema: 'partmode.advanced-mates-ui-smoke/v1',
    browserBacked: true,
    chrome: await browser.version(),
    families: FAMILY_ORDER,
    lifecycle,
    pathPersistenceReload: true,
    typedRuntimeDocumentSetup: true,
    expressionPreservingCouplerReloadEdit: true,
    htmlLikeMateNameEscaping: true,
    strictRecords: true,
    solverSettlement: Object.fromEntries(Object.entries(exactEvidence).map(([family, evidence]) => [family, {
      state: evidence.solverState,
      residual: evidence.residual,
    }])),
    isolatedProductionWorker: {
      includeExactBrep: true,
      currentDocumentHashBound: true,
      exactBodiesAndNamedTopology: Object.fromEntries(Object.entries(exactEvidence).map(([family, evidence]) => [
        family,
        { bodies: evidence.bodies, topology: evidence.topology },
      ])),
    },
    consoleNetworkResponsePageErrors: 0,
  }, null, 2));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
