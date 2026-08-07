import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Candidate {
  id: string;
  name?: string;
  signature: string;
}

interface ResolutionError extends Error {
  code: string;
  topologyKind: string;
  matchCount: number;
  resolutionMode: 'name' | 'signature';
  persistentName?: string;
}

interface ResolverModule {
  TOPOLOGY_REFERENCE_ERROR_CODES: {
    invalid: string;
    missing: string;
    ambiguous: string;
  };
  resolveTopologyReference(input: {
    reference: unknown;
    topologyKind: string;
    candidates: Candidate[];
    getName?: (candidate: Candidate) => string | null;
    matchesSignature?: (signature: unknown, candidate: Candidate) => boolean;
  }): Candidate;
}

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Topology reference resolver smoke failed: ${name}`);
}

function expectResolutionError(
  label: string,
  action: () => unknown,
  expected: { code: string; topologyKind: string; matchCount: number; resolutionMode: 'name' | 'signature' },
): ResolutionError {
  try {
    action();
  } catch (error) {
    check(`${label} throws an Error`, error instanceof Error);
    const resolutionError = error as ResolutionError;
    check(`${label} has code ${expected.code}`, resolutionError.code === expected.code);
    check(`${label} reports topology kind`, resolutionError.topologyKind === expected.topologyKind);
    check(`${label} reports match count`, resolutionError.matchCount === expected.matchCount);
    check(`${label} reports resolution mode`, resolutionError.resolutionMode === expected.resolutionMode);
    return resolutionError;
  }
  throw new Error(`Topology reference resolver smoke failed: ${label} did not throw`);
}

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/static/studio-topology-reference-resolver.js')).href;
const resolver = await import(moduleUrl) as ResolverModule;
const codes = resolver.TOPOLOGY_REFERENCE_ERROR_CODES;
const getName = (candidate: Candidate): string | null => candidate.name ?? null;
let namedSignatureCalls = 0;
const forbiddenNamedFallback = (): boolean => {
  namedSignatureCalls++;
  return true;
};

const named = resolver.resolveTopologyReference({
  reference: { name: 'edge:cap', sig: 'obsolete-signature' },
  topologyKind: 'edge',
  candidates: [
    { id: 'edge-a', name: 'edge:cap', signature: 'different-signature' },
    { id: 'edge-b', name: 'edge:side', signature: 'obsolete-signature' },
  ],
  getName,
  matchesSignature: forbiddenNamedFallback,
});
check('one named match resolves by exact name', named.id === 'edge-a');
check('named success never invokes signature matching', namedSignatureCalls === 0);

const namedMissing = expectResolutionError('missing persistent name', () => resolver.resolveTopologyReference({
  reference: { name: 'edge:gone', sig: 'alternate-hit' },
  topologyKind: 'edge',
  candidates: [{ id: 'signature-only-hit', signature: 'alternate-hit' }],
  getName,
  matchesSignature: forbiddenNamedFallback,
}), { code: codes.missing, topologyKind: 'edge', matchCount: 0, resolutionMode: 'name' });
check('missing named error preserves the persistent name', namedMissing.persistentName === 'edge:gone');
check('missing persistent name never falls back to signature', namedSignatureCalls === 0);

expectResolutionError('ambiguous persistent name', () => resolver.resolveTopologyReference({
  reference: { name: 'face:split', sig: 'unique-signature' },
  topologyKind: 'face',
  candidates: [
    { id: 'face-a', name: 'face:split', signature: 'other-a' },
    { id: 'face-b', name: 'face:split', signature: 'unique-signature' },
  ],
  getName,
  matchesSignature: forbiddenNamedFallback,
}), { code: codes.ambiguous, topologyKind: 'face', matchCount: 2, resolutionMode: 'name' });
check('ambiguous persistent name never falls back to signature', namedSignatureCalls === 0);

const matchesSignature = (signature: unknown, candidate: Candidate): boolean => signature === candidate.signature;
const unnamed = resolver.resolveTopologyReference({
  reference: 'vertex-signature',
  topologyKind: 'vertex',
  candidates: [
    { id: 'vertex-a', signature: 'other' },
    { id: 'vertex-b', signature: 'vertex-signature' },
  ],
  matchesSignature,
});
check('one bare signature resolves', unnamed.id === 'vertex-b');

expectResolutionError('missing signature', () => resolver.resolveTopologyReference({
  reference: { sig: 'edge-missing' },
  topologyKind: 'edge',
  candidates: [{ id: 'edge-a', signature: 'other' }],
  matchesSignature,
}), { code: codes.missing, topologyKind: 'edge', matchCount: 0, resolutionMode: 'signature' });

expectResolutionError('ambiguous signature', () => resolver.resolveTopologyReference({
  reference: { sig: 'face-duplicate' },
  topologyKind: 'face',
  candidates: [
    { id: 'face-a', signature: 'face-duplicate' },
    { id: 'face-b', signature: 'face-duplicate' },
  ],
  matchesSignature,
}), { code: codes.ambiguous, topologyKind: 'face', matchCount: 2, resolutionMode: 'signature' });

expectResolutionError('invalid unnamed reference', () => resolver.resolveTopologyReference({
  reference: null,
  topologyKind: 'vertex',
  candidates: [],
}), { code: codes.invalid, topologyKind: 'vertex', matchCount: 0, resolutionMode: 'signature' });

const workerSource = readFileSync(resolve(process.cwd(), 'src/static/studio-kernel.worker.js'), 'utf8');
const buildSource = readFileSync(resolve(process.cwd(), 'scripts/build.ts'), 'utf8');
check(
  'worker imports the shared resolver',
  workerSource.includes("import { resolveTopologyReference } from '/static/studio-topology-reference-resolver.js';"),
);
check(
  'static build includes the shared resolver',
  buildSource.includes("'studio-topology-reference-resolver.js',"),
);
check(
  'fillet and chamfer edge picks use fail-closed resolution',
  workerSource.includes("resolveModifierTopologyReference(reference, 'edge', lookups)"),
);
check(
  'variable fillet radius references use fail-closed resolution',
  workerSource.includes("resolveModifierTopologyReference(entry?.edge, 'edge', lookups)"),
);
check(
  'draft face picks use fail-closed resolution',
  workerSource.includes("const draftFaces = (feature.faces || []).map((reference) =>\n        resolveModifierTopologyReference(reference, 'face', lookups));"),
);
check(
  'face fillet derives its shared edge only after fail-closed face resolution',
  workerSource.includes("const selectedFaces = faceRefs.map((reference) =>\n          resolveModifierTopologyReference(reference, 'face', lookups));")
    && workerSource.includes('lookups.edgeCandidates.filter((candidate) =>'),
);
check(
  'shell face picks use fail-closed resolution',
  workerSource.includes("const shellFaces = (feature.faces || []).map((reference) =>\n        resolveModifierTopologyReference(reference, 'face', lookups));"),
);
check(
  'thicken face picks use fail-closed resolution',
  workerSource.includes("const thickenFaces = (feature.faces || []).map((reference) =>\n      resolveModifierTopologyReference(reference, 'face', lookups));"),
);
check(
  'exact lookup wrappers are disposed after modifier resolution',
  workerSource.includes('lookups.dispose();'),
);
check(
  'modifier integration no longer filters signatures to multiple picks',
  !workerSource.includes('shape.edges.filter((edge) => edgeMatches(entry.sig, edge))'),
);
check(
  'worker preserves stable resolver error codes in body diagnostics',
  workerSource.includes("...(typeof error?.code === 'string' ? { code: error.code } : {}),"),
);

console.log(JSON.stringify({
  named: 'resolved',
  namedMissing: codes.missing,
  namedAmbiguous: codes.ambiguous,
  unnamed: 'resolved',
  unnamedMissing: codes.missing,
  unnamedAmbiguous: codes.ambiguous,
  invalid: codes.invalid,
  namedSignatureCalls,
  integration: ['fillet', 'chamfer', 'variable-fillet', 'face-fillet', 'draft', 'shell', 'thicken'],
}));
