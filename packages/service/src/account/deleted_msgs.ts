/**
 * DeletedMsgStore — WeQ's per-account record of which messages *it* deleted.
 *
 * WeQ's message delete mirrors QQ's own recall: it rewrites the 40011/40012
 * type columns to `(1,1)` in place, leaving the 40800 body untouched (see
 * `MsgService.deleteMessage`). That keeps the row where it is — so the deleted
 * set can't be recovered from the DB alone, and QQ's *own* recalls are also
 * `(1,1)`, indistinguishable at the row level.
 *
 * This store is the authority for both problems: it remembers, per msgId, the
 * ORIGINAL 40011/40012 (so restore can write them back) plus the conversation
 * it belongs to (so the "deleted messages" list and the in-chat overlay can be
 * scoped to one conversation). One JSON file per account, keyed by msgId.
 *
 * Modeled on the AgentLab JSON stores (load on construct, persist after each
 * mutation, silent on I/O error).
 *
 * sent-cache 来源与键保留历史命名，现在覆盖全部漫游缓存；hidden 仅控制隐藏，
 * 不丢弃可恢复内容。同一消息跨缓存格式共用删除身份。
 */

import { JsonStore } from '../common/json_store';
import type { GapFetchedMessage } from './gap_history';

export type DeletedMsgRecord = {
  /** Which table holds it — chooses the c2c/dataline vs group restore path. */
  kind: 'c2c' | 'group';
  /** Conversation key: peer uid (c2c) or group code (group). */
  conv: string;
  /** Unix seconds when WeQ deleted it. */
  deletedAt: number;
  hidden?: boolean;
} & (
  | { source?: 'qq'; origMsgType: string; origSubType: string }
  | { source: 'sent-cache'; messageId: string }
);

export class DeletedMsgStore {
  private readonly store: JsonStore<Record<string, DeletedMsgRecord>>;

  constructor(filePath: string) {
    this.store = new JsonStore(filePath, () => ({}), {
      normalize: (raw) =>
        raw && typeof raw === 'object' ? (raw as Record<string, DeletedMsgRecord>) : {},
    });
  }

  /** The record for a msgId, or undefined if WeQ never deleted it. */
  get(msgId: string): DeletedMsgRecord | undefined {
    return this.store.data[msgId];
  }

  /** Remember a delete (original type columns + conversation). Persists. */
  add(msgId: string, rec: DeletedMsgRecord): void {
    if (rec.source === 'sent-cache') {
      const match = /^roaming:(?:(?:native|protocol):)?([1-9]\d*):(-?\d+)$/.exec(rec.messageId);
      if (match)
        for (const format of ['', 'native:', 'protocol:']) {
          delete this.store.data[
            DeletedMsgStore.cachedKey(
              rec.kind,
              rec.conv,
              `roaming:${format}${match[1]}:${match[2]}`,
            )
          ];
        }
    }
    this.store.data[msgId] = rec;
    this.store.save();
  }

  /** Forget a delete (on restore). Persists. No-op if absent. */
  remove(msgId: string): void {
    if (this.store.data[msgId] === undefined) return;
    delete this.store.data[msgId];
    this.store.save();
  }

  /** msgIds WeQ deleted in one conversation (matched by kind + conv). */
  listIds(kind: 'c2c' | 'group', conv: string): string[] {
    return Object.keys(this.store.data).flatMap((id) => {
      const r = this.store.data[id];
      return r !== undefined && r.kind === kind && r.conv === conv
        ? [r.source === 'sent-cache' ? r.messageId : id]
        : [];
    });
  }

  listHiddenIds(kind: 'c2c' | 'group', conv: string): string[] {
    return this.listIds(kind, conv).filter((id) =>
      id.startsWith('roaming:')
        ? this.get(DeletedMsgStore.cachedKey(kind, conv, id))?.hidden
        : this.get(id)?.hidden,
    );
  }

  static cachedKey(kind: 'c2c' | 'group', conv: string, messageId: string): string {
    // 保留旧键，已有自发缓存删除记录无需迁移。
    return `sent-cache:${JSON.stringify([kind, conv, messageId])}`;
  }

  /** 仅成功重新拉取的隐藏记录恢复；同一消息跨缓存格式仍是一次恢复。 */
  restoreFetched(messages: readonly GapFetchedMessage[]): void {
    const received = new Set(
      messages.map((row) => JSON.stringify([row.kind, row.conv, row.msgSeq, row.msgId])),
    );
    let changed = false;
    for (const [key, record] of Object.entries(this.store.data)) {
      if (record.source !== 'sent-cache' || !record.hidden) continue;
      const match = /^roaming:(?:(?:native|protocol):)?(\d+):(-?\d+)$/.exec(record.messageId);
      if (match && received.has(JSON.stringify([record.kind, record.conv, match[1], match[2]]))) {
        delete this.store.data[key];
        changed = true;
      }
    }
    if (changed) this.store.save();
  }

  isHiddenCached(message: GapFetchedMessage): boolean {
    return ['', 'native:', 'protocol:'].some(
      (format) =>
        this.get(
          DeletedMsgStore.cachedKey(
            message.kind,
            message.conv,
            `roaming:${format}${message.msgSeq}:${message.msgId}`,
          ),
        )?.hidden,
    );
  }
}
