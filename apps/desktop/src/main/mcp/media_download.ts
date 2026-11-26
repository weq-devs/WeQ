import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { toUSVString } from 'node:util';
import { getAppContext, type AccountServices } from '../context/app_context';

const MAX_BYTES = 64 * 1024 * 1024;
const TICKET_TTL_MS = 5 * 60_000;
const MAX_TICKETS = 128;
let activeDownloads = 0;

type OpenMedia = (signal: AbortSignal, check: () => void) => Promise<Response>;
interface Ticket {
  expiresAt: number;
  fileName: string;
  open: OpenMedia;
}

function sendError(res: ServerResponse, status: number, message: string) {
  if (!res.headersSent && !res.destroyed)
    res
      .writeHead(status, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      })
      .end(message);
}

export function createMcpDownloadRoute(path: string, label: string, fallbackName: string) {
  const accountTickets = new WeakMap<AccountServices, Map<string, Ticket>>();
  const limitError = `MCP ${label}下载上限为 64 MiB。`;
  return {
    issue(account: AccountServices, name: string, size: number | undefined, open: OpenMedia) {
      if (size !== undefined && size > MAX_BYTES) throw new Error(limitError);
      const base = toUSVString(posix.basename(name.replaceAll('\\', '/')));
      const fileName = !base || base === '.' || base === '..' ? fallbackName : base;
      const id = randomUUID();
      let tickets = accountTickets.get(account);
      if (!tickets) {
        tickets = new Map();
        accountTickets.set(account, tickets);
      }
      const now = Date.now();
      for (const [key, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(key);
      if (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value!);
      tickets.set(id, { expiresAt: now + TICKET_TTL_MS, fileName, open });
      return {
        fileName,
        size: size !== undefined && Number.isSafeInteger(size) && size > 0 ? size : null,
        downloadPath: `${path}${id}`,
        expiresIn: TICKET_TTL_MS / 1000,
      };
    },

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' }).end();
        return;
      }
      const id = req.url?.slice(path.length) ?? '';
      const account = getAppContext().services;
      const ticket = account ? accountTickets.get(account)?.get(id) : undefined;
      if (!ticket || ticket.expiresAt <= Date.now()) {
        sendError(res, 404, '下载路径无效或已过期，请重新调用工具。');
        return;
      }
      if (activeDownloads >= 2) {
        res.writeHead(429, { 'Retry-After': '5', 'Cache-Control': 'no-store' }).end();
        return;
      }

      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
      const abort = () => controller.abort();
      const check = () => {
        signal.throwIfAborted();
        if (getAppContext().services !== account) throw new Error('账号或数据源已切换。');
      };
      res.once('close', abort);
      activeDownloads++;
      let body: Response['body'] = null;
      try {
        const response = await ticket.open(signal, check);
        body = response.body;
        check();
        if (response.status !== 200 || !body) {
          sendError(res, 422, `${label}不可用。缓存缺失时，需 QQ 在线且文件未过期。`);
          return;
        }
        const size = response.headers.get('Content-Length');
        if (size !== null && Number(size) > MAX_BYTES) {
          sendError(res, 413, limitError);
          return;
        }
        const fileName = encodeURIComponent(ticket.fileName).replace(
          /[!'()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16)}`,
        );
        res.strictContentLength = size !== null;
        res.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${fileName}`,
          'X-Content-Type-Options': 'nosniff',
          ...(size === null ? {} : { 'Content-Length': size }),
        });
        await pipeline(
          Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
          async function* (chunks) {
            let received = 0;
            for await (const chunk of chunks) {
              check();
              received += chunk.byteLength;
              if (received > MAX_BYTES) throw new Error(limitError);
              yield chunk;
            }
          },
          res,
          { signal },
        );
      } catch {
        sendError(res, signal.aborted ? 408 : 422, `${label}下载中断，请重新调用工具。`);
      } finally {
        if (body && !body.locked) await body.cancel().catch(() => undefined);
        res.off('close', abort);
        activeDownloads--;
      }
    },
  };
}
