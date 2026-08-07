# DXF export and import (partmode.dxf/v1)

PartMode writes and reads deterministic DXF R12 (`$ACADVER` `AC1009`) ASCII
files through the source-owned `partmode.dxf/v1` module in
`src/static/studio-drawing-dxf.js`. Two exports and one import exist in this
slice:

- **Drawing sheet export** (`createStudioDrawingDxf`): the exact OCCT
  hidden-line projection paths of the generic four-view sheet, reachable
  through the visible **Output > DXF** button and the typed `drawing-dxf`
  artifact format.
- **Sketch profile export** (`createStudioSketchDxf`): one solved
  constraint-native sketch, reachable through the typed `sketch-dxf` artifact
  format with a `sketchFeatureId`.
- **Sketch profile import** (`importStudioSketchDxf`): DXF R12 ASCII in
  millimetres becomes one first-class constraint-native sketch, reachable
  through the visible **Open** file input (`.dxf`), the typed
  `sketch.importDxf` operation, and the typed `dxf` import format.

Both typed export formats sit under the existing `artifact.export-drawing`
permission; the import mutates the active document and sits under
`project.edit`. **DWG** in either direction and DXF **R13+** are explicit
exclusions of this slice.

## File contract

- ASCII DXF with LF newlines, one trailing newline, no user-controlled text.
- Leading `999` comments declare the schema, content kind, millimetre units,
  the active spline policy, and (for sheets) the documented per-view offsets.
- `HEADER` carries `$ACADVER`, `$INSBASE`, and exact `$EXTMIN`/`$EXTMAX`
  drawing extents. Extents for arcs use the conservative full-circle box.
- `TABLES` declares `CONTINUOUS` and `DASHED` linetypes plus only the layers
  actually used.
- Entity vocabulary is exactly `LINE`, `ARC`, `CIRCLE`, and `LWPOLYLINE`.
  Coordinates are millimetres rounded deterministically at 1e-6 mm; arcs are
  DXF-conventional counterclockwise start/end angles in degrees.
- Bounded limits fail closed: at most 20,000 entities and 8 MiB of output;
  drawing input is bounded to 100,000 exact paths and 16 MiB of path text.

## Drawing sheet mapping

The writer requires a successful `drawing-v5` result with
`occt-hlr-exact` evidence and exactly the four standard views (front, top,
right, iso), then emits the three orthographic views. The pictorial iso view
is an explicit exclusion: it projects circular model edges as elliptical
arcs, and DXF R12 has no exact ellipse entity, so including it would force a
silent approximation. Views keep their exact unscaled model-space millimetre
coordinates: the SVG y axis is mirrored back to the model y axis, then each
view is translated by a documented third-angle offset (front untranslated,
top one 20 mm gap above, right one gap to the right). The offsets are
repeated in the `999` comments so a consumer can recover raw projection
coordinates. Visible edges land on `PM-FRONT`/`PM-TOP`/`PM-RIGHT` (color 7,
CONTINUOUS); hidden edges land on the matching `-HIDDEN` layers (color 8,
DASHED).

Exact circular HLR edges become `ARC` entities; closed circular edges (the
worker parameterizes them with a 1e-4 mm closure displacement) become
`CIRCLE` entities. Standards-based persisted drawing sheets (title blocks,
annotations) are not part of the DXF slice; the sheet DXF always carries the
generic four-view geometry.

## Sketch profile mapping

The writer solves the constraint sketch through the production
`solveSketch` path and fails closed unless the solve succeeds. Solved lines,
circles, and arcs become `LINE`, `CIRCLE`, and `ARC` on the `PM-SKETCH`
layer; clockwise arcs are rewritten to the DXF counterclockwise convention.
Construction geometry and free points are excluded. Sketches whose arcs are
not exactly circular, empty sketches, and unsolved sketches fail closed.

## Spline policy

The default policy is `fail`: quadratic/cubic Bezier projection spans and
sketch splines fail closed with `DXF_UNSUPPORTED_CURVE` instead of being
approximated silently. Elliptical projection edges always fail closed; DXF
R12 has no exact ellipse entity and no tessellation policy covers them.

