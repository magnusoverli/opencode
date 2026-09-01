const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const ADDON = path.join(__dirname, "..");
const ROOTFS = path.join(ADDON, "rootfs");
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

describe("OpenCode V2 state isolation", () => {
  const environment = read(
    ROOTFS,
    "usr",
    "local",
    "lib",
    "opencode",
    "v2-environment.sh",
  );
  const init = read(
    ROOTFS,
    "etc",
    "s6-overlay",
    "s6-rc.d",
    "init-opencode",
    "run",
  );
  const config = read(ADDON, "config.yaml");
  const dockerfile = read(ADDON, "Dockerfile");
  const v2BoundaryFixture = read(ADDON, "test", "v2-boundary-fixture.sh");
  const migrator = read(
    ROOTFS,
    "usr",
    "local",
    "bin",
    "opencode-v2-migrate.py",
  );
  const runtime = read(ROOTFS, "usr", "local", "lib", "opencode", "runtime.sh");
  const v2Server = read(
    ROOTFS,
    "etc",
    "s6-overlay",
    "s6-rc.d",
    "ha-opencode-v2-server",
    "run",
  );
  const v2Sidecar = read(
    ROOTFS,
    "etc",
    "s6-overlay",
    "s6-rc.d",
    "ha-opencode-v2-mcp-sidecar",
    "run",
  );
  const v2Plugin = read(ROOTFS, "opt", "opencode-v2-homeassistant", "plugin.js");
  const runtimeGuard = read(ROOTFS, "opt", "opencode-v2-homeassistant", "runtime-guard.js");
  const nonDumpable = read(ROOTFS, "opt", "opencode-v2-homeassistant", "non-dumpable.c");
  const secureLauncher = read(ROOTFS, "opt", "opencode-v2-homeassistant", "secure-launcher.c");
  const credentialBroker = read(ROOTFS, "opt", "opencode-v2-homeassistant", "credential-broker.c");
  const v2Proxy = read(
    ROOTFS,
    "etc",
    "s6-overlay",
    "s6-rc.d",
    "ha-opencode-v2-mcp-proxy",
    "run",
  );
  const v2ProxyConnect = read(
    ROOTFS,
    "etc",
    "s6-overlay",
    "s6-rc.d",
    "ha-opencode-v2-mcp-proxy",
    "connect",
  );
  const mcpServer = read(ROOTFS, "opt", "ha-mcp-server", "index.js");

  it("assigns persistent V2 state to one atomically selected generation", () => {
    assert.match(environment, /OPENCODE_V2_GENERATIONS_ROOT="\$\{OPENCODE_V2_ROOT\}\/generations"/);
    assert.match(environment, /OPENCODE_V2_CURRENT_FILE="\$\{OPENCODE_V2_ROOT\}\/current"/);
    for (const leaf of ["home", "config", "data", "state"]) {
      assert.match(environment, new RegExp(`OPENCODE_V2_[A-Z_]+=.?.*\\$\\{OPENCODE_V2_GENERATION_ROOT\\}/${leaf}`));
    }
    for (const leaf of ["cache", "work"]) {
      assert.match(environment, new RegExp(`OPENCODE_V2_[A-Z_]+=.?.*\\$\\{OPENCODE_V2_ROOT\\}/${leaf}`));
    }
    assert.match(environment, /OPENCODE_V2_ROOT="\$\{OPENCODE_V2_ROOT:-\/data\/v2\}"/);
  });

  it("exports a complete isolated XDG environment for V2 launchers", () => {
    assert.match(environment, /opencode_v2_select_generation \|\| return 1/);
    assert.match(environment, /export HOME="\$\{OPENCODE_V2_HOME\}"/);
    assert.match(environment, /export XDG_CONFIG_HOME="\$\{OPENCODE_V2_CONFIG_HOME\}"/);
    assert.match(environment, /export XDG_DATA_HOME="\$\{OPENCODE_V2_DATA_HOME\}"/);
    assert.match(environment, /export XDG_STATE_HOME="\$\{OPENCODE_V2_STATE_HOME\}"/);
    assert.match(environment, /export XDG_CACHE_HOME="\$\{OPENCODE_V2_CACHE_HOME\}"/);
  });

  it("prepares V2 roots before activation without replacing the V1 init environment", () => {
    assert.match(init, /source \/usr\/local\/lib\/opencode\/v2-environment\.sh/);
    assert.match(init, /opencode_v2_prepare_directories/);
    assert.match(init, /export HOME="\/data"/);
    assert.match(init, /export XDG_CONFIG_HOME="\/data\/\.config"/);
    assert.match(init, /if opencode_v2_prepare_directories; then/);
    assert.match(init, /V2_ROOTS_READY=false/);
  });

  it("fails closed on links and reserves every V2 path variable from user overrides", () => {
    assert.match(environment, /\[ -L "\$\{path\}" \]/);
    for (const name of [
      "OPENCODE_V2_ROOT",
      "OPENCODE_V2_HOME",
      "OPENCODE_V2_CONFIG_HOME",
      "OPENCODE_V2_DATA_HOME",
      "OPENCODE_V2_STATE_HOME",
      "OPENCODE_V2_CACHE_HOME",
      "OPENCODE_V2_WORK_ROOT",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "BASH_ENV",
      "IFS",
    ]) {
      assert.match(init, new RegExp(`"${name}"`));
    }
  });

  it("runs the copy-on-write migration before V1 services are released", () => {
    assert.match(init, /opencode-v2-migrate\.py prepare/);
    assert.match(init, /--runtime-user opencode-v2/);
    assert.match(init, /continuing with the untouched V1 runtime and state/);
    assert.ok(
      init.indexOf("opencode-v2-migrate.py prepare") < init.indexOf("setsid node /usr/local/bin/discover-services.js"),
    );
  });

  it("migrates sessions without importing V1 provider credentials", () => {
    assert.doesNotMatch(migrator, /auth\.json/);
    assert.match(migrator, /validate_no_credentials/);
    assert.match(migrator, /credential_count != 0/);
    assert.match(init, /provider credentials copied by an earlier beta/);
  });

  it("runs the V2 converter as a dedicated identity with an allowlisted environment", () => {
    assert.match(dockerfile, /useradd --uid 60000 --gid opencode-v2/);
    assert.match(migrator, /def minimal_environment/);
    assert.match(migrator, /os\.setgroups\(\[\]\)/);
    assert.match(migrator, /os\.setuid\(uid\)/);
    assert.match(migrator, /require_source_isolation/);
    assert.doesNotMatch(migrator, /os\.environ\.items\(\)/);
  });

  it("selects the V2 native binary for the deployment CPU before migration", () => {
    assert.match(runtime, /opencode_select_v2_package_binary\(\)/);
    assert.match(runtime, /cli-linux-x64-baseline/);
    assert.match(runtime, /cli-linux-x64/);
    assert.match(runtime, /cli-linux-arm64/);
    assert.match(init, /V2_RUNTIME_BINARY_READY=false/);
    assert.match(init, /opencode_select_v2_package_binary/);
    assert.match(init, /V2_RUNTIME_BINARY_READY=true/);
    assert.match(init, /\[ "\$\{V2_RUNTIME_BINARY_READY\}" = "true" \]/);
  });

  it("probes the V2 version once inside disposable scrubbed roots", () => {
    assert.match(runtime, /opencode_v2_probe_version\(\)/);
    assert.match(runtime, /mktemp -d "\$\{work_root\}\/\.runtime-probe\.XXXXXXXX"/);
    assert.match(runtime, /env -i/);
    for (const leaf of ["home", "config", "data", "state", "cache", "tmp", "workspace"]) {
      assert.match(runtime, new RegExp(`\\$\\{probe_root\\}/${leaf}`));
    }
    assert.match(runtime, /OPENCODE_DISABLE_PROJECT_CONFIG="1"/);
    assert.match(runtime, /OPENCODE_DISABLE_EXTERNAL_SKILLS="1"/);
    assert.match(runtime, /OPENCODE_DISABLE_CLAUDE_CODE_SKILLS="1"/);
    assert.match(runtime, /"\$\{work_root\}"\/\.runtime-probe\.\*/);
    assert.match(runtime, /rm -rf -- "\$\{probe_root\}"/);
    assert.equal((init.match(/opencode_v2_probe_version/g) ?? []).length, 1);
    assert.doesNotMatch(init, /opencode_bin_runs "\$\{v2_bin\}"/);
    assert.doesNotMatch(init, /"\$\{v2_bin\}" --version/);
  });

  it("stages a root-owned native policy only after migration succeeds", () => {
    assert.match(init, /V2_STATE_READY=false/);
    assert.match(init, /V2_STATE_READY=true/);
    assert.match(init, /V2_RUNTIME_ROOT=\/run\/opencode-v2/);
    assert.match(init, /managed-config\.js/);
    assert.match(init, /--plugin-enabled "\$\{V2_PLUGIN_ENABLED\}"/);
    assert.match(init, /--native-mcp-enabled "\$\{V2_NATIVE_MCP_ENABLED\}"/);
    assert.match(init, /V2_PLUGIN_ENABLED=.*MCP_ENABLED/);
    assert.match(init, /sidecar-secret/);
    assert.match(init, /cp \/opt\/ha-mcp-server\/AGENTS\.md/);
    assert.match(init, /mkdir -p "\$\{V2_RUNTIME_ROOT\}\/config\/opencode" "\$\{V2_RUNTIME_ROOT\}\/home" "\$\{V2_RUNTIME_ROOT\}\/workspace"/);
    assert.match(init, /bashio::config 'restrict_sensitive_files' 'true'/);
    assert.ok(init.indexOf("V2_STATE_READY=true") < init.indexOf("managed-config.js"));
  });

  it("supervises V2 on loopback as root with a scrubbed environment", () => {
    assert.match(v2Server, /opencode_v2_select_generation/);
    assert.match(v2Server, /exec \/usr\/local\/bin\/opencode-v2-launch/);
    assert.doesNotMatch(v2Server, /SERVER_PASSWORD=/);
    assert.doesNotMatch(v2Server, /exec 3</);
    assert.match(v2Server, /Starting OpenCode V2 server as root/);
    assert.match(secureLauncher, /getuid\(\) != 0/);
    assert.doesNotMatch(secureLauncher, /setresgid|setresuid|RUNTIME_UID/);
    assert.match(secureLauncher, /PR_SET_NO_NEW_PRIVS/);
    assert.match(secureLauncher, /PR_SET_DUMPABLE, 0/);
    assert.match(secureLauncher, /setrlimit\(RLIMIT_CORE/);
    assert.match(secureLauncher, /clearenv\(\)/);
    assert.match(secureLauncher, /OPENCODE_DISABLE_PROJECT_CONFIG/);
    assert.match(secureLauncher, /OPENCODE_DISABLE_EXTERNAL_SKILLS/);
    assert.match(secureLauncher, /OPENCODE_DISABLE_CLAUDE_CODE_SKILLS/);
    assert.doesNotMatch(secureLauncher, /OPENCODE_SERVER_PASSWORD/);
    assert.match(secureLauncher, /publish_expected_pid/);
    assert.match(secureLauncher, /OPENCODE_V2_CREDENTIAL_SOCKET/);
    assert.match(nonDumpable, /setenv\("OPENCODE_SERVER_PASSWORD"/);
    assert.match(nonDumpable, /pipe2\(descriptors, O_CLOEXEC\)/);
    assert.match(credentialBroker, /SO_PEERCRED/);
    assert.match(credentialBroker, /#define RUNTIME_UID 0/);
    assert.match(credentialBroker, /validate_expected_identity\(pid_path, peer\.pid\)/);
    assert.match(secureLauncher, /process_start_time\(getpid\(\)\)/);
    assert.match(credentialBroker, /signal\(SIGPIPE, SIG_IGN\)/);
    assert.match(credentialBroker, /read_process_start_time/);
    assert.match(secureLauncher, /execve\(child_argv\[0\], child_argv, environ\)/);
    assert.doesNotMatch(secureLauncher, /--client|client-credential|publish_expected_client/);
    assert.doesNotMatch(credentialBroker, /client_mode|client-credential|validate_expected_client/);
    assert.match(v2Server, /http:\/\/127\.0\.0\.1:8765\/mcp/);
    assert.match(v2Server, /sidecar is not ready"\n        exit 1/);
    const sidecarReadyCheck = v2Server.indexOf("SIDECAR_READY=false");
    const serverLaunch = v2Server.indexOf("exec /usr/local/bin/opencode-v2-launch");
    assert.notEqual(sidecarReadyCheck, -1);
    assert.notEqual(serverLaunch, -1);
    assert.ok(sidecarReadyCheck < serverLaunch, "V2 waits for sidecar readiness before launch");
    assert.match(v2Server, /4100/);
    assert.doesNotMatch(v2Server, /source \/data\/\.env_vars/);
    assert.doesNotMatch(v2Server, /SUPERVISOR_TOKEN|HA_TOKEN|HA_ACCESS_TOKEN|PPQ_API_KEY/);
    assert.ok(fs.existsSync(path.join(
      ROOTFS,
      "etc",
      "s6-overlay",
      "s6-rc.d",
      "user",
      "contents.d",
      "ha-opencode-v2-server",
    )));
  });

  it("waits for the credential broker socket instead of racing service startup", () => {
    const waitStart = v2Server.indexOf("BROKER_READY=false");
    const socketReady = v2Server.indexOf('if [ -S "${BROKER_SOCKET}" ]');
    const restart = v2Server.indexOf("credential broker is not ready");
    assert.ok(waitStart >= 0);
    assert.ok(waitStart < socketReady);
    assert.ok(socketReady < restart);
    assert.match(v2Server, /for _attempt in \$\(seq 1 100\)/);
    assert.match(v2Server, /sleep 0\.1/);
  });

  it("isolates the authenticated Home Assistant sidecar from V2 shell subprocesses", () => {
    assert.match(v2Sidecar, /OPENCODE_MCP_TRANSPORT=streamable-http/);
    assert.match(v2Sidecar, /OPENCODE_MCP_SIDECAR_SOCKET="\$\{V2_RUNTIME_ROOT\}\/mcp-sidecar\.sock"/);
    assert.match(v2Sidecar, /OPENCODE_MCP_SIDECAR_PUBLIC_HOST=127\.0\.0\.1:8765/);
    assert.match(v2Sidecar, /OPENCODE_MCP_SIDECAR_SECRET_FILE="\$\{SIDECAR_SECRET_FILE\}"/);
    assert.match(v2Sidecar, /OPENCODE_MCP_SIDECAR_READY_FILE="\$\{SIDECAR_READY_FILE\}"/);
    assert.match(v2Sidecar, /rm -f "\$\{SIDECAR_READY_FILE\}"/);
    assert.match(v2Sidecar, /sidecar on root-only Unix socket \$\{V2_RUNTIME_ROOT\}\/mcp-sidecar\.sock/);
    assert.doesNotMatch(v2Sidecar, /sidecar on private loopback port 8765/);
    assert.match(v2Sidecar, /source "\$\{SIDECAR_ENV_FILE\}"/);
    assert.doesNotMatch(v2Sidecar, /source \/data\/\.env_vars/);
    assert.match(v2Sidecar, /ulimit -c 0/);
    assert.match(v2Sidecar, /LD_PRELOAD=\/usr\/local\/lib\/opencode-v2-non-dumpable\.so/);
    assert.match(init, /V2_SIDECAR_ENV_TEMP/);
    assert.match(init, /"\$\{V2_RUNTIME_ROOT\}\/sidecar-env"/);
    assert.match(v2Sidecar, /exec env -i/);
    assert.match(v2Sidecar, /SUPERVISOR_TOKEN="\$\{SUPERVISOR_TOKEN\}"/);
    assert.match(v2Sidecar, /OPENCODE_NATIVE_HA_MCP_ENABLED="\$\{OPENCODE_NATIVE_HA_MCP_ENABLED:-false\}"/);
    assert.doesNotMatch(v2Sidecar, /OPENCODE_NATIVE_HA_MCP_ENABLED=false/);
    assert.doesNotMatch(v2Sidecar, /OPENCODE_SERVER_PASSWORD/);
    assert.match(v2Plugin, /CALLER_SECRET_FD = 3/);
    assert.match(v2Plugin, /NATIVE_MCP_SERVER_NAME = "homeassistant_native"/);
    assert.match(v2Plugin, /nativeEndpoint/);
    assert.match(runtimeGuard, /import\("bun:ffi"\)/);
    assert.match(runtimeGuard, /PR_SET_DUMPABLE = 4/);
    assert.match(runtimeGuard, /prctl\(PR_SET_DUMPABLE, 0/);
    assert.match(runtimeGuard, /scrubParentEnvironment\(\)/);
    assert.match(runtimeGuard, /ctx\.shell\.hook\("create\.before"/);
    assert.match(v2Plugin, /delete input\.env\[name\]/);
    assert.match(nonDumpable, /prctl\(PR_SET_DUMPABLE, 0/);
    assert.match(nonDumpable, /unsetenv\("LD_PRELOAD"\)/);
    assert.match(secureLauncher, /LD_PRELOAD.*opencode-v2-non-dumpable\.so/);
    assert.match(v2Proxy, /s6-tcpserver -q -c 64 127\.0\.0\.1 8765/);
    assert.doesNotMatch(v2Proxy, /until s6-ipcclient/);
    assert.match(v2Proxy, /ha-opencode-v2-mcp-proxy\/connect/);
    assert.match(v2ProxyConnect, /mcp-sidecar\.ready/);
    assert.match(v2ProxyConnect, /V2_RUNTIME_ROOT="\$\{V2_RUNTIME_ROOT:-\/run\/opencode-v2\}"/);
    assert.match(v2ProxyConnect, /0:0:600:1/);
    assert.match(v2ProxyConnect, /\/proc\/\$\{ready_pid\}\/stat/);
    assert.match(v2ProxyConnect, /\/proc\/\$\{ready_pid\}\/status/);
    assert.match(v2ProxyConnect, /"\$\{1:-\}" != "Z"/);
    assert.match(v2ProxyConnect, /\[ -S "\$\{SIDECAR_SOCKET\}" \]/);
    assert.match(v2ProxyConnect, /HTTP\/1\.1 503 Service Unavailable/);
    assert.match(v2ProxyConnect, /exec s6-ipcclient "\$\{SIDECAR_SOCKET\}" s6-ioconnect/);
    assert.match(mcpServer, /OPENCODE_MCP_SIDECAR_READY_FILE/);
    assert.match(mcpServer, /createNativeMcpHandler/);
    assert.match(mcpServer, /"\/native-mcp": nativeMcpHandler/);
    assert.match(init, /HA_NATIVE_MCP_API_ID=%q.*NATIVE_HA_MCP_API_ID/);
    assert.match(init, /OPENCODE_NATIVE_HA_MCP_ENABLED=%q.*V2_NATIVE_MCP_ENABLED/);
    assert.match(init, /"\$\{V2_RUNTIME_ROOT\}\/native-mcp-enabled"/);
    assert.match(v2BoundaryFixture, /native-mcp-enabled/);
    assert.match(mcpServer, /writeFileSync\(temporaryReadyFile/);
    assert.match(mcpServer, /readFileSync\("\/proc\/self\/stat"/);
    assert.match(mcpServer, /unlinkSync\(readyFile\)/);
    assert.match(dockerfile, /source=test\/v2-boundary-fixture\.sh/);
    assert.match(dockerfile, /FROM runtime AS boundary-test/);
    assert.match(dockerfile, /timeout --signal=TERM --kill-after=10s 240s/);
    assert.doesNotMatch(dockerfile, /Skipping architecture-neutral V2 boundary fixture|BOUNDARY_ROOT=/);
    assert.match(v2BoundaryFixture, /wait_for_status 503/);
    assert.match(v2BoundaryFixture, /wait_for_status 401/);
    assert.doesNotMatch(v2BoundaryFixture, /kill -KILL "\$\{SIDECAR_PID\}"/);
    assert.match(v2BoundaryFixture, /NoNewPrivs/);
    assert.match(v2BoundaryFixture, /StreamableHTTPClientTransport/);
    for (const marker of [
      ["user", "contents.d", "ha-opencode-v2-mcp-sidecar"],
      ["ha-opencode-v2-server", "dependencies.d", "ha-opencode-v2-mcp-sidecar"],
      ["user", "contents.d", "ha-opencode-v2-mcp-proxy"],
      ["ha-opencode-v2-server", "dependencies.d", "ha-opencode-v2-mcp-proxy"],
      ["user", "contents.d", "ha-opencode-v2-credential-broker"],
      ["ha-opencode-v2-server", "dependencies.d", "ha-opencode-v2-credential-broker"],
    ]) {
      assert.ok(fs.existsSync(path.join(ROOTFS, "etc", "s6-overlay", "s6-rc.d", ...marker)));
    }
  });

  it("validates every selected generation leaf before exporting it", () => {
    assert.match(environment, /stat -c '%h'/);
    assert.match(environment, /"\$\{OPENCODE_V2_HOME\}"/);
    assert.match(environment, /"\$\{OPENCODE_V2_CONFIG_HOME\}"/);
    assert.match(environment, /"\$\{OPENCODE_V2_DATA_HOME\}"/);
    assert.match(environment, /"\$\{OPENCODE_V2_STATE_HOME\}"/);
  });

  it("excludes migration work and cache from Home Assistant backups", () => {
    assert.match(config, /^  - "v2\/work\/\*"$/m);
    assert.match(config, /^  - "v2\/cache\/\*"$/m);
  });
});
