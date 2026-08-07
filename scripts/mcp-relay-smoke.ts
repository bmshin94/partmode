import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  startPartModeServer,
  type RunningPartModeServer,
} from '../src/server.js';

type JsonRecord = Record<string, unknown>;

interface AccountClient {
  cookie: string;
  csrfToken: string;
  accountId: string;
}

interface StudioClient {
  studioId: string;
  studioToken: string;
}

interface HttpJsonResult {
  response: Response;
  body: JsonRecord;
}

const CAD_PROTOCOL = 'partmode.cad.agent/v1';
const MCP_PROTOCOL = '2025-11-25';
const VISIBLE_UI_PROFILE = 'partmode.cad.visible-projection/v1';
const PROJECT_ID_CANARY = 'project-private-canary';
const PROJECT_TITLE_CANARY = 'Secret turbine project';
const DOCUMENT_HASH_CANARY = 'f'.repeat(64);
const REQUESTED_MODE = 'preview-required';
const REQUESTED_PERMISSIONS = Object.freeze([
  'project.read',
  'project.edit',
  'artifact.export-drawing',
  'ui.read',
  'ui.command-draft',
  'ui.present-preview',
]);
const REQUESTED_OPERATION_KINDS = Object.freeze([
  'feature.loft',
  'feature.sweep',
]);
const REQUESTED_MAX_COMMITS = 2;
const REQUESTED_SESSION_SECONDS = 120;

function check(name: string, condition: boolean): asserts condition {
  if (!condition) throw new Error(`MCP relay smoke failed: ${name}`);
}

function record(value: unknown, label: string): JsonRecord {
  check(label, Boolean(value) && typeof value === 'object' && !Array.isArray(value));
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  check(label, Array.isArray(value));
  return value;
}

function string(value: unknown, label: string): string {
  check(label, typeof value === 'string' && value.length > 0);
  return value;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  check(label, JSON.stringify(actual) === JSON.stringify(wanted));
}

function assertNoProjectMetadata(label: string, value: unknown): void {
  const forbidden = new Set(['projectid', 'projecttitle', 'documenthash', 'hash', 'title']);
  const visit = (candidate: unknown, path: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, nested] of Object.entries(candidate as JsonRecord)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      check(`${label} does not expose ${path}.${key}`, !forbidden.has(normalized));
      visit(nested, `${path}.${key}`);
    }
  };
  visit(value, '$');
  const serialized = JSON.stringify(value);
  check(`${label} omits project ID canary`, !serialized.includes(PROJECT_ID_CANARY));
  check(`${label} omits project title canary`, !serialized.includes(PROJECT_TITLE_CANARY));
  check(`${label} omits document hash canary`, !serialized.includes(DOCUMENT_HASH_CANARY));
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  check('account response sets a session cookie', typeof setCookie === 'string');
  const separator = setCookie.indexOf(';');
  const cookie = separator === -1 ? setCookie : setCookie.slice(0, separator);
  check('session cookie has a value', Boolean(cookie) && cookie.includes('='));
  return cookie;
}

