import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';

const MAX_FILE_SIZE = 16 * 1024 * 1024;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** 只在宿主进程内运行；停用可重启，退出则永久拒绝迟到的启动请求。 */
export class AssistantResourceServer {
  private server: Server | null = null;
  private root: string | null = null;
  private requestedPort: number | null = null;
  private port: number | null = null;
  private quitting = false;
  private revision = 0;
  private pending: Promise<unknown> = Promise.resolve();

  status() {
    return { running: this.server?.listening ?? false, port: this.port };
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const task = this.pending.then(action);
    this.pending = task.catch(() => {});
    return task;
  }

  start(port: number, docroot: string): Promise<number> {
    return this.serialize(async () => {
      if (this.quitting) throw new Error('WeQ 正在退出，未启动助手资源服务');
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('助手端口无效');
      const root = await realpath(docroot);
      if (!(await stat(root)).isDirectory()) throw new Error('助手资源目录无效');
      if (this.server?.listening && this.root === root && this.requestedPort === port)
        return this.port!;
      await this.close();
      for (let offset = 0; offset < (port === 0 ? 1 : 20) && port + offset <= 65535; offset += 1) {
        if (this.quitting) throw new Error('WeQ 正在退出，未启动助手资源服务');
        const server = createServer((req, res) => {
          void serve(root, req, res);
        });
        server.requestTimeout = 10_000;
        server.headersTimeout = 10_000;
        server.keepAliveTimeout = 1000;
        server.maxConnections = 32;
        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port + offset, '127.0.0.1', () => {
              server.removeListener('error', reject);
              resolve();
            });
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
          throw error;
        }
        this.server = server;
        this.root = root;
        this.requestedPort = port;
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('无法读取助手监听端口');
        this.port = address.port;
        if (this.quitting) {
          await this.close();
          throw new Error('WeQ 正在退出，已停止助手资源服务');
        }
        return address.port;
      }
      throw new Error('助手端口及相邻端口均被占用');
    });
  }

  async publishAndStart(
    port: number,
    docroot: string,
    publish: () => Promise<void>,
  ): Promise<number | null> {
    const revision = ++this.revision;
    if (this.quitting) return null;
    await publish();
    if (this.quitting || revision !== this.revision) return null;
    const bound = await this.start(port, docroot);
    return revision === this.revision ? bound : null;
  }

  stop(): Promise<void> {
    this.revision += 1;
    return this.serialize(() => this.close());
  }

  shutdown(): Promise<void> {
    this.quitting = true;
    return this.stop();
  }

  private async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.root = null;
    this.port = null;
    this.requestedPort = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

function respond(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  type = 'text/plain; charset=utf-8',
) {
  if (res.destroyed) return;
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function serve(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    respond(req, res, 405, 'method not allowed');
    return;
  }
  let path: string;
  try {
    path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  } catch {
    respond(req, res, 400, 'bad path');
    return;
  }
  const segments = path.split('/');
  if (
    segments.some(
      (segment) =>
        segment === '..' ||
        segment.includes('\\') ||
        segment.includes('\0') ||
        segment.includes(':'),
    )
  ) {
    respond(req, res, 404, 'not found');
    return;
  }
  if (path === '/healthz') {
    respond(req, res, 200, 'ok');
    return;
  }
  const base = join(root, ...segments.filter((segment) => segment && segment !== '.'));
  const candidates = extname(base)
    ? [base]
    : [
        base,
        ...['html', 'png', 'jpg', 'jpeg', 'webp', 'svg'].map((ext) => `${base}.${ext}`),
        join(base, 'index.html'),
      ];
  for (const candidate of candidates) {
    try {
      const file = await realpath(candidate);
      const rel = relative(root, file);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) continue;
      const info = await stat(file);
      if (!info.isFile()) continue;
      if (info.size > MAX_FILE_SIZE) {
        respond(req, res, 413, 'file too large');
        return;
      }
      const bytes = await readFile(file);
      if (bytes.length > MAX_FILE_SIZE) {
        respond(req, res, 413, 'file too large');
        return;
      }
      respond(
        req,
        res,
        200,
        bytes,
        MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      );
      return;
    } catch {
      /* 未发布或正在替换的资源按缺失处理，不暴露本机路径。 */
    }
  }
  respond(req, res, 404, 'not found');
}

export const assistantResourceServer = new AssistantResourceServer();
