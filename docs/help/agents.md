# Agent workflow

PartMode agents use typed MCP operations, not pointer automation. An agent key
authenticates the agent account. CAD authority comes from one of two distinct
choices made by the account owner:

- **Browser-approved local project:** a normal key can request a visible,
  project-scoped session in a signed-in PartMode tab. The project stays in that
  browser. Every session requires approval in the tab.
- **Server-headless durable project:** an edit key created with the explicit
  headless grant can open an account-owned project on the PartMode server with
  no browser or per-session approval. The grant is per key, cannot be added
  later, and means the server stores the committed project document.

A key without the headless grant cannot open a server-headless project. A key
by itself also cannot invent a browser session.

## Set up hosted MCP

1. Open [Agent access](/account), create or sign in to a PartMode account, and
   create a revocable agent key.
2. For local browser projects, leave **Allow headless server sessions** off. For
   unattended server execution, create an edit key and deliberately enable that
   grant after reading the storage notice.
3. Store the key in the secret environment used to launch the agent. Do not
   paste it into a prompt, URL, command argument, or project file.
4. Configure the hosted endpoint.

```
codex mcp add partmode --url https://partmode.com/mcp --bearer-token-env-var PARTMODE_AGENT_KEY
```

5. Start a new agent session and read the MCP Help resources.

## Work with a browser-approved local project

1. Keep the intended project open in a signed-in PartMode CAD tab.
2. Call `partmode_list_studios`. Discovery returns non-project tab identity
   only.
3. Call `partmode_connect` for the chosen tab, the smallest required permission
   set, and a bounded commit budget.
4. Wait for the person to approve the visible connection request.
5. Call `cad_capabilities`. This live manifest is authoritative for operations,
   schemas, limits, and artifact support.
6. Use `cad_inspect` and `cad_query` to establish exact current state.
7. Use `cad_preview` for a typed transaction. Review the diagnostic and visible
   browser preview.
8. Use `cad_commit` only with the returned preview ID and matching revision.
9. Inspect the settled result and call `partmode_disconnect` when finished.

The browser remains the enforcement point. The person can reject a request,
pause or disconnect the session, reject a preview, or revoke the key. The
browser project and recovery data stay on that device. Commands and results
cross the hosted relay over HTTPS and remain only in bounded process memory.
There is no offline queue, and the relay is not end-to-end encrypted.

## Work with a server-headless durable project

1. Use an edit key that was created with **Allow headless server sessions**.
2. Call `partmode_headless_open` with a stable `projectId`, an optional project
   name and units, the smallest permissions needed, a bounded session duration,
   and a bounded commit budget.
3. Call `cad_capabilities`, then use `cad_inspect`, `cad_query`, `cad_preview`,
   `cad_commit`, and supported `cad_history` actions against the returned
   session ID.
4. Call `partmode_headless_export_step` when an exact STEP artifact is needed.
5. Inspect the settled revision and document hash, then call
   `partmode_disconnect` when finished.

Headless sessions are temporary, key-bound execution contexts. They expire in
at most one hour and do not survive a service restart. Committed headless
documents are different: PartMode stores the project ID, project name,
revision, full document JSON, canonical document hash, and timestamps under the
account. Those records survive sessions, key revocation, service restarts, and
deployments so another headless-granted key on the same account can reopen the
same `projectId`. They remain until the PartMode account is deleted. Account
deletion closes every live headless session and removes the durable records; it
does not delete unrelated projects in browser storage.

There is no visible studio in this path. `cad_artifact`, `cad_ui`, and
`cad_events` are refused, and a successful `cad_preview` is a typed kernel
preview, not a human approval or visible browser preview. The dedicated
`partmode_headless_export_step` tool is the current headless artifact path.
Revoking the key immediately prevents further MCP authentication and closes its
live headless sessions, but does not delete the account's durable project
records. Signing out of PartMode closes active browser relay and headless
execution sessions while keeping agent keys and durable headless projects in
the account.

## Current hosted tools

The current MCP surface advertises exactly 15 tools:

- Session and artifact tools: `partmode_list_studios`, `partmode_connect`,
  `partmode_session_status`, `partmode_disconnect`, `partmode_headless_open`,
  and `partmode_headless_export_step`.
- Typed CAD tools: `cad_capabilities`, `cad_inspect`, `cad_query`,
  `cad_preview`, `cad_commit`, `cad_history`, `cad_artifact`, `cad_ui`, and
  `cad_events`.

Tool listing does not mean every tool is valid for every session. The two
headless entry and export tools require the headless grant. `cad_artifact`
generates browser-session artifacts, including `drawing-svg`, and `cad_ui` and
`cad_events` also require a browser session. Headless currently exposes STEP
through its dedicated export tool. Never invent operation kinds or arguments
from static documentation. The live `cad_capabilities` response wins when Help
and a running build differ.

## Local pairing

The in-app **Connect local agent** action is for a compatible loopback
integration on the same device. Hosted agents should use the account key and
`https://partmode.com/mcp` instead.

## Record the jet-engine assembly demonstration

From an open editor, choose {{ux-path:templates.exploded-turbofan.existing-editor}}.
This is a native
schema-5 assembly, not an imported display mesh. The compact model tree contains
six numbered module occurrences placed entirely by authored mates. Expand a
module to inspect its exact part occurrences, lofted airfoil blade rows, and
patterned seeds. **Service exploded layout** is a saved display-only exploded
view; it changes presentation without changing the mate-solved placements.

The **Agent flight recorder** shows bounded, redacted Studio evidence. Its rows
come from actual tool requests, preview and commit events, OpenCascade rebuilds,
assembly settlement, rendering, artifacts, and human-attention events. It does
not expose or invent an agent's private reasoning, and it never prints raw tool
arguments, project JSON, keys, or connection tokens.

For a paced browser recording, open the template visibly first, then connect the
real agent. The hosted default uses the visible-projection profile: use `cad_ui`
to set presentation and narration to `recording`, activate the saved exploded
view, and fit the visible model. Read `cad_events` to wait for each authoritative
settlement boundary. Template selection itself is not released through the
hosted visible-projection profile. Do not present test-only pairing helpers or a
prerecorded transcript as a live agent run.

The bundled engine is a conceptual exact-feature demonstrator. Its blade
profiles, material assignments, clearances, loads, thermal behavior, seals,
bearings, and manufacturing details are not a certified production-engine
definition.

## Troubleshooting

- No studio listed: sign in to the same account in PartMode and keep the CAD
  tab open, or use a headless-granted edit key for the server path.
- Connection pending: approve or deny the visible browser dialog.
- `HEADLESS_NOT_GRANTED`: create a new edit key with the headless grant or use
  the browser-approved path. Existing keys cannot be upgraded. If PartMode adds
  a new permission, create a new key to receive it; the persisted ceiling on an
  existing key remains unchanged.
- `VISIBLE_STUDIO_REQUIRED`: use a browser session for `cad_artifact`, `cad_ui`,
  or `cad_events`.
- `HEADLESS_RATE_LIMITED` or `HEADLESS_CAPACITY_EXCEEDED`: wait for the reported
  retry window or active work to finish before retrying.
- `HEADLESS_PROJECT_QUOTA_EXCEEDED`: reopen one of the account's existing 32
  project IDs. The current release removes durable headless projects through
  account deletion, not an individual project-delete tool.
- Revision conflict: inspect again and create a new preview from the current
  revision.
- Capability disabled: request only an operation or artifact advertised by
  `cad_capabilities`.
- Session not found: open or connect again. Sessions are temporary even when a
  headless project document is durable.
