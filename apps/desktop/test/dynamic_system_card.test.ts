import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageRow } from '../src/renderer/src/im-template/template/messageRow';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { QzoneCardNavigationContext } from '../src/renderer/src/lib/qzoneNavigation';

const profile = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { getProfileByUin: { query: profile } } },
  trpc: {},
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const meta = (appid = '311') =>
  JSON.stringify({
    jump_schema: `mqqapi://qzoneschema/?schema=${encodeURIComponent(btoa(`mqzone://arouse/detail?appid=${appid}&uin=10001&cellid=synthetic_post&loginfrom=synthetic`))}`,
  });

it.each(['qqElements', 'elements'])(
  '%s 系统消息分支保留完整动态载荷，鼠标和键盘均能内部定位',
  async (field) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const demo = createTemplateDemoData(),
      conversation = demo.conversations.find((row) => row.type === 'direct')!;
    const element = {
      type: 'qqDynamic',
      data: {
        dynamicType: 2,
        dynamicMeta: meta(),
        dynamicPublisherUin: [10001],
        dynamicDesc2: { mainDesc: '合成动态摘要' },
        dynamicTags: [{ tagId: 1, tagContent: '合成标签' }],
      },
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host),
      navigate = vi.fn();
    try {
      await act(async () =>
        root.render(
          h(
            QzoneCardNavigationContext.Provider,
            { value: navigate },
            h(MessageRow, {
              message: {
                id: 'synthetic-msg',
                msgSeq: '734',
                conversationId: conversation.id,
                senderId: 'u_peer',
                createdAt: new Date(0).toISOString(),
                [field]: [element],
              },
              conversation,
              user: demo.user,
            }),
          ),
        ),
      );
      const link = host.querySelector<HTMLElement>('[role="link"]');
      expect(link).not.toBeNull();
      expect(host.textContent).toContain('说说动态');
      expect(host.textContent).toContain('合成动态摘要');
      expect(host.textContent).toContain('合成标签');
      expect(profile).toHaveBeenCalledWith({ uin: '10001' });
      act(() => link!.click());
      act(() => link!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })));
      act(() => link!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' })));
      expect(navigate.mock.calls).toEqual(
        Array.from({ length: 3 }, () => [{ kind: 'post', uin: '10001', tid: 'synthetic_post' }]),
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it('未知动态详情不从发布者或外层会话猜成主页或说说', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const demo = createTemplateDemoData(),
    conversation = demo.conversations.find((row) => row.type === 'direct')!;
  const host = document.createElement('div'),
    root = createRoot(host),
    navigate = vi.fn();
  try {
    await act(async () =>
      root.render(
        h(
          QzoneCardNavigationContext.Provider,
          { value: navigate },
          h(MessageRow, {
            message: {
              id: 'synthetic',
              conversationId: conversation.id,
              senderId: 'u_peer',
              createdAt: new Date(0).toISOString(),
              qqElements: [
                {
                  type: 'qqDynamic',
                  data: { dynamicType: 2, dynamicMeta: meta('4'), dynamicPublisherUin: [10001] },
                },
              ],
            },
            conversation,
            user: demo.user,
          }),
        ),
      ),
    );
    expect(host.querySelector('[role="link"]')).toBeNull();
    act(() => host.querySelector<HTMLElement>('.weq-dynamic-container')!.click());
    expect(navigate).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});
