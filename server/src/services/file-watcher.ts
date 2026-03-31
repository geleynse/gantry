import { open } from 'node:fs/promises';

export interface ReadResult {
  lines: string[];
  offset: number;
}

export interface HistoryResult {
  lines: string[];
  startOffset: number;
  endOffset: number;
  fileSize: number;
}

/**
 * Open the file, stat it, then call `reader(size)` to get the byte range to read.
 * Returns the decoded text and total file size. Closes the handle on completion or error.
 * If `reader` returns null, returns empty text (caller's early-exit signal).
 */
async function withFile(
  path: string,
  reader: (size: number) => { position: number; length: number } | null,
): Promise<{ text: string; size: number }> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const range = reader(size);
    if (!range || range.length === 0) return { text: '', size };
    const buf = Buffer.alloc(range.length);
    const { bytesRead } = await fh.read(buf, 0, range.length, range.position);
    return { text: buf.subarray(0, bytesRead).toString('utf-8'), size };
  } finally {
    await fh.close();
  }
}

const splitLines = (text: string): string[] => text.split('\n').filter(l => l !== '');

export class FileWatcher {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Read the last N lines of the file, return them and the byte offset at EOF. */
  async readTail(maxLines: number): Promise<ReadResult> {
    try {
      const { text, size } = await withFile(this.path, size => {
        if (size === 0) return null;
        const length = Math.min(size, maxLines * 200);
        return { position: size - length, length };
      });
      if (!text) return { lines: [], offset: 0 };
      return { lines: splitLines(text).slice(-maxLines), offset: size };
    } catch {
      return { lines: [], offset: 0 };
    }
  }

  /** Read new lines from a given byte offset. */
  async readFrom(fromOffset: number): Promise<ReadResult> {
    try {
      const { text, size } = await withFile(this.path, size => {
        if (fromOffset > size) fromOffset = 0; // file was truncated/rotated
        if (fromOffset === size) return null;
        return { position: fromOffset, length: size - fromOffset };
      });
      if (!text) return { lines: [], offset: size };
      return { lines: splitLines(text), offset: size };
    } catch {
      return { lines: [], offset: fromOffset };
    }
  }

  /** Read a page of history: lines starting from byte offset, up to limit lines. */
  async readHistory(fromOffset: number, limit: number): Promise<HistoryResult> {
    try {
      const { text, size } = await withFile(this.path, size => {
        if (fromOffset >= size) return null;
        return { position: fromOffset, length: Math.min(size - fromOffset, limit * 200) };
      });
      if (!text) return { lines: [], startOffset: fromOffset, endOffset: fromOffset, fileSize: size };
      const lines = splitLines(text).slice(0, limit);
      const endOffset = fromOffset + Buffer.byteLength(lines.join('\n') + '\n', 'utf-8');
      return { lines, startOffset: fromOffset, endOffset, fileSize: size };
    } catch {
      return { lines: [], startOffset: fromOffset, endOffset: fromOffset, fileSize: 0 };
    }
  }

  close(): void {
    // No-op for now; available for future fs.watch integration
  }
}
