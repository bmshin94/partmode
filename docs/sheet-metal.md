# Sheet metal

PartMode sheet metal is the source-owned `partmode.sheet-metal/v1` feature
family on the `sheet-metal-flange` schema-5 feature type. Four bounded kinds
exist, all exact OCCT solids:

- **Base flange**: one direct closed polyline profile sketch on a datum plane,
  extruded by a stored literal sheet thickness into one new exact body. The
  recipe stores the thickness, the neutral-axis K-factor, and the default
  bend radius for downstream flanges.
- **Edge flange**: one exact 90-degree bend along one selected persistent
  straight edge of the base flange, fused onto the base body. The folded
  increment is the exact quarter annulus between the inner bend radius `R`
  and `R + t` plus a flat wall of the authored flange length, swept along the
  full current edge (which corner reliefs may have shortened).
- **Corner relief** (SM002 slice): one exact rectangular or circular cutout
  through the sheet thickness at one perpendicular base corner, subtracted
  from the base body.
- **Flat pattern** (SM004 slice): one derived read-only body extruding the
  exact developed outline of the base plus its flanges and reliefs.

## Bend allowance and bend tables

The bend allowance along the neutral fiber is computed exactly as

```text
bendAllowance = (bendRadius + kFactor * thickness) * angleInRadians
```

with the angle fixed at 90 degrees in this slice. The stored value in every
edge-flange recipe must equal this closed form exactly; any drift, including a
base-thickness edit without recomputation, fails closed at the document
boundary and in the production worker. Editing the base thickness through the
typed lifecycle recomputes every dependent flange's stored allowance and every
dependent relief's stored size.

A part may store one bend table (SM003 slice) at
`part.extensions.sheetMetalBendTable`: 1 to 64 rows of literal
`{ thickness, bendRadius, kFactor }`, strictly sorted by thickness then bend
radius with no duplicate pairs. While the table is stored it is the only
K-factor source. Flange creation and edits refuse literal K-factors and
resolve through exact `(thickness, bendRadius)` equality lookup; a missing row
fails closed everywhere, including thickness edits that would land on a
missing pair. `sheetMetal.bendTable.set` canonically sorts the rows and
associatively re-resolves every stored flange K-factor (recomputing
allowances); `sheetMetal.bendTable.delete` removes the table and freezes the
currently resolved values as ordinary stored literals. A stored flange
K-factor that does not equal its exact table row is a tampered document.

## Corner relief

Corner relief exists because two edge flanges meeting at a shared base corner
cannot fuse: the first flange's swept end cap is coplanar with the neighboring
side face, the fuse unifies them, and the second flange's full-edge
attachment contract fails closed. The relief cut replays before every edge
flange of its base (the typed create splices it directly after the base
flange), removes the corner material, and thereby shortens both adjacent
persistent bend edges so the flange sweeps clear the corner.

The relief size is stored and validated as exactly

```text
reliefSize = baseBendRadius + thickness
```

using the base flange's stored default bend radius. The rectangular style
removes exactly `reliefSize^2 * thickness`; the circular style removes the
exact quarter disc `(pi/4) * reliefSize^2 * thickness`. The corner must be
exactly perpendicular, one relief per corner, reliefs may not consume an
entire segment, and any two edge flanges on adjacent segments refuse to
coexist without a relief at their shared corner (and refuse the relief's
deletion afterward). Every relief cut must remove its closed-form volume
exactly or no geometry is published.

## Flat pattern

The flat pattern is derived, never authored: its recipe stores only the base
association, and everything else recomputes from the current base profile,
flanges, and reliefs on every validation and rebuild. The developed outline
is one closed chain in the base profile plane:

- every flanged segment develops outward by exactly
  `bendAllowance + flangeLength` over its relief-shortened extent;
- every relieved corner opens its exact square or quarter-arc cutout toward
  the developed corner gap;
- the closed-form flat area is
  `profileArea + sum(effectiveLength * developedLength) - sum(reliefArea)`,
  and the extruded flat body volume must equal `flatArea * thickness` exactly
  or no geometry is published.

