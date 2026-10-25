import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { writeFileAtomicSync } from '../common/atomic_write';
import {
  buildWeqBackup,
  readWeqBackup,
  parseWeqBackupJson,
  summarizeWeqBackup,
  weqBackupPart,
  isWeqBackupConfigId,
  WEQ_BACKUP_LIMITS,
  WEQ_BACKUP_PARTS,
  type WeqBackupBundle,
  type WeqBackupFile,
  type WeqBackupPart,
  type WeqBackupSummary,
  weqAccountBackupScope,
} from './backup_bundle';
import { validateWeqBackupData } from './backup_data';
import { readWeqBackupFile, relocateWeqCloneAssets } from './backup_clones';
import {
  snapshotWeqAccount,
  snapshotWeqSettings,
  validateWeqAccountSettings,
} from './backup_settings';
import { weqAccountSettingPath } from './backup_accounts';
import {
  WEQ_ACCOUNT_SETTING_FILES,
  isWeqBackgroundName,
  type WeqAccountSettingFile,
} from '../common/backup_account_paths';
import { DEFAULT_APP_SETTINGS } from './user_config';
import type { AccountConfig } from '../account/user_config';
import { validateWeqClientSettings } from '../common/backup_client';

export interface WeqRestoreChoice {
  parts: WeqBackupPart[];
  conflict: 'skip' | 'overwrite';
  accountConfigIds?: string[];
  cloneConfigIds?: string[];
  scopeMap?: Record<string, string>;
  keepLocalPaths?: boolean;
  clientId?: string;
  includeClient?: boolean;
}
export interface WeqRestoreResult {
  id: string;
  status: 'applied' | 'failed';
  completedAt: string;
  applied: string[];
  skipped: string[];
  warnings: string[];
  clientPending: boolean;
  error?: string;
  needsRecovery?: boolean;
}
interface Pending {
  id: string;
  phase: 'writing' | 'ready';
  sha256: string;
  createdAt: string;
  choice: WeqRestoreChoice;
  summary: WeqBackupSummary;
}
interface Operation {
  kind: 'config' | 'client' | 'account' | 'clones' | 'account-setting';
  scope?: string;
  setting?: WeqAccountSettingFile | 'background';
  file?: string;
  hadOriginal: boolean;
  owned: boolean;
  hash: string;
  originalHash?: string;
}
interface Journal {
  id: string;
  cacheRoot: string;
  phase: 'preparing' | 'applying' | 'committed' | 'rolled-back';
  operations: Operation[];
  result: WeqRestoreResult;
}
interface Prepared {
  operation: Operation;
  files: WeqBackupFile[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const stateRoot = (root: string) => join(root, 'restore');
const pendingPath = (root: string) => join(stateRoot(root), 'pending.json');
const journalPath = (root: string) => join(stateRoot(root), 'journal.json');
const resultPath = (root: string) => join(stateRoot(root), 'result.json');
const clientPath = (root: string) => join(stateRoot(root), 'client.json');
const archivePath = (root: string, id: string) => join(stateRoot(root), `${id}.zip`);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF', 'EPERM', 'EACCES'].includes(String(code)))
      throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function ensureDirectory(path: string): void {
  if (present(path)) return;
  const parent = dirname(path);
  if (parent === path) throw new Error('恢复目标根目录不存在');
  ensureDirectory(parent);
  mkdirSync(path, { mode: 0o700 });
  syncDirectory(parent);
}
function move(from: string, to: string): void {
  renameSync(from, to);
  syncDirectory(dirname(from));
  if (dirname(from) !== dirname(to)) syncDirectory(dirname(to));
}
function json(path: string, maxBytes = 4 * 1024 * 1024): unknown {
  return parseWeqBackupJson(readWeqBackupFile(path, maxBytes));
}
function save(path: string, value: unknown): void {
  writeFileAtomicSync(path, JSON.stringify(value));
  syncDirectory(dirname(path));
}
function validateChoice(value: unknown): asserts value is WeqRestoreChoice {
  if (
    !record(value) ||
    !Array.isArray(value.parts) ||
    !value.parts.length ||
    value.parts.length > WEQ_BACKUP_PARTS.length ||
    new Set(value.parts).size !== value.parts.length ||
    value.parts.some((part) => !WEQ_BACKUP_PARTS.includes(part)) ||
    (value.conflict !== 'skip' && value.conflict !== 'overwrite')
  )
    throw new Error('无效的恢复选择');
  for (const key of ['accountConfigIds', 'cloneConfigIds'])
    if (
      value[key] !== undefined &&
      (!Array.isArray(value[key]) ||
        value[key].some((id) => typeof id !== 'string' || !isWeqBackupConfigId(id)))
    )
      throw new Error('无效的恢复数据域');
  if (value.keepLocalPaths !== undefined && typeof value.keepLocalPaths !== 'boolean')
    throw new Error('无效的机器路径选择');
  if (value.includeClient !== undefined && typeof value.includeClient !== 'boolean')
    throw new Error('无效的界面偏好选择');
  if (
    value.clientId !== undefined &&
    (typeof value.clientId !== 'string' || !UUID.test(value.clientId))
  )
    throw new Error('无效的界面恢复设备标识');
  if (value.scopeMap !== undefined) {
    if (!record(value.scopeMap)) throw new Error('无效的数据域映射');
    for (const [source, target] of Object.entries(value.scopeMap))
      if (
        !isWeqBackupConfigId(source) ||
        typeof target !== 'string' ||
        !isWeqBackupConfigId(target) ||
        source.split('_')[0] !== target.split('_')[0]
      )
        throw new Error('只允许映射到同 QQ 号的数据域');
  }
}
function validateResult(value: unknown): asserts value is WeqRestoreResult {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !UUID.test(value.id) ||
    (value.status !== 'applied' && value.status !== 'failed') ||
    !Array.isArray(value.applied) ||
    !Array.isArray(value.skipped) ||
    !Array.isArray(value.warnings) ||
    typeof value.clientPending !== 'boolean' ||
    typeof value.completedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    (value.error !== undefined && typeof value.error !== 'string') ||
    (value.needsRecovery !== undefined && typeof value.needsRecovery !== 'boolean') ||
    [...value.applied, ...value.skipped, ...value.warnings].some((item) => typeof item !== 'string')
  )
    throw new Error('恢复回执无效');
}
function validateSummary(value: unknown): void {
  if (
    !record(value) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.parts) ||
    !Array.isArray(value.accountConfigIds) ||
    !Array.isArray(value.cloneConfigIds) ||
    !Array.isArray(value.warnings)
  )
    throw new Error('暂存恢复摘要无效');
  for (const part of value.parts)
    if (
      !record(part) ||
      !WEQ_BACKUP_PARTS.includes(part.part as WeqBackupPart) ||
      typeof part.files !== 'number' ||
      !Number.isSafeInteger(part.files) ||
      part.files < 0 ||
      part.files > WEQ_BACKUP_LIMITS.maxEntries ||
      typeof part.bytes !== 'number' ||
      !Number.isSafeInteger(part.bytes) ||
      part.bytes < 0 ||
      part.bytes > WEQ_BACKUP_LIMITS.maxTotalBytes
    )
      throw new Error('暂存恢复摘要无效');
  if (
    [...value.accountConfigIds, ...value.cloneConfigIds].some(
      (id) => typeof id !== 'string' || !isWeqBackupConfigId(id),
    ) ||
    value.warnings.some((warning) => typeof warning !== 'string')
  )
    throw new Error('暂存恢复摘要无效');
}
function readPending(root: string): Pending | null {
  if (!present(pendingPath(root))) return null;
  const value = json(pendingPath(root));
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !UUID.test(value.id) ||
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !record(value.choice) ||
    !Array.isArray(value.choice.parts) ||
    value.choice.parts.some((part) => !WEQ_BACKUP_PARTS.includes(part)) ||
    (value.choice.conflict !== 'skip' && value.choice.conflict !== 'overwrite') ||
    !record(value.summary)
  )
    throw new Error('暂存恢复记录无效，未修改数据');
  if (value.phase !== 'writing' && value.phase !== 'ready') throw new Error('暂存恢复阶段无效');
  validateChoice(value.choice);
  validateSummary(value.summary);
  return value as unknown as Pending;
}
function readResult(root: string): WeqRestoreResult | null {
  if (!present(resultPath(root))) return null;
  const value = json(resultPath(root));
  validateResult(value);
  return value;
}
function readJournal(root: string): Journal | null {
  if (!present(journalPath(root))) return null;
  const value = json(journalPath(root));
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !UUID.test(value.id) ||
    typeof value.cacheRoot !== 'string' ||
    !['preparing', 'applying', 'committed', 'rolled-back'].includes(String(value.phase)) ||
    !Array.isArray(value.operations) ||
    !record(value.result) ||
    value.result.id !== value.id
  )
    throw new Error('恢复事务记录无效，原始数据已保留');
  validateResult(value.result);
  if (value.operations.length > WEQ_BACKUP_LIMITS.maxEntries) throw new Error('恢复事务目标过多');
  const seen = new Set<string>();
  for (const item of value.operations) {
    if (
      !record(item) ||
      !['config', 'client', 'account', 'clones', 'account-setting'].includes(String(item.kind)) ||
      typeof item.hadOriginal !== 'boolean' ||
      typeof item.owned !== 'boolean' ||
      typeof item.hash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(item.hash)
    )
      throw new Error('恢复事务目标无效');
    if (
      item.originalHash !== undefined &&
      (typeof item.originalHash !== 'string' || !/^[0-9a-f]{64}$/.test(item.originalHash))
    )
      throw new Error('恢复事务原始配置校验无效');
    if (
      item.kind === 'account' || item.kind === 'clones' || item.kind === 'account-setting'
        ? typeof item.scope !== 'string' || !isWeqBackupConfigId(item.scope)
        : item.scope !== undefined
    )
      throw new Error('恢复事务目标无效');
    if (item.kind === 'account-setting') {
      if (item.setting === 'background') {
        if (typeof item.file !== 'string' || !isWeqBackgroundName(item.file))
          throw new Error('恢复背景目标无效');
      } else if (
        !WEQ_ACCOUNT_SETTING_FILES.includes(item.setting as WeqAccountSettingFile) ||
        item.file !== undefined
      )
        throw new Error('恢复偏好目标无效');
    } else if (item.setting !== undefined || item.file !== undefined)
      throw new Error('恢复事务目标无效');
    const key = operationLabel(item as unknown as Operation);
    if (seen.has(key)) throw new Error('恢复事务目标重复');
    seen.add(key);
  }
  return value as unknown as Journal;
}

