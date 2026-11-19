import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EnhancementUpdateNotice } from '../src/shared/enhancement_release';
import { useEnhancementUpdates } from '../src/renderer/src/hooks/useEnhancementUpdates';
import { useDialog } from '../src/renderer/src/components/Dialog.shared';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import { onOpenSettingsRequest } from '../src/renderer/src/lib/callSettingsBridge';
const fixture = vi.hoisted(() => ({
  emit: null as ((notices: EnhancementUpdateNotice[]) => void) | null,
  acknowledge: vi.fn(async () => true),
  unsubscribe: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ bootstrap: { enhancementPacks: { invalidate: async () => {} } } }),
    bootstrap: { enhancementPacks: { useQuery: () => ({ data: undefined }) } },
  },
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
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
});
afterEach(() => {
  useDialog.getState().close();
  fixture.emit = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
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
it('多个更新合并一条受控横幅，不再额外弹确认框，前往增强包仍使用原入口', () => {
  const open = vi.fn();
  const stop = onOpenSettingsRequest(open);
  const unmount = mount();
  try {
    act(() => fixture.emit?.(notices));
    const toast = useToast.getState().toasts[0]!;
    expect(toast.event).toBe('update');
    expect(toast.title).toBe('增强包有可用更新');
    expect(toast.detail).toContain('本地文字识别');
    expect(toast.detail).toContain('本地语音转写');
    expect(useDialog.getState().current).toBeNull();
    expect(fixture.acknowledge).toHaveBeenCalledOnce();
    toast.action!.run();
    expect(open).toHaveBeenCalledWith('enhancementPacks');
    act(() => fixture.emit?.([...notices]));
    expect(useToast.getState().toasts).toHaveLength(1);
    expect(fixture.acknowledge).toHaveBeenCalledOnce();
  } finally {
    unmount();
    stop();
  }
  expect(fixture.unsubscribe).toHaveBeenCalledOnce();
});
it('分批发现的更新原位合并，不丢失前一批名称，不产生多条横幅', () => {
  const unmount = mount();
  try {
    act(() => fixture.emit?.([notices[0]!]));
    const id = useToast.getState().toasts[0]!.id;
    act(() => fixture.emit?.([notices[1]!]));
    const toast = useToast.getState().toasts[0]!;
    expect(toast.id).toBe(id);
    expect(useToast.getState().toasts).toHaveLength(1);
    expect(toast.detail).toContain('本地文字识别');
    expect(toast.detail).toContain('本地语音转写');
  } finally {
    unmount();
  }
});
it('不替换正在操作的确认框，新内容版本仍可更新同一条通知', () => {
  void useDialog.getState().confirm('保留当前确认', '正在操作');
  const original = useDialog.getState().current;
  const unmount = mount();
  try {
    act(() => fixture.emit?.(notices));
    expect(useDialog.getState().current).toBe(original);
    expect(fixture.acknowledge).toHaveBeenCalledOnce();
    act(() => fixture.emit?.([{ ...notices[0]!, contentVersion: 'c'.repeat(64) }]));
    expect(fixture.acknowledge).toHaveBeenCalledTimes(2);
    expect(useToast.getState().toasts).toHaveLength(1);
  } finally {
    unmount();
  }
});
