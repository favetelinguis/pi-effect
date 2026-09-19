# pi-effect — MVP / POC plan

A pi extension that **removes the `bash` tool** and replaces it with explicit, typed TypeScript
tools, each of which declares the **effects** it may perform. Effects are granted per session by
the user — either up front (the agent asks for what it will need) or just-in-time. A `/tool`
command gives full insight into which tools exist, what effects they carry, and lets you turn them
on/off for the session. A `/effects` command does the same for grants.

Decisions already made (from the kickoff Q&A):

| Topic            | Decision                                                                  |
| ---------------- | ------------------------------------------------------------------------- |
| Effect model     | Homegrown, lightweight. No Effect-TS dependency.                          |
| `bash`           | Removed entirely. No shell escape hatch.                                  |
| MVP tool scope   | `read/grep/find/ls` (pure), `edit/write` (fs.write), `git_*`, `http_request` |
| Approval UX      | Hybrid: `request_effects` tool for upfront batch approval + JIT prompt fallback |
| Post-MVP         | `aws` with read/write subcommand split, scoped grants, more tools         |

---

## 1. Research summary — what pi gives us (v0.85.1)

Everything needed is available through the public extension API; **no pi fork is required**.

| Need                                        | pi API                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Register typed tools                        | `pi.registerTool({ name, parameters: TypeBox, execute, renderCall?, renderResult?, executionMode? })`     |
| Replace built-ins by name                   | Registering a tool named `read`/`edit`/… **replaces** the built-in; built-in renderers are inherited per slot |
| Reuse built-in implementations              | `createReadToolDefinition(cwd)`, `createGrepToolDefinition`, `createFindToolDefinition`, `createLsToolDefinition`, `createEditToolDefinition`, `createWriteToolDefinition` are exported |
| Remove `bash`                               | `pi.setActiveTools(names)` at `session_start` (filter out `bash`/`powershell`) + `tool_call` block as belt-and-braces; optional `defaultTools` in `settings.json` |
| Intercept every tool call (the gate)        | `pi.on("tool_call", …)` → return `{ block: true, reason }`; fires for built-in **and** extension tools; preflight is sequential even in parallel mode, so prompts don't overlap |
| Prompt the user                             | `ctx.ui.select / confirm / custom` (check `ctx.hasUI` first; `ctx.mode === "tui"` for `custom`)           |
| List / toggle tools                         | `pi.getAllTools()` (includes inactive, with `sourceInfo`), `pi.getActiveTools()`, `pi.setActiveTools()` |
| Slash commands with autocomplete            | `pi.registerCommand("tool", { handler, getArgumentCompletions })`                                        |
| Persist grants/tool selection               | `pi.appendEntry(customType, data)` + replay from `ctx.sessionManager.getBranch()` on `session_start` / `session_tree` (branch-aware, survives `/reload` and `/resume`) |
| Show grants in the transcript               | `pi.registerEntryRenderer(customType, …)` (TUI only, never sent to the LLM)                             |
| Tell the model about the effect system      | `pi.on("before_agent_start")` → `systemPrompt` chaining; `promptSnippet` / `promptGuidelines` on tools   |
| Footer / widget                             | `ctx.ui.setStatus`, `ctx.ui.setWidget`                                                                   |
| Toggle UI                                   | `SettingsList` from `@earendil-works/pi-tui` + `getSettingsListTheme()` (see `examples/extensions/tools.ts`) |
| Run subprocesses                            | `pi.exec(cmd, args, { signal, timeout, cwd })` — argv array, **no shell**                               |
| Output truncation                           | `truncateHead / truncateTail / DEFAULT_MAX_BYTES / DEFAULT_MAX_LINES / formatSize`                       |
| Concurrent file safety                      | `withFileMutationQueue(absPath, fn)`                                                                     |
| Serialize impure tools                      | `executionMode: "sequential"` on the tool definition                                                     |
| Headless runs                               | `pi.registerFlag("grant", …)` + `pi.getFlag()`; `ctx.hasUI === false` in `-p` / json modes              |
| Distribution                                | `package.json` with `"pi": { "extensions": ["./src/index.ts"] }`; pi core packages as `peerDependencies` |

