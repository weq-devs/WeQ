import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomicSync } from '@weq/service/atomic-write';
import type { ObservedPush } from '@weqbot/protocol/qq-sync';

export interface RecallJournalEntry {
  id: string;
  at: number;
  events: ObservedPush[];
}

/** 过滤前原子保存，宿主提交留存后确认删除；重启后按账号来源接续。 */
export class RecallJournal {
  constructor(private readonly root: string) {}
  private directory(owner: string) {
    return join(this.root, createHash('sha256').update(owner).digest('hex'));
  }
  append(owner: string, events: ObservedPush[]) {
    if (!events.length) return;
    const directory = this.directory(owner);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const pending = readdirSync(directory).filter((name) => name.endsWith('.json'));
    if (
      pending.length >= 512 ||
      pending.reduce((total, name) => total + statSync(join(directory, name)).size, 0) >
        32 * 1024 * 1024
    )
      throw new Error('撤回留存等待处理的推送已达上限');
    const entry: RecallJournalEntry = {
      id: `${Date.now()}-${randomUUID()}`,
      at: Math.floor(Date.now() / 1000),
      events,
    };
    const data = JSON.stringify(entry);
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('撤回留存推送过大');
    writeFileAtomicSync(join(directory, `${entry.id}.json`), data);
  }
  take(owner: string, ack: string[] = []): RecallJournalEntry[] {
    const directory = this.directory(owner);
    for (const id of ack) {
      if (!/^\d+-[a-f\d-]{36}$/.test(id)) throw new Error('推送确认标识无效');
      try {
        unlinkSync(join(directory, `${id}.json`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    let names: string[];
    try {
      names = readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: RecallJournalEntry[] = [];
    let bytes = 0;
    for (const name of names.slice(0, 64)) {
      const text = readFileSync(join(directory, name), 'utf8');
      if (entries.length && bytes + Buffer.byteLength(text) > 2 * 1024 * 1024) break;
      entries.push(JSON.parse(text));
      bytes += Buffer.byteLength(text);
    }
    return entries;
  }
}
