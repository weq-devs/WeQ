import { act, createElement as h, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ProfileLikesRow } from '../src/renderer/src/components/qq-actions/ProfileLikesRow';
import { DialogHost } from '../src/renderer/src/components/Dialog';
import { useViewState } from '../src/renderer/src/state/view';

const state = vi.hoisted(() => ({
  count: 12345 as number | null,
  loading: false,
  perform: vi.fn(),
  write: vi.fn(async () => ({ state: 'accepted' })),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { qqActions: { profileLike: { mutate: state.write } } } },
  trpc: {
    account: {
      dressup: {
        peerStats: {
          useQuery: () => ({
            data: state.count === null ? undefined : { likeCount: state.count, level: 5 },
            isLoading: state.loading,
          }),
        },
      },
    },
    useUtils: () => ({ account: { dressup: { peerStats: { invalidate: vi.fn() } } } }),
  },
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  withQQAccountScope: (component: unknown) => component,
  useQQAction: () => ({
    disabled: false,
    pending: false,
    available: true,
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    perform: state.perform,
  }),
  ActionIcon: ({
    label,
    children,
    onClick,
    disabled,
  }: {
    label: string;
    children: ReactNode;
    onClick: () => void;
    disabled?: boolean;
  }) => h('button', { type: 'button', 'aria-label': label, onClick, disabled }, children),
  ActionFeedback: () => null,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  state.count = 12345;
  state.loading = false;
  state.perform.mockClear();
  state.write.mockClear();
  useViewState.setState({ openedUin: null });
});

it.each([1, 10, 20] as const)(
  '累计赞数与按钮同一资料行，打开不发送，点击 +%s 单次提交指定数量',
  async (count) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useViewState.setState({ openedUin: '10001' });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          h(
            Fragment,
            null,
            h(ProfileLikesRow, { uid: 'u_peer', uin: '10002', name: '合成好友' }),
            h(DialogHost),
          ),
        ),
      );
      expect(host.querySelector('.weq-profile-likes-row strong')?.textContent).toBe('12,345');
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="赞资料卡"]')!.click());
      expect(document.querySelector('.weq-profile-like-stage.is-active input')).toBeNull();
      expect(document.querySelector('.weq-profile-like-quota')).toBeNull();
      expect(document.querySelectorAll('.weq-profile-like-preset')).toHaveLength(4);
      expect(state.perform).not.toHaveBeenCalled();
      act(() =>
        document.querySelector<HTMLButtonElement>(`[aria-label="点赞 +${count}"]`)!.click(),
      );
      expect(state.perform).toHaveBeenCalledOnce();
      const action = state.perform.mock.calls[0]![0] as (binding: {
        expectedAccountUin: string;
        expectedAccountConfigId: string;
      }) => Promise<unknown>;
      await action({ expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' });
      expect(state.write).toHaveBeenCalledWith({
        expectedAccountUin: '10001',
        expectedAccountConfigId: 'source-a',
        uid: 'u_peer',
        count,
      });
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it('自定义在原弹窗内切换，取消不写，非法输入禁用确认，合法输入提交一次', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useViewState.setState({ openedUin: '10001' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
  try {
    act(() =>
      root.render(
        h(
          Fragment,
          null,
          h(ProfileLikesRow, { uid: 'u_peer', uin: '10002', name: '合成好友' }),
          h(DialogHost),
        ),
      ),
    );
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="赞资料卡"]')!.click());
    const dialog = document.querySelector('.weq-profile-like-dialog')!;
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="自定义点赞次数"]')!.click());
    expect(document.querySelector('.weq-profile-like-dialog')).toBe(dialog);
    expect(document.querySelector('.weq-profile-like-custom.is-active')).not.toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="取消自定义点赞"]')!.click());
    expect(document.querySelector('.weq-profile-like-controls.is-active')).not.toBeNull();
    expect(state.perform).not.toHaveBeenCalled();
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="自定义点赞次数"]')!.click());
    const input = document.querySelector<HTMLInputElement>('[aria-label="资料卡点赞次数"]')!;
    const change = (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    change('99');
    expect(document.querySelector<HTMLButtonElement>('[aria-label="确认点赞"]')!.disabled).toBe(
      true,
    );
    change('7');
    expect(document.querySelector<HTMLButtonElement>('[aria-label="确认点赞"]')!.disabled).toBe(
      false,
    );
    act(() =>
      document
        .querySelector('form.weq-profile-like-custom')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(state.perform).toHaveBeenCalledOnce();
    const action = state.perform.mock.calls[0]![0] as (scope: typeof binding) => Promise<unknown>;
    await action(binding);
    expect(state.write).toHaveBeenCalledWith({ ...binding, uid: 'u_peer', count: 7 });
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('查询失败不伪造零赞', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.count = null;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(h(ProfileLikesRow, { uid: 'u_peer', uin: '10002', name: '合成好友' })));
    expect(host.querySelector('strong')?.textContent).toBe('暂不可用');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
