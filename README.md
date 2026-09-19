# pi-effect

A [pi](https://github.com/earendil-works/pi-mono) extension that **removes the `bash` tool**
and replaces it with explicit, typed TypeScript tools. Every tool declares the **effects** it
may perform; effects are granted per session by the user, either upfront (`request_effects`) or
just-in-time (a prompt the first time a tool needs something it doesn't have).

No shell escape hatch. No Effect-TS dependency — the effect model is a homegrown ~150 lines of
pure TypeScript (`src/effects/model.ts`).

## Install

This is a [pi package](https://github.com/earendil-works/pi-mono) — install it straight from
GitHub, no local clone or build step required.

**Install for all projects (writes to `~/.pi/agent/settings.json`):**

```bash
pi install git:github.com/favetelinguis/pi-effect
```

**Install for the current project only (writes to `.pi/settings.json`, shareable with your team):**

```bash
pi install -l git:github.com/favetelinguis/pi-effect
```

**Try it once without installing** (clones to a temp dir for this run only):

```bash
pi -e git:github.com/favetelinguis/pi-effect
```

SSH clone also works if you prefer it over HTTPS:

```bash
pi install git:git@github.com:favetelinguis/pi-effect
```

Pi clones the repo, runs `npm install` in it automatically, and picks up the extension from the
`pi.extensions` entry in `package.json` — nothing else to configure. Manage it later with:

```bash
pi list                                       # see installed packages
pi update git:github.com/favetelinguis/pi-effect   # pull the latest pinned ref
pi remove git:github.com/favetelinguis/pi-effect
```

### Local development install

If you're hacking on this extension itself:

```bash
git clone git@github.com:favetelinguis/pi-effect.git
cd pi-effect
npm install
```

Then either:

- **Quick test:** `pi -e /path/to/pi-effect/src/index.ts`
- **Persistent (global):** symlink or copy this directory to `~/.pi/agent/extensions/pi-effect`
- **Persistent (project):** symlink or copy this directory to `.pi/extensions/pi-effect`

With `bash` gone, add `read/grep/find/ls/edit/write/delete_file/git_*/http_request` to your
muscle memory — or just let the model discover them from the tool list.

## Effect vocabulary

| Effect      | Meaning                                   | Tools                                                               |
| ----------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `fs.read`   | Read file contents, list, search           | `read`, `grep`, `find`, `ls`                                         |
| `fs.write`  | Create, modify, or delete files (scope = path) | `edit`, `write`, `delete_file`                                    |
| `git.read`  | Inspect repo state                         | `git_status`, `git_log`, `git_diff`, `git_show`, `git_branch_list`   |
| `git.write` | Mutate repo (scope = `local` \| `remote`)  | `git_add`, `git_commit`, `git_checkout`, `git_push`                  |
| `net.read`  | HTTP GET/HEAD (scope = host)               | `http_request`                                                       |
| `net.write` | HTTP POST/PUT/PATCH/DELETE (scope = host)  | `http_request`                                                       |

Rules:

- A tool is **pure** iff every effect it can produce has `mode: "read"`. Pure tools run in
  parallel and, with `autoGrantRead` (default `true`), never prompt for `fs.read`.
- **`write` implies `read`** within the same resource (configurable).
- A grant without a scope covers every requirement for that effect id. A scoped grant only
  covers requirements whose scope glob-matches.
- Deny policies (config) win over grants and can never be approved interactively. Defaults:
  `fs.write` on `**/.env*`, `**/.ssh/**`, `**/.aws/**`, `**/.gnupg/**`.

## Usage

- **Explore freely.** `read`, `grep`, `find`, `ls`, and the `git_*` read tools work with zero
  prompts by default.
- **First mutation prompts.** The first `edit`/`write`/`delete_file`/`git_commit`/... call triggers
  *"`<tool>` needs: `<effect>`. [Allow once] [Allow for session] [Deny]"*. "Allow for session"
  persists as a `pi-effect:grant` session entry — visible in the transcript, survives
  `/reload`/`/resume`, revert-able via `/tree`.
- **Batch approval.** The model can call `request_effects` once with every effect the task needs
  plus a one-line reason each, instead of hitting a JIT prompt per call.
- **`/tool`** — list, toggle, and inspect the tool catalog (`/tool`, `/tool list`, `/tool on|off
  <name>`, `/tool info <name>`). `git_push` is disabled by default.
- **`/effects`** — list, grant, revoke, and audit effect grants (`/effects`, `/effects list`,
  `/effects grant <id> [scope]`, `/effects revoke <id> [scope]`, `/effects clear`,
  `/effects log`).
- **Headless (`-p`, `--mode json`, RPC without UI):** nothing ungranted runs. Seed grants with
  `--grant fs.read,git.read` or a `defaultGrants` config entry.

## Config

`.pi/pi-effect.json` (project, only when trusted) merges over `~/.pi/agent/pi-effect.json`
(global):

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

`deny` entries add to (never replace) the built-in defaults. `unknownTools` controls what
happens when another extension's tool isn't in the pi-effect catalog: `"warn"` (default, allows
+ notifies), `"block"`, or `"allow"` silently.

## Project layout

```
src/
├── index.ts              extension entry: wires everything together
├── config.ts              .pi/pi-effect.json + ~/.pi/agent/pi-effect.json loading
├── prompt.ts              before_agent_start system-prompt section
├── effects/
│   ├── model.ts           Effect/Grant types, ids, purity, covers(), scope glob matching
│   ├── grants.ts          GrantStore (add/revoke/covers/list, once vs session)
│   ├── policy.ts          deny rules
│   └── gate.ts            pure decide() + the tool_call adapter + JIT prompt
├── caps/                  the only modules allowed to touch node:fs / child_process / fetch
│   ├── fs.ts
│   ├── proc.ts            argv-only subprocess exec via pi.exec — no shell, ever
│   ├── net.ts              fetch with a hard timeout
│   └── audit.ts           append-only JSONL audit log
├── tools/
│   ├── define.ts          defineEffectTool / registerEffectTool / EffectCatalog
│   ├── builtins.ts        read/grep/find/ls/edit/write, wrapped with effect metadata
│   ├── delete.ts           delete_file (fs.write, scoped to the resolved path)
│   ├── git.ts              git_status/log/diff/show/branch_list/add/commit/checkout/push
│   ├── http.ts              http_request
│   └── request-effects.ts  the upfront batch-approval tool
├── commands/
│   ├── tool.ts             /tool
│   └── effects.ts          /effects
└── ui/
    ├── badges.ts            ○ / ⚡ formatting
    └── entries.ts           transcript renderers for pi-effect:grant/revoke/tools entries
```

`npm run check` runs `tsc --noEmit`, the test suite (`node --test`), and
`scripts/check-caps-imports.mjs`, which greps `src/tools/**` for direct `node:fs` /
`node:child_process` / `fetch()` usage — the enforcement mechanism for "tools can only do what
they declare" without an Effect-TS `R` channel.

## Known limitations (MVP)

- `bash`/`powershell` are blocked unconditionally — skills or prompts that assume a shell will
  break by design.
- `effectsFor()` for `edit`/`write`/`delete_file` resolves paths against the extension's `cwd`
  at tool registration time (session start), not per-call `ctx.cwd`. This only matters if `cwd`
  changes mid-session, which pi does not currently do.
- `delete_file` only deletes a single file, never a directory (fails loudly instead of
  recursing). There is no `delete_directory`/`rm -rf` tool by design.
- `/tool` and `/effects` interactive UIs require TUI mode; RPC/print mode fall back to
  `list`/`grant`/`revoke` subcommands.
- The audit log (`~/.pi/agent/pi-effect/audit.jsonl`) is append-only and unbounded; rotate it
  yourself if it grows large.

## Post-MVP ideas

See `PLAN.md` section 5 backlog: `aws_*` tools, scoped-grant pickers, grant TTLs like
`"turns:5"`, effect profiles (`/effects profile review`), sub-agent capability attenuation, and
sandbox-level enforcement.
