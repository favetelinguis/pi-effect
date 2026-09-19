/**
 * pi-effect: removes the `bash` tool and replaces it with explicit, typed
 * TypeScript tools, each declaring the effects it may perform. Effects are
 * granted per session by the user, either upfront (request_effects) or
 * just-in-time (the tool_call gate).
 */

import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendAuditLine } from "./caps/audit.ts";
import { createNetCaps } from "./caps/net.ts";
import { createProcCaps } from "./caps/proc.ts";
import { loadConfig, type PiEffectConfig } from "./config.ts";
import { registerEffectsCommand } from "./commands/effects.ts";
import { registerToolCommand } from "./commands/tool.ts";
import { createGateHandler, REMOVED_TOOLS } from "./effects/gate.ts";
import { GrantStore } from "./effects/grants.ts";
import type { Effect, Grant } from "./effects/model.ts";
import { isEffectId } from "./effects/model.ts";
import { Policy, type PolicyLike } from "./effects/policy.ts";
import { buildEffectsPromptSection } from "./prompt.ts";
import { registerBuiltinTools } from "./tools/builtins.ts";
import { EffectCatalog } from "./tools/define.ts";
import { registerGitTools } from "./tools/git.ts";
import { registerHttpTool } from "./tools/http.ts";
import { registerRequestEffectsTool } from "./tools/request-effects.ts";
import { registerEntryRenderers } from "./ui/entries.ts";

export default function piEffectExtension(pi: ExtensionAPI): void {
  const catalog = new EffectCatalog();
  const grants = new GrantStore();
  let policy = new Policy();
  let config: PiEffectConfig | undefined;
  let toolsRegistered = false;
  const auditPath = join(getAgentDir(), "pi-effect", "audit.jsonl");

  // Live-updating views so consumers registered once at load time (commands,
  // the gate) always see the current `policy` / `config`, even after
  // session_start reassigns them.
  const policyView: PolicyLike = {
    denies: (effect) => policy.denies(effect),
    isDenied: (effect) => policy.isDenied(effect),
  };
  const unknownToolsPolicy = () => config?.unknownTools ?? "warn";

  pi.registerFlag("grant", {
    description: "Comma-separated effect ids (optionally id:scope) to grant for this session, e.g. fs.read,git.read",
    type: "string",
  });

  function runtimeCheck(toolName: string, params: unknown): { ok: true } | { ok: false; reason: string } {
    const entry = catalog.get(toolName);
    if (!entry) return { ok: true };
    if (!catalog.isEnabled(toolName)) {
      return { ok: false, reason: `Tool "${toolName}" is disabled via /tool.` };
    }
    const required = entry.effectsFor ? entry.effectsFor(params) : entry.effects;
    for (const effect of required) {
      if (policy.denies(effect).length > 0) {
        return { ok: false, reason: `Effect "${effect.id}" is denied by policy for this call.` };
      }
      if (!grants.covers(effect)) {
        return {
          ok: false,
          reason: `Effect "${effect.id}"${effect.scope ? ` (${effect.scope})` : ""} not granted. Call request_effects, or ask the user to run /effects grant ${effect.id}.`,
        };
      }
    }
    return { ok: true };
  }

  function updateStatus(ctx: ExtensionContext): void {
    const desc = grants.describe();
    ctx.ui.setStatus("pi-effect", desc ? ctx.ui.theme.fg("accent", `⚡ ${desc}`) : ctx.ui.theme.fg("dim", "○ read-only"));
  }

  function persistGrant(grant: Grant, ctx: ExtensionContext): void {
    pi.appendEntry("pi-effect:grant", grant);
    updateStatus(ctx);
  }

  function persistRevoke(effect: Effect, ctx: ExtensionContext): void {
    pi.appendEntry("pi-effect:revoke", effect);
    updateStatus(ctx);
  }

  function persistToolState(): void {
    pi.appendEntry("pi-effect:tools", { disabled: catalog.disabledNames() });
  }

  function applyActiveTools(): void {
    const active = new Set(pi.getActiveTools().filter((n) => !REMOVED_TOOLS.has(n)));
    for (const name of catalog.disabledNames()) active.delete(name);
    for (const name of catalog.enabledNames()) active.add(name);
    pi.setActiveTools([...active]);
  }

  function registerAllTools(ctx: ExtensionContext): void {
    if (toolsRegistered) return;
    toolsRegistered = true;

    const procCaps = createProcCaps(pi);
    const netCaps = createNetCaps();

    registerBuiltinTools(pi, catalog, ctx.cwd, runtimeCheck);
    registerGitTools(pi, catalog, procCaps, runtimeCheck);
    registerHttpTool(pi, catalog, netCaps, runtimeCheck);
    registerRequestEffectsTool(pi, { catalog, grants, policy: policyView, onGrant: persistGrant });
  }

  function replayBranch(ctx: ExtensionContext, cfg: PiEffectConfig): void {
    grants.clear();
    catalog.restoreDisabled(cfg.defaultDisabledTools);

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === "pi-effect:grant") {
        grants.add(entry.data as Grant);
      } else if (entry.customType === "pi-effect:revoke") {
        grants.revoke(entry.data as Effect);
      } else if (entry.customType === "pi-effect:tools") {
        const data = entry.data as { disabled: string[] } | undefined;
        if (data?.disabled) catalog.restoreDisabled(data.disabled);
      }
    }

    if (cfg.autoGrantRead) {
      grants.add({ id: "fs.read", ttl: "session", source: "config", grantedAt: Date.now() });
    }
    for (const g of cfg.defaultGrants) {
      grants.add({ ...g, ttl: "session", source: "config", grantedAt: Date.now() });
    }

    const grantFlag = pi.getFlag("grant");
    if (typeof grantFlag === "string" && grantFlag.trim().length > 0) {
      for (const raw of grantFlag.split(",").map((s) => s.trim()).filter(Boolean)) {
        const [id, scope] = raw.split(":");
        if (id && isEffectId(id)) {
          grants.add({ id, scope, ttl: "session", source: "flag", grantedAt: Date.now() });
        }
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
    policy = new Policy(config.deny);

    registerAllTools(ctx);
    replayBranch(ctx, config);
    applyActiveTools();
    updateStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (!config) return;
    replayBranch(ctx, config);
    applyActiveTools();
    updateStatus(ctx);
  });

  pi.on(
    "tool_call",
    createGateHandler({
      catalog,
      grants,
      policy: policyView,
      unknownToolsPolicy,
      onGrant: persistGrant,
      onAudit: (record) => {
        void appendAuditLine(auditPath, record);
      },
    }),
  );

  pi.on("before_agent_start", (event) => {
    return { systemPrompt: event.systemPrompt + buildEffectsPromptSection(grants) };
  });

  registerToolCommand(pi, { catalog, applyActiveTools, persistToolState });
  registerEffectsCommand(pi, { grants, policy: policyView, auditPath, persistGrant, persistRevoke, updateStatus });

  registerEntryRenderers(pi);
}
