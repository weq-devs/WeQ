import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { generatedMuteKey } from '@weq/service/client-preferences';
import type { GeneratedReply } from '../src/shared/generated_reply';
import { useGeneratedReplyNotifications } from '../src/renderer/src/hooks/useGeneratedReplyNotifications';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import {
  openNotificationSource,
  onNotificationNavigation,
} from '../src/renderer/src/lib/notificationNavigation.shared';

const fixture = vi.hoisted(() => ({
  binding: { expectedAccountUin: 'synthetic', expectedAccountConfigId: 'source' },
  onData: undefined as ((reply: GeneratedReply) => void) | undefined,
  invalidate: vi.fn(),
  publish: vi.fn(),
  banner: true,
  system: true,
  private: false,
  muted: false,
  reads: {} as Record<string, string>,
}));

vi.mock('../src/renderer/src/lib/clientPreferences', () => ({
  accountBinding: () => fixture.binding,
  preferenceValue: (key: string) => key === 'privacyMode' && fixture.private,
  sharedAccountRecords: (type: string) =>
    type === 'reads' ? fixture.reads : { [generatedMuteKey('virtual:group:g')]: fixture.muted },
  useAccountRecords: () => fixture.reads,
}));
vi.mock('../src/renderer/src/lib/notificationPolicy', () => ({
  notificationEnabled: (_event: string, channel: 'system' | 'banner') => fixture[channel],
  publishNotificationSystem: fixture.publish,
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const utils = { account: { listAgentLabGroups: { invalidate: fixture.invalidate } } };
  return {
    trpc: { useUtils: () => utils },
    client: {
      account: {
        onGeneratedReply: {
          subscribe: (_binding: unknown, handler: { onData: typeof fixture.onData }) => {
            fixture.onData = handler.onData;
            return {
              unsubscribe: () => {
                fixture.onData = undefined;
              },
            };
          },
        },
      },
    },
  };
});

afterEach(() => {
  fixture.binding.expectedAccountConfigId = 'source';
  fixture.banner = true;
  fixture.private = false;
  fixture.reads = {};
  fixture.invalidate.mockClear();
  fixture.publish.mockClear();
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('同步到相同会话的实际回复位置后才收起；迟到已读回复不再弹横幅', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  function Probe() {
    useGeneratedReplyNotifications('synthetic', 'source');
    return null;
  }
  const reply: GeneratedReply = {
    kind: 'group',
    conversationId: 'g',
    id: 'read-1',
    title: '克隆群',
    preview: '新回复',
    ts: 200,
  };
  try {
    act(() => root.render(h(Probe)));
    fixture.onData?.(reply);
    const [item] = useToast.getState().toasts;
    expect(item).toBeDefined();
    fixture.reads = { 'clone-group:g': '199', 'assistant:g': '400', 'clone-group:other': '400' };
    act(() => root.render(h(Probe)));
    expect(useToast.getState().leaving).toEqual([]);
    fixture.reads = { 'clone-group:g': '200' };
    act(() => root.render(h(Probe)));
    expect(useToast.getState().leaving).toEqual([item!.id]);
    fixture.onData?.({ ...reply, ts: 120, id: 'read-delayed' });
    expect(useToast.getState().toasts).toHaveLength(1);
  } finally {
    act(() => root.unmount());
  }
});

it('新回复按渠道发送并带原消息目标，过滤正在阅读、重复事件和切号迟到结果', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(window, 'focus').mockImplementation(() => {});
  const root = createRoot(document.createElement('div'));
  const navigate = vi.fn();
  const off = onNotificationNavigation(navigate);
  function Harness({ reading }: { reading?: string }) {
    useGeneratedReplyNotifications('synthetic', 'source', reading);
    return null;
  }
  const reply: GeneratedReply = {
    kind: 'group',
    conversationId: 'g',
    id: 'run',
    title: '克隆群',
    preview: '成员：新回复',
    messageId: 'turn',
  };
  try {
    act(() => root.render(h(Harness, { reading: 'virtual:group:g' })));
    fixture.onData?.({ ...reply, id: 'while-reading' });
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(useToast.getState().toasts).toHaveLength(0);
    act(() => root.render(h(Harness)));
    fixture.onData?.(reply);
    fixture.onData?.(reply);
    const [toast] = useToast.getState().toasts;
    expect(useToast.getState().toasts).toHaveLength(1);
    expect(fixture.publish).toHaveBeenCalledTimes(1);
    openNotificationSource(toast!.source!);
    expect(navigate).toHaveBeenCalledWith({
      kind: 'generated-reply',
      conversationKind: 'group',
      conversationId: 'g',
      messageId: 'turn',
    });
    fixture.banner = false;
    fixture.private = true;
    fixture.onData?.({ ...reply, id: 'private' });
    expect(fixture.publish.mock.lastCall?.slice(0, 3)).toEqual([
      'assistantReply',
      'WeQ',
      '收到新回复',
    ]);
    expect(useToast.getState().toasts).toHaveLength(1);
    fixture.muted = true;
    fixture.onData?.({ ...reply, id: 'muted' });
    expect(fixture.publish).toHaveBeenCalledTimes(2);
    fixture.muted = false;
    fixture.binding.expectedAccountConfigId = 'new-source';
    fixture.onData?.({ ...reply, id: 'late' });
    expect(fixture.publish).toHaveBeenCalledTimes(2);
  } finally {
    off();
    act(() => root.unmount());
  }
});
