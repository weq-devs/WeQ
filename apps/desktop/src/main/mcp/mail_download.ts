import { createReadStream } from 'node:fs';
import { mkdtemp, rm, statfs } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { MailFailure } from '@weq/service/mail';
import { getAppContext } from '../context/app_context';
import { mailAttachmentForTool, MCP_MAIL_ATTACHMENT_ROUTE } from './mail_tools';

let activeDownloads = 0;

export async function handleMcpMailDownload(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' }).end();
    return;
  }
  const id = req.url?.slice(MCP_MAIL_ATTACHMENT_ROUTE.length) ?? '';
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) {
    res.writeHead(404).end();
    return;
  }
  if (activeDownloads >= 2) {
    res.writeHead(429, { 'Retry-After': '5' }).end();
    return;
  }
  const services = getAppContext().services;
  if (!services) {
    res.writeHead(409).end('请先打开账号。');
    return;
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
  const abort = () => controller.abort();
  res.once('close', abort);
  activeDownloads++;
  let directory: string | undefined;
  try {
    const { name, size } = mailAttachmentForTool(services.mail, id);
    const space = await statfs(tmpdir());
    if (space.bavail * space.bsize < size + 64 * 1024 * 1024)
      throw new MailFailure('business', '本机临时磁盘空间不足。');
    directory = await mkdtemp(join(tmpdir(), 'weq-mcp-mail-'));
    const path = join(directory, 'attachment');
    await services.mail.download(id, path, signal, size);
    signal.throwIfAborted();
    if (getAppContext().services !== services)
      throw new MailFailure('auth', '账号或数据源已切换。');
    const filename = encodeURIComponent(Buffer.from(name).toString()).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16)}`,
    );
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': size,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'X-Content-Type-Options': 'nosniff',
    });
    await pipeline(createReadStream(path), res, { signal });
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      res
        .writeHead(signal.aborted ? 408 : 422, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
        })
        .end(
          error instanceof MailFailure
            ? error.message
            : '邮件附件不可用，请重新读取邮件或使用 WeQ 邮箱界面下载。',
        );
    }
  } finally {
    res.off('close', abort);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    activeDownloads--;
  }
}
