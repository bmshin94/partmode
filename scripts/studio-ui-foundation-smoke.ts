import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Studio UI foundation smoke failed: ${label}`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const registryTools = await moduleAt('src/static/studio-v6-ui-registry.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const selection = await moduleAt('src/static/studio-selection-tools.js');
const fixture = JSON.parse(await readFile(resolve(root, 'tests/fixtures/three-body.json'), 'utf8')) as JsonRecord;
const project = runtime.canonicalStudioV5Project(fixture);
const part = runtime.studioV5RootPart(project);

let kernel: HeadlessKernel | null = null;
let bodies: JsonRecord[] = [];
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  const result = await kernel.request({
    kind: 'rebuild', requestId: 'ui-foundation-exact-bodies', projectId: project.projectId,
    revision: 1, document: project,
  }) as JsonRecord;
  check(`exact viewport source rebuild failed: ${JSON.stringify(result.errors || [])}`,
    result.kind === 'rebuild-result' && result.errors?.length === 0);
  bodies = result.bodies;
  check('exact viewport source did not return all document bodies', bodies.length === part.bodies.length && bodies.length === 3);
  for (const body of bodies) {
    const topology = body.mesh?.topologyCounts;
    check(`body ${body.bodyId} has no exact valid solid`, body.geometry?.valid === true && body.geometry?.brepValid === true);
    check(`body ${body.bodyId} has no render mesh`, body.mesh?.vertices?.byteLength > 0 && body.mesh?.triangles?.byteLength > 0);
    check(`body ${body.bodyId} lacks complete persistent face/edge/vertex identity`,
      topology?.faces === topology?.namedFaces && topology?.edges === topology?.namedEdges
      && topology?.vertices === topology?.namedVertices);
  }
} finally {
  await kernel?.dispose();
}

const [page, studio, registrySource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
]);
const expectedWorkspaces = ['home', 'sketch', 'solid', 'assembly', 'view', 'manage', 'output'];
const workspaceTabs = [...page.matchAll(/data-workspace="([^"]+)"/g)].map((match) => match[1]);
const workspacePanels = [...page.matchAll(/data-workspace-panel="([^"]+)"/g)].map((match) => match[1]);
check('ribbon workspace tabs are incomplete or duplicated', JSON.stringify(workspaceTabs) === JSON.stringify(expectedWorkspaces));
check('ribbon workspace panels do not match their tabs', workspacePanels.length === expectedWorkspaces.length
  && JSON.stringify([...workspacePanels].sort()) === JSON.stringify([...expectedWorkspaces].sort()));
check('workspace tabs do not carry tab semantics', page.includes('role="tablist"')
  && expectedWorkspaces.every((id) => page.includes(`data-workspace="${id}"`))
  && expectedWorkspaces.every((id) => page.includes(`id="ws-panel-${id}" role="tabpanel"`)));
check('production workspace routing is absent', studio.includes('function showWorkspace(name, forced, actor = \'system\')')
  && studio.includes("document.querySelectorAll('[data-workspace]')")
  && studio.includes('panel.hidden = panel.dataset.workspacePanel !== name'));

check('production WebGL viewport surface is missing', page.includes('id="bw-studio"')
  && studio.includes('new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true })')
  && studio.includes('new OrbitControls(camera, renderer.domElement)'));
check('exact rebuild bodies are not the viewport source', studio.includes('setBodyMeshData(response.bodies)')
  && studio.includes('function setBodyMeshData(bodies)') && studio.includes('nextMeshes.set(bodyResult.bodyId, shaded)')
  && studio.includes('bodyMeshes = nextMeshes'));
check('viewport does not route exact topology through ray selection', studio.includes('new THREE.Raycaster()')
  && studio.includes('topologyNameOf(') && studio.includes('topologySigOf('));

check('part feature tree does not enumerate the canonical document', part.features.length === 4
  && studio.includes('function renderHistory()') && studio.includes('partFeatures().forEach((f, i) =>'));
check('part and assembly tree surfaces are missing', page.includes('id="bw-tree"') && page.includes('id="bw-history"')
  && studio.includes('function renderBodies()') && studio.includes('function renderAssemblyTree()'));
check('tree rows lack accessible selection and state semantics', studio.includes("element.setAttribute('role', 'treeitem')")
  && studio.includes("element.setAttribute('aria-selected'") && studio.includes("options.failed ? 'failed'"));
check('feature tree does not share typed mutation history', studio.includes("commitHumanOperations('Delete ")
  && studio.includes("commit('Reorder feature history'") && studio.includes('setStudioV5RollbackMarker('));

check('selection foundation vocabulary changed', JSON.stringify(selection.STUDIO_SELECTION_FILTERS)
  === JSON.stringify(['auto', 'component', 'body', 'face', 'edge', 'vertex']));
check('selection foundation is not wired to exact displayed geometry', studio.includes("selectionFilter === 'component'")
  && studio.includes("selectionFilter === 'face'") && studio.includes("selectionFilter === 'edge'")
  && studio.includes("selectionFilter === 'vertex'"));

const controls = registryTools.cadUiControlRegistry();
const controlById = new Map<string, JsonRecord>(
  controls.map((control: JsonRecord): [string, JsonRecord] => [String(control.id), control]),
);
check('typed registry omits one or more workspaces', expectedWorkspaces.every((id) => {
  const expectedAdapter = id === 'sketch' ? 'contextual' : 'available';
  return controlById.get('workspace.' + id)?.adapter === expectedAdapter;
}));
check('typed registry omits the viewport canvas', controlById.get('viewport.canvas')?.adapter === 'available'
  && controlById.get('viewport.canvas')?.semanticActions.includes('selection.set'));
check('typed registry omits core feature-tree actions', ['tree.feature.select', 'tree.feature.move-earlier', 'tree.feature.move-later',
  'tree.feature.rollback-toggle', 'tree.feature.edit', 'tree.feature.delete', 'tree.feature.drag-reorder']
  .every((id) => controlById.get(id)?.adapter === 'available'));
check('registry source does not retain dynamic model-tree bindings', registrySource.includes("dynamicBinding('model-tree.entity')"));

console.log(JSON.stringify({
  schema: 'partmode.ui-foundation-smoke/v1',
  ribbon: { workspaces: expectedWorkspaces, tabs: workspaceTabs.length, panels: workspacePanels.length },
  viewport: {
    exactBodies: bodies.length,
    meshBytes: bodies.reduce((total, body) => total + body.mesh.vertices.byteLength + body.mesh.triangles.byteLength, 0),
    persistentTopology: true,
  },
  selection: selection.STUDIO_SELECTION_FILTERS,
  featureTree: { partFeatures: part.features.length, typedActions: 7 },
  registryControls: controls.length,
}, null, 2));

process.exit(0);
