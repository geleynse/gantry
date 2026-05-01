import type { Request, Response } from "express";

/**
 * Cloudflare's default 524 timeout fires after ~100s of idle response. Send
 * a comment line every 30s to keep the connection alive through CF and any
 * intermediate proxies. Comments (`: …`) are ignored by EventSource clients.
 */
const SSE_HEARTBEAT_MS = 30_000;

export function initSSE(req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    try {
      res.write(": ping\n\n");
    } catch {
      // Connection probably closed underneath us; cleanup happens via 'close'.
    }
  }, SSE_HEARTBEAT_MS);

  const stop = () => clearInterval(heartbeat);
  // Test mocks may not provide event emitters; only wire if available.
  if (typeof req?.on === "function") req.on("close", stop);
  if (typeof res?.on === "function") {
    res.on("close", stop);
    res.on("finish", stop);
  }
}

export function writeSSE(
  res: Response,
  event: string,
  data: unknown,
): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
