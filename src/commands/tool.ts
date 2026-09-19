/**
 * /tool command family: list/toggle/inspect the effect-aware tool catalog.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { REMOVED_TOOLS } from "../effects/gate.ts";
import { effectsLabel, purityBadge } from "../ui/badges.ts";
import { makeHeader } from "../ui/header.ts";
import type { EffectCatalog } from "../tools/define.ts";

export interface ToolCommandDeps {
  catalog: EffectCatalog;
  applyActiveTools: () => void;
  persistToolState: () => void;
}

function summaryLine(catalog: EffectCatalog, name: string): string {
  const entry = catalog.get(name);
  if (!entry) return `${name}: unknown`;
  const enabled = catalog.isEnabled(name) ? "enabled" : "disabled";
  return `${purityBadge(entry.effects)} ${name.padEnd(16)} ${effectsLabel(entry.effects).padEnd(28)} ${enabled}`;
}

export function registerToolCommand(pi: ExtensionAPI, deps: ToolCommandDeps): void {
  pi.registerCommand("tool", {
    description: "List, toggle, or inspect pi-effect tools",
    // IMPORTANT: pi replaces the ENTIRE argument text (everything after
    // "/tool ") with the selected item's `value` — not just the last word
    // being typed. Every value returned here must reconstruct the full
    // "<subcommand> <name>" string, not just the name fragment.
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const spaceIndex = prefix.indexOf(" ");

      if (spaceIndex === -1) {
        const subcommands = ["list", "on", "off", "info"];
        const items = subcommands.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
        return items.length > 0 ? items : null;
      }

      const sub = prefix.slice(0, spaceIndex);
      if (sub !== "on" && sub !== "off" && sub !== "info") return null;

      const namePrefix = prefix.slice(spaceIndex + 1).replace(/^\s+/, "");
      const names = deps.catalog.all().map((e) => e.name);
      const items = names
        .filter((n) => n.startsWith(namePrefix))
        .map((n) => ({ value: `${sub} ${n}`, label: n }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const toolName = rest.join(" ");

      if (!sub) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/tool interactive UI requires TUI mode. Use /tool list instead.", "warning");
          return;
        }
        await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
          const entries = deps.catalog.all().filter((e) => e.group !== "meta");
          const items: SettingItem[] = entries.map((e) => ({
            id: e.name,
            label: `${purityBadge(e.effects)} ${e.name}`,
            description: effectsLabel(e.effects),
            currentValue: deps.catalog.isEnabled(e.name) ? "enabled" : "disabled",
            values: ["enabled", "disabled"],
          }));

          const container = new Container();
          container.addChild(
            makeHeader([
              theme.fg("accent", theme.bold("Tool Configuration")),
              theme.fg("dim", "⚡ = impure   ○ = pure   bash/powershell removed by policy   request_effects always on"),
              "",
            ]),
          );

          const settingsList = new SettingsList(
            items,
            Math.min(items.length + 2, 20),
            getSettingsListTheme(),
            (id, newValue) => {
              deps.catalog.setEnabled(id, newValue === "enabled");
              deps.applyActiveTools();
              deps.persistToolState();
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
        const lines = deps.catalog.all().map((e) => summaryLine(deps.catalog, e.name));
        lines.push(...[...REMOVED_TOOLS].map((n) => `${n}: removed by policy`));
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "on" || sub === "off") {
        if (!toolName) {
          ctx.ui.notify(`Usage: /tool ${sub} <name>`, "warning");
          return;
        }
        if (!deps.catalog.get(toolName)) {
          ctx.ui.notify(`Unknown tool: ${toolName}`, "error");
          return;
        }
        deps.catalog.setEnabled(toolName, sub === "on");
        deps.applyActiveTools();
        deps.persistToolState();
        ctx.ui.notify(`${toolName} ${sub === "on" ? "enabled" : "disabled"}`, "info");
        return;
      }

      if (sub === "info") {
        if (!toolName) {
          ctx.ui.notify("Usage: /tool info <name>", "warning");
          return;
        }
        const entry = deps.catalog.get(toolName);
        if (!entry) {
          ctx.ui.notify(`Unknown tool: ${toolName}`, "error");
          return;
        }
        const lines = [
          `${entry.name} (${entry.group})`,
          entry.description,
          `Purity: ${entry.pure ? "pure (read-only)" : "impure (mutates)"}`,
          `Effects: ${effectsLabel(entry.effects)}`,
          `Enabled: ${deps.catalog.isEnabled(entry.name)}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      ctx.ui.notify(`Unknown /tool subcommand: ${sub}. Use list, on, off, or info.`, "warning");
    },
  });
}
