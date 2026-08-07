import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonRecord = Record<string, any>;

interface ConfigurationError extends Error {
  code: string;
}

interface ConfigurationErrorCodes {
  duplicateId: string;
  duplicateName: string;
  unknownId: string;
  unknownParameter: string;
  duplicateParameter: string;
  invalidParameterValue: string;
  cyclicParameterValue: string;
  unknownFeature: string;
  duplicateFeature: string;
  invalidSuppression: string;
  invalidCsv: string;
  duplicateCsvColumn: string;
}

interface ConfigurationModule {
  STUDIO_PART_CONFIGURATION_ERROR_CODES: ConfigurationErrorCodes;
  StudioPartConfigurationError: new (...args: any[]) => ConfigurationError;
  applyStudioPartConfiguration(project: unknown, set: unknown, id?: string): JsonRecord;
  normalizeStudioPartConfigurationSet(project: unknown, set: unknown): JsonRecord;
  parseStudioPartDesignTable(source: string, options: unknown): JsonRecord;
  serializeStudioPartDesignTable(project: unknown, set: unknown): string;
  studioPartConfigurationIdFromName(name: string): string;
}

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-part-configurations.js')).href;
const configurationModule = await import(moduleUrl) as ConfigurationModule;
const {
  STUDIO_PART_CONFIGURATION_ERROR_CODES: CODES,
  StudioPartConfigurationError,
  applyStudioPartConfiguration,
  normalizeStudioPartConfigurationSet,
  parseStudioPartDesignTable,
  serializeStudioPartDesignTable,
  studioPartConfigurationIdFromName,
} = configurationModule;

const project: JsonRecord = {
  schemaVersion: 5,
  projectId: 'project-config-smoke',
  name: 'Configuration smoke',
  units: 'mm',
  parameters: [
    { id: 'parameter-global-scale', name: 'globalScale', value: 2 },
  ],
  partDefinitions: [
    {
      id: 'part-primary',
      name: 'Primary',
      parameters: [
        { id: 'parameter-width', name: 'width', value: 10 },
        { id: 'parameter-height', name: 'height', value: 5 },
        { id: 'parameter-area', name: 'area', value: 'width * height' },
      ],
      features: [
        { id: 'feature-cut', name: 'Cut', suppressed: false },
        { id: 'feature-fillet', name: 'Fillet', suppressed: false },
      ],
      featureOrder: ['feature-cut', 'feature-fillet'],
    },
    {
      id: 'part-secondary',
      name: 'Secondary',
      parameters: [
        { id: 'parameter-secondary-width', name: 'width', value: 999 },
      ],
      features: [
        { id: 'feature-secondary', name: 'Secondary feature', suppressed: false },
      ],
      featureOrder: ['feature-secondary'],
    },
  ],
  assemblyDefinitions: [],
  rootDocument: { kind: 'part', partId: 'part-primary' },
};

const configurationSet: JsonRecord = {
  partId: 'part-primary',
  activeConfigurationId: 'cfg-small',
  configurations: [
    {
      id: 'cfg-tall',
      name: 'Tall',
      parameterOverrides: { width: 8, height: 40 },
      featureSuppressionOverrides: { 'feature-fillet': false },
    },
    {
      id: 'cfg-small',
      name: 'Small',
      // Intentionally reverse insertion order. Canonical output must not care.
      parameterOverrides: { width: 20, height: 'width / globalScale' },
      featureSuppressionOverrides: { 'feature-fillet': true, 'feature-cut': false },
    },
  ],
  parameterColumns: ['width', 'height'],
  featureSuppressionColumns: ['feature-fillet', 'feature-cut'],
};

function expectCode(label: string, code: string, operation: () => unknown): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof StudioPartConfigurationError
      && (error as ConfigurationError).code === code,
    `${label}: expected ${code}`,
  );
}

