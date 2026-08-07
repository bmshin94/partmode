export const STUDIO_MECHANICAL_MATE_SCHEMA = 'partmode.mechanical-mate/v1';
export const STUDIO_MECHANICAL_MATE_VERSION = 1;
export const STUDIO_MECHANICAL_MATE_LIMITS = Object.freeze({
  minimumGearRatio: 1e-9,
  maximumGearRatio: 1e6,
  minimumHingeAngleDegrees: -180,
  maximumHingeAngleDegrees: 180,
});
export const STUDIO_MECHANICAL_MATE_KINDS = Object.freeze(['gear', 'hinge']);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const mechanicalMateKinds = new Set(STUDIO_MECHANICAL_MATE_KINDS);
const clone = (value) => structuredClone(value);
const owns = (record, key) => Object.prototype.hasOwnProperty.call(record, key);
const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

// Both delivered mechanical families constrain rotation about persistent axis
// datums. Gear couples the two ordered shaft rotations through a stored
// positive ratio and offset; hinge collapses a concentric axis pair to one
// rotational DOF with optional inclusive signed angle limits. The hinge limit
// pair is nullable as a unit: both null means a free hinge, and a single
// authored bound fails closed instead of guessing the other side.
const FAMILY_CONTRACTS = Object.freeze({
  gear: Object.freeze({
    occurrenceCount: 2,
    roles: Object.freeze(['gear-first-axis', 'gear-second-axis']),
    owners: Object.freeze([0, 1]),
    fields: Object.freeze(['ratio', 'offset']),
    nullableFields: Object.freeze([]),
  }),
  hinge: Object.freeze({
    occurrenceCount: 2,
    roles: Object.freeze(['hinge-first-axis', 'hinge-second-axis']),
    owners: Object.freeze([0, 1]),
    fields: Object.freeze(['minimum', 'maximum']),
    nullableFields: Object.freeze(['minimum', 'maximum']),
  }),
});

export class StudioMechanicalMateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StudioMechanicalMateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StudioMechanicalMateError(code, message);
}

function requireRecord(value, path) {
  if (!isRecord(value)) fail('MECHANICAL_MATE_RECORD_INVALID', path + ' must be an object.');
  return value;
}

function requireExactKeys(value, keys, path) {
  requireRecord(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('MECHANICAL_MATE_RECORD_INVALID', path + ' contains unsupported or missing fields.');
  }
  return value;
}

function requireId(value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('MECHANICAL_MATE_ID_INVALID', path + ' must be a stable schema-5 ID.');
  }
  return value;
}

function requireName(value, path) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 200) {
    fail(
      'MECHANICAL_MATE_NAME_INVALID',
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
      'MECHANICAL_MATE_EXPRESSION_INVALID',
      path + ' must be a finite number or supported expression.',
    );
  }
  if (!assertExpression) return typeof value === 'number' ? value : null;
  const evaluated = assertExpression(value, path);
  if (!Number.isFinite(evaluated)) {
    fail(
      'MECHANICAL_MATE_EXPRESSION_INVALID',
      path + ' must evaluate to a finite number.',
    );
  }
  return evaluated;
}

