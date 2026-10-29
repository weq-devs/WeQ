import { z } from 'zod';
import { JsonStore } from '@weq/service';
import type { BridgeMessage } from './server';

const locationSchema = z.object({
  conv: z.string(),
  msgId: z.string().optional(),
  msgSeq: z.number().int().nonnegative(),
  clientSeq: z.number().int().nonnegative(),
  random: z.number().int().nonnegative(),
});
export type MessageLocation = z.infer<typeof locationSchema>;
const entrySchema = z.object({
  id: z.number().int().min(-2147483647).max(-1),
  key: z.string(),
  peerType: z.enum(['c2c', 'group']),
  targetId: z.string(),
  senderUin: z.number(),
  nickname: z.string(),
  time: z.number(),
  sequence: z.number(),
  location: locationSchema.optional(),
  fileId: z.string().optional(),
  fileName: z.string().optional(),
  fileSize: z.number().optional(),
  registeredAt: z.number(),
});
const stateSchema = z.object({
  next: z.number().int().min(-2147483648).max(-1),
  entries: z.array(entrySchema).max(8192),
});
type Entry = z.infer<typeof entrySchema>;

/** 仅保存身份元数据；过期 ID 不再分配给另一条消息。 */
export class MessageRegistry {
  private readonly entries = new Map<number, Entry>();
  private readonly aliases = new Map<string, number>();
  private next = -1;
  private reserved = -1;
  private readonly store?: JsonStore<z.infer<typeof stateSchema>>;
  private timer?: ReturnType<typeof setTimeout>;
  private lastPrune = 0;

  constructor(path?: string) {
    if (path) {
      this.store = new JsonStore(path, () => ({ next: -1, entries: [] }), {
        strict: true,
        normalize: (raw) => stateSchema.parse(raw),
      });
      this.next = this.store.data.next;
      this.reserved = this.next;
      for (const entry of this.store.data.entries) {
        if (this.entries.has(entry.id) || entry.id <= this.next)
          throw new Error('OneBot 消息索引 ID 无效');
        this.entries.set(entry.id, entry);
        for (const key of this.keys(entry)) this.aliases.set(key, entry.id);
      }
    }
  }

  private keys(msg: Omit<BridgeMessage, 'message'>): string[] {
    const prefix = `${msg.peerType}:${msg.targetId}:${msg.senderUin}`;
    const quote =
      msg.peerType === 'group'
        ? msg.location?.msgSeq || msg.sequence
        : msg.location?.clientSeq || msg.sequence;
    return [
      ...(msg.location?.msgId ? [`msg:${prefix}:${msg.location.msgId}`] : []),
      ...(msg.location?.random ? [`random:${prefix}:${msg.location.random}:${msg.time}`] : []),
      ...(quote > 0 ? [`quote:${prefix}:${quote}:${msg.time}`] : []),
      `key:${prefix}:${msg.key}`,
    ];
  }

  find(msg: Omit<BridgeMessage, 'message'>): number | undefined {
    for (const key of this.keys(msg)) {
      const found = this.aliases.get(key);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  remember(msg: BridgeMessage): number {
    let id = this.find(msg);
    if (id === undefined) {
      if (this.next < -2147483647) throw new Error('OneBot 消息 ID 已用尽');
      // 先落盘预留一批 ID；进程意外退出也不会把旧 ID 发给新消息。
      if (this.store && this.next === this.reserved) {
        this.reserved = Math.max(-2147483648, this.next - 4096);
        this.store.replace({ next: this.reserved, entries: [...this.entries.values()] });
      }
      id = this.next--;
    }
    const old = this.entries.get(id);
    const { message: _message, ...metadata } = msg;
    const loc = msg.location ?? old?.location;
    const entry: Entry = {
      ...old,
      ...metadata,
      id,
      registeredAt: Date.now(),
      location: loc
        ? {
            ...loc,
            msgId: msg.location?.msgId ?? old?.location?.msgId,
            msgSeq: msg.location?.msgSeq || old?.location?.msgSeq || 0,
            clientSeq: msg.location?.clientSeq || old?.location?.clientSeq || 0,
            random: msg.location?.random || old?.location?.random || 0,
          }
        : undefined,
    };
    this.entries.delete(id);
    this.entries.set(id, entry);
    // 登记完整身份后仍保留已发出的引用占位别名。
    for (const key of this.keys(entry)) this.aliases.set(key, id);
    for (const key of this.keys(msg)) this.aliases.set(key, id);
    this.prune();
    if (this.store && !this.timer) {
      this.timer = setTimeout(() => {
        try {
          this.flush();
        } catch (error) {
          console.error('OneBot 消息索引保存失败', error);
        }
      }, 250);
      this.timer.unref();
    }
    return id;
  }

  get(id: number): BridgeMessage | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.registeredAt < Date.now() - 30 * 86400 * 1000) return undefined;
    const { id: _id, registeredAt: _registeredAt, ...msg } = entry;
    return { ...msg, message: [] };
  }

  private prune(): void {
    const now = Date.now();
    if (this.entries.size <= 8192 && now - this.lastPrune < 60000) return;
    this.lastPrune = now;
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= 8192 && entry.registeredAt >= now - 30 * 86400 * 1000) continue;
      this.entries.delete(id);
    }
    for (const [key, id] of this.aliases) if (!this.entries.has(id)) this.aliases.delete(key);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.store)
      this.store.replace({ next: this.reserved, entries: [...this.entries.values()] });
  }
}
