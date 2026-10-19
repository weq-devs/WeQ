import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QQWriteTextRow,
  QQWriteSelectRow,
  QQWriteToggleRow,
} from '../src/renderer/src/components/QQWriteControls';
import {
  useQQWriteSession,
  qqWriteOutcomeText,
  type QQWriteBinding,
  type QQWriteOutcome,
} from '../src/renderer/src/hooks/useQQWriteSession';
import { useViewState } from '../src/renderer/src/state/view';

const mocked = vi.hoisted(() => ({
  config: { uin: '10001', configId: 'source-a' },
  online: true,
  invalidate: vi.fn(async () => undefined),
  invalidateStatus: vi.fn(async () => undefined),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: { useQuery: () => ({ data: mocked.config }) },
      getGroupAlbumAccessState: {
        useQuery: () => ({
          data: {
            qqOnline: mocked.online,
            attachEnabled: true,
            hasA2: true,
            hasD2: true,
            hasD2Key: true,
            hasGuid: true,
          },
        }),
      },
    },
    useUtils: () => ({
      account: Object.fromEntries(
        [
          'listRecentContacts',
          'listTopContacts',
          'listBuddies',
          'getSelfProfile',
          'getOnlineStatus',
          'getProfile',
          'getProfilesByUids',
          'listAllGroups',
          'getGroupDetail',
        ].map((name) => [
          name,
          { invalidate: name === 'getOnlineStatus' ? mocked.invalidateStatus : mocked.invalidate },
        ]),
      ),
    }),
  },
}));

const cleanups: Array<() => void> = [];
function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, root };
}
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocked.config = { uin: '10001', configId: 'source-a' };
  mocked.online = true;
  mocked.invalidate.mockReset().mockResolvedValue(undefined);
  mocked.invalidateStatus.mockReset().mockResolvedValue(undefined);
  useViewState.setState({ openedUin: '10001' });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  useViewState.setState({ openedUin: null });
  vi.unstubAllGlobals();
});

