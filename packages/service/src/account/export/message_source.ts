/**
 * The reusable middle layer of the export pipeline: stream a whole
 * conversation's messages in chronological order, and normalize each one into
 * an {@link ExportedMessage}.
 *
 * Streaming (async generator) instead of "load all then return an array" is the
 * whole point — a busy group can hold hundreds of thousands of messages, and a
 * full in-memory array (plus its decoded protobuf elements) would blow the
 * heap. Callers `for await` one message at a time and write as they go.
 *
 * Paging strategy: ascending by msgSeq (40003) using a cursor, so each page hits
 * the `(40027,40003)` composite index and the output is naturally oldest-first
 * (the order a chat log reads top-to-bottom). The cursor advances to the last
 * seq of each page; we stop when a short page comes back.
 *
 * Mixed-seq conversations: phone→PC migrated history lands with no per-conv seq
 * (40003 = 0/NULL), so the seq cursor (`40003 > 0`) never returns it — yet the
 * PC's own messages (seq > 0) do, so a naive seq scan silently drops all the
 * imported history. To capture both, we run TWO cursors and merge them by
 * sendTime: the seq scan (seq > 0) and a rowid scan restricted to seq-less rows
 * (the imported block). Each stream is ~oldest-first on its own; the merge
 * interleaves them into one globally chronological stream. When a conversation
 * has no imported rows the seq-less stream is empty (one cheap query), and when
 * every row is seq-less the seq stream is empty — both degenerate cases fall out
 * of the same merge with no special-casing.
 *
 * ── 损坏宽容（可选，`opts.salvage`）────────────────────────────────────────
 *
 * 导出一场会话要读几万行，而数据库可能只在其中几页上坏掉。严格读的代价是
 * "坏一页 = 整场会话后面的消息全部导不出来"。所以当：
 *
 *   1. 某次分页**真的报出错**（`isLikelyCorruptionError`），且
 *   2. 该账号已被用户授权宽容级别 ≥ 2（记住账号的 `dbTolerance` 设置）
 *
 * 时，本次分页会从**当前游标**切到容错续读（沿 seq/rowid 轴分块扫描），把能读出来的
 * 消息接着导完，读不出来的区间如实汇报给 `onSkipped`（进导出报告与降级账本）。
 * 健康库上这条路径一次都不会用到：没有报错就没有切换，导出的速度与顺序与以前完全
 * 一样。回退只属于 group / c2c 两个最主要的会话类型（官方号 / 服务号的容错读取尚未
 * 接入，它们仍然严格失败）。
 *
 * 授权默认从 `msgs.salvage`（账号级设置）取，所以导出入口**不需要**多传一个参数；
 * 调用方仍可用 `opts.salvage` 覆盖它（例如只想对某一次导出开宽容）。两者都没给时，
 * 这里退化成原来的严格分页。
 */

import { type SalvageBindingOptions, isLikelyCorruptionError } from '@weq/db';
import type { SalvageSkippedRange } from '@weq/native';
import type { MsgSalvageSource, MsgService, RenderGroupMsg, RenderC2cMsg } from '../msg';
import type { GapFetchedMessage } from '../gap_history';
import type { ExportedMessage, ExportTimeRange } from './types';

/** 允许分块容错续读的最低宽容级别（跳过数据必须由用户授权）。 */
const SALVAGE_MIN_LEVEL = 2;

/**
 * 导出过程中被**跳过**的一段数据。
 *
 * 刻意只有区间与邻居 key，没有"丢了几行"：那些行本来就读不出来，精确值无法得知；
 * 而 `span` 只是这些区间的**键跨度合计**，并不是行数上界 —— 同一个 key 可能对应多行
 * （共享 `seq` 的灰条、贴表情），实测就有"丢 21 行而跨度只有 18"。报告里必须照这个
 * 口径写：只说"这一段读不出来"，不要伪造行数。
 */
