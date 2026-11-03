/** QQ 空间礼物商城查询与下单 HTTP 接口。 */

import {
  GIFT_MALL_ENDPOINTS,
  buildGiftMallHomePageExtraRequest,
  buildGiftMallHomePageGiftListRequest,
  buildGiftMallSearchRequest,
  buildGiftMallSingleGiftInfoRequest,
  buildGiftMallVipInfoRequest,
  buildGiftMallWallRequest,
  type GiftMallGiftListOptions,
  type GiftMallGiftListResponse,
  type GiftMallAIDiscStatusResponse,
  type GiftMallBuyItemRequest,
  type GiftMallBuyItemResponse,
  type GiftMallHomePageExtraResponse,
  type GiftMallSearchOptions,
  type GiftMallSearchResponse,
  type GiftMallSingleGiftInfoResponse,
  type GiftMallVipInfoResponse,
  type GiftMallWallOptions,
  type GiftMallWallResponse,
} from '@weq/protocol';
import { computeBkn, cookieHeader, WebAuthError, type WebCredential } from './credential';
import { WEB_READ_RETRY, WebRequestError, webRequestJson } from './http';

const HOST = 'https://club.vip.qq.com';
const AUTH_CODES = new Set([-3000, -10000]);
const REFERER = 'https://club.vip.qq.com/kuikly/vas_qqvip_gift_shop/2630';
const GIFT_MALL_UA =
  'Dalvik/2.1.0 (Linux; U; Android 13; 2109119BC Build/TKQ1.221114.001) V1_AND_SQ_9.3.75_16580_YYB_D QQ/9.3.75.42350 NetType/4G WebP/0.4.1 AppId/537397776 Pixel/1080 StatusBarHeight/95 SimpleUISwitch/0 QQTheme/1000 QQExt/0 StudyMode/0 CurrentMode/0 CurrentFontScale/1.0 GlobalDensityScale/0.9818182 AllowLandscape/false InMagicWin/0';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function responseError(response: unknown): Error | undefined {
  const data = record(response);
  if (!data || (typeof data.code !== 'number' && typeof data.code !== 'string')) return undefined;
  const code = Number(data.code);
  if (!Number.isFinite(code) || code === 0) return undefined;
  const message = typeof data.message === 'string' ? data.message : '礼物商城请求失败';
  return AUTH_CODES.has(code)
    ? new WebAuthError(`礼物商城登录态失效：${message}`, code)
    : new Error(`礼物商城请求失败（${code}）：${message}`);
}

async function postGiftMall<T>(cred: WebCredential, endpoint: string, body: unknown): Promise<T> {
  let response: unknown;
  try {
    response = await webRequestJson<unknown>(`${HOST}${endpoint}?g_tk=${computeBkn(cred.pskey)}`, {
      method: 'POST',
      cookie: cookieHeader(cred),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': GIFT_MALL_UA,
        Referer: REFERER,
      },
      body: JSON.stringify(body),
      retry: WEB_READ_RETRY,
    });
  } catch (error) {
    if (error instanceof WebRequestError && (error.status === 401 || error.status === 403)) {
      throw new WebAuthError('礼物商城登录态失效。', error.status);
    }
    throw error;
  }

  const error = responseError(response);
  if (error) throw error;
  return response as T;
}

function requireList(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`礼物商城响应缺少${label}列表。`);
}

/** 读取首页推荐、愿望单和服务端页签。 */
export async function fetchGiftMallHomePageExtraInfo(
  cred: WebCredential,
  toUin: number,
): Promise<GiftMallHomePageExtraResponse> {
  const response = await postGiftMall<GiftMallHomePageExtraResponse>(
    cred,
    GIFT_MALL_ENDPOINTS.homePageExtraInfo,
    buildGiftMallHomePageExtraRequest(toUin),
  );
  requireList(response.wishList, '愿望单');
  requireList(response.crowdRecomList, '推荐礼物');
  requireList(response.tabList, '页签');
  return response;
}

/** 读取首页礼物列表。空 `subTabName` 使用服务端默认的「最近上新」。 */
export async function fetchGiftMallGiftList(
  cred: WebCredential,
  toUin: number,
  options: GiftMallGiftListOptions = {},
): Promise<GiftMallGiftListResponse> {
  const response = await postGiftMall<GiftMallGiftListResponse>(
    cred,
    GIFT_MALL_ENDPOINTS.homePageGiftList,
    buildGiftMallHomePageGiftListRequest(toUin, options),
  );
  requireList(response.giftList, '礼物');
  if (typeof response.attachInfo !== 'string' || typeof response.isEnd !== 'boolean') {
    throw new Error('礼物商城分页响应缺少游标或结束标记。');
  }
  return response;
}

