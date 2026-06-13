/**
 * Test 1 — Win32DetectService.
 *
 * Exercises every read-only probe Win32DetectService exposes:
 *   - describeInstall()       paths discoverable without any QQ running
 *   - listAccounts()          parses login.db
 *   - detectRunningProcesses() walks live QQ.exe PIDs + port probes
 *
 * Run:  pnpm --filter @weq/service test:win32-detect
 *
 * No QQ login needed — this is the "what does the machine even have?"
 * sanity check.
 */

import { loadNative } from '@weq/native';
import { createWin32Platform } from '@weq/platform';
import { Win32DetectService } from '../src/bootstrap/win32_detect';

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
function log(msg: string, ...rest: unknown[]): void {
  console.log(`[${ts()}] ${msg}`, ...rest);
}

async function main(): Promise<void> {
  const platform = createWin32Platform(loadNative());
  const detect = new Win32DetectService(platform);

  log('--- [1] describeInstall() ---');
  const install = detect.describeInstall();
  log('QQ.exe         :', install.qqExePath);
  log('wrapper.node   :', install.wrapperNodePath);
  log('login.db       :', install.loginDbPath);
  log('Tencent Files  :');
  for (const root of install.tencentFilesRoots) {
    log('  -', root);
  }
  console.log();

  log('--- [2] listAccounts() ---');
  try {
    const accounts = await detect.listAccounts();
    log(`got ${accounts.length} account(s) from login.db`);
    for (const acc of accounts) {
      log('  -', acc.uin, acc.userName);
      // log(JSON.stringify(acc));
    }
  } catch (e) {
    log('listAccounts failed:', (e as Error).message);
  }
  console.log();

  log('--- [3] detectRunningProcesses() ---');
  const procs = detect.detectRunningProcesses();
  log(`got ${procs.length} running QQ process(es)`);
  for (const p of procs) {
    log(`  PID=${p.pid}`, p.loginInfo ?? '(no port info)');
  }
}

main().catch((e) => {
  console.error('[test:win32-detect] failed:', e);
  process.exit(1);
});
