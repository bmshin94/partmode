// Durable server-side CAD sessions.
//
// The browser relay path requires a live, signed-in PartMode tab and one
// visible approval per session. Headless sessions are the deliberate second
// path: an agent key whose owner explicitly opted in when creating it
// (headless grant, edit access only, never mutable afterward) may open
// sessions that execute on the server's shared CAD runtime with no browser
// anywhere. Consent moves from per-session approval to per-key opt-in; the
// permission ceilings, session expiry bounds, and commit budgets stay the
// same as the relay. Committed documents persist in the account store, so
// projects outlive sessions, processes, and deploys.
import { randomBytes } from 'node:crypto';
import type { AccountStore } from './account-store.js';
import { createHeadlessCadRuntime, type HeadlessCadRuntime } from './headless/agent-host.js';
import { RelayError, type AgentIdentity } from './relay-hub.js';

const SESSION_PREFIX = 'hsession_';
const MAX_SESSIONS_PER_ACCOUNT = 4;
const MAX_GLOBAL_SESSIONS = 128;
const MAX_GLOBAL_PENDING_EXECUTIONS = 16;
const MAX_PERSISTED_PROJECTS_PER_ACCOUNT = 32;
const MAX_REQUESTS_PER_ACCOUNT_WINDOW = 120;
const REQUEST_WINDOW_MS = 60_000;
const MAX_REQUEST_WINDOW_ENTRIES = 10_000;
const MAX_COMMITS = 20;
const MAX_SESSION_SECONDS = 3600;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const READ_CEILING = Object.freeze(['project.read']);
const EDIT_CEILING = Object.freeze(['project.read', 'project.edit']);

export interface HeadlessOpenInput {
  projectId: string;
  name?: string;
  units?: string;
  mode?: 'read-only' | 'preview-required';
  permissions?: string[];
  operationKinds?: string[];
  maxCommits?: number;
  sessionSeconds?: number;
}

export interface HeadlessSessionSummary {
  sessionId: string;
  projectId: string;
  projectName: string;
  revision: number;
  documentHash: string | null;
  mode: 'read-only' | 'preview-required';
  permissions: string[];
  maxCommits: number;
  remainingCommits: number;
  expiresAt: string;
  execution: 'server-headless';
  settlementError?: string;
}

interface HeadlessSession {
  sessionId: string;
  accountId: string;
  keyId: string;
  projectId: string;
  projectName: string;
  mode: 'read-only' | 'preview-required';
  service: any;
  permissionContext: Record<string, unknown>;
  permissions: string[];
  maxCommits: number;
  remainingCommits: number;
  persistedRevision: number;
  expiresAtMs: number;
  /** Set when a commit applied in memory but its persist failed. The
   * durable store is behind the service; further mutation is refused so a
   * later reopen cannot silently resurrect pre-failure geometry. */
  settlementError: string | null;
  /** A retained in-flight operation keeps a reference to this object after
   * the map entry is removed. Marking the reason lets the post-await check
   * fail closed instead of returning data produced after revocation. */
  closedReason: HeadlessSessionCloseReason | null;
  reservesNewProject: boolean;
}

type HeadlessSessionCloseReason =
  | 'ACCOUNT_REVOKED'
  | 'AUTHORITY_UNAVAILABLE'
  | 'DISCONNECTED'
  | 'KEY_REVOKED'
  | 'OPEN_FAILED'
  | 'SERVER_RESTARTED'
  | 'SESSION_EXPIRED';

export interface HeadlessSessionLimits {
  maxSessionsPerAccount: number;
  maxGlobalSessions: number;
  maxGlobalPendingExecutions: number;
  maxPersistedProjectsPerAccount: number;
  maxRequestsPerAccountWindow: number;
  requestWindowMs: number;
  maxRequestWindowEntries: number;
}

export interface HeadlessSessionManagerOptions {
  store: AccountStore;
  staticDir?: string;
  /** Dependency seams keep the safety policy deterministically testable.
   * Production uses the exact shared runtime and wall clock defaults. */
  runtimeFactory?: () => Promise<HeadlessCadRuntime>;
  now?: () => number;
  limits?: Partial<HeadlessSessionLimits>;
}

