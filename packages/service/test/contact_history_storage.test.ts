import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { UserConfigService } from '../src/bootstrap/user_config';

it('联系人历史单列统计且不进入普通缓存清理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-contact-storage-'));
  try {
    const config = new UserConfigService({ appDataRoot: () => root });
    const path = join(config.cacheDir('contacts/fixture/99999'), 'history.sqlite');
    await writeFile(path, 'synthetic history');
    const item = (await config.listStorageUsage()).find((value) => value.id === 'contacts');
    expect(item).toMatchObject({ label: '联系人与群资料历史', clearable: false, bytes: 17 });
    expect((await config.clearCache(['contacts'])).cleared).not.toContain('contacts');
    expect(await readFile(path, 'utf8')).toBe('synthetic history');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
