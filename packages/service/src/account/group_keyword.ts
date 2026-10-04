/**
 * GroupKeywordService — 群关键词提醒的匹配内核。
 *
 * 「提醒点位是收到的新消息」：监听 `nt_msg.db`（与 SSE 推送同一套
 * `createNtMsgDbHook`），把新插入的**群消息**拿去跟用户为每个群配置的关键词做
 * 匹配。命中后交给上层（桌面端）去弹系统通知卡片 + 写 `unread 2006` 高亮。
 *
 * 与 SSE 推送解耦：本服务有**自己的** DbWatch 实例，只要账号打开就挂上 ——
 * SSE 推送地址没配 / 「启用数据库监听」关掉都不影响群提醒（产品要求：
 * 「SSE 未开启的时候也要开启群提醒」）。
 *
 * 纯匹配逻辑（{@link matchesRule}）抽成独立函数，便于离线单测。
 */

import type { AccountSession } from '@weq/account';
import type { GroupMsg } from '@weq/db';
import { DbWatchService, type DbWatchHandle } from './db_watch';
import { createNtMsgDbHook, type NewMessages } from './nt_msg_hook';

/** 一个群的关键词规则（与前端 localStorage 结构一一对应）。 */
export interface GroupKeywordRule {
  /** 关键词；空数组 = 这个群不提醒。大小写不敏感的子串匹配。 */
  keywords: string[];
  /** 只在这些人发言时提醒（uid 列表）；空数组 = 任何人（不指定即全部）。 */
  memberUids: string[];
}

/** 全部群的关键词规则，key 为群号。 */
export type GroupKeywordRules = Record<string, GroupKeywordRule>;

/** 一次命中：交给上层弹通知 + 写高亮。 */
export interface GroupKeywordHit {
  /** 群号。 */
  groupCode: string;
  /** 消息在群内的 seq（点击卡片跳转目标）。 */
  msgSeq: bigint;
  /** 发送者 uid。 */
  senderUid: string;
  /** 发送者 QQ 号（可能为 0）。 */
  senderUin: bigint;
  /** 发送时间（unix 秒）。 */
  sendTime: bigint;
  /** 命中的关键词。 */
  keyword: string;
  /** 消息正文摘要（通知卡片预览 / 高亮记录）。 */
  text: string;
}

export interface GroupKeywordOptions {
  /** 命中回调；上层在此弹通知 + 写 2006 高亮。 */
  onHit: (hit: GroupKeywordHit) => void | Promise<void>;
  /** 轮询间隔毫秒，透传给 DbWatchService（默认 1000）。 */
  intervalMs?: number;
}

/** How long the extracted text may be before it is truncated in a notification. */
const MAX_TEXT_LEN = 200;
/** Cap on the dedup set — a long-lived session would otherwise grow it forever. */
const MAX_SEEN = 5_000;

export class GroupKeywordService {
  private readonly watch: DbWatchService;
  private handle: DbWatchHandle | null = null;
  /** 当前生效的规则（前端推送 / 账号打开时注入）。 */
  private rules: GroupKeywordRules = {};
  /** 已提醒过的 `group:seq`，避免同一 seq 因重复扫描被推两次。 */
  private readonly seen = new Set<string>();

  constructor(
    private readonly session: AccountSession,
    private readonly opts: GroupKeywordOptions,
  ) {
    this.watch = new DbWatchService({ intervalMs: opts.intervalMs ?? 1_000 });
  }

  /** 挂载 nt_msg.db 监听。幂等。 */
  start(): void {
    if (this.handle) return;
    this.handle = this.watch.mount(
      createNtMsgDbHook(this.session, {
        onDbChanged: () => {
          /* 与 UI 刷新路径无关，忽略 */
        },
        onNewMessages: (change: NewMessages) => this.onNewMessages(change),
      }),
    );
  }

  /** 停止监听（清空去重集合）。幂等。 */
  stop(): void {
    if (!this.handle) return;
    this.handle.unmount();
    this.handle = null;
    this.seen.clear();
  }

  /** 更新规则（前端配置变化时调用）。 */
  setRules(rules: GroupKeywordRules): void {
    this.rules = rules;
  }

  getRules(): GroupKeywordRules {
    return this.rules;
  }

  private onNewMessages(change: NewMessages): void {
    for (const msg of change.group) {
      void this.evaluate(msg);
    }
  }

  private async evaluate(msg: GroupMsg): Promise<void> {
    const groupCode = msg.targetGroupCode;
    const rule = this.rules[groupCode];
    const keyword = matchesRule(rule, msg);
    if (!keyword) return;

    const key = `${groupCode}:${msg.msgSeq}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > MAX_SEEN) {
      // Drop the oldest entries (insertion-ordered) to keep memory bounded.
      const overflow = this.seen.size - MAX_SEEN;
      let dropped = 0;
      for (const old of this.seen) {
        this.seen.delete(old);
        if (++dropped >= overflow) break;
      }
    }

    try {
      await this.opts.onHit({
        groupCode,
        msgSeq: msg.msgSeq,
        senderUid: msg.senderUid,
        senderUin: msg.senderUin,
        sendTime: msg.sendTime,
        keyword,
        text: plainTextOf(msg).slice(0, MAX_TEXT_LEN),
      });
    } catch (error) {
      // 通知 / 写库失败不影响后续消息；去掉去重标记好让重试有机会。
      this.seen.delete(key);
      throw error;
    }
  }
}

/**
 * 一条群消息是否命中某群规则。返回命中的关键词（未命中返回 null）。
 * - 规则缺失 / 关键词为空 → 不提醒；
 * - `memberUids` 非空时只认列表内成员发的消息（不指定即全部）；
 * - 关键词大小写不敏感，按子串匹配。
 */
export function matchesRule(
  rule: GroupKeywordRule | undefined,
  msg: Pick<GroupMsg, 'senderUid' | 'elements'>,
): string | null {
  if (!rule || rule.keywords.length === 0) return null;
  if (rule.memberUids.length > 0 && !rule.memberUids.includes(msg.senderUid)) return null;

  const text = plainTextOf(msg).toLowerCase();
  if (!text) return null;
  for (const keyword of rule.keywords) {
    const needle = keyword.trim().toLowerCase();
    if (needle && text.includes(needle)) return keyword.trim();
  }
  return null;
}

/** 消息的可搜索正文：text / at 取正文，其余元素对匹配无贡献，忽略。 */
function plainTextOf(msg: Pick<GroupMsg, 'elements'>): string {
  const parts: string[] = [];
  for (const el of msg.elements) {
    if (el.kind === 'text' || el.kind === 'at') parts.push(el.textContent);
  }
  return parts.join(' ').trim();
}

export type { GroupMsg };
