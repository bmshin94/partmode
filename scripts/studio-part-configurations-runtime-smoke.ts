import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonRecord = Record<string, any>;

interface ConfigurationError extends Error {
  code: string;
}

const runtimeUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-v5-runtime-document.js')).href;
const projectUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-project-v5.js')).href;
const configurationUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-part-configurations.js')).href;
const runtime: any = await import(runtimeUrl);
const projectBoundary: any = await import(projectUrl);
const configurationModule = await import(configurationUrl) as JsonRecord;
const CODES = configurationModule.STUDIO_PART_CONFIGURATION_ERROR_CODES as JsonRecord;
const StudioPartConfigurationError = configurationModule.StudioPartConfigurationError as new (...args: any[]) => ConfigurationError;

function expectCode(label: string, code: string, operation: () => unknown): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof StudioPartConfigurationError
      && (error as ConfigurationError).code === code,
    `${label}: expected ${code}`,
  );
}

function rootPart(project: JsonRecord): JsonRecord {
  return project.partDefinitions.find((part: JsonRecord) => part.id === project.rootDocument.partId);
}

const source: JsonRecord = {
  schemaVersion: 5,
  projectId: 'project-configuration-runtime-smoke',
  name: 'Configuration runtime smoke',
  units: 'mm',
  parameters: [],
  materials: [],
  partDefinitions: [{
    id: 'part-configured',
    name: 'Configured part',
    parameters: [{ id: 'parameter-width', name: 'width', value: 10 }],
    referenceGeometry: [],
    sketches: [],
    bodies: [{
      id: 'body-configured',
      name: 'Body',
      kind: 'solid',
      createdByFeatureId: 'feature-configured',
      featureIds: ['feature-configured'],
      visible: true,
      suppressed: false,
    }],
    bodyPatterns: [],
    features: [{
      id: 'feature-configured',
      name: 'Configured feature',
      type: 'extrude',
      suppressed: false,
      inputRefs: [],
      resultPolicy: { kind: 'new-body', bodyName: 'Body' },
      createdBodyId: 'body-configured',
      through: false,
      h: 'width',
      sketch: {
        z: 0,
        shapes: [{ kind: 'rect', x: 0, y: 0, w: 'width', h: 8 }],
      },
    }],
    featureOrder: ['feature-configured'],
    metadata: { activeBodyId: 'body-configured' },
  }],
  assemblyDefinitions: [],
  rootDocument: { kind: 'part', partId: 'part-configured' },
  resources: [],
  metadata: {},
};

const preparedWithoutSets = projectBoundary.prepareStudioV5Project(source);
assert.deepEqual(preparedWithoutSets.partConfigurationSets, [], 'missing configuration storage did not default to []');
const withoutDefault = structuredClone(preparedWithoutSets);
delete withoutDefault.partConfigurationSets;
assert.deepEqual(withoutDefault, source, 'an unconfigured document changed beyond the default storage field');
assert.equal(JSON.stringify(source).includes('partConfigurationSets'), false, 'schema preparation mutated its source');

const inputSet: JsonRecord = {
  partId: 'part-configured',
  activeConfigurationId: 'configuration-standard',
  configurations: [{
    id: 'configuration-wide',
    name: 'Wide',
    parameterOverrides: { width: 25 },
    featureSuppressionOverrides: { 'feature-configured': true },
  }, {
    id: 'configuration-standard',
    name: 'Standard',
    parameterOverrides: { width: 12 },
    featureSuppressionOverrides: { 'feature-configured': false },
  }],
};
const inputSnapshot = JSON.stringify(inputSet);
const create = runtime.createStudioV5PartConfigurationSet(preparedWithoutSets, inputSet);
assert.equal(JSON.stringify(inputSet), inputSnapshot, 'create mutated its configuration input');
assert.deepEqual(create.project.partConfigurationSets[0].configurations.map((entry: JsonRecord) => entry.id), [
  'configuration-standard',
  'configuration-wide',
]);
assert.equal(create.commandResult.commandId, 'part-configuration-set.create');
assert.equal(create.commandResult.before, null);
assert.equal(create.commandResult.undo.configurationSet, null);
assert.notEqual(create.commandResult.after, create.project.partConfigurationSets[0]);

const createdSnapshot = JSON.stringify(create.project);
create.commandResult.after.configurations[0].parameterOverrides.width = 999;
assert.equal(JSON.stringify(create.project), createdSnapshot, 'command metadata aliases the returned project');
inputSet.configurations[0].parameterOverrides.width = 777;
assert.equal(JSON.stringify(create.project), createdSnapshot, 'returned project aliases the command input');

const standardEvaluation = runtime.applyStudioV5PartConfiguration(create.project, 'part-configured');
assert.equal(JSON.stringify(create.project), createdSnapshot, 'configuration evaluation mutated the stored project');
assert.equal(rootPart(standardEvaluation.project).parameters[0].value, 12);
assert.equal(rootPart(standardEvaluation.project).features[0].suppressed, false);
assert.equal(standardEvaluation.configuration.id, 'configuration-standard');

