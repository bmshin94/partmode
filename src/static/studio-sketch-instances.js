import {
  constraintSketchToLoops,
  solveSketch,
  validateConstraintSketch,
} from './studio-sketch-solver.js';

export const STUDIO_SKETCH_INSTANCES_SCHEMA = 'partmode.sketch-instances/v1';
export const STUDIO_CONSTRAINED_2D_ROLE = 'constrained-2d';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ENTITY_REFERENCE_FIELDS = new Set(['a', 'b', 'line', 'circle', 'point', 'axis']);
const RELATION_FIELDS = new Set(['id', 'kind', ...ENTITY_REFERENCE_FIELDS, 'value', 'driving']);
const CONSTRAINED_ENTITY_FIELDS = Object.freeze({
  point: ['id', 'kind', 'at', 'fixed'],
  line: ['id', 'kind', 'a', 'b', 'construction'],
  circle: ['id', 'kind', 'center', 'r', 'construction'],
  arc: ['id', 'kind', 'center', 'a', 'b', 'ccw', 'construction'],
  spline: ['id', 'kind', 'through', 'construction'],
});
const CONSTRAINED_CONSTRAINT_FIELDS = Object.freeze([
  'id', 'kind', 'a', 'b', 'line', 'circle', 'point', 'axis',
  'curveSketchId', 'planeDatumId', 'value', 'driving',
]);
const CONSTRAINED_SOURCE_FIELDS = Object.freeze([
  'entities', 'constraints', 'blockInstances', 'relations', 'derivedFrom',
]);
const RELATION_KINDS = new Set([
  'coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'tangent', 'equal',
  'concentric', 'midpoint', 'pointOnLine', 'pointOnCircle', 'symmetric', 'distance',
  'horizontalDistance', 'verticalDistance', 'length', 'radius', 'angle',
]);
const DIMENSIONAL_RELATION_KINDS = new Set([
  'distance', 'horizontalDistance', 'verticalDistance', 'length', 'radius', 'angle',
]);
const RELATION_OPERAND_VARIANTS = Object.freeze({
  coincident: [['a', 'b']],
  horizontal: [['line'], ['a', 'b']],
  vertical: [['line'], ['a', 'b']],
  parallel: [['a', 'b']],
  perpendicular: [['a', 'b']],
  tangent: [['a', 'b']],
  equal: [['a', 'b']],
  concentric: [['a', 'b']],
  midpoint: [['point', 'line']],
  pointOnLine: [['point', 'line']],
  pointOnCircle: [['point', 'circle']],
  symmetric: [['a', 'b', 'axis']],
  distance: [['a', 'b']],
  horizontalDistance: [['a', 'b']],
  verticalDistance: [['a', 'b']],
  length: [['line']],
  radius: [['circle']],
  angle: [['a', 'b']],
});
const POINT_RELATION_MEMBER_KINDS = new Set(['point']);
const LINE_RELATION_MEMBER_KINDS = new Set(['line']);
const ROUND_RELATION_MEMBER_KINDS = new Set(['circle', 'arc']);
const TANGENT_RELATION_MEMBER_KINDS = new Set(['line', 'circle', 'arc']);
const EQUAL_RELATION_MEMBER_KINDS = new Set(['line', 'circle', 'arc']);
const RELATION_REFERENCE_KINDS = Object.freeze({
  coincident: { a: POINT_RELATION_MEMBER_KINDS, b: POINT_RELATION_MEMBER_KINDS },
  horizontal: { line: LINE_RELATION_MEMBER_KINDS, a: POINT_RELATION_MEMBER_KINDS, b: POINT_RELATION_MEMBER_KINDS },
  vertical: { line: LINE_RELATION_MEMBER_KINDS, a: POINT_RELATION_MEMBER_KINDS, b: POINT_RELATION_MEMBER_KINDS },
  parallel: { a: LINE_RELATION_MEMBER_KINDS, b: LINE_RELATION_MEMBER_KINDS },
  perpendicular: { a: LINE_RELATION_MEMBER_KINDS, b: LINE_RELATION_MEMBER_KINDS },
  tangent: { a: TANGENT_RELATION_MEMBER_KINDS, b: ROUND_RELATION_MEMBER_KINDS },
  equal: { a: EQUAL_RELATION_MEMBER_KINDS, b: EQUAL_RELATION_MEMBER_KINDS },
  concentric: { a: ROUND_RELATION_MEMBER_KINDS, b: ROUND_RELATION_MEMBER_KINDS },
  midpoint: { point: POINT_RELATION_MEMBER_KINDS, line: LINE_RELATION_MEMBER_KINDS },
  pointOnLine: { point: POINT_RELATION_MEMBER_KINDS, line: LINE_RELATION_MEMBER_KINDS },
  pointOnCircle: { point: POINT_RELATION_MEMBER_KINDS, circle: ROUND_RELATION_MEMBER_KINDS },
  symmetric: { a: POINT_RELATION_MEMBER_KINDS, b: POINT_RELATION_MEMBER_KINDS, axis: LINE_RELATION_MEMBER_KINDS },
  distance: { a: POINT_RELATION_MEMBER_KINDS, b: POINT_RELATION_MEMBER_KINDS },
  horizontalDistance: { a: POINT_RELATION_MEMBER_KINDS, b: POINT_RELATION_MEMBER_KINDS },
  verticalDistance: { a: POINT_RELATION_MEMBER_KINDS, b: POINT_RELATION_MEMBER_KINDS },
  length: { line: LINE_RELATION_MEMBER_KINDS },
  radius: { circle: ROUND_RELATION_MEMBER_KINDS },
  angle: { a: LINE_RELATION_MEMBER_KINDS, b: LINE_RELATION_MEMBER_KINDS },
});
const MAX_RESOLVED_SKETCH_ENTITIES = 25_000;
const MAX_RESOLVED_SKETCH_CONSTRAINTS = 100_000;
const MAX_SKETCH_SOLVER_DENSE_WORK_CELLS = 16_000_000;
const MAX_AUTHORED_REUSABLE_ID_LENGTH = 60;
const clone = (value) => structuredClone(value);

export class StudioSketchInstanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioSketchInstanceError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new StudioSketchInstanceError(code, message, details);
}

function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('SKETCH_INSTANCE_INVALID', path + ' must be an object.');
  }
  return value;
}

function rejectUnknownFields(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('SKETCH_INSTANCE_INVALID', path + ' contains unsupported field "' + key + '".');
  }
}

