# Contributing to PartMode

Thank you for helping improve PartMode.

## Before opening a pull request

1. Open an issue for a substantial behavior, document-schema, or architecture
   change so the intended boundary is clear.
2. Install Node.js 22.13 or newer and run `npm ci`.
3. Keep changes focused and preserve compatibility with saved project data.
4. Add or update the narrowest relevant regression test.
5. Run `npm run ci:gate` and any affected `smoke:*` scripts.

CAD completion must be supported by runtime and document evidence. Screenshots,
DOM rows, schema declarations, and mesh counts alone do not establish exact
geometry completion.

## Code and documentation

- Keep comments that explain invariants, ownership, topology, units, safety
  boundaries, or a non-obvious engineering decision.
- Avoid commentary that only repeats the code or records temporary project
  status.
- Never commit credentials, tokens, private deployment material, customer data,
  or standards content without confirmed redistribution rights.
- Do not add analytics or tracking without an explicit product decision and a
  consent-gated implementation.

By submitting a contribution, you agree that it may be distributed under this
repository's license.
