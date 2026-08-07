# Limits, evidence, and safety

PartMode uses OpenCascade through replicad for exact B-rep modeling. It is closer to a parametric mechanical CAD core than a mesh generator, but it is not a replacement for every SolidWorks, CATIA, or drawing-release workflow.

## Exact evidence

Treat these as meaningful completion evidence when they apply:

- a settled document and applied kernel revision;
- valid exact B-rep solids with complete face, edge, and vertex identity;
- canonical save and reopen behavior;
- exact OpenCascade HLR evidence for drawing views;
- at most 100 custom drawing line fonts, each with bounded width, dash pattern, and RGB values;
- at most 50 reusable drawing blocks and 500 authored sheet annotations per project;
- canonical project output and exact B-rep equivalence for unchanged inputs;
- structured diagnostics when topology or intent cannot be resolved safely.

Screenshots, shaded triangles, DOM rows, schema declarations, and mesh counts alone do not prove exact CAD completion.

## Current product limits

- No engineering simulation, certified analysis, or automated design approval.
- No CAM, native DWG authoring, or general GD&T/PMI workbench.
- Imported STEP does not reconstruct vendor-native feature history, mates, or PMI.
- Large assemblies and software-rendered browsers may reduce interactive display quality while preserving exact kernel work.
- Drawing coverage depends on the document recipe and is not automatically complete for manufacturing.
- Standards-oriented templates are demonstrations until independently validated and released under the applicable controlled standard.
- Server-headless execution is bounded to four live sessions and 32 durable
  project IDs per account, at most 20 commits and one hour per session, and 120
  headless requests per account in a one-minute request window. Global worker
  capacity can also return a retryable capacity error. Existing project IDs can
  be reopened without consuming another durable-project slot. There is no
  separate per-project deletion control yet; account deletion removes all
  durable headless projects.
- A narrow saved-project compatibility layer preserves selected historical
  schema-5 feature intent. Sampled controlled twist plus unmarked Draft and
  Fillet tangent propagation remain compatibility semantics. Constant-radius
  edge Fillet tangent chains carrying the explicit kernel-robustness policy are
  newly authorable through exact OCCT contours; variable-radius propagation is
  not.
- STEP export removes the volatile wall-clock value from the exchange-file
  header. Raw byte identity is enforced for the configuration-controlled
  single-part path; validate multi-body and assembly exchange by exact geometry,
  names, placements, and hierarchy rather than assuming every OCCT entity
  number is byte-stable.

## Data and privacy

Anonymous CAD, browser project recovery, and browser geometry stay in browser
storage. The browser-approved agent path does not turn those local projects
into cloud projects. Its approved commands and results pass transiently through
the relay over HTTPS, remain in bounded process memory, and are not an
end-to-end encrypted project channel.

Server-headless CAD is an explicit exception. An edit key created with the
headless grant authorizes PartMode to store committed projects under the
account. The stored record includes project ID, project name, revision, full
document JSON, canonical document hash, and timestamps. Headless execution
sessions are temporary and key-bound, but the committed documents survive
session expiry, key revocation, service restarts, and deployments. They remain
until account deletion. Deleting the account closes active headless sessions,
removes these server records, and does not delete unrelated projects held in
browser storage.

Headless sessions have no visible studio. `cad_artifact`, `cad_ui`, and
`cad_events` are refused, and typed preview evidence is not a human approval.
Their dedicated artifact export currently produces STEP. Choose the
browser-approved path whenever a person needs to see and approve each session
or preview, or when the agent needs a browser-generated artifact such as
`drawing-svg`.

Download important project files before clearing site data. Keep agent keys in secret storage, grant the smallest permissions needed, and revoke keys that are no longer used.
