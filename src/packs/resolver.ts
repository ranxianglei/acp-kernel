import { builtinSource } from "./builtin.js";
import { createDirPackSource } from "./dir.js";
import { isValidPackName, type Pack, type PackSource } from "./types.js";

/**
 * Ordered pack resolution over pluggable sources. The first non-null wins;
 * `listPacks` dedupes by name with the same priority. Custom sources (e.g. an
 * installer-managed registry) can be prepended without touching core code.
 */
export interface PackResolver {
  readonly sources: readonly PackSource[];
  resolve(name: string): Pack | null;
  listPacks(): Pack[];
}

export function createPackResolver(
  sources: readonly PackSource[],
): PackResolver {
  return {
    sources,
    resolve(name: string): Pack | null {
      if (!isValidPackName(name)) return null;
      for (const source of sources) {
        const pack = source.resolve(name);
        if (pack) return pack;
      }
      return null;
    },
    listPacks(): Pack[] {
      const seen = new Set<string>();
      const out: Pack[] = [];
      for (const source of sources) {
        for (const pack of source.list?.() ?? []) {
          if (!seen.has(pack.name)) {
            seen.add(pack.name);
            out.push(pack);
          }
        }
      }
      return out;
    },
  };
}

export interface DefaultPackSourcesOptions {
  /** Project-local pack directory (host decides where that lives). */
  projectDir?: string;
  /** User-global pack directories, in priority order. */
  userDirs?: readonly string[];
}

/**
 * The default source chain: project dir > user dirs (in order) > builtins.
 * Directory paths are host policy — the kernel never derives them from cwd or
 * homedir. Omitting both yields builtins only.
 */
export function defaultPackSources(
  options: DefaultPackSourcesOptions = {},
): PackSource[] {
  const sources: PackSource[] = [];
  if (options.projectDir)
    sources.push(createDirPackSource("project", options.projectDir));
  let i = 0;
  for (const dir of options.userDirs ?? [])
    sources.push(createDirPackSource(`user${i++}`, dir));
  sources.push(builtinSource);
  return sources;
}
