export const STUDIO_ASSEMBLY_FEATURES_SCHEMA = 'partmode.assembly-features/v1';
export const STUDIO_ASSEMBLY_FEATURE_EVIDENCE_SCHEMA = 'partmode.assembly-feature-evidence/v1';

export const STUDIO_ASSEMBLY_FEATURE_LIMITS = Object.freeze({
  features: 250,
  targetsPerFeature: 64,
  minimumDimensionMm: 0.001,
  maximumDimensionMm: 100_000,
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const FEATURE_KINDS = new Set(['cut', 'hole']);
const clone = (value) => structuredClone(value);
const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const owns = (record, key) => Object.prototype.hasOwnProperty.call(record, key);
const canonicalNumber = (value) => Object.is(value, -0) ? 0 : value;

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((entry, index) => sameValue(entry, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return sameJson(leftKeys, rightKeys) && leftKeys.every((key) => sameValue(left[key], right[key]));
}

export class StudioAssemblyFeatureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StudioAssemblyFeatureError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StudioAssemblyFeatureError(code, message);
}

function requireRecord(value, path) {
  if (!isRecord(value)) fail('ASSEMBLY_FEATURE_RECORD_INVALID', path + ' must be an object.');
  return value;
}

function requireExactKeys(value, keys, path) {
  requireRecord(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!sameJson(actual, expected)) {
    fail('ASSEMBLY_FEATURE_RECORD_INVALID', path + ' contains unsupported or missing fields.');
  }
  return value;
}

function requireInputKeys(value, requiredKeys, optionalKeys, path) {
  requireRecord(value, path);
  const supported = new Set([...requiredKeys, ...optionalKeys]);
  const missing = requiredKeys.filter((key) => !owns(value, key));
  const unsupported = Object.keys(value).filter((key) => !supported.has(key));
  if (missing.length || unsupported.length) {
    const details = [];
    if (missing.length) details.push('missing required fields: ' + missing.join(', '));
    if (unsupported.length) details.push('unsupported fields: ' + unsupported.join(', '));
    fail('ASSEMBLY_FEATURE_RECORD_INVALID', path + ' has ' + details.join('; ') + '.');
  }
  return value;
}

function requireId(value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('ASSEMBLY_FEATURE_ID_INVALID', path + ' must be a stable schema-5 ID.');
  }
  return value;
}

function requireName(value, path) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 200) {
    fail('ASSEMBLY_FEATURE_NAME_INVALID', path + ' must be non-empty text of at most 200 characters without outer whitespace.');
  }
  return value;
}

function requireBoolean(value, path) {
  if (typeof value !== 'boolean') fail('ASSEMBLY_FEATURE_RECORD_INVALID', path + ' must be true or false.');
  return value;
}

function requireDimension(value, path) {
  if (!Number.isFinite(value)
      || value < STUDIO_ASSEMBLY_FEATURE_LIMITS.minimumDimensionMm
      || value > STUDIO_ASSEMBLY_FEATURE_LIMITS.maximumDimensionMm) {
    fail(
      'ASSEMBLY_FEATURE_DIMENSION_INVALID',
      path + ' must be a finite number from ' + STUDIO_ASSEMBLY_FEATURE_LIMITS.minimumDimensionMm
        + ' mm through '
        + STUDIO_ASSEMBLY_FEATURE_LIMITS.maximumDimensionMm + ' mm.',
    );
  }
  return value;
}

function requireVector(value, path, { unit = false } = {}) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
    fail('ASSEMBLY_FEATURE_VECTOR_INVALID', path + ' must contain exactly three finite numbers.');
  }
  const length = Math.hypot(...value);
  if (!(length > 1e-12)) fail('ASSEMBLY_FEATURE_VECTOR_INVALID', path + ' must be nonzero.');
  if (unit && Math.abs(length - 1) > 1e-10) {
    fail('ASSEMBLY_FEATURE_VECTOR_INVALID', path + ' must be a unit vector.');
  }
  return value;
}

