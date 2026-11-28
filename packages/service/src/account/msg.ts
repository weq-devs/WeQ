import { assertQqDatabaseWriteAllowed } from '@weq/db';
/**
 * MsgService — fetch the messages of one conversation by seq cursor.
 *
 * The renderer loads a conversation as a *seq window*:
 *   - `*Latest`  → newest N (open / switch-into a conversation).
 *   - `*Before`  → the page just older than a seq (scroll up).
 *   - `*From`    → re-read everything at/after a seq (live refresh of the
 *                  currently-loaded window — picks up new tail + in-place edits).
 *
 * All return newest-first; bigint ids/seqs are serialized at the IPC boundary
 * by the caller. c2c queries resolve the peer uid to its sort number (column
 * 40027) via the session's resident `UidMap` so they hit the (40027,40003)
 * composite index; a missing mapping falls back to an unindexed uid scan.
 */

import { createHash } from 'node:crypto';
import type { AccountSession } from '@weq/account';
import { decodeBody, measureMessageWork, recordMessagePartition, recordMessageWork } from '@weq/db';
import type {
  C2cMsg,
  GroupMsg,
  BrowseCursor,
  HistoryCursor,
  C2cPartition,
  AppendMsgFields,
  C2cMsgDb,
  SeqWindow,
  SalvageStreamOptions,
  SalvageBindingOptions,
} from '@weq/db';
import {
  ProtoMsg,
  decodeElement,
  encodeElement,
  type Element,
  ElementType,
  validateComposeMessage,
  COMPOSE_ELEMENT_SPECS,
  isDatalineUid,
  DATALINE_UID_TO_DEVICE,
  compareMessageOrder,
  type ComposeKind,
  type FieldSpec,
  type MsgCacheRecord,
  decodeMsgDressColumn,
  decodeMsgCacheColumn,
  type MsgDecoration,
} from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { toRenderElements, type RenderElement } from './msg_view';
import { DeletedMsgStore } from './deleted_msgs';
import type { AntiRecallService } from './anti_recall';
import type { ExportSkippedRanges } from './export/message_source';
import {
  compileMessageFilter,
  isChatVideoAttachment,
  matchesMessageFilter,
  messageSearchText,
  messageSelectionKey,
  type MessageFilter,
} from './message_filter';
import type { GapFetchedMessage } from './gap_history';
import { elementsToText } from './export/element_text';
import { sourceStamp } from './export/resume';
import { mergeRoamingTimeline } from '../common/roaming_timeline';
import { RecordSearchIndex } from './record_search_index';

const bodyCodec = new ProtoMsg(MsgBody);
type MessageRecordKind = 'group' | 'c2c' | 'official' | 'service';
type MessageRecordTarget = { kind: MessageRecordKind; conv: string; msgId: string };

function messageBodyRevision(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * QQ's own recall/delete rewrites a message's type columns to `(1,1)`, leaving
 * the 40800 body untouched. WeQ's delete mirrors this exactly (see
 * {@link MsgService.deleteMessage}) so the DB stays byte-consistent with QQ's
 * behavior; reversibility (which rows WeQ deleted + their original 40011/40012)
 * is tracked out-of-band in a {@link DeletedMsgStore}, never in the DB.
 */
const DELETED_MSG_TYPE = 1n;
const DELETED_SUB_TYPE = 1n;

/**
 * ElementType values that render as a media thumbnail in a reply quote. A reply
 * whose stored `origElements` lacks all of these (QQ NT stores only a "[图片]"
 * text placeholder in the 40800 body) is a candidate for 40900-cache enrichment.
 */
const REPLY_MEDIA_TYPES: ReadonlySet<number> = new Set([
  ElementType.PIC,
  ElementType.VIDEO,
  ElementType.FILE,
  ElementType.MFACE,
  ElementType.PTT,
]);

/** A message carrying a reply element, tagged with its msgId for a 40900 lookup. */
interface ReplyBearer {
  msgId: bigint;
  elements: Element[];
}

export interface MessagePageOptions {
  deferReplyMedia?: boolean;
  skipUnindexed?: boolean;
}

/**
 * Input for authoring a new message. `elements` is the *raw* authored array
 * (already byte-decoded at the IPC boundary); it is validated + coerced against
 * the codec compose schemas here, so the service is the single validation point.
 */
export interface InsertMsgInput {
  /** Who the message appears to be from. */
  senderUid: string;
  senderUin: string | bigint;
  /** Authored elements (text/at/pic/face + optional leading reply). */
  elements: unknown[];
  /** Unix seconds; defaults to now. */
  sendTime?: number;
}

export interface InsertMsgResult {
  msgId: bigint;
  msgSeq: bigint;
}

/**
 * Augmented message shapes for the renderer.
 *
 * `deletedKind` marks the QQ-style `(1,1)` deleted signature and its origin:
 * `'weq'` = WeQ deleted it (in the DeletedMsgStore, restorable) → the chat
 * shows a "已删除" veil + restore button; `'qq'` = QQ's own recall / a delete
 * from another client (no store record, NOT restorable) → a "QQ删除" veil, no
 * restore. `undefined` = a live message.
 */
export type DeletedKind = 'weq' | 'qq';

/** Recall marker for a message with preserved original content. */
export interface RecallInfo {
  /** Uid that performed the recall (from the recall gray-tip; '' if unknown). */
  revokeUid: string;
  /** True = author recalled their own message; false = an admin recalled it. */
  sameSender: boolean;
  /** When the recall was intercepted (unix seconds). */
  recallTs: number;
  /** 正文来自防撤回独立副本（本地数据库快照或实时代理推送）。 */
  retained?: true;
}

/** Conversation-level `msgId → recall log entry` map (see AntiRecallService.getRecallMap). */
type RecallMap = Map<string, { revokeUid: string; senderUid: string; recallTs: number }>;

export interface RenderC2cMsg extends Omit<C2cMsg, 'elements'> {
  forwardSource?: import('./export/types').ExportedMessage['forwardSource'];
  senderName?: string;
  elements: RenderElement[];
  deletedKind?: DeletedKind;
  recall?: RecallInfo;
}
/**
 * 导出链路的损坏读取策略。不配置时不启用分块续读。
 *
 * 只有导出会用它：分页损坏后从当前游标切到分块续读，接受未读区间前由任务询问。
 * 聊天页、搜索等其它读取入口不会因此跳过数据。
 */
export interface MsgSalvageSource {
  /** 实时读取的宽容授权（含级别、账本与逐条落盘回调）。 */
  binding: SalvageBindingOptions;
  /** 每块键跨度；省略则用 native 默认值。 */
  chunk?: number;
  tableSkipped?: () => boolean;
  onUnreadable?: (error: unknown) => Promise<void>;
}

export interface RenderGroupMsg extends Omit<GroupMsg, 'elements'> {
  forwardSource?: import('./export/types').ExportedMessage['forwardSource'];
  senderName?: string;
  elements: RenderElement[];
  deletedKind?: DeletedKind;
  recall?: RecallInfo;
}

export class MsgService {
  private readonly deletionWrites = new Map<string, Promise<unknown>>();
  private readonly recordSearchIndex = new RecordSearchIndex();
  /**
   * `deleted` is the per-account {@link DeletedMsgStore}; omit it for contexts
   * that never delete (e.g. the export pipeline's private MsgService).
   *
   * `antiRecall` is the per-account {@link AntiRecallService}; when present, each
   * fetched page is tagged with `recall` for messages the trigger recorded in
   * `weq_recall_log`. Omit it for contexts with no anti-recall (export pipeline).
   *
   * `salvage` 是账号级的损坏宽容授权（可选）。它挂在消息服务上，而不是让每个导出
   * 入口各传一个参数：导出有 6 种格式、4 类会话、好几层中间模块（媒体扫描 / 昵称解析），
   * 把同一个授权对象穿过每一层只会让签名越来越长，且每新增一个格式都得记得传一次。
   * 语义仍然是"不配置就没有"—— 不传时导出与以前逐字节相同。
   */
  /**
   * 本次导出累计的「跳过区间」账目（按会话）。
   *
   * 容错续读的回调只覆盖它自己那一次读；而"这次导出到底少了哪一段"是**任务级**的
   * 问题，所以四类续读都顺手往这里记一份，由导出任务在消息阶段结束时取走
   * （见 {@link takeSalvageSkips}）。只记不写盘：落盘那份由账号级账本负责。
   */
  private readonly salvageSkips: ExportSkippedRanges[] = [];
  /** 特殊消息源可提供自己的稳定遍历；过滤、时间范围与取消仍由通用导出迭代器处理。 */
  exportC2cMessages?: (peerUid: string, pageSize: number) => AsyncGenerator<RenderC2cMsg>;
  exportJournal?: import('./export/message_journal').MessageJournal;
  exportFetchForward?: (resId: string) => Promise<import('./forward').FetchedForwardRecord[]>;

  constructor(
    private readonly session: AccountSession,
    private readonly deleted?: DeletedMsgStore,
    private readonly antiRecall?: AntiRecallService,
    readonly salvage?: MsgSalvageSource,
    readonly exportFilter?: MessageFilter,
    readonly exportSignal?: AbortSignal,
  ) {}

  withExportFilter(
    filter?: MessageFilter,
    signal?: AbortSignal,
    salvage = this.salvage,
  ): MsgService {
    return new MsgService(this.session, this.deleted, this.antiRecall, salvage, filter, signal);
  }

