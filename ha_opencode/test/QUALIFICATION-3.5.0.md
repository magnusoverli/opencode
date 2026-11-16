# Stable 3.5.0 promotion

Promotes beta `3.5.0b5` (`d5af6af4b86099d4e1997697f0e7121594842c25`).
The user authorized stable promotion and publication.

## Reconciliation

- Preserve stable name, slug, image, AppArmor profile, storage defaults, MCP
  migration channel and companion ownership.
- Promote OpenCode CLI/plugin 2.3.0, OpenChamber 2.7.2 at immutable revision
  `1a151518c95cc5ff3578bab593d2f96862ff3bb8`, Bun 1.4.4 and companion 0.1.0b8.
  HAB remains 1.8.0.
- Preserve stable's Zigporter 1.4.2 compatibility overlay, HAB registry/state
  cache invalidation and project placement/archive repair.
- Add previous-stable OpenCode 2.1.4 to the guarded converter fixture. Check
  source preservation, exact project fields and rejection of unrelated changes.
- Consolidate release notes against GitHub issue/PR identities. PR #210 is
  @BBungalow's contribution; PR #213 is @jameswgm87's. Their beta co-author
  attribution remains in repository history.

## Installed beta evidence

- b4: deprecation correction and core safe-patch transactions accepted.
  Recovery-failure tests were simulated. The temporary YAML fixture was removed;
  six journals and five recovery copies were deliberately retained.
- b5: display names, visibility/redaction, revisions, before/after reviews,
  mismatch/replay/stale-source protections, real managed read-only inspection
  and previews, apply exclusion, Build handoff and restoration accepted.
- Operator confirmed native approval. Flasher was restored to `verbose: true`,
  stopped, with its original opaque revision. No lifecycle apply was performed.
- Offered-tool reporting matched Build (71 bundled/72 native) and managed
  read-only (29 bundled/zero native). Availability is not an approval receipt.

## Validation scope

Native release CI validates both architectures and publishes their manifest.
Installed stable upgrade/rollback remains distinct from synthetic conversion
coverage. Installed schema edge cases, expiry/restart causality, name fallback,
256-field limits and concurrent contexts are not claimed as installed passes.
Real-account model entitlement, physical native-client pairing and affected-host
unknown-work/unsafe-path repairs are not claimed verified.

The first Windows-context local image attempt stopped at the Zigporter candidate
hash guard because checkout CRLF differed from committed LF; the normalized
candidate hash matches the reviewed manifest. Release snapshots use Git's
normalized bytes. Windows migration checks could not establish Linux behavior;
the actual converter and privilege checks run on Linux.
