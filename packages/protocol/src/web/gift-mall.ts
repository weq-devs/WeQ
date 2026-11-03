/**
 * QQ 礼物商城 HTTP 协议的请求与响应类型。
 *
 * 商城走 `club.vip.qq.com/mono/api/trpc/...` JSON 接口；下单则走
 * `act.qzone.qq.com/.../commonpay/BuyItem`，不属于 OIDB/SSO protobuf。
 */

export const GIFT_MALL_ENDPOINTS = {
  homePageExtraInfo: '/mono/api/trpc/qqva/gift_mall/gift_mall/GiftMall/GetHomePageExtraInfo',
  homePageGiftList: '/mono/api/trpc/qqva/gift_mall/gift_mall/GiftMall/GetHomePageGiftList',
  searchGifts: '/mono/api/trpc/qqva/gift_mall/gift_mall/GiftMall/SearchGifts',
  singleGiftInfo: '/mono/api/trpc/qqva/gift_mall/gift_mall/GiftMall/GetSingleGiftInfo',
  vipInfo: '/mono/api/trpc/qqva/gift_mall/gift_mall/GiftMall/GetVipInfo',
  sendRecvWallList: '/mono/api/trpc/qqva/gift_mall/gift_mall/GiftMall/GetSendRecvWallListV2',
  aiDiscStatus: '/mono/api/trpc/qqva/gift_mall/ugc/Ugc/GetAIDiscStatus',
  buyItem: '/v2/vip/tx/trpc/commonpay/BuyItem',
} as const;

/** 空字符串是「全部」顶层页签。 */
export const GIFT_MALL_TABS = {
  All: '',
  GiftCard: '礼品卡',
  Dress: '个性化装扮',
} as const;
export type GiftMallTab = (typeof GIFT_MALL_TABS)[keyof typeof GIFT_MALL_TABS];

/** 首页列表可选子页签；空数组保留服务端默认的「最近上新」。 */
export const GIFT_MALL_SUBTABS = {
  Recent: '最近上新',
  Flowers: '鲜花',
  Figures: '玩偶摆件',
  GiftCard: '礼品卡',
  Cake: '蛋糕',
  MusicMember: '音乐会员',
  VideoMember: '视频会员',
  OtherMember: '其他会员',
  QqBenefits: 'QQ权益',
  Theme: '主题',
  Bubble: '气泡',
  AvatarPendant: '头像挂件',
} as const;
export type GiftMallSubTab = (typeof GIFT_MALL_SUBTABS)[keyof typeof GIFT_MALL_SUBTABS];

export interface GiftMallGift {
  giftId: number;
  giftName: string;
  giftDesc?: string;
  giftPrice?: number;
  giftOriginalPrice?: number;
  giftType?: number;
  svipDiscount?: number;
  isWished?: boolean;
  isReceived?: boolean;
  canSendByPriviledge?: boolean;
  mapExt?: Record<string, unknown>;
  /** 详情页兜底图（抓包：`qzoneAIGift/item/<id>/详情页兜底图.png`）。 */
  staticPic?: string;
  /** 详情页大图。 */
  backgroundPic?: string;
  receivePic?: string;
  /** 商城列表用的方图（静态 / 动态），比 staticPic 更接近真机列表观感。 */
  squareStaticPic?: string;
  squareDynamicPic?: string;
  /** 礼物主题底色（`#rrggbb`），做预览卡背景用。 */
  backgroundColor?: string;
  /** 列表卡片上的短标语。 */
  homepageDesc?: string;
  /** 比 giftDesc 更长的一句描述。 */
  desc?: string;
  /** 分类标签（如 `['个性化装扮', '气泡']`）。 */
  vecTags?: string[];
  pagResourceUrl?: string;
  [field: string]: unknown;
}

export interface GiftMallHomePageExtraRequest {
  data: { to_uin: number };
}

export interface GiftMallHomePageExtraResponse {
  wishList: GiftMallGift[];
  crowdRecomList: GiftMallGift[];
  tabList: string[];
  crowdTab: string;
  decodeToUin?: number;
}

export interface GiftMallGiftListOptions {
  tabName?: GiftMallTab;
  subTabName?: readonly GiftMallSubTab[];
  attachInfo?: string;
  batchNum?: number;
  recommandType?: number;
  isNewMall?: boolean;
  crowdTab?: string;
}

export interface GiftMallHomePageGiftListRequest {
  data: {
    batch_num: number;
    tab_name: GiftMallTab;
    recommand_type: number;
    attach_info: string;
    sub_tab_name: GiftMallSubTab[];
    is_new_mall: boolean;
    crowd_tab: string;
    to_uin: number;
  };
}

