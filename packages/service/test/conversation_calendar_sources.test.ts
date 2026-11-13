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
      time: time / 1000,
      anchor: { id: 'a-message', seq: '', time: time / 1000, sessionId: 'selected-session' },
    },
  ]);
  expect(read).not.toHaveBeenCalled();
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
