// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/ci-local.mjs', import.meta.url));
describe('本地 CI 的无 Rust 模式', () => {
  it('保留全部非 Rust 门禁，并从递归测试中排除 daemon', () => {
    const output = execFileSync(process.execPath, [script, '--no-daemon', '--list'], {
      encoding: 'utf8',
    });
    expect(output).toContain('pnpm lint');
    expect(output).toContain('pnpm format:check');
    expect(output).toContain('pnpm -r typecheck');
    expect(output).toContain("pnpm --filter '!@weq/daemon' -r");
    expect(output).toContain('test --maxWorkers=2 --minWorkers=1');
    expect(output).not.toContain('cargo test');
    expect(output).not.toContain('cargo clippy');
  });
  it('不让 --no-daemon 静默削掉显式要求的 full 构建步骤', () => {
    const output = execFileSync(process.execPath, [script, '--no-daemon', '--full', '--list'], {
      encoding: 'utf8',
    });
    expect(output).toContain('pnpm run build:daemon');
    expect(output).toContain('pnpm --filter @weq/web build');
    expect(output).toContain('pnpm --filter @weq/web test:dist');
  });
});
