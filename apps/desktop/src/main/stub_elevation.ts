/**
 * Linux stub hooks for ninebird, elevating only when the host isn't root.
 *
 * The ninebird launch flow ensures a persistent entry stub (`loadNineBird.js`)
 * sits in QQ's `resources/app` so QQ's Electron entry (redirected by the
 * injected launcher.so) resolves a real file — a raw statx probe that
 * `LD_PRELOAD` can't fake. That directory is root-owned on a normal QQ
 * install, so a missing/stale stub needs elevation — unless we're already
 * root, in which case a plain `fs` write does (headless web server).
 *
 * Elevation is macOS-style `sudo -S`: the renderer draws the password dialog
 * (main → renderer via `elevation_ipc`, reuse of the global password UI),
 * the main process feeds the password to sudo over stdin, and root only does
 * a byte-level `cp` of a TS-written temp file. No polkit. The stub is
 * persistent — we deliberately do NOT clean it up here; removal happens only
 * via the explicit 「还原 NineBird」 action in settings.
 *
 * Windows never uses these hooks — `@weq/native` falls back to a direct `fs`
 * write there.
 */

import type { StubHooks } from '@weq/native';
import { writeFileAsRoot } from '@weq/native';
import { getLogger } from '@weq/service';
import { getSudoPasswordPrompt, requestSudoPassword } from './sudo_prompt';

const logger = getLogger().child({ scope: 'stub-elevation' });

/**
 * Write `content` to `path` as root via `sudo -S`. The password comes from
 * the renderer's self-drawn password dialog; rejecting on cancel keeps the
 * caller (ninebird `run()`) from launching QQ with a missing entry stub.
 */
async function sudoWriteFile(path: string, content: string): Promise<void> {
  const prompt = getSudoPasswordPrompt();
  if (!prompt) {
    throw new Error(
      '无法弹出密码输入框（无图形界面）。请以 root 运行 WeQ 服务，或在有桌面的环境中先安装 NineBird。',
    );
  }
  const password = await requestSudoPassword(
    '安装 NineBird',
    `需要管理员权限向 QQ 的启动目录写入入口文件：\n${path}\n\n请输入管理员密码。`,
  );
  if (!password) {
    throw new Error('已取消授权，NineBird 启动文件未写入。');
  }
  logger.info('writing ninebird entry stub via sudo', {
    event: 'stub-drop-sudo',
    path,
  });
  await writeFileAsRoot(path, content, password);
}

/**
 * StubHooks backed by sudo. `removeStub` is intentionally a no-op (see the
 * module header): the stub is persistent and only removed by the explicit
 * 「还原 NineBird」 action in settings.
 *
 * Only used when the host is NOT already root — see `linuxStubHooks`.
 */
const sudoStubHooks: StubHooks = {
  dropStub: async (path: string, content: string): Promise<void> => {
    await sudoWriteFile(path, content);
  },
  removeStub: (_path: string): void => {
    /* intentionally not cleaned up — see module header */
  },
};

/**
 * The linux stub hooks. Running as root (typical for the headless web server)
 * means we can write QQ's root-owned `resources/app` directly — `undefined`
 * selects `@weq/native`'s plain-`fs` default. Only an unprivileged host (the
 * desktop app, since Electron refuses to run as root) needs the sudo detour.
 */
export const linuxStubHooks: StubHooks | undefined =
  process.geteuid?.() === 0 ? undefined : sudoStubHooks;