function target(root: string, cacheRoot: string, op: Operation): string {
  if (op.kind === 'config') return join(root, 'config.json');
  if (op.kind === 'client') return clientPath(root);
  if (op.kind === 'account') return join(root, 'config', 'accounts', `${op.scope}.json`);
  if (op.kind === 'account-setting')
    return op.setting === 'background'
      ? join(root, 'config', 'accounts', op.scope!, op.file!)
      : weqAccountSettingPath(root, cacheRoot, op.scope!, op.setting as WeqAccountSettingFile);
  return join(cacheRoot, 'agentlab', op.scope!);
}
function operationLabel(op: Pick<Operation, 'kind' | 'scope' | 'setting' | 'file'>): string {
  return [op.kind, op.scope, op.setting, op.file].filter((part) => part !== undefined).join(':');
}
function work(root: string, cacheRoot: string, id: string, op: Operation): string {
  return join(
    dirname(target(root, cacheRoot, op)),
    `.weq-restore-${id}-${operationLabel(op).replaceAll(':', '-')}`,
  );
}
function actual(path: string, directory: boolean): boolean {
  if (!present(path)) return false;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
    throw new Error('恢复目标不是可原子替换的普通文件或目录，原件未改动');
  return true;
}
function treeHash(files: readonly WeqBackupFile[]): string {
  return digest(
    Buffer.from(
      JSON.stringify(
        files
          .map((file) => [file.path.normalize('NFC'), file.data.length, digest(file.data)])
          .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0)),
      ),
    ),
  );
}
function installedHash(path: string, directory: boolean): string {
  if (!actual(path, directory)) throw new Error('恢复目标缺失，未改写其他路径');
  if (!directory) return digest(readWeqBackupFile(path));
  const files: WeqBackupFile[] = [];
  let size = 0;
  const visit = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const file = join(folder, name),
        stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('恢复目标出现未预期的链接，已保留现场');
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) {
        size += stat.size;
        if (size > WEQ_BACKUP_LIMITS.maxTotalBytes || files.length >= WEQ_BACKUP_LIMITS.maxEntries)
          throw new Error('恢复目标出现未预期的数据，已保留现场');
        files.push({
          path: relative(path, file).split('\\').join('/'),
          data: readWeqBackupFile(file),
        });
      } else throw new Error('恢复目标出现未预期的数据类型');
    }
  };
  visit(path);
  return treeHash(files);
}

