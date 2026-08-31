<div align="center">

# 🚀 OpenCode

### *AI-Powered Configuration Assistant for Home Assistant*

[![Version][version-shield]][github]
[![Project Stage][project-stage-shield]][github]
[![License][license-shield]][license]
[![Maintenance][maintenance-shield]][github]

[![Stable Build][stable-build-shield]][stable-build-workflow]
[![Beta Build][beta-build-shield]][beta-build-workflow]

**Transform your Home Assistant configuration with the power of AI**

[Getting Started](#-getting-started) • [Features](#-features) • [Documentation][docs] • [Support](#-support)

---

</div>

> **Upstream attribution:** This is an independent Home Assistant add-on that redistributes and integrates [OpenCode](https://github.com/anomalyco/opencode), © 2025 opencode, under the MIT License. It is not made by, affiliated with, or endorsed by the OpenCode team or Anomaly. See the [third-party notices](THIRD-PARTY-LICENSES.md).

## 🚀 Getting Started

> ⚙️ **Hardware requirement:** on x86-64, OpenCode needs a CPU with **SSE4.2** (Intel Nehalem/2008 or newer, AMD Bulldozer/2011 or Jaguar/2013 or newer). Older processors cannot run it at all — it exits with `Illegal instruction (core dumped)`. ARM64 is unaffected. See [CPU requirements][cpu-req] for details.

### 1. Add This Repository

[![Add Repository][repo-btn]][repo-add]

<details>
<summary>Or add manually</summary>

Go to **Settings** → **Add-ons** → **Add-on Store** → **⋮** → **Repositories**

Add: `https://github.com/magnusoverli/opencode`
</details>

### 2. Install the Add-on

Find **"OpenCode"** in the add-on store and click **Install**.

> 💡 Prefer the beta channel to try new features early? Install **"OpenCode Beta"** from the same repository instead — it installs side by side with the stable add-on. See [Release channels](#release-channels).

### 3. Open OpenCode

Start the add-on, then click **Open Web UI** (or use the sidebar entry). By default you'll land in a web **terminal**.

> 💡 **Prefer a graphical interface?** Set **Interface Mode** to `openchamber` in the add-on **Configuration** tab and restart to swap the terminal for the [OpenChamber](https://github.com/openchamber/openchamber) web UI on the same sidebar entry. The default `terminal` mode is unchanged.

### 4. Connect an AI Provider

Run `opencode`, then `/connect` and follow the prompts to authenticate — Anthropic (Claude) is recommended, or pick OpenAI, Google, **OpenCode Zen** (curated coding models, no setup required), or any of the 70+ other supported providers.

### 5. Try It

Once connected, ask OpenCode things like:

```bash
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
Choose your experience from the sidebar: a beautiful web **terminal** with 10 themes, or the graphical **OpenChamber** web UI — both served through Home Assistant Ingress. Either can also be opted into a mappable LAN port for reverse proxies and remote clients.

#### 🔌 **Provider Agnostic**
Works with **Anthropic, OpenAI, Google, and 70+ other AI providers**.

#### 🔐 **Private TEE Models (Beta)**
Optional PPQ private-mode proxy routes requests to models running in remote trusted execution environments — encrypted end to end, with nothing exposed on the network.

#### 🎚️ **Scoped MCP Tool Profiles**
Choose a `compact`, `configuration`, or `full` tool profile to control how much of the Home Assistant tool surface the model sees — smaller profiles mean a cheaper prompt and a narrower blast radius.

</td>
<td width="50%">

#### 🔧 **Deep MCP Integration**
47 tools, 14 resources, and 6 guided prompts spanning state and service calls, history, config validation, calendars, decision notes, update and firmware management, ESPHome, Supervisor diagnostics, and CLI gateways.

#### 🧠 **Home Context**
Sessions start knowing your installation instead of rediscovering it. A generated briefing describes your setup, `AGENTS.local.md` holds your own standing instructions that survive updates, and decision notes — recorded only with your approval — carry the reasoning behind your configuration between sessions. Inspect it all with `ha-context`.

#### 💡 **Intelligent LSP Support**
Smart YAML editing with entity autocomplete, live hover information, deprecation warnings, and go-to-definition support.

#### 🛡️ **Safe Config Writing**
Validated config pipeline with automatic backup/restore and guardrails against accidental data loss. Direct file edits and in-place shell writes now ask for approval before touching disk, too.

#### 🏗️ **hab CLI Integration**
Includes the [Home Assistant Builder CLI](https://github.com/balloob/home-assistant-build-cli) by [@balloob](https://github.com/balloob) — a CLI purpose-built for AI agents to manage Home Assistant via REST and WebSocket APIs. Enables dashboard CRUD, area/floor management, helper creation, backup/restore, and bulk admin operations that would otherwise require direct API calls or UI interaction.

#### 🧩 **Startup Hooks**
An opt-in, persistent place for your own scripts to run at add-on startup — everything else in the container is rebuilt from the image on every restart, so this is the supported way to make your own customizations stick.

#### 🧭 **HA Native LLM Ready**
Home Assistant's native `llm` platform ships in **2026.8**. OpenCode's opt-in native MCP bridge already targets it (with fallback for older versions), while its own MCP tools remain the complete, supported working surface either way.

</td>
</tr>
</table>

---

## 🌟 What is OpenCode?

[**OpenCode**](https://opencode.ai) is an open-source AI coding agent that transforms how you interact with your codebase. It understands your files, executes commands, and helps you build and maintain software using natural language.

Think of it as your personal expert developer who:
- 📖 Reads and understands your entire configuration
- ✏️ Suggests and implements improvements
- 🐛 Finds and fixes bugs automatically
- 🚀 Implements new features on request
- 💬 Explains complex configurations in plain English

---

## 🎭 Supported AI Providers

OpenCode works with **Anthropic, OpenAI, Google, and 70+ other AI providers**. Choose the one that fits your needs:

<details>
<summary><b>🔥 Popular Providers (Click to expand)</b></summary>

| Provider | Notes |
|----------|------------------|
| 🧠 **Anthropic** | Claude models — recommended for configuration work |
| 💎 **OpenAI** | GPT and o-series reasoning models |
| 🌈 **Google** | Gemini models |
| ☁️ **AWS Bedrock** | Claude, Llama, Mistral, and others via AWS |
| 🔷 **Azure OpenAI** | Azure-hosted OpenAI models |
| ⚡ **Groq** | Ultra-fast inference for open models |
| 🎯 **Mistral** | Mistral and Codestral models |
| 🦙 **Ollama** | Local models — see the [local model notes](./ha_opencode/DOCS.md#local-models-ollama-and-similar) before choosing hardware |
| 🌐 **OpenRouter** | 100+ models through a single API |
| 🤝 **Together AI** | Llama, Mixtral, and other open models |
| 🔥 **Fireworks AI** | Fast inference for open models |
| 🚀 **xAI** | Grok models |
| 💫 **Deepseek** | Deepseek Coder and Deepseek Chat |

</details>

> **Running models locally?** The add-on sends a large tools-and-instructions prompt on every request. Read the [local model notes](./ha_opencode/DOCS.md#local-models-ollama-and-similar) first — a small model on modest hardware can take minutes per reply. A smaller MCP tool profile (see [Features](#-features)) is one of the easiest ways to cut that cost.

### 🎁 **Free Tier - OpenCode Zen**

Start immediately with **OpenCode Zen** - no API keys or subscriptions required! Get access to curated models optimized for coding tasks, perfect for trying OpenCode or for users who prefer not to manage their own API keys.

Simply run `/connect` and select **OpenCode Zen** to get started for free.

---

## 🛡️ Safety & Validation

> **This add-on has read/write access to your Home Assistant configuration directory.**

It also mounts Home Assistant add-on development folders (`/addons` and `/addon_configs`) so OpenCode can help with custom add-ons. Treat `/addon_configs` as sensitive because it may contain configuration data for other add-ons.

OpenCode includes a multi-layered validation pipeline designed to prevent AI-written configuration from causing your Home Assistant to fail to start:

- 🔍 **Automatic config validation** — every config write is validated through HA Core's own check before committing
- ↩️ **Automatic backup/restore** — if validation fails, the original file is instantly restored
- 🧪 **Jinja2 template pre-validation** — templates are tested through HA's engine before writing to disk
- 📋 **Deprecation scanning** — 20+ patterns catch outdated syntax, auto-updated from GitHub and cross-checked against your own instance's live HA Repairs warnings
- ✂️ **Guardrails against accidental data loss** — large deletions (missing list entries, removed top-level keys, or a file shrinking by more than half) are blocked unless explicitly confirmed
- 🏥 **HA Repairs integration** — surfaces your installation's active deprecation warnings
- ⚠️ **Structural checks** — catches missing triggers, actions, and other required fields
- ✅ **Approval before direct edits** — editing a file outright, in-place shell edits (`yq -i`, `sed -i`, `tee`), and deleting or renaming files now ask for confirmation first. Only the validated safe-write path skips the prompt, because it already checks itself.
- 🔒 **Sensitive files stay out of the model's context by default** — `secrets.yaml`, `.storage/`, `.cloud/`, `ssl/`, and key/cert files are read-protected unless you turn that off.

**Additional best practices:**

- 💾 **Always backup** your configuration before significant changes
- 👀 **Review changes** suggested by the AI before accepting them  
- 📝 **Use version control** (git) when possible for easy rollback

---

## 🧭 Home Assistant Native LLM Roadmap

Home Assistant is building native `llm` platform support directly into Core: the `llm` integration, per-domain tool platforms, and keyed `/api/mcp/<API ID>` endpoints all ship for the first time in **Home Assistant 2026.8**. OpenCode is tracking this closely and aims to be a premium consumer of the agent capabilities Home Assistant makes available.

OpenCode already ships an opt-in **Native Home Assistant MCP bridge** (beta) that targets these endpoints, falling back to the older configured `/api/mcp` endpoint on earlier Home Assistant versions and retrying periodically — so an already-running add-on picks up a Home Assistant upgrade on its own. Turning it on takes two one-time steps: add the **Model Context Protocol Server** integration in Home Assistant, then enable the bridge and restart the add-on. `get_agent_capabilities` reports whether the bridge is enabled and actually reachable, rather than leaving a stalled bridge to look like a broken configuration.

OpenCode's own MCP tools remain the complete, supported working surface regardless of bridge status — this roadmap is about *adding* native capabilities where they fit well, not replacing safe config writing, validation, admin/dev workflows, screenshots, firmware updates, or troubleshooting.

See the [full documentation][docs] for the current support status and long-term integration plan.

---

## 📚 Documentation

Comprehensive documentation is available covering all features:

- 📖 [**Full Add-on Documentation**][docs] - Complete guide to all features
- 📝 [**Changelog**][changelog] - Version history and updates

---

## 🤝 Support

Need help? We've got you covered:

<table>
<tr>
<td align="center" width="33%">

### 💬 Discord
[Join OpenCode Discord](https://opencode.ai/discord)

Community support & discussions

</td>
<td align="center" width="33%">

### 📖 Documentation
[OpenCode Docs](https://opencode.ai/docs)

Comprehensive guides & tutorials

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
experimental work in `ha_opencode_beta/`; touch `ha_opencode/` only for changes
that should reach stable users right away.

Both add-ons can be installed side by side — they keep separate decision notes
and separate storage. Full details in [RELEASING.md](RELEASING.md).

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

## 👏 Authors & Contributors

<table>
<tr>
<td align="center">
<a href="https://github.com/magnusoverli">
<img src="https://github.com/magnusoverli.png" width="100px;" alt="Magnus Overli"/><br />
<sub><b>Magnus Overli</b></sub>
</a><br />
<sub>Creator & Maintainer</sub>
</td>
<td align="center">
<a href="https://github.com/Teeflo">
<img src="https://github.com/Teeflo.png" width="100px;" alt="Teeflo"/><br />
<sub><b>Teeflo</b></sub>
</a><br />
<sub>ARM64 fixes, README, icons & logo</sub>
</td>
<td align="center">
<a href="https://github.com/balloob">
<img src="https://github.com/balloob.png" width="100px;" alt="Paulus Schoutsen"/><br />
<sub><b>Paulus Schoutsen</b></sub>
</a><br />
<sub><a href="https://github.com/balloob/home-assistant-build-cli">hab CLI</a> — admin backbone</sub>
</td>
<td>

### All Contributors

See the [contributors page](https://github.com/magnusoverli/opencode/graphs/contributors) for the full list of amazing people who have helped make this project better!

</td>
</tr>
</table>

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
[cpu-req]: ./ha_opencode/DOCS.md#cpu-requirements
[changelog]: ./ha_opencode/CHANGELOG.md
[issues]: https://github.com/magnusoverli/opencode/issues
[license]: UNLICENSE
[github]: https://github.com/magnusoverli/opencode
[repo-add]: https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fmagnusoverli%2Fopencode
[repo-btn]: https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg

<!-- Badges -->
[version-shield]: https://img.shields.io/github/v/release/magnusoverli/opencode.svg?style=for-the-badge
[project-stage-shield]: https://img.shields.io/badge/project%20stage-experimental-orange.svg?style=for-the-badge
[license-shield]: https://img.shields.io/github/license/magnusoverli/opencode.svg?style=for-the-badge
[maintenance-shield]: https://img.shields.io/maintenance/yes/2026.svg?style=for-the-badge
[stable-build-shield]: https://img.shields.io/github/v/release/magnusoverli/opencode?style=for-the-badge&label=stable%20release
[beta-build-shield]: https://img.shields.io/github/v/release/magnusoverli/opencode?include_prereleases&style=for-the-badge&label=beta%20release
[stable-build-workflow]: https://github.com/magnusoverli/opencode/releases
[beta-build-workflow]: https://github.com/magnusoverli/opencode/releases
