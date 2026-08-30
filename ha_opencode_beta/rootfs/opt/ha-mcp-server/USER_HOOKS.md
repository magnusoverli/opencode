# Startup Hooks

The user has turned on **startup hooks**. They can ask you to write one.

A startup hook is a `.sh` file in `startup.d/` inside the add-on's folder in the
Home Assistant configuration directory. Every hook runs once, as root, each time
the add-on starts. Run `ha-hooks list` to see the exact folder path and what is
already there — do not guess the path.

This is the supported way to add something to the add-on. Editing anything under
`/etc`, `/usr` or `/opt` does not survive a restart; only `/data` and the
configuration directory do.

## Rules you must follow when writing a hook

- Name it with a number prefix so its order is explicit: `20-thing.sh`. Hooks run
  in filename order.
- Start it with `#!/usr/bin/env bash` and `set -euo pipefail`.
- **Never use `set -x`.** The hook environment contains `SUPERVISOR_TOKEN`,
  `HA_TOKEN` and any keys the user configured, and the log is a file they may
  share.
- **The hook must return.** It is killed after 15 minutes. To raise that, put
  `# opencode-hook-timeout: <seconds>` in the first 10 lines (`0` = no limit).
- Make it safe to run twice. It runs on every start, and the user can re-run it
  with `ha-hooks run`.

## Anything long-running

A server started in the foreground is killed when the hook returns or times out.
It must be detached with `setsid`, redirected to its own log, and guarded:

```sh
if pgrep -f "/data/myapp/server.py" >/dev/null 2>&1; then exit 0; fi
setsid /data/venvs/myapp/bin/python3 -u /data/myapp/server.py \
    >/data/myapp.log 2>&1 </dev/null &
```

Nothing restarts it if it dies. Say so when you write one — do not imply the
add-on supervises it.

## Dependencies

- **Python**: create a venv under `/data` (`python3 -m venv /data/venvs/<name>`)
  and call its `bin/python3` by full path. Never `pip install --user` — that
  path contains the Python version and vanishes on an image update. There is no
  compiler-headers package, so prefer packages that ship wheels.
- **Node**: `npm install --prefix /data/<name>`. Never `npm install -g` — that
  prefix is shared with the add-on's own OpenCode updates.
- Write payload files under `/data/<name>/`. Never `/data/.cache` — it is
  deleted on every start.

## Ports and reaching things

`8099`, `3010`, `4096`, `4097`, `4100` and `8787` are already bound inside the
container. Never make a hook *listen* on one. **Connecting** to them is normal.

A hook's own service is not reachable from the LAN — no port is mapped — but
Home Assistant Core and other add-ons reach it at the container's hostname
(`hostname`). That is what a `rest_command` or a Wyoming integration points at.

- **Home Assistant Core**: no setup needed. `SUPERVISOR_TOKEN` is already in the
  environment and `http://supervisor/core/api/...` proxies to Core. Do not tell
  the user to create a long-lived access token for this.
- **OpenCode's own API**: `http://127.0.0.1:4096`, but only when the user has
  turned on **OpenCode LAN server**. Tell them to enable that option; tell them
  they do *not* need to map the port, because mapping is only for other
  computers and would expose it to their network.

## Before you finish

Tell the user to run `ha-hooks run <name>` to test it immediately, and
`ha-hooks log <name>` to read the output. Mention that turning **Startup hooks**
off in the Configuration tab disables every hook if anything goes wrong.