export interface ExportSkippedRanges {
  /** 会话标识（群号 / 好友 uid）。 */
  conv: string;
  /** 会话类型。 */
  kind: 'group' | 'c2c';
  /** 跳过区间（每条带自己的 `prevKey` / `nextKey` 邻居）。 */
  ranges: SalvageSkippedRange[];
  /** 这些区间的键跨度合计（**不是**丢失行数的上界，见上）。 */
  span: number;
}

/** 导出侧的宽容选项：级别、账本与 "少了什么" 的回调。 */
export interface SalvageSourceOptions {
  /**
   * 宽容授权 —— 与 `wrapBindingForSalvage` 用的是同一个对象（含实时级别读取、
   * 账本与逐条落盘回调）。级别由账号级设置决定，这里不猜。
   */
  binding: SalvageBindingOptions;
  /** 每次有区间被跳过就回调一批（导出报告 / 进度提示用）。 */
  onSkipped?: (info: ExportSkippedRanges) => void;
  /** 每块键跨度；省略则用 native 默认值。 */
  chunk?: number;
}

/** 当前是否允许把一次失败的分页换成容错续读。 */
function canSalvage(
  salvage: SalvageSourceOptions | MsgSalvageSource | undefined,
  error: unknown,
): boolean {
  if (!salvage) return false;
  if ((salvage.binding.level() ?? 0) < SALVAGE_MIN_LEVEL) return false;
  // 只有"看起来真的是损坏"才换路径：BUSY / 权限 / 语法错照旧抛出去，
  // 否则会把一个可重试的失败变成一个永不重试的降级。
  return isLikelyCorruptionError(error);
}

/** 把导出侧的选项折成 `streamSalvage*` 要的形状（含跳过回调的会话标注）。 */
function salvageStreamOptions(
  salvage: SalvageSourceOptions | MsgSalvageSource,
  conv: string,
  kind: 'group' | 'c2c',
): Parameters<MsgService['streamSalvageGroupAfter']>[2] {
  const report = 'onSkipped' in salvage ? salvage.onSkipped : undefined;
  return {
    salvage: salvage.binding,
    ...(salvage.chunk !== undefined ? { chunk: salvage.chunk } : {}),
    ...(report
      ? {
          onSkipped: (ranges: SalvageSkippedRange[], span: number) =>
            report({ conv, kind, ranges, span }),
        }
      : {}),
  };
}

/** 漫游补全消息的惰性来源（导出阶段只读一次缓存；无补全时省略）。 */
export type RoamMessageSource = () => Promise<GapFetchedMessage[]> | GapFetchedMessage[];

export interface IterateOptions {
  /** Messages per DB round-trip. Larger = fewer queries, more peak memory. */
  pageSize?: number;
  /** Inclusive send-time window (unix seconds); out-of-range messages are skipped. */
  range?: ExportTimeRange;
  /**
   * 漫游缓存补全的消息（导出「消息补全」拉回来的缺失消息）。按 sendTime 与
   * 本地消息合并、按 msgId 去重（同一消息本地已存在时以本地为准）。
   */
  roam?: RoamMessageSource;
  /**
   * 损坏宽容（可选）：页读失败且账号已授权级别 ≥ 2 时，从当前游标切到容错续读。
   * 不传则整条链路与以前完全一样（也不会去读任何宽容设置）。
   */
  salvage?: SalvageSourceOptions;
}

const DEFAULT_PAGE_SIZE = 2000;

/**
 * Whether a message's send time falls inside `range`. No range (or both bounds
 * null) accepts everything — the common "全部时间" case pays no per-message cost
 * beyond this guard. Paging still walks by msgSeq; only what we *yield* is
 * filtered, so the seq cursor and short-page termination are unaffected.
 */
function withinRange(sendTimeSec: number, range?: ExportTimeRange): boolean {
  if (!range) return true;
  if (range.start != null && sendTimeSec < range.start) return false;
  if (range.end != null && sendTimeSec > range.end) return false;
  return true;
}