/** 搜索礼物；页号与游标原样交给服务端，不自行猜测分页规则。 */
export async function searchGiftMall(
  cred: WebCredential,
  options: GiftMallSearchOptions,
): Promise<GiftMallSearchResponse> {
  const response = await postGiftMall<GiftMallSearchResponse>(
    cred,
    GIFT_MALL_ENDPOINTS.searchGifts,
    buildGiftMallSearchRequest(options),
  );
  requireList(response.giftList, '搜索结果');
  if (typeof response.attachInfo !== 'string' || typeof response.isEnd !== 'boolean') {
    throw new Error('礼物搜索分页响应缺少游标或结束标记。');
  }
  return response;
}

/** 查询一个礼物针对收礼人的详情与资格状态。 */
export async function fetchGiftMallSingleGiftInfo(
  cred: WebCredential,
  giftId: string | number,
  toUin: number,
): Promise<GiftMallSingleGiftInfoResponse> {
  const response = await postGiftMall<GiftMallSingleGiftInfoResponse>(
    cred,
    GIFT_MALL_ENDPOINTS.singleGiftInfo,
    buildGiftMallSingleGiftInfoRequest(giftId, toUin),
  );
  if (!record(response.giftInfo)) throw new Error('礼物详情响应缺少礼物信息。');
  return response;
}

/** 查询当前账号对礼物商城的 VIP / SVIP 权益。 */
export async function fetchGiftMallVipInfo(
  cred: WebCredential,
  giftId: string | number,
): Promise<GiftMallVipInfoResponse> {
  const response = await postGiftMall<GiftMallVipInfoResponse>(
    cred,
    GIFT_MALL_ENDPOINTS.vipInfo,
    buildGiftMallVipInfoRequest(giftId),
  );
  if (!record(response.info)) throw new Error('礼物商城会员信息响应缺少权益信息。');
  return response;
}

/** 读取送出或收到的礼物墙；游标和时间字段由调用方按响应原样传回。 */
export async function fetchGiftMallWall(
  cred: WebCredential,
  options: GiftMallWallOptions,
): Promise<GiftMallWallResponse> {
  const response = await postGiftMall<GiftMallWallResponse>(
    cred,
    GIFT_MALL_ENDPOINTS.sendRecvWallList,
    buildGiftMallWallRequest(options),
  );
  requireList(response.giftsList, '礼物墙');
  if (
    typeof response.extInfo !== 'string' ||
    typeof response.isEnd !== 'boolean' ||
    typeof response.beginTime !== 'number'
  ) {
    throw new Error('礼物墙分页响应缺少游标或时间字段。');
  }
  return response;
}

/** 读取礼物商城关联的 AI 内容披露状态。 */
export async function fetchGiftMallAIDiscStatus(
  cred: WebCredential,
): Promise<GiftMallAIDiscStatusResponse> {
  const response = await postGiftMall<GiftMallAIDiscStatusResponse>(
    cred,
    GIFT_MALL_ENDPOINTS.aiDiscStatus,
    {},
  );
  requireList(response.statusList, 'AI 内容披露状态');
  return response;
}

/**
 * 提交一次礼物下单/赠送请求。付费返回只包含支付所需信息，不会在这里付款。
 * 写请求只发一次，避免网络超时后重放造成重复订单。
 */
export async function submitGiftMallBuyItem(
  cred: WebCredential,
  request: GiftMallBuyItemRequest,
  beforeSend: () => void,
): Promise<GiftMallBuyItemResponse> {
  beforeSend();
  let response: unknown;
  try {
    response = await webRequestJson<unknown>(
      `https://act.qzone.qq.com${GIFT_MALL_ENDPOINTS.buyItem}`,
      {
        method: 'POST',
        cookie: cookieHeader(cred),
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': GIFT_MALL_UA,
        },
        body: JSON.stringify(request),
      },
    );
  } catch (error) {
    if (error instanceof WebRequestError && (error.status === 401 || error.status === 403)) {
      throw new WebAuthError('礼物下单登录态失效；请求未自动重放。', error.status);
    }
    throw error;
  }

  const error = responseError(response);
  if (error) throw error;
  const data = record(response);
  if (!data || typeof data.code !== 'number' || !record(data.data)) {
    throw new Error('礼物下单响应格式异常。');
  }
  return response as GiftMallBuyItemResponse;
}
