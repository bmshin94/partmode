import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonRecord = Record<string, any>;

const runtimeUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-v5-runtime-document.js')).href;
const projectUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-project-v5.js')).href;
const runtime: any = await import(runtimeUrl);
const projectBoundary: any = await import(projectUrl);

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const targetSource: JsonRecord = {
  schemaVersion: 5,
  projectId: 'project-target',
  name: 'Target assembly',
  units: 'mm',
  parameters: [],
  materials: [{ id: 'material-shared', name: 'Target material', appearanceId: 'appearance-shared' }],
  partDefinitions: [{
    id: 'part-source',
    name: 'Target base',
    parameters: [],
    referenceGeometry: [],
    sketches: [],
    bodies: [{
      id: 'body-shared', name: 'Target body', kind: 'solid', createdByFeatureId: 'feature-shared',
      featureIds: ['feature-shared'], visible: true, suppressed: false, materialId: 'material-shared',
    }],
    bodyPatterns: [],
    features: [{
      id: 'feature-shared', name: 'Target extrude', type: 'extrude', suppressed: false, inputRefs: [],
      resultPolicy: { kind: 'new-body', bodyName: 'Target body' }, createdBodyId: 'body-shared',
      through: false, h: 5, sketch: { z: 0, shapes: [{ id: 'shape-shared', kind: 'rect', x: 0, y: 0, w: 10, h: 10 }] },
    }],
    featureOrder: ['feature-shared'],
    metadata: { activeBodyId: 'body-shared' },
  }],
  assemblyDefinitions: [{
    id: 'assembly-target',
    name: 'Target assembly',
    parameters: [],
    occurrences: [{
      id: 'occurrence-target', name: 'Target base:1', definition: { kind: 'part', partId: 'part-source' },
      baseTransform: identity, fixed: true, suppressed: false, visible: true,
    }],
    mates: [], occurrencePatterns: [], explodedViews: [], sectionViews: [],
  }],
  rootDocument: { kind: 'assembly', assemblyId: 'assembly-target' },
  resources: [{ id: 'resource-shared', name: 'Target resource', mimeType: 'text/plain', byteLength: 0 }],
  metadata: {},
};

