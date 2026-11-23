/**
 * `msg_unread_info_table` — conversation unread info.
 *
 * Column map:
 *   48901  peer      (TEXT — format: "chatType_uid")
 *   48902  unreadBuf (BLOB — protobuf with field 41002: msgSeq)
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { QqDb } from '../qq_db';
import {
  ChatType,
  ElementType,
  GrayTipSubType,
  ProtoMsg,
  isDatalineSelfUid,
  isDatalineUid,
} from '@weq/codec';
import {
  appendNode,
  buildEditTree,
  encodeEditTree,
  newNode,
  removeNode,
  sanitizeBytes,
  updateNode,
} from '@weq/codec/raw';
import type { PbNode, PbValue } from '@weq/codec/raw';
import { RecentContactBody } from '@weq/codec/proto/msg/40051';
import { MsgType } from '@weq/codec/proto/msg/40900';
import { UnreadInfo } from '@weq/codec/proto/msg/48902';
import { RECALL_UNREAD_INDEX } from './anti_recall';
import {
  databaseReadBudget,
  databaseRequestSignal,
  withDatabaseReadBudget,
} from '../query_schedule';

export interface UnreadInfoDbOptions {
  dbPath: string;
  key?: string;
  algo?: DatabaseAlgorithms;
}

/**
 * Named categories of the 48902 notify-highlight (50005 → 50060), keyed by the
 * observed `50000` kind code. QQ NT populates one highlight group per category
 * that currently has an unread hit:
 *   1000 = @我 (at-me), 1002 = 回复我 (reply-me), 1006 = 特别关心 (special-care),
 *   1007 = QQ红包 (red-packet), 2000 = @全体 (at-all), 2001 = 新文件 (new-file),
 *   2005 = 群公告 (group announcement), 2006 = 群提醒词 (group keyword).
 * More will slot in as their codes are captured.
 */
export type HighlightKind =
  | 'atMe'
  | 'atAll'
  | 'replyMe'
  | 'specialCare'
  | 'newFile'
  | 'redPacket'
  | 'groupAnnouncement'
  | 'groupKeyword'
  | 'unknown';

const HIGHLIGHT_KIND_BY_CODE: Record<number, HighlightKind> = {
  1000: 'atMe',
  1002: 'replyMe',
  1006: 'specialCare',
  1007: 'redPacket',
  2000: 'atAll',
  2001: 'newFile',
  2005: 'groupAnnouncement',
  2006: 'groupKeyword',
};

/**
 * One notify-highlight hit for a conversation, decoded from 50060 → 50040.
 * Present only while the conversation has a matching unread message.
 */
export interface UnreadHighlight {
  /** Mapped category; 'unknown' when the 50000 code isn't recognized yet. */
  kind: HighlightKind;
  /** Raw 50000 code, preserved so unmapped categories are still identifiable. */
  rawKind: number;
  /** Seq of one highlighted message; a category may contain multiple hits. */
  msgSeq: number;
  /** Uid of the sender. */
  senderUid: string;
  /** Send time of the highlighted message (unix seconds). */
  sendTime: number;
  /** Preview text (50024). For 群提醒词 this is the keyword that matched. */
  text: string;
}

export interface UnreadInfoResult {
  peer: string;
  chatType: number;
  uid: string;
  msgSeq?: number;
  localReadSeq?: string;
  decreasedSeqs?: string[];
  markUnread?: boolean;
  storedUnreadCount?: number;
  localUnreadCount?: number;
  /** Notify-highlights (特别关心 / @我 / …) present on this conversation. */
  highlights?: UnreadHighlight[];
  /** 数据线以原消息时间和 ID 定位，序号统一为零。 */
  deviceRead?: string;
  deviceIncomingTime?: string;
}

export interface UnreadInfoTarget {
  chatType: number;
  uid: string;
}

export interface UnreadInfoSnapshot extends UnreadInfoResult {
  latestSeq: string | null;
  deviceLatest?: string;
  /** 正文发送者；灰条覆盖预览时不能直接使用小表 40020。 */
  latestSenderUid?: string;
  /** 最新序号已确认只有撤回／拍一拍，不是新的正文。 */
  latestSeqNonMessage?: true;
  /** 已确认撤回的序号，用于未读减项及过滤对应提醒。 */
  recalledSeqs?: string[];

  readError?: true;
}

type UnreadFields = Omit<UnreadInfoResult, 'peer' | 'chatType' | 'uid'>;
const MAX_CACHED_UNREAD_FIELDS = 16_384;
const MAX_CACHED_UNREAD_BYTES = 8 * 1024 * 1024;
const PROTECTED_RECALL_TARGET_BATCH = 128;
const PROTECTED_RECALL_RESULT_LIMIT = 256;

const GRAY_TIP = MsgType.GRAY_TIP;
const RECENT_CHAT_TYPE = `CAST(r."40010" AS INTEGER)`;
const TEMP_DIRECT_TYPES = [
  ChatType.KCHATTYPETEMPC2CFROMUNKNOWN,
  ChatType.KCHATTYPETEMPC2CFROMGROUP,
  ChatType.KCHATTYPETEMPFRIENDVERIFY,
].join(',');
// 临时私聊在最近会话表保留来源类型，未读表则与普通私聊共用 1_<uid>。
const RECENT_UNREAD_TYPE = `CASE WHEN ${RECENT_CHAT_TYPE} IN (${TEMP_DIRECT_TYPES}) THEN 1 ELSE ${RECENT_CHAT_TYPE} END`;
const RECENT_UNREAD_COLUMNS = `r."40003", r."40020", CASE WHEN r."40011"=${GRAY_TIP} THEN r."40051" END, r."40001", r."40027", ${RECENT_CHAT_TYPE}`;
const HAS_RECALL_UNREAD_INDEX = `EXISTS(SELECT 1 FROM sqlite_master
  WHERE type='index' AND name='${RECALL_UNREAD_INDEX}')`;
