import { parseStudioExpression } from './studio-expression.js';
import { createStudioProjectBundleManifest, StudioProjectBundleError } from './studio-project-bundle.js';
import {
  STUDIO_PART_CONFIGURATION_ERROR_CODES,
  StudioPartConfigurationError,
  normalizeStudioPartConfigurationSet,
} from './studio-part-configurations.js';
import {
  STUDIO_V5_FEATURE_INPUT_ERROR_CODES,
  assertStudioV5FeatureStructure,
  isStudioV5FeatureResultPolicy,
  isStudioV5FeatureType,
  studioV5FeatureContract,
} from './studio-v5-feature-types.js';
import {
  STUDIO_CONSTRAINED_2D_ROLE,
  assertStudioSketchInstancesPart,
} from './studio-sketch-instances.js';
import {
  STUDIO_VARIABLE_PATTERN_DIMENSION_FIELDS,
  STUDIO_VARIABLE_PATTERN_MAX_GENERATED,
  STUDIO_VARIABLE_PATTERN_MAX_PARAMETERS,
  studioFillPatternLattice,
} from './studio-advanced-patterns.js';
import { assertStudioStructuralMemberPart } from './studio-structural-members.js';
import { assertStudioWeldmentTreatmentPart } from './studio-structural-treatments.js';
import { assertStudioWeldBeadPart } from './studio-weld-beads.js';
import { assertStudioDirectEditPart } from './studio-direct-edit.js';
import { assertStudioSheetMetalBendTable, assertStudioSheetMetalPart } from './studio-sheet-metal.js';
import {
  assertStudioSmartFastenersProject,
  StudioSmartFastenerError,
} from './studio-smart-fasteners.js';
import {
  assertStudioAssemblyFeaturesProject,
  StudioAssemblyFeatureError,
} from './studio-assembly-features.js';
import {
  STUDIO_ADVANCED_MATE_KINDS,
  StudioAdvancedMateError,
  assertStudioAdvancedMateRecord,
  hasStudioAdvancedMateContract,
  isStudioAdvancedMateKind,
} from './studio-advanced-mates.js';
import {
  STUDIO_MECHANICAL_MATE_KINDS,
  StudioMechanicalMateError,
  assertStudioMechanicalMateRecord,
  hasStudioMechanicalMateContract,
  isStudioMechanicalMateKind,
} from './studio-mechanical-mates.js';
import { studioSha256BytesHex } from './studio-sha256.js';

// Canonical schema-5 project boundary. Slice 5A-runtime now uses this boundary
// for production multi-body part documents; later slices will consume the same
// envelope for assembly and advanced-modeling behavior.

export const STUDIO_V5_SCHEMA_VERSION = 5;

export const STUDIO_STEP_HEALING_SCHEMA = 'partmode.step-healing/v1';

export const STUDIO_STEP_HEALING_LIMITS = Object.freeze({
  sourceBytes: 50 * 1024 * 1024,
  toleranceMm: 0.05,
  attempts: 16,
  candidates: 5000,
  actions: 64,
  defects: 64,
  topologyCount: 10_000_000,
});

export const STUDIO_V5_PROJECT_LIMITS = Object.freeze({
  bytes: 20 * 1024 * 1024,
  // 20 MiB document + up to 100 MiB decoded resources at base64 expansion,
  // rounded up so parsing is bounded before JSON is allocated.
  fileBytes: 160 * 1024 * 1024,
  resourcesBytes: 100 * 1024 * 1024,
  partDefinitions: 250,
  assemblyDefinitions: 250,
  occurrences: 2000,
  generatedOccurrences: 5000,
  featuresPerPart: 2000,
  sketchEntities: 25000,
  parameters: 5000,
  materials: 1000,
  resources: 1000,
  treeDepth: 100,
});

export const STUDIO_V5_IDENTITY_MATRIX = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOCUMENT_KINDS = new Set(['part', 'assembly']);
const BODY_KINDS = new Set(['solid', 'surface']);
const OWNER_KINDS = new Set(['part', 'body', 'feature', 'datum', 'sketch', 'occurrence']);
const RESULT_KINDS = new Set(['new-body', 'add', 'subtract', 'intersect', 'surface']);
const REFERENCE_KINDS = new Set(['plane', 'axis', 'point', 'coordinate-system']);
const MATE_KINDS = new Set([
  'fixed',
  'coincident',
  'concentric',
  'distance',
  'angle',
  'parallel',
  'perpendicular',
  'tangent',
  'revolute',
  'slider',
  ...STUDIO_ADVANCED_MATE_KINDS,
  ...STUDIO_MECHANICAL_MATE_KINDS,
]);
const PATTERN_KINDS = new Set(['linear', 'circular', 'curve']);
const BODY_PATTERN_KINDS = new Set(['linear', 'circular', 'curve', 'mirror', 'sketch', 'fill', 'variable']);
const SECTION_KINDS = new Set(['plane', 'quarter', 'box']);
const RESOURCE_MIME_TYPES = new Set(['text/plain', 'text/csv', 'application/dxf', 'application/step', 'model/step', 'image/svg+xml']);
const STEP_HEALING_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STEP_HEALING_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
const STEP_HEALING_BOUNDS_EPSILON_MM = 1e-9;
const STEP_HEALING_RELATIVE_VOLUME_FLOOR_MM3 = 1e-8;
const STEP_HEALING_FIELDS = Object.freeze([
  'schema',
  'status',
  'sourceSha256',
  'sourceByteLength',
  'healedBrepSha256',
  'applied',
  'selectedToleranceMm',
  'policy',
  'attempts',
  'defects',
  'actions',
  'pre',
  'post',
  'drift',
]);
const STEP_HEALING_POLICY_FIELDS = Object.freeze([
  'name',
  'maxToleranceMm',
  'maxAttempts',
  'maxCandidates',
  'maxActions',
]);
const STEP_HEALING_ATTEMPT_FIELDS = Object.freeze([
  'index',
  'action',
  'toleranceMm',
  'applied',
  'before',
  'after',
]);
const STEP_HEALING_ACTION_FIELDS = Object.freeze([
  'action',
  'toleranceMm',
]);
const STEP_HEALING_METRIC_FIELDS = Object.freeze([
  'brepValid',
  'solidCount',
  'shellCount',
  'faceCount',
  'edgeCount',
  'vertexCount',
  'freeEdgeCount',
  'multipleEdgeCount',
  'volumeMm3',
  'boundsMm',
]);
const STEP_HEALING_DRIFT_FIELDS = Object.freeze([
  'maxBoundsDeltaMm',
  'absoluteVolumeDeltaMm3',
  'relativeVolumeDelta',
]);

export class StudioV5ProjectError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StudioV5ProjectError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new StudioV5ProjectError(code, message);
};

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJsonTree(value, path = 'project', stack = new Set(), depth = 0) {
  if (depth > STUDIO_V5_PROJECT_LIMITS.treeDepth) fail('LIMIT_DEPTH', path + ' exceeds the maximum nesting depth.');
  if (value == null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_NUMBER', path + ' must contain only finite numbers.');
    return;
  }
  if (typeof value !== 'object') fail('INVALID_VALUE', path + ' contains a non-JSON value.');
  if (stack.has(value)) fail('CYCLIC_OBJECT', path + ' contains a cyclic object reference.');
  if (!Array.isArray(value) && !isRecord(value)) fail('INVALID_VALUE', path + ' must contain only JSON objects and arrays.');
  stack.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonTree(item, path + '[' + index + ']', stack, depth + 1));
  } else {
    for (const [key, item] of Object.entries(value)) validateJsonTree(item, path + '.' + key, stack, depth + 1);
  }
  stack.delete(value);
}

function utf8Bytes(text, stopAfter = Number.POSITIVE_INFINITY) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const trail = text.charCodeAt(index + 1);
      if (trail >= 0xdc00 && trail <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

function jsonBytes(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    fail('CYCLIC_OBJECT', 'Project contains a cyclic object reference.');
  }
  return utf8Bytes(text);
}

function documentBytesWithoutEmbeddedResources(value) {
  if (!isRecord(value) || !Array.isArray(value.resources)) return jsonBytes(value);
  const resources = value.resources.map((resource) => {
    if (!isRecord(resource) || resource.data == null) return resource;
    const { data: _data, ...metadata } = resource;
    return metadata;
  });
  return jsonBytes({ ...value, resources });
}

function clone(value) {
  return structuredClone(value);
}

function requireRecord(value, path) {
  if (!isRecord(value)) fail('INVALID_RECORD', path + ' must be an object.');
  return value;
}

function requireArray(value, path, limit, code = 'LIMIT_ITEMS') {
  if (!Array.isArray(value)) fail('INVALID_ARRAY', path + ' must be an array.');
  if (value.length > limit) fail(code, path + ' exceeds its ' + limit.toLocaleString('en-US') + '-item limit.');
  return value;
}

function requireId(value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('INVALID_ID', path + ' must be a non-empty stable ID using letters, numbers, dot, underscore, colon, or hyphen.');
  }
  return value;
}

function requireName(value, path) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) fail('INVALID_NAME', path + ' must be a non-empty name of at most 200 characters.');
  return value.trim();
}

function requireBoolean(value, path) {
  if (typeof value !== 'boolean') fail('INVALID_BOOLEAN', path + ' must be true or false.');
  return value;
}

function validateOptionalRecord(value, path) {
  if (value != null) requireRecord(value, path);
}

function validateOptionalText(value, path, maximum = 2000) {
  if (value != null && (typeof value !== 'string' || value.length > maximum)) {
    fail('INVALID_TEXT', path + ' must be text of at most ' + maximum.toLocaleString('en-US') + ' characters.');
  }
}

function requireInteger(value, path, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail('INVALID_INTEGER', path + ' must be an integer from ' + minimum + ' to ' + maximum + '.');
  }
  return value;
}

function failStepHealing(path, message) {
  fail('INVALID_STEP_HEALING_EVIDENCE', path + ' ' + message);
}

function requireExactStepHealingRecord(value, path, fields) {
  if (!isRecord(value)) failStepHealing(path, 'must be an object.');
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) failStepHealing(path, 'contains unsupported field "' + field + '".');
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) failStepHealing(path, 'is missing required field "' + field + '".');
  }
  return value;
}

function requireStepHealingNumber(value, path, { positive = false } = {}) {
  if (!Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    failStepHealing(path, 'must be a ' + (positive ? 'positive' : 'non-negative') + ' finite number.');
  }
  return value;
}

function requireStepHealingInteger(value, path, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    failStepHealing(path, 'must be an exact integer from ' + minimum + ' to ' + maximum + '.');
  }
  return value;
}

function requireStepHealingToken(value, path) {
  if (typeof value !== 'string' || !STEP_HEALING_TOKEN_PATTERN.test(value)) {
    failStepHealing(path, 'must be a lowercase stable token of at most 100 characters.');
  }
  return value;
}

function requireStepHealingActionName(value, path) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 100) {
    failStepHealing(path, 'must be non-empty text of at most 100 characters without outer whitespace.');
  }
  return value;
}

function validateStepHealingTokenArray(value, path, limit) {
  if (!Array.isArray(value)) failStepHealing(path, 'must be an array.');
  if (value.length > limit) failStepHealing(path, 'exceeds its ' + limit + '-item limit.');
  const seen = new Set();
  value.forEach((entry, index) => {
    const token = requireStepHealingToken(entry, path + '[' + index + ']');
    if (seen.has(token)) failStepHealing(path, 'repeats token "' + token + '".');
    seen.add(token);
  });
  return value;
}

function validateStepHealingActions(value, path, policy) {
  if (!Array.isArray(value)) failStepHealing(path, 'must be an array.');
  if (value.length > policy.maxActions) failStepHealing(path, 'exceeds the declared policy action limit.');
  return value.map((entry, index) => {
    const actionPath = path + '[' + index + ']';
    const action = requireExactStepHealingRecord(entry, actionPath, STEP_HEALING_ACTION_FIELDS);
    requireStepHealingActionName(action.action, actionPath + '.action');
    requireStepHealingNumber(action.toleranceMm, actionPath + '.toleranceMm');
    if (action.toleranceMm > policy.maxToleranceMm) {
      failStepHealing(actionPath + '.toleranceMm', 'must not exceed policy.maxToleranceMm.');
    }
    return action;
  });
}

function validateStepHealingBounds(value, path) {
  if (!Array.isArray(value) || value.length !== 2) failStepHealing(path, 'must contain exact minimum and maximum coordinate triples.');
  const bounds = value.map((corner, cornerIndex) => {
    if (!Array.isArray(corner) || corner.length !== 3) failStepHealing(path + '[' + cornerIndex + ']', 'must contain exactly three coordinates.');
    return corner.map((coordinate, axis) => {
      if (!Number.isFinite(coordinate)) failStepHealing(path + '[' + cornerIndex + '][' + axis + ']', 'must be finite.');
      return coordinate;
    });
  });
  for (let axis = 0; axis < 3; axis++) {
    if (bounds[0][axis] > bounds[1][axis]) failStepHealing(path, 'minimum coordinates must not exceed maximum coordinates.');
  }
  return value;
}

function validateStepHealingMetrics(value, path) {
  const metrics = requireExactStepHealingRecord(value, path, STEP_HEALING_METRIC_FIELDS);
  if (typeof metrics.brepValid !== 'boolean') failStepHealing(path + '.brepValid', 'must be true or false.');
  for (const field of [
    'solidCount',
    'shellCount',
    'faceCount',
    'edgeCount',
    'vertexCount',
    'freeEdgeCount',
    'multipleEdgeCount',
  ]) {
    requireStepHealingInteger(metrics[field], path + '.' + field, 0, STUDIO_STEP_HEALING_LIMITS.topologyCount);
  }
  if (metrics.solidCount > metrics.shellCount) failStepHealing(path, 'solidCount must not exceed shellCount.');
  if (metrics.freeEdgeCount > metrics.edgeCount) failStepHealing(path, 'freeEdgeCount must not exceed edgeCount.');
  if (metrics.multipleEdgeCount > metrics.edgeCount) failStepHealing(path, 'multipleEdgeCount must not exceed edgeCount.');
  requireStepHealingNumber(metrics.volumeMm3, path + '.volumeMm3');
  validateStepHealingBounds(metrics.boundsMm, path + '.boundsMm');
  return metrics;
}

function validateStepHealingPolicy(value, path) {
  const policy = requireExactStepHealingRecord(value, path, STEP_HEALING_POLICY_FIELDS);
  requireStepHealingToken(policy.name, path + '.name');
  requireStepHealingNumber(policy.maxToleranceMm, path + '.maxToleranceMm', { positive: true });
  if (policy.maxToleranceMm > STUDIO_STEP_HEALING_LIMITS.toleranceMm) {
    failStepHealing(path + '.maxToleranceMm', 'must not exceed the 0.05 mm document safety ceiling.');
  }
  requireStepHealingInteger(policy.maxAttempts, path + '.maxAttempts', 1, STUDIO_STEP_HEALING_LIMITS.attempts);
  requireStepHealingInteger(policy.maxCandidates, path + '.maxCandidates', 1, STUDIO_STEP_HEALING_LIMITS.candidates);
  requireStepHealingInteger(policy.maxActions, path + '.maxActions', 1, STUDIO_STEP_HEALING_LIMITS.actions);
  return policy;
}

function validateStepHealingDrift(value, path) {
  const drift = requireExactStepHealingRecord(value, path, STEP_HEALING_DRIFT_FIELDS);
  STEP_HEALING_DRIFT_FIELDS.forEach((field) => requireStepHealingNumber(drift[field], path + '.' + field));
  return drift;
}

function expectedStepHealingDrift(pre, post) {
  const maxBoundsDeltaMm = Math.max(...pre.boundsMm.flatMap((corner, side) =>
    corner.map((coordinate, axis) => Math.abs(post.boundsMm[side][axis] - coordinate))));
  const absoluteVolumeDeltaMm3 = Math.abs(post.volumeMm3 - pre.volumeMm3);
  // Use the larger volume magnitude as the relative denominator. This keeps a
  // transition between a zero-volume face/shell candidate and a positive solid
  // finite and symmetric; the floor only defines the both-zero case.
  const relativeVolumeDenominatorMm3 = Math.max(
    Math.abs(pre.volumeMm3),
    Math.abs(post.volumeMm3),
    STEP_HEALING_RELATIVE_VOLUME_FLOOR_MM3,
  );
  return {
    maxBoundsDeltaMm,
    absoluteVolumeDeltaMm3,
    relativeVolumeDelta: absoluteVolumeDeltaMm3 / relativeVolumeDenominatorMm3,
  };
}

function validateStepHealingDriftClaims(drift, pre, post, selectedToleranceMm, path) {
  const expected = expectedStepHealingDrift(pre, post);
  for (const field of STEP_HEALING_DRIFT_FIELDS) {
    if (drift[field] !== expected[field]) {
      failStepHealing(
        path + '.' + field,
        'must exactly equal the value recomputed from pre and post metrics (' + expected[field] + ').',
      );
    }
  }
  if (drift.maxBoundsDeltaMm > selectedToleranceMm + STEP_HEALING_BOUNDS_EPSILON_MM) {
    failStepHealing(
      path + '.maxBoundsDeltaMm',
      'must not exceed selectedToleranceMm plus the 1e-9 mm numerical epsilon.',
    );
  }
}

function validateStepHealingEvidence(value, path) {
  const healing = requireExactStepHealingRecord(value, path, STEP_HEALING_FIELDS);
  if (healing.schema !== STUDIO_STEP_HEALING_SCHEMA) {
    failStepHealing(path + '.schema', 'must be exactly "' + STUDIO_STEP_HEALING_SCHEMA + '".');
  }
  if (healing.status !== 'unchanged' && healing.status !== 'healed') {
    failStepHealing(path + '.status', 'must be unchanged or healed.');
  }
  for (const field of ['sourceSha256', 'healedBrepSha256']) {
    if (typeof healing[field] !== 'string' || !STEP_HEALING_SHA256_PATTERN.test(healing[field])) {
      failStepHealing(path + '.' + field, 'must be a lowercase 64-hex SHA-256 digest.');
    }
  }
  requireStepHealingInteger(healing.sourceByteLength, path + '.sourceByteLength', 0, STUDIO_STEP_HEALING_LIMITS.sourceBytes);
  if (typeof healing.applied !== 'boolean') failStepHealing(path + '.applied', 'must be true or false.');
  requireStepHealingNumber(healing.selectedToleranceMm, path + '.selectedToleranceMm');

  const policy = validateStepHealingPolicy(healing.policy, path + '.policy');
  if (healing.selectedToleranceMm > policy.maxToleranceMm) {
    failStepHealing(path + '.selectedToleranceMm', 'must not exceed policy.maxToleranceMm.');
  }
  const defects = validateStepHealingTokenArray(healing.defects, path + '.defects', STUDIO_STEP_HEALING_LIMITS.defects);
  const actions = validateStepHealingActions(healing.actions, path + '.actions', policy);
  const pre = validateStepHealingMetrics(healing.pre, path + '.pre');
  const post = validateStepHealingMetrics(healing.post, path + '.post');
  const drift = validateStepHealingDrift(healing.drift, path + '.drift');
  validateStepHealingDriftClaims(
    drift,
    pre,
    post,
    healing.selectedToleranceMm,
    path + '.drift',
  );

  if (!Array.isArray(healing.attempts)) failStepHealing(path + '.attempts', 'must be an array.');
  if (healing.attempts.length > policy.maxAttempts || healing.attempts.length > policy.maxActions) {
    failStepHealing(path + '.attempts', 'exceeds the declared policy attempt/action limit.');
  }
  const attempts = healing.attempts.map((value, index) => {
    const attemptPath = path + '.attempts[' + index + ']';
    const attempt = requireExactStepHealingRecord(value, attemptPath, STEP_HEALING_ATTEMPT_FIELDS);
    requireStepHealingInteger(attempt.index, attemptPath + '.index', 1, policy.maxAttempts);
    if (attempt.index !== index + 1) failStepHealing(attemptPath + '.index', 'must use contiguous one-based attempt order.');
    requireStepHealingActionName(attempt.action, attemptPath + '.action');
    requireStepHealingNumber(attempt.toleranceMm, attemptPath + '.toleranceMm');
    if (attempt.toleranceMm > policy.maxToleranceMm) failStepHealing(attemptPath + '.toleranceMm', 'must not exceed policy.maxToleranceMm.');
    if (typeof attempt.applied !== 'boolean') failStepHealing(attemptPath + '.applied', 'must be true or false.');
    const before = validateStepHealingMetrics(attempt.before, attemptPath + '.before');
    const after = validateStepHealingMetrics(attempt.after, attemptPath + '.after');
    if (stableStringify(before) !== stableStringify(pre)) {
      failStepHealing(attemptPath + '.before', 'must equal the top-level pre metrics because every attempt starts from the imported root.');
    }
    return attempt;
  });

  if (post.brepValid !== true || post.solidCount !== 1 || post.shellCount !== 1 || post.volumeMm3 <= 0
      || post.freeEdgeCount !== 0 || post.multipleEdgeCount !== 0) {
    failStepHealing(path + '.post', 'must prove exactly one positive, B-rep-valid solid and shell with no free or multiple edges.');
  }
  if (post.faceCount !== pre.faceCount) {
    failStepHealing(path + '.post.faceCount', 'must equal pre.faceCount so healing cannot delete or add faces.');
  }

  if (healing.status === 'unchanged') {
    if (healing.applied !== false || healing.selectedToleranceMm !== 0) {
      failStepHealing(path, 'unchanged evidence requires applied false and selectedToleranceMm 0.');
    }
    if (attempts.length || defects.length || actions.length) {
      failStepHealing(path, 'unchanged evidence cannot contain attempts, defects, or actions.');
    }
    if (stableStringify(pre) !== stableStringify(post)) failStepHealing(path, 'unchanged evidence requires identical pre and post metrics.');
    if (STEP_HEALING_DRIFT_FIELDS.some((field) => drift[field] !== 0)) {
      failStepHealing(path + '.drift', 'must be exactly zero for unchanged geometry.');
    }
  } else {
    if (healing.applied !== true || !(healing.selectedToleranceMm > 0)) {
      failStepHealing(path, 'healed evidence requires applied true and a positive selectedToleranceMm.');
    }
    if (!attempts.length || !defects.length || !actions.length) {
      failStepHealing(path, 'healed evidence requires at least one attempt, defect, and action.');
    }
    if (pre.brepValid === true && pre.solidCount === 1 && pre.freeEdgeCount === 0 && pre.multipleEdgeCount === 0) {
      failStepHealing(path + '.pre', 'must prove a defect before healing is applied.');
    }
    const finalAttempt = attempts[attempts.length - 1];
    if (finalAttempt.applied !== true) failStepHealing(path + '.attempts', 'must end with an applied attempt.');
    if (finalAttempt.toleranceMm !== healing.selectedToleranceMm) {
      failStepHealing(path + '.selectedToleranceMm', 'must equal the final applied attempt tolerance.');
    }
    if (stableStringify(finalAttempt.after) !== stableStringify(post)) {
      failStepHealing(path + '.post', 'must equal the final applied attempt after metrics.');
    }
    const appliedActions = attempts
      .filter((attempt) => attempt.applied)
      .map((attempt) => ({ action: attempt.action, toleranceMm: attempt.toleranceMm }));
    if (stableStringify(actions) !== stableStringify(appliedActions)) {
      failStepHealing(path + '.actions', 'must exactly list the action and tolerance from each applied attempt in order.');
    }
  }
  return healing;
}

