import {
  createEmptyStudioV5PartProject,
  createStudioV5PartProject,
  prepareStudioV5Project,
  STUDIO_V5_PROJECT_LIMITS,
} from './studio-project-v5.js';
import {
  STUDIO_PART_CONFIGURATION_ERROR_CODES,
  StudioPartConfigurationError,
  applyStudioPartConfiguration as applyPartConfiguration,
  normalizeStudioPartConfigurationSet,
  parseStudioPartDesignTable,
  serializeStudioPartDesignTable,
} from './studio-part-configurations.js';
import { evaluateStudioV5Expression, resolveStudioV5Datums, resolveStudioV5PathPreview, resolveStudioV5Transform, studioV5ParameterValues, studioV5VectorMath } from './studio-v5-modeling.js';
import { studioV5IdentityMatrix } from './studio-v5-assembly.js';
import { studioFaceFilletExtension } from './studio-advanced-fillet.js';
import {
  STUDIO_STRUCTURAL_PROFILE_CATALOG_VERSION,
  STUDIO_STRUCTURAL_PROFILE_LIBRARY_SCHEMA,
  STUDIO_STRUCTURAL_PROFILE_SOURCE,
  assertStudioStructuralMemberId,
  assertStudioStructuralMemberPart,
  studioStructuralMemberOwnedIds,
  studioStructuralMemberRecipe,
  studioStructuralProfile,
} from './studio-structural-members.js';
import {
  assertStudioWeldmentTreatmentFeature,
  assertStudioWeldmentTreatmentId,
  assertStudioWeldmentTreatmentPart,
  isStudioWeldmentTreatmentFeature,
  studioWeldmentTreatmentPatch,
  studioWeldmentTreatmentRecipe,
} from './studio-structural-treatments.js';
import {
  STUDIO_SHEET_METAL_FEATURE_TYPE,
  assertStudioSheetMetalBendTable,
  assertStudioSheetMetalId,
  assertStudioSheetMetalPart,
  isStudioSheetMetalFeature,
  studioSheetMetalBasePatch,
  studioSheetMetalBaseRecipe,
  studioSheetMetalBendTable,
  studioSheetMetalBendTableLookup,
  studioSheetMetalCornerRecipe,
  studioSheetMetalDerivedPatch,
  studioSheetMetalEdgePatch,
  studioSheetMetalEdgeRecipe,
  studioSheetMetalFlatRecipe,
  studioSheetMetalFlatSketch,
} from './studio-sheet-metal.js';
import {
  assertStudioWeldBeadFeature,
  assertStudioWeldBeadId,
  assertStudioWeldBeadPart,
  isStudioWeldBeadFeature,
  studioWeldBeadPatch,
  studioWeldBeadRecipe,
} from './studio-weld-beads.js';
import {
  STUDIO_CONSTRAINED_2D_ROLE,
  STUDIO_SKETCH_INSTANCES_SCHEMA,
  materializeStudioSketchMembers,
  resolveStudioConstrainedSketch,
  resolveStudioSketchBlockDefinitions,
  studioDerivedSketchMemberId,
  studioSketchBlockMemberId,
  studioSketchBlockMemberPrefix,
} from './studio-sketch-instances.js';
import { parseStudioExpression } from './studio-expression.js';
import {
  STUDIO_VARIABLE_PATTERN_DIMENSION_FIELDS,
  STUDIO_VARIABLE_PATTERN_MAX_GENERATED,
  STUDIO_VARIABLE_PATTERN_MAX_PARAMETERS,
  studioFillPatternLattice,
} from './studio-advanced-patterns.js';
import {
  applyStudioSmartFastenerPlan,
  deleteStudioSmartFastenerGroup,
  studioSmartFastenerMateDependency,
  studioSmartFastenerOccurrenceDependency,
  updateStudioSmartFastenerGroup,
} from './studio-smart-fasteners.js';
import {
  createStudioAssemblyFeature,
  deleteStudioAssemblyFeature,
  studioAssemblyFeatureBodyDependencies,
  studioAssemblyFeatureOccurrenceDependency,
  updateStudioAssemblyFeature,
} from './studio-assembly-features.js';
import {
  assertStudioAdvancedMateUpdate,
  buildStudioAdvancedMateRecord,
  hasStudioAdvancedMateContract,
  isStudioAdvancedMateKind,
} from './studio-advanced-mates.js';
import {
  assertStudioMechanicalMateUpdate,
  buildStudioMechanicalMateRecord,
  hasStudioMechanicalMateContract,
  isStudioMechanicalMateKind,
} from './studio-mechanical-mates.js';
import {
  STUDIO_DIRECT_EDIT_OPERATIONS,
  assertStudioDirectEditPart,
  studioDirectEditExtension,
  studioDirectEditInputReferences,
} from './studio-direct-edit.js';
import { studioSha256BytesHex, studioSha256TextHex } from './studio-sha256.js';

export { studioSha256BytesHex, studioSha256TextHex };
export const studioV5Sha256Hex = studioSha256TextHex;

// Canonical schema-5 document helpers used by the production Studio runtime.

const clone = (value) => structuredClone(value);
const owns = (record, key) => Object.prototype.hasOwnProperty.call(record, key);

function authoredOr(record, key, fallback) {
  return owns(record, key) ? record[key] : fallback;
}

function optionalAuthoredBoolean(record, key, fallback) {
  if (!owns(record, key)) return fallback;
  if (typeof record[key] !== 'boolean') throw new Error(key + ' must be true or false.');
  return record[key];
}

function optionalAuthoredArray(record, key, fallback = []) {
  if (!owns(record, key)) return clone(fallback);
  if (!Array.isArray(record[key])) throw new Error(key + ' must be an array.');
  return clone(record[key]);
}

export function isStudioV5Project(value) {
  return Boolean(value && typeof value === 'object' && value.schemaVersion === 5 && Array.isArray(value.partDefinitions));
}

export function studioV5RootPart(project) {
  if (!isStudioV5Project(project) || project.rootDocument?.kind !== 'part') {
    throw new Error('This operation requires a schema-5 part document.');
  }
  const part = project.partDefinitions.find((entry) => entry.id === project.rootDocument.partId);
  if (!part) throw new Error('The active schema-5 part definition is missing.');
  return part;
}

export function studioV5RootAssembly(project) {
  if (!isStudioV5Project(project) || project.rootDocument?.kind !== 'assembly') {
    throw new Error('This operation requires a schema-5 assembly document.');
  }
  const assembly = project.assemblyDefinitions.find((entry) => entry.id === project.rootDocument.assemblyId);
  if (!assembly) throw new Error('The active schema-5 assembly definition is missing.');
  return assembly;
}

export function decorateStudioV5Project(project) {
  const part = project.rootDocument?.kind === 'part'
    ? project.partDefinitions.find((entry) => entry.id === project.rootDocument.partId)
    : null;
  const assembly = project.rootDocument?.kind === 'assembly'
    ? project.assemblyDefinitions.find((entry) => entry.id === project.rootDocument.assemblyId)
    : null;
  if (!part && !assembly) throw new Error('The active schema-5 document definition is missing.');
  return project;
}

function featureName(feature, index) {
  const fallback = String(feature.type || 'Feature').replace(/(^|-)([a-z])/g, (_, prefix, letter) => prefix + letter.toUpperCase());
  return typeof feature.name === 'string' && feature.name.trim()
    ? feature.name.trim().slice(0, 200)
    : fallback + ' ' + (index + 1);
}

function bodyIdFor(feature) {
  return feature.createdBodyId || 'body-' + feature.id;
}

export function reconcileStudioV5Bodies(part) {
  part.metadata ||= {};
  const existingByCreator = new Map((part.bodies || []).map((body) => [body.createdByFeatureId, body]));
  const features = Array.isArray(part.features) ? part.features : [];
  const byId = new Map();
  const bodies = [];

  features.forEach((feature, index) => {
    feature.name = featureName(feature, index);
    feature.suppressed = feature.suppressed === true;
    feature.inputRefs = Array.isArray(feature.inputRefs) ? feature.inputRefs : [];
    if (!feature.resultPolicy) {
      const firstBody = bodies[0];
      if (feature.type === 'cut' && !firstBody) {
        throw new Error('A Cut cannot be the first solid feature; create or select a target body first.');
      }
      feature.resultPolicy = firstBody
        ? feature.type === 'cut'
          ? { kind: 'subtract', targetBodyIds: [firstBody.id], keepTools: false }
          : { kind: 'add', targetBodyIds: [firstBody.id] }
        : { kind: 'new-body', bodyName: 'Body 1' };
    }
    if (feature.resultPolicy.kind !== 'new-body' && feature.resultPolicy.kind !== 'surface') return;
    const previous = existingByCreator.get(feature.id);
    const id = previous?.id || bodyIdFor(feature);
    feature.createdBodyId = id;
    const body = {
      id,
      name: previous?.name || feature.resultPolicy.bodyName || (feature.resultPolicy.kind === 'surface' ? 'Surface ' : 'Body ') + (bodies.length + 1),
      kind: feature.resultPolicy.kind === 'surface' ? 'surface' : 'solid',
      createdByFeatureId: feature.id,
      featureIds: [],
      visible: previous?.visible !== false,
      suppressed: previous?.suppressed === true,
      ...(previous?.appearanceId ? { appearanceId: previous.appearanceId } : {}),
      ...(previous?.materialId ? { materialId: previous.materialId } : {}),
      ...(previous?.extensions ? { extensions: clone(previous.extensions) } : {}),
    };
    bodies.push(body);
    byId.set(body.id, body);
  });

  for (const feature of features) {
    const policy = feature.resultPolicy;
    const targets = policy.kind === 'new-body' || policy.kind === 'surface'
      ? [feature.createdBodyId]
      : policy.targetBodyIds;
    for (const bodyId of targets || []) {
      const body = byId.get(bodyId);
      if (body && !body.featureIds.includes(feature.id)) body.featureIds.push(feature.id);
    }
  }

  part.bodies = bodies;
  part.featureOrder = features.map((feature) => feature.id);
  if (part.metadata.rollbackFeatureId && !features.some((feature) => feature.id === part.metadata.rollbackFeatureId)) {
    part.metadata.rollbackFeatureId = null;
  }
  const activeBody = bodies.find((body) => body.id === part.metadata.activeBodyId);
  if (!activeBody || activeBody.suppressed) {
    part.metadata.activeBodyId = bodies.find((body) => !body.suppressed)?.id || null;
  }
  return part;
}

export function prepareStudioV5RuntimeProject(candidate) {
  const detached = clone(candidate);
  for (const part of detached.partDefinitions || []) reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(detached));
}

export function createEmptyStudioV5RuntimePartProject(options = {}) {
  return decorateStudioV5Project(createEmptyStudioV5PartProject(options));
}

export function createStudioV5RuntimePartProject(options = {}) {
  return decorateStudioV5Project(createStudioV5PartProject(options));
}

export function parseStudioV5RuntimeProject(text) {
  if (typeof text !== 'string') throw new Error('Project file must be text.');
  if (new TextEncoder().encode(text).byteLength > STUDIO_V5_PROJECT_LIMITS.fileBytes) {
    throw new Error('Project file exceeds the 160 MB limit.');
  }
  let candidate;
  try {
    candidate = JSON.parse(text);
  } catch {
    throw new Error('Project file is not valid JSON.');
  }
  if (!isStudioV5Project(candidate)) {
    throw new Error('PartMode opens schema 5 projects only.');
  }
  return prepareStudioV5RuntimeProject(candidate);
}

export function canonicalStudioV5Project(project) {
  return prepareStudioV5Project(JSON.parse(JSON.stringify(project)));
}

function configurationFailure(code, message, details = {}) {
  throw new StudioPartConfigurationError(code, message, details);
}

function requireStudioV5ConfigurationPart(project, partId) {
  const part = project.partDefinitions.find((entry) => entry.id === partId);
  if (!part) {
    configurationFailure(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.unknownPart,
      'Configuration part "' + partId + '" does not exist.',
      { partId },
    );
  }
  return part;
}

function configurationSetIndex(project, partId) {
  requireStudioV5ConfigurationPart(project, partId);
  const matches = [];
  for (let index = 0; index < project.partConfigurationSets.length; index++) {
    if (project.partConfigurationSets[index].partId === partId) matches.push(index);
  }
  if (matches.length > 1) {
    configurationFailure(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.duplicatePart,
      'Part "' + partId + '" has more than one configuration set.',
      { partId },
    );
  }
  return matches[0] ?? -1;
}

function requireConfigurationSetIndex(project, partId) {
  const index = configurationSetIndex(project, partId);
  if (index < 0) {
    configurationFailure(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidSet,
      'Part "' + partId + '" does not have a configuration set.',
      { partId },
    );
  }
  return index;
}

function configurationCommandResult(candidate, input) {
  const project = prepareStudioV5RuntimeProject(candidate);
  const afterIndex = configurationSetIndex(project, input.partId);
  const after = afterIndex < 0 ? null : clone(project.partConfigurationSets[afterIndex]);
  const before = input.before == null ? null : clone(input.before);
  const metadata = {
    partId: input.partId,
    previousActiveConfigurationId: before?.activeConfigurationId ?? null,
    activeConfigurationId: after?.activeConfigurationId ?? null,
    configurationIds: after ? after.configurations.map((configuration) => configuration.id) : [],
    ...(input.metadata ? clone(input.metadata) : {}),
  };
  return {
    project,
    commandResult: {
      commandId: 'part-configuration-set.' + input.action,
      label: input.label,
      metadata,
      before: before == null ? null : clone(before),
      after: after == null ? null : clone(after),
      undo: {
        commandId: 'part-configuration-set.restore',
        partId: input.partId,
        configurationSet: before == null ? null : clone(before),
      },
    },
  };
}

/** Return a detached canonical configuration set for one exact part ID. */
export function studioV5PartConfigurationSet(project, partId = studioV5RootPart(project).id) {
  const candidate = canonicalStudioV5Project(project);
  const index = configurationSetIndex(candidate, partId);
  return index < 0 ? null : clone(candidate.partConfigurationSets[index]);
}

/**
 * Apply a selected row to an isolated runtime project. The stored source and
 * its canonical configuration set remain unchanged.
 */
export function applyStudioV5PartConfiguration(project, partId = studioV5RootPart(project).id, configurationId = undefined) {
  const candidate = canonicalStudioV5Project(project);
  const index = requireConfigurationSetIndex(candidate, partId);
  const set = candidate.partConfigurationSets[index];
  const applied = applyPartConfiguration(candidate, set, configurationId ?? set.activeConfigurationId);
  return {
    project: prepareStudioV5RuntimeProject(applied.project),
    partId,
    configuration: clone(applied.configuration),
    configurationSet: clone(set),
  };
}

export function createStudioV5PartConfigurationSet(project, configurationSet) {
  const candidate = canonicalStudioV5Project(project);
  const normalized = normalizeStudioPartConfigurationSet(candidate, configurationSet);
  if (configurationSetIndex(candidate, normalized.partId) >= 0) {
    configurationFailure(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.duplicatePart,
      'Part "' + normalized.partId + '" already has a configuration set.',
      { partId: normalized.partId },
    );
  }
  candidate.partConfigurationSets.push(normalized);
  return configurationCommandResult(candidate, {
    action: 'create',
    label: 'Create part configurations',
    partId: normalized.partId,
    before: null,
  });
}

export function updateStudioV5PartConfigurationSet(project, partId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const index = requireConfigurationSetIndex(candidate, partId);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    configurationFailure(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidSet,
      'The configuration set update must be an object.',
      { partId },
    );
  }
  if (patch.partId != null && patch.partId !== partId) {
    configurationFailure(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.unknownPart,
      'A configuration set update cannot change its exact part ID.',
      { partId: patch.partId },
    );
  }
  const before = clone(candidate.partConfigurationSets[index]);
  const normalized = normalizeStudioPartConfigurationSet(candidate, {
    ...before,
    ...clone(patch),
    partId,
  });
  candidate.partConfigurationSets[index] = normalized;
  return configurationCommandResult(candidate, {
    action: 'update',
    label: 'Update part configurations',
    partId,
    before,
  });
}

export function deleteStudioV5PartConfigurationSet(project, partId) {
  const candidate = canonicalStudioV5Project(project);
  const index = requireConfigurationSetIndex(candidate, partId);
  const before = clone(candidate.partConfigurationSets[index]);
  candidate.partConfigurationSets.splice(index, 1);
  return configurationCommandResult(candidate, {
    action: 'delete',
    label: 'Delete part configurations',
    partId,
    before,
  });
}

export function switchStudioV5PartConfiguration(project, partId, configurationId) {
  const candidate = canonicalStudioV5Project(project);
  const index = requireConfigurationSetIndex(candidate, partId);
  const before = clone(candidate.partConfigurationSets[index]);
  candidate.partConfigurationSets[index] = normalizeStudioPartConfigurationSet(candidate, {
    ...before,
    activeConfigurationId: configurationId,
  });
  return configurationCommandResult(candidate, {
    action: 'switch',
    label: 'Switch part configuration',
    partId,
    before,
  });
}

/** Replace or create a part configuration set from one deterministic CSV table. */
export function importStudioV5PartDesignTable(project, options) {
  const candidate = canonicalStudioV5Project(project);
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    configurationFailure(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidSet,
      'Design-table import options must be an object.',
    );
  }
  const partId = options.partId;
  requireStudioV5ConfigurationPart(candidate, partId);
  const existingIndex = configurationSetIndex(candidate, partId);
  const before = existingIndex < 0 ? null : clone(candidate.partConfigurationSets[existingIndex]);
  const existingIdsByName = before == null
    ? {}
    : Object.fromEntries(before.configurations.map((configuration) => [configuration.name, configuration.id]));
  let parsed = parseStudioPartDesignTable(options.source, {
    project: candidate,
    partId,
    configurationIdsByName: options.configurationIdsByName ?? existingIdsByName,
    ...(options.activeConfigurationId == null ? {} : { activeConfigurationId: options.activeConfigurationId }),
  });
  if (options.activeConfigurationId == null && before?.activeConfigurationId != null
      && parsed.configurations.some((configuration) => configuration.id === before.activeConfigurationId)) {
    parsed = normalizeStudioPartConfigurationSet(candidate, {
      ...parsed,
      activeConfigurationId: before.activeConfigurationId,
    });
  }
  if (existingIndex < 0) candidate.partConfigurationSets.push(parsed);
  else candidate.partConfigurationSets[existingIndex] = parsed;
  const canonicalDesignTable = serializeStudioPartDesignTable(candidate, parsed);
  return configurationCommandResult(candidate, {
    action: 'import-design-table',
    label: 'Import part design table',
    partId,
    before,
    metadata: {
      format: 'text/csv',
      importedConfigurationIds: parsed.configurations.map((configuration) => configuration.id),
      canonicalDesignTable,
    },
  });
}

export function serializeStudioV5PartDesignTable(project, partId = studioV5RootPart(project).id) {
  const candidate = canonicalStudioV5Project(project);
  const index = requireConfigurationSetIndex(candidate, partId);
  return serializeStudioPartDesignTable(candidate, candidate.partConfigurationSets[index]);
}

export function studioV5ActiveBody(project) {
  const part = studioV5RootPart(project);
  return part.bodies.find((body) => body.id === part.metadata?.activeBodyId && !body.suppressed) || null;
}

// Inline/basic profiles need authored semantic identity before the kernel can
// assign persistent topology.
// Allocate opaque ids when the profile is created or edited and persist them in
// the document. The evaluator never invents ids from shape/edge traversal
// order, geometry, hashes, or proximity.
function ensureInlineProfileSemanticIds(feature) {
  if (!['extrude', 'cut', 'revolve'].includes(feature?.type) || !Array.isArray(feature.sketch?.shapes)) return;
  const usedShapeIds = new Set(feature.sketch.shapes
    .map((shape) => typeof shape?.id === 'string' ? shape.id : null)
    .filter(Boolean));
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (!randomUUID) {
    throw new Error('This runtime cannot allocate secure persistent inline-profile identity.');
  }
  const allocate = (prefix, used) => {
    let id;
    do {
      const uuid = randomUUID().replaceAll('-', '');
      id = prefix + '-' + uuid.slice(0, 24);
    } while (used.has(id));
    used.add(id);
    return id;
  };
  for (const shape of feature.sketch.shapes) {
    if (typeof shape.id !== 'string' || !shape.id) {
      shape.id = allocate('inline-profile', usedShapeIds);
    }
    if (shape.kind !== 'poly' || !Array.isArray(shape.pts)) continue;
    const existing = Array.isArray(shape.edgeIds) ? shape.edgeIds : [];
    const usedEdgeIds = new Set(existing.filter((id) => typeof id === 'string' && id));
    shape.edgeIds = shape.pts.map((_point, index) => {
      const id = existing[index];
      return typeof id === 'string' && id ? id : allocate('inline-edge', usedEdgeIds);
    });
  }
}

export function configureStudioV5Feature(project, featureInput, options = {}) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = clone(featureInput);
  const existingIndex = part.features.findIndex((entry) => entry.id === feature.id);
  const previous = existingIndex >= 0 ? part.features[existingIndex] : null;
  if (isStudioWeldBeadFeature(previous) || isStudioWeldBeadFeature(feature)) {
    throw new Error('Weld beads must be created or edited through the typed weld-bead lifecycle.');
  }
  if (isStudioSheetMetalFeature(previous) || isStudioSheetMetalFeature(feature)) {
    throw new Error('Sheet-metal flanges must be created or edited through the typed sheetMetal.flange lifecycle.');
  }
  feature.name = featureName(feature, existingIndex >= 0 ? existingIndex : part.features.length);
  feature.suppressed = feature.suppressed === true;
  feature.inputRefs = Array.isArray(feature.inputRefs) ? feature.inputRefs : [];
  ensureInlineProfileSemanticIds(feature);

  if (options.resultPolicy) feature.resultPolicy = clone(options.resultPolicy);
  else if (previous?.resultPolicy) feature.resultPolicy = clone(previous.resultPolicy);
  else {
    const active = studioV5ActiveBody(candidate);
    if (feature.type === 'cut' && !active) {
      throw new Error('A Cut requires one existing active target body.');
    }
    feature.resultPolicy = active
      ? feature.type === 'cut'
        ? { kind: 'subtract', targetBodyIds: [active.id], keepTools: false }
        : { kind: 'add', targetBodyIds: [active.id] }
      : { kind: 'new-body', bodyName: options.bodyName || 'Body 1' };
  }
  if (feature.resultPolicy.kind === 'new-body' || feature.resultPolicy.kind === 'surface') {
    feature.resultPolicy.bodyName = options.bodyName || feature.resultPolicy.bodyName || previous?.resultPolicy?.bodyName || 'Body ' + (part.bodies.length + 1);
    feature.createdBodyId = previous?.createdBodyId || feature.createdBodyId || 'body-' + feature.id;
  }

  if (existingIndex >= 0) part.features[existingIndex] = feature;
  else part.features.push(feature);
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function createStudioV5BooleanFeature(project, options) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const target = part.bodies.find((body) => body.id === options.targetBodyId);
  const tool = part.bodies.find((body) => body.id === options.toolBodyId);
  if (!target || !tool || target.id === tool.id) throw new Error('Choose two different existing bodies for the Boolean operation.');
  const feature = {
    id: options.id,
    name: options.name || 'Subtract ' + tool.name + ' from ' + target.name,
    type: 'boolean',
    operation: options.operation || 'subtract',
    suppressed: false,
    inputRefs: [
      { ownerKind: 'body', ownerId: target.id, signature: { role: 'target' } },
      { ownerKind: 'body', ownerId: tool.id, signature: { role: 'tool' } },
    ],
    toolBodyIds: [tool.id],
    resultPolicy: {
      kind: options.operation || 'subtract',
      targetBodyIds: [target.id],
      keepTools: options.keepTools !== false,
    },
  };
  part.features.push(feature);
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function createStudioV5BooleanSplit(project, options) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const source = part.bodies.find((body) => body.id === options.targetBodyId);
  const tool = part.bodies.find((body) => body.id === options.toolBodyId);
  if (!source || !tool || source.id === tool.id) throw new Error('Choose different existing target and splitting-tool bodies.');
  const keepTools = optionalAuthoredBoolean(options, 'keepTools', true);
  if (!keepTools) throw new Error('Boolean Split currently retains both input bodies; keepTools=false is unsupported.');
  const keepOriginal = optionalAuthoredBoolean(options, 'keepOriginal', false);
  const operationId = options.id;
  const sides = [
    { side: 'outside', suffix: 'outside', name: options.outsideName || source.name + ' outside split' },
    { side: 'inside', suffix: 'inside', name: options.insideName || source.name + ' inside split' },
  ];
  for (const entry of sides) requireUniquePartId(part, operationId + '-' + entry.suffix, 'Boolean Split feature');
  for (const entry of sides) {
    part.features.push({
      id: operationId + '-' + entry.suffix,
      name: String((options.name || 'Split ' + source.name) + ' · ' + entry.suffix).trim(),
      type: 'boolean-split-side', operationId, side: entry.side,
      sourceBodyId: source.id, toolBodyIds: [source.id, tool.id], keepTools: true,
      suppressed: false,
      inputRefs: [bodyInputReference(source.id, 'target'), bodyInputReference(tool.id, 'tool')],
      resultPolicy: { kind: 'new-body', bodyName: entry.name },
    });
  }
  source.visible = keepOriginal;
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

function requireUniquePartId(part, id, label) {
  const used = new Set([
    ...part.referenceGeometry.map((entry) => entry.id),
    ...part.sketches.map((entry) => entry.id),
    ...part.features.map((entry) => entry.id),
    ...part.bodies.map((entry) => entry.id),
    ...(part.bodyPatterns || []).map((entry) => entry.id),
    ...(part.sketchBlockDefinitions || []).map((entry) => entry.id),
  ]);
  if (used.has(id)) throw new Error(label + ' ID "' + id + '" is already in use.');
}

