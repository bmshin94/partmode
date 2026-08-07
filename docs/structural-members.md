# Structural members

PartMode structural members are exact Sweep features backed by the
`partmode.structural-member/v1` document recipe. They use a source-owned,
generic metric profile catalog and retain the profile choice, placement,
authored Path, owned construction plane, owned profile sketch, and catalog
provenance in the part document.

## Delivered profile catalog

Catalog edition 1 contains three nominal sizes in each of five sharp-corner
families:

- rectangular bar;
- equal angle;
- channel;
- I section; and
- tee.

These profiles are an unstandardized design aid. They are not certified to a
national or international structural-shape standard and must not be treated as
manufacturing or procurement certification.

## Authoring boundary

Create one direct Path sketch containing exactly one nonzero straight segment,
then choose **3D Tools > Structural member**. Select a family, preset, insertion
point, rotation, and literal X/Y profile offset. The operation creates one new
exact solid body plus a source-owned profile plane and profile sketch.

The first release intentionally supports one member per two-point Path. It does
not accept splines, helices, projected or composite reference curves,
multi-segment groups, or a reversed Path that makes the persisted profile frame
ambiguous. The member follows associative endpoint and direction changes using
deterministic minimum-rotation frame transport.

Preset and placement edits are supported within the existing family and retain
persistent topology identity. Changing families can change the semantic meaning
and count of profile edges, so it is refused; create a new member instead. This
prevents downstream references from silently reattaching to unrelated geometry.

Exact downstream trim/extend, miter/cope corner treatments, gussets, and end
caps are available through **3D Tools > Structural treatment**. Their separate
persisted contract and authoring limits are documented in
[`structural-treatments.md`](structural-treatments.md).

Deleting a member deletes its exact body and owned construction helpers while
retaining the authored Path. The part-level catalog record is removed after the
last member is deleted.

## Current limits

The following are not supplied by this capability:

- member groups and multi-segment automatic corner propagation;
- weld beads and weld tables;
- cut lists, cut lengths, and end angles;
- hollow or custom profile authoring; and
- standards or manufacturing certification.

## Acceptance gates

Run the focused exact and visible gates after `npm run build`:

```text
npm run smoke:structural-members
npm run smoke:structural-members-ui
```

The exact gate evaluates every catalog preset in the production OpenCascade
worker and checks canonical B-rep output, analytic volume, complete persistent
face/edge/vertex identity, save/reopen, associative edits, deterministic fresh
workers, deletion cleanup, and fail-closed tamper cases. The UI gate uses real
headless Chrome to exercise the shipped ribbon dialog, history, inspector,
edit, cancel, and delete paths.
