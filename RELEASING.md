# Releasing

Two channels, two branches.

| | Branch | Tag | Image | Add-on shown in HA |
|---|---|---|---|---|
| **Stable** | `main` | `v2.3.8` | `ghcr.io/magnusoverli/ha_opencode` | OpenCode |
| **Beta** | `dev` | `beta-v2.3.8b3` | `ghcr.io/magnusoverli/ha_opencode_beta` | OpenCode Beta |

`dev` is `main` plus whatever is still cooking. Both add-ons are built from the
**same** source tree — `ha_opencode/` (Dockerfile + rootfs). What separates the
channels is *which branch the tag sits on*, and nothing else.

`ha_opencode_beta/` holds no code. It is metadata only: `config.yaml`,
`translations/`, `DOCS.md`, `CHANGELOG.md`, `build.yaml`, icons.

## Why the metadata lives on main

Home Assistant clones this repository and reads add-on definitions from the
**default branch only**. It never sees `dev`. So `main` must always carry a
correct `ha_opencode_beta/config.yaml`, even though beta code lives on `dev`.

`release-beta.yaml` handles this: when you tag `beta-v*` on `dev`, it checks
out `main`, copies `ha_opencode_beta/` across from the tagged commit, sets the
version, and pushes that to `main`. You never do it by hand.

