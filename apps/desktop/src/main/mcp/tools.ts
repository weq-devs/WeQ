/**
 * Transport-agnostic tool registry.
 *
 * One source of truth for the capabilities WeQ exposes to AI clients.
 * The MCP HTTP server (`./server.ts`) is its first consumer; a future in-app
 * assistant (Anthropic SDK tool runner) can reuse the very same `run` functions
 * — so the business logic lives here exactly once.
 *
 * Each tool's `run` resolves the *current* account's services via
 * `getAppContext().services`, so tools automatically follow account switches and
 * throw cleanly when no account is open. Results are converted to IPC-safe wire
 * shapes (bigint → string) with the same `serde` helpers the tRPC router uses.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { getAppContext, type AccountServices } from '../context/app_context';
import { classifyChatType, datalineName, isDatalineSelfUid, isDatalineUid } from '@weq/codec';
import type { DressMallItem, RenderElement } from '@weq/service';
import {
  computeBkn,
  DressAppId,
  fetchClientKey,
  fetchDownloadRkeys,
  fetchWebTokens,
  HonorType,
  normalizeMallItems,
} from '@weq/service';
import { searchCatalog } from '../market_catalog';
import { resolveResource } from '../resource';
import { decodeBlobHex, decodeBlobText } from './blob_decoder';
import { elementAiDetail, elementsToAiText, mediaForElements } from './msg_rich';
import {
  recentContactToWire,
  groupDetailToWire,
  groupMemberToWire,
  buddyToWire,
  userProfileToWire,
  groupEssenceToWire,
  groupBulletinToWire,
  forwardRecordToWire,
  collectionItemToWire,
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

// ── 在线能力（凭据 / OIDB 协议 / Web CGI）公共小工具 ─────────────────────────

/** 当前账号的 QQ 进程 pid；离线 / 完全离线模式时抛可读错误。 */
function onlinePid(): number {
  const ctx = getAppContext();
  const record = services().accountConfig.getRecord();
  if (!record?.qqOnline || !record.qqPid) {
    throw new Error('需要先登录该账号的 QQ 客户端（本工具要走在线实例）。');
  }
  if (ctx.bootstrap?.userConfig.getSettings().autoInjectQq === false) {
    throw new Error('已开启完全离线模式（自动注入 QQ 已关闭），本工具不可用。');
  }
  return record.qqPid;
}

/** 当前账号的 uin（字符串形式）。 */
function currentUin(): string {
  const uin = getAppContext().account?.context.uin;
  if (!uin) throw new Error('当前没有已登录的账号。');
  return String(uin);
}

/** 原生 ntHelper 绑定（未加载时抛错）。 */
function ntHelper() {
  const nt = getAppContext().platform?.native.ntHelper;
  if (!nt) throw new Error('原生组件未加载。');
  return nt;
}

/** 商城工具的统一结果信封。 */
function dressMallResult(
  kind: string,
  mode: string,
  items: DressMallItem[],
  total: number,
  note: string,
): unknown {
  return {
    ok: true,
    kind,
    mode,
    total,
    count: items.length,
    items: items.map((i) => ({
      itemId: i.itemId,
      name: i.name,
      kind,
      ...(i.labels.length ? { labels: i.labels } : {}),
      ...(i.price ? { price: i.price } : {}),
      ...(i.previewUrl ? { previewUrl: i.previewUrl } : {}),
      ...(i.mallName ? { mallName: i.mallName } : {}),
    })),
    note,
  };
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
  /** 稳定消息标识（仅 includeIds 时附上，供 get_message_details 回查）。 */
  msgId?: string;
  msgSeq?: string;
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
    if (!m)
      throw new Error(`无效日期：${date}（应为 YYYY-MM-DD，例如 2026-06-30；不传则默认今天）`);
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(d.getTime())) throw new Error(`无效日期：${date}`);
  } else {
    const now = new Date();
    d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  const startSec = Math.floor(d.getTime() / 1000);
  return {
    startSec,
    endSec: startSec + 86400,
    label: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
  };
}

/**
 * 解析一个「日期区间」为本地 [startSec, endSec) 半开窗口（秒）。start/end 均为
 * YYYY-MM-DD，end 含当天（内部 +1 天转半开）。给 compare_periods 的任意两段对比用。
 */
function rangeWindow(
  start: string,
  end: string,
): { startSec: number; endSec: number; label: string } {
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
      () =>
        settle(() =>
          reject(new Error('导出耗时过长已超时；如需带媒体或大批量，请在「导出中心」里操作。')),
        ),
      timeoutMs,
    );
    mgr.on('progress', onProgress);
    check(); // 可能在挂监听前就已完成
  });
}

/**
 * RenderElement[]（wire 形）→ 给 LLM 看的可读文本。复用导出管线的 element
 * 文案（回复引用、markdown 正文、灰条、卡片等都能读出内容），并补上语音转写。
 */
function flattenElements(elements: readonly unknown[]): string {
  return elementsToAiText(elements);
}

/**
 * 撤回/删除/数据线等“渲染行”投影成 AI 消息行的最小形状。
 * 结构兼容 {@link RenderC2cMsg} / {@link RenderGroupMsg}（字段更多没关系）。
 */
interface AiMsgRowLike {
  msgId?: bigint | number | string;
  msgSeq?: bigint | number | string;
  senderUid: string;
  /** 普通会话 senderUin 可用；数据线各设备共用同一个 uin，判 mine 走 senderUid。 */
  senderUin?: bigint | number | string;
  sendTime: bigint | number;
  elements?: readonly unknown[];
  deletedKind?: 'weq' | 'qq' | undefined;
  recall?: { revokeUid?: string; sameSender?: boolean; recallTs?: bigint | number } | undefined;
}

/** 「这条消息是不是我发的」——数据线按 PC=本机的伪 uid 约定，其余按 uin。 */
function rowIsMine(r: AiMsgRowLike, selfUin: bigint): boolean {
  if (isDatalineUid(r.senderUid)) return isDatalineSelfUid(r.senderUid);
  if (!r.senderUin) return false;
  const uin = typeof r.senderUin === 'bigint' ? r.senderUin : BigInt(r.senderUin);
  return selfUin > 0n && uin === selfUin;
}

/**
 * 旧→新一组渲染行 → 精简 AI 消息行。nameOf 只在 uid 不是数据线伪 uid、也不是
 * “我”时兜底（群成员/好友昵称由调用方批量解析好传进来）。
 */
function projectRows(
  rowsOldestFirst: readonly AiMsgRowLike[],
  selfUin: bigint,
  nameOf: (uid: string) => string | undefined,
): AiMsgLine[] {
  const lines: AiMsgLine[] = [];
  let prevSec: number | null = null;
  for (const r of rowsOldestFirst) {
    const sec = Number(r.sendTime);
    const mine = rowIsMine(r, selfUin);
    const fallback = String(r.senderUin ?? '') || r.senderUid || '未知';
    const sender = mine ? '我' : (datalineName(r.senderUid) ?? nameOf(r.senderUid) ?? fallback);
    const line: AiMsgLine = {
      time: fmtTime(sec),
      sender,
      mine,
      text: flattenElements(r.elements ?? []),
      ...(r.msgId !== undefined ? { msgId: String(r.msgId) } : {}),
      ...(r.msgSeq !== undefined ? { msgSeq: String(r.msgSeq) } : {}),
    };
    if (prevSec !== null) {
      const gapSec = sec - prevSec;
      if (gapSec >= 1800) line.gap = humanDuration(gapSec);
    }
    prevSec = sec;
    lines.push(line);
  }
  return lines;
}

/** 批量解析发送者昵称（自己除外），供撤回/删除等历史行投影用。 */
async function namesForRows(
  svc: AccountServices,
  rows: readonly AiMsgRowLike[],
  selfUin: bigint,
): Promise<(uid: string) => string | undefined> {
  const otherUids = [
    ...new Set(rows.filter((r) => !rowIsMine(r, selfUin)).map((r) => r.senderUid)),
  ];
  if (otherUids.length === 0) return () => undefined;
  const nameByUid = await svc.profile.nicksByUids(otherUids);
  return (uid) => nameByUid[uid];
}

/** Resolve an account DB file by name (same lookup execute_sql uses). */
async function accountDbFile(dbName: string): Promise<{
  name: string;
  path: string;
  bytes: number;
  kind: string;
} | null> {
  const svc = services();
  const dbs = await svc.dbExplorer.listDatabases();
  const db = dbs.find((d) => d.name.toLowerCase() === dbName.toLowerCase());
  return db ? { name: db.name, path: db.path, bytes: db.bytes, kind: db.kind } : null;
}

