// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, expect, it, vi } from 'vitest';
import { MsgService, type RenderC2cMsg } from '../src/account/msg';
import type { AccountSession } from '@weq/account';
import { ExportTaskManager, type ExportTask } from '../src/account/export/task_manager';
import type { ExportResult } from '../src/account/export/types';
import { readArchiveFile, object } from '../src/account/export/archive';
import {
  iterateOfficialMessages,
  iterateServiceMessages,
} from '../src/account/export/message_source';
import { mediaDirsFromNtDataDir, scanConvMedia } from '../src/account/export/media_scan';
import { resolveC2cSenders } from '../src/account/export/sender_resolve';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(kind: 'official' | 'service') {
  const root = mkdtempSync(join(tmpdir(), 'weq-feed-export-'));
  roots.push(root);
  const conv = kind === 'official' ? 'u_synthetic_official' : '1234567';
  const rows: RenderC2cMsg[] = [1, 2, 3].map((id) => ({
    msgId: BigInt(id),
    msgSeq: id === 2 ? 0n : BigInt(id),
    targetUid: conv,
    targetUin: 10002n,
    senderUid: kind === 'service' ? 'u_service_actual_sender' : conv,
    senderUin: 10002n,
    sendTime: BigInt(1000 + id),
    elements:
      id === 1
        ? [{ type: 'text', data: { textContent: '合成普通文本消息' } }]
        : [
            {
              type: 'ark',
              data: {
                arkData: JSON.stringify({ app: 'com.tencent.test', prompt: `合成订阅 ${id}` }),
              },
            },
          ],
  }));
  const getC2cAfter = vi.fn(async (_uid: string, after: bigint) => {
    if (kind === 'service') throw new Error('服务号不能读取普通私聊表');
    return rows.filter((row) => row.msgSeq > after);
  });
  const getC2cSeqlessAfterRowId = vi.fn(async () => {
    if (kind === 'service') throw new Error('服务号不能读取普通私聊表');
    return rows.filter((row) => row.msgSeq === 0n).map((row) => ({ ...row, rowId: row.msgId }));
  });
  const getServiceAfter = vi.fn(async (_appId: string, after: bigint) => {
    if (kind === 'official') throw new Error('公众号不能读取服务号表');
    return rows.filter((row) => row.msgSeq > after);
  });
  const getServiceSeqlessAfterRowId = vi.fn(async () => {
    if (kind === 'official') throw new Error('公众号不能读取服务号表');
    return rows.filter((row) => row.msgSeq === 0n).map((row) => ({ ...row, rowId: row.msgId }));
  });
  const exportSourceStamp = vi.fn((sourceKind: string, id: string) => `${sourceKind}:${id}`);
  const source = {
    getC2cAfter,
    getC2cSeqlessAfterRowId,
    getServiceAfter,
    getServiceSeqlessAfterRowId,
    exportSourceStamp,
    takeSalvageSkips: () => [],
  } as unknown as MsgService;
  return { root, conv, rows, source, getC2cAfter, getServiceAfter, exportSourceStamp };
}

