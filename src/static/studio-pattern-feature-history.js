// Persistent topology provenance for solid pattern occurrences and fused
// pattern results.
//
// Topology identity in this module is deliberately narrow: exact
// TopoDS_Shape::IsSame comparisons and the Modified/Generated history owned by
// the OCCT operation that produced the result. Explorer order, HashCode,
// geometry, proximity, and display-mesh identifiers are never identity inputs.

export const PATTERN_FEATURE_HISTORY_ERROR_CODES = Object.freeze({
  invalidInput: 'PATTERN_FEATURE_HISTORY_INVALID_INPUT',
  missingProvenance: 'PATTERN_FEATURE_HISTORY_MISSING_PROVENANCE',
  ambiguousProvenance: 'PATTERN_FEATURE_HISTORY_AMBIGUOUS_PROVENANCE',
  incompleteCoverage: 'PATTERN_FEATURE_HISTORY_INCOMPLETE_COVERAGE',
  unmappedTopology: 'PATTERN_FEATURE_HISTORY_UNMAPPED_TOPOLOGY',
  operationFailed: 'PATTERN_FEATURE_HISTORY_OPERATION_FAILED',
});

export class PatternFeatureHistoryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PatternFeatureHistoryError';
    this.code = code;
    for (const [key, value] of Object.entries(details)) this[key] = value;
    this.diagnostics = [{ severity: 'error', code, ...details, message }];
  }
}

const encoded = (value) => {
  const text = String(value);
  return text.length + ':' + text;
};

const topologyTag = (kind) => kind === 'face' ? 'F' : kind === 'edge' ? 'E' : 'V';

export function patternInstanceSubshapeName(featureId, instanceId, topologyKind, sourceName) {
  return topologyTag(topologyKind)
    + 'P' + encoded(featureId)
    + ':instance:' + encoded(instanceId)
    + ':source:' + encoded(sourceName);
}

