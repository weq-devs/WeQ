import { describe, expect, it, vi } from 'vitest';
import {
  bindExportSaveRequest,
  exportDownloadName,
  pickExportOutputDestination,
} from '../src/main/ipc/routers/export_save';

describe('导出下载文件名', () => {
  it('独立单文件按资源扩展名选择与下载，不沿用占位 JSON 格式', async () => {
    const task = {
      id: 'resource',
      name: '合成库',
      format: 'json',
      resource: {
        kind: 'database' as const,
        output: { kind: 'file' as const, name: '合成库', extension: 'db' },
      },
    };
    expect(exportDownloadName(task)).toBe('合成库.db');
    const host = {
      pickDirectory: vi.fn(async () => null),
      pickSaveTarget: vi.fn(async () => null),
    };
    await pickExportOutputDestination(task, host);
    expect(host.pickSaveTarget).toHaveBeenCalledWith({
      defaultName: '合成库.db',
      extension: 'db',
      locationKey: 'export-after',
    });
  });
  it('保存等待前后核对账号、配置与服务实例，纯全局选择不要求已登录账号', () => {
    let context = { uin: '10001', configId: 'source-a', services: {} };
    const original = context;
    const check = bindExportSaveRequest(
      { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
      () => context,
    );
    check();
    context = { ...original, configId: 'source-b' };
    expect(check).toThrow(/数据源/);
    context = { ...original, uin: '10002' };
    expect(check).toThrow(/账号/);
    context = { ...original, services: {} };
    expect(check).toThrow(/数据源/);
    const read = vi.fn(() => {
      throw new Error('不应读取账号');
    });
    expect(bindExportSaveRequest({}, read)).not.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
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
      locationKey: 'export-after',
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
