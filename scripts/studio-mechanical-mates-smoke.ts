import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const assemblyTools = await moduleAt('src/static/studio-v5-assembly.js');
const agentTools = await moduleAt('src/static/studio-agent-service.js');
const interaction = await moduleAt('src/static/studio-v6-interaction.js');
const registry = await moduleAt('src/static/studio-v6-ui-registry.js');
const mechanicalTools = await moduleAt('src/static/studio-mechanical-mates.js');

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Mechanical mates smoke failed: ${label}`);
}

function near(actual: number, expected: number, tolerance = 1e-4): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function vectorNear(actual: number[], expected: number[], tolerance = 1e-4): boolean {
  return actual.length === expected.length && actual.every((value, index) => near(value, expected[index]!, tolerance));
}

function mechanicalMateExtension(family: string, values: JsonRecord = {}): JsonRecord {
  return {
    mechanicalMate: {
      schema: 'partmode.mechanical-mate/v1',
      version: 1,
      family,
      ...values,
    },
  };
}

function geometryReference(
  ownerKind: string,
  ownerId: string,
  occurrenceId: string,
  role: string,
): JsonRecord {
  return {
    ownerKind,
    ownerId,
    occurrencePath: [occurrenceId],
    semanticPath: { role },
    signature: { role },
  };
}

const occurrenceReference = (occurrenceId: string, role: string): JsonRecord =>
  geometryReference('occurrence', occurrenceId, occurrenceId, role);
const datumReference = (occurrenceId: string, datumId: string, role: string): JsonRecord =>
  geometryReference('datum', datumId, occurrenceId, role);
const sketchReference = (occurrenceId: string, sketchId: string, role: string): JsonRecord =>
  geometryReference('sketch', sketchId, occurrenceId, role);
const bodyReference = (occurrenceId: string, bodyId: string, role: string): JsonRecord => ({
  ...geometryReference('body', bodyId, occurrenceId, role),
  signature: { kind: 'face', topologyKind: 'planar-face', p: [0, 0, 0], n: [0, 0, 1] },
});

const sourceFixture = JSON.parse(await readFile(
  resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'),
  'utf8',
)) as JsonRecord;

const translation = (x: number, y: number, z: number): number[] =>
  assemblyTools.studioV5TranslationMatrix([x, y, z]);
const rotationZ = (degrees: number): number[] =>
  assemblyTools.studioV5RotationMatrix([0, 0, 1], degrees);
const placed = (x: number, y: number, z: number, degrees: number): number[] =>
  assemblyTools.studioV5MultiplyMatrices(translation(x, y, z), rotationZ(degrees));

function planeDatum(id: string, name: string, origin: number[], normal: number[], xDirection: number[]): JsonRecord {
  return { id, name, kind: 'plane', suppressed: false, definition: { origin, normal, xDirection } };
}

function axisDatum(id: string, name: string, origin: number[], direction: number[]): JsonRecord {
  return { id, name, kind: 'axis', suppressed: false, definition: { origin, direction } };
}

function pointDatum(id: string, name: string, coordinates: number[]): JsonRecord {
  return { id, name, kind: 'point', suppressed: false, definition: { coordinates } };
}

function sourceProject(): JsonRecord {
  const project = structuredClone(sourceFixture);
  project.projectId = 'mechanical-mates-acceptance';
  project.name = 'Mechanical mates acceptance assembly';
  const basePart = project.partDefinitions.find((entry: JsonRecord) => entry.id === 'part-base-block');
  const movingPart = project.partDefinitions.find((entry: JsonRecord) => entry.id === 'part-moving-block');
  basePart.referenceGeometry.push(
    axisDatum('datum-base-shaft-first', 'First shaft mount axis', [0, 0, 0], [0, 0, 1]),
    axisDatum('datum-base-shaft-second', 'Second shaft mount axis', [30, 0, 0], [0, 0, 1]),
    planeDatum('datum-base-drive', 'Base drive plane', [0, 0, 0], [1, 0, 0], [0, 1, 0]),
    pointDatum('datum-base-point', 'Base point', [0, 0, 0]),
  );
  movingPart.referenceGeometry.push(
    axisDatum('datum-moving-shaft', 'Shaft rotation axis', [0, 0, 0], [0, 0, 1]),
    planeDatum('datum-moving-drive', 'Shaft drive plane', [0, 0, 0], [1, 0, 0], [0, 1, 0]),
  );
  basePart.sketches.push({
    id: 'sketch-base-ordinary',
    name: 'Ordinary sketch',
    entities: [{ id: 'entity-base-line', kind: 'line', a: [0, 0], b: [1, 1] }],
    groups: [],
    constraints: [],
  });
  const assembly = project.assemblyDefinitions[0];
  assembly.mates = [];
  assembly.occurrencePatterns = [];
  assembly.occurrences = [
    {
      id: 'occurrence-base', name: 'Fixed frame', definition: { kind: 'part', partId: 'part-base-block' },
      baseTransform: translation(0, 0, 0), fixed: true, suppressed: false, visible: true,
    },
    {
      id: 'occurrence-moving', name: 'First shaft', definition: { kind: 'part', partId: 'part-moving-block' },
      baseTransform: translation(0, 0, 0), fixed: false, suppressed: false, visible: true,
    },
    {
      id: 'occurrence-third', name: 'Second shaft', definition: { kind: 'part', partId: 'part-moving-block' },
      baseTransform: translation(30, 0, 0), fixed: false, suppressed: false, visible: true,
    },
  ];
  return runtime.canonicalStudioV5Project(project);
}

const gearMate = (values: JsonRecord = { ratio: 2, offset: 0 }): JsonRecord => ({
  id: 'mate-gear', name: 'Coupled shafts', kind: 'gear',
  occurrenceIds: ['occurrence-moving', 'occurrence-third'],
  references: [
    datumReference('occurrence-moving', 'datum-moving-shaft', 'gear-first-axis'),
    datumReference('occurrence-third', 'datum-moving-shaft', 'gear-second-axis'),
  ],
  suppressed: false,
  extensions: mechanicalMateExtension('gear', values),
});

const hingeMate = (values: JsonRecord = { minimum: null, maximum: null }): JsonRecord => ({
  id: 'mate-hinge', name: 'Hinged shaft', kind: 'hinge',
  occurrenceIds: ['occurrence-base', 'occurrence-moving'],
  references: [
    datumReference('occurrence-base', 'datum-base-shaft-first', 'hinge-first-axis'),
    datumReference('occurrence-moving', 'datum-moving-shaft', 'hinge-second-axis'),
  ],
  suppressed: false,
  extensions: mechanicalMateExtension('hinge', values),
});

const revoluteMate = (id: string, anchorDatumId: string, movingId: string): JsonRecord => ({
  id,
  name: `${movingId} mount`,
  kind: 'revolute',
  occurrenceIds: ['occurrence-base', movingId],
  references: [
    datumReference('occurrence-base', anchorDatumId, 'anchor'),
    datumReference(movingId, 'datum-moving-shaft', 'moving'),
  ],
  suppressed: false,
});

const driverMate = (degrees: number): JsonRecord => ({
  id: 'mate-drive-angle',
  name: 'Drive station',
  kind: 'angle',
  occurrenceIds: ['occurrence-base', 'occurrence-moving'],
  references: [
    datumReference('occurrence-base', 'datum-base-drive', 'anchor'),
    datumReference('occurrence-moving', 'datum-moving-drive', 'moving'),
  ],
  value: degrees,
  suppressed: false,
});

function createMate(project: JsonRecord, mate: JsonRecord): JsonRecord {
  return runtime.createStudioV5AssemblyMate(project, structuredClone(mate));
}

function projectForMates(
  mates: JsonRecord[],
  transforms: Record<string, number[]> = {},
): JsonRecord {
  let project = sourceProject();
  const assembly = runtime.studioV5RootAssembly(project);
  for (const occurrence of assembly.occurrences) {
    const transform = transforms[occurrence.id];
    if (transform) occurrence.baseTransform = [...transform];
  }
  project = runtime.canonicalStudioV5Project(project);
  for (const mate of mates) project = createMate(project, mate);
  return project;
}

function rotationAboutZ(matrix: number[]): number {
  return Math.atan2(matrix[1]!, matrix[0]!) * 180 / Math.PI;
}

const source = sourceProject();
const sourceBytes = JSON.stringify(source);
const sourceAxisDatums = source.partDefinitions.flatMap((part: JsonRecord) => part.referenceGeometry)
  .filter((entry: JsonRecord) => ['datum-base-shaft-first', 'datum-base-shaft-second', 'datum-moving-shaft'].includes(entry.id));
check('mechanical acceptance does not use genuine axis datums', sourceAxisDatums.length === 3
  && sourceAxisDatums.every((entry: JsonRecord) => entry.kind === 'axis'
    && entry.definition.direction[2] === 1
    && entry.definition.xDirection === undefined));

check('mechanical mate kind registry drifted',
  JSON.stringify(mechanicalTools.STUDIO_MECHANICAL_MATE_KINDS) === JSON.stringify(['gear', 'hinge'])
  && mechanicalTools.STUDIO_MECHANICAL_MATE_SCHEMA === 'partmode.mechanical-mate/v1');

// Direct persistent lifecycle: create both families, edit both, canonical
// save/reopen equality, and delete restoration.
let lifecycle = source;
for (const mate of [gearMate(), hingeMate({ minimum: 20, maximum: 45 })]) lifecycle = createMate(lifecycle, mate);
check('direct CRUD did not persist both mechanical families',
  JSON.stringify(runtime.studioV5RootAssembly(lifecycle).mates.map((entry: JsonRecord) => entry.kind))
    === JSON.stringify(['gear', 'hinge']));
lifecycle = runtime.updateStudioV5AssemblyMate(lifecycle, 'mate-gear', {
  name: 'Coupled shafts edited',
  extensions: mechanicalMateExtension('gear', { ratio: '4 / 2', offset: 30 }),
});
lifecycle = runtime.updateStudioV5AssemblyMate(lifecycle, 'mate-hinge', {
  name: 'Hinged shaft edited',
  extensions: mechanicalMateExtension('hinge', { minimum: -45, maximum: -20 }),
});
const editedGear = runtime.studioV5RootAssembly(lifecycle).mates.find((entry: JsonRecord) => entry.id === 'mate-gear');
check('gear expression edit did not persist', editedGear.extensions.mechanicalMate.ratio === '4 / 2'
  && editedGear.extensions.mechanicalMate.offset === 30);
const reopenedLifecycle = runtime.canonicalStudioV5Project(JSON.parse(JSON.stringify(lifecycle)));
assert.deepEqual(reopenedLifecycle, lifecycle, 'mechanical mate save/reopen was not canonical');
const freeHingeLifecycle = runtime.updateStudioV5AssemblyMate(lifecycle, 'mate-hinge', {
  extensions: mechanicalMateExtension('hinge', { minimum: null, maximum: null }),
});
const freeHinge = runtime.studioV5RootAssembly(freeHingeLifecycle).mates.find((entry: JsonRecord) => entry.id === 'mate-hinge');
check('hinge limits did not clear to the free-rotation null pair',
  freeHinge.extensions.mechanicalMate.minimum === null && freeHinge.extensions.mechanicalMate.maximum === null);
const reopenedFreeHinge = runtime.canonicalStudioV5Project(JSON.parse(JSON.stringify(freeHingeLifecycle)));
assert.deepEqual(reopenedFreeHinge, freeHingeLifecycle, 'free-hinge null limits did not survive canonical reopen');

// Typed mate.create / mate.update / mate.delete lifecycles.
const typedRecords = [gearMate(), hingeMate({ minimum: 20, maximum: 45 })];
const typedCreated = agentTools.applyCadTransaction(source, {
  transactionId: 'transaction-mechanical-mates-create',
  label: 'Create both mechanical mate families',
  expectedRevision: 0,
  atomic: true,
  operations: typedRecords.map((mate) => {
    const input = structuredClone(mate);
    delete input.kind;
    input.mateKind = mate.kind;
    return { kind: 'mate.create', input };
  }),
}).project;
check('typed create omitted a mechanical family', runtime.studioV5RootAssembly(typedCreated).mates.length === 2);
const typedUpdated = agentTools.applyCadTransaction(typedCreated, {
  transactionId: 'transaction-mechanical-mates-update',
  label: 'Update both mechanical mates',
  expectedRevision: 0,
  atomic: true,
  operations: typedRecords.map((mate) => ({
    kind: 'mate.update',
    input: { mateId: mate.id, patch: { name: `${mate.name} typed edit` } },
  })),
}).project;
check('typed update did not edit both mechanical mates',
  runtime.studioV5RootAssembly(typedUpdated).mates.every((entry: JsonRecord) => entry.name.endsWith('typed edit')));
const typedDeleted = agentTools.applyCadTransaction(typedUpdated, {
  transactionId: 'transaction-mechanical-mates-delete',
  label: 'Delete both mechanical mates',
  expectedRevision: 0,
  atomic: true,
  operations: [...typedRecords].reverse().map((mate) => ({ kind: 'mate.delete', input: { mateId: mate.id } })),
}).project;
check('typed delete retained mechanical mate records', runtime.studioV5RootAssembly(typedDeleted).mates.length === 0);
check('mechanical typed lifecycle mutated its caller', JSON.stringify(source) === sourceBytes);

// Refusal families.
assert.throws(
  () => createMate(source, {
    ...gearMate(), id: 'mate-gear-same-occurrence',
    occurrenceIds: ['occurrence-moving', 'occurrence-moving'],
    references: [
      datumReference('occurrence-moving', 'datum-moving-shaft', 'gear-first-axis'),
      datumReference('occurrence-moving', 'datum-moving-shaft', 'gear-second-axis'),
    ],
  }),
  /distinct/i,
  'same-occurrence gear pair did not fail closed',
);
assert.throws(
  () => createMate(source, {
    ...hingeMate(), id: 'mate-hinge-same-occurrence',
    occurrenceIds: ['occurrence-moving', 'occurrence-moving'],
    references: [
      datumReference('occurrence-moving', 'datum-moving-shaft', 'hinge-first-axis'),
      datumReference('occurrence-moving', 'datum-moving-shaft', 'hinge-second-axis'),
    ],
  }),
  /distinct/i,
  'same-occurrence hinge pair did not fail closed',
);
assert.throws(
  () => createMate(source, {
    ...gearMate(), id: 'mate-gear-plane-datum',
    references: [
      datumReference('occurrence-moving', 'datum-moving-drive', 'gear-first-axis'),
      gearMate().references[1],
    ],
  }),
  /axis datum/i,
  'gear stored a plane datum where an axis is required',
);
assert.throws(
  () => createMate(source, {
    ...hingeMate(), id: 'mate-hinge-point-datum',
    references: [
      datumReference('occurrence-base', 'datum-base-point', 'hinge-first-axis'),
      hingeMate().references[1],
    ],
  }),
  /axis datum/i,
  'hinge stored a point datum where an axis is required',
);
assert.throws(
  () => createMate(source, {
    ...gearMate(), id: 'mate-gear-origin-reference',
    references: [
      occurrenceReference('occurrence-moving', 'gear-first-axis'),
      gearMate().references[1],
    ],
  }),
  /axis datum/i,
  'gear stored a component-origin reference outside the axis surface',
);
assert.throws(
  () => createMate(source, {
    ...gearMate(), id: 'mate-gear-sketch-reference',
    references: [
      sketchReference('occurrence-moving', 'sketch-base-ordinary', 'gear-first-axis'),
      gearMate().references[1],
    ],
  }),
  /axis datum/i,
  'gear stored a sketch reference outside the axis surface',
);
assert.throws(
  () => createMate(source, {
    ...hingeMate(), id: 'mate-hinge-body-reference',
    references: [
      bodyReference('occurrence-base', 'body-base-block', 'hinge-first-axis'),
      hingeMate().references[1],
    ],
  }),
  /axis datum/i,
  'hinge stored a body-face reference outside the axis surface',
);
assert.throws(
  () => createMate(source, { ...gearMate({ ratio: 0, offset: 0 }), id: 'mate-gear-zero-ratio' }),
  /positive/i,
  'zero gear ratio did not fail closed',
);
assert.throws(
  () => createMate(source, { ...gearMate({ ratio: -2, offset: 0 }), id: 'mate-gear-negative-ratio' }),
  /positive/i,
  'negative gear ratio did not fail closed',
);
assert.throws(
  () => createMate(source, { ...gearMate({ ratio: '0 - 2', offset: 0 }), id: 'mate-gear-negative-expression' }),
  /positive/i,
  'negative gear ratio expression did not fail closed',
);
assert.throws(
  () => createMate(source, { ...hingeMate({ minimum: 60, maximum: 20 }), id: 'mate-hinge-inverted-limits' }),
  /minimum|maximum|ordered/i,
  'inverted hinge limits did not fail closed',
);
assert.throws(
  () => createMate(source, { ...hingeMate({ minimum: 10, maximum: null }), id: 'mate-hinge-single-limit' }),
  /together/i,
  'a single-sided hinge limit did not fail closed',
);
assert.throws(
  () => createMate(source, { ...hingeMate({ minimum: -200, maximum: 0 }), id: 'mate-hinge-out-of-range' }),
  /-180/,
  'out-of-range hinge limits did not fail closed',
);
assert.throws(
  () => runtime.updateStudioV5AssemblyMate(lifecycle, 'mate-gear', { kind: 'hinge' }),
  /immutable|family|kind/i,
  'mechanical mate kind mutation did not fail closed',
);
assert.throws(
  () => runtime.updateStudioV5AssemblyMate(lifecycle, 'mate-gear', {
    extensions: mechanicalMateExtension('hinge', { minimum: null, maximum: null }),
  }),
  /immutable|family/i,
  'mechanical mate family mutation did not fail closed',
);
assert.throws(
  () => runtime.updateStudioV5AssemblyMate(lifecycle, 'mate-gear', {
    extensions: { advancedMate: { schema: 'partmode.advanced-mate/v1', version: 1, family: 'gear' } },
  }),
  /mechanicalMate/,
  'mechanical mate accepted a foreign extensions contract',
);
const conventionalProject = projectForMates([revoluteMate('mate-first-mount', 'datum-base-shaft-first', 'occurrence-moving')]);
assert.throws(
  () => runtime.updateStudioV5AssemblyMate(conventionalProject, 'mate-first-mount', { kind: 'gear' }),
  /converted/i,
  'a conventional mate converted into a mechanical mate through mate.update',
);
assert.throws(
  () => createMate(source, {
    id: 'mate-revolute-contract-bypass', name: 'Bypass', kind: 'revolute',
    occurrenceIds: ['occurrence-base', 'occurrence-moving'],
    references: [
      datumReference('occurrence-base', 'datum-base-shaft-first', 'anchor'),
      datumReference('occurrence-moving', 'datum-moving-shaft', 'moving'),
    ],
    suppressed: false,
    extensions: mechanicalMateExtension('gear', { ratio: 2, offset: 0 }),
  }),
  /mechanical mate kind/i,
  'a conventional mate stored a mechanicalMate contract',
);
assert.throws(
  () => createMate(source, { ...gearMate(), unsupportedField: true } as JsonRecord),
  /unsupported fields/i,
  'mechanical mate accepted unsupported input fields',
);

// Gear: coupled rotation at three exact stations plus one authored offset
// station, with translations left to the two revolute mounts.
const gearSystem = (station: number, values?: JsonRecord): JsonRecord => projectForMates(
  [
    revoluteMate('mate-first-mount', 'datum-base-shaft-first', 'occurrence-moving'),
    revoluteMate('mate-second-mount', 'datum-base-shaft-second', 'occurrence-third'),
    ...(station === 0 ? [] : [driverMate(station)]),
    gearMate(values ?? { ratio: 2, offset: 0 }),
  ],
  {
    'occurrence-moving': placed(0, 0, 0, station),
    'occurrence-third': translation(30, 0, 0),
  },
);
const gearStations: Array<[number, number]> = [[10, -20], [20, -40], [45, -90]];
const gearResults = new Map<number, JsonRecord>();
for (const [station, expected] of gearStations) {
  const solved = assemblyTools.solveStudioV5Assembly(gearSystem(station), 'assembly-two-blocks');
  check(`gear station ${station} solve failed ${JSON.stringify(solved.errors)}`,
    solved.errors.length === 0 && solved.usedLastValid === false);
  const first = solved.transforms.get('occurrence-moving');
  const second = solved.transforms.get('occurrence-third');
  check(`gear station ${station} did not hold the driven shaft`, near(rotationAboutZ(first), station));
  check(`gear station ${station} did not couple theta2 = -2 * theta1`, near(rotationAboutZ(second), expected));
  check(`gear station ${station} moved a shaft off its mount`,
    vectorNear(first.slice(12, 15), [0, 0, 0]) && vectorNear(second.slice(12, 15), [30, 0, 0]));
  const residual = solved.residuals.find((entry: JsonRecord) => entry.mateId === 'mate-gear');
  check(`gear station ${station} retained a solver residual`,
    residual?.satisfied === true && residual.maxAngularResidual < 1e-6);
  gearResults.set(station, solved);
}
const offsetSolved = assemblyTools.solveStudioV5Assembly(
  gearSystem(10, { ratio: 2, offset: 30 }),
  'assembly-two-blocks',
);
check(`gear offset solve failed ${JSON.stringify(offsetSolved.errors)}`, offsetSolved.errors.length === 0);
check('gear offset did not shift the coupling to theta2 = -2 * theta1 + 30',
  near(rotationAboutZ(offsetSolved.transforms.get('occurrence-third')), 10));
const undrivenGear = assemblyTools.solveStudioV5Assembly(gearSystem(0), 'assembly-two-blocks');
check(`undriven gear solve failed ${JSON.stringify(undrivenGear.errors)}`, undrivenGear.errors.length === 0);
const gearComponent = undrivenGear.solverComponents.find((entry: JsonRecord) =>
  entry.occurrenceIds.includes('occurrence-moving'));
check('gear did not collapse the two mounted shafts to one coupled rotational DOF',
  gearComponent.rank === 11
  && gearComponent.variableCount === 12
  && gearComponent.degreesOfFreedom === 1
  && undrivenGear.degreesOfFreedom.get('occurrence-moving') === 1
  && undrivenGear.degreesOfFreedom.get('occurrence-third') === 1);
const drivenGearComponent = gearResults.get(45)!.solverComponents.find((entry: JsonRecord) =>
  entry.occurrenceIds.includes('occurrence-moving'));
check('driven gear system is not exactly fully constrained',
  drivenGearComponent.rank === 12 && drivenGearComponent.degreesOfFreedom === 0
  && gearResults.get(45)!.state === 'fully-constrained');

// Hinge: one concentric axis pair collapsing to a single rotational DOF.
const freeHingeProject = projectForMates(
  [hingeMate()],
  { 'occurrence-moving': placed(5, 4, 3, 73) },
);
const freeHingeSolved = assemblyTools.solveStudioV5Assembly(freeHingeProject, 'assembly-two-blocks');
check(`free hinge solve failed ${JSON.stringify(freeHingeSolved.errors)}`,
  freeHingeSolved.errors.length === 0 && freeHingeSolved.usedLastValid === false);
const freeHingeTransform = freeHingeSolved.transforms.get('occurrence-moving');
check('free hinge did not settle the shaft onto the concentric axis pair',
  vectorNear(freeHingeTransform.slice(12, 15), [0, 0, 0]));
check('free hinge did not preserve the free rotation angle', near(rotationAboutZ(freeHingeTransform), 73));
const hingeComponent = freeHingeSolved.solverComponents.find((entry: JsonRecord) =>
  entry.occurrenceIds.includes('occurrence-moving'));
check('free hinge rank did not collapse the pair to one rotational DOF',
  hingeComponent.rank === 5
  && hingeComponent.variableCount === 6
  && hingeComponent.degreesOfFreedom === 1
  && freeHingeSolved.degreesOfFreedom.get('occurrence-moving') === 1
  && freeHingeSolved.state === 'under-constrained');

// Hinge limit stations mirror the AS002 limit-angle evidence: below, inside,
// and above the authored range, plus one signed negative range.
function hingeLimitProject(station: number, values: JsonRecord): JsonRecord {
  return projectForMates(
    [hingeMate(values)],
    { 'occurrence-moving': placed(0, 0, 0, station) },
  );
}
const hingeLimits = { minimum: 20, maximum: 45 };
const hingeLow = assemblyTools.solveStudioV5Assembly(hingeLimitProject(10, hingeLimits), 'assembly-two-blocks');
const hingeInside = assemblyTools.solveStudioV5Assembly(hingeLimitProject(30, hingeLimits), 'assembly-two-blocks');
const hingeHigh = assemblyTools.solveStudioV5Assembly(hingeLimitProject(90, hingeLimits), 'assembly-two-blocks');
check(`hinge limit solves failed ${JSON.stringify([hingeLow.errors, hingeInside.errors, hingeHigh.errors])}`,
  hingeLow.errors.length === 0 && hingeInside.errors.length === 0 && hingeHigh.errors.length === 0);
check('hinge lower limit did not activate', near(rotationAboutZ(hingeLow.transforms.get('occurrence-moving')), 20));
check('hinge changed an in-range station', near(rotationAboutZ(hingeInside.transforms.get('occurrence-moving')), 30));
check('hinge upper limit did not activate', near(rotationAboutZ(hingeHigh.transforms.get('occurrence-moving')), 45));
check('in-range hinge limit did not retain the single rotational DOF',
  hingeInside.degreesOfFreedom.get('occurrence-moving') === 1);
const hingeSigned = assemblyTools.solveStudioV5Assembly(
  hingeLimitProject(-60, { minimum: -45, maximum: -20 }),
  'assembly-two-blocks',
);
check(`signed hinge limit solve failed ${JSON.stringify(hingeSigned.errors)}`, hingeSigned.errors.length === 0);
check('signed negative hinge limit did not activate',
  near(rotationAboutZ(hingeSigned.transforms.get('occurrence-moving')), -45));

// Semantic registry and visible-command interaction contracts.
const interactionContracts: JsonRecord[] = [
  {
    family: 'gear',
    occurrences: [
      ['gearFirstOccurrence', 'occ-gear-first'],
      ['gearSecondOccurrence', 'occ-gear-second'],
    ],
    references: [
      ['gearFirstReference', 0, 'gear-first-axis'],
      ['gearSecondReference', 1, 'gear-second-axis'],
    ],
    values: { ratio: '4 / 2', offset: '30' },
  },
  {
    family: 'hinge',
    occurrences: [
      ['hingeFirstOccurrence', 'occ-hinge-first'],
      ['hingeSecondOccurrence', 'occ-hinge-second'],
    ],
    references: [
      ['hingeFirstReference', 0, 'hinge-first-axis'],
      ['hingeSecondReference', 1, 'hinge-second-axis'],
    ],
    values: { minimum: '20', maximum: '45' },
  },
];
for (const contract of interactionContracts) {
  const definition = registry.cadUiCommandDefinition(`assembly.mate.${contract.family}`);
  check(`${contract.family} command is absent from the semantic registry`, definition);
  for (const [fieldId] of contract.references) {
    const field = definition.fields.find((entry: JsonRecord) => entry.id === fieldId);
    assert.deepEqual(
      field?.selectionKinds,
      ['datum'],
      `${contract.family}.${fieldId} advertises selections outside the axis-datum surface`,
    );
  }
}

function interactionDraft(contract: JsonRecord, options: JsonRecord = {}): JsonRecord {
  const boundSelections: JsonRecord = {};
  for (const [fieldId, occurrenceId] of contract.occurrences) {
    boundSelections[fieldId] = [{ kind: 'occurrence', id: occurrenceId }];
  }
  contract.references.forEach(([fieldId]: [string], index: number) => {
    boundSelections[fieldId] = [{ kind: 'datum', id: `datum-${contract.family}-${index}` }];
  });
  return {
    commandId: `assembly.mate.${contract.family}`,
    draftId: `draft-${contract.family}`,
    baseRevision: 7,
    inputValues: {
      name: `${contract.family} semantic mate`,
      ...structuredClone(options.values ?? contract.values),
    },
    boundSelections,
    generatedIds: { mateId: `mate-${contract.family}` },
    ...(options.edit ? { editEntity: { kind: 'mate', id: `mate-${contract.family}` } } : {}),
  };
}

function buildInteraction(contract: JsonRecord, options: JsonRecord = {}): JsonRecord {
  return interaction.buildCadUiCommandTransaction({
    draft: interactionDraft(contract, options),
    expectedRevision: 7,
    transactionId: `transaction-${contract.family}-${options.edit ? 'update' : 'create'}`,
  }).transaction;
}

for (const contract of interactionContracts) {
  const create = buildInteraction(contract);
  assert.equal(create.operations.length, 1);
  const createOperation = create.operations[0]!;
  assert.equal(createOperation.kind, 'mate.create');
  assert.equal(createOperation.input.mateKind, contract.family);
  assert.deepEqual(
    createOperation.input.occurrenceIds,
    contract.occurrences.map(([, occurrenceId]: [string, string]) => occurrenceId),
  );
  assert.deepEqual(
    createOperation.input.references.map((reference: JsonRecord) => reference.semanticPath.role),
    contract.references.map(([, , role]: [string, number, string]) => role),
  );
  assert.deepEqual(createOperation.input.extensions, {
    mechanicalMate: {
      schema: 'partmode.mechanical-mate/v1',
      version: 1,
      family: contract.family,
      ...contract.values,
    },
  });
  const update = buildInteraction(contract, { edit: true });
  assert.equal(update.operations[0]!.kind, 'mate.update');
  assert.equal(update.operations[0]!.input.mateId, `mate-${contract.family}`);
  assert.equal(update.operations[0]!.input.patch.kind, contract.family);
}
const freeHingeTransaction = buildInteraction(interactionContracts[1]!, { values: { } });
assert.deepEqual(
  freeHingeTransaction.operations[0]!.input.extensions.mechanicalMate,
  { schema: 'partmode.mechanical-mate/v1', version: 1, family: 'hinge', minimum: null, maximum: null },
  'omitted hinge limits did not author the free-rotation null pair',
);
for (const [selection, selectionKind] of [
  [{ kind: 'occurrence', id: 'occ-gear-first' }, 'occurrence'],
  [{ kind: 'sketch', id: 'sketch-not-an-axis' }, 'sketch'],
  [{
    owner: { kind: 'body', id: 'body-gear' },
    stableId: 'face:body-gear',
    topologySignature: { kind: 'face', topologyKind: 'planar-face', p: [0, 0, 0], n: [0, 0, 1] },
  }, 'face'],
] as Array<[JsonRecord, string]>) {
  const draft = interactionDraft(interactionContracts[0]!);
  draft.boundSelections.gearFirstReference = [selection];
  assert.throws(
    () => interaction.buildCadUiCommandTransaction({
      draft,
      expectedRevision: 7,
      transactionId: `transaction-gear-invalid-${selectionKind}`,
    }),
    (error: any) => error?.code === 'COMMAND_FIELD_INVALID'
      && new RegExp(`does not accept ${selectionKind}`, 'i').test(error.message),
    `gear mate accepted an unsupported ${selectionKind} reference selection`,
  );
}
const duplicateDraft = interactionDraft(interactionContracts[1]!);
duplicateDraft.boundSelections.hingeSecondOccurrence = [{ kind: 'occurrence', id: 'occ-hinge-first' }];
assert.throws(
  () => interaction.buildCadUiCommandTransaction({
    draft: duplicateDraft,
    expectedRevision: 7,
    transactionId: 'transaction-hinge-duplicate-occurrence',
  }),
  (error: any) => error?.code === 'COMMAND_FIELD_INVALID' && /distinct/i.test(error.message),
  'hinge mate accepted duplicate role occurrences',
);

// Production-worker exact rebuilds bound to the current document hash, with
// fresh-worker equality on the driven gear case.
type ExactAssemblyBodyEvidence = {
  occurrenceBody: JsonRecord;
  renderSource: JsonRecord;
  exactBrep: string;
};

function exactAssemblyBody(
  result: JsonRecord,
  occurrenceId: string,
  label: string,
): ExactAssemblyBodyEvidence {
  const body = result.bodies?.find((entry: JsonRecord) => entry.occurrenceInstance?.occurrenceId === occurrenceId);
  check(`${label} omitted ${occurrenceId}: ${JSON.stringify(result.errors || [])}`, body);
  const renderSource = body.sharesSourceGeometry === true
    ? result.bodies?.find((entry: JsonRecord) => entry.bodyId === body.renderSourceBodyId)
    : body;
  check(`${label} omitted exact shared-geometry source for ${occurrenceId}`, renderSource);
  const exactBrep = renderSource.exactBrep;
  const counts = renderSource.mesh?.topologyCounts;
  check(`${label} did not publish one valid exact B-rep for ${occurrenceId}: ${JSON.stringify({ body, renderSource })}`, body.error == null
    && body.lastValid === false
    && body.geometry?.valid === true
    && body.geometry?.brepValid === true
    && body.geometry?.solidCount === 1
    && Array.isArray(body.renderTransform)
    && body.renderTransform.length === 16
    && body.renderTransform.every(Number.isFinite)
    && renderSource.error == null
    && renderSource.lastValid === false
    && renderSource.geometry?.valid === true
    && renderSource.geometry?.brepValid === true
    && body.renderSourceKey === renderSource.renderSourceKey
    && typeof exactBrep === 'string'
    && exactBrep.length > 100);
  check(`${label} published incomplete topology for ${occurrenceId}: ${JSON.stringify(counts)}`, counts
    && counts.faces > 0 && counts.faces === renderSource.mesh.topologyFaces?.length
    && counts.edges > 0 && counts.edges === renderSource.mesh.edges?.length
    && counts.vertices > 0 && counts.vertices === renderSource.mesh.topologyVertices?.length
    && counts.faces === counts.namedFaces
    && counts.edges === counts.namedEdges
    && counts.vertices === counts.namedVertices
    && !renderSource.mesh.topologyDiagnostics?.some((entry: JsonRecord) => entry.severity === 'error'));
  return { occurrenceBody: body, renderSource, exactBrep };
}

async function rebuildExact(
  kernel: HeadlessKernel,
  project: JsonRecord,
  revision: number,
  label: string,
): Promise<JsonRecord> {
  const result = await kernel.request({
    kind: 'rebuild',
    requestId: `mechanical-mates-${label}`,
    projectId: project.projectId,
    revision,
    document: project,
    includeExactBrep: true,
  }, 180_000) as JsonRecord;
  check(`${label} exact rebuild failed ${JSON.stringify(result.errors || [])}`, result.kind === 'rebuild-result'
    && result.errors?.length === 0
    && result.effectiveDocumentHash === runtime.studioV5CanonicalHash(project));
  return result;
}

const exactCases = [
  ['gear-driven', gearSystem(45), ['occurrence-base', 'occurrence-moving', 'occurrence-third']],
  ['hinge-free', freeHingeProject, ['occurrence-base', 'occurrence-moving']],
  ['hinge-limited', hingeLimitProject(90, hingeLimits), ['occurrence-base', 'occurrence-moving']],
] as Array<[string, JsonRecord, string[]]>;

let kernel: HeadlessKernel | null = null;
const exactResults = new Map<string, JsonRecord>();
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  for (const [index, [label, project, occurrenceIds]] of exactCases.entries()) {
    const result = await rebuildExact(kernel, project, index + 1, label);
    for (const occurrenceId of occurrenceIds) exactAssemblyBody(result, occurrenceId, label);
    exactResults.set(label, result);
  }
} finally {
  await kernel?.dispose();
}

let freshKernel: HeadlessKernel | null = null;
let freshGearResult: JsonRecord | null = null;
try {
  freshKernel = await createHeadlessKernel();
  await freshKernel.waitForKernel();
  freshGearResult = await rebuildExact(freshKernel, gearSystem(45), 1, 'gear-driven-fresh-worker');
} finally {
  await freshKernel?.dispose();
}
const warmGearBody = exactAssemblyBody(exactResults.get('gear-driven')!, 'occurrence-third', 'gear-driven');
const freshGearBody = exactAssemblyBody(freshGearResult!, 'occurrence-third', 'gear-driven-fresh-worker');
check('fresh worker omitted nonempty serialized gear-mated B-rep bytes',
  warmGearBody.exactBrep.length > 100 && freshGearBody.exactBrep.length > 100);
check('fresh worker changed the authoritative shared render-source B-rep bytes',
  freshGearBody.exactBrep === warmGearBody.exactBrep);
check('fresh worker changed the exact gear-mated occurrence bounds or transform',
  JSON.stringify(freshGearBody.occurrenceBody.geometry.bounds)
      === JSON.stringify(warmGearBody.occurrenceBody.geometry.bounds)
    && JSON.stringify(freshGearBody.occurrenceBody.renderTransform)
      === JSON.stringify(warmGearBody.occurrenceBody.renderTransform));

console.log(JSON.stringify({
  schema: 'partmode.mechanical-mate/v1',
  families: ['gear', 'hinge'],
  lifecycle: { created: 2, updated: 2, deleted: 2, canonicalReopen: true },
  gear: {
    stations: gearStations.map(([station, expected]) => ({ theta1: station, theta2: expected })),
    offsetStation: { theta1: 10, offset: 30, theta2: 10 },
    coupledSystem: { rank: 11, variableCount: 12, degreesOfFreedom: 1 },
  },
  hinge: {
    free: { position: [0, 0, 0], angle: 73, rank: 5, degreesOfFreedom: 1 },
    limits: { below: 20, inside: 30, above: 45, signedNegative: -45 },
  },
  exactWorkerCases: exactCases.map(([label]) => label),
  freshWorker: true,
}, null, 2));
