import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type ElementHandle, type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';
import {
  PARTMODE_UX_NAVIGATION_CONTRACT,
  getPartModeUxNavigationPath,
  type PartModeUxNavigationStep,
} from '../src/ux-navigation-contract.js';

interface SmokeState {
  runtimeVersion: string;
  documentRevision: number;
  appliedRevision: number;
  bodies: number;
  validBodies: number;
  triangles: number;
  errors: string[];
  projectId: string;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..', '..');
const fixturePath = resolve(repositoryRoot, 'tests', 'fixtures', 'three-body.json');
const pageSource = readFileSync(resolve(repositoryRoot, 'src', 'page.html'), 'utf8');
const initialSketchTab = pageSource.match(/<button[^>]*data-workspace="sketch"[^>]*>/u)?.[0] ?? '';
if (!initialSketchTab || /\sdisabled(?:\s|=|>)/u.test(initialSketchTab) || /aria-disabled=/u.test(initialSketchTab)) {
  throw new Error(`Sketch must ship enabled with the other ribbon tabs: ${initialSketchTab || 'missing'}`);
}
const arguments_ = process.argv.slice(2);
const urlIndex = arguments_.indexOf('--url');
const shaIndex = arguments_.indexOf('--expected-sha');
const targetUrl = urlIndex >= 0 ? arguments_[urlIndex + 1] : undefined;
const expectedSha = shaIndex >= 0 ? arguments_[shaIndex + 1] : undefined;
const nightly = arguments_.includes('--nightly');

if (targetUrl && !/^https?:\/\//.test(targetUrl)) throw new Error(`invalid smoke URL: ${targetUrl}`);
if (expectedSha && !/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('expected SHA must be 40 lowercase hex characters');

let local: RunningPartModeServer | undefined;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-smoke-'));
const uploadedFixture = resolve(temporaryDirectory, 'three-body.partmode.json');
writeFileSync(uploadedFixture, readFileSync(fixturePath));

function failForBrowserErrors(
  pageErrors: string[],
  consoleErrors: string[],
  networkErrors: string[],
): void {
  const failures = [
    ...pageErrors.map((value) => `page: ${value}`),
    ...consoleErrors.map((value) => `console: ${value}`),
    ...networkErrors.map((value) => `network: ${value}`),
  ];
  if (failures.length > 0) throw new Error(`browser errors\n${failures.join('\n')}`);
}

async function clickVisibleControl(page: Page, selector: string): Promise<void> {
  const control = await page.$(selector);
  if (!control) throw new Error(`visible control is missing: ${selector}`);
  try {
    const state = await control.evaluate((element) => ({
      connected: element.isConnected,
      disabled: element instanceof HTMLButtonElement && element.disabled,
      ariaDisabled: element.getAttribute('aria-disabled'),
    }));
    if (!state.connected || state.disabled || state.ariaDisabled === 'true') {
      throw new Error(`visible control is not enabled: ${selector}`);
    }
    await control.evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    });
    const bounds = await control.boundingBox();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      throw new Error(`visible control has no hit-test bounds: ${selector}`);
    }
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const ownsHitTarget = await control.evaluate((element, point) => {
      const target = document.elementFromPoint(point.x, point.y);
      return Boolean(target && (target === element || element.contains(target)));
    }, center);
    if (!ownsHitTarget) {
      throw new Error(`visible control does not own its center hit target: ${selector}`);
    }
    await page.mouse.click(center.x, center.y);
  } finally {
    await control.dispose();
  }
}

async function assertVisibleNavigationStep(
  page: Page,
  pathId: string,
  step: PartModeUxNavigationStep,
): Promise<void> {
  const observation = await page.evaluate(({ selector, expectedLabel }) => {
    const matches = [...document.querySelectorAll<HTMLElement>(selector)];
    const element = matches[0] ?? null;
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const visible = (candidate: HTMLElement | null) => {
      if (!candidate || candidate.hidden) return false;
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };
    const primaryLabel = (candidate: HTMLElement | null) => {
      if (!candidate) return '';
      const explicit = candidate.querySelector<HTMLElement>(':scope > .wsr-label, :scope > b');
      if (explicit) return normalize(explicit.textContent);
      if (candidate.getAttribute('aria-label')) return normalize(candidate.getAttribute('aria-label'));
      const copy = candidate.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('[aria-hidden="true"], .ws-visually-hidden, small').forEach((child) => child.remove());
      return normalize(copy.textContent);
    };

    let surface = 'unknown';
    let surfaceLabel = '';
    let surfaceVisible = false;
    let surfaceConsistent = false;
    if (element?.closest('#bw-welcome')) {
      const welcome = document.getElementById('bw-welcome');
      surface = 'first-visit welcome';
      surfaceLabel = normalize(document.getElementById('bw-welcome-title')?.textContent);
      surfaceVisible = visible(welcome);
      surfaceConsistent = surfaceLabel === 'Choose a starting point';
    } else if (element?.closest('#bw-templates')) {
      const dialog = document.getElementById('bw-templates') as HTMLDialogElement | null;
      surface = 'template library dialog';
      surfaceLabel = normalize(document.getElementById('bw-templates-title')?.textContent);
      surfaceVisible = Boolean(dialog?.open && visible(dialog));
      surfaceConsistent = surfaceLabel === 'Template library';
    } else if (element?.closest('.ws-ribbon')) {
      const ribbon = element.closest<HTMLElement>('.ws-ribbon');
      const panel = element.closest<HTMLElement>('[data-workspace-panel]');
      const active = document.querySelector<HTMLElement>('[data-workspace][aria-selected="true"]');
      surface = panel ? 'active ribbon panel' : 'CAD ribbon';
      surfaceLabel = panel ? normalize(active?.textContent) : normalize(ribbon?.getAttribute('aria-label'));
      surfaceVisible = visible(ribbon) && (!panel || (!panel.hidden && visible(panel)));
      surfaceConsistent = panel
        ? panel.dataset.workspacePanel === active?.dataset.workspace
        : surfaceLabel === 'CAD ribbon';
    }

    return {
      actualLabel: primaryLabel(element),
      expectedLabel,
      matchCount: matches.length,
      surface,
      surfaceConsistent,
      surfaceLabel,
      surfaceVisible,
    };
  }, { selector: step.selector, expectedLabel: step.label });

  if (observation.matchCount !== 1) {
    throw new Error(`${pathId} step ${step.label} resolved ${observation.matchCount} controls`);
  }
  if (observation.actualLabel !== step.label) {
    throw new Error(
      `${pathId} expected visible label ${JSON.stringify(step.label)}, received ${JSON.stringify(observation.actualLabel)}`,
    );
  }
  if (!observation.surfaceVisible) {
    throw new Error(`${pathId} step ${step.label} is outside a visible product surface: ${JSON.stringify(observation)}`);
  }
  if (!observation.surfaceConsistent) {
    throw new Error(`${pathId} step ${step.label} has the wrong visible context: ${JSON.stringify(observation)}`);
  }
}

async function waitForNavigationStepOutcome(page: Page, step: PartModeUxNavigationStep): Promise<void> {
  if (step.selector === '#bw-welcome-start') {
    await page.waitForFunction(
      () => (window as unknown as { __bwStudio?: { mode(): { kind: string } } }).__bwStudio?.mode().kind === 'sketching'
        && document.getElementById('bw-welcome')?.hidden === true,
      { polling: 50, timeout: 5_000 },
    );
    return;
  }
  const workspace = /^\[data-workspace="([^"]+)"\]$/.exec(step.selector)?.[1];
  if (workspace) {
    await page.waitForFunction(
      (workspaceName) => document.querySelector(`[data-workspace="${workspaceName}"]`)?.getAttribute('aria-selected') === 'true'
        && document.querySelector<HTMLElement>(`[data-workspace-panel="${workspaceName}"]`)?.hidden === false,
      { polling: 50, timeout: 5_000 },
      workspace,
    );
    return;
  }
  if (step.selector === '#bw-welcome-templates' || step.selector.includes('bw-templates-open')) {
    await page.waitForFunction(
      () => (document.getElementById('bw-templates') as HTMLDialogElement | null)?.open === true
        && (document.getElementById('bw-template-search') as HTMLInputElement | null)?.value === ''
        && document.querySelector('[data-template-category="All parts"]')?.getAttribute('aria-pressed') === 'true',
      { polling: 50, timeout: 5_000 },
    );
    return;
  }
  if (step.selector.startsWith('[data-template-id=')) {
    await page.waitForFunction(
      (selector, label) => document.querySelector(selector)?.getAttribute('aria-selected') === 'true'
        && document.getElementById('bw-template-name')?.textContent?.trim() === label,
      { polling: 50, timeout: 5_000 },
      step.selector,
      step.label,
    );
    return;
  }
  if (step.selector.startsWith('[data-template-category=')) {
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true',
      { polling: 50, timeout: 5_000 },
      step.selector,
    );
    return;
  }
  if (step.selector === '#bw-template-use') {
    await page.waitForFunction(
      () => (document.getElementById('bw-templates') as HTMLDialogElement | null)?.open !== true
        && document.getElementById('bw-welcome')?.hidden === true,
      { polling: 50, timeout: 10_000 },
    );
    return;
  }
  if (step.selector.includes('bw-configurations-open')) {
    await page.waitForFunction(
      () => (document.getElementById('bw-configurations') as HTMLDialogElement | null)?.open === true,
      { polling: 50, timeout: 5_000 },
    );
    return;
  }
  if (step.selector.includes('bw-export-drawing')) {
    await page.waitForFunction(
      () => /drawing.*exported/i.test(document.getElementById('bw-studio-msg')?.textContent ?? ''),
      { polling: 100, timeout: 90_000 },
    );
  }
}

