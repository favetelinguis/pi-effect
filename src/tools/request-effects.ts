/**
 * request_effects: the upfront batch-approval tool. The model calls this once per
 * task with every effect it expects to need and a one-line reason each; the user
 * approves/denies via a checklist (TUI) or sequential confirms (RPC fallback).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ALL_EFFECT_IDS, formatEffect, type Grant } from "../effects/model.ts";
import type { GrantStore } from "../effects/grants.ts";
import type { PolicyLike } from "../effects/policy.ts";
import { requiresGrant } from "../effects/gate.ts";
import { makeHeader } from "../ui/header.ts";
import type { EffectCatalog } from "./define.ts";

const RequestEffectsParams = Type.Object({
  effects: Type.Array(
    Type.Object({
      id: StringEnum(ALL_EFFECT_IDS),
      scope: Type.Optional(Type.String({ description: "Narrowing scope: fs path glob, net host glob, or git 'local'/'remote'." })),
      reason: Type.String({ description: "One sentence: why this is needed for the current task." }),
    }),
  ),
});

type RequestEffectsInput = Static<typeof RequestEffectsParams>;

interface Deps {
  catalog: EffectCatalog;
  grants: GrantStore;
  policy: PolicyLike;
  onGrant: (grant: Grant, ctx: ExtensionContext) => void;
}

function itemKey(id: string, scope?: string): string {
  return scope ? `${id}\u0000${scope}` : id;
}

const CONFIRM_ID = "__confirm__";

async function showChecklist(
  ctx: ExtensionContext,
  requests: RequestEffectsInput["effects"],
): Promise<Map<string, boolean>> {
  const decisions = new Map<string, boolean>();
  for (const r of requests) decisions.set(itemKey(r.id, r.scope), true);

  if (ctx.mode !== "tui") {
    for (const r of requests) {
      const label = r.scope ? `${r.id} (${r.scope})` : r.id;
      const ok = await ctx.ui.confirm(`Grant ${label}?`, r.reason);
      decisions.set(itemKey(r.id, r.scope), ok);
    }
    return decisions;
  }

  // Escape always cancels the whole batch (deny everything), matching every
  // other pi dialog. Confirming requires explicitly activating the "Confirm"
  // row, since SettingsList's only "close" affordance (Escape) is onCancel.
  const confirmed = await ctx.ui.custom<boolean>((_tui, theme, _kb, done) => {
    const items: SettingItem[] = [
      ...requests.map((r) => ({
        id: itemKey(r.id, r.scope),
        label: r.scope ? `${r.id} (${r.scope})` : r.id,
        description: r.reason,
        currentValue: "grant",
        values: ["grant", "skip"],
      })),
      {
        id: CONFIRM_ID,
        label: "✅ Confirm and apply",
        description: "Grant every item still set to \"grant\" above and deny the rest.",
        currentValue: "press enter/space",
        values: ["press enter/space"],
      },
    ];

    const container = new Container();
    container.addChild(
      makeHeader([
        theme.fg("accent", theme.bold("Requested effects")),
        theme.fg("dim", "Enter/Space to toggle grant/skip. Select \"Confirm and apply\" to submit. Esc cancels everything."),
        "",
      ]),
    );

    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, newValue) => {
        if (id === CONFIRM_ID) {
          done(true);
          return;
        }
        decisions.set(id, newValue === "grant");
      },
      () => done(false),
    );

    container.addChild(settingsList);

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        settingsList.handleInput?.(data);
      },
    };
  });

  if (!confirmed) {
    // Cancelled (Escape): deny every requested effect, regardless of what was
    // toggled before cancelling.
    for (const r of requests) decisions.set(itemKey(r.id, r.scope), false);
  }

  return decisions;
}

export function registerRequestEffectsTool(pi: ExtensionAPI, deps: Deps): void {
  deps.catalog.register({
    name: "request_effects",
    label: "Request Effects",
    description: "Request effect grants from the user in a single batch.",
    effects: [],
    pure: true,
    group: "meta",
    defaultEnabled: true,
  });

  pi.registerTool({
    name: "request_effects",
    label: "Request Effects",
    description:
      "Request one or more WRITE effect grants from the user in a single batch, each with a one-sentence reason. " +
      "Read effects (fs.read, git.read, net.read) never need to be requested -- they are always allowed. " +
      `Valid effect ids: ${ALL_EFFECT_IDS.join(", ")}. ` +
      "Call this ONCE per task after exploring with pure tools, listing every write effect the task needs. Do not request effects you will not use.",
    promptSnippet: "Request write-effect grants (fs.write, git.write, net.write) from the user in one batch",
    promptGuidelines: [
      "Read effects (fs.read, git.read, net.read) are always allowed -- never request them. Before making changes, explore with pure tools, then call request_effects ONCE with every write effect the task needs. Do not request effects you will not use.",
      "If a call is blocked with 'not granted', call request_effects with a reason instead of retrying the same call.",
    ],
    parameters: RequestEffectsParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const granted: string[] = [];
      const denied: string[] = [];
      const deniedByPolicy: string[] = [];

      const alreadyAllowed: string[] = [];
      const requestable: RequestEffectsInput["effects"] = [];
      for (const req of params.effects) {
        const denyMatches = deps.policy.denies({ id: req.id, scope: req.scope });
        if (denyMatches.length > 0) {
          deniedByPolicy.push(formatEffect({ id: req.id, scope: req.scope }));
        } else if (!requiresGrant({ id: req.id, scope: req.scope })) {
          // Read effects are never gated -- nothing to ask the user, no grant to create.
          alreadyAllowed.push(formatEffect({ id: req.id, scope: req.scope }));
        } else {
          requestable.push(req);
        }
      }

      if (!ctx.hasUI) {
        const stillNeeded = requestable.map((r) => formatEffect({ id: r.id, scope: r.scope }));
        const lines: string[] = [];
        if (alreadyAllowed.length > 0) {
          lines.push(`Already allowed, no grant needed: ${alreadyAllowed.join(", ")}`);
        }
        if (stillNeeded.length > 0) {
          lines.push(
            `No UI available to grant effects interactively (headless mode). Denied: ${stillNeeded.join(", ")}. Start pi with --grant <effect-ids> or configure defaultGrants in .pi/pi-effect.json.`,
          );
        }
        if (deniedByPolicy.length > 0) {
          lines.push(`Denied by policy (cannot be granted): ${deniedByPolicy.join(", ")}`);
        }
        if (lines.length === 0) lines.push("No effects requested.");
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { granted: [], denied: [...stillNeeded, ...deniedByPolicy] },
        };
      }

      let decisions = new Map<string, boolean>();
      if (requestable.length > 0) {
        decisions = await showChecklist(ctx, requestable);
      }

      for (const req of requestable) {
        const key = itemKey(req.id, req.scope);
        const label = formatEffect({ id: req.id, scope: req.scope });
        if (decisions.get(key)) {
          const grant: Grant = {
            id: req.id,
            scope: req.scope,
            ttl: "session",
            source: "request_effects",
            grantedAt: Date.now(),
            reason: req.reason,
          };
          deps.grants.add(grant);
          deps.onGrant(grant, ctx);
          granted.push(label);
        } else {
          denied.push(label);
        }
      }

      const lines: string[] = [];
      if (alreadyAllowed.length > 0) {
        lines.push(`Already allowed, no grant needed: ${alreadyAllowed.join(", ")}`);
      }
      if (granted.length > 0) lines.push(`Granted: ${granted.join(", ")}`);
      if (denied.length > 0) lines.push(`Denied: ${denied.join(", ")}`);
      if (deniedByPolicy.length > 0) lines.push(`Denied by policy (cannot be granted): ${deniedByPolicy.join(", ")}`);
      if (lines.length === 0) lines.push("No effects requested.");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { granted, denied: [...denied, ...deniedByPolicy] },
      };
    },
  });
}
