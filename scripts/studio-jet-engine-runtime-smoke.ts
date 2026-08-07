import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';
import { createHeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..', '..');
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-jet-engine-runtime-'));
const cliValue = (flag: string): string | null => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return typeof value === 'string' ? value : null;
};
const externalUrl = cliValue('--url');
const expectedReleaseSha = cliValue('--expected-sha');

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function clickVisible(page: Page, selector: string): Promise<void> {
  const control = await page.$(selector);
  invariant(control, `visible control is missing: ${selector}`);
  try {
    const state = await control.evaluate((element) => ({
      connected: element.isConnected,
      disabled: element instanceof HTMLButtonElement && element.disabled,
      hidden: element instanceof HTMLElement && (element.hidden || getComputedStyle(element).display === 'none'),
    }));
    invariant(state.connected && !state.disabled && !state.hidden, `visible control is unavailable: ${selector}`);
    await control.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
    await control.click();
  } finally {
    await control.dispose();
  }
}

const jetModule = await import(pathToFileURL(resolve(root, 'src/static/studio-jet-engine.js')).href) as JsonRecord;
const projectModule = await import(pathToFileURL(resolve(root, 'src/static/studio-project-v5.js')).href) as JsonRecord;
const inspectionModule = await import(pathToFileURL(resolve(root, 'src/static/studio-v5-inspection.js')).href) as JsonRecord;

// ---------------------------------------------------------------------------
// Document contract: mate-solved modules, airfoil blade rows, saved exploded
// layout, saved section view, and a shipped drawing sheet.
// ---------------------------------------------------------------------------

const EXPECTED_BODY_COUNT = 394;
const EXPECTED_EXPLICIT_OCCURRENCES = 57;
const EXPECTED_GENERATED_MEMBERS = 343;
const EXPECTED_MATE_COUNT = 157;
const EXPECTED_PART_COUNT = 40;
const EXPECTED_PATTERN_COUNT = 19;

const source = jetModule.createJetEngineAssemblyProject() as JsonRecord;
const prepared = projectModule.prepareStudioV5Project(source) as JsonRecord;
const saved = JSON.stringify(prepared);
const reopened = projectModule.parseStudioV5Project(saved) as JsonRecord;
invariant(JSON.stringify(reopened) === saved, 'jet-engine save/reopen changed canonical project bytes');
invariant(prepared.rootDocument?.kind === 'assembly', 'jet-engine template root is not an assembly');
const rootAssembly = prepared.assemblyDefinitions.find(
  (assembly: JsonRecord) => assembly.id === prepared.rootDocument.assemblyId,
) as JsonRecord | undefined;
invariant(rootAssembly, 'jet-engine root assembly is missing');
const expectedNames = [
  '01 · Fan and LP Spool',
  '02 · Axial Compressor',
  '03 · Annular Combustor',
  '04 · Turbine',
  '05 · Exhaust',
  '06 · Fan Case and OGVs',
];
invariant(JSON.stringify(rootAssembly.occurrences.map((entry: JsonRecord) => entry.name)) === JSON.stringify(expectedNames),
  'jet-engine numbered module order is not canonical');
invariant(rootAssembly.occurrences.every((entry: JsonRecord, index: number) =>
  entry.fixed === false
    && entry.extensions?.initiallyExpanded === false
    && entry.extensions?.itemNumber === String(index + 1).padStart(2, '0')),
'jet-engine root modules must be mate-placed with enumeration metadata, not fixed');
invariant(prepared.metadata.expectedExactBodyCount === EXPECTED_BODY_COUNT, 'jet-engine exact-body contract changed');
invariant(prepared.metadata.expectedExplicitOccurrenceCount === EXPECTED_EXPLICIT_OCCURRENCES,
  'jet-engine explicit-occurrence contract changed');
invariant(prepared.metadata.expectedGeneratedBodyPatternMembers === EXPECTED_GENERATED_MEMBERS,
  'jet-engine generated-pattern contract changed');
invariant(prepared.partDefinitions.length === EXPECTED_PART_COUNT, 'jet-engine part-definition contract changed');

// Authored mates place every component; no occurrence anywhere relies on
// unconstrained fixed placement.
const allAssemblies = prepared.assemblyDefinitions as JsonRecord[];
invariant(allAssemblies.every((assembly) => assembly.occurrences.every((entry: JsonRecord) => entry.fixed === false)),
  'jet-engine still contains occurrence-level fixed placement');
const allMates = allAssemblies.flatMap((assembly) => assembly.mates || []);
invariant(allMates.length === EXPECTED_MATE_COUNT && prepared.metadata.authoredMateCount === EXPECTED_MATE_COUNT,
  `jet-engine authored mate contract changed: ${allMates.length}`);
