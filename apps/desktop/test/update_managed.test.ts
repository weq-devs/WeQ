// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  installRoot,
  isPackageManaged,
  managedUpdateHint,
  PACKAGE_MANAGED_ENV,
  PACKAGE_MANAGED_MARKER,
} from '../src/main/update/managed';

function probe(overrides: {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  existing?: readonly string[];
}): Parameters<typeof isPackageManaged>[0] {
  const existing = new Set(overrides.existing ?? []);
  return {
    env: overrides.env ?? {},
    execPath: overrides.execPath ?? '/opt/weq/@weqdesktop',
    exists: (path) => existing.has(path),
  };
}

describe('包管理器托管判定', () => {
  it('包装脚本导出的环境变量优先', () => {
    expect(isPackageManaged(probe({ env: { [PACKAGE_MANAGED_ENV]: '1' } }), 'linux')).toBe(true);
  });

  it('环境变量不是 1 时不算托管', () => {
    expect(isPackageManaged(probe({ env: { [PACKAGE_MANAGED_ENV]: '0' } }), 'linux')).toBe(false);
  });

  it('直接执行安装目录里的二进制时靠标记文件识别', () => {
    expect(
      isPackageManaged(
        probe({
          execPath: '/opt/weq/@weqdesktop',
          existing: [`/opt/weq/${PACKAGE_MANAGED_MARKER}`],
        }),
        'linux',
      ),
    ).toBe(true);
  });

  it('标记文件只在可执行文件所在目录生效', () => {
    expect(
      isPackageManaged(
        probe({
          execPath: '/opt/weq/@weqdesktop',
          existing: [`/home/user/${PACKAGE_MANAGED_MARKER}`],
        }),
        'linux',
      ),
    ).toBe(false);
  });

  it('非 Linux 平台一律不托管', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      expect(
        isPackageManaged(
          probe({
            env: { [PACKAGE_MANAGED_ENV]: '1' },
            existing: [`/opt/weq/${PACKAGE_MANAGED_MARKER}`],
          }),
          platform,
        ),
      ).toBe(false);
    }
  });

  it('相对路径或根目录下的二进制不冒充安装根', () => {
    expect(installRoot('@weqdesktop')).toBeNull();
    expect(installRoot('/@weqdesktop')).toBeNull();
    expect(installRoot('/opt/weq/@weqdesktop')).toBe('/opt/weq');
    expect(installRoot('  /opt/weq/@weqdesktop  ')).toBe('/opt/weq');
  });

  it('更新提示只在托管时给出命令', () => {
    expect(managedUpdateHint(false)).toBeNull();
    expect(managedUpdateHint(true)).toContain('paru -Syu');
  });
});
