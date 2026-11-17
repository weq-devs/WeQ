/**
 * Win32 path-resolution tests —— 重点覆盖 `nt_qq/global/nt_data/search/resource_jieba`
 * 这一共享词典路径（与账号目录 `<uin>/nt_qq/nt_data` 无关）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  candidateTencentFilesRoots,
  findJiebaDictDir,
  normalizeQqDataRoot,
  readUserDataInfo,
  tencentFilesRootFromUserDataInfo,
} from '../src/win32/paths';

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-win32-paths-'));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

describe('jieba dictionary (shared nt_qq/global tree)', () => {
  it('resolves <root>/nt_qq/global/nt_data/search/resource_jieba', () => {
    const root = tmpRoot();
    const dir = join(root, 'nt_qq', 'global', 'nt_data', 'search', 'resource_jieba');
    mkdirSync(dir, { recursive: true });
    expect(findJiebaDictDir(tmpRoot(), root)).toBe(dir);
  });

  it('returns null when QQ never downloaded the dictionary', () => {
    // home 也必须是空的临时目录：候选根里还有 `<home>/Documents/Tencent Files`
    // 和 `user_data_info` 里记的路径，拿真实 home 跑会扫到开发机自己的 QQ 数据。
    expect(findJiebaDictDir(tmpRoot(), tmpRoot())).toBeNull();
  });
});

describe('UserDataInfo.ini (UserDataSavePathType)', () => {
  /** 建一个隔离的 `<parent>/home` + `<parent>/Public/.../UserDataInfo.ini`。 */
  function homeWithIni(lines: string[]): string {
    const parent = tmpRoot();
    const home = join(parent, 'home');
    mkdirSync(home, { recursive: true });
    const iniDir = join(parent, 'Public', 'Documents', 'Tencent', 'QQ');
    mkdirSync(iniDir, { recursive: true });
    writeFileSync(join(iniDir, 'UserDataInfo.ini'), lines.join('\r\n'), 'utf-8');
    return home;
  }

  it('parses both keys, ignoring other sections', () => {
    const home = homeWithIni([
      '[UserDataImportSet]',
      'OldVerDataPath=D:\\legacy',
      '[UserDataSet]',
      'UserDataSavePathType=2',
      'UserDataSavePath=D:\\estkim\\Tencent Files',
    ]);
    expect(readUserDataInfo(home)).toEqual({
      savePathType: 2,
      savePath: 'D:\\estkim\\Tencent Files',
    });
  });

  it('returns null when the ini is missing', () => {
    expect(readUserDataInfo(tmpRoot())).toBeNull();
  });

  it('honors UserDataSavePath only for type=2', () => {
    const custom = homeWithIni([
      '[UserDataSet]',
      'UserDataSavePathType=2',
      'UserDataSavePath=D:\\x',
    ]);
    expect(tencentFilesRootFromUserDataInfo(custom)).toBe('D:\\x');

    // QQ 在其它 type 下直接忽略 savePath，但用户可能手改 ini 指回旧数据。
    for (const type of ['0', '1', '3', '9']) {
      const home = homeWithIni([
        '[UserDataSet]',
        `UserDataSavePathType=${type}`,
        'UserDataSavePath=D:\\x',
      ]);
      expect(tencentFilesRootFromUserDataInfo(home)).toBeNull();
      expect(candidateTencentFilesRoots(home)).toContain('D:\\x');
    }
  });

  it('maps type=1 to Documents/Tencent Files and everything else to Documents/QQ', () => {
    const typeOne = homeWithIni(['[UserDataSet]', 'UserDataSavePathType=1']);
    expect(candidateTencentFilesRoots(typeOne)[0]).toBe(
      join(typeOne, 'Documents', 'Tencent Files'),
    );

    // 0 / 3 / 未知 / 字段缺失 —— 旧版 NT 布局，即重装系统后仍保留历史记录的目录。
    for (const type of ['0', '3', '9']) {
      const home = homeWithIni(['[UserDataSet]', `UserDataSavePathType=${type}`]);
      expect(candidateTencentFilesRoots(home)[0]).toBe(join(home, 'Documents', 'QQ'));
    }
    const noType = homeWithIni(['[UserDataSet]', 'UserDataSavePath=D:\\x']);
    expect(candidateTencentFilesRoots(noType)[0]).toBe(join(noType, 'Documents', 'QQ'));
  });

  it('puts type=2 savePath first, ahead of every default location', () => {
    const home = homeWithIni([
      '[UserDataSet]',
      'UserDataSavePathType=2',
      'UserDataSavePath=D:\\estkim\\Tencent Files',
    ]);
    const roots = candidateTencentFilesRoots(home);
    expect(roots[0]).toBe('D:\\estkim\\Tencent Files');
    expect(roots).toContain(join(home, 'Documents', 'QQ'));
  });

  it('still lets an existing override win over the ini', () => {
    const home = homeWithIni([
      '[UserDataSet]',
      'UserDataSavePathType=2',
      'UserDataSavePath=D:\\estkim\\Tencent Files',
    ]);
    const override = join(home, 'picked');
    mkdirSync(override, { recursive: true });
    expect(candidateTencentFilesRoots(home, override)[0]).toBe(override);
  });
});

describe('normalizeQqDataRoot (picked data directory)', () => {
  it('accepts any folder name — no `Tencent Files` rule', () => {
    // 老版本 QQ 迁移过来的目录名往往五花八门，名字本身不该被校验。
    expect(normalizeQqDataRoot('D:\\QQData')).toBe('D:\\QQData');
    expect(normalizeQqDataRoot('E:\\备份\\QQ')).toBe('E:\\备份\\QQ');
    expect(normalizeQqDataRoot('D:\\Tencent Files')).toBe('D:\\Tencent Files');
  });

  it('strips trailing separators', () => {
    expect(normalizeQqDataRoot('D:\\QQData\\')).toBe('D:\\QQData');
    expect(normalizeQqDataRoot('/data/qq//')).toBe('/data/qq');
  });

  it('keeps a bare drive root intact', () => {
    // `D:\` 去掉分隔符会变成驱动器相对路径 `D:`，语义完全不同。
    expect(normalizeQqDataRoot('D:\\')).toBe('D:\\');
    expect(normalizeQqDataRoot('d:/')).toBe('d:/');
  });

  it('walks up when the per-account <uin> dir itself was picked', () => {
    const root = tmpRoot();
    const account = join(root, '1234567890');
    mkdirSync(join(account, 'nt_qq', 'nt_db'), { recursive: true });
    expect(normalizeQqDataRoot(account)).toBe(root);
  });

  it('keeps a data root that happens to be named like an account', () => {
    // 根目录自己叫 `1234` 时不能误判成账号目录（根有 nt_qq/global，账号没有）。
    const root = join(tmpRoot(), '1234');
    mkdirSync(join(root, 'nt_qq', 'global', 'nt_db'), { recursive: true });
    mkdirSync(join(root, 'nt_qq', 'nt_db'), { recursive: true });
    expect(normalizeQqDataRoot(root)).toBe(root);
  });

  it('walks up when a linux/macOS nt_qq_<hash> account dir was picked', () => {
    const root = tmpRoot();
    const account = join(root, 'nt_qq_0123456789abcdef');
    mkdirSync(join(account, 'nt_db'), { recursive: true });
    expect(normalizeQqDataRoot(account)).toBe(root);
  });
});
