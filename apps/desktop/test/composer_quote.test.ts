import { describe, expect, it } from 'vitest';
import {
  composerQuoteElement,
  quoteFromMessage,
} from '../src/renderer/src/im-template/template/composerQuote';
import { buildOptimisticRender } from '../src/renderer/src/im-template/template/composerSend';
import { elementToToken } from '../src/renderer/src/im-template/template/draftElements';
import type { Message } from '../src/renderer/src/im-template/template/types';

describe('发送引用的内容与编号', () => {
  it('引用摘要里的提及保留文字，不要求重新解析 UIN 或发送通知', () => {
    const quote = quoteFromMessage({
      msgSeq: '120',
      body: '@测试成员',
      qqElements: [{ type: 'at', data: { atTargetUid: 'u_peer', textContent: '@测试成员' } }],
    } as unknown as Message)!;
    expect(composerQuoteElement(quote).origElements).toEqual([
      { kind: 'text', textContent: '@测试成员' },
    ]);
  });
  it('保留摘要，乐观消息使用会话序号跳转，wire 使用私聊 client sequence', () => {
    const quote = quoteFromMessage({
      msgSeq: '120',
      clientSeq: '7',
      body: '原消息正文',
      sender: { identityValue: '20002', displayName: '测试用户' },
      createdAt: '2026-10-18T00:00:00+08:00',
      qqElements: [{ type: 'text', data: { textContent: '原消息正文' } }],
    } as unknown as Message)!;
    const element = composerQuoteElement(quote);
    expect(element).toMatchObject({
      origMsgSeq: 7,
      origMsgIndex: 120,
      origElements: [{ kind: 'text', textContent: '原消息正文' }],
    });
    const render = buildOptimisticRender({
      body: elementToToken(element),
      locals: [],
      superStickers: new Map(),
    });
    expect(render.elements[0]).toMatchObject({
      type: 'reply',
      data: {
        origMsgIndex: 120,
        origClientSeq: 7,
        origElements: [{ type: 'text', data: { textContent: '原消息正文' } }],
      },
    });
  });
});