export interface GiftMallGiftListResponse {
  giftList: GiftMallGift[];
  gameCenterAttachInfo?: unknown[];
  subTabs?: unknown[];
  giftExtInfo?: Record<string, unknown>;
  attachInfo: string;
  isEnd: boolean;
  ruleId?: string;
  decodeToUin?: number;
}

export interface GiftMallSearchOptions {
  keyword: string;
  toUin: number;
  pageNo: number;
  pageSize: number;
  attachInfo?: string;
}

export interface GiftMallSearchRequest {
  data: {
    key_word: string;
    attach_info: string;
    pagination: { page_no: number; page_size: number };
    to_uin: number;
  };
}

export interface GiftMallSearchResponse {
  giftList: GiftMallGift[];
  recomGifts?: GiftMallGift[];
  mapExt?: Record<string, unknown>;
  isEnd: boolean;
  attachInfo: string;
}

export interface GiftMallSingleGiftInfoRequest {
  data: { gift_id: string; to_uin: number };
}

export interface GiftMallSingleGiftInfoResponse {
  mapExt?: Record<string, unknown>;
  giftInfo: GiftMallGift;
}

export interface GiftMallVipInfoRequest {
  data: { gift_id: string };
}

export interface GiftMallVipInfo {
  isLv9Vip: boolean;
  lv9Cnt: number;
  isVip: boolean;
  vipCnt: number;
  yellowLvl: number;
  yellowLv10Cnt: number;
  svipLvl: number;
  svipCnt: number;
  freeCardCnt: number;
  svipDiscountTimes: number;
}

export interface GiftMallVipInfoResponse {
  info: GiftMallVipInfo;
  descImg?: string;
  descImgDark?: string;
}

export interface GiftMallWallOptions {
  /** true=送出的礼物，false=收到的礼物。 */
  isSend: boolean;
  /** 抓包中服务端返回的 beginTime；翻页时原样传回。 */
  beginTime: number;
  /** 服务端游标；翻页时原样传回。 */
  batchInfo: string;
}

export interface GiftMallWallRequest {
  data: { batch_info: string; is_send: boolean; begin_time: number };
}

export interface GiftMallWallItem {
  giftExt: Record<string, unknown>;
  giftId: number;
  giftName: string;
  staticPic: string;
  giftPrice: number;
  giftType: number;
  orderNum: string;
  time: string;
  nick: string;
  /** 抓包里是字符串（"0" / "2"），不是数字 —— 别按 int 解。 */
  displayType: number | string;
  material: string;
  source: number;
}

export interface GiftMallWallResponse {
  giftsList: GiftMallWallItem[];
  isEnd: boolean;
  extInfo: string;
  beginTime: number;
}

export interface GiftMallAIDiscStatusResponse {
  statusList: unknown[];
}

export interface GiftMallBuyItemOptions {
  aid: string;
  businessType: number;
  gift: Pick<GiftMallGift, 'giftId' | 'giftPrice' | 'svipDiscount'>;
  senderUin: number;
  toUin: number;
  message: string;
  sendDate: string;
  needAnonymous: boolean;
  freeSendType: number;
  /** 抓包字段整体透传；`byCount` 等值由客户端状态决定。 */
  mapExt: Record<string, string>;
  timestampMs: number;
  mapSendDate?: Record<string, string>;
  exactTime?: string;
  boxId?: string | null;
  boxPrice?: string;
  muin?: string;
  source?: string;
  buyNum?: number;
  reportExtraInfo?: string;
}

export interface GiftMallBuyItemRequest {
  aid: string;
  business_type: number;
  format: 'json';
  itemList: {
    businessType: number;
    buyNum: number;
    itemExtendInfo: string;
    itemId: string;
    itemSubId: string;
  }[];
  item_id: string;
  report_extra_info: string;
}

export interface GiftMallBuyItemResponse {
  code: number;
  data: {
    payMode: number;
    reportData: string;
    mode?: number;
    dc?: string;
    url_params?: string;
    token?: string;
    appid?: number;
    product_id?: string;
    pay_item?: string;
    zoneId?: number;
    orderID?: string;
  };
}

export function buildGiftMallHomePageExtraRequest(toUin: number): GiftMallHomePageExtraRequest {
  return { data: { to_uin: toUin } };
}

