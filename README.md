# PartMode

PartMode is free and open-source, browser-based parametric CAD built for people
and agents. It combines OpenCascade WebAssembly, replicad, and three.js with
editable parts, structured assemblies, exact B-rep evaluation, drawings, and
standard interchange formats.

- **Free and open source** — use, inspect, modify, and self-host PartMode under
  the GNU AGPL v3 license.
- **Browser-based** — create and edit exact CAD models through a local-first web
  interface, with no desktop CAD installation required.
- **Agent-first CAD** — permissioned agents use typed operations against the
  same editable documents and exact geometry evidence as the human interface.
  Agent-first does not mean agent-only: people and agents can build, inspect,
  revise, and export the same models.

[Try PartMode](https://partmode.com/) · [Read the in-product help](https://partmode.com/help)

## What is included

- Parametric sketches and feature history
- Multiple exact solid bodies and reusable part definitions
- Assembly occurrences, mates, exploded views, and sections
- Configurations, inspection, measurements, and mass properties
- STEP import/export plus STL, AMF, 3MF, SVG, DXF, and PDF outputs
- Browser-approved agent sessions and opt-in server-headless projects
- Regression tests for document, topology, B-rep, export, and visible UI behavior

PartMode is engineering software, not a certification authority. Validate
dimensions, tolerances, material choices, and released manufacturing data for
your application.

## Run locally

PartMode requires Node.js 22.13 or newer.

```sh
npm ci
npm run build
npm start
```

The server listens on `http://127.0.0.1:4401` by default. Browser-local CAD does
not require an account or external service.

## Verify a change

```sh
npm run ci:gate
```

The focused gate type-checks and builds the release, verifies the static and
runtime manifests, and exercises the local HTTP, account, identity, MCP, cloud,
and entrypoint contracts. The larger CAD and browser suites remain available as
individual `smoke:*` scripts and through `npm run release:gate`.

## Repository scope

This repository contains the standalone PartMode product source, public
technical documentation, fixtures, and tests. Production credentials, private
operations, deployment configuration, internal handovers, and release records
are intentionally outside this repository.

The BOMWiki organization is the administrative home of this repository;
PartMode does not depend on BOMWiki applications, services, databases, ports,
or deployment infrastructure.

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change and
[SECURITY.md](SECURITY.md) for vulnerability reports. Third-party components
and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

PartMode is licensed under the
[GNU Affero General Public License v3.0 only](LICENSE). Copyright © 2026 Sphinx.
