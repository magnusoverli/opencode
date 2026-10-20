# 3.2.4b0 PPQ discovery beta

## Scope

- Based on released stable `v3.2.3` (`303fbb4`), preserving beta app identity,
  storage, companion ownership and migration-journal channel.
- Includes stable's desktop/mobile missing-workspace recovery and its UI build,
  component, browser and Node contracts. The post-release Zigporter compatibility
  patch from `c47b3c5` is intentionally not part of this beta.
- Retains OpenCode CLI/plugin 2.0.26, OpenChamber 2.2.0 and HAB 1.7.2.
- Adds issue #188's live private-only PPQ catalog, bounded offline cache, dynamic
  V2 provider registration and an image-owned HTTP adapter around the already
  pinned Tinfoil SDK. No public inference fallback or automatic model replacement.

## Local evidence

- Reinstalled both channel runtime trees and verified the official CLI/plugin
  pins. The provider fixture now asserts the running server version, avoiding
  qualification against stale local node_modules.
- 75 focused PPQ/provider/runtime contracts passed per channel on Windows,
  including the real 2.0.26 resolver, streaming through the shipped HTTP adapter,
  newly discovered IDs and retired-private-default protection.
- Public, anonymous catalog inspection found six eligible private chat models;
  matching Tinfoil metadata supplied capabilities. No inference was requested.
- Both standalone PPQ dependency audits reported zero vulnerabilities.

## Release gates and limits

- GitHub Linux contract and native amd64/arm64 image checks must pass before
  cutting the release tag; local Docker is unavailable.
- Windows full-suite execution is not qualification: POSIX permission-dependent
  Assist tests fail there and the broad run timed out.
- Account-backed encrypted PPQ inference, affected-host verification, installed
  Supervisor upgrade and rollback acceptance remain unverified.
- Stable's advertised version stays 3.2.3. Installing beta does not import stable
  sessions, credentials or configuration.