function optionalStepHealingEvidence(extensions, path) {
  const importedStep = extensions?.studioImportedStep;
  if (!isRecord(importedStep) || !Object.prototype.hasOwnProperty.call(importedStep, 'healing')) return null;
  return validateStepHealingEvidence(importedStep.healing, path + '.studioImportedStep.healing');
}

function expressionLike(value) {
  return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim().length > 0 && value.length <= 500);
}

function parseSafeExpression(value, path, allowedNames) {
  if (!expressionLike(value)) fail('INVALID_EXPRESSION', path + ' must be a finite number or supported expression.');
  try {
    return parseStudioExpression(value, { path, allowedNames });
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('unknown parameter')) fail('UNKNOWN_PARAMETER', message);
    fail('INVALID_EXPRESSION', message);
  }
}

function addUnique(seen, id, path, scope = 'project') {
  if (seen.has(id)) fail('DUPLICATE_ID', 'Duplicate ' + scope + ' ID "' + id + '" at ' + path + '.');
  seen.add(id);
}

function validateDocumentRef(ref, path) {
  requireRecord(ref, path);
  if (!DOCUMENT_KINDS.has(ref.kind)) fail('INVALID_DOCUMENT_REF', path + '.kind must be part or assembly.');
  if (ref.kind === 'part') requireId(ref.partId, path + '.partId');
  else requireId(ref.assemblyId, path + '.assemblyId');
}

function validateGeometryReference(reference, path) {
  requireRecord(reference, path);
  if (!OWNER_KINDS.has(reference.ownerKind)) fail('INVALID_REFERENCE', path + '.ownerKind is unsupported.');
  requireId(reference.ownerId, path + '.ownerId');
  requireRecord(reference.signature, path + '.signature');
  if (reference.semanticPath != null) requireRecord(reference.semanticPath, path + '.semanticPath');
  if (reference.occurrencePath != null) {
    const occurrencePath = requireArray(reference.occurrencePath, path + '.occurrencePath', STUDIO_V5_PROJECT_LIMITS.occurrences);
    if (occurrencePath.length === 0) fail('INVALID_REFERENCE', path + '.occurrencePath must not be empty when present.');
    const seenOccurrences = new Set();
    occurrencePath.forEach((id, index) => {
      const occurrenceId = requireId(id, path + '.occurrencePath[' + index + ']');
      if (seenOccurrences.has(occurrenceId)) fail('CYCLIC_OCCURRENCE_PATH', path + '.occurrencePath repeats occurrence "' + occurrenceId + '".');
      seenOccurrences.add(occurrenceId);
    });
  }
}

function validatePartReferenceContext(reference, path, partId, bodyIds, featureIds, datumIds, sketchIds) {
  if (reference.occurrencePath?.length) return;
  if (reference.ownerKind === 'part' && reference.ownerId !== partId) {
    fail('MISSING_REFERENCE', path + ' references another part without an occurrence path.');
  }
  if (reference.ownerKind === 'body' && !bodyIds.has(reference.ownerId)) {
    fail('MISSING_REFERENCE', path + ' references a body outside this part without an occurrence path.');
  }
  if (reference.ownerKind === 'feature' && !featureIds.has(reference.ownerId)) {
    fail('MISSING_REFERENCE', path + ' references a feature outside this part without an occurrence path.');
  }
  if (reference.ownerKind === 'datum' && !datumIds.has(reference.ownerId)) {
    fail('MISSING_REFERENCE', path + ' references a datum outside this part without an occurrence path.');
  }
  if (reference.ownerKind === 'sketch' && !sketchIds.has(reference.ownerId)) {
    fail('MISSING_REFERENCE', path + ' references a sketch outside this part without an occurrence path.');
  }
  if (reference.ownerKind === 'occurrence') {
    fail('INVALID_REFERENCE', path + ' must include an occurrence path in a part definition.');
  }
}

function validateParameter(parameter, path, seenIds, seenNames) {
  requireRecord(parameter, path);
  const id = requireId(parameter.id, path + '.id');
  addUnique(seenIds, id, path, 'parameter');
  if (typeof parameter.name !== 'string' || !PARAMETER_NAME_PATTERN.test(parameter.name)) {
    fail('INVALID_PARAMETER', path + '.name must be a valid parameter identifier.');
  }
  if (seenNames.has(parameter.name)) fail('DUPLICATE_PARAMETER', 'Duplicate parameter name "' + parameter.name + '" in one scope.');
  seenNames.add(parameter.name);
  if (!expressionLike(parameter.value)) fail('INVALID_PARAMETER', path + '.value must be a finite number or non-empty expression.');
  validateOptionalText(parameter.description, path + '.description');
  validateOptionalRecord(parameter.extensions, path + '.extensions');
}

function validateParameterArray(parameters, path, counter, globalIds, inheritedValues = new Map()) {
  const entries = requireArray(parameters, path, STUDIO_V5_PROJECT_LIMITS.parameters, 'LIMIT_PARAMETERS');
  counter.count += entries.length;
  if (counter.count > STUDIO_V5_PROJECT_LIMITS.parameters) fail('LIMIT_PARAMETERS', 'Project exceeds the 5,000-parameter limit.');
  const seenNames = new Set();
  entries.forEach((parameter, index) => validateParameter(parameter, path + '[' + index + ']', globalIds, seenNames));
  const allowedNames = new Set([...inheritedValues.keys(), ...seenNames]);
  const parsed = new Map(entries.map((parameter, index) => [
    parameter.name,
    parseSafeExpression(parameter.value, path + '[' + index + '].value', allowedNames),
  ]));
  const dependencies = new Map([...parsed].map(([name, expression]) => [
    name,
    [...expression.dependencies].filter((dependency) => seenNames.has(dependency)),
  ]));
  const visiting = new Set();
  const visited = new Set();
  function visit(name, chain) {
    if (visiting.has(name)) fail('CYCLIC_PARAMETER', path + ' contains a parameter cycle: ' + [...chain, name].join(' -> ') + '.');
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of dependencies.get(name) || []) visit(dependency, [...chain, name]);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of dependencies.keys()) visit(name, []);
  const values = new Map(inheritedValues);
  const evaluating = new Set();
  const resolved = new Set();
  function resolve(name) {
    if (!parsed.has(name)) return inheritedValues.get(name);
    if (resolved.has(name)) return values.get(name);
    if (evaluating.has(name)) fail('CYCLIC_PARAMETER', path + ' contains a parameter cycle while evaluating "' + name + '".');
    evaluating.add(name);
    const value = parsed.get(name).evaluate(resolve);
    evaluating.delete(name);
    values.set(name, value);
    resolved.add(name);
    return value;
  }
  for (const name of parsed.keys()) resolve(name);
  return values;
}

function validateMaterial(material, path, seenIds) {
  requireRecord(material, path);
  const id = requireId(material.id, path + '.id');
  addUnique(seenIds, id, path, 'material');
  requireName(material.name, path + '.name');
  if (material.densityKgM3 != null && (typeof material.densityKgM3 !== 'number' || !Number.isFinite(material.densityKgM3) || material.densityKgM3 <= 0)) {
    fail('INVALID_MATERIAL', path + '.densityKgM3 must be a positive finite number.');
  }
  if (material.appearanceId != null) requireId(material.appearanceId, path + '.appearanceId');
  validateOptionalText(material.description, path + '.description');
  validateOptionalText(material.source, path + '.source');
  validateOptionalRecord(material.extensions, path + '.extensions');
}

function validateFeatureResultPolicy(policy, path) {
  requireRecord(policy, path);
  if (!RESULT_KINDS.has(policy.kind)) fail('INVALID_RESULT_POLICY', path + '.kind is unsupported.');
  if (policy.kind === 'new-body' || policy.kind === 'surface') {
    if (policy.bodyName != null) requireName(policy.bodyName, path + '.bodyName');
    return;
  }
  const targets = requireArray(policy.targetBodyIds, path + '.targetBodyIds', STUDIO_V5_PROJECT_LIMITS.featuresPerPart);
  if (targets.length === 0) fail('INVALID_RESULT_POLICY', path + '.targetBodyIds must contain at least one body.');
  const seen = new Set();
  targets.forEach((id, index) => {
    const bodyId = requireId(id, path + '.targetBodyIds[' + index + ']');
    if (seen.has(bodyId)) fail('DUPLICATE_REFERENCE', path + ' repeats target body "' + bodyId + '".');
    seen.add(bodyId);
  });
  if ((policy.kind === 'subtract' || policy.kind === 'intersect') && policy.keepTools != null) requireBoolean(policy.keepTools, path + '.keepTools');
}

function evaluatedFeatureExpression(value, path, parameterValues) {
  const parsed = parseSafeExpression(value, path, new Set(parameterValues.keys()));
  try {
    return parsed.evaluate((parameterName) => parameterValues.get(parameterName));
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('unknown parameter')) fail('UNKNOWN_PARAMETER', message);
    fail('INVALID_EXPRESSION', message);
  }
}

function validateClassicFeatureProfile(feature, path, parameterValues) {
  const sketch = feature.sketch;
  if (!isRecord(sketch)) return;
  if (sketch.z !== undefined) evaluatedFeatureExpression(sketch.z, path + '.sketch.z', parameterValues);
  if (sketch.shapes !== undefined) {
    const shapes = requireArray(sketch.shapes, path + '.sketch.shapes', STUDIO_V5_PROJECT_LIMITS.sketchEntities);
    if (!shapes.length) fail('INVALID_SKETCH', path + '.sketch.shapes must contain at least one closed profile.');
    shapes.forEach((shape, index) => {
      const shapePath = path + '.sketch.shapes[' + index + ']';
      requireRecord(shape, shapePath);
      if (shape.kind === 'rect') {
        evaluatedFeatureExpression(shape.x, shapePath + '.x', parameterValues);
        evaluatedFeatureExpression(shape.y, shapePath + '.y', parameterValues);
        const width = evaluatedFeatureExpression(shape.w, shapePath + '.w', parameterValues);
        const height = evaluatedFeatureExpression(shape.h, shapePath + '.h', parameterValues);
        if (!(width > 0) || !(height > 0)) {
          fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.profileDimension, shapePath + ' width and height must evaluate above zero.');
        }
      } else if (shape.kind === 'circle') {
        evaluatedFeatureExpression(shape.x, shapePath + '.x', parameterValues);
        evaluatedFeatureExpression(shape.y, shapePath + '.y', parameterValues);
        if (!(evaluatedFeatureExpression(shape.r, shapePath + '.r', parameterValues) > 0)) {
          fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.profileDimension, shapePath + '.r must evaluate above zero.');
        }
      } else if (shape.kind === 'poly') {
        const points = requireArray(shape.pts, shapePath + '.pts', STUDIO_V5_PROJECT_LIMITS.sketchEntities);
        if (points.length < 3) fail('INVALID_SKETCH', shapePath + '.pts must contain at least three points.');
        points.forEach((point, pointIndex) => {
          const pointPath = shapePath + '.pts[' + pointIndex + ']';
          const coordinates = requireArray(point, pointPath, 2);
          if (coordinates.length !== 2) fail('INVALID_SKETCH', pointPath + ' must contain exactly two coordinates.');
          coordinates.forEach((coordinate, coordinateIndex) => evaluatedFeatureExpression(coordinate, pointPath + '[' + coordinateIndex + ']', parameterValues));
        });
      } else fail('INVALID_SKETCH', shapePath + '.kind is unsupported.');
    });
  }
  for (const [index, entity] of (sketch.entities || []).entries()) {
    if (entity?.kind === 'circle') {
      const radius = evaluatedFeatureExpression(entity.radius, path + '.sketch.entities[' + index + '].radius', parameterValues);
      if (!(radius > 0)) fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.profileDimension, path + '.sketch.entities[' + index + '].radius must evaluate above zero.');
    }
  }
}

function validateFeatureDomains(feature, path, parameterValues) {
  if (feature.type === 'extrude' || feature.type === 'cut' || feature.type === 'revolve') {
    validateClassicFeatureProfile(feature, path, parameterValues);
  }
  if (feature.type === 'extrude' || (feature.type === 'cut' && !feature.through)) {
    if (!(evaluatedFeatureExpression(feature.h, path + '.h', parameterValues) > 0)) {
      fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.extrusionDepth, path + '.h must evaluate above zero.');
    }
  }
  if (feature.pattern) {
    const count = evaluatedFeatureExpression(feature.pattern.n, path + '.pattern.n', parameterValues);
    if (!Number.isInteger(count) || count < 2 || count > 100) {
      fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.sketchPatternCount, path + '.pattern.n must evaluate to an integer from 2 to 100.');
    }
    const coordinates = feature.pattern.kind === 'linear' ? ['dx', 'dy'] : ['cx', 'cy'];
    coordinates.forEach((key) => evaluatedFeatureExpression(feature.pattern[key], path + '.pattern.' + key, parameterValues));
  }
  if (feature.type === 'fillet' || feature.type === 'chamfer') {
    if (!(evaluatedFeatureExpression(feature.r, path + '.r', parameterValues) > 0)) {
      fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.modifierRadius, path + '.r must evaluate above zero.');
    }
    for (const [index, entry] of (feature.variableRadii || []).entries()) {
      const start = evaluatedFeatureExpression(entry.startRadius, path + '.variableRadii[' + index + '].startRadius', parameterValues);
      const end = evaluatedFeatureExpression(entry.endRadius, path + '.variableRadii[' + index + '].endRadius', parameterValues);
      if (!(start > 0) || !(end > 0)) {
        fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.modifierRadius, path + '.variableRadii[' + index + '] radii must evaluate above zero.');
      }
    }
  }
  if (feature.type === 'shell' && !(evaluatedFeatureExpression(feature.t, path + '.t', parameterValues) > 0)) {
    fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.shellThickness, path + '.t must evaluate above zero.');
  }
  if (feature.type === 'sweep' && !(evaluatedFeatureExpression(feature.scaleEnd, path + '.scaleEnd', parameterValues) > 0)) {
    fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.sweepScale, path + '.scaleEnd must evaluate above zero.');
  }
  if (feature.type === 'sweep') {
    const twist = evaluatedFeatureExpression(feature.twistAngle, path + '.twistAngle', parameterValues);
    const direction = feature.referenceDirection.map((value, index) => evaluatedFeatureExpression(value, path + '.referenceDirection[' + index + ']', parameterValues));
    if ((feature.orientation === 'fixed' || feature.orientation === 'reference') && Math.hypot(...direction) <= 1e-9) {
      fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.sweepDomain, path + '.referenceDirection must be nonzero for ' + feature.orientation + ' orientation.');
    }
    if (feature.orientation !== 'fixed' && feature.orientation !== 'reference') {
      if (Math.hypot(direction[0], direction[1], direction[2] - 1) > 1e-9) {
        fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.sweepDomain, path + '.referenceDirection must remain [0, 0, 1] when the orientation does not use it.');
      }
    }
    if (Math.abs(twist) > 1e-9) {
      fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.sweepDomain, path + '.twistAngle must remain zero because controlled-twist is not available in the exact kernel.');
    }
  }
  if (feature.type === 'revolve') {
    const angleSource = Object.prototype.hasOwnProperty.call(feature, 'angle') ? feature.angle : feature.h;
    const angle = evaluatedFeatureExpression(angleSource, path + '.angle', parameterValues);
    if (!(angle > 0 && angle <= 360)) {
      fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.revolveAngle, path + '.angle must evaluate above zero and at most 360 degrees.');
    }
    if (feature.startAngle !== undefined) {
      const startAngle = evaluatedFeatureExpression(feature.startAngle, path + '.startAngle', parameterValues);
      if (feature.symmetric === true && Math.abs(startAngle + angle / 2) > Math.max(1, Math.abs(angle)) * 1e-9) {
        fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.revolveAngle, path + '.startAngle must equal -angle/2 when symmetric is true.');
      }
    }
  }
  if (feature.type === 'draft') {
    const angle = evaluatedFeatureExpression(feature.angle, path + '.angle', parameterValues);
    if (!(Math.abs(angle) > 1e-6 && Math.abs(angle) < 89)) {
      fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.draftAngle, path + '.angle must be nonzero and stay between -89 and 89 degrees.');
    }
  }
  if (feature.type === 'thicken' && !(evaluatedFeatureExpression(feature.thickness, path + '.thickness', parameterValues) > 0)) {
    fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.thickenThickness, path + '.thickness must evaluate above zero.');
  }
  if (feature.type === 'transform') {
    const transform = feature.transform;
    const evaluateVector = (value, suffix) => value.map((entry, index) => evaluatedFeatureExpression(entry, path + '.transform.' + suffix + '[' + index + ']', parameterValues));
    if (['move', 'translate', 'copy'].includes(transform.mode)) evaluateVector(transform.translation, 'translation');
    else if (transform.mode === 'rotate') {
      evaluatedFeatureExpression(transform.angle, path + '.transform.angle', parameterValues);
      if (transform.direction) {
        const direction = evaluateVector(transform.direction, 'direction');
        if (Math.hypot(...direction) <= 1e-9) fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.transformDomain, path + '.transform.direction must be nonzero.');
      }
      if (transform.origin) evaluateVector(transform.origin, 'origin');
    } else if (transform.mode === 'scale') {
      const factor = evaluatedFeatureExpression(transform.factor, path + '.transform.factor', parameterValues);
      if (!(factor > 0)) fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.transformDomain, path + '.transform.factor must evaluate above zero.');
      evaluateVector(transform.center, 'center');
    } else if (transform.mode === 'mirror') {
      if (transform.normal) {
        const normal = evaluateVector(transform.normal, 'normal');
        if (Math.hypot(...normal) <= 1e-9) fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.transformDomain, path + '.transform.normal must be nonzero.');
      }
      if (transform.origin) evaluateVector(transform.origin, 'origin');
    } else if (transform.mode === 'align') {
      evaluatedFeatureExpression(transform.offset, path + '.transform.offset', parameterValues);
    }
  }
}

