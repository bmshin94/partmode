import { assertStudioStructuralMemberPart } from './studio-structural-members.js';

// Source-owned contract for one exact, modeled, continuous equal-leg straight
// fillet bead. The production worker still has to prove that the two persisted
// face/edge pairs resolve to one physically valid shared straight joint; this
// module deliberately validates only the durable document-side associations.
export const STUDIO_WELD_BEAD_SCHEMA = 'partmode.weld-bead/v1';
export const STUDIO_WELD_BEAD_KINDS = Object.freeze(['fillet']);

const SUPPORT_ROLES = Object.freeze(['support-a', 'support-b']);
const RECIPE_KEYS = Object.freeze([
  'schema', 'version', 'kind', 'featureId', 'sizeMm', 'process', 'supports',
]);
const SUPPORT_KEYS = Object.freeze(['role', 'memberId', 'bodyId', 'face', 'edge']);
const TOPOLOGY_REFERENCE_KEYS = Object.freeze(['name', 'sig']);
const FEATURE_REFERENCE_KEYS = Object.freeze(['ownerKind', 'ownerId', 'semanticPath', 'signature']);
const MAX_TOPOLOGY_SIGNATURE_DEPTH = 8;
const MAX_TOPOLOGY_SIGNATURE_ITEMS = 256;
const MAX_TOPOLOGY_SIGNATURE_TEXT = 8_000;
const clone = (value) => structuredClone(value);
const owns = (record, key) => Object.prototype.hasOwnProperty.call(record, key);

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(record, keys, label) {
  if (!isRecord(record)) throw new Error(label + ' must be an object.');
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(label + ' contains unsupported or missing fields.');
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return '[' + value.map(stableValue).join(',') + ']';
  if (isRecord(value)) {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + stableValue(value[key]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function equalValue(left, right) {
  return stableValue(left) === stableValue(right);
}

function safeId(value, label, maximumLength = 120) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    || value.length > maximumLength) {
    throw new Error(label + ' must contain 1 to ' + maximumLength + ' safe identifier characters.');
  }
  return value;
}

function positiveSize(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 1e-7 || number > 10_000) {
    throw new Error('Weld-bead sizeMm must be a literal value above zero and at most 10,000 mm.');
  }
  return number;
}

function weldProcess(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return 'unspecified';
  if (typeof value !== 'string') throw new Error('Weld-bead process must be bounded text.');
  const text = value.trim();
  if (text.length > 80 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error('Weld-bead process must contain 1 to 80 printable characters.');
  }
  return text;
}

function topologyName(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 500
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(label + '.name must contain 1 to 500 printable persistent-name characters.');
  }
  return value;
}

function canonicalSignatureValue(value, label, depth, counter, ancestors) {
  if (depth > MAX_TOPOLOGY_SIGNATURE_DEPTH) {
    throw new Error(label + ' exceeds the supported topology-signature depth.');
  }
  counter.count += 1;
  if (counter.count > MAX_TOPOLOGY_SIGNATURE_ITEMS) {
    throw new Error(label + ' contains too many topology-signature values.');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(label + ' must not contain non-finite numbers.');
    return value;
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    throw new Error(label + ' must contain only JSON-compatible topology-signature values.');
  }
  if (ancestors.has(value)) throw new Error(label + ' must not contain a cycle.');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry, index) => canonicalSignatureValue(
      entry,
      label + '[' + index + ']',
      depth + 1,
      counter,
      ancestors,
    ));
  } else {
    const keys = Object.keys(value).sort();
    if (keys.some((key) => !key || key.length > 120 || /[\u0000-\u001f\u007f]/u.test(key))) {
      throw new Error(label + ' contains an invalid topology-signature field name.');
    }
    result = Object.fromEntries(keys.map((key) => [
      key,
      canonicalSignatureValue(value[key], label + '.' + key, depth + 1, counter, ancestors),
    ]));
  }
  ancestors.delete(value);
  return result;
}

function topologySignature(value, label) {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error(label + ' must be a non-empty typed topology signature.');
  }
  const result = canonicalSignatureValue(value, label, 0, { count: 0 }, new Set());
  if (stableValue(result).length > MAX_TOPOLOGY_SIGNATURE_TEXT) {
    throw new Error(label + ' exceeds the supported topology-signature size.');
  }
  return result;
}