async function followVisibleNavigationPath(
  page: Page,
  pathId: string,
): Promise<string> {
  const path = getPartModeUxNavigationPath(pathId);
  for (const step of path.steps) {
    if (step.interaction !== 'click') throw new Error(`${pathId} contains an unsupported ${step.interaction} step`);
    await assertVisibleNavigationStep(page, pathId, step);
    await clickVisibleControl(page, step.selector);
    await waitForNavigationStepOutcome(page, step);
  }
  return path.userPath;
}

async function poisonTemplateLibraryFilters(page: Page): Promise<void> {
  const category: PartModeUxNavigationStep = {
    label: 'Workshop',
    selector: '[data-template-category="Workshop"]',
    interaction: 'click',
  };
  await assertVisibleNavigationStep(page, 'template-filter-reset-regression', category);
  await clickVisibleControl(page, category.selector);
  await waitForNavigationStepOutcome(page, category);

  const searchSurface = await page.evaluate(() => ({
    dialogOpen: (document.getElementById('bw-templates') as HTMLDialogElement | null)?.open === true,
    label: document.querySelector('.ws-template-search > span')?.textContent?.trim() ?? null,
  }));
  if (!searchSurface.dialogOpen || searchSurface.label !== 'Search components') {
    throw new Error(`template search is outside the visible library context: ${JSON.stringify(searchSurface)}`);
  }
  await clickVisibleControl(page, '#bw-template-search');
  await page.keyboard.type('definitely-no-turbofan');
  await page.waitForFunction(
    () => document.getElementById('bw-template-count')?.textContent?.trim() === '0 templates'
      && !document.querySelector('[data-template-id="jet-engine-exploded-assembly"]'),
    { polling: 50, timeout: 5_000 },
  );
}

