import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TipGroupElementType } from '@weq/codec';
import { GrayTipPokeMessage } from '../src/renderer/src/components/GrayTipPokeMessage';
import { GrayTipGroupMessage } from '../src/renderer/src/components/GrayTipGroupMessage';
import { GrayTipXmlMessage } from '../src/renderer/src/components/GrayTipXmlMessage';
import { GrayTipRevokeMessage } from '../src/renderer/src/components/GrayTipRevokeMessage';
import { GrayTipLine } from '../src/renderer/src/im-template/template/messageRow';
import { grayTipProfileTarget } from '../src/renderer/src/lib/grayTipProfile';
import { ProfileNavigationContext } from '../src/renderer/src/lib/profileNavigation';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { GroupMember } from '../src/renderer/src/im-template/template/types';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/renderer/src/components/FaceEmoji', () => ({
  FaceEmoji: () => h('span', { role: 'img', 'aria-label': '表情' }, '表情'),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (key === 'useQuery') return () => ({ data: undefined, isLoading: false });
        if (key === 'useMutation') return () => ({ mutate() {}, isLoading: false });
        return proxy();
      },
    });
  return { trpc: proxy(), client: proxy() };
});

const demo = createTemplateDemoData();
const alice: GroupMember = {
  ...demo.user,
  id: 'u_alice',
  identityValue: '10002',
  displayName: '同名',
  role: 'member',
  joinedAt: '',
};
const bob: GroupMember = { ...alice, id: 'u_bob', identityValue: '10003' };
const baseGroup = demo.conversations.find((item) => item.type === 'group')!;
const group = {
  ...baseGroup,
  id: '12345',
  group: { ...baseGroup.group, identityValue: '12345', name: '合成群' },
  members: [alice, bob],
};
const message = { ...demo.messages[0]!, sender: alice };
const self = { ...demo.user, id: 'self:10001', uid: 'u_self', identityValue: '10001' };
const cleanups: Array<() => void> = [];
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(content: ReactNode, navigation = true) {
  const open = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(h(ProfileNavigationContext.Provider, { value: navigation ? open : null }, content)),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, open, people: () => [...host.querySelectorAll<HTMLButtonElement>('button')] };
}

it('戳一戳灰条中同名的两个人分别打开自己的名片', () => {
  const f = mount(
    h(GrayTipPokeMessage, {
      conversation: group,
      message,
      user: self,
      element: {
        type: 'grayTipPoke',
        data: {
          grayTipXmlContent: '<gtip><qq uin="u_alice"/><nor txt="拍了拍"/><qq uin="u_bob"/></gtip>',
        },
      },
    }),
  );
  expect(f.people()).toHaveLength(2);
  act(() => f.people()[0]!.click());
  expect(f.open).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: 'u_alice', identityValue: '10002' }),
    expect.anything(),
    { code: '12345', name: '合成群' },
  );
  act(() => f.people()[1]!.click());
  expect(f.open).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: 'u_bob', identityValue: '10003' }),
    expect.anything(),
    { code: '12345', name: '合成群' },
  );
});

it('群提示使用明确的 user1Uid，不按昵称或消息发送人猜测身份', () => {
  const f = mount(
    h(GrayTipGroupMessage, {
      conversation: group,
      message,
      element: {
        type: 'grayTipGroup',
        data: {
          groupTipType: TipGroupElementType.KMEMBERADD,
          user1Nick: '同名',
          user1Uid: 'u_bob',
        },
      },
    }),
  );
  expect(f.people()).toHaveLength(1);
  act(() => f.people()[0]!.click());
  expect(f.open.mock.calls[0]![0]).toMatchObject({ id: 'u_bob', identityValue: '10003' });
});

it('XML 灰条支持 UID、明确 QQ 号和未加载的用户，不把数字当作 UID', () => {
  const f = mount(
    h(GrayTipXmlMessage, {
      conversation: group,
      message,
      element: {
        type: 'grayTipXml',
        data: {
          grayTipXmlContent:
            '<gtip><qq uin="u_unloaded" nm="未加载成员"/><nor txt="邀请了"/><qq uin="10009" nm="群外成员"/></gtip>',
        },
      },
    }),
  );
  expect(f.people()).toHaveLength(2);
  act(() => f.people()[0]!.click());
  expect(f.open.mock.calls[0]![0]).toMatchObject({ id: 'u_unloaded', identityValue: 'u_unloaded' });
  act(() => f.people()[1]!.click());
  expect(f.open.mock.calls[1]![0]).toMatchObject({ id: '', identityValue: '10009' });
});

