import { STUDIO_HOLE_WIZARD_ROWS } from './studio-hole-wizard.js';

// Source-owned ISO-metric thread contract. A thread binds an external or
// internal recipe to one persistent exact cylindrical face and leaves its
// world axis and support interval to the production kernel. It is not
// manufacturing certification or a substitute for licensed tolerance data.

export const STUDIO_THREAD_SCHEMA_V2 = 'partmode.thread/v2';
export const STUDIO_THREAD_POLICY_V2 = 'exact-cylindrical-face-thread-v1';
export const STUDIO_THREAD_EVIDENCE_SCHEMA = 'partmode.thread-evidence/v1';
export const STUDIO_THREAD_SUPPORT_POLICY = 'persistent-named-cylindrical-face-v1';
export const STUDIO_THREAD_PROFILE_POLICY = 'iso-68-1-truncated-profile-v1';
export const STUDIO_THREAD_TOLERANCE_POLICY = 'iso-965-maximum-material-reference-v1';
export const STUDIO_THREAD_RUNOUT_POLICY = 'partmode-explicit-axial-transition-v1';
export const STUDIO_THREAD_MODELED_TURN_LIMIT = 7;
export const STUDIO_THREAD_COSMETIC_TURN_LIMIT = 100;
export const STUDIO_THREAD_MODES = Object.freeze(['cosmetic', 'modeled']);
export const STUDIO_THREAD_HANDEDNESS = Object.freeze(['right', 'left']);
export const STUDIO_THREAD_KINDS = Object.freeze(['external', 'internal']);
export const STUDIO_THREAD_SPAN_MODES = Object.freeze(['fraction', 'offset']);
export const STUDIO_THREAD_RUNOUT_FORMS = Object.freeze(['full-profile', 'one-pitch-taper']);
export const STUDIO_THREAD_TOLERANCE_CLASSES = Object.freeze({
  external: Object.freeze(['6g']),
  internal: Object.freeze(['6H']),
});

export const STUDIO_THREAD_SOURCES = Object.freeze([
  Object.freeze({
    id: 'iso68-1',
    standard: 'ISO 68-1',
    edition: '2023',
    title: 'ISO general purpose screw threads - Basic and design profiles - Part 1: Metric screw threads',
    url: 'https://www.iso.org/standard/85107.html',
    status: 'published 2023-10; corrected 2024-03',
    verifiedOn: '2026-08-02',
  }),
  Object.freeze({
    id: 'iso261',
    standard: 'ISO 261',
    edition: '1998',
    title: 'ISO general purpose metric screw threads - General plan',
    url: 'https://www.iso.org/standard/4165.html',
    status: 'published; confirmed 2024',
    verifiedOn: '2026-08-02',
  }),
  Object.freeze({
    id: 'iso724',
    standard: 'ISO 724',
    edition: '2023',
    title: 'ISO general purpose metric screw threads - Basic dimensions',
    url: 'https://www.iso.org/standard/85104.html',
    status: 'published',
    verifiedOn: '2026-08-02',
  }),
]);

const STUDIO_THREAD_V2_ONLY_SOURCES = Object.freeze([
  Object.freeze({
    id: 'iso965-1',
    standard: 'ISO 965-1',
    edition: '2026',
    title: 'ISO general purpose metric screw threads - Tolerances - Part 1: Principles and basic data',
    url: 'https://www.iso.org/standard/87889.html',
    status: 'published 2026-04',
    verifiedOn: '2026-08-03',
  }),
  Object.freeze({
    id: 'iso965-2',
    standard: 'ISO 965-2',
    edition: '2024',
    title: 'ISO general purpose metric screw threads - Tolerances - Part 2: Limits of sizes for tolerance classes 6H and 6g',
    url: 'https://www.iso.org/standard/87890.html',
    status: 'published 2024-11',
    verifiedOn: '2026-08-03',
  }),
]);

