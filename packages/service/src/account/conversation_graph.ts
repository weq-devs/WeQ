/**
 * 「小团体」—— 按**聊天会话**算人与人之间的拉力。纯函数，不带任何 IO
 * （IO 在 GroupInfoService.getGroupConversationGraph）。
 *
 * 口径：
 *   ① **切会话**：消息按时间排序，相邻两条相差超过 `windowSeconds`（默认 5 分钟）
 *      就是一次新对话 —— 五分钟没人说话，上一段聊天就算结束了；
 *   ② **会话内拉力**：同一段对话里的两个人，拉力 = 两个人各自发言条数之积；
 *   ③ **总拉力**：两个人之间的拉力 = 他们在所有会话里的拉力之和 —— 一起聊得越多、
 *      各自说得越多，两个人之间就越「紧」。
 *
 * 乘积会随活跃度指数级放大（10 条 × 10 条 = 100，100 × 100 = 10000），这正是
 * 「区别活跃度」想要的效果；取对数后仍然保留这个排序，只是把差距压回可视范围，
 * 前端画图时按 `log1p(pull)` 映射边粗细 / 弹簧长度即可。
 *
 * 输出是一张图：节点是人，边是拉力。
 */

/** 会话切分需要的最小信息：谁、什么时候发的。 */
export interface ConversationMessage {
  senderUid: string;
  sendTime: number;
}

/** 力图里的一个节点（一个人）。 */
export interface ConversationGraphNode {
  uid: string;
  /** 统计范围内发的消息总数。 */
  messageCount: number;
  /** 参与过的会话数。 */
  conversationCount: number;
  /** 与他人拉力之和 —— 越大越「中心」。 */
  pull: number;
}

/** 力图里的一条边（两个人的拉力）。 */
export interface ConversationGraphEdge {
  source: string;
  target: string;
  /** 会话拉力和。 */
  pull: number;
  /** 共同参与过的会话数。 */
  conversations: number;
}

export interface ConversationGraphResult {
  windowSeconds: number;
  /** 切出来的会话总数。 */
  conversationCount: number;
  /** 参与统计的消息数（有发送者与发送时间的那些）。 */
  messageCount: number;
  /** 边上的节点，按消息数从多到少。 */
  nodes: ConversationGraphNode[];
  /** 拉力最强的若干条边，按拉力从大到小。 */
  edges: ConversationGraphEdge[];
  /** 算法算出的不同配对数（截断前）—— 前端据此说明「只画了最强的 N 条」。 */
  totalPairs: number;
}

/** 默认会话边界：两条消息相差超过 5 分钟就算新对话。 */
export const DEFAULT_CONVERSATION_WINDOW_SECONDS = 300;
/** 默认最多画多少条边 —— 力图太密就没法看了。 */
export const DEFAULT_CONVERSATION_MAX_EDGES = 600;
/** 单个会话里参与判定的最活跃人数上限：超大会话只取前 N 名，避免 O(n²) 炸掉。 */
const MAX_PARTICIPANTS_PER_CONVERSATION = 120;
/** 配对表的安全上限：真到这一步说明数据异常，宁可少算也不要卡死。 */
const MAX_PAIRS = 400_000;

/** 会话内两个人配对用的键（小的 uid 在前，保证 (a,b) 与 (b,a) 同键）。 */
const PAIR_SEP = '\u0000';

/**
 * 扫一遍消息时间线，切会话、累加拉力、输出力图数据。
 *
 * 传入的消息不必预先排序（内部按 `sendTime` 排一遍）；发送者为空、发送时间无效的
 * 行会被忽略。
 */
