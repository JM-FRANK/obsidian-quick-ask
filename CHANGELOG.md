# Changelog

## Unreleased

- Preserve profile-control subscriptions during page construction and clean them up after an observed detach.

- Prevent programmatic profile-control refresh from saving the displayed default as custom text; preserve exact default request bytes on settings open and Reset.
- Keep profile actions and legacy prompt updates atomic, with explicit normalization for older settings writers.
- Fix Scholar Workbench host packaging to discover new Quick Ask modules and reject missing local dependencies, preserving historical factory order and excluding already-inlined Composer state.

- Show the editable default role on fresh installs and add Restore default without changing default request bytes or existing session roles.
- Add named system profiles, settings management and a command-palette switcher. Show the selected profile in the sidebar header; switches apply to new sessions only.
- Focus the Quick Ask input after an accepted editor-selection drop inside it; keep pending-area, rejected and file-explorer drop behavior unchanged.

- Renderer 3 replaces the entire default literature-reading paragraph with a nonblank custom prompt after the fixed safety, format and tool rules. Empty prompts preserve renderer 2 bytes.
- Fresh questions in existing sessions adopt renderer 3 using the saved custom prompt, which can break prompt-cache continuity. Historical retries retain renderer 1/2 instructions exactly; setting changes still affect new sessions only.

## 1.0.2 — Chat Completions, reasoning controls and numbered context

- Add explicit Chat Completions protocol selection with native streaming/tool history, local replay and structured-summary compaction. Existing sessions retain their protocol; no automatic protocol fallback.
- Protect Chat Completions logs from older plugin writers with a separate format version, preserve refusal text and retain reported usage on interrupted streams.
- Display readable Chat Completions reasoning and add five shared effort levels through the command palette and a plain Composer label.
- Number outgoing file context and selection lines without changing source files or tracking baselines.
- Commit search/effort state with valid sends instead of writing session logs for each toggle.

## 1.0.1 — Community review fixes

- Upgrade diff to 8.0.3, fixing GHSA-73rr-hh4g-fpgx in the bundled dependency.
- Replace clip-path bubble tails with CSS border triangles and use traditional clipping for screen-reader-only labels.
- Preserve the 1.13.7 minimum Obsidian version and accessible role labels.

## 1.0.0 — First standalone release

- Ask AI about explicitly selected Markdown text and referenced files in a dedicated sidebar.
- Stream answers and supported reasoning summaries, track context changes, and compact long conversations.
- Keep local per-session conversation history with export/import and optional plaintext backup copies.
- Configure a Responses-compatible endpoint, model, named API secret and display preferences.
- Offer English and Simplified Chinese settings and core interface text; some interface text remains English.
- Publish Quick Ask independently from the same source maintained in Scholar Workbench, with separate view identity and session storage.
- Use Apache License 2.0 for Quick Ask; preserve third-party dependency licenses.

**Switching from Scholar Workbench:** export/import sessions, reconfigure the endpoint/model/secret, and disable the built-in Quick Ask. Existing Scholar sessions are retained. Desktop only; requires Obsidian 1.13.7 or later.
