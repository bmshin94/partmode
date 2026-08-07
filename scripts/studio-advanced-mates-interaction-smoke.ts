import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonRecord = Record<string, any>;

const interaction = await import(pathToFileURL(resolve(
  process.cwd(),
  'src/static/studio-v6-interaction.js',
)).href) as any;
const registry = await import(pathToFileURL(resolve(
  process.cwd(),
  'src/static/studio-v6-ui-registry.js',
)).href) as any;
const {
  buildCadUiCommandTransaction,
  cadUiNumberOrExpressionValue,
  cadUiTopologyStableId,
} = interaction;

const occurrence = (id: string): JsonRecord => ({ kind: 'occurrence', id });
const datum = (id: string): JsonRecord => ({ kind: 'datum', id });
const sketch = (id: string): JsonRecord => ({ kind: 'sketch', id });
const topology = (kind: 'face' | 'edge' | 'vertex', id: string, topologyKind: string): JsonRecord => ({
  owner: { kind: 'body', id },
  stableId: `${kind}:${id}`,
  topologySignature: {
    kind,
    p: [0, 0, 0],
    ...(kind === 'face' ? {
      topologyKind,
      n: [0, 0, 1],
      ...(['cylindrical-face', 'conical-face'].includes(topologyKind)
        ? { a: [0, 0, 0], d: [0, 0, 1], r: 1 }
        : {}),
      ...(topologyKind === 'conical-face' ? { semiAngle: Math.PI / 6 } : {}),
      ...(topologyKind === 'spherical-face' ? { c: [0, 0, 0], r: 1 } : {}),
    } : {}),
    ...(kind === 'edge' ? { l: 1, curveType: topologyKind } : {}),
  },
});

const contracts: JsonRecord[] = [
  {
    family: 'width',
    occurrences: [
      ['widthOccurrence', 'occ-width'],
      ['tabOccurrence', 'occ-tab'],
    ],
    references: [
      ['widthFirstReference', 0, 'width-first', datum('datum-width-first')],
      ['widthSecondReference', 0, 'width-second', datum('datum-width-second')],
      ['tabFirstReference', 1, 'tab-first', datum('datum-tab-first')],
      ['tabSecondReference', 1, 'tab-second', datum('datum-tab-second')],
    ],
    values: {},
  },
  {
    family: 'symmetry',
    occurrences: [
      ['symmetryFirstOccurrence', 'occ-symmetric-first'],
      ['symmetrySecondOccurrence', 'occ-symmetric-second'],
      ['symmetryPlaneOccurrence', 'occ-symmetry-plane'],
    ],
    references: [
      ['symmetryFirstReference', 0, 'symmetric-first', occurrence('occ-symmetric-first')],
      ['symmetrySecondReference', 1, 'symmetric-second', occurrence('occ-symmetric-second')],
      ['symmetryPlaneReference', 2, 'symmetry-plane', datum('datum-symmetry-plane')],
    ],
    values: {},
  },
  {
    family: 'path',
    occurrences: [
      ['pathOccurrence', 'occ-path'],
      ['followerOccurrence', 'occ-follower'],
    ],
    references: [
      ['pathReference', 0, 'path', sketch('sketch-exact-path')],
      ['followerReference', 1, 'follower', occurrence('occ-follower')],
    ],
    values: {},
  },
  {
    family: 'linear-coupler',
    occurrences: [
      ['firstOccurrence', 'occ-coupler-first'],
      ['secondOccurrence', 'occ-coupler-second'],
    ],
    references: [
      ['firstReference', 0, 'first-axis', datum('datum-first-axis')],
      ['secondReference', 1, 'second-axis', datum('datum-second-axis')],
    ],
    values: { ratio: '2 + 1', offset: '-2.5' },
  },
  {
    family: 'limit-distance',
    occurrences: [
      ['anchorOccurrence', 'occ-distance-anchor'],
      ['movingOccurrence', 'occ-distance-moving'],
    ],
    references: [
      ['anchorReference', 0, 'anchor', occurrence('occ-distance-anchor')],
      ['movingReference', 1, 'moving', occurrence('occ-distance-moving')],
    ],
    values: { minimum: '1 + 1', maximum: '6 * 2' },
  },
  {
    family: 'limit-angle',
    occurrences: [
      ['anchorOccurrence', 'occ-angle-anchor'],
      ['movingOccurrence', 'occ-angle-moving'],
    ],
    references: [
      ['anchorReference', 0, 'anchor', occurrence('occ-angle-anchor')],
      ['movingReference', 1, 'moving', occurrence('occ-angle-moving')],
    ],
    values: { minimum: '10 + 10', maximum: '90 / 2' },
  },
];

