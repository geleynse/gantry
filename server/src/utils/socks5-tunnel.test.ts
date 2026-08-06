import { describe, it, expect, afterEach } from 'bun:test';
import { createSOCKS5Tunnel, createSOCKS5Relay } from './socks5-tunnel.js';
import { SocksClient } from 'socks';
import { EventEmitter } from 'node:events';
import { connect as netConnect } from 'node:net';
// Shared helper, not a local copy: it prints GANTRY_SKIPPED_UNBINDABLE when the
// probe fails, which is what scripts/run-tests-isolated.sh greps for to report
// SKIPPED(unbindable). The private duplicate this replaces returned the same
// boolean and drove the same it.skip, but emitted no marker — so on a runner
// without loopback this file's relay coverage vanished under a green tick,
// which is the exact hole the marker was introduced to close.
import { canBindLocalhost } from '../test/http-test-server.js';

const CAN_BIND_LOCALHOST = await canBindLocalhost();

/**
 * Run `fn` with SocksClient.createConnection stubbed to reject with `message`.
 *
 * These tests exercise createSOCKS5Tunnel's ERROR CLASSIFICATION, which is pure
 * string logic. Driving it by making real connections (to :9999, to :1080, to
 * .invalid hostnames) assumed those ports were free and that DNS would fail a
 * particular way — uncontrolled I/O that produces false reds on a machine where
 * something is listening, and slow tests everywhere else. Stubbing the seam
 * makes each branch deterministic and lets us assert the SPECIFIC classified
 * message rather than merely that the word "SOCKS5" appears (which every branch
 * satisfies, so the old assertions could not tell the branches apart).
 */
async function withSocksError(message: string, fn: () => Promise<void>): Promise<void> {
  const original = SocksClient.createConnection;
  (SocksClient as any).createConnection = () => Promise.reject(new Error(message));
  try {
    await fn();
  } finally {
    (SocksClient as any).createConnection = original;
  }
}

/** Assert createSOCKS5Tunnel rejects, and return the message. */
async function tunnelError(
  proxyHost = '127.0.0.1',
  proxyPort = 1080,
  targetHost = 'example.com',
  targetPort = 443,
): Promise<string> {
  try {
    await createSOCKS5Tunnel(proxyHost, proxyPort, targetHost, targetPort);
  } catch (err: any) {
    return err.message as string;
  }
  throw new Error('expected createSOCKS5Tunnel to reject, but it resolved');
}

