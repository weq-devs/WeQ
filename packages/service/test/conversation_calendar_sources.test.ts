import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { createSqliteStub, fixtureDb, closeAllFixtureDbs } from '@weq/testkit';
import { ProtoMsg, encodeElement } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import {
  createCalendarSources,
  type CalendarSourceServices,
} from '../src/account/conversation_calendar_sources';
import type { CalendarKind, CalendarTarget } from '../src/account/conversation_calendar';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('助手日历仅扫描所选独立会话，锚点保留会话身份且不读取 QQ 数据库', async () => {
  const time = Date.parse('2026-11-13T12:00:00+08:00');
  const getConversation = vi.fn(() => [
    { id: 'a-message', role: 'user' as const, text: '合成消息', ts: time },
  ]);
  const nt = createSqliteStub();
  const read = vi.spyOn(nt, 'executeSql');
  const targets: CalendarTarget[] = [
    { kind: 'assistant', conv: 'selected-session', name: '独立助手', avatar: null, ancestors: [] },
  ];
  const sources = createCalendarSources(
    {
      session: {} as AccountSession,
      services: {
        assistant: { getConversation },
        agentLab: {
          listPersonaSessions: () => [],
          listGroupSessions: () => [],
          getConversation: () => [],
          getPersonaSessionConversation: () => [],
          getGroupMessages: () => [],
          getGroupSessionConversation: () => [],
        },
        msgs: { getHiddenDeletedMsgIds: () => [] },
        gapHistory: {
          hasCalendarCache: () => false,
          calendarConversations: async () => [],
          calendarPage: async () => [],
        },
      },
      targets,
      readers: new Map(),
    },
    nt,
    () => {},
  );
  const page = await sources[0]!.page(time / 1000 - 1, time / 1000 + 1, undefined, 256);
  expect(getConversation).toHaveBeenCalledOnce();
  expect(getConversation).toHaveBeenCalledWith('selected-session');
  expect(page.done).toBe(true);
  expect(page.rows).toEqual([
    {
      conv: 'selected-session',
      count: 1,
      time: time / 1000,
      anchor: { id: 'a-message', seq: '', time: time / 1000, sessionId: 'selected-session' },
    },
  ]);
  expect(read).not.toHaveBeenCalled();
});
it('生成对话跨日复用月汇总，空白日不重读历史；刷新后重新读取并保留最早锚点', async () => {
  const start = Date.parse('2026-11-08T00:00:00+08:00') / 1000;
  let messages = Array.from({ length: 1025 }, (_, index) => ({
    id: String(1025 - index),
    role: 'user' as const,
    text: '合成记录',
    ts: start * 1000,
  }));
  const getConversation = vi.fn(() => messages);
  const source = createCalendarSources(
    {
      session: {} as AccountSession,
      services: {
        assistant: { getConversation },
      } as unknown as CalendarSourceServices,
      targets: [{ kind: 'assistant', conv: 'fixture', name: '', avatar: null, ancestors: [] }],
      readers: new Map(),
    },
    createSqliteStub(),
    () => {},
  )[0]!;
  const page = await source.page(start, start + 86400, undefined, 256);
  expect(page.done).toBe(true);
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]).toMatchObject({ count: 1025, anchor: { id: '1' } });
  expect((await source.page(start + 86400, start + 172800, undefined, 256)).rows).toEqual([]);
  expect(getConversation).toHaveBeenCalledOnce();
  messages = [{ ...messages[0]!, id: 'new', ts: (start + 86400) * 1000 }];
  source.invalidate?.();
  expect((await source.page(start, start + 86400, undefined, 256)).rows).toEqual([]);
  expect((await source.page(start + 86400, start + 172800, undefined, 256)).rows[0]).toMatchObject({
    count: 1,
    anchor: { id: 'new' },
  });
  expect(getConversation).toHaveBeenCalledTimes(2);
});

it('生成对话兼容旧检查点 offset，仅汇总尚未处理的记录，非整日范围仍精确过滤', async () => {
  const start = Date.parse('2026-11-08T00:00:00+08:00') / 1000;
  const source = createCalendarSources(
    {
      session: {} as AccountSession,
      services: {
        assistant: {
          getConversation: () =>
            [0, 1, 2].map((offset) => ({
              id: String(offset),
              role: 'user' as const,
              text: '',
              ts: (start + offset) * 1000,
            })),
        },
      } as unknown as CalendarSourceServices,
      targets: [{ kind: 'assistant', conv: 'fixture', name: '', avatar: null, ancestors: [] }],
      readers: new Map(),
    },
    createSqliteStub(),
    () => {},
  )[0]!;
  const remaining = await source.page(start, start + 86400, { bucket: 0, offset: 1 }, 256);
  expect(remaining.rows[0]).toMatchObject({ count: 2, anchor: { id: '1' } });
  const narrow = await source.page(start + 1, start + 2, undefined, 256);
  expect(narrow.rows[0]).toMatchObject({ count: 1, anchor: { id: '1' } });
});

