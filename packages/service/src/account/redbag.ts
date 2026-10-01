/**
 * RedBagService — 查红包领取明细（`hb_pc_detail`）。
 *
 * 与发红包（`hb_pc_pre_pack`）不同，查详情只要**登录态还在**就能反复调用，所以
 * 这里把 `tenpay.com` 的 p_skey 按域缓存起来（照 `CollectionService` 用
 * `WebCredentialProvider` 的做法）。
 *
 * 为什么不缓存 / 定时过期：p_skey 的真实服务端 TTL 没有可信依据，猜早浪费一次
 * OIDB 往返、猜晚留过期窗口。凭证提供方只负责「拿一次、留着用」，失效交给服务端
 * 自己报 —— 调用方收到业务错误时 `invalidate('tenpay.com')` 再取一次即可。
 *
 * 注意：`tenpay.com` **不在** `PT_LOGIN_DOMAINS` 里（ptlogin2 本地快速登录没有这个
 * 域的抓包配置），所以缓存未命中时只有 OIDB `0x102A_0` 一条路 —— 也正因为如此，
 * 缓存命中能省下的就是每一次 OIDB 往返。
 *
 * 另外这条链路天生要求「在线且已注入的 QQ」：红包包走的是 hook 上的 `sendPacket`，
 * 光有 p_skey 也发不出去。
 */

import type { NtHelperBinding } from '@weq/native';
import type {
  RedBagClaim,
  RedBagDetailResult,
  RedBagDetailSummary,
  RedBagGrabResult,
} from '@weq/protocol';
import { RedBagDetail, RedBagGrab, RED_BAG_PSKEY_DOMAIN } from '@weq/protocol';
import type { AccountSession } from '@weq/account';
import { getLogger, logErrorContext } from '../common/logger';
import { WebCredentialProvider } from './web/credential';
import type { WebNative } from './web/credential';

/** 查详情所需的 native 面：OIDB 取 p_skey + SSO 发包 + 红包签名。 */
export type RedBagNative = WebNative & Pick<NtHelperBinding, 'sendPacket' | 'signRedBagRequest'>;

/** 一次查询的输入 —— 全部来自消息里的 wallet 元素。 */
export interface RedBagDetailQuery {
  /** 红包订单号 / nonce（32 位 hex），消息 tag 48451。 */
  orderId: string;
  /** 32 字节 packetId（消息 tag 48417.f2），hex 字符串。 */
  packetId: string;
  /**
   * 第二串 32 位 hex id（消息 tag 48418）。只有抢红包（grab）用得到，
   * 查详情（detail）不需要，所以是可选的。
   */
  token?: string;
  /** 领取方：私聊 = 对方 uin，群 = 群号。 */
  peerUin: string;
  /** 私聊传 `'c2c'`（wire 0），群传 `'group'`（wire 1）。 */
  peerType: 'c2c' | 'group';
}

/** 面向前端的领取明细。 */
export interface RedBagDetailView {
  /** 当前登录账号的 QQ 号 —— 前端用来高亮「我」那一条。 */
  selfUin: string;
  /** 自己在这个红包里的领取记录；没领过就是 null。 */
  selfClaim: RedBagClaim | null;
  /** 红包总个数。 */
  totalNum: number;
  /** 总金额，单位**分**。 */
  totalAmount: number;
  /** 已领取人数。 */
  claimedCount: number;
  /** 祝福语 / 口令。 */
  wishing: string;
  /** 发红包者 QQ 号。 */
  senderUin: string;
  /** 发红包者昵称（服务端回的那一份，可能带前缀）。 */
  senderNickname: string;
  /** 是否拼手气（split = 2）。 */
  lucky: boolean;
  /** 领取记录，按服务端返回顺序。 */
  claims: RedBagClaim[];
  /** 过期时间（unix 秒），0 表示未知。 */
  expireTime: number;
}

/** 明细里的概况有可能是精简版（grab 响应没有总个数 / 总额）。 */
function viewFrom(
  summary: RedBagDetailSummary | undefined,
  claims: RedBagClaim[],
  selfUin: string,
): RedBagDetailView {
  return {
    selfUin,
    selfClaim: claims.find((c) => c.uin === selfUin) ?? null,
    totalNum: summary?.totalNum ?? 0,
    totalAmount: summary?.totalAmount ?? 0,
    claimedCount: summary?.claimedCount ?? claims.length,
    wishing: summary?.wishing ?? '',
    senderUin: summary?.senderUin ?? '',
    senderNickname: summary?.senderNickname ?? '',
    lucky: summary?.split === 2,
    claims,
    expireTime: summary?.expireTime ?? 0,
  };
}

/** 抢红包（`hb_pc_grab`）的结果：自己抢到的那一份 + 概况。 */
export interface RedBagGrabView {
  /** 自己抢到的金额，单位**分**。 */
  amount: number;
  /** 领取时间（unix 秒）。 */
  claimTime: number;
  /** 抢到者的 QQ 号（服务端回的就是自己）。 */
  uin: string;
  /** 抢到者的昵称。 */
  nickname: string;
  /** 发红包者 QQ 号。 */
  senderUin: string;
  /** 发红包者昵称。 */
  senderNickname: string;
  /** 祝福语 / 口令。 */
  wishing: string;
  /** 是否拼手气。 */
  lucky: boolean;
  /** 已领取人数。 */
  claimedCount: number;
}

