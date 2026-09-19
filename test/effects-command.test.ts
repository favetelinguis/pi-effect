import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerEffectsCommand } from "../src/commands/effects.ts";
import { GrantStore } from "../src/effects/grants.ts";
import { Policy } from "../src/effects/policy.ts";
import type { Grant } from "../src/effects/model.ts";

function makeHarness() {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
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

  return { grants, notes, run };
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
