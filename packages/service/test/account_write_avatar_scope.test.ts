import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountWriteService } from '../src/account/account_write';

const io = vi.hoisted(() => ({
  fetch: vi.fn(async () => ({
    host: '127.0.0.1',
    port: 1,
    sigSession: new Uint8Array(16),
    sessionKey: new Uint8Array(16),
  })),
  upload: vi.fn(async () => {}),
}));
vi.mock('../../protocol/src/highway/highway-client', async (original) => ({
  ...(await original<typeof import('../../protocol/src/highway/highway-client')>()),
  fetchHighwaySession: io.fetch,
  uploadHighwayHttp: io.upload,
}));
const dirs: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function image() {
  const root = await mkdtemp(join(tmpdir(), 'weq-avatar-binding-'));
  dirs.push(root);
  const path = join(root, 'avatar.png');
  await writeFile(
    path,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jScsAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  return path;
}
function service(resolvePid: () => number) {
  return new AccountWriteService(
    { sendPacket: async () => Buffer.alloc(0), sendOidbPacket: async () => Buffer.alloc(0) },
    { uin: '10001', selfUid: 'u_self', getBuddy: async () => null, listCategories: async () => [] },
    resolvePid,
  );
}
describe('头像上传的账号与运行时绑定', () => {
  it('读图期间切号，个人和群头像均不申请会话或上传', async () => {
    const path = await image();
    for (const kind of ['self', 'group']) {
      let live = true;
      const writer = service(() => {
        if (!live) throw new Error('账号已切换');
        return 5;
      });
      const task = kind === 'self' ? writer.selfAvatar(path) : writer.groupAvatar(123, path);
      live = false;
      await expect(task).rejects.toThrow(/账号已切换/);
      expect(io.fetch).not.toHaveBeenCalled();
      expect(io.upload).not.toHaveBeenCalled();
    }
  });
  it('取得上传票据期间切号，不再进入真正的头像上传', async () => {
    const path = await image();
    let live = true;
    const writer = service(() => {
      if (!live) throw new Error('账号已切换');
      return 5;
    });
    io.fetch.mockImplementationOnce(async () => {
      live = false;
      return {
        host: '127.0.0.1',
        port: 1,
        sigSession: new Uint8Array(16),
        sessionKey: new Uint8Array(16),
      };
    });
    await expect(writer.selfAvatar(path)).rejects.toThrow(/账号已切换/);
    expect(io.fetch).toHaveBeenCalledOnce();
    expect(io.upload).not.toHaveBeenCalled();
  });
  it('同账号运行时 PID 已更换，也不继续使用旧票据写头像', async () => {
    const path = await image();
    let pid = 5;
    const writer = service(() => pid);
    io.fetch.mockImplementationOnce(async () => {
      pid = 6;
      return {
        host: '127.0.0.1',
        port: 1,
        sigSession: new Uint8Array(16),
        sessionKey: new Uint8Array(16),
      };
    });
    await expect(writer.groupAvatar(123, path)).rejects.toThrow(/运行时已切换/);
    expect(io.upload).not.toHaveBeenCalled();
  });
});