for (const assembly of allAssemblies) {
  const groundMates = (assembly.mates || []).filter((mate: JsonRecord) => mate.kind === 'fixed');
  invariant(groundMates.length === 1 && groundMates[0].occurrenceIds.length === 1,
    `jet-engine assembly ${assembly.id} must ground exactly one anchor component with an authored Fixed mate`);
}
const mateKinds = new Set(allMates.map((mate: JsonRecord) => mate.kind));
for (const kind of ['fixed', 'concentric', 'distance', 'angle', 'coincident']) {
  invariant(mateKinds.has(kind), `jet-engine authored mates omit the ${kind} family`);
}
invariant(allMates.every((mate: JsonRecord) => mate.kind === 'fixed'
  || (mate.references || []).every((reference: JsonRecord) => reference.ownerKind === 'datum'
    && Array.isArray(reference.occurrencePath) && reference.occurrencePath.length > 0)),
'jet-engine mates must reference authored part datums through occurrence paths');

// Blade rows: distinct stage counts driven by the recorded blade-row plan.
const bladeRowPlan = prepared.metadata.bladeRowPlan as JsonRecord;
invariant(bladeRowPlan && Array.isArray(bladeRowPlan.compressorRotors) && Array.isArray(bladeRowPlan.turbineRotors),
  'jet-engine blade-row plan metadata is missing');
const occurrencePatterns = allAssemblies.flatMap((assembly: JsonRecord) => assembly.occurrencePatterns || []);
invariant(occurrencePatterns.length === EXPECTED_PATTERN_COUNT,
  `jet-engine occurrence-pattern count is ${occurrencePatterns.length}`);
invariant(occurrencePatterns.every((pattern: JsonRecord) =>
  pattern.kind === 'circular'
    && pattern.sourceOccurrenceIds?.length === 1
    && Number.isInteger(pattern.generatedCount)
    && pattern.generatedCount > 0
    && JSON.stringify(pattern.definition?.axis) === JSON.stringify([1, 0, 0])),
'jet-engine occurrence-pattern metadata is not canonical');
invariant(occurrencePatterns.reduce((total: number, pattern: JsonRecord) => total + pattern.generatedCount, 0)
  === EXPECTED_GENERATED_MEMBERS,
`jet-engine occurrence-pattern members do not total ${EXPECTED_GENERATED_MEMBERS}`);
const patternTotal = (occurrenceId: string): number => {
  const pattern = occurrencePatterns.find((entry: JsonRecord) => entry.sourceOccurrenceIds[0] === occurrenceId);
  return pattern ? pattern.generatedCount + 1 : 0;
};
invariant(patternTotal('occ-jet-01-fan-blades') === bladeRowPlan.fanBlades,
  'jet-engine fan blade count does not match the blade-row plan');
invariant(patternTotal('occ-jet-06-ogvs') === bladeRowPlan.outletGuideVanes,
  'jet-engine OGV count does not match the blade-row plan');
invariant(patternTotal('occ-jet-03-injectors') === bladeRowPlan.fuelInjectors,
  'jet-engine injector count does not match the blade-row plan');
invariant(patternTotal('occ-jet-05-struts') === bladeRowPlan.exhaustStruts,
  'jet-engine exhaust strut count does not match the blade-row plan');
bladeRowPlan.compressorRotors.forEach((count: number, index: number) => {
  invariant(patternTotal(`occ-jet-02-rotor-blades-${index + 1}`) === count,
    `jet-engine compressor rotor stage ${index + 1} blade count is not ${count}`);
});
bladeRowPlan.compressorStators.forEach((count: number, index: number) => {
  invariant(patternTotal(`occ-jet-02-stator-vanes-${index + 1}`) === count,
    `jet-engine compressor stator stage ${index + 1} vane count is not ${count}`);
});
bladeRowPlan.turbineRotors.forEach((count: number, index: number) => {
  invariant(patternTotal(`occ-jet-04-turbine-blades-${index + 1}`) === count,
    `jet-engine turbine rotor stage ${index + 1} blade count is not ${count}`);
});
bladeRowPlan.turbineNozzleVanes.forEach((count: number, index: number) => {
  invariant(patternTotal(`occ-jet-04-nozzle-vanes-${index + 1}`) === count,
    `jet-engine turbine nozzle row ${index + 1} vane count is not ${count}`);
});
const stageCounts = (values: number[]): boolean => new Set(values).size === values.length;
invariant(stageCounts(bladeRowPlan.compressorRotors) && stageCounts(bladeRowPlan.turbineRotors),
  'jet-engine stages must carry distinct blade counts');

