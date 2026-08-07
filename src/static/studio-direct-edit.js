export const STUDIO_DIRECT_EDIT_SCHEMA = 'partmode.direct-edit/v1';
export const STUDIO_DIRECT_EDIT_MAX_DISTANCE_MM = 1_000_000;
const STUDIO_DIRECT_EDIT_MIN_DISTANCE_MM = 1e-9;
export const STUDIO_DIRECT_EDIT_OPERATIONS = Object.freeze([
  'push-pull',
  'replace-face',
  'delete-face',
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const operationSet = new Set(STUDIO_DIRECT_EDIT_OPERATIONS);
const clone = (value) => structuredClone(value);
const owns = (record, key) => Object.prototype.hasOwnProperty.call(record, key);
const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export class StudioDirectEditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StudioDirectEditError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StudioDirectEditError(code, message);
}

function exactKeys(record, keys, path) {
  if (!isRecord(record)) fail('DIRECT_EDIT_RECORD_INVALID', path + ' must be an object.');
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('DIRECT_EDIT_RECORD_INVALID', path + ' contains unsupported or missing fields.');
  }
  return record;
}

function requireId(value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('DIRECT_EDIT_ID_INVALID', path + ' must be a stable schema-5 ID.');
  }
  return value;
}

function requireName(value, path) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 200) {
    fail(
      'DIRECT_EDIT_NAME_INVALID',
      path + ' must contain 1 to 200 characters without outer whitespace.',
    );
  }
  return value;
}

function requireOperation(value, path) {
  if (!operationSet.has(value)) {
    fail('DIRECT_EDIT_OPERATION_INVALID', path + ' must be push-pull, replace-face, or delete-face.');
  }
  return value;
}

function requireBoolean(value, path) {
  if (typeof value !== 'boolean') fail('DIRECT_EDIT_RECORD_INVALID', path + ' must be true or false.');
  return value;
}

function requireExpression(value, path) {
  const valid = (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim().length > 0 && value.length <= 500);
  if (!valid) {
    fail('DIRECT_EDIT_DISTANCE_INVALID', path + ' must be a finite number or supported expression.');
  }
  if (typeof value === 'number'
      && (!(Math.abs(value) > STUDIO_DIRECT_EDIT_MIN_DISTANCE_MM)
        || Math.abs(value) > STUDIO_DIRECT_EDIT_MAX_DISTANCE_MM)) {
    fail(
      'DIRECT_EDIT_DISTANCE_INVALID',
      path + ' must be nonzero and no farther than '
        + STUDIO_DIRECT_EDIT_MAX_DISTANCE_MM + ' mm from the source face.',
    );
  }
  return value;
}

