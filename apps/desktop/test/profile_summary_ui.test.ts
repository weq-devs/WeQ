import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MedalWall, ProfileCommonPoints } from '../src/renderer/src/components/ProfileSummary';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

const state = vi.hoisted(() => ({
  medals: vi.fn(),
  similarity: vi.fn(),
  retry: vi.fn(),
  online: true,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      profileExtras: {
        medalWall: { useQuery: state.medals },
        similarity: { useQuery: state.similarity },
      },
    },
  },
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    available: state.online,
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source' },
  }),
}));
vi.mock('../src/renderer/src/lib/openExternalLink', () => ({
  openExternalLink: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../src/renderer/src/lib/resourceUrl', () => ({
  collectionImageUrl: (url: string) => url,
}));
const data = {
  targetUin: '10002',
  count: 0,
  openFlag: 1,
  newCount: 0,
  upgradeCount: 2,
  detailsUrl: 'https://ti.qq.com/qqmedal2/index.html?tuin=10002',
};
const result = (value: unknown) => ({
  data: value,
  error: null,
  isFetching: false,
  refetch: state.retry,
});
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  state.online = true;
  state.medals.mockReturnValue(result(data));
  state.similarity.mockReturnValue(
    result({
      targetUin: '10002',
      items: [{ icon: null, title: '同校', wordings: ['合成学校', '<img src=x>'] }],
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('勋章页保留零计数，开关一表示关闭而不是开启', async () => {
  await act(async () => root.render(h(MedalWall, { uin: '10002' })));
  expect(host.textContent).toContain('勋章数量0 枚');
  expect(host.textContent).toContain('展示状态已关闭');
  expect(host.textContent).toContain('新获勋章0 枚');
  expect(host.textContent).toContain('升级勋章2 枚');
  expect(host.querySelectorAll('button')).toHaveLength(1);
});
it('独立接口缺失的展示状态、新获和升级不补成零', async () => {
  state.medals.mockReturnValue(
    result({ ...data, openFlag: null, newCount: null, upgradeCount: null }),
  );
  await act(async () => root.render(h(MedalWall, { uin: '10002' })));
  expect(host.querySelectorAll('.weq-profile-data-row')).toHaveLength(1);
  expect(host.textContent).not.toContain('已关闭');
});
it('错目标、离线与失败不当作空墙，刷新失败保留已读内容', async () => {
  state.medals.mockReturnValue(result({ ...data, targetUin: '10003' }));
  await act(async () => root.render(h(MedalWall, { uin: '10002' })));
  expect(host.textContent).not.toContain('0 枚');
  expect(host.textContent).toContain('读取失败');
  state.medals.mockReturnValue({ ...result(data), error: new Error('暂不可读') });
  await act(async () => root.render(h(MedalWall, { uin: '10002' })));
  expect(host.textContent).toContain('0 枚');
  await act(async () =>
    host.querySelector<HTMLButtonElement>('.weq-profile-inline-error button')!.click(),
  );
  expect(state.retry).toHaveBeenCalledOnce();
  state.online = false;
  state.medals.mockReturnValue(result(undefined));
  await act(async () => root.render(h(MedalWall, { uin: '10002' })));
  expect(host.textContent).toContain('暂不可在线读取');
  expect(state.medals.mock.calls.at(-1)?.[1].enabled).toBe(false);
});
it('共同点以服务端文本显示，成功空列表独立显示，离开章节禁用查询', async () => {
  await act(async () => root.render(h(ProfileCommonPoints, { uin: '10002' })));
  expect(host.textContent).toContain('合成学校');
  expect(host.textContent).toContain('<img src=x>');
  expect(host.querySelector('img')).toBeNull();
  state.similarity.mockReturnValue(result({ targetUin: '10002', items: [] }));
  await act(async () =>
    root.render(h(TabActivity, { active: false }, h(ProfileCommonPoints, { uin: '10002' }))),
  );
  expect(host.textContent).toContain('暂无可展示的共同点');
  expect(state.similarity.mock.calls.at(-1)?.[1].enabled).toBe(false);
});