function validateFeature(feature, path, seenIds, globalIds, parameterValues) {
  requireRecord(feature, path);
  const id = requireId(feature.id, path + '.id');
  addUnique(seenIds, id, path, 'feature');
  addUnique(globalIds, id, path, 'project feature');
  requireName(feature.name, path + '.name');
  if (typeof feature.type !== 'string' || !feature.type.trim() || feature.type.length > 100) fail('INVALID_FEATURE', path + '.type is required.');
  if (!isStudioV5FeatureType(feature.type)) fail('INVALID_FEATURE', path + '.type is unsupported by schema 5.');
  requireBoolean(feature.suppressed, path + '.suppressed');
  requireArray(feature.inputRefs, path + '.inputRefs', STUDIO_V5_PROJECT_LIMITS.featuresPerPart)
    .forEach((reference, index) => validateGeometryReference(reference, path + '.inputRefs[' + index + ']'));
  validateFeatureResultPolicy(feature.resultPolicy, path + '.resultPolicy');
  if (feature.sketch?.constrained !== undefined) {
    const constrained = requireRecord(feature.sketch.constrained, path + '.sketch.constrained');
    for (const field of Object.keys(constrained)) {
      if (!['entities', 'constraints'].includes(field)) {
        fail('INVALID_FEATURE', path + '.sketch.constrained contains unsupported inline field "' + field + '".');
      }
    }
  }
  if (!isStudioV5FeatureResultPolicy(feature.type, feature.resultPolicy.kind)) {
    fail(
      'INVALID_FEATURE',
      path + ' feature type "' + feature.type + '" cannot use result policy "'
        + feature.resultPolicy.kind + '".',
    );
  }
  try {
    assertStudioV5FeatureStructure(feature, path);
  } catch (error) {
    fail(error?.code || STUDIO_V5_FEATURE_INPUT_ERROR_CODES.structure, String(error?.message || error));
  }
  validateFeatureDomains(feature, path, parameterValues);
  const featureContract = studioV5FeatureContract(feature.type);
  if (
    (featureContract.execution === 'body-modifier' || feature.type === 'cut')
    && feature.resultPolicy.targetBodyIds.length !== 1
  ) {
    fail('INVALID_FEATURE', path + ' must target exactly one body.');
  }
  const contextualFields = [
    ['sketch', new Set(['extrude', 'cut', 'revolve'])],
    ['pattern', new Set(['extrude', 'cut'])],
    ['onFace', new Set(['extrude', 'cut'])],
    ['profileSketchId', new Set(['revolve', 'sweep'])],
    ['pathSketchId', new Set(['sweep'])],
    ['guideSketchId', new Set(['sweep'])],
    ['sections', new Set(['loft'])],
    ['guideSketchIds', new Set(['loft'])],
    ['centerlineSketchId', new Set(['loft'])],
    ['axisDatumId', new Set(['revolve'])],
    ['neutralPlaneDatumId', new Set(['draft'])],
    ['edges', new Set(['fillet', 'chamfer'])],
    ['faces', new Set(['draft', 'fillet', 'shell', 'thicken'])],
    ['sourceBodyId', new Set(['boolean-split-side', 'direct-edit', 'thicken', 'transform'])],
    ['targetBodyId', new Set(['direct-edit'])],
    ['targetFace', new Set(['direct-edit'])],
    ['replacementBodyId', new Set(['direct-edit'])],
    ['replacementFace', new Set(['direct-edit'])],
    ['patchFace', new Set(['direct-edit'])],
    ['distance', new Set(['direct-edit'])],
    ['toolBodyIds', new Set(['boolean', 'boolean-split-side', 'thicken', 'transform'])],
    ['transform', new Set(['transform'])],
    ['variableRadii', new Set(['fillet'])],
    ['operation', new Set(['boolean', 'direct-edit', 'transform'])],
    ['thickness', new Set(['thicken'])],
    ['r', new Set(['fillet', 'chamfer'])],
    ['t', new Set(['shell'])],
    ['h', new Set(['extrude', 'cut', 'revolve'])],
    ['through', new Set(['extrude', 'cut'])],
    ['plane', new Set(['extrude', 'cut', 'revolve'])],
    ['reversed', new Set(['extrude', 'cut', 'revolve'])],
    ['symmetric', new Set(['extrude', 'cut', 'revolve', 'thicken'])],
    ['angle', new Set(['draft', 'revolve'])],
    ['startAngle', new Set(['revolve'])],
    ['side', new Set(['boolean-split-side'])],
    ['keepTools', new Set(['boolean-split-side'])],
    ['operationId', new Set(['boolean-split-side'])],
    ['mapping', new Set(['loft'])],
    ['continuity', new Set(['loft'])],
    ['ruled', new Set(['loft'])],
    ['closed', new Set(['loft'])],
    ['orientation', new Set(['sweep'])],
    ['referenceDirection', new Set(['sweep'])],
    ['twistAngle', new Set(['sweep'])],
    ['scaleEnd', new Set(['sweep'])],
    ['transition', new Set(['sweep'])],
    ['linked', new Set(['thicken', 'transform'])],
    ['flip', new Set(['draft', 'thicken'])],
    ['tangentPropagation', new Set(['draft', 'fillet'])],
    ['sketchId', new Set(['extrude', 'cut', 'revolve'])],
    ['createdBodyId', new Set([
      'boolean-split-side', 'extrude', 'imported-step', 'loft', 'revolve', 'sheet-metal-flange', 'sweep',
      'thicken', 'transform', 'weld-bead', 'weldment-treatment',
    ])],
  ];
  for (const [field, allowedTypes] of contextualFields) {
    if (feature[field] != null && !allowedTypes.has(feature.type)) {
      fail('INVALID_FEATURE', path + '.' + field + ' is not valid for feature type "' + feature.type + '".');
    }
  }
  validateOptionalRecord(feature.extensions, path + '.extensions');
  optionalStepHealingEvidence(feature.extensions, path + '.extensions');
}

function validateBody(body, path, seenIds, globalIds, featureIds, materialIds) {
  requireRecord(body, path);
  const id = requireId(body.id, path + '.id');
  addUnique(seenIds, id, path, 'body');
  addUnique(globalIds, id, path, 'project body');
  requireName(body.name, path + '.name');
  if (!BODY_KINDS.has(body.kind)) fail('INVALID_BODY', path + '.kind must be solid or surface.');
  const createdBy = requireId(body.createdByFeatureId, path + '.createdByFeatureId');
  if (!featureIds.has(createdBy)) fail('MISSING_REFERENCE', path + '.createdByFeatureId does not resolve in this part.');
  const ordered = requireArray(body.featureIds, path + '.featureIds', STUDIO_V5_PROJECT_LIMITS.featuresPerPart);
  if (ordered.length === 0 || !ordered.includes(createdBy)) fail('INVALID_BODY', path + '.featureIds must include its creating feature.');
  if (ordered[0] !== createdBy) fail('INVALID_BODY', path + '.featureIds must begin with its creating feature.');
  const seenFeatureIds = new Set();
  ordered.forEach((featureId, index) => {
    const idValue = requireId(featureId, path + '.featureIds[' + index + ']');
    if (!featureIds.has(idValue)) fail('MISSING_REFERENCE', path + '.featureIds[' + index + '] does not resolve in this part.');
    if (seenFeatureIds.has(idValue)) fail('DUPLICATE_REFERENCE', path + ' repeats feature "' + idValue + '".');
    seenFeatureIds.add(idValue);
  });
  requireBoolean(body.visible, path + '.visible');
  requireBoolean(body.suppressed, path + '.suppressed');
  if (body.materialId != null) {
    const materialId = requireId(body.materialId, path + '.materialId');
    if (!materialIds.has(materialId)) fail('MISSING_REFERENCE', path + '.materialId does not resolve in project materials.');
  }
  if (body.appearanceId != null) requireId(body.appearanceId, path + '.appearanceId');
  validateOptionalRecord(body.extensions, path + '.extensions');
}

function validatePatternDefinitionKeys(definition, allowed, path) {
  const unexpected = Object.keys(definition).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    fail('INVALID_PATTERN', path + ' contains unsupported fields for this pattern kind: ' + unexpected.join(', ') + '.');
  }
}

function variablePatternConsumedParameterNames(sourceBody, featureById, enabledFeatureIds, parameterNames, dependencyMap, path) {
  const consumed = new Set();
  for (const featureId of sourceBody.featureIds) {
    if (!enabledFeatureIds.has(featureId)) continue;
    const feature = featureById.get(featureId);
    if (!feature || feature.suppressed) continue;
    for (const field of STUDIO_VARIABLE_PATTERN_DIMENSION_FIELDS) {
      const value = feature[field];
      if (value === undefined) continue;
      const visit = (entry, suffix) => {
        if (typeof entry === 'string' || typeof entry === 'number') {
          const parsed = parseSafeExpression(entry, path + '.sourceFeature[' + feature.id + '].' + suffix, parameterNames);
          for (const dependency of parsed.dependencies) consumed.add(dependency);
        } else if (Array.isArray(entry)) {
          entry.forEach((child, index) => visit(child, suffix + '[' + index + ']'));
        } else if (isRecord(entry)) {
          Object.entries(entry).forEach(([key, child]) => visit(child, suffix + '.' + key));
        }
      };
      visit(value, field);
    }
  }
  const visitDependency = (name) => {
    for (const dependency of dependencyMap.get(name) || []) {
      if (consumed.has(dependency)) continue;
      consumed.add(dependency);
      visitDependency(dependency);
    }
  };
  for (const name of [...consumed]) visitDependency(name);
  return consumed;
}

function validateBodyPattern(
  pattern,
  path,
  partId,
  bodyIds,
  featureIds,
  datumIds,
  sketchIds,
  datumKinds,
  sketchRoles,
  sketchById,
  bodyById,
  featureById,
  enabledFeatureIds,
  parameterValues,
  partParameterNames,
  partParameterDependencies,
  seenIds,
  globalIds,
  counters,
) {
  requireRecord(pattern, path);
  const id = requireId(pattern.id, path + '.id');
  addUnique(seenIds, id, path, 'body pattern');
  addUnique(globalIds, id, path, 'project pattern');
  requireName(pattern.name, path + '.name');
  if (!BODY_PATTERN_KINDS.has(pattern.kind)) fail('INVALID_PATTERN', path + '.kind is unsupported.');
  const sourceBodyId = requireId(pattern.sourceBodyId, path + '.sourceBodyId');
  if (!bodyIds.has(sourceBodyId)) fail('MISSING_REFERENCE', path + '.sourceBodyId does not resolve in this part.');
  if (pattern.outputMode !== undefined && pattern.outputMode !== 'linked' && pattern.outputMode !== 'union') {
    fail('INVALID_PATTERN', path + '.outputMode must be linked or union.');
  }
  if (['sketch', 'fill', 'variable'].includes(pattern.kind) && pattern.outputMode !== 'linked') {
    fail('INVALID_PATTERN', path + '.outputMode must be linked for sketch, fill, and variable patterns.');
  }
  const references = requireArray(pattern.references, path + '.references', 4);
  references.forEach((reference, index) => validatePartReferenceContext(
    reference,
    path + '.references[' + index + ']',
    partId,
    bodyIds,
    featureIds,
    datumIds,
    sketchIds,
  ));
  requireRecord(pattern.definition, path + '.definition');
  const expressionValue = (value, suffix) => parseSafeExpression(value, path + '.definition.' + suffix, new Set(parameterValues.keys()))
    .evaluate((parameterName) => parameterValues.get(parameterName));
  let count = null;
  if (pattern.kind !== 'fill') {
    count = expressionValue(pattern.definition.count, 'count');
    if (!Number.isInteger(count) || count < 2 || count > STUDIO_V5_PROJECT_LIMITS.generatedOccurrences) {
      fail('INVALID_PATTERN', path + '.definition.count must evaluate to an integer from 2 to 5,000.');
    }
  }
  let occurrenceCount = count;
  const roles = references.map((reference, index) => {
    if (reference.occurrencePath?.length) fail('INVALID_PATTERN', path + '.references[' + index + '] cannot cross an assembly occurrence.');
    const role = reference.semanticPath?.role;
    if (typeof role !== 'string' || reference.signature?.role !== role) fail('INVALID_PATTERN', path + '.references[' + index + '] must carry one matching semantic role.');
    return role;
  });
  const expectRoles = (expected) => {
    if (roles.length !== expected.length || expected.some((role) => !roles.includes(role)) || new Set(roles).size !== roles.length) {
      fail('INVALID_PATTERN', path + '.references must contain exactly ' + expected.join(' and ') + '.');
    }
  };
  const expectReferenceKinds = (ownerKind, expectedRoles) => {
    expectRoles(expectedRoles);
    references.forEach((reference, index) => {
      if (reference.ownerKind !== ownerKind) fail('INVALID_PATTERN', path + '.references[' + index + '] must reference a ' + ownerKind + '.');
    });
  };
  const referenceForRole = (role) => references.find((reference) => reference.semanticPath?.role === role);
  const validateTable = (values, suffix, tableCount = count) => {
    const entries = requireArray(values, path + '.definition.' + suffix, tableCount - 1);
    if (entries.length !== tableCount - 1) fail('INVALID_PATTERN', path + '.definition.' + suffix + ' must contain one value per generated occurrence in that direction.');
    entries.forEach((value, index) => expressionValue(value, suffix + '[' + index + ']'));
  };
  if (pattern.kind === 'linear') {
    const linearRoles = roles.includes('direction-2') ? ['direction', 'direction-2'] : ['direction'];
    expectReferenceKinds('datum', linearRoles);
    linearRoles.forEach((role) => {
      if (!['axis', 'coordinate-system'].includes(datumKinds.get(referenceForRole(role).ownerId))) fail('INVALID_PATTERN', path + '.references role ' + role + ' must resolve to an axis or coordinate system.');
    });
    if (!['spacing', 'extent', 'table'].includes(pattern.definition.distribution)) fail('INVALID_PATTERN', path + '.definition.distribution is unsupported for a linear pattern.');
    if (!['preserve', 'alternating'].includes(pattern.definition.orientation)) fail('INVALID_PATTERN', path + '.definition.orientation is unsupported for a linear pattern.');
    if (pattern.definition.distribution === 'spacing' && Math.abs(expressionValue(pattern.definition.spacing, 'spacing')) <= 1e-9) fail('INVALID_PATTERN', path + '.definition.spacing must be nonzero.');
    if (pattern.definition.distribution === 'extent' && Math.abs(expressionValue(pattern.definition.extent, 'extent')) <= 1e-9) fail('INVALID_PATTERN', path + '.definition.extent must be nonzero.');
    if (pattern.definition.distribution === 'table') validateTable(pattern.definition.positions, 'positions');
    if (linearRoles.length === 2) {
      const count2 = expressionValue(pattern.definition.count2, 'count2');
      if (!Number.isInteger(count2) || count2 < 2 || count * count2 > STUDIO_V5_PROJECT_LIMITS.generatedOccurrences) {
        fail('INVALID_PATTERN', path + '.definition.count2 must produce from 4 to 5,000 total occurrences.');
      }
      occurrenceCount = count * count2;
      if (!['spacing', 'extent', 'table'].includes(pattern.definition.distribution2)) fail('INVALID_PATTERN', path + '.definition.distribution2 is unsupported for a linear pattern.');
      if (pattern.definition.distribution2 === 'spacing' && Math.abs(expressionValue(pattern.definition.spacing2, 'spacing2')) <= 1e-9) fail('INVALID_PATTERN', path + '.definition.spacing2 must be nonzero.');
      if (pattern.definition.distribution2 === 'extent' && Math.abs(expressionValue(pattern.definition.extent2, 'extent2')) <= 1e-9) fail('INVALID_PATTERN', path + '.definition.extent2 must be nonzero.');
      if (pattern.definition.distribution2 === 'table') validateTable(pattern.definition.positions2, 'positions2', count2);
    }
  } else if (pattern.kind === 'circular') {
    expectReferenceKinds('datum', ['axis']);
    if (!['axis', 'coordinate-system'].includes(datumKinds.get(referenceForRole('axis').ownerId))) fail('INVALID_PATTERN', path + '.references role axis must resolve to an axis or coordinate system.');
    if (!['full', 'spacing', 'extent', 'table'].includes(pattern.definition.distribution)) fail('INVALID_PATTERN', path + '.definition.distribution is unsupported for a circular pattern.');
    if (!['rotate', 'preserve', 'alternating'].includes(pattern.definition.orientation)) fail('INVALID_PATTERN', path + '.definition.orientation is unsupported for a circular pattern.');
    expressionValue(pattern.definition.radialOffset ?? 0, 'radialOffset');
    expressionValue(pattern.definition.axialOffset ?? 0, 'axialOffset');
    if (pattern.definition.distribution === 'spacing' && Math.abs(expressionValue(pattern.definition.spacingAngle, 'spacingAngle')) <= 1e-9) fail('INVALID_PATTERN', path + '.definition.spacingAngle must be nonzero.');
    if (pattern.definition.distribution === 'extent' && Math.abs(expressionValue(pattern.definition.totalAngle, 'totalAngle')) <= 1e-9) fail('INVALID_PATTERN', path + '.definition.totalAngle must be nonzero.');
    if (pattern.definition.distribution === 'table') validateTable(pattern.definition.angles, 'angles');
  } else if (pattern.kind === 'curve') {
    expectReferenceKinds('sketch', ['path']);
    if (sketchRoles.get(referenceForRole('path').ownerId) !== 'path') fail('INVALID_PATTERN', path + '.references role path must resolve to an editable path sketch.');
    if (!['equal', 'spacing', 'extent', 'table'].includes(pattern.definition.distribution)) fail('INVALID_PATTERN', path + '.definition.distribution is unsupported for a curve pattern.');
    if (!['tangent', 'fixed'].includes(pattern.definition.orientation)) fail('INVALID_PATTERN', path + '.definition.orientation is unsupported for a curve pattern.');
    if (pattern.definition.distribution === 'spacing' && expressionValue(pattern.definition.spacing, 'spacing') <= 0) fail('INVALID_PATTERN', path + '.definition.spacing must be positive.');
    if (pattern.definition.distribution === 'extent' && expressionValue(pattern.definition.extent, 'extent') <= 0) fail('INVALID_PATTERN', path + '.definition.extent must be positive.');
    if (pattern.definition.distribution === 'table') {
      validateTable(pattern.definition.parameters, 'parameters');
      pattern.definition.parameters.forEach((value, index) => {
        const parameter = expressionValue(value, 'parameters[' + index + ']');
        if (!(parameter >= 0 && parameter <= 1)) fail('INVALID_PATTERN', path + '.definition.parameters[' + index + '] must evaluate from 0 to 1.');
      });
    }
  } else if (pattern.kind === 'mirror') {
    expectReferenceKinds('datum', ['plane']);
    if (datumKinds.get(referenceForRole('plane').ownerId) !== 'plane') fail('INVALID_PATTERN', path + '.references role plane must resolve to a plane datum.');
    if (count !== 2 || pattern.definition.distribution !== 'mirror' || pattern.definition.orientation !== 'mirror') {
      fail('INVALID_PATTERN', path + '.definition must describe one mirror occurrence.');
    }
  } else if (pattern.kind === 'sketch') {
    validatePatternDefinitionKeys(
      pattern.definition,
      ['count', 'distribution', 'orientation', 'pointIds'],
      path + '.definition',
    );
    expectReferenceKinds('sketch', ['point-sketch']);
    const pointSketchId = referenceForRole('point-sketch').ownerId;
    const sketch = sketchById.get(pointSketchId);
    if (sketchRoles.get(pointSketchId) !== STUDIO_CONSTRAINED_2D_ROLE || !sketch?.constrained || sketch.constrained.derivedFrom) {
      fail('INVALID_PATTERN', path + '.references role point-sketch must resolve to one direct first-class constrained sketch.');
    }
    if (pattern.definition.distribution !== 'points' || pattern.definition.orientation !== 'preserve') {
      fail('INVALID_PATTERN', path + '.definition must describe one preserve-orientation sketch-point pattern.');
    }
    const pointIds = requireArray(
      pattern.definition.pointIds,
      path + '.definition.pointIds',
      STUDIO_V5_PROJECT_LIMITS.generatedOccurrences,
    );
    if (pointIds.length < 2 || pointIds.length !== count) {
      fail('INVALID_PATTERN', path + '.definition.pointIds must contain the seed plus one entry per generated occurrence.');
    }
    const localPoints = new Set((sketch.constrained.entities || [])
      .filter((entity) => entity.kind === 'point')
      .map((entity) => entity.id));
    const seenPoints = new Set();
    pointIds.forEach((pointId, index) => {
      const currentId = requireId(pointId, path + '.definition.pointIds[' + index + ']');
      if (!localPoints.has(currentId)) {
        fail('MISSING_REFERENCE', path + '.definition.pointIds[' + index + '] does not resolve to an authored local point in the point sketch.');
      }
      if (seenPoints.has(currentId)) fail('DUPLICATE_REFERENCE', path + '.definition.pointIds repeats point "' + currentId + '".');
      seenPoints.add(currentId);
    });
  } else if (pattern.kind === 'fill') {
    validatePatternDefinitionKeys(
      pattern.definition,
      ['distribution', 'orientation', 'layout', 'spacing', 'rotation', 'boundaryMargin', 'seed', 'maximumCount'],
      path + '.definition',
    );
    expectReferenceKinds('sketch', ['boundary']);
    const boundarySketchId = referenceForRole('boundary').ownerId;
    const sketch = sketchById.get(boundarySketchId);
    const entity = sketch?.entities?.[0];
    if (sketchRoles.get(boundarySketchId) !== 'profile' || entity?.kind !== 'polyline' || entity.closed !== true) {
      fail('INVALID_PATTERN', path + '.references role boundary must resolve to one closed advanced polyline profile.');
    }
    if (sketch.support?.ownerKind !== 'datum' || datumKinds.get(sketch.support.ownerId) !== 'plane') {
      fail('INVALID_PATTERN', path + '.references role boundary must retain datum-plane support.');
    }
    if (pattern.definition.distribution !== 'fill' || pattern.definition.orientation !== 'preserve') {
      fail('INVALID_PATTERN', path + '.definition must describe one preserve-orientation fill pattern.');
    }
    const maximumCount = pattern.definition.maximumCount;
    if (!Number.isInteger(maximumCount) || maximumCount < 2 || maximumCount > STUDIO_V5_PROJECT_LIMITS.generatedOccurrences) {
      fail('INVALID_PATTERN', path + '.definition.maximumCount must be a literal integer from 2 to 5,000.');
    }
    const seed = requireArray(pattern.definition.seed, path + '.definition.seed', 2);
    if (seed.length !== 2) fail('INVALID_PATTERN', path + '.definition.seed must contain exactly two coordinates.');
    const evaluatedSeed = seed.map((value, index) => expressionValue(value, 'seed[' + index + ']'));
    const boundaryPoints = entity.points.map((point, pointIndex) => point.map((value, coordinateIndex) =>
      parseSafeExpression(
        value,
        path + '.boundary.points[' + pointIndex + '][' + coordinateIndex + ']',
        new Set(parameterValues.keys()),
      ).evaluate((parameterName) => parameterValues.get(parameterName))));
    try {
      studioFillPatternLattice({
        boundaryPoints,
        layout: pattern.definition.layout,
        spacing: expressionValue(pattern.definition.spacing, 'spacing'),
        rotationDegrees: expressionValue(pattern.definition.rotation, 'rotation'),
        boundaryMargin: expressionValue(pattern.definition.boundaryMargin, 'boundaryMargin'),
        seed: evaluatedSeed,
        maxGenerated: maximumCount - 1,
      });
    } catch (error) {
      fail('INVALID_PATTERN', path + '.definition is not a valid current fill recipe: ' + String(error?.message || error));
    }
    occurrenceCount = maximumCount;
  } else {
    validatePatternDefinitionKeys(
      pattern.definition,
      ['count', 'distribution', 'orientation', 'instances'],
      path + '.definition',
    );
    expectReferenceKinds('datum', ['direction']);
    if (!['axis', 'coordinate-system'].includes(datumKinds.get(referenceForRole('direction').ownerId))) {
      fail('INVALID_PATTERN', path + '.references role direction must resolve to an axis or coordinate system.');
    }
    if (pattern.definition.distribution !== 'table' || pattern.definition.orientation !== 'preserve') {
      fail('INVALID_PATTERN', path + '.definition must describe one preserve-orientation variable table pattern.');
    }
    const instances = requireArray(
      pattern.definition.instances,
      path + '.definition.instances',
      STUDIO_VARIABLE_PATTERN_MAX_GENERATED,
    );
    if (instances.length < 1 || instances.length !== count - 1) {
      fail('INVALID_PATTERN', path + '.definition.instances must contain one row per generated variable occurrence.');
    }
    const sourceBody = bodyById.get(sourceBodyId);
    const consumedNames = variablePatternConsumedParameterNames(
      sourceBody,
      featureById,
      enabledFeatureIds,
      new Set(parameterValues.keys()),
      partParameterDependencies,
      path,
    );
    const seenPositions = [];
    const seenOverrideSignatures = new Set();
    let expectedKeys = null;
    instances.forEach((instance, index) => {
      requireRecord(instance, path + '.definition.instances[' + index + ']');
      const unexpected = Object.keys(instance).filter((key) => key !== 'position' && key !== 'parameterOverrides');
      if (unexpected.length) fail('INVALID_PATTERN', path + '.definition.instances[' + index + '] contains unsupported fields: ' + unexpected.join(', ') + '.');
      const position = expressionValue(instance.position, 'instances[' + index + '].position');
      if (seenPositions.some((value) => Math.abs(value - position) <= 1e-9)) {
        fail('DUPLICATE_REFERENCE', path + '.definition.instances repeats evaluated position ' + position + '.');
      }
      seenPositions.push(position);
      requireRecord(instance.parameterOverrides, path + '.definition.instances[' + index + '].parameterOverrides');
      const keys = Object.keys(instance.parameterOverrides).sort();
      if (!keys.length || keys.length > STUDIO_VARIABLE_PATTERN_MAX_PARAMETERS) {
        fail('INVALID_PATTERN', path + '.definition.instances[' + index + '].parameterOverrides must contain 1 to 16 part-parameter values.');
      }
      if (expectedKeys == null) expectedKeys = keys;
      else if (keys.length !== expectedKeys.length || keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])) {
        fail('INVALID_PATTERN', path + '.definition.instances must override the same ordered parameter-name set in every row.');
      }
      let differsFromSeed = false;
      for (const key of keys) {
        if (!partParameterNames.has(key)) {
          fail('MISSING_REFERENCE', path + '.definition.instances[' + index + '].parameterOverrides.' + key + ' must name a part-local parameter.');
        }
        if (!consumedNames.has(key)) {
          fail('INVALID_PATTERN', path + '.definition.instances[' + index + '].parameterOverrides.' + key + ' is not consumed by a supported active source-body feature dimension.');
        }
        const value = instance.parameterOverrides[key];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          fail('INVALID_PATTERN', path + '.definition.instances[' + index + '].parameterOverrides.' + key + ' must be a finite literal number.');
        }
        if (Math.abs(value - parameterValues.get(key)) > 1e-12) differsFromSeed = true;
      }
      if (!differsFromSeed) {
        fail('INVALID_PATTERN', path + '.definition.instances[' + index + '] must change at least one driving parameter from the source seed.');
      }
      const overrideSignature = JSON.stringify(keys.map((key) => [key, instance.parameterOverrides[key]]));
      if (seenOverrideSignatures.has(overrideSignature)) {
        fail('DUPLICATE_REFERENCE', path + '.definition.instances must rebuild distinct parameter variants.');
      }
      seenOverrideSignatures.add(overrideSignature);
    });
  }
  counters.generatedOccurrences += occurrenceCount - 1;
  if (counters.generatedOccurrences > STUDIO_V5_PROJECT_LIMITS.generatedOccurrences) {
    fail('LIMIT_GENERATED_OCCURRENCES', 'Project exceeds the 5,000-generated-occurrence limit.');
  }
  const skipped = requireArray(pattern.skippedIndices, path + '.skippedIndices', occurrenceCount - 1);
  if (pattern.kind === 'fill' && skipped.length) {
    fail('INVALID_PATTERN', path + '.skippedIndices must stay empty because fill occurrences use dynamic lattice identity.');
  }
  const seenSkipped = new Set();
  skipped.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 1 || value >= occurrenceCount) fail('INVALID_PATTERN', path + '.skippedIndices[' + index + '] is outside the generated occurrence range.');
    if (seenSkipped.has(value)) fail('DUPLICATE_REFERENCE', path + '.skippedIndices repeats occurrence ' + value + '.');
    seenSkipped.add(value);
  });
  requireBoolean(pattern.suppressed, path + '.suppressed');
  requireBoolean(pattern.visible, path + '.visible');
  validateOptionalRecord(pattern.extensions, path + '.extensions');
}

