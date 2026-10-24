import { loadNative, resolveNtHelperPath } from '@weq/native';
import { dirname } from 'node:path';
import { backupProbeInput } from './backup_probe_protocol';
import { inspectBackupDatabases } from './backup_probe_core';

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 16384) throw new Error('备份探测请求过大');
  }
  const request = backupProbeInput.parse(JSON.parse(input));
  process.chdir(dirname(resolveNtHelperPath()));
  const { ntHelper } = loadNative();
  const result = await inspectBackupDatabases(ntHelper, request);
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}

void main().catch(() => {
  process.stdout.write(
    `${JSON.stringify({ status: 'error', error: '备份探测进程初始化失败' })}\n`,
    () => process.exit(1),
  );
});
