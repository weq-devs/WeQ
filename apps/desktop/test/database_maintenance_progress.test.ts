import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseProgressTracker } from '@weq/service/db-progress';
import { DatabaseMaintenanceProgress } from '../src/renderer/src/components/DatabaseMaintenanceProgress';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('步骤在同一时间线展示一次，无分母时使用不定进度，失败保留步骤和数量', async () => {
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
    expect(host.querySelectorAll('.weq-db-progress-timeline')).toHaveLength(1);
    expect(host.textContent?.match(/解密源数据库/g)).toHaveLength(1);
    expect(host.querySelector('.weq-db-progress-groups')).toBeNull();
    expect(host.querySelector('details')).toBeNull();
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
    expect(host.querySelector('.weq-db-progress-timeline .is-failed')).not.toBeNull();
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

it('长步骤只显示一处任务耗时，不展示更新间隔或重复的步骤耗时', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T04:00:00Z'));
  const host = document.createElement('div');
  const root = createRoot(host);
  const tracker = new DatabaseProgressTracker('checkup', 'synthetic.db');
  const progress = tracker.update('checkup', { step: 'integrity', message: '检查数据库整体结构' });
  try {
    await act(async () => root.render(h(DatabaseMaintenanceProgress, { progress })));
    await act(async () => vi.advanceTimersByTime(79_000));
    expect(host.textContent?.match(/1 分 19 秒/g)).toHaveLength(1);
    expect(host.textContent?.match(/检查数据库整体结构/g)).toHaveLength(1);
    expect(host.textContent).not.toContain('进度更新');
    expect(host.textContent).not.toContain('本步骤');
    expect(host.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(host.textContent).toContain('页签名检查');
    expect(host.textContent).toContain('归属分析');
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it('长过程在同一时间线收起较早步骤，展开不重复当前步骤，停止后不再显示待开始', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const tracker = new DatabaseProgressTracker('repair', 'synthetic.db');
  for (let index = 0; index < 8; index++) {
    tracker.update('Repair', { step: String(index), message: `恢复步骤 ${index}` });
  }
  const progress = tracker.update('Repair', { step: 'current', message: '恢复当前数据' });
  try {
    await act(async () => root.render(h(DatabaseMaintenanceProgress, { progress })));
    expect(host.querySelectorAll('.weq-db-progress-entry:not(.is-pending)')).toHaveLength(4);
    expect(host.textContent).not.toContain('恢复步骤 0');
    const expand = host.querySelector<HTMLButtonElement>('.weq-db-progress-expand button')!;
    expect(expand.textContent).toContain('5');
    await act(async () => expand.click());
    expect(host.textContent).toContain('恢复步骤 0');
    expect(host.textContent?.match(/恢复当前数据/g)).toHaveLength(1);
    await act(async () =>
      root.render(h(DatabaseMaintenanceProgress, { progress: tracker.finish('cancelled')! })),
    );
    expect(host.textContent).toContain('已停止');
    expect(host.querySelector('.is-pending')).toBeNull();
    expect(host.querySelector('.weq-spin')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it('较早的失败步骤不随已完成步骤一起收起', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const tracker = new DatabaseProgressTracker('checkup', 'synthetic.db');
  tracker.update('checkup', { step: 'integrity', message: '结构检查未完成', status: 'failed' });
  for (let index = 0; index < 8; index++) {
    tracker.update('checkup', { step: `mapping-${index}`, message: `定位步骤 ${index}` });
  }
  const progress = tracker.update('checkup', { step: 'mapping', message: '归属分析' });
  try {
    await act(async () => root.render(h(DatabaseMaintenanceProgress, { progress })));
    expect(host.querySelector('.weq-db-progress-entry.is-failed')?.textContent).toContain(
      '结构检查未完成',
    );
    expect(host.textContent?.match(/归属分析/g)).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
  }
});
