// Headless host for the typed CAD op registry.
//
// CadCommandService was written dependency-injected: the exact kernel
// arrives as an adapter, the visible studio is optional, and its imports
// are all relative, so the browser module loads under Node as-is. This
// host supplies the one adapter the service needs (validate through the
// headless kernel) and exposes the same partmode.cad.agent/v1 envelope
// surface the browser relay speaks, plus STEP export through the kernel.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, resolveStaticDir, type KernelMessage } from './kernel-host.js';

export interface HeadlessAgentHost {
  /** partmode.cad.agent/v1 envelope entry, identical to the browser path. */
  request(envelope: KernelMessage): Promise<KernelMessage>;
  /** Export the current committed document (or an explicit one) as STEP. */
  exportStep(options?: { document?: KernelMessage; bodyIds?: string[] }): Promise<KernelMessage>;
  /** The underlying CadCommandService, for direct method access. */
  service: {
    request(envelope: KernelMessage): Promise<KernelMessage>;
    snapshot(): KernelMessage;
    synchronize(project: KernelMessage, revision: number, entry?: KernelMessage | null): KernelMessage;
    journal: Array<Record<string, unknown>>;
    revision: number;
    project: { projectId: string };
  };
  protocol: string;
  dispose(): Promise<void>;
}

export interface HeadlessCadRuntime {
  /** The loaded studio-agent-service.js module (CadCommandService etc.). */
  module: Record<string, any>;
  protocol: string;
  /** Construct one CadCommandService wired to the shared exact kernel. */
  createService(options?: { projectId?: string; name?: string; units?: string }): HeadlessAgentHost['service'];
  /** Export a document as STEP through the shared kernel. */
  exportStep(input: {
    projectId: string;
    revision: number;
    document: KernelMessage;
    bodyIds?: string[];
  }): Promise<KernelMessage>;
  dispose(): Promise<void>;
}

let runtime: Promise<HeadlessCadRuntime> | null = null;

/**
 * One wasm kernel and one loaded op-registry module per process, shared by
 * every headless service instance. Kernel access is serialized inside the
 * kernel host, so services from different sessions cannot interleave
 * rebuilds.
 */
export function createHeadlessCadRuntime(options: { staticDir?: string } = {}): Promise<HeadlessCadRuntime> {
  if (!runtime) {
    const pending = startRuntime(options);
    runtime = pending;
    void pending.catch(() => {
      if (runtime === pending) runtime = null;
    });
  }
  return runtime;
}

async function startRuntime(options: { staticDir?: string }): Promise<HeadlessCadRuntime> {
  const staticDir = resolveStaticDir(options.staticDir);
  const kernel = await createHeadlessKernel({ staticDir });
  await kernel.waitForKernel();
  const agentModule = await import(pathToFileURL(path.join(staticDir, 'studio-agent-service.js')).href);

  let sequence = 0;
  const kernelAdapter = {
    validate: (document: KernelMessage, revision: number) =>
      kernel.request({
        kind: 'validate-v5',
        requestId: `headless-agent-validate-${++sequence}`,
        projectId: document.projectId,
        revision,
        document,
      }),
  };

  return {
    module: agentModule,
    protocol: agentModule.CAD_AGENT_PROTOCOL,
    createService: (serviceOptions = {}) =>
      new agentModule.CadCommandService({
        kernel: kernelAdapter,
        ...(serviceOptions.projectId ? { projectId: serviceOptions.projectId } : {}),
        ...(serviceOptions.name ? { name: serviceOptions.name } : {}),
        ...(serviceOptions.units ? { units: serviceOptions.units } : {}),
      }),
    exportStep: (input) =>
      kernel.request({
        kind: 'export-step',
        requestId: `headless-agent-export-${++sequence}`,
        projectId: input.projectId,
        revision: input.revision,
        document: input.document,
        ...(input.bodyIds ? { bodyIds: input.bodyIds } : {}),
      }),
    dispose: async () => {
      runtime = null;
      await kernel.dispose();
    },
  };
}

export async function createHeadlessAgentHost(
  options: { staticDir?: string; projectId?: string; name?: string; units?: string } = {},
): Promise<HeadlessAgentHost> {
  const shared = await createHeadlessCadRuntime(
    options.staticDir ? { staticDir: options.staticDir } : {},
  );
  const service = shared.createService({
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.name ? { name: options.name } : {}),
    ...(options.units ? { units: options.units } : {}),
  });

  return {
    service,
    protocol: shared.protocol,
    request: (envelope) => service.request(envelope),
    exportStep: (exportOptions = {}) =>
      shared.exportStep({
        projectId: service.project.projectId,
        revision: service.revision,
        document: (exportOptions.document ?? service.snapshot()) as KernelMessage,
        ...(exportOptions.bodyIds ? { bodyIds: exportOptions.bodyIds } : {}),
      }),
    dispose: () => shared.dispose(),
  };
}