function grabViewFrom(result: RedBagGrabResult): RedBagGrabView {
  const claim = result.claim;
  if (!claim) {
    throw new Error('红包 grab 成功但回包里没有自己那一份领取记录。');
  }
  return {
    amount: claim.amount,
    claimTime: claim.claimTime,
    uin: claim.uin,
    nickname: claim.nickname,
    senderUin: result.summary?.senderUin ?? '',
    senderNickname: result.summary?.senderNickname ?? '',
    wishing: result.summary?.wishing ?? '',
    lucky: result.summary?.split === 2,
    // grab 响应的概况是精简版，**不带**已领人数（tag 16 缺失）—— 拿不到就是 0，
    // 前端在 0 时隐藏「已领取 x/y」那一行，不瞎编。
    claimedCount: result.summary?.claimedCount ?? 0,
  };
}

export class RedBagService {
  private readonly creds: WebCredentialProvider;
  private readonly logger;

  constructor(
    private readonly nt: RedBagNative,
    private readonly session: AccountSession,
    resolvePid: () => number,
  ) {
    this.creds = new WebCredentialProvider(nt, session.context.uin, resolvePid);
    this.logger = getLogger().child({ scope: 'redbag', accountUin: session.context.uin });
  }

  /**
   * 取 `tenpay.com` 的 p_skey（域级缓存；缓存命中就不打 OIDB）。
   *
   * 第一次现取，之后一直复用；服务端说票据不对时调 {@link invalidate} 清掉再来。
   */
  async pskey(): Promise<string> {
    const cred = await this.creds.forDomain(RED_BAG_PSKEY_DOMAIN);
    if (!cred.pskey) {
      throw new Error('拿不到 tenpay.com 的 p_skey：需要在线且已注入的 QQ。');
    }
    return cred.pskey;
  }

  /** 丢弃缓存的 p_skey，下次重新取。 */
  invalidate(): void {
    this.creds.invalidate(RED_BAG_PSKEY_DOMAIN);
  }

  /**
   * 查一个红包的领取明细（`hb_pc_detail`）。
   *
   * 签名与加密算法与发红包完全一致（见 `@weq/protocol` 的 `RedBagDetail`）。
   * 票据失效时换票重试**一次** —— 与 `withRetry` 的取舍一致：新票也被拒说明不是
   * 过期问题，重试也白搭。
   */
  async detail(query: RedBagDetailQuery, pid: number): Promise<RedBagDetailView> {
    const run = async (): Promise<RedBagDetailResult> => {
      const pskey = await this.pskey();
      return RedBagDetail.invoke(this.nt, pid, {
        uin: this.session.context.uin,
        pskey,
        orderId: query.orderId,
        packetId: query.packetId,
        peerUin: query.peerUin,
        scene: query.peerType === 'group' ? 1 : 0,
      });
    };

    let result: RedBagDetailResult;
    try {
      result = await run();
    } catch (error) {
      this.logger.warn('red bag detail failed; retrying with a fresh p_skey', {
        event: 'redbag-detail-retry',
        orderId: query.orderId,
        ...logErrorContext(error),
      });
      this.invalidate();
      result = await run();
    }

    if (result.bizCode !== 0) {
      throw new Error(
        `红包详情查询失败：code=${result.bizCode} message=${result.bizMessage || '(空)'}`,
      );
    }
    return viewFrom(result.summary, result.claims, this.session.context.uin);
  }

  /**
   * 抢一个红包（`hb_pc_grab`）—— **这一步真的会扣钱**（服务端记一笔自己的领取）。
   *
   * 与 {@link detail} 共用 sender / p_skey / 签名，只是 pack 换成 grab 的定位参数，
   * 并且多要两样东西：
   *   - `token`（消息 tag 48418）：服务端认这个第二串 id；
   *   - 自己当时的昵称（抓包写的就是自己），取不到就留空让服务端自己决定。
   *
   * 返回的就是自己抢到的那一份金额 / 时间，不再是整张领取列表。
   */
  async grab(query: RedBagDetailQuery, pid: number): Promise<RedBagGrabView> {
    if (!query.token) throw new Error('这个红包缺少领取 token（消息 tag 48418）。');

    const selfUin = this.session.context.uin;
    let nickname = '';
    try {
      const profile = await this.session.profileInfo.getProfileByUin(BigInt(selfUin));
      nickname = profile?.nick ?? '';
    } catch {
      /* 本地 profile_info 查不到就留空 —— 不影响抢红包。 */
    }

    const run = async (): Promise<RedBagGrabResult> => {
      const pskey = await this.pskey();
      return RedBagGrab.invoke(this.nt, pid, {
        uin: selfUin,
        pskey,
        orderId: query.orderId,
        packetId: query.packetId,
        token: query.token,
        nickname,
        peerUin: query.peerUin,
        scene: query.peerType === 'group' ? 1 : 0,
      });
    };

    let result: RedBagGrabResult;
    try {
      result = await run();
    } catch (error) {
      this.logger.warn('red bag grab failed; retrying with a fresh p_skey', {
        event: 'redbag-grab-retry',
        orderId: query.orderId,
        ...logErrorContext(error),
      });
      this.invalidate();
      result = await run();
    }

    if (result.bizCode !== 0) {
      throw new Error(
        `红包领取失败：code=${result.bizCode} message=${result.bizMessage || '(空)'}`,
      );
    }
    return grabViewFrom(result);
  }
}
