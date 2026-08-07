# Structural treatments

PartMode structural treatments are persistent `weldment-treatment` features
backed by the `partmode.weldment-treatment/v1` recipe. They consume exact
`partmode.structural-member/v1` members and are rebuilt by the production
OpenCascade worker; no display mesh or decorative overlay is used as the
authoritative result.

## Delivered operations

Choose **3D Tools > Structural treatment** to create one of four treatment
families:

- **Trim / extend** moves a named start or end boundary inward or outward by a
  positive literal distance. Trim uses an exact retained-side boundary;
  extension fuses the member's complete catalog profile over the added length.
- **Corner treatment** accepts two coincident named member ends. Miter cuts the
  selected target member at their exact bisector plane. Cope subtracts the
  current exact other-member body from the selected target and refuses a
  non-overlapping pair. Apply reciprocal miter treatments when both members of
  a joint must be cut.
- **Gusset** creates a separate triangular exact plate body in the plane of two
  non-collinear coincident member ends. Both leg lengths and plate thickness
  remain editable.
- **End cap** creates a separate exact plate body from the complete catalog
  profile at a named member end. Plate thickness remains editable.

Trim/extend and corner treatments remain downstream modifiers in the selected
member body's history. Gussets and end caps own stable result-body identities.
Treatment kind, member associations, body associations, and named ends are
immutable after creation; delete and recreate the treatment to change them.
This prevents an edit from silently reattaching exact topology to another
member. Supported dimensions and the trim/extend or miter/cope choice can be
edited through the typed treatment command.

A named member endpoint can participate in only one treatment. The sole
exception is a reciprocal pair of miter treatments, which cuts both members at
the same joint from the same persisted bisector construction. Treatments may
still be composed at opposite ends of one member. This endpoint-ownership rule
prevents a later cap, gusset, or corner feature from remaining at an authored
endpoint that an earlier trim or corner operation has removed.

Deleting a treatment either restores the source member history or removes its
owned plate body. A member or member body cannot be deleted while a treatment
depends on it; delete the treatment first.

## Exact evidence and refusal boundary

Every published treatment result must be one valid exact solid with a complete,
unique persistent name for every face, edge, and vertex. Trim, miter, and cope
must remove positive material; extension must add exactly profile area times
extension distance. Gusset and cap volumes must equal their persisted profile
area times thickness. Invalid recipes, detached member/body identities,
noncoincident joint endpoints, collinear gusset members, same-member corners,
zero dimensions, whole-member trims, non-overlapping copes, incomplete topology
history, and stale UI previews fail without publishing new geometry.

This capability does not add weld beads, weld symbols, weld tables, member
groups, cut-list generation, custom profile authoring, or manufacturing
certification.

Run the focused gates after `npm run build`:

```text
npm run smoke:structural-treatments
npm run smoke:structural-treatments-ui
```

The exact gate exercises the production worker, current document hashes,
canonical B-reps, analytic volume, complete topology identity, all five catalog
profile families for end caps, associative member edits, save/reopen, fresh
worker determinism, typed deletion, and fail-closed tamper cases. The UI gate
uses real Chrome to exercise the shipped dialog and typed lifecycle.
