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

/**
 * Accepts both notations so users can copy-paste what they see on screen:
 *   /effects revoke fs.write:.gitignore   (colon form, matches formatEffect() display)
 *   /effects revoke fs.write .gitignore   (space form)
 *   /effects revoke fs.write              (no scope: matches every scope for that id)
 */
function parseEffectArgs(args: string): { id: string; scope?: string } | undefined {
  const trimmed = args.trim();
  if (!trimmed) return undefined;
  const [first, ...rest] = trimmed.split(/\s+/).filter(Boolean);
  if (!first) return undefined;

  const colonIndex = first.indexOf(":");
  if (colonIndex !== -1) {
    const idPart = first.slice(0, colonIndex);
    if (isEffectId(idPart)) {
      const scopeFromColon = first.slice(colonIndex + 1);
      const restScope = rest.length > 0 ? rest.join(" ") : undefined;
      const scope = [scopeFromColon, restScope].filter((s) => s && s.length > 0).join(" ") || undefined;
      return { id: idPart, scope };
    }
  }

  const scope = rest.length > 0 ? rest.join(" ") : undefined;
  return { id: first, scope };
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
          // Active grants first (including scoped ones like fs.write:.gitignore) so
          // they're directly toggleable, not just visible via /effects list.
          const activeItems: SettingItem[] = deps.grants.list().map((g) => ({
            id: `active\u0000${formatEffect(g)}`,
            label: formatEffect(g),
            description: `${g.source}${g.reason ? ` — "${g.reason}"` : ""}`,
            currentValue: "granted",
            values: ["granted", "revoke"],
          }));

          // Base unscoped ids, so ungranted effects can be granted from here too.
          const baseItems: SettingItem[] = ALL_EFFECT_IDS.filter((id) => !deps.grants.list().some((g) => g.id === id && g.scope === undefined)).map((id) => ({
            id: `base\u0000${id}`,
            label: id,
            currentValue: "not granted",
            values: ["not granted", "granted (unscoped)"],
          }));

          const items = [...activeItems, ...baseItems];

          const container = new Container();
          container.addChild({
            render() {
              return [
                theme.fg("accent", theme.bold("Effect Grants")),
                theme.fg("dim", "Enter/Space to toggle. Active grants (incl. scoped) revoke directly; base ids grant unscoped. Esc closes."),
                "",
              ];
            },
            invalidate() {},
          });

          const settingsList = new SettingsList(
            items,
            Math.min(items.length + 2, 18),
            getSettingsListTheme(),
            (rowId, newValue) => {
              const [kind, payload] = rowId.split("\u0000");
              if (kind === "active") {
                // payload is the formatEffect() string; parse it back into id[:scope].
                const colonIndex = payload.indexOf(":");
                const id = colonIndex === -1 ? payload : payload.slice(0, colonIndex);
                const scope = colonIndex === -1 ? undefined : payload.slice(colonIndex + 1);
                if (newValue === "revoke") {
                  deps.grants.revoke({ id: id as never, scope });
                  deps.persistRevoke({ id: id as never, scope }, ctx);
                  deps.updateStatus(ctx);
                  ctx.ui.notify(`Revoked ${payload}. Reopen /effects to see the updated list.`, "info");
                  done(undefined); // the grant list changed shape; SettingsList can't remove rows in place
                }
              } else {
                const id = payload;
                if (newValue === "granted (unscoped)") {
                  const grant: Grant = { id: id as never, ttl: "session", source: "command", grantedAt: Date.now() };
                  deps.grants.add(grant);
                  deps.persistGrant(grant, ctx);
                  deps.updateStatus(ctx);
                  ctx.ui.notify(`Granted ${id} for this session. Reopen /effects to see the updated list.`, "info");
                  done(undefined);
                }
              }
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
          (g) =>
            `${formatEffect(g)} — ${g.source}${g.reason ? ` ("${g.reason}")` : ""} @ ${new Date(g.grantedAt).toLocaleTimeString()}` +
            `  →  /effects revoke ${formatEffect(g)}`,
        );
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "grant") {
        const parsed = parseEffectArgs(restArgs);
        if (!parsed || !isEffectId(parsed.id)) {
          ctx.ui.notify(
            `Usage: /effects grant <id>[:<scope>]  or  /effects grant <id> <scope>\nValid ids: ${ALL_EFFECT_IDS.join(", ")}`,
            "warning",
          );
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
          ctx.ui.notify(
            `Usage: /effects revoke <id>[:<scope>]  or  /effects revoke <id> <scope>\n` +
              `Omit the scope to revoke every scope for that id at once (e.g. "/effects revoke fs.write" removes fs.write:.gitignore too).\n` +
              `See exact grants with /effects list. Valid ids: ${ALL_EFFECT_IDS.join(", ")}`,
            "warning",
          );
          return;
        }
        const effect: Effect = { id: parsed.id, scope: parsed.scope };
        const removed = deps.grants.revoke(effect);
        deps.persistRevoke(effect, ctx);
        deps.updateStatus(ctx);
        if (removed.length > 0) {
          ctx.ui.notify(`Revoked ${removed.map(formatEffect).join(", ")}.`, "info");
        } else {
          ctx.ui.notify(
            `No matching grant for ${formatEffect(effect)}. Run /effects list to see exact scopes, or /effects revoke ${parsed.id} (no scope) to remove all of them.`,
            "warning",
          );
        }
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
