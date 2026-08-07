// Exact, document-wide undo/redo storage used by the visible Studio. History
// entries contain canonical JSON snapshots rather than operation-specific
// inverse payloads, so every mutation routed through commit() has the same
// restoration semantics.

export const STUDIO_DOCUMENT_HISTORY_SCHEMA = 'partmode.document-history/v1';
export const STUDIO_DOCUMENT_HISTORY_LIMITS = Object.freeze({
  maxEntries: 100,
  maxBytes: 16 * 1024 * 1024,
});

const utf8 = new TextEncoder();

function historyError(message) {
  return new Error('Studio document history: ' + message);
}

function limits(input = STUDIO_DOCUMENT_HISTORY_LIMITS) {
  const maxEntries = Number(input?.maxEntries);
  const maxBytes = Number(input?.maxBytes);
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw historyError('maxEntries must be a positive integer.');
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw historyError('maxBytes must be a positive integer.');
  return { maxEntries, maxBytes };
}

function label(value) {
  if (typeof value !== 'string' || !value.trim()) throw historyError('entry label must be a non-empty string.');
  return value.slice(0, 240);
}

function parsedSnapshot(value) {
  if (typeof value !== 'string') throw historyError('entry snapshot must be JSON text.');
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw historyError('entry snapshot is invalid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw historyError('entry snapshot must contain a document object.');
  }
  return parsed;
}

function entry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw historyError('entry must be an object.');
  const normalized = { label: label(value.label), snap: value.snap };
  parsedSnapshot(normalized.snap);
  return normalized;
}

function stacks(undoStack, redoStack) {
  if (!Array.isArray(undoStack) || !Array.isArray(redoStack)) throw historyError('undo and redo stacks must be arrays.');
  return {
    undo: undoStack.map(entry),
    redo: redoStack.map(entry),
  };
}

export function snapshotStudioDocument(document) {
  let snapshot;
  try { snapshot = JSON.stringify(document); }
  catch { throw historyError('document cannot be serialized.'); }
  parsedSnapshot(snapshot);
  return snapshot;
}

export function createStudioDocumentHistoryEntry(entryLabel, document) {
  return { label: label(entryLabel), snap: snapshotStudioDocument(document) };
}

export function studioDocumentHistoryEntryBytes(value) {
  const normalized = entry(value);
  return utf8.encode(normalized.snap).byteLength + utf8.encode(normalized.label).byteLength;
}

export function trimStudioDocumentHistory(undoStack, redoStack, inputLimits = STUDIO_DOCUMENT_HISTORY_LIMITS) {
  const checked = stacks(undoStack, redoStack);
  const bounded = limits(inputLimits);
  // Validate before mutating caller-owned arrays. Corrupt persisted history is
  // discarded by the journal hydrator instead of being partially accepted.
  undoStack.splice(0, undoStack.length, ...checked.undo);
  redoStack.splice(0, redoStack.length, ...checked.redo);
  while (undoStack.length + redoStack.length > bounded.maxEntries) {
    if (undoStack.length) undoStack.shift();
    else redoStack.shift();
  }
  let bytes = [...undoStack, ...redoStack]
    .reduce((total, current) => total + studioDocumentHistoryEntryBytes(current), 0);
  while (bytes > bounded.maxBytes && (undoStack.length || redoStack.length)) {
    // redo.at(-1) is the next redo step; shift removes the farthest future.
    const removed = undoStack.length ? undoStack.shift() : redoStack.shift();
    bytes -= studioDocumentHistoryEntryBytes(removed);
  }
  return { entries: undoStack.length + redoStack.length, bytes };
}

export function recordStudioDocumentCommit(
  undoStack,
  redoStack,
  historyEntry,
  inputLimits = STUDIO_DOCUMENT_HISTORY_LIMITS,
) {
  stacks(undoStack, redoStack);
  const normalized = entry(historyEntry);
  undoStack.push(normalized);
  redoStack.length = 0;
  trimStudioDocumentHistory(undoStack, redoStack, inputLimits);
  return normalized;
}

