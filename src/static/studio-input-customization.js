export const STUDIO_SHORTCUT_ACTIONS = Object.freeze([
  Object.freeze({ id: 'fit-view', label: 'Fit model', defaultBinding: 'f' }),
  Object.freeze({ id: 'selection-filter', label: 'Cycle selection filter', defaultBinding: 'f6' }),
  Object.freeze({ id: 'box-select', label: 'Box selection', defaultBinding: 'b' }),
  Object.freeze({ id: 'isolate', label: 'Isolate selection', defaultBinding: 'i' }),
  Object.freeze({ id: 'hide', label: 'Hide selection', defaultBinding: 'h' }),
  Object.freeze({ id: 'show-all', label: 'Show all', defaultBinding: 'shift+h' }),
  Object.freeze({ id: 'edit', label: 'Edit selection', defaultBinding: 'e' }),
  Object.freeze({ id: 'suppress', label: 'Suppress or restore', defaultBinding: 'shift+e' }),
  Object.freeze({ id: 'measure', label: 'Measure', defaultBinding: 'shift+m' }),
  Object.freeze({ id: 'section', label: 'Toggle section', defaultBinding: 'shift+s' }),
]);

export const STUDIO_SHORTCUT_CHOICES = Object.freeze([
  'b', 'e', 'f', 'f6', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'o', 'p', 'r', 's', 't', 'v',
  'shift+b', 'shift+e', 'shift+f', 'shift+g', 'shift+h', 'shift+i', 'shift+j',
  'shift+k', 'shift+l', 'shift+m', 'shift+o', 'shift+p', 'shift+r', 'shift+s',
  'shift+t', 'shift+v',
]);

const SHORTCUT_ACTION_IDS = new Set(STUDIO_SHORTCUT_ACTIONS.map((action) => action.id));
const SHORTCUT_CHOICES = new Set(STUDIO_SHORTCUT_CHOICES);

export function normalizeStudioShortcutChord(value) {
  if (typeof value !== 'string') return null;
  const compact = value.trim().toLowerCase().replaceAll(' ', '');
  return SHORTCUT_CHOICES.has(compact) ? compact : null;
}

export function defaultStudioShortcutBindings() {
  return Object.fromEntries(STUDIO_SHORTCUT_ACTIONS.map((action) => [action.id, action.defaultBinding]));
}

export function normalizeStudioShortcutBindings(value) {
  const defaults = defaultStudioShortcutBindings();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
  const normalized = {};
  const occupied = new Set();
  for (const action of STUDIO_SHORTCUT_ACTIONS) {
    const requested = normalizeStudioShortcutChord(value[action.id]);
    const binding = requested && !occupied.has(requested) ? requested : action.defaultBinding;
    if (occupied.has(binding)) return defaults;
    normalized[action.id] = binding;
    occupied.add(binding);
  }
  return normalized;
}

export function updateStudioShortcutBinding(bindings, actionId, value) {
  if (!SHORTCUT_ACTION_IDS.has(actionId)) throw new Error('Unknown shortcut action.');
  const binding = normalizeStudioShortcutChord(value);
  if (!binding) throw new Error('Unsupported shortcut binding.');
  const next = normalizeStudioShortcutBindings(bindings);
  const conflict = Object.entries(next).find(([id, chord]) => id !== actionId && chord === binding);
  if (!conflict) return { ...next, [actionId]: binding };
  return { ...next, [conflict[0]]: next[actionId], [actionId]: binding };
}

export function studioShortcutChordForEvent(event) {
  if (!event || event.metaKey || event.ctrlKey || event.altKey || typeof event.key !== 'string') return null;
  const key = event.key.toLowerCase();
  const base = /^f(?:[1-9]|1[0-2])$/.test(key) ? key : /^[a-z0-9]$/.test(key) ? key : null;
  if (!base) return null;
  return normalizeStudioShortcutChord((event.shiftKey ? 'shift+' : '') + base);
}

export function studioShortcutActionForEvent(event, bindings) {
  const chord = studioShortcutChordForEvent(event);
  if (!chord) return null;
  const normalized = normalizeStudioShortcutBindings(bindings);
  return Object.keys(normalized).find((actionId) => normalized[actionId] === chord) || null;
}

export const STUDIO_MOUSE_GESTURES = Object.freeze({
  north: 'isolate',
  east: 'edit',
  south: 'suppress',
  west: 'hide',
});

const finitePoint = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);

export function studioMouseGesture(start, end, deadzone = 28) {
  if (!finitePoint(start) || !finitePoint(end) || !Number.isFinite(deadzone) || deadzone < 0) {
    throw new Error('Mouse gesture requires finite screen points and a non-negative deadzone.');
  }
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const distance = Math.hypot(dx, dy);
  if (distance < deadzone) return null;
  const direction = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'east' : 'west') : (dy >= 0 ? 'south' : 'north');
  return { direction, action: STUDIO_MOUSE_GESTURES[direction], distance };
}

export function studioContextActions(scope = {}) {
  const actions = [];
  if (scope.feature || scope.mate) actions.push('edit');
  if (scope.feature || scope.mate || scope.body || scope.occurrence) actions.push('suppress');
  if (scope.body || scope.occurrence) actions.push('hide', 'isolate');
  actions.push('show-all', 'fit-view');
  return Object.freeze([...new Set(actions)]);
}
