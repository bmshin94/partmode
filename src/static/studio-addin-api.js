// Versioned, permission-gated third-party add-in host.
//
// Add-ins register code that is already loaded by the browser. Registration
// never grants document access: the visible manager must enable the add-in
// with an explicit subset of its declared permissions first. All data crossing
// the boundary is cloned, commands are namespaced, and disabling an add-in
// removes every command and event listener it owns.

export const STUDIO_ADDIN_SCHEMA = 'partmode.addin/v1';
export const STUDIO_ADDIN_API_VERSION = '1.0';
export const STUDIO_ADDIN_PERMISSIONS = Object.freeze([
  'document.read',
  'document.write',
  'commands.register',
]);

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u;
const COMMAND_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const clone = (value) => value === undefined ? undefined : structuredClone(value);

export class StudioAddinError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioAddinError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new StudioAddinError(code, message, details);
}

function text(value, label, maximum = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    fail('ADDIN_MANIFEST_INVALID', `${label} must be non-empty text no longer than ${maximum} characters.`);
  }
  return value.trim();
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ADDIN_MANIFEST_INVALID', 'Add-in manifest must be an object.');
  if (value.schema !== STUDIO_ADDIN_SCHEMA) fail('ADDIN_SCHEMA_UNSUPPORTED', `Add-in schema must be ${STUDIO_ADDIN_SCHEMA}.`);
  if (value.apiVersion !== STUDIO_ADDIN_API_VERSION) fail('ADDIN_API_UNSUPPORTED', `Add-in API version must be ${STUDIO_ADDIN_API_VERSION}.`);
  const id = text(value.id, 'Add-in id', 120);
  if (!ID_PATTERN.test(id)) fail('ADDIN_MANIFEST_INVALID', 'Add-in id must be a reverse-domain-style lowercase identifier.');
  const version = text(value.version, 'Add-in version', 64);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) fail('ADDIN_MANIFEST_INVALID', 'Add-in version must use semantic version syntax.');
  if (!Array.isArray(value.permissions) || new Set(value.permissions).size !== value.permissions.length) {
    fail('ADDIN_MANIFEST_INVALID', 'Add-in permissions must be a unique array.');
  }
  const permissions = value.permissions.map((permission) => text(permission, 'Add-in permission', 64));
  const allowed = new Set(STUDIO_ADDIN_PERMISSIONS);
  const unsupported = permissions.filter((permission) => !allowed.has(permission));
  if (unsupported.length) fail('ADDIN_PERMISSION_UNKNOWN', `Unsupported add-in permission: ${unsupported[0]}.`);
  return Object.freeze({
    schema: STUDIO_ADDIN_SCHEMA,
    apiVersion: STUDIO_ADDIN_API_VERSION,
    id,
    name: text(value.name, 'Add-in name', 100),
    version,
    permissions: Object.freeze([...permissions]),
    ...(value.description ? { description: text(value.description, 'Add-in description', 500) } : {}),
    ...(value.publisher ? { publisher: text(value.publisher, 'Add-in publisher', 100) } : {}),
  });
}

function recordView(record) {
  return clone({
    manifest: record.manifest,
    state: record.state,
    grantedPermissions: [...record.grants],
    commands: [...record.commands.values()].map(({ id, localId, title, description }) => ({ id, localId, title, ...(description ? { description } : {}) })),
    ...(record.error ? { error: record.error } : {}),
  });
}

