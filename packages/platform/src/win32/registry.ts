/**
 * Locate QQ.exe via the Windows registry. Replicates the logic from the
 * NapCat batch file.
 *
 * We call `reg query` directly instead of via `cmd /c` to avoid complex
 * quoting issues that often lead to "ERROR: Invalid key name".
 *
 * Then drops the leaf filename to get the install dir, and appends
 * `QQ.exe`. Failure modes (key missing, malformed value, binary absent)
 * all collapse to `null` — callers decide what to do.
 *
 * Win32-only. `child_process.spawnSync('reg', …)` blocks for ~30ms in
 * normal cases, which is fine for a one-shot bootstrap call.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const REG_KEY =
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ';
const REG_VALUE = 'UninstallString';

/**
 * Run `reg query` and parse the `UninstallString` value. Returns the raw
 * uninstaller path (e.g. `C:\Program Files\Tencent\QQNT\Uninstall.exe`),
 * or null if the registry doesn't have the key.
 */
function readUninstallString(): string | null {
  // Directly calling 'reg' with an arguments array avoids cmd.exe's nested quote pitfalls.
  const result = spawnSync(
    'reg',
    ['query', REG_KEY, '/v', REG_VALUE],
    { encoding: 'utf-8', windowsHide: true },
  );

  if (result.status !== 0) return null;

  // reg query output looks like:
  //   HKEY_LOCAL_MACHINE\...\QQ
  //       UninstallString    REG_SZ    "C:\Program Files\Tencent\QQNT\Uninstall.exe"
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*UninstallString\s+REG_\w+\s+(.+?)\s*$/);
    if (match?.[1]) {
      let rawPath = match[1].trim();

      // Remove surrounding quotes if present
      if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
        rawPath = rawPath.slice(1, -1);
      }

      return rawPath;
    }
  }
  return null;
}


/**
 * Best-effort QQ install root (the directory containing `QQ.exe`).
 * Strips the uninstaller filename from `UninstallString`. Returns null if
 * registry lookup failed or the directory doesn't exist.
 */
export function findQqInstallRoot(): string | null {
  const uninstall = readUninstallString();
  if (!uninstall) return null;
  const root = dirname(uninstall);
  return existsSync(root) ? root : null;
}

/** `<qqRoot>/QQ.exe` if both the registry key and the binary exist. */
export function findQqExe(): string | null {
  const root = findQqInstallRoot();
  if (!root) return null;
  const exe = join(root, 'QQ.exe');
  return existsSync(exe) ? exe : null;
}
