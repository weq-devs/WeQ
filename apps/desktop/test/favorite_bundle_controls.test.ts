import { act, createElement as h, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FavoriteBundleControls } from '../src/renderer/src/components/qq-actions/FavoriteBundleControls';

const binding = vi.hoisted(() => ({
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'source-a',
}));
const state = vi.hoisted(() => ({
  pick: vi.fn(),
  mutate: vi.fn(async (_input: unknown) => ({ state: 'accepted', emojiId: 'added-emoji' })),
  rows: vi.fn(async () => [] as Array<{ emojiId: string }>),
  invalidate: vi.fn(async () => {}),
  verified: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      qqActions: { favorites: { query: state.rows }, favorite: { mutate: state.mutate } },
    },
  },
  trpc: {
    useUtils: () => ({ account: { qqActions: { favorites: { invalidate: state.invalidate } } } }),
  },
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  withQQAccountScope: (component: unknown) => component,
  useQQAction: () => ({
    binding,
    available: true,
    pending: false,
    disabled: false,
    pickImage: state.pick,
    perform: async (
      run: (binding: unknown) => Promise<unknown>,
      refresh: () => Promise<void>,
      _warning: unknown,
      options: { readback: () => Promise<boolean> },
    ) => {
      await run(binding);
      state.verified(await options.readback());
      await refresh();
    },
  }),
  ActionIcon: (props: { label: string; disabled: boolean; onClick: () => void }) =>
    h(
      'button',
      {
        'aria-label': props.label,
        disabled: props.disabled,
        onClick: props.onClick,
        'data-binding': JSON.stringify(binding),
      },
      props.label,
    ),
}));
vi.mock('../src/renderer/src/components/qq-actions/FavoriteBundleImport', () => ({
  FavoriteBundleImport: (props: {
    binding: unknown;
    onBusyChange: (busy: boolean) => void;
    onChanged: () => Promise<void>;
  }) => {
    useEffect(() => props.onBusyChange(false), [props.onBusyChange]);
    return h(
      'button',
      {
        type: 'button',
        onClick: () => {
          props.onBusyChange(true);
          void props.onChanged();
        },
        'data-binding': JSON.stringify(props.binding),
      },
      '导入收藏表情包',
    );
  },
}));
vi.mock('../src/renderer/src/components/qq-actions/FavoriteBundleExport', () => ({
  FavoriteBundleExport: (props: { binding: unknown; disabled: boolean }) =>
    h(
      'button',
      { type: 'button', disabled: props.disabled, 'data-binding': JSON.stringify(props.binding) },
      '导出收藏表情包',
    ),
}));
afterEach(() => vi.unstubAllGlobals());

it('选择器入口使用同一账号绑定，导入开始后禁用并行导出并刷新收藏', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const changed = vi.fn(async () => {});
  try {
    act(() => root.render(h(FavoriteBundleControls, { onChanged: changed })));
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.dataset.binding === JSON.stringify(binding))).toBe(
      true,
    );
    expect(buttons[2]!.disabled).toBe(false);
    await act(async () => buttons[1]!.click());
    expect(changed).toHaveBeenCalledOnce();
    expect(buttons[2]!.disabled).toBe(true);
    expect(buttons[0]!.disabled).toBe(true);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('选择器可直接导入图片，取消选择不提交，成功后刷新管理列表及选择器', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const changed = vi.fn(async () => {});
  state.mutate.mockClear();
  state.invalidate.mockClear();
  state.verified.mockClear();
  try {
    act(() => root.render(h(FavoriteBundleControls, { onChanged: changed })));
    const button = host.querySelector<HTMLButtonElement>('[aria-label="导入图片到收藏表情"]')!;
    state.pick.mockResolvedValueOnce(null);
    await act(async () => button.click());
    expect(state.mutate).not.toHaveBeenCalled();
    state.pick.mockResolvedValueOnce({ path: '/synthetic/emoji.gif', fileName: 'emoji.gif' });
    state.rows.mockResolvedValueOnce([{ emojiId: 'unrelated-new-emoji' }]);
    await act(async () => button.click());
    expect(state.mutate).toHaveBeenCalledWith({
      ...binding,
      action: 'add',
      path: '/synthetic/emoji.gif',
    });
    expect(state.invalidate).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
    expect(state.verified).toHaveBeenLastCalledWith(false);
    state.pick.mockResolvedValueOnce({ path: '/synthetic/emoji.gif', fileName: 'emoji.gif' });
    state.rows.mockResolvedValueOnce([{ emojiId: 'added-emoji' }]);
    await act(async () => button.click());
    expect(state.verified).toHaveBeenLastCalledWith(true);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
