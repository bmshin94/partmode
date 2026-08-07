import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Scene settings smoke failed: ${label}`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const tools = await moduleAt('src/static/studio-scene-settings.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const fixture = JSON.parse(await readFile(resolve(root, 'tests/fixtures/three-body.json'), 'utf8'));

const defaults = tools.defaultStudioSceneSettings();
check('scene defaults changed', JSON.stringify(defaults) === JSON.stringify({
  schema: 'partmode.scene-settings/v1', preset: 'studio', exposure: 1, realView: false, shadows: false,
}));
const authored = tools.saveStudioSceneSettings(fixture, {
  preset: 'daylight', exposure: 1.35, realView: true, shadows: true,
});
check('scene authoring mutated the source project', fixture.extensions?.partmodeSceneSettings === undefined);
const reopened = runtime.canonicalStudioV5Project(JSON.parse(JSON.stringify(authored)));
const settings = tools.studioSceneSettings(reopened);
const render = tools.studioSceneRenderState(settings);
check('scene settings did not survive canonical save and reopen', settings.preset === 'daylight'
  && settings.exposure === 1.35 && settings.realView === true && settings.shadows === true);
check('RealView render contract did not enable physical presentation', render.toneMapping === 'aces-filmic'
  && render.shadowMap === true && render.contactShadowOpacity === 0.22
  && render.preset.keyPosition.join(',') === '120,180,45');
check('non-RealView render contract did not disable shadows', tools.studioSceneRenderState(defaults).shadowMap === false);
let invalidRejected = false;
try { tools.saveStudioSceneSettings(fixture, { preset: 'unknown', exposure: 1, realView: false, shadows: false }); } catch { invalidRejected = true; }
check('unknown scene preset did not fail closed', invalidRejected);
let exposureRejected = false;
try { tools.saveStudioSceneSettings(fixture, { preset: 'studio', exposure: 8, realView: true, shadows: true }); } catch { exposureRejected = true; }
check('unsafe exposure did not fail closed', exposureRejected);

const page = await readFile(resolve(root, 'src/page.html'), 'utf8');
const studio = await readFile(resolve(root, 'src/static/studio.js'), 'utf8');
const registry = await readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8');
const build = await readFile(resolve(root, 'scripts/build.ts'), 'utf8');
check('visible scene controls are missing', ['bw-scene-preset', 'bw-scene-exposure', 'bw-scene-realview', 'bw-scene-shadows', 'bw-scene-apply']
  .every((id) => page.includes(`id="${id}"`)));
check('production renderer is not wired to scene settings', studio.includes("import('/static/studio-scene-settings.js')")
  && studio.includes('studioSceneRenderState(') && studio.includes('renderer.toneMapping')
  && studio.includes('dirLight.castShadow') && studio.includes('shadowReceiver.visible'));
check('typed scene controls are missing', registry.includes("control('viewport.scene-preset'")
  && registry.includes("control('viewport.realview'"));
check('release asset allowlist omits scene settings', build.includes("'studio-scene-settings.js'"));

console.log(JSON.stringify({
  schema: 'partmode.scene-settings-smoke/v1',
  preset: settings.preset,
  exposure: settings.exposure,
  toneMapping: render.toneMapping,
  shadows: render.shadowMap,
  keyPosition: render.preset.keyPosition,
  saveReopen: true,
  failClosed: ['unknown-preset', 'unsafe-exposure'],
}, null, 2));
