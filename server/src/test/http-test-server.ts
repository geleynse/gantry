import { createServer, type Server } from "node:http";
import type { Express } from "express";

const DEFAULT_HOST = "127.0.0.1";

export interface StartedTestServer {
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
}

export interface StartTestServerOptions {
  host?: string;
  baseUrlHost?: string;
  maxAttempts?: number;
}

export async function canBindLocalhost(host = DEFAULT_HOST): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, host, () => {
      probe.close(() => resolve(true));
    });
  });
}

async function listenOnce(
  app: Express,
  host: string | undefined,
  baseUrlHost: string,
): Promise<StartedTestServer> {
  return await new Promise<StartedTestServer>((resolve, reject) => {
    const server = createServer(app);
    if (host) {
      server.listen(0, host);
    } else {
      server.listen(0);
    }

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onListening = () => {
      cleanup();
      const address = server.address();
      if (!address || typeof address === "string") {
        void server.close(() => reject(new Error("Failed to bind test server to an ephemeral port")));
        return;
      }
      resolve({
        server,
        baseUrl: `http://${baseUrlHost}:${address.port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => {
              if (err) {
                closeReject(err);
                return;
              }
              closeResolve();
            });
          }),
      });
    };

    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };

    server.once("error", onError);
    server.once("listening", onListening);
  });
}

export async function startTestServer(
  app: Express,
  options: StartTestServerOptions = {},
): Promise<StartedTestServer> {
  const host = options.host;
  const baseUrlHost = options.baseUrlHost ?? host ?? DEFAULT_HOST;
  const maxAttempts = options.maxAttempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await listenOnce(app, host, baseUrlHost);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await Bun.sleep(attempt * 25);
      }
    }
  }

  const reason =
    lastError instanceof Error ? lastError.message : "Unknown startup error";
  throw new Error(`Unable to start test server after ${maxAttempts} attempts: ${reason}`);
}
