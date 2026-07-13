import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { toPosixPath } from "./fs-utils.js";

export interface SkillRef {
  name: string;
  dir: string;
  relPath: string;
}

type SkillDiscovery = SkillRef & { hasEvals: boolean };

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(relPath: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => globToRegExp(toPosixPath(pattern)).test(relPath));
}

function readSkillName(skillPath: string, fallback: string): string {
  try {
    const markdown = readFileSync(skillPath, "utf-8");
    const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) return fallback;
    const frontmatter = load(match[1]) as unknown;
    if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return fallback;
    const name = (frontmatter as Record<string, unknown>).name;
    return typeof name === "string" && name.trim() ? name.trim() : fallback;
  } catch {
    return fallback;
  }
}

export function discoverSkills(
  root: string,
  opts: { include?: string[]; exclude?: string[] } = {}
): SkillDiscovery[] {
  const discoveryRoot = path.resolve(root);
  const results: SkillDiscovery[] = [];

  function walk(dir: string): void {
    const basename = path.basename(dir);
    if (basename === "node_modules" || basename === ".git" || basename === "dist" || basename === ".next") {
      return;
    }

    const relPath = toPosixPath(path.relative(discoveryRoot, dir) || basename);
    const skillPath = path.join(dir, "SKILL.md");
    if (existsSync(skillPath)) {
      const normalizedRel = toPosixPath(path.relative(discoveryRoot, dir));
      if (!matchesAny(normalizedRel, opts.exclude) && (!opts.include?.length || matchesAny(normalizedRel, opts.include))) {
        results.push({
          name: readSkillName(skillPath, basename),
          dir,
          relPath: normalizedRel,
          hasEvals: existsSync(path.join(dir, "evals", "evals.json")),
        });
      }
      return;
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  }

  walk(discoveryRoot);
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
