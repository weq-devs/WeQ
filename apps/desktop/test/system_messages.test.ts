import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { GrayTipRevokeMessage } from '../src/renderer/src/components/GrayTipRevokeMessage';
import { MessageRow, grayTipOf } from '../src/renderer/src/im-template/template/messageRow';
import { SetEmojiReactions } from '../src/renderer/src/components/SetEmojiReactions';
import {
  ShowMessageTimeContext,
  ShowMessageSeqContext,
} from '../src/renderer/src/components/MessageProvenance';
import { createTemplateDemoData } from './support/templateDemoData';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (key === 'useQuery') return () => ({ data: undefined, isLoading: false });
        if (key === 'useMutation') return () => ({ mutate: () => undefined, isLoading: false });
        return proxy();
      },
    });
  return { trpc: proxy(), client: proxy() };
});

const demo = createTemplateDemoData();
const user = { ...demo.user, id: 'self:10001', identityValue: '10001', uid: 'u_self' };
const group = demo.conversations.find((item) => item.type === 'group')!;
const direct = demo.conversations.find((item) => item.type === 'direct')!;
const message = { ...demo.messages[0]!, createdAt: '2026-10-16T23:35:11Z', msgSeq: '42' };
const text = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.textContent;

describe('撤回灰条的精确身份', () => {
  it.each(['u_self', '10001', 'self:10001'])('自己的 %s 不依赖群成员缓存或昵称', (id) => {
    const html = renderToStaticMarkup(
      createElement(GrayTipRevokeMessage, {
        user,
        conversation: { ...group, members: [] },
        element: {
          type: 'grayTipRevoke',
          data: { recallSenderUid: id, recallRevokeUid: id, recallDisplayText: '并抱了你一下' },
        },
      }),
    );
    expect(text(html)).toBe('你撤回了一条消息并抱了你一下');
  });
  it('自己的 UID 与 UIN 混用仍认作同一人，私聊同样成立', () => {
    const html = renderToStaticMarkup(
      createElement(GrayTipRevokeMessage, {
        user,
        conversation: direct,
        element: {
          type: 'grayTipRevoke',
          data: { recallSenderUid: 'u_self', recallRevokeUid: '10001' },
        },
      }),
    );
    expect(text(html)).toBe('你撤回了一条消息');
  });
  it('不同 UID 即使同名也不当作自己撤回自己，未知身份不伪称管理员', () => {
    const different = renderToStaticMarkup(
      createElement(GrayTipRevokeMessage, {
        user,
        conversation: group,
        element: {
          type: 'grayTipRevoke',
          data: {
            recallSenderUid: 'u_other',
            recallRevokeUid: 'u_self',
            recallSenderNick: '同名',
            recallRevokeNick: '同名',
          },
        },
      }),
    );
    expect(text(different)).toBe('你撤回了一条群成员同名的消息');
    const unknown = renderToStaticMarkup(
      createElement(GrayTipRevokeMessage, { element: { type: 'grayTipRevoke', data: {} } }),
    );
    expect(text(unknown)).not.toContain('管理员');
  });
});

describe('系统消息共用行', () => {
  it('正文与时间放在同一行容器，不输出 seq', () => {
    const system = {
      ...message,
      qqElements: [
        { type: 'grayTipRevoke', data: { recallSenderUid: 'u_self', recallRevokeUid: 'u_self' } },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(
        ShowMessageSeqContext.Provider,
        { value: true },
        createElement(
          ShowMessageTimeContext.Provider,
          { value: true },
          createElement(MessageRow, { message: system, conversation: group, user }),
        ),
      ),
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const line = doc.querySelector('.weq-system-message-content');
    expect(line?.querySelector('.weq-graytip')).not.toBeNull();
    expect(line?.querySelector('time')?.textContent).toBe('07:35:11');
    expect(doc.querySelector('.weq-message-seq')).toBeNull();
  });
  it.each([
    'grayTipRevoke',
    'grayTipPoke',
    'grayTipGroup',
    'grayTipXml',
    'grayTipFileRecv',
    'grayTipTempSession',
    'qqDynamic',
  ])('动作禁用沿用灰条分类 %s', (type) => {
    expect(grayTipOf({ qqElements: [{ type, data: {} }] })).not.toBeNull();
  });
});

describe('撤回自己的贴表情', () => {
  it('回应条仅撤回自己的回应，离线时保留查看名单但不提交请求', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onChange = vi.fn();
    const render = (blockedReason?: string) =>
      act(() =>
        root.render(
          createElement(SetEmojiReactions, {
            groupId: '10001',
            sequence: 42,
            list: [
              { emojiId: '14', setNum: 2, isSelfSet: true },
              { emojiId: '76', setNum: 1, isSelfSet: false },
            ],
            interaction: { onChange, blockedReason },
          }),
        ),
      );
    try {
      render();
      const own = host.querySelector<HTMLButtonElement>('[aria-label="撤回贴表情 14"]')!;
      expect(own).not.toBeNull();
      expect(host.querySelector('[aria-label="撤回贴表情 76"]')).toBeNull();
      expect(host.querySelector('[aria-label="跟贴表情 76"]')).not.toBeNull();
      act(() => own.click());
      expect(onChange).toHaveBeenLastCalledWith('14', false);
      onChange.mockClear();
      render('QQ 未在线');
      const offline = host.querySelector<HTMLButtonElement>('[aria-label="查看 14 的回应人"]')!;
      expect(offline.title).toBe('QQ 未在线');
      act(() => offline.click());
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