function writePreparedFile(path: string, data: Buffer): void {
  ensureDirectory(dirname(path));
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function merge(current: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const out = record(current) ? { ...current } : {};
  for (const [key, value] of Object.entries(patch))
    out[key] = record(value) ? merge(out[key], value) : structuredClone(value);
  return out;
}
function mergeRows(
  current: unknown,
  incoming: unknown,
  conflict: WeqRestoreChoice['conflict'],
  skipped: string[],
  label: string,
): unknown[] {
  const rows = new Map<string, Record<string, unknown>>();
  if (Array.isArray(current))
    for (const row of current) if (record(row) && typeof row.id === 'string') rows.set(row.id, row);
  if (Array.isArray(incoming))
    for (const row of incoming)
      if (record(row) && typeof row.id === 'string') {
        if (conflict === 'skip' && rows.has(row.id)) skipped.push(`${label}:${row.id}`);
        else rows.set(row.id, row);
      }
  return [...rows.values()];
}
function mappedScope(choice: WeqRestoreChoice, source: string): string {
  return choice.scopeMap && Object.hasOwn(choice.scopeMap, source)
    ? choice.scopeMap[source]!
    : source;
}
function mappingRecords(root: string, bundle: WeqBackupBundle, choice: WeqRestoreChoice) {
  const sources = new Set(
    bundle.files.flatMap((file) =>
      file.path.startsWith('accounts/')
        ? [weqAccountBackupScope(file.path)]
        : file.path.startsWith('clones/')
          ? [file.path.split('/')[1]!]
          : [],
    ),
  );
  const targets = new Set<string>();
  const records = new Map<string, { account: AccountConfig; hash: string }>();
  for (const source of sources) {
    const scope = mappedScope(choice, source);
    if (targets.has(scope)) throw new Error('多个来源不能映射到同一数据域，请分别恢复');
    targets.add(scope);
    if (scope === source) continue;
    const path = join(root, 'config', 'accounts', `${scope}.json`);
    if (!actual(path, false)) throw new Error('映射目标必须是本机已有的同 QQ 号账号配置');
    const data = readWeqBackupFile(path),
      value = parseWeqBackupJson(data);
    validateWeqAccountSettings(value, scope);
    records.set(source, { account: value, hash: digest(data) });
  }
  return records;
}
function mappedAccount(source: AccountConfig, local: AccountConfig): AccountConfig {
  const merged: Record<string, unknown> = { ...local, ...source };
  for (const key of [
    'mailNotifications',
    'mailShowUnread',
    'annualReport',
    'groupKeyword',
    'nativeMediaEnabled',
    'homeDress',
    'vip',
    'vipCheckedAt',
  ])
    if (!Object.hasOwn(source, key)) delete merged[key];
  for (const key of [
    'configId',
    'uin',
    'uid',
    'dbKey',
    'algos',
    'dataDir',
    'backupAccountDir',
    'static',
    'mobile',
    'nativeMediaDir',
    'guid',
    'displayName',
    'avatarUrl',
    'lastLoginAt',
    'qqOnline',
    'qqPid',
    'session',
    'a1Payload',
    'rkeys',
    'rkeyUpdatedAt',
    'clientKey',
    'loginPskey',
  ] as const)
    merged[key] = local[key];
  return merged as unknown as AccountConfig;
}
function configPlan(
  current: Record<string, unknown>,
  files: readonly WeqBackupFile[],
  choice: WeqRestoreChoice,
  skipped: string[],
): Record<string, unknown> | null {
  const app = files.find((file) => file.path === 'settings/app.json');
  const api = files.find((file) => file.path === 'api/settings.json');
  const presets = files.find((file) => file.path === 'settings/export-presets.json');
  if (!app && !api && !presets) return null;
  let settings = record(current.settings) ? structuredClone(current.settings) : {};
  if (app) {
    settings = merge(
      merge(settings, snapshotWeqSettings(DEFAULT_APP_SETTINGS)),
      parseWeqBackupJson(app.data) as Record<string, unknown>,
    );
    if (choice.keepLocalPaths !== false) {
      const local = record(current.settings) ? current.settings : {};
      settings.defaultExportDir =
        typeof local.defaultExportDir === 'string' ? local.defaultExportDir : null;
      settings.exportSaveMode =
        typeof local.exportSaveMode === 'string'
          ? local.exportSaveMode
          : DEFAULT_APP_SETTINGS.exportSaveMode;
      settings.externalChatpic = merge(settings.externalChatpic, {
        dir:
          record(local.externalChatpic) && typeof local.externalChatpic.dir === 'string'
            ? local.externalChatpic.dir
            : '',
      });
    }
  }
  if (api) {
    const value = parseWeqBackupJson(api.data) as Record<string, unknown>;
    const base = structuredClone(settings);
    settings = merge(settings, value);
    if (record(value.agentLab))
      settings.agentLab = {
        providers: mergeRows(
          record(base.agentLab) ? base.agentLab.providers : [],
          value.agentLab.providers,
          choice.conflict,
          skipped,
          'api:llm',
        ),
      };
    if (value.ttsProviders !== undefined) {
      settings.voiceTranscribe = merge(base.voiceTranscribe, {
        ttsProviders: mergeRows(
          record(base.voiceTranscribe) ? base.voiceTranscribe.ttsProviders : [],
          value.ttsProviders,
          choice.conflict,
          skipped,
          'api:tts',
        ),
      });
      delete settings.ttsProviders;
    }
    for (const key of ['externalRkey', 'ssePush'])
      if (record(value[key])) {
        const source = value[key],
          previous = record(base[key]) ? base[key] : {};
        settings[key] = {
          ...source,
          servers: mergeRows(
            previous.servers,
            source.servers,
            choice.conflict,
            skipped,
            `api:${key}`,
          ),
        };
      }
    if (value.mcp !== undefined && base.mcp !== undefined && choice.conflict === 'skip') {
      settings.mcp = base.mcp;
      skipped.push('api:mcp');
    }
  }
  return {
    ...current,
    settings,
    ...(presets ? { exportPresets: parseWeqBackupJson(presets.data) } : {}),
  };
}

function prepare(
  root: string,
  cacheRoot: string,
  pending: Pending,
  bundle: WeqBackupBundle,
): { plans: Prepared[]; result: WeqRestoreResult } {
  const plans: Prepared[] = [];
  const result: WeqRestoreResult = {
    id: pending.id,
    status: 'applied',
    completedAt: new Date().toISOString(),
    applied: [],
    skipped: [],
    warnings: summarizeWeqBackup(bundle).warnings.slice(0, 200),
    clientPending: false,
  };
  const needsGlobal = bundle.files.some((file) => file.path !== 'settings/client.json');
  const hasConfig = needsGlobal && present(join(root, 'config.json'));
  const original = hasConfig ? readWeqBackupFile(join(root, 'config.json')) : Buffer.from('{}');
  const currentConfig = parseWeqBackupJson(original);
  if (!record(currentConfig)) throw new Error('当前全局配置不是有效对象，未覆盖原件');
  const mappings = mappingRecords(root, bundle, pending.choice);
  const add = (
    kind: Operation['kind'],
    files: WeqBackupFile[],
    scope?: string,
    details: Pick<Operation, 'setting' | 'file' | 'originalHash'> = {},
  ) => {
    const op: Operation = {
      kind,
      ...(scope ? { scope } : {}),
      ...details,
      hadOriginal: false,
      owned: false,
      hash: kind === 'clones' ? treeHash(files) : digest(files[0]!.data),
    };
    op.hadOriginal = actual(target(root, cacheRoot, op), kind === 'clones');
    if (kind === 'config') {
      if (op.hadOriginal !== hasConfig) throw new Error('本机配置在准备期间发生变化，请重新预览');
      if (hasConfig) op.originalHash = digest(original);
    }
    const label = operationLabel(op);
    if (kind === 'clones' && op.hadOriginal && pending.choice.conflict === 'skip') {
      result.skipped.push(label);
      return;
    }
    result.applied.push(label);
    plans.push({ operation: op, files });
  };
  let config = configPlan(currentConfig, bundle.files, pending.choice, result.skipped);
  const accountFiles = bundle.files.filter((file) => file.path.startsWith('accounts/'));
  const hasClones = bundle.files.some((file) => file.path.startsWith('clones/'));
  const existingConfig = config ?? currentConfig;
  const client = bundle.files.find((file) => file.path === 'settings/client.json');
  if (client) {
    add('client', [
      {
        path: '',
        data: Buffer.from(
          JSON.stringify({
            id: pending.id,
            values: parseWeqBackupJson(client.data),
            ...(pending.choice.clientId ? { clientId: pending.choice.clientId } : {}),
          }),
        ),
      },
    ]);
    result.clientPending = true;
  }
  for (const file of accountFiles) {
    const sourceScope = weqAccountBackupScope(file.path),
      scope = mappedScope(pending.choice, sourceScope),
      parts = file.path.split('/');
    if (parts.length === 2) {
      let value = snapshotWeqAccount(parseWeqBackupJson(file.data) as unknown as AccountConfig);
      const local = mappings.get(sourceScope);
      if (local) value = mappedAccount(value, local.account);
      add(
        'account',
        [{ path: '', data: Buffer.from(JSON.stringify(value)) }],
        scope,
        local ? { originalHash: local.hash } : {},
      );
    } else {
      const setting =
        parts[2] === 'background' ? 'background' : (parts[2] as WeqAccountSettingFile);
      add('account-setting', [{ path: '', data: file.data }], scope, {
        setting,
        ...(setting === 'background' ? { file: parts[3]! } : {}),
      });
    }
  }
  for (const scope of new Set(
    bundle.files
      .filter((file) => file.path.startsWith('clones/'))
      .map((file) => file.path.split('/')[1]!),
  )) {
    const prefix = `clones/${scope}/`,
      destination = mappedScope(pending.choice, scope);
    add(
      'clones',
      bundle.files
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => ({
          path: file.path.slice(prefix.length),
          data: relocateWeqCloneAssets(
            { ...file, path: file.path.replace(prefix, `clones/${destination}/`) },
            join(cacheRoot, 'agentlab'),
          ).data,
        })),
      destination,
    );
  }
  if (pending.choice.conflict === 'skip') {
    const blocked = new Set(
      plans
        .filter(
          (plan) =>
            (plan.operation.kind === 'account' || plan.operation.kind === 'account-setting') &&
            plan.operation.hadOriginal,
        )
        .map((plan) => plan.operation.scope!),
    );
    for (const scope of blocked) {
      const labels = new Set(
        plans
          .filter(
            (plan) =>
              (plan.operation.kind === 'account' || plan.operation.kind === 'account-setting') &&
              plan.operation.scope === scope,
          )
          .map((plan) => operationLabel(plan.operation)),
      );
      for (let index = plans.length - 1; index >= 0; index--)
        if (labels.has(operationLabel(plans[index]!.operation))) plans.splice(index, 1);
      result.applied = result.applied.filter((label) => !labels.has(label));
      result.skipped.push(`account:${scope}`);
    }
  }
  const autoEnter = existingConfig.autoEnter;
  if (
    record(autoEnter) &&
    plans.some(
      (plan) =>
        (plan.operation.kind === 'account' || plan.operation.kind === 'account-setting') &&
        plan.operation.scope === autoEnter.configId,
    )
  )
    config = { ...existingConfig, autoEnter: null };
  for (const [source, mapped] of mappings)
    result.warnings.push(`${source} 将恢复到 ${mapped.account.configId}，保留本机接入信息。`);
  if (result.applied.some((label) => label.startsWith('account:')))
    result.warnings.push('账号配置不包含 QQ 数据库，原数据目录引用可能需要在本机重新选择。');
  if (hasClones || plans.some((plan) => plan.operation.kind === 'account-setting')) {
    const settings = record(existingConfig?.settings) ? existingConfig.settings : {};
    const agent = record(settings.agentLab) ? settings.agentLab : {};
    const voice = record(settings.voiceTranscribe) ? settings.voiceTranscribe : {};
    const providerIds = new Set(
      Array.isArray(agent.providers)
        ? agent.providers.filter(record).map((provider) => provider.id)
        : [],
    );
    const ttsIds = new Set(
      Array.isArray(voice.ttsProviders)
        ? voice.ttsProviders.filter(record).map((provider) => provider.id)
        : [],
    );
    for (const plan of plans.filter((plan) => plan.operation.kind === 'account-setting')) {
      const setting = plan.operation.setting;
      if (setting !== 'intent.json' && setting !== 'dress.json') continue;
      const value = parseWeqBackupJson(plan.files[0]!.data);
      if (!record(value)) continue;
      if (
        setting === 'intent.json' &&
        ['providerRef', 'profileProviderRef', 'suggestionProviderRef'].some((key) => {
          const ref = value[key];
          return (
            record(ref) &&
            (!providerIds.has(ref.providerId) || typeof ref.model !== 'string' || !ref.model.trim())
          );
        })
      )
        result.warnings.push(
          `${plan.operation.scope} 的意图／画像／推荐回复有未配置的模型引用，未自动替换提供方。`,
        );
      if (
        setting === 'dress.json' &&
        ['installedBubbles', 'installedFonts', 'installedWidgets'].some(
          (key) => Array.isArray(value[key]) && value[key].length,
        )
      )
        result.warnings.push(
          `${plan.operation.scope} 的装扮选择已包含，QQ 气泡、字体与挂件资源需在本机重新获取。`,
        );
    }
    for (const file of bundle.files.filter(
      (file) => file.path.startsWith('clones/') && file.path.endsWith('.json'),
    )) {
      if (
        result.skipped.includes(`clones:${mappedScope(pending.choice, file.path.split('/')[1]!)}`)
      )
        continue;
      const value = parseWeqBackupJson(file.data);
      if (!record(value)) continue;
      const persona = record(value.persona) ? value.persona : null;
      const models =
        persona && record(persona.models)
          ? Object.values(persona.models)
          : file.path.endsWith('/assistant.json') && record(value.model)
            ? [value.model]
            : [];
      if (
        models.some(
          (ref) =>
            record(ref) &&
            (!ref.providerId ||
              !providerIds.has(ref.providerId) ||
              typeof ref.model !== 'string' ||
              !ref.model.trim()),
        )
      )
        result.warnings.push(`${file.path} 有未配置的模型引用，未自动替换提供方。`);
      if (persona && record(persona.voice) && !ttsIds.has(persona.voice.providerId))
        result.warnings.push(`${file.path} 有未配置的语音服务商引用。`);
    }
  }
  const warnings = [...new Set(result.warnings)];
  result.warnings =
    warnings.length > 200
      ? [...warnings.slice(0, 200), `另有 ${warnings.length - 200} 条警告未展开。`]
      : warnings;
  if (config) add('config', [{ path: '', data: Buffer.from(JSON.stringify(config)) }]);
  return { plans, result };
}

