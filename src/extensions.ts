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

/**
 * Import and run the pi extension shipped by each installed plugin. Every plugin is
 * isolated: an import or factory failure becomes one warning and never stops the
 * others. A directory listed by several marketplaces is loaded once, under the first
 * entry's name. `importModule` is injectable for tests; production uses dynamic
 * `import()` with a cache-busting query so a reinstall picks up new code.
 */
export async function loadPluginExtensions(
  pi: ExtensionAPI,
  plugins: InstalledPlugin[],
  importModule: (url: string) => Promise<unknown> = (url) => import(url),
): Promise<{ loaded: string[]; warnings: string[] }> {
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
      await factory(pi);
      loaded.push(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`plugins: ${name} pi extension failed: ${message}`);
    }
  }
  return { loaded, warnings };
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
