/**
 * Wraps the six built-in read/grep/find/ls/edit/write tool definitions with
 * effect metadata. Execution is untouched (the exact built-in implementation),
 * only description/prompt metadata and the runtime grant re-check are added.
 */

import { resolve } from "node:path";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type EditToolInput,
  type ExtensionAPI,
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import type { Effect } from "../effects/model.ts";
import { registerBuiltinTool, type EffectCatalog } from "./define.ts";

const FS_READ: Effect[] = [{ id: "fs.read" }];

export function registerBuiltinTools(
  pi: ExtensionAPI,
  catalog: EffectCatalog,
  cwd: string,
  runtimeCheck: (toolName: string, params: unknown) => { ok: true } | { ok: false; reason: string },
): void {
  registerBuiltinTool(pi, catalog, "read", createReadToolDefinition(cwd), {
    effects: FS_READ,
    group: "fs",
    promptSnippet: "Read file contents",
    promptGuidelines: ["Use read to examine files instead of cat or sed."],
  }, runtimeCheck);

  registerBuiltinTool(pi, catalog, "grep", createGrepToolDefinition(cwd), {
    effects: FS_READ,
    group: "fs",
    promptSnippet: "Search file contents for patterns (respects .gitignore)",
  }, runtimeCheck);

  registerBuiltinTool(pi, catalog, "find", createFindToolDefinition(cwd), {
    effects: FS_READ,
    group: "fs",
    promptSnippet: "Find files by glob pattern (respects .gitignore)",
  }, runtimeCheck);

  registerBuiltinTool(pi, catalog, "ls", createLsToolDefinition(cwd), {
    effects: FS_READ,
    group: "fs",
    promptSnippet: "List directory contents",
  }, runtimeCheck);

  registerBuiltinTool(pi, catalog, "edit", createEditToolDefinition(cwd), {
    effects: [{ id: "fs.write" }, { id: "fs.read" }],
    effectsFor: (params: EditToolInput) => [{ id: "fs.write", scope: resolve(cwd, params.path) }],
    group: "fs",
    promptSnippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    promptGuidelines: [
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
    ],
  }, runtimeCheck);

  registerBuiltinTool(pi, catalog, "write", createWriteToolDefinition(cwd), {
    effects: [{ id: "fs.write" }, { id: "fs.read" }],
    effectsFor: (params: WriteToolInput) => [{ id: "fs.write", scope: resolve(cwd, params.path) }],
    group: "fs",
    promptSnippet: "Create or overwrite files",
    promptGuidelines: ["Use write only for new files or complete rewrites."],
  }, runtimeCheck);
}
