import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findPluginExtensionEntry,
  installedPluginDirs,
  loadPluginExtensions,
} from "../src/extensions.ts";

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

test("findPluginExtensionEntry only accepts regular files", () => {
  const d = tmp();
  mkdirSync(join(d, "pi", "index.ts"), { recursive: true });
  assert.equal(findPluginExtensionEntry(d), undefined);
});

test(
  "findPluginExtensionEntry treats an unreadable pi/ dir as no entry instead of throwing",
  { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false },
  async () => {
    const d = tmp();
    plugin(d, { "pi/index.ts": "" });
    chmodSync(join(d, "pi"), 0o000);
    try {
      assert.equal(findPluginExtensionEntry(d), undefined);
      const res = await loadPluginExtensions(
        {} as any,
        [{ marketplace: "mp", plugin: "a", dir: d }],
        async () => {
          throw new Error("must not import");
        },
      );
      assert.deepEqual(res, { loaded: [], warnings: [] });
    } finally {
      chmodSync(join(d, "pi"), 0o755);
    }
  },
);

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

test("loadPluginExtensions imports each entry with a cache-busting query and calls default(pi)", async () => {
  const d = tmp();
  plugin(d, { "pi/index.ts": "" });
  const calls: unknown[] = [];
  const urls: string[] = [];
  const fakePi = { tag: "pi" };
  const res = await loadPluginExtensions(
    fakePi as any,
    [{ marketplace: "mp", plugin: "a", dir: d }],
    async (url) => {
      urls.push(url);
      return {
        default: (api: unknown) => {
          calls.push(api);
        },
      };
    },
  );
  assert.deepEqual(res, { loaded: ["mp/a"], warnings: [] });
  assert.deepEqual(calls, [fakePi]);
  assert.match(urls[0]!, /^file:\/\/.*\/pi\/index\.ts\?v=\d+$/);
});

test("loadPluginExtensions skips plugins without a pi entry", async () => {
  const d = tmp();
  const res = await loadPluginExtensions(
    {} as any,
    [{ marketplace: "mp", plugin: "a", dir: d }],
    async () => {
      throw new Error("must not import");
    },
  );
  assert.deepEqual(res, { loaded: [], warnings: [] });
});

test("loadPluginExtensions reports a throwing factory and continues", async () => {
  const a = tmp();
  plugin(a, { "pi/index.ts": "" });
  const b = tmp();
  plugin(b, { "pi/index.ts": "" });
  const res = await loadPluginExtensions(
    {} as any,
    [
      { marketplace: "mp", plugin: "a", dir: a },
      { marketplace: "mp", plugin: "b", dir: b },
    ],
    async (url) =>
      url.includes(a)
        ? {
            default: () => {
              throw new Error("boom");
            },
          }
        : { default: () => {} },
  );
  assert.deepEqual(res.loaded, ["mp/b"]);
  assert.deepEqual(res.warnings, ["plugins: mp/a pi extension failed: boom"]);
});

test("loadPluginExtensions warns when the entry has no callable default export", async () => {
  const d = tmp();
  plugin(d, { "pi/index.ts": "" });
  const res = await loadPluginExtensions(
    {} as any,
    [{ marketplace: "mp", plugin: "a", dir: d }],
    async () => ({}),
  );
  assert.deepEqual(res.loaded, []);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0]!, /no default export function/);
});

test("loadPluginExtensions accepts a module that is itself the factory (CJS interop)", async () => {
  const d = tmp();
  plugin(d, { "pi/index.js": "" });
  const calls: unknown[] = [];
  const fakePi = { tag: "pi" };
  const res = await loadPluginExtensions(
    fakePi as any,
    [{ marketplace: "mp", plugin: "a", dir: d }],
    async () => (api: unknown) => {
      calls.push(api);
    },
  );
  assert.deepEqual(res, { loaded: ["mp/a"], warnings: [] });
  assert.deepEqual(calls, [fakePi]);
});

test("loadPluginExtensions reports a rejected import as one warning", async () => {
  const d = tmp();
  plugin(d, { "pi/index.ts": "" });
  const res = await loadPluginExtensions(
    {} as any,
    [{ marketplace: "mp", plugin: "a", dir: d }],
    async () => {
      throw new SyntaxError("Unexpected token");
    },
  );
  assert.deepEqual(res, {
    loaded: [],
    warnings: ["plugins: mp/a pi extension failed: Unexpected token"],
  });
});

test("loadPluginExtensions gives up on a factory that never settles and continues", async () => {
  const a = tmp();
  plugin(a, { "pi/index.ts": "" });
  const b = tmp();
  plugin(b, { "pi/index.ts": "" });
  const res = await loadPluginExtensions(
    {} as any,
    [
      { marketplace: "mp", plugin: "hang", dir: a },
      { marketplace: "mp", plugin: "ok", dir: b },
    ],
    async (url) =>
      url.includes(a) ? { default: () => new Promise(() => {}) } : { default: () => {} },
    { factoryTimeoutMs: 20 },
  );
  assert.deepEqual(res, {
    loaded: ["mp/ok"],
    warnings: ["plugins: mp/hang pi extension failed: factory did not finish within 20ms"],
  });
});

test("loadPluginExtensions loads a directory listed by two marketplaces once", async () => {
  const d = tmp();
  plugin(d, { "pi/index.ts": "" });
  let factoryCalls = 0;
  const res = await loadPluginExtensions(
    {} as any,
    [
      { marketplace: "mp1", plugin: "ext", dir: d },
      { marketplace: "mp2", plugin: "ext", dir: d },
    ],
    async () => ({
      default: () => {
        factoryCalls++;
      },
    }),
  );
  assert.equal(factoryCalls, 1);
  assert.deepEqual(res, { loaded: ["mp1/ext"], warnings: [] });
});