for (const contract of contracts) {
  const definition = registry.cadUiCommandDefinition(`assembly.mate.${contract.family}`);
  assert.ok(definition, `${contract.family} command is absent from the semantic registry`);
  for (const [fieldId, , role] of contract.references) {
    const field = definition.fields.find((entry: JsonRecord) => entry.id === fieldId);
    const expectedKinds = role === 'path' ? ['sketch'] : ['occurrence', 'datum'];
    assert.deepEqual(
      field?.selectionKinds,
      expectedKinds,
      `${contract.family}.${fieldId} advertises selections outside the proved advanced-mate surface`,
    );
  }
}

function draftFor(contract: JsonRecord, edit = false): JsonRecord {
  const boundSelections: JsonRecord = {};
  for (const [fieldId, occurrenceId] of contract.occurrences) {
    boundSelections[fieldId] = [occurrence(occurrenceId)];
  }
  for (const [fieldId, , , selection] of contract.references) {
    boundSelections[fieldId] = [structuredClone(selection)];
  }
  return {
    commandId: `assembly.mate.${contract.family}`,
    draftId: `draft-${contract.family}-${edit ? 'update' : 'create'}`,
    baseRevision: 7,
    inputValues: {
      name: `${contract.family} semantic mate`,
      ...structuredClone(contract.values),
    },
    boundSelections,
    generatedIds: { mateId: `mate-${contract.family}` },
    ...(edit ? { editEntity: { kind: 'mate', id: `mate-${contract.family}` } } : {}),
  };
}

function build(contract: JsonRecord, edit = false): JsonRecord {
  return buildCadUiCommandTransaction({
    draft: draftFor(contract, edit),
    expectedRevision: 7,
    transactionId: `transaction-${contract.family}-${edit ? 'update' : 'create'}`,
  }).transaction;
}

assert.equal(cadUiNumberOrExpressionValue(' 2 + driveRatio '), '2 + driveRatio',
  'semantic edit initialization did not preserve an authored expression');
assert.equal(cadUiNumberOrExpressionValue(' -2.5 '), '-2.5',
  'semantic edit initialization did not preserve authored numeric text');
assert.equal(cadUiNumberOrExpressionValue('', 7), 7,
  'semantic edit initialization did not retain its empty-field fallback');

function assertCanonicalRecord(contract: JsonRecord, record: JsonRecord): void {
  const occurrenceIds = contract.occurrences.map(([, occurrenceId]: [string, string]) => occurrenceId);
  assert.deepEqual(record.occurrenceIds, occurrenceIds, `${contract.family} occurrence order drifted`);
  assert.deepEqual(
    record.references.map((reference: JsonRecord) => reference.semanticPath.role),
    contract.references.map(([, , role]: [string, number, string]) => role),
    `${contract.family} role order drifted`,
  );
  record.references.forEach((reference: JsonRecord, index: number) => {
    const occurrenceIndex = contract.references[index]![1] as number;
    assert.equal(
      reference.occurrencePath[0],
      occurrenceIds[occurrenceIndex],
      `${contract.family} reference ${index} lost occurrence ownership`,
    );
  });
  const expectedAdvancedMate = {
    schema: 'partmode.advanced-mate/v1',
    version: 1,
    family: contract.family,
    ...contract.values,
  };
  assert.deepEqual(record.extensions, { advancedMate: expectedAdvancedMate });
  assert.equal(Object.hasOwn(record, 'value'), false, `${contract.family} leaked generic value`);
  assert.equal(Object.hasOwn(record, 'flip'), false, `${contract.family} leaked generic flip`);
}