/**
 * Merge two ~oldest-first message streams into one, ordered by sendTime. Both
 * inputs are individually near-ascending on sendTime (a seq scan and a rowid
 * scan of an imported block), so a classic two-way merge yields a globally
 * chronological stream while only ever holding one message from each in memory.
 * Ties and small local disorder inside a stream are preserved as-is — that's
 * the best obtainable order without a usable seq on the imported rows.
 */
async function* mergeBySendTime<T extends { sendTime: bigint }>(
  a: AsyncGenerator<T>,
  b: AsyncGenerator<T>,
): AsyncGenerator<T> {
  let na = await a.next();
  let nb = await b.next();
  while (!na.done && !nb.done) {
    if (na.value.sendTime <= nb.value.sendTime) {
      yield na.value;
      na = await a.next();
    } else {
      yield nb.value;
      nb = await b.next();
    }
  }
  for (; !na.done; na = await a.next()) yield na.value;
  for (; !nb.done; nb = await b.next()) yield nb.value;
}

/**
 * 把漫游缓存消息适配成渲染消息流（按 sendTime 升序），并过滤不属于本会话的
 * 脏数据。GapFetchedMessage 已带渲染元素（{ type, data }），与 DB 渲染消息同形。
 */
async function* roamMessageStream<T extends { sendTime: bigint }>(
  conv: string,
  source: RoamMessageSource,
): AsyncGenerator<T> {
  const messages = await source();
  const adapted = messages
    .filter((m) => m.conv === conv)
    .map(
      (m) =>
        ({
          msgId: BigInt(m.msgId),
          msgSeq: BigInt(m.msgSeq),
          sendTime: BigInt(m.sendTime),
          senderUid: m.senderUid,
          senderUin: BigInt(m.senderUin),
          elements: m.elements,
        }) as unknown as T,
    );
  adapted.sort((a, b) => (a.sendTime < b.sendTime ? -1 : a.sendTime > b.sendTime ? 1 : 0));
  yield* adapted;
}

/** 合并后按 msgId 去重：本地 DB 行（先到）优先，漫游重复副本丢弃。 */
async function* dedupeByMsgId<T extends { msgId: bigint }>(
  source: AsyncGenerator<T>,
): AsyncGenerator<T> {
  const seen = new Set<string>();
  for await (const m of source) {
    const key = m.msgId.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    yield m;
  }
}

/**
 * Yield every message of a group, oldest-first, paging under the hood.
 *
 * NOTE: the seq cursor uses `msgSeq > lastSeq`, which assumes per-group seqs are
 * unique (they are — 40003 is a per-group incrementing sequence). If a future
 * dataset proves otherwise, switch the cursor to a (seq,msgId) tuple.
 */
export async function* iterateGroupMessages(
  msgs: MsgService,
  groupCode: string,
  opts: IterateOptions = {},
): AsyncGenerator<RenderGroupMsg> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const salvage = opts.salvage ?? msgs.salvage;
  let merged: AsyncGenerator<RenderGroupMsg> = mergeBySendTime(
    pageGroupBySeq(msgs, groupCode, pageSize, salvage),
    pageGroupBySeqlessRowId(msgs, groupCode, pageSize, salvage),
  );
  if (opts.roam) {
    merged = mergeBySendTime(merged, roamMessageStream<RenderGroupMsg>(groupCode, opts.roam));
  }
  const deduped = opts.roam ? dedupeByMsgId(merged) : merged;
  for await (const m of deduped) {
    if (withinRange(Number(m.sendTime), opts.range)) yield m;
  }
}

