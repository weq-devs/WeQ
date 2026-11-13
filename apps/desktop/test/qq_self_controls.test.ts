import { act, Fragment, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelfProfileFixture as SelfQQControls } from './support/SelfProfileFixture';
import type { QQWriteBinding, QQWriteOutcome } from '../src/renderer/src/hooks/useQQWriteSession';
import { TitleBar } from '../src/renderer/src/im-template/template/TitleBar';
import type { User } from '../src/renderer/src/im-template/template/types';
import { ProfileNavigationContext } from '../src/renderer/src/lib/profileNavigation';
import SelfOnlineStatusEditor from '../src/renderer/src/components/SelfOnlineStatusEditor';

vi.mock('../src/renderer/src/components/settings/EditableSelfProfile', () => ({
  useEditableSelfProfileFields: () => ({ fields: {}, feedback: null }),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => h('div', { role: 'dialog' }, children),
  useDialog: (selector: (s: { confirm: () => Promise<boolean> }) => unknown) =>
    selector({ confirm: async () => true }),
}));

const state = vi.hoisted(() => ({
  configId: 'source-a',
  profilePresent: true,
  nick: '原昵称',
  statusError: null as string | null,
  status: {
    type: 10,
    subType: 0,
    customStatus: undefined as { faceId: number; text: string; faceType: number } | undefined,
  },
  queryOptions: { refetchInterval: false as number | false },
  invalidate: vi.fn(async () => undefined),
  mutate: vi.fn(async (_input: unknown) => ({ state: 'accepted' as const })),
  pick: vi.fn<() => Promise<{ path: string } | null>>(async () => null),
  navigate: vi.fn(),
  statusSaved: vi.fn(),
  readback: undefined as (() => Promise<boolean>) | undefined,
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: state.configId },
    available: true,
    busy: false,
    result: null,
    run: async (
      action: (binding: QQWriteBinding) => Promise<QQWriteOutcome>,
      _refresh?: unknown,
      options?: { readback?: () => Promise<boolean> },
    ) => {
      state.readback = options?.readback;
      await action({ expectedAccountUin: '10001', expectedAccountConfigId: state.configId });
      return true;
    },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      qqWrite: { onlineStatus: { mutate: (input: unknown) => state.mutate(input) } },
      pickSendFile: { mutate: state.pick },
    },
  },
  trpc: {
    useUtils: () => ({
      account: {
        getSelfProfile: { invalidate: state.invalidate },
        profileExtras: {
          avatarHistory: { invalidate: state.invalidate },
          signatureHistory: { invalidate: state.invalidate },
        },
        getOnlineStatus: { invalidate: state.invalidate },
        getSelfVip: { invalidate: state.invalidate },
      },
    }),
    account: {
      // 顶栏会员徽标与资料编辑无关，这里让它不渲染。
      getSelfProfile: { useQuery: () => ({ data: null }) },
      dressup: { peerStats: { useQuery: () => ({ data: null }) } },
      profileExtras: { energy: { useQuery: () => ({ data: undefined }) } },
      getSelfVip: { useQuery: () => ({ data: null }) },
      onVipChanged: { useSubscription: () => {} },
      qqActions: {
        extendedStatuses: {
          useQuery: () => ({ data: [{ value: 1018, label: '学习中' }], isFetching: false }),
        },
      },
      qqWrite: {
        selfState: {
          useQuery: (_input: unknown, options: typeof state.queryOptions) => {
            if ('refetchInterval' in options) state.queryOptions = options;
            return {
              data: {
                profile: state.profilePresent
                  ? {
                      uid: 'u_self',
                      uin: '10001',
                      nick: state.nick,
                      signature: '原签名',
                      gender: 2,
                    }
                  : null,
                status: state.status,
                statusError: state.statusError,
                statusOptions: [
                  { value: 10, label: '在线' },
                  { value: 30, label: '离开' },
                ],
              },
              isLoading: false,
              dataUpdatedAt: state.nick === '原昵称' ? 1 : 2,
              isFetching: false,
              refetch: async () => ({
                error: null,
                data: { status: state.status, statusError: state.statusError },
              }),
            };
          },
        },
        selfProfile: { useMutation: () => ({ mutateAsync: state.mutate }) },
        selfAvatar: { useMutation: () => ({ mutateAsync: state.mutate }) },
        onlineStatus: { useMutation: () => ({ mutateAsync: state.mutate }) },
      },
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
  const render = () => {
    act(() =>
      root.render(
        titleBar
          ? h(
              ProfileNavigationContext.Provider,
              { value: state.navigate },
              h(TitleBar, { user: { ...user } }),
            )
          : h(
              Fragment,
              null,
              h(SelfQQControls),
              h(SelfOnlineStatusEditor, {
                key: state.configId,
                binding: { expectedAccountUin: '10001', expectedAccountConfigId: state.configId },
                onSaved: state.statusSaved,
              }),
            ),
      ),
    );
    if (!titleBar)
      for (const label of ['QQ 昵称', '性别', '个性签名'])
        act(() => host.querySelector<HTMLButtonElement>(`[aria-label="编辑${label}"]`)?.click());
  };
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  render();
  return { host, render, user };
}
function input(host: HTMLElement, name: string, value: string) {
  if (!host.querySelector(`[aria-label="${name}"]`))
    act(() => host.querySelector<HTMLButtonElement>(`[aria-label="编辑${name}"]`)?.click());
  const field = host.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function selectExtended(host: HTMLElement, value: string) {
  const select = host.querySelector<HTMLSelectElement>('[aria-label="扩展在线状态"]')!;
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.configId = 'source-a';
  state.profilePresent = true;
  state.nick = '原昵称';
  state.statusError = null;
  state.status = { type: 10, subType: 0, customStatus: undefined };
  state.invalidate.mockClear();
  state.mutate.mockClear();
  state.pick.mockReset().mockResolvedValue(null);
  state.navigate.mockClear();
  state.statusSaved.mockClear();
  state.readback = undefined;
});
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('个人资料编辑入口', () => {
  it('尚未编辑时整体跟随迟到回读，不拼接不同版本的状态字段', () => {
    const f = fixture();
    state.status = {
      type: 10,
      subType: 2000,
      customStatus: { faceId: 14, faceType: 1, text: '迟到的完整状态' },
    };
    f.render();
    expect(f.host.querySelector<HTMLSelectElement>('[aria-label="扩展在线状态"]')!.value).toBe(
      '2000',
    );
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="自定义状态文字"]')!.value).toBe(
      '迟到的完整状态',
    );
    expect(f.host.querySelector('[aria-label="状态表情"]')!.getAttribute('title')).toBe('[呲牙]');
  });
  it('从扩展状态切换为离开时只提交一次整体状态，并清空扩展值', async () => {
    state.status = { type: 10, subType: 1018, customStatus: undefined };
    const f = fixture();
    act(() => {
      const base = f.host.querySelector<HTMLSelectElement>('[aria-label="在线状态"]')!;
      base.value = '30';
      base.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(f.host.querySelector('[aria-label="扩展在线状态"]')).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存在线状态"]')!.click(),
    );
    expect(state.mutate).toHaveBeenCalledOnce();
    expect(state.mutate).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      status: 30,
      extStatus: 0,
    });
    expect(await state.readback!()).toBe(false);
    state.status = { type: 30, subType: 0, customStatus: undefined };
    expect(await state.readback!()).toBe(true);
  });
  it('自定义状态完整核对基础值、扩展值、文字、表情编号和表情类型', async () => {
    const expected = { faceId: 0, text: '完整状态', faceType: 1 };
    state.status = { type: 10, subType: 2000, customStatus: expected };
    const f = fixture();
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存在线状态"]')!.click(),
    );
    const readback = state.readback!;
    expect(await readback()).toBe(true);
    for (const patch of [{ text: '另一个值' }, { faceId: 14 }, { faceType: 2 }]) {
      state.status = { type: 10, subType: 2000, customStatus: { ...expected, ...patch } };
      expect(await readback()).toBe(false);
    }
    state.statusError = '读取失败';
    expect(await readback()).toBe(false);
  });
  it('状态保存期间连续点击不重复提交，失败后保留整份草稿可重试', async () => {
    let reject!: (cause: Error) => void;
    state.mutate.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const f = fixture();
    const save = f.host.querySelector<HTMLButtonElement>('[aria-label="保存在线状态"]')!;
    act(() => {
      save.click();
      save.click();
    });
    expect(state.mutate).toHaveBeenCalledOnce();
    expect(save.disabled).toBe(true);
    await act(async () => reject(new Error('合成状态提交失败')));
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('合成状态提交失败');
    expect(save.disabled).toBe(false);
    expect(f.host.querySelector<HTMLSelectElement>('[aria-label="在线状态"]')!.value).toBe('10');
  });
  it.each([
    { label: '性别', value: '1', payload: { patch: { gender: 1 } } },
    { label: '在线状态', value: '10', payload: { status: 10, extStatus: 0 } },
  ])('$label 选择后通过保存提交', async ({ label, value, payload }) => {
    const f = fixture();
    expect(f.host.querySelector(`[aria-label="保存${label}"]`)).not.toBeNull();
    await act(async () => {
      if (label === '性别') {
        f.host.querySelectorAll<HTMLButtonElement>('[aria-label="性别"] button')[1]!.click();
      } else {
        const select = f.host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      expect(state.mutate).not.toHaveBeenCalled();
    });
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>(`[aria-label="保存${label}"]`)!.click(),
    );
    expect(state.mutate).toHaveBeenCalledOnce();
    expect(state.mutate).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      ...payload,
    });
  });
  it('所有状态选择共用一个保存入口，切换自定义和预设不自动提交', async () => {
    const f = fixture();
    expect(f.host.querySelector('[aria-label="自定义状态文字"]')).toBeNull();
    expect(f.host.querySelector('[title="清除自定义状态"]')).toBeNull();
    selectExtended(f.host, '2000');
    expect(f.host.querySelector('[aria-label="自定义状态文字"]')).not.toBeNull();
    expect(f.host.querySelectorAll('[aria-label="保存在线状态"]')).toHaveLength(1);
    expect(f.host.querySelector('[aria-label="保存扩展在线状态"]')).toBeNull();
    input(f.host, '自定义状态文字', '未保存草稿');
    await act(async () => selectExtended(f.host, '1018'));
    expect(f.host.querySelector('[aria-label="自定义状态文字"]')).toBeNull();
    expect(f.host.querySelector('[title="清除自定义状态"]')).toBeNull();
    expect(f.host.querySelector('[aria-label="保存扩展在线状态"]')).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
    state.mutate.mockClear();
    selectExtended(f.host, '2000');
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="自定义状态文字"]')!.value).toBe(
      '未保存草稿',
    );
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('自定义状态回读基础状态、文字与表情，迟到读取不覆盖文字草稿', () => {
    state.status = {
      type: 10,
      subType: 2000,
      customStatus: { faceId: 0, text: '测试状态', faceType: 1 },
    };
    const f = fixture();
    expect(f.host.querySelector<HTMLSelectElement>('[aria-label="在线状态"]')!.value).toBe('10');
    expect(
      f.host.querySelector<HTMLSelectElement>('[aria-label="扩展在线状态"]')!.selectedOptions[0]
        .textContent,
    ).toBe('自定义状态');
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="自定义状态文字"]')!.value).toBe(
      '测试状态',
    );
    expect(f.host.querySelector('[aria-label="状态表情"]')!.getAttribute('title')).toBe('[微笑]');
    input(f.host, '自定义状态文字', '未保存草稿');
    state.status = {
      ...state.status,
      customStatus: { faceId: 14, text: '远端新状态', faceType: 1 },
    };
    f.render();
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="自定义状态文字"]')!.value).toBe(
      '未保存草稿',
    );
    expect(f.host.querySelector('[aria-label="状态表情"]')!.getAttribute('title')).toBe('[微笑]');
  });
  it('同号更换来源会清除另一来源的自定义状态草稿', () => {
    const f = fixture();
    selectExtended(f.host, '2000');
    input(f.host, '自定义状态文字', '来源一草稿');
    state.configId = 'source-b';
    state.status = {
      type: 10,
      subType: 2000,
      customStatus: { faceId: 14, text: '来源二状态', faceType: 1 },
    };
    f.render();
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="自定义状态文字"]')!.value).toBe(
      '来源二状态',
    );
  });
  it('状态读回失败仍显示并允许编辑资料，同时给出状态错误', () => {
    state.statusError = 'premature EOF';
    const f = fixture();
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('状态读取失败');
    const signature = f.host.querySelector<HTMLTextAreaElement>('[aria-label="个性签名"]')!;
    expect(signature.value).toBe('');
    expect(signature.placeholder).toBe('新签名');
    expect(signature.disabled).toBe(false);
  });
  it('选择头像后提交当前来源的文件，并恢复按钮', async () => {
    state.pick.mockResolvedValueOnce({ path: '/synthetic/avatar.png' });
    const f = fixture();
    await act(async () => {
      f.host.querySelector<HTMLButtonElement>('[aria-label="更换头像"]')!.click();
    });
    expect(state.pick).toHaveBeenCalledOnce();
    expect(state.pick).toHaveBeenCalledWith({ kind: 'image' });
    expect(state.mutate).toHaveBeenCalledOnce();
    expect(state.mutate).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      source: '/synthetic/avatar.png',
    });
    expect(f.host.querySelector<HTMLButtonElement>('[aria-label="更换头像"]')!.disabled).toBe(
      false,
    );
  });
  it('选头像期间切换数据源不提交旧文件，并恢复按钮', async () => {
    let finish!: (file: { path: string }) => void;
    state.pick.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = fixture();
    const avatarButton = () => f.host.querySelector<HTMLButtonElement>('[aria-label="更换头像"]')!;
    act(() => avatarButton().click());
    expect(state.pick).toHaveBeenCalledOnce();
    expect(state.pick).toHaveBeenCalledWith({ kind: 'image' });
    expect(avatarButton().disabled).toBe(true);
    state.configId = 'source-b';
    f.render();
    await act(async () => finish({ path: '/synthetic/avatar.png' }));
    expect(state.mutate).not.toHaveBeenCalled();
    expect(avatarButton().disabled).toBe(false);
  });
  it('取消选图不写入，选图失败显示错误并恢复按钮', async () => {
    const f = fixture();
    const button = () => f.host.querySelector<HTMLButtonElement>('[aria-label="更换头像"]')!;
    await act(async () => button().click());
    expect(state.mutate).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
    state.pick.mockRejectedValueOnce(new Error('合成选图错误'));
    await act(async () => button().click());
    expect(f.host.querySelector('[role="alert"]')?.textContent).toBe('合成选图错误');
    expect(state.mutate).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
  });
  it('关闭头像对话框后，迟到的选图结果不再提交', async () => {
    let finish!: (file: { path: string }) => void;
    state.pick.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = fixture();
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="更换头像"]')!.click());
    cleanup.pop()!();
    await act(async () => finish({ path: '/synthetic/late-avatar.png' }));
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('头像请求已提交后关闭对话框，完成时仍刷新原账号的头像历史', async () => {
    let finish!: (value: { state: 'accepted' }) => void;
    state.pick.mockResolvedValueOnce({ path: '/synthetic/avatar.png' });
    state.mutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = fixture();
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="更换头像"]')!.click(),
    );
    expect(state.mutate).toHaveBeenCalledOnce();
    cleanup.pop()!();
    state.invalidate.mockClear();
    await act(async () => finish({ state: 'accepted' }));
    expect(state.invalidate).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
    });
  });
  it('共享控制层提供独立字段，不再生成重复身份区和基本资料分组', () => {
    const f = fixture();
    expect(f.host.querySelector('[aria-label="个人资料概览"]')).toBeNull();
    expect(f.host.querySelector('[aria-label="基本资料编辑"]')).toBeNull();
    expect(f.host.querySelectorAll('[aria-label="QQ 昵称"]')).toHaveLength(1);
    expect(f.host.querySelectorAll('[aria-label="性别"]')).toHaveLength(1);
    expect(f.host.querySelectorAll('input[aria-label="个性签名"]')).toHaveLength(1);
    expect(f.host.querySelector('[aria-label="更换头像"]')).not.toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('基础状态在扩展状态上方，预设扩展状态预览图标后确认提交', async () => {
    const f = fixture();
    const basic = f.host.querySelector('[aria-label="在线状态"]')!;
    const extended = f.host.querySelector<HTMLSelectElement>('[aria-label="扩展在线状态"]')!;
    expect(basic.compareDocumentPosition(extended) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => {
      extended.value = '1018';
      extended.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const preview = f.host.querySelector('[aria-label="扩展状态预览"]')!;
    expect(preview.textContent).toBe('学习中');
    expect(preview.querySelector('img')?.getAttribute('src')).toContain('study_3x.png');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存在线状态"]')!.click(),
    );
    expect(state.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 10, extStatus: 1018 }),
    );
  });
  it('自定义表情位于文字左侧，选择与输入互不覆盖', () => {
    const f = fixture();
    selectExtended(f.host, '2000');
    const face = f.host.querySelector<HTMLButtonElement>('[aria-label="状态表情"]')!;
    const wording = f.host.querySelector('[aria-label="自定义状态文字"]')!;
    expect(face.parentElement).toBe(wording.parentElement);
    expect(face.compareDocumentPosition(wording) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    input(f.host, '自定义状态文字', '正在学习');
    act(() => face.click());
    act(() => f.host.querySelector<HTMLButtonElement>('button[title="[微笑]"]')!.click());
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="自定义状态文字"]')!.value).toBe(
      '正在学习',
    );
    expect(face.title).toBe('[微笑]');
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('仅通过状态选择器展示和编辑状态，不再显示重复的服务端状态行', async () => {
    const f = fixture();
    expect(f.host.querySelector('.weq-qq-live-status')).toBeNull();
    expect(f.host.querySelector('[aria-label="查询服务端在线状态"]')).toBeNull();
    expect(f.host.textContent).not.toContain('服务端状态');
    const select = f.host.querySelector<HTMLSelectElement>('[aria-label="扩展在线状态"]')!;
    await act(async () => {
      select.value = '1018';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存在线状态"]')!.click(),
    );
    expect(f.host.querySelector('[aria-label="保存扩展在线状态"]')).toBeNull();
    expect(state.mutate).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      status: 10,
      extStatus: 1018,
    });
  });
  it('标题栏头像直接打开通用名片，不挂载专用的我的名片弹窗', () => {
    const f = fixture(true);
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    const avatar = f.host.querySelector<HTMLButtonElement>('[aria-label="查看我的名片"]')!;
    vi.spyOn(avatar, 'getBoundingClientRect').mockReturnValue({
      right: 68,
      bottom: 40,
    } as DOMRect);
    act(() => avatar.click());
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ identityValue: '10001', displayName: '自己' }),
      { x: 68, y: 40 },
    );
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    act(() =>
      avatar.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1, clientX: 48, clientY: 24 }),
      ),
    );
    expect(state.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ identityValue: '10001' }),
      { x: 48, y: 24 },
    );
    f.user.identityValue = '10002';
    f.render();
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="查看我的名片"]')!.click());
    expect(state.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ identityValue: '10002' }),
      expect.any(Object),
    );
    expect(f.host.querySelector('[role="dialog"]')).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
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
  it('保存后短时回读迟到资料并刷新标题栏，不锁住其他字段或覆盖草稿', async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect(state.queryOptions.refetchInterval).toBe(false);
    input(f.host, 'QQ 昵称', '新昵称');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存QQ 昵称"]')!.click(),
    );
    expect(state.queryOptions.refetchInterval).toBe(1000);
    expect(f.host.querySelector<HTMLTextAreaElement>('[aria-label="个性签名"]')!.disabled).toBe(
      false,
    );
    input(f.host, 'QQ 昵称', '下一次的草稿');
    state.invalidate.mockClear();
    state.nick = '新昵称';
    f.render();
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="QQ 昵称"]')!.value).toBe(
      '下一次的草稿',
    );
    expect(state.invalidate).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(state.queryOptions.refetchInterval).toBe(false);
    expect(state.mutate).toHaveBeenCalledOnce();
  });

  it('等待同步期间切换数据源会停止旧资料轮询', async () => {
    const f = fixture();
    input(f.host, 'QQ 昵称', '新昵称');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存QQ 昵称"]')!.click(),
    );
    expect(state.queryOptions.refetchInterval).toBe(1000);
    state.configId = 'source-b';
    f.render();
    expect(state.queryOptions.refetchInterval).toBe(false);
  });
  it('状态表情使用本机目录的 QSid，并保留 0 号表情', async () => {
    const f = fixture();
    selectExtended(f.host, '2000');
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
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存在线状态"]')!.click(),
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
    selectExtended(f.host, '2000');
    input(f.host, '自定义状态文字', '新的状态');
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="状态表情"]')!.click());
    input(f.host, '搜索表情', '呲牙');
    expect(f.host.querySelectorAll('.weq-face-cell')).toHaveLength(1);
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-face-cell')!.click());
    expect(f.host.querySelector('[aria-label="状态表情"] img')?.getAttribute('src')).toContain(
      '/14/apng/14.png',
    );
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存在线状态"]')!.click(),
    );
    expect(state.mutate).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      status: 10,
      extStatus: 2000,
      custom: { faceId: 14, faceType: 1, wording: '新的状态' },
    });
  });
  it.each(['搜索表情', '状态表情', 'blank'])('状态表情在 %s 聚焦时 Esc 只收起选择器', (focus) => {
    const f = fixture();
    selectExtended(f.host, '2000');
    input(f.host, '自定义状态文字', '保留状态草稿');
    const trigger = f.host.querySelector<HTMLButtonElement>('[aria-label="状态表情"]')!;
    act(() => trigger.click());
    const picker = f.host.querySelector<HTMLElement>('.weq-qq-write-face-picker')!;
    const target =
      focus === 'blank' ? picker : f.host.querySelector<HTMLElement>(`[aria-label="${focus}"]`)!;
    if (focus === 'blank') target.tabIndex = -1;
    act(() => target.focus());
    const editors = [...f.host.querySelectorAll('[data-profile-editing]')];
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => target.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(f.host.querySelector('.weq-face-picker')).toBeNull();
    expect([...f.host.querySelectorAll('[data-profile-editing]')]).toEqual(editors);
    expect(document.activeElement).toBe(trigger);
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="自定义状态文字"]')!.value).toBe(
      '保留状态草稿',
    );
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('上层详情和输入法 Esc 不收起状态表情选择器', () => {
    const f = fixture();
    selectExtended(f.host, '2000');
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="状态表情"]')!.click());
    const search = f.host.querySelector<HTMLElement>('[aria-label="搜索表情"]')!;
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      act(() =>
        search.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }),
        ),
      );
      expect(f.host.querySelector('.weq-face-picker')).not.toBeNull();
    }
    const detail = document.createElement('div');
    detail.setAttribute('role', 'dialog');
    detail.style.zIndex = '100';
    f.host.append(detail);
    act(() =>
      detail.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    );
    expect(f.host.querySelector('.weq-face-picker')).not.toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('同号切换数据源不携带上一个现场的未提交状态', () => {
    const f = fixture();
    selectExtended(f.host, '2000');
    input(f.host, '自定义状态文字', '不能串到下一数据源');
    state.configId = 'source-b';
    f.render();
    expect(f.host.querySelector('[aria-label="自定义状态文字"]')).toBeNull();
    selectExtended(f.host, '2000');
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="自定义状态文字"]')!.value).toBe('');
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it('资料缓存未填充时仍可明确修改昵称或提交新签名，空签名不提交', async () => {
    state.profilePresent = false;
    const f = fixture();
    input(f.host, 'QQ 昵称', '首次设置昵称');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存QQ 昵称"]')!.click(),
    );
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="个性签名"]')!.value).toBe('');
    expect(f.host.querySelector<HTMLButtonElement>('[aria-label="保存个性签名"]')!.disabled).toBe(
      true,
    );
    input(f.host, '个性签名', '新的签名');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="保存个性签名"]')!.click(),
    );
    expect(state.mutate).toHaveBeenNthCalledWith(1, {
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      patch: { nickname: '首次设置昵称' },
    });
    expect(state.mutate).toHaveBeenNthCalledWith(2, {
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      patch: { signature: '新的签名' },
    });
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="个性签名"]')!.value).toBe('');
  });
});
