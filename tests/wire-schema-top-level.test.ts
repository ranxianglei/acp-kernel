import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACP_TOOLS_ANTHROPIC,
  ACP_TOOLS_OPENAI,
  ACP_TOOLS_RESPONSES,
  ACP_READONLY_TOOLS_RESPONSES,
  ACP_TOOLS_GOOGLE,
  ABSORB_TOOL,
  ABSORB_TOOL_OPENAI,
  ABSORB_TOOL_GOOGLE,
  IMAGE_FULL_TOOL,
  IMAGE_FULL_TOOL_OPENAI,
  IMAGE_FULL_TOOL_RESPONSES,
  RETRIEVE_TOOL,
  RETRIEVE_TOOL_OPENAI,
  RETRIEVE_TOOL_RESPONSES,
} from "../src/compress-tools.js";

/**
 * Wire-legality contract (bili #1299): no tool schema may carry a TOP-LEVEL
 * combinator. Anthropic rejects `tools[].input_schema` containing
 * `oneOf`/`allOf`/`anyOf` at the top level with a 400 on every request that
 * carries the tool — one top-level anyOf in COMPRESS_PARAMETERS took down the
 * whole Claude lane of billion-context 0.1.148. Nested combinators (under a
 * property or items) are legal on every wire and stay allowed.
 *
 * This walks every exported wire shape so a future schema change fails HERE
 * instead of in production traffic.
 */

const COMBINATORS = ["oneOf", "allOf", "anyOf", "not"] as const;

type ToolLike = { name?: string };

function schemaOf(tool: ToolLike & Record<string, unknown>, shape: string): Record<string, unknown> {
  if (shape === "anthropic") return tool.input_schema as Record<string, unknown>;
  if (shape === "google") return tool.parameters as Record<string, unknown>;
  const fn = tool.function as { parameters?: Record<string, unknown> } | undefined;
  return (tool.parameters as Record<string, unknown> | undefined) ?? fn?.parameters ?? {};
}

function assertPlainTopLevel(tool: ToolLike & Record<string, unknown>, shape: string): void {
  const schema = schemaOf(tool, shape);
  assert.ok(schema && typeof schema === "object", `${tool.name}: ${shape} schema missing`);
  for (const key of COMBINATORS) {
    assert.ok(
      schema[key] === undefined,
      `${tool.name}: top-level ${shape} schema must not carry "${key}" (Anthropic 400, bili #1299)`,
    );
  }
}

function walk(list: readonly (ToolLike & Record<string, unknown>)[], shape: string): void {
  for (const tool of list) assertPlainTopLevel(tool, shape);
}

test("anthropic input_schema: no top-level combinators on any tool", () => {
  walk(ACP_TOOLS_ANTHROPIC, "anthropic");
  assertPlainTopLevel(ABSORB_TOOL as Record<string, unknown>, "anthropic");
  assertPlainTopLevel(IMAGE_FULL_TOOL as Record<string, unknown>, "anthropic");
  assertPlainTopLevel(RETRIEVE_TOOL as Record<string, unknown>, "anthropic");
});

test("openai function.parameters: no top-level combinators on any tool", () => {
  walk(ACP_TOOLS_OPENAI, "openai");
  assertPlainTopLevel(ABSORB_TOOL_OPENAI as Record<string, unknown>, "openai");
  assertPlainTopLevel(IMAGE_FULL_TOOL_OPENAI as Record<string, unknown>, "openai");
  assertPlainTopLevel(RETRIEVE_TOOL_OPENAI as Record<string, unknown>, "openai");
});

test("responses flat parameters: no top-level combinators on any tool", () => {
  walk(ACP_TOOLS_RESPONSES, "responses");
  walk(ACP_READONLY_TOOLS_RESPONSES, "responses");
  assertPlainTopLevel(IMAGE_FULL_TOOL_RESPONSES as Record<string, unknown>, "responses");
  assertPlainTopLevel(RETRIEVE_TOOL_RESPONSES as Record<string, unknown>, "responses");
});

test("google functionDeclarations parameters: no top-level combinators on any tool", () => {
  walk(ACP_TOOLS_GOOGLE, "google");
  assertPlainTopLevel(ABSORB_TOOL_GOOGLE as Record<string, unknown>, "google");
});

test("nested combinators remain allowed (items.anyOf stays legal on every wire)", () => {
  // The line-form/object-form alternation inside content.items is nested —
  // legal everywhere. This pins the boundary: combinator-freedom is a TOP
  // LEVEL requirement only.
  const params = ACP_TOOLS_OPENAI[0].function.parameters as {
    properties: { content: { items?: { anyOf?: unknown[] } } };
  };
  assert.ok(Array.isArray(params.properties.content.items?.anyOf));
});
