/**
 * macOS 的 `launchQQ` —— win/linux 的 ninebird_addon.node 在 mac 上的 TS 等价物。
 *
 * win/linux 需要一个 native addon 是因为它们要靠 CreateProcess 远程线程 /
 * LD_PRELOAD 把 hook 介质塞进 QQ 进程。macOS 的等价"注入介质"是
 * napcat 证明过的 package.json 入口补丁，所以启动器本身零 native：
 *
 *   1. ensureInstalled()：把 NineBird.node + loader JS 部署进 QQ 容器，
 *      并把 package.json 的 main 指向容器里的 shim（首次会弹系统授权框）；
 *   2. spawn `/Applications/QQ.app/Contents/MacOS/QQ --no-sandbox`，
 *      环境变量带 NINEBIRD_*（pipe / loader / appid / qua / log）；
 *   3. QQ 进程内：shim require(loader JS) → dlopen wrapper.node →
 *      require(NineBird.node) → installRecvHook（进程内 dyld 解析 + funchook）。
 *
 * 与 `NineBirdBootstrap` 的契约完全一致（launchQQ → {success, pid}），
 * 上层 pipe server / NDJSON / kill 逻辑一字不改。
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type {
  LaunchQqOptions,
  LaunchQqResult,
  NineBirdBootBinding,
  NineBirdResources,
} from '../types';
import { darwinPaths, ensureInstalled } from './install';

function resolveLogDir(): string {
  const override = process.env.WEQ_LOG_DIR;
  if (override) return override;
  return join(homedir(), 'Library', 'Application Support', 'weq', 'logs');
}

export function createDarwinNineBirdBoot(resources: NineBirdResources): NineBirdBootBinding {
  return {
    async launchQQ(opts: LaunchQqOptions): Promise<LaunchQqResult> {
      // 1. 部署 + 补丁（幂等；custom 入口会抛错，交给上层展示）。
      try {
        await ensureInstalled(opts.qqExePath, resources);
      } catch (e) {
        return {
          success: false,
          pid: 0,
          error: e instanceof Error ? e.message : String(e),
        };
      }

      // 2. 容器内的 loader 路径（QQ 沙箱读不到 WeQ 安装目录）。
      const paths = darwinPaths(opts.qqExePath);
      const containerLoader = join(paths.installDir, basename(opts.loadJsPath));

      // 3. 环境变量 —— 与 win/linux addon 传给 QQ 的 NINEBIRD_* 完全一致。
      const logDir = resolveLogDir();
      try {
        mkdirSync(logDir, { recursive: true });
      } catch {
        // 日志写不进不致命。
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NINEBIRD_PIPE_NAME: opts.pipeName,
        NINEBIRD_LOAD_PATH: containerLoader,
        NINEBIRD_LOADER_DIR: paths.installDir,
        NINEBIRD_TIMEOUT_MS: String(opts.timeoutMs ?? 180_000),
        NINEBIRD_LOG: join(logDir, 'ninebird_qq.log'),
        ...(opts.uin !== undefined ? { NINEBIRD_TARGET_UIN: opts.uin } : {}),
        ...(opts.appid !== undefined ? { NINEBIRD_APPID: opts.appid } : {}),
        ...(opts.qua !== undefined ? { NINEBIRD_QUA: opts.qua } : {}),
      };

      // 4. spawn QQ。`--no-sandbox` 是 shim 切换 NineBird 模式的标志，
      //    detached 让 QQ 独立于 WeQ 进程存活（与 linux addon 的 double-fork
      //    意图一致），kill() 仍按 pid 生效。
      const child = spawn(opts.qqExePath, ['--no-sandbox'], {
        env,
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      return { success: true, pid: child.pid ?? 0 };
    },
  };
}
