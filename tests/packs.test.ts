import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  isValidPackName,
  sanitizePackSurface,
  defaultPack,
  leanPack,
  builtinSource,
  createDirPackSource,
  createPackResolver,
  defaultPackSources,
  buildCompressSystemPrompt,
  buildCompressTextSystemPrompt,
  buildCompressHybridSystemPrompt,
  applyAcpToolOverrides,
  ACP_TOOLS_ANTHROPIC,
  ACP_TOOLS_OPENAI,
  ACP_TOOLS_RESPONSES,
  ACP_TOOL_NAMES,
  defaultPrompts,
} from "../src/index.js";
import type { PackSource } from "../src/index.js";

test("isValidPackName accepts safe names", () => {
  for (const name of ["lean", "default", "my-pack", "v1.2", "A.b_c-d"]) {
    assert.equal(isValidPackName(name), true, name);
  }
});

test("isValidPackName rejects traversal and malformed names", () => {
  assert.equal(isValidPackName(""), false);
  assert.equal(isValidPackName("-x"), false);
  assert.equal(isValidPackName(".hidden"), false);
  assert.equal(isValidPackName(".."), false);
  assert.equal(isValidPackName("../x"), false);
  assert.equal(isValidPackName("a b"), false);
  assert.equal(isValidPackName("a/b"), false);
});

test("sanitizePackSurface drops non-objects and unknown keys", () => {
  assert.deepEqual(sanitizePackSurface(null), {});
  assert.deepEqual(sanitizePackSurface(undefined), {});
  assert.deepEqual(sanitizePackSurface({ bogus: 1 }), {});
});

test("sanitizePackSurface narrows typed sections and drops wrong types", () => {
  const surface = sanitizePackSurface({
    prompts: { compressPhilosophy: "P", howToCompressRules: 42 },
    promptSections: { acpTags: "TAG", tools: null, bogus: 1 },
    nudgeSections: { efficiencyNote: "E", t2Guidance: [1] },
    toolPrompts: {
      compress: {
        description: "d",
        paramDescriptions: { content: "c", other: 7 },
      },
      decompress: { description: 9 },
    },
    adapters: { pi: { snippet: "s" } },
  });
  assert.deepEqual(surface.prompts, { compressPhilosophy: "P" });
  assert.deepEqual(surface.promptSections, { acpTags: "TAG", tools: null });
  assert.deepEqual(surface.nudgeSections, { efficiencyNote: "E" });
  assert.deepEqual(surface.toolPrompts, {
    compress: { description: "d", paramDescriptions: { content: "c" } },
  });
  assert.deepEqual(surface.adapters, { pi: { snippet: "s" } });
});

test("sanitizePackSurface treats adapters opaquely and copies them", () => {
  const input = { adapters: { pi: { deep: 1 } } };
  const surface = sanitizePackSurface(input);
  assert.ok(surface.adapters);
  (surface.adapters as Record<string, unknown>).pi = "mutated";
  assert.deepEqual(input.adapters, { pi: { deep: 1 } });
  assert.equal(sanitizePackSurface({ adapters: [1] }).adapters, undefined);
});

test("builtin registry resolves default and lean", () => {
  assert.equal(builtinSource.resolve("default"), defaultPack);
  const lean = builtinSource.resolve("lean");
  assert.ok(lean);
  assert.equal(lean.name, "lean");
  assert.equal(lean.source, "builtin:lean");
  assert.equal(builtinSource.resolve("nope"), null);
  assert.deepEqual(
    builtinSource
      .list?.()
      .map((p) => p.name)
      .sort(),
    ["default", "lean"],
  );
});

test("lean toolPrompts cover every ACP tool", () => {
  const toolPrompts = leanPack.surface.toolPrompts;
  assert.ok(toolPrompts);
  for (const name of ACP_TOOL_NAMES) {
    assert.ok(toolPrompts[name], `missing override for ${name}`);
    assert.ok(
      typeof toolPrompts[name]?.description === "string" &&
        toolPrompts[name]?.description.length < 200,
    );
  }
});

