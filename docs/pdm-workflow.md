# PartMode project lifecycle and PDM

PartMode schema-5 projects can carry a `partmode.pdm/v1` lifecycle graph in `project.extensions.pdm`. The graph travels with the canonical project file and is available through the visible **Manage > PDM** manager and typed agent transactions.

## Content versions

Each version contains a canonical project snapshot with the PDM graph removed, a SHA-256 content identity, one or more parent version IDs, author, timestamp, and message. Checkout verifies the hash before restoring the snapshot. A modified or corrupt snapshot fails closed as `PDM_VERSION_TAMPERED`.

Version IDs and branch IDs are stable within the project. Creating a version requires the caller to name the expected current branch head. A stale head rejects the entire atomic transaction. Creating a version without a content change is also rejected.

## Branches

Named branches point to immutable head versions. A new branch starts from an explicit version or the active head. Checkout restores the selected branch head and preserves the complete PDM graph. Branch content therefore drives the ordinary feature tree, exact OpenCascade rebuild, inspection, and export paths.

## Review and release states

Versions follow this controlled state machine:

```text
work-in-progress -> in-review -> released -> obsolete
                        |
                        +-> work-in-progress, after a recorded rejection
```

Submitting for review starts a new review round. Approval records are append-only and identify reviewer, decision, timestamp, comment, and round. The version author cannot approve their own version. Release requires the configured number of current-round approvals and no current-round rejection. A rejected review must return for changes before it can be resubmitted.

## Typed operations

- `pdm.initialize`
- `pdm.version.create`
- `pdm.branch.create`
- `pdm.branch.checkout`
- `pdm.review.submit`
- `pdm.approval.record`
- `pdm.review.return`
- `pdm.version.release`
- `pdm.version.obsolete`

All operations use the same atomic transaction boundary as modeling commands. PDM branches and versions also appear as typed `pdm-branch` and `pdm-version` entities in project inspection and change sets.
