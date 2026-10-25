import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduleSettings } from '../src/renderer/src/components/tasks/ScheduleSettings';
import {
  DEFAULT_OPTIONS,
  FULL_FORMATS,
  CHATLAB_FORMATS,
  type ScheduledTask,
} from '../src/renderer/src/views/export/types';

const fixture = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { listSchedules: { invalidate: vi.fn() } } }),
    account: {
      updateSchedule: { useMutation: () => ({ mutate: fixture.mutate, isLoading: false }) },
    },
  },
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ error: vi.fn(), success: vi.fn() }),
}));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.mutate.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const schedule: ScheduledTask = {
  id: 'synthetic-schedule',
  name: '合成定时任务',
  format: 'json',
  formats: ['json', 'html'],
  conversations: [{ id: 'synthetic-conv', name: '合成群聊', kind: 'group', total: 8 }],
  schedule: { mode: 'daily', time: '08:00', intervalHours: 6 },
  options: { ...DEFAULT_OPTIONS },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  nextRunAt: null,
  history: [],
};

describe('定时任务设置', () => {
  it('节奏未修改时不重发 schedule，避免服务端重新推算间隔任务的下次执行时间', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          h(ScheduleSettings, {
            schedule: { ...schedule, schedule: { ...schedule.schedule, mode: 'interval' } },
          }),
        ),
      );
      act(() =>
        host
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      expect(fixture.mutate.mock.calls[0]![0].patch).not.toHaveProperty('schedule');
    } finally {
      act(() => root.unmount());
    }
  });
  it.each([0, 169, 1.5])('非法间隔 %s 不提交后端', (intervalHours) => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          h(ScheduleSettings, {
            schedule: {
              ...schedule,
              schedule: { ...schedule.schedule, mode: 'interval', intervalHours },
            },
          }),
        ),
      );
      act(() =>
        host
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      expect(fixture.mutate).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
  it('只保存所选计划的名称、节奏与格式，不扩大导出对象或改写保存策略', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() => root.render(h(ScheduleSettings, { schedule })));
      const modes = host.querySelector('[role="radiogroup"][aria-label="执行方式"]')!;
      const interval = [...modes.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (button) => button.textContent === '间隔执行',
      )!;
      expect(interval.getAttribute('aria-checked')).toBe('false');
      act(() => interval.click());
      expect(interval.getAttribute('aria-checked')).toBe('true');
      act(() =>
        host
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      expect(fixture.mutate).toHaveBeenCalledWith({
        id: schedule.id,
        patch: {
          name: schedule.name,
          schedule: { ...schedule.schedule, mode: 'interval' },
          format: 'json',
          formats: ['json', 'html'],
        },
      });
      expect(fixture.mutate.mock.calls[0]![0].patch).not.toHaveProperty('conversations');
      expect(fixture.mutate.mock.calls[0]![0].patch).not.toHaveProperty('options');
      expect(host.textContent).toContain('合成群聊');
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([false, true])('格式沿用原导出能力，ChatLab=%s 不额外开放其它格式', (chatlab) => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() => root.render(h(ScheduleSettings, { schedule: { ...schedule, chatlab } })));
      expect(
        [...host.querySelectorAll('fieldset label')].map((label) => label.textContent),
      ).toEqual((chatlab ? CHATLAB_FORMATS : FULL_FORMATS).map((item) => item.label));
      expect(host.textContent).not.toContain('VCARD');
    } finally {
      act(() => root.unmount());
    }
  });
});
