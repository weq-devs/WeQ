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
  type WeqBackupFile,
  type WeqBackupPart,
} from './backup_bundle';
import { snapshotWeqClones } from './backup_clones';
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
}

/** UI 只持有不透明预览 ID；内存最多保留一份输入，不将归档或凭据回传渲染层。 */
export class WeqBackupService {
  private source: { id: string; archive: Buffer; name: string } | null = null;
  private preview: { id: string; sourceId: string; choice: WeqRestoreChoice } | null = null;
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
      accounts: accounts.map(({ configId, uin, displayName }) => ({
        configId,
        uin,
        displayName: displayName ?? uin,
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
      validateWeqClientSettings(client);
      add('settings/app.json', snapshotWeqSettings(settings));
      add('settings/client.json', client);
      add('settings/export-presets.json', this.config.getExportPresets());
    }
    if (selection.parts.includes('api')) add('api/settings.json', snapshotWeqApiSettings(settings));
    if (selection.parts.includes('accounts'))
      for (const account of accounts) {
        if (selection.accountConfigIds && !selection.accountConfigIds.includes(account.configId))
          continue;
        add(`accounts/${account.configId}.json`, snapshotWeqAccount(account));
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
    this.source = null;
    this.preview = null;
    const bundle = readWeqBackup(archive);
    this.source = { id: randomUUID(), archive: Buffer.from(archive), name };
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
    if (this.source?.id === sourceId) {
      this.source = null;
      this.preview = null;
    }
  }
  cancel(): void {
    cancelWeqBackupRestore(this.root, this.config.cacheBaseDir());
  }

  stageDefaults() {
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
      { parts: ['settings'], conflict: 'overwrite' },
    );
    this.source = null;
    this.preview = null;
    return result;
  }
}
