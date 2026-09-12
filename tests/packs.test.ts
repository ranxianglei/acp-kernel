import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  applyAcpToolOverrides,
  buildCompressSystemPrompt,
  ACP_TOOLS_OPENAI,
  type Pack,
  type PackSource,
} from "../src/index.js";

test("isValidPackName accepts simple names, rejects traversal", () => {
  assert.equal(isValidPackName("lean"), true);
  assert.equal(isValidPackName("team-pack.v2"), true);
  assert.equal(isValidPackName("../etc"), false);
  assert.equal(isValidPackName(""), false);
  assert.equal(isValidPackName("-x"), false);
});

test("sanitizePackSurface keeps known keys, drops malformed", () => {
  const s = sanitizePackSurface({
    prompts: { compressPhilosophy: "p", howToCompressRules: 42 },
    promptSections: { acpTags: "tags", tools: null, summariesInContext: 7 },
    nudgeSections: { efficiencyNote: "e", t2Guidance: null, bogus: "x" },
    toolPrompts: {
      compress: { description: "d", paramDescriptions: { content: "c", startId: 3 } },
      search_context: { description: null },
    },
    adapters: { pi: { any: "thing" } },
  });
  assert.deepEqual(s.prompts, { compressPhilosophy: "p" });
  assert.deepEqual(s.promptSections, { acpTags: "tags", tools: null });
  assert.deepEqual(s.nudgeSections, { efficiencyNote: "e", t2Guidance: null });
  assert.deepEqual(s.toolPrompts, { compress: { description: "d", paramDescriptions: { content: "c" } } });
  assert.deepEqual(s.adapters, { pi: { any: "thing" } });
});

test("sanitizePackSurface on null/garbage returns empty surface", () => {
  assert.deepEqual(sanitizePackSurface(null), {});
  assert.deepEqual(sanitizePackSurface({ prompts: "nope", adapters: [1] }), { prompts: {}, promptSections: {}, nudgeSections: {}, toolPrompts: {} });
});

test("builtin registry resolves default and lean; unknown misses", () => {
  assert.equal(builtinSource.resolve("default"), defaultPack);
  assert.equal(builtinSource.resolve("lean"), leanPack);
  assert.equal(builtinSource.resolve("nope"), null);
  const names = builtinSource.list().map((p) => p.name).sort();
  assert.deepEqual(names, ["default", "lean"]);
});

test("default pack has empty surface", () => {
  assert.deepEqual(defaultPack.surface, {});
});

test("lean pack keeps rules default, one-line tool descriptions, adapters namespace", () => {
  assert.deepEqual(leanPack.surface.prompts ?? {}, {});
  assert.equal(leanPack.surface.toolPrompts?.compress?.description, "Replace consumed conversation ranges with self-contained summaries using mNNNNN or bN refs.");
  assert.ok(leanPack.surface.adapters && typeof leanPack.surface.adapters === "object");
  assert.equal(Object.keys(leanPack.surface.adapters).length, 1);
});

