/**
 * Linux NineBird 安装纯函数测试 —— 全部跑在临时 fixture 上，不碰真 QQ、
 * 不跑 sudo（安装/卸载的执行体留给手工验证）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STUB_MARKER,
  linuxAppDir,
  linuxLoaderShimContent,
  linuxOriginalMain,
  linuxPaths,
  linuxStubStatus,
} from '../src/linux/install';

let root: string;
let exe: string;

function appDirOf(): string {
  return join(root, 'resources', 'app');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'weq-linux-'));
  mkdirSync(appDirOf(), { recursive: true });
  exe = join(root, 'qq');
  writeFileSync(exe, '');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('linuxPaths', () => {
  it('从 QQ 可执行文件推导 resources/app 与 stub 路径', () => {
    const paths = linuxPaths(exe);
    expect(paths.appDir).toBe(appDirOf());
    expect(paths.loaderJs).toBe(join(appDirOf(), 'loadNineBird.js'));
    expect(linuxAppDir(exe)).toBe(appDirOf());
  });
});

describe('linuxStubStatus', () => {
  it('缺失', () => {
    expect(linuxStubStatus(linuxPaths(exe))).toEqual({ installed: false, fresh: false });
  });

  it('旧版自删 stub（无 marker）→ installed 但不 fresh', () => {
    writeFileSync(
      join(appDirOf(), 'loadNineBird.js'),
      "try { require('fs').unlinkSync(__filename); } catch (e) {}\nrequire('/weq/loader.js');\n",
    );
    expect(linuxStubStatus(linuxPaths(exe))).toEqual({ installed: true, fresh: false });
  });

  it('持久版 stub（带 marker）→ installed 且 fresh', () => {
    writeFileSync(join(appDirOf(), 'loadNineBird.js'), `${STUB_MARKER}\nrequire('x');\n`);
    expect(linuxStubStatus(linuxPaths(exe))).toEqual({ installed: true, fresh: true });
  });
});

describe('linuxLoaderShimContent', () => {
  it('持久版：不自删、按 NINEBIRD_* 环境变量分支、loader 走 NINEBIRD_LOAD_PATH', () => {
    const shim = linuxLoaderShimContent('/weq/runtime/qr-dbkey.js', null);
    expect(shim).toContain(STUB_MARKER);
    expect(shim).not.toContain('unlinkSync');
    expect(shim).toContain('NINEBIRD_PIPE_NAME');
    expect(shim).toContain('NINEBIRD_LOAD_PATH');
    expect(shim).toContain('/weq/runtime/qr-dbkey.js');
  });

  it('提供原版 main 时生成「原版启动器」else 分支', () => {
    const main = '/opt/QQ/resources/app/application.asar/app_launcher/index.js';
    const shim = linuxLoaderShimContent('/w/qr.js', main);
    expect(shim).toContain(main);
    expect(shim).toContain('original launcher');
  });
});

describe('linuxOriginalMain', () => {
  it('读取 package.json main 并绝对化', () => {
    writeFileSync(
      join(appDirOf(), 'package.json'),
      JSON.stringify({ main: './application.asar/app_launcher/index.js' }),
    );
    expect(linuxOriginalMain(appDirOf())).toBe(
      join(appDirOf(), 'application.asar', 'app_launcher', 'index.js'),
    );
  });

  it('package.json 缺失返回 null', () => {
    expect(linuxOriginalMain(appDirOf())).toBeNull();
  });

  it('main 不是字符串返回 null', () => {
    writeFileSync(join(appDirOf(), 'package.json'), JSON.stringify({ main: 42 }));
    expect(linuxOriginalMain(appDirOf())).toBeNull();
  });
});
