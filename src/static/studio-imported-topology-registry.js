// Persistent topology for imported OCCT solids.
//
// A BREP reopen creates new TopoDS_TShape instances. Comparing a separately
// deserialized face, edge, or vertex with a subshape of the reopened solid is
// therefore not a persistence mechanism: TopoDS_Shape::IsSame is false even
// when both objects came from identical BREP text.
//
// This registry stores one carrier BREP. The carrier contains the imported
// solid and exact references to each of its subshapes in the *same* OCCT shape
// graph. A marker is identified by a persisted structural slot encoded in the
// orientation multiplicities of one repeated exact child. Geometry, explorer
// order, HashCode, serialized subshape comparison, and proximity never select
// a subshape. The source BREP
// is retained separately and compared as full canonical text, not as a hash,
// so a stale registry cannot be applied to a replacement import.
//
// Import-boundary persistence contract:
//   const captured = registry.capture({ shape: importedSolid, registryId });
//   resource.data = base64(captured.sourceBrep);
//   resource.extensions.studioImportedStep.topologyRegistry = captured.registry;
//   feature.extensions.studioImportedStep.topologyRegistry = captured.featureReference;
//
// Rebuild contract:
//   registry.restore({
//     sourceBrep: decodedResourceData,
//     registry: resource.extensions.studioImportedStep.topologyRegistry,
//     expectedRegistryRef: feature.extensions.studioImportedStep.topologyRegistry,
//   });
//
// The restore result owns `{ shape, names: {faces, edges, vertices} }` and must
// be disposed with `disposeOutcome`. A persistent-topology-required rebuild of
// an older imported-step feature with no registry must fail; it must not create
// names from the reopened shape. Resource budgets must include UTF-8 bytes for
// both `sourceBrep` and `registry.carrierBrep`.

export const IMPORTED_TOPOLOGY_REGISTRY_SCHEMA = 'partmode.imported-topology-registry/v1';
export const IMPORTED_TOPOLOGY_REGISTRY_VERSION = 1;

export const IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES = Object.freeze({
  invalidInput: 'IMPORTED_TOPOLOGY_REGISTRY_INVALID_INPUT',
  unsupportedShape: 'IMPORTED_TOPOLOGY_REGISTRY_UNSUPPORTED_SHAPE',
  invalidRegistry: 'IMPORTED_TOPOLOGY_REGISTRY_INVALID_REGISTRY',
  registryMismatch: 'IMPORTED_TOPOLOGY_REGISTRY_REFERENCE_MISMATCH',
  invalidCarrier: 'IMPORTED_TOPOLOGY_REGISTRY_INVALID_CARRIER',
  sourceMismatch: 'IMPORTED_TOPOLOGY_REGISTRY_SOURCE_MISMATCH',
  missingProvenance: 'IMPORTED_TOPOLOGY_REGISTRY_MISSING_PROVENANCE',
  ambiguousProvenance: 'IMPORTED_TOPOLOGY_REGISTRY_AMBIGUOUS_PROVENANCE',
  incompleteCoverage: 'IMPORTED_TOPOLOGY_REGISTRY_INCOMPLETE_COVERAGE',
  capacityExceeded: 'IMPORTED_TOPOLOGY_REGISTRY_CAPACITY_EXCEEDED',
});

export class ImportedTopologyRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ImportedTopologyRegistryError';
    this.code = code;
    for (const [key, value] of Object.entries(details)) this[key] = value;
    this.diagnostics = [{ severity: 'error', code, ...details, message }];
  }
}

const descriptor = Object.freeze({
  face: Object.freeze({ tableKey: 'faces', wrapperKey: 'face', tag: 'F' }),
  edge: Object.freeze({ tableKey: 'edges', wrapperKey: 'edge', tag: 'E' }),
  vertex: Object.freeze({ tableKey: 'vertices', wrapperKey: 'vertex', tag: 'V' }),
});

const SLOT_BASE = 16;
const SLOT_DIGIT_COUNT = 4;
const MAX_SLOT = SLOT_BASE ** SLOT_DIGIT_COUNT - 1;
const MAX_CANONICAL_BREP_REOPEN_PASSES = 32;
// OCCT rebuilds gp_Ax2/gp_Ax3 frames from cross products while reading
// analytic curve and surface records. Near-zero double-roundoff components can
// therefore drift for hundreds of reopen passes or differ between a solid and
// its co-serialized carrier even though the geometry is unchanged. Quantize
// only the nine dimensionless direction coefficients to the measured stable
// sub-picoradian grid; origins and scalar parameters remain exact.
const CANONICAL_ANALYTIC_FRAME_GRID = 1e-12;
const BREP_NUMBER_TOKEN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[Ee][-+]?\d+)?$/;
const compareCodeUnits = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const ANALYTIC_SURFACE_FRAME_TOKEN_COUNTS = Object.freeze({
  // GeomTools surface record type: plane, cylinder, cone, sphere, torus.
  // A cone's semi-angle is written on the following line; its reference
  // radius remains the final token of the frame line.
  1: 13,
  2: 14,
  3: 14,
  4: 14,
  5: 15,
});
const ANALYTIC_CURVE_FRAME_TOKEN_COUNTS = Object.freeze({
  // GeomTools 3D curve record type: circle, ellipse, parabola, hyperbola.
  2: 14,
  3: 15,
  4: 14,
  5: 15,
});