export function createStudioV5Datum(project, input) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  requireUniquePartId(part, input.id, 'Datum');
  const datum = {
    id: input.id,
    name: String(input.name || '').trim(),
    kind: input.kind,
    suppressed: false,
    definition: clone(authoredOr(input, 'definition', {})),
    ...(input.extensions ? { extensions: clone(input.extensions) } : {}),
  };
  if (!datum.name) throw new Error('Datum name is required.');
  part.referenceGeometry.push(datum);
  const prepared = prepareStudioV5Project(candidate);
  const resolution = resolveStudioV5Datums(prepared, part.id);
  if (resolution.errors.has(datum.id)) throw resolution.errors.get(datum.id);
  return decorateStudioV5Project(prepared);
}

export function updateStudioV5Datum(project, datumId, patch, options = {}) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const datum = part.referenceGeometry.find((entry) => entry.id === datumId);
  if (!datum) throw new Error('That datum no longer exists.');
  if (owns(patch, 'name')) {
    if (typeof patch.name !== 'string') throw new Error('Datum name must be a string.');
    const name = patch.name.trim();
    if (!name || name.length > 200) throw new Error('Datum names must contain 1 to 200 characters.');
    datum.name = name;
  }
  if (owns(patch, 'definition')) datum.definition = clone(patch.definition);
  if (patch.suppressed !== undefined) {
    if (typeof patch.suppressed !== 'boolean') throw new Error('Datum suppressed must be true or false.');
    datum.suppressed = patch.suppressed;
  }
  refreshStudioV5ReferenceCurvePreviewsInPart(candidate, part);
  const prepared = prepareStudioV5Project(candidate);
  if (options.allowBroken !== true && !datum.suppressed) {
    const resolution = resolveStudioV5Datums(prepared, part.id);
    if (resolution.errors.size) throw resolution.errors.get(datum.id) || resolution.errors.values().next().value;
  }
  return decorateStudioV5Project(prepared);
}

export function deleteStudioV5Datum(project, datumId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  if (!part.referenceGeometry.some((entry) => entry.id === datumId)) throw new Error('That datum no longer exists.');
  const usedBy = part.features.filter((feature) =>
    feature.inputRefs.some((reference) => reference.ownerKind === 'datum' && reference.ownerId === datumId) ||
    Object.values(feature.transform || {}).includes(datumId),
  );
  const sketchUsers = part.sketches.filter((sketch) => sketch.support?.ownerKind === 'datum' && sketch.support.ownerId === datumId);
  const referenceCurveUsers = part.sketches.filter((sketch) => Object.entries(sketch.extensions?.referenceCurve || {}).some(([field, value]) =>
    (field.endsWith('DatumId') && value === datumId) || (field.endsWith('DatumIds') && Array.isArray(value) && value.includes(datumId))));
  const datumUsers = part.referenceGeometry.filter((datum) => datum.id !== datumId && Object.values(datum.definition || {}).some((value) => value === datumId || (Array.isArray(value) && value.includes(datumId))));
  const patternUsers = (part.bodyPatterns || []).filter((pattern) => pattern.references?.some((reference) => reference.ownerKind === 'datum' && reference.ownerId === datumId));
  const pierceUsers = part.features.filter((feature) => feature.sketch?.constrained?.constraints?.some((constraint) =>
    constraint.kind === 'pierce' && constraint.planeDatumId === datumId));
  if (usedBy.length || sketchUsers.length || referenceCurveUsers.length || datumUsers.length || patternUsers.length || pierceUsers.length) {
    throw new Error('Datum is used by ' + [...usedBy.map((entry) => entry.name), ...sketchUsers.map((entry) => entry.name), ...referenceCurveUsers.map((entry) => entry.name), ...datumUsers.map((entry) => entry.name), ...patternUsers.map((entry) => entry.name), ...pierceUsers.map((entry) => entry.name)].join(', ') + '. Repair or delete those dependents first.');
  }
  part.referenceGeometry = part.referenceGeometry.filter((entry) => entry.id !== datumId);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

function advancedSketchEntity(input, role) {
  const dimensions = role === 'profile' ? 2 : 3;
  const minimum = role === 'profile' ? 3 : 2;
  const points = clone(input.points || []);
  if (!Array.isArray(points) || points.length < minimum) throw new Error((role === 'profile' ? 'Profiles' : 'Paths') + ' require at least ' + minimum + ' points.');
  if (points.some((point) => !Array.isArray(point) || point.length !== dimensions)) {
    throw new Error((role === 'profile' ? 'Profile' : 'Path') + ' points must contain ' + dimensions + ' coordinates.');
  }
  const kind = input.kind || 'spline';
  if (kind !== 'spline' && kind !== 'polyline') throw new Error('Sketch curve kind must be spline or polyline.');
  return { id: input.entityId || 'entity-' + input.id, kind, points, closed: role === 'profile' };
}

function validateAdvancedSketch(project, part, sketch) {
  const role = sketch.extensions?.studioRole;
  if (role !== 'profile' && role !== 'path') throw new Error('Advanced sketches must declare a profile or path role.');
  const entity = sketch.entities[0];
  const parameters = studioV5ParameterValues(project, part);
  const points = entity.points.map((point) => point.map((value) => evaluateStudioV5Expression(value, parameters)));
  for (let index = 1; index < points.length; index++) {
    if (Math.hypot(...points[index].map((value, axis) => value - points[index - 1][axis])) <= 1e-8) throw new Error('Sketch contains consecutive duplicate points.');
  }
  if (role === 'profile') {
    if (sketch.support?.ownerKind !== 'datum') throw new Error('A profile must be supported by a datum plane.');
    const frame = resolveStudioV5Datums(project, part.id).resolve(sketch.support.ownerId);
    if (frame.kind !== 'plane') throw new Error('A profile support must resolve to a datum plane.');
    const area = Math.abs(points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2);
    if (area <= 1e-8) throw new Error('Profile has zero enclosed area.');
  }
  return points;
}

function createStudioV5AdvancedSketch(project, input, role) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  requireUniquePartId(part, input.id, role === 'profile' ? 'Profile sketch' : 'Path sketch');
  const entity = advancedSketchEntity(input, role);
  const sketch = {
    id: input.id,
    name: String(input.name || '').trim(),
    ...(role === 'profile' ? { support: { ownerKind: 'datum', ownerId: input.planeDatumId, semanticPath: { role: 'support' }, signature: { kind: 'plane' } } } : {}),
    entities: [entity],
    groups: [],
    constraints: [],
    extensions: { ...(input.extensions || {}), studioRole: role },
  };
  if (!sketch.name) throw new Error('Sketch name is required.');
  part.sketches.push(sketch);
  const prepared = prepareStudioV5Project(candidate);
  validateAdvancedSketch(prepared, studioV5RootPart(prepared), sketch);
  return decorateStudioV5Project(prepared);
}

export function createStudioV5ProfileSketch(project, input) {
  return createStudioV5AdvancedSketch(project, input, 'profile');
}

export function createStudioV5PathSketch(project, input) {
  return createStudioV5AdvancedSketch(project, input, 'path');
}

function refreshStudioV5ReferenceCurvePreviewsInPart(project, part) {
  for (const sketch of part.sketches) {
    if (!sketch.extensions?.referenceCurve) continue;
    const preview = resolveStudioV5PathPreview(project, sketch.id, part.id);
    sketch.entities = [{
      id: sketch.entities?.[0]?.id || 'entity-' + sketch.id,
      kind: 'polyline',
      points: preview.points,
      closed: false,
    }];
  }
}

export function refreshStudioV5ReferenceCurves(project) {
  const candidate = canonicalStudioV5Project(project);
  if (candidate.rootDocument?.kind !== 'part') return decorateStudioV5Project(prepareStudioV5Project(candidate));
  const part = studioV5RootPart(candidate);
  refreshStudioV5ReferenceCurvePreviewsInPart(candidate, part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function createStudioV5ReferenceCurve(project, input) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  requireUniquePartId(part, input.id, 'Reference curve');
  const sketch = {
    id: input.id,
    name: String(input.name || '').trim(),
    entities: [{ id: input.entityId || 'entity-' + input.id, kind: 'polyline', points: [[0, 0, 0], [1, 0, 0]], closed: false }],
    groups: [],
    constraints: [],
    extensions: { studioRole: 'path', referenceCurve: clone(input.definition) },
  };
  if (!sketch.name) throw new Error('Reference curve name is required.');
  part.sketches.push(sketch);
  refreshStudioV5ReferenceCurvePreviewsInPart(candidate, part);
  const prepared = prepareStudioV5Project(candidate);
  validateAdvancedSketch(prepared, studioV5RootPart(prepared), sketch);
  return decorateStudioV5Project(prepared);
}

export function updateStudioV5ReferenceCurve(project, sketchId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sketch = part.sketches.find((entry) => entry.id === sketchId && entry.extensions?.referenceCurve);
  if (!sketch) throw new Error('That reference curve no longer exists.');
  if (patch.name != null) sketch.name = String(patch.name).trim();
  if (!sketch.name) throw new Error('Reference curve name is required.');
  if (owns(patch, 'definition')) sketch.extensions.referenceCurve = clone(patch.definition);
  refreshStudioV5ReferenceCurvePreviewsInPart(candidate, part);
  const prepared = prepareStudioV5Project(candidate);
  const preparedPart = studioV5RootPart(prepared);
  validateAdvancedSketch(prepared, preparedPart, preparedPart.sketches.find((entry) => entry.id === sketchId));
  const resolution = resolveStudioV5Datums(prepared, preparedPart.id);
  for (const datum of preparedPart.referenceGeometry) {
    if (Object.values(datum.definition || {}).includes(sketchId)) resolution.resolve(datum.id);
  }
  return decorateStudioV5Project(prepared);
}

export function updateStudioV5AdvancedSketch(project, sketchId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sketch = part.sketches.find((entry) => entry.id === sketchId);
  const role = sketch?.extensions?.studioRole;
  if (!sketch || (role !== 'profile' && role !== 'path')) throw new Error('That profile or path sketch no longer exists.');
  if (sketch.extensions?.referenceCurve) throw new Error('Reference curves must be edited through their typed reference-curve command.');
  if (patch.name != null) sketch.name = String(patch.name).trim();
  if (!sketch.name) throw new Error('Sketch name is required.');
  if (patch.points != null || patch.kind != null) {
    sketch.entities = [advancedSketchEntity({ id: sketch.id, entityId: sketch.entities[0]?.id, points: patch.points ?? sketch.entities[0].points, kind: patch.kind ?? sketch.entities[0].kind }, role)];
  }
  if (role === 'profile' && patch.planeDatumId != null) sketch.support.ownerId = patch.planeDatumId;
  refreshStudioV5ReferenceCurvePreviewsInPart(candidate, part);
  const prepared = prepareStudioV5Project(candidate);
  const preparedPart = studioV5RootPart(prepared);
  validateAdvancedSketch(prepared, preparedPart, sketch);
  const dependentDatums = preparedPart.referenceGeometry.filter((datum) =>
    Object.entries(datum.definition || {}).some(([field, value]) => field.endsWith('SketchId') && value === sketchId));
  if (dependentDatums.length) {
    const resolution = resolveStudioV5Datums(prepared, preparedPart.id);
    for (const datum of dependentDatums) resolution.resolve(datum.id);
  }
  return decorateStudioV5Project(prepared);
}

export function deleteStudioV5AdvancedSketch(project, sketchId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sketch = part.sketches.find((entry) => entry.id === sketchId);
  if (!sketch) throw new Error('That sketch no longer exists.');
  const users = part.features.filter((feature) => feature.inputRefs.some((reference) => reference.ownerKind === 'sketch' && reference.ownerId === sketchId));
  const patternUsers = (part.bodyPatterns || []).filter((pattern) => pattern.references?.some((reference) => reference.ownerKind === 'sketch' && reference.ownerId === sketchId));
  const datumUsers = part.referenceGeometry.filter((datum) =>
    Object.entries(datum.definition || {}).some(([field, value]) => field.endsWith('SketchId') && value === sketchId));
  const sketchUsers = part.sketches.filter((entry) => entry.id !== sketchId && (
    entry.extensions?.referenceCurve?.sourceSketchId === sketchId ||
    entry.extensions?.referenceCurve?.sourceSketchIds?.includes(sketchId)
  ));
  const pierceUsers = part.features.filter((feature) => feature.sketch?.constrained?.constraints?.some((constraint) =>
    constraint.kind === 'pierce' && constraint.curveSketchId === sketchId));
  if (users.length || patternUsers.length || datumUsers.length || sketchUsers.length || pierceUsers.length) {
    throw new Error('Sketch is used by ' + [...users, ...patternUsers, ...datumUsers, ...sketchUsers, ...pierceUsers].map((entry) => entry.name).join(', ') + '. Repair or delete those dependents first.');
  }
  part.sketches = part.sketches.filter((entry) => entry.id !== sketchId);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

function constrainedSketchReference(sketchId) {
  return {
    ownerKind: 'sketch', ownerId: sketchId,
    semanticPath: { role: 'profile' }, signature: { role: 'profile' },
  };
}

function normalizedConstrainedSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Constrained source must be an object.');
  }
  const allowed = new Set(['entities', 'constraints', 'blockInstances', 'relations', 'derivedFrom']);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new Error('Constrained source contains unsupported field "' + key + '".');
  }
  if (!Array.isArray(source.entities)) throw new Error('Constrained source entities must be an array.');
  for (const field of ['constraints', 'blockInstances', 'relations']) {
    if (source[field] !== undefined && !Array.isArray(source[field])) {
      throw new Error('Constrained source ' + field + ' must be an array.');
    }
  }
  return {
    entities: clone(source.entities || []),
    constraints: clone(source.constraints || []),
    blockInstances: clone(source.blockInstances || []),
    relations: clone(source.relations || []),
    ...(source.derivedFrom !== undefined ? { derivedFrom: clone(source.derivedFrom) } : {}),
  };
}

function constrainedSketchRecord(input) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Constrained sketch name is required.');
  return {
    id: input.id,
    name,
    plane: input.plane || 'XY',
    z: owns(input, 'z') ? clone(input.z) : 0,
    entities: [],
    groups: [],
    constraints: [],
    constrained: normalizedConstrainedSource(input.constrained),
    extensions: {
      ...(input.extensions || {}),
      studioRole: STUDIO_CONSTRAINED_2D_ROLE,
      sketchInstancesSchema: STUDIO_SKETCH_INSTANCES_SCHEMA,
    },
  };
}

function finishSketchInstanceCandidate(candidate) {
  for (const part of candidate.partDefinitions || []) reconcileStudioV5Bodies(part);
  const prepared = prepareStudioV5Project(candidate);
  for (const preparedPart of prepared.partDefinitions || []) {
    const parameters = studioV5ParameterValues(prepared, preparedPart);
    const evaluate = (value) => evaluateStudioV5Expression(value, parameters);
    const definitionSolutions = resolveStudioSketchBlockDefinitions(preparedPart, { evaluate });
    for (const sketch of preparedPart.sketches) {
      if (sketch.extensions?.studioRole !== STUDIO_CONSTRAINED_2D_ROLE) continue;
      const solidConsumers = preparedPart.features.filter((feature) => feature.sketchId === sketch.id);
      const resolved = resolveStudioConstrainedSketch(preparedPart, sketch.id, {
        evaluate,
        definitionSolutions,
        requireClosedProfile: solidConsumers.length > 0,
      });
      if (solidConsumers.length && resolved.exactEntities.some((entity) => entity.kind === 'spline')) {
        throw new Error(
          'First-class spline profiles remain unsupported for solids until exact spline side-face naming is available.',
        );
      }
    }
  }
  return decorateStudioV5Project(prepared);
}

export function refreshStudioV5SketchInstances(project) {
  return finishSketchInstanceCandidate(canonicalStudioV5Project(project));
}

function requireConstrainedSketch(part, sketchId) {
  const sketch = part.sketches.find((entry) =>
    entry.id === sketchId && entry.extensions?.studioRole === STUDIO_CONSTRAINED_2D_ROLE);
  if (!sketch) throw new Error('That first-class constrained sketch no longer exists.');
  return sketch;
}

function requireSketchBlockDefinition(part, definitionId) {
  const definition = (part.sketchBlockDefinitions || []).find((entry) => entry.id === definitionId);
  if (!definition) throw new Error('That sketch-block definition no longer exists.');
  return definition;
}

function assertSketchPatch(patch, allowedKeys, label) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(label + ' patch must be an object.');
  }
  const keys = Object.keys(patch);
  if (!keys.length) throw new Error(label + ' patch must change at least one supported field.');
  for (const key of keys) {
    if (!allowedKeys.includes(key)) throw new Error(label + ' patch contains unsupported field "' + key + '".');
  }
}

export function createStudioV5ConstrainedSketch(project, input) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  if (input.constrained?.derivedFrom !== undefined) {
    throw new Error('Use sketch.derived.create so source support and member identity are preserved.');
  }
  requireUniquePartId(part, input.id, 'Constrained sketch');
  part.sketches.push(constrainedSketchRecord(input));
  return finishSketchInstanceCandidate(candidate);
}

export function promoteStudioV5InlineConstrainedSketch(project, featureId, input) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId);
  if (!feature?.sketch?.constrained) throw new Error('Only an inline constraint-native feature sketch can be promoted.');
  if (feature.type !== 'extrude' && feature.type !== 'cut') {
    throw new Error('Only inline Extrude and Cut sketches can be promoted into first-class solid-profile consumers.');
  }
  requireUniquePartId(part, input.id, 'Constrained sketch');
  const plane = input.plane || feature.plane?.plane || 'XY';
  const sketch = constrainedSketchRecord({
    id: input.id,
    name: input.name || feature.name + ' sketch',
    plane,
    z: feature.sketch.z ?? 0,
    constrained: feature.sketch.constrained,
  });
  part.sketches.push(sketch);
  delete feature.sketch;
  feature.sketchId = sketch.id;
  feature.plane = { kind: 'base', plane };
  feature.inputRefs = [
    ...(feature.inputRefs || []).filter((reference) =>
      reference.ownerKind !== 'sketch' || reference.ownerId !== sketch.id),
    constrainedSketchReference(sketch.id),
  ];
  feature.extensions = { ...(feature.extensions || {}), exactSketchEntities: true };
  return finishSketchInstanceCandidate(candidate);
}

export function updateStudioV5ConstrainedSketch(project, sketchId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sketch = requireConstrainedSketch(part, sketchId);
  assertSketchPatch(patch, ['name', 'plane', 'z', 'constrained'], 'Constrained sketch');
  if (patch.name !== undefined) {
    sketch.name = String(patch.name).trim();
    if (!sketch.name) throw new Error('Constrained sketch name is required.');
  }
  if (patch.plane !== undefined) sketch.plane = patch.plane;
  if (patch.z !== undefined) sketch.z = clone(patch.z);
  if (patch.constrained !== undefined) {
    if (sketch.constrained.derivedFrom) throw new Error('A linked derived sketch rejects direct membership edits; Underive it first.');
    if (patch.constrained.derivedFrom !== undefined) {
      throw new Error('Use sketch.derived.create so source support and member identity are preserved.');
    }
    sketch.constrained = normalizedConstrainedSource(patch.constrained);
  }
  for (const feature of part.features.filter((entry) => entry.sketchId === sketch.id)) {
    feature.plane = { kind: 'base', plane: sketch.plane };
  }
  return finishSketchInstanceCandidate(candidate);
}

export function deleteStudioV5ConstrainedSketch(project, sketchId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sketch = requireConstrainedSketch(part, sketchId);
  const featureUsers = part.features.filter((feature) => feature.sketchId === sketch.id ||
    feature.inputRefs?.some((reference) => reference.ownerKind === 'sketch' && reference.ownerId === sketch.id));
  const derivedUsers = part.sketches.filter((entry) => entry.constrained?.derivedFrom?.sourceSketchId === sketch.id);
  const patternUsers = (part.bodyPatterns || []).filter((pattern) =>
    pattern.references?.some((reference) => reference.ownerKind === 'sketch' && reference.ownerId === sketch.id));
  if (featureUsers.length || derivedUsers.length || patternUsers.length) {
    throw new Error('Sketch is used by ' + [...featureUsers, ...derivedUsers, ...patternUsers].map((entry) => entry.name).join(', ') + '. Repair or delete those dependents first.');
  }
  part.sketches = part.sketches.filter((entry) => entry.id !== sketch.id);
  return finishSketchInstanceCandidate(candidate);
}

function selectedBlockDefinitionSource(sketch, memberEntityIds) {
  const source = sketch.constrained;
  if (source.derivedFrom) throw new Error('A derived sketch cannot become a block definition until it is underived.');
  if ((source.blockInstances || []).length) throw new Error('Nested sketch blocks are outside this block-definition contract; explode instances first.');
  const requested = memberEntityIds?.length
    ? new Set(memberEntityIds)
    : new Set(source.entities.map((entity) => entity.id));
  const byId = new Map(source.entities.map((entity) => [entity.id, entity]));
  for (const selectedId of requested) if (!byId.has(selectedId)) throw new Error('Selected sketch member "' + selectedId + '" does not exist.');
  const include = new Set(requested);
  const addPoint = (pointId) => { if (byId.get(pointId)?.kind === 'point') include.add(pointId); };
  for (const selectedId of [...requested]) {
    const entity = byId.get(selectedId);
    if (entity.kind === 'line') { addPoint(entity.a); addPoint(entity.b); }
    else if (entity.kind === 'circle') addPoint(entity.center);
    else if (entity.kind === 'arc') { addPoint(entity.center); addPoint(entity.a); addPoint(entity.b); }
    else if (entity.kind === 'spline') entity.through.forEach(addPoint);
  }
  const entities = source.entities.filter((entity) => include.has(entity.id));
  if (!entities.some((entity) => entity.kind !== 'point' && entity.construction !== true)) {
    throw new Error('A block definition requires selected non-construction sketch geometry.');
  }
  const referenceFields = ['a', 'b', 'line', 'circle', 'point', 'axis'];
  const selectedRecords = (records, label, normalizeReference) => records.flatMap((record, index) => {
    const references = referenceFields.flatMap((field) => {
      if (record[field] === undefined) return [];
      const normalized = normalizeReference(record[field], label + '[' + index + '].' + field);
      return [{ field, id: normalized }];
    });
    const selected = references.filter((reference) => include.has(reference.id));
    if (!selected.length) return [];
    if (selected.length !== references.length) {
      throw new Error(
        'Selected block members have a cross-boundary ' + label + ' at index ' + index
          + '; include every referenced member or remove that relation first.',
      );
    }
    const output = clone(record);
    for (const reference of references) output[reference.field] = reference.id;
    return [output];
  });
  const constraintRecords = selectedRecords(
    source.constraints || [],
    'constraint',
    (reference) => reference,
  );
  const relationRecords = selectedRecords(
    source.relations || [],
    'relation',
    (reference, path) => {
      if (typeof reference === 'string') return reference;
      if (reference?.entityId) return reference.entityId;
      throw new Error(path + ' is not a local entity relation and cannot be captured inside a block definition.');
    },
  );
  const constraints = [...constraintRecords, ...relationRecords];
  return { entities: clone(entities), constraints: clone(constraints), blockInstances: [], relations: [] };
}

export function createStudioV5SketchBlockDefinition(project, input) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  requireUniquePartId(part, input.id, 'Sketch-block definition');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Sketch-block definition name is required.');
  const hasConstrainedSource = input.constrained !== undefined;
  const hasSketchSource = input.sourceSketchId !== undefined;
  if (hasConstrainedSource === hasSketchSource) {
    throw new Error('Choose exactly one block-definition source: constrained or sourceSketchId.');
  }
  let constrained;
  if (hasConstrainedSource) constrained = normalizedConstrainedSource(input.constrained);
  else {
    const sourceSketch = requireConstrainedSketch(part, input.sourceSketchId);
    constrained = selectedBlockDefinitionSource(sourceSketch, input.memberEntityIds);
  }
  part.sketchBlockDefinitions = part.sketchBlockDefinitions || [];
  part.sketchBlockDefinitions.push({
    id: input.id,
    name,
    insertionPoint: clone(input.insertionPoint || [0, 0]),
    constrained,
  });
  return finishSketchInstanceCandidate(candidate);
}

export function updateStudioV5SketchBlockDefinition(project, definitionId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const definition = requireSketchBlockDefinition(part, definitionId);
  assertSketchPatch(patch, ['name', 'insertionPoint', 'constrained'], 'Sketch-block definition');
  if (patch.name !== undefined) {
    definition.name = String(patch.name).trim();
    if (!definition.name) throw new Error('Sketch-block definition name is required.');
  }
  if (patch.insertionPoint !== undefined) definition.insertionPoint = clone(patch.insertionPoint);
  if (patch.constrained !== undefined) definition.constrained = normalizedConstrainedSource(patch.constrained);
  return finishSketchInstanceCandidate(candidate);
}

export function deleteStudioV5SketchBlockDefinition(project, definitionId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const definition = requireSketchBlockDefinition(part, definitionId);
  const users = part.sketches.filter((sketch) =>
    sketch.constrained?.blockInstances?.some((instance) => instance.definitionId === definition.id));
  if (users.length) throw new Error('Sketch-block definition is used by ' + users.map((entry) => entry.name).join(', ') + '. Explode or delete those instances first.');
  part.sketchBlockDefinitions = part.sketchBlockDefinitions.filter((entry) => entry.id !== definition.id);
  return finishSketchInstanceCandidate(candidate);
}

export function createStudioV5SketchBlockInstance(project, sketchId, input) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sketch = requireConstrainedSketch(part, sketchId);
  if (sketch.constrained.derivedFrom) throw new Error('A linked derived sketch rejects block insertion; Underive it first.');
  requireSketchBlockDefinition(part, input.definitionId);
  const instances = sketch.constrained.blockInstances || (sketch.constrained.blockInstances = []);
  if (instances.some((entry) => entry.id === input.id)) throw new Error('Sketch-block instance ID is already in use.');
  instances.push({
    id: input.id,
    definitionId: input.definitionId,
    transform: clone(input.transform),
    fixed: input.fixed === true,
  });
  if (Array.isArray(input.relations)) sketch.constrained.relations.push(...clone(input.relations));
  return finishSketchInstanceCandidate(candidate);
}

