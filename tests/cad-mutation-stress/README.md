# Professional Core CAD mutation acceptance

`scripts/cad-mutation-stress.ts` is the deterministic Professional Core
mutation gate. The no-argument and `--exhaustive` scales are 200 distinct
schema-5 models by 100 valid edits per model, for 20,000 incremental versus
fresh-worker comparisons.

## Structural breadth

Models rotate through seven independently generated scenario families. The
default 200-model plan gives every family at least 28 models and gives every
registered feature type at least 28 meaningful model histories.

| Family | Runtime contexts exercised |
| --- | --- |
| Boolean history | independent target/tool Extrudes and a subtract Boolean |
| Fillet and Shell modifiers | named-edge Fillet and named-face Shell on independent bodies |
| Loft sections | a parameterized three-section Loft |
| Sweep path | a scaled Sweep over a parameterized spline path |
| Profile Cut pattern | exact upstream Extrude and repeated subtract Cut |
| Registered contexts | Chamfer, Draft, Revolve, Thicken, Transform, face-attached Cut, and both Boolean split sides |
| Imported topology | registry-backed imported STEP B-rep followed by Transform and named-edge Fillet |

Together those families exhaust the fail-closed
`STUDIO_V5_FEATURE_TYPES` registry: `boolean`, `boolean-split-side`,
`chamfer`, `cut`, `draft`, `extrude`, `fillet`, `imported-step`, `loft`,
`revolve`, `shell`, `sweep`, `thicken`, and `transform`. The aggregate fails if
any registered type lacks meaningful model coverage. Every non-import type
must also have a geometry edit attributed to it. Imported STEP is counted as
the exact persisted and reused upstream source, not falsely labelled as an
edited feature.

Every generated model varies safe geometric parameters. Each also receives a
unique exact probe stock with a persistent-name Fillet and a separate witness
Extrude. The probe exists only for topology failure recovery, so scenario
edits cannot accidentally satisfy the independent-body oracle.

## Per-edit acceptance oracles

Every valid edit is sent to the same persistent browser worker and to a newly
created, single-use cold browser worker. Logically equivalent inputs keep the
same `featureOrder` but reverse the stored feature records, parameter records,
datums, sketches, and resources. Every edit must prove all of the following:

- schema preparation is input-pure and idempotent;
- save/reopen JSON is byte-stable and has a stable SHA-256 canonical hash;
- the incremental and fresh-cold responses have identical canonical OCCT BREP,
  geometry, mesh, topology, signatures, and persistent-name evidence;
- every exact face, edge, and vertex on every body has exactly one name;
- every edit contributes a deterministic name-to-exact-topology evidence map;
  unchanged bodies must preserve every mapped signature byte-for-byte, while
  declared changed bodies may change geometric signatures but cannot move a
  name between bodies, topology kinds, or exact surface/curve classes;
- the intended bodies change exact BREP bytes and every independent body keeps
  the immediately preceding exact BREP bytes;
- the incremental trace contains exactly the expected dirty features and
  exactly the expected reused checkpoints;
- the cold worker evaluates every feature and reuses none.

Process-local OCCT `faceId` handles are replaced by response-local face
ordinals. Values within 1e-6 of zero are canonicalized because OCCT's 1e-7
bounding-box tolerance can survive a BREP checkpoint round trip with a
one-ULP spelling difference. This response normalization never changes the
canonical serialized BREP or any material geometry evidence.

The imported family initializes the bundled Replicad/OCCT runtime in Node,
creates one exact box, and captures its complete face/edge/vertex identity in
`partmode.imported-topology-registry/v1`. The generated document embeds both
the canonical source BREP and its co-serialized identity carrier. A Transform
edit must reuse Import and evaluate Transform plus downstream Fillet. A Fillet
radius edit must reuse Import plus Transform and evaluate only Fillet.

## Fail-closed recovery

At the configured interval, the harness replaces the dedicated probe Fillet's
edge with a persistent name that does not exist. It requires the explicit
`TOPOLOGY_REFERENCE_MISSING` diagnostic. Both the persistent and cold workers
must publish no probe-stock mesh, exact BREP, or geometry and must never label
the failed stock as last-valid. Every independent body must retain the exact
preceding BREP bytes in both workers. The next valid edit then continues on the
same incremental worker using its private valid checkpoint.

## Focused and exhaustive runs

Build first, then run:

```sh
npm run build

# Seven families, fourteen edits each. This executes every family and every
# mutation route in the registered-context scenario.
node .build/scripts/cad-mutation-stress.js --focused

# Professional Core acceptance: 200 models x 100 edits.
node .build/scripts/cad-mutation-stress.js --exhaustive \
  --checkpoint /absolute/path/to/cad-mutation-evidence.json

# Resume only against the identical harness, fixtures, registry, dist build,
# configuration, generated inputs, and completed-model evidence.
node .build/scripts/cad-mutation-stress.js --exhaustive \
  --checkpoint /absolute/path/to/cad-mutation-evidence.json --resume

# Package equivalents use .build/partmode-professional-core-200x100.json by
# default. Override it with PARTMODE_MUTATION_CHECKPOINT=/absolute/path.json.
npm run professional-core:gate

# Start only the exhaustive phase after an existing build, or resume an
# interrupted exhaustive phase without rebuilding the bound dist directory.
npm run smoke:cad-mutation-exhaustive:checkpoint
npm run smoke:cad-mutation-exhaustive:resume
```

Custom runs retain the literal breadth requirement and therefore require at
least seven models and seven edits:

```sh
node .build/scripts/cad-mutation-stress.js \
  --models 14 --cycles 14 --invalid-every 7 --progress-every 7 --jobs 4
```

Any invocation at 200 or more models by 100 or more edits is treated as a
Professional Core acceptance run even when those dimensions are supplied with
`--models` and `--cycles`: it still requires invalid-reference probes and at
least 20 meaningful model histories for every registered feature type.

Independent models run in bounded parallel lanes. One incremental worker stays
alive for one model's complete edit history, while each cold comparison creates
and terminates a fresh worker. Focused mode defaults to one lane; other modes
default to at most four. `--jobs N` can be reduced for a smaller CI runner.
`--scenario-offset 0..6` rotates the family order for diagnostic replay while
still requiring all seven families and the same aggregate coverage.

Checkpoints are atomic and accepted only at completed-model boundaries. The
version-3 envelope contains a SHA-256 integrity digest, the compiled harness,
schema, fixture, imported-registry, and bundled OCCT input fingerprints, the
complete `dist` fingerprint, the exact scenario and feature registries, seed
and acceptance configuration, every exact generated-document digest,
scenario/type coverage, per-edit name-to-exact-topology history digests, and
kernel evidence digests. Before a checkpoint can become `ok`, the harness
recomputes both the complete suite-input fingerprint and the complete `dist`
fingerprint so a rebuild during the run fails closed instead of producing
mixed-build evidence.
Resume regenerates and save/reopens each completed input before accepting its
record; any mismatch fails closed.
