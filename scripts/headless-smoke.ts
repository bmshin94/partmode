// Proves the CAD kernel executes without a browser: the unmodified worker
// module rebuilds the release fixture and exports STEP under plain Node.
// Evidence is exact geometry state (body validity, solid counts, mesh bytes)
// plus the hashed STEP artifact, the same fixture the browser gate builds.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHeadlessKernel } from '../src/headless/kernel-host.js';

function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`Headless smoke failed: ${name}`);
}

const fixturePath = resolve('tests/fixtures/three-body.json');
const document = JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>;

const kernel = await createHeadlessKernel();
await kernel.waitForKernel();

const rebuild = await kernel.request({
  kind: 'rebuild',
  requestId: 'headless-rebuild-1',
  projectId: document.projectId,
  revision: 1,
  document,
});
check('rebuild replies rebuild-result', rebuild.kind === 'rebuild-result');
const rebuildErrors = rebuild.errors as Array<{ message?: string }> | undefined;
check(
  `rebuild has no errors (${(rebuildErrors ?? []).map((error) => error.message).join('; ') || 'none'})`,
  Array.isArray(rebuildErrors) && rebuildErrors.length === 0,
);
const bodies = rebuild.bodies as Array<Record<string, any>>;
check('fixture yields three bodies', Array.isArray(bodies) && bodies.length === 3);
check(
  'every body carries a valid exact solid',
  bodies.every((body) => body.geometry && body.geometry.valid !== false),
);
const meshBytes = bodies.reduce(
  (total, body) => total + (body.mesh?.vertices?.byteLength ?? 0),
  0,
);
check('bodies carry tessellation', meshBytes > 0);

const exported = await kernel.request({
  kind: 'export-step',
  requestId: 'headless-export-1',
  projectId: document.projectId,
  revision: 1,
  document,
});
check('export replies export-result', exported.kind === 'export-result');
const exportErrors = exported.errors as Array<{ message?: string }> | undefined;
check(
  `export has no errors (${(exportErrors ?? []).map((error) => error.message).join('; ') || 'none'})`,
  Array.isArray(exportErrors) && exportErrors.length === 0,
);
check('export returns a non-empty STEP blob', exported.blob instanceof Blob && exported.blob.size > 0);
const stepBytes = Buffer.from(await (exported.blob as Blob).arrayBuffer());
check('STEP payload is ISO 10303-21', stepBytes.toString('utf8', 0, 32).startsWith('ISO-10303-21'));

console.log(
  JSON.stringify({
    ok: true,
    fixture: 'tests/fixtures/three-body.json',
    bodies: bodies.map((body) => ({
      id: body.bodyId,
      name: body.bodyName,
      solids: body.geometry?.solidCount ?? null,
      valid: body.geometry?.valid !== false,
    })),
    meshBytes,
    step: {
      bytes: stepBytes.byteLength,
      sha256: createHash('sha256').update(stepBytes).digest('hex'),
    },
  }),
);
kernel.dispose();
// The wasm runtime and the module-hooks thread can hold the event loop open;
// evidence is printed, so end the process explicitly.
process.exit(0);
