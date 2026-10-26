import { app, dialog } from 'electron';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import semver from 'semver';
import { resolveChildWorkerPath } from '../worker_path';
import { REPO } from './mirrors';
import {
  isAdhocSignature,
  MAC_STAGE_PREFIX,
  macAppBundle,
  macUpdateResultSchema,
  officialMacArchive,
  validateMacUpdatePlan,
  verifyMacArchive,
  verifyMacBundle,
  writeMacUpdateResult,
  type MacUpdatePlan,
} from './mac_install';

const run = promisify(execFile);
const reportPath = () => join(app.getPath('userData'), 'updates', 'mac-install.json');

export async function usesMacAdhocUpdater(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const { stderr } = await run('/usr/bin/codesign', [
    '-d',
    '--verbose=2',
    macAppBundle(process.execPath),
  ]);
  return isAdhocSignature(stderr);
}

export async function prepareMacUpdate(archive: string, version: string): Promise<MacUpdatePlan> {
  if (!semver.valid(version) || !semver.gt(version, app.getVersion()))
    throw new Error('更新版本无效或不高于当前版本');
  const response = await fetch(
    `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases/tags/v${encodeURIComponent(version)}`,
    {
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
      headers: { Accept: 'application/vnd.github+json' },
    },
  );
  if (!response.ok)
    throw new Error(`无法核验官方 Release（HTTP ${response.status}），未安装；请稍后重试。`);
  const asset = officialMacArchive(await response.json(), version, basename(archive));
  await verifyMacArchive(archive, asset);
  const target = await realpath(macAppBundle(process.execPath));
  await verifyMacBundle(target, app.getVersion());
  await finishMacUpdate();
  let staging: string;
  try {
    staging = await mkdtemp(join(dirname(target), MAC_STAGE_PREFIX));
  } catch {
    throw new Error(
      '当前应用位置不可写，请将 WeQ 移到有写入权限的应用程序文件夹后重试，或手动安装。',
    );
  }
  try {
    // 只有通过官方哈希验证的包才会解压；ditto 保留框架软链接和签名封装。
    await run('/usr/bin/ditto', ['-x', '-k', archive, staging], { timeout: 120_000 });
    await verifyMacBundle(join(staging, 'weQ.app'), version, asset.arch);
    await mkdir(dirname(reportPath()), { recursive: true });
    const plan: MacUpdatePlan = {
      target,
      staging,
      version,
      previousVersion: app.getVersion(),
      arch: asset.arch,
      report: reportPath(),
    };
    await writeMacUpdateResult(plan, 'prepared');
    return plan;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** 助手确认就绪及 will-quit 提交后才退出；下载或启动助手不会提前关闭账号。 */
export async function installMacUpdate(plan: MacUpdatePlan): Promise<void> {
  const worker = resolveChildWorkerPath(
    'macUpdateWorker.mjs',
    dirname(fileURLToPath(import.meta.url)),
  );
  const helper: ChildProcess = fork(worker, [], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  await new Promise<void>((resolve, reject) => {
    let committed = false;
    const cleanup = () => {
      clearTimeout(timer);
      app.removeListener('will-quit', commit);
      helper.removeListener('error', fail);
      helper.removeListener('exit', exited);
      helper.removeListener('message', message);
    };
    const fail = (error: Error) => {
      cleanup();
      if (!committed) helper.kill();
      reject(error);
    };
    const exited = () => fail(new Error('更新助手提前退出，未替换应用。'));
    const commit = (event: Electron.Event) => {
      if (committed || event.defaultPrevented) return;
      event.preventDefault();
      helper.send({ type: 'commit' }, (error) => {
        if (error) fail(error);
      });
    };
    const message = (value: unknown) => {
      const type = (value as { type?: string } | null)?.type;
      if (type === 'ready') {
        app.on('will-quit', commit);
        app.quit();
      } else if (type === 'committed') {
        committed = true;
        cleanup();
        helper.disconnect();
        helper.unref();
        resolve();
        app.quit();
      } else if (type === 'error') {
        fail(new Error((value as { message: string }).message));
      }
    };
    const timer = setTimeout(
      () => fail(new Error('更新助手准备或应用退出超时，未替换应用。')),
      120_000,
    );
    helper.once('error', fail);
    helper.once('exit', exited);
    helper.on('message', message);
    helper.send({ type: 'prepare', parentPid: process.pid, plan }, (error) => {
      if (error) fail(error);
    });
  });
}

/** 新版本启动后才清理本次旧应用副本；失败回执明确保留恢复位置。 */
export async function finishMacUpdate(): Promise<void> {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  try {
    const record = macUpdateResultSchema.parse(JSON.parse(await readFile(reportPath(), 'utf8')));
    const plan = validateMacUpdatePlan(record.plan);
    if (plan.target !== (await realpath(macAppBundle(process.execPath)))) return;
    if (record.phase === 'installing') return;
    if (
      record.phase === 'prepared' ||
      (record.phase === 'installed' && plan.version === app.getVersion())
    ) {
      await rm(plan.staging, { recursive: true, force: true });
    } else {
      dialog.showErrorBox(
        '上次更新未完成',
        `${record.message ?? '未确认新版本启动。'}\n恢复文件保留在：${plan.staging}`,
      );
    }
    await rm(reportPath(), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn('[update] macOS 更新回执读取失败', error);
  }
}
