import type { ReleaseManifest } from './server.js';
import type { PartModeHelpManifest } from './help.js';
import {
  isHeadlessSessionId,
  type HeadlessOpenInput,
  type HeadlessSessionManager,
} from './headless-sessions.js';
import {
  RelayError,
  type AgentIdentity,
  type ConnectRequest,
  type RelayHub,
} from './relay-hub.js';

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpHttpResult {
  status: number;
  body?: Record<string, unknown>;
}

export const MCP_PROTOCOL_VERSION = '2025-11-25';

const SESSION_ID_SCHEMA = {
  type: 'string',
  minLength: 10,
  maxLength: 100,
  description: 'Opaque session ID returned by partmode_connect or partmode_headless_open.',
};

const TOOLS: readonly McpToolDefinition[] = Object.freeze([
  {
    name: 'partmode_list_studios',
    title: 'List online PartMode tabs',
    description: 'Lists signed-in PartMode browser tabs for this account. No project metadata is exposed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'partmode_connect',
    title: 'Request a browser-approved CAD session',
    description: 'Requests one visible, project-scoped approval in an online PartMode tab. The API key alone grants no CAD access.',
    inputSchema: {
      type: 'object',
      required: ['studioId'],
      properties: {
        studioId: { type: 'string', minLength: 10, maxLength: 100 },
        clientLabel: { type: 'string', minLength: 1, maxLength: 80 },
        mode: { type: 'string', enum: ['read-only', 'preview-required'] },
        permissions: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 80 } },
        operationKinds: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 120 } },
        maxCommits: { type: 'integer', minimum: 0, maximum: 20 },
        sessionSeconds: { type: 'integer', minimum: 60, maximum: 3600 },
        uiProfile: {
          type: 'string',
          enum: ['partmode.cad.agentic-ui/v1', 'partmode.cad.visible-projection/v1'],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'partmode_session_status',
    title: 'Inspect CAD session status',
    description: 'Returns the mode, permissions, expiry, and remaining commit budget for a live browser or headless session.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: { sessionId: SESSION_ID_SCHEMA },
      additionalProperties: false,
    },
  },
  {
    name: 'partmode_disconnect',
    title: 'Disconnect from PartMode',
    description: 'Closes a browser-approved or server-headless CAD session and clears its live session state.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: { sessionId: SESSION_ID_SCHEMA },
      additionalProperties: false,
    },
  },
  {
    name: 'partmode_headless_open',
    title: 'Open a server-side CAD session',
    description:
      'Opens an ephemeral server-side CAD session with no browser. Requires an agent key created with the headless grant. Committed documents persist per account and project.',
    inputSchema: {
      type: 'object',
      required: ['projectId'],
      properties: {
        projectId: { type: 'string', minLength: 1, maxLength: 200 },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        units: { type: 'string', enum: ['mm', 'in'] },
        mode: { type: 'string', enum: ['read-only', 'preview-required'] },
        permissions: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 80 } },
        operationKinds: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 120 } },
        maxCommits: { type: 'integer', minimum: 0, maximum: 20 },
        sessionSeconds: { type: 'integer', minimum: 60, maximum: 3600 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'partmode_headless_export_step',
    title: 'Export STEP from a headless session',
    description: 'Exports the current committed document of a headless session as an ISO 10303-21 STEP file (base64), with byte count and SHA-256.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: SESSION_ID_SCHEMA,
        bodyIds: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 200 } },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cad_artifact',
    title: 'Generate a CAD artifact',
    description:
      'Generates an advertised browser-session artifact such as Project, STEP, STL, AMF, 3MF, drawing SVG, render, or narration data. Read cad_capabilities first.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'format'],
      properties: {
        sessionId: SESSION_ID_SCHEMA,
        format: {
          type: 'string',
          enum: ['project', 'step', 'stl', 'amf', '3mf', 'drawing-svg', 'drawing-dxf', 'sketch-dxf', 'flat-dxf', 'png', 'webvtt', 'srt'],
        },
        scope: { type: 'string', enum: ['selection', 'visible-model'] },
        sketchFeatureId: { type: 'string', minLength: 1, maxLength: 200 },
        flatFeatureId: { type: 'string', minLength: 1, maxLength: 200 },
        entities: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            required: ['kind', 'id'],
            properties: {
              kind: { type: 'string', enum: ['body', 'occurrence', 'part', 'assembly'] },
              id: { type: 'string', minLength: 1, maxLength: 200 },
            },
            additionalProperties: false,
          },
        },
        width: { type: 'integer', minimum: 128, maximum: 2048 },
        height: { type: 'integer', minimum: 128, maximum: 2048 },
      },
      additionalProperties: false,
    },
  },
  ...[
    ['cad_capabilities', 'Read PartMode CAD capabilities', 'Reads the exact typed capability manifest for the selected browser or headless session.'],
    ['cad_inspect', 'Inspect the CAD document', 'Reads exact document and body state from the selected browser or headless session.'],
    ['cad_query', 'Run an exact CAD query', 'Runs a typed, exact-kernel query in the selected browser or headless session.'],
    ['cad_preview', 'Preview a CAD transaction', 'Validates a typed CAD transaction without committing it. Browser sessions also present the preview visibly.'],
    ['cad_commit', 'Commit an accepted CAD preview', 'Commits an exact preview subject to session mode, revision, grant, and commit budget.'],
    ['cad_history', 'Use CAD history', 'Reads history or performs an authorized undo or redo.'],
    ['cad_ui', 'Use semantic CAD UI', 'Reads or applies typed semantic UI actions in a browser-approved session. This tool is unavailable headless.'],
    ['cad_events', 'Read CAD events', 'Reads or waits for bounded semantic events from a browser-approved session. This tool is unavailable headless.'],
  ].map(([name, title, description]) => ({
    name: name as string,
    title: title as string,
    description: description as string,
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: { sessionId: SESSION_ID_SCHEMA },
      additionalProperties: true,
    },
  })),
]);

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function toolSuccess(id: unknown, value: unknown): Record<string, unknown> {
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  });
}

