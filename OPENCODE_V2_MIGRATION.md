# OpenCode V1 to V2 Beta Migration

This document defines the direct migration of `ha_opencode_beta` from its
retained OpenCode V1 runtime to the pinned OpenCode V2 runtime targeted by
`3.0.0b0`. There is no separate Preview add-on and no cross-slug import path.
`ha_opencode` remains on certified V1 until a separate stable-adoption review.

Implementation status and remaining release work are tracked in
`.opencode-v2-beta-progress.md`. Runtime parity and upstream gaps are tracked in
[`OPENCODE_V2_FUTURE.md`](OPENCODE_V2_FUTURE.md).

## Product Boundaries

| Channel | Folder | Runtime |
|---|---|---|
| Stable | `ha_opencode/` | Certified V1 |
| Beta | `ha_opencode_beta/` | Retained V1 plus staged pinned V2 during migration |

The beta add-on upgrades in place. Home Assistant preserves its private `/data`,
which contains the previous beta V1 database and provider authentication. The
migrator reads only that beta-owned state. It never reads stable's private
volume and never uses `/homeassistant`, `/share`, or Home Assistant backups as a
transport.

## Non-Negotiable Rules

1. V1 and V2 never write the same database, auth file, config root, state root,
   cache root, or plugin directory.
2. Migration is copy-on-write. Retained V1 files are never moved, rewritten, or
   opened by a V2 process.
3. V2 conversion runs from a private cold SQLite snapshot under a dedicated
   unprivileged identity.
4. Only a fully validated generation is activated.
5. Failure is non-fatal to the retained V1 runtime and never replaces the last
   known-good V2 generation.
6. `SUPERVISOR_TOKEN`, Home Assistant access tokens, PPQ keys, discovered
   sessions, arbitrary environment variables, hooks, SSH state, and local
   plugins are not migrated.
7. There is no V2-to-V1 conversion. Rollback reuses the untouched V1 state.
8. A V2 binary with a different target version cannot open an activated
   generation until a reviewed V2-to-V2 copy-on-write upgrade exists.

## Storage Layout

Retained V1 roots:

```text
/data/.config/opencode
/data/.local/share/opencode
/data/.local/state/opencode
/data/.ssh
```

V2 roots:

```text
/data/v2/current                         active generation ID
/data/v2/generations/<id>/home           generation home
/data/v2/generations/<id>/config         conversion-time config
/data/v2/generations/<id>/data           V2 database and provider auth
/data/v2/generations/<id>/state          V2 state
/data/v2/generations/<id>/generation.json
/data/v2/cache                           shared V2 cache, backup-excluded
/data/v2/work                            candidate and lock root, backup-excluded
/data/v2/migration.json                  non-secret migration journal
```

`current` is a root-owned regular file containing one 32-character generation
ID. Generation activation uses same-filesystem atomic replacement. The selected
generation directory and its four leaves are checked for links and invalid path
types before any V2 launcher exports them.

Production V2 policy is regenerated under root-owned tmpfs on every boot:

```text
/run/opencode-v2/managed.json
/run/opencode-v2/config/opencode/AGENTS.md
/run/opencode-v2/home
/run/opencode-v2/workspace
/run/opencode-v2/server-password
/run/opencode-v2/ready
```

The runtime can read this policy but cannot replace it. Its writable persistent
database remains in the selected `/data/v2/generations/<id>` generation.

## Source Inventory

The automatic migration recognizes only:

- `/data/.local/share/opencode/opencode.db`;
- its SQLite `-wal` and `-shm` sidecars when a database is present;
- `/data/.local/share/opencode/auth.json` when a database is present.

The coordinator rejects symlinks, hardlinks, non-regular files, unexpected
sidecars, auth-only state, legacy JSON without its database, oversized input,
and V1 database files open by another process. It validates retained-root access
against UID/GID `60000` before conversion.

Generated config, caches, logs, binaries, MCP auth, SSH files, Git config, shell
history, custom plugins, project config, user hooks, and Home Assistant context
are never copied. Managed assets are regenerated from the image.

## Migration Sequence

`init-opencode` performs the following before credential-bearing discovery or
any V1 longrun is released:

1. Prepare `/data/v2` roots with restrictive modes and reject unsafe path types.
2. Select the deployment-CPU V2 binary and probe its exact version once with a
   scrubbed environment and disposable HOME/XDG roots under `/data/v2/work`.
3. Inventory the allowlisted V1 source and verify it is cold and inaccessible to
   the V2 identity.
4. Hash every selected source file.
5. Copy the database and sidecars into a private candidate cache, then use
   SQLite's backup API to create the conversion database.
