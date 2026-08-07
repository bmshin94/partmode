export const STUDIO_ADVANCED_MATE_SCHEMA = 'partmode.advanced-mate/v1';
export const STUDIO_ADVANCED_MATE_VERSION = 1;
export const STUDIO_ADVANCED_MATE_LIMITS = Object.freeze({
  minimumAbsoluteRatio: 1e-9,
  maximumAbsoluteRatio: 1e6,
  minimumAngleDegrees: 0,
  maximumAngleDegrees: 180,
});
export const STUDIO_ADVANCED_MATE_KINDS = Object.freeze([
  'width',
  'symmetry',
  'path',
  'linear-coupler',
  'limit-distance',
  'limit-angle',
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const advancedMateKinds = new Set(STUDIO_ADVANCED_MATE_KINDS);
const supportedFrameOwnerKinds = new Set(['occurrence', 'datum']);
const clone = (value) => structuredClone(value);
const owns = (record, key) => Object.prototype.hasOwnProperty.call(record, key);
const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const FAMILY_CONTRACTS = Object.freeze({
  width: Object.freeze({
    occurrenceCount: 2,
    roles: Object.freeze(['width-first', 'width-second', 'tab-first', 'tab-second']),
    owners: Object.freeze([0, 0, 1, 1]),
    fields: Object.freeze([]),
  }),
  symmetry: Object.freeze({
    occurrenceCount: 3,
    roles: Object.freeze(['symmetric-first', 'symmetric-second', 'symmetry-plane']),
    owners: Object.freeze([0, 1, 2]),
    fields: Object.freeze([]),
  }),
  path: Object.freeze({
    occurrenceCount: 2,
    roles: Object.freeze(['path', 'follower']),
    owners: Object.freeze([0, 1]),
    fields: Object.freeze([]),
  }),
  'linear-coupler': Object.freeze({
    occurrenceCount: 2,
    roles: Object.freeze(['first-axis', 'second-axis']),
    owners: Object.freeze([0, 1]),
    fields: Object.freeze(['ratio', 'offset']),
  }),
  'limit-distance': Object.freeze({
    occurrenceCount: 2,
    roles: Object.freeze(['anchor', 'moving']),
    owners: Object.freeze([0, 1]),
    fields: Object.freeze(['minimum', 'maximum']),
  }),
  'limit-angle': Object.freeze({
    occurrenceCount: 2,
    roles: Object.freeze(['anchor', 'moving']),
    owners: Object.freeze([0, 1]),
    fields: Object.freeze(['minimum', 'maximum']),
  }),
});

export class StudioAdvancedMateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StudioAdvancedMateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StudioAdvancedMateError(code, message);
}

function requireRecord(value, path) {
  if (!isRecord(value)) fail('ADVANCED_MATE_RECORD_INVALID', path + ' must be an object.');
  return value;
}

function requireExactKeys(value, keys, path) {
  requireRecord(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('ADVANCED_MATE_RECORD_INVALID', path + ' contains unsupported or missing fields.');
  }
  return value;
}

function requireId(value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('ADVANCED_MATE_ID_INVALID', path + ' must be a stable schema-5 ID.');
  }
  return value;
}

function requireName(value, path) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 200) {
    fail(
      'ADVANCED_MATE_NAME_INVALID',
      path + ' must contain 1 to 200 characters without outer whitespace.',
    );
  }
  return value;
}

function requireExpression(value, path, assertExpression) {
  const expressionLike = (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim().length > 0 && value.length <= 500);
  if (!expressionLike) {
    fail(
      'ADVANCED_MATE_EXPRESSION_INVALID',
      path + ' must be a finite number or supported expression.',
    );
  }
  if (!assertExpression) return typeof value === 'number' ? value : null;
  const evaluated = assertExpression(value, path);
  if (!Number.isFinite(evaluated)) {
    fail(
      'ADVANCED_MATE_EXPRESSION_INVALID',
      path + ' must evaluate to a finite number.',
    );
  }
  return evaluated;
}