it('JSON 人名按各自 UID 定位，普通链接、仅有昵称和数字动作参数不变成名片', () => {
  const f = mount(
    h(GrayTipPokeMessage, {
      conversation: group,
      message,
      element: {
        type: 'grayTipPoke',
        data: {
          tipJson: JSON.stringify({
            items: [
              { type: 'qq', uid: alice.id, nm: '同名' },
              { type: 'url', param: [bob.id], nm: '同名' },
              { type: 'url', param: ['https://example.invalid'], txt: '普通链接' },
              { type: 'url', param: ['10002'], txt: '数字动作参数' },
              { type: 'qq', nm: '仅有昵称' },
              { type: 'qq', uid: 12345, nm: '非字符串身份' },
            ],
          }),
        },
      },
    }),
  );
  expect(f.people()).toHaveLength(2);
  act(() => f.people()[1]!.click());
  expect(f.open.mock.calls[0]![0]).toMatchObject({ id: bob.id, identityValue: bob.identityValue });
  expect(f.host.textContent).toContain('普通链接数字动作参数仅有昵称非字符串身份');
});

it('缺少身份或出现明确 UID／QQ 号冲突时不按同名发送者兜底', () => {
  const f = mount(
    h(GrayTipPokeMessage, {
      conversation: group,
      message,
      user: self,
      element: {
        type: 'grayTipPoke',
        data: {
          grayTipXmlContent:
            '<gtip><qq nm="同名"/><qq nm="你"/><qq uin="10003" uid="u_alice" nm="冲突身份"/><qq uin="javascript:alert(1)" nm="无效身份"/></gtip>',
        },
      },
    }),
  );
  expect(f.people()).toHaveLength(0);
  expect(f.open).not.toHaveBeenCalled();
  expect(grayTipProfileTarget([], '同名', group, message, self)).toBeUndefined();
  expect(grayTipProfileTarget([null, 10002, {}], '同名', group, message, self)).toBeUndefined();
  expect(
    grayTipProfileTarget(
      ['bad-user'],
      '同名',
      { ...group, members: [{ ...alice, id: 'bad-user' }] },
      message,
      self,
    ),
  ).toBeUndefined();
  expect(grayTipProfileTarget(['self:10001'], '你', group, message, self)).toMatchObject({
    identity: 'u_self',
    uin: '10001',
  });
});

it.each(['qq', 'url'])('数字参数只有明确的 qq 人名节点可用（%s）', (type) => {
  const f = mount(
    h(GrayTipPokeMessage, {
      conversation: group,
      message,
      element: {
        type: 'grayTipPoke',
        data: {
          tipJson: JSON.stringify({
            items: [{ type, param: [bob.identityValue], nm: '参数中的成员' }],
          }),
        },
      },
    }),
  );
  expect(f.people()).toHaveLength(type === 'qq' ? 1 : 0);
  if (type === 'qq') {
    act(() => f.people()[0]!.click());
    expect(f.open.mock.calls[0]![0]).toMatchObject({
      id: bob.id,
      identityValue: bob.identityValue,
    });
  }
});

it('同一人重复出现时各节点均可点击，不产生重复组件键', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = mount(
    h(GrayTipPokeMessage, {
      conversation: group,
      message,
      element: {
        type: 'grayTipPoke',
        data: {
          grayTipXmlContent:
            '<gtip><qq uin="u_alice"/><nor txt="拍了拍"/><qq uin="u_alice"/></gtip>',
        },
      },
    }),
  );
  expect(f.people()).toHaveLength(2);
  act(() => {
    f.people()[0]!.click();
    f.people()[1]!.click();
  });
  expect(f.open).toHaveBeenCalledTimes(2);
  expect(f.open.mock.calls.every(([person]) => person.id === alice.id)).toBe(true);
  expect(errors).not.toHaveBeenCalled();
});

