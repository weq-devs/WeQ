// @vitest-environment node
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readOwnDatabaseKey } from '../src/main/qq_runtime/database_material';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'weq-owned-db-')));
  dirs.push(root);
  const direct = join(root, 'nt_db', 'nt_msg.db'),
    hashed = join(root, 'nt_qq_abcdef', 'nt_db', 'nt_msg.db');
  await mkdir(join(root, 'nt_db'), { recursive: true });
  await writeFile(direct, Buffer.alloc(4096));
  const key = 'FixtureKey123456';
  const nt = {
    scanKeyFromDatabase: vi.fn(async () => ({
      success: true,
      key,
      keyContextHex: 'private-nearby-memory',
    })),
  };
  return { root, direct, hashed, key, nt };
}
describe('托管数据库自身密钥采集', () => {
  it('只扫描自身 PID，保留原始口令且不转发附近内存', async () => {
    const f = await fixture();
    expect(await readOwnDatabaseKey(f.nt, f.root, [f.direct, f.hashed])).toEqual({
      dbPath: f.direct,
      dbKey: f.key,
    });
    expect(f.nt.scanKeyFromDatabase).toHaveBeenCalledWith(f.direct, process.pid);
  });
  it('路径越界或 symlink 指向外部时不读数据库', async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(readOwnDatabaseKey(f.nt, f.root, [other.direct])).rejects.toThrow(/路径无效/);
    await rm(f.direct);
    await symlink(other.direct, f.direct);
    await expect(readOwnDatabaseKey(f.nt, f.root, [f.direct])).rejects.toThrow(/外部/);
    expect(f.nt.scanKeyFromDatabase).not.toHaveBeenCalled();
  });
  it('两份消息库均存在时不猜测归属', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'nt_qq_abcdef', 'nt_db'), { recursive: true });
    await writeFile(f.hashed, Buffer.alloc(4096));
    await expect(readOwnDatabaseKey(f.nt, f.root, [f.direct, f.hashed])).rejects.toThrow(/歧义/);
    expect(f.nt.scanKeyFromDatabase).not.toHaveBeenCalled();
  });
  it('缺失或尚未创建完整页时不扫描，未验证的密钥不交付', async () => {
    const f = await fixture();
    await writeFile(f.direct, Buffer.alloc(100));
    await expect(readOwnDatabaseKey(f.nt, f.root, [f.direct])).rejects.toThrow(/尚未创建/);
    expect(f.nt.scanKeyFromDatabase).not.toHaveBeenCalled();
    await writeFile(f.direct, Buffer.alloc(4096));
    f.nt.scanKeyFromDatabase.mockResolvedValueOnce({
      success: false,
      key: f.key,
      keyContextHex: '',
    });
    await expect(readOwnDatabaseKey(f.nt, f.root, [f.direct])).rejects.toThrow(/密钥尚未就绪/);
  });
});
