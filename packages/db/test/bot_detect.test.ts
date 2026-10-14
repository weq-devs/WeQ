/**
 * Bot detection — the offline twin of the old `tools/verify_bot_detect.ts`.
 *
 * `ProfileInfoDb.botUids()` prefilters with `instr("21000", x'E29A0E')` — the
 * literal wire key of tag 29100 (botMark) — then confirms by actually decoding
 * the 21000 ext blob. This fixture encodes real `ProfileExtBody` blobs via
 * @weq/codec, so both stages of that pipeline are exercised:
 *
 *  - a row whose 21000 carries `{miscFlags:{botMark:{botType}}}` → detected;
 *  - a row with a normal ext (no botMark) → not detected;
 *  - a row whose 21000 is garbage bytes → not detected (decode bails).
 *
 * It also pins the uin-range fallback (`BOT_UIN_RANGES`): a real bot whose
 * 21000 was never backfilled still gets detected from its QQ number alone.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProtoMsg } from '@weq/codec';
import { ProfileExtBody } from '@weq/codec/proto/profile/21000';
import { ProfileInfoDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const extCodec = new ProtoMsg(ProfileExtBody);

let dir: string;
let dbPath: string;
let db: ProfileInfoDb;

afterEach(() => {
  db.close();
  closeAllFixtureDbs();
  rmSync(dir, { recursive: true, force: true });
});

function extBlob(value: Record<string, unknown>): Uint8Array {
  const encoded = extCodec.encode(value);
  return encoded instanceof Uint8Array ? encoded : new TextEncoder().encode(encoded as string);
}

function createFixture(): void {
  dir = mkdtempSync(join(tmpdir(), 'weq-bot-'));
  dbPath = join(dir, 'profile_info.db');
  const sql = fixtureDb(dbPath);
  // Full column set read by `SELECT_COLUMNS` (so `getProfileByUin` works too);
  // only uid / uin / 21000 are populated — the rest stay NULL.
  sql.exec(
    `CREATE TABLE profile_info_v6 ("1000" TEXT, "1001" TEXT, "1002" INTEGER, "20002" TEXT,
      "20004" TEXT, "20006" INTEGER, "20007" INTEGER, "20008" INTEGER, "20009" TEXT,
      "20011" TEXT, "20014" INTEGER, "20057" BLOB, "20070" INTEGER, "20072" BLOB,
      "24103" INTEGER, "24104" INTEGER, "21000" BLOB)`,
  );
  const ins = sql.prepare(`INSERT INTO profile_info_v6 ("1000","1002","21000") VALUES (?,?,?)`);
  ins.run('u_bot_ai', 66600000n, extBlob({ ext: { miscFlags: { botMark: { botType: 2 } } } }));
  ins.run('u_bot_third', 4010057831n, extBlob({ ext: { miscFlags: { botMark: { botType: 1 } } } }));
  // 号段内但 21000 从没回写过 —— 只能靠 uin 兜底认出来。
  ins.run('u_bot_range_only', 3889001776n, null);
  ins.run('u_human', 1707889225n, extBlob({ ext: { nick: '路人' } }));
  ins.run('u_garbage', 123456789n, new Uint8Array([0x00, 0xff, 0x00, 0xfe]));

  db = new ProfileInfoDb(createSqliteStub(), { dbPath });
}

describe('ProfileInfoDb.botUids (offline fixture)', () => {
  it('detects botMark rows + uin-range rows, skips humans / garbage', async () => {
    createFixture();

    const bots = await db.botUids();
    expect(bots.has('u_bot_ai')).toBe(true);
    expect(bots.has('u_bot_third')).toBe(true);
    expect(bots.has('u_bot_range_only')).toBe(true);
    expect(bots.has('u_human')).toBe(false);
    expect(bots.has('u_garbage')).toBe(false);
    expect(bots.size).toBe(3);
  });

  it('marks isBot from the uin range when botMark is absent', async () => {
    createFixture();

    const rangeBot = await db.getProfileByUin(3889001776n);
    expect(rangeBot?.isBot).toBe(true);
    // 21000 为空，extInfo 也不存在 —— isBot 只能来自号段。
    expect(rangeBot?.extInfo?.botType).toBeUndefined();

    const human = await db.getProfileByUin(1707889225n);
    expect(human?.isBot).toBe(false);
  });
});
