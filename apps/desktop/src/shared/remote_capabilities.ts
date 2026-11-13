/** Remote 的产品能力与屏幕布局无关；正常业务数据和导出暂存不属于电脑文件管理。 */
const computerProcedures = new Set([
  'bootstrap.pickTencentFilesRoot',
  'bootstrap.pickMsgDb',
  'bootstrap.pickStaticDbDir',
  'bootstrap.scanStaticDirs',
  'bootstrap.scanStaticDirsProgress',
  'bootstrap.testStaticDir',
  'bootstrap.pickCacheDir',
  'bootstrap.clearCacheDir',
  'bootstrap.clearStorageData',
  'bootstrap.clearWeqCache',
  'bootstrap.setLogRetentionDays',
  'bootstrap.revealStorageItem',
  'bootstrap.pickCallRecordingDir',
  'bootstrap.pickDefaultExportDir',
  'bootstrap.setDefaultExportDir',
  'bootstrap.setExportSaveMode',
  'bootstrap.setExportSaveDefaults',
  'bootstrap.pickExportSaveDirectory',
  'bootstrap.setExternalChatpic',
  'bootstrap.pickExternalChatpicDir',
  'bootstrap.installMcpToAgents',
  'bootstrap.listMcpAgentTargets',
  'bootstrap.setAutostart',
  'bootstrap.setShowWindowOnAutostart',
  'bootstrap.setWindowCloseBehavior',
  'bootstrap.setWindowsStyleControls',
  'bootstrap.openQqDataAccessSettings',
  'bootstrap.qqDebugCopyAction',
  'bootstrap.qqDebugCopyPermission',
  'bootstrap.backupPick',
  'bootstrap.backupOpenDirectory',
  'bootstrap.backupRevealExport',
  'bootstrap.backupRestart',
  'account.setNativeMediaEnabled',
  'account.pickDecryptOutputDir',
  'account.pickQzoneAlbumExportDir',
  'account.pickGroupAlbumExportDir',
  'account.pickGroupFileExportDir',
  'account.pickExportBaselineDirectory',
  'account.listExportBaselines',
  'account.resourceCleanup.cleanup',
  'account.dbExplorer.updateCell',
  'account.dbExplorer.insertRow',
  'account.dbExplorer.deleteRow',
  'wonderfulTools.pickDatabase',
  'wonderfulTools.peekDatabaseHeader',
  'wonderfulTools.fetchOtherDeviceKey',
  'wonderfulTools.loginAccountRemoveA1',
  'wonderfulTools.loginAccountDelete',
  'wonderfulTools.loginAccountRotateGuid',
  'help.openFolder',
  'exportViewer.scan',
  'exportViewer.scanProgress',
  'exportViewer.revealMedia',
  'update.setInterval',
  'update.setPrerelease',
  'update.check',
  'update.download',
  'update.install',
]);

export const REMOTE_UNSUPPORTED_MESSAGE =
  'WeQ Remote 不支持管理电脑文件或电脑系统环境，请在电脑端操作。';

export function remoteProcedureUnavailable(path: string, input: unknown): boolean {
  if (computerProcedures.has(path) || path.startsWith('dbRepair.')) return true;
  if (path === 'bootstrap.setCallRecording' && input && typeof input === 'object')
    return ['dir', 'systemAudio', 'udpTrace'].some((key) => Object.hasOwn(input, key));
  if (path === 'account.dbExplorer.runSql' && input && typeof input === 'object' && 'sql' in input)
    return typeof input.sql !== 'string' || !/^\s*(select|with|explain)\b/i.test(input.sql);
  if (path === 'account.startExport' && input && typeof input === 'object')
    return 'baselineDirectory' in input && Boolean(input.baselineDirectory);
  if (path === 'exportViewer.pick')
    return (
      !input ||
      typeof input !== 'object' ||
      !('uploadPath' in input) ||
      !input.uploadPath ||
      ('directory' in input && input.directory === true)
    );
  return false;
}

const computerSettingsPages = new Set(['weq-storage', 'qq-accounts', 'database-repair', 'media']);
const computerSettingIds = new Set([
  'weq-space-cleanup',
  'qq-storage-cleanup',
  'linked-resources',
  'external-chatpic',
  'other-device-key',
  'qq-debug-copy',
  'long-term-authorization',
  'startup-enabled',
  'window-close-behavior',
  'mcp-install',
  'update-check-interval',
  'update-prerelease',
]);

const computerResetCards = new Set([
  'startup-system',
  'window',
  'call-directory',
  'call-trace',
  'native-media',
  'external-chatpic',
  'logs',
]);

/**
 * 项目名（设置行标题 / 搜索条目名）层面的禁项。有些行没有 settingId，或者
 * 同一个 settingId 下只有某一项要藏，只能按名字认。放在这里而不是搜索里，
 * 新增禁项时导航、搜索、重置三处自动一起生效。
 */
const computerSettingItems = new Set([
  '自启时显示窗口',
  '使用仿 Windows 窗口按钮',
  '同时录电脑声音',
  '保存位置',
  '记录 UDP 流量',
  '日志保留时长',
  '日志文件夹',
]);

/** Remote 不提供的维护工具（MaintenanceTool id）；DataMaintenanceSection 只是转出这份清单。 */
export type RemoteBlockedMaintenanceTool =
  | 'cleanup'
  | 'db-repair'
  | 'other-device-key'
  | 'login-accounts';
export const REMOTE_BLOCKED_MAINTENANCE_TOOLS: readonly RemoteBlockedMaintenanceTool[] = [
  'cleanup',
  'db-repair',
  'other-device-key',
  'login-accounts',
];

export function remoteMaintenanceToolAvailable(tool: string): boolean {
  return !(REMOTE_BLOCKED_MAINTENANCE_TOOLS as readonly string[]).includes(tool);
}

/** 供遍历式测试用：表本身是唯一真源，测试按表逐项验证消费方没有漏。 */
export const REMOTE_BLOCKED_SETTING_PAGES: readonly string[] = [...computerSettingsPages];
export const REMOTE_BLOCKED_SETTING_IDS: readonly string[] = [...computerSettingIds];
export const REMOTE_BLOCKED_SETTING_ITEMS: readonly string[] = [...computerSettingItems];
export const REMOTE_BLOCKED_RESET_CARDS: readonly string[] = [...computerResetCards];

export function remoteResetCardAvailable(card: string): boolean {
  return !computerResetCards.has(card);
}

/** 导航、设置搜索和重置入口共用同一份可用项清单。 */
export function remoteSettingAvailable(page: string, settingId?: string, item?: string): boolean {
  return (
    !computerSettingsPages.has(page) &&
    !(settingId && computerSettingIds.has(settingId)) &&
    !(item && computerSettingItems.has(item))
  );
}
