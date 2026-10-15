/**
 * InteractionService — 会话内的「轻互动」：戳一戳（0xED3_1）、群消息贴表情
 * （0x9082_1/2 贴 / 撤）与贴表情的**查询侧**（0x9083_1 某表情的回应人名单）。
 * 三条都是 OIDB 发包，需要已注入的在线 QQ 进程。
 *
 * 与 PeerStatsService 同构：注入发生在账号 bootstrap，这里只负责在在线 pid 上
 * 发包 + 目标解析，离线 / 风控失败原样上抛。
 *
 * 注意与「窗口抖动」区分：窗口抖动是私聊消息里的 `commonElem serviceType=2`
 * 元素，走 `MessageSendService.sendElements`（MCP 的 send_rich_message，元素
 * `{"kind":"poke"}`）；本服务的 sendPoke 是聊天窗口里那个「戳一戳」灰条。
 */
import { createHash } from 'node:crypto';
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import {
  detectImageFormat,
  GetEmojiLikes,
  SendGroupJoinRequest,
  SendGroupSignup,
  SendPoke,
  SetReaction,
  type SendGroupSignupImage,
} from '@weq/protocol';

/** 报名图片下载超时（毫秒）。 */
const SIGNUP_IMAGE_TIMEOUT_MS = 15_000;

/**
 * PC/Linux 端发 0x921b 会被服务端在 OIDB 外层拒绝，native 抛出的原文形如：
 * `Reply status error: 319 ([oidb] rule type not match appid,...)`。
 * 这与图文 Ark 的 901501 是同一类「平台规则不匹配」缺口（详见 docs/develop/group-signup.md），
 * 这里把它翻译成可读错误，避免调用方以为是参数写错。
 */
function isSignupPlatformReject(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('rule type not match appid') || /status error: *319\b/.test(text);
}

export interface SendPokeParams {
  /** c2c = 私聊，group = 群聊。 */
  peerType: 'c2c' | 'group';
  /** 群号（群聊）或 QQ 号（私聊，纯数字）。 */
  targetId: string;
  /** 群聊里要被戳的成员 uin；缺省戳群本身。 */
  targetUin?: string;
}

/** 入群申请（OIDB 0x11ec_1）的入参。 */
export interface SendGroupJoinRequestServiceParams {
  /** 目标群号（数字或纯数字字符串）。 */
  groupCode: string | number;
  /** 分享码换来的鉴权串（64 字符 base64）。由调用方提供，本服务不生成。 */
  authKey: string;
  /** 入群问题的答案；缺省空串。 */
  answer?: string;
}

export interface MessageReactionUsersParams {
  /** 群号。 */
  groupId: string | number;
  /** 被回应消息的 msgSeq。 */
  sequence: number;
  /** 表情 id（贴表情用的那个 code）。 */
  emojiId: string;
  /** 1 = QQ 小黄脸短 id，2 = Unicode 码点；缺省按 emojiId 长度推断。 */
  emojiType?: number;
  /** 每页条数（缺省 30，IPC 侧会夹到 1..200）。 */
  count?: number;
  /** 上一页返回的续传 cookie；首页不传。 */
  cookie?: string;
}

/** 面板里的一行回应者。 */
export interface MessageReactionUser {
  /** QQ 号（十进制字符串，直接当头像 URL 的 nk 用）。 */
  uin: string;
  /** 显示名：服务端昵称 → 本地备注 / 昵称 → 空串（由前端退化成 uin）。 */
  nick: string;
  /** 头像直链：服务端 headUrl → 本地 profile.avatarUrl → 空串（由前端退回 qlogo）。 */
  avatarUrl: string;
}

export interface MessageReactionUsersPage {
  users: MessageReactionUser[];
  /** 下一页 cookie（空串 = 已到末页）。 */
  cookie: string;
  isLast: boolean;
}

export interface SendGroupSignupServiceParams {
  /** 目标群号（数字或纯数字字符串）。 */
  groupCode: string | number;
  /** 标题。 */
  title: string;
  /** 详情正文。 */
  detail: string;
  /** 报名截止时间（unix 秒，UTC）。不填 = 不截止。 */
  deadline?: number;
  /** 报名方式：1 = 直接报名（默认），2 = 上传图片。 */
  method?: 1 | 2;
  /** 报名人数上限（默认 200）。 */
  maxCount?: number;
  /**
   * 附带图片的直链（可选）。服务会**请求一次该 URL** 算出 md5 与像素宽高，再上 wire；
   * 请求失败 / 空响应会直接报错，**不会**发出没有图片信息的报名。
   */
  imageUrl?: string;
}