export const STUDIO_THREAD_V2_SOURCES = Object.freeze([
  ...STUDIO_THREAD_SOURCES,
  ...STUDIO_THREAD_V2_ONLY_SOURCES,
]);

export const STUDIO_THREAD_ROWS = Object.freeze(STUDIO_HOLE_WIZARD_ROWS.map((entry) => Object.freeze({
  designation: entry.designation,
  majorDiameter: entry.threadMajor,
  coarsePitch: entry.coarsePitch,
})));

const V2_LIMITATIONS = Object.freeze([
  'This bounded slice supports right- or left-hand external and internal ISO-metric coarse threads on one persistent named exact cylindrical face.',
  `Modeled geometry is limited to ${STUDIO_THREAD_MODELED_TURN_LIMIT} resolved turns and requires at least one full pitch, or two pitches for one-pitch start and end runouts, of exact cylindrical support.`,
  `Cosmetic viewport helices are limited to ${STUDIO_THREAD_COSMETIC_TURN_LIMIT} resolved turns so their analytic representation remains non-aliased.`,
  'The support axis, origin, radius, and available axial interval are derived from current exact topology; they are not authored coordinates.',
  'Tapered, conical, pipe, inch, multi-start, and custom-pitch threads are not generated.',
  'This is reference content, not manufacturing certification. Verify released dimensions and fits against licensed standards.',
]);

const clone = (value) => structuredClone(value);
const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const sameCanonicalJson = (left, right) => JSON.stringify(canonicalJson(left, 'left')) === JSON.stringify(canonicalJson(right, 'right'));

export class StudioThreadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StudioThreadError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new StudioThreadError(code, message);
};

function canonicalJson(value, path, depth = 0) {
  if (depth > 24) fail('THREAD_REFERENCE_INVALID', path + ' exceeds the supported nesting depth.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('THREAD_REFERENCE_INVALID', path + ' must contain finite numbers.');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) fail('THREAD_REFERENCE_INVALID', path + ' contains too many values.');
    return value.map((entry, index) => canonicalJson(entry, `${path}[${index}]`, depth + 1));
  }
  if (!isRecord(value)) fail('THREAD_REFERENCE_INVALID', path + ' must be JSON-safe.');
  const keys = Object.keys(value).sort();
  if (keys.length > 128) fail('THREAD_REFERENCE_INVALID', path + ' contains too many fields.');
  const result = {};
  for (const key of keys) {
    if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor') {
      fail('THREAD_REFERENCE_INVALID', path + ' contains an unsafe field name.');
    }
    result[key] = canonicalJson(value[key], `${path}.${key}`, depth + 1);
  }
  return result;
}

function positiveFinite(value, path) {
  if (!finite(value) || !(value > 0)) fail('THREAD_DIMENSION_INVALID', path + ' must be a positive finite millimetre value.');
  return value;
}

function canonicalThreadFace(face, path = 'targetFace') {
  if (!isRecord(face)) fail('THREAD_FACE_REFERENCE_INVALID', path + ' must be an exact persistent face reference.');
  if (typeof face.name !== 'string' || !face.name.trim() || face.name.length > 4096) {
    fail('THREAD_FACE_REFERENCE_INVALID', path + '.name must be a non-empty persistent topology name.');
  }
  if (!isRecord(face.sig)) fail('THREAD_FACE_REFERENCE_INVALID', path + '.sig must be an exact cylindrical-face signature.');
  const sig = canonicalJson(face.sig, path + '.sig');
  // UI selections carry a transport-only `kind: "face"` discriminator. The
  // persistent topology reference stores the analytic signature itself, just
  // like cadUiStoredTopologyReference, so UI and typed callers canonicalize to
  // identical bytes.
  delete sig.kind;
  if (Object.keys(sig).length === 0) {
    fail('THREAD_FACE_REFERENCE_INVALID', path + '.sig must retain non-empty exact cylindrical-face evidence.');
  }
  const declaredKind = sig.topologyKind ?? sig.geomType ?? sig.surfaceType;
  if (declaredKind !== undefined && !['face', 'CYLINDRE', 'cylinder', 'cylindrical-face'].includes(declaredKind)) {
    fail('THREAD_FACE_REFERENCE_INVALID', path + '.sig must describe a cylindrical face.');
  }
  return { name: face.name, sig };
}

