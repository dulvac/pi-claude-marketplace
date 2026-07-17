import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_DIR, type PluginsConfig } from "./config";
import { namespacedResourceName } from "./marketplace";

/**
 * Integration with pi-mcp-adapter (github.com/nicobailon/pi-mcp-adapter).
 *
 * Claude Code plugins can ship MCP servers in a plugin-root `.mcp.json`. Pi
 * itself has no MCP support, but when the pi-mcp-adapter extension is
 * installed we can register those servers in the adapter's pi-global config
 * (`~/.pi/agent/mcp.json`). Managed entries are tracked in our own config so
 * uninstalling a plugin removes exactly the servers it added and never
 * touches servers the user configured themselves.
 */

export const MCP_CONFIG_PATH = join(AGENT_DIR, "mcp.json");

/** True when the pi-mcp-adapter extension appears to be installed. */
export function mcpAdapterInstalled(cwd: string): boolean {
  return [
    join(AGENT_DIR, "npm", "node_modules", "pi-mcp-adapter"),
    join(cwd, "node_modules", "pi-mcp-adapter"),
  ].some(existsSync);
}

/** True when a plugin ships MCP servers we could register. */
export function pluginHasMcpServers(pluginDir: string): boolean {
  return Object.keys(readPluginMcpConfig(pluginDir)).length > 0;
}

/**
 * MCP servers declared by a plugin, keyed by their namespaced name
 * (plugin "tools" + server "search" -> "tools-search"), with
 * `${CLAUDE_PLUGIN_ROOT}` substituted by the plugin directory.
 */
export function pluginMcpServers(pluginDir: string, namespace: string): Record<string, unknown> {
  const servers = readPluginMcpConfig(pluginDir);
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(servers)) {
    out[namespacedResourceName(namespace, name)] = substitutePluginRoot(def, pluginDir);
  }
  return out;
}

function readPluginMcpConfig(pluginDir: string): Record<string, unknown> {
  const path = join(pluginDir, ".mcp.json");
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: unknown };
    if (raw && typeof raw.mcpServers === "object" && raw.mcpServers !== null) {
      return raw.mcpServers as Record<string, unknown>;
    }
  } catch {
    // malformed .mcp.json: treat as no servers
  }
  return {};
}

function substitutePluginRoot(value: unknown, pluginDir: string): unknown {
  if (typeof value === "string") return value.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginDir);
  if (Array.isArray(value)) return value.map((v) => substitutePluginRoot(v, pluginDir));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitutePluginRoot(v, pluginDir);
    return out;
  }
  return value;
}

/**
 * Reconcile `~/.pi/agent/mcp.json` with the MCP servers of the currently
 * installed plugins. Removes managed entries whose plugin is gone, adds new
 * ones, and refreshes existing managed entries (clone updates may change
 * them). Entries the user created themselves are never overwritten.
 *
 * Mutates `config.managedMcpServers`; returns true when either the mcp.json
 * file or the managed list changed (caller should persist the config).
 */
export function syncManagedMcpServers(
  config: PluginsConfig,
  desired: Record<string, unknown>,
): boolean {
  const previouslyManaged = new Set(config.managedMcpServers ?? []);

  let file: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) file = raw as Record<string, unknown>;
  } catch {
    // missing or malformed: start fresh, preserving nothing
  }
  const servers =
    file.mcpServers && typeof file.mcpServers === "object" && !Array.isArray(file.mcpServers)
      ? (file.mcpServers as Record<string, unknown>)
      : {};
  const before = JSON.stringify(servers);

  // Drop managed entries whose plugin was uninstalled.
  for (const name of previouslyManaged) {
    if (!(name in desired)) delete servers[name];
  }
  // Add or refresh entries for installed plugins. A name that exists but was
  // never managed by us belongs to the user; leave it alone.
  const managed: string[] = [];
  for (const [name, def] of Object.entries(desired)) {
    if (name in servers && !previouslyManaged.has(name)) continue;
    servers[name] = def;
    managed.push(name);
  }

  const managedChanged =
    managed.length !== previouslyManaged.size || managed.some((n) => !previouslyManaged.has(n));
  config.managedMcpServers = managed;

  const serversChanged = JSON.stringify(servers) !== before;
  if (serversChanged) {
    file.mcpServers = servers;
    mkdirSync(dirname(MCP_CONFIG_PATH), { recursive: true });
    const tmp = `${MCP_CONFIG_PATH}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(tmp, MCP_CONFIG_PATH);
  }
  return serversChanged || managedChanged;
}
