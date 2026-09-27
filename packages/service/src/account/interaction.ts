/**
 * InteractionService — 会话内的「轻互动」：戳一戳（0xED3_1）与群消息贴表情
 * （0x9082_1/2）。两条都是 OIDB 发包，需要已注入的在线 QQ 进程。
 *
 * 与 PeerStatsService 同构：注入发生在账号 bootstrap，这里只负责在在线 pid 上
 * 发包 + 目标解析，离线 / 风控失败原样上抛。
 *
 * 注意与「窗口抖动」区分：窗口抖动是私聊消息里的 `commonElem serviceType=2`
 * 元素，走 `MessageSendService.sendElements`（MCP 的 send_rich_message，元素
 * `{"kind":"poke"}`）；本服务的 sendPoke 是聊天窗口里那个「戳一戳」灰条。
 */
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { SendPoke, SetReaction } from '@weq/protocol';

export interface SendPokeParams {
  /** c2c = 私聊，group = 群聊。 */
  peerType: 'c2c' | 'group';
  /** 群号（群聊）或 QQ 号（私聊，纯数字）。 */
  targetId: string;
  /** 群聊里要被戳的成员 uin；缺省戳群本身。 */
  targetUin?: string;
}

export class InteractionService {
  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendOidbPacket'>,
    private readonly session: AccountSession,
    private readonly resolvePid: () => number,
  ) {}

  /** 把纯数字目标解析成 uin；非纯数字按 uid 反查本地 uid 目录。 */
  private resolveUin(input: string, what: string): number {
    const text = input.trim();
    if (!text) throw new Error(`${what}不能为空。`);
    if (!/^\d+$/.test(text)) {
      const uin = this.session.uidMap.uinByUid(text);
      if (!uin) {
        throw new Error(
          `本地 uid 目录里没有 uid「${text}」。可以用 find_contact / search_buddies 拿准确 uid，或直接传 QQ 号。`,
        );
      }
      return Number(uin);
    }
    const uin = Number(text);
    if (!Number.isSafeInteger(uin) || uin <= 0) throw new Error(`${what}不合法：${text}`);
    return uin;
  }

  /** 戳一戳（OIDB 0xED3_1）。群聊 + 私聊都支持。 */
  async sendPoke(params: SendPokeParams): Promise<void> {
    const peerUin = this.resolveUin(
      params.targetId,
      params.peerType === 'group' ? '群号' : 'QQ 号',
    );
    const targetUin =
      params.targetUin === undefined
        ? undefined
        : this.resolveUin(params.targetUin, '被戳成员 QQ 号');
    await SendPoke.invoke(this.nt, this.resolvePid(), {
      isGroup: params.peerType === 'group',
      peerUin,
      ...(targetUin !== undefined ? { targetUin } : {}),
    });
  }

  /**
   * 给某条群消息贴 / 撤表情回应（OIDB 0x9082_1/2）。
   *
   * `code` 是表情 id：1–3 位是 QQ 小黄脸 id（如 76 / 124），更长的是 Unicode
   * 码点（如 128516 = 😄）—— 协议层按长度自动分 type，调用方不用管。
   */
  async setMessageReaction(params: {
    groupId: string | number;
    sequence: number;
    code: string;
    isSet: boolean;
  }): Promise<void> {
    await SetReaction.invoke(this.nt, this.resolvePid(), {
      groupId: Number(params.groupId),
      sequence: params.sequence,
      code: params.code,
      isSet: params.isSet,
    });
  }
}
