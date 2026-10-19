import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { JoinGroupDialog } from '../src/renderer/src/components/JoinGroupDialog';

const mocks = vi.hoisted(() => ({ acknowledge: vi.fn(async () => {}) }));
vi.mock('../src/renderer/src/components/GroupJoinQr', () => ({ GroupJoinQr: () => null }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      getWelcomeAcknowledged: { useQuery: () => ({ data: true }) },
      getJoinGroupPromptAcknowledged: { useQuery: () => ({ data: false }) },
      acknowledgeJoinGroupPrompt: {
        useMutation: () => ({ mutateAsync: mocks.acknowledge, isLoading: false }),
      },
    },
    account: {
      getGroupJoinState: {
        useQuery: () => ({
          data: {
            inGroup: false,
            mode: 'browser',
            groupName: '合成群',
            groupCode: '10001',
            shareUrl: 'https://example.invalid',
          },
        }),
      },
      joinProjectGroup: { useMutation: () => ({ isLoading: false }) },
    },
  },
}));
let dispose = () => {};
afterEach(() => {
  dispose();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  dispose = () => {
    act(() => root.unmount());
    host.remove();
  };
  act(() => root.render(h(JoinGroupDialog)));
}
it('点外仅临时关闭，不写入永久不再提醒标记', () => {
  mount();
  act(() => {
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
    );
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  expect(document.querySelector('[aria-labelledby="weq-join-group-title"]')).toBeNull();
  expect(mocks.acknowledge).not.toHaveBeenCalled();
});
it('明确选择不再提醒才持久化标记', async () => {
  mount();
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '不再提醒')!
      .click(),
  );
  expect(mocks.acknowledge).toHaveBeenCalledOnce();
});
