// @vitest-environment node
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverManagedQQInstallation } from '../src/main/qq_runtime/installation';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'weq-qq-install-')));
  directories.push(root);
  const wrapper = join(root, 'wrapper.node'),
    major = join(root, 'major.node');
  await Promise.all([writeFile(wrapper, 'fixture'), writeFile(major, 'fixture')]);
  const info = { appid: '12345', version: '7.0.1', build: '12345', qua: 'fixture-qua' };
  const source = {
    kind: 'darwin' as const,
    qqWrapperNodePath: vi.fn(() => wrapper),
    qqMajorNodePath: vi.fn(() => major),
    qqVersion: () => '7.0.1-12345',
    native: { ntHelper: { resolveAppidFromMajor: vi.fn(() => info) } },
  };
  return { root, wrapper, major, info, source };
}
describe('托管 QQ 安装发现', () => {
  it('复用安装发现与原生信息解析，不从外部进程拼接版本', async () => {
    const f = await fixture();
    expect(await discoverManagedQQInstallation(f.source)).toEqual({
      wrapperPath: f.wrapper,
      majorPath: f.major,
      client: { appId: f.info.appid, version: f.source.qqVersion(), qua: f.info.qua },
    });
    expect(f.source.qqWrapperNodePath).toHaveBeenCalledWith();
    expect(f.source.qqMajorNodePath).toHaveBeenCalledWith();
    expect(f.source.native.ntHelper.resolveAppidFromMajor).toHaveBeenCalledWith(f.major);
  });
  it('拒绝混合安装和目录占位', async () => {
    const f = await fixture();
    const other = join(f.root, 'other');
    await mkdir(other);
    const otherMajor = join(other, 'major.node');
    await writeFile(otherMajor, 'fixture');
    f.source.qqMajorNodePath.mockReturnValue(otherMajor);
    await expect(discoverManagedQQInstallation(f.source)).rejects.toThrow(/同一安装/);
    f.source.qqMajorNodePath.mockReturnValue(f.root);
    f.source.qqWrapperNodePath.mockReturnValue(f.root);
    await expect(discoverManagedQQInstallation(f.source)).rejects.toThrow(/模块无效/);
  });
  it('版本或客户端身份缺失时明确失败，不使用兜底值', async () => {
    const f = await fixture();
    f.info.appid = '0';
    await expect(discoverManagedQQInstallation(f.source)).rejects.toThrow(/客户端身份/);
    f.info.appid = '12345';
    f.info.build = 'different';
    await expect(discoverManagedQQInstallation(f.source)).rejects.toThrow(/不一致/);
  });
});
