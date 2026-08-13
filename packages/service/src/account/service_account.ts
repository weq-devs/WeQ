/**
 * ServiceAccountService — QQ 服务号 (chatType 118) read-only accessor.
 *
 * 118 conversations live in dedicated tables: `service_assistant_contact` (roster)
 * and `service_assistant_msg_table` (messages, partitioned by `appId` == 40035).
 * Like 公众号, we surface ARK-only feeds.
 */

import type { AccountSession } from '@weq/account';
import type { RenderC2cMsg } from './msg';
import type { C2cMsg } from '@weq/db';
import { filterArkOnly } from './ark_feed';
import { toRenderElements } from './msg_view';

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
   * List all 服务号 accounts that have at least one ARK message. Returns
   * summary (latest prompt) for each.
   */
  async listAccounts(): Promise<ServiceAccountSummary[]> {
    const contacts = await this.session.serviceAssistantContacts.listContacts();
    const out: ServiceAccountSummary[] = [];

    for (const c of contacts) {
      // Pull the real latest message (appId partition).
      const appId = c.appId;
      const latest = await this.session.serviceAssistantMsgs.listLatest({ appId }, 1);
      const rendered = latest.map((msg: C2cMsg) => this.renderC2c(msg));
      const arkOnly = filterArkOnly(rendered);
      if (arkOnly.length === 0) continue; // No ARK message (defensive).

      const first = arkOnly[0];
      if (!first) continue;

      out.push({
        appId: String(appId),
        displayName: c.displayName,
        avatarUrl: c.avatarUrl || null,
        sendTime: first.sendTime,
        prompt: first.arkPrompt,
      });
    }

    return out;
  }

  /**
   * Fetch the full ARK feed for one 服务号 (latest `limit` messages, ARK-only).
   */
  async listArkFeed(appId: bigint, limit = 100): Promise<ArkFeedMessage[]> {
    const msgs = await this.session.serviceAssistantMsgs.listLatest({ appId }, limit);
    const rendered = msgs.map((msg: C2cMsg) => this.renderC2c(msg));
    return filterArkOnly(rendered);
  }

  private renderC2c(m: C2cMsg): RenderC2cMsg {
    return { ...m, elements: toRenderElements(m.elements) };
  }
}
