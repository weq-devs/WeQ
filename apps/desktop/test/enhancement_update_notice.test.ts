import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { EnhancementUpdateNotice } from '../src/shared/enhancement_release';
import { useEnhancementUpdates } from '../src/renderer/src/hooks/useEnhancementUpdates';
import { useDialog } from '../src/renderer/src/components/Dialog';
import { onOpenSettingsRequest } from '../src/renderer/src/lib/callSettingsBridge';

const fixture = vi.hoisted(() => ({
  emit: null as ((notices: EnhancementUpdateNotice[]) => void) | null,
  acknowledge: vi.fn(async () => true),
  unsubscribe: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: {
      onEnhancementUpdates: {
        subscribe: (_: unknown, handler: { onData: typeof fixture.emit }) => {
          fixture.emit = handler.onData;
          return { unsubscribe: fixture.unsubscribe };
        },
      },
      acknowledgeEnhancementUpdates: { mutate: fixture.acknowledge },
    },
  },
}));

afterEach(() => {
  useDialog.getState().close();
  fixture.emit = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  function Notifier() {
    useEnhancementUpdates();
    return null;
  }
  act(() => root.render(h(Notifier)));
  return () => act(() => root.unmount());
}
const notices: EnhancementUpdateNotice[] = [
  { id: 'text', name: '本地文字识别', contentVersion: 'a'.repeat(64) },
  { id: 'voice', name: '本地语音转写', contentVersion: 'b'.repeat(64) },
];

it('多个更新合并一张弹窗，前往增强包通过共用设置入口跳转', async () => {
  const open = vi.fn();
  const stop = onOpenSettingsRequest(open);
  const unmount = mount();
  try {
    act(() => fixture.emit?.(notices));
    const dialog = useDialog.getState().current!;
    expect(dialog.title).toBe('增强包有可用更新');
    const content = renderToStaticMarkup(h('div', null, dialog.message));
    expect(content).toContain('本地文字识别');
    expect(content).toContain('本地语音转写');
    expect(fixture.acknowledge).toHaveBeenCalledOnce();
    expect(fixture.acknowledge).toHaveBeenCalledWith(
      notices.map(({ id, contentVersion }) => ({ id, contentVersion })),
    );
    await act(async () => {
      dialog.confirm?.resolve(true);
      useDialog.getState().close();
    });
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith('enhancementPacks');
    act(() => fixture.emit?.([...notices]));
    expect(useDialog.getState().current).toBeNull();
  } finally {
    unmount();
    stop();
  }
  expect(fixture.unsubscribe).toHaveBeenCalledOnce();
});

it('提醒仍打开时新发现的更新并入原弹窗，不再弹第二张', async () => {
  const unmount = mount();
  try {
    act(() => fixture.emit?.([notices[0]!]));
    const id = useDialog.getState().current!.id;
    act(() => fixture.emit?.([notices[1]!]));
    const dialog = useDialog.getState().current!;
    expect(dialog.id).toBe(id);
    const content = renderToStaticMarkup(h('div', null, dialog.message));
    expect(content).toContain('本地文字识别');
    expect(content).toContain('本地语音转写');
    await act(async () => useDialog.getState().close());
    expect(useDialog.getState().current).toBeNull();
  } finally {
    unmount();
  }
});

it('不打断已有确认框，等待期间到达的多个更新合并提醒，稍后不跳转', async () => {
  const pending = useDialog.getState().confirm('保留当前确认', '正在操作');
  const original = useDialog.getState().current!;
  const open = vi.fn();
  const stop = onOpenSettingsRequest(open);
  const unmount = mount();
  try {
    act(() => fixture.emit?.([notices[0]!]));
    act(() => fixture.emit?.(notices));
    expect(useDialog.getState().current).toBe(original);
    expect(fixture.acknowledge).not.toHaveBeenCalled();
    await act(async () => {
      useDialog.getState().close();
      await pending;
    });
    expect(fixture.acknowledge).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(h('div', null, useDialog.getState().current?.message))).toContain(
      '本地语音转写',
    );
    await act(async () => useDialog.getState().close());
    expect(open).not.toHaveBeenCalled();
    act(() => fixture.emit?.(notices));
    expect(useDialog.getState().current).toBeNull();
    act(() => fixture.emit?.([{ ...notices[0]!, contentVersion: 'c'.repeat(64) }]));
    expect(useDialog.getState().current?.title).toBe('增强包有可用更新');
  } finally {
    unmount();
    stop();
  }
});