async function waitForCad(
  page: Page,
  after?: Pick<SmokeState, 'appliedRevision' | 'projectId'>,
): Promise<SmokeState> {
  try {
    await page.waitForFunction(
      (previous) => {
        const studio = (window as unknown as {
          __bwStudio?: {
            appliedRevision(): number;
            documentRevision(): number;
            errors(): string[];
            mode(): { kind: string };
            projectId(): string;
            triCount(): number;
          };
        }).__bwStudio;
        if (
          !studio ||
          studio.mode().kind !== 'idle' ||
          studio.appliedRevision() !== studio.documentRevision()
        ) return false;
        const advanced = previous == null
          || studio.projectId() !== previous.projectId
          || studio.appliedRevision() > previous.appliedRevision;
        return advanced && (studio.triCount() > 0 || studio.errors().length > 0);
      },
      { polling: 100, timeout: 90_000 },
      after ?? null,
    );
  } catch (error) {
    const snapshot = await page.evaluate(() => {
      const studio = (window as unknown as {
        __bwStudio?: {
          appliedRevision(): number;
          documentRevision(): number;
          errors(): string[];
          mode(): { kind: string };
          modeLog(): unknown[];
          projectId(): string;
          triCount(): number;
        };
      }).__bwStudio;
      return {
        present: Boolean(studio),
        mode: studio?.mode() ?? null,
        modeLog: studio?.modeLog() ?? [],
        projectId: studio?.projectId() ?? null,
        triangles: studio?.triCount() ?? null,
        appliedRevision: studio?.appliedRevision() ?? null,
        documentRevision: studio?.documentRevision() ?? null,
        errors: studio?.errors() ?? [],
      };
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CAD did not settle: ${message}; snapshot=${JSON.stringify(snapshot)}`, { cause: error });
  }

  const settled = await page.evaluate(() => {
    const studio = (window as unknown as {
      __bwStudio: {
        appliedRevision(): number;
        bodyResults(): Array<{ geometry?: { valid?: boolean } }>;
        documentRevision(): number;
        errors(): string[];
        projectId(): string;
        triCount(): number;
      };
    }).__bwStudio;
    const bodies = studio.bodyResults();
    return {
      runtimeVersion:
        document.querySelector('.ws-brand small')?.textContent?.match(/V(\d+)/)?.[1] === '8'
          ? '8.0.0'
          : 'unknown',
      documentRevision: studio.documentRevision(),
      appliedRevision: studio.appliedRevision(),
      bodies: bodies.length,
      validBodies: bodies.filter((body) => body.geometry?.valid !== false).length,
      triangles: studio.triCount(),
      errors: studio.errors(),
      projectId: studio.projectId(),
    };
  });
  if (settled.errors.length > 0) throw new Error(`CAD errors: ${settled.errors.join('; ')}`);
  if (settled.triangles <= 0) throw new Error('CAD settled without rendered triangles');
  return settled;
}

async function verifySketchRibbonEntry(page: Page): Promise<{
  enteredMode: string;
  escapeCancelled: boolean;
  keyboardEntry: boolean;
  returnedMode: string;
  revisionUnchanged: boolean;
  activeCommandTransitioned: boolean;
}> {
  const before = await page.evaluate(() => {
    const studio = (window as unknown as {
      __bwStudio?: { documentRevision(): number; mode(): { kind: string } };
    }).__bwStudio;
    const tab = document.querySelector<HTMLButtonElement>('[data-workspace="sketch"]');
    return {
      disabled: tab?.disabled ?? true,
      mode: studio?.mode().kind ?? null,
      revision: studio?.documentRevision() ?? null,
      title: tab?.title ?? null,
    };
  });
  if (before.mode !== 'idle' || before.disabled || before.title !== 'Start a sketch on the base plane') {
    throw new Error(`Sketch ribbon entry is unavailable while idle: ${JSON.stringify(before)}`);
  }

  await clickVisibleControl(page, '[data-workspace="sketch"]');
  await page.waitForFunction(
    () => {
      const studio = (window as unknown as {
        __bwStudio?: { mode(): { kind: string } };
      }).__bwStudio;
      const tab = document.querySelector<HTMLButtonElement>('[data-workspace="sketch"]');
      const panel = document.querySelector<HTMLElement>('[data-workspace-panel="sketch"]');
      const rectangle = document.querySelector<HTMLButtonElement>('[data-sktool="rect"]');
      return studio?.mode().kind === 'sketching'
        && tab?.getAttribute('aria-selected') === 'true'
        && panel?.hidden === false
        && rectangle?.disabled === false;
    },
    { polling: 50, timeout: 5_000 },
  );
  const enteredMode = await page.evaluate(() => (
    (window as unknown as { __bwStudio: { mode(): { kind: string } } }).__bwStudio.mode().kind
  ));

  await clickVisibleControl(page, '#bw-sk-cancel');
  await page.waitForFunction(
    () => (window as unknown as {
      __bwStudio?: { mode(): { kind: string } };
    }).__bwStudio?.mode().kind === 'idle',
    { polling: 50, timeout: 5_000 },
  );

  const solidTab = await page.$('[data-workspace="solid"]') as ElementHandle<HTMLButtonElement> | null;
  if (!solidTab) throw new Error('3D Tools ribbon tab is missing');
  await solidTab.focus();
  await solidTab.dispose();
  await page.keyboard.press('ArrowLeft');
  const keyboardFocus = await page.evaluate(() => (
    (document.activeElement as HTMLElement | null)?.dataset.workspace ?? null
  ));
  if (keyboardFocus !== 'sketch') {
    throw new Error(`Arrow-key ribbon navigation did not reach Sketch: ${keyboardFocus}`);
  }
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => (window as unknown as {
      __bwStudio?: { mode(): { kind: string } };
    }).__bwStudio?.mode().kind === 'sketching',
    { polling: 50, timeout: 5_000 },
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => (window as unknown as {
      __bwStudio?: { mode(): { kind: string } };
    }).__bwStudio?.mode().kind === 'idle',
    { polling: 50, timeout: 5_000 },
  );

  await clickVisibleControl(page, '[data-feat="extrude"]');
  await page.waitForFunction(
    () => (window as unknown as {
      __bwStudio?: { mode(): { kind: string } };
    }).__bwStudio?.mode().kind === 'choose-face',
    { polling: 50, timeout: 5_000 },
  );
  const unavailableState = await page.evaluate(() => {
    const tab = document.querySelector<HTMLButtonElement>('[data-workspace="sketch"]');
    const reasonId = tab?.getAttribute('aria-describedby');
    return {
      ariaDisabled: tab?.getAttribute('aria-disabled'),
      disabled: tab?.disabled,
      reason: reasonId ? document.getElementById(reasonId)?.textContent?.trim() : null,
      title: tab?.title,
    };
  });
  if (
    unavailableState.disabled
    || unavailableState.ariaDisabled !== null
    || unavailableState.reason !== null
    || unavailableState.title !== 'Start a sketch on the base plane'
  ) {
    throw new Error(`Sketch was disabled by an active command: ${JSON.stringify(unavailableState)}`);
  }
  const sketchTab = await page.$('[data-workspace="sketch"]') as ElementHandle<HTMLButtonElement> | null;
  if (!sketchTab) throw new Error('Sketch ribbon tab is missing');
  await sketchTab.focus();
  await sketchTab.dispose();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => {
      const studio = (window as unknown as {
        __bwStudio?: { mode(): { kind: string } };
      }).__bwStudio;
      return studio?.mode().kind === 'sketching';
    },
    { polling: 50, timeout: 5_000 },
  );
  await clickVisibleControl(page, '#bw-sk-cancel');
  await page.waitForFunction(
    () => (window as unknown as {
      __bwStudio?: { mode(): { kind: string } };
    }).__bwStudio?.mode().kind === 'idle',
    { polling: 50, timeout: 5_000 },
  );

  const after = await page.evaluate(() => {
    const studio = (window as unknown as {
      __bwStudio: { documentRevision(): number; mode(): { kind: string } };
    }).__bwStudio;
    return { mode: studio.mode().kind, revision: studio.documentRevision() };
  });
  if (after.revision !== before.revision) {
    throw new Error(`Cancelling ribbon-started Sketch mutated the document: ${before.revision} -> ${after.revision}`);
  }
  return {
    enteredMode,
    escapeCancelled: true,
    keyboardEntry: true,
    returnedMode: after.mode,
    revisionUnchanged: true,
    activeCommandTransitioned: true,
  };
}

async function verifyFirstSolidFlow(
  browserInstance: Awaited<ReturnType<typeof puppeteer.launch>>,
  smokeUrl: string,
): Promise<{
  canvasBackingMatchesDisplay: boolean;
  focusReturnedToSketch: boolean;
  undoReturnedToEmpty: boolean;
  primaryActions: number;
  shortViewportCanvasHeight: number;
  shortViewportEntryFocusVisible: boolean;
  shortViewportNoOverflow: boolean;
  dimensionsInsideSketch: boolean;
  visibleApplyButtons: number;
  visibleCancelButtons: number;
  triangles: number;
}> {
  const firstRunContext = await browserInstance.createBrowserContext();
  const firstRunPage = await firstRunContext.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  firstRunPage.on('pageerror', (error) => pageErrors.push(String(error)));
  firstRunPage.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  firstRunPage.on('requestfailed', (request) => {
    networkErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`);
  });
  firstRunPage.on('response', (response) => {
    if (response.status() >= 400) networkErrors.push(`${response.status()} ${response.url()}`);
  });

  try {
    await firstRunPage.setViewport({ width: 1365, height: 768, deviceScaleFactor: 1 });
    const response = await firstRunPage.goto(new URL('/', smokeUrl).href, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    if (!response || response.status() !== 200) {
      throw new Error(`first-run PartMode page returned HTTP ${response?.status() ?? 0}`);
    }
    await firstRunPage.waitForFunction(
      () => {
        const studio = (window as unknown as {
          __bwStudio?: { mode(): { kind: string } };
        }).__bwStudio;
        const tab = document.querySelector<HTMLButtonElement>('[data-workspace="sketch"]');
        const welcome = document.getElementById('bw-welcome');
        return studio?.mode().kind === 'idle'
          && tab?.disabled === false
          && welcome?.getAttribute('aria-busy') === 'false';
      },
      { polling: 100, timeout: 90_000 },
    );

    await clickVisibleControl(firstRunPage, '#pm-cookie-essential');
    await clickVisibleControl(firstRunPage, '[data-workspace="sketch"]');
    await firstRunPage.waitForFunction(
      () => (window as unknown as {
        __bwStudio?: { mode(): { kind: string } };
      }).__bwStudio?.mode().kind === 'sketching',
      { polling: 50, timeout: 5_000 },
    );
    const entry = await firstRunPage.evaluate(() => {
      const visible = (element: HTMLElement | null) => {
        if (!element || element.hidden) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      return {
        tourVisible: visible(document.getElementById('bw-tour')),
        optionsVisible: visible(document.getElementById('bw-sk-options')),
        optionsExpanded: document.getElementById('bw-sk-options')?.getAttribute('aria-expanded'),
        patternHidden: (document.getElementById('bw-sk-pat-row') as HTMLElement | null)?.hidden,
        resultHidden: (document.getElementById('bw-sk-result-row') as HTMLElement | null)?.hidden,
        globalActionsHidden: (document.getElementById('bw-cmd-actions') as HTMLElement | null)?.hidden,
      };
    });
    if (
      entry.tourVisible
      || !entry.optionsVisible
      || entry.optionsExpanded !== 'false'
      || entry.patternHidden !== true
      || entry.resultHidden !== true
      || entry.globalActionsHidden !== true
    ) {
      throw new Error(`first-run Sketch hierarchy is not progressive: ${JSON.stringify(entry)}`);
    }

    const waitForCanvasSizing = async () => {
      try {
        await firstRunPage.waitForFunction(
          () => {
            const canvas = document.getElementById('bw-sketch-canvas') as HTMLCanvasElement | null;
            if (!canvas) return false;
            const rect = canvas.getBoundingClientRect();
            const ratio = Math.min(window.devicePixelRatio || 1, 2);
            return rect.width > 0
              && rect.height > 0
              && Math.abs(canvas.width - Math.round(rect.width * ratio)) <= 1
              && Math.abs(canvas.height - Math.round(rect.height * ratio)) <= 1;
          },
          { polling: 50, timeout: 5_000 },
        );
      } catch (error) {
        const snapshot = await firstRunPage.evaluate(() => {
          const canvas = document.getElementById('bw-sketch-canvas') as HTMLCanvasElement | null;
          const rect = canvas?.getBoundingClientRect();
          const layout = ['bw-sketch', '.sk-top', '.sk-bottom', 'bw-studio'].map((selector) => {
            const element = selector.startsWith('.')
              ? document.querySelector<HTMLElement>(selector)
              : document.getElementById(selector);
            const bounds = element?.getBoundingClientRect();
            return bounds ? [bounds.width, bounds.height] : null;
          });
          return {
            backing: canvas ? [canvas.width, canvas.height] : null,
            css: rect ? [rect.width, rect.height] : null,
            dpr: window.devicePixelRatio,
            mode: document.querySelector('.cadstudio-app')?.getAttribute('data-mode'),
            display: canvas ? getComputedStyle(canvas).display : null,
            layout,
          };
        });
        throw new Error(`Sketch canvas backing mismatch: ${JSON.stringify(snapshot)}`, { cause: error });
      }
    };
    await waitForCanvasSizing();

    await firstRunPage.setViewport({ width: 844, height: 390, deviceScaleFactor: 1 });
    await firstRunPage.waitForFunction(
      () => document.querySelector('.cadstudio-app')?.getAttribute('data-mode') === 'sketching',
      { polling: 50, timeout: 5_000 },
    );
    await waitForCanvasSizing();
    await firstRunPage.waitForFunction(
      () => (document.activeElement as HTMLElement | null)?.id === 'bw-sketch-canvas',
      { polling: 25, timeout: 2_000 },
    );
    const shortViewportChrome = await firstRunPage.evaluate(() => {
      const visible = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        return Boolean(element && getComputedStyle(element).display !== 'none' && element.getClientRects().length);
      };
      const canvas = document.getElementById('bw-sketch-canvas')?.getBoundingClientRect();
      const active = document.activeElement as HTMLElement | null;
      const activeRect = active?.getBoundingClientRect();
      const toolRail = document.getElementById('ws-panel-sketch')?.getBoundingClientRect();
      return {
        canvasHeight: canvas?.height ?? 0,
        compactToolRail: visible('#rib-sketch') && Boolean(toolRail && toolRail.height <= 48),
        nonessentialChromeHidden: [
          '.ws-workspace-bar',
          '.ws-document-tabs',
          '.ws-tree',
          '.ws-side',
          '.ws-mtabs',
          '.ws-cmd',
          '.ws-status',
        ].every((selector) => !visible(selector)),
        entryFocusVisible: Boolean(
          active?.id === 'bw-sketch-canvas'
          && activeRect
          && activeRect.width > 0
          && activeRect.height > 0
          && activeRect.top >= 0
          && activeRect.bottom <= innerHeight
        ),
        focusedElement: active ? {
          id: active.id,
          tag: active.tagName,
          rect: activeRect ? [activeRect.left, activeRect.top, activeRect.right, activeRect.bottom] : null,
        } : null,
        viewport: [innerWidth, innerHeight],
      };
    });
    if (
      shortViewportChrome.canvasHeight < 160
      || !shortViewportChrome.compactToolRail
      || !shortViewportChrome.nonessentialChromeHidden
      || !shortViewportChrome.entryFocusVisible
    ) {
      throw new Error(`short-viewport Sketch did not reserve a usable canvas: ${JSON.stringify(shortViewportChrome)}`);
    }

    await clickVisibleControl(firstRunPage, '#bw-sk-options');
    await firstRunPage.waitForFunction(
      () => document.getElementById('bw-sk-options')?.getAttribute('aria-expanded') === 'true'
        && document.getElementById('bw-sk-pat-row')?.hidden === false
        && document.getElementById('bw-sk-result-row')?.hidden === false,
      { polling: 50, timeout: 5_000 },
    );
    await waitForCanvasSizing();
    await clickVisibleControl(firstRunPage, '#bw-sk-options');
    await firstRunPage.waitForFunction(
      () => document.getElementById('bw-sk-options')?.getAttribute('aria-expanded') === 'false'
        && document.getElementById('bw-sk-pat-row')?.hidden === true
        && document.getElementById('bw-sk-result-row')?.hidden === true,
      { polling: 50, timeout: 5_000 },
    );
    await waitForCanvasSizing();

    const canvas = await firstRunPage.$('#bw-sketch-canvas');
    if (!canvas) throw new Error('first-run sketch canvas is missing');
    const bounds = await canvas.boundingBox();
    if (!bounds || bounds.width < 200 || bounds.height < 160) {
      throw new Error(`first-run sketch canvas has invalid bounds: ${JSON.stringify(bounds)}`);
    }
    await firstRunPage.mouse.click(bounds.x + bounds.width * 0.36, bounds.y + bounds.height * 0.35);
    await firstRunPage.mouse.click(bounds.x + bounds.width * 0.64, bounds.y + bounds.height * 0.65);
    await firstRunPage.waitForFunction(
      () => document.querySelectorAll('#bw-sk-dims input').length >= 4,
      { polling: 50, timeout: 5_000 },
    );

    const layout = await firstRunPage.evaluate(() => {
      const visible = (element: HTMLElement | null) => {
        if (!element || element.hidden) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const sketch = document.getElementById('bw-sketch')?.getBoundingClientRect();
      const sketchElement = document.getElementById('bw-sketch');
      const canvas = document.getElementById('bw-sketch-canvas')?.getBoundingClientRect();
      const header = document.querySelector('.sk-top')?.getBoundingClientRect();
      const footer = document.querySelector('.sk-bottom')?.getBoundingClientRect();
      const dimensions = document.getElementById('bw-sk-dims')?.getBoundingClientRect();
      const visibleApplyButtons = ['bw-sk-apply', 'bw-cmd-apply']
        .filter((id) => visible(document.getElementById(id))).length;
      const visibleCancelButtons = ['bw-sk-cancel', 'bw-cmd-cancel']
        .filter((id) => visible(document.getElementById(id))).length;
      return {
        dimensionsInsideSketch: Boolean(
          sketch
          && dimensions
          && dimensions.top >= sketch.top - 1
          && dimensions.bottom <= sketch.bottom + 1
        ),
        shortViewportCanvasHeight: canvas?.height ?? 0,
        shortViewportNoOverflow: Boolean(
          sketchElement
          && sketchElement.scrollHeight <= sketchElement.clientHeight + 1
          && header
          && canvas
          && footer
          && header.bottom <= canvas.top + 1
          && canvas.bottom <= footer.top + 1
          && footer.bottom <= (sketch?.bottom ?? 0) + 1
        ),
        visibleApplyButtons,
        visibleCancelButtons,
      };
    });
    if (
      !layout.dimensionsInsideSketch
      || layout.shortViewportCanvasHeight < 160
      || !layout.shortViewportNoOverflow
      || layout.visibleApplyButtons !== 1
      || layout.visibleCancelButtons !== 1
    ) {
      throw new Error(`first-run Sketch layout is ambiguous or clipped: ${JSON.stringify(layout)}`);
    }

    await clickVisibleControl(firstRunPage, '#bw-sk-apply');
    await firstRunPage.waitForFunction(
      () => {
        const studio = (window as unknown as {
          __bwStudio?: {
            appliedRevision(): number;
            documentRevision(): number;
            errors(): string[];
            mode(): { kind: string };
            triCount(): number;
          };
        }).__bwStudio;
        return studio?.mode().kind === 'idle'
          && studio.appliedRevision() === studio.documentRevision()
          && studio.triCount() > 0
          && studio.errors().length === 0;
      },
      { polling: 100, timeout: 90_000 },
    );
    const triangles = await firstRunPage.evaluate(() => (
      (window as unknown as { __bwStudio: { triCount(): number } }).__bwStudio.triCount()
    ));
    const focusAfterApply = await firstRunPage.evaluate(() => ({
      ariaDisabled: document.querySelector('[data-workspace="sketch"]')?.getAttribute('aria-disabled'),
      disabled: (document.querySelector('[data-workspace="sketch"]') as HTMLButtonElement | null)?.disabled,
      workspace: (document.activeElement as HTMLElement | null)?.dataset.workspace ?? null,
    }));
    if (focusAfterApply.workspace !== 'sketch' || focusAfterApply.disabled || focusAfterApply.ariaDisabled !== null) {
      throw new Error(`Sketch did not restore focus after Apply: ${JSON.stringify(focusAfterApply)}`);
    }
    await clickVisibleControl(firstRunPage, '#bw-undo');
    await firstRunPage.waitForFunction(
      () => {
        const studio = (window as unknown as {
          __bwStudio?: {
            appliedRevision(): number;
            bodyResults(): unknown[];
            documentRevision(): number;
            errors(): string[];
            mode(): { kind: string };
            triCount(): number;
          };
        }).__bwStudio;
        return studio?.mode().kind === 'idle'
          && studio.appliedRevision() === studio.documentRevision()
          && studio.bodyResults().length === 0
          && studio.triCount() === 0
          && studio.errors().length === 0;
      },
      { polling: 100, timeout: 90_000 },
    );
    failForBrowserErrors(pageErrors, consoleErrors, networkErrors);
    return {
      canvasBackingMatchesDisplay: true,
      focusReturnedToSketch: true,
      undoReturnedToEmpty: true,
      primaryActions: 4,
      shortViewportEntryFocusVisible: shortViewportChrome.entryFocusVisible,
      ...layout,
      triangles,
    };
  } finally {
    await firstRunPage.close();
    await firstRunContext.close();
  }
}

async function verifyShortViewportPressPullFlow(
  browserInstance: Awaited<ReturnType<typeof puppeteer.launch>>,
  smokeUrl: string,
): Promise<{
  cardInsideViewport: boolean;
  focusReturnedToSketch: boolean;
  stageHeight: number;
  triangles: number;
}> {
  const context = await browserInstance.createBrowserContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    networkErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) networkErrors.push(`${response.status()} ${response.url()}`);
  });

  try {
    await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 1 });
    const response = await page.goto(new URL('/', smokeUrl).href, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    if (!response || response.status() !== 200) {
      throw new Error(`short-viewport Press / Pull page returned HTTP ${response?.status() ?? 0}`);
    }
    await page.waitForFunction(
      () => {
        const studio = (window as unknown as {
          __bwStudio?: { mode(): { kind: string } };
        }).__bwStudio;
        const tab = document.querySelector<HTMLButtonElement>('[data-workspace="sketch"]');
        const welcome = document.getElementById('bw-welcome');
        return studio?.mode().kind === 'idle'
          && tab?.disabled === false
          && welcome?.getAttribute('aria-busy') === 'false';
      },
      { polling: 100, timeout: 90_000 },
    );

    await clickVisibleControl(page, '#pm-cookie-essential');
    await clickVisibleControl(page, '[data-workspace="sketch"]');
    await page.waitForFunction(
      () => (window as unknown as {
        __bwStudio?: { mode(): { kind: string } };
      }).__bwStudio?.mode().kind === 'sketching'
        && (document.getElementById('bw-sketch-canvas')?.getBoundingClientRect().height ?? 0) >= 160,
      { polling: 50, timeout: 5_000 },
    );
    const canvas = await page.$('#bw-sketch-canvas');
    if (!canvas) throw new Error('short-viewport Press / Pull canvas is missing');
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error('short-viewport Press / Pull canvas has no bounds');
    await page.mouse.click(bounds.x + bounds.width * 0.36, bounds.y + bounds.height * 0.35);
    await page.mouse.click(bounds.x + bounds.width * 0.64, bounds.y + bounds.height * 0.65);
    await canvas.dispose();
    await page.waitForFunction(
      () => {
        const button = document.getElementById('bw-sk-presspull');
        return Boolean(button && !button.hidden && button.getClientRects().length);
      },
      { polling: 50, timeout: 5_000 },
    );
    await clickVisibleControl(page, '#bw-sk-presspull');
    await page.waitForFunction(
      () => (window as unknown as {
        __bwStudio?: { mode(): { kind: string } };
      }).__bwStudio?.mode().kind === 'press-pull',
      { polling: 50, timeout: 5_000 },
    );

    const pressPullLayout = await page.evaluate(() => {
      const stage = document.getElementById('bw-studio')?.getBoundingClientRect();
      const card = document.querySelector<HTMLElement>('.pp-card')?.getBoundingClientRect();
      const finish = document.getElementById('bw-presspull-apply')?.getBoundingClientRect();
      const finishButton = document.getElementById('bw-presspull-apply');
      const hit = finish
        ? document.elementFromPoint(finish.left + finish.width / 2, finish.top + finish.height / 2)
        : null;
      return {
        cardInsideViewport: Boolean(
          stage
          && card
          && finish
          && card.top >= stage.top - 1
          && card.bottom <= stage.bottom + 1
          && finish.bottom <= innerHeight
          && hit
          && finishButton?.contains(hit)
        ),
        mode: document.querySelector('.cadstudio-app')?.getAttribute('data-mode'),
        ribbonHidden: getComputedStyle(document.querySelector<HTMLElement>('.ws-ribbon')!).display === 'none',
        stageHeight: stage?.height ?? 0,
      };
    });
    if (
      pressPullLayout.mode !== 'press-pull'
      || !pressPullLayout.cardInsideViewport
      || !pressPullLayout.ribbonHidden
      || pressPullLayout.stageHeight < 300
    ) {
      throw new Error(`short-viewport Press / Pull is clipped: ${JSON.stringify(pressPullLayout)}`);
    }

    await clickVisibleControl(page, '#bw-presspull-apply');
    await page.waitForFunction(
      () => {
        const studio = (window as unknown as {
          __bwStudio?: {
            appliedRevision(): number;
            documentRevision(): number;
            errors(): string[];
            mode(): { kind: string };
            triCount(): number;
          };
        }).__bwStudio;
        return studio?.mode().kind === 'idle'
          && studio.appliedRevision() === studio.documentRevision()
          && studio.triCount() > 0
          && studio.errors().length === 0;
      },
      { polling: 100, timeout: 90_000 },
    );
    await page.waitForFunction(
      () => (document.activeElement as HTMLElement | null)?.dataset.workspace === 'sketch',
      { polling: 50, timeout: 5_000 },
    );
    const settled = await page.evaluate(() => ({
      focus: (document.activeElement as HTMLElement | null)?.dataset.workspace ?? null,
      triangles: (window as unknown as { __bwStudio: { triCount(): number } }).__bwStudio.triCount(),
    }));
    if (settled.focus !== 'sketch') {
      throw new Error(`Press / Pull did not restore focus to Sketch: ${settled.focus}`);
    }
    failForBrowserErrors(pageErrors, consoleErrors, networkErrors);
    return {
      cardInsideViewport: true,
      focusReturnedToSketch: true,
      stageHeight: pressPullLayout.stageHeight,
      triangles: settled.triangles,
    };
  } finally {
    await page.close();
    await context.close();
  }
}

