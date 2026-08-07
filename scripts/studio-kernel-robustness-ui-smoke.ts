import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import puppeteer, { type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, any>;

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-kernel-robustness-ui-'));
const SOURCE_FEATURE_ID = 'feature-ui-kernel-robustness-stock';
const SOURCE_BODY_ID = 'body-' + SOURCE_FEATURE_ID;
const PROJECT_LABEL = '<img src=x onerror="window.__pt018Injected=true"> rounded project';
const FEATURE_LABEL = '<svg onload="window.__pt018Injected=true"> tangent fillet';
const INITIAL_RADIUS = 1.5;
const EDITED_RADIUS = 2.25;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

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
  }, { polling: 100, timeout: 180_000 });
}

async function waitForPicker(page: Page, open: boolean): Promise<void> {
  await page.waitForFunction((expected) => {
    const picker = document.getElementById('bw-pick') as HTMLElement | null;
    const kind = (window as any).__bwStudio?.mode?.()?.kind;
    return expected
      ? picker?.hidden === false && kind === 'picking-edges'
      : picker?.hidden === true && kind === 'idle';
  }, { polling: 50, timeout: 60_000 }, open);
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

function historySelector(featureId: string): string {
  return `#bw-history .hist-item[data-sel="${featureId}"]`;
}

async function openClassicFillet(page: Page): Promise<void> {
  await clickVisible(page, 'button[data-feat="fillet"]');
  await waitForPicker(page, true);
  assert.equal(await page.$eval('#bw-pick-title', (element) => element.textContent), 'New fillet',
    'classic ribbon button opened the wrong edge feature');
  assert.equal(await page.$eval('#bw-pick-tangent-label', (element) => (element as HTMLElement).hidden), false,
    'classic Fillet did not expose tangent propagation');
  await assertHitTestable(page, '#bw-pick-tangent');
}

async function clickOneTopContourSeed(page: Page): Promise<JsonRecord> {
  const target = await page.evaluate((bodyId) => {
    const studio = (window as any).__bwStudio;
    studio.setViewForTest('top');
    studio.frame();
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[aria-label="3D modeling canvas"]');
    if (!canvas) throw new Error('3D modeling canvas is missing');
    const rect = canvas.getBoundingClientRect();
    const top = Number(studio.top());
    const candidates = studio.topologyInventoryForTest().filter((entry: JsonRecord) =>
      entry.owner?.kind === 'body'
      && entry.owner.id === bodyId
      && entry.topologySignature?.kind === 'edge'
      && Array.isArray(entry.topologySignature.p)
      && Math.abs(Number(entry.topologySignature.p[2]) - top) < 0.05
      && ['LINE', 'CIRCLE'].includes(entry.topologySignature.curveType));
    if (candidates.length !== 8) {
      throw new Error(`rounded stock exposes ${candidates.length} named top-contour edges instead of 8`);
    }
    const matches = (hit: JsonRecord, candidate: JsonRecord) =>
      hit?.curveType === candidate?.curveType
      && Math.abs(Number(hit?.l) - Number(candidate?.l)) < 0.05
      && Math.hypot(...[0, 1, 2].map((index) =>
        Number(hit?.p?.[index]) - Number(candidate?.p?.[index]))) < 0.05;
    const seen = new Set<string>();
    const groups = new Map<string, { candidate: JsonRecord; points: { x: number; y: number; fx: number; fy: number }[] }>();
    for (let row = 8; row <= 192; row += 2) {
      for (let column = 8; column <= 192; column += 2) {
        const fx = column / 200;
        const fy = row / 200;
        const hit = studio.pickAt(fx, fy);
        if (!hit?.sig) continue;
        seen.add(JSON.stringify(hit.sig));
        const candidate = candidates.find((entry: JsonRecord) => matches(hit.sig, entry.topologySignature));
        // Prefer a straight member of the contour. Averaging the full
        // hit-band for one line lands on its projected centre instead of the
        // looser 1.5 mm locator threshold's first boundary pixel; the actual
        // picker deliberately uses the tighter 1.2 mm trusted-click threshold.
        if (!candidate || candidate.topologySignature.curveType !== 'LINE') continue;
        const x = rect.left + fx * rect.width;
        const y = rect.top + fy * rect.height;
        const owner = document.elementFromPoint(x, y);
        if (owner !== canvas) continue;
        const group = groups.get(candidate.stableId) || {
          candidate,
          points: [] as { x: number; y: number; fx: number; fy: number }[],
        };
        group.points.push({ x, y, fx, fy });
        groups.set(candidate.stableId, group);
      }
    }
    const group = [...groups.values()].sort((left, right) => right.points.length - left.points.length)[0];
    if (group?.points.length) {
      const point = group.points.reduce((sum, entry) => ({
        x: sum.x + entry.x,
        y: sum.y + entry.y,
        fx: sum.fx + entry.fx,
        fy: sum.fy + entry.fy,
      }), { x: 0, y: 0, fx: 0, fy: 0 });
      const count = group.points.length;
      return {
        x: point.x / count,
        y: point.y / count,
        fx: point.fx / count,
        fy: point.fy / count,
        top,
        stableId: group.candidate.stableId,
        topologySignature: group.candidate.topologySignature,
        expectedGeometry: group.candidate.expectedGeometry,
        seenCount: seen.size,
        locatorBandSamples: count,
      };
    }
    throw new Error(`no hit-testable named top edge found; candidates=${JSON.stringify(candidates)} seen=${JSON.stringify([...seen])}`);
  }, SOURCE_BODY_ID);
  assert.ok(Number.isFinite(target.x) && Number.isFinite(target.y), 'top-edge locator returned no finite canvas point');
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(() =>
    document.getElementById('bw-pick-count')?.textContent === '1 picked'
      && (window as any).__bwStudio.mode()?.count === 1,
  { polling: 50, timeout: 30_000 });
  return target;
}

async function isolatedExact(page: Page, documentOverride: JsonRecord | null = null): Promise<JsonRecord> {
  await waitForSettlement(page);
  return page.evaluate(async (override) => {
    const studio = (window as any).__bwStudio;
    const studioScript = [...document.scripts].find((entry) => entry.src.includes('/studio.js'));
    if (!studioScript) throw new Error('versioned Studio module URL is missing');
    const workerUrl = new URL('studio-kernel.worker.js', studioScript.src).href;
    const worker = new Worker(workerUrl, { type: 'module' });
    const requestId = `kernel-robustness-ui-${crypto.randomUUID()}`;
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
          kind: 'rebuild',
          requestId,
          projectId: studio.projectId(),
          revision: studio.documentRevision(),
          document: override || JSON.parse(studio.docJson()),
          includeExactBrep: true,
        });
      });
      return JSON.parse(JSON.stringify({
        kind: response.kind,
        revision: response.revision,
        effectiveDocumentHash: response.effectiveDocumentHash || null,
        documentRevision: studio.documentRevision(),
        appliedRevision: studio.appliedRevision(),
        canonicalHash: override ? null : studio.canonicalHash(),
        errors: response.errors || [],
        bodies: response.bodies || [],
      }));
    } finally {
      worker.terminate();
    }
  }, documentOverride);
}

