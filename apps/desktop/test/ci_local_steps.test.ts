// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/ci-local.mjs', import.meta.url));
describe('不再构建独立 daemon 的本地 CI', () => {
  it('保留全部 TypeScript 工作区门禁，旧参数不改变验证范围', () => {
    const output = execFileSync(process.execPath, [script, '--no-daemon', '--list'], {
      encoding: 'utf8',
    });
    expect(output).toContain('pnpm lint');
    expect(output).toContain('pnpm format:check');
    expect(output).toContain('pnpm -r typecheck');
    expect(output).toContain('pnpm -r --workspace-concurrency=2');
    expect(output).toContain('test --maxWorkers=2 --minWorkers=1');
    expect(output).not.toContain('cargo test');
    expect(output).not.toContain('cargo clippy');
  });
  it('完整模式保留 Web 构建和冒烟，不再依赖 Rust 后台产物', () => {
    const output = execFileSync(process.execPath, [script, '--no-daemon', '--full', '--list'], {
      encoding: 'utf8',
    });
    expect(output).not.toContain('pnpm run build:daemon');
    expect(output).toContain('pnpm --filter @weq/web build');
    expect(output).toContain('pnpm --filter @weq/web test:dist');
  });
});
