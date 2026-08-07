import { assertStudioHoleWizardFeature } from './studio-hole-wizard.js';
import { assertStudioThreadFeature } from './studio-thread.js';
import { assertStudioAdvancedFilletFeature } from './studio-advanced-fillet.js';
import { assertStudioStructuralMemberFeature } from './studio-structural-members.js';
import { assertStudioWeldmentTreatmentFeature } from './studio-structural-treatments.js';
import { assertStudioWeldBeadFeature } from './studio-weld-beads.js';
import { assertStudioDirectEditFeature } from './studio-direct-edit.js';
import { assertStudioSheetMetalFeature } from './studio-sheet-metal.js';
import { hasStudioExactTangentFilletPolicy } from './studio-kernel-robustness.js';

// Schema-5 feature records are persisted and may be evaluated long after the
// UI that created them has changed. Keep their accepted type vocabulary in one
// fail-closed contract shared by document validation and kernel dispatch.
export const STUDIO_V5_FEATURE_TYPES = Object.freeze([
  'boolean',
  'boolean-split-side',
  'chamfer',
  'cut',
  'direct-edit',
  'draft',
  'extrude',
  'fillet',
  'imported-step',
  'loft',
  'revolve',
  'sheet-metal-flange',
  'shell',
  'sweep',
  'thicken',
  'thread',
  'transform',
  'weld-bead',
  'weldment-treatment',
]);

const studioV5FeatureTypeSet = new Set(STUDIO_V5_FEATURE_TYPES);

export const STUDIO_V5_FEATURE_INPUT_ERROR_CODES = Object.freeze({
  structure: 'FEATURE_INPUT_STRUCTURE_INVALID',
  profileDimension: 'FEATURE_PROFILE_DIMENSION_INVALID',
  sketchPatternCount: 'FEATURE_SKETCH_PATTERN_COUNT_INVALID',
  extrusionDepth: 'FEATURE_EXTRUSION_DEPTH_INVALID',
  modifierRadius: 'FEATURE_MODIFIER_RADIUS_INVALID',
  shellThickness: 'FEATURE_SHELL_THICKNESS_INVALID',
  sweepScale: 'FEATURE_SWEEP_SCALE_INVALID',
  sweepDomain: 'FEATURE_SWEEP_DOMAIN_INVALID',
  revolveAngle: 'FEATURE_REVOLVE_ANGLE_INVALID',
  draftAngle: 'FEATURE_DRAFT_ANGLE_INVALID',
  thickenThickness: 'FEATURE_THICKEN_THICKNESS_INVALID',
  transformDomain: 'FEATURE_TRANSFORM_DOMAIN_INVALID',
});

export class StudioV5FeatureInputError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioV5FeatureInputError';
    this.code = code;
    Object.assign(this, details);
  }
}

const structuralFailure = (message, details = {}) => {
  throw new StudioV5FeatureInputError(
    STUDIO_V5_FEATURE_INPUT_ERROR_CODES.structure,
    message,
    details,
  );
};

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const stableValue = (value) => {
  if (Array.isArray(value)) return '[' + value.map(stableValue).join(',') + ']';
  if (isRecord(value)) return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableValue(value[key])).join(',') + '}';
  return JSON.stringify(value);
};
const expressionLike = (value) =>
  (typeof value === 'number' && Number.isFinite(value))
  || (typeof value === 'string' && value.trim().length > 0 && value.length <= 500);

function requireString(value, path) {
  if (typeof value !== 'string' || !value) structuralFailure(path + ' must be a non-empty string.');
}

function requireExpression(value, path) {
  if (!expressionLike(value)) structuralFailure(path + ' must be a finite number or supported expression.');
}

function requireBoolean(value, path) {
  if (typeof value !== 'boolean') structuralFailure(path + ' must be true or false.');
}

function optionalBoolean(record, key, path) {
  if (record[key] !== undefined) requireBoolean(record[key], path + '.' + key);
}

function requireArray(value, path, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    structuralFailure(
      path + ' must be an array with '
        + (minimum === maximum ? 'exactly ' + minimum : minimum + ' to ' + maximum)
        + ' item' + (maximum === 1 ? '' : 's') + '.',
    );
  }
  return value;
}

function requireReferenceArray(value, path, minimum = 1, maximum = Number.POSITIVE_INFINITY) {
  const entries = requireArray(value, path, minimum, maximum);
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) structuralFailure(path + '[' + index + '] must be a topology reference object.');
  });
  return entries;
}

