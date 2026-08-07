import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface TopologySelection {
  owner: { kind: 'body'; id: string };
  stableId: string;
  topologySignature: Record<string, unknown>;
}

interface InteractionModule {
  cadUiTopologyStableId(topologyName: string | null, fallbackStableId: string): string;
  cadUiTopologyNameFromStableId(stableId: string): string | null;
  cadUiStoredTopologyReference(selection: TopologySelection): Record<string, unknown>;
  buildCadUiCommandTransaction(input: {
    draft: Record<string, unknown>;
    expectedRevision: number;
    transactionId: string;
  }): {
    transaction: {
      operations: Array<{ kind: string; input: Record<string, unknown> }>;
    };
  };
}

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Topology persistence smoke failed: ${name}`);
}

function sameJson(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

const interactionUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-v6-interaction.js')).href;
const interaction = await import(interactionUrl) as InteractionModule;
const studioSource = readFileSync(resolve(process.cwd(), 'src/static/studio.js'), 'utf8');
const interactionSource = readFileSync(resolve(process.cwd(), 'src/static/studio-v6-interaction.js'), 'utf8');

const edgeName = 'E(Ffeature-shaft:cap:end|Ffeature-shaft:side:profile-line-4)';
const edgeSignature = { kind: 'edge', p: [10, 0, 5], l: 20, curveType: 'LINE' };
const faceName = 'Ffeature-shaft:cap:end';
const faceSignature = { kind: 'face', p: [10, 0, 5], n: [0, 0, 1] };
const adjacentFaceName = 'Ffeature-shaft:side:profile-line-4';
const adjacentFaceSignature = { kind: 'face', p: [10, 5, 0], n: [0, 1, 0] };

const edgeStableId = interaction.cadUiTopologyStableId(edgeName, 'edge:fallback');
check('short persistent name is encoded through stableId', edgeStableId === `n:${edgeName}`);
check('short persistent name decodes from stableId', interaction.cadUiTopologyNameFromStableId(edgeStableId) === edgeName);

const longName = `Ffeature-long:${'side-segment/'.repeat(30)}`;
const longStableId = interaction.cadUiTopologyStableId(longName, 'face:fallback');
check('long persistent name stableId stays inside the public schema bound', longStableId.length <= 200);
check('long persistent name uses the internal registry form', longStableId.startsWith('nh:'));
check('long persistent name decodes through the internal registry', interaction.cadUiTopologyNameFromStableId(longStableId) === longName);

const namedEdgeSelection: TopologySelection = {
  owner: { kind: 'body', id: 'body-shaft' },
  stableId: edgeStableId,
  topologySignature: edgeSignature,
};
const namedFaceSelection: TopologySelection = {
  owner: { kind: 'body', id: 'body-shaft' },
  stableId: interaction.cadUiTopologyStableId(faceName, 'face:fallback'),
  topologySignature: faceSignature,
};
const adjacentFaceSelection: TopologySelection = {
  owner: { kind: 'body', id: 'body-shaft' },
  stableId: interaction.cadUiTopologyStableId(adjacentFaceName, 'face:adjacent-fallback'),
  topologySignature: adjacentFaceSignature,
};
const unnamedEdgeSelection: TopologySelection = {
  owner: { kind: 'body', id: 'body-shaft' },
  stableId: 'edge:fallback',
  topologySignature: edgeSignature,
};

check(
  'named selection serializes to a name and signature wrapper',
  sameJson(interaction.cadUiStoredTopologyReference(namedEdgeSelection), {
    name: edgeName,
    sig: { p: [10, 0, 5], l: 20, curveType: 'LINE' },
  }),
);
try {
  interaction.cadUiStoredTopologyReference(unnamedEdgeSelection);
  throw new Error('unnamed topology was accepted');
} catch (error: any) {
  check(
    'new unnamed selections fail closed',
    error?.code === 'TOPOLOGY_PERSISTENCE_REQUIRED',
  );
}

const bodySelection = { kind: 'body', id: 'body-shaft' };
const neutralPlaneSelection = { kind: 'datum', id: 'datum-origin-xy' };

function commandInput(
  commandId: string,
  inputValues: Record<string, unknown>,
  boundSelections: Record<string, unknown[]>,
): Record<string, unknown> {
  const built = interaction.buildCadUiCommandTransaction({
    draft: {
      commandId,
      draftId: `draft-${commandId}`,
      baseRevision: 7,
      inputValues,
      boundSelections,
      generatedIds: { featureId: `feature-${commandId}` },
    },
    expectedRevision: 7,
    transactionId: `transaction-${commandId}`,
  });
  const operation = built.transaction.operations.at(-1);
  check(`${commandId} creates an operation`, operation);
  return operation.input;
}

const filletInput = commandInput('model.fillet', { radius: 2, tangentPropagation: true }, { edges: [namedEdgeSelection] });
check('V6 fillet preserves named edge wrapper', sameJson(filletInput.edges, [
  { name: edgeName, sig: { p: [10, 0, 5], l: 20, curveType: 'LINE' } },
]));
check('V6 fillet preserves tangent-chain intent', filletInput.tangentPropagation === true);

const chamferInput = commandInput('model.chamfer', { radius: 2 }, { edges: [namedEdgeSelection] });
check('V6 chamfer preserves named edge wrapper', sameJson(chamferInput.edges, filletInput.edges));

const shellInput = commandInput('model.shell', { thickness: 2 }, {
  body: [bodySelection],
  faces: [namedFaceSelection],
});
check('V6 shell preserves named face wrapper', sameJson(shellInput.faces, [
  { name: faceName, sig: { p: [10, 0, 5], n: [0, 0, 1] } },
]));

const draftInput = commandInput('model.draft', {
  name: 'Draft',
  angle: 5,
  flip: false,
  tangentPropagation: false,
}, {
  body: [bodySelection],
  neutralPlane: [neutralPlaneSelection],
  faces: [namedFaceSelection],
});
check('V6 draft preserves named face wrapper', sameJson(draftInput.faceRefs, shellInput.faces));

const thickenInput = commandInput('model.thicken', {
  name: 'Thicken',
  bodyName: 'Thickened shaft',
  thickness: 1,
  symmetric: false,
  flip: false,
}, {
  body: [bodySelection],
  faces: [namedFaceSelection],
});
check('V6 thicken preserves named face wrapper', sameJson(thickenInput.faceRefs, shellInput.faces));

const variableFilletInput = commandInput('model.variable-fillet', {
  name: 'Variable fillet',
  startRadius: 1,
  endRadius: 3,
  tangentPropagation: false,
}, {
  body: [bodySelection],
  edges: [namedEdgeSelection],
});
check('V6 variable fillet preserves named edge wrapper', sameJson(variableFilletInput.edgeRefs, filletInput.edges));

const faceFilletInput = commandInput('model.face-fillet', {
  name: 'Face fillet',
  radius: 2,
}, {
  body: [bodySelection],
  faces: [namedFaceSelection, adjacentFaceSelection],
});
check('V6 face fillet preserves both named face wrappers', sameJson(faceFilletInput.faceRefs, [
  { name: faceName, sig: { p: [10, 0, 5], n: [0, 0, 1] } },
  { name: adjacentFaceName, sig: { p: [10, 5, 0], n: [0, 1, 0] } },
]));

const subshapeSchemaStart = interactionSource.indexOf('const SUBSHAPE_REF_SCHEMA =');
const subshapeSchemaEnd = interactionSource.indexOf('const SELECTION_REF_SCHEMA', subshapeSchemaStart);
const subshapeSchema = interactionSource.slice(subshapeSchemaStart, subshapeSchemaEnd);
check('public subshape schema remains closed', subshapeSchema.includes('additionalProperties: false'));
check('public subshape schema does not expose a topology name field', !subshapeSchema.includes('name:'));
check('face inventory derives stableId from serialized name', studioSource.includes('cadUiTopologyStableId(face.name,'));
check('edge inventory derives stableId from serialized name', studioSource.includes('cadUiTopologyStableId(entry.name,'));
check('vertex inventory derives stableId from serialized name', studioSource.includes('cadUiTopologyStableId(vertex.name,'));
check('assembly mate face options retain the persistent topology name',
  studioSource.includes('const persistentTopologyName = topologyNameOf(face);')
    && studioSource.includes('...(persistentTopologyName ? { name: persistentTopologyName } : {})'));
check('assembly mate semantic edit restores the stored topology name into stableId',
  studioSource.includes('cadUiTopologyStableId(stored.semanticPath?.name, fallbackStableId)'));
check('advanced human mate pickers are bounded to occurrence origins and role datums',
  studioSource.includes('const advancedReferenceOptions = (datumKinds)')
    && studioSource.includes("entry.referenceKind === 'origin' || datumKinds.includes(entry.referenceKind)")
    && studioSource.includes("advancedReferenceOptions(['axis'])")
    && studioSource.includes("advancedReferenceOptions(['plane'])"));
check('advanced human path picker separates exact sketches from supported follower frames',
  studioSource.includes("const pathOptions = references.filter((entry) => entry.referenceKind === 'path')")
    && studioSource.includes("advancedReferenceOptions(['plane', 'axis'])"));
check('internal topology names are stripped from public inventory', studioSource.includes('({ _topologyName, _runtimeBodyId, _faceId, _line, _entry, _point, ...entry })'));
check('unnamed topology is excluded from the agent inventory', studioSource.includes('.filter((entry) => Boolean(entry._topologyName))'));
check('named topology identity ignores stale signature snapshots', studioSource.includes('return Boolean(topologyName) ||'));
check('advanced face and edge choices retain live wrappers', studioSource.includes('.map(topologyReferenceForLive)'));
check('classic edge picker snapshot retains wrappers', studioSource.includes('next.edges = selections.map(v6StoredTopologyReference);'));
check('classic shell picker snapshot retains wrappers', studioSource.includes('next.faces = selections.map(v6StoredTopologyReference);'));
check('sketch support face retains wrapper', studioSource.includes('feature.onFace = v6StoredTopologyReference(ref);'));

console.log(JSON.stringify({
  stableIds: { named: edgeStableId, long: longStableId, unnamed: 'rejected' },
  commands: ['fillet', 'chamfer', 'shell', 'draft', 'thicken', 'variable-fillet', 'face-fillet'],
  classicPickers: ['edge', 'shell', 'support-face'],
  publicSchemaFields: ['owner', 'stableId', 'topologySignature', 'expectedGeometry'],
}));
