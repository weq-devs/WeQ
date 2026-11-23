import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NtHelperBinding, SqlValue } from '@weq/native';
import type { C2cMsg, GroupMsg } from '@weq/db';
import { scheduleDatabase } from '@weq/db';
import { decodeMessage } from '@weqbot/protocol';
import { decodePushEnvelope } from '@weqbot/protocol/push';
import { wrapClientMessage } from '@weqbot/protocol/qq-sync';
import type { RecallTarget, ObservedPush } from '@weqbot/protocol/qq-sync';
import { toGapMessage, type GapFetchedMessage } from './gap_history';
import { toRenderElements } from './msg_view';
import type { UnreadSequenceRange } from './unread_info';

type Native = Pick<NtHelperBinding, 'executeSql' | 'executeSqlWrite' | 'closeDb'>;
type StoredRecall = RecallTarget & { at: number; localId?: string };
const NATIVE_PAGE_ROWS = 128;
const WRITE_ROWS = 64;
const PENDING_KIND = "CASE WHEN json_valid(payload) THEN json_extract(payload,'$.kind') END";
const PENDING_CONV = "CASE WHEN json_valid(payload) THEN json_extract(payload,'$.conv') END";

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? { __bigint: String(item) } : item,
  );
}
function parse<T>(value: unknown): T {
  return JSON.parse(String(value), (_key, item) =>
    item && typeof item === 'object' && typeof item.__bigint === 'string'
      ? BigInt(item.__bigint)
      : item,
  ) as T;
}

/** 来源由存储位置确定，旧留存副本也能在读取时补齐。 */
function markRetained(message: GapFetchedMessage): GapFetchedMessage {
  return message.recall ? { ...message, recall: { ...message.recall, retained: true } } : message;
}

/** 独立于 QQ 库的原文副本。未撤回快照保留七天、最多一万条，已撤回正文持久保留。 */
export class RecallArchive {
  private ready?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private recoveredPending = false;
  constructor(
    private readonly nt: Native,
    readonly path: string,
    private readonly protects: (kind: 'c2c' | 'group', conv: string) => boolean,
    private readonly onRecall: (message: GapFetchedMessage) => void,
  ) {}

  private async prepare() {
    this.ready ??= (async () => {
      mkdirSync(dirname(this.path), { recursive: true });
      if (!existsSync(this.path)) writeFileSync(this.path, '', { flag: 'wx', mode: 0o600 });
      await this.nt.executeSqlWrite(
        this.path,
        `CREATE TABLE IF NOT EXISTS recall_snapshot (
          identity TEXT PRIMARY KEY, kind TEXT, conv TEXT, msg_id TEXT, seq INTEGER, sender TEXT, client_seq TEXT,
          observed INTEGER, recalled INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL)`,
        null,
      );
      const columns = await this.nt.executeSql(
        this.path,
        'PRAGMA table_info(recall_snapshot)',
        null,
      );
      if (!columns.some((row) => row[1] === 'identity')) {
        await this.nt.executeSqlWrite(
          this.path,
          'ALTER TABLE recall_snapshot ADD COLUMN identity TEXT',
          null,
        );
      }
      await this.nt.executeSqlWrite(
        this.path,
        `UPDATE recall_snapshot SET identity=kind||':'||conv||':'||seq||':'||sender||':'||
         COALESCE(NULLIF(json_extract(payload,'$.msgRandom'),''),msg_id) WHERE identity IS NULL`,
        null,
      );
      await this.nt.executeSqlWrite(
        this.path,
        'CREATE UNIQUE INDEX IF NOT EXISTS recall_snapshot_identity ON recall_snapshot(identity)',
        null,
      );
      await this.nt.executeSqlWrite(
        this.path,
        'CREATE INDEX IF NOT EXISTS recall_snapshot_match ON recall_snapshot(kind,conv,seq,sender)',
        null,
      );
      await this.nt.executeSqlWrite(
        this.path,
        'CREATE INDEX IF NOT EXISTS recall_snapshot_id ON recall_snapshot(msg_id)',
        null,
      );
      await this.nt.executeSqlWrite(
        this.path,
        'CREATE INDEX IF NOT EXISTS recall_snapshot_unrecalled_scan ON recall_snapshot(recalled) WHERE recalled=0',
        null,
      );
      await this.nt.executeSqlWrite(
        this.path,
        'CREATE INDEX IF NOT EXISTS recall_snapshot_unrecalled_age ON recall_snapshot(observed) WHERE recalled=0',
        null,
      );
      await this.nt.executeSqlWrite(
        this.path,
        'CREATE TABLE IF NOT EXISTS recall_pending (identity TEXT PRIMARY KEY, at INTEGER, payload TEXT)',
        null,
      );
      await this.nt.executeSqlWrite(
        this.path,
        'CREATE INDEX IF NOT EXISTS recall_pending_age ON recall_pending(at)',
        null,
      );
      await this.nt.executeSqlWrite(
        this.path,
        `CREATE INDEX IF NOT EXISTS recall_pending_scope ON recall_pending(${PENDING_KIND},${PENDING_CONV},at)`,
        null,
      );
    })().catch((error) => {
      this.ready = undefined;
      throw error;
    });
    await this.ready;
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes
      .catch(() => undefined)
      .then(async () => {
        await this.prepare();
        return operation();
      });
    this.writes = result;
    return result;
  }

