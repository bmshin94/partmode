# PartMode contribution roadmap

This roadmap lists candidate contribution areas. It does not assign delivery
dates, promise compatibility milestones, or imply that every item will ship.
Propose substantial changes in an issue before implementation so the boundary
and evidence can be agreed first.

## Browser and headless portability

- Import canonical project bundles and templates into server-headless projects.
- Add configuration-table authoring to the typed headless path.
- Expand headless artifact support beyond STEP when exact evidence permits it.
- Let an account owner delete one durable headless project without deleting the
  complete account.

The browser and headless paths intentionally have different authority, storage,
visibility, and artifact boundaries today. Portability work must preserve those
differences rather than silently widening access.

## Assembly edit context

- Support complete nested occurrence paths when editing a part in assembly
  context.
- Add safely bounded associative cross-part references to ghosted geometry.

The current workflow supports direct part occurrences. Missing or ambiguous
paths must continue to fail closed.

## Modeling parity

- Let first-class constrained sketches drive Revolve.
- Extend exact tangent-chain propagation beyond constant-radius Fillet chains.
- Improve contributor fixtures for safe parameter mutation, topology naming,
  and fresh-worker rebuilds.

New modeling behavior must carry canonical document intent and exact kernel
evidence. Proximity and traversal order are not acceptable reference fallbacks.

## Drawing parity

- Allow more topology-bound annotations on derived views.
- Broaden controlled GD&T and PMI coverage without implying standards
  certification.
- Extend exact exchange coverage while keeping approximation policies explicit.

## Scale and maintainability

- Establish measurable interaction and rebuild budgets for large assemblies and
  software-rendered browsers.
- Improve shared headless-worker throughput without weakening tenant isolation.
- Extract cohesive coordinators from `src/static/studio.js` while preserving
  schema, runtime, and browser behavior.

## Explicit boundaries

PartMode does not currently promise:

- CAM or native DWG authoring;
- engineering simulation, certified analysis, or automated design approval;
- a general standards-certified GD&T or PMI workbench;
- reconstruction of vendor-native feature history, mates, or PMI from STEP;
- identical interactive quality for every assembly size and renderer.

See [limits, evidence, and safety](docs/help/limits-and-safety.md) for the
current product boundary and [CONTRIBUTING.md](CONTRIBUTING.md) for the evidence
required in a change.
