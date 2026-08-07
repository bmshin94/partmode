# Weldment cut lists

PartMode drawing cut lists have two deliberately separate source modes. Legacy
`body-axis` tables measure the X, Y, or Z extent of explicitly selected bodies.
Weldment `structural-member` tables persist structural-member feature IDs and
derive all displayed manufacturing values from the current exact OpenCascade
result. Switching source modes requires deleting and recreating the table so a
stored table cannot silently change measurement semantics.

## Persistent contract

A structural-member cut list stores the drawing sheet, name, placement, width,
`sourceType: "structural-member"`, and an ordered unique `sourceMemberIds` list.
It does not store body IDs, an axis, authored lengths, authored angles, or cached
rows. Each member ID resolves to its current owned body during exact drawing
generation, so Path, profile-placement, trim, extend, miter, and cope changes do
not require rewriting the table.

## Exact measurement convention

The production worker evaluates the current structural-member recipe and final
OCCT body. Length is the long-point axial envelope of the final exact vertices
along the member's evaluated straight centerline:

```text
max(dot(vertex, axis)) - min(dot(vertex, axis))
```

This deliberately is not a world-axis bounding-box measurement. The worker
also publishes the exact B-rep digest, complete persistent topology counts and
names, vertex extrema, and unquantized planar-face points and unit normals.

For a planar terminal cut, the displayed end value is degrees off square:

```text
acos(abs(dot(cutFaceNormal, memberAxis)))
```

The start value belongs to the end nearest the authored Path start/profile; the
end value belongs to the opposite end. Square cuts are `0` degrees and a
perpendicular miter is `45` degrees. A cope has no honest single cut-plane angle,
so its numeric evidence is `null` and the table displays `COPE`.

## Resolution and repair

Exact table resolution requires evidence bound to the current canonical
document hash, one positive valid OCCT solid per selected member, complete
unique face/edge/vertex identity, zero topology diagnostics, a matching B-rep
digest, a corroborated member axis, and unambiguous supported terminal evidence.
Missing, suppressed, rollback-excluded, duplicated, stale, incomplete, tampered,
or unsupported nonplanar terminal inputs fail closed instead of falling back to
authored or approximate values. Explicit exact cope evidence is the supported
nonplanar exception and resolves to `COPE`, never to a fabricated angle.

A referenced member or owned body cannot be deleted until the table is deleted
or repaired. Structurally valid stale records remain inspectable, repairable,
and deletable even though their exact PDF resolution refuses output.

## Bounded delivery

The first delivery emits one row per explicitly selected straight structural
member with quantity one. It covers the shipped profile catalog plus exact
trim, extend, one-sided or reciprocal miter, and cope treatments. It does not
claim automatic grouping, patterned or assembly rollups, multi-segment members,
curved centerlines, stock nesting, cut optimization, signed three-dimensional
cut rotation, custom hollow profiles, or manufacturing certification.
