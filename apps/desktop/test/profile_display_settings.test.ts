import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProfileDisplaySetting } from '@weq/protocol';
import {
  DisplaySelfProfileField,
  ProfileDisplayEntry,
  SelfProfileDisplayProvider,
} from '../src/renderer/src/components/ProfileDisplaySettings';
import { QQWriteTextRow } from '../src/renderer/src/components/QQWriteControls';

const state = vi.hoisted(() => ({
  config: 'a',
  available: true,
  loading: false,
  error: null as Error | null,
  settings: [] as ProfileDisplaySetting[],
  mutate: vi.fn(),
  refetch: vi.fn(),
  content: vi.fn(),
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
    h(
      DisplaySelfProfileField,
      {
        label: '公司',
        value: '原公司',
        displayField: 'company',
      },
      h(QQWriteTextRow, {
        label: '公司',
        initial: '原公司',
        disabled: false,
        onSave: state.content,
      }),
    ),
    h(ProfileDisplayEntry, { field: 'age' }, '21 岁'),
    h(ProfileDisplayEntry, { field: 'education' }, '学校'),
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
  const click = (label: string) =>
    act(() => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  const choose = (field: string, value: string) =>
    act(() => {
      [
        ...host.querySelectorAll<HTMLButtonElement>(
          `[data-display-field="${field}"] [role="radio"]`,
        ),
      ]
        .find((button) => button.textContent === value)!
        .click();
    });
  return { host, render, click, choose };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.config = 'a';
  state.available = true;
  state.loading = false;
  state.error = null;
  state.settings = ['company', 'age', 'education'].map((field) => ({
    field: field as ProfileDisplaySetting['field'],
    raw: 0,
    value: 0,
    status: 'known',
  }));
  state.enabled = [];
  state.mutate.mockReset();
  state.refetch.mockReset();
  state.content.mockReset().mockResolvedValue(true);
  state.mutate.mockImplementation(async ({ field, value }: { field: string; value: number }) => ({
    targetUin: '10002',
    field,
    state: 'confirmed',
    setting: { field, value, raw: value, status: 'known' },
    error: null,
  }));
  state.refetch.mockResolvedValue({
    data: { targetUin: '10002', settings: state.settings },
    error: null,
  });
});
afterEach(() => {
  for (const fn of dispose.splice(0)) fn();
  vi.unstubAllGlobals();
});

it('普通展示不读范围、不显示全局开关；只展开正在编辑的字段', () => {
  const f = fixture();
  expect(state.enabled.every((enabled) => !enabled)).toBe(true);
  expect(f.host.querySelector('[data-profile-display-mode]')).toBeNull();
  expect(f.host.querySelector('[role="radiogroup"]')).toBeNull();
  f.click('编辑公司');
  expect(state.enabled.at(-1)).toBe(true);
  expect(f.host.querySelectorAll('[role="radiogroup"]')).toHaveLength(1);
  expect(f.host.querySelector('[data-display-field="age"]')).toBeNull();
  expect(f.host.textContent).toContain('21 岁');
});
it('选择范围只改草稿；取消不写入，重新编辑恢复已确认值', () => {
  const f = fixture();
  f.click('编辑公司');
  f.choose('company', '仅好友');
  expect(state.mutate).not.toHaveBeenCalled();
  expect(state.content).not.toHaveBeenCalled();
  f.click('取消编辑公司');
  f.click('编辑公司');
  expect(f.host.querySelector('[aria-checked="true"][role="radio"]')?.textContent).toBe('所有人');
});
it('内容与展示范围顺序保存，全部成功才退出编辑', async () => {
  let release!: (ok: boolean) => void;
  state.content.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const f = fixture();
  f.click('编辑公司');
  f.choose('company', '仅好友');
  await act(async () => f.click('保存公司'));
  expect(state.mutate).not.toHaveBeenCalled();
  expect(f.host.querySelector('[aria-label="取消编辑公司"]')).not.toBeNull();
  await act(async () => release(true));
  expect(state.mutate).toHaveBeenCalledTimes(1);
  expect(state.mutate).toHaveBeenCalledWith({
    expectedAccountUin: '10002',
    expectedAccountConfigId: 'a',
    field: 'company',
    value: 1,
  });
  expect(f.host.querySelector('[aria-label="编辑公司"]')).not.toBeNull();
});
it('内容失败不提交范围；重复点击保存不重复提交', async () => {
  let release!: (ok: boolean) => void;
  state.content.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const f = fixture();
  f.click('编辑公司');
  f.choose('company', '不可见');
  f.click('保存公司');
  f.click('保存公司');
  expect(state.content).toHaveBeenCalledTimes(1);
  await act(async () => release(false));
  expect(state.mutate).not.toHaveBeenCalled();
  expect(f.host.querySelector('[aria-label="取消编辑公司"]')).not.toBeNull();
});
it('只改内容不写范围，只有范围可改的字段也有保存与取消', async () => {
  const f = fixture();
  f.click('编辑公司');
  await act(async () => f.click('保存公司'));
  expect(state.mutate).not.toHaveBeenCalled();
  f.click('编辑年龄');
  f.choose('age', '不可见');
  expect(state.mutate).not.toHaveBeenCalled();
  expect(f.host.querySelector('[aria-label="取消编辑年龄"]')).not.toBeNull();
  await act(async () => f.click('保存年龄'));
  expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({ field: 'age', value: 2 }));
});
it('范围失败保留编辑并标明未完成项，重新读取不重发写请求', async () => {
  state.mutate.mockResolvedValue({
    targetUin: '10002',
    field: 'company',
    state: 'mismatch',
    setting: state.settings[0],
    error: '读回不一致',
  });
  const f = fixture();
  f.click('编辑公司');
  f.choose('company', '不可见');
  await act(async () => f.click('保存公司'));
  expect(f.host.textContent).toContain('展示范围尚未保存');
  expect(f.host.textContent).toContain('读回不一致');
  expect(f.host.querySelector('[aria-label="取消编辑公司"]')).not.toBeNull();
  await act(async () => f.click('重新读取公司展示设置'));
  expect(state.mutate).toHaveBeenCalledTimes(1);
  expect(state.refetch).toHaveBeenCalledTimes(1);
});
it.each(['unknown', 'missing', 'incomplete'] as const)(
  '范围为 %s 时不默认选中、不阻止内容保存',
  async (status) => {
    state.settings[0] = {
      field: 'company',
      raw: status === 'unknown' ? 99 : null,
      value: null,
      status,
    };
    const f = fixture();
    f.click('编辑公司');
    expect(f.host.querySelector('[aria-checked="true"][role="radio"]')).toBeNull();
    expect(f.host.querySelectorAll('[role="radio"]:not(:disabled)')).toHaveLength(0);
    await act(async () => f.click('保存公司'));
    expect(state.content).toHaveBeenCalledTimes(1);
    expect(state.mutate).not.toHaveBeenCalled();
  },
);
it('范围读取失败仍可独立保存内容', async () => {
  state.error = new Error('读取失败');
  state.settings = [];
  const f = fixture();
  f.click('编辑公司');
  expect(f.host.textContent).toContain('读取失败');
  await act(async () => f.click('保存公司'));
  expect(state.content).toHaveBeenCalledTimes(1);
  expect(state.mutate).not.toHaveBeenCalled();
});
it('切换数据源退出编辑，忽略旧保存回包', async () => {
  let release!: (value: unknown) => void;
  state.mutate.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const f = fixture();
  f.click('编辑年龄');
  f.choose('age', '仅好友');
  await act(async () => f.click('保存年龄'));
  state.config = 'b';
  f.render();
  await act(async () =>
    release({
      targetUin: '10002',
      field: 'age',
      state: 'confirmed',
      setting: { field: 'age', value: 1, raw: 1, status: 'known' },
    }),
  );
  expect(f.host.querySelector('[role="radiogroup"]')).toBeNull();
  f.click('编辑年龄');
  expect(f.host.querySelector('[aria-checked="true"][role="radio"]')?.textContent).toBe('所有人');
});
it('离线保持正文；没有本人上下文时不提供展示范围操作', () => {
  state.available = false;
  const f = fixture();
  expect(f.host.textContent).toContain('21 岁');
  expect(f.host.querySelector('[aria-label="编辑年龄"]')).toBeNull();
  const other = fixture(false);
  expect(other.host.querySelector('[aria-label="编辑年龄"]')).toBeNull();
});
it('Escape 取消整个字段草稿，不冒泡关闭页面并恢复焦点', () => {
  const f = fixture();
  f.click('编辑公司');
  f.choose('company', '仅好友');
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => f.host.querySelector('[aria-label="公司"]')!.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(state.mutate).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(f.host.querySelector('[aria-label="编辑公司"]'));
});