  async observe(messages: GapFetchedMessage[], recalls: StoredRecall[] = []) {
    return this.enqueue(async () => {
      const saved = messages.filter(
        (m) =>
          this.protects(m.kind, m.conv) &&
          m.elements.length &&
          !m.elements.some((element) => element.type.startsWith('grayTip')),
      );
      for (let i = 0; i < saved.length; i += WRITE_ROWS) {
        const batch = saved.slice(i, i + WRITE_ROWS);
        await this.nt.executeSqlWrite(
          this.path,
          `INSERT INTO recall_snapshot(identity,kind,conv,msg_id,seq,sender,client_seq,observed,payload)
           VALUES ${batch.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')} ON CONFLICT(identity) DO UPDATE SET
           msg_id=excluded.msg_id,seq=excluded.seq,client_seq=excluded.client_seq,payload=excluded.payload
           WHERE recall_snapshot.recalled=0
             AND (json_extract(excluded.payload,'$.sourceFormat') IS NULL OR json_extract(recall_snapshot.payload,'$.sourceFormat') IS NOT NULL)`,
          batch.flatMap((message) => [
            `${message.kind}:${message.conv}:${message.msgSeq}:${message.senderUid}:${message.msgRandom || message.msgId}`,
            message.kind,
            message.conv,
            message.msgId,
            BigInt(message.msgSeq),
            message.senderUid,
            message.clientSeq ?? '',
            Date.now(),
            stringify(message),
          ]),
        );
      }
      const protectedRecalls = recalls.filter((recall) => this.protects(recall.kind, recall.conv));
      for (let i = 0; i < protectedRecalls.length; i += WRITE_ROWS) {
        const batch = protectedRecalls.slice(i, i + WRITE_ROWS);
        await this.nt.executeSqlWrite(
          this.path,
          `INSERT OR IGNORE INTO recall_pending(identity,at,payload) VALUES ${batch.map(() => '(?,?,?)').join(',')}`,
          batch.flatMap((recall) => [
            stringify([
              recall.kind,
              recall.conv,
              recall.localId ?? recall.messageUid,
              recall.sequence,
              recall.clientSequence,
              recall.timestamp,
              recall.senderUid,
            ]),
            recall.at,
            stringify(recall),
          ]),
        );
      }
      if (saved.length || protectedRecalls.length) {
        const scopes = new Set(
          [...saved, ...protectedRecalls].map(({ kind, conv }) => JSON.stringify([kind, conv])),
        );
        try {
          // 启动后先补一次写入和匹配之间中断的工作，此后只处理本批变化涉及的会话。
          await this.applyPending(this.recoveredPending ? [...scopes] : undefined);
          this.recoveredPending = true;
        } catch (error) {
          this.recoveredPending = false;
          throw error;
        }
      }
      await this.nt.executeSqlWrite(
        this.path,
        `DELETE FROM recall_snapshot WHERE rowid IN (
          SELECT rowid FROM recall_snapshot INDEXED BY recall_snapshot_unrecalled_age
            WHERE recalled=0 AND observed<?
          UNION ALL SELECT rowid FROM (
            SELECT rowid FROM recall_snapshot INDEXED BY recall_snapshot_unrecalled_age WHERE recalled=0
              ORDER BY observed DESC, rowid DESC LIMIT -1 OFFSET 10000
          )
        )`,
        [Date.now() - 7 * 86400000],
      );
      await this.nt.executeSqlWrite(
        this.path,
        `DELETE FROM recall_pending WHERE rowid IN (
          SELECT rowid FROM recall_pending INDEXED BY recall_pending_age WHERE at<?
          UNION ALL SELECT rowid FROM (
            SELECT rowid FROM recall_pending INDEXED BY recall_pending_age
              ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET 1000
          )
        )`,
        [Math.floor(Date.now() / 1000) - 7 * 86400],
      );
    });
  }