export function previewWeqBackupRestore(
  appRoot: string,
  cacheBase: string,
  archive: Buffer,
  choice: WeqRestoreChoice,
) {
  validateChoice(choice);
  const source = readWeqBackup(archive);
  const files = selectFiles(source, choice);
  const bundle = { manifest: source.manifest, files };
  validateWeqBackupData(bundle);
  const pending: Pending = {
    id: randomUUID(),
    phase: 'ready',
    sha256: digest(archive),
    createdAt: new Date().toISOString(),
    choice,
    summary: summarizeWeqBackup(bundle),
  };
  const prepared = prepare(resolve(appRoot), resolve(cacheBase), pending, bundle);
  return {
    summary: pending.summary,
    planned: prepared.result.applied,
    skipped: prepared.result.skipped,
    warnings: prepared.result.warnings,
  };
}

function selectFiles(source: WeqBackupBundle, choice: WeqRestoreChoice): WeqBackupFile[] {
  const files = source.files.filter((file) => {
    if (file.path === 'settings/client.json' && choice.includeClient === false) return false;
    const part = weqBackupPart(file.path);
    if (!choice.parts.includes(part)) return false;
    if (part === 'accounts' && choice.accountConfigIds)
      return choice.accountConfigIds.includes(weqAccountBackupScope(file.path));
    if (part === 'clones' && choice.cloneConfigIds)
      return choice.cloneConfigIds.includes(file.path.split('/')[1]!);
    return true;
  });
  if (!files.length) throw new Error('没有选择可恢复的数据');
  return files;
}

