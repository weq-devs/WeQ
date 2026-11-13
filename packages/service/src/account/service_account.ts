/**
 * ServiceAccountService — QQ 服务号 (chatType 118) read-only accessor.
 *
 * 118 conversations live in dedicated tables: `service_assistant_contact` (roster)
 * and `service_assistant_msg_table` (messages, partitioned by `appId` == 40035).
 * 完整会话保留全部消息类型；旧 listArkFeed 保持兼容语义。
 */

import type { AccountSession } from '@weq/account';
import type { RenderC2cMsg } from './msg';
import type { C2cMsg } from '@weq/db';
import { filterArkOnly } from './ark_feed';
import { toRenderElements } from './msg_view';
import { readonlyConversationPage, type ReadonlyPageRequest } from './readonly_conversation';
import { plainContentText } from '../common/message_plain_text';

export interface ServiceAccountSummary {
  appId: string;
  displayName: string;
  avatarUrl: string | null;
  sendTime: bigint;
  prompt: string;
}

export interface ArkFeedMessage extends RenderC2cMsg {
  arkPrompt: string;
}

export class ServiceAccountService {
  constructor(private readonly session: AccountSession) {}

  /**
   * 列出已登记服务号，不按最新消息的元素类型筛选。
   */
  async listAccounts(): Promise<ServiceAccountSummary[]> {
    const contacts = await this.session.serviceAssistantContacts.listContacts();
    const out: ServiceAccountSummary[] = [];

    for (const c of contacts) {
      // Pull the real latest message (appId partition).
      const appId = c.appId;
      const latest = await this.session.serviceAssistantMsgs.listLatest({ appId }, 1);
      const rendered = latest.map((msg: C2cMsg) => this.renderC2c(msg));
      const first = rendered[0];

      out.push({
        appId: String(appId),
        displayName: c.displayName,
        avatarUrl: c.avatarUrl || null,
        sendTime: first?.sendTime ?? 0n,
        prompt: first ? plainContentText(first.elements) : '',
      });
    }

    return out;
  }

  /**
   * Fetch the full ARK feed for one 服务号 (latest `limit` messages, ARK-only).
   */
  async listArkFeed(appId: bigint, limit = 100, anchorId?: string): Promise<ArkFeedMessage[]> {
    const msgs = anchorId
      ? await this.session.serviceAssistantMsgs.calendarMessage({ appId }, BigInt(anchorId))
      : await this.session.serviceAssistantMsgs.listLatest({ appId }, limit);
    const rendered = msgs.map((msg: C2cMsg) => this.renderC2c(msg));
    return filterArkOnly(rendered);
  }

  listMessages(appId: string, request: ReadonlyPageRequest) {
    return readonlyConversationPage(this.session, { kind: 'service', appId }, request);
  }

  private renderC2c(m: C2cMsg): RenderC2cMsg {
    return { ...m, elements: toRenderElements(m.elements) };
  }
}
