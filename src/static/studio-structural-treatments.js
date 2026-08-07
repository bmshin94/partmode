import { assertStudioStructuralMemberPart } from './studio-structural-members.js';

export const STUDIO_WELDMENT_TREATMENT_SCHEMA = 'partmode.weldment-treatment/v1';
export const STUDIO_WELDMENT_TREATMENT_KINDS = Object.freeze([
  'trim-extend',
  'corner',
  'gusset',
  'end-cap',
]);

const ENDPOINTS = Object.freeze(['start', 'end']);
const clone = (value) => structuredClone(value);
const owns = (record, key) => Object.prototype.hasOwnProperty.call(record, key);

function exactKeys(record, keys, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(label + ' must be an object.');
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label + ' contains unsupported or missing fields.');
}

function safeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value) || value.length > 120) {
    throw new Error(label + ' must contain 1 to 120 safe identifier characters.');
  }
  return value;
}

function endpoint(value, label) {
  if (!ENDPOINTS.includes(value)) throw new Error(label + ' must be start or end.');
  return value;
}

function positiveLiteral(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 1e-7 || number > 10_000) {
    throw new Error(label + ' must be a literal value above zero and at most 10,000 mm.');
  }
  return number;
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(label + ' must be one of ' + allowed.join(', ') + '.');
  return value;
}

export function assertStudioWeldmentTreatmentId(value) {
  return safeId(value, 'Weldment-treatment ID');
}

export function studioWeldmentTreatmentRecipe(featureId, input) {
  const id = assertStudioWeldmentTreatmentId(featureId);
  const kind = enumValue(input?.kind, STUDIO_WELDMENT_TREATMENT_KINDS, 'Weldment-treatment kind');
  const common = { schema: STUDIO_WELDMENT_TREATMENT_SCHEMA, version: 1, kind, featureId: id };
  if (kind === 'trim-extend') {
    return {
      ...common,
      memberId: safeId(input.memberId, 'Trim/extend memberId'),
      memberBodyId: safeId(input.memberBodyId, 'Trim/extend memberBodyId'),
      end: endpoint(input.end, 'Trim/extend end'),
      mode: enumValue(input.mode, ['trim', 'extend'], 'Trim/extend mode'),
      distance: positiveLiteral(input.distance, 'Trim/extend distance'),
    };
  }
  if (kind === 'corner') {
    const targetMemberId = safeId(input.targetMemberId, 'Corner targetMemberId');
    const otherMemberId = safeId(input.otherMemberId, 'Corner otherMemberId');
    if (targetMemberId === otherMemberId) throw new Error('Corner treatment requires two different structural members.');
    return {
      ...common,
      targetMemberId,
      targetBodyId: safeId(input.targetBodyId, 'Corner targetBodyId'),
      targetEnd: endpoint(input.targetEnd, 'Corner targetEnd'),
      otherMemberId,
      otherBodyId: safeId(input.otherBodyId, 'Corner otherBodyId'),
      otherEnd: endpoint(input.otherEnd, 'Corner otherEnd'),
      style: enumValue(input.style, ['miter', 'cope'], 'Corner style'),
    };
  }
  if (kind === 'gusset') {
    const leftMemberId = safeId(input.leftMemberId, 'Gusset leftMemberId');
    const rightMemberId = safeId(input.rightMemberId, 'Gusset rightMemberId');
    if (leftMemberId === rightMemberId) throw new Error('Gusset requires two different structural members.');
    return {
      ...common,
      leftMemberId,
      leftEnd: endpoint(input.leftEnd, 'Gusset leftEnd'),
      rightMemberId,
      rightEnd: endpoint(input.rightEnd, 'Gusset rightEnd'),
      leftLegLength: positiveLiteral(input.leftLegLength, 'Gusset left leg length'),
      rightLegLength: positiveLiteral(input.rightLegLength, 'Gusset right leg length'),
      thickness: positiveLiteral(input.thickness, 'Gusset thickness'),
    };
  }
  return {
    ...common,
    memberId: safeId(input.memberId, 'End-cap memberId'),
    end: endpoint(input.end, 'End-cap end'),
    thickness: positiveLiteral(input.thickness, 'End-cap thickness'),
  };
}

