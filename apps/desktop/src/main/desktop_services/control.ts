import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { writeFileAtomic } from '@weq/service';
import { z } from 'zod';

export const PRIVATE_TOKEN_HEADER = 'x-weq-desktop-service';
export const PRIVATE_WEB_ROUTE_HEADER = 'x-weq-desktop-web-route';

const endpointSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});

export type ServiceEndpoint = z.infer<typeof endpointSchema>;

export const desktopServiceGeneration = z.number().int().positive().nullable();

export function currentDesktopServiceGeneration(): number | null {
  if (process.env.WEQ_DEV_RESTART_MANAGED !== '1') return null;
  return desktopServiceGeneration.safeParse(Number(process.env.WEQ_DEV_STARTED_AT)).data ?? null;
}

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

  constructor(dataRoot: string) {
    this.root = join(dataRoot, 'desktop-services');
  }

  private path(id: string): string {
    return join(this.root, `${id}.json`);
  }

  async publish(id: string, endpoint: ServiceEndpoint): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(id);
    await writeFileAtomic(path, JSON.stringify(endpoint));
    return () => unlink(path).catch(() => undefined);
  }

  async endpoint(id: string): Promise<ServiceEndpoint | null> {
    try {
      return endpointSchema.parse(JSON.parse(await readFile(this.path(id), 'utf8')));
    } catch {
      return null;
    }
  }

  async participants(): Promise<ServiceEndpoint[]> {
    const entries = await readdir(this.root).catch(() => []);
    const endpoints = await Promise.all(
      entries.flatMap((entry) => {
        const pid = Number(/^window-(\d+)\.json$/.exec(entry)?.[1]);
        if (!Number.isSafeInteger(pid) || pid <= 1) return [];
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            void unlink(join(this.root, entry)).catch(() => undefined);
            return [];
          }
        }
        return [this.endpoint(entry.slice(0, -5))];
      }),
    );
    return endpoints.filter((endpoint) => endpoint !== null);
  }
}

export async function connectDesktopService(
  registry: Pick<DesktopServiceRegistry, 'endpoint'>,
  launch: () => Promise<void>,
  generation: number | null,
): Promise<ServiceEndpoint> {
  let retiring: string | undefined;
  let launchAt = 0;
  const stop = AbortSignal.timeout(10_000);
  const deadline = () => AbortSignal.any([stop, AbortSignal.timeout(1000)]);
  for (let attempt = 0; !stop.aborted; attempt++) {
    const endpoint = await registry.endpoint('service');
    if (endpoint) {
      const peer = await callControl<unknown>(
        endpoint,
        'service.generation',
        undefined,
        deadline(),
      ).then(
        (value) => desktopServiceGeneration.safeParse(value).data,
        () => undefined,
      );
      if (peer !== undefined) {
        if (generation === null || peer === null || peer >= generation) return endpoint;
        if (retiring !== endpoint.token) {
          await callControl(endpoint, 'service.retire', generation, deadline());
          retiring = endpoint.token;
        }
        await pause(150);
        continue;
      }
      if (await callControl(endpoint, 'ping', undefined, deadline()).catch(() => false)) {
        throw new Error('旧版 WeQ 桌面服务仍在运行；请完整退出 WeQ 后重新打开。');
      }
    }
    // 旧服务可能先注销端点，再释放 Electron 单实例锁。
    if (attempt >= launchAt) {
      await launch();
      launchAt = retiring ? attempt + 15 : Infinity;
    }
    await pause(150);
  }
  throw new Error('WeQ 桌面服务未就绪。');
}
