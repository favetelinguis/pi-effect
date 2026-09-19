/**
 * Process capability: argv-only subprocess execution via pi.exec. No shell, ever.
 * Only this module (plus fs.ts / net.ts) is allowed to spawn processes.
 */

import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ProcCaps {
  spawn(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number; signal?: AbortSignal }): Promise<ExecResult>;
}

export function createProcCaps(pi: ExtensionAPI): ProcCaps {
  return {
    spawn(cmd, args, opts) {
      return pi.exec(cmd, args, opts);
    },
  };
}
