/**
 * 对话反思笔记存储（按账号隔离，落 JSON）。借鉴 CipherTalk 导演笔记：
 * - corrections：用户在克隆对话里对扮演的纠正/指示（注入 prompt 必须遵守）；
 * - episodes：历次克隆对话的摘要（克隆体自己的 episodic memory）；
 * - reflectedCount：已反思到的对话条数水位，避免重复反思同一段。
 *
 * 与 MemoryStore 同模式（纯 JSON load/persist + 容量裁剪），但视角不同：
 * memory 记的是「关于对方的事实」，notes 记的是「怎么扮演 TA / 我们聊过什么」。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentLabPersonaNotes } from '@weq/agentlab';

/** corrections 上限（纠正规则，强约束注入 prompt）。 */
const MAX_CORRECTIONS = 20;
/** episodes 上限（对话摘要，超出裁掉最旧的）。 */
const MAX_EPISODES = 8;

interface PersonaNotesEntry {
  corrections: string[];
  episodes: string[];
  /** 已反思到的对话条数（conversation 长度水位）。 */
  reflectedCount: number;
}

export class NotesStore {
  private data: Record<string, PersonaNotesEntry>;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  /** 注入 prompt 用的笔记（不含水位）。 */
  get(personaId: string): AgentLabPersonaNotes {
    const entry = this.data[personaId];
    return {
      corrections: entry?.corrections ?? [],
      episodes: entry?.episodes ?? [],
    };
  }

  /** 追加反思结果：corrections 去重后保留最新 MAX_CORRECTIONS 条，episode 非空则入栈。 */
  add(personaId: string, corrections: string[], episode: string): void {
    const entry = this.ensure(personaId);
    let changed = false;
    for (const raw of corrections) {
      const c = raw.trim();
      if (!c || entry.corrections.includes(c)) continue;
      entry.corrections.push(c);
      changed = true;
    }
    if (entry.corrections.length > MAX_CORRECTIONS) {
      entry.corrections = entry.corrections.slice(-MAX_CORRECTIONS);
      changed = true;
    }
    const ep = episode.trim();
    if (ep && !entry.episodes.includes(ep)) {
      entry.episodes.push(ep);
      if (entry.episodes.length > MAX_EPISODES) entry.episodes = entry.episodes.slice(-MAX_EPISODES);
      changed = true;
    }
    if (changed) this.persist();
  }

  getReflectedCount(personaId: string): number {
    return this.data[personaId]?.reflectedCount ?? 0;
  }

  setReflectedCount(personaId: string, count: number): void {
    const entry = this.ensure(personaId);
    entry.reflectedCount = count;
    this.persist();
  }

  clear(personaId: string): void {
    if (!(personaId in this.data)) return;
    delete this.data[personaId];
    this.persist();
  }

  private ensure(personaId: string): PersonaNotesEntry {
    let entry = this.data[personaId];
    if (!entry) {
      entry = { corrections: [], episodes: [], reflectedCount: 0 };
      this.data[personaId] = entry;
    }
    return entry;
  }

  private load(): Record<string, PersonaNotesEntry> {
    try {
      if (!existsSync(this.filePath)) return {};
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, PersonaNotesEntry>) : {};
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
