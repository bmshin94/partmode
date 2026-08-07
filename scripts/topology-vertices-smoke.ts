import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Vertex {
  id: string;
}

interface Edge {
  id: string;
  name: string | null;
  a: Vertex;
  b: Vertex;
}

interface VertexTableEntry {
  name: string;
  vertex: Vertex;
  incidentEdgeNames: string[];
}

interface VertexNamingResult {
  vertexTable: VertexTableEntry[];
  diagnostics: Array<Record<string, unknown>>;
  counts: {
    inputEdgeCount: number;
    exactEdgeCount: number;
    validEdgeCount: number;
    authoritativeNamedEdgeCount: number;
    exactVertexCount: number;
    namedVertexCount: number;
  };
}

interface VertexNamingModule {
  PERSISTENT_VERTEX_DIAGNOSTIC_CODES: {
    invalidInput: string;
    invalidEndpoints: string;
    missingEdgeName: string;
    ambiguousEdgeName: string;
    duplicateIncidence: string;
    unnameable: string;
    ambiguous: string;
  };
  persistentVertexNameFromEdgeNames(edgeNames: string[]): string;
  derivePersistentVertexNames(input: {
    edges: Edge[];
    getEdgeName: (edge: Edge) => string | null;
    getEdgeEndpoints: (edge: Edge) => [Vertex, Vertex];
    isSameEdge: (left: Edge, right: Edge) => boolean;
    isSameVertex: (left: Vertex, right: Vertex) => boolean;
  }): VertexNamingResult;
}

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Topology vertex smoke failed: ${name}`);
}

let coordinateReadCount = 0;
let edgeIdentityCallCount = 0;
let vertexIdentityCallCount = 0;

function vertex(id: string, coordinates: [number, number, number]): Vertex {
  const value = { id } as Vertex;
  const rejectCoordinateIdentity = (): never => {
    coordinateReadCount++;
    throw new Error(`coordinate identity read for ${id}: ${coordinates.join(',')}`);
  };
  for (const property of ['point', 'coordinates', 'x', 'y', 'z']) {
    Object.defineProperty(value, property, { enumerable: false, get: rejectCoordinateIdentity });
  }
  return value;
}

function edge(id: string, name: string | null, a: Vertex, b: Vertex): Edge {
  return { id, name, a, b };
}

const getEdgeName = (value: Edge): string | null => value.name;
const getEdgeEndpoints = (value: Edge): [Vertex, Vertex] => [value.a, value.b];
const isSameEdge = (left: Edge, right: Edge): boolean => {
  edgeIdentityCallCount++;
  return left.id === right.id;
};
const isSameVertex = (left: Vertex, right: Vertex): boolean => {
  vertexIdentityCallCount++;
  return left.id === right.id;
};

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-topology-vertices.js')).href;
const naming = await import(moduleUrl) as VertexNamingModule;
const codes = naming.PERSISTENT_VERTEX_DIAGNOSTIC_CODES;

function derive(edges: Edge[]): VertexNamingResult {
  return naming.derivePersistentVertexNames({
    edges,
    getEdgeName,
    getEdgeEndpoints,
    isSameEdge,
    isSameVertex,
  });
}

function tableSnapshot(result: VertexNamingResult): Array<Record<string, unknown>> {
  return result.vertexTable.map((entry) => ({
    name: entry.name,
    vertexId: entry.vertex.id,
    incidentEdgeNames: entry.incidentEdgeNames,
  }));
}

function diagnostic(result: VertexNamingResult, code: string, reason?: string): Record<string, unknown> | undefined {
  return result.diagnostics.find((entry) => entry.code === code && (reason == null || entry.reason === reason));
}

check(
  'persistent name sorts and length-prefixes incidence',
  naming.persistentVertexNameFromEdgeNames(['edge:z', 'edge:a']) === 'V(6:edge:a|6:edge:z)',
);

// Ordinary box: twelve uniquely named edges produce eight exact vertex names.
const boxVertices = new Map<string, Vertex>();
for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) {
  const id = `v${x}${y}${z}`;
  boxVertices.set(id, vertex(id, [x, y, z]));
}
const boxVertex = (id: string): Vertex => {
  const value = boxVertices.get(id);
  check(`box vertex ${id} exists`, value);
  return value;
};
const boxEdges: Edge[] = [
  edge('ex-00', 'E:box:x:y0:z0', boxVertex('v000'), boxVertex('v100')),
  edge('ex-10', 'E:box:x:y1:z0', boxVertex('v010'), boxVertex('v110')),
  edge('ex-01', 'E:box:x:y0:z1', boxVertex('v001'), boxVertex('v101')),
  edge('ex-11', 'E:box:x:y1:z1', boxVertex('v011'), boxVertex('v111')),
  edge('ey-00', 'E:box:y:x0:z0', boxVertex('v000'), boxVertex('v010')),
  edge('ey-10', 'E:box:y:x1:z0', boxVertex('v100'), boxVertex('v110')),
  edge('ey-01', 'E:box:y:x0:z1', boxVertex('v001'), boxVertex('v011')),
  edge('ey-11', 'E:box:y:x1:z1', boxVertex('v101'), boxVertex('v111')),
  edge('ez-00', 'E:box:z:x0:y0', boxVertex('v000'), boxVertex('v001')),
  edge('ez-10', 'E:box:z:x1:y0', boxVertex('v100'), boxVertex('v101')),
  edge('ez-01', 'E:box:z:x0:y1', boxVertex('v010'), boxVertex('v011')),
  edge('ez-11', 'E:box:z:x1:y1', boxVertex('v110'), boxVertex('v111')),
];
const box = derive(boxEdges);
check('box has eight exact vertices', box.counts.exactVertexCount === 8);
check('box names all eight vertices', box.counts.namedVertexCount === 8 && box.vertexTable.length === 8);
check('box vertex names each use three named incidences', box.vertexTable.every((entry) => entry.incidentEdgeNames.length === 3));
check('box has no diagnostics', box.diagnostics.length === 0);

// Reordering edges and reversing endpoint presentation cannot change identity.
const reorderedBoxEdges = [...boxEdges].reverse().map((value) => ({
  ...value,
  a: value.b,
  b: value.a,
}));
const reorderedBox = derive(reorderedBoxEdges);
check(
  'box naming is deterministic under edge and endpoint reordering',
  JSON.stringify(tableSnapshot(reorderedBox)) === JSON.stringify(tableSnapshot(box)),
);
check(
  'box diagnostics are deterministic under input reordering',
  JSON.stringify(reorderedBox.diagnostics) === JSON.stringify(box.diagnostics),
);

// Two distinct exact vertices intentionally occupy the same coordinates. Each
// belongs to a different named-edge triangle and must remain separately named.
const coincidentA = vertex('coincident-a', [50, 50, 50]);
const coincidentB = vertex('coincident-b', [50, 50, 50]);
const a1 = vertex('a1', [51, 50, 50]);
const a2 = vertex('a2', [50, 51, 50]);
const b1 = vertex('b1', [51, 50, 50]);
const b2 = vertex('b2', [50, 51, 50]);
const coincident = derive([
  edge('ca-1', 'E:coincident:a:1', coincidentA, a1),
  edge('ca-2', 'E:coincident:a:2', coincidentA, a2),
  edge('ca-3', 'E:coincident:a:3', a1, a2),
  edge('cb-1', 'E:coincident:b:1', coincidentB, b1),
  edge('cb-2', 'E:coincident:b:2', coincidentB, b2),
  edge('cb-3', 'E:coincident:b:3', b1, b2),
]);
const coincidentNames = new Map(coincident.vertexTable.map((entry) => [entry.vertex.id, entry.name]));
check('same-coordinate exact vertex A is named', coincidentNames.has('coincident-a'));
check('same-coordinate exact vertex B is named', coincidentNames.has('coincident-b'));
check('same-coordinate distinct vertices keep different names', coincidentNames.get('coincident-a') !== coincidentNames.get('coincident-b'));
check('same-coordinate graph names all exact vertices', coincident.counts.namedVertexCount === 6);

// A persistently split edge names its new junction from the two child names.
const splitLeft = vertex('split-left', [0, 0, 0]);
const splitJunction = vertex('split-junction', [5, 0, 0]);
const splitRight = vertex('split-right', [10, 0, 0]);
const splitReturn = vertex('split-return', [5, 5, 0]);
const split = derive([
  edge('split-0', 'E:source#0', splitLeft, splitJunction),
  edge('split-1', 'E:source#1', splitJunction, splitRight),
  edge('split-right-edge', 'E:right', splitRight, splitReturn),
  edge('split-left-edge', 'E:left', splitReturn, splitLeft),
]);
const splitEntry = split.vertexTable.find((entry) => entry.vertex.id === 'split-junction');
check('split junction is named', splitEntry);
check(
  'split junction derives identity from both child edge names',
  JSON.stringify(splitEntry.incidentEdgeNames) === JSON.stringify(['E:source#0', 'E:source#1']),
);

// Missing edge names are explicit. A vertex with two remaining authoritative
// names can still be named, while the other endpoints fail closed.
const missing0 = vertex('missing-0', [0, 0, 0]);
const missing1 = vertex('missing-1', [1, 0, 0]);
const missing2 = vertex('missing-2', [0, 1, 0]);
const missing = derive([
  edge('missing-a', 'E:missing:a', missing0, missing1),
  edge('missing-unnamed', null, missing1, missing2),
  edge('missing-b', 'E:missing:b', missing2, missing0),
]);
check('missing edge name emits an explicit diagnostic', diagnostic(missing, codes.missingEdgeName)?.edgeCount === 1);
check('insufficient named incidence emits unnameable diagnostics', Boolean(diagnostic(missing, codes.unnameable)));
check('vertex with two authoritative names remains nameable', missing.vertexTable.some((entry) => entry.vertex.id === 'missing-0'));
check('vertices with one authoritative name remain unnamed', !missing.vertexTable.some((entry) => entry.vertex.id === 'missing-1' || entry.vertex.id === 'missing-2'));

// Repeating the same exact edge is diagnosed but counted once, so it cannot
// corrupt an otherwise valid box incidence set.
const firstBoxEdge = boxEdges[0];
check('box has a first edge for duplicate-incidence coverage', firstBoxEdge);
const duplicateEdgeInput: Edge = { ...firstBoxEdge };
const duplicateIncidence = derive([...boxEdges, duplicateEdgeInput]);
const duplicateInputDiagnostic = diagnostic(duplicateIncidence, codes.duplicateIncidence, 'repeated-exact-edge-input');
check('repeated exact edge emits duplicate incidence diagnostic', duplicateInputDiagnostic?.occurrenceCount === 2);
check('repeated exact edge is counted once', duplicateIncidence.counts.exactEdgeCount === 12);
check('repeated exact edge does not change named box vertices', JSON.stringify(tableSnapshot(duplicateIncidence)) === JSON.stringify(tableSnapshot(box)));

// The same persistent name on distinct exact edges is not authoritative.
const duplicateNameA = vertex('duplicate-name-a', [0, 0, 0]);
const duplicateNameB = vertex('duplicate-name-b', [1, 0, 0]);
const duplicateNameC = vertex('duplicate-name-c', [0, 1, 0]);
const duplicateNames = derive([
  edge('duplicate-name-1', 'E:duplicate', duplicateNameA, duplicateNameB),
  edge('duplicate-name-2', 'E:duplicate', duplicateNameA, duplicateNameC),
  edge('duplicate-name-3', 'E:other', duplicateNameB, duplicateNameC),
]);
const duplicateNameDiagnostic = diagnostic(duplicateNames, codes.ambiguousEdgeName, 'duplicate-name-on-distinct-edges');
check('duplicate persistent edge name emits ambiguity diagnostic', duplicateNameDiagnostic?.edgeCount === 2);
check('duplicate persistent edge name is excluded from incidence', duplicateNames.counts.authoritativeNamedEdgeCount === 1);
check('duplicate persistent edge name cannot silently name a vertex', duplicateNames.vertexTable.length === 0);

// Two exact vertices sharing the same two named edges are topologically
// ambiguous even if a coordinate heuristic would choose or merge one.
const ambiguousA = vertex('ambiguous-a', [7, 7, 7]);
const ambiguousB = vertex('ambiguous-b', [7, 7, 7]);
const ambiguous = derive([
  edge('ambiguous-1', 'E:ambiguous:1', ambiguousA, ambiguousB),
  edge('ambiguous-2', 'E:ambiguous:2', ambiguousA, ambiguousB),
]);
const ambiguousDiagnostic = diagnostic(ambiguous, codes.ambiguous, 'named-incidence-not-unique');
check('duplicate incidence witness names no vertex', ambiguous.vertexTable.length === 0);
check('duplicate incidence witness reports both exact vertices', ambiguousDiagnostic?.vertexCount === 2 && ambiguousDiagnostic.matchingVertexCount === 2);

check('edge exact identity adapter is exercised', edgeIdentityCallCount > 0);
check('vertex exact identity adapter is exercised', vertexIdentityCallCount > 0);
check('coordinates are never read as vertex identity', coordinateReadCount === 0);

console.log(JSON.stringify({
  box: { vertices: box.counts.namedVertexCount, deterministic: true },
  coincidentDistinct: coincidentNames.size,
  splitJunction: splitEntry.name,
  missingNameDiagnostics: missing.diagnostics.length,
  duplicateIncidence: duplicateInputDiagnostic?.reason,
  duplicateEdgeName: duplicateNameDiagnostic?.reason,
  ambiguousVertices: ambiguousDiagnostic?.vertexCount,
  coordinateReadCount,
}));
