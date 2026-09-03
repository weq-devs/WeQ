/**
 * 频道私聊（guild direct）导出源。
 *
 * 频道私聊消息在 `guild_msg.db` 的 `guild_msg_table`（按 40027 nodeId 分区），
 * 不在主聊天库 nt_msg.db 里，导出管线的通用 c2c 消息源读不到。这里把 guild
 * 消息适配成 c2c 渲染行（对外 kind 仍走 `c2c`），让 json/jsonl/csv/xlsx/txt/html
 * 及媒体/装扮/头像等阶段原样复用：
 *
 *   - senderUid：对方 = peerTinyId；自己 = 账号在该频道的 tinyId。
 *   - senderUin：频道私聊没有 QQ 号，恒为 ''（输出记录里保持缺省语义）。
 *   - 转发记录（multiMsg）不展开：guild 的消息没有 40900 转发缓存表可回读。
 *   - 漫游/消息补全不适用：IPC 侧强制 completeMessages=false。
 */

import type { Element, MsgDecoration } from '@weq/codec';
import type { GuildDirectService, RenderGuildDirectMsg } from '../guild_direct';
import type { RenderC2cMsg } from '../msg';

/** 频道私聊导出任务的身份快照（全部 JSON 可序列化，随任务持久化）。 */
export interface GuildExportTaskMeta {
  /** 40027 会话分区 key（消息查询键）。 */
  nodeId: string;
  /** 对方 guild tinyId（作为导出任务的 conv / 成员 uid）。 */
  peerTinyId: string;
  /** 42052 guild id。 */
  guildId: string;
  /** 42053 guild 名。 */
  guildName: string;
  /** 对方展示昵称（频道昵称 → 全局昵称 → tinyId 兜底）。 */
  peerNick: string;
  /** 对方头像 URL（avatar_meta 派生；可为 null）。 */
  peerAvatarUrl: string | null;
  /** 本账号在该会话的 tinyId；没发过消息时为 ''。 */
  selfTinyId: string;
  /** 本账号 QQ 昵称。 */
  selfNick: string;
  /** 本账号 QQ 号（'' 未知）。 */
  selfUin: string;
  /** 本账号 QQ uid（'' 未知）。 */
  selfUid: string;
  /** 本账号 QQ 头像公网 URL（'' 未知时可为 null）。 */
  selfAvatarUrl: string | null;
}

/** 把一行频道私聊消息映射成导出管线的 c2c 渲染行。 */
function toC2cRender(m: RenderGuildDirectMsg, meta: GuildExportTaskMeta): RenderC2cMsg {
  const mine = m.sendType !== 0n;
  const senderTiny = m.senderTinyId.toString();
  const senderUid = mine ? meta.selfTinyId || senderTiny : meta.peerTinyId || senderTiny;
  const row: Record<string, unknown> = {
    msgId: m.msgId,
    msgSeq: m.msgSeq,
    targetUid: meta.peerTinyId,
    targetUin: 0n,
    senderUid,
    // 频道私聊没有 QQ 号；导出时统一输出空串而非 '0'。
    senderUin: '' as unknown as bigint,
    sendTime: m.sendTime,
    elements: m.elements,
  };
  if (m.msgType !== undefined) row.msgType = m.msgType;
  if (m.subType !== undefined) row.subType = m.subType;
  if (m.decoration) row.decoration = m.decoration;
  return row as unknown as RenderC2cMsg;
}

/**
 * 频道私聊消息源——实现导出管线 c2c 分支用到的 `MsgService` 成员子集。
 * 任务管理器在 guild 任务上用它替换 `this.msgs`（见 task_manager.msgsFor）。
 */
export class GuildMsgSource {
  constructor(
    private readonly svc: GuildDirectService,
    private readonly meta: GuildExportTaskMeta,
  ) {}

  /** 比 afterSeq 更新的一页（seq 升序）——与 iterateC2cMessages 的游标契约一致。 */
  async getC2cAfter(_peerUid: string, afterSeq: bigint, limit = 50): Promise<RenderC2cMsg[]> {
    const page = await this.svc.getAfter(this.meta.nodeId, afterSeq, limit);
    return page.map((m) => toC2cRender(m, this.meta));
  }

  /** 频道消息没有 seq-less（安卓迁移）块，恒空。 */
  async getC2cSeqlessAfterRowId(): Promise<Array<RenderC2cMsg & { rowId: bigint }>> {
    return [];
  }

  /** 消息补全不适用（IPC 强制关闭）；给个空 seq 窗口兜底。 */
  async getC2cSeqDesc(): Promise<{ seqs: bigint[]; below: bigint | null; above: bigint | null }> {
    return { seqs: [], below: null, above: null };
  }

  /** 会话本地消息计数（带发送时间窗）。 */
  async countConv(
    _kind: string,
    _conv: string,
    range?: { startTime?: number; endTime?: number },
  ): Promise<number> {
    return this.svc.countMessages(this.meta.nodeId, range ?? {});
  }

  /** 回读 40800 原始元素（媒体补全阶段定位 video/file/ptt 用）。 */
  async getRawElements(msgId: bigint): Promise<{ elements: Element[]; kind: 'c2c' } | null> {
    const elements = await this.svc.rawElementsOf(msgId);
    return elements ? { elements, kind: 'c2c' } : null;
  }

  /** 回读 40801 装扮（装扮扫描阶段用）。 */
  async getMsgDecoration(msgId: bigint): Promise<MsgDecoration | null> {
    return this.svc.decorationOf(msgId);
  }

  /** 频道消息没有 40900 转发缓存，转发记录保持原元素不展开。 */
  async listForward(): Promise<never[]> {
    return [];
  }

  /** 不把语音转写写回频道库（QQ 本体不读这里，避免误导）。 */
  async setPttTranscript(): Promise<boolean> {
    return false;
  }
}
