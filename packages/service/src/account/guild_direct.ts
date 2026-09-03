/**
 * GuildDirectService - QQ 频道私聊 (direct) sessions + message paging.
 *
 * Conversation list reads ONLY `direct_node_list_table` (guild_msg.db); it
 * never derives sessions by scanning `guild_msg_table`. Message pages read
 * `guild_msg_table` by the 40027 node id (indexed), newest-first like the
 * c2c seq-window contract. Peer display info comes from guild1.db's
 * `t_GPro_CommonUserProfile_v2` (never `t_GPro_ProfileInfo`).
 */

import type { AccountSession } from '@weq/account';
import type { Element, MsgDecoration } from '@weq/codec';
import type { GuildDirectMsg, GuildDirectSession } from '@weq/db';
import { toRenderElements, type RenderElement } from './msg_view';
import type { GuildExportTaskMeta } from './export/guild_source';

/** One DM conversation row + the peer profile resolved for display. */
export interface GuildDirectSessionView {
  /** Conversation node id (40027) - the key for message queries. */
  nodeId: string;
  /** 40022 direct route gid. */
  directGid: string;
  /** 40050 newest message time (unix seconds). */
  lastTime: string;
  /** 40003 newest message seq. */
  lastSeq: string;
  /** 42051 peer guild tiny id. */
  peerTinyId: string;
  /** 42052 guild id. */
  guildId: string;
  /** 42053 guild display name (the channel circle this DM lives in). */
  guildName: string;
  /** Display name: channel nick -> global nick -> profile nick -> id. */
  peerNick: string;
  /** Avatar URL derived from avatar_meta_ (null when unresolvable). */
  peerAvatarUrl: string | null;
  /** Decoded 40051 preview element (may not carry visible text). */
  preview: unknown | null;
  /** 本地消息总数（导出任务的进度分母；频道私聊没有漫游缓存可并计）。 */
  messageCount: number;
  /** Raw session row kept for the wire (peer nick / guild columns). */
  raw: Omit<GuildDirectSession, 'preview'>;
}

/** Guild DM message, elements mapped to the render view model. */
export interface RenderGuildDirectMsg extends Omit<GuildDirectMsg, 'elements'> {
  elements: RenderElement[];
}

/** Avatar-URL rules for `avatar_meta_` (see t_GPro_CommonUserProfile_v2). */
export function guildAvatarUrlFromMeta(meta: string): string | null {
  if (!meta) return null;
  const firstHash = meta.indexOf('#');
  const head = firstHash >= 0 ? meta.slice(0, firstHash) : '';
  const rest = firstHash >= 0 ? meta.slice(firstHash + 1) : meta;
  const seg = rest.split('#')[0] ?? '';
  if (!seg) return null;
  if (head === '0') {
    // e.g. "0#k-token&kti=xxxx#60#ts" -> thirdqq oidb avatar.
    const params = new URLSearchParams();
    params.set('b', 'oidb');
    for (const pair of seg.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq < 0) params.set('k', pair);
      else params.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    params.set('s', '0');
    return `https://thirdqq.qlogo.cn/g?${params.toString()}`;
  }
  if (head === '1') {
    // e.g. "1#<uuid>#31#ts" -> qqchannel profile bucket.
    return `https://qqchannel-profile-1251316161.file.myqcloud.com/${seg}/140`;
  }
  return null;
}

