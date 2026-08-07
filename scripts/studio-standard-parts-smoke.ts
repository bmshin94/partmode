import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Standard-parts smoke failed: ${label}`);
}

function closeTo(actual: number, expected: number, tolerance = 2e-6): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function parameterValues(project: JsonRecord): Record<string, number> {
  const part = project.partDefinitions.find((entry: JsonRecord) => entry.id === project.rootDocument.partId);
  return Object.fromEntries(part.parameters.map((entry: JsonRecord) => [entry.name, Number(entry.value)]));
}

function stableEntries(record: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
}

function numberParameter(parameters: Record<string, number>, name: string): number {
  const value = parameters[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Standard-parts smoke failed: evaluated parameter ${name} is missing or non-finite`);
  }
  return value;
}

const root = process.cwd();
const vendorDirectory = resolve(root, 'src/static/vendor');
const globals = globalThis as typeof globalThis & {
  require: ReturnType<typeof createRequire>;
  __dirname: string;
};
globals.require = createRequire(import.meta.url);
globals.__dirname = vendorDirectory;

const catalog = await import(pathToFileURL(resolve(root, 'src/static/studio-standard-parts.js')).href) as any;
const templates = await import(pathToFileURL(resolve(root, 'src/static/studio-templates.js')).href) as any;
const projectModule = await import(pathToFileURL(resolve(root, 'src/static/studio-project-v5.js')).href) as any;
const runtime = await import(pathToFileURL(resolve(root, 'src/static/studio-v5-runtime-document.js')).href) as any;
const featureTypes = await import(pathToFileURL(resolve(root, 'src/static/studio-v5-feature-types.js')).href) as any;
const rc = await import(pathToFileURL(resolve(vendorDirectory, 'replicad.module.js')).href) as any;
const ocFactory = await import(pathToFileURL(resolve(vendorDirectory, 'replicad-oc.module.js')).href) as any;
const oc = await ocFactory.default({ locateFile: () => resolve(vendorDirectory, 'replicad_single.wasm') });
rc.setOC(oc);

