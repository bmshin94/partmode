import assert from 'node:assert/strict';

import {
  STUDIO_V5_FEATURE_CONTRACTS,
  STUDIO_V5_FEATURE_TYPES,
  assertStudioV5FeatureStructure,
  assertStudioV5FeatureType,
  isStudioV5FeatureResultPolicy,
  isStudioV5FeatureType,
  studioV5FeatureContract,
} from '../src/static/studio-v5-feature-types.js';
import {
  createStudioV5PartProject,
  parseStudioV5Project,
  prepareStudioV5Project,
} from '../src/static/studio-project-v5.js';
import { STUDIO_TEMPLATES } from '../src/static/studio-templates.js';
import { setStudioExactTangentFilletPolicy } from '../src/static/studio-kernel-robustness.js';

const expectedTypes = [
  'boolean',
  'boolean-split-side',
  'chamfer',
  'cut',
  'direct-edit',
  'draft',
  'extrude',
  'fillet',
  'imported-step',
  'loft',
  'revolve',
  'sheet-metal-flange',
  'shell',
  'sweep',
  'thicken',
  'thread',
  'transform',
  'weld-bead',
  'weldment-treatment',
];

assert.deepEqual(STUDIO_V5_FEATURE_TYPES, expectedTypes);
assert.deepEqual(Object.keys(STUDIO_V5_FEATURE_CONTRACTS).sort(), [...expectedTypes].sort());
for (const type of expectedTypes) {
  assert.equal(isStudioV5FeatureType(type), true, type + ' is missing from the feature registry');
  assert.deepEqual(studioV5FeatureContract(type), STUDIO_V5_FEATURE_CONTRACTS[type]);
  assert.equal(assertStudioV5FeatureType(type), type);
}
assert.equal(isStudioV5FeatureType('unknown'), false);
assert.throws(() => assertStudioV5FeatureType('unknown'), /unsupported/iu);

for (const [type, contract] of Object.entries(STUDIO_V5_FEATURE_CONTRACTS)) {
  for (const kind of contract.resultPolicyKinds) {
    assert.equal(isStudioV5FeatureResultPolicy(type, kind), true);
  }
}
assert.equal(isStudioV5FeatureResultPolicy('fillet', 'new-body'), false);

const starter = createStudioV5PartProject({
  projectId: 'project-current-contract',
  name: 'Current contract',
  parameters: [{ name: 'width', value: 40 }],
  features: [{
    id: 'feature-base',
    type: 'extrude',
    sketch: {
      z: 0,
      shapes: [{ kind: 'rect', x: 0, y: 0, w: 'width', h: 20 }],
    },
    h: 5,
  }, {
    id: 'feature-hole',
    type: 'cut',
    sketch: {
      z: 5,
      shapes: [{ kind: 'circle', x: 0, y: 0, r: 4 }],
    },
    h: 10,
    through: true,
  }],
});
const part = starter.partDefinitions[0];
assert.equal(starter.schemaVersion, 5);
assert.equal(starter.rootDocument.kind, 'part');
assert.equal(part.features[0].through, false);
assert.equal(part.features[0].sketch.shapes[0].id, 'feature-base-profile-1');
assert.equal(part.features[1].resultPolicy.kind, 'subtract');
assert.equal(part.bodies.length, 1);
assert.deepEqual(parseStudioV5Project(JSON.stringify(starter)), prepareStudioV5Project(starter));

assert.throws(
  () => parseStudioV5Project(JSON.stringify({ title: 'Unversioned', params: [], features: [] })),
  (error) => error?.code === 'UNSUPPORTED_SCHEMA',
);
assert.throws(
  () => parseStudioV5Project(JSON.stringify({ schemaVersion: 4, title: 'Old', params: [], features: [] })),
  (error) => error?.code === 'UNSUPPORTED_SCHEMA',
);

for (const template of STUDIO_TEMPLATES) {
  assert.equal(template.document.schemaVersion, 5, template.id + ' is not schema 5');
  const prepared = prepareStudioV5Project(template.document);
  assert.equal(prepared.projectId, template.document.projectId);
}

const baseFeature = {
  id: 'feature-contract',
  name: 'Contract feature',
  suppressed: false,
  inputRefs: [],
  resultPolicy: { kind: 'add', targetBodyIds: ['body-contract'] },
};
const strictFailures = [
  {
    label: 'controlled-twist sweep',
    feature: {
      ...baseFeature,
      type: 'sweep',
      profileSketchId: 'sketch-profile',
      pathSketchId: 'sketch-path',
      orientation: 'controlled-twist',
      referenceDirection: [0, 0, 1],
      twistAngle: 45,
      scaleEnd: 1,
      transition: 'transformed',
    },
  },
  {
    label: 'asymmetric loft continuity',
    feature: {
      ...baseFeature,
      type: 'loft',
      sections: [
        { sketchId: 'sketch-a', startIndex: 0, reversed: false },
        { sketchId: 'sketch-b', startIndex: 0, reversed: false },
      ],
      guideSketchIds: [],
      mapping: 'explicit',
      continuity: { start: 'free', end: 'tangent' },
      ruled: false,
      closed: false,
    },
  },
  {
    label: 'draft tangent intent',
    feature: {
      ...baseFeature,
      type: 'draft',
      faces: [{ ownerKind: 'feature', ownerId: 'feature-base', semanticPath: { kind: 'face' }, signature: {} }],
      neutralPlaneDatumId: 'datum-neutral',
      angle: 2,
      flip: false,
      tangentPropagation: true,
    },
  },
];
for (const entry of strictFailures) {
  assert.throws(
    () => assertStudioV5FeatureStructure(entry.feature),
    /unsupported|must match/u,
    entry.label + ' was accepted',
  );
}

const exactFillet = {
  ...baseFeature,
  type: 'fillet',
  r: 2,
  edges: [{ name: 'edge:feature-base:1' }],
  tangentPropagation: true,
};
setStudioExactTangentFilletPolicy(exactFillet, true);
assert.doesNotThrow(() => assertStudioV5FeatureStructure(exactFillet));

console.log(JSON.stringify({
  featureTypes: STUDIO_V5_FEATURE_TYPES.length,
  templates: STUDIO_TEMPLATES.length,
  schema: starter.schemaVersion,
  strictCurrentContract: true,
}, null, 2));
