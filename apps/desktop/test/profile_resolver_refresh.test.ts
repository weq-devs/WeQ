import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  useProfileResolver,
  type ProfileResolver,
} from '../src/renderer/src/hooks/useProfileResolver';

type Profile = { uid: string; remark: string };
const mock = vi.hoisted(() => ({ query: vi.fn<() => Promise<Profile[]>>() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { getProfilesByUids: { query: mock.query } } },
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function fixture(primed: Profile[], fallback?: Profile[]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  let resolver!: ProfileResolver<Profile>;
  function Probe() {
    resolver = useProfileResolver(primed, fallback);
    return h('output', null, resolver.profileByUid.get('u_a')?.remark);
  }
  act(() => root.render(h(Probe)));
  cleanups.push(() => act(() => root.unmount()));
  return { host, get: () => resolver };
}
it('备注读回后可定向覆盖预热资料，不必刷新所有联系人', async () => {
  mock.query.mockReset().mockResolvedValue([{ uid: 'u_a', remark: '新备注' }]);
  const f = fixture([
    { uid: 'u_a', remark: '旧备注' },
    { uid: 'u_b', remark: '其他人' },
  ]);
  await act(async () => f.get().refreshProfiles(['u_a']));
  expect(mock.query).toHaveBeenCalledWith({ uids: ['u_a'] });
  expect(f.host.textContent).toBe('新备注');
  expect(f.get().profileByUid.get('u_b')?.remark).toBe('其他人');
});
it('迟到的首次补全不能覆盖保存后的新读回', async () => {
  let finish!: (profiles: Profile[]) => void;
  mock.query
    .mockReset()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce([{ uid: 'u_a', remark: '新备注' }]);
  const f = fixture([]);
  act(() => f.get().resolveProfiles(['u_a']));
  await act(async () => f.get().refreshProfiles(['u_a']));
  await act(async () => {
    finish([{ uid: 'u_a', remark: '迟到的旧备注' }]);
  });
  expect(f.host.textContent).toBe('新备注');
});
it('保存后的刷新使用绑定来源的读取，不退回无绑定查询', async () => {
  mock.query.mockReset().mockResolvedValue([{ uid: 'u_a', remark: '错误来源' }]);
  const read = vi.fn(async () => [{ uid: 'u_a', remark: '绑定来源' }]);
  const f = fixture([{ uid: 'u_a', remark: '原备注' }]);
  await act(async () => f.get().refreshProfiles(['u_a'], () => true, read));
  expect(read).toHaveBeenCalledWith(['u_a']);
  expect(mock.query).not.toHaveBeenCalled();
  expect(f.host.textContent).toBe('绑定来源');
});
it('不把响应里未请求的 UID 合并进资料缓存', async () => {
  mock.query.mockReset().mockResolvedValue([
    { uid: 'u_a', remark: '新备注' },
    { uid: 'u_other', remark: '无关资料' },
  ]);
  const f = fixture([{ uid: 'u_a', remark: '原备注' }]);
  await act(async () => f.get().refreshProfiles(['u_a']));
  expect(f.get().profileByUid.has('u_other')).toBe(false);
});
it('持久快照先显示但不阻止按需刷新，也不覆盖本地目录的新备注', async () => {
  mock.query.mockReset().mockResolvedValue([{ uid: 'u_a', remark: '读回备注' }]);
  const f = fixture(
    [{ uid: 'u_b', remark: '本地新备注' }],
    [
      { uid: 'u_a', remark: '缓存备注' },
      { uid: 'u_b', remark: '旧缓存备注' },
    ],
  );
  expect(f.host.textContent).toBe('缓存备注');
  expect(f.get().profileByUid.get('u_b')?.remark).toBe('本地新备注');
  await act(async () => f.get().resolveProfiles(['u_a', 'u_b']));
  expect(mock.query).toHaveBeenCalledWith({ uids: ['u_a'] });
  expect(f.host.textContent).toBe('读回备注');
});

it('相同刷新不重建资料 Map，单行变更保留其他行，空备注仍清空', async () => {
  mock.query.mockReset().mockImplementation(async () => [
    { uid: 'u_a', remark: '甲' },
    { uid: 'u_b', remark: '乙' },
  ]);
  const f = fixture([]);
  await act(async () => f.get().refreshProfiles(['u_a', 'u_b']));
  const first = f.get().profileByUid;
  await act(async () => f.get().refreshProfiles(['u_a', 'u_b']));
  expect(mock.query).toHaveBeenCalledTimes(2);
  expect(f.get().profileByUid).toBe(first);
  mock.query.mockResolvedValueOnce([
    { uid: 'u_a', remark: '' },
    { uid: 'u_b', remark: '乙' },
  ]);
  await act(async () => f.get().refreshProfiles(['u_a', 'u_b']));
  expect(f.get().profileByUid.get('u_b')).toBe(first.get('u_b'));
  expect(f.get().profileByUid.get('u_a')?.remark).toBe('');
});

it('等值刷新继续阻止迟到首次补全，拒绝旧结果不重建 Map', async () => {
  let finish!: (profiles: Profile[]) => void;
  mock.query.mockReset().mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = fixture([]);
  const read = async () => [{ uid: 'u_a', remark: '当前备注' }];
  await act(async () => f.get().refreshProfiles(['u_a'], () => true, read));
  const first = f.get().profileByUid;
  act(() => f.get().resolveProfiles(['u_a']));
  await act(async () => f.get().refreshProfiles(['u_a'], () => true, read));
  await act(async () => finish([{ uid: 'u_a', remark: '迟到旧备注' }]));
  expect(f.get().profileByUid).toBe(first);
  expect(f.host.textContent).toBe('当前备注');
});
