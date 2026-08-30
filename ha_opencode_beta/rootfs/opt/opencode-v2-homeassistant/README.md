# OpenCode V2 Home Assistant Runtime

This package pins and tests the OpenCode V2 runtime integrated into the
`ha_opencode_beta` add-on.

Initial integration scope:

- pin the CLI and plugin API to one matching beta build;
- register one existing Home Assistant MCP sidecar through `ctx.mcp.transform`;
- leave compact/configuration/full profile selection inside the privileged
  sidecar rather than accepting a caller-controlled profile header;
- expose tools directly with `codemode: false`;
- prove plugin cleanup and reject unsafe or credential-bearing options.

It deliberately does not contain Home Assistant credentials, API clients, or
tool handlers. Image activation, OpenChamber integration, and the production
sidecar authentication design remain gated by
[`OPENCODE_V2_FUTURE.md`](../../../../OPENCODE_V2_FUTURE.md).

Run:

```bash
npm ci
npm run verify:versions
npm test
```
