import {
  canonicalStudioV5Project,
  studioV5RootAssembly,
  studioV5RootPart,
} from './studio-v5-runtime-document.js';

const EXTENSION_KEY = 'partmodeViewStates';
const SCHEMA = 'partmode.view-states/v1';
const MAX_STATES = 64;
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const DISPLAY_MODES = new Set(['shaded', 'shaded-edges', 'wireframe', 'hidden-line', 'ghost']);
const clone = (value) => JSON.parse(JSON.stringify(value));

function fail(message) {
  throw new Error(message);
}

function validId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || value.length > 200) fail(`${label} must be a stable ID.`);
  return value;
}

function validName(value, label) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 200) fail(`${label} must be between 1 and 200 characters.`);
  return name;
}

function finiteVector(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) fail(`${label} must contain three finite numbers.`);
  return [...value];
}

function vectorLength(value) {
  return Math.hypot(value[0], value[1], value[2]);
}

function cameraRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('View orientation camera is required.');
  const position = finiteVector(value.position, 'Camera position');
  const target = finiteVector(value.target, 'Camera target');
  const up = finiteVector(value.up, 'Camera up');
  const direction = position.map((entry, index) => entry - target[index]);
  if (vectorLength(direction) <= 1e-6) fail('Camera position and target must differ.');
  if (vectorLength(up) <= 1e-6) fail('Camera up must have a direction.');
  const cross = [
    direction[1] * up[2] - direction[2] * up[1],
    direction[2] * up[0] - direction[0] * up[2],
    direction[0] * up[1] - direction[1] * up[0],
  ];
  if (vectorLength(cross) <= 1e-6) fail('Camera up cannot be parallel to its view direction.');
  return { position, target, up };
}

function uniqueIds(value, label) {
  if (!Array.isArray(value) || value.length > 10000) fail(`${label} must be a bounded ID list.`);
  const ids = value.map((entry) => validId(entry, label));
  if (new Set(ids).size !== ids.length) fail(`${label} cannot repeat an ID.`);
  return [...ids].sort();
}

function orientationRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('View orientation record is required.');
  return {
    id: validId(value.id, 'View orientation ID'),
    name: validName(value.name, 'View orientation name'),
    camera: cameraRecord(value.camera),
  };
}

function displayStateRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Display state record is required.');
  const displayMode = value.displayMode || 'shaded';
  if (!DISPLAY_MODES.has(displayMode)) fail('Display state mode is unsupported.');
  return {
    id: validId(value.id, 'Display state ID'),
    name: validName(value.name, 'Display state name'),
    hiddenBodyIds: uniqueIds(value.hiddenBodyIds || [], 'Hidden body IDs'),
    hiddenOccurrenceIds: uniqueIds(value.hiddenOccurrenceIds || [], 'Hidden occurrence IDs'),
    ...(value.isolatedBodyId ? { isolatedBodyId: validId(value.isolatedBodyId, 'Isolated body ID') } : {}),
    ...(value.isolatedOccurrenceId ? { isolatedOccurrenceId: validId(value.isolatedOccurrenceId, 'Isolated occurrence ID') } : {}),
    displayMode,
  };
}

function emptyManager() {
  return { schema: SCHEMA, orientations: [], displayStates: [] };
}

function managerRecord(project) {
  const raw = project?.extensions?.[EXTENSION_KEY];
  if (raw === undefined) return emptyManager();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema !== SCHEMA) fail('View-state extension schema is unsupported.');
  if (!Array.isArray(raw.orientations) || raw.orientations.length > MAX_STATES) fail('View orientations exceed their bounded limit.');
  if (!Array.isArray(raw.displayStates) || raw.displayStates.length > MAX_STATES) fail('Display states exceed their bounded limit.');
  const orientations = raw.orientations.map(orientationRecord).sort((left, right) => left.id.localeCompare(right.id));
  const displayStates = raw.displayStates.map(displayStateRecord).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(orientations.map((entry) => entry.id)).size !== orientations.length) fail('View orientation IDs must be unique.');
  if (new Set(displayStates.map((entry) => entry.id)).size !== displayStates.length) fail('Display state IDs must be unique.');
  const manager = { schema: SCHEMA, orientations, displayStates };
  if (raw.activeOrientationId !== undefined) {
    manager.activeOrientationId = validId(raw.activeOrientationId, 'Active view orientation ID');
    if (!orientations.some((entry) => entry.id === manager.activeOrientationId)) fail('Active view orientation does not exist.');
  }
  if (raw.activeDisplayStateId !== undefined) {
    manager.activeDisplayStateId = validId(raw.activeDisplayStateId, 'Active display state ID');
    if (!displayStates.some((entry) => entry.id === manager.activeDisplayStateId)) fail('Active display state does not exist.');
  }
  return manager;
}

