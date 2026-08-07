export const STUDIO_KERNEL_ROBUSTNESS_SCHEMA = 'partmode.kernel-robustness/v1';
export const STUDIO_TANGENT_FILLET_POLICY = 'occt-exact-tangent-contour-v1';

export function hasStudioExactTangentFilletPolicy(feature) {
  const contract = feature?.extensions?.kernelRobustness;
  return Boolean(contract && typeof contract === 'object' && !Array.isArray(contract))
    && Object.keys(contract).sort().join(',') === 'schema,tangentFilletPolicy'
    && contract.schema === STUDIO_KERNEL_ROBUSTNESS_SCHEMA
    && contract?.tangentFilletPolicy === STUDIO_TANGENT_FILLET_POLICY;
}

export function setStudioExactTangentFilletPolicy(feature, enabled) {
  if (!feature || typeof feature !== 'object' || Array.isArray(feature)) {
    throw new TypeError('Exact tangent-chain policy requires a feature record.');
  }
  const extensions = feature.extensions && typeof feature.extensions === 'object' && !Array.isArray(feature.extensions)
    ? { ...feature.extensions }
    : {};
  if (enabled) {
    extensions.kernelRobustness = {
      schema: STUDIO_KERNEL_ROBUSTNESS_SCHEMA,
      tangentFilletPolicy: STUDIO_TANGENT_FILLET_POLICY,
    };
  } else {
    delete extensions.kernelRobustness;
  }
  if (Object.keys(extensions).length) feature.extensions = extensions;
  else delete feature.extensions;
  return feature;
}

function safeDelete(value) {
  try { value?.delete?.(); } catch {}
}

function fail(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause != null) error.cause = cause;
  throw error;
}

function exactEdgeMatch(candidates, rawEdge, label) {
  const matches = candidates.filter((candidate) => candidate?.wrapped?.IsSame(rawEdge));
  if (matches.length !== 1) {
    fail(
      'TANGENT_CHAIN_TOPOLOGY_AMBIGUOUS',
      label + ' resolved to ' + matches.length + ' exact source edges instead of one.',
    );
  }
  return matches[0];
}

function namedPick(pick, index) {
  if (!pick?.edge?.wrapped) {
    fail('TANGENT_CHAIN_REFERENCE_INVALID', 'Tangent-chain seed ' + index + ' is not an exact OCCT edge.');
  }
  const edgeName = String(pick.edgeName || '').trim();
  if (!edgeName) {
    fail('TANGENT_CHAIN_REFERENCE_UNNAMED', 'Tangent-chain seed ' + index + ' has no persistent edge name.');
  }
  if (Array.isArray(pick.radii)) {
    fail(
      'TANGENT_CHAIN_VARIABLE_RADIUS_UNSUPPORTED',
      'Tangent-chain propagation requires one constant radius; variable start/end radii remain explicit-edge only.',
    );
  }
  const radius = Number(pick.radii);
  if (!(Number.isFinite(radius) && radius > 0)) {
    fail('TANGENT_CHAIN_RADIUS_INVALID', 'Tangent-chain radius must be a finite number above zero.');
  }
  return { edge: pick.edge, edgeName, radius };
}

function contourKey(edgeNames) {
  return [...edgeNames].sort().join('\n');
}

