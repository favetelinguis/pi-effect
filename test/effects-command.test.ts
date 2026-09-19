import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { registerEffectsCommand } from "../src/commands/effects.ts";
import { GrantStore } from "../src/effects/grants.ts";
import { Policy } from "../src/effects/policy.ts";
import type { Grant } from "../src/effects/model.ts";

type RegisteredCommand = {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
};

/**
 * Mirrors pi-tui's CombinedAutocompleteProvider.applyCompletion() for the
 * command-argument case: the full text after "/effects " is `prefix`, and
 * accepting `item` replaces that entire string with `item.value`. This lets
 * tests assert on the resulting argument string, not just item.value in
 * isolation — which is what actually caught the "revoke disappears" bug.
 */
function applyCompletion(item: AutocompleteItem): string {
  return item.value;
}

function makeHarness() {
  const commands = new Map<string, RegisteredCommand>();
  const pi = {
    registerCommand: (name: string, opts: never) => {
      commands.set(name, opts as never);
    },
  } as unknown as ExtensionAPI;

  const grants = new GrantStore();
  const policy = new Policy();
  const notes: Array<{ type: string; msg: string }> = [];
  const ctx = {
    mode: "print",
    hasUI: false,
    ui: { notify: (msg: string, type: string = "info") => notes.push({ type, msg }) },
  } as unknown as ExtensionCommandContext;

  registerEffectsCommand(pi, {
    grants,
    policy,
    auditPath: "/tmp/pi-effect-test-audit.jsonl",
    persistGrant: () => {},
    persistRevoke: () => {},
    updateStatus: () => {},
  });

  async function run(args: string): Promise<void> {
    const cmd = commands.get("effects");
    if (!cmd) throw new Error("effects command not registered");
    await cmd.handler(args, ctx);
  }

  function complete(argumentText: string): AutocompleteItem[] {
    const cmd = commands.get("effects");
    if (!cmd?.getArgumentCompletions) throw new Error("effects command has no getArgumentCompletions");
    return cmd.getArgumentCompletions(argumentText) ?? [];
  }

  return { grants, notes, run, complete };
}

function grant(partial: Partial<Grant> & Pick<Grant, "id">): Grant {
  return { ttl: "session", source: "jit", grantedAt: Date.now(), ...partial };
}

describe("/effects revoke argument parsing", () => {
  test("colon form matches the exact display string from /effects list", async () => {
    const { grants, run } = makeHarness();
    grants.add(grant({ id: "fs.write", scope: "/repo/.gitignore" }));
    await run("revoke fs.write:/repo/.gitignore");
    assert.equal(grants.covers({ id: "fs.write", scope: "/repo/.gitignore" }), false);
  });

  test("space form still works", async () => {
    const { grants, run } = makeHarness();
    grants.add(grant({ id: "fs.write", scope: "/repo/.gitignore" }));
    await run("revoke fs.write /repo/.gitignore");
    assert.equal(grants.covers({ id: "fs.write", scope: "/repo/.gitignore" }), false);
  });

  test("no scope removes every scope for that id", async () => {
    const { grants, run } = makeHarness();
    grants.add(grant({ id: "fs.write", scope: "/repo/.gitignore" }));
    grants.add(grant({ id: "fs.write", scope: "/repo/other.ts" }));
    await run("revoke fs.write");
    assert.equal(grants.list().length, 0);
  });

  test("unknown id reports a helpful usage message instead of silently no-op'ing", async () => {
    const { notes, run } = makeHarness();
    await run("revoke bogus.write");
    assert.ok(notes.some((n) => n.type === "warning" && /Usage: \/effects revoke/.test(n.msg)));
  });

  test("no match reports the exact-scope hint instead of a silent success", async () => {
    const { notes, run } = makeHarness();
    await run("revoke fs.write:/nope.ts");
    assert.ok(notes.some((n) => n.type === "warning" && /No matching grant/.test(n.msg)));
  });
});

describe("/effects grant argument parsing", () => {
  test("colon form grants with the parsed scope", async () => {
    const { grants, run } = makeHarness();
    await run("grant git.write:local");
    assert.equal(grants.covers({ id: "git.write", scope: "local" }), true);
    assert.equal(grants.covers({ id: "git.write", scope: "remote" }), false);
  });
});

describe("/effects list", () => {
  test("each grant line includes a copy-pasteable revoke command", async () => {
    const { grants, notes, run } = makeHarness();
    grants.add(grant({ id: "fs.write", scope: "/repo/.gitignore" }));
    await run("list");
    assert.ok(notes.some((n) => n.msg.includes("/effects revoke fs.write:/repo/.gitignore")));
  });
});

describe("/effects argument completion (regression: accepting a suggestion must not drop the subcommand)", () => {
  // pi replaces the ENTIRE argument text after "/effects " with the chosen
  // item's value (see pi-tui's CombinedAutocompleteProvider.applyCompletion).
  // A completion value of just "fs.write" would turn "/effects revoke fs.write"
  // into "/effects fs.write" on accept — losing "revoke" entirely.

  test("subcommand-level completions only replace the subcommand token", () => {
    const { complete } = makeHarness();
    const items = complete("rev");
    assert.ok(items.some((i) => i.value === "revoke"));
  });

  test("revoke completions include active scoped grants, in colon form, with 'revoke ' reconstructed", () => {
    const { grants, complete } = makeHarness();
    grants.add(grant({ id: "fs.write", scope: "/repo/.gitignore" }));

    const items = complete("revoke fs.write");
    const values = items.map((i) => i.value);

    assert.ok(values.includes("revoke fs.write:/repo/.gitignore"), `expected scoped grant in ${JSON.stringify(values)}`);
    assert.ok(values.includes("revoke fs.write"), `expected bare id in ${JSON.stringify(values)}`);

    // Simulate accepting the scoped suggestion: the resulting full argument
    // string must still start with "revoke ", not just be the id/scope.
    const chosen = items.find((i) => i.label === "fs.write:/repo/.gitignore");
    assert.ok(chosen);
    assert.equal(applyCompletion(chosen!), "revoke fs.write:/repo/.gitignore");
  });

  test("grant completions reconstruct 'grant <id>', never a bare id", () => {
    const { complete } = makeHarness();
    const items = complete("grant git.wr");
    assert.ok(items.length > 0);
    for (const item of items) {
      assert.match(item.value, /^grant /);
    }
  });

  test("unknown subcommand yields no argument completions", () => {
    const { complete } = makeHarness();
    assert.deepEqual(complete("bogus fs.wr"), []);
  });
});
