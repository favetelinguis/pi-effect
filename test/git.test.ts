import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerGitTools } from "../src/tools/git.ts";
import { EffectCatalog } from "../src/tools/define.ts";
import type { ProcCaps } from "../src/caps/proc.ts";

interface Call {
  cmd: string;
  args: string[];
  opts: unknown;
}

function makeHarness() {
  const registry = new Map<string, ToolDefinition<never, unknown>>();
  const pi = {
    registerTool: (def: ToolDefinition<never, unknown>) => {
      registry.set(def.name, def);
    },
  } as unknown as ExtensionAPI;

  const calls: Call[] = [];
  const proc: ProcCaps = {
    async spawn(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
  };

  const catalog = new EffectCatalog();
  const runtimeCheck = () => ({ ok: true as const });
  registerGitTools(pi, catalog, proc, runtimeCheck);

  const fakeCtx = { cwd: "/repo" } as ExtensionContext;

  async function run(name: string, params: unknown) {
    const def = registry.get(name);
    if (!def) throw new Error(`tool not registered: ${name}`);
    return def.execute("tc-1", params as never, undefined, undefined, fakeCtx);
  }

  return { registry, calls, catalog, run };
}

describe("git tools: registration + effect classification", () => {
  test("all nine git tools are registered", () => {
    const { registry } = makeHarness();
    const expected = [
      "git_status",
      "git_log",
      "git_diff",
      "git_show",
      "git_branch_list",
      "git_add",
      "git_commit",
      "git_checkout",
      "git_push",
    ];
    for (const name of expected) assert.ok(registry.has(name), `expected ${name} to be registered`);
  });

  test("read tools declare git.read only", () => {
    const { catalog } = makeHarness();
    for (const name of ["git_status", "git_log", "git_diff", "git_show", "git_branch_list"]) {
      const entry = catalog.get(name)!;
      assert.deepEqual(entry.effects, [{ id: "git.read" }]);
      assert.equal(entry.pure, true);
    }
  });

  test("git_add/git_commit/git_checkout declare git.write:local", () => {
    const { catalog } = makeHarness();
    for (const name of ["git_add", "git_commit", "git_checkout"]) {
      const entry = catalog.get(name)!;
      assert.equal(entry.pure, false);
      assert.ok(entry.effects.some((e) => e.id === "git.write" && e.scope === "local"));
    }
  });

  test("git_push declares git.write:remote and is disabled by default", () => {
    const { catalog } = makeHarness();
    const entry = catalog.get("git_push")!;
    assert.ok(entry.effects.some((e) => e.id === "git.write" && e.scope === "remote"));
    assert.equal(entry.defaultEnabled, false);
    assert.equal(catalog.isEnabled("git_push"), false);
  });
});

describe("git tools: argv construction (no shell, structured params only)", () => {
  test("git_status builds status --short --branch", async () => {
    const { calls, run } = makeHarness();
    await run("git_status", {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "git");
    assert.deepEqual(calls[0].args, ["status", "--short", "--branch"]);
    assert.deepEqual(calls[0].opts, { cwd: "/repo" });
  });

  test("git_log respects limit and path", async () => {
    const { calls, run } = makeHarness();
    await run("git_log", { limit: 5, path: "src/x.ts" });
    assert.deepEqual(calls[0].args, ["log", "--oneline", "-n", "5", "--", "src/x.ts"]);
  });

  test("git_diff staged + path", async () => {
    const { calls, run } = makeHarness();
    await run("git_diff", { staged: true, path: "src/x.ts" });
    assert.deepEqual(calls[0].args, ["diff", "--staged", "--", "src/x.ts"]);
  });

  test("git_show with path builds ref:path target", async () => {
    const { calls, run } = makeHarness();
    await run("git_show", { ref: "HEAD", path: "src/x.ts" });
    assert.deepEqual(calls[0].args, ["show", "HEAD:src/x.ts"]);
  });

  test("git_add stages exact paths, never a raw args passthrough", async () => {
    const { calls, run } = makeHarness();
    await run("git_add", { paths: ["a.ts", "b.ts"] });
    assert.deepEqual(calls[0].args, ["add", "--", "a.ts", "b.ts"]);
  });

  test("git_commit -a with message", async () => {
    const { calls, run } = makeHarness();
    await run("git_commit", { message: "fix: typo", all: true });
    assert.deepEqual(calls[0].args, ["commit", "-m", "fix: typo", "-a"]);
  });

  test("git_checkout -b for new branch", async () => {
    const { calls, run } = makeHarness();
    await run("git_checkout", { ref: "feature/x", create: true });
    assert.deepEqual(calls[0].args, ["checkout", "-b", "feature/x"]);
  });

  test("git_push builds remote/branch/upstream/force flags", async () => {
    const { calls, run } = makeHarness();
    await run("git_push", { remote: "upstream", branch: "main", setUpstream: true, force: true });
    assert.deepEqual(calls[0].args, ["push", "-u", "--force", "upstream", "main"]);
  });

  test("git_push defaults to origin with no branch arg", async () => {
    const { calls, run } = makeHarness();
    await run("git_push", {});
    assert.deepEqual(calls[0].args, ["push", "origin"]);
  });
});

describe("git tools: effectsFor is a subset of static effects", () => {
  test("git_commit effectsFor is not declared (uses static superset)", () => {
    const { catalog } = makeHarness();
    const entry = catalog.get("git_commit")!;
    assert.equal(entry.effectsFor, undefined);
  });
});
