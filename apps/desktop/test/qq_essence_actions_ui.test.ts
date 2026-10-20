import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QQMessageEssenceAction } from '../src/renderer/src/components/QQMessageEssenceAction';
import {
  GroupEssenceDialog,
  type GroupEssenceWire,
} from '../src/renderer/src/components/GroupEssenceDialog';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { useViewState } from '../src/renderer/src/state/view';
import { useQQEssence } from '../src/renderer/src/state/qqEssence';
import type { QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';

const state = vi.hoisted(() => ({
  configId: 'source-a',
  online: true,
  canManage: true,
  mutate: vi.fn(async (_input: unknown): Promise<QQWriteOutcome> => ({ state: 'accepted' })),
  invalidate: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: new Proxy({}, { get: () => ({ invalidate: state.invalidate }) }) }),
    account: {
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: state.configId } }) },
      getGroupAlbumAccessState: {
        useQuery: () => ({
          data: {
            qqOnline: state.online,
            attachEnabled: true,
            hasA2: true,
            hasD2: true,
            hasD2Key: true,
            hasGuid: true,
          },
        }),
      },
      qqActions: {
        groupPermissions: { useQuery: () => ({ data: { canManage: state.canManage } }) },
      },
      qqWrite: { groupEssence: { useMutation: () => ({ mutateAsync: state.mutate }) } },
    },
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.configId = 'source-a';
  state.online = true;
  state.canManage = true;
  state.mutate.mockReset().mockResolvedValue({ state: 'accepted' });
  state.invalidate.mockClear();
  useViewState.setState({ openedUin: '10001' });
  useQQEssence.setState({ receipts: {} });
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  useQQEssence.setState({ receipts: {} });
  useViewState.setState({ openedUin: null });
  vi.unstubAllGlobals();
});
function fixture(active = true, overrides: Partial<GroupEssenceWire> = {}) {
  const demo = createTemplateDemoData();
  const original = demo.conversations.find((row) => row.type === 'group')!;
  const conversation = {
    ...original,
    id: '123',
    group: { ...original.group, role: 'owner' as const, essenceSeqs: active ? ['42'] : [] },
  };
  const message = {
    ...demo.messages[0]!,
    id: 'essence-message',
    conversationId: '123',
    msgSeq: '42',
    msgRandom: '77',
  };
  const rows: GroupEssenceWire[] = active
    ? [
        {
          id: 'entry',
          msgSeq: 42,
          msgRandom: 77,
          senderName: '合成成员',
          operatorName: '',
          createdAt: '2026-10-20T00:00:00Z',
          active: true,
          content: [{ type: 1, text: '精华正文' }],
          ...overrides,
        },
      ]
    : [];
  const close = vi.fn(),
    jump = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(
        h(
          'main',
          null,
          h(
            'div',
            { className: 'menu' },
            h(QQMessageEssenceAction, { conversation, message, onClose: close }),
          ),
          h(GroupEssenceDialog, {
            groupCode: '123',
            groupName: '合成群',
            essenceMessages: rows,
            onClose: close,
            onJumpToMessage: jump,
          }),
        ),
      ),
    );
  render();
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const menu = () => host.querySelector<HTMLButtonElement>('.menu button')!;
  const remove = () => host.querySelector<HTMLButtonElement>('.weq-essence-remove')!;
  return { host, render, close, jump, menu, remove };
}
describe('消息菜单与精华列表的同步', () => {
  it.each(['menu', 'list'] as const)(
    '%s 取消受理后共同更新，不被旧读取结果重新插回',
    async (entry) => {
      const f = fixture();
      await act(async () => (entry === 'menu' ? f.menu() : f.remove()).click());
      expect(state.mutate).toHaveBeenCalledWith({
        expectedAccountUin: '10001',
        expectedAccountConfigId: 'source-a',
        groupId: 123,
        sequence: 42,
        random: 77,
        enable: false,
      });
      expect(f.menu().textContent).toBe('设为精华');
      expect(f.host.querySelector('.group-essence-item')).toBeNull();
      expect(f.host.textContent).toContain('精华操作已受理，等待 QQ 同步');
      expect(f.jump).not.toHaveBeenCalled();
      f.render();
      expect(f.host.querySelector('.group-essence-item')).toBeNull();
    },
  );
  it('新增精华受理后列表显示待同步记录，保留原始 random', async () => {
    const f = fixture(false);
    await act(async () => f.menu().click());
    expect(f.menu().textContent).toBe('取消精华');
    expect(f.host.querySelector('.group-essence-item')?.textContent).toContain('消息 42');
    await act(async () => f.remove().click());
    expect(state.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ sequence: 42, random: 77, enable: false }),
    );
  });
  it('列表与菜单共用在途锁，连续点击不重复提交', async () => {
    const f = fixture();
    let finish!: (value: QQWriteOutcome) => void;
    state.mutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => f.remove().click());
    expect(f.menu().disabled).toBe(true);
    expect(f.remove().disabled).toBe(true);
    act(() => f.menu().click());
    expect(state.mutate).toHaveBeenCalledOnce();
    await act(async () => finish({ state: 'accepted' }));
  });
  it.each(['error', 'unconfirmed'] as const)(
    '%s 不翻转或丢掉原记录，也不自动重试',
    async (kind) => {
      const f = fixture();
      if (kind === 'error') state.mutate.mockRejectedValueOnce(new Error('合成拒绝'));
      else state.mutate.mockResolvedValueOnce({ state: 'unconfirmed' });
      await act(async () => f.remove().click());
      expect(f.menu().textContent).toBe('取消精华');
      expect(f.host.querySelector('.group-essence-item')).not.toBeNull();
      expect(f.host.textContent).toContain(kind === 'error' ? '合成拒绝' : '结果未确认');
      expect(state.mutate).toHaveBeenCalledOnce();
      expect(f.close).not.toHaveBeenCalled();
    },
  );
  it('同号切换配置时迟到回执不修改新现场', async () => {
    const f = fixture();
    let finish!: (value: QQWriteOutcome) => void;
    state.mutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => f.menu().click());
    state.configId = 'source-b';
    f.render();
    await act(async () => finish({ state: 'accepted' }));
    expect(f.menu().textContent).toBe('取消精华');
    expect(f.host.querySelector('.group-essence-item')).not.toBeNull();
    expect(Object.values(useQQEssence.getState().receipts)).toHaveLength(0);
  });
  it('缺 random、服务端不允许或离线时不发请求；跳转动作独立', async () => {
    const f = fixture(true, { msgRandom: undefined });
    expect(f.remove().disabled).toBe(true);
    expect(f.remove().title).toContain('random');
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-essence-jump')!.click());
    expect(f.jump).toHaveBeenCalledWith(42);
    expect(state.mutate).not.toHaveBeenCalled();
    const denied = fixture(true, { canRemove: false });
    expect(denied.remove().disabled).toBe(true);
    state.online = false;
    denied.render();
    expect(denied.menu().disabled).toBe(true);
  });
});