test("lean acpTags section applies through all three builders", () => {
  const sections = leanPack.surface.promptSections;
  assert.ok(sections);
  const marker = "use only refs in ACP tool calls";
  for (const prompt of [
    buildCompressSystemPrompt(defaultPrompts, sections),
    buildCompressTextSystemPrompt(defaultPrompts, sections),
    buildCompressHybridSystemPrompt(defaultPrompts, sections),
  ]) {
    assert.ok(prompt.includes(marker), "lean acpTags line present");
    assert.ok(prompt.includes(defaultPrompts.compressPhilosophy));
    assert.ok(prompt.includes(defaultPrompts.howToCompressRules));
  }
  assert.notEqual(
    buildCompressSystemPrompt(),
    buildCompressSystemPrompt(defaultPrompts, sections),
  );
});

test("applyAcpToolOverrides replaces descriptions without mutating originals", () => {
  const overrides = leanPack.surface.toolPrompts;
  assert.ok(overrides);
  const originalDesc = ACP_TOOLS_ANTHROPIC[0].description;
  const out = applyAcpToolOverrides(ACP_TOOLS_ANTHROPIC, overrides);
  assert.notEqual(out[0], ACP_TOOLS_ANTHROPIC[0]);
  assert.equal(out[0].description, overrides["compress"]!.description);
  assert.equal(ACP_TOOLS_ANTHROPIC[0].description, originalDesc);
  const props = (
    out[0].input_schema as {
      properties: Record<string, { description?: string }>;
    }
  ).properties;
  assert.equal(
    props.content.description,
    overrides["compress"]!.paramDescriptions?.content,
  );
});

test("applyAcpToolOverrides passes non-matching tools through by reference", () => {
  const overrides = leanPack.surface.toolPrompts;
  const extra = { name: "not-an-acp-tool", description: "keep me" };
  const out = applyAcpToolOverrides(
    [...ACP_TOOLS_ANTHROPIC, extra] as typeof ACP_TOOLS_ANTHROPIC,
    overrides,
  );
  assert.equal(out[out.length - 1], extra);
});

test("applyAcpToolOverrides handles openai function shape", () => {
  const overrides = leanPack.surface.toolPrompts;
  const out = applyAcpToolOverrides(ACP_TOOLS_OPENAI, overrides!);
  const compress = out.find((t) => t.function?.name === "compress")!;
  assert.equal(compress.function.description, overrides!.compress!.description);
  const params = compress.function.parameters as {
    properties: Record<string, { description?: string }>;
  };
  assert.equal(
    params.properties.content.description,
    overrides!.compress!.paramDescriptions?.content,
  );
});

test("applyAcpToolOverrides handles responses flat shape", () => {
  const overrides = leanPack.surface.toolPrompts;
  const out = applyAcpToolOverrides(ACP_TOOLS_RESPONSES, overrides!);
  const decompress = out.find((t) => t.name === "decompress")!;
  assert.equal(decompress.description, overrides!.decompress!.description);
});

function memorySource(
  packs: Record<string, { name: string; surface?: unknown; source: string }>,
): PackSource {
  return {
    id: "memory",
    resolve(name) {
      const raw = packs[name];
      if (!raw) return null;
      return { ...raw, surface: sanitizePackSurface(raw.surface ?? {}) };
    },
    list() {
      return Object.values(packs).map((raw) => ({
        ...raw,
        surface: sanitizePackSurface(raw.surface ?? {}),
      }));
    },
  };
}

test("resolver uses first non-null source in order", () => {
  const first = memorySource({ custom: { name: "custom", source: "first" } });
  const second = memorySource({ custom: { name: "custom", source: "second" } });
  const resolver = createPackResolver([first, second, builtinSource]);
  assert.equal(resolver.resolve("custom")?.source, "first");
  assert.equal(resolver.resolve("lean")?.source, "builtin:lean");
  assert.equal(resolver.resolve("missing"), null);
});

test("resolver short-circuits invalid names before touching sources", () => {
  let calls = 0;
  const spy: PackSource = {
    id: "spy",
    resolve() {
      calls++;
      return null;
    },
    list() {
      return [];
    },
  };
  const resolver = createPackResolver([spy]);
  assert.equal(resolver.resolve("../x"), null);
  assert.equal(calls, 0);
});

