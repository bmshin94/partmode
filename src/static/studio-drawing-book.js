import { canonicalStudioV5Project } from './studio-v5-runtime-document.js';
import { STUDIO_STANDARD_DRAWING_VIEWS, STUDIO_TANGENT_EDGE_MODES, studioDrawingViewIds } from './studio-drawing-views.js';

export const STUDIO_DRAWING_BOOK_SCHEMA = 'partmode.drawing-book/v1';
export const STUDIO_DRAWING_VIEWS = STUDIO_STANDARD_DRAWING_VIEWS;
export const STUDIO_DRAWING_STANDARD_SCALES = Object.freeze([10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01]);
export const STUDIO_DRAWING_SHEET_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'iso-a4-landscape', name: 'ISO A4 landscape', standard: 'ISO', size: 'A4', widthMm: 297, heightMm: 210, projection: 'third-angle', titleBlock: 'iso-default' }),
  Object.freeze({ id: 'iso-a3-landscape', name: 'ISO A3 landscape', standard: 'ISO', size: 'A3', widthMm: 420, heightMm: 297, projection: 'third-angle', titleBlock: 'iso-default' }),
  Object.freeze({ id: 'iso-a2-landscape', name: 'ISO A2 landscape', standard: 'ISO', size: 'A2', widthMm: 594, heightMm: 420, projection: 'third-angle', titleBlock: 'iso-default' }),
  Object.freeze({ id: 'ansi-a-landscape', name: 'ANSI A landscape', standard: 'ANSI', size: 'A', widthMm: 279.4, heightMm: 215.9, projection: 'third-angle', titleBlock: 'ansi-default' }),
  Object.freeze({ id: 'ansi-b-landscape', name: 'ANSI B landscape', standard: 'ANSI', size: 'B', widthMm: 431.8, heightMm: 279.4, projection: 'third-angle', titleBlock: 'ansi-default' }),
  Object.freeze({ id: 'din-a4-landscape', name: 'DIN A4 landscape', standard: 'DIN', size: 'A4', widthMm: 297, heightMm: 210, projection: 'third-angle', titleBlock: 'din-default' }),
  Object.freeze({ id: 'din-a3-landscape', name: 'DIN A3 landscape', standard: 'DIN', size: 'A3', widthMm: 420, heightMm: 297, projection: 'third-angle', titleBlock: 'din-default' }),
]);

const clone = (value) => structuredClone(value);
const templates = new Map(STUDIO_DRAWING_SHEET_TEMPLATES.map((entry) => [entry.id, entry]));
const NAME = /^[^\u0000-\u001f]{1,120}$/u;

export class StudioDrawingBookError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioDrawingBookError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new StudioDrawingBookError(code, message, details);
}

function text(value, label, maximum = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || !NAME.test(value.trim())) {
    fail('DRAWING_BOOK_INPUT_INVALID', `${label} must be non-empty bounded text.`);
  }
  return value.trim();
}

function dimension(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 100 || number > 2_000) {
    fail('DRAWING_BOOK_INPUT_INVALID', `${label} must be between 100 and 2,000 millimetres.`);
  }
  return Math.round(number * 1000) / 1000;
}

function scale(value) {
  if (value == null || value === 'fit') return 'fit';
  const number = Number(value);
  if (!STUDIO_DRAWING_STANDARD_SCALES.includes(number)) fail('DRAWING_BOOK_INPUT_INVALID', 'Sheet scale must be Fit or a supported standard scale.');
  return number;
}

function views(value, namedViewIds = new Set()) {
  if (!Array.isArray(value) || !value.length || value.length > 16) {
    fail('DRAWING_BOOK_INPUT_INVALID', 'A sheet requires 1 to 16 drawing views.');
  }
  const result = value.map(String);
  if (new Set(result).size !== result.length || result.some((entry) => !STUDIO_DRAWING_VIEWS.includes(entry) && !namedViewIds.has(entry))) {
    fail('DRAWING_BOOK_INPUT_INVALID', 'Sheet views must be unique supported drawing views.');
  }
  return result;
}

