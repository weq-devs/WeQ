/**
 * Linux injection worker — the ROOT half of the elevated inject flow.
 *
 * Injection into a running QQ needs ptrace (root); fetching keys afterwards
 * does not (the hook's unix socket is reachable unprivileged). So we isolate
 * ONLY the inject in a short-lived root child: `inject_elevation.ts` spawns this
 * via `pkexec`, we require `nt_helper.node`, call `injectAndGetStatusEmbedded`,
 * print a one-line JSON result to stdout, and exit. The parent then talks to the
 * hook socket unprivileged.
 *
 * Bundled by electron-vite as a SEPARATE `.mjs` entry so the packaged (asar)
 * build can run it via `ELECTRON_RUN_AS_NODE` electron-as-node — end-user
 * machines aren't assumed to have a system `node`.
 *
 * Two pkexec-specific gotchas handled here:
 *   1. pkexec RESETS cwd, but the addon validates a LICENSE found by walking up
 *      from cwd — so we chdir into the addon's own directory (LICENSE sits a few
 *      levels up in both dev and packaged layouts, within its 5-level search).
 *   2. All inputs arrive as argv positionals (pkexec scrubs the environment).
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const requireFn = createRequire(__filename);

interface InjectResult {
  ok: boolean;
  status?: { pid: number; loggedIn: boolean; uin: string };
  error?: string;
}

function fail(error: string, code: number): never {
  const payload: InjectResult = { ok: false, error };
  process.stderr.write(JSON.stringify(payload));
  process.exit(code);
}

async function main(): Promise<void> {
  const pid = Number(process.argv[2]);
  const ntHelperPath = process.argv[3];

  if (!Number.isInteger(pid) || pid <= 0) fail(`bad pid: ${process.argv[2]}`, 2);
  if (!ntHelperPath) fail('missing nt_helper.node path (argv[3])', 2);

  // Must run BEFORE require — the addon's LICENSE check runs on load, and it
  // walks up from cwd. The addon dir's ancestors contain the LICENSE.
  try {
    process.chdir(dirname(ntHelperPath));
  } catch (e) {
    fail(`chdir failed: ${e instanceof Error ? e.message : String(e)}`, 2);
  }

  let nt: {
    getInitStatus(): number;
    injectAndGetStatusEmbedded(pid: number): Promise<{ pid: number; loggedIn: boolean; uin: string }>;
  };
  try {
    nt = requireFn(ntHelperPath);
  } catch (e) {
    fail(`require nt_helper.node failed: ${e instanceof Error ? e.message : String(e)}`, 1);
  }

  const initStatus = nt.getInitStatus();
  if (initStatus !== 0) fail(`nt_helper init failed (status ${initStatus})`, 1);

  try {
    const status = await nt.injectAndGetStatusEmbedded(pid);
    const payload: InjectResult = { ok: true, status };
    process.stdout.write(JSON.stringify(payload));
    process.exit(0);
  } catch (e) {
    fail(`inject failed: ${e instanceof Error ? e.message : String(e)}`, 1);
  }
}

void main();
