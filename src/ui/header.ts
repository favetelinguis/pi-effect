/**
 * Shared header component for our ctx.ui.custom() dialogs (/tool, /effects,
 * request_effects). Every custom Component's render(width) MUST truncate its
 * own output — pi's TUI does not truncate on a component's behalf, and an
 * over-width line crashes the whole process (uncaught "Rendered line exceeds
 * terminal width"). Centralizing this in one place means every dialog header
 * gets width-safety for free instead of three copies that can each drift.
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** A header is a fixed list of already-themed (ANSI-colored) lines, one per array entry. */
export function makeHeader(lines: readonly string[]): Component {
  return {
    render(width: number): string[] {
      return lines.map((line) => truncateToWidth(line, width));
    },
    invalidate() {},
  };
}
