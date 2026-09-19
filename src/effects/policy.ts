/**
 * Deny policies: rules that win over grants and can never be approved interactively.
 * Pure module — no I/O. Config loading lives in src/config.ts.
 */

import type { Effect } from "./model.ts";
import { covers } from "./model.ts";

export interface DenyRule extends Effect {}

/** Structural interface so callers can hold a live-updating proxy instead of a fixed instance. */
export interface PolicyLike {
  denies(required: Effect): DenyRule[];
  isDenied(required: Effect): boolean;
}

export class Policy implements PolicyLike {
  private readonly deny: readonly DenyRule[];

  constructor(deny: readonly DenyRule[] = []) {
    this.deny = deny;
  }

  /** Returns the deny rules that match `required`, if any (empty array = not denied). */
  denies(required: Effect): DenyRule[] {
    return this.deny.filter((rule) => covers(rule, required));
  }

  isDenied(required: Effect): boolean {
    return this.denies(required).length > 0;
  }
}

export const DEFAULT_DENY_RULES: readonly DenyRule[] = [
  { id: "fs.write", scope: "**/.env*" },
  { id: "fs.write", scope: "**/.ssh/**" },
  { id: "fs.write", scope: "**/.aws/**" },
  { id: "fs.write", scope: "**/.gnupg/**" },
];
