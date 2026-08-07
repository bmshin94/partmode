# Getting started

PartMode is local-first parametric CAD in the browser. OpenCascade evaluates
exact B-rep geometry on your device. You do not need an account to model, save a
project, or export a part. This browser-local workflow is separate from the
optional server-headless agent workflow, which requires explicit per-key consent
and stores committed documents under the account.

## Quick answers

**Is PartMode free?** Yes. PartMode is free to use and is intended to remain
free. Its source is available under the repository license.

**Who makes PartMode?** PartMode is made by
[Sphinx](https://x.com/protosphinx). Read [About PartMode](/about), the
[privacy notice](/privacy), or the [cookie details](/cookies).

## Build a part as a person

1. On the first visit, choose {{ux-path:project.blank.first-visit}} for a blank part or {{ux-path:templates.library.first-visit}} for an editable starting model.
2. Choose Sketch to start an Extrude profile on the base plane. Choose Extrude, Cut, or Revolve when you need another supported planar face or operation.
3. Draw a closed profile and type exact dimensions in millimetres.
4. Apply the feature. Add later operations from the feature ribbon and inspect them in History.
5. Use parameters for dimensions that should rebuild together.
6. Save the editable project file before clearing browser data.

The template library creates normal editable documents. A template is a starting recipe, not a screenshot or decorative mesh.

The **Standard parts** category adds configuration-controlled nominal content for ISO 4017:2022 hexagon-head screws, ISO 4032:2023 regular nuts, and ISO 7089:2000 normal-series washers. Choose a listed designation in Configurations after opening the family. The screw and nut threads are honest smooth envelopes with retained metric callouts, not modeled helices. The catalog does not select tolerances, material, coating, or property class and is not manufacturing certification; verify released hardware against the licensed standard.

## Explore the exploded turbofan

From the first-visit screen, choose {{ux-path:templates.exploded-turbofan.first-visit}}.
From an open editor, choose {{ux-path:templates.exploded-turbofan.existing-editor}}.
The conceptual engine demonstrator's left model tree lists eight numbered subsystems and keeps
their component leaves collapsed until you expand them. The saved **Service
exploded layout** separates the modules for inspection while leaving their
fixed assembly placements unchanged.

The right-side **Agent flight recorder** reports actual document, kernel,
assembly, render, and connected-agent events. It is an evidence log, not a
simulation of private agent reasoning. The engine consists of exact editable
features and reusable patterns, but it is not an aerodynamic, structural,
manufacturing, or airworthiness definition.

## Read the model state

- **History** is the ordered construction recipe.
- **Bodies** shows exact solids and visibility state.
- **Parameters** holds reusable expressions and dimensions.
- **CFG** selects a stored part configuration when the document defines a design table.
- **Inspector** shows the selected feature, body, occurrence, mate, or measurement.

PartMode reports rebuild errors instead of silently treating a failed edit as valid geometry. A visible shaded model is useful feedback, but exact completion is established by settled document revision, valid B-rep evidence, and the requested export or query result.

## Inspect dependencies and where-used

An agent can send an `entity.dependencies` query with an entity `{ kind, id }`.
Use `direction: "upstream"` to inspect inputs, `direction: "downstream"` for
where-used, or `direction: "both"` for both sides. `transitive: true` follows
the graph across multiple levels; `maxDepth`, `relation`, `pageSize`, and
`cursor` bound or filter the result.

The typed graph covers datum chains, sketch supports, feature inputs and body
results, materials, body and occurrence patterns, reusable part or subassembly
occurrences, mates, section scopes, and exploded-view steps. Deleting a datum
or sketch with dependents fails with their names. Body and occurrence deletion
removes their dependent feature, mate, and pattern records atomically.

## Pack and move a complete project

**Save project file** and the `project` agent artifact both export the complete
canonical project, including reusable part and assembly definitions,
occurrence dependencies, configurations, and embedded imported B-rep
resources. The agent artifact includes a deterministic
`partmode.project-bundle/v1` dependency manifest. Missing referenced resources
fail project validation instead of producing an incomplete bundle.

## Use equations and units

The **Parameters** table is the global-variable surface. Dimension fields can
reference those names and combine them with `+`, `-`, `*`, `/`, `^`,
parentheses, comparisons, and functions such as `sin`, `sqrt`, `min`, `max`,
and `if`. Length literals accept `mm`, `cm`, `m`, `um`, `in`, `ft`, and `mil`;
angle literals accept `deg` and `rad`. PartMode evaluates geometry in
millimetres and angles in degrees, including trigonometric arguments and
inverse-trigonometric results.

For example, `if(wall > 5mm, 2in, 1in)` selects a length from the global
`wall` value, and `sin(30deg) * 10mm` evaluates to 5 mm. Unsupported names,
functions, units, non-finite results, and parameter cycles fail the rebuild
instead of executing code or publishing guessed geometry.

## Inspect mass properties

1. Assign a material to each body from **Inspect > Material**. The bundled
   generic densities are editable engineering placeholders, so verify the
   actual grade before relying on the result.
2. Choose **Mass & health** in the Inspect ribbon group.
3. Review exact volume and surface area, density-driven mass, center of mass,
   the center-of-mass inertia tensor, principal moments and axes, and radii of
   gyration.

Assembly mass properties use each solved occurrence placement and the parallel
axis theorem. If any included body lacks material density, PartMode reports the
known subset and center of volume but does not claim a complete mass, center of
mass, or mass inertia tensor. An agent can read the same revision-keyed result
with a `cad_query` request whose kind is `geometry.health`.

## Mate references

Assembly mates can reference component origins, part datums, and analytic body
faces. Planar faces provide an origin and normal, cylindrical and conical faces
provide an exact axis, and spherical faces provide an exact center. A
concentric mate between cylinders or cones aligns the two axes while retaining
axial and rotational freedom. A concentric mate between spheres aligns their
centers while retaining rotational freedom.

PartMode rejects malformed analytic references and mixed spherical/axial
concentric pairs. A rejected solve preserves the previous valid placement or,
when there is no previous solve, the authored component placement.

## Edit a part in assembly context

1. Open an assembly and select a direct part occurrence.
2. Choose **Edit component** or **Edit in context**.
3. Edit the part's sketches, features, bodies, and parameters while the owning
   assembly remains visible. The chosen occurrence is rendered as the active
   solid; every other occurrence is ghosted and cannot be selected as editable
   part topology.
4. Use **Return to assembly** in the viewport banner when the part edit is
   complete.

The active occurrence keeps its exact solved assembly transform. A feature
edit changes the shared part definition, so every linked occurrence rebuilds
from the same edited definition. The assembly identity, occurrence path, and
edit mode survive project save and reopen. A deleted assembly, occurrence, or
part definition fails closed instead of silently opening a different part.

This workflow currently supports direct part occurrences. Nested occurrence
paths and associative cross-part references to ghosted geometry are not yet
supported.

## Save and exchange

- **Project file** preserves the editable schema-5 document.
- **STEP** exchanges exact CAD bodies and assembly structure with other CAD systems.
- **STL** exports tessellated geometry for mesh workflows such as printing.
- **AMF** exports named bodies as XML mesh objects with explicit millimetre units.
- **3MF** exports named bodies in a standards-based package with explicit millimetre units.
- **Drawing** exports an SVG sheet generated from the active, settled configuration.

Browser recovery is a convenience, not a substitute for downloading an important project file.

For a constant-radius edge fillet, **Propagate exact tangent chain** asks the
kernel to expand each persistent seed through its current non-branching OCCT
tangent contour. The saved feature retains only the authored seed references;
an explicit `partmode.kernel-robustness/v1` policy keeps this newly authored
behavior distinct from historical intent. The exact contour is rediscovered
and fully named on every rebuild. Variable-radius propagation remains
unavailable, and an unresolved, faulty, or incompletely named contour fails
without publishing geometry.

## Reopen an older project safely

PartMode preserves a narrow set of historical schema-5 feature intent when an
older saved project is reopened. This includes sampled controlled twist,
asymmetric loft continuity, historical Draft and unmarked Fillet tangent-
propagation intent, and Boolean Split tool-removal semantics. The compatibility
markers survive save and recovery, while a newly authored exact Fillet carries
its explicit kernel-robustness policy and remains exact after reopen.

Compatibility preservation means the original project remains recoverable; it
does not make those historical semantics newly authorable exact Professional
Core features. If an active browser project fails validation, PartMode protects
its stored bytes from fallback autosaves until you explicitly open, recover, or
start another project.
