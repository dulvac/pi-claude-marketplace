import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { renameSync, rmSync } from "node:fs";
import type { SelectItem } from "@earendil-works/pi-tui";
import {
  CLONES_DIR,
  CONFIG_PATH,
  defaultMarketplaceName,
  describeSource,
  loadConfig,
  parseMarketplaceSpec,
  saveConfig,
  withClaudeSettingsMarketplaces,
  type MarketplaceSource,
  type PluginsConfig,
} from "./config";

import {
  RESOURCES_DIR,
  ensureClone,
  marketplaceCloneDir,
  materializePluginResources,
  pluginNamespace,
  readManifest,
  resolvePluginDir,
  supportedResources,
  unsupportedFeatures,
  updateClone,
  type Exec,
  type MarketplaceManifest,
} from "./marketplace";
import { join } from "node:path";
import { findPluginExtensionEntry, installedPluginDirs, loadPluginExtensions } from "./extensions";
import { pickFromList } from "./ui";
import { mcpAdapterInstalled, pluginHasMcpServers, pluginMcpServers, syncManagedMcpServers } from "./mcp";

const SUBCOMMANDS = ["add", "remove", "install", "uninstall", "update", "list"] as const;

/** How a plugin-shipped `pi/` entry is described at install time. */
const PI_EXTENSION_PART = "pi extension (runs at startup)";

