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
const dragTools = await moduleAt('src/static/studio-assembly-drag.js');
const agentTools = await moduleAt('src/static/studio-agent-service.js');
const modelingTools = await moduleAt('src/static/studio-v5-modeling.js');

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Advanced mates smoke failed: ${label}`);
}

function near(actual: number, expected: number, tolerance = 1e-6): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function vectorNear(actual: number[], expected: number[], tolerance = 1e-6): boolean {
  return actual.length === expected.length && actual.every((value, index) => near(value, expected[index]!, tolerance));
}

function advancedMateExtension(family: string, values: JsonRecord = {}): JsonRecord {
  return {
    advancedMate: {
      schema: 'partmode.advanced-mate/v1',
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
const pathReference = (occurrenceId: string, sketchId: string, role: string): JsonRecord =>
  geometryReference('sketch', sketchId, occurrenceId, role);
const bodyReference = (
  occurrenceId: string,
  bodyId: string,
  role: string,
  topologyKind: string,
): JsonRecord => ({
  ...geometryReference('body', bodyId, occurrenceId, role),
  signature: { kind: topologyKind.endsWith('-face') ? 'face' : topologyKind.endsWith('-edge') ? 'edge' : 'vertex', topologyKind, p: [0, 0, 0] },
});

const sourceFixture = JSON.parse(await readFile(
  resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'),
  'utf8',
)) as JsonRecord;

const translation = (x: number, y: number, z: number): number[] =>
  assemblyTools.studioV5TranslationMatrix([x, y, z]);

function datum(id: string, name: string, origin: number[], normal: number[], xDirection: number[]): JsonRecord {
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
  project.projectId = 'advanced-mates-acceptance';
  project.name = 'Advanced mates acceptance assembly';
  const basePart = project.partDefinitions.find((entry: JsonRecord) => entry.id === 'part-base-block');
  const movingPart = project.partDefinitions.find((entry: JsonRecord) => entry.id === 'part-moving-block');
  basePart.referenceGeometry.push(
    datum('datum-base-width-first', 'Base width first', [-5, 0, 0], [1, 0, 0], [0, 1, 0]),
    datum('datum-base-width-second', 'Base width second', [5, 0, 0], [-1, 0, 0], [0, 1, 0]),
    axisDatum('datum-base-axis-x', 'Base X axis', [0, 0, 0], [1, 0, 0]),
    datum('datum-base-symmetry', 'Base symmetry plane', [0, 0, 0], [1, 0, 0], [0, 1, 0]),
    datum('datum-base-limit', 'Base limit plane', [0, 0, 0], [0, 0, 1], [1, 0, 0]),
    pointDatum('datum-base-point', 'Base point', [0, 0, 0]),
  );
  movingPart.referenceGeometry.push(
    datum('datum-moving-tab-first', 'Moving tab first', [-2, 0, 0], [1, 0, 0], [0, 1, 0]),
    datum('datum-moving-tab-second', 'Moving tab second', [2, 0, 0], [-1, 0, 0], [0, 1, 0]),
    axisDatum('datum-moving-axis-x', 'Moving X axis', [0, 0, 0], [1, 0, 0]),
    datum('datum-moving-limit', 'Moving limit plane', [0, 0, 0], [0, 0, 1], [1, 0, 0]),
    pointDatum('datum-moving-point', 'Moving point', [0, 0, 0]),
  );
  basePart.sketches.push(
    {
      id: 'sketch-assembly-path',
      name: 'Exact assembly spline path',
      entities: [{
        id: 'entity-assembly-path',
        kind: 'spline',
        points: [[0, 0, 0], [10, 5, 0], [20, 0, 0]],
      }],
      groups: [],
      constraints: [],
      extensions: { studioRole: 'path' },
    },
    {
      id: 'sketch-not-a-path',
      name: 'Ordinary untagged sketch',
      entities: [{ id: 'entity-not-a-path', kind: 'line', a: [0, 0], b: [1, 1] }],
      groups: [],
      constraints: [],
    },
    {
      id: 'sketch-helical-path',
      name: 'Helical path without exact projection spans',
      entities: [{ id: 'entity-helical-path', kind: 'spline', points: [[0, 0, 0], [1, 1, 1]] }],
      groups: [],
      constraints: [],
      extensions: {
        studioRole: 'path',
        referenceCurve: {
          kind: 'helix',
          axisDatumId: 'datum-base-axis-x',
          radius: 2,
          pitch: 4,
          turns: 2,
          handedness: 'right',
        },
      },
    },
  );
  const assembly = project.assemblyDefinitions[0];
  assembly.mates = [];
  assembly.occurrencePatterns = [];
  assembly.occurrences = [
    {
      id: 'occurrence-base', name: 'Fixed base', definition: { kind: 'part', partId: 'part-base-block' },
      baseTransform: translation(0, 0, 0), fixed: true, suppressed: false, visible: true,
    },
    {
      id: 'occurrence-moving', name: 'Moving component', definition: { kind: 'part', partId: 'part-moving-block' },
      baseTransform: translation(7, 0, 0), fixed: false, suppressed: false, visible: true,
    },
    {
      id: 'occurrence-third', name: 'Second moving component', definition: { kind: 'part', partId: 'part-moving-block' },
      baseTransform: translation(-7, 0, 0), fixed: false, suppressed: false, visible: true,
    },
  ];
  return runtime.canonicalStudioV5Project(project);
}

function mateRecords(): JsonRecord[] {
  return [
    {
      id: 'mate-width', name: 'Centered tab', kind: 'width',
      occurrenceIds: ['occurrence-base', 'occurrence-moving'],
      references: [
        datumReference('occurrence-base', 'datum-base-width-first', 'width-first'),
        datumReference('occurrence-base', 'datum-base-width-second', 'width-second'),
        datumReference('occurrence-moving', 'datum-moving-tab-first', 'tab-first'),
        datumReference('occurrence-moving', 'datum-moving-tab-second', 'tab-second'),
      ],
      suppressed: false,
      extensions: advancedMateExtension('width'),
    },
    {
      id: 'mate-symmetry', name: 'Mirrored components', kind: 'symmetry',
      occurrenceIds: ['occurrence-moving', 'occurrence-third', 'occurrence-base'],
      references: [
        occurrenceReference('occurrence-moving', 'symmetric-first'),
        occurrenceReference('occurrence-third', 'symmetric-second'),
        datumReference('occurrence-base', 'datum-base-symmetry', 'symmetry-plane'),
      ],
      suppressed: false,
      extensions: advancedMateExtension('symmetry'),
    },
    {
      id: 'mate-path', name: 'Follower on spline', kind: 'path',
      occurrenceIds: ['occurrence-base', 'occurrence-moving'],
      references: [
        pathReference('occurrence-base', 'sketch-assembly-path', 'path'),
        datumReference('occurrence-moving', 'datum-moving-axis-x', 'follower'),
      ],
      suppressed: false,
      extensions: advancedMateExtension('path'),
    },
    {
      id: 'mate-linear-coupler', name: 'Two-to-one travel', kind: 'linear-coupler',
      occurrenceIds: ['occurrence-moving', 'occurrence-third'],
      references: [
        datumReference('occurrence-moving', 'datum-moving-axis-x', 'first-axis'),
        datumReference('occurrence-third', 'datum-moving-axis-x', 'second-axis'),
      ],
      suppressed: false,
      extensions: advancedMateExtension('linear-coupler', { ratio: 2, offset: 1 }),
    },
    {
      id: 'mate-limit-distance', name: 'Bounded station', kind: 'limit-distance',
      occurrenceIds: ['occurrence-base', 'occurrence-moving'],
      references: [
        datumReference('occurrence-base', 'datum-base-limit', 'anchor'),
        datumReference('occurrence-moving', 'datum-moving-limit', 'moving'),
      ],
      suppressed: false,
      extensions: advancedMateExtension('limit-distance', { minimum: 5, maximum: 10 }),
    },
    {
      id: 'mate-limit-angle', name: 'Bounded rotation', kind: 'limit-angle',
      occurrenceIds: ['occurrence-base', 'occurrence-moving'],
      references: [
        datumReference('occurrence-base', 'datum-base-limit', 'anchor'),
        datumReference('occurrence-moving', 'datum-moving-limit', 'moving'),
      ],
      suppressed: false,
      extensions: advancedMateExtension('limit-angle', { minimum: 20, maximum: 45 }),
    },
  ];
}

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

const source = sourceProject();
const sourceBytes = JSON.stringify(source);
const sourceAxisDatums = source.partDefinitions.flatMap((part: JsonRecord) => part.referenceGeometry)
  .filter((entry: JsonRecord) => entry.id === 'datum-base-axis-x' || entry.id === 'datum-moving-axis-x');
check('linear-coupler acceptance does not use genuine X-axis datums', sourceAxisDatums.length === 2
  && sourceAxisDatums.every((entry: JsonRecord) => entry.kind === 'axis'
    && entry.definition.direction[0] === 1
    && entry.definition.xDirection === undefined));
let lifecycle = source;
for (const mate of mateRecords()) lifecycle = createMate(lifecycle, mate);
check('direct CRUD did not persist all six advanced families',
  JSON.stringify(runtime.studioV5RootAssembly(lifecycle).mates.map((entry: JsonRecord) => entry.kind))
    === JSON.stringify(['width', 'symmetry', 'path', 'linear-coupler', 'limit-distance', 'limit-angle']));
for (const mate of mateRecords()) {
  const patch = mate.kind === 'linear-coupler'
    ? { name: `${mate.name} edited`, extensions: advancedMateExtension(mate.kind, { ratio: 3, offset: -2 }) }
    : mate.kind.startsWith('limit-')
      ? { name: `${mate.name} edited`, extensions: advancedMateExtension(mate.kind, { minimum: mate.kind === 'limit-angle' ? 10 : 2, maximum: mate.kind === 'limit-angle' ? 60 : 12 }) }
      : { name: `${mate.name} edited` };
  lifecycle = runtime.updateStudioV5AssemblyMate(lifecycle, mate.id, patch);
}
const reopenedLifecycle = runtime.canonicalStudioV5Project(JSON.parse(JSON.stringify(lifecycle)));
assert.deepEqual(reopenedLifecycle, lifecycle, 'advanced mate save/reopen was not canonical');

const typedCreated = agentTools.applyCadTransaction(source, {
  transactionId: 'transaction-advanced-mates-create',
  label: 'Create all advanced mate families',
  expectedRevision: 0,
  atomic: true,
  operations: mateRecords().map((mate) => {
    const input = structuredClone(mate);
    delete input.kind;
    input.mateKind = mate.kind;
    return { kind: 'mate.create', input };
  }),
}).project;
check('typed create omitted an advanced family', runtime.studioV5RootAssembly(typedCreated).mates.length === 6);
const typedUpdated = agentTools.applyCadTransaction(typedCreated, {
  transactionId: 'transaction-advanced-mates-update',
  label: 'Update all advanced mate names',
  expectedRevision: 0,
  atomic: true,
  operations: mateRecords().map((mate) => ({
    kind: 'mate.update',
    input: { mateId: mate.id, patch: { name: `${mate.name} typed edit` } },
  })),
}).project;
check('typed update did not edit every advanced mate',
  runtime.studioV5RootAssembly(typedUpdated).mates.every((entry: JsonRecord) => entry.name.endsWith('typed edit')));
const typedDeleted = agentTools.applyCadTransaction(typedUpdated, {
  transactionId: 'transaction-advanced-mates-delete',
  label: 'Delete all advanced mates',
  expectedRevision: 0,
  atomic: true,
  operations: [...mateRecords()].reverse().map((mate) => ({ kind: 'mate.delete', input: { mateId: mate.id } })),
}).project;
check('typed delete retained advanced mate records', runtime.studioV5RootAssembly(typedDeleted).mates.length === 0);
check('advanced typed lifecycle mutated its caller', JSON.stringify(source) === sourceBytes);

const recordsByKind = new Map(mateRecords().map((mate) => [mate.kind, mate]));
function requiredMate(kind: string): JsonRecord {
  const mate = recordsByKind.get(kind);
  check(`missing ${kind} test mate`, mate);
  return mate;
}
assert.throws(
  () => runtime.updateStudioV5AssemblyMate(lifecycle, 'mate-width', { kind: 'symmetry' }),
  /immutable|family|kind/i,
  'advanced mate family mutation did not fail closed',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('linear-coupler'), id: 'mate-zero-ratio',
    extensions: advancedMateExtension('linear-coupler', { ratio: 0, offset: 0 }),
  }),
  /ratio|nonzero/i,
  'zero linear-coupler ratio did not fail closed',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('limit-distance'), id: 'mate-inverted-limit',
    extensions: advancedMateExtension('limit-distance', { minimum: 10, maximum: 5 }),
  }),
  /minimum|maximum|ordered/i,
  'inverted distance limits did not fail closed',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('path'), id: 'mate-invalid-path-owner',
    references: [
      occurrenceReference('occurrence-base', 'path'),
      occurrenceReference('occurrence-moving', 'follower'),
    ],
  }),
  /path|sketch/i,
  'non-sketch path reference did not fail closed',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('path'), id: 'mate-untagged-path-sketch',
    references: [
      pathReference('occurrence-base', 'sketch-not-a-path', 'path'),
      requiredMate('path').references[1],
    ],
  }),
  /exact.*path sketch|polyline|spline/i,
  'path mate stored an untagged sketch as an exact path',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('path'), id: 'mate-helical-path-without-spans',
    references: [
      pathReference('occurrence-base', 'sketch-helical-path', 'path'),
      requiredMate('path').references[1],
    ],
  }),
  /exact.*path sketch|projected|composite/i,
  'path mate stored a helix without executable exact projection spans',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('path'), id: 'mate-path-point-follower',
    references: [
      requiredMate('path').references[0],
      datumReference('occurrence-moving', 'datum-moving-point', 'follower'),
    ],
  }),
  /follower|plane or axis.*datum|resolved.*point/i,
  'path mate stored a point datum without a direction-bearing follower frame',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('width'), id: 'mate-duplicate-width-role',
    references: requiredMate('width').references.map((entry: JsonRecord, index: number) =>
      index === 1 ? { ...entry, semanticPath: { role: 'width-first' } } : entry),
  }),
  /role|width-second/i,
  'duplicate width role did not fail closed',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('width'), id: 'mate-width-sketch-reference',
    references: [
      pathReference('occurrence-base', 'sketch-assembly-path', 'width-first'),
      ...requiredMate('width').references.slice(1),
    ],
  }),
  /occurrence|datum|analytic body face|reference kind/i,
  'width mate accepted an unsupported sketch frame',
);
const namedPlanarReference = bodyReference(
  'occurrence-base',
  'body-base-block',
  'width-first',
  'planar-face',
);
namedPlanarReference.semanticPath.name = 'Ffeature-width:side:left';
assert.throws(
  () => createMate(source, {
    ...requiredMate('width'),
    id: 'mate-width-named-planar-reference',
    references: [namedPlanarReference, ...requiredMate('width').references.slice(1)],
  }),
  /component occurrence origin|supported datum/i,
  'advanced mate stored an unproved named body-face reference',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('width'), id: 'mate-width-cylindrical-reference',
    references: [
      bodyReference('occurrence-base', 'body-base-block', 'width-first', 'cylindrical-face'),
      ...requiredMate('width').references.slice(1),
    ],
  }),
  /component occurrence origin|supported datum/i,
  'width mate accepted an unproved body-face reference',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('width'), id: 'mate-width-axis-datum',
    references: [
      datumReference('occurrence-base', 'datum-base-axis-x', 'width-first'),
      ...requiredMate('width').references.slice(1),
    ],
  }),
  /width-first|plane.*datum|resolved.*axis/i,
  'width mate stored an axis datum where its first planar reference is required',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('symmetry'), id: 'mate-symmetry-edge-reference',
    references: [
      bodyReference('occurrence-moving', 'body-moving-block', 'symmetric-first', 'linear-edge'),
      ...requiredMate('symmetry').references.slice(1),
    ],
  }),
  /component occurrence origin|supported datum/i,
  'symmetry mate accepted an unsupported body edge',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('symmetry'), id: 'mate-symmetry-nonplanar-plane-reference',
    references: [
      ...requiredMate('symmetry').references.slice(0, 2),
      bodyReference('occurrence-base', 'body-base-block', 'symmetry-plane', 'conical-face'),
    ],
  }),
  /component occurrence origin|supported datum/i,
  'symmetry mate accepted an unproved body-face reference',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('symmetry'), id: 'mate-symmetry-axis-plane-datum',
    references: [
      ...requiredMate('symmetry').references.slice(0, 2),
      datumReference('occurrence-base', 'datum-base-axis-x', 'symmetry-plane'),
    ],
  }),
  /symmetry-plane|plane.*datum|resolved.*axis/i,
  'symmetry mate stored an axis datum as its symmetry plane',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('symmetry'), id: 'mate-symmetry-axis-first-datum',
    references: [
      datumReference('occurrence-moving', 'datum-moving-axis-x', 'symmetric-first'),
      ...requiredMate('symmetry').references.slice(1),
    ],
  }),
  /symmetric-first|plane.*datum|resolved.*axis/i,
  'symmetry mate stored an axis datum outside the proved plane-based subset',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('linear-coupler'), id: 'mate-coupler-vertex-reference',
    references: [
      bodyReference('occurrence-moving', 'body-moving-block', 'first-axis', 'vertex'),
      requiredMate('linear-coupler').references[1],
    ],
  }),
  /component occurrence origin|supported datum/i,
  'linear coupler accepted an unsupported body vertex',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('linear-coupler'), id: 'mate-coupler-planar-reference',
    references: [
      bodyReference('occurrence-moving', 'body-moving-block', 'first-axis', 'planar-face'),
      requiredMate('linear-coupler').references[1],
    ],
  }),
  /component occurrence origin|supported datum/i,
  'linear coupler accepted an unproved planar body face',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('linear-coupler'), id: 'mate-coupler-spherical-reference',
    references: [
      requiredMate('linear-coupler').references[0],
      bodyReference('occurrence-third', 'body-moving-block', 'second-axis', 'spherical-face'),
    ],
  }),
  /component occurrence origin|supported datum/i,
  'linear coupler accepted an unproved spherical body face',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('linear-coupler'), id: 'mate-coupler-plane-datum',
    references: [
      datumReference('occurrence-moving', 'datum-moving-tab-first', 'first-axis'),
      requiredMate('linear-coupler').references[1],
    ],
  }),
  /first-axis|axis.*datum|resolved.*plane/i,
  'linear coupler stored a plane datum where an axis is required',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('limit-distance'), id: 'mate-distance-edge-reference',
    references: [
      bodyReference('occurrence-base', 'body-base-block', 'anchor', 'linear-edge'),
      requiredMate('limit-distance').references[1],
    ],
  }),
  /component occurrence origin|supported datum/i,
  'limit-distance mate accepted an unsupported body edge',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('limit-angle'), id: 'mate-angle-vertex-reference',
    references: [
      requiredMate('limit-angle').references[0],
      bodyReference('occurrence-moving', 'body-moving-block', 'moving', 'vertex'),
    ],
  }),
  /component occurrence origin|supported datum/i,
  'limit-angle mate accepted an unsupported body vertex',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('limit-distance'), id: 'mate-distance-point-datum',
    references: [
      datumReference('occurrence-base', 'datum-base-point', 'anchor'),
      requiredMate('limit-distance').references[1],
    ],
  }),
  /anchor|plane.*datum|resolved.*point/i,
  'limit-distance stored a point datum without a direction-bearing local frame',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('limit-distance'), id: 'mate-distance-axis-datum',
    references: [
      datumReference('occurrence-base', 'datum-base-axis-x', 'anchor'),
      requiredMate('limit-distance').references[1],
    ],
  }),
  /anchor|plane.*datum|resolved.*axis/i,
  'limit-distance stored an axis datum outside the proved plane subset',
);
assert.throws(
  () => createMate(source, {
    ...requiredMate('limit-angle'), id: 'mate-angle-axis-datum',
    references: [
      datumReference('occurrence-base', 'datum-base-axis-x', 'anchor'),
      requiredMate('limit-angle').references[1],
    ],
  }),
  /anchor|plane.*datum|resolved.*axis/i,
  'limit-angle stored an axis datum outside the proved plane subset',
);

const widthProject = projectForMates(
  [requiredMate('width')],
  { 'occurrence-moving': translation(7, 3, 0) },
);
const widthSolved = assemblyTools.solveStudioV5Assembly(widthProject, 'assembly-two-blocks');
check(`width solve failed ${JSON.stringify(widthSolved.errors)}`, widthSolved.errors.length === 0 && widthSolved.usedLastValid === false);
check('width mate did not center the tab midplane', near(widthSolved.transforms.get('occurrence-moving')[12], 0));
check('width mate incorrectly removed free in-plane translation', near(widthSolved.transforms.get('occurrence-moving')[13], 3));

const symmetryProject = projectForMates(
  [requiredMate('symmetry')],
  {
    'occurrence-moving': translation(-4, 2, 0),
    'occurrence-third': translation(9, -3, 0),
  },
);
const symmetrySolved = assemblyTools.solveStudioV5Assembly(symmetryProject, 'assembly-two-blocks');
check(`symmetry solve failed ${JSON.stringify(symmetrySolved.errors)}`, symmetrySolved.errors.length === 0 && symmetrySolved.usedLastValid === false);
const symmetricFirst = symmetrySolved.transforms.get('occurrence-moving').slice(12, 15);
const symmetricSecond = symmetrySolved.transforms.get('occurrence-third').slice(12, 15);
check('symmetry mate did not reflect positions across the exact datum plane',
  vectorNear(symmetricSecond, [-symmetricFirst[0]!, symmetricFirst[1]!, symmetricFirst[2]!]));

const pathProject = projectForMates(
  [requiredMate('path')],
  { 'occurrence-moving': translation(10, 10, 3) },
);
const pathSolved = assemblyTools.solveStudioV5Assembly(pathProject, 'assembly-two-blocks');
check(`path solve failed ${JSON.stringify(pathSolved.errors)}`, pathSolved.errors.length === 0 && pathSolved.usedLastValid === false);
const pathTransform = pathSolved.transforms.get('occurrence-moving');
check('path mate did not retain a genuine travel DOF', pathSolved.degreesOfFreedom.get('occurrence-moving') === 4);
check('path mate did not settle the follower at the exact spline midpoint',
  vectorNear(pathTransform.slice(12, 15), [10, 5, 0], 2e-5));
const pathResidual = pathSolved.residuals.find((entry: JsonRecord) => entry.mateId === 'mate-path');
check('path mate retained a solver residual', pathResidual?.satisfied === true && pathResidual.maxLinearResidual < 1e-6);

const editedPathProject = structuredClone(pathProject);
const editedPath = editedPathProject.partDefinitions
  .find((entry: JsonRecord) => entry.id === 'part-base-block').sketches
  .find((entry: JsonRecord) => entry.id === 'sketch-assembly-path');
editedPath.entities[0].points[1][1] = 8;
const canonicalEditedPath = runtime.canonicalStudioV5Project(editedPathProject);
const editedPathSolved = assemblyTools.solveStudioV5Assembly(canonicalEditedPath, 'assembly-two-blocks');
check(`edited path solve failed ${JSON.stringify(editedPathSolved.errors)}`, editedPathSolved.errors.length === 0);
check('associative spline edit did not move the path-mated occurrence',
  vectorNear(editedPathSolved.transforms.get('occurrence-moving').slice(12, 15), [10, 8, 0], 2e-5));
const exactPath = modelingTools.resolveStudioV5PathPreview(canonicalEditedPath, 'sketch-assembly-path', 'part-base-block');
check('path mate source stopped being an exactly evaluated cubic spline', exactPath.exactPointEvaluation === true
  && exactPath.exactTangentEvaluation === true
  && exactPath.projectionSegments.every((entry: JsonRecord) => entry.kind === 'bezier'));

const sliderMate = (id: string, movingId: string): JsonRecord => ({
  id,
  name: `${movingId} slider`,
  kind: 'slider',
  occurrenceIds: ['occurrence-base', movingId],
  references: [
    datumReference('occurrence-base', 'datum-base-axis-x', 'anchor'),
    datumReference(movingId, 'datum-moving-axis-x', 'moving'),
  ],
  suppressed: false,
});
const couplerProject = projectForMates(
  [
    sliderMate('mate-slider-first', 'occurrence-moving'),
    sliderMate('mate-slider-second', 'occurrence-third'),
    requiredMate('linear-coupler'),
  ],
  {
    'occurrence-moving': translation(4, 0, 0),
    'occurrence-third': translation(1, 0, 0),
  },
);
const couplerSolved = assemblyTools.solveStudioV5Assembly(couplerProject, 'assembly-two-blocks');
check(`linear coupler solve failed ${JSON.stringify(couplerSolved.errors)}`, couplerSolved.errors.length === 0);
const firstCoordinate = couplerSolved.transforms.get('occurrence-moving')[12];
const secondCoordinate = couplerSolved.transforms.get('occurrence-third')[12];
check('linear coupler did not satisfy signed ratio plus offset', near(firstCoordinate, 2 * secondCoordinate + 1));
check('linear coupler plus two sliders did not retain exactly one travel DOF',
  couplerSolved.solverComponents[0].degreesOfFreedom === 1);
const draggedCoupler = dragTools.previewStudioAssemblyDrag(
  couplerProject,
  'occurrence-moving',
  translation(9, 0, 0),
);
check('mate-driven drag did not propagate through the linear coupler',
  near(draggedCoupler.occurrenceTransforms['occurrence-moving'][12], 9)
    && near(draggedCoupler.occurrenceTransforms['occurrence-third'][12], 4));
const reopenedDraggedCoupler = runtime.canonicalStudioV5Project(JSON.parse(JSON.stringify(draggedCoupler.project)));
const reopenedCouplerSolve = assemblyTools.solveStudioV5Assembly(reopenedDraggedCoupler, 'assembly-two-blocks');
check('linear-coupler drag did not survive canonical save/reopen', reopenedCouplerSolve.errors.length === 0
  && near(reopenedCouplerSolve.transforms.get('occurrence-moving')[12], 9)
  && near(reopenedCouplerSolve.transforms.get('occurrence-third')[12], 4));

function distanceLimitProject(station: number): JsonRecord {
  return projectForMates(
    [requiredMate('limit-distance')],
    { 'occurrence-moving': translation(0, 0, station) },
  );
}
const distanceLow = assemblyTools.solveStudioV5Assembly(distanceLimitProject(2), 'assembly-two-blocks');
const distanceInside = assemblyTools.solveStudioV5Assembly(distanceLimitProject(7), 'assembly-two-blocks');
const distanceHigh = assemblyTools.solveStudioV5Assembly(distanceLimitProject(20), 'assembly-two-blocks');
check('limit-distance lower bound did not activate', near(distanceLow.transforms.get('occurrence-moving')[14], 5));
check('limit-distance changed an in-range station', near(distanceInside.transforms.get('occurrence-moving')[14], 7));
check('limit-distance upper bound did not activate', near(distanceHigh.transforms.get('occurrence-moving')[14], 10));

function angleBetweenZ(matrix: number[]): number {
  const cosine = Math.max(-1, Math.min(1, matrix[10]!));
  return Math.acos(cosine) * 180 / Math.PI;
}

function angleLimitProject(angle: number): JsonRecord {
  return projectForMates(
    [requiredMate('limit-angle')],
    { 'occurrence-moving': assemblyTools.studioV5RotationMatrix([0, 1, 0], angle) },
  );
}
const angleLow = assemblyTools.solveStudioV5Assembly(angleLimitProject(10), 'assembly-two-blocks');
const angleInside = assemblyTools.solveStudioV5Assembly(angleLimitProject(30), 'assembly-two-blocks');
const angleHigh = assemblyTools.solveStudioV5Assembly(angleLimitProject(90), 'assembly-two-blocks');
check('limit-angle lower bound did not activate', near(angleBetweenZ(angleLow.transforms.get('occurrence-moving')), 20, 2e-5));
check('limit-angle changed an in-range orientation', near(angleBetweenZ(angleInside.transforms.get('occurrence-moving')), 30, 2e-5));
check('limit-angle upper bound did not activate', near(angleBetweenZ(angleHigh.transforms.get('occurrence-moving')), 45, 2e-5));

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
  check(`${label} omitted exact shared-geometry source for ${occurrenceId}: ${JSON.stringify(body)}`, renderSource);
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
    requestId: `advanced-mates-${label}`,
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
  ['width', widthProject, ['occurrence-base', 'occurrence-moving']],
  ['symmetry', symmetryProject, ['occurrence-base', 'occurrence-moving', 'occurrence-third']],
  ['path', pathProject, ['occurrence-base', 'occurrence-moving']],
  ['path-edited', canonicalEditedPath, ['occurrence-base', 'occurrence-moving']],
  ['linear-coupler-drag', reopenedDraggedCoupler, ['occurrence-base', 'occurrence-moving', 'occurrence-third']],
  ['limit-distance', distanceHigh ? distanceLimitProject(20) : null, ['occurrence-base', 'occurrence-moving']],
  ['limit-angle', angleHigh ? angleLimitProject(90) : null, ['occurrence-base', 'occurrence-moving']],
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

const pathBody = exactAssemblyBody(exactResults.get('path')!, 'occurrence-moving', 'path');
const editedPathBody = exactAssemblyBody(exactResults.get('path-edited')!, 'occurrence-moving', 'path-edited');
check('associative path edit did not change exact occurrence bounds',
  near(editedPathBody.occurrenceBody.geometry.bounds[0][1] - pathBody.occurrenceBody.geometry.bounds[0][1], 3, 2e-5)
    && near(editedPathBody.occurrenceBody.geometry.bounds[1][1] - pathBody.occurrenceBody.geometry.bounds[1][1], 3, 2e-5));

let freshKernel: HeadlessKernel | null = null;
let freshPathResult: JsonRecord | null = null;
try {
  freshKernel = await createHeadlessKernel();
  await freshKernel.waitForKernel();
  freshPathResult = await rebuildExact(freshKernel, canonicalEditedPath, 1, 'path-edited-fresh-worker');
} finally {
  await freshKernel?.dispose();
}
const warmEditedPathBody = exactAssemblyBody(exactResults.get('path-edited')!, 'occurrence-moving', 'path-edited');
const freshEditedPathBody = exactAssemblyBody(freshPathResult!, 'occurrence-moving', 'path-edited-fresh-worker');
check('fresh worker omitted nonempty serialized path-mated B-rep bytes',
  warmEditedPathBody.exactBrep.length > 100 && freshEditedPathBody.exactBrep.length > 100);
check('fresh worker changed the authoritative shared render-source B-rep bytes',
  freshEditedPathBody.exactBrep === warmEditedPathBody.exactBrep);
check('fresh worker changed the authoritative shared render-source exact bounds',
  JSON.stringify(freshEditedPathBody.renderSource.geometry.bounds)
    === JSON.stringify(warmEditedPathBody.renderSource.geometry.bounds));
check('fresh worker changed the exact path-mated occurrence bounds or transform',
  JSON.stringify(freshEditedPathBody.occurrenceBody.geometry.bounds)
      === JSON.stringify(warmEditedPathBody.occurrenceBody.geometry.bounds)
    && JSON.stringify(freshEditedPathBody.occurrenceBody.renderTransform)
      === JSON.stringify(warmEditedPathBody.occurrenceBody.renderTransform));

console.log(JSON.stringify({
  schema: 'partmode.advanced-mate/v1',
  families: mateRecords().map((mate) => mate.kind),
  lifecycle: { created: 6, updated: 6, deleted: 6, canonicalReopen: true },
  width: { translation: widthSolved.transforms.get('occurrence-moving').slice(12, 15) },
  symmetry: { first: symmetricFirst, second: symmetricSecond },
  path: {
    before: pathTransform.slice(12, 15),
    after: editedPathSolved.transforms.get('occurrence-moving').slice(12, 15),
    degreesOfFreedom: pathSolved.degreesOfFreedom.get('occurrence-moving'),
  },
  linearCoupler: { first: 9, second: 4, mateDrivenDrag: true },
  limitDistance: { below: 5, inside: 7, above: 10 },
  limitAngle: { below: 20, inside: 30, above: 45 },
  exactWorkerCases: exactCases.map(([label]) => label),
  freshWorker: true,
}, null, 2));
