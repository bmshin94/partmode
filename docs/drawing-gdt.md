# Drawing GD&T reference records

PartMode stores datum symbols, feature-control frames, and tolerance stacks in the project-owned `partmode.drawing-annotations/v1` graph. Open **Output > PDF / Print > GD&T and tolerance stacks** to author and manage the same records used by the typed transaction API and deterministic PDF writer.

## Datums and feature-control frames

A datum symbol stores its sheet, exact view, one selected persistent face, edge, or vertex reference, a 1 to 3 letter identifier, and its sheet label position. Identifiers exclude I, O, and Q and must be unique on a sheet.

A feature-control frame stores one persistent exact topology reference, one of 12 controlled geometric characteristics, a positive millimetre tolerance, optional diameter-zone semantics, regardless-of-feature-size, maximum-material, or least-material condition, up to three ordered datum-symbol record IDs, and its label position. Every referenced datum must exist on the same sheet. Deleting a datum that is still in use fails closed.

The production `drawing-v5` worker provides current `partmode.drawing-topology-evidence/v1` records for exact bodies. Datum and frame resolution requires document-hash-bound `occt-hlr-exact` evidence and exactly one current topology match for the stored body, kind, and kernel-owned persistent name. The current three-dimensional representative point is projected through the selected exact view. Missing bodies, missing or ambiguous topology names, missing datum records, and stale drawing evidence fail closed. There is no proximity, signature, or traversal-order fallback.

The PDF writer emits vector datum leaders and boxed identifiers plus boxed feature-control-frame cells. The page manifest retains the exact reference, current three-dimensional point, projection frame, document hash, authored characteristic, tolerance, material condition, and resolved datum identifiers.

## Controlled tolerance stacks

A tolerance stack stores 2 to 50 terms. Each term has a label, nominal millimetre value, non-negative plus and minus tolerances, and a positive or negative contribution direction. Resolution publishes nominal, worst-case minimum and maximum, worst-case plus and minus, and root-sum-square values. PDF output renders the authored terms and calculated results in a bounded vector table. Unsafe sheet placement fails closed instead of clipping or moving the table silently.

## Acceptance boundary

`smoke:drawing-gdt` discovers two exact named plate faces, creates datum A and datum B, authors a position frame with a 0.1 mm diameter zone at maximum material condition relative to A and B, and evaluates a three-term tolerance stack. The expected 90 mm nominal, 89.75 to 90.35 mm worst-case limits, minus 0.25 mm, plus 0.35 mm, and 0.229128785 mm RSS values appear in deterministic PDF bytes and manifest evidence. Typed create, update, and delete plus canonical save and reopen also pass.

This is controlled ASME Y14.5 reference vocabulary and deterministic document behavior, not certification that a finished drawing or manufactured part complies with ASME Y14.5. Composite frames, projected tolerance zones, datum targets, movable datum modifiers, statistical distributions beyond bounded RSS, automatic tolerance analysis from model dimensions, and standards conformance checking remain outside this slice.
