import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveSudoPath } from '@weq/native';
import type { LongTermAuthorizationStatus } from '../../shared/long_term_authorization';
import { AUTHORIZATION_PROTOCOL } from '../../shared/long_term_authorization';
import { requestSudoPassword } from '../sudo_prompt';
import {
  AuthorizationError,
  configureLongTermAuthorization,
  openLongTermAuthorization,
} from './client';

const execute = promisify(execFile);
export async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export class AuthorizationInstaller {
  private busy = false;
  private identityCache: Promise<{ id: string; root: string; endpoint: string }> | null = null;
  constructor(private readonly options: { helper: () => string; platform: NodeJS.Platform }) {
    configureLongTermAuthorization({ endpoint: async () => (await this.identity()).endpoint });
  }
  private identity() {
    this.identityCache ??= execute(this.options.helper(), ['identity'], {
      timeout: 5000,
      maxBuffer: 16_384,
      windowsHide: true,
    })
      .then(({ stdout }) => JSON.parse(stdout) as { id: string; root: string; endpoint: string })
      .catch((error: unknown) => {
        this.identityCache = null;
        throw error;
      });
    return this.identityCache;
  }
  async status(): Promise<LongTermAuthorizationStatus> {
    const platform = this.options.platform;
    try {
      await stat(this.options.helper());
      if (platform === 'linux') await stat('/run/systemd/system');
    } catch {
      return {
        platform,
        state: 'unavailable',
        message:
          platform === 'linux'
            ? '当前安装缺少原生权限助手或 systemd，仍可使用临时授权。'
            : '当前安装未包含原生权限助手，请更新原生组件。',
      };
    }
    try {
      const { connection, info } = await openLongTermAuthorization();
      connection.close();
      const identity = await this.identity();
      const installed = await stat(
        join(
          identity.root,
          this.options.platform === 'win32'
            ? 'weq-authorization-helper.exe'
            : 'weq-authorization-helper',
        ),
      );
      return {
        platform,
        state: 'ready',
        build: info.build,
        installedBytes: installed.size,
        message: '原生权限助手已连接。仅授权当前系统用户的 QQ 内存读取与网卡抓包，不绕过系统保护。',
      };
    } catch (error) {
      if (error instanceof AuthorizationError && error.code === 'not-authorized')
        return { platform, state: 'not-installed', message: '当前系统用户未启用长期授权。' };
      try {
        await stat(join((await this.identity()).root, 'manifest.json'));
      } catch {
        return {
          platform,
          state: 'not-installed',
          message: '未启用长期授权，权限不足时仍使用临时授权。',
        };
      }
      return {
        platform,
        state: 'needs-repair',
        message:
          error instanceof AuthorizationError && error.code === 'component-expired'
            ? error.message
            : '权限助手未响应或协议不兼容，请重新检查或修复授权。',
      };
    }
  }
  private async elevate(helper: string, args: string[]): Promise<void> {
    if (this.options.platform === 'win32') {
      const argumentsText = args.map((arg) => `"${arg.replaceAll('"', '\\"')}"`).join(' ');
      const script = `$p=Start-Process -FilePath ${powershellQuote(helper)} -ArgumentList ${powershellQuote(argumentsText)} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
      await execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 16_384 },
      );
    } else if (this.options.platform === 'darwin') {
      const command = [helper, ...args].map(shellQuote).join(' ');
      await execute(
        '/usr/bin/osascript',
        ['-e', `do shell script ${JSON.stringify(command)} with administrator privileges`],
        { timeout: 10 * 60_000, maxBuffer: 16_384 },
      );
    } else {
      const password = await requestSudoPassword(
        '安装或撤销长期授权',
        '将修改 WeQ 原生权限助手的系统服务。管理员密码仅用于本次操作，不会保存。',
      );
      if (!password) throw new Error('已取消长期授权操作');
      await new Promise<void>((resolve, reject) => {
        const child = spawn(resolveSudoPath(), ['-S', '-p', '', '--', helper, ...args], {
          stdio: ['pipe', 'ignore', 'pipe'],
        });
        let detail = '';
        child.stderr.on('data', (chunk: Buffer) => {
          detail = (detail + chunk.toString('utf8')).slice(-4096);
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('长期授权操作超时'));
        }, 10 * 60_000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(detail || '长期授权操作未完成'));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(`${password}\n`);
      });
    }
  }
  private async change(operation: 'install' | 'remove'): Promise<LongTermAuthorizationStatus> {
    if (this.busy) throw new Error('长期授权操作正在进行中');
    this.busy = true;
    let temporary: string | null = null;
    try {
      if ((await this.status()).state === 'unavailable')
        throw new Error('当前环境无法管理长期授权');
      const identity = await this.identity();
      // 只暂存一个小型可执行文件，兼容 root 读不到 AppImage/FUSE 的宿主。
      temporary = await mkdtemp(join(tmpdir(), 'weq-authorization-'));
      const helper = join(temporary, this.options.platform === 'win32' ? 'helper.exe' : 'helper');
      await copyFile(this.options.helper(), helper);
      await chmod(helper, 0o755);
      let args = ['remove', identity.id];
      if (operation === 'install') {
        const manifest = join(temporary, 'install.json');
        await writeFile(
          manifest,
          JSON.stringify({
            protocol: AUTHORIZATION_PROTOCOL,
            identity: identity.id,
            sha256: await fileDigest(helper),
          }),
          { mode: 0o600 },
        );
        args = ['install', manifest];
      }
      await this.elevate(helper, args);
      let status = await this.status();
      for (
        let attempt = 0;
        operation === 'install' && status.state !== 'ready' && attempt < 15;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        status = await this.status();
      }
      return status;
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
      this.busy = false;
    }
  }
  install() {
    return this.change('install');
  }
  remove() {
    return this.change('remove');
  }
}
