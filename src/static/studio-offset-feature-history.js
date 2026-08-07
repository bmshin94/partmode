// Persistent topology provenance for offset-based PartMode features.
//
// Identity in this module is exclusively TopoDS_Shape::IsSame plus OCCT's
// operation history.  HashCode, geometric coordinates, and explorer order are
// deliberately never used to decide which persistent name belongs to a face.

export const OFFSET_FEATURE_HISTORY_ERROR_CODES = Object.freeze({
  invalidInput: 'OFFSET_FEATURE_HISTORY_INVALID_INPUT',
  missingProvenance: 'OFFSET_FEATURE_HISTORY_MISSING_PROVENANCE',
  ambiguousProvenance: 'OFFSET_FEATURE_HISTORY_AMBIGUOUS_PROVENANCE',
  incompleteCoverage: 'OFFSET_FEATURE_HISTORY_INCOMPLETE_COVERAGE',
  operationFailed: 'OFFSET_FEATURE_HISTORY_OPERATION_FAILED',
});

export class OffsetFeatureHistoryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OffsetFeatureHistoryError';
    this.code = code;
    for (const [key, value] of Object.entries(details)) this[key] = value;
    this.diagnostics = [{
      severity: 'error',
      code,
      ...details,
      message,
    }];
  }
}

const encoded = (value) => String(value).length + ':' + String(value);

export function offsetFeatureFaceNames(featureId, sourceFaceName) {
  const feature = encoded(featureId);
  const source = encoded(sourceFaceName);
  return Object.freeze({
    shellInner: `F${feature}:shell:inner:${source}`,
    thickenStart: `F${feature}:thicken:start:${source}`,
    thickenEnd: `F${feature}:thicken:end:${source}`,
  });
}

export function shellRimEdgeFaceName(featureId, edgeName) {
  return `F${encoded(featureId)}:shell:rim:edge:${encoded(edgeName)}`;
}

export function shellRimOpeningFaceName(featureId, sourceFaceName) {
  return `F${encoded(featureId)}:shell:rim:opening:${encoded(sourceFaceName)}`;
}

export function shellRimVertexFaceName(featureId, incidentEdgeNames) {
  const sorted = [...incidentEdgeNames].map(String).sort();
  const vertexProvenance = `V(${sorted.map(encoded).join('|')})`;
  return `F${encoded(featureId)}:shell:rim:vertex:${encoded(vertexProvenance)}`;
}

export function thickenSideFaceName(featureId, edgeName) {
  return `F${encoded(featureId)}:thicken:side:${encoded(edgeName)}`;
}

