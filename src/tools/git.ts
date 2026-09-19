/**
 * git_* tools. Structured parameters only — never a raw `{ args: string[] }` escape
 * hatch. Argv is built here and passed straight to `git` via caps/proc.ts (no shell).
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProcCaps } from "../caps/proc.ts";
import { defineEffectTool, registerEffectTool, type EffectCatalog, type EffectToolDefinition } from "./define.ts";

const GIT_READ = [{ id: "git.read" as const }];
const GIT_WRITE_LOCAL = [{ id: "git.write" as const, scope: "local" }];
const GIT_WRITE_REMOTE = [{ id: "git.write" as const, scope: "remote" }];

function formatOutput(stdout: string, stderr: string, code: number): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  const truncation = truncateTail(combined || "(no output)", {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
  }
  if (code !== 0) {
    text = `git exited with code ${code}\n${text}`;
  }
  return text;
}

export function registerGitTools(
  pi: ExtensionAPI,
  catalog: EffectCatalog,
  proc: ProcCaps,
  runtimeCheck: (toolName: string, params: unknown) => { ok: true } | { ok: false; reason: string },
): void {
  const register = (def: EffectToolDefinition<any, any>) => registerEffectTool(pi, catalog, def, runtimeCheck);

  register(
    defineEffectTool({
      name: "git_status",
      label: "git status",
      description: "Show the working tree status (git status --short --branch).",
      group: "git",
      effects: GIT_READ,
      parameters: Type.Object({}),
      async execute(_params, ctx) {
        const result = await proc.spawn("git", ["status", "--short", "--branch"], { cwd: ctx.cwd });
        return { content: [{ type: "text", text: formatOutput(result.stdout, result.stderr, result.code) }], details: {} };
      },
    }),
  );

  register(
    defineEffectTool({
      name: "git_log",
      label: "git log",
      description: "Show commit history (git log --oneline).",
      group: "git",
      effects: GIT_READ,
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max number of commits to show. Default 20." })),
        path: Type.Optional(Type.String({ description: "Only show commits touching this path." })),
      }),
      async execute(params, ctx) {
        const args = ["log", "--oneline", "-n", String(params.limit ?? 20)];
        if (params.path) args.push("--", params.path);
        const result = await proc.spawn("git", args, { cwd: ctx.cwd });
        return { content: [{ type: "text", text: formatOutput(result.stdout, result.stderr, result.code) }], details: {} };
      },
    }),
  );

  register(
    defineEffectTool({
      name: "git_diff",
      label: "git diff",
      description: "Show changes between commits, working tree, or the index.",
      group: "git",
      effects: GIT_READ,
      parameters: Type.Object({
        staged: Type.Optional(Type.Boolean({ description: "Show staged changes (git diff --staged)." })),
        path: Type.Optional(Type.String({ description: "Limit diff to this path." })),
      }),
      async execute(params, ctx) {
        const args = ["diff"];
        if (params.staged) args.push("--staged");
        if (params.path) args.push("--", params.path);
        const result = await proc.spawn("git", args, { cwd: ctx.cwd });
        return { content: [{ type: "text", text: formatOutput(result.stdout, result.stderr, result.code) }], details: {} };
      },
    }),
  );

  register(
    defineEffectTool({
      name: "git_show",
      label: "git show",
      description: "Show a commit, tag, or file at a specific revision.",
      group: "git",
      effects: GIT_READ,
      parameters: Type.Object({
        ref: Type.String({ description: "Commit, tag, or ref to show." }),
        path: Type.Optional(Type.String({ description: "Show this path at that ref instead of the full commit." })),
      }),
      async execute(params, ctx) {
        const target = params.path ? `${params.ref}:${params.path}` : params.ref;
        const result = await proc.spawn("git", ["show", target], { cwd: ctx.cwd });
        return { content: [{ type: "text", text: formatOutput(result.stdout, result.stderr, result.code) }], details: {} };
      },
    }),
  );

  register(
    defineEffectTool({
      name: "git_branch_list",
      label: "git branch",
      description: "List local and remote branches.",
      group: "git",
      effects: GIT_READ,
      parameters: Type.Object({}),
      async execute(_params, ctx) {
        const result = await proc.spawn("git", ["branch", "--all"], { cwd: ctx.cwd });
        return { content: [{ type: "text", text: formatOutput(result.stdout, result.stderr, result.code) }], details: {} };
      },
    }),
  );

  register(
    defineEffectTool({
      name: "git_add",
      label: "git add",
      description: "Stage files for commit.",
      group: "git",
      effects: [...GIT_WRITE_LOCAL, ...GIT_READ],
      executionMode: "sequential",
      parameters: Type.Object({
        paths: Type.Array(Type.String(), { description: "Paths to stage. Use ['.'] to stage everything." }),
      }),
      async execute(params, ctx) {
        const result = await proc.spawn("git", ["add", "--", ...params.paths], { cwd: ctx.cwd });
        return { content: [{ type: "text", text: formatOutput(result.stdout, result.stderr, result.code) }], details: {} };
      },
    }),
  );

  register(
    defineEffectTool({
      name: "git_commit",
      label: "git commit",
      description: "Create a commit from the current index.",
      group: "git",
      effects: [...GIT_WRITE_LOCAL, ...GIT_READ],
      executionMode: "sequential",
      parameters: Type.Object({
        message: Type.String({ description: "Commit message." }),
        all: Type.Optional(Type.Boolean({ description: "Stage all tracked, modified files first (git commit -a)." })),
      }),
      async execute(params, ctx) {
        const args = ["commit", "-m", params.message];
        if (params.all) args.push("-a");
        const result = await proc.spawn("git", args, { cwd: ctx.cwd });
        return { content: [{ type: "text", text: formatOutput(result.stdout, result.stderr, result.code) }], details: {} };
      },
    }),
  );

  register(
    defineEffectTool({
      name: "git_checkout",
      label: "git checkout",
      description: "Switch branches or restore working tree files.",
      group: "git",
      effects: [...GIT_WRITE_LOCAL, ...GIT_READ],
      executionMode: "sequential",
      parameters: Type.Object({
        ref: Type.String({ description: "Branch name or ref to check out." }),
        create: Type.Optional(Type.Boolean({ description: "Create the branch (git checkout -b)." })),
      }),
      async execute(params, ctx) {
        const args = ["checkout"];
        if (params.create) args.push("-b");
        args.push(params.ref);
        const result = await proc.spawn("git", args, { cwd: ctx.cwd });
        return { content: [{ type: "text", text: formatOutput(result.stdout, result.stderr, result.code) }], details: {} };
      },
    }),
  );

  register(
    defineEffectTool({
      name: "git_push",
      label: "git push",
      description: "Push local commits to a remote. Disabled by default — enable with /tool on git_push.",
      group: "git",
      defaultEnabled: false,
      effects: [...GIT_WRITE_REMOTE, ...GIT_READ],
      executionMode: "sequential",
      parameters: Type.Object({
        remote: Type.Optional(Type.String({ description: "Remote name. Default 'origin'." })),
        branch: Type.Optional(Type.String({ description: "Branch to push. Default: current branch." })),
        setUpstream: Type.Optional(Type.Boolean({ description: "Set upstream tracking (git push -u)." })),
        force: Type.Optional(Type.Boolean({ description: "Force push (git push --force). Use with extreme care." })),
      }),
      async execute(params, ctx) {
        const args = ["push"];
        if (params.setUpstream) args.push("-u");
        if (params.force) args.push("--force");
        args.push(params.remote ?? "origin");
        if (params.branch) args.push(params.branch);
        const result = await proc.spawn("git", args, { cwd: ctx.cwd });
        return { content: [{ type: "text", text: formatOutput(result.stdout, result.stderr, result.code) }], details: {} };
      },
    }),
  );
}