const recipeKeys = Object.freeze({
  'trim-extend': Object.freeze([
    'schema', 'version', 'kind', 'featureId', 'memberId', 'memberBodyId', 'end', 'mode', 'distance',
  ]),
  corner: Object.freeze([
    'schema', 'version', 'kind', 'featureId', 'targetMemberId', 'targetBodyId', 'targetEnd',
    'otherMemberId', 'otherBodyId', 'otherEnd', 'style',
  ]),
  gusset: Object.freeze([
    'schema', 'version', 'kind', 'featureId', 'leftMemberId', 'leftEnd', 'rightMemberId', 'rightEnd',
    'leftLegLength', 'rightLegLength', 'thickness',
  ]),
  'end-cap': Object.freeze([
    'schema', 'version', 'kind', 'featureId', 'memberId', 'end', 'thickness',
  ]),
});

function exactReference(feature, ownerKind, ownerId, role, label) {
  const matches = (feature.inputRefs || []).filter((reference) =>
    reference?.ownerKind === ownerKind
      && reference.ownerId === ownerId
      && reference.semanticPath?.role === role
      && reference.signature?.role === role);
  if (matches.length !== 1) throw new Error(label + ' must contain exactly one persistent ' + role + ' reference.');
}

export function assertStudioWeldmentTreatmentFeature(feature, path = 'feature') {
  if (!feature || feature.type !== 'weldment-treatment') throw new Error(path + ' must be a weldment-treatment feature.');
  const source = feature.extensions?.weldmentTreatment;
  if (!source || !STUDIO_WELDMENT_TREATMENT_KINDS.includes(source.kind)) {
    throw new Error(path + '.extensions.weldmentTreatment kind is unsupported.');
  }
  exactKeys(source, recipeKeys[source.kind], path + '.extensions.weldmentTreatment');
  const recipe = studioWeldmentTreatmentRecipe(feature.id, source);
  if (recipe.schema !== source.schema || recipe.version !== source.version || JSON.stringify(recipe) !== JSON.stringify(source)) {
    throw new Error(path + ' weldment-treatment recipe is not canonical.');
  }
  if (source.featureId !== feature.id) throw new Error(path + ' weldment-treatment featureId is detached.');
  const modifier = source.kind === 'trim-extend' || source.kind === 'corner';
  if (modifier) {
    const targetBodyId = source.kind === 'trim-extend' ? source.memberBodyId : source.targetBodyId;
    if (feature.resultPolicy?.kind !== 'add'
      || !Array.isArray(feature.resultPolicy.targetBodyIds)
      || feature.resultPolicy.targetBodyIds.length !== 1
      || feature.resultPolicy.targetBodyIds[0] !== targetBodyId
      || feature.createdBodyId !== undefined) {
      throw new Error(path + ' modifying treatment must target exactly its structural-member body.');
    }
  } else if (feature.resultPolicy?.kind !== 'new-body' || typeof feature.resultPolicy.bodyName !== 'string' || !feature.resultPolicy.bodyName) {
    throw new Error(path + ' plate treatment must create one named body.');
  }
  if (source.kind === 'trim-extend') {
    exactReference(feature, 'feature', source.memberId, 'member', path);
    exactReference(feature, 'body', source.memberBodyId, 'target-body', path);
  } else if (source.kind === 'corner') {
    exactReference(feature, 'feature', source.targetMemberId, 'target-member', path);
    exactReference(feature, 'body', source.targetBodyId, 'target-body', path);
    exactReference(feature, 'feature', source.otherMemberId, 'other-member', path);
    exactReference(feature, 'body', source.otherBodyId, 'other-body', path);
  } else if (source.kind === 'gusset') {
    exactReference(feature, 'feature', source.leftMemberId, 'left-member', path);
    exactReference(feature, 'feature', source.rightMemberId, 'right-member', path);
  } else {
    exactReference(feature, 'feature', source.memberId, 'member', path);
  }
  const expectedReferenceCount = source.kind === 'trim-extend' ? 2 : source.kind === 'corner' ? 4 : source.kind === 'gusset' ? 2 : 1;
  if (feature.inputRefs.length !== expectedReferenceCount) throw new Error(path + ' contains unexpected weldment-treatment input references.');
  return clone(recipe);
}

