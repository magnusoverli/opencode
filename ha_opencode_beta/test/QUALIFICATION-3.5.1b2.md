# Beta 3.5.1b2: stable/beta browser-state isolation

## Root cause and change

The ingress proxy selected its browser-storage namespace using `ADDON_CHANNEL`,
but the actual s6 launcher used `env -i` without forwarding that variable.
Both installed channels therefore defaulted to `ha-opencode-stable`. Switching
Home Assistant Ingress instances could restore a chat workspace belonging only
to the other app's private `/data` volume.

The beta launcher now resolves identity through the existing `channel.sh` helper
and explicitly passes only `ADDON_CHANNEL` through its restricted environment.
Stable continues to use its stable namespace. Existing browser entries are not
deleted or copied; conversation records are not changed.

Beta may initialize fresh browser preferences. If a foreign workspace pointer
was already saved in beta's server settings, selecting **Open /homeassistant**
once repairs the browsing selection. Historical conversations retain their own
directories, so a genuinely missing historical workspace still needs recovery.

## Regression evidence

- Added a Linux test that launches both actual service scripts, redirecting only
  fixture paths and listen ports. Before the fix, it failed with beta emitting
  `ha-opencode-stable` instead of `ha-opencode-beta`.
- After the fix: **5 launcher/storage tests passed, zero skipped**. The real
  proxy's emitted installer was executed against shared browser-storage fixtures.
  Stable/beta switching, session/draft isolation, reopened selections, marker-file
  identity fallback and continued environment stripping were verified.
- Proxy component suite: **69 passed, one optional browser test skipped locally**.
- The in-image Chromium test now launches the proxy through the actual s6 script,
  seeds both current namespaced and legacy unscoped stable selections, and asserts
  the exact beta namespace and preservation of stable entries.
- That rendered test passed locally in the pinned b1 boundary runtime with the
  changed launcher and fixture mounted read-only: desktop/mobile Ingress,
  prompt/stream, restart retention, workspace recovery/reload and unchanged
  historical directories all passed.

Full PR checks and native AMD64/ARM64 image checks are required before publication.
Those checks include the rendered pinned OpenChamber UI, recovery persistence,
and the existing cache-expiry regressions. Exact runs are attached to the release
commit.

## Installed acceptance

The reported switching failure was reproduced through the shipped launcher,
not through access to the user's installed browser. After upgrading, verify
stable → beta → stable navigation in the same browser; a previously contaminated
server-side selection may need one recovery action. No installed data was
modified during development.

The broader pending acceptance items from b1 (installed approval UI, upgrade
preservation and real-model comparison) are not closed by this fix.
