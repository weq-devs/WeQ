import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { object, readArchiveFile } from '../src/account/export/archive';
import { writeGeneratedContent } from '../src/account/export/generated_export';
import { archiveViewerValues } from '../src/account/export/archive_viewer';
import { writeQzoneArchive } from '../src/account/export/archive_domain';
import type { GeneratedContentSnapshot } from '../src/account/generated_content';

const snapshot: GeneratedContentSnapshot = {
  origin: 'local-generated',
  target: { kind: 'assistant', ownerId: 'assistant', sessionId: 'session' },
  title: '助手',
  sessionTitle: '合成会话',
  capturedAt: 1000,
  messages: [
    {
      id: 'reply',
      text: '保留正文',
      ts: 1000,
      role: 'assistant',
      replyToId: 'outside',
      steps: [{ text: '过程' }],
      toolsUsed: ['tool'],
      actions: [{ name: 'action' }],
    },
  ],
};

it('关闭生成参数后，结构化归档不带过程，表格也不夹带完整记录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-domain-details-'));
  try {
    const options = { profile: 'full' as const, extra: { generatedParameters: false } };
    for (const format of ['json', 'jsonl', 'txt'] as const) {
      const path = join(root, `generated.${format}`);
      await writeGeneratedContent(snapshot, format, path, undefined, options);
      const output = await readFile(path, 'utf8');
      expect(output).toContain('保留正文');
      expect(output).not.toContain('过程');
      expect(output).not.toContain('toolsUsed');
      if (format !== 'txt') {
        const { archive } = await readArchiveFile(path, format);
        expect(archive.records[0]!.data.process).toEqual([]);
        expect(JSON.stringify(archiveViewerValues(archive))).not.toContain('"textContent":"[]"');
        expect(archive.records[0]!.data.replyToId).toBeDefined();
        expect(archive.externalReferences).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: archive.records[0]!.data.replyToId, kind: 'generated' }),
          ]),
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('空间保留未映射的来源属性；不同作者的同名转发不合并，未知原帖时间不伪造为 epoch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-qzone-details-'));
  try {
    const path = join(root, 'qzone.json');
    await writeQzoneArchive(
      {
        mediaOk: 0,
        mediaFailed: 0,
        rows: ['20001', '20002'].map((uin, index) => ({
          tid: `post-${index}`,
          time: 100,
          content: '转发',
          commentNum: 0,
          isPrivate: false,
          images: [],
          videos: [],
          imageTotal: 4,
          contentTruncated: true,
          repost: { tid: 'shared-tid', uin, nickname: uin, content: uin, images: [], videos: [] },
        })),
      },
      {
        name: '合成空间',
        localMedia: false,
        outputPath: path,
        targetUin: '10001',
        archive: { profile: 'full', accountUin: '10001' },
      },
      'json',
    );
    const { archive } = await readArchiveFile(path, 'json');
    const originals = archive.records.filter((record) => record.data.sourceId === 'shared-tid');
    expect(new Set(originals.map((record) => record.id)).size).toBe(2);
    expect(originals.map((record) => record.data.createdAt)).toEqual([null, null]);
    const post = archive.records.find((record) => record.data.sourceId === 'post-0')!;
    const attributes = object(post.native).attributes as Array<{ name: string; value: unknown }>;
    expect(attributes.map((attribute) => attribute.name)).toContain('source.imageTotal');
    expect(attributes.map((attribute) => attribute.name)).toContain('source.contentTruncated');
    expect(post.data.repostId).toBe(originals[0]!.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
