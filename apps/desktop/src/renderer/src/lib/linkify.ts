/**
 * 聊天文本里的链接识别与打开。
 *
 * 两件事：把一段纯文本切成「文字 / 链接」片段（{@link splitLinks}），以及安全地把一个
 * 链接交给系统浏览器（{@link openLink}）。
 *
 * 打开这一侧的边界：
 *   · 只放行 http(s)。`file://` / `javascript:` / `mqqapi://` 这类一律不开——聊天文本
 *     是完全不可信的输入，让它触发本机协议处理器等于把攻击面直接送出去。
 *   · 用户点的链接若指向可执行/安装包后缀，先弹一次确认。浏览器不会自动运行下载物，
 *     但「点一下就开始下 .exe」本身值得让人先看清域名——这一步是给人看的，不是给
 *     浏览器看的。
 *   · 复用跨端外链入口：桌面通过 IPC 交给系统浏览器，Web / Remote 在点击设备打开。
 */

import { splitLinks } from '@weq/service/text-links';
import { useDialog } from '../components/Dialog.shared';
import { openExternalLink } from './openExternalLink';

export { splitLinks, type LinkPart } from '@weq/service/text-links';

/** 整段文本是否**只是**一个链接（决定要不要出卡片）。 */
export function soleLink(text: string): string | null {
  const parts = splitLinks(text.trim());
  const links = parts.filter((p) => p.kind === 'link');
  if (links.length !== 1) return null;
  const rest = parts
    .filter((p) => p.kind === 'text')
    .map((p) => p.text.trim())
    .join('');
  return rest === '' ? links[0]!.href : null;
}

/** 点开会直接开始下载的后缀 —— 打开前要用户再确认一次。 */
const RISKY_EXT =
  /\.(exe|msi|msix|appx|bat|cmd|com|scr|pif|ps1|vbs|vbe|js|jse|wsf|hta|jar|apk|dmg|pkg|deb|rpm|sh|run|iso|img|lnk|reg|dll|zip|rar|7z|gz)(?:$|[?#])/i;

/**
 * 用系统浏览器打开一个链接。非 http(s) 直接拒绝；指向可执行/压缩包后缀时先确认。
 * 返回是否真的打开了。
 */
export async function openLink(href: string, ownerDocument?: Document): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (RISKY_EXT.test(url.pathname + url.search)) {
    const rawName = url.pathname.split('/').pop() ?? '';
    let name = rawName;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      // 非法百分号编码仍按原始文件名确认，不让链接点击抛出异常。
    }
    const ok = await useDialog
      .getState()
      .confirm(
        '打开下载链接？',
        `这个链接指向一个可执行文件或压缩包，打开后浏览器可能直接开始下载。\n\n` +
          `站点：${url.hostname}\n文件：${name}`,
        { okLabel: '在浏览器中打开', ownerDocument },
      );
    if (!ok) return false;
  }
  try {
    return (await openExternalLink(url.toString(), ownerDocument?.defaultView ?? undefined)).ok;
  } catch {
    return false;
  }
}
