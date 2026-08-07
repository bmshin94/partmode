import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type BrowserContext, type Page } from 'puppeteer';
import {
  startPartModeServer,
  type RunningPartModeServer,
} from '../src/server.js';

type JsonRecord = Record<string, unknown>;

interface BrowserFailures {
  page: string[];
  console: string[];
  network: string[];
}

interface CadState {
  revision: number;
  triangles: number;
  errors: string[];
  agentProtocol: string;
}

const MCP_PROTOCOL = '2025-11-25';
const CAD_PROTOCOL = 'partmode.cad.agent/v1';
const VISIBLE_UI_PROFILE = 'partmode.cad.visible-projection/v1';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-cloud-bridge-smoke-'));
const suffix = randomBytes(6).toString('hex');
const accountName = `bridge-${suffix}`;
const passphrase = `PartMode cloud bridge smoke ${suffix}`;

let rpcSequence = 0;
let running: RunningPartModeServer | undefined;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
let connectAbort: AbortController | undefined;

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Cloud bridge smoke failed: ${name}`);
}

function record(value: unknown, name: string): JsonRecord {
  check(name, Boolean(value) && typeof value === 'object' && !Array.isArray(value));
  return value as JsonRecord;
}

function array(value: unknown, name: string): unknown[] {
  check(name, Array.isArray(value));
  return value;
}

function string(value: unknown, name: string): string {
  check(name, typeof value === 'string' && value.length > 0);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function activateVisibleControl(
  page: Page,
  selector: string,
): Promise<void> {
  const control = await page.$(selector);
  check(`${selector} exists`, control);
  try {
    const state = await control.evaluate((element) => ({
      connected: element.isConnected,
      disabled: element instanceof HTMLButtonElement && element.disabled,
      ariaDisabled: element.getAttribute('aria-disabled'),
    }));
    check(`${selector} is connected`, state.connected);
    check(`${selector} is enabled`, state.disabled === false && state.ariaDisabled !== 'true');
    await control.evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    });
    const bounds = await control.boundingBox();
    check(`${selector} has visible bounds`, bounds && bounds.width > 0 && bounds.height > 0);
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const ownsHitTarget = await control.evaluate((element, point) => {
      const target = document.elementFromPoint(point.x, point.y);
      return Boolean(target && (target === element || element.contains(target)));
    }, center);
    check(`${selector} owns its center hit target`, ownsHitTarget);
    await page.mouse.click(center.x, center.y);
  } finally {
    await control.dispose();
  }
}

async function approveVisibleAgentDialog(page: Page): Promise<void> {
  const selector = '#bw-agent-connect [data-v6-control-id="app.agent.connection-approve"]';
  const control = await page.$(selector);
  check(`${selector} exists`, control);
  try {
    const state = await control.evaluate((element) => ({
      connected: element.isConnected,
      disabled: element instanceof HTMLButtonElement && element.disabled,
      ariaDisabled: element.getAttribute('aria-disabled'),
    }));
    check(`${selector} is connected`, state.connected);
    check(`${selector} is enabled`, state.disabled === false && state.ariaDisabled !== 'true');
    await control.evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    });
    const bounds = await control.boundingBox();
    check(`${selector} has visible bounds`, bounds && bounds.width > 0 && bounds.height > 0);
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const ownsHitTarget = await control.evaluate((element, point) => {
      const target = document.elementFromPoint(point.x, point.y);
      return Boolean(target && (target === element || element.contains(target)));
    }, center);
    check(`${selector} owns its center hit target`, ownsHitTarget);
    const focused = await control.evaluate((element) => {
      if (!(element instanceof HTMLElement)) return false;
      element.focus({ preventScroll: true });
      return document.activeElement === element;
    });
    check(`${selector} owns activeElement`, focused);
    await page.keyboard.press('Enter');

    // Chrome for Testing 148 in headless mode applies the dialog button's
    // trusted default action (closed with returnValue=approve) but can omit the
    // queued close event. Give the natural once-only handler a bounded turn;
    // dispatch only that omitted event if the dialog is still attached.
    await delay(100);
    const dialogState = await control.evaluate((element) => {
      const dialog = element.closest('dialog');
      return dialog instanceof HTMLDialogElement
        ? { present: true, connected: dialog.isConnected, open: dialog.open, returnValue: dialog.returnValue }
        : { present: false, connected: false, open: false, returnValue: '' };
    });
    check('approval control belongs to the agent dialog', dialogState.present);
    check('trusted approval closes the agent dialog', dialogState.open === false);
    check('trusted approval returns approve', dialogState.returnValue === 'approve');
    if (dialogState.connected) {
      await control.evaluate((element) => {
        const dialog = element.closest('dialog');
        if (!(dialog instanceof HTMLDialogElement)) {
          throw new TypeError('The approval control no longer belongs to a dialog.');
        }
        dialog.dispatchEvent(new Event('close'));
      });
    }
  } finally {
    await control.dispose();
  }
}

async function closeServer(server: RunningPartModeServer | undefined): Promise<void> {
  if (!server?.server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

function attachBrowserFailureCapture(page: Page): BrowserFailures {
  const failures: BrowserFailures = { page: [], console: [], network: [] };
  page.on('pageerror', (error) => failures.page.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.console.push(message.text());
  });
  page.on('requestfailed', (request) => {
    failures.network.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failures.network.push(`${response.status()} ${response.url()}`);
  });
  return failures;
}

function assertNoBrowserFailures(failures: BrowserFailures): void {
  const messages = [
    ...failures.page.map((value) => `page: ${value}`),
    ...failures.console.map((value) => `console: ${value}`),
    ...failures.network.map((value) => `network: ${value}`),
  ];
  check(`no browser, console, or network errors\n${messages.join('\n')}`, messages.length === 0);
}

async function waitForCad(page: Page, requireGeometry = true): Promise<CadState> {
  try {
    await page.waitForFunction(
      (mustHaveGeometry) => {
        const candidate = window as unknown as {
          __bwStudio?: {
            appliedRevision(): number;
            documentRevision(): number;
            errors(): string[];
            mode(): { kind: string };
            triCount(): number;
          };
          partmodeAgent?: { protocol?: string };
        };
        const studio = candidate.__bwStudio;
        if (
          !studio ||
          studio.mode().kind !== 'idle' ||
          studio.appliedRevision() !== studio.documentRevision() ||
          candidate.partmodeAgent?.protocol !== 'partmode.cad.agent/v1'
        ) return false;
        return !mustHaveGeometry || studio.triCount() > 0 || studio.errors().length > 0;
      },
      { polling: 100, timeout: 90_000 },
      requireGeometry,
    );
  } catch (error) {
    const snapshot = await page.evaluate(() => {
      const candidate = window as unknown as {
        __bwStudio?: {
          appliedRevision(): number;
          documentRevision(): number;
          errors(): string[];
          mode(): { kind: string };
          modeLog(): unknown[];
          triCount(): number;
        };
        partmodeAgent?: {
          protocol?: string;
          status?(): unknown;
        };
      };
      const studio = candidate.__bwStudio;
      return {
        studioPresent: Boolean(studio),
        mode: studio?.mode() ?? null,
        modeLog: studio?.modeLog() ?? [],
        triangles: studio?.triCount() ?? null,
        appliedRevision: studio?.appliedRevision() ?? null,
        documentRevision: studio?.documentRevision() ?? null,
        errors: studio?.errors() ?? [],
        agentProtocol: candidate.partmodeAgent?.protocol ?? null,
        agentStatus: candidate.partmodeAgent?.status?.() ?? null,
      };
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CAD did not settle: ${message}; snapshot=${JSON.stringify(snapshot)}`, { cause: error });
  }
  const settled = await page.evaluate(() => {
    const candidate = window as unknown as {
      __bwStudio: {
        appliedRevision(): number;
        errors(): string[];
        triCount(): number;
      };
      partmodeAgent: { protocol: string };
    };
    return {
      revision: candidate.__bwStudio.appliedRevision(),
      triangles: candidate.__bwStudio.triCount(),
      errors: candidate.__bwStudio.errors(),
      agentProtocol: candidate.partmodeAgent.protocol,
    };
  });
  check(`CAD settled without feature errors: ${settled.errors.join('; ')}`, settled.errors.length === 0);
  if (requireGeometry) check('CAD settled with rendered triangles', settled.triangles > 0);
  return settled;
}

