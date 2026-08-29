# OpenCode V2 Home Assistant Plugin Spike

This non-shipping package exercises the exact OpenCode V2 beta plugin contract
before any V2 code enters an add-on image.

Current scope:

- pin the CLI and plugin API to one matching beta build;
- register one existing Home Assistant MCP sidecar through `ctx.mcp.transform`;
- leave compact/configuration/full profile selection inside the privileged
  sidecar rather than accepting a caller-controlled profile header;
- expose tools directly with `codemode: false`;
- prove plugin cleanup and reject unsafe or credential-bearing options.

It deliberately does not contain Home Assistant credentials, API clients, tool
handlers, image/runtime changes, OpenChamber integration, or a production
sidecar authentication design. Those remain gated by
[`OPENCODE_V2_FUTURE.md`](../../OPENCODE_V2_FUTURE.md).

Run:

```bash
npm ci
npm run verify:versions
npm test
```
