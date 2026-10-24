import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  exportAllMailMessages,
  exportMailBody,
  exportMailMessages,
  matchesMailExport,
  previewMailExport,
} from '../src/account/mail/export';
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

it('所有邮件遍历各文件夹全部分页，跨文件夹去重且不受 100 封限制', async () => {
  const ctx = await context();
  const rows = Array.from({ length: 101 }, (_, index) => ({ ...detail, id: `mail-${index}` }));
  const list = vi.fn(async ({ folderId, page }: { folderId: number; page: number }) => ({
    items: folderId === 1 ? rows.slice(page * 100, (page + 1) * 100) : rows.slice(0, 1),
    page,
    total: folderId === 1 ? 101 : 1,
    unread: 0,
    hasMore: folderId === 1 && page === 0,
  }));
  const read = vi.fn(async (id: string) => ({ ...detail, id, attachments: [] }));
  const result = await exportAllMailMessages(
    {
      folders: vi.fn(async () =>
        [1, 2, 8].map((id) => ({ id, name: '夹具', total: 0, unread: 0, locked: false })),
      ),
      list,
      read,
      download: vi.fn(),
    },
    ctx,
    vi.fn(),
  );
  expect(list.mock.calls.map(([input]) => [input.folderId, input.page])).toEqual([
    [1, 0],
    [1, 1],
    [2, 0],
    [8, 0],
  ]);
  expect(list).toHaveBeenCalledWith({ folderId: 1, page: 0, pageSize: 100 }, ctx.signal);
  expect(read).toHaveBeenCalledTimes(101);
  expect(result).toEqual({ total: 101, ok: 101, failed: [] });
});

it('日期为起点包含、终点排除，发件人和主题忽略大小写并取交集', () => {
  const mail = { ...detail, time: 100 };
  expect(
    matchesMailExport(mail, {
      startTime: 100,
      endTime: 101,
      sender: 'SENDER@EXAMPLE',
      subject: '同名',
    }),
  ).toBe(true);
  expect(matchesMailExport(mail, { endTime: 100 })).toBe(false);
  expect(matchesMailExport(mail, { startTime: 101 })).toBe(false);
  expect(matchesMailExport(mail, { sender: '合成发件人' })).toBe(true);
  expect(matchesMailExport(mail, { sender: 'missing', subject: '同名' })).toBe(false);
});

it('筛选会话子邮件时不因摘要不匹配而漏导，也不夹带不匹配的子邮件', async () => {
  const ctx = await context();
  const result = await exportMailMessages(
    {
      read: vi.fn(async (id: string) => ({
        ...detail,
        id,
        attachments: [],
        subject: id === 'match' ? '目标主题' : '其他',
        ...(id === 'root' ? { thread: ['match', 'other'].map((id) => ({ ...detail, id })) } : {}),
      })),
      download: vi.fn(),
    },
    ['root'],
    ctx,
    vi.fn(),
    { subject: '目标' },
  );
  expect(result).toEqual({ total: 1, ok: 1, failed: [] });
  expect(JSON.parse(await readFile(join(ctx.directory, 'index.json'), 'utf8'))).toEqual([
    { id: 'match', directory: expect.any(String) },
  ]);
});

it('全量枚举失败、重复分页、锁定、切换来源和取消都不生成成功索引', async () => {
  for (const mode of ['network', 'repeat', 'locked', 'switch', 'cancel']) {
    const ctx = await context();
    let changed = false;
    const controller = new AbortController();
    const runContext = { ...ctx, signal: controller.signal };
    await expect(
      exportAllMailMessages(
        {
          folders: vi.fn(async () => [
            { id: 1, name: '夹具', total: 0, unread: 0, locked: mode === 'locked' },
          ]),
          list: vi.fn(async () => {
            if (mode === 'network') throw new Error('sid=synthetic-secret');
            if (mode === 'switch') changed = true;
            if (mode === 'cancel') controller.abort();
            return { items: [detail], page: 0, total: 2, unread: 0, hasMore: true };
          }),
          read: vi.fn(),
          download: vi.fn(),
        },
        runContext,
        () => {
          if (changed) throw new Error('来源已切换');
        },
      ),
    ).rejects.not.toThrow('synthetic-secret');
    await expect(readFile(join(ctx.directory, 'index.json'))).rejects.toThrow();
  }
});

it('预览跨分页和文件夹去重，展开会话后筛选，只返回可导出的摘要且不读普通正文', async () => {
  const signal = new AbortController().signal;
  const first = { ...detail, id: 'first', subject: '目标', attachments: [] };
  const child = { ...detail, id: 'child', subject: '目标', attachments: [] };
  const list = vi.fn(async ({ folderId, page }: { folderId: number; page: number }) => ({
    items:
      folderId === 1 && page === 0
        ? [first, { ...detail, id: 'C1Tfixture', subject: '非目标摘要' }]
        : folderId === 1
          ? [{ ...detail, id: 'skip', subject: '其他' }]
          : [first],
    page,
    total: 3,
    unread: 0,
    hasMore: folderId === 1 && page === 0,
  }));
  const read = vi.fn(async () => ({
    ...detail,
    id: 'C1Tfixture',
    thread: [child, { ...detail, id: 'other', subject: '其他' }],
  }));
  const rows = await previewMailExport(
    {
      folders: vi.fn(async () =>
        [1, 2].map((id) => ({ id, name: '夹具', total: 0, unread: 0, locked: false })),
      ),
      list,
      read,
    },
    null,
    { subject: '目标' },
    signal,
    vi.fn(),
  );
  expect(rows.map((item) => item.id)).toEqual(['first', 'child']);
  expect(list).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith('C1Tfixture', signal, false);
});

it('所选邮件预览只读一次，剔除正文和附件令牌；取消和切源不返回迟到结果', async () => {
  const signal = new AbortController().signal;
  const read = vi.fn(async () => structuredClone(detail));
  const mail = { folders: vi.fn(), list: vi.fn(), read };
  const rows = await previewMailExport(mail, ['fixture', 'fixture'], {}, signal, vi.fn());
  expect(rows).toHaveLength(1);
  expect(read).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(rows)).not.toMatch(/opaque-token|tracker.invalid|"html"|"attachments"/);
  expect(mail.list).not.toHaveBeenCalled();
  const controller = new AbortController();
  read.mockImplementationOnce(async () => {
    controller.abort();
    return structuredClone(detail);
  });
  await expect(
    previewMailExport(mail, ['fixture'], {}, controller.signal, vi.fn()),
  ).rejects.toThrow();
  let changed = false;
  read.mockImplementationOnce(async () => {
    changed = true;
    return structuredClone(detail);
  });
  await expect(
    previewMailExport(mail, ['fixture'], {}, signal, () => {
      if (changed) throw new Error('切源');
    }),
  ).rejects.toThrow('切源');
});

it('确认后的精确列表不会把新出现的会话子邮件加进导出', async () => {
  const ctx = await context();
  const read = vi.fn(async () => ({ ...detail, thread: [{ ...detail, id: 'late-child' }] }));
  const result = await exportMailMessages(
    { read, download: vi.fn() },
    ['fixture'],
    ctx,
    vi.fn(),
    {},
    false,
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(result.ok).toBe(0);
  expect(result.failed[0]?.error).toContain('重新查询');
});
