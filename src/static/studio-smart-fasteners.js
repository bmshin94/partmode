import {
  assertCanonicalStandardPartFamily,
  getStandardPartCatalogSelection,
  importCanonicalStandardPartFamily,
  selectStandardFastenerCatalogStack,
} from './studio-standard-parts.js';
import { assertStudioHoleWizardFeature } from './studio-hole-wizard.js';
import { prepareStudioV5Project } from './studio-project-v5.js';
import { studioSha256TextHex } from './studio-sha256.js';

export const STUDIO_SMART_FASTENERS_SCHEMA = 'partmode.smart-fasteners/v1';
export const STUDIO_SMART_FASTENER_PLAN_SCHEMA = 'partmode.smart-fastener-plan/v1';
export const STUDIO_SMART_FASTENER_POLICY_ID = 'aligned-clearance-hole-full-stack/v1';

export const STUDIO_SMART_FASTENER_COMPONENT_ROLES = Object.freeze(['screw', 'washer', 'nut']);
export const STUDIO_SMART_FASTENER_MATE_ROLES = Object.freeze([
  'screw-concentric-hole',
  'screw-coincident-washer',
  'washer-concentric-hole',
  'washer-coincident-entry',
  'nut-concentric-screw',
  'nut-coincident-exit',
]);

export const STUDIO_SMART_FASTENER_FACE_NAMES = Object.freeze({
  screwShank: 'Ffeature-standard-screw-shank:side:inline-shape:shape-standard-screw-shank:circle',
  screwBearing: 'Ffeature-standard-screw-head:cap:start',
  washerBore: 'Ffeature-standard-washer-bore:side:inline-shape:shape-standard-washer-bore:circle',
  washerBottom: 'Ffeature-standard-washer-body:cap:start',
  washerTop: 'Ffeature-standard-washer-body:cap:end',
  nutBore: 'Ffeature-standard-nut-thread:side:inline-shape:shape-standard-nut-thread:circle',
  nutBottom: 'Ffeature-standard-nut-body:cap:start',
  nutTop: 'Ffeature-standard-nut-body:cap:end',
});

const COMPONENT_FAMILIES = Object.freeze({
  screw: 'iso4017-hex-screw',
  washer: 'iso7089-plain-washer',
  nut: 'iso4032-hex-nut',
});

const MATE_SPECS = Object.freeze({
  'screw-concentric-hole': Object.freeze({ kind: 'concentric', occurrenceRoles: Object.freeze(['screw', 'target']) }),
  'screw-coincident-washer': Object.freeze({ kind: 'coincident', occurrenceRoles: Object.freeze(['screw', 'washer']), flip: true }),
  'washer-concentric-hole': Object.freeze({ kind: 'concentric', occurrenceRoles: Object.freeze(['washer', 'target']) }),
  'washer-coincident-entry': Object.freeze({ kind: 'coincident', occurrenceRoles: Object.freeze(['washer', 'target']), flip: true }),
  'nut-concentric-screw': Object.freeze({ kind: 'concentric', occurrenceRoles: Object.freeze(['nut', 'screw']) }),
  'nut-coincident-exit': Object.freeze({ kind: 'coincident', occurrenceRoles: Object.freeze(['nut', 'target']), flip: true }),
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const THREADS = new Set(['M5', 'M6', 'M8', 'M10', 'M12']);
const clone = (value) => structuredClone(value);
const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export class StudioSmartFastenerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StudioSmartFastenerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StudioSmartFastenerError(code, message);
}

function requireRecord(value, path) {
  if (!isRecord(value)) fail('SMART_FASTENER_RECORD_INVALID', path + ' must be an object.');
  return value;
}

function requireExactKeys(value, keys, path) {
  requireRecord(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!sameJson(actual, expected)) {
    fail('SMART_FASTENER_RECORD_INVALID', path + ' contains unsupported or missing fields.');
  }
  return value;
}

function requireId(value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('SMART_FASTENER_ID_INVALID', path + ' must be a stable schema-5 ID.');
  }
  return value;
}

function requireName(value, path) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 200) {
    fail('SMART_FASTENER_NAME_INVALID', path + ' must be non-empty text of at most 200 characters without outer whitespace.');
  }
  return value;
}

