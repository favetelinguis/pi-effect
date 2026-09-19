import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { makeHeader } from "../src/ui/header.ts";

/**
 * Regression for: "Rendered line N exceeds terminal width (95 > 89)." — an
 * uncaught exception that crashes the whole pi process. Every custom
 * Component's render(width) must truncate its own output; pi's TUI does not
 * do it on the component's behalf.
 */
describe("makeHeader", () => {
  test("every rendered line respects the requested width, even for long ANSI-colored text", () => {
    const longLine = "x".repeat(200);
    const header = makeHeader(["\x1b[1mshort\x1b[0m", `\x1b[2m${longLine}\x1b[0m`, ""]);

    for (const width of [10, 40, 80, 89, 95, 120]) {
      const lines = header.render(width);
      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `width ${width}: line visible width ${visibleWidth(line)} exceeds requested width\nline: ${JSON.stringify(line)}`,
        );
      }
    }
  });

  test("does not throw for width 0 or negative-ish edge cases", () => {
    const header = makeHeader(["hello", "world"]);
    assert.doesNotThrow(() => header.render(0));
    assert.doesNotThrow(() => header.render(1));
  });

  test("short lines pass through unchanged", () => {
    const header = makeHeader(["hi", ""]);
    assert.deepEqual(header.render(80), ["hi", ""]);
  });
});