  private async applyPending(scopes?: string[]) {
    const pending = await this.nt.executeSql(
      this.path,
      scopes
        ? `WITH affected AS (SELECT value FROM json_each(?))
           SELECT identity,payload FROM affected
           CROSS JOIN recall_pending INDEXED BY recall_pending_scope
           WHERE (${PENDING_KIND})=json_extract(affected.value,'$[0]')
             AND (${PENDING_CONV})=json_extract(affected.value,'$[1]')
           ORDER BY at`
        : 'SELECT identity,payload FROM recall_pending ORDER BY at',
      scopes ? [JSON.stringify(scopes)] : null,
    );
    for (const [identity, payload] of pending) {
      const recall = parse<StoredRecall>(payload);
      const values: SqlValue[] = [recall.kind, recall.conv];
      let where = '';
      if (recall.localId) {
        where = 'AND msg_id=?';
        values.push(recall.localId);
      } else if (recall.kind === 'group' && recall.sequence) {
        where = 'AND seq=? AND sender=?';
        values.push(recall.sequence, recall.senderUid);
      } else if (recall.clientSequence && recall.senderUid) {
        where = 'AND client_seq=? AND sender=?';
        values.push(String(recall.clientSequence), recall.senderUid);
        if (recall.timestamp) {
          where += " AND CAST(json_extract(payload,'$.sendTime') AS INTEGER)=?";
          values.push(recall.timestamp);
        }
      } else continue;
      const matches = await this.nt.executeSql(
        this.path,
        `SELECT payload,recalled FROM recall_snapshot WHERE kind=? AND conv=? ${where} LIMIT 2`,
        values,
      );
      if (matches.length !== 1) continue;
      const [stored, recalled] = matches[0]!;
      const message = parse<GapFetchedMessage>(stored);
      if (recall.senderUid && recall.senderUid !== message.senderUid) continue;
      if (!recalled) {
        message.recall = {
          revokeUid: recall.revokeUid,
          sameSender: recall.revokeUid === message.senderUid,
          recallTs: recall.at,
        };
        await this.nt.executeSqlWrite(
          this.path,
          'UPDATE recall_snapshot SET payload=?,recalled=1 WHERE kind=? AND conv=? AND msg_id=? AND recalled=0',
          [stringify(message), message.kind, message.conv, message.msgId],
        );
        this.onRecall(markRetained(message));
      }
      await this.nt.executeSqlWrite(this.path, 'DELETE FROM recall_pending WHERE identity=?', [
        identity!,
      ]);
    }
  }

  async observeNative(rows: (C2cMsg | GroupMsg)[]) {
    const messages: GapFetchedMessage[] = [];
    const recalls: StoredRecall[] = [];
    for (const row of rows) {
      const kind = 'targetGroupCode' in row ? 'group' : 'c2c';
      const conv = 'targetGroupCode' in row ? row.targetGroupCode : row.targetUid;
      if (!this.protects(kind, conv)) continue;
      const elements = toRenderElements(row.elements);
      const tip = elements.find((element) => element.type === 'grayTipRevoke');
      if (tip?.type === 'grayTipRevoke') {
        recalls.push({
          kind,
          conv,
          localId: String(row.msgId),
          senderUid: tip.data.recallSenderUid || row.senderUid,
          revokeUid: tip.data.recallRevokeUid,
          at: Math.floor(Date.now() / 1000),
        });
      } else {
        messages.push({
          kind,
          conv,
          msgId: String(row.msgId),
          msgSeq: String(row.msgSeq),
          msgRandom: row.msgRandom?.toString(),
          clientSeq: 'clientSeq' in row ? row.clientSeq?.toString() : undefined,
          senderUid: row.senderUid,
          senderUin: String(row.senderUin),
          sendTime: String(row.sendTime),
          ntSeqVerified: true,
          elements,
          decoration: row.decoration,
        });
      }
    }
    if (messages.length || recalls.length) await this.observe(messages, recalls);
  }

