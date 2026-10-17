import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RecentContactDb } from '@weq/db';
import { ProtoMsg, ChatType } from '@weq/codec';
import { RecentContactBody } from '@weq/codec/proto/msg/40051';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

let root = '';
let db: RecentContactDb | undefined;
afterEach(() => {
  db?.close();
  closeAllFixtureDbs();
  if (root) rmSync(root, { recursive: true, force: true });
});

it('读取全部会话时不截在一千条，混排预览保留文字与表情的顺序', async () => {
  root = mkdtempSync(join(tmpdir(), 'weq-recent-preview-'));
  const path = join(root, 'nt_msg.db');
  const sql = fixtureDb(path);
  sql.exec(`CREATE TABLE recent_contact_v3_table (
    "40003" INTEGER, "40010" INTEGER, "40020" TEXT, "40021" TEXT, "40030" INTEGER,
    "40050" INTEGER, "40051" BLOB, "40090" TEXT, "40093" TEXT, "40094" TEXT,
    "40095" TEXT, "41110" TEXT, "41135" TEXT, "41148" TEXT, "41220" INTEGER,
    "60001" INTEGER, "41103" INTEGER, "41104" INTEGER)`);
  const blob = new ProtoMsg(RecentContactBody).encode({
    preview: [
      { elementType: 1, textContent: '你好' },
      { elementType: 6, faceId: 14, displayText: '/微笑' },
      { elementType: 1, textContent: '！' },
    ],
  });
  const insert = sql.prepare(
    `INSERT INTO recent_contact_v3_table ("40010", "40021", "40050", "40051") VALUES (?, ?, ?, ?)`,
  );
  for (let i = 0; i < 1050; i++) insert.run(ChatType.KCHATTYPEC2C, `u_test${i}`, i, blob);
  db = new RecentContactDb(createSqliteStub(), { dbPath: path });
  const all = await db.getRecentContact(-1);
  expect(all).toHaveLength(1050);
  expect(all[0]?.preview?.previewElements).toMatchObject([
    { kind: 'text', textContent: '你好' },
    { kind: 'face', faceId: 14 },
    { kind: 'text', textContent: '！' },
  ]);
});
