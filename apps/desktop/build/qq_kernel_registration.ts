import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const QQ_KERNEL_REGISTRATION_FILE = 'qqKernelRegistration.node';

export function qqKernelRegistrationArgs(source: string, output: string): string[] {
  return [
    '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=13.0',
    '-dynamiclib', '-undefined', 'dynamic_lookup', '-fvisibility=hidden',
    '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output,
  ];
}

/** 桥只有稳定的 N-API ABI，无第三方依赖；一次生成两种 Mac 架构。 */
export async function buildQQKernelRegistration(appRoot: string, outputDir: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  await mkdir(outputDir, { recursive: true });
  const output = join(outputDir, QQ_KERNEL_REGISTRATION_FILE);
  await execute('/usr/bin/clang', qqKernelRegistrationArgs(resolve(appRoot, 'native/qq_kernel_registration.c'), output), {
    timeout: 30_000, maxBuffer: 64 * 1024,
  });
  return output;
}
