import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const repositoryRoot = resolve('.');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-entrypoint-'));
const isolatedRelease = resolve(temporaryDirectory, 'release');
mkdirSync(isolatedRelease);
cpSync(resolve(repositoryRoot, 'dist'), resolve(isolatedRelease, 'dist'), { recursive: true });
cpSync(resolve(repositoryRoot, 'package.json'), resolve(isolatedRelease, 'package.json'));
const currentLink = resolve(temporaryDirectory, 'current');
symlinkSync(isolatedRelease, currentLink, 'dir');

const child = spawn(process.execPath, [resolve(currentLink, 'dist', 'server.js')], {
  cwd: currentLink,
  env: {
    ...process.env,
    PARTMODE_HOST: '127.0.0.1',
    PARTMODE_PORT: '0',
    PARTMODE_STATE_DIR: resolve(temporaryDirectory, 'state'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk: string) => {
  stderr += chunk;
});

try {
  const url = await new Promise<string>((resolveUrl, rejectUrl) => {
    const timeout = setTimeout(() => {
      rejectUrl(new Error(`symlinked entrypoint did not start\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 10_000);
    const inspect = () => {
      const match = stdout.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) {
        clearTimeout(timeout);
        resolveUrl(match[1]);
      }
    };
    child.stdout.on('data', inspect);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      rejectUrl(new Error(`symlinked entrypoint exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
  const response = await fetch(`${url}/healthz`);
  const health = await response.json() as { ok?: boolean; product?: string; sha?: string };
  if (!response.ok || health.ok !== true || health.product !== 'PartMode') {
    throw new Error(`symlinked entrypoint health failed: ${JSON.stringify(health)}`);
  }
  console.log(JSON.stringify({ ok: true, url, sha: health.sha }));
} finally {
  child.kill('SIGTERM');
  await new Promise<void>((resolveExit) => {
    if (child.exitCode !== null) resolveExit();
    else child.once('exit', () => resolveExit());
  });
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
