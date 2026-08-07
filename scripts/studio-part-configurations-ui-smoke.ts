import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const [html, studio, css] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.css'), 'utf8'),
]);

function requireText(source: string, text: string, message: string): void {
  assert.ok(source.includes(text), message + ': missing ' + JSON.stringify(text));
}

for (const id of [
  'bw-configurations-open',
  'bw-configurations-reason',
  'bw-configuration-active-short',
  'bw-configurations',
  'bw-config-active-name',
  'bw-config-active-id',
  'bw-config-list',
  'bw-config-name',
  'bw-config-parameters',
  'bw-config-features',
  'bw-config-csv',
  'bw-config-export',
  'bw-config-import',
  'bw-config-status',
]) {
  assert.match(html, new RegExp('id=["\']' + id + '["\']'), 'missing HTML hook #' + id);
}
requireText(html, 'data-command-target="bw-configurations-open"', 'Manage ribbon does not expose Configurations');
requireText(html, 'role="listbox"', 'configuration rows are not exposed as a selectable list');
requireText(html, 'class="ws-visually-hidden"', 'configuration availability reason is not exposed to assistive technology');
requireText(html, 'role="status" aria-live="polite"', 'configuration status is not announced');
requireText(html, 'This part has no local parameters.', 'missing no-part-parameters explanation');
requireText(html, 'Configurations require a part document', 'missing assembly/root-kind explanation');
requireText(html, 'The part is unchanged until Import edited table succeeds.', 'missing fail-closed CSV copy');

for (const helper of [
  'studioV5PartConfigurationSet',
  'createStudioV5PartConfigurationSet',
  'updateStudioV5PartConfigurationSet',
  'deleteStudioV5PartConfigurationSet',
  'switchStudioV5PartConfiguration',
  'serializeStudioV5PartDesignTable',
  'importStudioV5PartDesignTable',
]) {
  requireText(studio, 'v5RuntimeTools.' + helper, 'configuration UI bypasses runtime helper ' + helper);
}

const regionStart = studio.indexOf('// --- part configurations + deterministic design table');
const regionEnd = studio.indexOf('// --- persistence', regionStart);
assert.ok(regionStart >= 0 && regionEnd > regionStart, 'configuration UI source region is missing');
const region = studio.slice(regionStart, regionEnd);
const transactionStart = region.indexOf('function runPartConfigurationMutation');
const transactionEnd = region.indexOf('function renderPartConfigurationButton', transactionStart);
assert.ok(transactionStart >= 0 && transactionEnd > transactionStart, 'transaction adapter is missing');
const transaction = region.slice(transactionStart, transactionEnd);
requireText(transaction, 'commit(label, () => {', 'configuration changes do not enter commit()');
requireText(transaction, 'return result.project;', 'transaction does not commit the detached runtime candidate');
requireText(transaction, 'renderPartConfigurations();', 'committed configuration state is not re-rendered');
requireText(transaction, 'syncPartConfigurationDesignTable(false);', 'committed configuration state does not refresh canonical CSV');
requireText(transaction, 'queueMicrotask(restorePartConfigurationFocus);', 'configuration mutation does not restore focus after its immediate render');
requireText(transaction, 'mutation?.kernelPromise', 'configuration mutation does not restore focus after exact settlement');

assert.doesNotMatch(region, /doc\s*\.\s*partConfigurationSets\s*(?:=|\.|\[)/u, 'configuration UI directly accesses mutable document configuration storage');
assert.doesNotMatch(region, /partConfigurationSets\s*\.\s*(?:push|splice|pop|shift|unshift|sort|reverse)\s*\(/u, 'configuration UI mutates configuration storage in place');
assert.doesNotMatch(region, /configurationSet\s*\.\s*configurations\s*\.\s*(?:push|splice|pop|shift|unshift|sort|reverse)\s*\(/u, 'configuration UI mutates a returned configuration set in place');
assert.doesNotMatch(region, /doc\s*\.\s*[A-Za-z_$][\w$]*\s*=(?!=)/u, 'configuration UI assigns directly into the live document');

requireText(region, "$('bw-config-active-name').textContent", 'active configuration name is not rendered');
requireText(region, "$('bw-config-active-id').textContent", 'active configuration ID is not rendered');
requireText(region, "button.setAttribute('aria-current', 'true')", 'active row is not semantically marked');
requireText(region, 'button.tabIndex = configuration.id === selected?.id ? 0 : -1;', 'configuration rows do not use roving keyboard focus');
requireText(region, "['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)",
  'configuration listbox does not handle Arrow, Home, and End keys');
requireText(region, "control.toggleAttribute('aria-disabled', disabled)", 'unavailable configuration controls use native disabled instead of an accessible reason');
requireText(region, "control.setAttribute('aria-describedby', 'bw-configurations-reason')", 'configuration controls are not associated with their availability reason');
requireText(region, 'configuration.parameterOverrides', 'parameter overrides are not rendered');
requireText(region, 'configuration.featureSuppressionOverrides', 'feature suppression states are not rendered');
requireText(region, 'select.dataset.configFeatureValue', 'feature suppression editor is not wired');
requireText(region, "$('bw-config-name').value.trim()", 'configuration rename field is not committed');
requireText(region, "code: 'CSV_EXPORTED'", 'deterministic CSV export status is missing');
requireText(region, "code: 'CSV_EDITED'", 'editable CSV dirty state is missing');
requireText(region, 'error?.path', 'structured validation paths are not surfaced');
requireText(region, 'error?.row', 'structured validation rows are not surfaced');
requireText(region, 'error?.configurationId', 'structured configuration IDs are not surfaced');
requireText(region, "status.setAttribute('role', error ? 'alert' : 'status')", 'validation failures are not announced as alerts');
requireText(region, "configurationDialog?.addEventListener('cancel'", 'native Escape/cancel handling is missing');
requireText(studio, 'if (configurationDialog?.open)', 'global Escape handling does not prioritize the configuration dialog');

requireText(css, '.ws-configurations', 'configuration workbench styling is missing');
requireText(css, '.ws-config-list button[aria-current=', 'active configuration rail styling is missing');
requireText(css, '.ws-configurations textarea:focus-visible', 'configuration keyboard focus styling is missing');
requireText(css, '@media (max-width: 760px)', 'configuration workbench has no responsive treatment');
requireText(css, '.ws-config-editor { display: block; overflow: visible; }', 'narrow configuration editor does not stack into a scrollable flow');
requireText(css, '@media (max-height: 540px)', 'configuration workbench has no short-viewport treatment');

console.log(JSON.stringify({
  htmlHooks: 14,
  runtimeHelpers: 7,
  transactionalCommit: true,
  directDocumentMutation: false,
  activeConfigurationDisplay: true,
  deterministicCsvSurface: true,
  structuredErrors: true,
  accessibleCancel: true,
  accessibleUnavailableReasonContract: true,
  keyboardListboxContract: true,
  responsiveSaveLayoutContract: true,
}));
