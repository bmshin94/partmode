// Headless Node host for the PartMode CAD kernel.
//
// The exact browser worker module (studio-kernel.worker.js) runs unmodified
// in a Node worker thread (kernel-thread.ts supplies the browser seams).
// Keeping it off the main thread is a hard requirement on the server: the
// wasm kernel is synchronous, so a rebuild would otherwise block HTTP, the
// browser relay, and authentication for every tenant while one tenant's
// geometry builds. Request and reply payloads stay byte-identical to the
// browser path; there is no headless-only geometry code.
//
// The worker module keeps kernel state in module scope and assumes one
// document at a time, exactly like its one browser tab, so requests are
// serialized here.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export type KernelMessage = Record<string, unknown>;

/** One synchronous wasm kernel serves the process. This ceiling includes
 * the active request and queued requests, so authenticated tenants cannot
 * grow the worker queue without bound. */
export const MAX_PENDING_HEADLESS_KERNEL_REQUESTS = 16;

export class HeadlessKernelCapacityError extends Error {
  readonly code = 'HEADLESS_KERNEL_CAPACITY_EXCEEDED';

  constructor() {
    super('The headless CAD kernel request queue is full.');
    this.name = 'HeadlessKernelCapacityError';
  }
}

export interface HeadlessKernel {
  /** Send one worker request and await the reply with the same requestId. */
  request(message: KernelMessage, timeoutMs?: number): Promise<KernelMessage>;
  /** Resolves when the wasm kernel reports ready; rejects if it fails. */
  waitForKernel(timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

export function resolveStaticDir(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.PARTMODE_STATIC_DIR,
    // Compiled location is .build/src/headless/, sources sit at src/static/.
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'static'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(path.join(candidate, 'studio-kernel.worker.js'))) {
      return path.resolve(candidate);
    }
  }
  throw new Error('cannot locate src/static (set PARTMODE_STATIC_DIR to the static source directory)');
}

let instance: Promise<HeadlessKernel> | null = null;

export function createHeadlessKernel(options: { staticDir?: string } = {}): Promise<HeadlessKernel> {
  if (!instance) {
    const pending = start(options);
    instance = pending;
    void pending.catch(() => {
      if (instance === pending) instance = null;
    });
  }
  return instance;
}

async function start(options: { staticDir?: string }): Promise<HeadlessKernel> {
  const staticDir = resolveStaticDir(options.staticDir);
  const threadEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'kernel-thread.js');

  const listeners = new Set<(message: KernelMessage) => void>();
  const statusLog: KernelMessage[] = [];
  let fatal: Error | null = null;
  let closed = false;
  let pendingRequests = 0;

  const worker = new Worker(threadEntry, { workerData: { staticDir } });
  worker.unref();
  worker.on('message', (message: KernelMessage) => {
    if (message?.kind === 'kernel-status') statusLog.push(message);
    for (const deliver of [...listeners]) deliver(message);
  });
  const failAll = (error: Error) => {
    fatal = error;
    for (const deliver of [...listeners]) {
      deliver({ kind: 'kernel-status', status: 'failed', message: error.message });
    }
  };
  worker.on('error', (error) => failAll(error instanceof Error ? error : new Error(String(error))));
  worker.on('exit', (code) => {
    if (code !== 0) failAll(new Error(`kernel thread exited with code ${code}`));
  });

  let queue: Promise<unknown> = Promise.resolve();

  return {
    request(message: KernelMessage, timeoutMs = 120_000): Promise<KernelMessage> {
      const requestId = message.requestId;
      if (typeof message.kind !== 'string' || typeof requestId !== 'string') {
        return Promise.reject(new Error('kernel requests need string kind and requestId fields'));
      }
      if (closed) return Promise.reject(new Error('headless kernel is disposed'));
      if (pendingRequests >= MAX_PENDING_HEADLESS_KERNEL_REQUESTS) {
        return Promise.reject(new HeadlessKernelCapacityError());
      }
      pendingRequests += 1;
      const run = () => new Promise<KernelMessage>((resolve, reject) => {
        if (closed) {
          reject(new Error('headless kernel is disposed'));
          return;
        }
        if (fatal) {
          reject(fatal);
          return;
        }
        const timeout = setTimeout(() => {
          listeners.delete(onReply);
          reject(new Error(`kernel request ${requestId} (${message.kind}) timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const onReply = (reply: KernelMessage) => {
          if (reply.kind === 'kernel-status' && reply.status === 'failed') {
            clearTimeout(timeout);
            listeners.delete(onReply);
            reject(new Error(String(reply.message ?? 'kernel thread failed')));
            return;
          }
          if (reply.requestId !== requestId) return;
          clearTimeout(timeout);
          listeners.delete(onReply);
          if (reply.kind === 'kernel-error') {
            const error = new Error(String(reply.message ?? 'kernel error')) as Error & { code?: string };
            if (typeof reply.code === 'string') error.code = reply.code;
            reject(error);
          } else resolve(reply);
        };
        listeners.add(onReply);
        worker.postMessage(message);
      });
      const result = queue.then(run, run);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result.finally(() => {
        pendingRequests = Math.max(0, pendingRequests - 1);
      });
    },
    waitForKernel(timeoutMs = 180_000): Promise<void> {
      return new Promise((resolve, reject) => {
        const settle = (message: KernelMessage): boolean => {
          if (message.kind !== 'kernel-status') return false;
          if (message.status === 'ready') {
            clearTimeout(timeout);
            listeners.delete(onStatus);
            resolve();
            return true;
          }
          if (message.status === 'failed') {
            clearTimeout(timeout);
            listeners.delete(onStatus);
            reject(new Error(`kernel failed to load: ${String(message.message ?? 'unknown error')}`));
            return true;
          }
          return false;
        };
        const timeout = setTimeout(() => {
          listeners.delete(onStatus);
          reject(new Error(`kernel did not become ready within ${timeoutMs}ms`));
        }, timeoutMs);
        const onStatus = (message: KernelMessage) => void settle(message);
        for (const message of statusLog) if (settle(message)) return;
        listeners.add(onStatus);
      });
    },
    async dispose() {
      if (closed) return;
      closed = true;
      failAll(new Error('headless kernel is disposed'));
      listeners.clear();
      instance = null;
      await worker.terminate();
    },
  };
}
