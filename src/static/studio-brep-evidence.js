// Canonical, test-only OCCT BREP evidence.
//
// A normal OCCT BREP serialization may contain derived triangulations and
// transient TopoDS bookkeeping flags. Those depend on whether a shape has
// already been rendered or checked, so comparing the raw text would compare
// cache history rather than the exact boundary representation. This helper
// round-trips into a detached shape, removes only derived polygonal data,
// clears the three transient flags, and serializes the result. Geometry,
// topology, orientation, locations, tolerances, curves, and surfaces remain
// untouched and therefore remain byte-for-byte acceptance evidence.

export const STUDIO_BREP_EVIDENCE_VERSION = 1;

const TOPOLOGY_KINDS = Object.freeze([
  'TopAbs_COMPOUND',
  'TopAbs_COMPSOLID',
  'TopAbs_SOLID',
  'TopAbs_SHELL',
  'TopAbs_FACE',
  'TopAbs_WIRE',
  'TopAbs_EDGE',
  'TopAbs_VERTEX',
]);

function resetTransientFlags(topology) {
  // Free, Modified, and Checked are mutable OCCT bookkeeping state. The other
  // serialized flags (Orientable, Closed, Infinite, Convex) describe topology
  // and intentionally remain part of the exact evidence.
  topology.Free_2(false);
  topology.Modified_2(false);
  topology.Checked_2(false);
}

function normalizeDetachedShape(oc, wrapped) {
  oc.BRepTools.Clean(wrapped, true);
  resetTransientFlags(wrapped);
  for (const kind of TOPOLOGY_KINDS) {
    const explorer = new oc.TopExp_Explorer_2(
      wrapped,
      oc.TopAbs_ShapeEnum[kind],
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    try {
      while (explorer.More()) {
        const current = explorer.Current();
        try { resetTransientFlags(current); }
        finally { current.delete(); }
        explorer.Next();
      }
    } finally {
      explorer.delete();
    }
  }
}

export function canonicalStudioBrepEvidence(rc, shape) {
  if (!rc?.deserializeShape || !rc?.getOC || !shape?.serialize) {
    throw new TypeError('Canonical BREP evidence requires an initialized replicad shape.');
  }
  const detached = rc.deserializeShape(shape.serialize());
  try {
    normalizeDetachedShape(rc.getOC(), detached.wrapped);
    return detached.serialize();
  } finally {
    detached.delete();
  }
}