function requireFamilyValues(family, advancedMate, path, assertExpression) {
  const contract = FAMILY_CONTRACTS[family];
  const evaluated = Object.fromEntries(contract.fields.map((field) => [
    field,
    requireExpression(advancedMate[field], path + '.' + field, assertExpression),
  ]));
  if (family === 'linear-coupler' && evaluated.ratio != null) {
    const absoluteRatio = Math.abs(evaluated.ratio);
    if (absoluteRatio < STUDIO_ADVANCED_MATE_LIMITS.minimumAbsoluteRatio
        || absoluteRatio > STUDIO_ADVANCED_MATE_LIMITS.maximumAbsoluteRatio) {
      fail(
        'ADVANCED_MATE_RATIO_INVALID',
        path + '.ratio must evaluate to a nonzero finite value with absolute magnitude from '
          + STUDIO_ADVANCED_MATE_LIMITS.minimumAbsoluteRatio + ' through '
          + STUDIO_ADVANCED_MATE_LIMITS.maximumAbsoluteRatio + '.',
      );
    }
  }
  if ((family === 'limit-distance' || family === 'limit-angle')
      && evaluated.minimum != null
      && evaluated.maximum != null
      && evaluated.minimum > evaluated.maximum) {
    fail(
      'ADVANCED_MATE_LIMIT_INVALID',
      path + '.minimum must evaluate less than or equal to ' + path + '.maximum.',
    );
  }
  if (family === 'limit-angle'
      && evaluated.minimum != null
      && evaluated.maximum != null
      && (evaluated.minimum < STUDIO_ADVANCED_MATE_LIMITS.minimumAngleDegrees
        || evaluated.maximum > STUDIO_ADVANCED_MATE_LIMITS.maximumAngleDegrees)) {
    fail(
      'ADVANCED_MATE_LIMIT_INVALID',
      path + ' angle bounds must evaluate from '
        + STUDIO_ADVANCED_MATE_LIMITS.minimumAngleDegrees + ' through '
        + STUDIO_ADVANCED_MATE_LIMITS.maximumAngleDegrees + ' degrees.',
    );
  }
  return evaluated;
}

function referenceOwnerOccurrence(reference) {
  if (Array.isArray(reference.occurrencePath) && reference.occurrencePath.length > 0) {
    return reference.occurrencePath[0];
  }
  if (reference.ownerKind === 'occurrence') return reference.ownerId;
  return null;
}

function requireReference(reference, role, occurrenceId, family, path) {
  requireRecord(reference, path);
  if (!isRecord(reference.semanticPath) || reference.semanticPath.role !== role) {
    fail(
      'ADVANCED_MATE_REFERENCE_ROLE_INVALID',
      path + '.semanticPath.role must be "' + role + '".',
    );
  }
  if (referenceOwnerOccurrence(reference) !== occurrenceId) {
    fail(
      'ADVANCED_MATE_REFERENCE_OWNER_INVALID',
      path + ' must be owned through occurrence "' + occurrenceId + '".',
    );
  }
  const pathSource = family === 'path' && role === 'path';
  if (pathSource && reference.ownerKind !== 'sketch') {
    fail(
      'ADVANCED_MATE_REFERENCE_OWNER_INVALID',
      path + ' must use ownerKind "sketch" for the path reference.',
    );
  }
  if (!pathSource && !supportedFrameOwnerKinds.has(reference.ownerKind)) {
    fail(
      'ADVANCED_MATE_REFERENCE_KIND_INVALID',
      path + ' must use a component occurrence origin or supported datum.',
    );
  }
  return reference;
}

export function isStudioAdvancedMateKind(kind) {
  return advancedMateKinds.has(kind);
}

export function hasStudioAdvancedMateContract(value) {
  return Boolean(isRecord(value?.extensions) && owns(value.extensions, 'advancedMate'));
}

export function studioAdvancedMateExtension(family, fields = {}) {
  if (!isStudioAdvancedMateKind(family)) {
    fail('ADVANCED_MATE_FAMILY_INVALID', 'advancedMate.family is unsupported.');
  }
  const contract = FAMILY_CONTRACTS[family];
  requireExactKeys(fields, contract.fields, 'advancedMate fields');
  requireFamilyValues(family, fields, 'advancedMate');
  return {
    schema: STUDIO_ADVANCED_MATE_SCHEMA,
    version: STUDIO_ADVANCED_MATE_VERSION,
    family,
    ...clone(fields),
  };
}

