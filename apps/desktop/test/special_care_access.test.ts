import { describe, expect, it } from 'vitest';
import { specialCareBlocker } from '../src/renderer/src/lib/specialCareAccess';

describe('特别关心在线前置状态', () => {
  const ready = { qqOnline: true, attachEnabled: true, ssoReady: true };

  it('配置已在线但原生尚未登记时不允许查询，就绪后自动放行', () => {
    expect(specialCareBlocker({ ...ready, ssoReady: false, credentialsPending: true })).toBe(
      '正在准备在线凭据…',
    );
    expect(specialCareBlocker({ ...ready, ssoReady: false })).not.toBeNull();
    expect(specialCareBlocker({ ...ready, ssoReady: undefined })).not.toBeNull();
    expect(specialCareBlocker(ready)).toBeNull();
  });

  it('状态未知、离线或完整模式关闭时不依赖残留的就绪标记', () => {
    expect(specialCareBlocker(undefined)).not.toBeNull();
    expect(specialCareBlocker({ ...ready, qqOnline: false })).toContain('QQ 未在线');
    expect(specialCareBlocker({ ...ready, attachEnabled: false })).toContain('完整功能未启用');
  });
});