export function stageWeqBackupRestore(
  appRoot: string,
  archive: Buffer,
  choice: WeqRestoreChoice,
): { id: string; summary: WeqBackupSummary } {
  const root = resolve(appRoot);
  if (present(pendingPath(root)) || present(journalPath(root)) || present(clientPath(root)))
    throw new Error('已有待应用或待确认的恢复，请先完成或取消');
  validateChoice(choice);
  const source = readWeqBackup(archive);
  const files = selectFiles(source, choice);
  const bundle = { manifest: source.manifest, files };
  validateWeqBackupData(bundle);
  mappingRecords(root, bundle, choice);
  const selected = buildWeqBackup(files, source.manifest.createdAt);
  const id = randomUUID();
  const pending: Pending = {
    id,
    phase: 'writing',
    createdAt: new Date().toISOString(),
    sha256: digest(selected),
    choice,
    summary: summarizeWeqBackup(bundle),
  };
  ensureDirectory(stateRoot(root));
  save(pendingPath(root), pending);
  writeFileAtomicSync(archivePath(root, id), selected);
  pending.phase = 'ready';
  save(pendingPath(root), pending);
  return { id, summary: pending.summary };
}

function rollback(root: string, cacheRoot: string, journal: Journal): void {
  for (const op of [...journal.operations].reverse()) {
    const directory = work(root, cacheRoot, journal.id, op),
      before = join(directory, 'before'),
      next = join(directory, 'next'),
      current = target(root, cacheRoot, op);
    if (!op.owned) {
      const owner = present(join(directory, 'owner.json'))
        ? json(join(directory, 'owner.json'))
        : null;
      if (
        record(owner) &&
        owner.id === journal.id &&
        owner.kind === op.kind &&
        owner.scope === op.scope &&
        owner.setting === op.setting &&
        owner.file === op.file
      )
        op.owned = true;
      else {
        if (present(before)) throw new Error('恢复前数据的工作区标记缺失，已保留现场');
        continue;
      }
    }
    const hasBefore = present(before),
      hasCurrent = present(current);
    if (hasBefore || (!op.hadOriginal && hasCurrent)) {
      if (hasCurrent) {
        if (present(next) || installedHash(current, op.kind === 'clones') !== op.hash)
          throw new Error('恢复后的目标已变化，已保留原始数据与现场，未覆盖新变化');
        move(current, next);
      }
      if (hasBefore) move(before, current);
    }
  }
  journal.phase = 'rolled-back';
  save(journalPath(root), journal);
}
function cleanWork(root: string, cacheRoot: string, journal: Journal): void {
  for (const op of journal.operations)
    if (op.owned) rmSync(work(root, cacheRoot, journal.id, op), { recursive: true, force: true });
}
function finalize(root: string, cacheRoot: string, journal: Journal): WeqRestoreResult {
  const pending = readPending(root);
  if (pending && pending.id !== journal.id)
    throw new Error('暂存恢复目标已改变，未删除其他恢复数据');
  const previous = readResult(root);
  if (previous?.id === journal.id && previous.status === 'applied' && !previous.clientPending)
    journal.result.clientPending = false;
  save(resultPath(root), journal.result);
  cleanWork(root, cacheRoot, journal);
  rmSync(archivePath(root, journal.id), { force: true });
  rmSync(pendingPath(root), { force: true });
  rmSync(journalPath(root), { force: true });
  return journal.result;
}
function finalizeCommitted(root: string, cacheRoot: string, journal: Journal): WeqRestoreResult {
  try {
    return finalize(root, cacheRoot, journal);
  } catch (error) {
    const result = {
      ...journal.result,
      warnings: [
        ...journal.result.warnings,
        `恢复已应用，暂存清理尚未完成：${error instanceof Error ? error.message : String(error)}`,
      ],
    };
    try {
      save(resultPath(root), result);
    } catch {
      /* committed 事务记录仍是实际已应用的依据。 */
    }
    return result;
  }
}

