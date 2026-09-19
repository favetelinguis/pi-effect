import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerRequestEffectsTool } from "../src/tools/request-effects.ts";
import { EffectCatalog } from "../src/tools/define.ts";
import { GrantStore } from "../src/effects/grants.ts";
import { Policy } from "../src/effects/policy.ts";

/**
 * request_effects only exists to gate write-mode effects. Read effects
 * (fs.read/git.read/net.read) never need a grant, so they must never show up
 * in the checklist and never require the user to answer anything for them --
 * they should just be reported back as "already allowed".
 */

type ExecuteFn = (toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{
  content: { type: string; text: string }[];
  details: { granted: string[]; denied: string[] };
}>;

function setup() {
  const registry = new Map<string, { execute: ExecuteFn }>();
  const pi = { registerTool: (def: never) => registry.set((def as { name: string }).name, def as unknown as { execute: ExecuteFn }) } as unknown as ExtensionAPI;
  const catalog = new EffectCatalog();
  const grants = new GrantStore();
  const policy = new Policy();
  const granted: unknown[] = [];
  registerRequestEffectsTool(pi, { catalog, grants, policy, onGrant: (g) => granted.push(g) });
  return { execute: registry.get("request_effects")!.execute, grants, granted };
}

describe("request_effects: read effects never need approval", () => {
  // getSettingsListTheme() (used to render the checklist) reads a process-wide
  // theme singleton that must be initialized once.
  before(() => {
    initTheme();
  });

  test("headless: read effects are reported as already-allowed, never denied, never granted", async () => {
    const { execute, grants, granted } = setup();
    const ctx = { hasUI: false } as unknown as ExtensionContext;

    const result = await execute(
      "tc-1",
      {
        effects: [
          { id: "fs.read", reason: "explore" },
          { id: "git.read", reason: "explore" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    assert.match(result.content[0].text, /Already allowed, no grant needed: fs\.read, git\.read/);
    assert.deepEqual(result.details.granted, []);
    assert.deepEqual(result.details.denied, []);
    // No grant should have been created for effects that never needed one.
    assert.equal(granted.length, 0);
    assert.equal(grants.list().length, 0);
  });

  test("headless: write effects still block with an actionable message; reads alongside them are unaffected", async () => {
    const { execute } = setup();
    const ctx = { hasUI: false } as unknown as ExtensionContext;

    const result = await execute(
      "tc-1",
      {
        effects: [
          { id: "fs.read", reason: "explore" },
          { id: "fs.write", scope: "src/x.ts", reason: "fix bug" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    assert.match(result.content[0].text, /Already allowed, no grant needed: fs\.read/);
    assert.match(result.content[0].text, /No UI available.*Denied: fs\.write:src\/x\.ts/s);
    assert.deepEqual(result.details.denied, ["fs.write:src/x.ts"]);
  });

  test("TUI: the checklist shown to the user only contains write effects, never read effects", async () => {
    const { execute, grants } = setup();
    let renderedText = "";
    const fakeTheme = { fg: (_n: string, t: string) => t, bold: (t: string) => t };
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown) {
          const component = (await factory({}, fakeTheme, {}, () => {})) as { render(w: number): string[] };
          renderedText = component.render(160).join("\n");
          // Simulate the user confirming without toggling anything: every item
          // that defaulted to "grant" stays granted.
          return true;
        },
      },
    } as unknown as ExtensionContext;

    const result = await execute(
      "tc-1",
      {
        effects: [
          { id: "fs.read", reason: "explore" },
          { id: "fs.write", scope: "src/x.ts", reason: "fix bug" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    assert.match(result.content[0].text, /Already allowed, no grant needed: fs\.read/);
    // Only the write effect should have been granted via the checklist's default "grant" value.
    assert.deepEqual(result.details.granted, ["fs.write:src/x.ts"]);
    assert.equal(grants.list().some((g) => g.id === "fs.read"), false);
    // The rendered checklist itself must never mention fs.read as an item -- only
    // the write effect should be offered to the user.
    assert.ok(renderedText.includes("fs.write"), `expected checklist to mention fs.write, got:\n${renderedText}`);
    assert.ok(!renderedText.includes("fs.read"), `expected checklist to NOT mention fs.read, got:\n${renderedText}`);
  });

  test("a read effect denied by policy is still reported as denied-by-policy, not as already-allowed", async () => {
    const registry = new Map<string, { execute: ExecuteFn }>();
    const pi = { registerTool: (def: never) => registry.set((def as { name: string }).name, def as unknown as { execute: ExecuteFn }) } as unknown as ExtensionAPI;
    const catalog = new EffectCatalog();
    const grants = new GrantStore();
    const policy = new Policy([{ id: "fs.read", scope: "**/.env*" }]);
    registerRequestEffectsTool(pi, { catalog, grants, policy, onGrant: () => {} });

    const ctx = { hasUI: false } as unknown as ExtensionContext;
    const result = await registry.get("request_effects")!.execute(
      "tc-1",
      { effects: [{ id: "fs.read", scope: ".env", reason: "peek" }] },
      undefined,
      undefined,
      ctx,
    );

    assert.match(result.content[0].text, /Denied by policy \(cannot be granted\): fs\.read:\.env/);
    assert.doesNotMatch(result.content[0].text, /Already allowed/);
  });
});
