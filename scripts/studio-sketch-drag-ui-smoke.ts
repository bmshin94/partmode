import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type AnyRecord = Record<string, any>;
type Point2 = [number, number];

type ScaleFixture = {
  totalEntities: number;
  sketch: AnyRecord;
  handleId: string;
  fixedHandleId: string;
  target: Point2;
  componentEntityIds: string[];
  componentPointIds: string[];
  componentLineIds: string[];
  fixedEntityIds: string[];
};

type DragEvidence = {
  telemetry: AnyRecord;
  paintedSamples: number;
  pointerEvents: AnyRecord[];
};

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-sketch-drag-ui-'));
const runtimeSeed = randomBytes(4).readUInt32LE(0);
const MAX_SAMPLE_P95_MS = 75;
const MAX_SAMPLE_MS = 125;
const MAX_SETTLE_MS = 500;
const MAX_DRAG_HEAP_GROWTH = 64 * 1024 * 1024;
const MAX_TOTAL_HEAP_GROWTH = 128 * 1024 * 1024;
const TARGET_TOLERANCE = 1e-7;

function check(label: string, condition: unknown): asserts condition {
  assert.ok(condition, `Sketch drag UI smoke failed: ${label}`);
}

function collectPageFailures(page: Page, failures: string[]): void {
  page.on('pageerror', (error) => {
    failures.push(`pageerror: ${error instanceof Error ? error.message : String(error)}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (request) => failures.push(
    `requestfailed: ${request.url()} ${request.failure()?.errorText ?? 'unknown'}`,
  ));
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`response: ${response.status()} ${response.url()}`);
  });
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function pointDistance(left: Point2, right: Point2): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1]);
}

function buildScaleFixture(totalEntities: 500 | 1000, seed: number): ScaleFixture {
  const random = mulberry32(seed ^ totalEntities);
  const entities: AnyRecord[] = [];
  const constraints: AnyRecord[] = [];
  const componentPointIds: string[] = [];
  const componentLineIds: string[] = [];

  // 64 points plus 63 lines is an exact 127-entity connected component.
  // Signed horizontal/vertical differences retain its authored shape while
  // leaving the two rigid-translation coordinates free for direct dragging.
  let x = -40;
  let y = -10;
  const componentPoints: AnyRecord[] = [];
  for (let index = 0; index < 64; index++) {
    if (index === 1) x += 15;
    else if (index > 1) {
      x += 1;
      let yStep = Math.floor(random() * 3) - 1;
      if (y > 3) yStep = -1;
      if (y < -17) yStep = 1;
      y += yStep;
    }
    const id = `move-point-${String(index).padStart(3, '0')}`;
    componentPointIds.push(id);
    componentPoints.push({ id, kind: 'point', at: [x, y] });
  }
  entities.push(...componentPoints);
  for (let index = 0; index < componentPoints.length - 1; index++) {
    const left = componentPoints[index]!;
    const right = componentPoints[index + 1]!;
    const lineId = `move-line-${String(index).padStart(3, '0')}`;
    componentLineIds.push(lineId);
    entities.push({ id: lineId, kind: 'line', a: left.id, b: right.id });
    constraints.push(
      {
        id: `move-dx-${String(index).padStart(3, '0')}`,
        kind: 'horizontalDistance',
        a: left.id,
        b: right.id,
        value: right.at[0] - left.at[0],
      },
      {
        id: `move-dy-${String(index).padStart(3, '0')}`,
        kind: 'verticalDistance',
        a: left.id,
        b: right.id,
        value: right.at[1] - left.at[1],
      },
    );
  }

  const componentEntityIds = [...componentPointIds, ...componentLineIds];
  check(`${totalEntities}-entity component is not exactly 127 entities`, componentEntityIds.length === 127);

  // The odd-sized remainder is a serpentine fixed construction raster:
  // N fixed points joined by N-1 fixed-reference lines. Every scale entity
  // therefore remains real sketch geometry rather than inert padding.
  const remainder = totalEntities - componentEntityIds.length;
  const fixedPointCount = (remainder + 1) / 2;
  check(`${totalEntities}-entity fixed remainder cannot form a polyline`, Number.isInteger(fixedPointCount));
  const fixedPoints: AnyRecord[] = [];
  for (let index = 0; index < fixedPointCount; index++) {
    const row = Math.floor(index / 32);
    const offset = index % 32;
    const column = row % 2 === 0 ? offset : 31 - offset;
    fixedPoints.push({
      id: `fixed-point-${String(index).padStart(3, '0')}`,
      kind: 'point',
      at: [-31 + column * 2, 35 + row * 2],
      fixed: true,
      construction: true,
    });
  }
  const fixedLines: AnyRecord[] = [];
  for (let index = 0; index < fixedPoints.length - 1; index++) {
    fixedLines.push({
      id: `fixed-line-${String(index).padStart(3, '0')}`,
      kind: 'line',
      a: fixedPoints[index]!.id,
      b: fixedPoints[index + 1]!.id,
      construction: true,
    });
  }
  entities.push(...fixedPoints, ...fixedLines);
  const fixedEntityIds = [...fixedPoints, ...fixedLines].map((entity) => entity.id);

  const handle = componentPoints[0]!;
  const target: Point2 = [
    handle.at[0] + 10 + Math.floor(random() * 3),
    handle.at[1] + 6 + Math.floor(random() * 3),
  ];
  const sketch = { entities, constraints };
  check(`${totalEntities}-entity fixture has the wrong entity count`, entities.length === totalEntities);
  check(`${totalEntities}-entity fixture does not have 126 shape-preserving constraints`, constraints.length === 126);
  check(`${totalEntities}-entity remainder contains a non-fixed point`, fixedPoints.every((point) => point.fixed === true));
  check(`${totalEntities}-entity remainder contains inert data`, fixedLines.every((line) => line.kind === 'line' && line.construction === true));
  return {
    totalEntities,
    sketch,
    handleId: handle.id,
    fixedHandleId: fixedPoints[0]!.id,
    target,
    componentEntityIds,
    componentPointIds,
    componentLineIds,
    fixedEntityIds,
  };
}

const rectangleSketch: AnyRecord = {
  entities: [
    { id: 'rect-p0', kind: 'point', at: [-12, -6] },
    { id: 'rect-p1', kind: 'point', at: [8, -6] },
    { id: 'rect-p2', kind: 'point', at: [8, 6] },
    { id: 'rect-p3', kind: 'point', at: [-12, 6] },
    { id: 'rect-l0', kind: 'line', a: 'rect-p0', b: 'rect-p1' },
    { id: 'rect-l1', kind: 'line', a: 'rect-p1', b: 'rect-p2' },
    { id: 'rect-l2', kind: 'line', a: 'rect-p2', b: 'rect-p3' },
    { id: 'rect-l3', kind: 'line', a: 'rect-p3', b: 'rect-p0' },
  ],
  constraints: [
    { id: 'rect-p0-p1-x', kind: 'horizontalDistance', a: 'rect-p0', b: 'rect-p1', value: 20 },
    { id: 'rect-p0-p1-y', kind: 'verticalDistance', a: 'rect-p0', b: 'rect-p1', value: 0 },
    { id: 'rect-p1-p2-x', kind: 'horizontalDistance', a: 'rect-p1', b: 'rect-p2', value: 0 },
    { id: 'rect-p1-p2-y', kind: 'verticalDistance', a: 'rect-p1', b: 'rect-p2', value: 12 },
    { id: 'rect-p2-p3-x', kind: 'horizontalDistance', a: 'rect-p2', b: 'rect-p3', value: -20 },
    { id: 'rect-p2-p3-y', kind: 'verticalDistance', a: 'rect-p2', b: 'rect-p3', value: 0 },
  ],
};
const rectangleTarget: Point2 = [-5, 1];

const projectedSketch: AnyRecord = {
  entities: [
    { id: 'project-origin', kind: 'point', at: [0, 0], fixed: true },
    { id: 'project-handle', kind: 'point', at: [10, -4] },
    { id: 'project-line', kind: 'line', a: 'project-origin', b: 'project-handle' },
  ],
  constraints: [
    { id: 'project-fixed-x', kind: 'horizontalDistance', a: 'project-origin', b: 'project-handle', value: 10 },
  ],
};
const projectedTarget: Point2 = [17, 9];
const projectedAchievedTarget: Point2 = [10, 9];

async function openSketch(page: Page, sketch: AnyRecord): Promise<void> {
  await page.evaluate((source) => (window as any).__bwStudio.openConstrainedSketchForTest(source), sketch);
  await page.waitForFunction((entityCount) => {
    const studio = (window as any).__bwStudio;
    const visual = studio?.sketchVisualState?.();
    const draft = studio?.sketchDraftForTest?.();
    const canvas = document.querySelector('#bw-sketch-canvas');
    const bounds = canvas?.getBoundingClientRect();
    return visual?.visible === true
      && visual.solverStatus === 'ok'
      && visual.geometry?.length === entityCount
      && draft?.sketch?.constrained?.entities?.length === entityCount
      && bounds && bounds.width > 100 && bounds.height > 100;
  }, { polling: 50, timeout: 180_000 }, sketch.entities.length);
}

async function clickVisible(page: Page, selector: string): Promise<Point2> {
  await page.waitForFunction((candidate) => {
    const element = document.querySelector(candidate) as HTMLElement | null;
    if (!element || !element.isConnected) return false;
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return !(element as HTMLButtonElement).disabled
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity) > 0
      && bounds.width > 2
      && bounds.height > 2;
  }, { polling: 20, timeout: 120_000 }, selector);
  const target = await page.evaluate((candidate) => {
    const element = document.querySelector(candidate) as HTMLElement;
    const bounds = element.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      x,
      y,
      ownsPoint: Boolean(top && (top === element || element.contains(top))),
    };
  }, selector);
  check(`visible control ${selector} does not own its centre point`, target.ownsPoint);
  await page.mouse.click(target.x, target.y, { button: 'left' });
  return [target.x, target.y];
}

async function authorNormalUserLineProfile(page: Page): Promise<{
  sketch: AnyRecord;
  clickCount: number;
}> {
  await clickVisible(page, '#bw-welcome-start');
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    const canvas = document.querySelector('#bw-sketch-canvas');
    const bounds = canvas?.getBoundingClientRect();
    return studio?.sketchVisualState?.().visible === true
      && studio?.sketchDraftForTest?.()?.sketch?.shapes?.length === 0
      && bounds && bounds.width > 100 && bounds.height > 100;
  }, { polling: 20, timeout: 120_000 });
  await clickVisible(page, '[data-sktool="line"]');
  const profile: Point2[] = [[-12, -8], [12, -8], [12, 8], [-12, 8]];
  for (const point of [...profile, profile[0]!]) {
    const target = await clientPoint(page, point);
    await page.mouse.click(target[0], target[1], { button: 'left' });
  }
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    const draft = studio?.sketchDraftForTest?.();
    const constrained = draft?.sketch?.constrained;
    const visual = studio?.sketchVisualState?.();
    return constrained?.entities?.length === 8
      && constrained.entities.filter((entity: any) => entity.kind === 'point').length === 4
      && constrained.entities.filter((entity: any) => entity.kind === 'line').length === 4
      && constrained.constraints?.length >= 4
      && visual?.solverStatus === 'ok'
      && visual.geometry?.length === 8
      && document.querySelector('[data-sktool="select"]')?.getAttribute('aria-pressed') === 'true';
  }, { polling: 20, timeout: 120_000 });
  const draft = await page.evaluate(() => (window as any).__bwStudio.sketchDraftForTest());
  check('normal Line workflow did not author a constrained sketch', Boolean(draft.sketch.constrained));
  return { sketch: draft.sketch.constrained, clickCount: profile.length + 1 };
}

async function clientPoint(page: Page, point: Point2): Promise<Point2> {
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
  check(`sketch point ${JSON.stringify(point)} is outside the visible canvas`,
    location.x >= location.rect.left + 2
    && location.x <= location.rect.right - 2
    && location.y >= location.rect.top + 2
    && location.y <= location.rect.bottom - 2);
  return [location.x, location.y];
}

async function paintedAt(page: Page, point: Point2): Promise<boolean> {
  return page.evaluate(([x, y]) => {
    const studio = (window as any).__bwStudio;
    const visual = studio.sketchVisualState();
    const canvas = document.querySelector('#bw-sketch-canvas') as HTMLCanvasElement | null;
    if (!canvas) return false;
    const context = canvas.getContext('2d');
    if (!context) return false;
    const rect = canvas.getBoundingClientRect();
    const localX = rect.width / 2 + (x - visual.view.cx) * visual.view.pxPerMm;
    const localY = rect.height / 2 - (y - visual.view.cy) * visual.view.pxPerMm;
    const pixelX = localX * canvas.width / rect.width;
    const pixelY = localY * canvas.height / rect.height;
    const expected = visual.colors.underDefined.match(/[a-f\d]{2}/gi)
      .map((component: string) => Number.parseInt(component, 16));
    const radius = 4;
    const left = Math.max(0, Math.round(pixelX) - radius);
    const top = Math.max(0, Math.round(pixelY) - radius);
    const width = Math.min(canvas.width - left, radius * 2 + 1);
    const height = Math.min(canvas.height - top, radius * 2 + 1);
    if (width < 1 || height < 1) return false;
    const pixels = context.getImageData(left, top, width, height).data;
    for (let index = 0; index < pixels.length; index += 4) {
      if (Math.abs(pixels[index]! - expected[0]!) <= 4
        && Math.abs(pixels[index + 1]! - expected[1]!) <= 4
        && Math.abs(pixels[index + 2]! - expected[2]!) <= 4
        && pixels[index + 3]! > 200) return true;
    }
    return false;
  }, point);
}

function sampleTargets(start: Point2, target: Point2, count = 20): Point2[] {
  check('performance drag path requires at least 20 preview targets', count >= 20);
  const awayX = target[0] >= start[0] ? -1 : 1;
  const awayY = target[1] >= start[1] ? -1 : 1;
  const points: Point2[] = [];
  // Exercise twenty separate integer cursor positions. The first nineteen
  // move away from the final request, keeping both coordinates distinct even
  // when an authored constraint projects one coordinate away; the twentieth
  // is the exact requested target. This makes p95 a real percentile while the
  // independent max bound still owns one cold or timeout-fallback frame.
  for (let index = 1; index < count; index++) {
    points.push([
      Math.round(start[0] + awayX * index),
      Math.round(start[1] + awayY * index),
    ]);
  }
  points.push([target[0], target[1]]);
  check('drag path did not contain twenty distinct integer preview targets',
    points.length >= 20 && new Set(points.map((point) => JSON.stringify(point))).size === points.length);
  check('drag path did not end at the requested final target', pointDistance(points.at(-1)!, target) === 0);
  return points;
}

async function installPointerEventProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__partmodeSketchPointerDebug = [];
    if ((window as any).__partmodeSketchPointerDebugInstalled) return;
    (window as any).__partmodeSketchPointerDebugInstalled = true;
    const canvas = document.querySelector('#bw-sketch-canvas');
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      for (const phase of ['capture', 'bubble']) {
        canvas?.addEventListener(type, (event: Event) => {
          const pointer = event as PointerEvent;
          (window as any).__partmodeSketchPointerDebug.push({
            type, phase, pointerId: pointer.pointerId, pointerType: pointer.pointerType,
            clientX: pointer.clientX, clientY: pointer.clientY, buttons: pointer.buttons,
            isTrusted: pointer.isTrusted,
          });
        }, { capture: phase === 'capture', once: false });
      }
    }
  });
}

async function runMouseDrag(
  page: Page,
  handleId: string,
  start: Point2,
  target: Point2,
  achievedFor: (requested: Point2) => Point2 = (requested) => requested,
  forceTimeoutFallback = false,
): Promise<DragEvidence> {
  await installPointerEventProbe(page);
  const startClient = await clientPoint(page, start);
  await page.mouse.move(startClient[0], startClient[1]);
  await page.mouse.down({ button: 'left' });
  await page.waitForFunction(() => (window as any).__bwStudio?.sketchDragState?.().active === true, {
    polling: 20, timeout: 30_000,
  });
  if (forceTimeoutFallback) await suspendNextAnimationFrame(page);

  let paintedSamples = 0;
  let accepted = 0;
  for (const waypoint of sampleTargets(start, target)) {
    const expectedAchieved = achievedFor(waypoint);
    const location = await clientPoint(page, waypoint);
    await page.mouse.move(location[0], location[1]);
    accepted++;
    try {
      await page.waitForFunction((minimum) => {
        const telemetry = (window as any).__bwStudio?.sketchDragState?.();
        return telemetry?.active === true
          && (telemetry.acceptedSamples >= minimum || telemetry.rejectedSamples > 0);
      }, { polling: 20, timeout: 5_000 }, accepted);
    } catch (error) {
      const debug = await page.evaluate(() => ({
        telemetry: (window as any).__bwStudio?.sketchDragState?.(),
        pointerEvents: (window as any).__partmodeSketchPointerDebug,
      }));
      throw new Error(`drag preview did not run for ${JSON.stringify(waypoint)}: ${JSON.stringify(debug)}`, { cause: error });
    }
    const acceptedState = await page.evaluate((expectedId) => {
      const studio = (window as any).__bwStudio;
      const draft = studio.sketchDraftForTest();
      return {
        point: draft.sketch.constrained.entities.find((entity: any) => entity.id === expectedId),
        telemetry: studio.sketchDragState(),
      };
    }, handleId);
    check(`drag preview rejected target ${JSON.stringify(waypoint)}: ${JSON.stringify(acceptedState.telemetry)}`,
      acceptedState.telemetry.rejectedSamples === 0);
    check(`accepted drag sample ${accepted} missed ${JSON.stringify(expectedAchieved)}: ${JSON.stringify(acceptedState)}`,
      acceptedState.point?.kind === 'point'
      && pointDistance(acceptedState.point.at, expectedAchieved) <= TARGET_TOLERANCE);
    const painted = await paintedAt(page, expectedAchieved);
    check(`accepted drag sample ${accepted} was not painted on the canvas`, painted);
    paintedSamples += Number(painted);
    if (forceTimeoutFallback && accepted === 1) await restoreAnimationFrames(page);
  }

  const finalClient = await clientPoint(page, target);
  await page.mouse.up({ button: 'left' });
  await page.waitForFunction((expected) => {
    const telemetry = (window as any).__bwStudio?.sketchDragState?.();
    return telemetry?.active === false
      && telemetry.status === 'settled'
      && telemetry.settled === true
      && JSON.stringify(telemetry.lastTarget) === JSON.stringify(expected);
  }, { polling: 20, timeout: 60_000 }, target);
  // Puppeteer's release occurs at its current mouse position. Keep an explicit
  // inversion check so a future canvas-layout drift cannot masquerade as the
  // requested sketch target.
  check('final client coordinate no longer maps inside the sketch canvas', Number.isFinite(finalClient[0] + finalClient[1]));
  const result = await page.evaluate(() => ({
    telemetry: (window as any).__bwStudio.sketchDragState(),
    pointerEvents: (window as any).__partmodeSketchPointerDebug,
  }));
  check('fewer than twenty accepted previews were visibly painted', paintedSamples >= 20);
  check('pointer telemetry did not record every accepted real move',
    result.telemetry.acceptedSamples === accepted
    && result.telemetry.receivedMoves >= accepted
    && result.telemetry.scheduledFrames >= accepted
    && result.telemetry.completedFrames >= accepted);
  check('pointer flush telemetry is internally inconsistent',
    result.telemetry.rafFlushes + result.telemetry.timeoutFlushes === result.telemetry.completedFrames);
  const bubbleEvents = result.pointerEvents.filter((event: AnyRecord) => event.phase === 'bubble');
  check('real pointer stream did not include down, move, and up events',
    bubbleEvents.some((event: AnyRecord) => event.type === 'pointerdown' && event.buttons === 1)
    && bubbleEvents.filter((event: AnyRecord) => event.type === 'pointermove' && event.buttons === 1).length >= 20
    && bubbleEvents.some((event: AnyRecord) => event.type === 'pointerup'));
  check('mouse drag was not driven by trusted browser pointer events',
    bubbleEvents.length > 0
    && bubbleEvents.every((event: AnyRecord) => event.isTrusted === true && event.pointerType === 'mouse'));
  return { telemetry: result.telemetry, paintedSamples, pointerEvents: bubbleEvents };
}

async function suspendNextAnimationFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as any;
    if (scope.__partmodeSketchDragRafSuspension) {
      throw new Error('animation frames are already suspended');
    }
    scope.__partmodeSketchDragRafSuspension = {
      requestAnimationFrame: window.requestAnimationFrame,
      cancelAnimationFrame: window.cancelAnimationFrame,
      nextId: 1,
    };
    window.requestAnimationFrame = () => {
      const saved = scope.__partmodeSketchDragRafSuspension;
      window.requestAnimationFrame = saved.requestAnimationFrame;
      return saved.nextId++;
    };
  });
}

async function restoreAnimationFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as any;
    const saved = scope.__partmodeSketchDragRafSuspension;
    if (!saved) return;
    window.requestAnimationFrame = saved.requestAnimationFrame;
    window.cancelAnimationFrame = saved.cancelAnimationFrame;
    delete scope.__partmodeSketchDragRafSuspension;
  });
}

async function beginMousePreview(
  page: Page,
  handleId: string,
  start: Point2,
  target: Point2,
): Promise<void> {
  const startClient = await clientPoint(page, start);
  const targetClient = await clientPoint(page, target);
  await page.mouse.move(startClient[0], startClient[1]);
  await page.mouse.down({ button: 'left' });
  await page.waitForFunction(() => (window as any).__bwStudio?.sketchDragState?.().active === true, {
    polling: 20, timeout: 30_000,
  });
  await page.mouse.move(targetClient[0], targetClient[1]);
  await page.waitForFunction((expectedId, expectedPoint) => {
    const studio = (window as any).__bwStudio;
    const telemetry = studio?.sketchDragState?.();
    const point = studio?.sketchDraftForTest?.()?.sketch?.constrained?.entities
      ?.find((entity: any) => entity.id === expectedId);
    return telemetry?.active === true
      && telemetry.acceptedSamples >= 1
      && Math.hypot(point?.at?.[0] - expectedPoint[0], point?.at?.[1] - expectedPoint[1]) <= 1e-7;
  }, { polling: 20, timeout: 30_000 }, handleId, target);
  check('rollback preview was not painted before cancellation', await paintedAt(page, target));
}

async function assertEscapeRollback(page: Page, sketch: AnyRecord, handleId: string, start: Point2, target: Point2): Promise<AnyRecord> {
  await openSketch(page, sketch);
  const sourceBytes = JSON.stringify(sketch);
  await beginMousePreview(page, handleId, start, target);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const state = (window as any).__bwStudio?.sketchDragState?.();
    return state?.active === false && state.status === 'cancelled' && state.sourceRestored === true;
  }, { polling: 20, timeout: 30_000 });
  await page.mouse.up({ button: 'left' });
  const result = await page.evaluate(() => ({
    draft: (window as any).__bwStudio.sketchDraftForTest().sketch.constrained,
    telemetry: (window as any).__bwStudio.sketchDragState(),
  }));
  assert.equal(JSON.stringify(result.draft), sourceBytes, 'Escape did not restore exact authored sketch bytes');
  return result.telemetry;
}

async function assertPointerCancelRollback(
  page: Page,
  client: CDPSession,
  sketch: AnyRecord,
  handleId: string,
  start: Point2,
  target: Point2,
): Promise<AnyRecord> {
  await openSketch(page, sketch);
  await installPointerEventProbe(page);
  const sourceBytes = JSON.stringify(sketch);
  const startClient = await clientPoint(page, start);
  const targetClient = await clientPoint(page, target);
  const touchTarget = await page.evaluate(([clientX, clientY]) => {
    const element = document.elementFromPoint(clientX, clientY);
    return element ? { id: element.id, tagName: element.tagName } : null;
  }, startClient);
  check(`trusted touch start is obscured: ${JSON.stringify(touchTarget)}`,
    touchTarget?.id === 'bw-sketch-canvas' && touchTarget.tagName === 'CANVAS');
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: startClient[0], y: startClient[1], id: 71, radiusX: 1, radiusY: 1, force: 1 }],
  });
  try {
    await page.waitForFunction(() => (window as any).__bwStudio?.sketchDragState?.().active === true, {
      polling: 20, timeout: 30_000,
    });
  } catch (error) {
    const debug = await page.evaluate(([clientX, clientY]) => {
      const element = document.elementFromPoint(clientX, clientY);
      return {
        element: element ? { id: element.id, className: element.className, tagName: element.tagName } : null,
        pointerEvents: (window as any).__partmodeSketchPointerDebug,
        telemetry: (window as any).__bwStudio?.sketchDragState?.(),
      };
    }, startClient);
    throw new Error(`trusted touchStart did not begin sketch drag: ${JSON.stringify(debug)}`, { cause: error });
  }
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: targetClient[0], y: targetClient[1], id: 71, radiusX: 1, radiusY: 1, force: 1 }],
  });
  await page.waitForFunction((expectedId, expectedPoint) => {
    const studio = (window as any).__bwStudio;
    const telemetry = studio?.sketchDragState?.();
    const point = studio?.sketchDraftForTest?.()?.sketch?.constrained?.entities
      ?.find((entity: any) => entity.id === expectedId);
    return telemetry?.active === true
      && telemetry.acceptedSamples >= 1
      && Math.hypot(point?.at?.[0] - expectedPoint[0], point?.at?.[1] - expectedPoint[1]) <= 1e-7;
  }, { polling: 20, timeout: 30_000 }, handleId, target);
  check('pointercancel preview was not painted before cancellation', await paintedAt(page, target));
  await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await page.waitForFunction(() => {
    const state = (window as any).__bwStudio?.sketchDragState?.();
    return state?.active === false && state.status === 'cancelled' && state.sourceRestored === true;
  }, { polling: 20, timeout: 30_000 });
  const result = await page.evaluate(() => ({
    draft: (window as any).__bwStudio.sketchDraftForTest().sketch.constrained,
    telemetry: (window as any).__bwStudio.sketchDragState(),
    pointerEvents: (window as any).__partmodeSketchPointerDebug,
  }));
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
  assert.equal(JSON.stringify(result.draft), sourceBytes, 'pointercancel did not restore exact authored sketch bytes');
  const bubbleEvents = result.pointerEvents.filter((event: AnyRecord) => event.phase === 'bubble');
  const touchStart = bubbleEvents.find((event: AnyRecord) => event.type === 'pointerdown');
  const touchMove = bubbleEvents.find((event: AnyRecord) => event.type === 'pointermove');
  const touchCancel = bubbleEvents.find((event: AnyRecord) => event.type === 'pointercancel');
  check('trusted touch stream did not include pointerdown, pointermove, and pointercancel',
    touchStart && touchMove && touchCancel);
  check('pointercancel rollback was not driven by trusted touch input',
    [touchStart, touchMove, touchCancel].every((event) => event.isTrusted === true && event.pointerType === 'touch'));
  check('trusted touch stream changed pointer identity before cancellation',
    touchStart.pointerId === touchMove.pointerId && touchMove.pointerId === touchCancel.pointerId);
  return {
    ...result.telemetry,
    trustedPointerStream: {
      pointerId: touchStart.pointerId,
      pointerType: 'touch',
      isTrusted: true,
      events: ['pointerdown', 'pointermove', 'pointercancel'],
    },
  };
}

async function assertFixedRefusal(page: Page, fixture: ScaleFixture): Promise<AnyRecord> {
  await openSketch(page, fixture.sketch);
  const sourceBytes = JSON.stringify(fixture.sketch);
  const fixed = fixture.sketch.entities.find((entity: AnyRecord) => entity.id === fixture.fixedHandleId)!;
  const start = await clientPoint(page, fixed.at);
  const finish = await clientPoint(page, [fixed.at[0] + 4, fixed.at[1] - 4]);
  await page.mouse.move(start[0], start[1]);
  await page.mouse.down({ button: 'left' });
  await page.waitForFunction(() => {
    const state = (window as any).__bwStudio?.sketchDragState?.();
    return state?.active === false && state.status === 'rejected' && state.error?.code === 'SKETCH_DRAG_HANDLE_FIXED';
  }, { polling: 20, timeout: 30_000 });
  await page.mouse.move(finish[0], finish[1]);
  await page.mouse.up({ button: 'left' });
  const result = await page.evaluate(() => ({
    draft: (window as any).__bwStudio.sketchDraftForTest().sketch.constrained,
    telemetry: (window as any).__bwStudio.sketchDragState(),
  }));
  assert.equal(JSON.stringify(result.draft), sourceBytes, 'fixed-handle refusal mutated the sketch draft');
  assert.equal(result.telemetry.acceptedSamples, 0, 'fixed handle produced an accepted drag sample');
  return result.telemetry;
}

async function heapUsed(client: CDPSession): Promise<number> {
  await client.send('HeapProfiler.collectGarbage');
  const usage = await client.send('Runtime.getHeapUsage');
  return usage.usedSize;
}

function latencySummary(telemetry: AnyRecord): {
  preview: { samples: number; p95Ms: number; maxMs: number };
  settle: { latencyMs: number; limitMs: number };
} {
  const samples = [...(telemetry.latenciesMs || [])].map(Number).sort((left, right) => left - right);
  check('settled drag has fewer than twenty preview-only latency samples', samples.length >= 20);
  const p95 = samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)]!;
  const max = samples.at(-1)!;
  const settle = Number(telemetry.settleLatencyMs);
  const diagnostics = JSON.stringify({ samples, pointerPipeline: pointerPipeline(telemetry) });
  check(`preview p95 ${p95} ms exceeds ${MAX_SAMPLE_P95_MS} ms: ${diagnostics}`, p95 <= MAX_SAMPLE_P95_MS);
  check(`preview maximum ${max} ms exceeds ${MAX_SAMPLE_MS} ms: ${diagnostics}`, max <= MAX_SAMPLE_MS);
  check('settle latency was mixed into or omitted from the preview telemetry',
    Number.isFinite(settle) && settle >= 0
    && samples.length === telemetry.acceptedSamples
    && telemetry.settled === true);
  check(`exact settlement ${settle} ms exceeds ${MAX_SETTLE_MS} ms`, settle <= MAX_SETTLE_MS);
  return {
    preview: { samples: samples.length, p95Ms: p95, maxMs: max },
    settle: { latencyMs: settle, limitMs: MAX_SETTLE_MS },
  };
}

function pointerPipeline(telemetry: AnyRecord): AnyRecord {
  return {
    receivedMoves: telemetry.receivedMoves,
    scheduledFrames: telemetry.scheduledFrames,
    completedFrames: telemetry.completedFrames,
    rafFlushes: telemetry.rafFlushes,
    timeoutFlushes: telemetry.timeoutFlushes,
    coalescedMoves: telemetry.coalescedMoves,
  };
}

function entitiesById(sketch: AnyRecord): Map<string, AnyRecord> {
  return new Map(sketch.entities.map((entity: AnyRecord) => [entity.id, entity]));
}

function assertScaleSettlement(
  fixture: ScaleFixture,
  draft: AnyRecord,
  telemetry: AnyRecord,
  solveSketch: (sketch: AnyRecord) => AnyRecord,
): AnyRecord {
  assert.deepEqual(draft.constraints, fixture.sketch.constraints, `${fixture.totalEntities}-entity drag changed constraint bytes or order`);
  check(`${fixture.totalEntities}-entity settled draft changed entity count`, draft.entities.length === fixture.totalEntities);
  const sourceById = entitiesById(fixture.sketch);
  const nextById = entitiesById(draft);
  const start = sourceById.get(fixture.handleId)!.at as Point2;
  const delta: Point2 = [fixture.target[0] - start[0], fixture.target[1] - start[1]];

  for (const id of fixture.componentPointIds) {
    const source = sourceById.get(id)!;
    const next = nextById.get(id)!;
    const expected: Point2 = [source.at[0] + delta[0], source.at[1] + delta[1]];
    check(`${fixture.totalEntities}-entity drag did not propagate exact translation to ${id}`,
      pointDistance(next.at, expected) <= TARGET_TOLERANCE);
  }
  for (const id of fixture.componentLineIds) {
    const line = nextById.get(id)!;
    check(`${fixture.totalEntities}-entity connected line ${id} lost a translated endpoint`,
      fixture.componentPointIds.includes(line.a) && fixture.componentPointIds.includes(line.b));
  }
  for (const id of fixture.fixedEntityIds) {
    assert.deepEqual(nextById.get(id), sourceById.get(id), `${fixture.totalEntities}-entity drag changed unrelated fixed entity ${id}`);
  }

  const solved = solveSketch(draft);
  check(`${fixture.totalEntities}-entity settled draft does not solve`, solved.status === 'ok');
  const solvedHandle = solved.entities.find((entity: AnyRecord) => entity.id === fixture.handleId);
  check(`${fixture.totalEntities}-entity solved handle missed the exact cursor target`,
    solvedHandle?.kind === 'point' && pointDistance(solvedHandle.at, fixture.target) <= TARGET_TOLERANCE);
  assert.deepEqual(telemetry.lastTarget, fixture.target, `${fixture.totalEntities}-entity UI did not record the exact cursor target`);
  assert.deepEqual(
    [...telemetry.lastAffectedEntityIds].sort(),
    [...fixture.componentEntityIds].sort(),
    `${fixture.totalEntities}-entity drag did not report the exact 127-entity connected component`,
  );
  check(`${fixture.totalEntities}-entity component count is not 127`, telemetry.componentCounts?.entities === 127);
  check(`${fixture.totalEntities}-entity source count telemetry is stale`, telemetry.componentCounts?.sourceEntities === fixture.totalEntities);
  check(`${fixture.totalEntities}-entity drag rejected an otherwise valid sample`, telemetry.rejectedSamples === 0);
  return {
    status: solved.status,
    dof: solved.dof,
    target: solvedHandle.at,
    translatedPoints: fixture.componentPointIds.length,
    connectedLines: fixture.componentLineIds.length,
    affectedEntities: telemetry.lastAffectedEntityIds.length,
    stableFixedEntities: fixture.fixedEntityIds.length,
    constraintBytesStable: true,
  };
}

let server: RunningPartModeServer | undefined;
let browser: Browser | undefined;

try {
  const solver = await import(pathToFileURL(resolve(repositoryRoot, 'src/static/studio-sketch-solver.js')).href) as AnyRecord;
  const dragModule = await import(pathToFileURL(resolve(repositoryRoot, 'src/static/studio-sketch-drag.js')).href) as AnyRecord;
  const scaleFixtures = [
    buildScaleFixture(500, runtimeSeed ^ 0x500),
    buildScaleFixture(1000, runtimeSeed ^ 0x1000),
  ];
  for (const fixture of scaleFixtures) {
    const baseline = solver.solveSketch(fixture.sketch);
    check(`${fixture.totalEntities}-entity runtime-seeded source does not solve`, baseline.status === 'ok');
    check(`${fixture.totalEntities}-entity movable chain does not leave exactly two translation DOF`, baseline.dof === 2);
  }

  const rectangleSession = dragModule.beginStudioSketchDrag(rectangleSketch, {
    kind: 'point', entityId: 'rect-p0',
  });
  const expectedRectangle = dragModule.settleStudioSketchDrag(rectangleSession, rectangleTarget);
  const expectedRectangleSolve = solver.solveSketch(expectedRectangle.sketch);
  const expectedRectangleLoops = solver.constraintSketchToLoops(expectedRectangle.sketch, { presolved: expectedRectangleSolve });
  check('module rectangle settlement is not one exact closed loop',
    expectedRectangleSolve.status === 'ok' && expectedRectangleLoops.status === 'ok' && expectedRectangleLoops.loops.length === 1);
  const projectedSession = dragModule.beginStudioSketchDrag(projectedSketch, {
    kind: 'point', entityId: 'project-handle',
  });
  const expectedProjected = dragModule.settleStudioSketchDrag(projectedSession, projectedTarget);
  check('module did not project the off-manifold cursor onto the x-fixed/y-free point',
    expectedProjected.projection?.applied === true
    && expectedProjected.projection.method === 'y-axis-driver'
    && pointDistance(expectedProjected.requestedTarget, projectedTarget) <= TARGET_TOLERANCE
    && pointDistance(expectedProjected.achievedTarget, projectedAchievedTarget) <= TARGET_TOLERANCE);

  server = await startPartModeServer({
    distDir: resolve(repositoryRoot, 'dist'),
    host: '127.0.0.1',
    port: 0,
    stateDir: resolve(temporaryDirectory, 'state'),
  });
  // Chrome 148's new-headless path can indefinitely withhold the
  // acknowledgement for Input.dispatchTouchEvent even on an empty page. The
  // bundled Headless Shell uses the same Chromium build and CDP protocol but
  // delivers the trusted touch stream reliably, so use it for this input gate.
  browser = await puppeteer.launch({
    headless: 'shell',
    protocolTimeout: 60_000,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-precise-memory-info',
      '--enable-unsafe-swiftshader',
      '--js-flags=--expose-gc',
      '--touch-events=enabled',
      '--use-angle=swiftshader-webgl',
      '--use-gl=angle',
    ],
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 });
  // Keep first-run Blank sketch visible. Suppress only the timed tour overlay,
  // which would otherwise cover the real controls exercised below.
  await page.evaluateOnNewDocument(() => localStorage.setItem('bw-studio-tour-v1', '1'));

  const failures: string[] = [];
  collectPageFailures(page, failures);

  const response = await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert.equal(response?.status(), 200, 'sketch drag browser route did not return HTTP 200');
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 50, timeout: 120_000 });
  if (await page.$eval('#pm-cookie-banner', (element) => !(element as HTMLElement).hidden)) {
    await clickVisible(page, '#pm-cookie-essential');
    await page.waitForFunction(() => (document.getElementById('pm-cookie-banner') as HTMLElement | null)?.hidden === true,
      { polling: 100, timeout: 10_000 });
  }
  const client = await page.createCDPSession();
  const initialHeap = await heapUsed(client);

  // Keep the touch stream isolated on a fresh, pre-emulated page and retain
  // trusted touchStart/move/cancel events. The main page below still begins
  // through visible Blank sketch and Line controls before fixture injection.
  const pointerCancelTelemetry = await (async () => {
    const pointerCancelContext = await browser.createBrowserContext();
    const pointerCancelPage = await pointerCancelContext.newPage();
    try {
      await pointerCancelPage.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 });
      await pointerCancelPage.evaluateOnNewDocument(() => {
        localStorage.setItem('bw-studio-tour-v1', '1');
        localStorage.setItem('bw-studio-welcome-v1', '1');
      });
      collectPageFailures(pointerCancelPage, failures);
      const pointerCancelClient = await pointerCancelPage.createCDPSession();
      const pointerResponse = await pointerCancelPage.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      assert.equal(pointerResponse?.status(), 200, 'pointercancel browser route did not return HTTP 200');
      await pointerCancelPage.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 50, timeout: 120_000 });
      // Headless Chrome can leave a second page backgrounded even when it was
      // created most recently. Touch dispatch requires the target page to be
      // foreground-active; make that precondition explicit before the trusted
      // CDP touch stream begins.
      await pointerCancelPage.bringToFront();
      return await assertPointerCancelRollback(
        pointerCancelPage, pointerCancelClient, rectangleSketch, 'rect-p0', [-12, -6], [-8, -2],
      );
    } finally {
      await pointerCancelContext.close();
    }
  })();
  await page.bringToFront();
  await page.waitForFunction(() => document.visibilityState === 'visible' && document.hasFocus(), {
    polling: 20,
    timeout: 30_000,
  });

  // Start the main page through the normal visible product path before any
  // fixture is injected into that page:
  // Blank sketch -> Line ribbon -> five canvas clicks closing a four-line loop.
  const normalUserAuthored = await authorNormalUserLineProfile(page);
  const normalUserSource = normalUserAuthored.sketch;
  const normalUserSourceSolve = solver.solveSketch(normalUserSource);
  const normalUserSourceLoops = solver.constraintSketchToLoops(normalUserSource, { presolved: normalUserSourceSolve });
  check('normal-user Line profile is not one solved constraint-native closed loop',
    normalUserSourceSolve.status === 'ok'
    && normalUserSourceLoops.status === 'ok'
    && normalUserSourceLoops.loops.length === 1);
  const normalUserHandle = normalUserSource.entities.find((entity: AnyRecord) => entity.kind === 'point' && !entity.fixed);
  check('normal-user Line profile has no movable non-fixed endpoint', normalUserHandle?.kind === 'point');
  const normalUserStart = normalUserHandle.at as Point2;
  const normalUserTarget: Point2 = [normalUserStart[0] + 5, normalUserStart[1] + 4];
  const normalUserSession = dragModule.beginStudioSketchDrag(normalUserSource, {
    kind: 'point', entityId: normalUserHandle.id,
  });
  const expectedNormalUser = dragModule.settleStudioSketchDrag(normalUserSession, normalUserTarget);
  check('normal-user endpoint request did not retain the cursor coordinate along its free axis',
    expectedNormalUser.projection?.applied === true
    && expectedNormalUser.projection.method === 'x-axis-driver'
    && pointDistance(expectedNormalUser.achievedTarget, [normalUserTarget[0], normalUserStart[1]]) <= TARGET_TOLERANCE
    && expectedNormalUser.affectedPointIds.length >= 2);
  check('normal-user endpoint request did not propagate through another constrained point',
    expectedNormalUser.affectedPointIds.length >= 2
    && expectedNormalUser.affectedEntityIds.some((id: string) =>
      normalUserSource.entities.find((entity: AnyRecord) => entity.id === id)?.kind === 'line'));
  const normalUserDrag = await runMouseDrag(
    page,
    normalUserHandle.id,
    normalUserStart,
    normalUserTarget,
    (requested) => dragModule.previewStudioSketchDrag(normalUserSession, requested).achievedTarget,
  );
  const normalUserDraft = await page.evaluate(() => (window as any).__bwStudio.sketchDraftForTest().sketch.constrained);
  assert.deepEqual(normalUserDraft, expectedNormalUser.sketch,
    'normal-user visible endpoint drag does not match module settlement');
  assert.deepEqual(normalUserDrag.telemetry.lastTarget, normalUserTarget,
    'normal-user drag did not retain its exact requested cursor target');
  check('normal-user drag did not retain its constraint-manifold achieved target',
    normalUserDrag.telemetry.targetProjected === true
    && pointDistance(normalUserDrag.telemetry.lastAchievedTarget, expectedNormalUser.achievedTarget) <= TARGET_TOLERANCE);
  assert.deepEqual(normalUserDraft.constraints, normalUserSource.constraints,
    'normal-user endpoint drag changed authored constraint bytes');
  assert.deepEqual(
    [...normalUserDrag.telemetry.lastAffectedEntityIds].sort(),
    [...expectedNormalUser.affectedEntityIds].sort(),
    'normal-user endpoint drag reported stale propagation evidence',
  );
  const normalUserSettledSolve = solver.solveSketch(normalUserDraft);
  const normalUserSettledLoops = solver.constraintSketchToLoops(normalUserDraft, { presolved: normalUserSettledSolve });
  check('normal-user settled drag lost its solved closed profile',
    normalUserSettledSolve.status === 'ok'
    && normalUserSettledLoops.status === 'ok'
    && normalUserSettledLoops.loops.length === 1);
  const normalUserPerformance = latencySummary(normalUserDrag.telemetry);

  await openSketch(page, rectangleSketch);
  // Suppress the first drag-owned animation frame so the bounded timer must
  // complete that same real-pointer work item. Later frames stay ordinary.
  const rectangleDrag = await runMouseDrag(
    page, 'rect-p0', [-12, -6], rectangleTarget, (requested) => requested, true,
  );
  check('forced animation-frame suspension did not exercise the bounded timer fallback',
    rectangleDrag.telemetry.timeoutFlushes > 0
    && rectangleDrag.telemetry.rafFlushes + rectangleDrag.telemetry.timeoutFlushes
      === rectangleDrag.telemetry.completedFrames);
  const rectangleDraft = await page.evaluate(() => (window as any).__bwStudio.sketchDraftForTest().sketch.constrained);
  assert.deepEqual(rectangleDraft, expectedRectangle.sketch, 'visible closed-rectangle drag does not match module settlement');
  assert.deepEqual(rectangleDraft.constraints, rectangleSketch.constraints, 'visible rectangle drag changed constraint bytes');
  const visibleRectangleSolve = solver.solveSketch(rectangleDraft);
  const visibleRectangleLoops = solver.constraintSketchToLoops(rectangleDraft, { presolved: visibleRectangleSolve });
  check('visible rectangle no longer solves as one closed loop',
    visibleRectangleSolve.status === 'ok' && visibleRectangleLoops.status === 'ok' && visibleRectangleLoops.loops.length === 1);
  const rectanglePerformance = latencySummary(rectangleDrag.telemetry);

  await openSketch(page, projectedSketch);
  const projectedDrag = await runMouseDrag(
    page,
    'project-handle',
    [10, -4],
    projectedTarget,
    (requested) => [10, requested[1]],
  );
  const projectedDraft = await page.evaluate(() => (window as any).__bwStudio.sketchDraftForTest().sketch.constrained);
  assert.deepEqual(projectedDraft, expectedProjected.sketch, 'visible off-manifold drag does not match module projection settlement');
  assert.deepEqual(projectedDraft.constraints, projectedSketch.constraints, 'off-manifold drag changed authored constraint bytes');
  const projectedHandle = projectedDraft.entities.find((entity: AnyRecord) => entity.id === 'project-handle');
  check('visible off-manifold drag did not achieve [fixedX, cursorY]',
    projectedHandle?.kind === 'point'
    && pointDistance(projectedHandle.at, projectedAchievedTarget) <= TARGET_TOLERANCE);
  assert.deepEqual(projectedDrag.telemetry.lastTarget, projectedTarget, 'UI did not record the requested off-manifold cursor target');
  check('UI did not record the projected achieved point',
    projectedDrag.telemetry.targetProjected === true
    && pointDistance(projectedDrag.telemetry.lastAchievedTarget, projectedAchievedTarget) <= TARGET_TOLERANCE);
  const projectedPerformance = latencySummary(projectedDrag.telemetry);

  const escapeTelemetry = await assertEscapeRollback(page, rectangleSketch, 'rect-p0', [-12, -6], [-7, -1]);
  const fixedTelemetry = await assertFixedRefusal(page, scaleFixtures[0]!);

  const scaleEvidence: AnyRecord[] = [];
  for (const fixture of scaleFixtures) {
    await openSketch(page, fixture.sketch);
    const heapBefore = await heapUsed(client);
    const sourceHandle = fixture.sketch.entities.find((entity: AnyRecord) => entity.id === fixture.handleId)!.at as Point2;
    const drag = await runMouseDrag(page, fixture.handleId, sourceHandle, fixture.target);
    const draft = await page.evaluate(() => (window as any).__bwStudio.sketchDraftForTest().sketch.constrained);
    const solvedEvidence = assertScaleSettlement(fixture, draft, drag.telemetry, solver.solveSketch);
    const performance = latencySummary(drag.telemetry);
    const heapAfter = await heapUsed(client);
    const heapGrowth = Math.max(0, heapAfter - heapBefore);
    check(`${fixture.totalEntities}-entity drag retained ${heapGrowth} heap bytes`, heapGrowth <= MAX_DRAG_HEAP_GROWTH);
    scaleEvidence.push({
      entityCount: fixture.totalEntities,
      componentEntities: fixture.componentEntityIds.length,
      fixedGeometryEntities: fixture.fixedEntityIds.length,
      paintedSamples: drag.paintedSamples,
      pointerPipeline: pointerPipeline(drag.telemetry),
      ...solvedEvidence,
      performance,
      heap: { before: heapBefore, after: heapAfter, growth: heapGrowth, limit: MAX_DRAG_HEAP_GROWTH },
    });
  }

  const finalHeap = await heapUsed(client);
  const totalHeapGrowth = Math.max(0, finalHeap - initialHeap);
  check(`browser retained ${totalHeapGrowth} total heap bytes`, totalHeapGrowth <= MAX_TOTAL_HEAP_GROWTH);
  assert.deepEqual(failures, [], `sketch drag browser gate reported errors: ${failures.join(' | ')}`);

  console.log(JSON.stringify({
    seed: runtimeSeed,
    browser: await browser.version(),
    browserMode: 'headless-shell',
    softwareWebgl: true,
    realPointerInput: true,
    normalUserPath: {
      controls: ['Blank sketch', 'Line'],
      profileCanvasClicks: normalUserAuthored.clickCount,
      constraintNative: true,
      entityCount: normalUserSource.entities.length,
      constraintCount: normalUserSource.constraints.length,
      closedLoop: true,
      handleId: normalUserHandle.id,
      requestedTarget: normalUserDrag.telemetry.lastTarget,
      achievedTarget: normalUserDrag.telemetry.lastAchievedTarget,
      propagatedPoints: expectedNormalUser.affectedPointIds.length,
      affectedEntities: normalUserDrag.telemetry.lastAffectedEntityIds.length,
      authoredConstraintBytesStable: true,
      moduleSettlementMatch: true,
      paintedSamples: normalUserDrag.paintedSamples,
      pointerPipeline: pointerPipeline(normalUserDrag.telemetry),
      performance: normalUserPerformance,
    },
    rectangle: {
      closedLoop: true,
      moduleSettlementMatch: true,
      paintedSamples: rectangleDrag.paintedSamples,
      target: rectangleDrag.telemetry.lastTarget,
      pointerPipeline: pointerPipeline(rectangleDrag.telemetry),
      performance: rectanglePerformance,
    },
    projectedPoint: {
      requestedTarget: projectedDrag.telemetry.lastTarget,
      achievedTarget: projectedDrag.telemetry.lastAchievedTarget,
      authoredConstraintBytesStable: true,
      moduleSettlementMatch: true,
      paintedSamples: projectedDrag.paintedSamples,
      pointerPipeline: pointerPipeline(projectedDrag.telemetry),
      performance: projectedPerformance,
    },
    rollback: {
      escape: { status: escapeTelemetry.status, sourceRestored: escapeTelemetry.sourceRestored },
      pointercancel: {
        status: pointerCancelTelemetry.status,
        sourceRestored: pointerCancelTelemetry.sourceRestored,
        trustedPointerStream: pointerCancelTelemetry.trustedPointerStream,
      },
    },
    fixedHandle: { status: fixedTelemetry.status, code: fixedTelemetry.error.code, sourceUnchanged: true },
    scale: scaleEvidence,
    latencyLimitsMs: { previewP95: MAX_SAMPLE_P95_MS, previewMax: MAX_SAMPLE_MS, settleMax: MAX_SETTLE_MS },
    heap: { initial: initialHeap, final: finalHeap, growth: totalHeapGrowth, limit: MAX_TOTAL_HEAP_GROWTH },
    consoleNetworkPageErrors: failures.length,
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