async function verifyRibbonLabelLayout(page: Page): Promise<{
  labels: number;
  panels: number;
}> {
  const originalViewport = page.viewport();
  let audit: {
    failures: Array<{
      button: [number, number, number, number];
      label: [number, number, number, number];
      panel: string;
      text: string;
      textOverflow: boolean;
    }>;
    labels: number;
    panels: number;
  };
  try {
    await page.setViewport({ width: 1158, height: 768, deviceScaleFactor: 1 });
    audit = await page.evaluate(() => {
      const panels = [...document.querySelectorAll<HTMLElement>('.ws-ribbon-panel[data-workspace-panel]')];
      const originalHidden = panels.map((panel) => panel.hidden);
      const failures: Array<{
        button: [number, number, number, number];
        label: [number, number, number, number];
        panel: string;
        text: string;
        textOverflow: boolean;
      }> = [];
      let labels = 0;

      try {
        for (const activePanel of panels) {
          for (const panel of panels) panel.hidden = panel !== activePanel;
          for (const label of activePanel.querySelectorAll<HTMLElement>('.wsr-btn > .wsr-label')) {
            const button = label.closest<HTMLElement>('.wsr-btn');
            if (!button || getComputedStyle(button).display === 'none') continue;
            const buttonRect = button.getBoundingClientRect();
            const labelRect = label.getBoundingClientRect();
            if (buttonRect.width <= 0 || buttonRect.height <= 0 || labelRect.width <= 0 || labelRect.height <= 0) continue;
            labels += 1;
            const textOverflow = label.scrollWidth > label.clientWidth + 1
              || label.scrollHeight > label.clientHeight + 1;
            const escapesButton = labelRect.left < buttonRect.left - 1
              || labelRect.right > buttonRect.right + 1
              || labelRect.top < buttonRect.top - 1
              || labelRect.bottom > buttonRect.bottom + 1;
            if (textOverflow || escapesButton) {
              failures.push({
                button: [buttonRect.left, buttonRect.top, buttonRect.right, buttonRect.bottom],
                label: [labelRect.left, labelRect.top, labelRect.right, labelRect.bottom],
                panel: activePanel.dataset.workspacePanel ?? activePanel.id,
                text: label.textContent?.trim() ?? '',
                textOverflow,
              });
            }
          }
        }
      } finally {
        panels.forEach((panel, index) => { panel.hidden = originalHidden[index] ?? true; });
      }

      return { failures, labels, panels: panels.length };
    });
  } finally {
    if (originalViewport) await page.setViewport(originalViewport);
  }

  if (audit.failures.length > 0) {
    throw new Error(`ribbon labels escape their command buttons: ${JSON.stringify(audit.failures)}`);
  }
  if (audit.panels < 7 || audit.labels < 40) {
    throw new Error(`ribbon layout audit did not cover the product: ${JSON.stringify(audit)}`);
  }
  return { labels: audit.labels, panels: audit.panels };
}