function memberContext(part, memberId, bodyId, path, evaluate) {
  const feature = part.features?.find((entry) => entry.id === memberId);
  const checked = assertStudioStructuralMemberPart(part, feature, path + '.member[' + memberId + ']', evaluate);
  const body = part.bodies?.find((entry) => entry.createdByFeatureId === feature.id);
  if (!body || (bodyId && body.id !== bodyId)) throw new Error(path + ' structural-member body identity is missing or detached.');
  return { feature, body, ...checked };
}

function endpointPoint(member, end) {
  return clone(member.evaluatedPath[end === 'start' ? 0 : 1]);
}

function awayDirection(member, end) {
  return member.currentTangent.map((value) => value * (end === 'start' ? 1 : -1));
}

function jointContext(left, leftEnd, right, rightEnd, path) {
  const leftPoint = endpointPoint(left, leftEnd);
  const rightPoint = endpointPoint(right, rightEnd);
  const scale = Math.max(
    1,
    Math.hypot(...left.evaluatedPath[1].map((value, axis) => value - left.evaluatedPath[0][axis])),
    Math.hypot(...right.evaluatedPath[1].map((value, axis) => value - right.evaluatedPath[0][axis])),
  );
  const tolerance = Math.max(1e-6, scale * 1e-9);
  if (Math.hypot(...leftPoint.map((value, axis) => value - rightPoint[axis])) > tolerance) {
    throw new Error(path + ' member endpoints must coincide to form one exact joint.');
  }
  return {
    point: leftPoint,
    leftAway: awayDirection(left, leftEnd),
    rightAway: awayDirection(right, rightEnd),
    tolerance,
  };
}

function treatmentEndpointClaims(recipe) {
  if (recipe.kind === 'trim-extend') return [{ memberId: recipe.memberId, end: recipe.end }];
  if (recipe.kind === 'corner') return [
    { memberId: recipe.targetMemberId, end: recipe.targetEnd },
    { memberId: recipe.otherMemberId, end: recipe.otherEnd },
  ];
  if (recipe.kind === 'gusset') return [
    { memberId: recipe.leftMemberId, end: recipe.leftEnd },
    { memberId: recipe.rightMemberId, end: recipe.rightEnd },
  ];
  return [{ memberId: recipe.memberId, end: recipe.end }];
}

function reciprocalMiterPair(left, right) {
  return left.kind === 'corner'
    && right.kind === 'corner'
    && left.style === 'miter'
    && right.style === 'miter'
    && left.targetMemberId === right.otherMemberId
    && left.targetEnd === right.otherEnd
    && left.otherMemberId === right.targetMemberId
    && left.otherEnd === right.targetEnd;
}

function assertExclusiveTreatmentEndpoints(part, feature, recipe, path) {
  const claims = treatmentEndpointClaims(recipe);
  for (const otherFeature of part.features || []) {
    if (otherFeature.id === feature.id || !isStudioWeldmentTreatmentFeature(otherFeature)) continue;
    const other = assertStudioWeldmentTreatmentFeature(otherFeature, path + '.peer[' + otherFeature.id + ']');
    if (reciprocalMiterPair(recipe, other)) continue;
    const conflict = claims.find((claim) => treatmentEndpointClaims(other).some((candidate) =>
      candidate.memberId === claim.memberId && candidate.end === claim.end));
    if (conflict) {
      throw new Error(
        path + ' member endpoint ' + conflict.memberId + ':' + conflict.end
          + ' is already claimed by weldment treatment ' + other.featureId
          + '. Delete the existing endpoint treatment first.',
      );
    }
  }
}

