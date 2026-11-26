import { randomUUID } from 'node:crypto';
import {
  constants,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type UserConfig, writeFileAtomicSync } from '@weq/service';
import { accountIsRunning, savedInstanceAccounts } from './account_instances';

const SCOPED_CACHE = [
  'agentlab',
  'anti_recall',
  'collection-history',
  'content-search',
  'db_tolerance',
  'deleted',
  'dress',
  'export',
  'favorite-emoji',
  'intent_sense',
  'roaming-jobs',
];

export function accountStorageMigrationPath(root: string): string {
  return join(root, 'account-storage-migration.json');
}

function metadata(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

function readConfig(path: string): UserConfig {
  const stat = metadata(path);
  if (!stat) return {};
  if (!stat.isFile()) throw new Error('账号设置迁移遇到无法验证的配置文件。');
  const data = JSON.parse(readFileSync(path, 'utf8')) as UserConfig;
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('账号设置迁移遇到无效配置文件。');
  return data;
}

interface MigrationDifference {
  configId: string;
  source: string;
  destination: string;
}

function migrateEntry(source: string, destination: string, difference: () => void): void {
  const from = metadata(source);
  if (!from) return;
  const to = metadata(destination);
  if ((!from.isDirectory() && !from.isFile()) || to) {
    if (from.isFile() && to?.isFile() && from.size === to.size && from.size <= 1024 * 1024) {
      if (readFileSync(source).equals(readFileSync(destination))) return;
    }
    difference();
    return;
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const staging = join(dirname(destination), `.account-migration-${randomUUID()}`);
  try {
    cpSync(source, staging, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => {
        const stat = lstatSync(path);
        if (stat.isDirectory() || stat.isFile()) return true;
        throw new Error(`旧账号状态包含链接或特殊文件：${relative(source, path)}`);
      },
    });
    renameSync(staging, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function addMissing(current: object, source: object): object {
  const result = { ...current };
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(result, key)) {
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else {
      const existing = Reflect.get(result, key);
      if (
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing) &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
      )
        Reflect.set(result, key, addMissing(existing, value));
    }
  }
  return result;
}

/** 在打开账号和维护共享目录之前运行一次，保留原窗口目录。 */
export function migrateAccountStorage(root: string): void {
  const receipt = accountStorageMigrationPath(root);
  if (metadata(receipt)?.isFile()) return;
  const oldRoot = join(root, 'instances');
  const entries = metadata(oldRoot)?.isDirectory()
    ? readdirSync(oldRoot, { withFileTypes: true })
    : [];
  const configPath = join(root, 'config.json');
  const main = readConfig(configPath);
  const settings = { ...main.settings };
  const cache =
    main.cacheDirOverride && isAbsolute(main.cacheDirOverride)
      ? main.cacheDirOverride
      : join(root, 'cache');
  const differences: MigrationDifference[] = [];
  const imported = new Set<string>();

  for (const dir of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dir.isDirectory() || !/^[a-f\d]{24}$/.test(dir.name)) continue;
    const source = join(oldRoot, dir.name, 'data');
    if (!metadata(source)?.isDirectory()) continue;
    const sourceConfig = readConfig(join(source, 'config.json'));
    const sourceCache =
      sourceConfig.cacheDirOverride && isAbsolute(sourceConfig.cacheDirOverride)
        ? sourceConfig.cacheDirOverride
        : join(source, 'cache');
    if (sourceConfig.settings?.oneBotByUin)
      settings.oneBotByUin = {
        ...sourceConfig.settings.oneBotByUin,
        ...settings.oneBotByUin,
      };

    for (const account of savedInstanceAccounts(source)) {
      const { configId } = account;
      if (accountIsRunning(root, account.uin))
        throw new Error('仍有旧账号窗口正在运行，请关闭后重试迁移。');
      const from = join(source, 'config', 'accounts');
      const to = join(root, 'config', 'accounts');
      const file = join(to, `${configId}.json`);
      const original = join(from, `${configId}.json`);
      if (!metadata(original)?.isFile()) continue;
      const old = JSON.parse(readFileSync(original, 'utf8')) as Record<string, unknown>;
      const prior = metadata(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
        : null;
      if (prior && prior.uin !== account.uin) {
        differences.push({ configId, source: original, destination: file });
        continue;
      }
      const {
        qqPid: _pid,
        qqOnline: _online,
        session: _session,
        rkeys: _rkeys,
        rkeyUpdatedAt: _updated,
        clientKey: _key,
        ...durable
      } = old;
      const sourceSettings = prior ? main.settings : sourceConfig.settings;
      const next = prior ? addMissing(prior, durable) : durable;
      if (prior && !isDeepStrictEqual(addMissing(durable, prior), next))
        differences.push({ configId, source: original, destination: file });
      if (!Object.hasOwn(next, 'qqClientSync')) {
        Object.assign(next, {
          qqClientSync: {
            enabled: sourceSettings?.qqClientSyncEnabled === true,
            liveMessages: sourceSettings?.qqLiveMessagesEnabled === true,
          },
        });
      }
      if (!isDeepStrictEqual(prior, next)) writeFileAtomicSync(file, JSON.stringify(next));
      const paths = [
        [join(from, configId), join(to, configId)] as const,
        ...SCOPED_CACHE.map(
          (category) =>
            [join(sourceCache, category, configId), join(cache, category, configId)] as const,
        ),
      ];
      for (const [src, dest] of paths) {
        if (src === dest) continue;
        migrateEntry(src, dest, () =>
          differences.push({ configId, source: src, destination: dest }),
        );
      }
      imported.add(configId);
    }
  }
  if (!isDeepStrictEqual(main.settings ?? {}, settings))
    writeFileAtomicSync(configPath, JSON.stringify({ ...main, settings }, null, 2));
  writeFileAtomicSync(
    receipt,
    JSON.stringify({ version: 1, imported: [...imported], differences }),
  );
}