function array(value, path, maximum = 25_000) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail('SKETCH_INSTANCE_INVALID', path + ' must be an array with at most ' + maximum + ' entries.');
  }
  return value;
}

function id(value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('SKETCH_INSTANCE_INVALID', path + ' must be a stable ID.');
  }
  return value;
}

function reusableAuthoredId(value, path, { allowMaterialized = false } = {}) {
  id(value, path);
  const materialized = allowMaterialized && (value.startsWith('bi:') || value.startsWith('ds:'));
  if (!materialized && value.length > MAX_AUTHORED_REUSABLE_ID_LENGTH) {
    fail(
      'SKETCH_INSTANCE_ID_BUDGET',
      path + ' must be at most ' + MAX_AUTHORED_REUSABLE_ID_LENGTH
        + ' characters so collision-free qualified solver IDs remain bounded.',
    );
  }
  return value;
}

function text(value, path) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
    fail('SKETCH_INSTANCE_INVALID', path + ' must contain 1 to 200 characters.');
  }
  return value.trim();
}

function expression(value, path) {
  if ((typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.trim() && value.length <= 500)) return value;
  fail('SKETCH_INSTANCE_INVALID', path + ' must be a finite number or bounded expression.');
}

function point(value, path, { expressionValues = false } = {}) {
  if (!Array.isArray(value) || value.length !== 2) {
    fail('SKETCH_INSTANCE_INVALID', path + ' must contain exactly two coordinates.');
  }
  value.forEach((entry, index) => {
    if (expressionValues) expression(entry, path + '[' + index + ']');
    else if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      fail('SKETCH_INSTANCE_INVALID', path + '[' + index + '] must be finite.');
    }
  });
  return value;
}

function definitionGraph(part) {
  if (part.sketchBlockDefinitions === undefined) return [];
  return array(part.sketchBlockDefinitions, 'part.sketchBlockDefinitions', 1_000);
}

function constrainedSource(sketch, path) {
  const source = record(sketch.constrained, path + '.constrained');
  rejectUnknownFields(source, CONSTRAINED_SOURCE_FIELDS, path + '.constrained');
  array(source.entities, path + '.constrained.entities');
  array(source.constraints === undefined ? [] : source.constraints, path + '.constrained.constraints');
  array(source.blockInstances === undefined ? [] : source.blockInstances, path + '.constrained.blockInstances', 1_000);
  array(source.relations === undefined ? [] : source.relations, path + '.constrained.relations', 10_000);
  return source;
}

// Member editors own only the authored entity and constraint arrays. Replacing
// those arrays must not flatten first-class reuse state (instances, placement
// relations, or a derived link), and neither the source nor the replacement may
// retain shared mutable references after a transactional edit.
export function replaceStudioSketchMembers(source, replacement) {
  const current = record(source, 'constrained source');
  rejectUnknownFields(current, CONSTRAINED_SOURCE_FIELDS, 'constrained source');
  const members = record(replacement, 'constrained member replacement');
  rejectUnknownFields(members, ['entities', 'constraints'], 'constrained member replacement');
  array(members.entities, 'constrained member replacement.entities');
  array(members.constraints, 'constrained member replacement.constraints');
  const result = clone(current);
  result.entities = clone(members.entities);
  result.constraints = clone(members.constraints);
  return result;
}

function transformRecord(value, path, { allowScale = true } = {}) {
  const transform = record(value, path);
  rejectUnknownFields(transform, allowScale ? ['translation', 'angleDeg', 'scale'] : ['translation', 'angleDeg'], path);
  point(transform.translation, path + '.translation', { expressionValues: true });
  expression(transform.angleDeg, path + '.angleDeg');
  if (allowScale) expression(transform.scale, path + '.scale');
  else if (transform.scale !== undefined) fail('SKETCH_INSTANCE_INVALID', path + '.scale is not valid for a derived sketch.');
  return transform;
}

function validateConstraintSource(source, path) {
  for (const [index, entity] of source.entities.entries()) {
    const entityPath = path + '.entities[' + index + ']';
    record(entity, entityPath);
    const fields = CONSTRAINED_ENTITY_FIELDS[entity.kind];
    if (fields) rejectUnknownFields(entity, fields, entityPath);
    if (entity.fixed !== undefined && typeof entity.fixed !== 'boolean') {
      fail('SKETCH_INSTANCE_INVALID', entityPath + '.fixed must be true or false.');
    }
    if (entity.construction !== undefined && typeof entity.construction !== 'boolean') {
      fail('SKETCH_INSTANCE_INVALID', entityPath + '.construction must be true or false.');
    }
    if (entity.ccw !== undefined && typeof entity.ccw !== 'boolean') {
      fail('SKETCH_INSTANCE_INVALID', entityPath + '.ccw must be true or false.');
    }
    if (entity.kind === 'circle') expression(entity.r, entityPath + '.r');
  }
  for (const [index, constraint] of (source.constraints || []).entries()) {
    record(constraint, path + '.constraints[' + index + ']');
    rejectUnknownFields(constraint, CONSTRAINED_CONSTRAINT_FIELDS, path + '.constraints[' + index + ']');
  }
  const unsupportedPierce = (source.constraints || []).find((constraint) => constraint?.kind === 'pierce');
  if (unsupportedPierce) {
    fail(
      'SKETCH_INSTANCE_PIERCE_UNSUPPORTED',
      path + ' cannot contain pierce until first-class sketches have a document-aware curve resolver.',
    );
  }
  const diagnostics = validateConstraintSketch({
    entities: source.entities,
    constraints: source.constraints || [],
  });
  if (diagnostics.length) {
    fail('SKETCH_INSTANCE_CONSTRAINTS_INVALID', path + ' is invalid: ' + diagnostics[0].message, {
      diagnostics,
    });
  }
}

function validateRelationReference(value, path) {
  if (typeof value === 'string') return id(value, path);
  const reference = record(value, path);
  for (const key of Object.keys(reference)) {
    if (!['entityId', 'instanceId', 'memberId', 'derivedMemberId'].includes(key)) {
      fail('SKETCH_INSTANCE_INVALID', path + ' contains unsupported field "' + key + '".');
    }
  }
  const variants = Number(typeof reference.entityId === 'string')
    + Number(typeof reference.instanceId === 'string' || typeof reference.memberId === 'string')
    + Number(typeof reference.derivedMemberId === 'string');
  if (variants !== 1) {
    fail('SKETCH_INSTANCE_INVALID', path + ' must identify one local entity, block member, or derived member.');
  }
  if (reference.entityId !== undefined) id(reference.entityId, path + '.entityId');
  if (reference.instanceId !== undefined || reference.memberId !== undefined) {
    id(reference.instanceId, path + '.instanceId');
    id(reference.memberId, path + '.memberId');
  }
  if (reference.derivedMemberId !== undefined) id(reference.derivedMemberId, path + '.derivedMemberId');
  return reference;
}

