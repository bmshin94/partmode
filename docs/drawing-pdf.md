# Print-ready drawing PDF

PartMode can download or print one A4 landscape PDF from the same exact OpenCascade hidden-line result used by the SVG drawing sheet. Open **Output > PDF / Print**, choose a sheet scale, then download the PDF or open the native print dialog.

## Scale policy

The Fit option chooses the largest supported standard scale that fits the front, top, right, and isometric layout. Explicit choices are 10:1, 5:1, 2:1, 1:1, 1:2, 1:5, 1:10, 1:20, 1:50, and 1:100.

An explicit scale is never silently reduced. If the exact projection does not fit the fixed A4 sheet at that scale, output fails with `DRAWING_SCALE_DOES_NOT_FIT` and reports the available fit boundary.

## PDF evidence boundary

The `partmode.drawing-pdf/v1` writer consumes exact `drawing-v5` HLR paths. Straight, cubic, quadratic, reflected, and elliptical-arc SVG path commands are emitted as PDF vector paths. The PDF carries an exact 297 by 210 mm MediaBox, Helvetica text, hidden-line dash geometry, overall dimensions, the selected scale, the title block, and assembly BOM and balloon annotations when present.

The writer is deterministic for a fixed drawing result, name, and scale. It validates its source paths and builds a complete PDF 1.7 object table, content stream, cross-reference table, trailer, and producer identity without a remote conversion service.

## Drawing sets

A persisted drawing set can now supply reusable ISO, ANSI, or DIN sheet templates, custom dimensions, ordered multiple sheets, and a standard scale per sheet. Its project-owned drawing-style extension controls semantic layers plus reusable custom line fonts, and the PDF manifest records the resolved profile and exact styles for every page. Project-owned annotations add notes, manual and automatic balloons, revision clouds, reusable blocks, and manufacturing symbols. Project-owned tables add exact-body cut lists, Hole Wizard schedules, and controlled revision records. See [Drawing sets](./drawing-book.md), [Drawing standards](./drawing-standards.md), [Drawing annotations](./drawing-annotations.md), [Manufacturing drawing symbols](./drawing-symbols.md), and [Associative drawing tables](./drawing-tables.md) for the document and output boundaries.

Specialized manufacturing symbols and additional drawing-view types remain separate drawing parity groups.