export function buildConversationGraph(
  messages: readonly ConversationMessage[],
  opts: { windowSeconds?: number; maxEdges?: number } = {},
): ConversationGraphResult {
  const windowSeconds = Math.max(1, opts.windowSeconds ?? DEFAULT_CONVERSATION_WINDOW_SECONDS);
  const maxEdges = Math.max(1, opts.maxEdges ?? DEFAULT_CONVERSATION_MAX_EDGES);

  const sorted = messages
    .filter((m) => m.senderUid && m.sendTime > 0)
    .sort((a, b) => a.sendTime - b.sendTime);

  const stats = new Map<string, { messageCount: number; conversationCount: number }>();
  const pairs = new Map<string, { pull: number; conversations: number }>();
  let conversationCount = 0;
  let messageCount = 0;
  let pairsFull = false;

  for (let i = 0; i < sorted.length; ) {
    // 一段对话：后一条与前一条的间隔不超过窗口，就是同一段。
    let end = i + 1;
    while (
      end < sorted.length &&
      sorted[end]!.sendTime - sorted[end - 1]!.sendTime <= windowSeconds
    ) {
      end += 1;
    }

    const perSender = new Map<string, number>();
    for (let k = i; k < end; k++) {
      const uid = sorted[k]!.senderUid;
      perSender.set(uid, (perSender.get(uid) ?? 0) + 1);
      messageCount += 1;
    }
    conversationCount += 1;
    for (const [uid, count] of perSender) {
      const stat = stats.get(uid) ?? { messageCount: 0, conversationCount: 0 };
      stat.messageCount += count;
      stat.conversationCount += 1;
      stats.set(uid, stat);
    }

    if (perSender.size >= 2) {
      // 只在最活跃的若干人之间拉线：超大会话（几十人刷屏）里，边缘的「随声附和」
      // 拉出来的线又密又弱，只会糊住真正的核心圈子。
      let participants = [...perSender.entries()];
      if (participants.length > MAX_PARTICIPANTS_PER_CONVERSATION) {
        participants = participants
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_PARTICIPANTS_PER_CONVERSATION);
      }
      for (let a = 0; a < participants.length; a++) {
        const [uidA, countA] = participants[a]!;
        for (let b = a + 1; b < participants.length; b++) {
          const [uidB, countB] = participants[b]!;
          const key = uidA < uidB ? `${uidA}${PAIR_SEP}${uidB}` : `${uidB}${PAIR_SEP}${uidA}`;
          const prev = pairs.get(key);
          if (prev) {
            prev.pull += countA * countB;
            prev.conversations += 1;
          } else if (!pairsFull) {
            if (pairs.size >= MAX_PAIRS) {
              pairsFull = true;
              continue;
            }
            pairs.set(key, { pull: countA * countB, conversations: 1 });
          }
        }
      }
    }

    i = end;
  }

  const totalPairs = pairs.size;
  const rankedEdges: ConversationGraphEdge[] = [];
  for (const [key, value] of pairs) {
    const cut = key.indexOf(PAIR_SEP);
    rankedEdges.push({
      source: key.slice(0, cut),
      target: key.slice(cut + 1),
      pull: value.pull,
      conversations: value.conversations,
    });
  }
  rankedEdges.sort((a, b) => b.pull - a.pull);
  const edges = rankedEdges.slice(0, maxEdges);

  // 只保留边上的节点：没跟任何人聊过的人不进力图（一张全是孤点的图没有信息）。
  const pullByUid = new Map<string, number>();
  for (const e of edges) {
    pullByUid.set(e.source, (pullByUid.get(e.source) ?? 0) + e.pull);
    pullByUid.set(e.target, (pullByUid.get(e.target) ?? 0) + e.pull);
  }
  const nodes: ConversationGraphNode[] = [...pullByUid.entries()]
    .map(([uid, pull]) => ({
      uid,
      pull,
      messageCount: stats.get(uid)?.messageCount ?? 0,
      conversationCount: stats.get(uid)?.conversationCount ?? 0,
    }))
    .sort((a, b) => b.messageCount - a.messageCount);

  return { windowSeconds, conversationCount, messageCount, nodes, edges, totalPairs };
}