function canonicalThreadSpan(span = { mode: 'fraction', start: 0, end: 1 }) {
  if (!isRecord(span) || !STUDIO_THREAD_SPAN_MODES.includes(span.mode)) {
    fail('THREAD_SPAN_INVALID', 'Thread span mode must be fraction or offset.');
  }
  if (span.mode === 'fraction') {
    if (!finite(span.start) || !finite(span.end) || span.start < 0 || span.end > 1 || !(span.end > span.start)) {
      fail('THREAD_SPAN_INVALID', 'Fractional thread span requires 0 <= start < end <= 1.');
    }
    return { mode: 'fraction', start: span.start, end: span.end };
  }
  if (!finite(span.startMm) || !finite(span.endMm) || span.startMm < 0 || !(span.endMm > span.startMm) || span.endMm > 100_000) {
    fail('THREAD_SPAN_INVALID', 'Offset thread span requires 0 <= startMm < endMm <= 100000.');
  }
  return { mode: 'offset', startMm: span.startMm, endMm: span.endMm };
}

function canonicalThreadRunout(runout = 'one-pitch-taper') {
  const form = typeof runout === 'string' ? runout : runout?.form;
  if (!STUDIO_THREAD_RUNOUT_FORMS.includes(form)) {
    fail('THREAD_RUNOUT_INVALID', 'Thread runout form must be full-profile or one-pitch-taper.');
  }
  const tapered = form === 'one-pitch-taper';
  return {
    form,
    policy: STUDIO_THREAD_RUNOUT_POLICY,
    startTurns: tapered ? 1 : 0,
    endTurns: tapered ? 1 : 0,
    construction: tapered
      ? 'partmode-linear-profile-scale-over-one-pitch'
      : 'constant-full-profile',
    standardsConformance: 'not-claimed',
  };
}

function studioThreadProfile(threadKind, row) {
  const H = Math.sqrt(3) * row.coarsePitch / 2;
  const basicDiameters = threadKind === 'external'
    ? {
        major: row.majorDiameter,
        pitch: row.majorDiameter - 3 * H / 4,
        minor: row.majorDiameter - 17 * H / 12,
      }
    : {
        major: row.majorDiameter,
        pitch: row.majorDiameter - 3 * H / 4,
        minor: row.majorDiameter - 5 * H / 4,
      };
  return {
    policy: STUDIO_THREAD_PROFILE_POLICY,
    includedAngleDegrees: 60,
    fundamentalTriangleHeight: H,
    basicDiameters,
    crest: {
      form: 'flat',
      truncationHeight: threadKind === 'external' ? H / 8 : H / 4,
    },
    root: {
      form: threadKind === 'external' ? 'rounded' : 'flat',
      truncationHeight: threadKind === 'external' ? H / 4 : H / 8,
      radius: threadKind === 'external' ? H / 6 : 0,
    },
  };
}

function studioThreadTolerance(threadKind, toleranceClass, row, profile) {
  const expectedClass = threadKind === 'external' ? '6g' : '6H';
  if (toleranceClass !== expectedClass) {
    fail('THREAD_TOLERANCE_CLASS_UNSUPPORTED', `${threadKind} ISO-metric threads currently require tolerance class ${expectedClass}.`);
  }
  // ISO position g has a negative fundamental deviation. Position H has a
  // zero lower deviation. These reference-only maximum-material boundaries are
  // deterministic construction evidence, not a substitute for licensed limit
  // tables, gauging, or manufacturing certification.
  const fundamentalDeviationMicrometres = threadKind === 'external'
    ? -(15 + 11 * row.coarsePitch)
    : 0;
  const shiftMm = fundamentalDeviationMicrometres / 1000;
  return {
    policy: STUDIO_THREAD_TOLERANCE_POLICY,
    class: toleranceClass,
    grade: 6,
    position: threadKind === 'external' ? 'g' : 'H',
    fundamentalDeviationMicrometres,
    allowanceMm: Math.abs(shiftMm),
    maximumMaterialRepresentative: {
      majorDiameter: profile.basicDiameters.major + shiftMm,
      pitchDiameter: profile.basicDiameters.pitch + shiftMm,
      minorDiameter: profile.basicDiameters.minor + shiftMm,
    },
  };
}

