import { expect, it } from 'vitest';
import { exportReport, exportReportHtml } from '../src/account/export/export_report';
import type { ExportTask } from '../src/account/export/task_manager';

it('HTML 报告与 JSON 使用同一份真实计数，转义内容并明确不确定性', () => {
  const task: ExportTask = {
    id: 'synthetic',
    kind: 'group',
    conv: '777',
    name: '<script>name</script>',
    format: 'json',
    status: 'completed',
    progress: 100,
    current: 9,
    total: 9,
    stages: [
      {
        key: 'message',
        label: '正文',
        status: 'completed',
        current: 9,
        total: 9,
        note: '<img src=x onerror=alert(1)>',
      },
    ],
    createdAt: 1,
    updatedAt: 2,
    mergeWarnings: {
      conflictingMessages: 1,
      conflictMessageIds: ['2'],
      sequenceGapCount: 1,
      sequenceGaps: [{ start: '3', end: '4' }],
      basis: 'candidate only',
    },
  };
  expect(exportReport(task).contentStatus).toBe('partial');
  const html = exportReportHtml(task);
  expect(html).toContain('已导出 9 条');
  expect(html).toContain('保留原记录，不覆盖');
  expect(html).toContain('不等于已证实丢失消息');
  expect(html).toContain('3–4');
  expect(html).toContain('&lt;script&gt;name&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img src=x');
  expect(html).toContain('prefers-color-scheme:dark');
});
