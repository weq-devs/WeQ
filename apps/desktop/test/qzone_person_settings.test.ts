import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { QzoneSettingsSection } from '../src/renderer/src/components/settings/QzoneSettingsSection';

const state = vi.hoisted(() => ({
  action: 'space' as 'space' | 'profile',
  priority: 'remark' as 'remark' | 'nickname',
  save: vi.fn(),
  savePriority: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('../src/renderer/src/components/settings/QzonePaginationSettings', () => ({
  QzonePaginationSettings: () => null,
}));
vi.mock('../src/renderer/src/components/settings/QzonePublicRefreshSettings', () => ({
  QzonePublicRefreshSettings: () => null,
}));
vi.mock('../src/renderer/src/components/qq-actions/QzoneFriendPermissions', () => ({
  QzoneFriendPermissions: () => null,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      getSettings: {
        useQuery: () => ({
          data: { qzonePersonClickAction: state.action, qzoneNamePriority: state.priority },
          refetch: state.refetch,
        }),
      },
      setQzoneForwardQuotePrevious: { useMutation: () => ({}) },
      setQzoneNamePriority: {
        useMutation: (options: { onSuccess: () => Promise<void> }) => ({
          mutate: (input: { priority: 'remark' | 'nickname' }) => {
            state.savePriority(input);
            state.priority = input.priority;
            void options.onSuccess();
          },
        }),
      },
      setQzonePersonClickAction: {
        useMutation: (options: { onSuccess: () => void }) => ({
          mutate: (input: { action: 'space' | 'profile' }) => {
            state.save(input);
            state.action = input.action;
            options.onSuccess();
          },
        }),
      },
    },
  },
}));

it('人物入口用分段选择保存点击行为，并刷新共用设置查询', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(h(QzoneSettingsSection)));
    const group = host.querySelector('[role="radiogroup"][aria-label="点击他人昵称或头像时"]')!;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(buttons.map((button) => button.textContent)).toEqual(['显示名片', '进入对方空间']);
    expect(buttons[1]!.getAttribute('aria-checked')).toBe('true');
    act(() => buttons[0]!.click());
    expect(state.save).toHaveBeenLastCalledWith({ action: 'profile' });
    expect(state.refetch).toHaveBeenCalledOnce();
    act(() => root.render(h(QzoneSettingsSection)));
    expect(buttons[0]!.getAttribute('aria-checked')).toBe('true');
    act(() => buttons[1]!.click());
    expect(state.save).toHaveBeenLastCalledWith({ action: 'space' });
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

it('人物名称可切换为昵称优先并刷新共用设置', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(h(QzoneSettingsSection)));
    const group = host.querySelector('[role="radiogroup"][aria-label="人物名称显示"]')!;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(buttons[0]!.getAttribute('aria-checked')).toBe('true');
    act(() => buttons[1]!.click());
    expect(state.savePriority).toHaveBeenLastCalledWith({ priority: 'nickname' });
    expect(state.refetch).toHaveBeenCalledOnce();
    act(() => root.render(h(QzoneSettingsSection)));
    expect(buttons[1]!.getAttribute('aria-checked')).toBe('true');
  } finally {
    act(() => root.unmount());
    state.priority = 'remark';
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