function requirePoint(value, path) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
    fail('ASSEMBLY_FEATURE_VECTOR_INVALID', path + ' must contain exactly three finite coordinates.');
  }
  return value;
}

function normalizedVector(value, path) {
  requireVector(value, path);
  const length = Math.hypot(...value);
  return value.map((entry) => canonicalNumber(entry / length));
}

function canonicalPlacement(input, path) {
  const origin = requirePoint(input.origin, path + '.origin').map(canonicalNumber);
  const direction = normalizedVector(input.direction, path + '.direction');
  const authoredX = normalizedVector(input.xDirection, path + '.xDirection');
  const projection = authoredX.reduce((total, value, index) => total + value * direction[index], 0);
  const orthogonal = authoredX.map((value, index) => value - projection * direction[index]);
  const length = Math.hypot(...orthogonal);
  if (!(length > 1e-8)) {
    fail('ASSEMBLY_FEATURE_VECTOR_INVALID', path + '.xDirection must not be parallel to direction.');
  }
  return { origin, direction, xDirection: orthogonal.map((value) => canonicalNumber(value / length)) };
}

function requireCanonicalPlacement(placement, path) {
  requireExactKeys(placement, ['origin', 'direction', 'xDirection'], path);
  requirePoint(placement.origin, path + '.origin');
  requireVector(placement.direction, path + '.direction', { unit: true });
  requireVector(placement.xDirection, path + '.xDirection', { unit: true });
  if ([...placement.origin, ...placement.direction, ...placement.xDirection].some((value) => Object.is(value, -0))) {
    fail('ASSEMBLY_FEATURE_VECTOR_INVALID', path + ' must use canonical positive zero coordinates.');
  }
  const dot = placement.direction.reduce((total, value, index) => total + value * placement.xDirection[index], 0);
  if (Math.abs(dot) > 1e-10) {
    fail('ASSEMBLY_FEATURE_VECTOR_INVALID', path + '.xDirection must be perpendicular to direction.');
  }
  return placement;
}

function canonicalDefinition(input, kind, path) {
  if (kind === 'hole') return {
    profile: 'circle',
    diameter: requireDimension(input.diameter, path + '.diameter'),
    extent: 'through-all',
  };
  return {
    profile: 'rectangle',
    width: requireDimension(input.width, path + '.width'),
    height: requireDimension(input.height, path + '.height'),
    extent: 'through-all',
  };
}

function requireCanonicalDefinition(definition, kind, path) {
  requireExactKeys(
    definition,
    kind === 'cut' ? ['profile', 'width', 'height', 'extent'] : ['profile', 'diameter', 'extent'],
    path,
  );
  if (definition.extent !== 'through-all') {
    fail('ASSEMBLY_FEATURE_EXTENT_INVALID', path + '.extent must be through-all.');
  }
  if (kind === 'cut') {
    if (definition.profile !== 'rectangle') fail('ASSEMBLY_FEATURE_PROFILE_INVALID', path + '.profile must be rectangle.');
    requireDimension(definition.width, path + '.width');
    requireDimension(definition.height, path + '.height');
  } else {
    if (definition.profile !== 'circle') fail('ASSEMBLY_FEATURE_PROFILE_INVALID', path + '.profile must be circle.');
    requireDimension(definition.diameter, path + '.diameter');
  }
  return definition;
}

function targetKey(target) {
  return target.occurrenceId + '\u0000' + target.partId + '\u0000' + target.bodyId;
}