function deviceStorageType(chatType: number, uid: string): number {
  if (!isDatalineUid(uid)) return chatType;
  return chatType === 8 ? 10 : chatType === 134 ? 53 : chatType;
}

function readPosition(time: bigint, id: bigint): string {
  return `0:${time}:${BigInt.asIntN(64, id)}`;
}

const previewProto = new ProtoMsg(RecentContactBody);

interface GrayTipUnreadTarget {
  snapshot: UnreadInfoSnapshot;
  partition: bigint;
  seq: bigint;
  msgId: bigint | null;
  recall: boolean;
}

interface ProtectedRecallTarget {
  snapshot: UnreadInfoSnapshot;
  kind: 'c2c' | 'group';
  uid: string;
  after: bigint;
  through: bigint;
}

function unreadGrayTip(blob: Uint8Array): 'recall' | 'poke' | undefined {
  try {
    const [wire] = previewProto.decode(sanitizeBytes(blob, RecentContactBody)).preview ?? [];
    if (wire?.elementType !== ElementType.GRAY_TIP) return;
    if (wire.subType === GrayTipSubType.REVOKE) return 'recall';
    if (
      (wire.subType === GrayTipSubType.JSON || wire.subType === GrayTipSubType.XML_MSG) &&
      wire.detailedId === 1061
    )
      return 'poke';
  } catch {
    // 预览异常不使整个未读快照失效。
  }
}

function positiveInt(value: unknown): bigint | null {
  if (value == null || !/^\d{1,20}$/.test(String(value))) return null;
  return BigInt(String(value)) || null;
}

/** 转为正式私聊后若仍有临时摘要，优先使用与未读键同类型的正式摘要。 */
function preferRecentUnreadRow(candidate: SqlRow, current: SqlRow): boolean {
  const exact = Number(candidate[9]) === Number(candidate[0]);
  const currentExact = Number(current[9]) === Number(current[0]);
  if (exact !== currentExact) return exact;
  return (positiveInt(candidate[4]) ?? 0n) > (positiveInt(current[4]) ?? 0n);
}

export interface UnreadReadChange extends UnreadInfoTarget {
  existed: boolean;
  before: Uint8Array | null;
  after: Uint8Array;
  afterReadSeq: string;
  beforeReadSeq?: string;
  afterMarkUnread?: boolean;
}

/**
 * One hit to write back into the `48902` notify-highlight extension
 * (`50005 → 50060`). Kept as a raw kind code (not the mapped enum) so callers
 * can write categories — e.g. `2006` 群提醒词 — that WeQ itself produces and
 * that QQ renders natively.
 */
export interface UnreadHighlightInput {
  /** Raw `50000` kind code, e.g. 2006 = 群提醒词. */
  kind: number;
  /** Seq of the highlighted message. */
  msgSeq: number;
  /** Sender uid. */
  senderUid: string;
  /** Send time (unix seconds). */
  sendTime: number;
  /** Preview text stored on the item (QQ often leaves this empty; we fill it). */
  text: string;
}

export class UnreadInfoDb {
  private readonly qq: QqDb;
  private readonly proto = new ProtoMsg(UnreadInfo);
  private readonly seqIndexes = new Map<string, Promise<boolean>>();
  private readonly unreadFields = new Map<string, { bytes: Uint8Array; decoded: UnreadFields }>();
  private unreadFieldBytes = 0;

