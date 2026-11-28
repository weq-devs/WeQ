import {
  collapseAiAssistantElements,
  splitAiMarkdownSegments,
  type MarkdownElement,
} from '@weq/codec';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AiMessageContent } from '../src/renderer/src/components/ai-assistant/AiMessageContent';

vi.mock('../src/renderer/src/components/QqMessageContent', () => ({
  QqMessageContent: () => null,
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
            needsAuth: false,
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