function assertExactBody(snapshot: JsonRecord, label: string, currentDocument = true): JsonRecord {
  assert.equal(snapshot.kind, 'rebuild-result', `${label}: isolated worker returned the wrong response kind`);
  if (currentDocument) {
    assert.equal(snapshot.revision, snapshot.documentRevision, `${label}: isolated production-worker proof is stale`);
    assert.equal(snapshot.appliedRevision, snapshot.documentRevision, `${label}: visible rebuild is not settled`);
    assert.equal(snapshot.effectiveDocumentHash, snapshot.canonicalHash,
      `${label}: isolated production-worker proof is not current-document-hash-bound`);
  }
  assert.deepEqual(snapshot.errors, [], `${label}: isolated production worker reported CAD errors`);
  const body = snapshot.bodies.find((entry: JsonRecord) => entry.bodyId === SOURCE_BODY_ID);
  assert.ok(body, `${label}: exact rounded stock body is missing`);
  assert.equal(body.error, null, `${label}: exact rounded stock has an error`);
  assert.equal(body.lastValid, false, `${label}: exact rounded stock reused last-valid geometry`);
  assert.equal(body.geometry?.valid, true, `${label}: exact rounded stock is invalid`);
  assert.equal(body.geometry?.brepValid, true, `${label}: BRepCheck rejected the rounded stock`);
  assert.equal(body.geometry?.solidCount, 1, `${label}: rounded stock is not exactly one solid`);
  assert.ok(typeof body.exactBrep === 'string' && body.exactBrep.length > 100,
    `${label}: canonical exact BREP is missing`);
  const counts = body.mesh?.topologyCounts;
  assert.ok(counts, `${label}: serialized exact topology counts are missing`);
  for (const [plural, countKey, namedKey, records] of [
    ['faces', 'faceCount', 'namedFaces', body.mesh?.topologyFaces],
    ['edges', 'edgeCount', 'namedEdges', body.mesh?.edges],
    ['vertices', 'vertexCount', 'namedVertices', body.mesh?.topologyVertices],
  ] as const) {
    assert.equal(Number(counts[plural]), Number(body.geometry?.[countKey]),
      `${label}: serialized ${plural} disagree with exact geometry`);
    assert.equal(Number(counts[namedKey]), Number(counts[plural]),
      `${label}: not every exact ${plural.slice(0, -1)} has a persistent name`);
    assert.equal(records?.length, Number(counts[plural]),
      `${label}: serialized ${plural} records are incomplete`);
  }
  assert.deepEqual(body.mesh?.topologyDiagnostics || [], [], `${label}: exact topology naming emitted diagnostics`);
  return body;
}

