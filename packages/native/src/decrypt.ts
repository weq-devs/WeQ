import { statSync } from 'node:fs';

export type DatabaseDecryptMode = 'fast' | 'safe';
export type DatabaseDecryptMethod = 'fastDecryptDatabase' | 'safeDecryptDatabase';

/**
 * The fast native helper reads the entire encrypted file into one allocation.
 * Electron's allocator can terminate the process on oversized allocations;
 * neither try/catch nor a worker thread can contain that failure. Leave ample
 * headroom below its ~2 GiB allocation limit, including for concurrent exports
 * and the decrypted copy, by using SQLite's page-based export for large files.
 */
export const MAX_FAST_DECRYPT_BYTES = 512 * 1024 * 1024;

export function selectDatabaseDecryptMethod(
  dbPath: string,
  mode: DatabaseDecryptMode = 'fast',
): DatabaseDecryptMethod {
  if (mode === 'safe') return 'safeDecryptDatabase';
  return statSync(dbPath).size < MAX_FAST_DECRYPT_BYTES
    ? 'fastDecryptDatabase'
    : 'safeDecryptDatabase';
}
