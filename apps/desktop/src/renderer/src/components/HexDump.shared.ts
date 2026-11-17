/**
 * 十六进制转储 + 复制按钮。
 *
 * 从 `CapturePanel.tsx` 抽出来的：UDP 抓包面板要用同一份实现，抽出来避免两处
 * 漂移。样式类名沿用 `.weq-cap-*`（两边共用同一套样式）。
 */

/** 默认渲染的字节数；超过可用「显示全部」展开。 */
export const HEX_PREVIEW_BYTES = 2048;
