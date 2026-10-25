import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { DOMParser } from '@xmldom/xmldom';
import { daemonStop, pingDaemon } from '@weq/service';

export type RunCommand = (command: string, args: string[]) => Promise<{ stdout: string }>;
const exec = promisify(execFile);
export const runCommand: RunCommand = (command, args) =>
  exec(command, args, { timeout: 8000, windowsHide: true });

export function legacyDaemonStateDir(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? home, 'weq-daemon');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'weq-daemon');
  return join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'weq-daemon');
}

async function optionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** 只退役 WeQ 的固定旧入口，不执行旧二进制、不删除旧数据、不修改系统全局 linger。 */
export async function retireLegacyDaemon(options: {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  run?: RunCommand;
  uid?: number;
}): Promise<void> {
  const { platform, home, env, uid = process.getuid?.() } = options;
  const run = options.run ?? runCommand;
  if (platform === process.platform && (platform === 'darwin' || platform === 'linux')) {
    const parent = await run('/bin/ps', ['-p', String(process.ppid), '-o', 'comm=']).catch(() => ({
      stdout: '',
    }));
    if (/(?:^|\/)weq-daemon(?:\s|$)/i.test(parent.stdout.trim())) {
      throw new Error('当前 WeQ 由旧后台启动；请完全退出后从系统启动器重新打开，再完成旧后台迁移');
    }
  }
  for (const label of ['weq-daemon', 'weq-daemon-gui']) {
    if (platform === 'darwin') {
      const path = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
      if ((await optionalFile(path)) === null) continue;
      const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path]);
      const parsed: unknown = JSON.parse(stdout);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('Label' in parsed) ||
        parsed.Label !== label ||
        !('ProgramArguments' in parsed) ||
        !Array.isArray(parsed.ProgramArguments) ||
        !parsed.ProgramArguments.some((arg: unknown) => typeof arg === 'string' && /weq/i.test(arg))
      )
        throw new Error(`旧服务 ${label} 的配置不匹配，未移除`);
      if (uid === undefined) throw new Error('无法确定旧服务所属用户');
      // 旧 GUI 登录项可能就是当前应用，不能 bootout 杀掉自己；一次性登录触发只需移除文件。
      if (label === 'weq-daemon-gui') {
        if ('KeepAlive' in parsed && parsed.KeepAlive)
          throw new Error('旧 GUI 登录项仍设为常驻，请停用旧入口后重开 WeQ');
        await rm(path);
        continue;
      }
      const target = `gui/${uid}/${label}`;
      try {
        await run('/bin/launchctl', ['bootout', target]);
      } catch (error) {
        const loaded = await run('/bin/launchctl', ['print', target]).then(
          () => true,
          () => false,
        );
        if (loaded) throw error;
      }
      await rm(path);
    } else if (platform === 'linux') {
      const path = join(home, '.config', 'systemd', 'user', `${label}.service`);
      const text = await optionalFile(path);
      if (text === null) continue;
      if (!/weq/i.test(text)) throw new Error(`旧服务 ${label} 的配置不匹配，未移除`);
      if (platform === process.platform) {
        const { stdout } = await run('systemctl', [
          '--user',
          'show',
          `${label}.service`,
          '--property=ControlGroup',
          '--value',
        ]);
        const group = stdout.trim();
        const ownGroups = await readFile('/proc/self/cgroup', 'utf8');
        if (
          group.startsWith('/') &&
          group !== '/' &&
          ownGroups.split('\n').some((line) => {
            const path = line.slice(line.lastIndexOf(':') + 1);
            return path === group || path.startsWith(`${group}/`);
          })
        )
          throw new Error('当前 WeQ 仍属于旧后台服务，请完全退出后从系统启动器重新打开');
      }
      await run('systemctl', ['--user', 'disable', '--now', `${label}.service`]);
      await rm(path);
      await run('systemctl', ['--user', 'daemon-reload']);
    } else if (platform === 'win32') {
      const command = win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe');
      const task = await run(command, ['/Query', '/TN', label, '/XML']).catch(
        async (error: unknown) => {
          if ((error as { code?: unknown }).code === 1) {
            const powershell = win32.join(
              env.SystemRoot ?? 'C:\\Windows',
              'System32',
              'WindowsPowerShell',
              'v1.0',
              'powershell.exe',
            );
            const { stdout } = await run(powershell, [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              "$ErrorActionPreference='Stop'; ConvertTo-Json -InputObject @(Get-ScheduledTask -ErrorAction Stop | Select-Object TaskName,TaskPath) -Compress",
            ]);
            const tasks: unknown = JSON.parse(stdout);
            if (
              !Array.isArray(tasks) ||
              !tasks.every(
                (entry: unknown) =>
                  entry &&
                  typeof entry === 'object' &&
                  'TaskName' in entry &&
                  typeof entry.TaskName === 'string' &&
                  'TaskPath' in entry &&
                  typeof entry.TaskPath === 'string',
              )
            )
              throw new Error('无法核实旧计划任务是否存在');
            if (!tasks.some((entry) => entry.TaskName === label && entry.TaskPath === '\\'))
              return null;
          }
          throw error;
        },
      );
      if (!task) continue;
      const xml = new DOMParser().parseFromString(task.stdout, 'text/xml');
      const commands = Array.from(xml.getElementsByTagName('Command'));
      if (!commands.some((entry) => /weq/i.test(entry.textContent ?? '')))
        throw new Error(`旧任务 ${label} 的配置不匹配，未移除`);
      if (label !== 'weq-daemon-gui') await run(command, ['/End', '/TN', label]).catch(() => {});
      await run(command, ['/Delete', '/TN', label, '/F']);
    }
  }
  await daemonStop();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await pingDaemon())) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('旧 WeQ 后台尚未停止，请检查旧服务后重启 WeQ');
}
