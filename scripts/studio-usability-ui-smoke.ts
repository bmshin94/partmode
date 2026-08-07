import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const [studio, css, storage, runtimeDocument, kernel] = await Promise.all([
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.css'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-storage.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-v5-runtime-document.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8'),
]);

function requireText(source: string, text: string, message: string): void {
  assert.ok(source.includes(text), message + ': missing ' + JSON.stringify(text));
}

// Beginner template selection must update both the card and detail pane.
requireText(studio, "template.id === 'starter-plate'", 'template library does not start with the beginner part');
requireText(studio, 'setTemplateSelection(\n      selectedTemplate && filtered.includes(selectedTemplate)',
  'template render does not synchronize its selected details');

// Feature history keeps the common Edit action primary and defers structural
// and destructive actions until the row is explicitly selected. Merely
// focusing Edit must not move that pointer target before click completes.
requireText(css, '.hist-item:not(.sel) .hi-a button:not([data-edit])',
  'feature history does not progressively disclose advanced actions');
assert.doesNotMatch(css, /\.hist-item:focus-within\s+\.hi-a/,
  'feature history moves Edit when it receives pointer focus');
requireText(css, 'grid-template-columns: minmax(0, 1fr) auto;',
  'feature history does not reserve a shrinkable feature-label column');
requireText(studio, 'const restoreEditedFeatureFocus = () =>',
  'existing feature edits do not restore keyboard focus');
requireText(studio, 'mutation.kernelPromise.catch(() => {}).then(restoreEditedFeatureFocus)',
  'feature edit focus is not restored after exact settlement');

// Short landscape face selection must remain a complete, cancellable command.
requireText(css, ".cadstudio-app[data-mode='choose-face'] #bw-face", 'short-viewport face picker is missing');
requireText(css, 'overflow-x: auto;', 'short-viewport face picker has no bounded action rail');
requireText(css, "[data-mode='choose-face'], [data-mode='sketching'], [data-mode='press-pull']",
  'face selection is not included in short-viewport focus mode');

// Assembly commands must work from ordinary parts, stay reachable on phones,
// and keep component/reference state coherent.
requireText(studio, 'v5RuntimeTools.canonicalStudioV5Project(doc)',
  'Create assembly does not start from the current canonical project');
assert.doesNotMatch(studio, /migrateStudioDocumentToV5|parseOrMigrateStudioV5/u,
  'Studio still contains an obsolete document migration path');
assert.doesNotMatch(studio, /doc\.(?:features|params|title)\b/u,
  'Studio still depends on an obsolete root-document alias');
assert.doesNotMatch(runtimeDocument, /defineAlias|prepareStoredStudioV5RuntimeProject|studioV5LegacyCanonicalHash/u,
  'runtime document boundary still carries a compatibility alias or stored-document shim');
assert.doesNotMatch(kernel, /buildLegacyDocument|schema-4|migratedFromSchema/u,
  'production kernel still carries an obsolete document execution path');
assert.doesNotMatch(css, /\[data-workspace=['"]assembly['"]\][^{]*\{[^}]*display\s*:\s*none/,
  'responsive CSS hides the Assembly workspace');
requireText(studio, 'if (nextSelectedOccurrenceId) selectedOccurrenceId = nextSelectedOccurrenceId;',
  'new assembly occurrences are not selected with their commit');
requireText(studio, "? selectField('Component to fix', 'movingOccurrenceId'",
  'Fixed mate does not use its compact one-component form');
requireText(studio, "coupleReference('movingOccurrenceId', 'movingReference')",
  'moving component and reference selectors are not coupled');
requireText(studio, 'function assemblyPlanarFaceLabel(result, face)',
  'mate faces still expose ordinal-only labels');
requireText(studio, "v5Dialog.__activeMateReferenceName = 'movingReference'",
  'mate dialog has no focused reference target for viewport picking');
requireText(studio, "v5Dialog.dataset.command === 'assembly-mate'",
  'viewport clicks are not routed into the active mate reference');
requireText(studio, 'previewAssemblyReference(control.value)',
  'mate reference changes do not highlight the exact face');
requireText(studio, "command === 'mate' && mateKind !== 'fixed'",
  'Fixed mate incorrectly uses the modeless viewport-pick path');
requireText(studio, 'const usesModelessCandidate = usesGizmo || usesViewportPick;',
  'assembly modeless commands do not capture one shared stale-candidate boundary');
requireText(studio, '__modelessCandidateCommandRevision = usesGizmo ? commandRevision : null;',
  'part transform gizmos do not capture their opening revision');
requireText(studio, 'The project changed while this modeless command was open.',
  'modeless commands do not reject a stale document candidate');
requireText(css, '.ws-v5-command.with-viewport-pick',
  'mate dialog does not leave the viewport available for face picking');
requireText(studio, 'if (v5Dialog?.open) {', 'global Escape does not prioritize the assembly command dialog');
requireText(studio, "$('bw-face-base')?.focus({ preventScroll: true })", 'face selection does not focus a visible command action');
requireText(studio, "mode.kind === 'sketching') canvas.focus()", 'Sketch does not focus its visible canvas');
requireText(studio, "visibility.setAttribute('aria-label', visibility.title + ' ' + occurrence.name)",
  'component visibility control has no accessible name');
requireText(studio, "suppress.setAttribute('aria-label', suppress.title + ' ' + occurrence.name)",
  'component suppression control has no accessible name');
requireText(studio, "$('bw-status-mode').textContent = isAssembly ? 'ASSEMBLY DESIGN' : 'PART DESIGN'",
  'assembly status still presents the part-design mode');
requireText(studio, 'Ready — select a component or mate, or insert a component',
  'assembly idle prompt still tells the user to pick a part feature');
requireText(studio, "summary.textContent = assembly.occurrences.length + ' component'",
  'assembly model tree still reports a part feature count');
requireText(studio, "$('bw-help-assembly-steps').hidden = !isAssembly", 'Help does not switch to assembly guidance');

// The local project journal must be enumerable for human component insertion.
requireText(storage, 'async function listProjects()', 'local project storage cannot feed an Insert component picker');
requireText(storage, 'listProjects,', 'local project listing is not exposed by the journal');
requireText(studio, 'importStudioV5PartDefinition', 'Insert component does not import a saved exact part definition');

console.log(JSON.stringify({
  beginnerTemplateContract: true,
  progressiveHistoryContract: true,
  editFocusRestorationContract: true,
  shortViewportFacePickerContract: true,
  assemblyReachabilityContract: true,
  compactFixedMateContract: true,
  coupledMateReferenceContract: true,
  viewportMatePickingWiring: true,
  modelessCandidateGuardContract: true,
  visibleCommandEntryFocusContract: true,
  accessibleComponentActionContract: true,
  assemblyIdleLanguageContract: true,
  assemblySpecificGuidanceContract: true,
  savedPartInsertionWiring: true,
}));