function validateSketch(sketch, path, counters, seenIds, globalIds, parameterValues) {
  requireRecord(sketch, path);
  const id = requireId(sketch.id, path + '.id');
  addUnique(seenIds, id, path, 'sketch');
  addUnique(globalIds, id, path, 'project sketch');
  requireName(sketch.name, path + '.name');
  if (sketch.support != null) validateGeometryReference(sketch.support, path + '.support');
  const entities = requireArray(sketch.entities, path + '.entities', STUDIO_V5_PROJECT_LIMITS.sketchEntities, 'LIMIT_SKETCH_ENTITIES');
  counters.sketchEntities += entities.length;
  if (counters.sketchEntities > STUDIO_V5_PROJECT_LIMITS.sketchEntities) {
    fail('LIMIT_SKETCH_ENTITIES', 'Project exceeds the 25,000-sketch-entity limit.');
  }
  entities.forEach((entity, index) => requireRecord(entity, path + '.entities[' + index + ']'));
  const role = sketch.extensions?.studioRole;
  if (role !== undefined && role !== 'profile' && role !== 'path' && role !== STUDIO_CONSTRAINED_2D_ROLE) {
    fail('INVALID_SKETCH', path + '.extensions.studioRole is unsupported.');
  }
  if (role === STUDIO_CONSTRAINED_2D_ROLE) {
    if (entities.length !== 0) {
      fail('INVALID_SKETCH', path + '.entities must stay empty; constrained source is resolved by the production solver.');
    }
    if (sketch.plane !== 'XY' && sketch.plane !== 'YZ' && sketch.plane !== 'ZX') {
      fail('INVALID_SKETCH', path + '.plane must be XY, YZ, or ZX.');
    }
    evaluatedFeatureExpression(sketch.z ?? 0, path + '.z', parameterValues);
  } else if (role === 'profile' || role === 'path') {
    if (entities.length !== 1) fail('INVALID_SKETCH', path + ' advanced sketch must contain exactly one curve entity.');
    const entity = entities[0];
    if (entity.kind !== 'spline' && entity.kind !== 'polyline') fail('INVALID_SKETCH_ENTITY', path + '.entities[0].kind must be spline or polyline.');
    const pointCount = role === 'profile' ? 3 : 2;
    const dimensions = role === 'profile' ? 2 : 3;
    const points = requireArray(entity.points, path + '.entities[0].points', STUDIO_V5_PROJECT_LIMITS.sketchEntities);
    if (points.length < pointCount) fail('INVALID_SKETCH_ENTITY', path + '.entities[0].points does not contain enough points.');
    points.forEach((point, pointIndex) => {
      const values = requireArray(point, path + '.entities[0].points[' + pointIndex + ']', dimensions);
      if (values.length !== dimensions) fail('INVALID_SKETCH_ENTITY', path + '.entities[0].points[' + pointIndex + '] must contain exactly ' + dimensions + ' coordinates.');
      values.forEach((value, coordinateIndex) => evaluatedFeatureExpression(value, path + '.entities[0].points[' + pointIndex + '][' + coordinateIndex + ']', parameterValues));
    });
    const referenceCurve = sketch.extensions?.referenceCurve;
    if (referenceCurve !== undefined) {
      if (role !== 'path') fail('INVALID_SKETCH', path + '.extensions.referenceCurve is only valid on path sketches.');
      requireRecord(referenceCurve, path + '.extensions.referenceCurve');
      if (!['projected', 'composite', 'helix'].includes(referenceCurve.kind)) {
        fail('INVALID_SKETCH', path + '.extensions.referenceCurve.kind is unsupported.');
      }
      if (referenceCurve.kind === 'projected') {
        requireId(referenceCurve.sourceSketchId, path + '.extensions.referenceCurve.sourceSketchId');
        requireId(referenceCurve.planeDatumId, path + '.extensions.referenceCurve.planeDatumId');
      } else if (referenceCurve.kind === 'composite') {
        const sourceSketchIds = requireArray(referenceCurve.sourceSketchIds, path + '.extensions.referenceCurve.sourceSketchIds', 64);
        if (sourceSketchIds.length < 2) fail('INVALID_SKETCH', path + '.extensions.referenceCurve.sourceSketchIds requires at least two paths.');
        const unique = new Set();
        sourceSketchIds.forEach((id, index) => {
          const sourceId = requireId(id, path + '.extensions.referenceCurve.sourceSketchIds[' + index + ']');
          if (unique.has(sourceId)) fail('DUPLICATE_REFERENCE', path + '.extensions.referenceCurve.sourceSketchIds repeats path "' + sourceId + '".');
          unique.add(sourceId);
        });
      } else {
        requireId(referenceCurve.axisDatumId, path + '.extensions.referenceCurve.axisDatumId');
        const radius = evaluatedFeatureExpression(referenceCurve.radius, path + '.extensions.referenceCurve.radius', parameterValues);
        const pitch = evaluatedFeatureExpression(referenceCurve.pitch, path + '.extensions.referenceCurve.pitch', parameterValues);
        const turns = evaluatedFeatureExpression(referenceCurve.turns, path + '.extensions.referenceCurve.turns', parameterValues);
        if (!(radius > 0)) fail('INVALID_SKETCH', path + '.extensions.referenceCurve.radius must evaluate above zero.');
        if (!(pitch > 0)) fail('INVALID_SKETCH', path + '.extensions.referenceCurve.pitch must evaluate above zero.');
        if (!(turns > 0 && turns <= 100)) fail('INVALID_SKETCH', path + '.extensions.referenceCurve.turns must evaluate above zero and at most 100.');
        if (referenceCurve.startAngle !== undefined) evaluatedFeatureExpression(referenceCurve.startAngle, path + '.extensions.referenceCurve.startAngle', parameterValues);
        if (referenceCurve.handedness !== 'right' && referenceCurve.handedness !== 'left') {
          fail('INVALID_SKETCH', path + '.extensions.referenceCurve.handedness must be right or left.');
        }
      }
    }
  } else {
    for (const [index, entity] of entities.entries()) {
      const entityPath = path + '.entities[' + index + ']';
      const point = (value, suffix) => {
        const values = requireArray(value, entityPath + '.' + suffix, 2);
        if (values.length !== 2) fail('INVALID_SKETCH_ENTITY', entityPath + '.' + suffix + ' must contain exactly two coordinates.');
        values.forEach((coordinate, coordinateIndex) => evaluatedFeatureExpression(coordinate, entityPath + '.' + suffix + '[' + coordinateIndex + ']', parameterValues));
      };
      if (entity.kind === 'line') {
        point(entity.a, 'a');
        point(entity.b, 'b');
      } else if (entity.kind === 'circle') {
        point(entity.center, 'center');
        if (!(evaluatedFeatureExpression(entity.radius, entityPath + '.radius', parameterValues) > 0)) fail(STUDIO_V5_FEATURE_INPUT_ERROR_CODES.profileDimension, entityPath + '.radius must evaluate above zero.');
      } else if (entity.kind === 'arc') {
        point(entity.center, 'center');
        point(entity.start, 'start');
        point(entity.end, 'end');
        if (entity.clockwise !== undefined) requireBoolean(entity.clockwise, entityPath + '.clockwise');
      } else if (entity.kind === 'spline') {
        const through = requireArray(entity.through, entityPath + '.through', STUDIO_V5_PROJECT_LIMITS.sketchEntities);
        if (through.length < 2) fail('INVALID_SKETCH_ENTITY', entityPath + '.through must contain at least two points.');
        through.forEach((entry, pointIndex) => point(entry, 'through[' + pointIndex + ']'));
      } else fail('INVALID_SKETCH_ENTITY', entityPath + '.kind is unsupported.');
      if (entity.construction !== undefined) requireBoolean(entity.construction, entityPath + '.construction');
    }
  }
  requireArray(sketch.groups, path + '.groups', STUDIO_V5_PROJECT_LIMITS.sketchEntities, 'LIMIT_SKETCH_ENTITIES')
    .forEach((group, index) => requireRecord(group, path + '.groups[' + index + ']'));
  requireArray(sketch.constraints, path + '.constraints', STUDIO_V5_PROJECT_LIMITS.sketchEntities, 'LIMIT_SKETCH_ENTITIES')
    .forEach((constraint, index) => requireRecord(constraint, path + '.constraints[' + index + ']'));
  validateOptionalRecord(sketch.extensions, path + '.extensions');
}

function validateDatumDefinition(datum, path, parameterValues) {
  const definition = datum.definition;
  const mode = definition.mode;
  const allowedModes = datum.kind === 'plane'
    ? ['principal', 'offset', 'angle', 'three-point', 'point-normal', 'curve-normal', 'midplane']
    : datum.kind === 'axis'
      ? ['principal', 'through-points', 'plane-normal']
      : datum.kind === 'point'
        ? ['coordinates', 'midpoint', 'on-curve']
        : datum.kind === 'coordinate-system'
          ? ['principal']
          : [];
  if (mode !== undefined && !allowedModes.includes(mode)) {
    fail('INVALID_DATUM_DEFINITION', path + '.definition.mode is unsupported for a ' + datum.kind + ' datum.');
  }
  const expression = (value, suffix) => evaluatedFeatureExpression(value, path + '.definition.' + suffix, parameterValues);
  const vector = (value, suffix) => {
    const values = requireArray(value, path + '.definition.' + suffix, 3);
    if (values.length !== 3) fail('INVALID_DATUM_DEFINITION', path + '.definition.' + suffix + ' must contain exactly three values.');
    values.forEach((entry, index) => expression(entry, suffix + '[' + index + ']'));
  };
  const optionalBoolean = (key) => {
    if (definition[key] !== undefined) requireBoolean(definition[key], path + '.definition.' + key);
  };
  if (datum.kind === 'plane' && mode === 'offset') {
    requireId(definition.referenceDatumId, path + '.definition.referenceDatumId');
    expression(definition.offset, 'offset');
    optionalBoolean('flipNormal');
  } else if (datum.kind === 'plane' && mode === 'angle') {
    requireId(definition.referenceDatumId, path + '.definition.referenceDatumId');
    requireId(definition.axisDatumId, path + '.definition.axisDatumId');
    expression(definition.angle, 'angle');
  } else if (datum.kind === 'plane' && mode === 'three-point') {
    const points = requireArray(definition.points, path + '.definition.points', 3);
    if (points.length !== 3) fail('INVALID_DATUM_DEFINITION', path + '.definition.points must contain exactly three points.');
  } else if (datum.kind === 'plane' && mode === 'curve-normal') {
    if (definition.curveSketchId !== undefined) {
      requireId(definition.curveSketchId, path + '.definition.curveSketchId');
      expression(definition.parameter ?? 0, 'parameter');
      if (definition.xDirection !== undefined) vector(definition.xDirection, 'xDirection');
      const hasReferenceNormal = definition.referenceNormal !== undefined;
      const hasReferenceXDirection = definition.referenceXDirection !== undefined;
      if (hasReferenceNormal !== hasReferenceXDirection) {
        fail('INVALID_DATUM_DEFINITION', path + '.definition.referenceNormal and referenceXDirection must be provided together.');
      }
      if (hasReferenceNormal) {
        vector(definition.referenceNormal, 'referenceNormal');
        vector(definition.referenceXDirection, 'referenceXDirection');
      }
    } else {
      if (definition.pointDatumId === undefined && definition.point === undefined) fail('INVALID_DATUM_DEFINITION', path + '.definition requires a point reference.');
      if (definition.axisDatumId === undefined && definition.normal === undefined && definition.tangent === undefined) fail('INVALID_DATUM_DEFINITION', path + '.definition requires a curve tangent direction.');
      if (definition.normal !== undefined) vector(definition.normal, 'normal');
      if (definition.tangent !== undefined) vector(definition.tangent, 'tangent');
      if (definition.xDirection !== undefined) vector(definition.xDirection, 'xDirection');
    }
  } else if (datum.kind === 'plane' && mode === 'point-normal') {
    if (definition.pointDatumId === undefined && definition.point === undefined) fail('INVALID_DATUM_DEFINITION', path + '.definition requires a point reference.');
    if (definition.axisDatumId === undefined && definition.normal === undefined && definition.tangent === undefined) fail('INVALID_DATUM_DEFINITION', path + '.definition requires a normal direction.');
    if (definition.xDirection !== undefined) vector(definition.xDirection, 'xDirection');
  } else if (datum.kind === 'plane' && mode === 'midplane') {
    requireId(definition.firstDatumId, path + '.definition.firstDatumId');
    requireId(definition.secondDatumId, path + '.definition.secondDatumId');
  } else if (datum.kind === 'axis' && mode === 'through-points') {
    if (definition.pointA === undefined || definition.pointB === undefined) fail('INVALID_DATUM_DEFINITION', path + '.definition requires pointA and pointB.');
  } else if (datum.kind === 'axis' && mode === 'plane-normal') {
    requireId(definition.planeDatumId, path + '.definition.planeDatumId');
  } else if (datum.kind === 'point' && mode === 'midpoint') {
    if (definition.pointA === undefined || definition.pointB === undefined) fail('INVALID_DATUM_DEFINITION', path + '.definition requires pointA and pointB.');
  } else if (datum.kind === 'point' && mode === 'on-curve') {
    requireId(definition.curveSketchId, path + '.definition.curveSketchId');
    expression(definition.parameter, 'parameter');
  } else if (mode === undefined || mode === 'principal' || (datum.kind === 'point' && mode === 'coordinates')) {
    if (datum.kind === 'point') vector(definition.coordinates ?? definition.point ?? [0, 0, 0], definition.coordinates !== undefined ? 'coordinates' : definition.point !== undefined ? 'point' : 'coordinates');
    else if (datum.kind === 'axis') {
      vector(definition.origin ?? [0, 0, 0], 'origin');
      vector(definition.direction ?? [1, 0, 0], 'direction');
    } else if (datum.kind === 'coordinate-system') {
      vector(definition.origin ?? [0, 0, 0], 'origin');
      vector(definition.xDirection ?? [1, 0, 0], 'xDirection');
      vector(definition.zDirection ?? [0, 0, 1], 'zDirection');
    } else {
      vector(definition.origin ?? [0, 0, 0], 'origin');
      vector(definition.normal ?? [0, 0, 1], 'normal');
      vector(definition.xDirection ?? [1, 0, 0], 'xDirection');
    }
  }
}