function storedTopologyReference(value, label) {
  exactKeys(value, TOPOLOGY_REFERENCE_KEYS, label);
  return {
    name: topologyName(value.name, label),
    sig: topologySignature(value.sig, label + '.sig'),
  };
}

function weldSupport(value, expectedRole, label) {
  exactKeys(value, SUPPORT_KEYS, label);
  if (value.role !== expectedRole) {
    throw new Error(label + '.role must be ' + expectedRole + ' in canonical support order.');
  }
  return {
    role: expectedRole,
    memberId: safeId(value.memberId, label + '.memberId'),
    bodyId: safeId(value.bodyId, label + '.bodyId'),
    face: storedTopologyReference(value.face, label + '.face'),
    edge: storedTopologyReference(value.edge, label + '.edge'),
  };
}

export function assertStudioWeldBeadId(value) {
  return safeId(value, 'Weld-bead ID', 115);
}

export function studioWeldBeadRecipe(featureId, input) {
  const id = assertStudioWeldBeadId(featureId);
  if (!input || input.kind !== 'fillet') {
    throw new Error('Weld-bead kind must be fillet.');
  }
  if (!Array.isArray(input.supports) || input.supports.length !== SUPPORT_ROLES.length) {
    throw new Error('Weld-bead supports must contain exactly support-a and support-b.');
  }
  const supports = SUPPORT_ROLES.map((role, index) => weldSupport(
    input.supports[index],
    role,
    'Weld-bead supports[' + index + ']',
  ));
  if (supports[0].memberId === supports[1].memberId || supports[0].bodyId === supports[1].bodyId) {
    throw new Error('Weld bead requires two distinct structural members and two distinct member bodies.');
  }
  return {
    schema: STUDIO_WELD_BEAD_SCHEMA,
    version: 1,
    kind: 'fillet',
    featureId: id,
    sizeMm: positiveSize(input.sizeMm),
    process: weldProcess(input.process),
    supports,
  };
}

function genericInputReference(ownerKind, ownerId, role) {
  return {
    ownerKind,
    ownerId,
    semanticPath: { role },
    signature: { role },
  };
}

function topologyInputReference(ownerId, role, topologyKind, reference) {
  return {
    ownerKind: 'body',
    ownerId,
    semanticPath: { role, topologyKind, name: reference.name },
    signature: clone(reference.sig),
  };
}

function expectedInputReferences(recipe) {
  return recipe.supports.flatMap((support) => [
    genericInputReference('feature', support.memberId, support.role + '-member'),
    genericInputReference('body', support.bodyId, support.role + '-body'),
    topologyInputReference(support.bodyId, support.role + '-face', 'face', support.face),
    topologyInputReference(support.bodyId, support.role + '-edge', 'edge', support.edge),
  ]);
}

function assertInputReferences(feature, recipe, path) {
  const expected = expectedInputReferences(recipe);
  if (!Array.isArray(feature.inputRefs) || feature.inputRefs.length !== expected.length) {
    throw new Error(path + '.inputRefs must contain exactly two member, two body, two face, and two edge references.');
  }
  feature.inputRefs.forEach((reference, index) => {
    exactKeys(reference, FEATURE_REFERENCE_KEYS, path + '.inputRefs[' + index + ']');
    if (!equalValue(reference, expected[index])) {
      throw new Error(
        path + '.inputRefs[' + index + '] must be the canonical persistent '
          + expected[index].semanticPath.role + ' reference.',
      );
    }
  });
}