Relevant examples to crib from: `tools.ts` (toggle UI + branch-aware persistence), `plan-mode/`
(setActiveTools + prompt injection + state restore), `permission-gate.ts` (tool_call prompt),
`tool-override.ts` (override built-in by name), `truncated-tool.ts` (wrapping `rg` with truncation
and custom renderers), `dynamic-tools.ts`.

Constraints discovered:

- Overriding a built-in does **not** inherit `promptSnippet` / `promptGuidelines` → re-declare them.
- Non-additive `setActiveTools()` changes invalidate the provider prompt cache. Acceptable for a
  user-driven toggle; avoid flapping tools on every turn.
- Skills that instruct the model to "use bash" will break by design. Document it.
- `tool_call` handlers can't call `ctx.reload()` etc.; fine for our use.

---

## 2. Core model

### 2.1 Effects

An **effect** is a user-facing, semantic capability the user can grant. Not a low-level syscall.

```ts
// src/effects/model.ts
export type Resource = "fs" | "git" | "net" /* later: "aws" | "proc" | "docker" … */;
export type Mode = "read" | "write";
export type EffectId = `${Resource}.${Mode}`;          // "fs.read" | "fs.write" | "git.read" | …

export interface Effect {
  id: EffectId;
  /** Optional narrowing, resource-specific: fs → path glob, net → host pattern, git → remote/branch */
  scope?: string;
}

export interface Grant extends Effect {
  ttl: "once" | "session";
  source: "request_effects" | "jit" | "command" | "config" | "flag";
  grantedAt: number;
}
```

MVP effect vocabulary:

| Effect      | Meaning                                              | Tools                                    |
| ----------- | ---------------------------------------------------- | ---------------------------------------- |
| `fs.read`   | Read file contents, list, search                     | `read`, `grep`, `find`, `ls`             |
| `fs.write`  | Create or modify files (scope = path)                | `edit`, `write`                          |
| `git.read`  | Inspect repo state                                   | `git_status`, `git_log`, `git_diff`, `git_show`, `git_branch_list` |
| `git.write` | Mutate repo (scope = `local` \| `remote`)            | `git_add`, `git_commit`, `git_checkout`, `git_push` |
| `net.read`  | HTTP GET/HEAD (scope = host)                         | `http_request`                           |
| `net.write` | HTTP POST/PUT/PATCH/DELETE (scope = host)            | `http_request`                           |

Rules:

- **Purity** is derived, not declared: a tool is *pure* iff every effect it can produce has
  `mode === "read"`. Pure tools never prompt once `*.read` is granted (or, configurable, are
  auto-granted). Shown as a badge in `/tool` and in tool-call rendering.
- **`write` implies `read`** within the same resource (`writeImpliesRead: true`, configurable).
- **Scope coverage**: a grant without `scope` covers everything for that effect. A scoped grant
  covers a requirement if the requirement's scope matches (fs → `path.matchesGlob`, net → host
  glob, git → exact). Requirements without scope are only covered by unscoped grants.
- **Deny policies** (from config) win over grants and can never be granted interactively
  (e.g. `fs.write` on `**/.env*`, `git.write` scope `remote` on `main`).

### 2.2 Effect tools

Tools declare effects **statically** (the maximum set) and optionally **dynamically** per call
(the exact set, e.g. `http_request` → `net.read` for GET vs `net.write` for POST; `edit` → scoped
to the file path).