  constructor(nt: NtHelperBinding, opts: UnreadInfoDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  async getUnreadInfo(chatType: number, uid: string): Promise<UnreadInfoResult | null> {
    const peer = `${chatType}_${uid}`;
    const storagePeer = `${deviceStorageType(chatType, uid)}_${uid}`;
    const rows = await this.qq.query(
      `SELECT "48901", "48902" FROM msg_unread_info_table WHERE "48901" IN (?, ?) ORDER BY "48901" = ? DESC LIMIT 1`,
      [storagePeer, peer, storagePeer],
    );

    const row = rows[0];
    if (!row) return null;

    const buf = row[1] as Uint8Array;
    const decoded = buf ? this.proto.decode(buf) : {};
    const highlights = extractHighlights(decoded.info?.ext);

    return {
      peer,
      chatType,
      uid,
      ...this.readFields(decoded),
      highlights: highlights.length ? highlights : undefined,
    };
  }

  /** 读取 QQ 已维护的阅读位置、减项及标志；灰条歧义只查最新序号。 */
  async getUnreadInfos(targets: UnreadInfoTarget[]): Promise<UnreadInfoSnapshot[]> {
    const unique = [...new Map(targets.map((t) => [`${t.chatType}_${t.uid}`, t])).values()];
    const result: UnreadInfoSnapshot[] = [];
    for (let offset = 0; offset < unique.length; offset += 256) {
      databaseRequestSignal()?.throwIfAborted();
      const batch = unique.slice(offset, offset + 256);
      const rows = await this.qq.query(
        `WITH targets(chatType, uid, storagePeer) AS (VALUES ${batch.map(() => '(?, ?, ?)').join(',')})
         SELECT t.chatType, t.uid, CAST(t.chatType AS INTEGER) || '_' || t.uid, COALESCE(u."48902", old."48902"), ${RECENT_UNREAD_COLUMNS}, ${HAS_RECALL_UNREAD_INDEX}
         FROM targets t
         LEFT JOIN msg_unread_info_table u ON u."48901" = t.storagePeer
         LEFT JOIN msg_unread_info_table old ON old."48901" = (CAST(t.chatType AS INTEGER) || '_' || t.uid) AND old."48901" != t.storagePeer
         LEFT JOIN recent_contact_v3_table r ON r."40021" = t.uid AND (${RECENT_UNREAD_TYPE}) = t.chatType`,
        batch.flatMap(({ chatType, uid }) => [
          chatType,
          uid,
          `${deviceStorageType(chatType, uid)}_${uid}`,
        ]),
      );
      const byPeer = new Map<string, SqlRow>();
      for (const row of rows) {
        const peer = String(row[2]);
        const current = byPeer.get(peer);
        if (!current || preferRecentUnreadRow(row, current)) byPeer.set(peer, row);
      }
      result.push(...(await this.decodeAndResolveSnapshots([...byPeer.values()])));
    }
    return result;
  }

  /** 账号共享快照由两张小表驱动，包含没有最近会话行的未读记录。 */
  async getAllUnreadInfos(): Promise<UnreadInfoSnapshot[]> {
    const rows = await this.qq.query(
      `SELECT ${RECENT_UNREAD_TYPE}, r."40021", (${RECENT_UNREAD_TYPE}) || '_' || r."40021", NULL, ${RECENT_UNREAD_COLUMNS}, ${HAS_RECALL_UNREAD_INDEX}
       FROM recent_contact_v3_table r
       WHERE ${RECENT_CHAT_TYPE} IN (1,2,8,134,${TEMP_DIRECT_TYPES})
       UNION ALL
       SELECT NULL,NULL,u."48901",u."48902",NULL,NULL,NULL,NULL,NULL,NULL,NULL FROM msg_unread_info_table u`,
    );
    // 同一 SQL 快照分别返回小表行，再线性合并；避免缺行检测逐个重扫最近会话表。
    const merged = new Map<string, SqlRow>();
    const nativeDeviceRows = new Set<string>();
    for (const row of rows) {
      let peer = String(row[2]);
      if (row[0] == null) {
        const separator = peer.indexOf('_');
        const type = Number(peer.slice(0, separator));
        const uid = peer.slice(separator + 1);
        if ((type === 10 || type === 53) && isDatalineUid(uid)) {
          peer = `${type === 10 ? 8 : 134}_${uid}`;
          nativeDeviceRows.add(peer);
          row[2] = peer;
        } else if (nativeDeviceRows.has(peer)) continue;
      }
      const recent = merged.get(peer);
      if (recent && row[0] == null) recent[3] = row[3] ?? null;
      else if (!recent || preferRecentUnreadRow(row, recent)) merged.set(peer, [...row]);
    }
    return (await this.decodeAndResolveSnapshots([...merged.values()], true)).filter((row) =>
      [1, 2, 8, 134].includes(row.chatType),
    );
  }

  private readFields(decoded: ReturnType<ProtoMsg<typeof UnreadInfo>['decode']>): UnreadFields {
    const info = decoded.info;
    return {
      msgSeq: info?.msgSeq,
      ...(info?.deviceReadTime && info.deviceReadId
        ? { deviceRead: readPosition(BigInt(info.deviceReadTime), BigInt(info.deviceReadId)) }
        : {}),
      ...(info?.deviceIncomingTime ? { deviceIncomingTime: String(info.deviceIncomingTime) } : {}),
      localReadSeq: info?.localReadSeq?.toString(),
      decreasedSeqs: info?.decreases
        ? [
            ...new Set(
              info.decreases.flatMap((item) =>
                item.msgSeq === undefined ? [] : [String(item.msgSeq)],
              ),
            ),
          ]
        : undefined,
      markUnread: info?.markUnread === undefined ? undefined : info.markUnread !== 0,
      storedUnreadCount: info?.unreadCount,
      localUnreadCount: info?.localUnreadCount,
    };
  }

  private decodeUnreadFields(blob: unknown): UnreadFields {
    const decoded = blob instanceof Uint8Array ? this.proto.decode(blob) : {};
    const highlights = extractHighlights(decoded.info?.ext);
    return { ...this.readFields(decoded), highlights: highlights.length ? highlights : undefined };
  }

  /** 只复用相同的 QQ 原始未读字段，灰条、撤回与数据线仍从最新快照求值。 */
  private snapshotUnreadFields(peer: string, blob: unknown): UnreadFields {
    if (!(blob instanceof Uint8Array)) return this.decodeUnreadFields(blob);
    let cached = this.unreadFields.get(peer);
    if (!cached || Buffer.compare(blob, cached.bytes) !== 0) {
      if (cached) {
        this.unreadFieldBytes -= cached.bytes.byteLength;
        this.unreadFields.delete(peer);
      }
      const decoded = this.decodeUnreadFields(blob);
      if (
        this.unreadFields.size >= MAX_CACHED_UNREAD_FIELDS ||
        this.unreadFieldBytes + blob.byteLength > MAX_CACHED_UNREAD_BYTES
      )
        return decoded;
      cached = { bytes: Uint8Array.from(blob), decoded };
      this.unreadFields.set(peer, cached);
      this.unreadFieldBytes += blob.byteLength;
    }
    return {
      ...cached.decoded,
      decreasedSeqs: cached.decoded.decreasedSeqs?.slice(),
      highlights: cached.decoded.highlights?.map((row) => ({ ...row })),
    };
  }

  private async decodeAndResolveSnapshots(
    rows: SqlRow[],
    reuseUnreadFields = false,
  ): Promise<UnreadInfoSnapshot[]> {
    const targets = new Map<number, GrayTipUnreadTarget[]>();
    const snapshots: UnreadInfoSnapshot[] = [];
    const signal = databaseRequestSignal();
    let sliceStarted = performance.now();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      const peer = String(row[2]);
      const split = peer.indexOf('_');
      const identity = {
        chatType: row[0] == null ? Number(peer.slice(0, split)) : Number(row[0]),
        uid: row[1] == null ? peer.slice(split + 1) : String(row[1]),
        peer,
        latestSeq: row[4] == null ? null : String(row[4]),
        latestSenderUid: row[5] == null ? undefined : String(row[5]),
      };
      try {
        const snapshot: UnreadInfoSnapshot = {
          ...identity,
          ...(reuseUnreadFields
            ? this.snapshotUnreadFields(peer, row[3])
            : this.decodeUnreadFields(row[3])),
        };
        this.collectGrayTipTarget(row, snapshot, targets);
        snapshots.push(snapshot);
      } catch {
        snapshots.push({ ...identity, readError: true });
      }
      if (
        reuseUnreadFields &&
        (index + 1) % 256 === 0 &&
        index + 1 < rows.length &&
        performance.now() - sliceStarted >= 8
      ) {
        await yieldToEventLoop(undefined, { signal });
        sliceStarted = performance.now();
      }
    }
    await Promise.all(
      snapshots.flatMap((snapshot) =>
        snapshot.chatType === 8 || snapshot.chatType === 134
          ? [this.resolveDeviceLatest(snapshot)]
          : [],
      ),
    );
    for (const [chatType, batch] of targets) await this.resolveGrayTipTargets(chatType, batch);
    if (rows.some((row) => Number(row[10]) === 1)) await this.resolveProtectedRecalls(snapshots);
    return snapshots;
  }

