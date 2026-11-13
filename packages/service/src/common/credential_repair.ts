/**
 * 长期授权助手存在，但当前版本/接口/有效期/运行通道与宿主不匹配。
 *
 * 这不是“没有助手”的临时回退场景：继续静默走 sudo 只会让界面一直停在
 * “正在启用完整功能”。自动 attach 应把原因交给监视器，由界面提示修复。
 */
export class CredentialRepairRequiredError extends Error {
  constructor(
    message: string,
    readonly reason = 'authorization-repair',
  ) {
    super(message);
    this.name = 'CredentialRepairRequiredError';
  }
}

/** 当前进程的调试签名不可读；后台可重试，但需要先切换到可调试的 QQ。 */
export class DebugReadUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DebugReadUnavailableError';
  }
}

/** 监视器向界面暴露的“凭据暂不可用且需要用户处理”的原因。 */
export interface OnlineCredentialIssue {
  title: string;
  message: string;
}
