# PartMode add-in API 1.0

PartMode exposes a versioned third-party add-in API through the **Manage > Add-ins** manager and `globalThis.PartModeAddins`. A local JavaScript module can register commands that inspect or edit the same typed schema-5 document used by the built-in UI and headless agent.

Add-in modules are trusted browser code, not a JavaScript sandbox. Only load code you trust. The permission review controls access through the PartMode CAD API; it does not make an arbitrary JavaScript module safe to execute.

## Module contract

The manager accepts a local `.mjs` or `.js` file of at most 2 MiB. The module must export `manifest` and `activate`:

```js
export const manifest = {
  schema: 'partmode.addin/v1',
  apiVersion: '1.0',
  id: 'com.example.height-tools',
  name: 'Height Tools',
  version: '1.0.0',
  publisher: 'Example CAD',
  description: 'Edits one named parameter.',
  permissions: ['document.read', 'document.write', 'commands.register'],
};

export async function activate(api) {
  const remove = api.commands.register({
    id: 'set-height',
    title: 'Set height',
  }, async ({ parameterId, value }) => api.document.transact({
    label: 'Set height from add-in',
    expectedRevision: api.document.revision(),
    operations: [{
      kind: 'parameter.update',
      input: { parameterId, value },
    }],
  }));

  return () => remove();
}
```

Loading registers the manifest but grants no permissions and does not call `activate`. The user reviews the requested permissions and explicitly enables the add-in. Disabling or unregistering it removes every command and document-change listener that it owns and invokes its optional cleanup function.

## Permissions

| Permission | Capability |
| --- | --- |
| `document.read` | Clone the current document, inspect the typed project tree, and subscribe to `document.changed`. |
| `document.write` | Submit 1 to 100 typed atomic CAD operations against an explicit expected revision. |
| `commands.register` | Register namespaced commands such as `com.example.height-tools/set-height`. |

Unknown permissions and grants that were not declared in the manifest fail closed. Every document payload crossing the API boundary is cloned. A stale `expectedRevision` rejects the entire transaction without changing the source document.

## API surface

- `api.document.revision()` returns the current command revision.
- `api.document.snapshot()` returns a cloned schema-5 document and requires `document.read`.
- `api.document.inspect(query)` runs the typed read-only inspection vocabulary and requires `document.read`.
- `api.document.transact(transaction)` applies an atomic typed transaction and requires `document.write`.
- `api.commands.register(definition, handler)` registers a command under the add-in ID and returns a removal function.
- `api.events.on('document.changed', listener)` subscribes to committed document changes and returns an unsubscribe function.

The public `PartModeAddins` object exposes registration, read-only manifest and command listings, and command invocation. Permission granting, enablement, disablement, and removal remain owned by the visible add-in manager.
