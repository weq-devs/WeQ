/**
 * 应用锁运行时状态的共享查询（左栏上锁按钮 / 锁屏遮罩 / 设置页共用）。
 *
 * 验证器绑定 / 解绑发生在设置弹窗里，而左栏上锁按钮独立读取「验证器是否已
 * 配置」。两处通过同一个 queryKey 关联：设置页在绑定 / 解绑后
 * invalidateQueries，左栏与锁屏的 useQuery 会自动重取，避免「绑定完成但
 * 按钮仍是灰色、重启才恢复」的过期状态。
 */

import { shellBridge } from './target';

export type TotpStatus = Awaited<ReturnType<typeof window.weq.totp.getStatus>>;
export type SystemAuthStatus = Awaited<ReturnType<typeof window.weq.systemAuth.getStatus>>;

export const TOTP_STATUS_QUERY_KEY = ['weq-shell', 'totp-status'] as const;
export const SYSTEM_AUTH_STATUS_QUERY_KEY = ['weq-shell', 'system-auth-status'] as const;

export async function fetchTotpStatus(): Promise<TotpStatus | null> {
  const b = shellBridge();
  if (!b) return null;
  return b.totp.getStatus();
}

export async function fetchSystemAuthStatus(): Promise<SystemAuthStatus | null> {
  const b = shellBridge();
  if (!b) return null;
  return b.systemAuth.getStatus();
}
