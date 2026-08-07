import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Add-in API smoke failed: ${label}`);
}

async function expectCode(label: string, fn: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try { await fn(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Add-in API smoke failed: ${label} did not fail`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const addinTools = await moduleAt('src/static/studio-addin-api.js');
const agentTools = await moduleAt('src/static/studio-agent-service.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
let project = runtime.canonicalStudioV5Project(JSON.parse(await readFile(resolve(root, 'tests/cad-corpus/named-checkpoint.partmode.json'), 'utf8')));
const original = JSON.stringify(project);
let revision = 0;
let host: any;
host = addinTools.createStudioAddinHost({
  snapshot: () => project,
  revision: () => revision,
  inspect: (query: JsonRecord) => new agentTools.CadCommandService({ project, revision }).inspect(query),
  transact: (request: JsonRecord, addinId: string) => {
    if (request.expectedRevision !== revision) {
      throw new addinTools.StudioAddinError('REVISION_CONFLICT', 'stale add-in transaction', { expectedRevision: request.expectedRevision, actualRevision: revision });
    }
    const applied = agentTools.applyCadTransaction(project, {
      transactionId: `addin-${addinId}-${revision + 1}`,
      label: request.label,
      expectedRevision: revision,
      atomic: true,
      operations: request.operations,
      metadata: { actor: 'addin', addinId },
    });
    project = applied.project;
    revision++;
    host.emitDocumentChanged({ revision, label: request.label, actor: 'addin', addinId });
    return { revision, transactionId: `addin-${addinId}-${revision}`, changeSet: applied.changeSet };
  },
});

const manifest = {
  schema: 'partmode.addin/v1', apiVersion: '1.0', id: 'com.example.height-tools',
  name: 'Height Tools', version: '1.2.3', publisher: 'Example CAD',
  description: 'Edits the named stock through the typed transaction API.',
  permissions: ['document.read', 'document.write', 'commands.register'],
};
let changedEvent: any = null;
const registered = host.register(manifest, async (api: any) => {
  const snapshot = api.document.snapshot();
  check('add-in snapshot is not a clone', snapshot !== project && JSON.stringify(snapshot) === JSON.stringify(project));
  const summary = await api.document.inspect({ kind: 'project.summary' });
  check('add-in inspection did not reach the typed document', summary.projectId === project.projectId && summary.counts.features === 2);
  api.events.on('document.changed', (event: JsonRecord) => { changedEvent = event; });
  api.commands.register({ id: 'set-height', title: 'Set named height', description: 'Updates the exact extrusion height.' }, async (input: JsonRecord) => {
    const transaction = await api.document.transact({
      label: 'Add-in set named height',
      expectedRevision: input.expectedRevision ?? api.document.revision(),
      operations: input.operations ?? [{ kind: 'parameter.update', input: { parameterId: 'param-named-height', value: input.height } }],
    });
    return { transaction, height: input.height };
  });
  return () => { changedEvent = { disposed: true }; };
});
check('registration granted access before approval', registered.state === 'registered' && registered.grantedPermissions.length === 0 && host.commands().length === 0);
await expectCode('undeclared permission grant', () => host.enable(manifest.id, [...manifest.permissions, 'network.fetch']), 'ADDIN_GRANT_INVALID');
await expectCode('duplicate registration', () => host.register(manifest, () => {}), 'ADDIN_ALREADY_REGISTERED');
await expectCode('remote or malformed manifest id', () => host.register({ ...manifest, id: 'https://evil.example/addin' }, () => {}), 'ADDIN_MANIFEST_INVALID');

const rollbackHost = addinTools.createStudioAddinHost({
  snapshot: () => project, revision: () => revision, inspect: () => ({}), transact: () => ({}),
});
rollbackHost.register({ ...manifest, id: 'com.example.failed-tools', name: 'Failed Tools', permissions: ['commands.register'] }, async (api: any) => {
  api.commands.register({ id: 'leaked-command', title: 'Leaked command' }, () => ({}));
  throw new addinTools.StudioAddinError('EXPECTED_ACTIVATION_FAILURE', 'activation failed after command registration');
});
await expectCode('activation rollback', () => rollbackHost.enable('com.example.failed-tools', ['commands.register']), 'EXPECTED_ACTIVATION_FAILURE');
check('failed activation leaked a command or grant', rollbackHost.commands().length === 0
  && rollbackHost.list()[0].state === 'failed' && rollbackHost.list()[0].grantedPermissions.length === 0);

const enabled = await host.enable(manifest.id, manifest.permissions);
check('enabled add-in did not register a namespaced command', enabled.state === 'active'
  && JSON.stringify(host.commands().map((entry: JsonRecord) => entry.id)) === JSON.stringify(['com.example.height-tools/set-height']));
const sourceBeforeCommand = JSON.stringify(project);
const result = await host.runCommand('com.example.height-tools/set-height', { height: 15 });
await new Promise((resolveTick) => setTimeout(resolveTick, 0));
check('add-in command did not return its typed transaction receipt', result.transaction.revision === 1 && result.height === 15);
check('add-in transaction mutated its source document', sourceBeforeCommand !== JSON.stringify(project) && original === JSON.stringify(runtime.canonicalStudioV5Project(JSON.parse(original))));
check('add-in document.changed event is missing', changedEvent?.revision === 1 && changedEvent?.addinId === manifest.id);
check('add-in typed edit did not preserve the authored parameter identity', project.parameters.find((entry: JsonRecord) => entry.id === 'param-named-height')?.value === 15);
await expectCode('stale add-in transaction', () => host.runCommand('com.example.height-tools/set-height', { height: 20, expectedRevision: 0 }), 'REVISION_CONFLICT');
await expectCode('empty add-in transaction', () => host.runCommand('com.example.height-tools/set-height', { height: 20, operations: [] }), 'ADDIN_TRANSACTION_INVALID');
await expectCode('oversized add-in transaction', () => host.runCommand('com.example.height-tools/set-height', {
  height: 20,
  operations: Array.from({ length: 101 }, (_, index) => ({ kind: 'project.rename', input: { name: `Bad ${index}` } })),
}), 'ADDIN_TRANSACTION_INVALID');
check('failed stale command mutated the document', project.parameters.find((entry: JsonRecord) => entry.id === 'param-named-height')?.value === 15 && revision === 1);

let deniedHost: any;
deniedHost = addinTools.createStudioAddinHost({
  snapshot: () => project, revision: () => revision,
  inspect: () => ({}), transact: () => { throw new Error('must not reach adapter'); },
});
deniedHost.register({ ...manifest, id: 'com.example.denied-tools', name: 'Denied Tools' }, async (api: any) => {
  api.commands.register({ id: 'write', title: 'Write' }, () => api.document.transact({ label: 'Forbidden', expectedRevision: revision, operations: [{ kind: 'project.rename', input: { name: 'Bad' } }] }));
});
await deniedHost.enable('com.example.denied-tools', ['commands.register']);
await expectCode('ungranted document write', () => deniedHost.runCommand('com.example.denied-tools/write', {}), 'ADDIN_PERMISSION_DENIED');

const reopened = runtime.canonicalStudioV5Project(JSON.parse(JSON.stringify(project)));
check('add-in-authored project changed after save/reopen', JSON.stringify(reopened) === JSON.stringify(project));
let kernel: HeadlessKernel | null = null;
let beforeExact: JsonRecord;
let afterExact: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  beforeExact = await kernel.request({ kind: 'rebuild', requestId: 'addin-before', projectId: project.projectId, revision: 1, document: JSON.parse(original) }) as JsonRecord;
  afterExact = await kernel.request({ kind: 'rebuild', requestId: 'addin-after', projectId: project.projectId, revision: 2, document: reopened }) as JsonRecord;
} finally { await kernel?.dispose(); }
for (const [label, exact] of [['before', beforeExact], ['after', afterExact]] as Array<[string, JsonRecord]>) {
  check(`${label} exact rebuild failed ${JSON.stringify(exact.errors || [])}`, exact.kind === 'rebuild-result' && exact.errors?.length === 0 && exact.bodies?.length === 1);
  check(`${label} exact body is invalid`, exact.bodies[0].geometry?.valid === true && exact.bodies[0].geometry?.solidCount === 1);
}
check('add-in exact edit did not change extrusion bounds from 10 to 15 mm',
  beforeExact.bodies[0].geometry.bounds[1][2] === 10 && afterExact.bodies[0].geometry.bounds[1][2] === 15);
