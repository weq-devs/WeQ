import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTHORIZATION_PROTOCOL,
  AUTHORIZATION_TARGETS,
  authorizationExecutable,
} from '../packages/native/authorization.mjs';
import {
  packagedAuthorizationPath,
  verifyAuthorizationHelper,
  verifyPackagedAuthorization,
} from './check-authorization-helper.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const platform = `${process.platform}-${process.arch}`;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'weq-authorization-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assets = join(directory, 'assets');
  const install = join(directory, 'install');
  await mkdir(assets);
  await mkdir(install);
  const buildTime = Math.floor(Date.now() / 1000) - 10;
  const bytes = Buffer.from('synthetic artifact, not executable code');
  const meta = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  const info = {
    protocol: AUTHORIZATION_PROTOCOL,
    target: AUTHORIZATION_TARGETS[platform],
    buildTime,
    expireTime: buildTime + 3600,
    validitySecs: 3600,
    isDev: false,
    capabilities: ['attach', 'key-scan', 'capture'],
  };
  const asset = `weq-authorization-helper-${platform}${process.platform === 'win32' ? '.exe' : ''}`;
  const manifest = {
    tag: 'nt-helper-fixture',
    commit: 'a'.repeat(40),
    buildTime: new Date(buildTime * 1000).toISOString(),
    expiresAt: new Date(info.expireTime * 1000).toISOString(),
    platforms: { [platform]: { ...meta, asset: `nt_helper-${platform}.node` } },
    authorization: { [platform]: { ...meta, ...info, asset } },
  };
  await writeFile(join(assets, asset), bytes);
  await writeFile(join(assets, `nt_helper-${platform}.node`), bytes);
  await writeFile(join(assets, 'manifest.json'), JSON.stringify(manifest));
  return { assets, install, manifest, asset, bytes };
}
function fetch(data, extra = []) {
  return spawnSync(
    process.execPath,
    [
      join(root, 'scripts/fetch-native.mjs'),
      '--from-dir',
      data.assets,
      '--root',
      data.install,
      '--platform',
      platform,
      '--no-dress',
      ...extra,
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
}

test('离线整套校验后安装，并记录助手元数据与执行权限', async (t) => {
  const data = await fixture(t);
  const result = fetch(data, ['--require-authorization']);
  assert.equal(result.status, 0, result.stderr);
  const marker = JSON.parse(await readFile(join(data.install, 'native/.installed.json'), 'utf8'));
  assert.equal(marker.authorization[platform].protocol, AUTHORIZATION_PROTOCOL);
  const helper = join(
    data.install,
    'native',
    ...platform.split('-'),
    authorizationExecutable(platform),
  );
  assert.deepEqual(await readFile(helper), data.bytes);
  const pin = { tag: data.manifest.tag };
  await writeFile(join(data.install, 'native/pinned.json'), JSON.stringify(pin));
  assert.equal(fetch(data, ['--require-authorization', '--check']).status, 0);
  assert.notEqual(fetch(data, ['--require-authorization', '--check', '--verify']).status, 0);
  marker.files = marker.files.filter((entry) => !entry.path.includes('weq-authorization-helper'));
  await writeFile(join(data.install, 'native/.installed.json'), JSON.stringify(marker));
  assert.notEqual(fetch(data, ['--require-authorization', '--check']).status, 0);
});

test('助手损坏时不先替换 .node；验证失败不写版本锚点', async (t) => {
  const data = await fixture(t);
  const native = join(data.install, 'native', ...platform.split('-'));
  await mkdir(native, { recursive: true });
  const addon = join(native, 'nt_helper.node');
  await writeFile(addon, 'keep original');
  await writeFile(join(data.assets, data.asset), Buffer.alloc(data.bytes.length, 0));
  assert.notEqual(fetch(data, ['--require-authorization']).status, 0);
  assert.equal(await readFile(addon, 'utf8'), 'keep original');
  await writeFile(join(data.assets, data.asset), data.bytes);
  assert.notEqual(fetch(data, ['--require-authorization', '--verify', '--write-pin']).status, 0);
  await assert.rejects(readFile(join(data.install, 'native/pinned.json')));
});

test('旧清单兼容开发，但不能通过桌面 release；Web 可不取助手', async (t) => {
  const data = await fixture(t);
  delete data.manifest.authorization;
  await writeFile(join(data.assets, 'manifest.json'), JSON.stringify(data.manifest));
  assert.equal(fetch(data).status, 0);
  assert.notEqual(fetch(data, ['--require-authorization']).status, 0);
  assert.equal(fetch(data, ['--no-authorization']).status, 0);
  assert.notEqual(fetch(data, ['--require-authorization', '--no-authorization']).status, 0);
});

test('打包位置覆盖五平台，缺件、链接及无执行权限在运行前拒绝', async (t) => {
  for (const name of Object.keys(AUTHORIZATION_TARGETS)) {
    const [os, arch] = name.split('-');
    const expected = join(
      '/fixture',
      ...(os === 'darwin' ? ['Contents', 'Resources'] : []),
      'native',
      os,
      arch,
      authorizationExecutable(name),
    );
    assert.equal(packagedAuthorizationPath('/fixture', name), expected);
  }
  const data = await fixture(t);
  assert.throws(() =>
    verifyPackagedAuthorization(data.install, platform, {
      required: true,
      manifest: data.manifest,
    }),
  );
  const ordinary = join(data.install, 'not-executable');
  await writeFile(ordinary, data.bytes);
  if (process.platform !== 'win32') {
    await chmod(ordinary, 0o600);
    assert.throws(() => verifyAuthorizationHelper(ordinary, platform));
    const link = join(data.install, 'linked-helper');
    await symlink(ordinary, link);
    assert.throws(() => verifyAuthorizationHelper(link, platform));
  }
});

test('桌面五个平台强制助手，Web 不取助手，打包前后均有门禁', async () => {
  const workflow = await readFile(join(root, '.github/workflows/release.yml'), 'utf8');
  assert.equal(
    (workflow.match(/fetch-native\.mjs --require-fresh --require-authorization --verify/g) ?? [])
      .length,
    5,
  );
  assert.equal(
    (workflow.match(/fetch-native\.mjs --require-fresh --no-authorization --verify/g) ?? []).length,
    1,
  );
  assert.match(workflow, /WEQ_REQUIRE_AUTHORIZATION_HELPER: '1'/);
  assert.match(
    await readFile(join(root, 'scripts/trim-desktop-package.mjs'), 'utf8'),
    /verifyDesktopAuthorization\(context, true\)/,
  );
  assert.match(
    await readFile(join(root, 'apps/desktop/electron-builder.yml'), 'utf8'),
    /afterSign: ..\/..\/scripts\/verify-desktop-authorization.mjs/,
  );
  assert.match(
    await readFile(join(root, 'scripts/verify-desktop-authorization.mjs'), 'utf8'),
    /verifyDesktopAuthorization\(context\)/,
  );
  assert.doesNotMatch(await readFile(join(root, 'scripts/sign-macos.mjs'), 'utf8'), /options.arch/);
});
