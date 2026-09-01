# OpenCode V2 Readiness and Migration

This document records confirmed OpenCode V2 beta changes, the proposed Home
Assistant plugin architecture, the copy-on-write V1-to-V2 migration and rollback
contract, and the release gates for the 3.0 beta line. It is the single canonical
V2 roadmap, not a claim that V2 is ready for stable users.

## Status Snapshot

Updated on 2026-09-01:

- Stable OpenCode is `opencode-ai@1.18.25` and remains the certified runtime in
  stable add-on 2.5.3.
- V2 is an active beta published separately as `@opencode-ai/cli`. The selected
  exact build is `0.0.0-beta-18684` and installs the
  `opencode2` command.
- Companion V2 packages use the same exact beta version. The beta integration must pin
  the CLI and its direct first-party plugin dependency graph; direct client or
  server dependencies are added only if add-on code imports them. It must never
  consume the moving `beta`, `next`, or `dev` tag in an image or lockfile.
- V1 and V2 are designed to install side by side. The first experiments must
  leave `/usr/local/bin/opencode` and all stable services on V1.
- `ha_opencode_beta` is the V2 integration and release target beginning with
  `3.0.0b0`. `ha_opencode` remains the certified V1 stable add-on. There is no
  third Preview add-on and no mechanical beta-to-stable promotion while the
  channels use different OpenCode generations.
