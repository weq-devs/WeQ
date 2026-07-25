/**
 * SC 快更新(scupdate)—— 个性装扮资源(气泡 / 字体)的下载地址获取。
 *
 * 这是 QQ 会员装扮资源的分发链路,原本是手Q(mobileqq)独有功能。桌面 NTQQ 通过
 * `sendPacket` 发同样的 SSO 包同样被服务端受理,只需在 `comm.plat` 里填 109
 * (Android QQ)。
 *
 *   item_id → scid(本地拼) → GetUrl(问服务端) → CDN 外链 → 直接 GET
 *
 * 地址里的 UUID 由服务端生成,本地推导不出,所以中间那步换取无法省略。但换回来的
 * 地址是公开的:鉴权只发生在换取请求(靠 QQ 进程的登录态),拿到 url 后无需任何 cookie。
 *
 *   schemas.ts   — protobuf 结构 + bid/storage_mode 等常量(字段号取自 apk)
 *   scid.ts      — scid 拼装/解析(纯字符串逻辑)
 *   session.ts   — comm 组装 + 响应状态检查
 *   get-url.ts   — cmd=2 GetUrl,scid → 下载地址
 *   sync-list.ts — cmd=1 SyncVCR,拉服务端资源清单(不必猜 item_id)
 *   resources.ts — 按 item_id 取资源的高层入口
 */

export {
  SCUPDATE_CMD,
  ScUpdateOp,
  VasBid,
  STORAGE_MODE_FILE,
  CODE_NOT_FOUND,
  PLAT_ANDROID_QQ,
  QVER_ANDROID,
} from './schemas';

export {
  BUBBLE_PARTS,
  FONT_FAMILIES,
  bubbleScid,
  bubbleScids,
  fontScid,
  bidFromScid,
  scanScids,
} from './scid';
export type { BubblePart, FontFamily } from './scid';

export { buildReqComm, readRspStatus, ScUpdateError } from './session';
export type { ScUpdateClient, ScUpdateStatus } from './session';

export { getResourceUrl, getResourceUrls, getUrlsByScid, isDownloadable } from './get-url';
export type { ResourceUrl, ScidRef } from './get-url';

export { syncResourceList } from './sync-list';
export type { ResourceListing } from './sync-list';

export { getBubbleResources, getFontResource } from './resources';
export type { BubbleResources } from './resources';
