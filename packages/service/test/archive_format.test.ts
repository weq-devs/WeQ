import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  archiveHeader,
  canonical,
  decodeArchiveLog,
  encodeArchiveLog,
  makeEntry,
  parseArchiveJson,
  readArchive,
  readArchiveFile,
  recordRevision,
  writeArchiveEntries,
  type Archive,
} from '../src/account/export/archive';
import { exportArchiveConversation } from '../src/account/export/archive_message';
import type { MsgService } from '../src/account/msg';
import { scanArchiveFile, streamArchiveEvents } from '../src/account/export/archive_stream';

const options = {
  accountUin: '10001',
  archiveId: 'test-archive',
  formats: ['json', 'jsonl'] as Array<'json' | 'jsonl'>,
  incrementalSupport: true,
};
function fixture(): Archive {
  const entry = makeEntry(
    'message',
    ['10001', 'group', '20001', '1'],
    {
      conversation: { kind: 'group', id: '20001' },
      messageId: '1',
      sender: { identities: [{ namespace: 'qq-uin', value: '10002' }] },
      sentAt: { unixSeconds: '1793800000', precision: 'second' },
      seq: '0',
      content: [{ type: 'text', text: '合成正文' }],
    },
    { observationId: 'scan-1' },
  );
  return {
    ...archiveHeader(options),
    records: [entry.record],
    observations: [entry.observation],
    resources: [],
  } as Archive;
}
describe('正式导出格式', () => {
  it('数字键按 UTF-16 顺序直接编码，大整数不经过数值转换', () => {
    expect(canonical({ 2: 'b', 10: 'a' })).toBe('{"10":"a","2":"b"}');
    expect(() => canonical({ n: 9007199254740992 })).toThrow('整数精度');
    expect(() => parseArchiveJson('{"x":1,"\\u0078":2}')).toThrow('重复 JSON 键');
    expect(() => parseArchiveJson('{"n":-0}')).toThrow('非规范');
  });
  it('严格 writer、宽容 reader 共用结构并保留未来字段', () => {
    const archive = fixture();
    archive.version = '1.2';
    archive.extension = { retained: 'yes' };
    archive.records[0]!.extension = { more: 'data' };
    archive.records[0]!.revision = recordRevision(archive.records[0]!);
    archive.observations[0]!.revision = archive.records[0]!.revision;
    expect(readArchive(archive)).toBe(archive);
    expect(() => encodeArchiveLog(archive)).toThrow();
    expect(() => readArchive({ ...archive, version: '2.0' })).toThrow('不支持');
  });
  it('JSONL 验证提交链，坏提交拒绝，未提交尾部不进入正式状态', () => {
    const archive = fixture();
    const log = encodeArchiveLog(archive);
    expect(decodeArchiveLog(log).archive).toEqual(archive);
    expect(decodeArchiveLog(`${log}{"type":"revision"`).uncommittedTail).toBe(true);
    const lines = log.trimEnd().split('\n');
    const commit = JSON.parse(lines.at(-1)!);
    commit.sha256 = '0'.repeat(64);
    lines[lines.length - 1] = JSON.stringify(commit);
    expect(() => decodeArchiveLog(`${lines.join('\n')}\n`)).toThrow('摘要');
    expect(() => decodeArchiveLog(log.replace('合成正文', '被改正文'))).toThrow('摘要');
  });
  it('拒绝悬空观察、资源与被篡改正文', () => {
    const archive = fixture();
    archive.observations[0]!.revision = '0'.repeat(64);
    expect(() => readArchive(archive)).toThrow('悬空');
    const media = fixture();
    media.records[0]!.data.content = [
      { type: 'media', mediaType: 'image', resourceIds: ['missing'] },
    ];
    media.records[0]!.revision = recordRevision(media.records[0]!);
    media.observations[0]!.revision = media.records[0]!.revision;
    expect(() => readArchive(media)).toThrow('悬空');
  });
  it.each(['json', 'jsonl'] as const)('流式写出 %s 并清理本轮暂存文件', async (format) => {
    const root = await mkdtemp(join(tmpdir(), 'weq-archive-'));
    try {
      const archive = fixture(),
        path = join(root, `messages.${format}`);
      const { records, observations, resources, ...header } = archive;
      await writeArchiveEntries(path, format, header, [
        { record: records[0]!, observation: observations[0]!, resources },
      ]);
      expect((await readArchiveFile(path, format)).archive).toEqual(archive);
      const scan = await scanArchiveFile(path, format);
      expect(scan.header.archiveId).toBe(archive.archiveId);
      expect(scan.latest.get(archive.records[0]!.id)?.revision).toBe(archive.records[0]!.revision);
      const events = [];
      for await (const event of streamArchiveEvents(path, format, { ...scan.state }))
        events.push(event);
      expect(events.map((event) => event.type)).toEqual(
        format === 'json' ? ['revision', 'observation'] : ['revision', 'observation', 'commit'],
      );
      expect(await readdir(root)).toEqual([`messages.${format}`]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('失败不覆盖原文件，也不遗留半成品', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weq-archive-'));
    try {
      const archive = fixture(),
        path = join(root, 'messages.json');
      const entry = { record: archive.records[0]!, observation: archive.observations[0]! };
      const {
        records: _records,
        observations: _observations,
        resources: _resources,
        ...header
      } = archive;
      await writeArchiveEntries(path, 'json', header, [entry]);
      const original = await readFile(path, 'utf8');
      entry.record.data.content = [{ type: 'text', text: '摘要不匹配' }];
      await expect(writeArchiveEntries(path, 'json', header, [entry])).rejects.toThrow('摘要');
      expect(await readFile(path, 'utf8')).toBe(original);
      expect(await readdir(root)).toEqual(['messages.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('消息完整档保留 bigint 原生属性，基础档不带 native', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weq-archive-'));
    const msgs = {
      async *exportC2cMessages() {
        yield {
          msgId: 9007199254740993n,
          msgSeq: 0n,
          targetUid: 'peer',
          targetUin: 10002n,
          senderUid: 'peer',
          senderUin: 10002n,
          sendTime: 1793800000n,
          clientSeq: 9007199254740994n,
          elements: [{ type: 'text', data: { textContent: '完整正文', subType: 0 } }],
        };
      },
    } as unknown as MsgService;
    try {
      for (const profile of ['basic', 'full'] as const) {
        const path = join(root, `${profile}.json`);
        await exportArchiveConversation(msgs, {
          kind: 'c2c',
          conv: 'peer',
          outputPath: path,
          format: 'json',
          archive: { ...options, profile },
        });
        const { archive } = await readArchiveFile(path, 'json');
        expect(archive.records[0]!.data.messageId).toBe('9007199254740993');
        expect(archive.records[0]!.data.content).toEqual([{ type: 'text', text: '完整正文' }]);
        if (profile === 'basic') expect(archive.records[0]!.native).toBeUndefined();
        else
          expect(archive.records[0]!.native).toMatchObject({
            attributes: expect.arrayContaining([
              {
                target: '/data',
                name: 'clientSeq',
                value: { type: 'integer', value: '9007199254740994' },
              },
            ]),
          });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