async function assertCurrentPublicTopologyComplete(page: Page, body: JsonRecord, label: string): Promise<void> {
  const counts = await page.evaluate((bodyId) => {
    const inventory = (window as any).__bwStudio.topologyInventoryForTest()
      .filter((entry: JsonRecord) => entry.owner?.kind === 'body' && entry.owner.id === bodyId);
    return Object.fromEntries(['face', 'edge', 'vertex'].map((kind) => [kind,
      inventory.filter((entry: JsonRecord) => entry.topologySignature?.kind === kind).length]));
  }, SOURCE_BODY_ID);
  assert.equal(counts.face, body.geometry.faceCount, `${label}: public named face inventory is incomplete`);
  assert.equal(counts.edge, body.geometry.edgeCount, `${label}: public named edge inventory is incomplete`);
  assert.equal(counts.vertex, body.geometry.vertexCount, `${label}: public named vertex inventory is incomplete`);
}

async function openTypedFillet(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    const agent = (window as any).partmodeAgent;
    const connection = await studio.connectAgentForTest({
      clientLabel: 'PT018 visible exact tangent-chain Fillet',
      mode: 'scoped-auto-commit',
      permissionContext: {
        granted: ['project.read', 'project.edit', 'ui.read', 'ui.select', 'ui.command-draft', 'ui.present-preview'],
        operationKinds: ['feature.fillet'],
        maxCommits: 1,
      },
    });
    const token = connection.connectionToken;
    const snapshot = await agent.requestTool(token, 'cad_ui', { action: 'snapshot' }, 'pt018-open-snapshot');
    const opened = await agent.requestTool(token, 'cad_ui', {
      action: 'apply',
      expectedUiRevision: snapshot.uiRevision,
      actions: [{ kind: 'command.open', commandId: 'model.fillet' }],
      presentation: { mode: 'instant', transition: 'cut' },
    }, 'pt018-open-command');
    const result = opened.results?.find((entry: JsonRecord) => entry.kind === 'command.open')?.result;
    if (result?.activeCommand?.commandId !== 'model.fillet') {
      throw new Error(`typed visible Fillet did not open: ${JSON.stringify(opened)}`);
    }
    return token;
  });
}

