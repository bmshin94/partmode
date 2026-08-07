import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Assembly drawing runtime smoke failed: ${label}`);
}

const root = process.cwd();
const source = JSON.parse(await readFile(resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'), 'utf8')) as JsonRecord;
const studioSource = await readFile(resolve(root, 'src/static/studio.js'), 'utf8');
const drawingSvgSource = await readFile(resolve(root, 'src/static/studio-drawing-svg.js'), 'utf8');
const reopened = JSON.parse(JSON.stringify(source));
check('canonical save/reopen source changed', JSON.stringify(reopened) === JSON.stringify(source));

let kernel: HeadlessKernel | null = null;
let drawing: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  drawing = await kernel.request({
    kind: 'drawing-v5', requestId: 'assembly-drawing-runtime', projectId: source.projectId,
    revision: 1, document: reopened, views: ['front', 'top', 'right', 'iso'],
  }) as JsonRecord;
} finally {
  await kernel?.dispose();
}

check(`exact drawing failed ${JSON.stringify(drawing.errors || [])}`,
  drawing.kind === 'drawing-result' && drawing.errors?.length === 0 && drawing.views?.length === 4);
check('drawing is not identified as an assembly', drawing.manifest?.documentKind === 'assembly');
check('drawing accepted non-exact projection evidence', drawing.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact');
check('drawing projection evidence is stale', drawing.manifest.exactProjectionEvidence.revisionKey === drawing.manifest.drawingPlan.revisionKey);
check('drawing plan did not use the shared placement ledger schema', drawing.manifest.drawingPlan.schema === 'partmode.assembly-drawing-plan/v2');
check('drawing projection evidence is not bound to the shared placement ledger',
  drawing.manifest.exactProjectionEvidence.placementLedgerFingerprint === drawing.manifest.drawingPlan.placementLedgerFingerprint);
check('drawing plan retained duplicated per-view placement matrices', drawing.manifest.drawingPlan.projectionRequests.every((request: JsonRecord) =>
  !Object.hasOwn(request.exactAssemblyPass, 'instances') && !Object.hasOwn(request.exactOccurrencePass, 'instances')));
check('one or more exact views contain no visible HLR path', drawing.views.every((view: JsonRecord) =>
  view.visible.length > 0 && view.viewBox.length === 4 && view.viewBox.every(Number.isFinite)));
check('standard and isometric view set changed',
  JSON.stringify(drawing.views.map((view: JsonRecord) => view.view)) === JSON.stringify(['front', 'top', 'right', 'iso']));

const bom = drawing.manifest.bom;
check('BOM did not group exact solved occurrences', Array.isArray(bom) && bom.length === 2
  && bom.every((entry: JsonRecord) => entry.quantity === 1 && entry.instanceIds.length === 1));
check('BOM identity is not deterministic', JSON.stringify(bom.map((entry: JsonRecord) => [entry.itemNumber, entry.partNumber, entry.revision]))
  === JSON.stringify([[1, 'PM-BASE-100', 'A'], [2, 'PM-MOVING-200', 'B']]));
const balloons = drawing.manifest.annotations?.balloons;
check(`automatic balloons do not cover every visible BOM item ${JSON.stringify(balloons)}`, Array.isArray(balloons) && balloons.length === 2
  && JSON.stringify(balloons.map((entry: JsonRecord) => entry.itemNumber).sort()) === JSON.stringify([1, 2]));
check('balloons are not backed by exact B-rep camera support and assembly HLR evidence', balloons.every((entry: JsonRecord) =>
  entry.evidence?.kind === 'occt-brep-camera-support'
  && entry.evidence.assemblyProjectionKind === 'occt-hlr-exact'
  && entry.evidence.revisionKey === drawing.manifest.drawingPlan.revisionKey
  && typeof entry.evidence.supportFingerprint === 'string' && entry.evidence.supportFingerprint.length === 32));
const hlrPerformance = drawing.manifest.hlrPerformance;
check('assembly drawing omitted exact HLR performance evidence',
  hlrPerformance?.schema === 'partmode.drawing-hlr-performance/v1'
  && hlrPerformance.revisionKey === drawing.manifest.drawingPlan.revisionKey
  && hlrPerformance.placementLedgerFingerprint === drawing.manifest.drawingPlan.placementLedgerFingerprint);
check('assembly drawing compound does not prove every exact body instance',
  hlrPerformance.visibleComponentCount === 2
  && hlrPerformance.exactBodyInstanceCount === 2
  && hlrPerformance.uniquePartVariantCount === 2
  && hlrPerformance.uniqueExactBodySourceCount === 2
  && hlrPerformance.placedCompoundEvidence?.brepValid === true
  && hlrPerformance.placedCompoundEvidence.solidCount === 2);
check('assembly drawing did not execute exactly one assembly HLR per view',
  hlrPerformance.requestedViewCount === 4
  && hlrPerformance.assemblyHlrPasses === 4
  && hlrPerformance.exactHlrPasses === 4);
check('assembly drawing retained per-occurrence HLR work',
  hlrPerformance.occurrenceHlrPasses === 0
  && hlrPerformance.naivePerViewOccurrenceHlrPasses === 8
  && hlrPerformance.avoidedOccurrenceHlrPasses === 8);
check('assembly drawing did not bound exact support work to BOM representatives',
  hlrPerformance.annotationRepresentativeCount === 2
  && hlrPerformance.occurrenceSupportEvaluations === 2
  && hlrPerformance.occurrenceBoundsEvidence?.filter((entry: JsonRecord) => entry.kind === 'occt-brep-camera-support').length === 1
  && hlrPerformance.occurrenceBoundsEvidence?.find((entry: JsonRecord) => entry.kind === 'occt-brep-camera-support')?.representatives?.length === 2);
check('one or more assembly views lack exact HLR path receipts', hlrPerformance.viewPathEvidence?.length === 4
  && hlrPerformance.viewPathEvidence.every((entry: JsonRecord) => entry.pathCount > 0 && typeof entry.pathHash === 'string'));
check('shipped sheet does not render BOM and balloon annotations',
  studioSource.includes('drawingSvgTools.createStudioDrawingSvg(generated.response, generated.partName)')
  && drawingSvgSource.includes('class="assembly-bom"') && drawingSvgSource.includes('class="assembly-balloon"')
  && drawingSvgSource.includes('data-bom-item'));

console.log(JSON.stringify({
  schema: drawing.manifest.drawingPlan.schema,
  evidence: drawing.manifest.exactProjectionEvidence.kind,
  exactHlrPasses: hlrPerformance.exactHlrPasses,
  occurrenceHlrPasses: hlrPerformance.occurrenceHlrPasses,
  representativeSupportEvaluations: hlrPerformance.occurrenceSupportEvaluations,
  views: drawing.views.map((view: JsonRecord) => ({ view: view.view, visible: view.visible.length, hidden: view.hidden.length })),
  bom: bom.map((entry: JsonRecord) => ({ item: entry.itemNumber, partNumber: entry.partNumber, revision: entry.revision, quantity: entry.quantity })),
  balloons: balloons.map((entry: JsonRecord) => ({ item: entry.itemNumber, view: entry.view, instanceId: entry.instanceId })),
  saveReopen: 'preserved',
}, null, 2));

process.exit(0);
