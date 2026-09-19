/**
 * The system-prompt section appended by before_agent_start, so the model knows the
 * effect system exists even if it never reads a tool description carefully.
 */

import type { GrantStore } from "./effects/grants.ts";

export function buildEffectsPromptSection(grants: GrantStore): string {
  const granted = grants.describe();
  return `

## Effects
There is no shell. Every tool declares effects (fs.read, fs.write, git.read, git.write:local|remote, net.read, net.write). Tools marked pure never change anything.
Currently granted: ${granted || "(none yet)"}.
Workflow: explore with pure tools first; then call \`request_effects\` ONCE listing every effect the task needs with a one-line reason each; then proceed. If a call is blocked with "not granted", call \`request_effects\` — do not retry the same call.`;
}
