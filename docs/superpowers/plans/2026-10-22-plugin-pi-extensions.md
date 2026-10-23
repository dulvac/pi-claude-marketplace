# pi-claude-marketplace: Load Plugin-Shipped pi Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an installed Claude Code plugin ship a pi extension at `pi/index.ts` that pi-claude-marketplace loads at startup, so the plugin can register native `/` commands in pi.

**Architecture:** A new `src/extensions.ts` enumerates installed plugins from the existing config and clones (no git at factory time), finds `pi/index.{ts,js,mjs}`, dynamically imports it with a cache-busting query, and calls its default export with the shared `ExtensionAPI`. Failures are collected per plugin and surfaced once at `session_start` as warnings. The factory in `src/index.ts` becomes async and calls it before registering `/plugins`.

**Tech Stack:** TypeScript (NodeNext, strict), Node 26 `node --test` with native type stripping, pi `ExtensionAPI` 1.2.x.

**Spec:** `/Users/adulvac/work/code-halle/.claude/worktrees/handover/docs/superpowers/specs/2026-10-22-handover-plugin-design.md`, section "pi-claude-marketplace change". The consumer is the handover plugin (same spec).

**Worktree:** `/Users/adulvac/work/pi-claude-marketplace/.worktrees/plugin-pi-extensions`, branch `feat/plugin-pi-extensions` off `origin/main`. The main checkout holds unrelated uncommitted work; do not touch it.

## Global Constraints

- Convention: a plugin may ship `pi/index.ts`, `pi/index.js` or `pi/index.mjs` at its root; first match in that order is the entry.
- Load at factory time only. No git, no network, no process spawning in the factory. Plugins whose clone directory is missing are skipped silently.
- `import(url)` uses `pathToFileURL(entry).href + "?v=" + Date.now()` so `/reload` picks up edits.
- A failing plugin extension never throws out of the factory; it produces one warning string, reported at `session_start` via `ctx.ui.notify(msg, "warning")`.
- Existing behaviour (skills, prompts, MCP sync, `/plugins` command) unchanged.
- Package version: `0.1.0` -> `0.2.0`.
- Validated approach: a host extension doing `await import(pathToFileURL(child.ts).href)` then `mod.default(pi)` worked under pi 1.2.0 (`registerCommand` from the child took effect).

## Review Focus

- A plugin's `pi/index.ts` that throws synchronously inside its factory: other plugins still load, one warning. (Task 2 test `loadPluginExtensions reports a throwing factory and continues`.)
- A plugin's `pi/index.ts` whose default export is not a function (e.g. empty module): warning, not a crash. (Task 2 test `loadPluginExtensions warns when the entry has no callable default export`.)
- Marketplace clone present but `.claude-plugin/marketplace.json` missing or unparsable: skipped, no warning spam. (Task 1 test `installedPluginDirs skips marketplaces without a readable manifest`.)
- Plugin installed in this session, then `/reload`: extension loads on the reload without restart. (Task 3 manual check.)
- An external-source plugin (object `source`) whose `_external` clone exists: entry found; when the clone is absent: skipped, no git. (Task 1 test `installedPluginDirs resolves external plugins only when already cloned`.)

---

### Task 1: Offline plugin enumeration and entry discovery

**Files:**
- Create: `src/extensions.ts`
- Modify: `src/marketplace.ts` (export `externalPluginCloneDir`; add `resolvePluginDirOffline`)
- Modify: `package.json` (add `"test": "node --test test/*.test.ts"`)
- Modify: `.gitignore` (add `.worktrees/`)
- Test: `test/extensions.test.ts`

**Interfaces:**
- Consumes: `readManifest(dir)`, `MarketplacePluginEntry`, `PluginsConfig`, `MarketplaceSource` from existing modules.
- Produces:
  - `resolvePluginDirOffline(marketplaceDir: string, plugin: MarketplacePluginEntry): string | undefined` in `src/marketplace.ts`. Same resolution as `resolvePluginDir` but never clones; returns the path only if it exists.
  - `findPluginExtensionEntry(pluginDir: string): string | undefined` in `src/extensions.ts`.
  - `installedPluginDirs(config: PluginsConfig, marketplaces: Record<string, MarketplaceSource>, clonesDir: string): Array<{ marketplace: string; plugin: string; dir: string }>` in `src/extensions.ts`. `clonesDir` is the parent of per-marketplace clones (production passes `CLONES_DIR`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/extensions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findPluginExtensionEntry, installedPluginDirs } from "../src/extensions.ts";

function tmp() { return mkdtempSync(join(tmpdir(), "pcm-")); }
function plugin(dir: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
}

test("findPluginExtensionEntry prefers index.ts, then index.js, then index.mjs", () => {
  const d = tmp();
  assert.equal(findPluginExtensionEntry(d), undefined);
  plugin(d, { "pi/index.mjs": "" });
  assert.equal(findPluginExtensionEntry(d), join(d, "pi", "index.mjs"));
  plugin(d, { "pi/index.js": "" });
  assert.equal(findPluginExtensionEntry(d), join(d, "pi", "index.js"));
  plugin(d, { "pi/index.ts": "" });
  assert.equal(findPluginExtensionEntry(d), join(d, "pi", "index.ts"));
});

