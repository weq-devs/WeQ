/**
 * QQ 公众号（103）只读入口，按 peerUid 读取 c2c_msg_table。
 * 目录与完整消息页保留全部元素类型；旧 listArkFeed 只用于兼容调用方。
 */

import type { AccountSession } from '@weq/account';
import type { RenderC2cMsg } from './msg';
import type { C2cMsg } from '@weq/db';
import { classifyChatType } from '@weq/codec';
import { feedConversationPreview, filterArkOnly } from './ark_feed';
import { toRenderElements } from './msg_view';
import { resolveC2cPartition } from './c2c_partition';
import { readonlyConversationPage, type ReadonlyPageRequest } from './readonly_conversation';
import { messageReadPosition, messageReadCursor } from '../common/client_preferences';

export interface OfficialAccountSummary {
  peerUid: string;
  displayName: string;
  avatarUrl: string | null;
  targetUin: string;
  sendTime: bigint;
  prompt: string;
  latestReadPosition: string;
}

export interface ArkFeedMessage extends RenderC2cMsg {
  arkPrompt: string;
}

export class OfficialAccountService {
  constructor(private readonly session: AccountSession) {}

  /**
   * 列出已登记公众号，最新记录不含 Ark 时也保留会话。
   */
  async listAccounts(): Promise<OfficialAccountSummary[]> {
    const contacts = await this.session.recentContacts.getRecentContact();
    const out: OfficialAccountSummary[] = [];

    for (const c of contacts) {
      if (classifyChatType(c.chatType) !== 'official') continue;

      // Pull the real latest message (ignore 40051 preview blob).
      const latest = await this.session.c2cMsgs.listHistory(
        await resolveC2cPartition(this.session.uidMap, c.targetUid),
        {
          min: -(1n << 63n),
          max: (1n << 63n) - 1n,
          descending: true,
          limit: 1,
          includeSeqless: true,
        },
      );
      const rendered = latest.map((msg: C2cMsg) => this.renderC2c(msg));
      const first = rendered[0];

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
        sendTime: first?.sendTime ?? c.sendTime,
        prompt: first ? feedConversationPreview(first.elements) : '',
        latestReadPosition: first ? messageReadPosition(first) : '0:0:0',
      });
    }

    return out;
  }

  /**
   * Fetch the full ARK feed for one 公众号 (latest `limit` messages, ARK-only).
   */
  async listArkFeed(peerUid: string, limit = 100, anchorId?: string): Promise<ArkFeedMessage[]> {
    const partition = await resolveC2cPartition(this.session.uidMap, peerUid);
    const msgs = anchorId
      ? await this.session.c2cMsgs.calendarMessage(partition, BigInt(anchorId))
      : await this.session.c2cMsgs.listLatest(partition, limit);
    const rendered = msgs.map((msg: C2cMsg) => this.renderC2c(msg));
    return filterArkOnly(rendered);
  }

  listMessages(peerUid: string, request: ReadonlyPageRequest) {
    return readonlyConversationPage(this.session, { kind: 'official', peerUid }, request);
  }
  async countUnread(peerUid: string, readSeq: string) {
    return this.session.c2cMsgs.countIncomingAfter(
      await resolveC2cPartition(this.session.uidMap, peerUid),
      messageReadCursor(readSeq),
    );
  }

  private renderC2c(m: C2cMsg): RenderC2cMsg {
    return { ...m, elements: toRenderElements(m.elements) };
  }
}