  async countDeviceIncoming(
    target: UnreadInfoTarget,
    after: string | undefined,
    through: string,
  ): Promise<number> {
    const [, endTime, endId] = through.split(':').map(BigInt);
    const [, startTime, startId] = after?.split(':').map(BigInt) ?? [0n, 0n, 0n];
    const [row] = await this.qq.query(
      `SELECT COUNT(*) FROM dataline_msg_table
       WHERE "40021"=? AND "40010"=? AND "40020"=? AND "40011"<>?
         AND ("40050","40001")>(?,?) AND ("40050","40001")<=(?,?)`,
      [
        target.uid,
        BigInt(target.chatType),
        target.uid,
        BigInt(GRAY_TIP),
        startTime!,
        startId!,
        endTime!,
        endId!,
      ],
    );
    return Number(row?.[0] ?? 0);
  }

  private async resolveDeviceLatest(snapshot: UnreadInfoSnapshot) {
    const { chatType, uid, deviceRead } = snapshot;
    if (snapshot.readError || !isDatalineUid(uid) || isDatalineSelfUid(uid)) return;
    const readTime = BigInt(deviceRead?.split(':')[1] ?? 0);
    // 只读取入站尾部的时间和 ID。同一秒按 ID 排序，自发消息及系统提示不会抬高尾部。
    const [message] = await this.qq
      .query(
        `SELECT "40050", "40001" FROM dataline_msg_table
         WHERE "40021"=? AND "40010"=? AND "40020"=? AND "40011"<>? AND "40050">=?
         ORDER BY "40050" DESC, "40001" DESC LIMIT 1`,
        [uid, BigInt(chatType), uid, BigInt(GRAY_TIP), readTime],
      )
      .catch(() => {
        snapshot.readError = true;
        return [];
      });
    if (message)
      snapshot.deviceLatest = readPosition(BigInt(String(message[0])), BigInt(String(message[1])));
  }

  private async resolveProtectedRecalls(snapshots: UnreadInfoSnapshot[]): Promise<void> {
    const targets = snapshots.flatMap<ProtectedRecallTarget>((snapshot) => {
      const { chatType, uid, msgSeq, localReadSeq, latestSeq, readError } = snapshot;
      if (readError || (chatType !== 1 && chatType !== 2) || latestSeq === null) return [];
      const serverRead = BigInt(msgSeq ?? 0);
      const localRead = BigInt(localReadSeq ?? '0');
      const after = serverRead > localRead ? serverRead : localRead;
      const through = positiveInt(latestSeq);
      if (after <= 0n || through === null || through <= after) return [];
      return [{ snapshot, kind: chatType === 1 ? 'c2c' : 'group', uid, after, through }];
    });
    for (let offset = 0; offset < targets.length; offset += PROTECTED_RECALL_TARGET_BATCH) {
      await this.resolveProtectedRecallBatch(
        targets.slice(offset, offset + PROTECTED_RECALL_TARGET_BATCH),
      );
    }
  }

  private async resolveProtectedRecallBatch(
    batch: ProtectedRecallTarget[],
    subdivided = false,
  ): Promise<void> {
    const signal = databaseRequestSignal();
    signal?.throwIfAborted();
    if (subdivided && batch.length === 1) {
      await this.resolveProtectedRecallTarget(batch[0]!);
      return;
    }
    const read = () =>
      this.qq.query(
        `WITH targets(idx, kind, conv, lo, hi) AS (VALUES ${batch.map(() => '(?,?,?,?,?)').join(',')})
         SELECT t.idx, r.orig_seq FROM targets t
         CROSS JOIN weq_recall_log r INDEXED BY ${RECALL_UNREAD_INDEX}
         WHERE r.table_kind=t.kind AND r.conv=t.conv AND r.orig_seq>t.lo AND r.orig_seq<=t.hi
         GROUP BY t.idx, r.orig_seq LIMIT ${PROTECTED_RECALL_RESULT_LIMIT + 1}`,
        batch.flatMap(({ kind, uid, after, through }, idx) => [
          BigInt(idx),
          kind,
          uid,
          after,
          through,
        ]),
      );
    let rows: SqlRow[] | undefined;
    try {
      rows =
        this.qq.supportsReadBudget && !databaseReadBudget()
          ? await withDatabaseReadBudget(15, read)
          : await read();
    } catch (error) {
      signal?.throwIfAborted();
      // 辅助表重建或读取失败时仍交付 QQ 小表。
      if (!(error instanceof Error) || !error.message.includes('database_query_execution_timeout'))
        return;
    }
    if (rows && rows.length <= PROTECTED_RECALL_RESULT_LIMIT) {
      for (const [idx, seq] of rows) {
        const snapshot = batch[Number(idx)]?.snapshot;
        if (!snapshot) continue;
        snapshot.recalledSeqs ??= [];
        snapshot.recalledSeqs.push(String(seq));
      }
      return;
    }
    if (batch.length > 1) {
      const middle = Math.floor(batch.length / 2);
      await this.resolveProtectedRecallBatch(batch.slice(0, middle), true);
      await this.resolveProtectedRecallBatch(batch.slice(middle), true);
      return;
    }
    await this.resolveProtectedRecallTarget(batch[0]!);
  }