```ts
// src/tools/define.ts
export interface EffectToolDefinition<P extends TSchema, D = unknown> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: P;
  /** Static superset of effects this tool can ever produce. Used for /tool display and purity. */
  effects: readonly Effect[];
  /** Optional exact effects for a given call. Must be a subset of `effects` (checked, throws otherwise). */
  effectsFor?: (params: Static<P>) => Effect[];
  /** Tool body. Receives a capability object limited to the declared resources (see 2.3). */
  execute: (params: Static<P>, caps: Caps, ctx: ToolCtx) => Promise<AgentToolResult<D>>;
  renderCall?: ToolDefinition<P, D>["renderCall"];
  renderResult?: ToolDefinition<P, D>["renderResult"];
  /** Defaults: pure → "parallel", impure → "sequential". */
  executionMode?: "parallel" | "sequential";
  /** Enabled at session start unless the user toggled it off. Default true. */
  defaultEnabled?: boolean;
  /** Free-form grouping for /tool ("fs", "git", "http", "meta"). */
  group?: string;
}

export function defineEffectTool<P extends TSchema, D>(def: EffectToolDefinition<P, D>): EffectToolDefinition<P, D>;
```

`registerEffectTool(pi, def)` translates to `pi.registerTool(...)`, adds the tool to the catalog,
and wraps `execute` so it **re-checks** grants right before running (defense in depth: the
`tool_call` gate is the primary check, but the wrapper protects against another extension's
`tool_call` mutation or a future pi behavior change).

Design principle — **no raw argv pass-through**. `git_*` tools take structured parameters
(`{ message, all?: boolean }`) and build argv themselves. `http_request` uses `fetch()`, not
`curl`. This is what makes the effect classification trustworthy; a `git: { args: string[] }` tool
would be bash with a different name (`git -c core.pager='rm -rf …' log`).

### 2.3 Capabilities (implementation-side, not user-facing)

To keep "the tool can only do what it declares" honest without Effect-TS, tool bodies receive a
`caps` object built from the tool's declared **resources**:

```ts
interface Caps {
  fs?: { readFile; stat; glob; readdir; writeFile; mkdir; /* writeFile/mkdir only if fs.write declared */ };
  proc?: { spawn(cmd: string, args: string[], opts) };   // only if the tool's resource is one that wraps a binary (git)
  net?: { fetch(input, init) };
}
```

- `src/caps/*.ts` is the only place allowed to import `node:fs`, `node:child_process`, `pi.exec`,
  or global `fetch`.
- An ESLint `no-restricted-imports` rule (or a simple grep in `npm run check`) enforces this for
  `src/tools/**`.
- This is the homegrown stand-in for Effect-TS's `R` channel: not type-enforced across the
  program, but enforced at the module boundary and cheap to audit.

### 2.4 Grants and the gate

```
tool_call(event)
  ├─ tool = catalog.get(event.toolName)
  ├─ if toolName is bash/powershell           → block ("removed by pi-effect policy")
  ├─ if tool unknown (other extension's tool) → passthrough (configurable: warn / block)
  ├─ if !catalog.isEnabled(tool)              → block ("disabled via /tool")
  ├─ required = tool.effectsFor?.(input) ?? tool.effects
  ├─ denied   = required.filter(policy.denies)          → block, list them
  ├─ missing  = required.filter(e => !grants.covers(e))
  ├─ if missing.length === 0                  → allow (audit log)
  ├─ if !ctx.hasUI                            → block ("call request_effects / start with --grant")
  └─ prompt: "<tool> needs <effects>. [Allow once] [Allow for session] [Deny]"
        once    → allow, do not persist
        session → grants.add(…, ttl: "session"), appendEntry, allow
        deny    → block ("Denied by user. Ask the user or call request_effects with a reason.")
```

Block reasons are written **for the model**: they name the exact effect ids and tell it what to do
next, so the agent recovers gracefully instead of retrying blindly.

### 2.5 Upfront approval: the `request_effects` tool

```ts
parameters: Type.Object({
  effects: Type.Array(Type.Object({
    id: StringEnum(ALL_EFFECT_IDS),
    scope: Type.Optional(Type.String()),
    reason: Type.String({ description: "One sentence: why this is needed for the current task" }),
  })),
})
```

