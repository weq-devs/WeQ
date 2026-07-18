/**
 * Linux privilege-escalated stub hooks for ninebird.
 *
 * The ninebird launch flow drops a tiny entry stub (`loadNineBird.js`) into
 * QQ's `resources/app` so QQ's Electron entry resolves a real file (a raw
 * statx probe that `LD_PRELOAD` can't fake). That directory is root-owned
 * (root:root 0755) on a normal QQ install, so writing the stub needs
 * elevation. We shell out to `pkexec`, which pops the desktop's graphical
 * polkit auth dialog.
 *
 * Frequency is low — a given account only needs a dbkey once — so a password
 * prompt per drop is acceptable. We deliberately do NOT clean the stub up:
 * polkit's default policy for `org.freedesktop.policykit.exec` is `auth_admin`
 * (no credential caching), so a later cleanup would just pop the dialog again.
 * The stub is a harmless self-`require` shim; the next drop overwrites it.
 *
 * Windows never uses these hooks — `@weq/native` falls back to a direct `fs`
 * write there.
 */

import { spawn } from 'node:child_process';
import type { StubHooks } from '@weq/native';
import { getLogger } from '@weq/service';

const logger = getLogger().child({ scope: 'stub-elevation' });

/**
 * Write `content` to `path` as root via pkexec. Rejects if pkexec exits
 * non-zero — user cancelled the dialog (exit 126), no auth agent running
 * (127), or the write itself failed. The caller (ninebird `run()`) turns a
 * throw into a `result: { success: false }` the renderer already surfaces.
 */
function pkexecWriteFile(path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // `sh -c 'cat > "$1"'` takes the target as an argv positional and the file
    // body from stdin, so the (world-visible) argv never carries the content.
    const child = spawn(
      'pkexec',
      ['sh', '-c', 'cat > "$1"', 'sh', path],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (e) => {
      reject(new Error(`pkexec 无法启动（是否已安装 polkit？）：${e.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const hint =
        code === 126
          ? '授权被取消。请在弹出的密码框中输入密码后重试。'
          : code === 127
            ? '未能弹出授权框。请确认桌面的 polkit 认证代理正在运行。'
            : `pkexec 退出码 ${code}。${stderr.trim()}`;
      reject(new Error(`向 QQ 目录写入启动文件需要管理员授权：${hint}`));
    });

    child.stdin.write(content);
    child.stdin.end();
  });
}

/**
 * StubHooks backed by pkexec. `removeStub` is intentionally a no-op (see the
 * module header): the stub is harmless and left in place, overwritten on the
 * next drop.
 */
export const pkexecStubHooks: StubHooks = {
  dropStub: async (path: string, content: string): Promise<void> => {
    logger.info('dropping ninebird entry stub via pkexec', {
      event: 'stub-drop-pkexec',
      path,
    });
    await pkexecWriteFile(path, content);
  },
  removeStub: (_path: string): void => {
    /* intentionally not cleaned up — see module header */
  },
};