async function previewTypedFillet(page: Page, token: string): Promise<JsonRecord> {
  return page.evaluate(async (connectionToken) => {
    const studio = (window as any).__bwStudio;
    const agent = (window as any).partmodeAgent;
    const before = await agent.requestTool(connectionToken, 'cad_ui', { action: 'snapshot' }, 'pt018-preview-snapshot');
    const active = before.activeCommand;
    if (
      active?.commandId !== 'model.fillet'
      || active?.inputValues?.radius !== 1.5
      || active?.inputValues?.tangentPropagation !== true
      || active?.boundSelections?.edges?.length !== 1
      || !active.boundSelections.edges[0]?.stableId
    ) {
      throw new Error(`visible Fillet draft lost radius, tangent propagation, or persistent seed: ${JSON.stringify(active)}`);
    }
    const batch = await agent.requestTool(connectionToken, 'cad_ui', {
      action: 'apply',
      expectedUiRevision: before.uiRevision,
      actions: [{ kind: 'command.preview' }],
      presentation: { mode: 'instant', transition: 'cut' },
    }, 'pt018-preview-command');
    const preview = batch.results?.find((entry: JsonRecord) => entry.kind === 'command.preview')?.result;
    const after = await agent.requestTool(connectionToken, 'cad_ui', { action: 'snapshot' }, 'pt018-preview-after');
    return JSON.parse(JSON.stringify({
      preview,
      activeBefore: active,
      activeAfter: after.activeCommand,
      previewAfter: after.preview,
      detached: studio.detachedPreviewForTest(),
    }));
  }, token);
}

function assertKernelRobustnessEvidence(
  body: JsonRecord,
  documentHash: string,
  feature: JsonRecord,
  sourceDigest: string,
  label: string,
): JsonRecord {
  const records = body.kernelRobustnessEvidence || [];
  assert.equal(records.length, 1, `${label}: exact body does not have one kernel-robustness record`);
  const evidence = records[0];
  assert.equal(evidence.schema, 'partmode.kernel-robustness/v1', `${label}: evidence has the wrong schema`);
  assert.equal(evidence.policy, 'occt-exact-tangent-contour-v1', `${label}: evidence has the wrong policy`);
  assert.equal(evidence.mode, 'tangent-chain-fillet', `${label}: evidence has the wrong mode`);
  assert.equal(evidence.featureId, feature.id, `${label}: evidence is bound to the wrong feature`);
  assert.equal(evidence.documentHash, documentHash, `${label}: evidence is not bound to the current document`);
  assert.equal(evidence.sourceBrepSha256, sourceDigest, `${label}: evidence is not bound to the source exact BREP`);
  assert.equal(evidence.resultBrepSha256, sha256(body.exactBrep), `${label}: evidence is not bound to the result exact BREP`);
  assert.notEqual(evidence.resultBrepSha256, evidence.sourceBrepSha256,
    `${label}: tangent Fillet result reused the source exact BREP`);
  assert.ok(closeTo(evidence.radiusMm, feature.r), `${label}: evidence has the wrong radius`);
  assert.equal(evidence.sourceEdgeCount, 24, `${label}: evidence has the wrong rounded-stock edge count`);
  assert.deepEqual(evidence.selectedEdgeNames, [feature.edges[0].name],
    `${label}: evidence is not bound to the one authored persistent seed`);
  assert.equal(new Set(evidence.expandedEdgeNames).size, 8,
    `${label}: exact tangent propagation did not expand to 8 unique edges`);
  assert.ok(evidence.expandedEdgeNames.includes(feature.edges[0].name),
    `${label}: expanded contour omitted its authored seed`);
  assert.equal(evidence.contourCount, 1, `${label}: authored seed resolved more than one contour`);
  assert.equal(evidence.contours?.length, 1, `${label}: contour evidence is incomplete`);
  assert.equal(evidence.contours[0].edgeCount, 8, `${label}: exact contour does not contain 8 edges`);
  assert.equal(evidence.contours[0].closedAndTangent, true, `${label}: OCCT did not prove a closed tangent contour`);
  assert.equal(new Set(evidence.contours[0].edgeNames).size, 8, `${label}: contour repeats an edge`);
  assert.deepEqual(evidence.resultTopology, {
    faces: body.geometry.faceCount,
    edges: body.geometry.edgeCount,
    vertices: body.geometry.vertexCount,
  }, `${label}: result-topology evidence disagrees with exact geometry`);
  return evidence;
}

