/**
 * AI 助手（小Q）的一条消息气泡内容。
 *
 * AI 正文与行内卡片一起渲染 Markdown，结构化卡片独立成块。
 * 普通消息内容由共享渲染器传入，推荐消息与操作栏显示在底部。
 *
 * 静态展示：推荐按钮与操作栏都只读 —— AI 助手不发消息，按钮点击需要 QQ 在线。
 */

import { memo } from 'react';
import type { ReactNode } from 'react';
import { QqMarkdown } from '../QqMarkdown';
import { AiCard } from './AiCard';
import { AiActionBar } from './AiActionBar';
import type { AiAssistantMessageWire, AiSegmentWire } from '../../../../shared/aiAssistantTypes';
import { AiRecommendedList } from './AiRecommendedList';

/** 渲染器认领消息时挂在 Message 上的字段。 */
export type AiMessagePayload = Pick<AiAssistantMessageWire, 'segments' | 'elements'> & {
  ordinaryElements?: AiAssistantMessageWire['elements'];
};

export const AiMessageContent = memo(function AiMessageContent({
  payload,
  children,
}: {
  payload: AiMessagePayload;
  children?: ReactNode;
}) {
  return (
    <div className="message-content qq-message-inline ai-message">
      {renderSegments(payload.segments)}
      {children}
      {payload.elements.map((element, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 元素没有稳定 id，顺序即身份
        <AiExtraElement key={index} element={element} />
      ))}
    </div>
  );
});

/** 用户卡和外链留在原来的段落或列表项中，结构化卡片独占一块。 */
function renderSegments(segments: readonly AiSegmentWire[]): ReactNode {
  const nodes: ReactNode[] = [];
  let text = '';
  let plainText = '';
  let links = new Map<string, Extract<AiSegmentWire, { kind: 'card' }>>();
  const flush = () => {
    if (text.trim()) {
      const inlineCards = links;
      nodes.push(
        <div className="ai-message-text" key={`t${nodes.length}`}>
          <QqMarkdown
            text={text}
            plainText={plainText}
            renderLink={
              inlineCards.size
                ? (href, children) => {
                    const segment = inlineCards.get(href);
                    if (segment)
                      return <AiCard card={segment.card}>{segment.label ? children : null}</AiCard>;
                  }
                : undefined
            }
          />
        </div>,
      );
    }
    text = '';
    plainText = '';
    links = new Map();
  };
  for (const segment of segments) {
    if (segment.kind === 'text') {
      text += segment.text;
      plainText += segment.text;
    } else if (segment.card.type === 'quser' || segment.card.type === 'qlink') {
      // 用可通过 Markdown URL 校验的内部地址关联卡片，实际链接由 AiCard 处理。
      const href = `https://weq.invalid/ai-card/${links.size}`;
      links.set(href, segment);
      text += `[${segment.label ?? ''}](${href})`;
      plainText += segment.label ?? '';
    } else {
      flush();
      nodes.push(<AiCard key={`c${nodes.length}`} card={segment.card} />);
    }
  }
  flush();
  return nodes.length ? nodes : null;
}

/** 推荐消息 / 操作栏 / 其它元素。 */
function AiExtraElement({ element }: { element: AiMessagePayload['elements'][number] }) {
  switch (element.type) {
    case 'recommendedMsg':
      return <AiRecommendedList rows={element.data?.rows as AiButtonRows | undefined} />;
    case 'actionBar':
      return <AiActionBar rows={element.data?.rows as AiButtonRows | undefined} />;
    default:
      return null;
  }
}

export type AiButtonRows = Array<Array<{ label?: string; action?: string; actionCode?: number }>>;
