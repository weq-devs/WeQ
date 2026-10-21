import { describe, expect, it, vi } from 'vitest';
import { renderDbHealthReportMarkdown } from '../src/account/db_health';
vi.mock('../src/common/host', () => ({ getHost: () => ({ appVersion: () => 'fixture' }) }));

describe('数据库健康报告的证据分类', () => {
  it('无法解密不等于确认损坏，不提供破坏性修复建议', () => {
    const report = renderDbHealthReportMarkdown({
      uin: '10001',
      dbDir: '/fixture/nt_db',
      failures: [
        {
          dbName: 'nt_msg.db',
          dbPath: '/fixture/nt_db/nt_msg.db',
          corruptedTables: [],
          error: 'Failed to decrypt database with provided key',
        },
      ],
    });
    expect(report).toContain('健康检查未能完成');
    expect(report).not.toContain('检出数据库损坏');
    expect(report).not.toContain('tail -c');
    expect(report).toContain('密钥');
  });
  it('真正完成检查并发现坏表时保留损坏结论及修复建议', () => {
    const report = renderDbHealthReportMarkdown({
      uin: '10001',
      dbDir: '/fixture/nt_db',
      failures: [
        {
          dbName: 'nt_msg.db',
          dbPath: '/fixture/nt_db/nt_msg.db',
          corruptedTables: ['fixture_table'],
        },
      ],
    });
    expect(report).toContain('检出数据库损坏');
    expect(report).toContain('fixture_table 表损坏');
  });
});
