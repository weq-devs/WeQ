/**
 * Test 2 — Win32KeyService.fetchFromInstance against a live QQ.
 *
 * Mirrors `Qrypt-Native/nt_helper/test/test_protocol.js`:
 *   1. getQqProcesses() → first PID
 *   2. probeQqLoginInfo(pid)
 *   3. injectAndGetStatusEmbedded(pid) with retry on "os error 2"
 *      (pipe not ready yet — the hook DLL needs a moment after injection)
 *   4. fetchFromInstance(pid, dbPath) → dbkey
 *
 * Run:  pnpm --filter @weq/service test:key-alive
 *
 * QQ must be running AND logged in before you start this test.
 * The injection path uses the embedded hook DLL bundled inside
 * `nt_helper.node` — no extra setup needed.
 */

import { loadNative } from '@weq/native';
import { createWin32Platform } from '@weq/platform';
import { Win32KeyService } from '../src/bootstrap/win32_key';
import { Win32DetectService } from '../src/bootstrap/win32_detect';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
function log(msg: string, ...rest: unknown[]): void {
  console.log(`[${ts()}] ${msg}`, ...rest);
}
function logErr(msg: string, ...rest: unknown[]): void {
  console.error(`[${ts()}] ${msg}`, ...rest);
}
function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function main(): Promise<void> {
  const platform = createWin32Platform(loadNative());
  const detect = new Win32DetectService(platform);
  const keys = new Win32KeyService(platform);
  const nt = platform.native.ntHelper;

  log('--- [1] getInitStatus ---');
  log('init status =', nt.getInitStatus());

  log('--- [2] detectRunningProcesses ---');
  const procs = detect.detectRunningProcesses();
  log(`found ${procs.length} QQ process(es)`);
  if (procs.length === 0) {
    logErr('No QQ.exe running — start QQ and log in first.');
    process.exit(2);
  }
  const target = procs[0]!;
  log('target PID =', target.pid);
  log('port info  =', target.loginInfo);

  log('--- [3] inject embedded hook ---');
  let status = null;
  for (let i = 1; i <= 5; i++) {
    log(`attempt ${i}...`);
    try {
      status = await nt.injectAndGetStatusEmbedded(target.pid);
      break;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('os error 2')) {
        log('pipe not ready yet, waiting 2s...');
        await sleep(2000);
      } else {
        logErr('injection failed:', msg);
        process.exit(3);
      }
    }
  }
  if (!status) {
    logErr('failed to establish pipe connection after multiple attempts');
    process.exit(3);
  }
  log('injection status =', status);

  if (!status.loggedIn) {
    log('QQ not logged in — skipping fetchFromInstance.');
    return;
  }

  log('--- [4] fetchFromInstance ---');
  log('uin    =', status.uin);
  log('dbPath =', DB_PATH);
  const t0 = Date.now();
  const result = await keys.fetchFromInstance(target.pid, DB_PATH);
  log(`fetchFromInstance returned in ${Date.now() - t0}ms`);
  if (result.success) {
    log('SUCCESS dbkey =', result.dbkey);
  } else {
    logErr('FAIL error =', result.error);
    process.exit(4);
  }
}

process.on('unhandledRejection', (reason) => logErr('unhandledRejection:', reason));
process.on('uncaughtException', (err) => logErr('uncaughtException:', err));

main().catch((e) => {
  logErr('main threw:', e);
  process.exit(1);
});