let headlessKernel: HeadlessKernel | null = null;
try {
headlessKernel = await createHeadlessKernel();
await headlessKernel.waitForKernel();
let kernelRevision = 0;
const expectedFamilies = [
  ['iso4017-hex-screw', 'ISO 4017', '2022', 15],
  ['iso4032-hex-nut', 'ISO 4032', '2023', 5],
  ['iso7089-plain-washer', 'ISO 7089', '2000', 5],
] as const;

check('catalog family order or inventory changed',
  JSON.stringify(catalog.STANDARD_PART_FAMILIES.map((family: JsonRecord) => [
    family.id,
    family.source.standard,
    family.source.edition,
    family.rows.length,
  ])) === JSON.stringify(expectedFamilies));
check('visible Standard parts category is missing', templates.STUDIO_TEMPLATE_CATEGORIES.includes('Standard parts'));
check('catalog cards are not all visible template documents', expectedFamilies.every(([id]) =>
  templates.STUDIO_TEMPLATES.some((template: JsonRecord) => template.id === id && template.category === 'Standard parts')));
check('unknown family lookup did not fail closed', catalog.getStandardPartFamily('ISO4017-HEX-SCREW') === null);
let unknownFamilyRejected = false;
try {
  catalog.createStandardPartProject('missing-standard-family');
} catch (error) {
  unknownFamilyRejected = /Unknown standard-part family/u.test(String(error));
}
check('unknown family creation did not fail closed', unknownFamilyRejected);

const evidence: JsonRecord[] = [];
for (const family of catalog.STANDARD_PART_FAMILIES as JsonRecord[]) {
  const source = catalog.createStandardPartProject(family.id) as JsonRecord;
  const prepared = projectModule.prepareStudioV5Project(source) as JsonRecord;
  check(`${family.id} is not a canonical schema-5 part`,
    prepared.schemaVersion === 5
    && prepared.rootDocument.kind === 'part'
    && prepared.partDefinitions.length === 1
    && prepared.assemblyDefinitions.length === 0);
  const part = prepared.partDefinitions[0];
  check(`${family.id} does not own one editable exact body`,
    part.bodies.length === 1
    && part.bodies[0].kind === 'solid'
    && part.bodies[0].featureIds.length === part.features.length
    && part.featureOrder.length === part.features.length);
  part.features.forEach((feature: JsonRecord, index: number) =>
    featureTypes.assertStudioV5FeatureStructure(feature, `${family.id}.features[${index}]`));
  const extension = part.extensions.standardPartCatalog;
  check(`${family.id} catalog provenance is incomplete`,
    extension.schema === 'partmode.standard-part-catalog/v1'
    && extension.source.standard === family.source.standard
    && extension.source.edition === family.source.edition
    && extension.source.url.startsWith('https://www.iso.org/')
    && extension.complianceStatus === 'reference-content-not-certified'
    && extension.limitations.some((entry: string) => entry.includes('licensed standard')));
  const set = prepared.partConfigurationSets[0];
  check(`${family.id} configuration inventory does not match source rows`,
    set.partId === part.id
    && set.configurations.length === family.rows.length
    && Object.keys(extension.configurationData).length === family.rows.length);
  check(`${family.id} repeats a designation`, new Set(family.rows.map((row: JsonRecord) => row.designation)).size === family.rows.length);
  check(`${family.id} repeats a configuration ID`, new Set(set.configurations.map((entry: JsonRecord) => entry.id)).size === set.configurations.length);

  let unknownConfigurationRejected = false;
  try {
    runtime.switchStudioV5PartConfiguration(prepared, part.id, `${family.id}-MISSING`);
  } catch (error) {
    unknownConfigurationRejected = (error as { code?: string })?.code === 'UNKNOWN_CONFIGURATION_ID';
  }
  check(`${family.id} unknown configuration did not fail closed`, unknownConfigurationRejected);

  const familyVolumes: number[] = [];
  const familyBreps: string[] = [];
  for (const configuration of set.configurations) {
    const configurationData = extension.configurationData[configuration.id];
    const row = family.rows.find((entry: JsonRecord) => entry.designation === configurationData?.designation);
    check(`${configuration.id} has no exact source row`, row);
    const active = runtime.switchStudioV5PartConfiguration(prepared, part.id, configuration.id).project as JsonRecord;
    const saved = JSON.stringify(projectModule.prepareStudioV5Project(active));
    const reopened = projectModule.parseStudioV5Project(saved) as JsonRecord;
    check(`${configuration.id} save/reopen changed canonical bytes`, JSON.stringify(reopened) === saved);
    check(`${configuration.id} save/reopen lost active designation`,
      reopened.partConfigurationSets[0].activeConfigurationId === configuration.id);
    const expectedParameters = family.parameterOverrides(row);
    const evaluated = runtime.applyStudioV5PartConfiguration(reopened, part.id, configuration.id).project as JsonRecord;
    check(`${configuration.id} parameter overrides are not exact`,
      JSON.stringify(stableEntries(parameterValues(evaluated))) === JSON.stringify(stableEntries(expectedParameters)));
    check(`${configuration.id} catalog identity is detached from its source row`,
      configurationData.designation === row.designation
      && configurationData.partNumber === row.partNumber
      && JSON.stringify(stableEntries(configurationData.dimensions)) === JSON.stringify(stableEntries(expectedParameters)));

    const p = parameterValues(evaluated);
    let shape: any;
    let expectedVolume: number;
    let expectedHeight: number;
    try {
      if (family.id === 'iso4017-hex-screw') {
      const threadMajor = numberParameter(p, 'thread_major');
      const length = numberParameter(p, 'length');
      const headAcrossFlats = numberParameter(p, 'head_across_flats');
      const headHeight = numberParameter(p, 'head_height');
      const shank = rc.makeCylinder(threadMajor / 2, length);
      const head = rc.drawPolysides(headAcrossFlats / Math.sqrt(3), 6)
        .sketchOnPlane('XY', [0, 0, length])
        .extrude(headHeight);
      try {
        shape = shank.fuse(head);
      } finally {
        shank.delete();
        head.delete();
      }
      expectedVolume = Math.PI * threadMajor ** 2 * length / 4
        + Math.sqrt(3) * headAcrossFlats ** 2 * headHeight / 2;
      expectedHeight = length + headHeight;
      } else if (family.id === 'iso4032-hex-nut') {
      const threadMajor = numberParameter(p, 'thread_major');
      const acrossFlats = numberParameter(p, 'across_flats');
      const height = numberParameter(p, 'height');
      const outside = rc.drawPolysides(acrossFlats / Math.sqrt(3), 6).sketchOnPlane('XY').extrude(height);
      const bore = rc.makeCylinder(threadMajor / 2, height);
      try {
        shape = outside.cut(bore);
      } finally {
        outside.delete();
        bore.delete();
      }
      expectedVolume = (Math.sqrt(3) * acrossFlats ** 2 / 2 - Math.PI * threadMajor ** 2 / 4) * height;
      expectedHeight = height;
      } else {
      const outsideDiameter = numberParameter(p, 'outside_diameter');
      const boreDiameter = numberParameter(p, 'bore_diameter');
      const thickness = numberParameter(p, 'thickness');
      const outside = rc.makeCylinder(outsideDiameter / 2, thickness);
      const bore = rc.makeCylinder(boreDiameter / 2, thickness);
      try {
        shape = outside.cut(bore);
      } finally {
        outside.delete();
        bore.delete();
      }
      expectedVolume = Math.PI * (outsideDiameter ** 2 - boreDiameter ** 2) * thickness / 4;
      expectedHeight = thickness;
      }
      try {
        const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
        try {
          check(`${configuration.id} exact OCCT solid is invalid`, analyzer.IsValid_2());
        } finally {
          analyzer.delete();
        }
        const volume = rc.measureVolume(shape);
        const bounds = shape.boundingBox.bounds;
        check(`${configuration.id} exact volume does not match its controlled dimensions`, closeTo(volume, expectedVolume, 1e-5));
        check(`${configuration.id} exact axial bound does not match its controlled dimensions`,
          closeTo(bounds[0][2], 0) && closeTo(bounds[1][2], expectedHeight));
        familyVolumes.push(volume);
      } finally {
        shape.delete();
      }

      kernelRevision += 1;
      const rebuild = await headlessKernel.request({
        kind: 'rebuild',
        requestId: `standard-part-${kernelRevision}-${configuration.id}`,
        projectId: reopened.projectId,
        revision: kernelRevision,
        document: reopened,
        includeExactBrep: true,
      }, 180_000) as JsonRecord;
      const rebuildErrors = rebuild.errors as JsonRecord[] | undefined;
      check(`${configuration.id} exact document rebuild failed: ${(rebuildErrors || []).map((entry) => entry.message).join('; ')}`,
        rebuild.kind === 'rebuild-result' && Array.isArray(rebuildErrors) && rebuildErrors.length === 0);
      check(`${configuration.id} exact document rebuild lost its active configuration`,
        rebuild.configuration?.id === configuration.id);
      check(`${configuration.id} exact document rebuild did not yield one valid solid`,
        rebuild.bodies?.length === 1
        && rebuild.bodies[0].geometry?.valid === true
        && rebuild.bodies[0].geometry?.brepValid === true
        && rebuild.bodies[0].geometry?.solidCount === 1
        && rebuild.bodies[0].lastValid !== true
        && !rebuild.bodies[0].error);
      const rebuiltBody = rebuild.bodies[0];
      check(`${configuration.id} document volume differs from the controlled nominal solid`,
        closeTo(Number(rebuiltBody.geometry.volume), expectedVolume, 1e-5));
      check(`${configuration.id} document axial bound differs from the controlled nominal solid`,
        closeTo(Number(rebuiltBody.geometry.bounds[0][2]), 0)
        && closeTo(Number(rebuiltBody.geometry.bounds[1][2]), expectedHeight));
      check(`${configuration.id} canonical exact B-rep is missing`,
        typeof rebuiltBody.exactBrep === 'string' && rebuiltBody.exactBrep.length > 100);
      familyBreps.push(rebuiltBody.exactBrep);
    } catch (error) {
      throw new Error(`${configuration.id} exact kernel construction failed: ${String(error)}`);
    }
  }
  check(`${family.id} configurations do not produce distinct exact geometry`,
    new Set(familyVolumes.map((volume) => volume.toFixed(7))).size === familyVolumes.length);
  check(`${family.id} exact document configurations do not produce distinct canonical B-reps`,
    new Set(familyBreps).size === family.rows.length);
  evidence.push({
    familyId: family.id,
    standard: `${family.source.standard}:${family.source.edition}`,
    designations: family.rows.length,
    exactKernelSolids: familyVolumes.length,
    exactDocumentRebuilds: familyBreps.length,
    modelPolicy: family.modelPolicy,
  });
}

console.log(JSON.stringify({
  schema: 'partmode.standard-parts-smoke/v1',
  families: evidence,
  totalDesignations: evidence.reduce((sum, entry) => sum + entry.designations, 0),
  exactKernelSolids: evidence.reduce((sum, entry) => sum + entry.exactKernelSolids, 0),
  exactDocumentRebuilds: evidence.reduce((sum, entry) => sum + entry.exactDocumentRebuilds, 0),
  insertionPolicy: 'open-editable-family-document',
  separateCapabilityGates: {
    automaticHoleRecognitionAndFastenerStack: 'smoke:smart-fasteners',
  },
  boundedLibraryExclusions: ['modeled-helical-threads', 'manufacturing-certification'],
}, null, 2));
await headlessKernel.dispose();
headlessKernel = null;
} catch (error) {
  if (headlessKernel) await headlessKernel.dispose();
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
}