function writeManager(project, manager) {
  const candidate = canonicalStudioV5Project(project);
  candidate.extensions = { ...(candidate.extensions || {}), [EXTENSION_KEY]: clone(manager) };
  return canonicalStudioV5Project(candidate);
}

export function studioViewStateManager(project) {
  return clone(managerRecord(project));
}

export function saveStudioViewOrientation(project, input) {
  const manager = managerRecord(project);
  const record = orientationRecord(input);
  const index = manager.orientations.findIndex((entry) => entry.id === record.id);
  if (index < 0) {
    if (manager.orientations.length >= MAX_STATES) fail('View orientations exceed their bounded limit.');
    manager.orientations.push(record);
  } else manager.orientations[index] = record;
  manager.orientations.sort((left, right) => left.id.localeCompare(right.id));
  manager.activeOrientationId = record.id;
  return writeManager(project, manager);
}

export function activateStudioViewOrientation(project, orientationId) {
  const manager = managerRecord(project);
  const record = manager.orientations.find((entry) => entry.id === orientationId);
  if (!record) fail('That saved view orientation does not exist.');
  manager.activeOrientationId = record.id;
  return { project: writeManager(project, manager), orientation: clone(record) };
}

export function deleteStudioViewOrientation(project, orientationId) {
  const manager = managerRecord(project);
  if (!manager.orientations.some((entry) => entry.id === orientationId)) fail('That saved view orientation does not exist.');
  manager.orientations = manager.orientations.filter((entry) => entry.id !== orientationId);
  if (manager.activeOrientationId === orientationId) delete manager.activeOrientationId;
  return writeManager(project, manager);
}

export function saveStudioDisplayState(project, input) {
  const manager = managerRecord(project);
  const record = displayStateRecord(input);
  const index = manager.displayStates.findIndex((entry) => entry.id === record.id);
  if (index < 0) {
    if (manager.displayStates.length >= MAX_STATES) fail('Display states exceed their bounded limit.');
    manager.displayStates.push(record);
  } else manager.displayStates[index] = record;
  manager.displayStates.sort((left, right) => left.id.localeCompare(right.id));
  manager.activeDisplayStateId = record.id;
  return writeManager(project, manager);
}

export function activateStudioDisplayState(project, displayStateId) {
  const candidate = canonicalStudioV5Project(project);
  const manager = managerRecord(candidate);
  const state = manager.displayStates.find((entry) => entry.id === displayStateId);
  if (!state) fail('That saved display state does not exist.');
  if (candidate.rootDocument.kind === 'part') {
    if (state.hiddenOccurrenceIds.length || state.isolatedOccurrenceId) fail('A part display state cannot reference components.');
    const part = studioV5RootPart(candidate);
    const ids = new Set(part.bodies.map((entry) => entry.id));
    for (const id of [...state.hiddenBodyIds, ...(state.isolatedBodyId ? [state.isolatedBodyId] : [])]) {
      if (!ids.has(id)) fail(`Display state body "${id}" no longer exists.`);
    }
    const hidden = new Set(state.hiddenBodyIds);
    for (const body of part.bodies) body.visible = !hidden.has(body.id);
  } else {
    if (state.hiddenBodyIds.length || state.isolatedBodyId) fail('An assembly display state cannot reference part bodies directly.');
    const assembly = studioV5RootAssembly(candidate);
    const ids = new Set(assembly.occurrences.map((entry) => entry.id));
    for (const id of [...state.hiddenOccurrenceIds, ...(state.isolatedOccurrenceId ? [state.isolatedOccurrenceId] : [])]) {
      if (!ids.has(id)) fail(`Display state component "${id}" no longer exists.`);
    }
    const hidden = new Set(state.hiddenOccurrenceIds);
    for (const occurrence of assembly.occurrences) occurrence.visible = !hidden.has(occurrence.id);
    assembly.metadata = { ...(assembly.metadata || {}), displayMode: state.displayMode };
  }
  manager.activeDisplayStateId = state.id;
  return { project: writeManager(candidate, manager), displayState: clone(state) };
}

export function deleteStudioDisplayState(project, displayStateId) {
  const manager = managerRecord(project);
  if (!manager.displayStates.some((entry) => entry.id === displayStateId)) fail('That saved display state does not exist.');
  manager.displayStates = manager.displayStates.filter((entry) => entry.id !== displayStateId);
  if (manager.activeDisplayStateId === displayStateId) delete manager.activeDisplayStateId;
  return writeManager(project, manager);
}
