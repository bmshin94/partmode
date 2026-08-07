import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Advanced pattern smoke failed: ${label}`);
}

function closeTo(actual: number, expected: number, tolerance = 2e-5): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function throws(label: string, action: () => unknown, pattern: RegExp): void {
  let error: unknown = null;
  try { action(); } catch (candidate) { error = candidate; }
  check(label, error && pattern.test(String((error as Error).message || error)));
}

const root = process.cwd();
const moduleAt = async (path: string) => import(pathToFileURL(resolve(root, path)).href) as Promise<any>;
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const projectModule = await moduleAt('src/static/studio-project-v5.js');
const agent = await moduleAt('src/static/studio-agent-service.js');
const uiRegistry = await moduleAt('src/static/studio-v6-ui-registry.js');

const patternControl = uiRegistry.cadUiCommandDefinition('model.pattern');
const patternKindField = patternControl?.fields?.find((entry: JsonRecord) => entry.id === 'patternKind');
const distributionField = patternControl?.fields?.find((entry: JsonRecord) => entry.id === 'distribution');
const patternFieldIds = new Set((patternControl?.fields || []).map((entry: JsonRecord) => entry.id));
check('visible pattern command does not advertise the advanced pattern modes', patternControl?.adapter === 'available'
  && patternKindField?.values?.includes('curve')
  && patternKindField?.values?.includes('sketch')
  && patternKindField?.values?.includes('fill')
  && patternKindField?.values?.includes('variable')
  && distributionField?.values?.includes('table')
  && distributionField?.values?.includes('points')
  && distributionField?.values?.includes('fill')
  && ['pointSketch', 'pointIds', 'boundarySketch', 'fillLayout', 'fillRotation', 'boundaryMargin', 'seedX', 'seedY', 'maximumCount', 'variableInstances']
    .every((fieldId) => patternFieldIds.has(fieldId)));

const fixture = JSON.parse(await readFile(resolve(root, 'tests/body-pattern-runtime/body-patterns.partmode.json'), 'utf8')) as JsonRecord;
fixture.partDefinitions[0].bodyPatterns = [];
const sourceHeight = fixture.parameters.find((entry: JsonRecord) => entry.name === 'source_height');
check('source-height fixture parameter is missing', sourceHeight);
fixture.parameters = fixture.parameters.filter((entry: JsonRecord) => entry !== sourceHeight);
fixture.partDefinitions[0].parameters.push(sourceHeight);
let base = projectModule.prepareStudioV5Project(fixture) as JsonRecord;
base = runtime.createStudioV5Datum(base, {
  id: 'datum-pattern-z-axis',
  name: 'Pattern Z axis',
  kind: 'axis',
  definition: { origin: [0, 0, 0], direction: [0, 0, 1] },
});
base = runtime.createStudioV5PathSketch(base, {
  id: 'sketch-pattern-path',
  name: 'Pattern path',
  kind: 'polyline',
  points: [[0, 0, 0], [0, 0, 30], [30, 0, 30]],
});
base = runtime.createStudioV5Datum(base, {
  id: 'datum-pattern-xy-plane',
  name: 'Pattern XY plane',
  kind: 'plane',
  definition: { mode: 'principal', origin: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
});

const pointSketchSource = {
  entities: [
    { id: 'pattern-seed', kind: 'point', at: [0, 0], fixed: true },
    { id: 'pattern-point-x', kind: 'point', at: [20, 0] },
    { id: 'pattern-point-y', kind: 'point', at: [0, 18] },
  ],
  constraints: [
    { id: 'pattern-point-x-horizontal', kind: 'horizontalDistance', a: 'pattern-seed', b: 'pattern-point-x', value: 20 },
    { id: 'pattern-point-x-vertical', kind: 'verticalDistance', a: 'pattern-seed', b: 'pattern-point-x', value: 0 },
    { id: 'pattern-point-y-horizontal', kind: 'horizontalDistance', a: 'pattern-seed', b: 'pattern-point-y', value: 0 },
    { id: 'pattern-point-y-vertical', kind: 'verticalDistance', a: 'pattern-seed', b: 'pattern-point-y', value: 18 },
  ],
};

const setupTransaction = agent.applyCadTransaction(base, {
  transactionId: 'transaction-advanced-pattern-sources',
  label: 'Create advanced pattern sources',
  expectedRevision: 0,
  atomic: true,
  operations: [
    {
      kind: 'sketch.constrained.create',
      input: {
        id: 'sketch-pattern-points', name: 'Solved pattern points', plane: 'XY', z: 0,
        constrained: pointSketchSource,
      },
    },
    {
      kind: 'sketch.profile.create',
      input: {
        id: 'sketch-fill-boundary', name: 'Fill boundary', planeDatumId: 'datum-pattern-xy-plane',
        curveKind: 'polyline', points: [[-20, -15], [20, -15], [20, 15], [-20, 15]],
      },
    },
  ],
});
base = setupTransaction.project as JsonRecord;

function canonical(candidate: JsonRecord, label: string): JsonRecord {
  const saved = JSON.stringify(projectModule.prepareStudioV5Project(candidate));
  const reopened = projectModule.parseStudioV5Project(saved) as JsonRecord;
  check(`${label} changed across canonical save/reopen`, JSON.stringify(reopened) === saved);
  return reopened;
}

function applyTransaction(source: JsonRecord, transactionId: string, label: string, operations: JsonRecord[]): JsonRecord {
  return agent.applyCadTransaction(source, {
    transactionId, label, expectedRevision: 0, atomic: true, operations,
  }).project as JsonRecord;
}

function withPattern(projectId: string, input: JsonRecord, sourceProject = base): JsonRecord {
  const source = structuredClone(sourceProject);
  source.projectId = projectId;
  const result = applyTransaction(source, `transaction-${input.id}`, `Create ${input.name}`, [{ kind: 'pattern.create', input }]);
  const stored = result.partDefinitions[0].bodyPatterns.find((entry: JsonRecord) => entry.id === input.id);
  check(`${input.id} was not persisted`, stored?.kind === input.kind
    && stored.definition.distribution === input.definition.distribution);
  return canonical(result, input.id);
}

const linear = withPattern('project-linear-table-pattern', {
  id: 'pattern-linear-table',
  name: 'Linear table pattern',
  kind: 'linear',
  sourceBodyId: 'body-pattern-source',
  directionDatumIds: ['datum-pattern-direction'],
  outputMode: 'union',
  definition: {
    count: 4,
    distribution: 'table',
    orientation: 'preserve',
    symmetric: false,
    positions: [8, 16, 24],
  },
});

const circular = withPattern('project-circular-table-pattern', {
  id: 'pattern-circular-table',
  name: 'Circular table pattern',
  kind: 'circular',
  sourceBodyId: 'body-pattern-source',
  axisDatumId: 'datum-pattern-z-axis',
  outputMode: 'linked',
  definition: {
    count: 4,
    distribution: 'table',
    orientation: 'rotate',
    symmetric: false,
    angles: [30, 90, 210],
  },
});

const curve = withPattern('project-curve-table-pattern', {
  id: 'pattern-curve-table',
  name: 'Curve table pattern',
  kind: 'curve',
  sourceBodyId: 'body-pattern-source',
  pathSketchId: 'sketch-pattern-path',
  outputMode: 'linked',
  definition: {
    count: 4,
    distribution: 'table',
    orientation: 'fixed',
    symmetric: false,
    parameters: [0.25, 0.5, 0.75],
  },
});

const sketchPattern = withPattern('project-sketch-point-pattern', {
  id: 'pattern-sketch-points',
  name: 'Solved sketch point pattern',
  kind: 'sketch',
  sourceBodyId: 'body-pattern-source',
  pointSketchId: 'sketch-pattern-points',
  outputMode: 'linked',
  definition: {
    count: 3,
    distribution: 'points',
    orientation: 'preserve',
    pointIds: ['pattern-seed', 'pattern-point-x', 'pattern-point-y'],
  },
});

const editedPointSketchSource = structuredClone(pointSketchSource);
const editedPointConstraint = editedPointSketchSource.constraints.find((entry: JsonRecord) => entry.id === 'pattern-point-x-horizontal');
check('editable point-pattern constraint is missing', editedPointConstraint);
editedPointConstraint.value = 26;
const sketchPatternEdited = canonical(applyTransaction(
  sketchPattern,
  'transaction-edit-sketch-pattern-points',
  'Edit solved sketch pattern point',
  [{
    kind: 'sketch.constrained.update',
    input: { sketchId: 'sketch-pattern-points', patch: { constrained: editedPointSketchSource } },
  }],
), 'edited sketch-point pattern');

const fillInput = (id: string, name: string, layout: 'square' | 'triangular') => ({
  id,
  name,
  kind: 'fill',
  sourceBodyId: 'body-pattern-source',
  boundarySketchId: 'sketch-fill-boundary',
  outputMode: 'linked',
  definition: {
    distribution: 'fill',
    orientation: 'preserve',
    layout,
    spacing: 10,
    rotation: 0,
    boundaryMargin: 4,
    seed: [0, 0],
    maximumCount: 64,
  },
});
const fillSquare = withPattern(
  'project-fill-square-pattern',
  fillInput('pattern-fill-square', 'Square fill pattern', 'square'),
);
const fillTriangular = withPattern(
  'project-fill-triangular-pattern',
  fillInput('pattern-fill-triangular', 'Triangular fill pattern', 'triangular'),
);
const expandedBoundary = [[-20, -15], [30, -15], [30, 25], [-20, 25]];
const fillSquareEdited = canonical(applyTransaction(
  fillSquare,
  'transaction-edit-square-fill-boundary',
  'Edit square fill boundary',
  [{ kind: 'sketch.advanced.update', input: { sketchId: 'sketch-fill-boundary', patch: { points: expandedBoundary } } }],
), 'edited square fill pattern');
const fillTriangularEdited = canonical(applyTransaction(
  fillTriangular,
  'transaction-edit-triangular-fill-boundary',
  'Edit triangular fill boundary',
  [{ kind: 'sketch.advanced.update', input: { sketchId: 'sketch-fill-boundary', patch: { points: expandedBoundary } } }],
), 'edited triangular fill pattern');

const variablePattern = withPattern('project-variable-pattern', {
  id: 'pattern-variable-height',
  name: 'Variable height pattern',
  kind: 'variable',
  sourceBodyId: 'body-pattern-source',
  directionDatumId: 'datum-pattern-direction',
  outputMode: 'linked',
  definition: {
    count: 3,
    distribution: 'table',
    orientation: 'preserve',
    instances: [
      { position: 18, parameterOverrides: { source_height: 10 } },
      { position: 36, parameterOverrides: { source_height: 12 } },
    ],
  },
});
const variablePatternEdited = canonical(applyTransaction(
  variablePattern,
  'transaction-edit-variable-pattern',
  'Edit variable pattern rows',
  [{
    kind: 'pattern.update',
    input: {
      patternId: 'pattern-variable-height',
      patch: {
        instances: [
          { position: 22, parameterOverrides: { source_height: 11 } },
          { position: 44, parameterOverrides: { source_height: 14 } },
        ],
      },
    },
  }],
), 'edited variable pattern');

throws('dependent point sketch deletion was not guarded', () => agent.applyCadTransaction(sketchPattern, {
  transactionId: 'transaction-delete-dependent-point-sketch',
  label: 'Delete dependent point sketch', expectedRevision: 0, atomic: true,
  operations: [{ kind: 'sketch.constrained.delete', input: { sketchId: 'sketch-pattern-points' } }],
}), /used by|point-sketch|does not resolve/u);
const sketchDeleted = canonical(applyTransaction(
  sketchPattern,
  'transaction-delete-sketch-pattern',
  'Delete sketch pattern and source',
  [
    { kind: 'pattern.delete', input: { patternId: 'pattern-sketch-points' } },
    { kind: 'sketch.constrained.delete', input: { sketchId: 'sketch-pattern-points' } },
  ],
), 'deleted sketch pattern');
check('typed pattern/source deletion left stale records',
  !sketchDeleted.partDefinitions[0].bodyPatterns.some((entry: JsonRecord) => entry.id === 'pattern-sketch-points')
  && !sketchDeleted.partDefinitions[0].sketches.some((entry: JsonRecord) => entry.id === 'sketch-pattern-points'));

const tamperedSketchPattern = structuredClone(sketchPattern);
tamperedSketchPattern.partDefinitions[0].bodyPatterns[0].definition.pointIds[2] = 'pattern-point-x';
throws('tampered duplicate sketch point IDs reopened',
  () => projectModule.prepareStudioV5Project(tamperedSketchPattern), /repeats|duplicate/u);
const tamperedFillPattern = structuredClone(fillSquare);
tamperedFillPattern.partDefinitions[0].bodyPatterns[0].definition.maximumCount = 2;
throws('tampered fill safety cap reopened',
  () => projectModule.prepareStudioV5Project(tamperedFillPattern), /generated occurrence limit|valid current fill recipe/u);
const tamperedFillSupportKind = structuredClone(fillSquare);
const tamperedFillSupportKindSketch = tamperedFillSupportKind.partDefinitions[0].sketches
  .find((entry: JsonRecord) => entry.id === 'sketch-fill-boundary');
check('tampered fill support fixture is missing', tamperedFillSupportKindSketch);
tamperedFillSupportKindSketch.support.ownerKind = 'sketch';
tamperedFillSupportKindSketch.support.ownerId = 'sketch-pattern-path';
throws('persisted fill boundary accepted non-datum support',
  () => projectModule.prepareStudioV5Project(tamperedFillSupportKind), /must retain datum-plane support/u);
const tamperedFillSupportDatum = structuredClone(fillSquare);
const tamperedFillSupportDatumSketch = tamperedFillSupportDatum.partDefinitions[0].sketches
  .find((entry: JsonRecord) => entry.id === 'sketch-fill-boundary');
check('tampered fill datum fixture is missing', tamperedFillSupportDatumSketch);
tamperedFillSupportDatumSketch.support.ownerId = 'datum-pattern-direction';
throws('persisted fill boundary accepted axis-datum support',
  () => projectModule.prepareStudioV5Project(tamperedFillSupportDatum), /must retain datum-plane support/u);
const tamperedVariablePattern = structuredClone(variablePattern);
tamperedVariablePattern.partDefinitions[0].bodyPatterns[0].definition.instances[0].parameterOverrides.source_height = '10';
throws('tampered variable expression override reopened',
  () => projectModule.prepareStudioV5Project(tamperedVariablePattern), /finite literal number/u);
const tamperedVariableSeedRow = structuredClone(variablePattern);
tamperedVariableSeedRow.partDefinitions[0].bodyPatterns[0].definition.instances[1].parameterOverrides.source_height = 8;
throws('persisted variable pattern accepted one unchanged seed row',
  () => projectModule.prepareStudioV5Project(tamperedVariableSeedRow), /must change at least one driving parameter/u);
const tamperedVariableDuplicate = structuredClone(variablePattern);
tamperedVariableDuplicate.partDefinitions[0].bodyPatterns[0].definition.instances[1].parameterOverrides.source_height = 10;
throws('persisted variable pattern accepted duplicate override signatures',
  () => projectModule.prepareStudioV5Project(tamperedVariableDuplicate), /distinct parameter variants/u);

const sketchWrongSeed = withPattern('project-sketch-pattern-wrong-seed', {
  id: 'pattern-sketch-wrong-seed',
  name: 'Wrong-seed sketch pattern',
  kind: 'sketch', sourceBodyId: 'body-pattern-source', pointSketchId: 'sketch-pattern-points', outputMode: 'linked',
  definition: { count: 2, distribution: 'points', orientation: 'preserve', pointIds: ['pattern-point-x', 'pattern-seed'] },
});
const fillWrongSeed = withPattern('project-fill-pattern-wrong-seed', {
  ...fillInput('pattern-fill-wrong-seed', 'Wrong-seed fill pattern', 'square'),
  definition: { ...fillInput('unused', 'unused', 'square').definition, seed: [5, 0] },
});

const invalidSnapshot = JSON.stringify(base);
throws('linear table cardinality did not fail closed', () => agent.applyCadTransaction(base, {
  transactionId: 'transaction-invalid-pattern-table',
  label: 'Invalid table pattern',
  expectedRevision: 0,
  atomic: true,
  operations: [{
    kind: 'pattern.create',
    input: {
      id: 'pattern-invalid-table', kind: 'linear', sourceBodyId: 'body-pattern-source',
      directionDatumIds: ['datum-pattern-direction'],
      definition: { count: 4, distribution: 'table', orientation: 'preserve', positions: [8, 16] },
    },
  }],
}), /one generated position per occurrence/u);
check('failed table transaction mutated its source', JSON.stringify(base) === invalidSnapshot);
throws('curve parameter outside the path did not fail closed', () => agent.applyCadTransaction(base, {
  transactionId: 'transaction-invalid-curve-table',
  label: 'Invalid curve table pattern',
  expectedRevision: 0,
  atomic: true,
  operations: [{
    kind: 'pattern.create',
    input: {
      id: 'pattern-invalid-curve', kind: 'curve', sourceBodyId: 'body-pattern-source', pathSketchId: 'sketch-pattern-path',
      definition: { count: 2, distribution: 'table', orientation: 'fixed', parameters: [1.1] },
    },
  }],
}), /must evaluate from 0 to 1/u);
throws('sketch pattern accepted a missing solved point ID', () => agent.applyCadTransaction(base, {
  transactionId: 'transaction-invalid-sketch-point-id', label: 'Invalid sketch point', expectedRevision: 0, atomic: true,
  operations: [{
    kind: 'pattern.create',
    input: {
      id: 'pattern-invalid-sketch-point', kind: 'sketch', sourceBodyId: 'body-pattern-source',
      pointSketchId: 'sketch-pattern-points',
      definition: { distribution: 'points', orientation: 'preserve', pointIds: ['pattern-seed', 'missing-point'] },
    },
  }],
}), /is not an authored local point/u);
throws('sketch pattern accepted union output', () => agent.applyCadTransaction(base, {
  transactionId: 'transaction-invalid-sketch-union', label: 'Invalid sketch union', expectedRevision: 0, atomic: true,
  operations: [{
    kind: 'pattern.create',
    input: {
      id: 'pattern-invalid-sketch-union', kind: 'sketch', sourceBodyId: 'body-pattern-source',
      pointSketchId: 'sketch-pattern-points', outputMode: 'union',
      definition: { distribution: 'points', orientation: 'preserve', pointIds: ['pattern-seed', 'pattern-point-x'] },
    },
  }],
}), /support linked output only/u);
throws('fill pattern accepted skipped dynamic lattice indices', () => agent.applyCadTransaction(base, {
  transactionId: 'transaction-invalid-fill-skipped', label: 'Invalid fill skip', expectedRevision: 0, atomic: true,
  operations: [{
    kind: 'pattern.create',
    input: { ...fillInput('pattern-invalid-fill-skipped', 'Invalid fill skip', 'square'), skippedIndices: [1] },
  }],
}), /skippedIndices must stay empty/u);
throws('variable pattern accepted duplicate evaluated positions', () => agent.applyCadTransaction(base, {
  transactionId: 'transaction-invalid-variable-positions', label: 'Invalid variable positions', expectedRevision: 0, atomic: true,
  operations: [{
    kind: 'pattern.create',
    input: {
      id: 'pattern-invalid-variable-positions', kind: 'variable', sourceBodyId: 'body-pattern-source',
      directionDatumId: 'datum-pattern-direction',
      definition: {
        distribution: 'table', orientation: 'preserve',
        instances: [
          { position: 18, parameterOverrides: { source_height: 10 } },
          { position: 18, parameterOverrides: { source_height: 12 } },
        ],
      },
    },
  }],
}), /positions must not repeat/u);
throws('variable pattern accepted a project-scoped override', () => agent.applyCadTransaction(base, {
  transactionId: 'transaction-invalid-variable-scope', label: 'Invalid variable scope', expectedRevision: 0, atomic: true,
  operations: [{
    kind: 'pattern.create',
    input: {
      id: 'pattern-invalid-variable-scope', kind: 'variable', sourceBodyId: 'body-pattern-source',
      directionDatumId: 'datum-pattern-direction',
      definition: {
        distribution: 'table', orientation: 'preserve',
        instances: [{ position: 18, parameterOverrides: { linked_spacing: 40 } }],
      },
    },
  }],
}), /must name a part-local parameter/u);
throws('variable pattern accepted rows that do not change the seed', () => agent.applyCadTransaction(base, {
  transactionId: 'transaction-invalid-variable-no-change', label: 'Invalid variable no-change', expectedRevision: 0, atomic: true,
  operations: [{
    kind: 'pattern.create',
    input: {
      id: 'pattern-invalid-variable-no-change', kind: 'variable', sourceBodyId: 'body-pattern-source',
      directionDatumId: 'datum-pattern-direction',
      definition: {
        distribution: 'table', orientation: 'preserve',
        instances: [{ position: 18, parameterOverrides: { source_height: 8 } }],
      },
    },
  }],
}), /change at least one driving parameter/u);
throws('variable pattern accepted one unchanged row beside a changed row', () => agent.applyCadTransaction(base, {
  transactionId: 'transaction-invalid-variable-one-seed-row', label: 'Invalid variable seed row', expectedRevision: 0, atomic: true,
  operations: [{
    kind: 'pattern.create',
    input: {
      id: 'pattern-invalid-variable-one-seed-row', kind: 'variable', sourceBodyId: 'body-pattern-source',
      directionDatumId: 'datum-pattern-direction',
      definition: {
        distribution: 'table', orientation: 'preserve',
        instances: [
          { position: 18, parameterOverrides: { source_height: 10 } },
          { position: 36, parameterOverrides: { source_height: 8 } },
        ],
      },
    },
  }],
}), /Every variable pattern row must change at least one driving parameter/u);
throws('variable pattern accepted duplicate override signatures', () => agent.applyCadTransaction(base, {
  transactionId: 'transaction-invalid-variable-duplicate-overrides', label: 'Invalid variable duplicate overrides', expectedRevision: 0, atomic: true,
  operations: [{
    kind: 'pattern.create',
    input: {
      id: 'pattern-invalid-variable-duplicate-overrides', kind: 'variable', sourceBodyId: 'body-pattern-source',
      directionDatumId: 'datum-pattern-direction',
      definition: {
        distribution: 'table', orientation: 'preserve',
        instances: [
          { position: 18, parameterOverrides: { source_height: 10 } },
          { position: 36, parameterOverrides: { source_height: 10 } },
        ],
      },
    },
  }],
}), /distinct parameter variants/u);
check('failed advanced-pattern transactions mutated their source', JSON.stringify(base) === invalidSnapshot);

function exactPatternOccurrences(result: JsonRecord, patternId: string): JsonRecord[] {
  return result.bodies
    .filter((entry: JsonRecord) => entry.patternInstance?.patternId === patternId && entry.patternInstance?.fused !== true)
    .sort((left: JsonRecord, right: JsonRecord) => left.patternInstance.index - right.patternInstance.index);
}

function assertExactOccurrence(entry: JsonRecord, label: string): void {
  check(`${label} has an exact error`, !entry.error && entry.lastValid === false);
  check(`${label} is not one valid exact linked solid: ${JSON.stringify(entry)}`, entry.geometry?.valid === true
    && entry.geometry?.brepValid === true
    && entry.geometry?.solidCount === 1
    && entry.renderSourceBodyId === 'body-pattern-source'
    && Array.isArray(entry.renderTransform)
    && entry.renderTransform.length === 16);
}

function assertCompleteTopology(entry: JsonRecord, label: string): void {
  check(`${label} exact topology is incomplete`, entry.mesh?.topologyCounts?.faces === entry.mesh?.topologyFaces?.length
    && entry.mesh?.topologyCounts?.edges === entry.mesh?.edges?.length
    && entry.mesh?.topologyCounts?.vertices === entry.mesh?.topologyVertices?.length
    && entry.mesh.topologyFaces.every((topology: JsonRecord) => typeof topology.name === 'string')
    && entry.mesh.edges.every((topology: JsonRecord) => typeof topology.name === 'string')
    && entry.mesh.topologyVertices.every((topology: JsonRecord) => typeof topology.name === 'string'));
}

function assertOwnedExactOccurrence(entry: JsonRecord, label: string): void {
  check(`${label} has an exact error`, !entry.error && entry.lastValid === false);
  check(`${label} did not publish one independently rebuilt exact solid: ${JSON.stringify(entry)}`,
    entry.geometry?.valid === true
      && entry.geometry?.brepValid === true
      && entry.geometry?.solidCount === 1
      && typeof entry.exactBrep === 'string'
      && entry.exactBrep.length > 100
      && entry.renderSourceBodyId === undefined
      && entry.sharesSourceGeometry === false);
  assertCompleteTopology(entry, label);
}

function checkBounds(actual: number[][], expected: number[][], label: string): void {
  check(label, actual?.flat().every((value: number, index: number) => closeTo(value, expected.flat()[index]!)));
}

let kernel: HeadlessKernel | null = null;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();
  let revision = 0;
  const rebuildRaw = async (document: JsonRecord, label: string): Promise<JsonRecord> => {
    revision += 1;
    const result = await kernel!.request({
      kind: 'rebuild', requestId: `advanced-pattern-${revision}-${label}`,
      projectId: document.projectId, revision, document, includeExactBrep: true,
    }, 180_000) as JsonRecord;
    check(`${label} did not return the current authored document hash`,
      result.effectiveDocumentHash === runtime.studioV5CanonicalHash(document));
    return result;
  };
  const rebuild = async (document: JsonRecord, label: string): Promise<JsonRecord> => {
    const result = await rebuildRaw(document, label);
    check(`${label} exact rebuild failed: ${JSON.stringify(result.errors || [])}`,
      result.kind === 'rebuild-result' && result.errors?.length === 0 && result.warnings?.length === 0);
    return result;
  };

  const linearResult = await rebuild(linear, 'linear-table');
  const linearFused = linearResult.bodies.find((entry: JsonRecord) => entry.patternInstance?.patternId === 'pattern-linear-table'
    && entry.patternInstance?.fused === true);
  check(`linear table union did not publish one exact fused B-rep: ${JSON.stringify(linearFused)}`, linearFused?.geometry?.valid === true
    && linearFused?.geometry?.brepValid === true
    && linearFused?.geometry?.solidCount === 1
    && typeof linearFused?.exactBrep === 'string'
    && linearFused.exactBrep.length > 100
    && closeTo(linearFused.geometry.volume, 2304, 2e-4));
  checkBounds(linearFused.geometry.bounds, [[-6, -4, 0], [30, 4, 8]], 'linear table positions changed exact fused bounds');
  check('linear table fused topology is incomplete', linearFused.mesh?.topologyCounts?.faces === linearFused.mesh.topologyFaces.length
    && linearFused.mesh?.topologyCounts?.edges === linearFused.mesh.edges.length
    && linearFused.mesh?.topologyCounts?.vertices === linearFused.mesh.topologyVertices.length
    && linearFused.mesh.topologyFaces.every((entry: JsonRecord) => typeof entry.name === 'string')
    && linearFused.mesh.edges.every((entry: JsonRecord) => typeof entry.name === 'string')
    && linearFused.mesh.topologyVertices.every((entry: JsonRecord) => typeof entry.name === 'string'));

  const circularResult = await rebuild(circular, 'circular-table');
  const circularOccurrences = exactPatternOccurrences(circularResult, 'pattern-circular-table');
  check('circular table did not create three exact occurrences', circularOccurrences.length === 3);
  circularOccurrences.forEach((entry, index) => assertExactOccurrence(entry, `circular occurrence ${index + 1}`));
  const circularExpectedBounds = [
    [[-7.196152423, -6.464101615, 0], [7.196152423, 6.464101615, 8]],
    [[-4, -6, 0], [4, 6, 8]],
    [[-7.196152423, -6.464101615, 0], [7.196152423, 6.464101615, 8]],
  ];
  circularOccurrences.forEach((entry, index) => checkBounds(
    entry.geometry.bounds,
    circularExpectedBounds[index]!,
    `circular table angle ${[30, 90, 210][index]} changed exact bounds`,
  ));

  const curveResult = await rebuild(curve, 'curve-table');
  const curveOccurrences = exactPatternOccurrences(curveResult, 'pattern-curve-table');
  check('curve table did not create three exact occurrences', curveOccurrences.length === 3);
  curveOccurrences.forEach((entry, index) => assertExactOccurrence(entry, `curve occurrence ${index + 1}`));
  const curveExpectedBounds = [
    [[-6, -4, 15], [6, 4, 23]],
    [[-6, -4, 30], [6, 4, 38]],
    [[9, -4, 30], [21, 4, 38]],
  ];
  curveOccurrences.forEach((entry, index) => checkBounds(
    entry.geometry.bounds,
    curveExpectedBounds[index]!,
    `curve table parameter ${[0.25, 0.5, 0.75][index]} changed exact bounds`,
  ));

  const sketchResult = await rebuild(sketchPattern, 'sketch-points');
  const sketchOccurrences = exactPatternOccurrences(sketchResult, 'pattern-sketch-points');
  check('sketch-point pattern did not create two exact solved-point occurrences', sketchOccurrences.length === 2);
  sketchOccurrences.forEach((entry, index) => assertExactOccurrence(entry, `sketch-point occurrence ${index + 1}`));
  check('sketch-point identities did not preserve the ordered solved point IDs',
    sketchOccurrences[0]?.patternInstance?.placementKey === 'pattern-point-x'
      && sketchOccurrences[1]?.patternInstance?.placementKey === 'pattern-point-y');
  checkBounds(sketchOccurrences[0]!.geometry.bounds, [[14, -4, 0], [26, 4, 8]], 'solved X sketch point changed exact bounds');
  checkBounds(sketchOccurrences[1]!.geometry.bounds, [[-6, 14, 0], [6, 22, 8]], 'solved Y sketch point changed exact bounds');

  const sketchEditedResult = await rebuild(sketchPatternEdited, 'sketch-points-edited');
  const sketchEditedOccurrences = exactPatternOccurrences(sketchEditedResult, 'pattern-sketch-points');
  check('edited sketch-point pattern did not retain two exact occurrences', sketchEditedOccurrences.length === 2);
  checkBounds(sketchEditedOccurrences[0]!.geometry.bounds, [[20, -4, 0], [32, 4, 8]], 'edited solved X sketch point did not recompute');
  checkBounds(sketchEditedOccurrences[1]!.geometry.bounds, [[-6, 14, 0], [6, 22, 8]], 'unmodified solved Y sketch point moved unexpectedly');
  check('sketch edit did not invalidate the changed exact occurrence',
    sketchEditedResult.evaluation?.evaluatedPatternInstanceIds?.includes(sketchEditedOccurrences[0]!.bodyId));
  const sketchDeletedResult = await rebuild(sketchDeleted, 'sketch-pattern-deleted');
  const deletedSource = sketchDeletedResult.bodies.find((entry: JsonRecord) => entry.bodyId === 'body-pattern-source');
  check('typed pattern/source deletion left generated geometry or damaged the source body',
    exactPatternOccurrences(sketchDeletedResult, 'pattern-sketch-points').length === 0
      && deletedSource?.geometry?.valid === true
      && closeTo(deletedSource.geometry.volume, 768, 2e-4)
      && typeof deletedSource.exactBrep === 'string');

  const expectedSquareCenters = [
    [-10, -10], [0, -10], [10, -10], [-10, 0], [10, 0], [-10, 10], [0, 10], [10, 10],
  ];
  const expectedTriangularCenters = [
    [-15, -8.660254037844386], [-5, -8.660254037844386], [5, -8.660254037844386], [15, -8.660254037844386],
    [-10, 0], [10, 0],
    [-15, 8.660254037844386], [-5, 8.660254037844386], [5, 8.660254037844386], [15, 8.660254037844386],
  ];
  const assertFill = (result: JsonRecord, patternId: string, expectedCenters: number[][], label: string): JsonRecord[] => {
    const occurrences = exactPatternOccurrences(result, patternId);
    check(`${label} generated ${occurrences.length} occurrences instead of ${expectedCenters.length}`,
      occurrences.length === expectedCenters.length);
    const actualCenters = occurrences.map((entry, index) => {
      assertExactOccurrence(entry, `${label} occurrence ${index + 1}`);
      check(`${label} occurrence ${index + 1} lost stable lattice identity`,
        Array.isArray(entry.patternInstance?.lattice) && typeof entry.patternInstance?.placementKey === 'string');
      check(`${label} occurrence ${index + 1} changed exact volume`, closeTo(entry.geometry.volume, 768, 2e-4));
      return [
        (entry.geometry.bounds[0][0] + entry.geometry.bounds[1][0]) / 2,
        (entry.geometry.bounds[0][1] + entry.geometry.bounds[1][1]) / 2,
      ];
    });
    expectedCenters.forEach((expected, index) => check(
      `${label} lattice center ${index + 1} changed: ${JSON.stringify(actualCenters[index])}`,
      closeTo(actualCenters[index]![0]!, expected[0]!) && closeTo(actualCenters[index]![1]!, expected[1]!),
    ));
    return occurrences;
  };

  const fillSquareResult = await rebuild(fillSquare, 'fill-square');
  const fillSquareOccurrences = assertFill(fillSquareResult, 'pattern-fill-square', expectedSquareCenters, 'square fill');
  const fillTriangularResult = await rebuild(fillTriangular, 'fill-triangular');
  const fillTriangularOccurrences = assertFill(
    fillTriangularResult,
    'pattern-fill-triangular',
    expectedTriangularCenters,
    'triangular fill',
  );
  const fillSquareEditedResult = await rebuild(fillSquareEdited, 'fill-square-edited-boundary');
  const fillSquareEditedOccurrences = exactPatternOccurrences(fillSquareEditedResult, 'pattern-fill-square');
  check('edited square fill boundary did not recompute to fifteen exact occurrences', fillSquareEditedOccurrences.length === 15);
  fillSquareEditedOccurrences.forEach((entry, index) => assertExactOccurrence(entry, `edited square fill occurrence ${index + 1}`));
  const fillTriangularEditedResult = await rebuild(fillTriangularEdited, 'fill-triangular-edited-boundary');
  const fillTriangularEditedOccurrences = exactPatternOccurrences(fillTriangularEditedResult, 'pattern-fill-triangular');
  check('edited triangular fill boundary did not recompute to seventeen exact occurrences', fillTriangularEditedOccurrences.length === 17);
  fillTriangularEditedOccurrences.forEach((entry, index) => assertExactOccurrence(entry, `edited triangular fill occurrence ${index + 1}`));
  check('fill boundary edits reused every stale dynamic occurrence',
    (fillSquareEditedResult.evaluation?.evaluatedPatternInstanceIds?.length || 0) > 0
      && (fillTriangularEditedResult.evaluation?.evaluatedPatternInstanceIds?.length || 0) > 0);

  const variableResult = await rebuild(variablePattern, 'variable-height');
  const variableOccurrences = exactPatternOccurrences(variableResult, 'pattern-variable-height');
  check('variable pattern did not create two exact independently rebuilt occurrences', variableOccurrences.length === 2);
  variableOccurrences.forEach((entry, index) => assertOwnedExactOccurrence(entry, `variable occurrence ${index + 1}`));
  checkBounds(variableOccurrences[0]!.geometry.bounds, [[12, -4, 0], [24, 4, 10]], 'first variable occurrence changed exact bounds');
  checkBounds(variableOccurrences[1]!.geometry.bounds, [[30, -4, 0], [42, 4, 12]], 'second variable occurrence changed exact bounds');
  check('variable occurrence volumes do not reflect their literal height overrides',
    closeTo(variableOccurrences[0]!.geometry.volume, 960, 2e-4)
      && closeTo(variableOccurrences[1]!.geometry.volume, 1152, 2e-4));
  check('variable rows did not publish distinct rebuilt seed evidence',
    variableOccurrences[0]!.patternInstance.variableSeedBrepSha256 !== variableOccurrences[1]!.patternInstance.variableSeedBrepSha256
      && variableOccurrences[0]!.exactBrep !== variableOccurrences[1]!.exactBrep);

  const variableEditedResult = await rebuild(variablePatternEdited, 'variable-height-edited');
  const variableEditedOccurrences = exactPatternOccurrences(variableEditedResult, 'pattern-variable-height');
  check('edited variable pattern did not retain two exact occurrences', variableEditedOccurrences.length === 2);
  variableEditedOccurrences.forEach((entry, index) => assertOwnedExactOccurrence(entry, `edited variable occurrence ${index + 1}`));
  checkBounds(variableEditedOccurrences[0]!.geometry.bounds, [[16, -4, 0], [28, 4, 11]], 'edited first variable occurrence changed exact bounds');
  checkBounds(variableEditedOccurrences[1]!.geometry.bounds, [[38, -4, 0], [50, 4, 14]], 'edited second variable occurrence changed exact bounds');
  check('variable row edits did not change exact volumes and B-reps',
    closeTo(variableEditedOccurrences[0]!.geometry.volume, 1056, 2e-4)
      && closeTo(variableEditedOccurrences[1]!.geometry.volume, 1344, 2e-4)
      && variableEditedOccurrences[0]!.exactBrep !== variableOccurrences[0]!.exactBrep
      && variableEditedOccurrences[1]!.exactBrep !== variableOccurrences[1]!.exactBrep);
  check('variable edit did not invalidate both exact per-row rebuilds',
    variableEditedOccurrences.every((entry) => variableEditedResult.evaluation?.evaluatedPatternInstanceIds?.includes(entry.bodyId)));

  const wrongSketchSeedResult = await rebuildRaw(sketchWrongSeed, 'sketch-wrong-seed-refusal');
  check('wrong sketch seed did not fail closed without generated geometry',
    wrongSketchSeedResult.errors?.some((entry: JsonRecord) => entry.featureId === 'pattern-sketch-wrong-seed'
      && /source bounding-box center projection|seed point/u.test(entry.message))
      && exactPatternOccurrences(wrongSketchSeedResult, 'pattern-sketch-wrong-seed').length === 0);
  const wrongFillSeedResult = await rebuildRaw(fillWrongSeed, 'fill-wrong-seed-refusal');
  check('wrong fill seed did not fail closed without generated geometry',
    wrongFillSeedResult.errors?.some((entry: JsonRecord) => entry.featureId === 'pattern-fill-wrong-seed'
      && /source bounding-box center projection|seed point/u.test(entry.message))
      && exactPatternOccurrences(wrongFillSeedResult, 'pattern-fill-wrong-seed').length === 0);

  let freshKernel: HeadlessKernel | null = null;
  try {
    freshKernel = await createHeadlessKernel();
    await freshKernel.waitForKernel();
    const freshVariable = await freshKernel.request({
      kind: 'rebuild', requestId: 'advanced-pattern-fresh-variable', projectId: variablePatternEdited.projectId,
      revision: 1, document: variablePatternEdited, includeExactBrep: true,
    }, 180_000) as JsonRecord;
    check(`fresh-worker variable rebuild failed: ${JSON.stringify(freshVariable.errors || [])}`,
      freshVariable.errors?.length === 0
        && freshVariable.effectiveDocumentHash === runtime.studioV5CanonicalHash(variablePatternEdited));
    const freshVariableOccurrences = exactPatternOccurrences(freshVariable, 'pattern-variable-height');
    check('fresh worker did not reproduce both variable exact B-reps deterministically',
      freshVariableOccurrences.length === 2
        && freshVariableOccurrences.every((entry, index) => entry.exactBrep === variableEditedOccurrences[index]!.exactBrep));
  } finally {
    await freshKernel?.dispose();
  }

  console.log(JSON.stringify({
    schema: 'partmode.advanced-pattern-smoke/v1',
    exactRebuilds: 15,
    proven: {
      linearTable: { positions: [8, 16, 24], fusedVolume: linearFused.geometry.volume, brepBytes: linearFused.exactBrep.length },
      circularTable: { angles: [30, 90, 210], occurrences: circularOccurrences.length },
      curveDrivenTable: { parameters: [0.25, 0.5, 0.75], pathPoints: [[0, 0, 0], [0, 0, 30], [30, 0, 30]], occurrences: curveOccurrences.length },
      sketchPoints: { pointIds: ['pattern-seed', 'pattern-point-x', 'pattern-point-y'], occurrences: sketchOccurrences.length, editedX: 26 },
      squareFill: { occurrences: fillSquareOccurrences.length, editedOccurrences: fillSquareEditedOccurrences.length },
      triangularFill: { occurrences: fillTriangularOccurrences.length, editedOccurrences: fillTriangularEditedOccurrences.length },
      variableDimensions: {
        occurrences: variableOccurrences.length,
        volumes: variableOccurrences.map((entry) => entry.geometry.volume),
        editedVolumes: variableEditedOccurrences.map((entry) => entry.geometry.volume),
      },
    },
    persistence: 'typed create/update/delete plus canonical save/reopen and fresh-worker rebuild',
    failClosed: [
      'linear table cardinality', 'curve parameter domain', 'missing sketch point', 'linked-only output',
      'dynamic fill skips', 'duplicate variable positions', 'project-scoped overrides', 'no-change overrides',
      'tampered stored records', 'wrong current sketch/fill source anchor',
    ],
  }, null, 2));
} finally {
  await kernel?.dispose();
}
