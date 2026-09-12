# Compatibility and validation

## Supported runtime

Quick Ask declares **Obsidian 1.13.7+ on desktop**, with no older-client fallback and no mobile support. It uses public Plugin lifecycle/registration methods, declarative `PluginSettingTab` definitions, `SecretComponent`/secret storage, Vault access and Markdown rendering APIs. Host editor extensions use Obsidian's CodeMirror; the owned composer has its own bundled CodeMirror graph.

The standalone command ID is `open` (qualified by Obsidian as `quick-ask:open`), with the displayed command name **Quick Ask: Open sidebar**. The Scholar host retains its original `open-quick-ask` ID for existing hotkeys. No default hotkey is assigned.

Settings use `Plugin.loadData()`/`saveData()`. Per-session append-only logs use the Adapter API within the owning plugin directory; they are not collapsed into one potentially large settings file. The actual configuration directory comes from `Vault.configDir`. Existing note contents are read through the Vault API.

Network access is limited to the configured API endpoint and enabled feature. Streaming uses the owning window's fetch/AbortController so streamed chunks and cancellation remain available; non-streaming fallback uses Obsidian's requestUrl. That API does not expose transport cancellation, so aborting stops awaiting its result. This is an intentional streaming-specific choice, not a claim that every endpoint or proxy supports streaming/CORS. Only Responses-compatible providers are supported.

## Automated evidence

The framework baseline passed 192 upstream pure tests and 191 exported pure tests, plus distribution tests for module isolation, settings persistence, identities and source export. Release preparation adds version/manifest/lock/provenance and packaging checks. Builds use pinned dependencies and committed lockfiles. CI runs on Ubuntu with Node.js 22.

These checks do not open Obsidian, simulate DOM/editor interactions, or send a request to an actual AI provider. They do not establish a Windows/macOS/Linux UI acceptance matrix. The earlier user-reported Windows success concerned the Scholar Citation toggle fix, not this independent Quick Ask package.

## Maintainer-owned manual acceptance

Before public release, check in the dedicated test Vault:

- Install only Quick Ask; confirm it enables, opens from ribbon/command, and does not require Scholar Workbench or ZotLit.
- Configure named secret, endpoint and model; reopen settings and reload the plugin to confirm persistence.
- Select Markdown text, add a file using `[[`/`【【`, submit a real question, stop a stream and send a follow-up.
- Confirm local history survives reload, and export/import from Scholar retains the original sessions.
- Disable the built-in feature while switching; confirm independent sessions and separate view identities.
- Disable/re-enable/unload Quick Ask and confirm no duplicate view, ribbon or command registration remains.

Status: **Not yet recorded for the standalone release.** No automated test result is a substitute for this acceptance.

API reference: [Official Obsidian declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts).
