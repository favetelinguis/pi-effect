import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerDeleteFileTool } from "../src/tools/delete.ts";
import { EffectCatalog } from "../src/tools/define.ts";
import type { FsCaps } from "../src/caps/fs.ts";

function makeHarness(files: Record<string, { isDirectory: boolean }>) {
  const registry = new Map<string, ToolDefinition<never, unknown>>();
  const pi = {
    registerTool: (def: ToolDefinition<never, unknown>) => {
      registry.set(def.name, def);
    },
  } as unknown as ExtensionAPI;

  const unlinked: string[] = [];
  const fs: FsCaps = {
    async readFile() {
      throw new Error("not used");
    },
    async stat(absPath) {
      const entry = files[absPath];
      if (!entry) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return { isDirectory: () => entry.isDirectory } as import("node:fs").Stats;
    },
    async readdir() {
      return [];
    },
    async writeFile() {
      /* not used */
    },
    async mkdir() {
      /* not used */
    },
    async unlink(absPath) {
      unlinked.push(absPath);
      delete files[absPath];
    },
  };

  const catalog = new EffectCatalog();
  const runtimeCheck = () => ({ ok: true as const });
  registerDeleteFileTool(pi, catalog, fs, "/repo", runtimeCheck);

  const fakeCtx = { cwd: "/repo" } as ExtensionContext;

  async function run(params: unknown) {
    const def = registry.get("delete_file");
    if (!def) throw new Error("delete_file not registered");
    return def.execute("tc-1", params as never, undefined, undefined, fakeCtx);
  }

  return { catalog, unlinked, run };
}

describe("delete_file: registration and effect classification", () => {
  test("registered with fs.write + fs.read static effects, impure, sequential", () => {
    const { catalog } = makeHarness({});
    const entry = catalog.get("delete_file")!;
    assert.ok(entry);
    assert.equal(entry.pure, false);
    assert.deepEqual(
      entry.effects.map((e) => e.id).sort(),
      ["fs.read", "fs.write"],
    );
  });

  test("effectsFor scopes fs.write to the resolved absolute path", () => {
    const { catalog } = makeHarness({});
    const entry = catalog.get("delete_file")!;
    const effects = entry.effectsFor!({ path: ".gitignore" });
    assert.deepEqual(effects, [{ id: "fs.write", scope: "/repo/.gitignore" }]);
  });
});

describe("delete_file: execution", () => {
  test("deletes an existing file via caps.fs.unlink (no shell rm)", async () => {
    const { unlinked, run } = makeHarness({ "/repo/.gitignore": { isDirectory: false } });
    const result = await run({ path: ".gitignore" });
    assert.deepEqual(unlinked, ["/repo/.gitignore"]);
    assert.match((result.content[0] as { text: string }).text, /Deleted \.gitignore/);
  });

  test("throws a clear error for a missing file instead of a raw ENOENT", async () => {
    const { run } = makeHarness({});
    await assert.rejects(() => run({ path: "nope.ts" }), /file not found/);
  });

  test("refuses to delete a directory", async () => {
    const { unlinked, run } = makeHarness({ "/repo/src": { isDirectory: true } });
    await assert.rejects(() => run({ path: "src" }), /is a directory/);
    assert.deepEqual(unlinked, []);
  });
});