function tangentEdges(value) {
  const mode = value == null ? 'visible' : String(value);
  if (!STUDIO_TANGENT_EDGE_MODES.includes(mode)) fail('DRAWING_BOOK_INPUT_INVALID', 'Tangent-edge display must be visible, removed, or phantom.');
  return mode;
}

function alignments(value, sheetViews) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > Math.max(0, sheetViews.length - 1)) fail('DRAWING_BOOK_INPUT_INVALID', 'View alignments must form a bounded sheet graph.');
  const viewIds = new Set(sheetViews);
  const children = new Set();
  const parentAxes = new Set();
  const result = value.map((entry) => {
    const parentView = String(entry?.parentView || '');
    const childView = String(entry?.childView || '');
    const axis = String(entry?.axis || '');
    const gapMm = entry?.gapMm == null ? 12 : Number(entry.gapMm);
    const parentAxis = `${parentView}:${axis}`;
    if (!viewIds.has(parentView) || !viewIds.has(childView) || parentView === childView || children.has(childView) || parentAxes.has(parentAxis)
      || !['horizontal', 'vertical'].includes(axis) || !Number.isFinite(gapMm) || gapMm < 2 || gapMm > 100) {
      fail('DRAWING_BOOK_INPUT_INVALID', 'Each view alignment requires distinct sheet views, one parent per child, a valid axis, and a 2 to 100 millimetre gap.');
    }
    children.add(childView);
    parentAxes.add(parentAxis);
    return { parentView, childView, axis, gapMm: Math.round(gapMm * 1000) / 1000 };
  });
  const parents = new Map(result.map((entry) => [entry.childView, entry.parentView]));
  for (const view of sheetViews) {
    const seen = new Set();
    let current = view;
    while (parents.has(current)) {
      if (seen.has(current)) fail('DRAWING_BOOK_INPUT_INVALID', 'View alignments cannot contain a cycle.');
      seen.add(current);
      current = parents.get(current);
    }
  }
  return result;
}

function resolvedFormat(input = {}) {
  if (input.templateId) {
    const template = templates.get(String(input.templateId));
    if (!template) fail('DRAWING_TEMPLATE_NOT_FOUND', `Drawing sheet template "${input.templateId}" does not exist.`);
    return { kind: 'template', templateId: template.id, ...clone(template) };
  }
  const widthMm = dimension(input.widthMm, 'Custom sheet width');
  const heightMm = dimension(input.heightMm, 'Custom sheet height');
  return {
    kind: 'custom',
    templateId: null,
    name: text(input.formatName || input.name || 'Custom sheet', 'Custom format name'),
    standard: text(input.standard || 'Custom', 'Custom format standard', 40),
    size: text(input.size || 'Custom', 'Custom format size', 40),
    widthMm,
    heightMm,
    projection: input.projection === 'first-angle' ? 'first-angle' : 'third-angle',
    titleBlock: text(input.titleBlock || 'custom-default', 'Title-block format', 80),
  };
}

function sheetRecord(graph, input = {}, namedViewIds = new Set()) {
  const id = `sheet-${String(++graph.sequence).padStart(6, '0')}`;
  const sheetViews = views(input.views || ['front', 'top', 'right', 'iso'], namedViewIds);
  return {
    id,
    name: text(input.name || `Sheet ${graph.sheets.length + 1}`, 'Sheet name'),
    format: resolvedFormat(input),
    scale: scale(input.scale),
    views: sheetViews,
    tangentEdges: tangentEdges(input.tangentEdges),
    alignments: alignments(input.alignments, sheetViews),
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 500) : '',
  };
}

