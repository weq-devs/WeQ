import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  copyExportSavePolicy,
  resolveExportSaveDirectory,
  resolveExportSaveFile,
  saveExportOutput,
} from '../src/account/export/save_output';

const roots: string[] = [];
/**
 * 造一个目录 / 文件链接。POSIX 用 `symlink`；Windows 创建符号链接需要管理员权限
 * （非提权跑单测时直接 EPERM），所以目录链接退用 junction —— 它同样会被
 * `realpathSync` 解析成真实路径。文件链接在 Windows 上没有免提权替代品，
 * 建不出来时由调用方跳过对应断言。
 */
function makeLink(target: string, path: string, kind: 'file' | 'dir'): boolean {
  try {
    if (kind === 'file') symlinkSync(target, path, 'file');
    else symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) return false;
    throw error;
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-save-output-'));
  roots.push(root);
  const source = join(root, 'source');
  const target = join(root, 'target');
  mkdirSync(source);
  mkdirSync(target);
  return { root, source, target };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('导出保存策略与结果发布', () => {
  it('服务器自动命名只规范化父目录，拒绝父目录逃逸但不跟随已有最终文件链接', () => {
    const f = fixture();
    const outside = join(f.source, 'private.json');
    writeFileSync(outside, 'personal');
    const alias = join(f.target, 'alias.json');
    symlinkSync(outside, alias);
    expect(resolveExportSaveFile(f.target, alias, true)).toBe(
      join(realpathSync(f.target), 'alias.json'),
    );
    expect(() => resolveExportSaveFile(f.target, alias)).toThrow();
    const outsideAlias = join(f.target, 'escape');
    symlinkSync(f.source, outsideAlias);
    expect(() => resolveExportSaveFile(f.target, join(outsideAlias, 'new.json'), true)).toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('personal');
  });
  it('自动保存为单文件时避开主文件和报告重名，保持已有内容且并发不相互覆盖', async () => {
    const f = fixture(),
      source = join(f.source, 'generated.json'),
      report = join(f.source, 'report.json');
    writeFileSync(source, 'generated');
    writeFileSync(report, 'report');
    const target = join(f.target, 'name.json');
    writeFileSync(`${target}.report.json`, 'original-report');
    const paths = await Promise.all([
      saveExportOutput(
        { name: '合成', filePath: source, reportPath: report },
        { filePath: target, unique: true },
      ),
      saveExportOutput(
        { name: '合成', filePath: source, reportPath: report },
        { filePath: target, unique: true },
      ),
    ]);
    expect(new Set(paths).size).toBe(2);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(`${target}.report.json`, 'utf8')).toBe('original-report');
    for (const path of paths) {
      expect(readFileSync(path, 'utf8')).toBe('generated');
      expect(readFileSync(`${path}.report.json`, 'utf8')).toBe('report');
    }
    expect(readdirSync(f.target).some((name) => name.endsWith('.partial'))).toBe(false);
  });
  it('单文件策略保留确切文件名，完成后选择清除路径，不接受文件／目录混用', () => {
    const f = fixture(),
      filePath = join(f.target, 'result.json');
    expect(copyExportSavePolicy({ mode: 'before', filePath })).toEqual({
      mode: 'before',
      filePath,
    });
    expect(copyExportSavePolicy({ mode: 'after', filePath })).toEqual({ mode: 'after' });
    expect(() => copyExportSavePolicy({ mode: 'before', filePath: 'relative.json' })).toThrow(
      /绝对路径/,
    );
    expect(() => copyExportSavePolicy({ mode: 'before', filePath, directory: f.target })).toThrow(
      /之一/,
    );
  });
  it('单文件按原生选择的文件名原子保存，报告旁附且源结果保留', async () => {
    const f = fixture(),
      source = join(f.source, 'cached.json'),
      report = join(f.source, 'report.json');
    writeFileSync(source, '{"fixture":true}');
    writeFileSync(report, '{"coverage":"complete"}');
    const target = join(f.target, '用户选择的名字.json');
    expect(
      await saveExportOutput(
        { name: '原名称', filePath: source, reportPath: report },
        { filePath: target },
      ),
    ).toBe(realpathSync(target));
    expect(readFileSync(target, 'utf8')).toBe(readFileSync(source, 'utf8'));
    expect(readFileSync(`${target}.report.json`, 'utf8')).toBe(readFileSync(report, 'utf8'));
    expect(readdirSync(f.target).sort()).toEqual([
      '用户选择的名字.json',
      '用户选择的名字.json.report.json',
    ]);
  });
  it('单文件同名冲突不覆盖个人文件，也不留下本轮旁附报告', async () => {
    const f = fixture(),
      source = join(f.source, 'cached.txt'),
      report = join(f.source, 'report.json');
    writeFileSync(source, 'generated');
    writeFileSync(report, 'report');
    const target = join(f.target, 'original.txt');
    writeFileSync(target, 'preserve');
    await expect(
      saveExportOutput(
        { name: 'fixture', filePath: source, reportPath: report },
        { filePath: target },
      ),
    ).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('preserve');
    expect(readdirSync(f.target)).toEqual(['original.txt']);
    expect(readFileSync(source, 'utf8')).toBe('generated');
  });
  it('旁附报告冲突时不发布主文件；缺失目录不自动创建替代位置', async () => {
    const f = fixture(),
      source = join(f.source, 'cached.txt'),
      report = join(f.source, 'report.json');
    writeFileSync(source, 'generated');
    writeFileSync(report, 'report');
    const target = join(f.target, 'chosen.txt');
    writeFileSync(`${target}.report.json`, 'original-report');
    await expect(
      saveExportOutput(
        { name: 'fixture', filePath: source, reportPath: report },
        { filePath: target },
      ),
    ).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(`${target}.report.json`, 'utf8')).toBe('original-report');
    const missing = join(f.root, 'unavailable');
    await expect(
      saveExportOutput({ name: 'fixture', filePath: source }, missing, undefined, {
        requireExistingDirectory: true,
      }),
    ).rejects.toThrow();
    await expect(
      saveExportOutput(
        { name: 'fixture', filePath: source },
        { filePath: join(missing, 'chosen.txt') },
      ),
    ).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
  });
  it('取消或把多文件包选成单文件时，不破坏缓存或发布目标', async () => {
    const f = fixture(),
      source = join(f.source, 'cached.txt');
    writeFileSync(source, 'generated');
    const target = join(f.target, 'chosen.txt'),
      abort = new AbortController();
    abort.abort();
    await expect(
      saveExportOutput({ name: 'fixture', filePath: source }, { filePath: target }, abort.signal),
    ).rejects.toThrow();
    await expect(
      saveExportOutput({ name: 'fixture', bundleDir: f.source }, { filePath: target }),
    ).rejects.toThrow(/多个文件/);
    expect(readdirSync(f.target)).toEqual([]);
    expect(readFileSync(source, 'utf8')).toBe('generated');
  });
  it('Web 保存子目录受服务端根约束，不允许父目录或链接逃逸', () => {
    const f = fixture();
    expect(resolveExportSaveDirectory(f.target, 'a/b')).toBe(
      join(realpathSync(f.target), 'a', 'b'),
    );
    expect(() => resolveExportSaveDirectory(f.target, '../source')).toThrow('导出目录内');
    expect(makeLink(f.source, join(f.target, 'outside'), 'dir')).toBe(true);
    expect(() => resolveExportSaveDirectory(f.target, 'outside/new')).toThrow('链接');
  });
  it('完成后选择不携带旧目录，其他两种模式必须先确定有效位置', () => {
    expect(copyExportSavePolicy({ mode: 'after', directory: '/old' })).toEqual({ mode: 'after' });
    expect(() => copyExportSavePolicy({ mode: 'before' })).toThrow('保存目录');
    expect(() => copyExportSavePolicy({ mode: 'preset', directory: 'relative' })).toThrow(
      '保存目录',
    );
    const f = fixture();
    for (const mode of ['preset', 'before'] as const)
      expect(copyExportSavePolicy({ mode, directory: f.target })).toEqual({
        mode,
        directory: f.target,
      });
  });

  it('单文件与报告逐字节保存，保留源结果，已有同名内容不覆盖', async () => {
    const f = fixture();
    const source = join(f.source, 'message.json');
    const report = join(f.source, 'message.report.json');
    writeFileSync(source, '{"fixture":true}');
    writeFileSync(report, '{"report":true}');
    mkdirSync(join(f.target, 'same-name'));
    writeFileSync(join(f.target, 'same-name', 'original.txt'), 'preserve');
    const first = await saveExportOutput(
      { name: 'same-name', filePath: source, reportPath: report },
      f.target,
    );
    const second = await saveExportOutput(
      { name: 'same-name', filePath: source, reportPath: report },
      f.target,
    );
    expect(first).not.toBe(second);
    expect(readFileSync(join(first, 'same-name.json'), 'utf8')).toBe('{"fixture":true}');
    expect(readFileSync(join(first, 'export-report.json'), 'utf8')).toBe('{"report":true}');
    expect(readFileSync(source, 'utf8')).toBe('{"fixture":true}');
    expect(readFileSync(join(f.target, 'same-name', 'original.txt'), 'utf8')).toBe('preserve');
    expect(readdirSync(f.target).some((name) => name.endsWith('.partial'))).toBe(false);
  });

  it('媒体包与空目录完整保留，HTML 相对媒体路径不改变', async () => {
    const f = fixture();
    mkdirSync(join(f.source, 'media'));
    mkdirSync(join(f.source, 'empty'));
    writeFileSync(join(f.source, 'index.html'), '<img src="media/pic.bin">');
    writeFileSync(join(f.source, 'media', 'pic.bin'), Buffer.from([0, 1, 255]));
    const path = await saveExportOutput({ name: 'fixture', bundleDir: f.source }, f.target);
    expect(readFileSync(join(path, 'index.html'), 'utf8')).toBe('<img src="media/pic.bin">');
    expect(readFileSync(join(path, 'media', 'pic.bin'))).toEqual(Buffer.from([0, 1, 255]));
    expect(readdirSync(join(path, 'empty'))).toEqual([]);
  });

  it('拒绝把结果复制回自身，不递归复制或破坏原件', async () => {
    const f = fixture();
    writeFileSync(join(f.source, 'original'), 'preserve');
    await expect(
      saveExportOutput({ name: 'fixture', bundleDir: f.source }, join(f.source, 'nested')),
    ).rejects.toThrow('源目录内部');
    expect(readdirSync(f.source)).toEqual(['original']);
  });

  it('失败或取消仅清理本次未发布副本，原件和已存目标保持不变', async () => {
    const f = fixture();
    writeFileSync(join(f.target, 'original'), 'preserve');
    writeFileSync(join(f.source, 'message.txt'), 'fixture');
    // Windows 非提权建不了文件符号链接 —— 那种环境跳过这段链接断言。
    const linked = makeLink(join(f.source, 'message.txt'), join(f.source, 'link'), 'file');
    if (linked) {
      await expect(
        saveExportOutput({ name: 'fixture', bundleDir: f.source }, f.target),
      ).rejects.toThrow('链接');
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      saveExportOutput(
        { name: 'fixture', filePath: join(f.source, 'message.txt') },
        f.target,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(readdirSync(f.target)).toEqual(['original']);
    expect(readFileSync(join(f.source, 'message.txt'), 'utf8')).toBe('fixture');
  });
});