const DEFAULT_LIMITS: Readonly<HeadlessSessionLimits> = Object.freeze({
  maxSessionsPerAccount: MAX_SESSIONS_PER_ACCOUNT,
  maxGlobalSessions: MAX_GLOBAL_SESSIONS,
  maxGlobalPendingExecutions: MAX_GLOBAL_PENDING_EXECUTIONS,
  maxPersistedProjectsPerAccount: MAX_PERSISTED_PROJECTS_PER_ACCOUNT,
  maxRequestsPerAccountWindow: MAX_REQUESTS_PER_ACCOUNT_WINDOW,
  requestWindowMs: REQUEST_WINDOW_MS,
  maxRequestWindowEntries: MAX_REQUEST_WINDOW_ENTRIES,
});

export function isHeadlessSessionId(sessionId: unknown): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(SESSION_PREFIX);
}

export class HeadlessSessionManager {
  #store: AccountStore;
  #staticDir: string | undefined;
  #runtimeFactory: () => Promise<HeadlessCadRuntime>;
  #runtimePromise: Promise<HeadlessCadRuntime> | null = null;
  #now: () => number;
  #limits: Readonly<HeadlessSessionLimits>;
  #sessions = new Map<string, HeadlessSession>();
  #activeSessionExecutions = new Set<string>();
  #pendingExecutions = 0;
  #requestWindows = new Map<string, { count: number; resetAtMs: number }>();
  #requestSequence = 0;
  #closed = false;