function requireFinite(value, path, positive = false) {
  if (!Number.isFinite(value) || (positive && value <= 0)) {
    fail('SMART_FASTENER_NUMBER_INVALID', path + ' must be a ' + (positive ? 'positive ' : '') + 'finite number.');
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function withoutFingerprint(plan) {
  const detached = clone(plan);
  delete detached.fingerprint;
  return detached;
}

export function studioSmartFastenerPlanFingerprint(plan) {
  return studioSha256TextHex(JSON.stringify(canonicalJson(withoutFingerprint(plan))));
}

function requireRigidTransform(value, path) {
  if (!Array.isArray(value) || value.length !== 16 || !value.every(Number.isFinite)) {
    fail('SMART_FASTENER_TRANSFORM_INVALID', path + ' must contain 16 finite numbers.');
  }
  const columns = [[value[0], value[1], value[2]], [value[4], value[5], value[6]], [value[8], value[9], value[10]]];
  const dot = (left, right) => left.reduce((total, entry, index) => total + entry * right[index], 0);
  const determinant =
    columns[0][0] * (columns[1][1] * columns[2][2] - columns[1][2] * columns[2][1]) -
    columns[1][0] * (columns[0][1] * columns[2][2] - columns[0][2] * columns[2][1]) +
    columns[2][0] * (columns[0][1] * columns[1][2] - columns[0][2] * columns[1][1]);
  const rigid = columns.every((column) => Math.abs(dot(column, column) - 1) <= 1e-8)
    && Math.abs(dot(columns[0], columns[1])) <= 1e-8
    && Math.abs(dot(columns[0], columns[2])) <= 1e-8
    && Math.abs(dot(columns[1], columns[2])) <= 1e-8
    && Math.abs(determinant - 1) <= 1e-8
    && Math.abs(value[3]) <= 1e-10
    && Math.abs(value[7]) <= 1e-10
    && Math.abs(value[11]) <= 1e-10
    && Math.abs(value[15] - 1) <= 1e-10;
  if (!rigid) fail('SMART_FASTENER_TRANSFORM_INVALID', path + ' must be a rigid right-handed transform.');
  return value;
}

function requireAnalyticReference(reference, path, topologyKind, occurrenceId, ownerId, persistentName = undefined) {
  requireExactKeys(reference, ['ownerKind', 'ownerId', 'occurrencePath', 'semanticPath', 'signature'], path);
  if (reference.ownerKind !== 'body') fail('SMART_FASTENER_REFERENCE_INVALID', path + '.ownerKind must be body.');
  if (reference.ownerId !== ownerId) fail('SMART_FASTENER_REFERENCE_INVALID', path + '.ownerId does not match its source body.');
  if (!Array.isArray(reference.occurrencePath) || reference.occurrencePath.length !== 1 || reference.occurrencePath[0] !== occurrenceId) {
    fail('SMART_FASTENER_REFERENCE_INVALID', path + '.occurrencePath must contain its one direct source occurrence.');
  }
  requireRecord(reference.semanticPath, path + '.semanticPath');
  const name = reference.semanticPath.name;
  if (typeof name !== 'string' || !name || name.length > 500) {
    fail('SMART_FASTENER_REFERENCE_INVALID', path + '.semanticPath.name must retain the current persistent face name.');
  }
  if (persistentName !== undefined && name !== persistentName) {
    fail('SMART_FASTENER_REFERENCE_INVALID', path + '.semanticPath.name does not match the source-owned standard-part face.');
  }
  requireRecord(reference.signature, path + '.signature');
  if (reference.signature.topologyKind !== topologyKind) {
    fail('SMART_FASTENER_REFERENCE_INVALID', path + '.signature.topologyKind must be ' + topologyKind + '.');
  }
  const vectors = topologyKind === 'cylindrical-face' ? ['p', 'n', 'a', 'd'] : ['p', 'n'];
  vectors.forEach((field) => {
    const vector = reference.signature[field];
    if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite)) {
      fail('SMART_FASTENER_REFERENCE_INVALID', path + '.signature.' + field + ' must contain three finite numbers.');
    }
  });
  if (topologyKind === 'cylindrical-face') requireFinite(reference.signature.r, path + '.signature.r', true);
  return reference;
}

function expectedSelection(role, value) {
  const selection = requireExactKeys(value, [
    'familyId',
    'partId',
    'bodyId',
    'configurationId',
    'designation',
    'partNumber',
    'parameterOverrides',
  ], 'plan.selections.' + role);
  if (selection.familyId !== COMPONENT_FAMILIES[role]) {
    fail('SMART_FASTENER_CATALOG_INVALID', 'plan.selections.' + role + '.familyId is not the bounded source-owned family.');
  }
  let canonical;
  try {
    canonical = getStandardPartCatalogSelection(selection.familyId, selection.designation);
  } catch (error) {
    fail('SMART_FASTENER_CATALOG_INVALID', String(error?.message || error));
  }
  if (!sameJson(selection, canonical)) {
    fail('SMART_FASTENER_CATALOG_INVALID', 'plan.selections.' + role + ' does not exactly match the canonical catalog row.');
  }
  return selection;
}

function expectedMateReferences(plan, role) {
  const component = plan.occurrences;
  const selection = plan.selections;
  const target = plan.target;
  const hardware = (componentRole, persistentName, topologyKind) => ({
    componentRole,
    occurrenceId: component[componentRole].occurrenceId,
    ownerId: selection[componentRole].bodyId,
    persistentName,
    topologyKind,
  });
  const targetReference = (field, topologyKind) => ({
    componentRole: 'target',
    occurrenceId: target.occurrenceId,
    ownerId: target.bodyId,
    persistentName: target[field].semanticPath.name,
    topologyKind,
    exact: target[field],
  });
  if (role === 'screw-concentric-hole') return [
    hardware('screw', STUDIO_SMART_FASTENER_FACE_NAMES.screwShank, 'cylindrical-face'),
    targetReference('holeReference', 'cylindrical-face'),
  ];
  if (role === 'screw-coincident-washer') return [
    hardware('screw', STUDIO_SMART_FASTENER_FACE_NAMES.screwBearing, 'planar-face'),
    hardware('washer', STUDIO_SMART_FASTENER_FACE_NAMES.washerTop, 'planar-face'),
  ];
  if (role === 'washer-concentric-hole') return [
    hardware('washer', STUDIO_SMART_FASTENER_FACE_NAMES.washerBore, 'cylindrical-face'),
    targetReference('holeReference', 'cylindrical-face'),
  ];
  if (role === 'washer-coincident-entry') return [
    hardware('washer', STUDIO_SMART_FASTENER_FACE_NAMES.washerBottom, 'planar-face'),
    targetReference('entryReference', 'planar-face'),
  ];
  if (role === 'nut-concentric-screw') return [
    hardware('nut', STUDIO_SMART_FASTENER_FACE_NAMES.nutBore, 'cylindrical-face'),
    hardware('screw', STUDIO_SMART_FASTENER_FACE_NAMES.screwShank, 'cylindrical-face'),
  ];
  return [
    hardware('nut', STUDIO_SMART_FASTENER_FACE_NAMES.nutTop, 'planar-face'),
    targetReference('exitReference', 'planar-face'),
  ];
}