async function parseJsonResponse(response: Response, name: string): Promise<JsonRecord> {
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Cloud bridge smoke failed: ${name} returned non-JSON HTTP ${response.status}`);
  }
  return record(value, `${name} returned a JSON object`);
}

async function mcpRequest(
  origin: string,
  rawKey: string,
  method: string,
  params: JsonRecord = {},
  signal?: AbortSignal,
): Promise<JsonRecord> {
  rpcSequence += 1;
  const response = await fetch(new URL('/mcp', origin), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${rawKey}`,
      'content-type': 'application/json',
      'mcp-protocol-version': MCP_PROTOCOL,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `cloud-bridge-smoke-${rpcSequence}`,
      method,
      params,
    }),
    signal: signal ?? AbortSignal.timeout(130_000),
  });
  const body = await parseJsonResponse(response, method);
  check(`${method} returns HTTP 200`, response.status === 200);
  return body;
}

async function callTool(
  origin: string,
  rawKey: string,
  name: string,
  args: JsonRecord,
  signal?: AbortSignal,
): Promise<JsonRecord> {
  const response = await mcpRequest(origin, rawKey, 'tools/call', {
    name,
    arguments: args,
  }, signal);
  const rpcResult = record(response.result, `${name} returns a JSON-RPC result`);
  check(`${name} is not a tool error: ${JSON.stringify(rpcResult)}`, rpcResult.isError === false);
  return record(rpcResult.structuredContent, `${name} returns structured content`);
}

