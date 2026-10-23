# Quick Ask user guide

**English** · [简体中文](user-guide_zh.md) · [Project overview](../README.md)

Configuration, daily use, image handling, network access and local data.

## Installation

Requires **Obsidian 1.13.7+ on desktop**. Mobile is not supported.

Install from the Obsidian community plugin directory:

1. Open **Settings → Community plugins → Browse**.
2. Search for **Quick Ask**, select **Install**, and enable it.
3. Configure a model connection in Quick Ask settings before submitting a question.

For manual installation, download `main.js`, `manifest.json` and `styles.css` from a [published release](https://github.com/JM-FRANK/obsidian-quick-ask/releases). Copy them into your Vault's `.obsidian/plugins/quick-ask/` directory, then enable Quick Ask. Use the actual Vault configuration directory if you have customized it. Check the [changelog](../CHANGELOG.md) for changes included in your installed version.

## Getting help

For questions, bugs or feature requests, [open a GitHub issue](https://github.com/JM-FRANK/obsidian-quick-ask/issues). Include your Obsidian/plugin versions, operating system, request protocol and steps to reproduce. For layout problems, include the theme name and a screenshot. Leave out API keys and private note content.

## Set up your models

Open **Settings → Quick Ask → Model connections**. Add a connection with a **Base URL** and **named API secret**, then choose a model and set its **request protocol** and **context window**.

- Select **Responses** or **Chat Completions** explicitly to match your service. For a compatible `/v1` endpoint, enter the Base URL without appending `/responses` or `/chat/completions`. The plugin does not switch protocols automatically after errors.
- Each connection remembers its selected model. Each model stores its own protocol and context window. The default window is **200K tokens**; configure it to match your service.
- When both address and secret are configured, editing either triggers a model-list request. **Refresh models** repeats it. Opening settings, selecting a saved connection and restarting do not fetch model lists. Discovery sends no note content, preserves existing selections and model overrides, and does not verify generation compatibility. You can enter a model ID manually.
- Existing single-connection settings migrate to a default connection. Settings changes do not automatically refresh existing conversations. Use the current conversation’s effort-label menu to explicitly select another saved model with the same protocol. Removing a connection does not alter saved session snapshots.

Settings are organized into **General**, **Model connections**, **System roles**, **Web search**, **Appearance**, and **Data and backups**. API access comes from your chosen provider; no model access is included with the plugin.

Local file, image and web-search tools share a concurrency setting across all sessions (default 3, range 1–10). Same-batch calls can execute in parallel; results return in the model’s original order. There is no per-question total-call limit. Image tool details show the complete Vault-relative image path.

## Ask about your notes

1. Open Quick Ask from its ribbon icon or the **Quick Ask: Open sidebar** command.
2. Select text in a Markdown editor and drag it into Quick Ask, or add a file using `[[` or file-explorer drag and drop. `【【` also opens the file picker when using full-width punctuation. Review or remove pending selections and references before sending.
3. Type your question and submit it. Added Markdown files become tracked context after the request is accepted. The model may use the read-only full-file tool for files already included in that conversation.
4. Return to a conversation to see its answers and submitted selections. Selection previews keep the original text; hovering shows the full quote. They do not open or navigate to the source file.

Newly sent text context includes source lines and selection word/character positions without modifying your notes. Editor offsets stay local. Retried questions use the current fixed instructions. The default role omits line-number details from answers unless you ask for them. PDF input is not supported. English and Simplified Chinese interfaces are available, with some remaining English text.

### Appearance and workspace

Adjust user/assistant bubble colors, text size and paragraph spacing in **Appearance**. Drag the top edge of the input to resize it. Quick Ask reserves bottom space when a status bar overlaps its pane, and does not add that space when the theme already leaves room.

### Formulas, diagrams and code

After an answer finishes, formulas and Mermaid code blocks use Obsidian's renderer. Formulas keep their text size; a thin local horizontal scrollbar overlays the formula bottom only when needed, without changing the formula height, and disappears when the pane is wide enough. Inline formulas have no toolbar. Hover or focus a display formula and use **View source** (`</>`) to select and copy its LaTeX; use the same button to restore that formula.

Mermaid diagrams have **Preview image**, **View source** and source-copy controls at the upper right. Preview uses the image viewer; Escape closes it. Source view changes only that diagram. Supported diagram syntax follows your Obsidian version; a diagram that cannot render shows its source and a local message. Code blocks (including text and unlabelled blocks), Mermaid diagrams and Markdown tables share upper-right copy buttons, visible on hover or keyboard focus. Successful copying shows a green check for one second. Tables copy their full original Markdown; code blocks copy their contents without fences. The controls stay visible while the content scrolls horizontally.

### Roles, reasoning and compaction

In **System roles**, choose, create, rename or edit a role profile. Literature Reading and Study Quiz are supplied initially with English prompt text; Study Quiz starts with three questions. Unedited legacy Study Quiz presets upgrade to English, while edited prompts and existing conversations keep their saved text. Custom prompts replace the built-in reading role while preserving fixed tool, read-only and math/diagram formatting rules. Click the role name beside the session selector to choose a saved role for the current conversation. Global edits never automatically refresh that snapshot. New conversations inherit the current role; models still use the global default.

Click the effort label to open two lists: same-protocol saved models and **Off / Low / High / XHigh / Max** effort. The label itself continues to show only effort. Duplicate model names include `connection name · model`. You can also use the reasoning-effort command. The default is **High**. This changes the next question; actual support depends on the provider. Readable reasoning is shown when the API returns it. New questions show thoughts and individual tool calls in an ordered process list. The list opens during generation while each thought and tool detail stays collapsed. Click a thought to read its Markdown or copy the complete source; tool details retain their recorded parameters, paths and result summaries. Long lists scroll internally, and successful completion folds the process while keeping the answer visible. Switching sessions or restarting resets historical disclosures. Older conversation records remain readable without migration.

Type `/` in the input for actions including `/compact` and `/web_search`. Automatic or manual compaction shortens the context sent to the model without deleting local conversation history. Tracked files remain available to the allowed full-file tool. Unsent search/effort choices stay in memory and do not survive a plugin restart.

### Withdraw and edit

Right-click the last user message and choose **Withdraw last turn and edit**.
The whole turn, including its answer, thoughts and tools, leaves active history;
the original question, selections and images return to the input for manual
resubmission. Failed/stopped turns are eligible. Clear that restored draft to
withdraw the preceding turn. Withdrawal is disabled while generating/compacting,
when a new draft or pending attachment exists, or when an older turn lacks the
original-draft metadata. Current role/model and billed token totals are retained.
Manual retries use the current role/model.

Switching models/providers may rebuild portable history and require compaction
on the next send. An incompatible history rejects the switch without changing
the selection. Older sessions remain readable; the first explicit role/model
switch or withdrawal upgrades that session’s format, which older plugin versions
cannot reopen. Export and preserved copies retain the edit history.

### Images

Add **PNG/JPEG/WebP** using `[[`, Vault/external drag and drop, or clipboard paste. You can send an image without question text. Limits are **20 MiB per image**, **20 images**, and **200 MiB combined per question**; original bytes are sent without resizing or compression.

Image bytes go only to the first model request of that question. Tool continuations, later questions and compaction do not resend them. Explicit retry rereads the image source. History and exports store paths, not image files; previews show the current source, with a placeholder when it is missing.

External and pasted images are copied into the plugin cache; original Vault images are not. **Keep cached images** defaults to on. Turning it off clears cached images on the next Obsidian reopen, not on plugin reload. Images are excluded from the local token estimate; provider-reported usage remains the billing authority.

### Web search

Search is **off by default**, and the default service is **DuckDuckGo**. Use the globe button or `/web_search` to enable it for a question. You can change the default behavior in **Web search** settings and select **Firecrawl**, **Exa**, **Parallel**, **Perplexity Search**, or **Model provider’s web search**. Independent API services require their own credentials.

Provider search supports the configured Responses/Chat Completions route where available, DeepSeek's independent Search API, native Gemini API-key search and supported relays such as CPA/Antigravity. Search is added alongside file and image tools; turning search off removes only search capability. File and image reads always check the current session’s authorization for the requested path. Search is selected manually; a failure does not silently switch services. See [provider search setup](native-search.md) for endpoint and credential details. Availability, streaming and structured source information depend on the selected service. Each connection offers **Mixed call** (default) or **Independent search**. Mixed call combines native search and read tools; independent search sends only the query in a separate provider request and returns its evidence to the main model, adding usage. Changes apply to the next question, including existing conversations on that connection. Compatibility errors suggest switching manually; there is no automatic probe or fallback.

## Accounts, costs and network use

Quick Ask is free and requires no Quick Ask account. Your AI/search provider may require an account, API key or paid credits. Its fees apply separately; an AI chat subscription does not necessarily include API access.

Submitting a question sends prompts, selected passages, referenced file content and effective conversation context to your configured service. Follow-up model/tool calls may send updated or complete contents of previously included files. Counting or compacting model context may also contact that service. When search is enabled, requests can also reach the selected search service. Model discovery sends an authenticated model-list request without note content. Recovery/deletion of older provider-stored responses may contact their configured endpoint.

Opening or enabling the sidebar alone does not submit note content. The plugin has no telemetry, analytics, ads or developer-operated backend, and does not install updates or executable dependencies at runtime. Provider retention and privacy policies apply to data you send.

## Local data and privacy

- Settings store **references to named secrets**, not API key values, in `data.json`. Key values come from Obsidian's secret storage.
- Conversations and included text context are readable, append-only JSONL files under the plugin directory's `quick-ask/` subdirectory. This plugin does not encrypt local history.
- **Data and backups** provides conversation export/import, data removal and optional plaintext preserved copies in a Vault folder you choose. Conversation exports exclude secret values and retain image paths rather than image bytes.
- The file picker enumerates Vault paths, excluding the configuration directory. This does not read or send every file's contents; file contents are read for explicitly added context and files already tracked by the conversation.
- Clipboard access is user-initiated: pasting images reads the paste event, importing reads clipboard text, and copy/export actions write the chosen output. The plugin does not poll or monitor the clipboard. Imported conversations are not submitted to a provider until you send a question.
- External image drops read only the files you explicitly provide and copy them into the plugin cache; they do not scan outside folders. Images are sent when you submit their question.
- Vault sync and backup tools may copy plugin data according to their own configuration.

## Development

This repository is the standalone distribution generated from Scholar Workbench. Feature and documentation changes are maintained in that upstream source project and synchronized here; see the [maintainer workflow](maintaining.md).

To build and check a local copy, use **Node.js 22.12+**:

```sh
npm ci
npm run build
npm test
npm run check
```

When switching from the bundled Scholar Workbench feature, export/import conversations, configure your model connection and secrets, and disable the built-in Quick Ask. The two plugins keep separate session stores.

## License

Copyright 2026 **FRANK-SMITH**. Quick Ask is licensed under [Apache License 2.0](../LICENSE); see [NOTICE](../NOTICE). Bundled dependencies retain their original MIT/BSD licenses, reproduced in `main.js` and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
