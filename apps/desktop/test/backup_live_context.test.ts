// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@weq/service';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

it('恢复默认立即更新同一个全局配置实例；随后的设置写入不覆盖恢复结果', async () => {
  const { initBackupContext, applyLiveBackupContext } = await import(
    '../src/main/context/backup_context'
  );
  const root = mkdtempSync(join(tmpdir(), 'weq-live-defaults-'));
  roots.push(root);
  const files = initBackupContext(root);
  if (!files.ok) throw new Error(files.error);
  const config = files.config;
  config.setSettings({ renderTextMarkdown: !DEFAULT_APP_SETTINGS.renderTextMarkdown });
  files.backups.stageDefaults();
  const result = applyLiveBackupContext();
  expect(result.status).toBe('applied');
  expect(files.config).toBe(config);
  expect(config.getSettings().renderTextMarkdown).toBe(DEFAULT_APP_SETTINGS.renderTextMarkdown);
  expect(files.backups.inventory().restore.pending).toBeNull();
  config.setSettings({ preferCdn: !DEFAULT_APP_SETTINGS.preferCdn });
  config.reload();
  expect(config.getSettings().renderTextMarkdown).toBe(DEFAULT_APP_SETTINGS.renderTextMarkdown);
});