export default async function (pi: ExtensionAPI) {
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);

  // Plugin-shipped pi extensions (`pi/index.{ts,js,mjs}`) run under this extension's
  // runtime. Offline only: whatever is already cloned on disk, no git at factory time.
  // Each failure is one warning, surfaced once the session has a UI.
  const config = loadConfig();
  const marketplaces = withClaudeSettingsMarketplaces(config, process.cwd());
  const { warnings } = await loadPluginExtensions(pi, installedPluginDirs(config, marketplaces, CLONES_DIR));
  if (warnings.length > 0) {
    pi.on("session_start", async (_event, ctx) => {
      for (const w of warnings) ctx.ui.notify(w, "warning");
    });
  }

  pi.on("resources_discover", async (event) => {
    return await collectResources(exec, event.cwd);
  });

  pi.registerCommand("plugins", {
    description: "Browse and install Claude Code marketplace plugins (skills/commands)",
    getArgumentCompletions: (prefix) => {
      const items = SUBCOMMANDS.map((s) => ({ value: s, label: s }));
      const filtered = items.filter((i) => i.value.startsWith(prefix.trim()));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const [sub, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
      try {
        switch (sub) {
          case undefined:
            await browse(exec, ctx);
            return;
          case "add":
            await addMarketplace(exec, ctx, rest[0], rest[1]);
            return;
          case "remove":
            await removeMarketplace(ctx, rest[0]);
            return;
          case "install":
            await installByName(exec, ctx, rest[0], rest[1]);
            return;
          case "uninstall":
            await uninstallByName(ctx, rest[0]);
            return;
          case "update":
            await update(exec, ctx, rest[0]);
            return;
          case "list":
            list(ctx);
            return;
          default:
            ctx.ui.notify(
              `Usage: /plugins [add <owner/repo>[@ref] [name] | remove <marketplace> | install <plugin> [marketplace] | uninstall <plugin> | update [marketplace] | list]`,
              "warning",
            );
        }
      } catch (error) {
        ctx.ui.notify(`plugins: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Resource discovery (skills + prompt templates for installed plugins)
// ---------------------------------------------------------------------------

async function collectResources(
  exec: Exec,
  cwd: string,
): Promise<{ skillPaths: string[]; promptPaths: string[] }> {
  const config = loadConfig();
  const marketplaces = withClaudeSettingsMarketplaces(config, cwd);
  const skillPaths = new Set<string>();
  const promptPaths = new Set<string>();
  const mcpSupported = mcpAdapterInstalled(cwd);
  const desiredMcpServers: Record<string, unknown> = {};

  // Rebuild the namespaced shadow resources from scratch each discovery pass,
  // so uninstalled plugins leave nothing behind.
  rmSync(RESOURCES_DIR, { recursive: true, force: true });

  for (const [mpName, pluginNames] of Object.entries(config.installed)) {
    if (pluginNames.length === 0) continue;
    const source = marketplaces[mpName];
    if (!source) continue;
    const dir = marketplaceCloneDir(mpName);
    try {
      await ensureClone(exec, dir, source);
    } catch {
      continue; // offline or auth failure: skip silently, resources reappear next reload
    }
    const manifest = readManifest(dir);
    if (!manifest) continue;
    for (const pluginName of pluginNames) {
      const plugin = manifest.plugins.find((p) => p.name === pluginName);
      if (!plugin) continue;
      try {
        const pluginDir = await resolvePluginDir(exec, dir, plugin);
        if (!pluginDir) continue;
        const namespace = pluginNamespace(pluginDir, pluginName);
        const outDir = join(RESOURCES_DIR, mpName, pluginName);
        const resources = materializePluginResources(pluginDir, namespace, outDir);
        if (resources.skills) skillPaths.add(resources.skills);
        if (resources.prompts) promptPaths.add(resources.prompts);
        if (mcpSupported) Object.assign(desiredMcpServers, pluginMcpServers(pluginDir, namespace));
      } catch {
        // external plugin clone failed: skip
      }
    }
  }
  if (mcpSupported || (config.managedMcpServers ?? []).length > 0) {
    try {
      if (syncManagedMcpServers(config, desiredMcpServers)) saveConfig(config);
    } catch {
      // never let MCP sync break resource discovery
    }
  }
  return { skillPaths: [...skillPaths], promptPaths: [...promptPaths] };
}

// ---------------------------------------------------------------------------
// Interactive browser
// ---------------------------------------------------------------------------

async function browse(exec: Exec, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("No UI available. Use /plugins install <plugin> [marketplace] instead.", "warning");
    return;
  }
  const config = loadConfig();
  const marketplaces = withClaudeSettingsMarketplaces(config, ctx.cwd);
  const names = Object.keys(marketplaces);
  if (names.length === 0) {
    ctx.ui.notify("No marketplaces configured. Add one with: /plugins add <owner/repo>[@ref]", "warning");
    return;
  }

  let mpName = names[0];
  if (names.length > 1) {
    const picked = await pickFromList(
      ctx,
      "Claude Code Marketplaces",
      names.map((name) => ({
        value: name,
        label: name,
        description: `${describeSource(marketplaces[name])} · ${config.installed[name]?.length ?? 0} installed`,
      })),
    );
    if (!picked) return;
    mpName = picked;
  }

  const source = marketplaces[mpName];
  const dir = marketplaceCloneDir(mpName);
  ctx.ui.setStatus("plugins", `Syncing ${mpName}...`);
  try {
    await ensureClone(exec, dir, source);
  } finally {
    ctx.ui.setStatus("plugins", undefined);
  }
  const manifest = readManifest(dir);
  if (!manifest) {
    ctx.ui.notify(`${mpName}: no .claude-plugin/marketplace.json found`, "error");
    return;
  }

  const installed = new Set(config.installed[mpName] ?? []);
  const items: SelectItem[] = manifest.plugins.map((plugin) => {
    const mark = installed.has(plugin.name) ? "✓ " : "  ";
    const version = plugin.version ? ` v${plugin.version}` : "";
    return {
      value: plugin.name,
      label: `${mark}${plugin.name}${version}`,
      description: plugin.description ?? "",
    };
  });
  items.push({ value: "__update__", label: "↻ refresh marketplace", description: `git update ${describeSource(source)}` });

  const picked = await pickFromList(
    ctx,
    `${manifest.name ?? mpName} (${describeSource(source)})`,
    items,
    "↑↓ navigate • enter install/uninstall • esc cancel",
  );
  if (!picked) return;

  if (picked === "__update__") {
    await update(exec, ctx, mpName);
    return;
  }

  if (installed.has(picked)) {
    const ok = await ctx.ui.confirm("Uninstall plugin", `Uninstall ${picked} from ${mpName}?`);
    if (!ok) return;
    doUninstall(config, mpName, picked);
    await applyAndReload(ctx, `Uninstalled ${picked}`);
    return;
  }

  const plugin = manifest.plugins.find((p) => p.name === picked);
  if (!plugin) return;
  const pluginDir = await resolvePluginDir(exec, dir, plugin);
  if (!pluginDir) {
    ctx.ui.notify(`${picked}: unsupported plugin source`, "error");
    return;
  }
  const resources = supportedResources(pluginDir);
  const mcpSupported = mcpAdapterInstalled(ctx.cwd);
  const hasMcp = mcpSupported && pluginHasMcpServers(pluginDir);
  const hasPiExtension = findPluginExtensionEntry(pluginDir) !== undefined;
  const skipped = unsupportedFeatures(pluginDir, { mcpSupported });
  if (!resources.skills && !resources.prompts && !hasMcp && !hasPiExtension) {
    ctx.ui.notify(
      `${picked} has no skills, commands, MCP servers, or pi extension pi can load${skipped.length > 0 ? ` (only: ${skipped.join(", ")})` : ""}.`,
      "warning",
    );
    return;
  }
  const parts: string[] = [];
  if (resources.skills) parts.push("skills");
  if (resources.prompts) parts.push("commands");
  if (hasMcp) parts.push("MCP servers via pi-mcp-adapter");
  if (hasPiExtension) parts.push(PI_EXTENSION_PART);
  let message = `Install ${picked} (${parts.join(" + ")}) from ${mpName}?`;
  if (skipped.length > 0) message += `\nNot supported in pi, will be skipped: ${skipped.join(", ")}`;
  const ok = await ctx.ui.confirm("Install plugin", message);
  if (!ok) return;
  doInstall(config, mpName, picked, source);
  await applyAndReload(ctx, `Installed ${picked}`);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function addMarketplace(
  exec: Exec,
  ctx: ExtensionCommandContext,
  spec: string | undefined,
  explicitName: string | undefined,
): Promise<void> {
  if (!spec) {
    ctx.ui.notify("Usage: /plugins add <owner/repo>[@ref] [name]", "warning");
    return;
  }
  const source = parseMarketplaceSpec(spec);
  if (!source) {
    ctx.ui.notify(`Cannot parse marketplace spec: ${spec}`, "error");
    return;
  }
  source.origin = "config";

  const provisionalName = explicitName ?? defaultMarketplaceName(source);
  const provisionalDir = marketplaceCloneDir(provisionalName);
  ctx.ui.setStatus("plugins", `Cloning ${describeSource(source)}...`);
  try {
    rmSync(provisionalDir, { recursive: true, force: true });
    await ensureClone(exec, provisionalDir, source);
  } finally {
    ctx.ui.setStatus("plugins", undefined);
  }
  const manifest = readManifest(provisionalDir);
  if (!manifest) {
    rmSync(provisionalDir, { recursive: true, force: true });
    ctx.ui.notify(`${describeSource(source)} has no .claude-plugin/marketplace.json, so it is not a marketplace.`, "error");
    return;
  }
  const name = explicitName ?? manifest.name ?? provisionalName;
  if (name !== provisionalName) {
    const finalDir = marketplaceCloneDir(name);
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(provisionalDir, finalDir);
  }

  const config = loadConfig();
  config.marketplaces[name] = source;
  saveConfig(config);
  ctx.ui.notify(
    `Added marketplace ${name} (${describeSource(source)}) with ${manifest.plugins.length} plugins. Run /plugins to browse.`,
    "info",
  );
}

async function removeMarketplace(ctx: ExtensionCommandContext, name: string | undefined): Promise<void> {
  if (!name) {
    ctx.ui.notify("Usage: /plugins remove <marketplace>", "warning");
    return;
  }
  const config = loadConfig();
  const hadInstalled = (config.installed[name] ?? []).length > 0;
  if (!config.marketplaces[name] && !config.installed[name]) {
    ctx.ui.notify(`Unknown marketplace: ${name}`, "error");
    return;
  }
  delete config.marketplaces[name];
  delete config.installed[name];
  saveConfig(config);
  rmSync(marketplaceCloneDir(name), { recursive: true, force: true });
  if (hadInstalled) {
    await applyAndReload(ctx, `Removed marketplace ${name}`);
  } else {
    ctx.ui.notify(`Removed marketplace ${name}`, "info");
  }
}

async function installByName(
  exec: Exec,
  ctx: ExtensionCommandContext,
  pluginName: string | undefined,
  mpFilter: string | undefined,
): Promise<void> {
  if (!pluginName) {
    ctx.ui.notify("Usage: /plugins install <plugin> [marketplace]", "warning");
    return;
  }
  const config = loadConfig();
  const marketplaces = withClaudeSettingsMarketplaces(config, ctx.cwd);
  const candidates = mpFilter ? [mpFilter] : Object.keys(marketplaces);
  for (const mpName of candidates) {
    const source = marketplaces[mpName];
    if (!source) continue;
    const dir = marketplaceCloneDir(mpName);
    try {
      await ensureClone(exec, dir, source);
    } catch {
      continue;
    }
    const manifest = readManifest(dir);
    const plugin = manifest?.plugins.find((p) => p.name === pluginName);
    if (!plugin || !manifest) continue;
    const pluginDir = await resolvePluginDir(exec, dir, plugin);
    if (!pluginDir) continue;
    const skipped = unsupportedFeatures(pluginDir, { mcpSupported: mcpAdapterInstalled(ctx.cwd) });
    if (skipped.length > 0) {
      ctx.ui.notify(`${pluginName}: skipping unsupported features: ${skipped.join(", ")}`, "warning");
    }
    if (findPluginExtensionEntry(pluginDir)) {
      ctx.ui.notify(`${pluginName} ships a ${PI_EXTENSION_PART}.`, "info");
    }
    doInstall(config, mpName, pluginName, source);
    await applyAndReload(ctx, `Installed ${pluginName} from ${mpName}`);
    return;
  }
  ctx.ui.notify(`Plugin not found: ${pluginName}`, "error");
}

async function uninstallByName(ctx: ExtensionCommandContext, pluginName: string | undefined): Promise<void> {
  if (!pluginName) {
    ctx.ui.notify("Usage: /plugins uninstall <plugin>", "warning");
    return;
  }
  const config = loadConfig();
  const mpName = Object.keys(config.installed).find((mp) => config.installed[mp].includes(pluginName));
  if (!mpName) {
    ctx.ui.notify(`Plugin not installed: ${pluginName}`, "error");
    return;
  }
  doUninstall(config, mpName, pluginName);
  await applyAndReload(ctx, `Uninstalled ${pluginName}`);
}

async function update(exec: Exec, ctx: ExtensionCommandContext, name: string | undefined): Promise<void> {
  const config = loadConfig();
  const marketplaces = withClaudeSettingsMarketplaces(config, ctx.cwd);
  const targets = name ? [name] : Object.keys(marketplaces);
  const updated: string[] = [];
  for (const mpName of targets) {
    const source = marketplaces[mpName];
    if (!source) {
      ctx.ui.notify(`Unknown marketplace: ${mpName}`, "error");
      continue;
    }
    ctx.ui.setStatus("plugins", `Updating ${mpName}...`);
    try {
      await updateClone(exec, marketplaceCloneDir(mpName), source);
      updated.push(mpName);
    } catch (error) {
      ctx.ui.notify(`${mpName}: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      ctx.ui.setStatus("plugins", undefined);
    }
  }
  if (updated.length > 0) {
    await applyAndReload(ctx, `Updated: ${updated.join(", ")}`);
  }
}

function list(ctx: ExtensionContext): void {
  const config = loadConfig();
  const marketplaces = withClaudeSettingsMarketplaces(config, ctx.cwd);
  const lines: string[] = [];
  for (const [name, source] of Object.entries(marketplaces)) {
    const suffix = source.origin === "claude-settings" ? " (from Claude Code settings)" : "";
    lines.push(`${name}: ${describeSource(source)}${suffix}`);
    for (const plugin of config.installed[name] ?? []) {
      lines.push(`  ✓ ${plugin}`);
    }
  }
  if (lines.length === 0) {
    lines.push(`No marketplaces configured (config: ${CONFIG_PATH})`);
    lines.push("Add one with: /plugins add <owner/repo>[@ref]");
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function doInstall(
  config: PluginsConfig,
  mpName: string,
  pluginName: string,
  source: MarketplaceSource,
): void {
  const plugins = config.installed[mpName] ?? [];
  if (!plugins.includes(pluginName)) plugins.push(pluginName);
  config.installed[mpName] = plugins;
  // Persist the marketplace source too, so installs from Claude-settings marketplaces
  // keep working even if the .claude settings file changes.
  if (!config.marketplaces[mpName]) {
    config.marketplaces[mpName] = { ...source, origin: "config" };
  }
  saveConfig(config);
}

function doUninstall(config: PluginsConfig, mpName: string, pluginName: string): void {
  config.installed[mpName] = (config.installed[mpName] ?? []).filter((p) => p !== pluginName);
  if (config.installed[mpName].length === 0) delete config.installed[mpName];
  saveConfig(config);
}

async function applyAndReload(ctx: ExtensionCommandContext, message: string): Promise<void> {
  ctx.ui.notify(message, "info");
  if (!ctx.hasUI) return;
  const reload = await ctx.ui.confirm("Reload", "Reload pi resources now to apply changes?");
  if (reload) {
    await ctx.reload();
  } else {
    ctx.ui.notify("Changes apply on next /reload or restart.", "info");
  }
}
