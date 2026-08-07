# Drawing standards, layers, and line fonts

PartMode stores drawing-output controls in the project-owned `partmode.drawing-standards/v1` extension. Open **Output > PDF / Print** to choose an ISO, ANSI, or DIN profile for each sheet, control its drawing layers, and create reusable custom line fonts.

The three built-in profiles are bounded PartMode profiles for the named standards families. They provide deterministic line widths, dash patterns, colors, and template choices; they are not a claim that a completed drawing has passed a standards-compliance review. Projection angle remains an explicit sheet-format property instead of being inferred from the selected profile.

## Layers

Every styled sheet owns the same seven stable semantic layers:

- border and title block;
- visible geometry;
- hidden geometry;
- tangent edges;
- dimensions;
- annotations and balloons;
- tables and BOM.

Each layer has independent visible and printable states plus a line-font reference. PDF output requires both states before emitting that layer. Applying a profile resets all seven layers to that profile's defaults. Deleting a sheet removes its authored layer state.

## Line fonts

A custom line font has a stable `line-font-000001` identity, a unique name, a width from 0.05 through 2 mm, an optional even-length on/off dash pattern, and an RGB color with each channel from 0 through 1. A project supports at most 100 custom line fonts. Deleting a line font that is assigned to a layer fails closed.

The vector PDF writer converts authored millimetre widths and dash lengths to PDF points. It records the resolved profile, all seven layers, and their exact line-font values in each page manifest.

## Typed operations

- `drawing.standard.apply`
- `drawing.layer.update`
- `drawing.lineFont.create`
- `drawing.lineFont.update`
- `drawing.lineFont.delete`

All operations are atomic, preserve source immutability, and travel through canonical project save/reopen.

## Acceptance boundary

`smoke:drawing-standards` drives the production OpenCascade hidden-line worker and the production multi-page PDF writer. It proves independent ISO, ANSI, and DIN pages, exact layer suppression, custom width/dash/color commands, deterministic bytes, canonical save/reopen, typed entities, visible controls, and fail-closed invalid input.
