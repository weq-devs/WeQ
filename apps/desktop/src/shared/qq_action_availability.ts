type QqAction = 'sendTuwenArk' | 'sendGroupSignup' | 'setGroupAdminPermissions';

export const qqActionUnavailable: Readonly<Partial<Record<QqAction, string>>> = {
  sendTuwenArk: 'QQ 暂不支持从 WeQ 发送图文 Ark 卡片。',
  sendGroupSignup: 'QQ 暂不支持从 WeQ 发送群报名卡片。',
  setGroupAdminPermissions: 'QQ 暂不支持从 WeQ 修改指定管理员的撤回和踢人权限。',
};
