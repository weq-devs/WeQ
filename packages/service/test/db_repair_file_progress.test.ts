import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { backupFileAndHash, fingerprintFile } from '../src/account/db_repair/files';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('异步备份与指纹返回真实字节计数，不覆盖已有目标，不联动源文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-repair-progress-'));
  roots.push(root);
  const source = join(root, 'source');
  const backup = join(root, 'backup');
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  writeFileSync(source, bytes);
  const events: [number, number][] = [];
  const result = await backupFileAndHash(source, backup, (done, total) =>
    events.push([done, total]),
  );
  expect(events[0]).toEqual([0, bytes.length]);
  expect(events.at(-1)).toEqual([bytes.length, bytes.length]);
  expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(await fingerprintFile(source, () => {})).toEqual(result);
  await expect(backupFileAndHash(source, backup, () => {})).rejects.toMatchObject({
    code: 'EEXIST',
  });
  writeFileSync(source, 'changed');
  expect(readFileSync(backup)).toEqual(bytes);
});