- V2's plugin and server APIs are explicitly beta and may continue to change.
- The current V2 branch is `v2`, not the old `2.0` branch.
- OpenChamber's V2 compatibility work is still open in
  [openchamber/openchamber#3007](https://github.com/openchamber/openchamber/pull/3007).
  OpenChamber must not be pointed at V2 until compatible support is released and
  its Home Assistant Ingress behavior is revalidated.
- V1 remains installed and selectable in beta for in-container rollback, the LAN
  server, and OpenChamber. V1 removal is not a beta or stable 3.0 milestone. Any
  future removal would require a separate decision and plan after OpenChamber V2,
  migration, rollback, and persistent-data behavior have all been re-evaluated.
- The deployed `3.0.0b2` image passed bounded Home Assistant checks under the
  official Supervisor devcontainer:
  V2 ran as UID/GID 60000 with no capabilities or readable process environment,
  the root proxy retained port 8765, both unauthenticated endpoints returned
  401, the sidecar MCP completed a read-only call, and no service restarted.
- The b1 startup-order race is resolved: the root proxy retains its listener and
  returns 503 until the sidecar is ready. Repeatable devcontainer acceptance now
  verifies the Home Assistant Core Ingress route, s6 state, smoke tests, and
  automatic sidecar crash recovery.

Sources:

- [V2 migration guide](https://opencode.ai/v2/docs/migrate-v1)
- [V2 configuration](https://opencode.ai/v2/docs/config)
- [V2 plugin API](https://opencode.ai/v2/docs/build/plugins)
- [V2 MCP servers](https://opencode.ai/v2/docs/mcp-servers)
- [V2 permissions](https://opencode.ai/v2/docs/permissions)
- [V2 branch](https://github.com/anomalyco/opencode/tree/v2)

## Historical Activation Path

### Why the b0-b3 TUI reported 1.18.25

Through `3.0.0b3`, the terminal service ran the certified V1 `1.18.25` runtime
while V2 remained an independently supervised authenticated server on
`127.0.0.1:4100`. That staging period preserved working V1 rollback while the
workspace and plugin-discovery boundaries were closed. Beta b4 then made V2 the
default terminal, and b5 adopted the current root-server model for HAOS
filesystem compatibility.

### Completed in 3.0.0b2: stabilization and truthful status

Beta 2 remained user-facing on V1 while making the staged V2 foundation quieter
and repeatably verifiable:

1. Bind the root TCP proxy to port 8765 immediately, then gate accepted
   connections on a root-owned sidecar-ready marker. Early callers receive a
   clean 503 until `/run/opencode-v2/mcp-sidecar.sock` is listening, while the
   root listener never gives UID 60000 a replacement window and later genuine
   backend failures remain visible.
2. Change the sidecar startup message to say that the credential-bearing worker
   listens on a root-only Unix socket and the root proxy publishes
   `127.0.0.1:8765`.
3. Update the terminal banner to report both facts explicitly: the current TUI
   uses V1 `1.18.25`, while V2 `0.0.0-beta-18684` is staged privately.
4. Add focused contracts for readiness-before-bind ordering and the corrected
   log ownership language; run only shell syntax and the V2 state-isolation
   contract during development.
5. Exercise sidecar and proxy restart ordering under the exact s6 tree,
   preserving the root listener and recovering the MCP endpoint without a crash
   loop.
6. Repeat the bounded live checks on the release candidate and confirm that the
   startup log contains no expected backend-connect errors.

### Completed b4 V2 terminal preview

The first user-facing V2 milestone was terminal-only and explicitly reversible.
It required these outcomes before the V2 path became the default:

1. Provide approved reads and writes under `/homeassistant` without changing host
   ownership or exposing retained V1 data. The final b5 implementation runs the
   active server as root and treats allowed shell execution as trusted container
   root access.
2. Enforce a bundled-plugin allowlist, or disable project and user plugin
   discovery, for every client-selected working directory including
   `/homeassistant`.
3. Define a client attachment and authentication path that does not put the V2
   server password in terminal environment variables, command arguments, shell
   history, or a user-readable file.
4. Prove native V2 ordered permissions and the read-only agent after all config
   and plugin hooks, including shell, edit, subagent, and MCP dispatch denial.
5. Deliver static Home Assistant rules and bounded briefing/decision context to
   initial requests and tool continuations without duplication.
6. Prove TUI startup, provider authentication, session resume, clean shutdown,
   tmux reattachment, and rollback to the retained V1 roots on real Home
   Assistant.
7. Add an explicit beta runtime selector, then switch the default and display the
   V2 version after the V2 path passes the complete terminal smoke test.

The root-owned managed policy now defines the selectable V2
`home-assistant-read-only` agent. Its final rules default-deny every action,
re-allow ordinary file reads and path globbing, then re-deny sensitive reads.
Content search stays denied because V2 authorizes it by search expression rather
than by each matched file. The complete `homeassistant_*` MCP namespace is also
denied before only the centrally defined compact diagnostic profile is
re-allowed. With the sidecar's full catalog active and global sensitive-read
rules disabled, the target-native boundary fixture asks V2's own permission
evaluator to deny generic mutations, content search, unknown/future native and
MCP actions, known mutating MCP tools, and sensitive reads while allowing normal
reads, path globbing, and a compact diagnostic tool. The compact-profile suite
separately proves stale direct mutating calls are rejected before sidecar
dispatch. This closes the managed policy and deterministic evaluator portion of
gate 4; model-driven tool invocation and the real TUI remain part of terminal
acceptance. A root-only `opencode-v2-self-test` now repeats those evaluator
checks against the live private server in one non-dumpable process, leaves no
pending approval or temporary session after success or controlled cancellation,
and keeps the server password out of arguments, environment variables, output,
proxies, and redirects. It also matches MCP activation to the root-owned boot
configuration and applies an internal deadline. Native image and Supervisor
acceptance both invoke it.

### Parity after terminal cutover

OpenChamber is not the first V2 client. After the terminal preview is reliable,
close the remaining LSP/formatter, PPQ, startup-hook, LAN, and
custom-provider gaps. Integrate OpenChamber only after upstream V2 support lands
and its Ingress, streaming, OAuth, update-policy, and service-worker behavior is
revalidated. Stable 3.0 still requires a supported upstream V2 release and a
multi-architecture beta soak.

### Dual-runtime beta milestones

These milestones describe how V2 became the default while V1 remained a tested,
selectable runtime. They are history and readiness gates, not a retirement
schedule.

- `3.0.0b2` completed startup cleanup, the dual-runtime banner, and exact s6
  restart checks while retaining V1 as the default user-facing runtime.
- `3.0.0b3` is the final planned V1-default beta. It adds the default-deny native
  read-only policy and its target-native evaluator coverage so operators can test
  the staged V2 service before terminal activation.
- `3.0.0b4` makes V2 the default terminal runtime. The V1 terminal, LAN, and
  OpenChamber paths run only when the operator explicitly selects V1; the V2
  mount and services remain inactive in that mode.
- `3.0.0b5` removes the HAOS-incompatible ID-mapped mount and runs the V2 server
  directly against `/homeassistant` as root so real-system testing can proceed.
- `3.0.0b6` removes provider calls from the V2 self-test so operators can run it
  without creating temporary model sessions or misleading authorization errors.
- `3.0.0b7` makes the configuration matrix explicit: V2 always serves the
  terminal, while V1 honors the saved terminal or OpenChamber preference.
- `3.0.0b8` stops importing V1 provider credentials into new V2 generations;
  sessions still migrate, existing V2 generations remain untouched, and users
  authenticate providers directly in V2 with `/connect`.
- `3.0.0b9` restores the optional native Home Assistant MCP bridge in V2 through
  the credential-isolated sidecar and removes the one-time credential-broker
  startup race. It retains explicit V1 rollback while these fixes soak.
- `3.0.0b10` expands complete Home Assistant entity-history retrieval and keeps
  the dual-runtime model unchanged.

V1 remains the supported in-container rollback, LAN, and OpenChamber path while
V2 parity work continues. Neither a beta number nor a soak result authorizes its
removal. The untouched V1 roots, V2 generations, and migration provenance are
user data and must not be automatically deleted.

## Confirmed Runtime Changes

### Distribution and process model

V2 is not a version of the `opencode-ai` package. The required starting pair is:

```text
@opencode-ai/cli     -> opencode2
@opencode-ai/plugin  -> matching beta plugin API
```

The plugin package already pins its matching client/protocol dependencies.
Install `@opencode-ai/client` or `@opencode-ai/server` directly only when a
specific add-on component imports that package.

The CLI package publishes Linux glibc binaries for x64, x64 baseline, and
arm64, so the add-on's amd64 and aarch64 targets are represented. Both binaries
start successfully in the Home Assistant Debian Trixie images; the x64 baseline
package must still be tested on a host without AVX2.

V2 is daemon-first. Its shared daemon, client-owned `--standalone` server, and
explicit `serve` process have different ownership models. Beta b5 runs one
authenticated root `serve` process under s6 on private loopback and attaches a
separately isolated UID-60001 TUI. The server accesses `/homeassistant` directly
for HAOS compatibility; both processes start outside that tree in a dedicated
root-owned project directory.
The current V1 LAN service cannot be renamed mechanically:

- V2 `serve` accepts repeatable `--cors` origins, but its authentication and
  exposure model still differs from the V1 LAN service.
- V2 has no top-level `attach` command; clients use `opencode2 --server URL`.
- V2 service discovery and authentication require a new LAN threat model.

Affected V1 integration points include:

- `ha_opencode_beta/Dockerfile`
- `rootfs/usr/local/lib/opencode/runtime.sh`
- `rootfs/usr/local/bin/opencode-session.sh`
- `rootfs/usr/local/bin/ha-readonly`
- `rootfs/etc/s6-overlay/s6-rc.d/ha-opencode-server/run`

### Configuration

V2 reads supported V1 files from the existing global and project locations and
normalizes supported values in memory. This is useful for compatibility tests,
but the beta must also have an explicit native V2 fixture so policy equivalence
can be inspected and tested.

Project configuration can append later permission and agent rules. The initial
beta must disable project config loading entirely rather than let
`/homeassistant/opencode.json(c)` or `.opencode` override the managed safety
policy. User project config is restored only after a validator and precedence
tests prove it cannot replace managed denies or load untrusted plugins.

Important native V2 translations:

| V1 | Native V2 |
|---|---|
| `snapshot` | `snapshots` |
| `permission` | ordered `permissions` array |
| permission `bash` | `shell` |
| permission `task` | `subagent` |
| permission `write` / `patch` | `edit` |
| `agent` | `agents` |
| agent `prompt` | `system` |
| `provider` | `providers` |
| provider `npm` | `package`, with `aisdk:` where applicable |
| `mcp.<name>` | `mcp.servers.<name>` |
| MCP `enabled` | inverse `disabled` |
| MCP scalar timeout | startup/catalog/execution timeout object |
| `plugin` | `plugins` |
| skills paths/URLs object | ordered `skills` array |

V2 permission rules are ordered and the last matching rule wins. A configured
deny cannot be overridden by a saved approval, but a later configured rule can
override an earlier rule and agent rules are appended after global rules. The
current read-only overlay must be translated deliberately and tested for every
selectable agent and subagent after all config and plugin hooks; a plugin
permission hook must not be its primary enforcement mechanism.

V2 MCP servers default to Code Mode. The existing Home Assistant tools need
`codemode: false` initially to preserve direct tool discovery, existing tool
names, and per-tool permission tests.

### Current feature gaps

Current official V2 documentation confirms these gaps:

- `instructions` is accepted but not loaded. The add-on currently uses it for
  core MCP guidance, generated briefing context, decision notes, focus mode,
  startup-hook guidance, the beta-owned `AGENTS.md`, and `AGENTS.local.md`.
- `lsp` is accepted but V2 does not start language servers. This regresses the
  Home Assistant YAML language server.
- `formatter` is accepted but V2 does not run formatter commands. This regresses
  the current Prettier workflow.
- Session sharing is accepted but not implemented.
- The V1 plugin and server/client APIs are intentionally incompatible with V2.

Static safety rules can move to V2's discovered global
`~/.config/opencode/AGENTS.md`. Every other currently injected source needs an
explicit destination: MCP/profile guidance and focus mode can be added by the
plugin; bounded briefing and decision context can use its per-model-call
`session.context` hook. Shared project `AGENTS.md`, `AGENTS.local.md`, and
startup-hook guidance are disabled in the initial beta rather than loaded
implicitly. The hook must be proven to reach initial and tool-continuation
requests without duplicating context before a user-facing V2 beta starts.

## Migration and Persistent Data Contract

### Product and data boundaries

The beta add-on upgrades in place. Home Assistant preserves its private `/data`,
which contains the beta's V1 database and provider authentication. There is no
Preview add-on, cross-slug import, or access to the stable add-on's private
volume. The migrator reads only the beta-owned V1 database, deliberately ignores
V1 provider credentials, and never uses `/homeassistant`, `/share`, or Home
Assistant backups as a transport.

The stable and beta channels remain separate products:

| Channel | Folder | Runtime |
|---|---|---|
| Stable | `ha_opencode/` | Certified V1 |
| Beta | `ha_opencode_beta/` | Selectable certified V1 and pinned V2 beta |

### Non-negotiable migration rules

1. V1 and V2 never write the same database, auth file, config root, state root,
   cache root, or plugin directory.
2. Migration is copy-on-write. Retained V1 files are never moved, rewritten, or
   opened by a V2 process.
3. V2 conversion runs from a private cold SQLite snapshot under dedicated UID/GID
   `60000`; this is separate from the active root V2 server used for HAOS
   filesystem compatibility.
4. Only a fully validated generation is activated.
5. Failure is non-fatal to V1 and never replaces the last known-good V2
   generation.
6. Provider credentials, `SUPERVISOR_TOKEN`, Home Assistant access tokens, PPQ
   keys, discovered sessions, arbitrary environment variables, hooks, SSH state,
   and local plugins are not migrated.
7. There is no V2-to-V1 conversion. Selecting V1 reuses its untouched state.
8. A V2 binary with a different target version cannot open an activated
   generation until a reviewed V2-to-V2 copy-on-write upgrade exists.

### Storage layout

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
generation directory and its leaves are checked for links and invalid path types
before any V2 launcher exports them.

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

### Source inventory

Automatic migration recognizes only `/data/.local/share/opencode/opencode.db`
and its SQLite `-wal` and `-shm` sidecars when a database is present. The
coordinator rejects symlinks, hardlinks, non-regular files, unexpected sidecars,
legacy JSON without its database, oversized input, and files open by another
process. It validates retained-root access against UID/GID `60000` before
conversion.

`auth.json` is neither opened nor hashed. Auth-only V1 state creates a fresh V2
generation and requires `/connect`. Generated config, caches, logs, binaries,
MCP auth, SSH files, Git config, shell history, custom plugins, project config,
user hooks, and Home Assistant context are never copied. Managed assets are
regenerated from the image.

### Copy-on-write migration sequence

`init-opencode` completes migration before normal s6 services are released:

1. Prepare `/data/v2` roots with restrictive modes and reject unsafe path types.
2. Select the deployment-CPU V2 binary and probe its exact version once with a
   scrubbed environment and disposable HOME/XDG roots under `/data/v2/work`.
3. Inventory the allowlisted V1 source and verify it is cold and inaccessible to
   the conversion identity.
4. Hash every selected source file.
5. Copy the database and sidecars into a private candidate cache, then use
   SQLite's backup API to create the conversion database.
6. Start the exact pinned `opencode2 serve` against the candidate with a random
   authenticated loopback endpoint, allowlisted environment, project config
   disabled, deny-all conversion policy, no supplementary groups, and UID/GID
   `60000`.
7. Wait for V2's migration status endpoint and stop the entire conversion
   process group.
8. Validate SQLite integrity, foreign keys, migration state, the exact pinned
   session/message projection including aggregates and event watermarks, and
   zero provider credentials.
9. Re-hash the retained V1 source and reject any change or newly open writer.
10. Write the protected generation marker, fsync the candidate tree, move it into
    `generations/<id>`, and atomically replace `current`.
11. Regenerate the root-owned native V2 policy and allow s6 startup to continue,
    regardless of whether V2 migration succeeded.

The migrator removes abandoned candidates and unselected generations only under
its private roots. Unknown entries fail closed rather than being deleted.

### Validation contract

An activated generation records bounded, non-secret metadata:

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
tool output. Diagnostic capture is bounded and keyword-checked before activation.
Pinned-binary regression checks prove exact projections, zero credentials, and
unchanged source hashes.

The image-build fixture runs conversion as `opencode-v2` and checks Linux source
inaccessibility and privilege boundaries on native amd64 and arm64. Supervisor,
Ingress, mount, and s6 lifecycle acceptance runs separately in Home Assistant's
official apps devcontainer. The devcontainer is lifecycle evidence, not a
substitute for host-level HAOS acceptance.

### Failure, restart, and generation behavior

- Missing V1 state creates one fresh, validated V2 generation.
- Orphan SQLite sidecars, unsafe paths, active V1 writers, insufficient disk
  space, conversion errors, count mismatches, source changes, and target-version
  mismatches defer V2 without changing V1. Auth-only V1 state follows the fresh,
  credential-free generation path above.
- A failed candidate is removed and never selected.
- Interrupted boots reconcile abandoned private work on the next attempt.
- Re-running the same target version reuses the activated generation and repairs
  a missing journal.
- A different target version fails closed without opening or mutating the
  selected generation.

### Permanent in-container rollback

V1 is a retained runtime, not a time-limited migration fallback:

1. Select **OpenCode runtime: V1**, save, and restart the add-on.
2. The V2 server, sidecar, broker, proxy, and managed V2 project remain inactive.
3. Continue using the retained V1 terminal, LAN server, OpenChamber, and MCP
   paths against the original V1 roots.
4. Never point V1 at `/data/v2` or copy V2 tables into the V1 database.

Removing `/data/v2` is not a rollback step. It may contain V2-only sessions and
provider authentication and must be treated as user data. V1 remains selectable
while OpenChamber and LAN require it, and no current roadmap milestone removes
the runtime or either generation's persistent data.

## Home Assistant Plugin Architecture

### Decision

Build a small first-party OpenCode V2 plugin, but keep the Home Assistant MCP
implementation in an independently supervised sidecar rather than loading its
tool handlers into the OpenCode process.

The plugin is the OpenCode-specific control-plane adapter. The existing MCP
server remains the Home Assistant integration and capability boundary.

```text
Home Assistant Supervisor and s6
  - options, mounts, process supervision, sidecar-only token injection
  - generated native V2 config and explicit permission rules
  - isolated V2 data/config/cache directories
  - privileged, profile-filtered HA integration sidecar
             |
             v
Root OpenCode V2 server + bundled plugin
  - MCP registration and lifecycle transform
  - bounded dynamic context hook
  - optional status/help commands
             |
             +--> HA integration sidecar (authenticated loopback MCP transport)
             +--> HA YAML LSP (independent; blocked until V2 runs LSP)

Isolated UID-60001 TUI
  - attaches to the root V2 server
  - separate XDG roots and root-owned managed configuration
```

### Plugin responsibilities

The first plugin should:

1. Register the sidecar's `homeassistant` MCP endpoint with `ctx.mcp.transform`.
2. Preserve `OPENCODE_MCP_TOOL_PROFILE` and server-side dispatch rejection.
3. Register native MCP through a separate authenticated sidecar route when its
   option is enabled, and deny its entire namespace in the read-only agent.
4. Set `codemode: false` for compatibility during the first migration.
5. Add already-sanitized, bounded home briefing and decision-note context with
   `ctx.session.hook("context")` once per model request.
6. Optionally add non-mutating status/help commands with
   `ctx.command.transform`.
7. Return cleanup and dispose registrations on plugin unload.
8. Log only lifecycle state, plugin version, MCP connection state, and selected
   non-secret profile. Never log environment values, tool arguments, or tokens.

The plugin must not:

- read or persist `SUPERVISOR_TOKEN`;
- implement Home Assistant HTTP clients or tool handlers in-process;
- replace MCP server-side tool-profile filtering;
- use permission hooks to relax the final configured policy;
- own s6 services, LAN binding, Ingress, OAuth bridging, or OpenChamber;
- overwrite user-owned `AGENTS.local.md` or skills;
- become the only read-only or sensitive-file boundary.

The V1 process inherits `SUPERVISOR_TOKEN`. V2 improves the default exposure by
keeping Supervisor and Home Assistant access tokens out of the server's inherited
environment, managed config, logs, and model context; the separately supervised
sidecar owns those credentials. A root-retained TCP proxy, root-only Unix
backend, peer-validated boot credential, non-dumpable runtime boundary, and
shell-environment scrubbing prevent incidental inheritance and ordinary
same-process inspection.

This is not an OS isolation boundary against an allowed V2 shell command. The
active V2 server and its shell run as container root for HAOS filesystem
compatibility and can read root-owned runtime files. Full-mode shell execution is
therefore trusted root code; the native read-only agent and compact profile deny
shell instead of relying on file modes to contain it. The attached TUI remains
isolated as UID `60001` with separate XDG roots and root-owned managed
configuration.

Model-provider credentials are a separate category: OpenCode may legitimately
need them, while optional PPQ and Home Assistant credentials can remain in
sidecars. The spike must inventory each secret source and document whether it is
available to shell tools. User-supplied environment variables are trusted
arbitrary process input, not covered by a blanket non-disclosure promise.

V2 auto-discovers local plugins independently of the confirmed project-config
disable flag. Before the terminal preview, project/user plugin discovery must be
disabled or a tested allowlist must contain only the exact bundled plugin. If V2
provides no enforceable mechanism, user/project plugins must be explicitly
classified as trusted arbitrary code and the beta cannot claim that only
audited plugin code executes. No plugin may be installed or updated at runtime.

### Why not rewrite every MCP tool as a plugin tool?

V2 can register native tools through `ctx.tool.transform`, but a rewrite is not
the first milestone:

- the MCP server already has hundreds of tested tool paths, feature gates,
  resources, prompts, caches, and error normalization;
- compact/configuration/full profiles are enforced both at catalog time and at
  dispatch, independent of OpenCode;
- a rewrite would move Home Assistant API access and the Supervisor token into
  the OpenCode process;
- it would maximize coupling to an explicitly unstable beta API;
- it would remove the protocol boundary used by other MCP clients and tests.

After the thin plugin is stable, selected first-class tools may be evaluated
only where they provide a demonstrated capability that MCP cannot.

## Delivered 3.0.0b0-b1 Foundation

### Integrated beta foundation

The V2 package and tests live directly under
`ha_opencode_beta/rootfs/opt/opencode-v2-homeassistant/` and currently prove:

- exact CLI/plugin beta `0.0.0-beta-18684` installation from a committed lock;
- `opencode2 serve` can run as an s6-ownable foreground process on an explicit
  loopback address and port;
- the server enforces HTTP Basic authentication and can use a managed password
  instead of logging an automatically generated credential;
- one exact local plugin loads through the real V2 loader and appears active;
- the plugin's MCP transform registers a direct-tool (`codemode: false`) remote
  Home Assistant server without accepting caller-controlled profile selection;
- s6 runs the credential-bearing Home Assistant integration as a separate root
  process on a root-only Unix socket, while a root-retained TCP listener exposes
  only authenticated loopback Streamable HTTP;
- a target-native launcher publishes the expected V2 PID, constructs a
  credential-free allowlisted environment, enables `no_new_privs`, disables core
  dumps and process inspection, then directly executes the active V2 server as
  root for HAOS filesystem compatibility;
- a target-native preload constructor restores non-dumpability before obtaining
  credentials from a root broker that validates the kernel-reported peer PID;
  the boot secret reaches V2 only through inherited FD 3 and is closed after
  read, while an always-loaded runtime guard reasserts the boundary and strips
  credentials from the parent and shell-child environments;
- the stateful sidecar transport supports long-running calls and replacement
  client sessions without the former 15-second socket cutoff, while MCP
  cancellation reaches HA HTTP, WebSocket, and process-group operations;
- one explicit managed config document is loaded while project config is
  disabled;
- the root sidecar consumes only an init-generated allowlist, arbitrary tool
  arguments are absent from logs, and V2 receives no Home Assistant credential;
- the integrated Linux image fixture starts the real sidecar and plugin-enabled
  V2, exercises authenticated Basic and MCP calls, closes FD 3, and runs a
  hostile same-UID poller across the native launch transition;
- the foreground process tree is terminated in the Linux CI harness; graceful
  image shutdown and non-Linux development hosts remain lifecycle gates.

The integrated foundation solved sidecar authentication and a real V2 MCP
exchange. Later beta milestones activated the root V2 server, isolated TUI,
dynamic context injection, and managed project/plugin boundaries; the remaining
work is the parity and stable-readiness scope below.

`3.0.0b1` was an explicitly experimental staged V2 foundation. It was not
eligible for mechanical promotion from 2.5 or treatment as stable-ready.

### Required vertical slice

1. Pin one exact V2 CLI and matching plugin set, plus only directly imported
   companion packages.
2. Install V2 alongside V1 and retain V1 as the rollback, LAN, and OpenChamber
   path.
3. Give V2 separate config, data, state, and cache directories under `/data` so
   opening the beta cannot mutate V1 session/auth data.
4. Select and document one exact V2 foreground process tree for s6, then prove
   startup, authentication, clean shutdown, and no orphan daemon.
5. Generate a native V2 config with explicit ordered permissions.
6. Disable project config and external plugin discovery for the initial beta.
7. Deploy core safety rules as V2-discovered `AGENTS.md`.
8. Load the bundled Home Assistant plugin from an exact local image path.
9. Run the credential-bearing Home Assistant integration as a privileged
   sidecar and have the plugin register its non-secret MCP endpoint.
10. Prove an untrusted non-root local process cannot replay the authenticated
    sidecar endpoint, and document allowed root shell execution as trusted code.
11. Support compact, configuration, and full profiles without weakening
   server-side dispatch rejection.
12. Route every current instruction source to global `AGENTS.md`, plugin context,
    or an explicit unsupported-option error.
13. Attach bounded generated briefing and decision context through the context
    hook without placing secrets in model context.
14. Keep OpenChamber disabled for V2 until upstream compatibility is released.
15. Clearly report that LSP and formatter integration are unavailable in the
    first beta unless upstream implements them before the pin is selected.
16. Build and smoke-test both amd64 and aarch64 images.

### Existing option disposition for 3.0.0b0

Every existing option must be supported, rejected with a clear startup error,
disabled with a visible migration warning, or ignored only when it is purely
visual and irrelevant. The initial target is:

| Option area | 3.0.0b0 disposition |
|---|---|
| Terminal theme, font, cursor | Supported |
| Focus mode | Supported through plugin context |
| MCP enablement and compact/configuration/full profiles | Supported |
| Home briefing and decision notes | Supported through bounded plugin context |
| Sensitive-file restrictions and add-on guidance | Supported and retested in native V2 policy/context |
| CPU mode | Supported for the V2 native packages |
| LSP and formatting | Disabled with a startup warning unless upstream implements them before the pin |
| OpenChamber and OpenChamber LAN | Rejected; V2 compatibility is not released |
| LAN OpenCode server and CORS origins | Rejected until the V2 authenticated LAN design is complete |
| Native HA MCP bridge | Deferred and rejected in b0 |
| PPQ private provider | Deferred and rejected in b0 |
| Screenshot/access-token-dependent paths | Rejected in initial b0; later owned by the privileged sidecar |
| Zigbee2MQTT and serial passthrough | Supported only through the sidecar and existing bounded tools |
| Raw `opencode_config` | Rejected until native V2 validation and plugin policy are enforceable |
| Project `opencode.json(c)`, `.opencode` config/plugins, `AGENTS.md`, and `AGENTS.local.md` | Disabled in initial b0 |
| User environment variables | Rejected initially; later requires an explicit trust and secret-exposure model |
| Startup hooks | Rejected in initial b0; later require the editable workspace lease before execution |

### User-facing V2 acceptance criteria

- The image asserts the exact resolved V2 CLI and plugin versions.
- `opencode2 --version` and help run on amd64 and aarch64.
- V1 stable remains available and unchanged; beta's V1 private roots remain an
  untouched rollback source during copy-on-write migration.
- V2 starts and stops without an orphan service or MCP child.
- The plugin appears once, unloads cleanly, and does not duplicate MCP servers
  after reload.
- The Home Assistant MCP server connects and advertises direct tools.
- Compact mode omits and rejects every mutating tool currently covered by the
  MCP profile tests.
- Configuration mode preserves its current safe configuration catalog and
  rejects control/administration tools.
- Full mode preserves the current feature-gated catalog.
- Native V2 permission denies block sensitive reads, content search, edits,
  shell, subagents, unknown actions, and denied MCP actions before dispatch
  where applicable.
- The server-side MCP profile still rejects a stale direct call.
- Static Home Assistant safety rules and dynamic bounded context reach every
  applicable model request.
- The OpenCode process environment, managed config, logs, tool output, and model
  context do not contain the Supervisor or Home Assistant access token.
- Approved edits in `/homeassistant` work without silently changing host
  ownership. Allowed full-mode shell commands are explicitly trusted container
  root code and are outside the credential-isolation claim.
- Sentinel Home Assistant credentials are absent from config, plugin options,
  process arguments, logs, tool output, and model context.
- The read-only agent and compact profile deny shell and reject denied MCP tools
  before dispatch; unrestricted root shell execution is not presented as a
  hostile-process security boundary.
- Only the bundled plugin loads; project/user plugin discovery is disabled or a
  tested trust policy is shown to the operator.
- Existing V1 contract, MCP, and LSP suites remain green.
- Through ttyd and Home Assistant Ingress, a real provider can authenticate, a
  model can answer, invoke one allowed Home Assistant MCP tool, consume its
  result, and complete the response.
- Copy-on-write V2 migration preserves the existing beta V1 data byte-for-byte,
  validates sessions and the absence of imported provider credentials before
  activation, and leaves the V1 roots usable by the previous beta image.
- OpenChamber is not started against V2.

## Investigation and Delivery Phases

### Phase 0: integrated beta foundation

- Integrate exact V2 dependencies, plugin code, and tests directly in
  `ha_opencode_beta` without publishing an incomplete tag.
- Prove plugin load/unload, MCP transform, direct tool discovery, permission
  denial, all three profile modes, plugin trust policy, and credential
  isolation.
- Add a CI lane that installs only the exact pinned V2 set and fails if npm
  resolves anything else.

### Phase 1: staged beta runtime (delivered in b0-b1)

- Add V2 runtime selection, native config generation, copy-on-write migration,
  isolated state paths, and s6 supervision to `ha_opencode_beta` only. Stable
  remains on V1.
- Bundle the plugin in the image; never install or update it at runtime.
- Extend `opencode-smoke-test` with V2 runtime, plugin, MCP, permission, context,
  process-lifecycle, and rollback probes.
- Reuse the beta image, `beta-v*` tags, changelog, and release workflows after
  making them V2-aware.
- Both architecture builds and the live `3.0.0b1` boundary check passed; at that
  milestone the staged runtime remained private while the terminal used V1.

### Phase 2: terminal-first V2 activation and beta gaps (activated in b4)

- Soak the activated V2 terminal, direct Home Assistant workspace, separate TUI
  identity, managed plugin boundary, and retained V1 rollback.
- Track working LSP and formatter execution upstream.
- Revalidate PPQ/custom-provider configuration in native V2 form.
- Test LAN authentication and replace V1 attach/CORS assumptions.
- Test V1 session migration plus fresh V2 provider authentication and document
  rollback.
- Soak the native MCP sidecar route and screenshot/access-token paths on real
  Home Assistant.
- Integrate an OpenChamber release that explicitly supports V2, then rerun all
  Ingress, OAuth, streaming, service-worker, update-policy, and asset tests.

### Phase 3: stable 3.0.0 gate

Stable 3.0.0 requires all of the following:

1. Upstream publishes a supported V2 release rather than a moving beta.
2. The plugin and server/client contracts used by the add-on are stable.
3. HA YAML LSP and formatting work without regression.
4. Terminal, LAN, read-only, MCP profiles, native MCP, PPQ, and OpenChamber all
   pass automated and real Home Assistant smoke tests.
5. V1 session/config migration, fresh V2 provider authentication, and rollback
   are demonstrated on copied persistent data.
6. Plan/read-only modes enforce non-mutation under native V2 permissions.
7. Both architectures complete a soak in the V2 beta channel.

Meeting these gates does not remove V1. The retained runtime remains the
in-container rollback and compatibility path unless a separate future decision
approves a different policy.

## Regression Cases To Retain

The original V2 risk reports are now closed, but they remain valuable tests:

- [#41081](https://github.com/anomalyco/opencode/issues/41081): mixed V1/V2
  custom-provider configuration.
- [#41346](https://github.com/anomalyco/opencode/issues/41346): V1 session-data
  migration failure.
- [#41476](https://github.com/anomalyco/opencode/issues/41476): plan-mode
  mutation.

Recheck this document whenever the selected V2 beta changes. Timestamped beta
builds move quickly, so a newer build is not accepted until the complete V2
lane passes again.