export function traverseStudioDocumentHistory(
  undoStack,
  redoStack,
  currentDocument,
  direction,
  inputLimits = STUDIO_DOCUMENT_HISTORY_LIMITS,
) {
  const checked = stacks(undoStack, redoStack);
  if (direction !== 'undo' && direction !== 'redo') throw historyError('direction must be undo or redo.');
  const source = direction === 'undo' ? checked.undo : checked.redo;
  if (!source.length) return null;
  const target = source.at(-1);
  const current = createStudioDocumentHistoryEntry(target.label, currentDocument);
  const restoredDocument = parsedSnapshot(target.snap);

  // All validation and current-document serialization completed above. Only
  // now update caller-owned stacks, leaving them untouched on any failure.
  undoStack.splice(0, undoStack.length, ...checked.undo);
  redoStack.splice(0, redoStack.length, ...checked.redo);
  const callerSource = direction === 'undo' ? undoStack : redoStack;
  const destination = direction === 'undo' ? redoStack : undoStack;
  callerSource.pop();
  destination.push(current);
  trimStudioDocumentHistory(undoStack, redoStack, inputLimits);
  return { label: target.label, snapshot: target.snap, document: restoredDocument };
}

function stringPatch(before, after) {
  let start = 0;
  const shared = Math.min(before.length, after.length);
  while (start < shared && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)) {
    beforeEnd--;
    afterEnd--;
  }
  return { start, remove: beforeEnd - start, insert: after.slice(start, afterEnd) };
}

function applyStringPatch(before, patch) {
  if (
    !patch || !Number.isInteger(patch.start) || !Number.isInteger(patch.remove) || patch.start < 0 || patch.remove < 0 ||
    patch.start + patch.remove > before.length || typeof patch.insert !== 'string'
  ) throw historyError('stored command patch is invalid.');
  return before.slice(0, patch.start) + patch.insert + before.slice(patch.start + patch.remove);
}

export function encodeStudioDocumentHistory(undoStack, redoStack, currentDocument) {
  const checked = stacks(undoStack, redoStack);
  const current = snapshotStudioDocument(currentDocument);
  const documents = [...checked.undo.map((item) => item.snap), current, ...checked.redo.slice().reverse().map((item) => item.snap)];
  const labels = [...checked.undo.map((item) => item.label), ...checked.redo.slice().reverse().map((item) => item.label)];
  const commands = labels.map((commandLabel, index) => ({
    label: commandLabel,
    ...stringPatch(documents[index], documents[index + 1]),
  }));
  return { version: 1, schema: STUDIO_DOCUMENT_HISTORY_SCHEMA, base: documents[0], commands, cursor: checked.undo.length };
}

export function decodeStudioDocumentHistory(history, inputLimits = STUDIO_DOCUMENT_HISTORY_LIMITS) {
  const bounded = limits(inputLimits);
  if (
    !history || history.version !== 1 ||
    (history.schema !== undefined && history.schema !== STUDIO_DOCUMENT_HISTORY_SCHEMA) ||
    typeof history.base !== 'string' || !Array.isArray(history.commands)
  ) throw historyError('stored history is invalid.');
  if (
    history.commands.length > bounded.maxEntries || !Number.isInteger(history.cursor) ||
    history.cursor < 0 || history.cursor > history.commands.length
  ) throw historyError('stored command cursor is invalid.');
  parsedSnapshot(history.base);
  const commands = history.commands.map((command) => ({ ...command, label: label(command?.label) }));
  const documents = [history.base];
  for (const command of commands) {
    const next = applyStringPatch(documents.at(-1), command);
    parsedSnapshot(next);
    documents.push(next);
  }
  const undoStack = commands.slice(0, history.cursor)
    .map((command, index) => ({ label: command.label, snap: documents[index] }));
  const redoStack = [];
  for (let index = commands.length - 1; index >= history.cursor; index--) {
    redoStack.push({ label: commands[index].label, snap: documents[index + 1] });
  }
  trimStudioDocumentHistory(undoStack, redoStack, bounded);
  return { current: documents[history.cursor], undoStack, redoStack };
}