function requireProfileSource(feature, path) {
  const inline = isRecord(feature.sketch);
  const linked = typeof feature.sketchId === 'string' && feature.sketchId.length > 0;
  if (!inline && !linked) structuralFailure(path + ' must contain an inline sketch or sketchId.');
}

function requireProfilePlane(feature, path) {
  if (feature.plane === undefined) return;
  const allowedPlanes = feature.type === 'revolve' ? ['XY', 'YZ', 'ZX', 'XZ'] : ['XY', 'YZ', 'ZX'];
  if (!isRecord(feature.plane) || feature.plane.kind !== 'base' || !allowedPlanes.includes(feature.plane.plane)) {
    structuralFailure(path + '.plane must be an exact supported base-plane record. Face support belongs in onFace.');
  }
}

function requireToolBodyIds(feature, path, minimum, maximum = Number.POSITIVE_INFINITY) {
  const ids = requireArray(feature.toolBodyIds, path + '.toolBodyIds', minimum, maximum);
  ids.forEach((id, index) => requireString(id, path + '.toolBodyIds[' + index + ']'));
  if (new Set(ids).size !== ids.length) structuralFailure(path + '.toolBodyIds must not repeat a body.');
  return ids;
}

function requireTransformStructure(feature, path) {
  requireString(feature.sourceBodyId, path + '.sourceBodyId');
  const transform = feature.transform;
  if (!isRecord(transform)) structuralFailure(path + '.transform must be an object.');
  const mode = transform.mode;
  if (!['move', 'translate', 'copy', 'rotate', 'align', 'mirror', 'scale'].includes(mode)) {
    structuralFailure(path + '.transform.mode is unsupported.');
  }
  if (feature.operation !== mode) structuralFailure(path + '.operation must match transform.mode.');
  if (mode === 'move' || mode === 'translate' || mode === 'copy') {
    requireArray(transform.translation, path + '.transform.translation', 3, 3)
      .forEach((value, index) => requireExpression(value, path + '.transform.translation[' + index + ']'));
  } else if (mode === 'rotate') {
    requireExpression(transform.angle, path + '.transform.angle');
    if (transform.axisDatumId === undefined) {
      requireArray(transform.origin, path + '.transform.origin', 3, 3)
        .forEach((value, index) => requireExpression(value, path + '.transform.origin[' + index + ']'));
      requireArray(transform.direction, path + '.transform.direction', 3, 3)
        .forEach((value, index) => requireExpression(value, path + '.transform.direction[' + index + ']'));
    } else requireString(transform.axisDatumId, path + '.transform.axisDatumId');
  } else if (mode === 'scale') {
    requireExpression(transform.factor, path + '.transform.factor');
    requireArray(transform.center, path + '.transform.center', 3, 3)
      .forEach((value, index) => requireExpression(value, path + '.transform.center[' + index + ']'));
  } else if (mode === 'mirror') {
    if (transform.planeDatumId === undefined) {
      requireArray(transform.origin, path + '.transform.origin', 3, 3)
        .forEach((value, index) => requireExpression(value, path + '.transform.origin[' + index + ']'));
      requireArray(transform.normal, path + '.transform.normal', 3, 3)
        .forEach((value, index) => requireExpression(value, path + '.transform.normal[' + index + ']'));
    } else requireString(transform.planeDatumId, path + '.transform.planeDatumId');
  } else {
    requireString(transform.fromDatumId, path + '.transform.fromDatumId');
    requireString(transform.toDatumId, path + '.transform.toDatumId');
    requireExpression(transform.offset, path + '.transform.offset');
    requireBoolean(transform.flip, path + '.transform.flip');
  }
  if (mode !== 'align' && transform.flip !== undefined) structuralFailure(path + '.transform.flip is only meaningful for align mode.');
  if (mode === 'copy' && feature.resultPolicy.kind !== 'new-body') structuralFailure(path + ' copy mode must create a new linked body.');
  if ((mode === 'move' || mode === 'translate') && feature.resultPolicy.kind !== 'add') structuralFailure(path + ' move and translate modes must modify their source body in place.');
}

const contract = (execution, resultPolicyKinds) => Object.freeze({
  execution,
  resultPolicyKinds: Object.freeze([...resultPolicyKinds]),
});

