# OpenCode V2 Readiness

This document records confirmed OpenCode V2 beta changes, the proposed Home
Assistant plugin architecture, and the release gates for the 2.6 line. It is an
engineering plan, not a claim that V2 is ready for stable users.

## Status Snapshot

Captured on 2026-08-28:

- Stable OpenCode is `opencode-ai@1.18.25` and remains the certified runtime in
  stable add-on 2.5.3.
- V2 is an active beta published separately as `@opencode-ai/cli`. The beta tag
  pointed to `0.0.0-beta-18600` when this snapshot was taken and installs the
  `opencode2` command.
- Companion V2 packages used the same exact beta version. A V2 spike must pin
  the CLI and its direct first-party plugin dependency graph; direct client or
  server dependencies are added only if add-on code imports them. It must never
  consume the moving `beta`, `next`, or `dev` tag in an image or lockfile.
- V1 and V2 are designed to install side by side. The first experiments must
  leave `/usr/local/bin/opencode` and all stable services on V1.
- V2's plugin and server APIs are explicitly beta and may continue to change.
- The current V2 branch is `v2`, not the old `2.0` branch.
- OpenChamber's V2 compatibility work is still open in
  [openchamber/openchamber#3007](https://github.com/openchamber/openchamber/pull/3007).
  OpenChamber must not be pointed at V2 until compatible support is released and
  its Home Assistant Ingress behavior is revalidated.

Sources:

- [V2 migration guide](https://opencode.ai/v2/docs/migrate-v1)
- [V2 configuration](https://opencode.ai/v2/docs/config)
- [V2 plugin API](https://opencode.ai/v2/docs/build/plugins)
- [V2 MCP servers](https://opencode.ai/v2/docs/mcp-servers)
- [V2 permissions](https://opencode.ai/v2/docs/permissions)
- [V2 branch](https://github.com/anomalyco/opencode/tree/v2)

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
still need to start successfully in the Home Assistant Debian Trixie images;
the x64 baseline package must also be tested on a host without AVX2.

V2 is daemon-first. Its shared daemon, client-owned `--standalone` server, and
explicit `serve` process have different ownership models. Phase 0 must choose
one exact foreground process tree that s6 can own; `2.6.0b0` cannot ship while
that process tree, authentication, shutdown, and orphan cleanup are ambiguous.
The current V1 LAN service cannot be renamed mechanically:

- V2 `serve` does not accept V1's `--cors` option.
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
explicit destination: `AGENTS.local.md`, MCP/profile guidance, focus mode, and
startup-hook guidance can be added by the plugin; bounded briefing and decision
context can use its per-model-call `session.context` hook. The hook must be
proven to reach initial and tool-continuation requests without duplicating
context before a user-facing V2 beta starts.

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
Unprivileged OpenCode V2 + bundled Home Assistant plugin
  - MCP registration and lifecycle transform
  - bounded dynamic context hook
  - optional status/help commands
             |
             +--> HA integration sidecar (authenticated loopback MCP transport)
             +--> HA YAML LSP (independent; blocked until V2 runs LSP)
```

### Plugin responsibilities

The first plugin should:

1. Register the sidecar's `homeassistant` MCP endpoint with `ctx.mcp.transform`.
2. Preserve `OPENCODE_MCP_TOOL_PROFILE` and server-side dispatch rejection.
3. Leave native MCP disabled until its sidecar path and profile enforcement are
   separately verified.
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

The V1 process currently inherits `SUPERVISOR_TOKEN`, which means shell access
or any in-process plugin can expose it. V2 must not repeat that design. The
OpenCode process should run as an unprivileged user without the Supervisor token
or Home Assistant access tokens. A separately supervised, more privileged
integration sidecar should own those credentials and expose only the
profile-filtered MCP contract over authenticated loopback Streamable HTTP, which
V2 supports as a remote MCP server. A bare localhost port is not a boundary:
shell commands could call it directly and bypass OpenCode permission checks.
Phase 0 must design an ephemeral caller credential and OS process boundary that
the bundled plugin can use but shell subprocesses cannot recover from config,
environment, files, `/proc`, logs, or process arguments.

The unprivileged process must still perform approved edits under
`/homeassistant`. Phase 0 must choose and test UID/GID, ACL, capability, or a
separate safe-write mechanism without silently changing host ownership or
making the sidecar process readable. If both file-write capability and process
isolation cannot be achieved in the Home Assistant base image, the sidecar
design is blocked rather than weakened.

Model-provider credentials are a separate category: OpenCode may legitimately
need them, while optional PPQ and Home Assistant credentials can remain in
sidecars. The spike must inventory each secret source and document whether it is
available to shell tools. User-supplied environment variables are trusted
arbitrary process input, not covered by a blanket non-disclosure promise.

V2 auto-discovers local plugins. `2.6.0b0` must disable project/user plugin
discovery or enforce a tested allowlist containing only the exact bundled
plugin. If V2 provides no enforceable mechanism, user/project plugins must be
explicitly classified as trusted arbitrary code and the beta cannot claim that
only audited plugin code executes. No plugin may be installed or updated at
runtime.

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

## Proposed 2.6.0b0 Scope

`2.6.0b0` should be an explicitly experimental, terminal-only V2 beta. It must
not be promoted mechanically from 2.5 or treated as stable-ready.

### Required vertical slice

1. Pin one exact V2 CLI and matching plugin set, plus only directly imported
   companion packages.
2. Install V2 alongside V1 during development; retain V1 as the rollback path.
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
10. Prove the authenticated sidecar endpoint cannot be replayed from a shell
    subprocess or another local process.
11. Support compact, configuration, and full profiles without weakening
   server-side dispatch rejection.
12. Route every current instruction source to global `AGENTS.md`, plugin context,
    or an explicit unsupported-option error.
13. Attach bounded generated briefing and decision context through the context
    hook without placing secrets in model context.
14. Keep OpenChamber disabled for V2 until upstream compatibility is released.
15. Clearly report that LSP and formatter integration are unavailable in the
    first preview unless upstream implements them before the pin is selected.
16. Build and smoke-test both amd64 and aarch64 images.

### Existing option disposition for b0

Every existing option must be supported, rejected with a clear startup error,
disabled with a visible migration warning, or ignored only when it is purely
visual and irrelevant. The initial target is:

| Option area | 2.6.0b0 disposition |
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
| Project `opencode.json(c)`, `.opencode` config and plugins | Disabled in initial b0 |
| User environment variables | Rejected initially; later requires an explicit trust and secret-exposure model |
| Startup hooks | Supported under the existing explicit root-code trust model; guidance must reach V2 context |

### 2.6.0b0 acceptance criteria

- The image asserts the exact resolved V2 CLI and plugin versions.
- `opencode2 --version` and help run on amd64 and aarch64.
- V1 remains available and unchanged during the engineering spike.
- V2 starts and stops without an orphan service or MCP child.
- The plugin appears once, unloads cleanly, and does not duplicate MCP servers
  after reload.
- The Home Assistant MCP server connects and advertises direct tools.
- Compact mode omits and rejects every mutating tool currently covered by the
  MCP profile tests.
- Configuration mode preserves its current safe configuration catalog and
  rejects control/administration tools.
- Full mode preserves the current feature-gated catalog.
- Native V2 permission denies block sensitive reads, edits, shell, subagents,
  and denied MCP actions before dispatch where applicable.
- The server-side MCP profile still rejects a stale direct call.
- Static Home Assistant safety rules and dynamic bounded context reach every
  applicable model request.
- The OpenCode process environment does not contain the Supervisor or Home
  Assistant access token, and its OS user cannot read the sidecar environment.
- Approved edits in `/homeassistant` still work without granting access to the
  sidecar's credentials or silently changing host ownership.
- Sentinel Home Assistant credentials are absent from config, plugin options,
  process arguments, logs, tool output, and model context.
- A direct shell or local-process request cannot authenticate to the sidecar MCP
  endpoint or invoke a tool outside OpenCode's permission path.
- Only the bundled plugin loads; project/user plugin discovery is disabled or a
  tested trust policy is shown to the operator.
- Existing V1 contract, MCP, and LSP suites remain green.
- Through ttyd and Home Assistant Ingress, a real provider can authenticate, a
  model can answer, invoke one allowed Home Assistant MCP tool, consume its
  result, and complete the response.
- Fresh isolated V2 state does not modify the existing V1 data, and V1 can
  resume after the V2 test. Copied-data migration remains a later beta gate.
- OpenChamber is not started against V2.

## Investigation and Delivery Phases

### Phase 0: isolated plugin spike

- Create a non-shipping spike with exact beta dependencies.
- Prove plugin load/unload, MCP transform, direct tool discovery, permission
  denial, all three profile modes, plugin trust policy, and credential
  isolation.
- Add a CI lane that installs only the exact pinned V2 set and fails if npm
  resolves anything else.

### Phase 1: beta image integration

- Add V2 runtime selection, native config generation, isolated state paths, and
  s6 supervision to `ha_opencode_beta` only.
- Bundle the plugin in the image; never install or update it at runtime.
- Extend `opencode-smoke-test` with V2 runtime, plugin, MCP, permission, context,
  process-lifecycle, and rollback probes.
- Release `2.6.0b0` only after both architecture builds pass.

### Phase 2: close beta gaps

- Track working LSP and formatter execution upstream.
- Revalidate PPQ/custom-provider configuration in native V2 form.
- Test LAN authentication and replace V1 attach/CORS assumptions.
- Test V1 session/auth migration on copied data and document rollback.
- Add native MCP and screenshot/access-token paths to the privileged sidecar.
- Integrate an OpenChamber release that explicitly supports V2, then rerun all
  Ingress, OAuth, streaming, service-worker, update-policy, and asset tests.

### Phase 3: stable 2.6.0 gate

Stable 2.6.0 requires all of the following:

1. Upstream publishes a supported V2 release rather than a moving beta.
2. The plugin and server/client contracts used by the add-on are stable.
3. HA YAML LSP and formatting work without regression.
4. Terminal, LAN, read-only, MCP profiles, native MCP, PPQ, and OpenChamber all
   pass automated and real Home Assistant smoke tests.
5. V1 session/config/auth migration and rollback are demonstrated on copied
   persistent data.
6. Plan/read-only modes enforce non-mutation under native V2 permissions.
7. Both architectures complete a soak in the beta channel.

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
