import { describe, it, expect, afterEach } from 'bun:test';
import { createSOCKS5Tunnel, createSOCKS5Relay } from './socks5-tunnel.js';
import { SocksClient } from 'socks';
import { EventEmitter } from 'node:events';
import { createServer, connect as netConnect, type Server } from 'node:net';

async function canBindLocalhost(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

const CAN_BIND_LOCALHOST = await canBindLocalhost();

describe('SOCKS5 Tunnel', () => {
  describe('createSOCKS5Tunnel', () => {
    it('throws error when proxy is unreachable', async () => {
      try {
        // Try to connect to non-existent proxy
        await createSOCKS5Tunnel('127.0.0.1', 9999, 'example.com', 443);
        expect(true).toBe(false); // Should not reach here
      } catch (err: any) {
        // Should throw a SOCKS5 error
        expect(err.message).toContain('SOCKS5');
      }
    });

    it('throws error for invalid target host', async () => {
      try {
        // No SOCKS5 proxy running on localhost:1080, so this should fail
        await createSOCKS5Tunnel('localhost', 1080, 'invalid---host--that-does-not-exist.local', 443);
        expect(true).toBe(false); // Should not reach here
      } catch (err: any) {
        // Error should be from SOCKS5 proxy connection failure
        expect(err.message).toContain('SOCKS5');
      }
    });

    it('includes proxy info in error messages', async () => {
      try {
        await createSOCKS5Tunnel('proxy.invalid.test', 1080, 'example.com', 443);
        expect(true).toBe(false); // Should not reach here
      } catch (err: any) {
        // Should include proxy host in error
        expect(err.message).toContain('proxy.invalid.test');
      }
    });

    it('handles DNS resolution errors gracefully', async () => {
      try {
        // Use a definitely invalid proxy host
        await createSOCKS5Tunnel('this-host-definitely-does-not-exist-12345.invalid', 1080, 'example.com', 443);
        expect(true).toBe(false); // Should not reach here
      } catch (err: any) {
        // Should throw a SOCKS5 error
        expect(err.message).toContain('SOCKS5');
      }
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