it.each(['persona', 'cloneGroup'] as const)(
  '生成来源 %s 汇总不计隐藏记录，跨日和月末边界不串入',
  async (kind) => {
    const start = Date.parse('2026-11-08T00:00:00+08:00') / 1000;
    const get = vi.fn(() =>
      [
        start - 1,
        start,
        start + 1,
        start + 86400,
        Date.parse('2026-12-01T00:00:00+08:00') / 1000,
      ].map((time, index) => ({
        id: String(index),
        role: 'user' as const,
        text: '',
        ts: time * 1000,
      })),
    );
    const source = createCalendarSources(
      {
        session: {} as AccountSession,
        services: {
          agentLab: {
            listPersonaSessions: () => [],
            listGroupSessions: () => [],
            getConversation: get,
            getGroupMessages: get,
          },
        } as unknown as CalendarSourceServices,
        targets: [
          {
            kind,
            conv: 'fixture',
            name: '',
            avatar: null,
            ancestors: [],
            hiddenIds: { draft: ['1'] },
          },
        ],
        readers: new Map(),
      },
      createSqliteStub(),
      () => {},
    )[0]!;
    expect((await source.page(start, start + 86400, undefined, 256)).rows[0]).toMatchObject({
      count: 1,
      anchor: { id: '2' },
    });
    expect(
      (await source.page(start + 86400, start + 172800, undefined, 256)).rows[0],
    ).toMatchObject({ count: 1, anchor: { id: '3' } });
    expect((await source.page(start + 172800, start + 259200, undefined, 256)).rows).toEqual([]);
    expect(get).toHaveBeenCalledOnce();
  },
);

it('大型生成对话汇总分片让出事件循环，取消后中断且不发布未完成汇总', async () => {
  const start = Date.parse('2026-11-08T00:00:00+08:00') / 1000;
  let cancelled = false;
  let clock = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 5));
  try {
    const source = createCalendarSources(
      {
        session: {} as AccountSession,
        services: {
          assistant: {
            getConversation: () =>
              Array.from({ length: 1025 }, (_, index) => ({
                id: String(index),
                role: 'user' as const,
                text: '',
                ts: start * 1000,
              })),
          },
        } as unknown as CalendarSourceServices,
        targets: [{ kind: 'assistant', conv: 'fixture', name: '', avatar: null, ancestors: [] }],
        readers: new Map(),
      },
      createSqliteStub(),
      () => {
        if (cancelled) throw new DOMException('已取消', 'AbortError');
      },
    )[0]!;
    setTimeout(() => {
      cancelled = true;
    }, 0);
    await expect(source.page(start, start + 86400, undefined, 256)).rejects.toMatchObject({
      name: 'AbortError',
    });
  } finally {
    now.mockRestore();
  }
});

