import * as timeFormat from '@weq/time';
/**
 * 设置 → 外部 RKEY 服务器.
 *
 * 让没有在线 QQ 进程的机器也能补全聊天媒体：通过外部 rkey 服务器（目前支持
 * NapCat 的 `/get_rkey_server` 接口）拉取 QQ 的媒体下载凭证。
 *
 * 全局配置：rkey 与账号权限关系不大，一份配置所有账号通用。可导入多份配置但
 * 同时只能启用一条（或都不启用）。下载图片/表情时优先用本机在线 QQ 自己获取的
 * rkey，本地不可用才回退到启用的外部服务器（见 service 侧 external_rkey.ts）。
 *
 * 后端契约（bootstrap router）：
 *   - getSettings               — 返回完整设置，含 externalRkey.servers / enabledServerId
 *   - saveExternalRkeyServer    — 新增/编辑（编辑时地址/token 变化会作废缓存 rkey）
 *   - deleteExternalRkeyServer  — 删除
 *   - setExternalRkeyEnabled    — 启用/停用（同时只启用一条）
 *   - testExternalRkeyServer    — 只探测连通性，不写缓存
 */

import '../../styles/settings-services.css';

/** unix 秒 → 「x 小时/分钟后过期」或「已过期」。 */
export function formatCacheExpiry(expiredTime: number | undefined): {
  text: string;
  expired: boolean;
} {
  if (expiredTime == null) return { text: '尚未拉取 rkey', expired: false };
  const at = expiredTime * 1000;
  const expired = at <= Date.now();
  if (!Number.isFinite(at) || expiredTime <= 0)
    return { text: '缓存 rkey 未提供有效到期时间，下次下载时重新检查', expired };
  return {
    text: `缓存 rkey ${timeFormat.formatDateTime(at)}（${expired ? '已过期，下次下载自动重拉' : timeFormat.formatRelativeTime(at)}）`,
    expired,
  };
}
