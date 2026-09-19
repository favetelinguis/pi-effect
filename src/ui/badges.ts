/**
 * Small formatting helpers shared by /tool, /effects, and the footer status.
 */

import type { Effect } from "../effects/model.ts";
import { formatEffect, isPure } from "../effects/model.ts";

export const PURE_BADGE = "○";
export const IMPURE_BADGE = "⚡";

export function purityBadge(effects: readonly Effect[]): string {
  return isPure(effects) ? PURE_BADGE : IMPURE_BADGE;
}

export function effectsLabel(effects: readonly Effect[]): string {
  if (effects.length === 0) return "(none)";
  return effects.map(formatEffect).join(" | ");
}