function assertPlanMate(plan, mate, index) {
  const path = 'plan.mates[' + index + ']';
  const role = mate?.role;
  const spec = MATE_SPECS[role];
  requireExactKeys(mate, [
    'role',
    'kind',
    'occurrenceRoles',
    'references',
    ...(spec?.flip === true ? ['flip'] : []),
  ], path);
  if (role !== STUDIO_SMART_FASTENER_MATE_ROLES[index]) {
    fail('SMART_FASTENER_PLAN_INVALID', path + '.role must use the canonical six-mate order.');
  }
  if (mate.kind !== spec.kind || !sameJson(mate.occurrenceRoles, spec.occurrenceRoles)) {
    fail('SMART_FASTENER_PLAN_INVALID', path + ' does not match the bounded mate kind and occurrence roles.');
  }
  if (spec.flip === true && mate.flip !== true) {
    fail('SMART_FASTENER_PLAN_INVALID', path + '.flip must be explicitly true for opposing axial contact normals.');
  }
  if (!Array.isArray(mate.references) || mate.references.length !== 2) {
    fail('SMART_FASTENER_PLAN_INVALID', path + '.references must contain exactly two named analytic references.');
  }
  const expected = expectedMateReferences(plan, mate.role);
  mate.references.forEach((reference, referenceIndex) => {
    const source = expected[referenceIndex];
    requireAnalyticReference(
      reference,
      path + '.references[' + referenceIndex + ']',
      source.topologyKind,
      source.occurrenceId,
      source.ownerId,
      source.persistentName,
    );
    if (source.exact && !sameJson(reference, source.exact)) {
      fail('SMART_FASTENER_PLAN_INVALID', path + '.references[' + referenceIndex + '] must equal the current target reference.');
    }
  });
}

export function assertStudioSmartFastenerPlan(plan, options = {}) {
  requireExactKeys(plan, [
    'schema',
    'policyId',
    'documentHash',
    'target',
    'selections',
    'occurrences',
    'mates',
    'fingerprint',
  ], 'plan');
  if (plan.schema !== STUDIO_SMART_FASTENER_PLAN_SCHEMA) fail('SMART_FASTENER_PLAN_INVALID', 'plan.schema is unsupported.');
  if (plan.policyId !== STUDIO_SMART_FASTENER_POLICY_ID) fail('SMART_FASTENER_PLAN_INVALID', 'plan.policyId is unsupported.');
  if (typeof plan.documentHash !== 'string' || !SHA256_PATTERN.test(plan.documentHash)) {
    fail('SMART_FASTENER_PLAN_INVALID', 'plan.documentHash must be a lowercase SHA-256 digest.');
  }
  if (options.documentHash !== undefined && plan.documentHash !== options.documentHash) {
    fail('SMART_FASTENER_PLAN_STALE', 'Smart Fastener plan is stale for the current document hash. Replan before applying it.');
  }
  if (typeof plan.fingerprint !== 'string' || !SHA256_PATTERN.test(plan.fingerprint)
      || plan.fingerprint !== studioSmartFastenerPlanFingerprint(plan)) {
    fail('SMART_FASTENER_PLAN_TAMPERED', 'Smart Fastener plan fingerprint does not match its current content.');
  }

  const target = requireExactKeys(plan.target, [
    'occurrenceId',
    'occurrencePath',
    'partId',
    'bodyId',
    'featureId',
    'designation',
    'holeReference',
    'entryReference',
    'exitReference',
    'exactGrip',
  ], 'plan.target');
  requireId(target.occurrenceId, 'plan.target.occurrenceId');
  if (!Array.isArray(target.occurrencePath) || target.occurrencePath.length !== 1 || target.occurrencePath[0] !== target.occurrenceId) {
    fail('SMART_FASTENER_PLAN_INVALID', 'plan.target.occurrencePath must contain its one direct occurrence.');
  }
  requireId(target.partId, 'plan.target.partId');
  requireId(target.bodyId, 'plan.target.bodyId');
  requireId(target.featureId, 'plan.target.featureId');
  if (!THREADS.has(target.designation)) fail('SMART_FASTENER_PLAN_INVALID', 'plan.target.designation is outside the bounded M5-M12 subset.');
  requireFinite(target.exactGrip, 'plan.target.exactGrip', true);
  requireAnalyticReference(target.holeReference, 'plan.target.holeReference', 'cylindrical-face', target.occurrenceId, target.bodyId);
  requireAnalyticReference(target.entryReference, 'plan.target.entryReference', 'planar-face', target.occurrenceId, target.bodyId);
  requireAnalyticReference(target.exitReference, 'plan.target.exitReference', 'planar-face', target.occurrenceId, target.bodyId);
  const targetNames = new Set([
    target.holeReference.semanticPath.name,
    target.entryReference.semanticPath.name,
    target.exitReference.semanticPath.name,
  ]);
  if (targetNames.size !== 3) fail('SMART_FASTENER_PLAN_INVALID', 'plan.target references must retain three distinct persistent face names.');

  requireExactKeys(plan.selections, STUDIO_SMART_FASTENER_COMPONENT_ROLES, 'plan.selections');
  STUDIO_SMART_FASTENER_COMPONENT_ROLES.forEach((role) => expectedSelection(role, plan.selections[role]));
  let selectedStack;
  try {
    selectedStack = selectStandardFastenerCatalogStack(target.designation, target.exactGrip);
  } catch (error) {
    fail('SMART_FASTENER_CATALOG_INVALID', String(error?.message || error));
  }
  STUDIO_SMART_FASTENER_COMPONENT_ROLES.forEach((role) => {
    if (!sameJson(plan.selections[role], selectedStack[role])) {
      fail('SMART_FASTENER_CATALOG_INVALID', 'plan.selections.' + role + ' is not the shortest complete stack for the exact grip.');
    }
  });

  requireExactKeys(plan.occurrences, STUDIO_SMART_FASTENER_COMPONENT_ROLES, 'plan.occurrences');
  const planOccurrenceIds = new Set([target.occurrenceId]);
  STUDIO_SMART_FASTENER_COMPONENT_ROLES.forEach((role) => {
    const occurrence = requireExactKeys(plan.occurrences[role], ['occurrenceId', 'baseTransform'], 'plan.occurrences.' + role);
    const id = requireId(occurrence.occurrenceId, 'plan.occurrences.' + role + '.occurrenceId');
    if (planOccurrenceIds.has(id)) fail('SMART_FASTENER_PLAN_INVALID', 'Plan occurrence IDs must be unique.');
    planOccurrenceIds.add(id);
    requireRigidTransform(occurrence.baseTransform, 'plan.occurrences.' + role + '.baseTransform');
  });

  if (!Array.isArray(plan.mates) || plan.mates.length !== STUDIO_SMART_FASTENER_MATE_ROLES.length) {
    fail('SMART_FASTENER_PLAN_INVALID', 'plan.mates must contain exactly six explicit templates.');
  }
  plan.mates.forEach((mate, index) => assertPlanMate(plan, mate, index));
  return clone(plan);
}