async function verifyAuditedUsability(page: Page): Promise<{
  beginnerTemplateReady: boolean;
  compactHistory: boolean;
  featureEditFocusRestored: boolean;
  facePickerEntryFocusVisible: boolean;
  shortFacePickerComplete: boolean;
  mobileAssemblyReachable: boolean;
  createAssemblyCancellable: boolean;
}> {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await clickVisibleControl(page, '#bw-templates-open');
  await page.waitForFunction(
    () => (document.getElementById('bw-templates') as HTMLDialogElement | null)?.open === true,
    { polling: 50, timeout: 5_000 },
  );
  const template = await page.evaluate(() => ({
    selected: document.querySelector('.ws-template-card[aria-selected="true"] b')?.textContent?.trim() ?? null,
    detail: document.getElementById('bw-template-name')?.textContent?.trim() ?? null,
    openDisabled: (document.getElementById('bw-template-use') as HTMLButtonElement | null)?.disabled ?? true,
  }));
  if (template.selected !== 'Starter plate' || template.detail !== 'Starter plate' || template.openDisabled) {
    throw new Error(`template library does not present an immediately usable beginner part: ${JSON.stringify(template)}`);
  }
  await clickVisibleControl(page, '#bw-templates-close');

  const history = await page.evaluate(() => {
    const list = document.getElementById('bw-history');
    const rows = [...document.querySelectorAll<HTMLElement>('#bw-history .hist-item')];
    return {
      rows: rows.length,
      noHorizontalOverflow: Boolean(list && list.scrollWidth <= list.clientWidth + 1),
      inactiveRowsKeepEditPrimary: rows.filter((row) => !row.classList.contains('sel')).every((row) => {
        const visible = [...row.querySelectorAll<HTMLButtonElement>('.hi-a button')]
          .filter((button) => getComputedStyle(button).display !== 'none');
        return visible.length === 1 && Boolean(visible[0]?.dataset.edit);
      }),
    };
  });
  if (!history.rows || !history.noHorizontalOverflow || !history.inactiveRowsKeepEditPrimary) {
    throw new Error(`feature history is still visually overloaded: ${JSON.stringify(history)}`);
  }

  const editableSketchSelector = '#bw-history .hist-item:is([data-feature="extrude"], [data-feature="cut"]) [data-edit]';
  const editButton = await page.$(editableSketchSelector) as ElementHandle<HTMLButtonElement> | null;
  if (!editButton) throw new Error('editable feature history row is missing');
  const editedFeatureId = await editButton.evaluate((button) => button.dataset.edit || '');
  const beforeEdit = await page.evaluate(() => {
    const studio = (window as unknown as {
      __bwStudio: { appliedRevision(): number; projectId(): string };
    }).__bwStudio;
    return { appliedRevision: studio.appliedRevision(), projectId: studio.projectId() };
  });
  await editButton.dispose();
  await clickVisibleControl(page, editableSketchSelector);
  await page.waitForFunction(
    () => (window as unknown as { __bwStudio?: { mode(): { kind: string } } }).__bwStudio?.mode().kind === 'sketching',
    { polling: 50, timeout: 5_000 },
  );
  await page.$eval('#bw-sk-op-h', (input) => {
    const control = input as HTMLInputElement;
    const current = control.value.trim();
    const numeric = Number(current);
    control.value = Number.isFinite(numeric) ? String(numeric + 1) : `(${current})+1`;
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickVisibleControl(page, '#bw-sk-apply');
  await waitForCad(page, beforeEdit);
  await page.waitForFunction(
    (featureId) => (document.activeElement as HTMLElement | null)?.dataset.edit === featureId,
    { polling: 50, timeout: 5_000 },
    editedFeatureId,
  );

  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 1 });
  await clickVisibleControl(page, '[data-workspace="solid"]');
  await clickVisibleControl(page, '[data-feat="extrude"]');
  await page.waitForFunction(
    () => (window as unknown as { __bwStudio?: { mode(): { kind: string } } }).__bwStudio?.mode().kind === 'choose-face'
      && (document.activeElement as HTMLElement | null)?.id === 'bw-face-base',
    { polling: 50, timeout: 5_000 },
  );
  const facePicker = await page.evaluate(() => {
    const ids = ['bw-face-next', 'bw-face-base', 'bw-face-cancel'];
    const actions = ids.map((id) => {
      const button = document.getElementById(id) as HTMLButtonElement | null;
      const rect = button?.getBoundingClientRect();
      const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
      return {
        id,
        inside: Boolean(rect && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight),
        ownsHit: Boolean(button && hit && button.contains(hit)),
      };
    });
    return {
      mode: document.querySelector('.cadstudio-app')?.getAttribute('data-mode'),
      actions,
    };
  });
  if (facePicker.mode !== 'choose-face' || facePicker.actions.some((action) => !action.inside || !action.ownsHit)) {
    throw new Error(`short-viewport face selection is incomplete: ${JSON.stringify(facePicker)}`);
  }
  await clickVisibleControl(page, '#bw-face-cancel');

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.$eval('[data-workspace="assembly"]', (element) => {
    element.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' });
  });
  const assemblyTab = await page.evaluate(() => {
    const tab = document.querySelector<HTMLButtonElement>('[data-workspace="assembly"]');
    const rect = tab?.getBoundingClientRect();
    return {
      visible: Boolean(tab && rect && getComputedStyle(tab).display !== 'none' && rect.width > 0 && rect.height > 0),
      disabled: tab?.disabled ?? true,
      inside: Boolean(rect && rect.left >= 0 && rect.right <= innerWidth),
    };
  });
  if (!assemblyTab.visible || assemblyTab.disabled || !assemblyTab.inside) {
    throw new Error(`Assembly workspace is not reachable on a phone viewport: ${JSON.stringify(assemblyTab)}`);
  }
  await clickVisibleControl(page, '[data-workspace="assembly"]');
  await clickVisibleControl(page, '[data-assembly-command="create"]');
  await page.waitForFunction(
    () => (document.getElementById('bw-v5-command') as HTMLDialogElement | null)?.open === true
      && document.getElementById('bw-v5-command-title')?.textContent?.includes('Create assembly'),
    { polling: 50, timeout: 5_000 },
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => (document.getElementById('bw-v5-command') as HTMLDialogElement | null)?.open !== true,
    { polling: 50, timeout: 5_000 },
  );
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await clickVisibleControl(page, '[data-workspace="solid"]');

  return {
    beginnerTemplateReady: true,
    compactHistory: true,
    featureEditFocusRestored: true,
    facePickerEntryFocusVisible: true,
    shortFacePickerComplete: true,
    mobileAssemblyReachable: true,
    createAssemblyCancellable: true,
  };
}

