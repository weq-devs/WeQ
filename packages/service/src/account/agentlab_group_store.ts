/**
 * 群聊存储的 JSON 实现（AgentLabGroupStore port，按账号隔离，落单个 JSON）。
 *
 * M1「接口优先」：引擎只依赖 @weq/agentlab 的 AgentLabGroupStore 接口，这里给一个
 * 零基础风险的 JSON 后端先兑现群聊；等 better-sqlite3 的 electron-rebuild 确认后，
 * 再写一个同接口的 SQLite 后端替换，引擎与 service 上层都不用改。
 *
 * 沿用 agentlab_memory.ts / agentlab_notes.ts 的落盘范式：构造传文件路径，
 * 内存态 + 同步 persist，持久化失败不影响聊天本身。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AgentLabGroup,
  AgentLabGroupMember,
  AgentLabGroupMessage,
  AgentLabGroupStore,
} from '@weq/agentlab';

/** 每个群最多保留的消息条数（超出丢最旧的，防无限增长）。 */
const MAX_MESSAGES_PER_GROUP = 2000;

interface GroupData {
  groups: Record<string, AgentLabGroup>;
  members: Record<string, AgentLabGroupMember[]>;
  messages: Record<string, AgentLabGroupMessage[]>;
}

export class JsonGroupStore implements AgentLabGroupStore {
  private data: GroupData;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  createGroup(input: { id: string; name: string; ownerId: string; now: number }): AgentLabGroup {
    const group: AgentLabGroup = {
      id: input.id,
      name: input.name,
      ownerId: input.ownerId,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.data.groups[group.id] = group;
    this.data.members[group.id] ??= [];
    this.data.messages[group.id] ??= [];
    this.persist();
    return group;
  }

  listGroups(ownerId: string): AgentLabGroup[] {
    return Object.values(this.data.groups)
      .filter((g) => g.ownerId === ownerId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getGroup(id: string): AgentLabGroup | null {
    return this.data.groups[id] ?? null;
  }

  renameGroup(id: string, name: string, now: number): void {
    const group = this.data.groups[id];
    if (!group) return;
    group.name = name;
    group.updatedAt = now;
    this.persist();
  }

  deleteGroup(id: string): void {
    delete this.data.groups[id];
    delete this.data.members[id];
    delete this.data.messages[id];
    this.persist();
  }

  setMembers(groupId: string, members: AgentLabGroupMember[]): void {
    this.data.members[groupId] = members;
    this.persist();
  }

  listMembers(groupId: string): AgentLabGroupMember[] {
    return this.data.members[groupId] ?? [];
  }

  addMember(member: AgentLabGroupMember): void {
    const cur = this.data.members[member.groupId] ?? [];
    // 同 memberId 去重（重复加群幂等，保留最早 joinedAt）。
    if (cur.some((m) => m.memberId === member.memberId)) return;
    cur.push(member);
    this.data.members[member.groupId] = cur;
    this.persist();
  }

  removeMember(groupId: string, memberId: string): void {
    const cur = this.data.members[groupId];
    if (!cur) return;
    this.data.members[groupId] = cur.filter((m) => m.memberId !== memberId);
    this.persist();
  }

  appendMessage(message: AgentLabGroupMessage): void {
    const cur = this.data.messages[message.groupId] ?? [];
    cur.push(message);
    // 超容量丢最旧的（数组尾部是最新）。
    this.data.messages[message.groupId] =
      cur.length > MAX_MESSAGES_PER_GROUP ? cur.slice(cur.length - MAX_MESSAGES_PER_GROUP) : cur;
    this.persist();
  }

  listMessages(groupId: string, limit?: number): AgentLabGroupMessage[] {
    const cur = this.data.messages[groupId] ?? [];
    if (limit === undefined || limit >= cur.length) return [...cur];
    return cur.slice(cur.length - limit);
  }

  clearMessages(groupId: string): void {
    this.data.messages[groupId] = [];
    this.persist();
  }

  private load(): GroupData {
    const empty: GroupData = { groups: {}, members: {}, messages: {} };
    try {
      if (!existsSync(this.filePath)) return empty;
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object') return empty;
      return {
        groups: parsed.groups ?? {},
        members: parsed.members ?? {},
        messages: parsed.messages ?? {},
      };
    } catch {
      return empty;
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data), 'utf-8');
    } catch {
      /* 持久化失败不应影响群聊本身 */
    }
  }
}