function validateReferenceGeometry(datum, path, seenIds, globalIds, parameterValues) {
  requireRecord(datum, path);
  const id = requireId(datum.id, path + '.id');
  addUnique(seenIds, id, path, 'datum');
  addUnique(globalIds, id, path, 'project datum');
  requireName(datum.name, path + '.name');
  if (!REFERENCE_KINDS.has(datum.kind)) fail('INVALID_DATUM', path + '.kind is unsupported.');
  requireBoolean(datum.suppressed, path + '.suppressed');
  requireRecord(datum.definition, path + '.definition');
  validateDatumDefinition(datum, path, parameterValues);
  validateOptionalRecord(datum.extensions, path + '.extensions');
}

function validatePart(part, path, counters, projectIds, materialIds, projectParameterValues) {
  requireRecord(part, path);
  const partId = requireId(part.id, path + '.id');
  addUnique(projectIds.partIds, partId, path, 'part');
  requireName(part.name, path + '.name');
  const partParameterValues = validateParameterArray(part.parameters, path + '.parameters', counters.parameters, projectIds.parameterIds, projectParameterValues);
  const partParameterNames = new Set(part.parameters.map((parameter) => parameter.name));
  const partParameterDependencies = new Map(part.parameters.map((parameter, index) => [
    parameter.name,
    parseSafeExpression(
      parameter.value,
      path + '.parameters[' + index + '].value',
      new Set(partParameterValues.keys()),
    ).dependencies,
  ]));

  const datumIds = new Set();
  requireArray(part.referenceGeometry, path + '.referenceGeometry', STUDIO_V5_PROJECT_LIMITS.featuresPerPart)
    .forEach((datum, index) => validateReferenceGeometry(
      datum,
      path + '.referenceGeometry[' + index + ']',
      datumIds,
      projectIds.datumIds,
      partParameterValues,
    ));

  const sketchIds = new Set();
  requireArray(part.sketches, path + '.sketches', STUDIO_V5_PROJECT_LIMITS.featuresPerPart)
    .forEach((sketch, index) => validateSketch(
      sketch,
      path + '.sketches[' + index + ']',
      counters,
      sketchIds,
      projectIds.sketchIds,
      partParameterValues,
    ));

  const featureEntries = requireArray(part.features, path + '.features', STUDIO_V5_PROJECT_LIMITS.featuresPerPart, 'LIMIT_FEATURES');
  const featureIds = new Set();
  featureEntries.forEach((feature, index) => validateFeature(
    feature,
    path + '.features[' + index + ']',
    featureIds,
    projectIds.featureIds,
    partParameterValues,
  ));

  const featureOrder = requireArray(part.featureOrder, path + '.featureOrder', STUDIO_V5_PROJECT_LIMITS.featuresPerPart, 'LIMIT_FEATURES');
  if (featureOrder.length !== featureEntries.length) fail('INVALID_FEATURE_ORDER', path + '.featureOrder must contain every feature exactly once.');
  const orderedIds = new Set();
  const orderIndex = new Map();
  featureOrder.forEach((featureId, index) => {
    const id = requireId(featureId, path + '.featureOrder[' + index + ']');
    if (!featureIds.has(id)) fail('MISSING_REFERENCE', path + '.featureOrder[' + index + '] does not resolve in this part.');
    if (orderedIds.has(id)) fail('DUPLICATE_REFERENCE', path + '.featureOrder repeats feature "' + id + '".');
    orderedIds.add(id);
    orderIndex.set(id, index);
  });
  const featureById = new Map(featureEntries.map((feature) => [feature.id, feature]));
  const requestedRollbackIndex = part.metadata?.rollbackFeatureId == null
    ? featureOrder.length - 1
    : featureOrder.indexOf(part.metadata.rollbackFeatureId);
  const enabledFeatureIds = new Set(featureOrder.slice(
    0,
    requestedRollbackIndex < 0 ? featureOrder.length : requestedRollbackIndex + 1,
  ));

  const featureDependencies = new Map(featureEntries.map((feature) => [
    feature.id,
    feature.inputRefs
      .filter((reference) => reference.ownerKind === 'feature' && !reference.occurrencePath?.length)
      .map((reference) => reference.ownerId),
  ]));
  const visitingFeatures = new Set();
  const visitedFeatures = new Set();
  function visitFeature(featureId, chain) {
    if (visitingFeatures.has(featureId)) fail('CYCLIC_FEATURE_DEPENDENCY', path + ' contains a feature dependency cycle: ' + [...chain, featureId].join(' -> ') + '.');
    if (visitedFeatures.has(featureId)) return;
    visitingFeatures.add(featureId);
    for (const dependencyId of featureDependencies.get(featureId) || []) {
      if (!featureIds.has(dependencyId)) fail('MISSING_REFERENCE', path + ' feature "' + featureId + '" references missing feature "' + dependencyId + '".');
      visitFeature(dependencyId, [...chain, featureId]);
    }
    visitingFeatures.delete(featureId);
    visitedFeatures.add(featureId);
  }
  for (const featureId of featureIds) visitFeature(featureId, []);
  for (const [featureId, dependencyIds] of featureDependencies) {
    for (const dependencyId of dependencyIds) {
      if (orderIndex.get(dependencyId) >= orderIndex.get(featureId)) {
        fail('INVALID_FEATURE_ORDER', path + ' feature "' + featureId + '" must come after dependency "' + dependencyId + '".');
      }
    }
  }

  const bodyIds = new Set();
  requireArray(part.bodies, path + '.bodies', STUDIO_V5_PROJECT_LIMITS.featuresPerPart)
    .forEach((body, index) => validateBody(body, path + '.bodies[' + index + ']', bodyIds, projectIds.bodyIds, featureIds, materialIds));
  const bodyById = new Map(part.bodies.map((body) => [body.id, body]));

  const bodyPatternIds = new Set();
  const datumKinds = new Map(part.referenceGeometry.map((datum) => [datum.id, datum.kind]));
  const sketchRoles = new Map(part.sketches.map((sketch) => [sketch.id, sketch.extensions?.studioRole]));
  const sketchById = new Map(part.sketches.map((sketch) => [sketch.id, sketch]));
  const referenceCurveDependencies = new Map();
  for (const [index, sketch] of part.sketches.entries()) {
    const reference = sketch.extensions?.referenceCurve;
    if (!reference) continue;
    const sketchPath = path + '.sketches[' + index + '].extensions.referenceCurve';
    const sourceSketchIds = reference.kind === 'projected' ? [reference.sourceSketchId]
      : reference.kind === 'composite' ? reference.sourceSketchIds : [];
    for (const sourceSketchId of sourceSketchIds) {
      if (sourceSketchId === sketch.id) fail('CYCLIC_SKETCH_DEPENDENCY', sketchPath + ' cannot reference its own curve.');
      if (sketchRoles.get(sourceSketchId) !== 'path') fail('MISSING_REFERENCE', sketchPath + ' must reference an existing path sketch.');
    }
    if (reference.kind === 'projected' && datumKinds.get(reference.planeDatumId) !== 'plane') {
      fail('MISSING_REFERENCE', sketchPath + '.planeDatumId must resolve to a plane datum.');
    }
    if (reference.kind === 'helix' && !['axis', 'coordinate-system'].includes(datumKinds.get(reference.axisDatumId))) {
      fail('MISSING_REFERENCE', sketchPath + '.axisDatumId must resolve to an axis or coordinate-system datum.');
    }
    referenceCurveDependencies.set(sketch.id, sourceSketchIds);
  }
  const visitingReferenceCurves = new Set();
  const visitedReferenceCurves = new Set();
  function visitReferenceCurve(sketchId, chain) {
    if (visitingReferenceCurves.has(sketchId)) fail('CYCLIC_SKETCH_DEPENDENCY', path + ' contains a reference-curve cycle: ' + [...chain, sketchId].join(' -> ') + '.');
    if (visitedReferenceCurves.has(sketchId)) return;
    visitingReferenceCurves.add(sketchId);
    for (const dependencyId of referenceCurveDependencies.get(sketchId) || []) {
      if (referenceCurveDependencies.has(dependencyId)) visitReferenceCurve(dependencyId, [...chain, sketchId]);
    }
    visitingReferenceCurves.delete(sketchId);
    visitedReferenceCurves.add(sketchId);
  }
  for (const sketchId of referenceCurveDependencies.keys()) visitReferenceCurve(sketchId, []);
  const exactProjectionCompatible = new Map();
  function isExactProjectionCompatible(sketchId) {
    if (exactProjectionCompatible.has(sketchId)) return exactProjectionCompatible.get(sketchId);
    const sketch = sketchById.get(sketchId);
    const reference = sketch?.extensions?.referenceCurve;
    let compatible = false;
    if (!reference) compatible = sketch?.extensions?.studioRole === 'path' && ['polyline', 'spline'].includes(sketch.entities?.[0]?.kind);
    else if (reference.kind === 'projected') compatible = isExactProjectionCompatible(reference.sourceSketchId);
    else if (reference.kind === 'composite') compatible = reference.sourceSketchIds.every((id) => isExactProjectionCompatible(id));
    exactProjectionCompatible.set(sketchId, compatible);
    return compatible;
  }
  for (const [index, sketch] of part.sketches.entries()) {
    const reference = sketch.extensions?.referenceCurve;
    if (reference?.kind === 'projected' && !isExactProjectionCompatible(reference.sourceSketchId)) {
      fail('INVALID_SKETCH', path + '.sketches[' + index + '].extensions.referenceCurve projected curves require a source representable by exact line or spline spans.');
    }
  }
  for (const [index, feature] of featureEntries.entries()) {
    const featurePath = path + '.features[' + index + ']';
    if (feature.sketchId !== undefined) {
      const linkedSketch = sketchById.get(feature.sketchId);
      if (!linkedSketch) fail('MISSING_REFERENCE', featurePath + '.sketchId does not resolve in this part.');
      if (linkedSketch.extensions?.studioRole === STUDIO_CONSTRAINED_2D_ROLE) {
        if (!['extrude', 'cut'].includes(feature.type)) {
          fail('INVALID_FEATURE', featurePath + '.sketchId uses a constrained 2D sketch on an unsupported feature type.');
        }
        if (feature.sketch !== undefined) {
          fail('INVALID_FEATURE', featurePath + ' cannot mix an inline sketch with a first-class constrained sketch.');
        }
        if (feature.extensions?.exactSketchEntities !== true) {
          fail('INVALID_FEATURE', featurePath + ' must execute first-class constrained sketches through exact sketch entities.');
        }
        if (feature.plane?.kind !== 'base' || feature.plane.plane !== linkedSketch.plane) {
          fail('INVALID_FEATURE', featurePath + '.plane must match its constrained sketch support plane.');
        }
        if (feature.onFace !== undefined) {
          fail('INVALID_FEATURE', featurePath + ' cannot reinterpret a base-plane constrained sketch on a face.');
        }
        const matchingRefs = feature.inputRefs.filter((reference) =>
          reference.ownerKind === 'sketch' && reference.ownerId === linkedSketch.id);
        if (matchingRefs.length !== 1) {
          fail('INVALID_FEATURE', featurePath + '.inputRefs must contain exactly one reference to its constrained sketch.');
        }
      }
    }
    if (feature.type === 'loft') {
      for (const [sectionIndex, section] of feature.sections.entries()) {
        const sketch = sketchById.get(section.sketchId);
        if (!sketch || sketch.extensions?.studioRole !== 'profile') fail('MISSING_REFERENCE', featurePath + '.sections[' + sectionIndex + '] must resolve to a profile sketch.');
        if (section.startIndex >= sketch.entities[0].points.length) fail('INVALID_FEATURE', featurePath + '.sections[' + sectionIndex + '].startIndex is outside its profile point range.');
      }
      feature.guideSketchIds.forEach((sketchId, guideIndex) => {
        if (sketchRoles.get(sketchId) !== 'path') fail('MISSING_REFERENCE', featurePath + '.guideSketchIds[' + guideIndex + '] must resolve to a path sketch.');
      });
      if (feature.centerlineSketchId !== undefined && sketchRoles.get(feature.centerlineSketchId) !== 'path') fail('MISSING_REFERENCE', featurePath + '.centerlineSketchId must resolve to a path sketch.');
    } else if (feature.type === 'sweep') {
      if (sketchRoles.get(feature.profileSketchId) !== 'profile') fail('MISSING_REFERENCE', featurePath + '.profileSketchId must resolve to a profile sketch.');
      if (sketchRoles.get(feature.pathSketchId) !== 'path') fail('MISSING_REFERENCE', featurePath + '.pathSketchId must resolve to a path sketch.');
      if (feature.guideSketchId !== undefined && sketchRoles.get(feature.guideSketchId) !== 'path') fail('MISSING_REFERENCE', featurePath + '.guideSketchId must resolve to a path sketch.');
      if (feature.extensions?.structuralMember) {
        try {
          assertStudioStructuralMemberPart(
            part,
            feature,
            featurePath,
            (value, expressionPath) => evaluatedFeatureExpression(value, expressionPath, partParameterValues),
          );
        } catch (error) {
          if (error instanceof StudioV5ProjectError) throw error;
          fail(error?.code || STUDIO_V5_FEATURE_INPUT_ERROR_CODES.structure, String(error?.message || error));
        }
      }
    } else if (feature.type === 'revolve' && feature.profileSketchId !== undefined) {
      if (sketchRoles.get(feature.profileSketchId) !== 'profile') fail('MISSING_REFERENCE', featurePath + '.profileSketchId must resolve to a profile sketch.');
      if (datumKinds.get(feature.axisDatumId) !== 'axis') fail('MISSING_REFERENCE', featurePath + '.axisDatumId must resolve to an axis datum.');
    } else if (feature.type === 'draft' && datumKinds.get(feature.neutralPlaneDatumId) !== 'plane') {
      fail('MISSING_REFERENCE', featurePath + '.neutralPlaneDatumId must resolve to a plane datum.');
    } else if (feature.type === 'weldment-treatment') {
      try {
        assertStudioWeldmentTreatmentPart(
          part,
          feature,
          featurePath,
          (value, expressionPath) => evaluatedFeatureExpression(value, expressionPath, partParameterValues),
        );
      } catch (error) {
        if (error instanceof StudioV5ProjectError) throw error;
        fail(error?.code || STUDIO_V5_FEATURE_INPUT_ERROR_CODES.structure, String(error?.message || error));
      }
    } else if (feature.type === 'weld-bead') {
      try {
        assertStudioWeldBeadPart(
          part,
          feature,
          featurePath,
          (value, expressionPath) => evaluatedFeatureExpression(value, expressionPath, partParameterValues),
        );
      } catch (error) {
        if (error instanceof StudioV5ProjectError) throw error;
        fail(error?.code || STUDIO_V5_FEATURE_INPUT_ERROR_CODES.structure, String(error?.message || error));
      }
    }
  }
  requireArray(part.bodyPatterns === undefined ? [] : part.bodyPatterns, path + '.bodyPatterns', STUDIO_V5_PROJECT_LIMITS.featuresPerPart)
    .forEach((pattern, index) => validateBodyPattern(
      pattern,
      path + '.bodyPatterns[' + index + ']',
      partId,
      bodyIds,
      featureIds,
      datumIds,
      sketchIds,
      datumKinds,
      sketchRoles,
      sketchById,
      bodyById,
      featureById,
      enabledFeatureIds,
      partParameterValues,
      partParameterNames,
      partParameterDependencies,
      bodyPatternIds,
      projectIds.patternIds,
      counters,
    ));

  for (const [index, body] of part.bodies.entries()) {
    let previousOrder = -1;
    for (const featureId of body.featureIds) {
      const nextOrder = orderIndex.get(featureId);
      if (nextOrder < previousOrder) fail('INVALID_BODY', path + '.bodies[' + index + '].featureIds must follow part feature order.');
      previousOrder = nextOrder;
    }
  }

  const bodyDependencies = new Map(part.bodies.map((body) => [body.id, new Set()]));
  for (const [index, feature] of featureEntries.entries()) {
    const policy = feature.resultPolicy;
    let affectedBodyIds;
    if (policy.kind === 'new-body' || policy.kind === 'surface') {
      affectedBodyIds = part.bodies.filter((body) => body.createdByFeatureId === feature.id).map((body) => body.id);
      if (affectedBodyIds.length !== 1) {
        fail('INVALID_BODY_OWNERSHIP', path + '.features[' + index + '] must create exactly one body for result policy "' + policy.kind + '".');
      }
      const createdBody = bodyById.get(affectedBodyIds[0]);
      const expectedKind = policy.kind === 'surface' ? 'surface' : 'solid';
      if (createdBody.kind !== expectedKind) {
        fail('INVALID_BODY_OWNERSHIP', path + '.features[' + index + '] creates a ' + createdBody.kind + ' body under a ' + policy.kind + ' result policy.');
      }
    } else {
      affectedBodyIds = policy.targetBodyIds;
      if (part.bodies.some((body) => body.createdByFeatureId === feature.id)) {
        fail('INVALID_BODY_OWNERSHIP', path + '.features[' + index + '] cannot create a body under a ' + policy.kind + ' result policy.');
      }
    }
    const expected = new Set(affectedBodyIds);
    for (const bodyId of expected) {
      const affectedBody = bodyById.get(bodyId);
      if (!affectedBody) {
        fail('MISSING_REFERENCE', path + '.features[' + index + '].resultPolicy references missing body "' + bodyId + '".');
      }
      if (!affectedBody.featureIds.includes(feature.id)) {
        fail('INVALID_BODY_OWNERSHIP', path + ' body "' + bodyId + '" is missing affected feature "' + feature.id + '" from its history.');
      }
    }
    for (const body of part.bodies) {
      if (body.featureIds.includes(feature.id) && !expected.has(body.id)) {
        fail('INVALID_BODY_OWNERSHIP', path + ' body "' + body.id + '" contains feature "' + feature.id + '" that does not target it.');
      }
    }
    if (feature.type === 'boolean') {
      if (policy.kind !== 'add' && policy.kind !== 'subtract' && policy.kind !== 'intersect') {
        fail('INVALID_FEATURE', path + '.features[' + index + '] Boolean result policy must be add, subtract, or intersect.');
      }
      if (feature.operation !== policy.kind) {
        fail('INVALID_FEATURE', path + '.features[' + index + '].operation must match its Boolean result policy.');
      }
      const toolBodyIds = requireArray(feature.toolBodyIds, path + '.features[' + index + '].toolBodyIds', STUDIO_V5_PROJECT_LIMITS.featuresPerPart);
      if (!toolBodyIds.length) fail('INVALID_FEATURE', path + '.features[' + index + '] Boolean must reference at least one tool body.');
      const seenTools = new Set();
      toolBodyIds.forEach((toolBodyId, toolIndex) => {
        const id = requireId(toolBodyId, path + '.features[' + index + '].toolBodyIds[' + toolIndex + ']');
        if (!bodyIds.has(id)) fail('MISSING_REFERENCE', path + '.features[' + index + '].toolBodyIds[' + toolIndex + '] does not resolve in this part.');
        if (seenTools.has(id)) fail('DUPLICATE_REFERENCE', path + '.features[' + index + '] repeats tool body "' + id + '".');
        if (policy.targetBodyIds.includes(id)) fail('INVALID_FEATURE', path + '.features[' + index + '] cannot use a target body as its own Boolean tool.');
        seenTools.add(id);
        for (const targetBodyId of policy.targetBodyIds) bodyDependencies.get(targetBodyId).add(id);
      });
    } else if (feature.type === 'direct-edit') {
      let checked;
      try {
        checked = assertStudioDirectEditPart(
          part,
          feature,
          path + '.features[' + index + ']',
          (value, expressionPath) => evaluatedFeatureExpression(value, expressionPath, partParameterValues),
        );
      } catch (error) {
        if (error instanceof StudioV5ProjectError) throw error;
        fail(error?.code || STUDIO_V5_FEATURE_INPUT_ERROR_CODES.structure, String(error?.message || error));
      }
      const directEditOrder = orderIndex.get(feature.id);
      if (orderIndex.get(checked.targetBody.createdByFeatureId) >= directEditOrder) {
        fail('INVALID_FEATURE_ORDER', path + '.features[' + index + '] must follow its target-body creation feature.');
      }
      if (checked.replacementBody) {
        const laterReplacementFeatureId = checked.replacementBody.featureIds.find((featureId) =>
          orderIndex.get(featureId) >= directEditOrder);
        if (laterReplacementFeatureId) {
          fail(
            'INVALID_FEATURE_ORDER',
            path + '.features[' + index + '] must follow the complete replacement-body history; feature "'
              + laterReplacementFeatureId + '" is not earlier in the part history.',
          );
        }
        bodyDependencies.get(checked.targetBody.id).add(checked.replacementBody.id);
      }
    } else if (feature.type === 'transform') {
      const sourceBodyId = requireId(feature.sourceBodyId, path + '.features[' + index + '].sourceBodyId');
      const sourceBody = bodyById.get(sourceBodyId);
      if (!sourceBody) fail('MISSING_REFERENCE', path + '.features[' + index + '].sourceBodyId does not resolve in this part.');
      const sourceCreationOrder = orderIndex.get(sourceBody.createdByFeatureId);
      if (sourceCreationOrder >= orderIndex.get(feature.id)) {
        fail('INVALID_FEATURE_ORDER', path + '.features[' + index + '] must come after its source body creation feature.');
      }
      const mode = feature.transform?.mode || feature.operation;
      if (!['move', 'translate', 'copy', 'rotate', 'align', 'mirror', 'scale'].includes(mode)) {
        fail('INVALID_FEATURE', path + '.features[' + index + '] has an unsupported transform mode.');
      }
      if (policy.kind === 'new-body') {
        const createdBody = part.bodies.find((body) => body.createdByFeatureId === feature.id);
        if (!createdBody || createdBody.id === sourceBodyId) fail('INVALID_FEATURE', path + '.features[' + index + '] must create a distinct linked body.');
        bodyDependencies.get(createdBody.id).add(sourceBodyId);
      } else if (policy.targetBodyIds.length !== 1 || policy.targetBodyIds[0] !== sourceBodyId) {
        fail('INVALID_FEATURE', path + '.features[' + index + '] must target exactly its source body unless it creates a copy.');
      }
    } else if (feature.type === 'thicken') {
      const sourceBodyId = requireId(feature.sourceBodyId, path + '.features[' + index + '].sourceBodyId');
      const sourceBody = bodyById.get(sourceBodyId);
      if (!sourceBody) fail('MISSING_REFERENCE', path + '.features[' + index + '].sourceBodyId does not resolve in this part.');
      if (orderIndex.get(sourceBody.createdByFeatureId) >= orderIndex.get(feature.id)) {
        fail('INVALID_FEATURE_ORDER', path + '.features[' + index + '] must come after its source body creation feature.');
      }
      if (sourceBody.featureIds.some((sourceFeatureId) => orderIndex.get(sourceFeatureId) >= orderIndex.get(feature.id))) {
        fail('INVALID_FEATURE_ORDER', path + '.features[' + index + '] must come after the complete source-body history.');
      }
      if (policy.kind !== 'new-body') fail('INVALID_FEATURE', path + '.features[' + index + '] Thicken must create a linked body.');
      const createdBody = part.bodies.find((body) => body.createdByFeatureId === feature.id);
      if (!createdBody || createdBody.id === sourceBodyId) fail('INVALID_FEATURE', path + '.features[' + index + '] Thicken must create a distinct linked body.');
      bodyDependencies.get(createdBody.id).add(sourceBodyId);
    } else if (feature.type === 'boolean-split-side') {
      const sourceBodyId = requireId(feature.sourceBodyId, path + '.features[' + index + '].sourceBodyId');
      const sourceBody = bodyById.get(sourceBodyId);
      if (!sourceBody) fail('MISSING_REFERENCE', path + '.features[' + index + '].sourceBodyId does not resolve in this part.');
      const toolBodyIds = requireArray(feature.toolBodyIds, path + '.features[' + index + '].toolBodyIds', 2);
      if (toolBodyIds.length !== 2 || toolBodyIds[0] !== sourceBodyId) fail('INVALID_FEATURE', path + '.features[' + index + '] Boolean Split must store target then tool body.');
      const toolBodyId = requireId(toolBodyIds[1], path + '.features[' + index + '].toolBodyIds[1]');
      const toolBody = bodyById.get(toolBodyId);
      if (!toolBody || toolBodyId === sourceBodyId) fail('MISSING_REFERENCE', path + '.features[' + index + '] Boolean Split tool must resolve to a different body.');
      if (feature.side !== 'inside' && feature.side !== 'outside') fail('INVALID_FEATURE', path + '.features[' + index + '].side must be inside or outside.');
      if (policy.kind !== 'new-body') fail('INVALID_FEATURE', path + '.features[' + index + '] Boolean Split sides must create bodies.');
      if ([...sourceBody.featureIds, ...toolBody.featureIds].some((dependencyId) => orderIndex.get(dependencyId) >= orderIndex.get(feature.id))) {
        fail('INVALID_FEATURE_ORDER', path + '.features[' + index + '] must come after complete target and tool histories.');
      }
      const createdBody = part.bodies.find((body) => body.createdByFeatureId === feature.id);
      if (!createdBody) fail('INVALID_FEATURE', path + '.features[' + index + '] Boolean Split side must create a distinct body.');
      bodyDependencies.get(createdBody.id).add(sourceBodyId);
      bodyDependencies.get(createdBody.id).add(toolBodyId);
    } else if (feature.type === 'weldment-treatment') {
      let checked;
      try {
        checked = assertStudioWeldmentTreatmentPart(
          part,
          feature,
          path + '.features[' + index + ']',
          (value, expressionPath) => evaluatedFeatureExpression(value, expressionPath, partParameterValues),
        );
      } catch (error) {
        if (error instanceof StudioV5ProjectError) throw error;
        fail(error?.code || STUDIO_V5_FEATURE_INPUT_ERROR_CODES.structure, String(error?.message || error));
      }
      const treatmentOrder = orderIndex.get(feature.id);
      const sourceBodies = checked.recipe.kind === 'trim-extend'
        ? [checked.member.body]
        : checked.recipe.kind === 'corner'
          ? [checked.target.body, checked.other.body]
          : checked.recipe.kind === 'gusset'
            ? [checked.left.body, checked.right.body]
            : [checked.member.body];
      for (const sourceBody of sourceBodies) {
        if (orderIndex.get(sourceBody.createdByFeatureId) >= treatmentOrder) {
          fail('INVALID_FEATURE_ORDER', path + '.features[' + index + '] must follow every referenced structural-member creation feature.');
        }
      }
      if (checked.recipe.kind === 'corner' && checked.recipe.style === 'cope') {
        if (checked.other.body.featureIds.some((dependencyId) => orderIndex.get(dependencyId) >= treatmentOrder)) {
          fail('INVALID_FEATURE_ORDER', path + '.features[' + index + '] cope must follow the complete other-member body history.');
        }
        bodyDependencies.get(checked.target.body.id).add(checked.other.body.id);
      } else if (checked.recipe.kind === 'gusset' || checked.recipe.kind === 'end-cap') {
        const createdBody = part.bodies.find((body) => body.createdByFeatureId === feature.id);
        if (!createdBody) {
          fail('INVALID_BODY_OWNERSHIP', path + '.features[' + index + '] plate treatment must create one body.');
        }
        for (const sourceBody of sourceBodies) {
          if (sourceBody.featureIds.some((dependencyId) => orderIndex.get(dependencyId) >= treatmentOrder)) {
            fail('INVALID_FEATURE_ORDER', path + '.features[' + index + '] plate treatment must follow the complete source-member history.');
          }
          bodyDependencies.get(createdBody.id).add(sourceBody.id);
        }
      }
    } else if (feature.type === 'sheet-metal-flange') {
      let checked;
      try {
        checked = assertStudioSheetMetalPart(
          part,
          feature,
          path + '.features[' + index + ']',
          (value, expressionPath) => evaluatedFeatureExpression(value, expressionPath, partParameterValues),
        );
      } catch (error) {
        if (error instanceof StudioV5ProjectError) throw error;
        fail(error?.code || STUDIO_V5_FEATURE_INPUT_ERROR_CODES.structure, String(error?.message || error));
      }
      if (checked.recipe.kind === 'edge-flange' || checked.recipe.kind === 'corner-relief') {
        const flangeOrder = orderIndex.get(feature.id);
        if (orderIndex.get(checked.baseFeature.id) >= flangeOrder) {
          fail('INVALID_FEATURE_ORDER', path + '.features[' + index + '] must follow its base-flange creation feature.');
        }
      } else {
        const createdBody = part.bodies.find((body) => body.createdByFeatureId === feature.id);
        if (!createdBody) {
          fail('INVALID_BODY_OWNERSHIP', path + '.features[' + index + '] '
            + (checked.recipe.kind === 'flat-pattern' ? 'flat pattern' : 'base flange') + ' must create one body.');
        }
        if (checked.recipe.kind === 'flat-pattern') {
          // The flat-pattern body is a derived read-only artifact: no other
          // feature may target, tool, or source it.
          for (const other of part.features) {
            if (other === feature) continue;
            const consumed = [
              ...(Array.isArray(other.resultPolicy?.targetBodyIds) ? other.resultPolicy.targetBodyIds : []),
              ...(Array.isArray(other.toolBodyIds) ? other.toolBodyIds : []),
              ...(typeof other.sourceBodyId === 'string' ? [other.sourceBodyId] : []),
            ];
            if (consumed.includes(createdBody.id)) {
              fail('INVALID_BODY_OWNERSHIP', path + '.features[' + index + '] flat-pattern body "'
                + createdBody.id + '" is derived and read-only; feature "' + other.id + '" cannot consume it.');
            }
          }
        }
      }
    } else if (feature.type === 'weld-bead') {
      let checked;
      try {
        checked = assertStudioWeldBeadPart(
          part,
          feature,
          path + '.features[' + index + ']',
          (value, expressionPath) => evaluatedFeatureExpression(value, expressionPath, partParameterValues),
        );
      } catch (error) {
        if (error instanceof StudioV5ProjectError) throw error;
        fail(error?.code || STUDIO_V5_FEATURE_INPUT_ERROR_CODES.structure, String(error?.message || error));
      }
      const beadOrder = orderIndex.get(feature.id);
      for (const support of checked.supports) {
        if (support.body.featureIds.some((dependencyId) => orderIndex.get(dependencyId) >= beadOrder)) {
          fail(
            'INVALID_FEATURE_ORDER',
            path + '.features[' + index + '] must follow the complete history of both structural-member support bodies.',
          );
        }
      }
      if (checked.createdBody.id === checked.supports[0].body.id
        || checked.createdBody.id === checked.supports[1].body.id) {
        fail('INVALID_BODY_OWNERSHIP', path + '.features[' + index + '] must create a distinct weld-bead body.');
      }
      bodyDependencies.get(checked.createdBody.id).add(checked.supports[0].body.id);
      bodyDependencies.get(checked.createdBody.id).add(checked.supports[1].body.id);
    }
  }

  const visitingBodies = new Set();
  const visitedBodies = new Set();
  function visitBody(bodyId, chain) {
    if (visitingBodies.has(bodyId)) fail('CYCLIC_BODY_DEPENDENCY', path + ' contains a body dependency cycle: ' + [...chain, bodyId].join(' -> ') + '.');
    if (visitedBodies.has(bodyId)) return;
    visitingBodies.add(bodyId);
    for (const dependencyId of bodyDependencies.get(bodyId) || []) visitBody(dependencyId, [...chain, bodyId]);
    visitingBodies.delete(bodyId);
    visitedBodies.add(bodyId);
  }
  for (const bodyId of bodyIds) visitBody(bodyId, []);

  for (const [index, feature] of featureEntries.entries()) {
    const policy = feature.resultPolicy;
    if (policy.kind === 'add' || policy.kind === 'subtract' || policy.kind === 'intersect') {
      policy.targetBodyIds.forEach((targetId, targetIndex) => {
        if (!bodyIds.has(targetId)) fail('MISSING_REFERENCE', path + '.features[' + index + '].resultPolicy.targetBodyIds[' + targetIndex + '] does not resolve in this part.');
      });
    }
    for (const [referenceIndex, reference] of feature.inputRefs.entries()) {
      validatePartReferenceContext(
        reference,
        path + '.features[' + index + '].inputRefs[' + referenceIndex + ']',
        partId,
        bodyIds,
        featureIds,
        datumIds,
        sketchIds,
      );
    }
  }

  for (const [index, sketch] of part.sketches.entries()) {
    if (sketch.support != null) {
      validatePartReferenceContext(sketch.support, path + '.sketches[' + index + '].support', partId, bodyIds, featureIds, datumIds, sketchIds);
    }
  }

  if (part.defaultAppearanceId != null) requireId(part.defaultAppearanceId, path + '.defaultAppearanceId');
  validateOptionalRecord(part.metadata, path + '.metadata');
  validateOptionalRecord(part.extensions, path + '.extensions');
  if (part.extensions?.sheetMetalBendTable !== undefined) {
    try {
      assertStudioSheetMetalBendTable(part.extensions.sheetMetalBendTable, path + '.extensions.sheetMetalBendTable');
    } catch (error) {
      if (error instanceof StudioV5ProjectError) throw error;
      fail(error?.code || STUDIO_V5_FEATURE_INPUT_ERROR_CODES.structure, String(error?.message || error));
    }
  }
  try {
    assertStudioSketchInstancesPart(part);
    for (const [index, definition] of (part.sketchBlockDefinitions || []).entries()) {
      addUnique(
        projectIds.sketchBlockDefinitionIds,
        definition.id,
        path + '.sketchBlockDefinitions[' + index + ']',
        'project sketch-block definition',
      );
    }
    for (const [sketchIndex, sketch] of part.sketches.entries()) {
      for (const [instanceIndex, instance] of (sketch.constrained?.blockInstances || []).entries()) {
        addUnique(
          projectIds.sketchBlockInstanceIds,
          instance.id,
          path + '.sketches[' + sketchIndex + '].constrained.blockInstances[' + instanceIndex + ']',
          'project sketch-block instance',
        );
      }
      for (const [relationIndex, relation] of (sketch.constrained?.relations || []).entries()) {
        addUnique(
          projectIds.sketchRelationIds,
          relation.id,
          path + '.sketches[' + sketchIndex + '].constrained.relations[' + relationIndex + ']',
          'project first-class sketch relation',
        );
      }
    }
    const constrainedEntities = part.sketches.reduce(
      (total, sketch) => total + (sketch.constrained?.entities?.length || 0),
      0,
    );
    const definitionEntities = (part.sketchBlockDefinitions || []).reduce(
      (total, definition) => total + (definition.constrained?.entities?.length || 0),
      0,
    );
    counters.sketchEntities += constrainedEntities + definitionEntities;
    if (counters.sketchEntities > STUDIO_V5_PROJECT_LIMITS.sketchEntities) {
      fail('LIMIT_SKETCH_ENTITIES', 'Project exceeds the 25,000-sketch-entity limit including constrained sketches and block definitions.');
    }
  } catch (error) {
    if (error instanceof StudioV5ProjectError) throw error;
    fail(error?.code || 'INVALID_SKETCH_INSTANCES', String(error?.message || error));
  }
}

