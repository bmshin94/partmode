# Configurations and drawings

A part configuration is a named set of parameter overrides stored inside the project. The active configuration drives rebuild, validation, inspection, drawing generation, STEP, STL, AMF, and 3MF export, and pattern freezing through the same effective document.

## Switch configuration as a person

1. Choose {{ux-path:configurations.existing-editor}}.
2. Choose a configuration from the design table.
3. Wait for the local kernel and document revision to settle.
4. Inspect the dimensions and exact body state.
5. Choose {{ux-path:drawing.existing-editor}} for the drawing, or use the other exact export label shown in **Output**. Output also exports STEP, STL, AMF, 3MF, or the Project file.

The exported artifact records the active configuration and effective-document evidence. Switching back to the same configuration must reproduce the same canonical document and exact geometry for unchanged inputs.

## Switch configuration and export as an agent

1. Read `partmode://help/agent-workflow`.
2. Connect to a visible, browser-approved PartMode tab containing the configured
   project. The public headless API cannot currently import that browser project
   or template, or create a configuration table.
3. Call `cad_capabilities` and use only operations and artifacts advertised by
   that live build.
4. Preview a `configuration.activate` operation with the target configuration ID.
5. Commit the exact preview after approval, then inspect the settled configuration and geometry.
6. In a browser session, call `cad_artifact` for `drawing-svg` or another
   advertised format. Artifact generation uses the settled project revision and
   active effective document.

Do not edit individual table-driven parameters as a substitute for activating a configuration unless the document explicitly supports that workflow.

A server-headless session can author supported typed geometry in its own durable
document and use `partmode_headless_export_step` for exact STEP. It cannot
currently import a configured browser project or template, create a
configuration table, or use `cad_artifact`. Those workflows therefore require
the browser path.

## What a drawing contains

PartMode drawings combine exact OpenCascade hidden-line-removal projections with document-owned drawing instructions. A configured part may add a profile-derived section, limit dimensions, tolerances, notes, symbols, tables, and a title block.

Exact projection evidence does not make every annotation a certified manufacturing requirement. The project owns the drawing recipe, and engineering review remains responsible for its completeness, standard revision, units, tolerances, and release status.

General parts and assemblies can produce compact SVG drawing sheets. A persisted
part-specific recipe can also produce a larger standards-oriented sheet.
