/**
 * Append-only audit log: one JSON line per gate decision. Best-effort; failures
 * to write must never break a tool call.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function appendAuditLine(path: string, record: unknown): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Best-effort. Never let audit logging break a tool call.
  }
}

export async function readAuditLines(path: string, limit: number): Promise<string[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines.slice(-limit);
  } catch {
    return [];
  }
}
