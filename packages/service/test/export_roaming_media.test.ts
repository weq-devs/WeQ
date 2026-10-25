import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { MsgService } from '../src/account/msg';
import type { GapFetchedMessage } from '../src/account/gap_history';
import { iterateC2cMessages, iterateGroupMessages } from '../src/account/export/message_source';
import { mediaDirsFromNtDataDir, scanConvMedia } from '../src/account/export/media_scan';
import { copyFoundMedia, downloadMissingImages } from '../src/account/export/media_export';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const msgs = {
  getC2cAfter: async () => [],
  getC2cSeqlessAfterRowId: async () => [],
  getGroupAfter: async () => [],
  getGroupSeqlessAfterRowId: async () => [],
} as unknown as MsgService;

it('暂停图片补全后不分配下一项，也不复制在途请求返回的文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-image-cancel-'));
  roots.push(root);
  const rows = Array.from({ length: 3 }, (_, index) => {
    const message = cached('group', '777')[0]!;
    const picture = message.elements[0]!;
    return {
      ...message,
      msgId: String(100 + index),
      elements: [
        {
          ...picture,
          data: { ...picture.data, fileName: `cancel-${index}.jpg`, fileToken: `cancel-${index}` },
        },
      ],
    };
  }) as GapFetchedMessage[];
  const scan = await scanConvMedia(msgs, 'group', '777', mediaDirsFromNtDataDir(root), {
    roam: () => rows,
  });
  const controller = new AbortController();
  const download = vi.fn(async () => {
    controller.abort();
    return '/synthetic/nonexistent-image.jpg';
  });
  const downloader = { download } as unknown as Parameters<typeof downloadMissingImages>[2];
  const result = await downloadMissingImages(
    scan,
    root,
    downloader,
    undefined,
    1,
    undefined,
    controller.signal,
  );
  expect(download).toHaveBeenCalledOnce();
  expect(result.ok).toBe(0);
  expect(result.failed).toBe(0);
});

function cached(kind: 'c2c' | 'group', conv: string): GapFetchedMessage[] {
  return [
    {
      kind,
      conv,
      msgId: '100',
      msgSeq: '10',
      sendTime: '1800000000',
      senderUid: 'u_self',
      senderUin: '10001',
      elements: [
        {
          type: 'pic',
          data: {
            fileName: 'fixture.jpg',
            fileSize: 123,
            imgWidth: 100,
            imgHeight: 100,
            imgType: 0,
            isOriginal: true,
            fileToken: 'fixture-token',
            uploadTime: 0,
            uploadTimestamp: 0,
            fileTTL: 0,
            originalUrl: '',
            summary: [],
          },
        },
      ],
    },
    {
      kind,
      conv,
      msgId: '101',
      msgSeq: '11',
      sendTime: '1800000001',
      senderUid: conv,
      senderUin: '10002',
      elements: [],
    },
  ];
}

it.each(['c2c', 'group'] as const)(
  '补全的 %s 消息可继续扫描媒体而不因缺少目标字段失败',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'weq-roaming-media-'));
    roots.push(root);
    const conv = kind === 'group' ? '777' : 'u_peer';
    const roam = () => cached(kind, conv);
    const scan = await scanConvMedia(msgs, kind, conv, mediaDirsFromNtDataDir(root), { roam });
    expect(scan.totalRefs).toBe(1);
    expect(scan.missing).toHaveLength(1);
    expect(scan.missing[0]?.ocr).toMatchObject({
      senderUin: '10001',
      peerUin: kind === 'group' ? conv : '10002',
      isGroup: kind === 'group',
    });
  },
);

it('私聊补全消息为双方保留同一对端，不把自己的发送者号码当作对端', async () => {
  const rows = [];
  for await (const row of iterateC2cMessages(msgs, 'u_peer', {
    roam: () => cached('c2c', 'u_peer'),
  }))
    rows.push(row);
  expect(rows.map((row) => [row.targetUid, row.targetUin])).toEqual([
    ['u_peer', 10002n],
    ['u_peer', 10002n],
  ]);
});

it('只有自己发出的补全消息时不猜测对端号码', async () => {
  const roam = () => cached('c2c', 'u_peer').slice(0, 1);
  for await (const row of iterateC2cMessages(msgs, 'u_peer', {
    roam,
  })) {
    expect(row.targetUid).toBe('u_peer');
    expect(row.targetUin).toBe(0n);
  }
  const root = await mkdtemp(join(tmpdir(), 'weq-roaming-media-'));
  roots.push(root);
  const scan = await scanConvMedia(msgs, 'c2c', 'u_peer', mediaDirsFromNtDataDir(root), { roam });
  expect(scan.missing[0]?.ocr?.peerUin).toBe('');
});

it('群补全消息保留群号并排除同名的私聊缓存', async () => {
  const rows = [];
  for await (const row of iterateGroupMessages(msgs, '777', {
    roam: () => [
      ...cached('group', '777'),
      ...cached('c2c', '777').map((row) => ({ ...row, msgId: String(BigInt(row.msgId) + 200n) })),
    ],
  }))
    rows.push(row);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.targetGroupCode)).toEqual(['777', '777']);
});

it.each(['c2c', 'group'] as const)(
  '%s 补全消息引用的本地图片可实际搬运到导出目录',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'weq-roaming-media-'));
    roots.push(root);
    const source = join(root, 'Pic', '2027-01', 'Ori');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'fixture.jpg'), 'fixture media bytes');
    const conv = kind === 'group' ? '777' : 'u_peer';
    const scan = await scanConvMedia(msgs, kind, conv, mediaDirsFromNtDataDir(root), {
      roam: () => cached(kind, conv),
    });
    const output = join(root, 'output', 'media');
    expect(await copyFoundMedia(scan, output)).toEqual({ total: 1, ok: 1, failed: 0 });
    expect(await readFile(join(output, 'image', 'fixture.jpg'), 'utf8')).toBe(
      'fixture media bytes',
    );
  },
);
