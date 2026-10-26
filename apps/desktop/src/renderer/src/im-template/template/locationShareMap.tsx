// @ts-nocheck
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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Minus, Plus } from 'lucide-react';
import { cn } from './classNames';
import { Avatar } from './primitives';
import { project, tileUrl, unproject } from './locationPicker';

const TILE_SIZE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 18;
/** Web Mercator 纬度上限；超出会让整块地图空掉。 */
const MAX_LAT = 85.05112878;
/** 拖拽判定阈值（像素）：超过就不算「点击落点」。 */
const CLICK_SLOP = 5;

export type MapView = { lng: number; lat: number; zoom: number };

/** 地图上的一个成员标记。 */
export interface MapMember {
  /** 稳定 key（uin 字符串）。 */
  id: string;
  /** 显示名（昵称 / 群名片），用于头像兜底与 title。 */
  name: string;
  avatarUrl?: string | null;
  /** 头像兜底种子（通常给 uid 或 uin）。 */
  seed?: string;
  longitude: number;
  latitude: number;
  /** 是不是自己 —— 自己用主题色描边 + 呼吸圈。 */
  isSelf?: boolean;
  /** 最近一次上报距今多少秒；用于「位置陈旧」的视觉提示。 */
  ageSeconds?: number;
}

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
      lng: points[0].longitude,
      lat: points[0].latitude,
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

export function LocationShareMap({
  view,
  onViewChange,
  members,
  onPick,
  pickEnabled = false,
  className,
}: {
  view: MapView;
  onViewChange: (next: MapView) => void;
  members: MapMember[];
  /** 点地图落点（把自己挪过去）；`pickEnabled` 为假时不触发。 */
  onPick?: (longitude: number, latitude: number) => void;
  pickEnabled?: boolean;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // 原生滚轮监听里要读当前视野，但不想让 effect 跟着 view 重挂。
  const viewRef = useRef(view);
  viewRef.current = view;

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
  const geoAt = useCallback((clientX: number, clientY: number) => {
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

  /** 缩放；给了锚点就让锚点下的地理坐标停在屏幕上的同一处。 */
  const zoomBy = useCallback(
    (delta: number, anchor?: { lng: number; lat: number }) => {
      const current = viewRef.current;
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom + delta));
      if (zoom === current.zoom) return;
      if (!anchor) {
        onViewChange(clampView({ ...current, zoom }));
        return;
      }
      const before = project(anchor.lng, anchor.lat, current.zoom);
      const after = project(anchor.lng, anchor.lat, zoom);
      const centerPx = project(current.lng, current.lat, current.zoom);
      const next = unproject(
        centerPx.x + (after.x - before.x),
        centerPx.y + (after.y - before.y),
        zoom,
      );
      onViewChange(clampView({ lng: next.lng, lat: next.lat, zoom }));
    },
    [onViewChange],
  );

  // 滚轮缩放要 preventDefault，React 的合成 wheel 是 passive 的 —— 挂原生监听。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1 : -1, geoAt(event.clientX, event.clientY));
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [zoomBy, geoAt]);

  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lng: number;
    lat: number;
    moved: number;
  } | null>(null);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lng: viewRef.current.lng,
      lat: viewRef.current.lat,
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
    onViewChange(clampView({ ...viewRef.current, lng: next.lng, lat: next.lat }));
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // 拖动过就不是落点。
    if (drag.moved > CLICK_SLOP) return;
    if (!pickEnabled || !onPick) return;
    const geo = geoAt(event.clientX, event.clientY);
    onPick(geo.lng, geo.lat);
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

  return (
    <div
      className={cn('lbs-map', pickEnabled && 'is-pickable', className)}
      ref={hostRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
      role="application"
      aria-label="位置共享地图"
    >
      <div className={cn('lbs-map-tiles')}>
        {tiles.map((tile) => (
          <img
            key={tile.key}
            className={cn('lbs-map-tile')}
            src={tile.src}
            alt=""
            draggable={false}
            referrerPolicy="no-referrer"
            style={{ left: `${tile.left}px`, top: `${tile.top}px` }}
          />
        ))}
      </div>

      {members.map((member) => {
        const px = project(member.longitude, member.latitude, view.zoom);
        const left = px.x - originX;
        const top = px.y - originY;
        // 视野外的标记不渲染 —— 否则它们会以「贴在边缘」的假位置出现。
        if (left < -80 || top < -80 || left > size.width + 80 || top > size.height + 80) {
          return null;
        }
        const stale = (member.ageSeconds ?? 0) > 60;
        return (
          <span
            key={member.id}
            className={cn('lbs-map-member', member.isSelf && 'is-self', stale && 'is-stale')}
            style={{ left: `${left}px`, top: `${top}px` }}
            title={member.name}
          >
            {member.isSelf ? <span className={cn('lbs-map-self-ring')} aria-hidden /> : null}
            <span className={cn('lbs-map-avatar')}>
              <Avatar
                name={member.name}
                avatarUrl={member.avatarUrl ?? null}
                seed={member.seed ?? member.id}
              />
            </span>
          </span>
        );
      })}

      <div className={cn('lbs-map-zoom')}>
        <button
          type="button"
          title="放大"
          disabled={view.zoom >= MAX_ZOOM}
          onClick={() => zoomBy(1)}
        >
          <Plus size={13} strokeWidth={2.4} />
        </button>
        <button
          type="button"
          title="缩小"
          disabled={view.zoom <= MIN_ZOOM}
          onClick={() => zoomBy(-1)}
        >
          <Minus size={13} strokeWidth={2.4} />
        </button>
      </div>

      <span className={cn('lbs-map-credit')}>© 高德地图</span>
    </div>
  );
}
