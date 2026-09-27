// @ts-nocheck
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Crosshair, Minus, Plus } from 'lucide-react';
import { cn } from './classNames';

const TILE_SIZE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 18;
/**
 * Web Mercator 的纬度上限。**映射到瓦片之外会让整块地图空掉**（`ty` 落到
 * `[0, 2^z)` 之外，一个瓦片都画不出来）—— 所以中心点必须夹住，拖到极地就停在边上。
 */
const MAX_LAT = 85.05112878;
/** 默认中心：北京 · 天安门（用户还没落点、也没搜索时的起点）。 */
export const DEFAULT_CENTER = { lng: 116.397428, lat: 39.90923 };
/** 新开地图时的初始缩放级别。 */
export const DEFAULT_ZOOM = 15;
/** 拖拽判定阈值：超过这个像素数就不算「单击落点」。 */
const CLICK_SLOP = 5;
/** 写回坐标时的小数位 —— 6 位约 0.1 米，与 QQ 卡片样本的精度一致。 */
const COORD_DECIMALS = 6;

type View = { lng: number; lat: number; zoom: number };
type GeoPoint = { lng: number; lat: number };

/** 高德栅格瓦片地址（`webrd0{1..4}`，无 key、无签名）。 */
export function tileUrl(zoom: number, x: number, y: number): string {
  const sub = (Math.abs(x + y) % 4) + 1;
  return `https://webrd0${sub}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&z=${zoom}&x=${x}&y=${y}`;
}

/** 经度归一化到 [-180, 180)。 */
function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** 把视野夹进可渲染范围：纬度不过极，缩放不越界。 */
function clampView(view: View): View {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom));
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, view.lat));
  return zoom === view.zoom && lat === view.lat
    ? view
    : { ...view, lng: wrapLng(view.lng), lat, zoom };
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

function parseCoordinate(value: string, limit: number): number | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const num = Number(text);
  if (!Number.isFinite(num) || Math.abs(num) > limit) return null;
  return num;
}