function requireTopologyReference(value, path) {
  exactKeys(value, ['name', 'sig'], path);
  if (typeof value.name !== 'string' || !value.name || value.name !== value.name.trim()
      || value.name.length > 4096) {
    fail(
      'DIRECT_EDIT_TOPOLOGY_REFERENCE_INVALID',
      path + '.name must contain one current persistent face name.',
    );
  }
  if (!isRecord(value.sig) || Object.keys(value.sig).length === 0) {
    fail(
      'DIRECT_EDIT_TOPOLOGY_REFERENCE_INVALID',
      path + '.sig must contain one persistent face signature.',
    );
  }
  return value;
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((entry, index) => sameValue(entry, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return JSON.stringify(leftKeys) === JSON.stringify(rightKeys)
    && leftKeys.every((key) => sameValue(left[key], right[key]));
}

function bodyReference(bodyId, role) {
  return {
    ownerKind: 'body',
    ownerId: bodyId,
    semanticPath: { role },
    signature: { role },
  };
}

function faceReference(bodyId, role, reference) {
  return {
    ownerKind: 'body',
    ownerId: bodyId,
    semanticPath: { role, topologyKind: 'face', name: reference.name },
    signature: clone(reference.sig),
  };
}

export function studioDirectEditInputReferences(feature) {
  const references = [
    bodyReference(feature.targetBodyId, 'target-body'),
    faceReference(feature.targetBodyId, 'target-face', feature.targetFace),
  ];
  if (feature.operation === 'replace-face') {
    references.push(
      bodyReference(feature.replacementBodyId, 'replacement-body'),
      faceReference(feature.replacementBodyId, 'replacement-face', feature.replacementFace),
    );
  } else if (feature.operation === 'delete-face') {
    references.push(faceReference(feature.targetBodyId, 'patch-face', feature.patchFace));
  }
  return references;
}

export function studioDirectEditExtension(operation) {
  return {
    schema: STUDIO_DIRECT_EDIT_SCHEMA,
    version: 1,
    operation: requireOperation(operation, 'directEdit.operation'),
  };
}

export function assertStudioDirectEditFeature(feature, path = 'feature') {
  if (!isRecord(feature) || feature.type !== 'direct-edit') {
    fail('DIRECT_EDIT_FEATURE_INVALID', path + ' must be a direct-edit feature.');
  }
  requireId(feature.id, path + '.id');
  requireName(feature.name, path + '.name');
  const operation = requireOperation(feature.operation, path + '.operation');
  const targetBodyId = requireId(feature.targetBodyId, path + '.targetBodyId');
  const sourceBodyId = requireId(feature.sourceBodyId, path + '.sourceBodyId');
  if (sourceBodyId !== targetBodyId) {
    fail('DIRECT_EDIT_TARGET_INVALID', path + '.sourceBodyId must equal immutable targetBodyId.');
  }
  requireTopologyReference(feature.targetFace, path + '.targetFace');
  requireBoolean(feature.suppressed, path + '.suppressed');

  if (feature.resultPolicy?.kind !== 'add'
      || !Array.isArray(feature.resultPolicy.targetBodyIds)
      || feature.resultPolicy.targetBodyIds.length !== 1
      || feature.resultPolicy.targetBodyIds[0] !== targetBodyId
      || Object.keys(feature.resultPolicy).some((key) => !['kind', 'targetBodyIds'].includes(key))) {
    fail(
      'DIRECT_EDIT_TARGET_INVALID',
      path + '.resultPolicy must modify exactly targetBodyId in place.',
    );
  }

  const expectedExtension = studioDirectEditExtension(operation);
  if (!isRecord(feature.extensions)
      || Object.keys(feature.extensions).length !== 1
      || !sameValue(feature.extensions.directEdit, expectedExtension)) {
    fail(
      'DIRECT_EDIT_SCHEMA_INVALID',
      path + '.extensions.directEdit must use the immutable ' + STUDIO_DIRECT_EDIT_SCHEMA + ' operation marker.',
    );
  }

  if (operation === 'push-pull') {
    requireExpression(feature.distance, path + '.distance');
    for (const field of ['replacementBodyId', 'replacementFace', 'patchFace']) {
      if (owns(feature, field)) fail('DIRECT_EDIT_RECORD_INVALID', path + '.' + field + ' is not valid for push-pull.');
    }
  } else if (operation === 'replace-face') {
    const replacementBodyId = requireId(feature.replacementBodyId, path + '.replacementBodyId');
    if (replacementBodyId === targetBodyId) {
      fail('DIRECT_EDIT_REPLACEMENT_INVALID', path + '.replacementBodyId must identify a distinct existing body.');
    }
    requireTopologyReference(feature.replacementFace, path + '.replacementFace');
    for (const field of ['distance', 'patchFace']) {
      if (owns(feature, field)) fail('DIRECT_EDIT_RECORD_INVALID', path + '.' + field + ' is not valid for replace-face.');
    }
  } else {
    requireTopologyReference(feature.patchFace, path + '.patchFace');
    if (sameValue(feature.patchFace, feature.targetFace)) {
      fail('DIRECT_EDIT_PATCH_INVALID', path + '.patchFace must identify a different existing face on the target body.');
    }
    for (const field of ['distance', 'replacementBodyId', 'replacementFace']) {
      if (owns(feature, field)) fail('DIRECT_EDIT_RECORD_INVALID', path + '.' + field + ' is not valid for delete-face.');
    }
  }

  const expectedReferences = studioDirectEditInputReferences(feature);
  if (!Array.isArray(feature.inputRefs)
      || feature.inputRefs.length !== expectedReferences.length
      || !feature.inputRefs.every((reference, index) => sameValue(reference, expectedReferences[index]))) {
    fail(
      'DIRECT_EDIT_INPUT_REFERENCE_INVALID',
      path + '.inputRefs must retain the canonical target/replacement body dependencies and persistent face roles.',
    );
  }
  return feature;
}

export function assertStudioDirectEditPart(part, feature, path = 'part', evaluate = Number) {
  assertStudioDirectEditFeature(feature, path + '.feature');
  const targetBody = part?.bodies?.find((body) => body.id === feature.targetBodyId);
  if (!targetBody || targetBody.kind !== 'solid') {
    fail('DIRECT_EDIT_TARGET_INVALID', path + ' targetBodyId must resolve to one existing solid body.');
  }
  let replacementBody = null;
  if (feature.operation === 'replace-face') {
    replacementBody = part.bodies.find((body) => body.id === feature.replacementBodyId);
    if (!replacementBody || replacementBody.kind !== 'solid' || replacementBody.id === targetBody.id) {
      fail(
        'DIRECT_EDIT_REPLACEMENT_INVALID',
        path + ' replacementBodyId must resolve to a distinct existing solid body.',
      );
    }
  }
  let distance = null;
  if (feature.operation === 'push-pull') {
    distance = evaluate(feature.distance, path + '.feature.distance');
    if (!Number.isFinite(distance)
        || !(Math.abs(distance) > STUDIO_DIRECT_EDIT_MIN_DISTANCE_MM)
        || Math.abs(distance) > STUDIO_DIRECT_EDIT_MAX_DISTANCE_MM) {
      fail(
        'DIRECT_EDIT_DISTANCE_INVALID',
        path + '.feature.distance must evaluate nonzero and within '
          + STUDIO_DIRECT_EDIT_MAX_DISTANCE_MM + ' mm.',
      );
    }
  }
  return { feature, targetBody, replacementBody, distance };
}
