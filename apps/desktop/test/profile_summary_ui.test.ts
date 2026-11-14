import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProfileCommonPoints } from '../src/renderer/src/components/ProfileSummary';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

const state = vi.hoisted(() => ({
  similarity: vi.fn(),
  retry: vi.fn(),
  online: true,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      profileExtras: {
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
vi.mock('../src/renderer/src/lib/resourceUrl', () => ({
  collectionImageUrl: (url: string) => url,
}));
const data = {
  targetUin: '10002',
  items: [{ icon: null, title: '同校', wordings: ['合成学校', '<img src=x>'] }],
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
  state.similarity.mockReturnValue(result(data));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('共同点错目标、离线与失败不当作空结果，刷新失败保留已读内容', async () => {
  state.similarity.mockReturnValue(result({ ...data, targetUin: '10003' }));
  await act(async () => root.render(h(ProfileCommonPoints, { uin: '10002' })));
  expect(host.textContent).not.toContain('合成学校');
  expect(host.textContent).toContain('读取失败');
  state.similarity.mockReturnValue({ ...result(data), error: new Error('暂不可读') });
  await act(async () => root.render(h(ProfileCommonPoints, { uin: '10002' })));
  expect(host.textContent).toContain('合成学校');
  await act(async () =>
    host.querySelector<HTMLButtonElement>('.weq-profile-inline-error button')!.click(),
  );
  expect(state.retry).toHaveBeenCalledOnce();
  state.online = false;
  state.similarity.mockReturnValue(result(undefined));
  await act(async () => root.render(h(ProfileCommonPoints, { uin: '10002' })));
  expect(host.textContent).toContain('暂不可在线读取');
  expect(state.similarity.mock.calls.at(-1)?.[1].enabled).toBe(false);
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
