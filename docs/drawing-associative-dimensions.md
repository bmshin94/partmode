# Topology-associative placed dimensions

PartMode stores user-placed drawing dimensions as persistent `associative-dimension` records in the project-owned `partmode.drawing-annotations/v1` graph. Open **Output > PDF / Print > Associative placed dimensions** to capture exactly two selected model subshapes, choose projected distance, horizontal distance, or vertical distance, select an exact drawing view, and set the dimension label position.

The visible capture action accepts persistently named faces, edges, and vertices. Each stored reference contains the owning body ID, exact topology kind, and the kernel-owned persistent name. It never stores a display hash as semantic identity.

## Exact resolution

The production `drawing-v5` worker publishes bounded `partmode.drawing-topology-evidence/v1` evidence for each visible exact part body. The evidence includes current one-to-one persistent names, exact representative points, separate topology-signature snapshots, and named and total topology counts. Face references measure from the exact face center, edge references from the exact curve midpoint, and vertex references from the exact OCCT point.

PDF generation requires current `occt-hlr-exact` evidence whose document hash matches the project. Both stored names must resolve exactly once on their owning current bodies. Their current three-dimensional points are projected through the selected exact view frame, then the chosen projected distance is evaluated. The controlled dimensions layer renders extension lines, a dimension line, arrowheads, and the resolved millimetre value. The page manifest retains the references, current 3D points, exact frame, resolved value, and document hash.

Missing or suppressed bodies, duplicate references, missing or ambiguous names, absent exact topology evidence, a collapsed projection, and stale drawing revisions fail closed. There is no proximity, display-hash, geometry-signature, or traversal-order fallback.

## Acceptance boundary

`smoke:drawing-associative-dimensions` discovers two exact named corner vertices on a 40 by 30 by 20 mm plate, captures and persists them, and proves typed create/update/delete plus canonical save/reopen. A typed history edit raises the plate from 20 to 30 mm and adds an exact M6 through hole. Exact topology changes from 6 faces, 12 edges, and 8 vertices to 7 faces, 15 edges, and 10 vertices while every subshape remains named. The two stored vertex names still resolve one-to-one, their front-view endpoint moves from -20 to -30 mm, and the placed dimension updates from 20 to 30 mm in deterministic PDF bytes and manifest evidence.

This bounded slice supports linear projected distances between two exact face, edge, or vertex reference points. Radius, diameter, angle, ordinate, arc-length, chained/baseline, tolerance, dual-unit, and assembly-occurrence dimensions remain outside this slice. Standards certification and automatic dimension layout are also not claimed.
