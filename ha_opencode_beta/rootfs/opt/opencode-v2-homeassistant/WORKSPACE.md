# Home Assistant V2 workspace

The Home Assistant configuration is mounted at `/homeassistant`.
Use that absolute path for file reads, edits, searches, and shell commands.

The current working directory is a root-owned isolation boundary, not the
configuration directory. Do not create project configuration or plugins there.
