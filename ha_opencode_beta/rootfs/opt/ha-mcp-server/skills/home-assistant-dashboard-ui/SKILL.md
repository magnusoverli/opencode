---
name: home-assistant-dashboard-ui
description: Build or change Home Assistant dashboards — Lovelace views, cards, layouts, themes, badges, custom cards and card-mod — and verify the result visually with a screenshot. Covers choosing between hab dashboard commands and YAML mode, the standard card set, conditional and template cards, and the screenshot verification loop. Load this for any Lovelace, dashboard, view, card, or theme request.
metadata:
  owner: ha-opencode-addon
---

# Dashboards and UI

## Which mechanism this installation uses

Find out before proposing anything — the two are not interchangeable.

- **Storage mode (default)**: dashboards live in `.storage/`, which is
  off-limits to direct editing. Use **`hab dashboard`**:
  `hab dashboard list`, `hab dashboard get <url_path>`,
  `hab dashboard create`, `hab dashboard view create`. This is the primary path
  for most installations.
- **YAML mode**: `lovelace:` in `configuration.yaml` names a dashboard file.
  Then it is ordinary YAML — the configuration skill's style guide and
  `write_config_safe` apply.

`hab dashboard list` tells you which dashboards exist and how they are managed.
`hab dashboard get <url_path> --json` gives you the current structure to modify;
read it before writing, exactly as with any config file.

## Building a view

Start from what the home actually has: `get_home_context` for the area and its
entities, or `get_areas` when laying out an area-per-view dashboard. Do not
invent entity IDs — every card you write should reference an entity you have
confirmed exists.

Standard cards worth knowing: `entities`, `tile`, `button`, `light`, `thermostat`,
`media-control`, `weather-forecast`, `history-graph`, `statistics-graph`,
`gauge`, `picture-elements`, `map`, `markdown`, `todo-list`, `area`, and the
layout cards `grid`, `vertical-stack`, `horizontal-stack`, `sections`.

- **`conditional`** shows a card only while a condition holds — the usual way to
  hide something that is irrelevant most of the time.
- **`custom:`** cards come from HACS. Check the resource is actually installed
  (`hab dashboard resources list`, or the `www/` folder) before writing one in;
  a missing custom card renders as an error box for the user.
- **card-mod** styling is a custom-card feature too, and equally dependent on
  the resource being present.

Views take `title`, `path`, `icon`, `type` (`sections`, `panel`, `masonry`,
`sidebar`), `badges`, and `cards`. Sections view type is the current default for
new dashboards and behaves differently from masonry — check which one the
existing dashboard uses before adding cards to it.

Follow the YAML style guide when writing dashboard YAML: block sequences,
double-quoted strings, unquoted entity IDs, `target:` for actions.

## Verifying visually

`screenshot_url` renders a page in a headless browser so you can see what the
user will see. It requires the **Screenshot tool** option and a long-lived
access token in the add-on configuration; if it is not available, say so rather
than claiming a change looks right.

The loop:

1. Make the change (with approval).
2. `screenshot_url` the dashboard path — for example
   `http://homeassistant.local:8123/lovelace/kitchen`, or the `url_path` from
   `hab dashboard list`.
3. Look at it. Check the things that break silently: cards that render as an
   error box, entities showing `Unavailable`, a layout that wraps badly,
   a title that got dropped.
4. Report what you see, with the screenshot, and fix or ask.

Screenshot the page **after** a change, not just before — an unverified
dashboard edit is the change most likely to look fine in YAML and wrong on
screen. Mention that mobile and desktop widths differ if the layout is
width-sensitive.

## Themes

Themes live in `themes/` and are referenced by `frontend:` in
`configuration.yaml`. Adding one needs a restart or a `frontend.reload_themes`
call; changing an existing theme file needs the reload. Theme variables are
frontend CSS variables — verify with a screenshot, since a typo in a variable
name fails silently rather than erroring.