export function createStudioKernelRobustness(rc) {
  if (!rc?.getOC) throw new Error('Kernel robustness requires the exact OCCT runtime.');
  const oc = rc.getOC();

  function planTangentFillet(shape, selectedPicks, edgeCandidates, edgeNameFor, context = {}) {
    if (!shape?.wrapped) fail('TANGENT_CHAIN_SOURCE_INVALID', 'Tangent-chain propagation requires an exact source solid.');
    if (!Array.isArray(selectedPicks) || !selectedPicks.length) {
      fail('TANGENT_CHAIN_REFERENCE_INVALID', 'Tangent-chain propagation requires at least one persistent seed edge.');
    }
    if (!Array.isArray(edgeCandidates) || !edgeCandidates.length) {
      fail('TANGENT_CHAIN_SOURCE_INVALID', 'Tangent-chain propagation could not enumerate exact source edges.');
    }
    if (typeof edgeNameFor !== 'function') {
      fail('TANGENT_CHAIN_SOURCE_INVALID', 'Tangent-chain propagation requires persistent source-edge identity.');
    }
    if (!/^[0-9a-f]{64}$/u.test(String(context.sourceBrepSha256 || ''))) {
      fail('TANGENT_CHAIN_SOURCE_INVALID', 'Tangent-chain evidence requires the exact source B-rep SHA-256 digest.');
    }
    if (!/^[0-9a-f]{64}$/u.test(String(context.documentHash || ''))) {
      fail('TANGENT_CHAIN_SOURCE_INVALID', 'Tangent-chain evidence requires the current canonical document hash.');
    }
    const featureId = String(context.featureId || '').trim();
    if (!featureId) fail('TANGENT_CHAIN_SOURCE_INVALID', 'Tangent-chain evidence requires its persistent feature identity.');

    const sourceNames = edgeCandidates.map((edge, index) => {
      const name = String(edgeNameFor(edge) || '').trim();
      if (!name) {
        fail('TANGENT_CHAIN_REFERENCE_UNNAMED', 'Exact source edge ' + index + ' has no persistent identity.');
      }
      return name;
    });
    if (new Set(sourceNames).size !== sourceNames.length) {
      fail('TANGENT_CHAIN_TOPOLOGY_AMBIGUOUS', 'Exact source edge names are not one-to-one.');
    }

    const seeds = selectedPicks.map(namedPick);
    if (new Set(seeds.map((seed) => seed.edgeName)).size !== seeds.length) {
      fail('TANGENT_CHAIN_REFERENCE_DUPLICATE', 'Tangent-chain propagation contains a duplicate persistent seed edge.');
    }
    const radius = seeds[0].radius;
    if (seeds.some((seed) => Math.abs(seed.radius - radius) > 1e-12)) {
      fail('TANGENT_CHAIN_RADIUS_INCONSISTENT', 'Every seed in one tangent-chain fillet must use the same constant radius.');
    }
    for (const seed of seeds) {
      const sourceIndex = edgeCandidates.findIndex((edge) => edge.wrapped.IsSame(seed.edge.wrapped));
      if (sourceIndex < 0 || sourceNames[sourceIndex] !== seed.edgeName) {
        fail(
          'TANGENT_CHAIN_REFERENCE_MISMATCH',
          'Persistent seed name "' + seed.edgeName + '" does not match its exact source edge.',
        );
      }
    }

    const contours = [];
    const contourByKey = new Map();
    for (const seed of seeds) {
      let probe = null;
      let probeResult = null;
      try {
        probe = new oc.BRepFilletAPI_MakeFillet(
          shape.wrapped,
          oc.ChFi3d_FilletShape.ChFi3d_Rational,
        );
        probe.Add_2(radius, seed.edge.wrapped);
        const contourIndex = Number(probe.Contour(seed.edge.wrapped));
        if (!Number.isSafeInteger(contourIndex) || contourIndex < 1) {
          fail(
            'TANGENT_CHAIN_UNRESOLVED',
            'Persistent edge "' + seed.edgeName + '" does not define an exact fillet contour.',
          );
        }
        const edgeCount = Number(probe.NbEdges(contourIndex));
        if (!Number.isSafeInteger(edgeCount) || edgeCount < 1 || edgeCount > edgeCandidates.length) {
          fail(
            'TANGENT_CHAIN_TOPOLOGY_AMBIGUOUS',
            'The exact fillet contour for "' + seed.edgeName + '" reported an invalid edge count.',
          );
        }
        const edges = [];
        const edgeNames = [];
        for (let edgeIndex = 1; edgeIndex <= edgeCount; edgeIndex++) {
          let rawEdge = null;
          try {
            rawEdge = probe.Edge(contourIndex, edgeIndex);
            const edge = exactEdgeMatch(
              edgeCandidates,
              rawEdge,
              'Tangent contour ' + contourIndex + ' edge ' + edgeIndex,
            );
            const edgeName = String(edgeNameFor(edge) || '').trim();
            if (!edgeName) {
              fail(
                'TANGENT_CHAIN_REFERENCE_UNNAMED',
                'The exact tangent contour contains an edge without persistent identity.',
              );
            }
            if (edgeNames.includes(edgeName)) {
              fail(
                'TANGENT_CHAIN_TOPOLOGY_AMBIGUOUS',
                'The exact tangent contour repeats persistent edge "' + edgeName + '".',
              );
            }
            edges.push(edge);
            edgeNames.push(edgeName);
          } finally {
            safeDelete(rawEdge);
          }
        }
        if (!edges.some((edge) => edge.wrapped.IsSame(seed.edge.wrapped))) {
          fail('TANGENT_CHAIN_TOPOLOGY_AMBIGUOUS', 'The planned tangent contour omitted its selected seed edge.');
        }
        probeResult = probe.Shape();
        if (
          probe.IsDone() !== true
          || Number(probe.NbFaultyContours()) !== 0
          || Number(probe.NbFaultyVertices()) !== 0
        ) {
          fail(
            'TANGENT_CHAIN_KERNEL_REJECTED',
            'OpenCascade reported a faulty or incomplete tangent contour for persistent edge "' + seed.edgeName + '".',
          );
        }
        const key = contourKey(edgeNames);
        const existing = contourByKey.get(key);
        if (existing) {
          existing.selectedSeedEdgeNames.push(seed.edgeName);
        } else {
          const contour = {
            key,
            seedEdgeName: seed.edgeName,
            selectedSeedEdgeNames: [seed.edgeName],
            edges,
            edgeNames,
            closedAndTangent: probe.ClosedAndTangent(contourIndex) === true,
          };
          contours.push(contour);
          contourByKey.set(key, contour);
        }
      } catch (error) {
        if (error?.code) throw error;
        fail(
          'TANGENT_CHAIN_UNRESOLVED',
          'OpenCascade could not resolve the tangent contour from persistent edge "' + seed.edgeName + '".',
          error,
        );
      } finally {
        safeDelete(probeResult);
        safeDelete(probe);
      }
    }

    const expanded = [];
    const expandedNames = new Set();
    for (const contour of contours) {
      for (let index = 0; index < contour.edges.length; index++) {
        const edgeName = contour.edgeNames[index];
        if (expandedNames.has(edgeName)) {
          fail(
            'TANGENT_CHAIN_TOPOLOGY_AMBIGUOUS',
            'Separate tangent contours overlap at persistent edge "' + edgeName + '".',
          );
        }
        expandedNames.add(edgeName);
        expanded.push({ edge: contour.edges[index], edgeName, radii: radius });
      }
    }

    const evidence = {
      schema: STUDIO_KERNEL_ROBUSTNESS_SCHEMA,
      policy: STUDIO_TANGENT_FILLET_POLICY,
      mode: 'tangent-chain-fillet',
      featureId,
      documentHash: context.documentHash,
      sourceBrepSha256: context.sourceBrepSha256,
      radiusMm: radius,
      sourceEdgeCount: edgeCandidates.length,
      selectedEdgeNames: seeds.map((seed) => seed.edgeName),
      expandedEdgeNames: expanded.map((pick) => pick.edgeName),
      contourCount: contours.length,
      contours: contours.map((contour) => ({
        seedEdgeName: contour.seedEdgeName,
        selectedSeedEdgeNames: [...contour.selectedSeedEdgeNames],
        edgeNames: [...contour.edgeNames],
        edgeCount: contour.edgeNames.length,
        closedAndTangent: contour.closedAndTangent,
      })),
    };
    return { picks: expanded, evidence };
  }

  return { planTangentFillet };
}
