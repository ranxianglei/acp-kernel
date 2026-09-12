import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { sanitizePackSurface } from "./sanitize.js";
import {
  isValidPackName,
  type Pack,
  type PackSource,
  type PromptPackFile,
} from "./types.js";

function readPackFile(file: string): PromptPackFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as PromptPackFile)
      : null;
  } catch {
    return null;
  }
}

/**
 * A pack directory source: `<dir>/<name>.json` files. One factory serves any
 * directory origin (project-local, user-global, installer-managed); the caller
 * decides which directories exist and their priority order. The filename (not
 * a `name` field inside the file) is authoritative for the pack name, so
 * every listed pack is resolvable by its listed name. Trust boundary: a
 * project-local dir lets whoever controls that repo ship surface overrides to
 * its consumers (inherent to the feature, like `.editorconfig`); content is
 * still sanitized before use. `resolve` reads from disk on every call — hosts
 * should resolve once per session and cache.
 */
export function createDirPackSource(id: string, dir: string): PackSource {
  const resolve = (name: string): Pack | null => {
    if (!isValidPackName(name)) return null;
    const file = path.join(dir, `${name}.json`);
    const raw = readPackFile(file);
    if (!raw) return null;
    return {
      name,
      version: typeof raw.version === "string" ? raw.version : undefined,
      description:
        typeof raw.description === "string" ? raw.description : undefined,
      surface: sanitizePackSurface(raw),
      source: `file:${file}`,
    };
  };
  return {
    id,
    resolve,
    list(): Pack[] {
      let names: string[];
      try {
        names = readdirSync(dir).filter((f) => f.endsWith(".json"));
      } catch {
        return [];
      }
      const out: Pack[] = [];
      for (const file of names) {
        const pack = resolve(file.slice(0, -5));
        if (pack) out.push(pack);
      }
      return out;
    },
  };
}