const projectSnapshot = JSON.stringify(project);
const setSnapshot = JSON.stringify(configurationSet);
const normalized = normalizeStudioPartConfigurationSet(project, configurationSet);
assert.equal(JSON.stringify(project), projectSnapshot, 'normalization mutated the project');
assert.equal(JSON.stringify(configurationSet), setSnapshot, 'normalization mutated the configuration input');
assert.deepEqual(normalized.configurations.map((entry: JsonRecord) => entry.id), ['cfg-small', 'cfg-tall']);
assert.deepEqual(normalized.parameterColumns, ['height', 'width']);
assert.deepEqual(normalized.featureSuppressionColumns, ['feature-cut', 'feature-fillet']);
assert.deepEqual(Object.keys(normalized.configurations[0].parameterOverrides), ['height', 'width']);
assert.deepEqual(Object.keys(normalized.configurations[0].featureSuppressionOverrides), ['feature-cut', 'feature-fillet']);

const applied = applyStudioPartConfiguration(project, configurationSet);
assert.equal(JSON.stringify(project), projectSnapshot, 'application mutated the source project');
assert.equal(JSON.stringify(configurationSet), setSnapshot, 'application mutated the source configuration set');
assert.notEqual(applied.project, project, 'application returned the source project object');
assert.equal(applied.configuration.id, 'cfg-small');
const appliedPrimary = applied.project.partDefinitions.find((part: JsonRecord) => part.id === 'part-primary');
const appliedSecondary = applied.project.partDefinitions.find((part: JsonRecord) => part.id === 'part-secondary');
assert.equal(appliedPrimary.parameters.find((parameter: JsonRecord) => parameter.name === 'width').value, 20);
assert.equal(appliedPrimary.parameters.find((parameter: JsonRecord) => parameter.name === 'height').value, 'width / globalScale');
assert.equal(appliedPrimary.parameters.find((parameter: JsonRecord) => parameter.name === 'area').value, 'width * height');
assert.equal(appliedPrimary.features.find((feature: JsonRecord) => feature.id === 'feature-cut').suppressed, false);
assert.equal(appliedPrimary.features.find((feature: JsonRecord) => feature.id === 'feature-fillet').suppressed, true);
assert.equal(appliedSecondary.parameters[0].value, 999, 'configuration leaked into another part with the same parameter name');
assert.equal(applied.project.parameters[0].value, 2, 'configuration changed a project-level parameter');

const explicit = applyStudioPartConfiguration(project, configurationSet, 'cfg-tall');
const explicitPrimary = explicit.project.partDefinitions.find((part: JsonRecord) => part.id === 'part-primary');
assert.equal(explicitPrimary.parameters.find((parameter: JsonRecord) => parameter.name === 'height').value, 40);
assert.equal(explicitPrimary.features.find((feature: JsonRecord) => feature.id === 'feature-fillet').suppressed, false);
const parenthesized = normalizeStudioPartConfigurationSet(project, {
  ...configurationSet,
  configurations: [{
    id: 'cfg-parenthesized',
    name: 'Parenthesized',
    parameterOverrides: { width: '(height + globalScale) * 2' },
  }],
  activeConfigurationId: 'cfg-parenthesized',
});
assert.equal(parenthesized.configurations[0].parameterOverrides.width, '(height + globalScale) * 2');
expectCode('exact configuration ID lookup', CODES.unknownId, () => {
  applyStudioPartConfiguration(project, configurationSet, 'CFG-SMALL');
});

const reversedSet: JsonRecord = {
  featureSuppressionColumns: ['feature-cut', 'feature-fillet'],
  parameterColumns: ['height', 'width'],
  configurations: [
    {
      featureSuppressionOverrides: { 'feature-cut': false, 'feature-fillet': true },
      parameterOverrides: { height: 'width / globalScale', width: 20 },
      name: 'Small',
      id: 'cfg-small',
    },
    {
      featureSuppressionOverrides: { 'feature-fillet': false },
      parameterOverrides: { height: 40, width: 8 },
      name: 'Tall',
      id: 'cfg-tall',
    },
  ],
  activeConfigurationId: 'cfg-small',
  partId: 'part-primary',
};
assert.deepEqual(
  normalizeStudioPartConfigurationSet(project, reversedSet),
  normalized,
  'normalization depends on object, column, or configuration insertion order',
);
assert.deepEqual(
  applyStudioPartConfiguration(project, reversedSet),
  applied,
  'application depends on configuration map insertion order',
);
assert.equal(
  serializeStudioPartDesignTable(project, reversedSet),
  serializeStudioPartDesignTable(project, configurationSet),
  'CSV serialization depends on insertion order',
);

