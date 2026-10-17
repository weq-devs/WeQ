import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { NtHelperBinding } from '@weq/native';
import { dbLaneFor } from '../src/main/db/lane';
import type { StandardDbLane } from '../src/main/db/router';
import { createDbRouter } from '../src/main/db/router';

function fakeBinding() {
  return {
    setDbLayout: vi.fn(),
    executeSql: vi.fn().mockResolvedValue([['main']]),
    executeSqlWithKey: vi.fn().mockResolvedValue([['qq']]),
    executeSqlWrite: vi.fn().mockResolvedValue(1),
    executeSqlWriteWithKey: vi.fn().mockResolvedValue(2),
    executeSqlSalvage: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
    safeDecryptDatabase: vi.fn(),
    executeSqlSalvageScan: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
    closeDb: vi.fn().mockReturnValue(3),
    closeSalvageDb: vi.fn().mockReturnValue(4),
    closeAllDb: vi.fn().mockReturnValue(5),
    clearQuarantinedTables: vi.fn().mockReturnValue(6),
    listQuarantinedTables: vi.fn().mockReturnValue([{ dbPath: '/qq.db' }]),
  };
}

function fakeStandard(): StandardDbLane {
  return {
    request: vi.fn().mockResolvedValue([[1n]]),
    notify: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('dbLaneFor', () => {
  it('sends every keyed SQLCipher method to the main process', () => {
    for (const method of [
      'executeSqlWithKey',
      'executeSqlWriteWithKey',
      'executeSqlSalvageWithKey',
      'executeSqlSalvageScanWithKey',
      'testDatabaseKey',
      'checkDatabaseHealth',
      'recoverDatabase',
      'checkpointWal',
      'fastDecryptDatabase',
      'safeDecryptDatabase',
    ]) {
      expect(dbLaneFor(method)).toBe('main');
    }
  });

  it('sends plain SQLite query / salvage methods to the worker', () => {
    for (const method of [
      'executeSql',
      'executeSqlWrite',
      'executeSqlSalvage',
      'executeSqlSalvageScan',
    ]) {
      expect(dbLaneFor(method)).toBe('standard');
    }
  });

  it('keeps handle bookkeeping in both lanes', () => {
    for (const method of ['closeDb', 'closeSalvageDb', 'closeAllDb', 'clearQuarantinedTables']) {
      expect(dbLaneFor(method)).toBe('both');
    }
  });
});

describe('createDbRouter', () => {
  it('pins the main process to QQ layout', () => {
    const nt = fakeBinding();
    createDbRouter(nt as unknown as NtHelperBinding, fakeStandard());
    expect(nt.setDbLayout).toHaveBeenCalledWith('qq');
  });

  it('routes unkeyed queries to the standard worker', async () => {
    const nt = fakeBinding();
    const standard = fakeStandard();
    const routed = createDbRouter(nt as unknown as NtHelperBinding, standard);

    await expect(routed.executeSql('/plain.db', 'SELECT 1', null)).resolves.toEqual([[1n]]);
    expect(standard.request).toHaveBeenCalledWith('executeSql', ['/plain.db', 'SELECT 1', null]);
    expect(nt.executeSql).not.toHaveBeenCalled();
  });

  it('keeps keyed queries in the main process', async () => {
    const nt = fakeBinding();
    const standard = fakeStandard();
    const routed = createDbRouter(nt as unknown as NtHelperBinding, standard);

    await expect(routed.executeSqlWithKey('/qq.db', 'SELECT 1', 'k', {}, null)).resolves.toEqual([
      ['qq'],
    ]);
    expect(nt.executeSqlWithKey).toHaveBeenCalledWith('/qq.db', 'SELECT 1', 'k', {}, null);
    expect(standard.request).not.toHaveBeenCalled();
  });

  it('routes a marked plaintext QQ database to the main lane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weq-db-router-'));
    try {
      const dbPath = join(dir, 'decrypted.db');
      writeFileSync(dbPath, '');
      const nt = fakeBinding();
      const standard = fakeStandard();
      const routed = createDbRouter(nt as unknown as NtHelperBinding, standard);

      routed.markQqLayout?.(dbPath);
      await expect(routed.executeSql(dbPath, 'SELECT 1', null)).resolves.toEqual([['main']]);
      expect(nt.executeSql).toHaveBeenCalledWith(dbPath, 'SELECT 1', null);
      expect(standard.request).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes handles in both lanes but keeps the synchronous main count', () => {
    const nt = fakeBinding();
    const standard = fakeStandard();
    const routed = createDbRouter(nt as unknown as NtHelperBinding, standard);

    expect(routed.closeDb('/plain.db')).toBe(3);
    expect(nt.closeDb).toHaveBeenCalledWith('/plain.db');
    expect(standard.notify).toHaveBeenCalledWith('closeDb', ['/plain.db']);

    expect(routed.closeSalvageDb('/plain.db')).toBe(4);
    expect(standard.notify).toHaveBeenCalledWith('closeSalvageDb', ['/plain.db']);
  });

  it('clears quarantine in both lanes and lists the main lane synchronously', () => {
    const nt = fakeBinding();
    const standard = fakeStandard();
    const routed = createDbRouter(nt as unknown as NtHelperBinding, standard);

    expect(routed.clearQuarantinedTables('/plain.db', 't')).toBe(6);
    expect(standard.notify).toHaveBeenCalledWith('clearQuarantinedTables', ['/plain.db', 't']);
    expect(routed.listQuarantinedTables()).toEqual([{ dbPath: '/qq.db' }]);
  });
});
