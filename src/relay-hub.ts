import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  AGENT_KEY_GRANT_CEILINGS,
  type AgentKeyAccess,
} from './account-store.js';

export type { AgentKeyAccess } from './account-store.js';

export interface AgentIdentity {
  /** True when the key was created with the headless execution grant. */
  headless?: boolean;
  accountId: string;
  keyId: string;
  keyLabel: string;
  access: AgentKeyAccess;
  /** Persisted authority from key creation. New product permissions never widen an existing key. */
  grantCeiling: readonly string[];
}

export interface StudioRegistration {
  label: string;
  protocol: string;
  tabId: string;
}

export interface ConnectRequest {
  studioId: string;
  clientLabel?: string;
  mode?: 'read-only' | 'preview-required';
  permissions?: string[];
  operationKinds?: string[];
  maxCommits?: number;
  sessionSeconds?: number;
  uiProfile?: 'partmode.cad.agentic-ui/v1' | 'partmode.cad.visible-projection/v1';
}

export interface BrowserResponse {
  requestId: string;
  status: 'approved' | 'denied' | 'ok' | 'error';
  result?: unknown;
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: unknown;
  };
}

export interface RelayEvent {
  type: 'connection.request' | 'tool.request' | 'session.close';
  requestId: string;
  sessionId: string;
  [key: string]: unknown;
}

interface StudioConnection {
  accountId: string;
  id: string;
  label: string;
  protocol: string;
  tabId: string;
  token: string;
  createdAt: number;
  lastSeenAt: number;
  queue: RelayEvent[];
  waiter: ((events: RelayEvent[]) => void) | null;
  activeSessionId: string | null;
  closed: boolean;
}

interface PendingConnection {
  accountId: string;
  keyId: string;
  studioId: string;
  sessionId: string;
  requestedPermissions: string[];
  requestedMode: 'read-only' | 'preview-required';
  requestedMaxCommits: number;
  requestedUiProfile: string;
  expiresAt: number;
  resolve: (value: AgentSessionSummary) => void;
  reject: (reason: RelayError) => void;
  timer: NodeJS.Timeout;
}

interface PendingToolCall {
  keyId: string;
  sessionId: string;
  resolve: (value: unknown) => void;
  reject: (reason: RelayError) => void;
  timer: NodeJS.Timeout;
}

interface ResponseReceipt {
  accountId: string;
  studioId: string;
  studioTokenHash: string;
  responseHash: string;
  expiresAt: number;
}

interface AgentSession {
  accountId: string;
  keyId: string;
  studioId: string;
  id: string;
  mode: 'read-only' | 'preview-required';
  permissions: string[];
  maxCommits: number;
  remainingCommits: number;
  uiProfile: string;
  expiresAt: number;
  createdAt: number;
  busy: boolean;
}

export interface AgentSessionSummary {
  sessionId: string;
  studioId: string;
  mode: 'read-only' | 'preview-required';
  permissions: string[];
  maxCommits: number;
  remainingCommits: number;
  uiProfile: string;
  expiresAt: string;
  capabilities?: unknown;
  revision?: number;
}

const CAD_PROTOCOL = 'partmode.cad.agent/v1';
const DEFAULT_UI_PROFILE = 'partmode.cad.visible-projection/v1';
const MAX_QUEUE_DEPTH = 32;
const MAX_EVENT_BATCH = 8;
const MAX_TOOL_BYTES = 512 * 1024;
const MAX_BROWSER_RESPONSE_FINGERPRINT_BYTES = 512 * 1024;
const MAX_STUDIOS_PER_ACCOUNT = 8;
const MAX_STUDIOS_GLOBAL = 1_000;
const MAX_PENDING_CONNECTIONS_PER_ACCOUNT = 4;
const MAX_PENDING_CONNECTIONS_GLOBAL = 64;
const MAX_PENDING_TOOL_CALLS_GLOBAL = 256;
const MAX_RESPONSE_RECEIPTS = 1_024;
const RESPONSE_RECEIPT_TTL_MS = 5 * 60 * 1_000;
const STUDIO_STALE_MS = 65_000;
const POLL_TIMEOUT_MS = 20_000;
const APPROVAL_TIMEOUT_MS = 90_000;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_SESSION_SECONDS = 3_600;
const MAX_COMMITS = 20;

