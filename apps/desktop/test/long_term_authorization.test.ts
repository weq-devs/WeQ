// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTHORIZATION_PROTOCOL } from '../src/shared/long_term_authorization';
import {
  type AuthorizationError,
  configureLongTermAuthorization,
  connectLongTermAuthorization,
  openLongTermAuthorization,
  tryLongTermAttach,
  tryLongTermKeyScan,
} from '../src/main/authorization/client';
import { fileDigest, shellQuote, powershellQuote } from '../src/main/authorization/install';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture({
  protocol = AUTHORIZATION_PROTOCOL,
  authorized = true,
  capabilities = ['attach', 'key-scan', 'capture'],
  validity = 'valid',
  development = false,
  expectedDevelopment = undefined as boolean | undefined,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'weq-authorization-client-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\weq-auth-test-${Date.now()}`
      : join(directory, 'fixture.sock');
  const requests: Array<Record<string, unknown>> = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (bytes: Buffer) => {
      buffer += bytes.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const request = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
        buffer = buffer.slice(end + 1);
        requests.push(request);
        const id = typeof request.id === 'number' ? request.id : 0;
        if (!authorized) {
          socket.end(
            `${JSON.stringify({ id, ok: false, code: 'not-authorized', error: 'fixture not authorized' })}\n`,
          );
          continue;
        }
        if (request.op === 'key-scan')
          socket.write(
            `${JSON.stringify({ id, progress: { phase: 'anchor', percent: 50, message: 'synthetic progress' } })}\n`,
          );
        const result =
          request.op === 'status'
            ? { protocol, build: 'older-compatible-build', capabilities, validity, development }
            : request.op === 'attach'
              ? { a2: 'aabb', d2: 'ccdd', d2Key: '22'.repeat(16) }
              : request.op === 'key-scan'
                ? { success: true, key: 'synthetic' }
                : { protocol };
        const text = `${JSON.stringify({ id, ok: true, result })}\n`;
        socket.write(text.slice(0, 8));
        socket.write(text.slice(8));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  configureLongTermAuthorization({
    endpoint: async () => endpoint,
    ...(expectedDevelopment === undefined
      ? {}
      : { development: async () => Boolean(expectedDevelopment) }),
  });
  return { directory, requests };
}
describe('原生权限助手客户端', () => {
  it.each([
    [false, true],
    [true, false],
  ])(
    '运行操作不能跨开发/正式通道：expected=%s actual=%s',
    async (expectedDevelopment, development) => {
      const data = await fixture({ expectedDevelopment, development });
      await expect(openLongTermAuthorization()).rejects.toMatchObject({ code: 'incompatible' });
      expect(await tryLongTermAttach(123)).toBeNull();
      expect(data.requests.some((request) => request.op === 'attach')).toBe(false);
    },
  );
  it('通过本机 IPC 握手，不发送用户身份或保存长期令牌', async () => {
    const data = await fixture();
    const { connection, info } = await openLongTermAuthorization();
    connection.close();
    expect(data.requests[0]).toEqual({ protocol: AUTHORIZATION_PROTOCOL });
    expect(info.build).toBe('older-compatible-build');
  });
  it('兼容的旧助手可跨 app 更新复用，不按二进制 hash 强制重新授权', async () => {
    await fixture();
    const result = await tryLongTermAttach(123);
    expect(result).toEqual({ a2: 'aabb', d2: 'ccdd', d2Key: '22'.repeat(16) });
  });
  it.each([{ protocol: AUTHORIZATION_PROTOCOL + 1 }, { capabilities: ['attach'] }])(
    '拒绝不兼容协议或缺少操作：%j',
    async (options) => {
      await fixture(options);
      expect(await connectLongTermAuthorization()).toBeNull();
    },
  );
  it('未授权由真实服务拒绝，临时授权回退可区分该原因', async () => {
    await fixture({ authorized: false });
    await expect(openLongTermAuthorization()).rejects.toMatchObject<Partial<AuthorizationError>>({
      code: 'not-authorized',
    });
    expect(await connectLongTermAuthorization()).toBeNull();
  });
  it('组件过期不误报可用，也不发送敏感操作', async () => {
    const data = await fixture({ validity: 'expired' });
    await expect(openLongTermAuthorization()).rejects.toMatchObject({ code: 'component-expired' });
    expect(await tryLongTermAttach(123)).toBeNull();
    expect(data.requests.some((request) => request.op === 'attach')).toBe(false);
  });
  it('密钥扫描发送有界加密样本并转发进度，不向 root 传任意文件路径', async () => {
    const data = await fixture();
    const database = join(data.directory, 'encrypted.db');
    await writeFile(database, Buffer.alloc(10240, 0x37));
    const progress: number[] = [];
    expect(
      await tryLongTermKeyScan(database, 123, (value) => progress.push(value.percent)),
    ).toEqual({ success: true, key: 'synthetic' });
    const request = data.requests.find((value) => value.op === 'key-scan')!;
    expect(Buffer.from(request.databaseSample as string, 'base64')).toEqual(
      Buffer.alloc(5120, 0x37),
    );
    expect(JSON.stringify(request)).not.toContain(database);
    expect(progress).toEqual([50]);
  });
  it('短样本不启动扫描，取消信号不触发 root 操作', async () => {
    const data = await fixture();
    const database = join(data.directory, 'short.db');
    await writeFile(database, Buffer.alloc(100));
    await expect(tryLongTermKeyScan(database, 123)).rejects.toThrow('5120');
    const controller = new AbortController();
    controller.abort();
    await expect(tryLongTermAttach(123, controller.signal)).rejects.toThrow();
    expect(
      data.requests.some((request) => ['attach', 'key-scan'].includes(String(request.op))),
    ).toBe(false);
  });
  it('安装参数正确引用路径，组件 hash 流式计算', async () => {
    const data = await fixture();
    const path = join(data.directory, 'component');
    await writeFile(path, 'abc');
    expect(await fileDigest(path)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(shellQuote("a'b c")).toBe("'a'\\''b c'");
    expect(powershellQuote("a'b c")).toBe("'a''b c'");
  });
});