function validateOccurrence(occurrence, path, seenIds, globalIds, parameterValues) {
  requireRecord(occurrence, path);
  const id = requireId(occurrence.id, path + '.id');
  addUnique(seenIds, id, path, 'occurrence');
  addUnique(globalIds, id, path, 'project occurrence');
  requireName(occurrence.name, path + '.name');
  validateDocumentRef(occurrence.definition, path + '.definition');
  if (occurrence.parentOccurrenceId != null) requireId(occurrence.parentOccurrenceId, path + '.parentOccurrenceId');
  const matrix = requireArray(occurrence.baseTransform, path + '.baseTransform', 16);
  if (matrix.length !== 16 || !matrix.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    fail('INVALID_TRANSFORM', path + '.baseTransform must contain 16 finite numbers.');
  }
  if (matrix.length === 16) {
    const columns = [[matrix[0], matrix[1], matrix[2]], [matrix[4], matrix[5], matrix[6]], [matrix[8], matrix[9], matrix[10]]];
    const dot3 = (left, right) => left.reduce((total, value, index) => total + value * right[index], 0);
    const determinant =
      columns[0][0] * (columns[1][1] * columns[2][2] - columns[1][2] * columns[2][1]) -
      columns[1][0] * (columns[0][1] * columns[2][2] - columns[0][2] * columns[2][1]) +
      columns[2][0] * (columns[0][1] * columns[1][2] - columns[0][2] * columns[1][1]);
    const rigid = columns.every((column) => Math.abs(dot3(column, column) - 1) <= 1e-8) &&
      Math.abs(dot3(columns[0], columns[1])) <= 1e-8 && Math.abs(dot3(columns[0], columns[2])) <= 1e-8 && Math.abs(dot3(columns[1], columns[2])) <= 1e-8 &&
      Math.abs(determinant - 1) <= 1e-8 && Math.abs(matrix[3]) <= 1e-10 && Math.abs(matrix[7]) <= 1e-10 && Math.abs(matrix[11]) <= 1e-10 && Math.abs(matrix[15] - 1) <= 1e-10;
    if (!rigid) fail('INVALID_TRANSFORM', path + '.baseTransform must be a rigid right-handed transform without scale, shear, reflection, or perspective.');
  }
  requireBoolean(occurrence.fixed, path + '.fixed');
  requireBoolean(occurrence.suppressed, path + '.suppressed');
  requireBoolean(occurrence.visible, path + '.visible');
  if (occurrence.appearanceOverrideId != null) requireId(occurrence.appearanceOverrideId, path + '.appearanceOverrideId');
  if (occurrence.parameterOverrides != null) {
    requireRecord(occurrence.parameterOverrides, path + '.parameterOverrides');
    for (const [name, value] of Object.entries(occurrence.parameterOverrides)) {
      if (!PARAMETER_NAME_PATTERN.test(name) || !expressionLike(value)) fail('INVALID_PARAMETER_OVERRIDE', path + '.parameterOverrides.' + name + ' is invalid.');
      parseSafeExpression(value, path + '.parameterOverrides.' + name, new Set(parameterValues.keys())).evaluate((parameterName) => parameterValues.get(parameterName));
    }
  }
  validateOptionalRecord(occurrence.extensions, path + '.extensions');
}