const READ_PERMISSIONS = AGENT_KEY_GRANT_CEILINGS['read-only'].granted;
const EDIT_PERMISSIONS = AGENT_KEY_GRANT_CEILINGS.edit.granted;

const ALLOWED_TOOLS = new Set([
  'cad_capabilities',
  'cad_inspect',
  'cad_query',
  'cad_preview',
  'cad_commit',
  'cad_history',
  'cad_artifact',
  'cad_ui',
  'cad_events',
]);

const ARTIFACT_PERMISSION_BY_FORMAT = Object.freeze({
  project: 'artifact.export-project',
  step: 'artifact.export-step',
  stl: 'artifact.export-stl',
  amf: 'artifact.export-amf',
  '3mf': 'artifact.export-3mf',
  'drawing-svg': 'artifact.export-drawing',
  'drawing-dxf': 'artifact.export-drawing',
  'sketch-dxf': 'artifact.export-drawing',
  'flat-dxf': 'artifact.export-drawing',
  png: 'artifact.render',
  webvtt: 'artifact.export-narration',
  srt: 'artifact.export-narration',
} as const);

export class RelayError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(
    code: string,
    message: string,
    options: { status?: number; retryable?: boolean; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = options.status ?? 400;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

function opaqueToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const label = value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
  return label || fallback;
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > 20_000 || depth > 64) {
      throw new RelayError('INVALID_RESPONSE', 'The browser response exceeds the safe structural limit.');
    }
    if (candidate === null) return 'null';
    if (typeof candidate === 'string' || typeof candidate === 'boolean') return JSON.stringify(candidate);
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new RelayError('INVALID_RESPONSE', 'The browser response contains a non-finite number.');
      }
      return JSON.stringify(candidate);
    }
    if (Array.isArray(candidate)) {
      return `[${candidate.map((entry) => visit(entry, depth + 1)).join(',')}]`;
    }
    if (typeof candidate === 'object') {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new RelayError('INVALID_RESPONSE', 'The browser response must contain only JSON values.');
      }
      const entries = Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      return `{${entries.map(([key, entry]) =>
        `${JSON.stringify(key)}:${visit(entry, depth + 1)}`).join(',')}}`;
    }
    throw new RelayError('INVALID_RESPONSE', 'The browser response must contain only JSON values.');
  };
  const canonical = visit(value, 0);
  if (Buffer.byteLength(canonical) > MAX_BROWSER_RESPONSE_FINGERPRINT_BYTES) {
    throw new RelayError('PAYLOAD_TOO_LARGE', 'The browser response exceeds the 512 KiB relay limit.', { status: 413 });
  }
  return canonical;
}

function responseHash(response: BrowserResponse): string {
  return sha256(canonicalJson({
    status: response.status,
    ...(response.result === undefined ? {} : { result: response.result }),
    ...(response.error === undefined ? {} : { error: response.error }),
  }));
}

function capacityError(
  scope: 'account' | 'global',
  resource: 'studios' | 'pending-connections' | 'pending-tool-calls',
  limit: number,
): RelayError {
  return new RelayError(
    'RELAY_CAPACITY_EXCEEDED',
    scope === 'account'
      ? `This account reached the PartMode relay ${resource} limit.`
      : `The PartMode relay reached its global ${resource} limit.`,
    {
      status: scope === 'account' ? 429 : 503,
      retryable: true,
      details: { scope, resource, limit },
    },
  );
}

function publicSession(session: AgentSession, extra: Record<string, unknown> = {}): AgentSessionSummary {
  return {
    sessionId: session.id,
    studioId: session.studioId,
    mode: session.mode,
    permissions: [...session.permissions],
    maxCommits: session.maxCommits,
    remainingCommits: session.remainingCommits,
    uiProfile: session.uiProfile,
    expiresAt: new Date(session.expiresAt).toISOString(),
    ...extra,
  };
}

function isSubset(values: string[], ceiling: readonly string[]): boolean {
  const allowed = new Set(ceiling);
  return values.every((value) => allowed.has(value));
}