describe('QQ 写控件', () => {
  it('编辑中的备注不被迟到缓存覆盖，受理后不重复提交相同值', async () => {
    const f = fixture();
    const save = vi.fn(async () => true);
    const render = (initial: string) =>
      act(() =>
        f.root.render(
          h(QQWriteTextRow, { label: '好友备注', initial, disabled: false, onSave: save }),
        ),
      );
    render('旧备注');
    const input = f.host.querySelector('input')!;
    type(input, '新备注');
    render('缓存旧值');
    expect(input.value).toBe('新备注');
    await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
    expect(save).toHaveBeenCalledWith('新备注');
    expect(f.host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    render('新备注');
    expect(input.value).toBe('新备注');
  });

  it('清空字符串仍可提交，未编辑的字段不提交', async () => {
    const f = fixture();
    const save = vi.fn(async () => true);
    act(() =>
      f.root.render(
        h(QQWriteTextRow, { label: '个性签名', initial: '原签名', disabled: false, onSave: save }),
      ),
    );
    expect(f.host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    type(f.host.querySelector('input')!, '');
    await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
    expect(save).toHaveBeenCalledWith('');
  });

  it('未读取的值使用明确的清空动作，不要求先联网读旧值', async () => {
    const f = fixture();
    const save = vi.fn(async () => true);
    act(() =>
      f.root.render(
        h(QQWriteTextRow, { label: '好友备注', initial: null, disabled: false, onSave: save }),
      ),
    );
    const button = f.host.querySelector<HTMLButtonElement>('[aria-label="清空好友备注"]')!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(save).toHaveBeenCalledWith('');
  });

  it('群助手与屏蔽保留各自枚举，未知值不默认选正常提醒', async () => {
    const f = fixture();
    const save = vi.fn(async () => true);
    act(() =>
      f.root.render(
        h(QQWriteSelectRow, {
          label: '消息接收',
          initial: 8,
          disabled: false,
          options: [
            { value: 1, label: '正常提醒' },
            { value: 4, label: '免打扰' },
            { value: 2, label: '群助手' },
            { value: 3, label: '屏蔽' },
          ],
          onSave: save,
        }),
      ),
    );
    const select = f.host.querySelector('select')!;
    expect(select.value).toBe('8');
    act(() => {
      select.value = '3';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
    expect(save).toHaveBeenCalledWith(3);
  });

  it('开关等待缓存同步期间不把期望值伪装成真实值', async () => {
    const f = fixture();
    const save = vi.fn(async () => true);
    const render = (initial: boolean) =>
      act(() =>
        f.root.render(
          h(QQWriteToggleRow, { label: '置顶', initial, disabled: false, onSave: save }),
        ),
      );
    render(false);
    await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
    expect(f.host.querySelector('button')!.getAttribute('aria-checked')).toBe('false');
    expect(f.host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    render(true);
    expect(f.host.querySelector('button')!.getAttribute('aria-checked')).toBe('true');
    expect(f.host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
  });

  it('免打扰状态未知时不伪装为关闭，但允许用户明确设置', async () => {
    const f = fixture();
    const save = vi.fn(async () => true);
    act(() =>
      f.root.render(
        h(QQWriteToggleRow, { label: '消息免打扰', initial: null, disabled: false, onSave: save }),
      ),
    );
    expect(f.host.querySelector('[role="switch"]')).toBeNull();
    const select = f.host.querySelector('select')!;
    expect(select.value).toBe('');
    act(() => {
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
    expect(save).toHaveBeenCalledWith(true);
  });
});

describe('QQ 写操作账号与生命周期', () => {
  function harness() {
    const f = fixture();
    let session: ReturnType<typeof useQQWriteSession>;
    function View({ scope }: { scope: string }) {
      session = useQQWriteSession(scope);
      return h('output', null, session.result?.text);
    }
    const render = (scope = 'c2c:u_a') => act(() => f.root.render(h(View, { scope })));
    render();
    return { ...f, render, session: () => session! };
  }
  it('输入状态等瞬时请求可以跳过与其无关的资料缓存刷新', async () => {
    const f = harness();
    await act(async () => {
      await f
        .session()
        .run(async () => ({ state: 'accepted' }), undefined, { refreshCaches: false });
    });
    expect(mocked.invalidate).not.toHaveBeenCalled();
    expect(mocked.invalidateStatus).not.toHaveBeenCalled();
  });
  it('快速重复点击只发一次，绑定的是提交时账号与数据源', async () => {
    const f = harness();
    const action = vi.fn(
      async (_binding: QQWriteBinding): Promise<QQWriteOutcome> => ({ state: 'accepted' }),
    );
    await act(async () => {
      await Promise.all([f.session().run(action), f.session().run(action)]);
    });
    expect(action).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledWith({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
    });
    expect(f.host.textContent).toContain('等待 QQ 同步');
    expect(mocked.invalidateStatus).toHaveBeenCalledOnce();
  });

  it.each(['account', 'source', 'conversation'])(
    '请求期间切换 %s，迟到结果不覆盖新现场',
    async (kind) => {
      const f = harness();
      let resolve: (outcome: QQWriteOutcome) => void = () => {};
      const action = vi.fn(
        () =>
          new Promise<QQWriteOutcome>((done) => {
            resolve = done;
          }),
      );
      let pending: Promise<boolean>;
      act(() => {
        pending = f.session().run(action);
      });
      act(() => {
        if (kind === 'account') {
          mocked.config = { uin: '10002', configId: 'source-b' };
          useViewState.setState({ openedUin: '10002' });
        }
        if (kind === 'source') mocked.config = { uin: '10001', configId: 'source-b' };
        f.render(kind === 'conversation' ? 'group:123' : undefined);
      });
      await act(async () => {
        resolve({ state: 'confirmed' });
        expect(await pending!).toBe(false);
      });
      expect(mocked.invalidate).not.toHaveBeenCalled();
      expect(mocked.invalidateStatus).not.toHaveBeenCalled();
      expect(f.host.textContent).toBe('');
    },
  );

  it('文件选择等异步步骤保留的旧回调不能作用于新会话', async () => {
    const f = harness();
    const oldRun = f.session().run;
    f.render('group:123');
    const action = vi.fn(async (): Promise<QQWriteOutcome> => ({ state: 'accepted' }));
    expect(await oldRun(action)).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it('刷新失败不冒充远端操作失败，也不重发写请求', async () => {
    const f = harness();
    mocked.invalidate.mockRejectedValue(new Error('cache error'));
    const action = vi.fn(async (): Promise<QQWriteOutcome> => ({ state: 'accepted' }));
    await act(async () => {
      await f.session().run(action);
    });
    expect(action).toHaveBeenCalledOnce();
    expect(f.session().result?.error).toBe(false);
    expect(f.host.textContent).toContain('本机刷新失败');
  });

  it('资料后台刷新未结束时释放保存锁，允许继续提交其他字段', async () => {
    const f = harness();
    let finishRefresh!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => (finishRefresh = resolve)));
    const action = vi.fn(async (): Promise<QQWriteOutcome> => ({ state: 'accepted' }));
    await act(async () => {
      expect(await f.session().run(action, refresh, { backgroundRefresh: true })).toBe(true);
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(f.session().busy).toBe(false);
    await act(async () => {
      expect(await f.session().run(action, undefined, { refreshCaches: false })).toBe(true);
      finishRefresh();
    });
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('旧后台刷新失败不覆盖下一次操作回执', async () => {
    const f = harness();
    let failRefresh!: (cause: Error) => void;
    await act(async () => {
      await f.session().run(
        async () => ({ state: 'accepted' }),
        () => new Promise<void>((_resolve, reject) => (failRefresh = reject)),
        { backgroundRefresh: true },
      );
      await f.session().run(async () => ({ state: 'confirmed' }), undefined, {
        refreshCaches: false,
      });
      failRefresh(new Error('late cache error'));
    });
    expect(f.host.textContent).toBe(qqWriteOutcomeText({ state: 'confirmed' }));
  });

  it('离线不发请求；未确认的回包不会显示已生效', async () => {
    mocked.online = false;
    const f = harness();
    const action = vi.fn(async (): Promise<QQWriteOutcome> => ({ state: 'accepted' }));
    expect(await f.session().run(action)).toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(qqWriteOutcomeText({ state: 'unconfirmed' })).toContain('未确认');
  });
});
