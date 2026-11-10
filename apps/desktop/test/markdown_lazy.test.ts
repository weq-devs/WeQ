import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { QqMarkdown } from '../src/renderer/src/components/QqMarkdown';

const state = vi.hoisted(() => ({ imports: 0 }));
vi.mock('../src/renderer/src/components/QqMarkdownContent', () => {
  state.imports++;
  return { QqMarkdown: ({ text }: { text: string }) => createElement('strong', null, text) };
});

it('不渲染 Markdown 时不载入引擎，首次使用后复用同一模块', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(createElement('p', null, '普通消息')));
    expect(state.imports).toBe(0);
    await act(async () => root.render(createElement(QqMarkdown, { text: '合成 Markdown' })));
    expect(host.querySelector('strong')?.textContent).toBe('合成 Markdown');
    expect(state.imports).toBe(1);
    await act(async () => root.render(createElement(QqMarkdown, { text: '下一条' })));
    expect(state.imports).toBe(1);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
