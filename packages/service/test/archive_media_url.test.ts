import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readArchiveFile } from '../src/account/export/archive';
import { exportArchiveConversation } from '../src/account/export/archive_message';
import type { MsgService } from '../src/account/msg';

describe('消息归档的媒体地址', () => {
  it.each([
    [
      '/download?appid=1407&fileid=synthetic',
      'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=synthetic',
    ],
    ['download?fileid=synthetic', 'https://multimedia.nt.qq.com.cn/download?fileid=synthetic'],
    ['https://example.invalid/image.png?x=1', 'https://example.invalid/image.png?x=1'],
    ['http://example.invalid/image.png', 'http://example.invalid/image.png'],
    [
      'https://example.invalid/合成图片.png',
      'https://example.invalid/%E5%90%88%E6%88%90%E5%9B%BE%E7%89%87.png',
    ],
    ['http://[invalid', undefined],
    ['https://example.invalid/bad%escape.png', undefined],
    ['', undefined],
  ])('原地址 %s 在 JSON/JSONL 中通过严格校验', async (originalUrl, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'weq-archive-media-url-'));
    const msgs = {
      async *exportC2cMessages() {
        yield {
          msgId: 1n,
          msgSeq: 1n,
          targetUid: 'peer',
          targetUin: 10002n,
          senderUid: 'peer',
          senderUin: 10002n,
          sendTime: 1793800000n,
          elements: [{ type: 'pic', data: { fileName: 'synthetic.png', originalUrl } }],
        };
      },
    } as unknown as MsgService;
    try {
      for (const format of ['json', 'jsonl'] as const)
        for (const profile of ['basic', 'full'] as const) {
          const outputPath = join(root, `${profile}.${format}`);
          await exportArchiveConversation(msgs, {
            kind: 'c2c',
            conv: 'peer',
            outputPath,
            format,
            archive: { accountUin: '10001', profile },
          });
          const { archive } = await readArchiveFile(outputPath, format);
          expect(archive.resources).toHaveLength(1);
          expect(archive.resources[0]?.url).toBe(expected);
          if (profile === 'full' && originalUrl !== expected)
            expect(archive.records[0]?.native).toMatchObject({
              attributes: expect.arrayContaining([
                expect.objectContaining({
                  name: 'source.originalUrl',
                  value: { type: 'text', value: originalUrl },
                }),
              ]),
            });
        }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
