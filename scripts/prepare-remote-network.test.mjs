import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareRemoteNetwork } from './prepare-remote-network.mjs';

test('编译本机架构并保留带空格路径，不启动节点或读取身份', () => {
  for (const [platform, arch, goos, goarch, binary] of [
    ['darwin', 'arm64', 'darwin', 'arm64', 'weq-remote-network'],
    ['darwin', 'x64', 'darwin', 'amd64', 'weq-remote-network'],
    ['win32', 'x64', 'windows', 'amd64', 'weq-remote-network.exe'],
  ]) {
    let calls = 0;
    const helper = prepareRemoteNetwork({
      repoDir: '/fixture/repo with spaces',
      platform,
      arch,
      build(command, args, options) {
        calls++;
        assert.equal(command, 'go');
        assert.deepEqual(args, [
          'build',
          '-p',
          '2',
          '-trimpath',
          '-o',
          `/fixture/repo with spaces/tools/remote-network/${binary}`,
          '.',
        ]);
        assert.equal(options.cwd, '/fixture/repo with spaces/tools/remote-network');
        assert.equal(options.env.GOOS, goos);
        assert.equal(options.env.GOARCH, goarch);
        assert.equal(options.env.CGO_ENABLED, '0');
        return { status: 0 };
      },
    });
    assert.equal(calls, 1);
    assert.ok(helper.endsWith(binary));
  }
});

test('缺失编译器、编译失败或不支持的架构均停止，不使用旧二进制冒充成功', () => {
  assert.throws(
    () => prepareRemoteNetwork({ build: () => ({ error: new Error('ENOENT') }) }),
    /无法运行 Go/,
  );
  assert.throws(() => prepareRemoteNetwork({ build: () => ({ status: 1 }) }), /构建失败/);
  assert.throws(
    () =>
      prepareRemoteNetwork({
        arch: 'ia32',
        build: () => {
          throw new Error('must not run');
        },
      }),
    /暂不支持/,
  );
});
