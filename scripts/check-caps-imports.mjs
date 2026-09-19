#!/usr/bin/env node
/**
 * Enforces (PLAN.md section 2.3): src/tools/** may not import node:fs,
 * node:child_process, or call fetch() directly. Tool bodies must go through
 * src/caps/** capability wrappers instead. This is the homegrown "R channel"
 * boundary — cheap to audit, not type-enforced.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const TOOLS_DIR = join(ROOT, "src", "tools");

const FORBIDDEN_PATTERNS = [
  { pattern: /from\s+["']node:fs/, name: "node:fs" },
  { pattern: /from\s+["']fs["']/, name: "fs" },
  { pattern: /from\s+["']fs\/promises["']/, name: "fs/promises" },
  { pattern: /from\s+["']node:child_process/, name: "node:child_process" },
  { pattern: /from\s+["']child_process["']/, name: "child_process" },
];

/** Bare `fetch(` calls (not `something.fetch(`) are forbidden outside caps/net.ts. */
const FETCH_CALL_PATTERN = /(?<![.\w])fetch\s*\(/;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = walk(TOOLS_DIR);
const violations = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  const content = stripComments(readFileSync(file, "utf8"));

  for (const { pattern, name } of FORBIDDEN_PATTERNS) {
    if (pattern.test(content)) violations.push(`${rel}: imports ${name} (only src/caps/** may)`);
  }
  if (FETCH_CALL_PATTERN.test(content)) {
    violations.push(`${rel}: calls fetch() directly (only src/caps/net.ts may; use caps/net.ts's NetCaps)`);
  }
}

if (violations.length > 0) {
  console.error("pi-effect: caps import boundary violated in src/tools/**:\n");
  for (const v of violations) console.error(`  - ${v}`);
  console.error("\nOnly src/caps/** may import node:fs, node:child_process, or call fetch() directly.");
  process.exit(1);
}

console.log(`pi-effect: caps import boundary OK (${files.length} files checked in src/tools/**).`);