export function assertStudioWeldBeadFeature(feature, path = 'feature') {
  if (!feature || feature.type !== 'weld-bead') throw new Error(path + ' must be a weld-bead feature.');
  if (feature.suppressed === true) {
    throw new Error(path + ' weld beads cannot be suppressed; use the typed weld-bead lifecycle.');
  }
  const source = feature.extensions?.weldBead;
  exactKeys(source, RECIPE_KEYS, path + '.extensions.weldBead');
  if (source.schema !== STUDIO_WELD_BEAD_SCHEMA || source.version !== 1
    || !STUDIO_WELD_BEAD_KINDS.includes(source.kind)) {
    throw new Error(path + '.extensions.weldBead schema, version, or kind is unsupported.');
  }
  const recipe = studioWeldBeadRecipe(feature.id, source);
  if (!equalValue(source, recipe)) throw new Error(path + ' weld-bead recipe is not canonical.');
  if (source.featureId !== feature.id) throw new Error(path + ' weld-bead featureId is detached.');
  exactKeys(feature.resultPolicy, ['kind', 'bodyName'], path + '.resultPolicy');
  if (feature.resultPolicy.kind !== 'new-body'
    || typeof feature.resultPolicy.bodyName !== 'string'
    || !feature.resultPolicy.bodyName
    || feature.resultPolicy.bodyName !== feature.resultPolicy.bodyName.trim()
    || feature.resultPolicy.bodyName.length > 200
    || /[\u0000-\u001f\u007f]/u.test(feature.resultPolicy.bodyName)) {
    throw new Error(path + ' weld bead must create exactly one named solid body.');
  }
  safeId(feature.createdBodyId, path + '.createdBodyId');
  if (feature.createdBodyId !== 'body-' + feature.id) {
    throw new Error(path + ' weld-bead result-body identity is not canonical.');
  }
  assertInputReferences(feature, recipe, path);
  return clone(recipe);
}

function memberSupportContext(part, support, path, evaluate) {
  const memberFeature = part.features?.find((entry) => entry.id === support.memberId);
  if (!memberFeature || memberFeature.suppressed === true) {
    throw new Error(path + ' structural-member feature is missing or suppressed.');
  }
  const member = assertStudioStructuralMemberPart(part, memberFeature, path, evaluate);
  const createdBodies = (part.bodies || []).filter((entry) => entry.createdByFeatureId === memberFeature.id);
  if (createdBodies.length !== 1 || createdBodies[0].id !== support.bodyId) {
    throw new Error(path + ' structural-member body identity is missing, ambiguous, or detached.');
  }
  const body = createdBodies[0];
  if (body.kind !== 'solid' || body.suppressed === true || !Array.isArray(body.featureIds)
    || !body.featureIds.includes(memberFeature.id)) {
    throw new Error(path + ' must reference the active exact solid created by its structural member.');
  }
  return {
    role: support.role,
    feature: memberFeature,
    body,
    face: clone(support.face),
    edge: clone(support.edge),
    ...member,
  };
}

export function assertStudioWeldBeadPart(part, feature, path = 'part', evaluate = Number) {
  if (!isRecord(part)) throw new Error(path + ' must be a part definition.');
  const recipe = assertStudioWeldBeadFeature(feature, path + '.feature');
  const supports = recipe.supports.map((support, index) => memberSupportContext(
    part,
    support,
    path + '.' + support.role + '[' + index + ']',
    evaluate,
  ));
  const createdBodies = (part.bodies || []).filter((entry) => entry.createdByFeatureId === feature.id);
  if (createdBodies.length !== 1 || createdBodies[0].id !== feature.createdBodyId) {
    throw new Error(path + ' weld-bead body identity is missing, ambiguous, or detached.');
  }
  const createdBody = createdBodies[0];
  if (createdBody.kind !== 'solid' || createdBody.suppressed === true || !Array.isArray(createdBody.featureIds)
    || !createdBody.featureIds.includes(feature.id)) {
    throw new Error(path + ' weld bead must own one active exact solid body.');
  }
  return { recipe, supports, createdBody };
}

export function studioWeldBeadPatch(recipe, patch = {}) {
  if (!isRecord(patch)) throw new Error('Weld-bead patch must be an object.');
  const unsupported = Object.keys(patch).filter((key) => !['name', 'sizeMm', 'process'].includes(key));
  if (unsupported.length) {
    throw new Error(
      'Weld-bead patch cannot change ' + unsupported.join(', ')
        + '. Delete and recreate it to change support topology.',
    );
  }
  const source = {
    ...clone(recipe),
    ...Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'name')),
  };
  return studioWeldBeadRecipe(recipe.featureId, source);
}

export function isStudioWeldBeadFeature(feature) {
  return feature?.type === 'weld-bead' && owns(feature?.extensions || {}, 'weldBead');
}
