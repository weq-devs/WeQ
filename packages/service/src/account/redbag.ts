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
import type { RedBagClaim, RedBagDetailResult, RedBagDetailSummary } from '@weq/protocol';
import { RedBagDetail, RED_BAG_PSKEY_DOMAIN } from '@weq/protocol';
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
  /** 领取方：私聊 = 对方 uin，群 = 群号。 */
  peerUin: string;
  /** 私聊传 `'c2c'`（wire 0），群传 `'group'`（wire 1）。 */
  peerType: 'c2c' | 'group';
}

/** 面向前端的领取明细。 */
export interface RedBagDetailView {
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
): RedBagDetailView {
  return {
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
    return viewFrom(result.summary, result.claims);
  }
}
