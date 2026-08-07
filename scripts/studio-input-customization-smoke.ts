import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonRecord = Record<string, any>;
function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Input customization smoke failed: ${label}`);
}

const root = process.cwd();
const tools = await import(pathToFileURL(resolve(root, 'src/static/studio-input-customization.js')).href) as JsonRecord;
const defaults = tools.defaultStudioShortcutBindings();
check('default shortcut map changed', JSON.stringify(defaults) === JSON.stringify({
  'fit-view': 'f', 'selection-filter': 'f6', 'box-select': 'b', isolate: 'i', hide: 'h',
  'show-all': 'shift+h', edit: 'e', suppress: 'shift+e', measure: 'shift+m', section: 'shift+s',
}));
check('shortcut event resolution failed', tools.studioShortcutActionForEvent({ key: 'H', shiftKey: true }, defaults) === 'show-all'
  && tools.studioShortcutActionForEvent({ key: 'F6' }, defaults) === 'selection-filter'
  && tools.studioShortcutActionForEvent({ key: 'e', ctrlKey: true }, defaults) === null);
const customized = tools.updateStudioShortcutBinding(defaults, 'fit-view', 'g');
check('shortcut customization was not immutable or deterministic', defaults['fit-view'] === 'f' && customized['fit-view'] === 'g');
const swapped = tools.updateStudioShortcutBinding(defaults, 'fit-view', 'h');
check('occupied shortcut did not swap atomically', swapped['fit-view'] === 'h' && swapped.hide === 'f');
let invalidBindingRejected = false;
try { tools.updateStudioShortcutBinding(defaults, 'fit-view', 'not-a-key'); } catch { invalidBindingRejected = true; }
check('invalid shortcut did not fail closed', invalidBindingRejected);
check('invalid stored shortcut map did not recover defaults', tools.normalizeStudioShortcutBindings({ hide: 'not-a-key' }).hide === 'h');

const gestures = [
  tools.studioMouseGesture([100, 100], [100, 60]),
  tools.studioMouseGesture([100, 100], [145, 105]),
  tools.studioMouseGesture([100, 100], [98, 142]),
  tools.studioMouseGesture([100, 100], [55, 95]),
];
check('four-way gesture mapping changed', JSON.stringify(gestures.map((entry: JsonRecord) => [entry.direction, entry.action]))
  === JSON.stringify([['north', 'isolate'], ['east', 'edit'], ['south', 'suppress'], ['west', 'hide']]));
check('gesture deadzone failed', tools.studioMouseGesture([0, 0], [10, 10]) === null);
let invalidGestureRejected = false;
try { tools.studioMouseGesture([0, Number.NaN], [10, 10]); } catch { invalidGestureRejected = true; }
check('invalid gesture did not fail closed', invalidGestureRejected);

check('selection-aware context actions changed', JSON.stringify(tools.studioContextActions({ body: true }))
  === JSON.stringify(['suppress', 'hide', 'isolate', 'show-all', 'fit-view'])
  && JSON.stringify(tools.studioContextActions({ feature: true }))
  === JSON.stringify(['edit', 'suppress', 'show-all', 'fit-view']));

const page = await readFile(resolve(root, 'src/page.html'), 'utf8');
const studio = await readFile(resolve(root, 'src/static/studio.js'), 'utf8');
const css = await readFile(resolve(root, 'src/static/studio.css'), 'utf8');
const registry = await readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8');
const build = await readFile(resolve(root, 'scripts/build.ts'), 'utf8');
check('visible context, gesture, or shortcut surfaces are missing', ['bw-context-toolbar', 'bw-mouse-gesture', 'bw-shortcut-editor', 'bw-shortcut-reset']
  .every((id) => page.includes(`id="${id}"`)));
check('visible context actions or gesture directions are incomplete', ['edit', 'suppress', 'hide', 'isolate', 'show-all', 'fit-view']
  .every((action) => page.includes(`data-context-action="${action}"`))
  && ['north', 'east', 'south', 'west'].every((direction) => page.includes(`data-gesture-direction="${direction}"`)));
check('production runtime is not wired to input customization', studio.includes("import('/static/studio-input-customization.js')")
  && studio.includes('studioMouseGesture(') && studio.includes('studioShortcutActionForEvent(')
  && studio.includes('studioContextActions('));
check('custom shortcuts are not stored locally or restored fail closed', studio.includes("const SHORTCUT_STORAGE_KEY = 'partmode.studio.shortcuts/v1'")
  && studio.includes('localStorage.setItem(SHORTCUT_STORAGE_KEY')
  && studio.includes('normalizeStudioShortcutBindings(stored)'));
check('visible interaction styling is missing', ['.ws-context-toolbar', '.ws-mouse-gesture', '.cs-shortcut-editor']
  .every((selector) => css.includes(selector)));
check('typed registry controls are missing', registry.includes("control('viewport.context-toolbar'")
  && registry.includes("control('viewport.mouse-gestures'") && registry.includes("control('help.shortcut-editor'"));
check('release asset allowlist omits input customization', build.includes("'studio-input-customization.js'"));

console.log(JSON.stringify({
  schema: 'partmode.input-customization-smoke/v1',
  shortcuts: Object.keys(defaults).length,
  gestures: gestures.map((entry: JsonRecord) => entry.direction),
  bodyContextActions: tools.studioContextActions({ body: true }),
  visibleSurfaces: 4,
}, null, 2));
