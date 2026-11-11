import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProfileDisplaySetting } from '@weq/protocol';
import {
  ProfileDisplayControl,
  ProfileDisplayToolbar,
  SelfProfileDisplayProvider,
} from '../src/renderer/src/components/ProfileDisplaySettings';

const state = vi.hoisted(() => ({
  config: 'a',
  available: true,
  loading: false,
  error: null as Error | null,
  settings: [] as ProfileDisplaySetting[],
  mutate: vi.fn(),
  refetch: vi.fn(),
  enabled: [] as boolean[],
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10002', expectedAccountConfigId: state.config },
    available: state.available,
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      qqWrite: {
        selfProfileDisplaySettings: {
          useQuery: (_input: unknown, options: { enabled: boolean }) => {
            state.enabled.push(options.enabled);
            return {
              data: options.enabled ? { targetUin: '10002', settings: state.settings } : undefined,
              isFetching: state.loading,
              error: state.error,
              refetch: state.refetch,
            };
          },
        },
        setSelfProfileDisplaySetting: { useMutation: () => ({ mutateAsync: state.mutate }) },
      },
    },
  },
}));
const dispose: (() => void)[] = [];
function fixture(provider = true) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const children = h(
    'div',
    null,
    h('p', null, '本地资料正文'),
    h(ProfileDisplayToolbar),
    h(ProfileDisplayControl, { field: 'gender' }),
    h(ProfileDisplayControl, { field: 'education' }),
    h(ProfileDisplayControl, { field: 'education' }),
  );
  const render = () =>
    act(() =>
      root.render(provider ? h(SelfProfileDisplayProvider, { uin: '10002', children }) : children),
    );
  render();
  dispose.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const toggle = () =>
    act(() => host.querySelector<HTMLButtonElement>('[data-profile-display-mode]')!.click());
  const choose = (field: string, value: string) =>
    act(() => {
      const buttons = host.querySelectorAll<HTMLButtonElement>(
        `[data-display-field="${field}"] [role="radio"]`,
      );
      [...buttons].find((button) => button.textContent === value)!.click();
    });
  return { host, render, toggle, choose };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.config = 'a';
  state.available = true;
  state.loading = false;
  state.error = null;
  state.settings = ['gender', 'education'].map((field) => ({
    field: field as ProfileDisplaySetting['field'],
    raw: 0,
    value: 0,
    status: 'known',
  }));
  state.enabled = [];
  state.mutate.mockReset();
  state.refetch.mockReset();
});
afterEach(() => {
  for (const fn of dispose.splice(0)) fn();
  vi.unstubAllGlobals();
});