it.each(['official', 'service'] as const)(
  '%s 完整任务各格式使用真实消息源、保留来源元数据且不拉普通漫游',
  async (kind) => {
    const f = fixture(kind);
    const backfill = vi.fn(async () => []);
    const fetchBackfill = vi.fn(async () => {
      throw new Error('订阅消息不支持漫游补全');
    });
    const manager = new ExportTaskManager(f.source, join(f.root, 'cache'), {
      messageBackfill: { cached: backfill, fetch: fetchBackfill },
    });
    const id = await manager.startTask({
      kind,
      conv: f.conv,
      name: '合成订阅',
      format: 'json',
      formats: ['json', 'jsonl', 'jsonl.gz', 'txt', 'csv', 'xlsx', 'html'],
      total: 0,
      media: {
        exportMedia: false,
        completeMessages: true,
        completeMedia: false,
        downloadVideo: false,
        downloadFile: false,
        downloadPtt: false,
        transcribeVoice: false,
      },
      includeIntegrityReport: true,
      savePolicy: { mode: 'before', directory: f.root },
    });
    await vi.waitFor(
      () => expect(manager.getTask(id)?.status, manager.getTask(id)?.error).toBe('completed'),
      { timeout: 5000 },
    );
    const task = manager.getTask(id)!;
    expect(task.kind).toBe(kind);
    expect(task.current).toBe(3);
    expect(task.total).toBe(3);
    expect(Object.values(task.formatCounts!)).toEqual([3, 3, 3, 3, 3, 3, 3]);
    expect(task.stages.some((stage) => stage.key === 'backfill')).toBe(false);
    expect(backfill).not.toHaveBeenCalled();
    expect(fetchBackfill).not.toHaveBeenCalled();
    const directory = dirname(task.filePath!);
    const baseName = parse(task.filePath!).name;
    for (const format of ['json', 'jsonl', 'jsonl.gz'] as const) {
      const path = join(directory, `${baseName}.${format}`);
      const { archive } = await readArchiveFile(path, format);
      expect(archive.records).toHaveLength(3);
      expect(JSON.stringify(archive.records)).toContain('合成普通文本消息');
      expect(
        archive.records.every((record) => object(record.data.conversation).kind === kind),
      ).toBe(true);
      expect(
        archive.records.every((record) => object(record.data.conversation).id === f.conv),
      ).toBe(true);
    }
    const html = readFileSync(join(directory, 'index.html'), 'utf8');
    expect(html).toContain(`${kind === 'official' ? '公众号' : '服务号'} · 导出于`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(join(directory, `${baseName}.xlsx`));
    expect(workbook.worksheets[0]?.rowCount).toBe(4);
    expect(
      f.exportSourceStamp.mock.calls.every(
        ([sourceKind, conv]) => sourceKind === kind && conv === f.conv,
      ),
    ).toBe(true);
    if (kind === 'service') {
      expect(f.getC2cAfter).not.toHaveBeenCalled();
      expect(f.getServiceAfter).toHaveBeenCalledWith(f.conv, 0n, 2000);
    } else {
      expect(f.getServiceAfter).not.toHaveBeenCalled();
      expect(f.getC2cAfter).toHaveBeenCalledWith(f.conv, 0n, 2000);
    }
  },
);

it.each(['official', 'service'] as const)(
  '%s 旧任务 CSV 和 Excel 分支也不落入普通私聊读取',
  async (kind) => {
    const f = fixture(kind);
    const manager = new ExportTaskManager(f.source, join(f.root, 'cache'));
    const task: ExportTask = {
      id: 'legacy-feed',
      kind,
      conv: f.conv,
      name: '旧订阅任务',
      format: 'csv',
      status: 'running',
      progress: 0,
      current: 0,
      total: 2,
      stages: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const legacy = manager as unknown as {
      exportMessagesOne(
        task: ExportTask,
        format: 'csv' | 'xlsx',
        output: string,
        senders: undefined,
        media: boolean,
        progress: () => void,
      ): Promise<ExportResult>;
    };
    for (const format of ['csv', 'xlsx'] as const) {
      const path = join(f.root, `legacy.${format}`);
      const result = await legacy.exportMessagesOne(task, format, path, undefined, false, () => {});
      expect(result.messageCount).toBe(3);
      if (format === 'xlsx') {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(path);
        expect(workbook.worksheets[0]?.rowCount).toBe(4);
      }
    }
    if (kind === 'service') expect(f.getC2cAfter).not.toHaveBeenCalled();
    else expect(f.getServiceAfter).not.toHaveBeenCalled();
  },
);

it.each(['official', 'service'] as const)(
  '%s 精确选区、时间窗和空集合都沿正式消息流生效',
  async (kind) => {
    const f = fixture(kind);
    f.source.exportFilter = { messageIds: ['2', '3'] };
    const read = async () => {
      const rows = [];
      const iterate = kind === 'official' ? iterateOfficialMessages : iterateServiceMessages;
      for await (const row of iterate(f.source, f.conv, { range: { start: 1002, end: 1002 } }))
        rows.push(row.msgId);
      return rows;
    };
    expect(await read()).toEqual([2n]);
    f.source.exportFilter = { messageIds: [] };
    f.getC2cAfter.mockClear();
    f.getServiceAfter.mockClear();
    expect(await read()).toEqual([]);
    expect(f.getC2cAfter).not.toHaveBeenCalled();
    expect(f.getServiceAfter).not.toHaveBeenCalled();
  },
);

it('服务号媒体扫描不借用私聊源，普通消息和 Ark 中的图片都保留', async () => {
  const f = fixture('service');
  f.rows[1]!.elements.push({ type: 'pic', data: { fileName: 'aabbcc.png', md5HexStr: 'aabbcc' } });
  f.rows[0]!.elements.push({ type: 'pic', data: { fileName: 'ddeeff.png', md5HexStr: 'ddeeff' } });
  const result = await scanConvMedia(
    f.source,
    'service',
    f.conv,
    mediaDirsFromNtDataDir(join(f.root, 'media')),
  );
  expect(result.totalRefs).toBe(2);
  expect(f.getC2cAfter).not.toHaveBeenCalled();
  expect(f.getServiceAfter).toHaveBeenCalled();
});

it('服务号 appId 仅作会话键，成员资料按消息真实 UID / QQ 号解析', async () => {
  const f = fixture('service');
  const profile = vi.fn(async () => ({ uin: '10002', nick: '服务发布者' }));
  const result = await resolveC2cSenders(
    f.conv,
    { resolveProfile: profile },
    { msgs: f.source, kind: 'service' },
  );
  expect(result.senders.has(f.conv)).toBe(false);
  expect(result.senders.get('u_service_actual_sender')).toMatchObject({
    platformId: '10002',
    sourceName: '服务发布者',
  });
  expect(profile).toHaveBeenCalledWith('u_service_actual_sender');
  expect(profile).not.toHaveBeenCalledWith(f.conv);
});

it('真实 MsgService 的服务号续作绑定只跟踪服务号表，不把 appId 用来选私聊库', () => {
  const f = fixture('service');
  const source = join(f.root, 'service-source');
  const unrelated = join(f.root, 'private-source');
  writeFileSync(source, 'service');
  writeFileSync(unrelated, 'private');
  const privateLookup = vi.fn(() => {
    throw new Error('服务号不能借用私聊源绑定');
  });
  const session = {
    serviceAssistantMsgs: { sourcePath: source },
    get c2cMsgs() {
      return privateLookup();
    },
  } as unknown as AccountSession;
  const messages = new MsgService(session);
  const before = messages.exportSourceStamp('service', f.conv);
  writeFileSync(unrelated, 'unrelated-change');
  expect(messages.exportSourceStamp('service', f.conv)).toBe(before);
  writeFileSync(source, 'changed-service-source');
  expect(messages.exportSourceStamp('service', f.conv)).not.toBe(before);
  expect(privateLookup).not.toHaveBeenCalled();
});
