<div align="center">

# 🚀 OpenCode

### *AI-Powered Configuration Assistant for Home Assistant*

[![Stable Release][version-shield]][releases]
[![Beta Release][beta-release-shield]][releases]
[![Project Stage][project-stage-shield]][github]
[![License][license-shield]][license]
[![Maintenance][maintenance-shield]][github]

**Transform your Home Assistant configuration with the power of AI**

[Getting Started](#-getting-started) • [Features](#-features) • [Documentation][docs] • [Support](#-support)

---

</div>

> **Upstream attribution:** This is an independent Home Assistant add-on that redistributes and integrates [OpenCode](https://github.com/anomalyco/opencode), © 2025 opencode, under the MIT License. It is not made by, affiliated with, or endorsed by the OpenCode team or Anomaly. See the [third-party notices](THIRD-PARTY-LICENSES.md).

## 🚀 Getting Started

Install **OpenCode** for the stable channel, or **OpenCode Beta** to test upcoming
changes. See the [stable changelog][changelog] and [beta changelog][beta-changelog]
for current versions and bundled component updates.

This is a Home Assistant **Supervisor add-on** (called an **app** in newer Home
Assistant versions), not a standalone Home Assistant Core/Container integration.
It supports **amd64** and **aarch64/ARM64**.

Upgrading an existing installation? Back up first and read the
[3.3 upgrade notes](ha_opencode/DOCS.md#upgrading-to-33), including stable history
preservation and backup-based rollback. Coming from 2.x? Follow the
[2.x upgrade guide](ha_opencode/DOCS.md#upgrading-from-2x).

> ⚙️ **Hardware requirement:** x86-64 CPUs need **SSE4.2**, and the regular build also requires **AVX2**. SSE4.2 alone may not be sufficient: the documented upstream baseline-package issue can still prevent non-AVX2 CPUs from running OpenCode. ARM64 is unaffected by these x86 requirements. See [CPU requirements][cpu-req] before installing on older hardware or a VM.

### 1. Add This Repository

[![Add Repository][repo-btn]][repo-add]

<details>
<summary>Or add manually</summary>

Go to **Settings** → **Apps** → **Install app** → **⋮** → **Repositories**.
On older Home Assistant versions, use **Add-ons** → **Add-on Store** instead.

Add: `https://github.com/magnusoverli/opencode`
</details>

### 2. Install the Add-on

Find **"OpenCode"** in the app/add-on store and click **Install**.

> 💡 Prefer the beta channel to try new features early? Install **"OpenCode Beta"** from the same repository instead — it installs side by side with the stable add-on. See [Release channels](#release-channels).

### 3. Open OpenCode

Start the add-on, then click **Open Web UI** (or use the sidebar entry). By default you'll land in a web **terminal**.

> 💡 **Prefer a graphical interface?** Set **Interface** (`interface_mode`) to `openchamber` in the add-on **Configuration** tab and restart to use the [OpenChamber](https://github.com/openchamber/openchamber) web UI on the same sidebar entry. Both interfaces use the same managed OpenCode V2 backend and conversation history within that channel.

### 4. Connect an AI Provider

In the terminal, run `opencode`, then `/connect` and follow the provider's sign-in
prompts. Run `/models` to choose a model. In OpenChamber, use its provider/model
settings instead. Anthropic, OpenAI, Google and other cloud or local providers
are supported; credentials, subscriptions and usage charges depend on the provider.

OpenCode and OpenChamber are pinned in the add-on image. Update them through
**Home Assistant Supervisor**, not an upstream in-app updater.

### 5. Try It

Once connected, ask OpenCode things like:

```text
# Create a new automation
"Create an automation that turns on lights when motion is detected"

# Review your configuration
"Check my configuration.yaml for any issues"

# Add sensors
"Add a template sensor to track my total energy usage"

# Get entity information
"What's the current state of all my lights?"

# Troubleshoot
"Why isn't my bedroom motion sensor triggering automations?"

# Analyze history
"Show me temperature trends for the past 24 hours"
```

---

## 🎯 Features

**OpenCode** brings the [OpenCode](https://opencode.ai) AI coding agent directly into your Home Assistant instance. Experience intelligent configuration editing through natural language, advanced YAML assistance, and deep integration via the Model Context Protocol (MCP) — with a growing set of features that help it understand *your* installation, not just configuration syntax in general.

<table>
<tr>
<td width="50%">

#### 🤖 **AI-Powered Editing**
Use natural language to modify your Home Assistant configuration. No more searching documentation - just ask!

#### 🎨 **Two Interface Modes**
Choose a web **terminal** with 10 themes or the graphical **OpenChamber** web UI through Home Assistant Ingress. Both share one backend and history. Optional LAN frontends require separate authentication and a trusted HTTPS reverse proxy; mapping a port alone is not enough. See [LAN setup](ha_opencode/DOCS.md#lan-server-mode).

#### 🔌 **Provider Agnostic**
Works with **Anthropic, OpenAI, Google**, other cloud providers and OpenAI-compatible local servers. Available models and authentication methods depend on the bundled runtime and provider.

#### 🔐 **Private TEE Models (Beta)**
Opt-in PPQ support uses an attested encrypted transport for eligible private models. Configure a PPQ key and explicitly select a private model; enabling it does not switch existing sessions. Account-backed encrypted inference remains unverified. See [PPQ setup](ha_opencode/DOCS.md#ppq-private-tee-models-beta).

#### 🎚️ **Scoped MCP Tool Profiles**
Choose `compact`, `configuration`, or `full` (`full` is the default) to reduce the bundled MCP tool surface and prompt size. Hidden tools are rejected, but profiles do not restrict shell or filesystem access. See [tool profiles](ha_opencode/DOCS.md#mcp-tool-profiles).

</td>
<td width="50%">

#### 🔧 **Deep MCP Integration**
Bundled tools, resources and guided prompts cover state and service calls, history, config validation, calendars, decision notes, updates, ESPHome, Supervisor diagnostics and CLI gateways. Availability depends on your tool profile and enabled features; inspect it with `ha-mcp tools` or `get_agent_capabilities`.

#### 🧠 **Home Context**
Sessions start knowing your installation instead of rediscovering it. A generated briefing describes your setup, `AGENTS.local.md` holds your own standing instructions that survive updates, and decision notes — recorded only with your approval — carry the reasoning behind your configuration between sessions. Inspect it all with `ha-context`.

#### 💡 **Intelligent LSP Support**
Home Assistant YAML diagnostics, completions, hover and definitions are available through agent tools, with live diagnostics/completion in OpenChamber's Ingress editor. Whole-file YAML formatting is opt-in. See [language assistance](ha_opencode/DOCS.md#v2-yaml-language-assistance-and-formatting).

#### 🛡️ **Safe Config Writing**
The `write_config_safe` MCP tool provides validation, backups, rollback attempts and content-loss checks. Native file edits and specified in-place shell commands ask for approval by default, but do not automatically use that pipeline.

#### 🏗️ **hab CLI Integration**
Includes the [Home Assistant Builder CLI](https://github.com/balloob/home-assistant-build-cli) by [@balloob](https://github.com/balloob) for dashboards, registries, helpers, backups and administration. Agents use the authenticated `hab_run` MCP gateway in the `full` profile; their shell does not inherit Supervisor credentials.

#### 🧩 **Startup Hooks**
An opt-in, persistent place for your own scripts to run at add-on startup. Scripts run as root; keep customizations in the supported [startup hooks directory](ha_opencode/DOCS.md#startup-hooks-beta), not the disposable container filesystem.

#### 🧭 **Native HA Tools & Experimental Assist**
Connect to Home Assistant's native MCP tools independently of bundled tools. An optional experimental companion also lets HA use OpenCode for Assist conversations and AI data tasks. These are separate integrations; see [setup and requirements](#-home-assistant-native-integration).

</td>
</tr>
</table>

---

## 🌟 What is OpenCode?

[**OpenCode**](https://opencode.ai) is an open-source AI coding agent that transforms how you interact with your codebase. It understands your files, executes commands, and helps you build and maintain software using natural language.

Think of it as your personal expert developer who:
- 📖 Reads relevant configuration files and inspects live state through tools
- ✏️ Suggests and implements improvements
- 🐛 Helps diagnose bugs and apply approved fixes
- 🚀 Implements new features on request
- 💬 Explains complex configurations in plain English

---

## 🎭 Supported AI Providers

OpenCode supports cloud providers and local models. Choose a provider and model
that support tool calling and fit your hardware, privacy needs and budget:

<details>
<summary><b>🔥 Popular Providers (Click to expand)</b></summary>

| Provider | Notes |
|----------|------------------|
| 🧠 **Anthropic** | Claude models — recommended for configuration work |
| 💎 **OpenAI** | OpenAI models with supported API-key or subscription sign-in |
| 🌈 **Google** | Gemini models |
| ☁️ **AWS Bedrock** | Claude, Llama, Mistral, and others via AWS |
| 🔷 **Azure OpenAI** | Azure-hosted OpenAI models |
| 🐙 **GitHub Copilot** | GitHub sign-in; requires an eligible Copilot account |
| ⚡ **Groq** | Ultra-fast inference for open models |
| 🎯 **Mistral** | Mistral and Codestral models |
| 🦙 **Ollama** | Local models — see the [context-window and tool-profile guidance](./ha_opencode/DOCS.md#mcp-tool-profiles) before choosing hardware |
| 🌐 **OpenRouter** | Models from multiple providers through a single API |
| 🤝 **Together AI** | Hosted open-weight models |
| 🔥 **Fireworks AI** | Fast inference for open models |
| 🚀 **xAI** | Grok models |
| 💫 **DeepSeek** | DeepSeek models |

</details>

> **Running models locally?** The add-on sends a large tools-and-instructions prompt on every request. Read the [context-window and tool-profile guidance](./ha_opencode/DOCS.md#mcp-tool-profiles) first — a small model on modest hardware can take minutes per reply. A smaller MCP tool profile (see [Features](#-features)) is one of the easiest ways to cut that cost.

### 💳 Model access and costs

The add-on does not include a paid model subscription. Upstream may offer free
models, but availability, limits and terms can change; do not assume every model
offered through OpenCode is free or keyless. Check the provider's current pricing
and [OpenCode's provider documentation](https://opencode.ai/v2/docs/providers).

Your prompts and tool results are sent to the selected model provider. Local
models need a separately running inference server; the add-on itself is not one.

---

## 🛡️ Safety & Validation

> **This add-on has read/write access to your Home Assistant configuration directory.**

It also mounts Home Assistant add-on development folders (`/addons` and `/addon_configs`) so OpenCode can help with custom add-ons. Treat `/addon_configs` as sensitive because it may contain configuration data for other add-ons.

The bundled **`write_config_safe` MCP tool** provides a multi-layered validation
pipeline. These checks apply to writes through that tool, **not every file write**:

- 🔍 **HA config validation** — after writing, the tool runs HA Core's config check; a failed or unavailable check is not reported as a successful save
- ↩️ **Backup and rollback** — existing files get a `.bak` copy; on failed validation the tool attempts to restore the original, or remove an invalid new file. Recovery can fail, so inspect the result and keep independent backups
- 🧪 **Jinja2 template pre-validation** — checks changed templates through HA's engine where possible; unchanged or runtime-dependent templates can be skipped
- 📋 **Deprecation scanning** — checks for outdated syntax and cross-checks your instance's HA Repairs warnings
- ✂️ **Guardrails against accidental data loss** — large deletions (missing list entries, removed top-level keys, or a file shrinking by more than half) are blocked unless explicitly confirmed
- 🏥 **HA Repairs integration** — surfaces your installation's active deprecation warnings
- ⚠️ **Structural checks** — catches missing triggers, actions, and other required fields

**Other guardrails and their limits:**

- ✅ **Direct-edit approval** — native file edits and configured shell patterns (`yq -i`, `sed -i`, `tee`, `rm`, `mv`) ask by default. These rules do not detect every possible shell write, and approval does not run safe-write validation. The safe-write tool has no separate native edit prompt; agent instructions still require your consent
- 🔒 **Sensitive-file read protection** — the normal agent's read tool denies `secrets.yaml`, `.storage/`, `.cloud/`, `ssl/`, and `*.key`/`*.pem` by default. This is not a shell sandbox: allowed shell commands run as container root and can bypass read-tool restrictions. See [protection scope](ha_opencode/DOCS.md#sensitive-file-protection)
- 🔄 **Saved is not active** — saving YAML does not reload Home Assistant. Apply an approved domain reload or restart as appropriate, then verify loading. The `configuration` profile omits service calls, so reload remains a manual step. See [editing automations](ha_opencode/DOCS.md#editing-automations-saved-versus-active)

**Additional best practices:**

- 💾 **Always backup** your configuration before significant changes
- 👀 **Review changes** suggested by the AI before accepting them  
- 📝 **Use version control** (git) when possible for easy rollback

---

## 🧭 Home Assistant Native Integration

Home Assistant's native `llm` platform and keyed MCP endpoints are available from
**HA 2026.8**. The add-on supports several distinct connections:

- **Bundled Home Assistant tools** (`mcp_enabled`) provide the add-on's configuration,
  validation, diagnostics and administration surface independently of HA's MCP Server.
- **Home Assistant native tools** (`native_ha_mcp_enabled`) connect OpenCode to HA's
  own MCP Server. On **HA 2026.10+**, enable it under **Settings → System → AI →
  Model Context Protocol**; on older versions, add the **Model Context Protocol
  Server** integration. Review the add-on's native settings and restart it.
- **Expose read-only MCP to Home Assistant** (`ha_mcp_server_enabled`) is an opt-in
  reverse connection, sharing the add-on's read-only tools with HA. See
  [read-only sharing](ha_opencode/DOCS.md#expose-read-only-mcp-to-home-assistant).
- **OpenCode Assist** (`ha_assist_enabled`) is an **experimental**, default-off
  companion for **HA 2026.10 with Supervisor**. Enable it and restart the add-on,
  then restart **Home Assistant Core** to load the companion and configure the
  discovered integration. Choose a model and APIs explicitly. Voice also needs
  separate speech engines; full supervised voice-pipeline and crash-recovery
  qualification remain open. See [Assist setup](ha_opencode/DOCS.md#experimental-native-assist-and-ai-data-tasks).

**Native bridge defaults:** native tools are on for new installs and use **Your
MCP API** (`/api/mcp`); upgrades preserve effective enabled/disabled state and
migrate legacy Assist selections once. `home_assistant`, `assist` and `custom`
selections are available. `/api/mcp` follows HA's selected APIs and can expand
when **Expose all LLM APIs** is on. The add-on does not enable or reconfigure HA's
MCP Server. No URL or token needs copying. Review
[migration and rollback guidance](ha_opencode/DOCS.md#upgrade-policy-assist-to-ha-configured-mcp).

Bundled, native and external MCP connections activate independently. A connected
status alone does not prove native tools have loaded: verify a suitable read-only
tool. Native tools complement, rather than replace, the bundled safe-write and
administration workflows.

Stable and beta have separate histories and settings, but edit the same HA
configuration. Only one channel should manage the shared Assist companion; follow
the [ownership-switch instructions](ha_opencode/DOCS.md#experimental-native-assist-and-ai-data-tasks)
when moving between them.

---

## 📚 Documentation

Comprehensive documentation is available covering all features:

- 📖 [**Full Add-on Documentation**][docs] - Complete guide to all features
- 🧪 [**Beta Documentation**][beta-docs] - Beta-specific setup and limitations
- 📝 [**Stable Changelog**][changelog] / [**Beta Changelog**][beta-changelog] - Version history and updates

---

## 🤝 Support

Need help? We've got you covered:

<table>
<tr>
<td align="center" width="33%">

### 💬 Discord
[Join OpenCode Discord](https://opencode.ai/discord)

Upstream OpenCode community; use this repository's issues for add-on problems

</td>
<td align="center" width="33%">

### 📖 Documentation
[OpenCode V2 Docs](https://opencode.ai/v2/docs/)

Upstream guides; add-on-specific setup is in [our documentation][docs]

</td>
<td align="center" width="33%">

### 🐛 Issues
[GitHub Issues][issues]

Bug reports & feature requests

</td>
</tr>
</table>

---

## 🌟 Contributing

We love contributions! Here's how you can help:

1. 🍴 Fork the repository
2. 🔧 Create your feature branch (`git checkout -b feature/amazing-feature`)
3. 💾 Commit your changes (`git commit -m 'Add amazing feature'`)
4. 📤 Push to the branch (`git push origin feature/amazing-feature`)
5. 🎉 Open a Pull Request

Contributions of all kinds are welcome — feel free to open a PR!

### Release channels

Channels are folders, not branches. Both live on `main`:

- **`ha_opencode/`** — the stable channel. Tagged `v*`, published as the
  **OpenCode** add-on.
- **`ha_opencode_beta/`** — the beta channel, for work still soaking. Tagged
  `beta-v*`, published as the **OpenCode Beta** add-on.

Each folder is a complete add-on with its own `Dockerfile` and `rootfs/`, so a
stable release cannot contain something that only exists in beta. Put
experimental work in `ha_opencode_beta/`; change `ha_opencode/` when preparing
a stable fix or promoting validated beta work. Merging does not publish an image;
the release workflows build and publish the tagged channel.

Both add-ons can be installed side by side — they keep separate decision notes
and app storage, but share Home Assistant configuration files and `AGENTS.local.md`.
Installing the other channel does not transfer conversations or provider sign-ins.
Use different host ports if exposing both channels' LAN frontends, and only one
channel to manage the shared Assist companion.

### Home Assistant development

The devcontainer is the default local development environment. It runs the
add-ons under Home Assistant's official Supervisor development environment. Run
the **Start Home Assistant** task first, then use the install, rebuild, start,
and log tasks for either `ha_opencode` or `ha_opencode_beta`. On a first run, use
**Install App** followed by **Start App**; use **Rebuild and Start App** while
iterating, and run **Run App Acceptance** after runtime or lifecycle changes. The
install task first registers the app, then builds the working tree over its local
image tag; rebuilds stop the app before replacing that tag. Acceptance traverses
Home Assistant Core's real Ingress route and, for beta, verifies automatic s6
recovery after a sidecar crash. Native amd64 and arm64 boundary checks run in
GitHub Actions; a local emulated arm64 build is not a release gate.

---

## 👏 Contributors

Thank you to everyone who contributes code, reports issues, tests releases or
improves the documentation!

[![Contributors to this repository](https://contrib.rocks/image?repo=magnusoverli/opencode)][contributors]

[View contributors on GitHub][contributors]. The avatar image is automatically
generated from GitHub contributor data by [contrib.rocks](https://contrib.rocks),
not maintained as a separate list in this repository. The [stable][changelog]
and [beta][beta-changelog] changelogs also credit reports and suggestions.

### Upstream acknowledgements

This add-on builds on [OpenCode](https://github.com/anomalyco/opencode),
[OpenChamber](https://github.com/openchamber/openchamber) and
[@balloob's hab CLI](https://github.com/balloob/home-assistant-build-cli), among
other open-source projects. See [third-party notices](THIRD-PARTY-LICENSES.md)
for retained license and attribution information.

---

## 📜 License

This is free and unencumbered software released into the public domain - see the [UNLICENSE](UNLICENSE) file for details.

This distribution also includes third-party software, including OpenCode. Its copyright notices and license terms are retained in [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) and in the add-on image at `/usr/share/doc/ha-opencode/NOTICE`.

---

<div align="center">

### ⭐ If you find OpenCode helpful, please star this repository!

**Made with ❤️ for the Home Assistant community**

[Getting Started](#-getting-started) • [Features](#-features) • [Documentation][docs] • [Support](#-support)

</div>

<!-- Links -->
[docs]: ./ha_opencode/DOCS.md
[beta-docs]: ./ha_opencode_beta/DOCS.md
[cpu-req]: ./ha_opencode/DOCS.md#cpu-requirements
[changelog]: ./ha_opencode/CHANGELOG.md
[beta-changelog]: ./ha_opencode_beta/CHANGELOG.md
[issues]: https://github.com/magnusoverli/opencode/issues
[contributors]: https://github.com/magnusoverli/opencode/graphs/contributors
[releases]: https://github.com/magnusoverli/opencode/releases
[license]: UNLICENSE
[github]: https://github.com/magnusoverli/opencode
[repo-add]: https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fmagnusoverli%2Fopencode
[repo-btn]: https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg

<!-- Badges -->
[version-shield]: https://img.shields.io/github/v/release/magnusoverli/opencode.svg?style=for-the-badge&label=stable%20release
[beta-release-shield]: https://img.shields.io/github/v/release/magnusoverli/opencode?include_prereleases&filter=beta-v*&style=for-the-badge&label=beta%20release
[project-stage-shield]: https://img.shields.io/badge/project%20stage-experimental-orange.svg?style=for-the-badge
[license-shield]: https://img.shields.io/github/license/magnusoverli/opencode.svg?style=for-the-badge
[maintenance-shield]: https://img.shields.io/maintenance/yes/2026.svg?style=for-the-badge
