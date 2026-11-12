import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SearchGroupContentResult } from '../src/renderer/src/components/search/SearchGroupContentResult';
import { FlashTransferViewer } from '../src/renderer/src/components/FlashTransferViewer';

const fixture = vi.hoisted(() => ({
  data: null as unknown,
  error: null as { message: string } | null,
  refetch: vi.fn(),
  bulletin: vi.fn(),
  essence: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: () => {
    throw new Error('搜索明细不应创建独立弹窗');
  },
}));
vi.mock('../src/renderer/src/components/GroupAnnouncementsDialog', () => ({
  GroupAnnouncementsDialog: (props: unknown) => {
    fixture.bulletin(props);
    return h('div', null, '公告正文');
  },
}));
vi.mock('../src/renderer/src/components/GroupEssenceDialog', () => ({
  GroupEssenceDialog: (props: unknown) => {
    fixture.essence(props);
    return h('div', null, '精华正文');
  },
}));
vi.mock('../src/renderer/src/components/FlashShareDialog', () => ({
  FlashShareDialog: () => null,
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ useToast: () => fixture.toast }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { account: { searchTargets: { group: { useQuery: () => fixture } } } },
  client: { account: { flashListFiles: { query: async () => ({ files: [] }) } } },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fixture.data = null;
  fixture.error = null;
});

it.each(['loading', 'error', 'bulletin', 'essence'] as const)(
  '群内容的 %s 状态始终内嵌，不实例化独立外壳',
  async (state) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    if (state === 'error') fixture.error = { message: '读取失败' };
    if (state === 'bulletin')
      fixture.data = { kind: 'bulletin', name: '合成群', bulletin: { id: 'notice' } };
    if (state === 'essence')
      fixture.data = { kind: 'essence', name: '合成群', message: { msgSeq: 1, operatorTime: 1 } };
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          h(SearchGroupContentResult, {
            target: {
              kind: 'groupBulletin',
              groupCode: '123',
              bulletinId: 'notice',
              expectedAccountUin: '10001',
              expectedAccountConfigId: 'synthetic',
            },
            onClose: vi.fn(),
            onJump: vi.fn(),
          }),
        ),
      );
      if (state === 'bulletin')
        expect(fixture.bulletin).toHaveBeenLastCalledWith(
          expect.objectContaining({ embedded: true }),
        );
      if (state === 'essence')
        expect(fixture.essence).toHaveBeenLastCalledWith(
          expect.objectContaining({ embedded: true }),
        );
      if (state === 'error') {
        expect(host.textContent).toContain('读取失败');
        act(() => host.querySelector<HTMLButtonElement>('button')!.click());
        expect(fixture.refetch).toHaveBeenCalledOnce();
      }
      expect(host.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  },
);

it('闪传搜索内容直接嵌入容器，不实例化旧的浮窗外壳', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(FlashTransferViewer, {
          embedded: true,
          filesetId: 'synthetic',
          title: '搜索命中',
          onClose: vi.fn(),
        }),
      ),
    );
    expect(host.querySelector('.weq-ft')).not.toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