check('add-in exact edit did not add the expected 1,000 cubic millimetres',
  Math.abs((afterExact.bodies[0].geometry.volume - beforeExact.bodies[0].geometry.volume) - 1000) < 1e-6);

await host.disable(manifest.id);
check('disable leaked commands', host.commands().length === 0 && host.list()[0].state === 'disabled');
await expectCode('disabled command execution', () => host.runCommand('com.example.height-tools/set-height', {}), 'ADDIN_COMMAND_NOT_FOUND');
check('disable did not run lifecycle cleanup', changedEvent?.disposed === true);
await host.unregister(manifest.id);
check('unregister retained manifest', host.list().length === 0);

const [pageSource, studioSource, registrySource, buildSource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
  readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
]);
check('visible add-in manager is missing', pageSource.includes('id="bw-addins-open"') && pageSource.includes('id="bw-addins"')
  && pageSource.includes('id="bw-addins-list"') && pageSource.includes('id="bw-addins-file"'));
check('visible manager does not require explicit permission approval', studioSource.includes("window.confirm('Enable '") && studioSource.includes('permissions.join'));
check('third-party module loader is missing or bypasses the manifest activator contract', studioSource.includes('await import(moduleUrl)')
  && studioSource.includes('loaded.manifest') && studioSource.includes("typeof loaded.activate !== 'function'")
  && studioSource.includes('2 * 1024 * 1024'));
