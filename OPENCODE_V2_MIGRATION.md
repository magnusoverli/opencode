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

The pinned-binary regression checks exact session, message, event-watermark, and
credential projections while proving the source hashes remain unchanged. A
bounded image-build fixture additionally runs conversion as `opencode-v2` and
checks Linux source inaccessibility and privilege boundaries. Native amd64 and
arm64 CI both run that full fault-injection target. Local QEMU builds are useful
diagnostics but are not a release gate.

Supervisor, Ingress, mount, and s6 lifecycle acceptance runs separately in Home
Assistant's official apps devcontainer. It starts real Supervisor and Home
Assistant containers and installs this repository as local apps.
`scripts/devcontainer-acceptance.sh` verifies the installed image, s6 services,
the Home Assistant Core Ingress route, smoke tests, and automatic sidecar crash
recovery. The component fixture does not reproduce that service graph, and the
devcontainer is not a substitute for HAOS host-level acceptance.

## Staged V2 Runtime

After successful migration, s6 supervises one staged V2 server on
`127.0.0.1:4100`. It is not exposed through Home Assistant Network settings and
is not used by the terminal, LAN server, or OpenChamber. When MCP is enabled,
the staged V2 process connects to a separately supervised Home Assistant MCP
sidecar on authenticated loopback; user-facing clients still remain on V1.
Consequently, seeing `1.18.25` in the ttyd TUI is expected through `3.0.0b2`:
`opencode-session.sh` still launches the retained V1 binary until the terminal
activation gates below pass.

The launcher:

- verifies the root-owned readiness files and selected generation;
- uses one target-native launcher to publish the expected V2 PID, construct a
  credential-free allowlisted environment, drop to UID/GID `60000`, clear
  supplementary groups and capabilities, disable core dumps, set
  `no_new_privs` and non-dumpability, and directly `execve` V2;
- starts from root-owned `/run/opencode-v2/workspace`;
- uses an empty allowlisted environment and root-owned config/home paths;
- exposes only authenticated loopback;
- disables project config and external skill discovery;
- loads no Home Assistant, PPQ, discovery, or user environment credentials;
- enters the final executable with a target-native preload constructor that
  disables same-UID process inspection before asking a root broker for the
  server password and optional sidecar secret; the broker authorizes the
  kernel-reported peer UID and exact root-published PID;
- always loads a runtime guard that reasserts the process boundary and strips
  server and sidecar credentials from parent and shell-child environments;
- when MCP is enabled, receives one root-owned boot secret through FD 3, closes
  it after read, and uses it only as an in-memory bearer for the sidecar.

The sidecar owns the Supervisor and optional Home Assistant credentials through
a root-owned allowlisted environment rather than user environment files. It is
non-dumpable with core dumps disabled and listens on a root-only Unix socket. A
separate root-retained listener owns `127.0.0.1:8765`, preventing UID `60000`
from impersonating a restarted sidecar, and proxies to that socket. The stateful
Streamable HTTP endpoint rejects calls without the boot bearer, supports
long-running calls, and propagates cancellation into HTTP, WebSocket, and
process-group operations. A restarted V2 client can replace the previous
session, and sidecar-readiness failures make the supervised V2 process exit and
retry instead of sleeping permanently.

The target-native image fixture starts the real sidecar and plugin-enabled V2
through the launcher on amd64 and arm64. It proves Basic authentication, an
authenticated MCP request, UID/GID and capability boundaries, FD 3 closure, and
denial of the final process environment before and after plugin activation. A
hostile UID-60000 poller also scans the launch transition and must not recover
either credential. Supervised restart behavior is verified separately by the
devcontainer acceptance harness.

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

Through the b3 terminal cutover, while the beta image still contains the
temporary V1 fallback:

1. Stop or leave the staged V2 service inactive.
2. Continue running the retained V1 terminal, LAN, OpenChamber, and MCP paths.
3. Never point V1 at `/data/v2`.
4. Never copy V2 tables back into the V1 database.

Removing `/data/v2` is not an automatic rollback step. It may contain V2-only
sessions once user-facing activation begins and must be treated as user data.

The planned b4 beta removes V1 executables and service definitions from the
image, so rollback after that point is an add-on downgrade to a prior image, not
an in-container runtime switch. The V1 roots remain byte-for-byte untouched and
must not be automatically deleted; the downgraded image continues to read those
original roots rather than attempting a V2-to-V1 database conversion.

## V1 Decommission Gates

- b2 remains V1-default and makes the staged/active runtime explicit in the
  terminal banner.
- b3 makes V2 the default terminal runtime and starts no V1 service unless the
  temporary rollback selector is explicitly chosen.
- b4 removes the V1 package, launchers, generated config, and s6 paths after the
  b3 real-system soak passes.
- Stable 3.0 ships V2 only; V1 remains available as the separate stable 2.5.x
  add-on release line, not as hidden code inside the 3.0 image.
- V1 persistent data survives code removal until a later explicit retention
  policy is designed and approved.

## Remaining V2 Activation Gates

- Keep the root TCP proxy bound to port 8765 throughout sidecar startup and
  restart, return a clean 503 until a root-owned backend-ready marker exists,
  correct the sidecar/proxy ownership log messages, and recheck exact s6 restart
  behavior on Home Assistant.
- Provide approved `/homeassistant` writes without exposing retained V1 or
  sidecar credentials.
- Enforce project/plugin discovery restrictions for every client-selected
  working directory.
- Provide V2 server authentication to the TUI client without placing the
  password in its environment, arguments, shell history, or readable files.
- Prove native V2 read-only and ordered permission behavior after every config
  and plugin hook.
- Inject bounded briefing and decision context into initial and continuation
  requests without duplication.
- Connect ttyd/TUI only after those boundaries pass, first as an explicit
  reversible preview while V1 data remains the rollback source.
- Defer OpenChamber until its upstream V2 support and Home Assistant Ingress
  behavior are validated separately.
