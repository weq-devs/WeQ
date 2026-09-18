/**
 * 会话切分 + 拉力力图（conversation_graph）的单测。
 *
 *   - 两条消息间隔超过窗口（默认 5 分钟）就是一次新对话；
 *   - 会话内两个人的拉力 = 各自消息条数之积；
 *   - 两人之间的拉力 = 各会话拉力之和；
 *   - 没跟任何人聊过的人不进力图；边只保留最强的若干条。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONVERSATION_WINDOW_SECONDS,
  buildConversationGraph,
  type ConversationMessage,
} from '../src/account/conversation_graph';

const MIN = 60;
const T0 = 1704067200;

/** 便捷构造：`atMinutes` 是相对基准的分钟数。 */
function msg(senderUid: string, atMinutes: number): ConversationMessage {
  return { senderUid, sendTime: T0 + Math.round(atMinutes * MIN) };
}

/** 连续发 `count` 条，每条隔 `everyMinutes` 分钟，从 `fromMinutes` 开始。 */
function say(
  senderUid: string,
  fromMinutes: number,
  count: number,
  everyMinutes = 0.5,
): ConversationMessage[] {
  return Array.from({ length: count }, (_, i) => msg(senderUid, fromMinutes + i * everyMinutes));
}

describe('buildConversationGraph', () => {
  it('5 分钟内算同一段对话，超过就切开', () => {
    const graph = buildConversationGraph([
      msg('a', 0),
      msg('b', 1),
      msg('a', 2), // 与上一条差 1 分钟 → 同一段
      msg('b', 12), // 与上一条差 10 分钟 → 新的一段
    ]);
    expect(graph.windowSeconds).toBe(DEFAULT_CONVERSATION_WINDOW_SECONDS);
    expect(graph.conversationCount).toBe(2);
    expect(graph.messageCount).toBe(4);
  });

  it('会话内两人的拉力 = 消息条数之积', () => {
    // a 说 2 条、b 说 3 条，都在同一段里 → 拉力 6。
    const graph = buildConversationGraph([...say('a', 0, 2), ...say('b', 2, 3)]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ source: 'a', target: 'b', pull: 6, conversations: 1 });
  });

  it('两人之间的总拉力 = 各会话拉力之和', () => {
    const graph = buildConversationGraph([
      ...say('a', 0, 2),
      ...say('b', 1, 3), // 第一段：2 × 3 = 6
      ...say('a', 60, 4),
      ...say('b', 61, 5), // 第二段：4 × 5 = 20
    ]);
    expect(graph.conversationCount).toBe(2);
    expect(graph.edges[0]).toMatchObject({ pull: 26, conversations: 2 });
  });

  it('三个人各说各的 → 三条边，每条都是两个人条数之积', () => {
    const graph = buildConversationGraph([...say('a', 0, 1), ...say('b', 1, 2), ...say('c', 2, 3)]);
    const edges = [...graph.edges].sort((x, y) =>
      `${x.source}|${x.target}`.localeCompare(`${y.source}|${y.target}`),
    );
    expect(edges.map((e) => [e.source, e.target, e.pull])).toEqual([
      ['a', 'b', 2],
      ['a', 'c', 3],
      ['b', 'c', 6],
    ]);
  });

  it('自定义窗口：窗口调大，原本两段对话会并成一段', () => {
    const messages = [...say('a', 0, 1), ...say('b', 3, 1)];
    expect(buildConversationGraph(messages, { windowSeconds: 60 }).conversationCount).toBe(2);
    expect(buildConversationGraph(messages, { windowSeconds: 600 }).conversationCount).toBe(1);
  });

  it('没跟任何人聊过的人不进力图', () => {
    const graph = buildConversationGraph([
      ...say('a', 0, 2),
      ...say('b', 1, 2), // a、b 有对话
      msg('lonely', 100), // 自言自语，一次会话只有一个人
    ]);
    expect(graph.conversationCount).toBe(2);
    expect(graph.nodes.map((n) => n.uid).sort()).toEqual(['a', 'b']);
  });

  it('发送者为空 / 时间无效的消息直接忽略', () => {
    const graph = buildConversationGraph([
      { senderUid: '', sendTime: T0 },
      { senderUid: 'a', sendTime: 0 },
      ...say('a', 0, 1),
      ...say('b', 1, 1),
    ]);
    expect(graph.messageCount).toBe(2);
    expect(graph.conversationCount).toBe(1);
  });

  it('只保留最强的若干条边，totalPairs 仍是完整配对对数', () => {
    const messages = [
      ...say('a', 0, 10),
      ...say('b', 1, 10), // a-b：100
      ...say('c', 100, 2),
      ...say('d', 101, 2), // c-d：4
      ...say('e', 200, 1),
      ...say('f', 201, 1), // e-f：1
    ];
    const graph = buildConversationGraph(messages, { maxEdges: 2 });
    expect(graph.totalPairs).toBe(3);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges[0]).toMatchObject({ source: 'a', target: 'b', pull: 100 });
    // 被截断的 e-f 两端都不进力图。
    expect(graph.nodes.map((n) => n.uid).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('节点带上发言总数 / 会话数 / 拉力合计', () => {
    const graph = buildConversationGraph([
      ...say('a', 0, 3),
      ...say('b', 1, 2), // a-b：6
      ...say('a', 60, 2),
      ...say('c', 61, 1), // a-c：2
    ]);
    const a = graph.nodes.find((n) => n.uid === 'a')!;
    expect(a.messageCount).toBe(5);
    expect(a.conversationCount).toBe(2);
    expect(a.pull).toBe(8);
  });

  it('空输入 → 空图，不炸', () => {
    const graph = buildConversationGraph([]);
    expect(graph).toMatchObject({ conversationCount: 0, messageCount: 0, totalPairs: 0 });
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});
