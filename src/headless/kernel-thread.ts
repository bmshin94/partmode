// Worker-thread entry for the headless CAD kernel.
//
// The browser kernel worker is synchronous wasm: a single rebuild occupies
// its thread for as long as the geometry takes. In the browser that thread
// is a Web Worker and the page stays responsive. On the server the same
// module must not run on the main thread, or one tenant's transaction
// freezes HTTP, the browser relay, and authentication for every other
// tenant. This module supplies the same three browser seams the in-process
// host used to (a self shim, /static/ and /assets/ import resolution, a
// disk-backed fetch) inside a real worker thread, and bridges parentPort.
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

const port = parentPort;
if (!port) throw new Error('kernel-thread must run as a worker thread');

const staticDir = String((workerData as { staticDir?: unknown })?.staticDir ?? '');
if (!staticDir) throw new Error('kernel-thread requires workerData.staticDir');

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
const WEB_ASSET_PREFIX = /^\/(?:static|assets\/[A-Za-z0-9]+)\//;

const toWorker = new Set<(event: { data: Record<string, unknown> }) => void>();

(globalThis as Record<string, unknown>).importScripts ??= () => {
  throw new Error('importScripts is not supported in the headless kernel thread');
};
(globalThis as Record<string, unknown>).self = {
  location: { href: pathToFileURL(path.join(staticDir, 'vendor') + path.sep).href },
  postMessage(message: Record<string, unknown>, transfer?: unknown[]) {
    // The worker posts DOM-style transfer lists (ArrayBuffers behind mesh
    // typed arrays); node:worker_threads accepts the same objects under its
    // own readonly Transferable type.
    if (Array.isArray(transfer) && transfer.length) {
      port.postMessage(message, transfer as Parameters<typeof port.postMessage>[1]);
    } else {
      port.postMessage(message);
    }
  },
  addEventListener(type: string, handler: (event: { data: Record<string, unknown> }) => void) {
    if (type === 'message') toWorker.add(handler);
  },
  removeEventListener(type: string, handler: (event: { data: Record<string, unknown> }) => void) {
    toWorker.delete(handler);
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.pathname : null;
  if (target && WEB_ASSET_PREFIX.test(target)) {
    const relative = target.replace(WEB_ASSET_PREFIX, '');
    const file = path.join(staticDir, relative);
    if (path.relative(staticDir, file).startsWith('..')) {
      throw new Error(`static fetch escapes the static directory: ${target}`);
    }
    const bytes = await readFile(file);
    const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
    return new Response(bytes, { status: 200, headers: { 'content-type': type } });
  }
  return realFetch(input as Parameters<typeof realFetch>[0], init as Parameters<typeof realFetch>[1]);
}) as typeof fetch;

port.on('message', (message: Record<string, unknown>) => {
  for (const deliver of [...toWorker]) deliver({ data: message });
});

register('./static-hooks.js', { parentURL: import.meta.url, data: { staticDir } });
await import(pathToFileURL(path.join(staticDir, 'studio-kernel.worker.js')).href);