async function verifyVisibleTemplateJourneys(
  browserInstance: Awaited<ReturnType<typeof puppeteer.launch>>,
  smokeUrl: string,
): Promise<{
  coveredPathIds: string[];
  firstVisitPath: string;
  existingEditorPath: string;
  exactBodies: number;
  numberedRoots: number;
  renderedBodies: number;
  triangles: number;
}> {
  const expectedRootNames = [
    '01 · Fan and LP Spool',
    '02 · Axial Compressor',
    '03 · Annular Combustor',
    '04 · Turbine',
    '05 · Exhaust',
    '06 · Fan Case and OGVs',
  ];

  const openFreshPage = async () => {
    const context = await browserInstance.createBrowserContext();
    const page = await context.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const networkErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('dialog', async (dialog) => {
      pageErrors.push(`unexpected ${dialog.type()} dialog: ${dialog.message()}`);
      await dialog.dismiss();
    });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      networkErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) networkErrors.push(`${response.status()} ${response.url()}`);
    });
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    const response = await page.goto(new URL('/', smokeUrl).href, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    if (!response || response.status() !== 200) {
      throw new Error(`fresh navigation page returned HTTP ${response?.status() ?? 0}`);
    }
    await page.waitForFunction(
      () => {
        const studio = (window as unknown as {
          __bwStudio?: {
            appliedRevision(): number;
            documentRevision(): number;
            mode(): { kind: string };
          };
        }).__bwStudio;
        const welcome = document.getElementById('bw-welcome');
        const browse = document.getElementById('bw-welcome-templates') as HTMLButtonElement | null;
        return studio?.mode().kind === 'idle'
          && studio.appliedRevision() === studio.documentRevision()
          && welcome?.getAttribute('aria-busy') === 'false'
          && browse?.disabled === false;
      },
      { polling: 100, timeout: 90_000 },
    );
    // First-visit overlays are sequenced: the cookie banner renders first and
    // the template chooser stays hidden until the banner is dismissed. The
    // two overlays must never be visible simultaneously.
    const onboarding = await page.evaluate(() => {
      const isVisible = (element: HTMLElement | null) => {
        const rect = element?.getBoundingClientRect();
        return Boolean(
          element
          && !element.hidden
          && rect
          && rect.width > 0
          && rect.height > 0
          && getComputedStyle(element).display !== 'none'
        );
      };
      return {
        firstVisitFlag: localStorage.getItem('bw-studio-welcome-v1'),
        seededFlag: localStorage.getItem('bw-studio-v2-seeded'),
        title: document.getElementById('bw-welcome-title')?.textContent?.trim() ?? null,
        bannerVisible: isVisible(document.getElementById('pm-cookie-banner')),
        welcomeVisible: isVisible(document.getElementById('bw-welcome')),
      };
    });
    if (
      onboarding.firstVisitFlag !== null
      || onboarding.seededFlag !== null
      || onboarding.title !== 'Choose a starting point'
      || !onboarding.bannerVisible
      || onboarding.welcomeVisible
    ) {
      throw new Error(`first-visit overlays are not sequenced banner-first: ${JSON.stringify(onboarding)}`);
    }
    await clickVisibleControl(page, '#pm-cookie-essential');
    await page.waitForFunction(
      () => {
        const banner = document.getElementById('pm-cookie-banner');
        const welcome = document.getElementById('bw-welcome');
        const rect = welcome?.getBoundingClientRect();
        return banner?.hidden === true
          && Boolean(welcome && !welcome.hidden && rect && rect.width > 0 && rect.height > 0
            && getComputedStyle(welcome).display !== 'none');
      },
      { polling: 50, timeout: 10_000 },
    );
    return { context, page, pageErrors, consoleErrors, networkErrors };
  };

  const coveredPathIds: string[] = [];
  const firstVisit = await openFreshPage();
  let firstVisitPath = '';
  try {
    await followVisibleNavigationPath(firstVisit.page, 'templates.library.first-visit');
    coveredPathIds.push('templates.library.first-visit');
    await clickVisibleControl(firstVisit.page, '#bw-templates-close');
    await firstVisit.page.waitForFunction(
      () => (document.getElementById('bw-templates') as HTMLDialogElement | null)?.open !== true
        && document.getElementById('bw-welcome')?.hidden === false,
      { polling: 50, timeout: 5_000 },
    );
    firstVisitPath = await followVisibleNavigationPath(
      firstVisit.page,
      'templates.exploded-turbofan.first-visit',
    );
    coveredPathIds.push('templates.exploded-turbofan.first-visit');
    failForBrowserErrors(firstVisit.pageErrors, firstVisit.consoleErrors, firstVisit.networkErrors);
  } finally {
    await firstVisit.page.close();
    await firstVisit.context.close();
  }

  const existingEditor = await openFreshPage();
  try {
    await followVisibleNavigationPath(existingEditor.page, 'project.blank.first-visit');
    coveredPathIds.push('project.blank.first-visit');
    await existingEditor.page.keyboard.press('Escape');
    await existingEditor.page.waitForFunction(
      () => (window as unknown as {
        __bwStudio?: { mode(): { kind: string } };
      }).__bwStudio?.mode().kind === 'idle'
        && document.getElementById('bw-welcome')?.hidden === true,
      { polling: 50, timeout: 5_000 },
    );

    await followVisibleNavigationPath(existingEditor.page, 'templates.library.existing-editor');
    coveredPathIds.push('templates.library.existing-editor');
    await clickVisibleControl(existingEditor.page, '#bw-templates-close');
    await existingEditor.page.waitForFunction(
      () => (document.getElementById('bw-templates') as HTMLDialogElement | null)?.open !== true,
      { polling: 50, timeout: 5_000 },
    );

    await followVisibleNavigationPath(existingEditor.page, 'templates.iso4017-screw.existing-editor');
    coveredPathIds.push('templates.iso4017-screw.existing-editor');
    const configuredPart = await waitForCad(existingEditor.page);
    if (configuredPart.errors.length > 0 || configuredPart.bodies !== 1 || configuredPart.validBodies !== 1) {
      throw new Error(`visible configured-part journey did not settle cleanly: ${JSON.stringify(configuredPart)}`);
    }

    await followVisibleNavigationPath(existingEditor.page, 'configurations.existing-editor');
    coveredPathIds.push('configurations.existing-editor');
    await clickVisibleControl(existingEditor.page, '#bw-configurations-close');
    await existingEditor.page.waitForFunction(
      () => (document.getElementById('bw-configurations') as HTMLDialogElement | null)?.open !== true,
      { polling: 50, timeout: 5_000 },
    );

    await followVisibleNavigationPath(existingEditor.page, 'drawing.existing-editor');
    coveredPathIds.push('drawing.existing-editor');

    await followVisibleNavigationPath(existingEditor.page, 'templates.library.existing-editor');
    await poisonTemplateLibraryFilters(existingEditor.page);
    await clickVisibleControl(existingEditor.page, '#bw-templates-close');
    await existingEditor.page.waitForFunction(
      () => (document.getElementById('bw-templates') as HTMLDialogElement | null)?.open !== true,
      { polling: 50, timeout: 5_000 },
    );

    const existingEditorPath = await followVisibleNavigationPath(
      existingEditor.page,
      'templates.exploded-turbofan.existing-editor',
    );
    coveredPathIds.push('templates.exploded-turbofan.existing-editor');
    const settled = await waitForCad(existingEditor.page);
    const runtime = await existingEditor.page.evaluate(() => {
      const studio = (window as unknown as {
        __bwStudio: {
          bodyResults(): Array<Record<string, any>>;
          errors(): string[];
          renderBodyCount(): number;
          triCount(): number;
        };
      }).__bwStudio;
      const bodyResults = studio.bodyResults();
      const rootRows = [...document.querySelectorAll<HTMLElement>('#bw-assembly-tree > .assembly-row')];
      return {
        bodyCount: bodyResults.length,
        exactBodies: bodyResults.filter((entry) =>
          !entry.error
            && entry.lastValid !== true
            && entry.geometry?.valid === true
            && entry.geometry?.brepValid === true
            && entry.geometry?.solidCount === 1
            && Number(entry.geometry?.volume) > 0).length,
        rootNames: rootRows.map((row) =>
          row.querySelector('[data-occurrence-action="select"] span')?.textContent?.trim() ?? null),
        rootItemNumbers: rootRows.map((row) => row.dataset.itemNumber ?? null),
        visibleLeafRows: document.querySelectorAll(
          '#bw-assembly-tree > .assembly-leaf-row:not([hidden])',
        ).length,
        renderedBodies: studio.renderBodyCount(),
        triangles: studio.triCount(),
        errors: studio.errors(),
        projectTitle: document.getElementById('bw-project-name')?.textContent?.trim() ?? null,
      };
    });
    if (settled.bodies !== 394 || runtime.bodyCount !== 394 || runtime.exactBodies !== 394) {
      throw new Error(`visible turbofan journey returned ${runtime.exactBodies}/${runtime.bodyCount} exact bodies`);
    }
    if (JSON.stringify(runtime.rootNames) !== JSON.stringify(expectedRootNames)) {
      throw new Error(`visible turbofan journey has the wrong numbered roots: ${JSON.stringify(runtime.rootNames)}`);
    }
    if (JSON.stringify(runtime.rootItemNumbers) !== JSON.stringify(['01', '02', '03', '04', '05', '06'])) {
      throw new Error(`visible turbofan journey has the wrong enumeration: ${JSON.stringify(runtime.rootItemNumbers)}`);
    }
    if (runtime.visibleLeafRows !== 0) {
      throw new Error(`visible turbofan journey opened with ${runtime.visibleLeafRows} expanded leaf rows`);
    }
    if (runtime.renderedBodies !== 394 || runtime.triangles <= 0) {
      throw new Error(`visible turbofan journey projected ${runtime.renderedBodies}/394 bodies and ${runtime.triangles} triangles`);
    }
    if (runtime.errors.length > 0 || runtime.projectTitle !== 'Turbofan demonstrator assembly') {
      throw new Error(`visible turbofan journey did not settle cleanly: ${JSON.stringify(runtime)}`);
    }
    const publishedPathIds = PARTMODE_UX_NAVIGATION_CONTRACT.paths.map((path) => path.id).sort();
    const testedPathIds = [...coveredPathIds].sort();
    if (JSON.stringify(testedPathIds) !== JSON.stringify(publishedPathIds)) {
      throw new Error(
        `browser navigation coverage does not match the published contract: `
          + `${JSON.stringify({ publishedPathIds, testedPathIds })}`,
      );
    }
    failForBrowserErrors(existingEditor.pageErrors, existingEditor.consoleErrors, existingEditor.networkErrors);
    return {
      coveredPathIds: testedPathIds,
      firstVisitPath,
      existingEditorPath,
      exactBodies: runtime.exactBodies,
      numberedRoots: runtime.rootNames.length,
      renderedBodies: runtime.renderedBodies,
      triangles: runtime.triangles,
    };
  } finally {
    await existingEditor.page.close();
    await existingEditor.context.close();
  }
}

