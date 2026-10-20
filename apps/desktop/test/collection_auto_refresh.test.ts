// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CollectionDialog } from '../src/renderer/src/components/CollectionDialog';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

const rpc = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { listCollections: { query: rpc.list } } },
}));
vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));
vi.mock('../src/renderer/src/components/ProfileAvatar', () => ({ ProfileAvatar: () => null }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('收藏断网仍读取本地缓存，联网自动校准，随后读取失败不覆盖已有云端内容', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const local = {
    cid: 'fixture',
    kind: 'text',
    type: 1,
    collectTime: 1,
    createTime: 1,
    authorName: '',
    authorUin: '',
    groupName: '',
    text: '本地旧摘要',
    fullContent: '',
    fullContentFormat: null,
    link: null,
    gallery: null,
    audio: null,
    video: null,
    file: null,
    location: null,
    richMedia: null,
  };
  let failRemote = false;
  rpc.list.mockReset().mockImplementation(async ({ source }: { source: string }) => {
    if (source === 'network' && failRemote) throw new Error('合成网络失败');
    return { items: [source === 'db' ? local : { ...local, text: '云端新摘要' }], hasMore: false };
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  let active = true;
  const render = () =>
    act(async () =>
      root.render(
        h(
          TabActivity,
          { active },
          h(CollectionDialog, { open: true, embedded: true, onClose() {} }),
        ),
      ),
    );
  try {
    await render();
    expect(host.textContent).toContain('本地旧摘要');
    expect(rpc.list).toHaveBeenCalledTimes(1);
    online.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(host.textContent).toContain('云端新摘要');
    expect(rpc.list).toHaveBeenCalledTimes(3);
    active = false;
    await render();
    failRemote = true;
    active = true;
    await render();
    expect(host.textContent).toContain('云端新摘要');
    expect(host.textContent).toContain('合成网络失败');
    expect(host.querySelector('[aria-label="重试读取收藏"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
