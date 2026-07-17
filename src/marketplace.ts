import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, normalize, relative } from "node:path";
import {
  CLONES_DIR,
  gitUrl,
  parseMarketplaceSpec,
  type MarketplaceSource,
} from "./config";

/** Minimal shape of pi.exec we depend on. */
export type Exec = (
  command: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export interface MarketplacePluginEntry {
  name: string;
  description?: string;
  version?: string;
  category?: string;
  author?: { name?: string };
  /** Relative path inside the marketplace repo, or an external source descriptor. */
  source: string | { source?: string; repo?: string; url?: string; ref?: string };
  strict?: boolean;
}

export interface MarketplaceManifest {
  name?: string;
  description?: string;
  owner?: { name?: string; email?: string };
  plugins: MarketplacePluginEntry[];
}

const GIT_TIMEOUT_MS = 120_000;

export function marketplaceCloneDir(name: string): string {
  return join(CLONES_DIR, sanitize(name));
}

/** Where namespaced shadow copies of plugin skills/commands are materialized. */
export const RESOURCES_DIR = join(CLONES_DIR, "_resources");

function externalPluginCloneDir(repoOrUrl: string): string {
  return join(CLONES_DIR, "_external", sanitize(repoOrUrl));
}

function sanitize(name: string): string {
  return name.replace(/[^\w.-]+/g, "__");
}

async function git(exec: Exec, args: string[], cwd?: string): Promise<string> {
  const fullArgs = cwd ? ["-C", cwd, ...args] : args;
  const result = await exec("git", fullArgs, { timeout: GIT_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

/** Clone a marketplace repo (honoring its pinned ref) if not already present. */
export async function ensureClone(exec: Exec, dir: string, source: MarketplaceSource): Promise<void> {
  if (existsSync(join(dir, ".git"))) return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".."), { recursive: true });
  const url = gitUrl(source);
  if (source.ref) {
    try {
      // Works for branches and tags.
      await git(exec, ["clone", "--depth", "1", "--branch", source.ref, url, dir]);
      return;
    } catch {
      // Possibly a commit SHA: fall through to full clone + checkout.
      rmSync(dir, { recursive: true, force: true });
    }
    await git(exec, ["clone", url, dir]);
    await git(exec, ["checkout", "--quiet", source.ref], dir);
    return;
  }
  await git(exec, ["clone", "--depth", "1", url, dir]);
}

/** Fetch and hard-reset an existing clone to the pinned ref (or fast-forward the default branch). */
export async function updateClone(exec: Exec, dir: string, source: MarketplaceSource): Promise<void> {
  if (!existsSync(join(dir, ".git"))) {
    await ensureClone(exec, dir, source);
    return;
  }
  if (source.ref) {
    await git(exec, ["fetch", "--depth", "1", "origin", source.ref], dir);
    await git(exec, ["checkout", "--quiet", "--detach", "FETCH_HEAD"], dir);
  } else {
    await git(exec, ["fetch", "--depth", "1", "origin"], dir);
    // Reset to whatever the remote default branch points at.
    const head = (await git(exec, ["rev-parse", "--abbrev-ref", "HEAD"], dir)).trim();
    if (head === "HEAD") {
      await git(exec, ["checkout", "--quiet", "--detach", "FETCH_HEAD"], dir);
    } else {
      await git(exec, ["reset", "--hard", `origin/${head}`], dir);
    }
  }
}

export function readManifest(dir: string): MarketplaceManifest | undefined {
  const manifestPath = join(dir, ".claude-plugin", "marketplace.json");
  if (!existsSync(manifestPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as MarketplaceManifest;
    if (!Array.isArray(raw.plugins)) return undefined;
    return { ...raw, plugins: raw.plugins.filter((p) => p && typeof p.name === "string") };
  } catch {
    return undefined;
  }
}

/**
 * Resolve the on-disk directory of a plugin. Relative-path sources resolve inside the
 * marketplace clone; external github/git sources get their own clone under _external/.
 * Returns undefined for unsupported source shapes.
 */
export async function resolvePluginDir(
  exec: Exec,
  marketplaceDir: string,
  plugin: MarketplacePluginEntry,
): Promise<string | undefined> {
  const source = plugin.source;
  if (typeof source === "string") {
    const rel = normalize(source).replace(/^(\.\/)+/, "");
    if (rel.startsWith("..") || rel.startsWith("/")) return undefined;
    const dir = join(marketplaceDir, rel);
    return existsSync(dir) ? dir : undefined;
  }
  if (source && typeof source === "object") {
    let external: MarketplaceSource | undefined;
    if (source.source === "github" && source.repo) {
      external = { repo: source.repo, ref: source.ref };
    } else if ((source.source === "git" || source.url) && source.url) {
      external = parseMarketplaceSpec(source.url) ?? { url: source.url };
      external.ref = source.ref ?? external.ref;
    }
    if (!external) return undefined;
    const dir = externalPluginCloneDir(external.repo ?? external.url ?? plugin.name);
    await ensureClone(exec, dir, external);
    return dir;
  }
  return undefined;
}

/** Claude Code plugin features that pi cannot load. Used for install-time warnings. */
export function unsupportedFeatures(pluginDir: string): string[] {
  const found: string[] = [];
  const checks: Array<[string, string]> = [
    [".mcp.json", "MCP servers (.mcp.json)"],
    [".lsp.json", "LSP config (.lsp.json)"],
    ["hooks", "hooks"],
    ["agents", "agents"],
    ["scripts", "scripts (statusline etc.)"],
  ];
  for (const [file, label] of checks) {
    if (existsSync(join(pluginDir, file))) found.push(label);
  }
  return found;
}

/** Resources pi can load from a plugin directory. */
export function supportedResources(pluginDir: string): { skills?: string; prompts?: string } {
  const result: { skills?: string; prompts?: string } = {};
  const skills = join(pluginDir, "skills");
  if (existsSync(skills)) result.skills = skills;
  const commands = join(pluginDir, "commands");
  if (existsSync(commands)) result.prompts = commands;
  return result;
}

// ---------------------------------------------------------------------------
// Namespacing (mirrors Claude Code's /plugin:command scoping)
// ---------------------------------------------------------------------------

/**
 * Namespace for a plugin's skills/commands: the plugin.json `name` (e.g. "tools"),
 * falling back to the marketplace entry name. Sanitized to pi's skill-name
 * charset (lowercase a-z, 0-9, hyphens).
 */
export function pluginNamespace(pluginDir: string, fallback: string): string {
  let name = fallback;
  try {
    const raw = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")) as {
      name?: string;
    };
    if (raw.name && typeof raw.name === "string") name = raw.name;
  } catch {
    // no plugin.json: use fallback
  }
  return sanitizeResourceName(name) || "plugin";
}

/** Pi skill names must match ^[a-z0-9-]+$ with no leading/trailing/double hyphens. */
function sanitizeResourceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "tools" + "setup" -> "tools-setup"; already-prefixed names ("tools-lint") stay as-is. */
function namespacedName(namespace: string, name: string): string {
  const clean = sanitizeResourceName(name) || "unnamed";
  if (clean === namespace || clean.startsWith(`${namespace}-`)) return clean;
  return `${namespace}-${clean}`;
}

/**
 * Materialize namespaced shadow copies of a plugin's skills and commands under
 * `outDir`, so that skill/command names never collide across plugins (Claude
 * Code scopes these as /tools:setup; pi skill names can't contain ":", so we use
 * "tools-setup"). SKILL.md files are copied with a rewritten `name:` frontmatter;
 * all other skill assets are symlinked to the original clone.
 */
export function materializePluginResources(
  pluginDir: string,
  namespace: string,
  outDir: string,
): { skills?: string; prompts?: string } {
  rmSync(outDir, { recursive: true, force: true });
  const source = supportedResources(pluginDir);
  const result: { skills?: string; prompts?: string } = {};

  if (source.skills) {
    const skillsOut = join(outDir, "skills");
    for (const skillDir of findSkillDirs(source.skills)) {
      const skillMd = readFileSync(join(skillDir, "SKILL.md"), "utf8");
      const originalName = frontmatterName(skillMd) ?? basename(skillDir);
      const name = namespacedName(namespace, originalName);
      const dest = join(skillsOut, name);
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "SKILL.md"), withFrontmatterName(skillMd, name), "utf8");
      for (const entry of readdirSync(skillDir)) {
        if (entry === "SKILL.md") continue;
        symlinkSync(join(skillDir, entry), join(dest, entry));
      }
    }
    if (existsSync(skillsOut)) result.skills = skillsOut;
  }

  if (source.prompts) {
    const promptsOut = join(outDir, "prompts");
    for (const file of findMarkdownFiles(source.prompts)) {
      // commands/pr.md -> tools-pr.md; nested commands/foo/bar.md -> tools-foo-bar.md
      const segments = relative(source.prompts, file).replace(/\.md$/i, "").split(/[\\/]/);
      const name = namespacedName(namespace, segments.join("-"));
      mkdirSync(promptsOut, { recursive: true });
      symlinkSync(file, join(promptsOut, `${name}.md`));
    }
    if (existsSync(promptsOut)) result.prompts = promptsOut;
  }

  return result;
}

/** Directories containing SKILL.md, searched recursively (no descent into a skill dir). */
function findSkillDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (existsSync(join(dir, "SKILL.md"))) {
      found.push(dir);
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
    }
  };
  walk(root);
  return found;
}

function findMarkdownFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) found.push(full);
    }
  };
  walk(root);
  return found;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function frontmatterName(content: string): string | undefined {
  const block = content.match(FRONTMATTER_RE)?.[1];
  const match = block?.match(/^name\s*:\s*(["']?)(.+?)\1\s*$/m);
  return match?.[2];
}

function withFrontmatterName(content: string, name: string): string {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return `---\nname: ${name}\n---\n\n${content}`;
  let block = match[1];
  if (/^name\s*:/m.test(block)) {
    block = block.replace(/^name\s*:.*$/m, `name: ${name}`);
  } else {
    block = `name: ${name}\n${block}`;
  }
  return `---\n${block}\n---\n${content.slice(match[0].length)}`;
}
