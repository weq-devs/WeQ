import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check-docs-submodule.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'weq-docs-pointer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'WeQ Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'WeQ Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (directory, ...args) =>
    execFileSync('git', ['-C', directory, ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const remote = join(root, 'remote.git');
  const source = join(root, 'source');
  const parent = join(root, 'parent');
  git(root, 'init', '--bare', remote);
  for (const directory of [source, parent]) git(root, 'init', '-b', 'main', directory);
  git(source, 'remote', 'add', 'origin', remote);
  const commit = (text) => {
    writeFileSync(join(source, 'README.md'), text);
    git(source, 'add', 'README.md');
    git(source, '-c', 'commit.gpgsign=false', 'commit', '-m', text);
    return git(source, 'rev-parse', 'HEAD');
  };
  const ancestor = commit('ancestor');
  const tip = commit('tip');
  git(source, 'push', 'origin', 'main');
  const unpublished = commit('unpublished');
  git(parent, 'config', '-f', '.gitmodules', 'submodule.docs.path', 'docs');
  git(parent, 'config', '-f', '.gitmodules', 'submodule.docs.url', remote);
  git(parent, 'add', '.gitmodules');
  const pointTo = (sha) => {
    git(parent, 'update-index', '--add', '--cacheinfo', `160000,${sha},docs`);
    git(parent, '-c', 'commit.gpgsign=false', 'commit', '-m', `docs ${sha}`);
  };
  const check = () => spawnSync(process.execPath, [script], { cwd: parent, encoding: 'utf8', env });
  return { ancestor, tip, unpublished, pointTo, check, git, parent, remote };
}

test('公开分支尖端和已发布历史提交都能在未初始化子模块时通过', (t) => {
  const repo = fixture(t);
  assert.ok(!repo.git(repo.parent, 'ls-remote', repo.remote).includes(repo.ancestor));
  for (const sha of [repo.tip, repo.ancestor]) {
    repo.pointTo(sha);
    const result = repo.check();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(sha));
  }
});

test('校验 HEAD 指针，不被暂存区中的另一个未发布指针影响', (t) => {
  const repo = fixture(t);
  repo.pointTo(repo.ancestor);
  repo.git(repo.parent, 'update-index', '--cacheinfo', `160000,${repo.unpublished},docs`);
  const result = repo.check();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(repo.ancestor));
  assert.equal(repo.git(repo.parent, 'rev-parse', ':docs'), repo.unpublished);
});

test('未推送的提交失败并给出具体指针和修复办法', (t) => {
  const repo = fixture(t);
  repo.pointTo(repo.unpublished);
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(repo.unpublished));
  assert.match(result.stderr, /无法从文档远端拉取/);
  assert.match(result.stderr, /先推送文档提交，或将主仓指针改为远端已有提交/);
});

test('远端不可用时不能冒充通过或断言一定是未推送', (t) => {
  const repo = fixture(t);
  repo.pointTo(repo.tip);
  rmSync(repo.remote, { recursive: true, force: true });
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /无法从文档远端拉取/);
  assert.match(result.stderr, /远端访问失败/);
});
