import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GiftWall } from '../src/renderer/src/components/gift/GiftWall';
import {
  RelationshipDirectoryContext,
  type RelationshipDirectory,
} from '../src/renderer/src/lib/contactRelationship';
import { ProfileNavigationContext } from '../src/renderer/src/lib/profileNavigation';

const rpc = vi.hoisted(() => ({ wall: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { giftMall: { wall: { query: rpc.wall } } } },
}));
const cleanups: Array<() => void> = [];
const alice = {
  id: 'u_alice',
  identityLabel: 'QQ',
  identityValue: '10002',
  nick: '合成昵称',
  remark: '本地备注',
};
const directory: RelationshipDirectory = {
  friends: new Map([
    ['u_alice', alice],
    ['10002', alice],
  ]),
  friendsComplete: true,
  groups: new Map(),
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rpc.wall.mockImplementation(async ({ isSend }) => ({
    giftsList: [
      {
        giftId: 1,
        giftName: isSend ? '送出礼物' : '收到礼物',
        staticPic: '',
        giftPrice: 100,
        time: '2026.11.14 10:00',
        nick: '合成昵称',
        orderNum: 'synthetic-order',
      },
    ],
    extInfo: '',
    beginTime: 0,
    isEnd: true,
  }));
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.getSelection()?.removeAllRanges();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function mount(people: RelationshipDirectory | null = directory, navigation = true) {
  const open = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      h(
        ProfileNavigationContext.Provider,
        { value: navigation ? open : null },
        h(RelationshipDirectoryContext.Provider, { value: people }, h(GiftWall)),
      ),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return {
    host,
    open,
    person: () => host.querySelector<HTMLButtonElement>('.weq-gift-wall-person button'),
  };
}

it('收发两个方向的昵称打开同一个好友名片', async () => {
  const f = await mount();
  for (const send of [false, true]) {
    if (send)
      await act(async () =>
        f.host.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click(),
      );
    expect(f.person()?.textContent).toBe('合成昵称');
    expect(f.person()?.getAttribute('aria-label')).toBe('查看 合成昵称 的名片');
    act(() =>
      f
        .person()!
        .dispatchEvent(
          new MouseEvent('click', { bubbles: true, detail: 1, clientX: 40, clientY: 60 }),
        ),
    );
    expect(f.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'u_alice', identityValue: '10002' }),
      { x: 40, y: 60 },
      undefined,
    );
  }
  expect(f.open).toHaveBeenCalledTimes(2);
});

it('方向与时间不触发名片，键盘点击按昵称边缘定位', async () => {
  const f = await mount();
  const row = f.host.querySelector('small')!;
  act(() => {
    row.firstElementChild!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    row.lastElementChild!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(f.open).not.toHaveBeenCalled();
  vi.spyOn(f.person()!, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 50, 15));
  act(() => f.person()!.click());
  expect(f.open).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'u_alice' }),
    { x: 60, y: 35 },
    undefined,
  );
});

it('拖选昵称不打开名片，清除选区后恢复点击', async () => {
  const f = await mount();
  const range = document.createRange();
  range.selectNodeContents(f.person()!);
  document.getSelection()!.addRange(range);
  act(() => f.person()!.click());
  expect(f.open).not.toHaveBeenCalled();
  document.getSelection()!.removeAllRanges();
  act(() => f.person()!.click());
  expect(f.open).toHaveBeenCalledOnce();
});

it('备注也可匹配，同一好友的 UID/QQ 双索引不算重名', async () => {
  const f = await mount({
    ...directory,
    friends: new Map([['u_alice', { ...alice, nick: '另一个昵称', remark: '合成昵称' }]]),
  });
  act(() => f.person()!.click());
  expect(f.open.mock.calls[0]![0].identityValue).toBe('10002');
});

it.each(['同名昵称', '昵称与备注重名'])('%s 不猜测身份', async (kind) => {
  const other = {
    id: 'u_bob',
    identityLabel: 'QQ',
    identityValue: '10003',
    nick: kind === '同名昵称' ? alice.nick : '另一位',
    remark: kind === '昵称与备注重名' ? alice.nick : '',
  };
  const f = await mount({
    ...directory,
    friends: new Map([...directory.friends, ['u_bob', other]]),
  });
  expect(f.person()).toBeNull();
  expect(f.host.textContent).toContain('合成昵称');
});

it.each(['无目录', '名单截断', '未匹配', '无名片宿主'])('%s 保留昵称文字', async (kind) => {
  const f = await mount(
    kind === '无目录'
      ? null
      : {
          ...directory,
          friendsComplete: kind !== '名单截断',
          friends: kind === '未匹配' ? new Map() : directory.friends,
        },
    kind !== '无名片宿主',
  );
  expect(f.person()).toBeNull();
  expect(f.host.textContent).toContain('合成昵称');
});