  exportDatabasePath(kind: 'group' | 'c2c', conv: string): string {
    return kind === 'group' ? this.session.groupMsgs.sourcePath : this.c2cDbFor(conv).sourcePath;
  }

  exportSourceStamp(kind: 'group' | 'c2c' | 'official' | 'service', conv: string): string {
    return sourceStamp(
      kind === 'group'
        ? this.session.groupMsgs.sourcePath
        : kind === 'service'
          ? this.session.serviceAssistantMsgs.sourcePath
          : this.c2cDbFor(conv).sourcePath,
    );
  }
  private privateRecordDatabase(kind: MessageRecordKind, conv: string) {
    return kind === 'service'
      ? { db: this.session.serviceAssistantMsgs, partition: { appId: BigInt(conv) } }
      : { db: this.c2cDbFor(conv), partition: this.c2cPartition(conv) };
  }

  private async findMessageRecord({ kind, conv, msgId }: MessageRecordTarget, full = true) {
    if (kind === 'group') {
      const db = this.session.groupMsgs;
      const [row] = await db.exportSourceRows(conv, [msgId], full);
      return row ? { db, row } : null;
    }
    const { db, partition } = this.privateRecordDatabase(kind, conv);
    const [row] = await db.exportSourceRows(partition, [msgId], full);
    return row ? { db, row } : null;
  }

  recordedGroupSenderNames(conv: string, ids: readonly string[]) {
    return this.session.groupMsgs.recordedSenderNames(conv, ids);
  }

  get groupSenderNamesPending() {
    return this.session.groupMsgs.senderNamesPending;
  }

  async groupSenderNames(filter: Parameters<AccountSession['groupMsgs']['senderNames']>[0]) {
    const rows = await this.session.groupMsgs.senderNames(filter);
    if (!rows.length) return [];
    const codes = [...new Set(rows.map((row) => row.groupCode))];
    const groups = await this.session.groupDetail.detailsByGroupCodes(codes.map(BigInt));
    const names = new Map(
      groups.map((group) => [String(group.groupCode), group.groupName || group.remark]),
    );
    return rows.map((row) => ({ ...row, groupName: names.get(row.groupCode) || row.groupCode }));
  }

  async messageRecordDetails(target: MessageRecordTarget) {
    const found = await this.findMessageRecord(target);
    if (!found) return null;
    const { columns, table, rowId, message } = found.row;
    const body = columns['40800'];
    return {
      table,
      rowId,
      columns,
      elements: message.elements,
      decoration: message.decoration,
      reactions: 'setEmojiList' in message ? message.setEmojiList : undefined,
      cache: decodeMsgCacheColumn(columns['40900']),
      revision: body instanceof Uint8Array ? messageBodyRevision(body) : null,
    };
  }

  async editMessageRecord(
    target: MessageRecordTarget,
    revision: string,
    elements: Element[],
    beforeWrite: () => void,
  ) {
    const found = await this.findMessageRecord(target, false);
    const before = found?.row.columns['40800'];
    if (!found || !(before instanceof Uint8Array) || messageBodyRevision(before) !== revision)
      return null;
    const body = bodyCodec.encode({ elements: elements.map(encodeElement) });
    beforeWrite();
    const count = await found.db.updateMsgBody(BigInt(target.msgId), body, {
      body: before,
      rowId: BigInt(found.row.rowId),
    });
    if (!count) return null;
    return toRenderElements(elements);
  }

  async exportSourceRows(
    kind: MessageRecordKind,
    conversation: string,
    ids: readonly string[],
    full = true,
  ) {
    const enrich = (message: GroupMsg | C2cMsg, columns: Record<string, unknown>) => {
      const cache = decodeMsgCacheColumn(columns['40900']);
      const quoted = cache.length === 1 ? cache[0] : undefined;
      const elements = (quoted as { elements?: unknown[] } | undefined)?.elements;
      const offsets: Record<number, number> = {};
      const metadata: Record<string, string | number | null> = {};
      if (quoted)
        for (const field of ['msgId', 'msgSeq', 'senderUin', 'senderUid', 'sendNick', 'sendTime']) {
          const value = (quoted as unknown as Record<string, unknown>)[field];
          if (value !== undefined) metadata[field] = String(value);
        }
      if (Array.isArray(elements) && elements.length)
        for (const [index, element] of message.elements.entries()) {
          if (element.kind !== 'reply') continue;
          const reply = element as ReplyLike;
          const previous = Array.isArray(reply.origElements) ? reply.origElements : [];
          offsets[index] = previous.length;
          reply.origElements = [...previous, ...elements];
        }
      return { offsets, metadata, count: elements?.length ?? 0 };
    };
    const metadataFor = (
      message: RenderGroupMsg | RenderC2cMsg,
      details: ReturnType<typeof enrich>,
    ) => {
      for (const [index, offset] of Object.entries(details.offsets)) {
        const element = message.elements[Number(index)];
        if (element?.type === 'reply')
          element.data.exportQuoteCache = {
            ...details.metadata,
            elementOffset: offset,
            elementCount: details.count,
          };
      }
      return message;
    };
    if (kind === 'group')
      return (await this.session.groupMsgs.exportSourceRows(conversation, ids, full)).map(
        (source) => {
          const details = enrich(source.message, source.columns);
          return {
            ...source,
            quoteCacheOffsets: details.offsets,
            message: metadataFor(this.renderGroupWithState(source.message), details),
          };
        },
      );
    const { db, partition } = this.privateRecordDatabase(kind, conversation);
    return (await db.exportSourceRows(partition, ids, full)).map((source) => {
      const details = enrich(source.message, source.columns);
      return {
        ...source,
        quoteCacheOffsets: details.offsets,
        message: metadataFor(this.renderC2cWithState(source.message), details),
      };
    });
  }

  async browse(
    kind: 'group' | 'c2c',
    conv: string,
    filter: MessageFilter & { start?: number; end?: number },
    cursor?: { time: number; rowId: string },
    limit = 30,
  ) {
    const items: Array<RenderGroupMsg | RenderC2cMsg> = [];
    let scanned = 0;
    let next = cursor;
    let hasMore = true;
    const recalls = await this.recallMapFor(kind, conv);
    const keyword = filter.keyword?.toLocaleLowerCase();
    const matches = compileMessageFilter({ ...filter, keyword: undefined });
    let scannedTime: number | undefined;
    while (items.length < limit && scanned < 5000) {
      const page =
        kind === 'group'
          ? await this.session.groupMsgs.browseRows(conv, filter, next)
          : await this.c2cDbFor(conv).browseRows(this.c2cPartition(conv), filter, next);
      if (!page.length) {
        hasMore = false;
        break;
      }
      for (const row of page) {
        scanned++;
        const time = Number(row.time);
        if (time > 0) scannedTime = time;
        next = { time, rowId: row.rowId };
        if (keyword && !row.body) continue;
        const key = `${kind}:${conv}:${row.rowId}`;
        const indexed = keyword ? this.recordSearchIndex.get(key, row.body) : undefined;
        if (keyword && indexed !== undefined && !indexed.includes(keyword)) continue;
        const rendered =
          kind === 'group'
            ? this.renderGroupWithState(row.decode() as GroupMsg, recalls)
            : this.renderC2cWithState(row.decode() as C2cMsg, recalls);
        if (!matches(rendered)) continue;
        if (keyword && indexed === undefined) {
          const text = messageSearchText(rendered.elements);
          this.recordSearchIndex.set(key, row.body, text);
          if (!text.includes(keyword)) continue;
        }
        items.push(rendered);
        if (items.length === limit) break;
      }
      if (items.length === limit) break;
      if (page.length < 500) {
        hasMore = false;
        break;
      }
    }
    const profiles = await this.session.profileInfo
      .profilesByUids([...new Set(items.map((m) => m.senderUid))])
      .catch(() => []);
    const names = new Map(profiles.map((p) => [p.uid, p.remark || p.nick]));
    return {
      items: items.map((m) => ({
        ...m,
        senderName: names.get(m.senderUid) || String(m.senderUin),
        content: elementsToText(m.elements),
      })),
      cursor: hasMore ? next : null,
      scannedTime,
      scanned,
      hasMore,
    };
  }

