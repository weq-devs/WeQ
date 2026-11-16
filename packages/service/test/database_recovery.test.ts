import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DatabaseRecoveryGate,
  DatabaseRecoveryStopped,
  type DatabaseRecoveryRequest,
  type DatabaseRecoveryRecord,
} from '../src/account/export/database_recovery';
import { DbToleranceService } from '../src/account/db_tolerance';
import { ExportTaskManager } from '../src/account/export/task_manager';
import { exportReport } from '../src/account/export/export_report';
import type { MsgService, MsgSalvageSource } from '../src/account/msg';

const input = {
  dbPath: '/fixture/nt_msg.db',
  table: 'group_msg_table',
  sqlFingerprint: 'scan',
  ranges: [{ lo: 9007199254740993n, hi: 9007199254740999n, errorKind: 'corrupt', errorCode: 11 }],
};
function fixture(partial = true) {
  const abort = new AbortController();
  let pending: DatabaseRecoveryRequest | undefined;
  const records: DatabaseRecoveryRecord[] = [];
  const changed = vi.fn((request: DatabaseRecoveryRequest | undefined) => {
    pending = request;
  });
  const gate = new DatabaseRecoveryGate(
    abort.signal,
    changed,
    (record) => records.push(record),
    () => partial,
  );
  return { gate, abort, records, changed, pending: () => pending };
}

