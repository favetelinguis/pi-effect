/**
 * The gate: a pure decision function plus a thin async adapter that wires it to
 * pi's `tool_call` event. Keeping `decide()` pure and synchronous makes the whole
 * decision table exhaustively testable without any pi runtime.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { Effect } from "./model.ts";
import { formatEffect, modeOf } from "./model.ts";
import type { GrantStore } from "./grants.ts";
import type { PolicyLike } from "./policy.ts";
import type { EffectCatalog, EffectToolEntry } from "../tools/define.ts";

/** Tool names removed entirely by pi-effect policy. No escape hatch. */
export const REMOVED_TOOLS = new Set(["bash", "powershell"]);

/**
 * The grant/prompt system exists to gate irreversible side effects, not to gate
 * observation. Only write-mode effects are ever "missing" and can trigger a JIT
 * prompt, a block, or show up in request_effects. Read-mode effects (fs.read,
 * git.read, net.read) are always allowed once they clear policy deny rules --
 * pure tools work with zero prompts, unconditionally, no grant or config needed.
 */
export function requiresGrant(effect: Effect): boolean {
  return modeOf(effect.id) === "write";
}

export type UnknownToolsPolicy = "warn" | "block" | "allow";

export type GateDecision =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "prompt"; missing: readonly Effect[]; entry: EffectToolEntry };

export interface DecideInput {
  toolName: string;
  entry: EffectToolEntry | undefined;
  isEnabled: boolean;
  required: readonly Effect[];
  deniedBy: (effect: Effect) => Effect[];
  covers: (effect: Effect) => boolean;
  hasUI: boolean;
  unknownToolsPolicy: UnknownToolsPolicy;
}

export function decide(input: DecideInput): GateDecision {
  if (REMOVED_TOOLS.has(input.toolName)) {
    return {
      kind: "block",
      reason: `The "${input.toolName}" tool has been removed by pi-effect policy. There is no shell. Use the structured tools instead (read/grep/find/ls/edit/write/git_*/http_request).`,
    };
  }

  if (!input.entry) {
    if (input.unknownToolsPolicy === "block") {
      return {
        kind: "block",
        reason: `Tool "${input.toolName}" is not classified by pi-effect and unknownTools policy is "block".`,
      };
    }
    // "warn" and "allow" both pass the call through; "warn" surfaces via ctx.ui.notify
    // in the adapter, not in this pure decision.
    return { kind: "allow" };
  }

  if (!input.isEnabled) {
    return {
      kind: "block",
      reason: `Tool "${input.toolName}" is disabled via /tool. Enable it with "/tool on ${input.toolName}" or ask the user to.`,
    };
  }

  const deniedEffects: Effect[] = [];
  for (const effect of input.required) {
    if (input.deniedBy(effect).length > 0) deniedEffects.push(effect);
  }
  if (deniedEffects.length > 0) {
    const list = deniedEffects.map(formatEffect).join(", ");
    return {
      kind: "block",
      reason: `Effect(s) ${list} are denied by policy for this call and can never be granted interactively. Ask the user to change the tool's parameters or the pi-effect config.`,
    };
  }

  const missing = input.required.filter((e) => requiresGrant(e) && !input.covers(e));
  if (missing.length === 0) {
    return { kind: "allow" };
  }

  if (!input.hasUI) {
    const list = missing.map(formatEffect).join(", ");
    return {
      kind: "block",
      reason: `Effect(s) ${list} not granted and no UI is available to prompt for them. Call request_effects, or start pi with --grant ${missing.map((e) => e.id).join(",")}.`,
    };
  }

  return { kind: "prompt", missing, entry: input.entry };
}

export interface GateDeps {
  catalog: EffectCatalog;
  grants: GrantStore;
  policy: PolicyLike;
  /** Function so callers can reflect config that may change (e.g. after /reload). */
  unknownToolsPolicy: () => UnknownToolsPolicy;
  /** Called for every session-ttl grant so the caller can persist + notify. Never called for "once". */
  onGrant: (grant: import("./model.ts").Grant, ctx: ExtensionContext) => void;
  onAudit?: (record: AuditRecord) => void;
}

export interface AuditRecord {
  toolName: string;
  effects: readonly Effect[];
  allowed: boolean;
  reason?: string;
  at: number;
}

/** Build the `tool_call` handler wired to real pi objects. */
export function createGateHandler(deps: GateDeps) {
  return async (event: ToolCallEvent, ctx: ExtensionContext) => {
    const entry = deps.catalog.get(event.toolName);
    const required = entry ? (entry.effectsFor ? entry.effectsFor(event.input as never) : entry.effects) : [];

    const decision = decide({
      toolName: event.toolName,
      entry,
      isEnabled: entry ? deps.catalog.isEnabled(event.toolName) : true,
      required,
      deniedBy: (effect) => deps.policy.denies(effect),
      covers: (effect) => deps.grants.covers(effect),
      hasUI: ctx.hasUI,
      unknownToolsPolicy: deps.unknownToolsPolicy(),
    });

    if (!entry && deps.unknownToolsPolicy() === "warn") {
      ctx.ui.notify(
        `pi-effect: tool "${event.toolName}" is not classified; allowing without effect checks.`,
        "warning",
      );
    }

    if (decision.kind === "allow") {
      deps.onAudit?.({ toolName: event.toolName, effects: required, allowed: true, at: Date.now() });
      return undefined;
    }

    if (decision.kind === "block") {
      deps.onAudit?.({
        toolName: event.toolName,
        effects: required,
        allowed: false,
        reason: decision.reason,
        at: Date.now(),
      });
      return { block: true, reason: decision.reason };
    }

    // decision.kind === "prompt"
    const missingList = decision.missing.map(formatEffect).join(", ");
    const choice = await ctx.ui.select(
      `${event.toolName} needs: ${missingList}`,
      ["Allow once", "Allow for session", "Deny"],
    );

    if (choice === "Deny" || choice === undefined) {
      const reason = `Denied by user. Ask the user for approval, or call request_effects with a reason for: ${missingList}.`;
      deps.onAudit?.({ toolName: event.toolName, effects: required, allowed: false, reason, at: Date.now() });
      return { block: true, reason };
    }

    const ttl = choice === "Allow for session" ? "session" : "once";
    for (const effect of decision.missing) {
      if (ttl === "session") {
        const grant: import("./model.ts").Grant = {
          id: effect.id,
          scope: effect.scope,
          ttl: "session",
          source: "jit",
          grantedAt: Date.now(),
          reason: `JIT approval for ${event.toolName}`,
        };
        deps.grants.add(grant);
        deps.onGrant(grant, ctx);
      }
    }

    deps.onAudit?.({ toolName: event.toolName, effects: required, allowed: true, at: Date.now() });
    return undefined;
  };
}

/** Register the gate + bash removal on an ExtensionAPI. */
export function registerGate(pi: ExtensionAPI, deps: GateDeps): void {
  pi.on("tool_call", createGateHandler(deps) as never);
}