const switched = runtime.switchStudioV5PartConfiguration(
  create.project,
  'part-configured',
  'configuration-wide',
);
assert.equal(JSON.stringify(create.project), createdSnapshot, 'switch mutated its source project');
assert.equal(switched.commandResult.metadata.previousActiveConfigurationId, 'configuration-standard');
assert.equal(switched.commandResult.metadata.activeConfigurationId, 'configuration-wide');
const wideEvaluation = runtime.applyStudioV5PartConfiguration(switched.project, 'part-configured');
assert.equal(rootPart(wideEvaluation.project).parameters[0].value, 25);
assert.equal(rootPart(wideEvaluation.project).features[0].suppressed, true);
assert.notEqual(
  JSON.stringify(rootPart(standardEvaluation.project)),
  JSON.stringify(rootPart(wideEvaluation.project)),
  'active configuration switch did not change the exact evaluated part',
);

expectCode('unknown exact configuration', CODES.unknownId, () => {
  runtime.switchStudioV5PartConfiguration(create.project, 'part-configured', 'CONFIGURATION-WIDE');
});
expectCode('unknown configuration part', CODES.unknownPart, () => {
  runtime.createStudioV5PartConfigurationSet(preparedWithoutSets, { ...inputSet, partId: 'part-missing' });
});
expectCode('duplicate configuration set command', CODES.duplicatePart, () => {
  runtime.createStudioV5PartConfigurationSet(create.project, inputSet);
});
expectCode('duplicate configuration sets at schema boundary', CODES.duplicatePart, () => {
  projectBoundary.prepareStudioV5Project({
    ...source,
    partConfigurationSets: [inputSet, { ...inputSet }],
  });
});

const update = runtime.updateStudioV5PartConfigurationSet(create.project, 'part-configured', {
  configurations: [{
    id: 'configuration-standard',
    name: 'Standard',
    parameterOverrides: { width: 14 },
    featureSuppressionOverrides: { 'feature-configured': false },
  }, {
    id: 'configuration-wide',
    name: 'Wide',
    parameterOverrides: { width: 30 },
    featureSuppressionOverrides: { 'feature-configured': true },
  }],
});
assert.equal(runtime.applyStudioV5PartConfiguration(update.project, 'part-configured').project.partDefinitions[0].parameters[0].value, 14);
assert.notEqual(update.commandResult.before, update.commandResult.undo.configurationSet);
update.commandResult.before.configurations[0].parameterOverrides.width = 555;
assert.notEqual(
  update.commandResult.undo.configurationSet.configurations[0].parameterOverrides.width,
  555,
  'undo payload aliases mutable command metadata',
);

const csv = [
  'Configuration,width,feature:feature-configured:suppressed',
  'Standard,16,false',
  'Wide,32,true',
  '',
].join('\r\n');
const importedA = runtime.importStudioV5PartDesignTable(create.project, {
  partId: 'part-configured',
  source: csv,
});
const importedB = runtime.importStudioV5PartDesignTable(create.project, {
  partId: 'part-configured',
  source: csv,
});
assert.deepEqual(importedA, importedB, 'design-table import output is not deterministic');
assert.equal(importedA.commandResult.metadata.canonicalDesignTable, csv);
assert.equal(runtime.serializeStudioV5PartDesignTable(importedA.project, 'part-configured'), csv);
assert.equal(importedA.project.partConfigurationSets[0].activeConfigurationId, 'configuration-standard');

const deleted = runtime.deleteStudioV5PartConfigurationSet(importedA.project, 'part-configured');
assert.deepEqual(deleted.project.partConfigurationSets, []);
assert.equal(deleted.commandResult.after, null);
assert.equal(deleted.commandResult.undo.configurationSet.partId, 'part-configured');

const saved = JSON.stringify(switched.project);
const reopened = projectBoundary.parseStudioV5Project(saved);
assert.equal(JSON.stringify(reopened), saved, 'save/reopen changed canonical configuration storage');
assert.deepEqual(
  runtime.applyStudioV5PartConfiguration(reopened, 'part-configured'),
  runtime.applyStudioV5PartConfiguration(switched.project, 'part-configured'),
  'save/reopen changed the exact evaluated project',
);
assert.equal(runtime.studioV5CanonicalHash(reopened), runtime.studioV5CanonicalHash(switched.project));

console.log(JSON.stringify({
  defaultStorage: preparedWithoutSets.partConfigurationSets.length,
  canonicalConfigurations: switched.project.partConfigurationSets[0].configurations.map((entry: JsonRecord) => entry.id),
  activeConfigurationId: switched.project.partConfigurationSets[0].activeConfigurationId,
  evaluatedWidth: rootPart(wideEvaluation.project).parameters[0].value,
  evaluatedSuppressed: rootPart(wideEvaluation.project).features[0].suppressed,
  deterministicRoundtrip: true,
}));
