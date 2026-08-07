import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundleUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-project-bundle.js')).href;
const projectUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-project-v5.js')).href;
const { createStudioProjectBundleManifest } = await import(bundleUrl) as any;
const { parseStudioV5Project } = await import(projectUrl) as any;
const source = JSON.parse(readFileSync(
  resolve(process.cwd(), 'tests/assembly-runtime/two-part-constrained.partmode.json'),
  'utf8',
));

const assemblyProject = parseStudioV5Project(JSON.stringify(source));
const assemblyManifest = createStudioProjectBundleManifest(assemblyProject);
assert.equal(assemblyManifest.schema, 'partmode.project-bundle/v1');
assert.equal(assemblyManifest.selfContained, true);
assert.deepEqual(assemblyManifest.root, { kind: 'assembly', definitionId: 'assembly-two-blocks' });
assert.deepEqual(assemblyManifest.partDefinitionIds, ['part-base-block', 'part-moving-block']);
assert.deepEqual(assemblyManifest.assemblyDefinitionIds, ['assembly-two-blocks']);
assert.equal(assemblyManifest.definitionEdges.length, 2);
assert.deepEqual(assemblyManifest.resourceIds, []);

const imported = structuredClone(source);
const importedPart = imported.partDefinitions[0];
const sourceFeature = importedPart.features[0];
const importedFeature = {
  id: sourceFeature.id,
  name: 'Imported exact body',
  type: 'imported-step',
  suppressed: false,
  inputRefs: [],
  resultPolicy: sourceFeature.resultPolicy,
  createdBodyId: sourceFeature.createdBodyId,
  extensions: {
  studioImportedStep: {
    resourceId: 'resource-imported-step',
    exactBrep: true,
    parametricHistory: false,
    topologyRegistry: { registryId: 'resource-imported-step' },
  },
  },
};
importedPart.features[0] = importedFeature;
imported.resources = [{
  id: 'resource-imported-step',
  name: 'Embedded exact B-rep fixture',
  mimeType: 'text/plain',
  byteLength: 3,
  encoding: 'base64',
  data: 'AQID',
  extensions: { studioImportedStep: { source: 'pack-and-go-gate' } },
}, {
  id: 'resource-shop-note',
  name: 'Bundled shop note',
  mimeType: 'text/plain',
  byteLength: 4,
  encoding: 'base64',
  data: 'bm90ZQ==',
}];

const canonicalImported = parseStudioV5Project(JSON.stringify(imported));
const importedManifest = createStudioProjectBundleManifest(canonicalImported);
assert.deepEqual(importedManifest.resourceIds, ['resource-imported-step', 'resource-shop-note']);
assert.deepEqual(importedManifest.resourceReferences, [{
  partId: importedPart.id,
  featureId: importedFeature.id,
  resourceId: 'resource-imported-step',
}]);
assert.deepEqual(importedManifest.unreferencedResourceIds, ['resource-shop-note']);

const reopened = parseStudioV5Project(JSON.stringify(canonicalImported, null, 2) + '\n');
assert.deepEqual(createStudioProjectBundleManifest(reopened), importedManifest,
  'save/reopen changed the dependency bundle manifest');
assert.equal(reopened.resources.find((resource: any) => resource.id === 'resource-imported-step')?.data, 'AQID',
  'save/reopen lost the embedded exact resource');

const reordered = structuredClone(canonicalImported);
reordered.partDefinitions.reverse();
reordered.resources.reverse();
assert.deepEqual(createStudioProjectBundleManifest(reordered), importedManifest,
  'bundle manifest changed with definition or resource declaration order');

const missingResource = structuredClone(imported);
missingResource.resources = missingResource.resources.filter((resource: any) => resource.id !== 'resource-imported-step');
assert.throws(
  () => parseStudioV5Project(JSON.stringify(missingResource)),
  (error: any) => error?.code === 'MISSING_BUNDLE_RESOURCE'
    && error?.message.includes('feature-base-extrude')
    && error?.message.includes('resource-imported-step'),
  'project validation did not fail closed on a missing bundled resource',
);

console.log(JSON.stringify({
  schema: importedManifest.schema,
  root: importedManifest.root,
  definitions: {
    parts: importedManifest.partDefinitionIds.length,
    assemblies: importedManifest.assemblyDefinitionIds.length,
    edges: importedManifest.definitionEdges.length,
  },
  resources: {
    bundled: importedManifest.resourceIds,
    referenced: importedManifest.resourceReferences.map((entry: any) => entry.resourceId),
    attachments: importedManifest.unreferencedResourceIds,
  },
  saveReopenStable: true,
  missingResourceFailsClosed: true,
}));