function toolFailure(id: unknown, error: unknown): Record<string, unknown> {
  const relay = error instanceof RelayError
    ? error
    : new RelayError('INTERNAL_ERROR', error instanceof Error ? error.message : 'PartMode could not complete the tool request.', { status: 500 });
  const result = {
    ok: false,
    error: {
      code: relay.code,
      message: relay.message,
      retryable: relay.retryable,
      ...(relay.details === undefined ? {} : { details: relay.details }),
    },
  };
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: true,
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayError('INVALID_ARGUMENTS', 'Tool arguments must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function requiredString(
  args: Record<string, unknown>,
  name: string,
  options: { minLength?: number; maxLength?: number } = {},
): string {
  const value = args[name];
  const minLength = options.minLength ?? 1;
  const maxLength = options.maxLength ?? 200;
  if (typeof value !== 'string' || value.length < minLength || value.length > maxLength) {
    throw new RelayError(
      'INVALID_ARGUMENTS',
      `"${name}" must be a string from ${minLength} to ${maxLength} characters.`,
    );
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  name: string,
  options: { minLength?: number; maxLength?: number } = {},
): string | undefined {
  if (args[name] === undefined) return undefined;
  return requiredString(args, name, options);
}

function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  name: string,
  values: readonly T[],
): T | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new RelayError('INVALID_ARGUMENTS', `"${name}" must be one of: ${values.join(', ')}.`);
  }
  return value as T;
}

function requiredEnum<T extends string>(
  args: Record<string, unknown>,
  name: string,
  values: readonly T[],
): T {
  const value = optionalEnum(args, name, values);
  if (value === undefined) {
    throw new RelayError('INVALID_ARGUMENTS', `"${name}" is required.`);
  }
  return value;
}