async function parseJsonResponse(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`MCP relay smoke received non-JSON HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return record(parsed, `HTTP ${response.status} response is an object`);
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs = 30_000,
  method: 'POST' | 'DELETE' = 'POST',
): Promise<HttpJsonResult> {
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { response, body: await parseJsonResponse(response) };
}

function browserHeaders(origin: string, account: AccountClient): Record<string, string> {
  return {
    origin,
    'sec-fetch-site': 'same-origin',
    cookie: account.cookie,
    'x-partmode-csrf': account.csrfToken,
  };
}

async function signUp(origin: string, name: string): Promise<AccountClient> {
  const result = await postJson(
    `${origin}/api/v1/accounts`,
    { name, password: `correct horse battery staple ${name}` },
    { origin, 'sec-fetch-site': 'same-origin' },
  );
  check(`${name} signup succeeds`, result.response.status === 201);
  const account = record(result.body.account, `${name} signup returns account`);
  return {
    cookie: cookieFrom(result.response),
    csrfToken: string(result.body.csrfToken, `${name} signup returns CSRF token`),
    accountId: string(account.id, `${name} signup returns account ID`),
  };
}

async function createEditKey(
  origin: string,
  account: AccountClient,
  label: string,
): Promise<{ rawKey: string; keyId: string }> {
  const result = await postJson(
    `${origin}/api/v1/agent-keys`,
    { label, access: 'edit' },
    browserHeaders(origin, account),
  );
  check(`${label} key creation succeeds`, result.response.status === 201);
  const key = record(result.body.key, `${label} key metadata is present`);
  const rawKey = string(result.body.rawKey, `${label} raw key is returned once`);
  check(`${label} key has the stable format`, /^pmak_v1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(rawKey));
  return { rawKey, keyId: string(key.id, `${label} key ID is present`) };
}

async function registerStudio(
  origin: string,
  account: AccountClient,
  tabId: string,
  label: string,
): Promise<StudioClient> {
  const result = await postJson(
    `${origin}/api/v1/studios/register`,
    {
      tabId,
      label,
      protocol: CAD_PROTOCOL,
      projectId: PROJECT_ID_CANARY,
      title: PROJECT_TITLE_CANARY,
      documentHash: DOCUMENT_HASH_CANARY,
    },
    browserHeaders(origin, account),
  );
  check(`${label} studio registration succeeds`, result.response.status === 201);
  exactKeys(result.body, ['studioId', 'studioToken'], `${label} registration exposes only relay credentials`);
  return {
    studioId: string(result.body.studioId, `${label} studio ID is present`),
    studioToken: string(result.body.studioToken, `${label} studio token is present`),
  };
}

async function pollStudio(
  origin: string,
  account: AccountClient,
  studio: StudioClient,
): Promise<JsonRecord[]> {
  const result = await postJson(
    `${origin}/api/v1/studios/poll`,
    studio,
    browserHeaders(origin, account),
    25_000,
  );
  check('browser poll succeeds', result.response.status === 200);
  return array(result.body.events, 'browser poll returns an event array').map((event, index) =>
    record(event, `browser event ${index} is an object`));
}

async function respondFromStudio(
  origin: string,
  account: AccountClient,
  studio: StudioClient,
  response: JsonRecord,
): Promise<HttpJsonResult> {
  const result = await postStudioResponse(origin, account, studio, response);
  check('browser response is accepted', result.response.status === 200 && result.body.accepted === true);
  return result;
}

async function postStudioResponse(
  origin: string,
  account: AccountClient,
  studio: StudioClient,
  response: JsonRecord,
): Promise<HttpJsonResult> {
  return postJson(
    `${origin}/api/v1/studios/respond`,
    { ...studio, ...response },
    browserHeaders(origin, account),
  );
}

let rpcSequence = 0;

function rpcRequest(method: string, params?: JsonRecord): JsonRecord {
  rpcSequence += 1;
  return {
    jsonrpc: '2.0',
    id: `smoke-${rpcSequence}`,
    method,
    ...(params ? { params } : {}),
  };
}

async function mcpRequest(
  origin: string,
  rawKey: string,
  request: JsonRecord,
  protocolHeader = MCP_PROTOCOL,
  timeoutMs = 30_000,
): Promise<HttpJsonResult> {
  return postJson(
    `${origin}/mcp`,
    request,
    {
      authorization: `Bearer ${rawKey}`,
      'mcp-protocol-version': protocolHeader,
    },
    timeoutMs,
  );
}

function rpcError(result: HttpJsonResult, label: string): JsonRecord {
  const error = record(result.body.error, `${label} has a JSON-RPC error`);
  check(`${label} uses JSON-RPC invalid params`, error.code === -32602);
  const data = record(error.data, `${label} includes protocol error data`);
  check(
    `${label} advertises only the supported protocol`,
    JSON.stringify(data.supportedProtocolVersions) === JSON.stringify([MCP_PROTOCOL]),
  );
  return data;
}

async function callTool(
  origin: string,
  rawKey: string,
  name: string,
  argumentsValue: JsonRecord,
  timeoutMs = 30_000,
): Promise<HttpJsonResult> {
  return mcpRequest(origin, rawKey, rpcRequest('tools/call', {
    name,
    arguments: argumentsValue,
  }), MCP_PROTOCOL, timeoutMs);
}

function persistLegacyEditCeiling(stateDirectory: string, keyId: string): readonly string[] {
  const legacyGranted = Object.freeze([
    'project.read',
    'project.edit',
    'ui.read',
    'ui.command-draft',
    'ui.present-preview',
  ]);
  const database = new DatabaseSync(join(stateDirectory, 'partmode.sqlite'));
  try {
    database.exec('PRAGMA busy_timeout = 5000;');
    const result = database.prepare(`
      UPDATE agent_keys
      SET grant_ceiling = ?
      WHERE id = ? AND access = 'edit'
    `).run(JSON.stringify({ granted: legacyGranted }), keyId);
    check('legacy edit key ceiling update changes exactly one row', result.changes === 1);
    const row = database.prepare(`
      SELECT grant_ceiling
      FROM agent_keys
      WHERE id = ?
    `).get(keyId) as { grant_ceiling?: unknown } | undefined;
    check('legacy edit key ceiling remains persisted JSON', typeof row?.grant_ceiling === 'string');
    const persisted = record(JSON.parse(row.grant_ceiling), 'legacy edit key ceiling parses as an object');
    const granted = array(persisted.granted, 'legacy edit key ceiling has a granted array');
    check(
      'legacy edit key persisted ceiling contains no artifact permission',
      granted.every((permission) => typeof permission === 'string' && !permission.startsWith('artifact.')),
    );
  } finally {
    database.close();
  }
  return legacyGranted;
}

function toolEnvelope(result: HttpJsonResult, label: string): JsonRecord {
  check(`${label} returns HTTP 200`, result.response.status === 200);
  const rpcResultValue = record(result.body.result, `${label} has a JSON-RPC result`);
  return rpcResultValue;
}

function toolSuccess(result: HttpJsonResult, label: string): JsonRecord {
  const envelope = toolEnvelope(result, label);
  check(`${label} succeeds`, envelope.isError === false);
  return record(envelope.structuredContent, `${label} has structured content`);
}

function toolErrorCode(result: HttpJsonResult, label: string): string {
  const envelope = toolEnvelope(result, label);
  check(`${label} is a typed tool failure`, envelope.isError === true);
  const structured = record(envelope.structuredContent, `${label} has structured failure content`);
  const error = record(structured.error, `${label} has an error object`);
  return string(error.code, `${label} has an error code`);
}

async function closeServer(running: RunningPartModeServer | undefined): Promise<void> {
  if (!running?.server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    running.server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

const stateDir = mkdtempSync(join(tmpdir(), 'partmode-mcp-relay-'));
let running: RunningPartModeServer | undefined;

try {
  running = await startPartModeServer({
    distDir: resolve('dist'),
    host: '127.0.0.1',
    port: 0,
    stateDir,
  });
  const origin = running.url;

  const primaryAccount = await signUp(origin, 'relay_primary');
  const primaryKey = await createEditKey(origin, primaryAccount, 'Primary smoke key');
  const primaryStudio = await registerStudio(origin, primaryAccount, 'tab-primary', 'Primary browser');

  const initialize = await mcpRequest(origin, primaryKey.rawKey, rpcRequest('initialize', {
    protocolVersion: MCP_PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'PartMode relay smoke', version: '1.0.0' },
  }));
  check('MCP initialize returns HTTP 200', initialize.response.status === 200);
  check('MCP initialize advertises the negotiated protocol', initialize.response.headers.get('mcp-protocol-version') === MCP_PROTOCOL);
  const initialized = record(initialize.body.result, 'MCP initialize has a result');
  check('MCP initialize selects the requested protocol', initialized.protocolVersion === MCP_PROTOCOL);
  const serverInfo = record(initialized.serverInfo, 'MCP initialize includes server info');
  check('MCP initialize identifies PartMode', serverInfo.name === 'PartMode');
  const initializedCapabilities = record(initialized.capabilities, 'MCP initialize includes capabilities');
  check(
    'MCP initialize advertises release-versioned Help resources',
    record(initializedCapabilities.resources, 'MCP resource capability is an object').listChanged === false,
  );

  const listedResources = await mcpRequest(origin, primaryKey.rawKey, rpcRequest('resources/list'));
  check('resources/list returns HTTP 200', listedResources.response.status === 200);
  const resourcesResult = record(listedResources.body.result, 'resources/list has a result');
  const helpResources = array(resourcesResult.resources, 'resources/list returns resources').map((resource, index) =>
    record(resource, `Help resource ${index} is an object`));
  check('resources/list exposes the four canonical Help topics', helpResources.length === 4);
  const helpUris = helpResources.map((resource, index) => string(resource.uri, `Help resource ${index} has a URI`));
  check(
    'resources/list exposes agent workflow Help',
    helpUris.includes('partmode://help/agent-workflow'),
  );
  const agentHelp = await mcpRequest(origin, primaryKey.rawKey, rpcRequest('resources/read', {
    uri: 'partmode://help/agent-workflow',
  }));
  check('resources/read returns HTTP 200', agentHelp.response.status === 200);
  const agentHelpResult = record(agentHelp.body.result, 'resources/read has a result');
  const agentHelpContents = array(agentHelpResult.contents, 'resources/read returns contents').map((content, index) =>
    record(content, `Help content ${index} is an object`));
  check(
    'agent Help gives the capability-first approval workflow',
    agentHelpContents.length === 1 &&
      agentHelpContents[0]!.mimeType === 'text/markdown' &&
      string(agentHelpContents[0]!.text, 'agent Help has text').includes('cad_capabilities') &&
      string(agentHelpContents[0]!.text, 'agent Help has setup instructions').includes('partmode_connect'),
  );

  const olderProtocol = '2025-06-18';
  const olderInitialize = await mcpRequest(origin, primaryKey.rawKey, rpcRequest('initialize', {
    protocolVersion: olderProtocol,
    capabilities: {},
    clientInfo: { name: 'PartMode older protocol smoke', version: '1.0.0' },
  }));
  check('older initialize is rejected at JSON-RPC level', olderInitialize.response.status === 200);
  check(
    'older initialize response advertises the current header',
    olderInitialize.response.headers.get('mcp-protocol-version') === MCP_PROTOCOL,
  );
  const olderInitializeError = rpcError(olderInitialize, 'older initialize');
  check('older initialize identifies the rejected version', olderInitializeError.requestedProtocolVersion === olderProtocol);

  const mismatchedHeader = await mcpRequest(
    origin,
    primaryKey.rawKey,
    rpcRequest('initialize', { protocolVersion: MCP_PROTOCOL }),
    olderProtocol,
  );
  check('mismatched protocol header is rejected at HTTP boundary', mismatchedHeader.response.status === 400);
  check(
    'mismatched-header response advertises the current header',
    mismatchedHeader.response.headers.get('mcp-protocol-version') === MCP_PROTOCOL,
  );
  const mismatchedHeaderError = rpcError(mismatchedHeader, 'mismatched protocol header');
  check('mismatched header identifies the rejected version', mismatchedHeaderError.requestedProtocolVersion === olderProtocol);

  const listedTools = await mcpRequest(origin, primaryKey.rawKey, rpcRequest('tools/list'));
  check('tools/list returns HTTP 200', listedTools.response.status === 200);
  const toolsResult = record(listedTools.body.result, 'tools/list has a result');
  const tools = array(toolsResult.tools, 'tools/list returns tools').map((tool, index) =>
    record(tool, `tool definition ${index} is an object`));
  const toolNames = tools.map((tool, index) => string(tool.name, `tool ${index} has a name`)).sort();
  const expectedToolNames = [
    'cad_capabilities',
    'cad_commit',
    'cad_events',
    'cad_history',
    'cad_inspect',
    'cad_artifact',
    'cad_preview',
    'cad_query',
    'cad_ui',
    'partmode_connect',
    'partmode_disconnect',
    'partmode_headless_export_step',
    'partmode_headless_open',
    'partmode_list_studios',
    'partmode_session_status',
  ].sort();
  check('tools/list exposes the exact hosted v1 surface', JSON.stringify(toolNames) === JSON.stringify(expectedToolNames));

  const invalidListArguments = await callTool(origin, primaryKey.rawKey, 'partmode_list_studios', {
    ignored: true,
  });
  check(
    'runtime rejects arguments excluded by the advertised schema',
    toolErrorCode(invalidListArguments, 'invalid list arguments') === 'INVALID_ARGUMENTS',
  );

  const invalidHeadlessArguments = await callTool(origin, primaryKey.rawKey, 'partmode_headless_open', {
    projectId: 'invalid-argument-project',
    operationKinds: [42],
  });
  check(
    'runtime rejects malformed bounded arrays instead of filtering them',
    toolErrorCode(invalidHeadlessArguments, 'invalid headless arguments') === 'INVALID_ARGUMENTS',
  );

  const fakeSessionCall = await callTool(origin, primaryKey.rawKey, 'cad_capabilities', {
    sessionId: 'session_fake_not_browser_approved',
    detail: 'summary',
  });
  check(
    'an API key alone cannot fabricate a CAD session',
    toolErrorCode(fakeSessionCall, 'key-only CAD call') === 'SESSION_NOT_FOUND',
  );

  const secondaryAccount = await signUp(origin, 'relay_secondary');
  const secondaryKey = await createEditKey(origin, secondaryAccount, 'Secondary smoke key');
  const secondaryStudio = await registerStudio(origin, secondaryAccount, 'tab-secondary', 'Secondary browser');

  const primaryListResponse = await callTool(origin, primaryKey.rawKey, 'partmode_list_studios', {});
  const primaryList = toolSuccess(primaryListResponse, 'primary studio list');
  const primaryStudios = array(primaryList.studios, 'primary studio list has studios').map((studio, index) =>
    record(studio, `primary studio ${index} is an object`));
  check('primary account sees one studio', primaryStudios.length === 1);
  exactKeys(
    primaryStudios[0]!,
    ['studioId', 'label', 'protocol', 'available'],
    'studio discovery returns only non-project metadata',
  );
  check('primary account sees only its studio', primaryStudios[0]!.studioId === primaryStudio.studioId);
  assertNoProjectMetadata('primary studio list', primaryList);

  const secondaryListResponse = await callTool(origin, secondaryKey.rawKey, 'partmode_list_studios', {});
  const secondaryList = toolSuccess(secondaryListResponse, 'secondary studio list');
  const secondaryStudios = array(secondaryList.studios, 'secondary studio list has studios').map((studio, index) =>
    record(studio, `secondary studio ${index} is an object`));
  check(
    'secondary account sees only its own studio',
    secondaryStudios.length === 1 && secondaryStudios[0]!.studioId === secondaryStudio.studioId,
  );
  assertNoProjectMetadata('secondary studio list', secondaryList);

  const crossTenantConnect = await callTool(origin, secondaryKey.rawKey, 'partmode_connect', {
    studioId: primaryStudio.studioId,
    mode: 'read-only',
  });
  check(
    'second account cannot connect to the first account studio',
    toolErrorCode(crossTenantConnect, 'cross-tenant connect') === 'STUDIO_NOT_FOUND',
  );

  const quotaAccount = await signUp(origin, 'relay_quota');
  for (let index = 0; index < 8; index++) {
    await registerStudio(origin, quotaAccount, `quota-tab-${index}`, `Quota browser ${index + 1}`);
  }
  const quotaExceeded = await postJson(
    `${origin}/api/v1/studios/register`,
    {
      tabId: 'quota-tab-8',
      label: 'Quota browser 9',
      protocol: CAD_PROTOCOL,
    },
    browserHeaders(origin, quotaAccount),
  );
  check('ninth account studio is rejected with HTTP 429', quotaExceeded.response.status === 429);
  check('ninth account studio returns the typed capacity error', quotaExceeded.body.error === 'RELAY_CAPACITY_EXCEEDED');
  const quotaDetails = record(quotaExceeded.body.details, 'studio quota error includes details');
  check(
    'studio quota error reports the exact account limit',
    quotaDetails.scope === 'account' && quotaDetails.resource === 'studios' && quotaDetails.limit === 8,
  );

  // Older edit keys may have been persisted before artifact permissions
  // existed. Authentication must honor that exact stored ceiling instead of
  // silently upgrading the key to today's edit defaults. In particular, a
  // drawing grant request must fail before the browser sees an approval.
  const legacyAccount = await signUp(origin, 'relay_legacy');
  const legacyKey = await createEditKey(origin, legacyAccount, 'Legacy edit smoke key');
  const legacyStudio = await registerStudio(origin, legacyAccount, 'tab-legacy', 'Legacy browser');
  const legacyGranted = persistLegacyEditCeiling(stateDir, legacyKey.keyId);
  const legacyDrawingConnect = await callTool(origin, legacyKey.rawKey, 'partmode_connect', {
    studioId: legacyStudio.studioId,
    clientLabel: 'Legacy drawing request',
    mode: 'preview-required',
    permissions: [...legacyGranted, 'artifact.export-drawing'],
    uiProfile: VISIBLE_UI_PROFILE,
  }, 5_000);
  check(
    'legacy edit key cannot exceed its persisted ceiling with drawing export',
    toolErrorCode(legacyDrawingConnect, 'legacy drawing connect') === 'GRANT_CEILING_EXCEEDED',
  );

  // A bounded follow-up request must be the first and only approval event.
  // If the forbidden request reached the browser queue, this poll would
  // expose it before the valid request and the assertions below would fail.
  const legacyBoundedConnect = callTool(origin, legacyKey.rawKey, 'partmode_connect', {
    studioId: legacyStudio.studioId,
    clientLabel: 'Legacy bounded request',
    mode: 'preview-required',
    permissions: [...legacyGranted],
    uiProfile: VISIBLE_UI_PROFILE,
  });
  const legacyApprovalEvents = await pollStudio(origin, legacyAccount, legacyStudio);
  check('legacy browser receives exactly one bounded approval', legacyApprovalEvents.length === 1);
  const legacyApproval = legacyApprovalEvents[0]!;
  check(
    'legacy browser never receives the forbidden drawing approval',
    legacyApproval.type === 'connection.request' &&
      legacyApproval.clientLabel === 'Legacy bounded request (Legacy edit smoke key)' &&
      !JSON.stringify(legacyApproval).includes('artifact.export-drawing'),
  );
  const legacyPermissionContext = record(
    legacyApproval.permissionContext,
    'legacy bounded approval includes a permission context',
  );
  check(
    'legacy bounded approval preserves the exact persisted ceiling',
    JSON.stringify(legacyPermissionContext.granted) === JSON.stringify(legacyGranted),
  );
  await respondFromStudio(origin, legacyAccount, legacyStudio, {
    requestId: legacyApproval.requestId,
    status: 'denied',
    error: { code: 'LEGACY_SMOKE_DENIED', message: 'Safety regression cleanup.' },
  });
  check(
    'legacy bounded cleanup denial settles the pending request',
    toolErrorCode(await legacyBoundedConnect, 'legacy bounded cleanup') === 'LEGACY_SMOKE_DENIED',
  );

  const connectStartedAt = Date.now();
  const connectPromise = callTool(origin, primaryKey.rawKey, 'partmode_connect', {
    studioId: primaryStudio.studioId,
    clientLabel: 'Relay smoke agent',
    mode: REQUESTED_MODE,
    permissions: [...REQUESTED_PERMISSIONS],
    operationKinds: [...REQUESTED_OPERATION_KINDS],
    maxCommits: REQUESTED_MAX_COMMITS,
    sessionSeconds: REQUESTED_SESSION_SECONDS,
    uiProfile: VISIBLE_UI_PROFILE,
  });
  const approvalEvents = await pollStudio(origin, primaryAccount, primaryStudio);
  check('browser receives exactly one approval event', approvalEvents.length === 1);
  const approval = approvalEvents[0]!;
  check('browser receives a connection request', approval.type === 'connection.request');
  check('approval uses the requested mode', approval.mode === REQUESTED_MODE);
  check('approval uses the requested visible UI profile', approval.uiProfile === VISIBLE_UI_PROFILE);
  check('approval identifies the server-authenticated key', approval.keyLabel === 'Primary smoke key');
  check(
    'approval combines the client and authenticated key labels',
    approval.clientLabel === 'Relay smoke agent (Primary smoke key)',
  );
  const permissionContext = record(approval.permissionContext, 'approval includes a permission context');
  check(
    'approval contains the exact bounded permissions',
    JSON.stringify(permissionContext.granted) === JSON.stringify(REQUESTED_PERMISSIONS),
  );
  check('approval contains the exact commit budget', permissionContext.maxCommits === REQUESTED_MAX_COMMITS);
  check(
    'approval contains the exact operation-kind boundary',
    JSON.stringify(permissionContext.operationKinds) === JSON.stringify(REQUESTED_OPERATION_KINDS),
  );
  const approvalExpiresAt = string(permissionContext.expiresAt, 'approval contains a permission expiry');
  check('top-level approval expiry matches its permission expiry', approval.expiresAt === approvalExpiresAt);
  const approvalDurationMs = Date.parse(approvalExpiresAt) - connectStartedAt;
  check(
    'approval expiry is bounded to the requested duration',
    approvalDurationMs >= (REQUESTED_SESSION_SECONDS - 2) * 1_000 &&
      approvalDurationMs <= (REQUESTED_SESSION_SECONDS + 2) * 1_000,
  );
  assertNoProjectMetadata('approval event', approval);

  const approvedBrowserResponse: JsonRecord = {
    requestId: approval.requestId,
    status: 'approved',
    result: {
      mode: REQUESTED_MODE,
      permissionContext: {
        granted: [...REQUESTED_PERMISSIONS],
        maxCommits: REQUESTED_MAX_COMMITS,
      },
      uiProfile: VISIBLE_UI_PROFILE,
      revision: 7,
      capabilities: { protocolVersion: CAD_PROTOCOL, exactKernel: true },
      projectId: PROJECT_ID_CANARY,
      title: PROJECT_TITLE_CANARY,
      documentHash: DOCUMENT_HASH_CANARY,
    },
  };
  await respondFromStudio(origin, primaryAccount, primaryStudio, approvedBrowserResponse);
  const replayedApproval = await respondFromStudio(
    origin,
    primaryAccount,
    primaryStudio,
    approvedBrowserResponse,
  );
  check(
    'identical approval retry is an accepted no-op',
    replayedApproval.response.status === 200 && replayedApproval.body.accepted === true,
  );
  const conflictingApproval = await postStudioResponse(origin, primaryAccount, primaryStudio, {
    ...approvedBrowserResponse,
    status: 'denied',
  });
  check('conflicting approval replay returns HTTP 409', conflictingApproval.response.status === 409);
  check(
    'conflicting approval replay returns the typed conflict',
    conflictingApproval.body.error === 'RESPONSE_REPLAY_CONFLICT',
  );
  const connected = toolSuccess(await connectPromise, 'browser-approved connect');
  const sessionId = string(connected.sessionId, 'connect returns an opaque session ID');
  check('connect preserves the approved mode', connected.mode === REQUESTED_MODE);
  check('connect preserves the approved commit budget', connected.maxCommits === REQUESTED_MAX_COMMITS);
  check(
    'connect preserves the approved permissions',
    JSON.stringify(connected.permissions) === JSON.stringify(REQUESTED_PERMISSIONS),
  );
  assertNoProjectMetadata('connect response', connected);

  const crossTenantStatus = await callTool(origin, secondaryKey.rawKey, 'partmode_session_status', { sessionId });
  check(
    'second account cannot inspect the first account session',
    toolErrorCode(crossTenantStatus, 'cross-tenant status') === 'SESSION_NOT_FOUND',
  );

  const capabilityPromise = callTool(origin, primaryKey.rawKey, 'cad_capabilities', {
    sessionId,
    detail: 'summary',
  });
  const toolEvents = await pollStudio(origin, primaryAccount, primaryStudio);
  check('browser receives exactly one tool event', toolEvents.length === 1);
  const toolEvent = toolEvents[0]!;
  check('browser receives a tool request', toolEvent.type === 'tool.request');
  check('tool event targets the approved session', toolEvent.sessionId === sessionId);
  check('tool event names cad_capabilities', toolEvent.tool === 'cad_capabilities');
  check(
    'tool event carries only the forwarded arguments',
    JSON.stringify(toolEvent.args) === JSON.stringify({ detail: 'summary' }),
  );
  const capabilityBrowserResponse: JsonRecord = {
    requestId: toolEvent.requestId,
    status: 'ok',
    result: {
      protocolVersion: CAD_PROTOCOL,
      studioVersion: '8.0.0',
      exactKernel: true,
      operationKinds: ['feature.loft', 'feature.sweep'],
    },
  };
  await respondFromStudio(origin, primaryAccount, primaryStudio, capabilityBrowserResponse);
  const replayedCapability = await respondFromStudio(
    origin,
    primaryAccount,
    primaryStudio,
    capabilityBrowserResponse,
  );
  check(
    'identical tool response retry is an accepted no-op',
    replayedCapability.response.status === 200 && replayedCapability.body.accepted === true,
  );
  const conflictingCapability = await postStudioResponse(origin, primaryAccount, primaryStudio, {
    ...capabilityBrowserResponse,
    result: { protocolVersion: CAD_PROTOCOL, exactKernel: false },
  });
  check('conflicting tool response replay returns HTTP 409', conflictingCapability.response.status === 409);
  check(
    'conflicting tool response replay returns the typed conflict',
    conflictingCapability.body.error === 'RESPONSE_REPLAY_CONFLICT',
  );
  const capabilityResult = toolSuccess(await capabilityPromise, 'cad_capabilities round trip');
  check('browser tool result reaches MCP unchanged', capabilityResult.protocolVersion === CAD_PROTOCOL);
  check('browser exact-kernel evidence reaches MCP', capabilityResult.exactKernel === true);
  assertNoProjectMetadata('capability response', capabilityResult);

  const drawingSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 297 210" data-evidence="occt-hlr-exact"><title>PartMode drawing smoke</title></svg>';
  const drawingBytes = Buffer.from(drawingSvg, 'utf8');
  const drawingSha256 = createHash('sha256').update(drawingBytes).digest('hex');
  const artifactPromise = callTool(origin, primaryKey.rawKey, 'cad_artifact', {
    sessionId,
    format: 'drawing-svg',
  });
  const artifactEvents = await pollStudio(origin, primaryAccount, primaryStudio);
  check('browser receives one drawing artifact request', artifactEvents.length === 1);
  const artifactEvent = artifactEvents[0]!;
  check(
    'hosted MCP routes cad_artifact drawing-svg to the approved browser session',
    artifactEvent.type === 'tool.request' &&
      artifactEvent.tool === 'cad_artifact' &&
      artifactEvent.sessionId === sessionId &&
      JSON.stringify(artifactEvent.args) === JSON.stringify({ format: 'drawing-svg' }),
  );
  await respondFromStudio(origin, primaryAccount, primaryStudio, {
    requestId: artifactEvent.requestId,
    status: 'ok',
    result: {
      phase: 'generated',
      format: 'drawing-svg',
      mediaType: 'image/svg+xml',
      bytes: drawingBytes.byteLength,
      sha256: drawingSha256,
      dataBase64: drawingBytes.toString('base64'),
      manifest: {
        kind: 'drawing-sheet',
        exactProjectionEvidence: 'occt-hlr-exact',
        views: ['front', 'right', 'iso'],
      },
    },
  });
  const artifactResult = toolSuccess(await artifactPromise, 'cad_artifact drawing round trip');
  check(
    'hosted MCP returns the exact drawing bytes and hash',
    artifactResult.format === 'drawing-svg' &&
      artifactResult.mediaType === 'image/svg+xml' &&
      artifactResult.bytes === drawingBytes.byteLength &&
      artifactResult.sha256 === drawingSha256 &&
      artifactResult.dataBase64 === drawingBytes.toString('base64'),
  );
  const ungrantedArtifact = await callTool(origin, primaryKey.rawKey, 'cad_artifact', {
    sessionId,
    format: 'step',
  });
  check(
    'relay enforces the format-specific artifact permission before browser dispatch',
    toolErrorCode(ungrantedArtifact, 'ungranted STEP artifact') === 'PERMISSION_DENIED',
  );

  const status = toolSuccess(
    await callTool(origin, primaryKey.rawKey, 'partmode_session_status', { sessionId }),
    'session status',
  );
  check('status reports the approved session', status.sessionId === sessionId);
  check('status reports the exact remaining budget', status.remainingCommits === REQUESTED_MAX_COMMITS);
  check('status reports the exact approved mode', status.mode === REQUESTED_MODE);
  assertNoProjectMetadata('session status', status);

  const disconnected = toolSuccess(
    await callTool(origin, primaryKey.rawKey, 'partmode_disconnect', { sessionId }),
    'disconnect',
  );
  check('disconnect acknowledges closure', disconnected.disconnected === true);
  const closeEvents = await pollStudio(origin, primaryAccount, primaryStudio);
  check('browser receives exactly one close event', closeEvents.length === 1);
  check(
    'browser close event targets the disconnected session',
    closeEvents[0]!.type === 'session.close' && closeEvents[0]!.sessionId === sessionId,
  );

  const closedStatus = await callTool(origin, primaryKey.rawKey, 'partmode_session_status', { sessionId });
  check(
    'disconnected session is no longer usable',
    toolErrorCode(closedStatus, 'closed session status') === 'SESSION_NOT_FOUND',
  );

  const revoke = await postJson(
    `${origin}/api/v1/agent-keys/${primaryKey.keyId}`,
    {},
    browserHeaders(origin, primaryAccount),
    30_000,
    'DELETE',
  );
  check('agent key revocation succeeds', revoke.response.status === 200 && revoke.body.revoked === true);
  const revokedMcp = await mcpRequest(origin, primaryKey.rawKey, rpcRequest('initialize', {
    protocolVersion: MCP_PROTOCOL,
  }));
  check('revoked key receives HTTP 401', revokedMcp.response.status === 401);
  check('revoked key receives the stable auth error', revokedMcp.body.error === 'INVALID_AGENT_KEY');

  console.log(JSON.stringify({
    ok: true,
    protocol: MCP_PROTOCOL,
    tools: toolNames.length,
    tenantIsolation: true,
    legacyGrantCeilingFailClosed: true,
    browserApproval: true,
    drawingArtifact: true,
    responseReplaySafe: true,
    studioAccountLimitStatus: quotaExceeded.response.status,
    protocolMismatchRejected: true,
    projectMetadataLeaked: false,
    revokedKeyStatus: revokedMcp.response.status,
  }));
} finally {
  await closeServer(running);
  rmSync(stateDir, { recursive: true, force: true });
}
