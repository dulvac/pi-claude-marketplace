import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MarketplaceSource, PluginsConfig } from "./config.ts";
import { marketplaceCloneDir, readManifest, resolvePluginDirOffline } from "./marketplace.ts";

/** Entry files a plugin may ship under `pi/`; the first one present wins. */
const ENTRY_CANDIDATES = ["index.ts", "index.js", "index.mjs"];

export interface InstalledPlugin {
  marketplace: string;
  plugin: string;
  /** Resolved plugin directory on disk. */
  dir: string;
}

/**
 * Path of the plugin's pi extension entry (`pi/index.{ts,js,mjs}`), if it ships one.
 * Never throws: unreadable or cyclic paths count as "no entry", like `existsSync`.
 */
export function findPluginExtensionEntry(pluginDir: string): string | undefined {
  for (const name of ENTRY_CANDIDATES) {
    const candidate = join(pluginDir, "pi", name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/**
 * Installed plugins whose directories already exist on disk. Works purely offline:
 * marketplaces that are unknown, not cloned, or lack a readable manifest are skipped,
 * as are plugins missing from the manifest or not yet cloned. `clonesDir` is the parent
 * of the per-marketplace clones (production passes `CLONES_DIR`).
 */
export function installedPluginDirs(
  config: PluginsConfig,
  marketplaces: Record<string, MarketplaceSource>,
  clonesDir: string,
): InstalledPlugin[] {
  const result: InstalledPlugin[] = [];
  for (const [mpName, pluginNames] of Object.entries(config.installed)) {
    if (!marketplaces[mpName]) continue;
    const marketplaceDir = marketplaceCloneDir(mpName, clonesDir);
    const manifest = readManifest(marketplaceDir);
    if (!manifest) continue;
    for (const pluginName of pluginNames) {
      const plugin = manifest.plugins.find((p) => p.name === pluginName);
      if (!plugin) continue;
      const dir = resolvePluginDirOffline(marketplaceDir, plugin, clonesDir);
      if (dir) result.push({ marketplace: mpName, plugin: pluginName, dir });
    }
  }
  return result;
}

/** Longest a plugin's factory may take before it is reported as failed and skipped. */
const DEFAULT_FACTORY_TIMEOUT_MS = 15_000;

export interface LoadPluginExtensionsOptions {
  /** Per-plugin bound on `await factory(pi)`, in milliseconds. Default 15000. */
  factoryTimeoutMs?: number;
}

/**
 * Import and run the pi extension shipped by each installed plugin. Every plugin is
 * isolated: an import or factory failure becomes one warning and never stops the
 * others, and a factory that does not settle within `factoryTimeoutMs` is reported
 * and skipped so a hung plugin cannot hold up pi startup. A directory listed by
 * several marketplaces is loaded once, under the first entry's name.
 *
 * Reload semantics: pi re-runs this entry on `/reload` because it creates a fresh module
 * loader per load, so edits to `.ts` and plain `.js` entries are picked up then. `.mjs`
 * entries (and `.js` under a `"type": "module"` package) are imported natively and cached
 * by Node for the life of the process, so they need a pi restart after an edit or
 * `/plugins update`. The `?v=` query below is harmless but is not what makes reload work;
 * pi's loader drops it before importing.
 *
 * `importModule` is injectable for tests; production uses dynamic `import()`.
 */
export async function loadPluginExtensions(
  pi: ExtensionAPI,
  plugins: InstalledPlugin[],
  importModule: (url: string) => Promise<unknown> = (url) => import(url),
  options: LoadPluginExtensionsOptions = {},
): Promise<{ loaded: string[]; warnings: string[] }> {
  const timeoutMs = options.factoryTimeoutMs ?? DEFAULT_FACTORY_TIMEOUT_MS;
  const loaded: string[] = [];
  const warnings: string[] = [];
  const seenDirs = new Set<string>();
  for (const { marketplace, plugin, dir } of plugins) {
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const entry = findPluginExtensionEntry(dir);
    if (!entry) continue;
    const name = `${marketplace}/${plugin}`;
    try {
      const mod = await importModule(pathToFileURL(entry).href + "?v=" + Date.now());
      const factory = extensionFactory(mod);
      if (!factory) throw new Error(`${entry} has no default export function`);
      await withTimeout(() => factory(pi), timeoutMs);
      loaded.push(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`plugins: ${name} pi extension failed: ${message}`);
    }
  }
  return { loaded, warnings };
}

/**
 * Run `fn` and reject if it has not settled after `ms`. The timer is cleared as soon as
 * the promise settles. On timeout the orphaned factory keeps running in the background
 * and may still register commands or handlers later through the shared `ExtensionAPI`,
 * which stays active after loading; that is harmless.
 */
async function withTimeout(fn: () => unknown, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`factory did not finish within ${formatMs(ms)}`)),
      ms,
    );
  });
  try {
    await Promise.race([Promise.resolve().then(fn), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function formatMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

type ExtensionFactory = (pi: ExtensionAPI) => unknown;

/** The module's `default` export when it is a function, or the module itself (CJS interop). */
function extensionFactory(mod: unknown): ExtensionFactory | undefined {
  if (typeof mod === "function") return mod as ExtensionFactory;
  if (mod && typeof mod === "object" && "default" in mod && typeof mod.default === "function") {
    return mod.default as ExtensionFactory;
  }
  return undefined;
}
