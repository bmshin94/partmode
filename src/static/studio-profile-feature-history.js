// Persistent creation naming for profile-driven schema-5 features.
//
// This module deliberately owns the raw OCCT builders. Replicad's convenient
// revolve/loft/sweep wrappers dispose those builders before callers can query
// Generated/FirstShape/LastShape, which is exactly the history needed for
// persistent topology provenance.
//
// The public builders return { shape, names, diagnostics }. `shape` and every
// face in `names` are replicad wrappers owned by the caller. Use
// disposeOutcome() or disposeNameTable() when the outcome leaves a cache.
//
// Identity is always TopoDS_Shape::IsSame. No HashCode, traversal index, or
// geometric signature assigns a persistent name. If one semantic source maps
// to several exact faces and OCCT history cannot distinguish them, all of those
// faces stay unnamed behind an explicit ambiguity diagnostic.
//
// One exception is exact, not geometric: a sweep whose open spine has several
// edges generates one lateral face per profile edge per spine segment. Those
// faces are distinguished by intersecting Generated(profile edge) with
// Generated(spine edge), ordered by the authored spine chain anchored at the
// start cap, and named with a :seg:N suffix. Ties, closed or branching
// spines, and unanchorable chains remain fail-closed.

export const PROFILE_FEATURE_HISTORY_CODES = Object.freeze({
  ambiguousCap: 'PROFILE_HISTORY_AMBIGUOUS_CAP',
  ambiguousGeneratedFace: 'PROFILE_HISTORY_AMBIGUOUS_GENERATED_FACE',
  ambiguousSuffix: 'PROFILE_HISTORY_AMBIGUOUS_SUFFIX',
  duplicateName: 'PROFILE_HISTORY_DUPLICATE_NAME',
  historyQueryFailed: 'PROFILE_HISTORY_QUERY_FAILED',
  missingCap: 'PROFILE_HISTORY_MISSING_CAP',
  sourceUnmapped: 'PROFILE_HISTORY_SOURCE_UNMAPPED',
  unnamedFace: 'PROFILE_HISTORY_UNNAMED_FACE',
});

const TWO_PI = Math.PI * 2;