expectCode('duplicate configuration ID', CODES.duplicateId, () => {
  normalizeStudioPartConfigurationSet(project, {
    ...configurationSet,
    configurations: [configurationSet.configurations[0], { ...configurationSet.configurations[1], id: 'cfg-tall' }],
  });
});
expectCode('duplicate configuration name', CODES.duplicateName, () => {
  normalizeStudioPartConfigurationSet(project, {
    ...configurationSet,
    configurations: [configurationSet.configurations[0], { ...configurationSet.configurations[1], name: 'Tall' }],
  });
});
expectCode('unknown active configuration ID', CODES.unknownId, () => {
  normalizeStudioPartConfigurationSet(project, { ...configurationSet, activeConfigurationId: 'cfg-missing' });
});
expectCode('global parameter cannot be a part override target', CODES.unknownParameter, () => {
  normalizeStudioPartConfigurationSet(project, {
    ...configurationSet,
    configurations: [{ id: 'cfg-bad', name: 'Bad', parameterOverrides: { globalScale: 4 } }],
    activeConfigurationId: 'cfg-bad',
  });
});
expectCode('duplicate parameter override', CODES.duplicateParameter, () => {
  normalizeStudioPartConfigurationSet(project, {
    ...configurationSet,
    configurations: [{
      id: 'cfg-bad',
      name: 'Bad',
      parameterOverrides: [
        { parameterName: 'width', value: 1 },
        { parameterName: 'width', value: 2 },
      ],
    }],
    activeConfigurationId: 'cfg-bad',
  });
});
for (const [label, value] of [
  ['NaN', Number.NaN],
  ['positive infinity', Number.POSITIVE_INFINITY],
  ['empty expression', ''],
  ['unsupported expression', 'width ** 2'],
  ['non-finite expression', '1 / 0'],
] as const) {
  expectCode(label, CODES.invalidParameterValue, () => {
    normalizeStudioPartConfigurationSet(project, {
      ...configurationSet,
      configurations: [{ id: 'cfg-bad', name: 'Bad', parameterOverrides: { width: value } }],
      activeConfigurationId: 'cfg-bad',
    });
  });
}
expectCode('cyclic parameter overrides', CODES.cyclicParameterValue, () => {
  normalizeStudioPartConfigurationSet(project, {
    ...configurationSet,
    configurations: [{
      id: 'cfg-cycle',
      name: 'Cycle',
      parameterOverrides: { width: 'height', height: 'width' },
    }],
    activeConfigurationId: 'cfg-cycle',
  });
});
expectCode('unknown feature override', CODES.unknownFeature, () => {
  normalizeStudioPartConfigurationSet(project, {
    ...configurationSet,
    configurations: [{ id: 'cfg-bad', name: 'Bad', featureSuppressionOverrides: { 'feature-missing': true } }],
    activeConfigurationId: 'cfg-bad',
  });
});
expectCode('duplicate feature override', CODES.duplicateFeature, () => {
  normalizeStudioPartConfigurationSet(project, {
    ...configurationSet,
    configurations: [{
      id: 'cfg-bad',
      name: 'Bad',
      featureSuppressionOverrides: [
        { featureId: 'feature-cut', suppressed: true },
        { featureId: 'feature-cut', suppressed: false },
      ],
    }],
    activeConfigurationId: 'cfg-bad',
  });
});
expectCode('invalid feature suppression value', CODES.invalidSuppression, () => {
  normalizeStudioPartConfigurationSet(project, {
    ...configurationSet,
    configurations: [{ id: 'cfg-bad', name: 'Bad', featureSuppressionOverrides: { 'feature-cut': 1 } }],
    activeConfigurationId: 'cfg-bad',
  });
});

const quotedName = 'Pilot, "quoted"\nline';
const csvSet: JsonRecord = {
  partId: 'part-primary',
  activeConfigurationId: 'cfg-plain',
  configurations: [
    {
      id: 'cfg-quoted',
      name: quotedName,
      parameterOverrides: { width: 17.5, height: 'width / globalScale' },
      featureSuppressionOverrides: { 'feature-fillet': true },
    },
    {
      id: 'cfg-plain',
      name: 'Plain',
      parameterOverrides: { width: 9 },
      featureSuppressionOverrides: { 'feature-cut': false },
    },
  ],
  parameterColumns: ['width', 'height'],
  featureSuppressionColumns: ['feature-fillet', 'feature-cut'],
};
const csv = serializeStudioPartDesignTable(project, csvSet);
assert.ok(csv.endsWith('\r\n'), 'CSV does not use a deterministic final CRLF');
assert.ok(csv.startsWith(
  'Configuration,height,width,feature:feature-cut:suppressed,feature:feature-fillet:suppressed\r\n',
), 'CSV columns are not canonical');
assert.ok(csv.includes('"Pilot, ""quoted""\nline"'), 'CSV did not RFC4180-quote comma, quote, and newline content');

