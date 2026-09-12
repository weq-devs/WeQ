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
  sql.exec(`CREATE TABLE profile_info_v6 ("1000" TEXT, "21000" BLOB)`);
  const ins = sql.prepare(`INSERT INTO profile_info_v6 ("1000","21000") VALUES (?,?)`);
  ins.run('u_bot_ai', extBlob({ ext: { miscFlags: { botMark: { botType: 2 } } } }));
  ins.run('u_bot_third', extBlob({ ext: { miscFlags: { botMark: { botType: 1 } } } }));
  ins.run('u_human', extBlob({ ext: { nick: '路人' } }));
  ins.run('u_garbage', new Uint8Array([0x00, 0xff, 0x00, 0xfe]));

  db = new ProfileInfoDb(createSqliteStub(), { dbPath });
}

describe('ProfileInfoDb.botUids (offline fixture)', () => {
  it('detects botMark rows and skips humans / garbage', async () => {
    createFixture();

    const bots = await db.botUids();
    expect(bots.has('u_bot_ai')).toBe(true);
    expect(bots.has('u_bot_third')).toBe(true);
    expect(bots.has('u_human')).toBe(false);
    expect(bots.has('u_garbage')).toBe(false);
    expect(bots.size).toBe(2);
  });
});
