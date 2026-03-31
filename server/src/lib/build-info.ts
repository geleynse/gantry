/**
 * Build information exposed at runtime.
 * Version and commit are baked in as process.env defines by esbuild at build
 * time, so the compiled bundle reports real values even on machines with no
 * .git directory or package.json. Falls back to env vars then filesystem walk.
 * Start time is captured when this module is first imported.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Walk up the directory tree from startDir until we find a directory
 * containing a file/directory named `marker`. Returns null if not found.
 *
 * Works whether running from source (src/lib/) or a compiled bundle
 * (dist/index.js), since the depth differs between those two cases.
 */
function findAncestorDir(startDir: string, marker: string, maxDepth = 10): string | null {
  let dir = startDir;
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(join(dir, marker))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

function readPackageField(field: string): string {
  // Check env var first — esbuild bakes this in as a string literal at build
  // time, so the compiled bundle always has a real value here.
  if (field === "version" && process.env.BUILD_VERSION) {
    return process.env.BUILD_VERSION;
  }
  try {
    const root = findAncestorDir(__dirname, "package.json");
    if (!root) return "unknown";
    const pkgPath = join(root, "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const val = pkg[field];
    return typeof val === "string" ? val : "unknown";
  } catch {
    return "unknown";
  }
}

function readGitCommit(): string {
  // Allow override via env (e.g. set by CI/deploy scripts)
  if (process.env.GIT_COMMIT) {
    return process.env.GIT_COMMIT.slice(0, 7);
  }
  try {
    const projectRoot = findAncestorDir(__dirname, ".git");
    if (!projectRoot) return "unknown";
    let gitDir = join(projectRoot, ".git");
    let refBaseDir = gitDir; // Where to resolve refs from

    // Handle git worktrees: .git is a file pointing to the actual git dir
    try {
      const gitContent = readFileSync(gitDir, "utf-8").trim();
      if (gitContent.startsWith("gitdir: ")) {
        const worktreeGitDir = gitContent.slice(8); // "gitdir: " is 8 chars
        gitDir = worktreeGitDir;

        // In a worktree, refs are stored in the main git directory.
        // Try to read commondir file which points to the shared git dir.
        try {
          const commonDir = readFileSync(join(gitDir, "commondir"), "utf-8").trim();
          refBaseDir = join(gitDir, commonDir);
        } catch {
          // If commondir doesn't exist, refs might be in the worktree git dir.
          // This is rare but we'll try it anyway.
          refBaseDir = gitDir;
        }
      }
    } catch {
      // Not a worktree, .git is a directory
    }

    const headPath = join(gitDir, "HEAD");
    const head = readFileSync(headPath, "utf-8").trim();
    if (head.startsWith("ref: ")) {
      const refPath = join(refBaseDir, head.slice(5));
      return readFileSync(refPath, "utf-8").trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return "unknown";
  }
}

export const BUILD_VERSION: string = readPackageField("version");
export const BUILD_COMMIT: string = readGitCommit();
export const SERVER_START_TIME: Date = new Date();

export function getUptimeSeconds(): number {
  return Math.floor((Date.now() - SERVER_START_TIME.getTime()) / 1000);
}
