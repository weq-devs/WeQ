import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactProfileDialog } from '../src/renderer/src/im-template/template/profilePanes';
import type { Contact } from '../src/renderer/src/im-template/template/types';

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      dressup: { peerStats: { useQuery: () => ({ data: undefined, isLoading: false }) } },
      mutualMark: {
        get: {
          useQuery: () => ({
            isLoading: false,
            data: {
              categories: [
                {
                  id: 'fixture',
                  name: '合成标识',
                  marks: [
                    {
                      id: 'fixture',
                      name: '测试标识',
                      intro: '',
                      level: 1,
                      levels: [{ level: 1, name: '测试等级', threshold: 1, desc: '测试条件' }],
                      iconUrl: '',
                      iconFormat: '',
                    },
                  ],
                },
              ],
            },
          }),
        },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/PersonalityHomeDialog', () => ({
  PersonalityHomeDialog: () => null,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('好友资料、互动标识和等级三层依次在入口旁展开，Escape 只关闭等级', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(120, 120, 240, 120),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  const contact: Contact = {
    id: 'fixture',
    identityLabel: 'QQ',
    identityValue: '10001',
    username: 'fixture',
    displayName: '合成好友',
    createdAt: new Date(0).toISOString(),
  };
  try {
    act(() => root.render(h(ContactProfileDialog, { contact, onClose: close })));
    const open = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('查看互动标识'),
    )!;
    act(() => open.click());
    act(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="查看 测试标识 的全部等级"]')!.click(),
    );
    const layers = ['好友资料', '合成好友 的互动标识', '测试标识 的等级'].map(
      (name) =>
        document
          .querySelector(`[aria-label="${name}"]`)!
          .closest<HTMLElement>('.weq-overlay-layer')!,
    );
    expect(Number(layers[1]!.style.zIndex)).toBeGreaterThan(Number(layers[0]!.style.zIndex));
    expect(Number(layers[2]!.style.zIndex)).toBeGreaterThan(Number(layers[1]!.style.zIndex));
    expect(layers[1]!.classList.contains('is-anchored-popover')).toBe(true);
    expect(layers[2]!.classList.contains('is-anchored-popover')).toBe(true);
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    expect(document.querySelector('[aria-label="测试标识 的等级"]')).toBeNull();
    expect(document.querySelector('[aria-label="合成好友 的互动标识"]')).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
