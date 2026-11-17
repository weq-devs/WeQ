/**
 * 待发送文件 / 视频托盘、超级表情卡片、拖拽落点与预览灯箱。
 * 图片不走这里 —— 图片像表情一样内联进输入框（见 chatPane 的 insertInlineImage）。
 */

import '../styles/composer-media-tray.css';

/** 从剪贴板 / 拖拽里挑出可用的文件。 */
export function collectFiles(files: FileList | File[] | null | undefined): File[] {
  if (!files) return [];
  return Array.from(files).filter((file) => file.size >= 0);
}
