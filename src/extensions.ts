import { existsSync } from "node:fs";
import { join } from "node:path";
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

/** Path of the plugin's pi extension entry (`pi/index.{ts,js,mjs}`), if it ships one. */
export function findPluginExtensionEntry(pluginDir: string): string | undefined {
  for (const name of ENTRY_CANDIDATES) {
    const candidate = join(pluginDir, "pi", name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
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