  /** 本地表与离线漫游缓存各读一个有界批次，先合并原始窗口再筛媒体。 */
  async mediaPage(
    kind: 'group' | 'c2c',
    conv: string,
    filter: MessageFilter & { start?: number; end?: number },
    direction: 'older' | 'newer',
    anchorMsgId: string,
    cursor?: { msgSeq: string; sendTime: string; msgId: string },
    anchorTime?: number,
    anchorSeq?: string,
    readCached?: (
      cursor: { msgSeq: number; sendTime: number; msgId: string },
      descending: boolean,
    ) => Promise<GapFetchedMessage[]>,
  ) {
    let position = cursor;
    if (!position) {
      const source = (await this.exportSourceRows(kind, conv, [anchorMsgId], false))[0];
      if (!source && (anchorTime === undefined || anchorSeq === undefined))
        throw new Error('预览起点消息已不可用，请重新打开');
      position = {
        msgSeq: source ? String(source.columns['40003'] ?? 0) : anchorSeq!,
        sendTime: source ? String(source.columns['40050'] ?? 0) : String(anchorTime),
        msgId: anchorMsgId,
      };
    }
    const descending = direction === 'older';
    const [rows, cached] = await Promise.all([
      this.getHistoryPage(kind, conv, {
        cursor: {
          msgSeq: BigInt(position.msgSeq),
          sendTime: BigInt(position.sendTime),
          msgId: BigInt(position.msgId),
        },
        min: 0n,
        max: 0x7fffffffffffffffn,
        descending,
        limit: 300,
      }),
      readCached?.(
        {
          msgSeq: Number(position.msgSeq),
          sendTime: Number(position.sendTime),
          msgId: position.msgId,
        },
        descending,
      ) ?? [],
    ]);
    const normalize = (
      row: RenderGroupMsg | RenderC2cMsg | GapFetchedMessage,
      source?: 'roaming',
    ) => ({
      kind,
      conv,
      msgId: String(row.msgId),
      msgSeq: String(row.msgSeq),
      sendTime: String(row.sendTime),
      msgRandom: String(row.msgRandom ?? '0'),
      senderUid: row.senderUid,
      senderUin: String(row.senderUin),
      elements: row.elements,
      source,
      sourceFormat: 'sourceFormat' in row ? row.sourceFormat : undefined,
      localSent: 'localSent' in row ? row.localSent : undefined,
      ntSeqVerified: 'ntSeqVerified' in row ? row.ntSeqVerified : undefined,
      recall: row.recall,
      deletedKind: 'deletedKind' in row ? row.deletedKind : undefined,
    });
    const merged = mergeRoamingTimeline(
      kind,
      rows.map((row) => normalize(row)),
      cached.map((row) => normalize(row, 'roaming')),
    );
    if (descending) merged.reverse();
    const window = merged.slice(0, 300);
    const hidden = new Set(this.getHiddenDeletedMsgIds(kind, conv));
    const items = window.filter(
      (message) =>
        !hidden.has(String(message.msgId)) &&
        matchesMessageFilter(message, filter) &&
        (filter.start === undefined || Number(message.sendTime) >= filter.start) &&
        (filter.end === undefined || Number(message.sendTime) <= filter.end) &&
        message.elements.some(
          (element) =>
            element.type === 'video' ||
            isChatVideoAttachment(element) ||
            (element.type === 'pic' &&
              element.data?.subType !== 1 &&
              !element.data?.isFlash &&
              !String(element.data?.fileToken ?? '').startsWith('/')),
        ),
    );
    const last = window.at(-1);
    return {
      items,
      cursor: last ? { msgSeq: last.msgSeq, sendTime: last.sendTime, msgId: last.msgId } : position,
      hasMore: rows.length === 300 || cached.length === 300 || merged.length > 300,
    };
  }

  /**
   * 取走并清空累计的跳过区间（导出任务在消息阶段结束后调用）。
   *
   * "取走"而不是"读"：一次导出的账目不该串到下一次任务里，尤其是同一个 MsgService
   * 会被整个账号的导出共用。
   */
  takeSalvageSkips(): ExportSkippedRanges[] {
    return this.salvageSkips.splice(0, this.salvageSkips.length);
  }

  /**
   * 在调用方给的 `onSkipped` 之外，再往本服务上记一份（见 {@link salvageSkips}）。
   */
  private withRecordedSkips(
    conv: string,
    kind: 'group' | 'c2c',
    opts: SalvageStreamOptions,
  ): SalvageStreamOptions {
    const outer = opts.onSkipped;
    return {
      ...opts,
      onSkipped: (ranges, span) => {
        this.salvageSkips.push({ conv, kind, ranges, span });
        outer?.(ranges, span);
      },
    };
  }

  /**
   * Classify a message's deleted state from its raw type columns. A `(1,1)`
   * signature (see {@link DELETED_MSG_TYPE}) means deleted; the DeletedMsgStore
   * then tells WeQ-deleted (restorable) apart from a QQ-native recall (not).
   * `undefined` when the columns weren't selected or the message is live.
   */
  private classifyDeleted(m: {
    msgId: bigint;
    msgType?: bigint;
    subType?: bigint;
  }): DeletedKind | undefined {
    if (m.msgType !== DELETED_MSG_TYPE || m.subType !== DELETED_SUB_TYPE) return undefined;
    return this.deleted?.get(m.msgId.toString()) ? 'weq' : 'qq';
  }

  /**
   * Resolve a message's recall marker from a conversation-level recall map
   * (msgId → log entry). `undefined` when this message wasn't recalled.
   * `sameSender` distinguishes a self-recall from an admin recalling someone else.
   */
  private classifyRecall(m: { msgId: bigint }, recallMap?: RecallMap): RecallInfo | undefined {
    const r = recallMap?.get(m.msgId.toString());
    if (!r) return undefined;
    return {
      revokeUid: r.revokeUid,
      sameSender: r.revokeUid !== '' && r.revokeUid === r.senderUid,
      recallTs: r.recallTs,
    };
  }

  /** Fetch the conversation's recall map once (empty when anti-recall is off). */
  private async recallMapFor(
    kind: 'c2c' | 'group',
    conv: string,
    rows?: readonly { msgId: bigint }[],
  ): Promise<RecallMap | undefined> {
    return this.antiRecall?.getRecallMap(
      kind,
      conv,
      rows?.map((row) => row.msgId),
    );
  }

  /** {@link renderC2c} plus the computed deleted/recall state. */
  private renderC2cWithState(m: C2cMsg, recallMap?: RecallMap): RenderC2cMsg {
    return {
      ...renderC2c(m),
      deletedKind: this.classifyDeleted(m),
      recall: this.classifyRecall(m, recallMap),
    };
  }

  /** {@link renderGroup} plus the computed deleted/recall state. */
  private renderGroupWithState(m: GroupMsg, recallMap?: RecallMap): RenderGroupMsg {
    return {
      ...renderGroup(m),
      deletedKind: this.classifyDeleted(m),
      recall: this.classifyRecall(m, recallMap),
    };
  }

  // ---- compose / insert ----------------------------------------------------

  /**
   * Field descriptors for each authorable element kind, derived from the codec
   * Zod schemas. The frontend builds its compose form from this — no parallel
   * interface to keep in sync.
   */
  getComposeSpecs(): Record<ComposeKind, FieldSpec[]> {
    return COMPOSE_ELEMENT_SPECS;
  }

  /** Insert a new private-chat message with `peerUid`. */
  async insertC2cMessage(peerUid: string, input: InsertMsgInput): Promise<InsertMsgResult | null> {
    const fields = this.buildAppendFields(input);
    return this.c2cDbFor(peerUid).appendMessage(this.c2cPartition(peerUid), fields);
  }

  /** Insert a new group message into `targetGroupCode`. */
  async insertGroupMessage(
    targetGroupCode: string,
    input: InsertMsgInput,
  ): Promise<InsertMsgResult | null> {
    const fields = this.buildAppendFields(input);
    return this.session.groupMsgs.appendMessage(targetGroupCode, fields);
  }

  /**
   * Validate the authored elements, derive msgType, encode the 40800 body, and
   * assemble the column overrides shared by c2c/group append. Throws on invalid
   * input so the caller surfaces the reason.
   */
  private buildAppendFields(input: InsertMsgInput): AppendMsgFields {
    const parsed = validateComposeMessage(input.elements);
    if (!parsed.ok) throw new Error(parsed.error);

    const body = bodyCodec.encode({ elements: parsed.elements.map(encodeElement) });
    const sendTime = BigInt(input.sendTime ?? Math.floor(Date.now() / 1000));

    return {
      senderUid: input.senderUid,
      senderUin: BigInt(input.senderUin),
      msgType: parsed.msgType,
      sendTime,
      dayTimestamp: localMidnight(sendTime),
      body,
    };
  }

  // ---- raw / modify --------------------------------------------------------

  /** Online voice recognition supports messages from ordinary private and group chats. */
  async getChatMessageForVoice(msgId: bigint): Promise<RenderC2cMsg | RenderGroupMsg | null> {
    const [privateRows, groupRows] = await Promise.all([
      this.session.c2cMsgs.listByMsgIds([msgId]),
      this.session.groupMsgs.listByMsgIds([msgId]),
    ]);
    if (privateRows[0]) return renderC2c(privateRows[0]);
    return groupRows[0] ? renderGroup(groupRows[0]) : null;
  }

  /**
   * Get all raw elements of a message by msgId (not filtered by renderer).
   * Searches C2C-shaped tables (c2c / dataline / service assistant) and Group.
   */
  async getRawElements(
    msgId: bigint,
  ): Promise<{ elements: Element[]; kind: 'c2c' | 'group' } | null> {
    // c2c / dataline / 服务号(118) 三张表都是 C2cMsgDb（同一 wire shape），
    // 服务号消息物理存在 service_assistant_msg_table，漏查会导致「服务号 ARK
    // 消息右键修改」永远 getRawElements 返回 null（编辑框打不开）。
    for (const db of [
      this.session.c2cMsgs,
      this.session.datalineMsgs,
      this.session.serviceAssistantMsgs,
    ] as const) {
      const blob = await db.getMsgBody(msgId);
      if (blob) return { elements: decodeBody(blob), kind: 'c2c' };
    }

    const groupBlob = await this.session.groupMsgs.getMsgBody(msgId);
    if (groupBlob) {
      return { elements: decodeBody(groupBlob), kind: 'group' };
    }

    return null;
  }

