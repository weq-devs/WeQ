import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { exportMailBody, exportMailMessages } from '../src/account/mail/export';
import type { MailDetail } from '../src/account/mail/types';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const detail: MailDetail = {
  id: 'fixture',
  folderId: 1,
  messageId: 'header-id',
  subject: '../同名邮件',
  snippet: '',
  sender: { name: '合成发件人', email: 'sender@example.invalid' },
  to: [],
  cc: [],
  bcc: [],
  time: 1,
  size: 7,
  unread: true,
  starred: false,
  hasAttachments: true,
  draft: false,
  replyTo: null,
  html: '<p>正文<script>secret</script><img src="https://tracker.invalid"></p>',
  attachments: [
    { id: 'opaque-token', name: '../../same.txt', size: 7, big: false, available: true },
  ],
};
async function context() {
  const directory = await mkdtemp(join(tmpdir(), 'weq-mail-export-'));
  roots.push(directory);
  return { directory, signal: new AbortController().signal, progress: vi.fn() };
}
it('导出基本信息、正文与附件，去重、路径安全且不主动标已读', async () => {
  const ctx = await context();
  const read = vi.fn(async () => structuredClone(detail));
  const result = await exportMailMessages(
    {
      read,
      download: vi.fn(async (_id, path) => {
        await writeFile(path, 'fixture');
      }),
    },
    ['fixture', 'fixture'],
    ctx,
    vi.fn(),
  );
  expect(result).toEqual({ total: 1, ok: 1, failed: [] });
  expect(read).toHaveBeenCalledWith('fixture', ctx.signal, false);
  const index = JSON.parse(await readFile(join(ctx.directory, 'index.json'), 'utf8'));
  const folder = join(ctx.directory, index[0].directory);
  const metadata = JSON.parse(await readFile(join(folder, 'message.json'), 'utf8'));
  expect(metadata.unread).toBe(true);
  expect(metadata.sender).toEqual(detail.sender);
  expect(JSON.stringify(metadata)).not.toContain('opaque-token');
  expect(metadata.attachments[0].file).not.toContain('/');
  expect(await readFile(join(folder, metadata.attachments[0].file), 'utf8')).toBe('fixture');
  const body = await readFile(join(folder, 'body.html'), 'utf8');
  expect(body).toContain('正文');
  expect(body).not.toMatch(/secret|tracker.invalid|<script/);
});
it('附件失效与下载失败记录缺失，底层错误不泄漏凭据', async () => {
  const ctx = await context();
  const result = await exportMailMessages(
    {
      read: vi.fn(async () => structuredClone(detail)),
      download: vi.fn(async () => {
        throw new Error('sid=secret');
      }),
    },
    ['fixture'],
    ctx,
    vi.fn(),
  );
  expect(result.failed).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('secret');
  const index = JSON.parse(await readFile(join(ctx.directory, 'index.json'), 'utf8'));
  const metadata = JSON.parse(
    await readFile(join(ctx.directory, index[0].directory, 'message.json'), 'utf8'),
  );
  expect(metadata.attachments[0].error).toBeTruthy();
});
it('迟到读取遇到账号切换立即终止，不产出索引', async () => {
  const ctx = await context();
  let changed = false;
  await expect(
    exportMailMessages(
      {
        read: vi.fn(async () => {
          changed = true;
          return structuredClone(detail);
        }),
        download: vi.fn(),
      },
      ['fixture'],
      ctx,
      () => {
        if (changed) throw new Error('来源已切换');
      },
    ),
  ).rejects.toThrow('来源已切换');
  await expect(readFile(join(ctx.directory, 'index.json'))).rejects.toThrow();
});
it('正文只留下静态内容，不保留事件、表单、外部加载和脚本链接', () => {
  expect(
    exportMailBody(
      '<p onclick="x()">正文<a href="javascript:x()">链接</a></p><form><input></form>',
    ),
  ).not.toMatch(/onclick|javascript:|<form|<input/);
});
