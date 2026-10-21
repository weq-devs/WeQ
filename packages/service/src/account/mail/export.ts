import { mkdir, writeFile, statfs, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { sanitizeSegment } from '../../common/path_sanitize';
import type { QQMailService } from './client';
import { MailFailure } from './types';
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
): Promise<ResourceExportSummary> {
  const { directory, signal, progress } = context;
  const queue = [...new Set(ids)];
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
      if (detail.thread?.length) {
        for (const child of detail.thread)
          if (!seen.has(child.id) && !queue.includes(child.id)) {
            if (queue.length >= 1000)
              throw new MailFailure('business', '会话邮件超过 1000 封，请分批导出。');
            queue.push(child.id);
          }
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