export function assertStudioWeldmentTreatmentPart(part, feature, path = 'part', evaluate = Number) {
  const recipe = assertStudioWeldmentTreatmentFeature(feature, path + '.feature');
  assertExclusiveTreatmentEndpoints(part, feature, recipe, path);
  if (recipe.kind === 'trim-extend') {
    const member = memberContext(part, recipe.memberId, recipe.memberBodyId, path, evaluate);
    const length = Math.hypot(...member.evaluatedPath[1].map((value, axis) => value - member.evaluatedPath[0][axis]));
    if (recipe.mode === 'trim' && recipe.distance >= length - Math.max(1e-7, length * 1e-9)) {
      throw new Error(path + ' trim distance must leave a positive exact member length.');
    }
    return { recipe, member, endpoint: endpointPoint(member, recipe.end), away: awayDirection(member, recipe.end) };
  }
  if (recipe.kind === 'corner') {
    const target = memberContext(part, recipe.targetMemberId, recipe.targetBodyId, path, evaluate);
    const other = memberContext(part, recipe.otherMemberId, recipe.otherBodyId, path, evaluate);
    const joint = jointContext(target, recipe.targetEnd, other, recipe.otherEnd, path + '.corner');
    const difference = joint.leftAway.map((value, axis) => value - joint.rightAway[axis]);
    if (Math.hypot(...difference) <= 1e-7) throw new Error(path + ' corner members cannot depart the joint in the same direction.');
    return { recipe, target, other, joint };
  }
  if (recipe.kind === 'gusset') {
    const left = memberContext(part, recipe.leftMemberId, null, path, evaluate);
    const right = memberContext(part, recipe.rightMemberId, null, path, evaluate);
    const joint = jointContext(left, recipe.leftEnd, right, recipe.rightEnd, path + '.gusset');
    const cross = [
      joint.leftAway[1] * joint.rightAway[2] - joint.leftAway[2] * joint.rightAway[1],
      joint.leftAway[2] * joint.rightAway[0] - joint.leftAway[0] * joint.rightAway[2],
      joint.leftAway[0] * joint.rightAway[1] - joint.leftAway[1] * joint.rightAway[0],
    ];
    if (Math.hypot(...cross) <= 1e-5) throw new Error(path + ' gusset members must define a non-collinear exact joint plane.');
    return { recipe, left, right, joint };
  }
  const member = memberContext(part, recipe.memberId, null, path, evaluate);
  return { recipe, member, endpoint: endpointPoint(member, recipe.end), away: awayDirection(member, recipe.end) };
}

export function studioWeldmentTreatmentPatch(recipe, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Weldment-treatment patch must be an object.');
  const allowed = recipe.kind === 'trim-extend'
    ? ['name', 'mode', 'distance']
    : recipe.kind === 'corner'
      ? ['name', 'style']
      : recipe.kind === 'gusset'
        ? ['name', 'leftLegLength', 'rightLegLength', 'thickness']
        : ['name', 'thickness'];
  const unsupported = Object.keys(patch).filter((key) => !allowed.includes(key));
  if (unsupported.length) throw new Error('Weldment-treatment patch cannot change ' + unsupported.join(', ') + '. Delete and recreate it to change associations.');
  const source = { ...clone(recipe), ...Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'name')) };
  return studioWeldmentTreatmentRecipe(recipe.featureId, source);
}

export function isStudioWeldmentTreatmentFeature(feature) {
  return feature?.type === 'weldment-treatment' && owns(feature?.extensions || {}, 'weldmentTreatment');
}
