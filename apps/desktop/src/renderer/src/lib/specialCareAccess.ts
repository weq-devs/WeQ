interface SpecialCareAccess {
  qqOnline: boolean;
  attachEnabled: boolean;
  ssoReady?: boolean;
  credentialsPending?: boolean;
}

export function specialCareBlocker(access: SpecialCareAccess | undefined): string | null {
  if (!access?.qqOnline) return 'QQ 未在线，特别关心未更新';
  if (!access.attachEnabled) return '完整功能未启用，特别关心未更新';
  if (!access.ssoReady)
    return access.credentialsPending ? '正在准备在线凭据…' : '在线凭据尚未就绪，特别关心未更新';
  return null;
}