  private async resolveProtectedRecallTarget({
    snapshot,
    kind,
    uid,
    after,
    through,
  }: ProtectedRecallTarget) {
    try {
      const sequences = await this.pageProtectedRecallSeqs(kind, uid, after, through);
      if (sequences.length) snapshot.recalledSeqs = sequences;
    } catch {
      databaseRequestSignal()?.throwIfAborted();
    }
  }

  /** 单个会话超出预算或结果较大时，用索引顺序逐页读完，再交付减项。 */
  private async pageProtectedRecallSeqs(
    kind: ProtectedRecallTarget['kind'],
    uid: string,
    after: bigint,
    through: bigint,
  ): Promise<string[]> {
    const sequences = new Set<string>();
    const statement = `SELECT orig_seq FROM weq_recall_log INDEXED BY ${RECALL_UNREAD_INDEX}
         WHERE table_kind=? AND conv=? AND orig_seq>? AND orig_seq<=? ORDER BY orig_seq LIMIT ?`;
    let cursor: SqlValue = after;
    let size = 64;
    for (;;) {
      const params = [kind, uid, cursor, through];
      let page: { rows: SqlRow[]; limit: number };
      try {
        page = await this.qq.queryPage(statement, params, size);
      } catch (error) {
        databaseRequestSignal()?.throwIfAborted();
        if (
          !(error instanceof Error) ||
          !error.message.includes('database_query_execution_timeout')
        )
          throw error;
        // 单条索引读取在原生预算内仍无法完成时，保留这条结果的读取机会。
        page = { rows: await this.qq.query(statement, [...params, 1n]), limit: 1 };
      }
      for (const [seq] of page.rows) sequences.add(String(seq));
      if (page.rows.length < page.limit) return [...sequences];
      const [seq] = page.rows.at(-1)!;
      if (seq == null) throw new Error('撤回索引分页缺少游标');
      // 当前序号已经加入结果，下一页可以直接跨过这个序号的其他记录。
      cursor = seq;
      size = page.limit;
    }
  }

  private collectGrayTipTarget(
    row: SqlRow,
    snapshot: UnreadInfoSnapshot,
    targets: Map<number, GrayTipUnreadTarget[]>,
  ): void {
    const { chatType, uid, latestSeq, localReadSeq, msgSeq, decreasedSeqs } = snapshot;
    if (!(row[6] instanceof Uint8Array) || (chatType !== 1 && chatType !== 2)) return;
    const seq = positiveInt(latestSeq);
    const serverRead = BigInt(msgSeq ?? 0);
    const localRead = BigInt(localReadSeq ?? '0');
    if (!seq || (!serverRead && !localRead) || seq <= serverRead || seq <= localRead) return;
    if (latestSeq !== null && decreasedSeqs?.includes(latestSeq)) return;
    const tip = unreadGrayTip(row[6]);
    if (!tip) return;

    // 小表此时只给灰条的发送者，不能拿它替代同序号正文的发送者。
    delete snapshot.latestSenderUid;
    const partition = positiveInt(chatType === 1 ? row[8] : uid);
    if (!partition) return;
    const batch = targets.get(chatType) ?? [];
    batch.push({ snapshot, partition, seq, msgId: positiveInt(row[7]), recall: tip === 'recall' });
    targets.set(chatType, batch);
  }

  private async resolveGrayTipTargets(chatType: number, targets: GrayTipUnreadTarget[]) {
    const table = chatType === 1 ? 'c2c_msg_table' : 'group_msg_table';
    let indexed = this.seqIndexes.get(table);
    if (!indexed) {
      indexed = this.qq.hasIndexPrefix(table, ['40027', '40003']).catch(() => {
        this.seqIndexes.delete(table);
        return false;
      });
      this.seqIndexes.set(table, indexed);
    }
    if (!(await indexed)) return;

    // 撤回可能改正文而不改原消息类型；只排除预览明确指向的原消息。
    const content = `m."40003" IS NOT NULL AND m."40011" IS NOT ${GRAY_TIP}
      AND NOT (t.recall=1 AND t.msgId IS NOT NULL AND m."40001" IS t.msgId)`;
    for (let offset = 0; offset < targets.length; offset += 128) {
      databaseRequestSignal()?.throwIfAborted();
      const batch = targets.slice(offset, offset + 128);
      try {
        const rows = await this.qq.query(
          `WITH targets(idx, partition, seq, msgId, recall) AS (VALUES ${batch.map(() => '(?,?,?,?,?)').join(',')})
           SELECT t.idx, MAX(m."40001"=t.msgId AND (t.recall=1 OR m."40011"=${GRAY_TIP})),
             MIN(CASE WHEN ${content} THEN COALESCE(m."40020", '') END),
             MAX(CASE WHEN ${content} THEN COALESCE(m."40020", '') END)
           FROM targets t LEFT JOIN ${table} m ON m."40027"=t.partition AND m."40003"=t.seq
           GROUP BY t.idx`,
          batch.flatMap(({ partition, seq, msgId, recall }, idx) => [
            BigInt(idx),
            partition,
            seq,
            msgId,
            recall ? 1n : 0n,
          ]),
        );
        for (const [idx, matched, firstSender, lastSender] of rows) {
          const snapshot = batch[Number(idx)]?.snapshot;
          if (!snapshot) continue;
          if (firstSender === null && Number(matched) === 1) snapshot.latestSeqNonMessage = true;
          if (typeof firstSender === 'string' && firstSender && firstSender === lastSender)
            snapshot.latestSenderUid = firstSender;
        }
      } catch {
        // 单点校验失败时不猜发送者，也不隐藏小表算出的未读。
      }
    }
  }

