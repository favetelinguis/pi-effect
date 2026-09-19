import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_EFFECT_IDS,
  covers,
  expandGrant,
  isCoveredBy,
  isEffectId,
  isPure,
  matchesGlob,
  modeOf,
  resourceOf,
  formatEffect,
} from "../src/effects/model.ts";

describe("model basics", () => {
  test("ALL_EFFECT_IDS has 6 entries", () => {
    assert.equal(ALL_EFFECT_IDS.length, 6);
  });

  test("resourceOf / modeOf", () => {
    assert.equal(resourceOf("fs.write"), "fs");
    assert.equal(modeOf("fs.write"), "write");
    assert.equal(resourceOf("git.read"), "git");
    assert.equal(modeOf("net.write"), "write");
  });

  test("isEffectId", () => {
    assert.equal(isEffectId("fs.read"), true);
    assert.equal(isEffectId("fs.exec"), false);
    assert.equal(isEffectId("bogus"), false);
  });

  test("formatEffect", () => {
    assert.equal(formatEffect({ id: "fs.read" }), "fs.read");
    assert.equal(formatEffect({ id: "fs.write", scope: "src/**" }), "fs.write:src/**");
  });
});

describe("isPure", () => {
  test("all-read effects are pure", () => {
    assert.equal(isPure([{ id: "fs.read" }, { id: "git.read" }]), true);
  });

  test("any write effect makes it impure", () => {
    assert.equal(isPure([{ id: "fs.read" }, { id: "fs.write" }]), false);
  });

  test("no effects at all is pure (vacuously)", () => {
    assert.equal(isPure([]), true);
  });
});

describe("matchesGlob", () => {
  test("exact match", () => {
    assert.equal(matchesGlob("src/foo.ts", "src/foo.ts"), true);
    assert.equal(matchesGlob("src/foo.ts", "src/bar.ts"), false);
  });

  test("single star does not cross slash", () => {
    assert.equal(matchesGlob("src/*.ts", "src/foo.ts"), true);
    assert.equal(matchesGlob("src/*.ts", "src/nested/foo.ts"), false);
  });

  test("double star crosses slashes", () => {
    assert.equal(matchesGlob("src/**/*.ts", "src/a/b/c.ts"), true);
    assert.equal(matchesGlob("**/.env*", ".env"), true);
    assert.equal(matchesGlob("**/.env*", "a/b/.env.local"), true);
    assert.equal(matchesGlob("**/.env*", "a/b/env"), false);
  });

  test("bare star or double-star matches everything", () => {
    assert.equal(matchesGlob("*", "anything/at/all"), true);
    assert.equal(matchesGlob("**", "anything/at/all"), true);
  });

  test("host globs", () => {
    assert.equal(matchesGlob("*.example.com", "api.example.com"), true);
    assert.equal(matchesGlob("*.example.com", "example.com"), false);
  });
});

describe("covers", () => {
  test("different id never covers", () => {
    assert.equal(covers({ id: "fs.read" }, { id: "fs.write" }), false);
  });

  test("unscoped grant covers any requirement for that id", () => {
    assert.equal(covers({ id: "fs.write" }, { id: "fs.write", scope: "src/x.ts" }), true);
    assert.equal(covers({ id: "fs.write" }, { id: "fs.write" }), true);
  });

  test("scoped grant only covers matching scoped requirement", () => {
    assert.equal(covers({ id: "fs.write", scope: "src/**" }, { id: "fs.write", scope: "src/x.ts" }), true);
    assert.equal(covers({ id: "fs.write", scope: "src/**" }, { id: "fs.write", scope: "test/x.ts" }), false);
  });

  test("scoped grant never covers an unscoped requirement", () => {
    assert.equal(covers({ id: "fs.write", scope: "src/**" }, { id: "fs.write" }), false);
  });
});

describe("expandGrant / write implies read", () => {
  test("write grant expands to matching read by default", () => {
    const expanded = expandGrant({ id: "fs.write", scope: "src/x.ts" });
    assert.deepEqual(expanded, [
      { id: "fs.write", scope: "src/x.ts" },
      { id: "fs.read", scope: "src/x.ts" },
    ]);
  });

  test("read grant does not expand", () => {
    const expanded = expandGrant({ id: "fs.read" });
    assert.deepEqual(expanded, [{ id: "fs.read" }]);
  });

  test("writeImpliesRead: false disables expansion", () => {
    const expanded = expandGrant({ id: "fs.write" }, { writeImpliesRead: false });
    assert.deepEqual(expanded, [{ id: "fs.write" }]);
  });
});

describe("isCoveredBy", () => {
  test("write grant covers a read requirement via write-implies-read", () => {
    assert.equal(isCoveredBy({ id: "fs.read", scope: "src/x.ts" }, [{ id: "fs.write", scope: "src/**" }]), true);
  });

  test("read grant never covers a write requirement", () => {
    assert.equal(isCoveredBy({ id: "fs.write" }, [{ id: "fs.read" }]), false);
  });

  test("empty grants cover nothing", () => {
    assert.equal(isCoveredBy({ id: "fs.read" }, []), false);
  });
});
