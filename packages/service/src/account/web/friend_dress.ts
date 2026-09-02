/**
 * 好友装扮查询 — `zb.vip.qq.com/v2/pages/aioDressPage`.
 *
 * 不同于其它 web cgi:这个端点返回的是 SSR 出来的 HTML(QQ 会员「好友装扮」页),
 * 对方正在用的装扮塞在 `<script>window.__INITIAL_ASYNCDATA__ = {...}</script>` 的
 * `rawUsingList` 里。我们只发 GET、抠这段 JSON,不跑页面 JS。
 *
 * Auth: cookie 四字段(uin/skey/p_uin/p_skey)即可,pt4_token 之类风控 cookie 非必需。
 * p_skey 走 `vip.qq.com` 域。
 *
 * 已知服务器侧的坑(只按 targetUin 查、不带装扮 id 时):
 *  - 气泡(appId 2)/字体(appId 5)/头像(appId 23) 永远回「默认款」,是废数据 ——
 *    这几类要客户端在 URL 里带 bubbleId/fontId 才能解析出对方真实所用,故一律剔除。
 *  - 其余类别(挂件/名片/来电/彩色屏保/头像双击动作/输入状态…)回的是真值。
 */

import { cookieHeader, type WebCredential } from './credential';
import { dressKind } from './dress_kind';
import { webRequestText } from './http';

/** 一个「好友装扮」项 —— 只留核心内容,不含页面按钮/场景等 UI 态。 */
export interface FriendDressItem {
  /** 装扮业务 id(QQ 会员的 appId,决定类别)。 */
  appId: number;
  /** 人类可读类别(按 appId 映射,未知则为 `appId=<n>`)。 */
  kind: string;
  /** 装扮 id(默认款为 0)。 */
  itemId: number;
  /** 装扮名。 */
  name: string;
  /** 静态预览图 url。 */
  previewUrl: string;
  /** 动态预览视频 url(名片/来电才有)。 */
  videoUrl?: string;
  /** 商城价(非默认款才有)。 */
  price?: number;
}

export interface FriendDress {
  /** 被查询的账号。 */
  targetUin: string;
  /** 对方是否 SVIP。 */
  isSvip: boolean;
  /** 对方头像图 url(装扮页附带,非"头像装扮")。 */
  avatarUrl: string;
  /** 对方正在用的装扮(已剔除服务器不回真值的气泡/字体/头像)。 */
  items: FriendDressItem[];
}

/**
 * 服务器不会回真值的装扮类型:气泡(2)/字体(5)/头像(23)。这几类只按 targetUin 查
 * 永远回默认款,必须客户端在请求里带对应 id 才知道对方用了啥 —— 拿到也是废数据,剔除。
 * (查**自己**的这三类是可行的,走 {@link ./self_dress}。)
 */
const UNRESOLVABLE_APPS = new Set([2, 5, 23]);

/**
 * HAR 里的 traceDetail:base64({"appid":"toaio","page_id":"37","item_id":"","item_type":""})。
 * 与 targetUin 无关,固定值。
 */
const TRACE_DETAIL =
  'base64-eyJhcHBpZCI6InRvYWlvIiwicGFnZV9pZCI6IjM3IiwiaXRlbV9pZCI6IiIsIml0ZW1fdHlwZSI6%0AIiJ9%0A';

/** aio webview 的移动端 UA(照 HAR;桌面 UA 可能返回不同壳)。 */
const DRESS_UA =
  'Mozilla/5.0 (Linux; Android 13; 2109119BC Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/121.0.6167.71 MQQBrowser/6.2 TBS/047925 Mobile Safari/537.36 V1_AND_SQ_9.2.66_13188_YYB_D QQ/9.2.66.33870 NetType/WIFI WebP/0.3.0 AppId/537339358';

interface RawDressItem {
  appId?: number;
  itemId?: number;
  name?: string;
  image?: string;
  extrainfo?: { price?: number };
  extraappinfo?: { extraInfo?: { immersiveMaterial?: string } };
}