function projectDocumentHash(project) {
  const canonical = prepareStudioV5Project(JSON.parse(JSON.stringify(project)));
  return studioSha256TextHex(JSON.stringify(canonical));
}

function boundedOwnedId(groupId, suffix) {
  const direct = groupId + ':' + suffix;
  if (direct.length <= 200) return direct;
  const digest = studioSha256TextHex(direct).slice(0, 16);
  return groupId.slice(0, 200 - suffix.length - digest.length - 2) + ':' + digest + ':' + suffix;
}

export function studioSmartFastenerOwnedIds(groupId) {
  requireId(groupId, 'groupId');
  return {
    occurrenceIds: Object.fromEntries(STUDIO_SMART_FASTENER_COMPONENT_ROLES.map((role) => [role, boundedOwnedId(groupId, 'occurrence-' + role)])),
    mateIds: Object.fromEntries(STUDIO_SMART_FASTENER_MATE_ROLES.map((role) => [role, boundedOwnedId(groupId, 'mate-' + role)])),
  };
}

function ownership(groupId, role, selection = undefined) {
  return {
    schema: STUDIO_SMART_FASTENERS_SCHEMA,
    groupId,
    role,
    ...(selection ? { selection: clone(selection) } : {}),
  };
}

function persistedSelection(selection) {
  return {
    familyId: selection.familyId,
    configurationId: selection.configurationId,
    designation: selection.designation,
    partNumber: selection.partNumber,
  };
}

function rebindReference(reference, occurrenceIdsByPlanId) {
  const output = clone(reference);
  output.occurrencePath = output.occurrencePath.map((id) => occurrenceIdsByPlanId.get(id) || id);
  return output;
}

function requireRootAssembly(project) {
  if (project?.schemaVersion !== 5 || project.rootDocument?.kind !== 'assembly') {
    fail('SMART_FASTENER_DOCUMENT_INVALID', 'Smart Fasteners requires a schema-5 root assembly.');
  }
  const assembly = project.assemblyDefinitions?.find((entry) => entry.id === project.rootDocument.assemblyId);
  if (!assembly) fail('SMART_FASTENER_DOCUMENT_INVALID', 'The root assembly definition is missing.');
  return assembly;
}