async function callToolError(
  origin: string,
  rawKey: string,
  name: string,
  args: JsonRecord,
): Promise<string> {
  const response = await mcpRequest(origin, rawKey, 'tools/call', {
    name,
    arguments: args,
  });
  const rpcResult = record(response.result, `${name} error returns a JSON-RPC result`);
  check(`${name} returns a typed tool error`, rpcResult.isError === true);
  const structured = record(rpcResult.structuredContent, `${name} error returns structured content`);
  const error = record(structured.error, `${name} error includes details`);
  return string(error.code, `${name} error includes a code`);
}

async function waitForOnlineStudio(origin: string, rawKey: string): Promise<JsonRecord> {
  const deadline = Date.now() + 60_000;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const result = await callTool(origin, rawKey, 'partmode_list_studios', {});
    const studios = array(result.studios, 'studio discovery returns an array');
    lastCount = studios.length;
    if (studios.length === 1) return record(studios[0], 'studio discovery returns one studio');
    await delay(250);
  }
  throw new Error(`Cloud bridge smoke failed: expected one online studio, received ${lastCount}`);
}

async function runWrongSessionRegression(
  context: BrowserContext,
  origin: string,
  assetVersion: string,
): Promise<{ requestToolCalls: number; disconnectCalls: number; responseCode: string }> {
  const page = await context.newPage();
  try {
    const response = await page.goto(new URL('/account', origin).href, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    check('wrong-session harness loads from the built server', response?.status() === 200);
    const bridgeUrl = new URL(`/assets/${assetVersion}/studio-cloud-agent-bridge.js`, origin).href;
    const result = await page.evaluate(async (moduleUrl) => {
      const originalFetch = window.fetch;
      const responses: Array<Record<string, unknown>> = [];
      let pollCount = 0;
      let requestToolCalls = 0;
      let disconnectCalls = 0;

      const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });

      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        const url = new URL(rawUrl, window.location.href);
        if (url.pathname === '/api/v1/account') {
          return jsonResponse({ authenticated: true, csrfToken: 'c'.repeat(43) });
        }
        if (url.pathname === '/api/v1/studios/register') {
          return jsonResponse({ studioId: 'studio_synthetic', studioToken: 'synthetic-studio-token' }, 201);
        }
        if (url.pathname === '/api/v1/studios/respond') {
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
          responses.push(body);
          return jsonResponse({ accepted: true });
        }
        if (url.pathname === '/api/v1/studios/poll') {
          pollCount += 1;
          if (pollCount === 1) {
            return jsonResponse({
              events: [{
                type: 'connection.request',
                requestId: 'approval_synthetic1234',
                sessionId: 'session_expected',
                clientLabel: 'Synthetic regression',
                mode: 'read-only',
                permissionContext: { granted: ['project.read'], maxCommits: 0 },
                skillVersion: 'cloud-smoke',
                uiProfile: 'partmode.cad.visible-projection/v1',
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              }],
              pollAfterMs: 0,
            });
          }
          if (pollCount === 2) {
            return jsonResponse({
              events: [{
                type: 'tool.request',
                requestId: 'tool_synthetic1234',
                sessionId: 'session_wrong',
                tool: 'cad_capabilities',
                args: {},
              }],
              pollAfterMs: 0,
            });
          }
          return jsonResponse({ error: 'REGRESSION_COMPLETE' }, 410);
        }
        return jsonResponse({ error: 'UNEXPECTED_REQUEST' }, 404);
      }) as typeof window.fetch;

      try {
        const bridge = await import(moduleUrl) as {
          startStudioCloudAgentBridge(agent: unknown): Promise<void>;
        };
        const agent = {
          protocol: 'partmode.cad.agent/v1',
          requestConnection: async (options: Record<string, unknown>) => ({
            protocol: 'partmode.cad.agent/v1',
            sessionId: options.sessionId,
            connectionToken: 'synthetic-connection-token',
            permissionContext: options.permissionContext,
            mode: options.mode,
            uiProfile: options.uiProfile,
          }),
          requestTool: async () => {
            requestToolCalls += 1;
            return { shouldNotRun: true };
          },
          disconnect: () => {
            disconnectCalls += 1;
            return true;
          },
        };
        await bridge.startStudioCloudAgentBridge(agent);
      } finally {
        window.fetch = originalFetch;
      }

      const wrongResponse = responses.find((entry) => entry.requestId === 'tool_synthetic1234');
      const error = wrongResponse?.error && typeof wrongResponse.error === 'object'
        ? wrongResponse.error as Record<string, unknown>
        : {};
      return {
        requestToolCalls,
        disconnectCalls,
        responseCode: typeof error.code === 'string' ? error.code : '',
      };
    }, bridgeUrl);

    check('wrong-session event never calls the sole connected tool target', result.requestToolCalls === 0);
    check('wrong-session event returns SESSION_NOT_FOUND', result.responseCode === 'SESSION_NOT_FOUND');
    check('synthetic bridge shuts down its synthetic connection', result.disconnectCalls === 1);
    return result;
  } finally {
    await page.close();
  }
}

