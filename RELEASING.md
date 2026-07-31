# Releasing

Two channels, two folders.

| | Folder | Tag | Image | Add-on shown in HA |
|---|---|---|---|---|
| **Stable** | `ha_opencode/` | `v2.3.8` | `ghcr.io/magnusoverli/ha_opencode` | OpenCode |
| **Beta** | `ha_opencode_beta/` | `beta-v2.3.9b2` | `ghcr.io/magnusoverli/ha_opencode_beta` | OpenCode Beta |

Each folder is a complete add-on: its own `Dockerfile`, its own `rootfs/`, its
own `config.yaml`. Both live on `main`, and both release from `main`.

**What separates the channels is the folder, and nothing else.** A stable
release builds `ha_opencode/`; it cannot contain something that only exists in
`ha_opencode_beta/`. No branch discipline is required to make that true — it is
true by construction.

This is the layout ESPHome (`esphome/`, `esphome-beta/`, `esphome-dev/`) and
Frigate (`frigate/`, `frigate_beta/`, …) use, and it exists because Home
Assistant reads add-on definitions from the **default branch only**. It never
sees any other branch.

## The one rule

`rootfs/` must never name a channel.

Promotion is a straight copy of `ha_opencode_beta/rootfs/` over
`ha_opencode/rootfs/`. A hardcoded `"beta"` anywhere in that tree would travel
with the copy and mislabel stable. Channel identity comes from a single Docker
build arg:

```
ADDON_CHANNEL=beta      # passed by .github/workflows/build-beta.yaml
ADDON_CHANNEL=stable    # passed by .github/workflows/build.yaml
```

Shell code reads it through `rootfs/usr/local/lib/opencode/channel.sh`; Node
code reads `process.env.ADDON_CHANNEL`. Add new channel-dependent values to
`channel.sh` rather than branching on the variable at each call site.

`scripts/promote-beta-to-stable.sh` enforces this: it refuses to finish if
stable's `rootfs/` names the beta channel after a copy.

## Everyday work

### A change that should only go to beta

```bash
git checkout main
git pull
# ...edit ha_opencode_beta/rootfs/... , add a section to ha_opencode_beta/CHANGELOG.md...
git commit -am "feat: the thing"
git push
git tag beta-v2.3.9b3 && git push origin beta-v2.3.9b3
```

The code only exists in `ha_opencode_beta/`, so a stable release physically
cannot contain it. No feature flag, no branch, no forward-merge.

### A small fix that should ship as stable now

```bash
git checkout main
git pull
# ...fix it in ha_opencode/, add a "## 2.3.8" section to ha_opencode/CHANGELOG.md...
git commit -am "fix: the thing"
git push
git tag v2.3.8 && git push origin v2.3.8
```

If the fix belongs in both channels, make it in both folders in the same
commit. There is no automation for that, and deliberately so: the two folders
are allowed to differ, and a bot cannot tell "beta hasn't got this yet" from
"beta does it differently on purpose".

### Promoting beta to stable

```bash
scripts/promote-beta-to-stable.sh --check    # what would change
scripts/promote-beta-to-stable.sh            # copy beta's code onto stable
# ...write the "## 2.3.8" section in ha_opencode/CHANGELOG.md...
git commit -am "release: promote 2.3.9b2 to stable 2.3.8"
git push
git tag v2.3.8 && git push origin v2.3.8
```

The script copies `Dockerfile`, `.dockerignore`, `rootfs/` and `test/`. It does
**not** copy `config.yaml`, `build.yaml`, `translations/`, `DOCS.md`,
`CHANGELOG.md` or the icons — those carry each channel's identity, and copying
them would publish beta's slug and panel title as stable.

`OPENCHAMBER_VERSION` in `build.yaml` is a genuine per-channel pin and is not
copied either. The script reports when the two differ so a soak that finished
in beta is not silently left behind.

## Version numbering

Beta versions are `<next-stable>b<N>` — `2.3.9b0`, `2.3.9b1`, … then stable
ships as `2.3.9`.

**Never publish a lower version than what is already on `main`.** Supervisor's
update check is `version != latest_version`, not `>`, so a lower number is
offered to every user as an update and pulls older code. Both release workflows
refuse to do this, but don't rely on it — always go forward.

## What CI does

Tagging is the trigger for everything.

| Workflow | Trigger | What it does |
|---|---|---|
| `build.yaml` | `v*` | Builds + pushes the stable image from `ha_opencode/` (amd64 + aarch64, then a multi-arch manifest) |
| `release.yaml` | `v*` | Writes `version:` into `ha_opencode/config.yaml` on main, creates the GitHub Release |
| `build-beta.yaml` | `beta-v*` | Same, from `ha_opencode_beta/`, with `ADDON_CHANNEL=beta` |
| `release-beta.yaml` | `beta-v*` | Writes `version:` into `ha_opencode_beta/config.yaml` on main, creates a prerelease |
| `check-hab-update.yaml` | weekly | Reports the `HAB_VERSION` pin in both Dockerfiles against the latest hab release |

Guards that will stop you:

- **Wrong branch.** A tag not reachable from `main` hard-fails. Both channels
  release from main.
- **main moved past the tag.** If the channel's own folder differs between the
  tag and main's tip, the release stops — otherwise the published storefront
  would describe an image built from different code. Each release only compares
  its own folder, so the channels do not block each other.
