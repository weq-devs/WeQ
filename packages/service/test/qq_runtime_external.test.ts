import { describe, expect, it, vi } from 'vitest';
import {
  createExternalQQRuntimeProbe,
  type QQExternalRuntimeSource,
} from '../src/qq_runtime_external';

function fixture() {
  const source: QQExternalRuntimeSource = {
    uin: '10001',
    uid: () => 'u_self',
    resolvePid: vi.fn(async () => 123),
    hasLease: vi.fn(() => true),
    hasNativeSession: vi.fn(async () => true),
    isCurrent: () => true,
    databaseReady: () => true,
    pushReady: () => false,
  };
  return {
    source,
    probe: createExternalQQRuntimeProbe(source),
    signal: new AbortController().signal,
  };
}

describe('外部 QQ 运行时适配', () => {
  it('只有账号租约和原生登记均有效时才发布 SSO 能力', async () => {
    const f = fixture();
    expect(await f.probe('10001', f.signal)).toMatchObject({
      pid: 123,
      account: { uin: '10001', uid: 'u_self' },
      capabilities: { sso: true, database: true, push: false },
    });
    f.source.hasLease = () => false;
    expect((await f.probe('10001', f.signal))?.capabilities.sso).toBe(false);
  });
  it('未解析 UID 仍保留只读数据源，但不伪造 UID 或 SSO 就绪', async () => {
    const f = fixture();
    f.source.uid = () => null;
    expect(await f.probe('10001', f.signal)).toMatchObject({
      account: { uin: '10001', uid: null },
      capabilities: { sso: false, database: true },
    });
  });
  it('探测期间切号、撤销租约或原生会话消失都不会发布旧凭据可用', async () => {
    const f = fixture();
    f.source.hasNativeSession = async () => {
      f.source.hasLease = () => false;
      return true;
    };
    expect((await f.probe('10001', f.signal))?.capabilities.sso).toBe(false);
    f.source.hasLease = () => true;
    f.source.hasNativeSession = async () => {
      f.source.isCurrent = () => false;
      return true;
    };
    await expect(f.probe('10001', f.signal)).rejects.toThrow(/切换/);
  });
  it('不探测其他账号或已取消的请求', async () => {
    const f = fixture();
    expect(await f.probe('10002', f.signal)).toBeNull();
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await f.probe('10001', cancelled.signal)).toBeNull();
    expect(f.source.resolvePid).not.toHaveBeenCalled();
  });
});
