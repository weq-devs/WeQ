import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProfileDetailsEntry } from '../src/renderer/src/components/ProfileDetailsEntry';

const state = vi.hoisted(() => ({ query: vi.fn(), refetch: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { account: { profileExtras: { details: { useQuery: state.query } } } },
}));
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source', uin: '10002' };
const data = {
  targetUin: '10002',
  company: '合成公司',
  personalDescription: '第一行\n第二行',
  email: 'synthetic@example.invalid',
  errors: {},
};
const result = (value: unknown = data) => ({
  data: value,
  error: null,
  isFetching: false,
  refetch: state.refetch,
});
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function render(input = binding, online = true) {
  await act(async () => root.render(h(ProfileDetailsEntry, { input, online })));
}
async function open() {
  await act(async () => host.querySelector('button')!.click());
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  state.query.mockReturnValue(result());
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('打开详细资料后才一次查询三项，保留多行个人说明', async () => {
  await render();
  expect(state.query).not.toHaveBeenCalled();
  await open();
  expect(state.query.mock.calls.at(-1)?.[0]).toEqual(binding);
  expect(state.query.mock.calls.at(-1)?.[1].enabled).toBe(true);
  expect(document.querySelectorAll('.weq-profile-data-row')).toHaveLength(3);
  expect(document.body.textContent).toContain('合成公司');
  expect(document.body.textContent).toContain('第一行\n第二行');
  expect(document.body.textContent).toContain('synthetic@example.invalid');
});
it('未返回、明确为空和单项格式错误分开，其他字段仍可展示', async () => {
  state.query.mockReturnValue(
    result({
      ...data,
      company: '',
      personalDescription: null,
      errors: { email: '文本格式无法识别' },
    }),
  );
  await render();
  await open();
  const rows = [...document.querySelectorAll('.weq-profile-data-row')].map(
    (row) => row.textContent,
  );
  expect(rows).toEqual(['公司未填写', '个人说明未返回', '邮箱文本格式无法识别']);
});
it('刷新失败保留已读内容，重试不清空正文', async () => {
  state.query.mockReturnValue({ ...result(), error: new Error('暂不可读') });
  await render();
  await open();
  expect(document.body.textContent).toContain('合成公司');
  expect(document.body.textContent).toContain('已显示的资料保留');
  await act(async () =>
    document.querySelector<HTMLButtonElement>('.weq-profile-inline-error button')!.click(),
  );
  expect(state.refetch).toHaveBeenCalledOnce();
});
it('离线和加载态不伪装成未填写，离线查询禁用', async () => {
  state.query.mockReturnValue({ ...result(), data: undefined });
  await render(binding, false);
  await open();
  expect(state.query.mock.calls.at(-1)?.[1].enabled).toBe(false);
  expect(document.body.textContent).toContain('暂不可在线读取');
  state.query.mockReturnValue({ ...result(), data: undefined, isFetching: true });
  await render();
  expect(document.body.textContent).toContain('读取中');
  expect(document.querySelectorAll('.weq-profile-data-row')).toHaveLength(0);
});
it('错目标数据不展示，切账号或切目标关闭旧详情', async () => {
  state.query.mockReturnValue(result({ ...data, targetUin: '10003' }));
  await render();
  await open();
  expect(document.body.textContent).not.toContain('合成公司');
  expect(document.body.textContent).toContain('读取失败');
  await render({ ...binding, expectedAccountConfigId: 'other' });
  expect(document.querySelector('[aria-label="关闭详细资料"]')).toBeNull();
  await open();
  await render({ ...binding, uin: '10004' });
  expect(document.querySelector('[aria-label="关闭详细资料"]')).toBeNull();
});
it('个人说明与邮箱内容按纯文本展示，不将资料当 HTML 执行', async () => {
  state.query.mockReturnValue(
    result({
      ...data,
      personalDescription: '<img src=x onerror=alert(1)>',
      email: '非标准邮箱文本',
    }),
  );
  await render();
  await open();
  expect(document.querySelector('.weq-profile-data img')).toBeNull();
  expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(document.body.textContent).toContain('非标准邮箱文本');
});
