/**
 * 与克隆体 / WeQ 助手的对话持久化（按账号隔离，落 JSON）。
 *
 * 注意：这不是 QQ 聊天记录，而是「我们和 agent 的对话」——刷新/重开不丢，
 * 也为未来导出 bot client 持续积累。按 agentId（personaId 或 'assistant'）分桶。
 */

import type { AssistantStep } from './assistant';
import { JsonStore } from '../common/json_store';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  /** assistant 回合用到的工具名（WeQ 助手）。 */
  toolsUsed?: string[];
  /** assistant 回合的多轮思考/工具调用过程（WeQ 助手），用于刷新后回放折叠历史。 */
  steps?: AssistantStep[];
}

/** 单个 agent 最多保留的回合数（防文件无限增长）。 */
const MAX_TURNS = 400;

export class ConversationStore {
  private readonly store: JsonStore<Record<string, ConversationTurn[]>>;

  constructor(filePath: string) {
    this.store = new JsonStore(filePath, () => ({}), {
      normalize: (raw) =>
        raw && typeof raw === 'object' ? (raw as Record<string, ConversationTurn[]>) : {},
    });
  }

  get(agentId: string): ConversationTurn[] {
    return this.store.data[agentId] ?? [];
  }

  append(agentId: string, turns: ConversationTurn[]): void {
    const cur = this.store.data[agentId] ?? [];
    const next = [...cur, ...turns];
    this.store.data[agentId] = next.length > MAX_TURNS ? next.slice(next.length - MAX_TURNS) : next;
    this.store.save();
  }

  clear(agentId: string): void {
    delete this.store.data[agentId];
    this.store.save();
  }
}
