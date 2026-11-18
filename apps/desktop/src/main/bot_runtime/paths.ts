/**
 * daemon 可执行文件与 socket 的路径解析。
 *
 * 三种形态都要能跑，且**不能靠猜**：
 *
 *   - 打包（electron-builder）：`resources/bot-runtime/weqbot-daemon.mjs`；
 *   - dev（`pnpm dev`）：仓库里 `vendor/weqbot/packages/node/src/daemon-entry.ts`，
 *     用 tsx 直接跑；
 *   - 测试：调用方传 `entry` / `socketPath` 覆盖。
 *
 * native 目录直接复用 `@weq/native` 的解析（`WEQ_NATIVE_DIR` → 打包 → dev 上溯），
 * 这样 desktop 和 daemon 永远加载**同一个** `.node`，不会因为两套路径逻辑漂移成
 * 两个不同版本（`subAppId` 不一致会让服务端静默丢弃注册）。
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultControlSocketPath } from '@weqbot/control';

const here = dirname(fileURLToPath(import.meta.url));

/** 打包后随 `extraResources` 放进去的入口。 */
const PACKAGED_ENTRY = 'bot-runtime/weqbot-daemon.mjs';

/** 打包后 `extraResources` 落点：`process.resourcesPath`。 */
function resourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

export interface DaemonPaths {
  /** `node` 可执行文件；dev 下是当前 Node。 */
  node: string;
  /** 传给 node 的前置参数：dev 下是 `--import tsx`，打包后为空。 */
  nodeArgs: string[];
  /** 入口脚本（`.mjs` 或 `.ts`）。 */
  entry: string;
  /** native 目录（`<root>/<platform>/<arch>`）。 */
  nativeDir: string;
  /** 控制通道 socket。 */
  socketPath: string;
}

export interface ResolveDaemonPathsOptions {
  uin: string;
  /** 覆盖入口（测试 / 自定义安装）。 */
  entry?: string;
  socketPath?: string;
  /** 覆盖 native 平台目录（测试）。 */
  nativeDir?: string;
}

/**
 * 解析 daemon 的可执行路径。
 *
 * 找不到时抛错而不是「稍后再试」：daemon 起不来意味着这个账号没有 OneBot 面，
 * 用户需要立刻看到「安装包不完整」，而不是一个安静的 1404。
 */
export function resolveDaemonPaths(options: ResolveDaemonPathsOptions): DaemonPaths {
  const socketPath = options.socketPath ?? defaultControlSocketPath(options.uin);
  const nativeDir = options.nativeDir ?? resolveNativePlatformDir();

  if (options.entry) {
    return {
      node: process.execPath,
      nodeArgs: options.entry.endsWith('.ts') ? ['--import', 'tsx'] : [],
      entry: options.entry,
      nativeDir,
      socketPath,
    };
  }

  const packaged = resourcesPath();
  if (packaged) {
    const entry = join(packaged, PACKAGED_ENTRY);
    if (existsSync(entry)) {
      return { node: process.execPath, nodeArgs: [], entry, nativeDir, socketPath };
    }
  }

  // dev：从当前文件往上找 `vendor/weqbot/packages/node/src/daemon-entry.ts`。
  // 不能写死层级 —— electron-vite 会把共享模块拆到 `out/main/chunks/`。
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'vendor', 'weqbot', 'packages', 'node', 'src', 'daemon-entry.ts');
    if (existsSync(candidate)) {
      return {
        node: process.execPath,
        nodeArgs: ['--import', 'tsx'],
        entry: candidate,
        nativeDir,
        socketPath,
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `找不到 weqbot daemon 入口。打包产物应位于 ${join(packaged ?? '<resources>', PACKAGED_ENTRY)}；` +
      `开发环境应能从 ${here} 上溯到 vendor/weqbot/packages/node/src/daemon-entry.ts。`,
  );
}

/** `native/<platform>/<arch>`；与 `@weq/native` 的解析保持一致。 */
function resolveNativePlatformDir(): string {
  const override = process.env.WEQ_NATIVE_DIR;
  const candidates: string[] = [];
  if (override) candidates.push(join(override, process.platform, process.arch), override);
  const packaged = resourcesPath();
  if (packaged) {
    candidates.push(join(dirname(packaged), 'native', process.platform, process.arch));
    candidates.push(join(packaged, 'native', process.platform, process.arch));
  }
  // dev：从当前文件上溯，找带平台子目录的 `native/`。
  let dir = here;
  for (let i = 0; i < 8; i++) {
    candidates.push(join(dir, 'native', process.platform, process.arch));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'nt_helper.node'))) return candidate;
  }
  throw new Error(
    `找不到 native 目录（${process.platform}/${process.arch}）。` +
      `新克隆请先跑 \`pnpm native:fetch\`，或用 WEQ_NATIVE_DIR 指定。`,
  );
}

/** 从 `native/<platform>/<arch>` 反推安装根的 native 目录（日志 / 诊断用）。 */
export function nativeRootOf(nativeDir: string): string {
  return resolve(nativeDir, '..', '..');
}