function isCanonicalAnalyticFrameRecord(tokens, expectedTokenCount) {
  if (tokens.length !== expectedTokenCount || !tokens.every((token) => BREP_NUMBER_TOKEN.test(token))) {
    return false;
  }
  const values = tokens.slice(1).map(Number);
  if (!values.every(Number.isFinite)) return false;
  const directions = [values.slice(3, 6), values.slice(6, 9), values.slice(9, 12)];
  const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
  const cross = (left, right) => [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
  const lengths = directions.map((direction) => Math.sqrt(dot(direction, direction)));
  return lengths.every((length) => Math.abs(length - 1) <= 1e-9)
    && Math.abs(dot(directions[0], directions[1])) <= 1e-9
    && Math.abs(dot(directions[0], directions[2])) <= 1e-9
    && Math.abs(dot(directions[1], directions[2])) <= 1e-9
    && Math.abs(Math.abs(dot(cross(directions[0], directions[1]), directions[2])) - 1) <= 1e-9;
}

function normalizeBrepAnalyticFrameNoise(brep) {
  let section = '';
  return String(brep).split('\n').map((line) => {
    const trimmed = line.trim();
    if (/^Curves\s+\d+$/.test(trimmed)) {
      section = 'curve-3d';
      return line;
    }
    if (/^Curve2ds\s+\d+$/.test(trimmed)) {
      section = '';
      return line;
    }
    if (/^Polygon3D\s+\d+$/.test(trimmed)) {
      section = '';
      return line;
    }
    if (/^Surfaces\s+\d+$/.test(trimmed)) {
      section = 'surface';
      return line;
    }
    if (/^Triangulations\s+\d+$/.test(trimmed)) {
      section = '';
      return line;
    }
    if (!section) return line;
    const tokens = trimmed.split(/\s+/);
    const expectedTokenCount = section === 'surface'
      ? ANALYTIC_SURFACE_FRAME_TOKEN_COUNTS[tokens[0]]
      : ANALYTIC_CURVE_FRAME_TOKEN_COUNTS[tokens[0]];
    if (!expectedTokenCount || !isCanonicalAnalyticFrameRecord(tokens, expectedTokenCount)) return line;
    let tokenIndex = -1;
    return line.replace(/\S+/g, (token) => {
      tokenIndex++;
      if (tokenIndex < 4 || tokenIndex > 12) return token;
      const value = Number(token);
      const quantized = Math.round(value / CANONICAL_ANALYTIC_FRAME_GRID)
        * CANONICAL_ANALYTIC_FRAME_GRID;
      return quantized === 0 ? '0' : String(quantized);
    });
  }).join('\n');
}

function firstBrepDifference(left, right) {
  const leftLines = String(left).split('\n');
  const rightLines = String(right).split('\n');
  const count = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < count; index++) {
    if (leftLines[index] !== rightLines[index]) {
      return {
        line: index + 1,
        left: String(leftLines[index] ?? '').slice(0, 240),
        right: String(rightLines[index] ?? '').slice(0, 240),
        leftBytes: String(left).length,
        rightBytes: String(right).length,
      };
    }
  }
  return { line: null, left: '', right: '', leftBytes: String(left).length, rightBytes: String(right).length };
}

const encoded = (value) => {
  const text = String(value);
  return text.length + ':' + text;
};

const opaqueTokenForSlot = (slot) => Number(slot).toString(36).padStart(4, '0');

export function importedTopologyPersistentName(registryId, topologyKind, opaqueToken) {
  const info = descriptor[topologyKind];
  if (!info) {
    throw new ImportedTopologyRegistryError(
      IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidInput,
      'Imported topology names require a supported topology kind.',
      { reason: 'unsupported-topology-kind', topologyKind: String(topologyKind || '') },
    );
  }
  return info.tag + 'I' + encoded(registryId) + ':opaque:' + encoded(opaqueToken);
}

export function importedTopologyFeatureReference(registry) {
  return Object.freeze({
    schema: IMPORTED_TOPOLOGY_REGISTRY_SCHEMA,
    version: IMPORTED_TOPOLOGY_REGISTRY_VERSION,
    registryId: String(registry?.registryId || ''),
  });
}

