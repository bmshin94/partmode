import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Studio document history smoke failed: ${label}`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const history = await moduleAt('src/static/studio-document-history.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');
const viewStates = await moduleAt('src/static/studio-view-states.js');
const scenes = await moduleAt('src/static/studio-scene-settings.js');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const snapshot = (value: unknown): string => history.snapshotStudioDocument(value);
check('production entry limit changed', history.STUDIO_DOCUMENT_HISTORY_LIMITS.maxEntries === 100);
check('production byte limit changed', history.STUDIO_DOCUMENT_HISTORY_LIMITS.maxBytes === 16 * 1024 * 1024);

type StackEntry = { label: string; snap: string };
type Sequence = { current: any; undo: StackEntry[]; redo: StackEntry[]; documents: string[]; labels: string[] };

function begin(document: any): Sequence {
  return { current: runtime.canonicalStudioV5Project(document), undo: [], redo: [], documents: [snapshot(runtime.canonicalStudioV5Project(document))], labels: [] };
}

function commit(sequence: Sequence, label: string, mutate: (document: any) => any): void {
  const entry = history.createStudioDocumentHistoryEntry(label, sequence.current);
  const next = mutate(sequence.current);
  history.recordStudioDocumentCommit(sequence.undo, sequence.redo, entry);
  sequence.current = next;
  sequence.labels.push(label);
  sequence.documents.push(snapshot(next));
}

function exactWalk(sequence: Sequence): void {
  for (let index = sequence.documents.length - 2; index >= 0; index--) {
    const step = history.traverseStudioDocumentHistory(sequence.undo, sequence.redo, sequence.current, 'undo');
    check(`undo step ${index} was unavailable`, step);
    check(`undo label ${index} changed`, step.label === sequence.labels[index]);
    check(`undo step ${index} did not restore exact document JSON`, step.snapshot === sequence.documents[index]);
    sequence.current = step.document;
  }
  check('undo stack did not drain', sequence.undo.length === 0);
  check('redo depth does not equal the mixed operation count', sequence.redo.length === sequence.labels.length);
  for (let index = 1; index < sequence.documents.length; index++) {
    const step = history.traverseStudioDocumentHistory(sequence.undo, sequence.redo, sequence.current, 'redo');
    check(`redo step ${index} was unavailable`, step);
    check(`redo label ${index} changed`, step.label === sequence.labels[index - 1]);
    check(`redo step ${index} did not restore exact document JSON`, step.snapshot === sequence.documents[index]);
    sequence.current = step.document;
  }
  check('redo stack did not drain', sequence.redo.length === 0);
  check('undo depth does not equal the mixed operation count', sequence.undo.length === sequence.labels.length);
}

const partFixture = JSON.parse(await readFile(resolve(root, 'tests/fixtures/three-body.json'), 'utf8'));
const part = begin(partFixture);
commit(part, 'Hide tool body', (document) => runtime.updateStudioV5Body(document, 'body-feature-tool', { visible: false }));
commit(part, 'Rename housing', (document) => runtime.updateStudioV5Body(document, 'body-feature-housing', { name: 'Primary housing' }));
commit(part, 'Roll back after shaft', (document) => runtime.setStudioV5RollbackMarker(document, 'feature-shaft'));
commit(part, 'Save inspection orientation', (document) => viewStates.saveStudioViewOrientation(document, {
  id: 'history-inspection',
  name: 'History inspection',
  camera: { position: [80, 60, 120], target: [0, 5, 0], up: [0, 1, 0] },
}));
commit(part, 'Apply daylight scene', (document) => scenes.saveStudioSceneSettings(document, {
  preset: 'daylight', exposure: 1.25, realView: true, shadows: true,
}));
const partFinalHash = runtime.studioV5CanonicalHash(part.current);
exactWalk(part);
check('part redo did not recover the exact final canonical hash', runtime.studioV5CanonicalHash(part.current) === partFinalHash);

// Persist a history with a non-terminal cursor. Decode must restore both stack
// directions and the exact active document, not merely the last saved state.
const firstUndo = history.traverseStudioDocumentHistory(part.undo, part.redo, part.current, 'undo');
check('persistence setup undo failed', firstUndo);
part.current = firstUndo.document;
const secondUndo = history.traverseStudioDocumentHistory(part.undo, part.redo, part.current, 'undo');
check('persistence setup second undo failed', secondUndo);
part.current = secondUndo.document;
const encoded = history.encodeStudioDocumentHistory(part.undo, part.redo, part.current);
const decoded = history.decodeStudioDocumentHistory(clone(encoded));
check('persisted history schema is not explicit', encoded.schema === 'partmode.document-history/v1');
check('persisted cursor changed', encoded.cursor === part.undo.length);
check('decoded active document changed', decoded.current === snapshot(part.current));
check('decoded undo depth changed', decoded.undoStack.length === part.undo.length);
check('decoded redo depth changed', decoded.redoStack.length === part.redo.length);

// A new edit after undo must cut off the abandoned future branch.
const branchEntry = history.createStudioDocumentHistoryEntry('Branch rename', part.current);
part.current = runtime.updateStudioV5Body(part.current, 'body-feature-shaft', { name: 'Branched shaft' });
history.recordStudioDocumentCommit(part.undo, part.redo, branchEntry);
check('new branch did not clear redo history', part.redo.length === 0);
check('new branch is not the next undo label', part.undo.at(-1)?.label === 'Branch rename');

const assemblyFixture = JSON.parse(await readFile(resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'), 'utf8'));
const assembly = begin(assemblyFixture);
commit(assembly, 'Hide base occurrence', (document) => runtime.updateStudioV5ComponentOccurrence(document, 'occurrence-base', { visible: false }));
commit(assembly, 'Suppress moving occurrence', (document) => runtime.updateStudioV5ComponentOccurrence(document, 'occurrence-moving', { suppressed: true }));
commit(assembly, 'Suppress corner mate', (document) => runtime.updateStudioV5AssemblyMate(document, 'mate-corner-x', { suppressed: true }));
const assemblyFinalHash = runtime.studioV5CanonicalHash(assembly.current);
exactWalk(assembly);
check('assembly redo did not recover the exact final canonical hash', runtime.studioV5CanonicalHash(assembly.current) === assemblyFinalHash);

// Entry and byte ceilings are hard bounds. The most recent operations remain
// traversable when older snapshots are evicted.
const boundedUndo: StackEntry[] = [];
const boundedRedo: StackEntry[] = [];
let boundedDocument: any = { schemaVersion: 5, marker: 0 };
for (let index = 0; index < 105; index++) {
  const entry = history.createStudioDocumentHistoryEntry(`Bounded ${index}`, boundedDocument);
  boundedDocument = { schemaVersion: 5, marker: index + 1 };
  history.recordStudioDocumentCommit(boundedUndo, boundedRedo, entry);
}
check('100-entry ceiling was not enforced', boundedUndo.length === 100 && boundedUndo.at(0)?.label === 'Bounded 5');
const byteUndo: StackEntry[] = [];
const byteRedo: StackEntry[] = [];
let byteDocument: any = { schemaVersion: 5, payload: 'α'.repeat(300) };
for (let index = 0; index < 6; index++) {
  const entry = history.createStudioDocumentHistoryEntry(`UTF-8 ${index}`, byteDocument);
  byteDocument = { schemaVersion: 5, payload: 'α'.repeat(300) + index };
  history.recordStudioDocumentCommit(byteUndo, byteRedo, entry, { maxEntries: 100, maxBytes: 1500 });
}
const retainedBytes = byteUndo.reduce((total: number, item: StackEntry) => total + history.studioDocumentHistoryEntryBytes(item), 0);
check('UTF-8 byte ceiling was not enforced', retainedBytes <= 1500 && byteUndo.length >= 1 && byteUndo.length < 6);

// A serialization or persisted-entry failure cannot partially consume either
// stack. Production creates the entry before mutation and records it only
// after a successful normalized replacement.
const guardedUndo = clone(assembly.undo);
const guardedRedo = clone(assembly.redo);
const guardedBefore = JSON.stringify({ guardedUndo, guardedRedo });
const circular: any = { schemaVersion: 5 };
circular.self = circular;
let circularRejected = false;
try { history.traverseStudioDocumentHistory(guardedUndo, guardedRedo, circular, 'undo'); }
catch { circularRejected = true; }
check('non-serializable current document did not fail closed', circularRejected);
check('failed traversal changed either stack', JSON.stringify({ guardedUndo, guardedRedo }) === guardedBefore);
const corruptUndo = [{ label: 'Corrupt', snap: '{' }];
const corruptRedo: StackEntry[] = [];
const corruptBefore = JSON.stringify({ corruptUndo, corruptRedo });
let corruptRejected = false;
try { history.traverseStudioDocumentHistory(corruptUndo, corruptRedo, assembly.current, 'undo'); }
catch { corruptRejected = true; }
check('corrupt target entry did not fail closed', corruptRejected);
check('corrupt traversal partially changed stacks', JSON.stringify({ corruptUndo, corruptRedo }) === corruptBefore);

const studioSource = await readFile(resolve(root, 'src/static/studio.js'), 'utf8');
const pageSource = await readFile(resolve(root, 'src/page.html'), 'utf8');
const registrySource = await readFile(resolve(root, 'src/static/studio-v6-ui-registry.js'), 'utf8');
const buildSource = await readFile(resolve(root, 'scripts/build.ts'), 'utf8');
check('production does not import the document-wide history boundary', studioSource.includes("import('/static/studio-document-history.js')"));
check('production commit does not snapshot before mutation', studioSource.indexOf('createStudioDocumentHistoryEntry(label, doc)') < studioSource.indexOf('replacement = mutate()'));
check('production records history before successful mutation settlement', studioSource.indexOf('recordStudioDocumentCommit(undoStack, redoStack, historyEntry)') > studioSource.indexOf('doc = normalizeDoc(replacement || doc)'));
check('typed agent transactions do not share the central commit boundary', /function commitHumanOperations[\s\S]*?commit\(label, \(\) => applied\.project/.test(studioSource));
check('monolithic runtime still mutates undo stack directly', !/undoStack\.(push|pop|shift|unshift)\(/.test(studioSource));
check('monolithic runtime still mutates redo stack directly', !/redoStack\.(push|pop|shift|unshift)\(/.test(studioSource));
check('visible undo/redo controls are missing', pageSource.includes('id="bw-undo"') && pageSource.includes('id="bw-redo"'));
check('visible history depth and next labels are not exposed', studioSource.includes("undoStack.at(-1).label + ' (' + undoStack.length + ' available) (Ctrl+Z)'")
  && studioSource.includes("redoStack.at(-1).label + ' (' + redoStack.length + ' available) (Ctrl+Shift+Z)'"));
check('typed history controls are missing', registrySource.includes("control('history.undo'") && registrySource.includes("control('history.redo'"));
check('release asset allowlist omits document history', buildSource.includes("'studio-document-history.js'"));

const directAssignments = studioSource.split('\n').filter((line) => /\bdoc\s*=/.test(line)).map((line) => line.trim());
const sanctionedAssignments = [
  /^doc = targetProject\.document;$/,
  /^doc = normalizeDoc\(recovered\);$/,
  /^let doc = /,
  /^doc = normalizeDoc\(JSON\.parse\(snap\)\);$/,
  /^doc = normalizeDoc\(replacement \|\| doc\);$/,
  /^doc = previous;$/,
  /^doc = normalizeDoc\(JSON\.parse\(snapJson\)\);$/,
  /^doc = restored\.document;$/,
  /^doc = normalizeDoc\(doc\);$/,
  /^if \(d .* doc = normalizeDoc\(/,
  /^else doc = normalizeDoc\(doc\);$/,
  /^doc = normalizeDoc\(imported\.document\);$/,
  /^doc = normalizeDoc\(deepCopy\(previous\.document\)\);$/,
  /^doc = normalizeDoc\(preserveAgent/,
  /^doc = normalizeDoc\(starterDocument\(\)\);$/,
  /^doc = normalizeDoc\(\{ \.\.\.templateDocument, projectId \}\);$/,
  /^doc = v5RuntimeTools\.createEmptyStudioV5RuntimePartProject\(\{$/,
];
check('an unclassified direct document replacement bypasses the audited commit/project-transition set',
  directAssignments.every((line) => sanctionedAssignments.some((pattern) => pattern.test(line))));

console.log(JSON.stringify({
  schema: 'partmode.document-history-smoke/v1',
  partOperations: 5,
  assemblyOperations: 3,
  exactUndoRedoDocuments: 16,
  persistedCursor: encoded.cursor,
  persistedRedoDepth: decoded.redoStack.length,
  branchClearsRedo: true,
  bounds: { entries: boundedUndo.length, utf8Bytes: retainedBytes },
  failClosed: ['non-serializable-current', 'corrupt-target'],
  productionRouting: { directAssignments: directAssignments.length, unclassified: 0 },
}, null, 2));