function canonicalTargets(targets, path) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > STUDIO_ASSEMBLY_FEATURE_LIMITS.targetsPerFeature) {
    fail(
      'ASSEMBLY_FEATURE_TARGET_INVALID',
      path + ' must contain 1 through ' + STUDIO_ASSEMBLY_FEATURE_LIMITS.targetsPerFeature + ' direct occurrence/body targets.',
    );
  }
  const seen = new Set();
  return targets.map((target, index) => {
    requireExactKeys(target, ['occurrenceId', 'partId', 'bodyId'], path + '[' + index + ']');
    const canonical = {
      occurrenceId: requireId(target.occurrenceId, path + '[' + index + '].occurrenceId'),
      partId: requireId(target.partId, path + '[' + index + '].partId'),
      bodyId: requireId(target.bodyId, path + '[' + index + '].bodyId'),
    };
    const key = targetKey(canonical);
    if (seen.has(key)) fail('ASSEMBLY_FEATURE_TARGET_DUPLICATE', path + ' repeats occurrence/body target "' + key + '".');
    seen.add(key);
    return canonical;
  });
}

function requireCanonicalTargets(targets, path) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > STUDIO_ASSEMBLY_FEATURE_LIMITS.targetsPerFeature) {
    fail('ASSEMBLY_FEATURE_TARGET_INVALID', path + ' has invalid target cardinality.');
  }
  const seen = new Set();
  targets.forEach((target, index) => {
    requireExactKeys(target, ['occurrenceId', 'partId', 'bodyId'], path + '[' + index + ']');
    requireId(target.occurrenceId, path + '[' + index + '].occurrenceId');
    requireId(target.partId, path + '[' + index + '].partId');
    requireId(target.bodyId, path + '[' + index + '].bodyId');
    const key = targetKey(target);
    if (seen.has(key)) fail('ASSEMBLY_FEATURE_TARGET_DUPLICATE', path + ' repeats occurrence/body target "' + key + '".');
    seen.add(key);
  });
  return targets;
}

function rootAssembly(project) {
  if (project?.schemaVersion !== 5 || project.rootDocument?.kind !== 'assembly') {
    fail('ASSEMBLY_FEATURE_DOCUMENT_INVALID', 'Assembly features require an active schema-5 root assembly.');
  }
  const assembly = project.assemblyDefinitions?.find((entry) => entry.id === project.rootDocument.assemblyId);
  if (!assembly) fail('ASSEMBLY_FEATURE_DOCUMENT_INVALID', 'The active assembly definition is missing.');
  return assembly;
}

function owningRootAssemblyId(project) {
  if (project?.rootDocument?.kind === 'assembly') return project.rootDocument.assemblyId;
  const context = project?.metadata?.editContext;
  if (project?.rootDocument?.kind !== 'part'
      || typeof context?.assemblyId !== 'string'
      || !Array.isArray(context.occurrencePath)
      || context.occurrencePath.length !== 1) return null;
  const assembly = project.assemblyDefinitions?.find((entry) => entry.id === context.assemblyId);
  const occurrence = assembly?.occurrences?.find((entry) =>
    entry.id === context.occurrencePath[0]
    && entry.parentOccurrenceId == null
    && entry.definition?.kind === 'part');
  return occurrence?.definition?.partId === project.rootDocument.partId ? assembly.id : null;
}

function validateTarget(project, assembly, target, path) {
  const occurrence = assembly.occurrences?.find((entry) => entry.id === target.occurrenceId);
  if (!occurrence || occurrence.parentOccurrenceId != null || occurrence.definition?.kind !== 'part'
      || occurrence.suppressed === true || occurrence.extensions?.smartFastenerOwnership) {
    fail(
      'ASSEMBLY_FEATURE_TARGET_INVALID',
      path + ' must resolve to one direct, unsuppressed, non-generated part occurrence.',
    );
  }
  if (occurrence.definition.partId !== target.partId) {
    fail('ASSEMBLY_FEATURE_TARGET_INVALID', path + ' no longer resolves to its stored part definition.');
  }
  if ((assembly.occurrencePatterns || []).some((pattern) =>
    pattern.suppressed !== true && pattern.sourceOccurrenceIds?.includes(occurrence.id))) {
    fail('ASSEMBLY_FEATURE_TARGET_INVALID', path + ' cannot be an active component-pattern source.');
  }
  if ((assembly.extensions?.smartFasteners?.groups || []).some((group) =>
    group.targetOccurrenceId === target.occurrenceId && group.target?.bodyId === target.bodyId)) {
    fail(
      'ASSEMBLY_FEATURE_TARGET_INVALID',
      path + ' is the recognized target of a Smart Fastener group; the two associative owners cannot overlap.',
    );
  }
  const part = project.partDefinitions?.find((entry) => entry.id === target.partId);
  const body = part?.bodies?.find((entry) => entry.id === target.bodyId);
  if (!part || !body || body.kind !== 'solid' || body.suppressed === true || body.extensions?.consumedByFeatureId) {
    fail('ASSEMBLY_FEATURE_TARGET_INVALID', path + ' must resolve to one current unsuppressed definition-local solid body.');
  }
  return { occurrence, part, body };
}