// A persisted feature type is only meaningful together with the execution
// context selected by its result policy. Keeping this matrix beside the type
// vocabulary prevents a recognized modifier (for example Chamfer) from being
// routed through an unrelated profile-solid constructor merely because a
// malformed document labelled it `new-body`.
export const STUDIO_V5_FEATURE_CONTRACTS = Object.freeze({
  boolean: contract('body-boolean', ['add', 'subtract', 'intersect']),
  'boolean-split-side': contract('linked-body', ['new-body']),
  chamfer: contract('body-modifier', ['add']),
  cut: contract('profile-solid', ['subtract']),
  'direct-edit': contract('body-modifier', ['add']),
  draft: contract('body-modifier', ['add']),
  extrude: contract('profile-solid', ['new-body', 'add', 'subtract', 'intersect']),
  fillet: contract('body-modifier', ['add']),
  'imported-step': contract('imported-body', ['new-body']),
  loft: contract('profile-solid', ['new-body', 'add', 'subtract', 'intersect']),
  revolve: contract('profile-solid', ['new-body', 'add', 'subtract', 'intersect']),
  'sheet-metal-flange': contract('sheet-metal', ['new-body', 'add', 'subtract']),
  shell: contract('body-modifier', ['add']),
  sweep: contract('profile-solid', ['new-body', 'add', 'subtract', 'intersect']),
  thicken: contract('linked-body', ['new-body']),
  thread: contract('body-modifier', ['add']),
  transform: contract('body-transform', ['new-body', 'add']),
  'weld-bead': contract('linked-body', ['new-body']),
  'weldment-treatment': contract('weldment-treatment', ['add', 'new-body']),
});

export function isStudioV5FeatureType(value) {
  return typeof value === 'string' && studioV5FeatureTypeSet.has(value);
}

export function assertStudioV5FeatureType(value) {
  if (!isStudioV5FeatureType(value)) {
    throw new Error('Unsupported schema-5 feature type "' + String(value) + '".');
  }
  return value;
}

export function studioV5FeatureContract(value) {
  const type = assertStudioV5FeatureType(value);
  const featureContract = STUDIO_V5_FEATURE_CONTRACTS[type];
  if (!featureContract) {
    throw new Error('Schema-5 feature type "' + type + '" has no execution contract.');
  }
  return featureContract;
}

export function isStudioV5FeatureResultPolicy(type, resultPolicyKind) {
  if (!isStudioV5FeatureType(type) || typeof resultPolicyKind !== 'string') return false;
  return STUDIO_V5_FEATURE_CONTRACTS[type]?.resultPolicyKinds.includes(resultPolicyKind) === true;
}

export function assertStudioV5FeatureContract(feature) {
  if (!feature || typeof feature !== 'object' || Array.isArray(feature)) {
    throw new Error('Schema-5 feature execution requires a feature record.');
  }
  const featureContract = studioV5FeatureContract(feature.type);
  const resultPolicyKind = feature.resultPolicy?.kind;
  if (!featureContract.resultPolicyKinds.includes(resultPolicyKind)) {
    throw new Error(
      'Schema-5 feature type "' + feature.type + '" cannot use result policy "'
        + String(resultPolicyKind) + '". Allowed policies: '
        + featureContract.resultPolicyKinds.join(', ') + '.',
    );
  }
  return featureContract;
}

