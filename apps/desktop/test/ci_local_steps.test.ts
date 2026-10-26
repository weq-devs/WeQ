// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/ci-local.mjs', import.meta.url));
const { scripts } = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };

it.each([
  ['test', ['--no-bail']],
  ['test:fail-fast', ['--bail=1']],
  ['test:changed', ['--changed', '--passWithNoTests', '--bail=1']],
] as const)('%s 有界并发且不因包依赖跳过下游单测', (name, flags) => {
  const args = scripts[name]!.split(' ');
  for (const flag of [
    '--no-sort',
    '--workspace-concurrency=2',
    '--maxWorkers=2',
    '--minWorkers=1',
    ...flags,
  ])
    expect(args, name).toContain(flag);
  if (name !== 'test:changed') expect(args).not.toContain('--passWithNoTests');
});

describe('不再构建独立 daemon 的本地 CI', () => {
  it('保留全部 TypeScript 工作区门禁，旧参数不改变验证范围', () => {
    const output = execFileSync(process.execPath, [script, '--no-daemon', '--list'], {
      encoding: 'utf8',
    });
    expect(output).toContain('pnpm lint');
    expect(output).toContain('pnpm format:check');
    expect(output).toContain('pnpm -r typecheck');
    expect(output).toContain('$ pnpm test ');
    expect(output).not.toContain('test:fail-fast');
    expect(output).not.toContain('cargo test');
    expect(output).not.toContain('cargo clippy');
  });
  it('失败即停模式同样让单测尽早退出，默认模式仍保留完整汇总', () => {
    const output = execFileSync(process.execPath, [script, '--fail-fast', '--list'], {
      encoding: 'utf8',
    });
    expect(output).toContain('$ pnpm test:fail-fast ');
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
