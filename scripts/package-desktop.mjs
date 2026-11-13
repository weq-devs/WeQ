import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseDesktopManifest } from './prepare-electron-builder-manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps/desktop');
const require = createRequire(join(desktop, 'package.json'));
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
const { load } = appBuilderRequire('js-yaml');

/** 本地与发布共用精简 manifest；临时 appDir 不替换开发目录中的 package.json。 */
export async function packageDesktop(args = process.argv.slice(2), env = process.env) {
  const pkg = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
  await mkdir(join(desktop, '.artifacts'), { recursive: true });
  const stage = await mkdtemp(join(desktop, '.artifacts/packaging-'));
  try {
    await writeFile(join(stage, 'package.json'), JSON.stringify(releaseDesktopManifest(pkg)));
    await symlink(
      join(desktop, 'node_modules'),
      join(stage, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const source = resolve(env.WEQ_DESKTOP_OUT ?? join(desktop, 'out'));
    // electron-builder 的 ASAR 过滤只接受 appDir 内文件；仅克隆构建产物，不复制源码或依赖树。
    await cp(source, join(stage, 'out'), { recursive: true, mode: constants.COPYFILE_FICLONE });
    const config = load(await readFile(join(desktop, 'electron-builder.yml'), 'utf8'));
    config.directories.app = stage;
    if (env.WEQ_PACKAGE_OUTPUT) config.directories.output = resolve(env.WEQ_PACKAGE_OUTPUT);
    config.npmRebuild = false;
    for (const section of [config, config.win, config.mac, config.linux]) {
      for (const resource of section?.extraResources ?? []) {
        if (resource.from.startsWith('out/')) resource.from = join(source, resource.from.slice(4));
        if (resource.to === 'remote-web' && env.WEQ_WEB_DIST)
          resource.from = join(resolve(env.WEQ_WEB_DIST), 'public');
      }
    }
    const configPath = join(stage, 'builder.json');
    await writeFile(configPath, JSON.stringify(config));
    const cli = join(dirname(require.resolve('electron-builder/package.json')), 'cli.js');
    const child = execFile(process.execPath, [cli, '--config', configPath, ...args], {
      cwd: desktop,
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`桌面打包退出：${code}`)),
      );
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await packageDesktop();
