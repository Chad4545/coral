import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decode,
  encode,
  type JsonRpcRequestEnvelope,
  type JsonRpcResponseEnvelope,
} from '#src/transport/ipc/json-rpc.js';
import { IpcLifecycleRefusal, IpcRequestTimeout, requestIpcMethod } from '#src/transport/ipc/client.js';
import { CoralSetupError } from '#src/runtime/errors.js';

const tempDirs: string[] = [];
const servers: NetServer[] = [];
const accepted: Socket[] = [];

function makeSocketPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-ipc-client-test-'));
  tempDirs.push(root);
  return join(root, `${name}.sock`);
}

async function startReplyServer(
  socketPath: string,
  reply: (request: JsonRpcRequestEnvelope) => JsonRpcResponseEnvelope | Promise<JsonRpcResponseEnvelope>,
): Promise<NetServer> {
  mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      void (async () => {
        buffer += chunk.toString('utf-8');
        const frames = buffer.split('\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (frame.trim().length === 0) continue;
          const request = decode(frame);
          if (request.kind !== 'request') {
            continue;
          }
          socket.end(`${encode(await reply(request))}\n`);
        }
      })().catch((error: unknown) => {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

/**
 * A server that accepts and never answers. It retains what it accepted because a client-side `destroy()` of
 * an unanswered request leaves the accepted socket open — with no `'data'` listener its EOF is never read —
 * and `close()` does not return while one is (measured on Node 24, darwin).
 */
async function startSilentServer(socketPath: string): Promise<NetServer> {
  mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer((socket) => accepted.push(socket));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

afterEach(async () => {
  for (const socket of accepted.splice(0)) {
    socket.destroy();
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ipc client', () => {
  it('sends a JSON-RPC request and resolves the response payload', async () => {
    const socketPath = makeSocketPath('request');
    await startReplyServer(socketPath, async (request) => ({
      kind: 'response',
      id: request.id,
      result: { ok: true, method: request.method, params: request.params },
    }));

    await expect(requestIpcMethod(socketPath, 'jobs.list', { all: true })).resolves.toEqual({
      ok: true,
      method: 'jobs.list',
      params: { all: true },
    });
  });

  it('retries once on ECONNREFUSED before succeeding', async () => {
    vi.resetModules();
    const socketPath = makeSocketPath('retry');
    const response = {
      kind: 'response',
      id: 1,
      result: { retried: true, method: 'transport.health' },
    } as const;
    const connectionCalls: string[] = [];

    class FakeSocket extends EventEmitter {
      destroyed = false;
      writableEnded = false;

      private readonly behavior: 'refused' | 'success';
      constructor(behavior: 'refused' | 'success') {
        super();
        this.behavior = behavior;
        queueMicrotask(() => {
          if (behavior === 'refused') {
            const error = new Error('ECONNREFUSED') as NodeJS.ErrnoException;
            error.code = 'ECONNREFUSED';
            this.emit('error', error);
            this.emit('close');
            return;
          }
          this.emit('connect');
        });
      }

      write(_chunk: string) {
        queueMicrotask(() => {
          this.emit('data', Buffer.from(`${encode(response)}\n`));
        });
        return true;
      }

      end() {
        this.writableEnded = true;
        this.emit('close');
      }

      destroy(error?: Error) {
        this.destroyed = true;
        if (error) {
          this.emit('error', error);
        }
        this.emit('close');
        return this;
      }
    }

    vi.doMock('node:net', () => ({
      createConnection: (path: string) => {
        connectionCalls.push(path);
        return new FakeSocket(connectionCalls.length === 1 ? 'refused' : 'success');
      },
    }));

    const { requestIpcMethod: requestWithRetry } = await import('#src/transport/ipc/client.js');
    await expect(requestWithRetry(socketPath, 'transport.health')).resolves.toEqual(response.result);
    expect(connectionCalls).toEqual([socketPath, socketPath]);
  });

  it.each([
    { name: 'the shipped body', result: { code: 'backend_shutting_down', message: 'Backend shutting down' } },
    {
      name: 'a newer body carrying extra fields',
      result: { code: 'backend_shutting_down', message: 'Backend shutting down', lifecycleState: 'draining' },
    },
  ])('rejects a lifecycle refusal riding $name', async ({ result }) => {
    const socketPath = makeSocketPath('refusal');
    await startReplyServer(socketPath, (request) => ({ kind: 'response', id: request.id, result }));

    const raised = await requestIpcMethod(socketPath, 'jobs.abort', { jobId: 'job-1' }).then(
      (value: unknown) => value,
      (error: unknown) => error,
    );

    expect(raised).toBeInstanceOf(IpcLifecycleRefusal);
    expect(raised).toMatchObject({ code: 'backend_shutting_down', method: 'jobs.abort', socketPath });
    expect((raised as Error).message).toContain('jobs.abort');
    expect((raised as Error).message).toContain(socketPath);
    expect((raised as Error).message).not.toContain('while draining');
  });

  it.each([
    { name: 'null', result: null },
    { name: 'a plain object', result: { aborted: ['job-1'] } },
    { name: 'a different code', result: { code: 'backend_recovering', message: 'Backend recovering' } },
    { name: 'a nested code', result: { cause: { code: 'backend_shutting_down' } } },
  ])('resolves $name unchanged', async ({ result }) => {
    const socketPath = makeSocketPath('passthrough');
    await startReplyServer(socketPath, (request) => ({ kind: 'response', id: request.id, result }));

    await expect(requestIpcMethod(socketPath, 'jobs.abort', { jobId: 'job-1' })).resolves.toEqual(result);
  });

  it('throws CoralSetupError with remediation on persistent connection failure', async () => {
    const socketPath = makeSocketPath('missing');

    let thrown: unknown;
    try {
      await requestIpcMethod(socketPath, 'transport.health', undefined, { timeoutMs: 25 });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CoralSetupError);
    expect((thrown as CoralSetupError).remediation).toContain('stale socket');
  });

  it('names the expired response budget when a connected request is never answered', async () => {
    const socketPath = makeSocketPath('silent');
    await startSilentServer(socketPath);

    // The budget destroys the socket with the typed timeout, which re-emits as `'error'`; a caller that
    // cannot tell that apart from a transport failure has no way to know the method may still have run.
    const thrown: unknown = await requestIpcMethod(socketPath, 'jobs.list', {}, { timeoutMs: 25 }).then(
      (result: unknown) => result,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(IpcRequestTimeout);
    const budgetMs = /timed out after (\d+)ms/.exec((thrown as Error).message)?.[1];
    expect(budgetMs).toBeDefined();
    expect(Number(budgetMs)).toBeGreaterThan(0);
    expect(Number(budgetMs)).toBeLessThanOrEqual(25);
  });
});