// Every blade row is a lofted airfoil with authored twist, not an extruded slab.
const bladeParts = prepared.partDefinitions.filter((part: JsonRecord) => part.extensions?.airfoil);
invariant(bladeParts.length === 18, `jet-engine airfoil part count is ${bladeParts.length}`);
for (const part of bladeParts) {
  const loft = part.features.find((feature: JsonRecord) => feature.type === 'loft');
  invariant(loft && loft.sections.length >= 2, `jet-engine ${part.id} is not a lofted airfoil`);
  const sections = part.extensions.airfoil.sections as JsonRecord[];
  invariant(sections.length === loft.sections.length, `jet-engine ${part.id} airfoil metadata is incomplete`);
  const isStrut = part.extensions.jetEngineRole === 'strut-seed';
  invariant(isStrut || Math.abs(Number(sections.at(-1)?.staggerDeg) - Number(sections[0]?.staggerDeg)) >= 6,
    `jet-engine ${part.id} carries no authored twist`);
  invariant(new Set(sections.map((section) => section.spanZ)).size === sections.length,
    `jet-engine ${part.id} sections do not span the blade`);
}
const revolveParts = prepared.partDefinitions.filter((part: JsonRecord) =>
  part.features.some((feature: JsonRecord) => feature.type === 'revolve' && feature.profileSketchId && feature.axisDatumId));
invariant(revolveParts.length === EXPECTED_PART_COUNT - bladeParts.length,
  'jet-engine non-blade parts must be authored bodies of revolution');
invariant(prepared.partDefinitions.every((part: JsonRecord) =>
  part.features.every((feature: JsonRecord) => feature.type === 'loft' || feature.type === 'revolve')),
'jet-engine parts must contain only exact Loft and Revolve features');

// Saved exploded layout with axial separation, saved section view, and the
// shipped drawing sheet.
invariant(rootAssembly.metadata.activeExplodedViewId === 'exploded-jet-engine-service-layout',
  'jet-engine saved exploded view is not active');
invariant(rootAssembly.explodedViews.length === 1 && rootAssembly.explodedViews[0].steps.length === 6,
  'jet-engine saved exploded layout must carry one step per module');
invariant(rootAssembly.explodedViews[0].steps.every((step: JsonRecord) => {
  const matrix = step.deltaTransform as number[];
  return Math.abs(Number(matrix[12])) > 0 && matrix[13] === 0 && matrix[14] === 0;
}), 'jet-engine exploded steps must separate modules along the engine axis');
const explodedTransforms = inspectionModule.studioV5ActiveExplodedTransforms(prepared) as Map<string, number[]>;
invariant(explodedTransforms.size === 6, `jet-engine expected 6 exploded module transforms, received ${explodedTransforms.size}`);
invariant(rootAssembly.sectionViews.length === 1
  && rootAssembly.sectionViews[0].kind === 'plane'
  && rootAssembly.sectionViews[0].definition?.planes?.length === 1,
'jet-engine template must ship one saved plane section view');
const drawingBook = prepared.extensions?.drawingBook as JsonRecord;
invariant(drawingBook?.schema === 'partmode.drawing-book/v1'
  && drawingBook.sheets?.length === 1
  && drawingBook.activeSheetId === drawingBook.sheets[0].id
  && drawingBook.sheets[0].views.length >= 3,
'jet-engine template must ship an initialized drawing sheet');

// ---------------------------------------------------------------------------
// Exact drawing evidence: the assembly drawing carries a complete BOM and
// balloon plan from the production kernel.
// ---------------------------------------------------------------------------

{
  const kernel = await createHeadlessKernel();
  try {
    await kernel.waitForKernel();
    const drawing = await kernel.request({
      kind: 'drawing-v5',
      requestId: 'jet-engine-drawing-acceptance',
      projectId: prepared.projectId,
      revision: 1,
      document: prepared,
      views: ['front'],
    }, 600_000) as JsonRecord;
    invariant(drawing.kind === 'drawing-result' && (drawing.errors || []).length === 0,
      `jet-engine assembly drawing failed: ${JSON.stringify(drawing.errors || [])}`);
    invariant(drawing.manifest?.documentKind === 'assembly'
      && drawing.manifest.exactProjectionEvidence?.kind === 'occt-hlr-exact',
    'jet-engine assembly drawing lacks exact projection evidence');
    const bom = drawing.manifest.bom as JsonRecord[];
    invariant(Array.isArray(bom) && bom.length >= 30,
      `jet-engine BOM does not cover the part catalog: ${bom?.length}`);
    invariant(bom.reduce((total, row) => total + row.quantity, 0) === EXPECTED_BODY_COUNT,
      'jet-engine BOM quantities do not cover every solved occurrence');
    const balloons = drawing.manifest.annotations?.balloons as JsonRecord[];
    invariant(Array.isArray(balloons) && balloons.length === bom.length,
      'jet-engine balloons do not cover every BOM item');
    invariant(balloons.every((entry) => entry.evidence?.kind === 'occt-brep-camera-support'),
      'jet-engine balloons are not backed by exact camera-support evidence');
  } finally {
    await kernel.dispose();
  }
}

