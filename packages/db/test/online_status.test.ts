import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { MiscDb } from '../src/profile/misc';
import { ProtoMsg } from '@weq/codec';
import { OnlineStatusBody } from '@weq/codec/proto/profile/48902';

// 按实际 wire 形状构造的脱敏黄金样本；20337 不是旧 schema 声称的天气结构。
const CUSTOM_STATUS_HEX =
  'b2f0173582f60931d03e914e92f60909755f6669787475726598f6090aa0f609d00f8af7091308a503120ce6b58be8af95e78ab6e680811801';
let dir: string;
let db: MiscDb;
afterEach(() => {
  db?.close();
  closeAllFixtureDbs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('自定义状态的数值表情字段不会触发 EOF，基础及扩展状态一并读回', async () => {
  dir = mkdtempSync(join(tmpdir(), 'weq-online-status-'));
  const dbPath = join(dir, 'misc.db');
  const sql = fixtureDb(dbPath);
  sql.exec('CREATE TABLE online_status_kv_table ("48901" TEXT PRIMARY KEY, "48902" BLOB)');
  sql
    .prepare('INSERT INTO online_status_kv_table VALUES (?, ?)')
    .run('u_fixture', Buffer.from(CUSTOM_STATUS_HEX, 'hex'));
  db = new MiscDb(createSqliteStub(), { dbPath });
  await expect(db.getUserOnlineStatus('u_fixture')).resolves.toMatchObject({
    uid: 'u_fixture',
    uin: '10001',
    type: 10,
    subType: 2000,
    customStatus: { faceId: 421, text: '测试状态', faceType: 1 },
  });
  await expect(db.getUserOnlineStatus('u_absent')).resolves.toBeNull();
});

it('未核实的扩展负载不套用自定义状态结构，不阻断基础和扩展状态', async () => {
  dir = mkdtempSync(join(tmpdir(), 'weq-online-status-'));
  const dbPath = join(dir, 'misc.db');
  const sql = fixtureDb(dbPath);
  sql.exec('CREATE TABLE online_status_kv_table ("48901" TEXT PRIMARY KEY, "48902" BLOB)');
  const blob = new ProtoMsg(OnlineStatusBody).encode({
    status: {
      detail: { uid: 'u_fixture', type: 10, subType: 1030, extendedPayload: Uint8Array.of(255) },
    },
  });
  sql
    .prepare('INSERT INTO online_status_kv_table VALUES (?, ?)')
    .run('u_fixture', Buffer.from(blob));
  db = new MiscDb(createSqliteStub(), { dbPath });
  const status = await db.getUserOnlineStatus('u_fixture');
  expect(status).toMatchObject({ type: 10, subType: 1030 });
  expect(status?.customStatus).toBeUndefined();
});