/** epoch 毫秒 → YYYY-MM-DD（收藏时间展示用）。 */
function fmtMsDate(ms: bigint | number): string {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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
            : [
                ...(await search.searchBuddy(keyword, probe)),
                ...(await search.searchGroup(keyword, probe)),
              ].sort((a, b) => Number(b.sendTime - a.sendTime));
      const hasMore = raw.length > limit;
      const hits = raw.slice(0, limit);

      const selfUid = (await svc.profile.getSelfProfile())?.uid ?? '';
      const otherUids = [
        ...new Set(hits.filter((h) => h.senderUid !== selfUid).map((h) => h.senderUid)),
      ];
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
          ? {
              hint: `没搜到含「${keyword}」的消息；换更短/近义的关键词再试，或改用 get_messages 直接读会话判断。零命中不代表内容不存在。`,
            }
          : hasMore
            ? {
                hint: `命中较多，只返回按时间最新的 ${limit} 条；调大 limit 或换更具体的关键词收窄。`,
              }
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
      const otherUids = [
        ...new Set(hits.filter((h) => h.senderUid !== selfUid).map((h) => h.senderUid)),
      ];
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
          ? {
              hint: `该会话里没搜到含「${keyword}」的消息；换更短/近义关键词，或用 get_messages 顺读判断。零命中不代表没说过。`,
            }
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
            : [
                ...(await svc.msgSearch.searchBuddy(keyword, POOL)),
                ...(await svc.msgSearch.searchGroup(keyword, POOL)),
              ];

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
          byUid.set(h.senderUid, {
            uid: h.senderUid,
            hits: 1,
            lastSec: sec,
            sample: h.content,
            scopes: new Set([kindScope]),
          });
        } else {
          cur.hits += 1;
          cur.scopes.add(kindScope);
          if (sec > cur.lastSec) {
            cur.lastSec = sec;
            cur.sample = h.content; // 样例取最近一条，最贴合「最近谁提过」
          }
        }
      }

      const ranked = [...byUid.values()]
        .sort((a, b) => b.hits - a.hits || b.lastSec - a.lastSec)
        .slice(0, limit);
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
    description:
      '列出最近会话（私聊与群聊），最新在前。用来给后续工具挑选目标会话——从返回的 conv/kind 接 get_messages / get_messages_by_date 读原文，或先看「最近在跟谁来往」。想按活跃量排行别用它（那用 rank_friends_by_activity / get_period_overview）。',
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
      '想要拿到某条消息的 msgId/msgSeq 以便回查详情或媒体，把 includeIds 设为 true。' +
      '\n【翻页】返回带 hasMore / nextBefore：还想往更早读，就把 nextBefore 原样传回 before 参数取上一页；' +
      '一次别把 limit 开太大，顺着翻更省 token 也更聚焦。',
    input: z.object({
      kind: z.enum(['c2c', 'group']).describe('会话类型'),
      conv: z.string().min(1).describe('私聊为对方 uid，群聊为群号'),
      limit: z.number().int().min(1).max(100).default(30).describe('返回条数上限'),
      before: z
        .string()
        .default('')
        .describe('翻页游标：上一次返回的 nextBefore（读更早的一页）；不传=最新一页'),
      includeIds: z
        .boolean()
        .default(false)
        .describe(
          '是否在每条消息上附带 msgId/msgSeq（供 get_message_details 回查；默认 false 更省 token）',
        ),
    }),
    run: async ({ kind, conv, limit, before, includeIds }) => {
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
      const otherUids = [
        ...new Set(page.filter((r) => r.senderUin !== selfUin).map((r) => r.senderUid)),
      ];
      const nameByUid = otherUids.length ? await svc.profile.nicksByUids(otherUids) : {};

      const ordered = [...page].reverse(); // 翻成旧→新方便顺读
      const messages: AiMsgLine[] = ordered.map((r, i) => {
        const line: AiMsgLine = {
          time: fmtTime(r.sendTime),
          sender: r.senderUin === selfUin ? '我' : nameByUid[r.senderUid] || String(r.senderUin),
          mine: r.senderUin === selfUin,
          text: flattenElements(r.elements),
          ...(includeIds ? { msgId: String(r.msgId), msgSeq: String(r.msgSeq) } : {}),
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
          ? {
              hint:
                beforeSeq != null
                  ? '没有更早的消息了。'
                  : '该会话本地没有消息记录（确认 conv 是否正确、或消息尚未同步）。',
            }
          : hasMore
            ? { hint: `还有更早的消息；把 nextBefore 传回 before 可继续往前读。` }
            : {}),
      };
    },
  }),

  tool({
    name: 'list_groups',
    description:
      '列出当前账号加入的群聊（群号、群名等）。用来枚举/挑群，或把群名对上群号（只找某一个群更快的是 find_contact / search_groups）。拿到群号后接 get_messages / get_group_activity / list_group_members 等。',
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
    description:
      '列出当前账号的 QQ 好友（uid、uin、昵称、备注等）。用来枚举好友或把昵称对上 uid（只找某一个人更快的是 find_contact / search_buddies）。拿到 uid 后接 get_messages / inspect_timeline / get_user_profile 等。想要「和谁聊得最多」的排行用 rank_friends_by_activity，别自己遍历。',
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
      query: z
        .string()
        .default('')
        .describe('搜索关键词（昵称/备注，不区分大小写，空字符串=全部）'),
      limit: z.number().int().min(1).max(200).default(50).describe('返回条数上限'),
    }),
    run: async ({ query, limit }) => {
      const svc = services();
      const buddies = await svc.profile.listBuddies(500, 0);
      const profiles = await svc.profile.profilesByUids(buddies.map((b) => b.uid));
      const q = query.toLowerCase();
      const matched = profiles.filter(
        (p) => !q || p.nick?.toLowerCase().includes(q) || p.remark?.toLowerCase().includes(q),
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
      const matched = all.filter((g) => !q || g.groupName?.toLowerCase().includes(q));
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
          return {
            groupCode: w.groupCode,
            groupName: w.groupName,
            remark: w.remark,
            memberCount: w.memberCount,
          };
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
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(30)
        .describe('返回条数上限（取亲密度最高的若干位）'),
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
        ...(w.birthYear
          ? { birthday: `${w.birthYear}-${pad2(w.birthMonth)}-${pad2(w.birthDay)}` }
          : {}),
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
        return {
          groupCode,
          found: false,
          hint: '找不到该群资料；确认群号是否正确（可用 find_contact 解析群名）。',
        };
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
        emojisSelf: analytics.emojisSelf.map((e) => ({
          faceId: e.faceId,
          faceText: e.faceText,
          count: e.count,
        })),
        emojisPeer: analytics.emojisPeer.map((e) => ({
          faceId: e.faceId,
          faceText: e.faceText,
          count: e.count,
        })),
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
        if (gap > longestSilence.days)
          longestSilence = { days: gap, from: daily[i - 1]!.date, to: daily[i]!.date };
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
      for (const d of daily)
        byMonth.set(d.date.slice(0, 7), (byMonth.get(d.date.slice(0, 7)) ?? 0) + d.count);
      const monthly = [...byMonth.entries()].map(([month, count]) => ({ month, count }));

      // 建议阅读窗口：消息量最高的前 3 天（最值得回看原话的高峰）。
      const readWindows = [...daily]
        .sort((x, y) => y.count - x.count)
        .slice(0, 3)
        .map((d) => ({ date: d.date, count: d.count }));

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
        topSenders: ranking.map((r) => ({
          name: r.displayName,
          uid: r.uid,
          count: r.messageCount,
        })),
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
        .filter(
          (t): t is { c: typeof t.c; wire: typeof t.wire; kind: 'c2c' | 'group' } =>
            t.kind !== null,
        );
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
          const day = rows.filter(
            (r) => Number(r.sendTime) >= startSec && Number(r.sendTime) < endSec,
          );
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
              hourly[new Date(sec * 1000).getHours()] =
                (hourly[new Date(sec * 1000).getHours()] ?? 0) + 1;
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

      const delta = (
        cur: number,
        prev: number,
      ): { value: number; delta: number; deltaPct: number | null } => ({
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
        .object({
          start: z.string().describe('起 YYYY-MM-DD'),
          end: z.string().describe('止 YYYY-MM-DD（含当天）'),
        })
        .describe('第一个日期段'),
      periodB: z
        .object({
          start: z.string().describe('起 YYYY-MM-DD'),
          end: z.string().describe('止 YYYY-MM-DD（含当天）'),
        })
        .describe('第二个日期段'),
      kind: z.enum(['c2c', 'group']).optional().describe('只比单个会话时传：c2c=私聊 / group=群聊'),
      conv: z.string().optional().describe('只比单个会话时传：私聊对方 uid 或群号（配合 kind）'),
    }),
    run: async ({ periodA, periodB, kind, conv }) => {
      const svc = services();
      const winA = rangeWindow(periodA.start, periodA.end);
      const winB = rangeWindow(periodB.start, periodB.end);
      const selfUid = svc.msgs.selfUid();

      const diff = (
        a: number,
        b: number,
      ): { a: number; b: number; delta: number; deltaPct: number | null } => ({
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
          selfUid
            ? svc.msgs.countConv(kind, conv, { ...w(winA), senderUid: selfUid })
            : Promise.resolve(0),
          svc.msgs.countConv(kind, conv, w(winB)),
          selfUid
            ? svc.msgs.countConv(kind, conv, { ...w(winB), senderUid: selfUid })
            : Promise.resolve(0),
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
      const win = (r: { startSec: number; endSec: number }) => ({
        startTime: r.startSec,
        endTime: r.endSec - 1,
      });
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
      '需要 msgId/msgSeq 供 get_message_details 回查时把 includeIds 设为 true。' +
      '\n【局限】只在该会话最近若干条里筛当天；查很久以前的某天可能扫不到（返回 coverage 会点明），那种情况改用 inspect_timeline 的 readWindows 找活跃日、或直接读最近的日期。',
    input: z.object({
      kind: z.enum(['c2c', 'group']).describe('会话类型'),
      conv: z.string().min(1).describe('私聊为对方 uid，群聊为群号'),
      date: z.string().default('').describe('某天 YYYY-MM-DD；空=今天'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(300)
        .default(120)
        .describe('返回条数上限（取当天最近的若干条）'),
      includeIds: z
        .boolean()
        .default(false)
        .describe('是否附带 msgId/msgSeq（供 get_message_details 回查；默认 false）'),
    }),
    run: async ({ kind, conv, date, limit, includeIds }) => {
      const svc = services();
      const { startSec, endSec, label } = dayWindow(date);
      const READ = kind === 'group' ? 1000 : 600;
      const rows =
        kind === 'group'
          ? await svc.msgs.getGroupLatest(conv, READ)
          : await svc.msgs.getC2cLatest(conv, READ);
      const day = rows.filter((r) => Number(r.sendTime) >= startSec && Number(r.sendTime) < endSec);
      // 读取窗口触顶且最旧一条仍晚于目标日 → 目标日可能落在未扫到的更早区间，coverage 要如实点明。
      const oldestSec = rows.length
        ? Number(rows[rows.length - 1]!.sendTime)
        : Number.MAX_SAFE_INTEGER;
      const mayMissEarlier = rows.length >= READ && oldestSec >= endSec;

      const selfUin = (await svc.profile.getSelfProfile())?.uin ?? -1n;
      const otherUids = [
        ...new Set(day.filter((r) => r.senderUin !== selfUin).map((r) => r.senderUid)),
      ];
      const nameByUid = otherUids.length ? await svc.profile.nicksByUids(otherUids) : {};

      // day 为最新在前；取当天最近 limit 条后翻成旧→新方便顺读。
      const slice = day.slice(0, limit).reverse();
      const messages: AiMsgLine[] = slice.map((r, i) => {
        const line: AiMsgLine = {
          time: hhmm(r.sendTime),
          sender: r.senderUin === selfUin ? '我' : nameByUid[r.senderUid] || String(r.senderUin),
          mine: r.senderUin === selfUin,
          text: flattenElements(r.elements),
          ...(includeIds ? { msgId: String(r.msgId), msgSeq: String(r.msgSeq) } : {}),
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
          ? {
              hint: `当天共 ${day.length} 条，只返回最近 ${limit} 条；如需更早可缩小到更早的日期或提高 limit。`,
            }
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
      format: z
        .enum(['html', 'txt', 'json', 'jsonl', 'csv', 'xlsx'])
        .default('html')
        .describe('导出格式，默认 html'),
      name: z.string().default('').describe('文件名（建议传联系人/群名，便于识别）'),
      days: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .default(0)
        .describe('只导出最近 N 天；0/不传=全部时间'),
    }),
    run: async ({ kind, conv, format, name, days }) => {
      const svc = services();
      const stem = (name || '').trim() || `导出-${conv}`;
      const total = await svc.msgs.countConv(kind, conv);
      const range =
        days > 0 ? { start: Math.floor(Date.now() / 1000) - days * 86400, end: null } : undefined;

      const taskId = await svc.exportManager.startTask({
        kind,
        conv,
        name: stem,
        format,
        total,
        range,
      });
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

  tool({
    name: 'get_anti_recall_status',
    description:
      '查询当前账号的防撤回状态：是否开启、保护范围（selected=指定会话 / all=全部会话）、' +
      '已配置的保护目标数量、数据库里实际安装的触发器、以及 QQ 是否在运行。' +
      '只读本地查询，不发网络请求。回答「防撤回开没开」「保护了哪些会话」「现在装的触发器有哪些」。',
    input: z.object({}),
    run: async () => {
      const svc = services();
      const status = await svc.antiRecall.getStatus();
      const targets = status.targets.map((t) => ({
        kind: t.kind,
        id: t.id,
        ...(t.kind === 'dataline' ? { name: datalineName(t.id) ?? t.id } : {}),
      }));
      const triggerNames = status.installed.map((i) => i.name);
      return {
        enabled: status.enabled,
        mode: status.mode,
        modeLabel: status.mode === 'all' ? '全部会话' : '仅指定会话',
        protectedTargets: targets,
        installedTriggers: triggerNames,
        qqRunning: status.qqRunning,
        hint: status.enabled
          ? `防撤回已开启（${status.mode === 'all' ? '保护全部会话' : `保护 ${status.targets.length} 个指定会话`}）；` +
            (status.qqRunning
              ? 'QQ 正在运行，最近一次开关/改目标可能要重启 QQ 后才真正生效。'
              : '触发器已按当前配置安装。') +
            '若从未有人撤回，撤回列表为空属正常。' +
            (status.targets.length > 0
              ? 'protectedTargets 里的 id 是内部会话标识，给用户展示前请用 find_contact 解析成名字。'
              : '')
          : '防撤回未开启，因此也没有拦截撤回的日志记录。',
      };
    },
  }),

  tool({
    name: 'set_anti_recall',
    assistantOnly: true, // 写数据库触发器 + 配置文件 → 只给内置助手，不进只读 MCP server
    description:
      '开启/取消防撤回。enabled=false 会卸载全部防撤回触发器；enabled=true 会按当前配置（或本次传入的 mode/targets）重建。' +
      'mode: selected=只保护 targets 里的会话，all=保护所有会话（无需列 targets）。targets 是会话清单：' +
      'kind=c2c 传对方 uid、kind=group 传群号、kind=dataline 传设备 uid（一般不需要手动加）。' +
      '返回最新状态与 QQ 是否在运行——QQ 开着时触发器可能要到重启 QQ 才真正生效。',
    input: z.object({
      enabled: z.boolean().describe('true=开启防撤回，false=关闭'),
      mode: z.enum(['selected', 'all']).optional().describe('保护范围：仅指定会话 / 全部会话'),
      targets: z
        .array(
          z.object({
            kind: z.enum(['c2c', 'group', 'dataline']).describe('会话类型'),
            id: z.string().min(1).describe('私聊/数据线为 uid，群聊为群号'),
          }),
        )
        .optional()
        .describe('要保护的会话清单（仅 mode=selected 时有意义）'),
    }),
    run: async ({ enabled, mode, targets }) => {
      const ctx = getAppContext();
      if (enabled && ctx.accountIsStatic && !ctx.accountIsAndroidBackup) {
        throw new Error('静态账号的数据库是离线快照，QQ 不会写入，防撤回无法生效。');
      }
      const svc = services().antiRecall;
      // 顺序固定：先改清单/范围再翻总开关，确保 applyTriggers 一次对齐终态。
      if (targets) await svc.setTargets(targets);
      if (mode) await svc.setMode(mode);
      await svc.setEnabled(enabled);
      const status = await svc.getStatus();
      return {
        ok: true,
        enabled: status.enabled,
        mode: status.mode,
        protectedTargets: status.targets,
        installedTriggers: status.installed.map((i) => i.name),
        qqRunning: status.qqRunning,
        hint: status.qqRunning
          ? 'QQ 正在运行，触发器的变化可能要到 QQ 重启后才真正生效。'
          : status.enabled
            ? '防撤回已开启，之后撤回的消息会被拦截并记录到本地日志。'
            : '防撤回已关闭，QQ 的撤回将正常执行。',
      };
    },
  }),

  tool({
    name: 'list_recalled_messages',
    description:
      '列出某个会话里最近被撤回过的消息（需曾开启防撤回且拦截成功才有记录；整页消息按原时间由旧到新顺读，覆盖最新的一批撤回）。' +
      'kind: c2c=私聊（conv 传对方 uid），group=群聊（conv 传群号）。' +
      '返回每条：msgId/msgSeq、time 发送时间、sender 发送者昵称、mine 是否本人发送、text 原文，以及 recall（byUid 撤回者、bySender 是否本人自撤、time 撤回时间）。' +
      '用来回答「TA 撤回了什么」「这个群里最近谁撤回过消息」。只读本地，不发网络。',
    input: z.object({
      kind: z.enum(['c2c', 'group']).describe('会话类型'),
      conv: z.string().min(1).describe('私聊为对方 uid，群聊为群号'),
      limit: z.number().int().min(1).max(100).default(30).describe('返回条数上限'),
    }),
    run: async ({ kind, conv, limit }) => {
      const svc = services();
      const rows = (await svc.msgs.getRecalledMessages(kind, conv)) as AiMsgRowLike[];
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const selfUin = (await svc.profile.getSelfProfile())?.uin ?? -1n;
      const nameOf = await namesForRows(svc, page, selfUin);
      const ordered = [...page].reverse(); // 旧→新给聊天式的顺读体验
      const lines = projectRows(ordered, selfUin, nameOf);
      const items = lines.map((line, i) => {
        const rec = ordered[i]?.recall;
        if (!rec) return line;
        return {
          ...line,
          recall: {
            ...(rec.revokeUid ? { byUid: rec.revokeUid } : {}),
            bySender: rec.sameSender === true,
            time: fmtTime(Number(rec.recallTs ?? 0)),
          },
        };
      });
      return {
        kind,
        conv,
        count: items.length,
        hasMore,
        messages: items,
        ...(items.length === 0
          ? {
              hint: '该会话没有撤回记录：可能是防撤回从未开启/从未拦截到撤回，或该会话没在保护范围内（可用 get_anti_recall_status 查）。',
            }
          : hasMore
            ? { hint: `记录较多，只返回最近 ${limit} 条；调大 limit 可看更多。` }
            : {}),
      };
    },
  }),

  tool({
    name: 'list_deleted_messages',
    description:
      '列出某个会话里“已删除”的消息（本地行被改成删除签名；整页按原发送时间由旧到新顺读，覆盖最新的一批删除）。' +
      'kind: c2c=私聊（conv 传对方 uid），group=群聊（conv 传群号）。' +
      '每条：msgId/msgSeq、time 发送时间、sender 发送者、mine、text 原文，deletedKind 标记删除来源：' +
      'weq=WeQ 本地删除（应用内可恢复）、qq=QQ 侧原生删除（不可恢复）。' +
      '用来回答「这个会话哪些消息被删了」「删掉的内容是什么」。只读本地，不发网络。',
    input: z.object({
      kind: z.enum(['c2c', 'group']).describe('会话类型'),
      conv: z.string().min(1).describe('私聊为对方 uid，群聊为群号'),
      limit: z.number().int().min(1).max(100).default(30).describe('返回条数上限'),
    }),
    run: async ({ kind, conv, limit }) => {
      const svc = services();
      const rows = (await svc.msgs.getDeletedMessages(kind, conv)) as AiMsgRowLike[];
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const selfUin = (await svc.profile.getSelfProfile())?.uin ?? -1n;
      const nameOf = await namesForRows(svc, page, selfUin);
      const ordered = [...page].reverse();
      const lines = projectRows(ordered, selfUin, nameOf);
      const items = lines.map((line, i) => {
        const deletedKind = ordered[i]?.deletedKind;
        return {
          ...line,
          ...(deletedKind ? { deletedKind } : {}),
        };
      });
      return {
        kind,
        conv,
        count: items.length,
        hasMore,
        deletedCount: rows.length,
        messages: items,
        ...(items.length === 0
          ? { hint: '该会话没有已删除（(1,1) 删除签名）的消息记录。' }
          : hasMore
            ? { hint: `记录较多，只返回最近 ${limit} 条；调大 limit 可看更多。` }
            : {}),
      };
    },
  }),

  tool({
    name: 'get_forward_messages',
    description:
      '展开一条「合并转发 / 聊天记录」消息的内容。先拿承载消息的 msgId——get_messages 开 includeIds 会返回，' +
      '或 execute_sql 在对应会话表查 40001——再传 kind（c2c=私聊/group=群聊）+ msgId 到这里。' +
      '本工具只读本机 40900 缓存，绝不联网拉取；本地没有缓存时返回 found=false（并提示没有走网络回退）。' +
      '返回 messages：time、sender、mine、text，嵌套的转发会按 depth 展开（受 maxDepth 限制），并附 hasMore/truncated。' +
      '媒体只保留占位（[图片]/[语音]/[文件]），不返回媒体本体。',
    input: z.object({
      kind: z.enum(['c2c', 'group']).describe('承载消息所在会话类型'),
      msgId: z.string().min(1).describe('承载「合并转发」的那条消息 msgId（数据库 40001）'),
      maxDepth: z
        .number()
        .int()
        .min(0)
        .max(4)
        .default(2)
        .describe('嵌套转发最多展开层数（0=只展开一层）'),
      limit: z.number().int().min(1).max(300).default(100).describe('返回子消息条数上限'),
    }),
    run: async ({ kind, msgId, maxDepth, limit }) => {
      const svc = services();
      const id = safeBigint(msgId);
      if (id === null) throw new Error(`msgId 无效：${msgId}（应为数字字符串）`);
      const records =
        kind === 'group'
          ? await svc.forwardMsgs.getGroupForward(id)
          : await svc.forwardMsgs.getC2cForward(id);
      if (records.length === 0) {
        return {
          found: false,
          kind,
          msgId,
          hint: '本地 40900 缓存里没有这条合并转发的内容（可能消息已清理/从未缓存）。本工具不联网补拉；如需在线拉取请在应用内使用。',
        };
      }

      interface ForwardNode {
        msgId?: string | number | bigint;
        sendNick?: unknown;
        senderUin?: string | number | bigint;
        senderUid?: string;
        isSender?: boolean;
        sendTime?: string | number | bigint;
        elements?: readonly unknown[];
        subMsgs?: ForwardNode[];
      }
      const roots = records.map((r) => forwardRecordToWire(r) as ForwardNode);
      const items: Array<{
        depth: number;
        time: string;
        sender: string;
        mine: boolean;
        text: string;
      }> = [];
      let truncated = false;
      const walk = (node: ForwardNode, depth: number): void => {
        if (items.length >= limit) {
          truncated = true;
          return;
        }
        if (depth > maxDepth) return;
        const uin = node.senderUin !== undefined ? String(node.senderUin) : '';
        const sender = String(node.sendNick ?? '') || uin || node.senderUid || '未知';
        items.push({
          depth,
          time: node.sendTime !== undefined ? fmtTime(Number(node.sendTime)) : '',
          sender,
          mine: node.isSender === true,
          text: flattenElements(node.elements ?? []),
        });
        for (const sub of node.subMsgs ?? []) walk(sub, depth + 1);
      };
      for (const root of roots) walk(root, 0);
      return {
        found: true,
        kind,
        msgId,
        count: items.length,
        truncated,
        hasMore: truncated,
        messages: items,
        hint:
          items.length === 0
            ? '缓存记录存在但没有可投影的文字内容（可能全是媒体/灰条）。'
            : truncated
              ? `转发内容较长，已截断为 ${limit} 条；如需更深层可调 maxDepth。`
              : '',
      };
    },
  }),

  tool({
    name: 'get_message_details',
    description:
      '取回【某一条消息】的完整结构化详情：逐条 element 的可读文案（回复引用、markdown 正文、' +
      '灰条/卡片等不再只是占位）、可选 payload 字段，以及本地媒体信息（图片/语音/视频/文件是否已在磁盘、' +
      '语音转写文本等）。' +
      '\n【怎么定位消息】msgId 来自 get_messages / get_messages_by_date 的 includeIds=true 输出，' +
      '或 list_recalled_messages / list_deleted_messages 返回的 msgId；也可以像 get_forward_messages 一样先 execute_sql 查 40001。' +
      'kind: c2c=私聊（数据线设备 uid 也按 c2c 传），group=群聊；conv 与读该消息的会话一致。' +
      '只读本地，不发网络；找不到时返回 found=false（msgId 可能不在该会话）。',
    input: z.object({
      kind: z.enum(['c2c', 'group']).describe('会话类型（数据线设备 uid 也按 c2c）'),
      conv: z.string().min(1).describe('私聊为对方 uid，群聊为群号'),
      msgId: z.string().min(1).describe('目标消息 msgId（40001，数字字符串）'),
      includePayload: z
        .boolean()
        .default(true)
        .describe('是否附带部分原始 payload（ark/markdown/灰条 XML/tipJson 等较长内容）'),
      includeMedia: z
        .boolean()
        .default(true)
        .describe('是否在本机媒体缓存里定位图片/语音/视频/文件的本地路径（不发网络）'),
    }),
    run: async ({ kind, conv, msgId, includePayload, includeMedia }) => {
      const svc = services();
      const id = safeBigint(msgId);
      if (id === null) throw new Error(`msgId 无效：${msgId}（应为数字字符串）`);
      const row =
        kind === 'group'
          ? await svc.msgs.getGroupMessageById(conv, id)
          : await svc.msgs.getC2cMessageById(conv, id);
      if (!row) {
        return {
          found: false,
          kind,
          conv,
          msgId,
          hint: '本地消息表里没有这条消息（msgId 不在该会话/库中，或消息已被彻底清理）。',
        };
      }

      const self = await svc.profile.getSelfProfile();
      const selfUin = self?.uin ?? -1n;
      const mine = row.senderUin === selfUin;
      const otherUids = mine ? [] : [row.senderUid];
      const nameByUid = otherUids.length ? await svc.profile.nicksByUids(otherUids) : {};
      const sender = mine
        ? '我'
        : (datalineName(row.senderUid) ?? nameByUid[row.senderUid] ?? String(row.senderUin));

      const details = row.elements.map((el, i) => elementAiDetail(el, i, includePayload));
      const media = includeMedia
        ? await mediaForElements(svc.fileSearch, Number(row.sendTime), row.elements)
        : [];

      const out: Record<string, unknown> = {
        found: true,
        kind,
        conv,
        msgId: String(row.msgId),
        msgSeq: String(row.msgSeq),
        time: fmtTime(row.sendTime),
        sender,
        mine,
        senderUid: row.senderUid,
        text: flattenElements(row.elements),
        elementCount: row.elements.length,
        elements: details,
        media,
      };
      if (row.deletedKind) out.deletedKind = row.deletedKind;
      if (row.recall) {
        out.recall = {
          byUid: row.recall.revokeUid,
          bySender: row.recall.sameSender,
          time: fmtTime(row.recall.recallTs),
        };
      }
      if ('setEmojiList' in row && Array.isArray(row.setEmojiList) && row.setEmojiList.length) {
        out.reactions = row.setEmojiList.map((e) => ({
          emojiId: e.emojiId,
          count: e.setNum,
          mine: e.isSelfSet,
        }));
      }
      return out;
    },
  }),

  tool({
    name: 'transcribe_voice_message',
    description:
      '把某条消息里的本地语音（ptt）交给 WeQ 已下载的语音转写模型即时转成文字。' +
      '只读本机已缓存的语音文件、不联网拉取，结果**不会写回数据库**（要写回 QQ 供导出复用属于改库副作用，不在本工具范围）。' +
      '如果该语音之前已经转写（get_message_details 的 media[].transcript 非空），直接读即可，无需再调本工具。' +
      '定位消息用 msgId：get_messages 开 includeIds 或 list_recalled_messages 会返回。' +
      '当消息里有多个语音时可传 fileName 指定；不传则尝试全部。模型未下载/未配置时返回明确错误。',
    input: z.object({
      kind: z.enum(['c2c', 'group']).describe('会话类型（数据线设备 uid 也按 c2c）'),
      conv: z.string().min(1).describe('私聊为对方 uid，群聊为群号'),
      msgId: z.string().min(1).describe('目标消息 msgId（40001，数字字符串）'),
      fileName: z
        .string()
        .optional()
        .describe('可选：只转写该文件名的 ptt（同一消息带多个语音时用）'),
    }),
    run: async ({ kind, conv, msgId, fileName }) => {
      const ctx = getAppContext();
      const id = safeBigint(msgId);
      if (id === null) throw new Error(`msgId 无效：${msgId}（应为数字字符串）`);
      const row =
        kind === 'group'
          ? await services().msgs.getGroupMessageById(conv, id)
          : await services().msgs.getC2cMessageById(conv, id);
      if (!row) {
        return {
          found: false,
          kind,
          conv,
          msgId,
          hint: '本地消息表里没有这条消息（msgId 不在该会话/库中）。',
        };
      }

      const ptts = row.elements.filter((el): el is Extract<RenderElement, { type: 'ptt' }> => {
        if (el.type !== 'ptt') return false;
        if (fileName) return String(el.data.fileName ?? '') === fileName;
        return true;
      });
      if (ptts.length === 0) {
        return {
          ok: false,
          found: true,
          kind,
          conv,
          msgId,
          error: '这条消息里没有匹配的语音元素。',
        };
      }

      const results: Array<Record<string, unknown>> = [];
      for (const ptt of ptts) {
        const name = String(ptt.data.fileName ?? '');
        const entry: Record<string, unknown> = {
          fileName: name || undefined,
          durationSec: Number(ptt.data.pttDuration ?? 0) || undefined,
        };
        const hit = name
          ? await services().fileSearch.findFile(Number(row.sendTime), name, 'ptt')
          : { source: null, thumb: null };
        if (!hit.source) {
          entry.ok = false;
          entry.error = '本机没有该语音的缓存文件（可能是旧消息被清理，或从未下载到本地）。';
          results.push(entry);
          continue;
        }
        entry.localPath = hit.source;
        const res = await ctx.transcribeSilk(hit.source);
        if (res.ok && res.text) {
          entry.ok = true;
          entry.transcript = res.text;
        } else {
          entry.ok = false;
          entry.error = res.error ?? '语音转写失败';
          entry.hint =
            '模型未下载/未配置时请先在 WeQ「设置 → 语音转录」选择并下载模型；结果不会写回数据库。';
        }
        results.push(entry);
      }

      const allOk = results.every((r) => r.ok === true);
      return {
        ok: allOk,
        found: true,
        kind,
        conv,
        msgId,
        count: results.length,
        results,
        hint: allOk
          ? '转写结果仅本工具返回；如需把文字写回语音消息（QQ 也会显示），请在内置助手里使用带写库能力的入口。'
          : '部分语音转写失败，多为模型未就绪或本地音频缺失。',
      };
    },
  }),

  tool({
    name: 'list_dataline_conversations',
    description:
      '列出「数据线」会话——QQ 跨设备同步的“我的手机 / 我的电脑 / 我的平板”聊天（数据存在 dataline_msg_table）。' +
      '返回：conv（设备伪 uid，读消息时传给 get_dataline_messages）、device 设备名、lastTime、lastSeq。' +
      '只读本地 recent_contact 列表，不发网络。回答「我和手机/电脑之间传过什么」这类问题时先调它拿 conv。',
    input: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(30)
        .describe('从最近会话里最多找多少个数据线会话'),
    }),
    run: async ({ limit }) => {
      const svc = services();
      const contacts = await svc.recentContacts.getRecentContact(limit * 5);
      const sessions = contacts.filter((c) => classifyChatType(c.chatType) === 'dataline');
      return {
        count: sessions.length,
        source: 'local-recent-contact',
        sessions: sessions.map((c) => ({
          conv: c.targetUid,
          device: datalineName(c.targetUid) ?? '未知设备',
          chatType: String(c.chatType),
          lastSeq: c.msgSeq.toString(),
          lastTime: fmtTime(c.sendTime),
        })),
        hint:
          sessions.length === 0
            ? '最近会话列表里没有数据线会话（从未用过跨设备同步，或太久没动没出现在最近列表）。'
            : '会话列表按最后消息时间排序；想看具体内容用 get_dataline_messages。',
      };
    },
  }),

  tool({
    name: 'get_dataline_messages',
    description:
      '读取某个数据线会话（我的手机/我的电脑/我的平板）的消息，按时间正序返回。' +
      'conv 来自 list_dataline_conversations（设备伪 uid）。与普通私聊不同：本工具按设备判定方向——' +
      'PC 伪 uid 算“我”，手机/平板算对端，昵称直接给“我的手机”等。' +
      '返回同 get_messages 的精简行（time/sender/mine/text/gap）并带 hasMore/nextBefore 翻页。' +
      '只读本地 dataline_msg_table，不发网络。',
    input: z.object({
      conv: z.string().min(1).describe('数据线设备伪 uid（用 list_dataline_conversations 获得）'),
      limit: z.number().int().min(1).max(100).default(30).describe('返回条数上限'),
      before: z.string().default('').describe('翻页游标：上一次返回的 nextBefore；不传=最新一页'),
    }),
    run: async ({ conv, limit, before }) => {
      if (!isDatalineUid(conv)) {
        throw new Error(
          `「${conv}」不是数据线设备 uid；请先调 list_dataline_conversations 拿 conv。`,
        );
      }
      const svc = services();
      const selfUin = (await svc.profile.getSelfProfile())?.uin ?? -1n;
      const beforeSeq = before.trim() ? safeBigint(before) : null;
      const probe = limit + 1;
      const rows = beforeSeq
        ? await svc.msgs.getC2cBefore(conv, beforeSeq, probe)
        : await svc.msgs.getC2cLatest(conv, probe);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const nextBefore = hasMore && page.length ? String(page[page.length - 1]!.msgSeq) : '';
      const lines = projectRows([...page].reverse(), selfUin, () => undefined);
      return {
        conv,
        device: datalineName(conv) ?? conv,
        count: lines.length,
        hasMore,
        ...(nextBefore ? { nextBefore } : {}),
        coverage: '数据线消息来自本地 dataline_msg_table，仅覆盖已同步部分。',
        messages: lines,
        ...(lines.length === 0
          ? {
              hint: beforeSeq != null ? '没有更早的消息了。' : '该数据线会话本地没有消息记录。',
            }
          : {}),
      };
    },
  }),

  tool({
    name: 'list_guild_direct_sessions',
    description:
      '列出 QQ 频道「私聊」会话（频道里的单聊，不是频道群聊；数据来自 guild_msg.db 的 direct_node_list_table）。' +
      '返回：nodeId（读频道私聊消息的键）、peerName 对方昵称、guildName 所在频道、lastSeq/lastTime、messageCount。' +
      '只读本地，不发网络。回答「我跟谁有频道私聊」先调它。',
    input: z.object({}),
    run: async () => {
      const svc = services();
      const sessions = await svc.guildDirect.listSessions();
      return {
        count: sessions.length,
        source: 'local-guild_msg.db',
        sessions: sessions.map((s) => ({
          nodeId: s.nodeId,
          peerName: s.peerNick,
          guildName: s.guildName,
          lastSeq: s.lastSeq,
          lastTime: s.lastTime ? fmtTime(Number(s.lastTime)) : '',
          messageCount: s.messageCount,
        })),
        hint:
          sessions.length === 0
            ? '本机没有频道私聊会话（guild_msg.db 不存在或为空）。'
            : '想看某会话的消息，把 nodeId 传给 get_guild_direct_messages。',
      };
    },
  }),

  tool({
    name: 'get_guild_direct_messages',
    description:
      '读取某个频道私聊会话的消息，按时间正序返回。nodeId 来自 list_guild_direct_sessions。' +
      '返回精简行 time/sender/mine/text（sender=我 或 对方昵称），带 hasMore/nextBefore 往前翻更早的页。' +
      '只读本地 guild_msg_table，不发网络。',
    input: z.object({
      nodeId: z.string().min(1).describe('会话 node id（list_guild_direct_sessions 返回）'),
      limit: z.number().int().min(1).max(100).default(30).describe('返回条数上限'),
      before: z.string().default('').describe('翻页游标：上一次返回的 nextBefore；不传=最新一页'),
    }),
    run: async ({ nodeId, limit, before }) => {
      try {
        BigInt(String(nodeId).trim());
      } catch {
        throw new Error(`nodeId 无效：${nodeId}（请用 list_guild_direct_sessions 获取）`);
      }
      const svc = services();
      let peerName: string;
      try {
        peerName = (await svc.guildDirect.buildExportMeta(nodeId)).peerNick;
      } catch {
        throw new Error(
          `未找到频道私聊会话（nodeId=${nodeId}）；可先用 list_guild_direct_sessions 确认。`,
        );
      }
      const beforeSeq = before.trim() ? safeBigint(before) : null;
      const probe = limit + 1;
      const rows = beforeSeq
        ? await svc.guildDirect.getBefore(nodeId, beforeSeq, probe)
        : await svc.guildDirect.getLatest(nodeId, probe);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit); // 最新在前
      const nextBefore = hasMore && page.length ? String(page[page.length - 1]!.msgSeq) : '';
      const ordered = [...page].reverse();
      const messages: AiMsgLine[] = [];
      let prevSec: number | null = null;
      for (const m of ordered) {
        const sec = Number(m.sendTime);
        const mine = Number(m.sendType) !== 0;
        const line: AiMsgLine = {
          time: fmtTime(sec),
          sender: mine ? '我' : peerName,
          mine,
          text: flattenElements(m.elements ?? []),
        };
        if (prevSec !== null && sec - prevSec >= 1800) line.gap = humanDuration(sec - prevSec);
        prevSec = sec;
        messages.push(line);
      }
      return {
        nodeId,
        peerName,
        count: messages.length,
        hasMore,
        ...(nextBefore ? { nextBefore } : {}),
        coverage: '频道私聊来自本地 guild_msg_table，仅覆盖已同步部分。',
        messages,
        ...(messages.length === 0
          ? {
              hint: beforeSeq != null ? '没有更早的消息了。' : '该频道私聊会话本地没有消息记录。',
            }
          : hasMore
            ? { hint: '还有更早的消息；把 nextBefore 传回 before 可继续往前读。' }
            : {}),
      };
    },
  }),

  tool({
    name: 'list_collections',
    description:
      '列出当前账号的 QQ 收藏（收藏夹）。只读本机 collection.db，**不联网同步微云**——比应用内收藏页可能少最新的网络收藏。' +
      '返回每条：cid、kind 类型（text 文本/link 链接/gallery 相册/audio 语音/video 视频/file 文件/location 位置/richMedia 富媒体）、' +
      'collectedAt 收藏日期、authorName/groupName 来源、content 一段纯文本摘要。type 可过滤（1文本 2链接 3相册 4语音 5视频 6文件 7位置 8富媒体）。' +
      '回答「我收藏过什么」「找一条收藏的链接/文章」用这个。',
    input: z.object({
      type: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe('按内容类型过滤：1=文本 2=链接 3=相册 4=语音 5=视频 6=文件 7=位置 8=富媒体'),
      limit: z.number().int().min(1).max(100).default(30).describe('返回条数上限'),
      offset: z.number().int().min(0).default(0).describe('分页偏移'),
    }),
    run: async ({ type, limit, offset }) => {
      const svc = services();
      const kindLabel: Record<string, string> = {
        text: '文本',
        link: '链接',
        gallery: '相册',
        audio: '语音',
        video: '视频',
        file: '文件',
        location: '位置',
        richMedia: '富媒体',
        unknown: '未知',
      };
      // type 过滤下「offset/limit 按匹配条数计」：底层接口不支持类型筛选，这里
      // 逐页扫本地库直到攒够 offset+limit 条匹配或扫完，避免每页截断后漏匹配。
      const PAGE = 100;
      const wantedEnd = offset + limit + 1; // 多取一条用于诚实的 hasMore
      const matched: Array<ReturnType<typeof collectionItemToWire>> = [];
      let scannedRows = 0;
      while (matched.length < wantedEnd) {
        const page = await svc.collection.listCollectionsFromDb(PAGE, scannedRows);
        if (!page || page.items.length === 0) break;
        scannedRows += page.items.length;
        for (const it of page.items) {
          if (type && it.type !== type) continue;
          matched.push(collectionItemToWire(it));
          if (matched.length >= wantedEnd) break;
        }
        if (!page.hasMore || page.items.length < PAGE) break;
      }
      const items = matched.slice(offset, offset + limit).map((w) => {
        let content = w.text;
        if (!content && w.link) {
          content = [w.link.title, w.link.brief, w.link.url].filter(Boolean).join(' | ');
        }
        if (!content && w.video?.title) content = `${w.video.title}[视频]`;
        if (!content && w.file?.name) content = `[文件:${w.file.name}]`;
        if (!content && w.location?.name) {
          content = [w.location.name, w.location.address].filter(Boolean).join(' ');
        }
        if (!content && w.richMedia?.title) {
          content = [w.richMedia.title, w.richMedia.brief, w.richMedia.originalUri]
            .filter(Boolean)
            .join(' | ');
        }
        if (!content && w.gallery?.pics?.length) content = `[相册 ${w.gallery.pics.length} 张图片]`;
        if (!content && w.audio?.stt) content = `[语音转写] ${w.audio.stt}`;
        return {
          cid: w.cid,
          kind: w.kind,
          kindLabel: kindLabel[w.kind] ?? w.kind,
          collectedAt: fmtMsDate(w.collectTime),
          ...(w.authorName ? { authorName: w.authorName } : {}),
          ...(w.groupName ? { groupName: w.groupName } : {}),
          content: content || '',
        };
      });
      if (items.length === 0 && matched.length === 0) {
        return {
          count: 0,
          source: 'db',
          items: [],
          hint: '本地 collection.db 里没有收藏记录（或该库不存在）。',
        };
      }
      return {
        count: items.length,
        hasMore: matched.length >= wantedEnd,
        source: 'db',
        items,
        hint: '来源为本地 collection.db（工具固定不走网络），仅包含本机已缓存的收藏。',
      };
    },
  }),

  tool({
    name: 'decode_blob',
    description:
      '把一段 hex / base64 二进制按 protobuf 或 JCE（QQHook TarsParser 语义）逆向解码成可读 JSON。' +
      'format=auto 时先按 protobuf 完整解析、失败再试 JCE；两者都不完整时退回 schema-free 猜测树，' +
      '并给出每个字段可能的含义（utf8 / bool / 时间戳 / zigzag / 定长 float 等）。' +
      'tag ≥ 1001 的字段会尽量附上 QQ 全局词典里的字段名（小 tag 无全局含义、以嵌套上下文为准）。' +
      '用于分析 execute_sql 查出来的 BLOB（如 40800 消息体）或任意十六进制/Base64 数据。' +
      '返回 fields：{ tag, field?, value } 树；bytes 较大时只给摘要 hex。',
    input: z.object({
      data: z
        .string()
        .min(1)
        .describe('hex（允许空格/冒号/0x 前缀）或 base64；可先直接粘贴 execute_sql 返回的 hex'),
      encoding: z
        .enum(['auto', 'hex', 'base64'])
        .default('auto')
        .describe('输入编码；auto 时先按 hex 判定'),
      format: z
        .enum(['auto', 'protobuf', 'jce'])
        .default('auto')
        .describe('auto=先 protobuf 再 JCE；也可强制按一种解析'),
    }),
    run: async ({ data, encoding, format }) => {
      const result = decodeBlobText(data, encoding, format);
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          hint: '换更短的片段，或确认输入是完整字节（BLOB 列通常从 execute_sql 直接复制 hex）。',
        };
      }
      return {
        ok: true,
        bytes: result.bytes,
        kind: result.kind,
        fields: result.fields,
        ...(result.guessNote ? { guessNote: result.guessNote } : {}),
        hint:
          result.kind === 'guess'
            ? '未完整解析为 protobuf/JCE：上面是 schema-free 猜测。可调 format 强制、裁剪首尾长度头（如 4 字节大端长度）后再试。'
            : '字段名只来自 QQ 全局 tag 词典；若想把该 blob 按已知表结构解码，可配合 execute_sql 看所在表/列名。',
      };
    },
  }),

  tool({
    name: 'decode_db_blob',
    description:
      '直接取当前账号某个数据库里【第一行满足 SQL 条件的目标列】的 BLOB/TEXT，并按 protobuf/JCE/schema-free 解码。' +
      '把「先 execute_sql 看 hex、再 decode_blob」两步合成一步：sql 必须是只读 SELECT，column 为要解的目标列名。' +
      '例：dbName=msg.db, sql=SELECT * FROM c2c_msg_table WHERE 40001=123, column=40800。' +
      '返回与 decode_blob 相同的 fields 树，并附 source（库/路径/SQL/列/字节数）。',
    input: z.object({
      dbName: z
        .string()
        .min(1)
        .describe('数据库文件名（如 msg.db / nt_msg.db），可用 list_databases 查'),
      sql: z
        .string()
        .min(1)
        .describe('只读 SELECT，取第一行作为目标（建议 WHERE 限定 msgId/rowid）'),
      column: z.string().min(1).describe('目标列名（结果集里要解码的那一列）'),
      format: z
        .enum(['auto', 'protobuf', 'jce'])
        .default('auto')
        .describe('同 decode_blob：auto=先 protobuf 再 JCE，失败给猜测树'),
      encoding: z
        .enum(['auto', 'hex', 'base64'])
        .default('auto')
        .describe('TEXT 单元格的输入编码（BLOB 单元格固定按 hex；auto 先判 hex）'),
    }),
    run: async ({ dbName, sql, column, format, encoding }) => {
      const dbFile = await accountDbFile(dbName);
      if (!dbFile) {
        return {
          ok: false,
          error: `未找到名为「${dbName}」的数据库。可通过 list_databases 查看可用数据库。`,
        };
      }
      if (!/^(select|with|explain)\b/i.test(sql.trim())) {
        return {
          ok: false,
          dbName: dbFile.name,
          error: 'decode_db_blob 只接受只读 SELECT / WITH / EXPLAIN，已阻止执行其它语句。',
        };
      }

      let result: Awaited<ReturnType<AccountServices['dbExplorer']['runSql']>>;
      try {
        result = await services().dbExplorer.runSql(dbFile.path, sql);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, dbName: dbFile.name, error: `SQL 执行失败：${message}` };
      }
      if (result.kind !== 'rows') {
        return {
          ok: false,
          dbName: dbFile.name,
          error: 'decode_db_blob 只接受只读 SELECT；当前语句不是读语句。',
        };
      }
      const colIndex = result.columns.indexOf(column);
      if (colIndex < 0) {
        return {
          ok: false,
          dbName: dbFile.name,
          column,
          availableColumns: result.columns,
          error: `结果集里没有列「${column}」。`,
        };
      }
      if (!result.rows.length) {
        return { ok: false, dbName: dbFile.name, error: 'SQL 没有返回任何行。' };
      }

      const cell: unknown = result.rows[0]?.[colIndex];
      let decoded: ReturnType<typeof decodeBlobHex>;
      if (
        cell !== null &&
        cell !== undefined &&
        typeof cell === 'object' &&
        't' in cell &&
        (cell as { t?: string }).t === 'blob' &&
        typeof (cell as { hex?: unknown }).hex === 'string'
      ) {
        decoded = decodeBlobHex(String((cell as { hex?: unknown }).hex), format);
      } else if (typeof cell === 'string') {
        decoded = decodeBlobText(cell, encoding, format);
      } else {
        decoded = {
          ok: false,
          kind: 'none',
          bytes: 0,
          fields: [],
          error: '目标单元格既不是 BLOB 也不是 TEXT。',
        };
      }
      if (!decoded.ok) {
        return {
          ok: false,
          dbName: dbFile.name,
          error: decoded.error,
        };
      }
      return {
        ok: true,
        source: {
          dbName: dbFile.name,
          dbPath: dbFile.path,
          sql,
          column,
        },
        bytes: decoded.bytes,
        kind: decoded.kind,
        fields: decoded.fields,
        ...(decoded.guessNote ? { guessNote: decoded.guessNote } : {}),
      };
    },
  }),

  tool({
    name: 'execute_sql',
    description:
      '在当前 QQ 账号本地数据库里执行一条 SQL 语句（SELECT / INSERT / UPDATE / DELETE / PRAGMA / DDL 等均可）。' +
      '`dbName` 是数据库文件名（如 `msg.db`、`login.db`、`bc_09.db`），可先用 list_databases 查；`table` 是参考用的表名，' +
      '仅用于结果里的上下文，不参与执行。执行成功返回 `{ success: true, result }`，失败返回 `{ success: false, error }`。' +
      '⚠️ 写操作会真的改 QQ 数据库，谨慎使用，建议 QQ 关闭时操作。',
    input: z.object({
      dbName: z
        .string()
        .min(1)
        .describe('数据库文件名（如 msg.db、login.db、bc_09.db），可通过 list_databases 获得'),
      table: z.string().min(1).describe('参考用的表名（仅用于结果上下文，不参与 SQL 执行）'),
      sql: z.string().min(1).describe('要执行的 SQL 语句（可含多条，用 ; 分隔，末尾分号可省略）'),
    }),
    run: async ({ dbName, sql }) => {
      const dbExplorer = services().dbExplorer;

      // 把数据库文件名解析成完整路径
      const databases = await dbExplorer.listDatabases();
      const dbFile = databases.find((d) => d.name.toLowerCase() === dbName.toLowerCase());
      if (!dbFile) {
        return {
          success: false,
          dbName,
          error: `未找到名为「${dbName}」的数据库。可通过 list_databases 查看可用数据库。`,
        };
      }

      try {
        const result = await dbExplorer.runSql(dbFile.path, sql);
        return {
          success: true,
          dbName: dbFile.name,
          dbPath: dbFile.path,
          table: dbName,
          result,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          success: false,
          dbName: dbFile.name,
          dbPath: dbFile.path,
          table: dbName,
          error: message,
        };
      }
    },
  }),

  tool({
    name: 'list_databases',
    description:
      '列出当前账号目录下可访问的 QQ 数据库文件（name、完整 dbPath、bytes、kind：account=账号库 / login=全局登录库）。' +
      '是 execute_sql / decrypt_database 选库的入口：dbName 直接取这里的 name 即可。只读本地目录，不发网络。',
    input: z.object({}),
    run: async () => {
      const svc = services();
      const dbs = await svc.dbDecrypt.listDatabases();
      return {
        count: dbs.length,
        databases: dbs.map((d) => ({
          name: d.name,
          path: d.path,
          bytes: d.bytes,
          kind: d.kind,
        })),
        hint:
          dbs.length === 0
            ? '当前账号目录下没有找到 .db 文件。'
            : '需要操作某库时把 name 传给 execute_sql；需要拿到明文副本用 decrypt_database。',
      };
    },
  }),

  tool({
    name: 'list_db_tables',
    description:
      '列出当前账号某个 QQ 数据库里的表 / 视图 / 索引（来自 sqlite_master，不含内部 sqlite_* 与触发器）。' +
      'DB 逆向或想确认 execute_sql 该查哪张表时先用它。dbName 用 list_databases 的 name。',
    input: z.object({
      dbName: z
        .string()
        .min(1)
        .describe('数据库文件名（如 msg.db、login.db、bc_09.db），可用 list_databases 查'),
    }),
    run: async ({ dbName }) => {
      const dbFile = await accountDbFile(dbName);
      if (!dbFile) {
        return {
          ok: false,
          error: `未找到名为「${dbName}」的数据库。可通过 list_databases 查看可用数据库。`,
        };
      }
      const objects = await services().dbExplorer.listObjects(dbFile.path);
      return {
        ok: true,
        dbName: dbFile.name,
        dbPath: dbFile.path,
        count: objects.length,
        tables: objects.filter((o) => o.type === 'table'),
        views: objects.filter((o) => o.type === 'view'),
        indexes: objects
          .filter((o) => o.type === 'index')
          .map((o) => ({
            name: o.name,
            table: o.tableName,
          })),
      };
    },
  }),

  tool({
    name: 'get_db_columns',
    description:
      '列出当前账号某个 QQ 数据库里指定表/视图的列（cid、列名、类型、NOT NULL、是否主键）。' +
      '配合 list_db_tables / execute_sql 做数据库探索：不用先手写 PRAGMA table_info。',
    input: z.object({
      dbName: z.string().min(1).describe('数据库文件名（如 msg.db），可用 list_databases 查'),
      table: z.string().min(1).describe('表名或视图名（list_db_tables 可查）'),
    }),
    run: async ({ dbName, table }) => {
      const dbFile = await accountDbFile(dbName);
      if (!dbFile) {
        return {
          ok: false,
          error: `未找到名为「${dbName}」的数据库。可通过 list_databases 查看可用数据库。`,
        };
      }
      try {
        const columns = await services().dbExplorer.getColumns(dbFile.path, table);
        return {
          ok: true,
          dbName: dbFile.name,
          dbPath: dbFile.path,
          table,
          count: columns.length,
          columns,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, dbName: dbFile.name, table, error: message };
      }
    },
  }),

  tool({
    name: 'query_sqlite_file',
    description:
      '对【已解密的明文 SQLite 文件】执行只读 SQL（SELECT / WITH / EXPLAIN；PRAGMA 不开放）——' +
      '例如 decrypt_database 生成的明文副本，或其它已知明文 .db。与 execute_sql 不同：' +
      '本工具直接接受文件路径、不校验账号目录、也不允许写语句（杜绝误改源库）。' +
      '返回与 execute_sql 相同的 rows 结构；BLOB 单元格以 hex 形式给出（可再交给 decode_blob / decode_db_blob）。',
    input: z.object({
      path: z
        .string()
        .min(1)
        .describe('明文 SQLite 文件的绝对路径（decrypt_database 返回的 outPath 即可直接填）'),
      sql: z
        .string()
        .min(1)
        .describe(
          '只读 SQL（SELECT / WITH / EXPLAIN；查表结构用 sqlite_master，查列用 pragma_table_info）',
        ),
    }),
    run: async ({ path, sql }) => {
      try {
        const result = await services().dbExplorer.queryPlainSqliteFile(path, sql);
        return { ok: true, path, sql, result };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          path,
          error: message,
          hint: '仅支持明文 SQLite（解密副本可直接查；加密的 nt_db 原库请走 execute_sql / list_databases）。',
        };
      }
    },
  }),

  tool({
    name: 'decrypt_database',
    description:
      '把当前账号的一个加密 QQ 数据库解密成明文 SQLite 副本写到本地目录（默认 fast 快路径；safe 更稳更慢）。' +
      'dbName 用 list_databases 的 name（如 msg.db / login.db / bc_09.db——bc_09 本就是明文，只做拷贝）。' +
      'outputDir 必须是本机真实存在的绝对目录（目录不存在会自动创建）。返回 outPath 明文文件路径，之后可用任意 SQLite 工具打开，' +
      '也可把路径交给 execute_sql 外的本地工具。⚠️ 本工具会写本地文件，且可能包含你全部聊天数据，注意输出目录权限。' +
      '只读源库（源文件不会被修改），不发网络。',
    input: z.object({
      dbName: z.string().min(1).describe('数据库文件名（list_databases 的 name）'),
      outputDir: z.string().min(1).describe('明文副本输出目录（绝对路径，不存在会自动创建）'),
      mode: z
        .enum(['fast', 'safe'])
        .default('fast')
        .describe('解密模式：fast=快路径（默认），safe=保守慢路径'),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(6)
        .optional()
        .describe('并发数（默认 3，单库无需传）'),
    }),
    run: async ({ dbName, outputDir, mode, concurrency }) => {
      const svc = services();
      const databases = await svc.dbDecrypt.listDatabases();
      const dbFile = databases.find((d) => d.name.toLowerCase() === dbName.toLowerCase());
      if (!dbFile) {
        return {
          ok: false,
          dbName,
          error: `未找到名为「${dbName}」的数据库。可先调 list_databases 查看可用数据库。`,
        };
      }
      const results = await svc.dbDecrypt.decryptDatabases({
        items: [{ dbPath: dbFile.path, name: dbFile.name }],
        outputDir: String(outputDir).trim(),
        mode,
        ...(concurrency ? { concurrency } : {}),
      });
      const r = results[0];
      if (!r?.ok) {
        return { ok: false, dbName, error: r?.error ?? '解密失败' };
      }
      return {
        ok: true,
        dbName: r.name,
        sourcePath: r.dbPath,
        outPath: r.outPath,
        mode,
        hint: `明文副本已写入 ${r.outPath}；源库未被修改。`,
      };
    },
  }),

  // ── 凭据类 ────────────────────────────────────────────────────────────

  tool({
    name: 'get_web_tokens',
    description:
      '获取当前账号在指定域的 web 凭据（skey / p_skey + bkn）。domain 可选 qzone.qq.com / qun.qq.com / ti.qq.com / vip.qq.com / pd.qq.com。' +
      '已注入时走 hook 实时取（秒回），未注入时自动回退 ptlogin2 本地快速登录。' +
      'skey 与域无关；p_skey 按域缓存。⚠️ 返回的是登录凭据，不要泄露、不要写入日志。需要在线 QQ。',
    input: z.object({
      domain: z
        .enum(['qzone.qq.com', 'qun.qq.com', 'ti.qq.com', 'vip.qq.com', 'pd.qq.com'])
        .describe('要取票据的业务域名'),
      needSkey: z.boolean().default(false).describe('是否同时取 skey（默认只要 p_skey）'),
    }),
    run: async ({ domain, needSkey }) => {
      const pid = onlinePid();
      const uin = currentUin();
      const tokens = await fetchWebTokens(ntHelper(), uin, pid, domain, { needSkey });
      if (!tokens.pskey && !tokens.skey) {
        return {
          ok: false,
          domain,
          error: '凭据获取失败（QQ 可能刚重启、票据过期或该域不支持兜底登录）。',
        };
      }
      return {
        ok: true,
        domain,
        uin,
        ...(tokens.skey ? { skey: tokens.skey } : {}),
        ...(tokens.pskey ? { pskey: tokens.pskey } : {}),
        bkn: computeBkn(tokens.pskey || tokens.skey),
        hint: '凭据短期有效；调外部接口时 cookie 带 skey/p_skey，g_tk 用返回的 bkn。',
      };
    },
  }),

  tool({
    name: 'get_client_key',
    description:
      '获取当前账号的 clientKey（客户端票据，可换一次性免登跳转 URL）。需要已注入的在线 QQ。' +
      '⚠️ 一次性敏感凭据，不要泄露。',
    input: z.object({}),
    run: async () => {
      onlinePid(); // 只要求在线；clientKey 由 hook 提供
      const ck = await fetchClientKey(ntHelper(), onlinePid());
      if (!ck.clientKey) {
        return {
          ok: false,
          error: 'clientKey 获取失败 —— 确认 QQ 在线且已开启「自动注入 QQ（完整功能）」。',
        };
      }
      return { ok: true, clientKey: ck.clientKey, keyIndex: ck.keyIndex };
    },
  }),

  tool({
    name: 'get_download_rkeys',
    description:
      '获取当前账号的媒体下载 rkey（图片 CDN 签名 URL 的 &rkey=… 片段）。type: 10=私聊图, 20=群聊图。' +
      '同时返回各 rkey 的有效期（createTime + ttlSeconds）。需要在线 QQ（hook 实时取）。',
    input: z.object({}),
    run: async () => {
      const pid = onlinePid();
      const items = await fetchDownloadRkeys(ntHelper(), pid);
      return {
        ok: true,
        count: items.length,
        items: items.map((r) => ({
          rkey: r.rkey,
          type: r.type,
          ttlSeconds: r.ttlSeconds,
          createTime: r.createTime,
          expiresAt: new Date((r.createTime + r.ttlSeconds) * 1000).toISOString(),
        })),
        hint: 'rkey 拼在 QQ 媒体 CDN URL 后面（&rkey=…）；过期后重新调用本工具即可。',
      };
    },
  }),

  tool({
    name: 'get_ptlogin_jump_url',
    description:
      '生成一个 QQ空间 / QQ频道 的【免登录跳转 URL】——浏览器打开即已登录（ptlogin2 跳转链，302 落 cookie）。' +
      'site=qzone 落地到空间个人中心，site=channel 落地到频道 pd.qq.com。URL 含一次性 clientKey，点击时现取。需要在线且已注入的 QQ。',
    input: z.object({
      site: z.enum(['qzone', 'channel']).describe('目标站点'),
    }),
    run: async ({ site }) => {
      const pid = onlinePid();
      const uin = currentUin();
      const landing =
        site === 'qzone'
          ? `https://user.qzone.qq.com/${uin}/infocenter?loginfrom=31`
          : 'https://pd.qq.com/';
      const ck = await fetchClientKey(ntHelper(), pid);
      if (!ck.clientKey) {
        return {
          ok: false,
          site,
          url: landing,
          autoLogin: false,
          hint: 'clientKey 不可用，退回裸地址（需手动登录）。',
        };
      }
      const { buildPtlogin2JumpUrl } = await import('@weq/service');
      return {
        ok: true,
        site,
        url: buildPtlogin2JumpUrl(ck, uin, landing),
        autoLogin: true,
        hint: 'URL 含一次性凭据，仅在本次会话使用，不要转发。',
      };
    },
  }),

  // ── 协议能力类（OIDB，需要在线 QQ）──────────────────────────────────

  tool({
    name: 'get_peer_stats',
    description:
      '查询某个用户的【QQ 等级 + 资料卡累计获赞】（两条 OIDB 并行：0xFE1_2 按 uin 查等级，0x7ED_12 按 uid 查获赞）。' +
      'uin 与 uid 至少传一个：只有 uin 时只查等级，只有 uid 时只查获赞，两个都传时全查。需要在线 QQ。',
    input: z.object({
      uin: z.string().optional().describe('目标 QQ 号（纯数字，查等级用）'),
      uid: z.string().optional().describe('目标 uid（u_ 开头，查获赞用；find_contact 可解析）'),
    }),
    run: async ({ uin, uid }) => {
      const svc = services().peerStats;
      const out: Record<string, unknown> = {};
      if (uin?.trim()) out.level = await svc.getQqLevel(uin.trim());
      if (uid?.trim()) out.likeCount = await svc.getLikeCount(uid.trim());
      if (Object.keys(out).length === 0) {
        throw new Error('uin 与 uid 至少传一个。');
      }
      return { ok: true, ...(uin ? { uin } : {}), ...(uid ? { uid } : {}), ...out };
    },
  }),

  tool({
    name: 'get_qq_show_url',
    description:
      '查询某个 QQ 号的【QQ 秀形象】（OIDB 0xFE1_3，按 uin 查），返回透明全身像 URL；没有 QQ 秀时 hasShow=false。需要在线 QQ。',
    input: z.object({
      uin: z.string().min(1).describe('目标 QQ 号（纯数字）'),
    }),
    run: async ({ uin }) => {
      const info = await services().peerStats.getQqShow(uin.trim());
      return {
        ok: true,
        uin,
        hasShow: info.hasShow,
        ...(info.hasShow && info.url ? { url: info.url } : {}),
        ...(!info.hasShow ? { hint: '该账号没有设置 QQ 秀。' } : {}),
      };
    },
  }),

  tool({
    name: 'get_flash_share_link',
    description:
      '把一条【QQ 闪传】卡片的 fileSetId 换成可分享的下载链接（OIDB 0x93d3_1）。' +
      'fileSetId 来自闪传消息的 fileTransferInfo。需要在线 QQ。',
    input: z.object({
      fileSetId: z.string().min(1).describe('闪传 fileset uuid'),
    }),
    run: async ({ fileSetId }) => {
      const shareUrl = await services().flashTransfer.getShareLink(fileSetId.trim());
      return {
        ok: shareUrl !== '',
        fileSetId,
        ...(shareUrl ? { shareUrl } : { error: '服务端没有返回分享链接（fileset 可能已过期）。' }),
      };
    },
  }),

  tool({
    name: 'fetch_history_window',
    description:
      '【从服务端拉取一段历史消息】（SsoGetGroupMsg / SsoGetC2cMsg，按 msgSeq 窗口，单次最多约 30 条）。' +
      '用于本地库有 seq 缺口、或想看比本地更早的消息。拉到的消息会写入本机漫游缓存，下次直接命中。' +
      'kind: c2c=私聊（conv 传对方 uid），group=群聊（conv 传群号）。需要在线 QQ。',
    input: z.object({
      kind: z.enum(['c2c', 'group']).describe('会话类型'),
      conv: z.string().min(1).describe('私聊为对方 uid，群聊为群号'),
      startSeq: z.number().int().min(0).describe('窗口起始 seq（含，旧端）'),
      endSeq: z
        .number()
        .int()
        .min(0)
        .describe('窗口结束 seq（含，新端；end-start ≤ 30，更大的缺口返回 nextStartSeq 分页继续）'),
    }),
    run: async ({ kind, conv, startSeq, endSeq }) => {
      const result = await services().gapHistory.fetch(kind, conv, startSeq, endSeq);
      if (!result.ok) {
        return {
          ok: false,
          kind,
          conv,
          startSeq,
          endSeq,
          reason: result.reason,
          error: result.message,
        };
      }
      return {
        ok: true,
        kind,
        conv,
        fetched: result.fetched,
        count: result.messages.length,
        ...(result.nextStartSeq !== null ? { nextStartSeq: result.nextStartSeq } : {}),
        messages: result.messages.map((m) => ({
          time: fmtTime(BigInt(m.sendTime)),
          msgSeq: m.msgSeq,
          sender: m.senderUin,
          text: flattenElements(m.elements),
        })),
        ...(!result.nextStartSeq && result.fetched === 0
          ? { hint: '这段 seq 服务端没有返回消息（可能超出漫游覆盖范围）。' }
          : {}),
      };
    },
  }),

  tool({
    name: 'send_tuwen_ark',
    description:
      '给私聊或群聊发送一张【自定义图文 Ark 卡片】（OIDB 0xdc2_34：标题 + 描述 + 跳转链接 + 预览图）。' +
      '⚠️ 这是真实的发送行为，会在目标会话里出现一条卡片消息。需要在线 QQ。',
    input: z.object({
      peerType: z.enum(['c2c', 'group']).describe('发送目标类型'),
      targetId: z.string().min(1).describe('目标 QQ 号（c2c）或群号（group），纯数字'),
      title: z.string().min(1).max(100).describe('卡片标题'),
      desc: z.string().max(200).default('').describe('卡片描述'),
      jumpUrl: z.string().url().describe('点击跳转的 URL'),
      previewUrl: z.string().url().default('').describe('卡片预览图 URL（可为空）'),
    }),
    run: async ({ peerType, targetId, title, desc, jumpUrl, previewUrl }) => {
      if (peerType !== 'group') {
        throw new Error('当前只支持发到群聊（peerType=group）。');
      }
      await services().flashTransfer.sendTuwenArkToGroup({
        groupId: Number(targetId.trim()),
        cardTitle: title,
        desc,
        jumpUrl,
        previewUrl,
      });
      return { ok: true, peerType, targetId, hint: '卡片已发送（响应仅 ack，无法撤回）。' };
    },
  }),

  // ── Web CGI 查询类 ──────────────────────────────────────────────────

  tool({
    name: 'get_group_honor',
    description:
      '查询某个群的【群荣誉榜单】（qun.qq.com 荣誉页）：type=talkative 龙王/群聊之火, performer 群聊炽焰, legend 群聊传说, emotion 快乐源泉。' +
      '返回每名：uin、nickname、desc 荣誉描述。需要在线 QQ（凭证可 pt_login 兜底）。',
    input: z.object({
      groupCode: z.string().min(1).describe('群号（纯数字，find_contact 可解析群名）'),
      type: z
        .enum(['talkative', 'performer', 'legend', 'emotion'])
        .default('talkative')
        .describe('荣誉类型'),
    }),
    run: async ({ groupCode, type }) => {
      const map = {
        talkative: HonorType.Talkative,
        performer: HonorType.Performer,
        legend: HonorType.Legend,
        emotion: HonorType.Emotion,
      } as const;
      const list = await services().webQuery.getHonorList(groupCode.trim(), map[type]);
      return {
        ok: true,
        groupCode,
        type,
        count: list.length,
        members: list.map((m) => ({
          uin: m.uin !== null ? String(m.uin) : null,
          nickname: m.nickname,
          desc: m.description,
        })),
        ...(list.length === 0 ? { hint: '榜单为空（该群暂无此荣誉数据，或无查看权限）。' } : {}),
      };
    },
  }),

  tool({
    name: 'get_group_albums',
    description:
      '列出某个群的【相册列表】（qzone cgi）：相册 id、名称、照片数、封面、描述、创建/更新时间。' +
      '相册 id 传给 get_group_album_photos 看内容。需要在线 QQ。',
    input: z.object({
      groupId: z.string().min(1).describe('群号（纯数字）'),
    }),
    run: async ({ groupId }) => {
      const albums = await services().webQuery.getGroupAlbumList(groupId.trim());
      return {
        ok: true,
        groupId,
        count: albums.length,
        albums: albums.map((a) => ({
          id: a.id,
          title: a.title,
          photoCount: a.photoCount,
          ...(a.coverUrl ? { coverUrl: a.coverUrl } : {}),
          ...(a.desc.trim() ? { desc: a.desc } : {}),
          createTime: a.createTime,
          updateTime: a.updateTime,
        })),
        ...(albums.length === 0 ? { hint: '该群没有相册，或票据已失效。' } : {}),
      };
    },
  }),

  tool({
    name: 'get_qzone_profile',
    description:
      '读取某个 QQ 号的【QQ空间资料】：说说列表（get_emotion_list，pos+num 稳定深翻）或相册列表。' +
      'mode=msgs 返回说说（内容/时间/图片/视频/评论数），mode=albums 返回相册。需要在线 QQ。',
    input: z.object({
      targetUin: z.string().min(1).describe('目标 QQ 号（纯数字；不传查自己）').optional(),
      mode: z.enum(['msgs', 'albums']).default('msgs').describe('msgs=说说列表, albums=相册列表'),
      pos: z.number().int().min(0).default(0).describe('说说翻页偏移（mode=msgs）'),
      num: z.number().int().min(1).max(50).default(10).describe('说说条数上限（mode=msgs）'),
    }),
    run: async ({ targetUin, mode, pos, num }) => {
      const svc = services().webQuery;
      const uin = (targetUin ?? currentUin()).trim();
      if (mode === 'albums') {
        const albums = await svc.getQzoneAlbums(uin);
        return {
          ok: true,
          targetUin: uin,
          mode,
          count: albums.length,
          albums: albums.map((a) => ({
            id: a.id,
            name: a.name,
            mediaCount: a.mediaCount,
            ...(a.coverUrl ? { coverUrl: a.coverUrl } : {}),
            createTime: a.createTime ? fmtDate(BigInt(a.createTime)) : '',
          })),
        };
      }
      const result = await svc.getQzoneMsgList(uin, pos, num);
      return {
        ok: true,
        targetUin: uin,
        mode,
        total: result.total,
        count: result.list.length,
        ...(pos + result.list.length < result.total ? { nextPos: pos + result.list.length } : {}),
        list: result.list.map((e) => ({
          tid: e.tid,
          time: fmtTime(BigInt(e.time)),
          content: e.content,
          commentNum: e.commentNum,
          ...(e.isPrivate ? { isPrivate: true } : {}),
          ...(e.images.length ? { images: e.images } : {}),
          ...(e.videos.length
            ? {
                videos: e.videos.map((v) => ({
                  coverUrl: v.coverUrl,
                  videoUrl: v.videoUrl,
                  duration: v.duration,
                })),
              }
            : {}),
        })),
      };
    },
  }),

  tool({
    name: 'get_friend_dress',
    description:
      '查询某个用户【正在使用的个性装扮】（好友装扮 SSR 页）：挂件/名片/浮屏/输入状态等。' +
      '注意：气泡/字体/头像装扮服务端对他人查询永远回默认款（已剔除），查自己正在用的全部装扮用 get_self_dress。需要在线 QQ。',
    input: z.object({
      targetUin: z.string().min(1).describe('目标 QQ 号（纯数字）'),
    }),
    run: async ({ targetUin }) => {
      const dress = await services().webQuery.getFriendDress(targetUin.trim());
      if (!dress) {
        return {
          ok: false,
          targetUin,
          error: '解析不出装扮数据（对方可能关闭了展示，或票据失效）。',
        };
      }
      return {
        ok: true,
        targetUin: dress.targetUin,
        isSvip: dress.isSvip,
        items: dress.items.map((i) => ({
          kind: i.kind,
          name: i.name,
          itemId: i.itemId,
          ...(i.price ? { price: i.price } : {}),
        })),
        ...(dress.items.length === 0 ? { hint: '对方没有可解析到的装扮（或全是默认款）。' } : {}),
      };
    },
  }),

  tool({
    name: 'get_self_dress',
    description:
      '查询【本账号正在使用的全部个性装扮】（含查他人拿不到的气泡/字体/头像），返回各类目 itemId 与名称。需要在线 QQ。',
    input: z.object({}),
    run: async () => {
      const dress = await services().webQuery.getSelfDress();
      return {
        ok: true,
        uin: dress.uin,
        items: dress.items.map((i) => ({
          kind: i.kind,
          name: i.name,
          itemId: i.itemId,
          ...(i.hdUrl ? { hdUrl: i.hdUrl } : {}),
        })),
      };
    },
  }),

  tool({
    name: 'get_friend_mutual_mark',
    description:
      '查询我与某个好友之间的【互动标识】（友谊的小船/巨轮、火花、幸运字符等，含每个标识的等级、进度、是否点亮、佩戴状态）。' +
      '传对方 uin。需要在线 QQ。',
    input: z.object({
      targetUin: z.string().min(1).describe('目标好友的 QQ 号（纯数字）'),
    }),
    run: async ({ targetUin }) => {
      const mark = await services().webQuery.getFriendMutualMark(targetUin.trim());
      return {
        ok: true,
        targetUin: mark.targetUin,
        targetNickname: mark.targetNickname,
        totalNum: mark.totalNum,
        lightUpNum: mark.lightUpNum,
        categories: mark.categories.map((c) => ({
          name: c.name,
          lightUpNum: c.lightUpNum,
          totalNum: c.totalNum,
          marks: c.marks.map((m) => ({
            name: m.name,
            symbol: m.symbol,
            level: m.level,
            isLightup: m.isLightup,
            isWearing: m.isWearing,
            count: m.count,
            ...(m.nextLevelName ? { nextLevelName: m.nextLevelName } : {}),
          })),
        })),
      };
    },
  }),

  tool({
    name: 'get_dress_mall',
    description:
      '查询【装扮商城】目录（气泡/字体/挂件）：mode=rank 排行榜（离线可用，走本地静态榜单兜底），mode=search 关键词搜索（必须在线）。' +
      'kind: bubble=气泡, font=字体, widget=挂件。返回每款 itemId、名称、预览图、价格。',
    input: z.object({
      kind: z.enum(['bubble', 'font', 'widget']).describe('装扮类目'),
      mode: z
        .enum(['rank', 'search'])
        .default('rank')
        .describe('rank=排行榜（离线可用）, search=搜索（需在线）'),
      keyword: z.string().default('').describe('搜索关键词（mode=search 时必填）'),
      pageIndex: z.number().int().min(1).default(1).describe('排行榜页码（从 1 起，mode=rank）'),
      pageSize: z.number().int().min(1).max(50).default(20).describe('每页条数'),
    }),
    run: async ({ kind, mode, keyword, pageIndex, pageSize }): Promise<unknown> => {
      const appId =
        kind === 'bubble'
          ? DressAppId.Bubble
          : kind === 'font'
            ? DressAppId.Font
            : DressAppId.Widget;
      const svc = services().webQuery;
      if (mode === 'search') {
        const kw = keyword.trim();
        if (!kw) throw new Error('mode=search 时必须传 keyword。');
        const { items, total } = await svc.searchDress(appId, kw, 0, pageSize);
        return dressMallResult(
          kind,
          'search',
          items,
          total,
          '搜索需要在线 QQ；没有在线实例时会抛错。',
        );
      }
      let items: DressMallItem[];
      let offline = false;
      try {
        items = await svc.getDressRank(appId, pageIndex, pageSize);
      } catch {
        // 离线兜底：读仓库里存的一份静态排行榜原始响应。
        const path = resolveResource('dress', `ranking-${kind}.json`);
        items = path ? normalizeMallItems(JSON.parse(readFileSync(path, 'utf-8'))) : [];
        offline = true;
      }
      return dressMallResult(
        kind,
        'rank',
        items,
        items.length,
        offline
          ? '当前为离线静态榜单（联网排行榜不可用时的兜底），内容可能不是最新。'
          : '在线排行榜。',
      );
    },
  }),

  tool({
    name: 'get_dress_resource_url',
    description:
      '从【本地离线资源 bundle】（resources/dress/*.dat，QQ 自带的那批装扮资源）查某款装扮某个部件的 CDN 下载 URL。' +
      '纯本地查询，不需要在线 QQ。kind: bubble/font/widget；name 部件名如 config.json / static.zip / other.zip / main / fzfont / aio_50.png / xydata.js。' +
      '查不到（bundle 没收录该款）返回 found=false，需要时改走在线换链。',
    input: z.object({
      kind: z.enum(['bubble', 'font', 'widget']).describe('装扮类目'),
      itemId: z.string().min(1).describe('装扮 id（纯数字）'),
      name: z.string().min(1).describe('部件名（如 config.json / static.zip / main / fzfont）'),
    }),
    run: async ({ kind, itemId, name }) => {
      const r = ntHelper().queryDressResourceUrl(kind, itemId.trim(), name.trim());
      if (!r) {
        return {
          found: false,
          kind,
          itemId,
          name,
          hint: '本地 bundle 没有这个条目（该款不在 QQ 自带资源里，或 name 不对）。',
        };
      }
      return {
        found: true,
        kind,
        itemId,
        name,
        url: r.url,
        bytes: r.size,
      };
    },
  }),

  tool({
    name: 'convert_font',
    description:
      '把 QQ 私有字体格式【FTF 转换成标准 TTF】（nt_helper 内置的 convertFont：识别 FTFH/FTFG 私有表、坐标解码、重组 glyf）。' +
      '输入已是普通 TTF 时会原样拷贝（并删掉 OTS 拒绝的空表）。返回输出文件路径与说明。⚠️ 会写本地文件。',
    input: z.object({
      inputPath: z.string().min(1).describe('输入字体文件绝对路径（.ttf，FTF 或普通 TTF）'),
      outputPath: z.string().min(1).describe('输出 TTF 的绝对路径'),
    }),
    run: async ({ inputPath, outputPath }) => {
      const message = ntHelper().convertFont(inputPath.trim(), outputPath.trim());
      return { ok: true, inputPath, outputPath, message };
    },
  }),

  // ── 商城表情 ────────────────────────────────────────────────────────

  tool({
    name: 'search_market_emoji',
    description:
      '搜索【商城表情包目录】（本地离线索引 25000+ 套：resources/emoji/market.csv）。' +
      'keyword 对名称/介绍做子串匹配；feeTypes 过滤来源（free/paid/vip/svip）。返回 packId、名称、介绍、来源标签。' +
      '拿到 packId 后接 get_market_pack_detail 看单套表情清单、get_market_pack_key 破解图片密钥。',
    input: z.object({
      keyword: z.string().default('').describe('搜索关键词（名称/介绍子串匹配，空=全部）'),
      feeTypes: z
        .array(z.enum(['free', 'paid', 'vip', 'svip']))
        .default([])
        .describe('来源过滤（空=全部）'),
      limit: z.number().int().min(1).max(200).default(30).describe('每页条数'),
      cursor: z.string().default('').describe('翻页游标（上一页返回的 nextCursor）'),
    }),
    run: async ({ keyword, feeTypes, limit, cursor }) => {
      const page = searchCatalog({
        keyword,
        ...(feeTypes.length ? { feeTypes } : {}),
        limit,
        ...(cursor ? { cursor } : {}),
      });
      return {
        total: page.total,
        count: page.entries.length,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        entries: page.entries,
        hint:
          page.entries.length === 0
            ? '没有命中；换个更短的关键词，或放宽 feeTypes。'
            : 'packId 可接 get_market_pack_detail（单套清单）与 get_market_pack_key（图片密钥）。',
      };
    },
  }),

  tool({
    name: 'get_market_pack_detail',
    description:
      '获取一套【商城表情包的在线详情】：名称、介绍、来源（免费/付费/VIP）、表情数量与每张表情的 hash/名称/关键词。' +
      '（CDN 拉 android.json 解析。）图片密钥用 get_market_pack_key。',
    input: z.object({
      packId: z.string().min(1).describe('表情包 ID（search_market_emoji 返回的 id）'),
    }),
    run: async ({ packId }) => {
      const detail = await services().emoji.getMarketPackDetail(packId.trim());
      if (!detail) {
        return { ok: false, packId, error: '拉不到该表情包的详情（id 不存在或 CDN 不可达）。' };
      }
      return {
        ok: true,
        packId: detail.packId,
        name: detail.name,
        summary: detail.summary,
        feeType: detail.feeType,
        updateTime: detail.updateTime,
        count: detail.count,
        items: detail.items,
      };
    },
  }),

  tool({
    name: 'get_market_pack_key',
    description:
      '破解一套【商城表情包的图片解密密钥】（16 位 ASCII，md5(str(seed)) 前缀）。' +
      '不传 timestamp 时自动恢复（免费包读元数据种子，付费包在 updateTime 附近爆破 TEA 头）；' +
      '手动传 timestamp 则按 md5(str(ts))[:16] 本地派生（不查网络）。解密图片走 get_market_pack_image。',
    input: z.object({
      packId: z.string().min(1).describe('表情包 ID'),
      timestamp: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('手动指定种子时间戳（unix 秒；不传=自动恢复）'),
    }),
    run: async ({ packId, timestamp }) => {
      const key = await services().emoji.getMarketPackKey(
        packId.trim(),
        timestamp && timestamp > 0 ? timestamp : undefined,
      );
      if (!key) {
        return {
          ok: false,
          packId,
          error: '密钥恢复失败（未知表情包 / 爆破窗口耗尽）。可试试手动传 timestamp。',
        };
      }
      return {
        ok: true,
        packId,
        key: key.key,
        timestamp: key.timestamp,
        source: key.source,
        hint: '密钥 = md5(str(timestamp)) 前 16 位；配合 CDN 加密 GIF 走 QQTEA 解密。',
      };
    },
  }),

  tool({
    name: 'get_market_pack_image',
    description:
      '下载并解密一张【商城表情图片】为明文 GIF（CDN 加密流 → packId 密钥 QQTEA 解密 → 本地缓存），返回本地文件路径。' +
      'keyOverride 可透传手动密钥跳过自动恢复。',
    input: z.object({
      packId: z.string().min(1).describe('表情包 ID'),
      hash: z.string().min(6).describe('表情图片 hash（get_market_pack_detail 的 items[].hash）'),
      keyOverride: z.string().optional().describe('手动密钥（16 位；不传=自动恢复）'),
    }),
    run: async ({ packId, hash, keyOverride }) => {
      const path = await services().emoji.getMarketPackImage(
        packId.trim(),
        hash.trim(),
        keyOverride?.trim() || undefined,
      );
      if (!path) {
        return {
          ok: false,
          packId,
          hash,
          error:
            '解密失败（密钥不对或 CDN 不可达）。可先 get_market_pack_key 拿密钥再传 keyOverride。',
        };
      }
      return { ok: true, packId, hash, path, hint: '明文 GIF 已落盘，可用文件工具查看。' };
    },
  }),
];