  constructor(options: HeadlessSessionManagerOptions) {
    this.#store = options.store;
    this.#staticDir = options.staticDir;
    this.#runtimeFactory = options.runtimeFactory ?? (() => createHeadlessCadRuntime(this.#staticDir ? { staticDir: this.#staticDir } : {}));
    this.#now = options.now ?? Date.now;
    this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    for (const [name, value] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`Headless session limit ${name} must be a positive integer.`);
      }
    }
  }

  async #runtime(): Promise<HeadlessCadRuntime> {
    if (this.#closed) {
      throw new RelayError('HEADLESS_UNAVAILABLE', 'Headless CAD execution is shutting down.', { status: 503, retryable: true });
    }
    if (!this.#runtimePromise) {
      const pending = this.#runtimeFactory();
      this.#runtimePromise = pending;
      void pending.catch(() => {
        if (this.#runtimePromise === pending) this.#runtimePromise = null;
      });
    }
    return this.#runtimePromise;
  }

  #expireStale(): void {
    const now = this.#now();
    for (const session of this.#sessions.values()) {
      if (session.expiresAtMs <= now) this.#closeSession(session, 'SESSION_EXPIRED');
    }
  }

  #closeSession(session: HeadlessSession, reason: HeadlessSessionCloseReason): void {
    if (!session.closedReason) session.closedReason = reason;
    if (this.#sessions.get(session.sessionId) === session) this.#sessions.delete(session.sessionId);
  }

  #closedSessionError(reason: HeadlessSessionCloseReason): RelayError {
    if (reason === 'KEY_REVOKED' || reason === 'ACCOUNT_REVOKED') {
      return new RelayError(reason, 'The authority for this headless CAD session was revoked.', { status: 401 });
    }
    if (reason === 'SESSION_EXPIRED') {
      return new RelayError('SESSION_EXPIRED', 'This headless CAD session expired.', { status: 410, retryable: true });
    }
    if (reason === 'SERVER_RESTARTED' || reason === 'AUTHORITY_UNAVAILABLE') {
      return new RelayError('HEADLESS_UNAVAILABLE', 'The headless CAD session is no longer available.', { status: 503, retryable: true });
    }
    return new RelayError('SESSION_NOT_FOUND', 'That headless CAD session is unavailable.', { status: 404, retryable: true });
  }

  #assertStoredAuthority(identity: AgentIdentity, session?: HeadlessSession): void {
    let key;
    try {
      key = this.#store.listAgentKeys(identity.accountId).find((entry) => entry.id === identity.keyId);
    } catch {
      if (session) this.#closeSession(session, 'AUTHORITY_UNAVAILABLE');
      throw this.#closedSessionError('AUTHORITY_UNAVAILABLE');
    }
    const expiresAtMs = key?.expiresAt ? Date.parse(key.expiresAt) : Number.POSITIVE_INFINITY;
    if (
      !key ||
      key.accountId !== identity.accountId ||
      key.revokedAt !== null ||
      expiresAtMs <= this.#now() ||
      key.headless !== true ||
      identity.headless !== true
    ) {
      if (session) this.#closeSession(session, 'KEY_REVOKED');
      throw this.#closedSessionError('KEY_REVOKED');
    }
  }

  #assertContinuation(identity: AgentIdentity, session: HeadlessSession): void {
    if (session.closedReason) throw this.#closedSessionError(session.closedReason);
    if (this.#closed) {
      this.#closeSession(session, 'SERVER_RESTARTED');
      throw this.#closedSessionError('SERVER_RESTARTED');
    }
    if (session.expiresAtMs <= this.#now()) {
      this.#closeSession(session, 'SESSION_EXPIRED');
      throw this.#closedSessionError('SESSION_EXPIRED');
    }
    if (this.#sessions.get(session.sessionId) !== session) {
      throw this.#closedSessionError('DISCONNECTED');
    }
    this.#assertStoredAuthority(identity, session);
  }

  #takeRequest(accountId: string): void {
    if (this.#closed) {
      throw new RelayError('HEADLESS_UNAVAILABLE', 'Headless CAD execution is shutting down.', { status: 503, retryable: true });
    }
    const now = this.#now();
    for (const [id, window] of this.#requestWindows) {
      if (window.resetAtMs <= now) this.#requestWindows.delete(id);
    }
    let window = this.#requestWindows.get(accountId);
    if (!window) {
      if (this.#requestWindows.size >= this.#limits.maxRequestWindowEntries) {
        throw new RelayError('HEADLESS_RATE_LIMITED', 'Headless CAD request capacity is temporarily full.', { status: 429, retryable: true });
      }
      window = { count: 0, resetAtMs: now + this.#limits.requestWindowMs };
      this.#requestWindows.set(accountId, window);
    }
    if (window.count >= this.#limits.maxRequestsPerAccountWindow) {
      throw new RelayError('HEADLESS_RATE_LIMITED', 'This account exceeded the headless CAD request allowance.', {
        status: 429,
        retryable: true,
        details: { retryAfterMs: Math.max(1, window.resetAtMs - now) },
      });
    }
    window.count += 1;
  }

  #beginExecution(identity: AgentIdentity, sessionId: string): HeadlessSession {
    this.#takeRequest(identity.accountId);
    const session = this.#ownedSession(identity, sessionId);
    if (this.#activeSessionExecutions.has(sessionId)) {
      throw new RelayError('SESSION_BUSY', 'This headless CAD session already has a request in flight.', { status: 409, retryable: true });
    }
    if (this.#pendingExecutions >= this.#limits.maxGlobalPendingExecutions) {
      throw new RelayError('HEADLESS_CAPACITY_EXCEEDED', 'The global headless CAD execution queue is full.', { status: 429, retryable: true });
    }
    this.#activeSessionExecutions.add(sessionId);
    this.#pendingExecutions += 1;
    return session;
  }

  #endExecution(session: HeadlessSession): void {
    if (this.#activeSessionExecutions.delete(session.sessionId)) {
      this.#pendingExecutions = Math.max(0, this.#pendingExecutions - 1);
    }
  }

  /**
   * A headless session belongs to the exact key that opened it, mirroring
   * the relay's account-and-key check. Binding to the account alone would
   * let a sibling key without the headless grant drive a granted key's
   * session, and would leave sessions alive after their key is revoked.
   */
  #ownedSession(identity: AgentIdentity, sessionId: string): HeadlessSession {
    this.#expireStale();
    const session = this.#sessions.get(sessionId);
    if (!session || session.accountId !== identity.accountId || session.keyId !== identity.keyId) {
      throw new RelayError('SESSION_NOT_FOUND', 'That headless CAD session is unavailable.', { status: 404, retryable: true });
    }
    if (identity.headless !== true) {
      throw new RelayError('HEADLESS_NOT_GRANTED', 'This agent key does not carry the headless execution grant.', { status: 403 });
    }
    this.#assertStoredAuthority(identity, session);
    return session;
  }

  /** Close every live session opened by a revoked key. */
  revokeKey(keyId: string): void {
    for (const session of this.#sessions.values()) {
      if (session.keyId === keyId) this.#closeSession(session, 'KEY_REVOKED');
    }
  }

  /** Close every live session and discard rate state for an account that
   * signed out or was deleted. In-flight requests retain the marked object
   * only long enough to fail their post-await authority check. */
  revokeAccount(accountId: string): void {
    for (const session of this.#sessions.values()) {
      if (session.accountId === accountId) this.#closeSession(session, 'ACCOUNT_REVOKED');
    }
    this.#requestWindows.delete(accountId);
  }

  async open(identity: AgentIdentity, input: HeadlessOpenInput): Promise<HeadlessSessionSummary> {
    this.#takeRequest(identity.accountId);
    if (identity.headless !== true) {
      throw new RelayError(
        'HEADLESS_NOT_GRANTED',
        'This agent key was not created with the headless execution grant. Create a new key with headless enabled, or connect through a browser studio.',
        { status: 403 },
      );
    }
    this.#assertStoredAuthority(identity);
    this.#expireStale();
    if (typeof input.projectId !== 'string' || !PROJECT_ID_PATTERN.test(input.projectId)) {
      throw new RelayError('INVALID_ARGUMENTS', 'projectId must match ' + String(PROJECT_ID_PATTERN), { status: 400 });
    }
    const accountSessions = [...this.#sessions.values()].filter((session) => session.accountId === identity.accountId);
    if (accountSessions.length >= this.#limits.maxSessionsPerAccount) {
      throw new RelayError('CAPACITY_EXCEEDED', 'This account already has the maximum number of headless sessions.', { status: 429, retryable: true });
    }
    if (this.#sessions.size >= this.#limits.maxGlobalSessions) {
      throw new RelayError('HEADLESS_CAPACITY_EXCEEDED', 'The global headless CAD session capacity is full.', { status: 429, retryable: true });
    }
    if (accountSessions.some((session) => session.projectId === input.projectId)) {
      throw new RelayError('PROJECT_BUSY', 'That project already has an active headless session.', { status: 409, retryable: true });
    }

    // Read and reserve the durable-project quota before the first await.
    // Pending opens count as new projects so concurrent requests cannot all
    // observe one remaining slot and grow SQLite past the account ceiling.
    const stored = this.#store.getHeadlessDocument(identity.accountId, input.projectId);
    const reservesNewProject = stored === null;
    if (reservesNewProject) {
      const persistedProjects = this.#store.listHeadlessDocuments(identity.accountId).length;
      const pendingNewProjects = accountSessions.filter((session) => session.reservesNewProject).length;
      if (persistedProjects + pendingNewProjects >= this.#limits.maxPersistedProjectsPerAccount) {
        throw new RelayError(
          'HEADLESS_PROJECT_QUOTA_EXCEEDED',
          'This account has reached its durable headless project quota. Reopen an existing project; deleting the account removes every durable project.',
          { status: 409 },
        );
      }
    }

    const mode = input.mode ?? 'preview-required';
    if (identity.access !== 'edit' && mode !== 'read-only') {
      throw new RelayError('GRANT_CEILING_EXCEEDED', 'This API key permits read-only sessions only.', { status: 403 });
    }
    const modeCeiling = mode === 'read-only' ? READ_CEILING : EDIT_CEILING;
    const persistedCeiling = new Set(identity.grantCeiling);
    const ceiling = modeCeiling.filter((permission) => persistedCeiling.has(permission));
    const requested = Array.isArray(input.permissions)
      ? input.permissions.filter((entry): entry is string => typeof entry === 'string')
      : [...ceiling];
    const permissions = [...new Set(['project.read', ...requested])];
    if (!permissions.every((entry) => ceiling.includes(entry))) {
      throw new RelayError('GRANT_CEILING_EXCEEDED', 'The requested permissions exceed this key or session mode. Headless sessions carry no ui.* surface.', { status: 403 });
    }
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

    // Reserve the project and the account slot synchronously, before the
    // first await. The shared runtime takes seconds to boot the wasm kernel
    // on the first open after a restart, and concurrent reconnects would
    // otherwise all pass the checks above and open duplicate sessions on
    // one project, whose commits then overwrite each other in the store.
    const reservationId = `${SESSION_PREFIX}${randomBytes(18).toString('base64url')}`;
    const reservation: HeadlessSession = {
      sessionId: reservationId,
      accountId: identity.accountId,
      keyId: identity.keyId,
      projectId: input.projectId,
      projectName: input.name || input.projectId,
      mode,
      service: null,
      permissions,
      maxCommits,
      remainingCommits: maxCommits,
      persistedRevision: 0,
      expiresAtMs: this.#now() + sessionSeconds * 1000,
      permissionContext: {},
      settlementError: null,
      closedReason: null,
      reservesNewProject,
    };
    this.#sessions.set(reservationId, reservation);

    let runtime: HeadlessCadRuntime;
    try {
      runtime = await this.#runtime();
      this.#assertContinuation(identity, reservation);
    } catch (error) {
      if (!reservation.closedReason) this.#closeSession(reservation, 'OPEN_FAILED');
      throw error;
    }
    try {
      const service = runtime.createService({
        projectId: input.projectId,
        name: input.name || stored?.name || input.projectId,
        ...(input.units ? { units: input.units } : {}),
      });
      // synchronize() with an entry writes a journal record carrying the
      // canonical document hash, for the restored and the fresh path alike.
      if (stored) {
        let restored: Record<string, unknown>;
        try {
          restored = JSON.parse(stored.documentJson) as Record<string, unknown>;
        } catch {
          throw new RelayError('DOCUMENT_UNREADABLE', 'The stored project document could not be parsed.', { status: 500 });
        }
        service.synchronize(restored, stored.revision, { label: 'Open headless project', actor: 'agent' });
      } else {
        service.synchronize(service.snapshot(), 0, { label: 'Create headless project', actor: 'agent' });
      }
      const projectName = stored?.name || input.name || input.projectId;
      const initialHash = this.#journalHash(service);
      if (!stored && initialHash) {
        this.#store.putHeadlessDocument(identity.accountId, {
          projectId: input.projectId,
          name: projectName,
          revision: 0,
          documentJson: JSON.stringify(service.snapshot()),
          documentHash: initialHash,
        });
      }

      reservation.service = service;
      reservation.projectName = projectName;
      reservation.persistedRevision = stored?.revision ?? 0;
      reservation.permissionContext = {
        granted: permissions,
        maxCommits,
        ...(operationKinds ? { operationKinds } : {}),
        expiresAt: new Date(reservation.expiresAtMs).toISOString(),
      };
      reservation.reservesNewProject = false;
      this.#assertContinuation(identity, reservation);
      return this.#summary(reservation);
    } catch (error) {
      if (!reservation.closedReason) this.#closeSession(reservation, 'OPEN_FAILED');
      throw error;
    }
  }

  #summary(session: HeadlessSession): HeadlessSessionSummary {
    return {
      sessionId: session.sessionId,
      projectId: session.projectId,
      projectName: session.projectName,
      revision: session.service.revision,
      documentHash: this.#journalHash(session.service),
      mode: session.mode,
      permissions: [...session.permissions],
      maxCommits: session.maxCommits,
      remainingCommits: session.remainingCommits,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      execution: 'server-headless',
      ...(session.settlementError ? { settlementError: session.settlementError } : {}),
    };
  }

  #journalHash(service: any): string | null {
    const entry = service.journal?.[service.journal.length - 1];
    return typeof entry?.documentHash === 'string' ? entry.documentHash : null;
  }

  sessionStatus(identity: AgentIdentity, sessionId: string): HeadlessSessionSummary {
    this.#takeRequest(identity.accountId);
    return this.#summary(this.#ownedSession(identity, sessionId));
  }

  disconnect(identity: AgentIdentity, sessionId: string): void {
    this.#takeRequest(identity.accountId);
    const session = this.#ownedSession(identity, sessionId);
    this.#closeSession(session, 'DISCONNECTED');
  }

  async callTool(identity: AgentIdentity, sessionId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const session = this.#beginExecution(identity, sessionId);
    try {
      const mutating = tool === 'cad_commit' || (tool === 'cad_history' && args.action !== 'list' && args.action !== 'changesSince');
      if (mutating && session.settlementError) {
        throw new RelayError(
          'COMMIT_SETTLEMENT_FAILED',
          'A previous commit applied in memory but could not be persisted, so this session accepts no further changes. Reopen the project to continue from the last durable revision.',
          { status: 409, details: { settlementError: session.settlementError, durableRevision: session.persistedRevision } },
        );
      }
      // The commit budget is session state. CadCommandService decrements the
      // permission context it is handed, but createCadAgentRequest deep-clones
      // that context per request, so the service's own decrement cannot
      // survive the call. The relay keeps its own counter for the same reason.
      if (tool === 'cad_commit' && session.remainingCommits <= 0) {
        throw new RelayError('COMMIT_BUDGET_EXHAUSTED', 'This headless session has no commits remaining.', { status: 403 });
      }

      let payload: Record<string, unknown>;
      if (tool === 'cad_capabilities') payload = { kind: 'capabilities', ...(args.capabilityQuery ? { capabilityQuery: args.capabilityQuery } : {}) };
      else if (tool === 'cad_inspect') payload = { kind: 'inspect', query: args.query || {} };
      else if (tool === 'cad_query') payload = { kind: 'query', query: args.query || {} };
      else if (tool === 'cad_preview') payload = { kind: 'preview', transaction: args.transaction };
      else if (tool === 'cad_commit') payload = { kind: 'commit', previewId: args.previewId };
      else if (tool === 'cad_history') {
        const { sessionId: _ignoredSessionId, expectedRevision: _ignoredRevision, ...historyArgs } = args;
        payload = { kind: 'history', ...historyArgs, ...(Number.isInteger(args.expectedRevision) ? { expectedRevision: args.expectedRevision } : {}) };
      } else if (tool === 'cad_ui' || tool === 'cad_events' || tool === 'cad_artifact') {
        throw new RelayError('VISIBLE_STUDIO_REQUIRED', `The ${tool} tool needs a visible browser studio; headless sessions have no UI surface.`, { status: 400 });
      } else {
        throw new RelayError('TOOL_NOT_FOUND', `Unknown PartMode tool "${tool}".`, { status: 404 });
      }

      const runtime = await this.#runtime();
      this.#assertContinuation(identity, session);
      const envelope = runtime.module.createCadAgentRequest({
        requestId: `hreq_${++this.#requestSequence}`,
        sessionId: session.sessionId,
        projectId: session.projectId,
        ...(Number.isInteger(args.expectedRevision) ? { expectedRevision: args.expectedRevision } : {}),
        permissionContext: { ...session.permissionContext, maxCommits: session.remainingCommits },
        payload,
      });
      const response = await session.service.request(envelope);

      // Revocation, account deletion, disconnect, expiry, or shutdown may
      // happen while the shared kernel is working. Never return or persist
      // that result unless the exact key and session are still authoritative.
      this.#assertContinuation(identity, session);

      // Match the browser path: a non-ok envelope is a typed tool failure, not
      // a successful reply carrying diagnostics.
      if (response?.status !== 'ok') {
        const diagnostic = response?.diagnostics?.[0] || {};
        throw new RelayError(
          typeof diagnostic.code === 'string' ? diagnostic.code : 'CAD_REQUEST_FAILED',
          typeof diagnostic.message === 'string' ? diagnostic.message : 'The CAD service rejected the request.',
          {
            status: response?.status === 'conflict' ? 409 : 400,
            ...(diagnostic.details === undefined ? {} : { details: diagnostic.details }),
          },
        );
      }

      if (tool === 'cad_commit') session.remainingCommits = Math.max(0, session.remainingCommits - 1);

    // Commit and history mutations advance the service revision; persist
    // exactly those, using the journal's canonical document hash so the
    // stored record matches what the service attests. The mutation has
    // already applied in memory, so a persist failure is reported as an
    // applied-but-unsettled commit rather than a plain error, and the
    // session is sealed against further changes.
      if (session.service.revision > session.persistedRevision) {
        const documentHash = this.#journalHash(session.service);
        if (documentHash) {
          try {
            this.#store.putHeadlessDocument(session.accountId, {
              projectId: session.projectId,
              name: session.projectName,
              revision: session.service.revision,
              documentJson: JSON.stringify(session.service.snapshot()),
              documentHash,
            });
            session.persistedRevision = session.service.revision;
          } catch (error) {
            session.settlementError = error instanceof Error ? error.message : String(error);
            throw new RelayError(
              'COMMIT_SETTLEMENT_FAILED',
              'The CAD change applied, but it could not be stored durably.',
              {
                status: 500,
                details: {
                  commitApplied: true,
                  revision: session.service.revision,
                  durableRevision: session.persistedRevision,
                  documentHash,
                  settlementError: session.settlementError,
                  repairOptions: [{ kind: 'reopen-project' }],
                },
              },
            );
          }
        }
      }

      // Match the browser tool contract: capabilities returns the bare
      // manifest, mutations return the result, reads carry their revision.
      if (tool === 'cad_capabilities') return response.result;
      if (tool === 'cad_preview' || tool === 'cad_commit' || tool === 'cad_history') return response.result;
      return { revision: response.revision, result: response.result };
    } catch (error) {
      // Worker disposal rejects pending RPC promises before the post-await
      // authority check can run. Preserve the public lifecycle contract when
      // shutdown or revocation caused that rejection; unrelated kernel errors
      // still propagate unchanged.
      if (session.closedReason) throw this.#closedSessionError(session.closedReason);
      if (this.#closed) throw this.#closedSessionError('SERVER_RESTARTED');
      throw error;
    } finally {
      this.#endExecution(session);
    }
  }

  async exportStep(identity: AgentIdentity, sessionId: string, bodyIds?: string[]): Promise<unknown> {
    const session = this.#beginExecution(identity, sessionId);
    try {
      const runtime = await this.#runtime();
      this.#assertContinuation(identity, session);
      const response = await runtime.exportStep({
        projectId: session.projectId,
        revision: session.service.revision,
        document: session.service.snapshot(),
        ...(bodyIds ? { bodyIds } : {}),
      });
      this.#assertContinuation(identity, session);
      return response;
    } catch (error) {
      if (session.closedReason) throw this.#closedSessionError(session.closedReason);
      if (this.#closed) throw this.#closedSessionError('SERVER_RESTARTED');
      throw error;
    } finally {
      this.#endExecution(session);
    }
  }

  /** Stop accepting work immediately, invalidate every session, then tear
   * down the shared worker if this manager ever started it. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const session of this.#sessions.values()) this.#closeSession(session, 'SERVER_RESTARTED');
    this.#requestWindows.clear();
    const pendingRuntime = this.#runtimePromise;
    this.#runtimePromise = null;
    if (!pendingRuntime) return;
    let runtime: HeadlessCadRuntime;
    try {
      runtime = await pendingRuntime;
    } catch {
      // A runtime that failed during startup has no reliable resources left
      // to dispose. Sessions were already invalidated synchronously above.
      return;
    }
    await runtime.dispose();
  }
}