export function updateStudioV5SketchBlockInstance(project, sketchId, instanceId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sketch = requireConstrainedSketch(part, sketchId);
  const instance = sketch.constrained.blockInstances?.find((entry) => entry.id === instanceId);
  if (!instance) throw new Error('That sketch-block instance no longer exists.');
  assertSketchPatch(patch, ['definitionId', 'transform', 'fixed'], 'Sketch-block instance');
  if (patch.definitionId !== undefined) {
    throw new Error('Replacing an instance definition requires an explicit member-identity mapping and is not supported.');
  }
  if (patch.transform !== undefined) instance.transform = clone(patch.transform);
  if (patch.fixed !== undefined) instance.fixed = patch.fixed;
  return finishSketchInstanceCandidate(candidate);
}

function relationReferencesInstance(relation, instanceId) {
  return ['a', 'b', 'line', 'circle', 'point', 'axis'].some((field) =>
    relation?.[field]?.instanceId === instanceId);
}

export function deleteStudioV5SketchBlockInstance(project, sketchId, instanceId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sketch = requireConstrainedSketch(part, sketchId);
  const instance = sketch.constrained.blockInstances?.find((entry) => entry.id === instanceId);
  if (!instance) throw new Error('That sketch-block instance no longer exists.');
  const relationUsers = (sketch.constrained.relations || []).filter((relation) =>
    relationReferencesInstance(relation, instanceId));
  if (relationUsers.length) {
    throw new Error(
      'Sketch-block instance is used by relations '
        + relationUsers.map((relation) => relation.id || relation.kind).join(', ')
        + '. Delete or rewrite those relations first.',
    );
  }
  sketch.constrained.blockInstances = sketch.constrained.blockInstances.filter((entry) => entry.id !== instanceId);
  return finishSketchInstanceCandidate(candidate);
}

function requireSketchRelation(sketch, relationId) {
  const relation = (sketch.constrained.relations || []).find((entry) => entry.id === relationId);
  if (!relation) throw new Error('That first-class sketch relation no longer exists.');
  return relation;
}

export function createStudioV5SketchRelation(project, sketchId, relation) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sketch = requireConstrainedSketch(part, sketchId);
  const relationId = relation?.id;
  if (typeof relationId !== 'string' || !relationId || relationId !== relationId.trim()) {
    throw new Error('First-class sketch relation ID must be a canonical stable ID without surrounding whitespace.');
  }
  const relations = sketch.constrained.relations || (sketch.constrained.relations = []);
  if (part.sketches.some((entry) =>
    (entry.constrained?.relations || []).some((candidateRelation) => candidateRelation.id === relationId))) {
    throw new Error('First-class sketch relation ID is already in use.');
  }
  relations.push(clone({ ...relation, id: relationId }));
  return finishSketchInstanceCandidate(candidate);
}

export function updateStudioV5SketchRelation(project, sketchId, relationId, replacement) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sketch = requireConstrainedSketch(part, sketchId);
  const current = requireSketchRelation(sketch, relationId);
  const replacementId = replacement?.id === undefined ? relationId : replacement.id;
  if (typeof replacementId !== 'string' || !replacementId || replacementId !== replacementId.trim()) {
    throw new Error('First-class sketch relation ID must be a canonical stable ID without surrounding whitespace.');
  }
  if (replacementId !== relationId) throw new Error('Updating a sketch relation cannot change its stable ID.');
  const index = sketch.constrained.relations.indexOf(current);
  sketch.constrained.relations[index] = clone({ ...replacement, id: relationId });
  return finishSketchInstanceCandidate(candidate);
}

export function deleteStudioV5SketchRelation(project, sketchId, relationId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sketch = requireConstrainedSketch(part, sketchId);
  requireSketchRelation(sketch, relationId);
  sketch.constrained.relations = sketch.constrained.relations.filter((entry) => entry.id !== relationId);
  return finishSketchInstanceCandidate(candidate);
}

function rewriteExplodedRelations(relations, instanceId, memberMap) {
  return (relations || []).map((relation) => {
    const rewritten = clone(relation);
    for (const field of ['a', 'b', 'line', 'circle', 'point', 'axis']) {
      const reference = rewritten[field];
      if (reference?.instanceId !== instanceId) continue;
      const mapped = memberMap.get(studioSketchBlockMemberId(instanceId, reference.memberId));
      if (!mapped) throw new Error('Block relation references a member that cannot be exploded.');
      rewritten[field] = mapped;
    }
    return rewritten;
  });
}

export function explodeStudioV5SketchBlockInstance(project, sketchId, instanceId, effects = {}) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sketch = requireConstrainedSketch(part, sketchId);
  const instance = sketch.constrained.blockInstances?.find((entry) => entry.id === instanceId);
  if (!instance) throw new Error('That sketch-block instance no longer exists.');
  const parameters = studioV5ParameterValues(candidate, part);
  const resolved = resolveStudioConstrainedSketch(part, sketch.id, {
    evaluate: (value) => evaluateStudioV5Expression(value, parameters),
  });
  const members = resolved.solved.entities.filter((entity) =>
    entity.id.startsWith(studioSketchBlockMemberPrefix(instanceId)));
  const materialized = materializeStudioSketchMembers(members, {
    idPrefix: 'exploded-' + instanceId,
    preserveIds: true,
    constraints: resolved.connectivityConstraints,
  });
  sketch.constrained.entities.push(...materialized.entities);
  sketch.constrained.constraints.push(...materialized.constraints);
  sketch.constrained.relations = rewriteExplodedRelations(sketch.constrained.relations, instanceId, materialized.idMap);
  sketch.constrained.blockInstances = sketch.constrained.blockInstances.filter((entry) => entry.id !== instanceId);
  if (Array.isArray(effects.remapped)) {
    for (const [fromId, toId] of materialized.idMap) if (fromId !== toId) effects.remapped.push({
      from: { kind: 'sketch-member', id: fromId },
      to: { kind: 'sketch-member', id: toId },
      reason: 'block-explode',
    });
  }
  return finishSketchInstanceCandidate(candidate);
}

export function createStudioV5DerivedSketch(project, input) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  requireUniquePartId(part, input.id, 'Derived sketch');
  const sourceSketch = requireConstrainedSketch(part, input.sourceSketchId);
  part.sketches.push(constrainedSketchRecord({
    id: input.id,
    name: input.name,
    plane: input.plane || sourceSketch.plane,
    z: owns(input, 'z') ? input.z : clone(sourceSketch.z ?? 0),
    constrained: {
      entities: [], constraints: [], blockInstances: [], relations: clone(input.relations || []),
      derivedFrom: { sourceSketchId: input.sourceSketchId, transform: clone(input.transform) },
    },
  }));
  return finishSketchInstanceCandidate(candidate);
}

export function updateStudioV5DerivedSketch(project, sketchId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sketch = requireConstrainedSketch(part, sketchId);
  if (!sketch.constrained.derivedFrom) throw new Error('That sketch is not derived.');
  assertSketchPatch(patch, ['sourceSketchId', 'transform', 'relations', 'name', 'plane', 'z'], 'Derived sketch');
  if (patch.sourceSketchId !== undefined) {
    throw new Error('Relinking a derived sketch requires an explicit member-identity mapping and is not supported.');
  }
  if (patch.transform !== undefined) sketch.constrained.derivedFrom.transform = clone(patch.transform);
  if (patch.relations !== undefined) sketch.constrained.relations = clone(patch.relations);
  if (patch.name !== undefined) {
    sketch.name = String(patch.name).trim();
    if (!sketch.name) throw new Error('Derived sketch name is required.');
  }
  if (patch.plane !== undefined) {
    sketch.plane = patch.plane;
    for (const feature of part.features.filter((entry) => entry.sketchId === sketch.id)) {
      feature.plane = { kind: 'base', plane: sketch.plane };
    }
  }
  if (patch.z !== undefined) sketch.z = clone(patch.z);
  return finishSketchInstanceCandidate(candidate);
}

export function underiveStudioV5DerivedSketch(project, sketchId, effects = {}) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sketch = requireConstrainedSketch(part, sketchId);
  if (!sketch.constrained.derivedFrom) throw new Error('That sketch is not derived.');
  const parameters = studioV5ParameterValues(candidate, part);
  const resolved = resolveStudioConstrainedSketch(part, sketch.id, {
    evaluate: (value) => evaluateStudioV5Expression(value, parameters),
  });
  const materialized = materializeStudioSketchMembers(resolved.solved.entities, {
    idPrefix: 'underived-' + sketch.id,
    preserveIds: true,
    constraints: resolved.connectivityConstraints,
  });
  const rewrittenRelations = (sketch.constrained.relations || []).map((relation) => {
    const rewritten = clone(relation);
    for (const field of ['a', 'b', 'line', 'circle', 'point', 'axis']) {
      const reference = rewritten[field];
      if (!reference?.derivedMemberId) continue;
      const mapped = materialized.idMap.get(studioDerivedSketchMemberId(sketch.id, reference.derivedMemberId));
      if (!mapped) throw new Error('Derived relation references a member that cannot be materialized.');
      rewritten[field] = mapped;
    }
    return rewritten;
  });
  sketch.constrained = {
    entities: materialized.entities,
    constraints: materialized.constraints,
    blockInstances: [],
    relations: rewrittenRelations,
  };
  if (Array.isArray(effects.remapped)) {
    for (const [fromId, toId] of materialized.idMap) if (fromId !== toId) effects.remapped.push({
      from: { kind: 'sketch-member', id: fromId },
      to: { kind: 'sketch-member', id: toId },
      reason: 'derived-underive',
    });
  }
  return finishSketchInstanceCandidate(candidate);
}

function advancedFeaturePolicy(part, options) {
  if (!owns(options, 'targetBodyId') || options.targetBodyId === undefined) {
    return { kind: 'new-body', bodyName: options.bodyName || options.name || 'Advanced body' };
  }
  if (typeof options.targetBodyId !== 'string' || !options.targetBodyId) throw new Error('Target body ID must be a non-empty string when provided.');
  if (!part.bodies.some((body) => body.id === options.targetBodyId)) throw new Error('Choose an existing target body.');
  const kind = authoredOr(options, 'operation', 'add');
  if (!['add', 'subtract', 'intersect'].includes(kind)) throw new Error('Advanced feature result policy is unsupported.');
  return { kind, targetBodyIds: [options.targetBodyId] };
}

function sketchReference(sketchId, role, index) {
  return { ownerKind: 'sketch', ownerId: sketchId, semanticPath: { role, ...(index == null ? {} : { index }) }, signature: { role } };
}

function requireAdvancedSketch(part, sketchId, role) {
  const sketch = part.sketches.find((entry) => entry.id === sketchId);
  if (!sketch || sketch.extensions?.studioRole !== role) throw new Error('Choose an existing ' + role + ' sketch.');
  return sketch;
}

function buildStudioV5LoftFeature(project, part, options, updatingId = null) {
  if (options.id !== updatingId) requireUniquePartId(part, options.id, 'Loft feature');
  const closed = optionalAuthoredBoolean(options, 'closed', false);
  const ruled = optionalAuthoredBoolean(options, 'ruled', false);
  if (closed) throw new Error('Closed periodic Loft is not available in this kernel increment.');
  const mapping = authoredOr(options, 'mapping', 'explicit');
  if (mapping !== 'explicit') throw new Error('This kernel increment requires explicit Loft section mapping.');
  if (!Array.isArray(options.sections)) throw new Error('Loft sections must be an array.');
  const sections = options.sections.map((section, index) => {
    if (typeof section !== 'string' && (!section || typeof section !== 'object' || Array.isArray(section))) {
      throw new Error('Loft section ' + index + ' must be a sketch ID or section object.');
    }
    const sketchId = typeof section === 'string' ? section : section.sketchId;
    const sketch = requireAdvancedSketch(part, sketchId, 'profile');
    const pointCount = sketch.entities[0].points.length;
    const startIndex = typeof section === 'string' || !owns(section, 'startIndex') ? 0 : section.startIndex;
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= pointCount) throw new Error('Loft section start index is out of range.');
    const reversed = typeof section === 'string' ? false : optionalAuthoredBoolean(section, 'reversed', false);
    return { sketchId, startIndex, reversed, index };
  });
  if (sections.length < 2 || new Set(sections.map((entry) => entry.sketchId)).size !== sections.length) throw new Error('Loft requires two or more distinct ordered profiles.');
  const guideSketchIds = optionalAuthoredArray(options, 'guideSketchIds');
  if (new Set(guideSketchIds).size !== guideSketchIds.length) throw new Error('Loft guide sketches must not repeat.');
  if (guideSketchIds.length || options.centerlineSketchId) {
    throw new Error(
      'Guided and centerline Loft are unavailable because this build cannot prove persistent face, edge, and vertex identity from OCCT history.',
    );
  }
  guideSketchIds.forEach((id) => requireAdvancedSketch(part, id, 'path'));
  if (guideSketchIds.length > 1) throw new Error('This kernel increment supports one explicit Loft guide curve.');
  if (options.centerlineSketchId) requireAdvancedSketch(part, options.centerlineSketchId, 'path');
  const continuityInput = authoredOr(options, 'continuity', {});
  if (!continuityInput || typeof continuityInput !== 'object' || Array.isArray(continuityInput)) throw new Error('Loft continuity must be an object.');
  const continuity = {
    start: authoredOr(continuityInput, 'start', 'free'),
    end: authoredOr(continuityInput, 'end', 'free'),
  };
  if (![continuity.start, continuity.end].every((value) => ['free', 'tangent', 'curvature'].includes(value))) throw new Error('Loft continuity must be free, tangent, or curvature.');
  if (continuity.start !== continuity.end) throw new Error('Loft start and end continuity must match because the exact kernel applies one global continuity order.');
  const feature = {
    id: options.id,
    name: String(options.name || 'Loft').trim(),
    type: 'loft',
    suppressed: false,
    sections: sections.map(({ index: _index, ...entry }) => entry),
    guideSketchIds,
    ...(options.centerlineSketchId ? { centerlineSketchId: options.centerlineSketchId } : {}),
    mapping,
    continuity,
    ruled,
    closed,
    inputRefs: [
      ...sections.map((section) => sketchReference(section.sketchId, 'section', section.index)),
      ...guideSketchIds.map((id, index) => sketchReference(id, 'guide', index)),
      ...(options.centerlineSketchId ? [sketchReference(options.centerlineSketchId, 'centerline')] : []),
    ],
    resultPolicy: advancedFeaturePolicy(part, options),
  };
  if (!feature.name) throw new Error('Loft name is required.');
  return feature;
}

export function createStudioV5LoftFeature(project, options) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = buildStudioV5LoftFeature(candidate, part, options);
  part.features.push(feature);
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

function buildStudioV5SweepFeature(project, part, options, updatingId = null) {
  if (options.id !== updatingId) requireUniquePartId(part, options.id, 'Sweep feature');
  requireAdvancedSketch(part, options.profileSketchId, 'profile');
  requireAdvancedSketch(part, options.pathSketchId, 'path');
  if (owns(options, 'guideSketchId') && options.guideSketchId !== undefined) requireAdvancedSketch(part, options.guideSketchId, 'path');
  const orientation = authoredOr(options, 'orientation', 'minimum-twist');
  if (!['path-normal', 'minimum-twist', 'fixed', 'reference', 'guide'].includes(orientation)) {
    throw new Error('Sweep orientation mode is unsupported; controlled-twist requires an exact kernel law that is not available yet.');
  }
  if (orientation === 'guide' && !options.guideSketchId) throw new Error('Guide orientation requires a guide path.');
  const parameters = studioV5ParameterValues(project, part);
  const twistAngleSource = authoredOr(options, 'twistAngle', 0);
  const scaleEndSource = authoredOr(options, 'scaleEnd', 1);
  const twistAngle = evaluateStudioV5Expression(twistAngleSource, parameters);
  const scaleEnd = evaluateStudioV5Expression(scaleEndSource, parameters);
  const referenceDirection = clone(authoredOr(options, 'referenceDirection', [0, 0, 1]));
  if (!Array.isArray(referenceDirection) || referenceDirection.length !== 3) throw new Error('Sweep reference direction requires three coordinates.');
  const evaluatedDirection = referenceDirection.map((value) => evaluateStudioV5Expression(value, parameters));
  if ((orientation === 'fixed' || orientation === 'reference') && Math.hypot(...evaluatedDirection) <= 1e-8) throw new Error('Sweep reference direction must be nonzero.');
  if (orientation !== 'fixed' && orientation !== 'reference' && Math.hypot(evaluatedDirection[0], evaluatedDirection[1], evaluatedDirection[2] - 1) > 1e-9) {
    throw new Error('Sweep reference direction must remain [0, 0, 1] when the selected orientation does not use it.');
  }
  if (Math.abs(twistAngle) > 1e-9) throw new Error('Sweep twist angle must remain zero until an exact controlled-twist kernel law is available.');
  if (!(scaleEnd > 0)) throw new Error('Sweep end scale must be greater than zero.');
  const transition = authoredOr(options, 'transition', 'right');
  if (!['transformed', 'round', 'right'].includes(transition)) throw new Error('Sweep transition mode is unsupported.');
  const feature = {
    id: options.id,
    name: String(options.name || 'Sweep').trim(),
    type: 'sweep',
    suppressed: false,
    profileSketchId: options.profileSketchId,
    pathSketchId: options.pathSketchId,
    ...(options.guideSketchId ? { guideSketchId: options.guideSketchId } : {}),
    orientation,
    referenceDirection,
    twistAngle: twistAngleSource,
    scaleEnd: scaleEndSource,
    transition,
    inputRefs: [
      sketchReference(options.profileSketchId, 'profile'),
      sketchReference(options.pathSketchId, 'path'),
      ...(options.guideSketchId ? [sketchReference(options.guideSketchId, 'guide')] : []),
    ],
    resultPolicy: advancedFeaturePolicy(part, options),
  };
  if (!feature.name) throw new Error('Sweep name is required.');
  return feature;
}

export function createStudioV5SweepFeature(project, options) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = buildStudioV5SweepFeature(candidate, part, options);
  part.features.push(feature);
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

function studioV5StructuralPath(project, pathSketchId) {
  const part = studioV5RootPart(project);
  const sketch = part.sketches.find((entry) => entry.id === pathSketchId);
  if (!sketch || sketch.extensions?.studioRole !== 'path') {
    throw new Error('Choose an existing exact path sketch for the structural member.');
  }
  const entity = sketch.entities?.[0];
  if (sketch.extensions?.referenceCurve || sketch.entities?.length !== 1 || entity?.kind !== 'polyline'
    || entity.points?.length !== 2) {
    throw new Error('Structural members require one direct two-point polyline path.');
  }
  const preview = resolveStudioV5PathPreview(project, pathSketchId, part.id);
  if (!preview.exactPolylineEvaluation || !preview.exactPointEvaluation || !preview.exactTangentEvaluation || typeof preview.tangent !== 'function') {
    throw new Error('Structural members require one exact straight segment; spline, helical, projected, and composite paths are unsupported.');
  }
  if (!Array.isArray(preview.points) || preview.points.length !== 2) {
    throw new Error('Structural-member paths require exactly two endpoints.');
  }
  if (Math.hypot(...preview.points[1].map((value, axis) => value - preview.points[0][axis])) <= 1e-7) {
    throw new Error('Structural-member paths cannot contain a zero-length segment.');
  }
  const tangent = preview.tangent(0);
  const preferredX = Math.abs(tangent[2]) < 0.95 ? [0, 0, 1] : [0, 1, 0];
  const frame = studioV5VectorMath.planeFrame([0, 0, 0], tangent, preferredX);
  return {
    part,
    sketch,
    preview,
    profileFrame: { normal: frame.normal, xDirection: frame.xDirection },
  };
}

function attachStudioStructuralMemberRecipe(project, featureId, recipe) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId);
  if (!feature) throw new Error('Structural-member Sweep feature is missing.');
  feature.extensions = { ...(feature.extensions || {}), structuralMember: clone(recipe) };
  part.extensions = {
    ...(part.extensions || {}),
    structuralProfileLibrary: {
      schema: STUDIO_STRUCTURAL_PROFILE_LIBRARY_SCHEMA,
      version: STUDIO_STRUCTURAL_PROFILE_CATALOG_VERSION,
      source: clone(STUDIO_STRUCTURAL_PROFILE_SOURCE),
    },
  };
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function createStudioStructuralMember(project, input) {
  const id = assertStudioStructuralMemberId(input?.id);
  const name = String(input?.name || 'Structural member').trim();
  if (!name || name.length > 200) throw new Error('Structural-member name must contain 1 to 200 characters.');
  const pathSketchId = input?.pathSketchId;
  let candidate = canonicalStudioV5Project(project);
  const path = studioV5StructuralPath(candidate, pathSketchId);
  const profile = studioStructuralProfile(input?.familyId, input?.presetId, input?.placement);
  const ids = studioStructuralMemberOwnedIds(id);
  const allIds = new Set([
    ...path.part.referenceGeometry.map((entry) => entry.id),
    ...path.part.sketches.map((entry) => entry.id),
    ...path.part.features.map((entry) => entry.id),
    ...path.part.bodies.map((entry) => entry.id),
  ]);
  for (const owned of [id, ids.profilePlaneId, ids.profileSketchId]) {
    if (allIds.has(owned)) throw new Error('Structural-member owned ID "' + owned + '" is already in use.');
  }
  candidate = createStudioV5Datum(candidate, {
    id: ids.profilePlaneId,
    name: name + ' profile plane',
    kind: 'plane',
    definition: {
      mode: 'curve-normal',
      curveSketchId: pathSketchId,
      parameter: 0,
      referenceNormal: path.profileFrame.normal,
      referenceXDirection: path.profileFrame.xDirection,
    },
    extensions: { structuralMemberOwnerId: id },
  });
  candidate = createStudioV5ProfileSketch(candidate, {
    id: ids.profileSketchId,
    name: profile.designation + ' profile',
    planeDatumId: ids.profilePlaneId,
    points: profile.points,
    kind: 'polyline',
    extensions: { structuralMemberOwnerId: id },
  });
  candidate = createStudioV5SweepFeature(candidate, {
    id,
    name,
    bodyName: String(input?.bodyName || name).trim() || name,
    profileSketchId: ids.profileSketchId,
    pathSketchId,
    orientation: 'minimum-twist',
    referenceDirection: [0, 0, 1],
    twistAngle: 0,
    scaleEnd: 1,
    transition: 'right',
  });
  return attachStudioStructuralMemberRecipe(
    candidate,
    id,
    studioStructuralMemberRecipe(id, pathSketchId, profile, ids, path.profileFrame),
  );
}

export function updateStudioStructuralMember(project, featureId, patch = {}) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const featureIndex = part.features.findIndex((entry) => entry.id === featureId);
  const feature = part.features[featureIndex];
  const parameters = studioV5ParameterValues(candidate, part);
  const evaluated = assertStudioStructuralMemberPart(
    part,
    feature,
    'structuralMember',
    (value) => evaluateStudioV5Expression(value, parameters),
  );
  const previous = evaluated.recipe;
  const name = String(owns(patch, 'name') ? patch.name : feature.name).trim();
  if (!name || name.length > 200) throw new Error('Structural-member name must contain 1 to 200 characters.');
  const pathSketchId = owns(patch, 'pathSketchId') ? patch.pathSketchId : previous.pathSketchId;
  const familyId = owns(patch, 'familyId') ? patch.familyId : previous.familyId;
  if (familyId !== previous.familyId) {
    throw new Error('Structural-member family changes require a new member so persistent topology cannot silently reattach to different profile edges.');
  }
  const presetId = owns(patch, 'presetId') ? patch.presetId : previous.presetId;
  let placement = previous.placement;
  if (owns(patch, 'placement')) {
    if (!patch.placement || typeof patch.placement !== 'object' || Array.isArray(patch.placement)) {
      throw new Error('Structural-member placement patch must be an object.');
    }
    placement = {
      anchor: owns(patch.placement, 'anchor') ? patch.placement.anchor : previous.placement.anchor,
      rotationDegrees: owns(patch.placement, 'rotationDegrees')
        ? patch.placement.rotationDegrees
        : previous.placement.rotationDegrees,
      offset: owns(patch.placement, 'offset') ? patch.placement.offset : previous.placement.offset,
    };
  }
  studioV5StructuralPath(candidate, pathSketchId);
  const profile = studioStructuralProfile(familyId, presetId, placement);
  const ids = { profilePlaneId: previous.profilePlaneId, profileSketchId: previous.profileSketchId };
  const plane = part.referenceGeometry.find((entry) => entry.id === ids.profilePlaneId);
  const profileSketch = part.sketches.find((entry) => entry.id === ids.profileSketchId);
  const body = part.bodies.find((entry) => entry.createdByFeatureId === feature.id);
  if (!plane || !profileSketch || !body) throw new Error('Structural-member owned geometry is incomplete.');
  plane.name = name + ' profile plane';
  plane.definition = {
    mode: 'curve-normal',
    curveSketchId: pathSketchId,
    parameter: 0,
    referenceNormal: clone(previous.profileFrame.normal),
    referenceXDirection: clone(previous.profileFrame.xDirection),
  };
  profileSketch.name = profile.designation + ' profile';
  profileSketch.support = {
    ownerKind: 'datum',
    ownerId: ids.profilePlaneId,
    semanticPath: { role: 'support' },
    signature: { kind: 'plane' },
  };
  profileSketch.entities = [{
    id: profileSketch.entities?.[0]?.id || 'entity-' + profileSketch.id,
    kind: 'polyline',
    points: clone(profile.points),
    closed: true,
  }];
  const replacement = buildStudioV5SweepFeature(candidate, part, {
    id: feature.id,
    name,
    bodyName: body.name,
    profileSketchId: ids.profileSketchId,
    pathSketchId,
    orientation: 'minimum-twist',
    referenceDirection: [0, 0, 1],
    twistAngle: 0,
    scaleEnd: 1,
    transition: 'right',
  }, feature.id);
  replacement.suppressed = feature.suppressed === true;
  replacement.extensions = {
    ...(feature.extensions || {}),
    structuralMember: studioStructuralMemberRecipe(
      feature.id,
      pathSketchId,
      profile,
      ids,
      previous.profileFrame,
    ),
  };
  part.features[featureIndex] = replacement;
  part.extensions = {
    ...(part.extensions || {}),
    structuralProfileLibrary: {
      schema: STUDIO_STRUCTURAL_PROFILE_LIBRARY_SCHEMA,
      version: STUDIO_STRUCTURAL_PROFILE_CATALOG_VERSION,
      source: clone(STUDIO_STRUCTURAL_PROFILE_SOURCE),
    },
  };
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function deleteStudioStructuralMember(project, featureId) {
  const source = canonicalStudioV5Project(project);
  const sourcePart = studioV5RootPart(source);
  const feature = sourcePart.features.find((entry) => entry.id === featureId);
  const parameters = studioV5ParameterValues(source, sourcePart);
  const { recipe } = assertStudioStructuralMemberPart(
    sourcePart,
    feature,
    'structuralMember',
    (value) => evaluateStudioV5Expression(value, parameters),
  );
  const body = sourcePart.bodies.find((entry) => entry.createdByFeatureId === featureId);
  if (!body) throw new Error('Structural-member result body is missing.');
  const cutListUsers = studioStructuralMemberCutListUsers(source, featureId, body.id);
  if (cutListUsers.length) {
    throw new Error(
      'Structural member is used by drawing cut-list tables '
        + cutListUsers.map((entry) => entry.id).join(', ')
        + '. Delete or repair those tables first.',
    );
  }
  const treatmentUsers = sourcePart.features.filter((entry) =>
    isStudioWeldmentTreatmentFeature(entry)
      && entry.inputRefs?.some((reference) => reference.ownerKind === 'feature' && reference.ownerId === featureId));
  const beadUsers = sourcePart.features.filter((entry) =>
    isStudioWeldBeadFeature(entry)
      && entry.inputRefs?.some((reference) => reference.ownerKind === 'feature' && reference.ownerId === featureId));
  if (treatmentUsers.length && !beadUsers.length) {
    throw new Error(
      'Structural member is used by weldment treatments '
        + treatmentUsers.map((entry) => entry.name).join(', ')
        + '. Delete those treatments first.',
    );
  }
  if (beadUsers.length) {
    throw new Error(
      'Structural member is used by weld beads '
        + beadUsers.map((entry) => entry.name).join(', ')
        + (treatmentUsers.length
          ? ' and weldment treatments ' + treatmentUsers.map((entry) => entry.name).join(', ')
          : '')
        + '. Delete those weldment dependents first.',
    );
  }
  const removed = deleteStudioV5Body(source, body.id);
  const candidate = canonicalStudioV5Project(removed);
  const part = studioV5RootPart(candidate);
  const ownedUsers = part.features.filter((entry) => entry.inputRefs?.some((reference) =>
    (reference.ownerKind === 'sketch' && reference.ownerId === recipe.profileSketchId)
      || (reference.ownerKind === 'datum' && reference.ownerId === recipe.profilePlaneId)));
  if (ownedUsers.length) {
    throw new Error('Structural-member owned profile geometry is used by ' + ownedUsers.map((entry) => entry.name).join(', ') + '. Delete those dependents first.');
  }
  part.sketches = part.sketches.filter((entry) => entry.id !== recipe.profileSketchId);
  part.referenceGeometry = part.referenceGeometry.filter((entry) => entry.id !== recipe.profilePlaneId);
  if (!part.features.some((entry) => entry.extensions?.structuralMember)) {
    const extensions = { ...(part.extensions || {}) };
    delete extensions.structuralProfileLibrary;
    part.extensions = extensions;
  }
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function assertStudioStructuralMemberDocument(project, featureId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId);
  const parameters = studioV5ParameterValues(candidate, part);
  const checked = assertStudioStructuralMemberPart(
    part,
    feature,
    'structuralMember',
    (value) => evaluateStudioV5Expression(value, parameters),
  );
  studioV5StructuralPath(candidate, checked.recipe.pathSketchId);
  return { feature: clone(feature), recipe: clone(checked.recipe), profile: clone(checked.profile), evaluatedPath: clone(checked.evaluatedPath) };
}

