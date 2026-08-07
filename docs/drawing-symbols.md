# Manufacturing drawing symbols

PartMode stores hole callouts, center marks, centerlines, weld symbols, and surface-finish symbols in the project-owned `partmode.drawing-annotations/v1` graph. Open **Output > PDF / Print** to add, update, or delete these symbols on the active sheet. They use the same typed `drawing.annotation.create`, `drawing.annotation.update`, and `drawing.annotation.delete` operations as general drawing annotations.

## Exact-source symbols

- A hole callout on a root-part drawing references one persistent, unsuppressed Hole Wizard feature and a view on the current sheet. PDF generation projects the stored three-dimensional hole center through the exact worker-supplied projection frame and derives the clearance, tapped, counterbore, or countersink callout from the validated Hole Wizard recipe.
- A center mark references one persistent Hole Wizard feature and resolves the same exact projected center.
- A centerline references exactly two distinct persistent Hole Wizard features. The PDF extends a conventional line through their two current exact projected centers. If the centers collapse in the selected projection, output stops instead of drawing an arbitrary line.

Moving an authored Hole Wizard center changes the resolved callout, center-mark, and centerline anchors after a successful exact rebuild. Missing, suppressed, malformed, or out-of-view sources fail closed.

## Authored manufacturing instructions

- A weld symbol retains an exact-view anchor, a sheet label position, weld type, arrow/other/both-side policy, size, and optional tail. The bounded vocabulary includes fillet, square-groove, V-groove, and plug/slot symbols.
- A surface-finish symbol retains an exact-view anchor, sheet label position, Ra value, material-removal policy, lay, and optional process text.

Weld and surface-finish records are authored drawing instructions. They do not claim that the kernel inferred a weld bead, manufacturing process, or certified standard compliance from geometry.

## Output and acceptance boundary

All five kinds require a successful `drawing-v5` result with current `occt-hlr-exact` evidence, a document hash that matches the project being printed, and a usable exact projection frame. They render as deterministic vector geometry and text through the controlled annotations layer, and each resolved symbol records its evidence in the PDF page manifest.

`smoke:drawing-symbols` proves all five persistent kinds, typed create/update/delete, canonical save/reopen, two production exact drawings, an M6 counterbore center moving from -8,-5 to -4,-5 in the top SVG/PDF projection coordinate system, deterministic PDF bytes, visible source-owned controls, and fail-closed missing, duplicate, suppressed, invalid, or non-exact sources.

Assembly-occurrence hole callouts, automatic circle recognition, weld-bead inference, and standards certification remain outside this bounded slice.
