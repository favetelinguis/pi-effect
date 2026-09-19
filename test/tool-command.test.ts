import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { registerToolCommand } from "../src/commands/tool.ts";
import { EffectCatalog } from "../src/tools/define.ts";

type RegisteredCommand = {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
};

function makeHarness() {
  const commands = new Map<string, RegisteredCommand>();
  const pi = {
    registerCommand: (name: string, opts: never) => {
      commands.set(name, opts as never);
    },
  } as unknown as ExtensionAPI;

  const catalog = new EffectCatalog();
  catalog.register({ name: "read", label: "read", description: "read", effects: [{ id: "fs.read" }], pure: true, group: "fs", defaultEnabled: true });
  catalog.register({
    name: "git_push",
    label: "git push",
    description: "push",
    effects: [{ id: "git.write", scope: "remote" }],
    pure: false,
    group: "git",
    defaultEnabled: false,
  });

  const notes: Array<{ type: string; msg: string }> = [];
  const ctx = {
    mode: "print",
    ui: { notify: (msg: string, type: string = "info") => notes.push({ type, msg }) },
  } as unknown as ExtensionCommandContext;

  registerToolCommand(pi, { catalog, applyActiveTools: () => {}, persistToolState: () => {} });

  async function run(args: string): Promise<void> {
    const cmd = commands.get("tool");
    if (!cmd) throw new Error("tool command not registered");
    await cmd.handler(args, ctx);
  }

  function complete(argumentText: string): AutocompleteItem[] {
    const cmd = commands.get("tool");
    if (!cmd?.getArgumentCompletions) throw new Error("tool command has no getArgumentCompletions");
    return cmd.getArgumentCompletions(argumentText) ?? [];
  }

  return { catalog, notes, run, complete };
}

describe("/tool argument completion (regression: accepting a suggestion must not drop the subcommand)", () => {
  // pi replaces the ENTIRE argument text after "/tool " with the chosen
  // item's value. A completion value of just "git_push" would turn
  // "/tool on git_push" into "/tool git_push" on accept.

  test("subcommand-level completions only replace the subcommand token", () => {
    const { complete } = makeHarness();
    const items = complete("o");
    const values = items.map((i) => i.value);
    assert.ok(values.includes("on") && values.includes("off"));
  });

  test("'on <name>' completions reconstruct the full 'on <name>' string", () => {
    const { complete } = makeHarness();
    const items = complete("on git_pu");
    assert.ok(items.length > 0);
    assert.equal(items[0]?.value, "on git_push");
  });

  test("'off <name>' completions reconstruct 'off <name>', not a bare name", () => {
    const { complete } = makeHarness();
    const items = complete("off git_pu");
    assert.equal(items[0]?.value, "off git_push");
  });

  test("'info <name>' completions reconstruct 'info <name>'", () => {
    const { complete } = makeHarness();
    const items = complete("info re");
    assert.equal(items[0]?.value, "info read");
  });

  test("'list' takes no argument completions", () => {
    const { complete } = makeHarness();
    assert.deepEqual(complete("list "), []);
  });
});

describe("/tool on|off", () => {
  test("on/off toggles catalog enablement", async () => {
    const { catalog, run } = makeHarness();
    assert.equal(catalog.isEnabled("git_push"), false);
    await run("on git_push");
    assert.equal(catalog.isEnabled("git_push"), true);
    await run("off git_push");
    assert.equal(catalog.isEnabled("git_push"), false);
  });
});
