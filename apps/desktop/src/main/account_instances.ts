import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type AccountConfig, type AutoEnterTarget, writeFileAtomicSync } from '@weq/service';
import type { AccountInstanceScope } from './account_instance_scope';

const ACCOUNT_ARG = '--weq-account-instance=';
const FOCUS_ARG = '--weq-focus-account=';
const PICKER_ARG = '--weq-account-picker=';
// scripts/dev.mjs 为默认开发窗口保留的固定 ID。
const DEVELOPMENT_PICKER_ID = '00000000-0000-0000-0000-000000000000';
const CONFIG_ID = /^[a-z\d][a-z\d_-]{0,127}$/i;
const PICKER_ID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
// Vite 5 的内置模块表不识别 node:sqlite，交给 Electron/Node 运行时加载。
const nodeSqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export function accountLaunchArgs(argv: readonly string[]): string[] {
  return argv
    .slice(1)
    .filter(
      (arg) => ![ACCOUNT_ARG, FOCUS_ARG, PICKER_ARG].some((prefix) => arg.startsWith(prefix)),
    );
}

export function accountPickerArg(id: string): string {
  return `${PICKER_ARG}${id}`;
}

export function accountPickerTarget(argv: readonly string[]): string | undefined {
  const arg = argv.find((value) => value.startsWith(PICKER_ARG));
  if (!arg) return undefined;
  const id = arg.slice(PICKER_ARG.length);
  if (!PICKER_ID.test(id)) throw new Error('账号选择窗口启动参数无效。');
  return id;
}

export function accountPickerDirectories(root: string, id: string) {
  return instanceDirectories(root, `picker-${id}`);
}

export interface AccountInstanceTarget {
  uin: string;
  configId: string;
}

export function instanceArg(target: AccountInstanceTarget): string {
  return `${ACCOUNT_ARG}${target.uin}:${target.configId}`;
}

export function focusAccountArg(uin: string): string {
  return `${FOCUS_ARG}${uin}`;
}

export function instanceTarget(argv: readonly string[]): AccountInstanceTarget | undefined {
  const arg = argv.find((value) => value.startsWith(ACCOUNT_ARG));
  if (!arg) return undefined;
  const [uin, configId, extra] = arg.slice(ACCOUNT_ARG.length).split(':');
  if (!uin || !configId || extra !== undefined || !CONFIG_ID.test(uin) || !CONFIG_ID.test(configId))
    throw new Error('账号实例启动参数无效。');
  return { uin, configId };
}

export function focusAccountTarget(argv: readonly string[]): string | undefined {
  const value = argv.find((arg) => arg.startsWith(FOCUS_ARG))?.slice(FOCUS_ARG.length);
  return value && CONFIG_ID.test(value) ? value : undefined;
}

function instanceRoot(root: string, uin: string): string {
  return join(root, 'instances', createHash('sha256').update(uin).digest('hex').slice(0, 24));
}

export function instanceDirectories(root: string, uin: string) {
  const directory = instanceRoot(root, uin);
  return { userData: join(directory, 'electron'), data: join(directory, 'data') };
}

function readAccount(directory: string, configId: string): AccountConfig | undefined {
  if (!CONFIG_ID.test(configId)) return undefined;
  try {
    const raw = JSON.parse(
      readFileSync(join(directory, `${configId}.json`), 'utf8'),
    ) as AccountConfig & { algo?: AccountConfig['algos'][string] };
    if (
      typeof raw.uin !== 'string' ||
      !CONFIG_ID.test(raw.uin) ||
      typeof raw.dbKey !== 'string' ||
      (raw.configId && raw.configId !== configId)
    )
      return undefined;
    return { ...raw, configId, algos: raw.algos ?? (raw.algo ? { 'nt_msg.db': raw.algo } : {}) };
  } catch {
    return undefined;
  }
}

function accountsDirectory(root: string): string {
  return join(root, 'config', 'accounts');
}

export function savedInstanceAccounts(root: string): AccountConfig[] {
  const directory = accountsDirectory(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => readAccount(directory, name.slice(0, -5)) ?? [])
    .sort((a, b) => b.lastLoginAt - a.lastLoginAt);
}