export function assertStudioAdvancedMateRecord(mate, options = {}) {
  const path = options.path || 'mate';
  requireExactKeys(
    mate,
    ['id', 'name', 'kind', 'occurrenceIds', 'references', 'suppressed', 'extensions'],
    path,
  );
  requireId(mate.id, path + '.id');
  requireName(mate.name, path + '.name');
  if (!isStudioAdvancedMateKind(mate.kind)) {
    fail('ADVANCED_MATE_KIND_INVALID', path + '.kind is not an advanced mate family.');
  }
  if (typeof mate.suppressed !== 'boolean') {
    fail('ADVANCED_MATE_RECORD_INVALID', path + '.suppressed must be true or false.');
  }

  const contract = FAMILY_CONTRACTS[mate.kind];
  if (!Array.isArray(mate.occurrenceIds)
      || mate.occurrenceIds.length !== contract.occurrenceCount) {
    fail(
      'ADVANCED_MATE_OCCURRENCE_INVALID',
      path + '.occurrenceIds must contain exactly ' + contract.occurrenceCount + ' occurrences.',
    );
  }
  const seenOccurrences = new Set();
  mate.occurrenceIds.forEach((occurrenceId, index) => {
    requireId(occurrenceId, path + '.occurrenceIds[' + index + ']');
    if (seenOccurrences.has(occurrenceId)) {
      fail(
        'ADVANCED_MATE_OCCURRENCE_INVALID',
        path + '.occurrenceIds must contain distinct occurrences.',
      );
    }
    seenOccurrences.add(occurrenceId);
  });

  if (!Array.isArray(mate.references) || mate.references.length !== contract.roles.length) {
    fail(
      'ADVANCED_MATE_REFERENCE_ROLE_INVALID',
      path + '.references must contain exactly ' + contract.roles.length + ' ordered references.',
    );
  }
  mate.references.forEach((reference, index) => requireReference(
    reference,
    contract.roles[index],
    mate.occurrenceIds[contract.owners[index]],
    mate.kind,
    path + '.references[' + index + ']',
  ));

  requireExactKeys(mate.extensions, ['advancedMate'], path + '.extensions');
  const advancedMate = requireExactKeys(
    mate.extensions.advancedMate,
    ['schema', 'version', 'family', ...contract.fields],
    path + '.extensions.advancedMate',
  );
  if (advancedMate.schema !== STUDIO_ADVANCED_MATE_SCHEMA
      || advancedMate.version !== STUDIO_ADVANCED_MATE_VERSION) {
    fail(
      'ADVANCED_MATE_SCHEMA_INVALID',
      path + '.extensions.advancedMate must use ' + STUDIO_ADVANCED_MATE_SCHEMA + ' version 1.',
    );
  }
  if (advancedMate.family !== mate.kind) {
    fail(
      'ADVANCED_MATE_FAMILY_INVALID',
      path + '.extensions.advancedMate.family must equal immutable mate kind "' + mate.kind + '".',
    );
  }
  requireFamilyValues(
    mate.kind,
    advancedMate,
    path + '.extensions.advancedMate',
    options.evaluateExpression || options.assertExpression,
  );
  return mate;
}

export function buildStudioAdvancedMateRecord(input, options = {}) {
  requireExactKeys(
    input,
    ['id', 'name', 'kind', 'occurrenceIds', 'references', 'suppressed', 'extensions'],
    options.inputPath || 'advanced mate input',
  );
  const record = {
    id: input.id,
    name: input.name,
    kind: input.kind,
    occurrenceIds: clone(input.occurrenceIds),
    references: clone(input.references),
    suppressed: input.suppressed,
    extensions: clone(input.extensions),
  };
  assertStudioAdvancedMateRecord(record, options);
  return record;
}

export function assertStudioAdvancedMateUpdate(previous, next, options = {}) {
  assertStudioAdvancedMateRecord(previous, {
    ...options,
    path: options.previousPath || 'previous mate',
  });
  if (next?.kind !== previous.kind
      || next?.extensions?.advancedMate?.family !== previous.extensions.advancedMate.family) {
    fail(
      'ADVANCED_MATE_FAMILY_IMMUTABLE',
      (options.path || 'mate') + ' cannot change its advanced mate kind or family.',
    );
  }
  assertStudioAdvancedMateRecord(next, {
    ...options,
    path: options.path || 'mate',
  });
  return next;
}
