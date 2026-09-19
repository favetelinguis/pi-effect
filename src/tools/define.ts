/**
 * defineEffectTool / registerEffectTool / EffectCatalog
 *
 * The catalog is the single source of truth for "what tools exist, what effects do
 * they carry, are they enabled" — used by /tool, /effects, the gate, and the system
 * prompt section.
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import type { Effect } from "../effects/model.ts";
import { isPure } from "../effects/model.ts";

export interface EffectToolDefinition<P extends TSchema, D = unknown> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: P;
  /** Static superset of effects this tool can ever produce. */
  effects: readonly Effect[];
  /** Optional exact effects for a given call. Must be a subset of `effects`. */
  effectsFor?: (params: Static<P>) => Effect[];
  execute: (
    params: Static<P>,
    ctx: ExtensionContext,
    extra: { toolCallId: string; signal: AbortSignal | undefined },
  ) => Promise<AgentToolResult<D>>;
  renderCall?: ToolDefinition<P, D>["renderCall"];
  renderResult?: ToolDefinition<P, D>["renderResult"];
  /** Defaults: pure -> "parallel", impure -> "sequential". */
  executionMode?: "parallel" | "sequential";
  /** Enabled at session start unless the user toggled it off. Default true. */
  defaultEnabled?: boolean;
  /** Free-form grouping for /tool ("fs", "git", "http", "meta"). */
  group?: string;
}

export function defineEffectTool<P extends TSchema, D>(
  def: EffectToolDefinition<P, D>,
): EffectToolDefinition<P, D> {
  // Defense in depth: assert effectsFor's declared shape never exceeds the static
  // superset. We can't check every possible input here, but we can sanity-check
  // that the tool author didn't declare an empty static set while defining effectsFor.
  if (def.effectsFor && def.effects.length === 0) {
    throw new Error(`pi-effect: tool "${def.name}" declares effectsFor() but an empty static effects[] superset.`);
  }
  return def;
}

/** Throws if `effects` is not a subset of `superset` (by id, ignoring scope). */
export function assertSubset(toolName: string, superset: readonly Effect[], effects: readonly Effect[]): void {
  const allowed = new Set(superset.map((e) => e.id));
  for (const effect of effects) {
    if (!allowed.has(effect.id)) {
      throw new Error(
        `pi-effect: tool "${toolName}" effectsFor() returned "${effect.id}" which is not in its declared static effects[].`,
      );
    }
  }
}

export interface EffectToolEntry {
  name: string;
  label: string;
  description: string;
  effects: readonly Effect[];
  effectsFor?: (params: unknown) => Effect[];
  pure: boolean;
  group: string;
  defaultEnabled: boolean;
}

/** Registry of every effect-aware tool, plus the enabled/disabled toggle state. */
export class EffectCatalog {
  private entries = new Map<string, EffectToolEntry>();
  private disabled = new Set<string>();

  register(entry: EffectToolEntry): void {
    this.entries.set(entry.name, entry);
    if (!entry.defaultEnabled) this.disabled.add(entry.name);
  }

  get(name: string): EffectToolEntry | undefined {
    return this.entries.get(name);
  }

  all(): EffectToolEntry[] {
    return [...this.entries.values()];
  }

  isEnabled(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) return true; // unclassified tools are not managed by /tool
    return !this.disabled.has(name);
  }

  setEnabled(name: string, enabled: boolean): void {
    if (!this.entries.has(name)) return;
    if (enabled) this.disabled.delete(name);
    else this.disabled.add(name);
  }

  enabledNames(): string[] {
    return this.all()
      .filter((e) => this.isEnabled(e.name))
      .map((e) => e.name);
  }

  disabledNames(): string[] {
    return [...this.disabled];
  }

  /** Restore disabled-set from a persisted list of names that should be DISABLED. */
  restoreDisabled(names: readonly string[]): void {
    this.disabled = new Set(names.filter((n) => this.entries.has(n)));
  }
}

/**
 * Translate an EffectToolDefinition into a real pi.registerTool() call, wrapping
 * execute() so it re-checks grants right before running (defense in depth beyond
 * the tool_call gate).
 */
export function registerEffectTool<P extends TSchema, D>(
  pi: ExtensionAPI,
  catalog: EffectCatalog,
  def: EffectToolDefinition<P, D>,
  runtimeCheck: (toolName: string, params: unknown) => { ok: true } | { ok: false; reason: string },
): void {
  const pure = isPure(def.effects);
  catalog.register({
    name: def.name,
    label: def.label,
    description: def.description,
    effects: def.effects,
    effectsFor: def.effectsFor as ((params: unknown) => Effect[]) | undefined,
    pure,
    group: def.group ?? "misc",
    defaultEnabled: def.defaultEnabled ?? true,
  });

  const effectsSuffix = def.effects.length > 0 ? ` Effects: ${def.effects.map((e) => e.id).join(", ")}.` : "";

  pi.registerTool({
    name: def.name,
    label: def.label,
    description: `${def.description}${effectsSuffix}`,
    promptSnippet: def.promptSnippet,
    promptGuidelines: def.promptGuidelines,
    parameters: def.parameters,
    executionMode: def.executionMode ?? (pure ? "parallel" : "sequential"),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const check = runtimeCheck(def.name, params);
      if (!check.ok) {
        throw new Error(check.reason);
      }
      return def.execute(params, ctx, { toolCallId, signal });
    },
    renderCall: def.renderCall,
    renderResult: def.renderResult,
  } as ToolDefinition<P, D>);
}

export interface BuiltinEffectMeta<P extends TSchema, D> {
  effects: readonly Effect[];
  effectsFor?: (params: Static<P>) => Effect[];
  group: string;
  defaultEnabled?: boolean;
  /** Overrides for prompt metadata; built-in tools don't carry these when overridden. */
  promptSnippet?: string;
  promptGuidelines?: string[];
}

/**
 * Re-register a built-in tool definition (from createReadToolDefinition() and
 * friends) unchanged, except for: description suffix ("Effects: ..."),
 * promptSnippet/promptGuidelines (not inherited by pi when overriding built-ins),
 * executionMode default, catalog registration, and a runtime grant re-check
 * wrapped around the untouched built-in execute/renderCall/renderResult.
 */
export function registerBuiltinTool<P extends TSchema, D>(
  pi: ExtensionAPI,
  catalog: EffectCatalog,
  name: string,
  builtin: ToolDefinition<P, D>,
  meta: BuiltinEffectMeta<P, D>,
  runtimeCheck: (toolName: string, params: unknown) => { ok: true } | { ok: false; reason: string },
): void {
  const pure = isPure(meta.effects);
  catalog.register({
    name,
    label: builtin.label,
    description: builtin.description,
    effects: meta.effects,
    effectsFor: meta.effectsFor as ((params: unknown) => Effect[]) | undefined,
    pure,
    group: meta.group,
    defaultEnabled: meta.defaultEnabled ?? true,
  });

  const effectsSuffix = meta.effects.length > 0 ? ` Effects: ${meta.effects.map((e) => e.id).join(", ")}.` : "";

  pi.registerTool({
    ...builtin,
    name,
    description: `${builtin.description}${effectsSuffix}`,
    promptSnippet: meta.promptSnippet,
    promptGuidelines: meta.promptGuidelines,
    executionMode: builtin.executionMode ?? (pure ? "parallel" : "sequential"),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const check = runtimeCheck(name, params);
      if (!check.ok) {
        throw new Error(check.reason);
      }
      return builtin.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