export function buildGiftMallHomePageGiftListRequest(
  toUin: number,
  options: GiftMallGiftListOptions = {},
): GiftMallHomePageGiftListRequest {
  const tabName = options.tabName ?? GIFT_MALL_TABS.All;
  const subTabName = [...(options.subTabName ?? [])];
  const allowedSubTabs: readonly GiftMallSubTab[] =
    tabName === GIFT_MALL_TABS.GiftCard
      ? [
          GIFT_MALL_SUBTABS.MusicMember,
          GIFT_MALL_SUBTABS.VideoMember,
          GIFT_MALL_SUBTABS.OtherMember,
          GIFT_MALL_SUBTABS.QqBenefits,
        ]
      : tabName === GIFT_MALL_TABS.Dress
        ? [GIFT_MALL_SUBTABS.Theme, GIFT_MALL_SUBTABS.Bubble, GIFT_MALL_SUBTABS.AvatarPendant]
        : [
            GIFT_MALL_SUBTABS.Recent,
            GIFT_MALL_SUBTABS.Flowers,
            GIFT_MALL_SUBTABS.Figures,
            GIFT_MALL_SUBTABS.GiftCard,
            GIFT_MALL_SUBTABS.Cake,
          ];
  if (subTabName.some((name) => !allowedSubTabs.includes(name))) {
    throw new Error(`礼物商城子页签不属于当前页签：${tabName || '全部'}`);
  }

  return {
    data: {
      batch_num: options.batchNum ?? 20,
      tab_name: tabName,
      recommand_type: options.recommandType ?? 0,
      attach_info: options.attachInfo ?? '',
      sub_tab_name: subTabName,
      is_new_mall: options.isNewMall ?? true,
      crowd_tab: options.crowdTab ?? '',
      to_uin: toUin,
    },
  };
}

export function buildGiftMallSearchRequest(options: GiftMallSearchOptions): GiftMallSearchRequest {
  return {
    data: {
      key_word: options.keyword,
      attach_info: options.attachInfo ?? '',
      pagination: { page_no: options.pageNo, page_size: options.pageSize },
      to_uin: options.toUin,
    },
  };
}

export function buildGiftMallSingleGiftInfoRequest(
  giftId: string | number,
  toUin: number,
): GiftMallSingleGiftInfoRequest {
  return { data: { gift_id: String(giftId), to_uin: toUin } };
}

export function buildGiftMallVipInfoRequest(giftId: string | number): GiftMallVipInfoRequest {
  return { data: { gift_id: String(giftId) } };
}

export function buildGiftMallWallRequest(options: GiftMallWallOptions): GiftMallWallRequest {
  return {
    data: {
      batch_info: options.batchInfo,
      is_send: options.isSend,
      begin_time: options.beginTime,
    },
  };
}

/**
 * 按两份购买抓包拼出客户端的 `itemSubId`。
 * `itemId`/`item_id` 都是 giftId；itemSubId 中 giftPrice、aio、uin 和 anonymous
 * 分别来自列表价格、freeSendType、发送/接收账号和匿名开关。
 */
export function buildGiftMallItemSubId(options: GiftMallBuyItemOptions): string {
  const giftId = String(options.gift.giftId);
  const giftPrice = options.gift.giftPrice;
  if (giftPrice === undefined) throw new Error('礼物缺少 giftPrice，无法生成 itemSubId。');
  return [
    `aio:${options.freeSendType}`,
    `giftId:${giftId}`,
    `giftPrice:${giftPrice}`,
    `boxId:${options.boxId ?? ''}`,
    `undefined_boxPrice:${options.boxPrice ?? ''}`,
    `undefined_muin:${options.muin ?? ''}`,
    `uin:${options.senderUin}`,
    `uin:${options.toUin}`,
    `anonymous:${Number(options.needAnonymous)}`,
    `source:${options.source ?? 'undefined'}`,
  ].join('_');
}

/** 组装 `commonpay/BuyItem` 的 JSON 请求体；不代表付款已经完成。 */
export function buildGiftMallBuyItemRequest(
  options: GiftMallBuyItemOptions,
): GiftMallBuyItemRequest {
  const giftId = String(options.gift.giftId);
  if (options.gift.svipDiscount === undefined) {
    throw new Error('礼物缺少 svipDiscount，无法生成 gift_prize。');
  }
  const mapSendDate = options.mapSendDate ?? { [String(options.toUin)]: options.sendDate };
  const itemExtendInfo = {
    gift_id: Number(giftId),
    gift_prize: options.gift.svipDiscount,
    box_id: options.boxId ?? null,
    wish_desc: options.message,
    send_date: options.sendDate,
    map_send_date: mapSendDate,
    exact_time: options.exactTime ?? '',
    sender_uin: options.senderUin,
    receive_uin: options.toUin,
    need_anonymous: options.needAnonymous,
    free_send_type: options.freeSendType,
    map_ext: options.mapExt,
    timestamp: options.timestampMs,
  };
  return {
    aid: options.aid,
    business_type: options.businessType,
    format: 'json',
    itemList: [
      {
        businessType: options.businessType,
        buyNum: options.buyNum ?? 1,
        itemExtendInfo: JSON.stringify(itemExtendInfo),
        itemId: giftId,
        itemSubId: buildGiftMallItemSubId(options),
      },
    ],
    item_id: giftId,
    report_extra_info: options.reportExtraInfo ?? '',
  };
}
