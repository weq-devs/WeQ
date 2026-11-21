import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  archiveHeader,
  makeEntry,
  sha256,
  type Archive,
  type ArchiveEntry,
  writeArchiveEntries,
} from '../src/account/export/archive';
import {
  archiveViewerValues,
  streamArchiveViewerValues,
} from '../src/account/export/archive_viewer';
import { DomainArchive } from '../src/account/export/archive_domain';
import { describeViewerFile, readViewerPage } from '../src/account/export/viewer';

describe('正式归档查看投影', () => {
  const header = archiveHeader({ accountUin: '10001' });
  const message = (content: string, time: string, partial = false, deleted = false): ArchiveEntry =>
    makeEntry(
      'message',
      ['10001', '1'],
      {
        conversation: { kind: 'c2c', id: 'peer' },
        messageId: '1',
        seq: '1',
        sender: { identities: [] },
        sentAt: null,
        content: partial
          ? [{ type: 'unknown', sourceType: 'future', reason: '截断' }]
          : [{ type: 'text', text: content }],
      },
      {
        state: deleted ? 'deleted' : 'present',
        coverage: { acquisition: 'partial', parsing: partial ? 'partial' : 'complete' },
        observedAt: { unixSeconds: time, precision: 'nanosecond' },
      },
    );
  it.each(['json', 'jsonl', 'jsonl.gz'] as const)(
    '最新局部观察不能抹掉完整旧正文，%s 流式与内存查看一致',
    async (format) => {
      const root = await mkdtemp(join(tmpdir(), 'weq-view-'));
      try {
        const entries = [message('已有正文', '1.000000001'), message('', '1.000000002', true)];
        const archive = {
          ...header,
          records: entries.map((entry) => entry.record),
          observations: entries.map((entry) => entry.observation),
          resources: [],
        } as Archive;
        const projected = archiveViewerValues(archive);
        expect(JSON.stringify(projected)).toContain('已有正文');
        expect(JSON.stringify(projected)).toContain('最新观察正文不完整');
        const path = join(root, `view.${format}`);
        await writeArchiveEntries(
          path,
          format,
          { ...header, formats: [format === 'jsonl.gz' ? 'jsonl' : format] },
          entries,
        );
        const stream = [];
        for await (const value of streamArchiveViewerValues(path, format)) stream.push(value);
        expect(JSON.stringify(stream)).toContain('已有正文');
        expect(JSON.stringify(stream)).toContain('最新观察正文不完整');
        expect(entries[1]?.record.data.content).toEqual([
          { type: 'unknown', sourceType: 'future', reason: '截断' },
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it('明确删除保持删除状态，不用旧正文冒充当前内容', () => {
    const entries = [message('旧正文', '1'), message('', '2', true, true)];
    const values = archiveViewerValues({
      ...header,
      records: entries.map((entry) => entry.record),
      observations: entries.map((entry) => entry.observation),
      resources: [],
    } as Archive);
    expect(JSON.stringify(values)).not.toContain('旧正文');
    expect(JSON.stringify(values)).toContain('已删除');
  });
  it.each(['json', 'jsonl', 'jsonl.gz'] as const)(
    '%s 保留旧归档小数时间，只展示确认为该内容绑定的媒体',
    async (format) => {
      const root = await mkdtemp(join(tmpdir(), 'weq-legacy-view-'));
      try {
        const path = join(root, `view.${format}`);
        await mkdir(join(root, 'media'));
        await writeFile(join(root, 'media', 'unrelated.png'), '不同来源的同名内容');
        const bytes = '合成已保存媒体';
        const hash = sha256(bytes);
        const saved = `media/${hash}`;
        await writeFile(join(root, saved), bytes);
        const entry = makeEntry('qzone', ['historical-qzone', 'post'], {
          type: 'post',
          sourceId: 'old-post',
          owner: { identities: [] },
          author: { identities: [] },
          createdAt: { unixSeconds: '1792771200.125', precision: 'millisecond' },
          content: ['old-resource', 'shared-file', 'shared-file'].map((id) => ({
            type: 'media',
            mediaType: 'image',
            resourceIds: [id],
          })),
        });
        entry.resources = [
          {
            id: 'old-resource',
            role: 'original',
            status: 'failed',
            name: 'unrelated.png',
            observedAt: { unixSeconds: '1792771201', precision: 'second' },
          },
          {
            id: 'shared-file',
            role: 'original',
            status: 'saved',
            path: saved,
            sha256: hash,
            size: String(Buffer.byteLength(bytes)),
            name: 'cached.png',
            observedAt: { unixSeconds: '1792771201', precision: 'second' },
            bindings: ['candidate', 'verified'].map((status, index) => ({
              recordId: entry.record.id,
              target: `/data/content/${index + 1}`,
              evidence: 'synthetic/association',
              status,
            })),
          },
        ];
        await writeArchiveEntries(
          path,
          format,
          {
            ...header,
            formats: [format === 'jsonl.gz' ? 'jsonl' : format],
          },
          [entry],
        );
        const source = await describeViewerFile(path);
        const page = await readViewerPage(source, { offset: 0, date: '2026-10-24' });
        expect(page.messages).toHaveLength(1);
        expect(page.messages[0]).toMatchObject({
          msgId: entry.record.id,
          sendTime: 1792771200.125,
          parts: [
            expect.objectContaining({ type: 'image', text: 'unrelated.png' }),
            expect.objectContaining({ type: 'image', text: 'cached.png（关联未确认）' }),
            expect.objectContaining({ type: 'image', text: 'cached.png', path: saved }),
          ],
        });
        expect(page.messages[0]?.parts[0]?.path).toBeUndefined();
        expect(page.messages[0]?.parts[1]?.path).toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it('非聊天领域也能显示，附加参数关闭不丢基本正文与工具过程', () => {
    const archive = new DomainArchive({ profile: 'full', extra: { generatedParameters: false } });
    const entry = archive.add(
      'generated',
      ['local', '1'],
      {
        origin: 'local-generated',
        targetKind: 'assistant',
        ownerId: '1',
        sessionId: null,
        messageId: '1',
        sender: { identities: [] },
        role: 'assistant',
        sentAt: null,
        content: [{ type: 'text', text: '生成正文' }],
        process: [{ type: 'json', value: { tool: 'read' } }],
      },
      { model: 'not-selected' },
    );
    expect(entry.record.native).toEqual({ attributes: [], residuals: [] });
    const values = archiveViewerValues({
      ...archive.header,
      records: [entry.record],
      observations: [entry.observation],
      resources: [],
    } as Archive);
    expect(JSON.stringify(values)).toContain('生成正文');
    expect(JSON.stringify(values)).toContain('read');
    expect(JSON.stringify(values)).not.toContain('not-selected');
  });
});
