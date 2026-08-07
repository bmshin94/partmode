# Exact A4 drawing SVG

PartMode exports one deterministic A4 landscape SVG through **Output > Drawing SVG** and the typed artifact API. The source-owned `partmode.drawing-svg/v1` writer consumes the production `drawing-v5` result and requires exact OpenCascade hidden-line evidence.

## Sheet contract

The generic sheet is 297 by 210 millimetres in third-angle projection. It contains exact front, top, right, and isometric views at one fitting standard scale plus three automatic overall dimensions: front width, front height, and top depth. Assembly output retains exact-projection BOM rows and automatic balloons.

The writer escapes user-facing text, bounds path payloads to 100,000 paths and 16 MiB of path data, and bounds BOM and balloon payloads to 100 records each. Missing exact evidence, incomplete or duplicated view sets, invalid bounds, empty visible paths, and over-limit payloads fail closed.

## Boundary

The three overall dimensions are generated from exact projection bounds. They are not user-placed associative dimensions and do not close DR-005. Project-owned general annotations and manufacturing symbols are available in persisted PDF drawing sets.
