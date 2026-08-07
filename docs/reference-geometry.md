# Reference geometry and curves

PartMode stores coordinate systems, points on curves, projected curves, composite curves, and helices as persistent schema-5 document entities. They can be created from the Reference geometry ribbon or with the corresponding typed CAD operations.

## Curve definitions

- A polyline path is an exact sequence of line spans.
- A spline path is an open interpolating cubic curve. Each adjacent pair of authored points becomes one exact cubic Bezier span, with shared tangents derived from the neighboring authored points.
- A projected curve orthogonally projects every exact line endpoint or cubic control point onto its datum plane. Affine projection therefore preserves the exact line or cubic representation instead of converting the curve to sampled line segments.
- A composite curve joins connected source curves in their authored order.
- A helix remains analytic OpenCascade geometry in the production kernel.

Displayed spline and helix points are previews. Modeling operations use the exact line, cubic, or analytic kernel representation.

## Point parameters

Point-on-curve parameters are bounded from zero through one and remain associative with the source curve.

- Polyline parameters use normalized arc length.
- Spline parameters divide the interval evenly across their exact cubic spans and use the cubic parameter within each span.
- Projected curves inherit the source parameter.
- Composite curves use their exact constituent spans. All-polyline composites retain normalized arc-length behavior.
- Helix parameters use normalized analytic turns and axial rise.

## Fail-closed boundaries

Projected sources must be representable as exact line or cubic spans. A direct projection of an analytic helix is rejected because it cannot be represented by those spans without changing its geometry. Pierce remains intentionally limited to exact polyline-compatible curves until exact curved intersection handling is available.

Referenced paths and datums cannot be deleted while dependent points, reference curves, patterns, or features still use them. Cycles, disconnected composites, invalid dimensions, missing references, and unsupported projections are rejected before a mutated project is published.
