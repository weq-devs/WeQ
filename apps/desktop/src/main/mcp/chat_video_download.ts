import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { toUSVString } from 'node:util';
import { getAppContext, type AccountServices } from '../context/app_context';
import { handleMediaRequest } from '../media_protocol';

export const MCP_CHAT_VIDEO_ROUTE = '/chat/videos/';
const MAX_BYTES = 64 * 1024 * 1024;
const TICKET_TTL_MS = 5 * 60_000;
const MAX_TICKETS = 128;

interface VideoTicket {
  expiresAt: number;
  fileName: string;
  query: URLSearchParams;
}

const accountTickets = new WeakMap<AccountServices, Map<string, VideoTicket>>();
let activeDownloads = 0;

export async function chatVideoForTool(
  account: AccountServices,
  {
    kind,
    conv,
    msgId,
    videoIndex,
  }: {
    kind: 'c2c' | 'group';
    conv: string;
    msgId: string;
    videoIndex: number;
  },
) {
  const row =
    kind === 'group'
      ? await account.msgs.getGroupMessageById(conv, BigInt(msgId))
      : await account.msgs.getC2cMessageById(conv, BigInt(msgId));
  if (getAppContext().services !== account) throw new Error('账号或数据源已切换，请重新查询。');
  if (!row || ('targetGroupCode' in row ? row.targetGroupCode : row.targetUid) !== conv)
    throw new Error('指定会话中没有这条消息。');
  const el = row.elements.filter((el) => el.type === 'video')[videoIndex];
  if (!el) throw new Error('指定消息中没有这个视频。');
  const { fileName: name, fileToken: token, fileSize: size } = el.data;
  if (!name && !token) throw new Error('该消息没有可用的视频原片标识。');
  if (size > MAX_BYTES) throw new Error('MCP 视频下载上限为 64 MiB。');
  const baseName = toUSVString(posix.basename(name.replaceAll('\\', '/')));
  const fileName = !baseName || baseName === '.' || baseName === '..' ? 'video.mp4' : baseName;
  const id = randomUUID();
  let tickets = accountTickets.get(account);
  if (!tickets) {
    tickets = new Map();
    accountTickets.set(account, tickets);
  }
  const now = Date.now();
  for (const [key, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(key);
  if (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value!);
  tickets.set(id, {
    expiresAt: now + TICKET_TTL_MS,
    fileName,
    query: new URLSearchParams({
      t: String(Number(row.sendTime) * 1000),
      name,
      token,
      msgId,
      conv: kind === 'group' ? conv : '',
      intent: 'interactive',
    }),
  });
  return {
    fileName,
    size: Number.isSafeInteger(size) && size > 0 ? size : null,
    downloadPath: `${MCP_CHAT_VIDEO_ROUTE}${id}`,
    expiresIn: TICKET_TTL_MS / 1000,
  };
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (!res.headersSent && !res.destroyed)
    res
      .writeHead(status, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      })
      .end(message);
}

export async function handleMcpChatVideoDownload(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' }).end();
    return;
  }
  const id = req.url?.slice(MCP_CHAT_VIDEO_ROUTE.length) ?? '';
  const account = getAppContext().services;
  const ticket = account ? accountTickets.get(account)?.get(id) : undefined;
  if (!account || !ticket || ticket.expiresAt <= Date.now()) {
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
    const request = new Request(`weq-media://video?${ticket.query}`, { signal });
    const video = await handleMediaRequest(request, check, { cacheVideo: false });
    body = video.body;
    check();
    if (video.status !== 200 || !body) {
      sendError(res, 422, '视频原片不可用。缓存缺失时，需 QQ 在线且视频未过期。');
      return;
    }
    const size = video.headers.get('Content-Length');
    if (size !== null && Number(size) > MAX_BYTES) {
      sendError(res, 413, 'MCP 视频下载上限为 64 MiB。');
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
          if (received > MAX_BYTES) throw new Error('MCP 视频下载上限为 64 MiB。');
          yield chunk;
        }
      },
      res,
      { signal },
    );
  } catch {
    sendError(res, signal.aborted ? 408 : 422, '视频下载中断，请重新调用工具。');
  } finally {
    if (body && !body.locked) await body.cancel().catch(() => undefined);
    res.off('close', abort);
    activeDownloads--;
  }
}