The flat body is read-only: no feature may target, tool, or source it; only
the display name is editable; deleting the body cascades exactly the
flat-pattern feature. The flat pattern must remain the last sheet-metal
feature of its base, so creating further flanges requires deleting it first.

The flat outline exports as DXF through the existing `partmode.dxf/v1` sketch
writer: `studioSheetMetalFlatPatternSketch` renders the outline as a
constraint-native sketch of fixed points, lines, and relief arcs, and the
`flat-dxf` artifact format (permission `artifact.export-drawing`, argument
`flatFeatureId`) is wired across the studio artifact handler, agent capability
manifest, relay permission map, and hosted MCP schema.

## Authoring boundary

Create a datum plane and a closed polyline profile sketch, then choose
**3D Tools > Sheet metal** for base and edge flanges. The edge flange selects
a base flange, one profile segment, and the up or down side; the persistent
edge, sheet-face, and attachment-face names are derived deterministically from
the base feature's creation names and stored in the feature's references. The
production worker resolves them name-first with no signature fallback,
derives the bend frame from the current exact adjacent faces, and requires
the attachment face to remain the exact current-edge-by-thickness rectangle.

Typed `sheetMetal.flange.create/update/delete`,
`sheetMetal.cornerRelief.create`, `sheetMetal.flatPattern.create`, and
`sheetMetal.bendTable.set/delete` are the only mutation paths; generic
feature update, advanced update, and configure paths refuse sheet-metal
features. Kind, profile, base association, segment, side, corner, and style
are immutable on edit; corner reliefs and flat patterns accept name edits
only. Deleting a base flange requires deleting its dependent flanges,
reliefs, and flat patterns first; deleting a body cascades its sheet-metal
history. Corner reliefs and flat patterns have no visible ribbon dialog yet;
they are typed-operation surfaces only.

Every accepted result is one valid exact solid with canonical B-rep bytes,
complete unique face/edge/vertex names, zero topology diagnostics, and an
exact analytic volume check: `profileArea * thickness` for the base,
`(pi/4) * ((R + t)^2 - R^2) + flangeLength * t` per unit current edge length
for each fused flange increment, the closed-form relief volume for each
cutout, and `flatArea * thickness` for the flat body. A boolean that does not
change exactly that volume publishes no geometry.

## Explicit exclusions in this slice

- miter flange, hem, jog, and tab (the remainder of SM001);
- partial-width and non-90-degree edge flanges;
- flanges chained onto flange walls (edge flanges attach to base flanges
  only);
- closed corners and sketched bends (the remainder of SM002);
- non-perpendicular corner reliefs and per-flange relief sizing overrides;
- gauge tables and interpolated or unit-converted bend-table lookup (the
  remainder of SM003; lookup is exact equality only);
- bend-line annotations, drawing flat-pattern views, and export scaling,
  kerf, or nesting (the remainder of SM004);
- convert solid to sheet metal, rip, unfold, fold (SM005);
- forming tools, louvers, lances (SM006);
- visible ribbon authoring for corner relief, bend tables, and flat patterns
  (typed operations only); and
- manufacturing or standards certification of any kind.

## Acceptance gates

Run the focused exact gates after `npm run build`:

```text
npm run smoke:sheet-metal
npm run smoke:sheet-metal-flat
```

`smoke:sheet-metal` proves the closed-form bend-allowance, relief-size, and
bend-table contracts, typed authoring and edits, canonical save/reopen,
duplicate-edge and tamper refusals, and ten production-worker rebuilds with
exact volumes, complete persistent topology, associative edits, and
fresh-worker determinism. `smoke:sheet-metal-flat` proves the derived flat
pattern: closed-form developed lengths and flat volume, read-only lifecycle,
four production rebuilds of the relieved four-flange enclosure (folded and
flat), and the byte-deterministic `partmode.dxf/v1` flat-outline export
re-parsed by an independent parser. `smoke:ui-foundation` covers the
registered flange ribbon control; a dedicated real-Chrome sheet-metal
lifecycle gate has not been written yet and no visible browser lifecycle
claim is made for these slices.