function studioSheetMetalReference(ownerKind, ownerId, role, topology = null) {
  return {
    ownerKind,
    ownerId,
    semanticPath: { role, ...(topology ? { topologyKind: topology.kind, name: topology.name } : {}) },
    signature: { role },
  };
}

function assertStudioSheetMetalPartState(project, part, feature, label) {
  const parameters = studioV5ParameterValues(project, part);
  return assertStudioSheetMetalPart(
    part,
    feature,
    label,
    (value) => evaluateStudioV5Expression(value, parameters),
  );
}

const SHEET_METAL_DEFAULT_NAMES = Object.freeze({
  'base-flange': 'Base flange',
  'edge-flange': 'Edge flange',
  'corner-relief': 'Corner relief',
  'flat-pattern': 'Flat pattern',
});

function studioSheetMetalBaseTarget(part, baseFeatureId, label) {
  const baseFeature = part.features.find((entry) => entry.id === baseFeatureId);
  if (!isStudioSheetMetalFeature(baseFeature) || baseFeature.extensions.sheetMetal.kind !== 'base-flange') {
    throw new Error(label + ' requires an existing base flange feature.');
  }
  const body = part.bodies.find((entry) => entry.createdByFeatureId === baseFeature.id);
  if (!body) throw new Error(label + ' base-flange body is missing.');
  return { baseFeature, body };
}

// With a stored bend table the table is the only K-factor source: explicit
// literals are refused and every resolution is an exact fail-closed row
// lookup on the (thickness, bendRadius) pair.
function studioSheetMetalResolvedFactor(table, input, thickness, bendRadius, fallback, label) {
  if (table) {
    if (input && owns(input, 'kFactor')) {
      throw new Error(label + ' K-factor is resolved from the stored bend table; edit the table instead of passing a literal.');
    }
    return studioSheetMetalBendTableLookup(table, thickness, bendRadius, label);
  }
  if (input && owns(input, 'kFactor')) return input.kFactor;
  if (fallback !== undefined) return fallback;
  throw new Error(label + ' requires a literal K-factor or a stored part bend table.');
}

export function createStudioSheetMetalFeature(project, input) {
  const id = assertStudioSheetMetalId(input?.id);
  const defaultName = SHEET_METAL_DEFAULT_NAMES[input?.kind] || 'Base flange';
  const name = String(input?.name || defaultName).trim();
  if (!name || name.length > 200) throw new Error('Sheet-metal feature name must contain 1 to 200 characters.');
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const bendTable = studioSheetMetalBendTable(part);
  const allIds = new Set([
    ...part.referenceGeometry.map((entry) => entry.id),
    ...part.sketches.map((entry) => entry.id),
    ...part.features.map((entry) => entry.id),
    ...part.bodies.map((entry) => entry.id),
  ]);
  if (allIds.has(id)) throw new Error('Sheet-metal feature ID "' + id + '" is already in use.');
  let feature;
  let insertIndex = null;
  if (input?.kind === 'base-flange') {
    const kFactor = studioSheetMetalResolvedFactor(
      bendTable, input, input?.thickness, input?.bendRadius, undefined, 'Base flange',
    );
    const recipe = studioSheetMetalBaseRecipe(id, input?.profileSketchId, { ...input, kFactor });
    feature = {
      id,
      name,
      type: STUDIO_SHEET_METAL_FEATURE_TYPE,
      suppressed: false,
      inputRefs: [studioSheetMetalReference('sketch', recipe.profileSketchId, 'profile')],
      resultPolicy: { kind: 'new-body', bodyName: String(input?.bodyName || name).trim() || name },
      extensions: { sheetMetal: recipe },
    };
  } else if (input?.kind === 'edge-flange') {
    const { baseFeature, body } = studioSheetMetalBaseTarget(part, input?.baseFeatureId, 'Edge flange');
    const baseRecipe = baseFeature.extensions.sheetMetal;
    const bendRadius = owns(input, 'bendRadius') ? input.bendRadius : baseRecipe.bendRadius;
    const kFactor = studioSheetMetalResolvedFactor(
      bendTable, input, baseRecipe.thickness, bendRadius, baseRecipe.kFactor, 'Edge flange',
    );
    const recipe = studioSheetMetalEdgeRecipe(id, {
      baseFeatureId: baseFeature.id,
      baseBodyId: body.id,
      baseThickness: baseRecipe.thickness,
    }, {
      segmentIndex: input?.segmentIndex,
      side: input?.side,
      bendRadius,
      kFactor,
      flangeLength: input?.flangeLength,
    });
    feature = {
      id,
      name,
      type: STUDIO_SHEET_METAL_FEATURE_TYPE,
      suppressed: false,
      inputRefs: [
        studioSheetMetalReference('feature', recipe.baseFeatureId, 'base-flange'),
        studioSheetMetalReference('body', recipe.baseBodyId, 'bend-edge', { kind: 'edge', name: recipe.edgeName }),
        studioSheetMetalReference('body', recipe.baseBodyId, 'sheet-face', { kind: 'face', name: recipe.sheetFaceName }),
        studioSheetMetalReference('body', recipe.baseBodyId, 'attachment-face', { kind: 'face', name: recipe.attachmentFaceName }),
      ],
      resultPolicy: { kind: 'add', targetBodyIds: [recipe.baseBodyId] },
      extensions: { sheetMetal: recipe },
    };
  } else if (input?.kind === 'corner-relief') {
    const { baseFeature, body } = studioSheetMetalBaseTarget(part, input?.baseFeatureId, 'Corner relief');
    const baseRecipe = baseFeature.extensions.sheetMetal;
    const recipe = studioSheetMetalCornerRecipe(id, {
      baseFeatureId: baseFeature.id,
      baseBodyId: body.id,
      baseThickness: baseRecipe.thickness,
      baseBendRadius: baseRecipe.bendRadius,
    }, input);
    feature = {
      id,
      name,
      type: STUDIO_SHEET_METAL_FEATURE_TYPE,
      suppressed: false,
      inputRefs: [
        studioSheetMetalReference('feature', recipe.baseFeatureId, 'base-flange'),
        studioSheetMetalReference('body', recipe.baseBodyId, 'relief-target'),
      ],
      resultPolicy: { kind: 'subtract', targetBodyIds: [recipe.baseBodyId] },
      extensions: { sheetMetal: recipe },
    };
    // The relief cut must replay before every edge flange of its base so the
    // flange sweeps resolve the shortened current edges: insert it directly
    // after the base flange and any reliefs the base already carries.
    insertIndex = part.features.indexOf(baseFeature) + 1;
    for (let index = insertIndex; index < part.features.length; index++) {
      const entry = part.features[index];
      if (isStudioSheetMetalFeature(entry)
        && entry.extensions.sheetMetal.kind === 'corner-relief'
        && entry.extensions.sheetMetal.baseFeatureId === baseFeature.id) {
        insertIndex = index + 1;
      }
    }
  } else if (input?.kind === 'flat-pattern') {
    const { baseFeature, body } = studioSheetMetalBaseTarget(part, input?.baseFeatureId, 'Flat pattern');
    const recipe = studioSheetMetalFlatRecipe(id, { baseFeatureId: baseFeature.id, baseBodyId: body.id });
    feature = {
      id,
      name,
      type: STUDIO_SHEET_METAL_FEATURE_TYPE,
      suppressed: false,
      inputRefs: [
        studioSheetMetalReference('feature', recipe.baseFeatureId, 'base-flange'),
        studioSheetMetalReference('body', recipe.baseBodyId, 'flat-source'),
      ],
      resultPolicy: { kind: 'new-body', bodyName: String(input?.bodyName || name).trim() || name },
      extensions: { sheetMetal: recipe },
    };
  } else {
    throw new Error('Sheet-metal kind must be base-flange, edge-flange, corner-relief, or flat-pattern.');
  }
  if (insertIndex === null) part.features.push(feature);
  else part.features.splice(insertIndex, 0, feature);
  reconcileStudioV5Bodies(part);
  assertStudioSheetMetalPartState(candidate, part, feature, 'sheetMetal[' + id + ']');
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function updateStudioSheetMetalFeature(project, featureId, patch = {}) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId && isStudioSheetMetalFeature(entry));
  if (!feature) throw new Error('That sheet-metal feature no longer exists.');
  const bendTable = studioSheetMetalBendTable(part);
  const previous = assertStudioSheetMetalPartState(candidate, part, feature, 'sheetMetal[' + featureId + ']').recipe;
  const name = String(owns(patch, 'name') ? patch.name : feature.name).trim();
  if (!name || name.length > 200) throw new Error('Sheet-metal feature name must contain 1 to 200 characters.');
  feature.name = name;
  if (previous.kind === 'base-flange') {
    const patched = studioSheetMetalBasePatch(previous, patch);
    patched.kFactor = studioSheetMetalResolvedFactor(
      bendTable, owns(patch, 'kFactor') ? patch : null, patched.thickness, patched.bendRadius, patched.kFactor, 'Base flange',
    );
    const nextRecipe = studioSheetMetalBaseRecipe(feature.id, previous.profileSketchId, patched);
    feature.extensions = { ...(feature.extensions || {}), sheetMetal: nextRecipe };
    // Bend allowances and relief sizes derive from the current base
    // thickness, K-factor source, and default bend radius, so every dependent
    // stored exact value recomputes associatively.
    for (const dependent of part.features) {
      if (!isStudioSheetMetalFeature(dependent)) continue;
      const dependentRecipe = dependent.extensions.sheetMetal;
      if (dependentRecipe.baseFeatureId !== feature.id) continue;
      if (dependentRecipe.kind === 'edge-flange') {
        dependent.extensions = {
          ...dependent.extensions,
          sheetMetal: studioSheetMetalEdgeRecipe(dependent.id, {
            baseFeatureId: feature.id,
            baseBodyId: dependentRecipe.baseBodyId,
            baseThickness: nextRecipe.thickness,
          }, {
            segmentIndex: dependentRecipe.segmentIndex,
            side: dependentRecipe.side,
            bendRadius: dependentRecipe.bendRadius,
            kFactor: bendTable
              ? studioSheetMetalBendTableLookup(bendTable, nextRecipe.thickness, dependentRecipe.bendRadius, 'Edge flange "' + dependent.id + '"')
              : dependentRecipe.kFactor,
            flangeLength: dependentRecipe.flangeLength,
          }),
        };
      } else if (dependentRecipe.kind === 'corner-relief') {
        dependent.extensions = {
          ...dependent.extensions,
          sheetMetal: studioSheetMetalCornerRecipe(dependent.id, {
            baseFeatureId: feature.id,
            baseBodyId: dependentRecipe.baseBodyId,
            baseThickness: nextRecipe.thickness,
            baseBendRadius: nextRecipe.bendRadius,
          }, {
            cornerIndex: dependentRecipe.cornerIndex,
            style: dependentRecipe.style,
          }),
        };
      }
    }
  } else if (previous.kind === 'edge-flange') {
    const baseFeature = part.features.find((entry) => entry.id === previous.baseFeatureId);
    if (!isStudioSheetMetalFeature(baseFeature)) throw new Error('Edge flange base flange no longer exists.');
    const baseThickness = baseFeature.extensions.sheetMetal.thickness;
    const patched = studioSheetMetalEdgePatch(previous, patch);
    patched.kFactor = studioSheetMetalResolvedFactor(
      bendTable, owns(patch, 'kFactor') ? patch : null, baseThickness, patched.bendRadius, patched.kFactor, 'Edge flange',
    );
    feature.extensions = {
      ...(feature.extensions || {}),
      sheetMetal: studioSheetMetalEdgeRecipe(feature.id, {
        baseFeatureId: previous.baseFeatureId,
        baseBodyId: previous.baseBodyId,
        baseThickness,
      }, patched),
    };
  } else {
    studioSheetMetalDerivedPatch(previous.kind, patch);
  }
  reconcileStudioV5Bodies(part);
  assertStudioSheetMetalPartState(candidate, part, feature, 'sheetMetal[' + featureId + ']');
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function deleteStudioSheetMetalFeature(project, featureId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId && isStudioSheetMetalFeature(entry));
  if (!feature) throw new Error('That sheet-metal feature no longer exists.');
  const recipe = assertStudioSheetMetalPartState(candidate, part, feature, 'sheetMetal[' + featureId + ']').recipe;
  if (recipe.kind === 'base-flange') {
    const dependents = part.features.filter((entry) => entry.id !== feature.id && entry.inputRefs?.some((reference) =>
      reference.ownerKind === 'feature' && reference.ownerId === feature.id));
    if (dependents.length) {
      throw new Error('Base flange is used by ' + dependents.map((entry) => entry.name).join(', ')
        + '. Delete those dependent sheet-metal features first.');
    }
  }
  if (recipe.kind === 'base-flange' || recipe.kind === 'flat-pattern') {
    const body = part.bodies.find((entry) => entry.createdByFeatureId === feature.id);
    if (!body) throw new Error('Sheet-metal feature body is missing.');
    return deleteStudioV5Body(candidate, body.id);
  }
  part.features = part.features.filter((entry) => entry.id !== feature.id);
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

// The per-part bend table is set and removed only through this typed
// lifecycle. Setting the table canonically sorts the rows and associatively
// re-resolves every flange K-factor through exact lookup, failing closed when
// any flange's (thickness, bendRadius) pair has no row. Removing the table
// freezes the currently resolved values as ordinary stored literals.
export function setStudioSheetMetalBendTable(project, input) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  if (!Array.isArray(input?.rows)) throw new Error('Bend table requires a rows array.');
  const rows = input.rows.map((row) => ({
    thickness: row?.thickness,
    bendRadius: row?.bendRadius,
    kFactor: row?.kFactor,
  })).sort((left, right) => (left.thickness - right.thickness) || (left.bendRadius - right.bendRadius));
  const table = assertStudioSheetMetalBendTable({
    schema: 'partmode.sheet-metal/v1',
    version: 1,
    kind: 'bend-table',
    rows,
  }, 'bendTable');
  part.extensions = { ...(part.extensions || {}), sheetMetalBendTable: table };
  for (const feature of part.features) {
    if (!isStudioSheetMetalFeature(feature)) continue;
    const recipe = feature.extensions.sheetMetal;
    if (recipe.kind === 'base-flange') {
      const kFactor = studioSheetMetalBendTableLookup(table, recipe.thickness, recipe.bendRadius, 'Base flange "' + feature.id + '"');
      feature.extensions = {
        ...feature.extensions,
        sheetMetal: studioSheetMetalBaseRecipe(feature.id, recipe.profileSketchId, {
          thickness: recipe.thickness,
          kFactor,
          bendRadius: recipe.bendRadius,
        }),
      };
    } else if (recipe.kind === 'edge-flange') {
      const baseFeature = part.features.find((entry) => entry.id === recipe.baseFeatureId);
      if (!isStudioSheetMetalFeature(baseFeature)) throw new Error('Edge flange base flange no longer exists.');
      const baseThickness = baseFeature.extensions.sheetMetal.thickness;
      const kFactor = studioSheetMetalBendTableLookup(table, baseThickness, recipe.bendRadius, 'Edge flange "' + feature.id + '"');
      feature.extensions = {
        ...feature.extensions,
        sheetMetal: studioSheetMetalEdgeRecipe(feature.id, {
          baseFeatureId: recipe.baseFeatureId,
          baseBodyId: recipe.baseBodyId,
          baseThickness,
        }, {
          segmentIndex: recipe.segmentIndex,
          side: recipe.side,
          bendRadius: recipe.bendRadius,
          kFactor,
          flangeLength: recipe.flangeLength,
        }),
      };
    }
  }
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function deleteStudioSheetMetalBendTable(project) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  if (!part.extensions || part.extensions.sheetMetalBendTable === undefined) {
    throw new Error('This part has no stored bend table.');
  }
  const { sheetMetalBendTable: _removed, ...rest } = part.extensions;
  part.extensions = rest;
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function assertStudioSheetMetalDocument(project, featureId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId);
  const checked = assertStudioSheetMetalPartState(candidate, part, feature, 'sheetMetal[' + featureId + ']');
  return {
    feature: clone(feature),
    recipe: clone(checked.recipe),
    ...(checked.profileArea !== undefined ? { profileArea: checked.profileArea } : {}),
    ...(checked.bendAllowance !== undefined ? { bendAllowance: checked.bendAllowance } : {}),
    ...(checked.effectiveLength !== undefined ? { effectiveLength: checked.effectiveLength } : {}),
    ...(checked.corner !== undefined ? { corner: clone(checked.corner) } : {}),
    ...(checked.plan !== undefined ? { plan: clone(checked.plan) } : {}),
  };
}

// The current flat-pattern outline as a constraint-native sketch for the
// partmode.dxf/v1 sketch writer.
export function studioSheetMetalFlatPatternSketch(project, featureId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId && isStudioSheetMetalFeature(entry));
  if (!feature || feature.extensions.sheetMetal.kind !== 'flat-pattern') {
    throw new Error('Flat-pattern DXF export requires an existing flat-pattern feature.');
  }
  const checked = assertStudioSheetMetalPartState(candidate, part, feature, 'sheetMetal[' + featureId + ']');
  return {
    sketch: studioSheetMetalFlatSketch(checked.plan),
    plan: clone(checked.plan),
    recipe: clone(checked.recipe),
  };
}

function studioWeldmentMemberIdentity(project, memberId, label) {
  const part = studioV5RootPart(project);
  const feature = part.features.find((entry) => entry.id === memberId && entry.extensions?.structuralMember);
  if (!feature) throw new Error(label + ' must reference an existing structural member.');
  const parameters = studioV5ParameterValues(project, part);
  assertStudioStructuralMemberPart(
    part,
    feature,
    label,
    (value) => evaluateStudioV5Expression(value, parameters),
  );
  const body = part.bodies.find((entry) => entry.createdByFeatureId === feature.id);
  if (!body) throw new Error(label + ' structural-member body is missing.');
  return { feature, body };
}

function studioWeldmentReference(ownerKind, ownerId, role) {
  return {
    ownerKind,
    ownerId,
    semanticPath: { role },
    signature: { role },
  };
}

function studioWeldmentTreatmentInputs(project, input) {
  const kind = input?.kind;
  if (kind === 'trim-extend') {
    const member = studioWeldmentMemberIdentity(project, input.memberId, 'Trim/extend member');
    return {
      recipeInput: { ...clone(input), memberBodyId: member.body.id },
      inputRefs: [
        studioWeldmentReference('feature', member.feature.id, 'member'),
        studioWeldmentReference('body', member.body.id, 'target-body'),
      ],
      resultPolicy: { kind: 'add', targetBodyIds: [member.body.id] },
    };
  }
  if (kind === 'corner') {
    const target = studioWeldmentMemberIdentity(project, input.targetMemberId, 'Corner target member');
    const other = studioWeldmentMemberIdentity(project, input.otherMemberId, 'Corner other member');
    return {
      recipeInput: {
        ...clone(input),
        targetBodyId: target.body.id,
        otherBodyId: other.body.id,
      },
      inputRefs: [
        studioWeldmentReference('feature', target.feature.id, 'target-member'),
        studioWeldmentReference('body', target.body.id, 'target-body'),
        studioWeldmentReference('feature', other.feature.id, 'other-member'),
        studioWeldmentReference('body', other.body.id, 'other-body'),
      ],
      resultPolicy: { kind: 'add', targetBodyIds: [target.body.id] },
    };
  }
  if (kind === 'gusset') {
    const left = studioWeldmentMemberIdentity(project, input.leftMemberId, 'Gusset left member');
    const right = studioWeldmentMemberIdentity(project, input.rightMemberId, 'Gusset right member');
    return {
      recipeInput: clone(input),
      inputRefs: [
        studioWeldmentReference('feature', left.feature.id, 'left-member'),
        studioWeldmentReference('feature', right.feature.id, 'right-member'),
      ],
      resultPolicy: { kind: 'new-body', bodyName: String(input.bodyName || input.name || 'Gusset').trim() || 'Gusset' },
    };
  }
  if (kind === 'end-cap') {
    const member = studioWeldmentMemberIdentity(project, input.memberId, 'End-cap member');
    return {
      recipeInput: clone(input),
      inputRefs: [studioWeldmentReference('feature', member.feature.id, 'member')],
      resultPolicy: { kind: 'new-body', bodyName: String(input.bodyName || input.name || 'End cap').trim() || 'End cap' },
    };
  }
  // The canonical recipe builder owns the public unsupported-kind error.
  studioWeldmentTreatmentRecipe(String(input?.id || ''), input);
  throw new Error('Weldment-treatment kind is unsupported.');
}

function assertUniqueStudioWeldmentTreatmentId(part, id) {
  const used = [
    ...(part.features || []),
    ...(part.bodies || []),
    ...(part.sketches || []),
    ...(part.referenceGeometry || []),
  ].some((entry) => entry.id === id || entry.id === 'body-' + id);
  if (used) throw new Error('Weldment-treatment ID or its result-body ID is already in use.');
}

