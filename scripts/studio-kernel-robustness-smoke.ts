import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

type ExactFixture = {
  captured: JsonRecord;
  sourceBrepSha256: string;
  seedEdgeName: string;
  seedSignature: JsonRecord;
  unfilletableEdgeName: string;
  unfilletableSignature: JsonRecord;
  direct: {
    contourEdgeCount: number;
    closedAndTangent: boolean;
    resultBrepSha256: string;
    topology: { faces: number; edges: number; vertices: number };
  };
};

const SCHEMA = 'partmode.kernel-robustness/v1';
const POLICY = 'occt-exact-tangent-contour-v1';
const CLOSED_CHAIN_EDGES = 8;
const OPEN_CHAIN_EDGES = 3;
const BODY_ID = 'body-kernel-robustness';
const IMPORT_FEATURE_ID = 'feature-kernel-robustness-import';
const FILLET_FEATURE_ID = 'feature-kernel-robustness-fillet';
const RESOURCE_ID = 'resource-kernel-robustness-brep';

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Studio kernel robustness smoke failed: ${label}`);
}

function safeDelete(value: any): void {
  try { value?.delete?.(); } catch {}
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorCode(error: unknown): string {
  return String((error as JsonRecord)?.code || '');
}

function expectThrow(
  label: string,
  action: () => unknown,
  acceptedCodes: string[],
  messagePattern?: RegExp,
): Error {
  let thrown: unknown = null;
  try { action(); } catch (error) { thrown = error; }
  check(`${label} did not throw`, thrown instanceof Error);
  check(
    `${label} returned code ${errorCode(thrown)} instead of ${acceptedCodes.join(' or ')}`,
    acceptedCodes.includes(errorCode(thrown)),
  );
  if (messagePattern) check(`${label} returned an unexpected message`, messagePattern.test(thrown.message));
  return thrown;
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const vendorDirectory = resolve(root, 'src/static/vendor');
const globals = globalThis as typeof globalThis & {
  require: ReturnType<typeof createRequire>;
  __dirname: string;
};
globals.require = createRequire(import.meta.url);
globals.__dirname = vendorDirectory;

const rc = await moduleAt('src/static/vendor/replicad.module.js');
const ocFactory = await moduleAt('src/static/vendor/replicad-oc.module.js');
const importedRegistryModule = await moduleAt('src/static/studio-imported-topology-registry.js');
const robustnessModule = await moduleAt('src/static/studio-kernel-robustness.js');
const topologyModule = await moduleAt('src/static/studio-topo-naming.js');
const brepEvidenceModule = await moduleAt('src/static/studio-brep-evidence.js');
const projectModule = await moduleAt('src/static/studio-project-v5.js');
const runtimeModule = await moduleAt('src/static/studio-v5-runtime-document.js');
const agentModule = await moduleAt('src/static/studio-agent-service.js');
const uiRegistryModule = await moduleAt('src/static/studio-v6-ui-registry.js');
const uiInteractionModule = await moduleAt('src/static/studio-v6-interaction.js');
const featureTypesModule = await moduleAt('src/static/studio-v5-feature-types.js');

const oc = await ocFactory.default({
  locateFile: () => resolve(vendorDirectory, 'replicad_single.wasm'),
});
rc.setOC(oc);
const importedRegistry = importedRegistryModule.createStudioImportedTopologyRegistry(rc);
const robustness = robustnessModule.createStudioKernelRobustness(rc);
const topology = topologyModule.createStudioTopoNaming(rc);

function closedRoundedRectangle(): any {
  const sketch = rc.sketchRoundedRectangle(20, 10, 2, { plane: 'XY' });
  try { return sketch.extrude(8); }
  finally { safeDelete(sketch); }
}

function openThreeEdgeChain(): any {
  // Only the upper-left corner is rounded. The top line, quarter arc, and left
  // line are one open tangent contour; the sharp corners terminate both ends.
  const drawing = rc.draw([-10, -5])
    .hLine(20)
    .vLine(10)
    .hLine(-20)
    .customCorner(2)
    .vLine(-10)
    .close();
  const sketch = drawing.sketchOnPlane('XY');
  try { return sketch.extrude(8); }
  finally { safeDelete(sketch); }
}

function pointTuple(value: any): number[] {
  return [Number(value.x ?? value[0]), Number(value.y ?? value[1]), Number(value.z ?? value[2])];
}

function exactEdgeSignature(edge: any): JsonRecord {
  let point: any = null;
  try {
    point = edge.pointAt(0.5);
    return {
      p: pointTuple(point).map((value) => Math.round(value * 100) / 100),
      l: Math.round(Number(edge.length) * 100) / 100,
      curveType: String(edge.geomType),
    };
  } finally {
    safeDelete(point);
  }
}

function exactCounts(shape: any): { faces: number; edges: number; vertices: number } {
  const faces = topology.exactFaces(shape);
  const edges = topology.exactEdges(shape);
  const vertices = topology.exactVertices(shape);
  try { return { faces: faces.length, edges: edges.length, vertices: vertices.length }; }
  finally {
    topology.disposeWrappers(vertices);
    topology.disposeWrappers(edges);
    topology.disposeWrappers(faces);
  }
}

function directContourFixture(
  label: string,
  sourceShape: any,
  expectedContourEdges: number,
  expectedClosedAndTangent: boolean,
): ExactFixture {
  const captured = importedRegistry.capture({
    shape: sourceShape,
    registryId: `resource-kernel-robustness-${label}`,
  });
  const restored = importedRegistry.restore({
    sourceBrep: captured.sourceBrep,
    registry: captured.registry,
    expectedRegistryRef: captured.featureReference,
  });
  let outcome: JsonRecord | null = null;
  let serialized: JsonRecord | null = null;
  let analyzer: any = null;
  try {
    check(`${label} imported carrier emitted diagnostics`, restored.diagnostics.length === 0);
    const edgeCandidates = restored.names.edges.map((entry: JsonRecord) => entry.edge);
    const edgeNameFor = (edge: any): string | null => {
      const matches = restored.names.edges.filter((entry: JsonRecord) => entry.edge.wrapped.IsSame(edge.wrapped));
      check(`${label} exact edge identity is not one-to-one`, matches.length === 1);
      return matches[0].name;
    };
    const context = {
      featureId: `feature-direct-${label}`,
      documentHash: sha256(`partmode-direct-${label}-document`),
      sourceBrepSha256: sha256(brepEvidenceModule.canonicalStudioBrepEvidence(rc, restored.shape)),
    };
    let plan: JsonRecord | null = null;
    let seedEntry: JsonRecord | null = null;
    let unfilletableEntry: JsonRecord | null = null;
    for (const entry of restored.names.edges) {
      try {
        const candidate = robustness.planTangentFillet(
          restored.shape,
          [{ edge: entry.edge, edgeName: entry.name, radii: 1 }],
          edgeCandidates,
          edgeNameFor,
          context,
        );
        if (!plan && candidate.evidence.contours[0]?.edgeCount === expectedContourEdges) {
          plan = candidate;
          seedEntry = entry;
        }
      } catch (error) {
        if (!unfilletableEntry && errorCode(error) === 'TANGENT_CHAIN_UNRESOLVED') {
          unfilletableEntry = entry;
        }
      }
    }
    check(`${label} did not expose an exact ${expectedContourEdges}-edge contour`, plan && seedEntry);
    check(`${label} did not expose a genuinely unfilletable exact seed`, unfilletableEntry);
    const contour = plan.evidence.contours[0];
    check(`${label} evidence schema/policy changed`, plan.evidence.schema === SCHEMA
      && plan.evidence.policy === POLICY && plan.evidence.mode === 'tangent-chain-fillet');
    check(`${label} contour cardinality is wrong`, plan.evidence.contourCount === 1
      && contour.edgeCount === expectedContourEdges
      && plan.picks.length === expectedContourEdges
      && plan.evidence.expandedEdgeNames.length === expectedContourEdges);
    check(`${label} contour closure classification is wrong`, contour.closedAndTangent === expectedClosedAndTangent);
    check(`${label} selected seed is absent from exact expansion`, contour.edgeNames.includes(seedEntry.name)
      && plan.evidence.selectedEdgeNames.length === 1 && plan.evidence.selectedEdgeNames[0] === seedEntry.name);
    check(`${label} expansion repeated an exact persistent edge`,
      new Set(plan.evidence.expandedEdgeNames).size === expectedContourEdges);

    const sourceBeforeFailures = brepEvidenceModule.canonicalStudioBrepEvidence(rc, restored.shape);
    const otherName = restored.names.edges.find((entry: JsonRecord) => entry.name !== seedEntry.name)?.name;
    check(`${label} lacks a second edge for mismatch coverage`, otherName);
    expectThrow(`${label} mismatched persistent seed`, () => robustness.planTangentFillet(
      restored.shape,
      [{ edge: seedEntry!.edge, edgeName: otherName, radii: 1 }],
      edgeCandidates,
      edgeNameFor,
      context,
    ), ['TANGENT_CHAIN_REFERENCE_MISMATCH']);
    expectThrow(`${label} missing persistent seed name`, () => robustness.planTangentFillet(
      restored.shape,
      [{ edge: seedEntry!.edge, edgeName: '', radii: 1 }],
      edgeCandidates,
      edgeNameFor,
      context,
    ), ['TANGENT_CHAIN_REFERENCE_UNNAMED']);
    expectThrow(`${label} variable-radius propagation`, () => robustness.planTangentFillet(
      restored.shape,
      [{ edge: seedEntry!.edge, edgeName: seedEntry!.name, radii: [1, 1.5] }],
      edgeCandidates,
      edgeNameFor,
      context,
    ), ['TANGENT_CHAIN_VARIABLE_RADIUS_UNSUPPORTED']);
    expectThrow(`${label} duplicate exact seed`, () => robustness.planTangentFillet(
      restored.shape,
      [
        { edge: seedEntry!.edge, edgeName: seedEntry!.name, radii: 1 },
        { edge: seedEntry!.edge, edgeName: seedEntry!.name, radii: 1 },
      ],
      edgeCandidates,
      edgeNameFor,
      context,
    ), ['TANGENT_CHAIN_REFERENCE_DUPLICATE']);
    expectThrow(`${label} unfilletable exact seed`, () => robustness.planTangentFillet(
      restored.shape,
      [{ edge: unfilletableEntry!.edge, edgeName: unfilletableEntry!.name, radii: 1 }],
      edgeCandidates,
      edgeNameFor,
      context,
    ), ['TANGENT_CHAIN_UNRESOLVED', 'TANGENT_CHAIN_KERNEL_REJECTED']);
    expectThrow(`${label} excessive-radius tangent chain`, () => robustness.planTangentFillet(
      restored.shape,
      [{ edge: seedEntry!.edge, edgeName: seedEntry!.name, radii: 100 }],
      edgeCandidates,
      edgeNameFor,
      context,
    ), ['TANGENT_CHAIN_UNRESOLVED', 'TANGENT_CHAIN_KERNEL_REJECTED']);
    check(`${label} refusal probes mutated the exact source`,
      brepEvidenceModule.canonicalStudioBrepEvidence(rc, restored.shape) === sourceBeforeFailures);

    // Imported names are real carrier-restored persistent names. Explicit edge
    // and vertex tables exercise the same complete propagation path as the
    // production imported-step feature checkpoint.
    const faceTable = restored.names.faces;
    faceTable.explicitEdgeTable = restored.names.edges;
    faceTable.explicitVertexTable = restored.names.vertices;
    const builtOutcome = topology.filletChamferWithNames(
      'fillet',
      restored.shape,
      plan.picks,
      faceTable,
      `feature-direct-${label}`,
    );
    outcome = builtOutcome;
    analyzer = new oc.BRepCheck_Analyzer(builtOutcome.shape.wrapped, true, false);
    check(`${label} exact tangent result is not BRepCheck-valid`, analyzer.IsValid_2() === true);
    const serializedNames = topology.serializationNames(builtOutcome.shape, builtOutcome.names);
    serialized = serializedNames;
    const counts = exactCounts(builtOutcome.shape);
    const diagnostics = [
      ...(builtOutcome.names.diagnostics || []),
      ...(serializedNames.diagnostics || []),
    ];
    check(`${label} topology propagation emitted diagnostics: ${JSON.stringify(diagnostics)}`,
      diagnostics.length === 0);
    check(`${label} face naming is incomplete`, builtOutcome.names.length === counts.faces);
    check(`${label} edge naming is incomplete`, serializedNames.edgeTable.length === counts.edges);
    check(`${label} vertex naming is incomplete`, serializedNames.vertexTable.length === counts.vertices);
    check(`${label} generated topology names are not unique`,
      new Set(builtOutcome.names.map((entry: JsonRecord) => entry.name)).size === counts.faces
      && new Set(serializedNames.edgeTable.map((entry: JsonRecord) => entry.name)).size === counts.edges
      && new Set(serializedNames.vertexTable.map((entry: JsonRecord) => entry.name)).size === counts.vertices);
    const resultEvidence = brepEvidenceModule.canonicalStudioBrepEvidence(rc, builtOutcome.shape);
    check(`${label} successful fillet mutated its exact source`,
      brepEvidenceModule.canonicalStudioBrepEvidence(rc, restored.shape) === sourceBeforeFailures);
    return {
      captured,
      sourceBrepSha256: context.sourceBrepSha256,
      seedEdgeName: seedEntry.name,
      seedSignature: exactEdgeSignature(seedEntry.edge),
      unfilletableEdgeName: unfilletableEntry.name,
      unfilletableSignature: exactEdgeSignature(unfilletableEntry.edge),
      direct: {
        contourEdgeCount: expectedContourEdges,
        closedAndTangent: expectedClosedAndTangent,
        resultBrepSha256: sha256(resultEvidence),
        topology: counts,
      },
    };
  } finally {
    safeDelete(analyzer);
    serialized?.dispose?.();
    if (outcome) {
      topology.disposeTable(outcome.names);
      safeDelete(outcome.shape);
    }
    importedRegistry.disposeOutcome(restored);
    safeDelete(sourceShape);
  }
}

const closedFixture = directContourFixture(
  'closed',
  closedRoundedRectangle(),
  CLOSED_CHAIN_EDGES,
  true,
);
const openFixture = directContourFixture(
  'open',
  openThreeEdgeChain(),
  OPEN_CHAIN_EDGES,
  false,
);

function importedRoundedRectangleProject(fixture: ExactFixture): JsonRecord {
  const brep = fixture.captured.sourceBrep;
  const registry = fixture.captured.registry;
  return projectModule.prepareStudioV5Project({
    schemaVersion: 5,
    projectId: 'project-kernel-robustness',
    name: 'Kernel robustness tangent-chain acceptance',
    units: 'mm',
    parameters: [],
    materials: [],
    partDefinitions: [{
      id: 'part-kernel-robustness',
      name: 'Imported rounded rectangle',
      parameters: [],
      referenceGeometry: [],
      sketches: [],
      bodies: [{
        id: BODY_ID,
        name: 'Imported rounded rectangle',
        kind: 'solid',
        createdByFeatureId: IMPORT_FEATURE_ID,
        featureIds: [IMPORT_FEATURE_ID],
        visible: true,
        suppressed: false,
      }],
      bodyPatterns: [],
      features: [{
        id: IMPORT_FEATURE_ID,
        name: 'Imported rounded rectangle',
        type: 'imported-step',
        suppressed: false,
        inputRefs: [],
        resultPolicy: { kind: 'new-body', bodyName: 'Imported rounded rectangle' },
        createdBodyId: BODY_ID,
        extensions: {
          studioImportedStep: {
            resourceId: RESOURCE_ID,
            exactBrep: true,
            parametricHistory: false,
            topologyRegistry: fixture.captured.featureReference,
          },
        },
      }],
      featureOrder: [IMPORT_FEATURE_ID],
      metadata: { activeBodyId: BODY_ID, importedFromStep: true },
      extensions: { studioImportedStep: { exactBrep: true, parametricHistory: false } },
    }],
    assemblyDefinitions: [],
    rootDocument: { kind: 'part', partId: 'part-kernel-robustness' },
    resources: [{
      id: RESOURCE_ID,
      name: 'Rounded rectangle exact B-rep',
      mimeType: 'text/plain',
      byteLength: Buffer.byteLength(brep, 'utf8'),
      encoding: 'base64',
      data: Buffer.from(brep, 'utf8').toString('base64'),
      extensions: {
        studioImportedStep: {
          source: 'runtime-generated-exact-brep',
          topologyRegistryByteLength: Buffer.byteLength(registry.carrierBrep, 'utf8'),
          topologyRegistry: registry,
        },
      },
    }],
    metadata: { acceptance: 'kernel-robustness-tangent-chain' },
  });
}

function rootPart(document: JsonRecord): JsonRecord {
  const part = runtimeModule.studioV5RootPart(document);
  check('root part is missing', part);
  return part;
}

function canonicalReopen(document: JsonRecord, label: string): JsonRecord {
  const canonical = JSON.stringify(projectModule.prepareStudioV5Project(document));
  const reopened = runtimeModule.parseStudioV5RuntimeProject(canonical);
  check(`${label} changed across canonical save/reopen`, JSON.stringify(reopened) === canonical);
  return reopened;
}

function transaction(source: JsonRecord, id: string, operations: JsonRecord[]): JsonRecord {
  return agentModule.applyCadTransaction(source, {
    transactionId: id,
    label: id,
    expectedRevision: 0,
    atomic: true,
    operations,
  }).project;
}

function rejectedTransaction(
  label: string,
  source: JsonRecord,
  operations: JsonRecord[],
  messagePattern: RegExp,
): void {
  const before = JSON.stringify(source);
  let thrown: unknown = null;
  try { transaction(source, `reject-${label}`, operations); } catch (error) { thrown = error; }
  const message = String((thrown as JsonRecord)?.message || thrown || '');
  check(`${label} transaction did not fail with the expected reason; received ${message || 'no error'}`,
    thrown != null && messagePattern.test(message));
  check(`${label} transaction mutated its source`, JSON.stringify(source) === before);
}

const baseProject = canonicalReopen(importedRoundedRectangleProject(closedFixture), 'imported source');
const filletCommand = uiRegistryModule.cadUiCommandDefinition('model.fillet');
check('visible Fillet command is not strictly available', filletCommand?.adapter === 'available'
  && filletCommand.workspaceId === 'solid'
  && filletCommand.fieldContract === 'typed'
  && JSON.stringify(filletCommand.operationKinds) === JSON.stringify(['feature.fillet']));
check('visible Fillet command has no exact tangent-chain boolean',
  filletCommand.fields.some((field: JsonRecord) => field.id === 'tangentPropagation'
    && field.kind === 'boolean' && /tangent chain/iu.test(field.label)));
check('visible Fillet command lost its edge/radius fields',
  filletCommand.fields.some((field: JsonRecord) => field.id === 'edges' && field.required === true)
  && filletCommand.fields.some((field: JsonRecord) => field.id === 'radius' && field.required === true));

const [pageSource, studioSource] = await Promise.all([
  readFile(resolve(root, 'src/page.html'), 'utf8'),
  readFile(resolve(root, 'src/static/studio.js'), 'utf8'),
]);
check('visible human tangent-chain checkbox is absent',
  pageSource.includes('id="bw-pick-tangent"')
  && pageSource.includes('name="tangentPropagation"')
  && pageSource.includes('Propagate exact tangent chain'));
check('visible human draft does not retain the tangent checkbox value',
  /base\.inputValues\s*=\s*\{[^}]*radius:[^}]*tangentPropagation:/su.test(studioSource));

const stableSeedId = uiInteractionModule.cadUiTopologyStableId(
  closedFixture.seedEdgeName,
  `fallback-${closedFixture.seedEdgeName}`,
);
const visible = uiInteractionModule.buildCadUiCommandTransaction({
  expectedRevision: 0,
  transactionId: 'visible-tangent-chain-fillet',
  draft: {
    commandId: 'model.fillet',
    draftId: 'draft-visible-tangent-chain-fillet',
    baseRevision: 0,
    inputValues: { radius: 1, tangentPropagation: true },
    boundSelections: {
      edges: [{
        owner: { kind: 'body', id: BODY_ID },
        stableId: stableSeedId,
        topologySignature: { kind: 'edge', ...closedFixture.seedSignature },
      }],
    },
    generatedIds: { featureId: FILLET_FEATURE_ID },
    bootstrapOperations: [],
  },
}).transaction;
check('visible interaction did not emit one typed Fillet operation', visible.operations.length === 1
  && visible.operations[0].kind === 'feature.fillet');
const visibleInput = visible.operations[0].input;
check('visible interaction dropped exact tangent-chain intent', visibleInput.tangentPropagation === true);
check('visible interaction dropped the persistent seed name', visibleInput.edges.length === 1
  && visibleInput.edges[0].name === closedFixture.seedEdgeName);
check('visible interaction targeted the wrong exact body',
  JSON.stringify(visibleInput.resultPolicy) === JSON.stringify({ kind: 'add', targetBodyIds: [BODY_ID] }));

const createdProject = agentModule.applyCadTransaction(baseProject, visible).project;
const createdFeature = rootPart(createdProject).features.find((feature: JsonRecord) => feature.id === FILLET_FEATURE_ID);
check('typed create did not persist tangent-chain intent', createdFeature?.type === 'fillet'
  && createdFeature.tangentPropagation === true && createdFeature.r === 1);
check('typed create did not persist the exact seed name', createdFeature.edges.length === 1
  && createdFeature.edges[0].name === closedFixture.seedEdgeName);
check('typed create did not persist the exact kernel-robustness policy',
  JSON.stringify(createdFeature.extensions?.kernelRobustness) === JSON.stringify({
    schema: SCHEMA,
    tangentFilletPolicy: POLICY,
  }));
check('typed create did not attach the feature to the target body',
  rootPart(createdProject).bodies.find((body: JsonRecord) => body.id === BODY_ID)?.featureIds.at(-1) === FILLET_FEATURE_ID);
featureTypesModule.assertStudioV5FeatureStructure(createdFeature, 'stored-tangent-chain-fillet');
const createdReopened = canonicalReopen(createdProject, 'created tangent-chain fillet');

const editedProject = canonicalReopen(transaction(createdReopened, 'edit-tangent-chain-radius', [{
  kind: 'feature.update',
  input: { featureId: FILLET_FEATURE_ID, patch: { r: 1.5 } },
}]), 'edited tangent-chain fillet');
const editedFeature = rootPart(editedProject).features.find((feature: JsonRecord) => feature.id === FILLET_FEATURE_ID);
check('typed update lost tangent-chain identity', editedFeature?.r === 1.5
  && editedFeature.tangentPropagation === true
  && editedFeature.edges[0].name === closedFixture.seedEdgeName);

const deletedProject = canonicalReopen(transaction(editedProject, 'delete-tangent-chain-fillet', [{
  kind: 'feature.delete', input: { featureId: FILLET_FEATURE_ID },
}]), 'deleted tangent-chain fillet');
check('typed delete retained the Fillet feature',
  !rootPart(deletedProject).features.some((feature: JsonRecord) => feature.id === FILLET_FEATURE_ID));
check('typed delete retained the Fillet body-history reference',
  !rootPart(deletedProject).bodies.find((body: JsonRecord) => body.id === BODY_ID)?.featureIds.includes(FILLET_FEATURE_ID));

const tangentInput = (overrides: JsonRecord = {}): JsonRecord => ({
  id: FILLET_FEATURE_ID,
  name: 'Exact tangent-chain fillet',
  radius: 1,
  edges: [{ name: closedFixture.seedEdgeName, sig: clone(closedFixture.seedSignature) }],
  tangentPropagation: true,
  resultPolicy: { kind: 'add', targetBodyIds: [BODY_ID] },
  ...overrides,
});

rejectedTransaction('unnamed tangent seed', baseProject, [{
  kind: 'feature.fillet',
  input: tangentInput({ edges: [clone(closedFixture.seedSignature)] }),
}], /persistent|name|tangent-chain/iu);
rejectedTransaction('duplicate tangent seeds', baseProject, [{
  kind: 'feature.fillet',
  input: tangentInput({
    edges: [
      { name: closedFixture.seedEdgeName, sig: clone(closedFixture.seedSignature) },
      { name: closedFixture.seedEdgeName, sig: clone(closedFixture.seedSignature) },
    ],
  }),
}], /duplicate tangent-chain seed/iu);
rejectedTransaction('variable-radius tangent propagation', baseProject, [{
  kind: 'feature.variableFillet',
  input: {
    id: FILLET_FEATURE_ID,
    bodyId: BODY_ID,
    edgeRefs: [{ name: closedFixture.seedEdgeName, sig: clone(closedFixture.seedSignature) }],
    variableRadii: [{
      edge: { name: closedFixture.seedEdgeName, sig: clone(closedFixture.seedSignature) },
      startRadius: 1,
      endRadius: 1.5,
    }],
    tangentPropagation: true,
  },
}], /tangentPropagation|tangent propagation|exact tangent-chain|const|false|schema/iu);

function projectWithTangentFillet(input: JsonRecord, label: string): JsonRecord {
  const project = transaction(baseProject, `create-${label}`, [{ kind: 'feature.fillet', input }]);
  project.projectId = baseProject.projectId;
  return canonicalReopen(project, label);
}

const missingSeedProject = projectWithTangentFillet(tangentInput({
  edges: [{ name: 'edge-that-does-not-exist', sig: clone(closedFixture.seedSignature) }],
}), 'missing persistent seed');
const unfilletableProject = projectWithTangentFillet(tangentInput({
  edges: [{
    name: closedFixture.unfilletableEdgeName,
    sig: clone(closedFixture.unfilletableSignature),
  }],
}), 'unfilletable exact seed');
const excessiveRadiusProject = projectWithTangentFillet(tangentInput({ radius: 100 }), 'excessive tangent radius');

function oneBody(result: JsonRecord, label: string): JsonRecord {
  check(`${label} did not return a rebuild result`, result.kind === 'rebuild-result');
  check(`${label} did not return one body`, result.bodies?.length === 1);
  return result.bodies[0];
}

function assertExactBody(result: JsonRecord, label: string): JsonRecord {
  check(`${label} rebuild errors: ${JSON.stringify(result.errors || [])}`, result.errors?.length === 0);
  const body = oneBody(result, label);
  const counts = body.mesh?.topologyCounts;
  check(`${label} did not publish one current exact valid solid`, body.error == null
    && body.lastValid === false
    && body.geometry?.valid === true
    && body.geometry?.brepValid === true
    && body.geometry?.solidCount === 1
    && body.geometry?.shellCount === 1
    && Number(body.geometry?.volume) > 0
    && typeof body.exactBrep === 'string'
    && body.exactBrep.length > 100);
  check(`${label} persistent topology is incomplete`, counts?.faces === counts?.namedFaces
    && counts?.edges === counts?.namedEdges
    && counts?.vertices === counts?.namedVertices);
  check(`${label} persistent topology has diagnostics`,
    counts?.diagnosticCount == null || counts.diagnosticCount === 0);
  return body;
}

function assertRejectedBody(
  result: JsonRecord,
  label: string,
  acceptedCodes: string[],
): JsonRecord {
  const failure = result.errors?.find((entry: JsonRecord) => entry.featureId === FILLET_FEATURE_ID);
  check(`${label} did not report the tangent-chain feature failure`, failure);
  check(`${label} returned code ${failure.code}`, acceptedCodes.includes(failure.code));
  const body = oneBody(result, label);
  check(`${label} leaked last-valid or failed geometry`, body.error
    && body.lastValid === false
    && body.geometry == null
    && body.mesh == null
    && body.exactBrep == null
    && !body.kernelRobustnessEvidence);
  return failure;
}

let revision = 0;
const rebuild = async (kernel: HeadlessKernel, document: JsonRecord, label: string): Promise<JsonRecord> => {
  revision += 1;
  return kernel.request({
    kind: 'rebuild',
    requestId: `kernel-robustness-${revision}-${label}`,
    projectId: document.projectId,
    revision,
    document,
    includeExactBrep: true,
  }, 180_000) as Promise<JsonRecord>;
};

function exactRobustnessEvidence(
  body: JsonRecord,
  document: JsonRecord,
  label: string,
  expectedSourceBrepSha256: string,
): JsonRecord {
  check(`${label} did not publish exactly one robustness record`, body.kernelRobustnessEvidence?.length === 1);
  const evidence = body.kernelRobustnessEvidence[0];
  check(`${label} evidence schema/policy changed`, evidence.schema === SCHEMA
    && evidence.policy === POLICY && evidence.mode === 'tangent-chain-fillet');
  check(`${label} evidence lost feature identity`, evidence.featureId === FILLET_FEATURE_ID);
  check(`${label} evidence is not bound to the current canonical document`,
    evidence.documentHash === runtimeModule.studioV5CanonicalHash(document));
  check(`${label} evidence is not bound to the exact source B-rep`,
    evidence.sourceBrepSha256 === expectedSourceBrepSha256);
  check(`${label} evidence is not bound to the published result B-rep`,
    evidence.resultBrepSha256 === sha256(body.exactBrep));
  check(`${label} evidence lost the selected seed`,
    JSON.stringify(evidence.selectedEdgeNames) === JSON.stringify([closedFixture.seedEdgeName]));
  check(`${label} evidence did not expand the closed eight-edge contour`,
    evidence.contourCount === 1
    && evidence.contours[0]?.edgeCount === CLOSED_CHAIN_EDGES
    && evidence.contours[0]?.closedAndTangent === true
    && evidence.expandedEdgeNames.length === CLOSED_CHAIN_EDGES
    && new Set(evidence.expandedEdgeNames).size === CLOSED_CHAIN_EDGES);
  const counts = body.mesh.topologyCounts;
  check(`${label} evidence result topology disagrees with exact serialization`,
    evidence.resultTopology.faces === counts.faces
    && evidence.resultTopology.edges === counts.edges
    && evidence.resultTopology.vertices === counts.vertices);
  return evidence;
}

let warmKernel: HeadlessKernel | null = null;
let freshKernel: HeadlessKernel | null = null;
try {
  warmKernel = await createHeadlessKernel();
  await warmKernel.waitForKernel();

  const baseBody = assertExactBody(await rebuild(warmKernel, baseProject, 'base'), 'base');
  const productionSourceBrepSha256 = sha256(baseBody.exactBrep);
  check('production imported source has no exact B-rep digest',
    /^[0-9a-f]{64}$/u.test(productionSourceBrepSha256));

  const createdBody = assertExactBody(await rebuild(warmKernel, createdReopened, 'created'), 'created');
  const createdEvidence = exactRobustnessEvidence(
    createdBody,
    createdReopened,
    'created',
    productionSourceBrepSha256,
  );
  check('tangent-chain Fillet did not change the exact imported source',
    createdBody.exactBrep !== baseBody.exactBrep
    && createdBody.geometry.volume < baseBody.geometry.volume);

  const editedBody = assertExactBody(await rebuild(warmKernel, editedProject, 'edited'), 'edited');
  const editedEvidence = exactRobustnessEvidence(
    editedBody,
    editedProject,
    'edited',
    productionSourceBrepSha256,
  );
  check('radius edit reused stale exact geometry', editedBody.exactBrep !== createdBody.exactBrep
    && editedBody.geometry.volume !== createdBody.geometry.volume
    && editedEvidence.resultBrepSha256 !== createdEvidence.resultBrepSha256);
  check('radius edit changed the source contour instead of only the result',
    editedEvidence.sourceBrepSha256 === createdEvidence.sourceBrepSha256
    && JSON.stringify(editedEvidence.expandedEdgeNames) === JSON.stringify(createdEvidence.expandedEdgeNames));

  const deletedBody = assertExactBody(await rebuild(warmKernel, deletedProject, 'deleted'), 'deleted');
  check('typed delete did not restore the exact imported source',
    deletedBody.exactBrep === baseBody.exactBrep
    && sha256(deletedBody.exactBrep) === productionSourceBrepSha256
    && !deletedBody.kernelRobustnessEvidence);

  const missingFailure = assertRejectedBody(
    await rebuild(warmKernel, missingSeedProject, 'missing-seed'),
    'missing seed',
    ['TOPOLOGY_REFERENCE_MISSING'],
  );
  const unfilletableFailure = assertRejectedBody(
    await rebuild(warmKernel, unfilletableProject, 'unfilletable-seed'),
    'unfilletable seed',
    ['TANGENT_CHAIN_UNRESOLVED', 'TANGENT_CHAIN_KERNEL_REJECTED'],
  );
  const excessiveFailure = assertRejectedBody(
    await rebuild(warmKernel, excessiveRadiusProject, 'excessive-radius'),
    'excessive radius',
    ['TANGENT_CHAIN_UNRESOLVED', 'TANGENT_CHAIN_KERNEL_REJECTED'],
  );

  freshKernel = await createHeadlessKernel();
  await freshKernel.waitForKernel();
  const freshEditedBody = assertExactBody(await rebuild(freshKernel, editedProject, 'fresh-edited'), 'fresh edited');
  const freshEvidence = exactRobustnessEvidence(
    freshEditedBody,
    editedProject,
    'fresh edited',
    productionSourceBrepSha256,
  );
  check('fresh worker changed exact tangent-chain geometry', freshEditedBody.exactBrep === editedBody.exactBrep);
  check('fresh worker changed digest-bound tangent-chain evidence',
    JSON.stringify(freshEvidence) === JSON.stringify(editedEvidence));

  console.log(JSON.stringify({
    schema: 'partmode.kernel-robustness-smoke/v1',
    directOcct: {
      closed: closedFixture.direct,
      open: openFixture.direct,
    },
    persistence: {
      visibleTransaction: visible.transactionId,
      featureId: FILLET_FEATURE_ID,
      seedEdgeName: closedFixture.seedEdgeName,
      canonicalReopen: true,
      typedLifecycle: ['create', 'update', 'delete'],
    },
    production: {
      sourceBrepSha256: createdEvidence.sourceBrepSha256,
      radiusOneResultBrepSha256: createdEvidence.resultBrepSha256,
      radiusOnePointFiveResultBrepSha256: editedEvidence.resultBrepSha256,
      documentHash: editedEvidence.documentHash,
      expandedEdges: editedEvidence.expandedEdgeNames.length,
      resultTopology: editedEvidence.resultTopology,
      freshWorkerDeterministic: true,
    },
    failureAtomic: {
      direct: [
        'mismatched persistent seed',
        'missing persistent seed name',
        'variable-radius propagation',
        'duplicate seed',
        'unfilletable seed',
        'excessive radius',
      ],
      typed: ['unnamed persistent seed', 'duplicate seed', 'variable-radius propagation'],
      worker: [missingFailure.code, unfilletableFailure.code, excessiveFailure.code],
      publishedFailedGeometry: false,
    },
    excluded: [
      'partial-edge blends',
      'setback and full-round fillets',
      'variable-radius tangent propagation',
      'arbitrary invalid-solid repair',
    ],
  }, null, 2));
} finally {
  await freshKernel?.dispose();
  await warmKernel?.dispose();
}

// The headless module-hooks workers can retain an event-loop handle after the
// exact evidence has been printed. Exit deterministically like adjacent gates.
process.exit(0);
