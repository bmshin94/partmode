import { canonicalStudioV5Project } from './studio-v5-runtime-document.js';

export const STUDIO_DRAWING_STANDARDS_SCHEMA = 'partmode.drawing-standards/v1';
export const STUDIO_DRAWING_STANDARD_PROFILES = Object.freeze([
  Object.freeze({ id: 'iso', name: 'ISO drawing profile', family: 'ISO 128 / ISO 5457' }),
  Object.freeze({ id: 'ansi', name: 'ANSI drawing profile', family: 'ASME Y14 drawing practice' }),
  Object.freeze({ id: 'din', name: 'DIN drawing profile', family: 'DIN ISO drawing practice' }),
]);
export const STUDIO_DRAWING_LAYER_ROLES = Object.freeze([
  'border', 'visible', 'hidden', 'tangent', 'dimensions', 'annotations', 'tables',
]);

const clone = (value) => structuredClone(value);
const NAME = /^[^\u0000-\u001f]{1,120}$/u;
const profiles = new Map(STUDIO_DRAWING_STANDARD_PROFILES.map((entry) => [entry.id, entry]));

const PROFILE_LINE_FONTS = Object.freeze({
  iso: Object.freeze({
    border: [0.5, [], [0.11, 0.15, 0.2]], visible: [0.35, [], [0.11, 0.15, 0.2]], hidden: [0.18, [1.8, 1.2], [0.11, 0.15, 0.2]],
    tangent: [0.16, [3, 1, 0.6, 1], [0.11, 0.15, 0.2]], dimensions: [0.25, [], [0.19, 0.33, 0.48]],
    annotations: [0.25, [], [0.19, 0.33, 0.48]], tables: [0.25, [], [0.11, 0.15, 0.2]],
  }),
  ansi: Object.freeze({
    border: [0.6, [], [0.08, 0.1, 0.14]], visible: [0.5, [], [0.08, 0.1, 0.14]], hidden: [0.25, [3, 1.5], [0.08, 0.1, 0.14]],
    tangent: [0.25, [6, 1.5, 1, 1.5], [0.08, 0.1, 0.14]], dimensions: [0.25, [], [0.16, 0.28, 0.42]],
    annotations: [0.25, [], [0.16, 0.28, 0.42]], tables: [0.25, [], [0.08, 0.1, 0.14]],
  }),
  din: Object.freeze({
    border: [0.7, [], [0.06, 0.09, 0.12]], visible: [0.5, [], [0.06, 0.09, 0.12]], hidden: [0.25, [4, 2], [0.06, 0.09, 0.12]],
    tangent: [0.25, [8, 2, 1, 2], [0.06, 0.09, 0.12]], dimensions: [0.25, [], [0.14, 0.25, 0.38]],
    annotations: [0.25, [], [0.14, 0.25, 0.38]], tables: [0.25, [], [0.06, 0.09, 0.12]],
  }),
});

export class StudioDrawingStandardsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioDrawingStandardsError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new StudioDrawingStandardsError(code, message, details);
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || !NAME.test(value.trim())) {
    fail('DRAWING_STANDARD_INPUT_INVALID', `${label} must be non-empty bounded text.`);
  }
  return value.trim();
}

function profileId(value) {
  const id = String(value || '');
  if (!profiles.has(id)) fail('DRAWING_STANDARD_PROFILE_NOT_FOUND', `Drawing standard profile "${id}" does not exist.`);
  return id;
}

function color(value) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => !Number.isFinite(Number(entry)) || Number(entry) < 0 || Number(entry) > 1)) {
    fail('DRAWING_STANDARD_INPUT_INVALID', 'Line-font color must contain three finite values from 0 through 1.');
  }
  return value.map((entry) => Math.round(Number(entry) * 1000) / 1000);
}

function dash(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 8 || value.length % 2 !== 0
    || value.some((entry) => !Number.isFinite(Number(entry)) || Number(entry) <= 0 || Number(entry) > 100)) {
    fail('DRAWING_STANDARD_INPUT_INVALID', 'Line-font dash pattern must contain zero to eight positive millimetre lengths in on/off pairs.');
  }
  return value.map((entry) => Math.round(Number(entry) * 1000) / 1000);
}

