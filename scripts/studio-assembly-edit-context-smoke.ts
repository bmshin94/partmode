import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Assembly edit-context smoke failed: ${name}`);
}

function throws(name: string, fn: () => unknown, message: string): void {
  try {
    fn();
  } catch (error: any) {
    check(name, String(error?.message || error).includes(message));
    return;
  }
  throw new Error(`Assembly edit-context smoke failed: ${name}`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const editContextTools = await moduleAt('src/static/studio-assembly-edit-context.js');
const assemblyTools = await moduleAt('src/static/studio-v5-assembly.js');
const agentTools = await moduleAt('src/static/studio-agent-service.js');

const fixture = JSON.parse(readFileSync(
  resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'),
  'utf8',
)) as any;

const withLinkedOccurrence = runtime.createStudioV5ComponentOccurrence(fixture, {
  id: 'occurrence-moving-linked',
  name: 'Moving block linked copy',
  definition: { kind: 'part', partId: 'part-moving-block' },
  baseTransform: assemblyTools.studioV5TranslationMatrix([30, 0, 0]),
  fixed: false,
  visible: true,
});
const entered = runtime.enterStudioV5AssemblyContext(withLinkedOccurrence, 'occurrence-moving');
const context = editContextTools.studioAssemblyEditContext(entered, { required: true });
check('enter keeps the owning assembly identity', context.assemblyId === 'assembly-two-blocks');
check('enter activates the occurrence part definition', entered.rootDocument.kind === 'part' && entered.rootDocument.partId === 'part-moving-block');
check('enter stores one exact occurrence path', JSON.stringify(context.occurrencePath) === JSON.stringify(['occurrence-moving']));

const display = editContextTools.studioAssemblyEditContextDisplayProject(entered);
check('display projection evaluates the owning assembly', display.rootDocument.kind === 'assembly' && display.rootDocument.assemblyId === 'assembly-two-blocks');
check('display projection does not mutate the editable document', entered.rootDocument.kind === 'part');
const solved = assemblyTools.solveStudioV5Assembly(display, 'assembly-two-blocks');
check('owning assembly still solves in edit context', solved.errors.length === 0);
check('display includes active and surrounding component placements', solved.leafOccurrences.length === 3);
const activeLeaf = solved.leafOccurrences.find((entry: any) => entry.id === 'occurrence-moving');
const baseLeaf = solved.leafOccurrences.find((entry: any) => entry.id === 'occurrence-base');
const linkedLeaf = solved.leafOccurrences.find((entry: any) => entry.id === 'occurrence-moving-linked');
check('active occurrence has its exact solved transform', activeLeaf && activeLeaf.transform.length === 16);
check('surrounding fixed occurrence remains available', baseLeaf && baseLeaf.transform.length === 16);
check('surrounding linked occurrence retains authored placement', linkedLeaf && linkedLeaf.transform.slice(12, 15).join(',') === '30,0,0');
check('only the chosen path is classified active', editContextTools.studioAssemblyEditContextRole(entered, activeLeaf.occurrencePath) === 'active');
check('other occurrences are classified surrounding',
  editContextTools.studioAssemblyEditContextRole(entered, baseLeaf.occurrencePath) === 'surrounding'
  && editContextTools.studioAssemblyEditContextRole(entered, linkedLeaf.occurrencePath) === 'surrounding');
check('active runtime body maps to editable source identity', editContextTools.studioAssemblyEditContextBodyId(entered, {
  bodyId: 'occurrence-moving:body-moving-block',
  sourceBodyId: 'body-moving-block',
  occurrenceInstance: { occurrencePath: activeLeaf.occurrencePath },
}) === 'body-moving-block');
check('surrounding runtime body is not editable', editContextTools.studioAssemblyEditContextBodyId(entered, {
  bodyId: 'occurrence-base:body-base-block',
  sourceBodyId: 'body-base-block',
  occurrenceInstance: { occurrencePath: baseLeaf.occurrencePath },
}) === null);

const edited = agentTools.applyCadTransaction(entered, {
  transactionId: 'transaction-edit-in-context',
  label: 'Edit moving component height in context',
  expectedRevision: 0,
  atomic: true,
  operations: [{ kind: 'feature.update', input: { featureId: 'feature-moving-extrude', patch: { h: 18 } } }],
}).project;
check('part edit preserves assembly edit context', editContextTools.studioAssemblyEditContext(edited, { required: true }).occurrence.id === 'occurrence-moving');
check('part edit changes the shared definition exactly', edited.partDefinitions.find((entry: any) => entry.id === 'part-moving-block').features.find((entry: any) => entry.id === 'feature-moving-extrude').h === 18);
const editedDisplay = editContextTools.studioAssemblyEditContextDisplayProject(edited);
const editedOccurrences = editedDisplay.assemblyDefinitions[0].occurrences.filter((entry: any) => entry.definition?.partId === 'part-moving-block');
check('active and linked occurrences still share the edited part definition', editedOccurrences.length === 2 && editedOccurrences.every((entry: any) => entry.definition.partId === 'part-moving-block'));
check('edited owning assembly still solves', assemblyTools.solveStudioV5Assembly(editedDisplay, 'assembly-two-blocks').errors.length === 0);

let kernel: HeadlessKernel | null = null;
let exactBefore: any;
let exactAfter: any;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  exactBefore = await kernel.request({
    kind: 'rebuild', requestId: 'assembly-edit-context-before', projectId: entered.projectId,
    revision: 1, document: entered,
  });
  exactAfter = await kernel.request({
    kind: 'rebuild', requestId: 'assembly-edit-context-after', projectId: edited.projectId,
    revision: 2, document: edited,
  });
} finally {
  await kernel?.dispose();
}
check('production kernel did not rebuild the owning assembly in edit context', exactBefore?.kind === 'rebuild-result'
  && exactBefore.errors?.length === 0 && exactBefore.bodies?.length === 3);
check('production kernel did not rebuild the edited shared definition', exactAfter?.kind === 'rebuild-result'
  && exactAfter.errors?.length === 0 && exactAfter.bodies?.length === 3);
const movingBefore = exactBefore.bodies.filter((body: any) => body.sourceBodyId === 'body-moving-block');
const movingAfter = exactAfter.bodies.filter((body: any) => body.sourceBodyId === 'body-moving-block');
check('exact display does not include active and linked shared-definition occurrences', movingBefore.length === 2
  && movingAfter.length === 2);
check('exact in-context edit did not update both linked occurrence volumes', movingBefore.every((body: any) => Math.abs(body.geometry?.volume - 1344) < 1e-8)
  && movingAfter.every((body: any) => Math.abs(body.geometry?.volume - 1728) < 1e-8));
check('exact in-context edit did not retain shared render geometry', movingAfter.some((body: any) => body.mesh)
  && movingAfter.some((body: any) => body.sharesSourceGeometry === true));
const movingMesh = movingAfter.find((body: any) => body.mesh)?.mesh;
check(`edited exact body does not publish complete selectable topology ${JSON.stringify(movingMesh?.topologyCounts || null)}`,
  movingMesh?.topologyCounts?.faces === 6 && movingMesh?.topologyCounts?.edges === 12
  && movingMesh?.topologyCounts?.vertices === 8 && movingMesh?.topologyFaces?.length === 6
  && movingMesh?.edges?.length === 12 && movingMesh?.topologyVertices?.length === 8);

const reopened = JSON.parse(JSON.stringify(edited));
check('edit context survives project save and reopen', editContextTools.studioAssemblyEditContext(reopened, { required: true }).partId === 'part-moving-block');
const exited = runtime.exitStudioV5AssemblyContext(reopened);
check('exit restores owning assembly', exited.rootDocument.kind === 'assembly' && exited.rootDocument.assemblyId === 'assembly-two-blocks');
check('exit removes edit-context metadata', exited.metadata.editContext === undefined);
check('exit preserves the in-context feature edit', exited.partDefinitions.find((entry: any) => entry.id === 'part-moving-block').features.find((entry: any) => entry.id === 'feature-moving-extrude').h === 18);

const missingAssembly = structuredClone(entered);
missingAssembly.assemblyDefinitions = [];
throws('missing owning assembly fails closed', () => editContextTools.studioAssemblyEditContextDisplayProject(missingAssembly), 'owning assembly');
const mismatchedPart = structuredClone(entered);
mismatchedPart.rootDocument = { kind: 'part', partId: 'part-base-block' };
throws('mismatched active part fails closed', () => editContextTools.studioAssemblyEditContextDisplayProject(mismatchedPart), 'does not match');

const workerSource = readFileSync(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8');
const studioSource = readFileSync(resolve(root, 'src/static/studio.js'), 'utf8');
const pageSource = readFileSync(resolve(root, 'src/page.html'), 'utf8');
check('kernel rebuild projects edit context through the owning assembly',
  workerSource.includes('studioAssemblyEditContextDisplayProject(context.effectiveDocument)')
  && workerSource.includes('return rebuildV5Assembly'));
check('surrounding geometry has an explicit ghost render role', studioSource.includes("editContextRole === 'surrounding'") && studioSource.includes("'edit-context-ghost'"));
check('surrounding geometry is excluded from topology and pointer selection',
  studioSource.includes("mesh.userData.editContextRole === 'surrounding'")
  && studioSource.includes("editContextRole !== 'surrounding'"));
check('active topology keeps editable source ownership without leaking runtime ids',
  studioSource.includes("lastBodyResults.find((entry) => entry.bodyId === bodyId)?.sourceBodyId || bodyId")
  && studioSource.includes('const runtimeBodyId = v6TopologyRuntimeBodyId(match)')
  && studioSource.includes('_topologyName, _runtimeBodyId, _faceId'));
check('visible context banner has an ordinary return control',
  pageSource.includes('id="bw-edit-context-banner"')
  && pageSource.includes('data-assembly-command="exit-context"'));

console.log(JSON.stringify({
  context: { assemblyId: context.assemblyId, occurrencePath: context.occurrencePath, partId: context.partId },
  display: { occurrences: solved.leafOccurrences.length, active: 1, surrounding: 2 },
  linkedEdit: {
    sharedOccurrences: editedOccurrences.length,
    height: 18,
    volumes: movingAfter.map((body: any) => body.geometry.volume),
    topology: movingMesh.topologyCounts,
  },
  saveReopen: 'preserved',
  failClosed: ['missing-assembly', 'mismatched-part'],
}, null, 2));
