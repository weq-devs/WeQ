import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveSudoPath } from '@weq/native';
import {
  type AuthorizationBuildInfo,
  validateAuthorizationBuildInfo,
  validateNativeBuildInfo,
} from '@weq/native/authorization.mjs';
import type { LongTermAuthorizationStatus } from '../../shared/long_term_authorization';
import { AUTHORIZATION_PROTOCOL } from '../../shared/long_term_authorization';
import { requestSudoPassword } from '../sudo_prompt';
import {
  AuthorizationError,
  configureLongTermAuthorization,
  openLongTermAuthorization,
} from './client';

const execute = promisify(execFile);
interface HelperIdentity {
  id: string;
  root: string;
  endpoint: string;
  development: boolean;
  buildInfo: AuthorizationBuildInfo;
}
type HelperProbe = (file: string, operation: 'identity' | 'build-info') => Promise<string>;
const queryHelper: HelperProbe = async (file, operation) =>
  (
    await execute(file, [operation], {
      timeout: 5000,
      maxBuffer: 16_384,
      windowsHide: true,
    })
  ).stdout;
export function validateHelperBuildForOperation(
  info: AuthorizationBuildInfo,
  operation: 'install' | 'remove',
): void {
  if (operation === 'install' && !info.isDev) validateNativeBuildInfo(info, { production: true });
}
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
  private identityCache: { key: string; value: Promise<HelperIdentity> } | null = null;
  constructor(
    private readonly options: {
      helper: () => string;
      platform: NodeJS.Platform;
      allowDevelopment?: boolean;
      probe?: HelperProbe;
    },
  ) {
    configureLongTermAuthorization({
      endpoint: async () => (await this.identity()).endpoint,
      development: async () => (await this.identity()).development,
    });
  }
  private async inspect(file: string): Promise<HelperIdentity> {
    const probe = this.options.probe ?? queryHelper;
    const [identityText, buildText] = await Promise.all([
      probe(file, 'identity'),
      probe(file, 'build-info'),
    ]);
    const identity = JSON.parse(identityText) as Omit<HelperIdentity, 'buildInfo'>;
    const buildInfo = JSON.parse(buildText) as AuthorizationBuildInfo;
    validateAuthorizationBuildInfo(buildInfo, `${this.options.platform}-${process.arch}`);
    if (
      !identity.id ||
      !identity.root ||
      !identity.endpoint ||
      typeof buildInfo.isDev !== 'boolean'
    )
      throw new AuthorizationError('权限助手诊断信息不完整，请更新组件', 'incompatible');
    if (buildInfo.isDev && !this.options.allowDevelopment)
      throw new AuthorizationError('正式版不使用开发构建的权限助手', 'incompatible');
    if (buildInfo.isDev && (buildInfo.channel !== 'development' || identity.development !== true))
      throw new AuthorizationError('请重新编译支持隔离开发通道的权限助手', 'incompatible');
    return { ...identity, development: buildInfo.isDev, buildInfo };
  }
  private async identity() {
    const file = this.options.helper();
    const info = await stat(file, { bigint: true });
    const key = `${file}:${info.ino}:${info.size}:${info.mtimeNs}`;
    if (this.identityCache?.key !== key) {
      const value = this.inspect(file).catch((error: unknown) => {
        if (this.identityCache?.key === key) this.identityCache = null;
        throw error;
      });
      this.identityCache = { key, value };
    }
    return this.identityCache.value;
  }
  async status(): Promise<LongTermAuthorizationStatus> {
    const platform = this.options.platform;
    let identity: HelperIdentity;
    try {
      if (platform === 'linux') await stat('/run/systemd/system');
      identity = await this.identity();
    } catch (error) {
      return {
        platform,
        state: 'unavailable',
        message:
          error instanceof AuthorizationError ||
          (error instanceof Error && error.message.startsWith('WEQ_AUTHORIZATION_HELPER_PATH'))
            ? error.message
            : platform === 'linux'
              ? '当前安装缺少原生权限助手或 systemd，仍可使用临时授权。'
              : '当前安装未包含原生权限助手，请更新原生组件。',
      };
    }
    const base = { platform, development: identity.development };
    try {
      const { connection, info } = await openLongTermAuthorization();
      connection.close();
      if (info.development !== undefined && info.development !== identity.development)
        throw new AuthorizationError('助手运行通道与所选组件不一致，请重新检查', 'incompatible');
      const installed = await stat(
        join(
          identity.root,
          this.options.platform === 'win32'
            ? 'weq-authorization-helper.exe'
            : 'weq-authorization-helper',
        ),
      );
      return {
        ...base,
        state: 'ready',
        build: info.build,
        installedBytes: installed.size,
        message: identity.development
          ? '独立开发助手已连接，授权与正式版隔离；仅提供当前系统用户的 QQ 内存读取与网卡抓包。'
          : '原生权限助手已连接。仅授权当前系统用户的 QQ 内存读取与网卡抓包，不绕过系统保护。',
      };
    } catch (error) {
      if (error instanceof AuthorizationError && error.code === 'not-authorized')
        return { ...base, state: 'not-installed', message: '当前系统用户未启用此通道的长期授权。' };
      try {
        await stat(join(identity.root, 'manifest.json'));
      } catch {
        return {
          ...base,
          state: 'not-installed',
          message: identity.development
            ? '未启用独立开发助手；启用后不替换正式助手，权限不足时仍可临时授权。'
            : '未启用长期授权，权限不足时仍使用临时授权。',
        };
      }
      return {
        ...base,
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
  private async change(
    operation: 'install' | 'remove',
    expectedDevelopment?: boolean,
  ): Promise<LongTermAuthorizationStatus> {
    if (this.busy) throw new Error('长期授权操作正在进行中');
    this.busy = true;
    let temporary: string | null = null;
    try {
      if ((await this.status()).state === 'unavailable')
        throw new Error('当前环境无法管理长期授权');
      const identity = await this.identity();
      if (expectedDevelopment !== undefined && expectedDevelopment !== identity.development)
        throw new Error('助手通道已变化，请重新检查并确认');
      // 只暂存一个小型可执行文件，兼容 root 读不到 AppImage/FUSE 的宿主。
      temporary = await mkdtemp(join(tmpdir(), 'weq-authorization-'));
      const helper = join(temporary, this.options.platform === 'win32' ? 'helper.exe' : 'helper');
      await copyFile(this.options.helper(), helper);
      await chmod(helper, 0o755);
      const staged = await this.inspect(helper);
      if (
        staged.id !== identity.id ||
        staged.root !== identity.root ||
        staged.endpoint !== identity.endpoint ||
        staged.development !== identity.development
      )
        throw new Error('操作期间助手通道发生变化，请重新检查后再试');
      validateHelperBuildForOperation(staged.buildInfo, operation);
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
  install(expectedDevelopment?: boolean) {
    return this.change('install', expectedDevelopment);
  }
  remove(expectedDevelopment?: boolean) {
    return this.change('remove', expectedDevelopment);
  }
}
