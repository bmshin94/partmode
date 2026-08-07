// Proves the typed CAD op registry executes without a browser: the exact
// partmode.cad.agent/v1 envelope surface (capabilities, sketch.solve,
// preview, commit, exact-geometry query) runs under plain Node against the
// headless kernel, ending in a hashed STEP export of the committed document.
import { createHash } from 'node:crypto';
import { createHeadlessAgentHost } from '../src/headless/agent-host.js';

function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`Agent headless smoke failed: ${name}`);
}

const host = await createHeadlessAgentHost({ projectId: 'agent-headless-smoke', name: 'Headless plate' });
const permissionContext = { granted: ['project.read', 'project.edit'] };
let requestSequence = 0;
const envelope = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  protocol: host.protocol,
  requestId: `smoke-${++requestSequence}`,
  sessionId: 'session-headless-smoke',
  permissionContext,
  payload,
  ...extra,
});

const capabilities = await host.request(envelope({ kind: 'capabilities' }));
check('capabilities reports ok', capabilities.status === 'ok');
const manifest = capabilities.result as Record<string, any>;
const stepExport = (manifest.exports as Array<Record<string, any>>)?.find((entry) => entry.format === 'step');
check('exact kernel enables STEP export capability', stepExport?.state === 'available');
check(
  'sketch.solve query is offered',
  (manifest.queries as Array<Record<string, any>>)?.some((entry) => entry.kind === 'sketch.solve'),
);

// Fully constrained 40x30 rectangle: fixed corner, horizontal/vertical
// pairs, two driving dimensions. The solver must report zero DOF and one
// closed loop.
const solved = await host.request(
  envelope({
    kind: 'query',
    query: {
      kind: 'sketch.solve',
      sketch: {
        entities: [
          { id: 'p1', kind: 'point', at: [0, 0], fixed: true },
          { id: 'p2', kind: 'point', at: [38, 1] },
          { id: 'p3', kind: 'point', at: [39, 29] },
          { id: 'p4', kind: 'point', at: [1, 31] },
          { id: 'l1', kind: 'line', a: 'p1', b: 'p2' },
          { id: 'l2', kind: 'line', a: 'p2', b: 'p3' },
          { id: 'l3', kind: 'line', a: 'p3', b: 'p4' },
          { id: 'l4', kind: 'line', a: 'p4', b: 'p1' },
        ],
        constraints: [
          { kind: 'horizontal', line: 'l1' },
          { kind: 'horizontal', line: 'l3' },
          { kind: 'vertical', line: 'l2' },
          { kind: 'vertical', line: 'l4' },
          { kind: 'length', line: 'l1', value: 40 },
          { kind: 'length', line: 'l2', value: 30 },
          { id: 'diagonal-reference', kind: 'distance', a: 'p1', b: 'p3', driving: false },
        ],
      },
    },
  }),
);
check('sketch.solve reports ok', solved.status === 'ok');
const sketchResult = solved.result as Record<string, any>;
check('sketch solves', sketchResult.status === 'ok');
check(`sketch is fully defined (dof=${sketchResult.dof})`, sketchResult.fullyDefined === true && sketchResult.dof === 0);
check('reference dimension does not add a solver equation', sketchResult.equations === 6);
check('typed query reports the measured diagonal reference dimension',
  sketchResult.referenceDimensions?.length === 1
  && sketchResult.referenceDimensions[0]?.id === 'diagonal-reference'
  && Math.abs(sketchResult.referenceDimensions[0]?.value - 50) <= 1e-8);
check('sketch profiles close', sketchResult.profilesClosed === true && sketchResult.loops.length === 1);

const preview = await host.request(
  envelope({
    kind: 'preview',
    transaction: {
      transactionId: 'tx-headless-plate',
      label: 'Base plate 40x30x8',
      expectedRevision: 0,
      atomic: true,
      operations: [
        {
          kind: 'feature.extrude',
          input: {
            name: 'Plate',
            sketch: { shapes: [{ kind: 'rect', x: 0, y: 0, w: 40, h: 30 }] },
            h: 8,
          },
        },
      ],
    },
  }),
);
check('preview reports ok', preview.status === 'ok');
const previewResult = preview.result as Record<string, any>;
check('preview returns a previewId', typeof previewResult.previewId === 'string');
check('preview evidence is exact-kernel', previewResult.evidence?.exactGeometry === true);
const previewBodies = previewResult.evidence?.bodyResults as Array<Record<string, any>>;
check(
  'preview evidence shows one valid solid',
  Array.isArray(previewBodies) && previewBodies.length === 1 && previewBodies[0]?.valid === true && previewBodies[0]?.solids === 1,
);

const commit = await host.request(
  envelope({ kind: 'commit', previewId: previewResult.previewId }, { expectedRevision: 0 }),
);
check('commit reports ok', commit.status === 'ok');
const commitResult = commit.result as Record<string, any>;
check('commit advances to revision 1', commitResult.revision === 1 && host.service.revision === 1);
check('commit carries the change set document hash', typeof commitResult.changeSet?.documentHashAfter === 'string');

const validity = await host.request(
  envelope({ kind: 'query', query: { kind: 'geometry.validity', exact: true } }),
);
check('exact validity reports ok', validity.status === 'ok');
const validityResult = validity.result as Record<string, any>;
check(
  'committed document is valid exact geometry',
  validityResult.exactGeometry === true && validityResult.valid === true && validityResult.bodies.length === 1,
);

const exported = await host.exportStep();
const exportErrors = exported.errors as Array<{ message?: string }> | undefined;
check(
  `export has no errors (${(exportErrors ?? []).map((error) => error.message).join('; ') || 'none'})`,
  Array.isArray(exportErrors) && exportErrors.length === 0,
);
check('export returns a non-empty STEP blob', exported.blob instanceof Blob && exported.blob.size > 0);
const stepBytes = Buffer.from(await (exported.blob as Blob).arrayBuffer());
check('STEP payload is ISO 10303-21', stepBytes.toString('utf8', 0, 32).startsWith('ISO-10303-21'));

console.log(
  JSON.stringify({
    ok: true,
    protocol: host.protocol,
    capabilities: { exactKernel: true },
    sketchSolve: {
      dof: sketchResult.dof,
      fullyDefined: sketchResult.fullyDefined,
      iterations: sketchResult.iterations,
      residual: sketchResult.residual,
      loops: sketchResult.loops.length,
    },
    commit: {
      revision: commitResult.revision,
      documentHash: commitResult.changeSet.documentHashAfter,
      bodies: previewBodies.map((body) => ({ name: body.body?.name, solids: body.solids, faces: body.faces, volume: body.volume ?? null })),
    },
    step: { bytes: stepBytes.byteLength, sha256: createHash('sha256').update(stepBytes).digest('hex') },
  }),
);
host.dispose();
// The wasm runtime and the module-hooks thread can hold the event loop open;
// evidence is printed, so end the process explicitly.
process.exit(0);