async function runNightlyTemplateMatrix(page: Page): Promise<{ count: number; failures: string[] }> {
  return page.evaluate(async () => {
    const studioScript = document.querySelector<HTMLScriptElement>('script[src*="/studio.js"]');
    if (!studioScript) throw new Error('versioned Studio entrypoint is missing');
    const assetBase = new URL('.', studioScript.src).href;
    const templatesModule = await import(`${assetBase}studio-templates.js`);
    const worker = new Worker(`${assetBase}studio-kernel.worker.js`, { type: 'module' });
    const failures: string[] = [];
    let revision = 100;
    for (const template of templatesModule.STUDIO_TEMPLATES) {
      revision += 1;
      try {
        const response = await new Promise<Record<string, any>>((resolveResponse, rejectResponse) => {
          const requestId = `nightly-${revision}`;
          const timeout = setTimeout(
            () => rejectResponse(new Error(`${template.id} timed out in the CAD kernel`)),
            90_000,
          );
          const onMessage = (event: MessageEvent) => {
            if (event.data?.requestId !== requestId) return;
            clearTimeout(timeout);
            worker.removeEventListener('message', onMessage);
            if (event.data.kind === 'kernel-error') {
              rejectResponse(new Error(event.data.message || `${template.id} kernel error`));
            } else {
              resolveResponse(event.data);
            }
          };
          worker.addEventListener('message', onMessage);
          worker.postMessage({
            kind: 'rebuild',
            requestId,
            projectId: 'partmode-nightly-templates',
            revision,
            document: template.document,
          });
        });
        const hasGeometry =
          Boolean(response.mesh?.vertices?.byteLength) ||
          (Array.isArray(response.bodies) &&
            response.bodies.some((body: { geometry?: { valid?: boolean } }) => body.geometry?.valid !== false));
        if (response.errors?.length || !hasGeometry) {
          failures.push(
            `${template.id}: ${
              response.errors?.map((error: { message?: string }) => error.message).join('; ') ||
              'empty geometry'
            }`,
          );
        }
      } catch (error) {
        failures.push(`${template.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    worker.terminate();
    return { count: templatesModule.STUDIO_TEMPLATES.length, failures };
  });
}

try {
  if (!targetUrl) {
    local = await startPartModeServer({
      distDir: resolve(repositoryRoot, 'dist'),
      host: '127.0.0.1',
      port: 0,
      stateDir: resolve(temporaryDirectory, 'state'),
    });
  }
  const smokeUrl = targetUrl ?? local?.url;
  if (!smokeUrl) throw new Error('smoke URL is unavailable');

  const healthResponse = await fetch(new URL('/healthz', smokeUrl));
  if (!healthResponse.ok) throw new Error(`health check returned HTTP ${healthResponse.status}`);
  const health = await healthResponse.json() as {
    ok?: boolean;
    product?: string;
    sha?: string;
    version?: string;
  };
  if (health.ok !== true || health.product !== 'PartMode') throw new Error(`invalid health response: ${JSON.stringify(health)}`);
  if (expectedSha && health.sha !== expectedSha) {
    throw new Error(`live SHA mismatch: expected ${expectedSha}, received ${health.sha}`);
  }
  console.log(`smoke health OK: ${health.sha ?? 'unknown'}`);

  const helpApiResponse = await fetch(new URL('/api/v1/help', smokeUrl));
  if (!helpApiResponse.ok) throw new Error(`Help API returned HTTP ${helpApiResponse.status}`);
  const helpApi = await helpApiResponse.json() as {
    schema?: unknown;
    releaseSha?: unknown;
    navigation?: unknown;
  };
  if (
    helpApi.schema !== 'partmode.help/v1'
    || (expectedSha && helpApi.releaseSha !== expectedSha)
    || JSON.stringify(helpApi.navigation) !== JSON.stringify(PARTMODE_UX_NAVIGATION_CONTRACT)
  ) {
    throw new Error(`Help API navigation contract mismatch: ${JSON.stringify(helpApi)}`);
  }
  const verifiedTurbofanExistingEditorUserPath = getPartModeUxNavigationPath(
    'templates.exploded-turbofan.existing-editor',
  ).userPath;
  console.log(`smoke Help API navigation OK: ${verifiedTurbofanExistingEditorUserPath}`);

  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 300_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('bw-studio-welcome-v1', '1');
  });

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('dialog', async (dialog) => {
    pageErrors.push(`unexpected ${dialog.type()} dialog: ${dialog.message()}`);
    await dialog.dismiss();
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    networkErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) networkErrors.push(`${response.status()} ${response.url()}`);
  });

  const response = await page.goto(new URL('/', smokeUrl).href, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  if (!response || response.status() !== 200) throw new Error(`PartMode page returned HTTP ${response?.status() ?? 0}`);
  console.log('smoke page loaded');
  await page.waitForFunction(
    () => {
      const studio = (window as unknown as { __bwStudio?: { mode(): { kind: string } } }).__bwStudio;
      return studio?.mode().kind === 'idle';
    },
    { polling: 50, timeout: 90_000 },
  );
  await clickVisibleControl(page, '#bw-templates-open');
  await page.waitForSelector('#bw-templates[open] .ws-template-card', { visible: true, timeout: 20_000 });
  await clickVisibleControl(page, '#bw-template-use');
  let initial = await waitForCad(page);
  console.log(`smoke initial CAD settled: revision ${initial.appliedRevision}, ${initial.triangles} triangles`);
  const ribbonLayout = await verifyRibbonLabelLayout(page);
  console.log(`smoke ribbon labels contained: ${ribbonLayout.labels} labels across ${ribbonLayout.panels} panels`);
  const firstSolidFlow = await verifyFirstSolidFlow(browser, smokeUrl);
  console.log(`smoke first solid completed in ${firstSolidFlow.primaryActions} primary actions`);
  const pressPullFirstSolidFlow = await verifyShortViewportPressPullFlow(browser, smokeUrl);
  console.log('smoke short-viewport Press / Pull first solid completed');
  const visibleTemplateJourneys = await verifyVisibleTemplateJourneys(browser, smokeUrl);
  console.log(
    `smoke visible template journeys OK: ${visibleTemplateJourneys.exactBodies} exact turbofan bodies, `
      + `${visibleTemplateJourneys.numberedRoots} numbered roots`,
  );

  const shell = await page.evaluate(() => {
    const banner = document.getElementById('pm-cookie-banner') as HTMLElement | null;
    const essential = document.getElementById('pm-cookie-essential') as HTMLButtonElement | null;
    const beforeChoice = banner ? !banner.hidden : false;
    essential?.click();
    return {
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      release: document.querySelector('meta[name="partmode-release"]')?.getAttribute('content') ?? null,
      bannerPresent: Boolean(banner && essential),
      beforeChoice,
      afterChoice: banner?.hidden ?? false,
      agentAccess: document.getElementById('pm-agent-access')?.getAttribute('href') ?? null,
      agentAccessText: document.getElementById('pm-agent-access')?.textContent?.trim() ?? null,
      anonymousCloudTabId: sessionStorage.getItem('partmode.cloud-agent.tab-id.v1'),
    };
  });
  if (shell.canonical !== 'https://partmode.com/') throw new Error(`unexpected canonical URL: ${shell.canonical}`);
  if (expectedSha && shell.release !== expectedSha) throw new Error(`HTML release mismatch: ${shell.release}`);
  if (!shell.bannerPresent || !shell.beforeChoice) {
    throw new Error('privacy notice was not visible in a fresh browser profile');
  }
  if (!shell.afterChoice) throw new Error('privacy notice did not dismiss after the essential-only choice');
  if (shell.agentAccess !== '/account') throw new Error(`agent access link is missing: ${shell.agentAccess}`);
  if (!['Sign in', 'Account'].includes(shell.agentAccessText ?? '')) {
    throw new Error(`account authentication label is unclear: ${shell.agentAccessText}`);
  }
  if (shell.anonymousCloudTabId !== null) throw new Error('anonymous CAD created cloud relay session state');

  const auditedUsability = await verifyAuditedUsability(page);
  console.log('smoke audited usability regressions OK');

  const sketchRibbonEntry = await verifySketchRibbonEntry(page);
  console.log('smoke Sketch ribbon entry OK');

  await clickVisibleControl(page, '#bw-help-open');
  const inAppHelp = await page.evaluate(() => {
    const dialog = document.getElementById('bw-help') as HTMLDialogElement | null;
    return {
      open: Boolean(dialog?.open),
      humanHref: document.getElementById('bw-help-full')?.getAttribute('href') ?? null,
      aboutHref: document.getElementById('bw-help-about')?.getAttribute('href') ?? null,
      agentHref: document.getElementById('bw-help-agent-guide')?.getAttribute('href') ?? null,
      hasConfigurationGuidance: dialog?.textContent?.includes('Configurations and drawings') ?? false,
    };
  });
  if (
    !inAppHelp.open ||
    inAppHelp.humanHref !== '/help' ||
    inAppHelp.aboutHref !== '/about' ||
    inAppHelp.agentHref !== '/help#agents' ||
    !inAppHelp.hasConfigurationGuidance
  ) {
    throw new Error(`in-app Help is incomplete: ${JSON.stringify(inAppHelp)}`);
  }
  await clickVisibleControl(page, '#bw-help-close');

  const helpPage = await context.newPage();
  const helpResponse = await helpPage.goto(new URL('/help', smokeUrl).href, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  if (!helpResponse || helpResponse.status() !== 200) {
    throw new Error(`PartMode Help returned HTTP ${helpResponse?.status() ?? 0}`);
  }
  const fullHelp = await helpPage.evaluate(() => ({
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
    release: document.querySelector('meta[name="partmode-release"]')?.getAttribute('content') ?? null,
    topics: document.querySelectorAll('main article').length,
    invalidListChildren: document.querySelectorAll('ol > :not(li), ul > :not(li)').length,
    humanAgentRail: document.querySelector('.pm-help-rail')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    hasFreeAnswer: document.body.textContent?.includes('PartMode is free to use and is intended to remain free') ?? false,
    aboutHref: document.querySelector('.pm-help-meta a[href="/about"]')?.getAttribute('href') ?? null,
    hasAgentWorkflow: document.body.textContent?.includes('cad_capabilities') ?? false,
  }));
  if (
    fullHelp.canonical !== 'https://partmode.com/help' ||
    (expectedSha && fullHelp.release !== expectedSha) ||
    fullHelp.topics !== 4 ||
    fullHelp.invalidListChildren !== 0 ||
    !fullHelp.humanAgentRail.includes('HUMAN') ||
    !fullHelp.humanAgentRail.includes('AGENT') ||
    !fullHelp.hasFreeAnswer ||
    fullHelp.aboutHref !== '/about' ||
    !fullHelp.hasAgentWorkflow
  ) {
    throw new Error(`full Help is incomplete: ${JSON.stringify(fullHelp)}`);
  }
  await helpPage.close();

  const aboutPage = await context.newPage();
  const aboutResponse = await aboutPage.goto(new URL('/about', smokeUrl).href, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  if (!aboutResponse || aboutResponse.status() !== 200) {
    throw new Error(`PartMode About returned HTTP ${aboutResponse?.status() ?? 0}`);
  }
  const about = await aboutPage.evaluate(() => {
    const bodyText = document.body.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const creator = document.querySelector('a[href="https://x.com/protosphinx"]');
    return {
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      release: document.querySelector('meta[name="partmode-release"]')?.getAttribute('content') ?? null,
      creatorText: creator?.textContent?.trim() ?? null,
      freeByIntent: bodyText.includes('PartMode is free to use and is intended to remain free'),
      privateIdentityVisible: /(?:founder|@protosphinx)/iu.test(bodyText),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  if (
    about.canonical !== 'https://partmode.com/about' ||
    (expectedSha && about.release !== expectedSha) ||
    about.creatorText !== 'Sphinx' ||
    !about.freeByIntent ||
    about.privateIdentityVisible ||
    about.horizontalOverflow
  ) {
    throw new Error(`About page is incomplete: ${JSON.stringify(about)}`);
  }
  await aboutPage.close();

  const consentCookies = (await context.cookies()).filter(
    (cookie) => cookie.name === 'partmode_cookie_consent',
  );
  const consentCookie = consentCookies[0];
  if (
    consentCookies.length !== 1 ||
    !consentCookie ||
    consentCookie.value !== 'essential-v1' ||
    consentCookie.path !== '/' ||
    consentCookie.sameSite !== 'Lax' ||
    consentCookie.httpOnly ||
    consentCookie.secure !== smokeUrl.startsWith('https://') ||
    consentCookie.expires < Date.now() / 1000 + 60 * 60 * 24 * 170
  ) {
    throw new Error(`invalid stored cookie preference: ${JSON.stringify(consentCookies)}`);
  }
  const unexpectedCookies = (await context.cookies()).filter(
    (cookie) => cookie.name !== 'partmode_cookie_consent',
  );
  if (unexpectedCookies.length > 0) {
    throw new Error(`unexpected optional or tracking cookies: ${JSON.stringify(unexpectedCookies)}`);
  }

  const reloadResponse = await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (!reloadResponse || reloadResponse.status() !== 200) {
    throw new Error(`PartMode reload returned HTTP ${reloadResponse?.status() ?? 0}`);
  }
  initial = await waitForCad(page);
  const bannerHiddenAfterReload = await page.evaluate(() => {
    const banner = document.getElementById('pm-cookie-banner') as HTMLElement | null;
    return Boolean(banner?.hidden);
  });
  if (!bannerHiddenAfterReload) throw new Error('stored cookie preference did not survive reload');

  const cookiesPage = await context.newPage();
  const cookiesResponse = await cookiesPage.goto(new URL('/cookies', smokeUrl).href, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  if (!cookiesResponse || cookiesResponse.status() !== 200) {
    throw new Error(`cookie settings returned HTTP ${cookiesResponse?.status() ?? 0}`);
  }
  const cookieControls = await cookiesPage.evaluate(() => ({
    status: document.getElementById('pm-cookie-status')?.textContent ?? '',
    reset: Boolean(document.getElementById('pm-cookie-reset')),
    essential: Boolean(document.querySelector('[data-cookie-essential]')),
    inventory: document.body.textContent?.includes('partmode_cookie_consent') ?? false,
  }));
  if (
    !cookieControls.status.includes('essential storage only') ||
    !cookieControls.reset ||
    !cookieControls.essential ||
    !cookieControls.inventory
  ) {
    throw new Error(`cookie settings are incomplete: ${JSON.stringify(cookieControls)}`);
  }
  await clickVisibleControl(cookiesPage, '#pm-cookie-reset');
  await cookiesPage.waitForFunction(
    () => document.getElementById('pm-cookie-status')?.textContent?.includes('No cookie choice is stored.'),
    { polling: 50, timeout: 5_000 },
  );
  if ((await context.cookies()).some((cookie) => cookie.name === 'partmode_cookie_consent')) {
    throw new Error('cookie reset control did not remove the stored choice');
  }
  await clickVisibleControl(cookiesPage, '[data-cookie-essential]');
  await cookiesPage.waitForFunction(
    () => document.getElementById('pm-cookie-status')?.textContent?.includes('essential storage only'),
    { polling: 50, timeout: 5_000 },
  );
  if ((await context.cookies()).filter((cookie) => cookie.name === 'partmode_cookie_consent').length !== 1) {
    throw new Error('cookie settings did not restore the essential-only choice');
  }
  await cookiesPage.close();
  console.log('smoke cookie preference and settings OK');

  const input = await page.$('#bw-open-file') as ElementHandle<HTMLInputElement> | null;
  if (!input) throw new Error('project file input is missing');
  await input.uploadFile(uploadedFixture);
  console.log('smoke canonical fixture opened');
  const fixture = await waitForCad(page, initial);
  console.log(`smoke canonical CAD settled: revision ${fixture.appliedRevision}, ${fixture.bodies} bodies`);

  if (fixture.runtimeVersion !== '8.0.0') throw new Error(`unexpected CAD runtime ${fixture.runtimeVersion}`);
  if (fixture.documentRevision !== fixture.appliedRevision) {
    throw new Error(`revision mismatch: document ${fixture.documentRevision}, applied ${fixture.appliedRevision}`);
  }
  if (fixture.bodies !== 3 || fixture.validBodies !== 3) {
    throw new Error(`canonical fixture returned ${fixture.validBodies}/${fixture.bodies} valid bodies`);
  }
  if (fixture.errors.length > 0) throw new Error(`CAD errors: ${fixture.errors.join('; ')}`);
  if (fixture.triangles <= 0) throw new Error('canonical fixture produced no triangles');

  const nightlyMatrix = nightly ? await runNightlyTemplateMatrix(page) : undefined;
  if (nightlyMatrix?.failures.length) {
    throw new Error(`nightly template failures\n${nightlyMatrix.failures.join('\n')}`);
  }
  failForBrowserErrors(pageErrors, consoleErrors, networkErrors);

  console.log(JSON.stringify({
    ok: true,
    url: smokeUrl,
    health,
    initial: {
      documentRevision: initial.documentRevision,
      appliedRevision: initial.appliedRevision,
      bodies: initial.bodies,
      triangles: initial.triangles,
    },
    canonicalFixture: fixture,
    firstSolidFlow,
    pressPullFirstSolidFlow,
    visibleTemplateJourneys,
    verifiedTurbofanExistingEditorUserPath,
    errors: {
      page: pageErrors.length,
      console: consoleErrors.length,
      network: networkErrors.length,
    },
    cookieConsent: {
      name: consentCookie.name,
      value: consentCookie.value,
      sameSite: consentCookie.sameSite,
      secure: consentCookie.secure,
      optionalCookies: unexpectedCookies.length,
    },
    sketchRibbonEntry,
    auditedUsability,
    ...(nightlyMatrix ? { nightlyTemplates: nightlyMatrix.count } : {}),
  }));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
