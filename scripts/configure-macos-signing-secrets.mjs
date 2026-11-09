import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyMacCertificate } from './verify-macos-signing.mjs';

const run = promisify(execFile);

async function setSecret(name, value) {
  await new Promise((resolve, reject) => {
    const child = spawn('gh', ['secret', 'set', name, '--repo', 'weq-devs/WeQ'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`配置 ${name} 超时`));
    }, 30_000);
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error(`无法配置 ${name}`));
    });
    child.stdin.on('error', () => {});
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`配置 ${name} 失败，未确认完成`));
    });
    child.stdin.end(value);
  });
}

/** 只有显式运行本入口才更新仓库 secrets；正文经 stdin，不出现在参数或日志中。 */
export async function configureMacSigningSecrets(directory) {
  verifyMacCertificate(await readFile(join(directory, 'certificate.pem')));
  // 写入前先检查当前 gh 登录可访问目标仓库；没有认证时不开始部分配置。
  await run('gh', ['secret', 'list', '--repo', 'weq-devs/WeQ', '--json', 'name'], {
    timeout: 20_000,
  });
  await setSecret('CSC_LINK', (await readFile(join(directory, 'identity.p12'))).toString('base64'));
  await setSecret('CSC_KEY_PASSWORD', await readFile(join(directory, 'password'), 'utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directory = resolve(
      process.argv[2] ?? join(homedir(), 'Library/Application Support/WeQSigning/release'),
    );
    await configureMacSigningSecrets(directory);
    console.log('weq-devs/WeQ macOS 签名 secrets 已配置');
  } catch {
    console.error(
      'macOS 签名 secrets 未确认全部配置，请检查 gh 登录与仓库访问后重试；未推送或发布',
    );
    process.exitCode = 1;
  }
}
