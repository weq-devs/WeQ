import {
  collapseAiAssistantElements,
  splitAiMarkdownSegments,
  type MarkdownElement,
} from '@weq/codec';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AiMessageContent } from '../src/renderer/src/components/ai-assistant/AiMessageContent';
import { AiAssistantPane } from '../src/renderer/src/components/ai-assistant/AiAssistantPane';
import { ForwardWindowHost } from '../src/renderer/src/components/ForwardWindow';
import { messageDetailsTarget } from '../src/renderer/src/lib/messageDetailsTarget';
import type { MessageRenderer } from '../src/renderer/src/im-template/template/messageRenderers';
import type {
  DirectConversation,
  Message,
  User,
} from '../src/renderer/src/im-template/template/types';

const fixture = vi.hoisted(() => ({
  messages: vi.fn(),
  forward: vi.fn(),
  timeline: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      listAiAssistantSessions: { query: async () => [] },
      listAiAssistantMessages: { query: fixture.messages },
      getForwardMessages: { query: fixture.forward },
    },
  },
  trpc: { account: { dressup: { resolveMsgDecoration: { useQuery: () => ({}) } } } },
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: null,
    settings: { isLoading: false },
    isCurrent: () => true,
  }),
}));
vi.mock('../src/renderer/src/im-template/template/chatPane', () => ({
  ChatPane: ({
    conversation,
    messages,
    messageRenderers,
  }: {
    conversation: DirectConversation;
    messages: Message[];
    messageRenderers: MessageRenderer[];
  }) => {
    fixture.timeline(conversation, messages);
    return messages.map((message) => {
      const context = { conversation, message, sender: message.sender!, mine: true };
      return createElement(
        'div',
        { key: message.id },
        messageRenderers.find((renderer) => renderer.match(context))?.render(context),
      );
    });
  },
}));

it('显示无阶段的小Q推送，并保留 Markdown 名单和推荐头像', async () => {
  const text = [
    '## 今日简报',
    '',
    '- [候选甲](qagent://markdown/node?type=quser&id=first)（同城）',
    '- [候选乙](qagent://markdown/node?type=quser&id=second)',
    '',
    '查看[详情](qagent://markdown/node?type=qlink&id=help)。',
    '',
    '[](qagent://markdown/node?type=qui&id=recommendations)',
  ].join('\n');
  const avatar = 'https://q.qlogo.cn/headimg_dl?dst_uin=10000&spec=100';
  const element: MarkdownElement = {
    kind: 'markdown',
    markdownContent: text,
    markdownMeta: {},
    markdownFlag48703: {},
    markdownFlag48704: '',
    markdownTextSummary: '',
    markdownFlag48706: 1,
    aiMarkdown: {
      phase: '',
      metaJson: '{"push_info":{}}',
      cardPayload: JSON.stringify({
        first: { type: 'quser', data: [{ peerUin: '10000' }] },
        second: { type: 'quser', data: [{ peerUin: '10001' }] },
        help: { type: 'qlink', data: [{ title: '其他标题', url: 'https://example.test/help' }] },
        recommendations: {
          type: 'qui',
          data: [
            [{ composite_list_item: { title: '跑友', iconImageUrl: avatar } }],
            [{ full_feed_card: { author: '作者', avatar: '10000', body: '动态正文' } }],
          ],
        },
      }),
    },
  };
  const collapsed = collapseAiAssistantElements([element]);
  expect(collapsed.markdown?.markdownContent).toBe(text);

  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await import('../src/renderer/src/components/QqMarkdownContent');
    await act(async () =>
      root.render(
        createElement(AiMessageContent, {
          payload: {
            segments: splitAiMarkdownSegments(text, collapsed.cards),
            elements: [],
          },
        }),
      ),
    );

    const items = host.querySelectorAll('ul > li');
    expect(items).toHaveLength(2);
    expect(items[0]?.querySelector('.ai-quser-avatar img')).toBeTruthy();
    expect(items[0]?.querySelector('.ai-quser')?.textContent).toBe('候选甲');
    expect(items[0]?.textContent).toContain('（同城）');
    expect(items[1]?.querySelector('.ai-quser')?.textContent).toBe('候选乙');
    expect(host.querySelector('.ai-qlink')?.textContent).toBe('详情');
    expect(host.querySelector('.ai-qlink')?.getAttribute('title')).toBe(
      'https://example.test/help',
    );
    const src = host.querySelector('.ai-qui-item-avatar img')?.getAttribute('src');
    expect(src).toMatch(/^weq-avatar:\/\/fetch\?/);
    expect(new URL(src ?? '').searchParams.get('src')).toBe(avatar);
    expect(host.querySelector('.ai-qui-feed-body')?.textContent).toBe('动态正文');
    expect(host.textContent).not.toContain('qagent:');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('小Q 的普通卡片打开本会话的转发记录，AI 正文也可带普通元素', async () => {
  const user: User = {
    id: 'u_fixture',
    username: 'fixture',
    displayName: '用户',
    identityLabel: 'UID',
    identityValue: 'u_fixture',
    avatarUrl: null,
  };
  const row = {
    msgSeq: '1',
    sendTime: '1700000000',
    mine: true,
    senderUid: user.id,
    needsAuth: false,
  };
  fixture.messages.mockResolvedValue([
    {
      ...row,
      msgId: '701',
      segments: [],
      elements: [
        {
          type: 'ark',
          data: {
            arkData: {
              app: 'com.tencent.multimsg',
              meta: { detail: { resid: 'fixture-forward' } },
            },
          },
        },
      ],
    },
    {
      ...row,
      msgId: '702',
      segments: [{ kind: 'text', text: '小Q 正文' }],
      elements: [{ type: 'text', data: { textContent: '附带的普通元素' } }],
    },
  ]);
  fixture.forward.mockResolvedValue([
    {
      msgId: '703',
      sendNick: '转发作者',
      elements: [{ type: 'text', data: { textContent: '转发正文' } }],
    },
    {
      msgId: '704',
      sendTime: row.sendTime,
      elements: [{ type: 'pic', data: { fileName: 'fixture.png', imgWidth: 120, imgHeight: 80 } }],
    },
  ]);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await import('../src/renderer/src/components/ForwardWindowContent');
    await import('../src/renderer/src/components/QqMarkdownContent');
    await act(async () =>
      root.render(
        createElement(
          'div',
          null,
          createElement(AiAssistantPane, {
            user,
            conversationId: '10000',
            sessionId: '20001',
            onBack: () => {},
          }),
          createElement(ForwardWindowHost),
        ),
      ),
    );
    expect(host.textContent).toContain('小Q 正文');
    expect(host.textContent).toContain('附带的普通元素');
    const [conversation, messages] = fixture.timeline.mock.lastCall!;
    const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
    expect(messageDetailsTarget(binding, conversation, messages[0])).toEqual({
      ...binding,
      kind: 'aiAssistant',
      conv: '20001',
      msgId: '701',
    });
    const card = host.querySelector<HTMLButtonElement>('.weq-forward-preview');
    expect(card).toBeTruthy();
    await act(async () => card!.click());
    expect(fixture.forward.mock.calls).toEqual([
      [{ kind: 'aiAssistant', msgId: '701', resId: 'fixture-forward' }],
    ]);
    expect(document.querySelector('.weq-forward-body')?.textContent).toContain('转发正文');
    expect(
      document.querySelector('.weq-forward-body img.qq-media-image')?.getAttribute('alt'),
    ).toBe('fixture.png');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
