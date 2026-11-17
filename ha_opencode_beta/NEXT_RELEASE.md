# Next beta: 3.5.2b0

Status: **development baseline prepared; not released**.

| Field | Value |
| --- | --- |
| Target beta version | `3.5.2b0` |
| Stable baseline | [`v3.5.1`](https://github.com/magnusoverli/opencode/releases/tag/v3.5.1) |
| Baseline commit | `edcc91b9570e6cfe6a7a2782a6413e5bd7069b4e` |
| Stable multi-architecture image | `ghcr.io/magnusoverli/ha_opencode:3.5.1` |
| Stable image digest | `sha256:f8fedde2b6d992d240305d2d86c4ac0cf284313d7e998c6d1aff0dc65c00c8b4` |
| Currently published beta | `3.5.1b4` |

## Implementation baseline

This series starts from the complete stable 3.5.1 implementation, including
Zigporter compatibility, HAB cache handling, project-upgrade preservation, native
V2 policies/configuration, instruction cleanup, guarded cache expiry and browser
channel isolation. Runtime pins remain OpenCode 2.3.0, OpenChamber 2.7.2 and
HAB 1.8.0. No additional feature changes are selected in this preparation.

`test/stable-baseline.test.js` checks every stable tracked runtime/build/compat
file against beta. The only runtime substitutions are beta's sidecar identity
and decision-note directory, MCP/LSP pattern-update URLs, companion owner and
native MCP migration provenance. These are exact substitutions, not whole-file
exemptions. Beta retains its own manifest, AppArmor profile, labels, history and
channel-specific test expectations.

## Development and release

1. Develop new changes in `ha_opencode_beta/` from this synchronized baseline.
   Carry stable bug fixes into beta as well. Review and explicitly test any new
   intentional shared-code differences instead of broadly exempting files.
2. Run the baseline check and beta contracts; qualify native AMD64/ARM64 images
   and installed behavior affected by the changes.
3. When publishing is authorized, set `config.yaml` to `3.5.2b0`, remove
   `(Unreleased)` from its changelog heading, and update the published-version
   wording in `DOCS.md`. Until then, keep the catalogue on the available b4 image.
4. Commit and push, require successful CI/native checks, then tag the qualified
   commit `beta-v3.5.2b0`. Verify both image architectures and release assets.

The prior beta's historical qualification records remain evidence for those
versions. A synchronized baseline is not a claim of new installed acceptance.