/** 仅在服务构造前执行。原目录通过同卷 rename 暂存，异常或断电可按事务记录回滚。 */
export function applyPendingWeqBackupRestore(
  appRoot: string,
  cacheBase: string,
): WeqRestoreResult | null {
  const root = resolve(appRoot),
    cacheRoot = resolve(cacheBase);
  let journal = readJournal(root);
  if (journal) {
    if (journal.cacheRoot !== cacheRoot) throw new Error('恢复目标缓存根已改变，已保留事务现场');
    if (journal.phase === 'committed') return finalizeCommitted(root, cacheRoot, journal);
    const interrupted = journal.phase !== 'rolled-back';
    if (interrupted) {
      try {
        rollback(root, cacheRoot, journal);
      } catch (error) {
        const result: WeqRestoreResult = {
          ...journal.result,
          completedAt: new Date().toISOString(),
          status: 'failed',
          applied: [],
          clientPending: false,
          needsRecovery: true,
          error: `上次恢复中断，回滚尚未完成：${error instanceof Error ? error.message : String(error)}`,
        };
        save(resultPath(root), result);
        return result;
      }
    }
    const previous = readResult(root);
    const result: WeqRestoreResult = {
      ...journal.result,
      ...(previous?.id === journal.id && previous.status === 'failed' ? previous : {}),
      ...(interrupted ? { completedAt: new Date().toISOString() } : {}),
      status: 'failed',
      applied: [],
      clientPending: false,
      needsRecovery: false,
      error:
        previous?.id === journal.id && !previous.needsRecovery
          ? previous.error
          : '上次恢复中断，已回滚；请取消暂存后重新导入',
    };
    save(resultPath(root), result);
    return result;
  }
  const pending = readPending(root);
  const lastResult = readResult(root);
  if (!pending || (lastResult?.id === pending.id && lastResult.status === 'failed')) return null;
  let result: WeqRestoreResult = {
    id: pending.id,
    status: 'failed',
    completedAt: new Date().toISOString(),
    applied: [],
    skipped: [],
    warnings: [],
    clientPending: false,
  };
  try {
    if (pending.phase !== 'ready')
      throw new Error('上次暂存未完成，未修改当前数据；请取消后重新导入');
    const bytes = readWeqBackupFile(
      archivePath(root, pending.id),
      WEQ_BACKUP_LIMITS.maxArchiveBytes,
    );
    if (digest(bytes) !== pending.sha256) throw new Error('暂存备份内容校验失败');
    const bundle = readWeqBackup(bytes);
    validateWeqBackupData(bundle);
    if (
      bundle.files.some(
        (file) =>
          weqBackupPart(file.path) === 'clones' ||
          (file.path.startsWith('accounts/') &&
            ['anti-recall.json', 'intent.json', 'tolerance.json'].includes(
              file.path.split('/')[2] ?? '',
            )),
      ) &&
      !existsSync(cacheRoot)
    ) {
      if (cacheRoot !== join(root, 'cache')) throw new Error('目标缓存根不可用，未创建替代目录');
      ensureDirectory(cacheRoot);
    }
    const prepared = prepare(root, cacheRoot, pending, bundle);
    result = prepared.result;
    journal = {
      id: pending.id,
      cacheRoot,
      phase: 'preparing',
      operations: prepared.plans.map((plan) => plan.operation),
      result,
    };
    save(journalPath(root), journal);
    for (const plan of prepared.plans) {
      const op = plan.operation,
        directory = work(root, cacheRoot, pending.id, op);
      ensureDirectory(dirname(directory));
      const volume = statfsSync(dirname(directory));
      const size = plan.files.reduce((sum, file) => sum + file.data.length, 0);
      if (volume.bavail * volume.bsize < size + 16 * 1024 * 1024)
        throw new Error('恢复目标空间不足，未替换当前数据');
      mkdirSync(directory, { mode: 0o700 });
      syncDirectory(dirname(directory));
      save(join(directory, 'owner.json'), {
        id: pending.id,
        kind: op.kind,
        ...(op.scope ? { scope: op.scope } : {}),
        ...(op.setting ? { setting: op.setting } : {}),
        ...(op.file ? { file: op.file } : {}),
      });
      op.owned = true;
      if (op.kind === 'clones') ensureDirectory(join(directory, 'next'));
      const directories = new Set<string>();
      for (const file of plan.files) {
        const path = join(directory, 'next', ...(file.path ? file.path.split('/') : []));
        writePreparedFile(path, file.data);
        directories.add(dirname(path));
      }
      for (const path of directories) syncDirectory(path);
      if (installedHash(join(directory, 'next'), op.kind === 'clones') !== op.hash)
        throw new Error('恢复暂存写入校验失败，当前数据未替换');
    }
    journal.phase = 'applying';
    save(journalPath(root), journal);
    for (const op of journal.operations) {
      const directory = work(root, cacheRoot, pending.id, op),
        current = target(root, cacheRoot, op);
      if (actual(current, op.kind === 'clones') !== op.hadOriginal)
        throw new Error('恢复目标在准备期间发生变化，已停止替换');
      if (op.originalHash && digest(readWeqBackupFile(current)) !== op.originalHash)
        throw new Error('本机配置在准备期间发生变化，未覆盖新修改');
      if (op.hadOriginal) move(current, join(directory, 'before'));
      move(join(directory, 'next'), current);
      if (installedHash(current, op.kind === 'clones') !== op.hash)
        throw new Error('恢复写入校验失败');
      if (
        op.originalHash &&
        digest(readWeqBackupFile(join(directory, 'before'))) !== op.originalHash
      )
        throw new Error('本机配置在替换期间发生变化，已停止提交');
    }
    journal.phase = 'committed';
    journal.result.completedAt = new Date().toISOString();
    save(journalPath(root), journal);
    return finalizeCommitted(root, cacheRoot, journal);
  } catch (error) {
    result = {
      ...result,
      status: 'failed',
      applied: [],
      clientPending: false,
      error: error instanceof Error ? error.message : String(error),
    };
    if (journal) {
      try {
        if (journal.phase === 'committed') {
          const stored = readJournal(root);
          journal.phase = 'applying';
          if (stored?.id === journal.id && stored.phase === 'committed')
            save(journalPath(root), journal);
        }
        rollback(root, cacheRoot, journal);
      } catch (recovery) {
        result.needsRecovery = true;
        result.error = `${result.error ?? '恢复失败'}；回滚未完成：${recovery instanceof Error ? recovery.message : String(recovery)}`;
      }
    }
    result.completedAt = new Date().toISOString();
    save(resultPath(root), result);
    return result;
  }
}

