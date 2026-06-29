/**
 * Transport-agnostic tool registry.
 *
 * One source of truth for the read-only capabilities WeQ exposes to AI clients.
 * The MCP HTTP server (`./server.ts`) is its first consumer; a future in-app
 * assistant (Anthropic SDK tool runner) can reuse the very same `run` functions
 * — so the business logic lives here exactly once.
 *
 * Each tool's `run` resolves the *current* account's services via
 * `getAppContext().services`, so tools automatically follow account switches and
 * throw cleanly when no account is open. Results are converted to IPC-safe wire
 * shapes (bigint → string) with the same `serde` helpers the tRPC router uses.
 */

import { z } from 'zod';
import { getAppContext, type AccountServices } from '../context/app_context';
import {
  recentContactToWire,
  groupDetailToWire,
  groupMemberToWire,
  buddyToWire,
  userProfileToWire,
} from '../ipc/serde';

/**
 * A capability, described once, consumable by any transport (MCP / assistant).
 *
 * Intentionally non-generic so a heterogeneous `AiTool[]` is well-typed — the
 * per-tool arg inference lives in the `tool()` builder below, not in this stored
 * shape (a generic `run` param would make the array invariant and unassignable).
 */
export interface AiTool {
  name: string;
  description: string;
  /** Zod object schema; `.shape` is handed to MCP / converted for the assistant. */
  input: z.ZodObject<z.ZodRawShape>;
  /** Returns plain JSON-serializable data (no bigint / Uint8Array). */
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

function services(): AccountServices {
  const svc = getAppContext().services;
  if (!svc) {
    throw new Error('当前没有已登录的账号，请先在 WeQ 里进入一个账号。');
  }
  return svc;
}

// ── 给 LLM 的紧凑消息投影 ──────────────────────────────────────────────────
// 原始 wire 形（msgId/msgSeq/conv/senderUid/elementId…）字段多、占 token，且大模型
// 分不清「谁发的」。这里统一压成 { time, sender(昵称), mine, text } —— 单一事实源，
// MCP 外部客户端和内置助手都受益；渲染端不走这些工具，不受影响。

/** 紧凑消息行：发送者昵称 + 是否本人(mine) + 纯文本，时间正序由调用方保证。 */
interface AiMsgLine {
  time: string;
  sender: string;
  mine: boolean;
  text: string;
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** epoch 秒 → 本地「MM-DD HH:mm」，给足时间感又不浪费 token。 */
function fmtTime(sec: bigint | number): string {
  const d = new Date(Number(sec) * 1000);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** RenderElement[]（wire 形）→ 给 LLM 看的纯文本：媒体只留占位，丢掉体积字段。 */
function flattenElements(elements: readonly unknown[]): string {
  const parts: string[] = [];
  for (const raw of elements ?? []) {
    const el = raw as { type?: string; data?: Record<string, unknown> };
    const d = el.data ?? {};
    switch (el.type) {
      case 'text':
      case 'at':
        parts.push(String(d.textContent ?? '').trim());
        break;
      case 'face':
        parts.push(d.faceText ? `[${String(d.faceText)}]` : '[表情]');
        break;
      case 'pic':
        parts.push('[图片]');
        break;
      case 'ptt':
        parts.push('[语音]');
        break;
      case 'video':
        parts.push('[视频]');
        break;
      case 'file':
        parts.push(d.fileName ? `[文件:${String(d.fileName)}]` : '[文件]');
        break;
      case 'reply':
        parts.push('[回复]');
        break;
      case 'mface':
        parts.push('[表情]');
        break;
      case 'ark':
        parts.push('[卡片]');
        break;
      case 'multimsg':
        parts.push('[聊天记录]');
        break;
      case 'markdown':
        parts.push(String(d.content ?? '[markdown]'));
        break;
      default:
        break; // graytip / 系统提示等对理解会话无意义，忽略
    }
  }
  return parts.filter(Boolean).join(' ').trim() || '[空消息]';
}

/**
 * Declare a tool with full arg-type inference inside `run`, erased to the
 * non-generic `AiTool` for storage in `AI_TOOLS`.
 */
function tool<I extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  input: z.ZodObject<I>;
  run: (args: z.infer<z.ZodObject<I>>) => Promise<unknown>;
}): AiTool {
  return def as unknown as AiTool;
}

export const AI_TOOLS: AiTool[] = [
  tool({
    name: 'search_messages',
    description:
      '在本地 QQ 聊天记录里全文搜索关键词。scope: buddy=私聊, group=群聊, all=两者合并按时间排序。' +
      '返回精简命中：time 时间、scope 会话类型、conv 会话标识、sender 发送者昵称、mine 是否本人发送、text 文本。',
    input: z.object({
      keyword: z.string().min(1).describe('搜索关键词'),
      scope: z.enum(['all', 'buddy', 'group']).default('all').describe('搜索范围'),
      limit: z.number().int().min(1).max(50).default(20).describe('返回条数上限'),
    }),
    run: async ({ keyword, scope, limit }) => {
      const svc = services();
      const search = svc.msgSearch;
      const hits =
        scope === 'buddy'
          ? await search.searchBuddy(keyword, limit)
          : scope === 'group'
            ? await search.searchGroup(keyword, limit)
            : [
                ...(await search.searchBuddy(keyword, limit)),
                ...(await search.searchGroup(keyword, limit)),
              ]
                .sort((a, b) => Number(b.sendTime - a.sendTime))
                .slice(0, limit);

      const selfUid = (await svc.profile.getSelfProfile())?.uid ?? '';
      const otherUids = [...new Set(hits.filter((h) => h.senderUid !== selfUid).map((h) => h.senderUid))];
      const nameByUid = otherUids.length ? await svc.profile.nicksByUids(otherUids) : {};

      return hits.map((h) => ({
        time: fmtTime(h.sendTime),
        scope: Number(h.chatType) === 2 ? 'group' : 'c2c',
        conv: h.targetUid,
        sender: h.senderUid === selfUid ? '我' : nameByUid[h.senderUid] || h.senderUid,
        mine: h.senderUid === selfUid,
        text: h.content,
        ...(h.fileName ? { file: h.fileName } : {}),
      }));
    },
  }),

  tool({
    name: 'search_in_conversation',
    description:
      '在【指定会话内】全文搜索关键词——比全局 search_messages 更精准，专治「某人/某群里 TA 说过什么」。' +
      'kind: c2c=私聊（conv 传对方 uid），group=群聊（conv 传群号）。会话标识来自 find_contact / list_conversations / list_groups。' +
      '提到人名/群名时先用 find_contact 解析成会话标识，再用这个在该会话里搜，别把人名当关键词。' +
      '返回精简命中：time 时间、sender 发送者昵称、mine 是否本人发送、text 文本。',
    input: z.object({
      kind: z.enum(['c2c', 'group']).describe('会话类型'),
      conv: z.string().min(1).describe('私聊为对方 uid，群聊为群号'),
      keyword: z.string().min(1).describe('搜索关键词'),
      limit: z.number().int().min(1).max(50).default(20).describe('返回条数上限'),
    }),
    run: async ({ kind, conv, keyword, limit }) => {
      const svc = services();
      const hits =
        kind === 'group'
          ? await svc.msgSearch.searchInGroupConversation(conv, keyword, limit)
          : await svc.msgSearch.searchInBuddyConversation(conv, keyword, limit);

      const selfUid = (await svc.profile.getSelfProfile())?.uid ?? '';
      const otherUids = [...new Set(hits.filter((h) => h.senderUid !== selfUid).map((h) => h.senderUid))];
      const nameByUid = otherUids.length ? await svc.profile.nicksByUids(otherUids) : {};

      return hits.map((h) => ({
        time: fmtTime(h.sendTime),
        sender: h.senderUid === selfUid ? '我' : nameByUid[h.senderUid] || h.senderUid,
        mine: h.senderUid === selfUid,
        text: h.content,
        ...(h.fileName ? { file: h.fileName } : {}),
      }));
    },
  }),

  tool({
    name: 'list_conversations',
    description: '列出最近会话（私聊与群聊），最新在前。用来给后续工具挑选目标会话。',
    input: z.object({
      limit: z.number().int().min(1).max(200).default(50).describe('返回条数上限'),
    }),
    run: async ({ limit }) => {
      const contacts = await services().recentContacts.getRecentContact(limit);
      return contacts.map(recentContactToWire);
    },
  }),

  tool({
    name: 'get_messages',
    description:
      '读取某个会话最新的若干条消息，按时间正序（旧→新）返回，方便顺读。' +
      'kind: c2c=私聊（conv 传对方 uid），group=群聊（conv 传群号）。会话标识可来自 list_conversations / list_groups。' +
      '每条为精简形：time 时间、sender 发送者昵称、mine 是否本人发送、text 文本。',
    input: z.object({
      kind: z.enum(['c2c', 'group']).describe('会话类型'),
      conv: z.string().min(1).describe('私聊为对方 uid，群聊为群号'),
      limit: z.number().int().min(1).max(100).default(30).describe('返回条数上限'),
    }),
    run: async ({ kind, conv, limit }): Promise<AiMsgLine[]> => {
      const svc = services();
      const selfUin = (await svc.profile.getSelfProfile())?.uin ?? -1n;
      const rows =
        kind === 'group'
          ? await svc.msgs.getGroupLatest(conv, limit)
          : await svc.msgs.getC2cLatest(conv, limit);

      // 名字解析：自己=「我」，其余批量取昵称（私聊就对方一个人，群聊各发言人）。
      const otherUids = [...new Set(rows.filter((r) => r.senderUin !== selfUin).map((r) => r.senderUid))];
      const nameByUid = otherUids.length ? await svc.profile.nicksByUids(otherUids) : {};

      const lines = rows.map((r) => ({
        time: fmtTime(r.sendTime),
        sender: r.senderUin === selfUin ? '我' : nameByUid[r.senderUid] || String(r.senderUin),
        mine: r.senderUin === selfUin,
        text: flattenElements(r.elements),
      }));
      lines.reverse(); // DB 是最新在前，翻成旧→新方便顺读
      return lines;
    },
  }),

  tool({
    name: 'list_groups',
    description: '列出当前账号加入的群聊（群号、群名等）。',
    input: z.object({
      limit: z.number().int().min(1).max(500).default(100).describe('返回条数上限'),
      offset: z.number().int().min(0).default(0).describe('分页偏移'),
    }),
    run: async ({ limit, offset }) => {
      const groups = await services().groupInfo.listAllGroups(limit, offset);
      return groups.map(groupDetailToWire);
    },
  }),

  tool({
    name: 'list_buddies',
    description: '列出当前账号的 QQ 好友（uid、uin、昵称、备注等）。',
    input: z.object({
      limit: z.number().int().min(1).max(500).default(100).describe('返回条数上限'),
      offset: z.number().int().min(0).default(0).describe('分页偏移'),
    }),
    run: async ({ limit, offset }) => {
      const buddies = await services().profile.listBuddies(limit, offset);
      return buddies.map(buddyToWire);
    },
  }),

  tool({
    name: 'search_buddies',
    description:
      '按昵称或备注模糊搜索好友（用于「找一下叫XX的好友」「我和谁的好友名字里有YY」等场景）。' +
      '支持部分匹配，返回 uid、uin、昵称、备注。不传 query 时返回所有好友。',
    input: z.object({
      query: z.string().default('').describe('搜索关键词（昵称/备注，不区分大小写，空字符串=全部）'),
      limit: z.number().int().min(1).max(200).default(50).describe('返回条数上限'),
    }),
    run: async ({ query, limit }) => {
      const svc = services();
      const buddies = await svc.profile.listBuddies(500, 0);
      const profiles = await svc.profile.profilesByUids(buddies.map((b) => b.uid));
      const q = query.toLowerCase();
      const matched = profiles.filter(
        (p) =>
          !q ||
          (p.nick && p.nick.toLowerCase().includes(q)) ||
          (p.remark && p.remark.toLowerCase().includes(q)),
      );
      return matched.slice(0, limit).map((p) => ({
        uid: p.uid,
        uin: p.uin.toString(),
        nick: p.nick,
        remark: p.remark,
        qid: p.qid,
      }));
    },
  }),

  tool({
    name: 'search_groups',
    description:
      '按群名模糊搜索群聊（用于「找一下XX群」「我加入的群里哪些名字包含YY」等场景）。' +
      '支持部分匹配，返回 groupCode、groupName 等。不传 query 时返回所有群。',
    input: z.object({
      query: z.string().default('').describe('搜索关键词（群名，不区分大小写，空字符串=全部）'),
      limit: z.number().int().min(1).max(200).default(50).describe('返回条数上限'),
    }),
    run: async ({ query, limit }) => {
      const all = await services().groupInfo.listAllGroups(500, 0);
      const q = query.toLowerCase();
      const matched = all.filter((g) => !q || (g.groupName && g.groupName.toLowerCase().includes(q)));
      return matched.slice(0, limit).map(groupDetailToWire);
    },
  }),

  tool({
    name: 'get_self_profile',
    description: '获取当前登录账号自己的资料（昵称、uin 等）。',
    input: z.object({}),
    run: async () => {
      const profile = await services().profile.getSelfProfile();
      return profile ? userProfileToWire(profile) : null;
    },
  }),

  tool({
    name: 'find_contact',
    description:
      '按名字/备注/群名模糊查找联系人与群，返回可直接用于 get_messages / search_messages 的会话标识。' +
      '当用户提到某个人名或群名（如「小枳壳」）时，先用这个把名字解析成会话（私聊对方 uid 或群号），再去读/搜该会话——' +
      '不要把人名本身当作搜索关键词丢给 search_messages。',
    input: z.object({
      query: z.string().min(1).describe('要查找的名字、备注或群名（部分匹配，大小写不敏感）'),
      limit: z.number().int().min(1).max(30).default(10).describe('每类返回上限'),
    }),
    run: async ({ query, limit }) => {
      const svc = services();
      const q = query.trim().toLowerCase();
      const hit = (s: string | undefined): boolean => !!s && s.toLowerCase().includes(q);

      // 人：扫最近会话（带昵称/备注/会话名），仅私聊，按 uid 去重。
      const contacts = await svc.recentContacts.getRecentContact(200);
      const peopleMap = new Map<
        string,
        { uid: string; uin: string; name: string; remark: string; lastTime: string }
      >();
      for (const c of contacts) {
        if (!String(c.chatType).includes('C2C')) continue;
        if (!hit(c.targetRemark) && !hit(c.targetDisplayName) && !hit(c.senderNick)) continue;
        if (peopleMap.has(c.targetUid)) continue;
        const wire = recentContactToWire(c);
        peopleMap.set(c.targetUid, {
          uid: wire.targetUid,
          uin: wire.targetUin,
          name: wire.targetDisplayName || wire.senderNick || wire.targetRemark || wire.targetUid,
          remark: wire.targetRemark,
          lastTime: wire.sendTime,
        });
      }
      const people = [...peopleMap.values()].slice(0, limit);

      // 群：扫全部群，匹配群名/备注。
      const groups = (await svc.groupInfo.listAllGroups(500, 0))
        .filter((g) => hit(g.groupName) || hit(g.remark))
        .slice(0, limit)
        .map((g) => {
          const w = groupDetailToWire(g);
          return { groupCode: w.groupCode, groupName: w.groupName, remark: w.remark, memberCount: w.memberCount };
        });

      return {
        query,
        people, // get_messages/search_messages: kind=c2c, conv=uid
        groups, // get_messages: kind=group, conv=groupCode；或 list_group_members
        hint:
          people.length === 0 && groups.length === 0
            ? '没有匹配的联系人或群。可换更短的关键词，或用 list_conversations / list_buddies / list_groups 浏览。'
            : '用 people[].uid 作为 c2c 会话标识，用 groups[].groupCode 作为群会话标识，继续 get_messages / search_messages。',
      };
    },
  }),

  tool({
    name: 'list_group_members',
    description:
      '列出某个群的成员（群号、群名片 card、昵称 nick、uid、uin 等）。用来把群内的某个昵称解析成 uid，再定位 TA 在群里的发言。',
    input: z.object({
      group: z.string().min(1).describe('群号'),
      limit: z.number().int().min(1).max(200).default(60).describe('返回条数上限'),
      offset: z.number().int().min(0).default(0).describe('分页偏移'),
    }),
    run: async ({ group, limit, offset }) => {
      let code: bigint;
      try {
        code = BigInt(group.trim());
      } catch {
        throw new Error(`群号无效：${group}（应为纯数字群号，可先用 find_contact 解析）`);
      }
      const members = await services().groupInfo.listMembersInGroup(code, limit, offset);
      return members.map(groupMemberToWire);
    },
  }),

  tool({
    name: 'list_user_groups',
    description:
      '列出某个用户「在我加入的群里」所属的群聊（即我和 TA 的共同群）。传入对方 uid（可由 find_contact 解析人名得到）。' +
      '用来回答「我和某人有哪些共同群」「TA 在哪些群里」。' +
      '返回每个群：groupCode 群号、groupName 群名、card 该用户在群里的名片、level 等级。',
    input: z.object({
      uid: z.string().min(1).describe('目标用户的 uid（可用 find_contact 把人名解析成 uid）'),
      limit: z.number().int().min(1).max(200).default(100).describe('返回条数上限'),
      offset: z.number().int().min(0).default(0).describe('分页偏移'),
    }),
    run: async ({ uid, limit, offset }) => {
      const svc = services();
      const memberships = await svc.groupInfo.listUserGroups(uid, limit, offset);
      if (memberships.length === 0) {
        return {
          uid,
          count: 0,
          groups: [],
          hint: '该用户不在你加入的任何群里，或 uid 不正确（可先用 find_contact 解析人名为 uid）。',
        };
      }
      // 群名不在成员记录里，批量取一次群列表建 code→名 映射，避免逐群查询。
      const allGroups = await svc.groupInfo.listAllGroups(500, 0);
      const nameByCode = new Map(allGroups.map((g) => [g.groupCode.toString(), g.groupName]));
      return {
        uid,
        count: memberships.length,
        groups: memberships.map((m) => {
          const code = m.groupCode.toString();
          return {
            groupCode: code,
            groupName: nameByCode.get(code) || code,
            card: m.card || m.nick || '',
            level: m.memberLevel,
          };
        }),
      };
    },
  }),

  tool({
    name: 'get_buddy_analytics',
    description:
      '获取与某个好友的私聊统计分析（消息总数、每日活跃度、时段分布、回复延迟、火花天数、常用词/表情等），用于生成私聊活跃度报告。' +
      '传入对方 uid（可由 find_contact 解析人名得到）。返回详细统计数据（JSON），适合用 write_report 生成 HTML 可视化报告。',
    input: z.object({
      uid: z.string().min(1).describe('目标好友的 uid（可用 find_contact 把人名解析成 uid）'),
    }),
    run: async ({ uid }) => {
      const analytics = await services().buddyAnalytics.getBuddyAnalytics(uid);
      // 转换 bigint → string，其余保留
      return {
        peer: { uid: analytics.peer.uid, uin: analytics.peer.uin.toString() },
        self: { uin: analytics.self.uin.toString() },
        statistics: analytics.statistics,
        messageTypes: analytics.messageTypes,
        hourlySelf: analytics.hourlySelf,
        hourlyPeer: analytics.hourlyPeer,
        daily: analytics.daily,
        initiation: analytics.initiation,
        reply: analytics.reply,
        streak: analytics.streak,
        phrasesSelf: analytics.phrasesSelf,
        phrasesPeer: analytics.phrasesPeer,
        emojisSelf: analytics.emojisSelf.map((e) => ({ faceId: e.faceId, faceText: e.faceText, count: e.count })),
        emojisPeer: analytics.emojisPeer.map((e) => ({ faceId: e.faceId, faceText: e.faceText, count: e.count })),
        wordCloud: analytics.wordCloud,
      };
    },
  }),

  tool({
    name: 'get_group_activity',
    description:
      '获取某个群聊的活跃度统计（指定时间范围内的消息数、活跃成员排行、时段分布、每日趋势等），用于生成群聊活跃度报告。' +
      '传入群号（可由 find_contact 解析群名得到）和时间范围（默认最近 30 天）。返回统计数据（JSON），适合用 write_report 生成 HTML 可视化报告。',
    input: z.object({
      groupCode: z.string().min(1).describe('群号（纯数字，可用 find_contact 把群名解析成群号）'),
      days: z.number().int().min(1).max(180).default(30).describe('统计最近 N 天（默认 30 天）'),
    }),
    run: async ({ groupCode, days }) => {
      const svc = services();
      const now = Date.now();
      // group_msg_table 的 sendTime 是 unix **秒**（见 packages/db/src/msg/group.ts 列 40050），
      // 故时间窗也换算成秒来比较；后面构造 Date 时再 ×1000 还原成毫秒。
      const startSec = Math.floor((now - days * 86400000) / 1000);

      // 通过 MsgService 获取群消息（getGroupLatest 最多 5000 条，足够覆盖大多数统计场景）
      const msgs = await svc.msgs.getGroupLatest(groupCode, 5000);
      const filtered = msgs.filter((m) => Number(m.sendTime) >= startSec);

      if (filtered.length === 0) {
        return {
          groupCode,
          days,
          totalMessages: 0,
          activeDays: 0,
          topSenders: [],
          hourlyDistribution: {},
          daily: [],
          hint: '该时间范围内无消息记录（或消息数超过 5000 条导致时间窗外的被截断）。',
        };
      }

      // 统计：总消息数、活跃天数、成员排行、时段分布、每日趋势
      const daily = new Map<string, number>();
      const hourly: Record<number, number> = {};
      for (let i = 0; i < 24; i++) hourly[i] = 0;
      const senderCounts = new Map<string, { uid: string; count: number }>();

      for (const msg of filtered) {
        const d = new Date(Number(msg.sendTime) * 1000);
        const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        daily.set(day, (daily.get(day) ?? 0) + 1);
        hourly[d.getHours()] = (hourly[d.getHours()] ?? 0) + 1;

        const uid = msg.senderUid;
        const prev = senderCounts.get(uid);
        senderCounts.set(uid, { uid, count: (prev?.count ?? 0) + 1 });
      }

      const topSenders = [...senderCounts.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 20)
        .map((s) => ({ uid: s.uid, count: s.count }));

      return {
        groupCode,
        days,
        totalMessages: filtered.length,
        activeDays: daily.size,
        topSenders,
        hourlyDistribution: hourly,
        daily: [...daily.entries()]
          .map(([date, count]) => ({ date, count }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      };
    },
  }),
];