export function patternFuseSubshapeName(featureId, topologyKind, contributors) {
  const tokens = [...contributors]
    .map((entry) => ({ kind: String(entry.kind), name: String(entry.name) }))
    .sort((left, right) => {
      const a = left.kind + '\u0000' + left.name;
      const b = right.kind + '\u0000' + right.name;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return topologyTag(topologyKind)
    + 'P' + encoded(featureId)
    + ':fuse:'
    + tokens.map((entry) => encoded(entry.kind) + encoded(entry.name)).join('');
}

export function createStudioPatternFeatureHistory(rc) {
  const oc = rc.getOC();
  const safeDelete = (value) => { try { value?.delete?.(); } catch {} };
  const disposeWrappers = (values) => { for (const value of values || []) safeDelete(value); };

  function fail(code, message, details = {}) {
    throw new PatternFeatureHistoryError(code, message, details);
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

  const descriptor = Object.freeze({
    face: Object.freeze({ tableKey: 'faces', wrapperKey: 'face' }),
    edge: Object.freeze({ tableKey: 'edges', wrapperKey: 'edge' }),
    vertex: Object.freeze({ tableKey: 'vertices', wrapperKey: 'vertex' }),
  });

  function disposeTables(tables) {
    for (const kind of ['face', 'edge', 'vertex']) {
      const { tableKey, wrapperKey } = descriptor[kind];
      for (const entry of tables?.[tableKey] || []) safeDelete(entry?.[wrapperKey]);
    }
  }

  function cloneTables(tables) {
    const cloned = { faces: [], edges: [], vertices: [] };
    try {
      for (const kind of ['face', 'edge', 'vertex']) {
        const { tableKey, wrapperKey } = descriptor[kind];
        cloned[tableKey] = (tables?.[tableKey] || []).map((entry) => ({
          name: String(entry.name),
          [wrapperKey]: entry[wrapperKey].clone(),
        }));
      }
      return cloned;
    } catch (error) {
      disposeTables(cloned);
      throw error;
    }
  }

  function validateCompleteTable(shape, table, kind) {
    const { wrapperKey } = descriptor[kind];
    const candidates = exactSubshapes(shape, kind);
    try {
      if (!Array.isArray(table)) {
        fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Pattern provenance tables must be arrays.', {
          reason: 'invalid-table', topologyKind: kind,
        });
      }
      const duplicateNames = [...new Set(table.map((entry) => String(entry?.name)))]
        .filter((name) => table.filter((entry) => String(entry?.name) === name).length !== 1)
        .sort();
      if (duplicateNames.length) {
        fail(
          PATTERN_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance,
          'A source persistent topology name is not one-to-one.',
          { reason: 'duplicate-persistent-name', topologyKind: kind, persistentNames: duplicateNames },
        );
      }
      for (const entry of table) {
        if (!String(entry?.name || '').length || !entry?.[wrapperKey]?.wrapped) {
          fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'A source topology entry is malformed.', {
            reason: 'malformed-table-entry', topologyKind: kind,
          });
        }
        const matches = candidates.filter((candidate) => candidate.wrapped.IsSame(entry[wrapperKey].wrapped));
        if (matches.length !== 1) {
          fail(
            matches.length
              ? PATTERN_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance
              : PATTERN_FEATURE_HISTORY_ERROR_CODES.missingProvenance,
            'A supplied source topology entry does not resolve to exactly one exact source subshape.',
            {
              reason: 'stale-or-ambiguous-table-entry',
              topologyKind: kind,
              persistentName: String(entry.name),
              candidateCount: matches.length,
            },
          );
        }
      }
      const ownershipCounts = candidates.map((candidate) => table.filter((entry) =>
        candidate.wrapped.IsSame(entry[wrapperKey].wrapped)).length);
      const missingCount = ownershipCounts.filter((count) => count === 0).length;
      const ambiguousCount = ownershipCounts.filter((count) => count > 1).length;
      if (ambiguousCount) {
        fail(
          PATTERN_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance,
          'More than one source provenance entry owns the same exact subshape.',
          { reason: 'multiple-entries-for-exact-subshape', topologyKind: kind, ambiguousCount },
        );
      }
      if (missingCount || table.length !== candidates.length) {
        fail(
          PATTERN_FEATURE_HISTORY_ERROR_CODES.incompleteCoverage,
          'The pattern source does not have complete persistent topology coverage.',
          {
            reason: 'source-table-incomplete',
            topologyKind: kind,
            exactCount: candidates.length,
            namedCount: table.length,
            missingCount,
          },
        );
      }
    } finally {
      disposeWrappers(candidates);
    }
  }

  function validateCompleteTables(shape, tables) {
    if (!shape?.wrapped || !tables || typeof tables !== 'object') {
      fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Pattern history requires an exact source shape and topology tables.', {
        reason: 'missing-source-shape-or-tables',
      });
    }
    validateCompleteTable(shape, tables.faces, 'face');
    validateCompleteTable(shape, tables.edges, 'edge');
    validateCompleteTable(shape, tables.vertices, 'vertex');
  }

  function validateFiniteVector(value, label) {
    if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => !Number.isFinite(entry))) {
      fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Pattern ' + label + ' must be a finite three-dimensional vector.', {
        reason: 'invalid-transform-vector', transformField: label,
      });
    }
  }

  function createTransformation(spec) {
    if (spec?.wrapped) return { transformation: spec, owned: false };
    if (spec?.transformation?.wrapped) return { transformation: spec.transformation, owned: false };
    const transformation = new rc.Transformation();
    try {
      const kind = spec?.kind || 'identity';
      if (kind === 'identity') return { transformation, owned: true };
      if (kind === 'translate') {
        validateFiniteVector(spec.vector, 'translation');
        transformation.translate(spec.vector);
      } else if (kind === 'rotate') {
        validateFiniteVector(spec.point, 'rotation point');
        validateFiniteVector(spec.direction, 'rotation direction');
        if (!Number.isFinite(spec.angleDegrees) || Math.hypot(...spec.direction) <= 1e-12) {
          fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Pattern rotation requires a finite angle and non-zero axis.', {
            reason: 'invalid-rotation',
          });
        }
        transformation.rotate(spec.angleDegrees, spec.point, spec.direction);
      } else if (kind === 'mirror') {
        validateFiniteVector(spec.point, 'mirror point');
        validateFiniteVector(spec.normal, 'mirror normal');
        if (Math.hypot(...spec.normal) <= 1e-12) {
          fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Pattern mirror requires a non-zero plane normal.', {
            reason: 'invalid-mirror-normal',
          });
        }
        transformation.mirror(spec.normal, spec.point);
      } else if (kind === 'scale') {
        validateFiniteVector(spec.center, 'scale center');
        if (!Number.isFinite(spec.factor) || Math.abs(spec.factor) <= 1e-12) {
          fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Pattern scale requires a finite non-zero factor.', {
            reason: 'invalid-scale-factor',
          });
        }
        transformation.scale(spec.center, spec.factor);
      } else {
        fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Pattern transform kind is unsupported.', {
          reason: 'unsupported-transform-kind', transformKind: String(kind),
        });
      }
      return { transformation, owned: true };
    } catch (error) {
      safeDelete(transformation);
      throw error;
    }
  }

  function exactResultCandidate(rawOutput, resultCandidates, kind, context) {
    let wrapper = null;
    try {
      if (!rawOutput || rawOutput.IsNull?.()) {
        fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.unmappedTopology, 'OCCT transform history returned a null subshape.', {
          reason: 'null-transform-history-result', topologyKind: kind, ...context,
        });
      }
      wrapper = rc.cast(rawOutput);
      const matches = resultCandidates.filter((candidate) => candidate.wrapped.IsSame(wrapper.wrapped));
      if (matches.length !== 1) {
        fail(
          matches.length
            ? PATTERN_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance
            : PATTERN_FEATURE_HISTORY_ERROR_CODES.unmappedTopology,
          'OCCT transform history did not resolve to exactly one exact result subshape.',
          {
            reason: 'transform-result-cardinality',
            topologyKind: kind,
            candidateCount: matches.length,
            ...context,
          },
        );
      }
      return matches[0];
    } finally {
      safeDelete(wrapper);
    }
  }

  function mapTransformTable(builder, resultShape, table, kind) {
    const { tableKey, wrapperKey } = descriptor[kind];
    const resultCandidates = exactSubshapes(resultShape, kind);
    const output = [];
    try {
      for (const entry of table) {
        let rawMapped = null;
        try {
          rawMapped = builder.ModifiedShape(entry[wrapperKey].wrapped);
          const candidate = exactResultCandidate(rawMapped, resultCandidates, kind, {
            persistentName: String(entry.name),
          });
          output.push({ name: String(entry.name), [wrapperKey]: candidate.clone() });
        } finally {
          safeDelete(rawMapped);
        }
      }
      const exactOwnership = resultCandidates.map((candidate) => output.filter((entry) =>
        candidate.wrapped.IsSame(entry[wrapperKey].wrapped)).length);
      const missingCount = exactOwnership.filter((count) => count === 0).length;
      const ambiguousCount = exactOwnership.filter((count) => count > 1).length;
      if (ambiguousCount) {
        fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance, 'Transform history mapped multiple source names to one exact result subshape.', {
          reason: 'transform-many-to-one', topologyKind: kind, ambiguousCount,
        });
      }
      if (missingCount || output.length !== resultCandidates.length) {
        fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.unmappedTopology, 'Transform history did not cover every exact result subshape.', {
          reason: 'transform-result-incomplete',
          topologyKind: kind,
          exactCount: resultCandidates.length,
          namedCount: output.length,
          missingCount,
        });
      }
      return { tableKey, output };
    } catch (error) {
      disposeWrappers(output.map((entry) => entry[wrapperKey]));
      throw error;
    } finally {
      disposeWrappers(resultCandidates);
    }
  }

  function transformOnce(shape, tables, transformSpec) {
    let transformation = null;
    let ownsTransformation = false;
    let builder = null;
    let rawResult = null;
    let resultShape = null;
    let resultTables = null;
    try {
      const created = createTransformation(transformSpec);
      transformation = created.transformation;
      ownsTransformation = created.owned;
      builder = new oc.BRepBuilderAPI_Transform_2(shape.wrapped, transformation.wrapped, true);
      if (!builder.IsDone()) {
        fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.operationFailed, 'OCCT could not complete a pattern transform.', {
          reason: 'transform-builder-not-done',
        });
      }
      rawResult = builder.ModifiedShape(shape.wrapped);
      resultShape = rc.cast(rawResult);
      safeDelete(rawResult);
      rawResult = null;
      if (!resultShape) {
        fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.operationFailed, 'OCCT pattern transform did not produce a 3D shape.', {
          reason: 'transform-result-not-3d',
        });
      }
      resultTables = { faces: [], edges: [], vertices: [] };
      for (const kind of ['face', 'edge', 'vertex']) {
        const { tableKey } = descriptor[kind];
        const mapped = mapTransformTable(builder, resultShape, tables[tableKey], kind);
        resultTables[mapped.tableKey] = mapped.output;
      }
      validateCompleteTables(resultShape, resultTables);
      const outcome = { shape: resultShape, names: resultTables };
      resultShape = null;
      resultTables = null;
      return outcome;
    } catch (error) {
      safeDelete(resultShape);
      disposeTables(resultTables);
      if (error instanceof PatternFeatureHistoryError) throw error;
      fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.operationFailed, 'OCCT pattern transform history failed.', {
        reason: 'transform-history-exception', cause: String(error?.message || error),
      });
    } finally {
      safeDelete(rawResult);
      safeDelete(builder);
      if (ownsTransformation) safeDelete(transformation);
    }
  }

  function transformPatternInstance({ sourceShape, sourceTables, featureId, instanceId, transforms = [] }) {
    if (!String(featureId || '').length || !String(instanceId || '').length || !Array.isArray(transforms)) {
      fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Pattern occurrence requires stable feature and instance IDs plus a transform list.', {
        reason: 'invalid-instance-input',
      });
    }
    validateCompleteTables(sourceShape, sourceTables);
    let currentShape = sourceShape;
    let currentTables = sourceTables;
    let ownsCurrent = false;
    const steps = transforms.length ? transforms : [{ kind: 'identity' }];
    try {
      for (const step of steps) {
        const next = transformOnce(currentShape, currentTables, step);
        if (ownsCurrent) {
          safeDelete(currentShape);
          disposeTables(currentTables);
        }
        currentShape = next.shape;
        currentTables = next.names;
        ownsCurrent = true;
      }
      for (const kind of ['face', 'edge', 'vertex']) {
        const { tableKey } = descriptor[kind];
        for (const entry of currentTables[tableKey]) {
          entry.name = patternInstanceSubshapeName(featureId, instanceId, kind, entry.name);
        }
      }
      validateCompleteTables(currentShape, currentTables);
      const outcome = {
        instanceId: String(instanceId),
        shape: currentShape,
        names: currentTables,
        diagnostics: [],
      };
      ownsCurrent = false;
      return outcome;
    } finally {
      if (ownsCurrent) {
        safeDelete(currentShape);
        disposeTables(currentTables);
      }
    }
  }

  function validateInstances(featureId, instances) {
    if (!String(featureId || '').length || !Array.isArray(instances) || !instances.length) {
      fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Pattern history requires a feature ID and at least one occurrence.', {
        reason: 'missing-feature-or-instances',
      });
    }
    const ids = instances.map((instance) => String(instance?.instanceId || ''));
    if (ids.some((id) => !id.length)) {
      fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.invalidInput, 'Every pattern occurrence requires a stable non-empty ID.', {
        reason: 'missing-instance-id',
      });
    }
    const duplicates = [...new Set(ids)].filter((id) => ids.filter((candidate) => candidate === id).length > 1).sort();
    if (duplicates.length) {
      fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance, 'Pattern occurrence IDs are not unique.', {
        reason: 'duplicate-instance-id', instanceIds: duplicates,
      });
    }
    return [...instances].sort((left, right) => {
      const a = String(left.instanceId);
      const b = String(right.instanceId);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  function patternInstancesWithHistory({ sourceShape, sourceTables, featureId, instances }) {
    validateCompleteTables(sourceShape, sourceTables);
    const ordered = validateInstances(featureId, instances);
    const outcomes = [];
    try {
      for (const instance of ordered) outcomes.push(transformPatternInstance({
        sourceShape,
        sourceTables,
        featureId,
        instanceId: instance.instanceId,
        transforms: instance.transforms || [],
      }));
      return { instances: outcomes, diagnostics: [] };
    } catch (error) {
      for (const outcome of outcomes) {
        safeDelete(outcome.shape);
        disposeTables(outcome.names);
      }
      throw error;
    }
  }

  // Takes ownership of the embind list returned by Modified/Generated.
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

  function outputCandidateForRaw(raw, candidatesByKind) {
    const matches = [];
    for (const kind of ['face', 'edge', 'vertex']) {
      for (const candidate of candidatesByKind[kind]) {
        if (candidate.wrapped.IsSame(raw)) matches.push({ kind, candidate });
      }
    }
    if (matches.length > 1) {
      fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance, 'One OCCT history result resolves to multiple exact result subshapes.', {
        reason: 'history-result-ambiguous', candidateCount: matches.length,
      });
    }
    return matches[0] || null;
  }

  function booleanRecords(tables) {
    const records = [];
    for (const kind of ['face', 'edge', 'vertex']) {
      const { tableKey, wrapperKey } = descriptor[kind];
      for (const entry of tables[tableKey]) records.push({
        kind,
        name: String(entry.name),
        wrapper: entry[wrapperKey],
      });
    }
    return records;
  }

  function fuseTwoWithHistory(featureId, left, right) {
    let progress = null;
    let builder = null;
    let rawResult = null;
    let resultShape = null;
    let resultTables = null;
    let candidatesByKind = null;
    try {
      validateCompleteTables(left.shape, left.names);
      validateCompleteTables(right.shape, right.names);
      progress = new oc.Message_ProgressRange_1();
      builder = new oc.BRepAlgoAPI_Fuse_3(left.shape.wrapped, right.shape.wrapped, progress);
      builder.Build(progress);
      if (!builder.IsDone()) {
        fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.operationFailed, 'OCCT could not fuse pattern occurrences.', {
          reason: 'fuse-builder-not-done',
        });
      }
      builder.SimplifyResult(true, true, 1e-3);
      rawResult = builder.Shape();
      resultShape = rc.cast(rawResult);
      safeDelete(rawResult);
      rawResult = null;
      if (!resultShape) {
        fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.operationFailed, 'OCCT pattern fusion did not produce a 3D shape.', {
          reason: 'fuse-result-not-3d',
        });
      }

      candidatesByKind = {
        face: exactFaces(resultShape),
        edge: exactEdges(resultShape),
        vertex: exactVertices(resultShape),
      };
      const provenance = new Map();
      for (const kind of ['face', 'edge', 'vertex']) {
        for (const candidate of candidatesByKind[kind]) provenance.set(candidate, new Map());
      }
      const register = (raw, contributor) => {
        const match = outputCandidateForRaw(raw, candidatesByKind);
        if (!match) return;
        const token = contributor.kind + '\u0000' + contributor.name;
        provenance.get(match.candidate).set(token, contributor);
      };
      for (const record of [...booleanRecords(left.names), ...booleanRecords(right.names)]) {
        const modified = drainList(builder.Modified(record.wrapper.wrapped));
        const generated = drainList(builder.Generated(record.wrapper.wrapped));
        try {
          for (const output of modified) register(output, record);
          for (const output of generated) register(output, record);
        } finally {
          disposeWrappers(modified);
          disposeWrappers(generated);
        }
        // Boolean history may omit unchanged topology. Exact IsSame survival
        // is the only permissible fallback.
        for (const kind of ['face', 'edge', 'vertex']) {
          for (const candidate of candidatesByKind[kind]) {
            if (candidate.wrapped.IsSame(record.wrapper.wrapped)) register(candidate.wrapped, record);
          }
        }
      }

      resultTables = { faces: [], edges: [], vertices: [] };
      for (const kind of ['face', 'edge', 'vertex']) {
        const { tableKey, wrapperKey } = descriptor[kind];
        for (const candidate of candidatesByKind[kind]) {
          const contributors = [...provenance.get(candidate).values()];
          if (!contributors.length) {
            fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.unmappedTopology, 'Boolean history did not map an exact fused-result subshape.', {
              reason: 'fuse-result-unmapped', topologyKind: kind,
            });
          }
          const direct = contributors.length === 1 && contributors[0].kind === kind;
          const name = direct
            ? contributors[0].name
            : patternFuseSubshapeName(featureId, kind, contributors);
          resultTables[tableKey].push({ name, [wrapperKey]: candidate.clone() });
        }
        const duplicates = [...new Set(resultTables[tableKey].map((entry) => entry.name))]
          .filter((name) => resultTables[tableKey].filter((entry) => entry.name === name).length > 1)
          .sort();
        if (duplicates.length) {
          fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.ambiguousProvenance, 'Distinct fused-result subshapes have indistinguishable OCCT provenance.', {
            reason: 'duplicate-output-provenance', topologyKind: kind, persistentNames: duplicates,
          });
        }
      }
      validateCompleteTables(resultShape, resultTables);
      const analyzer = new oc.BRepCheck_Analyzer(resultShape.wrapped, true, false);
      try {
        if (!analyzer.IsValid_2()) {
          fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.operationFailed, 'OCCT pattern fusion produced an invalid exact B-rep.', {
            reason: 'invalid-fuse-result',
          });
        }
      } finally {
        safeDelete(analyzer);
      }
      const outcome = { shape: resultShape, names: resultTables, diagnostics: [] };
      resultShape = null;
      resultTables = null;
      return outcome;
    } catch (error) {
      safeDelete(resultShape);
      disposeTables(resultTables);
      if (error instanceof PatternFeatureHistoryError) throw error;
      fail(PATTERN_FEATURE_HISTORY_ERROR_CODES.operationFailed, 'OCCT pattern fusion history failed.', {
        reason: 'fuse-history-exception', cause: String(error?.message || error),
      });
    } finally {
      safeDelete(rawResult);
      if (candidatesByKind) {
        disposeWrappers(candidatesByKind.face);
        disposeWrappers(candidatesByKind.edge);
        disposeWrappers(candidatesByKind.vertex);
      }
      safeDelete(builder);
      safeDelete(progress);
    }
  }

  function fusePatternWithHistory({ sourceShape, sourceTables, featureId, instances }) {
    const built = patternInstancesWithHistory({ sourceShape, sourceTables, featureId, instances });
    const remaining = [...built.instances];
    let accumulator = null;
    try {
      accumulator = remaining.shift();
      while (remaining.length) {
        const operand = remaining.shift();
        const previous = accumulator;
        accumulator = null;
        let next = null;
        try {
          next = fuseTwoWithHistory(featureId, previous, operand);
        } finally {
          safeDelete(previous?.shape);
          disposeTables(previous?.names);
          safeDelete(operand?.shape);
          disposeTables(operand?.names);
        }
        accumulator = next;
      }
      const outcome = {
        shape: accumulator.shape,
        names: accumulator.names,
        diagnostics: [],
      };
      accumulator = null;
      return outcome;
    } finally {
      if (accumulator) {
        safeDelete(accumulator.shape);
        disposeTables(accumulator.names);
      }
      for (const outcome of remaining) {
        safeDelete(outcome.shape);
        disposeTables(outcome.names);
      }
    }
  }

  function disposeOutcome(outcome) {
    safeDelete(outcome?.shape);
    disposeTables(outcome?.names);
  }

  return {
    exactFaces,
    exactEdges,
    exactVertices,
    disposeWrappers,
    disposeTables,
    cloneTables,
    validateCompleteTables,
    transformPatternInstance,
    patternInstancesWithHistory,
    fusePatternWithHistory,
    disposeOutcome,
  };
}