function canonicalFeature(input, prior = null) {
  requireRecord(input, prior ? 'assemblyFeature.patch' : 'assemblyFeature.input');
  const kind = prior?.kind ?? input.kind;
  if (!FEATURE_KINDS.has(kind)) fail('ASSEMBLY_FEATURE_KIND_INVALID', 'Assembly feature kind must be cut or hole.');
  if (prior) {
    requireInputKeys(
      input,
      [],
      kind === 'cut'
        ? ['name', 'targets', 'origin', 'direction', 'xDirection', 'width', 'height', 'suppressed']
        : ['name', 'targets', 'origin', 'direction', 'xDirection', 'diameter', 'suppressed'],
      'assemblyFeature.patch',
    );
    if (Object.keys(input).length === 0) {
      fail('ASSEMBLY_FEATURE_PATCH_INVALID', 'assemblyFeature.patch must change at least one family field.');
    }
  } else {
    requireInputKeys(
      input,
      kind === 'cut'
        ? ['id', 'name', 'kind', 'targets', 'origin', 'direction', 'xDirection', 'width', 'height']
        : ['id', 'name', 'kind', 'targets', 'origin', 'direction', 'xDirection', 'diameter'],
      ['suppressed'],
      'assemblyFeature.input',
    );
  }
  const inputOrPrior = (key, fallback) => owns(input, key) ? input[key] : fallback;
  const id = requireId(prior?.id ?? input.id, 'assemblyFeature.id');
  const name = requireName(inputOrPrior('name', prior?.name), 'assemblyFeature.name');
  const sourcePlacement = {
    origin: inputOrPrior('origin', prior?.placement?.origin),
    direction: inputOrPrior('direction', prior?.placement?.direction),
    xDirection: inputOrPrior('xDirection', prior?.placement?.xDirection),
  };
  const sourceDefinition = {
    diameter: inputOrPrior('diameter', prior?.definition?.diameter),
    width: inputOrPrior('width', prior?.definition?.width),
    height: inputOrPrior('height', prior?.definition?.height),
  };
  const feature = {
    id,
    name,
    kind,
    targets: canonicalTargets(inputOrPrior('targets', prior?.targets), 'assemblyFeature.targets'),
    placement: canonicalPlacement(sourcePlacement, 'assemblyFeature.placement'),
    definition: canonicalDefinition(sourceDefinition, kind, 'assemblyFeature.definition'),
    suppressed: owns(input, 'suppressed')
      ? requireBoolean(input.suppressed, 'assemblyFeature.suppressed')
      : prior?.suppressed === true,
  };
  if (prior && sameValue(feature, prior)) {
    fail('ASSEMBLY_FEATURE_PATCH_INVALID', 'assemblyFeature.patch does not change the stored feature.');
  }
  return feature;
}

function featureStore(assembly, create = false) {
  if (!assembly.extensions && create) assembly.extensions = {};
  if (!assembly.extensions?.assemblyFeatures && create) {
    assembly.extensions.assemblyFeatures = { schema: STUDIO_ASSEMBLY_FEATURES_SCHEMA, features: [] };
  }
  return assembly.extensions?.assemblyFeatures || null;
}

function replaceProjectContents(project, candidate) {
  for (const key of Object.keys(project)) delete project[key];
  Object.assign(project, candidate);
  return project;
}

