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
    useUtils: () => ({
      account: {
        getSelfProfile: { invalidate: state.invalidate },
        getOnlineStatus: { invalidate: state.invalidate },
      },
    }),
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
                statusOptions: [{ value: 10, label: '在线' }],
              },
              isLoading: false,
              dataUpdatedAt: state.nick === '原昵称' ? 1 : 2,
              isFetching: false,
              refetch: async () => ({ error: null }),
            };
          },
        },
        selfProfile: { useMutation: () => ({ mutateAsync: state.mutate }) },
        selfAvatar: { useMutation: () => ({ mutateAsync: state.mutate }) },
        onlineStatus: { useMutation: () => ({ mutateAsync: state.mutate }) },
      },
      pickSendFile: { useMutation: () => ({ mutateAsync: state.pick }) },
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
  state.nick = '原昵称';
  state.statusError = null;
  state.status = { type: 10, subType: 0, customStatus: undefined };
  state.invalidate.mockClear();
  state.mutate.mockClear();
  state.pick.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('个人资料编辑入口', () => {
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
    expect(f.host.querySelector('[aria-label="状态表情"]')!.getAttribute('title')).toBe('[呲牙]');
  });
  it('同号更换来源会清除另一来源的自定义状态草稿', () => {
    const f = fixture();
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
    expect(signature.value).toBe('原签名');
    expect(signature.disabled).toBe(false);
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
    expect(avatarButton().disabled).toBe(true);
    state.configId = 'source-b';
    f.render();
    await act(async () => finish({ path: '/synthetic/avatar.png' }));
    expect(state.mutate).not.toHaveBeenCalled();
    expect(avatarButton().disabled).toBe(false);
  });
  it('头像位于基本字段前，昵称与性别分组，签名独立占满编辑区', () => {
    const f = fixture();
    const header = f.host.querySelector('[aria-label="个人资料概览"]')!;
    expect(header).not.toBeNull();
    expect(header.textContent).toContain('10001');
    expect(header.querySelector('[aria-label="更换头像"]')).not.toBeNull();
    const basic = f.host.querySelector('[aria-label="基本资料编辑"]')!;
    expect(basic.querySelector('[aria-label="QQ 昵称"]')).not.toBeNull();
    expect(basic.querySelector('[aria-label="性别"]')).not.toBeNull();
    expect(basic.querySelector('[aria-label="个性签名"]')).toBeNull();
    const signature = f.host.querySelector('[aria-label="签名编辑"]')!;
    expect(signature.querySelector('textarea')).not.toBeNull();
    expect(header.compareDocumentPosition(basic) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      basic.compareDocumentPosition(signature) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('基础状态在扩展状态上方，扩展草稿实时预览且不自动提交', () => {
    const f = fixture();
    const basic = f.host.querySelector('[aria-label="在线状态"]')!;
    const extended = f.host.querySelector<HTMLSelectElement>('[aria-label="扩展在线状态"]')!;
    expect(basic.compareDocumentPosition(extended) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => {
      extended.value = '1018';
      extended.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const preview = f.host.querySelector('[aria-label="扩展状态预览"]')!;
    expect(preview.textContent).toBe('学习中');
    expect(preview.querySelector('img')?.getAttribute('src')).toContain('study_3x.png');
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it('自定义表情位于文字左侧，选择与输入互不覆盖', () => {
    const f = fixture();
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
