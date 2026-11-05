import { describe, expect, it } from 'vitest';
import { authorizationFailure, unwrapIpcError } from '../src/renderer/src/lib/authorizationError';

describe('unwrapIpcError', () => {
  it('剥掉 Electron IPC 包装，只留助手原文', () => {
    expect(
      unwrapIpcError(
        "Error invoking remote method 'authorization:install': Error: installation directory is not system-protected: /opt",
      ),
    ).toBe('installation directory is not system-protected: /opt');
  });

  it('没有包装时原样返回并去掉首尾空白', () => {
    expect(unwrapIpcError('  已取消长期授权操作 \n')).toBe('已取消长期授权操作');
    expect(
      unwrapIpcError(
        "Error invoking remote method 'authorization:remove': Error: 已取消长期授权操作",
      ),
    ).toBe('已取消长期授权操作');
  });
});

describe('authorizationFailure', () => {
  it('安装目录不受系统保护时给出可复制的 chown 命令，并保留原始报错', () => {
    const failure = authorizationFailure(
      "Error invoking remote method 'authorization:install': Error: installation directory is not system-protected: /opt",
    );
    expect(failure.needsUserAction).toBe(true);
    expect(failure.message).toContain('sudo chown root:root /opt');
    expect(failure.message).toContain('「启用长期授权」');
    // 用户 / Issue 排查需要原始英文，不能被吞掉。
    expect(failure.message).toContain(
      '原始报错：installation directory is not system-protected: /opt',
    );
    // 正式通道不应出现开发通道的免责声明。
    expect(failure.message).not.toContain('weq-authorization-dev');
  });

  it('路径取自报错本身，不硬编码 /opt', () => {
    const failure = authorizationFailure(
      'installation directory is not system-protected: /Library/PrivilegedHelperTools',
    );
    expect(failure.message).toContain('sudo chown root:root /Library/PrivilegedHelperTools');
    expect(failure.message).not.toContain('sudo chown root:root /opt\n');
  });

  it('开发通道额外说明不碰正式版目录', () => {
    const failure = authorizationFailure('installation directory is not system-protected: /opt', {
      development: true,
    });
    expect(failure.message).toContain('不碰正式版的 /opt/weq-authorization');
  });

  it('无 systemd 时说明长期授权不可用但临时授权仍在', () => {
    const failure = authorizationFailure('long-term authorization requires systemd');
    expect(failure.needsUserAction).toBe(true);
    expect(failure.message).toContain('临时授权不受影响');
  });

  it('忘记管理员批准 / 另一个安装进行中 都给出下一步', () => {
    expect(authorizationFailure('administrator authorization required').message).toContain(
      '系统授权窗口',
    );
    const busy = authorizationFailure('another authorization installation is in progress');
    expect(busy.needsUserAction).toBe(false);
    expect(busy.message).toContain('重新打开 WeQ');
  });

  it('撤销操作的中文文案按撤销后果给建议', () => {
    const failure = authorizationFailure('installation directory is not system-protected: /opt', {
      operation: 'remove',
    });
    expect(failure.message).toContain('「撤销授权」');
    expect(failure.message).not.toContain('「启用长期授权」');
    expect(
      authorizationFailure('synthetic unknown failure', { operation: 'remove' }).message,
    ).toContain('撤销长期授权失败');
  });

  it('用户主动取消不套多余前缀', () => {
    const failure = authorizationFailure('已取消长期授权操作');
    expect(failure).toEqual({ message: '已取消长期授权操作', needsUserAction: false });
  });

  it('不认识的报错原样附带，不吞信息', () => {
    const failure = authorizationFailure('some future helper failure');
    expect(failure.needsUserAction).toBe(false);
    expect(failure.message).toBe('启用长期授权失败：some future helper failure');
  });
});