function assertStoredFillet(feature: JsonRecord, radius: number, label: string): void {
  assert.ok(feature, `${label}: persistent Fillet feature is missing`);
  assert.equal(feature.type, 'fillet', `${label}: stored feature has the wrong type`);
  assert.ok(closeTo(feature.r, radius), `${label}: stored radius is wrong`);
  assert.equal(feature.tangentPropagation, true, `${label}: tangent propagation was not persisted`);
  assert.equal(feature.edges?.length, 1, `${label}: stored Fillet does not have exactly one authored seed`);
  assert.ok(typeof feature.edges[0]?.name === 'string' && feature.edges[0].name.length > 0,
    `${label}: authored seed has no persistent topology name`);
  assert.ok(feature.edges[0]?.sig && typeof feature.edges[0].sig === 'object',
    `${label}: authored seed has no topology signature snapshot`);
  assert.deepEqual(feature.extensions?.kernelRobustness, {
    schema: 'partmode.kernel-robustness/v1',
    tangentFilletPolicy: 'occt-exact-tangent-contour-v1',
  }, `${label}: typed tangent Fillet did not persist the exact-policy contract`);
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
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('bw-studio-welcome-v1', '1');
    (window as any).__pt018Injected = false;
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
  assert.equal(response?.status(), 200, 'PT018 UI route did not return HTTP 200');
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  if (await page.$eval('#pm-cookie-banner', (element) => !(element as HTMLElement).hidden)) {
    await clickVisible(page, '#pm-cookie-essential');
    await page.waitForFunction(() => (document.getElementById('pm-cookie-banner') as HTMLElement | null)?.hidden === true,
      { polling: 50, timeout: 30_000 });
  }
  await clickVisible(page, '[data-workspace="solid"]');

  await page.evaluate(async (fixture) => {
    const studio = (window as any).__bwStudio;
    await studio.commitHumanOperationsForTest('Seed exact rounded-rectangle stock', [
      { kind: 'project.clear', input: {} },
      { kind: 'project.rename', input: { name: fixture.projectLabel } },
      {
        kind: 'feature.extrude',
        input: {
          id: fixture.featureId,
          name: 'Exact rounded-rectangle stock',
          sketch: {
            id: 'sketch-ui-kernel-robustness-stock',
            name: 'Eight-edge tangent profile',
            shapes: [{ id: 'shape-ui-kernel-robustness-placeholder', kind: 'rect', x: 0, y: 0, w: 40, h: 24 }],
            entities: [
              { id: 'rounded-bottom', kind: 'line', a: [-14, -12], b: [14, -12] },
              { id: 'rounded-bottom-right', kind: 'arc', start: [14, -12], end: [20, -6], center: [14, -6], clockwise: false },
              { id: 'rounded-right', kind: 'line', a: [20, -6], b: [20, 6] },
              { id: 'rounded-top-right', kind: 'arc', start: [20, 6], end: [14, 12], center: [14, 6], clockwise: false },
              { id: 'rounded-top', kind: 'line', a: [14, 12], b: [-14, 12] },
              { id: 'rounded-top-left', kind: 'arc', start: [-14, 12], end: [-20, 6], center: [-14, 6], clockwise: false },
              { id: 'rounded-left', kind: 'line', a: [-20, 6], b: [-20, -6] },
              { id: 'rounded-bottom-left', kind: 'arc', start: [-20, -6], end: [-14, -12], center: [-14, -6], clockwise: false },
            ],
            groups: [],
            constraints: [],
            z: 0,
          },
          plane: 'XY',
          height: 12,
          resultPolicy: { kind: 'new-body', bodyName: 'Rounded tangent-chain stock' },
          extensions: { exactSketchEntities: true },
        },
      },
    ]);
  }, { featureId: SOURCE_FEATURE_ID, projectLabel: PROJECT_LABEL });
  await waitForSettlement(page);

  const sourceDocument = await readDocument(page);
  const baselineSnapshot = await isolatedExact(page);
  const baselineBody = assertExactBody(baselineSnapshot, 'rounded stock baseline');
  assert.equal(baselineBody.geometry.faceCount, 10, 'rounded stock does not have 8 side faces plus 2 caps');
  assert.equal(baselineBody.geometry.edgeCount, 24, 'rounded stock does not have 8 top, 8 bottom, and 8 vertical edges');
  assert.equal(baselineBody.geometry.vertexCount, 16, 'rounded stock does not have 16 exact vertices');
  await assertCurrentPublicTopologyComplete(page, baselineBody, 'rounded stock baseline');
  const sourceDigest = sha256(baselineBody.exactBrep);

  // The ordinary classic ribbon command, a trusted canvas pick, the visible
  // checkbox, and a changed radius are a transactional draft until Cancel.
  const beforeCancel = await projectState(page);
  await openClassicFillet(page);
  await clickOneTopContourSeed(page);
  await clickVisible(page, '#bw-pick-tangent');
  assert.equal(await page.$eval('#bw-pick-tangent', (element) => (element as HTMLInputElement).checked), true,
    'trusted checkbox click did not enable exact tangent propagation');
  await replaceValue(page, '#bw-pick-r', '1.25');
  assert.deepEqual(await projectState(page), beforeCancel,
    'classic Fillet draft mutated document bytes, hash, revision, or history before Apply');
  await clickVisible(page, '#bw-pick-cancel');
  await waitForPicker(page, false);
  assert.deepEqual(await projectState(page), beforeCancel,
    'Cancel mutated document bytes, hash, revision, or history');

  // Open the same classic picker through the typed visible-command runtime.
  // Real human controls update its typed draft, the production worker runs an
  // exact preview, and the human-owned visible Apply commits that preview.
  const typedToken = await openTypedFillet(page);
  await waitForPicker(page, true);
  assert.equal(await page.$eval('#bw-pick-title', (element) => element.textContent), 'New fillet',
    'typed visible command did not open the classic Fillet picker');
  const authoredSeed = await clickOneTopContourSeed(page);
  await clickVisible(page, '#bw-pick-tangent');
  await replaceValue(page, '#bw-pick-r', String(INITIAL_RADIUS));
  const beforePreview = await projectState(page);
  const typedPreview = await previewTypedFillet(page, typedToken);
  assert.equal(typedPreview.preview?.validation?.valid, true, 'typed tangent Fillet preview did not validate');
  assert.equal(typedPreview.preview?.validation?.exactGeometry, true, 'typed tangent Fillet preview was not exact');
  assert.equal(typedPreview.preview?.evidence?.exactGeometry, true, 'typed tangent Fillet preview omitted exact evidence');
  assert.equal(typedPreview.activeAfter?.state, 'preview',
    'visible command did not retain its exact preview state');
  assert.equal(typedPreview.previewAfter?.previewId, typedPreview.preview?.previewId,
    'cad_ui snapshot did not expose the exact preview');
  assert.equal(typedPreview.detached?.activePreviewVisible, true, 'exact Fillet preview is not visible in the viewport');
  assert.deepEqual(await projectState(page), beforePreview,
    'typed exact preview mutated document bytes, hash, revision, or history');
  await clickVisible(page, '#bw-pick-apply');
  await waitForPicker(page, false);
  await waitForSettlement(page);
  await page.evaluate((token) => (window as any).partmodeAgent.disconnect(token), typedToken);

  let part = await readPart(page);
  let feature = part.features.find((entry: JsonRecord) => entry.type === 'fillet');
  assertStoredFillet(feature, INITIAL_RADIUS, 'visible typed Fillet create');
  assert.ok(closeTo(feature.edges[0].sig?.l, authoredSeed.topologySignature?.l),
    'visible trusted pick stored a different edge length');
  assert.ok(Math.hypot(...[0, 1, 2].map((index) =>
    Number(feature.edges[0].sig?.p?.[index]) - Number(authoredSeed.topologySignature?.p?.[index]))) < 0.05,
  'visible trusted pick stored a different edge midpoint');
  const filletId = feature.id;
  assert.ok((await projectState(page)).documentRevision > beforePreview.documentRevision,
    'visible Apply did not advance the document revision');

  await page.evaluate(async (input) => {
    await (window as any).__bwStudio.commitHumanOperationsForTest('Give tangent Fillet a literal-safe label', [{
      kind: 'feature.update', input: { featureId: input.featureId, patch: { name: input.name } },
    }]);
  }, { featureId: filletId, name: FEATURE_LABEL });
  await waitForSettlement(page);
  part = await readPart(page);
  feature = part.features.find((entry: JsonRecord) => entry.id === filletId);
  assertStoredFillet(feature, INITIAL_RADIUS, 'literal-safe Fillet');
  assert.equal(feature.name, FEATURE_LABEL, 'typed update did not retain the literal feature label');
  assert.equal(await page.$eval('#bw-project-name', (element) => element.textContent), PROJECT_LABEL,
    'project label was not rendered literally');
  await clickVisible(page, `${historySelector(filletId)} .hi-sel`);
  assert.match(await page.$eval('#bw-studio-msg', (element) => element.textContent || ''), /<svg onload=/u,
    'selected feature status did not render its HTML-like label literally');
  assert.equal(await page.$$eval('img[src="x"], svg[onload]', (elements) => elements.length), 0,
    'HTML-like project or feature label created executable markup');
  assert.equal(await page.evaluate(() => (window as any).__pt018Injected), false,
    'HTML-like project or feature label executed script');

  await page.evaluate(async () => (window as any).__bwStudio.flushStorage());
  const saved = await projectState(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  await waitForSettlement(page);
  const reopened = await projectState(page);
  assert.equal(reopened.docJson, saved.docJson, 'save/reload changed canonical tangent-Fillet document bytes');
  assert.equal(reopened.canonicalHash, saved.canonicalHash, 'save/reload changed tangent-Fillet document hash');
  part = await readPart(page);
  feature = part.features.find((entry: JsonRecord) => entry.id === filletId);
  assertStoredFillet(feature, INITIAL_RADIUS, 'save/reopened Fillet');
  assert.equal(feature.name, FEATURE_LABEL, 'save/reload lost the literal feature label');
  assert.equal(await page.$eval('#bw-project-name', (element) => element.textContent), PROJECT_LABEL,
    'save/reload lost the literal project label');
  assert.equal(await page.$$eval('img[src="x"], svg[onload]', (elements) => elements.length), 0,
    'save/reload injected HTML-like project or feature markup');
  assert.equal(await page.evaluate(() => (window as any).__pt018Injected), false,
    'save/reload executed HTML-like project or feature markup');

  const reopenedSnapshot = await isolatedExact(page);
  const reopenedBody = assertExactBody(reopenedSnapshot, 'save/reopened tangent Fillet');
  await assertCurrentPublicTopologyComplete(page, reopenedBody, 'save/reopened tangent Fillet');
  const reopenedEvidence = assertKernelRobustnessEvidence(
    reopenedBody,
    reopenedSnapshot.canonicalHash,
    feature,
    sourceDigest,
    'save/reopened tangent Fillet',
  );

  // Visible radius-only edit retains the one authored source seed and tangent
  // checkbox even though the result Fillet has replaced that source edge.
  await clickVisible(page, '[data-workspace="solid"]');
  await clickVisible(page, `${historySelector(filletId)} [data-edit="${filletId}"]`);
  await waitForPicker(page, true);
  assert.equal(await page.$eval('#bw-pick-tangent', (element) => (element as HTMLInputElement).checked), true,
    'visible edit did not preload tangent propagation');
  assert.ok(closeTo(await page.$eval('#bw-pick-r', (element) => (element as HTMLInputElement).value), INITIAL_RADIUS),
    'visible edit did not preload the persisted radius');
  await replaceValue(page, '#bw-pick-r', String(EDITED_RADIUS));
  await clickVisible(page, '#bw-pick-apply');
  await waitForPicker(page, false);
  await waitForSettlement(page);
  part = await readPart(page);
  feature = part.features.find((entry: JsonRecord) => entry.id === filletId);
  assertStoredFillet(feature, EDITED_RADIUS, 'visible Fillet edit');
  assert.equal(feature.name, FEATURE_LABEL, 'visible radius edit lost the literal feature label');
  const editedSnapshot = await isolatedExact(page);
  const editedBody = assertExactBody(editedSnapshot, 'visible tangent Fillet edit');
  const editedEvidence = assertKernelRobustnessEvidence(
    editedBody,
    editedSnapshot.canonicalHash,
    feature,
    sourceDigest,
    'visible tangent Fillet edit',
  );
  assert.notEqual(editedEvidence.resultBrepSha256, reopenedEvidence.resultBrepSha256,
    'visible radius edit reused stale exact result BREP');

  const beforeEditCancel = await projectState(page);
  await clickVisible(page, `${historySelector(filletId)} [data-edit="${filletId}"]`);
  await waitForPicker(page, true);
  await replaceValue(page, '#bw-pick-r', '3');
  await clickVisible(page, '#bw-pick-tangent');
  assert.deepEqual(await projectState(page), beforeEditCancel,
    'visible edit draft mutated the document before Cancel');
  await clickVisible(page, '#bw-pick-cancel');
  await waitForPicker(page, false);
  assert.deepEqual(await projectState(page), beforeEditCancel,
    'visible edit Cancel mutated the exact document or history');

  await clickVisible(page, `${historySelector(filletId)} .hi-sel[data-sel="${filletId}"]`);
  await clickVisible(page, `${historySelector(filletId)} [data-del="${filletId}"]`);
  await waitForSettlement(page);
  assert.equal((await readPart(page)).features.some((entry: JsonRecord) => entry.id === filletId), false,
    'visible typed delete left the tangent Fillet in feature history');
  const restoredSnapshot = await isolatedExact(page);
  const restoredBody = assertExactBody(restoredSnapshot, 'visible tangent Fillet delete');
  assert.equal(restoredBody.exactBrep, baselineBody.exactBrep,
    'visible typed delete did not restore the exact source BREP');
  assert.deepEqual(restoredBody.kernelRobustnessEvidence || [], [],
    'visible typed delete left stale kernel-robustness evidence');
  await assertCurrentPublicTopologyComplete(page, restoredBody, 'visible tangent Fillet delete');
  assert.equal(sha256(restoredBody.exactBrep), sourceDigest, 'delete restoration changed source exact-BREP digest');
  assert.equal(JSON.stringify(sourceDocument), JSON.stringify(await readDocument(page)),
    'create/edit/delete lifecycle did not restore the ordinary typed source document');
  assert.deepEqual(failures, [], `kernel-robustness browser gate reported errors: ${failures.join(' | ')}`);

  console.log(JSON.stringify({
    schema: 'partmode.kernel-robustness-ui-smoke/v1',
    browserBacked: true,
    chrome: await browser.version(),
    ordinaryTypedSource: true,
    directStorageFixture: false,
    visibleClassicRibbon: true,
    trustedCanvasSeedPick: true,
    visibleTangentCheckbox: true,
    typedExactPreview: true,
    humanVisibleApply: true,
    saveReload: true,
    exactPolicyPersisted: true,
    currentDocumentHashBound: true,
    sourceBrepSha256: sourceDigest,
    resultBrepSha256: reopenedEvidence.resultBrepSha256,
    selectedSeedCount: 1,
    expandedEdgeCount: 8,
    closedAndTangent: true,
    topologyComplete: true,
    literalSafe: true,
    visibleEdit: { fromRadiusMm: INITIAL_RADIUS, toRadiusMm: EDITED_RADIUS },
    cancelAtomic: true,
    deleteRestoredSource: true,
    zeroBrowserErrors: true,
  }, null, 2));

  await context.close();
} finally {
  await browser?.close().catch(() => {});
  await local?.close().catch(() => {});
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
