/**
 * /effects command family: inspect, grant, and revoke effect grants.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { ALL_EFFECT_IDS, formatEffect, isEffectId, type Effect, type Grant } from "../effects/model.ts";
import type { GrantStore } from "../effects/grants.ts";
import type { PolicyLike } from "../effects/policy.ts";
import { readAuditLines } from "../caps/audit.ts";

export interface EffectsCommandDeps {
  grants: GrantStore;
  policy: PolicyLike;
  auditPath: string;
  persistGrant: (grant: Grant, ctx: ExtensionContext) => void;
  persistRevoke: (effect: Effect, ctx: ExtensionContext) => void;
  updateStatus: (ctx: ExtensionContext) => void;
}

function parseEffectArgs(args: string): { id: string; scope?: string } | undefined {
  const [id, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (!id) return undefined;
  const scope = rest.length > 0 ? rest.join(" ") : undefined;
  return { id, scope };
}

export function registerEffectsCommand(pi: ExtensionAPI, deps: EffectsCommandDeps): void {
  pi.registerCommand("effects", {
    description: "Inspect, grant, or revoke pi-effect capability grants",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const [sub, ...rest] = prefix.split(" ");
      const subcommands = ["list", "grant", "revoke", "clear", "log"];
      if (rest.length === 0 && !prefix.includes(" ")) {
        const items = subcommands.filter((s) => s.startsWith(sub ?? "")).map((s) => ({ value: s, label: s }));
        return items.length > 0 ? items : null;
      }
      if (sub === "grant" || sub === "revoke") {
        const idPrefix = rest.join(" ");
        const items = ALL_EFFECT_IDS.filter((id) => id.startsWith(idPrefix)).map((id) => ({ value: id, label: id }));
        return items.length > 0 ? items : null;
      }
      return null;
    },
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const restArgs = rest.join(" ");

      if (!sub) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/effects interactive UI requires TUI mode. Use /effects list instead.", "warning");
          return;
        }
        await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
          const items: SettingItem[] = ALL_EFFECT_IDS.map((id) => ({
            id,
            label: id,
            currentValue: deps.grants.covers({ id }) ? "granted" : "not granted",
            values: ["granted", "not granted"],
          }));

          const container = new Container();
          container.addChild({
            render() {
              return [theme.fg("accent", theme.bold("Effect Grants (unscoped)")), theme.fg("dim", "Toggle unscoped session grants. Use /effects grant/revoke for scoped grants."), ""];
            },
            invalidate() {},
          });

          const settingsList = new SettingsList(
            items,
            Math.min(items.length + 2, 15),
            getSettingsListTheme(),
            (id, newValue) => {
              if (newValue === "granted") {
                const grant: Grant = { id: id as never, ttl: "session", source: "command", grantedAt: Date.now() };
                deps.grants.add(grant);
                deps.persistGrant(grant, ctx);
              } else {
                deps.grants.revoke({ id: id as never });
                deps.persistRevoke({ id: id as never }, ctx);
              }
              deps.updateStatus(ctx);
            },
            () => done(undefined),
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
        return;
      }

      if (sub === "list") {
        const list = deps.grants.list();
        if (list.length === 0) {
          ctx.ui.notify("No active grants.", "info");
          return;
        }
        const lines = list.map(
          (g) => `${formatEffect(g)} — ${g.source}${g.reason ? ` ("${g.reason}")` : ""} @ ${new Date(g.grantedAt).toLocaleTimeString()}`,
        );
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "grant") {
        const parsed = parseEffectArgs(restArgs);
        if (!parsed || !isEffectId(parsed.id)) {
          ctx.ui.notify(`Usage: /effects grant <id> [scope]. Valid ids: ${ALL_EFFECT_IDS.join(", ")}`, "warning");
          return;
        }
        const effect: Effect = { id: parsed.id, scope: parsed.scope };
        if (deps.policy.denies(effect).length > 0) {
          ctx.ui.notify(`${formatEffect(effect)} is denied by policy and cannot be granted.`, "error");
          return;
        }
        const grant: Grant = { ...effect, ttl: "session", source: "command", grantedAt: Date.now() };
        deps.grants.add(grant);
        deps.persistGrant(grant, ctx);
        deps.updateStatus(ctx);
        ctx.ui.notify(`Granted ${formatEffect(effect)} for this session.`, "info");
        return;
      }

      if (sub === "revoke") {
        const parsed = parseEffectArgs(restArgs);
        if (!parsed || !isEffectId(parsed.id)) {
          ctx.ui.notify(`Usage: /effects revoke <id> [scope]. Valid ids: ${ALL_EFFECT_IDS.join(", ")}`, "warning");
          return;
        }
        const effect: Effect = { id: parsed.id, scope: parsed.scope };
        const removed = deps.grants.revoke(effect);
        deps.persistRevoke(effect, ctx);
        deps.updateStatus(ctx);
        ctx.ui.notify(removed.length > 0 ? `Revoked ${formatEffect(effect)}.` : `No matching grant for ${formatEffect(effect)}.`, "info");
        return;
      }

      if (sub === "clear") {
        const current = [...deps.grants.list()];
        for (const g of current) {
          deps.grants.revoke({ id: g.id, scope: g.scope });
          deps.persistRevoke({ id: g.id, scope: g.scope }, ctx);
        }
        deps.updateStatus(ctx);
        ctx.ui.notify(`Cleared ${current.length} grant(s). Pure effects will re-prompt on next use unless auto-granted.`, "info");
        return;
      }

      if (sub === "log") {
        const lines = await readAuditLines(deps.auditPath, 20);
        ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No audit log entries yet.", "info");
        return;
      }

      ctx.ui.notify(`Unknown /effects subcommand: ${sub}. Use list, grant, revoke, clear, or log.`, "warning");
    },
  });
}