  /**
   * Mark one conversation as read: raise `41002` (last-read seq) to the
   * conversation's newest seq and drop the `50060` notify-highlight groups, so
   * the unread dot goes away and — crucially — WeQ does not re-offer the same
   * highlight jumps the next time the chat is opened.
   *
   * The blob is rewritten through the wire-level edit tree (see
   * `@weq/codec/raw`): a node we don't touch is copied straight out of the
   * original bytes, so the columns we have NOT reverse-engineered
   * (`41024` / `41027` / `41032` / `50006` / `50007` …) survive bit-identically.
   *
   * @param latestSeq newest seq to write; when omitted it is read from
   *   `recent_contact_v3_table.40003` (same DB) so callers don't need to thread
   *   the conversation watermark through.
   * @returns true when the row was actually updated.
   */
  async markRead(
    chatType: number,
    uid: string,
    latestSeq?: number | bigint | string,
  ): Promise<boolean> {
    const target = latestSeq === undefined ? await this.latestSeqOf(uid) : BigInt(latestSeq);
    if (target === null || target <= 0n) return false;
    // 重试不得跟随新消息抬高目标，否则会把尚未展示的消息也标成已读。
    for (let attempt = 0; attempt < 3; attempt++) {
      const changed = await this.markReadAttempt(chatType, uid, target);
      if (changed !== null) return changed;
    }
    throw new Error('已读状态更新冲突，请稍后重试。');
  }

