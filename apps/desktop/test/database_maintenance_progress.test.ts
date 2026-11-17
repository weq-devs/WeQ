import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseProgressTracker } from '@weq/service/db-progress';
import { DatabaseMaintenanceProgress } from '../src/renderer/src/components/DatabaseMaintenanceProgress';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('展示步骤而非整体百分比，无分母时使用不定进度，失败展开过程并保留数量', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const tracker = new DatabaseProgressTracker('repair', 'synthetic.db');
  try {
    const render = async (progress: ReturnType<typeof tracker.update>, connectionError = false) => {
      await act(async () =>
        root.render(h(DatabaseMaintenanceProgress, { progress, connectionError })),
      );
    };
    await render(
      tracker.update('Decrypt', {
        step: 'decrypt',
        message: '解密源数据库',
        completed: 250,
        total: 1000,
        unit: 'pages',
      }),
    );
    expect(host.textContent).toContain('25.0%');
    expect(host.textContent).toContain('250 / 1,000 页');
    expect(host.querySelector('progress')?.getAttribute('value')).toBe('25');
    await render(
      tracker.update('Repair', {
        step: 'data',
        message: '恢复表数据',
        completed: 9000,
        unit: 'fields',
        objectName: 'group_msg_table',
      }),
    );
    expect(host.textContent).toContain('处理中');
    expect(host.textContent).toContain('9,000 个字段');
    expect(host.querySelector('progress')?.hasAttribute('value')).toBe(false);
    await render(tracker.finish('failed')!);
    expect(host.querySelector('details')?.open).toBe(true);
    expect(host.textContent).toContain('未完成');
    expect(host.textContent).toContain('9,000 个字段');
    await render(tracker.update('Repair', { step: 'data', message: '恢复表数据' }), true);
    expect(host.getElementsByClassName('weq-db-progress-warning')[0]?.textContent).toContain(
      '进度连接中断',
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
