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
  /** 与上一条（更早那条）的时间间隔，人读形式（如「2小时」）；仅在间隔较大时附上。 */
  gap?: string;
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

/** 秒数 → 精简中文时长（如「3天」「5小时」「12分钟」「刚刚」）。给「距今多久/间隔多久」用。 */
function humanDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return '刚刚';
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}天`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}个月`;
  return `${Math.floor(day / 365)}年`;
}

/** 容错解析翻页游标（模型回传，可能带空格/非法字符）；解析失败视作「无游标」而非抛错。 */
function safeBigint(text: string): bigint | null {
  try {
    return BigInt(text.trim());
  } catch {
    return null;
  }
}

/**
 * 排行/统计类工具的「范围说明」信封字段。给 LLM 一个恒定可读的窗口描述 + coverage 提醒，
 * 让低质模型每轮都看到「算的是哪段、数据可能不全」，而不是靠 system prompt 一句话约束。
 */
function rangeLabel(days: number, windowStart: number | null): string {
  if (days > 0 && windowStart) return `最近 ${days} 天（${fmtDate(windowStart)} 起至今）`;
  return '全部本地历史';
}

/** 排行类工具的统一 coverage 提醒——只统计本地已同步的消息。 */
const RANK_COVERAGE = '仅基于本地已同步的聊天记录统计；未漫游/未拉取的历史不计入。';

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

/**
 * 解析一个「日期区间」为本地 [startSec, endSec) 半开窗口（秒）。start/end 均为
 * YYYY-MM-DD，end 含当天（内部 +1 天转半开）。给 compare_periods 的任意两段对比用。
 */