function requireUnusedIds(project, ids) {
  const used = new Set();
  const visit = (value, key = '') => {
    if (key === 'id' && typeof value === 'string') used.add(value);
    else if (Array.isArray(value)) value.forEach((entry) => visit(entry));
    else if (isRecord(value)) Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(project);
  ids.forEach((id) => {
    if (used.has(id)) fail('SMART_FASTENER_ID_COLLISION', 'Smart Fastener owned ID "' + id + '" is already in use.');
  });
}

function assertTargetRecipe(project, assembly, target) {
  const occurrence = assembly.occurrences.find((entry) => entry.id === target.occurrenceId);
  if (!occurrence || occurrence.parentOccurrenceId != null || occurrence.definition?.kind !== 'part'
      || occurrence.fixed !== true || occurrence.suppressed === true) {
    fail('SMART_FASTENER_TARGET_INVALID', 'Smart Fastener target must be one fixed, direct, unsuppressed part occurrence.');
  }
  if (occurrence.definition.partId !== target.partId) {
    fail('SMART_FASTENER_TARGET_INVALID', 'Smart Fastener target part changed after planning.');
  }
  const part = project.partDefinitions.find((entry) => entry.id === target.partId);
  const body = part?.bodies?.find((entry) => entry.id === target.bodyId);
  if (!part || !body || body.kind !== 'solid' || body.suppressed === true) {
    fail('SMART_FASTENER_TARGET_INVALID', 'Smart Fastener target body must remain one valid unsuppressed solid recipe target.');
  }
  const clearanceFeatures = part.features.filter((feature) =>
    feature.suppressed !== true && feature.extensions?.holeWizard?.kind === 'clearance');
  if (clearanceFeatures.length !== 1 || clearanceFeatures[0].id !== target.featureId) {
    fail('SMART_FASTENER_TARGET_INVALID', 'Smart Fastener target part must retain one unique unsuppressed clearance Hole Wizard feature.');
  }
  let definition;
  try {
    definition = assertStudioHoleWizardFeature(clearanceFeatures[0], 'smartFastener.target.feature');
  } catch (error) {
    fail('SMART_FASTENER_TARGET_INVALID', String(error?.message || error));
  }
  if (definition.kind !== 'clearance' || definition.designation !== target.designation
      || !clearanceFeatures[0].resultPolicy?.targetBodyIds?.includes(target.bodyId)) {
    fail('SMART_FASTENER_TARGET_INVALID', 'Smart Fastener target Hole Wizard recipe no longer matches its stored association.');
  }
  return { occurrence, part, body, feature: clearanceFeatures[0] };
}

function smartFastenerTargetKey(targetOccurrenceId, target) {
  return JSON.stringify([targetOccurrenceId, target?.bodyId, target?.featureId]);
}

function assertUniqueSmartFastenerTarget(assembly, targetOccurrenceId, target, excludedGroupId = null) {
  const targetKey = smartFastenerTargetKey(targetOccurrenceId, target);
  const duplicate = (assembly.extensions?.smartFasteners?.groups || []).find((group) =>
    group.id !== excludedGroupId
    && smartFastenerTargetKey(group.targetOccurrenceId, group.target) === targetKey);
  if (duplicate) {
    fail(
      'SMART_FASTENER_TARGET_DUPLICATE',
      'Smart Fastener target occurrence/body/feature is already owned by group "' + duplicate.id + '".',
    );
  }
}

function replaceProjectContents(project, candidate) {
  for (const key of Object.keys(project)) delete project[key];
  Object.assign(project, candidate);
  return project;
}

function applyStudioSmartFastenerPlanWithHash(project, plan, options, currentHash) {
  const assembly = requireRootAssembly(project);
  assertStudioSmartFastenersProject(project);
  const id = requireId(options.id, 'options.id');
  const name = requireName(options.name || 'Smart Fastener ' + (assembly.extensions?.smartFasteners?.groups?.length + 1 || 1), 'options.name');
  assertStudioSmartFastenerPlan(plan, { documentHash: currentHash });
  assertTargetRecipe(project, assembly, plan.target);
  const existingStore = assembly.extensions?.smartFasteners;
  if (existingStore && existingStore.groups.some((group) => group.id === id)) {
    fail('SMART_FASTENER_ID_COLLISION', 'Smart Fastener group ID "' + id + '" is already in use.');
  }
  assertUniqueSmartFastenerTarget(assembly, plan.target.occurrenceId, plan.target);

  STUDIO_SMART_FASTENER_COMPONENT_ROLES.forEach((role) => importCanonicalStandardPartFamily(project, plan.selections[role].familyId));
  const owned = studioSmartFastenerOwnedIds(id);
  requireUnusedIds(project, [id, ...Object.values(owned.occurrenceIds), ...Object.values(owned.mateIds)]);
  const occurrenceIdsByPlanId = new Map([[plan.target.occurrenceId, plan.target.occurrenceId]]);

  STUDIO_SMART_FASTENER_COMPONENT_ROLES.forEach((role) => {
    const selection = plan.selections[role];
    const occurrenceId = owned.occurrenceIds[role];
    occurrenceIdsByPlanId.set(plan.occurrences[role].occurrenceId, occurrenceId);
    assembly.occurrences.push({
      id: occurrenceId,
      name: selection.partNumber,
      definition: { kind: 'part', partId: selection.partId },
      baseTransform: clone(plan.occurrences[role].baseTransform),
      fixed: false,
      suppressed: false,
      visible: true,
      parameterOverrides: clone(selection.parameterOverrides),
      extensions: { smartFastenerOwnership: ownership(id, role, persistedSelection(selection)) },
    });
  });

  plan.mates.forEach((template) => {
    const occurrenceIdForRole = (role) => role === 'target' ? plan.target.occurrenceId : owned.occurrenceIds[role];
    assembly.mates.push({
      id: owned.mateIds[template.role],
      name: name + ' ' + template.role.replaceAll('-', ' '),
      kind: template.kind,
      occurrenceIds: template.occurrenceRoles.map(occurrenceIdForRole),
      references: template.references.map((reference) => rebindReference(reference, occurrenceIdsByPlanId)),
      suppressed: false,
      extensions: {
        smartFastenerOwnership: ownership(id, template.role),
        ...(template.flip === true ? { flip: true } : {}),
      },
    });
  });

  const group = {
    id,
    name,
    policyId: STUDIO_SMART_FASTENER_POLICY_ID,
    targetOccurrenceId: plan.target.occurrenceId,
    target: {
      partId: plan.target.partId,
      bodyId: plan.target.bodyId,
      featureId: plan.target.featureId,
      designation: plan.target.designation,
    },
    selections: Object.fromEntries(STUDIO_SMART_FASTENER_COMPONENT_ROLES.map((role) => [role, persistedSelection(plan.selections[role])])),
    occurrenceIds: clone(owned.occurrenceIds),
    mateIds: clone(owned.mateIds),
  };
  assembly.extensions ||= {};
  assembly.extensions.smartFasteners ||= { schema: STUDIO_SMART_FASTENERS_SCHEMA, groups: [] };
  assembly.extensions.smartFasteners.groups.push(group);
  assertStudioSmartFastenersProject(project);
  return { project, group: clone(group) };
}

export function applyStudioSmartFastenerPlan(project, plan, options = {}) {
  const currentHash = projectDocumentHash(project);
  const candidate = clone(project);
  const result = applyStudioSmartFastenerPlanWithHash(candidate, plan, options, currentHash);
  replaceProjectContents(project, candidate);
  return { project, group: clone(result.group) };
}

export function deleteStudioSmartFastenerGroup(project, groupId) {
  const assembly = requireRootAssembly(project);
  const store = assembly.extensions?.smartFasteners;
  const index = store?.groups?.findIndex((group) => group.id === groupId) ?? -1;
  if (index < 0) fail('SMART_FASTENER_NOT_FOUND', 'Smart Fastener group "' + String(groupId) + '" does not exist.');
  const group = store.groups[index];
  const occurrenceIds = new Set(Object.values(group.occurrenceIds));
  const mateIds = new Set(Object.values(group.mateIds));
  assembly.occurrences = assembly.occurrences.filter((entry) => !occurrenceIds.has(entry.id));
  assembly.mates = assembly.mates.filter((entry) => !mateIds.has(entry.id));
  store.groups.splice(index, 1);
  if (store.groups.length === 0) delete assembly.extensions.smartFasteners;
  if (Object.keys(assembly.extensions).length === 0) delete assembly.extensions;
  assertStudioSmartFastenersProject(project);
  return { project, group: clone(group) };
}

export function updateStudioSmartFastenerGroup(project, groupId, plan, options = {}) {
  const assembly = requireRootAssembly(project);
  assertStudioSmartFastenersProject(project);
  const existing = assembly.extensions?.smartFasteners?.groups?.find((group) => group.id === groupId);
  if (!existing) fail('SMART_FASTENER_NOT_FOUND', 'Smart Fastener group "' + String(groupId) + '" does not exist.');
  const name = options.name === undefined ? existing.name : requireName(options.name, 'options.name');
  const currentHash = projectDocumentHash(project);
  assertStudioSmartFastenerPlan(plan, { documentHash: currentHash });
  assertTargetRecipe(project, assembly, plan.target);
  assertUniqueSmartFastenerTarget(assembly, plan.target.occurrenceId, plan.target, groupId);

  // Build and validate the complete replacement on a detached candidate. The
  // caller's document is not touched unless delete + apply + project
  // validation all succeed, so a failed exported update cannot strand a
  // partially deleted group or its owned occurrences and mates.
  const candidate = clone(project);
  deleteStudioSmartFastenerGroup(candidate, groupId);
  const result = applyStudioSmartFastenerPlanWithHash(candidate, plan, { id: groupId, name }, currentHash);
  replaceProjectContents(project, candidate);
  return { project, group: clone(result.group) };
}

function requirePersistedSelection(role, selection, targetDesignation) {
  requireExactKeys(selection, ['familyId', 'configurationId', 'designation', 'partNumber'], 'smartFastener.selections.' + role);
  if (selection.familyId !== COMPONENT_FAMILIES[role]) {
    fail('SMART_FASTENER_CATALOG_INVALID', 'Smart Fastener ' + role + ' family is not canonical.');
  }
  let canonical;
  try {
    canonical = getStandardPartCatalogSelection(selection.familyId, selection.designation);
  } catch (error) {
    fail('SMART_FASTENER_CATALOG_INVALID', String(error?.message || error));
  }
  if (!sameJson(selection, persistedSelection(canonical))) {
    fail('SMART_FASTENER_CATALOG_INVALID', 'Smart Fastener ' + role + ' selection is not a canonical catalog row.');
  }
  const thread = role === 'washer' ? 'M' + selection.designation : selection.designation.split('x')[0];
  if (thread !== targetDesignation) fail('SMART_FASTENER_CATALOG_INVALID', 'Smart Fastener ' + role + ' does not match the target designation.');
  return canonical;
}

function requireOwnership(value, groupId, role, selection = undefined, path = 'ownership') {
  const keys = selection ? ['schema', 'groupId', 'role', 'selection'] : ['schema', 'groupId', 'role'];
  requireExactKeys(value, keys, path);
  if (value.schema !== STUDIO_SMART_FASTENERS_SCHEMA || value.groupId !== groupId || value.role !== role) {
    fail('SMART_FASTENER_OWNERSHIP_INVALID', path + ' does not match its Smart Fastener group and role.');
  }
  if (selection && !sameJson(value.selection, selection)) {
    fail('SMART_FASTENER_OWNERSHIP_INVALID', path + '.selection does not match its configuration-aware group selection.');
  }
}

function validateStoredMate(group, mate, role, occurrenceById) {
  const spec = MATE_SPECS[role];
  if (!mate || mate.kind !== spec.kind || mate.suppressed !== false || !Array.isArray(mate.references) || mate.references.length !== 2) {
    fail('SMART_FASTENER_MATE_INVALID', 'Smart Fastener mate "' + role + '" is missing or structurally invalid.');
  }
  if ((mate.extensions?.flip === true) !== (spec.flip === true)) {
    fail('SMART_FASTENER_MATE_INVALID', 'Smart Fastener mate "' + role + '" lost its explicit axial-contact flip policy.');
  }
  const occurrenceIdForRole = (value) => value === 'target' ? group.targetOccurrenceId : group.occurrenceIds[value];
  const expectedOccurrenceIds = spec.occurrenceRoles.map(occurrenceIdForRole);
  if (!sameJson(mate.occurrenceIds, expectedOccurrenceIds)) {
    fail('SMART_FASTENER_MATE_INVALID', 'Smart Fastener mate "' + role + '" lost its exact occurrence crosslinks.');
  }
  requireOwnership(mate.extensions?.smartFastenerOwnership, group.id, role, undefined, 'mate[' + mate.id + '].extensions.smartFastenerOwnership');
  const roleByOccurrenceId = new Map([['target', group.targetOccurrenceId], ...STUDIO_SMART_FASTENER_COMPONENT_ROLES.map((componentRole) => [componentRole, group.occurrenceIds[componentRole]])]);
  const referenceRole = (reference) => {
    const occurrenceId = reference?.occurrencePath?.[0];
    return [...roleByOccurrenceId].find(([, id]) => id === occurrenceId)?.[0];
  };
  mate.references.forEach((reference, index) => {
    const componentRole = spec.occurrenceRoles[index];
    const actualRole = referenceRole(reference);
    if (actualRole !== componentRole) {
      fail('SMART_FASTENER_MATE_INVALID', 'Smart Fastener mate "' + role + '" reference paths do not match its occurrence roles.');
    }
    const occurrence = occurrenceById.get(reference.occurrencePath[0]);
    const ownerPart = occurrence?.definition?.kind === 'part'
      ? occurrence.definition.partId
      : null;
    const part = ownerPart && occurrenceById.project.partDefinitions.find((entry) => entry.id === ownerPart);
    if (reference.ownerKind !== 'body' || !part?.bodies?.some((body) => body.id === reference.ownerId)
        || typeof reference.semanticPath?.name !== 'string' || !reference.semanticPath.name) {
      fail('SMART_FASTENER_MATE_INVALID', 'Smart Fastener mate "' + role + '" must retain named source-body references.');
    }
    const topologyKind = reference.signature?.topologyKind;
    if (topologyKind !== (mate.kind === 'concentric' ? 'cylindrical-face' : 'planar-face')) {
      fail('SMART_FASTENER_MATE_INVALID', 'Smart Fastener mate "' + role + '" lost its analytic reference type.');
    }
  });
}

export function assertStudioSmartFastenersProject(project) {
  if (project?.schemaVersion !== 5) fail('SMART_FASTENER_DOCUMENT_INVALID', 'Smart Fastener validation requires a schema-5 project.');
  const allOwnedOccurrenceIds = new Set();
  const allOwnedMateIds = new Set();
  for (const assembly of project.assemblyDefinitions || []) {
    const store = assembly.extensions?.smartFasteners;
    const occurrenceById = new Map((assembly.occurrences || []).map((entry) => [entry.id, entry]));
    occurrenceById.project = project;
    const mateById = new Map((assembly.mates || []).map((entry) => [entry.id, entry]));
    const groups = store?.groups || [];
    if (store) {
      requireExactKeys(store, ['schema', 'groups'], 'assembly[' + assembly.id + '].extensions.smartFasteners');
      if (store.schema !== STUDIO_SMART_FASTENERS_SCHEMA || !Array.isArray(store.groups) || store.groups.length > 500) {
        fail('SMART_FASTENER_DOCUMENT_INVALID', 'Assembly Smart Fastener store is unsupported or exceeds 500 groups.');
      }
    }
    const groupIds = new Set();
    const targetKeys = new Set();
    for (const group of groups) {
      requireExactKeys(group, [
        'id', 'name', 'policyId', 'targetOccurrenceId', 'target', 'selections', 'occurrenceIds', 'mateIds',
      ], 'assembly[' + assembly.id + '].smartFastenerGroup');
      requireId(group.id, 'smartFastenerGroup.id');
      requireName(group.name, 'smartFastenerGroup.name');
      if (groupIds.has(group.id)) fail('SMART_FASTENER_ID_COLLISION', 'Smart Fastener group ID "' + group.id + '" is duplicated.');
      groupIds.add(group.id);
      if (group.policyId !== STUDIO_SMART_FASTENER_POLICY_ID) fail('SMART_FASTENER_DOCUMENT_INVALID', 'Smart Fastener policy is unsupported.');
      requireId(group.targetOccurrenceId, 'smartFastenerGroup.targetOccurrenceId');
      requireExactKeys(group.target, ['partId', 'bodyId', 'featureId', 'designation'], 'smartFastenerGroup.target');
      const targetKey = smartFastenerTargetKey(group.targetOccurrenceId, group.target);
      if (targetKeys.has(targetKey)) {
        fail('SMART_FASTENER_TARGET_DUPLICATE', 'Smart Fastener target occurrence/body/feature is owned by multiple groups.');
      }
      targetKeys.add(targetKey);
      const target = { ...group.target, occurrenceId: group.targetOccurrenceId };
      assertTargetRecipe(project, assembly, target);

      requireExactKeys(group.selections, STUDIO_SMART_FASTENER_COMPONENT_ROLES, 'smartFastenerGroup.selections');
      const canonicalSelections = Object.fromEntries(STUDIO_SMART_FASTENER_COMPONENT_ROLES.map((role) => [
        role,
        requirePersistedSelection(role, group.selections[role], group.target.designation),
      ]));
      for (const familyId of new Set(Object.values(canonicalSelections).map((selection) => selection.familyId))) {
        try {
          assertCanonicalStandardPartFamily(project, familyId);
        } catch (error) {
          fail('SMART_FASTENER_CATALOG_INVALID', String(error?.message || error));
        }
      }

      requireExactKeys(group.occurrenceIds, STUDIO_SMART_FASTENER_COMPONENT_ROLES, 'smartFastenerGroup.occurrenceIds');
      requireExactKeys(group.mateIds, STUDIO_SMART_FASTENER_MATE_ROLES, 'smartFastenerGroup.mateIds');
      const expectedIds = studioSmartFastenerOwnedIds(group.id);
      if (!sameJson(group.occurrenceIds, expectedIds.occurrenceIds) || !sameJson(group.mateIds, expectedIds.mateIds)) {
        fail('SMART_FASTENER_OWNERSHIP_INVALID', 'Smart Fastener owned IDs must be derived deterministically from the group ID.');
      }
      if (Object.values(group.occurrenceIds).includes(group.targetOccurrenceId)) {
        fail('SMART_FASTENER_OWNERSHIP_INVALID', 'Smart Fastener target occurrence cannot be owned by the same group.');
      }

      STUDIO_SMART_FASTENER_COMPONENT_ROLES.forEach((role) => {
        const occurrenceId = group.occurrenceIds[role];
        if (allOwnedOccurrenceIds.has(occurrenceId)) fail('SMART_FASTENER_OWNERSHIP_INVALID', 'Smart Fastener occurrence ownership is shared.');
        allOwnedOccurrenceIds.add(occurrenceId);
        const occurrence = occurrenceById.get(occurrenceId);
        const selection = canonicalSelections[role];
        if (!occurrence || occurrence.definition?.kind !== 'part' || occurrence.definition.partId !== selection.partId
            || occurrence.fixed !== false || occurrence.suppressed !== false || occurrence.visible !== true
            || !sameJson(occurrence.parameterOverrides, selection.parameterOverrides)) {
          fail('SMART_FASTENER_OWNERSHIP_INVALID', 'Smart Fastener ' + role + ' occurrence is missing or no longer matches its exact catalog configuration.');
        }
        requireOwnership(
          occurrence.extensions?.smartFastenerOwnership,
          group.id,
          role,
          group.selections[role],
          'occurrence[' + occurrenceId + '].extensions.smartFastenerOwnership',
        );
      });

      STUDIO_SMART_FASTENER_MATE_ROLES.forEach((role) => {
        const mateId = group.mateIds[role];
        if (allOwnedMateIds.has(mateId)) fail('SMART_FASTENER_OWNERSHIP_INVALID', 'Smart Fastener mate ownership is shared.');
        allOwnedMateIds.add(mateId);
        validateStoredMate(group, mateById.get(mateId), role, occurrenceById);
      });

      for (const mate of assembly.mates || []) {
        if (Object.values(group.mateIds).includes(mate.id)) continue;
        if (mate.occurrenceIds?.some((id) => Object.values(group.occurrenceIds).includes(id))) {
          fail('SMART_FASTENER_OWNERSHIP_INVALID', 'Smart Fastener owned occurrences cannot be shared with generic mates.');
        }
      }
      for (const pattern of assembly.occurrencePatterns || []) {
        if (pattern.sourceOccurrenceIds?.some((id) => Object.values(group.occurrenceIds).includes(id))) {
          fail('SMART_FASTENER_OWNERSHIP_INVALID', 'Smart Fastener owned occurrences cannot be shared with occurrence patterns.');
        }
      }
    }

    for (const occurrence of assembly.occurrences || []) {
      const owner = occurrence.extensions?.smartFastenerOwnership;
      if (owner && !allOwnedOccurrenceIds.has(occurrence.id)) {
        fail('SMART_FASTENER_OWNERSHIP_INVALID', 'An orphan Smart Fastener occurrence exists outside its group crosslinks.');
      }
    }
    for (const mate of assembly.mates || []) {
      const owner = mate.extensions?.smartFastenerOwnership;
      if (owner && !allOwnedMateIds.has(mate.id)) {
        fail('SMART_FASTENER_OWNERSHIP_INVALID', 'An orphan Smart Fastener mate exists outside its group crosslinks.');
      }
    }
  }
  return project;
}

export function studioSmartFastenerOccurrenceDependency(assembly, occurrenceId) {
  const groups = assembly?.extensions?.smartFasteners?.groups || [];
  for (const group of groups) {
    if (group.targetOccurrenceId === occurrenceId) return { groupId: group.id, role: 'target' };
    const role = STUDIO_SMART_FASTENER_COMPONENT_ROLES.find((value) => group.occurrenceIds?.[value] === occurrenceId);
    if (role) return { groupId: group.id, role };
  }
  return null;
}

export function studioSmartFastenerMateDependency(assembly, mateId) {
  const groups = assembly?.extensions?.smartFasteners?.groups || [];
  for (const group of groups) {
    const role = STUDIO_SMART_FASTENER_MATE_ROLES.find((value) => group.mateIds?.[value] === mateId);
    if (role) return { groupId: group.id, role };
  }
  return null;
}
