import { expect, it, vi } from 'vitest';
import { QqDb } from '@weq/db';
import type { NtHelperBinding, SqlRow } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { AnnualReportService } from '../src/account/annual_report/engine';

it('关闭账号取消报告排队读取，旧报告不在下一个账号继续触库', async () => {
  let finish!: (rows: SqlRow[]) => void;
  const executeSql = vi.fn(
    () =>
      new Promise<SqlRow[]>((done) => {
        finish = done;
      }),
  );
  const nt = { executeSql, closeDb() {} } as unknown as NtHelperBinding;
  const db = new QqDb(nt, { dbPath: '/synthetic/report-lifetime.db' });
  const holding = db.query('hold');
  const session = {
    context: { uin: '10001' },
    selfUid: 'u_self',
    msgDbPath: '/synthetic/report-lifetime.db',
    c2cMsgs: {
      yearsWithMessages: async () => (await db.query('years c2c')).map((row) => Number(row[0])),
    },
    groupMsgs: {
      yearsWithMessages: async () => (await db.query('years group')).map((row) => Number(row[0])),
    },
  } as unknown as AccountSession;
  const report = new AnnualReportService(session);
  const pending = report.getAvailableYears();
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  report.dispose();
  await rejected;
  finish([]);
  await holding;
  expect(executeSql).toHaveBeenCalledTimes(1);
  await expect(report.getAvailableYears()).rejects.toMatchObject({ name: 'AbortError' });
  await expect(report.getPageData(2026, 'overview')).rejects.toMatchObject({ name: 'AbortError' });
  expect(executeSql).toHaveBeenCalledTimes(1);
});
