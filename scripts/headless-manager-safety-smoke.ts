// Focused, deterministic safety evidence for the hosted headless manager.
// A dependency-injected runtime lets this prove concurrency and revocation
// races without relying on scheduler timing or spending wasm kernel cycles.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AccountStore } from '../src/account-store.js';
import {
  HeadlessSessionManager,
  type HeadlessSessionSummary,
} from '../src/headless-sessions.js';
import type { HeadlessCadRuntime } from '../src/headless/agent-host.js';
import type { KernelMessage } from '../src/headless/kernel-host.js';
import { RelayError, type AgentIdentity } from '../src/relay-hub.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function check(name: string, condition: boolean): asserts condition {
  if (!condition) throw new Error(`Headless manager safety smoke failed: ${name}`);
}

async function expectRelayError(
  name: string,
  action: Promise<unknown> | (() => unknown),
  code: string,
): Promise<RelayError> {
  try {
    if (typeof action === 'function') await Promise.resolve().then(action);
    else await action;
  } catch (error) {
    check(`${name} returns RelayError`, error instanceof RelayError);
    check(`${name} returns ${code}`, error.code === code);
    return error;
  }
  throw new Error(`Headless manager safety smoke failed: ${name} unexpectedly succeeded`);
}

async function waitFor(name: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Headless manager safety smoke failed: timed out waiting for ${name}`);
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  }
}

class FakeService {
  revision = 0;
  project: { projectId: string };
  journal: Array<Record<string, unknown>> = [];
  readonly #harness: FakeRuntimeHarness;

  constructor(harness: FakeRuntimeHarness, projectId: string) {
    this.#harness = harness;
    this.project = { projectId };
  }

  snapshot(): KernelMessage {
    return { projectId: this.project.projectId, name: this.project.projectId, units: 'mm', bodies: [], features: [] };
  }

  synchronize(project: KernelMessage, revision: number): KernelMessage {
    this.revision = revision;
    if (typeof project.projectId === 'string') this.project = { projectId: project.projectId };
    this.journal.push({ documentHash: 'a'.repeat(64) });
    return this.snapshot();
  }

  request(envelope: KernelMessage): Promise<KernelMessage> {
    return this.#harness.request(envelope, this.revision);
  }
}

class FakeRuntimeHarness {
  readonly gates: Array<Deferred<KernelMessage>> = [];
  readonly inFlight = new Set<Deferred<KernelMessage>>();
  readonly exportGates: Array<Deferred<KernelMessage>> = [];
  readonly inFlightExports = new Set<Deferred<KernelMessage>>();
  requests = 0;
  exports = 0;
  disposed = 0;

  constructor(readonly rejectPendingOnDispose = false) {}

  gateNext(): Deferred<KernelMessage> {
    const gate = deferred<KernelMessage>();
    this.gates.push(gate);
    return gate;
  }

  gateNextExport(): Deferred<KernelMessage> {
    const gate = deferred<KernelMessage>();
    this.exportGates.push(gate);
    return gate;
  }

  request(_envelope: KernelMessage, revision: number): Promise<KernelMessage> {
    this.requests += 1;
    const gate = this.gates.shift();
    if (gate) {
      this.inFlight.add(gate);
      return gate.promise.finally(() => this.inFlight.delete(gate));
    }
    return Promise.resolve({ status: 'ok', revision, result: { exact: true } });
  }

  exportStep(revision: number): Promise<KernelMessage> {
    this.exports += 1;
    const gate = this.exportGates.shift();
    if (gate) {
      this.inFlightExports.add(gate);
      return gate.promise.finally(() => this.inFlightExports.delete(gate));
    }
    return Promise.resolve({ status: 'ok', revision, result: { exact: true } });
  }

  runtime(): HeadlessCadRuntime {
    return {
      module: { createCadAgentRequest: (input: KernelMessage) => input },
      protocol: 'partmode.cad.agent/v1',
      createService: (options = {}) => new FakeService(this, options.projectId ?? 'fake-project') as never,
      exportStep: async (input) => this.exportStep(input.revision) as never,
      dispose: async () => {
        this.disposed += 1;
        if (this.rejectPendingOnDispose) {
          const disposed = new Error('headless kernel is disposed');
          for (const gate of this.inFlight) gate.reject(disposed);
          for (const gate of this.inFlightExports) gate.reject(disposed);
        }
      },
    };
  }
}

function identityFor(
  accountId: string,
  key: {
    id: string;
    label: string;
    access: 'read-only' | 'edit';
    headless: boolean;
    grantCeiling: { granted: readonly string[] };
  },
): AgentIdentity {
  return {
    accountId,
    keyId: key.id,
    keyLabel: key.label,
    access: key.access,
    headless: key.headless,
    grantCeiling: [...key.grantCeiling.granted],
  };
}

function manager(
  store: AccountStore,
  harness: FakeRuntimeHarness,
  now: () => number,
  limits: ConstructorParameters<typeof HeadlessSessionManager>[0]['limits'] = {},
): HeadlessSessionManager {
  return new HeadlessSessionManager({
    store,
    now,
    runtimeFactory: async () => harness.runtime(),
    limits: {
      maxRequestsPerAccountWindow: 1_000,
      maxPersistedProjectsPerAccount: 100,
      ...limits,
    },
  });
}

function okResponse(label: string): KernelMessage {
  return { status: 'ok', revision: 0, result: { label, mustNotLeakAfterRevocation: true } };
}

export interface HeadlessManagerSafetyEvidence {
  sessionBusy: true;
  globalPendingBounded: true;
  perAccountRateBounded: true;
  persistedProjectQuotaBounded: true;
  revokedKeyCannotReturnData: true;
  revokedAccountCannotReturnData: true;
  expiredSessionCannotReturnData: true;
  expiredKeyCannotReturnData: true;
  shutdownCannotReturnData: true;
  shutdownDisposalRejectionTyped: true;
  visibleStudioArtifactBoundary: true;
  runtimeDisposed: true;
}

export async function runHeadlessManagerSafetySmoke(): Promise<HeadlessManagerSafetyEvidence> {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-headless-manager-'));
  let clockMs = Date.now();
  const now = () => clockMs;
  const store = AccountStore.open({
    filename: resolve(temporaryDirectory, 'safety.sqlite'),
    pepper: 'headless-manager-safety-pepper-v1',
    now: () => new Date(clockMs),
  });

  try {
    const account = await store.createAccount('headless-safety', 'correct horse battery staple safety');
    const key = store.createAgentKey(
      account.id,
      'Safety key',
      'edit',
      new Date(clockMs + 24 * 60 * 60 * 1_000),
      { headless: true },
    ).key;
    const identity = identityFor(account.id, key);

    // Exactly one execution may run per session, and the global set of
    // active plus kernel-queued manager requests has a hard ceiling.
    const capacityHarness = new FakeRuntimeHarness();
    const capacityManager = manager(store, capacityHarness, now, { maxGlobalPendingExecutions: 2 });
    const first = await capacityManager.open(identity, { projectId: 'safety-capacity-a' });
    const second = await capacityManager.open(identity, { projectId: 'safety-capacity-b' });
    const third = await capacityManager.open(identity, { projectId: 'safety-capacity-c' });
    await expectRelayError(
      'headless artifact boundary',
      capacityManager.callTool(identity, first.sessionId, 'cad_artifact', {}),
      'VISIBLE_STUDIO_REQUIRED',
    );
    const firstGate = capacityHarness.gateNext();
    const secondGate = capacityHarness.gateNext();
    const firstPending = capacityManager.callTool(identity, first.sessionId, 'cad_inspect', {});
    const secondPending = capacityManager.callTool(identity, second.sessionId, 'cad_inspect', {});
    await waitFor('two in-flight fake CAD requests', () => capacityHarness.requests === 2);
    await expectRelayError(
      'same-session concurrent call',
      capacityManager.callTool(identity, first.sessionId, 'cad_inspect', {}),
      'SESSION_BUSY',
    );
    await expectRelayError(
      'global pending ceiling',
      capacityManager.callTool(identity, third.sessionId, 'cad_inspect', {}),
      'HEADLESS_CAPACITY_EXCEEDED',
    );
    firstGate.resolve(okResponse('first'));
    secondGate.resolve(okResponse('second'));
    await Promise.all([firstPending, secondPending]);
    await capacityManager.close();
    check('capacity runtime disposed exactly once', capacityHarness.disposed === 1);

    // Revocation during an awaited service call must invalidate the retained
    // session object and suppress the result even if the service completes.
    const keyHarness = new FakeRuntimeHarness();
    const keyManager = manager(store, keyHarness, now);
    const keySession = await keyManager.open(identity, { projectId: 'safety-key-revoke' });
    const keyGate = keyHarness.gateNext();
    const keyPending = keyManager.callTool(identity, keySession.sessionId, 'cad_inspect', {});
    await waitFor('key-revocation request start', () => keyHarness.requests === 1);
    keyManager.revokeKey(identity.keyId);
    keyGate.resolve(okResponse('revoked-key-secret'));
    await expectRelayError('post-await key revocation', keyPending, 'KEY_REVOKED');
    await keyManager.close();

    const accountHarness = new FakeRuntimeHarness();
    const accountManager = manager(store, accountHarness, now);
    const accountSession = await accountManager.open(identity, { projectId: 'safety-account-revoke' });
    const accountGate = accountHarness.gateNext();
    const accountPending = accountManager.callTool(identity, accountSession.sessionId, 'cad_inspect', {});
    await waitFor('account-revocation request start', () => accountHarness.requests === 1);
    accountManager.revokeAccount(identity.accountId);
    accountGate.resolve(okResponse('revoked-account-secret'));
    await expectRelayError('post-await account revocation', accountPending, 'ACCOUNT_REVOKED');
    await accountManager.close();

    // Both the session deadline and the durable key expiry are revalidated
    // after the await, rather than trusting request-start authentication.
    const sessionExpiryHarness = new FakeRuntimeHarness();
    const sessionExpiryManager = manager(store, sessionExpiryHarness, now);
    const expiringSession = await sessionExpiryManager.open(identity, {
      projectId: 'safety-session-expiry',
      sessionSeconds: 60,
    });
    const sessionExpiryGate = sessionExpiryHarness.gateNext();
    const sessionExpiryPending = sessionExpiryManager.callTool(identity, expiringSession.sessionId, 'cad_inspect', {});
    await waitFor('session-expiry request start', () => sessionExpiryHarness.requests === 1);
    clockMs += 61_000;
    sessionExpiryGate.resolve(okResponse('expired-session-secret'));
    await expectRelayError('post-await session expiry', sessionExpiryPending, 'SESSION_EXPIRED');
    await sessionExpiryManager.close();

    const expiringKey = store.createAgentKey(
      account.id,
      'Expiring key',
      'edit',
      new Date(clockMs + 30_000),
      { headless: true },
    ).key;
    const expiringIdentity = identityFor(account.id, expiringKey);
    const keyExpiryHarness = new FakeRuntimeHarness();
    const keyExpiryManager = manager(store, keyExpiryHarness, now);
    const keyExpirySession = await keyExpiryManager.open(expiringIdentity, { projectId: 'safety-key-expiry' });
    const keyExpiryGate = keyExpiryHarness.gateNext();
    const keyExpiryPending = keyExpiryManager.callTool(expiringIdentity, keyExpirySession.sessionId, 'cad_inspect', {});
    await waitFor('key-expiry request start', () => keyExpiryHarness.requests === 1);
    clockMs += 31_000;
    keyExpiryGate.resolve(okResponse('expired-key-secret'));
    await expectRelayError('post-await key expiry', keyExpiryPending, 'KEY_REVOKED');
    await keyExpiryManager.close();

    // Closing the manager marks sessions before awaiting worker disposal, so
    // an already-running request cannot race shutdown and return its payload.
    const closeHarness = new FakeRuntimeHarness(true);
    const closeManager = manager(store, closeHarness, now);
    const closeSession = await closeManager.open(identity, { projectId: 'safety-shutdown' });
    closeHarness.gateNext();
    const closePending = closeManager.callTool(identity, closeSession.sessionId, 'cad_inspect', {});
    await waitFor('shutdown request start', () => closeHarness.requests === 1);
    await closeManager.close();
    await expectRelayError('post-await shutdown', closePending, 'HEADLESS_UNAVAILABLE');
    check('shutdown disposes the runtime', closeHarness.disposed === 1);

    const exportCloseHarness = new FakeRuntimeHarness(true);
    const exportCloseManager = manager(store, exportCloseHarness, now);
    const exportCloseSession = await exportCloseManager.open(identity, { projectId: 'safety-export-shutdown' });
    exportCloseHarness.gateNextExport();
    const exportClosePending = exportCloseManager.exportStep(identity, exportCloseSession.sessionId);
    await waitFor('shutdown export start', () => exportCloseHarness.exports === 1);
    await exportCloseManager.close();
    await expectRelayError('post-await export shutdown', exportClosePending, 'HEADLESS_UNAVAILABLE');
    check('export shutdown disposes the runtime', exportCloseHarness.disposed === 1);

    // Every manager operation participates in a bounded per-account window.
    const rateHarness = new FakeRuntimeHarness();
    const rateManager = manager(store, rateHarness, now, { maxRequestsPerAccountWindow: 2 });
    const rateSession = await rateManager.open(identity, { projectId: 'safety-rate' });
    rateManager.sessionStatus(identity, rateSession.sessionId);
    await expectRelayError(
      'per-account headless request rate',
      () => rateManager.sessionStatus(identity, rateSession.sessionId),
      'HEADLESS_RATE_LIMITED',
    );
    await rateManager.close();

    // Existing durable projects remain reopenable at quota, while a new
    // project is rejected before any runtime or SQLite mutation occurs.
    const durableProjects = store.listHeadlessDocuments(account.id);
    check('safety setup created durable projects', durableProjects.length > 0);
    const quotaHarness = new FakeRuntimeHarness();
    const quotaManager = manager(store, quotaHarness, now, {
      maxPersistedProjectsPerAccount: durableProjects.length,
    });
    const existing = await quotaManager.open(identity, { projectId: durableProjects[0]!.projectId });
    quotaManager.disconnect(identity, existing.sessionId);
    await expectRelayError(
      'new persisted project at quota',
      quotaManager.open(identity, { projectId: 'safety-project-over-quota' }),
      'HEADLESS_PROJECT_QUOTA_EXCEEDED',
    );
    check(
      'project quota rejects before persistence',
      !store.listHeadlessDocuments(account.id).some((project) => project.projectId === 'safety-project-over-quota'),
    );
    await quotaManager.close();

    return {
      sessionBusy: true,
      globalPendingBounded: true,
      perAccountRateBounded: true,
      persistedProjectQuotaBounded: true,
      revokedKeyCannotReturnData: true,
      revokedAccountCannotReturnData: true,
      expiredSessionCannotReturnData: true,
      expiredKeyCannotReturnData: true,
      shutdownCannotReturnData: true,
      shutdownDisposalRejectionTyped: true,
      visibleStudioArtifactBoundary: true,
      runtimeDisposed: true,
    };
  } finally {
    store.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
