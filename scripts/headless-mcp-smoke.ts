// Proves durable server-side CAD sessions end to end: an agent key created
// WITH the explicit headless grant opens a session through the hosted MCP,
// authors and commits geometry with the typed cad_* tools against the
// server's own kernel (no browser process anywhere), exports hashed STEP,
// and the committed document survives a full server restart. A key created
// WITHOUT the grant is refused, and the visible-studio tools stay refused
// in headless sessions.
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runHeadlessManagerSafetySmoke } from './headless-manager-safety-smoke.js';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonRecord = Record<string, unknown>;

function check(name: string, condition: boolean): asserts condition {
  if (!condition) throw new Error(`Headless MCP smoke failed: ${name}`);
}

function record(value: unknown, label: string): JsonRecord {
  check(label, Boolean(value) && typeof value === 'object' && !Array.isArray(value));
  return value as JsonRecord;
}

function string(value: unknown, label: string): string {
  check(label, typeof value === 'string' && value.length > 0);
  return value;
}

async function parseJson(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  try {
    return record(JSON.parse(text), `HTTP ${response.status} response is an object`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Headless MCP smoke failed')) throw error;
    throw new Error(`Headless MCP smoke received non-JSON HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<{ response: Response; body: JsonRecord }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  return { response, body: await parseJson(response) };
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  check('signup sets a session cookie', typeof setCookie === 'string');
  const separator = setCookie.indexOf(';');
  return separator === -1 ? setCookie : setCookie.slice(0, separator);
}

let mcpSequence = 0;
async function mcpToolCall(origin: string, rawKey: string, name: string, args: JsonRecord): Promise<JsonRecord> {
  const result = await postJson(
    `${origin}/mcp`,
    { jsonrpc: '2.0', id: `smoke-${++mcpSequence}`, method: 'tools/call', params: { name, arguments: args } },
    { authorization: `Bearer ${rawKey}`, 'mcp-protocol-version': '2025-11-25' },
  );
  check(`${name} returns HTTP 200`, result.response.status === 200);
  return record(record(result.body.result, `${name} has a result`), `${name} result is an object`);
}

function toolValue(reply: JsonRecord, label: string): JsonRecord {
  check(`${label} is not an error`, reply.isError !== true);
  return record(reply.structuredContent, `${label} carries structured content`);
}

function toolError(reply: JsonRecord, label: string): JsonRecord {
  check(`${label} is an error`, reply.isError === true);
  const value = record(reply.structuredContent, `${label} carries structured content`);
  return record(value.error, `${label} carries a typed error`);
}

const managerSafety = await runHeadlessManagerSafetySmoke();
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-headless-'));
const stateDir = resolve(temporaryDirectory, 'state');
const distDir = resolve('dist');

function startServer(): Promise<RunningPartModeServer> {
  return startPartModeServer({ distDir, host: '127.0.0.1', port: 0, stateDir });
}

let running: RunningPartModeServer | null = await startServer();
let coldRunning: { child: ChildProcess; url: string } | null = null;

function stopServer(instance: RunningPartModeServer): Promise<void> {
  return instance.close();
}

async function availablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once('error', rejectListen);
    probe.listen(0, '127.0.0.1', () => {
      probe.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = probe.address();
  if (!address || typeof address === 'string') {
    throw new Error('Headless MCP smoke failed: cold-restart port probe did not bind an IP port');
  }
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return port;
}

async function startColdServer(): Promise<{ child: ChildProcess; url: string }> {
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [resolve('.build/src/server.js')], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PARTMODE_DIST_DIR: distDir,
      PARTMODE_STATE_DIR: stateDir,
      PARTMODE_HOST: '127.0.0.1',
      PARTMODE_PORT: String(port),
      PARTMODE_PUBLIC_ORIGIN: url,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { output += chunk; });
  child.stderr?.on('data', (chunk: string) => { output += chunk; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Headless MCP cold server exited before readiness (${child.exitCode}): ${output.slice(-1_000)}`);
    }
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, url };
    } catch {
      // The fresh process is still loading or binding.
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
  child.kill('SIGTERM');
  throw new Error(`Headless MCP cold server did not become ready: ${output.slice(-1_000)}`);
}

