/**
 * Network capability: fetch with a hard timeout. Only this module (plus fs.ts /
 * proc.ts) is allowed to touch global fetch.
 */

export interface NetCaps {
  fetch(input: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
}

export function createNetCaps(): NetCaps {
  return {
    async fetch(input, init) {
      const timeoutMs = init?.timeoutMs ?? 30_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const externalSignal = init?.signal;
      if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      try {
        return await fetch(input, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
