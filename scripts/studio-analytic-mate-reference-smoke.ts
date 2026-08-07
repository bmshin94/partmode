import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Analytic mate reference smoke failed: ${name}`);
}

function near(actual: number, expected: number, tolerance = 1e-7): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function vectorNear(actual: number[], expected: number[], tolerance = 1e-7): boolean {
  return actual.length === expected.length && actual.every((value, index) => near(value, expected[index]!, tolerance));
}

function dot(left: number[], right: number[]): number {
  return left.reduce((total, value, index) => total + value * right[index]!, 0);
}

function safeDelete(value: any): void {
  try { value?.delete?.(); } catch {}
}

const root = process.cwd();
const vendorDirectory = resolve(root, 'src/static/vendor');
const nodeGlobals = globalThis as typeof globalThis & {
  require: ReturnType<typeof createRequire>;
  __dirname: string;
};
nodeGlobals.require = createRequire(import.meta.url);
nodeGlobals.__dirname = vendorDirectory;

const rc = await import(pathToFileURL(resolve(vendorDirectory, 'replicad.module.js')).href) as any;
const ocFactory = await import(pathToFileURL(resolve(vendorDirectory, 'replicad-oc.module.js')).href) as any;
const signatureModule = await import(
  pathToFileURL(resolve(root, 'src/static/studio-analytic-mate-reference.js')).href
) as any;
const assemblyModule = await import(
  pathToFileURL(resolve(root, 'src/static/studio-v5-assembly.js')).href
) as any;
const interactionModule = await import(
  pathToFileURL(resolve(root, 'src/static/studio-v6-interaction.js')).href
) as any;
const oc = await ocFactory.default({ locateFile: () => resolve(vendorDirectory, 'replicad_single.wasm') });
rc.setOC(oc);

const quantize = (value: number): number => Math.round(value * 1e8) / 1e8;
const analyticSignature = signatureModule.createStudioAnalyticMateSignature as (
  kernel: any,
  face: any,
  rounding?: (value: number) => number,
) => Record<string, any>;

function signatureFor(shape: any, geometry: string): Record<string, any> {
  const faces = shape.faces as any[];
  const face = faces.find((candidate) => candidate.geomType === geometry);
  try {
    check(`shape exposes ${geometry} face`, face);
    return analyticSignature(oc, face, quantize);
  } finally {
    faces.forEach(safeDelete);
  }
}

const tiltedAxis = [0.6105578, -0.7257188, -0.6645552];
let cylinder: any = null;
let sphere: any = null;
let cone: any = null;
let sphereAxis: any = null;
let sphereMaker: any = null;
let sphereRaw: any = null;
try {
  cylinder = rc.makeCylinder(3, 8, [1, 2, 3], tiltedAxis);
  const cylinderSignature = signatureFor(cylinder, 'CYLINDRE');
  check('cylinder signature kind', cylinderSignature.topologyKind === 'cylindrical-face');
  check('cylinder radius is exact', near(cylinderSignature.r, 3));
  check('cylinder axis point is exact', vectorNear(cylinderSignature.a, [1, 2, 3]));
  check('cylinder axis direction is exact', Math.abs(dot(cylinderSignature.d, tiltedAxis)) > 0.9999999);

  const reopenedCylinder = rc.deserializeShape(cylinder.serialize());
  try {
    check('cylinder signature survives save and reopen',
      JSON.stringify(signatureFor(reopenedCylinder, 'CYLINDRE')) === JSON.stringify(cylinderSignature));
  } finally {
    reopenedCylinder.delete();
  }

  sphereAxis = rc.makeAx2([1, 2, 3], tiltedAxis);
  sphereMaker = new oc.BRepPrimAPI_MakeSphere_9(sphereAxis, 5);
  sphereRaw = sphereMaker.Shape();
  sphere = rc.cast(sphereRaw);
  sphereRaw.delete();
  sphereRaw = null;
  const sphereSignature = signatureFor(sphere, 'SPHERE');
  check('sphere signature kind', sphereSignature.topologyKind === 'spherical-face');
  check('sphere center is exact', vectorNear(sphereSignature.c, [1, 2, 3]));
  check('sphere radius is exact', near(sphereSignature.r, 5));

  cone = rc.draw([2, 0])
    .lineTo([4, 8])
    .lineTo([0, 8])
    .lineTo([0, 0])
    .close()
    .sketchOnPlane('XZ')
    .revolve([0, 0, 1]);
  const coneSignature = signatureFor(cone, 'CONE');
  check('cone signature kind', coneSignature.topologyKind === 'conical-face');
  check('cone axis is exact', Math.abs(coneSignature.d[2]) > 0.9999999 && Math.abs(coneSignature.d[0]) < 1e-7 && Math.abs(coneSignature.d[1]) < 1e-7);
  check('cone apex lies on the exact axis', Math.abs(coneSignature.a[0]) < 1e-7 && Math.abs(coneSignature.a[1]) < 1e-7);
  check('cone semi-angle is exact', near(coneSignature.semiAngle, Math.atan(0.25), 1e-7));
  check('cone reference radius is positive', coneSignature.r > 0);
} finally {
  safeDelete(cone);
  safeDelete(sphere);
  safeDelete(sphereRaw);
  safeDelete(sphereMaker);
  safeDelete(sphereAxis);
  safeDelete(cylinder);
}

const fixture = JSON.parse(readFileSync(
  resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'),
  'utf8',
)) as any;

function bodyReference(occurrenceId: string, ownerId: string, signature: Record<string, any>): Record<string, any> {
  return {
    ownerKind: 'body',
    ownerId,
    occurrencePath: [occurrenceId],
    semanticPath: { topologyKind: signature.topologyKind, bodyId: ownerId },
    signature,
  };
}

function solveWithSignatures(anchor: Record<string, any>, moving: Record<string, any>): any {
  const project = structuredClone(fixture);
  project.assemblyDefinitions[0].mates = [{
    id: 'mate-analytic',
    name: 'Analytic face concentric',
    kind: 'concentric',
    occurrenceIds: ['occurrence-base', 'occurrence-moving'],
    references: [
      bodyReference('occurrence-base', 'body-base-block', anchor),
      bodyReference('occurrence-moving', 'body-moving-block', moving),
    ],
    suppressed: false,
  }];
  return assemblyModule.solveStudioV5Assembly(project, 'assembly-two-blocks');
}

const cylinderFrame = { topologyKind: 'cylindrical-face', p: [3, 0, 0], n: [1, 0, 0], a: [0, 0, 0], d: [0, 0, 1], r: 3 };
const analyticSelection = {
  owner: { kind: 'body', id: 'body-base-block' },
  stableId: 'face:analytic-cylinder',
  topologySignature: { kind: 'face', ...cylinderFrame },
  expectedGeometry: 'cylinder',
};
const typedMateTransaction = interactionModule.buildCadUiCommandTransaction({
  draft: {
    commandId: 'assembly.mate.concentric',
    draftId: 'draft-analytic-concentric',
    baseRevision: 7,
    inputValues: { name: 'Cylinder concentric', value: 0, flip: false },
    boundSelections: {
      anchorOccurrence: [{ kind: 'occurrence', id: 'occurrence-base' }],
      movingOccurrence: [{ kind: 'occurrence', id: 'occurrence-moving' }],
      anchorReference: [analyticSelection],
      movingReference: [{
        ...analyticSelection,
        owner: { kind: 'body', id: 'body-moving-block' },
        stableId: 'face:analytic-cylinder-moving',
      }],
    },
    generatedIds: { mateId: 'mate-analytic-concentric' },
  },
  expectedRevision: 7,
  transactionId: 'transaction-analytic-concentric',
});
const typedMateInput = typedMateTransaction.transaction.operations.at(-1)?.input as any;
check('typed control plane accepts analytic face references', typedMateInput?.references?.length === 2);
check('typed control plane preserves analytic face geometry',
  typedMateInput.references.every((reference: any) => reference.signature.topologyKind === 'cylindrical-face'
    && vectorNear(reference.signature.a, [0, 0, 0])
    && vectorNear(reference.signature.d, [0, 0, 1])
    && reference.signature.r === 3));

const cylinderSolution = solveWithSignatures(cylinderFrame, cylinderFrame);
const cylinderTransform = cylinderSolution.transforms.get('occurrence-moving') as number[];
check('cylindrical mate is accepted', cylinderSolution.errors.length === 0 && cylinderSolution.state === 'under-constrained');
check('cylindrical mate aligns exact axes while retaining axial freedom', vectorNear(cylinderTransform.slice(12, 15), [0, 0, 9]));
check('cylindrical mate has exact rank and mobility', cylinderSolution.solverRank === 4 && cylinderSolution.degreesOfFreedom.get('occurrence-moving') === 2);

const coneFrame = { topologyKind: 'conical-face', p: [3, 0, 0], n: [1, 0, 0], a: [0, 0, -8], d: [0, 0, 1], r: 3, semiAngle: Math.atan(0.25) };
const coneSolution = solveWithSignatures(coneFrame, coneFrame);
const coneTransform = coneSolution.transforms.get('occurrence-moving') as number[];
check('conical mate is accepted', coneSolution.errors.length === 0);
check('conical mate aligns exact axes while retaining axial freedom', vectorNear(coneTransform.slice(12, 15), [0, 0, 9]));
check('conical mate has exact rank and mobility', coneSolution.solverRank === 4 && coneSolution.degreesOfFreedom.get('occurrence-moving') === 2);

const sphereFrame = { topologyKind: 'spherical-face', p: [3, 0, 0], n: [1, 0, 0], c: [0, 0, 0], r: 3 };
const sphereSolution = solveWithSignatures(sphereFrame, sphereFrame);
const sphereTransform = sphereSolution.transforms.get('occurrence-moving') as number[];
check('spherical mate is accepted', sphereSolution.errors.length === 0);
check('spherical mate aligns centers exactly', vectorNear(sphereTransform.slice(12, 15), [0, 0, 0]));
check('spherical mate has exact rank and mobility', sphereSolution.solverRank === 3 && sphereSolution.degreesOfFreedom.get('occurrence-moving') === 3);

const malformedSolution = solveWithSignatures(cylinderFrame, { ...cylinderFrame, d: [0, 0, 0] });
check('malformed analytic reference fails closed', malformedSolution.state === 'conflicting' && malformedSolution.errors.some((entry: any) => entry.message.includes('zero length')));
check('malformed analytic reference preserves input placement', vectorNear(malformedSolution.transforms.get('occurrence-moving').slice(12, 15), [7, -4, 9]));

const mixedSolution = solveWithSignatures(sphereFrame, cylinderFrame);
check('mixed spherical and axial references fail closed', mixedSolution.state === 'conflicting' && mixedSolution.errors.some((entry: any) => entry.message.includes('requires two spherical references')));
check('mixed analytic reference preserves input placement', vectorNear(mixedSolution.transforms.get('occurrence-moving').slice(12, 15), [7, -4, 9]));

const studioSource = readFileSync(resolve(root, 'src/static/studio.js'), 'utf8');
const interactionSource = readFileSync(resolve(root, 'src/static/studio-v6-interaction.js'), 'utf8');
check('Studio mate picker advertises all analytic face kinds',
  ['planar-face', 'cylindrical-face', 'conical-face', 'spherical-face'].every((kind) => studioSource.includes(`'${kind}'`)));
check('typed topology contract advertises spherical geometry', interactionSource.includes("'sphere'"));

console.log(JSON.stringify({
  cylinder: { rank: cylinderSolution.solverRank, dof: cylinderSolution.degreesOfFreedom.get('occurrence-moving'), translation: cylinderTransform.slice(12, 15) },
  cone: { rank: coneSolution.solverRank, dof: coneSolution.degreesOfFreedom.get('occurrence-moving'), translation: coneTransform.slice(12, 15) },
  sphere: { rank: sphereSolution.solverRank, dof: sphereSolution.degreesOfFreedom.get('occurrence-moving'), translation: sphereTransform.slice(12, 15) },
  malformedRejected: true,
  mixedRejected: true,
}, null, 2));
