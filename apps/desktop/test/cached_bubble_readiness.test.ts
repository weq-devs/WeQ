import { act, createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { BubbleSkin } from '@weq/service';
import { useMsgDecoration } from '../src/renderer/src/hooks/useMsgDecoration';

const state = vi.hoisted(() => ({
  local: undefined as { bubble: BubbleSkin | null } | undefined,
  remoteMiss: false,
  remoteEnabled: false,
  skin: {
    itemId: 21991,
    slice: { left: 4, right: 4, top: 4, bottom: 4 },
    imageSize: { w: 40, h: 40 },
    textColor: '#516196',
  },
}));
const skin = state.skin;
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      dressup: {
        resolveMsgDecoration: {
          useQuery: (
            ids: { bubbleId: number; localOnly?: boolean },
            options: { enabled: boolean },
          ) => {
            if (ids.localOnly) return { data: state.local, isError: false };
            if (ids.bubbleId) state.remoteEnabled = options.enabled;
            return { data: state.remoteMiss ? { bubble: null } : undefined };
          },
        },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/QqMessageContent', async () => {
  const { createContext } = await import('react');
  return { MsgDecorationEnabledContext: createContext({ bubble: true, font: true, widget: true }) };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([true, false])('本地气泡不闪默认，字体不阻塞，底图成功=%s', async (success) => {
  skin.itemId = success ? 21991 : 21992;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let decode: () => void = () => {};
  let fail: () => void = () => {};
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      naturalWidth = 40;
      naturalHeight = 40;
      removeAttribute() {
        this.src = '';
      }
      decode() {
        return new Promise<void>((resolve, reject) => {
          decode = resolve;
          fail = () => reject(new Error('损坏底图'));
        });
      }
    },
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  const commits: { bubbleId: number; bubblePending?: boolean }[] = [];
  function Message() {
    const result = useMsgDecoration({ bubbleId: skin.itemId, fontId: 31991, widgetId: 0 });
    useLayoutEffect(() => {
      commits.push(result);
    });
    return null;
  }
  state.local = undefined;
  state.remoteMiss = !success;
  try {
    await act(async () => root.render(createElement(Message)));
    expect(commits.at(-1)?.bubblePending).toBe(true);
    expect(state.remoteEnabled).toBe(false);
    state.local = { bubble: skin };
    await act(async () => root.render(createElement(Message)));
    expect(commits.at(-1)?.bubblePending).toBe(true);
    expect(state.remoteEnabled).toBe(false);
    await act(async () => (success ? decode() : fail()));
    expect(commits.at(-1)).toMatchObject({
      bubbleId: success ? skin.itemId : 0,
      bubblePending: false,
    });
    if (success)
      expect(
        commits.every((result) => result.bubbleId === skin.itemId || result.bubblePending),
      ).toBe(true);
    state.local = { bubble: null };
    await act(async () => root.render(createElement(Message)));
    expect(commits.at(-1)).toMatchObject({ bubbleId: 0, bubblePending: false });
    expect(state.remoteEnabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});
