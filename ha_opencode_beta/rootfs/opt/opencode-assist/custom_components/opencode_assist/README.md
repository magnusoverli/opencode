# OpenCode Assist companion (experimental)

Targets **Home Assistant 2026.10–2026.11 with Supervisor**, with automated contracts
against **2026.10.0b0** and **2026.11.1**. Companion **0.1.0b8** uses HA's **AI tools**
wording and explains the broader administrator API. It ships the add-on's icon/logo
through HA's local `brand/` support and limits each app connection to one
conversation agent and one AI data task.
Existing entities remain configurable; duplicate setup shows guidance instead
of adding another entity of the same type.

1. Configure a supported provider/model in OpenCode. Enable `ha_assist_enabled`
   in the beta app options and restart the app. It installs the bundled companion
   into HA's `custom_components/opencode_assist` before starting the Assist service.
2. **Restart Home Assistant**, not just the app, after installation or an update.
   HA must reload custom integration code. This interrupts HA automations and
   Assist while Core restarts; the app never initiates that restart automatically.
3. In **Settings → Devices & services**, configure the discovered **OpenCode
   Assist** app. Choose a **Conversation agent** for Assist voice/text conversations
   or an **AI data task** for generated text/structured data in automations and
   scripts, then confirm the connection. You can add both, one at a time.
   Supervisor supplies the connection details and an expiring
   bootstrap; HA generates and exchanges a scoped key automatically. Nothing
   needs copying. **Add integration → OpenCode Assist** finds the same app.
4. HA opens model/API selection as the next step. Choose a model and, for
   conversations, the **AI tools** to expose. No APIs are selected automatically.
   **Device control** (`assist`) respects exposed entities; HA 2026.11's
   **Home Assistant** (`homeassistant`) tools require an administrator and are
   not limited to exposed entities. HA checks the conversation caller's permissions.
   Select the conversation entity in your Assist pipeline or the AI task entity
   for `ai_task.generate_data`.

To add the other type later, open **Settings → Devices & services → OpenCode
Assist**, then select **Add conversation agent** or **Add AI data task**. These
buttons also appear in the existing app connection's overflow menu. **Add app
connection** creates a separate app connection; it is not the add-entity action.
Both entity types share the existing pairing, and each has its own model settings.
Use an existing entity's **Configure** button to change its settings. HA 2026.10–2026.11
uses the same supported-type declaration for Add and Configure, so the Add buttons
remain visible even after a type has been added; duplicate creation is rejected.
Removing a service lets you add that type again. Existing duplicate entities from
earlier versions are retained and can still be configured or removed individually.
Once paired, open **Settings → Devices & services → OpenCode Assist** to add
the second type to the existing connection.

The image and release `opencode-assist.zip` use this same source directory; no
integration code is downloaded at runtime. Automatic installation only updates
an unmodified app-managed copy. A manually installed integration (including an
earlier ZIP) or edited app-managed files cause an explicit conflict in the app
log; existing files are preserved and Assist does not start. Back up and move
that directory out of `custom_components` if you want to opt into app management,
then restart the app and HA. Old experimental manually paired HA entries should
be removed and recreated through discovery; no migration or manual pairing form
is provided. Disabling `ha_assist_enabled` stops the adapter and withdraws its
advertisement but leaves installed files, pairing and HA configuration intact.
Normal restarts and rediscovery keep the same pairing and subentries.

When companion files are installed or updated, the app creates a notification in
HA's **Notifications** panel with the companion version, installation time and
Core-restart guidance. It retries while HA is unavailable and uses one notification
ID, so subsequent updates replace the notice. A delivery receipt prevents ordinary
app/worker restarts from repeating it. HA clears notifications on Core restart;
if delivery was delayed until after you already restarted, dismiss the reminder.
No automatic Core restart is performed.

Beta **3.2.0b6** removes the redundant Assist setup header from both Ingress modes.
Setup is available through HA discovery or **Add integration → OpenCode Assist**,
including on mobile. If discovery is missing, check the app log for installation conflicts,
restart Core after installing/updating the companion, then retry when Supervisor
and OpenCode are available. If there are no models, configure a provider/model
in OpenCode and resubmit; no pairing is created before a model is available.

HA owns conversation history, user/device context, exposure rules and tool
execution. The app receives only that request's history, prompt and selected tool
schemas; it returns structured tool calls to HA. Each request uses a disposable,
deny-by-default OpenCode session with no coding/admin-tool fallback. HA history
is sent to the chosen model provider; its normal usage charges and data policies
apply. Choose a provider that supports external/companion use; OpenCode free-tier
restrictions also apply to this private agent. Transient OpenCode sessions are removed on completion or cancellation;
this is not a secure-erasure guarantee for database files or provider logs.
A worker/runtime crash can leave a temporary session behind; automatic orphan
cleanup and crash-recovery retention are not qualified in this first beta.

The pairing key permits model usage through this scoped adapter only. It is
stored in HA's config entry; the app stores only its digest. Supervisor's persisted
discovery record contains only an expiring bootstrap, never that durable key.
Renew the connection through HA's reauthentication or Reconfigure flow; confirmation
replaces its key and cancels active requests. Internal HTTP ports **8768/8769**
must remain unpublished. The beta app's pairing store is separate from stable
and from inbound MCP credentials. Removing the integration stops its requests
and revokes its pairing when the app is reachable. If removed while the app is
offline, the next confirmed setup replaces the old key.

AI data tasks support text and JSON validated against the requested schema.
They fail if the model returns invalid structured output; this adapter does not
claim provider-enforced JSON generation. Attachments, images and binary outputs
are not advertised. Selected custom HA APIs retain their own authorization
semantics; selecting a broader API does not acquire Assist's exposure boundary.

On HA 2026.11, HA can cache the selected tools and system prompt for a conversation.
Use tools for current state and start a new conversation after changing exposure
or instructions. HA rejects concurrent turns on the same conversation and retains
failed turns in its history; the adapter preserves HA's history and current caller
context. HA's MCP Server **Read-only** setting does not filter this companion's
directly selected AI tools.

Requests are bounded to two minutes, eight concurrent generations, 128 selected
tools, 32 tool calls, 256 history messages and a 512 KiB request body. Oversized
history fails explicitly instead of being silently compacted outside HA.

Diagnostics contain protocol/capability flags and selected-API counts only.
Full supervised HA installation, pairing/setup and voice-pipeline acceptance
remain experimental follow-up work; see
[issue #45](https://github.com/magnusoverli/opencode/issues/45) for verification
evidence and remaining qualification.
