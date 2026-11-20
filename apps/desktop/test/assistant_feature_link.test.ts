import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AssistantMessage } from '../src/renderer/src/views/agentlab/AssistantMessage';
import { featureLink, OPEN_FEATURE_EVENT } from '../src/shared/feature_links';
import { findLinkedAppEntry } from '../src/renderer/src/components/search/appSearchCatalog';

it('助手 Markdown 中的目录链接点击后调用应用导航，外链仍打开浏览器', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const selections: Array<ReturnType<typeof findLinkedAppEntry>> = [];
  const onOpen = (event: Event) =>
    selections.push(findLinkedAppEntry((event as CustomEvent<string>).detail));
  window.addEventListener(OPEN_FEATURE_EVENT, onOpen);
  try {
    const text = `[设置默认模型](${featureLink('setting:llm-default-model')}) 和 [外部参考](https://example.com)`;
    await act(async () => root.render(createElement(AssistantMessage, { text })));
    const [internal, external] = host.querySelectorAll<HTMLAnchorElement>('a');
    expect(internal?.textContent).toBe('设置默认模型');
    await act(async () => internal!.click());
    expect(selections).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ kind: 'setting', settingId: 'llm-default-model' }),
      }),
    ]);
    expect(external?.getAttribute('target')).toBe('_blank');
    expect(findLinkedAppEntry('assistant.clones.create')).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    window.removeEventListener(OPEN_FEATURE_EVENT, onOpen);
    host.remove();
    vi.unstubAllGlobals();
  }
});