export function createStudioImportedTopologyRegistry(rc) {
  const oc = rc.getOC();
  const safeDelete = (value) => { try { value?.delete?.(); } catch {} };
  const disposeWrappers = (values) => { for (const value of values || []) safeDelete(value); };

  function fail(code, message, details = {}) {
    throw new ImportedTopologyRegistryError(code, message, details);
  }

  const shapeEnum = Object.freeze({
    vertex: oc.TopAbs_ShapeEnum.TopAbs_VERTEX,
    edge: oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    wire: oc.TopAbs_ShapeEnum.TopAbs_WIRE,
    face: oc.TopAbs_ShapeEnum.TopAbs_FACE,
    shell: oc.TopAbs_ShapeEnum.TopAbs_SHELL,
    solid: oc.TopAbs_ShapeEnum.TopAbs_SOLID,
    compsolid: oc.TopAbs_ShapeEnum.TopAbs_COMPSOLID,
    compound: oc.TopAbs_ShapeEnum.TopAbs_COMPOUND,
  });

  function exactSubshapes(shape, kind) {
    const target = shapeEnum[kind];
    if (target == null || !shape?.wrapped) {
      fail(
        IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidInput,
        'Exact imported topology enumeration requires a wrapped OCCT shape and supported kind.',
        { reason: 'invalid-exact-enumeration-input', topologyKind: String(kind || '') },
      );
    }
    const explorer = new oc.TopExp_Explorer_2(
      shape.wrapped,
      target,
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

  function canonicalBrep(shape) {
    if (!shape?.wrapped || typeof shape.serialize !== 'function') {
      fail(
        IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidInput,
        'Imported topology evidence requires a serializable OCCT shape.',
        { reason: 'shape-is-not-serializable' },
      );
    }
    let current = normalizeBrepAnalyticFrameNoise(shape.serialize());
    const seen = new Map([[current, 0]]);
    let lastDifference = null;
    for (let pass = 1; pass <= MAX_CANONICAL_BREP_REOPEN_PASSES; pass++) {
      let reopened = null;
      try {
        reopened = rc.deserializeShape(current);
        oc.BRepTools.Clean(reopened.wrapped, true);
        const next = normalizeBrepAnalyticFrameNoise(reopened.serialize());
        if (next === current) {
          // Verify once more from a new OCCT graph. This is deliberately more
          // than bounded convergence: the returned bytes must themselves be
          // an exact clean serialize/reopen fixed point.
          let verification = null;
          try {
            verification = rc.deserializeShape(next);
            oc.BRepTools.Clean(verification.wrapped, true);
            if (normalizeBrepAnalyticFrameNoise(verification.serialize()) !== next) {
              fail(
                IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidInput,
                'Imported topology source BREP failed final fixed-point verification.',
                { reason: 'source-brep-final-verification-mismatch', pass },
              );
            }
          } finally {
            safeDelete(verification);
          }
          return next;
        }
        lastDifference = firstBrepDifference(current, next);
        const previousPass = seen.get(next);
        if (previousPass !== undefined) {
          // Some valid gp_Ax2/gp_Ax3 records form an irreducible two-state
          // serialize/reopen cycle at full double precision. Every phase in a
          // deterministic cycle has the same geometry. Select its exact
          // code-unit-minimum BREP as the canonical representative instead of
          // rounding nonzero model data or depending on the starting phase.
          return [...seen.entries()]
            .filter(([, seenPass]) => seenPass >= previousPass)
            .map(([candidate]) => candidate)
            .sort(compareCodeUnits)[0];
        }
        seen.set(next, pass);
        current = next;
      } finally {
        safeDelete(reopened);
      }
    }
    fail(
      IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidInput,
      'Imported topology source BREP did not reach a canonical serialize/reopen fixed point within the bounded pass limit. '
        + 'Last differing BREP line: ' + String(lastDifference?.line ?? 'unknown') + '.',
      {
        reason: 'source-brep-canonicalization-limit',
        maxPasses: MAX_CANONICAL_BREP_REOPEN_PASSES,
        lastDifference,
      },
    );
  }

  function validateSolid(shape, context) {
    if (!shape?.wrapped || shape.wrapped.ShapeType() !== shapeEnum.solid) {
      fail(
        IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.unsupportedShape,
        'Imported persistent topology currently requires one exact OCCT solid per resource.',
        { reason: 'resource-is-not-one-solid', context },
      );
    }
    const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
    try {
      if (!analyzer.IsValid_2()) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.unsupportedShape,
          'Imported persistent topology requires a valid OCCT solid.',
          { reason: 'invalid-source-solid', context },
        );
      }
    } finally {
      safeDelete(analyzer);
    }
    const faces = exactSubshapes(shape, 'face');
    try {
      if (!faces.length) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.unsupportedShape,
          'Imported persistent topology requires a non-empty OCCT solid.',
          { reason: 'source-solid-has-no-faces', context },
        );
      }
    } finally {
      disposeWrappers(faces);
    }
  }

  const persistentRootKinds = Object.freeze({
    solid: shapeEnum.solid,
    compsolid: shapeEnum.compsolid,
    compound: shapeEnum.compound,
  });

  function persistentRootKind(shape) {
    if (!shape?.wrapped) return null;
    const shapeType = shape.wrapped.ShapeType();
    return Object.keys(persistentRootKinds).find((kind) => persistentRootKinds[kind] === shapeType) || null;
  }

  function validateOneSolidRoot(shape, context) {
    const rootKind = persistentRootKind(shape);
    if (!rootKind) {
      fail(
        IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.unsupportedShape,
        'Persistent topology checkpoints require a SOLID, COMPSOLID, or COMPOUND root.',
        { reason: 'unsupported-checkpoint-root-kind', context },
      );
    }
    const solids = rootKind === 'solid' ? [shape.clone()] : exactSubshapes(shape, 'solid');
    try {
      if (solids.length !== 1) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.unsupportedShape,
          'Persistent topology checkpoints require exactly one exact OCCT solid.',
          { reason: 'checkpoint-root-solid-count', context, candidateCount: solids.length },
        );
      }
    } finally {
      disposeWrappers(solids);
    }
    const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
    try {
      if (!analyzer.IsValid_2()) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.unsupportedShape,
          'Persistent topology checkpoints require a valid OCCT one-solid root.',
          { reason: 'invalid-checkpoint-root', context },
        );
      }
    } finally {
      safeDelete(analyzer);
    }
    const faces = exactSubshapes(shape, 'face');
    try {
      if (!faces.length) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.unsupportedShape,
          'Persistent topology checkpoints require a non-empty OCCT solid.',
          { reason: 'checkpoint-root-has-no-faces', context },
        );
      }
    } finally {
      disposeWrappers(faces);
    }
    return rootKind;
  }

  function oneSolidRootFromSolid(solid, rootKind) {
    if (rootKind === 'solid') return solid.clone();
    let builder = null;
    let rawRoot = null;
    let root = null;
    try {
      builder = new oc.TopoDS_Builder();
      rawRoot = rootKind === 'compsolid' ? new oc.TopoDS_CompSolid() : new oc.TopoDS_Compound();
      if (rootKind === 'compsolid') builder.MakeCompSolid(rawRoot);
      else builder.MakeCompound(rawRoot);
      builder.Add(rawRoot, solid.wrapped);
      root = rc.cast(rawRoot);
      safeDelete(rawRoot);
      rawRoot = null;
      return root;
    } catch (error) {
      safeDelete(root);
      throw error;
    } finally {
      safeDelete(rawRoot);
      safeDelete(builder);
    }
  }

  const slotOrientations = Object.freeze([
    oc.TopAbs_Orientation.TopAbs_FORWARD,
    oc.TopAbs_Orientation.TopAbs_REVERSED,
    oc.TopAbs_Orientation.TopAbs_INTERNAL,
    oc.TopAbs_Orientation.TopAbs_EXTERNAL,
  ]);

  function addSlotOccurrences(builder, marker, child, slot) {
    let remainder = slot;
    for (const orientation of slotOrientations) {
      const digit = remainder % SLOT_BASE;
      remainder = Math.floor(remainder / SLOT_BASE);
      // One sentinel occurrence in each orientation makes a registry marker
      // independently recognizable. The additional 0..15 occurrences encode
      // one base-16 digit. Child ordering is never read.
      for (let index = 0; index <= digit; index++) {
        const occurrence = child.Oriented(orientation);
        try { builder.Add(marker, occurrence); }
        finally { safeDelete(occurrence); }
      }
    }
    if (remainder !== 0) {
      fail(
        IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.capacityExceeded,
        'Imported topology registry exceeded its structural slot capacity.',
        { reason: 'slot-cannot-be-encoded', slot, maxSlot: MAX_SLOT },
      );
    }
  }

  function markerSlot(marker, childKind) {
    const explorer = new oc.TopExp_Explorer_2(
      marker.wrapped,
      shapeEnum[childKind],
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    const counts = [0, 0, 0, 0];
    let representative = null;
    try {
      while (explorer.More()) {
        let current = null;
        try {
          current = explorer.Current();
          if (!representative) {
            representative = current;
            current = null;
          } else if (!representative.IsSame(current)) {
            return null;
          }
          const orientation = (current || representative).Orientation_1();
          const orientationIndex = slotOrientations.findIndex((candidate) => candidate === orientation);
          if (orientationIndex < 0) return null;
          counts[orientationIndex]++;
        } finally {
          safeDelete(current);
        }
        explorer.Next();
      }
      if (!representative || counts.some((count) => count < 1 || count > SLOT_BASE)) return null;
      return counts.reduce((slot, count, index) =>
        slot + (count - 1) * SLOT_BASE ** index, 0);
    } finally {
      safeDelete(representative);
      safeDelete(explorer);
    }
  }

  function vertexMarkerEdge(sourceVertex) {
    let point = null;
    let tokenPoint = null;
    let tokenMaker = null;
    let tokenVertex = null;
    let edgeMaker = null;
    try {
      point = oc.BRep_Tool.Pnt(sourceVertex.wrapped);
      // Marker geometry is never queried during restore. Its only purpose is
      // to make a valid auxiliary edge that retains the exact source vertex.
      tokenPoint = new oc.gp_Pnt_3(point.X() + 1, point.Y() + 2, point.Z() + 3);
      tokenMaker = new oc.BRepBuilderAPI_MakeVertex(tokenPoint);
      tokenVertex = tokenMaker.Vertex();
      edgeMaker = new oc.BRepBuilderAPI_MakeEdge_2(sourceVertex.wrapped, tokenVertex);
      if (!edgeMaker.IsDone()) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidCarrier,
          'OCCT could not create an imported vertex identity marker.',
          { reason: 'vertex-marker-edge-failed' },
        );
      }
      return edgeMaker.Edge();
    } finally {
      safeDelete(edgeMaker);
      safeDelete(tokenVertex);
      safeDelete(tokenMaker);
      safeDelete(tokenPoint);
      safeDelete(point);
    }
  }

  function createMarker(builder, rawCarrier, kind, subshape, slot) {
    let marker = null;
    let child = null;
    try {
      if (kind === 'face') {
        marker = new oc.TopoDS_Shell();
        builder.MakeShell(marker);
        child = subshape.wrapped;
      } else {
        marker = new oc.TopoDS_Wire();
        builder.MakeWire(marker);
        child = kind === 'edge' ? subshape.wrapped : vertexMarkerEdge(subshape);
      }
      addSlotOccurrences(builder, marker, child, slot);
      builder.Add(rawCarrier, marker);
    } finally {
      if (kind === 'vertex') safeDelete(child);
      safeDelete(marker);
    }
  }

  function validRegistryId(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 160;
  }

  function validateRegistry(registry) {
    if (!registry || typeof registry !== 'object'
      || registry.schema !== IMPORTED_TOPOLOGY_REGISTRY_SCHEMA
      || registry.version !== IMPORTED_TOPOLOGY_REGISTRY_VERSION
      || !validRegistryId(registry.registryId)
      || registry.carrierFormat !== 'occt-brep-shared-identity-carrier-v1'
      || typeof registry.carrierBrep !== 'string'
      || !registry.carrierBrep.length
      || !Array.isArray(registry.entries)
      || !registry.topologyCounts
      || typeof registry.topologyCounts !== 'object') {
      fail(
        IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidRegistry,
        'Imported topology registry metadata is malformed or unsupported.',
        { reason: 'invalid-registry-envelope' },
      );
    }
    if (registry.entries.length > MAX_SLOT) {
      fail(
        IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.capacityExceeded,
        'Imported topology registry has too many exact subshapes.',
        { reason: 'registry-entry-capacity-exceeded', entryCount: registry.entries.length, maxSlot: MAX_SLOT },
      );
    }
    const slots = new Set();
    const names = new Set();
    const nameMode = registry.nameMode || 'opaque-import-v1';
    const providedNameMode = nameMode === 'provided-persistent-names-v1';
    if (nameMode !== 'opaque-import-v1' && !providedNameMode) {
      fail(
        IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidRegistry,
        'Imported topology registry has an unsupported persistent-name mode.',
        { reason: 'unsupported-persistent-name-mode', nameMode: String(nameMode || '') },
      );
    }
    if (providedNameMode && !persistentRootKinds[registry.sourceRootKind]) {
      fail(
        IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidRegistry,
        'Persistent topology checkpoint registry has an invalid source-root kind.',
        { reason: 'invalid-persistent-source-root-kind', sourceRootKind: String(registry.sourceRootKind || '') },
      );
    }
    for (const entry of registry.entries) {
      if (!Number.isInteger(entry?.slot) || entry.slot < 1 || entry.slot > MAX_SLOT
        || !descriptor[entry?.kind]
        || entry?.opaqueToken !== opaqueTokenForSlot(entry.slot)
        || typeof entry?.name !== 'string' || !entry.name.length) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidRegistry,
          'Imported topology registry contains a malformed entry.',
          { reason: 'invalid-registry-entry' },
        );
      }
      const expectedName = nameMode === 'opaque-import-v1'
        ? importedTopologyPersistentName(registry.registryId, entry.kind, entry.opaqueToken)
        : null;
      if (expectedName !== null && entry.name !== expectedName) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidRegistry,
          'Imported topology persistent name does not match its structural marker token.',
          {
            reason: 'persistent-name-marker-token-mismatch',
            topologyKind: entry.kind,
            slot: entry.slot,
          },
        );
      }
      if (slots.has(entry.slot) || names.has(entry.name)) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.ambiguousProvenance,
          'Imported topology registry slots and persistent names must be one-to-one.',
          { reason: slots.has(entry.slot) ? 'duplicate-registry-slot' : 'duplicate-persistent-name' },
        );
      }
      slots.add(entry.slot);
      names.add(entry.name);
    }
    for (const kind of Object.keys(descriptor)) {
      const expected = registry.entries.filter((entry) => entry.kind === kind).length;
      const exactCount = registry.topologyCounts[descriptor[kind].tableKey];
      const validCount = Number.isInteger(exactCount) && exactCount === expected;
      if (!validCount) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidRegistry,
          'Imported topology registry counts do not match its entries.',
          { reason: 'registry-count-mismatch', topologyKind: kind, expected, exactCount },
        );
      }
    }
  }

  function validateExpectedReference(registry, expectedRegistryRef) {
    if (!expectedRegistryRef) return;
    if (expectedRegistryRef.schema !== IMPORTED_TOPOLOGY_REGISTRY_SCHEMA
      || expectedRegistryRef.version !== IMPORTED_TOPOLOGY_REGISTRY_VERSION
      || expectedRegistryRef.registryId !== registry.registryId) {
      fail(
        IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.registryMismatch,
        'The imported feature and resource topology registries do not match.',
        {
          reason: 'feature-resource-registry-reference-mismatch',
          expectedRegistryId: String(expectedRegistryRef.registryId || ''),
          actualRegistryId: registry.registryId,
        },
      );
    }
  }

  function capture({ shape, registryId }) {
    if (!validRegistryId(registryId)) {
      fail(
        IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidInput,
        'Imported topology capture requires a stable registry ID.',
        { reason: 'invalid-capture-metadata' },
      );
    }
    validateSolid(shape, 'capture');
    let sourceBrep = canonicalBrep(shape);
    let source = null;
    let carrier = null;
    let builder = null;
    let rawCarrier = null;
    const sourceTables = { faces: [], edges: [], vertices: [] };
    try {
      source = rc.deserializeShape(sourceBrep);
      validateSolid(source, 'canonical-capture');
      sourceTables.faces = exactSubshapes(source, 'face');
      sourceTables.edges = exactSubshapes(source, 'edge');
      sourceTables.vertices = exactSubshapes(source, 'vertex');
      const entryCount = sourceTables.faces.length + sourceTables.edges.length + sourceTables.vertices.length;
      if (entryCount > MAX_SLOT) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.capacityExceeded,
          'Imported topology registry has too many exact subshapes.',
          { reason: 'source-entry-capacity-exceeded', entryCount, maxSlot: MAX_SLOT },
        );
      }

      builder = new oc.TopoDS_Builder();
      rawCarrier = new oc.TopoDS_Compound();
      builder.MakeCompound(rawCarrier);
      builder.Add(rawCarrier, source.wrapped);
      const entries = [];
      let slot = 0;
      // This is the one-time import capture, where no older identity exists.
      // Enumeration assigns fresh opaque entries once; restore never assigns
      // by enumeration position and only accepts self-decoding markers.
      for (const kind of Object.keys(descriptor)) {
        const info = descriptor[kind];
        for (const subshape of sourceTables[info.tableKey]) {
          slot++;
          const opaqueToken = opaqueTokenForSlot(slot);
          createMarker(builder, rawCarrier, kind, subshape, slot);
          entries.push({
            slot,
            kind,
            opaqueToken,
            name: importedTopologyPersistentName(registryId, kind, opaqueToken),
          });
        }
      }
      carrier = rc.cast(rawCarrier);
      safeDelete(rawCarrier);
      rawCarrier = null;
      // TopoDS_Builder makes a child occurrence non-free when it is inserted
      // into the carrier. Persist the canonical body evidence after that
      // administrative flag transition so save/reopen comparison is exact.
      sourceBrep = canonicalBrep(source);
      const registry = {
        schema: IMPORTED_TOPOLOGY_REGISTRY_SCHEMA,
        version: IMPORTED_TOPOLOGY_REGISTRY_VERSION,
        registryId,
        carrierFormat: 'occt-brep-shared-identity-carrier-v1',
        carrierBrep: carrier.serialize(),
        topologyCounts: {
          faces: sourceTables.faces.length,
          edges: sourceTables.edges.length,
          vertices: sourceTables.vertices.length,
        },
        entries,
      };
      return {
        sourceBrep,
        registry,
        featureReference: importedTopologyFeatureReference(registry),
      };
    } finally {
      for (const key of ['faces', 'edges', 'vertices']) disposeWrappers(sourceTables[key]);
      safeDelete(builder);
      safeDelete(carrier);
      safeDelete(rawCarrier);
      safeDelete(source);
    }
  }

  // Capture a complete existing F/E/V name set into a private shared-identity
  // carrier. Unlike one-time import capture, names already exist and must move
  // to the checkpoint solid only through authoritative OCCT history.
  function captureNamed({ shape, registryId, names }) {
    if (!validRegistryId(registryId) || !names || typeof names !== 'object') {
      fail(
        IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidInput,
        'Named topology capture requires a stable registry ID and complete F/E/V tables.',
        { reason: 'invalid-named-capture-metadata' },
      );
    }
    validateOneSolidRoot(shape, 'named-capture');
    let sourceRootKind = null;
    let identity = null;
    let copier = null;
    let rawSource = null;
    let source = null;
    let carrier = null;
    let builder = null;
    let rawCarrier = null;
    const inputTables = { faces: [], edges: [], vertices: [] };
    const sourceTables = { faces: [], edges: [], vertices: [] };
    const mappedNames = { faces: [], edges: [], vertices: [] };
    try {
      for (const kind of Object.keys(descriptor)) {
        const info = descriptor[kind];
        if (!Array.isArray(names[info.tableKey])) {
          fail(
            IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidInput,
            'Named topology capture is missing one exact topology table.',
            { reason: 'missing-named-capture-table', topologyKind: kind },
          );
        }
        inputTables[info.tableKey] = exactSubshapes(shape, kind);
        const supplied = names[info.tableKey];
        const suppliedNames = new Set();
        const claimedInputs = [];
        for (const entry of supplied) {
          const wrapper = entry?.[info.wrapperKey];
          const persistentName = entry?.name;
          const matches = inputTables[info.tableKey].filter((candidate) =>
            wrapper?.wrapped && candidate.wrapped.IsSame(wrapper.wrapped));
          if (
            typeof persistentName !== 'string'
            || !persistentName
            || suppliedNames.has(persistentName)
            || matches.length !== 1
            || claimedInputs.some((candidate) => candidate.wrapped.IsSame(matches[0].wrapped))
          ) {
            fail(
              matches.length > 1 || suppliedNames.has(persistentName)
                ? IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.ambiguousProvenance
                : IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.incompleteCoverage,
              'Named topology capture tables must cover each exact input subshape one-to-one.',
              {
                reason: 'invalid-named-capture-coverage',
                topologyKind: kind,
                persistentName: String(persistentName || ''),
                candidateCount: matches.length,
              },
            );
          }
          suppliedNames.add(persistentName);
          claimedInputs.push(matches[0]);
        }
        if (supplied.length !== inputTables[info.tableKey].length) {
          fail(
            IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.incompleteCoverage,
            'Named topology capture requires complete exact topology coverage.',
            {
              reason: 'named-capture-count-mismatch',
              topologyKind: kind,
              exactCount: inputTables[info.tableKey].length,
              namedCount: supplied.length,
            },
          );
        }
      }

      identity = new rc.Transformation();
      copier = new oc.BRepBuilderAPI_Transform_2(shape.wrapped, identity.wrapped, true);
      if (!copier.IsDone()) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidCarrier,
          'OCCT could not create a private named topology checkpoint solid.',
          { reason: 'named-capture-copy-not-done' },
        );
      }
      rawSource = copier.ModifiedShape(shape.wrapped);
      source = rc.cast(rawSource);
      safeDelete(rawSource);
      rawSource = null;
      sourceRootKind = validateOneSolidRoot(source, 'named-capture-copy');
      if (sourceRootKind !== 'solid') {
        const copiedSolids = exactSubshapes(source, 'solid');
        try {
          if (copiedSolids.length !== 1) {
            fail(
              IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.ambiguousProvenance,
              'OCCT checkpoint copy did not contain one exact source solid.',
              { reason: 'named-capture-copy-solid-count', candidateCount: copiedSolids.length },
            );
          }
          const normalizedSource = oneSolidRootFromSolid(copiedSolids[0], sourceRootKind);
          safeDelete(source);
          source = normalizedSource;
        } finally {
          disposeWrappers(copiedSolids);
        }
        validateOneSolidRoot(source, 'normalized-named-capture-copy');
      }
      for (const kind of Object.keys(descriptor)) {
        const info = descriptor[kind];
        sourceTables[info.tableKey] = exactSubshapes(source, kind);
        for (const entry of names[info.tableKey]) {
          let raw = null;
          try {
            raw = copier.ModifiedShape(entry[info.wrapperKey].wrapped);
            const matches = sourceTables[info.tableKey].filter((candidate) =>
              candidate.wrapped.IsSame(raw));
            if (matches.length !== 1 || mappedNames[info.tableKey].some((mapped) =>
              mapped[info.wrapperKey].wrapped.IsSame(matches[0].wrapped))) {
              fail(
                IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.ambiguousProvenance,
                'OCCT checkpoint-copy history did not transfer one persistent name one-to-one.',
                {
                  reason: 'named-capture-copy-history-mismatch',
                  topologyKind: kind,
                  persistentName: entry.name,
                  candidateCount: matches.length,
                },
              );
            }
            mappedNames[info.tableKey].push({
              name: entry.name,
              [info.wrapperKey]: matches[0].clone(),
            });
          } finally {
            safeDelete(raw);
          }
        }
      }

      const entryCount = sourceTables.faces.length + sourceTables.edges.length + sourceTables.vertices.length;
      if (entryCount > MAX_SLOT) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.capacityExceeded,
          'Named topology checkpoint has too many exact subshapes.',
          { reason: 'named-capture-capacity-exceeded', entryCount, maxSlot: MAX_SLOT },
        );
      }
      builder = new oc.TopoDS_Builder();
      rawCarrier = new oc.TopoDS_Compound();
      builder.MakeCompound(rawCarrier);
      builder.Add(rawCarrier, source.wrapped);
      const entries = [];
      const allNames = new Set();
      let slot = 0;
      for (const kind of Object.keys(descriptor)) {
        const info = descriptor[kind];
        const sorted = [...mappedNames[info.tableKey]].sort((left, right) => compareCodeUnits(left.name, right.name));
        for (const entry of sorted) {
          const matches = sourceTables[info.tableKey].filter((subshape) =>
            entry[info.wrapperKey].wrapped.IsSame(subshape.wrapped));
          if (matches.length !== 1 || allNames.has(entry.name)) {
            fail(
              IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.ambiguousProvenance,
              'Named topology checkpoint cannot bind one persistent name to each carrier subshape.',
              {
                reason: 'named-carrier-attribution-mismatch',
                topologyKind: kind,
                candidateCount: matches.length,
              },
            );
          }
          slot++;
          const opaqueToken = opaqueTokenForSlot(slot);
          createMarker(builder, rawCarrier, kind, matches[0], slot);
          entries.push({ slot, kind, opaqueToken, name: entry.name });
          allNames.add(entry.name);
        }
      }
      carrier = rc.cast(rawCarrier);
      safeDelete(rawCarrier);
      rawCarrier = null;
      let sourceBrep;
      if (sourceRootKind === 'solid') {
        sourceBrep = canonicalBrep(source);
      } else {
        const evidenceSolids = exactSubshapes(source, 'solid');
        let evidenceRoot = null;
        try {
          if (evidenceSolids.length !== 1) {
            fail(
              IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.ambiguousProvenance,
              'Persistent topology checkpoint evidence requires one exact source solid.',
              { reason: 'named-capture-evidence-solid-count', candidateCount: evidenceSolids.length },
            );
          }
          evidenceRoot = oneSolidRootFromSolid(evidenceSolids[0], sourceRootKind);
          sourceBrep = canonicalBrep(evidenceRoot);
        } finally {
          safeDelete(evidenceRoot);
          disposeWrappers(evidenceSolids);
        }
      }
      const registry = {
        schema: IMPORTED_TOPOLOGY_REGISTRY_SCHEMA,
        version: IMPORTED_TOPOLOGY_REGISTRY_VERSION,
        registryId,
        nameMode: 'provided-persistent-names-v1',
        sourceRootKind,
        carrierFormat: 'occt-brep-shared-identity-carrier-v1',
        carrierBrep: carrier.serialize(),
        topologyCounts: {
          faces: sourceTables.faces.length,
          edges: sourceTables.edges.length,
          vertices: sourceTables.vertices.length,
        },
        entries,
      };
      validateRegistry(registry);
      return {
        sourceBrep,
        registry,
        featureReference: importedTopologyFeatureReference(registry),
      };
    } finally {
      for (const kind of Object.keys(descriptor)) {
        const info = descriptor[kind];
        disposeWrappers(mappedNames[info.tableKey].map((entry) => entry[info.wrapperKey]));
        disposeWrappers(sourceTables[info.tableKey]);
        disposeWrappers(inputTables[info.tableKey]);
      }
      safeDelete(builder);
      safeDelete(carrier);
      safeDelete(rawCarrier);
      safeDelete(source);
      safeDelete(rawSource);
      safeDelete(copier);
      safeDelete(identity);
    }
  }

  function bodyFromCarrier(carrier, registry) {
    if (carrier.wrapped.ShapeType() !== shapeEnum.compound) {
      fail(
        IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidCarrier,
        'Imported topology carrier is not an OCCT compound.',
        { reason: 'carrier-is-not-compound' },
      );
    }
    const nameMode = registry.nameMode || 'opaque-import-v1';
    if (nameMode === 'provided-persistent-names-v1') {
      const rootKind = registry.sourceRootKind;
      const solids = exactSubshapes(carrier, 'solid');
      const nonEmpty = [];
      try {
        for (const solid of solids) {
          const faces = exactSubshapes(solid, 'face');
          try { if (faces.length) nonEmpty.push(solid); }
          finally { disposeWrappers(faces); }
        }
        if (nonEmpty.length !== 1) {
          fail(
            nonEmpty.length
              ? IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.ambiguousProvenance
              : IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.missingProvenance,
            'Persistent topology carrier does not contain one unambiguous exact source solid.',
            {
              reason: 'carrier-source-solid-count',
              sourceRootKind: rootKind,
              candidateCount: nonEmpty.length,
            },
          );
        }
        return oneSolidRootFromSolid(nonEmpty[0], rootKind);
      } finally {
        disposeWrappers(solids);
      }
    }
    const solids = exactSubshapes(carrier, 'solid');
    const nonEmpty = [];
    try {
      for (const solid of solids) {
        const faces = exactSubshapes(solid, 'face');
        try { if (faces.length) nonEmpty.push(solid); }
        finally { disposeWrappers(faces); }
      }
      if (nonEmpty.length !== 1) {
        fail(
          nonEmpty.length
            ? IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.ambiguousProvenance
            : IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.missingProvenance,
          'Imported topology carrier must contain exactly one non-empty source solid.',
          { reason: 'carrier-source-solid-count', candidateCount: nonEmpty.length },
        );
      }
      return nonEmpty[0].clone();
    } finally {
      disposeWrappers(solids);
    }
  }

  function discoverMarkers(carrier) {
    const markers = [];
    const shells = exactSubshapes(carrier, 'shell');
    const wires = exactSubshapes(carrier, 'wire');
    try {
      for (const shell of shells) {
        const slot = markerSlot(shell, 'face');
        if (slot == null) continue;
        markers.push({ slot, envelopeKind: 'shell', marker: shell.clone() });
      }
      for (const wire of wires) {
        const slot = markerSlot(wire, 'edge');
        if (slot == null) continue;
        markers.push({ slot, envelopeKind: 'wire', marker: wire.clone() });
      }
      return markers.sort((left, right) => left.slot - right.slot);
    } finally {
      disposeWrappers(shells);
      disposeWrappers(wires);
    }
  }

  function disposeMarkers(markers) {
    for (const entry of markers || []) safeDelete(entry?.marker);
  }

  function restore({ sourceBrep, registry, expectedRegistryRef = null }) {
    if (typeof sourceBrep !== 'string' || !sourceBrep.length) {
      fail(
        IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.invalidInput,
        'Imported topology restore requires canonical source BREP text.',
        { reason: 'missing-source-brep' },
      );
    }
    validateRegistry(registry);
    validateExpectedReference(registry, expectedRegistryRef);
    let carrier = null;
    let body = null;
    let markers = [];
    const bodyTables = { faces: [], edges: [], vertices: [] };
    const names = { faces: [], edges: [], vertices: [] };
    try {
      carrier = rc.deserializeShape(registry.carrierBrep);
      body = bodyFromCarrier(carrier, registry);
      if ((registry.nameMode || 'opaque-import-v1') === 'opaque-import-v1') validateSolid(body, 'restore');
      else validateOneSolidRoot(body, 'restore');
      const restoredEvidence = canonicalBrep(body);
      if (restoredEvidence !== sourceBrep) {
        const firstDifference = firstBrepDifference(sourceBrep, restoredEvidence);
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.sourceMismatch,
          'Imported topology registry does not belong to the exact stored source BREP. '
            + 'First differing BREP line: ' + String(firstDifference.line ?? 'unknown') + '.',
          {
            reason: 'full-canonical-brep-evidence-mismatch',
            expectedBytes: sourceBrep.length,
            actualBytes: restoredEvidence.length,
            firstDifference,
          },
        );
      }

      bodyTables.faces = exactSubshapes(body, 'face');
      bodyTables.edges = exactSubshapes(body, 'edge');
      bodyTables.vertices = exactSubshapes(body, 'vertex');
      for (const kind of Object.keys(descriptor)) {
        const info = descriptor[kind];
        if (bodyTables[info.tableKey].length !== registry.topologyCounts[info.tableKey]) {
          fail(
            IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.incompleteCoverage,
            'Imported topology carrier count does not match the persisted registry.',
            {
              reason: 'carrier-topology-count-mismatch',
              topologyKind: kind,
              exactCount: bodyTables[info.tableKey].length,
              registryCount: registry.topologyCounts[info.tableKey],
            },
          );
        }
      }

      const recordBySlot = new Map(registry.entries.map((entry) => [entry.slot, entry]));
      const mappedSlots = new Set();
      markers = discoverMarkers(carrier);
      if (markers.length !== registry.entries.length) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.incompleteCoverage,
          'Imported topology carrier marker count does not match the registry.',
          {
            reason: 'carrier-marker-count-mismatch',
            markerCount: markers.length,
            registryEntryCount: registry.entries.length,
          },
        );
      }

      for (const markerEntry of markers) {
        const { marker, slot, envelopeKind } = markerEntry;
        const record = recordBySlot.get(slot);
        if (!record || mappedSlots.has(slot)) {
          fail(
            record
              ? IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.ambiguousProvenance
              : IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.missingProvenance,
            'Imported topology marker does not resolve to one persisted registry slot.',
            { reason: record ? 'duplicate-carrier-slot' : 'unregistered-carrier-slot', slot },
          );
        }
        const info = descriptor[record.kind];
        const expectedEnvelopeKind = record.kind === 'face' ? 'shell' : 'wire';
        if (envelopeKind !== expectedEnvelopeKind) {
          fail(
            IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.missingProvenance,
            'Imported topology marker envelope does not match its persisted topology kind.',
            {
              reason: 'marker-envelope-kind-mismatch',
              slot,
              topologyKind: record.kind,
              envelopeKind,
            },
          );
        }
        const markerSubshapes = exactSubshapes(marker, record.kind);
        try {
          if (record.kind === 'vertex') {
            const markerEdges = exactSubshapes(marker, 'edge');
            try {
              const sourceEdgeCount = bodyTables.edges.filter((candidate) =>
                markerEdges.some((marked) => marked.wrapped.IsSame(candidate.wrapped))).length;
              if (sourceEdgeCount !== 0) {
                fail(
                  IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.ambiguousProvenance,
                  'An imported vertex marker unexpectedly owns a source edge.',
                  { reason: 'vertex-marker-owns-source-edge', slot, sourceEdgeCount },
                );
              }
            } finally {
              disposeWrappers(markerEdges);
            }
          }
          const matches = bodyTables[info.tableKey].filter((candidate) =>
            markerSubshapes.some((marked) => marked.wrapped.IsSame(candidate.wrapped)));
          if (matches.length !== 1) {
            fail(
              matches.length
                ? IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.ambiguousProvenance
                : IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.missingProvenance,
              'Imported topology marker does not own exactly one exact source subshape.',
              {
                reason: 'marker-exact-subshape-count',
                slot,
                topologyKind: record.kind,
                candidateCount: matches.length,
              },
            );
          }
          names[info.tableKey].push({ name: record.name, [info.wrapperKey]: matches[0].clone() });
          mappedSlots.add(slot);
        } finally {
          disposeWrappers(markerSubshapes);
        }
      }

      if (mappedSlots.size !== registry.entries.length) {
        fail(
          IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.incompleteCoverage,
          'Imported topology carrier did not restore every persistent registry entry.',
          { reason: 'not-every-registry-slot-restored', restoredCount: mappedSlots.size, entryCount: registry.entries.length },
        );
      }
      for (const kind of Object.keys(descriptor)) {
        const info = descriptor[kind];
        const candidates = bodyTables[info.tableKey];
        const table = names[info.tableKey];
        const ownershipCounts = candidates.map((candidate) => table.filter((entry) =>
          entry[info.wrapperKey].wrapped.IsSame(candidate.wrapped)).length);
        const missingCount = ownershipCounts.filter((count) => count === 0).length;
        const ambiguousCount = ownershipCounts.filter((count) => count > 1).length;
        if (missingCount || ambiguousCount || table.length !== candidates.length) {
          fail(
            ambiguousCount
              ? IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.ambiguousProvenance
              : IMPORTED_TOPOLOGY_REGISTRY_ERROR_CODES.incompleteCoverage,
            'Imported topology registry does not cover every exact source subshape one-to-one.',
            {
              reason: 'exact-source-coverage-failed',
              topologyKind: kind,
              exactCount: candidates.length,
              namedCount: table.length,
              missingCount,
              ambiguousCount,
            },
          );
        }
      }
      const resultShape = body;
      body = null;
      return {
        shape: resultShape,
        names,
        diagnostics: [],
        registryId: registry.registryId,
        sourceEvidence: sourceBrep,
      };
    } catch (error) {
      disposeTables(names);
      throw error;
    } finally {
      for (const key of ['faces', 'edges', 'vertices']) disposeWrappers(bodyTables[key]);
      disposeMarkers(markers);
      safeDelete(body);
      safeDelete(carrier);
    }
  }

  function disposeTables(tables) {
    for (const kind of Object.keys(descriptor)) {
      const info = descriptor[kind];
      for (const entry of tables?.[info.tableKey] || []) safeDelete(entry?.[info.wrapperKey]);
    }
  }

  function disposeOutcome(outcome) {
    disposeTables(outcome?.names);
    safeDelete(outcome?.shape);
  }

  return Object.freeze({
    capture,
    captureNamed,
    restore,
    canonicalBrep,
    exactFaces: (shape) => exactSubshapes(shape, 'face'),
    exactEdges: (shape) => exactSubshapes(shape, 'edge'),
    exactVertices: (shape) => exactSubshapes(shape, 'vertex'),
    disposeWrappers,
    disposeTables,
    disposeOutcome,
  });
}
