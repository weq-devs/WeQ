import { act, createElement as h, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FavoriteBundleControls } from '../src/renderer/src/components/qq-actions/FavoriteBundleControls';

const binding = vi.hoisted(() => ({
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'source-a',
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  withQQAccountScope: (component: unknown) => component,
  useQQAction: () => ({ binding, available: true, pending: false, disabled: false }),
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
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.dataset.binding === JSON.stringify(binding))).toBe(
      true,
    );
    expect(buttons[1]!.disabled).toBe(false);
    await act(async () => buttons[0]!.click());
    expect(changed).toHaveBeenCalledOnce();
    expect(buttons[1]!.disabled).toBe(true);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
