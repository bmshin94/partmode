# CAD regression corpus

This corpus holds hand-auditable schema-5 PartMode documents and deterministic,
cumulative parameter mutations. It covers Boolean dependency rebuilds,
signature-selected Fillet and Shell operations, a three-section Loft, and a
scaled Sweep over a bent path. The named-checkpoint case also requires complete
face, edge, and vertex naming on its filleted exact solid and proves that each
name set survives both a downstream checkpoint reuse and an upstream rebuild.

The runner performs two gates:

1. Node validates every base document and mutation through the schema-5 parser,
   proves canonical round-trip idempotence, proves stable SHA-256 document
   hashes on replay, and checks the structural manifest.
2. A fresh browser worker per corpus case runs the shipped
   `studio-kernel.worker.js`. Every variant must return the expected bodies as
   one exact B-rep solid each, with no kernel errors, no last-valid fallback,
   positive volume, valid B-rep analysis, and the declared minimum mesh and
   topology counts. Downstream-only mutations also assert that the worker
   restores the unchanged upstream feature checkpoint and evaluates only the
   dirty suffix. Named vertex identity is derived from exact incident OCCT
   edges; rounded coordinates are not an identity key.

Build first, then run the compiled harness:

```sh
npm run build
npm run smoke:cad-regression
```

The corpus is part of both the focused blocking `release:gate` and
`smoke:nightly`. It currently covers part documents only; assembly solving,
drawing output, STEP round-trips, invalid-input diagnostics, topology deletion
failures, and long mutation sequences remain separate layers. Nightly adds the
checkpointed 200-model by 100-edit Professional Core mutation acceptance.
