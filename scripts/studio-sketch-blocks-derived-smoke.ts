import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Sketch blocks / derived sketches smoke failed: ${label}`);
}

function closeTo(actual: number, expected: number, tolerance = 2e-6): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function closeBounds(actual: number[][], expected: number[][], tolerance = 2e-6): boolean {
  return actual?.length === expected.length
    && actual.flat().length === expected.flat().length
    && actual.flat().every((value, index) => closeTo(value, expected.flat()[index]!, tolerance));
}

function rectangleConstrained(width: number, height: number, prefix: string, offset: [number, number] = [0, 0]): JsonRecord {
  const [x, y] = offset;
  return {
    entities: [
      { id: `${prefix}-bottom-a`, kind: 'point', at: [x, y], fixed: true },
      { id: `${prefix}-bottom-b`, kind: 'point', at: [x + width, y] },
      { id: `${prefix}-right-a`, kind: 'point', at: [x + width, y] },
      { id: `${prefix}-right-b`, kind: 'point', at: [x + width, y + height] },
      { id: `${prefix}-top-a`, kind: 'point', at: [x + width, y + height] },
      { id: `${prefix}-top-b`, kind: 'point', at: [x, y + height] },
      { id: `${prefix}-left-a`, kind: 'point', at: [x, y + height] },
      { id: `${prefix}-left-b`, kind: 'point', at: [x, y] },
      { id: `${prefix}-bottom`, kind: 'line', a: `${prefix}-bottom-a`, b: `${prefix}-bottom-b` },
      { id: `${prefix}-right`, kind: 'line', a: `${prefix}-right-a`, b: `${prefix}-right-b` },
      { id: `${prefix}-top`, kind: 'line', a: `${prefix}-top-a`, b: `${prefix}-top-b` },
      { id: `${prefix}-left`, kind: 'line', a: `${prefix}-left-a`, b: `${prefix}-left-b` },
    ],
    constraints: [
      { id: `${prefix}-join-bottom-right`, kind: 'coincident', a: `${prefix}-bottom-b`, b: `${prefix}-right-a` },
      { id: `${prefix}-join-right-top`, kind: 'coincident', a: `${prefix}-right-b`, b: `${prefix}-top-a` },
      { id: `${prefix}-join-top-left`, kind: 'coincident', a: `${prefix}-top-b`, b: `${prefix}-left-a` },
      { id: `${prefix}-join-left-bottom`, kind: 'coincident', a: `${prefix}-left-b`, b: `${prefix}-bottom-a` },
      { id: `${prefix}-horizontal-bottom`, kind: 'horizontal', line: `${prefix}-bottom` },
      { id: `${prefix}-vertical-right`, kind: 'vertical', line: `${prefix}-right` },
      { id: `${prefix}-horizontal-top`, kind: 'horizontal', line: `${prefix}-top` },
      { id: `${prefix}-vertical-left`, kind: 'vertical', line: `${prefix}-left` },
      { id: `${prefix}-width`, kind: 'horizontalDistance', a: `${prefix}-bottom-a`, b: `${prefix}-bottom-b`, value: width },
      { id: `${prefix}-height`, kind: 'verticalDistance', a: `${prefix}-bottom-a`, b: `${prefix}-left-a`, value: height },
    ],
    blockInstances: [],
    relations: [],
  };
}

function openLineConstrained(prefix: string): JsonRecord {
  return {
    entities: [
      { id: `${prefix}-a`, kind: 'point', at: [0, 0], fixed: true },
      { id: `${prefix}-b`, kind: 'point', at: [10, 0] },
      { id: `${prefix}-line`, kind: 'line', a: `${prefix}-a`, b: `${prefix}-b` },
    ],
    constraints: [{ id: `${prefix}-horizontal`, kind: 'horizontal', line: `${prefix}-line` }],
    blockInstances: [], relations: [],
  };
}

function closedSplineConstrained(prefix: string): JsonRecord {
  return {
    entities: [
      { id: `${prefix}-p1`, kind: 'point', at: [0, 0], fixed: true },
      { id: `${prefix}-p2`, kind: 'point', at: [10, 0] },
      { id: `${prefix}-p3`, kind: 'point', at: [10, 8] },
      { id: `${prefix}-control`, kind: 'point', at: [5, 12] },
      { id: `${prefix}-p4`, kind: 'point', at: [0, 8] },
      { id: `${prefix}-bottom`, kind: 'line', a: `${prefix}-p1`, b: `${prefix}-p2` },
      { id: `${prefix}-right`, kind: 'line', a: `${prefix}-p2`, b: `${prefix}-p3` },
      { id: `${prefix}-curve`, kind: 'spline', through: [`${prefix}-p3`, `${prefix}-control`, `${prefix}-p4`] },
      { id: `${prefix}-left`, kind: 'line', a: `${prefix}-p4`, b: `${prefix}-p1` },
    ],
    constraints: [
      { id: `${prefix}-horizontal`, kind: 'horizontal', line: `${prefix}-bottom` },
      { id: `${prefix}-right-vertical`, kind: 'vertical', line: `${prefix}-right` },
      { id: `${prefix}-left-vertical`, kind: 'vertical', line: `${prefix}-left` },
    ],
    blockInstances: [], relations: [],
  };
}

function fanoutBlockConstrained(): JsonRecord {
  const entities: JsonRecord[] = Array.from({ length: 30 }, (_, index) => ({
    id: `fan-point-${index}`,
    kind: 'point',
    at: [index % 6, Math.floor(index / 6)],
  }));
  for (let index = 0; index < 15; index++) {
    entities.push({ id: `fan-line-${index}`, kind: 'line', a: `fan-point-${index * 2}`, b: `fan-point-${index * 2 + 1}` });
  }
  return { entities, constraints: [], blockInstances: [], relations: [] };
}

function semicircleBlockConstrained(): JsonRecord {
  return {
    entities: [
      { id: 'semi-center', kind: 'point', at: [0, 0], fixed: true },
      { id: 'semi-a', kind: 'point', at: [5, 0] },
      { id: 'semi-b', kind: 'point', at: [-5, 0] },
      { id: 'semi-arc', kind: 'arc', center: 'semi-center', a: 'semi-a', b: 'semi-b', ccw: true },
      { id: 'semi-diameter', kind: 'line', a: 'semi-b', b: 'semi-a' },
    ],
    constraints: [], blockInstances: [], relations: [],
  };
}

function quarterArcBlockConstrained(): JsonRecord {
  return {
    entities: [
      { id: 'quarter-center', kind: 'point', at: [0, 0], fixed: true },
      { id: 'quarter-a', kind: 'point', at: [5, 0] },
      { id: 'quarter-b', kind: 'point', at: [0, 5] },
      { id: 'quarter-arc', kind: 'arc', center: 'quarter-center', a: 'quarter-a', b: 'quarter-b', ccw: true },
      { id: 'quarter-radial-a', kind: 'line', a: 'quarter-center', b: 'quarter-a' },
      { id: 'quarter-radial-b', kind: 'line', a: 'quarter-b', b: 'quarter-center' },
    ],
    constraints: [], blockInstances: [], relations: [],
  };
}

function inlineConstrainedGhost(field: 'blockInstances' | 'relations' | 'derivedFrom', value: unknown): JsonRecord {
  const source = rectangleConstrained(3, 2, `inline-${field}`);
  return { entities: source.entities, constraints: source.constraints, [field]: value };
}

function memberBounds(resolved: JsonRecord, marker: string, minimumPoints = 4): number[][] {
  const points = (resolved.solved?.entities || []).filter((entity: JsonRecord) =>
    entity.kind === 'point' && entity.id.includes(marker));
  check(`resolved member ${marker} has fewer than ${minimumPoints} points`, points.length >= minimumPoints);
  return [
    [Math.min(...points.map((entry: JsonRecord) => entry.at[0])), Math.min(...points.map((entry: JsonRecord) => entry.at[1]))],
    [Math.max(...points.map((entry: JsonRecord) => entry.at[0])), Math.max(...points.map((entry: JsonRecord) => entry.at[1]))],
  ];
}

function decodedTopologyNames(body: JsonRecord): string[] {
  const encoded = [
    ...(body.mesh?.topologyFaces || []),
    ...(body.mesh?.edges || []),
    ...(body.mesh?.topologyVertices || []),
  ].map((entry: JsonRecord) => String(entry.name || '')).filter(Boolean);
  return encoded.map((name: string) => {
    try { return decodeURIComponent(name); } catch { return name; }
  });
}

function brepHash(body: JsonRecord): string {
  check(`${body.bodyId} has no canonical OCCT BREP evidence`, typeof body.exactBrep === 'string' && body.exactBrep.length > 100);
  return createHash('sha256').update(body.exactBrep).digest('hex');
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const projectTools = await moduleAt('src/static/studio-project-v5.js');
const runtimeTools = await moduleAt('src/static/studio-v5-runtime-document.js');
const agentTools = await moduleAt('src/static/studio-agent-service.js');
const instanceTools = await moduleAt('src/static/studio-sketch-instances.js');
const modelingTools = await moduleAt('src/static/studio-v5-modeling.js');

function resolveFirstClassSketch(document: JsonRecord, sketchId: string, options: JsonRecord = {}): JsonRecord {
  const rootPart = runtimeTools.studioV5RootPart(document);
  const parameters = modelingTools.studioV5ParameterValues(document, rootPart);
  return instanceTools.resolveStudioConstrainedSketch(rootPart, sketchId, {
    ...options,
    evaluate: (value: unknown) => modelingTools.evaluateStudioV5Expression(value, parameters),
  });
}

let transactionSequence = 0;
const documentHashes: string[] = [];
let lastChangeSet: JsonRecord | null = null;
function latestRemap(): JsonRecord[] {
  return Array.isArray((lastChangeSet as JsonRecord | null)?.remapped)
    ? structuredClone((lastChangeSet as JsonRecord).remapped)
    : [];
}
function apply(source: JsonRecord, label: string, operations: JsonRecord[]): JsonRecord {
  const before = JSON.stringify(source);
  const result = agentTools.applyCadTransaction(source, {
    transactionId: `sketch-instances-${++transactionSequence}-${label}`,
    label,
    expectedRevision: 0,
    atomic: true,
    operations,
  });
  check(`${label} mutated its source document`, JSON.stringify(source) === before);
  check(`${label} omitted canonical before/after document hashes`,
    typeof result.changeSet?.documentHashBefore === 'string'
    && typeof result.changeSet?.documentHashAfter === 'string'
    && result.changeSet.documentHashBefore !== result.changeSet.documentHashAfter);
  documentHashes.push(`${source.projectId}:${result.changeSet.documentHashAfter}`);
  lastChangeSet = structuredClone(result.changeSet);
  return result.project;
}

function expectTypedRejection(
  label: string,
  source: JsonRecord,
  operations: JsonRecord[],
  expectedCode: string,
  message: RegExp,
): void {
  const before = JSON.stringify(source);
  let failure: any = null;
  try { apply(source, `rejected-${label}`, operations); } catch (error) { failure = error; }
  check(`${label} did not fail`, failure);
  check(`${label} returned ${String(failure?.code || 'UNTYPED_ERROR')} instead of ${expectedCode}`,
    failure?.code === expectedCode);
  check(`${label} did not explain its refusal: ${String(failure?.message || failure)}`,
    message.test(String(failure?.message || failure)));
  check(`${label} mutated the refused source document`, JSON.stringify(source) === before);
}

const definitionRectangle = rectangleConstrained(10, 6, 'definition');
const targetSeed: JsonRecord = {
  entities: [{ id: 'inner-pose-anchor', kind: 'point', at: [5, 3], fixed: true }],
  constraints: [],
  blockInstances: [],
  relations: [],
};
const probeSeed = { entities: [], constraints: [], blockInstances: [], relations: [] };

const unusedDefinitionProject = projectTools.createEmptyStudioV5PartProject({
  projectId: 'unused-invalid-block-definition',
  name: 'Unused invalid block definition refusal',
  units: 'mm',
}) as JsonRecord;
check('unused-definition refusal fixture unexpectedly contains a sketch instance',
  runtimeTools.studioV5RootPart(unusedDefinitionProject).sketches.length === 0);
expectTypedRejection('create an unused unsolved block definition before any instance exists', unusedDefinitionProject, [{
  kind: 'sketch.blockDefinition.create',
  input: {
    id: 'block-unused-invalid', name: 'Unused invalid definition', insertionPoint: [0, 0],
    constrained: {
      entities: [
        { id: 'invalid-fixed-a', kind: 'point', at: [0, 0], fixed: true },
        { id: 'invalid-fixed-b', kind: 'point', at: [5, 0], fixed: true },
        { id: 'invalid-line', kind: 'line', a: 'invalid-fixed-a', b: 'invalid-fixed-b' },
      ],
      constraints: [
        { id: 'invalid-fixed-coincident', kind: 'coincident', a: 'invalid-fixed-a', b: 'invalid-fixed-b' },
      ],
      blockInstances: [], relations: [],
    },
  },
}], 'SKETCH_BLOCK_DEFINITION_UNSOLVED', /did not solve/u);

let project = projectTools.createEmptyStudioV5PartProject({
  projectId: 'sketch-blocks-derived-exact',
  name: 'Sketch blocks and derived sketches acceptance',
  units: 'mm',
}) as JsonRecord;

project = apply(project, 'create-first-class-sketches', [
  { kind: 'parameter.create', input: { id: 'parameter-instance-scale', name: 'instance_scale', value: 1 } },
  {
    kind: 'sketch.constrained.create',
    input: { id: 'sketch-definition-source', name: 'Definition rectangle', plane: 'XY', z: 0, constrained: definitionRectangle },
  },
  {
    kind: 'sketch.constrained.create',
    input: { id: 'sketch-block-frame', name: 'Nested block frame', plane: 'XY', z: 0, constrained: targetSeed },
  },
  {
    kind: 'sketch.constrained.create',
    input: { id: 'sketch-free-pose-probe', name: 'Free rigid pose probe', plane: 'XY', z: 0, constrained: probeSeed },
  },
  {
    kind: 'sketch.constrained.create',
    input: { id: 'sketch-yz-source', name: 'Offset YZ source', plane: 'YZ', z: 7, constrained: rectangleConstrained(4, 3, 'support') },
  },
  {
    kind: 'sketch.derived.create',
    input: {
      id: 'sketch-yz-derived', name: 'Inherited YZ derived', sourceSketchId: 'sketch-yz-source',
      transform: { translation: [10, 20], angleDeg: 0 },
    },
  },
  {
    kind: 'sketch.blockDefinition.create',
    input: {
      id: 'block-rectangle', name: 'Parametric rectangle block', insertionPoint: [0, 0],
      sourceSketchId: 'sketch-definition-source',
      memberEntityIds: ['definition-bottom', 'definition-right', 'definition-top', 'definition-left'],
    },
  },
]);

let part = runtimeTools.studioV5RootPart(project);
const definition = part.sketchBlockDefinitions.find((entry: JsonRecord) => entry.id === 'block-rectangle');
check('rectangle block definition did not retain its selected geometry and constraints',
  definition?.constrained.entities.length === 12 && definition.constrained.constraints.length === 10
  && definition.constrained.constraints.filter((entry: JsonRecord) => entry.kind === 'coincident').length === 4);
const inheritedSupport = part.sketches.find((entry: JsonRecord) => entry.id === 'sketch-yz-derived');
check('derived sketch did not inherit YZ support and the source offset',
  inheritedSupport?.plane === 'YZ' && inheritedSupport.z === 7);

project = apply(project, 'prove-free-rigid-instance', [{
  kind: 'sketch.blockInstance.create',
  input: {
    sketchId: 'sketch-free-pose-probe', id: 'a', definitionId: 'block-rectangle',
    transform: { translation: [100, 20], angleDeg: 17, scale: 1.5 }, fixed: false,
  },
}]);
part = runtimeTools.studioV5RootPart(project);
const freePose = resolveFirstClassSketch(project, 'sketch-free-pose-probe');
check(`one unconstrained rigid block should expose exactly three pose DOF: ${JSON.stringify({
  dof: freePose.dof, rank: freePose.rank, equations: freePose.equations,
  entities: freePose.solved.entities.length, constraints: freePose.flattened.constraints.length,
})}`,
  freePose.dof === 3 && freePose.loops.length === 1
  && freePose.solved.entities.length === 12 && freePose.connectivityConstraints.length === 4);
project = apply(project, 'prove-colon-safe-member-identities', [{
  kind: 'sketch.blockInstance.create',
  input: {
    sketchId: 'sketch-free-pose-probe', id: 'a:b', definitionId: 'block-rectangle',
    transform: { translation: [140, 20], angleDeg: -11, scale: 0.75 }, fixed: false,
  },
}]);
part = runtimeTools.studioV5RootPart(project);
const collisionProbe = resolveFirstClassSketch(project, 'sketch-free-pose-probe');
const ownerA = instanceTools.studioSketchBlockMemberPrefix('a');
const ownerAB = instanceTools.studioSketchBlockMemberPrefix('a:b');
const ownerAIds = collisionProbe.solved.entities.filter((entry: JsonRecord) => entry.id.startsWith(ownerA)).map((entry: JsonRecord) => entry.id);
const ownerABIds = collisionProbe.solved.entities.filter((entry: JsonRecord) => entry.id.startsWith(ownerAB)).map((entry: JsonRecord) => entry.id);
check('length-delimited instance owners a and a:b collided',
  collisionProbe.dof === 6 && collisionProbe.loops.length === 2
  && ownerAIds.length === 12 && ownerABIds.length === 12
  && ownerAIds.every((id: string) => !ownerABIds.includes(id)));
check('owner/member colon ambiguity regressed',
  instanceTools.studioSketchBlockMemberId('a', 'b:c')
  !== instanceTools.studioSketchBlockMemberId('a:b', 'c'));
project = apply(project, 'create-probe-relation', [{
  kind: 'sketch.relation.create', alias: 'probeRelation',
  input: {
    sketchId: 'sketch-free-pose-probe',
    relation: {
      id: 'probe-instance-contact', kind: 'coincident',
      a: { instanceId: 'a', memberId: 'definition-bottom-a' },
      b: { instanceId: 'a:b', memberId: 'definition-bottom-a' },
    },
  },
}, {
  kind: 'sketch.relation.update',
  input: {
    sketchId: 'sketch-free-pose-probe', relationId: { alias: 'probeRelation' },
    relation: {
      id: 'probe-instance-contact', kind: 'coincident',
      a: { instanceId: 'a:b', memberId: 'definition-bottom-a' },
      b: { instanceId: 'a', memberId: 'definition-bottom-a' },
    },
  },
}]);
expectTypedRejection('delete an instance used by a relation', project, [{
  kind: 'sketch.blockInstance.delete',
  input: { sketchId: 'sketch-free-pose-probe', instanceId: 'a' },
}], 'DOCUMENT_VALIDATION_FAILED', /used by relations probe-instance-contact/u);
project = apply(project, 'delete-probe-relation-and-instances', [
  { kind: 'sketch.relation.delete', input: { sketchId: 'sketch-free-pose-probe', relationId: 'probe-instance-contact' } },
  { kind: 'sketch.blockInstance.delete', input: { sketchId: 'sketch-free-pose-probe', instanceId: 'a' } },
  { kind: 'sketch.blockInstance.delete', input: { sketchId: 'sketch-free-pose-probe', instanceId: 'a:b' } },
]);
part = runtimeTools.studioV5RootPart(project);
const blankProbe = resolveFirstClassSketch(project, 'sketch-free-pose-probe');
check('blank first-class sketch did not survive relation and instance deletion',
  blankProbe.solved.entities.length === 0 && blankProbe.loops.length === 0);
project = apply(project, 'remove-free-pose-probe', [
  { kind: 'sketch.constrained.delete', input: { sketchId: 'sketch-free-pose-probe' } },
]);

project = apply(project, 'insert-independent-block-instances', [
  {
    kind: 'sketch.blockInstance.create',
    input: {
      sketchId: 'sketch-block-frame', id: 'block-outer', definitionId: 'block-rectangle',
      transform: { translation: [0, 0], angleDeg: 0, scale: 2 }, fixed: true,
    },
  },
  {
    kind: 'sketch.blockInstance.create',
    input: {
      sketchId: 'sketch-block-frame', id: 'block-inner', definitionId: 'block-rectangle',
      transform: { translation: [5, 3], angleDeg: 0, scale: 'instance_scale' }, fixed: false,
    },
  },
]);

part = runtimeTools.studioV5RootPart(project);
let targetSketch = part.sketches.find((entry: JsonRecord) => entry.id === 'sketch-block-frame');
check('independent instance transforms were not persisted',
  targetSketch.constrained.blockInstances.length === 2
  && JSON.stringify(targetSketch.constrained.blockInstances[0].transform) === JSON.stringify({ translation: [0, 0], angleDeg: 0, scale: 2 })
  && JSON.stringify(targetSketch.constrained.blockInstances[1].transform) === JSON.stringify({ translation: [5, 3], angleDeg: 0, scale: 'instance_scale' }));
let resolvedTarget = resolveFirstClassSketch(project, 'sketch-block-frame');
check('free inner block did not retain three rigid-pose DOF before external relations',
  resolvedTarget.dof === 3 && resolvedTarget.loops.length === 2);
project = apply(project, 'author-and-update-external-pose-relations', [
  {
    kind: 'sketch.relation.create', alias: 'innerCoincident',
    input: {
      sketchId: 'sketch-block-frame',
      relation: {
        id: 'inner-anchor-coincident', kind: 'coincident',
        a: { entityId: 'inner-pose-anchor' },
        b: { instanceId: 'block-inner', memberId: 'definition-bottom-a' },
      },
    },
  },
  {
    kind: 'sketch.relation.create', alias: 'innerHorizontal',
    input: {
      sketchId: 'sketch-block-frame',
      relation: {
        id: 'inner-bottom-horizontal', kind: 'horizontal',
        line: { instanceId: 'block-inner', memberId: 'definition-bottom' },
      },
    },
  },
  {
    kind: 'sketch.relation.update',
    input: {
      sketchId: 'sketch-block-frame', relationId: { alias: 'innerCoincident' },
      relation: {
        id: 'inner-anchor-coincident', kind: 'coincident',
        a: { instanceId: 'block-inner', memberId: 'definition-bottom-a' },
        b: { entityId: 'inner-pose-anchor' },
      },
    },
  },
]);
part = runtimeTools.studioV5RootPart(project);
targetSketch = part.sketches.find((entry: JsonRecord) => entry.id === 'sketch-block-frame');
resolvedTarget = resolveFirstClassSketch(project, 'sketch-block-frame');
check(`external rigid-pose relations did not settle deterministically: ${JSON.stringify({
  dof: resolvedTarget.dof,
  loops: resolvedTarget.loops.length,
  entities: resolvedTarget.solved.entities.length,
  constraints: resolvedTarget.flattened.constraints.length,
  connectivity: resolvedTarget.connectivityConstraints.length,
  relations: targetSketch.constrained.relations.length,
})}`,
  resolvedTarget.dof === 0 && resolvedTarget.loops.length === 2
  && resolvedTarget.solved.entities.length === 25
  && resolvedTarget.flattened.constraints.length === 20
  && resolvedTarget.connectivityConstraints.length === 9
  && targetSketch.constrained.relations.length === 2);
check('external rigid-pose relation did not hold the inner insertion point',
  closeBounds(memberBounds(resolvedTarget, instanceTools.studioSketchBlockMemberPrefix('block-inner')), [[5, 3], [15, 9]]));

project = apply(project, 'create-linked-features', [
  {
    kind: 'sketch.derived.create',
    input: {
      id: 'sketch-derived-frame', name: 'Associative derived frame', sourceSketchId: 'sketch-block-frame',
      plane: 'XY', z: 10, transform: { translation: [30, 0], angleDeg: 0 },
    },
  },
  {
    kind: 'feature.extrude',
    input: {
      id: 'feature-block-frame', name: 'Linked block frame extrusion', sketchId: 'sketch-block-frame', height: 5,
      resultPolicy: { kind: 'new-body', bodyName: 'Block frame' },
    },
  },
  {
    kind: 'feature.extrude',
    input: {
      id: 'feature-derived-frame', name: 'Associative derived frame extrusion', sketchId: 'sketch-derived-frame', height: 3,
      resultPolicy: { kind: 'new-body', bodyName: 'Derived frame' },
    },
  },
  {
    kind: 'feature.extrude',
    input: {
      id: 'feature-yz-derived', name: 'Inherited YZ support extrusion', sketchId: 'sketch-yz-derived', height: 2,
      resultPolicy: { kind: 'new-body', bodyName: 'Inherited YZ support' },
    },
  },
]);

part = runtimeTools.studioV5RootPart(project);
resolvedTarget = resolveFirstClassSketch(project, 'sketch-block-frame');
const resolvedDerivedInitial = resolveFirstClassSketch(project, 'sketch-derived-frame');
check('block frame did not resolve as exactly two nested profiles', resolvedTarget.loops.length === 2 && resolvedTarget.dof === 0);
check('derived sketch did not resolve the source associatively',
  resolvedDerivedInitial.sourceSketchId === 'sketch-block-frame'
  && resolvedDerivedInitial.loops.length === 2
  && closeBounds(memberBounds(resolvedDerivedInitial, 'ds:'), [[30, 0], [50, 12]]));

expectTypedRejection('delete a referenced block definition', project, [{
  kind: 'sketch.blockDefinition.delete', input: { definitionId: 'block-rectangle' },
}], 'DOCUMENT_VALIDATION_FAILED', /used by Nested block frame/u);
expectTypedRejection('delete a referenced source sketch', project, [{
  kind: 'sketch.constrained.delete', input: { sketchId: 'sketch-block-frame' },
}], 'DOCUMENT_VALIDATION_FAILED', /Sketch is used by/u);
expectTypedRejection('submit an unknown top-level SK009 operation field', project, [{
  kind: 'sketch.blockDefinition.delete',
  input: { definitionId: 'block-rectangle', unexpectedTopLevel: true },
}], 'INVALID_REQUEST', /operation\.input contains unsupported field "unexpectedTopLevel"/u);
expectTypedRejection('submit an unknown nested SK009 transform field', project, [{
  kind: 'sketch.blockInstance.update',
  input: {
    sketchId: 'sketch-block-frame', instanceId: 'block-inner',
    patch: { transform: { translation: [5, 3], angleDeg: 0, scale: 'instance_scale', unexpectedNested: 1 } },
  },
}], 'SKETCH_INSTANCE_INVALID', /transform contains unsupported field "unexpectedNested"/u);
expectTypedRejection('bypass derived creation through generic constrained create', project, [{
  kind: 'sketch.constrained.create',
  input: {
    id: 'sketch-illegal-generic-derived-create', name: 'Illegal generic derived create', plane: 'XY', z: 0,
    constrained: {
      entities: [], constraints: [], blockInstances: [], relations: [],
      derivedFrom: {
        sourceSketchId: 'sketch-block-frame', transform: { translation: [0, 0], angleDeg: 0 },
      },
    },
  },
}], 'DOCUMENT_VALIDATION_FAILED', /Use sketch\.derived\.create/u);
expectTypedRejection('bypass derived creation through generic constrained update', project, [{
  kind: 'sketch.constrained.update',
  input: {
    sketchId: 'sketch-yz-source',
    patch: {
      constrained: {
        entities: [], constraints: [], blockInstances: [], relations: [],
        derivedFrom: {
          sourceSketchId: 'sketch-block-frame', transform: { translation: [0, 0], angleDeg: 0 },
        },
      },
    },
  },
}], 'DOCUMENT_VALIDATION_FAILED', /Use sketch\.derived\.create/u);
expectTypedRejection('create a dangling placement relation', project, [{
  kind: 'sketch.relation.create',
  input: {
    sketchId: 'sketch-block-frame',
    relation: {
      id: 'dangling-relation-probe', kind: 'coincident',
      a: { entityId: 'inner-pose-anchor' }, b: { entityId: 'missing-relation-member' },
    },
  },
}], 'MISSING_SKETCH_RELATION_MEMBER', /references missing resolved member "missing-relation-member"/u);
expectTypedRejection('create a relation with a missing operand shape', project, [{
  kind: 'sketch.relation.create',
  input: {
    sketchId: 'sketch-block-frame',
    relation: {
      id: 'missing-operand-relation-probe', kind: 'coincident',
      a: { entityId: 'inner-pose-anchor' },
    },
  },
}], 'SKETCH_INSTANCE_INVALID', /must contain exactly one supported operand shape/u);
expectTypedRejection('use a point where a relation requires a line member', project, [{
  kind: 'sketch.relation.create',
  input: {
    sketchId: 'sketch-block-frame',
    relation: {
      id: 'wrong-kind-relation-probe', kind: 'horizontal',
      line: { instanceId: 'block-inner', memberId: 'definition-bottom-a' },
    },
  },
}], 'SKETCH_RELATION_MEMBER_KIND_INVALID', /references a point; expected line/u);
expectTypedRejection('create a relation with a whitespace ID', project, [{
  kind: 'sketch.relation.create',
  input: {
    sketchId: 'sketch-block-frame',
    relation: {
      id: '   ', kind: 'vertical',
      line: { instanceId: 'block-inner', memberId: 'definition-right' },
    },
  },
}], 'INVALID_REQUEST', /operation\.input\.relation\.id must contain 1 to 200 characters/u);
expectTypedRejection('create a relation through a whitespace transaction alias', project, [{
  kind: 'sketch.relation.create', alias: '   ',
  input: {
    sketchId: 'sketch-block-frame',
    relation: {
      id: 'whitespace-alias-relation-probe', kind: 'vertical',
      line: { instanceId: 'block-inner', memberId: 'definition-right' },
    },
  },
}], 'INVALID_REQUEST', /operation\.alias must contain 1 to 200 characters/u);
for (const [field, value] of [
  ['blockInstances', []],
  ['relations', []],
  ['derivedFrom', { sourceSketchId: 'ghost-source', transform: { translation: [0, 0], angleDeg: 0 } }],
] as const) {
  expectTypedRejection(`smuggle ghost ${field} into an inline feature sketch`, project, [{
    kind: 'feature.extrude',
    input: {
      id: `feature-inline-ghost-${field}`, name: `Invalid inline ghost ${field}`,
      sketch: { z: 0, constrained: inlineConstrainedGhost(field, value) }, height: 1,
      resultPolicy: { kind: 'new-body', bodyName: `Invalid inline ghost ${field}` },
    },
  }], 'INVALID_FEATURE', new RegExp(`sketch\\.constrained contains unsupported inline field "${field}"`, 'u'));
}
expectTypedRejection('submit an empty constrained-sketch patch', project, [{
  kind: 'sketch.constrained.update', input: { sketchId: 'sketch-block-frame', patch: {} },
}], 'DOCUMENT_VALIDATION_FAILED', /must change at least one supported field/u);
expectTypedRejection('submit an unknown block-definition patch field', project, [{
  kind: 'sketch.blockDefinition.update', input: { definitionId: 'block-rectangle', patch: { unsupportedField: true } },
}], 'DOCUMENT_VALIDATION_FAILED', /contains unsupported field "unsupportedField"/u);
expectTypedRejection('replace a block-instance definition without an identity map', project, [{
  kind: 'sketch.blockInstance.update',
  input: { sketchId: 'sketch-block-frame', instanceId: 'block-inner', patch: { definitionId: 'block-rectangle' } },
}], 'DOCUMENT_VALIDATION_FAILED', /explicit member-identity mapping/u);
expectTypedRejection('relink a derived-sketch source without an identity map', project, [{
  kind: 'sketch.derived.update',
  input: { sketchId: 'sketch-derived-frame', patch: { sourceSketchId: 'sketch-yz-source' } },
}], 'DOCUMENT_VALIDATION_FAILED', /explicit member-identity mapping/u);
expectTypedRejection('create a linked derived-sketch chain', project, [{
  kind: 'sketch.derived.create',
  input: {
    id: 'sketch-derived-chain-probe', name: 'Invalid linked derived chain',
    sourceSketchId: 'sketch-derived-frame', transform: { translation: [0, 0], angleDeg: 0 },
  },
}], 'DERIVED_SKETCH_CHAIN_UNSUPPORTED', /cannot derive from another linked derived sketch/u);
expectTypedRejection('create an overlong reusable sketch ID', project, [{
  kind: 'sketch.constrained.create',
  input: { id: 's'.repeat(61), name: 'Overlong sketch ID', plane: 'XY', z: 0, constrained: probeSeed },
}], 'SKETCH_INSTANCE_ID_BUDGET', /at most 60 characters/u);
expectTypedRejection('create an overlong reusable instance ID', project, [{
  kind: 'sketch.blockInstance.create',
  input: {
    sketchId: 'sketch-block-frame', id: 'i'.repeat(61), definitionId: 'block-rectangle',
    transform: { translation: [0, 0], angleDeg: 0, scale: 1 }, fixed: true,
  },
}], 'SKETCH_INSTANCE_ID_BUDGET', /at most 60 characters/u);
expectTypedRejection('set a zero instance scale', project, [{
  kind: 'sketch.blockInstance.update',
  input: { sketchId: 'sketch-block-frame', instanceId: 'block-inner', patch: { transform: { translation: [5, 3], angleDeg: 0, scale: 0 } } },
}], 'SKETCH_INSTANCE_SCALE_INVALID', /above zero/u);
expectTypedRejection('set a negative instance scale', project, [{
  kind: 'sketch.blockInstance.update',
  input: { sketchId: 'sketch-block-frame', instanceId: 'block-inner', patch: { transform: { translation: [5, 3], angleDeg: 0, scale: -1 } } },
}], 'SKETCH_INSTANCE_SCALE_INVALID', /above zero/u);
expectTypedRejection('edit the instance scale parameter to a nonpositive value', project, [{
  kind: 'parameter.update', input: { parameterId: 'parameter-instance-scale', value: 0 },
}], 'SKETCH_INSTANCE_SCALE_INVALID', /above zero/u);

project = apply(project, 'edit-instance-scale-parameter', [{
  kind: 'parameter.update', input: { parameterId: 'parameter-instance-scale', value: 1.25 },
}]);
let parameterEditedTarget = resolveFirstClassSketch(project, 'sketch-block-frame');
check('parameter edit did not re-solve the linked instance while preserving its externally related pose',
  parameterEditedTarget.dof === 0
  && closeBounds(memberBounds(parameterEditedTarget, instanceTools.studioSketchBlockMemberPrefix('block-inner')), [[5, 3], [17.5, 10.5]]));
part = runtimeTools.studioV5RootPart(project);
targetSketch = part.sketches.find((entry: JsonRecord) => entry.id === 'sketch-block-frame');
check('parameter edit replaced the authored scale expression with a cached number',
  targetSketch.constrained.blockInstances.find((entry: JsonRecord) => entry.id === 'block-inner')?.transform.scale === 'instance_scale');
project = apply(project, 'restore-instance-scale-parameter', [{
  kind: 'parameter.update', input: { parameterId: 'parameter-instance-scale', value: 1 },
}]);
parameterEditedTarget = resolveFirstClassSketch(project, 'sketch-block-frame');
check('restoring the scale parameter did not restore the linked instance geometry',
  closeBounds(memberBounds(parameterEditedTarget, instanceTools.studioSketchBlockMemberPrefix('block-inner')), [[5, 3], [15, 9]]));

project = apply(project, 'create-open-and-spline-first-class-sketches', [
  {
    kind: 'sketch.constrained.create',
    input: { id: 'sketch-open-profile', name: 'Open profile probe', plane: 'XY', z: 30, constrained: openLineConstrained('open') },
  },
  {
    kind: 'sketch.constrained.create',
    input: { id: 'sketch-spline-profile', name: 'Spline profile probe', plane: 'XY', z: 40, constrained: closedSplineConstrained('spline') },
  },
]);
const openResolution = resolveFirstClassSketch(project, 'sketch-open-profile');
const splineResolution = resolveFirstClassSketch(project, 'sketch-spline-profile');
check('an open first-class sketch did not remain a valid editable non-profile sketch',
  openResolution.solved.entities.length === 3
  && openResolution.loops.length === 0
  && openResolution.profileStatus !== 'ok');
check('a closed first-class spline sketch did not resolve exact spline profile geometry',
  splineResolution.loops.length === 1
  && splineResolution.exactEntities.some((entry: JsonRecord) => entry.kind === 'spline'));
expectTypedRejection('consume an open first-class sketch as a solid profile', project, [{
  kind: 'feature.extrude',
  input: {
    id: 'feature-open-profile-probe', name: 'Invalid open profile extrusion',
    sketchId: 'sketch-open-profile', height: 2,
    resultPolicy: { kind: 'new-body', bodyName: 'Invalid open profile' },
  },
}], 'SKETCH_INSTANCES_PROFILE_OPEN', /does not form closed profiles/u);
expectTypedRejection('consume a spline first-class sketch before exact side naming exists', project, [{
  kind: 'feature.extrude',
  input: {
    id: 'feature-spline-profile-probe', name: 'Unsupported spline profile extrusion',
    sketchId: 'sketch-spline-profile', height: 2,
    resultPolicy: { kind: 'new-body', bodyName: 'Unsupported spline profile' },
  },
}], 'DOCUMENT_VALIDATION_FAILED', /spline profiles remain unsupported for solids/u);
expectTypedRejection('reinterpret a first-class sketch on an unrelated face', project, [{
  kind: 'feature.extrude',
  input: {
    id: 'feature-linked-on-face-probe', name: 'Invalid linked on-face extrusion',
    sketchId: 'sketch-block-frame', height: 2,
    onFace: { ownerKind: 'body', ownerId: 'body-nonexistent', signature: { role: 'cap' } },
    resultPolicy: { kind: 'new-body', bodyName: 'Invalid on-face linked profile' },
  },
}], 'INVALID_REQUEST', /cannot also use onFace/u);
project = apply(project, 'remove-open-and-spline-first-class-sketches', [
  { kind: 'sketch.constrained.delete', input: { sketchId: 'sketch-open-profile' } },
  { kind: 'sketch.constrained.delete', input: { sketchId: 'sketch-spline-profile' } },
]);

project = apply(project, 'create-chirality-probe', [
  {
    kind: 'sketch.constrained.create',
    input: {
      id: 'sketch-chirality-probe', name: 'Rigid chirality probe', plane: 'XY', z: 0,
      constrained: {
        entities: [
          { id: 'mirror-a', kind: 'point', at: [0, 0], fixed: true },
          { id: 'mirror-b', kind: 'point', at: [-10, 0], fixed: true },
          { id: 'mirror-c', kind: 'point', at: [0, 6], fixed: true },
        ],
        constraints: [], blockInstances: [], relations: [],
      },
    },
  },
  {
    kind: 'sketch.blockInstance.create',
    input: {
      sketchId: 'sketch-chirality-probe', id: 'mirror-instance', definitionId: 'block-rectangle',
      transform: { translation: [0, 0], angleDeg: 0, scale: 1 }, fixed: false,
    },
  },
]);
expectTypedRejection('mirror a rigid block through placement relations', project, [
  {
    kind: 'sketch.relation.create',
    input: {
      sketchId: 'sketch-chirality-probe',
      relation: {
        id: 'mirror-anchor-a', kind: 'coincident', a: { entityId: 'mirror-a' },
        b: { instanceId: 'mirror-instance', memberId: 'definition-bottom-a' },
      },
    },
  },
  {
    kind: 'sketch.relation.create',
    input: {
      sketchId: 'sketch-chirality-probe',
      relation: {
        id: 'mirror-anchor-b', kind: 'coincident', a: { entityId: 'mirror-b' },
        b: { instanceId: 'mirror-instance', memberId: 'definition-bottom-b' },
      },
    },
  },
  {
    kind: 'sketch.relation.create',
    input: {
      sketchId: 'sketch-chirality-probe',
      relation: {
        id: 'mirror-anchor-c', kind: 'coincident', a: { entityId: 'mirror-c' },
        b: { instanceId: 'mirror-instance', memberId: 'definition-left-a' },
      },
    },
  },
], 'SKETCH_INSTANCES_UNSOLVED', /did not solve/u);
project = apply(project, 'remove-chirality-probe', [
  { kind: 'sketch.blockInstance.delete', input: { sketchId: 'sketch-chirality-probe', instanceId: 'mirror-instance' } },
  { kind: 'sketch.constrained.delete', input: { sketchId: 'sketch-chirality-probe' } },
]);

project = apply(project, 'create-fanout-budget-definition', [{
  kind: 'sketch.blockDefinition.create',
  input: {
    id: 'block-fanout-budget', name: 'Resolved fan-out budget probe', insertionPoint: [0, 0],
    constrained: fanoutBlockConstrained(),
  },
}]);
expectTypedRejection('exceed the resolved sketch entity budget through block fan-out', project, [{
  kind: 'sketch.constrained.create',
  input: {
    id: 'sketch-fanout-overflow', name: 'Invalid resolved fan-out', plane: 'XY', z: 0,
    constrained: {
      entities: [], constraints: [], relations: [],
      blockInstances: Array.from({ length: 600 }, (_, index) => ({
        id: `fanout-${index}`, definitionId: 'block-fanout-budget',
        transform: { translation: [index * 10, 0], angleDeg: 0, scale: 1 }, fixed: true,
      })),
    },
  },
}], 'SKETCH_INSTANCE_RESOLVED_LIMIT', /exceeds 25,000 solver entities/u);
expectTypedRejection('exceed the bounded dense solver work budget below the entity cap', project, [{
  kind: 'sketch.constrained.create',
  input: {
    id: 'sketch-dense-work-overflow', name: 'Invalid dense solver work fan-out', plane: 'XY', z: 0,
    constrained: {
      entities: [], constraints: [], relations: [],
      blockInstances: Array.from({ length: 230 }, (_, index) => ({
        id: `dense-work-${index}`, definitionId: 'block-rectangle',
        transform: { translation: [index * 20, 0], angleDeg: 0, scale: 1 }, fixed: false,
      })),
    },
  },
}], 'SKETCH_INSTANCE_RESOLVED_LIMIT', /solver work budget/u);
project = apply(project, 'remove-fanout-budget-definition', [{
  kind: 'sketch.blockDefinition.delete', input: { definitionId: 'block-fanout-budget' },
}]);

let linkedRevolveProject = projectTools.createEmptyStudioV5PartProject({
  projectId: 'sketch-linked-revolve-refusal', name: 'Linked revolve refusal', units: 'mm',
}) as JsonRecord;
linkedRevolveProject = apply(linkedRevolveProject, 'create-linked-revolve-refusal-document', [{
  kind: 'sketch.constrained.create',
  input: {
    id: 'sketch-revolve-profile', name: 'Linked revolve profile', plane: 'XY', z: 0,
    constrained: rectangleConstrained(6, 4, 'revolve'),
  },
}]);
expectTypedRejection('use an intentionally unsupported first-class linked revolve', linkedRevolveProject, [{
  kind: 'feature.revolve',
  input: {
    id: 'feature-linked-revolve-probe', name: 'Unsupported linked revolve', sketchId: 'sketch-revolve-profile',
    resultPolicy: { kind: 'new-body', bodyName: 'Unsupported linked revolve' },
  },
}], 'UNSUPPORTED_FIRST_CLASS_SKETCH_CONSUMER', /support linked Extrude and Cut only/u);

let arcBlockProject = projectTools.createEmptyStudioV5PartProject({
  projectId: 'sketch-arc-blocks-exact', name: 'Tiny free arc blocks', units: 'mm',
}) as JsonRecord;
arcBlockProject = apply(arcBlockProject, 'create-tiny-free-arc-blocks', [
  {
    kind: 'sketch.blockDefinition.create',
    input: {
      id: 'block-semicircle', name: 'Semicircle block', insertionPoint: [0, 0],
      constrained: semicircleBlockConstrained(),
    },
  },
  {
    kind: 'sketch.blockDefinition.create',
    input: {
      id: 'block-quarter-arc', name: 'Quarter arc block', insertionPoint: [0, 0],
      constrained: quarterArcBlockConstrained(),
    },
  },
  {
    kind: 'sketch.constrained.create',
    input: { id: 'sketch-semicircle-block', name: 'Tiny free semicircle block', plane: 'XY', z: 0, constrained: probeSeed },
  },
  {
    kind: 'sketch.constrained.create',
    input: { id: 'sketch-quarter-arc-block', name: 'Tiny free quarter-arc block', plane: 'XY', z: 0, constrained: probeSeed },
  },
  {
    kind: 'sketch.constrained.create',
    input: { id: 'sketch-quarter-arc-exact', name: 'Model-scale quarter-arc block', plane: 'XY', z: 0, constrained: probeSeed },
  },
  {
    kind: 'sketch.blockInstance.create',
    input: {
      sketchId: 'sketch-semicircle-block', id: 'semicircle-instance', definitionId: 'block-semicircle',
      transform: { translation: [0, 0], angleDeg: 0, scale: 1e-6 }, fixed: false,
    },
  },
  {
    kind: 'sketch.blockInstance.create',
    input: {
      sketchId: 'sketch-quarter-arc-block', id: 'quarter-arc-instance', definitionId: 'block-quarter-arc',
      transform: { translation: [20e-6, 0], angleDeg: 0, scale: 1e-6 }, fixed: false,
    },
  },
  {
    kind: 'sketch.blockInstance.create',
    input: {
      sketchId: 'sketch-quarter-arc-exact', id: 'quarter-arc-exact-instance', definitionId: 'block-quarter-arc',
      transform: { translation: [20, 0], angleDeg: 0, scale: 1 }, fixed: false,
    },
  },
  {
    kind: 'feature.extrude',
    input: {
      id: 'feature-exact-quarter-arc', name: 'Model-scale quarter-arc exact extrusion',
      sketchId: 'sketch-quarter-arc-exact', height: 1,
      resultPolicy: { kind: 'new-body', bodyName: 'Exact quarter arc' },
    },
  },
]);
const freeSemicircle = resolveFirstClassSketch(arcBlockProject, 'sketch-semicircle-block');
const freeQuarterArc = resolveFirstClassSketch(arcBlockProject, 'sketch-quarter-arc-block');
const tinySemicirclePrefix = instanceTools.studioSketchBlockMemberPrefix('semicircle-instance');
const tinyQuarterArcPrefix = instanceTools.studioSketchBlockMemberPrefix('quarter-arc-instance');
check(`a free 1e-6-scale semicircle block did not preserve exactly three rigid-pose DOF: ${JSON.stringify({
  dof: freeSemicircle.dof, rank: freeSemicircle.rank, equations: freeSemicircle.equations,
})}`,
  freeSemicircle.dof === 3
  && freeSemicircle.loops.length === 1
  && freeSemicircle.exactEntities.some((entry: JsonRecord) =>
    entry.kind === 'arc' && entry.id === instanceTools.studioSketchBlockMemberId('semicircle-instance', 'semi-arc'))
  && freeSemicircle.exactEntities.some((entry: JsonRecord) =>
    entry.kind === 'line' && entry.id === instanceTools.studioSketchBlockMemberId('semicircle-instance', 'semi-diameter'))
  && freeSemicircle.solved.entities.filter((entry: JsonRecord) => entry.id.startsWith(tinySemicirclePrefix)).length === 5
  && closeBounds(memberBounds(freeSemicircle, tinySemicirclePrefix, 3),
    [[-5e-6, 0], [5e-6, 0]], 1e-10));
check(`a free 1e-6-scale quarter-arc block did not preserve exactly three rigid-pose DOF: ${JSON.stringify({
  dof: freeQuarterArc.dof, rank: freeQuarterArc.rank, equations: freeQuarterArc.equations,
})}`,
  freeQuarterArc.dof === 3
  && freeQuarterArc.loops.length === 1
  && freeQuarterArc.exactEntities.some((entry: JsonRecord) =>
    entry.kind === 'arc' && entry.id === instanceTools.studioSketchBlockMemberId('quarter-arc-instance', 'quarter-arc'))
  && ['quarter-radial-a', 'quarter-radial-b'].every((memberId) =>
    freeQuarterArc.exactEntities.some((entry: JsonRecord) =>
      entry.kind === 'line' && entry.id === instanceTools.studioSketchBlockMemberId('quarter-arc-instance', memberId)))
  && freeQuarterArc.solved.entities.filter((entry: JsonRecord) => entry.id.startsWith(tinyQuarterArcPrefix)).length === 6
  && closeBounds(memberBounds(freeQuarterArc, tinyQuarterArcPrefix, 3),
    [[20e-6, 0], [25e-6, 5e-6]], 1e-10));

let semicircleExactProject = projectTools.createEmptyStudioV5PartProject({
  projectId: 'sketch-semicircle-naming-refusal', name: 'Semicircle naming refusal', units: 'mm',
}) as JsonRecord;
semicircleExactProject = apply(semicircleExactProject, 'create-semicircle-naming-refusal', [
  {
    kind: 'sketch.blockDefinition.create',
    input: {
      id: 'block-semicircle-refusal', name: 'Semicircle refusal block', insertionPoint: [0, 0],
      constrained: semicircleBlockConstrained(),
    },
  },
  {
    kind: 'sketch.constrained.create',
    input: { id: 'sketch-semicircle-refusal', name: 'Semicircle refusal sketch', plane: 'XY', z: 0, constrained: probeSeed },
  },
  {
    kind: 'sketch.blockInstance.create',
    input: {
      sketchId: 'sketch-semicircle-refusal', id: 'semicircle-refusal-instance',
      definitionId: 'block-semicircle-refusal',
      transform: { translation: [0, 0], angleDeg: 0, scale: 1 }, fixed: false,
    },
  },
  {
    kind: 'feature.extrude',
    input: {
      id: 'feature-semicircle-refusal', name: 'Semicircle naming refusal extrusion',
      sketchId: 'sketch-semicircle-refusal', height: 1,
      resultPolicy: { kind: 'new-body', bodyName: 'Semicircle naming refusal' },
    },
  },
]);

let linkedCutStockProject = projectTools.createEmptyStudioV5PartProject({
  projectId: 'sketch-linked-cut-exact', name: 'Linked Cut exact worker proof', units: 'mm',
}) as JsonRecord;
linkedCutStockProject = apply(linkedCutStockProject, 'create-linked-cut-stock', [
  {
    kind: 'sketch.constrained.create',
    input: {
      id: 'sketch-linked-cut-stock', name: 'Linked Cut stock profile', plane: 'XY', z: 0,
      constrained: rectangleConstrained(20, 20, 'cut-stock'),
    },
  },
  {
    kind: 'feature.extrude',
    input: {
      id: 'feature-linked-cut-stock', name: 'Linked Cut stock', sketchId: 'sketch-linked-cut-stock', height: 5,
      resultPolicy: { kind: 'new-body', bodyName: 'Linked Cut stock' },
    },
  },
]);
const linkedCutStockPart = runtimeTools.studioV5RootPart(linkedCutStockProject);
const linkedCutStockBodyId = linkedCutStockPart.bodies.find((entry: JsonRecord) =>
  entry.createdByFeatureId === 'feature-linked-cut-stock')?.id;
check('linked Cut stock extrusion did not create a target body', linkedCutStockBodyId);
let linkedCutProject = apply(linkedCutStockProject, 'create-linked-cut-subtraction', [
  {
    kind: 'sketch.constrained.create',
    input: {
      id: 'sketch-linked-cut-tool', name: 'Linked Cut tool profile', plane: 'XY', z: 0,
      constrained: rectangleConstrained(4, 4, 'cut-tool', [8, 8]),
    },
  },
  {
    kind: 'feature.cut',
    input: {
      id: 'feature-linked-cut', name: 'Linked first-class Cut', sketchId: 'sketch-linked-cut-tool',
      height: 5, through: true,
      resultPolicy: { kind: 'subtract', targetBodyIds: [linkedCutStockBodyId], keepTools: false },
    },
  },
]);

const adjacentSourcePartId = runtimeTools.studioV5RootPart(project).id;
const adjacentAssemblyProject = apply(project, 'assembly-root-adjacent-regression', [
  {
    kind: 'assembly.create',
    input: {
      id: 'assembly-sketch-instance-adjacent', name: 'Sketch instance adjacent assembly',
      occurrenceId: 'occurrence-sketch-instance-adjacent', occurrenceName: 'Sketch instance part:1', fixed: true,
    },
  },
  { kind: 'project.rename', input: { name: 'Sketch instance assembly renamed' } },
]);
const adjacentAssembly = runtimeTools.studioV5RootAssembly(adjacentAssemblyProject);
const adjacentSourcePart = adjacentAssemblyProject.partDefinitions.find((entry: JsonRecord) => entry.id === adjacentSourcePartId);
const adjacentParameters = modelingTools.studioV5ParameterValues(adjacentAssemblyProject, adjacentSourcePart);
const adjacentResolution = instanceTools.resolveStudioConstrainedSketch(adjacentSourcePart, 'sketch-block-frame', {
  evaluate: (value: unknown) => modelingTools.evaluateStudioV5Expression(value, adjacentParameters),
});
check('assembly-root conversion or rename corrupted the retained first-class sketch graph',
  adjacentAssemblyProject.rootDocument.kind === 'assembly'
  && adjacentAssembly.name === 'Sketch instance assembly renamed'
  && adjacentAssembly.occurrences.length === 1
  && adjacentAssembly.occurrences[0].definition.partId === adjacentSourcePartId
  && adjacentResolution.loops.length === 2
  && adjacentResolution.dof === 0);

function editedDefinition(width: number, height: number): JsonRecord {
  return rectangleConstrained(width, height, 'definition');
}

type ExactPhase = {
  result: JsonRecord;
  target: JsonRecord;
  derived: JsonRecord;
  inheritedSupport: JsonRecord;
  targetBrepHash: string;
  derivedBrepHash: string;
};

let kernel: HeadlessKernel | null = null;
let exactRevision = 0;
async function rebuildExact(document: JsonRecord, label: string): Promise<ExactPhase> {
  exactRevision += 1;
  const result = await kernel!.request({
    kind: 'rebuild', requestId: `sketch-instances-exact-${exactRevision}-${label}`,
    projectId: document.projectId, revision: exactRevision, document, includeExactBrep: true,
  }, 180_000) as JsonRecord;
  check(`${label} exact rebuild failed: ${JSON.stringify(result.errors || [])}`,
    result.kind === 'rebuild-result' && result.errors?.length === 0 && result.warnings?.length === 0);
  check(`${label} exact evidence is not bound to the current canonical document hash`,
    result.effectiveDocumentHash === runtimeTools.studioV5CanonicalHash(document));
  const phasePart = runtimeTools.studioV5RootPart(document);
  const bodyFor = (featureId: string): JsonRecord => {
    const bodyId = phasePart.bodies.find((entry: JsonRecord) => entry.createdByFeatureId === featureId)?.id;
    const body = result.bodies.find((entry: JsonRecord) => entry.bodyId === bodyId);
    check(`${label} has no exact body created by ${featureId}`, body);
    check(`${label}/${featureId} is not one valid exact OCCT solid`,
      !body.error && body.lastValid === false
      && body.geometry?.valid === true && body.geometry?.brepValid === true && body.geometry?.solidCount === 1);
    const counts = body.mesh?.topologyCounts;
    check(`${label}/${featureId} does not retain complete face/edge/vertex identity`,
      counts?.faces === counts?.namedFaces && counts?.edges === counts?.namedEdges
      && counts?.vertices === counts?.namedVertices && counts.faces > 0 && counts.edges > 0 && counts.vertices > 0
      && body.mesh.topologyDiagnostics?.length === 0);
    return body;
  };
  const target = bodyFor('feature-block-frame');
  const derived = bodyFor('feature-derived-frame');
  const inheritedSupport = bodyFor('feature-yz-derived');
  return {
    result, target, derived, inheritedSupport,
    targetBrepHash: brepHash(target), derivedBrepHash: brepHash(derived),
  };
}

function assertExactBody(
  label: string,
  body: JsonRecord,
  expectedBounds: number[][],
  expectedVolume: number,
  provenanceMarkers: string[],
): void {
  check(`${label} bounds changed: ${JSON.stringify(body.geometry?.bounds)}`,
    closeBounds(body.geometry?.bounds, expectedBounds));
  check(`${label} volume changed: ${String(body.geometry?.volume)}`,
    closeTo(body.geometry?.volume, expectedVolume));
  check(`${label} frame topology changed`,
    body.geometry.faceCount === 10 && body.geometry.edgeCount === 24 && body.geometry.vertexCount === 16);
  const names = decodedTopologyNames(body).join('\n');
  for (const marker of provenanceMarkers) {
    check(`${label} exact topology lost provenance marker ${marker}`, names.includes(marker));
  }
}

function assertExactSupport(body: JsonRecord): void {
  check(`inherited YZ support bounds changed: ${JSON.stringify(body.geometry?.bounds)}`,
    closeBounds(body.geometry?.bounds, [[7, 10, 20], [9, 14, 23]]));
  check(`inherited YZ support volume changed: ${String(body.geometry?.volume)}`,
    closeTo(body.geometry?.volume, 24));
  check('inherited YZ support topology changed',
    body.geometry.faceCount === 6 && body.geometry.edgeCount === 12 && body.geometry.vertexCount === 8);
  const names = decodedTopologyNames(body).join('\n');
  check('inherited YZ support lost exact feature or derived-member provenance',
    names.includes('feature-yz-derived') && names.includes('sketch-yz-derived'));
}

function assertWarmWorkerEvaluation(label: string, phase: ExactPhase, featureIds: string[]): void {
  const evaluated = phase.result.evaluation?.evaluatedFeatureIds || [];
  const reused = phase.result.evaluation?.reusedFeatureIds || [];
  for (const featureId of featureIds) {
    check(`${label} did not evaluate invalidated feature ${featureId} on the warm production worker`,
      evaluated.includes(featureId));
    check(`${label} incorrectly reused stale feature ${featureId} on the warm production worker`,
      !reused.includes(featureId));
  }
}


function assertWarmWorkerReuse(label: string, phase: ExactPhase, featureId: string): void {
  const evaluated = phase.result.evaluation?.evaluatedFeatureIds || [];
  const reused = phase.result.evaluation?.reusedFeatureIds || [];
  check(`${label} reevaluated unrelated feature ${featureId}`, !evaluated.includes(featureId));
  check(`${label} did not reuse unrelated feature ${featureId}`, reused.includes(featureId));
}

async function rebuildAuxiliaryExact(document: JsonRecord, revision: number, label: string): Promise<JsonRecord> {
  const result = await kernel!.request({
    kind: 'rebuild', requestId: `${document.projectId}-${revision}-${label}`,
    projectId: document.projectId, revision, document, includeExactBrep: true,
  }, 180_000) as JsonRecord;
  check(`${label} auxiliary exact rebuild failed: ${JSON.stringify(result.errors || [])}`,
    result.kind === 'rebuild-result' && result.errors?.length === 0 && result.warnings?.length === 0);
  check(`${label} auxiliary exact evidence is not bound to its canonical document hash`,
    result.effectiveDocumentHash === runtimeTools.studioV5CanonicalHash(document));
  return result;
}

function auxiliaryBody(document: JsonRecord, result: JsonRecord, featureId: string, label: string): JsonRecord {
  const bodyId = runtimeTools.studioV5RootPart(document).bodies.find((entry: JsonRecord) =>
    entry.createdByFeatureId === featureId)?.id;
  const body = result.bodies.find((entry: JsonRecord) => entry.bodyId === bodyId);
  check(`${label} has no production-worker body for ${featureId}`, body);
  check(`${label}/${featureId} is not one valid exact OCCT solid`,
    !body.error && body.lastValid === false
    && body.geometry?.valid === true && body.geometry?.brepValid === true && body.geometry?.solidCount === 1);
  const counts = body.mesh?.topologyCounts;
  check(`${label}/${featureId} exact topology is not fully named`,
    counts?.faces === counts?.namedFaces && counts?.edges === counts?.namedEdges
    && counts?.vertices === counts?.namedVertices
    && body.mesh.topologyDiagnostics?.length === 0);
  brepHash(body);
  return body;
}

let initialExact: ExactPhase;
let editedBothExact: ExactPhase;
let explodedLinkedExact: ExactPhase;
let underivedExact: ExactPhase;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();

  const semicircleRefusalResult = await kernel.request({
    kind: 'rebuild', requestId: 'semicircle-naming-refusal-1',
    projectId: semicircleExactProject.projectId, revision: 1,
    document: semicircleExactProject, includeExactBrep: true,
  }, 180_000) as JsonRecord;
  check('semicircle naming refusal did not return a bounded production-worker rebuild result',
    semicircleRefusalResult.kind === 'rebuild-result'
    && semicircleRefusalResult.effectiveDocumentHash === runtimeTools.studioV5CanonicalHash(semicircleExactProject)
    && semicircleRefusalResult.warnings?.length === 0
    && semicircleRefusalResult.errors?.length === 1);
  const semicircleRefusal = semicircleRefusalResult.errors[0];
  const semicircleRefusalDiagnostics = JSON.stringify(semicircleRefusal.diagnostics || []);
  check(`semicircle seam ambiguity was not refused with exact member evidence: ${JSON.stringify(semicircleRefusal)}`,
    semicircleRefusal.featureId === 'feature-semicircle-refusal'
    && semicircleRefusal.code === 'TOPOLOGY_NAMING_AMBIGUOUS_SUFFIX'
    && semicircleRefusalDiagnostics.includes('semi-arc')
    && semicircleRefusalDiagnostics.includes('semi-diameter'));

  const arcExactResult = await rebuildAuxiliaryExact(arcBlockProject, 1, 'tiny-free-arc-blocks');
  const exactQuarterArc = auxiliaryBody(arcBlockProject, arcExactResult, 'feature-exact-quarter-arc', 'exact quarter-arc block');
  check(`quarter-arc exact bounds or volume changed: ${JSON.stringify(exactQuarterArc.geometry)}`,
    closeBounds(exactQuarterArc.geometry.bounds, [[20, 0, 0], [25, 5, 1]])
    && closeTo(exactQuarterArc.geometry.volume, 6.25 * Math.PI));
  check('quarter-arc exact topology changed',
    exactQuarterArc.geometry.faceCount === 5
    && exactQuarterArc.geometry.edgeCount === 9
    && exactQuarterArc.geometry.vertexCount === 6);
  const quarterArcNames = decodedTopologyNames(exactQuarterArc).join('\n');
  check(`quarter-arc exact topology lost block/member provenance: ${quarterArcNames}`,
    quarterArcNames.includes('feature-exact-quarter-arc')
    && quarterArcNames.includes('quarter-arc-exact-instance')
    && quarterArcNames.includes('quarter-arc'));

  const linkedCutStockExact = await rebuildAuxiliaryExact(linkedCutStockProject, 1, 'linked-cut-stock');
  const stockExactBody = auxiliaryBody(
    linkedCutStockProject, linkedCutStockExact, 'feature-linked-cut-stock', 'linked Cut stock');
  check('linked Cut stock exact geometry changed before subtraction',
    closeBounds(stockExactBody.geometry.bounds, [[0, 0, 0], [20, 20, 5]])
    && closeTo(stockExactBody.geometry.volume, 2000)
    && stockExactBody.geometry.faceCount === 6
    && stockExactBody.geometry.edgeCount === 12
    && stockExactBody.geometry.vertexCount === 8);
  const linkedCutExact = await rebuildAuxiliaryExact(linkedCutProject, 2, 'linked-cut-subtraction');
  const cutExactBody = linkedCutExact.bodies.find((entry: JsonRecord) => entry.bodyId === linkedCutStockBodyId);
  check('linked Cut exact subtraction lost its target body', cutExactBody);
  check('linked Cut result is not one valid exact OCCT subtraction',
    !cutExactBody.error && cutExactBody.lastValid === false
    && cutExactBody.geometry?.valid === true && cutExactBody.geometry?.brepValid === true
    && cutExactBody.geometry?.solidCount === 1 && brepHash(cutExactBody) !== brepHash(stockExactBody));
  check(`linked Cut exact bounds, volume, or topology changed: ${JSON.stringify(cutExactBody.geometry)}`,
    closeBounds(cutExactBody.geometry.bounds, [[0, 0, 0], [20, 20, 5]])
    && closeTo(cutExactBody.geometry.volume, 1920)
    && cutExactBody.geometry.faceCount === 10
    && cutExactBody.geometry.edgeCount === 24
    && cutExactBody.geometry.vertexCount === 16);
  const cutCounts = cutExactBody.mesh?.topologyCounts;
  check('linked Cut exact subtraction topology is not fully named',
    cutCounts?.faces === cutCounts?.namedFaces && cutCounts?.edges === cutCounts?.namedEdges
    && cutCounts?.vertices === cutCounts?.namedVertices
    && cutExactBody.mesh.topologyDiagnostics?.length === 0);
  const cutNames = decodedTopologyNames(cutExactBody).join('\n');
  const linkedCutFeature = runtimeTools.studioV5RootPart(linkedCutProject).features.find((entry: JsonRecord) =>
    entry.id === 'feature-linked-cut');
  check(`linked Cut exact topology lost feature/sketch provenance: ${cutNames}`,
    linkedCutFeature?.sketchId === 'sketch-linked-cut-tool'
    && cutNames.includes('feature-linked-cut')
    && ['cut-tool-bottom', 'cut-tool-right', 'cut-tool-top', 'cut-tool-left']
      .every((memberId) => cutNames.includes(memberId)));
  check('linked Cut did not evaluate on the warm production worker',
    linkedCutExact.evaluation?.evaluatedFeatureIds?.includes('feature-linked-cut'));
  check('linked Cut reevaluated rather than reusing its unchanged stock dependency',
    linkedCutExact.evaluation?.reusedFeatureIds?.includes('feature-linked-cut-stock'));

  initialExact = await rebuildExact(project, 'initial-linked-blocks');
  assertExactBody('initial linked block feature', initialExact.target, [[0, 0, 0], [20, 12, 5]], 900,
    ['feature-block-frame', 'block-outer', 'block-inner']);
  assertExactBody('initial associative derived feature', initialExact.derived, [[30, 0, 10], [50, 12, 13]], 540,
    ['feature-derived-frame', 'sketch-derived-frame', 'block-outer', 'block-inner']);
  assertExactSupport(initialExact.inheritedSupport);

  project = apply(project, 'edit-definition-updates-both-instances', [{
    kind: 'sketch.blockDefinition.update',
    input: { definitionId: 'block-rectangle', patch: { constrained: editedDefinition(12, 8) } },
  }]);
  part = runtimeTools.studioV5RootPart(project);
  resolvedTarget = resolveFirstClassSketch(project, 'sketch-block-frame');
  check('definition edit did not update the scaled outer instance',
    closeBounds(memberBounds(resolvedTarget, instanceTools.studioSketchBlockMemberPrefix('block-outer')), [[0, 0], [24, 16]]));
  check('definition edit did not update the independently posed inner instance',
    closeBounds(memberBounds(resolvedTarget, instanceTools.studioSketchBlockMemberPrefix('block-inner')), [[5, 3], [17, 11]]));
  check('definition edit broke coincident endpoint connectivity in either linked instance',
    resolvedTarget.loops.length === 2
    && resolvedTarget.connectivityConstraints.length === 9
    && resolvedTarget.flattened.constraints.length === 20);
  const derivedAfterDefinitionEdit = resolveFirstClassSketch(project, 'sketch-derived-frame');
  check('definition edit did not propagate through the associative derived sketch',
    closeBounds(memberBounds(derivedAfterDefinitionEdit, 'ds:'), [[30, 0], [54, 16]]));

  editedBothExact = await rebuildExact(project, 'definition-edits-both');
  assertWarmWorkerEvaluation('block-definition edit', editedBothExact,
    ['feature-block-frame', 'feature-derived-frame']);
  assertWarmWorkerReuse('block-definition edit', editedBothExact, 'feature-yz-derived');
  assertExactBody('edited two-instance block feature', editedBothExact.target, [[0, 0, 0], [24, 16, 5]], 1440,
    ['feature-block-frame', 'block-outer', 'block-inner']);
  assertExactBody('edited associative derived feature', editedBothExact.derived, [[30, 0, 10], [54, 16, 13]], 864,
    ['feature-derived-frame', 'sketch-derived-frame', 'block-outer', 'block-inner']);
  check('definition edit reused stale target or derived BREP bytes',
    initialExact.targetBrepHash !== editedBothExact.targetBrepHash
    && initialExact.derivedBrepHash !== editedBothExact.derivedBrepHash);

  const outerPrefix = instanceTools.studioSketchBlockMemberPrefix('block-outer');
  const outerMemberIdsBeforeExplode = resolvedTarget.solved.entities
    .filter((entry: JsonRecord) => entry.id.startsWith(outerPrefix))
    .map((entry: JsonRecord) => entry.id).sort();
  project = apply(project, 'explode-one-block-instance', [{
    kind: 'sketch.blockInstance.explode', input: { sketchId: 'sketch-block-frame', instanceId: 'block-outer' },
  }]);
  const explodeRemapped = latestRemap();
  part = runtimeTools.studioV5RootPart(project);
  targetSketch = part.sketches.find((entry: JsonRecord) => entry.id === 'sketch-block-frame');
  check(`explode did not replace exactly one linked instance with identity-stable local members: ${JSON.stringify({
    instances: targetSketch.constrained.blockInstances.map((entry: JsonRecord) => entry.id),
    entityIds: targetSketch.constrained.entities.map((entry: JsonRecord) => entry.id),
  })}`,
    targetSketch.constrained.blockInstances.length === 1
    && targetSketch.constrained.blockInstances[0].id === 'block-inner'
    && JSON.stringify(targetSketch.constrained.entities
      .filter((entry: JsonRecord) => entry.id.startsWith(outerPrefix))
      .map((entry: JsonRecord) => entry.id).sort()) === JSON.stringify(outerMemberIdsBeforeExplode));
  check('identity-preserving Explode reported an artificial member remap', explodeRemapped.length === 0);
  const resolvedAfterExplode = resolveFirstClassSketch(project, 'sketch-block-frame');
  check(`Explode did not materialize or retain all coincident endpoint joins: ${JSON.stringify({
    localCoincidences: targetSketch.constrained.constraints.filter((entry: JsonRecord) => entry.kind === 'coincident').length,
    connectivity: resolvedAfterExplode.connectivityConstraints.length,
    constraints: resolvedAfterExplode.flattened.constraints.length,
    loops: resolvedAfterExplode.loops.length,
  })}`,
    targetSketch.constrained.constraints.length === 4
    && targetSketch.constrained.constraints.every((entry: JsonRecord) => entry.kind === 'coincident')
    && resolvedAfterExplode.connectivityConstraints.length === 9
    && resolvedAfterExplode.flattened.constraints.length === 15
    && resolvedAfterExplode.loops.length === 2);
  const explodedMemberBytes = JSON.stringify(targetSketch.constrained.entities.filter((entry: JsonRecord) =>
    entry.id.startsWith(outerPrefix)));

  project = apply(project, 'later-definition-edit-updates-only-linked-instance', [{
    kind: 'sketch.blockDefinition.update',
    input: { definitionId: 'block-rectangle', patch: { constrained: editedDefinition(14, 9) } },
  }]);
  part = runtimeTools.studioV5RootPart(project);
  targetSketch = part.sketches.find((entry: JsonRecord) => entry.id === 'sketch-block-frame');
  check('later definition edit changed exploded local member bytes',
    JSON.stringify(targetSketch.constrained.entities.filter((entry: JsonRecord) =>
      entry.id.startsWith(outerPrefix))) === explodedMemberBytes);
  resolvedTarget = resolveFirstClassSketch(project, 'sketch-block-frame');
  check('exploded outer instance did not stay frozen at its 24 by 16 geometry',
    closeBounds(memberBounds(resolvedTarget, outerPrefix), [[0, 0], [24, 16]]));
  check('linked inner instance did not update to the 14 by 9 definition',
    closeBounds(memberBounds(resolvedTarget, instanceTools.studioSketchBlockMemberPrefix('block-inner')), [[5, 3], [19, 12]]));
  check('later definition edit broke the exploded or linked endpoint connectivity',
    resolvedTarget.loops.length === 2
    && resolvedTarget.connectivityConstraints.length === 9
    && resolvedTarget.flattened.constraints.length === 15);

  explodedLinkedExact = await rebuildExact(project, 'exploded-and-linked');
  assertWarmWorkerEvaluation('derived-source edit', explodedLinkedExact,
    ['feature-block-frame', 'feature-derived-frame']);
  assertWarmWorkerReuse('derived-source edit', explodedLinkedExact, 'feature-yz-derived');
  assertExactBody('exploded plus linked block feature', explodedLinkedExact.target, [[0, 0, 0], [24, 16, 5]], 1290,
    ['feature-block-frame', 'block-outer', 'block-inner']);
  assertExactBody('derived feature after explode and linked edit', explodedLinkedExact.derived, [[30, 0, 10], [54, 16, 13]], 774,
    ['feature-derived-frame', 'sketch-derived-frame', 'block-outer', 'block-inner']);

  expectTypedRejection('direct derived membership edit', project, [{
    kind: 'sketch.constrained.update',
    input: { sketchId: 'sketch-derived-frame', patch: { constrained: rectangleConstrained(2, 2, 'illegal-derived-edit') } },
  }], 'DOCUMENT_VALIDATION_FAILED', /rejects direct membership edits/u);

  const derivedBeforeUnderive = resolveFirstClassSketch(project, 'sketch-derived-frame');
  check('associative derived sketch lost source endpoint connectivity before Underive',
    derivedBeforeUnderive.loops.length === 2
    && derivedBeforeUnderive.connectivityConstraints.length === 9
    && derivedBeforeUnderive.exactEntities.filter((entry: JsonRecord) => entry.kind === 'line').length === 8);
  const derivedMemberIdsBeforeUnderive = derivedBeforeUnderive.solved.entities
    .map((entry: JsonRecord) => entry.id).sort();
  project = apply(project, 'underive-freezes-associative-members', [{
    kind: 'sketch.derived.underive', input: { sketchId: 'sketch-derived-frame' },
  }]);
  const underiveRemapped = latestRemap();
  part = runtimeTools.studioV5RootPart(project);
  let derivedSketch = part.sketches.find((entry: JsonRecord) => entry.id === 'sketch-derived-frame');
  check('Underive did not replace the link with editable local members',
    !derivedSketch.constrained.derivedFrom && derivedSketch.constrained.entities.length > 0
    && derivedSketch.constrained.blockInstances.length === 0);
  check('Underive did not materialize all source endpoint joins as editable local constraints',
    derivedSketch.constrained.constraints.length === 9
    && derivedSketch.constrained.constraints.every((entry: JsonRecord) => entry.kind === 'coincident'));
  check('Underive changed stable resolved member identities',
    JSON.stringify(derivedSketch.constrained.entities.map((entry: JsonRecord) => entry.id).sort())
    === JSON.stringify(derivedMemberIdsBeforeUnderive));
  check('identity-preserving Underive reported an artificial member remap', underiveRemapped.length === 0);
  const frozenDerivedBytes = JSON.stringify(derivedSketch.constrained);
  const underivedResolution = resolveFirstClassSketch(project, 'sketch-derived-frame');
  check('Underive changed the resolved geometry it froze',
    JSON.stringify(underivedResolution.exactEntities) === JSON.stringify(derivedBeforeUnderive.exactEntities)
    && underivedResolution.loops.length === 2
    && underivedResolution.connectivityConstraints.length === 9
    && underivedResolution.exactEntities.filter((entry: JsonRecord) => entry.kind === 'line').length === 8);

  project = apply(project, 'edit-definition-after-underive', [{
    kind: 'sketch.blockDefinition.update',
    input: { definitionId: 'block-rectangle', patch: { constrained: editedDefinition(16, 10) } },
  }]);
  part = runtimeTools.studioV5RootPart(project);
  derivedSketch = part.sketches.find((entry: JsonRecord) => entry.id === 'sketch-derived-frame');
  check('definition edit after Underive changed frozen derived membership',
    JSON.stringify(derivedSketch.constrained) === frozenDerivedBytes);
  resolvedTarget = resolveFirstClassSketch(project, 'sketch-block-frame');
  check('definition edit after Underive did not continue updating the linked inner instance',
    closeBounds(memberBounds(resolvedTarget, instanceTools.studioSketchBlockMemberPrefix('block-inner')), [[5, 3], [21, 13]]));
  check('definition edit after Underive changed the exploded outer instance',
    closeBounds(memberBounds(resolvedTarget, outerPrefix), [[0, 0], [24, 16]]));

  const canonicalText = JSON.stringify(runtimeTools.canonicalStudioV5Project(project));
  const reopened = projectTools.parseStudioV5Project(canonicalText) as JsonRecord;
  check('canonical save/reopen changed sketch-block or Underive document bytes',
    JSON.stringify(reopened) === canonicalText);
  project = reopened;

  underivedExact = await rebuildExact(project, 'canonical-reopen-underived');
  assertWarmWorkerReuse('canonical reopen after Underive', underivedExact, 'feature-yz-derived');
  assertExactBody('final exploded plus linked block feature', underivedExact.target, [[0, 0, 0], [24, 16, 5]], 1120,
    ['feature-block-frame', 'block-outer', 'block-inner']);
  assertExactBody('final frozen Underived feature', underivedExact.derived, [[30, 0, 10], [54, 16, 13]], 774,
    ['feature-derived-frame', 'sketch-derived-frame']);
  check('post-Underive source edit did not change the target exact BREP',
    underivedExact.targetBrepHash !== explodedLinkedExact.targetBrepHash);
  check('Underive or later source edits changed the frozen derived exact BREP',
    underivedExact.derivedBrepHash === explodedLinkedExact.derivedBrepHash);
} finally {
  await kernel?.dispose();
}

const reusableSixtyCharacterSketchId = 's'.repeat(60);
const independentSourcePart = runtimeTools.studioV5RootPart(project);
const independentSourceBlockSketch = independentSourcePart.sketches.find((entry: JsonRecord) =>
  entry.id === 'sketch-block-frame');
const independentSourceUnderivedSketch = independentSourcePart.sketches.find((entry: JsonRecord) =>
  entry.id === 'sketch-derived-frame');
const explodedBiLineId = independentSourceBlockSketch.constrained.entities.find((entry: JsonRecord) =>
  entry.kind === 'line' && entry.id.startsWith('bi:') && entry.id.endsWith('definition-bottom'))?.id;
const underivedDsLineId = independentSourceUnderivedSketch.constrained.entities.find((entry: JsonRecord) =>
  entry.kind === 'line' && entry.id.startsWith('ds:') && entry.id.endsWith('definition-bottom'))?.id;
check('make-independent fixture lacks typical exploded bi: or Underived ds: member IDs',
  explodedBiLineId?.startsWith('bi:') && underivedDsLineId?.startsWith('ds:'));

let independentSourceProject = apply(project, 'create-make-independent-remap-fixtures', [
  {
    kind: 'sketch.constrained.create',
    input: {
      id: reusableSixtyCharacterSketchId, name: 'Sixty character reusable sketch',
      plane: 'XY', z: 0, constrained: probeSeed,
    },
  },
  {
    kind: 'sketch.relation.create',
    input: {
      sketchId: 'sketch-block-frame',
      relation: {
        id: 'independent-exploded-bi-relation', kind: 'horizontal',
        line: { entityId: explodedBiLineId },
      },
    },
  },
  {
    kind: 'sketch.relation.create',
    input: {
      sketchId: 'sketch-derived-frame',
      relation: {
        id: 'independent-underived-ds-relation', kind: 'horizontal',
        line: { entityId: underivedDsLineId },
      },
    },
  },
]);
const independentOriginalPartId = runtimeTools.studioV5RootPart(independentSourceProject).id;
let independentAssemblyProject = apply(independentSourceProject, 'create-make-independent-assembly', [{
  kind: 'assembly.create',
  input: {
    id: 'assembly-make-independent-remap', name: 'Make independent remap assembly',
    occurrenceId: 'occurrence-make-independent-remap', occurrenceName: 'Remap source:1', fixed: true,
  },
}]);
independentAssemblyProject = apply(independentAssemblyProject, 'make-sketch-reuse-part-independent', [{
  kind: 'component.makeIndependent',
  input: {
    occurrenceId: 'occurrence-make-independent-remap', partId: 'independent-remap-copy',
    name: 'Independent sketch reuse copy', occurrenceName: 'Independent copy:1',
  },
}]);
const independentAssembly = runtimeTools.studioV5RootAssembly(independentAssemblyProject);
const independentPart = independentAssemblyProject.partDefinitions.find((entry: JsonRecord) =>
  entry.id === 'independent-remap-copy');
check('Make independent did not preserve the source part and repoint exactly one occurrence to its copy',
  independentAssemblyProject.partDefinitions.some((entry: JsonRecord) => entry.id === independentOriginalPartId)
  && independentAssembly.occurrences.length === 1
  && independentAssembly.occurrences[0].definition.partId === 'independent-remap-copy'
  && independentPart);
const copiedSixtySketch = independentPart.sketches.find((entry: JsonRecord) =>
  entry.name === 'Sixty character reusable sketch');
const copiedBlockSketch = independentPart.sketches.find((entry: JsonRecord) => entry.name === 'Nested block frame');
const copiedUnderivedSketch = independentPart.sketches.find((entry: JsonRecord) => entry.name === 'Associative derived frame');
check('Make independent did not bound and preserve the 60-character reusable sketch ID',
  copiedSixtySketch?.id.length === 60
  && copiedSixtySketch.id !== reusableSixtyCharacterSketchId
  && copiedSixtySketch.extensions?.studioRole === 'constrained-2d');
const copiedBiRelation = copiedBlockSketch.constrained.relations.find((entry: JsonRecord) =>
  entry.id.endsWith('independent-exploded-bi-relation'));
const copiedDsRelation = copiedUnderivedSketch.constrained.relations.find((entry: JsonRecord) =>
  entry.id.endsWith('independent-underived-ds-relation'));
const copiedBiLineId = copiedBiRelation?.line?.entityId;
const copiedDsLineId = copiedDsRelation?.line?.entityId;
check('Make independent did not remap an exploded bi: member relation to one stored copied line',
  typeof copiedBiLineId === 'string' && copiedBiLineId.includes('bi:') && copiedBiLineId.length <= 60
  && copiedBlockSketch.constrained.entities.some((entry: JsonRecord) =>
    entry.id === copiedBiLineId && entry.kind === 'line'));
check('Make independent did not remap an Underived ds: member relation to one stored copied line',
  typeof copiedDsLineId === 'string' && copiedDsLineId.includes('ds:') && copiedDsLineId.length <= 60
  && copiedUnderivedSketch.constrained.entities.some((entry: JsonRecord) =>
    entry.id === copiedDsLineId && entry.kind === 'line'));
const independentParameters = modelingTools.studioV5ParameterValues(independentAssemblyProject, independentPart);
const resolveIndependentSketch = (sketchId: string): JsonRecord => instanceTools.resolveStudioConstrainedSketch(
  independentPart,
  sketchId,
  { evaluate: (value: unknown) => modelingTools.evaluateStudioV5Expression(value, independentParameters) },
);
const copiedBlockResolution = resolveIndependentSketch(copiedBlockSketch.id);
const copiedUnderivedResolution = resolveIndependentSketch(copiedUnderivedSketch.id);
const copiedSixtyResolution = resolveIndependentSketch(copiedSixtySketch.id);
check('Make independent produced invalid remapped first-class sketches or relations',
  copiedBlockResolution.loops.length === 2 && copiedBlockResolution.connectivityConstraints.length === 9
  && copiedUnderivedResolution.loops.length === 2 && copiedUnderivedResolution.connectivityConstraints.length === 9
  && copiedSixtyResolution.solved.entities.length === 0);
const independentCanonicalText = JSON.stringify(runtimeTools.canonicalStudioV5Project(independentAssemblyProject));
const independentReopened = projectTools.parseStudioV5Project(independentCanonicalText) as JsonRecord;
check('Make independent remap did not survive canonical save/reopen byte-for-byte',
  JSON.stringify(independentReopened) === independentCanonicalText);
const reopenedIndependentPart = independentReopened.partDefinitions.find((entry: JsonRecord) =>
  entry.id === 'independent-remap-copy');
const reopenedIndependentParameters = modelingTools.studioV5ParameterValues(independentReopened, reopenedIndependentPart);
const reopenedCopiedBlockSketch = reopenedIndependentPart.sketches.find((entry: JsonRecord) =>
  entry.name === 'Nested block frame');
check('Make independent remapped relations did not resolve after canonical reopen',
  instanceTools.resolveStudioConstrainedSketch(reopenedIndependentPart, reopenedCopiedBlockSketch.id, {
    evaluate: (value: unknown) => modelingTools.evaluateStudioV5Expression(value, reopenedIndependentParameters),
  }).loops.length === 2);

let qualifiedCollisionProject = projectTools.createEmptyStudioV5PartProject({
  projectId: 'make-independent-qualified-id-collision',
  name: 'Qualified ID collision source',
  units: 'mm',
}) as JsonRecord;
qualifiedCollisionProject = apply(qualifiedCollisionProject, 'create-qualified-id-collision-source', [
  {
    kind: 'sketch.blockDefinition.create',
    input: {
      id: 'block-authored-qualified', name: 'Authored qualified member definition', insertionPoint: [0, 0],
      constrained: {
        entities: [
          { id: 'authored-a', kind: 'point', at: [0, 0], fixed: true },
          { id: 'authored-b', kind: 'point', at: [3, 0] },
          { id: 'bi:1:a:b', kind: 'line', a: 'authored-a', b: 'authored-b' },
        ],
        constraints: [{ id: 'authored-horizontal', kind: 'horizontal', line: 'bi:1:a:b' }],
        blockInstances: [], relations: [],
      },
    },
  },
  {
    kind: 'sketch.blockDefinition.create',
    input: {
      id: 'block-generated-qualified', name: 'Generated qualified member definition', insertionPoint: [0, 0],
      constrained: {
        entities: [
          { id: 'generated-a', kind: 'point', at: [0, 0], fixed: true },
          { id: 'generated-b', kind: 'point', at: [4, 0] },
          { id: 'b', kind: 'line', a: 'generated-a', b: 'generated-b' },
        ],
        constraints: [{ id: 'generated-horizontal', kind: 'horizontal', line: 'b' }],
        blockInstances: [], relations: [],
      },
    },
  },
  {
    kind: 'sketch.constrained.create',
    input: {
      id: 'sketch-generated-qualified', name: 'Generated qualified member sketch', plane: 'XY', z: 0,
      constrained: {
        entities: [], constraints: [],
        blockInstances: [{
          id: 'a', definitionId: 'block-generated-qualified',
          transform: { translation: [0, 0], angleDeg: 0, scale: 1 }, fixed: false,
        }],
        relations: [{
          id: 'generated-qualified-relation', kind: 'horizontal',
          line: { instanceId: 'a', memberId: 'b' },
        }],
      },
    },
  },
]);
qualifiedCollisionProject = apply(qualifiedCollisionProject, 'create-qualified-id-collision-assembly', [{
  kind: 'assembly.create',
  input: {
    id: 'assembly-qualified-id-collision', name: 'Qualified ID collision assembly',
    occurrenceId: 'occurrence-qualified-id-collision', occurrenceName: 'Collision source:1', fixed: true,
  },
}]);
const maximumIndependentPartId = 'p'.repeat(200);
qualifiedCollisionProject = apply(qualifiedCollisionProject, 'make-qualified-id-collision-independent', [{
  kind: 'component.makeIndependent',
  input: {
    occurrenceId: 'occurrence-qualified-id-collision', partId: maximumIndependentPartId,
    name: 'Qualified collision independent copy', occurrenceName: 'Collision independent:1',
  },
}]);
const qualifiedIndependentPart = qualifiedCollisionProject.partDefinitions.find((entry: JsonRecord) =>
  entry.id === maximumIndependentPartId);
const copiedAuthoredDefinition = qualifiedIndependentPart.sketchBlockDefinitions.find((entry: JsonRecord) =>
  entry.name === 'Authored qualified member definition');
const copiedGeneratedDefinition = qualifiedIndependentPart.sketchBlockDefinitions.find((entry: JsonRecord) =>
  entry.name === 'Generated qualified member definition');
const copiedQualifiedSketch = qualifiedIndependentPart.sketches.find((entry: JsonRecord) =>
  entry.name === 'Generated qualified member sketch');
const copiedAuthoredQualifiedLine = copiedAuthoredDefinition.constrained.entities.find((entry: JsonRecord) =>
  entry.kind === 'line');
const copiedGeneratedLine = copiedGeneratedDefinition.constrained.entities.find((entry: JsonRecord) =>
  entry.kind === 'line');
const copiedCollisionInstance = copiedQualifiedSketch.constrained.blockInstances[0];
const copiedCollisionRelation = copiedQualifiedSketch.constrained.relations[0];
const generatedQualifiedMemberId = instanceTools.studioSketchBlockMemberId(
  copiedCollisionInstance.id,
  copiedGeneratedLine.id,
);
check('200-character Make independent did not keep every stored collision participant within 60 characters',
  [
    copiedAuthoredQualifiedLine.id,
    copiedGeneratedLine.id,
    copiedCollisionInstance.id,
    copiedCollisionRelation.id,
  ].every((id: string) => typeof id === 'string' && id.length <= 60));
check('qualified-ID collision mapped the relation to the authored bi: lookalike instead of the generated member',
  copiedAuthoredQualifiedLine.id !== generatedQualifiedMemberId
  && copiedCollisionRelation.line.instanceId === copiedCollisionInstance.id
  && copiedCollisionRelation.line.memberId === copiedGeneratedLine.id);
const qualifiedIndependentParameters = modelingTools.studioV5ParameterValues(
  qualifiedCollisionProject,
  qualifiedIndependentPart,
);
const qualifiedCollisionResolution = instanceTools.resolveStudioConstrainedSketch(
  qualifiedIndependentPart,
  copiedQualifiedSketch.id,
  { evaluate: (value: unknown) => modelingTools.evaluateStudioV5Expression(value, qualifiedIndependentParameters) },
);
check('qualified-ID collision relation did not resolve to the generated qualified block member',
  qualifiedCollisionResolution.solved.entities.some((entry: JsonRecord) => entry.id === generatedQualifiedMemberId)
  && qualifiedCollisionResolution.flattened.constraints.some((entry: JsonRecord) =>
    entry.kind === 'horizontal' && entry.line === generatedQualifiedMemberId));
const qualifiedCollisionCanonicalText = JSON.stringify(runtimeTools.canonicalStudioV5Project(qualifiedCollisionProject));
check('qualified-ID collision Make independent did not survive canonical save/reopen',
  JSON.stringify(projectTools.parseStudioV5Project(qualifiedCollisionCanonicalText)) === qualifiedCollisionCanonicalText);

check('a typed mutation returned the same project/hash pair as its immediately preceding mutation',
  documentHashes.every((entry, index) => index === 0 || entry !== documentHashes[index - 1]));
console.log(JSON.stringify({
  schema: 'partmode.sketch-blocks-derived-smoke/v1',
  typedOperations: [
    'parameter.update',
    'sketch.constrained.create', 'sketch.constrained.update', 'sketch.constrained.delete',
    'sketch.blockDefinition.create', 'sketch.blockDefinition.update', 'sketch.blockDefinition.delete',
    'sketch.blockInstance.create', 'sketch.blockInstance.update', 'sketch.blockInstance.delete', 'sketch.blockInstance.explode',
    'sketch.relation.create', 'sketch.relation.update', 'sketch.relation.delete',
    'sketch.derived.create', 'sketch.derived.update', 'sketch.derived.underive',
    'feature.extrude', 'feature.cut', 'feature.revolve',
    'assembly.create', 'component.makeIndependent',
  ],
  rigidPose: {
    freeDof: freePose.dof,
    relatedDof: 0,
    externalRelations: ['coincident', 'horizontal'],
    endpointConnectivity: { resolved: 9, exploded: 9, underived: 9 },
    tinyArcBlocks: { scale: 1e-6, semicircleDof: freeSemicircle.dof, quarterArcDof: freeQuarterArc.dof },
  },
  definitionEdits: {
    bothLinked: { width: 12, height: 8 },
    afterExplode: { linked: [14, 9], exploded: [12, 8] },
    afterUnderive: { linked: [16, 10], underivedArea: 258 },
  },
  exact: {
    rebuilds: { main: exactRevision, auxiliaryPositive: 3, boundedNegative: 1, total: exactRevision + 4 },
    initial: { targetVolume: 900, derivedVolume: 540 },
    bothEdited: { targetVolume: 1440, derivedVolume: 864 },
    explodedLinked: { targetVolume: 1290, derivedVolume: 774 },
    underived: { targetVolume: 1120, derivedVolume: 774 },
    inheritedSupport: { plane: 'YZ', offset: 7, volume: 24 },
    linkedCut: { stockVolume: 2000, resultVolume: 1920, faces: 10, edges: 24, vertices: 16 },
    analyticArc: { quarterSectorVolume: 6.25 * Math.PI, faces: 5, edges: 9, vertices: 6 },
    boundedSemicircleRefusal: 'TOPOLOGY_NAMING_AMBIGUOUS_SUFFIX',
    topology: { faces: 10, edges: 24, vertices: 16, persistentNames: 'complete' },
    brepSha256: {
      target: underivedExact!.targetBrepHash,
      frozenDerived: underivedExact!.derivedBrepHash,
    },
    effectiveDocumentHash: underivedExact!.result.effectiveDocumentHash,
  },
  persistence: {
    part: 'canonical-save-reopen',
    makeIndependent: {
      reusableSketchIdLength: copiedSixtySketch.id.length,
      explodedMemberNamespace: 'bi:',
      underivedMemberNamespace: 'ds:',
      adversarialPartIdLength: maximumIndependentPartId.length,
      qualifiedCollisionResolved: generatedQualifiedMemberId,
    },
  },
  refusals: [
    'unused-invalid-definition',
    'definition-delete-in-use', 'source-delete-in-use', 'instance-delete-in-use',
    'empty-patch', 'unknown-patch', 'unknown-top-level-input', 'unknown-nested-input',
    'definition-replacement', 'derived-source-relink', 'derived-chain',
    'generic-derived-create-bypass', 'generic-derived-update-bypass',
    'dangling-relation', 'missing-relation-operands', 'wrong-relation-member-kind',
    'whitespace-relation-id', 'whitespace-transaction-alias',
    'inline-ghost-blockInstances', 'inline-ghost-relations', 'inline-ghost-derivedFrom',
    'overlong-sketch-id', 'overlong-instance-id',
    'zero-scale', 'negative-scale', 'nonpositive-scale-parameter',
    'open-profile-solid', 'spline-profile-solid', 'linked-on-face', 'linked-revolve',
    'mirror-chirality', 'resolved-entity-budget', 'dense-solver-work-budget',
    'derived-direct-membership-edit', 'semicircle-topology-naming-ambiguity',
  ],
}, null, 2));

process.exit(0);
