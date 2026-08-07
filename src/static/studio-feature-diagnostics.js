// Structured, source-owned feature diagnosis. This module never guesses at
// geometry: it explains the exact worker's error/warning records in document
// context and preserves the worker message as the authoritative cause.

export const STUDIO_FEATURE_DIAGNOSIS_SCHEMA = 'partmode.feature-diagnosis/v1';

const clone = (value) => JSON.parse(JSON.stringify(value));
const boundedText = (value, fallback = '', max = 600) => {
  const text = String(value ?? fallback).trim();
  return (text || fallback).slice(0, max);
};
const stableToken = (value) => boundedText(value, 'unknown', 160).replace(/[^A-Za-z0-9_.:-]+/g, '-');

function projectEntities(project) {
  const features = new Map();
  const bodies = new Map();
  const mates = new Map();
  const occurrences = new Map();
  const sketches = new Map();
  const parameters = new Map();
  for (const parameter of project?.parameters || []) parameters.set(parameter.name, parameter);
  for (const part of project?.partDefinitions || []) {
    for (const feature of part.features || []) features.set(feature.id, { ...feature, partId: part.id });
    for (const body of part.bodies || []) bodies.set(body.id, { ...body, partId: part.id });
    for (const sketch of part.sketches || []) sketches.set(sketch.id, { ...sketch, partId: part.id });
    for (const parameter of part.parameters || []) parameters.set(parameter.name, parameter);
  }
  for (const assembly of project?.assemblyDefinitions || []) {
    for (const mate of assembly.mates || []) mates.set(mate.id, { ...mate, assemblyId: assembly.id });
    for (const occurrence of assembly.occurrences || []) occurrences.set(occurrence.id, { ...occurrence, assemblyId: assembly.id });
  }
  return { features, bodies, mates, occurrences, sketches, parameters };
}

function entityFor(record, entities) {
  if (record.mateId) {
    const mate = entities.mates.get(record.mateId);
    return { kind: 'mate', id: record.mateId, label: mate?.name || record.mateId, type: mate?.type || 'mate' };
  }
  if (record.featureId) {
    const feature = entities.features.get(record.featureId);
    return { kind: 'feature', id: record.featureId, label: feature?.name || record.featureId, type: feature?.type || record.featureType || 'feature' };
  }
  if (record.bodyId) {
    const localBodyId = String(record.bodyId).includes(':') ? String(record.bodyId).split(':').at(-1) : record.bodyId;
    const body = entities.bodies.get(record.bodyId) || entities.bodies.get(localBodyId);
    return { kind: 'body', id: record.bodyId, label: body?.name || record.bodyId, type: body?.kind || record.featureType || 'body' };
  }
  return { kind: 'document', id: 'active-document', label: 'Active document', type: record.featureType || 'document' };
}

const valueLabels = Object.freeze({
  h: 'Height', r: 'Radius', t: 'Wall thickness', angle: 'Angle', thickness: 'Thickness', through: 'Through all',
  operation: 'Operation', side: 'Split side', orientation: 'Orientation', twistAngle: 'Twist angle',
});

function addInput(target, seen, input) {
  const key = input.kind + ':' + input.label + ':' + String(input.value ?? input.entity?.kind + ':' + input.entity?.id);
  if (seen.has(key) || target.length >= 16) return;
  seen.add(key);
  target.push(input);
}

function featureInputs(feature, entities) {
  if (!feature) return [];
  const inputs = [];
  const seen = new Set();
  for (const [key, label] of Object.entries(valueLabels)) {
    if (feature[key] !== undefined) {
      addInput(inputs, seen, { kind: 'value', label, value: clone(feature[key]) });
      if (typeof feature[key] === 'string') {
        for (const match of feature[key].matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
          const parameter = entities.parameters.get(match[0]);
          if (parameter) addInput(inputs, seen, { kind: 'value', label: 'Parameter ' + parameter.name, value: clone(parameter.value) });
        }
      }
    }
  }
  const reference = (label, kind, id) => {
    if (typeof id === 'string' && id) addInput(inputs, seen, { kind: 'reference', label, entity: { kind, id } });
  };
  reference('Source body', 'body', feature.sourceBodyId);
  reference('Profile sketch', 'sketch', feature.profileSketchId);
  reference('Path sketch', 'sketch', feature.pathSketchId);
  reference('Mirror plane', 'datum', feature.planeDatumId);
  for (const id of feature.sectionIds || []) reference('Section sketch', 'sketch', id);
  for (const id of feature.guideSketchIds || []) reference('Guide sketch', 'sketch', id);
  for (const id of feature.toolBodyIds || []) reference('Tool body', 'body', id);
  for (const id of feature.resultPolicy?.targetBodyIds || []) reference('Target body', 'body', id);
  for (const item of feature.inputRefs || []) reference(boundedText(item.signature?.role, 'Input reference', 80), item.ownerKind || 'entity', item.ownerId);
  if (Array.isArray(feature.faces)) addInput(inputs, seen, { kind: 'count', label: 'Selected faces', value: feature.faces.length });
  if (Array.isArray(feature.edges)) addInput(inputs, seen, { kind: 'count', label: 'Selected edges', value: feature.edges.length });
  if (feature.sketch?.shapes) addInput(inputs, seen, { kind: 'count', label: 'Profile shapes', value: feature.sketch.shapes.length });
  return inputs;
}