test("installedPluginDirs resolves relative-source plugins from existing clones", () => {
  const clones = tmp();
  const mp = join(clones, "code-halle");
  plugin(mp, {
    ".claude-plugin/marketplace.json": JSON.stringify({ plugins: [
      { name: "handover", source: "./plugins/handover" },
      { name: "missing", source: "./plugins/missing" },
    ] }),
    "plugins/handover/.claude-plugin/plugin.json": JSON.stringify({ name: "handover" }),
  });
  const out = installedPluginDirs(
    { marketplaces: {}, installed: { "code-halle": ["handover", "missing", "not-in-manifest"] } },
    { "code-halle": { repo: "x/y" } },
    clones,
  );
  assert.deepEqual(out, [{ marketplace: "code-halle", plugin: "handover", dir: join(mp, "plugins", "handover") }]);
});

test("installedPluginDirs skips marketplaces without a readable manifest", () => {
  const clones = tmp();
  mkdirSync(join(clones, "broken"), { recursive: true });
  writeFileSync(join(clones, "broken", ".claude-plugin"), "not a dir");
  const out = installedPluginDirs(
    { marketplaces: {}, installed: { broken: ["p"], absent: ["q"] } },
    { broken: { repo: "a/b" }, absent: { repo: "c/d" } },
    clones,
  );
  assert.deepEqual(out, []);
});

test("installedPluginDirs resolves external plugins only when already cloned", () => {
  const clones = tmp();
  const mp = join(clones, "mp");
  plugin(mp, { ".claude-plugin/marketplace.json": JSON.stringify({ plugins: [
    { name: "ext", source: { source: "github", repo: "owner/ext-plugin" } },
  ] }) });
  const cfg = { marketplaces: {}, installed: { mp: ["ext"] } };
  const mps = { mp: { repo: "x/y" } };
  assert.deepEqual(installedPluginDirs(cfg, mps, clones), []);
  const extDir = join(clones, "_external", "owner__ext-plugin");
  mkdirSync(extDir, { recursive: true });
  assert.deepEqual(installedPluginDirs(cfg, mps, clones), [{ marketplace: "mp", plugin: "ext", dir: extDir }]);
});
```

Check the exact `_external` directory name against `sanitize()` in `src/marketplace.ts` (`owner/ext-plugin` -> `owner__ext-plugin`) and adjust the test constant if the sanitizer differs.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/adulvac/work/pi-claude-marketplace/.worktrees/plugin-pi-extensions && npm install && node --test test/extensions.test.ts`
Expected: FAIL, cannot find module `../src/extensions.ts`.

- [ ] **Step 3: Implement**

In `src/marketplace.ts`: export `externalPluginCloneDir`; add `resolvePluginDirOffline` mirroring `resolvePluginDir` minus `ensureClone` (return the external dir only if `existsSync`). Both `marketplaceCloneDir` and `externalPluginCloneDir` are bound to `CLONES_DIR`; add an optional trailing `clonesDir = CLONES_DIR` parameter to each so tests can redirect them.

In `src/extensions.ts`: `findPluginExtensionEntry` checks the three candidates in order. `installedPluginDirs` iterates `config.installed`, skips marketplaces not in `marketplaces` or without a clone dir or manifest, finds each plugin entry by name, and calls `resolvePluginDirOffline`.

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test test/extensions.test.ts && npm run typecheck`
Expected: 4 passing, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/extensions.ts src/marketplace.ts test/extensions.test.ts package.json .gitignore
git commit -m "feat: enumerate installed plugins offline and find pi extension entries"
```

---

### Task 2: Load plugin extensions with per-plugin error isolation

**Files:**
- Modify: `src/extensions.ts`
- Test: `test/extensions.test.ts`

**Interfaces:**
- Consumes: `installedPluginDirs`, `findPluginExtensionEntry` (Task 1).
- Produces: `loadPluginExtensions(pi: ExtensionAPI, plugins: Array<{ marketplace: string; plugin: string; dir: string }>, importModule: (url: string) => Promise<unknown> = (u) => import(u)): Promise<{ loaded: string[]; warnings: string[] }>`. `loaded` holds `"<marketplace>/<plugin>"` for each successful factory call. Each warning reads `plugins: <marketplace>/<plugin> pi extension failed: <message>`.

- [ ] **Step 1: Write the failing tests**

