import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QqArk } from '../src/renderer/src/components/ark/QqArk';
import {
  groupShareTarget,
  sharedGroupConversation,
} from '../src/renderer/src/components/ark/groupShareCard';
import { buildContactPlaceholderArk } from '../src/renderer/src/im-template/template/arkCards';
import { ChatNavigationContext } from '../src/renderer/src/lib/chatNavigation';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';

vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {}, client: {} }));

const code = '123456789';
const target = {
  code,
  name: '合成群聊',
  avatar: `https://p.qlogo.cn/gh/${code}/${code}/0`,
};
const ark = {
  app: 'com.tencent.troopsharecard',
  meta: {
    contact: {
      title: target.name,
      avatar: target.avatar,
      jumpUrl: `mqqapi://card/show_pslcard?src_type=internal&version=1&card_type=group&uin=${code}`,
    },
  },
};
const cleanups: Array<() => void> = [];
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(known = false, data: unknown = ark) {
  const openChat = vi.fn();
  const parentClick = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const conversation = sharedGroupConversation(target);
  conversation.group.memberCount = 23;
  conversation.group.announcement = '合成公告';
  act(() =>
    root.render(
      h(
        ChatNavigationContext.Provider,
        { value: openChat },
        h(
          ConversationDirectoryContext.Provider,
          {
            value: {
              real: known ? [conversation] : [],
              virtual: [],
              onVirtual: vi.fn(),
              onCreate: vi.fn(),
            },
          },
          h('div', { onClick: parentClick }, h(QqArk, { arkData: data })),
        ),
      ),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, openChat, parentClick, conversation };
}

describe('群名片消息', () => {
  it('解析群分享与推荐群占位卡，保留精确群号', () => {
    expect(groupShareTarget(ark.app, ark.meta)).toEqual(target);
    const placeholder = JSON.parse(buildContactPlaceholderArk('group', Number(code)));
    expect(groupShareTarget(placeholder.app, placeholder.meta)?.code).toBe(code);
    expect(
      groupShareTarget('com.tencent.contact.lua', {
        contact: { type: 'group', id: code, title: target.name },
      }),
    ).toEqual(target);
  });

  it('拒绝好友、伪造链接及无效群号，不从文案或头像猜身份', () => {
    for (const jumpUrl of [
      `mqqapi://card.evil/show_pslcard?card_type=group&uin=${code}`,
      `mqqapi://card/show_pslcard?uin=${code}`,
      `https://evil.example/?card_type=group&uin=${code}`,
      'mqqapi://card/show_pslcard?card_type=group&uin=0',
      'mqqapi://card/show_pslcard?card_type=group&uin=1e8',
      'not-a-url',
    ])
      expect(
        groupShareTarget(ark.app, {
          contact: { title: code, avatar: target.avatar, jumpUrl },
        }),
      ).toBeNull();
    expect(groupShareTarget('unknown', ark.meta)).toBeNull();
    expect(
      groupShareTarget('com.tencent.contact.lua', { contact: { type: 'qq', id: code } }),
    ).toBeNull();
    expect(groupShareTarget(ark.app, { contact: { id: Number.MAX_SAFE_INTEGER + 1 } })).toBeNull();
  });

  it('点击显示已有群资料，随后跳转到同一个群会话', () => {
    const f = fixture(true);
    const external = vi.spyOn(window, 'open');
    act(() => f.host.querySelector<HTMLElement>('[title="查看群名片"]')!.click());
    const dialog = document.querySelector('[role="dialog"][aria-label="群资料"]')!;
    expect(dialog.textContent).toContain(target.name);
    expect(dialog.textContent).toContain(code);
    expect(dialog.textContent).toContain('23');
    expect(dialog.textContent).toContain('合成公告');
    expect(f.openChat).not.toHaveBeenCalled();
    expect(f.parentClick).not.toHaveBeenCalled();
    const open = [...dialog.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('查看群聊消息'),
    )!;
    act(() => open.click());
    expect(f.openChat).toHaveBeenCalledWith({ kind: 'group', conversation: f.conversation });
    expect(document.querySelector('[aria-label="群资料"]')).toBeNull();
    expect(external).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '])('键盘 %s 打开未收录群，不虚构群人数，关闭后可再次打开', (key) => {
    const f = fixture();
    const card = f.host.querySelector<HTMLElement>('[title="查看群名片"]')!;
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    const dialog = document.querySelector('[aria-label="群资料"]')!;
    expect(dialog.textContent).toContain(target.name);
    expect(dialog.querySelector('.weq-profile-members')).toBeNull();
    expect(dialog.querySelector('.weq-profile-list')).toBeNull();
    act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    expect(document.querySelector('[aria-label="群资料"]')).toBeNull();
    act(() => card.click());
    const open = [
      ...document.querySelectorAll<HTMLButtonElement>('[aria-label="群资料"] button'),
    ].find((button) => button.textContent?.includes('查看群聊消息'))!;
    act(() => open.click());
    expect(f.openChat).toHaveBeenCalledWith({
      kind: 'group',
      conversation: expect.objectContaining({ id: code, type: 'group' }),
    });
  });

  it('未知群号仍保留消息展示，不显示群名片按钮', () => {
    const f = fixture(false, {
      ...ark,
      meta: { contact: { title: target.name, desc: '推荐群聊' } },
    });
    expect(f.host.textContent).toContain(target.name);
    expect(f.host.querySelector('[title="查看群名片"]')).toBeNull();
  });
});
