import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProfileLikeAction } from '../src/renderer/src/components/qq-actions/ProfileLikeAction';
import { useViewState } from '../src/renderer/src/state/view';
import { useToast } from '../src/renderer/src/components/Toast';

const state = vi.hoisted(() => ({
  write: vi.fn(async () => ({ state: 'accepted' as const })),
  read: vi.fn(async () => ({ likeCount: 101 })),
  invalidate: vi.fn(async () => undefined),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      qqActions: { profileLike: { mutate: state.write } },
      dressup: { peerStats: { query: state.read } },
    },
  },
  trpc: {
    account: {
      getAccountConfig: {
        useQuery: () => ({ data: { uin: '10001', configId: 'source-a' } }),
      },
      getGroupAlbumAccessState: {
        useQuery: () => ({
          data: {
            qqOnline: true,
            attachEnabled: true,
            hasA2: true,
            hasD2: true,
            hasD2Key: true,
            hasGuid: true,
          },
        }),
      },
    },
    useUtils: () => ({
      account: {
        dressup: {
          peerStats: { getData: () => ({ likeCount: 100 }), invalidate: state.invalidate },
        },
      },
    }),
  },
}));

let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useViewState.setState({ openedUin: '10001' });
  useToast.setState({ toasts: [], leaving: [] });
  state.write.mockClear();
  state.read.mockClear();
  state.invalidate.mockClear();
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  useViewState.setState({ openedUin: null });
  useToast.setState({ toasts: [], leaving: [] });
  vi.unstubAllGlobals();
});

it.each([
  ['request', 'button'],
  ['request', 'escape'],
  ['request', 'outside'],
  ['readback', 'button'],
  ['readback', 'escape'],
  ['readback', 'outside'],
] as const)(
  '点赞在 %s 阶段仍可通过 %s 关闭，不重复发送或被迟到结果重新打开',
  async (phase, method) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (phase === 'request') {
      state.write.mockImplementationOnce(async () => {
        await pending;
        return { state: 'accepted' };
      });
    } else {
      state.read.mockImplementationOnce(async () => {
        await pending;
        return { likeCount: 101 };
      });
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    cleanup = () => {
      act(() => root.unmount());
      host.remove();
    };
    const button = (label: string) =>
      document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    try {
      act(() =>
        root.render(h(ProfileLikeAction, { uid: 'u_peer', uin: '10002', name: '合成好友' })),
      );
      act(() => button('赞资料卡').click());
      await act(async () => button('点赞 +1').click());
      expect(state.write).toHaveBeenCalledOnce();
      expect(state.read).toHaveBeenCalledTimes(phase === 'readback' ? 1 : 0);
      expect(button('点赞 +1').disabled).toBe(true);
      act(() => button('点赞 +1').click());
      act(() => {
        if (method === 'button') button('关闭资料卡点赞').click();
        else if (method === 'escape') {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        } else {
          document
            .querySelector('.weq-dialog-layer')!
            .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
      });
      expect(document.querySelector('.weq-profile-like-dialog')).toBeNull();
    } finally {
      await act(async () => release());
    }
    expect(state.write).toHaveBeenCalledOnce();
    expect(document.querySelector('.weq-profile-like-dialog')).toBeNull();
  },
);
