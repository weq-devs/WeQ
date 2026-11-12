import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageSelectionBar } from '../src/renderer/src/components/MessageSelectionBar';
afterEach(() => vi.unstubAllGlobals());
it.each([
  { props: {}, toolbar: '消息多选操作', count: '已选 3 条消息', label: '条已选' },
  {
    props: { unit: '项', subject: '内容' },
    toolbar: '内容多选操作',
    count: '已选 3 项内容',
    label: '项已选',
  },
])(
  '复用多选栏保持原消息默认语义，并支持资源计数：$toolbar',
  async ({ props, toolbar, count, label }) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          createElement(
            MessageSelectionBar,
            {
              ...props,
              count: 3,
            },
            createElement('button', { type: 'button' }, '动作'),
          ),
        ),
      );
      expect(host.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe(toolbar);
      expect(host.querySelector('.selection-bar-info')?.getAttribute('aria-label')).toBe(count);
      expect(host.querySelector('.selection-bar-label')?.textContent).toBe(label);
    } finally {
      await act(async () => root.unmount());
    }
  },
);
