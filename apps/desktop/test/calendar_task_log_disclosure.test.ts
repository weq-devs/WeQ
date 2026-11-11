import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TaskLogDisclosure } from '../src/renderer/src/components/TaskLogDisclosure';
it('公共日志栏在任务内部展开并显示错误，收起后不显示日志正文', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'),
    root = createRoot(host);
  function Fixture() {
    const [open, setOpen] = useState(false);
    return createElement(TaskLogDisclosure, {
      open,
      onOpenChange: setOpen,
      lines: [{ ts: 0, seq: 1, stage: 'task', level: 'info', text: '已计 256 条消息' }],
      error: '合成日志读取失败',
    });
  }
  try {
    act(() => root.render(createElement(Fixture)));
    const button = host.querySelector('button')!;
    expect(button.className).toBe('weq-exp-detail-tasklog-head');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.weq-exp-log')).toBeNull();
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('已计 256 条消息');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('合成日志读取失败');
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.weq-exp-log')).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