let local: RunningPartModeServer | undefined;
let browser: Browser | undefined;
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
const networkErrors: string[] = [];

try {
  if (!externalUrl) {
    local = await startPartModeServer({
      distDir: resolve(root, 'dist'),
      host: '127.0.0.1',
      port: 0,
      stateDir: resolve(temporaryDirectory, 'state'),
    });
  }
  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 360_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('bw-studio-welcome-v1', '1');
    localStorage.setItem('bw-studio-tour-v1', '1');
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    networkErrors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || 'failed'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) networkErrors.push(`${response.status()} ${response.url()}`);
  });

  const targetUrl = externalUrl || local?.url;
  invariant(targetUrl, 'PartMode smoke target URL is unavailable');
  const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  invariant(response?.status() === 200, `PartMode page returned HTTP ${response?.status() || 0}`);
  if (expectedReleaseSha) {
    const actualReleaseSha = await page.$eval('meta[name="partmode-release"]', (element) => element.getAttribute('content'));
    invariant(actualReleaseSha === expectedReleaseSha,
      `PartMode page release is ${actualReleaseSha || 'missing'}, expected ${expectedReleaseSha}`);
  }
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    return studio && studio.mode().kind === 'idle' && document.getElementById('bw-templates-open');
  }, { polling: 50, timeout: 60_000 });

  await clickVisible(page, '#pm-cookie-essential');
  await clickVisible(page, '#bw-templates-open');
  await page.waitForSelector('[data-template-id="jet-engine-exploded-assembly"]', { visible: true, timeout: 10_000 });
  await clickVisible(page, '[data-template-id="jet-engine-exploded-assembly"]');
  await clickVisible(page, '#bw-template-use');
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    if (!studio || studio.mode().kind !== 'idle' || studio.documentRevision() !== studio.appliedRevision()) return false;
    try {
      const documentValue = JSON.parse(studio.docJson());
      return documentValue.metadata?.templateId === 'jet-engine-exploded-assembly'
        && studio.bodyResults().length === documentValue.metadata.expectedExactBodyCount;
    } catch {
      return false;
    }
  }, { polling: 100, timeout: 300_000 });

  const runtime = await page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    const documentValue = JSON.parse(studio.docJson());
    const rootValue = documentValue.assemblyDefinitions.find(
      (assembly: Record<string, any>) => assembly.id === documentValue.rootDocument.assemblyId,
    );
    const bodyResults = studio.bodyResults();
    let rootRows = [...document.querySelectorAll<HTMLElement>('#bw-assembly-tree > .assembly-row')];
    const flightPanel = document.getElementById('bw-agent-flight-recorder') as HTMLElement | null;
    const beforeAgent = studio.agentFlightRecorder();
    const recorderBeforeProjectionFailure = beforeAgent.length;
    studio.failNextDisplayProjectionForTest();
    await studio.rebuildForTest();
    const projectionFailureRecords = studio.agentFlightRecorder().slice(recorderBeforeProjectionFailure);
    await studio.rebuildForTest();
    const secretSentinel = 'PARTMODE_SENTINEL_DO_NOT_RECORD_7f3a91';
    const connection = await studio.connectAgentForTest({
      clientLabel: 'Codex jet-engine acceptance',
      uiProfile: 'partmode.cad.visible-projection/v1',
      permissionContext: { granted: ['project.read', 'ui.read', 'ui.wait-events'] },
    });
    const manifest = await (window as any).partmodeAgent.requestTool(
      connection.connectionToken,
      'cad_capabilities',
      {},
      secretSentinel,
    );
    studio.commitHumanOperationsForTest(secretSentinel, [{
      kind: 'component.update',
      input: { occurrenceId: rootValue.occurrences[0].id, patch: { visible: true } },
    }]);
    await studio.latestDocumentSettlementForTest();
    const connectedBeforeReconnect = studio.agentFlightRecorder()
      .filter((entry: Record<string, any>) => entry.message.startsWith('session connected')).length;
    studio.disconnectAgentForTest(connection.connectionToken);
    const reconnect = await studio.connectAgentForTest({
      clientLabel: 'Codex jet-engine reconnect acceptance',
      uiProfile: 'partmode.cad.visible-projection/v1',
      permissionContext: { granted: ['project.read', 'ui.read', 'ui.wait-events'] },
    });
    const afterAgent = studio.agentFlightRecorder();
    const connectedAfterReconnect = afterAgent
      .filter((entry: Record<string, any>) => entry.message.startsWith('session connected')).length;
    const recorderText = document.getElementById('bw-agent-flight-recorder-log')?.textContent || '';
    const recorderHtml = document.getElementById('bw-agent-flight-recorder')?.outerHTML || '';
    studio.disconnectAgentForTest(reconnect.connectionToken);
    rootRows = [...document.querySelectorAll<HTMLElement>('#bw-assembly-tree > .assembly-row')];
    const phases = afterAgent.map((entry: Record<string, any>) => entry.phase);
    const generatedByPattern: Record<string, number> = {};
    for (const entry of bodyResults) {
      const patternId = entry.occurrenceInstance?.patternInstance?.patternId;
      if (typeof patternId === 'string') generatedByPattern[patternId] = (generatedByPattern[patternId] || 0) + 1;
    }
    return {
      bodyCount: bodyResults.length,
      exactBodies: bodyResults.filter((entry: Record<string, any>) =>
        !entry.error
          && entry.lastValid !== true
          && entry.geometry?.valid === true
          && entry.geometry?.brepValid === true
          && entry.geometry?.solidCount === 1
          && Number(entry.geometry?.volume) > 0).length,
      generatedBodies: bodyResults.filter((entry: Record<string, any>) =>
        entry.occurrenceInstance?.patternInstance).length,
      generatedByPattern,
      uniqueBodyIds: new Set(bodyResults.map((entry: Record<string, any>) => entry.bodyId)).size,
      rootNames: rootRows.map((row) => row.querySelector('[data-occurrence-action="select"] span')?.textContent?.trim()),
      rootItemNumbers: rootRows.map((row) => row.dataset.itemNumber || null),
      firstRootLayout: (() => {
        const row = rootRows[0];
        const select = row?.querySelector<HTMLElement>('[data-occurrence-action="select"]');
        const name = select?.querySelector<HTMLElement>('span');
        const detail = select?.querySelector<HTMLElement>('small');
        return {
          rowWidth: row?.getBoundingClientRect().width || 0,
          selectWidth: select?.getBoundingClientRect().width || 0,
          nameWidth: name?.getBoundingClientRect().width || 0,
          detailWidth: detail?.getBoundingClientRect().width || 0,
          selectDisplay: select ? getComputedStyle(select).display : null,
        };
      })(),
      visibleLeafRows: document.querySelectorAll('#bw-assembly-tree > .assembly-leaf-row:not([hidden])').length,
      activeExplodedViewId: studio.activeExplodedViewId(),
      activeExplodedRows: document.querySelectorAll('#bw-inspection-tree .inspection-row.is-active').length,
      savedViewRows: document.querySelectorAll('#bw-inspection-tree .inspection-row').length,
      documentMateCount: documentValue.assemblyDefinitions
        .reduce((total: number, assembly: Record<string, any>) => total + (assembly.mates || []).length, 0),
      fixedOccurrences: documentValue.assemblyDefinitions
        .flatMap((assembly: Record<string, any>) => assembly.occurrences)
        .filter((entry: Record<string, any>) => entry.fixed === true).length,
      trace: studio.evaluationTrace(),
      panelVisible: Boolean(flightPanel && !flightPanel.hidden),
      demoFlightRecorderEnabled: documentValue.metadata?.partmodeDemo?.flightRecorder === true,
      beforeAgent,
      afterAgent,
      projectionFailureRecords,
      connectedBeforeReconnect,
      connectedAfterReconnect,
      recorderText,
      recorderHtml,
      secretSentinel,
      phases,
      capabilityProtocolVersion: manifest.protocolVersion,
      capabilityStudioVersion: manifest.studioVersion,
      capabilityKernelVersion: manifest.kernelVersion,
      capabilitySchemaVersions: manifest.schemaVersions,
      capabilityDocumentKinds: manifest.documentKinds,
      documentBodyContract: documentValue.metadata.expectedExactBodyCount,
      rootOccurrenceCount: rootValue.occurrences.length,
      renderBodyCount: studio.renderBodyCount(),
      renderGeometryCount: studio.renderGeometryCount(),
      triangleCount: studio.triCount(),
      scenePresentation: studio.scenePresentationStateForTest(),
      framePresentation: studio.framePresentationForTest(),
      errors: studio.errors(),
    };
  });

  invariant(runtime.bodyCount === EXPECTED_BODY_COUNT && runtime.exactBodies === EXPECTED_BODY_COUNT,
    `jet-engine exact runtime bodies are ${runtime.exactBodies}/${runtime.bodyCount}`);
  invariant(runtime.generatedBodies === EXPECTED_GENERATED_MEMBERS,
    `jet-engine generated body count is ${runtime.generatedBodies}`);
  invariant(runtime.uniqueBodyIds === EXPECTED_BODY_COUNT, `jet-engine unique body ids are ${runtime.uniqueBodyIds}`);
  for (const pattern of occurrencePatterns) {
    invariant(runtime.generatedByPattern[pattern.id] === pattern.generatedCount,
      `jet-engine pattern ${pattern.id} generated ${runtime.generatedByPattern[pattern.id] || 0} exact bodies, expected ${pattern.generatedCount}`);
  }
  invariant(JSON.stringify(runtime.rootNames) === JSON.stringify(expectedNames),
    `visible numbered module rows are wrong: ${JSON.stringify(runtime.rootNames)}`);
  invariant(JSON.stringify(runtime.rootItemNumbers) === JSON.stringify(['01', '02', '03', '04', '05', '06']),
    `visible module item numbers are wrong: ${JSON.stringify(runtime.rootItemNumbers)}`);
  invariant(runtime.firstRootLayout.selectWidth >= 150 && runtime.firstRootLayout.nameWidth >= 150,
    `visible module enumeration is cramped: ${JSON.stringify(runtime.firstRootLayout)}`);
  invariant(runtime.visibleLeafRows === 0, `jet-engine tree opened with ${runtime.visibleLeafRows} flooded leaf rows`);
  invariant(runtime.activeExplodedViewId === 'exploded-jet-engine-service-layout' && runtime.activeExplodedRows === 1,
    'jet-engine saved exploded inspection is not visibly active');
  invariant(runtime.savedViewRows >= 2, 'jet-engine saved exploded and section rows are not visible');
  invariant(runtime.documentMateCount === EXPECTED_MATE_COUNT && runtime.documentMateCount > 0,
    `jet-engine runtime mate count is ${runtime.documentMateCount}`);
  invariant(runtime.fixedOccurrences === 0,
    `jet-engine runtime document retains ${runtime.fixedOccurrences} fixed occurrences`);
  invariant(runtime.rootOccurrenceCount === 6 && runtime.documentBodyContract === EXPECTED_BODY_COUNT,
    'jet-engine document contract is inconsistent with the visible runtime');
  invariant(runtime.trace?.solverState === 'fully-constrained',
    `jet-engine mate solve is ${runtime.trace?.solverState}, not fully-constrained`);
  invariant(runtime.trace?.conflicts?.length === 0,
    `jet-engine mated assembly has solver conflicts: ${JSON.stringify(runtime.trace?.conflicts)}`);
  invariant(Object.values(runtime.trace?.degreesOfFreedom || {}).every((value) => value === 0),
    `jet-engine mated assembly retained degrees of freedom: ${JSON.stringify(runtime.trace?.degreesOfFreedom)}`);
  const recorderDiagnostics = () => JSON.stringify({
    records: runtime.afterAgent.map((entry: JsonRecord) => ({
      phase: entry.phase,
      kind: entry.kind,
      message: entry.message,
      revision: entry.revision,
    })),
    renderBodyCount: runtime.renderBodyCount,
    renderGeometryCount: runtime.renderGeometryCount,
    triangleCount: runtime.triangleCount,
  });
  invariant(runtime.renderBodyCount === EXPECTED_BODY_COUNT
    && runtime.renderGeometryCount === EXPECTED_PART_COUNT
    && runtime.triangleCount > 0,
  `jet-engine exact bodies were not completely projected into the viewport; diagnostics=${recorderDiagnostics()}`);
  invariant(runtime.scenePresentation.gridVisible === false,
    'jet-engine assembly presentation retained the part-modeling grid');
  invariant(runtime.scenePresentation.environmentReady === true,
    'jet-engine metallic materials have no image-based studio light');
  invariant(runtime.scenePresentation.visibleBodies === EXPECTED_BODY_COUNT
      && runtime.scenePresentation.opaqueBodies === EXPECTED_BODY_COUNT
      && runtime.scenePresentation.minimumOpacity === 1,
    `jet-engine presentation is unexpectedly translucent: ${JSON.stringify(runtime.scenePresentation)}`);
  invariant(runtime.framePresentation.modelPixelCount > 0,
    `jet-engine presentation frame contains no distinguishable model pixels: ${JSON.stringify(runtime.framePresentation)}`);
  invariant(runtime.framePresentation.meanModelLuminance >= 60
      && runtime.framePresentation.darkModelFraction <= 0.2,
    `jet-engine metallic presentation regressed to unreadable dark faces: ${JSON.stringify(runtime.framePresentation)}`);
  invariant(runtime.panelVisible, 'jet-engine agent flight recorder is not visible');
  invariant(runtime.demoFlightRecorderEnabled, 'jet-engine document lost its flight-recorder contract');
  for (const phase of ['DOCUMENT', 'KERNEL', 'RENDER', 'ASSEMBLY', 'VIEW', 'AGENT']) {
    invariant(runtime.phases.includes(phase),
      `jet-engine flight recorder omits real ${phase} evidence; phases=${JSON.stringify(runtime.phases)}`);
  }
  invariant(runtime.afterAgent.length <= 160, 'jet-engine flight recorder exceeded its bounded retention');
  const capabilityCompletion = runtime.afterAgent.find((entry: JsonRecord) =>
    entry.message.includes('cad_capabilities completed') && entry.kind === 'ok');
  invariant(capabilityCompletion?.operationId?.startsWith('OP-'),
  'jet-engine flight recorder did not pair the real capability request/result');
  invariant(runtime.afterAgent.some((entry: JsonRecord) =>
    entry.operationId === capabilityCompletion.operationId
      && entry.message.includes('cad_capabilities accepted')
      && entry.status === 'running'),
  'jet-engine flight recorder did not retain the local operation start');
  invariant(runtime.projectionFailureRecords.some((entry: JsonRecord) =>
    entry.phase === 'RENDER' && entry.kind === 'error' && entry.message === 'viewport projection failed'),
  'jet-engine flight recorder did not report forced viewport projection failure');
  invariant(!runtime.projectionFailureRecords.some((entry: JsonRecord) =>
    entry.phase === 'RENDER' && entry.kind === 'ok'),
  'jet-engine flight recorder claimed render success after forced projection failure');
  invariant(runtime.afterAgent.some((entry: JsonRecord) =>
    entry.phase === 'KERNEL' && entry.kind === 'ok'
      && entry.message.startsWith(`${EXPECTED_BODY_COUNT} exact B-rep bodies`)),
  `jet-engine flight recorder did not bind kernel success to all ${EXPECTED_BODY_COUNT} healthy exact bodies`);
  invariant(runtime.afterAgent.some((entry: JsonRecord) =>
    entry.phase === 'RENDER' && entry.kind === 'ok'
      && entry.message.startsWith(`${EXPECTED_BODY_COUNT} exact bodies projected`)),
  `jet-engine flight recorder did not bind render success to the ${EXPECTED_BODY_COUNT}-body viewport projection`);
  invariant(runtime.connectedAfterReconnect === runtime.connectedBeforeReconnect + 1,
    `jet-engine reconnect event was lost (${runtime.connectedBeforeReconnect} -> ${runtime.connectedAfterReconnect})`);
  const recordedSurface = JSON.stringify(runtime.afterAgent) + runtime.recorderText + runtime.recorderHtml;
  invariant(!recordedSurface.includes(runtime.secretSentinel),
    'jet-engine flight recorder leaked a caller-supplied request ID or transaction label');
  invariant(runtime.afterAgent.every((entry: JsonRecord) =>
    !entry.message.includes('permissionContext')
      && !entry.message.includes('partDefinitions')
      && !entry.message.includes('connectionToken')
      && entry.requestId === undefined
      && entry.correlationId === undefined),
  'jet-engine flight recorder leaked raw request or project data');
  invariant(runtime.capabilityProtocolVersion === 'partmode.cad.agent/v1'
      && runtime.capabilityStudioVersion === '8.0.0'
      && runtime.capabilityKernelVersion === 'replicad-open-cascade/runtime-5A'
      && runtime.capabilitySchemaVersions?.includes(5)
      && runtime.capabilityDocumentKinds?.includes('assembly'),
    'jet-engine agent capability receipt is missing the V8 contract');
  invariant(runtime.errors.length === 0, `jet-engine visible Studio errors: ${runtime.errors.join('; ')}`);
  invariant(pageErrors.length === 0 && consoleErrors.length === 0 && networkErrors.length === 0,
    `jet-engine browser errors: ${JSON.stringify({ pageErrors, consoleErrors, networkErrors })}`);

  const screenshotPath = process.env.PARTMODE_JET_SCREENSHOT;
  if (screenshotPath) await page.screenshot({ path: screenshotPath as `${string}.png` });

  const engineBeforeTransition = await page.evaluate(() => {
    const studio = (window as any).__bwStudio;
    return {
      projectId: studio.projectId(),
      canonicalHash: studio.canonicalHash(),
      bodyCount: studio.bodyResults().length,
    };
  });
  await clickVisible(page, '#bw-templates-open');
  await page.waitForSelector('[data-template-id="starter-plate"]', { visible: true, timeout: 10_000 });
  await clickVisible(page, '[data-template-id="starter-plate"]');
  await clickVisible(page, '#bw-template-use');
  try {
    await page.waitForFunction(() => {
      const studio = (window as any).__bwStudio;
      if (!studio || studio.mode().kind !== 'idle' || studio.documentRevision() !== studio.appliedRevision()) return false;
      return JSON.parse(studio.docJson()).name === 'Starter plate';
    }, { polling: 50, timeout: 60_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const studio = (window as any).__bwStudio;
      const documentValue = studio ? JSON.parse(studio.docJson()) : null;
      return {
        name: documentValue?.name || null,
        projectId: studio?.projectId?.() || null,
        mode: studio?.mode?.() || null,
        documentRevision: studio?.documentRevision?.() || null,
        appliedRevision: studio?.appliedRevision?.() || null,
        bodyCount: studio?.bodyResults?.().length || 0,
        errors: studio?.errors?.() || [],
        storageState: document.getElementById('bw-storage-state')?.textContent?.trim() || null,
        templateDialogOpen: (document.getElementById('bw-templates') as HTMLDialogElement | null)?.open || false,
        status: document.getElementById('bw-status')?.textContent?.trim() || null,
      };
    });
    throw new Error(`opening Starter plate from the engine did not settle: ${JSON.stringify(diagnostic)}; ${String(error)}`);
  }
  const partPresentation = await page.evaluate(() => (window as any).__bwStudio.scenePresentationStateForTest());
  invariant(partPresentation.gridVisible === true,
    'switching from an assembly to a part did not restore the modeling grid');
  const transitionOffered = await page.$eval('#bw-transition-undo', (element) =>
    element instanceof HTMLButtonElement && !element.hidden && !element.disabled);
  invariant(transitionOffered, 'opening a part template from the engine did not offer transition Undo');
  await clickVisible(page, '#bw-transition-undo');
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    if (!studio || studio.mode().kind !== 'idle' || studio.documentRevision() !== studio.appliedRevision()) return false;
    const documentValue = JSON.parse(studio.docJson());
    return documentValue.metadata?.templateId === 'jet-engine-exploded-assembly'
      && studio.bodyResults().length === documentValue.metadata.expectedExactBodyCount;
  }, { polling: 100, timeout: 300_000 });
  const engineAfterTransition = await page.evaluate(() => {
    const studio = (window as any).__bwStudio;
    return {
      projectId: studio.projectId(),
      canonicalHash: studio.canonicalHash(),
      bodyCount: studio.bodyResults().length,
      bodyContract: JSON.parse(studio.docJson()).metadata?.expectedExactBodyCount,
      scenePresentation: studio.scenePresentationStateForTest(),
      recorder: studio.agentFlightRecorder(),
    };
  });
  invariant(engineAfterTransition.projectId === engineBeforeTransition.projectId,
    'transition Undo did not restore the engine project identity');
  invariant(engineAfterTransition.canonicalHash === engineBeforeTransition.canonicalHash,
    'transition Undo did not restore the canonical engine document');
  invariant(engineAfterTransition.bodyCount === engineBeforeTransition.bodyCount
      && engineAfterTransition.bodyCount === engineAfterTransition.bodyContract,
    'transition Undo did not restore the complete exact engine body contract');
  invariant(engineAfterTransition.scenePresentation.gridVisible === false,
    'transition Undo did not restore the clean assembly presentation');
  invariant(engineAfterTransition.recorder[0]?.sequence === 1,
    'engine reopen retained stale flight-recorder rows from another project');
  invariant(pageErrors.length === 0 && consoleErrors.length === 0 && networkErrors.length === 0,
    `jet-engine transition errors: ${JSON.stringify({ pageErrors, consoleErrors, networkErrors })}`);

  console.log(JSON.stringify({
    ok: true,
    document: {
      schemaVersion: prepared.schemaVersion,
      rootOccurrences: rootAssembly.occurrences.length,
      explicitOccurrences: prepared.metadata.expectedExplicitOccurrenceCount,
      generatedPatternMembers: prepared.metadata.expectedGeneratedBodyPatternMembers,
      exactBodies: runtime.exactBodies,
      authoredMates: runtime.documentMateCount,
      fixedOccurrences: runtime.fixedOccurrences,
      airfoilParts: bladeParts.length,
      saveReopenStable: true,
    },
    kernel: {
      solverState: runtime.trace?.solverState,
      conflicts: runtime.trace?.conflicts?.length || 0,
      projectedBodies: runtime.renderBodyCount,
      renderedGeometryTemplates: runtime.renderGeometryCount,
      triangles: runtime.triangleCount,
    },
    presentation: {
      numberedRows: runtime.rootNames,
      collapsedLeafRows: runtime.visibleLeafRows,
      activeExplodedViewId: runtime.activeExplodedViewId,
      gridVisible: runtime.scenePresentation.gridVisible,
      environmentReady: runtime.scenePresentation.environmentReady,
      opaqueBodies: runtime.scenePresentation.opaqueBodies,
      meanModelLuminance: runtime.framePresentation.meanModelLuminance,
      darkModelFraction: runtime.framePresentation.darkModelFraction,
      savedSectionViews: rootAssembly.sectionViews.length,
      drawingSheets: drawingBook.sheets.length,
      flightRecorderPhases: [...new Set(runtime.phases)],
      flightRecorderRecords: runtime.afterAgent.length,
      templateTransitionRestored: true,
    },
  }));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
