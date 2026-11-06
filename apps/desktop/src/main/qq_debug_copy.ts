import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  runOwnedChild,
  type HostBridge,
  type OwnedChildOptions,
  type OwnedChildResult,
} from '@weq/service';
import { z } from 'zod';
import type {
  QqDebugCopyAction,
  QqDebugCopyPhase,
  QqDebugCopyPermissionAction,
  QqDebugCopyStatus,
} from '../shared/qq_debug_copy';

const DEBUGGER = 'com.apple.security.cs.debugger';
const GET_TASK_ALLOW = 'com.apple.security.get-task-allow';
const markerName = 'weq-debug-copy.json';
const markerSchema = z.object({
  format: z.literal(1),
  source: z.string(),
  sourceVersion: z.string(),
  signingVersion: z.literal(1).optional(),
});
type Command = (
  command: string,
  args: readonly string[],
  options?: OwnedChildOptions,
) => Promise<OwnedChildResult>;

/** ps 的 comm 字段保留完整可执行路径，不用模糊 QQ 名称决定能否替换副本。 */
export function debugCopyPids(output: string, bundle: string): number[] {
  const contents = `${join(bundle, 'Contents')}/`;
  return output.split('\n').flatMap((line) => {
    const match = /^\s*([1-9]\d*)\s+(.+?)\s*$/.exec(line);
    return match?.[2]?.startsWith(contents) ? [Number(match[1])] : [];
  });
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 仅管理固定的用户级副本；原安装和共享 QQ 数据从不作为写入目标。 */
export class QqDebugCopyManager {
  private phase: QqDebugCopyPhase = 'idle';
  private busy = false;
  private readonly path: string;
  private readonly run: Command;
  constructor(
    private readonly options: {
      source: () => string | null;
      home?: string;
      platform?: string;
      executable?: string;
      run?: Command;
    },
  ) {
    this.path = join(options.home ?? homedir(), 'Applications/QQ-WeQ.app');
    this.run = options.run ?? runOwnedChild;
  }
  private async command(command: string, args: readonly string[], input?: string): Promise<string> {
    const result = await this.run(command, args, {
      input,
      timeoutMs: 180_000,
      maxOutputBytes: 512 * 1024,
    });
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || `系统命令执行失败：${command} (${result.code})`);
    return result.stdout;
  }
  private async removeTree(path: string): Promise<void> {
    // Electron 会把 .asar 当虚拟目录；系统 rm 按真实文件删除归档，避免 ENOTEMPTY。
    await this.command('/bin/rm', ['-r', '--', path]);
  }
  private async removeCopy(): Promise<void> {
    const markerPath = join(this.path, 'Contents/Resources', markerName);
    const marker = await readFile(markerPath, 'utf8');
    try {
      await this.removeTree(this.path);
    } catch (error) {
      if (await exists(this.path)) {
        const remaining = await lstat(this.path);
        if (remaining.isDirectory() && !remaining.isSymbolicLink()) {
          // 部分删除可能先删掉标记；恢复它，让下次操作仍可识别并继续移除。
          await mkdir(dirname(markerPath), { recursive: true });
          await writeFile(markerPath, marker);
        }
      }
      throw error;
    }
  }
  private async entitlements(path: string): Promise<Record<string, unknown>> {
    const xml = await this.command('/usr/bin/codesign', ['-d', '--entitlements', ':-', path]);
    return z
      .record(z.unknown())
      .parse(
        JSON.parse(
          await this.command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], xml),
        ),
      );
  }
  private async version(path: string): Promise<string> {
    const plist = join(path, 'Contents/Info.plist');
    const field = async (key: string) =>
      (await this.command('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).trim();
    if (
      (await field('CFBundleIdentifier')) !== 'com.tencent.qq' ||
      (await field('CFBundleExecutable')) !== 'QQ'
    )
      throw new Error('检测到的应用不是 QQ 主程序。');
    return `${await field('CFBundleShortVersionString')}-${await field('CFBundleVersion')}`;
  }
  private async owned(path = this.path): Promise<boolean> {
    try {
      markerSchema.parse(
        JSON.parse(await readFile(join(path, 'Contents/Resources', markerName), 'utf8')),
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EACCES') throw error;
      return false;
    }
  }
  private async pids(): Promise<number[]> {
    return debugCopyPids(await this.command('/bin/ps', ['-axo', 'pid=,comm=']), this.path);
  }
  private async stopped(): Promise<void> {
    if ((await this.pids()).length)
      throw new Error('QQ 调试副本正在运行，请先从副本菜单退出 QQ，再重试；不会自动退出其他 QQ。');
  }
  private async verify(path: string, deep = true): Promise<void> {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error('副本路径是软链接，请使用普通应用目录。');
    await this.version(path);
    const marker = markerSchema.parse(
      JSON.parse(await readFile(join(path, 'Contents/Resources', markerName), 'utf8')),
    );
    if (!marker.signingVersion)
      throw new Error('副本使用旧签名方式，可能导致 QQ 子进程启动失败，请重新准备副本。');
    await this.command('/usr/bin/codesign', [
      '--verify',
      ...(deep ? ['--deep'] : []),
      '--strict',
      path,
    ]);
    if ((await this.entitlements(path))[GET_TASK_ALLOW] !== true)
      throw new Error('副本缺少调试读取权限，请重新准备副本。');
  }
  async permission(
    action: QqDebugCopyPermissionAction,
    host: Pick<HostBridge, 'openExternal' | 'revealInFolder'>,
  ): Promise<void> {
    if ((this.options.platform ?? process.platform) !== 'darwin')
      throw new Error('仅 macOS 支持 QQ 副本权限设置。');
    if (action === 'reveal') {
      if (!(await exists(this.path))) throw new Error('尚未创建 QQ 调试副本。');
      if ((await lstat(this.path)).isSymbolicLink()) throw new Error('副本路径是软链接。');
      if (!(await this.owned())) throw new Error('此位置不是 WeQ 管理的副本。');
      await host.revealInFolder(this.path);
      return;
    }
    const panes = {
      screenCapture: 'Privacy_ScreenCapture',
      microphone: 'Privacy_Microphone',
      camera: 'Privacy_Camera',
    } as const;
    await host.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${panes[action]}`,
    );
  }
  async status(): Promise<QqDebugCopyStatus> {
    const supported = (this.options.platform ?? process.platform) === 'darwin';
    const result: QqDebugCopyStatus = {
      supported,
      phase: this.phase,
      state: 'missing',
      sourcePath: null,
      sourceVersion: null,
      path: this.path,
      version: null,
      readerReady: false,
      runningPids: [],
      message: supported ? '尚未创建 QQ 调试副本。' : '请在运行 QQ 的 Mac 桌面端管理调试副本。',
    };
    if (!supported) return result;
    try {
      result.readerReady =
        (await this.entitlements(this.options.executable ?? process.execPath))[DEBUGGER] === true;
    } catch {
      /* 未签名开发宿主必须明确显示读取端未就绪。 */
    }
    const source = this.options.source();
    if (source && resolve(source) !== resolve(this.path)) {
      result.sourcePath = source;
      try {
        result.sourceVersion = await this.version(source);
      } catch (error) {
        result.message = error instanceof Error ? error.message : String(error);
      }
    }
    result.runningPids = await this.pids();
    if (!(await exists(this.path))) return { ...result, phase: this.phase };
    result.state = 'unmanaged';
    result.message = '此位置已有非 WeQ 管理的应用，未覆盖或删除；请先将它移到其他位置。';
    if (!(await this.owned())) return { ...result, phase: this.phase };
    try {
      result.version = await this.version(this.path);
      await this.verify(this.path, false);
      result.state =
        result.sourceVersion && result.sourceVersion !== result.version ? 'outdated' : 'ready';
      result.message =
        result.state === 'outdated'
          ? '原安装版本已变化，请退出副本后更新。'
          : '副本签名与调试权限已就绪；启动并登录后检查在线凭据。';
    } catch (error) {
      result.state = 'invalid';
      result.message = error instanceof Error ? error.message : String(error);
    }
    return { ...result, phase: this.phase };
  }
  async perform(action: QqDebugCopyAction): Promise<QqDebugCopyStatus> {
    if ((this.options.platform ?? process.platform) !== 'darwin')
      throw new Error('仅 macOS 支持 QQ 调试副本。');
    if (this.busy) throw new Error('正在处理 QQ 调试副本，请等待当前操作完成。');
    this.busy = true;
    this.phase = 'checking';
    // 目录锁跨 WeQ 实例生效；不触碰其他实例持有的暂存目录。
    const lock = `${this.path}.lock`;
    let locked = false;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      try {
        await mkdir(lock);
        locked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new Error(
            `另一个副本管理操作尚未结束。确认所有 WeQ 已退出后，可移除锁目录：${lock}`,
          );
        throw error;
      }
      const present = await exists(this.path);
      if (present && !(await this.owned()))
        throw new Error('副本位置已有非 WeQ 管理的应用，未修改。');
      if (action === 'prepare') await this.prepare(present);
      else if (action === 'remove') {
        await this.stopped();
        this.phase = 'removing';
        if (present) await this.removeCopy();
      } else {
        this.phase = 'verifying';
        await this.verify(this.path);
        if (action === 'launch') {
          if ((await this.pids()).length)
            throw new Error('QQ 调试副本已在运行，请切换到副本窗口登录。');
          this.phase = 'launching';
          const env = { ...process.env };
          delete env.ELECTRON_RUN_AS_NODE;
          const opened = await this.run('/usr/bin/open', ['-n', '-a', this.path], {
            env,
            timeoutMs: 15_000,
          });
          if (opened.code !== 0)
            throw new Error(opened.stderr.trim() || '系统未能打开 QQ 调试副本。');
        }
      }
    } finally {
      try {
        if (locked) await rm(lock, { recursive: true, force: true });
      } finally {
        this.busy = false;
        this.phase = 'idle';
      }
    }
    return this.status();
  }
  private async prepare(present: boolean): Promise<void> {
    const source = this.options.source();
    if (!source || resolve(source) === resolve(this.path))
      throw new Error('未检测到 QQ 原安装，请先安装 QQ 后重新检查。');
    const version = await this.version(source);
    await this.stopped();
    const staging = await mkdtemp(join(dirname(this.path), '.weq-qq-'));
    const next = join(staging, 'QQ.app');
    const previous = join(staging, 'previous.app');
    let backedUp = false;
    try {
      this.phase = 'copying';
      await this.command('/bin/cp', ['-cR', source, next]);
      if ((await this.version(next)) !== version || (await this.version(source)) !== version)
        throw new Error('QQ 在准备期间发生更新，请重试。');
      const entitlements = { ...(await this.entitlements(source)), [GET_TASK_ALLOW]: true };
      const plist = join(staging, 'entitlements.plist');
      const xml = await this.command(
        '/usr/bin/plutil',
        ['-convert', 'xml1', '-o', '-', '--', '-'],
        JSON.stringify(entitlements),
      );
      await writeFile(plist, xml, { mode: 0o600 });
      await writeFile(
        join(next, 'Contents/Resources', markerName),
        JSON.stringify({ format: 1, source, sourceVersion: version, signingVersion: 1 }),
      );
      this.phase = 'signing';
      // 不递归重签：保留 Helper 的沙盒继承、原签名及热更新框架的 Team ID 匹配。
      await this.command('/usr/bin/codesign', [
        '--force',
        '--options',
        'runtime',
        '--entitlements',
        plist,
        '--sign',
        '-',
        next,
      ]);
      this.phase = 'verifying';
      await this.verify(next);
      await this.stopped();
      if (present ? !(await this.owned()) : await exists(this.path))
        throw new Error('准备期间副本位置发生变化，未覆盖该位置的应用，请重新检查。');
      if (present) {
        await rename(this.path, previous);
        backedUp = true;
      }
      try {
        await rename(next, this.path);
      } catch (error) {
        if (backedUp) {
          await rename(previous, this.path);
          backedUp = false;
        }
        throw error;
      }
      backedUp = false;
    } finally {
      // 若回滚本身失败，保留 previous.app，不把唯一可恢复副本当临时文件删掉。
      if (!backedUp) await this.removeTree(staging);
    }
  }
}
