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

[Installation](#-installation) • [Features](#-features) • [Documentation][docs] • [Support](#-support)

---

</div>

## ✨ About

**OpenCode** brings the revolutionary [OpenCode](https://opencode.ai) AI coding agent directly into your Home Assistant instance. Experience intelligent configuration editing through natural language, advanced YAML assistance, and deep integration via the Model Context Protocol (MCP).


### 🎯 Key Features

<table>
<tr>
<td width="50%">

#### 🤖 **AI-Powered Editing**
Use natural language to modify your Home Assistant configuration. No more searching documentation - just ask!

#### 🎨 **Two Interface Modes**
Choose your experience from the sidebar: a beautiful web **terminal** with 10 themes, or the graphical **OpenChamber** web UI — both served through Home Assistant Ingress.

#### 🔌 **Provider Agnostic**
Works with **75+ AI providers**: Anthropic, OpenAI, Google, Groq, Ollama, and many more.

</td>
<td width="50%">

#### 🔧 **Deep MCP Integration**
37 tools, 14 resources, and 6 guided prompts for comprehensive Home Assistant interaction.

#### 💡 **Intelligent LSP Support**
Smart YAML editing with entity autocomplete, live hover information, deprecation warnings, and go-to-definition support.

#### 🛡️ **Safe Config Writing**
Validated config pipeline with automatic backup/restore. Multi-layered checks are designed to prevent AI-written config from breaking your HA instance.

#### 🏗️ **hab CLI Integration**
Includes the [Home Assistant Builder CLI](https://github.com/balloob/home-assistant-build-cli) by [@balloob](https://github.com/balloob) — a CLI purpose-built for AI agents to manage Home Assistant via REST and WebSocket APIs. Enables dashboard CRUD, area/floor management, helper creation, backup/restore, and bulk admin operations that would otherwise require direct API calls or UI interaction.

#### 🧭 **HA Native LLM Ready**
Tracks Home Assistant's emerging native `llm` integration and native MCP endpoints such as `/api/mcp/<API ID>`, reports readiness through MCP, and targets beta-channel bridge testing first.

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

OpenCode works with **75+ AI providers**. Choose the one that fits your needs:

<details>
<summary><b>🔥 Popular Providers (Click to expand)</b></summary>

| Provider | Available Models |
|----------|------------------|
| 🧠 **Anthropic** | Claude 4 Opus, Claude 4 Sonnet, Claude 3.5 Sonnet, Claude 3.5 Haiku |
| 💎 **OpenAI** | GPT-4o, GPT-4 Turbo, o1, o1-mini, o3-mini |
| 🌈 **Google** | Gemini 2.0 Flash, Gemini 1.5 Pro, Gemini 1.5 Flash |
| ☁️ **AWS Bedrock** | Claude, Llama, Mistral (via AWS) |
| 🔷 **Azure OpenAI** | GPT-4, GPT-4 Turbo (Azure hosted) |
| ⚡ **Groq** | Llama 3, Mixtral (ultra-fast inference) |
| 🎯 **Mistral** | Mistral Large, Mistral Medium, Codestral |
| 🦙 **Ollama** | Local models (Llama, CodeLlama, Mistral, etc.) |
| 🌐 **OpenRouter** | 100+ models through single API |
| 🤝 **Together AI** | Llama, Mixtral, and open models |
| 🔥 **Fireworks AI** | Fast inference for open models |
| 🚀 **xAI** | Grok models |
| 💫 **Deepseek** | Deepseek Coder, Deepseek Chat |

</details>

### 🎁 **Free Tier - OpenCode Zen**

Start immediately with **OpenCode Zen** - no API keys or subscriptions required! Get access to curated models optimized for coding tasks, perfect for trying OpenCode or for users who prefer not to manage their own API keys.

Simply run `/connect` and select **OpenCode Zen** to get started for free.

---

## 📦 Installation

### Quick Install

1. **Add this repository to Home Assistant:**

   [![Add Repository][repo-btn]][repo-add]

   <details>
   <summary>Or add manually</summary>
   
   Go to **Settings** → **Add-ons** → **Add-on Store** → **⋮** → **Repositories**
   
   Add: `https://github.com/magnusoverli/opencode`
   </details>

2. **Install the add-on:**
   - Find **"OpenCode"** in the add-on store
   - Click **Install**

3. **Start using it:**
   - Start the add-on
   - Click **Open Web UI** (or use the sidebar)
   - Run `opencode` and use `/connect` to configure your AI provider

   > 💡 **Prefer a graphical interface?** Set **Interface Mode** to `openchamber` in the add-on **Configuration** tab and restart to swap the terminal for the [OpenChamber](https://github.com/openchamber/openchamber) web UI on the same sidebar entry. The default `terminal` mode is unchanged.

---

## 🛡️ Safety & Validation

> **This add-on has read/write access to your Home Assistant configuration directory.**

It also mounts Home Assistant add-on development folders (`/addons` and `/addon_configs`) so OpenCode can help with custom add-ons. Treat `/addon_configs` as sensitive because it may contain configuration data for other add-ons.

OpenCode includes a multi-layered validation pipeline designed to prevent AI-written configuration from causing your Home Assistant to fail to start:

- 🔍 **Automatic config validation** — every config write is validated through HA Core's own check before committing
- ↩️ **Automatic backup/restore** — if validation fails, the original file is instantly restored
- 🧪 **Jinja2 template pre-validation** — templates are tested through HA's engine before writing to disk
- 📋 **Deprecation scanning** — 20+ patterns catch outdated syntax, auto-updated from GitHub
- 🏥 **HA Repairs integration** — surfaces your installation's active deprecation warnings
- ⚠️ **Structural checks** — catches missing triggers, actions, and other required fields

**Additional best practices:**

- 💾 **Always backup** your configuration before significant changes
- 👀 **Review changes** suggested by the AI before accepting them  
- 📝 **Use version control** (git) when possible for easy rollback

---

## 🧭 Home Assistant Native LLM Roadmap

Home Assistant is developing a native `llm` integration so Core integrations and custom integrations can expose curated tools to Assist through `<integration>/llm.py` and registered LLM APIs over `/api/mcp/<API ID>`. OpenCode will follow this work closely and aims to be a premium consumer of the agent capabilities Home Assistant makes available.

Today, the add-on keeps MCP as the complete working tool surface, adds readiness reporting through `get_agent_capabilities` / `ha://agent/capabilities`, provides compact `get_home_context` discovery, and includes a native LLM provider guide for custom integration authors. The beta channel can opt into a configurable native MCP bridge targeting `/api/mcp/<API ID>` with `assist` as the default. As HA-native LLM capabilities become stable and accessible to add-ons, OpenCode will prefer native HA tools where they fit while keeping MCP for safe config writing, validation, admin/dev workflows, screenshots, firmware updates, and troubleshooting.

See the [full documentation][docs] for the current support status and long-term integration plan.

---

## 📚 Documentation

Comprehensive documentation is available covering all features:

- 📖 [**Full Add-on Documentation**][docs] - Complete guide to all features
- 📝 [**Changelog**][changelog] - Version history and updates

---

## 🎯 Quick Start Examples

Once installed and connected to an AI provider, try these commands:

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

---

<div align="center">

### ⭐ If you find OpenCode helpful, please star this repository!

**Made with ❤️ for the Home Assistant community**

[Installation](#-installation) • [Features](#-features) • [Documentation][docs] • [Support](#-support)

</div>

<!-- Links -->
[docs]: ./ha_opencode/DOCS.md
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
