/**
 * Atomic file write utility.
 *
 * Writes data to a temp file, fsyncs it, then renames it to the target path.
 * On POSIX systems, rename(2) is atomic — readers always see either the old
 * or the new file, never a partial write.
 *
 * Temp file is cleaned up on failure.
 */
import { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { dirname, basename } from "node:path";

/**
 * Write `data` to `filePath` atomically.
 *
 * 1. Writes to `<dir>/<basename>.tmp.<pid>` in the same directory
 *    (same filesystem guaranteed → rename is atomic).
 * 2. fsyncs the file descriptor to flush OS write buffers.
 * 3. Renames temp → target (atomic on POSIX).
 * 4. Cleans up the temp file if any step fails.
 *
 * @param filePath  Absolute path to the target file.
 * @param data      String content to write (UTF-8).
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const tmpPath = `${dir}/${base}.tmp.${process.pid}`;

  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, "w", 0o600);
    const buf = Buffer.from(data, "utf-8");
    writeSync(fd, buf);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined; // already closed

    renameSync(tmpPath, filePath);
  } catch (err) {
    // Close fd if still open
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    // Best-effort cleanup of temp file
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}
