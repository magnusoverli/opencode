# Repository Agent Guidance

## Default Development Environment

The official Home Assistant Apps devcontainer is the default environment for
developing this repository. It runs real Supervisor and Home Assistant
containers and exposes this repository as local apps.

- Start runtime-affecting work from `.devcontainer/devcontainer.json`. Do not
  install or approximate Supervisor directly on the host.
- Use the canonical VS Code task sequence in `.vscode/tasks.json`: **Start Home
  Assistant**, **Install App**, then **Start App** for the first run. Use
  **Rebuild and Start App** while iterating, **Run App Acceptance** after
  runtime/lifecycle changes, and **Show App Logs** for diagnostics.
- Select `ha_opencode` for stable or `ha_opencode_beta` for beta. Do not infer a
  channel from the current branch; both channels live on `main`.
- Build working-tree images with `scripts/devcontainer-build-app.sh`, as the
  tasks do. Do not use `ha apps rebuild --force`: because production
  `config.yaml` declares `image:`, Supervisor can re-pull the published image
  instead of building the checkout.
- Treat successful Supervisor install/start, s6 service state, Home Assistant
  Core Ingress routing, and `scripts/devcontainer-acceptance.sh` results from
  this environment as local lifecycle evidence. The
  devcontainer is not HAOS and does not prove host-level HAOS behavior.
- Host-side reads, edits, and focused static/unit tests are acceptable when they
  do not need the app runtime. Do not substitute host Docker or local QEMU for
  the devcontainer when validating Supervisor/s6 behavior.
- Arm64 acceptance runs on GitHub's native ARM runner. Local emulated arm64
  builds are optional diagnostics and never a release gate.
- If the devcontainer cannot run, report that limitation and the unverified
  lifecycle behavior instead of silently using a lower-fidelity substitute.

## Verification Budget

Use the smallest verification step that provides direct evidence for the change.
Testing should support development rather than repeatedly delay it.

- During routine development, run one targeted verification pass for the files or package changed.
- Run static checks only when they apply to the touched language or are explicitly required by existing repository guidance.
- Do not run full repository suites, Docker image builds, or multi-architecture builds by default.
- Reserve broad and multi-architecture verification for release readiness, an explicit user request, or a change that directly affects packaging or architecture-specific behavior.
- For authentication, privilege boundaries, migrations, and destructive behavior, add or run one focused integration scenario that exercises the changed boundary. Do not expand this into unrelated exhaustive testing.
- If the same expensive verification fails twice, stop rerunning the broad command. Isolate the failure with a smaller reproduction, make the fix, and perform at most one broad confirmation run when justified.
- Do not rerun passing checks unless subsequent edits could affect what they covered.
- Report any verification not performed and the resulting residual risk instead of pursuing complete coverage automatically.
- Always honor a test command explicitly requested by the user and mandatory checks stated elsewhere in repository guidance.

Before starting an expensive verification step, prefer asking the user when its value is uncertain.