describe('SOCKS5 Tunnel', () => {
  describe('createSOCKS5Tunnel error classification', () => {
    it('classifies a refused connection as an unreachable proxy, naming host:port', async () => {
      await withSocksError('connect ECONNREFUSED 127.0.0.1:9999', async () => {
        const msg = await tunnelError('127.0.0.1', 9999);
        expect(msg).toContain('SOCKS5 proxy unreachable: 127.0.0.1:9999');
        expect(msg).toContain('ECONNREFUSED');
      });
    });

    it('classifies an authentication failure', async () => {
      await withSocksError('Socks5 authentication failed', async () => {
        const msg = await tunnelError();
        expect(msg).toContain('SOCKS5 proxy authentication failed');
      });
    });

    it('classifies a DNS failure and names the proxy host', async () => {
      await withSocksError('getaddrinfo ENOTFOUND proxy.invalid.test', async () => {
        const msg = await tunnelError('proxy.invalid.test');
        expect(msg).toContain('SOCKS5 proxy DNS resolution failed for proxy.invalid.test');
      });
    });

    it('classifies a bad destination and names the target host:port', async () => {
      await withSocksError('Socks5 proxy rejected destination', async () => {
        const msg = await tunnelError('127.0.0.1', 1080, 'nope.example', 443);
        expect(msg).toContain('SOCKS5 tunnel: invalid target host nope.example:443');
      });
    });

    it('falls back to a generic SOCKS5 error for an unrecognized failure', async () => {
      await withSocksError('something entirely unexpected', async () => {
        const msg = await tunnelError();
        expect(msg).toContain('SOCKS5 tunnel failed: something entirely unexpected');
      });
    });

    it('returns socket from successful SOCKS5 connection', async () => {
      const fakeSocket = new EventEmitter();
      const original = SocksClient.createConnection;
      (SocksClient as any).createConnection = () => Promise.resolve({ socket: fakeSocket });

      try {
        const socket = await createSOCKS5Tunnel('127.0.0.1', 1080, 'example.com', 443);
        expect(socket).toBe(fakeSocket as unknown as import("net").Socket);
      } finally {
        (SocksClient as any).createConnection = original;
      }
    });

    it('passes correct SOCKS5 config to SocksClient', async () => {
      const original = SocksClient.createConnection;
      let capturedOpts: any = null;
      const fakeSocket = new EventEmitter();
      (SocksClient as any).createConnection = (opts: any) => {
        capturedOpts = opts;
        return Promise.resolve({ socket: fakeSocket });
      };

      try {
        await createSOCKS5Tunnel('10.0.0.1', 9050, 'game.server.com', 8443);
        expect(capturedOpts.proxy.ipaddress).toBe('10.0.0.1');
        expect(capturedOpts.proxy.port).toBe(9050);
        expect(capturedOpts.proxy.type).toBe(5);
        expect(capturedOpts.destination.host).toBe('game.server.com');
        expect(capturedOpts.destination.port).toBe(8443);
      } finally {
        (SocksClient as any).createConnection = original;
      }
    });
  });

  describe('createSOCKS5Relay', () => {
    // Skip when localhost TCP binding is unavailable (e.g., sandboxed CI containers)
    const bindIt = CAN_BIND_LOCALHOST ? it : it.skip;

    it('fails through to SOCKS5 error when proxy is unreachable', async () => {
      try {
        await createSOCKS5Relay(9999, 'wss://game.example.com:8443/ws');
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.message).toContain('SOCKS5');
      }
    });

    it('parses ws:// URLs and attempts SOCKS connection', async () => {
      try {
        await createSOCKS5Relay(9999, 'ws://game.example.com:8080/ws');
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.message).toContain('SOCKS5');
      }
    });

    bindIt('returns local ws:// URL and cleanup function on success', async () => {
      const original = SocksClient.createConnection;
      const fakeSocket = new EventEmitter();
      (fakeSocket as any).pipe = () => fakeSocket;
      (fakeSocket as any).destroy = () => {};
      (fakeSocket as any).end = () => {};
      (fakeSocket as any).write = () => true;
      (SocksClient as any).createConnection = () => Promise.resolve({ socket: fakeSocket });

      let relay: { localUrl: string; cleanup: () => void } | undefined;
      try {
        // Use ws:// (not wss://) to avoid TLS upgrade on fake socket
        relay = await createSOCKS5Relay(1080, 'ws://game.server.com:8080/ws?token=abc');
        expect(relay.localUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws\?token=abc$/);
        expect(typeof relay.cleanup).toBe('function');
      } finally {
        relay?.cleanup();
        (SocksClient as any).createConnection = original;
      }
    });

    bindIt('rewrites Host header from 127.0.0.1 to target hostname', async () => {
      const original = SocksClient.createConnection;
      const fakeRemote = new EventEmitter();
      const writtenChunks: Buffer[] = [];
      (fakeRemote as any).pipe = () => fakeRemote;
      (fakeRemote as any).destroy = () => {};
      (fakeRemote as any).end = () => {};
      (fakeRemote as any).write = (data: Buffer) => { writtenChunks.push(data); return true; };
      (SocksClient as any).createConnection = () => Promise.resolve({ socket: fakeRemote });

      let relay: { localUrl: string; cleanup: () => void } | undefined;
      try {
        relay = await createSOCKS5Relay(1080, 'ws://game.spacemolt.com:8080/ws');
        const localUrl = new URL(relay.localUrl);
        const localPort = localUrl.port;

        // Simulate what Bun's WebSocket does: connect to local relay and send HTTP upgrade
        const conn = netConnect(parseInt(localPort), '127.0.0.1');
        const upgradeRequest =
          `GET /ws HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${localPort}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n\r\n`;

        await new Promise<void>((resolve) => {
          conn.on('connect', () => {
            conn.write(upgradeRequest);
            // Give relay time to process
            setTimeout(() => {
              conn.destroy();
              resolve();
            }, 100);
          });
        });

        // Verify the remote received a rewritten Host header
        expect(writtenChunks.length).toBeGreaterThan(0);
        const forwarded = writtenChunks[0].toString('utf8');
        expect(forwarded).toContain('Host: game.spacemolt.com');
        expect(forwarded).not.toContain('Host: 127.0.0.1');
      } finally {
        relay?.cleanup();
        (SocksClient as any).createConnection = original;
      }
    });
  });
});
