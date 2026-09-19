/**
 * Core effect model: the vocabulary of user-facing capabilities that tools declare
 * and that the user grants. This module has zero side effects and zero imports from
 * node built-ins — it is pure data + pure functions so it is trivial to unit test.
 */

export type Resource = "fs" | "git" | "net";
export type Mode = "read" | "write";
export type EffectId = `${Resource}.${Mode}`;

export const ALL_RESOURCES: readonly Resource[] = ["fs", "git", "net"];
export const ALL_MODES: readonly Mode[] = ["read", "write"];

export const ALL_EFFECT_IDS: readonly EffectId[] = ALL_RESOURCES.flatMap((r) =>
  ALL_MODES.map((m) => `${r}.${m}` as EffectId),
);

export function resourceOf(id: EffectId): Resource {
  return id.split(".")[0] as Resource;
}

export function modeOf(id: EffectId): Mode {
  return id.split(".")[1] as Mode;
}

export function isEffectId(value: string): value is EffectId {
  return (ALL_EFFECT_IDS as readonly string[]).includes(value);
}

/** A single effect requirement: a resource+mode pair, optionally scoped. */
export interface Effect {
  id: EffectId;
  /**
   * Optional narrowing. Semantics depend on resource:
   * - fs: a glob against an absolute or repo-relative path
   * - net: a glob against a hostname
   * - git: "local" | "remote" (git.write only)
   */
  scope?: string;
}

export type GrantTtl = "once" | "session";
export type GrantSource = "request_effects" | "jit" | "command" | "config" | "flag";

export interface Grant extends Effect {
  ttl: GrantTtl;
  source: GrantSource;
  grantedAt: number;
  /** Free-text reason, shown in the transcript / audit log. */
  reason?: string;
}

export interface EffectModelOptions {
  /** write implies read within the same resource. Default: true. */
  writeImpliesRead?: boolean;
}

const DEFAULT_OPTIONS: Required<EffectModelOptions> = {
  writeImpliesRead: true,
};

/** A tool is pure iff every effect it can ever produce has mode "read". */
export function isPure(effects: readonly Effect[]): boolean {
  return effects.every((e) => modeOf(e.id) === "read");
}

/**
 * Glob matcher for scopes. Supports `*` (any run of non-separator chars) and `**`
 * (any run of chars including separators). No dependency on minimatch to keep
 * this module dependency-free and trivially testable.
 */
export function matchesGlob(glob: string, value: string): boolean {
  if (glob === "*" || glob === "**") return true;
  const pattern = globToRegExp(glob);
  return pattern.test(value);
}

function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        // consume an optional following slash so "**/x" matches "x" too
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  out += "$";
  return new RegExp(out);
}

/**
 * Does `grant` cover `required`?
 *
 * - Different effect id -> no (unless writeImpliesRead expands write grants to also
 *   cover the matching read id, handled by the caller via expandGrant()).
 * - Grant with no scope covers any requirement for that effect id (scoped or not).
 * - Grant with scope covers a requirement only if the requirement has a scope and
 *   the grant's scope glob matches it. An unscoped requirement is only covered by
 *   an unscoped grant.
 */
export function covers(grant: Effect, required: Effect): boolean {
  if (grant.id !== required.id) return false;
  if (grant.scope === undefined) return true;
  if (required.scope === undefined) return false;
  return matchesGlob(grant.scope, required.scope);
}

/** Expand a grant to the set of effects it actually satisfies (write -> +read). */
export function expandGrant(grant: Effect, options: EffectModelOptions = {}): Effect[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const out: Effect[] = [grant];
  if (opts.writeImpliesRead && modeOf(grant.id) === "write") {
    const readId = `${resourceOf(grant.id)}.read` as EffectId;
    out.push({ id: readId, scope: grant.scope });
  }
  return out;
}

/** Does any of `grants` (after expansion) cover `required`? */
export function isCoveredBy(
  required: Effect,
  grants: readonly Effect[],
  options: EffectModelOptions = {},
): boolean {
  for (const grant of grants) {
    for (const expanded of expandGrant(grant, options)) {
      if (covers(expanded, required)) return true;
    }
  }
  return false;
}

export function formatEffect(effect: Effect): string {
  return effect.scope ? `${effect.id}:${effect.scope}` : effect.id;
}
