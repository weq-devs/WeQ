export interface OnlineAccess {
  source?: { expectedAccountUin: string; expectedAccountConfigId: string };
  qqOnline: boolean;
  qqPid?: number | null;
  attachEnabled: boolean;
  hasA2: boolean;
  hasD2: boolean;
  hasD2Key: boolean;
  hasGuid: boolean;
  hasUid?: boolean;
  needsMemoryRead?: boolean;
  ssoReady?: boolean;
  credentialsPending?: boolean;
  /** 需要用户处理的凭据原因（当前是长期授权助手需要修复）。 */
  credentialsIssue?: { title: string; message: string } | null;
}

export interface Restriction {
  code:
    | 'offline'
    | 'disabled'
    | 'sip'
    | 'credentials'
    | 'checking'
    | 'authorization'
    | 'data-access';
  title: string;
  guidance: string;
}

export function dataAccessRestriction(status?: string): Restriction[] {
  if (status !== 'denied' && status !== 'error') return [];
  return [
    {
      code: 'data-access',
      title: status === 'denied' ? 'QQ 数据读取受限' : 'QQ 数据读取检测失败',
      guidance: '',
    },
  ];
}

function offlineRestriction(sipEnabled?: boolean | null, hasCurrentAccount = true): Restriction {
  const account = hasCurrentAccount ? '当前账号' : '要使用的 QQ 账号';
  return {
    code: 'offline',
    title: hasCurrentAccount ? '当前账号未登录 QQ' : 'QQ 不在线',
    guidance:
      sipEnabled === true
        ? `请在 QQ 调试副本中登录${account}，登录后会自动重新检查。`
        : `请在本机 QQ 登录${account}，登录后会自动重新检查。`,
  };
}

/** 启动页未选账号，进程在运行与账号已登录是两项不同事实。 */
export function startupRestrictionReasons(input: {
  probe?: { count: number | null; runningCount?: number | null };
  sipEnabled?: boolean | null;
  dataStatus?: string;
  failed?: boolean;
}): Restriction[] {
  const reasons = dataAccessRestriction(input.dataStatus);
  if (input.failed || input.probe?.count === null) {
    reasons.push({
      code: 'checking',
      title: 'QQ 在线状态待确认',
      guidance: input.probe?.runningCount
        ? 'QQ 正在运行。请按提示处理读取权限，WeQ 会继续检查登录状态。'
        : '暂时无法读取 QQ 的登录状态，稍后会自动再试。',
    });
  } else if (input.probe?.count === 0) {
    reasons.push(offlineRestriction(input.sipEnabled, false));
  }
  return reasons;
}

/** 只依据已确认的能力判断；没有密码请求不等于需要提权。 */
export function restrictionReasons(input: {
  access?: OnlineAccess;
  sipEnabled?: boolean | null;
  failed?: boolean;
}): Restriction[] {
  if (!input.access)
    return input.failed
      ? [
          {
            code: 'checking',
            title: '状态检查失败',
            guidance: '稍后会自动检查 QQ 与在线功能状态。',
          },
        ]
      : [];
  const access = input.access;
  const reasons: Restriction[] = [];
  if (!access.qqOnline) reasons.push(offlineRestriction(input.sipEnabled));
  if (!access.attachEnabled)
    reasons.push({
      code: 'disabled',
      title: 'QQ 在线能力已关闭',
      guidance: '在「QQ 能力档位」选择在线模式或完整模式后可用。',
    });
  const sessionReady =
    access.hasA2 && access.hasD2 && access.hasD2Key && access.needsMemoryRead !== true;
  const ready =
    sessionReady && access.hasGuid && access.hasUid !== false && access.ssoReady !== false;
  if (access.qqOnline && access.attachEnabled && access.credentialsIssue)
    reasons.push({
      code: 'authorization',
      title: access.credentialsIssue.title,
      guidance: access.credentialsIssue.message,
    });
  else if (access.qqOnline && access.attachEnabled && !ready) {
    if (input.sipEnabled === true && !sessionReady && !access.credentialsPending)
      reasons.push({
        code: 'sip',
        title: 'QQ 调试读取尚未就绪',
        guidance: '请在 QQ 调试副本中登录当前账号，登录后会自动继续；也可使用扫码登录。',
      });
    else
      reasons.push({
        code: 'credentials',
        title: '会话凭据不完整',
        guidance:
          '在线功能所需的会话凭据或设备身份尚未就绪，后台会自动重试。请保持 QQ 登录；也可手动重试获取凭据或使用扫码登录。',
      });
  }
  if (input.failed)
    reasons.push({
      code: 'checking',
      title: '状态检查失败',
      guidance: '暂时无法确认最新状态，稍后会自动再试。',
    });
  return reasons;
}

export function restrictedActionTitle(action: string): string {
  return `在线能力受限，无法${action}`;
}
