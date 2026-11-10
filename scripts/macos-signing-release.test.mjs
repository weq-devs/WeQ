import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createMacSigningIdentity } from './create-macos-signing-identity.mjs';
import { prepareMacSigning, parseKeychainSearchList } from './prepare-macos-signing.mjs';

const run = promisify(execFile);
const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve('electron-builder'));
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { load } = libraryRequire('js-yaml');

test('解析 security 搜索列表时去掉引号并保留顺序', () => {
  assert.deepEqual(
    parseKeychainSearchList(
      '    "/Users/runner/Library/Keychains/login.keychain-db"\n' +
        '    "/Users/runner/work/_temp/weq-release-signing-x/signing.keychain-db"\n',
    ),
    [
      '/Users/runner/Library/Keychains/login.keychain-db',
      '/Users/runner/work/_temp/weq-release-signing-x/signing.keychain-db',
    ],
  );
  assert.deepEqual(parseKeychainSearchList('\n'), []);
});

test('实际 electron-builder 25 加载器可以解析含固定证书校验的 ESM 签名钩子', async () => {
  const { resolveFunction } = libraryRequire('app-builder-lib/out/util/resolve');
  const hook = await resolveFunction(
    'module',
    fileURLToPath(new URL('./sign-macos.mjs', import.meta.url)),
    'sign',
  );
  assert.equal(typeof hook, 'function');
});

test('两个 macOS release job 显式准备固定身份、校验 ZIP，并总是清理钥匙串', async () => {
  const workflow = load(
    await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );
  for (const arch of ['x64', 'arm64']) {
    const steps = workflow.jobs[`macos-${arch}`].steps;
    const prepare = steps.findIndex(
      (step) => step.run === 'node scripts/prepare-macos-signing.mjs',
    );
    const pack = steps.findIndex((step) => step.run?.includes(`electron-builder --mac --${arch}`));
    const verify = steps.findIndex((step) =>
      step.run?.startsWith('node scripts/verify-macos-signing.mjs'),
    );
    assert.ok(prepare >= 0 && prepare < pack && pack < verify);
    assert.equal(steps[prepare].env.CSC_LINK, `\${{ secrets.CSC_LINK }}`);
    assert.equal(steps[prepare].env.CSC_KEY_PASSWORD, `\${{ secrets.CSC_KEY_PASSWORD }}`);
    assert.equal(steps[pack].env.WEQ_MAC_SIGNING_MODE, 'self-signed');
    assert.equal(steps[pack].env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
    assert.equal(
      steps.find((step) => step.run === 'node scripts/prepare-macos-signing.mjs --cleanup')?.if,
      'always()',
    );
  }
});

test('缺失正式签名 secret 时立即拒绝，不创建钥匙串', {
  skip: process.platform !== 'darwin',
}, async () => {
  await assert.rejects(prepareMacSigning({}), /缺少/);
});

test('错误密码和错误证书均中止且清理 CI 凭据，不在异常中输出密码或 P12', {
  skip: process.platform !== 'darwin',
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'weq-ci-signing-'));
  const searchBefore = (await run('/usr/bin/security', ['list-keychains', '-d', 'user'])).stdout;
  const identity = await createMacSigningIdentity(join(root, 'identity'));
  t.after(async () => {
    await run('/usr/bin/security', [
      'delete-keychain',
      join(identity.directory, 'signing.keychain-db'),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  const p12 = (await readFile(join(identity.directory, 'identity.p12'))).toString('base64');
  const password = await readFile(join(identity.directory, 'password'), 'utf8');
  const githubEnv = join(root, 'github-env');
  await writeFile(githubEnv, '');
  for (const secret of ['synthetic-wrong-password', password]) {
    await assert.rejects(
      prepareMacSigning({
        CSC_LINK: p12,
        CSC_KEY_PASSWORD: secret,
        RUNNER_TEMP: root,
        GITHUB_ENV: githubEnv,
      }),
      (error) => {
        assert.match(error.message, /准备失败/);
        assert.ok(!error.message.includes(secret) && !error.message.includes(p12));
        return true;
      },
    );
    assert.equal(await readFile(githubEnv, 'utf8'), '');
    assert.ok(!(await readdir(root)).some((name) => name.startsWith('weq-release-signing-')));
  }
  assert.equal(
    (await run('/usr/bin/security', ['list-keychains', '-d', 'user'])).stdout,
    searchBefore,
  );
});
