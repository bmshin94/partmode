import { derivePersistentVertexNames } from './studio-topology-vertices.js';

// Topological naming for the CAD Studio v5 evaluator.
//
// Implements the reference contract of CAD_STUDIO_V5_COMPLEX_MODELING_SPEC.md §18:
// topology created by a feature receives a persistent provenance name, and every
// downstream operation propagates names through OCCT shape history
// (Modified/Generated/IsDeleted on the raw builders). Stored references resolve
// name-first without signature fallback; only unnamed signature references may use
// geometric-signature matching.
//
// A name table is an array of { name, face } entries where `face` is a replicad
// Face wrapper whose TopoDS handle stays valid for the lifetime of the owning
// body result (cache entries carry their tables; dispose together). Imported
// exact bodies may additionally own `explicitEdgeTable` and
// `explicitVertexTable` arrays. Those tables carry registry-backed opaque
// names which must never be replaced by face-incidence or coordinate guesses.
//
// Face names:
//   F<featureId>:cap:start / F<featureId>:cap:end      extrude caps
//   F<featureId>:side:<entityId>                        lateral face of a sketch entity
//   F<featureId>:blend:<edgeName>                       fillet/chamfer face from an edge
//   body:<toolBodyId>/<name>                            face arriving via a boolean body op
//   <name>#<k>                                          deterministic split disambiguator
// Edge names: E(<faceNameA>|<faceNameB>)[#<k>], canonical lexicographic face order.

export const TOPOLOGY_NAMING_ERROR_CODES = Object.freeze({
  ambiguousIdentity: 'TOPOLOGY_NAMING_AMBIGUOUS_IDENTITY',
  ambiguousSuffix: 'TOPOLOGY_NAMING_AMBIGUOUS_SUFFIX',
});

export class TopologyNamingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TopologyNamingError';
    this.code = code;
    for (const [key, value] of Object.entries(details)) this[key] = value;
  }
}

// A persistent suffix needs authoritative construction provenance. Geometry can
// be useful diagnostic evidence, but it cannot decide which exact subshape owns
// #0 or #1 because dimensional edits can reverse that order. Refuse every
// multi-candidate suffix group instead of guessing.
export function strictTopologySuffixOrder(baseName, candidates, _keyOf, topologyKind = 'topology') {
  if (candidates.length > 1) {
    throw new TopologyNamingError(
      TOPOLOGY_NAMING_ERROR_CODES.ambiguousSuffix,
      'Persistent ' + topologyKind + ' name "' + baseName + '" has ' + candidates.length
        + ' exact candidates without authoritative suffix provenance.',
      {
        reason: 'multiple-exact-candidates-without-provenance',
        topologyKind,
        persistentBaseName: baseName,
        candidateCount: candidates.length,
      },
    );
  }
  return candidates.map((candidate) => ({ candidate, key: '' }));
}