function lineFontRecord(value, id = value?.id) {
  const widthMm = Number(value?.widthMm);
  if (!Number.isFinite(widthMm) || widthMm < 0.05 || widthMm > 2) {
    fail('DRAWING_STANDARD_INPUT_INVALID', 'Line-font width must be between 0.05 and 2 millimetres.');
  }
  return {
    id: String(id || ''),
    name: text(value?.name, 'Line-font name'),
    widthMm: Math.round(widthMm * 1000) / 1000,
    dashMm: dash(value?.dashMm),
    color: color(value?.color),
  };
}

function builtInLineFonts(id) {
  const resolved = profileId(id);
  return Object.fromEntries(STUDIO_DRAWING_LAYER_ROLES.map((role) => {
    const [widthMm, dashMm, fontColor] = PROFILE_LINE_FONTS[resolved][role];
    return [role, {
      id: `${resolved}-${role}`, name: `${profiles.get(resolved).name} ${role}`,
      widthMm, dashMm: [...dashMm], color: [...fontColor], builtIn: true, profileId: resolved,
    }];
  }));
}

function defaultLayers(id) {
  return STUDIO_DRAWING_LAYER_ROLES.map((role) => ({ id: role, visible: true, printable: true, lineFontId: `${id}-${role}` }));
}

function emptyGraph() {
  return { schema: STUDIO_DRAWING_STANDARDS_SCHEMA, sequence: 0, lineFonts: [], sheets: [] };
}

function validateGraph(value, book = null) {
  if (value == null) return emptyGraph();
  if (!value || typeof value !== 'object' || value.schema !== STUDIO_DRAWING_STANDARDS_SCHEMA
    || !Number.isInteger(value.sequence) || value.sequence < 0 || !Array.isArray(value.lineFonts) || value.lineFonts.length > 100
    || !Array.isArray(value.sheets) || value.sheets.length > 20) {
    fail('DRAWING_STANDARDS_INVALID', 'Drawing standards graph is invalid.');
  }
  const graph = clone(value);
  const fontIds = new Set();
  const fontNames = new Set();
  let maximumSequence = 0;
  for (const source of graph.lineFonts) {
    if (!/^line-font-\d{6}$/u.test(source?.id || '') || fontIds.has(source.id)) fail('DRAWING_STANDARDS_INVALID', 'Custom line-font ids are missing or duplicated.');
    const font = lineFontRecord(source, source.id);
    const folded = font.name.toLowerCase();
    if (fontNames.has(folded)) fail('DRAWING_STANDARDS_INVALID', 'Custom line-font names must be unique.');
    Object.assign(source, font);
    maximumSequence = Math.max(maximumSequence, Number(source.id.slice('line-font-'.length)));
    fontIds.add(source.id);
    fontNames.add(folded);
  }
  if (graph.sequence < maximumSequence) fail('DRAWING_STANDARDS_INVALID', 'Line-font sequence can collide with an existing id.');
  const knownSheets = new Set((book?.sheets || []).map((entry) => entry.id));
  const sheetIds = new Set();
  for (const style of graph.sheets) {
    if (!/^sheet-\d{6}$/u.test(style?.sheetId || '') || sheetIds.has(style.sheetId) || (book && !knownSheets.has(style.sheetId))) {
      fail('DRAWING_STANDARDS_INVALID', 'Drawing layer state references a missing or duplicated sheet.');
    }
    style.profileId = profileId(style.profileId);
    if (!Array.isArray(style.layers) || style.layers.length !== STUDIO_DRAWING_LAYER_ROLES.length) fail('DRAWING_STANDARDS_INVALID', 'Each styled sheet must contain every drawing layer exactly once.');
    const roles = new Set();
    for (const layer of style.layers) {
      if (!STUDIO_DRAWING_LAYER_ROLES.includes(layer?.id) || roles.has(layer.id) || typeof layer.visible !== 'boolean' || typeof layer.printable !== 'boolean') {
        fail('DRAWING_STANDARDS_INVALID', 'Drawing layers require unique supported ids and explicit visibility/print state.');
      }
      const builtIns = new Set(Object.keys(PROFILE_LINE_FONTS).flatMap((id) => STUDIO_DRAWING_LAYER_ROLES.map((role) => `${id}-${role}`)));
      if (!builtIns.has(layer.lineFontId) && !fontIds.has(layer.lineFontId)) fail('DRAWING_STANDARDS_INVALID', `Drawing layer "${layer.id}" references a missing line font.`);
      roles.add(layer.id);
    }
    sheetIds.add(style.sheetId);
  }
  return graph;
}

