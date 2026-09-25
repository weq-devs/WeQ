/**
 * 会话列表排序口径 —— 纯函数、零依赖，因此单独作为
 * `@weq/service/conversation-order` 子路径导出（理由同 `report-time`）：
 * renderer 只 type-import 主 barrel（它会牵进 native/db），但「按什么时间排序」
 * 这件事必须能被真正 import 进浏览器包，也要能被单测直接跑。
 *
 * 排序键 = `max(最后消息时间, 草稿时间)`，两个时间都取自数据库：最后消息时间是
 * 会话行的 `40050`，草稿时间是 `recent_contact_v3_table."41108"`（草稿表 `40050`
 * 的跨表镜像）。QQ 自己在同一张表里用 `41136` 表达同一件事（见
 * `docs/database/nt_msg/recent-contact.md`）；WeQ 在渲染层按同一口径重算，是因为
 * 主列表还并进了隐藏 / 删除等条目、且按置顶表（`41103`）重排。
 *
 * 输入框里**还没落库**的内容不参与排序 —— 排序只认库里有什么。
 */

/** 后端 `listConversationDraftTimes` 返回的一行（`recent_contact_v3_table."41108"`）。 */
export interface ConversationDraftTimeRow {
  /** 会话键：c2c 是对端 uid，群是群号 —— 对齐会话 id。 */
  targetUid: string;
  /** 草稿时间，unix 秒（bigint 过 JSON 后是字符串）。 */
  draftTime: string;
}

/**
 * 组装「会话 id → 草稿时间（毫秒）」。
 *
 * 只认**数据库里的** `41108`（> 0 的行）。刻意不掺输入框里还没落库的内容 ——
 * 排序是「库里有什么就是什么」，本地正在编辑的半成品不该让会话跳位置。
 */
export function draftSortTimes(rows: readonly ConversationDraftTimeRow[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const row of rows) {
    if (!row.targetUid) continue;
    const sec = Number(row.draftTime);
    if (Number.isFinite(sec) && sec > 0) map[row.targetUid] = sec * 1000;
  }
  return map;
}

/**
 * 单条会话的排序时间（毫秒）= `max(最后消息时间, 草稿时间)`。
 * `updatedAt` 解析不出来时按 0 处理（会话仍会按草稿时间参与排序）。
 */
export function conversationSortTime(updatedAt: string, draftTimeMs: number | undefined): number {
  const msgMs = Date.parse(updatedAt);
  return Math.max(Number.isFinite(msgMs) ? msgMs : 0, draftTimeMs ?? 0);
}
