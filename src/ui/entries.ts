/**
 * Entry renderers: turn pi-effect:* custom entries into transcript lines. These
 * entries never reach the LLM — this is purely the human-facing audit trail.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Effect, Grant } from "../effects/model.ts";
import { formatEffect } from "../effects/model.ts";

export function registerEntryRenderers(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<Grant>("pi-effect:grant", (entry, _options, theme) => {
    const grant = entry.data;
    if (!grant) return new Text(theme.fg("dim", "pi-effect: grant"), 0, 0);
    const scope = formatEffect(grant);
    const reason = grant.reason ? theme.fg("dim", ` — "${grant.reason}"`) : "";
    return new Text(`${theme.fg("success", "✓ granted")} ${theme.bold(scope)} ${theme.fg("muted", `(${grant.source})`)}${reason}`, 0, 0);
  });

  pi.registerEntryRenderer<Effect>("pi-effect:revoke", (entry, _options, theme) => {
    const effect = entry.data;
    if (!effect) return new Text(theme.fg("dim", "pi-effect: revoke"), 0, 0);
    return new Text(`${theme.fg("warning", "✗ revoked")} ${theme.bold(formatEffect(effect))}`, 0, 0);
  });

  pi.registerEntryRenderer<{ disabled: string[] }>("pi-effect:tools", (entry, _options, theme) => {
    const data = entry.data;
    const disabled = data?.disabled ?? [];
    const text = disabled.length > 0 ? `disabled: ${disabled.join(", ")}` : "all tools enabled";
    return new Text(`${theme.fg("accent", "⚙ tools")} ${theme.fg("muted", text)}`, 0, 0);
  });
}