function normalizePermissions(
  requested: unknown,
  identity: AgentIdentity,
  mode: 'read-only' | 'preview-required',
): string[] {
  const modeCeiling = identity.access === 'edit' && mode !== 'read-only'
    ? EDIT_PERMISSIONS
    : READ_PERMISSIONS;
  const persistedCeiling = new Set(identity.grantCeiling);
  const ceiling = modeCeiling.filter((permission) => persistedCeiling.has(permission));
  const candidates = Array.isArray(requested)
    ? requested.filter((entry): entry is string => typeof entry === 'string')
    : [...ceiling];
  const unique = [...new Set(candidates)];
  if (!unique.includes('project.read')) unique.unshift('project.read');
  if (!isSubset(unique, ceiling)) {
    throw new RelayError('GRANT_CEILING_EXCEEDED', 'The requested permissions exceed this key or session mode.');
  }
  return unique;
}

function browserError(error: BrowserResponse['error'], fallbackCode: string): RelayError {
  return new RelayError(
    typeof error?.code === 'string' ? error.code : fallbackCode,
    typeof error?.message === 'string' ? error.message : 'The PartMode browser rejected the request.',
    {
      status: 409,
      retryable: error?.retryable === true,
      details: error?.details,
    },
  );
}

export class RelayHub {
  readonly #studios = new Map<string, StudioConnection>();
  readonly #pendingConnections = new Map<string, PendingConnection>();
  readonly #pendingToolCalls = new Map<string, PendingToolCall>();
  readonly #sessions = new Map<string, AgentSession>();
  readonly #responseReceipts = new Map<string, ResponseReceipt>();