// Structural execution contract shared by the save boundary and the worker.
// It deliberately does not evaluate parameter expressions; callers evaluate
// domains in their own parameter scope after this shape/cardinality gate.
export function assertStudioV5FeatureStructure(feature, path = 'feature') {
  assertStudioV5FeatureContract(feature);
  const type = feature.type;

  if (type === 'boolean') {
    if (!['add', 'subtract', 'intersect'].includes(feature.operation)) structuralFailure(path + '.operation is unsupported.');
    if (feature.operation !== feature.resultPolicy.kind) structuralFailure(path + '.operation must match resultPolicy.kind.');
    requireToolBodyIds(feature, path, 1);
  } else if (type === 'boolean-split-side') {
    requireString(feature.operationId, path + '.operationId');
    if (feature.side !== 'inside' && feature.side !== 'outside') structuralFailure(path + '.side must be inside or outside.');
    requireString(feature.sourceBodyId, path + '.sourceBodyId');
    const ids = requireToolBodyIds(feature, path, 2, 2);
    if (ids[0] !== feature.sourceBodyId) structuralFailure(path + '.toolBodyIds must store source then tool body.');
    requireBoolean(feature.keepTools, path + '.keepTools');
    if (feature.keepTools !== true) structuralFailure(path + '.keepTools=false is unsupported; Boolean Split retains both input bodies.');
  } else if (type === 'chamfer') {
    requireExpression(feature.r, path + '.r');
    requireReferenceArray(feature.edges, path + '.edges');
  } else if (type === 'cut' || type === 'extrude') {
    requireProfileSource(feature, path);
    requireProfilePlane(feature, path);
    requireBoolean(feature.through, path + '.through');
    if (type === 'extrude' && feature.through) structuralFailure(path + '.through is only supported by Cut.');
    if (type === 'extrude' || !feature.through) requireExpression(feature.h, path + '.h');
    optionalBoolean(feature, 'reversed', path);
    optionalBoolean(feature, 'symmetric', path);
    if (type === 'cut' && feature.through && (feature.reversed === true || feature.symmetric === true)) {
      structuralFailure(path + ' Through All is bidirectional and does not accept reversed or symmetric intent.');
    }
    if (feature.extensions?.exactSketchEntities !== true) {
      if (!feature.onFace && feature.plane !== undefined && feature.plane.plane !== 'XY') {
        structuralFailure(path + '.plane is ignored by classic free-shape execution; use exact sketch entities for non-XY planes.');
      }
      if (!feature.onFace && feature.reversed === true) {
        structuralFailure(path + '.reversed is ignored by classic base-plane free-shape execution; use exact sketch entities.');
      }
      if (feature.symmetric === true) {
        structuralFailure(path + '.symmetric is ignored by classic free-shape execution; use exact sketch entities.');
      }
    }
    if (feature.pattern !== undefined) {
      const pattern = feature.pattern;
      if (!isRecord(pattern) || !['linear', 'circular'].includes(pattern.kind)) structuralFailure(path + '.pattern.kind is unsupported.');
      requireExpression(pattern.n, path + '.pattern.n');
      if (pattern.kind === 'linear') {
        requireExpression(pattern.dx, path + '.pattern.dx');
        requireExpression(pattern.dy, path + '.pattern.dy');
      } else {
        requireExpression(pattern.cx, path + '.pattern.cx');
        requireExpression(pattern.cy, path + '.pattern.cy');
      }
    }
    if (feature.extensions?.holeWizard !== undefined) {
      if (type !== 'cut') structuralFailure(path + '.extensions.holeWizard is only supported by Cut.');
      try {
        assertStudioHoleWizardFeature(feature, path);
      } catch (error) {
        structuralFailure(String(error?.message || error));
      }
    }
  } else if (type === 'direct-edit') {
    try {
      assertStudioDirectEditFeature(feature, path);
    } catch (error) {
      structuralFailure(String(error?.message || error));
    }
  } else if (type === 'draft') {
    requireReferenceArray(feature.faces, path + '.faces');
    requireString(feature.neutralPlaneDatumId, path + '.neutralPlaneDatumId');
    requireExpression(feature.angle, path + '.angle');
    requireBoolean(feature.flip, path + '.flip');
    requireBoolean(feature.tangentPropagation, path + '.tangentPropagation');
    if (feature.tangentPropagation) structuralFailure(path + '.tangentPropagation=true is unsupported until exact tangent-chain expansion is implemented.');
  } else if (type === 'fillet') {
    requireExpression(feature.r, path + '.r');
    if (feature.extensions?.advancedFillet !== undefined) {
      try { assertStudioAdvancedFilletFeature(feature, path); }
      catch (error) { structuralFailure(String(error?.message || error)); }
      requireReferenceArray(feature.faces, path + '.faces', 2, 2);
      requireArray(feature.edges, path + '.edges', 0, 0);
    } else {
      requireReferenceArray(feature.edges, path + '.edges');
      if (feature.faces !== undefined) structuralFailure(path + '.faces requires a source-owned advanced Fillet contract.');
    }
    optionalBoolean(feature, 'tangentPropagation', path);
    const exactTangentPolicy = hasStudioExactTangentFilletPolicy(feature);
    if (feature.extensions?.kernelRobustness !== undefined && !exactTangentPolicy) {
      structuralFailure(path + '.extensions.kernelRobustness is not a supported exact tangent-chain policy.');
    }
    if (exactTangentPolicy && feature.tangentPropagation !== true) {
      structuralFailure(path + '.extensions.kernelRobustness requires tangentPropagation=true.');
    }
    if (feature.tangentPropagation === true) {
      if (!exactTangentPolicy) {
        structuralFailure(path + '.tangentPropagation=true requires an exact tangent-chain policy.');
      }
      if (
        exactTangentPolicy
        && feature.edges.some((reference) =>
          !isRecord(reference)
          || typeof reference.name !== 'string'
          || !reference.name.trim())
      ) structuralFailure(path + '.edges must use persistent named edge references for exact tangent-chain propagation.');
      const tangentEdgeKeys = feature.edges.map((reference) =>
        isRecord(reference) && typeof reference.name === 'string' && reference.name
          ? 'name:' + reference.name
          : stableValue(reference));
      if (new Set(tangentEdgeKeys).size !== tangentEdgeKeys.length) {
        structuralFailure(path + '.edges contains a duplicate tangent-chain seed reference.');
      }
    }
    if (
      feature.tangentPropagation === true
      && (feature.extensions?.advancedFillet !== undefined || feature.variableRadii !== undefined)
    ) structuralFailure(path + '.tangentPropagation=true requires a constant-radius edge Fillet.');
    if (feature.variableRadii !== undefined) {
      const entries = requireArray(feature.variableRadii, path + '.variableRadii', 0);
      if (entries.length > feature.edges.length) structuralFailure(path + '.variableRadii cannot contain more entries than selected edges.');
      const selectedEdges = new Set(feature.edges.map(stableValue));
      const assignedEdges = new Set();
      entries.forEach((entry, index) => {
        if (!isRecord(entry) || !isRecord(entry.edge)) structuralFailure(path + '.variableRadii[' + index + '].edge must be a topology reference.');
        const edgeKey = stableValue(entry.edge);
        if (!selectedEdges.has(edgeKey)) structuralFailure(path + '.variableRadii[' + index + '].edge must exactly match one selected edge.');
        if (assignedEdges.has(edgeKey)) structuralFailure(path + '.variableRadii must not assign an edge more than once.');
        assignedEdges.add(edgeKey);
        requireExpression(entry.startRadius, path + '.variableRadii[' + index + '].startRadius');
        requireExpression(entry.endRadius, path + '.variableRadii[' + index + '].endRadius');
      });
    }
  } else if (type === 'imported-step') {
    const imported = feature.extensions?.studioImportedStep;
    if (!isRecord(imported)) structuralFailure(path + '.extensions.studioImportedStep is required.');
    requireString(imported.resourceId, path + '.extensions.studioImportedStep.resourceId');
    if (imported.exactBrep !== true || imported.parametricHistory !== false || !isRecord(imported.topologyRegistry)) {
      structuralFailure(path + '.extensions.studioImportedStep must declare exact B-rep and its topology registry.');
    }
  } else if (type === 'loft') {
    const sections = requireArray(feature.sections, path + '.sections', 2);
    sections.forEach((section, index) => {
      if (!isRecord(section)) structuralFailure(path + '.sections[' + index + '] must be an object.');
      requireString(section.sketchId, path + '.sections[' + index + '].sketchId');
      if (!Number.isInteger(section.startIndex) || section.startIndex < 0) structuralFailure(path + '.sections[' + index + '].startIndex must be a non-negative integer.');
      requireBoolean(section.reversed, path + '.sections[' + index + '].reversed');
    });
    if (new Set(sections.map((section) => section.sketchId)).size !== sections.length) structuralFailure(path + '.sections must reference distinct sketches.');
    requireArray(feature.guideSketchIds, path + '.guideSketchIds').forEach((id, index) => requireString(id, path + '.guideSketchIds[' + index + ']'));
    if (feature.centerlineSketchId !== undefined) requireString(feature.centerlineSketchId, path + '.centerlineSketchId');
    if (feature.mapping !== 'explicit') structuralFailure(path + '.mapping must be explicit.');
    if (!isRecord(feature.continuity)) structuralFailure(path + '.continuity must be an object.');
    for (const end of ['start', 'end']) {
      if (!['free', 'tangent', 'curvature'].includes(feature.continuity[end])) structuralFailure(path + '.continuity.' + end + ' is unsupported.');
    }
    if (feature.continuity.start !== feature.continuity.end) structuralFailure(path + '.continuity start and end must match because the kernel currently applies one global continuity order.');
    requireBoolean(feature.ruled, path + '.ruled');
    requireBoolean(feature.closed, path + '.closed');
    if (feature.closed) structuralFailure(path + '.closed=true is unsupported by the current exact Loft implementation.');
  } else if (type === 'revolve') {
    const advanced = feature.profileSketchId !== undefined || feature.axisDatumId !== undefined;
    if (advanced) {
      requireString(feature.profileSketchId, path + '.profileSketchId');
      requireString(feature.axisDatumId, path + '.axisDatumId');
      requireExpression(feature.angle, path + '.angle');
      requireExpression(feature.startAngle, path + '.startAngle');
      requireBoolean(feature.symmetric, path + '.symmetric');
      if (feature.reversed !== undefined) structuralFailure(path + '.reversed is only supported by basic inline-profile Revolve.');
    } else {
      requireProfileSource(feature, path);
      requireProfilePlane(feature, path);
      const angleSource = Object.prototype.hasOwnProperty.call(feature, 'angle') ? feature.angle : feature.h;
      requireExpression(angleSource, path + '.angle');
      optionalBoolean(feature, 'reversed', path);
      if (feature.startAngle !== undefined || feature.symmetric !== undefined) structuralFailure(path + ' basic Revolve does not support startAngle or symmetric fields.');
    }
  } else if (type === 'shell') {
    requireExpression(feature.t, path + '.t');
    requireReferenceArray(feature.faces, path + '.faces');
  } else if (type === 'thread') {
    try {
      assertStudioThreadFeature(feature, path);
    } catch (error) {
      structuralFailure(String(error?.message || error));
    }
  } else if (type === 'sweep') {
    requireString(feature.profileSketchId, path + '.profileSketchId');
    requireString(feature.pathSketchId, path + '.pathSketchId');
    if (!['path-normal', 'minimum-twist', 'fixed', 'reference', 'guide'].includes(feature.orientation)) structuralFailure(path + '.orientation is unsupported; controlled-twist is unavailable until an exact kernel law replaces sampled approximation.');
    if (feature.orientation === 'guide') requireString(feature.guideSketchId, path + '.guideSketchId');
    else if (feature.guideSketchId !== undefined) structuralFailure(path + '.guideSketchId requires guide orientation.');
    requireArray(feature.referenceDirection, path + '.referenceDirection', 3, 3)
      .forEach((value, index) => requireExpression(value, path + '.referenceDirection[' + index + ']'));
    requireExpression(feature.twistAngle, path + '.twistAngle');
    requireExpression(feature.scaleEnd, path + '.scaleEnd');
    if (!['transformed', 'round', 'right'].includes(feature.transition)) structuralFailure(path + '.transition is unsupported.');
    if (feature.extensions?.structuralMember !== undefined) {
      try { assertStudioStructuralMemberFeature(feature, path); }
      catch (error) { structuralFailure(String(error?.message || error)); }
    }
  } else if (type === 'thicken') {
    requireString(feature.sourceBodyId, path + '.sourceBodyId');
    const ids = requireToolBodyIds(feature, path, 1, 1);
    if (ids[0] !== feature.sourceBodyId) structuralFailure(path + '.toolBodyIds must contain exactly its source body.');
    requireReferenceArray(feature.faces, path + '.faces', 1, 1);
    requireExpression(feature.thickness, path + '.thickness');
    requireBoolean(feature.symmetric, path + '.symmetric');
    requireBoolean(feature.flip, path + '.flip');
    if (feature.linked !== true) structuralFailure(path + '.linked must be true.');
  } else if (type === 'sheet-metal-flange') {
    try {
      assertStudioSheetMetalFeature(feature, path);
    } catch (error) {
      structuralFailure(String(error?.message || error));
    }
  } else if (type === 'weldment-treatment') {
    try {
      assertStudioWeldmentTreatmentFeature(feature, path);
    } catch (error) {
      structuralFailure(String(error?.message || error));
    }
  } else if (type === 'weld-bead') {
    try {
      assertStudioWeldBeadFeature(feature, path);
    } catch (error) {
      structuralFailure(String(error?.message || error));
    }
  } else if (type === 'transform') {
    requireTransformStructure(feature, path);
    if (feature.resultPolicy.kind === 'new-body') {
      const ids = requireToolBodyIds(feature, path, 1, 1);
      if (ids[0] !== feature.sourceBodyId) structuralFailure(path + '.toolBodyIds must contain exactly its source body.');
      if (feature.linked !== true) structuralFailure(path + '.linked must be true for a copied body.');
    } else {
      if (feature.toolBodyIds !== undefined && requireToolBodyIds(feature, path, 0, 0).length !== 0) {
        structuralFailure(path + '.toolBodyIds must be empty for an in-place transform.');
      }
      if (feature.linked !== undefined && feature.linked !== false) structuralFailure(path + '.linked must be false for an in-place transform.');
    }
  }
  return STUDIO_V5_FEATURE_CONTRACTS[type];
}
