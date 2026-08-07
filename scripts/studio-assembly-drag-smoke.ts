import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Assembly drag smoke failed: ${label}`);
}

function expectCode(label: string, fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Assembly drag smoke failed: ${label} did not fail`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const assemblyTools = await moduleAt('src/static/studio-v5-assembly.js');
const dragTools = await moduleAt('src/static/studio-assembly-drag.js');
const agentTools = await moduleAt('src/static/studio-agent-service.js');
const registryTools = await moduleAt('src/static/studio-v6-ui-registry.js');
const interactionTools = await moduleAt('src/static/studio-v6-interaction.js');

const sourceFixture = JSON.parse(await readFile(
  resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'),
  'utf8',
)) as JsonRecord;
const authored = structuredClone(sourceFixture);
authored.projectId = 'assembly-drag-chain';
authored.name = 'Mate-driven three-component drag';
const assembly = authored.assemblyDefinitions[0];
const transform = (z: number): number[] => assemblyTools.studioV5TranslationMatrix([0, 0, z]);
assembly.occurrences = [
  {
    id: 'occurrence-base', name: 'Fixed base', definition: { kind: 'part', partId: 'part-base-block' },
    baseTransform: transform(0), fixed: true, suppressed: false, visible: true,
  },
  {
    id: 'occurrence-driver', name: 'Dragged carriage', definition: { kind: 'part', partId: 'part-moving-block' },
    baseTransform: transform(10), fixed: false, suppressed: false, visible: true,
  },
  {
    id: 'occurrence-follower', name: 'Following carriage', definition: { kind: 'part', partId: 'part-moving-block' },
    baseTransform: transform(20), fixed: false, suppressed: false, visible: true,
  },
];
const occurrenceReference = (occurrenceId: string): JsonRecord => ({
  ownerKind: 'occurrence', ownerId: occurrenceId, occurrencePath: [occurrenceId],
  semanticPath: { role: 'component-origin-plane' },
  signature: { role: 'plane', normal: [0, 0, 1] },
});
assembly.mates = [
  {
    id: 'mate-base-slider', name: 'Carriage slider', kind: 'slider',
    occurrenceIds: ['occurrence-base', 'occurrence-driver'],
    references: [occurrenceReference('occurrence-base'), occurrenceReference('occurrence-driver')],
    suppressed: false,
  },
  {
    id: 'mate-follower-distance', name: 'Follower spacing', kind: 'distance', value: 10,
    occurrenceIds: ['occurrence-driver', 'occurrence-follower'],
    references: [occurrenceReference('occurrence-driver'), occurrenceReference('occurrence-follower')],
    suppressed: false,
  },
];
assembly.occurrencePatterns = [];
assembly.explodedViews = [];
assembly.sectionViews = [];
const project = runtime.canonicalStudioV5Project(authored);
const sourceJson = JSON.stringify(project);

const preview = dragTools.previewStudioAssemblyDrag(project, 'occurrence-driver', transform(25));
check('drag response schema changed', preview.schema === 'partmode.assembly-drag/v1');
check('drag mutated its source document', JSON.stringify(project) === sourceJson);
check('drag did not move the driver and follower only', JSON.stringify(preview.affectedOccurrenceIds)
  === JSON.stringify(['occurrence-driver', 'occurrence-follower']));
check('driver did not retain the exact target transform', preview.occurrenceTransforms['occurrence-driver'][14] === 25);
check('follower did not preserve its exact 10 mm mate distance', Math.abs(preview.occurrenceTransforms['occurrence-follower'][14] - 35) < 1e-7);
check('fixed base moved during drag', JSON.stringify(preview.occurrenceTransforms['occurrence-base']) === JSON.stringify(transform(0)));
const settled = assemblyTools.solveStudioV5Assembly(preview.project, assembly.id);
check('committed drag does not remain a valid mate solution', settled.errors.length === 0 && settled.usedLastValid === false);
check('settled driver or follower drifted', Math.abs(settled.transforms.get('occurrence-driver')[14] - 25) < 1e-7
  && Math.abs(settled.transforms.get('occurrence-follower')[14] - 35) < 1e-7);
const reopened = runtime.canonicalStudioV5Project(JSON.parse(JSON.stringify(preview.project)));
const reopenedSettled = assemblyTools.solveStudioV5Assembly(reopened, assembly.id);
check('saved and reopened drag does not remain a valid mate solution', reopenedSettled.errors.length === 0 && reopenedSettled.usedLastValid === false);
check('saved and reopened placements drifted', Math.abs(reopenedSettled.transforms.get('occurrence-driver')[14] - 25) < 1e-7
  && Math.abs(reopenedSettled.transforms.get('occurrence-follower')[14] - 35) < 1e-7);

const reversed = structuredClone(project);
reversed.assemblyDefinitions[0].mates.reverse();
const reversedPreview = dragTools.previewStudioAssemblyDrag(reversed, 'occurrence-driver', transform(25));
check('drag depends on mate declaration order', JSON.stringify(reversedPreview.occurrenceTransforms)
  === JSON.stringify(preview.occurrenceTransforms));
