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
 *   · 走 `window.open` → 主进程 `setWindowOpenHandler` 已把所有 target=_blank 转成
 *     `shell.openExternal` 并 deny 掉窗口，所以应用内不会有任何远程页面被加载。
 */

/**
 * 链接匹配。刻意不追求 RFC 完备，只认聊天里真正会出现的两种写法：带 scheme 的
 * http(s)，以及裸 `www.` 开头的域名。写成无回溯的字符类扫描（避免 catastrophic
 * backtracking——这条正则要跑在每一条消息上）。
 */
const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>"'“”，。！？；：、）】》]+/gi;

/** 结尾的成对标点通常是句子的一部分而非 URL 的（`(见 https://a.com/x)`）。 */
function trimTrailing(raw: string): string {
  let out = raw;
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    if ('.,;:!?)]}\'"'.includes(last)) {
      // 括号只在没有配对的开括号时才剥掉（维基链接常自带括号）。
      if (last === ')' && (out.match(/\(/g)?.length ?? 0) >= (out.match(/\)/g)?.length ?? 0)) break;
      out = out.slice(0, -1);
      continue;
    }
    break;
  }
  return out;
}

export interface LinkPart {
  kind: 'text' | 'link';
  /** 原文（链接片段保留用户写的原样，用于显示）。 */
  text: string;
  /** 链接片段的规范化地址（裸 www. 补上 https://）；文字片段为空串。 */
  href: string;
}

/** 把一段文本切成文字/链接片段。没有链接时返回单个 text 片段。 */
export function splitLinks(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let cursor = 0;
  LINK_RE.lastIndex = 0;
  let m = LINK_RE.exec(text);
  while (m) {
    const raw = trimTrailing(m[0]);
    if (raw.length >= 8) {
      const start = m.index;
      if (start > cursor) parts.push({ kind: 'text', text: text.slice(cursor, start), href: '' });
      const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      parts.push({ kind: 'link', text: raw, href });
      cursor = start + raw.length;
    }
    LINK_RE.lastIndex = m.index + m[0].length;
    m = LINK_RE.exec(text);
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor), href: '' });
  return parts;
}

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
export function openLink(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (RISKY_EXT.test(url.pathname + url.search)) {
    const name = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    const ok = window.confirm(
      `这个链接指向一个可执行文件或压缩包，打开后浏览器可能直接开始下载。\n\n` +
        `站点：${url.hostname}\n文件：${name}\n\n确定要在浏览器中打开吗？`,
    );
    if (!ok) return false;
  }
  window.open(url.toString(), '_blank', 'noopener,noreferrer');
  return true;
}
