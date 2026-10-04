# Changelog

## 1.0.4 — Image attachments and context-window improvements

### Added

- Send explicitly added PNG/JPEG/WebP images through Responses or Chat Completions, including image-only questions. Add them with the Vault picker, Vault/external drag and drop, or clipboard paste; Markdown embeds are not attached automatically.
- Send original bytes without resizing or compression. Limits are 20 MiB per image, 20 images and 200 MiB combined per question; oversized or unsupported input receives a clear error.
- Show removable previews above the context-file collapse bar and image previews in user-message history. Missing sources display a theme-aware, borderless placeholder.
- Open previews in a window-sized viewer that keeps the image's aspect ratio, with an 85%-opacity dark mask and a body-sized title at the window top. Escape, the backdrop or the close button dismisses it; pop-out windows use their own viewer.
- Add **Keep cached images**, enabled by default. External and pasted images stay in the plugin cache. Turning it off clears those images on the next Obsidian reopen; disabling/re-enabling or reloading the plugin does not clear them. Original Vault images are unaffected.

### Changed

- Image bytes appear only in the first model request of a submitted question. Tool continuations, later questions and compaction do not resend them. Session logs, exports and preserved copies retain image paths only, not image files; moving/deleting a source can make its history preview unavailable.
- Explicit image retries reread the current source and refuse missing or unreadable images. Local token estimates exclude image cost and say so; provider usage remains the billing authority.
- Default the context window to **200,000 tokens (200K)** and display/edit it in decimal K with a fixed suffix. Decimal values such as `262.144K` save exact whole tokens; the capacity must exceed 16.384K. Clearing the field retains its previous behavior. Existing settings and session capacity snapshots are not migrated.
- Append to the built-in role: “Unless explicitly requested by the user, you must not include any line-number-related information in your responses.” Renderer 4 uses the new rule; custom roles and historical renderer 1–3 retries retain their existing behavior. Source line metadata remains available.

### Fixed

- Preserve original image proportions in thumbnails and remove the fixed-height dark letterboxing, borders and button shadows. Align missing-image placeholders with the same borderless presentation.
- Allow image-only questions to complete read-only tool calls without resending images.
- Keep asynchronous image acquisition in its owning session, prevent deleted-draft recreation and check concurrent attachment limits at commit time.
- Share pending startup cleanup across plugin reloads and check actual cumulative bytes before encoding changed source files.
- Avoid floating-point loss when parsing and displaying decimal K capacities, and preserve the mounted capacity input while typing.
- Remove the dedicated footer image button; existing picker, drag-and-drop and paste inputs remain available.

### Validation and upgrade notes

- Verified 32 upstream core test files and 27 standalone test files, plus source provenance and matching build outputs. The user accepted the recent Quick Ask additions and fixes; remaining backlog items are tracked separately.
- Version 1.0.4 requires Obsidian 1.13.7 or later on desktop. Source synchronization does not publish a GitHub Release; installation assets must be released separately.

## 1.0.3 — Compaction replay, file references and system profiles

- After compaction, reintroduce tracked files as path references instead of repeating their full bodies. Preserve the recent tail, local history and existing full-file retrieval limits.
- Restore post-compaction occupancy and its composition after session switching or reload, entirely offline, without reusing pre-compaction usage or triggering redundant compaction on the next send.
- Use tokenx for all local token estimates, retaining the approximate marker and exact provider usage.
- Remove the inner compaction retry; retain the final send-time capacity check and existing historical dividers.
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
