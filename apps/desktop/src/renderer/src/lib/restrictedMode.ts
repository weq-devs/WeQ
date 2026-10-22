export interface OnlineAccess {
  qqOnline: boolean;
  attachEnabled: boolean;
  hasA2: boolean;
  hasD2: boolean;
  hasD2Key: boolean;
  hasGuid: boolean;
}

export interface Restriction {
  code: 'offline' | 'disabled' | 'sip' | 'credentials' | 'checking' | 'authorization';
  title: string;
  guidance: string;
}

/** 只依据已确认的能力判断；没有密码请求不等于需要提权。 */
export function restrictionReasons(input: {
  access?: OnlineAccess;
  sipEnabled?: boolean | null;
  failed?: boolean;
}): Restriction[] {
  if (!input.access)
    return input.failed
      ? [{ code: 'checking', title: '状态检查失败', guidance: '请重新检查 QQ 与在线功能状态。' }]
      : [];
  const access = input.access;
  const reasons: Restriction[] = [];
  if (!access.qqOnline)
    reasons.push({
      code: 'offline',
      title: 'QQ 不在线',
      guidance: '请在本机 QQ 登录当前账号，登录后会自动重新检查。',
    });
  if (!access.attachEnabled)
    reasons.push({
      code: 'disabled',
      title: '完全离线模式',
      guidance: '自动读取 QQ 内存已关闭。可启用完整功能后重新读取。',
    });
  const sessionReady = access.hasA2 && access.hasD2 && access.hasD2Key;
  const ready = sessionReady && access.hasGuid;
  if (access.qqOnline && access.attachEnabled && !ready) {
    if (input.sipEnabled === true && !sessionReady)
      reasons.push({
        code: 'sip',
        title: 'SIP 未关闭',
        guidance:
          'macOS 系统完整性保护阻止读取 QQ 内存，管理员密码无法绕过。可使用扫码登录；如选择关闭 SIP，需进入恢复模式操作，这会降低系统安全性。',
      });
    else
      reasons.push({
        code: 'credentials',
        title: '会话凭据不完整',
        guidance:
          '在线功能所需的会话凭据或设备身份尚未就绪。请确认 QQ 已登录后重新读取，或使用扫码登录。',
      });
  }
  if (input.failed)
    reasons.push({
      code: 'checking',
      title: '状态检查失败',
      guidance: '暂时无法确认最新状态，请重新检查。',
    });
  return reasons;
}

export function restrictedActionTitle(action: string): string {
  return `受限模式下无法${action}`;
}
