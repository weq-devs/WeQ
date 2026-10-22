import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const root = new URL('..', import.meta.url);
function tracked(...paths) {
  return execFileSync('git', ['ls-files', '--cached', '-z', '--', ...paths], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

test('原仓库不再跟踪已独立的 iOS 和 Android 手机源码', () => {
  assert.deepEqual(tracked('apps/ios', 'apps/android'), []);
});

test('移除手机壳时保留电脑 Remote、网络入口和 Web 构建', () => {
  const paths = [
    'apps/desktop/src/main/ipc/routers/remote.ts',
    'apps/desktop/src/main/remote/http.ts',
    'apps/desktop/src/main/remote/pairing.ts',
    'apps/desktop/src/main/remote/runtime.ts',
    'apps/web/vite.config.ts',
    'tools/remote-network/main.go',
  ];
  assert.deepEqual(tracked(...paths).sort(), paths.sort());
});

test('提交的维护入口不再链接已移走的手机 README', () => {
  const prototype = execFileSync(
    'git',
    ['show', ':docs/develop/weq-remote-prototype-20261022.md'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.doesNotMatch(prototype, /\.\.\/\.\.\/apps\/(?:ios|android)\//);
  assert.match(prototype, /remote-repository-split-20261023\.md/);
  assert.deepEqual(tracked('docs/develop/remote-repository-split-20261023.md'), [
    'docs/develop/remote-repository-split-20261023.md',
  ]);
});
