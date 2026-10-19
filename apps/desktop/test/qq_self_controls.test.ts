import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelfQQControls } from '../src/renderer/src/components/settings/SelfQQControls';
import type { QQWriteBinding, QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';
import { TitleBar } from '../src/renderer/src/im-template/template/TitleBar';
import type { User } from '../src/renderer/src/im-template/template/types';

vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => h('div', { role: 'dialog' }, children),
  useDialog: (selector: (s: { confirm: () => Promise<boolean> }) => unknown) =>
    selector({ confirm: async () => true }),
}));

const state = vi.hoisted(() => ({
  configId: 'source-a',
  profilePresent: true,
  mutate: vi.fn(async (_input: unknown) => ({ state: 'accepted' as const })),
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: state.configId },
    available: true,
    busy: false,
    result: null,
    run: async (action: (binding: QQWriteBinding) => Promise<QQWriteOutcome>) => {
      await action({ expectedAccountUin: '10001', expectedAccountConfigId: state.configId });
      return true;
    },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: { qqWrite: { onlineStatus: { mutate: (input: unknown) => state.mutate(input) } } },
  },
  trpc: {
    account: {
      qqActions: {
        liveStatus: {
          useQuery: () => ({
            data: { status: 40, extStatus: 0 },
            isFetching: false,
            refetch: async () => ({ error: null }),
          }),
        },
        extendedStatuses: {
          useQuery: () => ({ data: [{ value: 1018, label: '学习中' }], isFetching: false }),
        },
      },
      qqWrite: {
        selfState: {
          useQuery: () => ({
            data: {
              profile: state.profilePresent
                ? {
                    uid: 'u_self',
                    uin: '10001',
                    nick: '原昵称',
                    signature: '原签名',
                    gender: 2,
                  }
                : null,
              status: { type: 10, subType: 0 },
              statusOptions: [{ value: 10, label: '在线' }],
            },
            isLoading: false,
            isFetching: false,
            refetch: async () => ({ error: null }),
          }),
        },
        selfProfile: { useMutation: () => ({ mutateAsync: state.mutate }) },
        selfAvatar: { useMutation: () => ({ mutateAsync: state.mutate }) },
        onlineStatus: { useMutation: () => ({ mutateAsync: state.mutate }) },
      },
      pickSendFile: { useMutation: () => ({ mutateAsync: async () => null }) },
      getSystemFaces: {
        useQuery: () => ({
          data: [
            { id: 0, desc: '[微笑]', emojiType: 1, unicodeId: 0 },
            { id: 14, desc: '[呲牙]', emojiType: 1, unicodeId: 128512 },
            { id: 99, desc: '[动态]', emojiType: 3, unicodeId: 0 },
          ],
        }),
      },
    },
  },
}));

const cleanup: Array<() => void> = [];
function fixture(titleBar = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const user: User = {
    id: 'self',
    identityLabel: 'QQ',
    identityValue: '10001',
    username: '自己',
    displayName: '自己',
    avatarUrl: null,
  };
  const render = () =>
    act(() => root.render(titleBar ? h(TitleBar, { user: { ...user } }) : h(SelfQQControls)));
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  render();
  return { host, render, user };
}
function input(host: HTMLElement, name: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.configId = 'source-a';
  state.profilePresent = true;
  state.mutate.mockClear();
});
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.unstubAllGlobals();
});