export function getStudioThreadRow(designation) {
  if (typeof designation !== 'string') return null;
  return STUDIO_THREAD_ROWS.find((entry) => entry.designation === designation) || null;
}

export function studioThreadV2Definition({
  mode,
  threadKind,
  designation,
  handedness = 'right',
  toleranceClass = threadKind === 'internal' ? '6H' : '6g',
  span = { mode: 'fraction', start: 0, end: 1 },
  runout = 'one-pitch-taper',
} = {}) {
  if (!STUDIO_THREAD_MODES.includes(mode)) fail('THREAD_MODE_UNSUPPORTED', `Unsupported thread mode "${String(mode)}".`);
  if (!STUDIO_THREAD_KINDS.includes(threadKind)) fail('THREAD_KIND_UNSUPPORTED', `Unsupported thread kind "${String(threadKind)}".`);
  if (!STUDIO_THREAD_HANDEDNESS.includes(handedness)) fail('THREAD_HANDEDNESS_UNSUPPORTED', `Unsupported thread handedness "${String(handedness)}".`);
  const row = getStudioThreadRow(designation);
  if (!row) fail('THREAD_SIZE_UNSUPPORTED', `Unsupported thread size "${String(designation)}".`);
  const profile = studioThreadProfile(threadKind, row);
  const tolerance = studioThreadTolerance(threadKind, toleranceClass, row, profile);
  return {
    schema: STUDIO_THREAD_SCHEMA_V2,
    version: 2,
    policy: STUDIO_THREAD_POLICY_V2,
    mode,
    threadKind,
    designation: row.designation,
    handedness,
    toleranceClass,
    majorDiameter: row.majorDiameter,
    coarsePitch: row.coarsePitch,
    profile,
    tolerance,
    runout: canonicalThreadRunout(runout),
    span: canonicalThreadSpan(span),
    modeledTurnLimit: STUDIO_THREAD_MODELED_TURN_LIMIT,
    cosmeticTurnLimit: STUDIO_THREAD_COSMETIC_TURN_LIMIT,
    sourceIds: STUDIO_THREAD_V2_SOURCES.map((entry) => entry.id),
    sources: clone(STUDIO_THREAD_V2_SOURCES),
    complianceStatus: 'reference-content-not-certified',
    limitations: [...V2_LIMITATIONS],
  };
}

export function assertStudioThreadV2Definition(definition, path = 'threadDefinition') {
  if (!isRecord(definition) || definition.schema !== STUDIO_THREAD_SCHEMA_V2 || definition.support !== undefined) {
    fail('THREAD_RECIPE_INVALID', path + ' must be a support-independent partmode.thread/v2 definition.');
  }
  const expected = studioThreadV2Definition({
    mode: definition.mode,
    threadKind: definition.threadKind,
    designation: definition.designation,
    handedness: definition.handedness,
    toleranceClass: definition.toleranceClass,
    span: definition.span,
    runout: definition.runout,
  });
  if (!sameCanonicalJson(definition, expected)) {
    fail('THREAD_RECIPE_INVALID', path + ' does not match the source-owned exact cylindrical-thread definition.');
  }
  return clone(expected);
}

