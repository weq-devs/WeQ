// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { createWebHost } from '../src/main/web/host';
import { prepareExportDestination } from '../src/main/ipc/routers/export_save';

it('Remote 忽略电脑长期保存位置，仅准备下载暂存；普通 Web 仍校验保存根', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-remote-export-'));
  try {
    const host = createWebHost({ exportDir: root, version: 'test' });
    const policy = { mode: 'preset' as const, directory: join(tmpdir(), 'computer-export') };
    const output = { kind: 'file' as const, name: '报告', extension: 'txt' };
    const prepared = await prepareExportDestination(
      policy,
      policy.directory,
      { ...host, remoteClient: true },
      output,
    );
    expect(prepared?.filePath && dirname(prepared.filePath)).toBe(realpathSync(root));
    expect(policy.directory).not.toBe(root);
    await expect(prepareExportDestination(policy, policy.directory, host, output)).rejects.toThrow(
      'Web 保存位置',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
