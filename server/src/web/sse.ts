import type { Request, Response } from "express";

export function initSSE(req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

export function writeSSE(
  res: Response,
  event: string,
  data: unknown,
): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