function validateMate(mate, path, occurrenceIds, seenIds, globalIds, parameterValues) {
  requireRecord(mate, path);
  const id = requireId(mate.id, path + '.id');
  addUnique(seenIds, id, path, 'mate');
  addUnique(globalIds, id, path, 'project mate');
  requireName(mate.name, path + '.name');
  if (!MATE_KINDS.has(mate.kind)) fail('INVALID_MATE', path + '.kind is unsupported.');

  if (isStudioAdvancedMateKind(mate.kind)) {
    try {
      assertStudioAdvancedMateRecord(mate, {
        path,
        evaluateExpression(value, expressionPath) {
          return parseSafeExpression(
            value,
            expressionPath,
            new Set(parameterValues.keys()),
          ).evaluate((parameterName) => parameterValues.get(parameterName));
        },
      });
    } catch (error) {
      if (error instanceof StudioV5ProjectError) throw error;
      if (error instanceof StudioAdvancedMateError) fail(error.code, error.message);
      throw error;
    }
    mate.occurrenceIds.forEach((occurrenceId, index) => {
      if (!occurrenceIds.has(occurrenceId)) {
        fail(
          'MISSING_REFERENCE',
          path + '.occurrenceIds[' + index + '] does not resolve in this assembly.',
        );
      }
    });
    mate.references.forEach((reference, index) => {
      validateGeometryReference(reference, path + '.references[' + index + ']');
    });
    return;
  }
  if (isStudioMechanicalMateKind(mate.kind)) {
    try {
      assertStudioMechanicalMateRecord(mate, {
        path,
        evaluateExpression(value, expressionPath) {
          return parseSafeExpression(
            value,
            expressionPath,
            new Set(parameterValues.keys()),
          ).evaluate((parameterName) => parameterValues.get(parameterName));
        },
      });
    } catch (error) {
      if (error instanceof StudioV5ProjectError) throw error;
      if (error instanceof StudioMechanicalMateError) fail(error.code, error.message);
      throw error;
    }
    mate.occurrenceIds.forEach((occurrenceId, index) => {
      if (!occurrenceIds.has(occurrenceId)) {
        fail(
          'MISSING_REFERENCE',
          path + '.occurrenceIds[' + index + '] does not resolve in this assembly.',
        );
      }
    });
    mate.references.forEach((reference, index) => {
      validateGeometryReference(reference, path + '.references[' + index + ']');
    });
    return;
  }
  if (hasStudioAdvancedMateContract(mate)) {
    fail(
      'ADVANCED_MATE_KIND_INVALID',
      path + '.extensions.advancedMate is only valid for an advanced mate kind.',
    );
  }
  if (hasStudioMechanicalMateContract(mate)) {
    fail(
      'MECHANICAL_MATE_KIND_INVALID',
      path + '.extensions.mechanicalMate is only valid for a mechanical mate kind.',
    );
  }

  const selectedOccurrences = requireArray(mate.occurrenceIds, path + '.occurrenceIds', STUDIO_V5_PROJECT_LIMITS.occurrences);
  const expectedOccurrences = mate.kind === 'fixed' ? 1 : 2;
  const selectedOccurrenceIds = new Set();
  selectedOccurrences.forEach((occurrenceId, index) => {
    const idValue = requireId(occurrenceId, path + '.occurrenceIds[' + index + ']');
    if (!occurrenceIds.has(idValue)) fail('MISSING_REFERENCE', path + '.occurrenceIds[' + index + '] does not resolve in this assembly.');
    if (selectedOccurrenceIds.has(idValue)) fail('DUPLICATE_REFERENCE', path + '.occurrenceIds repeats occurrence "' + idValue + '".');
    selectedOccurrenceIds.add(idValue);
  });
  if (selectedOccurrences.length !== expectedOccurrences) fail('INVALID_MATE', path + '.occurrenceIds must contain exactly ' + expectedOccurrences + ' occurrence' + (expectedOccurrences === 1 ? '' : 's') + ' for a ' + mate.kind + ' mate.');
  const references = requireArray(mate.references, path + '.references', 10);
  const expectedReferences = mate.kind === 'fixed' ? [0, 1] : [2];
  if (!expectedReferences.includes(references.length)) fail('INVALID_MATE', path + '.references has the wrong number of explicit references for a ' + mate.kind + ' mate.');
  references.forEach((reference, index) => validateGeometryReference(reference, path + '.references[' + index + ']'));
  if (mate.value != null) {
    parseSafeExpression(mate.value, path + '.value', new Set(parameterValues.keys())).evaluate((parameterName) => parameterValues.get(parameterName));
  }
  requireBoolean(mate.suppressed, path + '.suppressed');
  validateOptionalRecord(mate.extensions, path + '.extensions');
}

function validateOccurrencePattern(pattern, path, occurrenceIds, seenIds, globalIds, counters) {
  requireRecord(pattern, path);
  const id = requireId(pattern.id, path + '.id');
  addUnique(seenIds, id, path, 'occurrence pattern');
  addUnique(globalIds, id, path, 'project occurrence pattern');
  requireName(pattern.name, path + '.name');
  if (!PATTERN_KINDS.has(pattern.kind)) fail('INVALID_PATTERN', path + '.kind is unsupported.');
  const sourceIds = requireArray(pattern.sourceOccurrenceIds, path + '.sourceOccurrenceIds', STUDIO_V5_PROJECT_LIMITS.occurrences);
  if (sourceIds.length === 0) fail('INVALID_PATTERN', path + '.sourceOccurrenceIds must not be empty.');
  const sourceOccurrenceIds = new Set();
  sourceIds.forEach((occurrenceId, index) => {
    const idValue = requireId(occurrenceId, path + '.sourceOccurrenceIds[' + index + ']');
    if (!occurrenceIds.has(idValue)) fail('MISSING_REFERENCE', path + '.sourceOccurrenceIds[' + index + '] does not resolve in this assembly.');
    if (sourceOccurrenceIds.has(idValue)) fail('DUPLICATE_REFERENCE', path + '.sourceOccurrenceIds repeats occurrence "' + idValue + '".');
    sourceOccurrenceIds.add(idValue);
  });
  const generatedCount = requireInteger(pattern.generatedCount, path + '.generatedCount', 1, STUDIO_V5_PROJECT_LIMITS.generatedOccurrences);
  counters.generatedOccurrences += generatedCount;
  if (counters.generatedOccurrences > STUDIO_V5_PROJECT_LIMITS.generatedOccurrences) {
    fail('LIMIT_GENERATED_OCCURRENCES', 'Project exceeds the 5,000-generated-occurrence limit.');
  }
  requireRecord(pattern.definition, path + '.definition');
  requireBoolean(pattern.suppressed, path + '.suppressed');
  validateOptionalRecord(pattern.extensions, path + '.extensions');
}

function detectParentOccurrenceCycles(occurrences, path) {
  const byId = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence]));
  for (const occurrence of occurrences) {
    if (occurrence.parentOccurrenceId != null && !byId.has(occurrence.parentOccurrenceId)) {
      fail('MISSING_REFERENCE', path + ' occurrence "' + occurrence.id + '" has a missing parentOccurrenceId.');
    }
    const active = new Set();
    let current = occurrence;
    while (current?.parentOccurrenceId != null) {
      if (active.has(current.id)) fail('CYCLIC_OCCURRENCE_PARENT', path + ' contains a parent-occurrence cycle at "' + current.id + '".');
      active.add(current.id);
      current = byId.get(current.parentOccurrenceId);
    }
  }
}

function validateAssembly(assembly, path, counters, projectIds, projectParameterValues) {
  requireRecord(assembly, path);
  const assemblyId = requireId(assembly.id, path + '.id');
  addUnique(projectIds.assemblyIds, assemblyId, path, 'assembly');
  requireName(assembly.name, path + '.name');
  const parameterValues = validateParameterArray(
    assembly.parameters,
    path + '.parameters',
    counters.parameters,
    projectIds.parameterIds,
    projectParameterValues,
  );

  const occurrences = requireArray(assembly.occurrences, path + '.occurrences', STUDIO_V5_PROJECT_LIMITS.occurrences, 'LIMIT_OCCURRENCES');
  counters.occurrences += occurrences.length;
  if (counters.occurrences > STUDIO_V5_PROJECT_LIMITS.occurrences) fail('LIMIT_OCCURRENCES', 'Project exceeds the 2,000-explicit-occurrence limit.');
  const occurrenceIds = new Set();
  occurrences.forEach((occurrence, index) => validateOccurrence(
    occurrence,
    path + '.occurrences[' + index + ']',
    occurrenceIds,
    projectIds.occurrenceIds,
    parameterValues,
  ));
  detectParentOccurrenceCycles(occurrences, path + '.occurrences');

  const mateIds = new Set();
  requireArray(assembly.mates, path + '.mates', STUDIO_V5_PROJECT_LIMITS.occurrences)
    .forEach((mate, index) => validateMate(
      mate,
      path + '.mates[' + index + ']',
      occurrenceIds,
      mateIds,
      projectIds.mateIds,
      parameterValues,
    ));

  const patternIds = new Set();
  requireArray(assembly.occurrencePatterns, path + '.occurrencePatterns', STUDIO_V5_PROJECT_LIMITS.occurrences)
    .forEach((pattern, index) => validateOccurrencePattern(
      pattern,
      path + '.occurrencePatterns[' + index + ']',
      occurrenceIds,
      patternIds,
      projectIds.patternIds,
      counters,
    ));

  const explodedIds = new Set();
  requireArray(assembly.explodedViews, path + '.explodedViews', 1000).forEach((view, index) => {
    const viewPath = path + '.explodedViews[' + index + ']';
    requireRecord(view, viewPath);
    const id = requireId(view.id, viewPath + '.id');
    addUnique(explodedIds, id, viewPath, 'exploded view');
    addUnique(projectIds.explodedViewIds, id, viewPath, 'project exploded view');
    requireName(view.name, viewPath + '.name');
    requireArray(view.steps, viewPath + '.steps', STUDIO_V5_PROJECT_LIMITS.occurrences)
      .forEach((step, stepIndex) => requireRecord(step, viewPath + '.steps[' + stepIndex + ']'));
    validateOptionalRecord(view.extensions, viewPath + '.extensions');
  });

  const sectionIds = new Set();
  requireArray(assembly.sectionViews, path + '.sectionViews', 1000).forEach((view, index) => {
    const viewPath = path + '.sectionViews[' + index + ']';
    requireRecord(view, viewPath);
    const id = requireId(view.id, viewPath + '.id');
    addUnique(sectionIds, id, viewPath, 'section view');
    addUnique(projectIds.sectionViewIds, id, viewPath, 'project section view');
    requireName(view.name, viewPath + '.name');
    if (!SECTION_KINDS.has(view.kind)) fail('INVALID_SECTION', viewPath + '.kind is unsupported.');
    requireRecord(view.definition, viewPath + '.definition');
    validateOptionalRecord(view.extensions, viewPath + '.extensions');
  });
  validateOptionalRecord(assembly.metadata, path + '.metadata');
  validateOptionalRecord(assembly.extensions, path + '.extensions');
}

function documentRefKey(ref) {
  return ref.kind === 'part' ? 'part:' + ref.partId : 'assembly:' + ref.assemblyId;
}

function validateResolvedDocumentRef(ref, path, projectIds) {
  if (ref.kind === 'part' && !projectIds.partIds.has(ref.partId)) fail('MISSING_REFERENCE', path + ' does not resolve to a part definition.');
  if (ref.kind === 'assembly' && !projectIds.assemblyIds.has(ref.assemblyId)) fail('MISSING_REFERENCE', path + ' does not resolve to an assembly definition.');
}

