# Modeled weld beads

PartMode weld beads are persistent `weld-bead` features backed by the
`partmode.weld-bead/v1` recipe. They consume two exact
`partmode.structural-member/v1` bodies and create a separate exact solid in the
production OpenCascade worker. The viewport mesh is only a projection of that
result; it is not completion evidence.

## Delivered operation

Choose **3D Tools > Weld bead** after selecting one named planar face and one
named straight edge on each of two distinct structural-member bodies. Capture
the four selections, then author an equal leg size and optional process label.
The delivered slice models one continuous, straight, equal-leg, 90-degree
fillet bead.

The feature persists both member identities, both created-body identities, and
both face/edge pairs as canonical topology references. Its result body has a
stable identity. Name, leg size, and process may be edited; support associations
are immutable so an edit cannot silently retarget deposited material to another
joint. Delete and recreate the bead to choose different supports.

A support member or body cannot be deleted while a bead depends on it. A bead
referenced by a drawing weld table cannot be deleted until that table is
removed. Generic feature/body mutation paths refuse the typed bead lifecycle.

## Exact evidence and refusal boundary

Before publishing geometry, the worker requires both selected edges to remain
incident to their selected exact planar faces, to resolve to the same endpoint
pair and positive length, and to lie on perpendicular support planes. The two
source solids must touch without volumetric overlap. Both bead toes must remain
inside the bounded support faces.

The accepted result is one triangular-prism solid with 5 faces, 9 edges, and 6
vertices. Its exact volume must equal `0.5 × leg size² × current seam length`.
The bead must contact both source bodies without being embedded in either one,
and every face, edge, and vertex must retain a unique persistent name. Exact
intersection checks use private B-rep operands so evidence gathering cannot
mutate the cached source members.

Missing or ambiguous topology, a curved or detached seam, non-perpendicular
supports, overlapping sources, out-of-bounds toes, invalid dimensions, stale UI
previews, and tampered recipes fail without publishing bead geometry.

This bounded operation does not claim intermittent or multi-segment beads,
curved seams, unequal-leg, convex, or concave profiles, groove, plug, or slot
welds, assembly welds, automatic joint inference, process simulation, standards
certification, or manufacturing suitability.

## Weld tables

An associative drawing weld table references 1 through 100 weld-bead feature
identities. During PDF generation it requires current document-hash-bound exact
drawing evidence, resolves both persisted support edges from exact topology,
recomputes their shared seam length, and verifies the current bead body's exact
volume against the fillet formula. Its rows contain item, bead name, type, size,
current length, authored process label, and modeled volume. A copied authored
total, stale worker result, or missing source stops output.

Run the focused gates after `npm run build`:

```text
npm run smoke:weld-beads
npm run smoke:weld-beads-ui
```

The exact gate exercises typed lifecycle, canonical save/reopen, current-hash
production rebuilds, associative support edits, fresh-worker determinism,
derived weld-table rows, deterministic PDF bytes, independent Poppler
validation, and fail-closed tamper cases. The UI gate uses real Chrome to
exercise the shipped selection, create, edit, Cancel, delete, and table paths.
