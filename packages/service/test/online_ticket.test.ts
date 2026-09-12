import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encode, RequestDecryptKey } from '@weq/protocol';
import type { NtHelperBinding } from '@weq/native';
import { requestDecryptKeyFromInstance } from '../src/account/online_ticket';

describe('requestDecryptKeyFromInstance', () => {
  it('reads the header salt at 0x2f..0xaf and sends OIDB 0xCDE_2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weq-ticket-'));
    const dbPath = join(dir, 'nt_msg.db');
    try {
      const salt = 'a1'.repeat(64);
      const header = Buffer.alloc(0xaf);
      header.write(salt, 0x2f, 'ascii');
      writeFileSync(dbPath, header);

      const sent: unknown[] = [];
      const nt = {
        sendOidbPacket: async (
          pid: number,
          command: number,
          subCommand: number,
          body: Buffer,
          isUid: boolean,
        ): Promise<Buffer> => {
          sent.push({ pid, command, subCommand, body: Buffer.from(body), isUid });
          return Buffer.from(encode(RequestDecryptKey.respSchema, { info: { dbKey: 'deadbeef' } }));
        },
      } as Pick<NtHelperBinding, 'sendOidbPacket'>;

      await expect(requestDecryptKeyFromInstance(nt, 4321, dbPath)).resolves.toBe('deadbeef');
      expect(sent).toEqual([
        {
          pid: 4321,
          command: 0xcde,
          subCommand: 2,
          body: Buffer.from(
            encode(
              RequestDecryptKey.reqSchema,
              RequestDecryptKey.serialize({ dbSalt: salt.toUpperCase() }),
            ),
          ),
          isUid: false,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a header whose salt is not 128 hex chars', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weq-ticket-'));
    const dbPath = join(dir, 'nt_msg.db');
    try {
      const header = Buffer.alloc(0xaf);
      writeFileSync(dbPath, header);
      const nt = {
        sendOidbPacket: async (): Promise<Buffer> => Buffer.alloc(0),
      } as Pick<NtHelperBinding, 'sendOidbPacket'>;
      await expect(requestDecryptKeyFromInstance(nt, 1, dbPath)).rejects.toThrow('Invalid db_salt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