export function createStudioThreadV2Extension({
  bodyId,
  targetFace,
  mode,
  threadKind,
  designation,
  handedness = 'right',
  toleranceClass = threadKind === 'internal' ? '6H' : '6g',
  span = { mode: 'fraction', start: 0, end: 1 },
  runout = 'one-pitch-taper',
} = {}) {
  if (typeof bodyId !== 'string' || !bodyId.trim()) fail('THREAD_TARGET_INVALID', 'Thread target body ID is required.');
  const definition = studioThreadV2Definition({
    mode,
    threadKind,
    designation,
    handedness,
    toleranceClass,
    span,
    runout,
  });
  return {
    ...definition,
    support: {
      policy: STUDIO_THREAD_SUPPORT_POLICY,
      bodyId,
      face: canonicalThreadFace(targetFace),
    },
  };
}

export function assertStudioThreadV2Extension(extension, path = 'feature.extensions.thread') {
  if (!isRecord(extension) || extension.schema !== STUDIO_THREAD_SCHEMA_V2) {
    fail('THREAD_RECIPE_INVALID', path + ' must be a partmode.thread/v2 object.');
  }
  if (!isRecord(extension.support) || extension.support.policy !== STUDIO_THREAD_SUPPORT_POLICY) {
    fail('THREAD_RECIPE_INVALID', path + '.support must use the persistent named cylindrical-face policy.');
  }
  const expected = createStudioThreadV2Extension({
    bodyId: extension.support.bodyId,
    targetFace: extension.support.face,
    mode: extension.mode,
    threadKind: extension.threadKind,
    designation: extension.designation,
    handedness: extension.handedness,
    toleranceClass: extension.toleranceClass,
    span: extension.span,
    runout: extension.runout,
  });
  if (!sameCanonicalJson(extension, expected)) {
    fail('THREAD_RECIPE_INVALID', path + ' does not match the source-owned exact cylindrical-thread recipe.');
  }
  return clone(expected);
}

export function studioThreadV2InputRefs(bodyId, targetFace) {
  if (typeof bodyId !== 'string' || !bodyId.trim()) fail('THREAD_TARGET_INVALID', 'Thread target body ID is required.');
  const face = canonicalThreadFace(targetFace);
  return [
    {
      ownerKind: 'body',
      ownerId: bodyId,
      semanticPath: { role: 'target-body' },
      signature: { role: 'target-body' },
    },
    {
      ownerKind: 'body',
      ownerId: bodyId,
      semanticPath: { role: 'target-face', topologyKind: 'face', name: face.name },
      signature: clone(face.sig),
    },
  ];
}

export function studioThreadResolveAxialSpan(definition, supportLengthMm) {
  const normalized = definition?.support
    ? assertStudioThreadV2Extension(definition)
    : assertStudioThreadV2Definition(definition);
  if (!normalized || normalized.schema !== STUDIO_THREAD_SCHEMA_V2) {
    fail('THREAD_RECIPE_INVALID', 'Axial span resolution requires a partmode.thread/v2 definition.');
  }
  const supportLength = positiveFinite(supportLengthMm, 'supportLengthMm');
  const span = normalized.span;
  const startMm = span.mode === 'fraction' ? span.start * supportLength : span.startMm;
  const endMm = span.mode === 'fraction' ? span.end * supportLength : span.endMm;
  const tolerance = Math.max(1e-9, supportLength * 1e-9);
  if (startMm < -tolerance || endMm > supportLength + tolerance || !(endMm > startMm + tolerance)) {
    fail('THREAD_SPAN_OUTSIDE_SUPPORT', 'Thread span must remain inside the current exact cylindrical-face interval.');
  }
  const lengthMm = endMm - startMm;
  const turnCount = lengthMm / normalized.coarsePitch;
  const minimumTurns = Math.max(1, normalized.runout.startTurns + normalized.runout.endTurns);
  if (turnCount < minimumTurns - 1e-9) {
    fail(
      'THREAD_SPAN_TOO_SHORT',
      normalized.runout.form === 'one-pitch-taper'
        ? 'One-pitch start and end runouts require at least two full pitches so their ramps do not overlap.'
        : 'Thread span must contain at least one full pitch.',
    );
  }
  if (normalized.mode === 'modeled' && turnCount > normalized.modeledTurnLimit + 1e-9) {
    fail('THREAD_TURN_COUNT_INVALID', `Modeled thread span exceeds the ${normalized.modeledTurnLimit}-turn practical ceiling.`);
  }
  if (normalized.mode === 'cosmetic' && turnCount > normalized.cosmeticTurnLimit + 1e-9) {
    fail('THREAD_TURN_COUNT_INVALID', `Cosmetic thread span exceeds the ${normalized.cosmeticTurnLimit}-turn viewport ceiling.`);
  }
  return {
    startMm: Math.max(0, startMm),
    endMm: Math.min(supportLength, endMm),
    lengthMm,
    turnCount,
    fullTurnCount: Math.floor(turnCount + 1e-9),
  };
}

