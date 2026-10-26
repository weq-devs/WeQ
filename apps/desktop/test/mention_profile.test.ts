import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ConvContext,
  ForwardKindContext,
  QqMessageContent,
  ReplyJumpContext,
} from '../src/renderer/src/components/QqMessageContent';
import { ProfileNavigationContext } from '../src/renderer/src/lib/profileNavigation';
import { messageNodeClipboard } from '../src/renderer/src/lib/messageClipboard';

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

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

const at = (data: Record<string, unknown>) => ({
  type: 'at',
  data: { textContent: '@合成成员 ', ...data },
});

function mount(
  elements: Array<{ type: string; data: Record<string, unknown> }>,
  { navigation = true, group = true, conv = '12345' } = {},
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const open = vi.fn();
  const jump = vi.fn();
  const bubbleClick = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let content: ReactNode = h(QqMessageContent, { elements, sendTimeMs: 0, msgId: 'fixture' });
  content = h(ReplyJumpContext.Provider, { value: jump }, content);
  content = h(ConvContext.Provider, { value: conv }, content);
  content = h(ForwardKindContext.Provider, { value: group ? 'group' : 'c2c' }, content);
  content = h(ProfileNavigationContext.Provider, { value: navigation ? open : null }, content);
  act(() => root.render(h('div', { onClick: bubbleClick }, content)));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return {
    host,
    open,
    jump,
    bubbleClick,
    mentions: () => [...host.querySelectorAll<HTMLElement>('.qq-at-element')],
  };
}

it('普通 @ 使用消息中的 UID 打开名片，传递群上下文并保留 UID 提示', () => {
  const f = mount([at({ atTargetUid: 'u_unloaded' })]);
  const mention = f.mentions()[0]!;
  act(() =>
    mention.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 1, clientX: 80, clientY: 90 }),
    ),
  );
  expect(f.open).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'u_unloaded',
      identityValue: 'u_unloaded',
      displayName: '合成成员',
    }),
    { x: 80, y: 90 },
    { code: '12345', name: '' },
  );
  expect(mention.title).toContain('u_unloaded');
  expect(f.bubbleClick).not.toHaveBeenCalled();
});

it.each([
  { atTargetUin: 10009 },
  { textEncodingFlag: 10009 },
  { atTargetUid: 'invalid', atTargetUin: '10009' },
])('明确 QQ 号可以打开名片，不能伪装成 UID：%j', (identity) => {
  const f = mount([at(identity)], { group: false, conv: '10008' });
  act(() => f.mentions()[0]!.click());
  expect(f.open).toHaveBeenCalledWith(
    expect.objectContaining({ id: '', identityLabel: 'QQ', identityValue: '10009' }),
    expect.anything(),
    undefined,
  );
});

it('同名的 @ 严格使用各自身份，不按显示文字或消息发送者猜测', () => {
  const f = mount([at({ atTargetUid: 'u_alice' }), at({ atTargetUid: 'u_bob' })]);
  act(() => {
    f.mentions()[0]!.click();
    f.mentions()[1]!.click();
  });
  expect(f.open.mock.calls.map(([user]) => user.id)).toEqual(['u_alice', 'u_bob']);
});

it('引用预览中的 @ 打开名片，不触发引用跳转，引用其它位置仍能跳转', () => {
  const f = mount([
    {
      type: 'reply',
      data: {
        origMsgSeq: '99',
        origElements: [at({ atTargetUid: 'u_quoted', atTargetUin: 10009 })],
      },
    },
  ]);
  const mention = f.mentions()[0]!;
  act(() => mention.click());
  expect(f.open.mock.calls[0]?.[0]).toMatchObject({ id: 'u_quoted', identityValue: '10009' });
  expect(f.jump).not.toHaveBeenCalled();
  expect(mention.dataset.weqAtUin).toBe('10009');
  act(() => f.host.querySelector<HTMLElement>('.qq-reply-quote-sender')!.click());
  expect(f.jump).toHaveBeenCalledOnce();
});

it.each(['Enter', ' '])('键盘 %j 可打开引用里的名片，不触发跳转或页面滚动', (key) => {
  const f = mount([
    { type: 'reply', data: { origMsgSeq: '99', origElements: [at({ atTargetUid: 'u_peer' })] } },
  ]);
  const mention = f.mentions()[0]!;
  expect(mention.tabIndex).toBe(0);
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => mention.dispatchEvent(event));
  expect(f.open).toHaveBeenCalledOnce();
  expect(f.jump).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(true);
});

it.each([
  { atTargetUid: 'all', atTargetUin: 10009 },
  { atTargetUid: 'u_peer', all: true },
  { atTargetUid: 'invalid' },
  { atTargetUin: 0 },
  {},
])('全体成员或缺少有效身份的 @ 不提供无效名片入口：%j', (identity) => {
  const f = mount([at(identity)]);
  const mention = f.mentions()[0]!;
  expect(mention.getAttribute('role')).not.toBe('button');
  expect(mention.classList.contains('cursor-pointer')).toBe(false);
  act(() => mention.click());
  expect(f.open).not.toHaveBeenCalled();
});

it('没有名片宿主时仅保留 @ 文字和身份，不显示可点击外观', () => {
  const f = mount([at({ atTargetUid: 'u_peer' })], { navigation: false });
  expect(f.mentions()[0]!.getAttribute('role')).not.toBe('button');
  expect(f.mentions()[0]!.classList.contains('cursor-pointer')).toBe(false);
  expect(f.host.textContent).toBe('@合成成员 ');
});

it('可点击的 @ 保留原始文字、换行与复制身份，不混入名片操作文案', () => {
  const f = mount([
    { type: 'text', data: { textContent: '前\n' } },
    at({ atTargetUid: 'u_peer', atTargetUin: 10009 }),
    { type: 'text', data: { textContent: '后' } },
  ]);
  const copied = messageNodeClipboard(f.host);
  expect(copied.text).toBe('前\n@合成成员 后');
  expect(copied.html).toContain('data-weq-at-uid="u_peer"');
  expect(copied.html).toContain('data-weq-at-uin="10009"');
  expect(copied.html).not.toContain('查看');
});
