import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findPluginExtensionEntry, installedPluginDirs } from "../src/extensions.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "pcm-"));
}

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
    ".claude-plugin/marketplace.json": JSON.stringify({
      plugins: [
        { name: "handover", source: "./plugins/handover" },
        { name: "missing", source: "./plugins/missing" },
      ],
    }),
    "plugins/handover/.claude-plugin/plugin.json": JSON.stringify({ name: "handover" }),
  });
  const out = installedPluginDirs(
    { marketplaces: {}, installed: { "code-halle": ["handover", "missing", "not-in-manifest"] } },
    { "code-halle": { repo: "x/y" } },
    clones,
  );
  assert.deepEqual(out, [
    { marketplace: "code-halle", plugin: "handover", dir: join(mp, "plugins", "handover") },
  ]);
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
  plugin(mp, {
    ".claude-plugin/marketplace.json": JSON.stringify({
      plugins: [{ name: "ext", source: { source: "github", repo: "owner/ext-plugin" } }],
    }),
  });
  const cfg = { marketplaces: {}, installed: { mp: ["ext"] } };
  const mps = { mp: { repo: "x/y" } };
  assert.deepEqual(installedPluginDirs(cfg, mps, clones), []);
  const extDir = join(clones, "_external", "owner__ext-plugin");
  mkdirSync(extDir, { recursive: true });
  assert.deepEqual(installedPluginDirs(cfg, mps, clones), [
    { marketplace: "mp", plugin: "ext", dir: extDir },
  ]);
});