- **Downgrade.** Publishing a version lower than the one on main is refused.
- **Wrong folder.** Each build asserts the `slug:` in the folder it is building
  before pushing anything, so a beta image can never be published carrying the
  stable slug.
- **Silent sed failures.** Every rewrite of `version:`/`image:` is asserted
  afterwards.
- **Race between the two release workflows.** They share a `concurrency` group,
  so a `v*` and a `beta-v*` pushed together queue instead of one dying on a
  non-fast-forward with its images already public.

## What happened to `dev`

Nothing releases from it any more. Channels are folders now, so the branch that
used to *be* the beta channel has no special role — with it went
`channel-sync.yaml`, the forward-merge PR bot, and the cross-branch metadata
copy in `release-beta.yaml`.

Keep using `dev` (or any branch) as an ordinary integration branch for work in
progress if you like. Merge it into `main` when it is ready. The thing it must
no longer do is carry a release.

## Both add-ons on one machine

They are separate add-ons with separate slugs, so `/data` — sessions, the
OpenCode binary, generated context, credentials — is already fully isolated.
The configuration directory is not: both mount `/homeassistant`.

Split per channel:

- `/homeassistant/opencode/decisions.yaml` (stable) and
  `/homeassistant/opencode_beta/decisions.yaml` (beta). On first start, beta
  copies stable's notes across so an existing beta user does not lose their
  history. It copies rather than moves — stable's notes are still stable's.

- `AGENTS.md`. **Stable owns `/homeassistant/AGENTS.md`; beta never writes to
  the configuration directory at all.** Beta keeps its copy at
  `/data/context/AGENTS.md` and lists it in OpenCode's `instructions`, next to
  the briefing and the decision digest.

  This is not symmetry for its own sake. Only one file in the configuration
  directory can be called `AGENTS.md` — OpenCode finds it by convention from
  the working directory, not from anything we configure — so if both channels
  deployed it, the add-on that started last would own it. And the two copies
  are not interchangeable: beta's documents capabilities only beta's build
  ships (`call_service` returning service response data, backed by
  `lib/service-response.js`, which stable does not have). A stable session
  reading beta's file would be instructed to use a tool it does not have.

  Keeping stable as the sole owner leaves the remaining overlap pointing the
  only harmless way: a stable session now reads only stable's instructions,
  while a beta session additionally picks up stable's file through the working
  directory. That under-describes beta rather than mis-describing it.

  Stable's ownership marker lives at `/homeassistant/.opencode_agents_md.sha256`,
  beside the file it describes rather than in `/data` — `/data` is wiped on
  reinstall while the configuration directory is not, so a marker there made a
  reinstall look like a hand edit and left a spurious `.bak`.

  A beta add-on upgrading from the old scheme deletes its own leftover
  `/homeassistant/AGENTS.md`, but only when the file still hashes to what beta
  last wrote. A user-edited file, or stable's, is never touched.

Deliberately shared:
- `/homeassistant/AGENTS.local.md`. The user's own file; the add-on never
  writes it.
- `/homeassistant/.prettierrc.yaml` and `AGENTS.local.md.example`, both
  deployed only when absent.

Ports do **not** collide. The `ports:` keys in `config.yaml` are *container*
ports and each add-on has its own network namespace; the host side is null
(unmapped) by default. If you map both add-ons' LAN ports, give them different
host ports.

## If something goes wrong

Snapshots from the day the branch-based split was set up:

```bash
git log --oneline backup/main-pre-switch    # main as it was
git log --oneline archive/dev-pre-switch    # the original dev
```

To un-publish a bad release: delete the tag locally and remotely, then push a
**higher** version with the fix. Never re-point a published tag — GHCR images
and the GitHub Release already reference it, and a moved tag means a pinned
`version:` no longer pins fixed bytes.

## Known gaps

Things deliberately not fixed yet, so they don't surprise you:

- **A beta session still reads stable's `AGENTS.md`** when both add-ons are
  installed, because OpenCode discovers it from the working directory and
  nothing the add-on controls can prevent that. It is the harmless direction —
  beta ends up over-informed rather than mis-instructed — but it does mean a
  beta session carries both files' worth of instructions. Closing it entirely
  would need OpenCode to support disabling convention-based discovery.

- **Version-before-image race.** `release.yaml` writes the new version to main
  in about a minute; the two-arch build takes 10–15. In that window HA offers
  an update whose image doesn't exist yet, and `docker pull` 404s. If the build
  fails outright, main advertises a version that will never exist until you fix
  it by hand. Fixing this properly means gating the version write on the GHCR
  manifest existing.
- **The storefront is main's tip, not the tag's.** The release workflows edit
  `config.yaml` in place on main rather than rendering it from the tag. The
  "main moved past the tag" guard makes the mismatch loud instead of silent,
  but the underlying design is unchanged.
- **`bashio::config 'key' || echo "default"` is dead code** (~30 call sites).
  For a key absent from `options.json`, bashio returns its `default_value`
  argument — which is itself the literal string `null` when you don't pass one
  — and exits 0, so `||` never fires. The fix is the second argument, not `||`:
  `bashio::config 'restrict_sensitive_files' 'true'`.

  This matters now that the two channels can genuinely diverge: add an option
  to one channel's `config.yaml` and the other gets `null`, not your default.
  Today that would leave `restrict_sensitive_files` on the *unsafe* side,
  because it is declared `|| echo "true"` but tested `= "true"`. Both channels
  currently declare all 28 options identically, so nothing is live.
