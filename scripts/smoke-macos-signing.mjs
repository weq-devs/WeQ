import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { sign } from './sign-macos.mjs';
import { macSigningRequirement, verifyMacReleaseArchive } from './verify-macos-signing.mjs';

const run = promisify(execFile);
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const builderRequire = createRequire(require.resolve('electron-builder'));
const inheritedEntitlements = join(
  dirname(builderRequire.resolve('app-builder-lib')),
  '../templates/entitlements.mac.plist',
);

/** 只克隆 Electron 运行库及启动壳，不复制产品代码或原生业务模块，不验收 TCC。 */
export async function smokeMacSigning(source, keychain) {
  if (process.platform !== 'darwin' || !keychain) throw new Error('需要 macOS 和专用 CSC_KEYCHAIN');
  const root = await mkdtemp(join(tmpdir(), 'weq-electron-signing-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const previousMode = process.env.WEQ_MAC_SIGNING_MODE;
  process.env.WEQ_MAC_SIGNING_MODE = 'self-signed';
  const observations = [];
  try {
    for (const version of ['1.0.0', '1.1.0']) {
      const directory = join(root, version);
      const bundle = join(directory, 'weQ.app');
      const contents = join(bundle, 'Contents');
      const resources = join(contents, 'Resources');
      const executable = join(contents, 'MacOS/weQ');
      const receipt = join(directory, 'receipt.json');
      await mkdir(join(contents, 'MacOS'), { recursive: true });
      await mkdir(join(resources, 'app'), { recursive: true });
      await mkdir(join(directory, 'profile'));
      // APFS clone 复用本机 Electron；两份夹具峰值不复制整个产品或依赖环境。
      await run('/bin/cp', ['-c', join(source, 'Contents/MacOS/weQ'), executable]);
      await run('/bin/cp', [
        '-cR',
        join(source, 'Contents/Frameworks'),
        join(contents, 'Frameworks'),
      ]);
      await run('/bin/chmod', ['-R', 'u+w', bundle]);
      await writeFile(
        join(contents, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.weq.desktop</string>
<key>CFBundleExecutable</key><string>weQ</string>
<key>CFBundleName</key><string>weQ</string>
<key>CFBundleDisplayName</key><string>WeQ Signing Fixture</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>`,
      );
      await writeFile(
        join(resources, 'app/package.json'),
        JSON.stringify({ name: 'weq-signing-fixture', version, main: 'index.cjs' }),
      );
      await writeFile(
        join(resources, 'app/index.cjs'),
        `const {app}=require('electron');
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
app.disableHardwareAcceleration();
app.whenReady().then(()=>{require('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify({version:app.getVersion(),electron:process.versions.electron,executable:process.execPath}));app.quit();});`,
      );
      await sign({
        app: bundle,
        platform: 'darwin',
        keychain,
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        optionsForFile: (file) => ({
          hardenedRuntime: true,
          entitlements:
            file === bundle
              ? fileURLToPath(
                  new URL('../apps/desktop/build/entitlements.mac.plist', import.meta.url),
                )
              : inheritedEntitlements,
        }),
      });
      const { stdout, stderr } = await run('/usr/bin/codesign', [
        '-d',
        '-r-',
        '--verbose=4',
        bundle,
      ]);
      const details = stdout + stderr;
      const hash = /^CDHash=(.+)$/m.exec(details)?.[1];
      assert.ok(hash);
      await run('/usr/bin/codesign', ['--verify', '-R', `=${macSigningRequirement}`, bundle]);
      await run(executable, [], { env, timeout: 30_000 });
      const result = JSON.parse(await readFile(receipt, 'utf8'));
      assert.equal(result.version, version);
      assert.ok(result.electron);
      const archive = join(directory, 'update.zip');
      await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, archive], {
        timeout: 120_000,
      });
      await verifyMacReleaseArchive(archive);
      observations.push({ ...result, cdhash: hash, requirement: macSigningRequirement });
    }
    assert.notEqual(observations[0].cdhash, observations[1].cdhash);
    assert.equal(observations[0].requirement, observations[1].requirement);
    return { platform: process.platform, arch: process.arch, observations, tccVerified: false };
  } finally {
    if (previousMode === undefined) delete process.env.WEQ_MAC_SIGNING_MODE;
    else process.env.WEQ_MAC_SIGNING_MODE = previousMode;
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2])
      throw new Error(
        '用法：CSC_KEYCHAIN=<专用钥匙串> node scripts/smoke-macos-signing.mjs <现有 weQ.app>',
      );
    console.log(
      JSON.stringify(
        await smokeMacSigning(resolve(process.argv[2]), process.env.CSC_KEYCHAIN),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
