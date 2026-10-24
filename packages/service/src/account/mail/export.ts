import { mkdir, writeFile, statfs, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { sanitizeSegment } from '../../common/path_sanitize';
import type { QQMailService } from './client';
import { MailFailure, type MailExportFilter, type MailSummary } from './types';
import { isMailThreadId } from './wire';
import type { ResourceExportRunContext, ResourceExportSummary } from '../export/task_manager';

const BODY_TAGS = new Set([
  'p',
  'br',
  'div',
  'span',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'blockquote',
  'pre',
  'code',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'h1',
  'h2',
  'h3',
  'h4',
  'hr',
  'a',
]);

const BLOCKED_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'svg',
  'math',
  'template',
  'link',
  'meta',
  'base',
]);

/** 导出不请求外部图片或保留活动内容；图片替为占位，附件另存。 */
export function exportMailBody(html: string): string {
  const fragment = parseFragment(html);
  const visit = (parent: DefaultTreeAdapterMap['parentNode']) => {
    parent.childNodes = parent.childNodes.flatMap((node) => {
      if (!('tagName' in node)) return [node];
      if (BLOCKED_TAGS.has(node.tagName)) return [];
      if (node.tagName === 'img') return parseFragment('[图片未导出]').childNodes;
      visit(node);
      return BODY_TAGS.has(node.tagName) ? [node] : node.childNodes;
    });
    for (const node of parent.childNodes) {
      node.parentNode = parent;
      if ('tagName' in node) {
        node.attrs = [];
      }
    }
  };
  visit(fragment);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>邮件正文</title><style>body{font:16px/1.6 sans-serif;max-width:900px;margin:24px auto;padding:0 16px;overflow-wrap:anywhere}pre{white-space:pre-wrap}table{max-width:100%}@media(prefers-color-scheme:dark){body{background:#171717;color:#eee}}</style><body>${serialize(fragment)}</body></html>`;
}

export async function exportMailMessages(
  mail: Pick<QQMailService, 'read' | 'download'>,
  ids: readonly string[],
  context: ResourceExportRunContext,
  check: () => void,
  filter: MailExportFilter = {},
  expandThreads = true,
): Promise<ResourceExportSummary> {
  const { directory, signal, progress } = context;
  const queue = [...new Set(ids)];
  const queued = new Set(queue);
  const seen = new Set<string>();
  const manifest: Array<{ id: string; directory?: string; error?: string }> = [];
  const failed: ResourceExportSummary['failed'] = [];
  const current = () => {
    signal.throwIfAborted();
    check();
  };
  for (let index = 0; index < queue.length; index++) {
    current();
    const id = queue[index]!;
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const detail = await mail.read(id, signal, false);
      current();
      if (!expandThreads && detail.thread)
        throw new MailFailure('business', '邮件已变为会话，请重新查询待导出列表。');
      if (detail.thread?.length) {
        for (const child of detail.thread)
          if (!queued.has(child.id)) {
            queued.add(child.id);
            queue.push(child.id);
          }
      }
      // 会话中的每封子邮件独立筛选，不能因会话摘要不匹配而漏掉子邮件。
      if (!matchesMailExport(detail, filter)) {
        progress(index + 1, queue.length);
        continue;
      }
      const folder = `${String(index + 1).padStart(4, '0')}-${sanitizeSegment(detail.subject, '邮件', { maxLen: 60 })}`;
      const target = join(directory, folder);
      await mkdir(target, { recursive: true });
      const attachments: Array<{ name: string; size: number; file?: string; error?: string }> = [];
      for (const [number, attachment] of detail.attachments.entries()) {
        current();
        const file = `${number + 1}-${sanitizeSegment(attachment.name, '附件', { maxLen: 100 })}`;
        const path = join(target, file);
        try {
          if (!attachment.available) throw new MailFailure('business', '附件已失效。');
          const space = await statfs(directory);
          current();
          if (space.bavail * space.bsize < attachment.size + 64 * 1024 * 1024)
            throw new MailFailure('business', '目标磁盘空间不足。');
          await mail.download(attachment.id, path, signal);
          current();
          attachments.push({ name: attachment.name, size: attachment.size, file });
        } catch (error) {
          current();
          await rm(path, { force: true });
          const message = error instanceof MailFailure ? error.message : '附件导出失败。';
          attachments.push({ name: attachment.name, size: attachment.size, error: message });
          failed.push({ fileName: `${folder}/${file}`, error: message });
        }
      }
      current();
      const { html, attachments: _tokens, ...metadata } = detail;
      await writeFile(
        join(target, 'message.json'),
        JSON.stringify({ ...metadata, attachments }, null, 2),
        { flag: 'wx' },
      );
      current();
      await writeFile(join(target, 'body.html'), exportMailBody(html), { flag: 'wx' });
      current();
      manifest.push({ id, directory: folder });
    } catch (error) {
      current();
      const message = error instanceof MailFailure ? error.message : '邮件导出失败。';
      manifest.push({ id, error: message });
      failed.push({ fileName: `邮件 ${index + 1}`, error: message });
    }
    progress(index + 1, queue.length);
  }
  current();
  await writeFile(join(directory, 'index.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  current();
  return {
    total: manifest.length + failed.filter((item) => item.fileName.includes('/')).length,
    ok: manifest.filter((item) => item.directory).length,
    failed,
  };
}

/** 在公共后台任务中枚举整个邮箱，不继承内容页的分页、搜索或未读条件。 */
export async function exportAllMailMessages(
  mail: Pick<QQMailService, 'folders' | 'list' | 'read' | 'download'>,
  context: ResourceExportRunContext,
  check: () => void,
  filter: MailExportFilter = {},
): Promise<ResourceExportSummary> {
  const rows = await listMailExportItems(mail, context.signal, check);
  return exportMailMessages(
    mail,
    rows.map((item) => item.id),
    context,
    check,
    filter,
  );
}

async function listMailExportItems(
  mail: Pick<QQMailService, 'folders' | 'list'>,
  signal: AbortSignal,
  check: () => void,
): Promise<MailSummary[]> {
  const current = () => {
    signal.throwIfAborted();
    check();
  };
  current();
  const safeRead = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      current();
      throw error instanceof MailFailure
        ? error
        : new MailFailure('network', '邮箱列表读取失败，请重试。');
    }
  };
  const folders = await safeRead(() => mail.folders(signal));
  current();
  const rows = new Map<string, MailSummary>();
  for (const folder of folders) {
    if (folder.locked) throw new MailFailure('business', '邮箱包含加锁文件夹，请解锁后重试。');
    const listed = new Set<string>();
    for (let page = 0; ; page++) {
      current();
      const result = await safeRead(() =>
        mail.list({ folderId: folder.id, page, pageSize: 100 }, signal),
      );
      current();
      const before = listed.size;
      for (const item of result.items) {
        listed.add(item.id);
        rows.set(item.id, item);
        if (rows.size > 100000)
          throw new MailFailure('business', '邮件超过十万封，请缩小导出范围。');
      }
      if (!result.hasMore) break;
      if (listed.size === before || page >= 100000)
        throw new MailFailure('business', '邮箱分页未能继续，已停止导出，请重试。');
    }
  }
  return [...rows.values()];
}

/** 先枚举实际邮件；只补读会话目录，预览不下载附件、不标为已读。 */
export async function previewMailExport(
  mail: Pick<QQMailService, 'folders' | 'list' | 'read'>,
  ids: readonly string[] | null,
  filter: MailExportFilter,
  signal: AbortSignal,
  check: () => void,
): Promise<MailSummary[]> {
  const current = () => {
    signal.throwIfAborted();
    check();
  };
  const readSummary = async (id: string) => {
    current();
    try {
      const detail = await mail.read(id, signal, false);
      current();
      const {
        html: _html,
        attachments: _attachments,
        replyTo: _replyTo,
        thread,
        ...summary
      } = detail;
      return { summary, thread };
    } catch (error) {
      current();
      throw error instanceof MailFailure
        ? error
        : new MailFailure('network', '待导出邮件读取失败，请重试。');
    }
  };
  current();
  const queue: MailSummary[] = [];
  if (ids === null) queue.push(...(await listMailExportItems(mail, signal, check)));
  else {
    for (const id of new Set(ids)) {
      const { summary, thread } = await readSummary(id);
      queue.push(...(thread ?? [summary]));
    }
  }
  const seen = new Set<string>();
  const result: MailSummary[] = [];
  for (let index = 0; index < queue.length; index++) {
    current();
    const item = queue[index]!;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (seen.size > 100000) throw new MailFailure('business', '邮件超过十万封，请缩小导出范围。');
    if (isMailThreadId(item.id)) {
      const { thread } = await readSummary(item.id);
      if (!thread) throw new MailFailure('business', '会话邮件已变化，请重新查询。');
      queue.push(...thread);
    } else if (matchesMailExport(item, filter)) result.push(item);
  }
  current();
  return result;
}

export function matchesMailExport(mail: MailSummary, filter: MailExportFilter): boolean {
  if (filter.startTime !== undefined && mail.time < filter.startTime) return false;
  if (filter.endTime !== undefined && mail.time >= filter.endTime) return false;
  const sender = filter.sender?.trim().toLowerCase();
  if (sender && !`${mail.sender.name}\n${mail.sender.email}`.toLowerCase().includes(sender))
    return false;
  const subject = filter.subject?.trim().toLowerCase();
  return !subject || mail.subject.toLowerCase().includes(subject);
}
