/**
 * 克隆体记忆存储（按账号隔离，落 JSON）。借鉴 MaiBot 记忆：
 * 每条记忆带 accessCount + lastAccessedAt，检索命中就 +access；容量超限时按
 * 「强度 = access 热度 + 时间新鲜度」淘汰最弱的，实现 access_count 衰减式遗忘。
 *
 * 视角：「AI 变成 TA」——记的是克隆体眼中关于「对方（用户）」的事。
 * 检索/打分（BM25 兜底）在 @weq/agentlab 的 runPersonaChat 里做，这里只管存取与遗忘。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { keywordsOf, type AgentLabMemoryItem } from '@weq/agentlab';

/** 每个克隆体最多保留的记忆条数（超出按强度淘汰）。 */
const MAX_PER_PERSONA = 200;
/** 一条记忆没被想起多久算「冷却」（30 天，单位 ms），用于新鲜度衰减。 */
const FRESHNESS_WINDOW = 30 * 24 * 3600 * 1000;

export class MemoryStore {
  private data: Record<string, AgentLabMemoryItem[]>;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  get(personaId: string): AgentLabMemoryItem[] {
    return this.data[personaId] ?? [];
  }

  /**
   * 追加蒸馏出的新记忆（按文本去重）。返回实际新增条数。
   * now 由调用方传入（service 用 Date.now()）。
   */
  add(personaId: string, texts: string[], now: number): number {
    const cur = this.data[personaId] ?? [];
    const existing = new Set(cur.map((m) => m.text));
    let added = 0;
    for (const text of texts) {
      const t = text.trim();
      if (!t || existing.has(t)) continue;
      existing.add(t);
      cur.push({
        id: this.makeId(personaId, t, now + added),
        text: t,
        keywords: keywordsOf(t),
        accessCount: 0,
        createdAt: now,
        lastAccessedAt: now,
      });
      added += 1;
    }
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
    delete this.data[personaId];
    this.persist();
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

  private load(): Record<string, AgentLabMemoryItem[]> {
    try {
      if (!existsSync(this.filePath)) return {};
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, AgentLabMemoryItem[]>) : {};
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data), 'utf-8');
    } catch {
      /* 持久化失败不应影响对话本身 */
    }
  }
}
