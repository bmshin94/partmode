import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Drawing PDF smoke failed: ${label}`);
}

function expectCode(label: string, fn: () => unknown, code: string): void {
  try { fn(); } catch (error: any) {
    check(`${label} returned ${String(error?.code || error)}`, error?.code === code);
    return;
  }
  throw new Error(`Drawing PDF smoke failed: ${label} did not fail`);
}

function validatePdfStructure(bytes: Uint8Array): { objects: number; xrefOffset: number; mediaBox: number[] } {
  const text = Buffer.from(bytes).toString('latin1');
  check('PDF header is missing', text.startsWith('%PDF-1.7\n%'));
  check('PDF trailer is incomplete', text.endsWith('%%EOF\n'));
  const startMatch = text.match(/startxref\n(\d+)\n%%EOF\n$/u);
  check('PDF startxref is missing', startMatch);
  const xrefOffset = Number(startMatch[1]!);
  check('PDF xref offset is wrong', text.slice(xrefOffset).startsWith('xref\n0 7\n'));
  const xrefLines = text.slice(xrefOffset).split('\n');
  for (let object = 1; object <= 6; object++) {
    const offset = Number(xrefLines[2 + object]!.slice(0, 10));
    check(`PDF xref object ${object} is wrong`, text.slice(offset).startsWith(`${object} 0 obj\n`));
  }
  const mediaMatch = text.match(/\/MediaBox \[0 0 ([0-9.]+) ([0-9.]+)\]/u);
  check('PDF MediaBox is missing', mediaMatch);
  const mediaBox: [number, number, number, number] = [0, 0, Number(mediaMatch[1]!), Number(mediaMatch[2]!)];
  check('PDF is not exact A4 landscape', Math.abs(mediaBox[2] - 297 * 72 / 25.4) < 0.001
    && Math.abs(mediaBox[3] - 210 * 72 / 25.4) < 0.001 && mediaBox[2] > mediaBox[3]);
  const streamMatch = text.match(/5 0 obj\n<< \/Length (\d+) >>\nstream\n/u);
  check('PDF content stream length is missing', streamMatch);
  const streamStart = streamMatch.index! + streamMatch[0].length;
  const streamEnd = text.indexOf('endstream', streamStart);
  check('PDF content stream byte length is wrong', streamEnd - streamStart === Number(streamMatch[1]));
  return { objects: 6, xrefOffset, mediaBox };
}

const root = process.cwd();
const drawingPdf: any = await import(pathToFileURL(resolve(root, 'src/static/studio-drawing-pdf.js')).href);
const [assemblySource, curvedSource] = await Promise.all([
  readFile(resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'), 'utf8').then(JSON.parse),
  readFile(resolve(root, 'tests/feature-registry-runtime/registered-features.partmode.json'), 'utf8').then(JSON.parse),
]);
const assemblyJson = JSON.stringify(assemblySource);
let kernel: HeadlessKernel | null = null;
let assemblyDrawing: JsonRecord;
let curvedDrawing: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  assemblyDrawing = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-pdf-assembly', projectId: assemblySource.projectId,
    revision: 1, document: assemblySource, views: ['front', 'top', 'right', 'iso'],
  }) as JsonRecord;
  curvedDrawing = await kernel.request({
    kind: 'drawing-v5', requestId: 'drawing-pdf-curves', projectId: curvedSource.projectId,
    revision: 1, document: curvedSource, views: ['front', 'top'],
  }) as JsonRecord;
} finally { await kernel?.dispose(); }
check(`assembly exact drawing failed ${JSON.stringify(assemblyDrawing.errors || [])}`,
  assemblyDrawing.kind === 'drawing-result' && assemblyDrawing.errors?.length === 0 && assemblyDrawing.views?.length === 4);
check(`curved exact drawing failed ${JSON.stringify(curvedDrawing.errors || [])}`,
  curvedDrawing.kind === 'drawing-result' && curvedDrawing.errors?.length === 0 && curvedDrawing.views?.length === 2);
check('PDF gate mutated the exact source document', JSON.stringify(assemblySource) === assemblyJson);

const first = drawingPdf.createStudioDrawingPdf(assemblyDrawing, 'Two Part Assembly', { scale: 'fit' });
const second = drawingPdf.createStudioDrawingPdf(assemblyDrawing, 'Two Part Assembly', { scale: 'fit' });
check('PDF bytes are not deterministic', Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes)) === 0);
check('PDF manifest is wrong', first.mediaType === 'application/pdf'
  && first.manifest.schema === 'partmode.drawing-pdf/v1'
  && first.manifest.sheet.size === 'A4' && first.manifest.sheet.orientation === 'landscape'
  && first.manifest.scale === 2 && first.manifest.scaleLabel === '2:1'
  && JSON.stringify(first.manifest.views) === JSON.stringify(['front', 'top', 'right', 'iso'])
  && first.manifest.exactProjectionEvidence?.kind === 'occt-hlr-exact');
const structure = validatePdfStructure(first.bytes);
const pdfText = Buffer.from(first.bytes).toString('latin1');
check('PDF omits exact HLR vector paths', (pdfText.match(/ [mlc]\n/gu) || []).length < 10 ? false : true);
check('PDF omits assembly BOM identity', pdfText.includes('(PM-BASE-100)') && pdfText.includes('(PM-MOVING-200)'));
check('PDF omits controlled drawing scale', pdfText.includes('(Scale 2:1 | millimetres | third angle)'));
check('PDF producer identity is missing', pdfText.includes('/Producer (PartMode partmode.drawing-pdf/v1)'));

const curved = drawingPdf.createStudioDrawingPdf(curvedDrawing, 'Curved Features', { scale: 1 });
const curvedText = Buffer.from(curved.bytes).toString('latin1');
check('SVG elliptical arcs were not converted to PDF cubic curves', (curvedText.match(/ c\n/gu) || []).length >= 4);
validatePdfStructure(curved.bytes);
expectCode('oversized explicit drawing scale', () => drawingPdf.createStudioDrawingPdf(assemblyDrawing, 'Assembly', { scale: 10 }), 'DRAWING_SCALE_DOES_NOT_FIT');
expectCode('unsupported drawing scale', () => drawingPdf.createStudioDrawingPdf(assemblyDrawing, 'Assembly', { scale: 0.3 }), 'DRAWING_SCALE_DOES_NOT_FIT');
expectCode('missing exact drawing', () => drawingPdf.createStudioDrawingPdf({ views: [] }, 'Empty'), 'DRAWING_PDF_INVALID');
const invalidPath = structuredClone(assemblyDrawing);
invalidPath.views[0].visible[0] = 'M 0 nope';
expectCode('invalid exact HLR path', () => drawingPdf.createStudioDrawingPdf(invalidPath, 'Invalid'), 'DRAWING_PATH_INVALID');
const invalidArc = structuredClone(assemblyDrawing);
invalidArc.views[0].visible[0] = 'M 0 0 A 4 4 0 2 0 8 0';
expectCode('invalid exact HLR arc', () => drawingPdf.createStudioDrawingPdf(invalidArc, 'Invalid arc'), 'DRAWING_PATH_INVALID');
const tooManyViews = { views: Array.from({ length: 17 }, (_, index) => ({
  view: `view-${index}`, viewBox: [0, 0, 1, 1], visible: ['M 0 0 L 1 1'], hidden: [],
})) };
expectCode('too many exact views', () => drawingPdf.createStudioDrawingPdf(tooManyViews, 'Too many'), 'DRAWING_PDF_LIMIT_EXCEEDED');

const [pageSource, studioSource, registrySource, buildSource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
  readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
]);
check('visible PDF/print manager is missing', pageSource.includes('id="bw-export-pdf-open"')
  && pageSource.includes('id="bw-drawing-pdf-scale"') && pageSource.includes('id="bw-drawing-pdf-download"')
  && pageSource.includes('id="bw-drawing-pdf-print"'));
check('visible PDF output does not use exact drawing response', studioSource.includes("kernelCall('drawing-v5'")
  && studioSource.includes('drawingPdfTools.createStudioDrawingPdf(generated.response'));
check('PDF download and print paths are missing', studioSource.includes("type: generated.mediaType")
  && studioSource.includes("frame.contentWindow?.print()") && studioSource.includes("'-drawing.pdf'"));
check('typed UI registry omits PDF output', registrySource.includes("'export.drawing-pdf'")
  && registrySource.includes("'dialog.drawing-pdf.scale'")
  && registrySource.includes("'dialog.drawing-pdf.download'") && registrySource.includes("'dialog.drawing-pdf.print'"));
check('drawing PDF runtime is not release packaged', buildSource.includes("'studio-drawing-pdf.js'"));

console.log(JSON.stringify({
  schema: first.manifest.schema,
  bytes: first.bytes.length,
  deterministic: true,
  sheet: first.manifest.sheet,
  scale: first.manifest.scaleLabel,
  exactViews: first.manifest.views,
  exactEvidence: first.manifest.exactProjectionEvidence.kind,
  vectorPaths: (pdfText.match(/ [mlc]\n/gu) || []).length,
  curvedCubicSegments: (curvedText.match(/ c\n/gu) || []).length,
  bomRows: assemblyDrawing.manifest.bom.length,
  structure,
  failClosed: ['oversized-scale', 'unsupported-scale', 'missing-drawing', 'invalid-path', 'invalid-arc', 'view-limit'],
}, null, 2));

process.exit(0);
