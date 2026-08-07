# Named and aligned drawing views

PartMode stores arbitrary projection frames in the project-owned `partmode.drawing-views/v1` extension. Open **Output > PDF / Print** to add, edit, or delete a named view. A named view has a stable id, unique name, normalized direction, and an orthogonal normalized sheet x-axis.

## Exact projection

The drawing worker passes each authored frame to an OpenCascade `ProjectionCamera` and runs exact hidden-line removal against the current B-rep. Editing the frame changes the exact projection on the next rebuild. A named view that is referenced by a sheet cannot be deleted.

Standard front, top, right, left, bottom, back, and isometric views use the same exact path. A request is bounded to 16 unique projections, and every requested projection must succeed. The worker no longer silently drops a failed view.

## Alignment

A sheet can store a bounded acyclic alignment graph. A horizontal relation keeps the two view centers on the same sheet y-coordinate and places the child to the right at the authored gap. A vertical relation keeps the centers on the same sheet x-coordinate and places the child above the parent at the authored gap.

Each child has one parent, and one parent can have at most one child for each axis. Gaps range from 2 through 100 millimetres. Fit chooses the largest standard scale whose complete aligned graph fits the sheet; explicit scales fail if the graph does not fit.

## Tangent-edge display

The exact HLR pass keeps ordinary and outline edges separate from OpenCascade `Rg1` tangent-continuity edges. Each sheet chooses one display mode:

- Visible emits tangent edges with the ordinary visible or hidden line style.
- Removed omits tangent edges while retaining ordinary and silhouette edges.
- Phantom emits tangent edges with a separate long-short phantom line font.

These are exact B-rep edge classes, not classifications inferred from a display mesh.
