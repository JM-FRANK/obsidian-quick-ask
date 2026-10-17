# Quick Ask

**English** · [简体中文](README_zh.md)

### Ask about the passage, right where you read it.

A focused AI sidebar for your Obsidian notes, papers and images. Explain a term, compare notes, or turn a section into review questions — drag in your material and ask.

[Get started](#get-started) · [User guide](docs/user-guide.md) · [Releases](https://github.com/JM-FRANK/obsidian-quick-ask/releases) · [Help & feedback](https://github.com/JM-FRANK/obsidian-quick-ask/issues)

<p align="center">
  <a href="ui-showcase.png"><img src="ui-showcase.png" width="560" alt="Quick Ask explains a selected term in context, with the original quote above the question." /></a>
</p>

## Why Quick Ask?

- **Less copying, more reading.** Drag a passage or file into the sidebar, or type `[[` to choose a file. Decide exactly which notes the conversation can access.
- **Pick up where you left off.** Conversations stay local. Original selections remain above their questions, with the full quote available on hover.
- **Your models, your way of asking.** Save multiple connections, use Responses or Chat Completions, and switch between Literature Reading, Study Quiz and your own roles for new conversations.
- **Bring more than text.** Drop in an image or paste a screenshot. Enable web search when you need online information.
- **Keep the conversation going.** Added files are tracked for changes; long conversations can compact model context while keeping the full local history.
- **At home in Obsidian.** Theme-aware bubbles, readable reasoning, adjustable text and a resizable input area.

**Lightweight:** about 1.3 MiB installed (≈306 KiB gzipped). No telemetry or developer-operated backend.

## Get started

Requires **Obsidian 1.13.7+ on desktop**.

1. In **Settings → Community plugins → Browse**, search for **Quick Ask**, install and enable it.
2. Open **Quick Ask → Model connections**. Add your Base URL and named API secret, then choose a model and its protocol.
3. Open the sidebar, drag in a passage or add a file with `[[`, and send your question.

Connection/model and role changes apply to **new conversations**. Use your own provider API access; model/search fees are separate from the free plugin. Mobile and PDF input are not supported.

[Manual installation and full setup →](docs/user-guide.md#installation)

## Explore

- [User guide](docs/user-guide.md) — model connections, roles, reasoning, images, search, compaction and backups.
- [Provider search setup](docs/native-search.md) — supported endpoints and credentials.
- [Changelog](CHANGELOG.md) — changes included in each version.

## Your data

History is stored locally. Submitting a question sends its selected context to your configured provider; model discovery and enabled search also make network requests. There is no background polling, and the plugin cannot edit notes or search arbitrary Vault files.

Read the [network, costs and privacy details](docs/user-guide.md#accounts-costs-and-network-use), including what image exports contain and how cached files are retained.

## Help & contribute

Questions, bugs or ideas? [Open an issue](https://github.com/JM-FRANK/obsidian-quick-ask/issues). Include versions and reproduction steps; for layout issues, add your theme and a screenshot. Keep API keys and private notes out of reports.

For local builds and contributions, see the [development guide](docs/user-guide.md#development) and [maintainer workflow](docs/maintaining.md).

## License

Copyright 2026 **FRANK-SMITH** · [Apache License 2.0](LICENSE) · [NOTICE](NOTICE). Dependency licenses are included in `main.js` and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