  /** 手动未读只改标志；已读抬高固定水位，未知字段逐字节保留。 */
  async setReadState(
    chatType: number,
    uid: string,
    readSeq: string,
    throughSeq: string,
    unread: boolean,
  ): Promise<UnreadReadChange> {
    if (!/^\d{1,20}$/.test(readSeq) || !/^\d{1,20}$/.test(throughSeq))
      throw new Error('无效的阅读位置');
    const peer = `${chatType}_${uid}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = await this.qq.query(
        `SELECT "48902" FROM msg_unread_info_table WHERE "48901" = ? LIMIT 1`,
        [peer],
      );
      const existing = rows[0]?.[0];
      if (existing != null && !(existing instanceof Uint8Array))
        throw new Error('无法解析会话未读状态');
      const before = existing instanceof Uint8Array ? existing : null;
      let tree = before?.length
        ? buildEditTree(before)
        : [nestedNode(48902, [varintNode(40010, chatType), utf8Node(40021, uid)])];
      const info = tree.find((node) => node.tag === 48902);
      if (!info?.children) throw new Error('无法解析会话未读状态');
      const readNode = info.children.find((node) => node.tag === 41002);
      const stored = readNode ? readVarintText(readNode) : 0n;
      const requested = BigInt(readSeq);
      const target = unread || requested < stored ? stored : requested;
      tree = readNode
        ? updateNode(tree, readNode.id, (node) => ({
            ...node,
            value: { kind: 'varint', text: String(target) },
          }))
        : appendNode(tree, info.id, varintNode(41002, target));
      const flag = info.children.find((node) => node.tag === 41027);
      tree = flag
        ? updateNode(tree, flag.id, (node) => ({
            ...node,
            value: { kind: 'varint', text: unread ? '1' : '0' },
          }))
        : appendNode(tree, info.id, varintNode(41027, unread ? 1 : 0));
      if (!unread) {
        for (const node of readHighlightRemovals(info, BigInt(throughSeq)))
          tree = removeNode(tree, node.id);
      }
      const after = encodeEditTree(tree, before ?? new Uint8Array(0));
      const changed = rows.length
        ? await this.qq.write(
            `UPDATE msg_unread_info_table SET "48902" = ? WHERE "48901" = ? AND "48902" IS ?`,
            [after, peer, existing ?? null],
          )
        : await this.qq.write(
            `INSERT OR IGNORE INTO msg_unread_info_table ("48901", "48902") VALUES (?, ?)`,
            [peer, after],
          );
      if (changed > 0)
        return {
          chatType,
          uid,
          existed: rows.length > 0,
          before,
          after,
          afterReadSeq: String(target),
          beforeReadSeq: readNode ? String(stored) : undefined,
          afterMarkUnread: unread,
        };
    }
    throw new Error('未读状态更新冲突，请稍后重试');
  }

  /** 仅在阅读水位仍属于本次操作时撤销；合并后来到达的提醒和未知字段。 */
  async undoReadState(change: UnreadReadChange): Promise<boolean> {
    const peer = `${change.chatType}_${change.uid}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = await this.qq.query(
        `SELECT "48902" FROM msg_unread_info_table WHERE "48901" = ? LIMIT 1`,
        [peer],
      );
      const current = rows[0]?.[0];
      if (!(current instanceof Uint8Array) || !current.length) return false;
      if (
        current.length === change.after.length &&
        current.every((byte, index) => byte === change.after[index])
      ) {
        const changed = change.existed
          ? await this.qq.write(
              `UPDATE msg_unread_info_table SET "48902" = ? WHERE "48901" = ? AND "48902" = ?`,
              [change.before, peer, current],
            )
          : await this.qq.write(
              `DELETE FROM msg_unread_info_table WHERE "48901" = ? AND "48902" = ?`,
              [peer, current],
            );
        if (changed > 0) return true;
        continue;
      }
      let tree = buildEditTree(current);
      const info = tree.find((node) => node.tag === 48902);
      const readNode = info?.children?.find((node) => node.tag === 41002);
      if (!info?.children || !readNode || String(readVarintText(readNode)) !== change.afterReadSeq)
        return false;
      const flag = info.children.find((node) => node.tag === 41027);
      if (
        change.afterMarkUnread !== undefined &&
        Boolean(flag && readVarintText(flag) !== 0n) !== change.afterMarkUnread
      )
        return false;
      const original = change.before?.length
        ? buildEditTree(change.before).find((node) => node.tag === 48902)
        : undefined;
      const originalRead = original?.children?.find((node) => node.tag === 41002);
      tree = originalRead
        ? updateNode(tree, readNode.id, (node) => ({
            ...node,
            value: { kind: 'varint', text: String(readVarintText(originalRead)) },
          }))
        : removeNode(tree, readNode.id);
      const originalFlag = original?.children?.find((node) => node.tag === 41027);
      if (flag)
        tree = originalFlag
          ? updateNode(tree, flag.id, (node) => ({
              ...node,
              value: { kind: 'varint', text: String(readVarintText(originalFlag)) },
            }))
          : removeNode(tree, flag.id);
      for (const group of original ? findAll(original, 50060) : []) {
        const kind = readVarintChild(group, 50000);
        const currentInfo = tree.find((node) => node.tag === 48902)!;
        const matching = findAll(currentInfo, 50060).find(
          (candidate) => readVarintChild(candidate, 50000) === kind,
        );
        if (matching) {
          const sequences = new Set(
            findAll(matching, 50040).map((item) => readVarintChild(item, 50020)),
          );
          for (const item of findAll(group, 50040)) {
            if (!sequences.has(readVarintChild(item, 50020)))
              tree = appendNode(tree, matching.id, copyRawNode(item, change.before!));
          }
        } else {
          const ext = currentInfo.children?.find((node) => node.tag === 50005);
          const copy = copyRawNode(group, change.before!);
          tree = ext
            ? appendNode(tree, ext.id, copy)
            : appendNode(
                tree,
                currentInfo.id,
                nestedNode(50005, [...extHeader(change.uid, change.chatType), copy]),
              );
        }
      }
      const after = encodeEditTree(tree, current);
      const changed = await this.qq.write(
        `UPDATE msg_unread_info_table SET "48902" = ? WHERE "48901" = ? AND "48902" = ?`,
        [after, peer, current],
      );
      if (changed > 0) return true;
    }
    throw new Error('撤销时未读状态发生冲突，请重试');
  }

  private async markReadAttempt(
    chatType: number,
    uid: string,
    target: bigint,
  ): Promise<boolean | null> {
    const peer = `${chatType}_${uid}`;
    const rows = await this.qq.query(
      `SELECT "48902" FROM msg_unread_info_table WHERE "48901" = ? LIMIT 1`,
      [peer],
    );
    const row = rows[0];
    if (!row) return false;

    const bytes = row[0] as Uint8Array | null;
    if (!bytes || bytes.length === 0) return false;

    const tree = buildEditTree(bytes);
    const info = tree.find((node) => node.tag === 48902);
    if (!info?.children) return false;

    const readNode = info.children.find((node) => node.tag === 41002);
    // 50060 在 50005 内，遍历整棵树处理所有提醒组。
    const removable = readHighlightRemovals(info, target);
    const storedRead = readNode ? readVarintText(readNode) : 0n;
    const flag = info.children.find((node) => node.tag === 41027);
    const markedUnread = flag && readVarintText(flag) !== 0n;
    if (storedRead > target) target = storedRead;
    const alreadyRead = !markedUnread && removable.length === 0 && readNode && storedRead >= target;
    if (alreadyRead) return false;

    let next = tree;
    if (readNode) {
      next = updateNode(next, readNode.id, (node) => ({
        ...node,
        value: { kind: 'varint', text: target.toString() },
      }));
    } else {
      // No 41002 yet (a conversation row created before any read marker).
      // Append one so the read watermark lands where QQ expects it.
      const appended = newNode(41002, 0);
      appended.value = { kind: 'varint', text: target.toString() };
      next = appendNode(next, info.id, appended);
    }
    for (const node of removable) {
      next = removeNode(next, node.id);
    }
    if (flag)
      next = updateNode(next, flag.id, (node) => ({
        ...node,
        value: { kind: 'varint', text: '0' },
      }));

    const encoded = encodeEditTree(next, bytes);
    const changed = await this.qq.write(
      `UPDATE msg_unread_info_table SET "48902" = ? WHERE "48901" = ? AND "48902" = ?`,
      [encoded, peer, bytes],
    );
    return changed > 0 ? true : null;
  }

  /**
   * Append one notify-highlight hit to a conversation's `48902` blob so the
   * conversation shows the matching badge in **both** WeQ and QQ itself. Used
   * by the group-keyword reminder (kind `2006`).
   *
   * Like {@link markRead} this rewrite goes through the wire-level edit tree:
   * every field we have not reverse-engineered survives byte-for-byte. When the
   * conversation has no unread row yet, a minimal `48902` blob carrying just
   * `chatType` / `peerUid` / the highlight is inserted instead.
   *
   * Idempotent per `(kind, msgSeq)`: re-adding the same hit is a no-op.
   *
   * @returns true when the row was actually written.
   */
  async addHighlight(
    chatType: number,
    uid: string,
    highlight: UnreadHighlightInput,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const changed = await this.addHighlightAttempt(chatType, uid, highlight);
      if (changed !== null) return changed;
    }
    throw new Error('提醒状态更新冲突，请稍后重试。');
  }

  private async addHighlightAttempt(
    chatType: number,
    uid: string,
    highlight: UnreadHighlightInput,
  ): Promise<boolean | null> {
    const peer = `${chatType}_${uid}`;
    const rows = await this.qq.query(
      `SELECT "48902" FROM msg_unread_info_table WHERE "48901" = ? LIMIT 1`,
      [peer],
    );
    const existing = rows[0]?.[0];
    const bytes = existing instanceof Uint8Array && existing.length > 0 ? existing : null;

    const itemNode = nestedNode(50040, [
      varintNode(50020, highlight.msgSeq),
      utf8Node(50022, highlight.senderUid),
      varintNode(50023, highlight.sendTime),
      utf8Node(50024, highlight.text),
    ]);
    const groupNode = () => nestedNode(50060, [varintNode(50000, highlight.kind), itemNode]);

    let tree: PbNode[];
    if (bytes) {
      tree = buildEditTree(bytes);
      const info = tree.find((node) => node.tag === 48902);
      if (!info?.children) return false;
      const read = info.children.find((node) => node.tag === 41002);
      if (read && readVarintText(read) >= BigInt(highlight.msgSeq)) return false;

      // Reuse the existing group of the same kind when there is one — QQ's
      // shape is one 50060 per category with many 50040 items under it.
      const group = findAll(info, 50060).find(
        (node) => readVarintChild(node, 50000) === highlight.kind,
      );
      if (group) {
        const dup = findAll(group, 50040).some(
          (node) => readVarintChild(node, 50020) === highlight.msgSeq,
        );
        if (dup) return false;
        tree = appendNode(tree, group.id, itemNode);
      } else {
        const node = groupNode();
        const ext = info.children.find((child) => child.tag === 50005);
        tree = ext
          ? appendNode(tree, ext.id, node)
          : appendNode(tree, info.id, nestedNode(50005, [...extHeader(uid, chatType), node]));
      }
    } else {
      // No row yet: a minimal 48902 carrying only the highlight. 41002 sits one
      // below the hit so the conversation still reads as unread.
      const readSeq = highlight.msgSeq > 1 ? highlight.msgSeq - 1 : 0;
      tree = [
        nestedNode(48902, [
          varintNode(40010, chatType),
          utf8Node(40021, uid),
          ...(readSeq > 0 ? [varintNode(41002, readSeq)] : []),
          nestedNode(50005, [...extHeader(uid, chatType), groupNode()]),
        ]),
      ];
    }

    const encoded = encodeEditTree(tree, bytes ?? new Uint8Array(0));
    if (rows.length > 0) {
      const changed = await this.qq.write(
        `UPDATE msg_unread_info_table SET "48902" = ? WHERE "48901" = ? AND "48902" IS ?`,
        [encoded, peer, existing ?? null],
      );
      return changed > 0 ? true : null;
    }
    const changed = await this.qq.write(
      `INSERT OR IGNORE INTO msg_unread_info_table ("48901", "48902") VALUES (?, ?)`,
      [peer, encoded],
    );
    return changed > 0 ? true : null;
  }

  /** Conversation watermark (`recent_contact_v3_table.40003`) or null when absent. */
  private async latestSeqOf(uid: string): Promise<bigint | null> {
    const rows = await this.qq.query(
      `SELECT "40003" FROM recent_contact_v3_table WHERE "40021" = ? LIMIT 1`,
      [uid],
    );
    const value = rows[0]?.[0];
    if (value === undefined || value === null) return null;
    return BigInt(value as number | bigint | string);
  }

  close(): void {
    this.unreadFields.clear();
    this.unreadFieldBytes = 0;
    this.qq.close();
  }
}

