import { appendFile, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  archiveHeader,
  decodeArchiveLog,
  makeEntry,
  readArchiveFile,
  writeArchive,
  writeArchiveEntries,
} from '../src/account/export/archive';
import {
  compressedArchiveBlocks,
  compressArchiveBlock,
} from '../src/account/export/archive_compression';
import * as compression from '../src/account/export/archive_compression';
import { scanArchiveFile } from '../src/account/export/archive_stream';
import { updateArchiveFile } from '../src/account/export/archive_update';
import {
  describeViewerFile,
  discoverViewerSources,
  readViewerPage,
} from '../src/account/export/viewer';
import { listFormalArchives, resolveArchiveTargets } from '../src/account/export/archive_catalog';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';
import { fileExtension, uniqueName } from '../src/common/path_sanitize';
import { describeExportOutput, exportOutputFileName } from '../src/account/export/output_shape';

const format = 'jsonl.gz';
const header = () =>
  archiveHeader({
    archiveId: 'compressed-test',
    accountUin: '10001',
    formats: [format],
    incrementalSupport: true,
    selection: { kind: 'c2c', conv: 'peer' },
  });
const entry = (id: number, text = `正文 ${id}`) =>
  makeEntry(
    'message',
    ['10001', String(id)],
    {
      conversation: { kind: 'c2c', id: 'peer' },
      messageId: String(id),
      seq: String(id),
      sender: { identities: [] },
      sentAt: { unixSeconds: '1793800000', precision: 'second' },
      content: [{ type: 'text', text }],
    },
    {
      observationId: `scan:${id}:${text}`,
      observedAt: { unixSeconds: '1793800001', precision: 'second' },
    },
  );
