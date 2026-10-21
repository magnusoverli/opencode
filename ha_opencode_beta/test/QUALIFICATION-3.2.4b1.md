# 3.2.4b1 PPQ model-pricing regression

## Root cause

Issue #188's latest screenshot reports `Missing key` at
`["data"][10]["cost"][0]["cache"]`, not a missing credential.
The 3.2.4b0 provider published incomplete domain `Model.Cost` records.
The real 2.0.26 model-list API rejected a priced model with HTTP 400 and the
exact screenshot error; the same model without pricing returned HTTP 200.
The existing inference fixture omitted prices, and unit assertions did not
validate the emitted domain model schema, allowing this regression through.

## Fix and qualification scope

- Complete pricing in a single normalization function, retaining published
  cache read/write rates (including zero), using ordinary input pricing only
  for unknown cache rates, and never representing unknown overall prices as free.
- Revalidate/normalize old on-disk cache records in memory without deleting
  files, changing credentials, rewriting sessions or requiring network access.
- Validate every source model with the pinned native `Model.Info` schema before
  registration. No schema-invalid source model can poison the shared model list.
- Exercise the real 2.0.26 model-list API, post-connect refresh, priced default,
  unknown prices, absent/null cache rates and retired-default protection.
- Keep model discovery and encrypted-only inference routing unchanged.

## Evidence and release gates

- The original local reproducer now returns HTTP 200 for both priced and
  unpriced models; native schema and client model-list decoding pass.
- 78 focused provider/runtime contracts pass per channel against official
  OpenCode 2.0.26, including the real API and regression fixtures above.
- Mock-backed tests use isolated state and fixture credentials only. No paid
  inference or reporter-key access is required to reproduce or verify this fix.
- Linux contracts and native amd64/arm64 image checks are mandatory before
  release. The build and published multi-architecture manifest are verified
  separately; a GitHub prerelease alone is not proof of installability.
- Real account-backed encrypted inference and installed Supervisor upgrade/
  rollback acceptance remain unverified. Stable remains version 3.2.3.
