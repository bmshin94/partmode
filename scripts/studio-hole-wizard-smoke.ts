import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Hole Wizard smoke failed: ${label}`);
}

function closeTo(actual: number, expected: number, tolerance = 2e-5): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function throws(label: string, action: () => unknown, pattern: RegExp): void {
  let error: unknown = null;
  try {
    action();
  } catch (candidate) {
    error = candidate;
  }
  check(label, error && pattern.test(String((error as Error).message || error)));
}

const root = process.cwd();
const moduleAt = async (path: string) => import(pathToFileURL(resolve(root, path)).href) as Promise<any>;
const holeWizard = await moduleAt('src/static/studio-hole-wizard.js');
const projectModule = await moduleAt('src/static/studio-project-v5.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const agent = await moduleAt('src/static/studio-agent-service.js');
const featureTypes = await moduleAt('src/static/studio-v5-feature-types.js');

check('catalog inventory changed', JSON.stringify(holeWizard.STUDIO_HOLE_WIZARD_ROWS.map((entry: JsonRecord) => entry.designation))
  === JSON.stringify(['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12']));
check('hole kinds changed', JSON.stringify(holeWizard.STUDIO_HOLE_WIZARD_KINDS)
  === JSON.stringify(['clearance', 'tapped', 'counterbore', 'countersink']));
check('catalog rows are not immutable', Object.isFrozen(holeWizard.STUDIO_HOLE_WIZARD_ROWS)
  && holeWizard.STUDIO_HOLE_WIZARD_ROWS.every((entry: JsonRecord) => Object.isFrozen(entry)));
check('source records are not immutable', Object.isFrozen(holeWizard.STUDIO_HOLE_WIZARD_SOURCES)
  && Object.values(holeWizard.STUDIO_HOLE_WIZARD_SOURCES).every(Object.isFrozen));
check('official source metadata is incomplete', Object.values(holeWizard.STUDIO_HOLE_WIZARD_SOURCES).every((source: any) =>
  source.url.startsWith('https://www.iso.org/standard/')
  && /^\d{4}-\d{2}-\d{2}$/u.test(source.verifiedOn)
  && typeof source.status === 'string'
  && source.status.length > 0));

for (const kind of holeWizard.STUDIO_HOLE_WIZARD_KINDS as string[]) {
  for (const entry of holeWizard.STUDIO_HOLE_WIZARD_ROWS as JsonRecord[]) {
    const definition = holeWizard.studioHoleWizardDefinition(kind, entry.designation);
    check(`${kind} ${entry.designation} lacks a positive pilot`, definition.dimensions.pilotDiameter > 0);
    check(`${kind} ${entry.designation} lacks source metadata`, definition.sources.length === definition.sourceIds.length
      && definition.sources.every((source: JsonRecord, index: number) => source.id === definition.sourceIds[index]));
    if (kind === 'tapped') {
      check(`${entry.designation} tap drill is not smaller than the thread major diameter`,
        definition.dimensions.tapDrillDiameter < definition.dimensions.threadMajorDiameter);
      check(`${entry.designation} coarse pitch detached from row`, definition.dimensions.coarsePitch === entry.coarsePitch);
    }
    if (kind === 'counterbore' || kind === 'countersink') {
      check(`${kind} ${entry.designation} recess is not larger than its pilot`,
        definition.dimensions.recessDiameter > definition.dimensions.pilotDiameter
        && definition.dimensions.recessDepth > 0);
    }
  }
}

throws('case-folded designation did not fail closed',
  () => holeWizard.studioHoleWizardDefinition('clearance', 'm6'), /Unsupported Hole Wizard size/u);
throws('unknown kind did not fail closed',
  () => holeWizard.studioHoleWizardDefinition('spotface', 'M6'), /Unsupported Hole Wizard kind/u);
throws('non-finite center did not fail closed',
  () => holeWizard.createStudioHoleWizardExtension({ kind: 'clearance', designation: 'M6', center: [0, Number.NaN] }), /finite/u);

const valid = holeWizard.createStudioHoleWizardFeature({
  id: 'feature-hole-wizard-validation',
  bodyId: 'body-validation',
  kind: 'counterbore',
  designation: 'M6',
  center: [2, -3],
  sketchZ: 20,
});
featureTypes.assertStudioV5FeatureStructure(valid, 'valid-hole-wizard');
const changedDimension = structuredClone(valid);
changedDimension.extensions.holeWizard.dimensions.recessDiameter += 0.1;
throws('tampered nominal dimension did not fail closed',
  () => featureTypes.assertStudioV5FeatureStructure(changedDimension), /does not match/u);
const changedSource = structuredClone(valid);
changedSource.extensions.holeWizard.sources[0].url = 'https://example.invalid/';
throws('tampered source provenance did not fail closed',
  () => featureTypes.assertStudioV5FeatureStructure(changedSource), /official source metadata/u);
const changedProfile = structuredClone(valid);
changedProfile.sketch.shapes[0].r += 0.1;
throws('detached pilot profile did not fail closed',
  () => featureTypes.assertStudioV5FeatureStructure(changedProfile), /circle diameter/u);
const changedExtent = structuredClone(valid);
changedExtent.through = false;
throws('blind extent did not fail closed',
  () => featureTypes.assertStudioV5FeatureStructure(changedExtent), /Through All Cut/u);

const plateDocument = (projectId: string): JsonRecord => runtime.createStudioV5RuntimePartProject({
  projectId,
  name: 'Hole Wizard exact plate',
  units: 'mm',
  parameters: [],
  features: [{
    id: 'feature-base-plate',
    type: 'extrude',
    sketch: {
      shapes: [{ id: 'shape-base-plate', kind: 'rect', x: 0, y: 0, w: 40, h: 40 }],
      z: 0,
    },
    h: 20,
    through: false,
  }],

});

const expectedVolume = (definition: JsonRecord): number => {
  const dimensions = definition.dimensions;
  const pilotRadius = dimensions.pilotDiameter / 2;
  let removed = Math.PI * pilotRadius ** 2 * 20;
  if (definition.kind === 'counterbore') {
    removed += Math.PI * ((dimensions.recessDiameter / 2) ** 2 - pilotRadius ** 2) * dimensions.recessDepth;
  } else if (definition.kind === 'countersink') {
    const outerRadius = dimensions.recessDiameter / 2;
    const h = dimensions.recessDepth;
    const frustum = Math.PI * h * (outerRadius ** 2 + outerRadius * pilotRadius + pilotRadius ** 2) / 3;
    removed += frustum - Math.PI * pilotRadius ** 2 * h;
  }
  return 40 * 40 * 20 - removed;
};

let headlessKernel: HeadlessKernel | null = null;
try {
  headlessKernel = await createHeadlessKernel();
  await headlessKernel.waitForKernel();
  const evidence: JsonRecord[] = [];
  let revision = 0;
  for (const kind of holeWizard.STUDIO_HOLE_WIZARD_KINDS as string[]) {
    const projectId = `project-hole-wizard-${kind}`;
    const base = plateDocument(projectId);
    const body = runtime.studioV5ActiveBody(base);
    check(`${kind} base plate has no active target body`, body?.id);
    const feature = holeWizard.createStudioHoleWizardFeature({
      id: `feature-hole-wizard-${kind}`,
      bodyId: body.id,
      kind,
      designation: 'M6',
      center: [0, 0],
      sketchZ: 20,
    });
    const applied = agent.applyCadTransaction(base, {
      transactionId: `transaction-hole-wizard-${kind}`,
      label: `Create ${kind} hole`,
      expectedRevision: 0,
      atomic: true,
      operations: [{ kind: 'feature.cut', input: holeWizard.studioHoleWizardOperationInput(feature) }],
    }).project as JsonRecord;
    const storedFeature = applied.partDefinitions[0].features.at(-1);
    check(`${kind} typed transaction lost the Hole Wizard recipe`, storedFeature.extensions?.holeWizard?.kind === kind);
    check(`${kind} typed transaction lost target ownership`, body.featureIds.length === 1
      && applied.partDefinitions[0].bodies[0].featureIds.at(-1) === storedFeature.id);
    const saved = JSON.stringify(projectModule.prepareStudioV5Project(applied));
    const reopened = projectModule.parseStudioV5Project(saved) as JsonRecord;
    check(`${kind} save/reopen changed canonical bytes`, JSON.stringify(reopened) === saved);
    check(`${kind} save/reopen lost source provenance`,
      reopened.partDefinitions[0].features.at(-1).extensions.holeWizard.sources.every((source: JsonRecord) => source.url.startsWith('https://www.iso.org/')));

    revision += 1;
    const rebuild = await headlessKernel.request({
      kind: 'rebuild',
      requestId: `hole-wizard-${revision}-${kind}`,
      projectId,
      revision,
      document: reopened,
      includeExactBrep: true,
    }, 180_000) as JsonRecord;
    const errors = rebuild.errors as JsonRecord[] | undefined;
    check(`${kind} production-kernel rebuild failed: ${JSON.stringify(errors || [])}`,
      rebuild.kind === 'rebuild-result' && Array.isArray(errors) && errors.length === 0);
    check(`${kind} did not rebuild one valid exact solid`, rebuild.bodies?.length === 1
      && rebuild.bodies[0].geometry?.valid === true
      && rebuild.bodies[0].geometry?.brepValid === true
      && rebuild.bodies[0].geometry?.solidCount === 1
      && rebuild.bodies[0].lastValid !== true
      && !rebuild.bodies[0].error);
    const rebuiltBody = rebuild.bodies[0];
    const definition = holeWizard.studioHoleWizardDefinition(kind, 'M6');
    const volume = Number(rebuiltBody.geometry.volume);
    const expected = expectedVolume(definition);
    check(`${kind} exact volume differs from its nominal envelope: ${volume} != ${expected}`, closeTo(volume, expected));
    const roundedBounds = rebuiltBody.geometry.bounds.map((corner: number[]) => corner.map((value) => Math.round(value * 1e9) / 1e9));
    const expectedBounds: number[] = [-20, -20, 0, 20, 20, 20];
    check(`${kind} changed the plate bounds: ${JSON.stringify(roundedBounds)}`,
      roundedBounds.flat().every((value: number, index: number) => closeTo(value, expectedBounds[index] ?? Number.NaN, 2e-6)));
    check(`${kind} canonical exact B-rep is missing`, typeof rebuiltBody.exactBrep === 'string' && rebuiltBody.exactBrep.length > 100);
    evidence.push({
      kind,
      designation: 'M6',
      expectedVolume: expected,
      exactVolume: volume,
      brepBytes: rebuiltBody.exactBrep.length,
      sources: definition.sources.map((source: JsonRecord) => `${source.standard}:${source.edition}`),
      modelPolicy: reopened.partDefinitions[0].features.at(-1).extensions.holeWizard.modelPolicy,
    });
  }
  check('hole kinds did not produce four distinct exact B-reps', new Set(evidence.map((entry) => entry.exactVolume.toFixed(7))).size === 4);

  const bottomBase = plateDocument('project-hole-wizard-bottom-counterbore');
  const bottomBody = runtime.studioV5ActiveBody(bottomBase);
  const bottomFeature = holeWizard.createStudioHoleWizardFeature({
    id: 'feature-hole-wizard-bottom-counterbore',
    bodyId: bottomBody.id,
    kind: 'counterbore',
    designation: 'M6',
    center: [0, 0],
    sketchZ: 0,
  });
  const bottomProject = agent.applyCadTransaction(bottomBase, {
    transactionId: 'transaction-hole-wizard-bottom-counterbore',
    label: 'Create bottom-face counterbore',
    expectedRevision: 0,
    atomic: true,
    operations: [{ kind: 'feature.cut', input: holeWizard.studioHoleWizardOperationInput(bottomFeature) }],
  }).project;
  revision += 1;
  const bottomRebuild = await headlessKernel.request({
    kind: 'rebuild',
    requestId: `hole-wizard-${revision}-bottom-counterbore`,
    projectId: bottomProject.projectId,
    revision,
    document: bottomProject,
    includeExactBrep: true,
  }, 180_000) as JsonRecord;
  check('bottom-plane inward-direction rebuild failed', bottomRebuild.errors?.length === 0 && bottomRebuild.bodies?.[0]?.geometry?.brepValid === true);
  const topCounterbore = evidence.find((entry) => entry.kind === 'counterbore');
  check('top-plane counterbore evidence is missing', topCounterbore);
  check('bottom-plane counterbore volume differs from top-plane counterbore',
    closeTo(Number(bottomRebuild.bodies[0].geometry.volume), topCounterbore.exactVolume));

  const [studioSource, pageSource, registrySource, workerSource, buildSource] = await Promise.all([
    readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
    readFile(resolve(root, 'src/page.html'), 'utf8'),
    readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8'),
    readFile(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8'),
    readFile(resolve(root, 'scripts/build.ts'), 'utf8'),
  ]);
  check('Studio does not import the source-owned Hole Wizard module', studioSource.includes("import('/static/studio-hole-wizard.js')"));
  check('visible Hole Wizard dialog or ribbon control is missing', pageSource.includes('id="bw-hole-wizard-open"') && pageSource.includes('id="bw-hole-wizard-form"'));
  check('Hole Wizard control is missing from the UI denominator', registrySource.includes("control('model.hole-wizard'"));
  check('worker does not execute the source-owned Hole Wizard recipe', workerSource.includes("from '/static/studio-hole-wizard.js'") && workerSource.includes('studioHoleWizardRecess('));
  check('release asset allowlist omits the Hole Wizard module', buildSource.includes("'studio-hole-wizard.js'"));

  console.log(JSON.stringify({
    schema: 'partmode.hole-wizard-smoke/v1',
    catalog: {
      designations: holeWizard.STUDIO_HOLE_WIZARD_ROWS.length,
      kinds: holeWizard.STUDIO_HOLE_WIZARD_KINDS.length,
      combinations: holeWizard.STUDIO_HOLE_WIZARD_ROWS.length * holeWizard.STUDIO_HOLE_WIZARD_KINDS.length,
      complianceStatus: 'reference-content-not-certified',
    },
    exactDocumentRebuilds: evidence.length + 1,
    evidence,
    inwardDirection: { topAndBottomCounterboreVolumesMatch: true },
    unsupported: ['blind-hole extent', 'custom diameters', 'inch standards', 'modeled helical threads', 'manufacturing certification'],
  }, null, 2));
} finally {
  if (headlessKernel) await headlessKernel.dispose();
}