- Shows a `ctx.ui.custom` checklist (or `ui.select` fallback): every requested effect with its
  reason, pre-checked; user can uncheck items, approve, or deny all. Timeout option for RPC.
- Returns `{ granted: [...], denied: [...] }` to the model; persists grants as entries.
- `promptGuidelines`: *"Before making changes, explore with pure tools, then call
  `request_effects` **once** with every effect the task needs. Do not request effects you will not
  use."*
- Always enabled; cannot be toggled off in `/tool` (shown as `meta`).

### 2.6 Persistence (branch-aware, `/reload`- and `/resume`-safe)

Custom entries (never sent to the LLM):

| customType              | data                                                   | when                          |
| ----------------------- | ------------------------------------------------------ | ----------------------------- |
| `pi-effect:grant`       | `Grant`                                                | each grant (one entry each → transcript shows them via entry renderer) |
| `pi-effect:revoke`      | `Effect`                                               | `/effects revoke`             |
| `pi-effect:tools`       | `{ enabled: string[] }`                                | any `/tool` toggle            |

On `session_start` and `session_tree`: replay `ctx.sessionManager.getBranch()` in order to rebuild
`GrantStore` and enabled set, then `pi.setActiveTools()`. `ttl: "once"` grants are never
persisted.

---

## 3. User experience

### 3.1 `/tool`

```
/tool                 interactive SettingsList (fuzzy search), toggles apply immediately
/tool list            compact table → notify
/tool on <name>       enable   (autocomplete)
/tool off <name>      disable  (autocomplete)
/tool info <name>     description, params summary, effects, purity, group, source
```

Interactive row format (pi `SettingsList` items):

```
Tool Configuration                          ⚡ = impure   ○ = pure
─────────────────────────────────────────────────────────────────
○ read           fs.read                                 enabled
○ grep           fs.read                                 enabled
○ find           fs.read                                 enabled
○ ls             fs.read                                 enabled
⚡ edit           fs.write                                enabled
⚡ write          fs.write                                enabled
○ git_status     git.read                                enabled
○ git_log        git.read                                enabled
○ git_diff       git.read                                enabled
⚡ git_add        git.write:local                         enabled
⚡ git_commit     git.write:local                         enabled
⚡ git_push       git.write:remote                        disabled
⚡ http_request   net.read | net.write                    enabled
· request_effects (meta, always on)
· bash           removed by policy
```

Toggle → `pi.setActiveTools()` + `appendEntry("pi-effect:tools")` + notify.

### 3.2 `/effects`

```
/effects                   interactive: every effect id, state (granted-session / not), toggle
/effects list              grants in the current branch with source + time
/effects grant <id> [scope]
/effects revoke <id> [scope]
/effects clear             revoke everything (pure effects re-prompt afterwards unless auto-granted)
/effects log               last N audit lines (tool, effects, allowed/blocked, at)
```

### 3.3 Ambient UI

- Footer status: `⚡ fs.write git.write:local` (granted impure effects) or `○ read-only`.
- Widget (above editor) while a `request_effects` decision is pending / when a JIT prompt fires.
- Entry renderer: `✓ granted fs.write (session) — "edit src/foo.ts"` lines in the transcript, so
  the session file itself is the audit trail.
- Tool-call renderers for `git_*` / `http_request` show the effect badge inline:
  `⚡ git_commit  git.write:local  "fix typo"`. Overridden built-ins keep pi's renderers.

### 3.4 What the model sees

`before_agent_start` appends to the system prompt (chained, ~15 lines):

```
## Effects
There is no shell. Every tool declares effects (fs.read, fs.write, git.read, git.write:local|remote,
net.read, net.write). Tools marked pure never change anything.
Currently granted: fs.read, git.read.
Workflow: explore with pure tools first; then call `request_effects` ONCE listing every effect the
task needs with a one-line reason each; then proceed. If a call is blocked with "not granted",
call `request_effects` — do not retry the same call.
```

Each tool's `description` ends with `Effects: …` so the model can plan without the prompt.

