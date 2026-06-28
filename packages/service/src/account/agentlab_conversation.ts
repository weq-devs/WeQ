/**
 * 与克隆体 / WeQ 助手的对话持久化（按账号隔离，落 JSON）。
 *
 * 注意：这不是 QQ 聊天记录，而是「我们和 agent 的对话」——刷新/重开不丢，
 * 也为未来导出 bot client 持续积累。按 agentId（personaId 或 'assistant'）分桶。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  /** assistant 回合用到的工具名（WeQ 助手）。 */
  toolsUsed?: string[];
}

/** 单个 agent 最多保留的回合数（防文件无限增长）。 */
const MAX_TURNS = 400;

export class ConversationStore {
  private data: Record<string, ConversationTurn[]>;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  get(agentId: string): ConversationTurn[] {
    return this.data[agentId] ?? [];
  }

  append(agentId: string, turns: ConversationTurn[]): void {
    const cur = this.data[agentId] ?? [];
    const next = [...cur, ...turns];
    this.data[agentId] = next.length > MAX_TURNS ? next.slice(next.length - MAX_TURNS) : next;
    this.persist();
  }

  clear(agentId: string): void {
    delete this.data[agentId];
    this.persist();
  }

  private load(): Record<string, ConversationTurn[]> {
    try {
      if (!existsSync(this.filePath)) return {};
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, ConversationTurn[]>) : {};
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
