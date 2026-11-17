/**
 * 位置选点地图 —— **手写的 slippy map**（高德栅格瓦片），不依赖任何地图 SDK。
 *
 * 为什么不用地图 JS API：本应用的 CSP 是 `script-src 'self'`（见 index.html），引第三方
 * SDK 要放开脚本边界 —— 那是 XSS 的主防线，为一个选点组件不值得。瓦片是纯 `<img>`，
 * 只需 `img-src` 放行，无 key、无鉴权。
 *
 * 坐标：瓦片本身是 GCJ-02 的，所以从地图上读出来的经纬度就是 GCJ-02 —— 正好是
 * QQ 位置卡片要的那一套，不需要任何火星坐标转换。
 *
 * 交互：拖拽平移、滚轮 / 按钮缩放、单击（没拖动的那一下）落点。落点用图钉标出，
 * 与父级的经纬度输入框双向同步。
 */

export const TILE_SIZE = 256;
/**
 * Web Mercator 的纬度上限。**映射到瓦片之外会让整块地图空掉**（`ty` 落到
 * `[0, 2^z)` 之外，一个瓦片都画不出来）—— 所以中心点必须夹住，拖到极地就停在边上。
 */
export const MAX_LAT = 85.05112878;
/** 默认中心：北京 · 天安门（用户还没落点、也没搜索时的起点）。 */
export const DEFAULT_CENTER = { lng: 116.397428, lat: 39.90923 };
/** 新开地图时的初始缩放级别。 */
export const DEFAULT_ZOOM = 15;
/** 写回坐标时的小数位 —— 6 位约 0.1 米，与 QQ 卡片样本的精度一致。 */
const COORD_DECIMALS = 6;
export type GeoPoint = { lng: number; lat: number };

/** 高德栅格瓦片地址（`webrd0{1..4}`，无 key、无签名）。 */
export function tileUrl(zoom: number, x: number, y: number): string {
  const sub = (Math.abs(x + y) % 4) + 1;
  return `https://webrd0${sub}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&z=${zoom}&x=${x}&y=${y}`;
}

/** 经度归一化到 [-180, 180)。 */
export function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** 经纬度 → 世界像素坐标（Web Mercator，与瓦片同一套投影）。 */
export function project(lng: number, lat: number, zoom: number): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** zoom;
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

/** {@link project} 的逆运算。 */
export function unproject(x: number, y: number, zoom: number): GeoPoint {
  const scale = TILE_SIZE * 2 ** zoom;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - 2 * Math.PI * (y / scale);
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lng: wrapLng(lng), lat };
}

/** 度 → 定长小数字符串（面板与 QQ 卡片都用它）。 */
export function formatCoordinate(value: number): string {
  return value.toFixed(COORD_DECIMALS);
}
