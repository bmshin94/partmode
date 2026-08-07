import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-assembly-drawing-plan.js')).href;
const {
  assemblyDrawingCanonicalFingerprint,
  createAssemblyDrawingPlan,
  finalizeAssemblyDrawingAnnotations,
} = await import(moduleUrl) as any;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const moved = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
const frontFrame = { direction: [0, -1, 0], xAxis: [1, 0, 0], yAxis: [0, 0, 1] };
const frontCameraTransform = {
  rigid: true,
  determinant: 1,
  matrix4x4: [[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]],
  sourceNormal: frontFrame.direction,
  sourceXAxis: frontFrame.xAxis,
  targetNormal: [0, 0, 1],
  targetXAxis: [1, 0, 0],
};
const exactSupport = (instanceId: string, viewBox: number[]) => {
  const [x, y, width, height] = viewBox as [number, number, number, number];
  const supports = [{
    rangeMethod: 'rigid-camera-frame-AddOptimal',
    x: [x, x + width],
    y: [-(y + height), -y],
    depth: [0, 1],
    cameraTransform: frontCameraTransform,
  }];
  return {
    schema: 'partmode.drawing-brep-camera-support/v1',
    kind: 'occt-brep-camera-support',
    revisionKey: 'revision-42',
    sourceBodyCount: 1,
    frame: frontFrame,
    supports,
    supportFingerprint: assemblyDrawingCanonicalFingerprint({
      revisionKey: 'revision-42', view: 'front', instanceId, frame: frontFrame, supports,
    }),
  };
};
const project = {
  units: 'mm',
  rootDocument: { kind: 'assembly', assemblyId: 'assembly-main' },
  partDefinitions: [
    { id: 'plate', name: 'Mounting plate', metadata: { partNumber: 'PLATE-10', revision: 'B', description: 'Mounting plate' } },
    { id: 'bolt', name: 'Socket bolt', metadata: { partNumber: 'BOLT-M6', revision: 'A', description: 'M6 socket bolt' } },
  ],
  assemblyDefinitions: [{ id: 'assembly-main', name: 'Bracket assembly' }],
};
const leafOccurrences = [
  { id: 'plate-1', occurrencePath: ['plate-1'], name: 'Plate', definition: { kind: 'part', partId: 'plate' }, transform: identity, visible: true },
  { id: 'bolt-2', occurrencePath: ['bolt-2'], name: 'Bolt 2', definition: { kind: 'part', partId: 'bolt' }, transform: moved(20), visible: true, parameterOverrides: { length: 20 } },
  { id: 'bolt-1', occurrencePath: ['bolt-1'], name: 'Bolt 1', definition: { kind: 'part', partId: 'bolt' }, transform: moved(10), visible: true, parameterOverrides: { length: 20 } },
  { id: 'bolt-3', occurrencePath: ['pattern-1-instance-2-bolt-1'], name: 'Bolt 3', definition: { kind: 'part', partId: 'bolt' }, transform: moved(30), visible: false, parameterOverrides: { length: 20 }, patternInstance: { patternId: 'pattern-1', index: 2 } },
];
const solution = {
  assembly: { id: 'assembly-main' },
  state: 'under-constrained',
  errors: [],
  usedLastValid: false,
  leafOccurrences,
};

