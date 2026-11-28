/**
 * 小Q（QQ AI 助手）的头像。
 *
 * QQ 内置的是一个自家符号，没有可取的 CDN 图片；这里自绘一个与 QQ 品牌色
 * 协调的圆盘 + 对话气泡星芒，输出 `data:image/svg+xml`，直接交给 Avatar 组件
 * 当 `<img src>` 用（`cachedAvatarUrl` 对 data: URI 原样透传）。
 *
 * 同 deviceAvatar 的思路：不依赖外部资源，也不跟主题冲突。
 */

const AI_GLYPH =
  '<path d="M20 24h24a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H31l-8 6v-6h-3a4 4 0 0 1-4-4V28a4 4 0 0 1 4-4z"/>' +
  '<path d="M32 29l1.6 3.6L37 34l-3.4 1.4L32 39l-1.6-3.6L27 34l3.4-1.4z" fill="#fff" stroke="none"/>';

export function aiAssistantAvatarDataUri(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#5ac8fa"/><stop offset="1" stop-color="#0a84ff"/>` +
    `</linearGradient></defs>` +
    `<circle cx="32" cy="32" r="32" fill="url(#g)"/>` +
    `<g fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">` +
    AI_GLYPH +
    `</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
