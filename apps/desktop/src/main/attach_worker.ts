/**
 * Attach worker — the ROOT half of the elevated attach flow.
 *
 * Reading a running QQ's memory needs a ptrace attach (root: the same
 * `PTRACE_MODE_ATTACH` gate that used to guard injection). Nothing else here
 * does. So we isolate ONLY the memory read in a short-lived root child:
 * `attach_elevation.ts` spawns this via `sudo -S` (password from a self-drawn
 * renderer dialog), we require `nt_helper.node`, call `scanSessionMaterial(pid)`,
 * print a one-line JSON result to stdout, and exit.
 *
 * Bundled by electron-vite as a SEPARATE `.mjs` entry so the packaged (asar)
 * build can run it via `ELECTRON_RUN_AS_NODE` electron-as-node — end-user
 * machines aren't assumed to have a system `node`.
 *
 * Gotchas handled here:
 *   1. The addon validates a LICENSE found by walking up from cwd — so we
 *      chdir into the addon's own directory (LICENSE sits a few levels up in
 *      both dev and packaged layouts, within its 5-level search).
 *   2. All inputs arrive as argv positionals (the parent feeds them explicitly,
 *      never via the environment).
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const requireFn = createRequire(__filename);

/** 一次扫描的物料 —— 与 `@weq/native` 的 `SessionMaterial` 同形。 */
interface SessionMaterial {
  a2?: string;
  d2?: string;
  d2Key?: string;
}

interface AttachResult {
  ok: boolean;
  material?: SessionMaterial;
  error?: string;
}

function fail(error: string, code: number): never {
  const payload: AttachResult = { ok: false, error };
  process.stderr.write(JSON.stringify(payload));
  process.exit(code);
}

async function main(): Promise<void> {
  const pid = Number(process.argv[2]);
  // argv[3] 是账号 uin —— 读取本身不需要它（只用于归属/诊断），保留这个位置是
  // 为了让父进程的参数布局不随实现变化。
  const uin = process.argv[3];
  const ntHelperPath = process.argv[4];

  if (!Number.isInteger(pid) || pid <= 0) fail(`bad pid: ${process.argv[2]}`, 2);
  if (!uin) fail('missing account uin (argv[3])', 2);
  if (!ntHelperPath) fail('missing nt_helper.node path (argv[4])', 2);

  // Must run BEFORE require — the addon's LICENSE check runs on load, and it
  // walks up from cwd. The addon dir's ancestors contain the LICENSE.
  try {
    process.chdir(dirname(ntHelperPath));
  } catch (e) {
    fail(`chdir failed: ${e instanceof Error ? e.message : String(e)}`, 2);
  }

  let nt: {
    getInitStatus(): number;
    scanSessionMaterial(pid: number): Promise<SessionMaterial>;
  };
  try {
    nt = requireFn(ntHelperPath);
  } catch (e) {
    fail(`require nt_helper.node failed: ${e instanceof Error ? e.message : String(e)}`, 1);
  }

  const initStatus = nt.getInitStatus();
  if (initStatus !== 0) fail(`nt_helper init failed (status ${initStatus})`, 1);

  try {
    const material = await nt.scanSessionMaterial(pid);
    const payload: AttachResult = { ok: true, material };
    process.stdout.write(JSON.stringify(payload));
    process.exit(0);
  } catch (e) {
    fail(`attach failed: ${e instanceof Error ? e.message : String(e)}`, 1);
  }
}

void main();