function validateRelation(relation, path) {
  record(relation, path);
  for (const key of Object.keys(relation)) {
    if (!RELATION_FIELDS.has(key)) {
      fail('SKETCH_INSTANCE_INVALID', path + ' contains unsupported field "' + key + '".');
    }
  }
  if (relation.id === undefined) fail('SKETCH_INSTANCE_INVALID', path + '.id is required for relation CRUD.');
  id(relation.id, path + '.id');
  if (!RELATION_KINDS.has(relation.kind)) {
    fail('SKETCH_INSTANCE_INVALID', path + '.kind is unsupported for first-class sketch relations.');
  }
  const presentOperands = [...ENTITY_REFERENCE_FIELDS].filter((field) => relation[field] !== undefined);
  const operandVariants = RELATION_OPERAND_VARIANTS[relation.kind] || [];
  const validOperandShape = operandVariants.some((variant) =>
    variant.length === presentOperands.length && variant.every((field) => presentOperands.includes(field)));
  if (!validOperandShape) {
    fail(
      'SKETCH_INSTANCE_INVALID',
      path + ' must contain exactly one supported operand shape for ' + relation.kind + ': '
        + operandVariants.map((variant) => variant.join(' + ')).join(' or ') + '.',
    );
  }
  for (const field of ENTITY_REFERENCE_FIELDS) {
    if (relation[field] !== undefined) validateRelationReference(relation[field], path + '.' + field);
  }
  if (relation.driving !== undefined && typeof relation.driving !== 'boolean') {
    fail('SKETCH_INSTANCE_INVALID', path + '.driving must be true or false.');
  }
  const dimensional = DIMENSIONAL_RELATION_KINDS.has(relation.kind);
  if (!dimensional && relation.driving === false) {
    fail('SKETCH_INSTANCE_INVALID', path + '.driving=false is valid only for dimensional relations.');
  }
  if (!dimensional && relation.value !== undefined) {
    fail('SKETCH_INSTANCE_INVALID', path + '.value is valid only for dimensional relations.');
  }
  if (dimensional && relation.driving === false) {
    if (relation.value !== undefined) {
      fail('SKETCH_INSTANCE_INVALID', path + ' is a reference dimension and must not store a driving value.');
    }
  } else if (dimensional) {
    if (relation.value === undefined) {
      fail('SKETCH_INSTANCE_INVALID', path + '.value is required for a driving dimensional relation.');
    }
    expression(relation.value, path + '.value');
  }
}

