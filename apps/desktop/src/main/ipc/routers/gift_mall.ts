/**
 * `account.giftMall.*` —— 私聊礼物商城(首页推荐 / 分类列表 / 搜索 / 详情 / 礼物墙 / 赠送)。
 *
 * 全部走 `club.vip.qq.com` 的 trpc JSON 接口(见 `@weq/protocol` 的 `web/gift-mall`),
 * 需要在线 QQ 实例去取 `vip.qq.com` / `qzone.qq.com` 的 p_skey;完全离线模式一律报错,
 * 不做静态兜底 —— 商城内容每天都在变,存一份假目录只会误导人。
 *
 * 收礼人一律传 QQ 号,不传 uid:渲染层手上只有会话对方的 uid,所以这里统一用
 * `uidMap` 换成 uin(`/^\d+$/` 的输入当 uin 直接用)。
 *
 * 赠送只下**一单**,并且**不替用户付款**:响应里出现支付信息(payMode / token /
 * url_params / orderID 任一)就当成「需要支付」抛错,让用户回手机 QQ 送。WeQ 没有
 * 收银台,静默吞掉只会让人以为礼物已经送出去了。
 */

import { z } from 'zod';
import { GIFT_MALL_SUBTABS, GIFT_MALL_TABS } from '@weq/protocol';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { fullModeAllowed } from '../../context/full_mode';
import { procedure, router } from '../trpc';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

/** 商城走 Web CGI:有在线 QQ 实例(p_skey 可由本地快速登录兜底)即可,不要求注入。 */
function webQqOnline(services = requireServices()): boolean {
  const record = services.accountConfig.getRecord();
  if (!(record?.qqOnline && record.qqPid)) return false;
  return fullModeAllowed(getAppContext());
}

const OFFLINE_HINT = '礼物商城需要在线 QQ 实例 —— 请先登录该账号的 QQ 客户端，并退出完全离线模式。';

function requireWebOnline(services = requireServices()): void {
  if (!webQqOnline(services)) throw new Error(OFFLINE_HINT);
}

/**
 * 收礼人:渲染层给的是会话 id(uid)或 QQ 号。能直接当数字用的就是 uin,
 * 否则查 uid→uin 映射。解析不出直接报错 —— 拿 0 去请求只会换回一份别人的商城。
 */
function peerUin(peer: string): number {
  if (/^\d+$/.test(peer)) return Number(peer);
  const uin = getAppContext().account?.uidMap.uinByUid(peer);
  if (!uin) throw new Error('解析不出对方的 QQ 号，无法打开礼物商城。');
  return Number(uin);
}

const tabNameInput = z.enum([GIFT_MALL_TABS.All, GIFT_MALL_TABS.GiftCard, GIFT_MALL_TABS.Dress]);

const subTabInput = z.enum([
  GIFT_MALL_SUBTABS.Recent,
  GIFT_MALL_SUBTABS.Flowers,
  GIFT_MALL_SUBTABS.Figures,
  GIFT_MALL_SUBTABS.GiftCard,
  GIFT_MALL_SUBTABS.Cake,
  GIFT_MALL_SUBTABS.MusicMember,
  GIFT_MALL_SUBTABS.VideoMember,
  GIFT_MALL_SUBTABS.OtherMember,
  GIFT_MALL_SUBTABS.QqBenefits,
  GIFT_MALL_SUBTABS.Theme,
  GIFT_MALL_SUBTABS.Bubble,
  GIFT_MALL_SUBTABS.AvatarPendant,
]);

const peerInput = z.string().min(1).describe('私聊对方：uid 或 QQ 号');