export function LocationPicker({
  latitude,
  longitude,
  onPick,
  disabled,
}: {
  /** 纬度（十进制度字符串）。空 = 还没落点。 */
  latitude: string;
  /** 经度（十进制度字符串）。空 = 还没落点。 */
  longitude: string;
  /** 点选回调；`onPick(lat, lng)` 都是定长小数字符串。 */
  onPick: (latitude: string, longitude: string) => void;
  disabled?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const picked = useMemo<GeoPoint | null>(() => {
    const lat = parseCoordinate(latitude, 90);
    const lng = parseCoordinate(longitude, 180);
    return lat === null || lng === null ? null : { lat, lng };
  }, [latitude, longitude]);

  const [view, setView] = useState<View>(() =>
    clampView({
      lng: picked?.lng ?? DEFAULT_CENTER.lng,
      lat: picked?.lat ?? DEFAULT_CENTER.lat,
      zoom: DEFAULT_ZOOM,
    }),
  );
  // 原生滚轮监听里要读「当前视野」，但又不想让 Effect 跟着 view 重挂 —— 走 ref。
  const viewRef = useRef(view);
  viewRef.current = view;
  /** 最近一次**地图内**落点的坐标签名：自己点的不用再「飞过去」，否则地图会在光标下跳。 */
  const internalPickRef = useRef<string | null>(null);

  // 容器尺寸：瓦片要按可视区裁，尺寸靠 ResizeObserver 拿。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = (): void => setSize({ width: host.clientWidth, height: host.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  /** 屏幕坐标 → 地理坐标。 */
  const geoAt = useCallback((clientX: number, clientY: number): GeoPoint => {
    const host = hostRef.current;
    const current = viewRef.current;
    if (!host) return { lng: current.lng, lat: current.lat };
    const rect = host.getBoundingClientRect();
    const centerPx = project(current.lng, current.lat, current.zoom);
    return unproject(
      centerPx.x + (clientX - rect.left) - rect.width / 2,
      centerPx.y + (clientY - rect.top) - rect.height / 2,
      current.zoom,
    );
  }, []);

  // 经纬度**从外面**改了（搜索选了一条 / 用户在输入框里敲了坐标）：只在目标跑出
  // 视野时才跟着飞过去 —— 视野内不动，免得每敲一位数字地图都跳一下。
  // 地图内自己落的那一下直接跳过（否则地图会在光标下面跳走）。
  useEffect(() => {
    if (!picked) return;
    if (internalPickRef.current === `${latitude}|${longitude}`) return;
    const current = viewRef.current;
    const rect = hostRef.current?.getBoundingClientRect();
    const centerPx = project(current.lng, current.lat, current.zoom);
    const targetPx = project(picked.lng, picked.lat, current.zoom);
    const halfWidth = (rect?.width ?? 0) / 2;
    const halfHeight = (rect?.height ?? 0) / 2;
    const visible =
      Math.abs(targetPx.x - centerPx.x) <= halfWidth * 0.8 &&
      Math.abs(targetPx.y - centerPx.y) <= halfHeight * 0.8;
    if (visible) return;
    setView((v) => clampView({ ...v, lng: picked.lng, lat: picked.lat }));
  }, [latitude, longitude, picked]);

  /**
   * 缩放；给了锚点就让锚点下的地理坐标停在屏幕上的同一处。
   *
   * 推导（`centerPx` = 中心的世界像素）：某点相对容器中心的屏幕偏移是
   * `project(g).x - centerPx.x`，要保持这个差值不变，
   * 所以 `centerPx2 = centerPx + (project(g, z2) - project(g, z1))`。
   * 早先这里把差值写反了、还多加了指针偏移，结果一滚轮视野就飞到极地，
   * `ty` 全落到瓦片范围外 —— 表现就是「缩放后一张图都不出来」。
   */
  const zoomBy = useCallback((delta: number, anchor?: GeoPoint) => {
    setView((current) => {
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom + delta));
      if (zoom === current.zoom) return current;
      if (!anchor) return clampView({ ...current, zoom });
      const before = project(anchor.lng, anchor.lat, current.zoom);
      const after = project(anchor.lng, anchor.lat, zoom);
      const centerPx = project(current.lng, current.lat, current.zoom);
      const next = unproject(
        centerPx.x + (after.x - before.x),
        centerPx.y + (after.y - before.y),
        zoom,
      );
      return clampView({ lng: next.lng, lat: next.lat, zoom });
    });
  }, []);

  // 滚轮缩放要 preventDefault，React 的合成 wheel 是 passive 的 —— 挂原生监听。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent): void => {
      if (disabled) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1 : -1, geoAt(event.clientX, event.clientY));
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [zoomBy, geoAt, disabled]);

  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lng: number;
    lat: number;
    moved: number;
  } | null>(null);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (disabled || event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lng: view.lng,
      lat: view.lat,
      moved: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
    const startPx = project(drag.lng, drag.lat, viewRef.current.zoom);
    const next = unproject(startPx.x - dx, startPx.y - dy, viewRef.current.zoom);
    setView((current) => clampView({ ...current, lng: next.lng, lat: next.lat }));
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // 拖动过就不是落点；没拖动 → 这一下就是「落点」。
    if (disabled || drag.moved > CLICK_SLOP) return;
    const geo = geoAt(event.clientX, event.clientY);
    const lat = formatCoordinate(geo.lat);
    const lng = formatCoordinate(geo.lng);
    internalPickRef.current = `${lat}|${lng}`;
    onPick(lat, lng);
  }

  const centerPx = project(view.lng, view.lat, view.zoom);
  const originX = centerPx.x - size.width / 2;
  const originY = centerPx.y - size.height / 2;
  const tileCount = 2 ** view.zoom;

  const tiles: Array<{ key: string; src: string; left: number; top: number }> = [];
  if (size.width > 0 && size.height > 0) {
    const startX = Math.floor(originX / TILE_SIZE);
    const endX = Math.floor((originX + size.width) / TILE_SIZE);
    const startY = Math.floor(originY / TILE_SIZE);
    const endY = Math.floor((originY + size.height) / TILE_SIZE);
    for (let tx = startX; tx <= endX; tx += 1) {
      for (let ty = startY; ty <= endY; ty += 1) {
        if (ty < 0 || ty >= tileCount) continue;
        const wrapped = ((tx % tileCount) + tileCount) % tileCount;
        tiles.push({
          key: `${view.zoom}/${tx}/${ty}`,
          src: tileUrl(view.zoom, wrapped, ty),
          left: tx * TILE_SIZE - originX,
          top: ty * TILE_SIZE - originY,
        });
      }
    }
  }

  const markerPx = picked ? project(picked.lng, picked.lat, view.zoom) : null;

  return (
    <div
      className={cn('ark-map', disabled && 'is-disabled')}
      ref={hostRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
      role="application"
      aria-label="位置选点地图"
    >
      <div className={cn('ark-map-tiles')}>
        {tiles.map((tile) => (
          <img
            key={tile.key}
            className={cn('ark-map-tile')}
            src={tile.src}
            alt=""
            draggable={false}
            referrerPolicy="no-referrer"
            style={{ left: `${tile.left}px`, top: `${tile.top}px` }}
          />
        ))}
      </div>

      {markerPx ? (
        <span
          className={cn('ark-map-pin')}
          style={{ left: `${markerPx.x - originX}px`, top: `${markerPx.y - originY}px` }}
          aria-hidden
        >
          <svg viewBox="0 0 24 24" width="24" height="24">
            <path
              d="M12 2c-3.9 0-7 3.1-7 7 0 5.1 7 13 7 13s7-7.9 7-13c0-3.9-3.1-7-7-7z"
              fill="currentColor"
            />
            <circle cx="12" cy="9" r="2.6" fill="#ffffff" />
          </svg>
        </span>
      ) : (
        <button
          type="button"
          className={cn('ark-map-hint')}
          title="点一下地图落点"
          disabled={disabled}
          onClick={() =>
            onPick(formatCoordinate(DEFAULT_CENTER.lat), formatCoordinate(DEFAULT_CENTER.lng))
          }
        >
          <Crosshair size={13} strokeWidth={2.2} />
          点地图落点
        </button>
      )}

      <div className={cn('ark-map-zoom')}>
        <button
          type="button"
          title="放大"
          disabled={disabled || view.zoom >= MAX_ZOOM}
          onClick={() => zoomBy(1)}
        >
          <Plus size={13} strokeWidth={2.4} />
        </button>
        <button
          type="button"
          title="缩小"
          disabled={disabled || view.zoom <= MIN_ZOOM}
          onClick={() => zoomBy(-1)}
        >
          <Minus size={13} strokeWidth={2.4} />
        </button>
      </div>

      <span className={cn('ark-map-credit')}>© 高德地图</span>
    </div>
  );
}
