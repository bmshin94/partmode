import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonRecord = Record<string, any>;
function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Selection tools smoke failed: ${label}`);
}
const root = process.cwd();
const tools = await import(pathToFileURL(resolve(root, 'src/static/studio-selection-tools.js')).href) as JsonRecord;

check('selection filter vocabulary changed', JSON.stringify(tools.STUDIO_SELECTION_FILTERS)
  === JSON.stringify(['auto', 'component', 'body', 'face', 'edge', 'vertex']));
check('filter cycle is not deterministic', tools.nextStudioSelectionFilter('auto') === 'component'
  && tools.nextStudioSelectionFilter('edge') === 'vertex'
  && tools.nextStudioSelectionFilter('vertex') === 'auto'
  && tools.normalizeStudioSelectionFilter('mesh') === 'auto');

const candidates = [
  { key: 'body:b', depth: 3, bounds: { left: 20, top: 20, right: 70, bottom: 70 } },
  { key: 'body:a', depth: 1, bounds: { left: 10, top: 10, right: 40, bottom: 40 } },
  { key: 'body:c', depth: 2, bounds: { left: 80, top: 80, right: 120, bottom: 120 } },
];
const first = tools.studioSelectOther(candidates);
const second = tools.studioSelectOther(candidates, first.candidate.key);
const wrapped = tools.studioSelectOther(candidates, 'body:b');
check('select-other did not order unique hits by depth', first.candidate.key === 'body:a' && first.count === 3
  && second.candidate.key === 'body:c' && wrapped.candidate.key === 'body:a');
check('select-other did not deduplicate stable candidates', tools.studioSelectOther([candidates[0], candidates[0]]).count === 1);

const windowSelection = tools.studioBoxSelection([0, 0], [75, 75], candidates);
check('left-to-right window selection must require full containment', windowSelection.mode === 'window'
  && JSON.stringify(windowSelection.matches.map((entry: JsonRecord) => entry.key)) === JSON.stringify(['body:a', 'body:b']));
const crossingSelection = tools.studioBoxSelection([75, 75], [15, 15], candidates);
check('right-to-left crossing selection must include intersecting bounds', crossingSelection.mode === 'crossing'
  && JSON.stringify(crossingSelection.matches.map((entry: JsonRecord) => entry.key)) === JSON.stringify(['body:a', 'body:b']));
const edgeTouch = tools.studioBoxSelection([75, 75], [70, 70], candidates);
check('crossing selection did not include a boundary touch', edgeTouch.matches.some((entry: JsonRecord) => entry.key === 'body:b'));

let invalidRejected = false;
try { tools.studioSelectionBounds([[0, Number.NaN]]); } catch { invalidRejected = true; }
check('invalid screen geometry did not fail closed', invalidRejected);

const page = await readFile(resolve(root, 'src/page.html'), 'utf8');
const studio = await readFile(resolve(root, 'src/static/studio.js'), 'utf8');
const registry = await readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8');
const build = await readFile(resolve(root, 'scripts/build.ts'), 'utf8');
check('visible selection controls are missing', ['bw-selection-filter', 'bw-select-other', 'bw-box-select', 'bw-selection-marquee']
  .every((id) => page.includes(`id="${id}"`)));
check('visible selection filter choices are incomplete', tools.STUDIO_SELECTION_FILTERS
  .filter((filter: string) => filter !== 'auto')
  .every((filter: string) => page.includes(`<option value="${filter}">`)));
check('runtime is not wired to source-owned selection tools', studio.includes("import('/static/studio-selection-tools.js')")
  && studio.includes('studioSelectOther(') && studio.includes('studioBoxSelection('));
check('runtime does not route every displayed geometry class', [
  "selectionFilter === 'component'",
  "selectionFilter === 'face'",
  "selectionFilter === 'edge'",
  "selectionFilter === 'vertex'",
].every((branch) => studio.includes(branch)));
check('selection keyboard access is missing', studio.includes("shortcutAction === 'selection-filter'")
  && studio.includes("shortcutAction === 'box-select'")
  && page.includes('data-shortcut-display="selection-filter"')
  && page.includes('data-shortcut-display="box-select"'));
check('selection controls are absent from the typed UI registry', registry.includes("control('viewport.selection-filter'")
  && registry.includes("control('viewport.select-other'") && registry.includes("control('viewport.box-select'"));
check('release asset allowlist omits the selection runtime', build.includes("'studio-selection-tools.js'"));

console.log(JSON.stringify({
  schema: 'partmode.selection-tools-smoke/v1',
  filters: tools.STUDIO_SELECTION_FILTERS,
  selectOther: { count: first.count, order: [first.candidate.key, second.candidate.key, 'body:b'] },
  boxSelection: { window: windowSelection.matches.length, crossing: crossingSelection.matches.length },
  visibleControls: 4,
}, null, 2));
