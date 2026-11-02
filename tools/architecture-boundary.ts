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
  bootstrap: [],
};

export const FORBIDDEN_NODE_LAYERS = new Set(["contracts", "domain", "application", "ports"]);

export type SourceModule = Readonly<{
  path: string;
  source: string;
}>;

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
