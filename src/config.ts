import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where a marketplace repo lives. Exactly one of `repo` (github shorthand) or `url` is set. */
export interface MarketplaceSource {
  /** GitHub shorthand: "owner/name" */
  repo?: string;
  /** Full git URL (https://, ssh://, git@host:path) */
  url?: string;
  /** Branch, tag, or commit to pin. Defaults to the repo's default branch. */
  ref?: string;
  /** Where this entry came from. "claude-settings" entries are read-only. */
  origin?: "config" | "claude-settings";
}

export interface PluginsConfig {
  marketplaces: Record<string, MarketplaceSource>;
  /** marketplace name -> installed plugin names */
  installed: Record<string, string[]>;
  /** MCP server names we registered in the pi-mcp-adapter config (mcp.json). */
  managedMcpServers?: string[];
}

export const AGENT_DIR = join(homedir(), ".pi", "agent");
export const CONFIG_PATH = join(AGENT_DIR, "claude-marketplace.json");
export const CLONES_DIR = join(AGENT_DIR, "claude-marketplaces");

export function loadConfig(): PluginsConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<PluginsConfig>;
    const marketplaces: Record<string, MarketplaceSource> = {};
    for (const [name, src] of Object.entries(raw.marketplaces ?? {})) {
      if (src && (src.repo || src.url)) marketplaces[name] = { ...src, origin: "config" };
    }
    const installed: Record<string, string[]> = {};
    for (const [name, plugins] of Object.entries(raw.installed ?? {})) {
      if (Array.isArray(plugins)) installed[name] = plugins.filter((p) => typeof p === "string");
    }
    const managedMcpServers = Array.isArray(raw.managedMcpServers)
      ? raw.managedMcpServers.filter((n) => typeof n === "string")
      : [];
    return { marketplaces, installed, managedMcpServers };
  } catch {
    return { marketplaces: {}, installed: {}, managedMcpServers: [] };
  }
}

export function saveConfig(config: PluginsConfig): void {
  const marketplaces: Record<string, Omit<MarketplaceSource, "origin">> = {};
  for (const [name, src] of Object.entries(config.marketplaces)) {
    if (src.origin === "claude-settings") continue; // never persist mirrored Claude Code settings
    const { origin: _origin, ...rest } = src;
    marketplaces[name] = rest;
  }
  const installed: Record<string, string[]> = {};
  for (const [name, plugins] of Object.entries(config.installed)) {
    if (plugins.length > 0) installed[name] = plugins;
  }
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  const managedMcpServers = config.managedMcpServers ?? [];
  writeFileSync(
    tmp,
    `${JSON.stringify({ marketplaces, installed, managedMcpServers }, null, 2)}\n`,
    "utf8",
  );
  renameSync(tmp, CONFIG_PATH);
}

/**
 * Mirror Claude Code's `extraKnownMarketplaces` from ~/.claude/settings.json and
 * <cwd>/.claude/settings.json so pi users get the same marketplaces with zero setup.
 * Explicit pi config entries win over mirrored ones.
 */
export function withClaudeSettingsMarketplaces(
  config: PluginsConfig,
  cwd: string,
): Record<string, MarketplaceSource> {
  const merged: Record<string, MarketplaceSource> = {};
  for (const settingsPath of [
    join(homedir(), ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
  ]) {
    if (!existsSync(settingsPath)) continue;
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        extraKnownMarketplaces?: Record<
          string,
          { source?: { source?: string; repo?: string; url?: string; ref?: string } }
        >;
      };
      for (const [name, entry] of Object.entries(settings.extraKnownMarketplaces ?? {})) {
        const source = entry?.source;
        if (!source) continue;
        if (source.source === "github" && source.repo) {
          merged[name] = { repo: source.repo, ref: source.ref, origin: "claude-settings" };
        } else if (source.source === "git" && source.url) {
          merged[name] = { url: source.url, ref: source.ref, origin: "claude-settings" };
        }
      }
    } catch {
      // ignore malformed settings files
    }
  }
  return { ...merged, ...config.marketplaces };
}

/**
 * Parse a marketplace spec like:
 *   owner/repo
 *   owner/repo@dev
 *   https://github.com/owner/repo@v1.2
 *   git@github.com:owner/repo@dev
 *   ssh://git@github.com/owner/repo
 */
export function parseMarketplaceSpec(spec: string): MarketplaceSource | undefined {
  let rest = spec.trim();
  if (!rest) return undefined;

  let ref: string | undefined;
  const at = rest.lastIndexOf("@");
  if (at > 0) {
    const candidate = rest.slice(at + 1);
    // A ref never contains "/" or ":" (which would indicate the "@" belongs to an ssh URL).
    if (candidate && !candidate.includes("/") && !candidate.includes(":")) {
      ref = candidate;
      rest = rest.slice(0, at);
    }
  }

  if (/^(https?|ssh|git):\/\//.test(rest) || /^git@[^/]+:/.test(rest)) {
    return { url: rest, ref };
  }
  const githubMatch = rest.match(/^github\.com\/([^/]+\/[^/]+)$/);
  if (githubMatch) return { repo: githubMatch[1], ref };
  if (/^[\w.-]+\/[\w.-]+$/.test(rest)) return { repo: rest, ref };
  return undefined;
}

/** Default marketplace name derived from a source (repo basename). */
export function defaultMarketplaceName(source: MarketplaceSource): string {
  const path = source.repo ?? source.url ?? "marketplace";
  const base = path.split(/[/:]/).filter(Boolean).pop() ?? "marketplace";
  return base.replace(/\.git$/, "");
}

export function gitUrl(source: MarketplaceSource): string {
  if (source.url) return source.url;
  return `https://github.com/${source.repo}.git`;
}

export function describeSource(source: MarketplaceSource): string {
  const base = source.repo ?? source.url ?? "?";
  return source.ref ? `${base}@${source.ref}` : base;
}