async function fixture(run: (root: string, target: string, incoming: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'weq-compressed-'));
  try {
    await run(root, join(root, `old.${format}`), join(root, `new.${format}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('分块压缩正式 JSONL', () => {
  it('复合扩展名在单文件命名和同名去重时保持完整', () => {
    expect(uniqueName('export.jsonl.gz', new Set(['export.jsonl.gz']))).toBe('export-2.jsonl.gz');
    expect(fileExtension('Renamed.JSONL.GZ')).toBe('.JSONL.GZ');
    expect(uniqueName('Renamed.JSONL.GZ', new Set(['renamed.jsonl.gz']))).toBe(
      'Renamed-2.JSONL.GZ',
    );
    const shape = describeExportOutput(
      { kind: 'messages', name: '压缩归档', format },
      {
        avatar: false,
        transcribe: false,
        ocr: false,
        dress: false,
      },
    );
    expect(shape).toEqual({ kind: 'file', name: '压缩归档', extension: format });
    if (shape.kind === 'file') expect(exportOutputFileName(shape)).toBe('压缩归档.jsonl.gz');
  });
  it('标准 gzip 能解压为正式 JSONL，多个提交独立压缩且不留展开文件', async () =>
    fixture(async (root, target) => {
      await writeArchiveEntries(
        target,
        format,
        header(),
        Array.from({ length: 400 }, (_, i) => entry(i)),
      );
      const bytes = await readFile(target);
      const plain = gunzipSync(bytes).toString('utf8');
      const decoded = decodeArchiveLog(plain);
      expect(decoded.archive.records).toHaveLength(400);
      expect(decoded.archive.formats).toEqual(['jsonl']);
      expect(decoded.archive.incremental.authority).toBe('jsonl');
      expect(bytes.length).toBeLessThan(Buffer.byteLength(plain));
      let blocks = 0;
      for await (const { data } of compressedArchiveBlocks(target)) {
        expect(JSON.parse(data.toString('utf8').trimEnd().split('\n').at(-1)!).type).toBe('commit');
        blocks++;
      }
      expect(blocks).toBeGreaterThan(1);
      expect(await readdir(root)).toEqual([`old.${format}`]);
      expect((await scanArchiveFile(target, format)).state.uncommittedTail).toBe(false);
      await writeArchive(target, format, decoded.archive);
      expect((await readArchiveFile(target, format)).archive).toEqual(decoded.archive);
    }));

  it('增量只追加新块，重复执行无变化，观察和版本保持完整', async () =>
    fixture(async (_root, target, incoming) => {
      await writeArchiveEntries(target, format, header(), [entry(1)]);
      const before = await readFile(target);
      await writeArchiveEntries(incoming, format, header(), [entry(1, '新版'), entry(2)]);
      expect((await updateArchiveFile(target, incoming, format)).entries).toBe(4);
      const after = await readFile(target);
      expect(after.subarray(0, before.length)).toEqual(before);
      expect(decodeArchiveLog(gunzipSync(after).toString('utf8')).archive.records).toHaveLength(3);
      expect((await readArchiveFile(target, format)).archive.records).toHaveLength(3);
      expect((await updateArchiveFile(target, incoming, format)).entries).toBe(0);
      expect(await readFile(target)).toEqual(after);
    }));

  it('截断尾块不生效，续作保留完整前缀；完整块 CRC 损坏不能被当尾部吞掉', async () =>
    fixture(async (_root, target, incoming) => {
      await writeArchiveEntries(target, format, header(), [entry(1)]);
      const before = await readFile(target);
      const partial = await compressArchiveBlock('{"type":"revision"}\n');
      await appendFile(target, partial.subarray(0, partial.length - 4));
      expect((await scanArchiveFile(target, format)).state.uncommittedTail).toBe(true);
      expect((await readArchiveFile(target, format)).uncommittedTail).toBe(true);
      await writeArchiveEntries(incoming, format, header(), [entry(2)]);
      await updateArchiveFile(target, incoming, format);
      expect((await scanArchiveFile(target, format)).state.uncommittedTail).toBe(false);
      const after = await readFile(target);
      expect(after.subarray(0, before.length)).toEqual(before);
      const damaged = Buffer.from(after);
      damaged[before.length - 8] = damaged[before.length - 8]! ^ 1;
      await writeFile(target, damaged);
      await expect(updateArchiveFile(target, incoming, format)).rejects.toThrow();
      expect(await readFile(target)).toEqual(damaged);
      const damagedHeader = Buffer.from(after);
      damagedHeader[16] = damagedHeader[16]! ^ 1;
      await writeFile(target, damagedHeader);
      await expect(scanArchiveFile(target, format)).rejects.toThrow('块头校验');
    }));

  it('无效块、完整提交链和取消信号均被校验', async () =>
    fixture(async (_root, target) => {
      await writeFile(target, Buffer.alloc(22));
      await expect(scanArchiveFile(target, format)).rejects.toThrow('分块压缩');
      await writeArchiveEntries(target, format, header(), [entry(1)]);
      const text = gunzipSync(await readFile(target))
        .toString('utf8')
        .replace('正文 1', '篡改 1');
      await writeFile(target, await compressArchiveBlock(text));
      await expect(scanArchiveFile(target, format)).rejects.toThrow('摘要');
      const controller = new AbortController();
      controller.abort();
      await expect(scanArchiveFile(target, format, controller.signal)).rejects.toThrow();
    }));

  it('文件与目录都能发现并直接预览，正式基线能按压缩格式解析', async () =>
    fixture(async (root, target) => {
      await writeArchiveEntries(target, format, header(), [entry(1), entry(2)]);
      const source = await describeViewerFile(target);
      expect(source.format).toBe(format);
      expect((await readViewerPage(source, { offset: 0 })).messages).toHaveLength(2);
      expect((await readViewerPage(source, { offset: 0, query: '正文 2' })).total).toBe(1);
      expect(
        (await discoverViewerSources(root)).sources.some((value) => value.format === format),
      ).toBe(true);
      expect((await listFormalArchives(root))[0]?.formal.format).toBe(format);
      expect(await resolveArchiveTargets(target, { kind: 'c2c', conv: 'peer' }, [format])).toEqual({
        [format]: await realpath(target),
      });
    }));

  it('预览缓存仅保留定位，后续分页只读取命中块，文件更新后重建', async () =>
    fixture(async (_root, target, incoming) => {
      await writeArchiveEntries(
        target,
        format,
        header(),
        Array.from({ length: 400 }, (_, i) => entry(i)),
      );
      const source = await describeViewerFile(target);
      const spy = vi.spyOn(compression, 'compressedArchiveBlocks');
      try {
        const page = await readViewerPage(source, { offset: 390 });
        expect(page.total).toBe(400);
        expect(page.messages).toHaveLength(10);
        expect(page.messages[0]?.msgId).toBe('390');
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[2]?.start).toBeGreaterThan(0);
      } finally {
        spy.mockRestore();
      }
      await writeArchiveEntries(incoming, format, header(), [entry(400)]);
      await updateArchiveFile(target, incoming, format);
      await expect(readViewerPage(source, { offset: 0 })).rejects.toThrow('已变化');
      const reopened = await describeViewerFile(target);
      expect((await readViewerPage(reopened, { offset: 400 })).messages[0]?.msgId).toBe('400');
    }));

  it.each([false, true])('完整任务支持压缩导出及多格式=%s 的增量续写', async (multiple) =>
    fixture(async (root) => {
      let count = 1;
      const messages = {
        takeSalvageSkips: () => [],
        async *exportC2cMessages() {
          for (let i = 1; i <= count; i++)
            yield {
              msgId: BigInt(i),
              msgSeq: BigInt(i),
              targetUid: 'peer',
              targetUin: 10002n,
              senderUid: 'peer',
              senderUin: 10002n,
              sendTime: 1793800000n,
              elements: [{ type: 'text', data: { textContent: `消息 ${i}` } }],
            };
        },
      } as unknown as MsgService;
      const manager = new ExportTaskManager(messages, join(root, 'cache'), {
        exportAccountUin: '10001',
      });
      const id = await manager.startTask({
        kind: 'c2c',
        conv: 'peer',
        name: '压缩测试',
        format,
        ...(multiple ? { formats: [format, 'jsonl' as const] } : {}),
        includeIntegrityReport: false,
        savePolicy: multiple
          ? { mode: 'before', directory: root }
          : { mode: 'before', filePath: join(root, `export.${format}`) },
      });
      await vi.waitFor(
        () => expect(manager.getTask(id)?.status, manager.getTask(id)?.error).toBe('completed'),
        { timeout: 10000 },
      );
      const path = manager.getTask(id)!.filePath!;
      expect(path.endsWith('.jsonl.gz')).toBe(true);
      expect((await scanArchiveFile(path, format)).messageCount).toBe(1);
      const before = await readFile(path);
      count = 2;
      expect(manager.resumeTask(id, true)).toBe(true);
      await vi.waitFor(
        () => expect(manager.getTask(id)?.status, manager.getTask(id)?.error).toBe('completed'),
        { timeout: 10000 },
      );
      const after = await readFile(path);
      expect(after.subarray(0, before.length)).toEqual(before);
      expect((await scanArchiveFile(path, format)).messageCount).toBe(2);
      if (multiple) {
        const plain = manager.getTask(id)!.publishedOutputs!.jsonl!;
        expect((await readArchiveFile(plain, 'jsonl')).archive.records).toHaveLength(2);
      }
      expect((await readdir(root)).some((name) => name.endsWith('.jsonl'))).toBe(false);
    }),
  );
});
