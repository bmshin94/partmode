import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Topology hash hardening smoke failed: ${name}`);
}

const root = process.cwd();
const vendorDir = resolve(root, 'src/static/vendor');
const nodeGlobals = globalThis as typeof globalThis & {
  require: ReturnType<typeof createRequire>;
  __dirname: string;
};
nodeGlobals.require = createRequire(import.meta.url);
nodeGlobals.__dirname = vendorDir;

const topologySource = readFileSync(resolve(root, 'src/static/studio-topo-naming.js'), 'utf8');
const workerSource = readFileSync(resolve(root, 'src/static/studio-kernel.worker.js'), 'utf8');
const modifierSlice = workerSource.slice(
  workerSource.indexOf('function topologyCandidateName('),
  workerSource.indexOf('function transformDirection('),
);
const serializationSlice = workerSource.slice(
  workerSource.indexOf('function serializeShape('),
  workerSource.indexOf('async function rebuild(request)'),
);
const creationSlice = workerSource.slice(
  workerSource.indexOf('function creationNameTable('),
  workerSource.indexOf('function disposeNameTable('),
);

check('topology naming does not index exact edges by hash', !topologySource.includes('nameByEdgeHash'));
check('modifier resolution contains no hash identity', !modifierSlice.includes('.hashCode'));
check('modifier candidates come from exact lookup ownership', modifierSlice.includes('lookups.edgeCandidates'));
check('modifier lookup wrappers are disposed', modifierSlice.includes('lookups.dispose()'));
check('creation naming no longer converts failures to an empty table', !creationSlice.includes('catch {\n    return [];'));
check('serialization naming no longer swallows failures', !serializationSlice.includes('try { wireNames = topo.serializationNames'));
check('ambiguous display hashes are diagnosed', serializationSlice.includes('TOPOLOGY_DISPLAY_HASH_AMBIGUOUS'));

const rc = await import(pathToFileURL(resolve(vendorDir, 'replicad.module.js')).href) as any;
const ocFactory = await import(pathToFileURL(resolve(vendorDir, 'replicad-oc.module.js')).href) as any;
const namingModule = await import(pathToFileURL(resolve(root, 'src/static/studio-topo-naming.js')).href) as any;
const oc = await ocFactory.default({ locateFile: () => resolve(vendorDir, 'replicad_single.wasm') });
rc.setOC(oc);

const tie = (input: Array<{ id: string }>) => {
  try {
    namingModule.strictTopologySuffixOrder('E(face-a|face-b)', input, () => '0,0,0', 'edge');
    throw new Error('tie was accepted');
  } catch (error: any) {
    check('geometric suffix tie has explicit code', error.code === namingModule.TOPOLOGY_NAMING_ERROR_CODES.ambiguousSuffix);
    return {
      code: error.code,
      reason: error.reason,
      candidateCount: error.candidateCount,
      tiedKeys: error.tiedKeys,
    };
  }
};
const tieForward = tie([{ id: 'a' }, { id: 'b' }]);
const tieReverse = tie([{ id: 'b' }, { id: 'a' }]);
check('tie diagnostic is input-order independent', JSON.stringify(tieForward) === JSON.stringify(tieReverse));

let geometricOrderRejected: any = null;
try {
  namingModule.strictTopologySuffixOrder(
    'Ffeature:side:line',
    [{ id: 'high' }, { id: 'low' }],
    (entry: { id: string }) => entry.id === 'low' ? '-1,0,0' : '1,0,0',
    'face',
  );
} catch (error) {
  geometricOrderRejected = error;
}
check('even unique geometric keys cannot assign persistent suffix identity',
  geometricOrderRejected?.code === namingModule.TOPOLOGY_NAMING_ERROR_CODES.ambiguousSuffix);

const topology = namingModule.createStudioTopoNaming(rc);
const shape = rc.makeBox([0, 0, 0], [10, 10, 10]);
const exactFaces = topology.exactFaces(shape);
const exactEdges = topology.exactEdges(shape);
check('raw explorer finds all six exact box faces', exactFaces.length === 6);
check('raw explorer finds all twelve exact box edges', exactEdges.length === 12);
const faceTable = exactFaces.map((face: any, index: number) => ({ name: `Fbox:${index}`, face: face.clone() }));
let edgeTable: any[] & { diagnostics: any[] } = Object.assign([], { diagnostics: [] });
let lookups: any = null;
let wireNames: any = null;
let filletNameCount = 0;
try {
  edgeTable = topology.deriveEdgeTable(shape, faceTable);
  check('exact adjacency names every box edge', edgeTable.length === 12);
  check('ordinary box has no suffix ambiguity diagnostics', edgeTable.diagnostics.length === 0);
  check('edge names are unique', new Set(edgeTable.map((entry: any) => entry.name)).size === 12);

  lookups = topology.nameLookups(shape, faceTable);
  check('lookup owns twelve exact edge candidates', lookups.edgeCandidates.length === 12);
  const candidate = lookups.edgeCandidates[0];
  const partner = candidate.clone();
  try {
    check('IsSame partner resolves the same persistent edge name',
      lookups.getEdgeName(candidate) === lookups.getEdgeName(partner));
  } finally {
    partner.delete();
  }

  wireNames = topology.serializationNames(shape, faceTable);
  const serializedPartner = exactEdges[0].clone();
  try {
    check('serialization resolves edge names by exact identity',
      wireNames.getEdgeName(exactEdges[0]) === wireNames.getEdgeName(serializedPartner));
  } finally {
    serializedPartner.delete();
  }

  const pickedEdge = edgeTable[0];
  const fillet = topology.filletChamferWithNames(
    'fillet',
    shape,
    [{ edge: pickedEdge.edge, radii: 1, edgeName: pickedEdge.name }],
    faceTable,
    'hash-hardening-fillet',
  );
  try {
    const analyzer = new oc.BRepCheck_Analyzer(fillet.shape.wrapped, true, false);
    try { check('exact-history fillet remains a valid B-rep', analyzer.IsValid_2()); }
    finally { analyzer.delete(); }
    check('fillet creates a persistent blend face', fillet.names.some((entry: any) =>
      entry.name.startsWith(`Fhash-hardening-fillet:blend:${pickedEdge.name}`)));
    filletNameCount = fillet.names.length;
  } finally {
    topology.disposeTable(fillet.names);
    fillet.shape.delete();
  }
} finally {
  wireNames?.dispose();
  lookups?.dispose();
  topology.disposeWrappers(edgeTable.map((entry: any) => entry.edge));
  topology.disposeTable(faceTable);
  topology.disposeWrappers(exactFaces);
  topology.disposeWrappers(exactEdges);
  shape.delete();
}

console.log(JSON.stringify({
  exactBox: { faces: 6, edges: 12, namedEdges: 12 },
  exactFillet: { names: filletNameCount },
  suffixTie: tieForward,
  modifierHashIdentity: false,
  displayHashAmbiguity: 'diagnosed-and-omitted',
}));
