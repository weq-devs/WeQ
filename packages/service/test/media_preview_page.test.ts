import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { GroupMsgDb, C2cMsgDb } from '@weq/db';
import { ProtoMsg, encodeElement } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { createSqliteStub, fixtureDb, closeAllFixtureDbs } from '@weq/testkit';
import { MsgService } from '../src/account/msg';
import type { GapFetchedMessage } from '../src/account/gap_history';

let root = '';
afterEach(() => {
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture(sameSequence = false) {
  root = mkdtempSync(join(tmpdir(), 'weq-media-page-'));
  const path = join(root, 'nt_msg.db');
  const sql = fixtureDb(path);
  const body = new ProtoMsg(MsgBody).encode({
    elements: [
      encodeElement({
        kind: 'pic',
        fileName: 'fixture.png',
        fileSize: 10,
        md5Bytes: new Uint8Array(16),
        contentHash: new Uint8Array(),
        imgWidth: 10,
        imgHeight: 10,
        imgType: 1000,
        isOriginal: true,
        md5: '0'.repeat(32),
        fileToken: 'fixture-token',
        uploadTime: 0,
        uploadTimestamp: 0,
        fileTTL: 0,
        thumbnailUrl: '',
        previewUrl: '',
        originalUrl: '',
        summary: [],
        cdnHost: '',
      }),
    ],
  });
  for (const table of ['group_msg_table', 'c2c_msg_table']) {
    sql.exec(
      `CREATE TABLE ${table} ("40001" INTEGER,"40002" INTEGER,"40003" INTEGER,"40005" INTEGER,"40011" INTEGER,"40012" INTEGER,"40013" INTEGER,"40020" TEXT,"40021" TEXT,"40027" TEXT,"40030" INTEGER,"40033" INTEGER,"40040" INTEGER,"40050" INTEGER,"40062" BLOB,"40800" BLOB,"40801" BLOB)`,
    );
    const insert = sql.prepare(
      `INSERT INTO ${table} ("40001","40003","40020","40021","40027","40033","40050","40800") VALUES(?,?,?,?,?,?,?,?)`,
    );
    // 同时间但消息 ID 逆序，游标必须使用实际 rowid，不能拿消息 ID 猜行号。
    insert.run(99, 1, 'alice', 'u_peer', '42', 123, 10, body);
    insert.run(10, 2, 'bob', 'u_peer', '42', 456, 10, body);
    if (sameSequence) {
      insert.run(77, 2, 'bob', 'u_peer', '42', 456, 10, body);
      insert.run(20, 2, 'bob', 'u_peer', '42', 456, 10, body);
    }
    for (let id = 100; id < 401; id++) insert.run(id, id, 'alice', 'u_peer', '42', 123, 20, null);
    insert.run(500, 500, 'alice', 'u_peer', '42', 123, 30, body);
    insert.run(501, 501, 'alice', 'u_other', '43', 123, 31, body);
  }
  const nt = createSqliteStub();
  const service = new MsgService({
    groupMsgs: new GroupMsgDb(nt, { dbPath: path }),
    c2cMsgs: new C2cMsgDb(nt, { dbPath: path }),
    uidMap: { sortNoByUid: () => undefined },
    msgDbPath: path,
    profileInfo: { profilesByUids: async () => [] },
  } as unknown as AccountSession);
  return { service, sql };
}
it.each(['group', 'c2c'] as const)(
  '媒体分页 %s 同时间双向完整，稀疏批次前进且不跨会话',
  async (kind) => {
    const { service } = fixture();
    const conv = kind === 'group' ? '42' : 'u_peer';
    const older = await service.mediaPage(kind, conv, {}, 'older', '10');
    expect(older.items.map((row) => String(row.msgId))).toEqual(['99']);
    expect(older.hasMore).toBe(false);
    const sparse = await service.mediaPage(kind, conv, {}, 'newer', '10');
    expect(sparse.items).toHaveLength(0);
    expect(sparse.hasMore).toBe(true);
    const next = await service.mediaPage(kind, conv, {}, 'newer', '10', sparse.cursor);
    expect(next.items.map((row) => String(row.msgId))).toEqual(['500']);
    expect(next.hasMore).toBe(false);
  },
);
it('过滤器沿用消息筛选，游标定位不受筛选条件排除锚点影响', async () => {
  const { service } = fixture();
  const page = await service.mediaPage(
    'group',
    '42',
    { sender: 'bob', keyword: 'fixture' },
    'newer',
    '99',
  );
  expect(page.items.map((row) => String(row.msgId))).toEqual(['10']);
  expect(
    (await service.mediaPage('group', '42', { start: 11, end: 29 }, 'newer', '10')).items,
  ).toHaveLength(0);
});

it.each(['group', 'c2c'] as const)(
  '会话搜索 %s 复用正文时仍核对同一行的更新并纳入新消息',
  async (kind) => {
    const { service, sql } = fixture();
    const conv = kind === 'group' ? '42' : 'u_peer';
    const table = `${kind === 'group' ? 'group' : 'c2c'}_msg_table`;
    const filter = { keyword: 'FIXTURE', recordType: 'media' as const };
    const first = await service.browse(kind, conv, filter, undefined, 2);
    expect(first.items.map(({ msgId }) => msgId)).toEqual([500n, 10n]);
    expect(first.items.every(({ content }) => content === '[图片: fixture.png]')).toBe(true);
    expect(await service.browse(kind, conv, filter, undefined, 2)).toEqual(first);
    const next = await service.browse(kind, conv, filter, first.cursor ?? undefined, 2);
    expect(next.items.map(({ msgId }) => msgId)).toEqual([99n]);

    const changed = { keyword: '更新后的正文' };
    expect((await service.browse(kind, conv, changed)).items).toEqual([]);
    const body = new ProtoMsg(MsgBody).encode({
      elements: [encodeElement({ kind: 'text', textContent: changed.keyword })],
    });
    sql.prepare(`UPDATE ${table} SET "40800"=? WHERE "40001"=500`).run(body);
    sql
      .prepare(`INSERT INTO ${table} ("40001","40020","40021","40027","40050","40800")
    VALUES(502,'alice','u_peer','42',31,?)`)
      .run(body);
    const after = await service.browse(kind, conv, changed);
    expect(after.items.map(({ msgId }) => msgId)).toEqual([502n, 500n]);
    expect((await service.browse(kind, conv, filter)).items.map(({ msgId }) => msgId)).toEqual([
      10n,
      99n,
    ]);
  },
);
it('同序号同时间的消息沿用真实ID排序，双向游标不遗漏媒体', async () => {
  const { service } = fixture(true);
  expect(
    (await service.mediaPage('group', '42', {}, 'older', '77')).items.map((item) => item.msgId),
  ).toEqual(['20', '10', '99']);
  expect(
    (await service.mediaPage('group', '42', {}, 'newer', '10')).items.map((item) => item.msgId),
  ).toEqual(['20', '77']);
});
it('离线漫游缓存补入本地窗口，截断前先合并，缓存独有起点仍可连续浏览', async () => {
  const { service } = fixture();
  const cached: GapFetchedMessage = {
    kind: 'group',
    conv: '42',
    msgId: '90',
    msgSeq: '3',
    sendTime: '11',
    senderUid: 'bob',
    senderUin: '456',
    sourceFormat: 'native',
    elements: [{ type: 'pic', data: { fileToken: 'cached', fileName: 'cached.png' } }],
  };
  const read = vi.fn(async (cursor: { msgSeq: number }, descending: boolean) =>
    (descending ? cursor.msgSeq > 3 : cursor.msgSeq < 3) ? [cached] : [],
  );
  const first = await service.mediaPage(
    'group',
    '42',
    {},
    'newer',
    '10',
    undefined,
    undefined,
    undefined,
    read,
  );
  expect(first.items.map((row) => row.msgId)).toEqual(['90']);
  expect(first.hasMore).toBe(true);
  const next = await service.mediaPage(
    'group',
    '42',
    {},
    'newer',
    '10',
    first.cursor,
    undefined,
    undefined,
    read,
  );
  expect(next.items.map((row) => row.msgId)).toEqual(['500']);
  const fromCache = await service.mediaPage(
    'group',
    '42',
    {},
    'older',
    '90',
    undefined,
    11,
    '3',
    read,
  );
  expect(fromCache.items.map((row) => row.msgId)).toEqual(['10', '99']);
  expect(fromCache.items.every((row) => row.source !== 'roaming')).toBe(true);
});