function readHighlightRemovals(info: PbNode, target: bigint): PbNode[] {
  const removable: PbNode[] = [];
  for (const group of findAll(info, 50060)) {
    const items = findAll(group, 50040);
    const readItems = items.filter((item) => {
      const seq = readVarintChild(item, 50020);
      return seq !== null && BigInt(seq) <= target;
    });
    if (!items.length || readItems.length === items.length) removable.push(group);
    else removable.push(...readItems);
  }
  return removable;
}

/** 跨 BLOB 合并节点时重新分配节点 id，不能沿用另一棵树的字节偏移。 */
function copyRawNode(node: PbNode, source: Uint8Array): PbNode {
  const encoded = encodeEditTree([node], source);
  const fresh = buildEditTree(encoded)[0]!;
  const copy = newNode(fresh.tag, fresh.wireType);
  copy.value = fresh.value;
  if (fresh.children) copy.children = fresh.children.map((child) => copyRawNode(child, encoded));
  return copy;
}

/** Read a `varint`-kind node's decimal text back as a BigInt (0 when malformed). */
function readVarintText(node: PbNode): bigint {
  if (node.value.kind !== 'varint' && node.value.kind !== 'timestamp') return 0n;
  try {
    return BigInt(node.value.text);
  } catch {
    return 0n;
  }
}

/** Every node under `root` (inclusive) whose tag matches, depth-first. */
function findAll(root: PbNode, tag: number): PbNode[] {
  const out: PbNode[] = [];
  if (root.tag === tag) out.push(root);
  for (const child of root.children ?? []) {
    out.push(...findAll(child, tag));
  }
  return out;
}

/** A freshly-built, dirty `varint` (wire 0) field node. */
function varintNode(tag: number, value: number | bigint): PbNode {
  const node = newNode(tag, 0);
  node.value = { kind: 'varint', text: value.toString() } satisfies PbValue;
  return node;
}

/** A freshly-built, dirty UTF-8 (wire 2) field node. */
function utf8Node(tag: number, text: string): PbNode {
  const node = newNode(tag, 2);
  node.value = { kind: 'utf8', text } satisfies PbValue;
  return node;
}

/** A freshly-built, dirty nested-message (wire 2) field node. */
function nestedNode(tag: number, children: PbNode[]): PbNode {
  const node = newNode(tag, 2);
  node.value = { kind: 'nested' } satisfies PbValue;
  node.children = children;
  return node;
}

/** The `50001` peerUid + `50002` chatType header shared by every `50005` ext. */
function extHeader(uid: string, chatType: number): PbNode[] {
  return [utf8Node(50001, uid), varintNode(50002, chatType)];
}

/** Read a nested node's scalar child (by tag) back as a number, or null. */
function readVarintChild(parent: PbNode, tag: number): number | null {
  const child = parent.children?.find((node) => node.tag === tag);
  if (!child) return null;
  const value = readVarintText(child);
  return Number(value);
}

type DecodedExt = NonNullable<
  NonNullable<ReturnType<ProtoMsg<typeof UnreadInfo>['decode']>['info']>['ext']
>;

/**
 * 展平全部提醒项；同类较早的命中也要留给重要消息列表。
 */
function extractHighlights(ext: DecodedExt | undefined): UnreadHighlight[] {
  const groups = ext?.highlight;
  if (!groups?.length) return [];

  const out: UnreadHighlight[] = [];
  for (const group of groups) {
    const rawKind = group.kind ?? -1;
    for (const item of group.items ?? []) {
      if (item.msgSeq === undefined) continue;
      out.push({
        kind: HIGHLIGHT_KIND_BY_CODE[rawKind] ?? 'unknown',
        rawKind,
        msgSeq: item.msgSeq,
        senderUid: item.senderUid ?? '',
        sendTime: item.sendTime ?? 0,
        text: item.text ?? '',
      });
    }
  }
  return out;
}
