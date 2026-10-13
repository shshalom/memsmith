import { describe, expect, it } from 'bun:test';
import net from 'net';
import { findRunningServer } from '../../../src/server/runtime/ServerService.js';

function listen(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}

// Observed 2026-10-07: the server's pid file was gone while the server kept
// running, so every `start` spawned a duplicate daemon that died on the port.
describe('findRunningServer', () => {
  it('reports a server listening on the port even when the pid file is missing', async () => {
    const { server, port } = await listen();
    try {
      const found = await findRunningServer(port, '127.0.0.1', { readPidFile: () => null });
      expect(found).toEqual({ pid: null, port });
    } finally {
      server.close();
    }
  });

  it('reports nothing when the pid file is missing and the port is free', async () => {
    const { server, port } = await listen();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const found = await findRunningServer(port, '127.0.0.1', { readPidFile: () => null });
    expect(found).toBeNull();
  });
});
