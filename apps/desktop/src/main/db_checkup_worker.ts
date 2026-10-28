import { dirname } from 'node:path';
import { loadNative, resolveNtHelperPath } from '@weq/native';
import type { DbRepairTarget } from '@weq/service';
import { inspectDatabase } from './db_checkup_core';

async function main(): Promise<void> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 65536) throw new Error('体检请求过大');
  }
  const target = JSON.parse(input) as DbRepairTarget;
  process.chdir(dirname(resolveNtHelperPath()));
  const { ntHelper } = loadNative();
  const result = await inspectDatabase(ntHelper, target);
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}

void main().catch(() => process.exit(1));
