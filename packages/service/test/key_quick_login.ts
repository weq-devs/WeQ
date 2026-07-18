/**
 * Test 3 — Win32KeyService.quickLoginStream (quick UIN-cached login).
 *
 * Mirrors `Qrypt-Native/nt_helper/test/test_quick_login.mjs`:
 *   - NDJSON events stream back as the bootstrap script inside QQ runs
 *   - `login-list` arrives mid-flight (QQ read its login.db)
 *   - `result` is terminal
 *
 * The pipe server / NDJSON parsing / QQ kill are all hidden inside
 * `NineBirdBootstrap` (which `Win32KeyService` wraps). Compared to the
 * raw nt_helper test, we just iterate an `AsyncIterable<KeyEvent>`.
 *
 * Run:  pnpm --filter @weq/service test:key-quick
 *
 * Args:
 *   WEQ_TEST_UIN env var (or argv[2]) — configured via root .env
 */

import { loadNative } from '@weq/native';
import { createWin32Platform } from '@weq/platform';
import { Win32KeyService } from '../src/bootstrap/win32_key';
import { testEnv } from '@weq/testkit';

const UIN = process.argv[2] ?? testEnv.uin;
const TIMEOUT_MS = 60_000;

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

async function main(): Promise<void> {
  const platform = createWin32Platform(loadNative());
  const keys = new Win32KeyService(platform);

  log('=== quickLoginStream demo ===');
  log('uin       =', UIN);
  log('timeoutMs =', TIMEOUT_MS);

  let receivedLoginList = false;

  for await (const e of keys.quickLoginStream({ uin: UIN, timeoutMs: TIMEOUT_MS })) {
    switch (e.kind) {
      case 'login-list': {
        receivedLoginList = true;
        log(`recv login-list: ${e.list.length} item(s)`);
        for (const u of e.list) {
          log('  -', u.uin, u.userName);
        }
        break;
      }
      case 'result': {
        log('=== RESULT ===');
        log('success                       :', e.result.success);
        if (e.result.dbkey) log('dbkey                         :', e.result.dbkey);
        if (e.result.error) log('error                         :', e.result.error);
        log('received login-list beforehand:', receivedLoginList);
        process.exit(e.result.success ? 0 : 1);
        break;
      }
      // 'qrcode' / 'qrcode-state' don't appear in quick-login; ignore.
      default:
        log('recv unexpected kind:', e);
    }
  }

  logErr('stream ended without a `result` event');
  process.exit(1);
}

process.on('unhandledRejection', (reason) => logErr('unhandledRejection:', reason));
process.on('uncaughtException', (err) => logErr('uncaughtException:', err));

main().catch((e) => {
  logErr('main threw:', e);
  process.exit(1);
});
