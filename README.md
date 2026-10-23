# pi-claude-marketplace

Browse and install [Claude Code plugin marketplaces](https://docs.anthropic.com/en/docs/claude-code/plugins) from [pi](https://pi.dev).

Claude Code plugins are mostly bundles of **skills** (Agent Skills `SKILL.md` format) and **commands** (Markdown prompts). Pi understands both formats natively, so this extension just adds the marketplace UX on top:

- `/plugins` opens an interactive browser: pick a marketplace, see plugins with descriptions and versions, install or uninstall with one keystroke.
- Marketplace sources support git refs, so you can pin a branch, tag, or commit.
- Marketplaces already registered in Claude Code (`extraKnownMarketplaces` in `~/.claude/settings.json` and `.claude/settings.json`) show up with zero setup.
- Installed plugin skills load as pi skills, and plugin `commands/*.md` load as pi prompt templates.
- A plugin can also ship a pi extension at `pi/index.ts`, which runs under this extension at startup. That is how a plugin gets a native `/command` in pi. See [Plugin-shipped pi extensions](#plugin-shipped-pi-extensions).

## Install

```bash
pi install git:github.com/dulvac/pi-claude-marketplace
```

## Usage

```
/plugins                                  # browse & install/uninstall interactively
/plugins add owner/marketplace@dev        # add a marketplace pinned to the dev branch
/plugins add owner/repo@v1.2 my-name      # optional explicit marketplace name
/plugins install my-plugin my-marketplace # install a plugin non-interactively
/plugins uninstall my-plugin
/plugins update                           # git-update all marketplaces (re-pins refs)
/plugins update my-marketplace
/plugins remove my-marketplace            # remove marketplace + its installed plugins
/plugins list
```

Marketplace specs accept GitHub shorthand (`owner/repo`), full HTTPS/SSH git URLs, and an optional `@ref` suffix (branch, tag, or commit SHA). Private repos work through your regular git credentials.

## How it works

- Marketplaces are shallow-cloned to `~/.pi/agent/claude-marketplaces/<name>` and pinned to their configured ref.
- State lives in `~/.pi/agent/claude-marketplace.json`:

  ```json
  {
    "marketplaces": {
      "my-marketplace": { "repo": "owner/marketplace", "ref": "dev" }
    },
    "installed": {
      "my-marketplace": ["my-plugin", "other-plugin"]
    }
  }
  ```

- On every session start (and `/reload`), the extension materializes namespaced copies of the installed plugins' skills and commands and contributes them via pi's `resources_discover` hook. No pi settings mutation.
- Plugins whose manifest `source` points at an external GitHub repo are cloned under `~/.pi/agent/claude-marketplaces/_external/`.
- If an installed plugin ships `pi/index.ts`, it is imported and run as a pi extension at startup and on `/reload`. See [Plugin-shipped pi extensions](#plugin-shipped-pi-extensions).

## Plugin-shipped pi extensions

Claude Code has no notion of a pi extension, so a plugin that wants a native pi command (one that runs code, not a prompt template) ships one itself. Put a file at `pi/index.ts` (preferred, see reload notes below), `pi/index.js`, or `pi/index.mjs` in the plugin root (first match in that order wins) with a default export that takes pi's `ExtensionAPI`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (_args, ctx) => ctx.ui.notify("hello", "info"),
  });
}
```

The factory may be sync or async (`(pi) => void | Promise<void>`). It receives the same `ExtensionAPI` this extension got, so it can register commands, tools, and event handlers like any pi extension.

How loading works:

- Entries are loaded at pi startup and on `/reload`, before `/plugins` itself is registered. Only plugins already cloned on disk are considered; nothing touches git or the network at that point.
- Each plugin is isolated. If its entry fails to import, has no callable default export, throws from the factory, or does not finish within 15 seconds, you get one warning at session start naming the plugin, and every other plugin still loads. A broken plugin extension never prevents pi from starting.
- `/reload` re-runs `.ts` and plain `.js` entries from the file on disk, because pi creates a fresh module loader per load. `.mjs` entries (and `.js` entries under a package with `"type": "module"`) are imported natively and cached by Node for the life of the process, so edits to those need a pi restart. Prefer `.ts`. The file comes from the marketplace clone, so a new plugin version only reaches pi after `/plugins update` (or `/plugins update <marketplace>`) pulls it; the update offers to reload, which is enough for `.ts` and plain `.js`; for `.mjs`, restart pi.
- The entry is imported through the same jiti runtime pi loads extensions with, so with current pi `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox` resolve to pi's own copies. Other bare imports have nowhere to resolve from, since a marketplace clone normally has no `node_modules`; stick to Node built-ins and those packages.

Installing a plugin that ships `pi/` means running its code. The entry runs with your user's privileges every time pi starts, whether interactive, `pi -p`, or RPC, in every project, with no sandbox. A plugin that adds `pi/` in a later version starts executing after `/plugins update` with no new prompt. Only install plugins from marketplaces you trust, and read the entry before installing if you are unsure.

## Namespacing

Claude Code scopes plugin commands as `/plugin:command` (for example `/tools:setup`). Pi skill names can't contain `:`, so this extension prefixes each skill and command with the plugin's name from `plugin.json`, joined with a hyphen: a `setup` skill from the `tools` plugin becomes `tools-setup`, invoked as `/skill:tools-setup`. Skills that already start with the plugin name keep it once (a `humanize` skill in a `humanize` plugin stays `humanize`, not `humanize-humanize`).

This means two installed plugins can both ship a `setup` skill without one shadowing the other.

Under the hood, the extension builds a shadow tree at `~/.pi/agent/claude-marketplaces/_resources/`: each `SKILL.md` gets copied with a rewritten `name:` frontmatter, and every other skill asset is symlinked back to the original clone. The tree is rebuilt from scratch on every discovery pass, so uninstalled plugins leave nothing behind.

## MCP servers

Pi has no built-in MCP support, but if you have the [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) extension installed, this extension registers plugin-shipped MCP servers (`.mcp.json` at the plugin root) in the adapter's pi-global config at `~/.pi/agent/mcp.json`. Server names get the same plugin-name prefix as skills, and `${CLAUDE_PLUGIN_ROOT}` in commands, args, or URLs is replaced with the plugin's install path.

The extension tracks which entries it added, so uninstalling a plugin removes exactly those servers and nothing else. Servers you configured yourself are never overwritten, even on name collision. Without pi-mcp-adapter, `.mcp.json` is skipped with a warning, same as before.

## What is (not) supported

| Claude Code plugin feature | pi |
|---|---|
| `skills/` (Agent Skills) | loaded as pi skills, namespaced |
| `commands/` (slash commands) | loaded as pi prompt templates, namespaced |
| `.mcp.json` (MCP servers) | registered via pi-mcp-adapter when installed, otherwise skipped with a warning |
| `pi/index.ts` (pi only, this project's convention) | loaded as a pi extension (commands, tools, events) under this extension's runtime; runs the plugin's code at every pi startup |
| `.lsp.json` (LSP servers) | skipped |
| `hooks/`, `agents/`, statusline scripts | skipped |

Install-time warnings tell you exactly what was skipped for a given plugin.

## License

MIT
