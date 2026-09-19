import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerToolCommand } from "../src/commands/tool.ts";
import { registerEffectsCommand } from "../src/commands/effects.ts";
import { registerRequestEffectsTool } from "../src/tools/request-effects.ts";
import { EffectCatalog } from "../src/tools/define.ts";
import { GrantStore } from "../src/effects/grants.ts";
import { Policy } from "../src/effects/policy.ts";

/**
 * Regression for a real crash report:
 *
 *   Error: Rendered line 21 exceeds terminal width (95 > 89).
 *   This is likely caused by a custom TUI component not truncating its output.
 *
 * Root cause: our /tool, /effects, and request_effects dialogs each had a
 * hand-written header Component whose render(width) ignored `width` entirely.
 * Symbols like ⚡/○ are double-width in visibleWidth()'s East Asian Width
 * accounting, so the header hint text measured 86-105 columns wide -- wider
 * than an 89-column terminal, crashing the whole process on render.
 *
 * These tests capture the real Component each dialog hands to ctx.ui.custom()
 * (not just the shared makeHeader() helper) and render it at the exact
 * reported width, so a future hand-written Component that bypasses
 * makeHeader() fails here instead of crashing a user's terminal.
 */

// Minimal theme stand-in. Real ANSI codes only add invisible bytes that
// visibleWidth() already strips, so plain pass-through is a valid (and
// simpler) test of true visible character count.
const fakeTheme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  cursor: ">",
} as never;

function assertAllLinesFit(lines: string[], width: number, label: string) {
  for (const [i, line] of lines.entries()) {
    assert.ok(
      visibleWidth(line) <= width,
      `${label}: line ${i} is ${visibleWidth(line)} columns wide, exceeds requested width ${width}\nline: ${JSON.stringify(line)}`,
    );
  }
}

const CRASH_WIDTH = 89; // the exact width from the bug report
// Also check a much narrower width so a dialog whose header happens to be
// shorter than 89 columns (and so wouldn't have crashed at exactly 89) still
// gets genuine truncation exercised, instead of trivially passing.
const TEST_WIDTHS = [40, CRASH_WIDTH];

describe("dialog width safety (regression: 'Rendered line N exceeds terminal width')", () => {
  // getSettingsListTheme() (used by /tool, /effects, request_effects dialogs)
  // reads the process-wide theme singleton, which must be initialized once.
  before(() => {
    initTheme();
  });

  test("/tool dialog header + list fit within an 89-column terminal", async () => {
    const catalog = new EffectCatalog();
    for (let i = 0; i < 20; i++) {
      catalog.register({
        name: `tool_${i}`,
        label: `tool_${i}`,
        description: "d",
        effects: [{ id: "fs.read" }],
        pure: true,
        group: "fs",
        defaultEnabled: true,
      });
    }

    const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
    const pi = { registerCommand: (name: string, opts: never) => commands.set(name, opts as never) } as unknown as ExtensionAPI;
    registerToolCommand(pi, { catalog, applyActiveTools: () => {}, persistToolState: () => {} });

    let allLines: string[] = [];
    const ctx = {
      mode: "tui",
      ui: {
        async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown) {
          const component = (await factory({}, fakeTheme, {}, () => {})) as { render(w: number): string[] };
          for (const width of TEST_WIDTHS) {
            allLines = component.render(width);
            assertAllLinesFit(allLines, width, `/tool @ width ${width}`);
          }
          return undefined;
        },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("tool")!.handler("", ctx);
    assert.ok(allLines.length > 0);
  });

  test("/effects dialog header + list fit within an 89-column terminal, even with long scoped grants", async () => {
    const grants = new GrantStore();
    grants.add({
      id: "fs.write",
      scope: "/home/user/some/deeply/nested/project/directory/structure/src/index.ts",
      ttl: "session",
      source: "jit",
      grantedAt: Date.now(),
    });

    const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
    const pi = { registerCommand: (name: string, opts: never) => commands.set(name, opts as never) } as unknown as ExtensionAPI;
    registerEffectsCommand(pi, {
      grants,
      policy: new Policy(),
      auditPath: "/tmp/pi-effect-dialog-width-test.jsonl",
      persistGrant: () => {},
      persistRevoke: () => {},
      updateStatus: () => {},
    });

    let allLines: string[] = [];
    const ctx = {
      mode: "tui",
      ui: {
        async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown) {
          const component = (await factory({}, fakeTheme, {}, () => {})) as { render(w: number): string[] };
          for (const width of TEST_WIDTHS) {
            allLines = component.render(width);
            assertAllLinesFit(allLines, width, `/effects @ width ${width}`);
          }
          return undefined;
        },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("effects")!.handler("", ctx);
    assert.ok(allLines.length > 0);
  });

  test("request_effects checklist header + items fit within an 89-column terminal", async () => {
    type ExecuteFn = (toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
    const registry = new Map<string, { execute: ExecuteFn }>();
    const pi = { registerTool: (def: never) => registry.set((def as { name: string }).name, def as unknown as { execute: ExecuteFn }) } as unknown as ExtensionAPI;
    const catalog = new EffectCatalog();
    const grants = new GrantStore();
    registerRequestEffectsTool(pi, { catalog, grants, policy: new Policy(), onGrant: () => {} });

    let allLines: string[] = [];
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown) {
          const component = (await factory({}, fakeTheme, {}, () => {})) as { render(w: number): string[] };
          for (const width of TEST_WIDTHS) {
            allLines = component.render(width);
            assertAllLinesFit(allLines, width, `request_effects @ width ${width}`);
          }
          return true; // pretend the user confirmed, so execute() completes
        },
      },
    } as unknown as ExtensionContext;

    const requestEffects = registry.get("request_effects")!;
    await requestEffects.execute(
      "tc-1",
      {
        effects: [
          { id: "fs.write", scope: "/home/user/very/long/path/to/some/file/that/is/quite/deep.ts", reason: "test" },
          { id: "git.write", scope: "local", reason: "test" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    assert.ok(allLines.length > 0);
    assertAllLinesFit(allLines, CRASH_WIDTH, "request_effects");
  });
});
