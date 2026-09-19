/**
 * Filesystem capability. Only this module (plus proc.ts / net.ts) is allowed to
 * import node:fs. `npm run check` greps src/tools/** for violations.
 */

import { mkdir as fsMkdir, readdir as fsReaddir, readFile as fsReadFile, stat as fsStat, unlink as fsUnlink, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface FsCaps {
  readFile(absPath: string): Promise<string>;
  stat(absPath: string): Promise<import("node:fs").Stats>;
  readdir(absPath: string): Promise<string[]>;
  writeFile(absPath: string, content: string): Promise<void>;
  mkdir(absDir: string): Promise<void>;
  unlink(absPath: string): Promise<void>;
}

export function createFsCaps(): FsCaps {
  return {
    readFile: (absPath) => fsReadFile(absPath, "utf8"),
    stat: (absPath) => fsStat(absPath),
    readdir: (absPath) => fsReaddir(absPath),
    async writeFile(absPath, content) {
      await withFileMutationQueue(absPath, async () => {
        await fsMkdir(dirname(absPath), { recursive: true });
        await fsWriteFile(absPath, content, "utf8");
      });
    },
    mkdir: (absDir) => fsMkdir(absDir, { recursive: true }).then(() => undefined),
    async unlink(absPath) {
      await withFileMutationQueue(absPath, async () => {
        await fsUnlink(absPath);
      });
    },
  };
}
