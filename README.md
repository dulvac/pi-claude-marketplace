# pi-claude-marketplace

Browse and install [Claude Code plugin marketplaces](https://docs.anthropic.com/en/docs/claude-code/plugins) from [pi](https://pi.dev).

Claude Code plugins are mostly bundles of **skills** (Agent Skills `SKILL.md` format) and **commands** (Markdown prompts). Pi understands both formats natively, so this extension just adds the marketplace UX on top:

- `/plugins` opens an interactive browser: pick a marketplace, see plugins with descriptions and versions, install or uninstall with one keystroke.
- Marketplace sources support git refs, so you can pin a branch, tag, or commit.
- Marketplaces already registered in Claude Code (`extraKnownMarketplaces` in `~/.claude/settings.json` and `.claude/settings.json`) show up with zero setup.
- Installed plugin skills load as pi skills, and plugin `commands/*.md` load as pi prompt templates.

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
- A plugin may ship a pi extension at `pi/index.ts` (or `pi/index.js`, `pi/index.mjs`) with a default export `(pi: ExtensionAPI) => void | Promise<void>`. Installed plugins' entries are imported and run at pi startup and on `/reload`, under this extension's runtime, so they can register commands, tools and event handlers like any other pi extension. A plugin whose entry fails to import or whose factory throws produces one warning at session start and never blocks the other plugins. Loading reads only what is already on disk, so a new plugin version reaches pi after `/plugins update`, which offers to reload.

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
| `pi/index.ts` (pi extension, this project's convention) | loaded as a pi extension (commands, tools, events) under this extension's runtime |
| `.lsp.json` (LSP servers) | skipped |
| `hooks/`, `agents/`, statusline scripts | skipped |

Install-time warnings tell you exactly what was skipped for a given plugin.

## License

MIT