const sourcePartProject: JsonRecord = {
  schemaVersion: 5,
  projectId: 'project-source',
  name: 'Saved source part',
  units: 'mm',
  parameters: [
    { id: 'parameter-global-base', name: 'global_base', value: 10 },
    { id: 'parameter-global-derived', name: 'global_derived', value: 'global_base * 2' },
  ],
  materials: [
    { id: 'material-shared', name: 'Imported alloy', densityKgM3: 2700, appearanceId: 'appearance-shared' },
    { id: 'material-unused', name: 'Unused material' },
  ],
  partDefinitions: [{
    id: 'part-source',
    name: 'Saved source part',
    parameters: [
      { id: 'parameter-global-copy', name: 'global_copy', value: 'global_base' },
      { id: 'parameter-local-height', name: 'local_height', value: 'global_derived + 5' },
    ],
    referenceGeometry: [{
      id: 'global_base', name: 'global_base', kind: 'plane', suppressed: false,
      definition: { origin: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
    }, {
      id: 'name', name: 'Schema key collision datum', kind: 'plane', suppressed: false,
      definition: { mode: 'offset', referenceDatumId: 'global_base', offset: 5, flipNormal: false },
    }],
    sketches: [{
      id: 'sketch-imported', name: 'Imported editable sketch', support: null,
      entities: [{ id: 'entity-line', kind: 'line', a: [0, 0], b: [10, 0] }],
      groups: [{ id: 'group-profile', kind: 'profile', entityIds: ['entity-line'] }],
      constraints: [{
        id: 'constraint-horizontal', kind: 'horizontal', refs: [{ entityId: 'entity-line' }], driving: false,
      }],
    }],
    bodies: [{
      id: 'body-shared', name: 'body-shared', kind: 'solid', createdByFeatureId: 'feature-shared',
      featureIds: ['feature-shared'], visible: true, suppressed: false,
      materialId: 'material-shared', appearanceId: 'appearance-shared',
    }, {
      id: 'body-tool', name: 'Split tool', kind: 'solid', createdByFeatureId: 'feature-tool',
      featureIds: ['feature-tool'], visible: true, suppressed: false,
    }],
    bodyPatterns: [],
    features: [{
      id: 'feature-shared', name: 'Imported exact body', type: 'imported-step', suppressed: false, inputRefs: [],
      resultPolicy: { kind: 'new-body', bodyName: 'Imported exact body' }, createdBodyId: 'body-shared',
      extensions: {
        studioImportedStep: {
          resourceId: 'resource-shared', exactBrep: true, parametricHistory: false,
          topologyRegistry: { registryId: 'resource-shared' },
        },
      },
    }, {
      id: 'feature-tool', name: 'Split tool', type: 'extrude', suppressed: false, inputRefs: [],
      resultPolicy: { kind: 'new-body', bodyName: 'Split tool' }, createdBodyId: 'body-tool',
      through: false, h: 5,
      sketch: { z: 0, shapes: [{ id: 'shape-tool', kind: 'rect', x: 2, y: 2, w: 4, h: 4 }] },
    }],
    featureOrder: ['feature-shared', 'feature-tool'],
    metadata: { activeBodyId: 'body-shared' },
    extensions: {
      partmodeDrawing: {
        configurationData: {
          'configuration-standard': { label: 'configuration-standard' },
        },
      },
    },
  }],
  assemblyDefinitions: [],
  rootDocument: { kind: 'part', partId: 'part-source' },
  resources: [
    {
      id: 'resource-shared', name: 'Imported exact B-rep', mimeType: 'text/plain', byteLength: 0,
      extensions: { studioImportedStep: { topologyRegistry: { registryId: 'resource-shared' } } },
    },
    { id: 'resource-unused', name: 'Unused resource', mimeType: 'text/plain', byteLength: 0 },
  ],
  metadata: {},
  partConfigurationSets: [{
    partId: 'part-source',
    activeConfigurationId: 'configuration-standard',
    configurations: [{
      id: 'configuration-standard', name: 'Standard',
      parameterOverrides: { local_height: 30 },
      featureSuppressionOverrides: { 'feature-shared': false },
    }],
  }],
};

const target = projectBoundary.prepareStudioV5Project(targetSource);
const source = runtime.createStudioV5BooleanSplit(
  projectBoundary.prepareStudioV5Project(sourcePartProject),
  { id: 'split-operation', targetBodyId: 'body-shared', toolBodyId: 'body-tool' },
);
const targetSnapshot = JSON.stringify(target);
const sourceSnapshot = JSON.stringify(source);
const imported = runtime.importStudioV5PartDefinition(target, source, {
  partId: 'part-imported',
  name: 'Imported fitting',
});

assert.equal(JSON.stringify(target), targetSnapshot, 'part import mutated the target project');
assert.equal(JSON.stringify(source), sourceSnapshot, 'part import mutated the source project');
assert.deepEqual(imported.rootDocument, target.rootDocument, 'part import replaced the active assembly');
assert.equal(imported.partDefinitions.length, target.partDefinitions.length + 1, 'part import did not add exactly one definition');
assert.equal(imported.assemblyDefinitions[0].occurrences.length, 1, 'part import added an occurrence before the caller requested one');

const importedPart = imported.partDefinitions.find((part: JsonRecord) => part.id === 'part-imported');
assert(importedPart, 'imported part definition is missing');
assert.equal(importedPart.name, 'Imported fitting', 'imported part name override was ignored');
assert.deepEqual(
  importedPart.parameters.map((parameter: JsonRecord) => [parameter.name, parameter.value]),
  [['global_base', 10], ['global_derived', 20], ['global_copy', 'global_base'], ['local_height', 'global_derived + 5']],
  'source project parameters were not localized at their exact evaluated values',
);
assert.equal(importedPart.bodies[0].name, 'body-shared', 'a human-readable name equal to an owned ID was remapped');
assert.equal(importedPart.referenceGeometry[0].name, 'global_base', 'a datum name equal to a parameter name was remapped');
assert.notEqual(importedPart.referenceGeometry[0].id, 'global_base', 'the colliding owned datum ID was not remapped');
assert.equal(importedPart.referenceGeometry[1].name, 'Schema key collision datum', 'an owned ID rewrote arbitrary schema keys');
assert.equal(importedPart.referenceGeometry[1].definition.referenceDatumId, importedPart.referenceGeometry[0].id,
  'derived datum reference was not remapped');
assert.equal(importedPart.sketches[0].groups[0].entityIds[0], importedPart.sketches[0].entities[0].id,
  'sketch group entity reference was not remapped');
assert.equal(importedPart.sketches[0].constraints[0].refs[0].entityId, importedPart.sketches[0].entities[0].id,
  'sketch constraint entity reference was not remapped');
assert.notEqual(importedPart.bodies[0].id, 'body-shared', 'body ID collided with the target project');
assert.notEqual(importedPart.features[0].id, 'feature-shared', 'feature ID collided with the target project');
const importedSplitFeatures = importedPart.features.filter((feature: JsonRecord) => feature.type === 'boolean-split-side');
assert.equal(importedSplitFeatures.length, 2, 'Boolean Split feature pair was not imported');
assert.equal(new Set(importedSplitFeatures.map((feature: JsonRecord) => feature.operationId)).size, 1,
  'Boolean Split operation identity diverged during import');
assert.notEqual(importedSplitFeatures[0].operationId, 'split-operation',
  'Boolean Split operation identity was not remapped');

const importedMaterial = imported.materials.find((material: JsonRecord) => material.id === importedPart.bodies[0].materialId);
assert(importedMaterial, 'referenced material was not imported');
assert.equal(importedMaterial.name, 'Imported alloy');
assert.notEqual(importedMaterial.id, 'material-shared', 'material ID collided with the target project');
assert.notEqual(importedMaterial.appearanceId, 'appearance-shared', 'appearance ID collided with the target project');
assert.equal(imported.materials.some((material: JsonRecord) => material.name === 'Unused material'), false, 'unreferenced material was imported');

const importedResourceId = importedPart.features[0].extensions.studioImportedStep.resourceId;
const importedResource = imported.resources.find((resource: JsonRecord) => resource.id === importedResourceId);
assert(importedResource, 'referenced exact-geometry resource was not imported');
assert.equal(importedResource.name, 'Imported exact B-rep');
assert.notEqual(importedResource.id, 'resource-shared', 'resource ID collided with the target project');
assert.equal(imported.resources.some((resource: JsonRecord) => resource.name === 'Unused resource'), false, 'unreferenced resource was imported');

const importedConfiguration = imported.partConfigurationSets.find((entry: JsonRecord) => entry.partId === 'part-imported');
assert(importedConfiguration, 'source part configuration set was not imported');
assert.equal(
  importedConfiguration.activeConfigurationId,
  importedConfiguration.configurations[0].id,
  'active configuration reference was not remapped',
);
assert.deepEqual(
  Object.keys(importedConfiguration.configurations[0].featureSuppressionOverrides),
  [importedPart.features[0].id],
  'configuration feature references were not remapped',
);
assert.deepEqual(
  importedConfiguration.featureSuppressionColumns,
  [importedPart.features[0].id],
  'configuration feature columns were not remapped',
);
assert.deepEqual(
  Object.keys(importedPart.extensions.partmodeDrawing.configurationData),
  [importedConfiguration.configurations[0].id],
  'drawing configuration map keys were not remapped',
);
assert.equal(
  importedPart.extensions.partmodeDrawing.configurationData[importedConfiguration.configurations[0].id].label,
  'configuration-standard',
  'drawing configuration human strings were remapped',
);
assert.equal(
  importedResource.extensions.studioImportedStep.topologyRegistry.registryId,
  importedResource.id,
  'exact resource topology registry reference was not remapped',
);
assert.equal(
  importedPart.features[0].extensions.studioImportedStep.topologyRegistry.registryId,
  importedResource.id,
  'exact feature topology registry reference was not remapped',
);

const withOccurrence = runtime.createStudioV5ComponentOccurrence(imported, {
  id: 'occurrence-imported',
  name: 'Imported fitting:1',
  definition: { kind: 'part', partId: 'part-imported' },
  baseTransform: identity,
});
assert.equal(withOccurrence.assemblyDefinitions[0].occurrences.length, 2, 'imported definition could not be inserted');
assert.deepEqual(
  withOccurrence.assemblyDefinitions[0].occurrences[1].definition,
  { kind: 'part', partId: 'part-imported' },
);
const reopened = projectBoundary.parseStudioV5Project(JSON.stringify(withOccurrence));
assert.equal(
  runtime.studioV5CanonicalHash(reopened),
  runtime.studioV5CanonicalHash(withOccurrence),
  'save/reopen changed the imported assembly',
);

const twice = runtime.importStudioV5PartDefinition(imported, source, { partId: 'part-imported-two' });
const secondPart = twice.partDefinitions.find((part: JsonRecord) => part.id === 'part-imported-two');
assert(secondPart, 'second import is missing');
assert.notEqual(secondPart.features[0].id, importedPart.features[0].id, 'repeated imports reused a feature ID');
assert.notEqual(secondPart.bodies[0].id, importedPart.bodies[0].id, 'repeated imports reused a body ID');

assert.throws(
  () => runtime.importStudioV5PartDefinition(target, source, { partId: 'part-source' }),
  /already in use/,
  'target part ID collision did not fail closed',
);
const inchSource = structuredClone(source);
inchSource.units = 'in';
assert.throws(
  () => runtime.importStudioV5PartDefinition(target, inchSource, { partId: 'part-inch' }),
  /units must match/,
  'unit mismatch did not fail closed',
);
assert.throws(
  () => runtime.importStudioV5PartDefinition(target, target, { partId: 'part-from-assembly' }),
  /active document is a part/,
  'assembly-root source did not fail closed',
);
const missingResource = structuredClone(source);
missingResource.resources = [];
assert.throws(
  () => runtime.importStudioV5PartDefinition(target, missingResource, { partId: 'part-missing-resource' }),
  /missing its exact imported-geometry resource|absent from the project bundle/,
  'missing exact-geometry resource did not fail closed',
);
const assemblyContextSource = structuredClone(source);
assemblyContextSource.assemblyDefinitions = [{
  id: 'assembly-source-context',
  name: 'Source context',
  parameters: [],
  occurrences: [{
    id: 'occurrence-source-context', name: 'Saved source part:1',
    definition: { kind: 'part', partId: 'part-source' }, baseTransform: identity,
    fixed: true, suppressed: false, visible: true,
  }],
  mates: [], occurrencePatterns: [], explodedViews: [], sectionViews: [],
}];
assemblyContextSource.partDefinitions[0].features[0].inputRefs = [{
  ownerKind: 'body',
  ownerId: 'body-shared',
  occurrencePath: ['occurrence-source-context'],
  semanticPath: { role: 'assembly-context' },
  signature: { role: 'assembly-context' },
}];
const preparedAssemblyContextSource = projectBoundary.prepareStudioV5Project(assemblyContextSource);
assert.throws(
  () => runtime.importStudioV5PartDefinition(target, preparedAssemblyContextSource, { partId: 'part-contextual' }),
  /assembly-context reference/,
  'assembly-context geometry did not fail closed',
);

console.log(JSON.stringify({
  importedPartId: importedPart.id,
  localizedParameters: importedPart.parameters.length,
  importedMaterialId: importedMaterial.id,
  importedResourceId: importedResource.id,
  occurrenceCount: withOccurrence.assemblyDefinitions[0].occurrences.length,
  repeatImportPartId: secondPart.id,
}, null, 2));
