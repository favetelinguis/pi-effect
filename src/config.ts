/**
 * Config loading: .pi/pi-effect.json (project, only when trusted) merged over
 * ~/.pi/agent/pi-effect.json (global). Pure-ish: file reads are isolated here so
 * the rest of the extension stays testable.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DenyRule } from "./effects/policy.ts";
import { DEFAULT_DENY_RULES } from "./effects/policy.ts";
import type { EffectId } from "./effects/model.ts";
import type { UnknownToolsPolicy } from "./effects/gate.ts";

export interface DefaultGrantConfig {
  id: EffectId;
  scope?: string;
}

export interface PiEffectConfig {
  autoGrantRead: boolean;
  writeImpliesRead: boolean;
  defaultGrants: DefaultGrantConfig[];
  defaultDisabledTools: string[];
  deny: DenyRule[];
  unknownTools: UnknownToolsPolicy;
}

export const DEFAULT_CONFIG: PiEffectConfig = {
  autoGrantRead: true,
  writeImpliesRead: true,
  defaultGrants: [],
  defaultDisabledTools: ["git_push"],
  deny: [...DEFAULT_DENY_RULES],
  unknownTools: "warn",
};

async function readJsonIfExists(path: string): Promise<Partial<PiEffectConfig> | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Partial<PiEffectConfig>;
  } catch {
    return undefined;
  }
}

function mergeConfig(base: PiEffectConfig, override: Partial<PiEffectConfig> | undefined): PiEffectConfig {
  if (!override) return base;
  return {
    autoGrantRead: override.autoGrantRead ?? base.autoGrantRead,
    writeImpliesRead: override.writeImpliesRead ?? base.writeImpliesRead,
    defaultGrants: override.defaultGrants ?? base.defaultGrants,
    defaultDisabledTools: override.defaultDisabledTools ?? base.defaultDisabledTools,
    // Deny rules accumulate: project/global rules add to defaults, they never remove them.
    deny: override.deny ? [...base.deny, ...override.deny] : base.deny,
    unknownTools: override.unknownTools ?? base.unknownTools,
  };
}

export async function loadConfig(cwd: string, projectTrusted: boolean): Promise<PiEffectConfig> {
  let config = DEFAULT_CONFIG;

  const globalPath = join(getAgentDir(), "pi-effect.json");
  config = mergeConfig(config, await readJsonIfExists(globalPath));

  if (projectTrusted) {
    const projectPath = join(cwd, CONFIG_DIR_NAME, "pi-effect.json");
    config = mergeConfig(config, await readJsonIfExists(projectPath));
  }

  return config;
}