  async observePush(events: ObservedPush[], selfUid: string, at: number) {
    const messages: GapFetchedMessage[] = [];
    const recalls: StoredRecall[] = [];
    for (const event of events) {
      recalls.push(...event.recalls.map((recall) => ({ ...recall, at })));
      if (event.recalls.length) continue;
      try {
        const bytes = Buffer.from(event.raw, 'base64');
        const decoded = decodeMessage(bytes);
        const raw = decodePushEnvelope(wrapClientMessage(bytes)).messages[0];
        const newId = (raw?.contentHead as { newId?: bigint } | undefined)?.newId;
        if (![82, 166, 167, 141].includes(decoded.head.msgType)) continue;
        const kind = decoded.head.msgType === 82 ? 'group' : 'c2c';
        const conv =
          kind === 'group'
            ? String(decoded.session.uin)
            : decoded.sender.uid === selfUid
              ? decoded.session.uid
              : decoded.sender.uid;
        if (!conv || !this.protects(kind, conv)) continue;
        const message = toGapMessage(kind, conv, decoded);
        if (kind === 'c2c' && !message.ntSeqVerified) continue;
        // 协议 newId 与 QQ 本地消息 ID 不同；random、会话序号和发送方用于对账。
        messages.push({
          ...message,
          msgId: newId && newId > 0n ? String(newId) : message.msgId,
          sourceFormat: 'protocol',
          protocolRaw: event.raw,
          msgRandom: String(decoded.head.msgId),
        });
      } catch {
        /* 保留其他可识别的消息。 */
      }
    }
    if (messages.length || recalls.length) await this.observe(messages, recalls);
  }

  async list(kind?: 'c2c' | 'group', conv?: string, recalled = true): Promise<GapFetchedMessage[]> {
    if (!existsSync(this.path)) return [];
    await this.writes.catch(() => undefined);
    await this.prepare();
    const rows = await this.nt.executeSql(
      this.path,
      `SELECT payload FROM recall_snapshot WHERE recalled=? ${kind ? 'AND kind=?' : ''} ${conv ? 'AND conv=?' : ''}`,
      [recalled ? 1 : 0, ...(kind ? [kind] : []), ...(conv ? [conv] : [])],
    );
    return rows.map((row) => markRetained(parse<GapFetchedMessage>(row[0])));
  }

  async byKeys(kind: 'c2c' | 'group', conv: string, keys: readonly (readonly [string, string])[]) {
    if (!existsSync(this.path) || !keys.length) return [];
    await this.writes.catch(() => undefined);
    await this.prepare();
    const rows = await this.nt.executeSql(
      this.path,
      "SELECT payload FROM recall_snapshot WHERE recalled=1 AND kind=? AND conv=? AND (seq || ':' || msg_id) IN (SELECT value FROM json_each(?))",
      [kind, conv, JSON.stringify(keys.map(([seq, id]) => `${seq}:${id}`))],
    );
    return rows.map((row) => markRetained(parse<GapFetchedMessage>(row[0])));
  }

