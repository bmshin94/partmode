# Drawing annotations and reusable blocks

PartMode stores authored annotations in the project-owned `partmode.drawing-annotations/v1` extension. Open **Output > PDF / Print** to add, update, or delete notes, manual balloons, revision clouds, reusable block definitions, and block instances on the active sheet.

The same graph also stores exact-source hole callouts, center marks, centerlines, and authored weld and surface-finish instructions. See [Manufacturing drawing symbols](./drawing-symbols.md) for their projection and evidence boundary.

## Authored annotation kinds

- A note stores bounded printable text, a sheet position in millimetres, and a 5 through 24 point text size. Multi-line notes are preserved.
- A manual balloon stores its anchor in the coordinate frame of one exact sheet view, plus a label position in sheet millimetres. Changing sheet layout moves the anchor with its exact view while retaining the authored label position.
- A revision cloud stores a revision label and a bounded sheet rectangle. The vector PDF writer emits a deterministic scalloped boundary and centered revision label.
- A reusable block stores a stable identity, unique name, printable text, width, and height. Each block instance stores its sheet position and scale. A project supports 50 definitions and 500 total authored annotations.

Automatic assembly balloons remain separate from manual balloons. They continue to require current `occt-hlr-exact` occurrence evidence, while manual annotations remain explicitly authored drawing data.

## Typed operations

- `drawing.annotation.create`
- `drawing.annotation.update`
- `drawing.annotation.delete`
- `drawing.block.create`
- `drawing.block.update`
- `drawing.block.delete`

All operations are atomic and expose persisted annotations and block definitions as typed entities. Deleting a referenced block fails closed. Deleting a sheet removes its authored annotations. Canonical save/reopen preserves every identity and coordinate.

## Output and acceptance boundary

The production multi-page PDF writer resolves the active sheet annotations and emits them through the controlled annotations layer. Hiding or disabling print for that layer suppresses authored notes, manual balloons, revision clouds, reusable blocks, title text, and automatic balloons together.

`smoke:drawing-annotations` drives a solved assembly through the production OpenCascade worker and PDF writer. It proves two automatic exact-evidence balloons plus one note, manual balloon, revision cloud, and block instance; deterministic bytes; exact-view anchor mapping; edits that change output; layer suppression; save/reopen; source-owned UI; and fail-closed invalid references and bounds.