export function createStudioOffsetFeatureHistory(rc) {
  const oc = rc.getOC();
  const safeDelete = (value) => { try { value?.delete?.(); } catch {} };
  const disposeWrappers = (values) => { for (const value of values || []) safeDelete(value); };

  function fail(code, message, details = {}) {
    throw new OffsetFeatureHistoryError(code, message, details);
  }

  function exactSubshapes(shape, kind) {
    const shapeKind = kind === 'face'
      ? oc.TopAbs_ShapeEnum.TopAbs_FACE
      : kind === 'edge'
        ? oc.TopAbs_ShapeEnum.TopAbs_EDGE
        : oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
    const explorer = new oc.TopExp_Explorer_2(
      shape.wrapped,
      shapeKind,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    const wrappers = [];
    try {
      while (explorer.More()) {
        let current = null;
        let wrapper = null;
        try {
          current = explorer.Current();
          wrapper = rc.cast(current);
          if (wrappers.some((candidate) => candidate.wrapped.IsSame(wrapper.wrapped))) {
            safeDelete(wrapper);
          } else {
            wrappers.push(wrapper);
            wrapper = null;
          }
        } finally {
          safeDelete(wrapper);
          safeDelete(current);
        }
        explorer.Next();
      }
      return wrappers;
    } catch (error) {
      disposeWrappers(wrappers);
      throw error;
    } finally {
      safeDelete(explorer);
    }
  }

  const exactFaces = (shape) => exactSubshapes(shape, 'face');
  const exactEdges = (shape) => exactSubshapes(shape, 'edge');
  const exactVertices = (shape) => exactSubshapes(shape, 'vertex');

  // Takes ownership of the embind list returned from Generated/Modified.  The
  // TopoDS_Shape copies in the returned array remain caller-owned.
  function drainList(list) {
    const shapes = [];
    if (!list) return shapes;
    const copy = new oc.TopTools_ListOfShape_1();
    try {
      copy.Assign(list);
      while (copy.Size() > 0) {
        shapes.push(copy.First_1());
        copy.RemoveFirst();
      }
      return shapes;
    } finally {
      safeDelete(copy);
      safeDelete(list);
    }
  }

  function uniqueExactMatch(candidate, values, topologyKind, context) {
    const matches = values.filter((value) => value.wrapped.IsSame(candidate.wrapped));
    if (matches.length !== 1) {
      fail(
        OFFSET_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance,
        `Raw OCCT history did not resolve to exactly one ${topologyKind} in the owning shape.`,
        { reason: 'history-result-cardinality', topologyKind, context, candidateCount: matches.length },
      );
    }
    return matches[0];
  }

  function exactTableName(candidate, table, wrapperKey, topologyKind, required = false) {
    const matches = (table || []).filter((entry) => {
      try { return entry?.[wrapperKey]?.wrapped?.IsSame(candidate.wrapped); } catch { return false; }
    });
    const names = [...new Set(matches.map((entry) => String(entry.name)))].sort();
    if (matches.length > 1 || names.length > 1) {
      fail(
        OFFSET_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance,
        `One exact ${topologyKind} has more than one provenance entry.`,
        {
          reason: 'multiple-names-for-exact-subshape',
          topologyKind,
          candidateCount: matches.length,
          persistentNames: names,
        },
      );
    }
    if (!matches.length && required) {
      fail(
        OFFSET_FEATURE_HISTORY_ERROR_CODES.missingProvenance,
        `An exact ${topologyKind} required by the offset feature has no persistent name.`,
        { reason: 'missing-subshape-name', topologyKind },
      );
    }
    return matches.length ? names[0] : null;
  }

  function validateUniqueNames(entries, topologyKind) {
    const byName = new Map();
    for (const entry of entries || []) {
      const name = String(entry.name);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(entry);
    }
    const duplicates = [...byName.entries()]
      .filter(([, values]) => values.length !== 1)
      .map(([name]) => name)
      .sort();
    if (duplicates.length) {
      fail(
        OFFSET_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance,
        `Persistent ${topologyKind} names are not one-to-one.`,
        { reason: 'duplicate-persistent-name', topologyKind, persistentNames: duplicates },
      );
    }
  }

  function validateTableMembership(table, candidates, wrapperKey, topologyKind) {
    for (const entry of table || []) {
      const matches = candidates.filter((candidate) => {
        try { return candidate.wrapped.IsSame(entry?.[wrapperKey]?.wrapped); } catch { return false; }
      });
      if (matches.length !== 1) {
        fail(
          matches.length
            ? OFFSET_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance
            : OFFSET_FEATURE_HISTORY_ERROR_CODES.missingProvenance,
          `A supplied persistent ${topologyKind} entry does not resolve to exactly one exact source subshape.`,
          {
            reason: 'stale-or-ambiguous-table-entry',
            topologyKind,
            persistentName: String(entry?.name),
            candidateCount: matches.length,
          },
        );
      }
    }
  }

  function sourceTopology(shape, faceTable, suppliedEdgeTable = []) {
    validateUniqueNames(faceTable, 'face');
    validateUniqueNames(suppliedEdgeTable, 'edge');
    const faces = exactFaces(shape);
    const edges = exactEdges(shape);
    const vertices = exactVertices(shape);
    try {
      validateTableMembership(faceTable, faces, 'face', 'face');
      validateTableMembership(suppliedEdgeTable, edges, 'edge', 'edge');
      const faceNames = new Map();
      for (const face of faces) faceNames.set(face, exactTableName(face, faceTable, 'face', 'face', true));

      // Build exact edge/face incidence. A supplied edge name is authoritative.
      // Otherwise a unique pair of named adjacent faces is sufficient. If two
      // exact edges share that pair, no geometric suffix is invented.
      const edgeRecords = edges.map((edge) => {
        const adjacentFaceNames = faces
          .filter((face) => {
            const faceEdges = exactEdges(face);
            try { return faceEdges.some((candidate) => candidate.wrapped.IsSame(edge.wrapped)); }
            finally { disposeWrappers(faceEdges); }
          })
          .map((face) => faceNames.get(face))
          .sort();
        return {
          edge,
          adjacentFaceNames,
          suppliedName: exactTableName(edge, suppliedEdgeTable, 'edge', 'edge', false),
          name: null,
        };
      });
      const pairCounts = new Map();
      for (const record of edgeRecords) {
        if (record.adjacentFaceNames.length !== 2) continue;
        const pair = record.adjacentFaceNames.map(encoded).join('|');
        pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
      }
      for (const record of edgeRecords) {
        if (record.suppliedName) {
          record.name = record.suppliedName;
          continue;
        }
        if (record.adjacentFaceNames.length !== 2) {
          fail(
            OFFSET_FEATURE_HISTORY_ERROR_CODES.missingProvenance,
            'A source boundary edge has no supplied name and cannot be named by two adjacent persistent faces.',
            {
              reason: 'edge-adjacency-is-not-two-named-faces',
              topologyKind: 'edge',
              adjacentFaceNames: record.adjacentFaceNames,
            },
          );
        }
        const pair = record.adjacentFaceNames.map(encoded).join('|');
        if (pairCounts.get(pair) !== 1) {
          fail(
            OFFSET_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance,
            'Several exact source edges have the same named-face incidence.',
            {
              reason: 'indistinguishable-face-incidence',
              topologyKind: 'edge',
              adjacentFaceNames: record.adjacentFaceNames,
              candidateCount: pairCounts.get(pair),
            },
          );
        }
        record.name = `E(${pair})`;
      }
      validateUniqueNames(edgeRecords, 'edge');

      const vertexRecords = vertices.map((vertex) => {
        const incidentEdgeNames = edgeRecords
          .filter((record) => {
            const edgeVertices = exactVertices(record.edge);
            try { return edgeVertices.some((candidate) => candidate.wrapped.IsSame(vertex.wrapped)); }
            finally { disposeWrappers(edgeVertices); }
          })
          .map((record) => record.name)
          .sort();
        if (incidentEdgeNames.length < 2) {
          fail(
            OFFSET_FEATURE_HISTORY_ERROR_CODES.missingProvenance,
            'A source vertex does not have enough named incident edges for persistent provenance.',
            { reason: 'insufficient-named-edge-incidence', topologyKind: 'vertex', incidentEdgeNames },
          );
        }
        return { vertex, incidentEdgeNames };
      });
      const vertexKeys = vertexRecords.map((record) => record.incidentEdgeNames.map(encoded).join('|'));
      const duplicateVertexKeys = vertexKeys.filter((key, index) => vertexKeys.indexOf(key) !== index);
      if (duplicateVertexKeys.length) {
        fail(
          OFFSET_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance,
          'Several exact source vertices have indistinguishable named-edge incidence.',
          {
            reason: 'indistinguishable-edge-incidence',
            topologyKind: 'vertex',
            incidentEdgeKeys: [...new Set(duplicateVertexKeys)].sort(),
          },
        );
      }
      return { faces, edges, vertices, faceNames, edgeRecords, vertexRecords };
    } catch (error) {
      disposeWrappers(faces);
      disposeWrappers(edges);
      disposeWrappers(vertices);
      throw error;
    }
  }

  function disposeSourceTopology(topology) {
    disposeWrappers(topology?.faces);
    disposeWrappers(topology?.edges);
    disposeWrappers(topology?.vertices);
  }

  function createClaimRegistry(resultShape) {
    const resultFaces = exactFaces(resultShape);
    const claims = resultFaces.map((face) => ({ face, claims: [] }));
    return {
      resultFaces,
      claimExact(candidate, name, kind, source) {
        const record = uniqueExactMatch(candidate, resultFaces, 'face', { kind, source });
        claims.find((entry) => entry.face === record).claims.push({ name, kind, source });
        return record;
      },
      claimRaw(raw, name, kind, source) {
        let wrapped = null;
        try {
          if (raw.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) return null;
          wrapped = rc.cast(raw);
          return this.claimExact(wrapped, name, kind, source);
        } finally {
          safeDelete(wrapped);
        }
      },
      finish() {
        const ambiguous = [];
        const missing = [];
        const names = [];
        const usedNames = new Map();
        for (const entry of claims) {
          const unique = [...new Map(entry.claims.map((claim) => [claim.name, claim])).values()];
          if (!unique.length) {
            missing.push({ topologyKind: 'face', reason: 'unclaimed-result-face' });
            continue;
          }
          if (unique.length !== 1) {
            ambiguous.push({
              topologyKind: 'face',
              reason: 'conflicting-history-attribution',
              persistentNames: unique.map((claim) => claim.name).sort(),
              sources: unique.map((claim) => claim.source),
            });
            continue;
          }
          const claim = unique[0];
          if (!usedNames.has(claim.name)) usedNames.set(claim.name, []);
          usedNames.get(claim.name).push(entry);
          names.push({ name: claim.name, face: entry.face.clone() });
        }
        const duplicateNames = [...usedNames.entries()]
          .filter(([, entries]) => entries.length !== 1)
          .map(([name]) => name)
          .sort();
        if (missing.length || ambiguous.length || duplicateNames.length) {
          disposeWrappers(names.map((entry) => entry.face));
          if (ambiguous.length || duplicateNames.length) {
            fail(
              OFFSET_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance,
              'Offset history cannot assign a unique persistent name to every exact result face.',
              {
                reason: 'non-bijective-result-attribution',
                ambiguous,
                duplicateNames,
                missingFaceCount: missing.length,
              },
            );
          }
          fail(
            OFFSET_FEATURE_HISTORY_ERROR_CODES.incompleteCoverage,
            'Offset history left exact result faces unnamed.',
            { reason: 'unclaimed-result-faces', missingFaceCount: missing.length },
          );
        }
        return names;
      },
      dispose() { disposeWrappers(resultFaces); },
    };
  }

  function claimGenerated(builder, input, registry, name, kind, source) {
    const generated = drainList(builder.Generated(input.wrapped));
    const claimed = [];
    try {
      for (const output of generated) {
        const face = registry.claimRaw(output, name, kind, source);
        if (face && !claimed.includes(face)) claimed.push(face);
      }
      return claimed;
    } finally {
      for (const output of generated) safeDelete(output);
    }
  }

  function claimModified(builder, input, registry, name, kind, source) {
    const modified = drainList(builder.Modified(input.wrapped));
    try {
      for (const output of modified) registry.claimRaw(output, name, kind, source);
    } finally {
      for (const output of modified) safeDelete(output);
    }
  }

  function shellWithHistory({
    shape,
    openingFaces,
    faceTable,
    edgeTable = [],
    propagateExplicitTopology = null,
    featureId,
    thickness,
    tolerance = 1e-3,
  }) {
    if (!shape?.wrapped || !Array.isArray(openingFaces) || !openingFaces.length || !String(featureId || '')) {
      fail(OFFSET_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Shell history requires a shape, opening faces, and feature id.', {
        reason: 'invalid-shell-input',
      });
    }
    if (!Number.isFinite(thickness) || Math.abs(thickness) <= 1e-9) {
      fail(OFFSET_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Shell thickness must be finite and non-zero.', {
        reason: 'invalid-shell-thickness', thickness,
      });
    }
    let topology = null;
    let facesToRemove = null;
    let progress = null;
    let builder = null;
    let rawResult = null;
    let resultShape = null;
    let registry = null;
    let names = null;
    try {
      topology = sourceTopology(shape, faceTable, edgeTable);
      const openings = openingFaces.map((opening) =>
        uniqueExactMatch(opening, topology.faces, 'face', { operation: 'shell', role: 'opening' }));
      if (new Set(openings).size !== openings.length) {
        fail(OFFSET_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance, 'Shell contains duplicate exact opening faces.', {
          reason: 'duplicate-opening-face', topologyKind: 'face',
        });
      }

      facesToRemove = new oc.TopTools_ListOfShape_1();
      for (const opening of openings) facesToRemove.Append_1(opening.wrapped);
      progress = new oc.Message_ProgressRange_1();
      builder = new oc.BRepOffsetAPI_MakeThickSolid();
      builder.MakeThickSolidByJoin(
        shape.wrapped,
        facesToRemove,
        -thickness,
        tolerance,
        oc.BRepOffset_Mode.BRepOffset_Skin,
        false,
        false,
        // Intersection joins keep offset walls sharp and, critically, produce
        // an exact BREP serialization fixed point. OCCT Arc joins introduce
        // derived corner frames whose normalized direction components
        // oscillate by one ULP on alternate serialize/reopen passes; that shape
        // cannot be an authoritative checkpoint carrier. Tangent join is not
        // defined for this ordinary prismatic shell case.
        oc.GeomAbs_JoinType.GeomAbs_Intersection,
        false,
        progress,
      );
      if (!builder.IsDone()) {
        fail(OFFSET_FEATURE_HISTORY_ERROR_CODES.operationFailed, 'OCCT could not complete the shell operation.', {
          reason: 'shell-builder-not-done',
        });
      }
      rawResult = builder.Shape();
      resultShape = rc.cast(rawResult);
      safeDelete(rawResult);
      rawResult = null;
      if (!resultShape) {
        fail(OFFSET_FEATURE_HISTORY_ERROR_CODES.operationFailed, 'OCCT shell did not produce a 3D shape.', {
          reason: 'shell-result-not-3d',
        });
      }

      registry = createClaimRegistry(resultShape);
      for (const sourceFace of topology.faces) {
        const sourceName = topology.faceNames.get(sourceFace);
        const removed = openings.some((opening) => opening.wrapped.IsSame(sourceFace.wrapped));
        if (!removed) {
          const survivor = registry.resultFaces.filter((face) => face.wrapped.IsSame(sourceFace.wrapped));
          if (survivor.length > 1) {
            fail(OFFSET_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance, 'A source face survives more than once in the shell.', {
              reason: 'multiple-exact-survivors', topologyKind: 'face', persistentName: sourceName,
            });
          }
          if (survivor.length === 1) registry.claimExact(survivor[0], sourceName, 'surviving-outer', sourceName);
          claimModified(builder, sourceFace, registry, sourceName, 'modified-outer', sourceName);
          claimGenerated(
            builder,
            sourceFace,
            registry,
            offsetFeatureFaceNames(featureId, sourceName).shellInner,
            'inner-offset',
            sourceName,
          );
        } else {
          // OCCT may create a planar collar from the removed opening face. It
          // is new topology: the source name disappears and the collar gets a
          // feature-derived rim name instead.
          claimGenerated(
            builder,
            sourceFace,
            registry,
            shellRimOpeningFaceName(featureId, sourceName),
            'rim-opening',
            sourceName,
          );
          claimModified(
            builder,
            sourceFace,
            registry,
            shellRimOpeningFaceName(featureId, sourceName),
            'rim-opening',
            sourceName,
          );
        }
      }
      for (const record of topology.edgeRecords) {
        claimGenerated(
          builder,
          record.edge,
          registry,
          shellRimEdgeFaceName(featureId, record.name),
          'rim-edge',
          record.name,
        );
      }
      for (const record of topology.vertexRecords) {
        claimGenerated(
          builder,
          record.vertex,
          registry,
          shellRimVertexFaceName(featureId, record.incidentEdgeNames),
          'rim-vertex',
          record.incidentEdgeNames,
        );
      }
      names = registry.finish();
      names.diagnostics = [...(faceTable?.diagnostics || [])];
      if (typeof propagateExplicitTopology === 'function') {
        const overlays = propagateExplicitTopology({
          isDeleted: (subshape) => builder.IsDeleted(subshape),
          modified: (subshape) => drainList(builder.Modified(subshape)),
          generated: (subshape) => drainList(builder.Generated(subshape)),
        }, [faceTable], resultShape);
        if (overlays.edges !== null) names.explicitEdgeTable = overlays.edges;
        if (overlays.vertices !== null) names.explicitVertexTable = overlays.vertices;
      }
      const diagnostics = [...names.diagnostics];
      const outcome = { shape: resultShape, names, diagnostics };
      resultShape = null;
      names = null;
      return outcome;
    } catch (error) {
      disposeTable(names);
      safeDelete(resultShape);
      throw error;
    } finally {
      registry?.dispose();
      safeDelete(rawResult);
      safeDelete(builder);
      safeDelete(progress);
      safeDelete(facesToRemove);
      disposeSourceTopology(topology);
    }
  }

  function planarThickenWithHistory({
    sourceFace,
    sourceFaceName,
    boundaryEdgeTable,
    explicitEdgeTable = null,
    explicitVertexTable = null,
    topologyDiagnostics = [],
    propagateExplicitTopology = null,
    featureId,
    direction,
    thickness,
    symmetric = false,
  }) {
    if (!sourceFace?.wrapped || !sourceFaceName || !featureId || !Array.isArray(boundaryEdgeTable)) {
      fail(OFFSET_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Planar Thicken requires a source face and persistent face/edge provenance.', {
        reason: 'invalid-thicken-input',
      });
    }
    if (!Array.isArray(direction) || direction.length !== 3 || direction.some((value) => !Number.isFinite(value))) {
      fail(OFFSET_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Planar Thicken requires a finite three-dimensional direction.', {
        reason: 'invalid-thicken-direction', direction,
      });
    }
    const magnitude = Math.hypot(...direction);
    if (magnitude <= 1e-12 || !Number.isFinite(thickness) || thickness <= 1e-9) {
      fail(OFFSET_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Planar Thicken distance and direction must be positive.', {
        reason: 'invalid-thicken-distance', thickness,
      });
    }
    const unit = direction.map((value) => value / magnitude);
    let sourceEdges = null;
    let startFace = null;
    let startEdges = null;
    let transform = null;
    let translation = null;
    let vector = null;
    let builder = null;
    let rawResult = null;
    let resultShape = null;
    let registry = null;
    let names = null;
    let transformedExplicitTable = null;
    try {
      sourceEdges = exactEdges(sourceFace);
      validateUniqueNames(boundaryEdgeTable, 'edge');
      validateTableMembership(boundaryEdgeTable, sourceEdges, 'edge', 'edge');
      const edgeRecords = sourceEdges.map((edge) => ({
        edge,
        name: exactTableName(edge, boundaryEdgeTable, 'edge', 'edge', true),
      }));
      validateUniqueNames(edgeRecords, 'edge');

      startFace = sourceFace.clone();
      startEdges = edgeRecords.map((record) => ({ edge: record.edge, startEdge: record.edge, name: record.name }));
      if (symmetric) {
        translation = new rc.Transformation();
        translation.translate(unit.map((value) => -value * thickness / 2));
        transform = new oc.BRepBuilderAPI_Transform_2(sourceFace.wrapped, translation.wrapped, true);
        if (!transform.IsDone()) {
          fail(OFFSET_FEATURE_HISTORY_ERROR_CODES.operationFailed, 'OCCT could not place the symmetric Thicken start face.', {
            reason: 'thicken-start-transform-not-done',
          });
        }
        safeDelete(startFace);
        const rawStart = transform.ModifiedShape(sourceFace.wrapped);
        try { startFace = rc.cast(rawStart); } finally { safeDelete(rawStart); }
        startEdges = edgeRecords.map((record) => {
          const rawEdge = transform.ModifiedShape(record.edge.wrapped);
          try { return { edge: record.edge, startEdge: rc.cast(rawEdge), name: record.name, owned: true }; }
          finally { safeDelete(rawEdge); }
        });
      }

      const sourceExplicitTable = [];
      if (Array.isArray(explicitEdgeTable)) sourceExplicitTable.explicitEdgeTable = explicitEdgeTable;
      if (Array.isArray(explicitVertexTable)) sourceExplicitTable.explicitVertexTable = explicitVertexTable;
      let startExplicitTable = sourceExplicitTable;
      if (symmetric && typeof propagateExplicitTopology === 'function') {
        const overlays = propagateExplicitTopology({
          isDeleted: () => false,
          modified: (subshape) => {
            const modified = transform.ModifiedShape(subshape);
            return modified ? [modified] : [];
          },
          generated: () => [],
        }, [sourceExplicitTable], startFace);
        transformedExplicitTable = [];
        if (overlays.edges !== null) transformedExplicitTable.explicitEdgeTable = overlays.edges;
        if (overlays.vertices !== null) transformedExplicitTable.explicitVertexTable = overlays.vertices;
        startExplicitTable = transformedExplicitTable;
      }

      vector = new rc.Vector(unit.map((value) => value * thickness));
      builder = new oc.BRepPrimAPI_MakePrism_1(startFace.wrapped, vector.wrapped, false, true);
      if (!builder.IsDone()) {
        fail(OFFSET_FEATURE_HISTORY_ERROR_CODES.operationFailed, 'OCCT could not complete planar Thicken.', {
          reason: 'thicken-prism-not-done',
        });
      }
      rawResult = builder.Shape();
      resultShape = rc.cast(rawResult);
      safeDelete(rawResult);
      rawResult = null;
      if (!resultShape) {
        fail(OFFSET_FEATURE_HISTORY_ERROR_CODES.operationFailed, 'OCCT planar Thicken did not produce a 3D shape.', {
          reason: 'thicken-result-not-3d',
        });
      }

      registry = createClaimRegistry(resultShape);
      const semantic = offsetFeatureFaceNames(featureId, sourceFaceName);
      const claimed = new Set([
        registry.claimExact(startFace, semantic.thickenStart, 'thicken-start', sourceFaceName),
      ]);
      for (const record of startEdges) {
        const sideFaces = claimGenerated(
          builder,
          record.startEdge,
          registry,
          thickenSideFaceName(featureId, record.name),
          'thicken-side',
          record.name,
        );
        for (const face of sideFaces) claimed.add(face);
      }
      const endCandidates = registry.resultFaces.filter((face) => !claimed.has(face));
      if (endCandidates.length !== 1) {
        fail(
          OFFSET_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance,
          'Planar Thicken history did not leave exactly one end face.',
          {
            reason: 'thicken-end-cardinality',
            topologyKind: 'face',
            candidateCount: endCandidates.length,
          },
        );
      }
      registry.claimExact(endCandidates[0], semantic.thickenEnd, 'thicken-end', sourceFaceName);
      names = registry.finish();
      names.diagnostics = [...topologyDiagnostics];
      if (typeof propagateExplicitTopology === 'function') {
        const overlays = propagateExplicitTopology({
          isDeleted: (subshape) => builder.IsDeleted(subshape),
          modified: (subshape) => drainList(builder.Modified(subshape)),
          generated: (subshape) => drainList(builder.Generated(subshape)),
        }, [startExplicitTable], resultShape);
        if (overlays.edges !== null) names.explicitEdgeTable = overlays.edges;
        if (overlays.vertices !== null) names.explicitVertexTable = overlays.vertices;
      }
      const outcome = { shape: resultShape, names, diagnostics: [...names.diagnostics] };
      resultShape = null;
      names = null;
      return outcome;
    } catch (error) {
      disposeTable(names);
      safeDelete(resultShape);
      throw error;
    } finally {
      registry?.dispose();
      disposeTable(transformedExplicitTable);
      for (const record of startEdges || []) if (record.owned) safeDelete(record.startEdge);
      safeDelete(rawResult);
      safeDelete(builder);
      safeDelete(vector);
      safeDelete(transform);
      safeDelete(translation);
      safeDelete(startFace);
      disposeWrappers(sourceEdges);
    }
  }

  function disposeTable(table) {
    disposeWrappers((table || []).map((entry) => entry.face));
    disposeWrappers((table?.explicitEdgeTable || []).map((entry) => entry.edge));
    disposeWrappers((table?.explicitVertexTable || []).map((entry) => entry.vertex));
  }

  return {
    shellWithHistory,
    planarThickenWithHistory,
    disposeTable,
    exactFaces,
    exactEdges,
    disposeWrappers,
  };
}
