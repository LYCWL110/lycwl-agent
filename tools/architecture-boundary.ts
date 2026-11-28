import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

export const FORBIDDEN_TARGET_LAYERS: Readonly<Record<string, readonly string[]>> = {
  contracts: ["adapters", "application", "bootstrap", "services", "tui"],
  domain: ["adapters", "application", "bootstrap", "services", "tui"],
  application: ["adapters", "bootstrap", "tui"],
  ports: ["adapters", "application", "bootstrap", "services", "tui"],
  adapters: ["application", "bootstrap", "tui"],
  services: ["bootstrap", "tui"],
  tui: ["bootstrap"],
  web: ["bootstrap"],
  bootstrap: [],
};

export const FORBIDDEN_NODE_LAYERS = new Set(["contracts", "domain", "application", "ports"]);

/**
 * Layers that must be pure: no ambient process, filesystem, clock or random access.
 * A pure layer is what makes a render or a policy decision reproducible, so this is
 * enforced rather than trusted.
 */
export const PURE_LAYERS = new Set(["contracts", "domain", "ports"]);

/** Ambient access patterns that make a pure module depend on its environment. */
const AMBIENT_PATTERNS: readonly Readonly<{ pattern: RegExp; label: string }>[] = [
  { pattern: /\bprocess\s*\.\s*env\b/, label: "process.env" },
  { pattern: /\bDate\s*\.\s*now\b/, label: "Date.now" },
  { pattern: /\bnew\s+Date\s*\(\s*\)/, label: "new Date()" },
  { pattern: /\bMath\s*\.\s*random\b/, label: "Math.random" },
  { pattern: /\brequire\s*\(\s*["']node:/, label: "require('node:...')" },
  { pattern: /\bimport\s*\(\s*["']node:/, label: "dynamic import of node:" },
];

/**
 * Layers that must not execute anything. The TUI and the web front end read
 * projections and submit commands; a render path that could execute a tool would
 * make the interface an authority instead of a view.
 */
const NO_EXECUTION_LAYERS = new Set(["tui", "web", "contracts"]);

const EXECUTION_PATTERNS: readonly Readonly<{ pattern: RegExp; label: string }>[] = [
  { pattern: /\bchild_process\b/, label: "child_process" },
  { pattern: /\bexecSync\b/, label: "execSync" },
  { pattern: /\bspawnSync\b/, label: "spawnSync" },
];

export type SourceModule = Readonly<{
  path: string;
  source: string;
}>;

/**
 * Purity and non-execution checks, kept separate from the import graph so a
 * failure names the rule that was broken.
 */
export function findPolicyViolations(modules: readonly SourceModule[]): string[] {
  const violations: string[] = [];
  for (const { path: relative, source } of modules) {
    const layer = sourceLayer(relative);
    if (PURE_LAYERS.has(layer)) {
      for (const { pattern, label } of AMBIENT_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(`${relative} uses ${label} in a pure layer`);
        }
      }
    }
    if (NO_EXECUTION_LAYERS.has(layer)) {
      for (const { pattern, label } of EXECUTION_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(`${relative} references ${label} in a non-executing layer`);
        }
      }
    }
  }
  return violations;
}

export function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

function sourceLayer(relativePath: string): string {
  return relativePath.split(path.sep)[0] ?? "";
}

export function findBoundaryViolations(modules: readonly SourceModule[]): string[] {
  const violations: string[] = [];
  const graph = new Map<string, string[]>();
  const knownPaths = new Set(modules.map(({ path: modulePath }) => modulePath));

  for (const { path: relative, source } of modules) {
    const layer = sourceLayer(relative);
    const edges: string[] = [];

    for (const specifier of importedSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const target = path.normalize(path.join(path.dirname(relative), specifier));
        if (target.startsWith("..") || path.isAbsolute(target)) {
          violations.push(`${relative} imports outside the source root "${specifier}"`);
          continue;
        }
        const resolved = SOURCE_EXTENSIONS.has(path.extname(target))
          ? target
          : [...SOURCE_EXTENSIONS]
              .map((extension) => `${target}${extension}`)
              .find((candidate) => knownPaths.has(candidate));
        if (resolved !== undefined) edges.push(resolved);

        const targetLayer = sourceLayer(target);
        if (FORBIDDEN_TARGET_LAYERS[layer]?.includes(targetLayer)) {
          violations.push(`${relative} imports forbidden "${specifier}"`);
        }
      } else {
        if (FORBIDDEN_NODE_LAYERS.has(layer) && specifier.startsWith("node:")) {
          violations.push(`${relative} imports runtime module "${specifier}"`);
        }
      }
    }
    graph.set(relative, edges);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(node: string, stack: string[]): void {
    if (visiting.has(node)) {
      violations.push(`dependency cycle: ${[...stack, node].join(" -> ")}`);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const target of graph.get(node) ?? []) visit(target, [...stack, node]);
    visiting.delete(node);
    visited.add(node);
  }

  for (const file of graph.keys()) visit(file, []);
  return violations;
}

export async function listSourceModules(root: string): Promise<SourceModule[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const modules = await Promise.all(
    entries.map(async (entry): Promise<SourceModule[]> => {
      const absolute = path.join(root, entry.name);
      if (entry.isDirectory()) return listSourceModules(absolute);
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) return [];
      return [
        {
          path: path.relative(path.resolve("src"), absolute),
          source: await readFile(absolute, "utf8"),
        },
      ];
    }),
  );
  return modules.flat();
}
