/**
 * URL builders for the `weq-asset://` protocol (served by the main process
 * from the shared `resources/` tree — see src/main/resource_protocol.ts).
 *
 * In the browser build there are no custom schemes, so the same handlers are
 * mounted on HTTP routes and these builders emit `/_asset/…` / `/_media/…`
 * instead. `VITE_WEQ_TARGET` is set by each app's vite config.
 */

const IS_WEB = import.meta.env.VITE_WEQ_TARGET === 'web';

/** `weq-asset://` on Electron, `/_asset/` in the browser. */
const SCHEME_PREFIX = IS_WEB ? '/_asset/' : 'weq-asset://';
const MEDIA_PREFIX = IS_WEB ? '/_media/' : 'weq-media://';
const AVATAR_PREFIX = IS_WEB ? '/_avatar/' : 'weq-avatar://';

/** `weq-asset://<segments joined by '/'>` */
export function resourceUrl(...segments: string[]): string {
  const path = segments
    .flatMap((segment) => segment.split('/'))
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `${SCHEME_PREFIX}${path}`;
}

/** Shorthand for assets under `resources/emoji/…`. */
export function emojiUrl(...segments: string[]): string {
  return resourceUrl('emoji', ...segments);
}

/** Shorthand for a file-type icon under `resources/fileIcon/…`. */
export function fileIconUrl(iconBasename: string): string {
  return resourceUrl('fileIcon', iconBasename);
}

/**
 * `weq-media://<kind>?<query>` — streams a chat message's on-disk media (served
 * by src/main/media_protocol.ts). `kind` is pic/video/ptt/mface.
 */
export function mediaUrl(kind: string, params: Record<string, string | number>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  return `${MEDIA_PREFIX}${kind}?${q.toString()}`;
}

/** Proxy a remote QQ album image through the main process so Qzone referer is attached. */
export function albumMediaUrl(src: string): string {
  return mediaUrl('album', { src });
}

/** `weq-avatar://fetch?src=…` — the disk-cached bridge for a remote image. */
export function avatarFetchUrl(src: string): string {
  return `${AVATAR_PREFIX}fetch?src=${encodeURIComponent(src)}`;
}

/**
 * Proxy a QQ 收藏 (collection) collector-CDN image (`http://shp.qpic.cn/collector/…`)
 * through the disk-cached avatar bridge. The collector CDN is public (no referer),
 * so the generic fetch+cache bridge is enough; on failure `<img onError>` falls back.
 */
export function collectionImageUrl(src: string): string {
  return avatarFetchUrl(src);
}

/**
 * Proxy a QQ 会员装扮资源 (tianquan.gtimg.cn — 挂件/名片/浮屏/聊天背景) through the
 * main process's disk cache. 图片走头像缓存、mp4 落盘后按文件流回,渲染进程因此不必
 * 直连 CDN(也就不用为它放开 CSP)。空串原样返回,方便调用方直接 `url && <img …>`。
 */
export function dressUrl(src: string): string {
  return src ? mediaUrl('dress', { src }) : '';
}

/**
 * 已安装的装扮字体 ttf。清单里记着绝对路径,主进程按 itemId 查(见 dress_install)。
 * 走 weq-media 而不是 weq-asset —— 后者只服务仓库的 resources/ 树,读不了账号缓存目录。
 */
export function dressFontUrl(itemId: number): string {
  return mediaUrl('dressfont', { id: itemId });
}

/**
 * 走 protocol 兜底装上的气泡九宫格(本地 PNG)。
 *
 * 与 {@link dressUrl} 二选一:CDN 直链走那个,本地文件走这个 —— `dress` 分支有
 * host 白名单(只放行 tianquan.gtimg.cn),喂本地路径会被拒。
 */
export function dressBubbleUrl(itemId: number): string {
  return mediaUrl('dressbubble', { id: itemId });
}

/**
 * 用户自选的聊天背景(本地图)。
 *
 * `stamp` 是用来穿透缓存的:文件名固定为 `custom.<ext>`,换了图 url 却不变,浏览器
 * 会继续画旧的那张。传一个换图时必然变的值(清单里的绝对路径)即可。
 */
export function dressBackgroundUrl(stamp: string): string {
  return mediaUrl('dressbg', { v: stamp });
}

/**
 * 浮屏挂件的图片目录(`resources/dress/screen/<id>/images/`),用作 lottie 的
 * `assetsPath`。
 *
 * 两个坑合在这一行里:
 *
 *  1. **必须指向 images/ 而不是包目录。** 设了 assetsPath 时 lottie 只用 asset 的
 *     `p`(`"img_0.png"`)、**忽略 `u`**(`"images/"`),见 lottie_light 的
 *     `getAssetsPath`。指向包目录会拼出 `…/4/img_0.png`,少一层。
 *  2. **必须带尾斜杠。** 那里是裸字符串拼接,少一个斜杠会拼出 `imagesimg_0.png`。
 *     所以不能走 {@link resourceUrl} —— 它会把空段过滤掉,尾斜杠留不住。
 */
export function screenWidgetAssetsPath(widgetId: string): string {
  return `${resourceUrl('dress', 'screen', widgetId, 'images')}/`;
}

/** 挂件目录下的某个文件。 */
export function screenWidgetUrl(widgetId: string, ...segments: string[]): string {
  return resourceUrl('dress', 'screen', widgetId, ...segments);
}

/**
 * 链接卡片的封面图。`id` 是主进程落盘时给的缓存名 —— 这里刻意**不接受 URL**：
 * 图片字节由 LinkPreviewService 抓取并验过魔数,渲染层只能取已缓存的那些,
 * 不能拿这条协议当任意 URL 的代理。
 */
export function linkPreviewImageUrl(id: string): string {
  return mediaUrl('linkpreview', { id });
}

/** Preview a local file under `nt_data/File/Ori` by absolute path (image thumbnails). */export function localFileUrl(absPath: string): string {
  return mediaUrl('localfile', { path: absPath });
}

/**
 * Stream a local media-cache file (PhotoWall / Qzone / Pic / Video). `rel` is the
 * path relative to that kind's root (`<bucket>/<name>` or `<month>/Ori|Thumb/<name>`);
 * the main process re-validates it before streaming.
 */
export function localMediaUrl(kind: string, rel: string): string {
  return mediaUrl('localmedia', { kind, rel });
}

/**
 * Stream a voice clip from the local `Ptt` cache, decoded to WAV. `rel` is the
 * path relative to the Ptt root (`<month>/Ori/<name>`); the main process
 * re-validates it and decodes the SILK bytes before streaming playable audio.
 */
export function localVoiceUrl(rel: string): string {
  return mediaUrl('localvoice', { rel });
}