function drawingBook(project) {
  const book = project?.extensions?.drawingBook;
  if (!book || book.schema !== 'partmode.drawing-book/v1' || !Array.isArray(book.sheets)) {
    fail('DRAWING_BOOK_NOT_INITIALIZED', 'A drawing book is required before editing drawing standards.');
  }
  return book;
}

function from(project) {
  return validateGraph(project?.extensions?.drawingStandards, project?.extensions?.drawingBook || null);
}

function attach(project, graph) {
  const candidate = canonicalStudioV5Project(project);
  candidate.extensions = { ...(candidate.extensions || {}), drawingStandards: validateGraph(graph, candidate.extensions?.drawingBook || null) };
  return canonicalStudioV5Project(candidate);
}

function sheet(book, sheetId) {
  const result = book.sheets.find((entry) => entry.id === sheetId);
  if (!result) fail('DRAWING_SHEET_NOT_FOUND', 'Requested drawing sheet does not exist.');
  return result;
}

function derivedProfile(sheetRecord) {
  const standard = String(sheetRecord?.format?.standard || '').toLowerCase();
  if (standard.includes('ansi') || standard.includes('asme')) return 'ansi';
  if (standard.includes('din')) return 'din';
  return 'iso';
}

function ensureStyle(graph, book, sheetId) {
  const sheetRecord = sheet(book, sheetId);
  let style = graph.sheets.find((entry) => entry.sheetId === sheetId);
  if (!style) {
    const resolvedProfile = derivedProfile(sheetRecord);
    style = { sheetId, profileId: resolvedProfile, layers: defaultLayers(resolvedProfile) };
    graph.sheets.push(style);
  }
  return style;
}

function knownLineFonts(graph) {
  return new Map([
    ...Object.keys(PROFILE_LINE_FONTS).flatMap((id) => Object.values(builtInLineFonts(id)).map((font) => [font.id, font])),
    ...graph.lineFonts.map((font) => [font.id, { ...font, builtIn: false }]),
  ]);
}

export function inspectStudioDrawingStandards(project) {
  return from(project);
}

export function resolveStudioDrawingSheetStyle(book, standards, sheetId) {
  if (!book || book.schema !== 'partmode.drawing-book/v1' || !Array.isArray(book.sheets)) fail('DRAWING_BOOK_NOT_INITIALIZED', 'A drawing book is required to resolve drawing standards.');
  const graph = validateGraph(standards, book);
  const sheetRecord = sheet(book, sheetId);
  const authored = graph.sheets.find((entry) => entry.sheetId === sheetId);
  const resolvedProfile = authored?.profileId || derivedProfile(sheetRecord);
  const layerRecords = authored?.layers || defaultLayers(resolvedProfile);
  const fonts = knownLineFonts(graph);
  return {
    schema: 'partmode.drawing-style-resolved/v1',
    sheetId,
    profile: clone(profiles.get(resolvedProfile)),
    layers: layerRecords.map((layer) => {
      const lineFont = fonts.get(layer.lineFontId);
      if (!lineFont) fail('DRAWING_STANDARDS_INVALID', `Drawing layer "${layer.id}" references a missing line font.`);
      return { ...clone(layer), lineFont: clone(lineFont) };
    }),
  };
}

export function defaultStudioDrawingStyle(profile = 'iso') {
  const id = profileId(profile);
  const book = { schema: 'partmode.drawing-book/v1', sheets: [{ id: 'sheet-000001', format: { standard: id.toUpperCase() } }] };
  return resolveStudioDrawingSheetStyle(book, null, 'sheet-000001');
}