function projectIdsOutsideAssemblyFeatures(project) {
  const ids = new Set();
  const actualFeatures = new Set((project.assemblyDefinitions || []).flatMap((assembly) =>
    assembly.extensions?.assemblyFeatures?.features || []));
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry));
      return;
    }
    if (!isRecord(value)) return;
    const actualFeature = actualFeatures.has(value);
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === 'id' && typeof child === 'string' && !actualFeature) ids.add(child);
      else visit(child);
    }
  };
  visit(project);
  return ids;
}

function assertFeatureStored(project, assembly, feature, path, idsOutside, featureIds) {
  requireExactKeys(feature, ['id', 'name', 'kind', 'targets', 'placement', 'definition', 'suppressed'], path);
  requireId(feature.id, path + '.id');
  requireName(feature.name, path + '.name');
  if (!FEATURE_KINDS.has(feature.kind)) fail('ASSEMBLY_FEATURE_KIND_INVALID', path + '.kind must be cut or hole.');
  requireCanonicalTargets(feature.targets, path + '.targets');
  requireCanonicalPlacement(feature.placement, path + '.placement');
  requireCanonicalDefinition(feature.definition, feature.kind, path + '.definition');
  requireBoolean(feature.suppressed, path + '.suppressed');
  if (featureIds.has(feature.id) || idsOutside.has(feature.id)) {
    fail('ASSEMBLY_FEATURE_ID_COLLISION', 'Assembly feature ID "' + feature.id + '" is already in use.');
  }
  featureIds.add(feature.id);
  feature.targets.forEach((target, index) => validateTarget(project, assembly, target, path + '.targets[' + index + ']'));
  return feature;
}

export function assertStudioAssemblyFeaturesProject(project) {
  if (project?.schemaVersion !== 5) {
    fail('ASSEMBLY_FEATURE_DOCUMENT_INVALID', 'Assembly feature validation requires a schema-5 project.');
  }
  const idsOutside = projectIdsOutsideAssemblyFeatures(project);
  const featureIds = new Set();
  const ownerAssemblyId = owningRootAssemblyId(project);
  for (const [assemblyIndex, assembly] of (project.assemblyDefinitions || []).entries()) {
    const store = featureStore(assembly);
    if (!store) continue;
    const path = 'project.assemblyDefinitions[' + assemblyIndex + '].extensions.assemblyFeatures';
    if (ownerAssemblyId !== assembly.id) {
      fail(
        'ASSEMBLY_FEATURE_DOCUMENT_INVALID',
        path + ' is not owned by the active root assembly; nested or inactive assembly feature histories are unsupported.',
      );
    }
    requireExactKeys(store, ['schema', 'features'], path);
    if (store.schema !== STUDIO_ASSEMBLY_FEATURES_SCHEMA || !Array.isArray(store.features)
        || store.features.length > STUDIO_ASSEMBLY_FEATURE_LIMITS.features) {
      fail('ASSEMBLY_FEATURE_DOCUMENT_INVALID', path + ' is unsupported or exceeds the feature limit.');
    }
    store.features.forEach((feature, featureIndex) => assertFeatureStored(
      project,
      assembly,
      feature,
      path + '.features[' + featureIndex + ']',
      idsOutside,
      featureIds,
    ));
  }
  return project;
}

export function createStudioAssemblyFeature(project, input) {
  const candidate = clone(project);
  const assembly = rootAssembly(candidate);
  assertStudioAssemblyFeaturesProject(candidate);
  const feature = canonicalFeature(input);
  if (projectIdsOutsideAssemblyFeatures(candidate).has(feature.id)
      || (assembly.extensions?.assemblyFeatures?.features || []).some((entry) => entry.id === feature.id)) {
    fail('ASSEMBLY_FEATURE_ID_COLLISION', 'Assembly feature ID "' + feature.id + '" is already in use.');
  }
  feature.targets.forEach((target, index) => validateTarget(candidate, assembly, target, 'assemblyFeature.targets[' + index + ']'));
  const store = featureStore(assembly, true);
  if (store.features.length >= STUDIO_ASSEMBLY_FEATURE_LIMITS.features) {
    fail('ASSEMBLY_FEATURE_LIMIT', 'Assembly feature store has reached its ' + STUDIO_ASSEMBLY_FEATURE_LIMITS.features + '-feature limit.');
  }
  store.features.push(feature);
  assertStudioAssemblyFeaturesProject(candidate);
  replaceProjectContents(project, candidate);
  return { project, feature: clone(feature) };
}