const plan = createAssemblyDrawingPlan(project, solution, { revisionKey: 'revision-42', views: ['front', 'top'] });
assert.equal(plan.schema, 'partmode.assembly-drawing-plan/v2');
assert.equal(plan.bom.length, 2);
assert.deepEqual(plan.bom.map((entry: any) => [entry.partNumber, entry.quantity]), [['BOLT-M6', 3], ['PLATE-10', 1]]);
assert.equal(plan.bom[0].itemNumber, 1);
assert.equal(plan.projectionRequests[0].exactAssemblyPass.kind, 'occt-hlr-placed-compound');
assert.equal(plan.projectionRequests[0].exactAssemblyPass.instanceCount, 3, 'hidden occurrence entered the complete HLR pass');
assert.equal(plan.instances.filter((entry: any) => entry.visible).length, 3);
assert.equal(plan.annotationProjectionView, 'front');
assert.deepEqual(plan.annotationRepresentatives.map((entry: any) => entry.instanceId), ['bolt-1', 'plate-1']);
assert.equal(plan.projectionRequests[0].exactOccurrencePass.kind, 'occt-brep-camera-support');
assert.deepEqual(plan.projectionRequests[0].exactOccurrencePass.instanceIds, ['bolt-1', 'plate-1']);
assert.equal(plan.projectionRequests[1].exactOccurrencePass.kind, 'not-required-outside-annotation-view');
assert.equal(plan.projectionRequests[1].exactOccurrencePass.instanceIds.length, 0, 'non-annotation view retained redundant occurrence support work');
assert.deepEqual(plan.warnings.map((entry: any) => entry.code), ['ASSEMBLY_DRAWING_UNDER_CONSTRAINED']);

const reordered = createAssemblyDrawingPlan(project, { ...solution, leafOccurrences: [...leafOccurrences].reverse() }, { revisionKey: 'revision-42', views: ['front', 'top'] });
assert.deepEqual(reordered, plan, 'assembly drawing plan changed with leaf traversal order');

assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, {
  kind: 'mesh-bounds', revisionKey: 'revision-42', views: [],
}), /exact OCCT HLR evidence/, 'mesh bounds were accepted as assembly drawing evidence');
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, {
  kind: 'occt-hlr-exact', revisionKey: 'stale', views: [],
}), /stale/, 'stale exact projection evidence was accepted');

const exactEvidence = {
  kind: 'occt-hlr-exact',
  revisionKey: 'revision-42',
  placementLedgerFingerprint: plan.placementLedgerFingerprint,
  views: [
    {
      view: 'front',
      occurrencePassKind: 'occt-brep-camera-support',
      assemblyViewBox: [0, 0, 100, 60],
      occurrences: [
        { instanceId: 'plate-1', viewBox: [0, 0, 100, 50], evidence: exactSupport('plate-1', [0, 0, 100, 50]) },
        { instanceId: 'bolt-1', viewBox: [8, 5, 6, 20], evidence: exactSupport('bolt-1', [8, 5, 6, 20]) },
      ],
    },
    {
      view: 'top',
      occurrencePassKind: 'not-required-outside-annotation-view',
      assemblyViewBox: [0, 0, 100, 30],
      occurrences: [],
    },
  ],
};
const annotated = finalizeAssemblyDrawingAnnotations(plan, exactEvidence);
assert.deepEqual(annotated.annotations.balloons.map((entry: any) => entry.itemNumber), [1, 2]);
assert.deepEqual(annotated.annotations.balloons.map((entry: any) => entry.quantity), [3, 1]);
assert.ok(annotated.annotations.balloons.every((entry: any) =>
  entry.evidence.kind === 'occt-brep-camera-support'
  && entry.evidence.assemblyProjectionKind === 'occt-hlr-exact'
  && entry.evidence.supportFingerprint));
assert.deepEqual(annotated.annotations.diagnostics, []);

