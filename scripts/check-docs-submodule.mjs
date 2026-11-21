import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

try {
  const [target = 'HEAD', ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('用法：node scripts/check-docs-submodule.mjs [--staged|提交]');
  const tree =
    target === '--staged'
      ? git(root, 'write-tree')
      : git(root, 'rev-parse', '--verify', '--end-of-options', `${target}^{commit}`);
  const entry = git(root, 'ls-tree', tree, '--', 'docs');
  const sha = /^160000 commit ([a-f0-9]{40})\tdocs$/.exec(entry)?.[1];
  if (!sha) throw new Error(`主仓 ${target} 没有有效的 docs 子模块指针。`);
  const url = git(root, 'config', '--blob', `${tree}:.gitmodules`, 'submodule.docs.url');
  const temporary = mkdtempSync(join(tmpdir(), 'weq-docs-submodule-'));
  try {
    git(temporary, 'init', '--bare');
    // ls-remote 只列引用尖端；实际 fetch 才能覆盖已发布的历史提交和远端访问失败。
    git(temporary, 'fetch', '--no-tags', '--depth=1', '--no-recurse-submodules', url, sha);
    if (git(temporary, 'rev-parse', 'FETCH_HEAD') !== sha) {
      throw new Error('拉取结果与主仓记录的指针不一致。');
    }
  } catch (error) {
    throw new Error(
      `无法从文档远端拉取 docs @ ${sha}：提交尚未推送或远端访问失败。\n` +
        '先推送文档提交，或将主仓指针改为远端已有提交；访问失败时检查远端连接。\n' +
        (error.stderr?.toString().trim() || error.message),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`docs @ ${sha} 已确认可从远端拉取`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
