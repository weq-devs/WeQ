import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { AntiRecallDb, scheduleDatabase, type RecallLogRow } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { AntiRecallService } from '../src/account/anti_recall';
import type { DbChange, DbWatchTask } from '../src/account/db_watch';

const state = vi.hoisted(() => ({ tasks: [] as DbWatchTask[] }));
vi.mock('../src/account/db_watch', () => ({
  DbWatchService: class {
    mount(task: DbWatchTask) {
      state.tasks.push(task);
      return { unmount: vi.fn() };
    }
  },
}));
const roots: string[] = [];
const services: AntiRecallService[] = [];
const change: DbChange = {
  dbPath: '/fixture/msg.db',
  prevTotal: 0,
  total: 1,
  delta: 1,
  files: [],
  at: 1,
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-recall-monitor-'));
  roots.push(root);
  const path = join(root, 'msg.db');
  fixtureDb(path).exec(`CREATE TABLE weq_recall_log (
    msgid INTEGER PRIMARY KEY, conv TEXT, table_kind TEXT, sender_uid TEXT, revoke_uid TEXT,
    orig_seq INTEGER, recall_ts INTEGER);`);
  const config = join(root, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      enabled: true,
      mode: 'all',
      targets: [],
      notifyEnabled: true,
      notifyTargets: ['group:123456'],
    }),
  );
  const nt = createSqliteStub();
  const close = vi.spyOn(nt, 'closeDb');
  const notify = vi.fn();
  const service = new AntiRecallService(
    {
      msgDbPath: path,
      context: { dbKey: '', algos: {}, uin: '10001' },
    } as unknown as AccountSession,
    {
      native: { ntHelper: nt },
      isQqLoggedIn: () => false,
    } as unknown as Platform,
    config,
    { onRecall: notify },
  );
  services.push(service);
  return { service, nt, path, close, notify };
}
function rows(count: number, start = 1): RecallLogRow[] {
  return Array.from({ length: count }, (_, index) => ({
    msgid: String(start + index),
    kind: 'group',
    conv: '123456',
    senderUid: 'u_sender',
    revokeUid: 'u_revoker',
    origSeq: String(index + 1),
    recallTs: 1,
  }));
}
const poll = () => state.tasks.at(-1)!.onDbFileChangeHook(change);
afterEach(() => {
  for (const service of services.splice(0)) service.stopMonitor();
  vi.restoreAllMocks();
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  state.tasks.length = 0;
});

it('撤回监听只读查询复用账号连接，历史不通知且大整数游标不会重复交付', async () => {
  const f = fixture();
  const old = 9007199254740993n;
  fixtureDb(f.path).exec(`INSERT INTO weq_recall_log VALUES
    (${old},'123456','group','u_sender','u_revoker',1,1)`);
  f.service.startMonitor();
  await turn();
  await poll();
  expect(f.notify).not.toHaveBeenCalled();
  fixtureDb(f.path).exec(`INSERT INTO weq_recall_log VALUES
    (${old + 1n},'123456','group','u_sender','u_revoker',2,2)`);
  await poll();
  await poll();
  expect(f.notify).toHaveBeenCalledOnce();
  expect(f.notify.mock.calls[0]![0]).toMatchObject({ kind: 'group', origSeq: '2' });
  expect(f.close).not.toHaveBeenCalled();
});

it('停止后迟到整页不通知、不补后页，也不关闭新读者共用的连接', async () => {
  const f = fixture();
  vi.spyOn(AntiRecallDb.prototype, 'latestRecallCursor').mockResolvedValue(0n);
  const waiting = deferred<RecallLogRow[]>();
  const page = vi
    .spyOn(AntiRecallDb.prototype, 'listRecallsAfter')
    .mockReturnValueOnce(waiting.promise);
  f.service.startMonitor();
  await turn();
  f.close.mockClear();
  const pending = poll();
  f.service.stopMonitor();
  waiting.resolve(rows(200));
  await pending;
  expect(f.notify.mock.calls.length).toBe(0);
  expect(page).toHaveBeenCalledOnce();
  expect(f.close).not.toHaveBeenCalled();
});

it('重启后旧基线迟到返回不能覆盖新游标', async () => {
  const f = fixture();
  const old = deferred<bigint>();
  vi.spyOn(AntiRecallDb.prototype, 'latestRecallCursor')
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue(2000n);
  const page = vi.spyOn(AntiRecallDb.prototype, 'listRecallsAfter').mockResolvedValue([]);
  f.service.startMonitor();
  f.service.stopMonitor();
  f.service.startMonitor();
  await turn();
  old.resolve(1n);
  await turn();
  await poll();
  expect(page).toHaveBeenLastCalledWith(2000n, 200);
});