export function createStudioProfileFeatureHistory(rc) {
  const oc = rc.getOC();

  const safeDelete = (value) => {
    try { value?.delete?.(); } catch {}
  };

  const disposeWrappers = (values) => {
    for (const value of values || []) safeDelete(value);
  };

  function disposeNameTable(table) {
    for (const entry of table || []) safeDelete(entry.face);
  }

  function disposeOutcome(outcome) {
    if (!outcome) return;
    disposeNameTable(outcome.names);
    safeDelete(outcome.shape);
  }

  function exactSubshapes(shape, shapeKind) {
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

  const exactFaces = (shape) => exactSubshapes(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE);
  const exactEdges = (shape) => exactSubshapes(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
  const exactVertices = (shape) => exactSubshapes(shape, oc.TopAbs_ShapeEnum.TopAbs_VERTEX);

  // Takes ownership of an embind TopTools_ListOfShape result.
  function drainShapeList(list) {
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

  function diagnostic(code, message, details = {}, severity = 'error') {
    return { severity, code, message, ...details };
  }

  const encoded = (value) => encodeURIComponent(String(value));

  function sourceToken(source, fallbackScope) {
    const scope = source.sectionId ?? source.sketchId ?? source.profileId ?? fallbackScope;
    if (scope == null || source.entityId == null) {
      throw new Error('Profile history sources require a sketch/section scope and entityId');
    }
    return encoded(scope) + '/' + encoded(source.entityId);
  }

  function faceEvidence(face) {
    let center = null;
    try {
      center = face.center;
      const number = (value) => Number(value).toPrecision(15);
      return {
        geometry: String(face.geomType || 'UNKNOWN'),
        area: number(rc.measureArea(face)),
        center: [number(center.x ?? center[0]), number(center.y ?? center[1]), number(center.z ?? center[2])],
      };
    } catch (error) {
      return { geometry: String(face.geomType || 'UNKNOWN'), unavailable: String(error?.message || error) };
    } finally {
      safeDelete(center);
    }
  }

  const evidenceKey = (face) => {
    const evidence = faceEvidence(face);
    return JSON.stringify([evidence.geometry, evidence.center || [], evidence.area || '', evidence.unavailable || '']);
  };

  function diagnoseIndistinguishableFaces(operation, baseName, faces, diagnostics, diagnosedFaces) {
    for (const face of faces) diagnosedFaces.add(face);
    diagnostics.push(diagnostic(
      PROFILE_FEATURE_HISTORY_CODES.ambiguousSuffix,
      'One semantic profile provenance maps to several exact result faces, and OCCT history supplies no stable discriminator.',
      {
        operation,
        persistentBaseName: baseName,
        candidateCount: faces.length,
        evidence: faces.map(faceEvidence).sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right))),
      },
    ));
  }

  function findResultFacesFromRaw(rawShape, resultFaces) {
    if (!rawShape) return [];
    const direct = resultFaces.filter((face) => {
      try { return face.wrapped.IsSame(rawShape); } catch { return false; }
    });
    if (direct.length) return direct;

    let wrapped = null;
    let nested = [];
    try {
      wrapped = rc.cast(rawShape);
      nested = exactSubshapes(wrapped, oc.TopAbs_ShapeEnum.TopAbs_FACE);
      return resultFaces.filter((face) => nested.some((candidate) => face.wrapped.IsSame(candidate.wrapped)));
    } catch {
      return [];
    } finally {
      disposeWrappers(nested);
      safeDelete(wrapped);
    }
  }

  function boundaryFaceMatches(rawBoundary, resultFaces) {
    const direct = findResultFacesFromRaw(rawBoundary, resultFaces);
    if (direct.length) return direct;

    let boundaryWrapper = null;
    let boundaryEdges = [];
    try {
      boundaryWrapper = rc.cast(rawBoundary);
      boundaryEdges = exactEdges(boundaryWrapper);
      if (!boundaryEdges.length) return [];
      return resultFaces.filter((face) => {
        const candidateEdges = exactEdges(face);
        try {
          return boundaryEdges.every((boundaryEdge) =>
            candidateEdges.some((candidate) => candidate.wrapped.IsSame(boundaryEdge.wrapped)));
        } finally {
          disposeWrappers(candidateEdges);
        }
      });
    } catch {
      return [];
    } finally {
      disposeWrappers(boundaryEdges);
      safeDelete(boundaryWrapper);
    }
  }

  function addCapName(role, rawBoundary, name, state) {
    const { resultFaces, names, diagnostics, claimedFaces, diagnosedFaces } = state;
    const matches = rawBoundary ? boundaryFaceMatches(rawBoundary, resultFaces) : [];
    if (matches.length !== 1) {
      for (const face of matches) diagnosedFaces.add(face);
      diagnostics.push(diagnostic(
        matches.length
          ? PROFILE_FEATURE_HISTORY_CODES.ambiguousCap
          : PROFILE_FEATURE_HISTORY_CODES.missingCap,
        matches.length
          ? 'OCCT boundary history resolves to several result faces.'
          : 'OCCT boundary history did not resolve a result cap.',
        { role, persistentName: name, candidateCount: matches.length },
      ));
      return;
    }
    const face = matches[0];
    if (claimedFaces.has(face)) {
      diagnosedFaces.add(face);
      diagnostics.push(diagnostic(
        PROFILE_FEATURE_HISTORY_CODES.ambiguousCap,
        'One exact result face is claimed by several cap roles.',
        { role, persistentName: name, evidence: faceEvidence(face) },
      ));
      return;
    }
    names.push({ name, face: face.clone() });
    claimedFaces.add(face);
  }

  function generatedFaces(builder, source, resultFaces, diagnostics, sourceName, options = {}) {
    let rawOutputs = [];
    try {
      rawOutputs = drainShapeList(builder.Generated(source.edge.wrapped));
    } catch (error) {
      diagnostics.push(diagnostic(
        PROFILE_FEATURE_HISTORY_CODES.historyQueryFailed,
        'OCCT Generated history query failed.',
        { source: sourceName, operation: options.operation, error: String(error?.message || error) },
      ));
    }
    const matches = [];
    try {
      for (const rawOutput of rawOutputs) {
        for (const face of findResultFacesFromRaw(rawOutput, resultFaces)) {
          if (!matches.includes(face)) matches.push(face);
        }
      }
    } finally {
      for (const rawOutput of rawOutputs) safeDelete(rawOutput);
    }

    if (!matches.length && options.generatedFaceFallback && typeof builder.GeneratedFace === 'function') {
      let rawFace = null;
      try {
        rawFace = builder.GeneratedFace(source.edge.wrapped);
        for (const face of findResultFacesFromRaw(rawFace, resultFaces)) {
          if (!matches.includes(face)) matches.push(face);
        }
      } catch (error) {
        diagnostics.push(diagnostic(
          PROFILE_FEATURE_HISTORY_CODES.historyQueryFailed,
          'OCCT GeneratedFace history query failed.',
          { source: sourceName, operation: options.operation, error: String(error?.message || error) },
        ));
      } finally {
        safeDelete(rawFace);
      }
    }

    // A closed BRepPrimAPI revolution does not report the annular face swept by
    // a radial profile edge from Generated(edge). It does, however, report the
    // two circular result edges from Generated(each exact endpoint vertex).
    // Intersecting the result faces incident to every such generated-edge group
    // gives the swept face by exact OCCT history alone. One group or several
    // candidate faces is insufficient and remains fail-closed.
    if (!matches.length && options.vertexBoundaryFallback) {
      const sourceVertices = exactVertices(source.edge);
      const faceEdges = resultFaces.map((face) => exactEdges(face));
      try {
        if (sourceVertices.length >= 2) {
          const generatedEdgeGroups = [];
          for (const vertex of sourceVertices) {
            let rawGenerated = [];
            try {
              rawGenerated = drainShapeList(builder.Generated(vertex.wrapped));
              const group = [];
              for (const edges of faceEdges) {
                for (const edge of edges) {
                  if (group.includes(edge)) continue;
                  if (rawGenerated.some((output) => {
                    try { return edge.wrapped.IsSame(output); } catch { return false; }
                  })) group.push(edge);
                }
              }
              generatedEdgeGroups.push(group);
            } catch (error) {
              diagnostics.push(diagnostic(
                PROFILE_FEATURE_HISTORY_CODES.historyQueryFailed,
                'OCCT Generated endpoint-vertex history query failed.',
                { source: sourceName, operation: options.operation, error: String(error?.message || error) },
              ));
              generatedEdgeGroups.push([]);
            } finally {
              for (const output of rawGenerated) safeDelete(output);
            }
          }
          const groupsAreDisjoint = generatedEdgeGroups.every((group, index) =>
            generatedEdgeGroups.slice(index + 1).every((other) =>
              !group.some((edge) => other.some((candidate) =>
                edge.wrapped.IsSame(candidate.wrapped)))));
          if (generatedEdgeGroups.every((group) => group.length > 0) && groupsAreDisjoint) {
            const boundaryMatches = resultFaces.filter((_face, faceIndex) =>
              generatedEdgeGroups.every((group) => group.some((generatedEdge) =>
                faceEdges[faceIndex].some((candidate) =>
                  candidate.wrapped.IsSame(generatedEdge.wrapped)))));
            for (const face of boundaryMatches) if (!matches.includes(face)) matches.push(face);
          }
        }
      } finally {
        disposeWrappers(sourceVertices);
        for (const edges of faceEdges) disposeWrappers(edges);
      }
    }
    return matches;
  }

  // Exact spine segmentation for sweeps. Each entry of the returned map takes
  // a result face to the ordinal of the authored spine edge that generated it,
  // anchored so segment 0 touches the start cap. Pure IsSame identity; any
  // structural ambiguity returns null and callers stay fail-closed.
  function spineSegmentIndexMap(builder, spine, startCapRaw, resultFaces) {
    const spineEdges = exactEdges(spine);
    if (spineEdges.length < 2) { disposeWrappers(spineEdges); return null; }
    const edgeVertices = spineEdges.map((edge) => exactVertices(edge));
    try {
      const vertexShared = (left, right) => edgeVertices[left].some((a) =>
        edgeVertices[right].some((b) => { try { return a.wrapped.IsSame(b.wrapped); } catch { return false; } }));
      const neighbors = spineEdges.map((_edge, index) =>
        spineEdges.map((_other, otherIndex) => otherIndex)
          .filter((otherIndex) => otherIndex !== index && vertexShared(index, otherIndex)));
      const ends = neighbors.map((list, index) => ({ index, count: list.length }))
        .filter((entry) => entry.count === 1);
      if (ends.length !== 2 || neighbors.some((list) => list.length > 2)) return null;
      const ordered = [ends[0].index];
      while (ordered.length < spineEdges.length) {
        const current = ordered.at(-1);
        const previous = ordered.length > 1 ? ordered.at(-2) : null;
        const next = neighbors[current].find((candidate) => candidate !== previous);
        if (next == null || ordered.includes(next)) return null;
        ordered.push(next);
      }
      const rings = [];
      for (const edgeIndex of ordered) {
        let raws = [];
        try { raws = drainShapeList(builder.Generated(spineEdges[edgeIndex].wrapped)); } catch { return null; }
        try {
          const ring = [];
          for (const raw of raws) {
            for (const face of findResultFacesFromRaw(raw, resultFaces)) {
              if (!ring.includes(face)) ring.push(face);
            }
          }
          if (!ring.length) return null;
          rings.push(ring);
        } finally {
          for (const raw of raws) safeDelete(raw);
        }
      }
      const capFaces = findResultFacesFromRaw(startCapRaw, resultFaces);
      if (!capFaces.length) return null;
      const capEdges = capFaces.flatMap((face) => exactEdges(face));
      try {
        const ringTouchesCap = (ring) => ring.some((face) => {
          const faceEdges = exactEdges(face);
          try {
            return faceEdges.some((edge) => capEdges.some((capEdge) => {
              try { return edge.wrapped.IsSame(capEdge.wrapped); } catch { return false; }
            }));
          } finally {
            disposeWrappers(faceEdges);
          }
        });
        const firstTouches = ringTouchesCap(rings[0]);
        const lastTouches = ringTouchesCap(rings.at(-1));
        if (firstTouches === lastTouches) return null;
        if (lastTouches) rings.reverse();
      } finally {
        disposeWrappers(capEdges);
      }
      const segmentByFace = new Map();
      const conflicted = new Set();
      rings.forEach((ring, segment) => {
        for (const face of ring) {
          if (segmentByFace.has(face) && segmentByFace.get(face) !== segment) conflicted.add(face);
          else segmentByFace.set(face, segment);
        }
      });
      for (const face of conflicted) segmentByFace.delete(face);
      return segmentByFace;
    } finally {
      for (const vertices of edgeVertices) disposeWrappers(vertices);
      disposeWrappers(spineEdges);
    }
  }

  function assignSimpleLateralNames(operation, featureId, sources, builder, state, fallbackScope, historyOptions = {}) {
    const { resultFaces, names, diagnostics, claimedFaces, diagnosedFaces } = state;
    const bySource = new Map();
    const faceSources = new Map();
    for (const source of sources || []) {
      const token = sourceToken(source, fallbackScope);
      const sourceName = 'F' + encoded(featureId) + ':' + operation + ':side:' + token;
      const matches = generatedFaces(builder, source, resultFaces, diagnostics, token, { operation, ...historyOptions });
      if (!matches.length) {
        diagnostics.push(diagnostic(
          PROFILE_FEATURE_HISTORY_CODES.sourceUnmapped,
          'OCCT history did not report a generated result face for this profile entity.',
          { operation, source: token },
          'warning',
        ));
        continue;
      }
      if (!bySource.has(sourceName)) bySource.set(sourceName, []);
      const outputs = bySource.get(sourceName);
      for (const face of matches) {
        if (!outputs.includes(face)) outputs.push(face);
        if (!faceSources.has(face)) faceSources.set(face, new Set());
        faceSources.get(face).add(sourceName);
      }
    }

    for (const [face, contributors] of faceSources) {
      if (contributors.size > 1 || claimedFaces.has(face)) {
        diagnosedFaces.add(face);
        diagnostics.push(diagnostic(
          PROFILE_FEATURE_HISTORY_CODES.ambiguousGeneratedFace,
          'One exact generated face has several incompatible profile provenance claims.',
          { operation, persistentNames: [...contributors].sort(), evidence: faceEvidence(face) },
        ));
      }
    }

    for (const [baseName, candidates] of bySource) {
      const usable = candidates.filter((face) =>
        !diagnosedFaces.has(face)
        && !claimedFaces.has(face)
        && faceSources.get(face)?.size === 1);
      if (!usable.length) continue;
      if (usable.length > 1) {
        const segmentOfFace = historyOptions.segmentOfFace || null;
        const segmented = segmentOfFace ? usable.map((face) => ({ face, segment: segmentOfFace(face) })) : null;
        const distinct = segmented
          && segmented.every((entry) => Number.isInteger(entry.segment))
          && new Set(segmented.map((entry) => entry.segment)).size === segmented.length;
        if (distinct) {
          for (const entry of segmented) {
            const segmentName = baseName + ':seg:' + entry.segment;
            names.push({ name: segmentName, face: entry.face.clone() });
            claimedFaces.add(entry.face);
          }
          continue;
        }
        diagnoseIndistinguishableFaces(operation, baseName, usable, diagnostics, diagnosedFaces);
        continue;
      }
      const face = usable[0];
      names.push({ name: baseName, face: face.clone() });
      claimedFaces.add(face);
    }
  }

  function assignLoftLateralNames(featureId, sections, builder, state) {
    const { resultFaces, names, diagnostics, claimedFaces, diagnosedFaces } = state;
    const faceSources = new Map();
    const sectionOrder = new Map(sections.map((section, index) => [String(section.id), index]));
    for (const section of sections) {
      for (const source of section.edges || []) {
        const normalized = { ...source, sectionId: section.id };
        const token = sourceToken(normalized, section.id);
        const matches = generatedFaces(builder, normalized, resultFaces, diagnostics, token, {
          operation: 'loft',
          generatedFaceFallback: true,
        });
        if (!matches.length) {
          diagnostics.push(diagnostic(
            PROFILE_FEATURE_HISTORY_CODES.sourceUnmapped,
            'OCCT loft history did not map this section entity to a result face.',
            { operation: 'loft', source: token },
            'warning',
          ));
          continue;
        }
        for (const face of matches) {
          if (!faceSources.has(face)) faceSources.set(face, new Set());
          faceSources.get(face).add(token);
        }
      }
    }

    const byName = new Map();
    for (const [face, contributors] of faceSources) {
      if (claimedFaces.has(face)) {
        diagnosedFaces.add(face);
        diagnostics.push(diagnostic(
          PROFILE_FEATURE_HISTORY_CODES.ambiguousGeneratedFace,
          'A loft face is claimed by both cap and lateral history.',
          { operation: 'loft', sources: [...contributors].sort(), evidence: faceEvidence(face) },
        ));
        continue;
      }
      const orderedTokens = [...contributors].sort((left, right) => {
        const leftSection = decodeURIComponent(left.split('/')[0]);
        const rightSection = decodeURIComponent(right.split('/')[0]);
        const sectionDelta = (sectionOrder.get(leftSection) ?? Number.MAX_SAFE_INTEGER)
          - (sectionOrder.get(rightSection) ?? Number.MAX_SAFE_INTEGER);
        return sectionDelta || left.localeCompare(right);
      });
      const baseName = 'F' + encoded(featureId) + ':loft:side:' + orderedTokens.join('>');
      if (!byName.has(baseName)) byName.set(baseName, []);
      byName.get(baseName).push(face);
    }
    for (const [baseName, candidates] of byName) {
      if (candidates.length > 1) {
        diagnoseIndistinguishableFaces('loft', baseName, candidates, diagnostics, diagnosedFaces);
        continue;
      }
      const face = candidates[0];
      names.push({ name: baseName, face: face.clone() });
      claimedFaces.add(face);
    }
  }

  function finishOutcome(shape, state) {
    const { resultFaces, names, diagnostics, claimedFaces, diagnosedFaces } = state;
    const counts = new Map();
    for (const entry of names) counts.set(entry.name, (counts.get(entry.name) || 0) + 1);
    for (const [name, count] of counts) {
      if (count === 1) continue;
      diagnostics.push(diagnostic(
        PROFILE_FEATURE_HISTORY_CODES.duplicateName,
        'Persistent profile feature history produced a duplicate name.',
        { persistentName: name, candidateCount: count },
      ));
    }

    const unnamed = resultFaces.filter((face) => !claimedFaces.has(face) && !diagnosedFaces.has(face));
    const byEvidence = new Map();
    for (const face of unnamed) {
      const key = evidenceKey(face);
      if (!byEvidence.has(key)) byEvidence.set(key, []);
      byEvidence.get(key).push(face);
    }
    for (const [key, faces] of [...byEvidence.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      diagnostics.push(diagnostic(
        PROFILE_FEATURE_HISTORY_CODES.unnamedFace,
        'OCCT produced a face with no authoritative profile-feature history.',
        { candidateCount: faces.length, evidence: JSON.parse(key) },
      ));
      for (const face of faces) diagnosedFaces.add(face);
    }
    diagnostics.sort((left, right) =>
      String(left.code).localeCompare(String(right.code))
      || JSON.stringify(left).localeCompare(JSON.stringify(right)));
    disposeWrappers(resultFaces);
    return { shape, names, diagnostics };
  }

  function initialState(shape) {
    return {
      resultFaces: exactFaces(shape),
      names: [],
      diagnostics: [],
      claimedFaces: new Set(),
      diagnosedFaces: new Set(),
    };
  }

  function rawShape(builder) {
    let raw = null;
    try {
      raw = builder.Shape();
      const shape = rc.cast(raw);
      if (!shape || shape.isNull) throw new Error('OCCT returned a null profile-feature shape');
      return shape;
    } finally {
      safeDelete(raw);
    }
  }

  function revolveWithHistory(options) {
    const {
      featureId,
      profileFace,
      profileEdges = [],
      profileId = 'profile',
      axisOrigin = [0, 0, 0],
      axisDirection = [0, 0, 1],
      angleDegrees = 360,
    } = options || {};
    if (!featureId || !profileFace) throw new Error('revolveWithHistory requires featureId and profileFace');
    if (!(angleDegrees > 0 && angleDegrees <= 360)) throw new Error('Revolve angle must be above zero and at most 360 degrees');
    let axis = null;
    let builder = null;
    let shape = null;
    let state = null;
    let first = null;
    let last = null;
    try {
      axis = rc.makeAx1(axisOrigin, axisDirection);
      builder = new oc.BRepPrimAPI_MakeRevol_1(profileFace.wrapped, axis, angleDegrees * Math.PI / 180, false);
      if (!builder.IsDone()) throw new Error('OCCT could not complete the revolve operation');
      shape = rawShape(builder);
      state = initialState(shape);
      const isFull = Math.abs(angleDegrees * Math.PI / 180 - TWO_PI) <= 1e-10;
      if (!isFull) {
        try { first = builder.FirstShape_1(); } catch { first = builder.FirstShape(); }
        try { last = builder.LastShape_1(); } catch { last = builder.LastShape(); }
        addCapName('start', first, 'F' + encoded(featureId) + ':revolve:cap:start:' + encoded(profileId), state);
        addCapName('end', last, 'F' + encoded(featureId) + ':revolve:cap:end:' + encoded(profileId), state);
      }
      assignSimpleLateralNames(
        'revolve', featureId, profileEdges, builder, state, profileId,
        { vertexBoundaryFallback: true },
      );
      const outcome = finishOutcome(shape, state);
      shape = null;
      state = null;
      return outcome;
    } catch (error) {
      if (state) {
        disposeNameTable(state.names);
        disposeWrappers(state.resultFaces);
      }
      safeDelete(shape);
      throw error;
    } finally {
      safeDelete(first);
      safeDelete(last);
      safeDelete(builder);
      safeDelete(axis);
    }
  }

  function loftWithHistory(options) {
    const {
      featureId,
      sections = [],
      ruled = false,
      tolerance = 1e-4,
      solid = true,
      checkCompatibility = false,
      smoothing = false,
      maxDegree = 4,
      continuity = oc.GeomAbs_Shape.GeomAbs_C0,
    } = options || {};
    if (!featureId || sections.length < 2) throw new Error('loftWithHistory requires featureId and at least two sections');
    let builder = null;
    let progress = null;
    let shape = null;
    let state = null;
    let first = null;
    let last = null;
    try {
      builder = new oc.BRepOffsetAPI_ThruSections(solid, ruled === true, tolerance);
      builder.CheckCompatibility(checkCompatibility === true);
      builder.SetSmoothing(smoothing === true);
      builder.SetMaxDegree(maxDegree);
      builder.SetContinuity(continuity);
      for (const section of sections) builder.AddWire(section.wire.wrapped);
      progress = new oc.Message_ProgressRange_1();
      builder.Build(progress);
      if (!builder.IsDone()) throw new Error('OCCT could not complete the loft operation');
      shape = rawShape(builder);
      state = initialState(shape);
      if (solid) {
        first = builder.FirstShape();
        last = builder.LastShape();
        addCapName(
          'start',
          first,
          'F' + encoded(featureId) + ':loft:cap:start:' + encoded(sections[0].id),
          state,
        );
        addCapName(
          'end',
          last,
          'F' + encoded(featureId) + ':loft:cap:end:' + encoded(sections[sections.length - 1].id),
          state,
        );
      }
      assignLoftLateralNames(featureId, sections, builder, state);
      const outcome = finishOutcome(shape, state);
      shape = null;
      state = null;
      return outcome;
    } catch (error) {
      if (state) {
        disposeNameTable(state.names);
        disposeWrappers(state.resultFaces);
      }
      safeDelete(shape);
      throw error;
    } finally {
      safeDelete(first);
      safeDelete(last);
      safeDelete(progress);
      safeDelete(builder);
    }
  }

  function configurePipeShell(builder, spine, profileWire, options, resources) {
    const transition = {
      transformed: oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_Transformed,
      round: oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner,
      right: oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner,
    }[options.transition || 'right'];
    builder.SetTransitionMode(transition);
    if (options.auxiliarySpine) {
      builder.SetMode_5(options.auxiliarySpine.wrapped, false, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
    } else if (options.fixedDirection) {
      resources.direction = rc.makeDirection(options.fixedDirection);
      builder.SetMode_3(resources.direction);
    } else {
      builder.SetMode_1(options.frenet === true);
    }
    if (options.scaleEnd != null && Math.abs(options.scaleEnd - 1) > 1e-9) {
      resources.law = new oc.Law_Linear();
      resources.law.Set(0, 1, spine.length, options.scaleEnd);
      resources.trimmedLaw = resources.law.Trim(0, spine.length, 1e-6);
      builder.SetLaw_1(profileWire.wrapped, resources.trimmedLaw, false, true);
    } else {
      const withCorrection = options.transition === 'round' || options.forceProfileSpineOrthogonality === true;
      builder.Add_1(profileWire.wrapped, false, withCorrection);
    }
  }

  function sweepWithHistory(options) {
    const {
      featureId,
      profileWire,
      profileEdges = [],
      profileId = 'profile',
      spine,
    } = options || {};
    if (!featureId || !profileWire || !spine) throw new Error('sweepWithHistory requires featureId, profileWire, and spine');
    let builder = null;
    let progress = null;
    let shape = null;
    let state = null;
    let first = null;
    let last = null;
    const resources = { direction: null, law: null, trimmedLaw: null };
    try {
      builder = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
      configurePipeShell(builder, spine, profileWire, options, resources);
      progress = new oc.Message_ProgressRange_1();
      builder.Build(progress);
      if (!builder.IsDone()) throw new Error('OCCT could not complete the sweep operation');
      builder.MakeSolid();
      if (!builder.IsDone()) throw new Error('OCCT could not close the sweep as a solid');
      shape = rawShape(builder);
      state = initialState(shape);
      first = builder.FirstShape();
      last = builder.LastShape();
      addCapName('start', first, 'F' + encoded(featureId) + ':sweep:cap:start:' + encoded(profileId), state);
      addCapName('end', last, 'F' + encoded(featureId) + ':sweep:cap:end:' + encoded(profileId), state);
      const spineSegments = spineSegmentIndexMap(builder, spine, first, state.resultFaces);
      assignSimpleLateralNames('sweep', featureId, profileEdges, builder, state, profileId,
        spineSegments ? { segmentOfFace: (face) => spineSegments.get(face) } : {});
      const outcome = finishOutcome(shape, state);
      shape = null;
      state = null;
      return outcome;
    } catch (error) {
      if (state) {
        disposeNameTable(state.names);
        disposeWrappers(state.resultFaces);
      }
      safeDelete(shape);
      throw error;
    } finally {
      safeDelete(first);
      safeDelete(last);
      safeDelete(progress);
      safeDelete(resources.trimmedLaw);
      safeDelete(resources.law);
      safeDelete(resources.direction);
      safeDelete(builder);
    }
  }

  function exactNameEvidence(outcome) {
    const faces = exactFaces(outcome.shape);
    try {
      return (outcome.names || []).map((entry) => {
        const matches = faces.filter((face) => face.wrapped.IsSame(entry.face.wrapped));
        return {
          name: entry.name,
          exactMatchCount: matches.length,
          evidence: matches.length === 1 ? faceEvidence(matches[0]) : null,
        };
      }).sort((left, right) => left.name.localeCompare(right.name));
    } finally {
      disposeWrappers(faces);
    }
  }

  return {
    revolveWithHistory,
    loftWithHistory,
    sweepWithHistory,
    disposeNameTable,
    disposeOutcome,
    disposeWrappers,
    exactFaces,
    exactEdges,
    exactVertices,
    exactNameEvidence,
  };
}