/** Group seq cursor (`40003 > lastSeq`): all messages that carry a real seq. */
async function* pageGroupBySeq(
  msgs: MsgService,
  groupCode: string,
  pageSize: number,
  salvage?: SalvageSourceOptions,
): AsyncGenerator<RenderGroupMsg> {
  let cursor = 0n;
  for (;;) {
    let page: RenderGroupMsg[];
    try {
      page = await msgs.getGroupAfter(groupCode, cursor, pageSize);
    } catch (error) {
      if (!canSalvage(salvage, error)) throw error;
      // 严格读坏了：从**当前游标**接着读（不是从头重来 —— 已经 yield 出去的那部分
      // 不该重复写进文件）。续读是分批交出来的，所以这里再拆一层，保住"逐条产出"的契约。
      for await (const batch of msgs.streamSalvageGroupAfter(
        groupCode,
        cursor,
        salvageStreamOptions(salvage!, groupCode, 'group'),
      )) {
        yield* batch;
      }
      return;
    }
    if (page.length === 0) break;
    for (const m of page) yield m;
    cursor = page[page.length - 1]!.msgSeq;
    // A short page means we reached the tail — no need for one more empty query.
    if (page.length < pageSize) break;
  }
}

/** Group rowid cursor over seq-less rows only: the migration-imported block. */
async function* pageGroupBySeqlessRowId(
  msgs: MsgService,
  groupCode: string,
  pageSize: number,
  salvage?: SalvageSourceOptions,
): AsyncGenerator<RenderGroupMsg> {
  let cursor = 0n;
  for (;;) {
    let page: Array<RenderGroupMsg & { rowId: bigint }>;
    try {
      page = await msgs.getGroupSeqlessAfterRowId(groupCode, cursor, pageSize);
    } catch (error) {
      if (!canSalvage(salvage, error)) throw error;
      for await (const batch of msgs.streamSalvageGroupSeqlessAfterRowId(
        groupCode,
        cursor,
        salvageStreamOptions(salvage!, groupCode, 'group'),
      )) {
        yield* batch;
      }
      return;
    }
    if (page.length === 0) break;
    for (const m of page) yield m;
    cursor = page[page.length - 1]!.rowId;
    if (page.length < pageSize) break;
  }
}

/**
 * Yield every c2c message with a peer, oldest-first, paging under the hood.
 */
export async function* iterateC2cMessages(
  msgs: MsgService,
  peerUid: string,
  opts: IterateOptions = {},
): AsyncGenerator<RenderC2cMsg> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const salvage = opts.salvage ?? msgs.salvage;
  let merged: AsyncGenerator<RenderC2cMsg> = mergeBySendTime(
    pageC2cBySeq(msgs, peerUid, pageSize, salvage),
    pageC2cBySeqlessRowId(msgs, peerUid, pageSize, salvage),
  );
  if (opts.roam) {
    merged = mergeBySendTime(merged, roamMessageStream<RenderC2cMsg>(peerUid, opts.roam));
  }
  const deduped = opts.roam ? dedupeByMsgId(merged) : merged;
  for await (const m of deduped) {
    if (withinRange(Number(m.sendTime), opts.range)) yield m;
  }
}

/** C2c seq cursor (`40003 > lastSeq`): all messages that carry a real seq. */
async function* pageC2cBySeq(
  msgs: MsgService,
  peerUid: string,
  pageSize: number,
  salvage?: SalvageSourceOptions,
): AsyncGenerator<RenderC2cMsg> {
  let cursor = 0n;
  for (;;) {
    let page: RenderC2cMsg[];
    try {
      page = await msgs.getC2cAfter(peerUid, cursor, pageSize);
    } catch (error) {
      if (!canSalvage(salvage, error)) throw error;
      for await (const batch of msgs.streamSalvageC2cAfter(
        peerUid,
        cursor,
        salvageStreamOptions(salvage!, peerUid, 'c2c'),
      )) {
        yield* batch;
      }
      return;
    }
    if (page.length === 0) break;
    for (const m of page) yield m;
    cursor = page[page.length - 1]!.msgSeq;
    if (page.length < pageSize) break;
  }
}

