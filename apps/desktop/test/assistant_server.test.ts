// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssistantResourceServer } from '../src/main/weq_assistant/server';

let root: string;
let server: AssistantResourceServer;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'weq-assistant-server-'));
  await mkdir(join(root, 'public', 'p'), { recursive: true });
  await mkdir(join(root, 'public', 'cover'));
  await writeFile(join(root, 'public', 'p', 'daily.html'), '<h1>fixture</h1>');
  await writeFile(join(root, 'public', 'cover', 'daily.png'), 'synthetic-png');
  await writeFile(join(root, 'secret.txt'), 'private-fixture');
  server = new AssistantResourceServer();
});
afterEach(async () => {
  await server.shutdown();
  await rm(root, { recursive: true, force: true });
});
function get(port: number, path: string, method = 'GET') {
  return new Promise<{ status: number; body: string; type: string | undefined }>(
    (resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            type: res.headers['content-type'],
          }),
        );
      });
      req.on('error', reject);
      req.end();
    },
  );
}
describe('随 WeQ 运行的助手资源服务', () => {
  it('发布资源尚未完成便停用时，迟到发布不能重新监听端口', async () => {
    let finish = () => {};
    const starting = server.publishAndStart(
      0,
      join(root, 'public'),
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await server.stop();
    finish();
    expect(await starting).toBeNull();
    expect(server.status().running).toBe(false);
  });
  it('默认不监听；按需提供既有卡片路由，支持查询参数与 HEAD', async () => {
    expect(server.status().running).toBe(false);
    const port = await server.start(0, join(root, 'public'));
    expect(await get(port, '/p/daily?v=1')).toMatchObject({
      status: 200,
      body: '<h1>fixture</h1>',
      type: 'text/html; charset=utf-8',
    });
    expect(await get(port, '/cover/daily')).toMatchObject({
      status: 200,
      body: 'synthetic-png',
      type: 'image/png',
    });
    expect(await get(port, '/healthz')).toMatchObject({ status: 200, body: 'ok' });
    expect(await get(port, '/p/daily', 'HEAD')).toMatchObject({ status: 200, body: '' });
    expect(await get(port, '/p/daily', 'POST')).toMatchObject({ status: 405 });
  });
  it('拒绝路径穿越、畸形编码、目录外符号链接和过大文件', async () => {
    await symlink(join(root, 'secret.txt'), join(root, 'public', 'escape.txt'));
    await writeFile(join(root, 'public', 'large.txt'), Buffer.alloc(16 * 1024 * 1024 + 1));
    const port = await server.start(0, join(root, 'public'));
    for (const path of [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/%5csecret.txt',
      '/escape.txt',
      '/nope',
    ]) {
      expect((await get(port, path)).status, path).toBe(404);
    }
    expect((await get(port, '/%zz')).status).toBe(400);
    expect((await get(port, '/large.txt')).status).toBe(413);
  });
  it('重复开启复用当前服务，停用后可重启，彻底退出后禁止迟到开启', async () => {
    const port = await server.start(0, join(root, 'public'));
    expect(await server.start(0, join(root, 'public'))).toBe(port);
    await server.stop();
    await expect(get(port, '/healthz')).rejects.toThrow();
    const starting = server.start(0, join(root, 'public'));
    const closing = server.shutdown();
    await starting.catch(() => {});
    await closing;
    expect(server.status().running).toBe(false);
    await expect(server.start(0, join(root, 'public'))).rejects.toThrow('退出');
  });
  it('端口占用时向后回落；无效目录不关闭已经工作的服务', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('fixture address');
    try {
      const port = await server.start(address.port, join(root, 'public'));
      expect(port).toBeGreaterThan(address.port);
      await expect(server.start(port, join(root, 'missing'))).rejects.toThrow();
      expect((await get(port, '/healthz')).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
