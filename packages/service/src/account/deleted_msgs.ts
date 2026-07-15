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
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DeletedMsgRecord {
  /** Original column 40011 (msgType) before delete, as a decimal string. */
  origMsgType: string;
  /** Original column 40012 (subType) before delete, as a decimal string. */
  origSubType: string;
  /** Which table holds it — chooses the c2c/dataline vs group restore path. */
  kind: 'c2c' | 'group';
  /** Conversation key: peer uid (c2c) or group code (group). */
  conv: string;
  /** Unix seconds when WeQ deleted it. */
  deletedAt: number;
}

export class DeletedMsgStore {
  private data: Record<string, DeletedMsgRecord>;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  /** The record for a msgId, or undefined if WeQ never deleted it. */
  get(msgId: string): DeletedMsgRecord | undefined {
    return this.data[msgId];
  }

  /** Remember a delete (original type columns + conversation). Persists. */
  add(msgId: string, rec: DeletedMsgRecord): void {
    this.data[msgId] = rec;
    this.persist();
  }

  /** Forget a delete (on restore). Persists. No-op if absent. */
  remove(msgId: string): void {
    if (this.data[msgId] === undefined) return;
    delete this.data[msgId];
    this.persist();
  }

  /** msgIds WeQ deleted in one conversation (matched by kind + conv). */
  listIds(kind: 'c2c' | 'group', conv: string): string[] {
    return Object.keys(this.data).filter((id) => {
      const r = this.data[id];
      return r !== undefined && r.kind === kind && r.conv === conv;
    });
  }

  private load(): Record<string, DeletedMsgRecord> {
    try {
      if (!existsSync(this.filePath)) return {};
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, DeletedMsgRecord>) : {};
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data), 'utf-8');
    } catch {
      /* 持久化失败不应影响删除/恢复本身 */
    }
  }
}
