const ACCOUNT_URL = '/api/v1/account';
const REGISTER_URL = '/api/v1/studios/register';
const POLL_URL = '/api/v1/studios/poll';
const RESPOND_URL = '/api/v1/studios/respond';
const UNREGISTER_URL = '/api/v1/studios/unregister';
const TAB_ID_STORAGE_KEY = 'partmode.cloud-agent.tab-id.v1';
const MAX_REGISTER_ATTEMPTS = 4;
const MAX_POLL_FAILURES = 8;
const MAX_RESPONSE_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let started = false;

class CloudBridgeHttpError extends Error {
  constructor(status) {
    super('The PartMode cloud bridge request failed.');
    this.name = 'CloudBridgeHttpError';
    this.status = status;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function backoff(attempt) {
  return Math.min(MAX_BACKOFF_MS, 250 * (2 ** Math.max(0, attempt - 1)));
}

function jsonCopy(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function boundedText(value, fallback, maximum = 1_000) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, maximum);
}

function safeError(error, includeDetails = true) {
  const candidate = error && typeof error === 'object' ? error : {};
  const code = boundedText(candidate.code, 'CAD_TOOL_FAILED', 100);
  const message = boundedText(candidate.message, 'The CAD request failed.');
  const details = includeDetails ? jsonCopy(candidate.details) : undefined;
  return {
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function safePermissionContext(value) {
  const context = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const granted = Array.isArray(context.granted)
    ? context.granted.filter((entry) => typeof entry === 'string').slice(0, 100)
    : [];
  const operationKinds = Array.isArray(context.operationKinds)
    ? context.operationKinds.filter((entry) => typeof entry === 'string').slice(0, 250)
    : undefined;
  return {
    granted,
    ...(operationKinds ? { operationKinds } : {}),
    ...(typeof context.expiresAt === 'string' ? { expiresAt: context.expiresAt } : {}),
    ...(Number.isInteger(context.maxCommits) && context.maxCommits >= 0
      ? { maxCommits: context.maxCommits }
      : {}),
  };
}

function tabIdFromSessionStorage() {
  try {
    const existing = sessionStorage.getItem(TAB_ID_STORAGE_KEY);
    if (existing && UUID_PATTERN.test(existing)) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(TAB_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return null;
  }
}

async function readJson(response) {
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    throw new CloudBridgeHttpError(response.status || 502);
  }
}

async function accountState() {
  const response = await fetch(ACCOUNT_URL, {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'same-origin',
  });
  if (!response.ok) throw new CloudBridgeHttpError(response.status);
  const body = await readJson(response);
  const csrfToken = typeof body.csrfToken === 'string'
    ? body.csrfToken
    : response.headers.get('x-partmode-csrf');
  return {
    authenticated: body.authenticated === true,
    csrfToken: typeof csrfToken === 'string' && csrfToken.length >= 16 && csrfToken.length <= 512
      ? csrfToken
      : null,
  };
}

function renderAccountAccess(authenticated) {
  const link = document.getElementById('pm-agent-access');
  if (!(link instanceof HTMLAnchorElement)) return;
  const label = link.querySelector('.pm-account-link-label');
  const text = authenticated ? 'Account' : 'Sign in';
  const description = authenticated ? 'Account and agent keys' : 'Sign in or create account';
  if (label) label.textContent = text;
  link.setAttribute('aria-label', description);
  link.title = description;
}

async function mutate(url, csrfToken, body, options = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'X-PartMode-CSRF': csrfToken,
    },
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'same-origin',
    keepalive: options.keepalive === true,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new CloudBridgeHttpError(response.status);
  return readJson(response);
}

async function withRetry(operation, attempts) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (
        error instanceof CloudBridgeHttpError &&
        [400, 401, 403, 404, 409, 410, 422].includes(error.status)
      ) {
        throw error;
      }
      if (attempt < attempts) await wait(backoff(attempt));
    }
  }
  throw lastError;
}

function validBridgeCredential(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512;
}

function eventConnection(connections, event) {
  if (
    typeof event.sessionId !== 'string' ||
    event.sessionId.length === 0 ||
    !connections.has(event.sessionId)
  ) return null;
  return {
    sessionId: event.sessionId,
    connectionToken: connections.get(event.sessionId),
  };
}

function removeConnectionToken(connections, connectionToken) {
  for (const [sessionId, token] of connections) {
    if (token === connectionToken) connections.delete(sessionId);
  }
}

function connectionOptions(event) {
  return {
    sessionId: event.sessionId,
    clientLabel: event.clientLabel,
    permissionContext: event.permissionContext,
    mode: event.mode,
    skillVersion: event.skillVersion,
    uiProfile: event.uiProfile,
    expiresAt: event.expiresAt,
  };
}