export class InteractionService {
  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendOidbPacket'>,
    private readonly session: AccountSession,
    private readonly resolvePid: () => number,
  ) {}

  /** 下载报名图片并算出 `{ url, md5, width, height }`；拿不到字节则抛错。 */
  private async resolveSignupImage(url: string): Promise<SendGroupSignupImage> {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(SIGNUP_IMAGE_TIMEOUT_MS) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`报名图片下载失败（${url}）：${reason}`);
    }
    if (!res.ok) throw new Error(`报名图片下载失败（${url}）：HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) throw new Error(`报名图片为空（${url}）`);
    const { width, height } = detectImageFormat(bytes);
    const md5 = createHash('md5').update(bytes).digest('hex');
    return { url, md5, width, height };
  }

  /**
   * 发一条**群报名 / 群收集表**卡片（OIDB 0x921b_0）。
   *
   * 附带图片时只收 `imageUrl`：这里请求一次资源算 md5 + 宽高（QQ 端按 URL+md5 取图），
   * 请求不到就直接报错、不发。返回实际写进协议的图片信息，方便调用方回显。
   */
  async sendGroupSignup(
    params: SendGroupSignupServiceParams,
  ): Promise<{ image?: SendGroupSignupImage }> {
    const image = params.imageUrl ? await this.resolveSignupImage(params.imageUrl) : undefined;
    try {
      await SendGroupSignup.invoke(this.nt, this.resolvePid(), {
        groupCode: Number(params.groupCode),
        title: params.title,
        detail: params.detail,
        ...(params.deadline && params.deadline > 0 ? { deadline: params.deadline } : {}),
        ...(params.method !== undefined ? { method: params.method } : {}),
        ...(params.maxCount !== undefined ? { maxCount: params.maxCount } : {}),
        ...(image ? { image } : {}),
      });
    } catch (error) {
      if (isSignupPlatformReject(error)) {
        throw new Error(
          '服务端拒绝了群报名卡片：319 [oidb] rule type not match appid（登录态白名单校验失败）。' +
            '这是 PC/Linux 端与 Android 端的平台规则差异（和图文 Ark 的 901501 同源），' +
            '不是参数写错；当前实现无法在 PC/Linux 上发出该卡片。' +
            '原始返回：' +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      throw error;
    }
    return image ? { image } : {};
  }

  /**
   * 发一条**入群申请**（OIDB 0x11ec_1）。
   *
   * `authKey` 必须由调用方提供 —— 它是「分享码换来的鉴权串」（见
   * `@weq/service` 的 `resolveGroupShareAuthKey`），服务端按值校验：有效值直接放行，
   * 无效 / 全零会降级成短信安全验证（native 侧同样按成功 ack 返回，拿不到那条链接）。
   *
   * `answer` 是自动进群问题的答案，缺省空串（照样显式上 wire，与抓包一致）。
   */
  async sendGroupJoinRequest(params: SendGroupJoinRequestServiceParams): Promise<void> {
    const groupCode = Number(params.groupCode);
    if (!Number.isSafeInteger(groupCode) || groupCode <= 0) {
      throw new Error(`群号不合法：${String(params.groupCode)}`);
    }
    if (!params.authKey) throw new Error('缺少入群鉴权串（authKey）。');
    await SendGroupJoinRequest.invoke(this.nt, this.resolvePid(), {
      groupCode,
      authKey: params.authKey,
      ...(params.answer !== undefined ? { answer: params.answer } : {}),
    });
  }

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
   * 查某条群消息上**某个表情**的回应人名单（OIDB 0x9083_1，可分页）。
   *
   * 这是 0x9082 的查询侧：本地 40062 列只有「每个表情被贴了几次」，没有**是谁**贴的，
   * 所以名单只能实时问服务端（需要在线已注入的 QQ）—— 离线时调用方要自己把错误
   * 呈现成「需要 QQ 在线」而不是空列表。
   *
   * 服务端回包里 `nick` / `headUrl` 常常是空的，这里用本地 `profile_info` 按 uin 补一次；
   * 都拿不到就把两个字段留成空串，渲染侧再退化成「QQ 号 + qlogo 头像」。
   */
  async getMessageReactionUsers(
    params: MessageReactionUsersParams,
  ): Promise<MessageReactionUsersPage> {
    const emojiId = params.emojiId;
    const page = await GetEmojiLikes.invoke(this.nt, this.resolvePid(), {
      groupId: Number(params.groupId),
      sequence: params.sequence,
      emojiId,
      // 与 SetReaction 同一套启发式：短 id 是 QQ 小黄脸，长的是 Unicode 码点。
      emojiType: params.emojiType ?? (emojiId.length > 3 ? 2 : 1),
      ...(params.count !== undefined ? { count: params.count } : {}),
      ...(params.cookie ? { cookie: params.cookie } : {}),
    });

    const users: MessageReactionUser[] = [];
    for (const user of page.users) {
      // 服务端两样都给全了就不用碰本地库。
      if (user.nick && user.headUrl) {
        users.push({ uin: String(user.uin), nick: user.nick, avatarUrl: user.headUrl });
        continue;
      }
      const local = await this.localProfile(user.uin);
      users.push({
        uin: String(user.uin),
        // 有备注先显示备注（和会话列表 / 成员列表的习惯一致）。
        nick: user.nick || local?.remark || local?.nick || '',
        avatarUrl: user.headUrl || local?.avatarUrl || '',
      });
    }

    return { users, cookie: page.cookie, isLast: page.isLast };
  }

  /** 本地 profile_info 里按 uin 找一个人；查不到 / 库不可用都返回 null。 */
  private async localProfile(
    uin: number,
  ): Promise<{ nick: string; remark: string; avatarUrl: string } | null> {
    if (!Number.isSafeInteger(uin) || uin <= 0) return null;
    try {
      const profile = await this.session.profileInfo.getProfileByUin(BigInt(uin));
      if (!profile) return null;
      return {
        nick: profile.nick ?? '',
        remark: profile.remark ?? '',
        avatarUrl: profile.avatarUrl ?? '',
      };
    } catch {
      // 资料库没读完 / 该 uin 没行：都当作「本地没有」，不影响名单本身。
      return null;
    }
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
