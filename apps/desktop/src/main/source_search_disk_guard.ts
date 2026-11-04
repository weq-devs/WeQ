import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 本机有统一外盘守卫时复用其 UUID/hold 协议；不把宿主私有工具变成产品依赖。 */
export function sourceSearchCommand(
  executable: string,
  args: string[],
  paths: string[],
  options: {
    platform?: NodeJS.Platform;
    guardPath?: string;
    physicalPath?: (path: string) => string;
    exists?: (path: string) => boolean;
  } = {},
) {
  const command = { executable, args };
  if ((options.platform ?? process.platform) !== 'darwin') return command;
  const guard =
    options.guardPath ??
    process.env.WEQ_EXTERNAL_DISK_GUARD ??
    join(homedir(), 'Projects', 'local-portal', 'external_disk_guard.py');
  if (!(options.exists ?? existsSync)(guard)) return command;
  const roots = new Set<string>();
  for (const path of paths) {
    let physical: string;
    try {
      physical = (options.physicalPath ?? realpathSync)(path);
    } catch {
      continue;
    }
    const match = /^\/Volumes\/([^/]+)(?:\/|$)/.exec(physical);
    if (match) roots.add(`/Volumes/${match[1]}`);
  }
  if (!roots.size) return command;
  return {
    executable: process.env.WEQ_EXTERNAL_DISK_PYTHON ?? '/usr/bin/python3',
    args: [
      guard,
      '--name',
      'weq-search-owned-reader',
      '--once',
      ...[...roots].flatMap((root) => ['--root', root]),
      '--',
      executable,
      ...args,
    ],
  };
}
