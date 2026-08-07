// Pure, kernel-independent persistent vertex naming.
//
// Vertex identity comes only from the caller's exact topological identity
// adapters. Coordinates are intentionally absent from this contract: two
// vertices may occupy the same point and must remain distinct when the kernel
// says they are distinct.

export const PERSISTENT_VERTEX_DIAGNOSTIC_CODES = Object.freeze({
  invalidInput: 'TOPOLOGY_VERTEX_INPUT_INVALID',
  invalidEndpoints: 'TOPOLOGY_VERTEX_EDGE_ENDPOINTS_INVALID',
  missingEdgeName: 'TOPOLOGY_VERTEX_EDGE_NAME_MISSING',
  ambiguousEdgeName: 'TOPOLOGY_VERTEX_EDGE_NAME_AMBIGUOUS',
  duplicateIncidence: 'TOPOLOGY_VERTEX_INCIDENCE_DUPLICATE',
  unnameable: 'TOPOLOGY_VERTEX_UNNAMEABLE',
  ambiguous: 'TOPOLOGY_VERTEX_AMBIGUOUS',
});

const MINIMUM_NAMED_INCIDENCE = 2;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function diagnosticSortKey(diagnostic) {
  return JSON.stringify(canonical(diagnostic));
}

function sortedDiagnostics(diagnostics) {
  return diagnostics.sort((left, right) => {
    const leftKey = diagnosticSortKey(left);
    const rightKey = diagnosticSortKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function emptyResult(inputEdgeCount, diagnostics) {
  return {
    vertexTable: [],
    diagnostics: sortedDiagnostics(diagnostics),
    counts: {
      inputEdgeCount,
      exactEdgeCount: 0,
      validEdgeCount: 0,
      authoritativeNamedEdgeCount: 0,
      exactVertexCount: 0,
      namedVertexCount: 0,
    },
  };
}

function requireIdentityResult(result, label) {
  if (typeof result !== 'boolean') {
    throw new TypeError(label + ' must return a boolean exact-identity result.');
  }
  return result;
}

function exactIdentity(left, right, isSame, label) {
  const forward = requireIdentityResult(isSame(left, right), label);
  const reverse = requireIdentityResult(isSame(right, left), label);
  if (forward !== reverse) throw new TypeError(label + ' must be symmetric for every supplied topology pair.');
  return forward;
}

function identityMatches(records, value, isSame, label) {
  if (!requireIdentityResult(isSame(value, value), label)) {
    throw new TypeError(label + ' must be reflexive for every supplied topology value.');
  }
  const matches = [];
  for (let index = 0; index < records.length; index++) {
    if (exactIdentity(records[index].value, value, isSame, label)) matches.push(index);
  }
  if (matches.length > 1) {
    throw new TypeError(label + ' identified one topology value as equal to multiple existing identity groups.');
  }
  return matches[0] ?? -1;
}

function sameEndpointPair(left, right, isSameVertex) {
  const same = (a, b) => exactIdentity(a, b, isSameVertex, 'isSameVertex');
  return (same(left[0], right[0]) && same(left[1], right[1])) ||
    (same(left[0], right[1]) && same(left[1], right[0]));
}

function readEdgeName(edge, getEdgeName) {
  const name = getEdgeName(edge);
  if (name == null || name === '') return null;
  if (typeof name !== 'string') throw new TypeError('getEdgeName must return a string, null, or undefined.');
  return name;
}

function readEdgeEndpoints(edge, getEdgeEndpoints) {
  const endpoints = getEdgeEndpoints(edge);
  if (!Array.isArray(endpoints) || endpoints.length !== 2 || endpoints[0] == null || endpoints[1] == null) return null;
  return [endpoints[0], endpoints[1]];
}

/**
 * Encode an unambiguous vertex name from an authoritative edge-incidence set.
 * Components are sorted and length-prefixed because edge names can themselves
 * contain every punctuation character used by the face/edge naming grammar.
 */
export function persistentVertexNameFromEdgeNames(edgeNames) {
  if (!Array.isArray(edgeNames)) throw new TypeError('Persistent vertex edge names must be an array.');
  const names = edgeNames.map((name) => {
    if (typeof name !== 'string' || !name) throw new TypeError('Persistent vertex edge names must be non-empty strings.');
    return name;
  }).sort();
  if (names.length < MINIMUM_NAMED_INCIDENCE) {
    throw new TypeError('A persistent vertex name requires at least two named incident edges.');
  }
  if (new Set(names).size !== names.length) {
    throw new TypeError('A persistent vertex name cannot contain duplicate edge incidence.');
  }
  return 'V(' + names.map((name) => name.length + ':' + name).join('|') + ')';
}

/**
 * Derive persistent vertex names from exact topology and persistent edge names.
 *
 * Required worker adapters:
 * - getEdgeName(edge): persistent edge name or null
 * - getEdgeEndpoints(edge): exactly two kernel vertex wrappers
 * - isSameEdge(left, right): exact kernel edge identity
 * - isSameVertex(left, right): exact kernel vertex identity
 *
 * `vertexTable` is sorted by generated name. A worker can map an exact vertex
 * back to its name with `isSameVertex(tableEntry.vertex, candidateVertex)`.
 * Diagnostics contain no coordinate-derived identity or input-order ordinals.
 */
export function derivePersistentVertexNames({
  edges,
  getEdgeName,
  getEdgeEndpoints,
  isSameEdge,
  isSameVertex,
} = {}) {
  const inputEdgeCount = Array.isArray(edges) ? edges.length : 0;
  if (
    !Array.isArray(edges) ||
    typeof getEdgeName !== 'function' ||
    typeof getEdgeEndpoints !== 'function' ||
    typeof isSameEdge !== 'function' ||
    typeof isSameVertex !== 'function'
  ) {
    return emptyResult(inputEdgeCount, [{
      code: PERSISTENT_VERTEX_DIAGNOSTIC_CODES.invalidInput,
      reason: 'missing-adapter',
      message: 'Vertex naming requires edges plus exact edge-name, endpoint, edge-identity, and vertex-identity adapters.',
    }]);
  }

  const diagnostics = [];
  try {
    // Group input wrappers by exact edge identity before reading incidence. A
    // repeated exact edge is reported and counted once, not silently doubled.
    const edgeGroups = [];
    for (const edge of edges) {
      if (edge == null) {
        diagnostics.push({
          code: PERSISTENT_VERTEX_DIAGNOSTIC_CODES.invalidInput,
          reason: 'null-edge',
          message: 'A null edge cannot participate in persistent vertex naming.',
        });
        continue;
      }
      const matchIndex = identityMatches(edgeGroups, edge, isSameEdge, 'isSameEdge');
      if (matchIndex < 0) edgeGroups.push({ value: edge, occurrences: [edge] });
      else edgeGroups[matchIndex].occurrences.push(edge);
    }

    const edgeRecords = [];
    let missingEdgeNameCount = 0;
    let invalidEndpointEdgeCount = 0;
    for (const group of edgeGroups) {
      const observedNames = group.occurrences.map((edge) => readEdgeName(edge, getEdgeName));
      const names = new Set(observedNames.filter(Boolean));
      const missingOccurrences = observedNames.filter((name) => name == null).length;
      let name = names.size === 1 ? [...names][0] : null;
      if (names.size > 1) {
        diagnostics.push({
          code: PERSISTENT_VERTEX_DIAGNOSTIC_CODES.ambiguousEdgeName,
          reason: 'conflicting-names-for-exact-edge',
          edgeNames: [...names].sort(),
          message: 'One exact edge was presented with conflicting persistent names.',
        });
      } else if (names.size === 0 || missingOccurrences > 0) {
        missingEdgeNameCount++;
      }

      const endpointPairs = group.occurrences
        .map((edge) => readEdgeEndpoints(edge, getEdgeEndpoints))
        .filter(Boolean);
      if (!endpointPairs.length || endpointPairs.length !== group.occurrences.length) {
        invalidEndpointEdgeCount++;
      }
      if (!endpointPairs.length) continue;
      if (endpointPairs.some((pair) => !sameEndpointPair(endpointPairs[0], pair, isSameVertex))) {
        diagnostics.push({
          code: PERSISTENT_VERTEX_DIAGNOSTIC_CODES.invalidEndpoints,
          reason: 'conflicting-endpoints-for-exact-edge',
          ...(name ? { edgeName: name } : {}),
          message: 'One exact edge was presented with conflicting exact endpoint identities.',
        });
        continue;
      }
      if (group.occurrences.length > 1) {
        diagnostics.push({
          code: PERSISTENT_VERTEX_DIAGNOSTIC_CODES.duplicateIncidence,
          reason: 'repeated-exact-edge-input',
          occurrenceCount: group.occurrences.length,
          ...(name ? { edgeName: name } : {}),
          message: 'A repeated exact edge input was counted once and reported as duplicate incidence.',
        });
      }
      if (missingOccurrences > 0 && names.size === 1) name = null;
      edgeRecords.push({ value: group.value, name, endpoints: endpointPairs[0] });
    }

    if (missingEdgeNameCount) {
      diagnostics.push({
        code: PERSISTENT_VERTEX_DIAGNOSTIC_CODES.missingEdgeName,
        edgeCount: missingEdgeNameCount,
        message: missingEdgeNameCount + ' exact edge' + (missingEdgeNameCount === 1 ? ' has' : 's have') + ' no persistent name.',
      });
    }
    if (invalidEndpointEdgeCount) {
      diagnostics.push({
        code: PERSISTENT_VERTEX_DIAGNOSTIC_CODES.invalidEndpoints,
        reason: 'missing-or-invalid-endpoints',
        edgeCount: invalidEndpointEdgeCount,
        message: invalidEndpointEdgeCount + ' exact edge' + (invalidEndpointEdgeCount === 1 ? ' has' : 's have') + ' missing or invalid endpoints.',
      });
    }

    // A persistent edge name must itself identify one exact edge. Duplicate
    // names on distinct edges are removed from authoritative incidence.
    const recordsByName = new Map();
    for (const record of edgeRecords) {
      if (!record.name) continue;
      if (!recordsByName.has(record.name)) recordsByName.set(record.name, []);
      recordsByName.get(record.name).push(record);
    }
    const ambiguousEdgeNames = new Set();
    for (const [name, records] of recordsByName) {
      if (records.length < 2) continue;
      ambiguousEdgeNames.add(name);
      diagnostics.push({
        code: PERSISTENT_VERTEX_DIAGNOSTIC_CODES.ambiguousEdgeName,
        reason: 'duplicate-name-on-distinct-edges',
        edgeName: name,
        edgeCount: records.length,
        message: 'A persistent edge name identifies more than one exact edge and cannot name a vertex.',
      });
    }

    // Partition endpoints only through the exact vertex identity adapter.
    const vertexRecords = [];
    for (const edgeRecord of edgeRecords) {
      for (const endpoint of edgeRecord.endpoints) {
        const matchIndex = identityMatches(vertexRecords, endpoint, isSameVertex, 'isSameVertex');
        const vertexRecord = matchIndex < 0
          ? { value: endpoint, incidences: [] }
          : vertexRecords[matchIndex];
        if (matchIndex < 0) vertexRecords.push(vertexRecord);
        // A closed periodic edge legitimately has one exact vertex serving as
        // both endpoints. Count that edge once; this is valid B-rep topology,
        // not duplicate input and therefore not a correctness diagnostic.
        if (!vertexRecord.incidences.includes(edgeRecord)) {
          vertexRecord.incidences.push(edgeRecord);
        }
      }
    }

    const incidenceNames = vertexRecords.map((vertexRecord) => [...new Set(vertexRecord.incidences
      .map((record) => record.name)
      .filter((name) => name && !ambiguousEdgeNames.has(name)))].sort());
    const incidenceSets = incidenceNames.map((names) => new Set(names));
    const vertexTable = [];
    const unresolved = new Map();
    const addUnresolved = (code, reason, names, matchingVertexCount = undefined) => {
      const key = JSON.stringify([code, reason, names, matchingVertexCount]);
      const existing = unresolved.get(key);
      if (existing) {
        existing.vertexCount++;
        return;
      }
      unresolved.set(key, {
        code,
        reason,
        incidentEdgeNames: [...names],
        vertexCount: 1,
        ...(matchingVertexCount === undefined ? {} : { matchingVertexCount }),
        message: code === PERSISTENT_VERTEX_DIAGNOSTIC_CODES.unnameable
          ? 'An exact vertex has fewer than two authoritative named incident edges.'
          : 'Named edge incidence resolves to more than one exact vertex.',
      });
    };

    for (let vertexIndex = 0; vertexIndex < vertexRecords.length; vertexIndex++) {
      const names = incidenceNames[vertexIndex];
      if (names.length < MINIMUM_NAMED_INCIDENCE) {
        addUnresolved(
          PERSISTENT_VERTEX_DIAGNOSTIC_CODES.unnameable,
          'insufficient-authoritative-named-incidence',
          names,
        );
        continue;
      }
      // The full incidence set is a witness only when no other exact vertex
      // contains every same named edge. A superset is still ambiguous because
      // the witness edges meet at both vertices.
      const matchingVertexIndices = incidenceSets
        .map((candidate, index) => names.every((name) => candidate.has(name)) ? index : -1)
        .filter((index) => index >= 0);
      if (matchingVertexIndices.length !== 1 || matchingVertexIndices[0] !== vertexIndex) {
        addUnresolved(
          PERSISTENT_VERTEX_DIAGNOSTIC_CODES.ambiguous,
          'named-incidence-not-unique',
          names,
          matchingVertexIndices.length,
        );
        continue;
      }
      vertexTable.push({
        name: persistentVertexNameFromEdgeNames(names),
        vertex: vertexRecords[vertexIndex].value,
        incidentEdgeNames: [...names],
      });
    }

    diagnostics.push(...unresolved.values());
    vertexTable.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    return {
      vertexTable,
      diagnostics: sortedDiagnostics(diagnostics),
      counts: {
        inputEdgeCount,
        exactEdgeCount: edgeGroups.length,
        validEdgeCount: edgeRecords.length,
        authoritativeNamedEdgeCount: edgeRecords.filter((record) => record.name && !ambiguousEdgeNames.has(record.name)).length,
        exactVertexCount: vertexRecords.length,
        namedVertexCount: vertexTable.length,
      },
    };
  } catch (error) {
    return emptyResult(inputEdgeCount, [{
      code: PERSISTENT_VERTEX_DIAGNOSTIC_CODES.invalidInput,
      reason: 'identity-or-adapter-failure',
      message: String(error?.message || error),
    }]);
  }
}
