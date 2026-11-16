import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseRecoveryPanel } from '../src/renderer/src/components/tasks/DatabaseRecoveryPanel';
import { DatabaseRepairSection } from '../src/renderer/src/components/settings/DatabaseRepairSection';

vi.mock('../src/renderer/src/components/settings/controls', () => ({
  Card: ({
    title,
    children,
    settingId,
  }: {
    title: string;
    children: ReactNode;
    settingId: string;
  }) => createElement('section', { 'data-setting-id': settingId }, title, children),
  Row: ({ label, control }: { label: string; control: ReactNode }) =>
    createElement('div', {}, label, control),
}));
vi.mock('../src/renderer/src/components/settings/NotificationSettingsLink', () => ({
  NotificationSettingsLink: () => createElement('button', {}, '通知设置'),
}));
vi.mock('../src/renderer/src/components/settings/DataMaintenanceSection', () => ({
  DataMaintenanceSection: ({ onOpen }: { onOpen: (tool: string) => void }) =>
    createElement('button', { onClick: () => onOpen('db-repair') }, '打开修复工具'),
}));

afterEach(() => vi.unstubAllGlobals());
function mount(node: ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return {
    host,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
const request = {
  id: 'fixture',
  kind: 'ranges' as const,
  dbPath: '/fixture/nt_msg.db',
  table: 'group_msg_table',
  canSkip: true,
  ranges: [{ lo: '9007199254740993', hi: '9007199254740999' }],
};

it('数据库设置只提供检查修复和通知入口，不再呈现原容错配置或记录', () => {
  const onOpen = vi.fn();
  const f = mount(createElement(DatabaseRepairSection, { onOpen }));
  try {
    expect(f.host.textContent).toContain('数据库检查与修复');
    expect(f.host.textContent).toContain('通知设置');
    expect(f.host.querySelector('select')).toBeNull();
    expect(f.host.textContent).not.toMatch(/容错级别|容错记录|降级账本|实验性/);
    act(() =>
      [...f.host.querySelectorAll('button')]
        .find((button) => button.textContent === '打开修复工具')!
        .click(),
    );
    expect(onOpen).toHaveBeenCalledWith('db-repair');
  } finally {
    f.close();
  }
});

it('坏区间直接原位确认，只将本次任务的区间偏好交给后端', async () => {
  const onDecision = vi.fn(async () => {});
  const f = mount(createElement(DatabaseRecoveryPanel, { request, name: '合成会话', onDecision }));
  try {
    expect(onDecision).not.toHaveBeenCalled();
    expect(f.host.textContent).toContain('9007199254740993');
    act(() => f.host.querySelector<HTMLInputElement>('input')!.click());
    await act(async () =>
      [...f.host.querySelectorAll('button')]
        .find((button) => button.textContent === '跳过此区间并继续')!
        .click(),
    );
    expect(onDecision).toHaveBeenCalledOnce();
    expect(onDecision).toHaveBeenCalledWith('skip', true);
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    f.close();
  }
});

it.each([true, false])('整表单独询问，没有剩余任务时不声称继续，canSkip=%s', async (canSkip) => {
  const onDecision = vi.fn(async () => {});
  const f = mount(
    createElement(DatabaseRecoveryPanel, {
      request: { ...request, kind: 'table', canSkip },
      name: '合成会话',
      onDecision,
    }),
  );
  try {
    expect(f.host.querySelector('input')).toBeNull();
    expect(f.host.textContent).toContain('包括其中可能完好的消息');
    expect(f.host.textContent?.includes('结束此表并保留已有结果')).toBe(canSkip);
    expect(f.host.textContent).not.toContain('跳过此表并继续');
    await act(async () =>
      [...f.host.querySelectorAll('button')]
        .find((button) => button.textContent === '尝试修复…')!
        .click(),
    );
    expect(onDecision).toHaveBeenCalledOnce();
    expect(onDecision).toHaveBeenCalledWith('repair', false);
  } finally {
    f.close();
  }
});

it('不可拆分的读取没有跳过入口，失败原位保留重试按钮', async () => {
  const onDecision = vi.fn(async () => {
    throw new Error('状态已变化');
  });
  const f = mount(
    createElement(DatabaseRecoveryPanel, {
      request: { ...request, kind: 'read', canSkip: false },
      name: '统计',
      onDecision,
    }),
  );
  try {
    expect(f.host.textContent).not.toContain('跳过此区间并继续');
    await act(async () =>
      [...f.host.querySelectorAll('button')]
        .find((button) => button.textContent === '结束任务')!
        .click(),
    );
    expect(f.host.querySelector('[role="alert"]')?.textContent).toBe('状态已变化');
    expect([...f.host.querySelectorAll('button')].every((button) => !button.disabled)).toBe(true);
  } finally {
    f.close();
  }
});