expectCode('fixed component drag', () => dragTools.previewStudioAssemblyDrag(project, 'occurrence-base', transform(5)), 'ASSEMBLY_DRAG_OCCURRENCE_FIXED');
const reflected = transform(25); reflected[0] = -1;
expectCode('reflected transform', () => dragTools.previewStudioAssemblyDrag(project, 'occurrence-driver', reflected), 'ASSEMBLY_DRAG_TRANSFORM_INVALID');
const impossible = transform(25); impossible[12] = 5;
expectCode('off-axis slider drag', () => dragTools.previewStudioAssemblyDrag(project, 'occurrence-driver', impossible), 'ASSEMBLY_DRAG_UNSATISFIED');
check('failed drags mutated the source document', JSON.stringify(project) === sourceJson);

const transaction = agentTools.applyCadTransaction(project, {
  transactionId: 'transaction-drag-with-mates', label: 'Drag carriage with mates', expectedRevision: 0, atomic: true,
  operations: [{ kind: 'assembly.drag', input: { occurrenceId: 'occurrence-driver', targetTransform: transform(25) } }],
});
check('typed transaction does not use the mate-driven result', JSON.stringify(transaction.project) === JSON.stringify(preview.project));
check('typed transaction does not report both changed placements', transaction.changeSet.transformDiffs.length === 2);
const visibleCommand = interactionTools.buildCadUiCommandTransaction({
  draft: {
    draftId: 'draft-drag-with-mates', commandId: 'assembly.component-transform', baseRevision: 0,
    boundSelections: { occurrence: [{ kind: 'occurrence', id: 'occurrence-driver' }] },
    inputValues: { transform: transform(25) }, generatedIds: {},
  },
  expectedRevision: 0,
  transactionId: 'transaction-visible-drag-with-mates',
});
check('visible command adapter does not author the typed drag operation', visibleCommand.transaction.operations.length === 1
  && visibleCommand.transaction.operations[0].kind === 'assembly.drag'
  && visibleCommand.transaction.operations[0].input.occurrenceId === 'occurrence-driver');

let kernel: HeadlessKernel | null = null;
let exact: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  exact = await kernel.request({
    kind: 'rebuild', requestId: 'assembly-drag-exact', projectId: project.projectId,
    revision: 1, document: preview.project,
  }) as JsonRecord;
} finally {
  await kernel?.dispose();
}
check(`exact dragged assembly rebuild failed ${JSON.stringify(exact.errors || [])}`,
  exact.kind === 'rebuild-result' && exact.errors?.length === 0 && exact.bodies?.length === 3);
const exactByOccurrence = new Map<string, JsonRecord>(exact.bodies.map((body: JsonRecord): [string, JsonRecord] => [body.occurrenceInstance.occurrenceId, body]));
const driverBounds = exactByOccurrence.get('occurrence-driver')?.geometry?.bounds;
const followerBounds = exactByOccurrence.get('occurrence-follower')?.geometry?.bounds;
check(`exact driver bounds do not match the 25 mm solved station ${JSON.stringify(driverBounds)}`,
  Math.abs(driverBounds?.[0]?.[2] - 25) < 1e-7 && Math.abs(driverBounds?.[1]?.[2] - 39) < 1e-7);
check(`exact follower bounds do not match the 35 mm solved station ${JSON.stringify(followerBounds)}`,
  Math.abs(followerBounds?.[0]?.[2] - 35) < 1e-7 && Math.abs(followerBounds?.[1]?.[2] - 49) < 1e-7);
check('linked dragged components do not retain shared exact render geometry', exact.bodies.filter((body: JsonRecord) => body.sourceBodyId === 'body-moving-block').some((body: JsonRecord) => body.sharesSourceGeometry === true));

const [studioSource, pageSource, interactionSource, buildSource] = await Promise.all([
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-interaction.js'), 'utf8'),
  readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
]);
check('visible Studio does not preview the simultaneous mate solution', studioSource.includes('previewStudioAssemblyDrag(doc, preview.occurrenceId, cad)')
  && studioSource.includes('drag.occurrenceTransforms[entry.occurrenceId]'));
check('visible Apply does not commit the settled chain atomically', studioSource.includes('previewStudioAssemblyDrag(candidate, occurrenceId, matrix).project'));
check('shipped ribbon does not expose Drag with mates', pageSource.includes('data-assembly-command="transform"')
  && pageSource.includes('Drag with mates'));
check('typed visible command does not author assembly.drag', interactionSource.includes("kind: 'assembly.drag'")
  && interactionSource.includes('targetTransform: clone(transform)'));
check('drag module is not release-packaged', buildSource.includes("'studio-assembly-drag.js'"));
const control = registryTools.cadUiControlRegistry().find((entry: JsonRecord) => entry.id === 'assembly.component-transform');
check('typed UI registry does not advertise mate-driven drag', control?.adapter === 'available'
  && control.operationKinds?.includes('assembly.drag'));

console.log(JSON.stringify({
  schema: preview.schema,
  affectedOccurrenceIds: preview.affectedOccurrenceIds,
  stationsMm: Object.fromEntries(Object.entries(preview.occurrenceTransforms).map(([id, value]: [string, any]) => [id, value[14]])),
  exactBounds: Object.fromEntries([...exactByOccurrence].map(([id, body]) => [id, body.geometry.bounds])),
  solver: preview.solver,
  atomicTransactionPlacements: transaction.changeSet.transformDiffs.length,
}, null, 2));

process.exit(0);