check('public third-party API is not installed', studioSource.includes('globalThis.PartModeAddins') && studioSource.includes('studioAddinHost.publicApi()'));
check('add-in writes do not respect agent settlement', studioSource.includes('if (agentCommitInProgress)')
  && studioSource.includes("'DOCUMENT_SETTLEMENT_IN_PROGRESS'"));
check('typed UI registry omits add-in manager', registrySource.includes("'dialog.addins.open'")
  && registrySource.includes("'dialog.addins.close'") && registrySource.includes("'dialog.addins.load'"));
check('add-in runtime is not release packaged', buildSource.includes("'studio-addin-api.js'"));

console.log(JSON.stringify({
  schema: addinTools.STUDIO_ADDIN_SCHEMA,
  apiVersion: addinTools.STUDIO_ADDIN_API_VERSION,
  permissions: addinTools.STUDIO_ADDIN_PERMISSIONS,
  command: 'com.example.height-tools/set-height',
  revision,
  exact: {
    boundsBefore: beforeExact.bodies[0].geometry.bounds,
    boundsAfter: afterExact.bodies[0].geometry.bounds,
    volumeBefore: beforeExact.bodies[0].geometry.volume,
    volumeAfter: afterExact.bodies[0].geometry.volume,
  },
  lifecycle: ['register', 'approve', 'activate', 'command', 'disable', 'unregister'],
  failClosed: ['invalid-manifest', 'undeclared-grant', 'activation-rollback', 'ungranted-write', 'empty-or-oversized-transaction', 'stale-revision', 'settlement-conflict', 'disabled-command'],
  saveReopen: 'preserved',
}, null, 2));

process.exit(0);
