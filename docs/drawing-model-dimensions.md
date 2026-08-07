# Imported model dimensions

PartMode can import a bounded set of driving feature dimensions into an exact drawing sheet. Each imported dimension is a persistent `model-dimension` record in the project-owned `partmode.drawing-annotations/v1` graph and uses the typed `drawing.annotation.create`, `drawing.annotation.update`, and `drawing.annotation.delete` lifecycle.

Open **Output > PDF / Print > Imported model dimensions** to select the active sheet, an exact view, a persistent feature ID, the driving field, two projection endpoints, and a sheet label position.

## Supported model sources

- `h` imports the depth of an unsuppressed Extrude or bounded Cut. Through All cuts do not expose a finite driving depth and are rejected.
- `r` imports the radius of an unsuppressed Fillet or Chamfer.
- `t` imports the thickness of an unsuppressed Shell.

The record preserves the authored number or expression. PDF resolution evaluates that expression with the same safe parameter, units, functions, comparison, and arithmetic grammar used by the production kernel. Project and part parameters retain the same shadowing and cyclic-reference behavior. A parameter edit therefore changes the displayed value without replacing the imported-dimension record.

## Exact evidence and output

Resolution requires a successful current `drawing-v5` result with `occt-hlr-exact` evidence. The document hash must match the project being printed, the selected exact view must still exist, and both authored endpoints must remain inside its projection bounds. The deterministic PDF writer draws extension lines, a dimension line, arrowheads, and the resolved feature name, semantic field, value, and millimetre unit through the controlled dimensions layer.

Each resolved PDF manifest record retains the persistent feature and field, authored expression, resolved value and unit, exact view frame, and current document hash. Missing, suppressed, incompatible, non-positive, unevaluable, collapsed, out-of-view, non-exact, or stale sources fail closed.

## Acceptance boundary

`smoke:drawing-model-dimensions` proves typed create/update/delete, canonical save/reopen, full expression evaluation, two production exact drawings, a typed `stock` parameter edit that changes the imported Plate depth from 20 to 30 mm, deterministic PDF bytes, source evidence, visible registered controls, and the fail-closed cases above.

The two extension endpoints are authored coordinates in one exact projection. This slice does not claim topology-associative user placement, automatic dimension import, assembly-occurrence dimensions, angle dimensions, tolerances, dual units, or standards certification. Topology-associative user-placed dimensions remain tracked separately under `PM-PAR-DR-005`.
