import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ForwardWindowHost, openForwardWindow } from '../src/renderer/src/components/ForwardWindow';
import { useForwardStore } from '../src/renderer/src/state/forwardWindow';
import { messageBubble } from '../src/renderer/src/lib/messageBubbles';
import type { MessageBubbleSkin } from '@weq/service';

const fixture = vi.hoisted(() => ({ loaded: vi.fn(), ready: Promise.resolve() }));
vi.mock('../src/renderer/src/components/ForwardWindowContent', async () => {
  fixture.loaded();
  await fixture.ready;
  return {
    ForwardWindowContent: ({ windows }: { windows: { id: number; title: string }[] }) =>
      h('output', { 'data-forward-content': true }, windows.map((win) => win.title).join(',')),
  };
});

it('未打开不加载正文，首次占位可关闭，加载完成不恢复已关闭窗口，重开复用正文模块', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useForwardStore.setState({ windows: [], seq: 0, zTop: 1000 });
  let release = () => {};
  fixture.ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  const skin: MessageBubbleSkin = {
    itemId: 21991,
    slice: { left: 4, right: 4, top: 4, bottom: 4 },
    imageSize: { w: 40, h: 40 },
    textColor: '#516196',
    localFile: 'synthetic.png',
  };
  try {
    await act(async () => root.render(h(ForwardWindowHost)));
    expect(fixture.loaded).not.toHaveBeenCalled();
    await act(async () =>
      openForwardWindow({
        title: '旧窗口',
        kind: 'c2c',
        conv: '',
        msgId: 'old',
        records: [{ msgId: 'old', elements: [], cachedBubbles: [skin] }],
      }),
    );
    expect(messageBubble(skin.itemId)).toBe(skin);
    expect(fixture.loaded).toHaveBeenCalledOnce();
    const pending = document.querySelector<HTMLElement>('[aria-label="旧窗口"]')!;
    expect(pending.getAttribute('aria-busy')).toBe('true');
    await act(async () => pending.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    expect(useForwardStore.getState().windows).toHaveLength(0);
    await act(async () => release());
    expect(document.querySelector('[data-forward-content]')).toBeNull();
    await act(async () =>
      openForwardWindow({ title: '新窗口', kind: 'c2c', conv: '', msgId: 'new', records: [] }),
    );
    expect(document.querySelector('[data-forward-content]')?.textContent).toBe('新窗口');
    expect(fixture.loaded).toHaveBeenCalledOnce();
  } finally {
    release();
    act(() => {
      useForwardStore.setState({ windows: [] });
      root.unmount();
    });
    vi.unstubAllGlobals();
  }
});