export function weqBackupRestoreStatus(appRoot: string) {
  const root = resolve(appRoot);
  const pending = readPending(root);
  return {
    pending: pending ? { id: pending.id, phase: pending.phase, summary: pending.summary } : null,
    result: readResult(root),
  };
}

export function hasPendingWeqBackupRestore(appRoot: string): boolean {
  const root = resolve(appRoot);
  return present(pendingPath(root)) || present(journalPath(root));
}

/** 根配置可能已被同卷移至 before；只读取已校验事务内的原件，不猜缓存目录。 */
export function readWeqRestoreStartupConfig(appRoot: string): Buffer | null {
  const root = resolve(appRoot),
    current = join(root, 'config.json');
  if (present(current)) return readWeqBackupFile(current);
  const journal = readJournal(root);
  const operation = journal?.operations.find((op) => op.kind === 'config' && op.hadOriginal);
  if (!journal || !operation) return null;
  const before = join(work(root, journal.cacheRoot, journal.id, operation), 'before');
  if (!present(before)) throw new Error('恢复现场缺少原始全局配置，未猜测缓存目录');
  const bytes = readWeqBackupFile(before);
  if (!operation.originalHash || digest(bytes) !== operation.originalHash)
    throw new Error('恢复现场原始全局配置校验失败');
  return bytes;
}

