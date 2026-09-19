/**
 * http_request tool. Uses fetch() via caps/net.ts — never curl/wget as a subprocess.
 * Method determines the effect: GET/HEAD -> net.read, everything else -> net.write.
 * Scope is the request hostname.
 */

import { DEFAULT_MAX_BYTES, formatSize, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { NetCaps } from "../caps/net.ts";
import type { Effect } from "../effects/model.ts";
import { defineEffectTool, registerEffectTool, type EffectCatalog } from "./define.ts";

const READ_METHODS = new Set(["GET", "HEAD"]);
const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

const HttpParams = Type.Object({
  url: Type.String({ description: "Absolute http(s) URL." }),
  method: Type.Optional(StringEnum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const, { default: "GET" })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  body: Type.Optional(Type.String({ description: "Request body, sent as-is." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Request timeout in milliseconds. Default 30000." })),
});

function effectsForRequest(params: { url: string; method?: string }): Effect[] {
  const method = params.method ?? "GET";
  let host: string;
  try {
    host = new URL(params.url).hostname;
  } catch {
    host = "*";
  }
  const id = READ_METHODS.has(method) ? "net.read" : "net.write";
  return [{ id, scope: host }];
}

export function registerHttpTool(
  pi: ExtensionAPI,
  catalog: EffectCatalog,
  net: NetCaps,
  runtimeCheck: (toolName: string, params: unknown) => { ok: true } | { ok: false; reason: string },
): void {
  registerEffectTool(
    pi,
    catalog,
    defineEffectTool({
      name: "http_request",
      label: "HTTP Request",
      description:
        "Make an HTTP request. GET/HEAD require net.read; POST/PUT/PATCH/DELETE require net.write. Scope is the request host. file:// and localhost are blocked by default.",
      group: "http",
      effects: [{ id: "net.read" }, { id: "net.write" }],
      effectsFor: effectsForRequest,
      parameters: HttpParams,
      async execute(params) {
        const url = new URL(params.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error(`Blocked: only http:// and https:// URLs are allowed (got "${url.protocol}").`);
        }
        if (BLOCKED_HOSTS.has(url.hostname)) {
          throw new Error(`Blocked: requests to "${url.hostname}" are disabled by default policy.`);
        }

        const method = params.method ?? "GET";
        const response = await net.fetch(url.toString(), {
          method,
          headers: params.headers,
          body: params.body,
          timeoutMs: params.timeoutMs,
        });

        const bodyText = await response.text();
        const truncation = truncateHead(bodyText, { maxBytes: DEFAULT_MAX_BYTES, maxLines: 2000 });
        let text = `${response.status} ${response.statusText}\n\n${truncation.content}`;
        if (truncation.truncated) {
          text += `\n\n[Body truncated: showing ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}.]`;
        }

        return {
          content: [{ type: "text", text }],
          details: { status: response.status, ok: response.ok },
        };
      },
    }),
    runtimeCheck,
  );
}