const alteredEvidence = (mutate: (evidence: any) => void) => {
  const evidence = structuredClone(exactEvidence);
  mutate(evidence);
  return evidence;
};
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, alteredEvidence((evidence) => {
  evidence.placementLedgerFingerprint = 'altered-placement-ledger';
})), /stale or altered placement ledger/, 'altered placement ledger fingerprint was accepted');
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, alteredEvidence((evidence) => {
  evidence.views.pop();
})), /missing a requested view/, 'missing requested view was accepted');
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, alteredEvidence((evidence) => {
  evidence.views.push(structuredClone(evidence.views[0]));
})), /repeats a requested view/, 'duplicate requested view was accepted');
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, alteredEvidence((evidence) => {
  evidence.views[0].occurrencePassKind = 'occt-hlr-occurrence-silhouettes';
})), /wrong exact pass/, 'wrong occurrence evidence method was accepted');
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, alteredEvidence((evidence) => {
  evidence.views[0].occurrences.pop();
})), /incomplete for view/, 'missing BOM representative support was accepted');
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, alteredEvidence((evidence) => {
  evidence.views[0].occurrences[0].evidence.kind = 'mesh-bounds';
})), /not current exact B-rep camera support/, 'mesh representative support was accepted');
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, alteredEvidence((evidence) => {
  evidence.views[0].occurrences[0].evidence.revisionKey = 'stale';
})), /not current exact B-rep camera support/, 'stale representative support was accepted');
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, alteredEvidence((evidence) => {
  evidence.views[0].occurrences[0].evidence.supportFingerprint = '';
})), /support fingerprint is stale or altered/, 'unbound representative support was accepted');
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, alteredEvidence((evidence) => {
  evidence.views[0].occurrences[0].viewBox[0] += 1;
})), /box does not match/, 'support-backed representative box tamper was accepted');
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, alteredEvidence((evidence) => {
  evidence.views[0].occurrences[0].evidence.supports[0].x[1] += 1;
})), /support fingerprint is stale or altered/, 'exact support range tamper was accepted');
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, alteredEvidence((evidence) => {
  evidence.views[0].occurrences[0].evidence.supports[0].cameraTransform.matrix4x4[0][0] = -1;
})), /camera transform/, 'camera transform tamper was accepted');
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, alteredEvidence((evidence) => {
  const occurrence = evidence.views[0].occurrences[0];
  occurrence.evidence.supports[0].cameraTransform.matrix4x4[0][2] = 7;
  occurrence.evidence.supportFingerprint = assemblyDrawingCanonicalFingerprint({
    revisionKey: evidence.revisionKey,
    view: evidence.views[0].view,
    instanceId: occurrence.instanceId,
    frame: occurrence.evidence.frame,
    supports: occurrence.evidence.supports,
  });
})), /camera transform/, 're-fingerprinted determinant-one camera shear was accepted');
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, alteredEvidence((evidence) => {
  evidence.views[0].occurrences[0].evidence.frame.direction = [0, 1, 0];
})), /camera frame|orthonormal/, 'camera frame tamper was accepted');
assert.throws(() => finalizeAssemblyDrawingAnnotations(plan, alteredEvidence((evidence) => {
  evidence.views[1].occurrences.push(structuredClone(evidence.views[0].occurrences[0]));
})), /incomplete for view/, 'redundant non-annotation occurrence evidence was accepted');
assert.throws(() => finalizeAssemblyDrawingAnnotations({
  ...structuredClone(plan),
  instances: plan.instances.map((entry: any, index: number) => index === 0
    ? { ...structuredClone(entry), transform: moved(99) }
    : structuredClone(entry)),
}, exactEvidence), /plan placement ledger fingerprint is stale or altered/, 'mutated plan ledger was accepted');

assert.throws(() => createAssemblyDrawingPlan(project, { ...solution, usedLastValid: true }), /last-valid fallback/);
assert.throws(() => createAssemblyDrawingPlan(project, { ...solution, state: 'over-constrained' }), /conflicting mate solution/);

console.log(JSON.stringify({
  bom: plan.bom.map((entry: any) => ({ item: entry.itemNumber, partNumber: entry.partNumber, quantity: entry.quantity })),
  projectedOccurrences: plan.projectionRequests[0].exactAssemblyPass.instanceCount,
  supportRepresentatives: plan.projectionRequests[0].exactOccurrencePass.instanceIds.length,
  balloons: annotated.annotations.balloons.map((entry: any) => ({ item: entry.itemNumber, instanceId: entry.instanceId })),
  evidence: annotated.exactProjectionEvidence.kind,
}));
