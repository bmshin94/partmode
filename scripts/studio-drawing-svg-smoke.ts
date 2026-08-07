import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Drawing SVG smoke failed: ${label}`);
}

function expectCode(label: string, fn: () => unknown, code: string): void {
  try { fn(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Drawing SVG smoke failed: ${label} did not fail`);
}

const root = process.cwd();
const svgTools = await import(pathToFileURL(resolve(root, 'src/static/studio-drawing-svg.js')).href);
const source = JSON.parse(await readFile(resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'), 'utf8')) as JsonRecord;
let kernel: HeadlessKernel | null = null;
let drawing: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  drawing = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-svg-exact', projectId: source.projectId,
    revision: 1, document: source, views: ['front', 'top', 'right', 'iso'],
  }) as JsonRecord;
} finally { await kernel?.dispose(); }
check(`exact drawing failed ${JSON.stringify(drawing.errors || [])}`,
  drawing.kind === 'drawing-result' && drawing.errors?.length === 0
  && drawing.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');

const first = svgTools.createStudioDrawingSvg(drawing, 'Assembly <release>', { date: '2026-08-02' });
const second = svgTools.createStudioDrawingSvg(drawing, 'Assembly <release>', { date: '2026-08-02' });
check('A4 SVG is not deterministic', first === second);
check('A4 SVG root contract is wrong', first.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="297mm" height="210mm" viewBox="0 0 297 210"')
  && first.includes('data-drawing-schema="partmode.drawing-svg/v1"')
  && first.includes('data-projection="third-angle"') && first.includes('data-scale="2:1"'));
const exactViews = [...first.matchAll(/data-exact-view="([^"]+)"/gu)].map((match) => match[1]);
check('A4 SVG exact view set is wrong', JSON.stringify(exactViews) === JSON.stringify(['front', 'top', 'right', 'iso']));
const automaticDimensions = [...first.matchAll(/data-auto-dimension="([^"]+)"/gu)].map((match) => match[1]);
check('A4 SVG automatic dimensions are wrong', JSON.stringify(automaticDimensions) === JSON.stringify(['front-width', 'front-height', 'top-depth']));
check('A4 SVG lost hidden-line styling', first.includes('stroke-dasharray=') && first.includes('stroke-opacity="0.55"'));
check('A4 SVG lost BOM or exact balloons', first.includes('class="assembly-bom" data-bom-rows="2"')
  && (first.match(/class="assembly-balloon"/gu) || []).length === 2);
check('A4 SVG failed to escape its title', first.includes('Assembly &lt;release&gt;') && !first.includes('Assembly <release>'));
check('A4 SVG date or title block is wrong', first.includes('PartMode | 2026-08-02') && first.includes('Scale 2:1 | millimetres | third angle'));

expectCode('missing exact evidence', () => svgTools.createStudioDrawingSvg({ ...drawing, manifest: { ...drawing.manifest, exactProjectionEvidence: null } }, 'Part'), 'DRAWING_SVG_EXACT_REQUIRED');
expectCode('missing standard view', () => svgTools.createStudioDrawingSvg({ ...drawing, views: drawing.views.slice(0, 3) }, 'Part'), 'DRAWING_SVG_VIEW_SET_INVALID');
expectCode('duplicate standard view', () => svgTools.createStudioDrawingSvg({ ...drawing, views: [...drawing.views.slice(0, 3), drawing.views[0]] }, 'Part'), 'DRAWING_SVG_VIEW_SET_INVALID');
expectCode('invalid exact bounds', () => svgTools.createStudioDrawingSvg({ ...drawing, views: drawing.views.map((entry: JsonRecord, index: number) => index ? entry : { ...entry, viewBox: [0, 0, Number.NaN, 10] }) }, 'Part'), 'DRAWING_SVG_VIEW_SET_INVALID');
expectCode('empty exact visible paths', () => svgTools.createStudioDrawingSvg({ ...drawing, views: drawing.views.map((entry: JsonRecord, index: number) => index ? entry : { ...entry, visible: [] }) }, 'Part'), 'DRAWING_SVG_VIEW_SET_INVALID');
expectCode('balloon limit', () => svgTools.createStudioDrawingSvg({ ...drawing, manifest: { ...drawing.manifest, annotations: { balloons: Array.from({ length: 101 }, () => ({})) } } }, 'Part'), 'DRAWING_SVG_LIMIT_EXCEEDED');
expectCode('BOM limit', () => svgTools.createStudioDrawingSvg({ ...drawing, manifest: { ...drawing.manifest, bom: Array.from({ length: 101 }, () => ({})) } }, 'Part'), 'DRAWING_SVG_LIMIT_EXCEEDED');

const [studioSource, buildSource] = await Promise.all([
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
]);
check('production drawing export does not use the source-owned SVG writer',
  studioSource.includes('drawingSvgTools.createStudioDrawingSvg(generated.response, generated.partName)'));
check('drawing SVG writer is absent from the release assets', buildSource.includes("'studio-drawing-svg.js'"));

console.log(JSON.stringify({
  schema: 'partmode.drawing-svg/v1', bytes: new TextEncoder().encode(first).length,
  deterministic: true, sheet: [297, 210], projection: 'third-angle', scale: '2:1',
  exactEvidence: drawing.manifest.exactProjectionEvidence.kind, exactViews,
  automaticDimensions, bomRows: 2, balloons: 2,
  failClosed: ['missing-exact-evidence', 'missing-view', 'duplicate-view', 'invalid-bounds', 'empty-visible-paths', 'balloon-limit', 'bom-limit'],
}, null, 2));