export const giftMallRouter = router({
  /** 首页推荐、愿望单和服务端页签。 */
  extra: procedure.input(z.object({ peer: peerInput })).query(async ({ input }) => {
    const services = requireServices();
    requireWebOnline(services);
    return services.webQuery.getGiftMallHomePageExtraInfo(peerUin(input.peer));
  }),

  /** 分类礼物列表。`attachInfo` 来自上一页响应,原样回传。 */
  list: procedure
    .input(
      z.object({
        peer: peerInput,
        tabName: tabNameInput.default(GIFT_MALL_TABS.All),
        subTabName: z.array(subTabInput).default([]),
        attachInfo: z.string().default(''),
        crowdTab: z.string().default(''),
      }),
    )
    .query(async ({ input }) => {
      const services = requireServices();
      requireWebOnline(services);
      return services.webQuery.getGiftMallGiftList(peerUin(input.peer), {
        tabName: input.tabName,
        subTabName: input.subTabName,
        attachInfo: input.attachInfo,
        crowdTab: input.crowdTab,
      });
    }),

  /** 关键词搜索。页号从 1 起,与接口一致。 */
  search: procedure
    .input(
      z.object({
        peer: peerInput,
        keyword: z.string().min(1).max(40),
        pageNo: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(50).default(20),
        attachInfo: z.string().default(''),
      }),
    )
    .query(async ({ input }) => {
      const services = requireServices();
      requireWebOnline(services);
      return services.webQuery.searchGiftMall({
        keyword: input.keyword,
        toUin: peerUin(input.peer),
        pageNo: input.pageNo,
        pageSize: input.pageSize,
        attachInfo: input.attachInfo,
      });
    }),

  /** 单个礼物针对这位收礼人的详情(含折扣与领取资格)。 */
  detail: procedure
    .input(z.object({ peer: peerInput, giftId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const services = requireServices();
      requireWebOnline(services);
      return services.webQuery.getGiftMallSingleGiftInfo(input.giftId, peerUin(input.peer));
    }),

  /**
   * 送出 / 收到的礼物墙。`batchInfo` + `beginTime` 是服务端游标,翻页原样传回;
   * 首页请求的 `beginTime` 取当前秒级时间戳(HAR 里就是这个值)。
   */
  wall: procedure
    .input(
      z.object({
        isSend: z.boolean().default(false),
        batchInfo: z.string().default('0&20'),
        beginTime: z
          .number()
          .int()
          .positive()
          .default(() => Math.floor(Date.now() / 1000)),
      }),
    )
    .query(async ({ input }) => {
      const services = requireServices();
      requireWebOnline(services);
      return services.webQuery.getGiftMallWall(input);
    }),

  /**
   * 赠送一个礼物。**只下单一单,不付款**:
   * 需要支付(payMode / token / url_params / orderID 任一出现)时直接抛错。
   *
   * `giftPrice` 用列表价(itemSubId 里也是它),`svipDiscount` 用详情里的折后价
   * (gift_prize),与两份抓包一致。
   */
  send: procedure
    .input(
      z.object({
        peer: peerInput,
        giftId: z.number().int().positive(),
        giftPrice: z.number().int().nonnegative(),
        svipDiscount: z.number().int().nonnegative().optional(),
        message: z.string().max(60).default(''),
        anonymous: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const services = requireServices();
      requireWebOnline(services);
      const self = getAppContext().account;
      if (!self) throw new Error('没有打开的账号会话。');

      const toUin = peerUin(input.peer);
      const senderUin = Number(self.context.uin);
      const now = new Date();
      const pad = (value: number) => String(value).padStart(2, '0');
      const sendDate = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

      const response = await services.webQuery.sendGift(
        {
          aid: 'jhan_gift_mall',
          businessType: 1064,
          gift: {
            giftId: input.giftId,
            giftPrice: input.giftPrice,
            svipDiscount: input.svipDiscount ?? input.giftPrice,
          },
          senderUin,
          toUin,
          // 抓包里的 wish_desc 是 percent-encoded 的一句祝福,这里照同一个形状传。
          message: encodeURIComponent(input.message),
          sendDate,
          needAnonymous: input.anonymous,
          freeSendType: 0,
          mapExt: {
            ios_iap: '0',
            client_ver: '1',
            qua: 'V1_AND_SQ_9.3.75_16580_YYB_D',
            source: '',
            bag_id: '',
            custom_msg: '',
            byCount: 'svipDiscount',
          },
          timestampMs: now.getTime(),
        },
        () => {},
      );

      const data = response.data;
      const needsPayment =
        data.payMode !== 0 || Boolean(data.token || data.url_params || data.orderID);
      if (needsPayment) {
        throw new Error('这个礼物需要付款才能送出。WeQ 没有收银台，请到手机 QQ 的礼物商城里送它。');
      }
      return { ok: true as const };
    }),
});