export function createStudioWeldmentTreatment(project, input) {
  const id = assertStudioWeldmentTreatmentId(input?.id);
  const name = String(input?.name || 'Structural treatment').trim();
  if (!name || name.length > 200) throw new Error('Weldment-treatment name must contain 1 to 200 characters.');
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  assertUniqueStudioWeldmentTreatmentId(part, id);
  const normalized = studioWeldmentTreatmentInputs(candidate, input);
  const recipe = studioWeldmentTreatmentRecipe(id, normalized.recipeInput);
  const feature = {
    id,
    name,
    type: 'weldment-treatment',
    suppressed: false,
    inputRefs: normalized.inputRefs,
    resultPolicy: normalized.resultPolicy,
    extensions: { weldmentTreatment: recipe },
  };
  part.features.push(feature);
  reconcileStudioV5Bodies(part);
  const parameters = studioV5ParameterValues(candidate, part);
  assertStudioWeldmentTreatmentPart(
    part,
    feature,
    'weldmentTreatment[' + id + ']',
    (value) => evaluateStudioV5Expression(value, parameters),
  );
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function updateStudioWeldmentTreatment(project, featureId, patch = {}) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId && isStudioWeldmentTreatmentFeature(entry));
  if (!feature) throw new Error('That weldment treatment no longer exists.');
  const previous = assertStudioWeldmentTreatmentFeature(feature, 'weldmentTreatment[' + featureId + ']');
  const recipe = studioWeldmentTreatmentPatch(previous, patch);
  const name = String(owns(patch, 'name') ? patch.name : feature.name).trim();
  if (!name || name.length > 200) throw new Error('Weldment-treatment name must contain 1 to 200 characters.');
  feature.name = name;
  feature.extensions = { ...(feature.extensions || {}), weldmentTreatment: recipe };
  reconcileStudioV5Bodies(part);
  const parameters = studioV5ParameterValues(candidate, part);
  assertStudioWeldmentTreatmentPart(
    part,
    feature,
    'weldmentTreatment[' + featureId + ']',
    (value) => evaluateStudioV5Expression(value, parameters),
  );
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function deleteStudioWeldmentTreatment(project, featureId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId && isStudioWeldmentTreatmentFeature(entry));
  if (!feature) throw new Error('That weldment treatment no longer exists.');
  assertStudioWeldmentTreatmentFeature(feature, 'weldmentTreatment[' + featureId + ']');
  const dependents = part.features.filter((entry) => entry.id !== feature.id && entry.inputRefs?.some((reference) =>
    reference.ownerKind === 'feature' && reference.ownerId === feature.id));
  if (dependents.length) {
    throw new Error('Weldment treatment is used by ' + dependents.map((entry) => entry.name).join(', ') + '. Delete those dependents first.');
  }
  const body = part.bodies.find((entry) => entry.createdByFeatureId === feature.id);
  if (body) return deleteStudioV5Body(candidate, body.id);
  part.features = part.features.filter((entry) => entry.id !== feature.id);
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function assertStudioWeldmentTreatmentDocument(project, featureId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId);
  const parameters = studioV5ParameterValues(candidate, part);
  const checked = assertStudioWeldmentTreatmentPart(
    part,
    feature,
    'weldmentTreatment[' + featureId + ']',
    (value) => evaluateStudioV5Expression(value, parameters),
  );
  return { feature: clone(feature), recipe: clone(checked.recipe) };
}

function studioWeldBeadReference(ownerKind, ownerId, role) {
  return {
    ownerKind,
    ownerId,
    semanticPath: { role },
    signature: { role },
  };
}

function studioWeldBeadTopologyReference(bodyId, role, topologyKind, reference) {
  return {
    ownerKind: 'body',
    ownerId: bodyId,
    semanticPath: { role, topologyKind, name: reference.name },
    signature: clone(reference.sig),
  };
}

function studioWeldBeadInputs(project, input) {
  if (!Array.isArray(input?.supports) || input.supports.length !== 2) {
    throw new Error('Weld bead requires exactly support-a and support-b.');
  }
  const roles = ['support-a', 'support-b'];
  const supports = roles.map((role, index) => {
    const source = input.supports[index];
    if (source?.role !== role) throw new Error('Weld-bead supports must use canonical support-a then support-b order.');
    const member = studioWeldmentMemberIdentity(project, source.memberId, 'Weld bead ' + role);
    return {
      role,
      memberId: member.feature.id,
      bodyId: member.body.id,
      face: clone(source.face),
      edge: clone(source.edge),
    };
  });
  const inputRefs = supports.flatMap((support) => [
    studioWeldBeadReference('feature', support.memberId, support.role + '-member'),
    studioWeldBeadReference('body', support.bodyId, support.role + '-body'),
    studioWeldBeadTopologyReference(support.bodyId, support.role + '-face', 'face', support.face),
    studioWeldBeadTopologyReference(support.bodyId, support.role + '-edge', 'edge', support.edge),
  ]);
  return { supports, inputRefs };
}

function assertUniqueStudioWeldBeadId(part, id) {
  const bodyId = 'body-' + id;
  const used = [
    ...(part.features || []),
    ...(part.bodies || []),
    ...(part.sketches || []),
    ...(part.referenceGeometry || []),
  ].some((entry) => entry.id === id || entry.id === bodyId);
  if (used) throw new Error('Weld-bead ID or its result-body ID is already in use.');
}

export function createStudioWeldBead(project, input) {
  const id = assertStudioWeldBeadId(input?.id);
  const name = String(input?.name || 'Fillet weld bead').trim();
  if (!name || name.length > 200) throw new Error('Weld-bead name must contain 1 to 200 characters.');
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  assertUniqueStudioWeldBeadId(part, id);
  const normalized = studioWeldBeadInputs(candidate, input);
  const recipe = studioWeldBeadRecipe(id, {
    kind: input?.kind,
    sizeMm: input?.sizeMm,
    process: input?.process,
    supports: normalized.supports,
  });
  const feature = {
    id,
    name,
    type: 'weld-bead',
    suppressed: false,
    inputRefs: normalized.inputRefs,
    resultPolicy: {
      kind: 'new-body',
      bodyName: String(input?.bodyName || name + ' body').trim() || name + ' body',
    },
    createdBodyId: 'body-' + id,
    extensions: { weldBead: recipe },
  };
  if (feature.resultPolicy.bodyName.length > 200) {
    throw new Error('Weld-bead body name must contain 1 to 200 characters.');
  }
  part.features.push(feature);
  reconcileStudioV5Bodies(part);
  const parameters = studioV5ParameterValues(candidate, part);
  assertStudioWeldBeadPart(
    part,
    feature,
    'weldBead[' + id + ']',
    (value) => evaluateStudioV5Expression(value, parameters),
  );
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function updateStudioWeldBead(project, featureId, patch = {}) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId && isStudioWeldBeadFeature(entry));
  if (!feature) throw new Error('That weld bead no longer exists.');
  const previous = assertStudioWeldBeadFeature(feature, 'weldBead[' + featureId + ']');
  const recipe = studioWeldBeadPatch(previous, patch);
  const name = String(owns(patch, 'name') ? patch.name : feature.name).trim();
  if (!name || name.length > 200) throw new Error('Weld-bead name must contain 1 to 200 characters.');
  feature.name = name;
  feature.extensions = { ...(feature.extensions || {}), weldBead: recipe };
  reconcileStudioV5Bodies(part);
  const parameters = studioV5ParameterValues(candidate, part);
  assertStudioWeldBeadPart(
    part,
    feature,
    'weldBead[' + featureId + ']',
    (value) => evaluateStudioV5Expression(value, parameters),
  );
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

function studioWeldBeadDrawingTableUsers(project, featureId) {
  return (project.extensions?.drawingTables?.tables || []).filter((table) =>
    table.kind === 'weld' && table.sourceFeatureIds?.includes(featureId));
}

export function deleteStudioWeldBead(project, featureId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId && isStudioWeldBeadFeature(entry));
  if (!feature) throw new Error('That weld bead no longer exists.');
  assertStudioWeldBeadFeature(feature, 'weldBead[' + featureId + ']');
  const tableUsers = studioWeldBeadDrawingTableUsers(candidate, feature.id);
  if (tableUsers.length) {
    throw new Error(
      'Weld bead is used by drawing weld tables '
        + tableUsers.map((entry) => entry.name).join(', ')
        + '. Delete or repair those tables first.',
    );
  }
  const createdBodyId = feature.createdBodyId;
  const featureUsers = part.features.filter((entry) => entry.id !== feature.id && entry.inputRefs?.some((reference) =>
    (reference.ownerKind === 'feature' && reference.ownerId === feature.id)
      || (reference.ownerKind === 'body' && reference.ownerId === createdBodyId)));
  const bodyUsers = part.features.filter((entry) => entry.id !== feature.id && (
    entry.resultPolicy?.targetBodyIds?.includes(createdBodyId)
      || entry.toolBodyIds?.includes(createdBodyId)
  ));
  const patternUsers = (part.bodyPatterns || []).filter((entry) => entry.sourceBodyId === createdBodyId);
  if (featureUsers.length || bodyUsers.length || patternUsers.length) {
    throw new Error(
      'Weld bead is used by '
        + [...featureUsers, ...bodyUsers, ...patternUsers].map((entry) => entry.name).join(', ')
        + '. Delete those dependents first.',
    );
  }
  part.features = part.features.filter((entry) => entry.id !== feature.id);
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function assertStudioWeldBeadDocument(project, featureId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId);
  const parameters = studioV5ParameterValues(candidate, part);
  const checked = assertStudioWeldBeadPart(
    part,
    feature,
    'weldBead[' + featureId + ']',
    (value) => evaluateStudioV5Expression(value, parameters),
  );
  return {
    feature: clone(feature),
    recipe: clone(checked.recipe),
    supports: clone(checked.supports),
    createdBody: clone(checked.createdBody),
  };
}

export function updateStudioV5AdvancedFeature(project, featureId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId && (
    entry.type === 'loft' || entry.type === 'sweep' || entry.type === 'revolve' || entry.type === 'draft' ||
    entry.type === 'thicken' || (entry.type === 'fillet' && (
      Array.isArray(entry.variableRadii) || entry.extensions?.advancedFillet?.mode === 'adjacent-face-pair'
    ))
  ));
  if (!feature) throw new Error('That advanced shape feature no longer exists.');
  if (feature.extensions?.structuralMember) {
    throw new Error('Structural members must be edited through the typed structural-member command.');
  }
  const body = part.bodies.find((entry) => entry.createdByFeatureId === feature.id);
  const featureIndex = part.features.indexOf(feature);
  const targetBodyId = feature.resultPolicy.kind === 'new-body' ? null : feature.resultPolicy.targetBodyIds[0];
  const shared = {
    id: feature.id,
    name: authoredOr(patch, 'name', feature.name),
    bodyName: body?.name || feature.resultPolicy.bodyName,
    ...(targetBodyId ? { targetBodyId, operation: feature.resultPolicy.kind } : {}),
  };
  if (feature.type === 'loft') {
    part.features[featureIndex] = buildStudioV5LoftFeature(candidate, part, {
      ...shared,
      sections: authoredOr(patch, 'sections', feature.sections),
      guideSketchIds: authoredOr(patch, 'guideSketchIds', feature.guideSketchIds),
      centerlineSketchId: authoredOr(patch, 'centerlineSketchId', feature.centerlineSketchId),
      continuity: authoredOr(patch, 'continuity', feature.continuity),
      ruled: authoredOr(patch, 'ruled', feature.ruled),
      closed: authoredOr(patch, 'closed', feature.closed),
      mapping: authoredOr(patch, 'mapping', feature.mapping),
    }, feature.id);
  } else if (feature.type === 'sweep') {
    part.features[featureIndex] = buildStudioV5SweepFeature(candidate, part, {
      ...shared,
      profileSketchId: authoredOr(patch, 'profileSketchId', feature.profileSketchId),
      pathSketchId: authoredOr(patch, 'pathSketchId', feature.pathSketchId),
      guideSketchId: authoredOr(patch, 'guideSketchId', feature.guideSketchId),
      orientation: authoredOr(patch, 'orientation', feature.orientation),
      referenceDirection: authoredOr(patch, 'referenceDirection', feature.referenceDirection),
      twistAngle: authoredOr(patch, 'twistAngle', feature.twistAngle),
      scaleEnd: authoredOr(patch, 'scaleEnd', feature.scaleEnd),
      transition: authoredOr(patch, 'transition', feature.transition),
    }, feature.id);
  } else if (feature.type === 'revolve') {
    part.features[featureIndex] = buildStudioV5RevolveFeature(candidate, part, {
      ...shared,
      profileSketchId: authoredOr(patch, 'profileSketchId', feature.profileSketchId),
      axisDatumId: authoredOr(patch, 'axisDatumId', feature.axisDatumId),
      angle: authoredOr(patch, 'angle', feature.angle),
      startAngle: authoredOr(patch, 'startAngle', feature.startAngle),
      symmetric: authoredOr(patch, 'symmetric', feature.symmetric),
    }, feature.id);
  } else if (feature.type === 'draft') {
    part.features[featureIndex] = buildStudioV5DraftFeature(candidate, part, {
      id: feature.id,
      name: authoredOr(patch, 'name', feature.name),
      bodyId: authoredOr(patch, 'bodyId', targetBodyId),
      faces: authoredOr(patch, 'faces', feature.faces),
      neutralPlaneDatumId: authoredOr(patch, 'neutralPlaneDatumId', feature.neutralPlaneDatumId),
      angle: authoredOr(patch, 'angle', feature.angle),
      flip: authoredOr(patch, 'flip', feature.flip),
      tangentPropagation: authoredOr(patch, 'tangentPropagation', feature.tangentPropagation),
    }, feature.id);
  } else if (feature.type === 'thicken') {
    part.features[featureIndex] = buildStudioV5ThickenFeature(candidate, part, {
      id: feature.id,
      name: authoredOr(patch, 'name', feature.name),
      bodyId: authoredOr(patch, 'bodyId', feature.sourceBodyId),
      bodyName: body?.name || feature.resultPolicy.bodyName,
      faces: authoredOr(patch, 'faces', feature.faces),
      thickness: authoredOr(patch, 'thickness', feature.thickness),
      symmetric: authoredOr(patch, 'symmetric', feature.symmetric),
      flip: authoredOr(patch, 'flip', feature.flip),
    }, feature.id);
  } else if (feature.type === 'fillet' && feature.extensions?.advancedFillet?.mode === 'adjacent-face-pair') {
    part.features[featureIndex] = buildStudioV5FaceFilletFeature(candidate, part, {
      id: feature.id,
      name: authoredOr(patch, 'name', feature.name),
      bodyId: authoredOr(patch, 'bodyId', targetBodyId),
      faces: authoredOr(patch, 'faces', feature.faces),
      radius: authoredOr(patch, 'radius', feature.r),
    }, feature.id);
  } else {
    part.features[featureIndex] = buildStudioV5VariableFilletFeature(candidate, part, {
      id: feature.id,
      name: authoredOr(patch, 'name', feature.name),
      bodyId: authoredOr(patch, 'bodyId', targetBodyId),
      edges: authoredOr(patch, 'edges', feature.edges),
      radii: authoredOr(patch, 'radii', undefined),
      startRadius: authoredOr(patch, 'startRadius', feature.variableRadii[0]?.startRadius),
      endRadius: authoredOr(patch, 'endRadius', feature.variableRadii[0]?.endRadius),
      tangentPropagation: authoredOr(patch, 'tangentPropagation', feature.tangentPropagation),
    }, feature.id);
  }
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

const bodyInputReference = (bodyId, role = 'source') => ({
  ownerKind: 'body', ownerId: bodyId, semanticPath: { role }, signature: { role },
});
const datumInputReference = (datumId, role) => ({
  ownerKind: 'datum', ownerId: datumId, semanticPath: { role }, signature: { role },
});

function buildStudioV5RevolveFeature(candidate, part, options, updatingId = null) {
  if (options.id !== updatingId) requireUniquePartId(part, options.id, 'Revolve feature');
  requireAdvancedSketch(part, options.profileSketchId, 'profile');
  const axis = resolveStudioV5Datums(candidate, part.id).resolve(options.axisDatumId);
  if (axis.kind !== 'axis') throw new Error('Revolve requires an axis datum.');
  const parameters = studioV5ParameterValues(candidate, part);
  const angleSource = authoredOr(options, 'angle', 360);
  const angle = evaluateStudioV5Expression(angleSource, parameters);
  const symmetric = optionalAuthoredBoolean(options, 'symmetric', false);
  const startAngleSource = authoredOr(options, 'startAngle', symmetric ? -angle / 2 : 0);
  const startAngle = evaluateStudioV5Expression(startAngleSource, parameters);
  if (!(angle > 0 && angle <= 360) || !Number.isFinite(startAngle)) throw new Error('Revolve angle must evaluate above zero and at most 360 degrees.');
  if (symmetric && Math.abs(startAngle + angle / 2) > Math.max(1, Math.abs(angle)) * 1e-9) {
    throw new Error('Symmetric Revolve requires startAngle to equal -angle/2.');
  }
  const feature = {
    id: options.id,
    name: String(options.name || 'Revolve').trim(),
    type: 'revolve',
    profileSketchId: options.profileSketchId,
    axisDatumId: options.axisDatumId,
    angle: angleSource,
    startAngle: startAngleSource,
    symmetric,
    suppressed: false,
    inputRefs: [sketchReference(options.profileSketchId, 'profile'), datumInputReference(options.axisDatumId, 'axis')],
    resultPolicy: advancedFeaturePolicy(part, options),
  };
  if (!feature.name) throw new Error('Revolve name is required.');
  return feature;
}

export function createStudioV5RevolveFeature(project, options) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = buildStudioV5RevolveFeature(candidate, part, options);
  part.features.push(feature);
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

function buildStudioV5DraftFeature(candidate, part, options, updatingId = null) {
  if (options.id !== updatingId) requireUniquePartId(part, options.id, 'Draft feature');
  const target = part.bodies.find((body) => body.id === options.bodyId);
  if (!target) throw new Error('Choose a body to draft.');
  const plane = resolveStudioV5Datums(candidate, part.id).resolve(options.neutralPlaneDatumId);
  if (plane.kind !== 'plane') throw new Error('Draft requires a neutral plane datum.');
  const parameters = studioV5ParameterValues(candidate, part);
  const angle = evaluateStudioV5Expression(options.angle, parameters);
  if (!(Math.abs(angle) > 1e-6 && Math.abs(angle) < 89)) throw new Error('Draft angle must be non-zero and below 89 degrees.');
  if (!Array.isArray(options.faces) || !options.faces.length) throw new Error('Draft requires at least one selected face.');
  const flip = optionalAuthoredBoolean(options, 'flip', false);
  const tangentPropagation = optionalAuthoredBoolean(options, 'tangentPropagation', false);
  if (tangentPropagation) throw new Error('Draft tangent propagation is unavailable until exact tangent-chain expansion is implemented.');
  const feature = {
    id: options.id,
    name: String(options.name || 'Draft ' + target.name).trim(),
    type: 'draft',
    faces: clone(options.faces),
    neutralPlaneDatumId: options.neutralPlaneDatumId,
    angle: options.angle,
    flip,
    tangentPropagation,
    suppressed: false,
    inputRefs: [bodyInputReference(target.id, 'target'), datumInputReference(options.neutralPlaneDatumId, 'neutral-plane')],
    resultPolicy: { kind: 'add', targetBodyIds: [target.id] },
  };
  if (!feature.name) throw new Error('Draft name is required.');
  return feature;
}

export function createStudioV5DraftFeature(project, options) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  part.features.push(buildStudioV5DraftFeature(candidate, part, options));
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

function buildStudioV5ThickenFeature(candidate, part, options, updatingId = null) {
  if (options.id !== updatingId) requireUniquePartId(part, options.id, 'Thicken feature');
  const source = part.bodies.find((body) => body.id === options.bodyId);
  if (!source) throw new Error('Choose a body face to thicken.');
  const parameters = studioV5ParameterValues(candidate, part);
  if (!(evaluateStudioV5Expression(options.thickness, parameters) > 0)) throw new Error('Thicken distance must evaluate above zero.');
  if (!Array.isArray(options.faces) || options.faces.length !== 1) throw new Error('This Thicken increment requires exactly one selected planar face.');
  const symmetric = optionalAuthoredBoolean(options, 'symmetric', false);
  const flip = optionalAuthoredBoolean(options, 'flip', false);
  const feature = {
    id: options.id,
    name: String(options.name || 'Thicken ' + source.name).trim(),
    type: 'thicken',
    sourceBodyId: source.id,
    toolBodyIds: [source.id],
    linked: true,
    faces: clone(options.faces),
    thickness: options.thickness,
    symmetric,
    flip,
    suppressed: false,
    inputRefs: [bodyInputReference(source.id)],
    resultPolicy: { kind: 'new-body', bodyName: options.bodyName || source.name + ' thickened face' },
  };
  if (!feature.name) throw new Error('Thicken name is required.');
  return feature;
}

export function createStudioV5ThickenFeature(project, options) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  part.features.push(buildStudioV5ThickenFeature(candidate, part, options));
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

function buildStudioV5VariableFilletFeature(candidate, part, options, updatingId = null) {
  if (options.id !== updatingId) requireUniquePartId(part, options.id, 'Variable Fillet feature');
  const target = part.bodies.find((body) => body.id === options.bodyId);
  if (!target) throw new Error('Choose a body to fillet.');
  const parameters = studioV5ParameterValues(candidate, part);
  if (!Array.isArray(options.edges) || !options.edges.length) throw new Error('Variable Fillet requires one or more selected edges.');
  const radii = owns(options, 'radii') ? options.radii : undefined;
  if (radii !== undefined && (!Array.isArray(radii) || radii.length !== options.edges.length)) {
    throw new Error('Variable Fillet radii must contain exactly one entry per selected edge.');
  }
  const variableRadii = options.edges.map((edge, index) => {
    const entry = radii?.[index];
    if (entry !== undefined && (!entry || typeof entry !== 'object' || Array.isArray(entry))) throw new Error('Variable Fillet radius entries must be objects.');
    const startRadius = entry && owns(entry, 'startRadius') ? entry.startRadius : authoredOr(options, 'startRadius', undefined);
    const endRadius = entry && owns(entry, 'endRadius') ? entry.endRadius : authoredOr(options, 'endRadius', undefined);
    if (!(evaluateStudioV5Expression(startRadius, parameters) > 0) || !(evaluateStudioV5Expression(endRadius, parameters) > 0)) {
      throw new Error('Variable Fillet radii must evaluate above zero.');
    }
    return { edge: clone(edge), startRadius, endRadius };
  });
  const tangentPropagation = optionalAuthoredBoolean(options, 'tangentPropagation', false);
  if (tangentPropagation) throw new Error('Fillet tangent propagation is unavailable until exact tangent-chain expansion is implemented.');
  const feature = {
    id: options.id,
    name: String(options.name || 'Variable Fillet ' + target.name).trim(),
    type: 'fillet',
    r: variableRadii[0].startRadius,
    edges: options.edges.map(clone),
    variableRadii,
    tangentPropagation,
    suppressed: false,
    inputRefs: [bodyInputReference(target.id, 'target')],
    resultPolicy: { kind: 'add', targetBodyIds: [target.id] },
  };
  if (!feature.name) throw new Error('Variable Fillet name is required.');
  return feature;
}

function buildStudioV5FaceFilletFeature(candidate, part, options, updatingId = null) {
  if (options.id !== updatingId) requireUniquePartId(part, options.id, 'Face Fillet feature');
  const target = part.bodies.find((body) => body.id === options.bodyId);
  if (!target) throw new Error('Choose a body to face fillet.');
  if (!Array.isArray(options.faces) || options.faces.length !== 2) {
    throw new Error('Face Fillet requires exactly two selected faces.');
  }
  const faces = options.faces.map(clone);
  if (JSON.stringify(faces[0]) === JSON.stringify(faces[1])) {
    throw new Error('Face Fillet requires two distinct face references.');
  }
  const parameters = studioV5ParameterValues(candidate, part);
  if (!(evaluateStudioV5Expression(options.radius, parameters) > 0)) {
    throw new Error('Face Fillet radius must evaluate above zero.');
  }
  const feature = {
    id: options.id,
    name: String(options.name || 'Face Fillet ' + target.name).trim(),
    type: 'fillet',
    r: options.radius,
    edges: [],
    faces,
    tangentPropagation: false,
    suppressed: false,
    inputRefs: [bodyInputReference(target.id, 'target')],
    resultPolicy: { kind: 'add', targetBodyIds: [target.id] },
    extensions: { advancedFillet: studioFaceFilletExtension() },
  };
  if (!feature.name) throw new Error('Face Fillet name is required.');
  return feature;
}

export function createStudioV5FaceFilletFeature(project, options) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  part.features.push(buildStudioV5FaceFilletFeature(candidate, part, options));
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function createStudioV5VariableFilletFeature(project, options) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  part.features.push(buildStudioV5VariableFilletFeature(candidate, part, options));
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export const studioV5PatternInstanceId = (patternId, index) => patternId + '-instance-' + index;

function patternReference(ownerKind, ownerId, role) {
  return { ownerKind, ownerId, semanticPath: { role }, signature: { role } };
}

function variablePatternConsumedParameterNames(project, part, source, parameters) {
  const parameterNames = new Set(parameters.keys());
  const partParameterNames = new Set((part.parameters || []).map((parameter) => parameter.name));
  const dependencyMap = new Map((part.parameters || []).map((parameter) => [
    parameter.name,
    parseStudioExpression(parameter.value, {
      path: 'Part parameter "' + parameter.name + '"',
      allowedNames: parameterNames,
    }).dependencies,
  ]));
  const requestedRollbackIndex = part.metadata?.rollbackFeatureId == null
    ? part.featureOrder.length - 1
    : part.featureOrder.indexOf(part.metadata.rollbackFeatureId);
  const enabledFeatureIds = new Set(part.featureOrder.slice(
    0,
    requestedRollbackIndex < 0 ? part.featureOrder.length : requestedRollbackIndex + 1,
  ));
  const featureById = new Map(part.features.map((feature) => [feature.id, feature]));
  const consumed = new Set();
  for (const featureId of source.featureIds) {
    if (!enabledFeatureIds.has(featureId)) continue;
    const feature = featureById.get(featureId);
    if (!feature || feature.suppressed) continue;
    for (const field of STUDIO_VARIABLE_PATTERN_DIMENSION_FIELDS) {
      const visit = (value) => {
        if (typeof value === 'string' || typeof value === 'number') {
          const parsed = parseStudioExpression(value, {
            path: 'Variable pattern source ' + feature.id + '.' + field,
            allowedNames: parameterNames,
          });
          for (const dependency of parsed.dependencies) consumed.add(dependency);
        } else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') Object.values(value).forEach(visit);
      };
      if (owns(feature, field)) visit(feature[field]);
    }
  }
  const includeDependencies = (name) => {
    for (const dependency of dependencyMap.get(name) || []) {
      if (consumed.has(dependency)) continue;
      consumed.add(dependency);
      includeDependencies(dependency);
    }
  };
  for (const name of [...consumed]) includeDependencies(name);
  return { consumed, partParameterNames };
}

function expressionNumber(value, parameters, label) {
  const evaluated = evaluateStudioV5Expression(value, parameters);
  if (!Number.isFinite(evaluated)) throw new Error(label + ' must evaluate to a finite number.');
  return evaluated;
}

