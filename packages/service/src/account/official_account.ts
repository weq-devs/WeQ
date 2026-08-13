/**
 * OfficialAccountService — QQ 公众号 (chatType 103) read-only accessor.
 *
 * 103 conversations physically live in `c2c_msg_table` / `recent_contact_v3_table`,
 * each with its own `peerUid`. We filter by chatType=103, pull the latest ARK
 * message per peer, and surface them as a feed. All other element types are
 * excluded (per user requirement).
 */

import type { AccountSession } from '@weq/account';
import type { RenderC2cMsg } from './msg';
import type { C2cMsg } from '@weq/db';
import { classifyChatType } from '@weq/codec';
import { filterArkOnly } from './ark_feed';
import { toRenderElements } from './msg_view';

export interface OfficialAccountSummary {
  peerUid: string;
  displayName: string;
  avatarUrl: string | null;
  targetUin: string;
  sendTime: bigint;
  prompt: string;
}

export interface ArkFeedMessage extends RenderC2cMsg {
  arkPrompt: string;
}

export class OfficialAccountService {
  constructor(private readonly session: AccountSession) {}

  /**
   * List all 公众号 accounts that have at least one ARK message. Returns
   * summary (latest prompt) for each.
   */
  async listAccounts(): Promise<OfficialAccountSummary[]> {
    const contacts = await this.session.recentContacts.getRecentContact();
    const out: OfficialAccountSummary[] = [];

    for (const c of contacts) {
      if (classifyChatType(c.chatType) !== 'official') continue;

      // Pull the real latest message (ignore 40051 preview blob).
      const latest = await this.session.c2cMsgs.listLatest({ uid: c.targetUid }, 1);
      const rendered = latest.map((msg: C2cMsg) => this.renderC2c(msg));
      const arkOnly = filterArkOnly(rendered);
      if (arkOnly.length === 0) continue; // No ARK message (shouldn't happen, defensive).

      const first = arkOnly[0];
      if (!first) continue;

      // 尝试从 profile_info.db 的 public_account_profile 表获取公众号名称和 uin
      let displayName = c.targetDisplayName;
      let targetUin = String(c.targetUin);
      try {
        const profile = await this.session.profileInfo.getProfile(c.targetUid);
        if (profile) {
          if (profile.nick) displayName = profile.nick;
          if (profile.uin && profile.uin !== 0n) targetUin = String(profile.uin);
        }
      } catch {
        // Fallback to recent_contact fields
      }

      out.push({
        peerUid: c.targetUid,
        displayName,
        avatarUrl: null, // 前端用 targetUin 拼接
        targetUin,
        sendTime: first.sendTime,
        prompt: first.arkPrompt,
      });
    }

    return out;
  }

  /**
   * Fetch the full ARK feed for one 公众号 (latest `limit` messages, ARK-only).
   */
  async listArkFeed(peerUid: string, limit = 100): Promise<ArkFeedMessage[]> {
    const msgs = await this.session.c2cMsgs.listLatest({ uid: peerUid }, limit);
    const rendered = msgs.map((msg: C2cMsg) => this.renderC2c(msg));
    return filterArkOnly(rendered);
  }

  private renderC2c(m: C2cMsg): RenderC2cMsg {
    return { ...m, elements: toRenderElements(m.elements) };
  }
}