  /**
   * Fetch one private-chat / dataline message by msgId, fully rendered (reply
   * media enriched, deleted/recall state attached). The msgId is globally
   * unique, so this narrows to whichever table `targetUid` maps to; returns
   * null when no row holds that id.
   */
  async getC2cMessageById(targetUid: string, msgId: bigint): Promise<RenderC2cMsg | null> {
    const rows = await this.c2cDbFor(targetUid).listByMsgIds([msgId]);
    const m = rows[0];
    if (!m) return null;
    await this.enrichReplyMedia([m], 'c2c');
    const recallMap = await this.recallMapFor('c2c', targetUid, [m]);
    return this.renderC2cWithState(m, recallMap);
  }

  /** Fetch one group message by msgId, rendered the same way as a chat page. */
  async getGroupMessageById(
    targetGroupCode: string,
    msgId: bigint,
  ): Promise<RenderGroupMsg | null> {
    const rows = await this.session.groupMsgs.listByMsgIds([msgId]);
    const m = rows[0];
    if (!m) return null;
    await this.enrichReplyMedia([m], 'group');
    const recallMap = await this.recallMapFor('group', targetGroupCode, [m]);
    return this.renderGroupWithState(m, recallMap);
  }

  /**
   * Update the elements of a message by msgId.
   */
  async updateElements(msgId: bigint, elements: Element[]): Promise<boolean> {
    const info = await this.getRawElements(msgId);
    if (!info) return false;

    const blob = bodyCodec.encode({
      elements: elements.map(encodeElement),
    });

    if (info.kind === 'group') {
      return (await this.session.groupMsgs.updateMsgBody(msgId, blob)) > 0;
    }

    // kind 'c2c' 只告诉我们「不是群消息」，具体是 c2c / dataline / 服务号三张表
    // 里的哪一张要靠 msgId 命中哪张才知道——写回也得挨个试，只在 getRawElements()
    // 里判断来源、却在这里无条件写 c2cMsgs 会让 dataline/服务号消息的编辑静默
    // 不生效（UPDATE 命中 0 行）。msgId 全局唯一，只有真正持有该行的表会写入成功。
    for (const db of [
      this.session.c2cMsgs,
      this.session.datalineMsgs,
      this.session.serviceAssistantMsgs,
    ] as const) {
      const affected = await db.updateMsgBody(msgId, blob);
      if (affected > 0) return true;
    }

    return false;
  }

  /**
   * Write a voice transcript back onto the message's ptt element (wire tag
   * 45923) — the same field QQ's own 「转文字」fills in, so QQ reads it too and
   * a re-export skips the clip.
   *
   * `fileName` picks the ptt element when a message carries several. Returns
   * false when the row / element isn't found, or when the value is unchanged.
   */
  async setPttTranscript(
    msgId: bigint,
    fileName: string,
    text: string,
    options: { ifEmpty?: boolean; current?: () => boolean } = {},
  ): Promise<boolean> {
    for (const db of [
      this.session.c2cMsgs,
      this.session.datalineMsgs,
      this.session.groupMsgs,
    ] as const) {
      const blob = await db.getMsgBody(msgId);
      if (!blob) continue;
      const elements = decodeBody(blob);
      const ptt = elements.find(
        (el): el is Extract<Element, { kind: 'ptt' }> =>
          el.kind === 'ptt' && (!fileName || el.fileName === fileName),
      );
      if (!ptt || ptt.pttTranscript === text || (options.ifEmpty && ptt.pttTranscript))
        return false;
      ptt.pttTranscript = text;
      // QQ 写转录结果时同时置这两个 flag（参考行 c2c 7669105866341663773，全库
      // 观测到 45924 恒 1 / 45926 恒 2）。它们是 QQ 判断「这条已经转过文字了」的
      // 依据 —— 只写 45923 的话 QQ 本体不认，还会再转一次。
      ptt.pttFlag45924 = 1;
      ptt.pttFlag45926 = 2;
      if (options.current && !options.current()) return false;
      const affected = await db.replaceMsgBody(
        msgId,
        blob,
        bodyCodec.encode({ elements: elements.map(encodeElement) }),
      );
      return affected > 0;
    }
    return false;
  }

  async getSentVoiceRows(kind: 'c2c' | 'group', conv: string, seq: bigint) {
    if (kind === 'group') {
      return (await this.session.groupMsgs.listBySeqsInPartition(conv, [seq])).map(renderGroup);
    }
    return (
      await this.c2cDbFor(conv).listBySeqsInPartition(await this.c2cPagePartition(conv), [seq])
    ).map(renderC2c);
  }

  /**
   * Read the decoration data (column 40801) for a message: bubble skin,
   * chat-font skin, and widget itemIds. Searches c2c → dataline → group.
   * Returns null when the column is absent, empty, or all ids are 0.
   */
  async getMsgDecoration(msgId: bigint): Promise<MsgDecoration | null> {
    for (const db of [
      this.session.c2cMsgs,
      this.session.datalineMsgs,
      this.session.groupMsgs,
    ] as const) {
      const blob = await db.getMsgDressBlob(msgId);
      if (!blob) continue;
      return decodeMsgDressColumn(blob);
    }
    return null;
  }

  /**
   * Delete a message the way QQ itself does: rewrite the type columns
   * 40011/40012 to `(1,1)` in place (verified against a live QQ delete — those
   * are the ONLY two columns QQ touches; the 40800 body stays intact). The row
   * never leaves its conversation partition, so it still renders in the chat —
   * the frontend shows it under a translucent "deleted" overlay.
   *
   * Reversibility lives in the {@link DeletedMsgStore}: the original 40011/40012
   * are remembered there per msgId (they vary by message kind — plain text is
   * 2/16, replies 9/…), which is also what distinguishes WeQ deletes from QQ's
   * own recalls (both are `(1,1)` in the DB). 恢复存储不可用时拒绝删除，不降级成不可恢复操作。
   *
   * Searches c2c → dataline → group and acts on whichever holds the row.
   * Returns true if a row was rewritten.
   */
  async deleteMessage(
    msgId: bigint,
    kind: 'c2c' | 'group',
    conv: string,
    hidden = false,
  ): Promise<boolean> {
    return this.serializeDeletion(msgId, () => this.deleteMessageNow(msgId, kind, conv, hidden));
  }