### 3.5 Headless / RPC / print mode

- `--grant fs.read,git.read` flag (`pi.registerFlag`) seeds session grants.
- `.pi/pi-effect.json` `defaultGrants` seeds grants for a project.
- When `!ctx.hasUI`, missing effects are blocked (never silently allowed).

### 3.6 Config: `.pi/pi-effect.json` (project) / `~/.pi/agent/pi-effect.json` (global)

```json
{
  "autoGrantRead": true,
  "writeImpliesRead": true,
  "defaultGrants": [{ "id": "git.read" }],
  "defaultDisabledTools": ["git_push"],
  "deny": [
    { "id": "fs.write", "scope": "**/.env*" },
    { "id": "git.write", "scope": "remote" }
  ],
  "unknownTools": "warn"
}
```

---

## 4. Project layout

```
pi-effect/
├── package.json              "pi": { "extensions": ["./src/index.ts"] }; peerDeps on pi core pkgs
├── tsconfig.json             strict, moduleResolution bundler, allowImportingTsExtensions
├── PLAN.md                   this file
├── README.md                 install + usage + effect vocabulary
├── src/
│   ├── index.ts              extension entry: wires everything, session_start/tree restore
│   ├── config.ts             load/merge .pi/pi-effect.json + flags
│   ├── effects/
│   │   ├── model.ts          Effect/Grant types, ids, purity, covers(), scope matchers
│   │   ├── grants.ts         GrantStore (add/revoke/covers/list, once vs session, replay)
│   │   ├── policy.ts         deny rules
│   │   └── gate.ts           tool_call handler + JIT prompt + audit
│   ├── caps/
│   │   ├── fs.ts             readFile/stat/glob/readdir/writeFile/mkdir (uses withFileMutationQueue)
│   │   ├── proc.ts           spawn(cmd, argv) via pi.exec — no shell, timeout, signal, truncation
│   │   └── net.ts            fetch with size/time limits
│   ├── tools/
│   │   ├── define.ts         defineEffectTool / registerEffectTool / Catalog
│   │   ├── builtins.ts       read/grep/find/ls/edit/write wrappers over createXToolDefinition
│   │   ├── git.ts            git_status, git_log, git_diff, git_show, git_branch_list, git_add, git_commit, git_checkout, git_push
│   │   ├── http.ts           http_request
│   │   └── request-effects.ts
│   ├── commands/
│   │   ├── tool.ts           /tool
│   │   └── effects.ts        /effects
│   ├── prompt.ts             before_agent_start system prompt section
│   └── ui/
│       ├── badges.ts         ○ / ⚡ formatting, effect chip rendering
│       ├── entries.ts        entry renderers for pi-effect:grant / revoke / tools
│       └── request-dialog.ts checklist component for request_effects (ctx.ui.custom)
└── test/
    ├── model.test.ts         covers(), scope matching, purity, writeImpliesRead
    ├── grants.test.ts        add/revoke/replay/once-vs-session
    ├── gate.test.ts          decision table with fake ctx (hasUI true/false, prompt answers)
    └── git.test.ts           argv construction & effect classification per subcommand
```

Tooling: Node 26 is installed → use the built-in test runner on `.ts` directly
(`node --test test/**/*.test.ts`, type stripping is native), `tsc --noEmit` for types. Zero build
step; pi loads TS via jiti. Dev loop: `pi -e ./src/index.ts` in a scratch repo, or symlink the
folder into `~/.pi/agent/extensions/pi-effect` and use `/reload`.

---

## 5. Phases

### Phase 0 — scaffold (½ day)
- `package.json` (peerDeps: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
  `@earendil-works/pi-ai`, `typebox`; devDeps: `typescript`, same pkgs for types), `tsconfig.json`,
  `npm run check` (tsc + tests + caps-import grep).
- `src/index.ts` that only logs "pi-effect loaded"; verify `pi -e ./src/index.ts`.

