# Quick Ask

[Repository](https://github.com/JM-FRANK/obsidian-quick-ask) · [Releases](https://github.com/JM-FRANK/obsidian-quick-ask/releases) · [Changelog](CHANGELOG.md)

Ask AI about Markdown text and files you explicitly choose, directly in an Obsidian sidebar. Keep conversation history locally and control what becomes context for each conversation.

## Features

- Add selected Markdown text or reference Markdown files with `[[` (also `【【` with a Chinese IME).
- Stream answers, show reasoning summaries when supplied by the provider, and manage multiple conversations.
- Track changes to files already added to a conversation and compact long conversation context.
- Customize display preferences and export/import local sessions.
- Open the sidebar from the ribbon or the **Quick Ask: Open sidebar** command; assign a hotkey in Obsidian if desired.

## Installation

Quick Ask is being prepared for community-directory submission; it is not yet listed. When a public release is available:

1. Download `main.js`, `manifest.json` and `styles.css` from [Releases](https://github.com/JM-FRANK/obsidian-quick-ask/releases).
2. Create `.obsidian/plugins/quick-ask/` inside your Vault (use your Vault's actual configuration directory if customized).
3. Copy the three files into that directory and enable **Quick Ask** in **Settings → Community plugins**.
4. Open Quick Ask settings and configure your provider before submitting a question.

## Configuration and use

Requires **Obsidian 1.13.7+ on desktop**. Mobile is not supported. Settings use Obsidian's 1.13 declarative settings and named secret storage.

Configure a **Base URL**, **model**, and **named API secret**. For OpenAI, an example Base URL is `https://api.openai.com/v1`; do not append `/responses`. Other endpoints must support the Responses API used by this plugin. A Chat Completions-only endpoint is not sufficient. No model or API access is included with the plugin.

Select Markdown text or add a Markdown file as context, type a question and submit it. The model may request the complete contents of files already included in that conversation. It cannot search arbitrary files or edit your notes. PDF/image input is not supported in this release. Interface language supports English and Simplified Chinese, with some remaining English interface text.

## Accounts, costs and network use

The plugin itself is free and requires no Quick Ask account. Your selected AI provider may require an account, API key or paid credits; its API usage and pricing apply separately. An AI chat subscription does not necessarily include API access.

Quick Ask connects to the **Base URL you configure**, such as OpenAI or another Responses-compatible service. It sends prompts, selected text, referenced file content and conversation context to generate answers and support token counting/compaction. During an active request, follow-up model/tool calls may send updated or complete contents of previously added files. Recovery or deletion of older provider-stored responses can also contact that configured service. Merely opening/enabling the sidebar does not submit note content.

No plugin telemetry, analytics, ads or separate developer-operated backend is included. The provider's own retention and privacy policies apply to data sent to it. Review your chosen provider's policies before using sensitive notes. The plugin does not install/update itself or download executable dependencies at runtime.

## Local data and privacy

- Preferences and a **secret reference**, not the API key value, are saved in the plugin's `data.json`. Key values are resolved from Obsidian's secret storage.
- Conversations and included context are stored as readable files under the plugin directory's `quick-ask/` subdirectory. Local history is not encrypted by this plugin.
- Optional preserved copies write plaintext backups to a Vault folder you choose. Clipboard export/import contains conversation content; secret values are excluded.
- The plugin accesses files in the current Vault and its own plugin-data directory; it does not read files outside the Vault. Vault sync/backup tools may copy these files according to their own configuration.

## Switching from Scholar Workbench

Quick Ask is generated from the same upstream feature implementation maintained in Scholar Workbench. It works independently; Scholar Workbench and ZotLit are not prerequisites.

Disable Scholar Workbench's built-in Quick Ask when switching. Export sessions from its Quick Ask settings and import them into this plugin. Select the named API secret and configure the new plugin's endpoint/model again. Source sessions remain intact. Both installations have separate view identities and plugin directories; there is no automatic shared-history synchronization. Use separate plaintext backup directories if both remain enabled.

## Development and releases

Use Node.js 22:

```sh
npm ci
npm run build
npm test
npm run check
```

Make all feature and release-material changes in **Scholar Workbench** and synchronize a fixed commit. `upstream.json` records the source commit and file hashes; direct downstream source edits are rejected by the next sync. See [Maintainer workflow](docs/maintaining.md).

For release preparation and the submission form, see [Community submission](docs/community-submission.md) and [Compatibility and validation](docs/compatibility.md). A draft release or passing tests does not imply community approval or complete manual platform validation.

## License

Copyright 2026 **FRANK-SMITH**. Quick Ask is licensed under [Apache License 2.0](LICENSE); see [NOTICE](NOTICE). Bundled dependencies retain their original MIT/BSD licenses, reproduced in `main.js` and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