  /** 只读取未读区间内已确认的撤回序号，无需解析留存正文。 */
  async unreadRecalledSequences(ranges: UnreadSequenceRange[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (!ranges.length || !existsSync(this.path)) return result;
    await this.prepare();
    for (let offset = 0; offset < ranges.length; offset += 128) {
      const batch = ranges.slice(offset, offset + 128);
      const rows = await scheduleDatabase(
        this.path,
        () =>
          this.nt.executeSql(
            this.path,
            `WITH targets(peer, kind, conv, lo, hi) AS (VALUES ${batch.map(() => '(?,?,?,?,?)').join(',')})
             SELECT DISTINCT t.peer, s.seq FROM targets t
             CROSS JOIN recall_snapshot s INDEXED BY recall_snapshot_match
             WHERE s.kind=t.kind AND s.conv=t.conv AND s.seq>t.lo AND s.seq<=t.hi AND s.recalled=1
             ORDER BY t.peer, s.seq`,
            batch.flatMap(({ peer, kind, conv, after, through }) => [
              peer,
              kind,
              conv,
              after,
              through,
            ]),
          ),
        this.nt,
      );
      for (const [peer, seq] of rows) {
        const key = String(peer);
        const sequences = result.get(key) ?? [];
        sequences.push(String(seq));
        result.set(key, sequences);
      }
    }
    return result;
  }

  async find(msgId: string): Promise<GapFetchedMessage | null> {
    if (!existsSync(this.path)) return null;
    await this.writes.catch(() => undefined);
    await this.prepare();
    const rows = await this.nt.executeSql(
      this.path,
      'SELECT payload FROM recall_snapshot WHERE recalled=1 AND msg_id=? LIMIT 2',
      [msgId],
    );
    return rows.length === 1 ? markRetained(parse<GapFetchedMessage>(rows[0]![0])) : null;
  }

  async *pendingNativeIdPages(
    signal?: AbortSignal,
  ): AsyncGenerator<Array<{ kind: 'c2c' | 'group'; id: string; conv: string }>> {
    if (!existsSync(this.path)) return;
    await this.writes.catch(() => undefined);
    if (signal?.aborted) return;
    await this.prepare();
    const upper = (
      await this.nt.executeSql(
        this.path,
        'SELECT MAX(rowid) FROM recall_snapshot INDEXED BY recall_snapshot_unrecalled_scan WHERE recalled=0',
        null,
      )
    )[0]?.[0];
    if (upper == null) return;
    let after: SqlValue | undefined;
    while (!signal?.aborted) {
      const rows = await this.nt.executeSql(
        this.path,
        `SELECT rowid,kind,msg_id,conv FROM recall_snapshot INDEXED BY recall_snapshot_unrecalled_scan
          WHERE recalled=0 AND rowid<=?${after === undefined ? '' : ' AND rowid>?'}
          ORDER BY rowid LIMIT ?`,
        after === undefined ? [upper, NATIVE_PAGE_ROWS] : [upper, after, NATIVE_PAGE_ROWS],
      );
      if (!rows.length || signal?.aborted) return;
      yield rows.flatMap(([, kind, id, conv]) =>
        kind === 'c2c' || kind === 'group' ? [{ kind, id: String(id), conv: String(conv) }] : [],
      );
      if (rows.length < NATIVE_PAGE_ROWS) return;
      after = rows.at(-1)?.[0];
    }
  }

  async query(
    kind: 'c2c' | 'group',
    conv: string,
    start: number,
    end: number,
    limit: number,
    descending: boolean,
    cursor?: { msgSeq: number; sendTime: number; msgId: string },
  ) {
    if (!existsSync(this.path)) return [];
    await this.writes.catch(() => undefined);
    await this.prepare();
    const sign = "CASE WHEN substr(msg_id,1,1)='-' THEN 0 ELSE 1 END";
    const negative = "CASE WHEN substr(msg_id,1,1)='-' THEN CAST(msg_id AS INTEGER) ELSE 0 END";
    const order = `seq,CAST(json_extract(payload,'$.sendTime') AS INTEGER),${sign},${negative},length(msg_id),msg_id`;
    const keyset = cursor ? `AND (${order}) ${descending ? '<' : '>'} (?,?,?,?,?,?)` : '';
    const negativeId = cursor?.msgId.startsWith('-') ?? false;
    const rows = await this.nt.executeSql(
      this.path,
      `SELECT payload FROM recall_snapshot WHERE recalled=1 AND kind=? AND conv=? AND seq BETWEEN ? AND ? ${keyset} ORDER BY seq ${descending ? 'DESC' : 'ASC'}, CAST(json_extract(payload,'$.sendTime') AS INTEGER) ${descending ? 'DESC' : 'ASC'}, ${sign} ${descending ? 'DESC' : 'ASC'}, ${negative} ${descending ? 'DESC' : 'ASC'}, length(msg_id) ${descending ? 'DESC' : 'ASC'}, msg_id ${descending ? 'DESC' : 'ASC'} LIMIT ?`,
      [
        kind,
        conv,
        start,
        end,
        ...(cursor
          ? [
              cursor.msgSeq,
              cursor.sendTime,
              negativeId ? 0 : 1,
              negativeId ? BigInt(cursor.msgId) : 0,
              cursor.msgId.length,
              cursor.msgId,
            ]
          : []),
        limit,
      ],
    );
    return rows.map((row) => markRetained(parse<GapFetchedMessage>(row[0])));
  }

  async close() {
    await this.writes.catch(() => undefined);
    this.nt.closeDb(this.path);
  }
}
