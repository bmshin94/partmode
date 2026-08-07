# Drawing sets

PartMode stores a drawing set in the project-owned `partmode.drawing-book/v1` extension. Open **Output > PDF / Print** to initialize the set, add or remove sheets, choose the active sheet, edit a sheet, or reorder the set. Download and print use the same ordered multi-page PDF. ISO, ANSI, and DIN profile, layer, and line-font controls are documented in [Drawing standards](./drawing-standards.md). Notes, balloons, revision clouds, and reusable blocks are documented in [Drawing annotations](./drawing-annotations.md). Hole callouts, center marks, centerlines, weld symbols, and surface-finish symbols are documented in [Manufacturing drawing symbols](./drawing-symbols.md). Cut lists, Hole Wizard schedules, and revision tables are documented in [Associative drawing tables](./drawing-tables.md).

## Formats and sizes

Reusable formats include ISO A4, A3, and A2 landscape sheets, ANSI A and B landscape sheets, and DIN A4 and A3 landscape sheets. A custom format accepts dimensions from 100 through 2,000 millimetres and retains its name, standard label, size label, projection convention, and title-block identity across canonical save and reopen.

Each sheet has a unique stable identity and name. A drawing set contains 1 through 20 sheets, retains exactly one active sheet, rejects duplicate names, and cannot delete its final sheet.

## Views and scales

Each sheet selects 1 through 16 exact standard or named hidden-line views. Standard choices are front, top, right, left, bottom, back, and isometric. Project-owned named views add an arbitrary normalized direction and orthogonal sheet x-axis. PDF generation requests the union once from the production `drawing-v5` worker, then fails closed if any sheet view is absent. It does not substitute screenshots or sampled geometry.

Schema-5 part drawings can also place project-owned derived views. Full sections retain one authored exact half-space and orient the delivered camera to the retained cutting plane's normal and x-axis instead of reusing the source camera. Half sections validate one source-normal section plane and one source-axis split plane, bind the split axis, exterior side, and position to those planes, and remove the exact intersection of the two retained-side complements. Aligned sections turn the authored plane order into persistent canonical hinges and disjoint half-space region cells, prove that the exact regional volumes cover the cut body without overlap, rigidly transform every complete regional B-rep into the first plane's frame, compound those regions, and run one final OCCT HLR so silhouettes, hidden edges, and tangent classes unfold with the section contours. Broken-out sections cut a rectangular or circular parent-view profile to a numeric depth measured from the exact B-rep support in the source camera frame. The worker rigidly maps the body into that frame before `BRepBndLib.AddOptimal`, so arbitrary named-view directions do not inherit a projected world-AABB front. Arbitrary sketched profiles and local picked-surface depth origins are outside this slice.

Detail and crop views clip every exact source-HLR edge class against the authored two-dimensional boundary without changing the model B-rep or introducing cut faces; detail magnification is applied after clipping. Auxiliary views derive their camera from one uniquely resolved persistent planar-face name. Break views likewise leave the B-rep unchanged: they clip the source HLR into two authored bands and apply the exact recorded two-dimensional translation to the second band.

Every derived result carries `partmode.drawing-derived-view-evidence/v1`, bound to the current canonical document hash, persistent source frame, and definition hash. Section evidence includes OCCT intersection edge counts, valid result topology and volumes, generated-face filtering, and hashes and bounds for the closed exact section contours used for deterministic PDF hatching. Aligned evidence additionally binds canonical joints, non-overlapping region ownership, source and transformed region B-reps, rigid 4×4 matrices, pre-unfold paths, and final compound-HLR paths; unchanged object HLR fails closed. Broken-out evidence binds the rigid camera-frame transform, exact front and end depths, persisted numeric depth, cutter interval, and generated end plane; PDF validation independently enforces `end = front + depth`. Detail, crop, and break evidence records the source and result path mappings for every HLR edge class. A missing face, forged source camera, non-intersecting cutting plane or broken-out profile, empty clip or retained band, unchanged section Boolean, invalid B-rep, stale hash, incomplete aligned partition, non-rigid transform, or incomplete requested view fails the complete drawing request.

Sheets can align views horizontally or vertically with an exact authored gap. Alignment graphs reject cycles, duplicate children, and ambiguous parent-axis branches. Tangent edges can be visible, removed, or emitted with a phantom line font from exact OCCT regularity classes.

A sheet can use Fit or an explicit standard scale from 10:1 through 1:100. Fit chooses the largest supported scale that fits that sheet. An explicit scale that does not fit is rejected rather than silently reduced.

## Typed operations

The visible manager and headless agent route through the same atomic operations:

- `drawing.book.initialize`
- `drawing.sheet.create`
- `drawing.sheet.update`
- `drawing.sheet.delete`
- `drawing.sheet.activate`
- `drawing.sheet.reorder`
- `drawing.derivedView.create`
- `drawing.derivedView.update`
- `drawing.derivedView.delete`

The canonical entity graph exposes every persisted sheet as a `drawing-sheet` entity. Operations are non-mutating until their transaction commits, and malformed formats, unsupported views, incomplete orders, missing references, and invalid scale requests fail closed.

## Current boundary

Derived views currently use standard or named ordinary views as their persistent source; derived-to-derived chains are intentionally rejected. Persistence and exact execution are restricted to schema-5 part documents, while solved assembly drawing plans continue to use their separate occurrence-aware ordinary-view pipeline. View-bound annotations, associative dimensions, GD&T, and manufacturing symbols currently require an ordinary view so their topology projection cannot silently ignore a derived transform; those capabilities remain separate drawing parity groups.
