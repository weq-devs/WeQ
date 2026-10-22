import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { UserConfigService } from './user_config';
import { DEFAULT_APP_SETTINGS } from './user_config';
import { snapshotWeqSettings, snapshotWeqApiSettings, snapshotWeqAccount } from './backup_settings';
import {
  buildWeqBackup,
  readWeqBackup,
  summarizeWeqBackup,
  isWeqBackupConfigId,
  WEQ_BACKUP_PARTS,
  WEQ_BACKUP_LIMITS,
  type WeqBackupFile,
  type WeqBackupPart,
} from './backup_bundle';
import { snapshotWeqClones } from './backup_clones';
import { snapshotWeqAccountPreferences } from './backup_accounts';
import { validateWeqBackupData } from './backup_data';
import { validateWeqClientSettings } from '../common/backup_client';
import {
  previewWeqBackupRestore,
  stageWeqBackupRestore,
  weqBackupRestoreStatus,
  cancelWeqBackupRestore,
  type WeqRestoreChoice,
} from './backup_restore';

export interface WeqBackupSelection {
  parts: WeqBackupPart[];
  accountConfigIds?: string[];
  cloneConfigIds?: string[];
  includeClient?: boolean;
}

/** UI 只持有不透明预览 ID；内存最多保留一份输入，不将归档或凭据回传渲染层。 */
export class WeqBackupService {
  private source: { id: string; archive: Buffer; name: string } | null = null;
  private preview: { id: string; sourceId: string; choice: WeqRestoreChoice } | null = null;
  private upload: { id: string; data: Buffer; received: number; name: string } | null = null;
  private exported: { id: string; path: string } | null = null;
  readonly root: string;
  constructor(
    appRoot: string,
    private readonly config: UserConfigService,
  ) {
    this.root = resolve(appRoot);
  }

  private cloneScopes(): string[] {
    const root = join(this.config.cacheBaseDir(), 'agentlab');
    return existsSync(root)
      ? readdirSync(root).filter(
          (id) => isWeqBackupConfigId(id) && lstatSync(join(root, id)).isDirectory(),
        )
      : [];
  }

  inventory() {
    const accounts = this.config
      .listAccountConfigs()
      .filter(
        (account) => typeof account.configId === 'string' && isWeqBackupConfigId(account.configId),
      );
    return {
      accounts: accounts.map(({ configId, uin, displayName, dataDir }) => ({
        configId,
        uin,
        displayName: displayName ?? uin,
        ...(typeof dataDir === 'string' ? { dataDir } : {}),
      })),
      cloneScopes: this.cloneScopes(),
      restore: weqBackupRestoreStatus(this.root),
    };
  }

  snapshot(selection: WeqBackupSelection, client: unknown) {
    if (!selection.parts.length || selection.parts.some((part) => !WEQ_BACKUP_PARTS.includes(part)))
      throw new Error('请选择要备份的数据');
    const accounts = selection.parts.includes('accounts') ? this.config.listAccountConfigs() : [];
    const check = (selected: string[] | undefined, available: string[]) => {
      if (selected?.some((id) => !available.includes(id)))
        throw new Error('所选数据域已经变化，请重新读取后选择');
    };
    if (selection.parts.includes('accounts'))
      check(
        selection.accountConfigIds,
        accounts.map((account) => account.configId),
      );
    if (selection.parts.includes('clones')) check(selection.cloneConfigIds, this.cloneScopes());
    const files: WeqBackupFile[] = [];
    const add = (path: string, value: unknown) =>
      files.push({ path, data: Buffer.from(JSON.stringify(value)) });
    const settings = selection.parts.some((part) => part === 'settings' || part === 'api')
      ? this.config.getSettings()
      : DEFAULT_APP_SETTINGS;
    const warnings: string[] = [];
    if (selection.parts.includes('settings')) {
      add('settings/app.json', snapshotWeqSettings(settings));
      if (selection.includeClient !== false) {
        validateWeqClientSettings(client);
        add('settings/client.json', client);
      }
      add('settings/export-presets.json', this.config.getExportPresets());
    }
    if (selection.parts.includes('api')) add('api/settings.json', snapshotWeqApiSettings(settings));
    if (selection.parts.includes('accounts'))
      for (const account of accounts) {
        if (selection.accountConfigIds && !selection.accountConfigIds.includes(account.configId))
          continue;
        add(`accounts/${account.configId}.json`, snapshotWeqAccount(account));
        const preferences = snapshotWeqAccountPreferences(
          this.root,
          this.config.cacheBaseDir(),
          account.configId,
        );
        files.push(...preferences.files);
        warnings.push(...preferences.warnings);
      }
    if (selection.parts.includes('clones')) {
      const clones = snapshotWeqClones(
        join(this.config.cacheBaseDir(), 'agentlab'),
        selection.cloneConfigIds,
      );
      files.push(...clones.files);
      warnings.push(...clones.warnings);
      if (!clones.files.length) warnings.push('所选数据域没有可备份的克隆或助手数据。');
    }
    const archive = buildWeqBackup(files);
    const bundle = readWeqBackup(archive);
    validateWeqBackupData(bundle);
    const summary = summarizeWeqBackup(bundle);
    return {
      archive,
      summary: { ...summary, warnings: [...new Set([...summary.warnings, ...warnings])] },
    };
  }

