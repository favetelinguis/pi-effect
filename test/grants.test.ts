import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { GrantStore } from "../src/effects/grants.ts";
import type { Grant } from "../src/effects/model.ts";

function grant(partial: Partial<Grant> & Pick<Grant, "id">): Grant {
  return { ttl: "session", source: "command", grantedAt: Date.now(), ...partial };
}

describe("GrantStore", () => {
  test("once grants are never added", () => {
    const store = new GrantStore();
    store.add(grant({ id: "fs.write", ttl: "once" }));
    assert.equal(store.list().length, 0);
    assert.equal(store.covers({ id: "fs.write" }), false);
  });

  test("session grants are added and cover requirements", () => {
    const store = new GrantStore();
    store.add(grant({ id: "fs.read" }));
    assert.equal(store.covers({ id: "fs.read" }), true);
    assert.equal(store.covers({ id: "fs.write" }), false);
  });

  test("revoke removes matching grants (unscoped filter removes all scopes)", () => {
    const store = new GrantStore();
    store.add(grant({ id: "fs.write", scope: "a.ts" }));
    store.add(grant({ id: "fs.write", scope: "b.ts" }));
    const removed = store.revoke({ id: "fs.write" });
    assert.equal(removed.length, 2);
    assert.equal(store.list().length, 0);
  });

  test("revoke with scope only removes exact match", () => {
    const store = new GrantStore();
    store.add(grant({ id: "fs.write", scope: "a.ts" }));
    store.add(grant({ id: "fs.write", scope: "b.ts" }));
    const removed = store.revoke({ id: "fs.write", scope: "a.ts" });
    assert.equal(removed.length, 1);
    assert.equal(store.list().length, 1);
    assert.equal(store.covers({ id: "fs.write", scope: "b.ts" }), true);
  });

  test("clear removes everything", () => {
    const store = new GrantStore();
    store.add(grant({ id: "fs.read" }));
    store.add(grant({ id: "git.read" }));
    store.clear();
    assert.equal(store.list().length, 0);
  });

  test("reset replaces the grant set and drops non-session grants", () => {
    const store = new GrantStore();
    store.add(grant({ id: "fs.read" }));
    store.reset([grant({ id: "git.read" }), grant({ id: "net.read", ttl: "once" })]);
    assert.equal(store.covers({ id: "fs.read" }), false);
    assert.equal(store.covers({ id: "git.read" }), true);
    assert.equal(store.covers({ id: "net.read" }), false);
  });

  test("describe formats granted effects for status display", () => {
    const store = new GrantStore();
    assert.equal(store.describe(), "");
    store.add(grant({ id: "fs.read" }));
    store.add(grant({ id: "git.write", scope: "local" }));
    assert.equal(store.describe(), "fs.read git.write:local");
  });

  test("write grant covers read via writeImpliesRead option threaded through constructor", () => {
    const store = new GrantStore({ writeImpliesRead: true });
    store.add(grant({ id: "fs.write", scope: "src/**" }));
    assert.equal(store.covers({ id: "fs.read", scope: "src/x.ts" }), true);
  });
});
