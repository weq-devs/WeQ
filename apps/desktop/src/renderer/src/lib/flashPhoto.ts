/**
 * 闪照（阅后即焚图）在**渲染层**的识别与占位处理。
 *
 * 背景（`docs/database/nt_msg/elements/pic.md`）：闪照在本地库 `40800` 里只剩一条
 * 纯文本 `[闪照]请使用新版手机QQ查看闪照。`，真正的 `commonElem(serviceType=3)`
 * 元素从来没落过库。所以离线看到的永远是这句话，图片本体也不在磁盘上。
 *
 * 要看内容只有一条路：**走协议拉取**（`SsoGetC2cMsg` / `SsoGetGroupMsg`，服务端
 * 漫游里这条消息仍然带着完整的闪照元素），拿到后按 `pic` + `isFlash` 重新渲染。
 * 这条链路需要在线 QQ + 完整模式，所以本模块只负责「识别」和「文案」，拉取由
 * `MainView` 在会话层触发。
 */

/**
 * 闪照的兜底文案 —— 与 `@weq/protocol` 的 `FLASH_PHOTO_FALLBACK_TEXT` 同值。
 *
 * 不直接 import：渲染层不能依赖 protocol 包（那边带 node / native 依赖，会被打进
 * 渲染进程的 bundle）。两处都改的话请一起改，协议包有测试钉住这个字面量。
 */
export const FLASH_PHOTO_PLACEHOLDER_TEXT = '[闪照]请使用新版手机QQ查看闪照。';

/** 这条纯文本是不是闪照的兜底文案（用于触发协议补拉）。 */
export function isFlashPhotoPlaceholderText(text: string): boolean {
  return text.trim() === FLASH_PHOTO_PLACEHOLDER_TEXT;
}