### Phase 1 — effect model + grants + gate, no UI (1 day)
- `model.ts`, `grants.ts`, `policy.ts` with tests.
- `gate.ts` as a pure decision function `decide(tool, input, grants, policy, hasUI) → Allow | Block | Prompt`,
  then the thin `tool_call` adapter around it. Test the decision table exhaustively.
- Bash removal: `session_start` → `setActiveTools(active.filter(n => !["bash","powershell"].includes(n)))`
  and gate blocks `bash` unconditionally.

### Phase 2 — effect tools: built-ins wrapped (1 day)
- `define.ts` + `Catalog`.
- `builtins.ts`: wrap the six `createXToolDefinition(ctx.cwd)` results; re-declare
  `promptSnippet`/`promptGuidelines`; `effectsFor` for `edit`/`write` returns `fs.write` scoped to the
  resolved path; `executionMode: "sequential"` for the two writers.
- Smoke test in a scratch repo: reads work with zero prompts (`autoGrantRead`), first `edit`
  triggers JIT prompt, "Allow for session" persists across `/reload`.

### Phase 3 — `/tool` (½–1 day)
- Command with subcommands + autocomplete + `SettingsList` UI; persistence entry; restore on
  `session_start` / `session_tree`.
- Bash/powershell rows shown as "removed by policy", `request_effects` as meta.

### Phase 4 — upfront approval + `/effects` + prompt (1 day)
- `request_effects` tool + checklist dialog + entries + entry renderers.
- `/effects` command family.
- `prompt.ts` system-prompt section; footer status; pending-request widget.
- `--grant` flag and config-file `defaultGrants`; headless behavior.

### Phase 5 — git + http tools (1 day)
- `caps/proc.ts` (argv only, timeout, abort, `truncateTail`, temp-file spill like `truncated-tool.ts`).
- `git.ts`: structured subcommands, `effectsFor` → `git.read` vs `git.write:local|remote`; custom
  `renderCall` with badge; `git_push` `defaultEnabled: false`.
- `http.ts`: `fetch`-based; method → `net.read`/`net.write`; scope = host; size/time limits; deny
  `file:`/`localhost` by default.

### Phase 6 — polish + docs (½ day)
- Audit log (`~/.pi/agent/pi-effect/audit.jsonl`) + `/effects log`.
- README, demo script, known limitations.

**Total: ~5–6 focused days for the MVP.**

### Post-MVP backlog
- `aws` tool family: `aws_describe`/`aws_list`/`aws_get` (→ `aws.read`) vs mutating ops
  (→ `aws.write`, scope = `service` or `service:region:account`). Built on argv `aws … --output json`
  with an allowlist per subcommand, never raw args.
- Scoped grants UI (path/host pickers), grant expiry (`ttl: "turns:5"`).
- **Effect profiles**: `/effects profile review` = read-only; `/effects profile ship` = + git.write.
  Pairs naturally with the `preset.ts` idea.
- Sub-agents inherit a *subset* of the parent's grants (capability attenuation).
- Second line of defense: run impure tools under bubblewrap/sandbox-runtime (the `sandbox/`
  example) so a bug in a tool still can't exceed its declared effects at the OS level.
- Optional LLM classifier for ambiguous requests (see claude-auto-permission's design), only ever
  as an extra veto, never as an approver.
- Publish as a pi package (`pi install git:…`).

---

## 6. Suggestions for an optimal experience (my additions)

1. **Pure tools run in parallel, impure tools run sequentially** by default
   (`executionMode`). Fewer races, and a JIT prompt for a write never fires in the middle of another
   write.
2. **Auto-grant `*.read` on start** (`autoGrantRead: true`). Exploration should feel exactly like
   today; friction is reserved for mutation. `/effects revoke fs.read` still works for paranoid
   sessions.
3. **Block reasons are prompts for the model, not error strings.** "Effect `git.write:remote`
   not granted. Call `request_effects` with a reason, or ask the user." Cuts retry loops.
4. **One `request_effects` per task.** The system prompt nudges "explore → request once →
   execute". Approving a batch of 3 effects with reasons is far nicer than 3 modal interrupts.
5. **Grants live in the session file as entries** and render in the transcript. Reviewing a session
   later shows *when* and *why* each capability was approved — a real audit trail, branch-aware,
   and revert-able via `/tree`.
6. **`git_push` disabled by default**, `git.write:remote` deniable by config. Local mutation is
   cheap to undo; remote is not.
7. **Deny policies that can't be overridden interactively** (`.env*`, secrets, `git.write:remote`
   on `main`). Muscle-memory "Allow for session" should never be able to leak a secret.