export function createStudioAddinHost(adapters = {}) {
  if (typeof adapters.snapshot !== 'function' || typeof adapters.revision !== 'function'
    || typeof adapters.inspect !== 'function' || typeof adapters.transact !== 'function') {
    fail('ADDIN_HOST_INVALID', 'Add-in host requires snapshot, revision, inspect, and transact adapters.');
  }
  const records = new Map();
  const commandOwners = new Map();
  const eventListeners = new Map([['document.changed', new Map()]]);

  const recordFor = (id) => {
    const record = records.get(String(id || ''));
    if (!record) fail('ADDIN_NOT_FOUND', `Add-in "${String(id || '')}" is not registered.`);
    return record;
  };
  const requirePermission = (record, permission) => {
    if (!record.grants.has(permission)) fail('ADDIN_PERMISSION_DENIED', `Add-in "${record.manifest.id}" was not granted ${permission}.`, { addinId: record.manifest.id, permission });
  };
  const removeOwnedResources = (record) => {
    for (const commandId of record.commands.keys()) commandOwners.delete(commandId);
    record.commands.clear();
    for (const listeners of eventListeners.values()) listeners.delete(record.manifest.id);
  };
  const apiFor = (record) => Object.freeze({
    schema: 'partmode.addin-api/v1',
    apiVersion: STUDIO_ADDIN_API_VERSION,
    manifest: clone(record.manifest),
    permissions: Object.freeze([...record.grants]),
    document: Object.freeze({
      revision: () => Number(adapters.revision()),
      snapshot: () => {
        requirePermission(record, 'document.read');
        return clone(adapters.snapshot());
      },
      inspect: async (query) => {
        requirePermission(record, 'document.read');
        return clone(await adapters.inspect(clone(query), record.manifest.id));
      },
      transact: async (transaction) => {
        requirePermission(record, 'document.write');
        if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) fail('ADDIN_TRANSACTION_INVALID', 'Add-in transaction must be an object.');
        if (!Number.isInteger(transaction.expectedRevision) || transaction.expectedRevision < 0) fail('ADDIN_TRANSACTION_INVALID', 'Add-in transaction requires a non-negative expectedRevision.');
        if (!Array.isArray(transaction.operations) || !transaction.operations.length || transaction.operations.length > 100) fail('ADDIN_TRANSACTION_INVALID', 'Add-in transaction requires 1 to 100 typed operations.');
        const request = {
          label: text(transaction.label, 'Add-in transaction label', 160),
          expectedRevision: transaction.expectedRevision,
          operations: clone(transaction.operations),
        };
        return clone(await adapters.transact(request, record.manifest.id));
      },
    }),
    commands: Object.freeze({
      register: (definition, handler) => {
        requirePermission(record, 'commands.register');
        if (record.state !== 'activating' && record.state !== 'active') fail('ADDIN_NOT_ACTIVE', 'Commands may only be registered while the add-in is active.');
        if (!definition || typeof definition !== 'object' || typeof handler !== 'function') fail('ADDIN_COMMAND_INVALID', 'Add-in command requires a definition and handler.');
        const localId = text(definition.id, 'Add-in command id', 80);
        if (!COMMAND_PATTERN.test(localId)) fail('ADDIN_COMMAND_INVALID', 'Add-in command id must contain lowercase dotted or dashed segments.');
        const id = `${record.manifest.id}/${localId}`;
        if (commandOwners.has(id)) fail('ADDIN_COMMAND_CONFLICT', `Add-in command "${id}" is already registered.`);
        const command = Object.freeze({
          id,
          localId,
          title: text(definition.title, 'Add-in command title', 100),
          ...(definition.description ? { description: text(definition.description, 'Add-in command description', 300) } : {}),
          handler,
        });
        record.commands.set(id, command);
        commandOwners.set(id, record.manifest.id);
        return () => {
          if (record.commands.get(id) !== command) return false;
          record.commands.delete(id);
          commandOwners.delete(id);
          return true;
        };
      },
    }),
    events: Object.freeze({
      on: (eventName, listener) => {
        requirePermission(record, 'document.read');
        if (eventName !== 'document.changed' || typeof listener !== 'function') fail('ADDIN_EVENT_INVALID', 'Only document.changed listeners are supported.');
        const listeners = eventListeners.get(eventName);
        if (!listeners.has(record.manifest.id)) listeners.set(record.manifest.id, new Set());
        listeners.get(record.manifest.id).add(listener);
        return () => listeners.get(record.manifest.id)?.delete(listener) || false;
      },
    }),
  });

  const host = {
    register(manifestValue, activate) {
      const manifest = validateManifest(manifestValue);
      if (typeof activate !== 'function') fail('ADDIN_ACTIVATOR_INVALID', 'Add-in registration requires an activation function.');
      if (records.has(manifest.id)) fail('ADDIN_ALREADY_REGISTERED', `Add-in "${manifest.id}" is already registered.`);
      const record = { manifest, activate, state: 'registered', grants: new Set(), commands: new Map(), dispose: null, error: null };
      records.set(manifest.id, record);
      return recordView(record);
    },
    async enable(id, grantedPermissions = []) {
      const record = recordFor(id);
      if (record.state === 'active') return recordView(record);
      if (!Array.isArray(grantedPermissions) || new Set(grantedPermissions).size !== grantedPermissions.length) fail('ADDIN_GRANT_INVALID', 'Granted permissions must be a unique array.');
      const declared = new Set(record.manifest.permissions);
      for (const permission of grantedPermissions) {
        if (!declared.has(permission)) fail('ADDIN_GRANT_INVALID', `Permission ${permission} was not declared by add-in "${record.manifest.id}".`);
      }
      removeOwnedResources(record);
      record.grants = new Set(grantedPermissions);
      record.state = 'activating';
      record.error = null;
      try {
        const activated = await record.activate(apiFor(record));
        record.dispose = typeof activated === 'function' ? activated : typeof activated?.dispose === 'function' ? activated.dispose.bind(activated) : null;
        record.state = 'active';
        return recordView(record);
      } catch (error) {
        removeOwnedResources(record);
        record.dispose = null;
        record.grants.clear();
        record.state = 'failed';
        record.error = { code: error?.code || 'ADDIN_ACTIVATION_FAILED', message: String(error?.message || error) };
        throw error;
      }
    },
    async disable(id) {
      const record = recordFor(id);
      let disposeError = null;
      try { await record.dispose?.(); } catch (error) { disposeError = error; }
      removeOwnedResources(record);
      record.dispose = null;
      record.grants.clear();
      record.state = 'disabled';
      if (disposeError) fail('ADDIN_DISPOSE_FAILED', String(disposeError?.message || disposeError));
      return recordView(record);
    },
    async unregister(id) {
      const record = recordFor(id);
      await host.disable(id);
      records.delete(record.manifest.id);
      return true;
    },
    list() {
      return [...records.values()].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id)).map(recordView);
    },
    commands() {
      return [...commandOwners.keys()].sort().map((id) => {
        const record = recordFor(commandOwners.get(id));
        const { handler: _handler, ...command } = record.commands.get(id);
        return clone({ ...command, addinId: record.manifest.id });
      });
    },
    async runCommand(id, input) {
      const ownerId = commandOwners.get(String(id || ''));
      if (!ownerId) fail('ADDIN_COMMAND_NOT_FOUND', `Add-in command "${String(id || '')}" is not registered.`);
      const record = recordFor(ownerId);
      if (record.state !== 'active') fail('ADDIN_NOT_ACTIVE', `Add-in "${ownerId}" is not active.`);
      const command = record.commands.get(String(id));
      return clone(await command.handler(clone(input)));
    },
    emitDocumentChanged(event) {
      const listeners = eventListeners.get('document.changed');
      for (const [addinId, owned] of listeners) {
        if (records.get(addinId)?.state !== 'active') continue;
        for (const listener of [...owned]) queueMicrotask(() => {
          try { listener(clone(event)); }
          catch (error) { adapters.onListenerError?.(error, { addinId, eventName: 'document.changed' }); }
        });
      }
    },
    publicApi() {
      return Object.freeze({
        schema: 'partmode.addin-public/v1',
        apiVersion: STUDIO_ADDIN_API_VERSION,
        register: host.register,
        list: host.list,
        commands: host.commands,
        run: host.runCommand,
      });
    },
  };
  return Object.freeze(host);
}
