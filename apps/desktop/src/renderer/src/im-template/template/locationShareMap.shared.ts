/**
 * 位置共享地图 —— 多成员头像标记 + 可交互的 slippy map。
 *
 * 与 `locationPicker.tsx` 同源（同一套高德栅格瓦片与 Web Mercator 投影），但那个
 * 组件是「选一个点」的受控输入框（固定 150px 高、视口不可控、单图钉），位置共享
 * 要的是「看一屋子人在哪 + 自己随时能挪」：
 *
 *   - 视口（中心 / 缩放）由外部控制，便于「跟随我」；
 *   - 每个成员一个头像标记，自己高亮；
 *   - 点击地图 = 把自己挪过去（可选）；
 *   - 拖拽平移、滚轮/按钮缩放。
 *
 * CSP：瓦片是纯 `<img>`，`img-src` 已放行 `https://*.is.autonavi.com`。
 * 坐标全程 GCJ-02 —— 瓦片与 QQ 的共享协议是同一套，不需要火星坐标转换。
 */

import { project, unproject } from './locationPicker.shared';
export const MIN_ZOOM = 3;
export const MAX_ZOOM = 18;
/** Web Mercator 纬度上限；超出会让整块地图空掉。 */
const MAX_LAT = 85.05112878;

export type MapView = { lng: number; lat: number; zoom: number };

function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

export function clampView(view: MapView): MapView {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom));
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, view.lat));
  const lng = wrapLng(view.lng);
  // 三个分量都没变就原样返回，避免调用方拿到新对象触发多余重渲染。
  if (zoom === view.zoom && lat === view.lat && lng === view.lng) return view;
  return { lng, lat, zoom };
}

/**
 * 把一组坐标收进视野：算出让所有点都可见的中心与缩放。
 *
 * `padding` 是给标记留的边距（像素），否则贴边的头像会被裁掉一半。
 */
export function fitView(
  points: Array<{ longitude: number; latitude: number }>,
  size: { width: number; height: number },
  padding = 56,
): MapView | null {
  if (!points.length || size.width <= 0 || size.height <= 0) return null;
  if (points.length === 1) {
    return clampView({
      lng: points[0]!.longitude,
      lat: points[0]!.latitude,
      zoom: 16,
    });
  }
  const usableW = Math.max(1, size.width - padding * 2);
  const usableH = Math.max(1, size.height - padding * 2);
  // 先在最细粒度上投影，再按「需要缩多少」反推 zoom。
  const baseZoom = 18;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    const px = project(point.longitude, point.latitude, baseZoom);
    minX = Math.min(minX, px.x);
    maxX = Math.max(maxX, px.x);
    minY = Math.min(minY, px.y);
    maxY = Math.max(maxY, px.y);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const zoomX = baseZoom + Math.log2(usableW / spanX);
  const zoomY = baseZoom + Math.log2(usableH / spanY);
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(zoomX, zoomY)));
  const center = unproject((minX + maxX) / 2, (minY + maxY) / 2, baseZoom);
  return clampView({ lng: center.lng, lat: center.lat, zoom });
}
