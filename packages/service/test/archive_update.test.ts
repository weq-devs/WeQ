import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  archiveHeader,
  canonical,
  makeEntry,
  readArchiveFile,
  writeArchiveEntries,
  sha256,
  recordRevision,
  type ArchiveEntry,
} from '../src/account/export/archive';
import { updateArchiveFile } from '../src/account/export/archive_update';

const options = { archiveId: 'original-archive', accountUin: '10001', incrementalSupport: true };
const entry = (id: string, text: string, observation = `scan:${id}:${text}`): ArchiveEntry =>
  makeEntry(
    'message',
    ['10001', 'group', '20001', id],
    {
      conversation: { kind: 'group', id: '20001' },
      messageId: id,
      seq: id,
      sender: { identities: [] },
      sentAt: { unixSeconds: '1793800000', precision: 'second' },
      content: [{ type: 'text', text }],
    },
    { observationId: observation, observedAt: { unixSeconds: '1793800001', precision: 'second' } },
  );

describe.each(['json', 'jsonl'] as const)('正式归档 %s 更新', (format) => {
  async function fixture(run: (root: string, target: string, incoming: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'weq-update-'));
    try {
      await run(root, join(root, `old.${format}`), join(root, `new.${format}`));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const write = (path: string, entries: ArchiveEntry[], accountUin = '10001') =>
    writeArchiveEntries(
      path,
      format,
      archiveHeader({ ...options, accountUin, formats: [format] }),
      entries,
    );
  it('未来同主版本的未知可选字段和原 header 在更新后原样保留', async () =>
    fixture(async (_root, target, incoming) => {
      await write(target, [entry('1', '旧正文')]);
      const { archive } = await readArchiveFile(target, format);
      archive.version = '1.2';
      archive.futureHeader = { retained: 'header' };
      archive.records[0]!.futureRecord = { retained: ['unknown', 12] };
      archive.records[0]!.revision = recordRevision(archive.records[0]!);
      archive.observations[0]!.revision = archive.records[0]!.revision;
      const { records, observations, resources, ...header } = archive;
      if (format === 'json') await writeFile(target, canonical(archive));
      else {
        const batchId = 'future-batch';
        const rows = [
          ...records.map((record) => ({ type: 'revision', batchId, record })),
          ...observations.map((observation) => ({ type: 'observation', batchId, observation })),
          ...resources.map((resource) => ({ type: 'resource', batchId, resource })),
        ];
        const body = rows.map((row) => `${canonical(row)}\n`).join('');
        await writeFile(
          target,
          `${canonical({ type: 'header', header })}\n${body}${canonical({ type: 'commit', batchId, sequence: '1', entries: rows.length, sha256: sha256(body), previous: null })}\n`,
        );
      }
      await write(incoming, [entry('2', '新正文')]);
      await updateArchiveFile(target, incoming, format);
      const updated = (await readArchiveFile(target, format)).archive;
      expect(updated.version).toBe('1.2');
      expect(updated.futureHeader).toEqual(archive.futureHeader);
      expect(updated.records[0]!.futureRecord).toEqual(archive.records[0]!.futureRecord);
      expect(updated.archiveId).toBe(header.archiveId);
    }));
  it('保留旧范围，新增晚到历史和版本，不重写既有 JSONL 正文', async () =>
    fixture(async (_root, target, incoming) => {
      await write(target, [entry('2', '旧正文')]);
      const prefix = await readFile(target, 'utf8');
      await write(incoming, [entry('1', '晚到历史'), entry('2', '修改正文')]);
      expect(await updateArchiveFile(target, incoming, format)).toMatchObject({
        archiveId: options.archiveId,
        entries: 4,
      });
      const output = await readFile(target, 'utf8');
      if (format === 'jsonl') expect(output.startsWith(prefix)).toBe(true);
      const { archive } = await readArchiveFile(target, format);
      expect(archive.records).toHaveLength(3);
      expect(archive.observations.map((value) => value.id)).toEqual([
        'scan:2:旧正文',
        'scan:1:晚到历史',
        'scan:2:修改正文',
      ]);
      const before = await readFile(target);
      expect((await updateArchiveFile(target, incoming, format)).entries).toBe(0);
      expect(await readFile(target)).toEqual(before);
    }));
  it('同内容新观察不复制正文，同一观察 ID 不允许偷偷改值', async () =>
    fixture(async (_root, target, incoming) => {
      await write(target, [entry('1', '正文', 'first')]);
      await write(incoming, [entry('1', '正文', 'second')]);
      await updateArchiveFile(target, incoming, format);
      const { archive } = await readArchiveFile(target, format);
      expect(archive.records).toHaveLength(1);
      expect(archive.observations).toHaveLength(2);
      await write(incoming, [entry('1', '不同正文', 'first')]);
      const before = await readFile(target);
      await expect(updateArchiveFile(target, incoming, format)).rejects.toThrow('观察 ID');
      expect(await readFile(target)).toEqual(before);
    }));
  it('账号不匹配或存在写锁时不改正式数据，失败清理本轮临时物', async () =>
    fixture(async (root, target, incoming) => {
      await write(target, [entry('1', '正文')]);
      await write(incoming, [entry('2', '其他账号')], '10002');
      const before = await readFile(target);
      await expect(updateArchiveFile(target, incoming, format)).rejects.toThrow('账号不匹配');
      expect(await readFile(target)).toEqual(before);
      expect((await readdir(root)).sort()).toEqual([`new.${format}`, `old.${format}`]);
      await writeFile(`${target}.weq-lock`, 'another-writer');
      await expect(updateArchiveFile(target, incoming, format)).rejects.toThrow('正在更新');
      expect(await readFile(`${target}.weq-lock`, 'utf8')).toBe('another-writer');
    }));
  if (format === 'jsonl')
    it('只修复未提交尾部，已提交内容损坏时停止', async () =>
      fixture(async (_root, target, incoming) => {
        await write(target, [entry('1', '正文')]);
        const prefix = await readFile(target, 'utf8');
        await appendFile(target, '{"type":"revision"}\n{invalid-json}\n{"type":"revision"');
        await write(incoming, [entry('2', '新增')]);
        await updateArchiveFile(target, incoming, format);
        expect((await readFile(target, 'utf8')).startsWith(prefix)).toBe(true);
        expect((await readArchiveFile(target, format)).archive.records).toHaveLength(2);
        await writeFile(target, (await readFile(target, 'utf8')).replace('正文', '篡改'));
        const damaged = await readFile(target);
        await expect(updateArchiveFile(target, incoming, format)).rejects.toThrow('摘要');
        expect(await readFile(target)).toEqual(damaged);
      }));
});