test("dir source resolves and lists json packs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-packs-"));
  try {
    writeFileSync(
      path.join(dir, "team.json"),
      JSON.stringify({ name: "team", version: "2.0", description: "d", toolPrompts: { compress: { description: "T" } } }),
    );
    writeFileSync(path.join(dir, "broken.json"), "not json");
    const src = createDirPackSource("project", dir);
    const pack = src.resolve("team");
    assert.equal(pack?.source, `file:${path.join(dir, "team.json")}`);
    assert.equal(pack?.version, "2.0");
    assert.equal(pack?.surface.toolPrompts?.compress?.description, "T");
    assert.equal(src.resolve("broken"), null);
    assert.equal(src.resolve("../escape"), null);
    const names = src.list().map((p) => p.name);
    assert.deepEqual(names, ["team"]);
    const { list: listDetached } = src;
    assert.deepEqual(listDetached().map((p) => p.name), ["team"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dir source: filename is the pack identity — internal name mismatch is ignored", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-packs-id-"));
  try {
    writeFileSync(path.join(dir, "team.json"), JSON.stringify({ name: "other", toolPrompts: { compress: { description: "T" } } }));
    const src = createDirPackSource("project", dir);
    const pack = src.resolve("team");
    assert.equal(pack?.name, "team");
    assert.equal(pack?.surface.toolPrompts?.compress?.description, "T");
    assert.equal(src.resolve("other"), null, "content-side name is not a resolution key");
    assert.deepEqual(src.list().map((p) => p.name), ["team"], "list() reports the filename too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dir source on missing directory yields empty list and no resolve", () => {
  const src = createDirPackSource("user", path.join(tmpdir(), "acp-no-such-dir"));
  assert.equal(src.resolve("lean"), null);
  assert.deepEqual(src.list(), []);
});

test("resolver consults sources in order; first hit wins", () => {
  const a: PackSource = {
    id: "a",
    resolve: (name) => (name === "x" ? { name: "x", surface: {}, source: "a" } : null),
  };
  const b: PackSource = {
    id: "b",
    resolve: (name) => (name === "x" || name === "y" ? { name, surface: {}, source: "b" } : null),
    list: () => [{ name: "x", surface: {}, source: "b" }, { name: "z", surface: {}, source: "b" }],
  };
  const r = createPackResolver([a, b, builtinSource]);
  assert.equal(r.resolve("x")?.source, "a");
  assert.equal(r.resolve("y")?.source, "b");
  assert.equal(r.resolve("lean")?.name, "lean");
  assert.equal(r.resolve("../bad"), null);
  assert.deepEqual(r.listPacks().map((p) => `${p.name}:${p.source}`), ["x:b", "z:b", "default:builtin:default", "lean:builtin:lean"]);
});

test("custom source can shadow builtin lean", () => {
  const custom: PackSource = {
    id: "managed",
    resolve: (name) => (name === "lean" ? { name: "lean", surface: { toolPrompts: { acp_status: { description: "custom" } } }, source: "managed:lean" } : null),
  };
  const r = createPackResolver([custom, builtinSource]);
  assert.equal(r.resolve("lean")?.surface.toolPrompts?.acp_status?.description, "custom");
});

test("defaultPackSources orders project, user, builtin", () => {
  const sources = defaultPackSources({ projectDir: "/p", userDirs: ["/u1", "/u2"] });
  assert.deepEqual(sources.map((s) => s.id), ["project", "user", "user", "builtin"]);
});

test("lean surface applies to wire tools via applyAcpToolOverrides", () => {
  const tools = applyAcpToolOverrides(ACP_TOOLS_OPENAI, leanPack.surface.toolPrompts);
  const compress = tools.find((t) => t.function.name === "compress");
  assert.ok(compress);
  assert.equal(compress.function.description, leanPack.surface.toolPrompts?.compress?.description);
  const params = compress.function.parameters as { properties: { content: { items: { properties: Record<string, { description?: string }> } } } };
  assert.equal(params.properties.content.items.properties.startId.description, "Inclusive first mNNNNN or bN ref.");
});

test("pack promptSections flow into buildCompressSystemPrompt", () => {
  const pack: Pack = { name: "quiet", surface: { promptSections: { summariesInContext: null, tools: "TOOLS-OVERRIDE" } }, source: "test" };
  const text = buildCompressSystemPrompt(undefined, pack.surface.promptSections);
  assert.ok(text.includes("TOOLS-OVERRIDE"));
  assert.ok(!text.includes("COMPRESSION SUMMARIES IN CONTEXT"));
});

test("file pack round-trips through dir source into resolver", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-packs-rt-"));
  const sub = path.join(dir, "nested");
  mkdirSync(sub, { recursive: true });
  try {
    writeFileSync(
      path.join(sub, "rt.json"),
      JSON.stringify({ promptSections: { acpTags: "RT" }, adapters: { pi: { delegatePrompt: "D" } } }),
    );
    const r = createPackResolver(defaultPackSources({ projectDir: sub }));
    const pack = r.resolve("rt");
    assert.equal(pack?.surface.promptSections?.acpTags, "RT");
    assert.deepEqual(pack?.surface.adapters, { pi: { delegatePrompt: "D" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
