/**
 * BotCapabilities —— 主动能力封装（扩展轴③）。
 *
 * 把 OneBot 原生 action 包成语义方法，供未来「bot 主动做事」（撤回 / 戳一戳 / 改群名片 / 查群成员…）
 * 和 AI-tool hook 调用。新增能力只在这里加一个方法即可，不动编排层/适配层。
 * 底层统一走 adapter.callAction（echo RPC），napcat/snowluma 通用。
 */
import type { OneBot11Adapter } from './adapter/types';

export class BotCapabilities {
  constructor(private readonly adapter: OneBot11Adapter) {}

  /** 撤回一条消息。 */
  recall(messageId: string): Promise<unknown> {
    return this.adapter.callAction('delete_msg', { message_id: messageId });
  }

  /** 戳一戳（群内或私聊）。 */
  poke(userId: string, groupId?: string): Promise<unknown> {
    return this.adapter.callAction(
      'send_poke',
      groupId ? { group_id: Number(groupId), user_id: Number(userId) } : { user_id: Number(userId) },
    );
  }

  /** 改群名片。 */
  setGroupCard(groupId: string, userId: string, card: string): Promise<unknown> {
    return this.adapter.callAction('set_group_card', {
      group_id: Number(groupId),
      user_id: Number(userId),
      card,
    });
  }

  /** 查群成员列表。 */
  getGroupMembers(groupId: string): Promise<unknown> {
    return this.adapter.callAction('get_group_member_list', { group_id: Number(groupId) });
  }

  /** 查陌生人/群友资料。 */
  getStrangerInfo(userId: string): Promise<unknown> {
    return this.adapter.callAction('get_stranger_info', { user_id: Number(userId) });
  }

  /** 逃生口：调任意 OneBot action。 */
  call(action: string, params: Record<string, unknown>): Promise<unknown> {
    return this.adapter.callAction(action, params);
  }
}
