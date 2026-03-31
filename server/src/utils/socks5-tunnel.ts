import { SocksClient } from 'socks';
import type { Socket } from 'net';
import { createServer, type Server } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export interface SOCKS5Config {
  host: string;
  port: number;
}

/**
 * Creates a SOCKS5 tunnel through a proxy server to a target host.
 * Returns a socket that is connected through the SOCKS5 proxy and ready for TLS upgrade.
 * 
 * @param proxyHost SOCKS5 proxy hostname
 * @param proxyPort SOCKS5 proxy port
 * @param targetHost Target hostname (resolved by proxy)
 * @param targetPort Target port
 * @returns Promise resolving to connected socket
 * @throws Error if tunnel creation fails (proxy unreachable, auth failed, etc.)
 */
export async function createSOCKS5Tunnel(
  proxyHost: string,
  proxyPort: number,
  targetHost: string,
  targetPort: number
): Promise<Socket> {
  try {
    const result = await SocksClient.createConnection({
      proxy: {
        ipaddress: proxyHost,
        port: proxyPort,
        type: 5 // SOCKS5
      },
      command: 'connect',
      destination: {
        host: targetHost,
        port: targetPort
      }
    });

    return result.socket;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    
    // Classify SOCKS5 errors for better debugging
    if (message.includes('ECONNREFUSED') || message.includes('unreachable')) {
      throw new Error(`SOCKS5 proxy unreachable: ${proxyHost}:${proxyPort} - ${message}`);
    }
    
    if (message.includes('407') || message.includes('auth') || message.includes('authentication')) {
      throw new Error(`SOCKS5 proxy authentication failed: ${message}`);
    }
    
    if (message.includes('ENOTFOUND') || message.includes('DNS')) {
      throw new Error(`SOCKS5 proxy DNS resolution failed for ${proxyHost}: ${message}`);
    }
    
    if (message.includes('invalid target') || message.includes('destination')) {
      throw new Error(`SOCKS5 tunnel: invalid target host ${targetHost}:${targetPort} - ${message}`);
    }
    
    // Generic SOCKS5 error
    throw new Error(`SOCKS5 tunnel failed: ${message}`);
  }
}

/**
 * Creates a SOCKS5 relay: tunnels through the proxy and exposes a local TCP
 * server so Bun's native WebSocket (which has no socket/agent option) can
 * connect to `ws://127.0.0.1:<port>` while traffic flows through SOCKS5.
 *
 * For wss:// targets the tunnel socket is upgraded to TLS before relaying,
 * so the local WebSocket side uses plain ws://.
 */
export async function createSOCKS5Relay(
  proxyPort: number,
  wsUrl: string
): Promise<{ localUrl: string; cleanup: () => void }> {
  const url = new URL(wsUrl);
  const useTls = url.protocol === 'wss:';
  const targetHost = url.hostname;
  const targetPort = parseInt(url.port) || (useTls ? 443 : 80);

  // Step 1: raw TCP socket through SOCKS5 proxy
  const tunnelSocket = await createSOCKS5Tunnel('127.0.0.1', proxyPort, targetHost, targetPort);

  // Step 2: TLS upgrade if the original URL was wss://
  const remoteSocket: Socket = useTls
    ? (tlsConnect({ socket: tunnelSocket, servername: targetHost }) as unknown as Socket)
    : tunnelSocket;

  // Step 3: local TCP relay — accepts exactly one connection then stops listening
  return new Promise((resolve, reject) => {
    const server: Server = createServer((localSocket) => {
      // Rewrite Host header in the initial HTTP upgrade request.
      // Bun sends Host: 127.0.0.1:<port> but game server expects the real hostname.
      localSocket.once('data', (firstChunk) => {
        const str = firstChunk.toString('utf8');
        const modified = str.replace(
          /Host: 127\.0\.0\.1:\d+/i,
          `Host: ${targetHost}`
        );
        remoteSocket.write(Buffer.from(modified, 'utf8'));
        localSocket.pipe(remoteSocket);
      });
      remoteSocket.pipe(localSocket);

      localSocket.on('error', () => remoteSocket.destroy());
      remoteSocket.on('error', () => localSocket.destroy());
      localSocket.on('close', () => { remoteSocket.destroy(); server.close(); });
      remoteSocket.on('close', () => { localSocket.destroy(); server.close(); });

      // Only one WS connection expected — stop accepting new ones
      server.close();
    });

    const bindCandidates = ['127.0.0.1', 'localhost', '::1'];
    let settled = false;
    server.on('error', () => {
      // Post-bind runtime errors should not crash callers.
      if (!settled) return;
      try { remoteSocket.destroy(); } catch {}
    });

    const tryBind = (index: number) => {
      if (index >= bindCandidates.length) {
        if (!settled) {
          settled = true;
          tunnelSocket.destroy();
          reject(new Error('SOCKS5 relay: failed to bind local port on any loopback address'));
        }
        return;
      }

      const host = bindCandidates[index];
      const onError = (err: Error) => {
        server.off('listening', onListening);
        // Try next loopback host.
        tryBind(index + 1);
      };
      const onListening = () => {
        server.off('error', onError);
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          tunnelSocket.destroy();
          if (!settled) {
            settled = true;
            reject(new Error('SOCKS5 relay: failed to bind local port'));
          }
          return;
        }

        if (!settled) {
          settled = true;
          const localUrl = `ws://127.0.0.1:${addr.port}${url.pathname}${url.search}`;
          resolve({
            localUrl,
            cleanup: () => {
              try { server.close(); } catch {}
              try { remoteSocket.destroy(); } catch {}
              try { tunnelSocket.destroy(); } catch {}
            },
          });
        }
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, host);
    };

    tryBind(0);
  });
}
