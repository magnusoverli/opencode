# Stable 3.3.3 release recovery

## Scope

The public `v3.3.2` tag is retained unchanged. Its native build failed before
either architecture image or the multi-architecture manifest was published.
3.3.3 is the replacement release, retaining OpenCode 2.1.4, OpenChamber 2.5.2
and hab 1.8.0.

## Remediation

- The native provider-startup fixture now advertises a 128K context window.
  Its old 32K window could make the complete tool catalogue trigger a compaction
  request that the startup-only mock could not answer. Credential, model,
  read-tool and disabled-search assertions remain intact; production model
  limits and compaction behavior are unchanged.
- Stable and beta MCP servers use patched Zod 4.6.7 or later compatible 4.x.
  The existing SDK supports Zod 4; no MCP tool/profile policy was relaxed.
- Both private-inference runtimes pin Zod 4.6.7 and undici 7.30.1, retaining
  tinfoil 1.2.1, tsx 4.23.15 and the encrypted-only request policy.
- Beta changes are the separately approved security dependencies and changelog
  only. No beta version, runtime pin, tag or image release is changed.

## Local evidence

- Stable MCP suite: 743 passed, 4 skipped.
- Beta MCP suite: 731 passed, 4 skipped.
- Both MCP production audits and both private-inference production audits:
  zero reported vulnerabilities.
- Stable private-inference/provider/runtime contracts: 46 passed; beta
  private-inference contracts: 11 passed. These include importing the real
  encryption SDK and rejecting plaintext fallback.

## Remote validation

Candidate commit: `358c8190c25ad3a927909d87e42fe68f2ecf85c8`.

- [Native stable images](https://github.com/magnusoverli/opencode/actions/runs/40283843678): passed on native amd64 and arm64 runners, including the complete `boundary-test` target and corrected provider-startup fixture.
- [Shared PR checks](https://github.com/magnusoverli/opencode/actions/runs/40283843679): passed, including both channels' production audits, root privilege-boundary contracts, MCP suites, companion tests and language-server checks.

The shared CI records 545 stable and 536 beta add-on contract passes (7 skips
each), plus 29 external-MCP root checks, 31 startup-persistence root checks,
one durable-TUI check and one native provider-credential check per channel.
Those root/compiler checks were actually executed in CI, not inferred from the
local non-root runs.

The separately triggered [beta image check](https://github.com/magnusoverli/opencode/actions/runs/40283843682)
fails on beta's older OpenChamber dependency lock (body-parser 2.3.0, undici
6.29.0 and Zod 4.3.6). The approved beta work is limited to MCP/private-inference
dependencies; it does not update or release beta's OpenChamber image. That audit
is not suppressed and is independent of stable's image validation/publication.

Release publication is not established by a GitHub release page alone. Both
architecture images, the multi-architecture manifest and the matching release
image assets must be verified after the tagged build. Installed Supervisor
upgrade/rollback acceptance is separate; no live Home Assistant was changed here.