it('缓存日期筛选超预算时沿原游标退回分页，无关日期不触发本地去重，其他错误照常抛出', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-calendar-cache-fallback-'));
  roots.push(root);
  const path = join(root, 'msg.db');
  fixtureDb(path).exec(
    'CREATE TABLE group_msg_table("40001" INTEGER PRIMARY KEY,"40003" INTEGER,"40050" INTEGER,"40027" INTEGER,"40040" INTEGER,"40002" INTEGER,"40020" TEXT); CREATE INDEX time_dir ON group_msg_table("40050","40040")',
  );
  const start = Date.parse('2026-11-08T00:00:00+08:00') / 1000;
  const message = (seq: number, time: number) => ({
    kind: 'group' as const,
    conv: '42',
    msgId: String(seq),
    msgSeq: String(seq),
    sendTime: String(time),
    senderUid: 'sender',
    senderUin: '10000',
    elements: [],
  });
  const calendarPage = vi
    .fn<CalendarSourceServices['gapHistory']['calendarPage']>()
    .mockRejectedValueOnce(new Error('database_query_execution_timeout'))
    .mockResolvedValueOnce([message(1, start - 1)])
    .mockResolvedValueOnce([message(2, start)]);
  const context = {
    session: { msgDbPath: path, context: { dbKey: '', algos: {} } } as AccountSession,
    services: {
      msgs: { getHiddenDeletedMsgIds: () => [] },
      gapHistory: {
        hasCalendarCache: () => true,
        calendarConversations: async () => ['42'],
        calendarPage,
      },
    } as unknown as CalendarSourceServices,
    targets: [{ kind: 'group' as const, conv: '42', name: '', avatar: null, ancestors: [] }],
    readers: new Map(),
  };
  const source = createCalendarSources(context, createSqliteStub(), () => {})[0]!;
  const dedup = vi.spyOn(context.readers.get('group')!, 'localTimeline');
  const native = await source.page(start, start + 86400, undefined, 1);
  const older = await source.page(start, start + 86400, native.cursor, 1);
  expect(older.rows).toEqual([]);
  expect(dedup).not.toHaveBeenCalled();
  expect(calendarPage.mock.calls[0]?.[4]).toEqual({ start, end: start + 86400 });
  expect(calendarPage.mock.calls[1]?.[4]).toBeUndefined();
  const current = await source.page(start, start + 86400, older.cursor, 1);
  expect(current.rows).toHaveLength(1);
  expect(dedup).toHaveBeenCalledOnce();
  expect(calendarPage.mock.calls[2]?.[3]).toMatchObject({ msgSeq: 1 });
  expect(calendarPage.mock.calls[2]?.[4]).toBeUndefined();
  calendarPage.mockRejectedValueOnce(new Error('synthetic corruption'));
  await expect(source.page(start, start + 86400, current.cursor, 1)).rejects.toThrow(
    'synthetic corruption',
  );
});
it('全部八类来源只读取所属会话，卡片源沿用可展示性，克隆保持子会话锚点', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-calendar-sources-'));
  roots.push(root);
  const path = join(root, 'nt_msg.db');
  const nt = createSqliteStub();
  const time = Date.parse('2026-11-08T12:00:00+08:00') / 1000;
  const body = new ProtoMsg(MsgBody).encode({
    elements: [encodeElement({ kind: 'ark', arkData: '{"prompt":"fixture"}' })],
  });
  for (const table of [
    'group_msg_table',
    'c2c_msg_table',
    'dataline_msg_table',
    'service_assistant_msg_table',
    'guild_msg_table',
  ]) {
    const sql = fixtureDb(table === 'guild_msg_table' ? join(root, 'guild_msg.db') : path);
    sql.exec(
      `CREATE TABLE ${table}("40001" INTEGER PRIMARY KEY,"40003" INTEGER,"40002" INTEGER,"40020" TEXT,"40050" INTEGER,"40027" INTEGER,"40021" TEXT,"40035" INTEGER,"40040" INTEGER,"40800" BLOB); CREATE INDEX ${table}_time ON ${table}("40050","40040")`,
    );
    const insert = sql.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?,?,?,?,?)`);
    insert.run(1, 1, 0, 'sender', time, 42, 'u_peer', 5, 0, body);
    if (table === 'c2c_msg_table')
      insert.run(2, 2, 0, 'sender', time, 43, 'u_official', 5, 0, body);
  }
  const kinds: CalendarKind[] = [
    'c2c',
    'group',
    'dataline',
    'official',
    'service',
    'guild',
    'persona',
    'cloneGroup',
  ];
  const convs = ['u_peer', '42', 'u_peer', 'u_official', '5', '42', 'same-clone', 'same-clone'];
  const targets: CalendarTarget[] = kinds.map((kind, index) => ({
    kind,
    conv: convs[index]!,
    name: kind,
    avatar: null,
    ancestors: [],
  }));
  const turn = { id: 'fixture-uuid', text: 'message', ts: time * 1000, role: 'user' as const };
  const services: CalendarSourceServices = {
    msgs: { getHiddenDeletedMsgIds: () => [] },
    gapHistory: {
      hasCalendarCache: () => false,
      calendarConversations: async () => [],
      calendarPage: async () => [],
    },
    agentLab: {
      listPersonaSessions: () => [{ id: 'persona-session', title: '', createdAt: 0, updatedAt: 0 }],
      listGroupSessions: () => [{ id: 'group-session', title: '', createdAt: 0, updatedAt: 0 }],
      getConversation: () => [],
      getGroupMessages: () => [],
      getPersonaSessionConversation: () => [turn],
      getGroupSessionConversation: () => [
        {
          id: turn.id,
          text: turn.text,
          ts: turn.ts,
          senderId: 'self',
          senderKind: 'user' as const,
        },
      ],
    },
  };
  const sources = createCalendarSources(
    {
      session: {
        msgDbPath: path,
        context: { dbKey: '', algos: {} },
        uidMap: { sortNoByUid: () => undefined },
      } as unknown as AccountSession,
      services,
      targets,
      readers: new Map(),
    },
    nt,
    () => {},
  );
  for (const source of sources) {
    let cursor: unknown;
    const rows = [];
    for (let batches = 0; batches < 20; batches++) {
      const page = await source.page(time - 43200, time + 43200, cursor, 1);
      rows.push(
        ...page.rows.filter(
          (row) => row.conv === targets.find((target) => target.kind === source.kind)?.conv,
        ),
      );
      cursor = page.cursor;
      if (page.done) break;
    }
    expect(rows, source.kind).toHaveLength(1);
    if (source.kind === 'persona') expect(rows[0]?.anchor.sessionId).toBe('persona-session');
    if (source.kind === 'cloneGroup') expect(rows[0]?.anchor.sessionId).toBe('group-session');
  }
  const reads = vi.spyOn(nt, 'executeSql');
  const group = sources.find((source) => source.kind === 'group')!;
  await group.page(time - 1, time + 1, undefined, 256);
  expect(reads.mock.calls.every(([, query]) => !query.includes('40800'))).toBe(true);
});
