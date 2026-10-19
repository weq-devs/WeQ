import { describe, expect, it, vi } from 'vitest';
import {
  exportDownloadName,
  pickExportOutputDestination,
} from '../src/main/ipc/routers/export_save';

describe('导出下载文件名', () => {
  it('桌面单文件使用另存为，多文件包与 Web 使用文件夹', async () => {
    const host = {
      pickDirectory: vi.fn(async () => '/chosen/folder'),
      pickSaveTarget: vi.fn(async () => ({ path: '/chosen/contact.vcf', downloadId: null })),
    };
    const task = { id: 'synthetic', name: '联系人名单', format: 'vcard' };
    expect(await pickExportOutputDestination(task, host)).toEqual({
      mode: 'before',
      filePath: '/chosen/contact.vcf',
    });
    expect(host.pickSaveTarget).toHaveBeenCalledWith({
      defaultName: '联系人名单.vcf',
      extension: 'vcf',
    });
    expect(host.pickDirectory).not.toHaveBeenCalled();
    expect(
      await pickExportOutputDestination({ ...task, bundleDir: '/cache/bundle' }, host),
    ).toEqual({ mode: 'before', directory: '/chosen/folder' });
    expect(await pickExportOutputDestination(task, { ...host, exportRoot: '/server' })).toEqual({
      mode: 'before',
      directory: '/chosen/folder',
    });
    expect(host.pickSaveTarget).toHaveBeenCalledOnce();
  });
  it('系统文件或目录选择取消返回 null，不冒充保存失败', async () => {
    const host = { pickDirectory: async () => null, pickSaveTarget: async () => null };
    const task = { id: 'synthetic', name: '名单', format: 'json' };
    expect(await pickExportOutputDestination(task, host)).toBeNull();
    expect(
      await pickExportOutputDestination({ ...task, bundleDir: '/cache/bundle' }, host),
    ).toBeNull();
  });
  it('联系人 vCard 使用真实的 vcf 扩展名，不暴露内部缓存任务名', () => {
    expect(exportDownloadName({ id: 'synthetic-task', name: '精确好友', format: 'vcard' })).toBe(
      '精确好友.vcf',
    );
  });
  it('资源包统一使用 zip，普通格式维持原扩展名', () => {
    expect(
      exportDownloadName({
        id: 'synthetic-task',
        name: '好友与头像',
        format: 'json',
        bundleDir: '/fixture/bundle',
      }),
    ).toBe('好友与头像.zip');
    expect(exportDownloadName({ id: 'synthetic-task', name: '好友', format: 'csv' })).toBe(
      '好友.csv',
    );
  });
  it('复用统一路径段清洗，不把路径、控制字符或设备名带入下载名', () => {
    const result = exportDownloadName({
      id: 'synthetic-task',
      name: '../合成:好友\n',
      format: 'json',
    });
    expect(result).not.toMatch(/[/:\n]/);
    expect(exportDownloadName({ id: 'synthetic-task', name: 'CON', format: 'json' })).toBe(
      'synthetic-task.json',
    );
  });
});