export async function startStudioCloudAgentBridge(partmodeAgent = window.partmodeAgent) {
  if (started) return;
  started = true;
  if (
    !partmodeAgent ||
    typeof partmodeAgent.protocol !== 'string' ||
    typeof partmodeAgent.requestConnection !== 'function' ||
    typeof partmodeAgent.requestTool !== 'function' ||
    typeof partmodeAgent.disconnect !== 'function'
  ) {
    return;
  }

  let account;
  try {
    account = await accountState();
  } catch {
    return;
  }
  renderAccountAccess(account.authenticated);
  if (!account.authenticated || !account.csrfToken) return;

  const tabId = tabIdFromSessionStorage();
  if (!tabId) return;

  let registration;
  try {
    registration = await withRetry(
      () => mutate(REGISTER_URL, account.csrfToken, {
        tabId,
        label: 'This browser',
        protocol: partmodeAgent.protocol,
      }),
      MAX_REGISTER_ATTEMPTS,
    );
  } catch {
    return;
  }
  if (
    !validBridgeCredential(registration.studioId) ||
    !validBridgeCredential(registration.studioToken)
  ) {
    return;
  }

  const bridge = {
    stopped: false,
    csrfToken: account.csrfToken,
    studioId: registration.studioId,
    studioToken: registration.studioToken,
    connections: new Map(),
  };

  const respond = (payload) => withRetry(
    () => mutate(RESPOND_URL, bridge.csrfToken, {
      studioId: bridge.studioId,
      studioToken: bridge.studioToken,
      ...payload,
    }),
    MAX_RESPONSE_ATTEMPTS,
  );

  async function handleConnectionRequest(event) {
    const requestId = boundedText(event.requestId, '', 200);
    if (!requestId) return;
    let connection;
    try {
      connection = await partmodeAgent.requestConnection(connectionOptions(event));
    } catch (error) {
      await respond({
        requestId,
        status: 'denied',
        error: safeError(error, false),
      });
      return;
    }

    const sessionId = boundedText(connection?.sessionId, '', 200);
    const connectionToken = connection?.connectionToken;
    if (
      !sessionId ||
      sessionId !== event.sessionId ||
      typeof connectionToken !== 'string' ||
      !connectionToken
    ) {
      if (typeof connectionToken === 'string') partmodeAgent.disconnect(connectionToken);
      await respond({
        requestId,
        status: 'denied',
        error: {
          code: 'SESSION_NOT_FOUND',
          message: 'Studio did not create a usable agent session.',
        },
      });
      return;
    }

    bridge.connections.set(sessionId, connectionToken);
    try {
      await respond({
        requestId,
        status: 'approved',
        result: {
          sessionId,
          protocol: boundedText(connection.protocol, partmodeAgent.protocol, 100),
          mode: boundedText(connection.mode, 'preview-required', 50),
          uiProfile: boundedText(connection.uiProfile, '', 100),
          permissionContext: safePermissionContext(connection.permissionContext),
        },
      });
    } catch (error) {
      bridge.connections.delete(sessionId);
      partmodeAgent.disconnect(connectionToken);
      throw error;
    }
  }

  async function handleToolRequest(event) {
    const requestId = boundedText(event.requestId, '', 200);
    if (!requestId) return;
    const connection = eventConnection(bridge.connections, event);
    if (!connection) {
      await respond({
        requestId,
        status: 'error',
        error: {
          code: 'SESSION_NOT_FOUND',
          message: 'The cloud Studio session is not connected.',
        },
      });
      return;
    }
    let result;
    try {
      result = await partmodeAgent.requestTool(
        connection.connectionToken,
        event.tool,
        event.args,
        requestId,
      );
    } catch (error) {
      if (['SESSION_NOT_FOUND', 'SESSION_REVOKED'].includes(error?.code)) {
        removeConnectionToken(bridge.connections, connection.connectionToken);
      }
      await respond({ requestId, status: 'error', error: safeError(error) });
      return;
    }
    await respond({ requestId, status: 'ok', result });
  }

  async function handleSessionClose(event) {
    const connection = eventConnection(bridge.connections, event);
    const closed = connection
      ? partmodeAgent.disconnect(connection.connectionToken)
      : false;
    if (connection) removeConnectionToken(bridge.connections, connection.connectionToken);
    return closed;
  }

  async function handleEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    if (event.type === 'connection.request') return handleConnectionRequest(event);
    if (event.type === 'tool.request') return handleToolRequest(event);
    if (event.type === 'session.close') return handleSessionClose(event);
    if (typeof event.requestId === 'string' && event.requestId) {
      await respond({
        requestId: event.requestId.slice(0, 200),
        status: 'error',
        error: {
          code: 'CLOUD_EVENT_UNSUPPORTED',
          message: 'The browser received an unsupported cloud bridge event.',
        },
      });
    }
  }

  function stop() {
    if (bridge.stopped) return;
    bridge.stopped = true;
    for (const connectionToken of new Set(bridge.connections.values())) {
      partmodeAgent.disconnect(connectionToken);
    }
    bridge.connections.clear();
  }

  function unregister() {
    if (bridge.stopped) return;
    stop();
    void mutate(UNREGISTER_URL, bridge.csrfToken, {
      studioId: bridge.studioId,
      studioToken: bridge.studioToken,
    }, { keepalive: true }).catch(() => {});
  }

  addEventListener('pagehide', unregister, { once: true });

  let consecutiveFailures = 0;
  while (!bridge.stopped) {
    try {
      const payload = await mutate(POLL_URL, bridge.csrfToken, {
        studioId: bridge.studioId,
        studioToken: bridge.studioToken,
      });
      consecutiveFailures = 0;
      const events = Array.isArray(payload.events)
        ? payload.events.slice(0, 100)
        : payload.event
          ? [payload.event]
          : [];
      for (const event of events) {
        if (bridge.stopped) break;
        await handleEvent(event);
      }
      const pollAfterMs = Number.isInteger(payload.pollAfterMs)
        ? Math.max(0, Math.min(5_000, payload.pollAfterMs))
        : events.length
          ? 0
          : 100;
      if (pollAfterMs && !bridge.stopped) await wait(pollAfterMs);
    } catch (error) {
      if (bridge.stopped) break;
      if (
        error instanceof CloudBridgeHttpError &&
        [400, 401, 403, 404, 409, 410, 422].includes(error.status)
      ) {
        stop();
        break;
      }
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_POLL_FAILURES) {
        stop();
        break;
      }
      await wait(backoff(consecutiveFailures));
    }
  }
}
