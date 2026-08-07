export const STUDIO_SELECTION_FILTERS = Object.freeze(['auto', 'component', 'body', 'face', 'edge', 'vertex']);

const finitePoint = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);

export function normalizeStudioSelectionFilter(value) {
  return STUDIO_SELECTION_FILTERS.includes(value) ? value : 'auto';
}

export function nextStudioSelectionFilter(value) {
  const current = normalizeStudioSelectionFilter(value);
  return STUDIO_SELECTION_FILTERS[(STUDIO_SELECTION_FILTERS.indexOf(current) + 1) % STUDIO_SELECTION_FILTERS.length];
}

export function studioSelectionBounds(points) {
  if (!Array.isArray(points) || !points.length || points.some((point) => !finitePoint(point))) {
    throw new Error('Selection bounds require one or more finite screen points.');
  }
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

function normalizedDrag(start, end) {
  if (!finitePoint(start) || !finitePoint(end)) throw new Error('Selection drag requires finite start and end points.');
  return {
    mode: end[0] >= start[0] ? 'window' : 'crossing',
    bounds: studioSelectionBounds([start, end]),
  };
}

function validCandidate(candidate) {
  return candidate && typeof candidate.key === 'string' && candidate.key
    && candidate.bounds && ['left', 'top', 'right', 'bottom'].every((key) => Number.isFinite(candidate.bounds[key]));
}

export function studioBoxSelection(start, end, candidates) {
  const drag = normalizedDrag(start, end);
  const unique = new Map();
  for (const candidate of candidates || []) {
    if (!validCandidate(candidate) || unique.has(candidate.key)) continue;
    const bounds = candidate.bounds;
    const matches = drag.mode === 'window'
      ? bounds.left >= drag.bounds.left && bounds.right <= drag.bounds.right
        && bounds.top >= drag.bounds.top && bounds.bottom <= drag.bounds.bottom
      : bounds.right >= drag.bounds.left && bounds.left <= drag.bounds.right
        && bounds.bottom >= drag.bounds.top && bounds.top <= drag.bounds.bottom;
    if (matches) unique.set(candidate.key, candidate);
  }
  return { mode: drag.mode, bounds: drag.bounds, matches: [...unique.values()].sort((left, right) => left.key.localeCompare(right.key)) };
}

export function studioSelectOther(candidates, currentKey = null) {
  const unique = new Map();
  for (const candidate of candidates || []) {
    if (!candidate || typeof candidate.key !== 'string' || !candidate.key || unique.has(candidate.key)) continue;
    unique.set(candidate.key, candidate);
  }
  const ordered = [...unique.values()].sort((left, right) => {
    const depth = (Number(left.depth) || 0) - (Number(right.depth) || 0);
    return depth || left.key.localeCompare(right.key);
  });
  if (!ordered.length) return { candidate: null, index: -1, count: 0 };
  const currentIndex = ordered.findIndex((candidate) => candidate.key === currentKey);
  const index = (currentIndex + 1) % ordered.length;
  return { candidate: ordered[index], index, count: ordered.length };
}