for (const contract of contracts) {
  const create = build(contract);
  assert.equal(create.operations.length, 1);
  const createOperation = create.operations[0]!;
  assert.equal(createOperation.kind, 'mate.create');
  assert.deepEqual(
    Object.keys(createOperation.input).sort(),
    ['extensions', 'id', 'mateKind', 'name', 'occurrenceIds', 'references'],
    `${contract.family} create emitted unsupported typed-agent fields`,
  );
  assert.equal(createOperation.input.mateKind, contract.family);
  assert.equal(
    Object.hasOwn(createOperation.input, 'kind'),
    false,
    `${contract.family} create leaked update-only kind`,
  );
  assertCanonicalRecord(contract, createOperation.input);

  const update = build(contract, true);
  assert.equal(update.operations.length, 1);
  const updateOperation = update.operations[0]!;
  assert.equal(updateOperation.kind, 'mate.update');
  assert.deepEqual(Object.keys(updateOperation.input).sort(), ['mateId', 'patch']);
  assert.equal(updateOperation.input.mateId, `mate-${contract.family}`);
  assert.deepEqual(
    Object.keys(updateOperation.input.patch).sort(),
    ['extensions', 'kind', 'name', 'occurrenceIds', 'references'],
    `${contract.family} update patch is not exact`,
  );
  assert.equal(updateOperation.input.patch.kind, contract.family);
  assert.equal(Object.hasOwn(updateOperation.input.patch, 'mateKind'), false);
  assertCanonicalRecord(contract, updateOperation.input.patch);
}

const pathContract = contracts.find((entry) => entry.family === 'path')!;
const invalidPathDraft = draftFor(pathContract);
invalidPathDraft.boundSelections.pathReference = [datum('datum-not-a-path')];
assert.throws(
  () => buildCadUiCommandTransaction({
    draft: invalidPathDraft,
    expectedRevision: 7,
    transactionId: 'transaction-invalid-path-owner',
  }),
  (error: any) => error?.code === 'COMMAND_FIELD_INVALID' && /does not accept datum/i.test(error.message),
  'path mate accepted a non-sketch path selection',
);

const widthContract = contracts.find((entry) => entry.family === 'width')!;
const duplicateOccurrenceDraft = draftFor(widthContract);
duplicateOccurrenceDraft.boundSelections.tabOccurrence = [occurrence('occ-width')];
assert.throws(
  () => buildCadUiCommandTransaction({
    draft: duplicateOccurrenceDraft,
    expectedRevision: 7,
    transactionId: 'transaction-duplicate-width-occurrence',
  }),
  (error: any) => error?.code === 'COMMAND_FIELD_INVALID' && /distinct/i.test(error.message),
  'width mate accepted duplicate role occurrences',
);

const wrongOwnerDraft = draftFor(widthContract);
wrongOwnerDraft.boundSelections.widthFirstReference = [occurrence('occ-tab')];
assert.throws(
  () => buildCadUiCommandTransaction({
    draft: wrongOwnerDraft,
    expectedRevision: 7,
    transactionId: 'transaction-wrong-width-owner',
  }),
  (error: any) => error?.code === 'COMMAND_FIELD_INVALID' && /owning component/i.test(error.message),
  'width mate accepted an occurrence reference owned by the wrong role component',
);

function assertReferenceKindRejected(
  contract: JsonRecord,
  fieldId: string,
  selection: JsonRecord,
  selectionKind: string,
): void {
  const draft = draftFor(contract);
  draft.boundSelections[fieldId] = [selection];
  assert.throws(
    () => buildCadUiCommandTransaction({
      draft,
      expectedRevision: 7,
      transactionId: `transaction-invalid-${contract.family}-${selectionKind}`,
    }),
    (error: any) => error?.code === 'COMMAND_FIELD_INVALID'
      && new RegExp(`does not accept ${selectionKind}`, 'i').test(error.message),
    `${contract.family} mate accepted unsupported ${selectionKind} reference`,
  );
}