function requireFamilyValues(family, mechanicalMate, path, assertExpression) {
  const contract = FAMILY_CONTRACTS[family];
  const nullable = new Set(contract.nullableFields);
  const evaluated = Object.fromEntries(contract.fields.map((field) => [
    field,
    nullable.has(field) && mechanicalMate[field] === null
      ? null
      : requireExpression(mechanicalMate[field], path + '.' + field, assertExpression),
  ]));
  if (family === 'gear' && evaluated.ratio != null) {
    if (!(evaluated.ratio >= STUDIO_MECHANICAL_MATE_LIMITS.minimumGearRatio)
        || !(evaluated.ratio <= STUDIO_MECHANICAL_MATE_LIMITS.maximumGearRatio)) {
      fail(
        'MECHANICAL_MATE_RATIO_INVALID',
        path + '.ratio must evaluate to a positive finite value from '
          + STUDIO_MECHANICAL_MATE_LIMITS.minimumGearRatio + ' through '
          + STUDIO_MECHANICAL_MATE_LIMITS.maximumGearRatio + '.',
      );
    }
  }
  if (family === 'hinge') {
    const authoredMinimum = mechanicalMate.minimum !== null;
    const authoredMaximum = mechanicalMate.maximum !== null;
    if (authoredMinimum !== authoredMaximum) {
      fail(
        'MECHANICAL_MATE_LIMIT_INVALID',
        path + ' hinge limits must be authored together or both left null.',
      );
    }
    if (evaluated.minimum != null && evaluated.maximum != null) {
      if (evaluated.minimum > evaluated.maximum) {
        fail(
          'MECHANICAL_MATE_LIMIT_INVALID',
          path + '.minimum must evaluate less than or equal to ' + path + '.maximum.',
        );
      }
      if (evaluated.minimum < STUDIO_MECHANICAL_MATE_LIMITS.minimumHingeAngleDegrees
          || evaluated.maximum > STUDIO_MECHANICAL_MATE_LIMITS.maximumHingeAngleDegrees) {
        fail(
          'MECHANICAL_MATE_LIMIT_INVALID',
          path + ' hinge angle bounds must evaluate from '
            + STUDIO_MECHANICAL_MATE_LIMITS.minimumHingeAngleDegrees + ' through '
            + STUDIO_MECHANICAL_MATE_LIMITS.maximumHingeAngleDegrees + ' degrees.',
        );
      }
    }
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

function requireReference(reference, role, occurrenceId, path) {
  requireRecord(reference, path);
  if (!isRecord(reference.semanticPath) || reference.semanticPath.role !== role) {
    fail(
      'MECHANICAL_MATE_REFERENCE_ROLE_INVALID',
      path + '.semanticPath.role must be "' + role + '".',
    );
  }
  if (referenceOwnerOccurrence(reference) !== occurrenceId) {
    fail(
      'MECHANICAL_MATE_REFERENCE_OWNER_INVALID',
      path + ' must be owned through occurrence "' + occurrenceId + '".',
    );
  }
  // Every delivered mechanical role is an axis; component origins, sketches,
  // and body topology are outside the proved reference surface. The axis
  // datum kind itself is verified at project reference resolution.
  if (reference.ownerKind !== 'datum') {
    fail(
      'MECHANICAL_MATE_REFERENCE_KIND_INVALID',
      path + ' must reference a persistent axis datum.',
    );
  }
  return reference;
}

export function isStudioMechanicalMateKind(kind) {
  return mechanicalMateKinds.has(kind);
}

export function hasStudioMechanicalMateContract(value) {
  return Boolean(isRecord(value?.extensions) && owns(value.extensions, 'mechanicalMate'));
}

export function studioMechanicalMateExtension(family, fields = {}) {
  if (!isStudioMechanicalMateKind(family)) {
    fail('MECHANICAL_MATE_FAMILY_INVALID', 'mechanicalMate.family is unsupported.');
  }
  const contract = FAMILY_CONTRACTS[family];
  requireExactKeys(fields, contract.fields, 'mechanicalMate fields');
  requireFamilyValues(family, fields, 'mechanicalMate');
  return {
    schema: STUDIO_MECHANICAL_MATE_SCHEMA,
    version: STUDIO_MECHANICAL_MATE_VERSION,
    family,
    ...clone(fields),
  };
}

export function assertStudioMechanicalMateRecord(mate, options = {}) {
  const path = options.path || 'mate';
  requireExactKeys(
    mate,
    ['id', 'name', 'kind', 'occurrenceIds', 'references', 'suppressed', 'extensions'],
    path,
  );
  requireId(mate.id, path + '.id');
  requireName(mate.name, path + '.name');
  if (!isStudioMechanicalMateKind(mate.kind)) {
    fail('MECHANICAL_MATE_KIND_INVALID', path + '.kind is not a mechanical mate family.');
  }
  if (typeof mate.suppressed !== 'boolean') {
    fail('MECHANICAL_MATE_RECORD_INVALID', path + '.suppressed must be true or false.');
  }

  const contract = FAMILY_CONTRACTS[mate.kind];
  if (!Array.isArray(mate.occurrenceIds)
      || mate.occurrenceIds.length !== contract.occurrenceCount) {
    fail(
      'MECHANICAL_MATE_OCCURRENCE_INVALID',
      path + '.occurrenceIds must contain exactly ' + contract.occurrenceCount + ' occurrences.',
    );
  }
  const seenOccurrences = new Set();
  mate.occurrenceIds.forEach((occurrenceId, index) => {
    requireId(occurrenceId, path + '.occurrenceIds[' + index + ']');
    if (seenOccurrences.has(occurrenceId)) {
      fail(
        'MECHANICAL_MATE_OCCURRENCE_INVALID',
        path + '.occurrenceIds must contain distinct occurrences.',
      );
    }
    seenOccurrences.add(occurrenceId);
  });

  if (!Array.isArray(mate.references) || mate.references.length !== contract.roles.length) {
    fail(
      'MECHANICAL_MATE_REFERENCE_ROLE_INVALID',
      path + '.references must contain exactly ' + contract.roles.length + ' ordered references.',
    );
  }
  mate.references.forEach((reference, index) => requireReference(
    reference,
    contract.roles[index],
    mate.occurrenceIds[contract.owners[index]],
    path + '.references[' + index + ']',
  ));

  requireExactKeys(mate.extensions, ['mechanicalMate'], path + '.extensions');
  const mechanicalMate = requireExactKeys(
    mate.extensions.mechanicalMate,
    ['schema', 'version', 'family', ...contract.fields],
    path + '.extensions.mechanicalMate',
  );
  if (mechanicalMate.schema !== STUDIO_MECHANICAL_MATE_SCHEMA
      || mechanicalMate.version !== STUDIO_MECHANICAL_MATE_VERSION) {
    fail(
      'MECHANICAL_MATE_SCHEMA_INVALID',
      path + '.extensions.mechanicalMate must use ' + STUDIO_MECHANICAL_MATE_SCHEMA + ' version 1.',
    );
  }
  if (mechanicalMate.family !== mate.kind) {
    fail(
      'MECHANICAL_MATE_FAMILY_INVALID',
      path + '.extensions.mechanicalMate.family must equal immutable mate kind "' + mate.kind + '".',
    );
  }
  requireFamilyValues(
    mate.kind,
    mechanicalMate,
    path + '.extensions.mechanicalMate',
    options.evaluateExpression || options.assertExpression,
  );
  return mate;
}

export function buildStudioMechanicalMateRecord(input, options = {}) {
  requireExactKeys(
    input,
    ['id', 'name', 'kind', 'occurrenceIds', 'references', 'suppressed', 'extensions'],
    options.inputPath || 'mechanical mate input',
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
  assertStudioMechanicalMateRecord(record, options);
  return record;
}

export function assertStudioMechanicalMateUpdate(previous, next, options = {}) {
  assertStudioMechanicalMateRecord(previous, {
    ...options,
    path: options.previousPath || 'previous mate',
  });
  if (next?.kind !== previous.kind
      || next?.extensions?.mechanicalMate?.family !== previous.extensions.mechanicalMate.family) {
    fail(
      'MECHANICAL_MATE_FAMILY_IMMUTABLE',
      (options.path || 'mate') + ' cannot change its mechanical mate kind or family.',
    );
  }
  assertStudioMechanicalMateRecord(next, {
    ...options,
    path: options.path || 'mate',
  });
  return next;
}