/** C2c rowid cursor over seq-less rows only: the migration-imported block. */
async function* pageC2cBySeqlessRowId(
  msgs: MsgService,
  peerUid: string,
  pageSize: number,
  salvage?: SalvageSourceOptions,
): AsyncGenerator<RenderC2cMsg> {
  let cursor = 0n;
  for (;;) {
    let page: Array<RenderC2cMsg & { rowId: bigint }>;
    try {
      page = await msgs.getC2cSeqlessAfterRowId(peerUid, cursor, pageSize);
    } catch (error) {
      if (!canSalvage(salvage, error)) throw error;
      for await (const batch of msgs.streamSalvageC2cSeqlessAfterRowId(
        peerUid,
        cursor,
        salvageStreamOptions(salvage!, peerUid, 'c2c'),
      )) {
        yield* batch;
      }
      return;
    }
    if (page.length === 0) break;
    for (const m of page) yield m;
    cursor = page[page.length - 1]!.rowId;
    if (page.length < pageSize) break;
  }
}

/**
 * Yield every official account (chatType 103) message with a peer, oldest-first,
 * ARK-only filtered.
 */
export async function* iterateOfficialMessages(
  msgs: MsgService,
  peerUid: string,
  opts: IterateOptions = {},
): AsyncGenerator<RenderC2cMsg> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const merged = mergeBySendTime(
    pageC2cBySeq(msgs, peerUid, pageSize),
    pageC2cBySeqlessRowId(msgs, peerUid, pageSize),
  );
  for await (const m of merged) {
    if (!withinRange(Number(m.sendTime), opts.range)) continue;
    if (!hasArkElement(m)) continue;
    yield m;
  }
}

/**
 * Yield every service account (chatType 118) message for a given appId,
 * oldest-first, ARK-only filtered.
 */
export async function* iterateServiceMessages(
  msgs: MsgService,
  appId: string,
  opts: IterateOptions = {},
): AsyncGenerator<RenderC2cMsg> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const merged = mergeBySendTime(
    pageServiceBySeq(msgs, appId, pageSize),
    pageServiceBySeqlessRowId(msgs, appId, pageSize),
  );
  for await (const m of merged) {
    if (!withinRange(Number(m.sendTime), opts.range)) continue;
    if (!hasArkElement(m)) continue;
    yield m;
  }
}

/** Service seq cursor for service_assistant_msg_table. */
async function* pageServiceBySeq(
  msgs: MsgService,
  appId: string,
  pageSize: number,
): AsyncGenerator<RenderC2cMsg> {
  let cursor = 0n;
  for (;;) {
    const page = await msgs.getServiceAfter(appId, cursor, pageSize);
    if (page.length === 0) break;
    for (const m of page) yield m;
    cursor = page[page.length - 1]!.msgSeq;
    if (page.length < pageSize) break;
  }
}

/** Service rowid cursor over seq-less rows. */
async function* pageServiceBySeqlessRowId(
  msgs: MsgService,
  appId: string,
  pageSize: number,
): AsyncGenerator<RenderC2cMsg> {
  let cursor = 0n;
  for (;;) {
    const page = await msgs.getServiceSeqlessAfterRowId(appId, cursor, pageSize);
    if (page.length === 0) break;
    for (const m of page) yield m;
    cursor = page[page.length - 1]!.rowId;
    if (page.length < pageSize) break;
  }
}

/** Check if a message contains at least one ARK element. */
function hasArkElement(m: RenderC2cMsg | RenderGroupMsg): boolean {
  return m.elements.some((el) => 'elementType' in el && el.elementType === 'ark');
}

/** Normalize a render message into the export record (bigints → strings). */
export function toExportedMessage(m: RenderGroupMsg | RenderC2cMsg): ExportedMessage {
  return {
    msgId: m.msgId.toString(),
    msgSeq: m.msgSeq.toString(),
    sendTime: Number(m.sendTime),
    senderUin: m.senderUin.toString(),
    senderUid: m.senderUid,
    elements: m.elements,
  };
}
