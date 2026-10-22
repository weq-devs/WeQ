import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { bootstrapWeqBackupFiles } from '../src/bootstrap/backup_startup';
import { buildWeqBackup } from '../src/bootstrap/backup_bundle';
import { stageWeqBackupRestore } from '../src/bootstrap/backup_restore';
import { writeWeqBackupExclusive } from '../src/bootstrap/backup_output';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-files-startup-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const archive = () =>
  buildWeqBackup([
    { path: 'settings/app.json', data: Buffer.from('{"renderTextMarkdown":false}') },
  ]);

it('先应用恢复再创建 UserConfig，沿用现有缓存路径且不初始化 Native', () => {
  const root = fixture(),
    cache = join(root, 'custom-cache');
  mkdirSync(cache);
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ cacheDirOverride: cache, settings: { renderTextMarkdown: true } }),
  );
  stageWeqBackupRestore(root, archive(), { parts: ['settings'], conflict: 'overwrite' });
  const started = bootstrapWeqBackupFiles(root);
  expect(started).toMatchObject({ ok: true, cacheRoot: cache, result: { status: 'applied' } });
  if (!started.ok) throw Error(started.error);
  expect(started.config.getSettings().renderTextMarkdown).toBe(false);
  expect(started.backups.inventory().restore.pending).toBeNull();
  expect(bootstrapWeqBackupFiles(root).result).toBeNull();
});

it('待恢复时根配置无法解析，不猜目录、不构造配置服务、不覆写损坏原件', () => {
  const root = fixture();
  stageWeqBackupRestore(root, archive(), { parts: ['settings'], conflict: 'overwrite' });
  writeFileSync(join(root, 'config.json'), 'synthetic-corrupt-config');
  const started = bootstrapWeqBackupFiles(root);
  expect(started).toMatchObject({ ok: false, config: null, backups: null });
  expect(readFileSync(join(root, 'config.json'), 'utf8')).toBe('synthetic-corrupt-config');
});

it('输出只发布完整 ZIP，不覆盖同名文件，失败只清理自己的中间文件', async () => {
  const root = fixture(),
    output = join(root, 'backup.zip');
  const bytes = archive();
  await writeWeqBackupExclusive(output, bytes);
  expect(readFileSync(output)).toEqual(bytes);
  await expect(writeWeqBackupExclusive(output, Buffer.from('other'))).rejects.toMatchObject({
    code: 'EEXIST',
  });
  expect(readFileSync(output)).toEqual(bytes);
  expect(readdirSync(root)).toEqual(['backup.zip']);
});