function buildStudioV5BodyPattern(project, part, input, updatingId = null) {
  if (input.id !== updatingId) requireUniquePartId(part, input.id, 'Pattern');
  const source = part.bodies.find((body) => body.id === input.sourceBodyId);
  if (!source) throw new Error('Choose an existing source body.');
  const parameters = studioV5ParameterValues(project, part);
  const kind = input.kind;
  if (!['linear', 'circular', 'curve', 'mirror', 'sketch', 'fill', 'variable'].includes(kind)) throw new Error('Pattern type is unsupported.');
  let countExpression = null;
  let count = null;
  if (!['sketch', 'fill', 'variable'].includes(kind)) {
    countExpression = authoredOr(input, 'count', 2);
    count = expressionNumber(countExpression, parameters, 'Pattern count');
    if (!Number.isInteger(count) || count < 2 || count > 5000) throw new Error('Pattern count must evaluate to an integer from 2 to 5,000.');
    if (kind === 'mirror' && count !== 2) throw new Error('Mirror pattern count must evaluate to exactly 2.');
  }
  const skippedIndices = optionalAuthoredArray(input, 'skippedIndices');
  if (new Set(skippedIndices).size !== skippedIndices.length) throw new Error('Skipped pattern indices must not repeat.');
  skippedIndices.sort((a, b) => a - b);
  let occurrenceCount = count;
  const references = [];
  const defaultDistribution = kind === 'circular' ? 'full'
    : kind === 'curve' ? 'equal'
      : kind === 'mirror' ? 'mirror'
        : kind === 'sketch' ? 'points'
          : kind === 'fill' ? 'fill'
            : kind === 'variable' ? 'table'
              : 'spacing';
  const defaultOrientation = kind === 'circular' ? 'rotate'
    : kind === 'curve' ? 'tangent'
      : kind === 'mirror' ? 'mirror'
        : 'preserve';
  const definition = {
    ...(countExpression == null ? {} : { count: countExpression }),
    distribution: authoredOr(input, 'distribution', defaultDistribution),
    orientation: authoredOr(input, 'orientation', defaultOrientation),
    ...(['linear', 'circular', 'curve', 'mirror'].includes(kind)
      ? { symmetric: optionalAuthoredBoolean(input, 'symmetric', false) }
      : {}),
  };
  if (kind === 'linear') {
    const directionDatumIds = owns(input, 'directionDatumIds')
      ? optionalAuthoredArray(input, 'directionDatumIds')
      : owns(input, 'directionDatumId')
        ? [input.directionDatumId]
        : [];
    if (new Set(directionDatumIds).size !== directionDatumIds.length) throw new Error('Linear pattern direction datums must not repeat.');
    if (directionDatumIds.length < 1 || directionDatumIds.length > 2) throw new Error('Linear pattern requires one or two direction datums.');
    for (const [index, datumId] of directionDatumIds.entries()) {
      const frame = resolveStudioV5Datums(project, part.id).resolve(datumId);
      if (frame.kind !== 'axis' && frame.kind !== 'coordinate-system') throw new Error('Linear pattern directions must resolve to axes or coordinate systems.');
      references.push(patternReference('datum', datumId, index === 0 ? 'direction' : 'direction-2'));
    }
    definition.spacing = authoredOr(input, 'spacing', 10);
    definition.extent = authoredOr(input, 'extent', expressionNumber(definition.spacing, parameters, 'Pattern spacing') * (count - 1));
    definition.positions = optionalAuthoredArray(input, 'positions');
    definition.alternating = optionalAuthoredBoolean(input, 'alternating', definition.orientation === 'alternating');
    if (!['spacing', 'extent', 'table'].includes(definition.distribution)) throw new Error('Linear pattern distribution is unsupported.');
    if (!['preserve', 'alternating'].includes(definition.orientation)) throw new Error('Linear pattern orientation is unsupported.');
    if (definition.distribution === 'spacing' && Math.abs(expressionNumber(definition.spacing, parameters, 'Pattern spacing')) <= 1e-9) throw new Error('Linear pattern spacing must be nonzero.');
    if (definition.distribution === 'extent' && Math.abs(expressionNumber(definition.extent, parameters, 'Pattern extent')) <= 1e-9) throw new Error('Linear pattern extent must be nonzero.');
    if (definition.distribution === 'table' && definition.positions.length !== count - 1) throw new Error('Linear table spacing requires one generated position per occurrence.');
    if (directionDatumIds.length === 2) {
      definition.count2 = authoredOr(input, 'count2', 2);
      const count2 = expressionNumber(definition.count2, parameters, 'Second-direction pattern count');
      if (!Number.isInteger(count2) || count2 < 2 || count * count2 > 5000) throw new Error('Two-direction pattern counts must produce from 4 to 5,000 total occurrences.');
      occurrenceCount = count * count2;
      definition.distribution2 = authoredOr(input, 'distribution2', 'spacing');
      definition.symmetric2 = optionalAuthoredBoolean(input, 'symmetric2', false);
      definition.spacing2 = authoredOr(input, 'spacing2', 10);
      definition.extent2 = authoredOr(input, 'extent2', expressionNumber(definition.spacing2, parameters, 'Second-direction pattern spacing') * (count2 - 1));
      definition.positions2 = optionalAuthoredArray(input, 'positions2');
      definition.alternating2 = optionalAuthoredBoolean(input, 'alternating2', false);
      if (!['spacing', 'extent', 'table'].includes(definition.distribution2)) throw new Error('Second-direction linear pattern distribution is unsupported.');
      if (definition.distribution2 === 'spacing' && Math.abs(expressionNumber(definition.spacing2, parameters, 'Second-direction pattern spacing')) <= 1e-9) throw new Error('Second-direction pattern spacing must be nonzero.');
      if (definition.distribution2 === 'extent' && Math.abs(expressionNumber(definition.extent2, parameters, 'Second-direction pattern extent')) <= 1e-9) throw new Error('Second-direction pattern extent must be nonzero.');
      if (definition.distribution2 === 'table' && definition.positions2.length !== count2 - 1) throw new Error('Second-direction table spacing requires one generated position per occurrence.');
    }
  } else if (kind === 'circular') {
    const frame = resolveStudioV5Datums(project, part.id).resolve(input.axisDatumId);
    if (frame.kind !== 'axis' && frame.kind !== 'coordinate-system') throw new Error('Circular pattern axis must resolve to an axis or coordinate system.');
    references.push(patternReference('datum', input.axisDatumId, 'axis'));
    definition.totalAngle = authoredOr(input, 'totalAngle', 360);
    definition.spacingAngle = authoredOr(input, 'spacingAngle', expressionNumber(definition.totalAngle, parameters, 'Pattern angle') / count);
    definition.angles = optionalAuthoredArray(input, 'angles');
    definition.radialOffset = authoredOr(input, 'radialOffset', 0);
    definition.axialOffset = authoredOr(input, 'axialOffset', 0);
    if (!['full', 'extent', 'spacing', 'table'].includes(definition.distribution)) throw new Error('Circular pattern distribution is unsupported.');
    if (definition.distribution === 'spacing' && Math.abs(expressionNumber(definition.spacingAngle, parameters, 'Pattern spacing angle')) <= 1e-9) throw new Error('Circular pattern spacing angle must be nonzero.');
    if (definition.distribution === 'extent' && Math.abs(expressionNumber(definition.totalAngle, parameters, 'Pattern total angle')) <= 1e-9) throw new Error('Circular pattern total angle must be nonzero.');
    if (definition.distribution === 'table' && definition.angles.length !== count - 1) throw new Error('Circular table spacing requires one generated angle per occurrence.');
    if (!['rotate', 'preserve', 'alternating'].includes(definition.orientation)) throw new Error('Circular pattern orientation is unsupported.');
  } else if (kind === 'curve') {
    const sketch = part.sketches.find((entry) => entry.id === input.pathSketchId && entry.extensions?.studioRole === 'path');
    if (!sketch) throw new Error('Curve pattern requires an editable path sketch.');
    references.push(patternReference('sketch', input.pathSketchId, 'path'));
    definition.spacing = authoredOr(input, 'spacing', 10);
    definition.extent = authoredOr(input, 'extent', 1);
    definition.parameters = optionalAuthoredArray(input, 'parameters');
    if (!['equal', 'spacing', 'extent', 'table'].includes(definition.distribution)) throw new Error('Curve pattern distribution is unsupported.');
    if (definition.distribution === 'spacing' && expressionNumber(definition.spacing, parameters, 'Curve pattern spacing') <= 0) throw new Error('Curve pattern spacing must be positive.');
    if (definition.distribution === 'extent' && expressionNumber(definition.extent, parameters, 'Curve pattern extent') <= 0) throw new Error('Curve pattern extent must be positive.');
    if (definition.distribution === 'table' && definition.parameters.length !== count - 1) throw new Error('Curve table spacing requires one parameter per generated occurrence.');
    if (!['tangent', 'fixed'].includes(definition.orientation)) throw new Error('Curve pattern orientation is unsupported.');
  } else if (kind === 'mirror') {
    const frame = resolveStudioV5Datums(project, part.id).resolve(input.planeDatumId);
    if (frame.kind !== 'plane') throw new Error('Mirror pattern requires a plane datum.');
    references.push(patternReference('datum', input.planeDatumId, 'plane'));
    if (definition.distribution !== 'mirror' || definition.orientation !== 'mirror') throw new Error('Mirror pattern distribution and orientation must be mirror.');
  } else if (kind === 'sketch') {
    const pointSketchId = input.pointSketchId;
    const sketch = part.sketches.find((entry) =>
      entry.id === pointSketchId
        && entry.extensions?.studioRole === STUDIO_CONSTRAINED_2D_ROLE
        && !entry.constrained?.derivedFrom);
    if (!sketch) throw new Error('Sketch-driven pattern requires one direct first-class constrained point sketch.');
    const pointIds = optionalAuthoredArray(input, 'pointIds');
    if (pointIds.length < 2 || pointIds.length > 5000) throw new Error('Sketch-driven pattern requires the seed plus 1 to 4,999 generated point IDs.');
    const localPoints = new Set((sketch.constrained?.entities || [])
      .filter((entity) => entity.kind === 'point')
      .map((entity) => entity.id));
    if (new Set(pointIds).size !== pointIds.length) throw new Error('Sketch-driven pattern point IDs must not repeat.');
    for (const pointId of pointIds) if (!localPoints.has(pointId)) {
      throw new Error('Sketch-driven pattern point "' + pointId + '" is not an authored local point in the point sketch.');
    }
    count = pointIds.length;
    countExpression = count;
    occurrenceCount = count;
    if (owns(input, 'count') && expressionNumber(input.count, parameters, 'Sketch-driven pattern count') !== count) {
      throw new Error('Sketch-driven pattern count is derived from its ordered point IDs.');
    }
    definition.count = count;
    definition.pointIds = pointIds;
    references.push(patternReference('sketch', pointSketchId, 'point-sketch'));
    if (definition.distribution !== 'points' || definition.orientation !== 'preserve') {
      throw new Error('Sketch-driven pattern distribution and orientation must be points and preserve.');
    }
  } else if (kind === 'fill') {
    const boundarySketchId = input.boundarySketchId;
    const sketch = part.sketches.find((entry) =>
      entry.id === boundarySketchId
        && entry.extensions?.studioRole === 'profile'
        && entry.entities?.[0]?.kind === 'polyline'
        && entry.entities[0].closed === true);
    if (!sketch) throw new Error('Fill pattern requires one closed advanced polyline profile boundary.');
    if (sketch.support?.ownerKind !== 'datum'
        || resolveStudioV5Datums(project, part.id).resolve(sketch.support.ownerId).kind !== 'plane') {
      throw new Error('Fill pattern boundary must retain datum-plane support.');
    }
    definition.layout = authoredOr(input, 'layout', 'square');
    definition.spacing = authoredOr(input, 'spacing', 10);
    definition.rotation = authoredOr(input, 'rotation', 0);
    definition.boundaryMargin = authoredOr(input, 'boundaryMargin', 0);
    definition.seed = optionalAuthoredArray(input, 'seed', [0, 0]);
    definition.maximumCount = authoredOr(input, 'maximumCount', 500);
    if (!Number.isInteger(definition.maximumCount) || definition.maximumCount < 2 || definition.maximumCount > 5000) {
      throw new Error('Fill pattern maximumCount must be a literal integer from 2 to 5,000.');
    }
    if (definition.seed.length !== 2) throw new Error('Fill pattern seed must contain exactly two coordinates.');
    const boundaryPoints = validateAdvancedSketch(project, part, sketch);
    studioFillPatternLattice({
      boundaryPoints,
      layout: definition.layout,
      spacing: expressionNumber(definition.spacing, parameters, 'Fill pattern spacing'),
      rotationDegrees: expressionNumber(definition.rotation, parameters, 'Fill pattern rotation'),
      boundaryMargin: expressionNumber(definition.boundaryMargin, parameters, 'Fill pattern boundary margin'),
      seed: definition.seed.map((value, index) => expressionNumber(value, parameters, 'Fill pattern seed ' + (index + 1))),
      maxGenerated: definition.maximumCount - 1,
    });
    occurrenceCount = definition.maximumCount;
    references.push(patternReference('sketch', boundarySketchId, 'boundary'));
    if (definition.distribution !== 'fill' || definition.orientation !== 'preserve') {
      throw new Error('Fill pattern distribution and orientation must be fill and preserve.');
    }
    if (skippedIndices.length) throw new Error('Fill pattern skippedIndices must stay empty because lattice identity is dynamic.');
  } else {
    const directionDatumId = input.directionDatumId;
    const frame = resolveStudioV5Datums(project, part.id).resolve(directionDatumId);
    if (frame.kind !== 'axis' && frame.kind !== 'coordinate-system') {
      throw new Error('Variable pattern direction must resolve to an axis or coordinate system.');
    }
    const instances = optionalAuthoredArray(input, 'instances');
    if (instances.length < 1 || instances.length > STUDIO_VARIABLE_PATTERN_MAX_GENERATED) {
      throw new Error('Variable pattern requires 1 to 100 generated instance rows.');
    }
    count = instances.length + 1;
    countExpression = count;
    occurrenceCount = count;
    if (owns(input, 'count') && expressionNumber(input.count, parameters, 'Variable pattern count') !== count) {
      throw new Error('Variable pattern count is derived from its generated instance rows.');
    }
    const { consumed, partParameterNames } = variablePatternConsumedParameterNames(project, part, source, parameters);
    const seenPositions = [];
    const seenOverrideSignatures = new Set();
    let expectedKeys = null;
    definition.instances = instances.map((instance, index) => {
      if (!instance || typeof instance !== 'object' || Array.isArray(instance)) {
        throw new Error('Variable pattern instance ' + (index + 1) + ' must be an object.');
      }
      const unexpected = Object.keys(instance).filter((key) => key !== 'position' && key !== 'parameterOverrides');
      if (unexpected.length) throw new Error('Variable pattern instance contains unsupported fields: ' + unexpected.join(', ') + '.');
      const position = expressionNumber(instance.position, parameters, 'Variable pattern position ' + (index + 1));
      if (seenPositions.some((value) => Math.abs(value - position) <= 1e-9)) {
        throw new Error('Variable pattern evaluated positions must not repeat.');
      }
      seenPositions.push(position);
      const overrides = instance.parameterOverrides;
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        throw new Error('Variable pattern instance parameterOverrides must be an object.');
      }
      const keys = Object.keys(overrides).sort();
      if (!keys.length || keys.length > STUDIO_VARIABLE_PATTERN_MAX_PARAMETERS) {
        throw new Error('Variable pattern rows must override 1 to 16 part-local parameters.');
      }
      if (expectedKeys == null) expectedKeys = keys;
      else if (keys.length !== expectedKeys.length || keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])) {
        throw new Error('Variable pattern rows must override the same parameter-name set.');
      }
      const parameterOverrides = {};
      let differsFromSeed = false;
      for (const key of keys) {
        if (!partParameterNames.has(key)) throw new Error('Variable pattern override "' + key + '" must name a part-local parameter.');
        if (!consumed.has(key)) throw new Error('Variable pattern override "' + key + '" is not consumed by a supported active source-body feature dimension.');
        const value = overrides[key];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error('Variable pattern override "' + key + '" must be a finite literal number.');
        }
        parameterOverrides[key] = value;
        if (Math.abs(value - parameters.get(key)) > 1e-12) differsFromSeed = true;
      }
      if (!differsFromSeed) {
        throw new Error('Every variable pattern row must change at least one driving parameter from the source seed.');
      }
      const overrideSignature = JSON.stringify(keys.map((key) => [key, parameterOverrides[key]]));
      if (seenOverrideSignatures.has(overrideSignature)) {
        throw new Error('Variable pattern rows must rebuild distinct parameter variants.');
      }
      seenOverrideSignatures.add(overrideSignature);
      return { position: clone(instance.position), parameterOverrides };
    });
    definition.count = count;
    references.push(patternReference('datum', directionDatumId, 'direction'));
    if (definition.distribution !== 'table' || definition.orientation !== 'preserve') {
      throw new Error('Variable pattern distribution and orientation must be table and preserve.');
    }
  }
  if (skippedIndices.some((index) => !Number.isInteger(index) || index < 1 || index >= occurrenceCount)) throw new Error('Skipped pattern indices must refer to generated occurrences 1 through ' + (occurrenceCount - 1) + '.');
  return {
    id: input.id,
    name: String(input.name || (kind[0].toUpperCase() + kind.slice(1) + ' pattern')).trim(),
    kind,
    sourceBodyId: source.id,
    references,
    definition,
    outputMode: (() => {
      const outputMode = authoredOr(input, 'outputMode', 'linked');
      if (outputMode !== 'linked' && outputMode !== 'union') throw new Error('Pattern outputMode must be linked or union.');
      if (['sketch', 'fill', 'variable'].includes(kind) && outputMode !== 'linked') {
        throw new Error('Sketch, fill, and variable patterns support linked output only.');
      }
      return outputMode;
    })(),
    skippedIndices,
    suppressed: optionalAuthoredBoolean(input, 'suppressed', false),
    visible: optionalAuthoredBoolean(input, 'visible', true),
  };
}

export function createStudioV5BodyPattern(project, input) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const pattern = buildStudioV5BodyPattern(candidate, part, input);
  if (!pattern.name) throw new Error('Pattern name is required.');
  part.bodyPatterns ||= [];
  part.bodyPatterns.push(pattern);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function updateStudioV5BodyPattern(project, patternId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const index = (part.bodyPatterns || []).findIndex((entry) => entry.id === patternId);
  if (index < 0) throw new Error('That body pattern no longer exists.');
  const previous = part.bodyPatterns[index];
  const byRole = Object.fromEntries((previous.references || []).map((reference) => [reference.semanticPath?.role, reference.ownerId]));
  const input = {
    id: previous.id,
    name: authoredOr(patch, 'name', previous.name),
    kind: authoredOr(patch, 'kind', previous.kind),
    sourceBodyId: authoredOr(patch, 'sourceBodyId', previous.sourceBodyId),
    ...(owns(patch, 'count') || (
      !['sketch', 'variable'].includes(authoredOr(patch, 'kind', previous.kind))
      && previous.definition.count !== undefined
    )
      ? { count: authoredOr(patch, 'count', previous.definition.count) }
      : {}),
    distribution: authoredOr(patch, 'distribution', previous.definition.distribution),
    symmetric: authoredOr(patch, 'symmetric', previous.definition.symmetric),
    orientation: authoredOr(patch, 'orientation', previous.definition.orientation),
    skippedIndices: authoredOr(patch, 'skippedIndices', previous.skippedIndices),
    suppressed: authoredOr(patch, 'suppressed', previous.suppressed),
    visible: authoredOr(patch, 'visible', previous.visible),
    directionDatumIds: authoredOr(patch, 'directionDatumIds', [byRole.direction, byRole['direction-2']].filter(Boolean)),
    directionDatumId: authoredOr(patch, 'directionDatumId', byRole.direction),
    axisDatumId: authoredOr(patch, 'axisDatumId', byRole.axis),
    pathSketchId: authoredOr(patch, 'pathSketchId', byRole.path),
    planeDatumId: authoredOr(patch, 'planeDatumId', byRole.plane),
    pointSketchId: authoredOr(patch, 'pointSketchId', byRole['point-sketch']),
    pointIds: authoredOr(patch, 'pointIds', previous.definition.pointIds),
    boundarySketchId: authoredOr(patch, 'boundarySketchId', byRole.boundary),
    layout: authoredOr(patch, 'layout', previous.definition.layout),
    rotation: authoredOr(patch, 'rotation', previous.definition.rotation),
    boundaryMargin: authoredOr(patch, 'boundaryMargin', previous.definition.boundaryMargin),
    seed: authoredOr(patch, 'seed', previous.definition.seed),
    maximumCount: authoredOr(patch, 'maximumCount', previous.definition.maximumCount),
    instances: authoredOr(patch, 'instances', previous.definition.instances),
    spacing: authoredOr(patch, 'spacing', previous.definition.spacing),
    extent: authoredOr(patch, 'extent', previous.definition.extent),
    positions: authoredOr(patch, 'positions', previous.definition.positions),
    alternating: authoredOr(patch, 'alternating', previous.definition.alternating),
    count2: authoredOr(patch, 'count2', previous.definition.count2),
    distribution2: authoredOr(patch, 'distribution2', previous.definition.distribution2),
    symmetric2: authoredOr(patch, 'symmetric2', previous.definition.symmetric2),
    spacing2: authoredOr(patch, 'spacing2', previous.definition.spacing2),
    extent2: authoredOr(patch, 'extent2', previous.definition.extent2),
    positions2: authoredOr(patch, 'positions2', previous.definition.positions2),
    alternating2: authoredOr(patch, 'alternating2', previous.definition.alternating2),
    totalAngle: authoredOr(patch, 'totalAngle', previous.definition.totalAngle),
    spacingAngle: authoredOr(patch, 'spacingAngle', previous.definition.spacingAngle),
    angles: authoredOr(patch, 'angles', previous.definition.angles),
    radialOffset: authoredOr(patch, 'radialOffset', previous.definition.radialOffset),
    axialOffset: authoredOr(patch, 'axialOffset', previous.definition.axialOffset),
    parameters: authoredOr(patch, 'parameters', previous.definition.parameters),
    outputMode: authoredOr(patch, 'outputMode', previous.outputMode),
  };
  part.bodyPatterns[index] = buildStudioV5BodyPattern(candidate, part, input, patternId);
  if (!part.bodyPatterns[index].name) throw new Error('Pattern name is required.');
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function deleteStudioV5BodyPattern(project, patternId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  if (!(part.bodyPatterns || []).some((entry) => entry.id === patternId)) throw new Error('That body pattern no longer exists.');
  part.bodyPatterns = part.bodyPatterns.filter((entry) => entry.id !== patternId);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function materializeStudioV5PatternOccurrences(project, patternId, records, options = {}) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const pattern = (part.bodyPatterns || []).find((entry) => entry.id === patternId);
  if (!pattern) throw new Error('That body pattern no longer exists.');
  if (!Array.isArray(records) || !records.length) throw new Error('Pattern materialization requires at least one exact occurrence record.');
  const indices = new Set();
  for (const [index, record] of records.entries()) {
    if (record?.patternId !== pattern.id || record.sourceBodyId !== pattern.sourceBodyId) throw new Error('Materialized occurrence ' + (index + 1) + ' does not belong to this pattern.');
    if (!Number.isInteger(record.patternIndex) || record.patternIndex < 1) throw new Error('Materialized occurrence has an invalid stable index.');
    if (indices.has(record.patternIndex)) throw new Error('Materialized occurrence index ' + record.patternIndex + ' is duplicated.');
    indices.add(record.patternIndex);
    const resource = clone(record.resource);
    const feature = clone(record.feature);
    const body = clone(record.body);
    requireUniquePartId(part, feature.id, 'Materialized feature');
    requireUniquePartId(part, body.id, 'Materialized body');
    if (candidate.resources.some((entry) => entry.id === resource.id)) throw new Error('Materialized resource ID "' + resource.id + '" is already in use.');
    feature.createdBodyId = body.id;
    feature.resultPolicy = { kind: 'new-body', bodyName: body.name };
    feature.extensions = {
      ...(feature.extensions || {}),
      studioPatternMaterialization: { patternId: pattern.id, patternIndex: record.patternIndex, sourceBodyId: pattern.sourceBodyId, independent: true },
    };
    body.createdByFeatureId = feature.id;
    body.featureIds = [feature.id];
    body.extensions = {
      ...(body.extensions || {}),
      studioPatternMaterialization: { patternId: pattern.id, patternIndex: record.patternIndex, sourceBodyId: pattern.sourceBodyId, independent: true },
    };
    candidate.resources.push(resource);
    part.features.push(feature);
    part.bodies.push(body);
  }
  if (options.dissolve === true) part.bodyPatterns = part.bodyPatterns.filter((entry) => entry.id !== pattern.id);
  else pattern.skippedIndices = [...new Set([...(pattern.skippedIndices || []), ...indices])].sort((left, right) => left - right);
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

function studioV5ProjectIds(project) {
  const ids = new Set([project.projectId]);
  const visit = (value, key = '') => {
    if (key === 'id' && typeof value === 'string') ids.add(value);
    else if (Array.isArray(value)) value.forEach((entry) => visit(entry));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(project);
  return ids;
}

function requireUniqueProjectId(project, id, label) {
  if (studioV5ProjectIds(project).has(id)) throw new Error(label + ' ID "' + id + '" is already in use.');
}

export function createStudioV5AssemblyFromPart(project, input) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  requireUniqueProjectId(candidate, input.id, 'Assembly');
  requireUniqueProjectId(candidate, input.occurrenceId, 'Occurrence');
  const assembly = {
    id: input.id,
    name: String(input.name || part.name + ' assembly').trim(),
    parameters: [],
    occurrences: [{
      id: input.occurrenceId,
      name: String(input.occurrenceName || part.name).trim(),
      definition: { kind: 'part', partId: part.id },
      baseTransform: studioV5IdentityMatrix(),
      fixed: input.fixed !== false,
      suppressed: false,
      visible: true,
    }],
    mates: [],
    occurrencePatterns: [],
    explodedViews: [],
    sectionViews: [],
  };
  if (!assembly.name || !assembly.occurrences[0].name) throw new Error('Assembly and first occurrence names are required.');
  candidate.assemblyDefinitions.push(assembly);
  candidate.rootDocument = { kind: 'assembly', assemblyId: assembly.id };
  candidate.name = assembly.name;
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function createStudioV5ComponentOccurrence(project, input) {
  const candidate = canonicalStudioV5Project(project);
  const assembly = studioV5RootAssembly(candidate);
  requireUniqueProjectId(candidate, input.id, 'Occurrence');
  const definition = clone(input.definition);
  const source = definition?.kind === 'part'
    ? candidate.partDefinitions.find((entry) => entry.id === definition.partId)
    : candidate.assemblyDefinitions.find((entry) => entry.id === definition?.assemblyId);
  if (!source) throw new Error('Choose an existing part or subassembly definition.');
  if (definition.kind === 'assembly' && definition.assemblyId === assembly.id) throw new Error('An assembly cannot contain itself.');
  const matrix = input.baseTransform == null ? studioV5IdentityMatrix() : [...input.baseTransform];
  if (matrix.length !== 16 || !matrix.every(Number.isFinite)) throw new Error('Component transform must contain 16 finite numbers.');
  const occurrence = {
    id: input.id,
    name: String(input.name || source.name).trim(),
    definition,
    ...(input.parentOccurrenceId ? { parentOccurrenceId: input.parentOccurrenceId } : {}),
    baseTransform: matrix,
    fixed: input.fixed === true,
    suppressed: input.suppressed === true,
    visible: input.visible !== false,
    ...(input.parameterOverrides ? { parameterOverrides: clone(input.parameterOverrides) } : {}),
    ...(input.extensions ? { extensions: clone(input.extensions) } : {}),
  };
  if (!occurrence.name) throw new Error('Component occurrence name is required.');
  assembly.occurrences.push(occurrence);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function updateStudioV5ComponentOccurrence(project, occurrenceId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const assembly = studioV5RootAssembly(candidate);
  const occurrence = assembly.occurrences.find((entry) => entry.id === occurrenceId);
  if (!occurrence) throw new Error('That component occurrence no longer exists.');
  if (patch.name != null) {
    const name = String(patch.name).trim();
    if (!name) throw new Error('Component occurrence name is required.');
    occurrence.name = name;
  }
  for (const property of ['fixed', 'suppressed', 'visible']) if (patch[property] != null) occurrence[property] = patch[property] === true;
  if (patch.baseTransform != null) occurrence.baseTransform = [...patch.baseTransform];
  if (patch.parameterOverrides !== undefined) {
    if (patch.parameterOverrides == null) delete occurrence.parameterOverrides;
    else occurrence.parameterOverrides = clone(patch.parameterOverrides);
  }
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function duplicateStudioV5LinkedOccurrence(project, occurrenceId, input) {
  const assembly = studioV5RootAssembly(project);
  const source = assembly.occurrences.find((entry) => entry.id === occurrenceId);
  if (!source) throw new Error('That component occurrence no longer exists.');
  return createStudioV5ComponentOccurrence(project, {
    ...source,
    id: input.id,
    name: input.name || source.name + ' linked',
    baseTransform: input.baseTransform || source.baseTransform,
    fixed: input.fixed === true,
  });
}

function remapDefinitionIds(value, replacements, key = '') {
  if (typeof value === 'string') return replacements.get(value) || value;
  if (Array.isArray(value)) return value.map((entry) => remapDefinitionIds(entry, replacements, key));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, remapDefinitionIds(child, replacements, childKey)]));
}

function boundedIndependentChildId(partId, sourceId, usedIds) {
  const expanded = partId + '-' + sourceId;
  if (expanded.length <= 60 && !usedIds.has(expanded)) return expanded;
  for (let collision = 0; collision < 10_000; collision++) {
    const digest = studioV5Sha256Hex(expanded + ':' + collision).slice(0, 12);
    const suffix = '-' + digest;
    const candidate = expanded.slice(0, 60 - suffix.length) + suffix;
    if (!usedIds.has(candidate)) return candidate;
  }
  throw new Error('Could not allocate a bounded stable ID for the independent part copy.');
}

// Project identities and references share string storage with parameter
// expressions, user labels, and extension payloads. Keep ownership discovery
// out of opaque records and rewrite only schema fields that explicitly carry
// an owned identity or reference. Known extension references (for example
// resourceId/registryId) remain covered by the reference-field allowlist.
const IMPORTED_OPAQUE_ID_SCOPES = new Set(['extensions', 'metadata', 'semanticPath', 'signature']);

const IMPORTED_OWNED_ID_FIELDS = new Set(['id', 'operationId']);

const IMPORTED_REFERENCE_ID_FIELDS = new Set([
  'activeBodyId',
  'activeConfigurationId',
  'affectedBodyIds',
  'appearanceId',
  'appearanceOverrideId',
  'assemblyId',
  'axisDatumId',
  'beforeFeatureId',
  'bodyId',
  'bodyIds',
  'centerlineSketchId',
  'configurationId',
  'consumedByFeatureId',
  'createdBodyId',
  'createdByFeatureId',
  'datumId',
  'defaultAppearanceId',
  'directionDatumId',
  'directionDatumIds',
  'entityId',
  'entityIds',
  'featureId',
  'featureIds',
  'featureOrder',
  'featureSuppressionColumns',
  'firstDatumId',
  'fromDatumId',
  'guideSketchId',
  'guideSketchIds',
  'materialId',
  'neutralPlaneDatumId',
  'occurrenceId',
  'occurrenceIds',
  'occurrencePath',
  'operationId',
  'ownerFeatureId',
  'ownerId',
  'parameterId',
  'parentOccurrenceId',
  'partId',
  'pathSketchId',
  'patternId',
  'planeDatumId',
  'pointDatumId',
  'profileSketchId',
  'registryId',
  'referenceDatumId',
  'repairedFromOwnerId',
  'resourceId',
  'rollbackFeatureId',
  'secondDatumId',
  'sketchId',
  'sourceBodyId',
  'sourceFeatureId',
  'sourceEntityIds',
  'sourceOccurrenceIds',
  'sourcePatternId',
  'targetBodyId',
  'targetBodyIds',
  'toDatumId',
  'toolBodyId',
  'toolBodyIds',
]);

const IMPORTED_REFERENCE_ID_MAPS = new Set([
  'configurationData',
  'featureSuppressionOverrides',
]);

function collectImportedOwnedIds(value, ids = new Set(), ownedIdScope = true) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectImportedOwnedIds(entry, ids, ownedIdScope));
    return ids;
  }
  if (!value || typeof value !== 'object') return ids;
  for (const [key, child] of Object.entries(value)) {
    if (ownedIdScope && IMPORTED_OWNED_ID_FIELDS.has(key) && typeof child === 'string') ids.add(child);
    collectImportedOwnedIds(child, ids, ownedIdScope && !IMPORTED_OPAQUE_ID_SCOPES.has(key));
  }
  return ids;
}

