import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Studio feature diagnostics smoke failed: ${label}`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const diagnostics = await moduleAt('src/static/studio-feature-diagnostics.js');
const uiRegistry = await moduleAt('src/static/studio-v6-ui-registry.js');
const source = JSON.parse(await readFile(resolve(root, 'tests/fixtures/three-body.json'), 'utf8')) as JsonRecord;
const invalid = JSON.parse(await readFile(resolve(root, 'tests/cad-corpus/fillet-shell.partmode.json'), 'utf8')) as JsonRecord;
invalid.projectId = 'project-feature-diagnosis';
invalid.parameters.find((parameter: JsonRecord) => parameter.name === 'fillet_r').value = 100;

let kernel: HeadlessKernel | null = null;
let workerError: JsonRecord | null = null;
let failedBody: JsonRecord | null = null;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  const result = await kernel.request({
    kind: 'rebuild', requestId: 'feature-diagnosis-invalid-fillet', projectId: invalid.projectId,
    revision: 1, document: invalid,
  }) as JsonRecord;
  check('invalid exact rebuild did not return a rebuild result', result.kind === 'rebuild-result');
  check(`invalid exact rebuild did not report an error: ${JSON.stringify(result.errors || [])}`, result.errors?.length >= 1);
  workerError = result.errors.find((error: JsonRecord) => error.featureId === 'feature-edge-fillet') || null;
  check('exact error did not identify the authored feature', workerError?.featureId === 'feature-edge-fillet');
  check('exact error has no stable code', typeof workerError.code === 'string' && workerError.code.length > 0);
  failedBody = result.bodies.find((body: JsonRecord) => body.bodyId === 'body-fillet-box') || null;
  check('failed body incorrectly published geometry', failedBody?.error && failedBody.geometry == null && failedBody.mesh == null);
} finally {
  await kernel?.dispose();
}

check('exact worker error was not captured', workerError);
const exactReport = diagnostics.diagnoseStudioProject(invalid, { errors: [workerError], warnings: [] });
check('diagnosis schema changed', exactReport.schema === 'partmode.feature-diagnosis/v1');
check('exact failed report is not failed', exactReport.status === 'failed' && exactReport.summary.errors === 1);
const exactDiagnosis = exactReport.diagnoses[0];
check('exact diagnosis lost feature identity', exactDiagnosis.entity.kind === 'feature'
  && exactDiagnosis.entity.id === 'feature-edge-fillet' && exactDiagnosis.entity.label === 'Topology edge fillet');
check('exact Fillet failure was not classified from exact worker evidence', exactDiagnosis.category === 'edge-modifier');
check('authoritative worker message was not preserved', exactDiagnosis.explanation === workerError.message);
check('authored radius expression is absent', exactDiagnosis.inputs.some((input: JsonRecord) => input.label === 'Radius' && input.value === 'fillet_r'));
check('resolved radius parameter is absent', exactDiagnosis.inputs.some((input: JsonRecord) => input.label === 'Parameter fillet_r' && input.value === 100));
check('selected exact edge count is absent', exactDiagnosis.inputs.some((input: JsonRecord) => input.label === 'Selected edges' && input.value === 1));
check('repair guidance is missing', exactDiagnosis.suggestions.length === 3 && exactDiagnosis.actions.some((action: JsonRecord) => action.kind === 'edit'));
check('diagnosis mutated the document', invalid.parameters.find((parameter: JsonRecord) => parameter.name === 'fillet_r').value === 100);

const lostReferenceReport = diagnostics.diagnoseStudioProject(source, { errors: [{
  featureId: 'feature-housing-tool-subtract', bodyId: 'body-feature-housing', featureType: 'boolean',
  code: 'TOPOLOGY_REFERENCE_MISSING', stage: 'rebuild',
  message: 'The persistent name face:tool no longer exists.',
  diagnostics: [{ severity: 'error', code: 'PERSISTENT_NAME_MISSING', message: 'face:tool was not resolved.' }],
}] });
const lostReference = lostReferenceReport.diagnoses[0];
check('lost exact topology reference was not classified', lostReference.category === 'lost-reference');
check('Boolean target input is absent', lostReference.inputs.some((input: JsonRecord) => input.entity?.id === 'body-feature-housing'));
check('Boolean tool input is absent', lostReference.inputs.some((input: JsonRecord) => input.entity?.id === 'body-feature-tool'));
check('nested exact topology detail is absent', lostReference.details.length === 1
  && lostReference.details[0].code === 'PERSISTENT_NAME_MISSING');
check('non-editable Boolean advertises a dead repair action', !lostReference.actions.some((action: JsonRecord) => action.kind === 'edit'));

const assembly = JSON.parse(await readFile(resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'), 'utf8')) as JsonRecord;
const mateReport = diagnostics.diagnoseStudioProject(assembly, { errors: [{
  mateId: 'mate-corner-x', featureType: 'mate', code: 'ASSEMBLY_CONVERGENCE_FAILED',
  message: 'The simultaneous mate solver reached its iteration limit.',
  conflictSet: ['mate-corner-x', 'mate-corner-y'],
}] });
const mateDiagnosis = mateReport.diagnoses[0];
check('assembly convergence was not classified', mateDiagnosis.category === 'assembly-convergence');
check('mate identity was not resolved', mateDiagnosis.entity.kind === 'mate' && mateDiagnosis.entity.id === 'mate-corner-x');
check('mate conflict set is absent', mateDiagnosis.inputs.filter((input: JsonRecord) => input.label === 'Conflict mate').length === 2);

const warningReport = diagnostics.diagnoseStudioProject(source, { warnings: [{
  severity: 'warning', featureId: 'feature-housing-tool-subtract', featureType: 'boolean', code: 'CUT_NO_EFFECT',
  message: 'the cut does not touch the part; nothing was removed',
}] });
check('no-effect report status is not warning', warningReport.status === 'warning' && warningReport.summary.warnings === 1);
check('no-effect warning was misclassified', warningReport.diagnoses[0].category === 'no-effect');
const healthy = diagnostics.diagnoseStudioProject(source, {});
check('healthy report is not explicit', healthy.status === 'healthy' && healthy.summary.total === 0);
const checking = diagnostics.diagnoseStudioProject(source, { pending: true });
check('pending exact rebuild looks healthy', checking.status === 'checking' && checking.summary.total === 0);

const [page, studio, worker, registry, css, build] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.css'), 'utf8'),
  readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
]);
check('visible Design Check control is missing', page.includes('id="bw-design-check"')
  && page.includes('id="bw-v6-diagnostics-title">Design check'));
check('production runtime does not retain exact worker records', studio.includes('lastKernelErrors = deepCopy(response.errors || [])')
  && studio.includes('lastKernelWarnings = deepCopy(response.warnings || [])'));
check('production feature and pattern failures do not share stable fallback codes', worker.includes('function featureFailureCode(')
  && worker.includes('code: featureFailureCode(currentFeature')
  && worker.match(/code: featureFailureCode\(\{ type: 'pattern' \}/g)?.length === 3);
check('production diagnosis cards omit authored inputs or repair path', studio.includes("inputHeading.textContent = 'Authored inputs'")
  && studio.includes("repairHeading.textContent = 'Repair path'"));
check('failed feature rows have no direct explanation action', studio.includes('data-diagnose-feature=')
  && studio.includes('Explain this exact rebuild failure'));
check('typed agent snapshot omits diagnoses', studio.includes('diagnostics: deepCopy(diagnosis)'));
check('Design Check typed control is missing', registry.includes("control('diagnostics.design-check'"));
const designCheckControl = uiRegistry.cadUiControlRegistry().find((control: JsonRecord) => control.id === 'diagnostics.design-check');
check('Design Check typed control is not available through cad_ui', designCheckControl?.adapter === 'available'
  && designCheckControl.semanticAction === 'diagnostics.show' && designCheckControl.adapterTool === 'cad_ui'
  && designCheckControl.humanBindings.some((binding: JsonRecord) => binding.elementId === 'bw-design-check'));
check('diagnosis card styling is missing', css.includes('.v6-diagnostic.is-error')
  && css.includes('.v6-diagnostic-actions'));
check('release asset allowlist omits feature diagnostics', build.includes("'studio-feature-diagnostics.js'"));

console.log(JSON.stringify({
  schema: 'partmode.feature-diagnostics-smoke/v1',
  exactFailure: {
    featureId: workerError.featureId,
    code: workerError.code,
    category: exactDiagnosis.category,
    geometryPublished: Boolean(failedBody?.geometry || failedBody?.mesh),
    authoredRadius: exactDiagnosis.inputs.find((input: JsonRecord) => input.label === 'Radius')?.value,
    resolvedRadius: exactDiagnosis.inputs.find((input: JsonRecord) => input.label === 'Parameter fillet_r')?.value,
  },
  classified: ['edge-modifier', 'lost-reference', 'assembly-convergence', 'no-effect'],
  healthy: healthy.status,
  repairActions: exactDiagnosis.actions.map((action: JsonRecord) => action.kind),
}, null, 2));

// The headless worker owns a module-hooks thread that can retain the event
// loop after disposal. Exact evidence is printed, so end deterministically.
process.exit(0);
