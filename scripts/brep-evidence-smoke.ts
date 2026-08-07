import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
const evidenceModule = await import(pathToFileURL(resolve(root, 'src/static/studio-brep-evidence.js')).href) as any;
const oc = await ocFactory.default({ locateFile: () => resolve(vendorDirectory, 'replicad_single.wasm') });
rc.setOC(oc);

const shape = rc.makeBox([0, 0, 0], [7, 6, 5]);
const sourceBeforeMesh = shape.serialize();
const mesh = shape.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
assert.ok(mesh.triangles.length > 0, 'fixture did not create a derived triangulation');
const sourceWithMesh = shape.serialize();
assert.notEqual(sourceWithMesh, sourceBeforeMesh, 'fixture serialization did not expose the mesh-cache difference');

const canonicalMeshed = evidenceModule.canonicalStudioBrepEvidence(rc, shape);
const restored = rc.deserializeShape(sourceWithMesh);
let analyzer: any = null;
try {
  analyzer = new oc.BRepCheck_Analyzer(restored.wrapped, true, false);
  assert.equal(analyzer.IsValid_2(), true, 'restored fixture is not a valid BREP');
  const canonicalCheckedRestored = evidenceModule.canonicalStudioBrepEvidence(rc, restored);
  assert.equal(canonicalCheckedRestored, canonicalMeshed, 'mesh/check history changed canonical BREP bytes');

  const restoredAgain = rc.deserializeShape(canonicalCheckedRestored);
  try {
    assert.equal(
      evidenceModule.canonicalStudioBrepEvidence(rc, restoredAgain),
      canonicalMeshed,
      'canonical BREP evidence is not a serialize/reopen fixed point',
    );
  } finally {
    restoredAgain.delete();
  }
} finally {
  analyzer?.delete();
  restored.delete();
  shape.delete();
}

assert.match(canonicalMeshed, /PolygonOnTriangulations 0\n/u);
assert.match(canonicalMeshed, /Triangulations 0\n/u);
assert.equal(evidenceModule.STUDIO_BREP_EVIDENCE_VERSION, 1);

console.log(JSON.stringify({
  ok: true,
  version: evidenceModule.STUDIO_BREP_EVIDENCE_VERSION,
  canonicalBytes: canonicalMeshed.length,
  stripsDerivedTriangulation: true,
  serializeReopenFixedPoint: true,
}));