describe('任务内数据库恢复决策', () => {
  it('确认前不接受不完整结果，键值不丢精度，同区间的并行扫描只询问一次', async () => {
    const f = fixture();
    let accepted = false;
    const first = f.gate.beforeSkip(input).then(() => {
      accepted = true;
    });
    const second = f.gate.beforeSkip(input);
    await vi.waitFor(() => expect(f.pending()?.kind).toBe('ranges'));
    expect(accepted).toBe(false);
    expect(f.records).toEqual([]);
    expect(f.pending()?.ranges?.[0]?.lo).toBe('9007199254740993');
    expect(f.gate.respond('stale', 'skip')).toBe(false);
    expect(f.gate.respond(f.pending()!.id, 'skip')).toBe(true);
    await Promise.all([first, second]);
    expect(f.records).toHaveLength(1);
    expect(f.changed.mock.calls.filter(([request]) => request)).toHaveLength(1);
  });

  it('本次自动跳区间不授权整表，另一个任务仍需询问', async () => {
    const f = fixture();
    const first = f.gate.beforeSkip(input);
    await vi.waitFor(() => expect(f.pending()).toBeDefined());
    f.gate.respond(f.pending()!.id, 'skip', true);
    await first;
    await f.gate.beforeSkip({ ...input, ranges: [{ ...input.ranges[0]!, hi: 9007199254741000n }] });
    const table = f.gate.unreadable(input.dbPath, input.table, new Error('损坏超出预算'));
    await vi.waitFor(() => expect(f.pending()?.kind).toBe('table'));
    expect(f.gate.tableSkipped).toBe(false);
    f.gate.respond(f.pending()!.id, 'skip');
    await table;
    expect(f.gate.tableSkipped).toBe(true);
    const other = fixture();
    const second = other.gate.beforeSkip(input);
    await vi.waitFor(() => expect(other.pending()).toBeDefined());
    other.gate.respond(other.pending()!.id, 'skip');
    await second;
  });

  it.each(['repair', 'stop'] as const)('选择 %s 结束所有等待，不留下跳过记录', async (decision) => {
    const f = fixture();
    const first = f.gate.beforeSkip(input);
    const check = expect(first).rejects.toMatchObject({ repair: decision === 'repair' });
    const queued = f.gate.beforeSkip(input);
    const checkQueued = expect(queued).rejects.toBeInstanceOf(DatabaseRecoveryStopped);
    await vi.waitFor(() => expect(f.pending()).toBeDefined());
    f.gate.respond(f.pending()!.id, decision);
    await Promise.all([check, checkQueued]);
    expect(f.pending()).toBeUndefined();
    expect(f.records).toEqual([]);
  });

  it('没有可保留结果时不提供整表跳过，取消可解除等待', async () => {
    const f = fixture(false);
    const pending = f.gate.unreadable(input.dbPath, input.table, new Error('failed'));
    const check = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.pending()).toBeDefined());
    expect(f.pending()?.canSkip).toBe(false);
    expect(f.gate.respond(f.pending()!.id, 'skip')).toBe(false);
    f.abort.abort();
    await check;
    expect(f.pending()).toBeUndefined();
  });

  it('旧账号的所有级别都改用自动无损读取，不重写历史配置', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weq-auto-tolerance-'));
    try {
      for (const level of [0, 1, 2, 3]) {
        const path = join(root, 'config.json');
        const old = JSON.stringify({ level, grantedAt: '2026-01-01' });
        await writeFile(path, old);
        const service = new DbToleranceService();
        expect(service.binding().level()).toBe(1);
        expect(service.getConfig()).toEqual({ level: 1 });
        expect(await readFile(path, 'utf8')).toBe(old);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('真实任务等待、修复暂停、取消与报告均保留正确状态', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weq-task-recovery-'));
    const msgs = {
      salvage: { binding: { level: () => 1 } },
      withExportFilter(_filter: unknown, signal: AbortSignal, salvage: MsgSalvageSource) {
        return Object.assign(Object.create(this), { exportSignal: signal, salvage });
      },
      countConv: async () => 1,
      takeSalvageSkips: () => [],
      async *exportC2cMessages(this: { salvage: MsgSalvageSource }, peerUid: string) {
        yield {
          msgId: 2n,
          msgSeq: 2n,
          targetUid: 'peer',
          targetUin: 10002n,
          senderUid: 'peer',
          senderUin: 10002n,
          sendTime: 1793799999n,
          elements: [{ type: 'text', data: { textContent: '已经读到的消息' } }],
        };
        if (peerUid === 'healthy') return;
        await this.salvage.binding.beforeSkip!(input);
        yield {
          msgId: 1n,
          msgSeq: 1n,
          targetUid: 'peer',
          targetUin: 10002n,
          senderUid: 'peer',
          senderUin: 10002n,
          sendTime: 1793800000n,
          elements: [{ type: 'text', data: { textContent: '保留的消息' } }],
        };
      },
    } as unknown as MsgService;
    const manager = new ExportTaskManager(msgs, join(root, 'cache'));
    try {
      const start = () =>
        manager.startTask({
          kind: 'c2c',
          conv: 'peer',
          name: '恢复夹具',
          format: 'txt',
          total: 1,
          includeIntegrityReport: false,
          savePolicy: { mode: 'before', directory: root },
        });
      const id = await start();
      await vi.waitFor(() => expect(manager.getTask(id)?.databaseRecovery).toBeDefined());
      expect(manager.getTask(id)?.status).toBe('paused');
      const independent = await manager.startTask({
        kind: 'c2c',
        conv: 'healthy',
        name: '独立健康任务',
        format: 'txt',
        total: 1,
        savePolicy: { mode: 'before', directory: root },
      });
      await vi.waitFor(() => expect(manager.getTask(independent)?.status).toBe('completed'));
      expect(manager.getTask(id)?.databaseRecovery).toBeDefined();
      const restored = new ExportTaskManager(msgs, join(root, 'cache'));
      expect(restored.getTask(id)?.databaseRecovery).toBeUndefined();
      expect(restored.getTask(id)?.status).toBe('paused');
      expect(manager.resumeTask(id)).toBe(false);
      expect(await manager.resolveDatabaseRecovery(id, 'stale', 'skip')).toBe(false);
      expect(
        await manager.resolveDatabaseRecovery(
          id,
          manager.getTask(id)!.databaseRecovery!.id,
          'skip',
        ),
      ).toBe(true);
      await vi.waitFor(() =>
        expect(manager.getTask(id)?.status, manager.getTask(id)?.error).toBe('completed'),
      );
      expect(exportReport(manager.getTask(id)!)).toMatchObject({
        contentStatus: 'partial',
        databaseRecovery: [{ kind: 'ranges' }],
      });
      expect(manager.getTask(id)?.reportPath).toBeTruthy();

      const repair = await start();
      await vi.waitFor(() => expect(manager.getTask(repair)?.databaseRecovery).toBeDefined());
      await manager.resolveDatabaseRecovery(
        repair,
        manager.getTask(repair)!.databaseRecovery!.id,
        'repair',
      );
      expect(manager.getTask(repair)?.status).toBe('paused');
      expect(manager.getTask(repair)?.current).toBeGreaterThanOrEqual(1);
      expect(manager.listTasks().find((task) => task.id === repair)?.canResume).toBe(true);
      expect(manager.getTask(repair)?.databaseRecoveryRecords).toBeUndefined();

      const cancel = await start();
      await vi.waitFor(() => expect(manager.getTask(cancel)?.databaseRecovery).toBeDefined());
      manager.cancelTask(cancel);
      await vi.waitFor(() => expect(manager.getTask(cancel)?.databaseRecovery).toBeUndefined());
      expect(manager.getTask(cancel)?.status).toBe('cancelled');
    } finally {
      for (const task of manager.listTasks())
        if (task.databaseRecovery) manager.cancelTask(task.id);
      await (manager as unknown as { queue: Promise<void> }).queue;
      await rm(root, { recursive: true, force: true });
    }
  });
});
