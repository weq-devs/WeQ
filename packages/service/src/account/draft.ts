/**
 * DraftService — 读写 `nt_msg.db` 的 `draft_storage_table_v1`（会话草稿）。
 *
 * **WeQ 不再自己存草稿**：输了一半的内容直接落 QQ 自己的草稿表，与 QQ 客户端
 * 共用同一份状态，切设备/切账号都跟着走。表结构与字段含义见
 * `docs/database/nt_msg/draft-storage.md`。
 *
 * 为什么写库要成对做两件事：
 *   - `draft_storage_table_v1` 只存正文，会话列表的「有草稿 / 排序」看的是
 *     `recent_contact_v3_table` 的两列镜像 —— `41108`（草稿时间）与 `41136`
 *     （排序键）。所以每次写/删草稿都必须把这两列一起同步，否则会话列表不动。
 *
 * 写入策略（产品决定）：**不做逐字写、也不做兜底**。前端只在「离开会话 / 离开
 * 消息页 / 应用退出」这类时刻调用一次；WeQ 意外关闭导致没写成，就按没草稿处理。
 * 写不进去（QQ 离线、库被锁）也直接失败，不往本地缓存回落。
 */

import type { AccountSession } from '@weq/account';
import type { Element } from '@weq/codec';
import type { Draft } from '@weq/db';

/** 会话类型（= `draftStorageKey` 里那一段，也就是 ChatType 的两个主值）。 */
export type DraftPeerKind = 'c2c' | 'group';

/** `chatType` 数字 ↔ 服务层用的 kind。 */
export function chatTypeOf(kind: DraftPeerKind): number {
  return kind === 'group' ? 2 : 1;
}

export interface SaveDraftInput {
  kind: DraftPeerKind;
  /** c2c 是对端 uid，群是群号。 */
  targetUid: string;
  /** 草稿正文（按 40800 全量元素）。空数组 = 删除该会话的草稿。 */
  elements: Element[];
}

export class DraftService {
  constructor(private readonly session: AccountSession) {}

  /**
   * 整表读（这张表只有几行）。返回的 `elements` 是按 40800 全量解析的正文，
   * 文本 / @ / 表情 / 图片 / 视频 / 文件 / markdown / ark / 引用…… 都在里面。
   */
  async listDrafts(): Promise<Draft[]> {
    return this.session.drafts.listDrafts();
  }

  /**
   * 写入一份草稿并同步会话列表镜像。
   *
   * `elements` 为空时不写空行，而是直接删掉草稿（QQ 在清空输入框后也是把这一行
   * 移除，并且 `41108` 归零、`41136` 回落到 `40050`）。
   */
  async saveDraft(input: SaveDraftInput): Promise<void> {
    const chatType = chatTypeOf(input.kind);
    if (input.elements.length === 0) {
      return this.clearDraft(input.kind, input.targetUid);
    }
    const sendTime = BigInt(Math.floor(Date.now() / 1000));
    await this.session.drafts.saveDraft({
      chatType,
      targetUid: input.targetUid,
      sendTime,
      elements: input.elements,
    });
    await this.session.recentContacts.setDraftTime(input.targetUid, sendTime);
  }

  /** 删掉一个会话的草稿，并把 `41108` 归零、`41136` 回落。 */
  async clearDraft(kind: DraftPeerKind, targetUid: string): Promise<void> {
    await this.session.drafts.deleteDraft(chatTypeOf(kind), targetUid);
    await this.session.recentContacts.setDraftTime(targetUid, null);
  }
}