export function assertStudioThreadExtension(extension, path = 'feature.extensions.thread') {
  return assertStudioThreadV2Extension(extension, path);
}

export function assertStudioThreadFeature(feature, path = 'feature') {
  const definition = assertStudioThreadExtension(feature?.extensions?.thread, path + '.extensions.thread');
  if (feature?.type !== 'thread') fail('THREAD_FEATURE_INVALID', path + '.type must be thread.');
  if (feature?.resultPolicy?.kind !== 'add' || feature.resultPolicy.targetBodyIds?.length !== 1) {
    fail('THREAD_FEATURE_INVALID', path + ' must modify exactly one target body in place.');
  }
  const targetBodyId = feature.resultPolicy.targetBodyIds[0];
  if (typeof targetBodyId !== 'string' || !targetBodyId) fail('THREAD_FEATURE_INVALID', path + ' target body is invalid.');
  if (definition.support.bodyId !== targetBodyId) {
    fail('THREAD_FEATURE_INVALID', path + ' result body and exact cylindrical-face support body must match.');
  }
  const expectedRefs = studioThreadV2InputRefs(targetBodyId, definition.support.face);
  if (!Array.isArray(feature.inputRefs) || !sameCanonicalJson(feature.inputRefs, expectedRefs)) {
    fail('THREAD_FEATURE_INVALID', path + ' must retain canonical target-body and persistent target-face input references.');
  }
  return definition;
}

export function createStudioThreadV2Feature({
  id,
  bodyId,
  targetFace,
  mode,
  threadKind,
  designation,
  handedness = 'right',
  toleranceClass = threadKind === 'internal' ? '6H' : '6g',
  span = { mode: 'fraction', start: 0, end: 1 },
  runout = 'one-pitch-taper',
  name,
} = {}) {
  if (typeof id !== 'string' || !id.trim()) fail('THREAD_ID_INVALID', 'Thread feature ID is required.');
  if (typeof bodyId !== 'string' || !bodyId.trim()) fail('THREAD_TARGET_INVALID', 'Thread target body ID is required.');
  const extension = createStudioThreadV2Extension({
    bodyId,
    targetFace,
    mode,
    threadKind,
    designation,
    handedness,
    toleranceClass,
    span,
    runout,
  });
  const feature = {
    id,
    name: name || `${mode === 'modeled' ? 'Modeled' : 'Cosmetic'} ${threadKind} thread ${designation}`,
    type: 'thread',
    resultPolicy: { kind: 'add', targetBodyIds: [bodyId] },
    suppressed: false,
    inputRefs: studioThreadV2InputRefs(bodyId, extension.support.face),
    extensions: { thread: extension },
  };
  assertStudioThreadFeature(feature);
  return feature;
}

export function studioThreadOperationInput(feature) {
  assertStudioThreadFeature(feature);
  return {
    id: feature.id,
    name: feature.name,
    resultPolicy: clone(feature.resultPolicy),
    inputRefs: clone(feature.inputRefs),
    extensions: clone(feature.extensions),
  };
}
