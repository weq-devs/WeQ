import { describe, expect, it } from 'vitest';
import { exportDownloadName } from '../src/main/ipc/routers/export_save';

describe('导出下载文件名', () => {
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