export function createStudioTopoNaming(rc) {
  const oc = rc.getOC();

  const safeDelete = (value) => { try { value?.delete(); } catch {} };

  // ---- OCCT list + history helpers -------------------------------------------

  // TopTools_ListOfShape has no bound iterator; Assign-copy and drain so the
  // builder's internal history list stays intact (verified empirically).
  // Takes ownership of `list` (the embind copy returned by Modified/Generated)
  // and frees it; the returned TopoDS_Shape copies are owned by the caller,
  // who must safeDelete each after use.
  function drainList(list) {
    const shapes = [];
    if (!list) return shapes;
    const copy = new oc.TopTools_ListOfShape_1();
    try {
      copy.Assign(list);
      while (copy.Size() > 0) { shapes.push(copy.First_1()); copy.RemoveFirst(); }
    } finally { safeDelete(copy); safeDelete(list); }
    return shapes;
  }

  const historyOf = (builder, strict = false) => ({
    isDeleted(face) {
      if (strict) return builder.IsDeleted(face);
      try { return builder.IsDeleted(face); } catch { return false; }
    },
    modified(face) {
      if (strict) return drainList(builder.Modified(face));
      try { return drainList(builder.Modified(face)); } catch { return []; }
    },
    generated(subshape) {
      if (strict) return drainList(builder.Generated(subshape));
      try { return drainList(builder.Generated(subshape)); } catch { return []; }
    },
  });

  // ---- vector helpers --------------------------------------------------------

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => Math.hypot(a[0], a[1], a[2]);
  const normalize = (a) => { const l = norm(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  const POSITION_TOLERANCE = 1e-4;
  const DIRECTION_TOLERANCE = 1 - 1e-6;

  // Replicad's public `.faces` / `.edges` accessors deduplicate by HashCode.
  // HashCode is a display/session identifier, not exact identity. Traverse the
  // OCCT topology directly and deduplicate only with TopoDS_Shape::IsSame.
  function exactSubshapeWrappers(shape, kind) {
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
      for (const wrapper of wrappers) safeDelete(wrapper);
      throw error;
    } finally {
      safeDelete(explorer);
    }
  }

  const exactFaces = (shape) => exactSubshapeWrappers(shape, 'face');
  const exactEdges = (shape) => exactSubshapeWrappers(shape, 'edge');
  const exactVertices = (shape) => exactSubshapeWrappers(shape, 'vertex');
  const disposeWrappers = (wrappers) => { for (const wrapper of wrappers || []) safeDelete(wrapper); };

  function exactEntryName(candidate, table, wrapperKey, topologyKind) {
    const candidateWrapped = candidate?.wrapped || candidate;
    const matches = (table || []).filter((entry) => {
      try { return entry[wrapperKey].wrapped.IsSame(candidateWrapped); } catch { return false; }
    });
    if (!matches.length) return null;
    const names = [...new Set(matches.map((entry) => entry.name))].sort();
    if (matches.length !== 1 || names.length !== 1) {
      throw new TopologyNamingError(
        TOPOLOGY_NAMING_ERROR_CODES.ambiguousIdentity,
        'One exact ' + topologyKind + ' is associated with multiple persistent-name entries.',
        {
          reason: 'multiple-names-for-exact-subshape',
          topologyKind,
          candidateCount: matches.length,
          persistentNames: names,
        },
      );
    }
    return names[0];
  }

  // ---- name tables -----------------------------------------------------------

  function disposeTable(table) {
    for (const entry of table || []) safeDelete(entry.face);
    for (const entry of table?.explicitEdgeTable || []) safeDelete(entry.edge);
    for (const entry of table?.explicitVertexTable || []) safeDelete(entry.vertex);
  }

  function validatedExplicitTable(shape, sourceTable, kind) {
    const wrapperKey = kind === 'edge' ? 'edge' : 'vertex';
    const candidates = kind === 'edge' ? exactEdges(shape) : exactVertices(shape);
    const table = [];
    table.diagnostics = [...(sourceTable?.diagnostics || [])];
    try {
      const names = new Set();
      const claimed = [];
      for (const entry of sourceTable || []) {
        if (typeof entry?.name !== 'string' || !entry.name || names.has(entry.name) || !entry?.[wrapperKey]?.wrapped) {
          throw new TopologyNamingError(
            TOPOLOGY_NAMING_ERROR_CODES.ambiguousIdentity,
            'An explicit persistent ' + kind + ' table is malformed or contains duplicate names.',
            { reason: 'invalid-explicit-table-entry', topologyKind: kind },
          );
        }
        const matches = candidates.filter((candidate) =>
          candidate.wrapped.IsSame(entry[wrapperKey].wrapped));
        if (matches.length !== 1 || claimed.some((candidate) => candidate.wrapped.IsSame(matches[0].wrapped))) {
          throw new TopologyNamingError(
            TOPOLOGY_NAMING_ERROR_CODES.ambiguousIdentity,
            'An explicit persistent ' + kind + ' name does not own exactly one exact subshape.',
            {
              reason: matches.length === 1 ? 'multiple-explicit-names-for-exact-subshape' : 'stale-explicit-subshape',
              topologyKind: kind,
              persistentName: entry.name,
              candidateCount: matches.length,
            },
          );
        }
        names.add(entry.name);
        claimed.push(matches[0]);
        table.push({ name: entry.name, [wrapperKey]: matches[0].clone() });
      }
      return table;
    } catch (error) {
      for (const entry of table) safeDelete(entry[wrapperKey]);
      throw error;
    } finally {
      disposeWrappers(candidates);
    }
  }

  const stripSplitSuffix = (name) => name.replace(/#\d+$/, '');

  // Propagate a name table through a history-reporting builder. `tables` is
  // ordered by precedence: the boolean target's names come before tool names, so
  // retained target faces win coincident-face merges (spec §18).
  //
  // Two-phase: first collect (inputName -> outputFace) pairs from the history
  // (Modified outputs, an operation-specific Generated fallback, or IsSame
  // survival for untouched faces), then resolve
  // per output face:
  //   - one contributor: keep its name;
  //   - several contributors that are #k siblings of one base (a seam-split
  //     surface re-unified by SimplifyResult): the base name;
  //   - genuinely different contributors (coincident faces merged): the
  //     highest-precedence contributor wins;
  // and finally re-suffix #k (by quantized centroid) when one name still maps
  // to several output faces (a split). Consumes nothing; caller disposes input
  // tables afterwards.
  function propagateTables(history, tables, resultShape, options = {}) {
    const pairs = []; // { name, order, output: replicad Face }
    const outputRegistry = []; // unique output faces (replicad wrappers)
    const registerOutput = (topoShape) => {
      let found = outputRegistry.find((candidate) => candidate.wrapped.IsSame(topoShape));
      if (!found) { found = rc.cast(topoShape); outputRegistry.push(found); }
      return found;
    };
    let resultFaces = null;
    const facesOfResult = () => (resultFaces ||= exactFaces(resultShape));
    const kept = new Set();
    let returned = false;
    try {
      let order = 0;
      for (const table of tables) {
        for (const { name, face } of table || []) {
          const topo = face.wrapped;
          order++;
          if (history.isDeleted(topo)) continue;
          const outputs = history.modified(topo);
          if (!outputs.length && options.generatedFallback) {
            const generated = history.generated(topo);
            outputs.push(...generated);
          }
          if (outputs.length) {
            for (const output of outputs) {
              try { pairs.push({ name, order, output: registerOutput(output) }); }
              finally { safeDelete(output); }
            }
            continue;
          }
          // Untouched faces keep their exact TopoDS identity in the result.
          const survivor = facesOfResult().find((candidate) => candidate.wrapped.IsSame(topo));
          if (survivor) pairs.push({ name, order, output: registerOutput(survivor.wrapped) });
        }
      }
      // Resolve one candidate name per distinct exact output face.
      const candidates = []; // { name, output }
      for (const output of outputRegistry) {
        const contributors = pairs.filter((pair) => pair.output === output).sort((a, b) => a.order - b.order);
        const uniqueNames = [...new Set(contributors.map((pair) => pair.name))];
        if (!uniqueNames.length) continue;
        let name;
        if (uniqueNames.length === 1) name = uniqueNames[0];
        else {
          const bases = [...new Set(uniqueNames.map(stripSplitSuffix))];
          name = bases.length === 1 ? bases[0] : uniqueNames[0];
        }
        candidates.push({ name, output });
      }
      // A single persistent input name splitting into several exact outputs has
      // no identity until the operation supplies more provenance. Omit that
      // whole group and expose a structured diagnostic; never order by geometry.
      const byName = new Map();
      for (const candidate of candidates) {
        if (!byName.has(candidate.name)) byName.set(candidate.name, []);
        byName.get(candidate.name).push(candidate.output);
      }
      const next = [];
      next.diagnostics = tables.flatMap((table) => table?.diagnostics || []);
      for (const [name, outputs] of byName) {
        if (outputs.length === 1) {
          next.push({ name, face: outputs[0] });
          kept.add(outputs[0]);
          continue;
        }
        next.diagnostics.push({
          severity: 'error',
          code: TOPOLOGY_NAMING_ERROR_CODES.ambiguousSuffix,
          reason: 'multiple-exact-candidates-without-provenance',
          topologyKind: 'face',
          persistentBaseName: name,
          candidateCount: outputs.length,
        });
      }
      const counts = new Map();
      for (const entry of next) counts.set(entry.name, (counts.get(entry.name) || 0) + 1);
      const duplicateNames = [...counts.entries()]
        .filter(([, count]) => count !== 1)
        .map(([name]) => name)
        .sort();
      if (duplicateNames.length) {
        throw new TopologyNamingError(
          TOPOLOGY_NAMING_ERROR_CODES.ambiguousIdentity,
          'Persistent face propagation produced duplicate names.',
          { reason: 'duplicate-propagated-name', topologyKind: 'face', persistentNames: duplicateNames },
        );
      }
      returned = true;
      return next;
    } finally {
      disposeWrappers(resultFaces);
      for (const output of outputRegistry) if (!returned || !kept.has(output)) safeDelete(output);
    }
  }

  const explicitTopology = Object.freeze({
    edge: Object.freeze({ tableKey: 'explicitEdgeTable', wrapperKey: 'edge', shapeType: oc.TopAbs_ShapeEnum.TopAbs_EDGE }),
    vertex: Object.freeze({ tableKey: 'explicitVertexTable', wrapperKey: 'vertex', shapeType: oc.TopAbs_ShapeEnum.TopAbs_VERTEX }),
  });

  function propagatedExplicitTable(history, tables, resultShape, kind) {
    const info = explicitTopology[kind];
    const ownsOverlay = tables.some((table) =>
      table && Object.prototype.hasOwnProperty.call(table, info.tableKey));
    if (!ownsOverlay) return null;
    const resultCandidates = kind === 'edge' ? exactEdges(resultShape) : exactVertices(resultShape);
    const sourceEntries = tables.flatMap((table) => table?.[info.tableKey] || []);
    const next = [];
    next.diagnostics = tables.flatMap((table) => table?.[info.tableKey]?.diagnostics || []);
    const sourceNames = new Set();
    const sourceShapes = [];
    const claimedOutputs = [];
    try {
      for (const entry of sourceEntries) {
        const source = entry?.[info.wrapperKey];
        if (typeof entry?.name !== 'string' || !entry.name || !source?.wrapped) {
          throw new TopologyNamingError(
            TOPOLOGY_NAMING_ERROR_CODES.ambiguousIdentity,
            'An explicit persistent ' + kind + ' propagation entry is malformed.',
            { reason: 'invalid-explicit-propagation-entry', topologyKind: kind },
          );
        }
        if (sourceNames.has(entry.name)) {
          throw new TopologyNamingError(
            TOPOLOGY_NAMING_ERROR_CODES.ambiguousIdentity,
            'An explicit persistent ' + kind + ' name occurs more than once in the operation inputs.',
            { reason: 'duplicate-explicit-input-name', topologyKind: kind, persistentName: entry.name },
          );
        }
        if (sourceShapes.some((candidate) => candidate.wrapped.IsSame(source.wrapped))) {
          throw new TopologyNamingError(
            TOPOLOGY_NAMING_ERROR_CODES.ambiguousIdentity,
            'One exact input ' + kind + ' owns more than one explicit persistent name.',
            { reason: 'multiple-explicit-names-for-input-subshape', topologyKind: kind, persistentName: entry.name },
          );
        }
        sourceNames.add(entry.name);
        sourceShapes.push(source);

        // Exact survival is stronger evidence than Modified history. Offset
        // builders can retain an outer boundary IsSame while also reporting a
        // newly created inner boundary from that source subshape.
        const survivors = resultCandidates.filter((candidate) =>
          candidate.wrapped.IsSame(source.wrapped));
        if (survivors.length > 1) {
          throw new TopologyNamingError(
            TOPOLOGY_NAMING_ERROR_CODES.ambiguousIdentity,
            'One explicit persistent ' + kind + ' survives as several exact result subshapes.',
            {
              reason: 'multiple-exact-survivors',
              topologyKind: kind,
              persistentName: entry.name,
              candidateCount: survivors.length,
            },
          );
        }

        let output = survivors[0] || null;
        if (!output) {
          const modified = history.modified(source.wrapped);
          const modifiedMatches = [];
          try {
            for (const raw of modified) {
              if (raw.ShapeType() !== info.shapeType) continue;
              const matches = resultCandidates.filter((candidate) =>
                candidate.wrapped.IsSame(raw));
              if (matches.length > 1) {
                throw new TopologyNamingError(
                  TOPOLOGY_NAMING_ERROR_CODES.ambiguousIdentity,
                  'OCCT history resolved one explicit persistent ' + kind + ' output more than once.',
                  {
                    reason: 'modified-output-membership-ambiguous',
                    topologyKind: kind,
                    persistentName: entry.name,
                    candidateCount: matches.length,
                  },
                );
              }
              if (matches.length === 1 && !modifiedMatches.some((candidate) =>
                candidate.wrapped.IsSame(matches[0].wrapped))) modifiedMatches.push(matches[0]);
            }
          } finally {
            for (const raw of modified) safeDelete(raw);
          }
          if (modifiedMatches.length > 1) {
            throw new TopologyNamingError(
              TOPOLOGY_NAMING_ERROR_CODES.ambiguousSuffix,
              'OCCT history split one explicit persistent ' + kind + ' into several exact result subshapes.',
              {
                reason: 'explicit-history-split',
                topologyKind: kind,
                persistentName: entry.name,
                candidateCount: modifiedMatches.length,
              },
            );
          }
          output = modifiedMatches[0] || null;
        }
        if (!output) {
          const generated = history.generated(source.wrapped);
          for (const raw of generated) safeDelete(raw);
          // Generated topology is new topology. It never inherits the opaque
          // identity of the consumed input edge or vertex. Likewise, when a
          // builder supplies neither IsSame survival nor one Modified result,
          // the opaque name is retired; derived result provenance may name the
          // replacement, but the old identity is never guessed onto it.
          continue;
        }
        if (claimedOutputs.some((candidate) => candidate.wrapped.IsSame(output.wrapped))) {
          throw new TopologyNamingError(
            TOPOLOGY_NAMING_ERROR_CODES.ambiguousIdentity,
            'Several explicit persistent ' + kind + ' names resolve to one exact result subshape.',
            { reason: 'explicit-output-already-claimed', topologyKind: kind, persistentName: entry.name },
          );
        }
        claimedOutputs.push(output);
        next.push({ name: entry.name, [info.wrapperKey]: output.clone() });
      }
      return next;
    } catch (error) {
      for (const entry of next) safeDelete(entry[info.wrapperKey]);
      throw error;
    } finally {
      disposeWrappers(resultCandidates);
    }
  }

  function propagateExplicitTopology(history, tables, resultShape) {
    const overlays = { edges: null, vertices: null };
    try {
      overlays.edges = propagatedExplicitTable(history, tables, resultShape, 'edge');
      overlays.vertices = propagatedExplicitTable(history, tables, resultShape, 'vertex');
      return overlays;
    } catch (error) {
      for (const entry of overlays.edges || []) safeDelete(entry.edge);
      for (const entry of overlays.vertices || []) safeDelete(entry.vertex);
      throw error;
    }
  }

  function attachExplicitTopology(names, history, tables, resultShape) {
    const overlays = propagateExplicitTopology(history, tables, resultShape);
    if (overlays.edges !== null) names.explicitEdgeTable = overlays.edges;
    if (overlays.vertices !== null) names.explicitVertexTable = overlays.vertices;
    return names;
  }

  function prefixTable(table, prefix) {
    const prefixed = (table || []).map(({ name, face }) => ({ name: prefix + name, face: face.clone() }));
    prefixed.diagnostics = [...(table?.diagnostics || [])];
    if (table?.explicitEdgeTable) {
      prefixed.explicitEdgeTable = table.explicitEdgeTable.map(({ name, edge }) => ({
        name: prefix + name,
        edge: edge.clone(),
      }));
    }
    if (table?.explicitVertexTable) {
      prefixed.explicitVertexTable = table.explicitVertexTable.map(({ name, vertex }) => ({
        name: prefix + name,
        vertex: vertex.clone(),
      }));
    }
    return prefixed;
  }

  function transformExplicitTable(builder, resultShape, sourceTable, kind) {
    if (!sourceTable) return null;
    const wrapperKey = kind === 'edge' ? 'edge' : 'vertex';
    const candidates = kind === 'edge' ? exactEdges(resultShape) : exactVertices(resultShape);
    const table = [];
    table.diagnostics = [...(sourceTable.diagnostics || [])];
    try {
      const claimed = [];
      for (const entry of sourceTable) {
        let raw = null;
        try {
          raw = builder.ModifiedShape(entry[wrapperKey].wrapped);
          const matches = candidates.filter((candidate) => candidate.wrapped.IsSame(raw));
          if (matches.length !== 1 || claimed.some((candidate) => candidate.wrapped.IsSame(matches[0].wrapped))) {
            throw new TopologyNamingError(
              TOPOLOGY_NAMING_ERROR_CODES.ambiguousIdentity,
              'Transform history did not preserve one explicit persistent ' + kind + ' name one-to-one.',
              {
                reason: matches.length === 1 ? 'transform-explicit-output-already-claimed' : 'transform-explicit-history-mismatch',
                topologyKind: kind,
                persistentName: entry.name,
                candidateCount: matches.length,
              },
            );
          }
          claimed.push(matches[0]);
          table.push({ name: entry.name, [wrapperKey]: matches[0].clone() });
        } finally {
          safeDelete(raw);
        }
      }
      return table;
    } catch (error) {
      for (const entry of table) safeDelete(entry[wrapperKey]);
      throw error;
    } finally {
      disposeWrappers(candidates);
    }
  }

  // ---- shape modifiers with history -----------------------------------------

  // Mirrors replicad's rigid/uniform transform path (copy=true) while retaining
  // BRepBuilderAPI_Transform long enough to map every named input face through
  // its Modified history.
  function transformWithNames(shape, transformation, faceTable) {
    let builder = null;
    let rawResult = null;
    let resultShape = null;
    try {
      builder = new oc.BRepBuilderAPI_Transform_2(shape.wrapped, transformation.wrapped, true);
      if (!builder.IsDone()) throw new Error('Could not complete the transform operation');
      rawResult = builder.ModifiedShape(shape.wrapped);
      resultShape = rc.cast(rawResult);
      safeDelete(rawResult);
      rawResult = null;
      if (!resultShape) throw new Error('Could not transform as a 3d shape');
      const names = propagateTables(historyOf(builder, true), [faceTable], resultShape);
      let explicitEdges = null;
      try {
        explicitEdges = transformExplicitTable(
          builder,
          resultShape,
          faceTable?.explicitEdgeTable,
          'edge',
        );
        const explicitVertices = transformExplicitTable(
          builder,
          resultShape,
          faceTable?.explicitVertexTable,
          'vertex',
        );
        if (explicitEdges !== null) names.explicitEdgeTable = explicitEdges;
        if (explicitVertices !== null) names.explicitVertexTable = explicitVertices;
      } catch (error) {
        if (!names.explicitEdgeTable) for (const entry of explicitEdges || []) safeDelete(entry.edge);
        disposeTable(names);
        throw error;
      }
      return { shape: resultShape, names };
    } catch (error) {
      safeDelete(resultShape);
      throw error;
    } finally {
      safeDelete(rawResult);
      safeDelete(builder);
    }
  }

  // Mirrors Shape.draft exactly: degrees at the public boundary, a neutral
  // plane normal as pull direction, and BRepOffsetAPI_DraftAngle history for
  // both selected and adjacent faces.
  function draftWithNames(shape, selectedFaces, faceTable, angleDegrees, neutralPlane) {
    let builder = null;
    let origin = null;
    let direction = null;
    let plane = null;
    let progress = null;
    let rawResult = null;
    let resultShape = null;
    try {
      builder = new oc.BRepOffsetAPI_DraftAngle_2(shape.wrapped);
      origin = new oc.gp_Pnt_2(neutralPlane.origin.wrapped.XYZ());
      direction = new oc.gp_Dir_3(neutralPlane.zDir.wrapped.XYZ());
      plane = new oc.gp_Pln_3(origin, direction);
      for (const face of selectedFaces) {
        builder.Add(face.wrapped, direction, angleDegrees * Math.PI / 180, plane, false);
        if (!builder.AddDone()) throw new Error('Could not add the selected face to the draft operation');
      }
      progress = new oc.Message_ProgressRange_1();
      builder.Build(progress);
      if (!builder.IsDone()) throw new Error('Could not complete the draft operation');
      rawResult = builder.ModifiedShape(shape.wrapped);
      resultShape = rc.cast(rawResult);
      safeDelete(rawResult);
      rawResult = null;
      if (!resultShape) throw new Error('Could not draft as a 3d shape');
      const history = historyOf(builder, true);
      const names = propagateTables(history, [faceTable], resultShape, { generatedFallback: true });
      try {
        attachExplicitTopology(names, history, [faceTable], resultShape);
      } catch (error) {
        disposeTable(names);
        throw error;
      }
      return { shape: resultShape, names };
    } catch (error) {
      safeDelete(resultShape);
      throw error;
    } finally {
      safeDelete(progress);
      safeDelete(rawResult);
      safeDelete(plane);
      safeDelete(direction);
      safeDelete(origin);
      safeDelete(builder);
    }
  }

  // Mirrors Shape.shell exactly. `thickness` retains replicad's public sign
  // convention; MakeThickSolidByJoin receives its negation.
  function shellWithNames(shape, selectedFaces, faceTable, thickness, tolerance = 1e-3) {
    let builder = null;
    let facesToRemove = null;
    let progress = null;
    let rawResult = null;
    let resultShape = null;
    try {
      facesToRemove = new oc.TopTools_ListOfShape_1();
      for (const face of selectedFaces) facesToRemove.Append_1(face.wrapped);
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
        oc.GeomAbs_JoinType.GeomAbs_Arc,
        false,
        progress,
      );
      if (!builder.IsDone()) throw new Error('Could not complete the shell operation');
      rawResult = builder.Shape();
      resultShape = rc.cast(rawResult);
      safeDelete(rawResult);
      rawResult = null;
      if (!resultShape) throw new Error('Could not shell as a 3d shape');
      // A removed opening face may appear in Modified history as a newly made
      // rim face. That rim is not the old face, so its old persistent name must
      // disappear. Unselected walls still propagate through Modified/IsSame;
      // generated offset and rim topology stays unnamed until it receives its
      // own feature-derived provenance scheme.
      const survivingTable = (faceTable || []).filter(({ face }) =>
        !selectedFaces.some((selected) => selected.wrapped.IsSame(face.wrapped)));
      survivingTable.diagnostics = [...(faceTable?.diagnostics || [])];
      const history = historyOf(builder, true);
      const names = propagateTables(history, [survivingTable], resultShape);
      try {
        // Opening faces are excluded only from face-name propagation. Their
        // boundary E/V identities still survive when OCCT retains them exactly
        // or reports one authoritative Modified result.
        attachExplicitTopology(names, history, [faceTable], resultShape);
      } catch (error) {
        disposeTable(names);
        throw error;
      }
      return { shape: resultShape, names };
    } catch (error) {
      safeDelete(resultShape);
      throw error;
    } finally {
      safeDelete(builder);
      safeDelete(rawResult);
      safeDelete(progress);
      safeDelete(facesToRemove);
    }
  }

  // ---- booleans with history -------------------------------------------------

  // Mirrors replicad's fuse/cut/intersect (same builders, same SimplifyResult
  // call) but keeps the builder long enough to read its history.
  function booleanWithNames(kind, targetShape, toolShape, targetTable, toolTable) {
    const progress = new oc.Message_ProgressRange_1();
    let builder = null;
    let resultShape = null;
    try {
      builder =
        kind === 'fuse' ? new oc.BRepAlgoAPI_Fuse_3(targetShape.wrapped, toolShape.wrapped, progress)
        : kind === 'cut' ? new oc.BRepAlgoAPI_Cut_3(targetShape.wrapped, toolShape.wrapped, progress)
        : new oc.BRepAlgoAPI_Common_3(targetShape.wrapped, toolShape.wrapped, progress);
      builder.Build(progress);
      builder.SimplifyResult(true, true, 1e-3);
      resultShape = rc.cast(builder.Shape());
      if (!resultShape) throw new Error('Could not ' + kind + ' as a 3d shape');
      const history = historyOf(builder, true);
      const names = propagateTables(history, [targetTable, toolTable], resultShape);
      try {
        attachExplicitTopology(names, history, [targetTable, toolTable], resultShape);
      } catch (error) {
        disposeTable(names);
        throw error;
      }
      return { shape: resultShape, names };
    } catch (error) {
      safeDelete(resultShape);
      throw error;
    } finally {
      safeDelete(builder);
      safeDelete(progress);
    }
  }

  // ---- creation naming for extrusions ---------------------------------------

  function planeGeometry(face) {
    // Exact plane parameters of a planar face.
    const center = face.center;
    const normal = face.normalAt();
    try {
      return { origin: [center.x, center.y, center.z], normal: normalize([normal.x, normal.y, normal.z]) };
    } finally {
      safeDelete(normal);
      safeDelete(center);
    }
  }

  function cylinderGeometry(face) {
    let adaptor = null; let cylinder = null; let axis = null; let location = null; let direction = null;
    try {
      adaptor = new oc.BRepAdaptor_Surface_2(face.wrapped, true);
      cylinder = adaptor.Cylinder();
      axis = cylinder.Axis();
      location = axis.Location();
      direction = axis.Direction();
      return {
        radius: cylinder.Radius(),
        axisPoint: [location.X(), location.Y(), location.Z()],
        axisDirection: normalize([direction.X(), direction.Y(), direction.Z()]),
      };
    } catch { return null; }
    finally { safeDelete(direction); safeDelete(location); safeDelete(axis); safeDelete(cylinder); safeDelete(adaptor); }
  }

  const pointToLineDistance = (point, linePoint, lineDirection) => norm(cross(sub(point, linePoint), lineDirection));

  function constructionEnvelopeMatches(face, points) {
    let boundingBox = null;
    try {
      boundingBox = face?.boundingBox;
      const bounds = boundingBox?.bounds;
      if (
        !Array.isArray(bounds)
        || bounds.length !== 2
        || bounds.some((corner) => !Array.isArray(corner) || corner.length !== 3)
      ) return false;
      const expected = [0, 1, 2].map((axis) => [
        Math.min(...points.map((point) => point[axis])),
        Math.max(...points.map((point) => point[axis])),
      ]);
      const tolerance = Math.max(
        POSITION_TOLERANCE,
        ...expected.map(([low, high]) => Math.abs(high - low) * 1e-7),
      );
      return expected.every(([low, high], axis) =>
        Math.abs(bounds[0][axis] - low) <= tolerance
        && Math.abs(bounds[1][axis] - high) <= tolerance);
    } finally {
      safeDelete(boundingBox);
    }
  }

  // Assign creation names to the faces of a freshly built extrude/cut solid.
  // `context` carries exact construction knowledge:
  //   featureId, entities (non-construction exact sketch entities),
  //   toWorld(point2d) -> 3D point on the sketch plane, sweepDirection (unit),
  //   capOffsets: [startOffset, endOffset] along sweepDirection from the sketch
  //   plane's origin projection.
  // Any ambiguity (a face matching several entities or several faces matching
  // one entity) leaves that topology unnamed. Schema-5 serialization then emits
  // TOPOLOGY_PERSISTENCE_INCOMPLETE, and named references never fall back to a
  // geometric signature.
  function creationNamesForSweep(solidShape, context) {
    const { featureId, entities, toWorld, sweepDirection, capOffsets } = context;
    const names = [];
    names.diagnostics = [];
    const faces = exactFaces(solidShape);
    const claimed = new Set();
    const planeOrigin = toWorld([0, 0]);
    try {
      // Caps: planar faces whose normal is parallel to the sweep direction.
      const capCandidates = [];
      for (const face of faces) {
        if (face.geomType !== 'PLANE') continue;
        const { origin, normal } = planeGeometry(face);
        if (Math.abs(dot(normal, sweepDirection)) < DIRECTION_TOLERANCE) continue;
        capCandidates.push({ face, offset: dot(sub(origin, planeOrigin), sweepDirection) });
      }
      const capTolerance = Math.max(POSITION_TOLERANCE, Math.abs(capOffsets[1] - capOffsets[0]) * 1e-6);
      for (const [index, role] of [[0, 'start'], [1, 'end']]) {
        const matches = capCandidates.filter((candidate) => Math.abs(candidate.offset - capOffsets[index]) < capTolerance);
        if (matches.length === 1 && !claimed.has(matches[0].face)) {
          names.push({ name: 'F' + featureId + ':cap:' + role, face: matches[0].face.clone() });
          claimed.add(matches[0].face);
        }
      }

      // Side faces: each swept entity produces one lateral face whose surface we
      // can predict exactly. Entities arrive pre-evaluated:
      //   { kind: 'line', id, a2: [x, y], b2: [x, y] }
      //   { kind: 'circle' | 'arc', id, center2: [x, y], radius }
      // A face matching several entities, or several faces matching one entity,
      // stays unnamed.
      const sideMatches = new Map();
      for (const entity of entities) {
        let matches = [];
        if (entity.kind === 'line') {
          const start = toWorld(entity.a2);
          const end = toWorld(entity.b2);
          const segment = sub(end, start);
          if (norm(segment) < POSITION_TOLERANCE) continue;
          const expectedNormal = normalize(cross(normalize(segment), sweepDirection));
          matches = faces.filter((face) => {
            if (face.geomType !== 'PLANE' || claimed.has(face)) return false;
            const { origin, normal } = planeGeometry(face);
            if (Math.abs(dot(normal, expectedNormal)) < DIRECTION_TOLERANCE) return false;
            return Math.abs(dot(sub(start, origin), normal)) < POSITION_TOLERANCE
              && Math.abs(dot(sub(end, origin), normal)) < POSITION_TOLERANCE;
          });
          // Concave profiles can contain disconnected, collinear boundary
          // segments (for example the two outer flange edges of a channel).
          // Their lateral faces share one support plane, so plane membership
          // alone is deliberately ambiguous. Resolve only from the complete
          // authored sweep envelope for this semantic segment; this remains
          // construction provenance and never orders faces by a geometry
          // signature or traversal index.
          if (matches.length > 1) {
            const corners = [start, end].flatMap((point) => capOffsets.map((offset) => [
              point[0] + sweepDirection[0] * offset,
              point[1] + sweepDirection[1] * offset,
              point[2] + sweepDirection[2] * offset,
            ]));
            const envelopeMatches = matches.filter((face) => constructionEnvelopeMatches(face, corners));
            if (envelopeMatches.length) matches = envelopeMatches;
          }
        } else if (entity.kind === 'circle' || entity.kind === 'arc') {
          const center = toWorld(entity.center2);
          if (!(entity.radius > 0)) continue;
          matches = faces.filter((face) => {
            // replicad reports cylindrical surfaces as 'CYLINDRE'.
            if (face.geomType !== 'CYLINDRE' || claimed.has(face)) return false;
            const cylinder = cylinderGeometry(face);
            if (!cylinder) return false;
            return Math.abs(cylinder.radius - entity.radius) < POSITION_TOLERANCE
              && Math.abs(dot(cylinder.axisDirection, sweepDirection)) > DIRECTION_TOLERANCE
              && pointToLineDistance(center, cylinder.axisPoint, cylinder.axisDirection) < POSITION_TOLERANCE;
          });
        } else {
          continue;
        }
        if (matches.length) sideMatches.set(entity.id, matches);
      }
      // A face claimed by two entities is genuinely ambiguous (coincident
      // geometry) — drop it everywhere. An entity owning several faces of its
      // own surface (a cylinder split at the seam) is normal only when the
      // geometric ordering key is unique.
      const faceUses = new Map();
      for (const matches of sideMatches.values()) {
        for (const face of matches) faceUses.set(face, (faceUses.get(face) || 0) + 1);
      }
      for (const [entityId, matches] of sideMatches) {
        const unambiguous = matches.filter((face) => faceUses.get(face) === 1);
        if (!unambiguous.length) continue;
        const baseName = 'F' + featureId + ':side:' + entityId;
        if (unambiguous.length !== 1) {
          names.diagnostics.push({
            severity: 'error',
            code: TOPOLOGY_NAMING_ERROR_CODES.ambiguousSuffix,
            reason: 'multiple-exact-candidates-without-provenance',
            topologyKind: 'face',
            persistentBaseName: baseName,
            candidateCount: unambiguous.length,
          });
          continue;
        }
        names.push({ name: baseName, face: unambiguous[0].clone() });
        claimed.add(unambiguous[0]);
      }
      return names;
    } catch (error) {
      disposeTable(names);
      throw error;
    } finally {
      disposeWrappers(faces);
    }
  }

  // ---- edge naming and reference resolution ---------------------------------

  // Derive the edge name table from exact face incidence. An ordinary edge
  // bounded by two named faces is E(a|b). A periodic face seam is incident to
  // one named face on both sides and is E(a|a). Several exact edges sharing one
  // incidence key remain ambiguous without additional construction provenance,
  // so the whole group is omitted.
  function deriveEdgeTable(shape, faceTable) {
    const table = [];
    table.diagnostics = [];
    if (!faceTable?.length) return table;
    const faces = exactFaces(shape);
    const edgeRegistry = []; // owned { edge, faceNames:Set }
    let returned = false;
    try {
      for (const face of faces) {
        const faceName = exactEntryName(face, faceTable, 'face', 'face');
        const faceEdges = exactEdges(face);
        try {
          for (const edge of faceEdges) {
            let entry = edgeRegistry.find((candidate) => candidate.edge.wrapped.IsSame(edge.wrapped));
            if (!entry) {
              entry = { edge: edge.clone(), faceNames: new Set() };
              edgeRegistry.push(entry);
            }
            if (faceName) entry.faceNames.add(faceName);
          }
        } finally {
          disposeWrappers(faceEdges);
        }
      }
      const grouped = new Map(); // canonical adjacent-face incidence -> entries
      for (const entry of edgeRegistry) {
        if (entry.faceNames.size < 1 || entry.faceNames.size > 2) continue;
        const pair = [...entry.faceNames].sort();
        if (pair.length === 1) pair.push(pair[0]);
        const key = 'E(' + pair[0] + '|' + pair[1] + ')';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(entry);
      }
      for (const [key, entries] of grouped) {
        if (entries.length === 1) {
          table.push({ name: key, edge: entries[0].edge });
          entries[0].retained = true;
          continue;
        }
        table.diagnostics.push({
          severity: 'error',
          code: TOPOLOGY_NAMING_ERROR_CODES.ambiguousSuffix,
          reason: 'multiple-exact-candidates-without-provenance',
          topologyKind: 'edge',
          persistentBaseName: key,
          candidateCount: entries.length,
        });
      }
      table.diagnostics.sort((left, right) =>
        String(left.persistentBaseName).localeCompare(String(right.persistentBaseName)));
      returned = true;
      return table;
    } finally {
      disposeWrappers(faces);
      for (const entry of edgeRegistry) if (!returned || !entry.retained) safeDelete(entry.edge);
    }
  }

  function derivedVertexTable(edgeTable) {
    const records = [];
    try {
      for (const entry of edgeTable || []) {
        records.push({ entry, endpoints: exactVertices(entry.edge) });
      }
      const naming = derivePersistentVertexNames({
        edges: records,
        getEdgeName: (record) => record.entry.name,
        getEdgeEndpoints: (record) => record.endpoints.length === 1
          ? [record.endpoints[0], record.endpoints[0]]
          : record.endpoints.length === 2
            ? record.endpoints
            : [],
        isSameEdge: (left, right) => left.entry.edge.wrapped.IsSame(right.entry.edge.wrapped),
        isSameVertex: (left, right) => left.wrapped.IsSame(right.wrapped),
      });
      const table = naming.vertexTable.map((entry) => ({
        name: entry.name,
        vertex: entry.vertex.clone(),
      }));
      table.diagnostics = [...naming.diagnostics];
      table.counts = { ...naming.counts };
      return table;
    } finally {
      for (const record of records) disposeWrappers(record.endpoints);
    }
  }

  function mergeExplicitOverlay(shape, sourceTable, derivedTable, kind) {
    const wrapperKey = kind === 'edge' ? 'edge' : 'vertex';
    const explicit = validatedExplicitTable(shape, sourceTable, kind);
    const exactCandidates = kind === 'edge' ? exactEdges(shape) : exactVertices(shape);
    try {
      const names = new Set(explicit.map((entry) => entry.name));
      const keptDerived = [];
      const shadowedDerived = [];
      for (const entry of derivedTable) {
        const claimed = explicit.filter((candidate) =>
          candidate[wrapperKey].wrapped.IsSame(entry[wrapperKey].wrapped));
        if (claimed.length > 1) {
          throw new TopologyNamingError(
            TOPOLOGY_NAMING_ERROR_CODES.ambiguousIdentity,
            'Several explicit persistent ' + kind + ' entries claim one derived exact subshape.',
            { reason: 'explicit-overlay-claim-ambiguous', topologyKind: kind, candidateCount: claimed.length },
          );
        }
        if (claimed.length === 1) {
          shadowedDerived.push(entry);
          continue;
        }
        if (names.has(entry.name)) {
          throw new TopologyNamingError(
            TOPOLOGY_NAMING_ERROR_CODES.ambiguousIdentity,
            'An explicit persistent ' + kind + ' name collides with derived result provenance.',
            { reason: 'explicit-derived-name-collision', topologyKind: kind, persistentName: entry.name },
          );
        }
        names.add(entry.name);
        keptDerived.push(entry);
      }
      const merged = [...explicit, ...keptDerived];
      const explicitIsComplete = explicit.length === exactCandidates.length
        && exactCandidates.every((candidate) => explicit.filter((entry) =>
          entry[wrapperKey].wrapped.IsSame(candidate.wrapped)).length === 1);
      merged.diagnostics = [
        ...(sourceTable?.diagnostics || []),
        // A complete, validated construction-owned table resolves every exact
        // subshape directly. Face-incidence ambiguity is then diagnostic noise,
        // not missing provenance. Partial overlays still retain all derived
        // diagnostics and therefore fail closed where incidence is ambiguous.
        ...(explicitIsComplete ? [] : derivedTable?.diagnostics || []),
      ];
      if (derivedTable?.counts) merged.counts = { ...derivedTable.counts, namedVertexCount: merged.length };
      for (const entry of shadowedDerived) safeDelete(entry[wrapperKey]);
      return merged;
    } catch (error) {
      for (const entry of explicit) safeDelete(entry[wrapperKey]);
      for (const entry of derivedTable) safeDelete(entry[wrapperKey]);
      throw error;
    } finally {
      disposeWrappers(exactCandidates);
    }
  }

  function edgeTableWithExplicitOverlay(shape, faceTable) {
    const derived = deriveEdgeTable(shape, faceTable);
    if (!faceTable || !Object.prototype.hasOwnProperty.call(faceTable, 'explicitEdgeTable')) return derived;
    return mergeExplicitOverlay(shape, faceTable.explicitEdgeTable, derived, 'edge');
  }

  function vertexTableWithExplicitOverlay(shape, faceTable, edgeTable) {
    if (!faceTable || !Object.prototype.hasOwnProperty.call(faceTable, 'explicitVertexTable')) return [];
    const derived = derivedVertexTable(edgeTable);
    return mergeExplicitOverlay(shape, faceTable.explicitVertexTable, derived, 'vertex');
  }

  function nameLookups(shape, faceTable) {
    const edgeTable = edgeTableWithExplicitOverlay(shape, faceTable);
    let edgeCandidates = [];
    let faceCandidates = [];
    try {
      edgeCandidates = exactEdges(shape);
      faceCandidates = exactFaces(shape);
      return {
        edgeTable,
        edgeCandidates,
        faceCandidates,
        diagnostics: edgeTable.diagnostics || [],
        getEdgeName: (candidate) => exactEntryName(candidate, edgeTable, 'edge', 'edge'),
        getFaceName: (candidate) => exactEntryName(candidate, faceTable, 'face', 'face'),
        dispose() {
          disposeWrappers(edgeTable.map((entry) => entry.edge));
          disposeWrappers(edgeCandidates);
          disposeWrappers(faceCandidates);
        },
      };
    } catch (error) {
      disposeWrappers(edgeTable.map((entry) => entry.edge));
      disposeWrappers(edgeCandidates);
      disposeWrappers(faceCandidates);
      throw error;
    }
  }

  // ---- fillet / chamfer with history ----------------------------------------

  // `picks` entries: { edge (replicad Edge), radii (number | [start, end]), edgeName? }.
  function filletChamferWithNames(kind, shape, picks, faceTable, featureId) {
    let builder = null;
    let resultShape = null;
    try {
      builder = kind === 'fillet'
        ? new oc.BRepFilletAPI_MakeFillet(shape.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational)
        : new oc.BRepFilletAPI_MakeChamfer(shape.wrapped);
      for (const pick of picks) {
        if (Array.isArray(pick.radii)) builder.Add_3(pick.radii[0], pick.radii[1], pick.edge.wrapped);
        else builder.Add_2(pick.radii, pick.edge.wrapped);
      }
      resultShape = rc.cast(builder.Shape());
      if (!resultShape) throw new Error('Could not ' + kind + ' as a 3d shape');
      const history = historyOf(builder, true);
      const names = propagateTables(history, [faceTable], resultShape);
      try {
        attachExplicitTopology(names, history, [faceTable], resultShape);
        const claimedBlends = [];
        for (const pick of picks) {
          if (!pick.edgeName) continue;
          const drained = history.generated(pick.edge.wrapped);
          let wrappedList = [];
          let adopted = false;
          try {
            const generated = drained
              .filter((output) => !claimedBlends.some((candidate) => candidate.IsSame(output))
                && !names.some((entry) => entry.face.wrapped.IsSame(output)));
            wrappedList = generated.map((output) => rc.cast(output));
            const baseName = 'F' + featureId + ':blend:' + pick.edgeName;
            if (wrappedList.length > 1) {
              if (!names.diagnostics) names.diagnostics = [];
              names.diagnostics.push({
                severity: 'error',
                code: TOPOLOGY_NAMING_ERROR_CODES.ambiguousSuffix,
                reason: 'multiple-exact-candidates-without-provenance',
                topologyKind: 'face',
                persistentBaseName: baseName,
                candidateCount: wrappedList.length,
              });
            } else if (wrappedList.length === 1) {
              names.push({ name: baseName, face: wrappedList[0] });
              claimedBlends.push(wrappedList[0].wrapped);
              adopted = true;
            }
          } finally {
            for (const output of drained) safeDelete(output);
            if (!adopted) disposeWrappers(wrappedList);
          }
        }
      } catch (error) {
        disposeTable(names);
        throw error;
      }
      return { shape: resultShape, names };
    } catch (error) {
      safeDelete(resultShape);
      throw error;
    } finally {
      safeDelete(builder);
    }
  }

  // ---- serialization ---------------------------------------------------------

  // Serialization retains exact lookup tables. Hash codes are used only later
  // to correlate Replicad's display mesh groups, never to assign names.
  function serializationNames(shape, faceTable) {
    const edgeTable = edgeTableWithExplicitOverlay(shape, faceTable);
    let vertexTable = [];
    try {
      vertexTable = vertexTableWithExplicitOverlay(shape, faceTable, edgeTable);
    } catch (error) {
      disposeWrappers(edgeTable.map((entry) => entry.edge));
      throw error;
    }
    return {
      edgeTable,
      vertexTable,
      diagnostics: [
        ...(faceTable?.diagnostics || []),
        ...(edgeTable.diagnostics || []),
        ...(vertexTable.diagnostics || []),
      ],
      getFaceName: (candidate) => exactEntryName(candidate, faceTable, 'face', 'face'),
      getEdgeName: (candidate) => exactEntryName(candidate, edgeTable, 'edge', 'edge'),
      getVertexName: (candidate) => exactEntryName(candidate, vertexTable, 'vertex', 'vertex'),
      dispose() {
        disposeWrappers(edgeTable.map((entry) => entry.edge));
        disposeWrappers(vertexTable.map((entry) => entry.vertex));
      },
    };
  }

  return {
    disposeTable,
    propagateTables,
    propagateExplicitTopology,
    prefixTable,
    transformWithNames,
    draftWithNames,
    shellWithNames,
    booleanWithNames,
    creationNamesForSweep,
    exactFaces,
    exactEdges,
    exactVertices,
    disposeWrappers,
    deriveEdgeTable,
    nameLookups,
    filletChamferWithNames,
    serializationNames,
  };
}