  inspect(archive: Buffer, name: string) {
    this.upload = null;
    return this.inspectOwned(Buffer.from(archive), name);
  }

  private inspectOwned(archive: Buffer, name: string) {
    this.source = null;
    this.preview = null;
    const bundle = readWeqBackup(archive);
    this.source = { id: randomUUID(), archive, name };
    return { id: this.source.id, name, summary: summarizeWeqBackup(bundle) };
  }

  prepare(sourceId: string, choice: WeqRestoreChoice) {
    if (!this.source || this.source.id !== sourceId)
      throw new Error('备份预览已经失效，请重新选择文件');
    const result = previewWeqBackupRestore(
      this.root,
      this.config.cacheBaseDir(),
      this.source.archive,
      choice,
    );
    this.preview = { id: randomUUID(), sourceId, choice: structuredClone(choice) };
    return { id: this.preview.id, ...result };
  }

  stage(previewId: string) {
    if (
      !this.source ||
      !this.preview ||
      this.preview.id !== previewId ||
      this.preview.sourceId !== this.source.id
    )
      throw new Error('恢复确认已经失效，请重新预览');
    const result = stageWeqBackupRestore(this.root, this.source.archive, this.preview.choice);
    this.source = null;
    this.preview = null;
    return result;
  }

  dispose(sourceId: string): void {
    if (this.upload?.id === sourceId) this.upload = null;
    if (this.source?.id === sourceId) {
      this.source = null;
      this.preview = null;
    }
  }
  beginUpload(name: string, bytes: number): string {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > WEQ_BACKUP_LIMITS.maxArchiveBytes ||
      !name ||
      name.length > 512
    )
      throw new Error('备份上传大小或名称无效');
    this.upload = null;
    this.source = null;
    this.preview = null;
    this.upload = { id: randomUUID(), data: Buffer.alloc(bytes), received: 0, name };
    return this.upload.id;
  }
  uploadChunk(id: string, offset: number, encoded: string): number {
    const upload = this.upload;
    if (!upload || upload.id !== id) throw new Error('备份上传已失效');
    if (
      encoded.length > 87384 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    )
      throw new Error('备份上传分片无效');
    const bytes = Buffer.from(encoded, 'base64');
    if (
      !bytes.length ||
      bytes.length > 65536 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + bytes.length > upload.data.length
    )
      throw new Error('备份上传分片越界');
    if (
      offset < upload.received &&
      offset + bytes.length <= upload.received &&
      upload.data.subarray(offset, offset + bytes.length).equals(bytes)
    )
      return upload.received;
    if (offset !== upload.received) throw new Error('备份上传分片顺序不一致');
    bytes.copy(upload.data, offset);
    upload.received += bytes.length;
    return upload.received;
  }
  finishUpload(id: string) {
    const upload = this.upload;
    if (!upload || upload.id !== id || upload.received !== upload.data.length)
      throw new Error('备份上传尚未完成或已失效');
    this.upload = null;
    return this.inspectOwned(upload.data, upload.name);
  }
  rememberExport(path: string): string {
    this.exported = { id: randomUUID(), path };
    return this.exported.id;
  }
  exportPath(id: string): string {
    if (this.exported?.id !== id) throw new Error('导出记录已失效，已保存的文件不受影响');
    return this.exported.path;
  }
  cancel(): void {
    cancelWeqBackupRestore(this.root, this.config.cacheBaseDir());
  }

  stageDefaults(clientId?: string) {
    const result = stageWeqBackupRestore(
      this.root,
      buildWeqBackup([
        {
          path: 'settings/app.json',
          data: Buffer.from(JSON.stringify(snapshotWeqSettings(DEFAULT_APP_SETTINGS))),
        },
        { path: 'settings/client.json', data: Buffer.from('{}') },
        { path: 'settings/export-presets.json', data: Buffer.from('{}') },
      ]),
      {
        parts: ['settings'],
        conflict: 'overwrite',
        keepLocalPaths: false,
        ...(clientId ? { clientId } : {}),
      },
    );
    this.source = null;
    this.preview = null;
    this.upload = null;
    return result;
  }
}
