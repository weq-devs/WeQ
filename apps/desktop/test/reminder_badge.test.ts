import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReminderCount, ReminderDot } from '../src/renderer/src/components/ReminderBadge';
import { WorkspaceStatusDot } from '../src/renderer/src/components/WorkspaceStatusDot';

afterEach(() => vi.unstubAllGlobals());

describe('共用提醒组件', () => {
  it('数字格式、空计数和三种语义保持一致，消息角标仍可独立点击', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const clicked = vi.fn();
    try {
      for (const [count, label] of [
        [1, '1'],
        [99, '99'],
        [100, '99+'],
      ] as const) {
        act(() =>
          root.render(
            h(ReminderCount, {
              count,
              as: 'button',
              overlay: true,
              className: 'rail-message-badge',
              'aria-label': '定位未读消息',
              onClick: clicked,
            }),
          ),
        );
        const badge = host.querySelector<HTMLButtonElement>('.rail-message-badge')!;
        expect(badge.tagName).toBe('BUTTON');
        expect(badge.type).toBe('button');
        expect(badge.textContent).toBe(label);
        expect(badge.getAttribute('aria-label')).toBe('定位未读消息');
        expect(badge.classList.contains('weq-reminder-overlay')).toBe(true);
        expect(badge.dataset.tone).toBe('notice');
        act(() => badge.click());
      }
      expect(clicked).toHaveBeenCalledTimes(3);
      for (const tone of ['notice', 'muted', 'running'] as const) {
        act(() => root.render(h(ReminderCount, { count: 8, tone })));
        const badge = host.querySelector<HTMLElement>('.weq-reminder-count')!;
        expect(badge.tagName).toBe('SPAN');
        expect(badge.dataset.tone).toBe(tone);
        expect(badge.classList.contains('weq-reminder-overlay')).toBe(false);
      }
      for (const count of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        act(() => root.render(h(ReminderCount, { count })));
        expect(host.childElementCount).toBe(0);
      }
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('纯圆点保留入口样式钩子和无障碍标签，不包含数字', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          h(ReminderDot, {
            className: 'notice-entry-dot',
            role: 'status',
            'aria-label': '有新通知',
          }),
        ),
      );
      const dot = host.querySelector('.notice-entry-dot')!;
      expect(dot.classList.contains('weq-reminder-dot')).toBe(true);
      expect(dot.textContent).toBe('');
      expect(dot.getAttribute('aria-label')).toBe('有新通知');
      expect(dot.getAttribute('role')).toBe('status');
    } finally {
      act(() => root.unmount());
    }
  });

  it('菜单优先展示进行中数量，结束结果只显示红点', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() => root.render(h(WorkspaceStatusDot, { running: 2, finished: 5 })));
      expect(host.querySelector<HTMLElement>('.weq-reminder-count')?.dataset.tone).toBe('running');
      expect(host.textContent).toBe('2');
      act(() => root.render(h(WorkspaceStatusDot, { running: 0, finished: 105 })));
      expect(host.querySelector('.weq-reminder-dot')).not.toBeNull();
      expect(host.textContent).toBe('');
      act(() => root.render(h(WorkspaceStatusDot, { running: 0, finished: 0 })));
      expect(host.childElementCount).toBe(0);
    } finally {
      act(() => root.unmount());
    }
  });
});
