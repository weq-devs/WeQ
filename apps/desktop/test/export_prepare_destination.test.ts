import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareExportDestination } from '../src/main/ipc/routers/export_save';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-prepare-destination-'));
  roots.push(root);
  const directory = join(root, 'chosen');
  mkdirSync(directory);
  const host = {
    pickSaveTarget: vi.fn(async () => ({
      path: join(directory, '用户选择.json'),
      downloadId: null,
    })),
    pickDirectory: vi.fn(async () => directory),
  };
  return { root, directory, host };
}
const file = { kind: 'file' as const, name: '合成结果', extension: 'json' };
describe('生成前的位置准备', () => {
  it('单文件走另存为，整包走目录；明确位置优先于长期默认', async () => {
    const f = fixture();
    expect(
      await prepareExportDestination({ mode: 'before' }, '/unused/default', f.host, file),
    ).toEqual({ mode: 'before', filePath: join(f.directory, '用户选择.json') });
    expect(f.host.pickSaveTarget).toHaveBeenCalledWith({
      defaultName: '合成结果.json',
      extension: 'json',
    });
    expect(f.host.pickDirectory).not.toHaveBeenCalled();
    expect(
      await prepareExportDestination({ mode: 'before' }, null, f.host, { kind: 'directory' }),
    ).toEqual({ mode: 'before', directory: f.directory });
    f.host.pickSaveTarget.mockClear();
    expect(
      await prepareExportDestination(
        { mode: 'preset', directory: f.directory },
        '/unused/default',
        f.host,
        file,
      ),
    ).toEqual({
      mode: 'preset',
      filePath: join(f.directory, '合成结果.json'),
      uniqueFileName: true,
    });
    expect(f.host.pickSaveTarget).not.toHaveBeenCalled();
  });
  it('默认文件夹未配置时询问本次位置，但失效的已配置位置不静默回落', async () => {
    const f = fixture();
    expect((await prepareExportDestination({ mode: 'preset' }, null, f.host, file))?.mode).toBe(
      'before',
    );
    expect(f.host.pickSaveTarget).toHaveBeenCalledOnce();
    f.host.pickSaveTarget.mockClear();
    const missing = join(f.root, 'missing');
    await expect(
      prepareExportDestination({ mode: 'preset' }, missing, f.host, file),
    ).rejects.toThrow(/重新选择/);
    expect(f.host.pickSaveTarget).not.toHaveBeenCalled();
    expect(existsSync(missing)).toBe(false);
  });
  it('取消与先生成不要求位置，选择器结束后来源失效则停止', async () => {
    const f = fixture();
    expect(
      await prepareExportDestination({ mode: 'after', directory: '/old' }, null, f.host, file),
    ).toEqual({ mode: 'after' });
    expect(f.host.pickSaveTarget).not.toHaveBeenCalled();
    let changed = false;
    f.host.pickSaveTarget.mockImplementationOnce(async () => {
      changed = true;
      return { path: join(f.directory, '旧来源.json'), downloadId: null };
    });
    await expect(
      prepareExportDestination({ mode: 'before' }, null, f.host, file, () => {
        if (changed) throw new Error('来源切换');
      }),
    ).rejects.toThrow(/来源切换/);
    const cancel = { ...f.host, pickSaveTarget: async () => null, pickDirectory: async () => null };
    expect(await prepareExportDestination({ mode: 'before' }, null, cancel, file)).toBeNull();
    expect(
      await prepareExportDestination({ mode: 'before' }, null, cancel, { kind: 'directory' }),
    ).toBeNull();
  });
  it('多文件不能指定单文件位置，Web 路径只落服务器根且不调用原生选择器', async () => {
    const f = fixture();
    await expect(
      prepareExportDestination(
        { mode: 'before', filePath: join(f.directory, 'wrong.json') },
        null,
        f.host,
        { kind: 'directory' },
      ),
    ).rejects.toThrow(/多个文件/);
    const host = { ...f.host, exportRoot: f.directory };
    const result = await prepareExportDestination(
      { mode: 'before', directory: 'child' },
      null,
      host,
      file,
    );
    expect(result?.filePath).toContain('child');
    expect(result?.uniqueFileName).toBe(true);
    await expect(
      prepareExportDestination({ mode: 'before', directory: '../outside' }, null, host, file),
    ).rejects.toThrow(/导出目录内/);
    expect(f.host.pickDirectory).not.toHaveBeenCalled();
    expect(f.host.pickSaveTarget).not.toHaveBeenCalled();
  });
});
