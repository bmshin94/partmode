import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Face Fillet smoke failed: ${label}`);
}

function closeTo(actual: number, expected: number, tolerance = 2e-5): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function rejection(label: string, source: JsonRecord, action: () => unknown, pattern: RegExp): void {
  const before = JSON.stringify(source);
  let error: unknown = null;
  try { action(); } catch (candidate) { error = candidate; }
  check(label, error instanceof Error && pattern.test(error.message));
  check(`${label} mutated its source`, JSON.stringify(source) === before);
}

const root = process.cwd();
const moduleAt = async (path: string) => import(pathToFileURL(resolve(root, path)).href) as Promise<any>;
const projectModule = await moduleAt('src/static/studio-project-v5.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const agent = await moduleAt('src/static/studio-agent-service.js');
const uiRegistry = await moduleAt('src/static/studio-v6-ui-registry.js');
const uiInteraction = await moduleAt('src/static/studio-v6-interaction.js');
const featureTypes = await moduleAt('src/static/studio-v5-feature-types.js');

const faceCommand = uiRegistry.cadUiCommandDefinition('model.face-fillet');
check('visible face-fillet command is not fully advertised', faceCommand?.adapter === 'available'
  && faceCommand.operationKinds.includes('feature.faceFillet')
  && faceCommand.fields.some((field: JsonRecord) => field.id === 'faces' && field.minItems === 2 && field.maxItems === 2)
  && faceCommand.fields.some((field: JsonRecord) => field.id === 'radius'));
const pageSource = await readFile(resolve(root, 'src/page.html'), 'utf8');
check('human face-fillet ribbon control is missing', pageSource.includes('data-v5-command="face-fillet"'));
const workerSource = await readFile(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8');
check('worker does not derive the exact shared edge from two selected faces', workerSource.includes("mode === 'adjacent-face-pair'")
  && workerSource.includes('selected faces are not adjacent')
  && workerSource.includes('ambiguous shared-edge set'));
const buildSource = await readFile(resolve(root, 'scripts/build.ts'), 'utf8');
check('release asset allowlist omits the advanced Fillet contract', buildSource.includes("'studio-advanced-fillet.js'"));

const topFace = { p: [0, 0, 8], n: [0, 0, 1] };
const rightFace = { p: [6, 0, 4], n: [1, 0, 0] };
const bottomFace = { p: [0, 0, 0], n: [0, 0, -1] };
const selection = (name: string, signature: JsonRecord): JsonRecord => ({
  owner: { kind: 'body', id: 'body-pattern-source' },
  stableId: `n:${name}`,
  topologySignature: { kind: 'face', ...signature },
});
const visibleTransaction = uiInteraction.buildCadUiCommandTransaction({
  expectedRevision: 0,
  transactionId: 'visible-face-fillet',
  draft: {
    commandId: 'model.face-fillet', draftId: 'draft-face-fillet', baseRevision: 0,
    inputValues: { name: 'Visible face fillet', radius: 2 },
    boundSelections: {
      body: [{ kind: 'body', id: 'body-pattern-source' }],
      faces: [selection('face-top', topFace), selection('face-right', rightFace)],
    },
    generatedIds: { featureId: 'feature-visible-face-fillet' }, bootstrapOperations: [],
  },
}).transaction;
check('visible adapter did not produce one typed face-fillet operation', visibleTransaction.operations.length === 1
  && visibleTransaction.operations[0].kind === 'feature.faceFillet'
  && visibleTransaction.operations[0].input.faceRefs.length === 2
  && visibleTransaction.operations[0].input.radius === 2);
const visibleEdit = uiInteraction.buildCadUiCommandTransaction({
  expectedRevision: 1,
  transactionId: 'visible-face-fillet-edit',
  draft: {
    commandId: 'model.face-fillet', draftId: 'draft-face-fillet-edit', baseRevision: 1,
    editEntity: { kind: 'feature', id: 'feature-face-fillet' },
    inputValues: { name: 'Visible edited face fillet', radius: 3 },
    boundSelections: {
      body: [{ kind: 'body', id: 'body-pattern-source' }],
      faces: [selection('face-top', topFace), selection('face-right', rightFace)],
    },
    generatedIds: { featureId: 'feature-face-fillet' }, bootstrapOperations: [],
  },
}).transaction;
check('visible edit adapter did not produce one typed advanced update', visibleEdit.operations.length === 1
  && visibleEdit.operations[0].kind === 'feature.advanced.update'
  && visibleEdit.operations[0].input.featureId === 'feature-face-fillet'
  && visibleEdit.operations[0].input.patch.radius === 3
  && visibleEdit.operations[0].input.patch.faces.length === 2);

const fixture = JSON.parse(await readFile(resolve(root, 'tests/body-pattern-runtime/body-patterns.partmode.json'), 'utf8')) as JsonRecord;
fixture.projectId = 'project-face-fillet';
fixture.name = 'Adjacent face fillet acceptance';
fixture.partDefinitions[0].bodyPatterns = [];
const base = projectModule.prepareStudioV5Project(fixture) as JsonRecord;
const apply = (source: JsonRecord, id: string, operations: JsonRecord[]): JsonRecord => agent.applyCadTransaction(source, {
  transactionId: id, label: id, expectedRevision: 0, atomic: true, operations,
}).project as JsonRecord;

const project = apply(base, 'create-face-fillet', [{
  kind: 'feature.faceFillet',
  input: {
    id: 'feature-face-fillet', name: 'Top right face fillet', bodyId: 'body-pattern-source',
    faceRefs: [topFace, rightFace], radius: 2,
  },
}]);
const feature = runtime.studioV5RootPart(project).features.at(-1);
check('typed transaction lost the source-owned face-fillet recipe', feature.extensions?.advancedFillet?.schema === 'partmode.advanced-fillet/v1'
  && feature.extensions.advancedFillet.mode === 'adjacent-face-pair'
  && feature.faces.length === 2 && feature.edges.length === 0 && feature.r === 2);
featureTypes.assertStudioV5FeatureStructure(feature, 'stored-face-fillet');
const canonicalText = JSON.stringify(projectModule.prepareStudioV5Project(project));
const reopened = projectModule.parseStudioV5Project(canonicalText) as JsonRecord;
check('face fillet changed across canonical save/reopen', JSON.stringify(reopened) === canonicalText);

const dependencies = new agent.CadCommandService({ project: reopened }).inspect({
  kind: 'entity.dependencies', entity: { kind: 'body', id: 'body-pattern-source' }, direction: 'downstream',
});
check('target body dependency is absent', dependencies.items.some((edge: JsonRecord) =>
  edge.from.id === 'body-pattern-source' && edge.to.id === 'feature-face-fillet'));

rejection('duplicate face references did not fail closed', base, () => apply(base, 'duplicate-face-fillet', [{
  kind: 'feature.faceFillet',
  input: { id: 'feature-duplicate-face-fillet', bodyId: 'body-pattern-source', faceRefs: [topFace, topFace], radius: 2 },
}]), /distinct face references/u);
rejection('wrong face cardinality did not fail closed', base, () => apply(base, 'short-face-fillet', [{
  kind: 'feature.faceFillet',
  input: { id: 'feature-short-face-fillet', bodyId: 'body-pattern-source', faceRefs: [topFace], radius: 2 },
}]), /at least 2 items|requires exactly two/u);
const tampered = structuredClone(project);
tampered.partDefinitions[0].features.at(-1).extensions.advancedFillet.schema = 'partmode.advanced-fillet/tampered';
rejection('tampered face-fillet recipe did not fail closed', tampered,
  () => featureTypes.assertStudioV5FeatureStructure(tampered.partDefinitions[0].features.at(-1)),
  /edges must be an array with 1|source-owned advanced Fillet contract|schema partmode\.advanced-fillet\/v1/u);

function exactBody(result: JsonRecord, label: string): JsonRecord {
  check(`${label} exact rebuild failed: ${JSON.stringify(result.errors || [])}`,
    result.kind === 'rebuild-result' && result.errors?.length === 0 && result.warnings?.length === 0);
  check(`${label} did not publish one exact valid body`, result.bodies?.length === 1);
  const body = result.bodies[0];
  const counts = body.mesh?.topologyCounts;
  check(`${label} exact B-rep/topology is incomplete`, body.error == null && body.lastValid === false
    && body.geometry?.valid === true && body.geometry?.brepValid === true && body.geometry?.solidCount === 1
    && typeof body.exactBrep === 'string' && body.exactBrep.length > 0
    && counts?.faces === counts?.namedFaces && counts?.edges === counts?.namedEdges && counts?.vertices === counts?.namedVertices);
  return body;
}

const expectedVolume = (radius: number): number => 12 * 8 * 8 - 8 * radius ** 2 * (1 - Math.PI / 4);
let kernel: HeadlessKernel | null = null;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  let revision = 0;
  const rebuild = async (document: JsonRecord, label: string): Promise<JsonRecord> => {
    revision += 1;
    return kernel!.request({
      kind: 'rebuild', requestId: `face-fillet-${revision}-${label}`,
      projectId: document.projectId, revision, document, includeExactBrep: true,
    }, 180_000) as Promise<JsonRecord>;
  };

  const radiusTwo = exactBody(await rebuild(reopened, 'radius-two'), 'radius-two');
  check('radius-two bounds changed', JSON.stringify(radiusTwo.geometry.bounds) === JSON.stringify([[-6, -4, 0], [6, 4, 8]]));
  check('radius-two exact volume changed', closeTo(radiusTwo.geometry.volume, expectedVolume(2)));

  const radiusThreeProject = apply(reopened, 'update-face-fillet', [{
    kind: 'feature.advanced.update', input: { featureId: 'feature-face-fillet', patch: { radius: 3 } },
  }]);
  const radiusThreeFeature = runtime.studioV5RootPart(radiusThreeProject).features.at(-1);
  check('typed edit did not preserve the face-pair recipe', radiusThreeFeature.r === 3
    && radiusThreeFeature.faces.length === 2 && radiusThreeFeature.extensions?.advancedFillet?.mode === 'adjacent-face-pair');
  const radiusThree = exactBody(await rebuild(radiusThreeProject, 'radius-three'), 'radius-three');
  check('radius edit reused stale exact geometry', closeTo(radiusThree.geometry.volume, expectedVolume(3))
    && !closeTo(radiusThree.geometry.volume, radiusTwo.geometry.volume));

  const nonAdjacent = apply(base, 'create-nonadjacent-face-fillet', [{
    kind: 'feature.faceFillet',
    input: {
      id: 'feature-nonadjacent-face-fillet', name: 'Nonadjacent face fillet', bodyId: 'body-pattern-source',
      faceRefs: [topFace, bottomFace], radius: 2,
    },
  }]);
  nonAdjacent.projectId = 'project-face-fillet-nonadjacent';
  const rejected = await rebuild(nonAdjacent, 'nonadjacent');
  check('non-adjacent exact face pair did not fail closed', rejected.errors?.some((entry: JsonRecord) =>
    entry.featureId === 'feature-nonadjacent-face-fillet' && /not adjacent/u.test(entry.message)));
  check('non-adjacent face pair published modified exact geometry', !rejected.bodies?.some((body: JsonRecord) =>
    body.error == null && body.geometry?.valid === true && closeTo(body.geometry.volume, expectedVolume(2))));

  console.log(JSON.stringify({
    schema: 'partmode.face-fillet-smoke/v1',
    exactRebuilds: 3,
    proven: {
      selection: 'exactly two adjacent persistent face references with one derived shared OCCT edge',
      radiusTwoVolume: radiusTwo.geometry.volume,
      radiusThreeVolume: radiusThree.geometry.volume,
      bounds: radiusThree.geometry.bounds,
      topology: radiusThree.mesh.topologyCounts,
    },
    persistence: 'visible command plus typed transaction plus canonical save/reopen plus typed edit',
    failClosed: ['duplicate faces', 'wrong cardinality', 'tampered recipe', 'non-adjacent faces'],
    excluded: ['full-round fillet', 'setback corners', 'ambiguous multi-edge face pairs'],
  }, null, 2));
} finally {
  await kernel?.dispose();
}