The documented opt-in policy `tessellate-v1` converts only spline classes to
`LWPOLYLINE`:

- drawing Bezier spans: 32 uniform parameter samples per span;
- sketch splines: the solver's own Catmull-Rom sampler
  (`sampleSplineThrough`) at 16 steps per segment, emitted closed when the
  spline closes.

`LWPOLYLINE` post-dates strict AutoCAD R12; it is emitted only under this
explicit policy and is a documented deviation accepted by mainstream readers.
With the default policy the output is strict R12.

## Sketch import mapping

`importStudioSketchDxf` reads DXF R12 ASCII text and fails closed on
everything outside its documented subset:

- The entity vocabulary is exactly `LINE`, `ARC`, `CIRCLE`, and straight
  `LWPOLYLINE`; any other entity (legacy `POLYLINE`, `SPLINE`, `ELLIPSE`,
  `INSERT`, `TEXT`, ...) fails closed with `DXF_IMPORT_UNSUPPORTED_ENTITY`,
  and `LWPOLYLINE` bulge arcs fail closed with
  `DXF_IMPORT_UNSUPPORTED_CURVE`.
- `$ACADVER`, when present, must be `AC1009`; the binary DXF sentinel and
  every other version (R13 and later) fail closed with
  `DXF_IMPORT_UNSUPPORTED_VERSION`. `$INSUNITS`, when present, must declare
  millimetres (4); anything else fails closed with
  `DXF_IMPORT_UNSUPPORTED_UNITS`, and an absent header means millimetres per
  the file contract.
- Malformed or truncated group-code pairs, group codes outside the
  documented per-entity subset, repeated scalar codes, non-finite or
  out-of-range numbers, nonplanar geometry (nonzero z, elevation, thickness,
  or tilted extrusion direction), degenerate segments, and content after
  `EOF` fail closed with `DXF_IMPORT_INVALID`.
- Bounds fail closed with `DXF_IMPORT_LIMIT_EXCEEDED`: 8 MiB of input text,
  5,000 DXF entities, and 4,096 vertices per polyline.
- Coordinates land as authored sketch entities (lines, circles,
  counterclockwise arcs) with **no inferred constraints**; the only inferred
  relationship is that coincident curve endpoints within the exact
  0.0001 mm tolerance merge into one shared sketch point. Arc and circle
  centers always stay independent points.
- The importer re-solves the resulting sketch through the production
  `solveSketch` path and fails closed with `DXF_IMPORT_UNSOLVED` unless the
  settled geometry stays within the same tolerance of the authored
  coordinates.

The visible **Open** file input accepts `.dxf` and lands the profile in the
active part as one first-class constrained sketch through the ordinary typed
`sketch.importDxf` operation (also available to agents through `cad_commit`
transactions). The chunked typed import path accepts format `dxf` alongside
`project` and `step`; unlike those formats it mutates the active project
under `project.edit` instead of replacing it under `project.replace`.

## Acceptance gate

`npm run smoke:drawing-dxf` (`scripts/studio-drawing-dxf-smoke.ts`) builds an
exact HLR drawing and a solved sketch, parses the emitted DXF with an
independent minimal parser defined inside the gate, and re-derives every
entity endpoint against the exact source geometry, including a radius-5
model-truth circle and notch arc, arc direction conventions, extents, byte
determinism, and sixteen fail-closed export cases. The import half
round-trips the exported sketch DXF through `importStudioSketchDxf` back to
byte-identical DXF with zero inferred constraints, proves benchmark B4
step 4 by importing a foreign-authored CRLF profile (closed LWPOLYLINE
rectangle plus hole circle) and extruding it through the typed operations to
the closed-form exact volume, covers twenty-two typed fail-closed import
cases plus the coincidence-tolerance boundary, and uploads a real `.dxf`
through the visible file input in headless Chrome, including an atomic typed
rejection.
