import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { AppAutostartStatus } from '@weq/service';
import { legacyDaemonStateDir, retireLegacyDaemon, type RunCommand } from './legacy_daemon';

const APP_ID = 'app.weq.desktop';
const legacyPreference = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  gui_exe: z.string(),
});
const migrationState = z.object({
  version: z.literal(1),
  autostartMigrated: z.boolean(),
  retired: z.boolean(),
});
interface LoginOptions {
  path?: string;
  args?: string[];
  name?: string;
}
interface NativeLoginState {
  openAtLogin: boolean;
  status?: string;
  executableWillLaunchAtLogin?: boolean;
}
interface Options {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  configDir: string;
  exePath: string;
  supported: boolean;
  native: {
    get(options?: LoginOptions): NativeLoginState;
    set(options: LoginOptions & { openAtLogin: boolean }): void;
  };
  run?: RunCommand;
  stopLegacy?: () => Promise<void>;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export class AppAutostart {
  private pending: Promise<unknown> = Promise.resolve();
  private migrationError: string | undefined;
  constructor(private readonly options: Options) {}
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const task = this.pending.then(action);
    this.pending = task.catch(() => {});
    return task;
  }
  private get desktopEntry() {
    return join(
      this.options.env.XDG_CONFIG_HOME ?? join(this.options.home, '.config'),
      'autostart',
      `${APP_ID}.desktop`,
    );
  }
  private get loginOptions(): LoginOptions {
    return { path: this.options.exePath, args: [] };
  }
  private async readStatus(): Promise<AppAutostartStatus> {
    const base = {
      supported: this.options.supported,
      enabled: false,
      registered: false,
      requiresApproval: false,
      migrationError: this.migrationError,
    };
    if (!this.options.supported) return base;
    if (this.options.platform === 'linux') {
      const text = await readOptional(this.desktopEntry);
      const enabled = text !== null && !/^Hidden\s*=\s*true\s*$/m.test(text);
      return { ...base, enabled, registered: text !== null };
    }
    const current = this.options.native.get(
      this.options.platform === 'win32' ? this.loginOptions : undefined,
    );
    return {
      ...base,
      enabled: current.openAtLogin && current.executableWillLaunchAtLogin !== false,
      registered: current.openAtLogin || current.status === 'requires-approval',
      requiresApproval: current.status === 'requires-approval',
    };
  }
  async status(): Promise<AppAutostartStatus> {
    await this.pending;
    return this.readStatus();
  }
  private async apply(enabled: boolean): Promise<AppAutostartStatus> {
    if (!this.options.supported) throw new Error('请使用打包安装版设置 WeQ 登录自启');
    if (this.options.platform === 'linux') {
      if (enabled) {
        const exe = this.options.env.APPIMAGE || this.options.exePath;
        if (!isAbsolute(exe) || /[\r\n=]/.test(exe) || exe.includes('\0'))
          throw new Error('应用启动路径无效');
        // XDG 先解码字符串转义，再解码 Exec 引号；反斜杠需经过两层编码。
        const quoted = exe
          .replaceAll('%', '%%')
          .replaceAll('\\', '\\\\')
          .replaceAll('"', '\\"')
          .replaceAll('`', '\\`')
          .replaceAll('$', '\\$')
          .replaceAll('\\', '\\\\');
        await mkdir(
          join(this.options.env.XDG_CONFIG_HOME ?? join(this.options.home, '.config'), 'autostart'),
          { recursive: true },
        );
        await writeFile(
          this.desktopEntry,
          `[Desktop Entry]\nType=Application\nName=WeQ\nExec="${quoted}" --ozone-platform=x11 --no-sandbox\nTerminal=false\n`,
          { mode: 0o600 },
        );
      } else await rm(this.desktopEntry, { force: true });
    } else {
      this.options.native.set({
        openAtLogin: enabled,
        ...(this.options.platform === 'win32' ? { ...this.loginOptions, name: APP_ID } : {}),
      });
    }
    const status = await this.readStatus();
    if (enabled !== status.enabled && !(enabled && status.requiresApproval))
      throw new Error('系统未应用 WeQ 自启设置，请检查系统登录项');
    return status;
  }
  set(enabled: boolean): Promise<AppAutostartStatus> {
    return this.serialize(() => this.apply(enabled));
  }

  migrateLegacy(): Promise<void> {
    return this.serialize(async () => {
      if (!this.options.supported) return;
      try {
        const path = join(this.options.configDir, 'legacy-daemon-migration.json');
        const raw = await readOptional(path);
        const state =
          raw === null
            ? { version: 1 as const, autostartMigrated: false, retired: false }
            : migrationState.parse(JSON.parse(raw));
        // 旧版本回滚或手动启动可能重新注册旧服务；只迁一次偏好，启动时仍复核退役。
        if (!state.autostartMigrated) {
          const legacy = await readOptional(
            join(
              legacyDaemonStateDir(this.options.platform, this.options.home, this.options.env),
              'weq-daemon.gui.json',
            ),
          );
          const previous = legacy === null ? null : legacyPreference.parse(JSON.parse(legacy));
          const current = await this.readStatus();
          if (previous?.enabled && !current.registered) await this.apply(true);
          state.autostartMigrated = true;
          await this.saveMigration(path, state);
        }
        await (this.options.stopLegacy ?? (() => retireLegacyDaemon(this.options)))();
        state.retired = true;
        await this.saveMigration(path, state);
        this.migrationError = undefined;
      } catch (error) {
        this.migrationError = error instanceof Error ? error.message : '旧后台迁移失败';
        throw error;
      }
    });
  }
  private async saveMigration(path: string, state: z.infer<typeof migrationState>): Promise<void> {
    await mkdir(this.options.configDir, { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }
  }
}
