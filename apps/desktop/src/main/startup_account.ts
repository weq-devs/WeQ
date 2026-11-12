import type { UserConfigService } from '@weq/service';
import type { appRouter } from './ipc/router';

type StartupPage = ReturnType<UserConfigService['getStartupPage']>;
type BootstrapCaller = ReturnType<typeof appRouter.createCaller>['bootstrap'];

export interface StartupResult {
  opened: boolean;
  page: StartupPage | null;
  error: string | null;
}

/** 进程启动只开一次账号；界面重载接回同一任务，不重复打开数据库。 */
export class StartupAccount {
  private task: Promise<StartupResult> | undefined;
  private attached = false;
  private settled = false;

  get pending(): boolean {
    return this.task !== undefined && !this.settled;
  }

  start(run: () => Promise<StartupResult>): Promise<StartupResult> {
    this.task ??= Promise.resolve()
      .then(run)
      .catch((error: unknown) => ({
        opened: false,
        page: null,
        error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        this.settled = true;
      });
    return this.task;
  }

  async wait(): Promise<StartupResult> {
    return this.task ?? { opened: false, page: null, error: null };
  }

  async attach(): Promise<StartupResult> {
    const result = await this.wait();
    if (this.attached) return { ...result, page: null, error: null };
    this.attached = true;
    return result;
  }
}

export const desktopStartupAccount = new StartupAccount();

/** 仅在本轮自动进入尚未结束且目标仍有效时提前使用工作区尺寸。 */
export function startupWindowLayout(
  accountOpen: boolean,
  pending: boolean,
  config: Pick<UserConfigService, 'getStartupAutoEnter' | 'listAccountConfigs'> | undefined,
): 'chat' | 'home' {
  if (accountOpen) return 'chat';
  if (!pending || !config) return 'home';
  const target = config.getStartupAutoEnter();
  return target &&
    config.listAccountConfigs().some((account) => account.configId === target.configId)
    ? 'chat'
    : 'home';
}

/** 复用正式打开入口，保持在线账号与静态备份的验证、配置及物料处理一致。 */
export async function openStartupAccount(
  config: Pick<UserConfigService, 'getStartupAutoEnter' | 'listAccountConfigs' | 'getStartupPage'>,
  caller: Pick<
    BootstrapCaller,
    'qqDataAccess' | 'testDatabaseKey' | 'openAccount' | 'openStaticAccount'
  >,
  isMac: boolean,
): Promise<StartupResult> {
  const target = config.getStartupAutoEnter();
  const cfg = target
    ? config.listAccountConfigs().find((account) => account.configId === target.configId)
    : undefined;
  if (!cfg) return { opened: false, page: null, error: null };
  if (!cfg.static && isMac) {
    const access = await caller.qqDataAccess();
    // 与原首页流程一致：读取不可用时落回账号选择页，由现有访问提示接续。
    if (access.status === 'denied' || access.status === 'error')
      return { opened: false, page: null, error: null };
  }
  if (cfg.static) {
    if (!cfg.dataDir) throw new Error('该静态账号缺少数据库目录，请重新导入。');
    await caller.openStaticAccount({
      dirPath: cfg.dataDir,
      preview: {
        uin: cfg.uin,
        uid: cfg.uid ?? '',
        displayName: cfg.displayName ?? '',
        avatarUrl: cfg.avatarUrl ?? '',
      },
      ...(cfg.dbKey ? { dbKey: cfg.dbKey } : {}),
      ...(cfg.algos?.['nt_msg.db'] ? { algo: cfg.algos['nt_msg.db'] } : {}),
      ...(cfg.mobile ? { mobile: true } : {}),
    });
  } else {
    const test = await caller.testDatabaseKey({ uin: cfg.uin, dbKey: cfg.dbKey });
    if (!test.success) throw new Error(test.error ?? '数据库密钥不正确');
    await caller.openAccount({
      uin: cfg.uin,
      ...(cfg.uid ? { uid: cfg.uid } : {}),
      dbKey: cfg.dbKey,
      algo: test.algo,
      ...(cfg.displayName ? { displayName: cfg.displayName } : {}),
      ...(cfg.avatarUrl ? { avatarUrl: cfg.avatarUrl } : {}),
      ...(cfg.dataDir ? { dataDir: cfg.dataDir } : {}),
    });
  }
  return { opened: true, page: config.getStartupPage(), error: null };
}
