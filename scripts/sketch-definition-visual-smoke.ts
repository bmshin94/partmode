import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer, { type Browser } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type AnyRecord = Record<string, any>;

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Sketch definition visual smoke failed: ${name}`);
}

const mixedSketch = {
  entities: [
    { id: 'anchor', kind: 'point', at: [0, 0], fixed: true },
    { id: 'defined-end', kind: 'point', at: [10, 2] },
    { id: 'defined-line', kind: 'line', a: 'anchor', b: 'defined-end' },
    { id: 'open-a', kind: 'point', at: [20, 10] },
    { id: 'open-b', kind: 'point', at: [30, 10] },
    { id: 'open-line', kind: 'line', a: 'open-a', b: 'open-b' },
    { id: 'circle-center', kind: 'point', at: [-10, 10], fixed: true },
    { id: 'defined-circle', kind: 'circle', center: 'circle-center', r: 3 },
  ],
  constraints: [
    { id: 'defined-horizontal', kind: 'horizontal', line: 'defined-line' },
    { id: 'defined-x', kind: 'horizontalDistance', a: 'anchor', b: 'defined-end', value: 10 },
    { id: 'defined-radius', kind: 'radius', circle: 'defined-circle', value: 3 },
  ],
};

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-sketch-visual-'));
let server: RunningPartModeServer | undefined;
let browser: Browser | undefined;

try {
  const solverUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-sketch-solver.js')).href;
  const { solveSketch } = await import(solverUrl) as { solveSketch: (sketch: AnyRecord) => AnyRecord };
  const solved = solveSketch(mixedSketch);
  check('mixed sketch solves', solved.status === 'ok');
  check('mixed sketch retains four open translational parameters', solved.dof === 4);
  const states = new Map<string, AnyRecord>(solved.entityStates.map((state: AnyRecord) => [state.entityId, state]));
  check('anchored dimensioned line is fully defined', states.get('defined-line')?.fullyDefined === true);
  check('dimensioned circle is fully defined', states.get('defined-circle')?.fullyDefined === true);
  check('disconnected line is under-defined', states.get('open-line')?.underDefined === true);
  check('disconnected line exposes four movable endpoint coordinates', states.get('open-line')?.freeParameterCount === 4);

  const reordered = solveSketch({
    entities: [...mixedSketch.entities].reverse(),
    constraints: [...mixedSketch.constraints].reverse(),
  });
  check(
    'entity definition states are ordering deterministic',
    JSON.stringify(reordered.entityStates) === JSON.stringify(solved.entityStates),
  );

  // A pivot coordinate can still move when it is coupled to a free variable.
  // This guards against mistaking Gaussian-elimination pivots for fixed DOF.
  const coupled = solveSketch({
    entities: [
      { id: 'a', kind: 'point', at: [0, 0] },
      { id: 'b', kind: 'point', at: [5, 0] },
      { id: 'line', kind: 'line', a: 'a', b: 'b' },
    ],
    constraints: [{ id: 'horizontal', kind: 'horizontal', line: 'line' }],
  });
  check('coupled line solves', coupled.status === 'ok');
  check('coupled pivot coordinates remain under-defined', coupled.entityStates.find((state: AnyRecord) => state.entityId === 'line')?.underDefined === true);

  server = await startPartModeServer({
    host: '127.0.0.1',
    port: 0,
    stateDir: resolve(temporaryDirectory, 'state'),
  });
  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('bw-studio-welcome-v1', '1');
  });
  const response = await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { polling: 100, timeout: 60_000 });
  if (await page.$eval('#pm-cookie-banner', (element) => !(element as HTMLElement).hidden).catch(() => false)) {
    await page.click('#pm-cookie-essential');
    await page.waitForFunction(() => (document.getElementById('pm-cookie-banner') as HTMLElement | null)?.hidden === true,
      { polling: 100, timeout: 10_000 });
  }
  check('Studio page loads', response?.status() === 200);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { timeout: 120_000 });
  await page.evaluate((sketch) => (window as any).__bwStudio.openConstrainedSketchForTest(sketch), mixedSketch);
  await page.waitForFunction(() => {
    const visual = (window as any).__bwStudio?.sketchVisualState?.();
    return visual?.solverStatus === 'ok' && visual.geometry?.length === 8;
  });

  // The constraint panel populates asynchronously and can relayout the canvas
  // between the first paint and a one-shot sample. Poll until the rendered
  // pixels are stable; the assertions below still require the exact colors.
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    const visual = studio?.sketchVisualState?.();
    const canvas = document.querySelector('#bw-sketch-canvas') as HTMLCanvasElement | null;
    if (!visual || !canvas) return false;
    const context = canvas.getContext('2d');
    if (!context) return false;
    const sample = (point: number[], expected: number[]) => {
      const cssWidth = canvas.width / devicePixelRatio;
      const cssHeight = canvas.height / devicePixelRatio;
      const x = (((point[0] ?? 0) - visual.view.cx) * visual.view.pxPerMm + cssWidth / 2) * devicePixelRatio;
      const y = ((visual.view.cy - (point[1] ?? 0)) * visual.view.pxPerMm + cssHeight / 2) * devicePixelRatio;
      if (x < 3 || y < 3 || x > canvas.width - 4 || y > canvas.height - 4) return false;
      const pixels = context.getImageData(Math.round(x) - 3, Math.round(y) - 3, 7, 7).data;
      for (let index = 0; index < pixels.length; index += 4) {
        if (Math.abs((pixels[index] ?? 0) - (expected[0] ?? 0)) <= 3
          && Math.abs((pixels[index + 1] ?? 0) - (expected[1] ?? 0)) <= 3
          && Math.abs((pixels[index + 2] ?? 0) - (expected[2] ?? 0)) <= 3
          && (pixels[index + 3] ?? 0) > 200) return true;
      }
      return false;
    };
    const rgb = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    return sample([5, 0], rgb(visual.colors.fullyDefined)) && sample([25, 10], rgb(visual.colors.underDefined));
  }, { polling: 100, timeout: 180_000 });
  const visible = await page.evaluate(() => {
    const studio = (window as any).__bwStudio;
    const visual = studio.sketchVisualState();
    const canvas = document.querySelector('#bw-sketch-canvas') as HTMLCanvasElement | null;
    const sketchPanel = document.querySelector('#bw-sketch') as HTMLElement | null;
    const sampleColor = (point: [number, number], color: string) => {
      if (!canvas) return false;
      const context = canvas.getContext('2d');
      if (!context) return false;
      const cssWidth = canvas.width / devicePixelRatio;
      const cssHeight = canvas.height / devicePixelRatio;
      const x = ((point[0] - visual.view.cx) * visual.view.pxPerMm + cssWidth / 2) * devicePixelRatio;
      const y = (cssHeight / 2 - (point[1] - visual.view.cy) * visual.view.pxPerMm) * devicePixelRatio;
      const expected = color.match(/[a-f\d]{2}/gi)?.map((component: string) => Number.parseInt(component, 16)) || [];
      const pixels = context.getImageData(Math.round(x) - 3, Math.round(y) - 3, 7, 7).data;
      for (let index = 0; index < pixels.length; index += 4) {
        if (Math.abs(pixels[index]! - expected[0]!) <= 3
          && Math.abs(pixels[index + 1]! - expected[1]!) <= 3
          && Math.abs(pixels[index + 2]! - expected[2]!) <= 3
          && pixels[index + 3]! > 200) return true;
      }
      return false;
    };
    return {
      visual,
      panelVisible: Boolean(sketchPanel && !sketchPanel.hidden && getComputedStyle(sketchPanel).display !== 'none'),
      canvasVisible: Boolean(canvas && canvas.getBoundingClientRect().width > 0 && canvas.getBoundingClientRect().height > 0),
      neutralPixel: sampleColor([5, 0], visual.colors.fullyDefined),
      bluePixel: sampleColor([25, 10], visual.colors.underDefined),
    };
  });
  check('sketch editor is visibly open', visible.panelVisible && visible.canvasVisible);
  check('visible DOF pill reports the open state', visible.visual.pill?.hidden === false && visible.visual.pill?.text === '4 DOF remaining');
  check('visible DOF pill uses the open-state class', visible.visual.pill?.className.includes('is-open'));
  const visualById = new Map<string, AnyRecord>(visible.visual.geometry.map((entry: AnyRecord) => [entry.entityId, entry]));
  check('defined line uses the neutral geometry color', visualById.get('defined-line')?.color === visible.visual.colors.fullyDefined);
  check('open line uses the blue geometry color', visualById.get('open-line')?.color === visible.visual.colors.underDefined);
  check('defined circle uses the neutral geometry color', visualById.get('defined-circle')?.color === visible.visual.colors.fullyDefined);
  check('neutral geometry color is present in rendered canvas pixels', visible.neutralPixel);
  check('under-defined blue is present in rendered canvas pixels', visible.bluePixel);

  console.log(JSON.stringify({
    solver: { dof: solved.dof, entityStates: solved.entityStates },
    ui: {
      pill: visible.visual.pill,
      colors: visible.visual.colors,
      geometry: visible.visual.geometry.filter((entry: AnyRecord) => ['defined-line', 'open-line', 'defined-circle'].includes(entry.entityId)),
      exactCanvasPixels: { neutral: visible.neutralPixel, underDefined: visible.bluePixel },
    },
  }));
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
