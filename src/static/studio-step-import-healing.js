const STEP_HEALING_SCHEMA = 'partmode.step-healing/v1';
const POLICY_NAME = 'occt-bounded-sewing-v1';
const MIN_TOLERANCE_MM = 0.001;
const MAX_TOLERANCE_MM = 0.05;
const SCALE_TOLERANCE_RATIO = 0.001;
const POLICY_SCALE_QUANTUM_MM = MAX_TOLERANCE_MM * 2;
const MAX_ATTEMPTS = 16;
const MAX_ACTIONS = 64;
const DEFAULT_MAX_CANDIDATES = 5000;
const MIN_SOLID_VOLUME_MM3 = 1e-8;
const HASH_CODE_MAX = 2147483647;
const ACTION = 'OCCT sew faces and ShapeFix solid';

function safeDelete(value) {
  try { value?.delete?.(); } catch {}
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function clone(value) {
  return structuredClone(value);
}

function exactTopologyCount(rc, shape, kind) {
  let count = 0;
  for (const raw of rc.iterTopo(shape.wrapped, kind)) {
    count += 1;
    safeDelete(raw);
  }
  return count;
}

function exactBounds(oc, shape) {
  let box = null;
  try {
    box = new oc.Bnd_Box_1();
    oc.BRepBndLib.AddOptimal(shape.wrapped, box, false, false);
    const xMin = { current: 0 }; const yMin = { current: 0 }; const zMin = { current: 0 };
    const xMax = { current: 0 }; const yMax = { current: 0 }; const zMax = { current: 0 };
    box.Get(xMin, yMin, zMin, xMax, yMax, zMax);
    const bounds = [
      [xMin.current, yMin.current, zMin.current],
      [xMax.current, yMax.current, zMax.current],
    ];
    if (bounds.flat().some((value) => !Number.isFinite(value))) {
      fail('STEP_HEALING_REFUSED', 'STEP healing could not measure finite exact source bounds.');
    }
    return bounds;
  } finally {
    safeDelete(box);
  }
}

function edgeUseEvidence(oc, rc, shape) {
  const buckets = new Map();
  const retained = [];
  const faceEnum = oc.TopAbs_ShapeEnum.TopAbs_FACE;
  const edgeEnum = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  const shapeEnum = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;
  let faceCount = 0;
  try {
    for (const rawFace of rc.iterTopo(shape.wrapped, 'face')) {
      let explorer = null;
      try {
        faceCount += 1;
        explorer = new oc.TopExp_Explorer_2(rawFace, edgeEnum, shapeEnum);
        while (explorer.More()) {
          const edge = explorer.Current();
          const hash = edge.HashCode(HASH_CODE_MAX);
          const bucket = buckets.get(hash) || [];
          const existing = bucket.find((entry) => entry.edge.IsSame(edge));
          if (existing) {
            existing.uses += 1;
            safeDelete(edge);
          } else {
            const entry = { edge, uses: 1 };
            bucket.push(entry);
            buckets.set(hash, bucket);
            retained.push(entry);
          }
          explorer.Next();
        }
      } finally {
        safeDelete(explorer);
        safeDelete(rawFace);
      }
    }
    let freeEdgeCount = 0;
    let multipleEdgeCount = 0;
    for (const entry of retained) {
      if (entry.uses === 1) freeEdgeCount += 1;
      else if (entry.uses > 2) multipleEdgeCount += 1;
    }
    return {
      faceCount,
      faceOwnedEdgeCount: retained.length,
      freeEdgeCount,
      multipleEdgeCount,
    };
  } finally {
    retained.forEach((entry) => safeDelete(entry.edge));
  }
}

function inspectExactShape(oc, rc, shape) {
  if (!shape?.wrapped) fail('STEP_HEALING_REFUSED', 'STEP healing requires an exact OCCT shape.');
  let analyzer = null;
  let brepValid = false;
  try {
    analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
    brepValid = analyzer.IsValid_2();
  } finally {
    safeDelete(analyzer);
  }
  const edgeUses = edgeUseEvidence(oc, rc, shape);
  let volumeMm3 = 0;
  try { volumeMm3 = Number(rc.measureVolume(shape)); }
  catch (error) {
    fail('STEP_HEALING_REFUSED', 'STEP healing could not measure exact volume: ' + String(error?.message || error));
  }
  if (!Number.isFinite(volumeMm3)) fail('STEP_HEALING_REFUSED', 'STEP healing measured a non-finite exact volume.');
  const metrics = {
    brepValid,
    solidCount: exactTopologyCount(rc, shape, 'solid'),
    shellCount: exactTopologyCount(rc, shape, 'shell'),
    faceCount: exactTopologyCount(rc, shape, 'face'),
    edgeCount: exactTopologyCount(rc, shape, 'edge'),
    vertexCount: exactTopologyCount(rc, shape, 'vertex'),
    freeEdgeCount: edgeUses.freeEdgeCount,
    multipleEdgeCount: edgeUses.multipleEdgeCount,
    volumeMm3,
    boundsMm: exactBounds(oc, shape),
  };
  return {
    metrics,
    faceOwnedEdgeCount: edgeUses.faceOwnedEdgeCount,
    traversedFaceCount: edgeUses.faceCount,
  };
}

function publicMetrics(inspection) {
  return clone(inspection.metrics);
}

function exactSubshapes(rc, shape, kind) {
  const result = [];
  for (const raw of rc.iterTopo(shape.wrapped, kind)) {
    try { result.push(rc.cast(raw)); }
    finally { safeDelete(raw); }
  }
  return result;
}

function disposeShapes(shapes) {
  if (!Array.isArray(shapes)) return;
  const seen = new Set();
  for (const shape of shapes) {
    if (!shape || seen.has(shape)) continue;
    seen.add(shape);
    safeDelete(shape);
  }
}

function isAcceptedSolid(metrics) {
  return metrics.brepValid === true
    && metrics.solidCount === 1
    && metrics.shellCount === 1
    && metrics.faceCount > 0
    && metrics.freeEdgeCount === 0
    && metrics.multipleEdgeCount === 0
    && metrics.volumeMm3 > MIN_SOLID_VOLUME_MM3;
}

function maxBoundsDelta(left, right) {
  return Math.max(...left.flatMap((corner, side) => corner.map(
    (value, axis) => Math.abs(value - right[side][axis]),
  )));
}

function driftEvidence(pre, post) {
  const absoluteVolumeDeltaMm3 = Math.abs(post.volumeMm3 - pre.volumeMm3);
  return {
    maxBoundsDeltaMm: maxBoundsDelta(pre.boundsMm, post.boundsMm),
    absoluteVolumeDeltaMm3,
    relativeVolumeDelta: absoluteVolumeDeltaMm3 / Math.max(
      Math.abs(pre.volumeMm3),
      Math.abs(post.volumeMm3),
      MIN_SOLID_VOLUME_MM3,
    ),
  };
}

function modelDiagonal(bounds) {
  // Quantize only the scale estimate, never the geometry. A sub-policy defect
  // must not enlarge its own healing allowance (for example, an 8.00 mm body
  // with a face displaced to 8.02 mm). The 0.1 mm quantum is twice the global
  // tolerance ceiling, so this cannot erase geometry accepted by the policy.
  const extents = bounds[0].map((value, axis) => {
    const extent = bounds[1][axis] - value;
    return Math.round(extent / POLICY_SCALE_QUANTUM_MM) * POLICY_SCALE_QUANTUM_MM;
  });
  return Math.hypot(...extents);
}

function policyFor(pre, requestedCandidates) {
  const diagonal = modelDiagonal(pre.boundsMm);
  const maxToleranceMm = Math.min(
    MAX_TOLERANCE_MM,
    Math.max(MIN_TOLERANCE_MM, diagonal * SCALE_TOLERANCE_RATIO),
  );
  const maxCandidates = Number.isSafeInteger(requestedCandidates)
    ? Math.min(DEFAULT_MAX_CANDIDATES, Math.max(1, requestedCandidates))
    : DEFAULT_MAX_CANDIDATES;
  return {
    name: POLICY_NAME,
    maxToleranceMm,
    maxAttempts: MAX_ATTEMPTS,
    maxCandidates,
    maxActions: MAX_ACTIONS,
  };
}

function toleranceLadder(maxToleranceMm) {
  const tolerances = [];
  let current = MIN_TOLERANCE_MM;
  while (current < maxToleranceMm && tolerances.length < MAX_ATTEMPTS - 1) {
    tolerances.push(current);
    current *= 2;
  }
  if (!tolerances.length || Math.abs(tolerances.at(-1) - maxToleranceMm) > 1e-15) {
    tolerances.push(maxToleranceMm);
  }
  return tolerances;
}

function evidenceBase(context, policy) {
  if (!/^[0-9a-f]{64}$/.test(context?.sourceSha256 || '')) {
    fail('STEP_HEALING_REFUSED', 'STEP healing requires the exact source STEP SHA-256 digest.');
  }
  if (!Number.isSafeInteger(context?.sourceByteLength) || context.sourceByteLength <= 0) {
    fail('STEP_HEALING_REFUSED', 'STEP healing requires the exact positive source STEP byte length.');
  }
  return {
    schema: STEP_HEALING_SCHEMA,
    sourceSha256: context.sourceSha256,
    sourceByteLength: context.sourceByteLength,
    // The production importer replaces this sentinel with the SHA-256 of the
    // canonical BREP bytes captured for each accepted body resource.
    healedBrepSha256: '0'.repeat(64),
    policy,
  };
}

function unchangedEvidence(context, policy, metrics) {
  return {
    ...evidenceBase(context, policy),
    status: 'unchanged',
    applied: false,
    selectedToleranceMm: 0,
    attempts: [],
    defects: [],
    actions: [],
    pre: clone(metrics),
    post: clone(metrics),
    drift: {
      maxBoundsDeltaMm: 0,
      absoluteVolumeDeltaMm3: 0,
      relativeVolumeDelta: 0,
    },
  };
}

function sourceDefects(pre) {
  const defects = [];
  if (!pre.brepValid) defects.push('invalid-brep');
  if (pre.solidCount === 0) defects.push('no-solid');
  if (pre.shellCount !== 1) defects.push('disconnected-shells');
  if (pre.freeEdgeCount > 0) defects.push('free-edges');
  if (pre.multipleEdgeCount > 0) defects.push('multiple-edges');
  return defects;
}

function preserveValidSolids(oc, rc, rootInspection, policy) {
  const solids = exactSubshapes(rc, rootInspection.shape, 'solid');
  if (!solids.length) return null;
  try {
    if (solids.length > policy.maxCandidates) {
      fail('STEP_HEALING_REFUSED', 'STEP import exceeds the bounded exact-solid candidate limit.');
    }
    const inspections = solids.map((solid) => inspectExactShape(oc, rc, solid));
    if (inspections.some((inspection) => !isAcceptedSolid(inspection.metrics))) {
      fail('STEP_HEALING_REFUSED', 'STEP import contains an invalid or open solid; solid repair is outside the bounded face-healing policy.');
    }
    const totals = inspections.reduce((sum, inspection) => ({
      shells: sum.shells + inspection.metrics.shellCount,
      faces: sum.faces + inspection.metrics.faceCount,
      edges: sum.edges + inspection.metrics.edgeCount,
      vertices: sum.vertices + inspection.metrics.vertexCount,
    }), { shells: 0, faces: 0, edges: 0, vertices: 0 });
    const root = rootInspection.metrics;
    if (totals.shells !== root.shellCount || totals.faces !== root.faceCount
        || totals.edges !== root.edgeCount || totals.vertices !== root.vertexCount) {
      fail('STEP_HEALING_REFUSED', 'STEP import mixes valid solids with unaccounted exact topology.');
    }
    return solids;
  } catch (error) {
    disposeShapes(solids);
    throw error;
  }
}

function attemptSewing(oc, rc, rootShape, pre, toleranceMm, index) {
  let sewing = null;
  let progress = null;
  let sewedRaw = null;
  let sewed = null;
  let shell = null;
  let solidFixer = null;
  let solidRaw = null;
  let solid = null;
  let after = clone(pre);
  let accepted = false;
  try {
    sewing = new oc.BRepBuilderAPI_Sewing(toleranceMm, true, true, true, false);
    sewing.SetSameParameterMode(true);
    sewing.SetNonManifoldMode(false);
    sewing.SetFaceMode(true);
    sewing.SetFloatingEdgesMode(false);
    const faces = exactSubshapes(rc, rootShape, 'face');
    try { faces.forEach((face) => sewing.Add(face.wrapped)); }
    finally { disposeShapes(faces); }
    progress = new oc.Message_ProgressRange_1();
    sewing.Perform(progress);
    const diagnostics = {
      free: sewing.NbFreeEdges(),
      multiple: sewing.NbMultipleEdges(),
      degenerated: sewing.NbDegeneratedShapes(),
      deleted: sewing.NbDeletedFaces(),
    };
    sewedRaw = sewing.SewedShape();
    sewed = rc.cast(sewedRaw);
    const sewedInspection = inspectExactShape(oc, rc, sewed);
    after = publicMetrics(sewedInspection);
    const shells = exactSubshapes(rc, sewed, 'shell');
    try {
      if (shells.length === 1) shell = shells[0].clone();
    } finally { disposeShapes(shells); }
    if (diagnostics.free === 0 && diagnostics.multiple === 0
        && diagnostics.degenerated === 0 && diagnostics.deleted === 0
        && sewedInspection.metrics.shellCount === 1
        && sewedInspection.metrics.faceCount === pre.faceCount
        && sewedInspection.faceOwnedEdgeCount === sewedInspection.metrics.edgeCount
        && shell) {
      solidFixer = new oc.ShapeFix_Solid_1();
      solidRaw = solidFixer.SolidFromShell(shell.wrapped);
      solid = rc.cast(solidRaw);
      const solidInspection = inspectExactShape(oc, rc, solid);
      after = publicMetrics(solidInspection);
      const boundsDelta = maxBoundsDelta(pre.boundsMm, after.boundsMm);
      accepted = isAcceptedSolid(after)
        && after.faceCount === pre.faceCount
        && solidInspection.faceOwnedEdgeCount === after.edgeCount
        && boundsDelta <= toleranceMm + 1e-9;
    }
    return {
      attempt: {
        index,
        action: ACTION,
        toleranceMm,
        applied: accepted,
        before: clone(pre),
        after: clone(after),
      },
      solid: accepted ? solid : null,
    };
  } finally {
    if (!accepted) safeDelete(solid);
    safeDelete(solidRaw);
    safeDelete(solidFixer);
    safeDelete(shell);
    safeDelete(sewed);
    safeDelete(sewedRaw);
    safeDelete(progress);
    safeDelete(sewing);
  }
}

export function createStudioStepImportHealing(rc) {
  if (!rc?.getOC) throw new Error('STEP healing requires the OpenCascade runtime.');
  const oc = rc.getOC();

  function inspect(shape) {
    return publicMetrics(inspectExactShape(oc, rc, shape));
  }

  function prepare(rootShape, context = {}) {
    const inspectedRoot = inspectExactShape(oc, rc, rootShape);
    // Preserve the exact source shape internally while applying accounting
    // checks; no mesh or bounding-box substitute can enter this boundary.
    inspectedRoot.shape = rootShape;
    const pre = publicMetrics(inspectedRoot);
    const policy = policyFor(pre, context.maxCandidates);
    const preserved = preserveValidSolids(oc, rc, inspectedRoot, policy);
    if (preserved) {
      return {
        solids: preserved,
        evidence: unchangedEvidence(context, policy, pre),
      };
    }

    if (pre.solidCount !== 0 || pre.faceCount === 0 || pre.faceCount > policy.maxCandidates) {
      fail('STEP_HEALING_REFUSED', 'STEP healing accepts only one bounded face or shell body candidate.');
    }
    if (inspectedRoot.traversedFaceCount !== pre.faceCount
        || inspectedRoot.faceOwnedEdgeCount !== pre.edgeCount) {
      fail('STEP_HEALING_REFUSED', 'STEP healing refuses unaccounted non-face topology.');
    }
    if (pre.multipleEdgeCount > 0) {
      fail('STEP_HEALING_REFUSED', 'STEP healing refuses non-manifold source edges.');
    }

    const attempts = [];
    let acceptedSolid = null;
    for (const toleranceMm of toleranceLadder(policy.maxToleranceMm)) {
      const outcome = attemptSewing(oc, rc, rootShape, pre, toleranceMm, attempts.length + 1);
      attempts.push(outcome.attempt);
      if (outcome.solid) {
        acceptedSolid = outcome.solid;
        break;
      }
    }
    if (!acceptedSolid) {
      fail(
        'STEP_HEALING_REFUSED',
        'STEP geometry could not be closed as one valid exact solid within the '
          + policy.maxToleranceMm + ' mm bounded tolerance policy.',
      );
    }
    const post = clone(attempts.at(-1).after);
    const selectedToleranceMm = attempts.at(-1).toleranceMm;
    return {
      solids: [acceptedSolid],
      evidence: {
        ...evidenceBase(context, policy),
        status: 'healed',
        applied: true,
        selectedToleranceMm,
        attempts,
        defects: sourceDefects(pre),
        actions: [{ action: ACTION, toleranceMm: selectedToleranceMm }],
        pre,
        post,
        drift: driftEvidence(pre, post),
      },
    };
  }

  return Object.freeze({
    inspect,
    prepare,
    disposeSolids: disposeShapes,
  });
}
