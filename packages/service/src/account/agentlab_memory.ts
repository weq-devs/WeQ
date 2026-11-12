/**
 * 克隆体记忆存储（按账号隔离，落 JSON）。借鉴 MaiBot 记忆：
 * 每条记忆带 accessCount + lastAccessedAt，检索命中就 +access；容量超限时按
 * 「强度 = access 热度 + 时间新鲜度」淘汰最弱的，实现 access_count 衰减式遗忘。
 *
 * 视角：「AI 变成 TA」——记的是克隆体眼中关于「对方（用户）」的事。
 * 检索/打分（BM25 兜底）在 @weq/agentlab 的 runPersonaChat 里做，这里只管存取与遗忘。
 */

import { createHash } from 'node:crypto';
import { keywordsOf, type AgentLabMemoryItem } from '@weq/agentlab';
import { JsonStore } from '../common/json_store';

/** 每个克隆体最多保留的记忆条数（超出按强度淘汰）。 */
const MAX_PER_PERSONA = 200;
/** 一条记忆没被想起多久算「冷却」（30 天，单位 ms），用于新鲜度衰减。 */
const FRESHNESS_WINDOW = 30 * 24 * 3600 * 1000;

export class MemoryStore {
  private readonly store: JsonStore<Record<string, AgentLabMemoryItem[]>>;

  constructor(filePath: string) {
    this.store = new JsonStore(filePath, () => ({}), {
      normalize: (raw) =>
        raw && typeof raw === 'object' ? (raw as Record<string, AgentLabMemoryItem[]>) : {},
    });
  }

  private get data(): Record<string, AgentLabMemoryItem[]> {
    return this.store.data;
  }

  private set data(next: Record<string, AgentLabMemoryItem[]>) {
    this.store.data = next;
  }

  get(personaId: string): AgentLabMemoryItem[] {
    return this.data[personaId] ?? [];
  }

  /**
   * 只取「关于指定成员」的记忆（M5 多人，防串人）。includeUntagged=true 时把旧的无
   * aboutId 记忆也算进来（视为关于私聊对方）。
   */
  getAbout(personaId: string, aboutIds: string[], includeUntagged = false): AgentLabMemoryItem[] {
    const cur = this.data[personaId] ?? [];
    const ids = new Set(aboutIds);
    return cur.filter((m) => (m.aboutId ? ids.has(m.aboutId) : includeUntagged));
  }

  /**
   * 追加蒸馏出的新记忆（按 关于谁+文本 去重）。返回实际新增条数。
   * now 由调用方传入（service 用 Date.now()）。about 缺省 = 关于私聊对方（旧行为）。
   * embeddings 与 texts 一一对应（可选，配了向量模型时用于语义召回）。
   */
  add(
    personaId: string,
    texts: string[],
    now: number,
    about?: { aboutId: string; aboutKind: 'user' | 'persona' },
    embeddings?: Array<number[] | undefined>,
  ): number {
    const cur = this.data[personaId] ?? [];
    const dedupKey = (aboutId: string | undefined, text: string): string =>
      `${aboutId ?? ''}\x00${text}`;
    const existing = new Set(cur.map((m) => dedupKey(m.aboutId, m.text)));
    let added = 0;
    texts.forEach((raw, i) => {
      const t = raw.trim();
      const key = dedupKey(about?.aboutId, t);
      if (!t || existing.has(key)) return;
      existing.add(key);
      const emb = embeddings?.[i];
      cur.push({
        id: this.makeId(personaId, t, now + added),
        text: t,
        keywords: keywordsOf(t),
        ...(emb && emb.length > 0 ? { embedding: emb } : {}),
        ...(about ? { aboutId: about.aboutId, aboutKind: about.aboutKind } : {}),
        accessCount: 0,
        createdAt: now,
        lastAccessedAt: now,
      });
      added += 1;
    });
    this.data[personaId] = this.prune(cur, now);
    if (added > 0) this.persist();
    return added;
  }

  /** 检索命中的记忆 +access（被想起 → 更不易遗忘）。 */
  touch(personaId: string, ids: string[], now: number): void {
    if (ids.length === 0) return;
    const cur = this.data[personaId];
    if (!cur) return;
    const idSet = new Set(ids);
    let changed = false;
    for (const m of cur) {
      if (idSet.has(m.id)) {
        m.accessCount += 1;
        m.lastAccessedAt = now;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  remove(personaId: string, id: string): void {
    const cur = this.data[personaId];
    if (!cur) return;
    this.data[personaId] = cur.filter((m) => m.id !== id);
    this.persist();
  }

  clear(personaId: string): void {
    const next = { ...this.data };
    delete next[personaId];
    this.store.replace(next, true);
  }

  /** 强度 = access 热度 + 时间新鲜度；容量超限时淘汰最弱的。 */
  private prune(items: AgentLabMemoryItem[], now: number): AgentLabMemoryItem[] {
    if (items.length <= MAX_PER_PERSONA) return items;
    const strength = (m: AgentLabMemoryItem): number => {
      const fresh = Math.max(0, 1 - (now - m.lastAccessedAt) / FRESHNESS_WINDOW);
      return Math.log1p(m.accessCount) + fresh;
    };
    return [...items].sort((a, b) => strength(b) - strength(a)).slice(0, MAX_PER_PERSONA);
  }

  private makeId(personaId: string, text: string, salt: number): string {
    return createHash('sha1').update(`${personaId}:${text}:${salt}`).digest('hex').slice(0, 16);
  }

  private persist(): void {
    this.store.save();
  }
}