export function prepareAccountPicker(): string {
  return randomUUID();
}

/** 独立窗口也从宿主的账号清单打开数据源。 */
export function prepareInstanceAccount(root: string, target: AccountInstanceTarget): AccountConfig {
  const source = readAccount(accountsDirectory(root), target.configId);
  if (source?.uin !== target.uin) throw new Error('找不到此账号的已保存数据源。');
  return source;
}

function lockAccount(root: string, uin: string, probe = false): DatabaseSync | null {
  const directory = instanceRoot(root, uin);
  if (!probe) mkdirSync(directory, { recursive: true, mode: 0o700 });
  return lockOwnerFile(join(directory, 'owner.sqlite'), probe ? 0 : 100);
}

export function lockOwnerFile(path: string, waitMs = 0): DatabaseSync | null {
  const db = new nodeSqlite.DatabaseSync(path);
  try {
    // SQLite 的跨进程文件锁会在进程崩溃后由系统释放，无需根据 PID 清理锁文件。
    db.exec(`PRAGMA busy_timeout = ${waitMs}; BEGIN IMMEDIATE`);
    return db;
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5) return null;
    throw error;
  }
}

export function ownerFileIsLocked(path: string): boolean {
  if (!existsSync(path)) return false;
  const probe = lockOwnerFile(path);
  probe?.close();
  return probe === null;
}

export function accountIsRunning(root: string, uin: string): boolean {
  return ownerFileIsLocked(join(instanceRoot(root, uin), 'owner.sqlite'));
}

export function developmentStartupConfigId(
  root: string,
  pickerId: string | undefined,
  target: AutoEnterTarget | null | undefined,
): string | undefined {
  if (!isDevelopmentPicker(pickerId) || !target || accountIsRunning(root, target.uin))
    return undefined;
  return target.configId;
}

export function isDevelopmentPicker(pickerId: string | undefined): boolean {
  return pickerId === DEVELOPMENT_PICKER_ID;
}

function pickerOwnerPath(root: string, uin: string): string {
  return join(instanceRoot(root, uin), 'picker-owner');
}

export function accountPickerOwner(root: string, uin: string): string | undefined {
  const path = pickerOwnerPath(root, uin);
  if (!existsSync(path) || !accountIsRunning(root, uin)) return undefined;
  const id = readFileSync(path, 'utf8');
  return PICKER_ID.test(id) ? id : undefined;
}

export class AccountInstanceBusy extends Error {
  constructor() {
    super('此账号已在另一个 WeQ 实例打开。');
  }
}

/** 普通窗口可逐次打开账号，独立窗口始终保留指定账号的所有权。 */
export class AccountInstances implements AccountInstanceScope {
  private readonly locks = new Map<string, DatabaseSync>();
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly assignedUin?: string,
    private readonly pickerId?: string,
  ) {}

  owns(uin: string): boolean {
    return this.locks.has(uin);
  }

  dispose(): void {
    for (const lock of this.locks.values()) lock.close();
    this.locks.clear();
  }

  claim(uin: string): void {
    if (this.locks.has(uin)) return;
    const lock = lockAccount(this.root, uin);
    if (!lock) throw new AccountInstanceBusy();
    try {
      const ownerPath = pickerOwnerPath(this.root, uin);
      if (this.pickerId || existsSync(ownerPath))
        writeFileAtomicSync(ownerPath, this.pickerId ?? '');
    } catch (error) {
      lock.close();
      throw error;
    }
    this.locks.set(uin, lock);
  }

  run<T>(
    uin: string | null,
    operation: () => Promise<T>,
    opened: () => string | undefined,
  ): Promise<T> {
    const result = this.pending.then(async () => {
      if (uin && this.assignedUin && uin !== this.assignedUin)
        throw new Error('此窗口已绑定一个 QQ 账号，请在独立窗口打开其它账号。');
      if (uin) this.claim(uin);
      try {
        return await operation();
      } finally {
        const active = opened();
        for (const [owner, lock] of this.locks) {
          if (owner === active || owner === this.assignedUin) continue;
          lock.close();
          this.locks.delete(owner);
        }
      }
    });
    this.pending = result.catch(() => undefined);
    return result;
  }
}
