/**
 * macOS NineBird 安装器纯函数测试 —— 全部跑在临时 fixture 上，不碰真 QQ。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ORIGINAL_LOADERS,
  darwinPaths,
  getPatchStatus,
  hotUpdatePackageUrls,
  loaderMain,
  loaderShimContent,
  patchHotUpdatePackages,
  qqAppDir,
  restoreHotUpdatePackages,
} from '../src/darwin/install';

let root: string;
let exe: string;
const HOME = 'home';

function appDirOf(): string {
  return join(root, 'QQ.app', 'Contents', 'Resources', 'app');
}

function writePackage(main: string, extra: Record<string, unknown> = {}): void {
  const dir = appDirOf();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ main, ...extra }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'weq-darwin-'));
  mkdirSync(join(root, 'QQ.app', 'Contents', 'MacOS'), { recursive: true });
  exe = join(root, 'QQ.app', 'Contents', 'MacOS', 'QQ');
  writeFileSync(exe, '');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('darwinPaths', () => {
  it('从 QQ 可执行文件推导 app 目录与容器部署路径', () => {
    const paths = darwinPaths(exe);
    expect(paths.appDir).toBe(appDirOf());
    expect(paths.packageJson).toBe(join(appDirOf(), 'package.json'));
    expect(paths.installDir).toContain('weq-ninebird');
    expect(paths.loaderJs).toBe(join(paths.installDir, 'loadNineBird.js'));
    expect(paths.nineBirdNode).toBe(join(paths.installDir, 'NineBird.node'));
  });

  it('qqAppDir 只上溯一层到 Contents', () => {
    expect(qqAppDir(exe)).toBe(appDirOf());
  });
});

describe('getPatchStatus', () => {
  it('原版入口', () => {
    writePackage('./application.asar/app_launcher/index.js');
    const status = getPatchStatus(darwinPaths(exe));
    expect(status.kind).toBe('original');
  });

  it('NineBird 入口（main 等于相对 loader 路径）', () => {
    const paths = darwinPaths(exe);
    writePackage(loaderMain(paths));
    const status = getPatchStatus(paths);
    expect(status.kind).toBe('ninebird');
  });

  it('自定义入口', () => {
    writePackage('./some/other/entry.js');
    const status = getPatchStatus(darwinPaths(exe));
    expect(status.kind).toBe('custom');
  });

  it('缺失 package.json', () => {
    const status = getPatchStatus(darwinPaths(exe));
    expect(status.kind).toBe('missing');
  });

  it('原版入口表与 QQ 当前版本一致', () => {
    expect(ORIGINAL_LOADERS).toContain('./application.asar/app_launcher/index.js');
    expect(ORIGINAL_LOADERS).toContain('./application/app_launcher/index.js');
    expect(ORIGINAL_LOADERS).toContain('./app_launcher/index.js');
  });
});

describe('loaderShimContent', () => {
  it('包含 --no-sandbox 分支、fallback loader 与原版启动器', () => {
    const paths = darwinPaths(exe);
    const shim = loaderShimContent(paths);
    expect(shim).toContain("process.argv.includes('--no-sandbox')");
    expect(shim).toContain('NINEBIRD_LOAD_PATH');
    expect(shim).toContain(join(paths.installDir, 'qr-dbkey.js'));
    expect(shim).toContain(join(paths.appDir, 'app_launcher', 'index.js'));
    expect(shim).toContain('global.launcher.installPathPkgJson.main');
  });
});

describe('热更新包', () => {
  function makeHotUpdate(version: string, main: string): void {
    const dir = join(
      root,
      HOME,
      'Library',
      'Containers',
      'com.tencent.qq',
      'Data',
      'Library',
      'Application Support',
      'QQ',
      'versions',
      version,
    );
    const appDir = join(dir, 'QQUpdate.app', 'Contents', 'Resources', 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ main, buildVersion: version }));
  }

  it('发现容器 versions 目录下的热更新包', () => {
    makeHotUpdate('52194', './application.asar/app_launcher/index.js');
    const paths = darwinPaths(exe, join(root, HOME));
    const urls = hotUpdatePackageUrls(paths);
    expect(urls).toHaveLength(1);
  });

  it('patch 指向 loader，restore 按 buildVersion 还原原版入口', () => {
    makeHotUpdate('52194', './application.asar/app_launcher/index.js');
    const paths = darwinPaths(exe, join(root, HOME));

    const patched = patchHotUpdatePackages(paths);
    expect(patched).toBe(1);
    const pkg = JSON.parse(readFileSync(hotUpdatePackageUrls(paths)[0]!, 'utf-8'));
    expect(pkg.main).toBe(loaderMain(paths));

    // 已是 loader 入口时不重复 patch。
    expect(patchHotUpdatePackages(paths)).toBe(0);

    const restored = restoreHotUpdatePackages(paths);
    expect(restored).toBe(1);
    const after = JSON.parse(readFileSync(hotUpdatePackageUrls(paths)[0]!, 'utf-8'));
    expect(after.main).toBe('./application.asar/app_launcher/index.js');
  });
});
