import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`PDM smoke failed: ${label}`);
}

function expectCode(label: string, fn: () => unknown, code: string): void {
  try { fn(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`PDM smoke failed: ${label} did not fail`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const pdm = await moduleAt('src/static/studio-pdm.js');
const agent = await moduleAt('src/static/studio-agent-service.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const source = runtime.canonicalStudioV5Project(JSON.parse(await readFile(resolve(root, 'tests/cad-corpus/named-checkpoint.partmode.json'), 'utf8')));
const originalJson = JSON.stringify(source);

const transact = (project: JsonRecord, id: string, operations: JsonRecord[]) => agent.applyCadTransaction(project, {
  transactionId: id, label: id, expectedRevision: 0, atomic: true, operations,
});
const initializedTx = transact(source, 'pdm-initialize', [{
  kind: 'pdm.initialize', input: { actor: 'user.author', at: '2026-08-02T01:00:00Z', branchName: 'main', message: 'Initial controlled model' },
}]);
check('PDM initialization mutated its source document', JSON.stringify(source) === originalJson);
let project = initializedTx.project;
let graph = pdm.inspectStudioPdm(project);
check('PDM initial graph is wrong', graph.schema === 'partmode.pdm/v1' && graph.branches.length === 1 && graph.versions.length === 1
  && graph.activeBranchId === 'branch-000001' && graph.branches[0].headVersionId === 'version-000001');
check('initial version hash does not match the exact source document', graph.versions[0].documentHash === runtime.studioV5CanonicalHash(source));

project = transact(project, 'pdm-branch-prototype', [{
  kind: 'pdm.branch.create', input: { name: 'prototype', actor: 'user.author', at: '2026-08-02T01:05:00Z', fromVersionId: 'version-000001', checkout: true },
}]).project;
graph = pdm.inspectStudioPdm(project);
check('prototype branch was not created and checked out', graph.activeBranchId === 'branch-000002'
  && graph.branches.find((entry: JsonRecord) => entry.id === 'branch-000002')?.headVersionId === 'version-000001');

const prototypeTx = transact(project, 'pdm-prototype-version', [
  { kind: 'parameter.update', input: { parameterId: 'param-named-height', value: 15 } },
  { kind: 'pdm.version.create', input: { branchId: 'branch-000002', expectedHeadVersionId: 'version-000001', actor: 'user.author', at: '2026-08-02T01:10:00Z', message: 'Raise prototype height to 15 mm' } },
]);
project = prototypeTx.project;
graph = pdm.inspectStudioPdm(project);
const prototypeVersion = graph.versions.find((entry: JsonRecord) => entry.id === 'version-000003');
check('prototype version graph is wrong', prototypeVersion?.parentVersionIds[0] === 'version-000001'
  && graph.branches.find((entry: JsonRecord) => entry.id === 'branch-000002')?.headVersionId === 'version-000003'
  && project.parameters.find((entry: JsonRecord) => entry.id === 'param-named-height')?.value === 15);
check('typed change set did not expose immutable version creation', prototypeTx.changeSet.created.some((entry: JsonRecord) => entry.kind === 'pdm-version' && entry.id === 'version-000003'));

project = transact(project, 'pdm-submit-review', [{
  kind: 'pdm.review.submit', input: { versionId: 'version-000003', actor: 'user.author', at: '2026-08-02T01:15:00Z', comment: 'Ready for release review' },
}]).project;
const directReviewSource = JSON.stringify(project);
const directReviewed = pdm.recordStudioPdmApproval(project, {
  versionId: 'version-000003', reviewer: 'user.direct-reviewer', decision: 'approved', at: '2026-08-02T01:15:30Z',
});
check('direct PDM review mutated its source document', JSON.stringify(project) === directReviewSource);
check('direct PDM review did not return a reviewed clone', pdm.inspectStudioPdm(directReviewed).versions
  .find((entry: JsonRecord) => entry.id === 'version-000003')?.approvals[0]?.reviewer === 'user.direct-reviewer');
expectCode('release without approval', () => transact(project, 'pdm-release-without-approval', [{
  kind: 'pdm.version.release', input: { versionId: 'version-000003', actor: 'user.release-manager', at: '2026-08-02T01:16:00Z' },
}]), 'PDM_APPROVAL_REQUIRED');
expectCode('self approval', () => transact(project, 'pdm-self-approval', [{
  kind: 'pdm.approval.record', input: { versionId: 'version-000003', reviewer: 'user.author', decision: 'approved', at: '2026-08-02T01:17:00Z' },
}]), 'PDM_SELF_APPROVAL_DENIED');
const reviewProject = project;
const reviewSource = JSON.stringify(reviewProject);
project = transact(project, 'pdm-approve-release', [
  { kind: 'pdm.approval.record', input: { versionId: 'version-000003', reviewer: 'user.reviewer', decision: 'approved', at: '2026-08-02T01:20:00Z', comment: 'Geometry and metadata reviewed' } },
  { kind: 'pdm.version.release', input: { versionId: 'version-000003', actor: 'user.release-manager', at: '2026-08-02T01:21:00Z', requiredApprovals: 1 } },
]).project;
check('approval/release transaction mutated its source', JSON.stringify(reviewProject) === reviewSource);
graph = pdm.inspectStudioPdm(project);
const released = graph.versions.find((entry: JsonRecord) => entry.id === 'version-000003');
check('released version lacks approval audit', released.state === 'released' && released.approvals.length === 1
  && released.approvals[0].reviewer === 'user.reviewer' && released.transitions.at(-1).code === 'released');

const reopened = runtime.canonicalStudioV5Project(JSON.parse(JSON.stringify(project)));
check('PDM graph changed after canonical save/reopen', JSON.stringify(reopened) === JSON.stringify(project));
const main = transact(reopened, 'pdm-checkout-main', [{ kind: 'pdm.branch.checkout', input: { branchId: 'branch-000001' } }]).project;
check('main checkout did not restore immutable 10 mm content', main.parameters.find((entry: JsonRecord) => entry.id === 'param-named-height')?.value === 10
  && pdm.inspectStudioPdm(main).activeBranchId === 'branch-000001');
const prototype = transact(main, 'pdm-checkout-prototype', [{ kind: 'pdm.branch.checkout', input: { branchId: 'branch-000002' } }]).project;
check('prototype checkout did not restore immutable 15 mm content', prototype.parameters.find((entry: JsonRecord) => entry.id === 'param-named-height')?.value === 15
  && pdm.inspectStudioPdm(prototype).activeBranchId === 'branch-000002');
expectCode('no-change duplicate version', () => transact(prototype, 'pdm-no-changes', [{
  kind: 'pdm.version.create', input: { branchId: 'branch-000002', expectedHeadVersionId: 'version-000003', actor: 'user.author', at: '2026-08-02T01:22:00Z', message: 'No changes' },
}]), 'PDM_NO_CHANGES');
expectCode('stale branch head', () => transact(prototype, 'pdm-stale-head', [
  { kind: 'parameter.update', input: { parameterId: 'param-named-height', value: 16 } },
  { kind: 'pdm.version.create', input: { branchId: 'branch-000002', expectedHeadVersionId: 'version-000001', actor: 'user.author', at: '2026-08-02T01:23:00Z', message: 'Stale attempt' } },
]), 'PDM_HEAD_CONFLICT');
check('failed atomic PDM transaction changed the source', prototype.parameters.find((entry: JsonRecord) => entry.id === 'param-named-height')?.value === 15);

let rejected = transact(prototype, 'pdm-rejected-version', [
  { kind: 'parameter.update', input: { parameterId: 'param-named-height', value: 16 } },
  { kind: 'pdm.version.create', input: { branchId: 'branch-000002', expectedHeadVersionId: 'version-000003', actor: 'user.author', at: '2026-08-02T01:24:00Z', message: 'Candidate requiring changes' } },
  { kind: 'pdm.review.submit', input: { versionId: 'version-000004', actor: 'user.author', at: '2026-08-02T01:25:00Z' } },
  { kind: 'pdm.approval.record', input: { versionId: 'version-000004', reviewer: 'user.reviewer-two', decision: 'rejected', at: '2026-08-02T01:26:00Z', comment: 'Resolve the review issue' } },
]).project;
expectCode('release with rejection', () => transact(rejected, 'pdm-release-rejected', [{
  kind: 'pdm.version.release', input: { versionId: 'version-000004', actor: 'user.release-manager', at: '2026-08-02T01:27:00Z' },
}]), 'PDM_REVIEW_REJECTED');
rejected = transact(rejected, 'pdm-return-resubmit', [
  { kind: 'pdm.review.return', input: { versionId: 'version-000004', actor: 'user.author', at: '2026-08-02T01:28:00Z', comment: 'Addressing review' } },
  { kind: 'pdm.review.submit', input: { versionId: 'version-000004', actor: 'user.author', at: '2026-08-02T01:29:00Z', comment: 'Review issue addressed' } },
]).project;
const resubmitted = pdm.inspectStudioPdm(rejected).versions.find((entry: JsonRecord) => entry.id === 'version-000004');
check('rejected version did not return and start a fresh review round', resubmitted.state === 'in-review' && resubmitted.reviewRound === 2
  && resubmitted.approvals.length === 1 && resubmitted.approvals[0].reviewRound === 1);

const tampered = structuredClone(prototype);
tampered.extensions.pdm.versions[0].snapshot.parameters[0].value = 999;
expectCode('tampered immutable snapshot', () => pdm.inspectStudioPdm(tampered), 'PDM_VERSION_TAMPERED');

let kernel: HeadlessKernel | null = null;
let mainExact: JsonRecord;
let prototypeExact: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  mainExact = await kernel.request({ kind: 'rebuild', requestId: 'pdm-main-exact', projectId: main.projectId, revision: 1, document: main }) as JsonRecord;
  prototypeExact = await kernel.request({ kind: 'rebuild', requestId: 'pdm-prototype-exact', projectId: prototype.projectId, revision: 2, document: prototype }) as JsonRecord;
} finally { await kernel?.dispose(); }
for (const [label, exact] of [['main', mainExact], ['prototype', prototypeExact]] as Array<[string, JsonRecord]>) {
  check(`${label} exact rebuild failed ${JSON.stringify(exact.errors || [])}`, exact.kind === 'rebuild-result' && exact.errors?.length === 0 && exact.bodies?.length === 1);
  check(`${label} exact body is invalid`, exact.bodies[0].geometry?.valid === true && exact.bodies[0].geometry?.solidCount === 1);
}
check('branch checkout did not drive distinct exact geometry', mainExact.bodies[0].geometry.bounds[1][2] === 10
  && prototypeExact.bodies[0].geometry.bounds[1][2] === 15
  && Math.abs((prototypeExact.bodies[0].geometry.volume - mainExact.bodies[0].geometry.volume) - 1000) < 1e-6);

const obsolete = transact(prototype, 'pdm-obsolete-release', [{
  kind: 'pdm.version.obsolete', input: { versionId: 'version-000003', actor: 'user.release-manager', at: '2026-08-02T02:00:00Z', comment: 'Superseded in the release catalog' },
}]).project;
check('released version did not transition to obsolete', pdm.inspectStudioPdm(obsolete).versions.find((entry: JsonRecord) => entry.id === 'version-000003')?.state === 'obsolete');

const [pageSource, studioSource, registrySource, agentSource, buildSource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-agent-service.js'), 'utf8'),
  readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
]);
check('visible PDM manager is missing', pageSource.includes('id="bw-pdm-open"') && pageSource.includes('id="bw-pdm"')
  && pageSource.includes('id="bw-pdm-branch"') && pageSource.includes('id="bw-pdm-version"'));
check('visible PDM manager does not route through typed atomic operations', studioSource.includes("kind: 'pdm.initialize'")
  && studioSource.includes("kind: 'pdm.version.create'") && studioSource.includes("kind: 'pdm.branch.checkout'")
  && studioSource.includes("kind: 'pdm.approval.record'") && studioSource.includes("kind: 'pdm.version.release'"));
check('typed UI registry omits PDM workflow', registrySource.includes("'dialog.pdm.open'")
  && registrySource.includes("'dialog.pdm.version'") && registrySource.includes("'dialog.pdm.release'"));
check('typed agent schema omits PDM operations', agentSource.includes("'pdm.branch.create'")
  && agentSource.includes("'pdm.review.submit'") && agentSource.includes("'pdm.version.obsolete'"));
check('PDM runtime is not release packaged', buildSource.includes("'studio-pdm.js'"));

console.log(JSON.stringify({
  schema: graph.schema,
  branches: graph.branches.map((entry: JsonRecord) => ({ id: entry.id, name: entry.name, head: entry.headVersionId })),
  releasedVersion: { id: released.id, state: released.state, hash: released.documentHash, approvals: released.approvals.length },
  exact: {
    mainBounds: mainExact.bodies[0].geometry.bounds,
    prototypeBounds: prototypeExact.bodies[0].geometry.bounds,
    volumeDelta: prototypeExact.bodies[0].geometry.volume - mainExact.bodies[0].geometry.volume,
  },
  saveReopen: 'preserved',
  failClosed: ['release-without-approval', 'self-approval', 'release-with-rejection', 'no-changes', 'stale-head', 'tampered-snapshot'],
}, null, 2));

process.exit(0);