function validateBook(value, namedViewIds = new Set()) {
  if (!value || typeof value !== 'object' || value.schema !== STUDIO_DRAWING_BOOK_SCHEMA) {
    fail('DRAWING_BOOK_NOT_INITIALIZED', 'Project does not contain a supported drawing book.');
  }
  const book = clone(value);
  if (!Number.isInteger(book.sequence) || book.sequence < 1 || !Array.isArray(book.sheets) || !book.sheets.length || book.sheets.length > 20) {
    fail('DRAWING_BOOK_INVALID', 'Drawing-book sequence or sheet count is invalid.');
  }
  const ids = new Set();
  const names = new Set();
  let maximumSequence = 0;
  for (const sheet of book.sheets) {
    if (!/^sheet-\d{6}$/u.test(sheet?.id || '') || ids.has(sheet.id)) fail('DRAWING_BOOK_INVALID', 'Drawing-sheet ids are missing or duplicated.');
    maximumSequence = Math.max(maximumSequence, Number(sheet.id.slice(6)));
    sheet.name = text(sheet.name, 'Sheet name');
    const folded = sheet.name.toLowerCase();
    if (names.has(folded)) fail('DRAWING_BOOK_INVALID', 'Drawing-sheet names must be unique.');
    sheet.format = sheet.format?.kind === 'template'
      ? resolvedFormat({ templateId: sheet.format.templateId })
      : resolvedFormat(sheet.format || {});
    sheet.scale = scale(sheet.scale);
    sheet.views = views(sheet.views, namedViewIds);
    sheet.tangentEdges = tangentEdges(sheet.tangentEdges);
    sheet.alignments = alignments(sheet.alignments, sheet.views);
    sheet.description = typeof sheet.description === 'string' ? sheet.description.slice(0, 500) : '';
    ids.add(sheet.id);
    names.add(folded);
  }
  if (book.sequence < maximumSequence) fail('DRAWING_BOOK_INVALID', 'Drawing-book sequence can collide with an existing sheet id.');
  if (!ids.has(book.activeSheetId)) fail('DRAWING_BOOK_INVALID', 'Active drawing sheet does not exist.');
  book.title = text(book.title || 'Drawing set', 'Drawing-book title');
  return book;
}

function from(project) {
  return validateBook(project?.extensions?.drawingBook, studioDrawingViewIds(project));
}

function attach(project, book) {
  const candidate = canonicalStudioV5Project(project);
  candidate.extensions = { ...(candidate.extensions || {}), drawingBook: validateBook(book, studioDrawingViewIds(candidate)) };
  return canonicalStudioV5Project(candidate);
}

export function initializeStudioDrawingBook(project, input = {}) {
  if (project?.extensions?.drawingBook) fail('DRAWING_BOOK_ALREADY_INITIALIZED', 'Project drawing book is already initialized.');
  const book = { schema: STUDIO_DRAWING_BOOK_SCHEMA, sequence: 0, title: text(input.title || 'Drawing set', 'Drawing-book title'), activeSheetId: null, sheets: [] };
  const namedViewIds = studioDrawingViewIds(project);
  const sheet = sheetRecord(book, { templateId: input.templateId || 'iso-a4-landscape', name: input.name || 'Sheet 1', scale: input.scale, views: input.views, tangentEdges: input.tangentEdges, alignments: input.alignments }, namedViewIds);
  book.sheets.push(sheet);
  book.activeSheetId = sheet.id;
  return attach(project, book);
}

export function createStudioDrawingSheet(project, input = {}) {
  const book = from(project);
  if (book.sheets.length >= 20) fail('DRAWING_BOOK_LIMIT_EXCEEDED', 'Drawing book supports at most 20 sheets.');
  const namedViewIds = studioDrawingViewIds(project);
  const sheet = sheetRecord(book, input, namedViewIds);
  if (book.sheets.some((entry) => entry.name.toLowerCase() === sheet.name.toLowerCase())) fail('DRAWING_SHEET_EXISTS', `Drawing sheet "${sheet.name}" already exists.`);
  book.sheets.push(sheet);
  if (input.activate !== false) book.activeSheetId = sheet.id;
  return attach(project, book);
}

