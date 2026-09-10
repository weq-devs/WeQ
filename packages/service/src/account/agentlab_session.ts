/**
 * 克隆体会话（好友克隆 / 群聊通用）：
 *  - AgentLabSessionStore：会话元数据（id/title/时间），按 ownerId 分桶
 *    （ownerId = personaId 或 `group:<groupId>`）。
 *  - AgentLabGroupSessionMessageStore：群聊会话的消息记录，按 `${groupId}:${sessionId}` 分桶。
 *
 * 落盘范式与 agentlab_memory.ts / agentlab_group_store.ts 对齐：构造读盘一次，
 * 内存态 + 变更即 persist（原子写），持久化失败不影响聊天主流程。
 */
import { randomUUID } from 'node:crypto';
import type { AgentLabGroupMessage } from '@weq/agentlab';
import { JsonStore } from '../common/json_store';

export interface AgentLabSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/** 新建会话的占位标题；首条消息发出后由第一句自动生成。 */
export const DEFAULT_SESSION_TITLE = '新会话';

/** 由会话里的第一句用户消息生成标题（取首行、截断、表情标记归一）。 */
export function sessionTitleFromText(text: string): string {
  const clean = text.replace(/\[\[(sticker|voice):[^\]]+\]\]/g, '[表情]').trim();
  const firstLine = (clean.split('\n')[0] ?? clean).trim();
  return (firstLine || DEFAULT_SESSION_TITLE).slice(0, 24);
}

function normalizeSessions(raw: unknown): AgentLabSession[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is AgentLabSession =>
      !!s &&
      typeof s === 'object' &&
      typeof (s as AgentLabSession).id === 'string' &&
      typeof (s as AgentLabSession).title === 'string',
  );
}

/** 会话元数据存储（按 ownerId 分桶，列表按最近活跃倒序）。 */
export class AgentLabSessionStore {
  private readonly store: JsonStore<Record<string, AgentLabSession[]>>;

  constructor(filePath: string) {
    this.store = new JsonStore(filePath, () => ({}), {
      normalize: (raw): Record<string, AgentLabSession[]> => {
        const parsed = (raw ?? {}) as Record<string, unknown>;
        const out: Record<string, AgentLabSession[]> = {};
        for (const key of Object.keys(parsed)) {
          const list = normalizeSessions(parsed[key]);
          if (list.length > 0) out[key] = list;
        }
        return out;
      },
    });
  }

  list(ownerId: string): AgentLabSession[] {
    return [...(this.store.data[ownerId] ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(ownerId: string, sessionId: string): AgentLabSession | null {
    return this.store.data[ownerId]?.find((s) => s.id === sessionId) ?? null;
  }

  /** 新建一个空会话（占位标题，首条消息后由第一句生成）。 */
  create(ownerId: string): AgentLabSession {
    const now = Date.now();
    const session: AgentLabSession = {
      id: randomUUID(),
      title: DEFAULT_SESSION_TITLE,
      createdAt: now,
      updatedAt: now,
    };
    const cur = this.store.data[ownerId] ?? [];
    cur.push(session);
    this.store.data[ownerId] = cur;
    this.store.save();
    return session;
  }

  /** 删除会话；不存在返回 false。 */
  delete(ownerId: string, sessionId: string): boolean {
    const cur = this.store.data[ownerId];
    if (!cur) return false;
    const next = cur.filter((s) => s.id !== sessionId);
    if (next.length === cur.length) return false;
    if (next.length === 0) delete this.store.data[ownerId];
    else this.store.data[ownerId] = next;
    this.store.save();
    return true;
  }

  /** 会话活跃时间更新（聊天时调用，驱动列表排序）。 */
  touch(ownerId: string, sessionId: string): void {
    const session = this.get(ownerId, sessionId);
    if (!session) return;
    session.updatedAt = Date.now();
    this.store.save();
  }

  /** 首条消息后由第一句生成标题。 */
  setTitle(ownerId: string, sessionId: string, title: string): void {
    const session = this.get(ownerId, sessionId);
    if (!session) return;
    session.title = title.trim().slice(0, 24) || DEFAULT_SESSION_TITLE;
    this.store.save();
  }

  /** 删除某 owner 的全部会话（删除克隆体 / 群聊时调用）。 */
  deleteOwner(ownerId: string): void {
    if (!this.store.data[ownerId]) return;
    delete this.store.data[ownerId];
    this.store.save();
  }
}

/** 群聊会话的消息记录（按 `${groupId}:${sessionId}` 分桶）。 */
export class AgentLabGroupSessionMessageStore {
  /** 每个会话最多保留的消息条数（超出丢最旧的，防无限增长）。 */
  private static readonly MAX_PER_SESSION = 1000;

  private readonly store: JsonStore<Record<string, AgentLabGroupMessage[]>>;

  constructor(filePath: string) {
    this.store = new JsonStore(filePath, () => ({}), {
      normalize: (raw): Record<string, AgentLabGroupMessage[]> => {
        const parsed = (raw ?? {}) as Record<string, unknown>;
        const out: Record<string, AgentLabGroupMessage[]> = {};
        for (const key of Object.keys(parsed)) {
          if (Array.isArray(parsed[key])) out[key] = parsed[key] as AgentLabGroupMessage[];
        }
        return out;
      },
    });
  }

  list(bucket: string): AgentLabGroupMessage[] {
    return [...(this.store.data[bucket] ?? [])];
  }

  append(bucket: string, message: AgentLabGroupMessage): void {
    const cur = this.store.data[bucket] ?? [];
    cur.push(message);
    this.store.data[bucket] =
      cur.length > AgentLabGroupSessionMessageStore.MAX_PER_SESSION
        ? cur.slice(cur.length - AgentLabGroupSessionMessageStore.MAX_PER_SESSION)
        : cur;
    this.store.save();
  }

  clear(bucket: string): void {
    if (!this.store.data[bucket]) return;
    delete this.store.data[bucket];
    this.store.save();
  }

  /** 删除某群的全部会话消息（删除群聊时调用）。 */
  deleteGroup(groupId: string): void {
    const prefix = `${groupId}:`;
    let changed = false;
    for (const key of Object.keys(this.store.data)) {
      if (key.startsWith(prefix)) {
        delete this.store.data[key];
        changed = true;
      }
    }
    if (changed) this.store.save();
  }
}
