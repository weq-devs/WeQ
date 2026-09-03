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
import type { GuildDirectMsg, GuildDirectSession } from '@weq/db';
import { toRenderElements, type RenderElement } from './msg_view';

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
}

function renderGuildDirectMsg(m: GuildDirectMsg): RenderGuildDirectMsg {
  return { ...m, elements: toRenderElements(m.elements) };
}