  private async serializeDeletion<T>(msgId: bigint, write: () => Promise<T>): Promise<T> {
    const key = msgId.toString();
    const previous = this.deletionWrites.get(key) ?? Promise.resolve();
    // 前一次失败不能阻止后续重试或恢复。
    const pending = previous.catch(() => {}).then(write);
    this.deletionWrites.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.deletionWrites.get(key) === pending) this.deletionWrites.delete(key);
    }
  }

  private async deleteMessageNow(
    msgId: bigint,
    kind: 'c2c' | 'group',
    conv: string,
    hidden: boolean,
  ): Promise<boolean> {
    if (!this.deleted) throw new Error('删除恢复记录不可用，已阻止修改消息。');
    const previous = this.deleted.get(msgId.toString());
    if (
      previous &&
      (previous.source === 'sent-cache' || previous.kind !== kind || previous.conv !== conv)
    )
      return false;
    for (const db of [
      this.session.c2cMsgs,
      this.session.datalineMsgs,
      this.session.groupMsgs,
    ] as const) {
      const orig = await db.readMsgType(msgId);
      if (!orig) continue;
      // await 期间可能已有同消息删除完成，不能用 (1,1) 覆盖首次保存的原始类型。
      const current = this.deleted.get(msgId.toString());
      if (
        current &&
        (current.source === 'sent-cache' || current.kind !== kind || current.conv !== conv)
      )
        return false;
      this.deleted.add(msgId.toString(), {
        origMsgType: current?.origMsgType ?? orig.msgType.toString(),
        origSubType: current?.origSubType ?? orig.subType.toString(),
        kind,
        conv,
        deletedAt: current?.deletedAt ?? Math.floor(Date.now() / 1000),
        hidden,
      });
      return (await db.writeMsgType(msgId, DELETED_MSG_TYPE, DELETED_SUB_TYPE)) > 0;
    }
    return false;
  }

  /**
   * Reverse a {@link deleteMessage}: write the remembered original 40011/40012
   * back and drop the store record. No-op (false) for messages WeQ never
   * deleted — including QQ's own recalls, which have no store record.
   */
  async restoreMessage(msgId: bigint): Promise<boolean> {
    return this.serializeDeletion(msgId, () => this.restoreMessageNow(msgId));
  }

  private async restoreMessageNow(msgId: bigint): Promise<boolean> {
    const rec = this.deleted?.get(msgId.toString());
    if (!rec || rec.source === 'sent-cache') return false;
    for (const db of [
      this.session.c2cMsgs,
      this.session.datalineMsgs,
      this.session.groupMsgs,
    ] as const) {
      const cur = await db.readMsgType(msgId);
      if (!cur) continue;
      const n = await db.writeMsgType(msgId, BigInt(rec.origMsgType), BigInt(rec.origSubType));
      if (n > 0) this.deleted?.remove(msgId.toString());
      return n > 0;
    }
    return false;
  }

  /**
   * List the deleted messages of one conversation, newest-first, rendered like
   * a normal page so the UI can reuse its chat bubbles. Scans EVERY `(1,1)` row
   * in the conversation (see `listDeletedByConv`) — so it surfaces both WeQ's
   * own deletes AND QQ-native recalls the store never recorded — then tags each
   * with `deletedKind` ('weq' restorable vs 'qq' not) via {@link classifyDeleted}.
   */
  async getDeletedMessages(
    kind: 'c2c' | 'group',
    conv: string,
  ): Promise<RenderC2cMsg[] | RenderGroupMsg[]> {
    const recallMap = await this.recallMapFor(kind, conv);
    if (kind === 'group') {
      const msgs = await this.session.groupMsgs.listDeletedByConv(conv);
      await this.enrichReplyMedia(msgs, 'group');
      return msgs.map((m) => this.renderGroupWithState(m, recallMap));
    }
    const msgs = await this.c2cDbFor(conv).listDeletedByConv(conv);
    await this.enrichReplyMedia(msgs, 'c2c');
    return msgs.map((m) => this.renderC2cWithState(m, recallMap));
  }

  async listDeletedRefs(
    kind: 'c2c' | 'group',
    conv: string,
    limit: number,
    before?: { time: number; id?: string },
  ) {
    if (kind === 'group') return this.session.groupMsgs.listDeletedRefs(conv, limit, before);
    return this.c2cDbFor(conv).listDeletedRefs(await this.c2cPagePartition(conv), limit, before);
  }

  async listRecallRefs(
    kind: 'c2c' | 'group',
    conv: string,
    limit?: number,
    before?: { time: number; id?: string },
  ) {
    const tableKind = kind === 'c2c' && isDatalineUid(conv) ? 'dataline' : kind;
    return (await this.antiRecall?.listRecallRefs(tableKind, conv, limit, before)) ?? [];
  }

  async readHistoryRecordBodies(
    kind: 'c2c' | 'group',
    conv: string,
    ids: bigint[],
  ): Promise<RenderC2cMsg[] | RenderGroupMsg[]> {
    if (!ids.length) return [];
    const recalls = this.antiRecall?.getRecallMap(kind, conv, ids);
    if (kind === 'group') {
      const [rows, recallMap] = await Promise.all([
        this.session.groupMsgs.listByMsgIds(ids),
        recalls,
      ]);
      return rows.map((row) => this.renderGroupWithState(row, recallMap));
    }
    const [rows, recallMap] = await Promise.all([this.c2cDbFor(conv).listByMsgIds(ids), recalls]);
    return rows.map((row) => this.renderC2cWithState(row, recallMap));
  }

  /**
   * The msgIds WeQ deleted in one conversation — the lightweight signal the
   * chat view uses to draw the translucent "deleted" overlay over in-place
   * rows without fetching their content again.
   */
  getDeletedMsgIds(kind: 'c2c' | 'group', conv: string): string[] {
    return this.deleted?.listIds(kind, conv) ?? [];
  }

  getHiddenDeletedMsgIds(kind: 'c2c' | 'group', conv: string): string[] {
    return this.deleted?.listHiddenIds(kind, conv) ?? [];
  }

  /** 漫游来源仅标记 WeQ 缓存，绝不将缓存身份送入 QQ 原库。 */
  deleteCachedSentMessage(message: GapFetchedMessage, hidden = false): boolean {
    assertQqDatabaseWriteAllowed();
    if (
      !this.deleted ||
      !/^[1-9]\d*$/.test(message.msgSeq) ||
      BigInt(message.msgSeq) > 0xffffffffn ||
      !/^-?\d{1,20}$/.test(message.msgId) ||
      (message.kind === 'c2c' && !message.ntSeqVerified)
    )
      return false;
    const messageId = messageSelectionKey({ ...message, source: 'roaming' })!;
    this.deleted.add(DeletedMsgStore.cachedKey(message.kind, message.conv, messageId), {
      source: 'sent-cache',
      messageId,
      kind: message.kind,
      conv: message.conv,
      deletedAt: Math.floor(Date.now() / 1000),
      hidden,
    });
    return true;
  }

  restoreCachedSentMessage(messageId: string, kind: 'c2c' | 'group', conv: string): boolean {
    assertQqDatabaseWriteAllowed();
    const match = /^roaming:(?:(?:native|protocol):)?([1-9]\d*):(-?\d+)$/.exec(messageId);
    if (!match || !this.deleted) return false;
    let restored = false;
    for (const format of ['', 'native:', 'protocol:']) {
      const key = DeletedMsgStore.cachedKey(kind, conv, `roaming:${format}${match[1]}:${match[2]}`);
      if (this.deleted.get(key)?.source !== 'sent-cache') continue;
      this.deleted.remove(key);
      restored = true;
    }
    return restored;
  }

  /**
   * The recalled messages of one conversation, newest-recall-first, rendered
   * like a normal page so the "撤回列表" panel can reuse the chat bubbles.
   *
   * Unlike deletes, a recalled message's original row is untouched on disk (the
   * trigger cancelled QQ's recall in place) — so we read the recall log for the
   * msgIds + who/when, then fetch those original rows by id and re-order them to
   * match the log's newest-first order (listByMsgIds sorts by seq, not recall
   * time). Each row is tagged with its `recall` marker.
   */
  async getRecalledMessages(
    kind: 'c2c' | 'group',
    conv: string,
  ): Promise<RenderC2cMsg[] | RenderGroupMsg[]> {
    const recallMap = await this.recallMapFor(kind, conv);
    if (!recallMap || recallMap.size === 0) return [];
    const ids = [...recallMap.keys()];
    const idBigints = ids.map((id) => BigInt(id));

    if (kind === 'group') {
      const rows = await this.session.groupMsgs.listByMsgIds(idBigints);
      await this.enrichReplyMedia(rows, 'group');
      const byId = new Map(rows.map((m) => [m.msgId.toString(), m]));
      return ids
        .map((id) => byId.get(id))
        .filter((m): m is GroupMsg => m !== undefined)
        .map((m) => this.renderGroupWithState(m, recallMap));
    }
    const rows = await this.c2cDbFor(conv).listByMsgIds(idBigints);
    await this.enrichReplyMedia(rows, 'c2c');
    const byId = new Map(rows.map((m) => [m.msgId.toString(), m]));
    return ids
      .map((id) => byId.get(id))
      .filter((m): m is C2cMsg => m !== undefined)
      .map((m) => this.renderC2cWithState(m, recallMap));
  }

  /** Newest N private-chat messages with one peer. */
  async getC2cLatest(
    targetUid: string,
    limit = 50,
    options: MessagePageOptions = {},
  ): Promise<RenderC2cMsg[]> {
    return measureMessageWork(this.session.msgDbPath, 'messagePage', async () => {
      const msgs = await this.c2cDbFor(targetUid).listLatest(
        await this.c2cPagePartition(targetUid, options),
        limit,
      );
      if (!options.deferReplyMedia) await this.enrichReplyMedia(msgs, 'c2c');
      const recallMap = await this.recallMapFor('c2c', targetUid, msgs);
      return msgs.map((m) => this.renderC2cWithState(m, recallMap));
    });
  }

  resolveC2cReplySeq(
    conv: string,
    clientSeq: bigint,
    senderUin?: bigint,
    sendTime?: bigint,
  ): Promise<bigint | null | undefined> {
    return this.c2cDbFor(conv).resolveReplySeq(
      this.c2cPartition(conv),
      clientSeq,
      senderUin,
      sendTime,
    );
  }

  /** Resolve a reply to a local row, never to its embedded quote snapshot. */
  async resolveLocalReplyOriginal(
    kind: 'group' | 'c2c',
    conv: string,
    replyMsgId: bigint,
    quote: Extract<RenderElement, { type: 'reply' }>['data'],
  ) {
    const positive = (value: number) =>
      Number.isSafeInteger(value) && value > 0 ? BigInt(value) : undefined;
    const replySeq = positive(quote.origMsgSeq);
    const senderUin = positive(quote.origSenderUin);
    const sendTime = positive(quote.origMsgTime);
    let rows: (GroupMsg | C2cMsg)[];
    if (kind === 'group') {
      if (!replySeq) return;
      rows = await this.session.groupMsgs.listBySeqsInPartition(conv, [replySeq]);
    } else {
      const db = this.c2cDbFor(conv);
      const partition = this.c2cPartition(conv);
      let seq = positive(quote.origMsgIndex);
      if (!seq && replySeq && (senderUin || sendTime)) {
        seq = (await db.resolveReplySeq(partition, replySeq, senderUin, sendTime)) ?? undefined;
      }
      if (!seq) return;
      rows = await db.listBySeqsInPartition(partition, [seq]);
    }
    const matches = rows.filter(
      (row) =>
        ('targetGroupCode' in row ? row.targetGroupCode : row.targetUid) === conv &&
        row.msgId !== 0n &&
        row.msgId !== replyMsgId &&
        (!quote.origSenderUid || row.senderUid === quote.origSenderUid) &&
        (!senderUin || row.senderUin === senderUin) &&
        (!sendTime || row.sendTime === sendTime) &&
        (!replySeq || !('clientSeq' in row) || !row.clientSeq || row.clientSeq === replySeq),
    );
    const original = matches.length === 1 ? matches[0] : undefined;
    if (original) {
      const { msgId, msgSeq, sendTime } = original;
      return { msgId, msgSeq, sendTime };
    }
  }

  calendar(kind: 'group' | 'c2c', conv: string, bounds?: { start: number; end: number }) {
    return kind === 'group'
      ? this.session.groupMsgs.calendar(conv, bounds)
      : this.c2cDbFor(conv).calendar(this.c2cPartition(conv), bounds);
  }

  boundary(
    kind: 'group' | 'c2c',
    conv: string,
    newest: boolean,
    bounds?: { start?: number; end?: number },
  ) {
    return kind === 'group'
      ? this.session.groupMsgs.boundary(conv, newest, bounds)
      : this.c2cDbFor(conv).boundary(this.c2cPartition(conv), newest, bounds);
  }

  /** 范围选择按序号分页，完整读取边界同序号记录，避免跨页漏选。 */
  async getSelectionRangePage(
    kind: 'c2c' | 'group',
    conv: string,
    start: bigint,
    end: bigint,
    after?: bigint,
    limit = 200,
  ) {
    const cursor = after ?? start - 1n;
    if (start <= 0n || end < start || cursor >= end)
      return { items: [] as Array<RenderC2cMsg | RenderGroupMsg>, nextSeq: null };
    const page: Array<C2cMsg | GroupMsg> =
      kind === 'group'
        ? await this.session.groupMsgs.listAfter(conv, cursor, limit)
        : await this.c2cDbFor(conv).listAfter(this.c2cPartition(conv), cursor, limit);
    const boundary = page.at(-1)?.msgSeq;
    if (boundary !== undefined && boundary <= cursor) throw new Error('消息范围分页游标未前进');
    const extra =
      page.length >= limit && boundary !== undefined && boundary <= end
        ? kind === 'group'
          ? await this.session.groupMsgs.listBySeqsInPartition(conv, [boundary])
          : await this.c2cDbFor(conv).listBySeqsInPartition(this.c2cPartition(conv), [boundary])
        : [];
    const rows = [
      ...new Map(
        [...page, ...extra]
          .filter((row) => row.msgSeq >= start && row.msgSeq <= end)
          .map((row) => [row.msgId, row]),
      ).values(),
    ].sort(compareMessageOrder);
    await this.enrichReplyMedia(rows, kind);
    const recalls = await this.recallMapFor(kind, conv, rows);
    return {
      items: rows.map((row) =>
        kind === 'group'
          ? this.renderGroupWithState(row as GroupMsg, recalls)
          : this.renderC2cWithState(row as C2cMsg, recalls),
      ),
      nextSeq:
        page.length >= limit && boundary !== undefined && boundary < end
          ? boundary.toString()
          : null,
    };
  }

  /** Private-chat page just older than `beforeSeq` (scroll-up). */
  async getC2cBefore(
    targetUid: string,
    beforeSeq: bigint,
    limit = 50,
    options: MessagePageOptions = {},
  ): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listBefore(
      await this.c2cPagePartition(targetUid),
      beforeSeq,
      limit,
    );
    if (!options.deferReplyMedia) await this.enrichReplyMedia(msgs, 'c2c');
    const recallMap = await this.recallMapFor('c2c', targetUid, msgs);
    return msgs.map((m) => this.renderC2cWithState(m, recallMap));
  }

  /** Private-chat page just newer than `afterSeq` (scroll-down / jump context). */
  async getC2cAfter(
    targetUid: string,
    afterSeq: bigint,
    limit = 50,
    options: MessagePageOptions = {},
  ): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listAfter(
      await this.c2cPagePartition(targetUid),
      afterSeq,
      limit,
    );
    if (!options.deferReplyMedia) await this.enrichReplyMedia(msgs, 'c2c');
    const recallMap = await this.recallMapFor('c2c', targetUid, msgs);
    return msgs.map((m) => this.renderC2cWithState(m, recallMap));
  }

  /** Re-read private-chat messages with seq >= `sinceSeq` (live refresh). */
  async getC2cFrom(
    targetUid: string,
    sinceSeq: bigint,
    limit = 500,
    options: MessagePageOptions = {},
  ): Promise<RenderC2cMsg[]> {
    const msgs = await this.c2cDbFor(targetUid).listFrom(
      await this.c2cPagePartition(targetUid),
      sinceSeq,
      limit,
    );
    if (!options.deferReplyMedia) await this.enrichReplyMedia(msgs, 'c2c');
    const recallMap = await this.recallMapFor('c2c', targetUid, msgs);
    return msgs.map((m) => this.renderC2cWithState(m, recallMap));
  }

  /**
   * Private-chat page of seq-less messages (migration-imported history) just
   * newer than `afterRowId` (rowid order). Export-only — the seq scan misses
   * these; see `C2cMsgDb.listSeqlessAfterRowId` and `message_source`.
   */
  async getC2cSeqlessAfterRowId(
    targetUid: string,
    afterRowId: bigint,
    limit = 2000,
  ): Promise<Array<RenderC2cMsg & { rowId: bigint }>> {
    const msgs = await this.c2cDbFor(targetUid).listSeqlessAfterRowId(
      this.c2cPartition(targetUid),
      afterRowId,
      limit,
    );
    return msgs.map((m) => ({ ...renderC2c(m), rowId: m.rowId }));
  }

  // ---- group ---------------------------------------------------------------

  async getHistoryPage(
    kind: 'c2c' | 'group',
    conv: string,
    options: {
      cursor?: { msgSeq: bigint; sendTime: bigint; msgId: bigint };
      min: bigint;
      max: bigint;
      descending: boolean;
      limit: number;
    },
  ): Promise<(RenderC2cMsg | RenderGroupMsg)[]> {
    const rows =
      kind === 'group'
        ? await this.session.groupMsgs.listHistory(conv, options)
        : await this.c2cDbFor(conv).listHistory(this.c2cPartition(conv), options);
    const recalls = await this.recallMapFor(kind, conv, rows);
    return rows.map((row) =>
      kind === 'group'
        ? this.renderGroupWithState(row as GroupMsg, recalls)
        : this.renderC2cWithState(row as C2cMsg, recalls),
    );
  }

  async getLocalMessagePage(
    kind: 'c2c' | 'group',
    conv: string,
    limit: number,
    before?: HistoryCursor,
  ): Promise<(RenderC2cMsg | RenderGroupMsg)[]> {
    const rows =
      kind === 'group'
        ? await this.session.groupMsgs.listNewestHistory(conv, limit, before)
        : await this.c2cDbFor(conv).listNewestHistory(
            await this.c2cPagePartition(conv),
            limit,
            before,
          );
    await this.enrichReplyMedia(rows, kind);
    const recalls = await this.recallMapFor(kind, conv, rows);
    return rows.map((row) =>
      kind === 'group'
        ? this.renderGroupWithState(row as GroupMsg, recalls)
        : this.renderC2cWithState(row as C2cMsg, recalls),
    );
  }

  /** Latest local messages in a time interval, with rowid breaking ties within a second. */
  async getLocalMessageRangePage(
    kind: 'c2c' | 'group',
    conv: string,
    range: { start: number; end: number },
    limit: number,
    before?: BrowseCursor,
  ) {
    const rows =
      kind === 'group'
        ? await this.session.groupMsgs.browse(conv, range, before, limit + 1)
        : await this.c2cDbFor(conv).browse(
            await this.c2cPagePartition(conv),
            range,
            before,
            limit + 1,
          );
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page.at(-1) : undefined;
    const recalls = await this.recallMapFor(
      kind,
      conv,
      page.map(({ message }) => message),
    );
    return {
      messages: page.map(({ message }) =>
        'targetGroupCode' in message
          ? this.renderGroupWithState(message, recalls)
          : this.renderC2cWithState(message, recalls),
      ),
      nextBefore: last && { time: last.message.sendTime, rowId: last.rowId },
    };
  }

  /** 以本地数据线消息为准，历史设备会话可能已从最近会话列表移除。 */
  async listDatalineConversations() {
    const db = this.session.datalineMsgs;
    if (!(await db.hasTable())) return [];
    const sessions = await Promise.all(
      Object.keys(DATALINE_UID_TO_DEVICE).map(async (conv) => {
        const [latest] = await db.listNewestHistory(this.c2cPartition(conv), 1);
        return latest ? [{ conv, lastTime: latest.sendTime, lastSeq: latest.msgSeq }] : [];
      }),
    );
    return sessions.flat().sort((a, b) => Number(b.lastTime - a.lastTime));
  }

  /** Newest N group messages in one group. */
  async getGroupLatest(
    targetGroupCode: string,
    limit = 50,
    options: MessagePageOptions = {},
  ): Promise<RenderGroupMsg[]> {
    return measureMessageWork(this.session.msgDbPath, 'messagePage', async () => {
      const msgs = await this.session.groupMsgs.listLatest(targetGroupCode, limit);
      if (!options.deferReplyMedia) await this.enrichReplyMedia(msgs, 'group');
      const recallMap = await this.recallMapFor('group', targetGroupCode, msgs);
      return msgs.map((m) => this.renderGroupWithState(m, recallMap));
    });
  }

  /** Group page just older than `beforeSeq` (scroll-up). */
  async getGroupBefore(
    targetGroupCode: string,
    beforeSeq: bigint,
    limit = 50,
    options: MessagePageOptions = {},
  ): Promise<RenderGroupMsg[]> {
    const msgs = await this.session.groupMsgs.listBefore(targetGroupCode, beforeSeq, limit);
    if (!options.deferReplyMedia) await this.enrichReplyMedia(msgs, 'group');
    const recallMap = await this.recallMapFor('group', targetGroupCode, msgs);
    return msgs.map((m) => this.renderGroupWithState(m, recallMap));
  }

  /** Group page just newer than `afterSeq` (scroll-down / jump context). */
  async getGroupAfter(
    targetGroupCode: string,
    afterSeq: bigint,
    limit = 50,
    options: MessagePageOptions = {},
  ): Promise<RenderGroupMsg[]> {
    const msgs = await this.session.groupMsgs.listAfter(targetGroupCode, afterSeq, limit);
    if (!options.deferReplyMedia) await this.enrichReplyMedia(msgs, 'group');
    const recallMap = await this.recallMapFor('group', targetGroupCode, msgs);
    return msgs.map((m) => this.renderGroupWithState(m, recallMap));
  }

  /** Re-read group messages with seq >= `sinceSeq` (live refresh). */
  async getGroupFrom(
    targetGroupCode: string,
    sinceSeq: bigint,
    limit = 500,
    options: MessagePageOptions = {},
  ): Promise<RenderGroupMsg[]> {
    const msgs = await this.session.groupMsgs.listFrom(targetGroupCode, sinceSeq, limit);
    if (!options.deferReplyMedia) await this.enrichReplyMedia(msgs, 'group');
    const recallMap = await this.recallMapFor('group', targetGroupCode, msgs);
    return msgs.map((m) => this.renderGroupWithState(m, recallMap));
  }

  /**
   * Group page of seq-less messages (migration-imported history) just newer
   * than `afterRowId` (rowid order). Export-only — the seq scan misses these;
   * see `GroupMsgDb.listSeqlessAfterRowId` and `message_source`.
   */
  async getGroupSeqlessAfterRowId(
    targetGroupCode: string,
    afterRowId: bigint,
    limit = 2000,
  ): Promise<Array<RenderGroupMsg & { rowId: bigint }>> {
    const msgs = await this.session.groupMsgs.listSeqlessAfterRowId(
      targetGroupCode,
      afterRowId,
      limit,
    );
    return msgs.map((m) => ({ ...renderGroup(m), rowId: m.rowId }));
  }

  /**
   * The conversation's seq window for a time range (40003 > 0), newest-first.
   * Powers the export 「消息补全」seq 空窗扫描 (which holes to fetch from the roam
   * server). `startTime`/`endTime` (unix seconds) narrow the seqs to the
   * window and return the `below`/`above` boundary anchors, so the backfill
   * only pulls gaps inside the export's time range instead of the whole
   * pre-window history.
   */
  async getGroupSeqDesc(
    targetGroupCode: string,
    opts: { startTime?: number; endTime?: number } = {},
  ): Promise<SeqWindow> {
    return this.session.groupMsgs.listSeqDesc(targetGroupCode, opts);
  }

  /**
   * The conversation's seq window for a time range (40003 > 0) of a private
   * chat, newest-first. See {@link getGroupSeqDesc}.
   */
  async getC2cSeqDesc(
    targetUid: string,
    opts: { startTime?: number; endTime?: number } = {},
  ): Promise<SeqWindow> {
    return this.c2cDbFor(targetUid).listSeqDesc(this.c2cPartition(targetUid), opts);
  }

  // ---- service assistant (chatType 118) ------------------------------------

  /** Service account page just newer than `afterSeq` (export use). */
  async getServiceAfter(appId: string, afterSeq: bigint, limit = 50): Promise<RenderC2cMsg[]> {
    const msgs = await this.session.serviceAssistantMsgs.listAfter(
      { appId: BigInt(appId) },
      afterSeq,
      limit,
    );
    return msgs.map((m) => renderC2c(m));
  }

  /** Service account seq-less page (export use). */
  async getServiceSeqlessAfterRowId(
    appId: string,
    afterRowId: bigint,
    limit = 2000,
  ): Promise<Array<RenderC2cMsg & { rowId: bigint }>> {
    const msgs = await this.session.serviceAssistantMsgs.listSeqlessAfterRowId(
      { appId: BigInt(appId) },
      afterRowId,
      limit,
    );
    return msgs.map((m) => ({ ...renderC2c(m), rowId: m.rowId }));
  }

  // ---- 损坏宽容续读（导出专用） ----------------------------------------------
  //
  // 这四个方法与上面的分页方法一一对应，差别只有一个：**页内坏了不整体失败**。
  // 它们沿键轴分块扫描，块内先换访问路径、再二分，真的读不出来就跳过并交由账本/
  // 报告汇报。代价是会丢数据，所以只在用户授权级别 ≥ 2 时才允许调用（native 侧再
  // 兜一道），且调用方应该是"严格读已经失败之后接着往下读"的那条路径。

  /**
   * 群消息的容错续读（seq 升序）。渲染口径与 {@link getGroupAfter} 完全一致
   * （同样做 reply 富化与已删除/撤回标记），否则"续读出来的消息"会与"严格读出来的
   * 消息"长得不一样，导出的文件里一眼就能看出分界线。
   */
  async *streamSalvageGroupAfter(
    targetGroupCode: string,
    afterSeq: bigint,
    opts: SalvageStreamOptions,
  ): AsyncGenerator<RenderGroupMsg[]> {
    // 召回映射取一次就够：续读可能跨很多窗口，不该每个窗口重查一遍。
    const recallMap = await this.recallMapFor('group', targetGroupCode);
    for await (const batch of this.session.groupMsgs.streamSalvageAfter(
      targetGroupCode,
      afterSeq,
      this.withRecordedSkips(targetGroupCode, 'group', opts),
    )) {
      await this.enrichReplyMedia(batch, 'group');
      yield batch.map((m) => this.renderGroupWithState(m, recallMap));
    }
  }

  /** 群消息里**无 seq** 的迁移导入块的容错续读（rowid 升序）。 */
  async *streamSalvageGroupSeqlessAfterRowId(
    targetGroupCode: string,
    afterRowId: bigint,
    opts: SalvageStreamOptions,
  ): AsyncGenerator<Array<RenderGroupMsg & { rowId: bigint }>> {
    for await (const batch of this.session.groupMsgs.streamSalvageSeqlessAfterRowId(
      targetGroupCode,
      afterRowId,
      this.withRecordedSkips(targetGroupCode, 'group', opts),
    )) {
      yield batch.map((m) => ({ ...renderGroup(m), rowId: m.rowId }));
    }
  }

  /** 私聊消息的容错续读（seq 升序）；渲染口径与 {@link getC2cAfter} 一致。 */
  async *streamSalvageC2cAfter(
    targetUid: string,
    afterSeq: bigint,
    opts: SalvageStreamOptions,
  ): AsyncGenerator<RenderC2cMsg[]> {
    const recallMap = await this.recallMapFor('c2c', targetUid);
    for await (const batch of this.c2cDbFor(targetUid).streamSalvageAfter(
      this.c2cPartition(targetUid),
      afterSeq,
      this.withRecordedSkips(targetUid, 'c2c', opts),
    )) {
      await this.enrichReplyMedia(batch, 'c2c');
      yield batch.map((m) => this.renderC2cWithState(m, recallMap));
    }
  }

  /** 私聊消息里**无 seq** 的迁移导入块的容错续读（rowid 升序）。 */
  async *streamSalvageC2cSeqlessAfterRowId(
    targetUid: string,
    afterRowId: bigint,
    opts: SalvageStreamOptions,
  ): AsyncGenerator<Array<RenderC2cMsg & { rowId: bigint }>> {
    for await (const batch of this.c2cDbFor(targetUid).streamSalvageSeqlessAfterRowId(
      this.c2cPartition(targetUid),
      afterRowId,
      this.withRecordedSkips(targetUid, 'c2c', opts),
    )) {
      yield batch.map((m) => ({ ...renderC2c(m), rowId: m.rowId }));
    }
  }

  // ---- count ---------------------------------------------------------------

  /**
   * Count the total stored messages of one conversation (a single COUNT query).
   * Used as a coarse `total` estimate for export progress; failures degrade to 0
   * so callers never break on it.
   *
   * `opts` narrows the count without extra scans (see the DB layer): `startTime`/
   * `endTime` window on sendTime; `senderUid` counts only that sender's messages
   * (e.g. self, for 「我在这段发了多少」). Powers `compare_periods` per-conversation.
   */
  async countConv(
    kind: 'c2c' | 'group',
    conv: string,
    opts: { startTime?: number; endTime?: number; senderUid?: string } = {},
  ): Promise<number> {
    try {
      if (kind === 'group') {
        const byCode = await this.session.groupMsgs.countByGroups([conv], opts);
        return byCode[conv] ?? 0;
      }
      const byUid = await this.c2cDbFor(conv).countByUids([conv], opts);
      return byUid[conv] ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * The 40900 merged-forward / reply cache for one message, by kind. Each record
   * is a full cached message snapshot and may nest its own 40900 list (deep
   * forwards). The export pipeline uses this to expand a `[合并转发]` placeholder
   * into the real forwarded content. Returns [] on any miss / decode error.
   */
  async listForward(
    kind: 'c2c' | 'group' | 'official' | 'service',
    msgId: bigint,
  ): Promise<MsgCacheRecord[]> {
    try {
      return kind === 'group'
        ? await this.session.forwardMsgs.listGroupForward(msgId)
        : await this.session.forwardMsgs.listC2cForward(msgId);
    } catch {
      return [];
    }
  }

  /** Current account's own uid (for `senderUid=self` filters). '' if unresolved. */
  selfUid(): string {
    return this.session.selfUid;
  }

  /**
   * Find a media element inside a message's 40900 forward cache.
   *
   * Forwarded sub-messages are snapshots of rows that live in *someone else's*
   * conversation — they were never written to our own c2c/group msg tables, so
   * {@link getRawElements} can't see them. Their elements are only in the
   * carrying message's 40900 blob, which is exactly what this walks (recursively
   * — a forward can nest forwards arbitrarily deep).
   *
   * `subMsgId` picks the sub-message; `token` disambiguates when one sub-message
   * carries several media of the same kind.
   */
  async findForwardedMediaElement(
    kind: 'c2c' | 'group',
    msgId: bigint,
    subMsgId: bigint,
    mediaKind: 'video' | 'file' | 'ptt',
    token: string,
  ): Promise<Element | null> {
    const records = await this.listForward(kind, msgId);
    if (records.length === 0) return null;
    return findMediaInCache(records, subMsgId, mediaKind, token);
  }

  // ---- reply media enrichment ----------------------------------------------

  /**
   * Back-fill a reply quote's real media element from the 40900 cache.
   *
   * QQ NT stores only a "[图片]" / "[视频]" TEXT placeholder in a reply's inline
   * `origElements` (40800 body) — the quoted message's true media (image token,
   * md5, CDN urls) lives instead in the 40900 message-cache column as a full
   * snapshot of the quoted row. So for every reply whose stored origElements
   * carries NO media element, we look up this message's 40900 cache, find the
   * cached quoted message (matched by origMsgId, else the first record), and
   * splice its real elements into origElements — letting the renderer show an
   * actual thumbnail. Text/@/face replies and replies that already carry media
   * are left untouched (no lookup).
   *
   * Mutates the passed messages in place (before render mapping) and swallows
   * per-message lookup failures so a bad cache never breaks the page.
   */
  private async enrichReplyMedia(msgs: ReplyBearer[], kind: 'c2c' | 'group'): Promise<void> {
    const pending = msgs.filter((m) => m.elements.some(isMediaLessReply));
    if (pending.length === 0) return;
    const began = performance.now();

    try {
      const caches = await this.replyMedia(
        kind,
        pending.map((m) => m.msgId),
      );
      for (const m of pending) {
        const cache = caches.get(m.msgId) ?? [];
        if (cache.length === 0) continue;
        for (const el of m.elements) {
          if (isMediaLessReply(el)) (el as ReplyLike).origElements = cache;
        }
      }
    } catch {
      /* keep the "[图片]" placeholder on any cache miss / decode error */
    } finally {
      recordMessageWork(this.session.msgDbPath, 'replyCache', performance.now() - began);
    }
  }

  private async replyMedia(kind: 'c2c' | 'group', ids: bigint[]): Promise<Map<bigint, unknown[]>> {
    const caches = await this.session.forwardMsgs.listForMessages(kind, ids);
    return new Map([...caches].map(([id, cache]) => [id, cachedQuotedMedia(cache)]));
  }

  /** 正文已显示后按页读取引用快照中的媒体和发送者称呼。 */
  async getReplyMedia(kind: 'c2c' | 'group', ids: bigint[], includeHistoricalNames = false) {
    const caches = await this.session.forwardMsgs.listForMessages(kind, ids);
    return [...caches].flatMap(([id, records]) => {
      if (records.length !== 1) return [];
      const record = records[0]!;
      const name = kind === 'group' && includeHistoricalNames ? record.sendNick?.trim() : undefined;
      const quotedSender = name
        ? {
            name,
            uid: record.senderUid || '',
            seq: String(record.msgSeq || ''),
            msgId: String(record.msgId || ''),
          }
        : undefined;
      const elements = cachedQuotedMedia(records);
      if (!elements.length && !quotedSender) return [];
      try {
        return [
          {
            msgId: id.toString(),
            elements: toRenderElements(elements.map((wire) => decodeElement(wire as never))),
            ...(quotedSender ? { quotedSender } : {}),
          },
        ];
      } catch {
        return [];
      }
    });
  }

  /** Resolve a peer uid to its indexed partition (sortNo), else fall back to uid. */
  private async c2cPagePartition(
    targetUid: string,
    options: MessagePageOptions = {},
  ): Promise<C2cPartition> {
    if (!isDatalineUid(targetUid) && this.session.uidMap.sortNoByUid(targetUid) === undefined) {
      try {
        await this.session.uidMap.resolveSortNo?.(targetUid);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
      }
    }
    if (options.skipUnindexed && this.session.uidMap.sortNoByUid(targetUid) === undefined)
      throw new Error('跳过未索引会话的后台预取');
    return this.c2cPartition(targetUid);
  }

  private c2cPartition(targetUid: string): C2cPartition {
    const sortNo = this.session.uidMap.sortNoByUid(targetUid);
    recordMessagePartition(this.session.msgDbPath, sortNo !== undefined);
    return sortNo !== undefined ? { sortNo } : { uid: targetUid };
  }

  /**
   * Pick the message table for a "c2c-like" conversation. Device-line uids
   * (我的手机/我的电脑) live in `dataline_msg_table`; everything else is a real
   * private chat in `c2c_msg_table`. Both are served by C2cMsgDb (same schema),
   * and dataline uids aren't in the uid map so they naturally take the uid
   * partition path.
   */
  private c2cDbFor(targetUid: string): C2cMsgDb {
    return isDatalineUid(targetUid) ? this.session.datalineMsgs : this.session.c2cMsgs;
  }
}

/** Local-midnight (unix seconds) of a unix-seconds timestamp — column 40058. */
function localMidnight(sec: bigint): bigint {
  const d = new Date(Number(sec) * 1000);
  return BigInt(Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000));
}

