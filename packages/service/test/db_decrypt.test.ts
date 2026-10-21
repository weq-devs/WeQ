import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { MAX_FAST_DECRYPT_BYTES, selectDatabaseDecryptMethod } from '@weq/native';
import type { Platform } from '@weq/platform';
import { DbDecryptService } from '../src/account/db_decrypt';

// `decryptDatabases` resolves the real `nt_helper.node` path up front, and
// `resolveNtHelperPath()` throws when the addon isn't installed — which is the
// normal state of a fresh clone, since the binary is fetched, never committed.
// Pin that one export to the offline fixture so the suite stays hermetic; the
// Worker mock below still substitutes the binding the worker actually loads.
vi.mock('@weq/native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weq/native')>();
  return {
    ...actual,
    resolveNtHelperPath: () =>
      fileURLToPath(new URL('./fixtures/decrypt_binding.cjs', import.meta.url)),
  };
});

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
    } as unknown as Platform,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('database export allocation guard', () => {
  it('开始前取消不创建目录，单并发中取消不再分配下一份数据库', async () => {
    const abort = new AbortController();
    abort.abort(new Error('合成取消'));
    const outputDir = join(dir, 'cancelled');
    await expect(
      service.decryptDatabases({
        items: [{ dbPath }],
        outputDir,
        mode: 'safe',
        signal: abort.signal,
      }),
    ).rejects.toThrow('合成取消');
    expect(existsSync(outputDir)).toBe(false);
    const second = join(dir, 'next.db');
    writeFileSync(second, 'synthetic');
    const pending = new AbortController();
    const progress = vi.fn(() => pending.abort(new Error('停止后续库')));
    await expect(
      service.decryptDatabases({
        items: [{ dbPath }, { dbPath: second }],
        outputDir,
        mode: 'safe',
        concurrency: 1,
        signal: pending.signal,
        onProgress: progress,
      }),
    ).rejects.toThrow('停止后续库');
    expect(progress).toHaveBeenCalledOnce();
    expect(existsSync(join(outputDir, 'next.db'))).toBe(false);
    expect(readFileSync(dbPath, 'utf8')).toBe('fixture');
    expect(readFileSync(second, 'utf8')).toBe('synthetic');
  });
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
