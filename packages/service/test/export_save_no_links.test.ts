import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveExportOutput } from '../src/account/export/save_output';
const state = vi.hoisted(() => ({ failWrite: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: vi.fn(async () => {
      throw Object.assign(new Error('卷不支持硬链接'), { code: 'ENOTSUP' });
    }),
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (state.failWrite)
        vi.spyOn(handle, 'write').mockRejectedValue(
          Object.assign(new Error('空间不足'), { code: 'ENOSPC' }),
        );
      return handle;
    },
  };
});
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-save-no-links-'));
  roots.push(root);
  const source = join(root, 'source.json'),
    target = join(root, 'chosen.json');
  const content = 'synthetic'.repeat(20000);
  writeFileSync(source, content);
  return { root, source, target, content };
}
afterEach(() => {
  state.failWrite = false;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('不支持硬链接的保存卷', () => {
  it('独占句柄流式复制与报告校验，保留源且没有大型目标卷临时副本', async () => {
    const f = fixture(),
      report = join(f.root, 'source-report.json');
    writeFileSync(report, '{"report":true}');
    expect(
      await saveExportOutput(
        { name: '合成', filePath: f.source, reportPath: report },
        { filePath: f.target },
      ),
    ).toBe(realpathSync(f.target));
    expect(readFileSync(f.target, 'utf8')).toBe(f.content);
    expect(readFileSync(`${f.target}.report.json`, 'utf8')).toBe('{"report":true}');
    expect(readFileSync(f.source, 'utf8')).toBe(f.content);
    expect(readdirSync(f.root).some((name) => name.endsWith('.partial'))).toBe(false);
  });
  it('已有文件不覆盖，复制失败清理自己创建的未完成文件', async () => {
    const f = fixture();
    writeFileSync(f.target, 'original');
    await expect(
      saveExportOutput({ name: '合成', filePath: f.source }, { filePath: f.target }),
    ).rejects.toThrow(/同名/);
    expect(readFileSync(f.target, 'utf8')).toBe('original');
    const failed = join(f.root, 'failed.json');
    state.failWrite = true;
    await expect(
      saveExportOutput({ name: '合成', filePath: f.source }, { filePath: failed }),
    ).rejects.toThrow(/空间不足/);
    expect(existsSync(failed)).toBe(false);
    expect(readFileSync(f.source, 'utf8')).toBe(f.content);
    expect(readdirSync(f.root).some((name) => name.endsWith('.partial'))).toBe(false);
  });
  it('自动命名并发避开主文件／报告冲突，不覆盖原件', async () => {
    const f = fixture();
    writeFileSync(f.target, 'personal');
    const paths = await Promise.all([
      saveExportOutput({ name: '合成', filePath: f.source }, { filePath: f.target, unique: true }),
      saveExportOutput({ name: '合成', filePath: f.source }, { filePath: f.target, unique: true }),
    ]);
    expect(new Set(paths).size).toBe(2);
    expect(readFileSync(f.target, 'utf8')).toBe('personal');
    for (const path of paths) expect(readFileSync(path, 'utf8')).toBe(f.content);
  });
  it('自动命名不跟随已有文件链接到其他文件夹', async () => {
    const f = fixture();
    mkdirSync(join(f.root, 'outside'));
    const original = join(f.root, 'outside', 'personal.json'),
      alias = join(f.root, 'alias.json');
    writeFileSync(original, 'preserve');
    symlinkSync(original, alias);
    const path = await saveExportOutput(
      { name: '合成', filePath: f.source },
      { filePath: alias, unique: true },
    );
    expect(path).not.toBe(realpathSync(original));
    expect(dirname(path)).toBe(realpathSync(f.root));
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readFileSync(original, 'utf8')).toBe('preserve');
  });
});