interface RawAsyncData {
  targetUin?: string;
  isSvip?: boolean;
  avatarImage?: string;
  rawUsingList?: RawDressItem[];
}

/** 按 targetUin 拼装扮页 URL(结构照 HAR)。 */
function buildDressUrl(targetUin: string): string {
  const inner =
    `https://zb.vip.qq.com/v2/pages/aioDressPage?fromPage=1&targetUin=${targetUin}` +
    `&widgetId=0&fontEffectId=0&bgId=custom&chatId=${targetUin}` +
    `&isGroup=0&traceDetail=${TRACE_DETAIL}`;
  const params = new URLSearchParams({
    fromPage: '1',
    enteranceId: 'aio',
    url: inner,
    fontEffectId: '0',
    chatId: targetUin,
    widgetId: '0',
    targetUin,
    isGroup: '0',
    bgId: 'custom',
  });
  // traceDetail 已是编码后的 base64-... 串,单独拼避免被二次编码。
  return `https://zb.vip.qq.com/v2/pages/aioDressPage?${params.toString()}&traceDetail=${TRACE_DETAIL}`;
}

/** 从 SSR HTML 抠出 window.__INITIAL_ASYNCDATA__ 的 JSON(拿不到返回 null)。 */
function parseAsyncData(html: string): RawAsyncData | null {
  const m = html.match(/window\.__INITIAL_ASYNCDATA__\s*=\s*(\{[\s\S]*?\});\(function/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as RawAsyncData;
  } catch {
    return null;
  }
}

/**
 * 抠出该装扮项的动态预览视频 url(没有则 undefined)。
 *  - 名片(appId 15):video 藏在 extraInfo.immersiveMaterial(JSON 字符串)的 videoUrl。
 *  - 来电(appId 17):无独立字段,按预览图同目录换名 image.jpg → media.mp4
 *    (funCall/item/{itemId}/media.mp4,已验证可访问)。
 */
function resolveVideoUrl(r: RawDressItem): string | undefined {
  if (r.appId === 15) {
    const raw = r.extraappinfo?.extraInfo?.immersiveMaterial;
    if (!raw) return undefined;
    try {
      return (JSON.parse(raw) as { videoUrl?: string }).videoUrl || undefined;
    } catch {
      return undefined;
    }
  }
  // 只有确实以 /image.jpg 结尾才推得出 media.mp4。别用 replace 兜底 —— 匹配不上时
  // 它原样返回,图片地址就被当成视频 url 发出去了。
  if (r.appId === 17 && r.image && /\/image\.jpg$/.test(r.image)) {
    return r.image.replace(/\/image\.jpg$/, '/media.mp4');
  }
  return undefined;
}

function toItem(r: RawDressItem): FriendDressItem {
  const appId = r.appId ?? 0;
  const item: FriendDressItem = {
    appId,
    kind: dressKind(appId),
    itemId: r.itemId ?? 0,
    name: r.name ?? '',
    previewUrl: r.image ?? '',
  };
  const videoUrl = resolveVideoUrl(r);
  if (videoUrl) item.videoUrl = videoUrl;
  if (r.extrainfo?.price) item.price = r.extrainfo.price;
  return item;
}

/**
 * 查 `targetUin` 正在用的好友装扮。抠不到 __INITIAL_ASYNCDATA__(未登录态/风控/页面
 * 改版)时返回 `null`,让调用方区分「查到但空」与「压根没解析出来」。
 */
export async function getFriendDress(
  cred: WebCredential,
  targetUin: string,
): Promise<FriendDress | null> {
  const html = await webRequestText(buildDressUrl(targetUin), {
    method: 'GET',
    cookie: cookieHeader(cred),
    headers: {
      'User-Agent': DRESS_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });
  //
  // console.log(html);

  const data = parseAsyncData(html);
  if (!data?.rawUsingList) return null;

  return {
    targetUin: data.targetUin ?? targetUin,
    isSvip: data.isSvip ?? false,
    avatarUrl: data.avatarImage ?? '',
    items: data.rawUsingList.filter((r) => !UNRESOLVABLE_APPS.has(r.appId ?? 0)).map(toItem),
  };
}