The practical consequence: **`main` receives bot commits after every beta
release.** That is expected, and `dev` needs to pick them up — see
[Keeping dev in sync](#keeping-dev-in-sync).

## Everyday work

### A change that should only go to beta

```bash
git checkout dev
git pull
# ...edit ha_opencode/rootfs/... , update ha_opencode_beta/CHANGELOG.md...
git commit -am "feat: the thing"
git push
git tag beta-v2.3.8b3 && git push origin beta-v2.3.8b3
```

The code is on `dev` only, so a stable release cut from `main` physically
cannot contain it. No feature flag needed.

### A small fix that should ship as stable now

```bash
git checkout main
git pull
# ...fix it, add a "## 2.3.8" section to ha_opencode/CHANGELOG.md...
git commit -am "fix: the thing"
git push
git tag v2.3.8 && git push origin v2.3.8
```

Unfinished beta work on `dev` cannot reach this release. Afterwards, merge
`main` into `dev` so beta doesn't regress the fix — CI will open that PR for
you within a day, or do it yourself:

```bash
git checkout dev && git merge main && git push
```

### Promoting beta to stable

```bash
git checkout main
git pull
git merge dev            # or cherry-pick just the parts that are ready
# ...write the "## 2.3.8" section in ha_opencode/CHANGELOG.md...
git commit
git push
git tag v2.3.8 && git push origin v2.3.8
```

Then start the next beta line on `dev` (`2.3.9b0`, or `2.4.0b0` if it's big).

## Version numbering

Beta versions are `<next-stable>b<N>` — `2.3.8b0`, `2.3.8b1`, … then stable
ships as `2.3.8`. Current state: stable `2.3.7`, beta `2.3.8b2`, so the next
beta is `2.3.8b3`.

**Never publish a lower version than what is already on `main`.** Supervisor's
update check is `version != latest_version`, not `>`, so a lower number is
offered to every user as an update and pulls older code. Both release
workflows now refuse to do this, but don't rely on it — always go forward.

## What CI checks

Tagging is the trigger for everything. Four workflows fire:

| Workflow | Trigger | What it does |
|---|---|---|
| `build.yaml` | `v*` | Builds + pushes the stable image (amd64 + aarch64, then a multi-arch manifest) |
| `release.yaml` | `v*` | Writes `version:` into `ha_opencode/config.yaml` on main, creates the GitHub Release |
| `build-beta.yaml` | `beta-v*` | Same, for the beta image |
| `release-beta.yaml` | `beta-v*` | Syncs `ha_opencode_beta/` from the tag onto main, creates a prerelease |

Guards that will stop you:

- **Wrong branch.** A `v*` tag not reachable from `main`, or a `beta-v*` tag
  not reachable from `dev`, hard-fails with an explanation.
- **main moved past the tag.** If `ha_opencode/` differs between the tag and
  main's tip, the release stops — otherwise the published storefront would
  describe an image that was built from different code. (main is still allowed
  to move for beta-only reasons; only `ha_opencode/` is compared.)
- **Downgrade.** Publishing a version lower than the one on main is refused.
- **Silent sed failures.** Every rewrite of `version:`/`image:` is asserted
  afterwards. Previously an unmatched pattern looked identical to success.
- **Race between the two release workflows.** They now share a `concurrency`
  group, so a `v*` and a `beta-v*` pushed together queue instead of one dying
  on a non-fast-forward with its images already public.

`channel-sync.yaml` runs on pushes to main, daily, and on demand. When `main`
has commits `dev` lacks, it opens a `main → dev` PR and keeps it updated; when
they're back in sync it closes it. The daily run exists because the release
bots push with `GITHUB_TOKEN`, and GitHub does not fire `push` triggers for
those commits.

## Keeping dev in sync

Merge `main` into `dev` whenever the sync PR appears. Merge that direction
only — `dev` → `main` happens at promotion time, deliberately, not routinely.

If you skip it for a long time, the beta metadata sync commits pile up and the
eventual merge conflicts in `ha_opencode_beta/CHANGELOG.md`. Resolve by
keeping both sides' entries in version order.

## Known gaps

Things deliberately not fixed yet, so they don't surprise you:

- **`build.yaml` (the add-on ones, not the workflow) is almost entirely
  inert.** CI passes only `BUILD_FROM`, `BUILD_VERSION`, `BUILD_ARCH` — plus
  `OPENCHAMBER_VERSION` for beta, scraped from `ha_opencode_beta/build.yaml`.
  Every other pin (`OPENCODE_VERSION`, `TSX_VERSION`, `TTYD_VERSION`,
  `PPQ_PROXY_VERSION`, `YQ_VERSION`, `HAB_VERSION`) resolves from the `ARG`
  defaults in `ha_opencode/Dockerfile`. The values currently match, so nothing
  looks broken — but **editing a version in `build.yaml` has no effect.**
  Change the Dockerfile. `OPENCHAMBER_VERSION` in
  `ha_opencode_beta/build.yaml` is the one genuine per-channel pin, and now
  that beta builds from `dev` it finally does something useful.
- **Version-before-image race.** `release.yaml` writes the new version to main
  in about a minute; the two-arch build takes 10–15. In that window HA offers
  an update whose image doesn't exist yet, and `docker pull` 404s. If the
  build fails outright, main advertises a version that will never exist until
  you fix it by hand. Fixing this properly means gating the version write on
  the GHCR manifest existing.
- **The stable storefront is main's tip, not the tag's.** `release.yaml` edits
  `ha_opencode/config.yaml` in place on main rather than rendering it from the
  tag. The new "main moved past the tag" guard makes the mismatch loud instead
  of silent, but the underlying design is unchanged.
- **`bashio::config 'key' || echo "default"` is dead code** (~30 call sites).
  `bashio::config` prints the literal string `null` and exits 0 for a key
  absent from `options.json`, so the fallback never runs. This matters if you
  ever add an option to only one channel's `config.yaml`: the other channel
  gets `null`, not your default. `restrict_sensitive_files` would fail to the
  *unsafe* side that way. Prefer keeping schemas identical across channels and
  separating behaviour by branch instead.

## If something goes wrong

Both branches have a snapshot from the day the split was set up:

```bash
git log --oneline backup/main-pre-switch    # main as it was
git log --oneline archive/dev-pre-switch    # the original dev
```

To un-publish a bad release: delete the tag locally and remotely, then push a
**higher** version with the fix. Never re-point a published tag — GHCR images
and the GitHub Release already reference it, and a moved tag means a pinned
`version:` no longer pins fixed bytes.
