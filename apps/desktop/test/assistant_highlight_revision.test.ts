import { act, createElement as h, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AssistantMessage } from '../src/renderer/src/views/agentlab/AssistantMessage';

const pending = vi.hoisted(
  () => [] as Array<(result: { tokens: { content: string }[][] }) => void>,
);
vi.mock('../src/renderer/src/views/agentlab/shikiHighlighter', () => ({
  shikiCodeHighlighter: {
    highlight: (
      _options: unknown,
      callback: (result: { tokens: { content: string }[][] }) => void,
    ) => {
      pending.push(callback);
      return null;
    },
  },
}));
vi.mock('streamdown', () => ({
  Streamdown: ({
    children,
    plugins,
  }: {
    children: string;
    plugins: {
      code: {
        highlight: (
          options: unknown,
          callback: (value: { tokens: { content: string }[][] }) => void,
        ) => void;
      };
    };
  }) => {
    const [text, setText] = useState(children);
    useEffect(() => {
      setText(children);
      plugins.code.highlight({}, (result) => setText(result.tokens[0]![0]!.content));
    }, [children, plugins]);
    return h('code', null, text);
  },
}));
it('流式内容更新后忽略旧版本的异步高亮回填', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(h(AssistantMessage, { text: 'old', streaming: true })));
    act(() => root.render(h(AssistantMessage, { text: 'new', streaming: true })));
    act(() => pending[0]!({ tokens: [[{ content: 'stale' }]] }));
    expect(host.textContent).toBe('new');
    act(() => pending[1]!({ tokens: [[{ content: 'new highlighted' }]] }));
    expect(host.textContent).toBe('new highlighted');
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
