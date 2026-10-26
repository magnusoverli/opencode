# Stable hab 1.8.0 qualification

## Scope

- Included in stable **3.3.2**; no beta changes or live HA mutations during qualification.
- hab source pin: `1.8.0`, commit `f200a763798bc2a305c7fe0fad58dc0946e07861`.
- Supervisor credentials remain in the MCP sidecar; `hab_run` remains full-profile only.
- Existing dedicated area-assignment tools and zigporter cascade renames remain available.

## Local evidence — 2026-10-26

| Check | Result |
|---|---|
| Stable MCP `npm test` | 743 passed, 4 skipped across 46 files; includes profile enforcement, cancellation, quoting, output retention and new cache/registry-result contracts |
| Stable runtime, skills, promotion and channel-state contracts | 77 passed with `node --test ha_opencode/test/{runtime-contract,skills-and-agents,stable-promotion,opencode-v2-state-isolation}.test.js` |
| Real hab + real MCP gateway | Passed `test/hab-cli-fixture.mjs` on Linux amd64 with Node 24.22.0 in a disposable Bubblewrap filesystem, against authenticated loopback HTTP/WebSocket fixtures only |
| Documented commands | 40 argv examples validated against the actual 1.8.0 command tree |
| Discovery | Full schema 7,726,143 bytes; compact root MCP result 2,786 bytes; payload/output contracts, schema identities, short-ID inputs and expansion metadata retained |
| Dashboard regression | Existing plan/apply/no-op/conflict/rejection/uncertain-save checks and complete large-output retention passed |
| Registry updates | Live previews, clearing empty overrides/collections, explicit false, scoped categories, validation, no-ops for device/area/floor/label, and independent read-back passed |
| Fault injection | Rejected write, read-back failure/mismatch and accepted write with lost acknowledgement remain unverified without automatic retry |
| Context freshness | Later MCP reads see updated metadata after successful and uncertain writes; entity-ID changes invalidate state snapshots; a delayed pre-edit read cannot refill the cache |
| Short IDs | Ambiguity rejected before preview/write; filtered discovery retains globally unique prefixes; scoped categories and typed payload references resolve without altering arbitrary variables/text |
| Trace regression | Automation entity ID resolves to its different configuration ID |

The local fixture used the upstream `hab-linux-amd64` release binary, verified
against release SHA-256
`71ef3c6c2fdc226ec500bed9b8571c7713af7c9c519f1cc2a96f9057e80ffe2c`.
This is not evidence that the complete app image was built or installed.

Upstream's schema still calls the new registry previews `command_plan`; the
fixture proves live reads and before/after values instead of rewriting or trusting
that annotation. Lost registry-write acknowledgements can outlast the gateway's
deadline; timeout results correctly say the outcome is unverified and clear caches.

## Remaining release checks

- Run **Stable Image Checks**, which already builds `boundary-test` on native
  amd64 and arm64 runners and runs this expanded hab fixture with the source-built
  binary. Neither complete image build nor arm64 execution was available locally.
- Installed Supervisor update/rollback and actual HA-version/permission acceptance
  remain unverified. Back up the stable app and HA configuration before updating;
  restore that backup to roll back. Do not self-update hab inside the image.
