import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exportSavePolicyInput,
  prepareExportDestination,
  saveCompletedExportTask,
} from '../src/main/ipc/routers/export_save';
import type { ExportTask } from '@weq/service';
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
  it('已完成结果同样遵循自动保存设置，不被历史位置或旧保存状态改成询问', async () => {
    const f = fixture();
    const task = { id: 'done', name: '已完成', format: 'json', status: 'completed' } as ExportTask;
    const manager = {
      getTask: () => task,
      saveTaskOutput: vi.fn(async () => '/saved/result.json'),
    };
    await saveCompletedExportTask(
      manager,
      task.id,
      () => f.host,
      {},
      () => {},
      {
        exportSaveMode: 'preset',
        defaultExportDir: f.directory,
      },
    );
    expect(manager.saveTaskOutput).toHaveBeenCalledWith(
      task.id,
      undefined,
      join(f.directory, '已完成.json'),
      true,
    );
    expect(f.host.pickSaveTarget).not.toHaveBeenCalled();
    expect(f.host.pickDirectory).not.toHaveBeenCalled();
  });
  it('单文件走另存为，整包走目录；明确位置优先于长期默认', async () => {
    const f = fixture();
    expect(
      await prepareExportDestination({ mode: 'before' }, '/unused/default', f.host, file),
    ).toEqual({ mode: 'before', filePath: join(f.directory, '用户选择.json') });
    expect(f.host.pickSaveTarget).toHaveBeenCalledWith({
      locationKey: 'export:file:json',
      defaultDirectory: '/unused/default',
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
  it('自动保存缺少或失效的默认文件夹时明确失败，不弹选择器或静默回落', async () => {
    const f = fixture();
    await expect(prepareExportDestination({ mode: 'preset' }, null, f.host, file)).rejects.toThrow(
      '默认保存文件夹',
    );
    expect(f.host.pickSaveTarget).not.toHaveBeenCalled();
    f.host.pickSaveTarget.mockClear();
    const missing = join(f.root, 'missing');
    await expect(
      prepareExportDestination({ mode: 'preset' }, missing, f.host, file),
    ).rejects.toThrow(/重新选择/);
    expect(f.host.pickSaveTarget).not.toHaveBeenCalled();
    expect(existsSync(missing)).toBe(false);
  });
  it('拒绝旧稍后保存参数，取消或来源失效不返回可执行位置', async () => {
    const f = fixture();
    expect(exportSavePolicyInput.safeParse({ mode: 'after' }).success).toBe(false);
    await expect(
      prepareExportDestination(
        { mode: 'after' } as unknown as Parameters<typeof prepareExportDestination>[0],
        null,
        f.host,
        file,
      ),
    ).rejects.toThrow('不支持');
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
    const browser = await prepareExportDestination(
      { mode: 'before', directory: '.' },
      '/unavailable/default-directory',
      host,
      file,
    );
    expect(browser?.filePath).toBe(join(realpathSync(f.directory), '合成结果.json'));
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
