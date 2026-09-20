import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { MAX_FAST_DECRYPT_BYTES, selectDatabaseDecryptMethod } from '@weq/native';
import type { Platform } from '@weq/platform';
import { DbDecryptService } from '../src/account/db_decrypt';

// Exercise the production worker code, substituting only the native addon.
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(code: string, options: import('node:worker_threads').WorkerOptions) {
        super(code, {
          ...options,
          workerData: {
            ...options.workerData,
            ntHelperPath: fileURLToPath(new URL('./fixtures/decrypt_binding.cjs', import.meta.url)),
          },
        });
      }
    },
  };
});

const algo = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
let dir: string;
let dbPath: string;
let service: DbDecryptService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weq-decrypt-'));
  dbPath = join(dir, 'group_msg_fts.db');
  writeFileSync(dbPath, 'fixture');
  service = new DbDecryptService(
    {
      context: { uin: 'fixture', dbKey: 'fixture-key', algos: { 'group_msg_fts.db': algo } },
    } as AccountSession,
    {
      ntDbDir: () => dir,
      loginDbPath: () => null,
      native: { resources: { loaderDir: join(dir, 'ninebird') } },
    } as unknown as Platform,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('database export allocation guard', () => {
  it.each([
    [MAX_FAST_DECRYPT_BYTES - 1, 'fast', 'fast'],
    [MAX_FAST_DECRYPT_BYTES, 'fast', 'safe'],
    [2 ** 31 + 4096, 'fast', 'safe'],
    [2 ** 32 + 4096, 'fast', 'safe'],
    [4096, 'safe', 'safe'],
  ] as const)('exports %i bytes in requested %s mode using %s', async (size, mode, expected) => {
    // Sparse files exercise actual filesystem sizes without allocating GiB.
    truncateSync(dbPath, size);
    const results = await service.decryptDatabases({
      items: [{ dbPath }],
      outputDir: join(dir, 'out'),
      mode,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.ok, results[0]!.error).toBe(true);
    expect(JSON.parse(readFileSync(results[0]!.outPath, 'utf8'))).toMatchObject({
      method: expected,
      dbPath,
      key: 'fixture-key',
      algo,
    });
  });

  it('fails before native fast decryption if the file cannot be sized', () => {
    expect(() => selectDatabaseDecryptMethod(join(dir, 'missing.db'))).toThrow();
  });
});