function collectImportedAppearanceIds(value, ids = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectImportedAppearanceIds(entry, ids));
    return ids;
  }
  if (!value || typeof value !== 'object') return ids;
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'appearanceId' || key === 'defaultAppearanceId' || key === 'appearanceOverrideId') && typeof child === 'string') ids.add(child);
    collectImportedAppearanceIds(child, ids);
  }
  return ids;
}

function remapImportedIds(value, replacements, key = '', ownedIdScope = true) {
  if (typeof value === 'string') {
    return ((ownedIdScope && IMPORTED_OWNED_ID_FIELDS.has(key)) || IMPORTED_REFERENCE_ID_FIELDS.has(key))
      ? replacements.get(value) || value
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => remapImportedIds(entry, replacements, key, ownedIdScope));
  }
  if (!value || typeof value !== 'object') return value;
  const remapKeys = IMPORTED_REFERENCE_ID_MAPS.has(key);
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    remapKeys ? replacements.get(childKey) || childKey : childKey,
    remapImportedIds(
      child,
      replacements,
      childKey,
      ownedIdScope && !IMPORTED_OPAQUE_ID_SCOPES.has(childKey),
    ),
  ]));
}

function importedPartHasExternalGeometryReferences(part, ownedIds) {
  let external = null;
  const visit = (value) => {
    if (external || !value || typeof value !== 'object') return;
    if (
      typeof value.ownerKind === 'string' &&
      typeof value.ownerId === 'string' &&
      (value.occurrencePath?.length || !ownedIds.has(value.ownerId))
    ) {
      external = value;
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  };
  visit(part);
  return external;
}

function allocateImportedId(usedIds, partId, serial) {
  let nextSerial = serial;
  for (;;) {
    const suffix = ':import:' + nextSerial.toString(36);
    const candidate = partId.slice(0, Math.max(1, 200 - suffix.length)) + suffix;
    nextSerial++;
    if (!usedIds.has(candidate)) {
      usedIds.add(candidate);
      return { id: candidate, nextSerial };
    }
  }
}

// Importing a saved component is a definition merge, not a project-open. Keep
// the active project/root assembly intact, localize source-project parameters
// into the imported part, and remap every owned identity before the caller adds
// an occurrence. The normal schema boundary remains the final authority.
export function importStudioV5PartDefinition(project, sourceProject, input) {
  const candidate = canonicalStudioV5Project(project);
  const source = canonicalStudioV5Project(sourceProject);
  if (source.rootDocument?.kind !== 'part') throw new Error('Choose a saved project whose active document is a part.');
  if (source.units !== candidate.units) throw new Error('Imported part units must match the active project.');

  const partId = String(input?.partId || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(partId)) {
    throw new Error('Imported part ID must use letters, numbers, dot, underscore, colon, or hyphen.');
  }
  requireUniqueProjectId(candidate, partId, 'Imported part');

  const sourcePart = clone(studioV5RootPart(source));
  const sourceOwnedIds = new Set([
    sourcePart.id,
    ...sourcePart.referenceGeometry.map((entry) => entry.id),
    ...sourcePart.sketches.map((entry) => entry.id),
    ...sourcePart.features.map((entry) => entry.id),
    ...sourcePart.bodies.map((entry) => entry.id),
  ]);
  const externalReference = importedPartHasExternalGeometryReferences(sourcePart, sourceOwnedIds);
  if (externalReference) {
    throw new Error('The saved part contains an assembly-context reference; make that geometry independent before importing it.');
  }

  const localParameterNames = new Set(sourcePart.parameters.map((parameter) => parameter.name));
  const resolvedProjectParameters = studioV5ParameterValues(source, { parameters: [] });
  const localizedProjectParameters = source.parameters
    .filter((parameter) => !localParameterNames.has(parameter.name))
    .map((parameter) => ({ ...clone(parameter), value: resolvedProjectParameters.get(parameter.name) }));
  sourcePart.parameters = [...localizedProjectParameters, ...sourcePart.parameters];
  if (input?.name != null) sourcePart.name = String(input.name).trim();

  const sourceConfigurationSet = source.partConfigurationSets.find((entry) => entry.partId === sourcePart.id) || null;
  const referencedMaterialIds = new Set(sourcePart.bodies.map((body) => body.materialId).filter(Boolean));
  const referencedAppearanceIds = collectImportedAppearanceIds(sourcePart);
  const selectedMaterials = source.materials.filter((material) =>
    referencedMaterialIds.has(material.id) || referencedAppearanceIds.has(material.appearanceId));
  const referencedResourceIds = new Set(sourcePart.features
    .map((feature) => feature.extensions?.studioImportedStep?.resourceId)
    .filter(Boolean));
  const selectedResources = source.resources.filter((resource) => referencedResourceIds.has(resource.id));
  for (const resourceId of referencedResourceIds) {
    if (!selectedResources.some((resource) => resource.id === resourceId)) {
      throw new Error('The saved part is missing its exact imported-geometry resource.');
    }
  }

  const bundle = {
    part: sourcePart,
    materials: selectedMaterials,
    resources: selectedResources,
    configurationSet: sourceConfigurationSet,
  };
  const importedIds = collectImportedOwnedIds(bundle);
  collectImportedAppearanceIds(bundle, importedIds);
  const usedIds = studioV5ProjectIds(candidate);
  collectImportedAppearanceIds(candidate, usedIds);
  const replacements = new Map([[sourcePart.id, partId]]);
  usedIds.add(partId);
  let serial = 1;
  for (const sourceId of importedIds) {
    if (replacements.has(sourceId)) continue;
    const allocated = allocateImportedId(usedIds, partId, serial);
    replacements.set(sourceId, allocated.id);
    serial = allocated.nextSerial;
  }

  const importedPart = remapImportedIds(sourcePart, replacements);
  candidate.partDefinitions.push(importedPart);
  candidate.materials.push(...selectedMaterials.map((material) => remapImportedIds(material, replacements)));
  candidate.resources.push(...selectedResources.map((resource) => remapImportedIds(resource, replacements)));
  if (sourceConfigurationSet) {
    candidate.partConfigurationSets.push(remapImportedIds(sourceConfigurationSet, replacements));
  }
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function makeStudioV5OccurrenceIndependent(project, occurrenceId, input) {
  const candidate = canonicalStudioV5Project(project);
  const assembly = studioV5RootAssembly(candidate);
  const occurrence = assembly.occurrences.find((entry) => entry.id === occurrenceId);
  if (!occurrence || occurrence.definition.kind !== 'part') throw new Error('Make independent currently requires a part occurrence.');
  const source = candidate.partDefinitions.find((entry) => entry.id === occurrence.definition.partId);
  if (!source) throw new Error('The source part definition is missing.');
  requireUniqueProjectId(candidate, input.partId, 'Independent part');
  const replacements = new Map();
  const usedIds = new Set();
  const collectUsed = (value, key = '') => {
    if (key === 'id' && typeof value === 'string') usedIds.add(value);
    else if (Array.isArray(value)) value.forEach((entry) => collectUsed(entry));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([childKey, child]) => collectUsed(child, childKey));
  };
  collectUsed(candidate);
  replacements.set(source.id, input.partId);
  usedIds.add(input.partId);
  const collect = (value, key = '') => {
    if (key === 'id' && typeof value === 'string' && !replacements.has(value)) {
      const replacement = boundedIndependentChildId(input.partId, value, usedIds);
      replacements.set(value, replacement);
      usedIds.add(replacement);
    }
    else if (Array.isArray(value)) value.forEach((entry) => collect(entry));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([childKey, child]) => collect(child, childKey));
  };
  collect(source);
  const definitionById = new Map((source.sketchBlockDefinitions || []).map((definition) => [definition.id, definition]));
  const sketchById = new Map((source.sketches || []).map((sketch) => [sketch.id, sketch]));
  const memberPairs = new Map();
  const resolvedMemberPairs = (sketchId) => {
    if (memberPairs.has(sketchId)) return memberPairs.get(sketchId);
    const sketch = sketchById.get(sketchId);
    const pairs = [];
    memberPairs.set(sketchId, pairs);
    if (sketch?.constrained?.derivedFrom) {
      for (const [oldMemberId, newMemberId] of resolvedMemberPairs(sketch.constrained.derivedFrom.sourceSketchId)) {
        pairs.push([
          studioDerivedSketchMemberId(sketch.id, oldMemberId),
          studioDerivedSketchMemberId(replacements.get(sketch.id), newMemberId),
        ]);
      }
    } else if (sketch?.constrained) {
      for (const entity of sketch.constrained.entities || []) {
        pairs.push([entity.id, replacements.get(entity.id) || entity.id]);
      }
      for (const instance of sketch.constrained.blockInstances || []) {
        const definition = definitionById.get(instance.definitionId);
        for (const entity of definition?.constrained?.entities || []) {
          pairs.push([
            studioSketchBlockMemberId(instance.id, entity.id),
            studioSketchBlockMemberId(
              replacements.get(instance.id) || instance.id,
              replacements.get(entity.id) || entity.id,
            ),
          ]);
        }
      }
    }
    return pairs;
  };
  for (const sketch of source.sketches || []) {
    resolvedMemberPairs(sketch.id);
  }
  const independent = remapDefinitionIds(source, replacements);
  const memberMapFor = (sketchId) => new Map(resolvedMemberPairs(sketchId));
  const remapRelationReference = (reference, sourceSketch) => {
    const currentMembers = memberMapFor(sourceSketch.id);
    const mappedCurrentMember = (memberId) => currentMembers.get(memberId) || replacements.get(memberId) || memberId;
    if (typeof reference === 'string') return mappedCurrentMember(reference);
    if (reference.entityId !== undefined) {
      return { ...reference, entityId: mappedCurrentMember(reference.entityId) };
    }
    if (reference.instanceId !== undefined) {
      return {
        ...reference,
        instanceId: replacements.get(reference.instanceId) || reference.instanceId,
        memberId: replacements.get(reference.memberId) || reference.memberId,
      };
    }
    if (reference.derivedMemberId !== undefined) {
      const sourceSketchId = sourceSketch.constrained?.derivedFrom?.sourceSketchId;
      const upstreamMembers = sourceSketchId ? memberMapFor(sourceSketchId) : new Map();
      return {
        ...reference,
        derivedMemberId: upstreamMembers.get(reference.derivedMemberId)
          || replacements.get(reference.derivedMemberId)
          || reference.derivedMemberId,
      };
    }
    return reference;
  };
  const independentSketches = new Map((independent.sketches || []).map((sketch) => [sketch.id, sketch]));
  for (const sourceSketch of source.sketches || []) {
    const independentSketch = independentSketches.get(replacements.get(sourceSketch.id) || sourceSketch.id);
    if (!independentSketch?.constrained) continue;
    const clonedRelations = independentSketch.constrained.relations || [];
    independentSketch.constrained.relations = (sourceSketch.constrained?.relations || []).map((relation, index) => {
      const output = clonedRelations[index] || remapDefinitionIds(relation, replacements);
      for (const field of ['a', 'b', 'line', 'circle', 'point', 'axis']) {
        if (relation[field] !== undefined) output[field] = remapRelationReference(relation[field], sourceSketch);
      }
      return output;
    });
  }
  independent.id = input.partId;
  independent.name = String(input.name || source.name + ' independent').trim();
  candidate.partDefinitions.push(independent);
  occurrence.definition = { kind: 'part', partId: independent.id };
  occurrence.name = input.occurrenceName || occurrence.name;
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function replaceStudioV5ComponentOccurrence(project, occurrenceId, definition) {
  const candidate = canonicalStudioV5Project(project);
  const assembly = studioV5RootAssembly(candidate);
  const occurrence = assembly.occurrences.find((entry) => entry.id === occurrenceId);
  if (!occurrence) throw new Error('That component occurrence no longer exists.');
  const previousDefinition = occurrence.definition.kind === 'part'
    ? candidate.partDefinitions.find((entry) => entry.id === occurrence.definition.partId)
    : candidate.assemblyDefinitions.find((entry) => entry.id === occurrence.definition.assemblyId);
  const replacement = definition?.kind === 'part'
    ? candidate.partDefinitions.find((entry) => entry.id === definition.partId)
    : candidate.assemblyDefinitions.find((entry) => entry.id === definition?.assemblyId);
  if (!replacement) throw new Error('Choose an existing replacement definition.');
  occurrence.definition = clone(definition);
  const replacementOwnerIds = new Set();
  const visit = (value, key = '') => {
    if (key === 'id' && typeof value === 'string') replacementOwnerIds.add(value);
    else if (Array.isArray(value)) value.forEach((entry) => visit(entry));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(replacement);
  const compatibleOwners = new Map();
  if (previousDefinition && occurrence.definition.kind === 'part') {
    const ownerCollections = [
      ['datum', previousDefinition.referenceGeometry || [], replacement.referenceGeometry || []],
      ['sketch', previousDefinition.sketches || [], replacement.sketches || []],
      ['body', previousDefinition.bodies || [], replacement.bodies || []],
    ];
    const semanticToken = (entry) => String(entry?.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).at(-1) || '';
    for (const [ownerKind, previousOwners, nextOwners] of ownerCollections) for (const owner of previousOwners) {
      const matches = nextOwners.filter((entry) => ownerKind !== 'datum' || entry.kind === owner.kind);
      const semantic = matches.find((entry) => semanticToken(entry) === semanticToken(owner));
      const sameMode = matches.find((entry) => entry.definition?.mode === owner.definition?.mode);
      const resolved = semantic || sameMode || (matches.length === 1 ? matches[0] : null);
      if (resolved) compatibleOwners.set(ownerKind + ':' + owner.id, resolved.id);
    }
  }
  assembly.mates = assembly.mates.filter((mate) => {
    if (!mate.occurrenceIds.includes(occurrenceId)) return true;
    for (const reference of mate.references) {
      if (reference.ownerKind === 'occurrence' || !reference.occurrencePath?.includes(occurrenceId) || replacementOwnerIds.has(reference.ownerId)) continue;
      const repaired = compatibleOwners.get(reference.ownerKind + ':' + reference.ownerId);
      if (!repaired) return false;
      const previousOwnerId = reference.ownerId;
      reference.ownerId = repaired;
      reference.signature = { ...(reference.signature || {}), repairedFromOwnerId: previousOwnerId };
    }
    return true;
  });
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function deleteStudioV5ComponentOccurrence(project, occurrenceId) {
  const candidate = canonicalStudioV5Project(project);
  const assembly = studioV5RootAssembly(candidate);
  if (!assembly.occurrences.some((entry) => entry.id === occurrenceId)) throw new Error('That component occurrence no longer exists.');
  const smartFastenerDependency = studioSmartFastenerOccurrenceDependency(assembly, occurrenceId);
  if (smartFastenerDependency) {
    throw new Error(
      'Smart Fastener group "' + smartFastenerDependency.groupId + '" ' +
      (smartFastenerDependency.role === 'target' ? 'depends on' : 'owns') +
      ' this occurrence. Delete or update the Smart Fastener group through its typed command.',
    );
  }
  const assemblyFeatureDependency = studioAssemblyFeatureOccurrenceDependency(assembly, occurrenceId);
  if (assemblyFeatureDependency) {
    throw new Error(
      'Assembly ' + assemblyFeatureDependency.kind + ' feature "' + assemblyFeatureDependency.featureId
        + '" targets this occurrence. Delete or update that assembly feature first.',
    );
  }
  const removed = new Set([occurrenceId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const occurrence of assembly.occurrences) if (removed.has(occurrence.parentOccurrenceId) && !removed.has(occurrence.id)) {
      removed.add(occurrence.id); changed = true;
    }
  }
  assembly.occurrences = assembly.occurrences.filter((entry) => !removed.has(entry.id));
  assembly.mates = assembly.mates.filter((mate) => !mate.occurrenceIds.some((id) => removed.has(id)));
  assembly.occurrencePatterns = assembly.occurrencePatterns.filter((pattern) => !pattern.sourceOccurrenceIds.some((id) => removed.has(id)));
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

const ADVANCED_MATE_INPUT_KEYS = new Set([
  'id',
  'name',
  'kind',
  'mateKind',
  'occurrenceIds',
  'references',
  'suppressed',
  'extensions',
]);

function buildStudioV5AdvancedMate(assembly, input) {
  const unsupported = Object.keys(input).filter((key) => !ADVANCED_MATE_INPUT_KEYS.has(key));
  if (unsupported.length) {
    throw new Error(
      'Advanced mate input contains unsupported fields: ' + unsupported.join(', ') + '.',
    );
  }
  if (owns(input, 'mateKind') && input.mateKind !== input.kind) {
    throw new Error('Advanced mate transport kind must equal its immutable mate kind.');
  }
  const occurrenceIds = clone(input.occurrenceIds || []);
  if (occurrenceIds.some((id) => !assembly.occurrences.some((entry) => entry.id === id))) {
    throw new Error('Mate occurrence selection no longer resolves.');
  }
  return buildStudioAdvancedMateRecord({
    id: input.id,
    name: String(input.name || input.kind[0].toUpperCase() + input.kind.slice(1) + ' mate').trim(),
    kind: input.kind,
    occurrenceIds,
    references: clone(input.references || []),
    suppressed: input.suppressed === true,
    extensions: clone(input.extensions),
  });
}

function buildStudioV5MechanicalMate(assembly, input) {
  const unsupported = Object.keys(input).filter((key) => !ADVANCED_MATE_INPUT_KEYS.has(key));
  if (unsupported.length) {
    throw new Error(
      'Mechanical mate input contains unsupported fields: ' + unsupported.join(', ') + '.',
    );
  }
  if (owns(input, 'mateKind') && input.mateKind !== input.kind) {
    throw new Error('Mechanical mate transport kind must equal its immutable mate kind.');
  }
  const occurrenceIds = clone(input.occurrenceIds || []);
  if (occurrenceIds.some((id) => !assembly.occurrences.some((entry) => entry.id === id))) {
    throw new Error('Mate occurrence selection no longer resolves.');
  }
  return buildStudioMechanicalMateRecord({
    id: input.id,
    name: String(input.name || input.kind[0].toUpperCase() + input.kind.slice(1) + ' mate').trim(),
    kind: input.kind,
    occurrenceIds,
    references: clone(input.references || []),
    suppressed: input.suppressed === true,
    extensions: clone(input.extensions),
  });
}

function buildStudioV5Mate(assembly, input) {
  const kind = input.kind;
  if (isStudioAdvancedMateKind(kind)) return buildStudioV5AdvancedMate(assembly, input);
  if (isStudioMechanicalMateKind(kind)) return buildStudioV5MechanicalMate(assembly, input);
  if (hasStudioAdvancedMateContract(input)) {
    throw new Error('extensions.advancedMate is only valid for an advanced mate kind.');
  }
  if (hasStudioMechanicalMateContract(input)) {
    throw new Error('extensions.mechanicalMate is only valid for a mechanical mate kind.');
  }
  const occurrenceIds = [...new Set(input.occurrenceIds || [])];
  if (kind === 'fixed') {
    if (occurrenceIds.length !== 1) throw new Error('Fixed mate requires one occurrence.');
  } else if (occurrenceIds.length !== 2) throw new Error(kind + ' mate requires two different occurrences.');
  if (occurrenceIds.some((id) => !assembly.occurrences.some((entry) => entry.id === id))) throw new Error('Mate occurrence selection no longer resolves.');
  const references = clone(input.references || []);
  if (kind !== 'fixed' && references.length !== 2) throw new Error(kind + ' mate requires two explicit references.');
  return {
    id: input.id,
    name: String(input.name || kind[0].toUpperCase() + kind.slice(1) + ' mate').trim(),
    kind,
    occurrenceIds,
    references,
    ...(input.value != null ? { value: input.value } : {}),
    suppressed: input.suppressed === true,
    ...(input.extensions ? { extensions: clone(input.extensions) } : {}),
  };
}

export function createStudioV5AssemblyMate(project, input) {
  const candidate = canonicalStudioV5Project(project);
  const assembly = studioV5RootAssembly(candidate);
  requireUniqueProjectId(candidate, input.id, 'Mate');
  const mate = buildStudioV5Mate(assembly, input);
  if (!mate.name) throw new Error('Mate name is required.');
  assembly.mates.push(mate);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function updateStudioV5AssemblyMate(project, mateId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const assembly = studioV5RootAssembly(candidate);
  const index = assembly.mates.findIndex((entry) => entry.id === mateId);
  if (index < 0) throw new Error('That mate no longer exists.');
  const previous = assembly.mates[index];
  let nextInput = { ...previous, ...patch, id: previous.id };
  if (isStudioAdvancedMateKind(previous.kind)) {
    if (owns(patch, 'kind') && patch.kind !== previous.kind) {
      throw new Error('Advanced mate kind is immutable.');
    }
    if (owns(patch, 'mateKind') && patch.mateKind !== previous.kind) {
      throw new Error('Advanced mate kind is immutable.');
    }
    if (owns(patch, 'extensions')) {
      if (!patch.extensions || typeof patch.extensions !== 'object'
          || Array.isArray(patch.extensions)
          || Object.keys(patch.extensions).length !== 1
          || !owns(patch.extensions, 'advancedMate')
          || !patch.extensions.advancedMate
          || typeof patch.extensions.advancedMate !== 'object'
          || Array.isArray(patch.extensions.advancedMate)) {
        throw new Error('Advanced mate updates must retain the exact extensions.advancedMate contract.');
      }
      if (owns(patch.extensions.advancedMate, 'family')
          && patch.extensions.advancedMate.family !== previous.extensions.advancedMate.family) {
        throw new Error('Advanced mate family is immutable.');
      }
      nextInput = {
        ...nextInput,
        extensions: {
          advancedMate: {
            ...previous.extensions.advancedMate,
            ...patch.extensions.advancedMate,
          },
        },
      };
    }
    const next = buildStudioV5Mate(assembly, nextInput);
    assertStudioAdvancedMateUpdate(previous, next);
    assembly.mates[index] = next;
  } else if (isStudioMechanicalMateKind(previous.kind)) {
    if (owns(patch, 'kind') && patch.kind !== previous.kind) {
      throw new Error('Mechanical mate kind is immutable.');
    }
    if (owns(patch, 'mateKind') && patch.mateKind !== previous.kind) {
      throw new Error('Mechanical mate kind is immutable.');
    }
    if (owns(patch, 'extensions')) {
      if (!patch.extensions || typeof patch.extensions !== 'object'
          || Array.isArray(patch.extensions)
          || Object.keys(patch.extensions).length !== 1
          || !owns(patch.extensions, 'mechanicalMate')
          || !patch.extensions.mechanicalMate
          || typeof patch.extensions.mechanicalMate !== 'object'
          || Array.isArray(patch.extensions.mechanicalMate)) {
        throw new Error('Mechanical mate updates must retain the exact extensions.mechanicalMate contract.');
      }
      if (owns(patch.extensions.mechanicalMate, 'family')
          && patch.extensions.mechanicalMate.family !== previous.extensions.mechanicalMate.family) {
        throw new Error('Mechanical mate family is immutable.');
      }
      nextInput = {
        ...nextInput,
        extensions: {
          mechanicalMate: {
            ...previous.extensions.mechanicalMate,
            ...patch.extensions.mechanicalMate,
          },
        },
      };
    }
    const next = buildStudioV5Mate(assembly, nextInput);
    assertStudioMechanicalMateUpdate(previous, next);
    assembly.mates[index] = next;
  } else {
    if (isStudioAdvancedMateKind(nextInput.kind) || hasStudioAdvancedMateContract(nextInput)) {
      throw new Error('A conventional mate cannot be converted into an advanced mate through mate.update.');
    }
    if (isStudioMechanicalMateKind(nextInput.kind) || hasStudioMechanicalMateContract(nextInput)) {
      throw new Error('A conventional mate cannot be converted into a mechanical mate through mate.update.');
    }
    assembly.mates[index] = buildStudioV5Mate(assembly, nextInput);
  }
  if (!assembly.mates[index].name) throw new Error('Mate name is required.');
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function deleteStudioV5AssemblyMate(project, mateId) {
  const candidate = canonicalStudioV5Project(project);
  const assembly = studioV5RootAssembly(candidate);
  if (!assembly.mates.some((entry) => entry.id === mateId)) throw new Error('That mate no longer exists.');
  const smartFastenerDependency = studioSmartFastenerMateDependency(assembly, mateId);
  if (smartFastenerDependency) {
    throw new Error(
      'Smart Fastener group "' + smartFastenerDependency.groupId +
      '" owns this mate. Delete or update the Smart Fastener group through its typed command.',
    );
  }
  assembly.mates = assembly.mates.filter((entry) => entry.id !== mateId);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

function studioV5SmartFastenerResult(candidate, result) {
  return {
    project: decorateStudioV5Project(prepareStudioV5Project(candidate)),
    group: clone(result.group),
  };
}

export function applyStudioV5SmartFastenerPlan(project, plan, options) {
  const candidate = canonicalStudioV5Project(project);
  const result = applyStudioSmartFastenerPlan(candidate, plan, options);
  return studioV5SmartFastenerResult(candidate, result);
}

export function updateStudioV5SmartFastenerGroup(project, groupId, plan, options = {}) {
  const candidate = canonicalStudioV5Project(project);
  const result = updateStudioSmartFastenerGroup(candidate, groupId, plan, options);
  return studioV5SmartFastenerResult(candidate, result);
}

export function deleteStudioV5SmartFastenerGroup(project, groupId) {
  const candidate = canonicalStudioV5Project(project);
  const result = deleteStudioSmartFastenerGroup(candidate, groupId);
  return studioV5SmartFastenerResult(candidate, result);
}

function studioV5AssemblyFeatureResult(candidate, result) {
  return {
    project: decorateStudioV5Project(prepareStudioV5Project(candidate)),
    feature: clone(result.feature),
  };
}

export function createStudioV5AssemblyFeature(project, input) {
  const candidate = canonicalStudioV5Project(project);
  const result = createStudioAssemblyFeature(candidate, clone(input));
  return studioV5AssemblyFeatureResult(candidate, result);
}

export function updateStudioV5AssemblyFeature(project, featureId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const result = updateStudioAssemblyFeature(candidate, featureId, clone(patch));
  return studioV5AssemblyFeatureResult(candidate, result);
}

export function deleteStudioV5AssemblyFeature(project, featureId) {
  const candidate = canonicalStudioV5Project(project);
  const result = deleteStudioAssemblyFeature(candidate, featureId);
  return studioV5AssemblyFeatureResult(candidate, result);
}

export function createStudioV5OccurrencePattern(project, input) {
  const candidate = canonicalStudioV5Project(project);
  const assembly = studioV5RootAssembly(candidate);
  requireUniqueProjectId(candidate, input.id, 'Occurrence pattern');
  const sources = [...new Set(input.sourceOccurrenceIds || [])];
  if (!sources.length || sources.some((id) => !assembly.occurrences.some((entry) => entry.id === id))) throw new Error('Choose existing source component occurrences.');
  const generatedCount = Number(input.generatedCount);
  if (!Number.isInteger(generatedCount) || generatedCount < 1 || generatedCount > 5000) throw new Error('Generated occurrence count must be an integer from 1 to 5,000.');
  assembly.occurrencePatterns.push({
    id: input.id,
    name: String(input.name || 'Component pattern').trim(),
    kind: input.kind || 'circular',
    sourceOccurrenceIds: sources,
    generatedCount,
    definition: clone(input.definition || {}),
    suppressed: input.suppressed === true,
  });
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function updateStudioV5OccurrencePattern(project, patternId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const assembly = studioV5RootAssembly(candidate);
  const index = assembly.occurrencePatterns.findIndex((entry) => entry.id === patternId);
  if (index < 0) throw new Error('That component pattern no longer exists.');
  const previous = assembly.occurrencePatterns[index];
  const sources = [...new Set(patch.sourceOccurrenceIds || previous.sourceOccurrenceIds)];
  if (!sources.length || sources.some((id) => !assembly.occurrences.some((entry) => entry.id === id))) throw new Error('Choose existing source component occurrences.');
  const generatedCount = Number(patch.generatedCount ?? previous.generatedCount);
  if (!Number.isInteger(generatedCount) || generatedCount < 1 || generatedCount > 5000) throw new Error('Generated occurrence count must be an integer from 1 to 5,000.');
  const name = String(patch.name ?? previous.name).trim();
  if (!name) throw new Error('Component pattern name is required.');
  assembly.occurrencePatterns[index] = {
    ...previous,
    name,
    kind: patch.kind ?? previous.kind,
    sourceOccurrenceIds: sources,
    generatedCount,
    definition: clone(patch.definition ?? previous.definition),
    suppressed: patch.suppressed ?? previous.suppressed,
  };
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function deleteStudioV5OccurrencePattern(project, patternId) {
  const candidate = canonicalStudioV5Project(project);
  const assembly = studioV5RootAssembly(candidate);
  if (!assembly.occurrencePatterns.some((entry) => entry.id === patternId)) throw new Error('That component pattern no longer exists.');
  assembly.occurrencePatterns = assembly.occurrencePatterns.filter((entry) => entry.id !== patternId);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function enterStudioV5AssemblyContext(project, occurrenceId) {
  const candidate = canonicalStudioV5Project(project);
  const assembly = studioV5RootAssembly(candidate);
  const occurrence = assembly.occurrences.find((entry) => entry.id === occurrenceId && entry.definition.kind === 'part');
  if (!occurrence) throw new Error('Choose a direct part occurrence to edit in context.');
  candidate.metadata.editContext = { assemblyId: assembly.id, occurrencePath: [occurrence.id] };
  candidate.rootDocument = clone(occurrence.definition);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function exitStudioV5AssemblyContext(project) {
  const candidate = canonicalStudioV5Project(project);
  const assemblyId = candidate.metadata?.editContext?.assemblyId;
  if (!assemblyId || !candidate.assemblyDefinitions.some((entry) => entry.id === assemblyId)) throw new Error('There is no active assembly edit context.');
  candidate.rootDocument = { kind: 'assembly', assemblyId };
  delete candidate.metadata.editContext;
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

function directEditDefaultName(operation, bodyName) {
  if (operation === 'push-pull') return 'Push/Pull ' + bodyName;
  if (operation === 'replace-face') return 'Replace Face ' + bodyName;
  return 'Delete Face ' + bodyName;
}

function buildStudioV5DirectEditFeature(candidate, part, input, updatingId = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Direct-edit input must be an object.');
  }
  if (input.id !== updatingId) requireUniquePartId(part, input.id, 'Direct-edit feature');
  if (!STUDIO_DIRECT_EDIT_OPERATIONS.includes(input.operation)) {
    throw new Error('Direct-edit operation must be push-pull, replace-face, or delete-face.');
  }
  const allowedFields = input.operation === 'push-pull'
    ? new Set(['id', 'name', 'operation', 'targetBodyId', 'targetFace', 'distance', 'suppressed'])
    : input.operation === 'replace-face'
      ? new Set([
        'id', 'name', 'operation', 'targetBodyId', 'targetFace',
        'replacementBodyId', 'replacementFace', 'suppressed',
      ])
      : new Set(['id', 'name', 'operation', 'targetBodyId', 'targetFace', 'patchFace', 'suppressed']);
  const unsupportedFields = Object.keys(input).filter((key) => !allowedFields.has(key));
  if (unsupportedFields.length) {
    throw new Error('Direct-edit input contains unsupported fields: ' + unsupportedFields.join(', ') + '.');
  }
  const targetBody = part.bodies.find((body) => body.id === input.targetBodyId);
  if (!targetBody) throw new Error('Choose one existing body to direct edit.');
  const name = owns(input, 'name')
    ? input.name
    : directEditDefaultName(input.operation, targetBody.name);
  const feature = {
    id: input.id,
    name,
    type: 'direct-edit',
    operation: input.operation,
    sourceBodyId: targetBody.id,
    targetBodyId: targetBody.id,
    targetFace: clone(input.targetFace),
    suppressed: optionalAuthoredBoolean(input, 'suppressed', false),
    inputRefs: [],
    resultPolicy: { kind: 'add', targetBodyIds: [targetBody.id] },
    extensions: { directEdit: studioDirectEditExtension(input.operation) },
  };
  if (input.operation === 'push-pull') {
    feature.distance = input.distance;
  } else if (input.operation === 'replace-face') {
    feature.replacementBodyId = input.replacementBodyId;
    feature.replacementFace = clone(input.replacementFace);
  } else {
    feature.patchFace = clone(input.patchFace);
  }
  feature.inputRefs = studioDirectEditInputReferences(feature);
  const parameters = studioV5ParameterValues(candidate, part);
  assertStudioDirectEditPart(
    part,
    feature,
    'directEdit[' + feature.id + ']',
    (value) => evaluateStudioV5Expression(value, parameters),
  );
  return feature;
}

export function createStudioV5DirectEditFeature(project, input) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = buildStudioV5DirectEditFeature(candidate, part, input);
  part.features.push(feature);
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function updateStudioV5DirectEditFeature(project, featureId, patch = {}) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const index = part.features.findIndex((entry) => entry.id === featureId && entry.type === 'direct-edit');
  if (index < 0) throw new Error('That direct-edit feature no longer exists.');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new Error('Direct-edit patch must be a non-empty object.');
  }
  const previous = part.features[index];
  const allowed = previous.operation === 'push-pull'
    ? new Set(['name', 'targetFace', 'distance', 'suppressed'])
    : previous.operation === 'replace-face'
      ? new Set(['name', 'targetFace', 'replacementBodyId', 'replacementFace', 'suppressed'])
      : new Set(['name', 'targetFace', 'patchFace', 'suppressed']);
  const unsupported = Object.keys(patch).filter((key) => !allowed.has(key));
  if (unsupported.length) {
    throw new Error(
      'Direct-edit patch cannot change ' + unsupported.join(', ')
        + '; operation and target body are immutable. Delete and recreate the feature instead.',
    );
  }
  const input = {
    id: previous.id,
    name: owns(patch, 'name') ? patch.name : previous.name,
    operation: previous.operation,
    targetBodyId: previous.targetBodyId,
    targetFace: owns(patch, 'targetFace') ? clone(patch.targetFace) : clone(previous.targetFace),
    suppressed: owns(patch, 'suppressed') ? patch.suppressed : previous.suppressed,
  };
  if (previous.operation === 'push-pull') {
    input.distance = owns(patch, 'distance') ? patch.distance : previous.distance;
  } else if (previous.operation === 'replace-face') {
    input.replacementBodyId = owns(patch, 'replacementBodyId')
      ? patch.replacementBodyId
      : previous.replacementBodyId;
    input.replacementFace = owns(patch, 'replacementFace')
      ? clone(patch.replacementFace)
      : clone(previous.replacementFace);
  } else {
    input.patchFace = owns(patch, 'patchFace') ? clone(patch.patchFace) : clone(previous.patchFace);
  }
  const feature = buildStudioV5DirectEditFeature(candidate, part, input, previous.id);
  if (JSON.stringify(feature) === JSON.stringify(previous)) {
    throw new Error('Direct-edit patch does not change the stored feature.');
  }
  part.features[index] = feature;
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function deleteStudioV5DirectEditFeature(project, featureId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId && entry.type === 'direct-edit');
  if (!feature) throw new Error('That direct-edit feature no longer exists.');
  const parameters = studioV5ParameterValues(candidate, part);
  assertStudioDirectEditPart(
    part,
    feature,
    'directEdit[' + feature.id + ']',
    (value) => evaluateStudioV5Expression(value, parameters),
  );
  const dependents = part.features.filter((entry) => entry.id !== feature.id && entry.inputRefs?.some((reference) =>
    reference.ownerKind === 'feature' && reference.ownerId === feature.id));
  if (dependents.length) {
    throw new Error(
      'Direct-edit feature is used by ' + dependents.map((entry) => entry.name).join(', ')
        + '. Delete or repair those dependents first.',
    );
  }
  part.features = part.features.filter((entry) => entry.id !== feature.id);
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

function datumRefsForTransform(transform) {
  return ['axisDatumId', 'planeDatumId', 'fromDatumId', 'toDatumId']
    .filter((key) => typeof transform?.[key] === 'string')
    .map((key) => ({ ownerKind: 'datum', ownerId: transform[key], semanticPath: { role: key }, signature: { kind: key.replace('DatumId', '') } }));
}

export function createStudioV5TransformFeature(project, options) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  requireUniquePartId(part, options.id, 'Transform feature');
  const source = part.bodies.find((body) => body.id === options.bodyId);
  if (!source) throw new Error('Choose an existing body to transform.');
  const transformInput = authoredOr(options, 'transform', {});
  if (!transformInput || typeof transformInput !== 'object' || Array.isArray(transformInput)) throw new Error('Transform must be an object.');
  const nestedMode = owns(transformInput, 'mode') ? transformInput.mode : undefined;
  const outerMode = owns(options, 'mode') ? options.mode : undefined;
  if (nestedMode !== undefined && outerMode !== undefined && nestedMode !== outerMode) throw new Error('Transform mode fields must match exactly.');
  const mode = nestedMode !== undefined ? nestedMode : outerMode;
  const copyRequested = optionalAuthoredBoolean(options, 'copy', false);
  const moveOriginal = optionalAuthoredBoolean(options, 'moveOriginal', false);
  if (mode !== 'mirror' && owns(options, 'moveOriginal')) throw new Error('moveOriginal is only meaningful for mirror mode.');
  if ((mode === 'move' || mode === 'translate') && copyRequested) throw new Error('Move and translate modes cannot create a copy; use copy mode.');
  if (mode === 'copy' && owns(options, 'copy') && !copyRequested) throw new Error('Copy mode cannot be combined with copy=false.');
  const createsCopy = copyRequested || mode === 'copy' || (mode === 'mirror' && !moveOriginal);
  const feature = {
    id: options.id,
    name: String(options.name || (mode === 'mirror' ? 'Mirror ' : createsCopy ? 'Copy ' : 'Transform ') + source.name).trim(),
    type: 'transform',
    operation: mode,
    transform: clone({ ...transformInput, mode }),
    sourceBodyId: source.id,
    toolBodyIds: createsCopy ? [source.id] : [],
    linked: createsCopy,
    suppressed: false,
    inputRefs: [
      { ownerKind: 'body', ownerId: source.id, semanticPath: { role: 'source' }, signature: { role: 'source' } },
      ...datumRefsForTransform(transformInput),
    ],
    resultPolicy: createsCopy
      ? { kind: 'new-body', bodyName: options.bodyName || (mode === 'mirror' ? source.name + ' mirror' : source.name + ' copy') }
      : { kind: 'add', targetBodyIds: [source.id] },
  };
  if (createsCopy) feature.createdBodyId = options.createdBodyId || 'body-' + feature.id;
  // Resolve before the feature enters history so invalid frames and cyclic
  // datums cannot create an undo entry or mutate the active document.
  resolveStudioV5Transform(candidate, part, feature);
  part.features.push(feature);
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function updateStudioV5TransformFeature(project, featureId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId && entry.type === 'transform');
  if (!feature) throw new Error('That transform feature no longer exists.');
  if (owns(patch, 'name')) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) throw new Error('Transform name is required.');
    feature.name = patch.name.trim();
  }
  if (owns(patch, 'transform')) {
    feature.transform = clone(patch.transform);
    if (!feature.transform || typeof feature.transform !== 'object' || Array.isArray(feature.transform)) throw new Error('Transform must be an object.');
    feature.operation = feature.transform.mode;
    feature.inputRefs = feature.inputRefs.filter((reference) => reference.ownerKind !== 'datum').concat(datumRefsForTransform(feature.transform));
  }
  if (owns(patch, 'suppressed')) {
    if (typeof patch.suppressed !== 'boolean') throw new Error('Transform suppressed must be true or false.');
    feature.suppressed = patch.suppressed;
  }
  resolveStudioV5Transform(candidate, part, feature);
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function reorderStudioV5Feature(project, featureId, beforeFeatureId = null) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const from = part.features.findIndex((feature) => feature.id === featureId);
  if (from < 0) throw new Error('That feature no longer exists.');
  const [feature] = part.features.splice(from, 1);
  const destination = beforeFeatureId == null ? part.features.length : part.features.findIndex((entry) => entry.id === beforeFeatureId);
  if (destination < 0) throw new Error('The target history position no longer exists.');
  part.features.splice(destination, 0, feature);
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function setStudioV5RollbackMarker(project, featureId = null) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  if (featureId != null && !part.features.some((feature) => feature.id === featureId)) throw new Error('That rollback feature no longer exists.');
  part.metadata = { ...(part.metadata || {}), rollbackFeatureId: featureId };
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function updateStudioV5Body(project, bodyId, patch) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const body = part.bodies.find((entry) => entry.id === bodyId);
  if (!body) throw new Error('That body no longer exists.');
  const beadFeature = part.features.find((entry) => entry.id === body.createdByFeatureId && isStudioWeldBeadFeature(entry));
  if (beadFeature && patch.suppressed != null) {
    throw new Error('Weld-bead bodies cannot be generically suppressed; use the typed weld-bead lifecycle.');
  }
  if (patch.name != null) {
    const name = String(patch.name).trim();
    if (!name || name.length > 200) throw new Error('Body names must contain 1 to 200 characters.');
    body.name = name;
  }
  if (patch.visible != null) body.visible = Boolean(patch.visible);
  if (patch.suppressed != null) body.suppressed = Boolean(patch.suppressed);
  if (patch.active === true) part.metadata = { ...(part.metadata || {}), activeBodyId: body.id };
  return prepareStudioV5RuntimeProject(candidate);
}

function studioStructuralMemberCutListUsers(project, memberId, bodyId) {
  const tables = project?.extensions?.drawingTables?.tables;
  if (!Array.isArray(tables)) return [];
  return tables.filter((table) => table?.kind === 'cut-list' && (
    (Array.isArray(table.sourceMemberIds) && table.sourceMemberIds.includes(memberId))
      || (Array.isArray(table.sourceBodyIds) && table.sourceBodyIds.includes(bodyId))
  ));
}

export function deleteStudioV5Body(project, bodyId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const sourceBody = part.bodies.find((body) => body.id === bodyId);
  if (!sourceBody) throw new Error('That body no longer exists.');
  const assemblyFeatureUsers = studioAssemblyFeatureBodyDependencies(candidate, part.id, bodyId);
  if (assemblyFeatureUsers.length) {
    throw new Error(
      'Body is targeted by assembly features '
        + assemblyFeatureUsers.map((entry) => entry.featureId).join(', ')
        + '. Delete or retarget those assembly features first.',
    );
  }
  const sourceBead = part.features.find((feature) =>
    feature.id === sourceBody.createdByFeatureId && isStudioWeldBeadFeature(feature));
  if (sourceBead) return deleteStudioWeldBead(candidate, sourceBead.id);
  const sourceMember = part.features.find((feature) =>
    feature.id === sourceBody.createdByFeatureId && feature.extensions?.structuralMember);
  const cutListUsers = sourceMember
    ? studioStructuralMemberCutListUsers(candidate, sourceMember.id, sourceBody.id)
    : [];
  if (cutListUsers.length) {
    throw new Error(
      'Structural-member body is used by drawing cut-list tables '
        + cutListUsers.map((entry) => entry.id).join(', ')
        + '. Delete or repair those tables first.',
    );
  }
  const treatmentUsers = sourceMember ? part.features.filter((feature) =>
    isStudioWeldmentTreatmentFeature(feature)
      && feature.inputRefs?.some((reference) =>
        reference.ownerKind === 'feature' && reference.ownerId === sourceMember.id)) : [];
  const beadUsers = sourceMember ? part.features.filter((feature) =>
    isStudioWeldBeadFeature(feature)
      && feature.inputRefs?.some((reference) =>
        reference.ownerKind === 'feature' && reference.ownerId === sourceMember.id)) : [];
  if (treatmentUsers.length && !beadUsers.length) {
    throw new Error(
      'Structural-member body is used by weldment treatments '
        + treatmentUsers.map((feature) => feature.name).join(', ')
        + '. Delete those treatments first.',
    );
  }
  if (beadUsers.length) {
    throw new Error(
      'Structural-member body is used by weld beads '
        + beadUsers.map((feature) => feature.name).join(', ')
        + (treatmentUsers.length
          ? ' and weldment treatments ' + treatmentUsers.map((feature) => feature.name).join(', ')
          : '')
        + '. Delete those weldment dependents first.',
    );
  }
  const removedFeatureIds = new Set();
  const removedBodyIds = new Set([bodyId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const feature of part.features) {
      if (removedFeatureIds.has(feature.id)) continue;
      const createsBody = removedBodyIds.has(feature.createdBodyId);
      const targetsBody = feature.resultPolicy?.targetBodyIds?.some((id) => removedBodyIds.has(id));
      const usesBody = feature.toolBodyIds?.some((id) => removedBodyIds.has(id)) || feature.inputRefs?.some((ref) => ref.ownerKind === 'body' && removedBodyIds.has(ref.ownerId));
      const usesRemovedFeature = feature.inputRefs?.some((ref) => ref.ownerKind === 'feature' && removedFeatureIds.has(ref.ownerId));
      if (createsBody || targetsBody || usesBody || usesRemovedFeature) {
        removedFeatureIds.add(feature.id);
        if (feature.createdBodyId) removedBodyIds.add(feature.createdBodyId);
        changed = true;
      }
    }
  }
  part.features = part.features.filter((feature) => !removedFeatureIds.has(feature.id));
  part.bodyPatterns = (part.bodyPatterns || []).filter((pattern) => !removedBodyIds.has(pattern.sourceBodyId));
  reconcileStudioV5Bodies(part);
  return decorateStudioV5Project(prepareStudioV5Project(candidate));
}

export function studioV5CanonicalHash(project) {
  return studioV5Sha256Hex(JSON.stringify(canonicalStudioV5Project(project)));
}
