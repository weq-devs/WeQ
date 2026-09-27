/**
 * LbsService —— 腾讯位置服务（WebService API）的**只读**封装：关键词输入提示 +
 * 逆地址解析。用途只有一个：给「位置卡片」面板提供搜索与「点选反查地址」。
 *
 * 为什么是腾讯而不是高德：高德的**服务类能力**（POI 搜索 / 逆地理）需要额外的
 * 「安全密钥」，没有它一律 `INVALID_USER_SCODE`（本项目实测过）；腾讯这边一把
 * WebService key 就能用，而且数据与 QQ 自带的位置分享是同一套（都是 GCJ-02），
 * 发出去的位置卡片点开不会偏移。
 *
 * 边界（都是有意为之）：
 *   - 只走 WebService（HTTP JSON）。**不用**腾讯的 WMTS 栅格瓦片（那是高级付费
 *     服务，这个 key 返回 `113 此功能未被授权`），底图由渲染层自己画；
 *   - **不引任何 JS SDK**（渲染层 CSP 是 `script-src 'self'`）；
 *   - 请求全部在主进程发 —— 渲染层 `connect-src 'self'`，直连 `apis.map.qq.com`
 *     要放开连接边界；放这里既不碰 CSP，key 也不落进前端代码。
 *
 * 本服务**不需要 QQ 在线、也不需要 cookie**：纯公网只读查询。
 */

/** 默认 key：仓库内置的那把（可用环境变量覆盖，见 {@link lbsKey}）。 */
const DEFAULT_LBS_KEY = '73dfcdeff8636c1d3501fa9a2860ebb7';

const LBS_HOST = 'https://apis.map.qq.com';

/** 单次请求超时（毫秒）。地址解析是交互里的阻塞步骤，不能挂太久。 */
const LBS_TIMEOUT_MS = 8000;

/**
 * 取本次调用用的 key。
 *
 * 允许环境变量覆盖：key 无 IP / 域名限制（实测伪造 `Origin: file://` 也照样放行），
 * 随客户端发出去就等于公开，所以留一个不重新打包就能换 key 的口子。
 */
export function lbsKey(): string {
  // 服务包也可能被非 Node 环境（网页端打包）引用，调用前先确认 process 在。
  const fromEnv =
    typeof process !== 'undefined' ? process.env?.WEQ_TENCENT_LBS_KEY?.trim() : undefined;
  return fromEnv || DEFAULT_LBS_KEY;
}

/** 一条地点建议（搜索 / 输入提示的结果，已归一化成面板要的形状）。 */
export interface LbsPlace {
  /** 腾讯的 POI id。 */
  id: string;
  /** 地点名称（卡片标题那一行）。 */
  title: string;
  /** 详细地址（**已去掉**省市区前缀，直接进位置卡片的 `address`）。 */
  address: string;
  /** 省市区（直接进位置卡片的 `region`）。 */
  region: string;
  latitude: number;
  longitude: number;
}

/** 逆地址解析结果（点选坐标 → 可填进卡片的文字）。 */
export interface LbsResolvedAddress {
  /** 地点名称建议（地标 / 人性化地址）；解析不出时为空串。 */
  title: string;
  /** 详细地址（街道 + 门牌）；解析不出时回落到去前缀的完整地址。 */
  address: string;
  /** 省市区。 */
  region: string;
}

/** 文生义的常见 status 释义；服务端返回的 `message` 才是权威，这里只做补充。 */
const STATUS_HINTS: Record<number, string> = {
  110: '请求来源未被授权',
  111: '签名校验失败（该 key 开了 SN 校验，需要 SK 计算 sig）',
  112: 'IP 未被授权',
  113: '此功能未被授权（该 key 没开通这个接口）',
  120: '该 key 每日调用量已达到上限',
  121: '该 key 每秒调用量已达到上限',
  122: '该 key 未开启 WebServiceAPI 功能',
};

interface LbsEnvelope {
  status?: number;
  message?: string;
  data?: unknown;
  result?: unknown;
}

/**
 * 发一次 WebService 请求并校验 `status`。
 *
 * **不静默**：非 0 一律抛错（带上服务端的 message + 常见释义）。调用方（面板）会
 * 把这句话直接显示出来，而不是假装搜索返回了空结果。
 */
async function lbsGet(path: string, params: Record<string, string | number>): Promise<LbsEnvelope> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === '' || value === undefined) continue;
    query.set(key, String(value));
  }
  query.set('key', lbsKey());

  const url = `${LBS_HOST}${path}?${query.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(LBS_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(
      `无法连接腾讯位置服务（${path}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`腾讯位置服务返回 HTTP ${res.status}：${path}`);
  }
  const body = (await res.json()) as LbsEnvelope;
  const status = typeof body.status === 'number' ? body.status : -1;
  if (status !== 0) {
    const hint = STATUS_HINTS[status];
    const message = body.message || '未知错误';
    throw new Error(`腾讯位置服务 ${status}：${message}${hint ? `（${hint}）` : ''}`);
  }
  return body;
}

// ───────────────────────────── 归一化（纯函数，便于单测） ─────────────────────────────

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 省市区拼成位置卡片的 `region` 那一行。
 *
 * 腾讯会给 `北京市/北京市/东城区` 这种「直辖市省市同名」的组合，原样拼会得到
 * 「北京市北京市东城区」，所以相邻重复的段落只留一个，空的段落丢掉。
 */
