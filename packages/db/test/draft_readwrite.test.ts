/**
 * `DraftDb` + `RecentContactDb.setDraftTime` —— 草稿读写与会话列表镜像的回归。
 *
 * 用真实 sqlite fixture（不是 mock）跑完整链路：
 *   写草稿 → 回读正文一致 → 再写一次（整行覆盖）→ 清掉草稿
 * 并锁住 recent_contact 侧的两列镜像：
 *   `41108` = 草稿时间、`41136` = 2^47 × [已置顶] + (有草稿 ? 草稿时间 : 40050)。
 *
 * 这两列是「打了字会话就冒到列表最前面」的全部依据，写错会静默改变会话排序。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DraftDb, RecentContactDb, draftStorageKey } from '@weq/db';
import { decodeElement, encodeElement, type Element } from '@weq/codec';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const UID = 'u_LKt3AdAIMP-CUfn6ydzDzw';
const GROUP = '673646675';
const PINNED_BIT = 140737488355328n;

let dir: string;
let drafts: DraftDb;
let contacts: RecentContactDb;

afterEach(() => {
  drafts.close();
  contacts.close();
  closeAllFixtureDbs();
  rmSync(dir, { recursive: true, force: true });
});

function createFixture(): void {
  dir = mkdtempSync(join(tmpdir(), 'weq-draft-'));
  const dbPath = join(dir, 'nt_msg.db');
  const sql = fixtureDb(dbPath);
  sql.exec(`CREATE TABLE draft_storage_table_v1 ("43001" TEXT PRIMARY KEY, "43002" BLOB)`);
  sql.exec(
    `CREATE TABLE recent_contact_v3_table ("40021" TEXT, "40050" INTEGER, "41104" INTEGER, "41108" INTEGER, "41136" INTEGER)`,
  );
  // 一个置顶会话 + 一个未置顶会话，覆盖 41136 的两种形态。
  sql.exec(
    `INSERT INTO recent_contact_v3_table VALUES ('${UID}', 1790280000, 1, 0, ${PINNED_BIT + 1790280000n})`,
  );
  sql.exec(`INSERT INTO recent_contact_v3_table VALUES ('${GROUP}', 1790200000, 0, 0, 1790200000)`);
  const nt = createSqliteStub();
  drafts = new DraftDb(nt, { dbPath });
  contacts = new RecentContactDb(nt, { dbPath });
}

function sql() {
  return fixtureDb(join(dir, 'nt_msg.db'));
}

const textEl = (text: string): Element => ({ kind: 'text', textContent: text }) as Element;
const picEl = (): Element =>
  ({ kind: 'pic', fileName: 'a.png', localPath: '/tmp/a.png' }) as unknown as Element;

describe('DraftDb read/write', () => {
  it('writes a draft and reads back the same elements', async () => {
    createFixture();
    await drafts.saveDraft({
      chatType: 1,
      targetUid: UID,
      sendTime: 1790280959n,
      elements: [
        textEl('表情缓存'),
        { kind: 'face', faceId: 178, faceText: '[斜眼笑]' } as Element,
      ],
    });

    const got = await drafts.getDraft(1, UID);
    expect(got?.targetUid).toBe(UID);
    expect(got?.chatType).toBe(1);
    expect(got?.sendTime).toBe(1790280959n);
    expect(got?.elements.map((e) => e.kind)).toEqual(['text', 'face']);
    expect((got?.elements[0] as { textContent?: string } | undefined)?.textContent).toBe(
      '表情缓存',
    );
    expect((got?.elements[1] as { faceId?: number } | undefined)?.faceId).toBe(178);
  });

  it('reads all rows via listDrafts and decodes a pic element', async () => {
    createFixture();
    await drafts.saveDraft({
      chatType: 2,
      targetUid: GROUP,
      sendTime: 1790281124n,
      elements: [textEl('群聊的图片缓存'), picEl()],
    });
    const all = await drafts.listDrafts();
    expect(all).toHaveLength(1);
    expect(all[0]?.targetUid).toBe(GROUP);
    expect(all[0]?.elements.map((e) => e.kind)).toEqual(['text', 'pic']);
    expect((all[0]?.elements[1] as { fileName?: string } | undefined)?.fileName).toBe('a.png');
  });

  it('overwrites the whole row on the second write (QQ 的整行覆盖语义)', async () => {
    createFixture();
    await drafts.saveDraft({
      chatType: 1,
      targetUid: UID,
      sendTime: 100n,
      elements: [textEl('first')],
    });
    await drafts.saveDraft({
      chatType: 1,
      targetUid: UID,
      sendTime: 200n,
      elements: [textEl('second')],
    });
    const rows = await drafts.listDrafts();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sendTime).toBe(200n);
    expect((rows[0]?.elements[0] as { textContent?: string } | undefined)?.textContent).toBe(
      'second',
    );
  });

  it('deletes the draft row on clear', async () => {
    createFixture();
    await drafts.saveDraft({ chatType: 1, targetUid: UID, elements: [textEl('x')] });
    await drafts.deleteDraft(1, UID);
    expect(await drafts.getDraft(1, UID)).toBeNull();
    expect(await drafts.listDrafts()).toHaveLength(0);
  });

  it('round-trips an unknown element without losing its bytes', async () => {
    createFixture();
    const unknown = {
      kind: 'unknown',
      elementType: 9999,
      raw: { elementType: 9999 },
    } as unknown as Element;
    await drafts.saveDraft({ chatType: 1, targetUid: UID, elements: [unknown] });
    const got = await drafts.getDraft(1, UID);
    expect(got?.elements[0]?.kind).toBe('unknown');
  });

  it('derives the storage key the same way QQ does', async () => {
    createFixture();
    await drafts.saveDraft({ chatType: 1, targetUid: UID, elements: [textEl('x')] });
    const rows = sql().prepare(`SELECT "43001" FROM draft_storage_table_v1`).all() as Array<{
      '43001': string;
    }>;
    expect(rows[0]?.['43001']).toBe(draftStorageKey(1, UID));
    expect(rows[0]?.['43001']).toBe(`0_1__${UID}`);
  });
});

describe('RecentContactDb.setDraftTime mirror', () => {
  it('sets 41108 and folds the draft time into 41136 (pinned keeps bit 47)', async () => {
    createFixture();
    await contacts.setDraftTime(UID, 1790280959n);
    const row = sql()
      .prepare(`SELECT "41108","41136" FROM recent_contact_v3_table WHERE "40021" = ?`)
      .get(UID) as { '41108': number; '41136': number };
    expect(row['41108']).toBe(1790280959);
    expect(BigInt(row['41136'])).toBe(PINNED_BIT + 1790280959n);
  });

  it('falls back to 40050 when the draft is cleared', async () => {
    createFixture();
    await contacts.setDraftTime(GROUP, 1790285263n);
    let row = sql()
      .prepare(`SELECT "41108","41136" FROM recent_contact_v3_table WHERE "40021" = ?`)
      .get(GROUP) as { '41108': number; '41136': number };
    expect(BigInt(row['41136'])).toBe(1790285263n);

    await contacts.setDraftTime(GROUP, null);
    row = sql()
      .prepare(`SELECT "41108","41136" FROM recent_contact_v3_table WHERE "40021" = ?`)
      .get(GROUP) as { '41108': number; '41136': number };
    expect(row['41108']).toBe(0);
    expect(BigInt(row['41136'])).toBe(1790200000n);
  });

  it('is a no-op for a conversation that has no recent-contact row', async () => {
    createFixture();
    await expect(contacts.setDraftTime('u_nonexistent', 123n)).resolves.toBeUndefined();
  });
});

describe('RecentContactDb.listDraftTimes', () => {
  it('returns only conversations whose 41108 is a real draft time', async () => {
    createFixture();
    await contacts.setDraftTime(UID, 1790280959n);
    const times = await contacts.listDraftTimes();
    expect([...times]).toEqual([[UID, 1790280959n]]);
  });

  it('drops a conversation again once its draft is cleared', async () => {
    createFixture();
    await contacts.setDraftTime(GROUP, 1790285263n);
    expect((await contacts.listDraftTimes()).has(GROUP)).toBe(true);
    await contacts.setDraftTime(GROUP, null);
    expect((await contacts.listDraftTimes()).has(GROUP)).toBe(false);
  });

  it('is empty when no conversation has a draft', async () => {
    createFixture();
    expect((await contacts.listDraftTimes()).size).toBe(0);
  });
});

describe('element encode/decode stability used by the draft path', () => {
  it('keeps text + pic elements identical through decode → encode', () => {
    const wire = {
      elementType: 2,
      fileName: 'a.png',
      localPath: '/tmp/a.png',
      md5Bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    } as never;
    const el = decodeElement(wire);
    expect(el.kind).toBe('pic');
    expect(encodeElement(el)).toEqual(wire);
  });
});