export function updateStudioAssemblyFeature(project, featureId, patch) {
  requireId(featureId, 'assemblyFeature.id');
  requireRecord(patch, 'assemblyFeature.patch');
  if (owns(patch, 'id')) {
    fail('ASSEMBLY_FEATURE_ID_INVALID', 'Assembly feature IDs are immutable.');
  }
  if (owns(patch, 'kind')) {
    fail('ASSEMBLY_FEATURE_KIND_INVALID', 'Assembly feature kind is immutable; create a new feature to change families.');
  }
  const candidate = clone(project);
  const assembly = rootAssembly(candidate);
  assertStudioAssemblyFeaturesProject(candidate);
  const store = featureStore(assembly);
  const index = store?.features?.findIndex((entry) => entry.id === featureId) ?? -1;
  if (index < 0) fail('ASSEMBLY_FEATURE_NOT_FOUND', 'Assembly feature "' + String(featureId) + '" does not exist.');
  const previous = store.features[index];
  const feature = canonicalFeature(clone(patch), previous);
  feature.targets.forEach((target, targetIndex) => validateTarget(candidate, assembly, target, 'assemblyFeature.targets[' + targetIndex + ']'));
  store.features[index] = feature;
  assertStudioAssemblyFeaturesProject(candidate);
  replaceProjectContents(project, candidate);
  return { project, feature: clone(feature) };
}

export function deleteStudioAssemblyFeature(project, featureId) {
  requireId(featureId, 'assemblyFeature.id');
  const candidate = clone(project);
  const assembly = rootAssembly(candidate);
  assertStudioAssemblyFeaturesProject(candidate);
  const store = featureStore(assembly);
  const index = store?.features?.findIndex((entry) => entry.id === featureId) ?? -1;
  if (index < 0) fail('ASSEMBLY_FEATURE_NOT_FOUND', 'Assembly feature "' + String(featureId) + '" does not exist.');
  const [feature] = store.features.splice(index, 1);
  if (store.features.length === 0) delete assembly.extensions.assemblyFeatures;
  if (assembly.extensions && Object.keys(assembly.extensions).length === 0) delete assembly.extensions;
  assertStudioAssemblyFeaturesProject(candidate);
  replaceProjectContents(project, candidate);
  return { project, feature: clone(feature) };
}

export function studioAssemblyFeatureOccurrenceDependency(assembly, occurrenceId) {
  for (const feature of assembly?.extensions?.assemblyFeatures?.features || []) {
    if (feature.targets?.some((target) => target.occurrenceId === occurrenceId)) {
      return { featureId: feature.id, kind: feature.kind };
    }
  }
  return null;
}

export function studioAssemblyFeatureBodyDependencies(project, partId, bodyId) {
  const dependencies = [];
  for (const assembly of project?.assemblyDefinitions || []) {
    const occurrences = new Map((assembly.occurrences || []).map((occurrence) => [occurrence.id, occurrence]));
    for (const feature of assembly.extensions?.assemblyFeatures?.features || []) {
      for (const target of feature.targets || []) {
        const occurrence = occurrences.get(target.occurrenceId);
        if (target.partId === partId && occurrence?.definition?.kind === 'part'
            && occurrence.definition.partId === partId && target.bodyId === bodyId) {
          dependencies.push({ assemblyId: assembly.id, featureId: feature.id, occurrenceId: target.occurrenceId, kind: feature.kind });
        }
      }
    }
  }
  return dependencies;
}