function rangeWindow(start: string, end: string): { startSec: number; endSec: number; label: string } {
  const parse = (s: string): Date => {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec((s ?? '').trim());
    if (!m) throw new Error(`无效日期：${s}（应为 YYYY-MM-DD，例如 2026-06-30）`);
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(d.getTime())) throw new Error(`无效日期：${s}`);
    return d;
  };
  const a = parse(start);
  const b = parse(end);
  const startSec = Math.floor(a.getTime() / 1000);
  const endSec = Math.floor(b.getTime() / 1000) + 86400; // end 含当天
  if (endSec <= startSec) throw new Error(`区间起止颠倒：${start} ~ ${end}（结束应不早于开始）`);
  return { startSec, endSec, label: `${fmtDate(startSec)} ~ ${fmtDate(endSec - 86400)}` };
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
      '返回精简命中：time 时间、scope 会话类型、conv 会话标识、sender 发送者昵称、mine 是否本人发送、text 文本。' +
      '\n【怎么用我】底层是**本地字面关键词匹配**，不理解整句问题：keyword 只能传一个最有辨识度、可能真出现在原话里的短词/短语，' +
      '别把用户的问句、同义词列表或空格拼接的多词丢进来。想限定某个人/某个群里搜，改用 search_in_conversation 更准。' +
      '\n【结果不能代表什么】一次零命中**不等于**内容不存在——可能是词没选对；要换更短/近义的关键词多试几次，或改用 get_messages 直接把相关会话读出来判断。' +
      '命中的原话可作为「谁在何时说过某字面词」的直接证据，但**别拿前几十条命中当完整名单**（要「还有谁说过 X」用 find_people_who_mentioned），也别据此推断关系亲疏——那要接 inspect_timeline / get_messages 核验。',
    input: z.object({
      keyword: z.string().min(1).describe('搜索关键词'),
      scope: z.enum(['all', 'buddy', 'group']).default('all').describe('搜索范围'),
      limit: z.number().int().min(1).max(50).default(20).describe('返回条数上限'),
    }),
    run: async ({ keyword, scope, limit }) => {
      const svc = services();
      const search = svc.msgSearch;
      // 多探一条判断是否还有更多命中（诚实的 hasMore）；合并 all 时两路各探再并。
      const probe = limit + 1;
      const raw =
        scope === 'buddy'
          ? await search.searchBuddy(keyword, probe)
          : scope === 'group'
            ? await search.searchGroup(keyword, probe)
            : [...(await search.searchBuddy(keyword, probe)), ...(await search.searchGroup(keyword, probe))].sort(
                (a, b) => Number(b.sendTime - a.sendTime),
              );
      const hasMore = raw.length > limit;
      const hits = raw.slice(0, limit);

      const selfUid = (await svc.profile.getSelfProfile())?.uid ?? '';
      const otherUids = [...new Set(hits.filter((h) => h.senderUid !== selfUid).map((h) => h.senderUid))];
      const nameByUid = otherUids.length ? await svc.profile.nicksByUids(otherUids) : {};

      const items = hits.map((h) => ({
        time: fmtTime(h.sendTime),
        scope: Number(h.chatType) === 2 ? 'group' : 'c2c',
        conv: h.targetUid,
        sender: h.senderUid === selfUid ? '我' : nameByUid[h.senderUid] || h.senderUid,
        mine: h.senderUid === selfUid,
        text: h.content,
        ...(h.fileName ? { file: h.fileName } : {}),
      }));

      return {
        keyword,
        scope,
        count: items.length,
        hasMore,
        coverage: RANK_COVERAGE,
        hits: items,
        ...(items.length === 0
          ? { hint: `没搜到含「${keyword}」的消息；换更短/近义的关键词再试，或改用 get_messages 直接读会话判断。零命中不代表内容不存在。` }
          : hasMore
            ? { hint: `命中较多，只返回按时间最新的 ${limit} 条；调大 limit 或换更具体的关键词收窄。` }
            : {}),
      };
    },
  }),

  tool({
    name: 'search_in_conversation',
    description:
      '在【指定会话内】全文搜索关键词——比全局 search_messages 更精准，专治「某人/某群里 TA 说过什么」。' +
      'kind: c2c=私聊（conv 传对方 uid），group=群聊（conv 传群号）。会话标识来自 find_contact / list_conversations / list_groups。' +
      '提到人名/群名时先用 find_contact 解析成会话标识，再用这个在该会话里搜，别把人名当关键词。' +
      '返回 hits：time 时间、sender 发送者昵称、mine 是否本人发送、text 文本；带 hasMore（命中是否被截断）。' +
      '同样是字面匹配：keyword 传短词、零命中≠不存在，可换词或改用 get_messages 顺读。',
    input: z.object({
      kind: z.enum(['c2c', 'group']).describe('会话类型'),
      conv: z.string().min(1).describe('私聊为对方 uid，群聊为群号'),
      keyword: z.string().min(1).describe('搜索关键词'),
      limit: z.number().int().min(1).max(50).default(20).describe('返回条数上限'),
    }),
    run: async ({ kind, conv, keyword, limit }) => {
      const svc = services();
      const probe = limit + 1;
      const raw =
        kind === 'group'
          ? await svc.msgSearch.searchInGroupConversation(conv, keyword, probe)
          : await svc.msgSearch.searchInBuddyConversation(conv, keyword, probe);
      const hasMore = raw.length > limit;
      const hits = raw.slice(0, limit);

      const selfUid = (await svc.profile.getSelfProfile())?.uid ?? '';
      const otherUids = [...new Set(hits.filter((h) => h.senderUid !== selfUid).map((h) => h.senderUid))];
      const nameByUid = otherUids.length ? await svc.profile.nicksByUids(otherUids) : {};

      const items = hits.map((h) => ({
        time: fmtTime(h.sendTime),
        sender: h.senderUid === selfUid ? '我' : nameByUid[h.senderUid] || h.senderUid,
        mine: h.senderUid === selfUid,
        text: h.content,
        ...(h.fileName ? { file: h.fileName } : {}),
      }));

      return {
        kind,
        conv,
        keyword,
        count: items.length,
        hasMore,
        coverage: RANK_COVERAGE,
        hits: items,
        ...(items.length === 0
          ? { hint: `该会话里没搜到含「${keyword}」的消息；换更短/近义关键词，或用 get_messages 顺读判断。零命中不代表没说过。` }
          : hasMore
            ? { hint: `命中较多，只返回 ${limit} 条；调大 limit 或换更具体的关键词。` }
            : {}),
      };
    },
  }),

  tool({
    name: 'find_people_who_mentioned',
    description:
      '【按人聚合的关键词检索】搜某个关键词（如「吃饭」「借钱」「出去玩」），把命中**按发言人归类**，' +
      '数出「谁提得最多、最近一次什么时候提的」——直接回答「还有谁说过 X」「最近谁跟我约过 XX」。' +
      '比 search_messages 更适合「按人找」：后者把命中按时间平铺、要你自己数；这个已经替你 group by 人。' +
      'scope: buddy=私聊里、group=群聊里、all=两者。days 限定最近 N 天（默认 0=全部历史）。' +
      'includeMe=false（默认）时不把我自己的发言算进去，只看别人提没提。' +
      '返回每人：name 名称、hits 命中次数、lastTime 最近一次、sample 一条样例原文、scope 命中所在会话类型。',
    input: z.object({
      keyword: z.string().min(1).describe('要检索的关键词/短语'),
      scope: z.enum(['all', 'buddy', 'group']).default('all').describe('检索范围：私聊/群聊/两者'),
      days: z.number().int().min(0).max(3650).default(0).describe('只看最近 N 天；0=全部历史'),
      includeMe: z.boolean().default(false).describe('是否把我自己的发言也算进去（默认否）'),
      limit: z.number().int().min(1).max(50).default(15).describe('返回前几名发言人'),
    }),
    run: async ({ keyword, scope, days, includeMe, limit }) => {
      const svc = services();
      // FTS 末尾会 slice(0, POOL)，聚合要尽量多的命中垫底 → 顶到池上限 500。
      const POOL = 500;
      const raw =
        scope === 'buddy'
          ? await svc.msgSearch.searchBuddy(keyword, POOL)
          : scope === 'group'
            ? await svc.msgSearch.searchGroup(keyword, POOL)
            : [...(await svc.msgSearch.searchBuddy(keyword, POOL)), ...(await svc.msgSearch.searchGroup(keyword, POOL))];

      const selfUid = (await svc.profile.getSelfProfile())?.uid ?? '';
      const cutoff = days > 0 ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
      const hits = raw.filter((h) => {
        if (cutoff && Number(h.sendTime) < cutoff) return false;
        if (!includeMe && h.senderUid === selfUid) return false;
        return !!h.senderUid;
      });

      // 按发言人聚合：命中数、最近一次时间、一条样例、命中所在会话类型集合。
      interface Agg {
        uid: string;
        hits: number;
        lastSec: number;
        sample: string;
        scopes: Set<'c2c' | 'group'>;
      }
      const byUid = new Map<string, Agg>();
      for (const h of hits) {
        const sec = Number(h.sendTime);
        const kindScope: 'c2c' | 'group' = Number(h.chatType) === 2 ? 'group' : 'c2c';
        const cur = byUid.get(h.senderUid);
        if (!cur) {
          byUid.set(h.senderUid, { uid: h.senderUid, hits: 1, lastSec: sec, sample: h.content, scopes: new Set([kindScope]) });
        } else {
          cur.hits += 1;
          cur.scopes.add(kindScope);
          if (sec > cur.lastSec) {
            cur.lastSec = sec;
            cur.sample = h.content; // 样例取最近一条，最贴合「最近谁提过」
          }
        }
      }

      const ranked = [...byUid.values()].sort((a, b) => b.hits - a.hits || b.lastSec - a.lastSec).slice(0, limit);
      const nameByUid = ranked.length
        ? await svc.profile.nicksByUids(ranked.map((r) => r.uid).filter((u) => u !== selfUid))
        : {};

      return {
        keyword,
        range: days > 0 ? `最近 ${days} 天` : '全部本地历史',
        coverage: RANK_COVERAGE,
        totalHits: hits.length,
        peopleCount: byUid.size,
        items: ranked.map((r) => ({
          name: r.uid === selfUid ? '我' : nameByUid[r.uid] || r.uid,
          uid: r.uid,
          hits: r.hits,
          lastTime: fmtTime(r.lastSec),
          scope: [...r.scopes].join('+'),
          sample: r.sample.slice(0, 80),
        })),
        hint:
          byUid.size === 0
            ? `没搜到含「${keyword}」的发言（这段时间内）；可换同义词、放宽 days、或把 includeMe 设 true 连自己一起看。`
            : raw.length >= POOL
              ? `命中较多、已按相关度取前 ${POOL} 条聚合；结果偏「谁高频提到」，个别少量提及者可能未纳入。`
              : '这是「谁提得多」的线索；确认具体语境请用 search_in_conversation 到对应会话看原文。',
      };
    },
  }),

  tool({
    name: 'list_conversations',
    description: '列出最近会话（私聊与群聊），最新在前。用来给后续工具挑选目标会话——从返回的 conv/kind 接 get_messages / get_messages_by_date 读原文，或先看「最近在跟谁来往」。想按活跃量排行别用它（那用 rank_friends_by_activity / get_period_overview）。',
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
      '读取某个会话的消息，按时间正序（旧→新）返回，方便顺读。默认取最新一页。' +
      'kind: c2c=私聊（conv 传对方 uid），group=群聊（conv 传群号）。会话标识可来自 list_conversations / list_groups。' +
      '每条为精简形：time 时间、sender 发送者昵称、mine 是否本人发送、text 文本；间隔较大时附 gap（距上一条多久）。' +
      '\n【翻页】返回带 hasMore / nextBefore：还想往更早读，就把 nextBefore 原样传回 before 参数取上一页；' +
      '一次别把 limit 开太大，顺着翻更省 token 也更聚焦。',
    input: z.object({
      kind: z.enum(['c2c', 'group']).describe('会话类型'),
      conv: z.string().min(1).describe('私聊为对方 uid，群聊为群号'),
      limit: z.number().int().min(1).max(100).default(30).describe('返回条数上限'),
      before: z.string().default('').describe('翻页游标：上一次返回的 nextBefore（读更早的一页）；不传=最新一页'),
    }),
    run: async ({ kind, conv, limit, before }) => {
      const svc = services();
      const selfUin = (await svc.profile.getSelfProfile())?.uin ?? -1n;
      const beforeSeq = before.trim() ? safeBigint(before) : null;
      // 探测法：多取一条判断是否还有更早的消息，既得到诚实的 hasMore、又不返回会翻出空页的游标。
      const probe = limit + 1;
      const rows =
        kind === 'group'
          ? beforeSeq != null
            ? await svc.msgs.getGroupBefore(conv, beforeSeq, probe)
            : await svc.msgs.getGroupLatest(conv, probe)
          : beforeSeq != null
            ? await svc.msgs.getC2cBefore(conv, beforeSeq, probe)
            : await svc.msgs.getC2cLatest(conv, probe);

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit); // DB 最新在前，取最新的 limit 条
      // 更早一页的游标 = 本页最旧那条的 seq（page 仍是新→旧，故取末元素）。
      const nextBefore = hasMore && page.length ? String(page[page.length - 1]!.msgSeq) : '';

      // 名字解析：自己=「我」，其余批量取昵称（私聊就对方一个人，群聊各发言人）。
      const otherUids = [...new Set(page.filter((r) => r.senderUin !== selfUin).map((r) => r.senderUid))];
      const nameByUid = otherUids.length ? await svc.profile.nicksByUids(otherUids) : {};

      const ordered = [...page].reverse(); // 翻成旧→新方便顺读
      const messages: AiMsgLine[] = ordered.map((r, i) => {
        const line: AiMsgLine = {
          time: fmtTime(r.sendTime),
          sender: r.senderUin === selfUin ? '我' : nameByUid[r.senderUid] || String(r.senderUin),
          mine: r.senderUin === selfUin,
          text: flattenElements(r.elements),
        };
        // 与上一条（更早那条）的间隔：只在 ≥30 分钟时标注，给「聊天有没有断档」的时间感又不刷屏。
        if (i > 0) {
          const gapSec = Number(r.sendTime) - Number(ordered[i - 1]!.sendTime);
          if (gapSec >= 1800) line.gap = humanDuration(gapSec);
        }
        return line;
      });

      return {
        kind,
        conv,
        count: messages.length,
        hasMore,
        ...(nextBefore ? { nextBefore } : {}),
        coverage: RANK_COVERAGE,
        messages,
        ...(messages.length === 0
          ? { hint: beforeSeq != null ? '没有更早的消息了。' : '该会话本地没有消息记录（确认 conv 是否正确、或消息尚未同步）。' }
          : hasMore
            ? { hint: `还有更早的消息；把 nextBefore 传回 before 可继续往前读。` }
            : {}),
      };
    },
  }),

  tool({
    name: 'list_groups',
    description: '列出当前账号加入的群聊（群号、群名等）。用来枚举/挑群，或把群名对上群号（只找某一个群更快的是 find_contact / search_groups）。拿到群号后接 get_messages / get_group_activity / list_group_members 等。',
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
    description: '列出当前账号的 QQ 好友（uid、uin、昵称、备注等）。用来枚举好友或把昵称对上 uid（只找某一个人更快的是 find_contact / search_buddies）。拿到 uid 后接 get_messages / inspect_timeline / get_user_profile 等。想要「和谁聊得最多」的排行用 rank_friends_by_activity，别自己遍历。',
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
          (p.nick?.toLowerCase().includes(q)) ||
          (p.remark?.toLowerCase().includes(q)),
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
      const matched = all.filter((g) => !q || (g.groupName?.toLowerCase().includes(q)));
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
    name: 'inspect_timeline',
    description:
      '【单个好友的关系时间线】把我和某个好友的私聊摊成一条时间线：首次/最近一次聊天、**距今多久没联系**、' +
      '逐月消息量、**最长沉默期**（中间断得最久的一段）、近30天 vs 近90天对比、以及**建议进一步阅读的日期窗口**（消息量高峰的那几天）。' +
      '用于「我和 XX 是什么时候熟起来的/多久没联系了/关系降温了吗」这类关系深挖。传对方 uid（可用 find_contact 解析人名）。' +
      '注意：这是**时间结构线索**，不含具体聊了什么——想看某段窗口的原话，用返回的 readWindows 里的日期接 get_messages_by_date。',
    input: z.object({
      uid: z.string().min(1).describe('目标好友的 uid（可用 find_contact 把人名解析成 uid）'),
    }),
    run: async ({ uid }) => {
      const svc = services();
      const a = await svc.buddyAnalytics.getBuddyAnalytics(uid);
      const daily = [...a.daily].sort((x, y) => x.date.localeCompare(y.date)); // 只含有消息的日子，升序
      const now = Date.now();
      const dayMs = 86400_000;
      const nameByUid = await svc.profile.nicksByUids([uid]);

      if (daily.length === 0 || a.statistics.totalMessages === 0) {
        return {
          uid,
          name: nameByUid[uid] || uid,
          found: false,
          hint: '本地没有和该好友的私聊记录；确认 uid 是否正确（find_contact 解析），或消息尚未同步。',
        };
      }

      const first = a.statistics.firstMessageTime ?? 0;
      const last = a.statistics.lastMessageTime ?? 0;
      const daysSinceLast = last ? Math.floor((now / 1000 - last) / 86400) : null;

      // 最长沉默期：相邻两个「有消息日期」之间的最大间隔（天）。
      let longestSilence = { days: 0, from: '', to: '' };
      for (let i = 1; i < daily.length; i++) {
        const prev = new Date(`${daily[i - 1]!.date}T00:00:00`).getTime();
        const cur = new Date(`${daily[i]!.date}T00:00:00`).getTime();
        const gap = Math.round((cur - prev) / dayMs);
        if (gap > longestSilence.days) longestSilence = { days: gap, from: daily[i - 1]!.date, to: daily[i]!.date };
      }

      // 近 30 / 90 天消息量（用 daily 求和，省去再扫库）。
      const since = (d: number): number => {
        const cut = new Date(now - d * dayMs);
        const cutYmd = `${cut.getFullYear()}-${pad2(cut.getMonth() + 1)}-${pad2(cut.getDate())}`;
        return daily.filter((x) => x.date >= cutYmd).reduce((s, x) => s + x.count, 0);
      };
      const last30 = since(30);
      const last90 = since(90);

      // 逐月消息量。
      const byMonth = new Map<string, number>();
      for (const d of daily) byMonth.set(d.date.slice(0, 7), (byMonth.get(d.date.slice(0, 7)) ?? 0) + d.count);
      const monthly = [...byMonth.entries()].map(([month, count]) => ({ month, count }));

      // 建议阅读窗口：消息量最高的前 3 天（最值得回看原话的高峰）。
      const readWindows = [...daily].sort((x, y) => y.count - x.count).slice(0, 3).map((d) => ({ date: d.date, count: d.count }));

      return {
        uid,
        name: nameByUid[uid] || uid,
        found: true,
        coverage: RANK_COVERAGE,
        firstChat: fmtDate(first),
        lastChat: fmtDate(last),
        daysSinceLastChat: daysSinceLast,
        totalMessages: a.statistics.totalMessages,
        sentVsReceived: { mine: a.statistics.selfMessages, peer: a.statistics.peerMessages },
        activeDays: a.statistics.activeDays,
        initiation: a.initiation, // 谁更常先开口
        streak: a.streak, // 火花：连续双方都说话的天数
        last30Days: last30,
        last90Days: last90,
        recentTrend:
          last90 > 0
            ? last30 >= last90 * 0.5
              ? '近30天占近90天过半，最近更密集'
              : last30 === 0
                ? '近30天无往来，可能已降温'
                : '近30天明显少于前期，有降温迹象'
            : '近90天无往来',
        longestSilence,
        monthly,
        readWindows,
        hint: '想看某段具体聊了什么，用 readWindows 里的 date 接 get_messages_by_date(kind=c2c, conv=uid, date=…)。以上只是时间结构线索，别据此直接下关系结论。',
      };
    },
  }),

  tool({
    name: 'rank_friends_by_activity',
    description:
      '【私聊活跃排行】把我的**所有好友**按最近一段时间的私聊消息量从多到少排出来——直接回答' +
      '「我最近和谁聊得最多/最火热」「这周谁聊得最勤」。内部一次性聚合全部好友（不是逐个查、也不会漏人），' +
      'days 控制窗口（默认 7 天，0=全部历史）。返回每位：rank 名次、name 名称、total 总条数、mine 我发的、peer 对方发的。' +
      '注意：消息条数只是**热度线索**，不等于关系亲疏；要判断关系还需结合具体聊了什么、谁主动。' +
      '想深挖某人再用 get_buddy_analytics / get_messages。',
    input: z.object({
      days: z.number().int().min(0).max(3650).default(7).describe('统计最近 N 天；0=全部历史'),
      limit: z.number().int().min(1).max(100).default(15).describe('返回前几名'),
    }),
    run: async ({ days, limit }) => {
      const { windowStart, items } = await services().buddyAnalytics.rankFriendsByActivity(days);
      const top = items.slice(0, limit).map((it, i) => ({
        rank: i + 1,
        name: it.remark || it.nick || it.uin || it.uid,
        uid: it.uid,
        uin: it.uin,
        total: it.total,
        mine: it.mine,
        peer: it.peer,
      }));
      return {
        range: rangeLabel(days, windowStart),
        coverage: RANK_COVERAGE,
        activeFriends: items.length,
        items: top,
        hint:
          items.length === 0
            ? '该时间窗内没有任何私聊记录；可把 days 调大或用 0 看全部历史。'
            : '这是「聊得多少」的热度排行，不代表关系深浅；要下结论请再看具体聊天内容（get_messages / get_buddy_analytics）。',
      };
    },
  }),

  tool({
    name: 'rank_my_groups_by_activity',
    description:
      '【群活跃排行】把我加入的**所有群**按最近一段时间的活跃度从高到低排出来。by="me"（默认）按' +
      '**我在群里的发言量**排——回答「我最近最活跃/最常冒泡的是哪个群」；by="all" 按**群总消息量**排——' +
      '回答「哪个群最热闹」。内部一次性聚合全部群（不逐个查、不漏群），days 控制窗口（默认 7 天，0=全部历史）。' +
      '返回每个群：rank 名次、groupName 群名、groupCode 群号、count 条数。' +
      '想知道某个群在聊什么，接着用 get_group_activity（词云/趋势）或 get_messages_by_date（逐条）。',
    input: z.object({
      days: z.number().int().min(0).max(3650).default(7).describe('统计最近 N 天；0=全部历史'),
      by: z
        .enum(['me', 'all'])
        .default('me')
        .describe('me=按我的发言量排（我最活跃的群）；all=按群总消息量排（最热闹的群）'),
      limit: z.number().int().min(1).max(100).default(15).describe('返回前几名'),
    }),
    run: async ({ days, by, limit }) => {
      const { windowStart, items } = await services().groupInfo.rankMyGroupsByActivity(days, by);
      const top = items.slice(0, limit).map((it, i) => ({
        rank: i + 1,
        groupName: it.groupName,
        groupCode: it.groupCode,
        count: it.count,
      }));
      return {
        range: rangeLabel(days, windowStart),
        coverage: RANK_COVERAGE,
        countedBy: by === 'me' ? '我的发言量' : '群总消息量',
        activeGroups: items.length,
        items: top,
        hint:
          items.length === 0
            ? '该时间窗内你的群没有消息记录；可把 days 调大或用 0 看全部历史。'
            : '想看某个群具体在聊什么，用 groupCode 接 get_group_activity（词云/趋势）或 get_messages_by_date（逐条）。',
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
    name: 'get_period_overview',
    description:
      '【账号级周报/月报总览】一站式回答「帮我写份聊天数据周报」「我最近一个月的社交总览」。' +
      '把最近一段时间跨【所有私聊 + 所有群】的活跃度汇总成一份账号级报告，并**自动和上一个等长周期对比**（环比升降）。' +
      'days 控制周期长度（默认 7=周报，可 30=月报，等等）。内部只做聚合计数、不逐条扫消息，覆盖全部会话不漏。' +
      '返回：range 周期说明、totals（私聊消息量/群消息量/我发的/收到的/活跃私聊数/活跃群数，各带对上周期的 delta 环比）、' +
      'topFriends 私聊活跃榜、topGroups 我最活跃的群榜。非常适合接着用 write_report 出一份可视化 HTML 周报。',
    input: z.object({
      days: z.number().int().min(1).max(365).default(7).describe('周期天数：7=周报，30=月报'),
      topN: z.number().int().min(1).max(30).default(8).describe('好友/群榜各取前几名'),
    }),
    run: async ({ days, topN }) => {
      const svc = services();
      const now = Math.floor(Date.now() / 1000);
      const span = days * 86400;
      const curWin = { startTime: now - span, endTime: now };
      const prevWin = { startTime: now - span * 2, endTime: now - span };

      // 当前周期与上一等长周期各跑一次好友榜+群榜（复用 ①② 的聚合，各一条 SQL）。
      const [curFriends, prevFriends, curGroups, prevGroups] = await Promise.all([
        svc.buddyAnalytics.rankFriendsByActivity(days, curWin),
        svc.buddyAnalytics.rankFriendsByActivity(days, prevWin),
        svc.groupInfo.rankMyGroupsByActivity(days, 'me', curWin),
        svc.groupInfo.rankMyGroupsByActivity(days, 'me', prevWin),
      ]);

      const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);
      // 私聊侧账号级汇总。
      const c2cMine = sum(curFriends.items.map((f) => f.mine));
      const c2cPeer = sum(curFriends.items.map((f) => f.peer));
      const c2cTotal = c2cMine + c2cPeer;
      const prevC2cTotal = sum(prevFriends.items.map((f) => f.total));
      // 群侧账号级汇总（by='me'，即我在群里发的）。
      const groupMine = sum(curGroups.items.map((g) => g.count));
      const prevGroupMine = sum(prevGroups.items.map((g) => g.count));

      const delta = (cur: number, prev: number): { value: number; delta: number; deltaPct: number | null } => ({
        value: cur,
        delta: cur - prev,
        deltaPct: prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null,
      });

      const startD = fmtDate(curWin.startTime);
      const endD = fmtDate(now);

      return {
        range: `最近 ${days} 天（${startD} ~ ${endD}）`,
        comparedTo: `上一个 ${days} 天（${fmtDate(prevWin.startTime)} ~ ${startD}）`,
        coverage: RANK_COVERAGE,
        totals: {
          c2cMessages: delta(c2cTotal, prevC2cTotal), // 私聊总消息（我+对方）
          c2cSent: c2cMine, // 私聊我发的
          c2cReceived: c2cPeer, // 私聊我收到的
          groupMessagesByMe: delta(groupMine, prevGroupMine), // 我在群里发的
          activeFriends: delta(curFriends.items.length, prevFriends.items.length),
          activeGroups: delta(curGroups.items.length, prevGroups.items.length),
        },
        topFriends: curFriends.items.slice(0, topN).map((f, i) => ({
          rank: i + 1,
          name: f.remark || f.nick || f.uin || f.uid,
          uid: f.uid,
          total: f.total,
          mine: f.mine,
          peer: f.peer,
        })),
        topGroups: curGroups.items.slice(0, topN).map((g, i) => ({
          rank: i + 1,
          groupName: g.groupName,
          groupCode: g.groupCode,
          myMessages: g.count,
        })),
        hint:
          c2cTotal === 0 && groupMine === 0
            ? '该周期内没有你的聊天记录；确认账号数据已同步，或把 days 调大。'
            : 'delta 为对上一等长周期的增减、deltaPct 为百分比（上期为 0 时为 null）。可据此用 write_report 出一份带环比图表的 HTML 周报；想深挖某人/某群再用 get_buddy_analytics / get_group_activity。',
      };
    },
  }),

  tool({
    name: 'compare_periods',
    description:
      '【任意两个日期段对比】给两段自定义时间区间 periodA / periodB，对比消息量与我发/收到的变化——' +
      '回答「我和 XX 这个月比上个月聊得多还是少」「国庆那周 vs 平时的群活跃差多少」这类**指定区间**的对比。' +
      '不传 conv=账号级对比（跨所有私聊+群）；传 conv 则只比这一个会话（kind=c2c 传对方 uid，kind=group 传群号，可用 find_contact 解析）。' +
      '每段日期用 start/end（YYYY-MM-DD，含起止当天）。返回两段各自指标 + delta 差值/百分比。' +
      '想要「最近N天 vs 上一个等长周期」这种滚动环比，直接用 get_period_overview 更省事；本工具专用于**手动指定**的两段。',
    input: z.object({
      periodA: z
        .object({ start: z.string().describe('起 YYYY-MM-DD'), end: z.string().describe('止 YYYY-MM-DD（含当天）') })
        .describe('第一个日期段'),
      periodB: z
        .object({ start: z.string().describe('起 YYYY-MM-DD'), end: z.string().describe('止 YYYY-MM-DD（含当天）') })
        .describe('第二个日期段'),
      kind: z.enum(['c2c', 'group']).optional().describe('只比单个会话时传：c2c=私聊 / group=群聊'),
      conv: z.string().optional().describe('只比单个会话时传：私聊对方 uid 或群号（配合 kind）'),
    }),
    run: async ({ periodA, periodB, kind, conv }) => {
      const svc = services();
      const winA = rangeWindow(periodA.start, periodA.end);
      const winB = rangeWindow(periodB.start, periodB.end);
      const selfUid = svc.msgs.selfUid();

      const diff = (a: number, b: number): { a: number; b: number; delta: number; deltaPct: number | null } => ({
        a,
        b,
        delta: a - b,
        deltaPct: b > 0 ? Math.round(((a - b) / b) * 100) : null,
      });

      // ── 单会话对比 ──────────────────────────────────────────────
      if (kind && conv) {
        const w = (win: { startSec: number; endSec: number }) => ({
          startTime: win.startSec,
          endTime: win.endSec - 1, // countConv 的 endTime 为闭区间上界
        });
        const [totalA, mineA, totalB, mineB] = await Promise.all([
          svc.msgs.countConv(kind, conv, w(winA)),
          selfUid ? svc.msgs.countConv(kind, conv, { ...w(winA), senderUid: selfUid }) : Promise.resolve(0),
          svc.msgs.countConv(kind, conv, w(winB)),
          selfUid ? svc.msgs.countConv(kind, conv, { ...w(winB), senderUid: selfUid }) : Promise.resolve(0),
        ]);
        return {
          scope: 'conversation',
          kind,
          conv,
          periodA: winA.label,
          periodB: winB.label,
          coverage: RANK_COVERAGE,
          total: diff(totalA, totalB),
          mine: diff(mineA, mineB),
          peer: diff(totalA - mineA, totalB - mineB),
          hint:
            totalA === 0 && totalB === 0
              ? '两段区间该会话都没有消息；确认 conv/kind 是否正确、数据是否已同步。'
              : 'a=periodA、b=periodB；delta=a-b、deltaPct 为相对 b 的百分比（b 为 0 时 null）。想看具体聊了什么用 get_messages_by_date。',
        };
      }

      // ── 账号级对比（复用 ①② 的窗口聚合）──────────────────────────
      const win = (r: { startSec: number; endSec: number }) => ({ startTime: r.startSec, endTime: r.endSec - 1 });
      const [fa, fb, ga, gb] = await Promise.all([
        svc.buddyAnalytics.rankFriendsByActivity(0, win(winA)),
        svc.buddyAnalytics.rankFriendsByActivity(0, win(winB)),
        svc.groupInfo.rankMyGroupsByActivity(0, 'me', win(winA)),
        svc.groupInfo.rankMyGroupsByActivity(0, 'me', win(winB)),
      ]);
      const sum = (ns: number[]): number => ns.reduce((s, n) => s + n, 0);
      const c2cA = sum(fa.items.map((f) => f.total));
      const c2cB = sum(fb.items.map((f) => f.total));
      const mineA = sum(fa.items.map((f) => f.mine));
      const mineB = sum(fb.items.map((f) => f.mine));
      const grpA = sum(ga.items.map((g) => g.count));
      const grpB = sum(gb.items.map((g) => g.count));

      return {
        scope: 'account',
        periodA: winA.label,
        periodB: winB.label,
        coverage: RANK_COVERAGE,
        c2cMessages: diff(c2cA, c2cB),
        c2cSentByMe: diff(mineA, mineB),
        groupMessagesByMe: diff(grpA, grpB),
        activeFriends: diff(fa.items.length, fb.items.length),
        activeGroups: diff(ga.items.length, gb.items.length),
        hint:
          c2cA === 0 && c2cB === 0 && grpA === 0 && grpB === 0
            ? '两段区间都没有聊天记录；确认日期与数据同步。'
            : 'a=periodA、b=periodB；delta=a-b、deltaPct 为相对 b 的百分比。想按人/群看差异用 rank_friends_by_activity / rank_my_groups_by_activity。',
      };
    },
  }),

  tool({
    name: 'get_messages_by_date',
    description:
      '读取【某个会话】在【某一天】的逐条消息，按时间正序返回——用于「今天/某天和 XX 聊了什么」做话题归纳，或回看某天群里的讨论。' +
      'kind: c2c=私聊（conv 传对方 uid），group=群聊（conv 传群号）；会话标识可由 find_contact 解析。date 默认今天，可传 YYYY-MM-DD。' +
      '每条为精简形：time（HH:mm）、sender 发送者昵称、mine 是否本人、text 文本；间隔较大时附 gap（距上一条多久）。' +
      '\n【局限】只在该会话最近若干条里筛当天；查很久以前的某天可能扫不到（返回 coverage 会点明），那种情况改用 inspect_timeline 的 readWindows 找活跃日、或直接读最近的日期。',
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
      // 读取窗口触顶且最旧一条仍晚于目标日 → 目标日可能落在未扫到的更早区间，coverage 要如实点明。
      const oldestSec = rows.length ? Number(rows[rows.length - 1]!.sendTime) : Number.MAX_SAFE_INTEGER;
      const mayMissEarlier = rows.length >= READ && oldestSec >= endSec;

      const selfUin = (await svc.profile.getSelfProfile())?.uin ?? -1n;
      const otherUids = [...new Set(day.filter((r) => r.senderUin !== selfUin).map((r) => r.senderUid))];
      const nameByUid = otherUids.length ? await svc.profile.nicksByUids(otherUids) : {};

      // day 为最新在前；取当天最近 limit 条后翻成旧→新方便顺读。
      const slice = day.slice(0, limit).reverse();
      const messages: AiMsgLine[] = slice.map((r, i) => {
        const line: AiMsgLine = {
          time: hhmm(r.sendTime),
          sender: r.senderUin === selfUin ? '我' : nameByUid[r.senderUid] || String(r.senderUin),
          mine: r.senderUin === selfUin,
          text: flattenElements(r.elements),
        };
        if (i > 0) {
          const gapSec = Number(r.sendTime) - Number(slice[i - 1]!.sendTime);
          if (gapSec >= 1800) line.gap = humanDuration(gapSec);
        }
        return line;
      });

      return {
        date: label,
        kind,
        conv,
        count: messages.length,
        coverage: mayMissEarlier
          ? `${RANK_COVERAGE}（注意：只扫了该会话最近 ${READ} 条，这一天可能更早、未完全覆盖）`
          : RANK_COVERAGE,
        messages,
        ...(day.length > limit
          ? { hint: `当天共 ${day.length} 条，只返回最近 ${limit} 条；如需更早可缩小到更早的日期或提高 limit。` }
          : day.length === 0
            ? {
                hint: mayMissEarlier
                  ? '在最近的读取窗口里没扫到这一天（可能更久远）；用 inspect_timeline 找活跃日、或读更近的日期。'
                  : '这一天该会话没有消息记录。',
              }
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

