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
 * ## immersiveMaterial
 *
 * 每条 item 的 `extraappinfo.extraInfo.immersiveMaterial` 是个 **JSON 字符串**(不是对象),
 * 里面有九宫格切片直链、zoomPoint 和文字色。气泡渲染并不依赖它(那些 url 纯 itemId 可
 * 预测),但 `color` 是权威文字色、`animationAll` 的有无能省掉一次探测请求,所以解出来
 * 一并带上。字体的这个字段则常常是空串(engine=2 的老字体),别指望它。
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
  /** 该款是否有 APNG 动效层(从 immersiveMaterial 判,省一次探测)。 */
  animated: boolean;
  /** 权威文字色,形如 `0xFF11053b`。接口没给时为空串。 */
  color: string;
  /**
   * 气泡的权威九宫格参数。字体类目恒为 null;气泡也可能为 null(字段缺失/解析失败)。
   *
   * 有它就能零探测地渲染气泡(外链推不出来,见 {@link BubbleMaterial})。
   */
  material: BubbleMaterial | null;
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
  extraappinfo?: { extraInfo?: Record<string, string> };
}

/** 排行榜的条目外面包了一层;搜索没有。两种都喂给 normalize。 */
type RawEntry = RawItem | { item?: RawItem };

interface RawResponse {
  response?: { items?: RawEntry[]; results?: RawEntry[]; displayNum?: number };
  retCode?: number;
  error?: { code?: number; message?: string };
}

/**
 * `immersiveMaterial` 里气泡渲染真正需要的东西。
 *
 * **这是九宫格外链的唯一权威来源。** 曾经以为路径能按 `immersive/bubble/<itemId>/…`
 * 拼出来 —— 老款是这样,但新款的目录段变成了两段 hex:
 *
 *   老: immersive/bubble/2130704/static-all.png
 *   新: immersive/bubble/20ad45c9/797bfea60982f009/static-all.png
 *
 * 第一段是 `md5(itemId)[:8]`(可推),第二段 16 位 hex 实测在 64 位空间里均匀散布、
 * 与 itemId 无关,也不是 md5/sha1/sha256/crc32 对 itemId / 名称 / 各字段组合的任何切片
 * —— 应是服务端的内容摘要或版本 nonce,**推不出来**。静态排行 20 款里 12 款是新式路径,
 * 按 itemId 拼一律 404。所以气泡外链必须由本字段提供(商城路径),或走 protocol 换取
 * (只有 itemId 时,见 dress_shared_cache 的安装路径)。
 *
 * 顺带:`zoomPointX/Y` 就是九宫格拉伸点,拿到它就不必再下载左上角切片去量尺寸了。
 */
export interface BubbleMaterial {
  /** 静态底图直链。 */
  staticAll: string;
  /** 动效叠加层直链(APNG)。没有动效版本时为空串。 */
  animationAll: string;
  /** 九宫格拉伸点(源图像素)。 */
  zoomPointX: number;
  zoomPointY: number;
  /** 权威文字色,形如 `0xFF11053b`。没给时为空串。 */
  color: string;
}

function readMaterial(extraInfo: Record<string, string> | undefined): BubbleMaterial | null {
  const raw = extraInfo?.immersiveMaterial;
  if (!raw) return null;
  try {
    const mat = JSON.parse(raw) as Record<string, unknown>;
    const staticAll = typeof mat.staticAll === 'string' ? mat.staticAll : '';
    const zx = Number(mat.zoomPointX ?? 0);
    const zy = Number(mat.zoomPointY ?? 0);
    // 没有底图或没有拉伸点就没法渲染 —— 当作没有 material,交给上层兜底。
    if (!staticAll || !zx || !zy) return null;
    return {
      staticAll,
      animationAll: typeof mat.animationAll === 'string' ? mat.animationAll : '',
      zoomPointX: zx,
      zoomPointY: zy,
      color: typeof mat.color === 'string' ? mat.color : '',
    };
  } catch {
    // 字体的这个字段常常是别的形状(甚至空串),解不动就当没有。
    return null;
  }
}

function normalizeItem(raw: RawItem): DressMallItem | null {
  const itemId = Number(raw.itemId ?? 0);
  if (!itemId) return null;
  const material = readMaterial(raw.extraappinfo?.extraInfo);
  return {
    appId: Number(raw.appId ?? 0),
    itemId,
    name: raw.name ?? '',
    previewUrl: raw.image ?? '',
    previewLargeUrl: raw.extraimage?.images?.[0] ?? '',
    labels: (raw.labels ?? []).map((l) => l.msg ?? '').filter(Boolean),
    price: Number(raw.extrainfo?.price ?? 0),
    mallName: raw.extrainfo?.mallname ?? '',
    animated: Boolean(material?.animationAll),
    color: material?.color ?? '',
    material,
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
