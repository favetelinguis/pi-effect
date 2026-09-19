/**
 * delete_file: the missing fs-mutation tool. Without this, a model asked to
 * remove a file has no way to do so at all (edit/write can only rewrite
 * content, never unlink), so it either refuses or improvises a workaround
 * (e.g. "empty the file instead") without ever reaching the effect gate.
 *
 * Gated by fs.write, scoped to the resolved path — same JIT/request_effects
 * flow as edit/write.
 */

import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { FsCaps } from "../caps/fs.ts";
import type { Effect } from "../effects/model.ts";
import { defineEffectTool, registerEffectTool, type EffectCatalog } from "./define.ts";

const DeleteFileParams = Type.Object({
  path: Type.String({ description: "Path to the file to delete (relative or absolute)." }),
});

type DeleteFileInput = Static<typeof DeleteFileParams>;

export function registerDeleteFileTool(
  pi: ExtensionAPI,
  catalog: EffectCatalog,
  fs: FsCaps,
  cwd: string,
  runtimeCheck: (toolName: string, params: unknown) => { ok: true } | { ok: false; reason: string },
): void {
  registerEffectTool(
    pi,
    catalog,
    defineEffectTool({
      name: "delete_file",
      label: "Delete File",
      description:
        "Permanently delete a single file from disk. Fails with a clear error if the path is a directory or does not exist — this tool never deletes directories or recurses.",
      promptSnippet: "Permanently delete a single file",
      promptGuidelines: [
        "Use delete_file to remove a file the user asked to delete. Do not work around a missing delete capability by emptying or renaming the file instead — call delete_file.",
      ],
      group: "fs",
      effects: [{ id: "fs.write" }, { id: "fs.read" }],
      effectsFor: (params: DeleteFileInput): Effect[] => [{ id: "fs.write", scope: resolve(cwd, params.path) }],
      executionMode: "sequential",
      parameters: DeleteFileParams,
      async execute(params, ctx) {
        const absolutePath = resolve(ctx.cwd, params.path);

        let stat: Awaited<ReturnType<FsCaps["stat"]>>;
        try {
          stat = await fs.stat(absolutePath);
        } catch {
          throw new Error(`Cannot delete "${params.path}": file not found.`);
        }
        if (stat.isDirectory()) {
          throw new Error(`Cannot delete "${params.path}": it is a directory. delete_file only deletes files.`);
        }

        await fs.unlink(absolutePath);

        return {
          content: [{ type: "text", text: `Deleted ${params.path}` }],
          details: {},
        };
      },
    }),
    runtimeCheck,
  );
}