/** 自己的公开头像：主帐号有 QQ 号，用与 c2c 导出同款 qlogo CDN。 */
function qqAvatarUrlForUin(uin: string): string {
  return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`;
}

export class GuildDirectService {
  constructor(private readonly session: AccountSession) {}

  /** Every 频道私聊 conversation, newest first. Empty when the DB is absent. */
  async listSessions(): Promise<GuildDirectSessionView[]> {
    try {
      const sessions = await this.session.guildDirectNodes.listSessions();
      if (sessions.length === 0) return [];
      const tinyIds = sessions.map((s) => s.peerTinyId);
      const profiles = await this.session.guildCommonProfiles.listByTinyIds(tinyIds);
      const byTinyId = new Map(profiles.map((p) => [p.tinyId, p]));
      const countByNode = new Map(
        (await this.session.guildDirectMsgs.countAllByNode()).map((c) => [c.nodeId, c.count]),
      );
      return sessions.map((s) => {
        const profile = byTinyId.get(s.peerTinyId);
        return {
          nodeId: s.nodeId.toString(),
          directGid: s.directGid,
          lastTime: s.lastTime.toString(),
          lastSeq: s.lastSeq.toString(),
          peerTinyId: s.peerTinyId.toString(),
          guildId: s.guildId.toString(),
          guildName: s.guildName,
          peerNick: s.nickChannel || s.nickGlobal || profile?.nick || s.peerTinyId.toString(),
          peerAvatarUrl: profile ? guildAvatarUrlFromMeta(profile.avatarMeta) : null,
          preview: s.preview ?? null,
          messageCount: countByNode.get(s.nodeId) ?? 0,
          raw: s,
        };
      });
    } catch (e) {
      console.error('[GuildDirectService] listSessions failed:', e);
      return [];
    }
  }

  /** Newest N messages of one DM conversation, newest-first (seq DESC). */
  async getLatest(nodeId: string, limit = 50): Promise<RenderGuildDirectMsg[]> {
    const msgs = await this.session.guildDirectMsgs.listLatest(BigInt(nodeId), limit);
    return msgs.map(renderGuildDirectMsg);
  }

  /** The page just older than `beforeSeq` (exclusive), newest-first. */
  async getBefore(nodeId: string, beforeSeq: bigint, limit = 50): Promise<RenderGuildDirectMsg[]> {
    const msgs = await this.session.guildDirectMsgs.listBefore(BigInt(nodeId), beforeSeq, limit);
    return msgs.map(renderGuildDirectMsg);
  }

  /** The page just newer than `afterSeq` (exclusive), oldest-first. */
  async getAfter(nodeId: string, afterSeq: bigint, limit = 50): Promise<RenderGuildDirectMsg[]> {
    const msgs = await this.session.guildDirectMsgs.listAfter(BigInt(nodeId), afterSeq, limit);
    return msgs.map(renderGuildDirectMsg);
  }

  /** 该会话本地消息数（导出任务进度分母；可按发送时间窗过滤）。 */
  async countMessages(
    nodeId: string,
    range: { startTime?: number; endTime?: number } = {},
  ): Promise<number> {
    return this.session.guildDirectMsgs.countMessages(BigInt(nodeId), range);
  }

  /** 本账号在该会话自己发的第一条消息的 guild tinyId；没发过时为 ''。 */
  async selfTinyId(nodeId: string): Promise<string> {
    const v = await this.session.guildDirectMsgs.findSelfTinyId(BigInt(nodeId));
    return v === null || v === 0n ? '' : v.toString();
  }

  /** 按 msgId 回读 40800 原始元素（导出媒体补全阶段用）。 */
  async rawElementsOf(msgId: bigint): Promise<Element[] | null> {
    const blob = await this.session.guildDirectMsgs.getMsgBody(msgId);
    if (!blob) return null;
    const { decodeBody } = await import('@weq/db');
    return decodeBody(blob);
  }

  /** 按 msgId 回读 40801 装扮（导出装扮阶段用）。 */
  async decorationOf(msgId: bigint): Promise<MsgDecoration | null> {
    const blob = await this.session.guildDirectMsgs.getMsgDressBlob(msgId);
    if (!blob) return null;
    const { decodeDress } = await import('@weq/db');
    return decodeDress(blob) ?? null;
  }

  /**
   * 导出任务的身份快照（IPC 一次性组装，随任务持久化供历史回放）。
   * 对方用 direct_node_list_table + guild1.db profile；自己用
   * guild_msg_table 里发过的第一条消息的 tinyId + 主帐号账户
   * 资料库的 QQ 号/昵称。频道私聊没有 QQ 号，
   * senderUin 统一为 ''（消息不可能是漫游拉来的）。
   */
  async buildExportMeta(nodeId: string): Promise<GuildExportTaskMeta> {
    const node = BigInt(nodeId);
    const sessions = await this.session.guildDirectNodes.listSessions();
    const s = sessions.find((x) => x.nodeId === node);
    if (!s) throw new Error(`未找到频道私聊会话（nodeId=${nodeId}）`);
    const profiles = await this.session.guildCommonProfiles.listByTinyIds([s.peerTinyId]);
    const profile = profiles[0] ?? null;
    const selfTinyId = await this.selfTinyId(nodeId);
    const selfUin = this.session.context.uin;
    let selfNick = '';
    if (selfUin) {
      try {
        const selfProfile = await this.session.profileInfo.getProfileByUin(BigInt(selfUin));
        selfNick = selfProfile?.nick ?? '';
      } catch {
        // 资料库缺失时昵称留空；导出时回退到 platformId。
      }
    }
    return {
      nodeId,
      peerTinyId: s.peerTinyId.toString(),
      guildId: s.guildId.toString(),
      guildName: s.guildName,
      peerNick: s.nickChannel || s.nickGlobal || profile?.nick || s.peerTinyId.toString(),
      peerAvatarUrl: profile ? guildAvatarUrlFromMeta(profile.avatarMeta) : null,
      selfTinyId,
      selfNick,
      selfUin,
      selfUid: '',
      selfAvatarUrl: selfUin ? qqAvatarUrlForUin(selfUin) : null,
    };
  }
}

function renderGuildDirectMsg(m: GuildDirectMsg): RenderGuildDirectMsg {
  return { ...m, elements: toRenderElements(m.elements) };
}
