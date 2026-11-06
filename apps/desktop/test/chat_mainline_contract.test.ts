// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { countAppendedMessages } from '../src/renderer/src/im-template/template/chatTimelineModel';
import type { Message } from '../src/renderer/src/im-template/template/types';

it('本阶段恢复的核心文件不能重新关闭类型检查', () => {
  for (const name of [
    'types.ts',
    'chatPane.tsx',
    'chatMainContent.tsx',
    'composer.tsx',
    'composerQuote.tsx',
    'draftElements.ts',
    'messageRow.tsx',
    'messageBubble.tsx',
    'messageRenderers.tsx',
    'useChatTimelineNavigation.tsx',
    'chatTimelineModel.ts',
    'composerSubmission.ts',
  ]) {
    const source = readFileSync(
      new URL(`../src/renderer/src/im-template/template/${name}`, import.meta.url),
      'utf8',
    );
    expect(source, name).not.toMatch(/@ts-(?:nocheck|ignore)\b/);
  }
});

it('新消息计数只看已有锚点之后的对端消息，锚点消失时只计最后一条', () => {
  const message = (id: string, senderId = 'peer'): Message => ({
    id,
    senderId,
    conversationId: 'chat',
    body: id,
    createdAt: '2026-11-06T00:00:00+08:00',
  });
  const rows = [message('old'), message('mine', 'self'), message('new')];
  expect(countAppendedMessages('old', rows, 'self')).toBe(1);
  expect(countAppendedMessages('new', rows, 'self')).toBe(0);
  expect(countAppendedMessages('missing', rows, 'self')).toBe(1);
  expect(countAppendedMessages(null, [message('mine', 'self')], 'self')).toBe(0);
  expect(countAppendedMessages(null, [], 'self')).toBe(0);
});
