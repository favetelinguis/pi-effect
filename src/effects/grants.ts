/**
 * GrantStore: the set of effect grants active for the current session.
 *
 * Only "session" grants live here — "once" grants are never added to the store
 * (the gate allows the single call and moves on without persisting anything).
 * Pure in-memory data structure; persistence (appendEntry) and replay from the
 * session branch are the caller's responsibility (see src/index.ts).
 */

import type { Effect, EffectModelOptions, Grant } from "./model.ts";
import { formatEffect, isCoveredBy } from "./model.ts";

export class GrantStore {
  private grants: Grant[] = [];
  private readonly options: EffectModelOptions;

  constructor(options: EffectModelOptions = {}) {
    this.options = options;
  }

  /** All grants currently held (session ttl only). */
  list(): readonly Grant[] {
    return this.grants;
  }

  add(grant: Grant): void {
    if (grant.ttl !== "session") return;
    this.grants.push(grant);
  }

  /** Replace the whole grant set, e.g. when replaying branch history at session_start. */
  reset(grants: readonly Grant[]): void {
    this.grants = grants.filter((g) => g.ttl === "session").slice();
  }

  clear(): void {
    this.grants = [];
  }

  /**
   * Revoke grants matching `effect.id`. If `effect.scope` is given, only grants with
   * an exact matching scope are removed; if omitted, every grant for that id is removed
   * (scoped or not).
   */
  revoke(effect: Effect): Grant[] {
    const removed: Grant[] = [];
    this.grants = this.grants.filter((g) => {
      const matches = g.id === effect.id && (effect.scope === undefined || g.scope === effect.scope);
      if (matches) removed.push(g);
      return !matches;
    });
    return removed;
  }

  covers(required: Effect): boolean {
    return isCoveredBy(required, this.grants, this.options);
  }

  /** Human-readable summary of currently granted effects, for footer/status display. */
  describe(): string {
    if (this.grants.length === 0) return "";
    return this.grants.map((g) => formatEffect(g)).join(" ");
  }
}
