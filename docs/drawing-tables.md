# Associative drawing tables

PartMode stores cut lists, hole tables, weld tables, and revision tables in the project-owned `partmode.drawing-tables/v1` extension. Open **Output > PDF / Print** to add, update, or delete tables on the active sheet. Each table retains a stable identity, sheet position, width, and unique name across canonical save and reopen.

## Table kinds

- A cut list references 1 through 50 persistent part-body identities and an X, Y, or Z length axis. PDF generation resolves quantity and length from the current exact B-rep bounds. A missing body, non-solid result, or stale exact result stops output instead of emitting an estimated length.
- A hole table references 1 through 100 persistent Hole Wizard features. It resolves the stored exact standard recipe into tag, X/Y center, and clearance, counterbore, countersink, or tapped-hole callout rows. Arbitrary circular cuts are not represented as Hole Wizard holes.
- A weld table references 1 through 100 persistent modeled weld-bead features. PDF generation resolves each bead's two persisted support edges from current exact topology, proves that they still describe the same straight seam, and verifies the current bead volume against `0.5 × equal leg size² × seam length`. Rows report the current modeled length and volume; authored totals are not accepted as evidence.
- A revision table stores 1 through 100 unique revision identifiers with description, real `YYYY-MM-DD` date, and approver. These rows are controlled document records; they are not inferred from Git or browser history.

A project supports 60 total drawing tables. Deleting a sheet removes its tables. Deleting or replacing a referenced model source makes output fail closed until the table reference is repaired or removed.

## Typed operations

- `drawing.table.create`
- `drawing.table.update`
- `drawing.table.delete`

The visible table manager and the headless agent use the same atomic operations. The canonical entity graph exposes every persisted table as a `drawing-table` entity.

## Output and evidence boundary

The multi-page PDF writer resolves model-derived tables only from a successful `drawing-v5` result carrying `occt-hlr-exact` projection evidence whose document hash matches the project being printed. Cut-list lengths additionally require current B-rep-valid single-solid evidence for every referenced body. Weld tables require current valid one-solid bead and source-body evidence, exact named LINE endpoints and lengths, and an exact analytic-volume match. Tables render as deterministic vector grids and text on the controlled tables layer, and their resolved rows and evidence are recorded in the PDF manifest.

`smoke:drawing-tables` proves persistent typed authoring, canonical save/reopen, exact cut length updating from 20 to 30 mm after a valid rebuild, an M6 counterbore callout, controlled revision rows, deterministic PDF bytes, sheet-deletion cleanup, and fail-closed missing or stale references. `smoke:weld-beads` adds exact modeled weld rows, current seam-length updates, deterministic PDF output, and independent Poppler validation.

General BOM rows already resolve from exact assembly occurrence evidence. Assembly cut-list aggregation, weldment-specific cut lists, automatic geometric hole recognition, and arbitrary user-defined table formulas remain outside this slice.