function validateAssemblyContainment(parts, assemblies, projectIds) {
  const byId = new Map(assemblies.map((assembly) => [assembly.id, assembly]));
  const partsById = new Map(parts.map((part) => [part.id, part]));
  for (const assembly of assemblies) {
    for (const [index, occurrence] of assembly.occurrences.entries()) {
      validateResolvedDocumentRef(occurrence.definition, 'assemblyDefinitions[' + assembly.id + '].occurrences[' + index + '].definition', projectIds);
      if (occurrence.parameterOverrides != null) {
        const definition = occurrence.definition.kind === 'part'
          ? partsById.get(occurrence.definition.partId)
          : byId.get(occurrence.definition.assemblyId);
        const parameterNames = new Set(definition.parameters.map((parameter) => parameter.name));
        for (const name of Object.keys(occurrence.parameterOverrides)) {
          if (!parameterNames.has(name)) {
            fail('MISSING_REFERENCE', 'assemblyDefinitions[' + assembly.id + '].occurrences[' + index + '].parameterOverrides.' + name + ' does not resolve in the component definition.');
          }
        }
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(assemblyId, chain) {
    if (visiting.has(assemblyId)) fail('CYCLIC_ASSEMBLY', 'Assembly containment cycle: ' + [...chain, assemblyId].join(' -> ') + '.');
    if (visited.has(assemblyId)) return;
    visiting.add(assemblyId);
    const assembly = byId.get(assemblyId);
    for (const occurrence of assembly.occurrences) {
      if (occurrence.definition.kind === 'assembly') visit(occurrence.definition.assemblyId, [...chain, assemblyId]);
    }
    visiting.delete(assemblyId);
    visited.add(assemblyId);
  }
  for (const assembly of assemblies) visit(assembly.id, []);
}

function base64Value(characterCode) {
  if (characterCode >= 65 && characterCode <= 90) return characterCode - 65;
  if (characterCode >= 97 && characterCode <= 122) return characterCode - 71;
  if (characterCode >= 48 && characterCode <= 57) return characterCode + 4;
  if (characterCode === 43) return 62;
  if (characterCode === 47) return 63;
  return -1;
}

function canonicalBase64DecodedBytes(data, path) {
  const maximumEncodedBytes = Math.ceil(STUDIO_V5_PROJECT_LIMITS.resourcesBytes * 4 / 3) + 4;
  if (data.length > maximumEncodedBytes || data.length % 4 !== 0) {
    fail('INVALID_RESOURCE', path + ' must be bounded canonical base64.');
  }
  if (data.length === 0) return 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const contentLength = data.length - padding;
  for (let index = 0; index < contentLength; index++) {
    if (base64Value(data.charCodeAt(index)) < 0) fail('INVALID_RESOURCE', path + ' contains a non-base64 character.');
  }
  for (let index = contentLength; index < data.length; index++) {
    if (data.charCodeAt(index) !== 61) fail('INVALID_RESOURCE', path + ' has invalid base64 padding.');
  }
  if (padding === 2 && (base64Value(data.charCodeAt(data.length - 3)) & 15) !== 0) {
    fail('INVALID_RESOURCE', path + ' has non-canonical base64 padding bits.');
  }
  if (padding === 1 && (base64Value(data.charCodeAt(data.length - 2)) & 3) !== 0) {
    fail('INVALID_RESOURCE', path + ' has non-canonical base64 padding bits.');
  }
  return data.length / 4 * 3 - padding;
}

function decodeCanonicalBase64(data, decodedByteLength) {
  const decoded = new Uint8Array(decodedByteLength);
  let outputIndex = 0;
  for (let inputIndex = 0; inputIndex < data.length; inputIndex += 4) {
    const first = base64Value(data.charCodeAt(inputIndex));
    const second = base64Value(data.charCodeAt(inputIndex + 1));
    const third = data.charCodeAt(inputIndex + 2) === 61
      ? 0
      : base64Value(data.charCodeAt(inputIndex + 2));
    const fourth = data.charCodeAt(inputIndex + 3) === 61
      ? 0
      : base64Value(data.charCodeAt(inputIndex + 3));
    if (outputIndex < decoded.length) decoded[outputIndex++] = (first << 2) | (second >>> 4);
    if (outputIndex < decoded.length) decoded[outputIndex++] = ((second & 15) << 4) | (third >>> 2);
    if (outputIndex < decoded.length) decoded[outputIndex++] = ((third & 3) << 6) | fourth;
  }
  return decoded;
}

function validateGeometryReferenceResolution(parts, assemblies, projectIds) {
  const featurePartId = new Map();
  const bodyPartId = new Map();
  const datumPartId = new Map();
  const datumKindById = new Map();
  const sketchPartId = new Map();
  const sketchById = new Map();
  for (const part of parts) {
    part.features.forEach((feature) => featurePartId.set(feature.id, part.id));
    part.bodies.forEach((body) => bodyPartId.set(body.id, part.id));
    part.referenceGeometry.forEach((datum) => {
      datumPartId.set(datum.id, part.id);
      datumKindById.set(datum.id, datum.kind);
    });
    part.sketches.forEach((sketch) => {
      sketchPartId.set(sketch.id, part.id);
      sketchById.set(sketch.id, sketch);
    });
  }
  const occurrenceById = new Map();
  const occurrenceAssemblyId = new Map();
  for (const assembly of assemblies) {
    for (const occurrence of assembly.occurrences) {
      occurrenceById.set(occurrence.id, occurrence);
      occurrenceAssemblyId.set(occurrence.id, assembly.id);
    }
  }

  function ownerPart(reference) {
    if (reference.ownerKind === 'part') return reference.ownerId;
    if (reference.ownerKind === 'body') return bodyPartId.get(reference.ownerId);
    if (reference.ownerKind === 'feature') return featurePartId.get(reference.ownerId);
    if (reference.ownerKind === 'datum') return datumPartId.get(reference.ownerId);
    if (reference.ownerKind === 'sketch') return sketchPartId.get(reference.ownerId);
    return undefined;
  }

  function validateReference(reference, path, selectedOccurrenceIds) {
    const ownerSet = reference.ownerKind === 'part'
      ? projectIds.partIds
      : reference.ownerKind === 'body'
        ? projectIds.bodyIds
        : reference.ownerKind === 'feature'
          ? projectIds.featureIds
          : reference.ownerKind === 'datum'
            ? projectIds.datumIds
            : reference.ownerKind === 'sketch'
              ? projectIds.sketchIds
          : projectIds.occurrenceIds;
    if (!ownerSet.has(reference.ownerId)) fail('MISSING_REFERENCE', path + ' does not resolve to an existing ' + reference.ownerKind + ' owner.');

    const occurrencePath = reference.occurrencePath;
    if (!occurrencePath?.length) {
      if (selectedOccurrenceIds) {
        if (reference.ownerKind !== 'occurrence' || !selectedOccurrenceIds.has(reference.ownerId)) {
          fail('INVALID_REFERENCE', path + ' must resolve through one of the mate occurrence paths.');
        }
      }
      return;
    }
    if (selectedOccurrenceIds && !selectedOccurrenceIds.has(occurrencePath[0])) {
      fail('INVALID_REFERENCE', path + '.occurrencePath must begin with one of the mate occurrences.');
    }
    for (let index = 0; index < occurrencePath.length; index++) {
      const occurrenceId = occurrencePath[index];
      const occurrence = occurrenceById.get(occurrenceId);
      if (!occurrence) fail('MISSING_REFERENCE', path + '.occurrencePath[' + index + '] does not resolve to an occurrence.');
      if (index > 0) {
        const parent = occurrenceById.get(occurrencePath[index - 1]);
        if (parent.definition.kind !== 'assembly' || parent.definition.assemblyId !== occurrenceAssemblyId.get(occurrenceId)) {
          fail('INVALID_REFERENCE', path + '.occurrencePath is not a valid nested component chain.');
        }
      }
    }
    const terminalId = occurrencePath[occurrencePath.length - 1];
    const terminal = occurrenceById.get(terminalId);
    if (reference.ownerKind === 'occurrence') {
      if (terminalId !== reference.ownerId) fail('INVALID_REFERENCE', path + '.occurrencePath does not terminate at its occurrence owner.');
      return;
    }
    const partId = ownerPart(reference);
    if (terminal.definition.kind !== 'part' || terminal.definition.partId !== partId) {
      fail('INVALID_REFERENCE', path + '.occurrencePath does not terminate at the owner part.');
    }
  }

  const exactPathMemo = new Map();
  function isExactMatePathSketch(sketchId, visiting = new Set()) {
    if (exactPathMemo.has(sketchId)) return exactPathMemo.get(sketchId);
    if (visiting.has(sketchId)) return false;
    const sketch = sketchById.get(sketchId);
    if (!sketch || sketch.extensions?.studioRole !== 'path') return false;
    const referenceCurve = sketch.extensions?.referenceCurve;
    let exact = false;
    if (!referenceCurve) {
      exact = ['polyline', 'spline'].includes(sketch.entities?.[0]?.kind);
    } else {
      const nextVisiting = new Set(visiting).add(sketchId);
      if (referenceCurve.kind === 'projected') {
        exact = isExactMatePathSketch(referenceCurve.sourceSketchId, nextVisiting);
      } else if (referenceCurve.kind === 'composite') {
        exact = referenceCurve.sourceSketchIds.every((sourceSketchId) =>
          isExactMatePathSketch(sourceSketchId, nextVisiting));
      }
    }
    exactPathMemo.set(sketchId, exact);
    return exact;
  }

  function validateAdvancedMateReference(mate, reference, path) {
    const role = reference.semanticPath?.role;
    if (mate.kind === 'path' && role === 'path') {
      if (reference.ownerKind !== 'sketch' || !isExactMatePathSketch(reference.ownerId)) {
        fail(
          'ADVANCED_MATE_REFERENCE_KIND_INVALID',
          path + ' path role must resolve to an exact polyline, spline, projected, or composite path sketch.',
        );
      }
      return;
    }
    if (reference.ownerKind !== 'datum') return;
    const allowedKinds = mate.kind === 'width' || mate.kind === 'symmetry'
      ? ['plane']
      : mate.kind === 'linear-coupler'
        ? ['axis']
        : mate.kind === 'path'
          ? ['plane', 'axis']
          : ['plane'];
    const datumKind = datumKindById.get(reference.ownerId);
    if (!allowedKinds.includes(datumKind)) {
      fail(
        'ADVANCED_MATE_REFERENCE_KIND_INVALID',
        path + ' role "' + role + '" requires a ' + allowedKinds.join(' or ')
          + ' datum; resolved "' + datumKind + '".',
      );
    }
  }

  for (const [partIndex, part] of parts.entries()) {
    for (const [sketchIndex, sketch] of part.sketches.entries()) {
      if (sketch.support != null) validateReference(sketch.support, 'partDefinitions[' + partIndex + '].sketches[' + sketchIndex + '].support');
    }
    for (const [featureIndex, feature] of part.features.entries()) {
      feature.inputRefs.forEach((reference, referenceIndex) => validateReference(
        reference,
        'partDefinitions[' + partIndex + '].features[' + featureIndex + '].inputRefs[' + referenceIndex + ']',
      ));
    }
  }
  function validateMechanicalMateReference(mate, reference, path) {
    const role = reference.semanticPath?.role;
    const datumKind = datumKindById.get(reference.ownerId);
    if (reference.ownerKind !== 'datum' || datumKind !== 'axis') {
      fail(
        'MECHANICAL_MATE_REFERENCE_KIND_INVALID',
        path + ' role "' + role + '" requires an axis datum; resolved "'
          + (reference.ownerKind === 'datum' ? datumKind : reference.ownerKind) + '".',
      );
    }
  }

  for (const [assemblyIndex, assembly] of assemblies.entries()) {
    for (const [mateIndex, mate] of assembly.mates.entries()) {
      const selectedOccurrenceIds = new Set(mate.occurrenceIds);
      mate.references.forEach((reference, referenceIndex) => {
        const referencePath = 'assemblyDefinitions[' + assemblyIndex + '].mates[' + mateIndex + '].references[' + referenceIndex + ']';
        validateReference(reference, referencePath, selectedOccurrenceIds);
        if (isStudioAdvancedMateKind(mate.kind)) {
          validateAdvancedMateReference(mate, reference, referencePath);
        }
        if (isStudioMechanicalMateKind(mate.kind)) {
          validateMechanicalMateReference(mate, reference, referencePath);
        }
      });
    }
  }
}

function validateResource(resource, path, seenIds, counters) {
  requireRecord(resource, path);
  const id = requireId(resource.id, path + '.id');
  addUnique(seenIds, id, path, 'resource');
  requireName(resource.name, path + '.name');
  if (typeof resource.mimeType !== 'string' || !RESOURCE_MIME_TYPES.has(resource.mimeType)) fail('INVALID_RESOURCE', path + '.mimeType is not allowed.');
  const byteLength = requireInteger(resource.byteLength, path + '.byteLength', 0, STUDIO_V5_PROJECT_LIMITS.resourcesBytes);
  counters.resourceBytes += byteLength;
  if (counters.resourceBytes > STUDIO_V5_PROJECT_LIMITS.resourcesBytes) fail('LIMIT_RESOURCE_BYTES', 'Project resources exceed the 100 MB decoded limit.');
  let decodedByteLength = null;
  if (resource.data != null) {
    if (resource.encoding !== 'base64' || typeof resource.data !== 'string') {
      fail('INVALID_RESOURCE', path + '.data must be canonical base64 with encoding "base64".');
    }
    decodedByteLength = canonicalBase64DecodedBytes(resource.data, path + '.data');
    if (decodedByteLength !== byteLength) fail('INVALID_RESOURCE', path + '.byteLength does not match embedded base64 data.');
  } else if (resource.encoding != null) fail('INVALID_RESOURCE', path + '.encoding requires embedded data.');
  validateOptionalRecord(resource.extensions, path + '.extensions');
  const healing = optionalStepHealingEvidence(resource.extensions, path + '.extensions');
  if (healing) {
    if (resource.encoding !== 'base64' || typeof resource.data !== 'string' || decodedByteLength === null) {
      failStepHealing(path + '.data', 'must embed the exact healed BREP as canonical base64.');
    }
    if (decodedByteLength === 0) {
      failStepHealing(path + '.data', 'must contain a non-empty exact healed BREP.');
    }
    const decoded = decodeCanonicalBase64(resource.data, decodedByteLength);
    const actualSha256 = studioSha256BytesHex(decoded);
    if (healing.healedBrepSha256 !== actualSha256) {
      failStepHealing(
        path + '.extensions.studioImportedStep.healing.healedBrepSha256',
        'must equal the SHA-256 digest of the exact embedded resource bytes.',
      );
    }
  }
}

function validateStepHealingEvidenceLinks(parts, resources) {
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  for (const [partIndex, part] of parts.entries()) {
    for (const [featureIndex, feature] of part.features.entries()) {
      if (feature.type !== 'imported-step') continue;
      const featurePath = 'project.partDefinitions[' + partIndex + '].features[' + featureIndex + ']';
      const featureImportedStep = feature.extensions?.studioImportedStep;
      const featureHasHealing = isRecord(featureImportedStep)
        && Object.prototype.hasOwnProperty.call(featureImportedStep, 'healing');
      const resource = resourcesById.get(featureImportedStep?.resourceId);
      if (!resource) continue;
      const resourceImportedStep = resource.extensions?.studioImportedStep;
      const resourceHasHealing = isRecord(resourceImportedStep)
        && Object.prototype.hasOwnProperty.call(resourceImportedStep, 'healing');
      if (featureHasHealing !== resourceHasHealing) {
        failStepHealing(
          featurePath + '.extensions.studioImportedStep.healing',
          'must be present on both the imported-step feature and its resource.',
        );
      }
      if (featureHasHealing
          && stableStringify(featureImportedStep.healing) !== stableStringify(resourceImportedStep.healing)) {
        failStepHealing(
          featurePath + '.extensions.studioImportedStep.healing',
          'must exactly equal resource "' + resource.id + '" healing evidence.',
        );
      }
    }
  }
}

export function prepareStudioV5Project(candidate) {
  if (!isRecord(candidate)) fail('INVALID_PROJECT', 'Project root must be an object.');
  validateJsonTree(candidate);
  if (documentBytesWithoutEmbeddedResources(candidate) > STUDIO_V5_PROJECT_LIMITS.bytes) {
    fail('LIMIT_BYTES', 'Project exceeds the 20 MB canonical JSON limit before embedded resources.');
  }
  if (candidate.schemaVersion !== STUDIO_V5_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', 'PartMode accepts schema 5 projects only.');
  requireId(candidate.projectId, 'project.projectId');
  requireName(candidate.name, 'project.name');
  if (candidate.units !== 'mm' && candidate.units !== 'in') fail('INVALID_UNITS', 'project.units must be mm or in.');

  const counters = {
    sketchEntities: 0,
    occurrences: 0,
    generatedOccurrences: 0,
    resourceBytes: 0,
    parameters: { count: 0 },
  };
  const projectIds = {
    partIds: new Set(),
    assemblyIds: new Set(),
    parameterIds: new Set(),
    datumIds: new Set(),
    sketchIds: new Set(),
    sketchBlockDefinitionIds: new Set(),
    sketchBlockInstanceIds: new Set(),
    sketchRelationIds: new Set(),
    featureIds: new Set(),
    bodyIds: new Set(),
    occurrenceIds: new Set(),
    mateIds: new Set(),
    patternIds: new Set(),
    explodedViewIds: new Set(),
    sectionViewIds: new Set(),
  };
  const projectParameterValues = validateParameterArray(
    candidate.parameters,
    'project.parameters',
    counters.parameters,
    projectIds.parameterIds,
  );

  const materialEntries = requireArray(candidate.materials, 'project.materials', STUDIO_V5_PROJECT_LIMITS.materials, 'LIMIT_MATERIALS');
  const materialIds = new Set();
  materialEntries.forEach((material, index) => validateMaterial(material, 'project.materials[' + index + ']', materialIds));

  const parts = requireArray(candidate.partDefinitions, 'project.partDefinitions', STUDIO_V5_PROJECT_LIMITS.partDefinitions, 'LIMIT_PARTS');
  parts.forEach((part, index) => validatePart(
    part,
    'project.partDefinitions[' + index + ']',
    counters,
    projectIds,
    materialIds,
    projectParameterValues,
  ));

  const assemblies = requireArray(candidate.assemblyDefinitions, 'project.assemblyDefinitions', STUDIO_V5_PROJECT_LIMITS.assemblyDefinitions, 'LIMIT_ASSEMBLIES');
  assemblies.forEach((assembly, index) => validateAssembly(
    assembly,
    'project.assemblyDefinitions[' + index + ']',
    counters,
    projectIds,
    projectParameterValues,
  ));

  if (parts.length + assemblies.length === 0) fail('INVALID_PROJECT', 'Project must contain at least one part or assembly definition.');
  validateDocumentRef(candidate.rootDocument, 'project.rootDocument');
  validateResolvedDocumentRef(candidate.rootDocument, 'project.rootDocument', projectIds);
  validateAssemblyContainment(parts, assemblies, projectIds);
  validateGeometryReferenceResolution(parts, assemblies, projectIds);

  const resourceEntries = requireArray(candidate.resources, 'project.resources', STUDIO_V5_PROJECT_LIMITS.resources, 'LIMIT_RESOURCES');
  const resourceIds = new Set();
  resourceEntries.forEach((resource, index) => validateResource(resource, 'project.resources[' + index + ']', resourceIds, counters));
  try {
    createStudioProjectBundleManifest(candidate);
  } catch (error) {
    if (error instanceof StudioProjectBundleError) fail(error.code, error.message);
    throw error;
  }
  validateStepHealingEvidenceLinks(parts, resourceEntries);
  requireRecord(candidate.metadata, 'project.metadata');
  validateOptionalRecord(candidate.extensions, 'project.extensions');

  // Configuration sets depend on already-validated part parameters and feature
  // IDs. Keep them outside the core part records so selecting a row never
  // rewrites the authored feature history, and canonicalize only after every
  // referenced part has passed the schema boundary above.
  const prepared = clone(candidate);
  const configurationSets = requireArray(
    candidate.partConfigurationSets === undefined ? [] : candidate.partConfigurationSets,
    'project.partConfigurationSets',
    STUDIO_V5_PROJECT_LIMITS.partDefinitions,
    'LIMIT_CONFIGURATION_SETS',
  );
  const configuredPartIds = new Set();
  prepared.partConfigurationSets = configurationSets.map((configurationSet) => {
    const normalized = normalizeStudioPartConfigurationSet(prepared, configurationSet);
    if (configuredPartIds.has(normalized.partId)) {
      throw new StudioPartConfigurationError(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.duplicatePart,
        'Part "' + normalized.partId + '" has more than one configuration set.',
        { partId: normalized.partId, path: 'project.partConfigurationSets' },
      );
    }
    configuredPartIds.add(normalized.partId);
    return normalized;
  }).sort((left, right) => left.partId < right.partId ? -1 : left.partId > right.partId ? 1 : 0);

  try {
    assertStudioSmartFastenersProject(prepared);
  } catch (error) {
    if (error instanceof StudioSmartFastenerError) fail(error.code, error.message);
    throw error;
  }

  try {
    assertStudioAssemblyFeaturesProject(prepared);
  } catch (error) {
    if (error instanceof StudioAssemblyFeatureError) fail(error.code, error.message);
    throw error;
  }

  return prepared;
}

export function parseStudioV5Project(text) {
  if (typeof text !== 'string') fail('INVALID_FILE', 'Project file must be text.');
  if (utf8Bytes(text, STUDIO_V5_PROJECT_LIMITS.fileBytes) > STUDIO_V5_PROJECT_LIMITS.fileBytes) fail('LIMIT_FILE_BYTES', 'Project file exceeds the 160 MB encoded limit.');
  let candidate;
  try {
    candidate = JSON.parse(text);
  } catch {
    fail('INVALID_JSON', 'Project file is not valid JSON.');
  }
  return prepareStudioV5Project(candidate);
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function stableHash(value) {
  const source = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

function cleanIdFragment(value, fallback) {
  const cleaned = String(value || '').trim().replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
  return cleaned && ID_PATTERN.test(cleaned) ? cleaned : fallback;
}

function currentProfileShapes(featureId, shapes) {
  if (!Array.isArray(shapes)) return shapes;
  return shapes.map((source, shapeIndex) => {
    const shape = clone(source);
    const shapeId = Object.prototype.hasOwnProperty.call(shape, 'id')
      ? shape.id
      : featureId + '-profile-' + (shapeIndex + 1);
    shape.id = shapeId;
    if (shape.kind === 'poly' && !Object.prototype.hasOwnProperty.call(shape, 'edgeIds')) {
      const points = Array.isArray(shape.pts) ? shape.pts : [];
      shape.edgeIds = points.map((_point, edgeIndex) =>
        shapeId + '-edge-' + (edgeIndex + 1));
    }
    return shape;
  });
}

function currentResultPolicy(feature, index, bodyId) {
  if (isRecord(feature.resultPolicy)) return clone(feature.resultPolicy);
  if (feature.type === 'cut') {
    if (index === 0) fail('INVALID_FEATURE', 'Cut cannot be the first solid feature because it has no target body.');
    return { kind: 'subtract', targetBodyIds: [bodyId], keepTools: false };
  }
  if (index === 0) return { kind: 'new-body', bodyName: 'Body 1' };
  return { kind: 'add', targetBodyIds: [bodyId] };
}

export function createStudioV5PartProject(options = {}) {
  requireRecord(options, 'options');
  const name = typeof options.name === 'string' && options.name.trim()
    ? options.name.trim().slice(0, 200)
    : 'Untitled part';
  const units = options.units === 'in' ? 'in' : 'mm';
  const sourceParameters = requireArray(
    options.parameters === undefined ? [] : options.parameters,
    'options.parameters',
    STUDIO_V5_PROJECT_LIMITS.parameters,
    'LIMIT_PARAMETERS',
  );
  const sourceFeatures = requireArray(
    options.features === undefined ? [] : options.features,
    'options.features',
    STUDIO_V5_PROJECT_LIMITS.features,
    'LIMIT_FEATURES',
  );
  const fingerprint = stableHash({ name, units, parameters: sourceParameters, features: sourceFeatures });
  const projectId = options.projectId || 'project-' + fingerprint;
  const partId = options.partId || projectId + '-part';
  const bodyId = options.bodyId || projectId + '-body';
  requireId(projectId, 'options.projectId');
  requireId(partId, 'options.partId');
  requireId(bodyId, 'options.bodyId');

  const parameters = sourceParameters.map((source, index) => {
    requireRecord(source, 'options.parameters[' + index + ']');
    const parameter = clone(source);
    parameter.id = parameter.id || projectId + '-param-' + cleanIdFragment(parameter.name, String(index + 1));
    if (!Object.prototype.hasOwnProperty.call(parameter, 'value')) {
      fail('INVALID_PARAMETER', 'options.parameters[' + index + '].value is required.');
    }
    return parameter;
  });

  const features = sourceFeatures.map((source, index) => {
    requireRecord(source, 'options.features[' + index + ']');
    const feature = clone(source);
    feature.id = feature.id || projectId + '-feature-' + (index + 1);
    feature.name = typeof feature.name === 'string' && feature.name.trim()
      ? feature.name.trim().slice(0, 200)
      : String(feature.type || 'Feature') + ' ' + (index + 1);
    feature.suppressed = feature.suppressed === true;
    feature.inputRefs = Array.isArray(feature.inputRefs) ? feature.inputRefs : [];
    feature.resultPolicy = currentResultPolicy(feature, index, bodyId);
    if (feature.resultPolicy.kind === 'new-body') feature.createdBodyId = feature.createdBodyId || bodyId;
    if ((feature.type === 'extrude' || feature.type === 'cut')
      && !Object.prototype.hasOwnProperty.call(feature, 'through')) {
      feature.through = false;
    }
    if (Array.isArray(feature.sketch?.shapes)) {
      feature.sketch.shapes = currentProfileShapes(feature.id, feature.sketch.shapes);
    }
    delete feature.error;
    return feature;
  });

  const featureOrder = features.map((feature) => feature.id);
  const bodies = features.length ? [{
    id: bodyId,
    name: options.bodyName || 'Body 1',
    kind: 'solid',
    createdByFeatureId: features[0].id,
    featureIds: [...featureOrder],
    visible: true,
    suppressed: false,
  }] : [];

  return prepareStudioV5Project({
    schemaVersion: STUDIO_V5_SCHEMA_VERSION,
    projectId,
    name,
    units,
    parameters,
    materials: clone(options.materials || []),
    partDefinitions: [{
      id: partId,
      name,
      parameters: clone(options.partParameters || []),
      referenceGeometry: clone(options.referenceGeometry || []),
      sketches: clone(options.sketches || []),
      sketchBlockDefinitions: clone(options.sketchBlockDefinitions || []),
      bodies,
      bodyPatterns: clone(options.bodyPatterns || []),
      features,
      featureOrder,
      metadata: {
        activeBodyId: bodies[0]?.id || null,
        ...clone(options.partMetadata || {}),
      },
      extensions: clone(options.partExtensions || {}),
    }],
    assemblyDefinitions: [],
    rootDocument: { kind: 'part', partId },
    resources: clone(options.resources || []),
    metadata: clone(options.metadata || {}),
    extensions: clone(options.extensions || {}),
  });
}

export function createEmptyStudioV5PartProject(options = {}) {
  const seed = {
    projectId: options.projectId || 'project-new',
    name: options.name || 'Untitled part',
    units: options.units || 'mm',
  };
  const fingerprint = stableHash(seed);
  if (options.projectId != null) requireId(options.projectId, 'options.projectId');
  const projectId = options.projectId || 'project-new-' + fingerprint;
  const partId = 'part-new-' + fingerprint;
  return prepareStudioV5Project({
    schemaVersion: STUDIO_V5_SCHEMA_VERSION,
    projectId,
    name: seed.name,
    units: seed.units,
    parameters: [],
    materials: [],
    partDefinitions: [{
      id: partId,
      name: seed.name,
      parameters: [],
      referenceGeometry: [],
      sketches: [],
      sketchBlockDefinitions: [],
      bodies: [],
      bodyPatterns: [],
      features: [],
      featureOrder: [],
    }],
    assemblyDefinitions: [],
    rootDocument: { kind: 'part', partId },
    resources: [],
    metadata: {},
  });
}

export function studioV5DocumentRefKey(ref) {
  validateDocumentRef(ref, 'documentRef');
  return documentRefKey(ref);
}