describe('个人资料编辑入口', () => {
  it('预设扩展状态使用 status=10 和对应 extStatus，查询服务端状态不发写请求', async () => {
    const f = fixture();
    const select = f.host.querySelector<HTMLSelectElement>('[aria-label="扩展在线状态"]')!;
    act(() => {
      select.value = '1018';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存扩展在线状态"]')!.click(),
    );
    expect(state.mutate).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      status: 10,
      extStatus: 1018,
    });
    state.mutate.mockClear();
    act(() =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="查询服务端在线状态"]')!.click(),
    );
    expect(f.host.textContent).toContain('隐身');
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('标题栏头像打开真实资料编辑器，关闭后重新打开不保留草稿', async () => {
    const f = fixture(true);
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    const open = () =>
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="编辑 QQ 资料"]')!.click());
    open();
    input(f.host, 'QQ 昵称', '从标题栏修改');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存QQ 昵称"]')!.click(),
    );
    expect(state.mutate).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      patch: { nickname: '从标题栏修改' },
    });
    input(f.host, 'QQ 昵称', '关闭时丢弃的草稿');
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="关闭资料编辑"]')!.click());
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    open();
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="QQ 昵称"]')!.value).toBe('原昵称');
    f.user.identityValue = '10002';
    f.render();
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
  });
  it('修改昵称只提交昵称，不带旧签名和性别', async () => {
    const f = fixture();
    input(f.host, 'QQ 昵称', '新昵称');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存QQ 昵称"]')!.click(),
    );
    expect(state.mutate).toHaveBeenCalledOnce();
    expect(state.mutate).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      patch: { nickname: '新昵称' },
    });
  });
  it('状态表情使用本机目录的 QSid，并保留 0 号表情', async () => {
    const f = fixture();
    input(f.host, '自定义状态文字', '测试状态');
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="状态表情"]')!.click());
    expect(f.host.querySelector('[title="[动态]"]')).toBeNull();
    act(() => f.host.querySelector<HTMLButtonElement>('button[title="[微笑]"]')!.click());
    expect(f.host.querySelector('[aria-label="状态表情"] img')?.getAttribute('src')).toContain(
      '/0/apng/0.png',
    );
    expect(f.host.querySelector('.weq-face-picker')).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="状态表情"]')!.click());
    expect(f.host.querySelector('button[title="[微笑]"][aria-pressed="true"]')).not.toBeNull();
    act(() =>
      f.host
        .querySelector('[aria-label="搜索表情"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(f.host.querySelector('.weq-face-picker')).toBeNull();
    expect(document.activeElement).toBe(f.host.querySelector('[aria-label="状态表情"]'));
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存自定义状态"]')!.click(),
    );
    expect(state.mutate).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      status: 10,
      extStatus: 2000,
      custom: { faceId: 0, faceType: 1, wording: '测试状态' },
    });
  });
  it('状态选择器可搜索图片表情，提交 QSid 而非 Unicode 编号', async () => {
    const f = fixture();
    input(f.host, '自定义状态文字', '新的状态');
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="状态表情"]')!.click());
    input(f.host, '搜索表情', '呲牙');
    expect(f.host.querySelectorAll('.weq-face-cell')).toHaveLength(1);
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-face-cell')!.click());
    expect(f.host.querySelector('[aria-label="状态表情"] img')?.getAttribute('src')).toContain(
      '/14/apng/14.png',
    );
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存自定义状态"]')!.click(),
    );
    expect(state.mutate).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      status: 10,
      extStatus: 2000,
      custom: { faceId: 14, faceType: 1, wording: '新的状态' },
    });
  });
  it('同号切换数据源不携带上一个现场的未提交状态', () => {
    const f = fixture();
    input(f.host, '自定义状态文字', '不能串到下一数据源');
    state.configId = 'source-b';
    f.render();
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="自定义状态文字"]')!.value).toBe('');
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it('资料缓存未填充时仍可明确修改昵称或清空签名', async () => {
    state.profilePresent = false;
    const f = fixture();
    input(f.host, 'QQ 昵称', '首次设置昵称');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存QQ 昵称"]')!.click(),
    );
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="清空个性签名"]')!.click(),
    );
    expect(state.mutate).toHaveBeenNthCalledWith(1, {
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      patch: { nickname: '首次设置昵称' },
    });
    expect(state.mutate).toHaveBeenNthCalledWith(2, {
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      patch: { signature: '' },
    });
  });
});
