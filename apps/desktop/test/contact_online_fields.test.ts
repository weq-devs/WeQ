import { act, createElement as h, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ContactOnlineOccupation,
  ContactOnlineRegion,
  ContactOnlineSchool,
} from '../src/renderer/src/components/contactProfile/ContactOnlineFields';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

const state = vi.hoisted(() => ({
  details: vi.fn(),
  education: vi.fn(),
  region: vi.fn(),
  retry: vi.fn(),
  online: true,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      profileExtras: {
        details: { useQuery: state.details },
        region: { useQuery: state.region },
        educationHistory: { useQuery: state.education },
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
const details = {
  targetUin: '10002',
  company: null,
  email: null,
  personalDescription: null,
  hometown: null,
  hometownText: null,
  school: '合成大学',
  profession: 1,
  errors: {},
};
const query = (data?: unknown) => ({ data, error: null, isFetching: false, refetch: state.retry });
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  state.online = true;
  state.details.mockReturnValue(query(details));
  state.region.mockReturnValue(query({ targetUin: '10002', regionText: '中国 · 四川 · 成都' }));
  state.education.mockReturnValue(query({ targetUin: '10002', items: [] }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('本地缺值的三个字段可以用真实读取模型补齐，学校仍从值进入完整教育经历', async () => {
  const open = vi.fn();
  await act(async () =>
    root.render(
      h(
        Fragment,
        null,
        h(ContactOnlineOccupation, { uin: '10002' }),
        h(ContactOnlineRegion, { uin: '10002' }),
        h(ContactOnlineSchool, { uin: '10002', onOpen: open }),
      ),
    ),
  );
  expect(host.textContent).toContain('计算机／互联网／通信');
  expect(host.textContent).toContain('中国 · 四川 · 成都');
  expect(host.textContent).toContain('合成大学');
  expect(state.education.mock.calls.at(-1)?.[1].enabled).toBe(false);
  await act(async () => host.querySelector<HTMLButtonElement>('.weq-profile-data-action')!.click());
  expect(open).toHaveBeenCalledOnce();
});
it('不能假设旧学校文本总存在；缺文本时用结构化经历并跳过隐藏记录', async () => {
  state.details.mockReturnValue(query({ ...details, school: null }));
  state.education.mockReturnValue(
    query({
      targetUin: '10002',
      items: [
        { index: 1, schoolName: '不可显示学校', hidden: 1, degree: 6 },
        { index: 2, schoolName: '公开学校', hidden: 0, degree: 6 },
      ],
    }),
  );
  await act(async () => root.render(h(ContactOnlineSchool, { uin: '10002', onOpen: vi.fn() })));
  expect(state.education.mock.calls.at(-1)?.[1].enabled).toBe(true);
  expect(host.textContent).toContain('公开学校 · 本科');
  expect(host.textContent).not.toContain('不可显示学校');
});
it('旧资料失败仍可独立读教育经历，已有学历不等待网络才显示', async () => {
  state.details.mockReturnValue({ ...query(), error: new Error('暂不可读') });
  state.education.mockReturnValue(
    query({
      targetUin: '10002',
      items: [{ index: 1, schoolName: '公开学校', hidden: 0, degree: 8 }],
    }),
  );
  await act(async () =>
    root.render(h(ContactOnlineSchool, { uin: '10002', cachedDegree: '本科', onOpen: vi.fn() })),
  );
  expect(host.textContent).toContain('公开学校 · 本科');
  state.details.mockReturnValue({ ...query(), isFetching: true });
  state.education.mockReturnValue(query());
  await act(async () =>
    root.render(h(ContactOnlineSchool, { uin: '10002', cachedDegree: '本科', onOpen: vi.fn() })),
  );
  expect(host.textContent).toContain('本科');
});
it('错目标数据不进入当前行；读取失败有重试，不伪装成未填写', async () => {
  state.region.mockReturnValue(query({ targetUin: '10003', regionText: '错误地区' }));
  await act(async () => root.render(h(ContactOnlineRegion, { uin: '10002' })));
  expect(host.textContent).not.toContain('错误地区');
  expect(host.textContent).toContain('读取失败');
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(state.retry).toHaveBeenCalledOnce();
});
it('关闭章节或离线不启动补全，成功无值不画空行', async () => {
  state.details.mockReturnValue(query({ ...details, school: null, profession: 0 }));
  await act(async () =>
    root.render(h(TabActivity, { active: false }, h(ContactOnlineOccupation, { uin: '10002' }))),
  );
  expect(state.details.mock.calls.at(-1)?.[1].enabled).toBe(false);
  expect(host.querySelector('.weq-profile-data-row')).toBeNull();
  state.online = false;
  await act(async () => root.render(h(ContactOnlineRegion, { uin: '10002' })));
  expect(state.region.mock.calls.at(-1)?.[1].enabled).toBe(false);
});