function optionalInteger(
  args: Record<string, unknown>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RelayError('INVALID_ARGUMENTS', `"${name}" must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function optionalStringArray(
  args: Record<string, unknown>,
  name: string,
  options: { minItems?: number; maxItems: number; maxLength: number },
): string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  const minItems = options.minItems ?? 0;
  if (
    !Array.isArray(value) ||
    value.length < minItems ||
    value.length > options.maxItems ||
    value.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > options.maxLength)
  ) {
    throw new RelayError(
      'INVALID_ARGUMENTS',
      `"${name}" must contain ${minItems} to ${options.maxItems} strings of at most ${options.maxLength} characters.`,
    );
  }
  return [...new Set(value as string[])];
}

function onlyKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => !allowedSet.has(key));
  if (unknown.length) {
    throw new RelayError('INVALID_ARGUMENTS', `Unknown tool argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`);
  }
}

function validateArtifactArguments(args: Record<string, unknown>): void {
  onlyKeys(args, ['sessionId', 'format', 'scope', 'entities', 'width', 'height', 'sketchFeatureId', 'flatFeatureId']);
  requiredString(args, 'sessionId', { minLength: 10, maxLength: 100 });
  const format = requiredEnum(args, 'format', ['project', 'step', 'stl', 'amf', '3mf', 'drawing-svg', 'drawing-dxf', 'sketch-dxf', 'flat-dxf', 'png', 'webvtt', 'srt'] as const);
  optionalEnum(args, 'scope', ['selection', 'visible-model'] as const);
  if (args.sketchFeatureId !== undefined) {
    if (format !== 'sketch-dxf') {
      throw new RelayError('INVALID_ARGUMENTS', 'Only the sketch-dxf artifact accepts "sketchFeatureId".');
    }
    requiredString(args, 'sketchFeatureId', { maxLength: 200 });
  }
  if (args.flatFeatureId !== undefined) {
    if (format !== 'flat-dxf') {
      throw new RelayError('INVALID_ARGUMENTS', 'Only the flat-dxf artifact accepts "flatFeatureId".');
    }
    requiredString(args, 'flatFeatureId', { maxLength: 200 });
  }
  optionalInteger(args, 'width', 128, 2048);
  optionalInteger(args, 'height', 128, 2048);
  if (args.entities !== undefined) {
    if (!Array.isArray(args.entities) || args.entities.length < 1 || args.entities.length > 100) {
      throw new RelayError('INVALID_ARGUMENTS', '"entities" must contain 1 to 100 stable entity references.');
    }
    for (const entry of args.entities) {
      const entity = record(entry);
      onlyKeys(entity, ['kind', 'id']);
      requiredEnum(entity, 'kind', ['body', 'occurrence', 'part', 'assembly'] as const);
      const id = requiredString(entity, 'id', { maxLength: 200 });
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) {
        throw new RelayError('INVALID_ARGUMENTS', 'Artifact entity IDs must be stable PartMode identifiers.');
      }
    }
  }
  if (args.entities !== undefined && args.scope !== undefined) {
    throw new RelayError('INVALID_ARGUMENTS', 'Choose either "entities" or "scope", not both.');
  }
}

async function callTool(
  name: string,
  rawArguments: unknown,
  identity: AgentIdentity,
  hub: RelayHub,
  headless?: HeadlessSessionManager,
): Promise<unknown> {
  const args = record(rawArguments ?? {});
  const requireHeadless = (): HeadlessSessionManager => {
    if (!headless) {
      throw new RelayError('HEADLESS_UNAVAILABLE', 'Headless CAD execution is not enabled on this server.', { status: 503 });
    }
    return headless;
  };
  if (name === 'partmode_list_studios') {
    onlyKeys(args, []);
    return { studios: hub.listStudios(identity) };
  }
  if (name === 'partmode_headless_open') {
    onlyKeys(args, ['projectId', 'name', 'units', 'mode', 'permissions', 'operationKinds', 'maxCommits', 'sessionSeconds']);
    const input: HeadlessOpenInput = { projectId: requiredString(args, 'projectId', { maxLength: 200 }) };
    const projectName = optionalString(args, 'name', { maxLength: 200 });
    const units = optionalEnum(args, 'units', ['mm', 'in'] as const);
    const mode = optionalEnum(args, 'mode', ['read-only', 'preview-required'] as const);
    const permissions = optionalStringArray(args, 'permissions', { maxItems: 20, maxLength: 80 });
    const operationKinds = optionalStringArray(args, 'operationKinds', { maxItems: 100, maxLength: 120 });
    const maxCommits = optionalInteger(args, 'maxCommits', 0, 20);
    const sessionSeconds = optionalInteger(args, 'sessionSeconds', 60, 3_600);
    if (projectName !== undefined) input.name = projectName;
    if (units !== undefined) input.units = units;
    if (mode !== undefined) input.mode = mode;
    if (permissions !== undefined) input.permissions = permissions;
    if (operationKinds !== undefined) input.operationKinds = operationKinds;
    if (maxCommits !== undefined) input.maxCommits = maxCommits;
    if (sessionSeconds !== undefined) input.sessionSeconds = sessionSeconds;
    return requireHeadless().open(identity, input);
  }
  if (name === 'partmode_headless_export_step') {
    onlyKeys(args, ['sessionId', 'bodyIds']);
    const sessionId = requiredString(args, 'sessionId', { minLength: 10, maxLength: 100 });
    const bodyIds = optionalStringArray(args, 'bodyIds', { maxItems: 100, maxLength: 200 });
    const reply = record(await requireHeadless().exportStep(identity, sessionId, bodyIds) ?? {});
    const errors = Array.isArray(reply.errors) ? reply.errors : [];
    if (errors.length) {
      throw new RelayError('EXPORT_FAILED', 'The STEP export reported errors.', { status: 422 });
    }
    if (!(reply.blob instanceof Blob) || reply.blob.size < 1) {
      throw new RelayError('EXPORT_FAILED', 'The STEP export produced no data.', { status: 422 });
    }
    const bytes = Buffer.from(await reply.blob.arrayBuffer());
    const { createHash } = await import('node:crypto');
    return {
      format: 'step',
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      stepBase64: bytes.toString('base64'),
      manifest: reply.manifest ?? null,
    };
  }
  if (name === 'partmode_connect') {
    onlyKeys(args, ['studioId', 'clientLabel', 'mode', 'permissions', 'operationKinds', 'maxCommits', 'sessionSeconds', 'uiProfile']);
    const studioId = requiredString(args, 'studioId', { minLength: 10, maxLength: 100 });
    const input: ConnectRequest = { studioId };
    const clientLabel = optionalString(args, 'clientLabel', { maxLength: 80 });
    const mode = optionalEnum(args, 'mode', ['read-only', 'preview-required'] as const);
    const permissions = optionalStringArray(args, 'permissions', { maxItems: 20, maxLength: 80 });
    const operationKinds = optionalStringArray(args, 'operationKinds', { maxItems: 100, maxLength: 120 });
    const maxCommits = optionalInteger(args, 'maxCommits', 0, 20);
    const sessionSeconds = optionalInteger(args, 'sessionSeconds', 60, 3_600);
    const uiProfile = optionalEnum(args, 'uiProfile', ['partmode.cad.agentic-ui/v1', 'partmode.cad.visible-projection/v1'] as const);
    if (clientLabel !== undefined) input.clientLabel = clientLabel;
    if (mode !== undefined) input.mode = mode;
    if (permissions !== undefined) input.permissions = permissions;
    if (operationKinds !== undefined) input.operationKinds = operationKinds;
    if (maxCommits !== undefined) input.maxCommits = maxCommits;
    if (sessionSeconds !== undefined) input.sessionSeconds = sessionSeconds;
    if (uiProfile !== undefined) input.uiProfile = uiProfile;
    return hub.connect(identity, input);
  }
  if (name === 'partmode_session_status') {
    onlyKeys(args, ['sessionId']);
    const sessionId = requiredString(args, 'sessionId', { minLength: 10, maxLength: 100 });
    return isHeadlessSessionId(sessionId)
      ? requireHeadless().sessionStatus(identity, sessionId)
      : hub.sessionStatus(identity, sessionId);
  }
  if (name === 'partmode_disconnect') {
    onlyKeys(args, ['sessionId']);
    const sessionId = requiredString(args, 'sessionId', { minLength: 10, maxLength: 100 });
    if (isHeadlessSessionId(sessionId)) requireHeadless().disconnect(identity, sessionId);
    else hub.disconnect(identity, sessionId);
    return { disconnected: true };
  }
  if (name.startsWith('cad_')) {
    if (name === 'cad_artifact') validateArtifactArguments(args);
    const sessionId = requiredString(args, 'sessionId', { minLength: 10, maxLength: 100 });
    const forwarded = { ...args };
    delete forwarded.sessionId;
    return isHeadlessSessionId(sessionId)
      ? requireHeadless().callTool(identity, sessionId, name, forwarded)
      : hub.callTool(identity, sessionId, name, forwarded);
  }
  throw new RelayError('TOOL_NOT_FOUND', `Unknown PartMode tool "${name}".`, { status: 404 });
}

export async function handleMcpRequest(
  rawRequest: unknown,
  identity: AgentIdentity,
  hub: RelayHub,
  release: ReleaseManifest,
  help: PartModeHelpManifest,
  requestProtocolVersion?: string,
  headless?: HeadlessSessionManager,
): Promise<McpHttpResult> {
  if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid JSON-RPC request.') };
  }
  const request = rawRequest as JsonRpcRequest;
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return { status: 400, body: rpcError(request.id, -32600, 'Invalid JSON-RPC request.') };
  }
  if (
    requestProtocolVersion !== undefined &&
    requestProtocolVersion !== MCP_PROTOCOL_VERSION
  ) {
    return {
      status: 400,
      body: rpcError(
        request.id,
        -32602,
        'The MCP-Protocol-Version header is not supported.',
        {
          requestedProtocolVersion: requestProtocolVersion,
          supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
        },
      ),
    };
  }
  if (request.id === undefined) {
    return { status: 202 };
  }
  if (request.method === 'initialize') {
    const params = request.params && typeof request.params === 'object'
      ? request.params as Record<string, unknown>
      : {};
    const requested = typeof params.protocolVersion === 'string'
      ? params.protocolVersion
      : MCP_PROTOCOL_VERSION;
    if (requested !== MCP_PROTOCOL_VERSION) {
      return {
        status: 200,
        body: rpcError(
          request.id,
          -32602,
          'The requested MCP protocol version is not supported.',
          {
            requestedProtocolVersion: requested,
            supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
          },
        ),
      };
    }
    return {
      status: 200,
      body: rpcResult(request.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: { name: 'PartMode', title: 'PartMode hosted CAD', version: release.version },
        instructions:
          'Read the PartMode Help resources, then choose one session path: list online studios and request visible browser approval, or open an ephemeral server-side session backed by a durable committed document with partmode_headless_open using a key created with the explicit headless grant. Call cad_capabilities before using typed cad_* tools with the returned sessionId. A normal key alone grants no CAD authority; a headless-granted key carries the separately disclosed server-execution consent.',
      }),
    };
  }
  if (request.method === 'ping') return { status: 200, body: rpcResult(request.id, {}) };
  if (request.method === 'resources/list') {
    return {
      status: 200,
      body: rpcResult(request.id, {
        resources: help.resources.map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          title: resource.title,
          description: resource.description,
          mimeType: resource.mimeType,
          annotations: {
            audience: resource.audience.includes('agent') ? ['assistant', 'user'] : ['user'],
            priority: 0.8,
          },
        })),
      }),
    };
  }
  if (request.method === 'resources/read') {
    const params = request.params && typeof request.params === 'object'
      ? request.params as Record<string, unknown>
      : {};
    if (typeof params.uri !== 'string') {
      return { status: 200, body: rpcError(request.id, -32602, 'Resource URI is required.') };
    }
    const resource = help.resources.find((entry) => entry.uri === params.uri);
    if (!resource) {
      return { status: 200, body: rpcError(request.id, -32002, `Resource not found: ${params.uri}`) };
    }
    return {
      status: 200,
      body: rpcResult(request.id, {
        contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }],
      }),
    };
  }
  if (request.method === 'tools/list') {
    return { status: 200, body: rpcResult(request.id, { tools: TOOLS }) };
  }
  if (request.method === 'tools/call') {
    const params = request.params && typeof request.params === 'object'
      ? request.params as Record<string, unknown>
      : {};
    if (typeof params.name !== 'string') {
      return { status: 200, body: toolFailure(request.id, new RelayError('INVALID_ARGUMENTS', 'Tool name is required.')) };
    }
    try {
      const value = await callTool(params.name, params.arguments ?? {}, identity, hub, headless);
      return { status: 200, body: toolSuccess(request.id, value) };
    } catch (error) {
      return { status: 200, body: toolFailure(request.id, error) };
    }
  }
  return { status: 200, body: rpcError(request.id, -32601, `Method not found: ${request.method}`) };
}

export function mcpTools(): readonly McpToolDefinition[] {
  return TOOLS;
}
