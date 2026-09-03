/**
 * 个性装扮商城 —— 搜索与排行榜。
 *
 * 与 {@link ./self_dress}(查自己在用的装扮)同宿主同鉴权:`zb.vip.qq.com/trpc-proxy/qqva/`,
 * cookie(vip.qq.com 域)+ `g_tk = bkn(p_skey)`,请求/响应都是 JSON。差别只在两个端点和
 * 各自的 req 形状。
 *
 * ## 两个端点的响应形状不一样(坑)
 *
 * 排行榜把每条包了一层:`response.items[].item`,外面还挂个空的 `mRecomExtInfo`;
 * 搜索则是直接给对象:`response.results[]`。**item 本体的字段是完全一致的**,所以这里
 * 统一归一化成 {@link DressMallItem},调用方不必分两套。
 *
 * ## 为什么排行榜还有一份静态兜底
 *
 * 搜索必须联网(要 pskey),但排行榜的内容变化很慢,所以仓库里存了一份
 * `resources/dress/ranking-bubble.json`(就是这个端点的原始响应)。离线 / ninebird 账号
 * 也能浏览一个可用的气泡目录 —— 气泡渲染只要 itemId 就够(见 bubble_skin.ts),
 * 拿静态清单里的 id 一样能装。{@link normalizeMallItems} 对原始响应和静态文件通吃。
 *
 * 历史上还解过 `immersiveMaterial`(static-all 直链 / zoomPoint / 文字色)给气泡做
 * 零探测安装 —— 已随 CDN 直链路径整体移除,安装统一走 itemId 的 zip 下载链
 * (本地 bundle → protocol,见 dress_shared_cache)。字体类目的这个字段是空串(engine=2
 * 的老字体),原本也用不上。
 */

import { computeBkn, cookieHeader, type WebCredential } from './credential';

const HOST = 'https://zb.vip.qq.com/trpc-proxy/qqva';
const RANK_ENDPOINT = `${HOST}/qc_submall_server/qc_submall_server/GetItemLikeRank`;
const SEARCH_ENDPOINT = `${HOST}/qc_search_server/personalize_search/gxhCommSearchV2`;

/** 手 Q Android 的 UA。与 self_dress 同一个 —— 这些端点认 Dalvik UA。 */
const DRESS_UA =
  'Dalvik/2.1.0 (Linux; U; Android 13; 2109119BC Build/TKQ1.221114.001) V1_AND_SQ_9.3.25_15220_YYB_D QQ/9.3.25.38950 NetType/4G WebP/0.4.1 AppId/537375289';

/** 所有 trpc-proxy 端点共用的 options 包。 */
const TRPC_OPTIONS = {
  context: { businessType: 'qqgxh' },
  naming: { namespace: 'Production', env: 'formal' },
} as const;

/** 装扮类别。商城接口里排行叫 `appid`、搜索叫 `itemClass`,取值一致。 */
export const DressAppId = {
  Bubble: 2,
  /** 头像挂件。 */
  Widget: 4,
  Font: 5,
} as const;
export type DressAppId = (typeof DressAppId)[keyof typeof DressAppId];

/** 商城里的一款装扮(排行/搜索归一化后的形状)。 */
export interface DressMallItem {
  appId: number;
  itemId: number;
  name: string;
  /** 预览图(newPreview1)。渲染侧要经 `weq-media://dress` 代理,别直连。 */
  previewUrl: string;
  /** 更大的预览图(newPreview2),没有时为空串。 */
  previewLargeUrl: string;
  /** 分类标签,如「萌宠」「手写体」。 */
  labels: string[];
  /** 售价(Q点)。0 表示接口没给。 */
  price: number;
  /** 出品方名。 */
  mallName: string;
}

interface RawLabel {
  msg?: string;
}

interface RawItem {
  appId?: number;
  itemId?: number;
  name?: string;
  image?: string;
  labels?: RawLabel[];
  extraimage?: { images?: string[] };
  extrainfo?: { price?: number; mallname?: string };
}

/** 排行榜的条目外面包了一层;搜索没有。两种都喂给 normalize。 */
type RawEntry = RawItem | { item?: RawItem };

interface RawResponse {
  response?: { items?: RawEntry[]; results?: RawEntry[]; displayNum?: number };
  retCode?: number;
  error?: { code?: number; message?: string };
}

