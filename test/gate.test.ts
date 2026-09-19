import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decide, type DecideInput } from "../src/effects/gate.ts";
import type { EffectToolEntry } from "../src/tools/define.ts";

const readEntry: EffectToolEntry = {
  name: "read",
  label: "read",
  description: "read",
  effects: [{ id: "fs.read" }],
  pure: true,
  group: "fs",
  defaultEnabled: true,
};

const editEntry: EffectToolEntry = {
  name: "edit",
  label: "edit",
  description: "edit",
  effects: [{ id: "fs.write" }, { id: "fs.read" }],
  effectsFor: (params: unknown) => [{ id: "fs.write", scope: (params as { path: string }).path }],
  pure: false,
  group: "fs",
  defaultEnabled: true,
};

function baseInput(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    toolName: "read",
    entry: readEntry,
    isEnabled: true,
    required: readEntry.effects,
    deniedBy: () => [],
    covers: () => true,
    hasUI: true,
    unknownToolsPolicy: "warn",
    ...overrides,
  };
}

describe("decide", () => {
  test("bash is always blocked, even if somehow classified", () => {
    const result = decide(baseInput({ toolName: "bash", entry: undefined }));
    assert.equal(result.kind, "block");
  });

  test("powershell is always blocked", () => {
    const result = decide(baseInput({ toolName: "powershell", entry: undefined }));
    assert.equal(result.kind, "block");
  });

  test("unknown tool with policy allow passes through", () => {
    const result = decide(baseInput({ toolName: "mystery", entry: undefined, unknownToolsPolicy: "allow" }));
    assert.equal(result.kind, "allow");
  });

  test("unknown tool with policy warn passes through (warning is the adapter's job)", () => {
    const result = decide(baseInput({ toolName: "mystery", entry: undefined, unknownToolsPolicy: "warn" }));
    assert.equal(result.kind, "allow");
  });

  test("unknown tool with policy block is blocked", () => {
    const result = decide(baseInput({ toolName: "mystery", entry: undefined, unknownToolsPolicy: "block" }));
    assert.equal(result.kind, "block");
  });

  test("disabled tool is blocked regardless of grants", () => {
    const result = decide(baseInput({ isEnabled: false, covers: () => true }));
    assert.equal(result.kind, "block");
  });

  test("denied effect blocks even if covered by a grant", () => {
    const result = decide(baseInput({ deniedBy: () => [{ id: "fs.read" }], covers: () => true }));
    assert.equal(result.kind, "block");
    if (result.kind === "block") assert.match(result.reason, /denied by policy/);
  });

  test("fully covered required effects allow", () => {
    const result = decide(baseInput({ covers: () => true }));
    assert.equal(result.kind, "allow");
  });

  test("missing effect with no UI blocks with an actionable message", () => {
    const result = decide(baseInput({ covers: () => false, hasUI: false }));
    assert.equal(result.kind, "block");
    if (result.kind === "block") assert.match(result.reason, /request_effects|--grant/);
  });

  test("missing effect with UI available prompts, listing missing effects", () => {
    const result = decide(
      baseInput({
        toolName: "edit",
        entry: editEntry,
        required: [{ id: "fs.write", scope: "src/x.ts" }],
        covers: () => false,
        hasUI: true,
      }),
    );
    assert.equal(result.kind, "prompt");
    if (result.kind === "prompt") {
      assert.deepEqual(result.missing, [{ id: "fs.write", scope: "src/x.ts" }]);
      assert.equal(result.entry.name, "edit");
    }
  });

  test("partially covered effects only list the missing ones in the prompt", () => {
    const result = decide(
      baseInput({
        toolName: "edit",
        entry: editEntry,
        required: [{ id: "fs.write", scope: "src/x.ts" }, { id: "fs.read", scope: "src/x.ts" }],
        covers: (e) => e.id === "fs.read",
        hasUI: true,
      }),
    );
    assert.equal(result.kind, "prompt");
    if (result.kind === "prompt") {
      assert.deepEqual(result.missing, [{ id: "fs.write", scope: "src/x.ts" }]);
    }
  });
});
