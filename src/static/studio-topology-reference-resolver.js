// Pure, kernel-independent topology-reference resolution.
//
// Persistent names are authoritative. Once a reference carries a name, a dead
// or ambiguous name is a repair condition and must never be redirected through
// a geometric signature. Bare signatures are the canonical unnamed-reference
// form.

export const TOPOLOGY_REFERENCE_ERROR_CODES = Object.freeze({
  invalid: 'TOPOLOGY_REFERENCE_INVALID',
  missing: 'TOPOLOGY_REFERENCE_MISSING',
  ambiguous: 'TOPOLOGY_REFERENCE_AMBIGUOUS',
});

export class TopologyReferenceResolutionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TopologyReferenceResolutionError';
    this.code = code;
    this.topologyKind = details.topologyKind;
    this.matchCount = details.matchCount;
    this.resolutionMode = details.resolutionMode;
    if (details.persistentName != null) this.persistentName = details.persistentName;
  }
}

function requireExactlyOne(matches, context) {
  if (matches.length === 1) return matches[0];
  const missing = matches.length === 0;
  const code = missing
    ? TOPOLOGY_REFERENCE_ERROR_CODES.missing
    : TOPOLOGY_REFERENCE_ERROR_CODES.ambiguous;
  const subject = context.resolutionMode === 'name'
    ? 'persistent name "' + context.persistentName + '"'
    : 'signature';
  const message = missing
    ? 'No ' + context.topologyKind + ' matched the stored ' + subject + '.'
    : matches.length + ' ' + context.topologyKind + ' candidates matched the stored ' + subject + '.';
  throw new TopologyReferenceResolutionError(code, message, {
    ...context,
    matchCount: matches.length,
  });
}

/**
 * Resolve a stored topology reference against current candidates.
 *
 * `reference` is either a named `{ name, sig }` reference or an unnamed
 * signature (a bare signature or `{ sig }`). `getName` and `matchesSignature`
 * adapt kernel-specific candidate objects without coupling this module to OCCT.
 */
export function resolveTopologyReference({
  reference,
  topologyKind,
  candidates,
  getName = (candidate) => candidate?.name ?? null,
  matchesSignature,
}) {
  const kind = typeof topologyKind === 'string' && topologyKind ? topologyKind : 'topology';
  const available = Array.isArray(candidates) ? candidates : [];
  const persistentName = typeof reference?.name === 'string' && reference.name.length
    ? reference.name
    : null;

  if (persistentName != null) {
    const matches = available.filter((candidate) => getName(candidate) === persistentName);
    return requireExactlyOne(matches, {
      topologyKind: kind,
      resolutionMode: 'name',
      persistentName,
    });
  }

  const signature = reference?.sig ?? reference;
  if (signature == null || typeof matchesSignature !== 'function') {
    throw new TopologyReferenceResolutionError(
      TOPOLOGY_REFERENCE_ERROR_CODES.invalid,
      'An unnamed ' + kind + ' reference requires a stored signature and matcher.',
      { topologyKind: kind, matchCount: 0, resolutionMode: 'signature' },
    );
  }
  const matches = available.filter((candidate) => matchesSignature(signature, candidate));
  return requireExactlyOne(matches, {
    topologyKind: kind,
    resolutionMode: 'signature',
  });
}
