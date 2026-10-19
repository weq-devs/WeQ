import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  copyExportSavePolicy,
  resolveExportSaveDirectory,
  saveExportOutput,
} from '../src/account/export/save_output';

const roots: string[] = [];
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
  it('Web 保存子目录受服务端根约束，不允许父目录或链接逃逸', () => {
    const f = fixture();
    expect(resolveExportSaveDirectory(f.target, 'a/b')).toBe(
      join(realpathSync(f.target), 'a', 'b'),
    );
    expect(() => resolveExportSaveDirectory(f.target, '../source')).toThrow('导出目录内');
    symlinkSync(f.source, join(f.target, 'outside'));
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
    symlinkSync(join(f.source, 'message.txt'), join(f.source, 'link'));
    await expect(
      saveExportOutput({ name: 'fixture', bundleDir: f.source }, f.target),
    ).rejects.toThrow('链接');
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