function mateInputs(mate) {
  if (!mate) return [];
  const inputs = [
    { kind: 'value', label: 'Mate type', value: mate.type },
    ...(mate.value !== undefined ? [{ kind: 'value', label: 'Mate value', value: clone(mate.value) }] : []),
  ];
  const ids = new Set();
  const collect = (value) => {
    if (typeof value === 'string' && value) ids.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => {
      if (/occurrenceId$/i.test(key)) collect(item);
    });
  };
  collect(mate);
  for (const id of ids) inputs.push({ kind: 'reference', label: 'Component', entity: { kind: 'occurrence', id } });
  return inputs.slice(0, 16);
}

function categoryFor(record, entity) {
  const code = boundedText(record.code, '', 160).toUpperCase();
  const message = boundedText(record.message, '', 800).toLowerCase();
  const type = boundedText(entity.type || record.featureType, '', 80).toLowerCase();
  if (record.severity === 'warning' || /NO_EFFECT/.test(code) || /nothing was|outside the body/.test(message)) return 'no-effect';
  if (code === 'ASSEMBLY_CONVERGENCE_FAILED' || /convergen|iteration limit/.test(message)) return 'assembly-convergence';
  if (record.mateId || type === 'mate' || /mate|constraint.*conflict|redundant/.test(message)) return 'assembly-constraint';
  if (/TOPOLOGY|REFERENCE|PERSISTENT_NAME/.test(code) || /no longer exist|missing .*reference|could not resolve|persistent name/.test(message)) return 'lost-reference';
  if (/_INVALID|EXPRESSION|PARAMETER/.test(code) || /must be|invalid|positive|finite|out of range|unsupported input/.test(message)) return 'invalid-input';
  if (/source body|tool body|target body/.test(message) && /no valid|missing|does not exist/.test(message)) return 'upstream-dependency';
  if (record.stage === 'serialization' || /SERIALIZATION/.test(code)) return 'exact-publication';
  if (type === 'fillet' || type === 'chamfer') return 'edge-modifier';
  if (type === 'shell' || type === 'thicken') return 'wall-thickness';
  if (type === 'loft' || type === 'sweep' || type === 'revolve') return 'profile-path';
  if (type === 'boolean' || /boolean|intersect|subtract|union/.test(message)) return 'boolean-operation';
  if (type === 'pattern') return 'pattern-operation';
  return 'kernel-rebuild';
}

function guidance(category, entity) {
  const authoredType = boundedText(entity.type, 'feature', 80).replaceAll('-', ' ');
  const type = authoredType.charAt(0).toUpperCase() + authoredType.slice(1);
  const table = {
    'assembly-convergence': {
      headline: 'Assembly constraints did not converge',
      suggestions: ['Inspect the reported mate conflict set.', 'Suppress or edit the most recently added mate, then rebuild.', 'Remove duplicate constraints before adding another degree-of-freedom lock.'],
    },
    'assembly-constraint': {
      headline: 'A mate constraint is inconsistent',
      suggestions: ['Inspect the mate references and their current component geometry.', 'Suppress this mate to confirm the rest of the assembly solves.', 'Remove redundant or contradictory mates before rebuilding.'],
    },
    'lost-reference': {
      headline: 'A referenced entity can no longer be resolved',
      suggestions: ['Edit the feature and reselect the missing face, edge, sketch, datum, or body.', 'Repair the earliest failed upstream feature before this one.', 'Avoid accepting a replacement unless its persistent identity is unambiguous.'],
    },
    'invalid-input': {
      headline: type + ' has an invalid authored input',
      suggestions: ['Edit the highlighted values and use finite values inside the allowed range.', 'Check parameter expressions and units used by this feature.', 'Preview the repaired feature before applying it.'],
    },
    'upstream-dependency': {
      headline: type + ' is blocked by an upstream body',
      suggestions: ['Repair the source or tool body named in the exact kernel message first.', 'Confirm referenced bodies are unsuppressed and still produce valid solids.', 'Rebuild this feature after the upstream body is healthy.'],
    },
    'edge-modifier': {
      headline: type + ' could not produce a valid exact solid',
      suggestions: ['Try a smaller radius or distance.', 'Repair or reselect edges whose persistent references changed.', 'Move the modifier earlier in history if later geometry interrupts the selected chain.'],
    },
    'wall-thickness': {
      headline: type + ' could not produce valid walls',
      suggestions: ['Try a smaller wall thickness.', 'Reselect opening faces that still exist on the current body.', 'Apply the operation earlier in history before narrow details are added.'],
    },
    'profile-path': {
      headline: type + ' could not build from its profiles or path',
      suggestions: ['Check that required profiles are closed and non-self-intersecting.', 'Confirm the path meets the profile at the intended endpoint.', 'Remove duplicate or degenerate sections and rebuild.'],
    },
    'boolean-operation': {
      headline: 'Boolean inputs did not produce the requested result',
      suggestions: ['Confirm target and tool bodies are valid, visible exact solids.', 'Check that subtract/intersect bodies overlap.', 'Repair any earlier body failure before retrying the Boolean.'],
    },
    'pattern-operation': {
      headline: 'Pattern instances could not be generated',
      suggestions: ['Check count, spacing, angles, or curve parameters.', 'Confirm the source body remains valid and unsuppressed.', 'Reduce the instance set to isolate the first failing placement.'],
    },
    'exact-publication': {
      headline: 'Exact topology could not be published safely',
      suggestions: ['Repair the named feature or body before export.', 'Inspect topology diagnostics for an unnamed or ambiguous entity.', 'Do not use the displayed result as exact geometry until rebuild succeeds.'],
    },
    'no-effect': {
      headline: type + ' rebuilt but has no geometric effect',
      suggestions: ['Edit its placement or dimensions so it intersects the target body.', 'Suppress or delete the feature if the no-op is intentional.', 'Check pattern instances that fall outside the body.'],
    },
    'kernel-rebuild': {
      headline: type + ' could not rebuild',
      suggestions: ['Use the exact kernel message below as the repair boundary.', 'Edit this feature or repair the earliest failed upstream feature.', 'Undo the last edit if the intended inputs are no longer recoverable.'],
    },
  };
  return table[category];
}