8. **Scope shown in every prompt.** "edit needs fs.write → `src/auth/login.ts`" is decidable in
   one glance; "edit needs fs.write" is not.
9. **Capability object + import lint** (`src/caps` is the only module that touches `node:fs` /
   `child_process` / `fetch`). This is what keeps the declared effects honest as tools are added.
10. **Headless safety by default**: no UI ⇒ nothing un-granted runs. `--grant` and `defaultGrants`
    make CI/`-p` runs explicit and reviewable.
11. **Structured tools over CLI mirrors.** `git_commit { message, all }` beats
    `git { args }` for both safety and model accuracy (fewer flag hallucinations).
12. **Tool descriptions end with `Effects: …`** so the model can plan its `request_effects` call
    without relying on the system prompt surviving compaction.

---

## 7. Risks & open questions

| Risk                                                                | Mitigation                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Model keeps asking for a shell / tries `write` a script it can't run | Prompt section explains there is no shell; tools cover 90% of the coding loop; add tools as gaps appear (`npm_run`, `test_run` are natural next candidates as structured tools) |
| Skills/prompts referencing `bash` break                             | Documented; `unknownTools: "warn"` surfaces it                                              |
| Prompt cache invalidation on tool toggles                           | Toggles are user-driven and rare; `request_effects` doesn't change the tool list           |
| Interactive-mode "override built-in" warnings at startup            | Cosmetic; note in README                                                                    |
| A tool's `effectsFor` under-reports                                  | `define.ts` asserts `effectsFor(...) ⊆ effects` and throws; tests per tool                  |
| Another extension registers an un-classified tool                   | `unknownTools: "warn" | "block" | "allow"` policy; default `warn`                            |
| `ctx.cwd` changes mid-session                                       | Wrappers resolve paths against `ctx.cwd` at call time, not at registration                  |

Open questions to settle during Phase 1:

- Should `autoGrantRead` be true by default (recommended) or should even reads be requested once?
- Grant scope syntax in commands: `/effects grant fs.write src/**` — positional or `--scope=`?
- Should `/tool off <impure tool>` also revoke its effects, or are tools and effects fully orthogonal? (Recommendation: orthogonal — two independent dials is easier to reason about.)

---

## 8. MVP acceptance demo

1. `pi -e ./src/index.ts` in a scratch git repo. `/tool` lists read/grep/find/ls/edit/write, 9 `git_*`
   tools, `http_request`, `request_effects`; `bash` shows "removed by policy".
2. "Find every TODO in this repo" → grep/read run, **no prompts**, footer shows `○ read-only`.
3. "Fix the TODO in `src/x.ts` and commit it" → model calls `request_effects` with
   `fs.write (src/x.ts)`, `git.write:local` + reasons → checklist → approve → edit + `git_commit` run;
   transcript shows two `✓ granted` entries; footer shows `⚡ fs.write git.write:local`.
4. `/tool off git_commit` → "…and push it" → `git_commit` blocked with a clear reason, `git_push`
   disabled by default → model reports back instead of looping.
5. `/effects revoke fs.write` → next `edit` triggers a JIT prompt; choose "Allow once" → not persisted.
6. `/reload` and `/resume` → grants and tool selection restored from the branch.
7. `pi -p "list files" --grant fs.read` works headless; `pi -p "edit …"` without grants is blocked with
   an actionable message.
