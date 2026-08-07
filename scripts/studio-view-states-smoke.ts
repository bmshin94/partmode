import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`View states smoke failed: ${label}`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const tools = await moduleAt('src/static/studio-view-states.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const fixture = JSON.parse(await readFile(resolve(root, 'tests/fixtures/three-body.json'), 'utf8'));

const withOrientation = tools.saveStudioViewOrientation(fixture, {
  id: 'view-inspection',
  name: 'Inspection view',
  camera: { position: [90, 80, 130], target: [0, 5, 0], up: [0, 1, 0] },
});
check('orientation mutation changed the source document', fixture.extensions?.partmodeViewStates === undefined);
const activatedOrientation = tools.activateStudioViewOrientation(withOrientation, 'view-inspection');
check('orientation did not preserve its exact camera', JSON.stringify(activatedOrientation.orientation.camera)
  === JSON.stringify({ position: [90, 80, 130], target: [0, 5, 0], up: [0, 1, 0] }));

const withDisplay = tools.saveStudioDisplayState(activatedOrientation.project, {
  id: 'display-housing-only',
  name: 'Housing only',
  hiddenBodyIds: ['body-feature-shaft', 'body-feature-tool'],
  hiddenOccurrenceIds: [],
  isolatedBodyId: 'body-feature-housing',
  displayMode: 'shaded-edges',
});
const appliedPart = tools.activateStudioDisplayState(withDisplay, 'display-housing-only');
const part = runtime.studioV5RootPart(appliedPart.project);
check('part display state did not restore exact visibility', part.bodies.find((body: any) => body.id === 'body-feature-housing').visible === true
  && part.bodies.filter((body: any) => body.id !== 'body-feature-housing').every((body: any) => body.visible === false));
const reopened = runtime.canonicalStudioV5Project(JSON.parse(JSON.stringify(appliedPart.project)));
const reopenedManager = tools.studioViewStateManager(reopened);
check('view manager did not survive canonical save and reopen', reopenedManager.orientations.length === 1
  && reopenedManager.displayStates.length === 1
  && reopenedManager.activeOrientationId === 'view-inspection'
  && reopenedManager.activeDisplayStateId === 'display-housing-only');

let danglingRejected = false;
try {
  tools.activateStudioDisplayState(tools.saveStudioDisplayState(fixture, {
    id: 'display-dangling', name: 'Dangling', hiddenBodyIds: ['body-missing'], hiddenOccurrenceIds: [], displayMode: 'shaded',
  }), 'display-dangling');
} catch { danglingRejected = true; }
check('dangling display-state reference did not fail closed', danglingRejected);
let invalidCameraRejected = false;
try {
  tools.saveStudioViewOrientation(fixture, {
    id: 'view-invalid', name: 'Invalid', camera: { position: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0] },
  });
} catch { invalidCameraRejected = true; }
check('degenerate camera did not fail closed', invalidCameraRejected);

const assemblyFixture = JSON.parse(await readFile(resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'), 'utf8'));
const withAssemblyDisplay = tools.saveStudioDisplayState(assemblyFixture, {
  id: 'display-moving-only',
  name: 'Moving component only',
  hiddenBodyIds: [],
  hiddenOccurrenceIds: ['occurrence-base'],
  isolatedOccurrenceId: 'occurrence-moving',
  displayMode: 'ghost',
});
const appliedAssembly = tools.activateStudioDisplayState(withAssemblyDisplay, 'display-moving-only');
const assembly = runtime.studioV5RootAssembly(appliedAssembly.project);
check('assembly display state did not restore exact visibility and mode', assembly.occurrences.find((entry: any) => entry.id === 'occurrence-base').visible === false
  && assembly.occurrences.find((entry: any) => entry.id === 'occurrence-moving').visible === true
  && assembly.metadata.displayMode === 'ghost');

const deleted = tools.deleteStudioViewOrientation(
  tools.deleteStudioDisplayState(appliedPart.project, 'display-housing-only'),
  'view-inspection',
);
const empty = tools.studioViewStateManager(deleted);
check('delete did not clear records and active references', empty.orientations.length === 0 && empty.displayStates.length === 0
  && empty.activeOrientationId === undefined && empty.activeDisplayStateId === undefined);

const page = await readFile(resolve(root, 'src/page.html'), 'utf8');
const studio = await readFile(resolve(root, 'src/static/studio.js'), 'utf8');
const registry = await readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8');
const build = await readFile(resolve(root, 'scripts/build.ts'), 'utf8');
check('visible view-state manager controls are missing', ['bw-view-state-name', 'bw-orientation-save', 'bw-display-state-save', 'bw-orientation-list', 'bw-display-state-list']
  .every((id) => page.includes(`id="${id}"`)));
check('production runtime is not wired to persisted view states', studio.includes("import('/static/studio-view-states.js')")
  && studio.includes('saveStudioViewOrientation(') && studio.includes('activateStudioDisplayState(')
  && studio.includes('renderViewStateManager(') && studio.includes('restoreSavedViewStateRuntime()'));
check('typed view-state manager controls are missing', registry.includes("control('viewport.orientation-manager'")
  && registry.includes("control('viewport.display-state-manager'"));
check('release asset allowlist omits view states', build.includes("'studio-view-states.js'"));

console.log(JSON.stringify({
  schema: 'partmode.view-states-smoke/v1',
  orientationCamera: activatedOrientation.orientation.camera,
  partVisibility: Object.fromEntries(part.bodies.map((body: any) => [body.id, body.visible])),
  assemblyDisplayMode: assembly.metadata.displayMode,
  saveReopen: { orientations: reopenedManager.orientations.length, displayStates: reopenedManager.displayStates.length },
  failClosed: ['dangling-reference', 'degenerate-camera'],
}, null, 2));