function nestedDetails(record) {
  const details = [];
  for (const item of Array.isArray(record.diagnostics) ? record.diagnostics : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    details.push({
      code: boundedText(item.code, 'DETAIL', 160),
      severity: item.severity === 'warning' ? 'warning' : 'error',
      message: boundedText(item.message, 'No additional message.', 600),
    });
    if (details.length === 12) break;
  }
  return details;
}

function diagnosis(record, severity, index, entities) {
  const entity = entityFor(record, entities);
  const normalized = { ...record, severity };
  const category = categoryFor(normalized, entity);
  const guide = guidance(category, entity);
  const feature = entity.kind === 'feature' ? entities.features.get(entity.id) : null;
  const mate = entity.kind === 'mate' ? entities.mates.get(entity.id) : null;
  const code = boundedText(record.code, severity === 'warning' ? 'KERNEL_WARNING' : 'KERNEL_REBUILD_FAILED', 160);
  const inputs = featureInputs(feature, entities);
  if (mate) inputs.push(...mateInputs(mate));
  const conflictSet = Array.isArray(record.conflictSet)
    ? record.conflictSet.filter((id) => typeof id === 'string').slice(0, 30)
    : [];
  for (const mateId of conflictSet) inputs.push({ kind: 'reference', label: 'Conflict mate', entity: { kind: 'mate', id: mateId } });
  return {
    schema: STUDIO_FEATURE_DIAGNOSIS_SCHEMA,
    id: [severity, entity.kind, stableToken(entity.id), stableToken(code), index].join(':'),
    severity,
    category,
    code,
    stage: boundedText(record.stage, 'rebuild', 80),
    entity,
    headline: guide.headline,
    explanation: boundedText(record.message, 'The exact kernel did not provide a message.', 800),
    inputs: inputs.slice(0, 16),
    suggestions: guide.suggestions,
    details: nestedDetails(record),
    actions: [
      ...(entity.kind !== 'document' ? [{ kind: 'select', entity: { kind: entity.kind, id: entity.id } }] : []),
      ...((entity.kind === 'feature' && !['boolean', 'boolean-split-side', 'imported-step'].includes(feature?.type)) || entity.kind === 'mate'
        ? [{ kind: 'edit', entity: { kind: entity.kind, id: entity.id } }]
        : []),
      { kind: 'undo' },
    ],
  };
}

export function diagnoseStudioProject(project, input = {}) {
  const errors = Array.isArray(input.errors) ? input.errors : [];
  const warnings = Array.isArray(input.warnings) ? input.warnings : [];
  const pending = input.pending === true;
  const entities = projectEntities(project);
  const diagnoses = [
    ...errors.map((record, index) => diagnosis(record || {}, 'error', index, entities)),
    ...warnings.map((record, index) => diagnosis(record || {}, 'warning', index, entities)),
  ];
  return {
    schema: STUDIO_FEATURE_DIAGNOSIS_SCHEMA,
    status: errors.length ? 'failed' : pending ? 'checking' : warnings.length ? 'warning' : 'healthy',
    summary: { errors: errors.length, warnings: warnings.length, total: diagnoses.length },
    diagnoses,
  };
}