export function assertStudioSketchInstancesPart(part) {
  record(part, 'part');
  const blocks = definitionGraph(part);
  const blocksById = new Map();
  const blockIds = new Set();
  for (const [index, block] of blocks.entries()) {
    const path = 'part.sketchBlockDefinitions[' + index + ']';
    record(block, path);
    rejectUnknownFields(block, ['id', 'name', 'insertionPoint', 'constrained'], path);
    const blockId = id(block.id, path + '.id');
    if (blockIds.has(blockId)) fail('DUPLICATE_SKETCH_BLOCK', path + ' repeats block definition "' + blockId + '".');
    blockIds.add(blockId);
    blocksById.set(blockId, block);
    text(block.name, path + '.name');
    point(block.insertionPoint, path + '.insertionPoint');
    const source = constrainedSource(block, path);
    if (!source.entities.length) fail('SKETCH_BLOCK_EMPTY', path + ' must contain geometry.');
    if (source.blockInstances?.length || source.relations?.length || source.derivedFrom !== undefined) {
      fail('SKETCH_BLOCK_NESTING_UNSUPPORTED', path + ' cannot contain nested blocks or a derived source.');
    }
    for (const [entityIndex, entity] of source.entities.entries()) {
      reusableAuthoredId(entity.id, path + '.constrained.entities[' + entityIndex + '].id');
    }
    validateConstraintSource(source, path + '.constrained');
  }

  const sketches = new Map();
  const allInstanceIds = new Set();
  for (const [index, sketch] of (part.sketches || []).entries()) {
    if (sketch.extensions?.studioRole !== STUDIO_CONSTRAINED_2D_ROLE) continue;
    const path = 'part.sketches[' + index + ']';
    reusableAuthoredId(sketch.id, path + '.id');
    if (sketches.has(sketch.id)) fail('DUPLICATE_SKETCH', path + ' repeats constrained sketch "' + sketch.id + '".');
    sketches.set(sketch.id, sketch);
    if (sketch.extensions?.sketchInstancesSchema !== STUDIO_SKETCH_INSTANCES_SCHEMA) {
      fail('SKETCH_INSTANCE_SCHEMA_INVALID', path + ' must declare ' + STUDIO_SKETCH_INSTANCES_SCHEMA + '.');
    }
    const plane = sketch.plane === undefined ? 'XY' : sketch.plane;
    if (!['XY', 'YZ', 'ZX'].includes(plane)) fail('SKETCH_SUPPORT_INVALID', path + '.plane must be XY, YZ, or ZX.');
    expression(sketch.z === undefined ? 0 : sketch.z, path + '.z');
    const source = constrainedSource(sketch, path);
    const localIds = new Set();
    for (const [entityIndex, entity] of source.entities.entries()) {
      const entityId = reusableAuthoredId(
        entity.id,
        path + '.constrained.entities[' + entityIndex + '].id',
        { allowMaterialized: true },
      );
      if (localIds.has(entityId)) fail('DUPLICATE_SKETCH_ENTITY', path + ' repeats entity "' + entityId + '".');
      localIds.add(entityId);
    }
    if (!source.derivedFrom) validateConstraintSource(source, path + '.constrained');
    const instanceIds = new Set();
    for (const [instanceIndex, instance] of (source.blockInstances || []).entries()) {
      const instancePath = path + '.constrained.blockInstances[' + instanceIndex + ']';
      record(instance, instancePath);
      rejectUnknownFields(instance, ['id', 'definitionId', 'transform', 'fixed'], instancePath);
      const instanceId = reusableAuthoredId(instance.id, instancePath + '.id');
      if (instanceIds.has(instanceId)) fail('DUPLICATE_SKETCH_BLOCK_INSTANCE', instancePath + ' repeats instance "' + instanceId + '".');
      if (allInstanceIds.has(instanceId)) fail('DUPLICATE_SKETCH_BLOCK_INSTANCE', instancePath + ' reuses project instance ID "' + instanceId + '".');
      instanceIds.add(instanceId);
      allInstanceIds.add(instanceId);
      const definitionId = id(instance.definitionId, instancePath + '.definitionId');
      if (!blockIds.has(definitionId)) fail('MISSING_SKETCH_BLOCK', instancePath + ' references missing definition "' + definitionId + '".');
      transformRecord(instance.transform, instancePath + '.transform');
      if (instance.fixed !== undefined && typeof instance.fixed !== 'boolean') {
        fail('SKETCH_INSTANCE_INVALID', instancePath + '.fixed must be true or false.');
      }
    }
    const relationIds = new Set();
    for (const [relationIndex, relation] of (source.relations || []).entries()) {
      validateRelation(relation, path + '.constrained.relations[' + relationIndex + ']');
      if (relation.id !== undefined) {
        if (relationIds.has(relation.id)) {
          fail('DUPLICATE_SKETCH_RELATION', path + ' repeats relation "' + relation.id + '".');
        }
        relationIds.add(relation.id);
      }
    }
    if (source.derivedFrom !== undefined) {
      if (source.entities.length || (source.constraints || []).length || (source.blockInstances || []).length) {
        fail('DERIVED_SKETCH_READ_ONLY', path + ' cannot store editable members while it remains derived.');
      }
      const derived = record(source.derivedFrom, path + '.constrained.derivedFrom');
      rejectUnknownFields(derived, ['sourceSketchId', 'transform'], path + '.constrained.derivedFrom');
      id(derived.sourceSketchId, path + '.constrained.derivedFrom.sourceSketchId');
      transformRecord(derived.transform, path + '.constrained.derivedFrom.transform', { allowScale: false });
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(sketchId, chain) {
    if (visiting.has(sketchId)) {
      fail('CYCLIC_DERIVED_SKETCH', 'Derived sketch cycle: ' + [...chain, sketchId].join(' -> ') + '.');
    }
    if (visited.has(sketchId)) return;
    visiting.add(sketchId);
    const sourceId = sketches.get(sketchId)?.constrained?.derivedFrom?.sourceSketchId;
    if (sourceId !== undefined) {
      if (sourceId === sketchId) fail('CYCLIC_DERIVED_SKETCH', 'Sketch "' + sketchId + '" cannot derive from itself.');
      if (!sketches.has(sourceId)) fail('MISSING_DERIVED_SKETCH_SOURCE', 'Derived sketch "' + sketchId + '" references missing constrained sketch "' + sourceId + '".');
      if (sketches.get(sourceId)?.constrained?.derivedFrom) {
        fail('DERIVED_SKETCH_CHAIN_UNSUPPORTED', 'Derived sketch "' + sketchId + '" cannot derive from another linked derived sketch; Underive the source first.');
      }
      visit(sourceId, [...chain, sketchId]);
    }
    visiting.delete(sketchId);
    visited.add(sketchId);
  }
  for (const sketchId of sketches.keys()) visit(sketchId, []);

  const structuralMemberMemo = new Map();
  const structuralMembers = (sketchId) => {
    if (structuralMemberMemo.has(sketchId)) return structuralMemberMemo.get(sketchId);
    const sketch = sketches.get(sketchId);
    const source = sketch.constrained;
    let members;
    if (source.derivedFrom) {
      members = new Map([...structuralMembers(source.derivedFrom.sourceSketchId)].map(([memberId, kind]) =>
        [studioDerivedSketchMemberId(sketch.id, memberId), kind]));
    } else {
      members = new Map(source.entities.map((entity) => [entity.id, entity.kind]));
      for (const instance of source.blockInstances || []) {
        const definition = blocksById.get(instance.definitionId);
        for (const entity of definition.constrained.entities) {
          members.set(studioSketchBlockMemberId(instance.id, entity.id), entity.kind);
        }
      }
    }
    structuralMemberMemo.set(sketchId, members);
    return members;
  };
  for (const [sketchId, sketch] of sketches) {
    const source = sketch.constrained;
    const currentMembers = structuralMembers(sketchId);
    const instances = new Map((source.blockInstances || []).map((instance) => [instance.id, instance]));
    const upstreamMembers = source.derivedFrom
      ? structuralMembers(source.derivedFrom.sourceSketchId)
      : null;
    const requireResolvedReference = (reference, path) => {
      if (typeof reference === 'string' || reference.entityId !== undefined) {
        const memberId = typeof reference === 'string' ? reference : reference.entityId;
        if (!currentMembers.has(memberId)) {
          fail('MISSING_SKETCH_RELATION_MEMBER', path + ' references missing resolved member "' + memberId + '".');
        }
        return currentMembers.get(memberId);
      }
      if (reference.instanceId !== undefined) {
        const instance = instances.get(reference.instanceId);
        const definition = instance ? blocksById.get(instance.definitionId) : null;
        const member = definition?.constrained.entities.find((entity) => entity.id === reference.memberId);
        if (!instance || !member) {
          fail('MISSING_SKETCH_RELATION_MEMBER', path + ' references a missing block instance member.');
        }
        return member.kind;
      }
      if (!upstreamMembers?.has(reference.derivedMemberId)) {
        fail('MISSING_SKETCH_RELATION_MEMBER', path + ' references a missing derived source member.');
      }
      return upstreamMembers.get(reference.derivedMemberId);
    };
    for (const [relationIndex, relation] of (source.relations || []).entries()) {
      const memberKinds = new Map();
      for (const field of ENTITY_REFERENCE_FIELDS) {
        if (relation[field] !== undefined) {
          memberKinds.set(field, requireResolvedReference(
            relation[field],
            'sketch "' + sketchId + '" relation[' + relationIndex + '].' + field,
          ));
        }
      }
      const expectedKinds = RELATION_REFERENCE_KINDS[relation.kind] || {};
      for (const [field, kind] of memberKinds) {
        if (!expectedKinds[field]?.has(kind)) {
          fail(
            'SKETCH_RELATION_MEMBER_KIND_INVALID',
            'sketch "' + sketchId + '" relation[' + relationIndex + '].' + field
              + ' references a ' + kind + '; expected ' + [...(expectedKinds[field] || [])].join('|') + '.',
          );
        }
      }
      if (relation.kind === 'equal') {
        const aRound = ROUND_RELATION_MEMBER_KINDS.has(memberKinds.get('a'));
        const bRound = ROUND_RELATION_MEMBER_KINDS.has(memberKinds.get('b'));
        if (aRound !== bRound) {
          fail(
            'SKETCH_RELATION_MEMBER_KIND_INVALID',
            'sketch "' + sketchId + '" relation[' + relationIndex + '] cannot equate a line length with a radius.',
          );
        }
      }
    }
  }
  return { blocks: blocks.length, sketches: sketches.size };
}

function evaluated(value, evaluate, path) {
  let result;
  try { result = evaluate(value); }
  catch (error) {
    fail('SKETCH_INSTANCE_EXPRESSION_INVALID', path + ' could not be evaluated: ' + String(error?.message || error));
  }
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    fail('SKETCH_INSTANCE_EXPRESSION_INVALID', path + ' did not evaluate to a finite number.');
  }
  return result;
}

function evaluatedTransform(source, evaluate, path, { allowScale = true } = {}) {
  const translation = source.translation.map((value, index) => evaluated(value, evaluate, path + '.translation[' + index + ']'));
  const angleDeg = evaluated(source.angleDeg, evaluate, path + '.angleDeg');
  const scale = allowScale ? evaluated(source.scale, evaluate, path + '.scale') : 1;
  if (!(scale > 0)) fail('SKETCH_INSTANCE_SCALE_INVALID', path + '.scale must evaluate above zero; reflections are not accepted.');
  const radians = angleDeg * Math.PI / 180;
  return { translation, angleDeg, radians, scale };
}

function qualifiedOwnerPrefix(prefix, ownerId) {
  return prefix + ':' + ownerId.length + ':' + ownerId + ':';
}

function qualify(prefix, first, second) {
  // IDs may themselves contain colons. The owner-length field makes the pair
  // unambiguous: (owner="a", member="b:c") cannot collide with
  // (owner="a:b", member="c").
  const value = qualifiedOwnerPrefix(prefix, first) + second;
  if (!ID_PATTERN.test(value)) {
    fail('SKETCH_INSTANCE_ID_OVERFLOW', 'Qualified sketch member ID exceeds the stable-ID contract.', {
      prefix, first, second,
    });
  }
  return value;
}

export function studioSketchBlockMemberId(instanceId, memberId) {
  return qualify('bi', instanceId, memberId);
}

export function studioSketchBlockMemberPrefix(instanceId) {
  return qualifiedOwnerPrefix('bi', instanceId);
}

export function studioDerivedSketchMemberId(sketchId, memberId) {
  return qualify('ds', sketchId, memberId);
}

function transformPoint(value, origin, transform) {
  const x = (value[0] - origin[0]) * transform.scale;
  const y = (value[1] - origin[1]) * transform.scale;
  const cosine = Math.cos(transform.radians);
  const sine = Math.sin(transform.radians);
  return [
    transform.translation[0] + x * cosine - y * sine,
    transform.translation[1] + x * sine + y * cosine,
  ];
}

function solvedEntityGeometry(entity) {
  if (entity.kind === 'circle') return { ...entity, r: entity.solvedR ?? entity.r };
  return entity;
}

function transformEntities(entities, { prefix, ownerId, origin, transform, fixed }) {
  const idMap = new Map(entities.map((entity) => [entity.id, qualify(prefix, ownerId, entity.id)]));
  const output = entities.map((source) => {
    const entity = solvedEntityGeometry(source);
    if (entity.kind === 'point') {
      return {
        id: idMap.get(entity.id),
        kind: 'point',
        at: transformPoint(entity.at, origin, transform),
        ...(fixed ? { fixed: true } : {}),
      };
    }
    if (entity.kind === 'line') {
      return { id: idMap.get(entity.id), kind: 'line', a: idMap.get(entity.a), b: idMap.get(entity.b), ...(entity.construction ? { construction: true } : {}) };
    }
    if (entity.kind === 'circle') {
      return { id: idMap.get(entity.id), kind: 'circle', center: idMap.get(entity.center), r: Number(entity.r) * transform.scale, ...(entity.construction ? { construction: true } : {}) };
    }
    if (entity.kind === 'arc') {
      return {
        id: idMap.get(entity.id), kind: 'arc', center: idMap.get(entity.center), a: idMap.get(entity.a), b: idMap.get(entity.b),
        ...(entity.ccw === false ? { ccw: false } : {}), ...(entity.construction ? { construction: true } : {}),
      };
    }
    if (entity.kind === 'spline') {
      return { id: idMap.get(entity.id), kind: 'spline', through: entity.through.map((pointId) => idMap.get(pointId)), ...(entity.construction ? { construction: true } : {}) };
    }
    fail('SKETCH_INSTANCE_ENTITY_UNSUPPORTED', 'Sketch instance member "' + entity.id + '" has unsupported kind "' + entity.kind + '".');
  });
  return { entities: output, idMap };
}

function distanceBetween(left, right) {
  return Math.hypot(left.at[0] - right.at[0], left.at[1] - right.at[1]);
}

function nonCollinear(left, middle, right) {
  const first = [middle.at[0] - left.at[0], middle.at[1] - left.at[1]];
  const second = [right.at[0] - left.at[0], right.at[1] - left.at[1]];
  const magnitude = Math.hypot(first[0], first[1]) * Math.hypot(second[0], second[1]);
  if (!(magnitude > 0)) return false;
  const normalizedArea = Math.abs(first[0] * second[1] - first[1] * second[0]) / magnitude;
  return normalizedArea > 1e-8;
}

function coincidentPointRepresentatives(points, constraints) {
  const byId = new Map(points.map((point) => [point.id, point]));
  const parent = new Map(points.map((point) => [point.id, point.id]));
  const size = new Map(points.map((point) => [point.id, 1]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    let cursor = id;
    while (cursor !== root) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  for (const constraint of constraints) {
    if (constraint.kind !== 'coincident' || !byId.has(constraint.a) || !byId.has(constraint.b)) continue;
    let left = find(constraint.a);
    let right = find(constraint.b);
    if (left === right) continue;
    if (size.get(left) < size.get(right)) [left, right] = [right, left];
    parent.set(right, left);
    size.set(left, size.get(left) + size.get(right));
  }
  const clusters = new Map();
  for (const point of points) {
    const root = find(point.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(point);
  }
  return [...clusters.values()]
    .map((cluster) => cluster.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)[0])
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

// A block is a rigid solver participant, not a cache of fixed member points.
// Minimal distance relations leave its translation and rotation free while
// preserving the definition's exact shape. One distance defines a stable
// reference axis; each remaining point is located by one distance and one
// signed angle to that axis. This is the minimal 2n-3 equation count for a
// planar rigid participant, while the signed angles prevent the reflected
// branches that distance-only trilateration permits. Coincident topology is
// collapsed first because the solver also treats each coincidence cluster as
// one point variable. Construction rays are solver-only and never become
// public or exact topology.
function rigidRelations(entities, ownerId, prefix, connectivityConstraints) {
  const points = coincidentPointRepresentatives(
    entities.filter((entity) => entity.kind === 'point'),
    connectivityConstraints,
  );
  const circles = entities.filter((entity) => entity.kind === 'circle');
  const constraints = [];
  const chiralityWitnesses = [];
  const helpers = [];
  const addDistance = (left, right, sequence) => constraints.push({
    id: qualify(prefix + 'r', ownerId, String(sequence)),
    kind: 'distance', a: left.id, b: right.id, value: distanceBetween(left, right),
  });
  if (points.length === 2) addDistance(points[0], points[1], 1);
  else if (points.length >= 3) {
    const first = points[0];
    let second = points[1];
    let secondDistance = distanceBetween(first, second);
    for (let index = 2; index < points.length; index++) {
      const candidateDistance = distanceBetween(first, points[index]);
      if (candidateDistance > secondDistance) {
        second = points[index];
        secondDistance = candidateDistance;
      }
    }
    if (secondDistance <= Number.EPSILON) {
      fail('SKETCH_BLOCK_RIGIDITY_AMBIGUOUS', 'A block with three or more points cannot collapse every point to one location.');
    }
    const frameX = second.at[0] - first.at[0];
    const frameY = second.at[1] - first.at[1];
    let sequence = 0;
    addDistance(first, second, ++sequence);
    const forwardAxis = {
      id: qualify(prefix + 'h', ownerId, 'rigid-axis-forward'),
      kind: 'line', a: first.id, b: second.id, construction: true,
    };
    const reverseAxis = {
      id: qualify(prefix + 'h', ownerId, 'rigid-axis-reverse'),
      kind: 'line', a: second.id, b: first.id, construction: true,
    };
    helpers.push(forwardAxis, reverseAxis);
    const frameIds = new Set([first.id, second.id]);
    for (const candidate of points) {
      if (frameIds.has(candidate.id)) continue;
      const firstDistance = distanceBetween(first, candidate);
      const secondCandidateDistance = distanceBetween(second, candidate);
      const anchor = firstDistance >= secondCandidateDistance ? first : second;
      const other = anchor === first ? second : first;
      const axis = anchor === first ? forwardAxis : reverseAxis;
      const ray = {
        id: qualify(prefix + 'h', ownerId, 'rigid-ray-' + sequence),
        kind: 'line', a: anchor.id, b: candidate.id, construction: true,
      };
      helpers.push(ray);
      addDistance(anchor, candidate, ++sequence);
      const axisX = other.at[0] - anchor.at[0];
      const axisY = other.at[1] - anchor.at[1];
      const rayX = candidate.at[0] - anchor.at[0];
      const rayY = candidate.at[1] - anchor.at[1];
      const angleDeg = Math.atan2(axisX * rayY - axisY * rayX, axisX * rayX + axisY * rayY) * 180 / Math.PI;
      constraints.push({
        id: qualify(prefix + 'r', ownerId, String(++sequence)),
        kind: 'angle', a: axis.id, b: ray.id, value: angleDeg,
      });
      if (nonCollinear(first, second, candidate)) {
        chiralityWitnesses.push({
          kind: 'chirality', ownerId, points: [first.id, second.id, candidate.id],
          sign: Math.sign(frameX * (candidate.at[1] - first.at[1]) - frameY * (candidate.at[0] - first.at[0])),
        });
      } else {
        chiralityWitnesses.push({
          kind: 'projection', ownerId, points: [first.id, second.id, candidate.id],
          projection: (
            (candidate.at[0] - first.at[0]) * frameX
              + (candidate.at[1] - first.at[1]) * frameY
          ) / (secondDistance * secondDistance),
        });
      }
    }
  }
  let circleSequence = constraints.length;
  for (const circle of circles) constraints.push({
    id: qualify(prefix + 'r', ownerId, String(++circleSequence)),
    kind: 'radius', circle: circle.id, value: circle.r,
  });
  return { constraints, chiralityWitnesses, helpers };
}

function transformedCoincidences(constraints, idMap) {
  return (constraints || []).flatMap((constraint) => {
    if (constraint.kind !== 'coincident') return [];
    const a = idMap.get(constraint.a);
    const b = idMap.get(constraint.b);
    return a && b ? [{ kind: 'coincident', a, b }] : [];
  });
}

function mapRelationReference(value, context, path) {
  if (typeof value === 'string') return value;
  if (value.entityId !== undefined) return value.entityId;
  if (value.instanceId !== undefined) {
    const definitionId = context.instanceDefinitions.get(value.instanceId);
    if (!definitionId) fail('MISSING_SKETCH_BLOCK_INSTANCE', path + ' references missing instance "' + value.instanceId + '".');
    const definition = context.definitions.get(definitionId);
    if (!definition.constrained.entities.some((entity) => entity.id === value.memberId)) {
      fail('MISSING_SKETCH_BLOCK_MEMBER', path + ' references missing member "' + value.memberId + '".');
    }
    return studioSketchBlockMemberId(value.instanceId, value.memberId);
  }
  if (value.derivedMemberId !== undefined) {
    if (!context.derivedMemberIds.has(value.derivedMemberId)) {
      fail('MISSING_DERIVED_SKETCH_MEMBER', path + ' references missing source member "' + value.derivedMemberId + '".');
    }
    return studioDerivedSketchMemberId(context.sketchId, value.derivedMemberId);
  }
  fail('SKETCH_INSTANCE_INVALID', path + ' has an invalid member reference.');
}

function resolvedRelation(relation, context, index) {
  const output = clone(relation);
  for (const field of ENTITY_REFERENCE_FIELDS) {
    if (output[field] !== undefined) output[field] = mapRelationReference(output[field], context, 'relations[' + index + '].' + field);
  }
  return output;
}

function exactEntitiesFromLoops(loops) {
  const entities = [];
  let fallback = 0;
  for (const loop of loops) {
    if (loop.kind === 'circle') {
      entities.push({
        id: loop.entityId || 'resolved-circle-' + (++fallback),
        kind: 'circle', center: [loop.center[0], loop.center[1]], radius: loop.r,
      });
      continue;
    }
    for (const segment of loop.segments) {
      const entityId = segment.entityId || 'resolved-' + segment.kind + '-' + (++fallback);
      if (segment.kind === 'line') entities.push({ id: entityId, kind: 'line', a: [...segment.a], b: [...segment.b] });
      else if (segment.kind === 'spline') entities.push({ id: entityId, kind: 'spline', through: segment.through.map((entry) => [...entry]) });
      else entities.push({
        id: entityId, kind: 'arc', start: [...segment.a], end: [...segment.b], center: [...segment.center],
        clockwise: segment.ccw === false,
      });
    }
  }
  return entities;
}

function solvedBlockDefinition(definition, evaluate) {
  const source = definition.constrained;
  const solved = solveSketch({ entities: clone(source.entities), constraints: clone(source.constraints || []) }, {
    resolveDimension: evaluate,
    maxDenseWorkCells: MAX_SKETCH_SOLVER_DENSE_WORK_CELLS,
  });
  if (solved.status !== 'ok') {
    const workLimit = solved.diagnostics?.find((diagnostic) => diagnostic.code === 'SKETCH_SOLVE_WORK_LIMIT');
    if (workLimit) {
      fail('SKETCH_INSTANCE_RESOLVED_LIMIT', 'Block definition "' + definition.id + '" exceeds the bounded solver work budget.', {
        diagnostics: solved.diagnostics,
      });
    }
    fail('SKETCH_BLOCK_DEFINITION_UNSOLVED', 'Block definition "' + definition.id + '" did not solve.', {
      diagnostics: solved.diagnostics,
    });
  }
  return {
    entities: solved.entities,
    connectivityConstraints: clone((source.constraints || []).filter((constraint) => constraint.kind === 'coincident')),
  };
}

export function resolveStudioSketchBlockDefinition(part, definitionId, options = {}) {
  assertStudioSketchInstancesPart(part);
  const definition = definitionGraph(part).find((entry) => entry.id === definitionId);
  if (!definition) fail('MISSING_SKETCH_BLOCK', 'Block definition "' + definitionId + '" does not exist.');
  const evaluate = options.evaluate || ((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expression resolver is required.');
    return value;
  });
  return solvedBlockDefinition(definition, evaluate);
}

export function resolveStudioSketchBlockDefinitions(part, options = {}) {
  assertStudioSketchInstancesPart(part);
  const evaluate = options.evaluate || ((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expression resolver is required.');
    return value;
  });
  return new Map(definitionGraph(part).map((definition) => [
    definition.id,
    solvedBlockDefinition(definition, evaluate),
  ]));
}

export function resolveStudioConstrainedSketch(part, sketchId, options = {}) {
  assertStudioSketchInstancesPart(part);
  const evaluate = options.evaluate || ((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expression resolver is required.');
    return value;
  });
  const definitions = new Map(definitionGraph(part).map((entry) => [entry.id, entry]));
  const sketches = new Map((part.sketches || [])
    .filter((entry) => entry.extensions?.studioRole === STUDIO_CONSTRAINED_2D_ROLE)
    .map((entry) => [entry.id, entry]));
  const memo = new Map();
  const definitionMemo = options.definitionSolutions instanceof Map
    ? options.definitionSolutions
    : new Map();
  const resolving = new Set();

  function resolveDefinition(definition) {
    if (definitionMemo.has(definition.id)) return definitionMemo.get(definition.id);
    const result = solvedBlockDefinition(definition, evaluate);
    definitionMemo.set(definition.id, result);
    return result;
  }

  function resolveSketch(currentId) {
    if (memo.has(currentId)) return memo.get(currentId);
    if (resolving.has(currentId)) fail('CYCLIC_DERIVED_SKETCH', 'Derived sketch cycle reached "' + currentId + '".');
    const sketch = sketches.get(currentId);
    if (!sketch) fail('MISSING_CONSTRAINED_SKETCH', 'Constrained sketch "' + currentId + '" does not exist.');
    resolving.add(currentId);
    const source = sketch.constrained;
    const flattened = { entities: [], constraints: [] };
    const chiralityWitnesses = [];
    const helperIds = new Set();
    const rigidArcIds = new Set();
    const instanceDefinitions = new Map();
    const derivedMemberIds = new Set();
    const appendEntities = (entries) => {
      if (flattened.entities.length + entries.length > MAX_RESOLVED_SKETCH_ENTITIES) {
        fail('SKETCH_INSTANCE_RESOLVED_LIMIT', 'Resolved sketch "' + currentId + '" exceeds 25,000 solver entities.');
      }
      flattened.entities.push(...entries);
    };
    const appendConstraints = (entries) => {
      if (flattened.constraints.length + entries.length > MAX_RESOLVED_SKETCH_CONSTRAINTS) {
        fail('SKETCH_INSTANCE_RESOLVED_LIMIT', 'Resolved sketch "' + currentId + '" exceeds 100,000 solver constraints.');
      }
      flattened.constraints.push(...entries);
    };
    const appendRigidMembers = (transformed, ownerId, prefix, connectivityConstraints) => {
      const transformedConnectivity = transformedCoincidences(connectivityConstraints, transformed.idMap);
      const rigidity = rigidRelations(transformed.entities, ownerId, prefix, transformedConnectivity);
      chiralityWitnesses.push(...rigidity.chiralityWitnesses);
      rigidity.helpers.forEach((entity) => helperIds.add(entity.id));
      transformed.entities.forEach((entity) => {
        if (entity.kind === 'arc') rigidArcIds.add(entity.id);
      });
      appendEntities([...transformed.entities, ...rigidity.helpers]);
      appendConstraints([
        ...transformedConnectivity,
        ...rigidity.constraints,
      ]);
    };

    if (source.derivedFrom) {
      const upstream = resolveSketch(source.derivedFrom.sourceSketchId);
      const transform = evaluatedTransform(
        source.derivedFrom.transform,
        evaluate,
        'sketch "' + currentId + '" derived transform',
        { allowScale: false },
      );
      const transformed = transformEntities(upstream.solved.entities, {
        prefix: 'ds', ownerId: currentId, origin: [0, 0], transform, fixed: false,
      });
      upstream.solved.entities.forEach((entity) => derivedMemberIds.add(entity.id));
      appendRigidMembers(transformed, currentId, 'ds', upstream.connectivityConstraints);
    } else {
      appendEntities(clone(source.entities));
      appendConstraints(clone(source.constraints || []));
      for (const instance of source.blockInstances || []) {
        const definition = definitions.get(instance.definitionId);
        if (!definition) fail('MISSING_SKETCH_BLOCK', 'Instance "' + instance.id + '" references a missing block definition.');
        const transform = evaluatedTransform(instance.transform, evaluate, 'block instance "' + instance.id + '" transform');
        const members = resolveDefinition(definition);
        const transformed = transformEntities(members.entities, {
          prefix: 'bi', ownerId: instance.id, origin: definition.insertionPoint, transform, fixed: instance.fixed === true,
        });
        appendRigidMembers(transformed, instance.id, 'bi', members.connectivityConstraints);
        instanceDefinitions.set(instance.id, definition.id);
      }
    }

    const context = { definitions, instanceDefinitions, derivedMemberIds, sketchId: currentId };
    appendConstraints((source.relations || []).map((relation, index) => resolvedRelation(relation, context, index)));
    const diagnostics = validateConstraintSketch(flattened);
    if (diagnostics.length) {
      fail('SKETCH_INSTANCES_INVALID', 'Resolved sketch "' + currentId + '" is invalid: ' + diagnostics[0].message, { diagnostics });
    }
    const solved = solveSketch(flattened, {
      resolveDimension: evaluate,
      skipArcInternalIds: rigidArcIds,
      maxDenseWorkCells: MAX_SKETCH_SOLVER_DENSE_WORK_CELLS,
    });
    if (solved.status !== 'ok') {
      const workLimit = solved.diagnostics?.find((diagnostic) => diagnostic.code === 'SKETCH_SOLVE_WORK_LIMIT');
      if (workLimit) {
        fail('SKETCH_INSTANCE_RESOLVED_LIMIT', 'Resolved sketch "' + currentId + '" exceeds the bounded solver work budget.', {
          diagnostics: solved.diagnostics,
        });
      }
      fail('SKETCH_INSTANCES_UNSOLVED', 'Resolved sketch "' + currentId + '" did not solve.', { diagnostics: solved.diagnostics });
    }
    const solvedById = new Map(solved.entities.map((entity) => [entity.id, entity]));
    for (const witness of chiralityWitnesses) {
      const [a, b, c] = witness.points.map((pointId) => solvedById.get(pointId));
      let valid = false;
      if (witness.kind === 'projection') {
        const frameDx = b.at[0] - a.at[0];
        const frameDy = b.at[1] - a.at[1];
        const denominator = frameDx * frameDx + frameDy * frameDy;
        const projection = denominator === 0 ? Number.NaN : (
          (c.at[0] - a.at[0]) * frameDx + (c.at[1] - a.at[1]) * frameDy
        ) / denominator;
        valid = Number.isFinite(projection) && Math.abs(projection - witness.projection) <= 1e-7;
      } else {
        const signedArea = (b.at[0] - a.at[0]) * (c.at[1] - a.at[1])
          - (b.at[1] - a.at[1]) * (c.at[0] - a.at[0]);
        valid = nonCollinear(a, b, c) && Math.sign(signedArea) === witness.sign;
      }
      if (!valid) {
        fail(
          'SKETCH_BLOCK_CHIRALITY_INVALID',
          'Rigid sketch participant "' + witness.ownerId + '" reflected or collapsed during solve.',
        );
      }
    }
    const loopResult = constraintSketchToLoops(flattened, { presolved: solved });
    if (options.requireClosedProfile === true && (loopResult.status !== 'ok' || loopResult.loops.length === 0)) {
      fail('SKETCH_INSTANCES_PROFILE_OPEN', 'Resolved sketch "' + currentId + '" does not form closed profiles.', {
        diagnostics: loopResult.diagnostics,
      });
    }
    const publicEntities = solved.entities.filter((entity) => !helperIds.has(entity.id));
    const publicIds = new Set(publicEntities.map((entity) => entity.id));
    const connectivityConstraints = flattened.constraints.filter((constraint) =>
      constraint.kind === 'coincident' && publicIds.has(constraint.a) && publicIds.has(constraint.b));
    const result = {
      schema: STUDIO_SKETCH_INSTANCES_SCHEMA,
      sketchId: currentId,
      sourceSketchId: source.derivedFrom?.sourceSketchId || null,
      flattened,
      solved: { ...solved, entities: publicEntities },
      loops: loopResult.loops,
      profileStatus: loopResult.status,
      profileDiagnostics: loopResult.diagnostics,
      connectivityConstraints: clone(connectivityConstraints),
      exactEntities: exactEntitiesFromLoops(loopResult.loops),
      dof: solved.dof,
      rank: solved.rank,
      equations: solved.equations,
    };
    resolving.delete(currentId);
    memo.set(currentId, result);
    return result;
  }

  return resolveSketch(sketchId);
}

export function materializeStudioSketchMembers(
  entities,
  { idPrefix = 'materialized', preserveIds = false, constraints = [] } = {},
) {
  const map = new Map(entities.map((entity) => [
    entity.id,
    preserveIds ? entity.id : qualify(idPrefix, 'member', entity.id),
  ]));
  const output = entities.map((entity) => {
    if (entity.kind === 'point') return {
      id: map.get(entity.id), kind: 'point', at: [...entity.at],
      ...(entity.fixed === true ? { fixed: true } : {}),
    };
    if (entity.kind === 'line') return { id: map.get(entity.id), kind: 'line', a: map.get(entity.a), b: map.get(entity.b), ...(entity.construction ? { construction: true } : {}) };
    if (entity.kind === 'circle') return { id: map.get(entity.id), kind: 'circle', center: map.get(entity.center), r: entity.solvedR ?? entity.r, ...(entity.construction ? { construction: true } : {}) };
    if (entity.kind === 'arc') return { id: map.get(entity.id), kind: 'arc', center: map.get(entity.center), a: map.get(entity.a), b: map.get(entity.b), ...(entity.ccw === false ? { ccw: false } : {}), ...(entity.construction ? { construction: true } : {}) };
    if (entity.kind === 'spline') return { id: map.get(entity.id), kind: 'spline', through: entity.through.map((entry) => map.get(entry)), ...(entity.construction ? { construction: true } : {}) };
    fail('SKETCH_INSTANCE_ENTITY_UNSUPPORTED', 'Cannot materialize unsupported member kind "' + entity.kind + '".');
  });
  const materializedConstraints = constraints.flatMap((constraint) => {
    if (constraint.kind !== 'coincident') return [];
    const a = map.get(constraint.a);
    const b = map.get(constraint.b);
    return a && b ? [{ kind: 'coincident', a, b }] : [];
  });
  return { entities: output, constraints: materializedConstraints, idMap: map };
}