test("listPacks dedupes by name with first-wins priority", () => {
  const first = memorySource({ dup: { name: "dup", source: "first" } });
  const second = memorySource({
    dup: { name: "dup", source: "second" },
    extra: { name: "extra", source: "second" },
  });
  const packs = createPackResolver([first, second, builtinSource]).listPacks();
  const dups = packs.filter((p) => p.name === "dup");
  assert.equal(dups.length, 1);
  assert.equal(dups[0].source, "first");
  assert.ok(packs.some((p) => p.name === "extra"));
  assert.ok(packs.some((p) => p.name === "lean"));
});

test("dir source roundtrips a pack file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acp-packs-"));
  try {
    writeFileSync(
      path.join(dir, "mypack.json"),
      JSON.stringify({
        name: "mypack",
        version: "0.1.0",
        description: "d",
        promptSections: { acpTags: "TAG" },
        adapters: { pi: 1 },
        bogus: true,
      }),
    );
    const src = createDirPackSource("project", dir);
    const pack = src.resolve("mypack");
    assert.ok(pack);
    assert.equal(pack.version, "0.1.0");
    assert.ok(pack.source.startsWith("file:"));
    assert.equal(pack.surface.promptSections?.acpTags, "TAG");
    assert.deepEqual(pack.surface.adapters, { pi: 1 });
    assert.equal("bogus" in (pack.surface as object), false);
    assert.deepEqual(
      src.list().map((p) => p.name),
      ["mypack"],
    );
    const { list } = src;
    assert.deepEqual(
      list().map((p) => p.name),
      ["mypack"],
    );
    assert.equal(src.resolve("missing"), null);
    assert.equal(src.resolve("../evil"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dir source makes the filename authoritative over the inner name field", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acp-packs-mismatch-"));
  try {
    writeFileSync(
      path.join(dir, "lean.json"),
      JSON.stringify({ name: "custom", promptSections: { acpTags: "T" } }),
    );
    const src = createDirPackSource("project", dir);
    const pack = src.resolve("lean");
    assert.ok(pack);
    assert.equal(pack.name, "lean");
    assert.deepEqual(
      src.list().map((p) => p.name),
      ["lean"],
    );
    assert.ok(
      src.resolve("custom") === null ||
        src.resolve("custom")?.name === "custom",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dir source tolerates missing dir, malformed json, and non-object files", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acp-packs-bad-"));
  try {
    writeFileSync(path.join(dir, "bad.json"), "{not json");
    writeFileSync(path.join(dir, "prim.json"), JSON.stringify(["an", "array"]));
    const src = createDirPackSource("user0", dir);
    assert.equal(src.resolve("bad"), null);
    assert.equal(src.resolve("prim"), null);
    assert.deepEqual(src.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const ghost = createDirPackSource(
    "ghost",
    path.join(os.tmpdir(), "acp-packs-no-such-dir"),
  );
  assert.equal(ghost.resolve("lean"), null);
  assert.deepEqual(ghost.list(), []);
});

test("defaultPackSources builds project > user > builtin chain", () => {
  assert.deepEqual(
    defaultPackSources().map((s) => s.id),
    ["builtin"],
  );
  const sources = defaultPackSources({
    projectDir: "/tmp/p",
    userDirs: ["/tmp/u0", "/tmp/u1"],
  });
  assert.deepEqual(
    sources.map((s) => s.id),
    ["project", "user0", "user1", "builtin"],
  );
});

test("project pack shadows builtin lean end-to-end", () => {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "acp-packs-shadow-"));
  try {
    writeFileSync(
      path.join(projectDir, "lean.json"),
      JSON.stringify({ promptSections: { acpTags: "PROJECT LEAN" } }),
    );
    const resolver = createPackResolver(defaultPackSources({ projectDir }));
    const pack = resolver.resolve("lean");
    assert.ok(pack);
    assert.ok(pack.source.startsWith("file:"));
    assert.equal(pack.surface.promptSections?.acpTags, "PROJECT LEAN");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