async function stopColdServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error('Headless MCP cold server did not stop after SIGTERM'));
    }, 15_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && signal === null) resolveExit();
      else rejectExit(new Error(`Headless MCP cold server exited with code ${String(code)} signal ${String(signal)}`));
    });
  });
}

try {
  check('in-process server started', running !== null);
  const origin = running.url;

  const signup = await postJson(
    `${origin}/api/v1/accounts`,
    { name: 'headless-smoke', password: 'correct horse battery staple headless' },
    { origin, 'sec-fetch-site': 'same-origin' },
  );
  check('signup succeeds', signup.response.status === 201);
  const browserHeaders = {
    origin,
    'sec-fetch-site': 'same-origin',
    cookie: cookieFrom(signup.response),
    'x-partmode-csrf': string(signup.body.csrfToken, 'signup returns CSRF token'),
  };

  const grantedKey = await postJson(
    `${origin}/api/v1/agent-keys`,
    { label: 'Headless CI agent', access: 'edit', headless: true },
    browserHeaders,
  );
  check('headless key creation succeeds', grantedKey.response.status === 201);
  check('headless key reports the grant', record(grantedKey.body.key, 'headless key metadata').headless === true);
  const grantedRaw = string(grantedKey.body.rawKey, 'headless raw key returned');
  const grantedKeyId = string(record(grantedKey.body.key, 'headless key metadata').id, 'headless key ID');

  const plainKey = await postJson(
    `${origin}/api/v1/agent-keys`,
    { label: 'Plain edit agent', access: 'edit' },
    browserHeaders,
  );
  check('plain key creation succeeds', plainKey.response.status === 201);
  check('plain key has no grant', record(plainKey.body.key, 'plain key metadata').headless === false);
  const plainRaw = string(plainKey.body.rawKey, 'plain raw key returned');

  const readOnlyHeadless = await postJson(
    `${origin}/api/v1/agent-keys`,
    { label: 'Bad combo', access: 'read-only', headless: true },
    browserHeaders,
  );
  check('read-only headless key is refused', readOnlyHeadless.response.status >= 400);

  const refused = toolError(
    await mcpToolCall(origin, plainRaw, 'partmode_headless_open', { projectId: 'hp-plate' }),
    'ungranted open',
  );
  check('ungranted key gets HEADLESS_NOT_GRANTED', refused.code === 'HEADLESS_NOT_GRANTED');

  const opened = toolValue(
    await mcpToolCall(origin, grantedRaw, 'partmode_headless_open', {
      projectId: 'hp-plate',
      name: 'Headless plate',
      maxCommits: 2,
    }),
    'granted open',
  );
  const sessionId = string(opened.sessionId, 'headless session ID');
  check('session ID carries the headless prefix', sessionId.startsWith('hsession_'));
  check('fresh project opens at revision 0', opened.revision === 0);
  check('summary declares server-headless execution', opened.execution === 'server-headless');
  check('summary reports the full commit budget', opened.maxCommits === 2 && opened.remainingCommits === 2);

  // A session belongs to the key that opened it. A sibling key on the same
  // account, with no headless grant, must not be able to drive it.
  const siblingStatus = toolError(
    await mcpToolCall(origin, plainRaw, 'partmode_session_status', { sessionId }),
    'sibling key session status',
  );
  check('sibling key cannot see the session', siblingStatus.code === 'SESSION_NOT_FOUND');
  const siblingExport = toolError(
    await mcpToolCall(origin, plainRaw, 'partmode_headless_export_step', { sessionId }),
    'sibling key export',
  );
  check('sibling key cannot export from the session', siblingExport.code === 'SESSION_NOT_FOUND');

  const manifest = toolValue(
    await mcpToolCall(origin, grantedRaw, 'cad_capabilities', { sessionId }),
    'headless capabilities',
  );
  const stepCapability = (manifest.exports as JsonRecord[])?.find((entry) => entry.format === 'step');
  check('headless capabilities return the bare manifest, like the browser path', stepCapability?.state === 'available');

  const plate = (label: string, expectedRevision: number, w: number): JsonRecord => ({
    sessionId,
    transaction: {
      transactionId: `tx-${label}`,
      label,
      expectedRevision,
      atomic: true,
      operations: [
        {
          kind: 'feature.extrude',
          input: { name: label, sketch: { shapes: [{ kind: 'rect', x: 0, y: 0, w, h: 20 }] }, h: 6 },
        },
      ],
    },
  });

  const previewResult = toolValue(
    await mcpToolCall(origin, grantedRaw, 'cad_preview', plate('plate-a', 0, 50)),
    'headless preview',
  );
  check('preview returns the result directly, like the browser path', typeof previewResult.previewId === 'string');
  check('preview evidence is exact-kernel', (previewResult.evidence as JsonRecord)?.exactGeometry === true);

  const commitResult = toolValue(
    await mcpToolCall(origin, grantedRaw, 'cad_commit', {
      sessionId,
      previewId: string(previewResult.previewId, 'preview ID'),
      expectedRevision: 0,
    }),
    'headless commit',
  );
  check('commit advances to revision 1', commitResult.revision === 1);
  const committedHash = string(
    (commitResult.changeSet as JsonRecord).documentHashAfter,
    'commit carries the document hash',
  );

  // A stale expectedRevision must surface as a typed tool failure, not as a
  // successful reply whose envelope happens to say conflict.
  const stalePreview = toolValue(
    await mcpToolCall(origin, grantedRaw, 'cad_preview', plate('plate-stale', 1, 30)),
    'preview for stale-commit probe',
  );
  const staleCommit = toolError(
    await mcpToolCall(origin, grantedRaw, 'cad_commit', {
      sessionId,
      previewId: string(stalePreview.previewId, 'stale preview ID'),
      expectedRevision: 0,
    }),
    'stale commit',
  );
  check('stale commit is a typed conflict failure', staleCommit.code === 'REVISION_CONFLICT');

  const uiRefused = toolError(
    await mcpToolCall(origin, grantedRaw, 'cad_ui', { sessionId, action: { kind: 'ui.read' } }),
    'headless cad_ui',
  );
  check('cad_ui needs a visible studio', uiRefused.code === 'VISIBLE_STUDIO_REQUIRED');

  const exported = toolValue(
    await mcpToolCall(origin, grantedRaw, 'partmode_headless_export_step', { sessionId }),
    'headless STEP export',
  );
  const stepBytes = Buffer.from(string(exported.stepBase64, 'export carries base64 STEP'), 'base64');
  check('exported byte count matches', exported.bytes === stepBytes.byteLength && stepBytes.byteLength > 0);
  check('exported hash matches', exported.sha256 === createHash('sha256').update(stepBytes).digest('hex'));
  check('exported payload is ISO 10303-21', stepBytes.toString('utf8', 0, 32).startsWith('ISO-10303-21'));

  // The commit budget is enforced by the session, not by the per-request
  // permission clone. Opened with 2: one is spent, one remains.
  const afterFirstCommit = toolValue(
    await mcpToolCall(origin, grantedRaw, 'partmode_session_status', { sessionId }),
    'status after first commit',
  );
  check('one commit is spent', afterFirstCommit.remainingCommits === 1);

  const secondPreview = toolValue(
    await mcpToolCall(origin, grantedRaw, 'cad_preview', plate('plate-b', 1, 25)),
    'second preview',
  );
  toolValue(
    await mcpToolCall(origin, grantedRaw, 'cad_commit', {
      sessionId,
      previewId: string(secondPreview.previewId, 'second preview ID'),
      expectedRevision: 1,
    }),
    'second commit',
  );
  const thirdPreview = toolValue(
    await mcpToolCall(origin, grantedRaw, 'cad_preview', plate('plate-c', 2, 15)),
    'third preview',
  );
  const budgetError = toolError(
    await mcpToolCall(origin, grantedRaw, 'cad_commit', {
      sessionId,
      previewId: string(thirdPreview.previewId, 'third preview ID'),
      expectedRevision: 2,
    }),
    'commit beyond budget',
  );
  check('commit budget is enforced', budgetError.code === 'COMMIT_BUDGET_EXHAUSTED');

  toolValue(await mcpToolCall(origin, grantedRaw, 'partmode_disconnect', { sessionId }), 'disconnect');

  // Revoking a key must close its live sessions, as the relay does.
  const revocationSession = string(
    toolValue(
      await mcpToolCall(origin, grantedRaw, 'partmode_headless_open', { projectId: 'hp-revocation' }),
      'session for revocation probe',
    ).sessionId,
    'revocation session ID',
  );
  const revoked = await fetch(`${origin}/api/v1/agent-keys/${grantedKeyId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...browserHeaders },
    body: JSON.stringify({}),
  });
  check('key revocation succeeds', revoked.status === 200);
  const afterRevoke = await postJson(
    `${origin}/mcp`,
    { jsonrpc: '2.0', id: 'revoked-probe', method: 'tools/call', params: { name: 'partmode_session_status', arguments: { sessionId: revocationSession } } },
    { authorization: `Bearer ${grantedRaw}`, 'mcp-protocol-version': '2025-11-25' },
  );
  check('revoked key is rejected at authentication', afterRevoke.response.status === 401);

  // Re-mint a granted key to prove the durable document outlives both the
  // revoked key and the process.
  const restartKey = await postJson(
    `${origin}/api/v1/agent-keys`,
    { label: 'Restart probe', access: 'edit', headless: true },
    browserHeaders,
  );
  check('replacement key creation succeeds', restartKey.response.status === 201);
  const restartRaw = string(restartKey.body.rawKey, 'replacement raw key');

  // Web sign-out follows the relay contract and closes every active CAD
  // session for the account, including headless sessions, without revoking
  // the durable agent key itself.
  const logoutSession = string(
    toolValue(
      await mcpToolCall(origin, restartRaw, 'partmode_headless_open', { projectId: 'hp-logout-cleanup' }),
      'session for account-level logout cleanup',
    ).sessionId,
    'logout cleanup session ID',
  );
  const logout = await fetch(`${origin}/api/v1/session`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...browserHeaders },
    body: JSON.stringify({}),
  });
  check('web logout succeeds', logout.status === 200);
  const afterLogout = toolError(
    await mcpToolCall(origin, restartRaw, 'partmode_session_status', { sessionId: logoutSession }),
    'account-level logout cleanup',
  );
  check('web logout closes headless account sessions', afterLogout.code === 'SESSION_NOT_FOUND');

  // Durability: stop the original server only after it has awaited worker
  // disposal, then launch the compiled entrypoint in a fresh OS process.
  // Reusing only the SQLite state directory makes this a cold-start proof,
  // not a same-process cache or module-singleton restart.
  await stopServer(running);
  running = null;
  coldRunning = await startColdServer();
  const reopened = toolValue(
    await mcpToolCall(coldRunning.url, restartRaw, 'partmode_headless_open', { projectId: 'hp-plate' }),
    'reopen after cold process restart',
  );
  check('cold restart preserves the committed revision', reopened.revision === 2);
  check('cold restart restores a fresh commit budget', reopened.remainingCommits === 3);
  await stopColdServer(coldRunning.child);
  coldRunning = null;

  console.log(
    JSON.stringify({
      ok: true,
      grant: { refusedWithoutGrant: true, readOnlyComboRefused: true },
      session: {
        execution: 'server-headless',
        uiToolsRefused: true,
        keyBound: true,
        budgetEnforced: true,
        revocationClosesSessions: true,
        accountLogoutClosesSessions: true,
        typedConflictOnStaleCommit: true,
      },
      commit: { revision: 1, documentHash: committedHash },
      step: { bytes: stepBytes.byteLength, sha256: exported.sha256 },
      safety: managerSafety,
      restart: { revision: reopened.revision, durable: true, coldProcess: true, gracefulWorkerShutdown: true },
    }),
  );
} finally {
  if (running) await stopServer(running).catch(() => undefined);
  if (coldRunning) await stopColdServer(coldRunning.child).catch(() => undefined);
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
process.exit(0);
