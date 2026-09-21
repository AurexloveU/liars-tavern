# Codex runtime workspace

This directory is an intentionally empty, non-instructional working directory for the local Codex app-server player. Local save and statistics JSON files are stored here and excluded from Git. It contains no credentials, project instructions, skills, hooks, MCP configuration, or tool scripts.

`codex-provider.js` starts the locally installed Codex CLI with the current desktop login session, `--disable plugins`, `project_doc_max_bytes=0`, a separate reusable ephemeral thread per seat, `approvalPolicy: "never"`, and a read-only sandbox with no network access. The provider sends only the public game view and that seat's own hand. It requests the selected preset (Astra medium, Sol high, Terra xhigh, or Luna max), allows one JSON repair request, and never substitutes a rule-based player.

The provider keeps a per-room cap on real `turn/start` requests (150 by default). Tests inject a protocol client and do not contact a model. The directory is not a place to put a Codex API key or any other secret.
