/**
 * SC 快更新(scupdate)—— 个性装扮资源(气泡 / 字体 / 头像挂件)的下载地址获取。
 *
 * 这是 QQ 会员装扮资源的分发链路。桌面 NTQQ 自己也发这套 SSO 包(`plat=111`),WeQ 因此
 * 默认就以桌面端身份发(见 `PC_QQ_CLIENT`),与真机报文对齐;手Q 身份只剩
 * `ANDROID_QQ_CLIENT`,留给批量抓取脚本复现历史行为。
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
  APP_ID_PC_QQ,
  SCUPDATE_CMD,
  ScUpdateOp,
  VasBid,
  STORAGE_MODE_FILE,
  CODE_NOT_FOUND,
  FROM_PC_DRESS,
  OSVER_PC_WINDOWS,
  PLAT_ANDROID_QQ,
  PLAT_PC_QQ,
  QVER_ANDROID,
} from './schemas';

export {
  BUBBLE_PARTS,
  FONT_FAMILIES,
  PENDANT_PARTS,
  SCID_OS_ANDROID,
  SCID_OS_IOS,
  bubbleScid,
  bubbleScids,
  fontScid,
  pendantScid,
  pendantScids,
  bidFromScid,
  scanScids,
} from './scid';
export type { BubblePart, FontFamily, PendantPart, ScidOs } from './scid';

export {
  ANDROID_QQ_CLIENT,
  PC_QQ_CLIENT,
  buildReqComm,
  readRspStatus,
  ScUpdateError,
} from './session';
export type { ScUpdateClient, ScUpdateStatus } from './session';

export {
  buildGetUrlRequest,
  getResourceUrl,
  getResourceUrls,
  getUrlsByScid,
  isDownloadable,
} from './get-url';
export type { ResourceUrl, ScidRef } from './get-url';

export { syncResourceList } from './sync-list';
export type { ResourceListing } from './sync-list';

export { getBubbleResources, getFontResource, getPendantResources } from './resources';
export type { BubbleResources, PendantResources } from './resources';