export function updateStudioDrawingSheet(project, input = {}) {
  const book = from(project);
  const sheet = book.sheets.find((entry) => entry.id === input.sheetId);
  if (!sheet) fail('DRAWING_SHEET_NOT_FOUND', 'Requested drawing sheet does not exist.');
  const patch = input.patch && typeof input.patch === 'object' ? input.patch : {};
  const allowed = new Set(['name', 'templateId', 'customFormat', 'scale', 'views', 'tangentEdges', 'alignments', 'description']);
  const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
  if (unknown.length) fail('DRAWING_BOOK_INPUT_INVALID', 'Drawing-sheet patch contains unsupported fields.', { unknown });
  if (patch.name != null) sheet.name = text(patch.name, 'Sheet name');
  if (patch.templateId != null && patch.customFormat != null) fail('DRAWING_BOOK_INPUT_INVALID', 'Choose either a template or a custom sheet format.');
  if (patch.templateId != null) sheet.format = resolvedFormat({ templateId: patch.templateId });
  if (patch.customFormat != null) sheet.format = resolvedFormat(patch.customFormat);
  if (patch.scale != null) sheet.scale = scale(patch.scale);
  const namedViewIds = studioDrawingViewIds(project);
  if (patch.views != null) sheet.views = views(patch.views, namedViewIds);
  if (patch.tangentEdges != null) sheet.tangentEdges = tangentEdges(patch.tangentEdges);
  if (patch.alignments != null || patch.views != null) sheet.alignments = alignments(patch.alignments ?? sheet.alignments, sheet.views);
  if (patch.description != null) sheet.description = String(patch.description).trim().slice(0, 500);
  return attach(project, book);
}

export function deleteStudioDrawingSheet(project, sheetId) {
  const book = from(project);
  if (book.sheets.length === 1) fail('DRAWING_SHEET_REQUIRED', 'A drawing book must retain at least one sheet.');
  const index = book.sheets.findIndex((entry) => entry.id === sheetId);
  if (index < 0) fail('DRAWING_SHEET_NOT_FOUND', 'Requested drawing sheet does not exist.');
  book.sheets.splice(index, 1);
  if (book.activeSheetId === sheetId) book.activeSheetId = book.sheets[Math.min(index, book.sheets.length - 1)].id;
  const candidate = attach(project, book);
  if (candidate.extensions?.drawingStandards?.schema === 'partmode.drawing-standards/v1' && Array.isArray(candidate.extensions.drawingStandards.sheets)) {
    candidate.extensions.drawingStandards.sheets = candidate.extensions.drawingStandards.sheets.filter((entry) => entry.sheetId !== sheetId);
  }
  if (candidate.extensions?.drawingAnnotations?.schema === 'partmode.drawing-annotations/v1' && Array.isArray(candidate.extensions.drawingAnnotations.annotations)) {
    candidate.extensions.drawingAnnotations.annotations = candidate.extensions.drawingAnnotations.annotations.filter((entry) => entry.sheetId !== sheetId);
  }
  if (candidate.extensions?.drawingTables?.schema === 'partmode.drawing-tables/v1' && Array.isArray(candidate.extensions.drawingTables.tables)) {
    candidate.extensions.drawingTables.tables = candidate.extensions.drawingTables.tables.filter((entry) => entry.sheetId !== sheetId);
  }
  return canonicalStudioV5Project(candidate);
}

export function reorderStudioDrawingSheets(project, orderedSheetIds) {
  const book = from(project);
  if (!Array.isArray(orderedSheetIds) || orderedSheetIds.length !== book.sheets.length || new Set(orderedSheetIds).size !== book.sheets.length) {
    fail('DRAWING_BOOK_INPUT_INVALID', 'Sheet reorder must name every sheet exactly once.');
  }
  const byId = new Map(book.sheets.map((entry) => [entry.id, entry]));
  if (orderedSheetIds.some((id) => !byId.has(id))) fail('DRAWING_SHEET_NOT_FOUND', 'Sheet reorder names an unknown sheet.');
  book.sheets = orderedSheetIds.map((id) => byId.get(id));
  return attach(project, book);
}

export function activateStudioDrawingSheet(project, sheetId) {
  const book = from(project);
  if (!book.sheets.some((entry) => entry.id === sheetId)) fail('DRAWING_SHEET_NOT_FOUND', 'Requested drawing sheet does not exist.');
  book.activeSheetId = sheetId;
  return attach(project, book);
}

export function inspectStudioDrawingBook(project) {
  return from(project);
}

export function requiredStudioDrawingBookViews(project) {
  const book = from(project);
  return [...new Set(book.sheets.flatMap((sheet) => sheet.views))];
}
