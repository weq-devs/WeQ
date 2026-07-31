/**
 * Test 4 — Win32KeyService.qrLoginStream (QR code login).
 *
 * Mirrors `Qrypt-Native/nt_helper/test/test_qr_login.mjs`:
 *   - `qrcode`        — URL to render as a QR (we ASCII-render it to the
 *                       terminal so you can scan from your phone)
 *   - `qrcode-state`  — status transitions (waiting / scanned / confirmed)
 *   - `result`        — terminal event with dbkey or error
 *
 * Run:  pnpm --filter @weq/service test:key-qr
 *
 * Defaults: 3-minute timeout. Pass argv[2] to override (seconds).
 */

import QRCode from 'qrcode';
import { loadNative } from '@weq/native';
import { createWin32Platform } from '@weq/platform';
import { Win32KeyService } from '../src/bootstrap/win32_key';

const TIMEOUT_MS = Number(process.argv[2] ?? 180) * 1000;

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

async function renderQrToTerminal(url: string): Promise<void> {
  const art = await QRCode.toString(url, { type: 'terminal', small: true });
  console.log(art);
}

async function main(): Promise<void> {
  const platform = createWin32Platform(loadNative());
  const keys = new Win32KeyService(platform);

  log('=== qrLoginStream demo ===');
  log('timeoutMs =', TIMEOUT_MS);

  for await (const e of keys.qrLoginStream({ timeoutMs: TIMEOUT_MS })) {
    switch (e.kind) {
      case 'qrcode': {
        log('🟢 scan this QR to log in:');
        await renderQrToTerminal(e.url);
        log('URL =', e.url);
        break;
      }
      case 'qrcode-state': {
        log('🟡 qrcode state:', e.state);
        break;
      }
      case 'result': {
        log('=== RESULT ===');
        log('success :', e.result.success);
        if (e.result.dbkey) log('dbkey   :', e.result.dbkey);
        if (e.result.error) log('error   :', e.result.error);
        process.exit(e.result.success ? 0 : 1);
        break;
      }
      // 'login-list' doesn't appear in QR-login; ignore.
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
