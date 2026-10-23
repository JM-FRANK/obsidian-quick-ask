# Changelog

## 1.0.6 — Image tools, ordered process views and faster history

### Added

- Let the model request authorized images with `get-image`, including exact image paths and image links from Markdown documents already sent to the conversation. Tool results remain available for active-history replay; session logs retain paths rather than image bytes.
- Show reasoning and individual tool calls in an ordered, collapsible process view, with expandable call details, lazy Markdown rendering and a shared scroll area. Successful turns collapse the process while keeping the final answer visible; older session logs remain readable.
- Add image-viewer zoom and bounded panning, with finer wheel and keyboard adjustments and a 20% minimum scale.
- Add formula and Mermaid source views, diagram previews, and shared code/table copy controls.

### Changed

- Initially render the latest eight conversation turns and load earlier history on demand. Batch formula measurements to reduce long-history rendering work; deleting a session selects the remaining session with the most recent content activity.
- Run local tools concurrently with one queue shared across sessions. The concurrency setting defaults to 3 and supports 1–10; remove per-question call and continuation limits. Tool failures remain independent, and results return in model-call order.
- Keep local read tools available alongside provider search. Choose mixed or independent provider search per connection; independent mode sends only the query to a search-only child request and returns its evidence to the conversation, without automatically switching services or modes.
- Describe historical selection positions in words and Han characters, and refine answer-format instructions for new requests.
- Keep generated installation bundles out of source control. Release builds continue to provide the three Obsidian installation files with embedded license notices and source provenance.

### Fixed

- Address CSS review warnings by replacing `!important` with scoped selector specificity and styling MathJax containers through their generated class.
- Resolve document image links to exact paths without substituting a same-named image when the target is missing, and reject unreadable image contents.
- Handle empty session configuration before an existing conversation has loaded.
- Account independent provider-search usage without treating its input tokens as the main conversation's context occupancy.

### Validation and upgrade notes

- The synchronized feature snapshot passed 47 upstream core test files, 9 distribution checks and 693 standalone tests, with matching standalone build output. Release metadata and artifacts are checked again during release preparation. User-owned UI and provider acceptance remain tracked separately where still open.
- Version 1.0.6 requires Obsidian 1.13.7 or later on desktop. Existing session logs are not rewritten. Image inputs still send once by default; later image retrieval requires a model tool call within the authorized image/document scope.

## 1.0.5 — Model connections, provider search and selection history

### Added

- Save multiple model connections with their own Base URL and named API secret. Each connection remembers its selected model, and each model can use its own protocol and context window. Discover models after editing connection details or with an explicit refresh; model discovery sends no note content. Manual model IDs remain available.
- Show submitted text selections above their user message, including replayed history. Previews use a single fading line and the user's bubble tint; hovering for 0.75 seconds shows a source filename and the full original quote in a readable, scrollable card. Selection references have no click or navigation action.
- Add an initial study-quiz system profile with three questions, including upgrade seeding with a unique name that preserves existing profiles.

### Changed

- Organize settings into General, Model connections, System roles, Web search, Appearance, and Data and backups. Existing single-connection settings migrate to a default connection; connection/model changes apply to new sessions, while existing sessions retain their saved configuration.
- Support DeepSeek's independent Search API across DeepSeek models and both request protocols, native Gemini API-key search, and compatible relay endpoints, including CPA/Antigravity Gemini Responses and Chat Completions search. Search remains manually selected, with DuckDuckGo as the default. Google search turns retain explicit Context without local file tools.
- Reduce session-index write amplification while keeping canonical session records append-only and immediately persisted.

### Fixed

- Resolve file-reference aliases and heading/block suffixes to Vault paths while respecting code and other literal syntax. Preserve Composer code whitespace.
- Preserve full native Gemini search history and grounding metadata for native replay, and project the ordinary fields for plain Chat Completions history.
- Keep release attachments limited to the three Obsidian installation files, with license notices embedded in the bundle and checksums in release notes.

### Validation and upgrade notes

- The latest upstream change passed 36 core test files and 8 distribution checks; the standalone snapshot passed 549 tests and build/source consistency checks. Historical selection display and UI refinements were accepted by the user. Remaining unrelated acceptance items stay tracked separately.
- Version 1.0.5 requires Obsidian 1.13.7 or later on desktop. API access is supplied by your chosen provider; discovering a model does not verify its generation or search compatibility. Existing session logs and accepted model inputs are not rewritten.

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
