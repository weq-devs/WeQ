import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EnhancementUpdateNotice } from '../src/shared/enhancement_release';
import type { EnhancementStateChange } from '../src/main/enhancements/updates';
import { useEnhancementUpdates } from '../src/renderer/src/hooks/useEnhancementUpdates';
import { useDialog } from '../src/renderer/src/components/Dialog.shared';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import { onOpenSettingsRequest } from '../src/renderer/src/lib/callSettingsBridge';
import { useUpdateStore } from '../src/renderer/src/state/update';
const fixture = vi.hoisted(() => ({
  emit: null as ((notices: EnhancementUpdateNotice[]) => void) | null,
  emitState: null as ((change: EnhancementStateChange) => void) | null,
  refetch: vi.fn(async () => {}),
  acknowledge: vi.fn(async () => true),
  unsubscribe: vi.fn(),
  packs: undefined as
    | {
        preferences?: { autoCheck: boolean };
        packs: Array<{
          id: string;
          installed: boolean;
          installedVersion: string;
          ready: boolean;
          busy: boolean;
          updateAvailable: boolean;
          updateNeedsAttention?: boolean;
          autoUpdate?: boolean;
        }>;
      }
    | undefined,
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const query = { invalidate: async () => {} };
  const utils = {
    bootstrap: {
      enhancementPacks: { cancel: async () => {}, invalidate: fixture.refetch },
      localModelResources: query,
      getLocalEngine: query,
    },
    settings: { intent: { getStatus: query } },
    account: { intentSense: { getStatus: query }, dressup: { getState: query } },
  };
  return {
    trpc: {
      useUtils: () => utils,
      bootstrap: { enhancementPacks: { useQuery: () => ({ data: fixture.packs }) } },
    },
    client: {
      bootstrap: {
        onEnhancementStateChanged: {
          subscribe: (_: unknown, handler: { onData: typeof fixture.emitState }) => {
            fixture.emitState = handler.onData;
            return { unsubscribe() {} };
          },
        },
        onEnhancementUpdates: {
          subscribe: (_: unknown, handler: { onData: typeof fixture.emit }) => {
            fixture.emit = handler.onData;
            return { unsubscribe: fixture.unsubscribe };
          },
        },
        acknowledgeEnhancementUpdates: { mutate: fixture.acknowledge },
      },
    },
  };
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  useUpdateStore.setState({ packsAvailable: false });
});
afterEach(() => {
  useDialog.getState().close();
  fixture.emit = null;
  fixture.emitState = null;
  fixture.refetch.mockReset();
  fixture.packs = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function mount(refresh?: (render: () => void) => void) {
  const host = document.createElement('div');
  const root = createRoot(host);
  function Notifier() {
    useEnhancementUpdates();
    return null;
  }
  const render = () => act(() => root.render(h(Notifier)));
  render();
  refresh?.(render);
  return () => act(() => root.unmount());
}
const notices: EnhancementUpdateNotice[] = [
  { id: 'text', name: '本地文字识别', contentVersion: 'a'.repeat(64) },
  { id: 'voice', name: '本地语音转写', contentVersion: 'b'.repeat(64) },
];
const listedNames = (toast: NonNullable<ReturnType<typeof useToast.getState>['toasts'][number]>) =>
  Reflect.get(toast, 'summary') ?? toast.detail;
it('多个更新合并一条受控横幅，不再额外弹确认框，前往增强包仍使用原入口', () => {
  const open = vi.fn();
  const stop = onOpenSettingsRequest(open);
  const unmount = mount();
  try {
    act(() => fixture.emit?.(notices));
    const toast = useToast.getState().toasts[0]!;
    expect(toast.event).toBe('update');
    expect(toast.title).toBe('增强包有可用更新');
    expect(listedNames(toast)).toContain('本地文字识别');
    expect(listedNames(toast)).toContain('本地语音转写');
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
    expect(listedNames(toast)).toContain('本地文字识别');
    expect(listedNames(toast)).toContain('本地语音转写');
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
it('安装确认前保留增强包提醒，安装一部分只移除对应项', () => {
  let render!: () => void;
  const unmount = mount((refresh) => {
    render = refresh;
  });
  const first = notices[0]!;
  const second = notices[1]!;
  const pack = (notice: EnhancementUpdateNotice, installedVersion: string, busy = false) => ({
    id: notice.id,
    installed: true,
    installedVersion,
    busy,
    ready: !busy,
    updateAvailable: installedVersion !== notice.contentVersion,
  });
  try {
    act(() => fixture.emit?.(notices));
    const [item] = useToast.getState().toasts;
    fixture.packs = { packs: [pack(first, first.contentVersion, true)] };
    render();
    expect(listedNames(useToast.getState().toasts[0]!)).toContain(first.name);
    fixture.packs = {
      preferences: { autoCheck: true },
      packs: [
        { ...pack(first, 'legacy', true), autoUpdate: true, updateNeedsAttention: false },
        { ...pack(second, 'legacy'), updateNeedsAttention: true },
      ],
    };
    render();
    expect(listedNames(useToast.getState().toasts[0]!)).toBe(second.name);
    expect(useUpdateStore.getState().packsAvailable).toBe(true);
    fixture.packs = { packs: [pack(first, first.contentVersion), pack(second, 'legacy')] };
    render();
    expect(useToast.getState().leaving).toEqual([]);
    expect(listedNames(useToast.getState().toasts[0]!)).toBe(second.name);
    fixture.packs = {
      packs: [pack(first, first.contentVersion), pack(second, second.contentVersion)],
    };
    render();
    expect(useToast.getState().leaving).toEqual([item!.id]);
    expect(useUpdateStore.getState().packsAvailable).toBe(false);
  } finally {
    unmount();
  }
});

it('其他端安装完成不需要新的更新通知，刷新后收起红点和旧横幅', async () => {
  const notice = notices[0]!;
  const initial = {
    id: notice.id,
    installed: true,
    installedVersion: 'legacy',
    ready: true,
    busy: false,
    updateAvailable: true,
    updateNeedsAttention: true,
  };
  fixture.packs = { packs: [initial] };
  let render!: () => void;
  const unmount = mount((refresh) => {
    render = refresh;
  });
  try {
    act(() => fixture.emit?.([notice]));
    act(() => fixture.emit?.([]));
    const [item] = useToast.getState().toasts;
    expect(useUpdateStore.getState().packsAvailable).toBe(true);
    fixture.refetch.mockImplementation(async () => {
      fixture.packs = {
        packs: [
          {
            ...initial,
            installedVersion: notice.contentVersion,
            updateAvailable: false,
            updateNeedsAttention: false,
          },
        ],
      };
      render();
    });
    await act(async () => fixture.emitState?.({ kind: 'resources', id: notice.id }));
    expect(useUpdateStore.getState().packsAvailable).toBe(false);
    expect(useToast.getState().leaving).toEqual([item!.id]);
  } finally {
    unmount();
  }
});
