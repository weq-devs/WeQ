// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
describe('独立后台退出产品构建', () => {
  it('不再包含 Rust 工作区和构建命令，桌面包排除旧的本地可再生产物', () => {
    expect(existsSync(join(root, 'packages/daemon/package.json'))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts).not.toHaveProperty('build:daemon');
    expect(readFileSync(join(root, 'apps/desktop/electron-builder.yml'), 'utf8')).toContain(
      '"!daemon/**"',
    );
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      expect(readFileSync(join(root, file), 'utf8')).not.toMatch(/build:daemon|rust-toolchain/);
    }
  });
  it('桌面和 Web 启动入口不再调用旧后台启动器', () => {
    for (const file of ['apps/desktop/src/main/index.ts', 'apps/web/src/server/index.ts']) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source).not.toMatch(/ensureDaemonRunning|startReleaseMonitor|syncGuiAutostartIntent/);
      expect(source).toContain('assistantResourceServer.shutdown');
    }
  });
});