export function applyStudioDrawingStandardProfile(project, input = {}) {
  const book = drawingBook(project);
  const graph = from(project);
  const style = ensureStyle(graph, book, String(input.sheetId || ''));
  style.profileId = profileId(input.profileId);
  style.layers = defaultLayers(style.profileId);
  return attach(project, graph);
}

export function updateStudioDrawingLayer(project, input = {}) {
  const book = drawingBook(project);
  const graph = from(project);
  const style = ensureStyle(graph, book, String(input.sheetId || ''));
  const layer = style.layers.find((entry) => entry.id === input.layerId);
  if (!layer) fail('DRAWING_LAYER_NOT_FOUND', 'Requested drawing layer does not exist.');
  const patch = input.patch && typeof input.patch === 'object' ? input.patch : {};
  const unknown = Object.keys(patch).filter((key) => !['visible', 'printable', 'lineFontId'].includes(key));
  if (unknown.length) fail('DRAWING_STANDARD_INPUT_INVALID', 'Drawing-layer patch contains unsupported fields.', { unknown });
  if (patch.visible != null) {
    if (typeof patch.visible !== 'boolean') fail('DRAWING_STANDARD_INPUT_INVALID', 'Drawing-layer visibility must be boolean.');
    layer.visible = patch.visible;
  }
  if (patch.printable != null) {
    if (typeof patch.printable !== 'boolean') fail('DRAWING_STANDARD_INPUT_INVALID', 'Drawing-layer print state must be boolean.');
    layer.printable = patch.printable;
  }
  if (patch.lineFontId != null) {
    const fontId = String(patch.lineFontId);
    if (!knownLineFonts(graph).has(fontId)) fail('DRAWING_LINE_FONT_NOT_FOUND', 'Requested drawing line font does not exist.');
    layer.lineFontId = fontId;
  }
  return attach(project, graph);
}

export function createStudioDrawingLineFont(project, input = {}) {
  drawingBook(project);
  const graph = from(project);
  if (graph.lineFonts.length >= 100) fail('DRAWING_LINE_FONT_LIMIT_EXCEEDED', 'A project supports at most 100 custom line fonts.');
  const name = text(input.name, 'Line-font name');
  if (graph.lineFonts.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) fail('DRAWING_LINE_FONT_EXISTS', `Line font "${name}" already exists.`);
  const id = `line-font-${String(++graph.sequence).padStart(6, '0')}`;
  graph.lineFonts.push(lineFontRecord({ ...input, name }, id));
  return attach(project, graph);
}

export function updateStudioDrawingLineFont(project, input = {}) {
  const graph = from(project);
  const font = graph.lineFonts.find((entry) => entry.id === input.lineFontId);
  if (!font) fail('DRAWING_LINE_FONT_NOT_FOUND', 'Requested custom line font does not exist.');
  const patch = input.patch && typeof input.patch === 'object' ? input.patch : {};
  const unknown = Object.keys(patch).filter((key) => !['name', 'widthMm', 'dashMm', 'color'].includes(key));
  if (unknown.length) fail('DRAWING_STANDARD_INPUT_INVALID', 'Line-font patch contains unsupported fields.', { unknown });
  const next = lineFontRecord({ ...font, ...patch }, font.id);
  if (graph.lineFonts.some((entry) => entry.id !== font.id && entry.name.toLowerCase() === next.name.toLowerCase())) fail('DRAWING_LINE_FONT_EXISTS', `Line font "${next.name}" already exists.`);
  Object.assign(font, next);
  return attach(project, graph);
}

export function deleteStudioDrawingLineFont(project, lineFontId) {
  const graph = from(project);
  const index = graph.lineFonts.findIndex((entry) => entry.id === lineFontId);
  if (index < 0) fail('DRAWING_LINE_FONT_NOT_FOUND', 'Requested custom line font does not exist.');
  const users = graph.sheets.flatMap((style) => style.layers.filter((layer) => layer.lineFontId === lineFontId).map((layer) => ({ sheetId: style.sheetId, layerId: layer.id })));
  if (users.length) fail('DRAWING_LINE_FONT_IN_USE', 'Custom line font is assigned to one or more drawing layers.', { users });
  graph.lineFonts.splice(index, 1);
  return attach(project, graph);
}