it('未启用不读状态；启用不隐藏正文；关闭不写入', () => {
  const f = fixture();
  expect(f.host.querySelector('[data-profile-display-mode]')?.tagName).toBe('BUTTON');
  expect(f.host.querySelector('[role="switch"]')).toBeNull();
  expect(state.enabled.every((enabled) => !enabled)).toBe(true);
  expect(f.host.querySelector('[role="radiogroup"]')).toBeNull();
  f.toggle();
  expect(f.host.querySelector('[data-profile-display-mode]')?.textContent).toBe('完成资料展示设置');
  expect(state.enabled.at(-1)).toBe(true);
  expect(f.host.textContent).toContain('本地资料正文');
  f.toggle();
  expect(f.host.querySelector('[role="radiogroup"]')).toBeNull();
  expect(state.mutate).not.toHaveBeenCalled();
});
it('同一项多入口共享状态，确认成功才选中；在途不阻塞其他项', async () => {
  let release!: (value: unknown) => void;
  state.mutate.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const f = fixture();
  f.toggle();
  f.choose('education', '仅好友');
  expect(f.host.querySelectorAll('[data-display-field="education"] button:disabled')).toHaveLength(
    6,
  );
  expect(f.host.querySelectorAll('[data-display-field="gender"] button:disabled')).toHaveLength(0);
  f.choose('education', '不可见');
  expect(state.mutate).toHaveBeenCalledTimes(1);
  await act(async () =>
    release({
      targetUin: '10002',
      field: 'education',
      state: 'confirmed',
      setting: { field: 'education', value: 1, raw: 1, status: 'known' },
      error: null,
    }),
  );
  expect(
    f.host.querySelectorAll('[data-display-field="education"] [aria-checked="true"]'),
  ).toHaveLength(2);
  expect(
    [...f.host.querySelectorAll('[data-display-field="education"] [aria-checked="true"]')].every(
      (el) => el.textContent === '仅好友',
    ),
  ).toBe(true);
});
it('保存失败不冒充成功；读回按钮不重发写请求', async () => {
  state.mutate.mockResolvedValue({
    targetUin: '10002',
    field: 'gender',
    state: 'mismatch',
    setting: state.settings[0],
    error: '读回不一致',
  });
  state.refetch.mockResolvedValue({
    data: { targetUin: '10002', settings: state.settings },
    error: null,
  });
  const f = fixture();
  f.toggle();
  await act(async () => f.choose('gender', '不可见'));
  expect(f.host.textContent).toContain('读回不一致');
  expect(
    f.host.querySelector('[data-display-field="gender"] [aria-checked="true"]')?.textContent,
  ).toBe('所有人');
  await act(async () =>
    f.host.querySelector<HTMLButtonElement>('[aria-label="重新读取性别展示设置"]')!.click(),
  );
  expect(state.mutate).toHaveBeenCalledTimes(1);
  expect(state.refetch).toHaveBeenCalledTimes(1);
});
it('缺失未知和读取中均不默认选中；离线保留正文', () => {
  state.settings = [
    { field: 'gender', raw: 99, value: null, status: 'unknown' },
    { field: 'education', raw: null, value: null, status: 'missing' },
  ];
  const f = fixture();
  f.toggle();
  expect(f.host.textContent).toContain('未知状态（99）');
  expect(f.host.textContent).toContain('未返回此项');
  expect(f.host.querySelector('[aria-checked="true"][role="radio"]')).toBeNull();
  state.available = false;
  f.render();
  expect(f.host.textContent).toContain('本地资料正文');
  expect(f.host.querySelectorAll('[role="radio"]:not(:disabled)')).toHaveLength(0);
});
it('切换账号退出模式，旧保存回包不会污染新账号', async () => {
  let release!: (value: unknown) => void;
  state.mutate.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const f = fixture();
  f.toggle();
  f.choose('gender', '不可见');
  state.config = 'b';
  f.render();
  await act(async () =>
    release({
      targetUin: '10002',
      field: 'gender',
      state: 'confirmed',
      setting: { field: 'gender', value: 2, raw: 2, status: 'known' },
      error: null,
    }),
  );
  expect(f.host.querySelector('[data-profile-display-mode]')?.getAttribute('aria-expanded')).toBe(
    'false',
  );
  f.toggle();
  expect(
    f.host.querySelector('[data-display-field="gender"] [aria-checked="true"]')?.textContent,
  ).toBe('所有人');
});
it('没有自己的资料上下文时，其他联系人不会出现入口或查询', () => {
  const f = fixture(false);
  expect(f.host.querySelector('[data-profile-display-mode]')).toBeNull();
  expect(state.enabled).toHaveLength(0);
});

it('首次读取未完成时没有默认选项，正文照常绘制', () => {
  state.settings = [];
  state.loading = true;
  const f = fixture();
  f.toggle();
  expect(f.host.textContent).toContain('本地资料正文');
  expect(f.host.textContent).toContain('读取中');
  expect(f.host.querySelector('[aria-checked="true"][role="radio"]')).toBeNull();
  expect(f.host.querySelectorAll('[role="radio"]:not(:disabled)')).toHaveLength(0);
});

it('较早开始的全量刷新不能覆盖随后确认的单项保存', async () => {
  let releaseRefresh!: (value: unknown) => void;
  state.refetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseRefresh = resolve;
      }),
  );
  state.mutate.mockResolvedValue({
    targetUin: '10002',
    field: 'gender',
    state: 'confirmed',
    setting: { field: 'gender', raw: 1, value: 1, status: 'known' },
    error: null,
  });
  const f = fixture();
  f.toggle();
  act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="重新读取展示设置"]')!.click());
  await act(async () => f.choose('gender', '仅好友'));
  await act(async () =>
    releaseRefresh({ data: { targetUin: '10002', settings: state.settings }, error: null }),
  );
  expect(
    f.host.querySelector('[data-display-field="gender"] [aria-checked="true"]')?.textContent,
  ).toBe('仅好友');
});