export function joinRegion(province: unknown, city: unknown, district: unknown): string {
  const parts: string[] = [];
  for (const raw of [text(province), text(city), text(district)]) {
    if (!raw) continue;
    if (parts[parts.length - 1] === raw) continue;
    parts.push(raw);
  }
  return parts.join('');
}

/**
 * 从完整地址里剥掉省市区前缀，只留街道门牌（位置卡片的 `address` 字段是
 * 「详细地址」，与 `region` 分开显示，重复一遍省市区很难看）。
 *
 * 剥不动（前缀对不上，比如地址以地标开头）就原样返回完整地址 —— 宁可长一点，
 * 也不要把地址削成空的。
 */
export function stripRegionPrefix(address: unknown, region: string): string {
  const full = text(address);
  if (!full) return '';
  if (!region) return full;
  let rest = full;
  // 逐段剥：腾讯的 address 未必逐字等于 province+city+district 的拼接。
  for (const part of [region, ...splitRegionParts(region)]) {
    if (part && rest.startsWith(part)) {
      rest = rest.slice(part.length);
      break;
    }
  }
  return rest.trim() || full;
}

/** 把拼好的 region 拆回单段（用于逐段尝试剥前缀）。 */
function splitRegionParts(region: string): string[] {
  const parts: string[] = [];
  for (const suffix of ['省', '市', '区', '县', '自治区', '自治州', '盟', '旗']) {
    let index = region.indexOf(suffix);
    while (index >= 0) {
      parts.push(region.slice(0, index + suffix.length));
      index = region.indexOf(suffix, index + suffix.length);
    }
  }
  return parts;
}

/** `/ws/place/v1/suggestion` 的一条 data → {@link LbsPlace}。 */
export function toLbsPlace(row: unknown): LbsPlace {
  const r = (row ?? {}) as Record<string, unknown>;
  const location = (r.location ?? {}) as Record<string, unknown>;
  const region = joinRegion(r.province, r.city, r.district);
  return {
    id: text(r.id),
    title: text(r.title),
    address: stripRegionPrefix(r.address, region),
    region,
    latitude: num(location.lat),
    longitude: num(location.lng),
  };
}

/** `/ws/geocoder/v1` 的 result → {@link LbsResolvedAddress}。 */
export function toLbsResolvedAddress(result: unknown): LbsResolvedAddress {
  const r = (result ?? {}) as Record<string, unknown>;
  const component = (r.address_component ?? {}) as Record<string, unknown>;
  const formatted = (r.formatted_addresses ?? {}) as Record<string, unknown>;
  const reference = (r.address_reference ?? {}) as Record<string, unknown>;
  const landmark = (reference.landmark_l2 ?? {}) as Record<string, unknown>;

  const region = joinRegion(component.province, component.city, component.district);
  const street = [text(component.street), text(component.street_number)].join('');
  return {
    // 地标名优先：位置卡片上写「天安门」比写「西长安街」更像人话；
    // 拿不到地标就退到腾讯的人性化地址推荐。
    title: text(landmark.title) || text(formatted.recommend),
    address: street || stripRegionPrefix(r.address, region),
    region,
  };
}

export class LbsService {
  /**
   * 关键词输入提示（`/ws/place/v1/suggestion`）。
   *
   * `latitude/longitude` 给当前地图中心，可以让结果按离你多远排序（腾讯按
   * `location` 半径优先）。
   */
  async suggestPlaces(params: {
    keyword: string;
    latitude?: number;
    longitude?: number;
    /** 限定城市（可选），减少跨城噪音。 */
    region?: string;
    limit?: number;
  }): Promise<LbsPlace[]> {
    const keyword = params.keyword?.trim();
    if (!keyword) return [];
    const body = await lbsGet('/ws/place/v1/suggestion', {
      keyword,
      // 腾讯要 lat,lng 的顺序（latitude 在前），别写反。
      ...(params.latitude !== undefined && params.longitude !== undefined
        ? { location: `${params.latitude},${params.longitude}` }
        : {}),
      ...(params.region?.trim() ? { region: params.region.trim() } : {}),
      page_index: 1,
      page_size: Math.min(Math.max(params.limit ?? 10, 1), 20),
      output: 'json',
    });
    const rows = Array.isArray(body.data) ? body.data : [];
    return rows.map(toLbsPlace).filter((place) => place.title !== '' || place.address !== '');
  }

  /**
   * 逆地址解析（`/ws/geocoder/v1`）：地图上点一下 → 可填进卡片的文字。
   *
   * `poi_options=policy=5` 是腾讯给的「**位置共享场景**」排序（发位置、分享位置
   * 常用地点优先）—— 正好是我们这个面板干的事。
   */
  async reverseGeocode(params: {
    latitude: number;
    longitude: number;
  }): Promise<LbsResolvedAddress> {
    const body = await lbsGet('/ws/geocoder/v1/', {
      location: `${params.latitude},${params.longitude}`,
      poi_options: 'policy=5',
      get_poi: 0,
      output: 'json',
    });
    return toLbsResolvedAddress(body.result);
  }
}
