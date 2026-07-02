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
  groupEssenceToWire,
  groupBulletinToWire,
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
  /**
   * Exclude from the external read-only MCP server (`server.ts`); only the in-app
   * assistant may call it. Use for tools with side effects (e.g. writing an export
   * file) so the public MCP surface stays strictly read-only.
   */
  assistantOnly?: boolean;
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

/** epoch 秒 → 本地「HH:mm」（单日内的精简时间）。 */
function hhmm(sec: bigint | number): string {
  const d = new Date(Number(sec) * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** epoch 秒 → 本地「YYYY-MM-DD」（只到日，给建群时间等）。 */
function fmtDate(sec: bigint | number): string {
  const d = new Date(Number(sec) * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 解析「某天」为本地 [startSec, endSec) 半开窗口（秒），默认今天。
 * date 形如 YYYY-MM-DD；非法时抛出可读错误。给「今日/某天」类工具单一事实源。
 */
function dayWindow(date?: string): { startSec: number; endSec: number; label: string } {
  let d: Date;
  const raw = (date ?? '').trim();
  if (raw) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    if (!m) throw new Error(`无效日期：${date}（应为 YYYY-MM-DD，例如 2026-06-30；不传则默认今天）`);
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(d.getTime())) throw new Error(`无效日期：${date}`);
  } else {
    const now = new Date();
    d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  const startSec = Math.floor(d.getTime() / 1000);
  return { startSec, endSec: startSec + 86400, label: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` };
}

/** 从 RecentContact.chatType 判定会话类型（兼容字符串枚举与数字）。 */
function convKindOf(chatType: unknown): 'c2c' | 'group' | null {
  const s = String(chatType).toUpperCase();
  if (s.includes('C2C') || s === '1') return 'c2c';
  if (s.includes('GROUP') || s === '2') return 'group';
  return null;
}

/** 导出格式 → MIME（结果卡片显示用）。 */
const EXPORT_MIME: Record<string, string> = {
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  txt: 'text/plain',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html',
};

/**
 * 等导出任务到终态。监听 manager 的 `progress` 事件按 taskId 轮询 getTask，
 * 带超时兜底——避免大导出把助手这一轮卡死（媒体类大导出应走导出中心）。
 */
function waitForExport(
  mgr: AccountServices['exportManager'],
  taskId: string,
  timeoutMs = 180_000,
): Promise<NonNullable<ReturnType<AccountServices['exportManager']['getTask']>>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      mgr.off('progress', onProgress);
      clearTimeout(timer);
      fn();
    };
    const check = (): void => {
      const t = mgr.getTask(taskId);
      if (!t) return;
      if (t.status === 'completed') settle(() => resolve(t));
      else if (t.status === 'failed') settle(() => reject(new Error(t.error || '导出失败')));
      else if (t.status === 'cancelled') settle(() => reject(new Error('导出被取消了')));
    };
    const onProgress = (p: { taskId?: string }): void => {
      if (p?.taskId === taskId) check();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error('导出耗时过长已超时；如需带媒体或大批量，请在「导出中心」里操作。'))),
      timeoutMs,
    );
    mgr.on('progress', onProgress);
    check(); // 可能在挂监听前就已完成
  });
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
  assistantOnly?: boolean;
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
      '列出某个群的成员名单（群号、群名片 card、昵称 nick、uid、uin、群等级 memberLevel、管理标记 adminFlag 等）。' +
      '既能把群内的某个昵称解析成 uid（再定位 TA 的发言），也能出「群成员名单/等级排行」。' +
      'orderBy: default=默认顺序，level=按群等级从高到低（看群里的元老/等级排行）。支持 limit/offset 翻页。',
    input: z.object({
      group: z.string().min(1).describe('群号（可先用 find_contact 把群名解析成群号）'),
      orderBy: z
        .enum(['default', 'level'])
        .default('default')
        .describe('排序方式：default=默认顺序；level=按群等级从高到低'),
      limit: z.number().int().min(1).max(200).default(60).describe('返回条数上限'),
      offset: z.number().int().min(0).default(0).describe('分页偏移'),
    }),
    run: async ({ group, orderBy, limit, offset }) => {
      let code: bigint;
      try {
        code = BigInt(group.trim());
      } catch {
        throw new Error(`群号无效：${group}（应为纯数字群号，可先用 find_contact 解析）`);
      }
      const members =
        orderBy === 'level'
          ? await services().groupInfo.listMembersByLevel(code, limit, offset)
          : await services().groupInfo.listMembersInGroup(code, limit, offset);
      return members.map(groupMemberToWire);
    },
  }),

  tool({
    name: 'list_friends_by_intimacy',
    description:
      '按【亲密度】从高到低列出我的 QQ 好友排行榜。亲密度来自 QQ 本地资料（profile_info），0 表示未知/无数据，会排到最后。' +
      '用来回答「我和谁最亲密」「亲密度最高的好友」「好友亲密度排行」。' +
      '返回每位：rank 名次、nick 昵称、remark 备注、uin QQ号、uid、intimacy 亲密度分值。',
    input: z.object({
      limit: z.number().int().min(1).max(200).default(30).describe('返回条数上限（取亲密度最高的若干位）'),
      offset: z.number().int().min(0).default(0).describe('分页偏移（翻看排行后段）'),
    }),
    run: async ({ limit, offset }) => {
      const friends = await services().profile.listFriendsByIntimacy(limit, offset);
      return friends.map((f, i) => ({
        rank: offset + i + 1,
        nick: f.nick,
        remark: f.remark,
        uin: f.uin,
        uid: f.uid,
        intimacy: f.intimacy,
      }));
    },
  }),

  tool({
    name: 'get_user_profile',
    description:
      '查看某个用户的详细资料卡（昵称、备注、QQ号、性别、年龄、生日、个性签名、亲密度、是否我的好友）。' +
      '传入对方 uid（可用 find_contact 解析人名、或 list_group_members 从群里拿到 uid）。' +
      '用来回答「XX 的生日/签名/性别是什么」「TA 是不是我好友」等。资料取自本地缓存，未缓存的字段可能为空。',
    input: z.object({
      uid: z.string().min(1).describe('目标用户的 uid（可用 find_contact 把人名解析成 uid）'),
    }),
    run: async ({ uid }) => {
      const p = await services().profile.getProfile(uid);
      if (!p) {
        return {
          uid,
          found: false,
          hint: '没有该用户的缓存资料；确认 uid 是否正确（可用 find_contact 解析人名为 uid）。',
        };
      }
      const w = userProfileToWire(p);
      return {
        found: true,
        uid: w.uid,
        uin: w.uin,
        nick: w.nick,
        remark: w.remark,
        gender: w.gender === 1 ? '男' : w.gender === 2 ? '女' : '未知',
        ...(w.age ? { age: w.age } : {}),
        ...(w.birthYear ? { birthday: `${w.birthYear}-${pad2(w.birthMonth)}-${pad2(w.birthDay)}` } : {}),
        ...(w.signature ? { signature: w.signature } : {}),
        intimacy: w.intimacy,
        isFriend: w.isFriend,
      };
    },
  }),

  tool({
    name: 'get_group_info',
    description:
      '查看某个群的资料详情（群名、群号、群主 uid、当前人数/人数上限、创建时间、群介绍、置顶公告、群标签）。' +
      '传入群号（可用 find_contact 解析群名得到）。用来回答「这个群多少人」「群主是谁」「群什么时候建的」「群介绍/置顶」等。',
    input: z.object({
      groupCode: z.string().min(1).describe('群号（纯数字，可用 find_contact 把群名解析成群号）'),
    }),
    run: async ({ groupCode }) => {
      let gc: bigint;
      try {
        gc = BigInt(String(groupCode).trim());
      } catch {
        throw new Error(`群号必须是纯数字：${groupCode}（先用 find_contact 把群名解析成群号）`);
      }
      const d = await services().groupInfo.getGroupDetail(gc);
      if (!d) {
        return { groupCode, found: false, hint: '找不到该群资料；确认群号是否正确（可用 find_contact 解析群名）。' };
      }
      const w = groupDetailToWire(d);
      return {
        found: true,
        groupCode: w.groupCode,
        groupName: w.groupName,
        ownerUid: w.ownerUid,
        memberCount: w.memberCount,
        maxMemberCount: w.maxMemberCount,
        ...(w.createTime ? { created: fmtDate(w.createTime) } : {}),
        ...(w.description ? { description: w.description } : {}),
        ...(w.pinnedAnnounce ? { pinnedAnnounce: w.pinnedAnnounce } : {}),
        ...(w.remark ? { remark: w.remark } : {}),
        ...(w.labels ? { labels: w.labels } : {}),
      };
    },
  }),

  tool({
    name: 'get_group_essence',
    description:
      '列出某个群的精华消息（被群管理设为「精华」的发言），较新在前。传入群号（可用 find_contact 解析群名得到）。' +
      '用来回答「群里有哪些精华消息」「谁的发言被设成精华了」。' +
      '返回每条：sender 原发言人、senderUin、operator 设精华的人、time 设置时间、msgSeq。',
    input: z.object({
      groupCode: z.string().min(1).describe('群号'),
      limit: z.number().int().min(1).max(100).default(30).describe('返回条数上限'),
    }),
    run: async ({ groupCode, limit }) => {
      let gc: bigint;
      try {
        gc = BigInt(String(groupCode).trim());
      } catch {
        throw new Error(`群号必须是纯数字：${groupCode}（先用 find_contact 把群名解析成群号）`);
      }
      const list = await services().groupInfo.getEssenceMessages(gc, limit, 0);
      return list.map((e) => {
        const w = groupEssenceToWire(e);
        return {
          sender: w.senderNick || w.senderUin,
          senderUin: w.senderUin,
          operator: w.operatorNick || w.operatorUin,
          time: w.timestamp ? fmtTime(w.timestamp) : '',
          msgSeq: w.msgSeq,
        };
      });
    },
  }),

  tool({
    name: 'get_group_bulletins',
    description:
      '列出某个群的群公告（较新在前）。传入群号（可用 find_contact 解析群名得到）。' +
      '用来回答「群公告说了什么」「最新群公告」「进群须知」等。返回每条：text 公告正文、time 发布时间、publisherUid 发布者。',
    input: z.object({
      groupCode: z.string().min(1).describe('群号'),
      limit: z.number().int().min(1).max(50).default(10).describe('返回条数上限'),
    }),
    run: async ({ groupCode, limit }) => {
      let gc: bigint;
      try {
        gc = BigInt(String(groupCode).trim());
      } catch {
        throw new Error(`群号必须是纯数字：${groupCode}（先用 find_contact 把群名解析成群号）`);
      }
      const list = await services().groupInfo.getGroupBulletins(gc, limit, 0);
      return list.map((b) => {
        const w = groupBulletinToWire(b);
        const t = Number(w.msgTime);
        return {
          text: w.textContent,
          time: t ? fmtTime(t) : '',
          publisherUid: w.publisherUid,
        };
      });
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
      '获取某个群聊的活跃度全量统计——活跃成员排行（已解析成群名片/昵称）、24 时段分布、每日消息趋势、热词词云。' +
      '**默认统计全部历史**（days=0）；传 days>0 才只看最近 N 天。传入群号（可由 find_contact 解析群名得到）。' +
      '内部走全量分页扫描（与「群聊分析」卡片同一套逻辑），不做 5000 条截断，故不会漏统计。' +
      '返回统计数据（JSON），非常适合接着用 write_report 出一份带图表/排行/词云的 HTML 可视化报告。',
    input: z.object({
      groupCode: z.string().min(1).describe('群号（纯数字，可用 find_contact 把群名解析成群号）'),
      days: z
        .number()
        .int()
        .min(0)
        .max(3650)
        .default(0)
        .describe('统计最近 N 天；0=全部历史（默认，最不容易漏数据）'),
      wordLimit: z
        .number()
        .int()
        .min(0)
        .max(300)
        .default(60)
        .describe('词云返回的热词数量；0=不算词云（省时）'),
    }),
    run: async ({ groupCode, days, wordLimit }) => {
      const svc = services();
      let gc: bigint;
      try {
        gc = BigInt(String(groupCode).trim());
      } catch {
        throw new Error(`群号必须是纯数字：${groupCode}（先用 find_contact 把群名解析成群号）`);
      }

      // 复刻「群聊分析」卡片：不限时间=全历史；days>0 时才下推 sendTime 时间窗（unix 秒）。
      let startTime: number | undefined;
      let endTime: number | undefined;
      if (days && days > 0) {
        endTime = Math.floor(Date.now() / 1000);
        startTime = endTime - days * 86400;
      }

      // 全部走 groupInfo 的全量分页统计（listBatch，逐 500 条扫到底），与卡片同源。
      const [ranking, hourlyDistribution, daily, wordCloud] = await Promise.all([
        svc.groupInfo.getGroupMessageRanking(gc, 20, startTime, endTime),
        svc.groupInfo.getGroupActiveHours(gc, startTime, endTime),
        svc.groupInfo.getGroupDailyActivity(gc, startTime, endTime),
        wordLimit > 0
          ? svc.groupInfo.getGroupWordCloud(gc, wordLimit, startTime, endTime)
          : Promise.resolve([]),
      ]);

      const totalMessages = daily.reduce((sum, d) => sum + d.count, 0);

      return {
        groupCode,
        range: days && days > 0 ? `最近 ${days} 天` : '全部历史',
        totalMessages,
        activeDays: daily.length,
        // 排行已解析成群名片/昵称（displayName），报告里可直接展示，不必再自己查名字。
        topSenders: ranking.map((r) => ({ name: r.displayName, uid: r.uid, count: r.messageCount })),
        hourlyDistribution,
        daily,
        wordCloud: wordCloud.map((w) => ({ word: w.word, count: w.count })),
        ...(totalMessages === 0
          ? { hint: '该范围内没有消息记录：确认群号是否正确，或用 days=0 看全部历史。' }
          : {}),
      };
    },
  }),

  tool({
    name: 'get_daily_digest',
    description:
      '一站式「某天活跃总览」——回答「我今天在哪些群发了消息」「今天和哪些好友聊了天」「今日活跃日记」等。' +
      '高效：先用最近会话筛出当天动过的会话，再并发统计，不做全表扫描。date 默认今天，可传 YYYY-MM-DD 看某天（如昨天）。' +
      '返回：totals 总览（我发了多少条/触达会话数/我发言的群数/聊过的好友数/首末活跃时刻/活跃小时数）、hourlyMine 我的逐小时分布、' +
      'groups 当天动过的群（含 myCount 我在该群发言数、totalCount 群当天总条数、lastSnippet 最后一条摘要）、friends 当天私聊好友（含 myCount/peerCount）。' +
      '适合接着用 write_report 出一份带图表/时间线的「活跃日记」HTML 报告。',
    input: z.object({
      date: z.string().default('').describe('某天 YYYY-MM-DD；空=今天'),
    }),
    run: async ({ date }) => {
      const svc = services();
      const { startSec, endSec, label } = dayWindow(date);
      const self = await svc.profile.getSelfProfile();
      const selfUin = self?.uin ?? -1n;

      // 1) 廉价筛出「当天动过」的会话（recent_contact 自带最后消息时间）。
      const contacts = await svc.recentContacts.getRecentContact(200);
      const CAP = 80;
      const touched = contacts
        .filter((c) => Number(c.sendTime) >= startSec && Number(c.sendTime) < endSec)
        .map((c) => ({ c, wire: recentContactToWire(c), kind: convKindOf(c.chatType) }))
        .filter((t): t is { c: typeof t.c; wire: typeof t.wire; kind: 'c2c' | 'group' } => t.kind !== null);
      const capped = touched.slice(0, CAP);

      // 群名映射：一次性建 code→名，避免逐群查询。
      const allGroups = capped.some((t) => t.kind === 'group')
        ? await svc.groupInfo.listAllGroups(500, 0)
        : [];
      const groupNameByCode = new Map(allGroups.map((g) => [g.groupCode.toString(), g.groupName]));

      // 2) 并发读每个会话当天消息并就地统计。
      const READ_GROUP = 800;
      const READ_C2C = 500;
      const perConv = await Promise.all(
        capped.map(async (t) => {
          const conv = t.wire.targetUid;
          const rows =
            t.kind === 'group'
              ? await svc.msgs.getGroupLatest(conv, READ_GROUP)
              : await svc.msgs.getC2cLatest(conv, READ_C2C);
          const limit = t.kind === 'group' ? READ_GROUP : READ_C2C;
          // rows 为最新在前；过滤到当天窗口。
          const day = rows.filter((r) => Number(r.sendTime) >= startSec && Number(r.sendTime) < endSec);
          let myCount = 0;
          const hourly: Record<number, number> = {};
          let lastSec = 0; // 会话当天最后一条（任意人），用于「最近活跃」展示
          let myFirstSec = Infinity; // 我自己当天首/末发言，用于刻画「我的活跃区间」
          let myLastSec = 0;
          for (const r of day) {
            const sec = Number(r.sendTime);
            if (sec > lastSec) lastSec = sec;
            if (r.senderUin === selfUin) {
              myCount += 1;
              if (sec < myFirstSec) myFirstSec = sec;
              if (sec > myLastSec) myLastSec = sec;
              hourly[new Date(sec * 1000).getHours()] = (hourly[new Date(sec * 1000).getHours()] ?? 0) + 1;
            }
          }
          const name =
            t.kind === 'group'
              ? groupNameByCode.get(conv) || t.wire.targetDisplayName || conv
              : t.wire.targetRemark || t.wire.targetDisplayName || t.wire.senderNick || conv;
          // 当天消息条数 >= 读取上限时，更早的可能被截断。
          const truncated = rows.length >= limit && day.length === rows.length;
          return {
            kind: t.kind,
            conv,
            name,
            total: day.length,
            myCount,
            peerCount: day.length - myCount,
            myFirstSec: myFirstSec === Infinity ? 0 : myFirstSec,
            myLastSec,
            lastSec,
            lastSnippet: day.length ? flattenElements(day[0]!.elements).slice(0, 60) : '',
            hourly,
            truncated,
          };
        }),
      );

      // 3) 汇总。
      const hourlyMine: Record<number, number> = {};
      for (let i = 0; i < 24; i++) hourlyMine[i] = 0;
      let myMessages = 0;
      let firstActive = Infinity;
      let lastActive = 0;
      for (const p of perConv) {
        myMessages += p.myCount;
        for (const [h, n] of Object.entries(p.hourly)) {
          hourlyMine[Number(h)] = (hourlyMine[Number(h)] ?? 0) + n;
        }
        if (p.myFirstSec && p.myFirstSec < firstActive) firstActive = p.myFirstSec;
        if (p.myLastSec > lastActive) lastActive = p.myLastSec;
      }
      const groups = perConv
        .filter((p) => p.kind === 'group')
        .sort((a, b) => b.myCount - a.myCount || b.total - a.total)
        .slice(0, 40)
        .map((p) => ({
          groupCode: p.conv,
          groupName: p.name,
          myCount: p.myCount,
          totalCount: p.total,
          lastActive: p.lastSec ? hhmm(p.lastSec) : '',
          lastSnippet: p.lastSnippet,
          ...(p.truncated ? { truncated: true } : {}),
        }));
      const friends = perConv
        .filter((p) => p.kind === 'c2c')
        .sort((a, b) => b.total - a.total)
        .slice(0, 40)
        .map((p) => ({
          uid: p.conv,
          name: p.name,
          myCount: p.myCount,
          peerCount: p.peerCount,
          total: p.total,
          lastActive: p.lastSec ? hhmm(p.lastSec) : '',
          lastSnippet: p.lastSnippet,
        }));
      const activeHours = Object.values(hourlyMine).filter((n) => n > 0).length;

      return {
        date: label,
        self: { uin: selfUin.toString(), nick: self?.nick ?? '' },
        totals: {
          myMessages,
          conversationsTouched: touched.length,
          groupsIPostedIn: groups.filter((g) => g.myCount > 0).length,
          friendsIChattedWith: friends.length,
          firstActive: firstActive === Infinity ? '' : hhmm(firstActive),
          lastActive: lastActive ? hhmm(lastActive) : '',
          activeHours,
        },
        hourlyMine,
        groups,
        friends,
        hint:
          touched.length > CAP
            ? `当天动过的会话有 ${touched.length} 个，仅统计了最近 ${CAP} 个。`
            : myMessages === 0
              ? '这一天你没有发送记录（或消息超出读取上限被截断）。'
              : '可据此用 write_report 生成「活跃日记」；想看与某人具体聊了啥，用 get_messages_by_date。',
      };
    },
  }),

  tool({
    name: 'get_messages_by_date',
    description:
      '读取【某个会话】在【某一天】的逐条消息，按时间正序返回——用于「今天/某天和 XX 聊了什么」做话题归纳，或回看某天群里的讨论。' +
      'kind: c2c=私聊（conv 传对方 uid），group=群聊（conv 传群号）；会话标识可由 find_contact 解析。date 默认今天，可传 YYYY-MM-DD。' +
      '每条为精简形：time（HH:mm）、sender 发送者昵称、mine 是否本人、text 文本。',
    input: z.object({
      kind: z.enum(['c2c', 'group']).describe('会话类型'),
      conv: z.string().min(1).describe('私聊为对方 uid，群聊为群号'),
      date: z.string().default('').describe('某天 YYYY-MM-DD；空=今天'),
      limit: z.number().int().min(1).max(300).default(120).describe('返回条数上限（取当天最近的若干条）'),
    }),
    run: async ({ kind, conv, date, limit }) => {
      const svc = services();
      const { startSec, endSec, label } = dayWindow(date);
      const READ = kind === 'group' ? 1000 : 600;
      const rows =
        kind === 'group' ? await svc.msgs.getGroupLatest(conv, READ) : await svc.msgs.getC2cLatest(conv, READ);
      const day = rows.filter((r) => Number(r.sendTime) >= startSec && Number(r.sendTime) < endSec);

      const selfUin = (await svc.profile.getSelfProfile())?.uin ?? -1n;
      const otherUids = [...new Set(day.filter((r) => r.senderUin !== selfUin).map((r) => r.senderUid))];
      const nameByUid = otherUids.length ? await svc.profile.nicksByUids(otherUids) : {};

      // day 为最新在前；取当天最近 limit 条后翻成旧→新方便顺读。
      const slice = day.slice(0, limit).reverse();
      const messages = slice.map((r) => ({
        time: hhmm(r.sendTime),
        sender: r.senderUin === selfUin ? '我' : nameByUid[r.senderUid] || String(r.senderUin),
        mine: r.senderUin === selfUin,
        text: flattenElements(r.elements),
      }));

      return {
        date: label,
        kind,
        conv,
        count: messages.length,
        messages,
        ...(day.length > limit
          ? { hint: `当天共 ${day.length} 条，只返回最近 ${limit} 条；如需更早可缩小到更早的日期或提高 limit。` }
          : day.length === 0
            ? { hint: '这一天该会话没有消息记录。' }
            : {}),
      };
    },
  }),

  tool({
    name: 'export_conversation',
    assistantOnly: true, // 写本地导出文件（有副作用）→ 不进只读 MCP server，仅助手可用
    description:
      '把某个会话的聊天记录【快速导出】成一个本地文件，完成后会在你的回复里出现一张「导出」卡片，用户可「打开」或「另存为」。' +
      'kind: c2c=私聊（conv 传对方 uid），group=群聊（conv 传群号）；会话标识可由 find_contact 解析。' +
      'format 默认 html（自带样式、可直接看），也支持 txt/json/jsonl/csv/xlsx。days 只导出最近 N 天（不传=全部）。' +
      '注意：本工具只导出纯文字记录、不含图片/语音/视频；要带媒体或超大批量，请提示用户去应用内「导出中心」操作。',
    input: z.object({
      kind: z.enum(['c2c', 'group']).describe('会话类型'),
      conv: z.string().min(1).describe('私聊为对方 uid，群聊为群号'),
      format: z.enum(['html', 'txt', 'json', 'jsonl', 'csv', 'xlsx']).default('html').describe('导出格式，默认 html'),
      name: z.string().default('').describe('文件名（建议传联系人/群名，便于识别）'),
      days: z.number().int().min(1).max(3650).default(0).describe('只导出最近 N 天；0/不传=全部时间'),
    }),
    run: async ({ kind, conv, format, name, days }) => {
      const svc = services();
      const stem = (name || '').trim() || `导出-${conv}`;
      const total = await svc.msgs.countConv(kind, conv);
      const range =
        days > 0 ? { start: Math.floor(Date.now() / 1000) - days * 86400, end: null } : undefined;

      const taskId = await svc.exportManager.startTask({ kind, conv, name: stem, format, total, range });
      const task = await waitForExport(svc.exportManager, taskId);

      const path = task.filePath || task.bundleDir;
      if (!path) throw new Error('导出完成但未找到结果文件。');
      const { statSync } = await import('node:fs');
      let bytes = 0;
      try {
        bytes = statSync(path).size;
      } catch {
        bytes = 0;
      }

      return {
        artifactCard: {
          id: taskId,
          name: `${stem}.${format}`,
          kind: 'export' as const,
          mime: EXPORT_MIME[format] ?? 'application/octet-stream',
          bytes,
        },
        ok: true,
        exported: total,
        format,
        message: `已导出${total ? ` ${total} 条` : ''}聊天记录为 ${format.toUpperCase()} 文件，卡片里可「打开」或「另存为」。`,
      };
    },
  }),
];