function renderC2c(m: C2cMsg): RenderC2cMsg {
  return { ...m, elements: toRenderElements(m.elements) };
}

function renderGroup(m: GroupMsg): RenderGroupMsg {
  return { ...m, elements: toRenderElements(m.elements) };
}

/** A reply element (pre-render): `origElements` holds raw quoted ElementWire. */
interface ReplyLike {
  kind?: string;
  origElements?: unknown[];
}

/** Raw wire element: an object bearing a numeric `elementType`. */
function wireType(el: unknown): number {
  const t = (el as { elementType?: unknown })?.elementType;
  return typeof t === 'number' ? t : 0;
}

/**
 * True for a `reply` element whose stored `origElements` contains no media
 * element — i.e. only the "[图片]"/"[视频]" text placeholder QQ writes into the
 * 40800 body. These are the replies worth a 40900-cache lookup.
 */
function isMediaLessReply(el: Element): boolean {
  if ((el as ReplyLike).kind !== 'reply') return false;
  const orig = (el as ReplyLike).origElements;
  if (!Array.isArray(orig)) return true;
  return !orig.some((o) => REPLY_MEDIA_TYPES.has(wireType(o)));
}

/**
 * Pick the quoted message's real media-bearing elements out of a 40900 cache.
 *
 * A reply's 40900 cache holds exactly ONE record: the quoted message (only
 * merged-forwards, msgType 8, carry multiple). The reply element's `origMsgId`
 * is NOT the cached record's snowflake msgId (verified on a live row — they
 * differ), so we can't match by id; we take the sole record. Returns its raw
 * wire elements (ready for decodeElement in mapReply), or [] when the cached
 * record carries no media after all.
 */
