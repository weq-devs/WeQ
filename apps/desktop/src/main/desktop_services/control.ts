import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { writeFileAtomic } from '@weq/service';
import { z } from 'zod/v3';
import { lockOwnerFile } from '../account_instances';

export const PRIVATE_TOKEN_HEADER = 'x-weq-desktop-service';
export const PRIVATE_WEB_ROUTE_HEADER = 'x-weq-desktop-web-route';

const endpointSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});

export type ServiceEndpoint = z.infer<typeof endpointSchema>;

export function newServiceToken(): string {
  return randomBytes(32).toString('hex');
}

export function privateRequest(req: IncomingMessage, token: string): boolean {
  const actual = req.headers[PRIVATE_TOKEN_HEADER];
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(token));
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

export async function readControlJson(
  req: IncomingMessage,
  maxBytes = 256 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('服务请求过大。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function listenPrivate(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本机服务地址不可用。');
  return address.port;
}

export function stopPrivate(server: Server): void {
  server.close();
  server.closeAllConnections();
}

export async function openControl(
  handle: (method: string, input: unknown) => unknown | Promise<unknown>,
) {
  const token = newServiceToken();
  const server = createServer((req, res) => {
    if (!privateRequest(req, token) || req.method !== 'POST') {
      sendJson(res, 403, { error: '本机服务请求未获授权。' });
      return;
    }
    void readControlJson(req)
      .then((body) => {
        const command = z.object({ method: z.string(), input: z.unknown() }).parse(body);
        return handle(command.method, command.input);
      })
      .then(
        (value) => sendJson(res, 200, { value }),
        (error) =>
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }),
      );
  });
  const port = await listenPrivate(server);
  return { endpoint: { port, token }, close: () => stopPrivate(server) };
}

export async function callControl<T>(
  endpoint: ServiceEndpoint,
  method: string,
  input?: unknown,
  signal: AbortSignal = AbortSignal.timeout(30000),
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/`, {
    method: 'POST',
    headers: { [PRIVATE_TOKEN_HEADER]: endpoint.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, input }),
    signal,
    redirect: 'error',
  });
  const body = (await response.json()) as { value?: T; error?: string };
  if (!response.ok) throw new Error(body.error ?? '本机服务请求失败。');
  return body.value as T;
}

export class DesktopServiceRegistry {
  readonly root: string;
  private readonly runtime: string;

  constructor(dataRoot: string) {
    this.root = join(dataRoot, 'desktop-services');
    // 旧服务只读取父目录，否则升级后会把新窗口误认成自己的，无法自动退出。
    this.runtime = join(this.root, 'runtime');
  }

  private path(id: string): string {
    return join(this.runtime, `${id}.json`);
  }

  async claimHost(): Promise<(() => void) | null> {
    await mkdir(this.runtime, { recursive: true, mode: 0o700 });
    const lock = lockOwnerFile(join(this.runtime, 'host.sqlite'));
    return lock ? () => lock.close() : null;
  }

  async publish(id: string, endpoint: ServiceEndpoint): Promise<() => Promise<void>> {
    await mkdir(this.runtime, { recursive: true, mode: 0o700 });
    const path = this.path(id);
    await writeFileAtomic(path, JSON.stringify(endpoint));
    return () => unlink(path).catch(() => undefined);
  }

  private async readEndpoint(path: string): Promise<ServiceEndpoint | null> {
    try {
      return endpointSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch {
      return null;
    }
  }

  endpoint(id: string): Promise<ServiceEndpoint | null> {
    return this.readEndpoint(this.path(id));
  }

  legacyService(): Promise<ServiceEndpoint | null> {
    return this.readEndpoint(join(this.root, 'service.json'));
  }

  async participants(): Promise<ServiceEndpoint[]> {
    const entries = await readdir(this.runtime).catch(() => []);
    const endpoints = await Promise.all(
      entries.flatMap((entry) => {
        const pid = Number(/^window-(\d+)\.json$/.exec(entry)?.[1]);
        if (!Number.isSafeInteger(pid) || pid <= 1) return [];
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            void unlink(join(this.runtime, entry)).catch(() => undefined);
            return [];
          }
        }
        return [this.endpoint(entry.slice(0, -5))];
      }),
    );
    return endpoints.filter((endpoint) => endpoint !== null);
  }
}

export async function desktopServiceIsRunning(
  endpoint: ServiceEndpoint,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(1000)]);
  return callControl(endpoint, 'ping', undefined, deadline).then(
    (result) => result === true,
    () => false,
  );
}

export async function connectDesktopService(
  registry: Pick<DesktopServiceRegistry, 'endpoint'>,
  startHost: ((signal: AbortSignal) => Promise<ServiceEndpoint | null>) | undefined,
  signal: AbortSignal,
): Promise<ServiceEndpoint> {
  // 升级时允许上一版服务在最后一个旧窗口退出后完成原有的空闲退出。
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
  while (!deadline.aborted) {
    const endpoint = await registry.endpoint('service');
    if (endpoint && (await desktopServiceIsRunning(endpoint, deadline))) return endpoint;
    if (deadline.aborted) break;
    const hosted = await startHost?.(deadline);
    if (hosted) return hosted;
    await pause(250, undefined, { signal: deadline }).catch(() => undefined);
  }
  signal.throwIfAborted();
  throw new Error('WeQ 桌面服务未就绪。');
}
