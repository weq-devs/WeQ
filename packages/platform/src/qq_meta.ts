/**
 * Cross-platform QQ metadata readers — pure functions shared by every OS
 * adapter so the logic lives in exactly one place.
 *
 * QQ ships a `package.json` next to `wrapper.node` inside `resources/app`
 * (win32: `…/versions/<cur>/resources/app`, linux: `…/resources/app`). Its
 * `version` field ("3.2.31-51102") is the authoritative client version — far
 * more robust than scraping the version out of the on-disk path, which only
 * works on win32's `versions/<ver>/` layout and breaks on linux's flat one.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Read QQ's client version from the `package.json` co-located with
 * `wrapper.node` (both live in `resources/app`). Returns null when the
 * wrapper path is unknown, the file is missing/unreadable, or it carries no
 * `version`. Works identically on win32 and linux.
 */
export function readQqVersion(wrapperNodePath: string | null): string | null {
  if (!wrapperNodePath) return null;
  const pkg = join(dirname(wrapperNodePath), 'package.json');
  if (!existsSync(pkg)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pkg, 'utf-8')) as { version?: string };
    const v = parsed.version;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Number of running QQ launcher instances, read from `<root>/versions/setting.json`'s
 * `launcherCounts`. QQ maintains this itself on every platform, so it's a far more
 * reliable "online instance count" than counting Electron processes (one instance
 * forks gpu/renderer/utility/zygote, all named `qq`). Win32's root is the QQ install
 * dir (`C:\Program Files\Tencent\QQNT`), linux's is the data dir (`~/.config/QQ`).
 *
 * Returns null when the file is missing / unreadable / has no numeric
 * `launcherCounts`, so callers can fall back to the process-count probe.
 * `root` is the QQ root whose `versions/` holds `setting.json`; pass null to
 * short-circuit.
 */
export function readLauncherCount(root: string | null): number | null {
  if (!root) return null;
  const settingPath = join(root, 'versions', 'setting.json');
  try {
    const parsed = JSON.parse(readFileSync(settingPath, 'utf-8')) as { launcherCounts?: unknown };
    const n = parsed.launcherCounts;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