```ts
test("loadPluginExtensions imports each entry with a cache-busting query and calls default(pi)", async () => {
  const d = tmp(); plugin(d, { "pi/index.ts": "" });
  const calls: unknown[] = []; const urls: string[] = [];
  const fakePi = { tag: "pi" };
  const res = await loadPluginExtensions(fakePi as any,
    [{ marketplace: "mp", plugin: "a", dir: d }],
    async (url) => { urls.push(url); return { default: (api: unknown) => { calls.push(api); } }; });
  assert.deepEqual(res, { loaded: ["mp/a"], warnings: [] });
  assert.deepEqual(calls, [fakePi]);
  assert.match(urls[0]!, /^file:\/\/.*\/pi\/index\.ts\?v=\d+$/);
});

test("loadPluginExtensions skips plugins without a pi entry", async () => {
  const d = tmp();
  const res = await loadPluginExtensions({} as any, [{ marketplace: "mp", plugin: "a", dir: d }],
    async () => { throw new Error("must not import"); });
  assert.deepEqual(res, { loaded: [], warnings: [] });
});

test("loadPluginExtensions reports a throwing factory and continues", async () => {
  const a = tmp(); plugin(a, { "pi/index.ts": "" });
  const b = tmp(); plugin(b, { "pi/index.ts": "" });
  const res = await loadPluginExtensions({} as any,
    [{ marketplace: "mp", plugin: "a", dir: a }, { marketplace: "mp", plugin: "b", dir: b }],
    async (url) => url.includes(a)
      ? { default: () => { throw new Error("boom"); } }
      : { default: () => {} });
  assert.deepEqual(res.loaded, ["mp/b"]);
  assert.deepEqual(res.warnings, ["plugins: mp/a pi extension failed: boom"]);
});

test("loadPluginExtensions warns when the entry has no callable default export", async () => {
  const d = tmp(); plugin(d, { "pi/index.ts": "" });
  const res = await loadPluginExtensions({} as any, [{ marketplace: "mp", plugin: "a", dir: d }],
    async () => ({}));
  assert.deepEqual(res.loaded, []);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0]!, /no default export function/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/extensions.test.ts`
Expected: FAIL, `loadPluginExtensions` is not exported.

- [ ] **Step 3: Implement `loadPluginExtensions`**

Accept a module whose `default` is a function, or a module that is itself a function (CommonJS interop). Await the factory (it may be async). Wrap import and call per plugin in one try/catch.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: 8 passing, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/extensions.ts test/extensions.test.ts
git commit -m "feat: load plugin-shipped pi extensions with per-plugin error isolation"
```

---

### Task 3: Wire into the factory, document, bump version

**Files:**
- Modify: `src/index.ts:41-45` (factory signature and body start)
- Modify: `README.md` ("How it works", "What is (not) supported" table)
- Modify: `package.json` (`version`)

**Interfaces:**
- Consumes: `installedPluginDirs`, `loadPluginExtensions` (Tasks 1-2); `loadConfig`, `withClaudeSettingsMarketplaces`, `CLONES_DIR` (existing).

- [ ] **Step 1: Make the factory async and load plugin extensions first**

In `src/index.ts`, `export default async function (pi: ExtensionAPI)`. Before `pi.on("resources_discover", ...)`:

```ts
const config = loadConfig();
const marketplaces = withClaudeSettingsMarketplaces(config, process.cwd());
const { warnings } = await loadPluginExtensions(pi, installedPluginDirs(config, marketplaces, CLONES_DIR));
if (warnings.length > 0) {
  pi.on("session_start", async (_event, ctx) => {
    for (const w of warnings) ctx.ui.notify(w, "warning");
  });
}
```

Check `withClaudeSettingsMarketplaces`'s signature in `src/config.ts:76` and pass what it expects.

- [ ] **Step 2: Typecheck and run tests**

Run: `npm run typecheck && npm test`
Expected: clean, 8 passing.

- [ ] **Step 3: Smoke test under pi with a throwaway plugin**

Create a temp marketplace clone shape under a scratch `HOME` is heavy; instead point pi at the worktree directly while the published package is disabled:

```bash
cd /tmp && HOME_BAK=$HOME
pi --no-session -p -e /Users/adulvac/work/pi-claude-marketplace/.worktrees/plugin-pi-extensions/src/index.ts "reply ok" 2>&1 | tail -5
```

Expected: pi starts, answers, no stack trace. (The published package also loads and registers `/plugins` first; a duplicate-command warning is acceptable for this smoke test and is not part of the deliverable.)

- [ ] **Step 4: README**

Add to "How it works": a plugin may ship `pi/index.ts` (or `.js`/`.mjs`) exporting a default `(pi: ExtensionAPI) => void | Promise<void>`; it is loaded at pi startup and on `/reload`; a failure shows one warning at session start and never blocks other plugins; a new plugin version reaches pi only after `/plugins update`. Add table row: `pi/index.ts` | loaded as a pi extension (commands, tools, events) under this extension's runtime.

- [ ] **Step 5: Bump version and commit**

`package.json` version `0.2.0`.

```bash
git add src/index.ts README.md package.json
git commit -m "feat: load pi extensions shipped by installed plugins"
```

- [ ] **Step 6: Push and open PR**

```bash
git push -u origin feat/plugin-pi-extensions
gh pr create --base main --title "feat: load pi extensions shipped by installed plugins" --body-file -
```

PR body: what the convention is, why (handover plugin needs `/handover` as a native pi command), the error-isolation rule, and the `/plugins update` note. Run the humanize check on the body before posting (`python3 /Users/adulvac/.pi/agent/claude-marketplaces/_resources/code-halle/humanize/skills/humanize/scripts/check_symbols.py <file>`).

Do not merge yet. The handover plugin's end-to-end task points pi at this worktree first; merge after that passes.
