---
name: home-assistant-troubleshooting
description: Diagnose a Home Assistant problem without changing anything — an unavailable or stuck entity, an automation that did not fire, a template error, a failing integration, a slow or unhealthy system. Covers bounded state, history, logbook and log queries, Supervisor health and repair evidence, and how to end with a recommendation rather than a fix. Load this when the user reports something broken, missing, or behaving oddly.
metadata:
  owner: ha-opencode-addon
---

# Troubleshooting Home Assistant

**This work is read-only and ends in a recommendation.** Gather evidence,
explain what it shows, propose the smallest fix — and stop. Do not edit files,
call services, restart, reload, or "just try" a change while investigating. The
user asks for a fix separately, and then the configuration skill applies.

## Keep queries bounded

Diagnostics is where context gets burned. Every query below has a narrower form;
use it. A dump of every entity or a full log crowds out the evidence that
actually matters.

- `get_home_context` before any broad listing — it answers most "what exists"
  questions in a fraction of the tokens.
- `search_entities` with a pattern, not `get_states` with no filter.
- `get_states(domain=...)` when you do need a list.
- `get_history` / `get_logbook` over the shortest window that could show the
  problem. Start at a few hours, widen only if it is not there. Supplied
  timestamps must carry `Z` or a UTC offset.
- `get_error_log` before `get_support_logs`; the error log is already filtered.
- `get_support_logs` when you need Core, Supervisor, host or add-on logs — it is
  bounded and credential-redacted. Name the component and keep the line count small.

If a query comes back empty, that means *that query* found nothing. Widen the
window or change the search term before concluding the thing does not exist.

## Order of attack

**Start with `diagnose_entity`** whenever the report names an entity. It bundles
current state, recent history, related entities and the common causes, so it
usually replaces four separate calls.

Then, depending on what it shows:

| Symptom | Next evidence |
|---|---|
| `unavailable` / `unknown` | `get_entity_details` for the integration and device; `get_devices` for the parent device; the integration's entries in `get_error_log` |
| Entity missing entirely | `search_entities` for the old and new names; check whether it was renamed or the integration failed to load |
| Automation did not fire | `get_logbook` for the automation entity; read the automation YAML; check each condition against `get_history` at the trigger time |
| Template error | `render_template` with the exact expression; check the referenced entities exist and are not `unknown` |
| Value looks wrong | `get_history` for the entity, then for its source entity |
| Integration failing to set up | `get_error_log`; `get_supervisor_resolution` for known issues |
| Slow, restarting, or out of space | `get_supervisor_health`, `get_supervisor_metrics`, `get_backup_posture`, `get_store_audit` |
| Something changed after an update | `get_breaking_changes`; the release notes for the installed version |

`detect_anomalies` and `get_suggestions` are worth a call when the user reports
something vague ("the house feels off") rather than a specific failure.

## Common causes worth ruling out early

- The device is offline, asleep, or out of battery — check `last_updated`, not
  just the state.
- The entity was renamed and something still points at the old `entity_id`.
- The integration failed to load at start-up; everything downstream then reads
  `unknown`.
- A template referencing an entity that is `unavailable` at start-up and never
  recovering because the template has no trigger.
- An automation whose condition is evaluated against a state that has already
  changed by the time the action runs.
- Two automations fighting over the same entity.
- A recorder exclusion hiding the history you are looking for.
- A change the user made deliberately — check `recall_decisions` before calling
  something a bug. A note may already explain it.

## Reporting

Say what you observed, what it means, and what you would change — in that order,
briefly. Distinguish what the evidence shows from what you infer. If the
evidence is not conclusive, say what would settle it.

End with a concrete proposal and let the user decide:

> `sensor.kitchen_temperature` last reported 4 hours ago and its Zigbee device
> shows `lqi: 0`. The battery entity reads 4%. The likely fix is a new battery,
> not a configuration change. Want me to check the other sensors on that device?

If the fix means editing configuration, hand over to the configuration skill and
get approval first. If it means restarting or reloading, say which and why —
never do it as part of investigating.