assertReferenceKindRejected(widthContract, 'widthFirstReference', sketch('sketch-not-a-width-plane'), 'sketch');
assertReferenceKindRejected(
  contracts.find((entry) => entry.family === 'symmetry')!,
  'symmetryFirstReference',
  topology('edge', 'body-symmetry', 'linear-edge'),
  'edge',
);
assertReferenceKindRejected(
  contracts.find((entry) => entry.family === 'linear-coupler')!,
  'firstReference',
  topology('vertex', 'body-coupler', 'vertex'),
  'vertex',
);
assertReferenceKindRejected(
  contracts.find((entry) => entry.family === 'limit-distance')!,
  'anchorReference',
  sketch('sketch-not-a-distance-frame'),
  'sketch',
);
assertReferenceKindRejected(
  contracts.find((entry) => entry.family === 'limit-angle')!,
  'movingReference',
  topology('edge', 'body-angle', 'circular-edge'),
  'edge',
);

assertReferenceKindRejected(
  widthContract,
  'widthFirstReference',
  topology('face', 'body-width', 'planar-face'),
  'face',
);
assertReferenceKindRejected(
  contracts.find((entry) => entry.family === 'symmetry')!,
  'symmetryPlaneReference',
  topology('face', 'body-symmetry', 'planar-face'),
  'face',
);
assertReferenceKindRejected(
  contracts.find((entry) => entry.family === 'path')!,
  'followerReference',
  topology('face', 'body-path-follower', 'planar-face'),
  'face',
);
assertReferenceKindRejected(
  contracts.find((entry) => entry.family === 'linear-coupler')!,
  'firstReference',
  topology('face', 'body-coupler', 'cylindrical-face'),
  'face',
);
assertReferenceKindRejected(
  contracts.find((entry) => entry.family === 'limit-distance')!,
  'anchorReference',
  topology('face', 'body-distance', 'planar-face'),
  'face',
);
assertReferenceKindRejected(
  contracts.find((entry) => entry.family === 'limit-angle')!,
  'movingReference',
  topology('face', 'body-angle', 'planar-face'),
  'face',
);

const namedFaceDraft = draftFor(widthContract, true);
const namedFace = topology('face', 'body-width', 'planar-face');
namedFace.stableId = cadUiTopologyStableId('Ffeature-width:side:left', namedFace.stableId);
namedFaceDraft.boundSelections.widthFirstReference = [namedFace];
assert.throws(
  () => buildCadUiCommandTransaction({
    draft: namedFaceDraft,
    expectedRevision: 7,
    transactionId: 'transaction-width-named-face-edit',
  }),
  (error: any) => error?.code === 'COMMAND_FIELD_INVALID' && /does not accept face/i.test(error.message),
  'advanced mate semantic edit accepted an unproved named body face',
);

const couplerContract = contracts.find((entry) => entry.family === 'linear-coupler')!;
const invalidExpressionDraft = draftFor(couplerContract);
invalidExpressionDraft.inputValues.ratio = { unsupported: true };
assert.throws(
  () => buildCadUiCommandTransaction({
    draft: invalidExpressionDraft,
    expectedRevision: 7,
    transactionId: 'transaction-invalid-coupler-expression',
  }),
  (error: any) => error?.code === 'COMMAND_FIELD_REQUIRED' && /number or expression/i.test(error.message),
  'linear coupler accepted a non-expression ratio payload',
);

const missingReferenceDraft = draftFor(
  contracts.find((entry) => entry.family === 'limit-distance')!,
);
delete missingReferenceDraft.boundSelections.movingReference;
assert.throws(
  () => buildCadUiCommandTransaction({
    draft: missingReferenceDraft,
    expectedRevision: 7,
    transactionId: 'transaction-missing-limit-reference',
  }),
  (error: any) => error?.code === 'COMMAND_FIELD_REQUIRED' && /movingReference/.test(error.message),
  'limit mate accepted a missing moving reference',
);

console.log('studio advanced mates interaction smoke passed');