function normalizeItem(raw: RawItem): DressMallItem | null {
  const itemId = Number(raw.itemId ?? 0);
  if (!itemId) return null;
  return {
    appId: Number(raw.appId ?? 0),
    itemId,
    name: raw.name ?? '',
    previewUrl: raw.image ?? '',
    previewLargeUrl: raw.extraimage?.images?.[0] ?? '',
    labels: (raw.labels ?? []).map((l) => l.msg ?? '').filter(Boolean),
    price: Number(raw.extrainfo?.price ?? 0),
    mallName: raw.extrainfo?.mallname ?? '',
  };
}

/**
 * 把任意一种原始响应(排行 `items[].item` / 搜索 `results[]`)归一化成条目数组。
 *
 * 导出是为了让离线路径复用 —— 主进程读 `resources/dress/ranking-*.json`(存的就是原始
 * 响应)后直接喂给这个函数,与联网走同一条解析路径,不必维护两套。
 */
export function normalizeMallItems(payload: unknown): DressMallItem[] {
  // 静态资源可能缺失/损坏,`?.` 挡不住 null 本身 —— 先确认是个对象再往里摸。
  if (typeof payload !== 'object' || payload === null) return [];
  const data = payload as RawResponse;
  const entries = data.response?.items ?? data.response?.results ?? [];
  if (!Array.isArray(entries)) return [];
  const out: DressMallItem[] = [];
  for (const entry of entries) {
    // 排行榜包了一层 `item`,搜索没包。
    const raw = 'item' in entry && entry.item ? entry.item : (entry as RawItem);
    const item = normalizeItem(raw);
    if (item) out.push(item);
  }
  return out;
}

/** POST 一个 trpc-proxy 端点并校验业务状态位。 */
async function postTrpc(
  endpoint: string,
  cred: WebCredential,
  req: Record<string, unknown>,
): Promise<RawResponse> {
  const res = await fetch(`${endpoint}?g_tk=${computeBkn(cred.pskey)}`, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(cred),
      'Content-Type': 'application/json',
      'User-Agent': DRESS_UA,
      Referer: 'https://zb.vip.qq.com/kuikly/category/3760',
    },
    body: JSON.stringify({ req, options: TRPC_OPTIONS }),
  });
  if (!res.ok) throw new Error(`dress mall cgi ${res.status} ${res.statusText}`);

  const data = (await res.json()) as RawResponse;
  if (data.retCode !== 0) {
    throw new Error(`dress mall retCode=${data.retCode} ${data.error?.message ?? ''}`.trim());
  }
  return data;
}

/** 排行榜。`pageIndex` 从 1 起(照 HAR)。 */
export async function getDressRank(
  cred: WebCredential,
  opts: { appId: DressAppId; pageIndex?: number; pageSize?: number },
): Promise<DressMallItem[]> {
  const data = await postTrpc(RANK_ENDPOINT, cred, {
    rankType: 1,
    appid: opts.appId,
    pageIndex: opts.pageIndex ?? 1,
    pageSize: opts.pageSize ?? 20,
  });
  return normalizeMallItems(data);
}

/**
 * 搜索。`pageIndex` 从 0 起(与排行榜不同,照 HAR)。
 *
 * `stLogin.sSKey` 在 HAR 里是字面量 `"string"` —— 服务端不校验它(真正认人的是 cookie),
 * 照抄即可,别塞真 skey 进去。
 */
export async function searchDress(
  cred: WebCredential,
  opts: { appId: DressAppId; keyword: string; pageIndex?: number; pageSize?: number },
): Promise<{ items: DressMallItem[]; total: number }> {
  const data = await postTrpc(SEARCH_ENDPOINT, cred, {
    itemClass: opts.appId,
    searchKey: opts.keyword,
    writeHistoryFlag: 1,
    pageIndex: opts.pageIndex ?? 0,
    pageItemNUm: opts.pageSize ?? 40,
    platform: 2,
    stLogin: { iKeyType: 1, iOpplat: 2, sClientIp: '', sClientVer: '9.3.25', sSKey: 'string' },
  });
  return {
    items: normalizeMallItems(data),
    total: Number(data.response?.displayNum ?? 0),
  };
}
