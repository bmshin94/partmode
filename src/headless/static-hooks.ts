// Module hooks that let the browser kernel worker run unmodified under Node.
// The worker imports its siblings by the absolute /static/ URLs the web
// server exposes, so resolution has to map those specifiers onto the
// checkout's static source tree.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let staticDir = '';

export function initialize(data: { staticDir: string }): void {
  staticDir = data.staticDir;
}

// The Emscripten glue detects Node and then loads the wasm through fs using
// the /static/ URL path, which only exists on the web server. Forcing the
// detection off sends it down the fetch + instantiateStreaming path, which
// the headless host serves from disk. Exact-match so a vendor update that
// changes the glue fails loudly here instead of drifting past the rewrite.
const NODE_DETECTION =
  'var ENVIRONMENT_IS_NODE=typeof process=="object"&&typeof process.versions=="object"&&typeof process.versions.node=="string"';

function sourceText(source: unknown): string {
  if (typeof source === 'string') return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString('utf8');
  if (source instanceof ArrayBuffer) return Buffer.from(source).toString('utf8');
  throw new Error('unexpected module source type for the Emscripten glue');
}

export async function load(
  url: string,
  context: { format?: string | null },
  nextLoad: (
    url: string,
    context?: { format?: string | null },
  ) => Promise<{ format: string; source: unknown; shortCircuit?: boolean }>,
): Promise<{ format: string; source: unknown; shortCircuit?: boolean }> {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/vendor/replicad-oc.module.js')) return result;
  const source = sourceText(result.source);
  if (!source.includes(NODE_DETECTION)) {
    throw new Error('replicad-oc.module.js no longer matches the expected Node environment detection');
  }
  return { ...result, source: source.replace(NODE_DETECTION, 'var ENVIRONMENT_IS_NODE=false') };
}

// Development serves modules at /static/; production builds rewrite that
// prefix to the immutable /assets/<version>/ path. Both shapes must map onto
// the configured directory so the same host runs against src/static and a
// deployed dist/assets/<version> tree.
export const WEB_ASSET_PREFIX = /^\/(?:static|assets\/[A-Za-z0-9]+)\//;

export async function resolve(
  specifier: string,
  context: { parentURL?: string; conditions?: string[] },
  nextResolve: (
    specifier: string,
    context?: { parentURL?: string; conditions?: string[] },
  ) => Promise<{ url: string; shortCircuit?: boolean }>,
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (staticDir && WEB_ASSET_PREFIX.test(specifier)) {
    const relative = specifier.replace(WEB_ASSET_PREFIX, '');
    const resolved = path.join(staticDir, relative);
    if (path.relative(staticDir, resolved).startsWith('..')) {
      throw new Error(`static import escapes the static directory: ${specifier}`);
    }
    return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