it('重新启用时换代基线，旧分页不能发通知或覆盖新水位', async () => {
  const f = fixture();
  vi.spyOn(f.service, 'applyTriggers').mockResolvedValue();
  vi.spyOn(AntiRecallDb.prototype, 'latestRecallCursor')
    .mockResolvedValueOnce(0n)
    .mockResolvedValue(2000n);
  const waiting = deferred<RecallLogRow[]>();
  const page = vi
    .spyOn(AntiRecallDb.prototype, 'listRecallsAfter')
    .mockReturnValueOnce(waiting.promise)
    .mockResolvedValue([]);
  f.service.startMonitor();
  await turn();
  const pending = poll();
  await f.service.setEnabled(true);
  await turn();
  waiting.resolve(rows(200, 1000));
  await pending;
  await poll();
  expect(f.notify.mock.calls.length).toBe(0);
  expect(page).toHaveBeenLastCalledWith(2000n, 200);
});

it('基线未完成时的文件变化等待同一基线，不再重复发查询', async () => {
  const f = fixture();
  const gate = deferred<bigint>();
  const baseline = vi
    .spyOn(AntiRecallDb.prototype, 'latestRecallCursor')
    .mockReturnValue(gate.promise);
  vi.spyOn(AntiRecallDb.prototype, 'listRecallsAfter').mockResolvedValue([]);
  f.service.startMonitor();
  const pending = poll();
  expect(baseline).toHaveBeenCalledOnce();
  gate.resolve(1000n);
  await pending;
  expect(baseline).toHaveBeenCalledOnce();
});

it('基线还排队时停止监听，会撤销尚未执行的原生查询', async () => {
  const f = fixture();
  const gate = deferred<[]>();
  const blocking = scheduleDatabase(f.path, () => gate.promise, f.nt);
  const execute = vi.spyOn(f.nt, 'executeSql');
  f.service.startMonitor();
  f.service.stopMonitor();
  gate.resolve([]);
  await blocking;
  await turn();
  await turn();
  expect(execute).not.toHaveBeenCalled();
});

it('当前监听正常补齐整页后续记录，游标推进后不重复通知', async () => {
  const f = fixture();
  vi.spyOn(AntiRecallDb.prototype, 'latestRecallCursor').mockResolvedValue(0n);
  const page = vi
    .spyOn(AntiRecallDb.prototype, 'listRecallsAfter')
    .mockResolvedValueOnce(rows(200, 1000))
    .mockResolvedValueOnce(rows(1, 1200))
    .mockResolvedValue([]);
  f.service.startMonitor();
  await turn();
  await poll();
  expect(f.notify).toHaveBeenCalledTimes(201);
  expect(page.mock.calls.map(([cursor]) => cursor)).toEqual([0n, 1199n]);
  await poll();
  expect(page).toHaveBeenLastCalledWith(1200n, 200);
  expect(f.notify).toHaveBeenCalledTimes(201);
});

it('监听未启动时更新配置不额外读取通知基线，启动后才建立', async () => {
  const f = fixture();
  vi.spyOn(f.service, 'applyTriggers').mockResolvedValue();
  const baseline = vi.spyOn(AntiRecallDb.prototype, 'latestRecallCursor').mockResolvedValue(0n);
  const status = await f.service.setEnabled(true);
  expect(status.enabled).toBe(true);
  expect(baseline).not.toHaveBeenCalled();
  f.service.startMonitor();
  await turn();
  expect(baseline).toHaveBeenCalledOnce();
});

it('撤回状态、列表和目录只借用账号连接，仍保留数据线合并与空会话过滤', async () => {
  const f = fixture();
  fixtureDb(f.path).exec(`INSERT INTO weq_recall_log VALUES
    (1,'u_peer','c2c','u_sender','u_revoker',1,10),
    (2,'u_peer','dataline','u_sender','u_revoker',2,20),
    (3,'123456','group','u_sender','u_revoker',3,30),
    (4,'','group','u_sender','u_revoker',4,40)`);
  expect((await f.service.getStatus()).installed).toEqual([]);
  expect((await f.service.listRecalls('c2c', 'u_peer')).map((row) => row.msgid)).toEqual([
    '2',
    '1',
  ]);
  expect((await f.service.listRecalls('group', '123456')).map((row) => row.msgid)).toEqual(['3']);
  expect((await f.service.listRecallConversations()).map((row) => row.conv)).toEqual([
    '123456',
    'u_peer',
    'u_peer',
  ]);
  expect([...(await f.service.getRecallMap('c2c', 'u_peer', [1n, 2n])).keys()].sort()).toEqual([
    '1',
    '2',
  ]);
  expect(f.close).not.toHaveBeenCalled();
});

it('触发器写入路径仍关闭连接释放锁，不受只读连接复用影响', async () => {
  const f = fixture();
  const reconcile = vi.spyOn(AntiRecallDb.prototype, 'reconcile').mockResolvedValue();
  await f.service.applyTriggers();
  expect(reconcile).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledOnce();
});
