/**
 * RecentContactService — the recent-conversations list for one account.
 *
 * 合并 QQ 会话摘要与已确认发送的本地缓存，不写 QQ 数据库。返回结构化的
 * `RecentContact[]` (newest first); bigint timestamps are handled at the
 * IPC/JSON boundary by the caller.
 */

import type { AccountSession } from '@weq/account';
import { ChatType, classifyChatType, type PreviewElement } from '@weq/codec';
import type { RecentContact, RecentContactTop } from '@weq/db';
import type { GapFetchedMessage } from './gap_history';
import { elementToText } from './export/element_text';

export class RecentContactService {
  constructor(
    private readonly session: AccountSession,
    private readonly latestSent?: () => Promise<GapFetchedMessage[]>,
  ) {}

  /** Recent conversations, newest first. Defaults to 200. */
  async getRecentContact(
    limit = 200,
    offset = 0,
    opts: { excludeChatTypes?: readonly number[] } = {},
  ): Promise<RecentContact[]> {
    let sent: GapFetchedMessage[] = [];
    try {
      sent = (await this.latestSent?.()) ?? [];
    } catch (error) {
      console.warn('[RecentContact] 读取已发送摘要失败，保留 QQ 会话列表', error);
    }
    if (!sent.length) return this.session.recentContacts.getRecentContact(limit, offset, opts);

    const latest = new Map<string, GapFetchedMessage>();
    for (const message of sent) {
      if (!message.localSent || (message.kind === 'c2c' && !message.ntSeqVerified)) continue;
      const key = `${message.kind}:${message.conv}`;
      const previous = latest.get(key);
      if (!previous || BigInt(message.msgSeq) > BigInt(previous.msgSeq)) latest.set(key, message);
    }
    if (!latest.size) return this.session.recentContacts.getRecentContact(limit, offset, opts);
    // 摘要只会向前移动：读取原始前缀并精确补入发送目标即可，不必每页扫描完整列表。
    const [prefix, targets] = await Promise.all([
      this.session.recentContacts.getRecentContact(limit < 0 ? -1 : offset + limit, 0, opts),
      limit < 0
        ? Promise.resolve([])
        : this.session.recentContacts.getByTargetUids([...new Set(sent.map((row) => row.conv))]),
    ]);
    const byId = new Map(prefix.map((row) => [`${row.chatType}:${row.targetUid}`, row]));
    for (const row of targets) {
      const type =
        typeof row.chatType === 'number'
          ? row.chatType
          : ChatType[row.chatType as keyof typeof ChatType];
      const kind = classifyChatType(row.chatType);
      if (
        (kind !== 'direct' && kind !== 'group') ||
        (type !== undefined && opts.excludeChatTypes?.includes(type))
      )
        continue;
      byId.set(`${row.chatType}:${row.targetUid}`, row);
    }
    const rows = [...byId.values()];
    const merged = rows.map((row) => {
      const kind = classifyChatType(row.chatType);
      const message = latest.get(`${kind === 'direct' ? 'c2c' : kind}:${row.targetUid}`);
      if (
        !message ||
        BigInt(message.msgSeq) <= row.msgSeq ||
        BigInt(message.sendTime) < row.sendTime
      )
        return row;
      const previewElements: PreviewElement[] = message.elements.map((element) =>
        element.type === 'face'
          ? { kind: 'face', faceId: element.data.faceId, faceText: element.data.faceText }
          : { kind: 'text', textContent: elementToText(element) },
      );
      return {
        ...row,
        sendTime: BigInt(message.sendTime),
        senderUid: message.senderUid,
        senderDisplayName: '',
        senderNick: '',
        // 未读水位仍以 QQ 的真实 msgSeq 为准，不把发送缓存当成收到的新消息。
        preview: previewElements[0] ? { ...previewElements[0], previewElements } : null,
      };
    });
    merged.sort((a, b) => (a.sendTime === b.sendTime ? 0 : a.sendTime > b.sendTime ? -1 : 1));
    return limit < 0 ? merged.slice(offset) : merged.slice(offset, offset + limit);
  }

  /** Total count matching {@link getRecentContact} (same exclusion rules). */
  countRecentContact(opts: { excludeChatTypes?: readonly number[] } = {}): Promise<number> {
    return this.session.recentContacts.countRecentContact(opts);
  }

  /** 置顶会话，最近置顶的在前。 */
  getTopContacts(): Promise<RecentContactTop[]> {
    return this.session.recentContactTops.getTopContacts();
  }

  getByTargetUids(ids: readonly string[]): Promise<RecentContact[]> {
    return this.session.recentContacts.getByTargetUids(ids);
  }

  /**
   * 有草稿的会话 → 草稿时间（targetUid -> unix 秒）。读的是
   * `recent_contact_v3_table."41108"`（草稿表 `40050` 的跨表镜像），只返回
   * `41108 > 0` 的行。前端拿它和最后消息时间取最大值给会话排序。
   */
  listDraftTimes(): Promise<Map<string, bigint>> {
    return this.session.recentContacts.listDraftTimes();
  }
}