try {
  running = await startPartModeServer({
    distDir: resolve(repositoryRoot, 'dist'),
    host: '127.0.0.1',
    port: 0,
    stateDir: resolve(temporaryDirectory, 'state'),
  });
  const origin = running.url;

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
  const failures = attachBrowserFailureCapture(page);

  const anonymousResponse = await page.goto(new URL('/', origin).href, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  check('anonymous CAD route returns HTTP 200', anonymousResponse?.status() === 200);
  const anonymousCad = await waitForCad(page, false);
  check('anonymous CAD opens a clean current project', anonymousCad.triangles === 0 && anonymousCad.errors.length === 0);
  await activateVisibleControl(page, '#bw-templates-open');
  await page.waitForSelector('#bw-templates[open] .ws-template-card', { visible: true, timeout: 20_000 });
  await activateVisibleControl(page, '#bw-template-use');
  const templatedCad = await waitForCad(page);
  check('anonymous template selection produces exact rendered geometry', templatedCad.triangles > 0 && templatedCad.errors.length === 0);
  const anonymousAuthCookies = (await context.cookies()).filter(
    (cookie) => cookie.name === 'partmode_account_dev' || cookie.name === '__Host-partmode_account',
  );
  check('anonymous CAD creates no account authentication cookie', anonymousAuthCookies.length === 0);
  const anonymousTabId = await page.evaluate(() => sessionStorage.getItem('partmode.cloud-agent.tab-id.v1'));
  check('anonymous CAD does not register cloud relay state', anonymousTabId === null);

  const accountResponse = await page.goto(new URL('/account', origin).href, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  check('account route returns HTTP 200', accountResponse?.status() === 200);
  await page.waitForSelector('#pm-signup-form', { visible: true, timeout: 10_000 });
  await page.type('#pm-signup-form input[name="name"]', accountName);
  await page.type('#pm-signup-form input[name="password"]', passphrase);
  await activateVisibleControl(page, '#pm-signup-form button[type="submit"]');
  await page.waitForFunction(
    () => {
      const dashboard = document.getElementById('pm-dashboard') as HTMLElement | null;
      return Boolean(dashboard && !dashboard.hidden);
    },
    { polling: 50, timeout: 20_000 },
  );

  await page.type('#pm-key-form input[name="label"]', 'Cloud bridge browser smoke');
  await page.select('#pm-key-form select[name="access"]', 'edit');
  await activateVisibleControl(page, '#pm-key-form button[type="submit"]');
  await page.waitForFunction(
    () => {
      const panel = document.getElementById('pm-key-secret') as HTMLElement | null;
      const value = document.getElementById('pm-key-secret-value')?.textContent?.trim() ?? '';
      return Boolean(panel && !panel.hidden && /^pmak_v1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(value));
    },
    { polling: 50, timeout: 20_000 },
  );
  const rawKey = await page.$eval('#pm-key-secret-value', (element) => element.textContent?.trim() ?? '');
  check('visible account UI returns one well-formed key', /^pmak_v1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(rawKey));
  const secretPersisted = await page.evaluate((secret) => {
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key && (key.includes(secret) || storage.getItem(key)?.includes(secret))) return true;
      }
    }
    return false;
  }, rawKey);
  check('one-time key is not persisted in localStorage or sessionStorage', secretPersisted === false);
  const accountCookies = (await context.cookies()).filter(
    (cookie) => cookie.name === 'partmode_account_dev' || cookie.name === '__Host-partmode_account',
  );
  check(
    'visible signup creates one HttpOnly account cookie',
    accountCookies.length === 1 && accountCookies[0]?.httpOnly === true,
  );

  const studioResponse = await page.goto(new URL('/', origin).href, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  check('signed-in CAD route returns HTTP 200', studioResponse?.status() === 200);
  const cadBefore = await waitForCad(page);
  check('key secret leaves the DOM after account navigation', !(await page.content()).includes(rawKey));

  const initialize = await mcpRequest(origin, rawKey, 'initialize', {
    protocolVersion: MCP_PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'PartMode cloud bridge smoke', version: '1.0.0' },
  });
  const initializeResult = record(initialize.result, 'MCP initialize returns a result');
  check('MCP initialize negotiates the current protocol', initializeResult.protocolVersion === MCP_PROTOCOL);

  const onlineStudio = await waitForOnlineStudio(origin, rawKey);
  const studioId = string(onlineStudio.studioId, 'online studio has an opaque ID');
  check('online Studio uses the real CAD protocol', onlineStudio.protocol === CAD_PROTOCOL);
  check('online Studio is available before approval', onlineStudio.available === true);

  connectAbort = new AbortController();
  let connectFailure: unknown;
  const connectPromise = callTool(origin, rawKey, 'partmode_connect', {
    studioId,
    clientLabel: 'Cloud bridge smoke agent',
    mode: 'read-only',
    permissions: ['project.read', 'artifact.export-amf', 'artifact.export-3mf', 'artifact.export-drawing'],
    maxCommits: 0,
    sessionSeconds: 120,
    uiProfile: VISIBLE_UI_PROFILE,
  }, connectAbort.signal).catch((error: unknown) => {
    connectFailure = error;
    return null;
  });

  try {
    await page.waitForSelector('#bw-agent-connect', { visible: true, timeout: 20_000 });
    const approval = await page.$eval('#bw-agent-connect', (element) => ({
      id: element.id,
      open: element instanceof HTMLDialogElement && element.open,
      text: element.textContent ?? '',
    }));
    check('real #bw-agent-connect dialog is open', approval.id === 'bw-agent-connect' && approval.open);
    check('approval dialog names the requesting agent', approval.text.includes('Cloud bridge smoke agent'));
    check('approval dialog shows read-only authority', approval.text.includes('Read only'));
    await approveVisibleAgentDialog(page);
  } catch (error) {
    connectAbort.abort();
    throw error;
  }

  const connected = await connectPromise;
  if (!connected) throw connectFailure ?? new Error('Cloud bridge smoke failed: connect did not return a session');
  const sessionId = string(connected.sessionId, 'browser-approved connect returns a session ID');
  check('browser approval preserves read-only mode', connected.mode === 'read-only');
  check('browser approval grants zero commits', connected.maxCommits === 0 && connected.remainingCommits === 0);
  await page.waitForFunction(
    (expectedSessionId) => {
      const agent = (window as unknown as {
        partmodeAgent?: { status(): { connected?: boolean; sessionId?: string } };
      }).partmodeAgent;
      const status = agent?.status();
      return status?.connected === true && status.sessionId === expectedSessionId;
    },
    { polling: 50, timeout: 10_000 },
    sessionId,
  );
  const cadConnected = await waitForCad(page);

  const wrongSessionCode = await callToolError(origin, rawKey, 'cad_capabilities', {
    sessionId: 'session_not_browser_approved',
  });
  check('HTTP MCP rejects a fabricated browser session', wrongSessionCode === 'SESSION_NOT_FOUND');

  const capabilities = await callTool(origin, rawKey, 'cad_capabilities', { sessionId, detail: 'summary' });
  check('real browser capability response uses the CAD protocol', capabilities.protocolVersion === CAD_PROTOCOL);
  check('real browser capability response uses V8 visible projection', capabilities.studioVersion === '8.0.0');
  check(
    'real browser capability response identifies the exact kernel runtime',
    capabilities.kernelVersion === 'replicad-open-cascade/runtime-5A',
  );
  const topologyQuery = array(capabilities.queries, 'capability manifest lists queries')
    .map((entry, index) => record(entry, `capability query ${index} is an object`))
    .find((entry) => entry.kind === 'geometry.topology');
  check('exact topology query is available', topologyQuery?.state === 'available');
  const exports = array(capabilities.exports, 'capability manifest lists exports')
    .map((entry, index) => record(entry, `capability export ${index} is an object`));
  check(
    'exact and named-mesh CAD exports are available',
    ['step', 'stl', 'amf', '3mf'].every((format) => exports.some((entry) => entry.format === format && entry.state === 'available')),
  );

  for (const expected of [
    { format: 'amf', mediaType: 'application/x-amf', prefix: '<?xml version="1.0" encoding="UTF-8"?><amf unit="millimeter"' },
    { format: '3mf', mediaType: 'model/3mf', prefix: '' },
  ]) {
    const artifact = await callTool(origin, rawKey, 'cad_artifact', { sessionId, format: expected.format });
    const bytes = Buffer.from(string(artifact.dataBase64, `${expected.format} artifact returns base64 data`), 'base64');
    check(`${expected.format} artifact format is exact`, artifact.format === expected.format);
    check(`${expected.format} artifact MIME type is exact`, artifact.mediaType === expected.mediaType);
    const signature = expected.format === '3mf'
      ? Buffer.from([0x50, 0x4b, 0x03, 0x04])
      : Buffer.from(expected.prefix, 'utf8');
    check(`${expected.format} artifact bytes have the expected signature`,
      bytes.subarray(0, signature.byteLength).equals(signature));
    const manifest = record(artifact.manifest, `${expected.format} artifact returns a manifest`);
    check(`${expected.format} agent artifact preserves millimetre units and named bodies`,
      manifest.units === 'mm' && Array.isArray(manifest.names) && manifest.names.length > 0);
  }

  const drawing = await callTool(origin, rawKey, 'cad_artifact', {
    sessionId,
    format: 'drawing-svg',
  });
  const drawingBase64 = string(drawing.dataBase64, 'drawing artifact returns base64 data');
  const drawingBytes = Buffer.from(drawingBase64, 'base64');
  const drawingManifest = record(drawing.manifest, 'drawing artifact returns a manifest');
  const drawingEvidence = record(
    drawingManifest.exactProjectionEvidence,
    'drawing manifest carries exact projection evidence',
  );
  check(
    'hosted MCP returns a complete exact SVG drawing artifact',
    drawing.phase === 'generated' &&
      drawing.format === 'drawing-svg' &&
      drawing.mediaType === 'image/svg+xml' &&
      drawing.bytes === drawingBytes.byteLength &&
      drawingBytes.byteLength > 1_000 &&
      drawing.sha256 === createHash('sha256').update(drawingBytes).digest('hex') &&
      drawingBytes.toString('utf8', 0, 128).includes('<svg') &&
      drawingManifest.kind === 'drawing-sheet' &&
      drawingEvidence.kind === 'occt-hlr-exact',
  );

  const disconnected = await callTool(origin, rawKey, 'partmode_disconnect', { sessionId });
  check('MCP disconnect acknowledges the live session', disconnected.disconnected === true);
  await page.waitForFunction(
    () => {
      const agent = (window as unknown as {
        partmodeAgent?: { status(): { connected?: boolean } };
      }).partmodeAgent;
      return agent?.status().connected === false;
    },
    { polling: 50, timeout: 10_000 },
  );
  const cadAfter = await waitForCad(page);
  check('read-only capability flow does not mutate the connected CAD revision', cadAfter.revision === cadConnected.revision);

  const regressionContext = await browser.createBrowserContext();
  const wrongSessionRegression = await runWrongSessionRegression(
    regressionContext,
    origin,
    running.release.assetVersion,
  );
  await regressionContext.close();

  assertNoBrowserFailures(failures);
  console.log(JSON.stringify({
    ok: true,
    anonymous: {
      authCookies: anonymousAuthCookies.length,
      cloudTabId: anonymousTabId,
      revision: anonymousCad.revision,
    },
    account: {
      visibleSignup: true,
      oneTimeKeyCaptured: true,
      secretPersisted: false,
    },
    relay: {
      studioId,
      sessionId,
      approvalDialog: '#bw-agent-connect',
      connectionRevision: cadConnected.revision,
      revisionBeforeConnection: cadBefore.revision,
      disconnected: true,
    },
    capabilities: {
      protocolVersion: capabilities.protocolVersion,
      studioVersion: capabilities.studioVersion,
      kernelVersion: capabilities.kernelVersion,
      topologyQuery: topologyQuery?.state,
    },
    drawing: {
      format: drawing.format,
      bytes: drawingBytes.byteLength,
      sha256: drawing.sha256,
      exactEvidence: drawingEvidence.kind,
    },
    wrongSessionRegression,
    errors: {
      page: failures.page.length,
      console: failures.console.length,
      network: failures.network.length,
    },
  }));
} finally {
  connectAbort?.abort();
  await browser?.close();
  await closeServer(running);
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