it('禁言灰条的目标和操作者各自定位，群名不是用户入口', () => {
  const f = mount(
    h(GrayTipGroupMessage, {
      conversation: group,
      message,
      element: {
        type: 'grayTipGroup',
        data: {
          groupTipType: TipGroupElementType.KSHUTUP,
          muteInfo: {
            operator: { uid: alice.id },
            mutedUser: { uid: bob.id, groupNick: '目标成员' },
            duration: 60,
          },
        },
      },
    }),
  );
  expect(f.people()).toHaveLength(2);
  act(() => f.people()[0]!.click());
  expect(f.open.mock.calls[0]![0].id).toBe(bob.id);
  act(() => f.people()[1]!.click());
  expect(f.open.mock.calls[1]![0].id).toBe(alice.id);
  const rename = mount(
    h(GrayTipGroupMessage, {
      conversation: group,
      message,
      element: {
        type: 'grayTipGroup',
        data: {
          groupTipType: TipGroupElementType.KGROUPNAMEMODIFIED,
          user1Uid: alice.id,
          user1Nick: '同名',
          groupTipGroupName: '10003',
        },
      },
    }),
  );
  expect(rename.people()).toHaveLength(1);
  expect(rename.host.textContent).toContain('10003');
});

it('撤回灰条分别定位操作者和原作者，自己的别名复用真实身份', () => {
  const f = mount(
    h(GrayTipRevokeMessage, {
      conversation: group,
      message,
      user: self,
      element: {
        type: 'grayTipRevoke',
        data: { recallSenderUid: bob.id, recallSenderNick: '同名', recallRevokeUid: 'u_self' },
      },
    }),
  );
  expect(f.people()).toHaveLength(2);
  act(() => f.people()[0]!.click());
  expect(f.open.mock.calls[0]![0]).toMatchObject({
    id: 'u_self',
    identityValue: '10001',
    displayName: '你',
  });
  act(() => f.people()[1]!.click());
  expect(f.open.mock.calls[1]![0].id).toBe(bob.id);
});

it('共用灰条行传递自己的身份，无名片宿主时只显示文字', () => {
  const gt = {
    kind: 'grayTipXml',
    el: {
      type: 'grayTipXml',
      data: { grayTipXmlContent: '<gtip><qq uin="u_self" nm="自己"/></gtip>' },
    },
  };
  const f = mount(h(GrayTipLine, { gt, conversation: group, message, user: self }));
  expect(f.people()).toHaveLength(1);
  act(() => f.people()[0]!.click());
  expect(f.open.mock.calls[0]![0]).toMatchObject({ id: 'u_self', identityValue: '10001' });
  const fallback = mount(h(GrayTipLine, { gt, conversation: group, message, user: self }), false);
  expect(fallback.people()).toHaveLength(0);
  expect(fallback.host.textContent).toBe('自己');
});

it('灰条名片的合成布局', () => {
  const f = mount(
    h(
      'div',
      null,
      h(GrayTipPokeMessage, {
        conversation: group,
        message,
        user: self,
        element: {
          type: 'grayTipPoke',
          data: {
            grayTipXmlContent:
              '<gtip><qq uin="u_self" nm="自己"/><nor txt="拍了拍"/><qq uin="u_alice" nm="成员"/></gtip>',
          },
        },
      }),
      h(GrayTipGroupMessage, {
        conversation: group,
        message,
        element: {
          type: 'grayTipGroup',
          data: {
            groupTipType: TipGroupElementType.KGROUPNAMEMODIFIED,
            user1Uid: alice.id,
            user1Nick: '很长很长的合成群成员昵称用于检查换行',
            groupTipGroupName: '合成的新群名',
          },
        },
      }),
      h(GrayTipXmlMessage, {
        conversation: group,
        element: {
          type: 'grayTipXml',
          data: {
            grayTipXmlContent:
              '<gtip><qq uin="10009" nm="群外成员"/><nor txt="邀请了"/><qq nm="身份未知的成员"/></gtip>',
          },
        },
      }),
    ),
  );
  const output = process.env.WEQ_GRAYTIP_LAYOUT;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  const styles = ['index.css', 'profile-avatar.css', 'gray-tip-profile.css']
    .map((file) => `<link rel="stylesheet" href="/@fs${resolve('src/renderer/src/styles', file)}">`)
    .join('');
  writeFileSync(
    resolve(output, 'gray-tip-profile.html'),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${styles}<style>html,body{margin:0;font-family:system-ui;background:var(--background);color:var(--foreground)}*,*::before,*::after{box-sizing:border-box}main{padding:24px;max-width:900px;margin:auto}.weq-graytip{padding:12px;border-bottom:1px solid var(--border)}</style><body><main>${f.host.innerHTML}</main></body></html>`,
  );
});