export function pendingWeqClientSettings(
  appRoot: string,
  clientId?: string,
  allowOtherClient = false,
): { id: string; values: Record<string, string>; clientId?: string } | null {
  const root = resolve(appRoot);
  if (!present(clientPath(root))) return null;
  const value = json(clientPath(root), WEQ_BACKUP_LIMITS.maxEntryBytes);
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !UUID.test(value.id) ||
    !record(value.values)
  )
    throw new Error('待恢复界面偏好无效');
  validateWeqClientSettings(value.values);
  if (
    value.clientId !== undefined &&
    (typeof value.clientId !== 'string' || !UUID.test(value.clientId))
  )
    throw new Error('待恢复界面设备标识无效');
  const result = readResult(root),
    journal = readJournal(root);
  if (journal?.id === value.id && journal.phase !== 'committed') return null;
  if (result?.id === value.id && result.status === 'applied') {
    if (!result.clientPending) {
      rmSync(clientPath(root));
      return null;
    }
  } else if (journal?.id !== value.id || journal.phase !== 'committed')
    throw new Error('缺少已提交的恢复回执，未应用界面偏好');
  if (!allowOtherClient && value.clientId !== undefined && value.clientId !== clientId) return null;
  return value as unknown as { id: string; values: Record<string, string>; clientId?: string };
}

export function acknowledgeWeqClientSettings(
  appRoot: string,
  id: string,
  clientId?: string,
): boolean {
  const root = resolve(appRoot),
    pending = pendingWeqClientSettings(root, clientId);
  if (!pending) {
    const result = readResult(root);
    return result?.id === id && result.status === 'applied' && !result.clientPending;
  }
  if (pending.id !== id) return false;
  const result = readResult(root),
    journal = readJournal(root);
  const receipt =
    result?.id === id
      ? result
      : journal?.id === id && journal.phase === 'committed'
        ? journal.result
        : null;
  if (!receipt) return false;
  save(resultPath(root), { ...receipt, clientPending: false });
  rmSync(clientPath(root));
  return true;
}

export function skipWeqClientSettings(appRoot: string, id: string): boolean {
  const root = resolve(appRoot),
    result = readResult(root),
    journal = readJournal(root);
  const receipt =
    result?.id === id && result.status === 'applied'
      ? result
      : journal?.id === id && journal.phase === 'committed'
        ? journal.result
        : null;
  if (!receipt || (journal?.id === id && journal.phase !== 'committed')) return false;
  if (!receipt.clientPending) {
    rmSync(clientPath(root), { force: true });
    return true;
  }
  save(resultPath(root), {
    ...receipt,
    clientPending: false,
    warnings: [...receipt.warnings, '已选择保留本机界面偏好，未应用包内界面偏好。'],
  });
  rmSync(clientPath(root), { force: true });
  return true;
}

export function reassignWeqClientSettings(appRoot: string, id: string, clientId: string): boolean {
  if (!UUID.test(clientId)) throw new Error('无效的界面恢复设备标识');
  const root = resolve(appRoot),
    pending = pendingWeqClientSettings(root, undefined, true);
  if (!pending || pending.id !== id) return false;
  save(clientPath(root), { ...pending, clientId });
  return true;
}

export function cancelWeqBackupRestore(appRoot: string, cacheBase: string): void {
  const root = resolve(appRoot),
    cacheRoot = resolve(cacheBase),
    journal = readJournal(root),
    pending = readPending(root);
  if (journal) {
    if (journal.phase !== 'rolled-back' || journal.cacheRoot !== cacheRoot)
      throw new Error('恢复事务尚未安全结束，不能丢弃原始数据');
    for (const op of journal.operations)
      if (present(join(work(root, cacheRoot, journal.id, op), 'before')))
        throw new Error('恢复现场仍含原始数据，不能丢弃');
    cleanWork(root, cacheRoot, journal);
    rmSync(journalPath(root));
  }
  if (pending) rmSync(archivePath(root, pending.id), { force: true });
  rmSync(pendingPath(root), { force: true });
}
