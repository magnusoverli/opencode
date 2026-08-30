# Startup hooks

Scripts in this folder run once, every time the OpenCode add-on starts.

This is the supported way to add your own thing to the add-on — a bridge, a
small service, an extra tool — without editing anything inside the container.
Everything inside the container except `/data` and your Home Assistant
configuration directory is rebuilt from the image on every start, which is why
patching files in there never survives.

**These are your scripts.** The add-on runs them and stays out of the way. It
does not check them, restart them, or keep anything they start alive.

---

## The rules

1. A hook is a file ending in `.sh` in this folder.
2. Hooks run in filename order. Use a number prefix: `10-`, `20-`, `30-`.
3. To stop a hook running, rename it to anything not ending in `.sh`
   (`10-thing.sh.off` is fine). There is no enable/disable flag.
4. A hook runs as **root**, as `bash <file>` — the executable bit is not needed,
   because files written over Samba usually lose it.
5. **A hook must return.** It is killed after 15 minutes. Put
   `# opencode-hook-timeout: 1800` in the **first 10 lines** to change that, or
   `0` for no limit — worth doing if a first run has to compile something on
   slow hardware. If you want something to keep running, see below.
6. A hook that fails is logged and does not stop the next one.

## Starting something that keeps running

This is the important part. A hook that just runs your server in the foreground
will be killed when the hook times out. Detach it with `setsid` so it leaves the
hook's process group, and give it its own log file:

```sh
setsid /data/venvs/mybridge/bin/python3 -u /data/mybridge/server.py \
    >/data/mybridge.log 2>&1 </dev/null &
```

Guard it so a re-run does not start a second copy:

```sh
if pgrep -f "/data/mybridge/server.py" >/dev/null; then
    echo "already running"
    exit 0
fi
```

Nothing restarts it if it dies. This add-on is not a service manager, and it is
not trying to become one.

## Python packages

Use a virtual environment under `/data`, which is the only place that survives
a restart:

```sh
if [ ! -d /data/venvs/mybridge ]; then
    python3 -m venv /data/venvs/mybridge
fi
/data/venvs/mybridge/bin/pip install --quiet wyoming aiohttp
```

Then always call `/data/venvs/mybridge/bin/python3`, not bare `python3`.

Do not use `pip install --user`: it installs into a path that contains the
Python version number, so it silently disappears the next time the add-on image
moves to a newer Python. There is no C compiler header package in the image, so
packages that have to build from source will fail — pick ones with wheels.

## Node packages

Install into your own prefix, never globally:

```sh
npm install --prefix /data/mybridge wyoming
```

`npm install -g` writes to the same folder the add-on uses for its own OpenCode
updates, and the two can corrupt each other.

## Ports

These are already taken inside the container: **8099** (the interface behind
Ingress), **3010** (OpenChamber), **4096** (OpenCode's own API), **4097**
(OpenChamber LAN), **4100** (staged V2 loopback server), and **8787** (PPQ
proxy). Pick a different one for your own service — *listening* on one of these
breaks the add-on in a way that is very hard to trace.

**Connecting** to them is fine, and is how you reach OpenCode itself.

Your service is *not* reachable from your LAN — the add-on maps no ports for
it. It **is** reachable from Home Assistant Core and other add-ons, on the
container's hostname. Run `hostname` in the add-on terminal to see it, then
point a `rest_command` or a Wyoming integration at it.

## Talking to Home Assistant, and to OpenCode

Home Assistant needs no setup — the token is already in your environment:

```sh
curl -fsSL -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
    http://supervisor/core/api/config
```

To drive OpenCode itself, turn on **OpenCode LAN server** in the Configuration
tab. You do *not* need to map port 4096 in Network settings — mapping is only
for reaching it from another computer. Left unmapped it is still there at
`http://127.0.0.1:4096` for your hook, with nothing exposed to your network.

## Seeing what happened

```
ha-hooks list              # what exists, when it last ran, how it went
ha-hooks run               # run them all again, without restarting
ha-hooks run 20-thing.sh   # run just one
ha-hooks log 20-thing.sh   # what it printed
```

A hook's log is wiped at the start of each run. Anything you start in the
background should write to its own file, not to the hook's log.

## What you can reach

A hook gets the add-on's own environment: `SUPERVISOR_TOKEN` and `HA_TOKEN` for
the Home Assistant API through `http://supervisor/core`, plus any environment
variables you set in the add-on's Configuration tab.

That means a hook's output can contain credentials. Do not use `set -x`, and do
not paste a hook log into a bug report without reading it first.

## If the add-on stops starting properly

Turn **Startup hooks** off in the Configuration tab and restart. Hooks never run
when it is off, so that always gets you back to a working add-on.

Hooks are also skipped automatically when the add-on restarts within a minute
of the last hook run, which breaks the common case of a hook that crashes the
add-on on every start. A hook that takes longer than a minute to reach the
crash can still loop — turning the option off is the reliable way out.

---

Folder: `@@HOOKS_DIR@@`