const csvSnapshot = csv;
const parsed = parseStudioPartDesignTable(csv, {
  project,
  partId: 'part-primary',
  activeConfigurationId: 'cfg-plain',
  configurationIdsByName: new Map([
    ['Plain', 'cfg-plain'],
    [quotedName, 'cfg-quoted'],
  ]),
});
assert.equal(csv, csvSnapshot, 'CSV parsing mutated its source string');
assert.deepEqual(parsed, normalizeStudioPartConfigurationSet(project, csvSet), 'CSV did not round-trip its configuration set');
assert.equal(serializeStudioPartDesignTable(project, parsed), csv, 'CSV serialize/parse/serialize is not byte deterministic');

const generated = parseStudioPartDesignTable(
  'Configuration,width,feature:feature-cut:suppressed\r\nBeta,12,true\r\nAlpha,8,false\r\n',
  { project, partId: 'part-primary' },
);
const generatedAgain = parseStudioPartDesignTable(
  'Configuration,width,feature:feature-cut:suppressed\r\nAlpha,8,false\r\nBeta,12,true\r\n',
  { project, partId: 'part-primary' },
);
assert.deepEqual(generated, generatedAgain, 'CSV row order changes generated IDs or canonical output');
assert.equal(
  generated.configurations.find((entry: JsonRecord) => entry.name === 'Alpha').id,
  studioPartConfigurationIdFromName('Alpha'),
  'CSV-derived configuration ID is not stable',
);

expectCode('duplicate CSV header', CODES.duplicateCsvColumn, () => {
  parseStudioPartDesignTable('Configuration,width,width\r\nA,1,2\r\n', { project, partId: 'part-primary' });
});
expectCode('unknown CSV parameter', CODES.unknownParameter, () => {
  parseStudioPartDesignTable('Configuration,missing\r\nA,1\r\n', { project, partId: 'part-primary' });
});
expectCode('unknown CSV feature', CODES.unknownFeature, () => {
  parseStudioPartDesignTable('Configuration,feature:missing:suppressed\r\nA,true\r\n', { project, partId: 'part-primary' });
});
expectCode('duplicate CSV configuration name', CODES.duplicateName, () => {
  parseStudioPartDesignTable('Configuration,width\r\nA,1\r\nA,2\r\n', { project, partId: 'part-primary' });
});
expectCode('unknown CSV active configuration ID', CODES.unknownId, () => {
  parseStudioPartDesignTable('Configuration,width\r\nA,1\r\n', {
    project,
    partId: 'part-primary',
    activeConfigurationId: 'cfg-missing',
  });
});
expectCode('non-finite CSV number', CODES.invalidParameterValue, () => {
  parseStudioPartDesignTable('Configuration,width\r\nA,1e999\r\n', { project, partId: 'part-primary' });
});
expectCode('invalid CSV suppression', CODES.invalidSuppression, () => {
  parseStudioPartDesignTable('Configuration,feature:feature-cut:suppressed\r\nA,yes\r\n', {
    project,
    partId: 'part-primary',
  });
});
expectCode('unclosed CSV quote', CODES.invalidCsv, () => {
  parseStudioPartDesignTable('Configuration,width\r\n"A,1\r\n', { project, partId: 'part-primary' });
});
expectCode('CSV row width mismatch', CODES.invalidCsv, () => {
  parseStudioPartDesignTable('Configuration,width\r\nA\r\n', { project, partId: 'part-primary' });
});

console.log(JSON.stringify({
  ok: true,
  configurationCount: normalized.configurations.length,
  deterministicCsvBytes: Buffer.byteLength(csv),
  quotedCsvRoundtrip: true,
  scopedPartApplication: true,
  structuredFailureCoverage: true,
}));
