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
    expect(host.querySelector('details')?.open).toBe(true);
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
    expect(host.querySelector('.is-pending')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it('结构检查的记录阶段展示自身百分比与记录数，不把阶段完成当作整库完成', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const tracker = new DatabaseProgressTracker('checkup', 'synthetic.db');
  tracker.update('checkup', {
    step: 'integrity-pages',
    message: '检查页结构与引用',
    completed: 1024,
    total: 1024,
    unit: 'pages',
  });
  const progress = tracker.update('checkup', {
    step: 'integrity-records-2',
    message: '检查记录与索引对应',
    objectName: 'synthetic_table',
    completed: 500,
    total: 2000,
    unit: 'records',
  });
  try {
    await act(async () => root.render(h(DatabaseMaintenanceProgress, { progress })));
    expect(host.querySelector('progress')?.getAttribute('value')).toBe('25');
    expect(host.textContent).toContain('500 / 2,000 条记录');
    expect(host.textContent).toContain('synthetic_table');
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain(
      '检查记录与索引对应',
    );
    expect(host.querySelector('.is-pending')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it('长过程在同一时间线收起较早步骤，展开不重复当前步骤，停止后不再显示待开始', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const tracker = new DatabaseProgressTracker('repair', 'synthetic.db');
  for (let index = 0; index < 8; index++) {
    tracker.update('Decrypt', { step: String(index), message: `恢复步骤 ${index}` });
  }
  const progress = tracker.update('Repair', { step: 'current', message: '恢复当前数据' });
  try {
    await act(async () => root.render(h(DatabaseMaintenanceProgress, { progress })));
    const earlier = host.querySelector<HTMLDetailsElement>('details')!;
    expect(earlier.open).toBe(false);
    await act(async () => {
      earlier.open = true;
      earlier.dispatchEvent(new Event('toggle'));
    });
    expect(earlier.open).toBe(true);
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

it('未扫完的阶段显示提前结束，异常在继续定位和历史折叠后仍然可见', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const tracker = new DatabaseProgressTracker('checkup', 'synthetic.db');
  tracker.update('checkup', { step: 'integrity', message: '检查数据库整体结构' });
  tracker.update('checkup', {
    step: 'integrity-pages',
    message: '检查页结构与引用',
    completed: 4336384,
    total: 4567177,
    unit: 'pages',
  });
  const progress = tracker.update('checkup', {
    step: 'integrity-tables',
    message: '逐表定位结构异常',
    completed: 17,
    total: 34,
    unit: 'tables',
    outcome: 'abnormal',
  });
  try {
    await act(async () => root.render(h(DatabaseMaintenanceProgress, { progress })));
    const partial = host.querySelector('.is-incomplete');
    expect(partial?.textContent).toContain('提前结束');
    expect(partial?.textContent).toContain('4,336,384 / 4,567,177 页');
    expect(partial?.querySelector('.lucide-check')).toBeNull();
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain('异常');
    tracker.update('checkup', {
      step: 'integrity',
      message: '检查数据库整体结构',
      status: 'completed',
      outcome: 'abnormal',
    });
    for (let index = 0; index < 8; index++)
      tracker.update('checkup', {
        step: `mapping-${index}`,
        message: `定位步骤 ${index}`,
      });
    await act(async () =>
      root.render(
        h(DatabaseMaintenanceProgress, {
          progress: tracker.update('checkup', { step: 'mapping', message: '归属分析' }),
        }),
      ),
    );
    expect(host.querySelector('.is-abnormal')?.textContent).toContain('异常');
    expect(host.querySelector('.is-incomplete')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  ['normal', '正常'],
  ['abnormal', '发现异常'],
  ['unverified', '未判定'],
] as const)('检查结果 %s 有明确文字，不以完成勾代替', async (outcome, label) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const tracker = new DatabaseProgressTracker('checkup', 'synthetic.db');
  const progress = tracker.update('checkup', {
    step: 'pages',
    message: '检查页签名',
    status: 'completed',
    outcome,
    detail: '合成检查结果',
    completed: 4,
    total: 4,
    unit: 'pages',
  });
  try {
    await act(async () => root.render(h(DatabaseMaintenanceProgress, { progress })));
    expect(host.querySelector('.weq-db-progress-step strong')?.textContent).toBe(label);
    expect(host.textContent).toContain('合成检查结果');
    if (outcome !== 'normal') expect(host.querySelector('.lucide-check')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
