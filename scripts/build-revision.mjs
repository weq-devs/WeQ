import { execFileSync } from 'node:child_process';

export function buildRevision(repoRoot) {
  let commit = null;
  try {
    commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // 源码压缩包构建没有 Git 历史，构建时间仍可用于关联日志。
  }
  return { commit, builtAt: new Date().toISOString() };
}