  registerStudio(accountId: string, input: StudioRegistration): { studioId: string; studioToken: string } {
    this.#expireStaleStudios();
    if (input.protocol !== CAD_PROTOCOL) {
      throw new RelayError('UNSUPPORTED_PROTOCOL', `This service requires ${CAD_PROTOCOL}.`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.tabId)) {
      throw new RelayError('INVALID_TAB_ID', 'The browser tab identifier is invalid.');
    }
    for (const studio of this.#studios.values()) {
      if (studio.accountId === accountId && studio.tabId === input.tabId) this.#closeStudio(studio, 'BROWSER_REPLACED');
    }
    if (this.#studios.size >= MAX_STUDIOS_GLOBAL) {
      throw capacityError('global', 'studios', MAX_STUDIOS_GLOBAL);
    }
    const accountStudios = [...this.#studios.values()].filter((studio) =>
      !studio.closed && studio.accountId === accountId).length;
    if (accountStudios >= MAX_STUDIOS_PER_ACCOUNT) {
      throw capacityError('account', 'studios', MAX_STUDIOS_PER_ACCOUNT);
    }
    const id = `studio_${opaqueToken(12)}`;
    const token = opaqueToken(32);
    const now = Date.now();
    this.#studios.set(id, {
      accountId,
      id,
      label: safeLabel(input.label, 'This browser'),
      protocol: input.protocol,
      tabId: input.tabId,
      token,
      createdAt: now,
      lastSeenAt: now,
      queue: [],
      waiter: null,
      activeSessionId: null,
      closed: false,
    });
    return { studioId: id, studioToken: token };
  }

  async pollStudio(
    accountId: string,
    studioId: string,
    studioToken: string,
  ): Promise<{ events: RelayEvent[]; pollAfterMs: number }> {
    this.#expireStaleStudios();
    const studio = this.#authorizeStudio(accountId, studioId, studioToken);
    studio.lastSeenAt = Date.now();
    if (studio.queue.length > 0) return { events: studio.queue.splice(0, MAX_EVENT_BATCH), pollAfterMs: 0 };
    if (studio.waiter) {
      throw new RelayError('POLL_ALREADY_ACTIVE', 'Only one browser poll may be active per tab.', { status: 409 });
    }
    const events = await new Promise<RelayEvent[]>((resolve) => {
      const timer = setTimeout(() => {
        if (studio.waiter === deliver) studio.waiter = null;
        resolve([]);
      }, POLL_TIMEOUT_MS);
      const deliver = (value: RelayEvent[]) => {
        clearTimeout(timer);
        studio.waiter = null;
        resolve(value);
      };
      studio.waiter = deliver;
    });
    studio.lastSeenAt = Date.now();
    return { events, pollAfterMs: events.length > 0 ? 0 : 250 };
  }

  respondFromStudio(
    accountId: string,
    studioId: string,
    studioToken: string,
    response: BrowserResponse,
  ): void {
    this.#cleanResponseReceipts();
    if (!/^(?:approval|tool)_[A-Za-z0-9_-]{10,100}$/.test(response.requestId)) {
      throw new RelayError('INVALID_RESPONSE', 'The browser response identifier is invalid.');
    }
    if (!['approved', 'denied', 'ok', 'error'].includes(response.status)) {
      throw new RelayError('INVALID_RESPONSE', 'The browser response status is invalid.');
    }
    const fingerprint = responseHash(response);
    const priorReceipt = this.#responseReceipts.get(response.requestId);
    if (priorReceipt) {
      if (
        priorReceipt.accountId !== accountId ||
        priorReceipt.studioId !== studioId ||
        !secureEqual(priorReceipt.studioTokenHash, sha256(studioToken))
      ) {
        throw new RelayError(
          'RESPONSE_SCOPE_MISMATCH',
          'The response receipt does not belong to this browser tab.',
          { status: 403 },
        );
      }
      if (!secureEqual(priorReceipt.responseHash, fingerprint)) {
        throw new RelayError(
          'RESPONSE_REPLAY_CONFLICT',
          'This browser response identifier was already accepted with different content.',
          { status: 409 },
        );
      }
      return;
    }
    const studio = this.#authorizeStudio(accountId, studioId, studioToken);
    studio.lastSeenAt = Date.now();
    const pendingConnection = this.#pendingConnections.get(response.requestId);
    if (pendingConnection) {
      if (pendingConnection.studioId !== studio.id || pendingConnection.accountId !== accountId) {
        throw new RelayError('RESPONSE_SCOPE_MISMATCH', 'The approval response does not belong to this browser tab.', { status: 403 });
      }
      clearTimeout(pendingConnection.timer);
      this.#pendingConnections.delete(response.requestId);
      if (response.status !== 'approved') {
        studio.activeSessionId = null;
        pendingConnection.reject(browserError(response.error, 'CONNECTION_DENIED'));
        this.#rememberResponseReceipt(accountId, studioId, studioToken, response.requestId, fingerprint);
        return;
      }
      const result = response.result && typeof response.result === 'object'
        ? response.result as Record<string, unknown>
        : {};
      const permissionContext = result.permissionContext && typeof result.permissionContext === 'object'
        ? result.permissionContext as Record<string, unknown>
        : {};
      const permissions = Array.isArray(permissionContext.granted)
        ? permissionContext.granted.filter((entry): entry is string => typeof entry === 'string')
        : [];
      if (
        permissions.length === 0 ||
        !isSubset(permissions, pendingConnection.requestedPermissions) ||
        result.mode !== pendingConnection.requestedMode ||
        result.uiProfile !== pendingConnection.requestedUiProfile
      ) {
        studio.activeSessionId = null;
        pendingConnection.reject(new RelayError(
          'APPROVAL_SCOPE_INVALID',
          'The browser approval did not preserve or narrow the requested authority.',
          { status: 409 },
        ));
        this.#rememberResponseReceipt(accountId, studioId, studioToken, response.requestId, fingerprint);
        return;
      }
      const approvedMaxCommits = Number.isInteger(permissionContext.maxCommits)
        ? Number(permissionContext.maxCommits)
        : pendingConnection.requestedMaxCommits;
      if (approvedMaxCommits < 0 || approvedMaxCommits > pendingConnection.requestedMaxCommits) {
        studio.activeSessionId = null;
        pendingConnection.reject(new RelayError('APPROVAL_SCOPE_INVALID', 'The browser increased the requested commit budget.', { status: 409 }));
        this.#rememberResponseReceipt(accountId, studioId, studioToken, response.requestId, fingerprint);
        return;
      }
      const session: AgentSession = {
        accountId,
        keyId: pendingConnection.keyId,
        studioId,
        id: pendingConnection.sessionId,
        mode: pendingConnection.requestedMode,
        permissions,
        maxCommits: approvedMaxCommits,
        remainingCommits: approvedMaxCommits,
        uiProfile: pendingConnection.requestedUiProfile,
        expiresAt: pendingConnection.expiresAt,
        createdAt: Date.now(),
        busy: false,
      };
      this.#sessions.set(session.id, session);
      studio.activeSessionId = session.id;
      pendingConnection.resolve(publicSession(session, {
        ...(Number.isInteger(result.revision) ? { revision: Number(result.revision) } : {}),
        ...(result.capabilities !== undefined ? { capabilities: result.capabilities } : {}),
      }));
      this.#rememberResponseReceipt(accountId, studioId, studioToken, response.requestId, fingerprint);
      return;
    }

    const pendingCall = this.#pendingToolCalls.get(response.requestId);
    if (!pendingCall) throw new RelayError('REQUEST_NOT_FOUND', 'The relay request is no longer active.', { status: 404 });
    const session = this.#sessions.get(pendingCall.sessionId);
    if (!session || session.studioId !== studio.id) {
      throw new RelayError('RESPONSE_SCOPE_MISMATCH', 'The tool response does not belong to this browser tab.', { status: 403 });
    }
    clearTimeout(pendingCall.timer);
    this.#pendingToolCalls.delete(response.requestId);
    session.busy = false;
    if (response.status === 'ok') pendingCall.resolve(response.result);
    else pendingCall.reject(browserError(response.error, 'CAD_TOOL_FAILED'));
    this.#rememberResponseReceipt(accountId, studioId, studioToken, response.requestId, fingerprint);
  }

  unregisterStudio(accountId: string, studioId: string, studioToken: string): void {
    const studio = this.#authorizeStudio(accountId, studioId, studioToken);
    this.#closeStudio(studio, 'BROWSER_DISCONNECTED');
  }

  listStudios(identity: AgentIdentity): Array<{
    studioId: string;
    label: string;
    protocol: string;
    available: boolean;
  }> {
    this.#expireStaleStudios();
    return [...this.#studios.values()]
      .filter((studio) => !studio.closed && studio.accountId === identity.accountId)
      .map((studio) => ({
        studioId: studio.id,
        label: studio.label,
        protocol: studio.protocol,
        available: studio.activeSessionId === null,
      }));
  }

  async connect(identity: AgentIdentity, input: ConnectRequest): Promise<AgentSessionSummary> {
    this.#expireStaleStudios();
    const studio = this.#studios.get(input.studioId);
    if (!studio || studio.closed || studio.accountId !== identity.accountId) {
      throw new RelayError('STUDIO_NOT_FOUND', 'That online PartMode tab is unavailable.', { status: 404, retryable: true });
    }
    if (studio.activeSessionId) {
      throw new RelayError('STUDIO_BUSY', 'That PartMode tab already has an active agent session.', { status: 409, retryable: true });
    }
    if (this.#pendingConnections.size >= MAX_PENDING_CONNECTIONS_GLOBAL) {
      throw capacityError('global', 'pending-connections', MAX_PENDING_CONNECTIONS_GLOBAL);
    }
    const accountPendingConnections = [...this.#pendingConnections.values()].filter((pending) =>
      pending.accountId === identity.accountId).length;
    if (accountPendingConnections >= MAX_PENDING_CONNECTIONS_PER_ACCOUNT) {
      throw capacityError('account', 'pending-connections', MAX_PENDING_CONNECTIONS_PER_ACCOUNT);
    }
    const mode = input.mode ?? (identity.access === 'edit' ? 'preview-required' : 'read-only');
    if (identity.access === 'read-only' && mode !== 'read-only') {
      throw new RelayError('GRANT_CEILING_EXCEEDED', 'This API key permits read-only sessions only.', { status: 403 });
    }
    const permissions = normalizePermissions(input.permissions, identity, mode);
    const maxCommits = mode === 'read-only'
      ? 0
      : Math.max(0, Math.min(MAX_COMMITS, Number.isInteger(input.maxCommits) ? Number(input.maxCommits) : 3));
    const sessionSeconds = Math.max(
      60,
      Math.min(MAX_SESSION_SECONDS, Number.isInteger(input.sessionSeconds) ? Number(input.sessionSeconds) : 900),
    );
    const operationKinds = Array.isArray(input.operationKinds)
      ? [...new Set(input.operationKinds.filter((entry): entry is string => typeof entry === 'string'))].slice(0, 100)
      : undefined;
    const uiProfile = input.uiProfile ?? DEFAULT_UI_PROFILE;
    const sessionId = `session_${opaqueToken(18)}`;
    const requestId = `approval_${opaqueToken(18)}`;
    const expiresAt = Date.now() + sessionSeconds * 1000;
    studio.activeSessionId = sessionId;

    const promise = new Promise<AgentSessionSummary>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingConnections.delete(requestId);
        if (studio.activeSessionId === sessionId) studio.activeSessionId = null;
        reject(new RelayError('APPROVAL_TIMEOUT', 'The browser approval request timed out.', { status: 408, retryable: true }));
      }, APPROVAL_TIMEOUT_MS);
      this.#pendingConnections.set(requestId, {
        accountId: identity.accountId,
        keyId: identity.keyId,
        studioId: studio.id,
        sessionId,
        requestedPermissions: permissions,
        requestedMode: mode,
        requestedMaxCommits: maxCommits,
        requestedUiProfile: uiProfile,
        expiresAt,
        resolve,
        reject,
        timer,
      });
    });

    try {
      this.#enqueue(studio, {
        type: 'connection.request',
        requestId,
        sessionId,
        clientLabel: input.clientLabel
          ? `${safeLabel(input.clientLabel, 'Agent')} (${identity.keyLabel})`
          : identity.keyLabel,
        keyLabel: identity.keyLabel,
        protocol: CAD_PROTOCOL,
        skillVersion: 'hosted-mcp-v1',
        mode,
        permissionContext: {
          granted: permissions,
          maxCommits,
          ...(operationKinds ? { operationKinds } : {}),
          expiresAt: new Date(expiresAt).toISOString(),
        },
        uiProfile,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    } catch (error) {
      const pending = this.#pendingConnections.get(requestId);
      if (pending) clearTimeout(pending.timer);
      this.#pendingConnections.delete(requestId);
      studio.activeSessionId = null;
      throw error;
    }
    return promise;
  }

  sessionStatus(identity: AgentIdentity, sessionId: string): AgentSessionSummary {
    const session = this.#authorizeAgentSession(identity, sessionId);
    return publicSession(session);
  }

  async callTool(
    identity: AgentIdentity,
    sessionId: string,
    tool: string,
    args: unknown,
  ): Promise<unknown> {
    const session = this.#authorizeAgentSession(identity, sessionId);
    if (!ALLOWED_TOOLS.has(tool)) throw new RelayError('TOOL_NOT_FOUND', `Unsupported PartMode tool "${tool}".`, { status: 404 });
    if (session.busy) throw new RelayError('SESSION_BUSY', 'This CAD session already has an in-flight tool request.', { status: 409, retryable: true });
    if (tool === 'cad_artifact') {
      const record = args && typeof args === 'object' && !Array.isArray(args)
        ? args as Record<string, unknown>
        : {};
      const permission = typeof record.format === 'string'
        ? ARTIFACT_PERMISSION_BY_FORMAT[record.format as keyof typeof ARTIFACT_PERMISSION_BY_FORMAT]
        : undefined;
      if (!permission) {
        throw new RelayError('INVALID_TOOL_ARGUMENTS', 'The artifact format is missing or unsupported.');
      }
      if (!session.permissions.includes(permission)) {
        throw new RelayError('PERMISSION_DENIED', `Permission "${permission}" is required for this artifact.`, { status: 403 });
      }
    }
    if (session.mode === 'read-only') {
      const record = args && typeof args === 'object' ? args as Record<string, unknown> : {};
      if (
        tool === 'cad_preview' ||
        tool === 'cad_commit' ||
        (tool === 'cad_history' && ['undo', 'redo'].includes(String(record.action))) ||
        (tool === 'cad_ui' && record.action === 'apply')
      ) {
        throw new RelayError('PERMISSION_DENIED', 'This browser-approved session is read only.', { status: 403 });
      }
    }
    if (tool === 'cad_commit' && session.remainingCommits <= 0) {
      throw new RelayError('COMMIT_BUDGET_EXHAUSTED', 'This session has no remaining approved commits.', { status: 403 });
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(args ?? {});
    } catch {
      throw new RelayError('INVALID_TOOL_ARGUMENTS', 'Tool arguments must be JSON serializable.');
    }
    if (Buffer.byteLength(serialized) > MAX_TOOL_BYTES) {
      throw new RelayError('PAYLOAD_TOO_LARGE', 'The tool request exceeds the 512 KiB relay limit.', { status: 413 });
    }
    if (this.#pendingToolCalls.size >= MAX_PENDING_TOOL_CALLS_GLOBAL) {
      throw capacityError('global', 'pending-tool-calls', MAX_PENDING_TOOL_CALLS_GLOBAL);
    }
    const studio = this.#studios.get(session.studioId);
    if (!studio || studio.closed) {
      this.#closeSession(session, 'RELAY_PEER_OFFLINE');
      throw new RelayError('RELAY_PEER_OFFLINE', 'The PartMode browser tab is offline.', { status: 409, retryable: true });
    }
    const requestId = `tool_${randomUUID()}`;
    session.busy = true;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingToolCalls.delete(requestId);
        session.busy = false;
        reject(new RelayError(
          'TOOL_OUTCOME_UNKNOWN',
          'The browser did not settle this tool request before the relay timeout. Inspect current session state before retrying.',
          { status: 504, retryable: false },
        ));
      }, TOOL_TIMEOUT_MS);
      this.#pendingToolCalls.set(requestId, {
        keyId: identity.keyId,
        sessionId,
        resolve: (value) => {
          if (tool === 'cad_commit') session.remainingCommits = Math.max(0, session.remainingCommits - 1);
          resolve(value);
        },
        reject,
        timer,
      });
    });
    try {
      this.#enqueue(studio, {
        type: 'tool.request',
        requestId,
        sessionId,
        tool,
        args: args ?? {},
      });
    } catch (error) {
      const pending = this.#pendingToolCalls.get(requestId);
      if (pending) clearTimeout(pending.timer);
      this.#pendingToolCalls.delete(requestId);
      session.busy = false;
      throw error;
    }
    return promise;
  }

  disconnect(identity: AgentIdentity, sessionId: string, reason = 'Agent disconnected'): void {
    const session = this.#authorizeAgentSession(identity, sessionId);
    this.#closeSession(session, reason);
  }

  revokeKey(keyId: string): void {
    for (const [requestId, pending] of [...this.#pendingConnections.entries()]) {
      if (pending.keyId !== keyId) continue;
      clearTimeout(pending.timer);
      this.#pendingConnections.delete(requestId);
      pending.reject(new RelayError('KEY_REVOKED', 'The agent key was revoked.', { status: 401 }));
      const studio = this.#studios.get(pending.studioId);
      if (studio?.activeSessionId === pending.sessionId) studio.activeSessionId = null;
    }
    for (const session of [...this.#sessions.values()]) {
      if (session.keyId === keyId) this.#closeSession(session, 'Agent key revoked');
    }
  }

  revokeAccount(accountId: string): void {
    for (const studio of [...this.#studios.values()]) {
      if (studio.accountId === accountId) this.#closeStudio(studio, 'ACCOUNT_REVOKED');
    }
  }

  counts(): { studios: number; sessions: number; pending: number } {
    this.#expireStaleStudios();
    return {
      studios: [...this.#studios.values()].filter((studio) => !studio.closed).length,
      sessions: this.#sessions.size,
      pending: this.#pendingConnections.size + this.#pendingToolCalls.size,
    };
  }

  close(): void {
    for (const studio of [...this.#studios.values()]) this.#closeStudio(studio, 'SERVER_RESTARTED');
    this.#studios.clear();
    this.#responseReceipts.clear();
  }

  #authorizeStudio(accountId: string, studioId: string, token: string): StudioConnection {
    const studio = this.#studios.get(studioId);
    if (!studio || studio.closed || studio.accountId !== accountId || !secureEqual(studio.token, token)) {
      throw new RelayError('STUDIO_NOT_FOUND', 'The browser relay registration is invalid or offline.', { status: 404 });
    }
    return studio;
  }

  #authorizeAgentSession(identity: AgentIdentity, sessionId: string): AgentSession {
    const session = this.#sessions.get(sessionId);
    if (!session || session.accountId !== identity.accountId || session.keyId !== identity.keyId) {
      throw new RelayError('SESSION_NOT_FOUND', 'The browser-approved CAD session was not found.', { status: 404 });
    }
    if (session.expiresAt <= Date.now()) {
      this.#closeSession(session, 'Session expired');
      throw new RelayError('SESSION_EXPIRED', 'The browser-approved CAD session expired.', { status: 401 });
    }
    return session;
  }

  #rememberResponseReceipt(
    accountId: string,
    studioId: string,
    studioToken: string,
    requestId: string,
    fingerprint: string,
  ): void {
    this.#cleanResponseReceipts();
    while (this.#responseReceipts.size >= MAX_RESPONSE_RECEIPTS) {
      const oldest = this.#responseReceipts.keys().next().value;
      if (oldest === undefined) break;
      this.#responseReceipts.delete(oldest);
    }
    this.#responseReceipts.set(requestId, {
      accountId,
      studioId,
      studioTokenHash: sha256(studioToken),
      responseHash: fingerprint,
      expiresAt: Date.now() + RESPONSE_RECEIPT_TTL_MS,
    });
  }

  #cleanResponseReceipts(now = Date.now()): void {
    for (const [requestId, receipt] of this.#responseReceipts) {
      if (receipt.expiresAt <= now) this.#responseReceipts.delete(requestId);
    }
  }

  #enqueue(studio: StudioConnection, event: RelayEvent): void {
    if (studio.closed) throw new RelayError('RELAY_PEER_OFFLINE', 'The PartMode browser tab is offline.', { status: 409, retryable: true });
    if (studio.waiter) {
      const waiter = studio.waiter;
      studio.waiter = null;
      waiter([event]);
      return;
    }
    if (studio.queue.length >= MAX_QUEUE_DEPTH) {
      this.#closeStudio(studio, 'RELAY_QUEUE_OVERFLOW');
      throw new RelayError('RELAY_QUEUE_OVERFLOW', 'The browser relay queue exceeded its safe limit.', { status: 503 });
    }
    studio.queue.push(event);
  }

  #closeSession(session: AgentSession, reason: string): void {
    this.#sessions.delete(session.id);
    const studio = this.#studios.get(session.studioId);
    if (studio?.activeSessionId === session.id) {
      studio.activeSessionId = null;
      try {
        this.#enqueue(studio, {
          type: 'session.close',
          requestId: `close_${opaqueToken(10)}`,
          sessionId: session.id,
          reason: safeLabel(reason, 'Session closed'),
        });
      } catch {
        // The peer is already unavailable; there is no payload to retain.
      }
    }
    for (const [requestId, pending] of this.#pendingToolCalls) {
      if (pending.sessionId !== session.id) continue;
      clearTimeout(pending.timer);
      this.#pendingToolCalls.delete(requestId);
      pending.reject(new RelayError(
        'TOOL_OUTCOME_UNKNOWN',
        `${reason}. A tool request was in flight; inspect current CAD state before deciding whether to retry.`,
        { status: 409, retryable: false },
      ));
    }
  }

  #closeStudio(studio: StudioConnection, reason: string): void {
    if (studio.closed) return;
    studio.closed = true;
    this.#studios.delete(studio.id);
    if (studio.waiter) {
      const waiter = studio.waiter;
      studio.waiter = null;
      waiter([]);
    }
    for (const [requestId, pending] of this.#pendingConnections) {
      if (pending.studioId !== studio.id) continue;
      clearTimeout(pending.timer);
      this.#pendingConnections.delete(requestId);
      pending.reject(new RelayError('RELAY_PEER_OFFLINE', reason, { status: 409, retryable: true }));
    }
    if (studio.activeSessionId) {
      const session = this.#sessions.get(studio.activeSessionId);
      if (session) this.#closeSession(session, reason);
    }
  }

  #expireStaleStudios(): void {
    const now = Date.now();
    this.#cleanResponseReceipts(now);
    for (const studio of [...this.#studios.values()]) {
      if (now - studio.lastSeenAt > STUDIO_STALE_MS) this.#closeStudio(studio, 'RELAY_PEER_OFFLINE');
    }
    for (const session of [...this.#sessions.values()]) {
      if (session.expiresAt <= now) this.#closeSession(session, 'Session expired');
    }
  }
}