6. Copy and validate provider auth only when the source database is present.
7. Start the exact pinned `opencode2 serve` against the candidate with:
   - a random loopback-only authenticated endpoint;
   - an allowlisted environment;
   - project config disabled;
   - a deny-all conversion policy;
   - supplementary groups removed and UID/GID set to `60000`.
8. Wait for V2's migration status endpoint and stop the entire conversion
   process group.
9. Validate SQLite integrity, foreign keys, migration state, the exact pinned
   session/message projection (including aggregates and event watermarks), and
   provider identity plus credential semantics.
10. Re-hash the retained V1 source and reject any change or newly open writer.
11. Write the protected generation marker, fsync the candidate tree, move it
    into `generations/<id>`, and atomically replace `current`.
12. Regenerate the root-owned native V2 policy and release the retained V1
    services regardless of V2 success.

The migrator removes abandoned candidates and unselected generations under its
own private roots. Unknown entries fail closed rather than being deleted.

## Validation Contract

An activated generation records only non-secret metadata:

```json
{
  "format": "ha-opencode-v2-migration/v1",
  "status": "validated",
  "generation": "<32 lowercase hex characters>",
  "target_version": "0.0.0-beta-...",
  "source": {
    "session_count": 0,
    "message_count": 0,
    "part_count": 0,
    "content_part_count": 0,
    "provider_auth_count": 0
  },
  "target": {
    "session_count": 0,
    "message_count": 0,
    "validated_content_part_count": 0,
    "provider_auth_count": 0
  }
}
```

The marker contains no provider names, credentials, session titles, message
content, source filenames, server passwords, environment values, or captured
tool output. Diagnostic capture is bounded and keyword-checked before the
candidate can activate.

The local pinned-binary regression checks exact session, message, event-watermark,
and credential projections while proving the source hashes remain unchanged. The
in-image fixture additionally runs conversion as `opencode-v2` and checks Linux
source inaccessibility and privilege boundaries. That Linux fixture must pass in
CI or a local Docker build before release; it passes locally for both native
amd64 and emulated arm64.

## Staged V2 Runtime

After successful migration, s6 supervises one staged V2 server on
`127.0.0.1:4100`. It is not exposed through Home Assistant Network settings and
is not used by the terminal, LAN server, OpenChamber, or MCP yet.

The launcher:

- verifies the root-owned readiness files and selected generation;
- drops to UID/GID `60000` with no supplementary groups, capabilities, or new
  privileges;
- starts from root-owned `/run/opencode-v2/workspace`;
- uses an empty allowlisted environment and root-owned config/home paths;
- exposes only authenticated loopback;
- disables project config and external skill discovery;
- loads no Home Assistant, PPQ, discovery, or user environment credentials;
- leaves the Home Assistant MCP plugin disabled.

V2 currently discovers project plugins independently of the project-config
disable flag. Consequently, the staged server remains private and starts only
from a root-owned empty workspace. User-facing clients must not be connected
until plugin discovery is enforceably disabled for every client-selected
directory.

## Failure and Restart Behavior

- Missing V1 state creates one fresh, validated V2 generation.
- Auth without a V1 database, orphan SQLite sidecars, unsafe paths, active V1
  writers, insufficient disk space, conversion errors, count mismatches, source
  changes, and target-version mismatches defer V2.
- A failed candidate is removed and never selected.
- An interrupted boot reconciles abandoned private work on the next attempt.
- Re-running the same target version reuses the activated generation and repairs
  a missing journal.
- A different target version fails closed without opening or mutating the
  selected generation.
- V1 startup continues with its original roots after every V2 deferral.

## Rollback

Until V2 is separately approved for stable:

1. Stop or leave the staged V2 service inactive.
2. Continue running the retained V1 terminal, LAN, OpenChamber, and MCP paths.
3. Never point V1 at `/data/v2`.
4. Never copy V2 tables back into the V1 database.

Removing `/data/v2` is not an automatic rollback step. It may contain V2-only
sessions once user-facing activation begins and must be treated as user data.

## Remaining Release Gates

- Build and run the image fixture on amd64 and aarch64.
- Exercise the exact s6 launcher, effective UID/GID/capabilities, authenticated
  health endpoint, supervised shutdown, and V1-root denial in Linux.
- Design an authenticated Home Assistant MCP sidecar credential that shell
  subprocesses cannot recover or replay.
- Provide approved `/homeassistant` writes without exposing retained V1 or
  sidecar credentials.
- Enforce project/plugin discovery restrictions for every client-selected
  working directory.
- Connect ttyd/TUI only after those boundaries pass.
- Run the real Home Assistant migration and rollback smoke test before tagging
  `3.0.0b0`.
