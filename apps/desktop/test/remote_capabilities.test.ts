// @vitest-environment node
import { expect, it } from 'vitest';
import { remoteProcedureUnavailable } from '../src/shared/remote_capabilities';

it.each([
  'bootstrap.pickTencentFilesRoot',
  'bootstrap.pickCacheDir',
  'bootstrap.pickCallRecordingDir',
  'bootstrap.clearStorageData',
  'bootstrap.installMcpToAgents',
  'bootstrap.setAutostart',
  'bootstrap.backupRestart',
  'account.setNativeMediaEnabled',
  'account.dbExplorer.updateCell',
  'account.resourceCleanup.cleanup',
  'dbRepair.restore',
  'wonderfulTools.loginAccountDelete',
  'update.install',
])('Remote 不提供电脑管理操作 %s', (path) => {
  expect(remoteProcedureUnavailable(path, {})).toBe(true);
});

it.each([
  'bootstrap.openAccount',
  'bootstrap.closeAccount',
  'bootstrap.openStaticAccount',
  'bootstrap.backupBeginUpload',
  'bootstrap.backupStage',
  'bootstrap.backupApply',
  'account.getMessages',
  'account.sendText',
  'account.pickedFileChunk',
  'account.dbExplorer.getRows',
  'account.dbExplorer.runSql',
  'account.startDatabasePlainExport',
  'account.exportTaskDownload',
  'mail.download',
])('Remote 保留正常业务与暂存 %s', (path) => {
  expect(remoteProcedureUnavailable(path, {})).toBe(false);
});

it('仅拦截录音设置里的电脑目录，正常录制偏好仍可保存', () => {
  expect(remoteProcedureUnavailable('bootstrap.setCallRecording', { mode: 'mixed' })).toBe(false);
  expect(remoteProcedureUnavailable('bootstrap.setCallRecording', { dir: null })).toBe(true);
  expect(remoteProcedureUnavailable('bootstrap.setCallRecording', { dir: '/computer' })).toBe(true);
});

it('导出查看器仅接受设备上传文件，不能经 Remote 扫描电脑目录', () => {
  expect(remoteProcedureUnavailable('exportViewer.pick', { directory: true })).toBe(true);
  expect(remoteProcedureUnavailable('exportViewer.pick', { directory: false })).toBe(true);
  expect(
    remoteProcedureUnavailable('exportViewer.pick', {
      directory: false,
      uploadPath: '/staging/chat.json',
    }),
  ).toBe(false);
});

it('Remote SQL 入口不开放写语句和可写 PRAGMA，读取仍交给后端只读执行', () => {
  expect(remoteProcedureUnavailable('account.dbExplorer.runSql', { sql: 'SELECT 1' })).toBe(false);
  expect(remoteProcedureUnavailable('account.dbExplorer.runSql', { sql: 'UPDATE t SET n=2' })).toBe(
    true,
  );
  expect(
    remoteProcedureUnavailable('account.dbExplorer.runSql', { sql: 'PRAGMA user_version=9' }),
  ).toBe(true);
});
