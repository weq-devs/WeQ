/**
 * Device-line (数据线) avatar helper.
 *
 * Conversations of chatType `KCHATTYPEDATALINE` (8) / `KCHATTYPEDATALINEMQQ`
 * (134) are QQ's cross-device sync entries — 「我的手机」/「我的电脑」/「我的平板」. Their
 * uid is a fixed device pseudo-uid (see `@weq/codec` DATALINE_* ), not a real
 * friend uid, so the CDN avatar can't resolve. Instead of an empty
 * initial-letter fallback we render a self-drawn device glyph (picked by the
 * device type) on a QQ-blue gradient disc.
 *
 * The result is a `data:image/svg+xml,…` URI that flows straight through the
 * existing `Avatar` component (`<img src>`); `cachedAvatarUrl` leaves `data:`
 * URIs untouched, so no template change is needed.
 */

import { datalineDevice, type DatalineDevice } from '@weq/codec';

/** True for device-line conversations (accepts the mapped enum string or the raw number). */
export function isDataline(chatType: string | number): boolean {
  const s = String(chatType);
  return s.includes('DATALINE') || s === '8' || s === '134';
}

/** White line glyphs (viewBox 0 0 64 64), stroked white in render. */
const GLYPHS: Record<DatalineDevice, string> = {
  // 手机：圆角机身 + 听筒线 + 底部圆点
  phone:
    '<rect x="23" y="16" width="18" height="32" rx="4"/>' +
    '<line x1="29" y1="21" x2="35" y2="21"/>' +
    '<circle cx="32" cy="43" r="1.6" fill="#fff" stroke="none"/>',
  // 电脑：显示器 + 底座
  pc:
    '<rect x="16" y="18" width="32" height="21" rx="3"/>' +
    '<line x1="26" y1="46" x2="38" y2="46"/>' +
    '<line x1="32" y1="39" x2="32" y2="46"/>',
  // 平板：横向机身 + 侧边按钮
  pad:
    '<rect x="18" y="19" width="28" height="26" rx="3"/>' +
    '<line x1="42" y1="25" x2="42" y2="31"/>',
};

// 未知设备（uid 不在映射表里）时的通用「设备同步」图标。
const SYNC_GLYPH =
  '<path d="M20 30a12 12 0 0 1 20-7l4 3"/>' +
  '<path d="M44 34a12 12 0 0 1-20 7l-4-3"/>' +
  '<path d="M44 20v6h-6"/>' +
  '<path d="M20 44v-6h6"/>';

/**
 * A QQ-blue disc + white device glyph, as a `data:image/svg+xml` URI. Pass the
 * conversation uid so the glyph matches the actual device; unknown uids get a
 * generic sync icon.
 */
export function deviceAvatarDataUri(uid: string): string {
  const device = datalineDevice(uid);
  const glyph = device ? GLYPHS[device] : SYNC_GLYPH;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#4aa8ff"/><stop offset="1" stop-color="#0d84e8"/>` +
    `</linearGradient></defs>` +
    `<circle cx="32" cy="32" r="32" fill="url(#g)"/>` +
    `<g fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">` +
    glyph +
    `</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