function cachedQuotedMedia(cache: MsgCacheRecord[]): unknown[] {
  if (cache.length !== 1) return [];
  const record = cache[0];
  const els = (record as { elements?: unknown[] } | undefined)?.elements;
  if (!Array.isArray(els)) return [];
  return els.some((o) => REPLY_MEDIA_TYPES.has(wireType(o))) ? els : [];
}

/** A 40900 record as far as the media walk cares. */
interface CacheRecordLike {
  msgId?: number | bigint;
  elements?: unknown[];
  subMsgs?: MsgCacheRecord[];
}

/**
 * Depth-first search of a 40900 cache tree for a sub-message's media element.
 * Matches the record by msgId, then picks the element by kind + fileToken (the
 * token only disambiguates — a sub-message with one video/file matches without).
 *
 * A record whose msgId doesn't match is still searched for an exact `token` hit:
 * fileToken uniquely identifies the media regardless of which record carries it,
 * so this rescues the case where the renderer's sub-msgId went missing. Only
 * runs after the whole tree failed the id match, so it never shadows it.
 */
function findMediaInCache(
  records: MsgCacheRecord[],
  subMsgId: bigint,
  mediaKind: 'video' | 'file' | 'ptt',
  token: string,
  depth = 0,
): Element | null {
  const byId = walkCache(
    records,
    mediaKind,
    depth,
    (rec) => rec.msgId != null && BigInt(rec.msgId) === subMsgId,
  );
  if (byId) {
    const hit = token
      ? byId.find((e) => (e as { fileToken?: string }).fileToken === token)
      : byId[0];
    if (hit) return hit;
  }
  if (!token) return null;
  const anywhere = walkCache(records, mediaKind, depth, () => true);
  return anywhere?.find((e) => (e as { fileToken?: string }).fileToken === token) ?? null;
}

/** Collect every media element of `mediaKind` from records passing `accept`. */
function walkCache(
  records: MsgCacheRecord[],
  mediaKind: 'video' | 'file' | 'ptt',
  depth: number,
  accept: (rec: CacheRecordLike) => boolean,
): Element[] | null {
  if (depth > 16) return null;
  const out: Element[] = [];
  for (const raw of records) {
    const rec = raw as CacheRecordLike;
    if (accept(rec) && Array.isArray(rec.elements)) {
      for (const wire of rec.elements) {
        try {
          const el = decodeElement(wire as never);
          if (el.kind === mediaKind || (mediaKind === 'video' && el.kind === 'bubbleVideo'))
            out.push(el);
        } catch {
          /* skip an element the codec can't parse — others may still match */
        }
      }
    }
    if (Array.isArray(rec.subMsgs) && rec.subMsgs.length > 0) {
      const nested = walkCache(rec.subMsgs, mediaKind, depth + 1, accept);
      if (nested) out.push(...nested);
    }
  }
  return out.length > 0 ? out : null;
}
